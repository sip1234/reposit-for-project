"""Optional local cross-encoder. Public model download only; no remote inference."""
import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

MODEL = 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1'
REVISION = '1427fd652930e4ba29e8149678df786c240d8825'
WEIGHTS = 'onnx/model_quint8_avx2.onnx'
RESOURCE = f'{REVISION}:{WEIGHTS}'
gate = threading.Semaphore(1)
model, tokenizer, load_error = None, None, '模型正在加载'


def load():
    global model, tokenizer, load_error
    try:
        offline = os.environ.get('HF_HUB_OFFLINE') == '1'
        path = hf_hub_download(MODEL, WEIGHTS, revision=REVISION, local_files_only=offline)
        tok = hf_hub_download(MODEL, 'tokenizer.json', revision=REVISION, local_files_only=offline)
        options = ort.SessionOptions()
        options.intra_op_num_threads = int(os.environ.get('RERANK_THREADS', '2'))
        options.inter_op_num_threads = 1
        model = ort.InferenceSession(path, sess_options=options, providers=['CPUExecutionProvider'])
        tokenizer = Tokenizer.from_file(tok)
        load_error = None
        print(f'Ready: {MODEL} {RESOURCE}', flush=True)
    except Exception as error:
        load_error = str(error)[:700]
        print(f'Rerank resource unavailable: {load_error}', flush=True)


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != '/health':
            return self.send(404, {'error': '未找到接口'})
        return self.send(503 if load_error else 200, {'model': MODEL, 'revision': RESOURCE,
            'ready': not bool(load_error), 'error': load_error, 'maxTokens': 512,
            'scoreType': 'cross_encoder_logit', 'provider': 'local', 'concurrency': 1})

    def do_POST(self):
        if self.path != '/rerank':
            return self.send(404, {'error': '未找到接口'})
        if load_error:
            return self.send(503, {'error': load_error})
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 700000:
            return self.send(413, {'error': '重排请求过大'})
        if not gate.acquire(blocking=False):
            return self.send(429, {'error': '本地重排正在处理其他请求，请稍后重试'})
        start = time.monotonic()
        try:
            body = json.loads(self.rfile.read(length))
            query, documents = body.get('query'), body.get('documents')
            limit, batch = body.get('maxTokens', 512), body.get('batchSize', 4)
            timeout = body.get('timeoutMs', 15000)
            if (body.get('model') != MODEL or not isinstance(query, str) or not query.strip()
                or len(query) > 500 or not isinstance(documents, list) or not 1 <= len(documents) <= 40
                or any(not isinstance(s, str) or not s.strip() or len(s) > 8000 for s in documents)
                or type(limit) is not int or not 64 <= limit <= 512
                or type(batch) is not int or not 1 <= batch <= 8
                or type(timeout) is not int or not 100 <= timeout <= 60000):
                return self.send(400, {'error': '重排参数无效'})
            tokenizer.no_truncation()
            tokenizer.no_padding()
            qids = tokenizer.encode(query, add_special_tokens=False).ids
            query_budget = min(128, limit // 3)
            trimmed_query = tokenizer.decode(qids[:query_budget]) if len(qids) > query_budget else query
            original_lengths = [len(tokenizer.encode(s, add_special_tokens=False).ids) for s in documents]
            tokenizer.enable_truncation(max_length=limit, strategy='only_second')
            tokenizer.enable_padding(pad_id=tokenizer.token_to_id('<pad>'), pad_token='<pad>')
            scores = []
            for offset in range(0, len(documents), batch):
                if (time.monotonic() - start) * 1000 >= timeout:
                    return self.send(504, {'error': '本地重排超时，未返回部分排序'})
                encodings = tokenizer.encode_batch([(trimmed_query, s) for s in documents[offset:offset + batch]])
                inputs = {'input_ids': np.asarray([e.ids for e in encodings], dtype=np.int64),
                    'attention_mask': np.asarray([e.attention_mask for e in encodings], dtype=np.int64),
                    'token_type_ids': np.asarray([e.type_ids for e in encodings], dtype=np.int64)}
                logits = model.run(None, {i.name: inputs[i.name] for i in model.get_inputs()})[0].reshape(-1)
                if len(logits) != len(encodings) or any(not math.isfinite(float(s)) for s in logits):
                    raise ValueError('本地模型返回非法分数')
                for i, (encoding, score) in enumerate(zip(encodings, logits)):
                    index = offset + i
                    used = sum(x == 1 for x in encoding.sequence_ids)
                    scores.append({'index': index, 'score': float(score), 'originalTokens': original_lengths[index],
                        'usedTokens': used, 'truncated': used < original_lengths[index]})
            elapsed = round((time.monotonic() - start) * 1000, 2)
            if elapsed >= timeout:
                return self.send(504, {'error': '本地重排超时，未返回部分排序'})
            self.send(200, {'model': MODEL, 'revision': RESOURCE, 'scores': scores,
                'queryTruncated': len(qids) > query_budget, 'maxTokens': limit, 'elapsedMs': elapsed,
                'scoreType': 'cross_encoder_logit'})
        except Exception as error:
            self.send(500, {'error': str(error)[:500]})
        finally:
            gate.release()

    def log_message(self, fmt, *args):
        # Do not log queries or document content.
        print(f'{self.command} {self.path} {args[1] if len(args)>1 else ""}', flush=True)


if __name__ == '__main__':
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8090), Handler).serve_forever()
