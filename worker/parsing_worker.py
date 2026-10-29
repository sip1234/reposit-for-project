"""Transactional parsing worker. Shared artifacts are immutable; edits are document scoped."""
import json
import math
import os
import time
import urllib.request
import urllib.error
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from structured_parser import extract, chunk_blocks, PARSER_VERSION

DB = os.environ["DATABASE_URL"]
DATA = Path(os.environ.get("DATA_ROOT", "/data"))
OLLAMA = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")


def embed(texts, model_name, dimensions):
    request = urllib.request.Request(OLLAMA + "/api/embed", data=json.dumps({"model": model_name, "input": texts}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            vectors = json.load(response)["embeddings"]
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get('error', str(error))
        except (ValueError, AttributeError):
            detail = str(error)
        raise RuntimeError(f'Ollama {error.code}: {str(detail)[:500]}') from error
    if len(vectors) != len(texts) or any(len(v) != dimensions or not any(x != 0 for x in v) or any(not math.isfinite(x) for x in v) for v in vectors):
        raise RuntimeError("向量模型返回维度或数值无效")
    return vectors


def vector_text(vector):
    return "[" + ",".join(map(str, vector)) + "]"


def progress(conn, job_id, stage, percent, details=None):
    details = details or {}
    old = conn.execute('SELECT stage FROM parsing_jobs WHERE id=%s', (job_id,)).fetchone()
    if old['stage'] != stage or 'pages' in details:
        conn.execute('INSERT INTO parsing_events(job_id,stage,progress,details) VALUES(%s,%s,%s,%s)',
            (job_id, stage, percent, Jsonb({k:v for k,v in details.items() if k not in ('pages','warnings')})))
    conn.execute("""UPDATE parsing_jobs SET stage=%s,progress=%s,updated_at=now(),
        pages=COALESCE(%s,pages),warnings=COALESCE(%s,warnings),page_count=COALESCE(%s,page_count) WHERE id=%s""",
        (stage, percent, Jsonb(details["pages"]) if "pages" in details else None,
         Jsonb(details["warnings"]) if "warnings" in details else None, details.get("page_count"), job_id))
    conn.commit()


def publish_waiting(conn):
    """Sweeps versions attached while a job was completing; no snapshot race."""
    versions = conn.execute("""SELECT v.id,v.document_id,v.job_id,j.status FROM parsing_versions v JOIN parsing_jobs j ON j.id=v.job_id
        WHERE v.status='pending' AND j.status IN ('ready','failed') ORDER BY v.created_at LIMIT 100""").fetchall()
    conn.commit()
    for version in versions:
        with conn.transaction():
            conn.execute("SELECT id FROM documents WHERE id=%s FOR UPDATE", (version["document_id"],))
            row = conn.execute("SELECT status FROM parsing_versions WHERE id=%s FOR UPDATE", (version["id"],)).fetchone()
            if row["status"] != "pending":
                continue
            if version["status"] == "failed":
                conn.execute("UPDATE parsing_versions SET status='failed' WHERE id=%s", (version["id"],))
                continue
            conn.execute("""INSERT INTO parsing_version_chunks(version_id,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length)
                SELECT %s,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length FROM parsing_artifact_chunks WHERE job_id=%s""", (version["id"], version["job_id"]))
            conn.execute("UPDATE parsing_versions SET status='ready',activated_at=now() WHERE id=%s", (version["id"],))
            conn.execute("UPDATE documents SET active_parse_version_id=%s WHERE id=%s AND requested_parse_version_id=%s", (version["id"], version["document_id"], version["id"]))


def process_job(conn, job):
    job_id, started = job["id"], time.monotonic()
    phases, phase, phase_start = {}, "extracting", time.monotonic()

    def report(stage, percent, details):
        nonlocal phase, phase_start
        if stage != phase:
            phases[phase] = phases.get(phase, 0) + time.monotonic() - phase_start
            phase, phase_start = stage, time.monotonic()
        progress(conn, job_id, stage, percent, details)

    try:
        if job["parser_version"] != PARSER_VERSION:
            raise RuntimeError("任务解析器版本与 worker 不一致，请重新提交")
        path = DATA / "raw" / (job["source_document_id"] + job["extension"])
        if not path.is_file():
            raise RuntimeError("原始文件不存在")
        conn.execute("DELETE FROM parsing_artifact_chunks WHERE job_id=%s", (job_id,))
        conn.execute("DELETE FROM parsing_blocks WHERE job_id=%s", (job_id,))
        conn.commit()
        blocks, pages, warnings = extract(path, job["extension"], job["config"], report)
        report("chunking", 45, {"pages": pages, "warnings": warnings, "page_count": len(pages)})
        for index, part in enumerate(blocks):
            conn.execute("INSERT INTO parsing_blocks(job_id,block_index,content,content_type,source,section_path) VALUES(%s,%s,%s,%s,%s,%s)",
                (job_id, index, part["content"], part["content_type"], Jsonb(part["source"]), Jsonb(part["section_path"])))
        conn.execute("UPDATE parsing_jobs SET block_count=%s WHERE id=%s", (len(blocks), job_id))
        conn.commit()
        chunks = chunk_blocks(blocks, job["config"], warnings)
        if not chunks:
            raise RuntimeError("未提取到可用内容，请查看页面诊断；扫描页需要启用 OCR")
        report("embedding", 50, {"warnings": warnings})
        for offset in range(0, len(chunks), 8):
            batch = chunks[offset:offset + 8]
            vectors = embed([c["content"] for c in batch], job["model_name"], job["dimensions"])
            for chunk, vector in zip(batch, vectors):
                conn.execute("""INSERT INTO parsing_artifact_chunks(job_id,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length)
                    VALUES(%s,%s,%s,%s::vector,%s,%s,%s,%s,%s)""", (job_id, chunk["chunk_index"], chunk["content"], vector_text(vector), chunk["content_type"],
                        Jsonb(chunk["source"]), Jsonb(chunk["section_path"]), chunk["strategy"], chunk["char_length"]))
            conn.execute("UPDATE parsing_jobs SET chunk_count=%s WHERE id=%s", (offset + len(batch), job_id))
            conn.commit()
            report("embedding", 50 + round((offset + len(batch)) / len(chunks) * 49), {})
        phases[phase] = phases.get(phase, 0) + time.monotonic() - phase_start
        metrics = {"duration_seconds": round(time.monotonic() - started, 3), "phase_seconds": {k: round(v, 3) for k, v in phases.items()}}
        conn.execute("""UPDATE parsing_jobs SET status='ready',stage='complete',progress=100,chunk_count=%s,
            warnings=%s,metrics=%s,finished_at=now(),updated_at=now(),error=NULL WHERE id=%s""", (len(chunks), Jsonb(warnings), Jsonb(metrics), job_id))
        conn.execute("INSERT INTO parsing_events(job_id,stage,progress,details) VALUES(%s,'complete',100,%s)", (job_id, Jsonb(metrics)))
        conn.commit()
        print(f"Parsed {job_id}: {len(blocks)} blocks, {len(chunks)} chunks", flush=True)
    except Exception as error:
        conn.rollback()
        conn.execute("""UPDATE parsing_jobs SET status='failed',stage='failed',error=%s,
            finished_at=now(),updated_at=now(),metrics=%s WHERE id=%s""", (str(error)[:2000], Jsonb({"duration_seconds": round(time.monotonic() - started, 3)}), job_id))
        conn.execute("INSERT INTO parsing_events(job_id,stage,progress,details) SELECT id,'failed',progress,%s FROM parsing_jobs WHERE id=%s", (Jsonb({'error':str(error)[:2000]}), job_id))
        conn.commit()
        print(f"Parse failed {job_id}: {error}", flush=True)


def process_update(conn, job):
    try:
        vector = embed([job["content"]], job["model_name"], job["dimensions"])[0]
        changed = conn.execute("""UPDATE parsing_version_chunks SET embedding=%s::vector,vector_revision=%s,embedding_state='ready',error=NULL,updated_at=now()
            WHERE version_id=%s AND chunk_index=%s AND revision=%s AND embedding_job_id=%s AND content=%s""",
            (vector_text(vector), job["revision"], job["version_id"], job["chunk_index"], job["revision"], job['id'],job['content'])).rowcount
        conn.execute("UPDATE parsing_chunk_updates SET status=%s,finished_at=now() WHERE id=%s", ("ready" if changed else "superseded", job["id"]))
        if changed:
            conn.execute("INSERT INTO parsing_audit(version_id,action,details) VALUES(%s,'embedding_complete',%s)",
                (job['version_id'],Jsonb({'chunkIndex':job['chunk_index'],'revision':job['revision'],'vectorRevision':job['revision'],'jobId':str(job['id'])})))
        conn.commit()
    except Exception as error:
        conn.rollback()
        changed=conn.execute("""UPDATE parsing_version_chunks SET embedding_state='failed',error=%s,updated_at=now()
            WHERE version_id=%s AND chunk_index=%s AND revision=%s AND embedding_job_id=%s""",
            (str(error)[:1000], job["version_id"], job["chunk_index"], job["revision"],job['id'])).rowcount
        conn.execute("UPDATE parsing_chunk_updates SET status=%s,error=%s,finished_at=now() WHERE id=%s", ('failed' if changed else 'superseded',str(error)[:1000], job["id"]))
        if changed:
            conn.execute("INSERT INTO parsing_audit(version_id,action,details) VALUES(%s,'embedding_failed',%s)",
                (job['version_id'],Jsonb({'chunkIndex':job['chunk_index'],'revision':job['revision'],'jobId':str(job['id']),'error':str(error)[:1000]})))
        conn.commit()


def claim_update(conn):
    """Only the latest task for the current body can claim the processing state."""
    with conn.transaction():
        job = conn.execute("""SELECT u.*,m.model_name,m.dimensions,c.revision AS current_revision,c.embedding_job_id
            FROM parsing_chunk_updates u JOIN parsing_version_chunks c ON c.version_id=u.version_id AND c.chunk_index=u.chunk_index
            JOIN parsing_versions v ON v.id=u.version_id JOIN parsing_jobs j ON j.id=v.job_id JOIN ai_models m ON m.id=j.model_id
            WHERE u.status='pending' ORDER BY u.created_at,u.id LIMIT 1 FOR UPDATE OF u,c SKIP LOCKED""").fetchone()
        if not job:
            return None
        if job['current_revision']!=job['revision'] or job['embedding_job_id']!=job['id']:
            conn.execute("UPDATE parsing_chunk_updates SET status='superseded',finished_at=now() WHERE id=%s",(job['id'],))
            return None
        conn.execute("UPDATE parsing_chunk_updates SET status='processing',started_at=now() WHERE id=%s",(job['id'],))
        conn.execute("UPDATE parsing_version_chunks SET embedding_state='processing',error=NULL,updated_at=now() WHERE version_id=%s AND chunk_index=%s",(job['version_id'],job['chunk_index']))
        conn.execute("INSERT INTO parsing_audit(version_id,action,details) VALUES(%s,'embedding_started',%s)",
            (job['version_id'],Jsonb({'chunkIndex':job['chunk_index'],'revision':job['revision'],'jobId':str(job['id'])})))
        return job


def work(conn):
    if not conn.execute("SELECT pg_try_advisory_lock(84271932) AS owned").fetchone()["owned"]:
        conn.rollback()
        time.sleep(5)
        return
    conn.execute("INSERT INTO parsing_events(job_id,stage,progress,details) SELECT id,'waiting',0,'{\"reason\":\"worker restart\"}'::jsonb FROM parsing_jobs WHERE status='processing'")
    conn.execute("UPDATE parsing_jobs SET status='pending',stage='waiting',error='worker 重启，等待恢复' WHERE status='processing'")
    conn.execute("UPDATE parsing_chunk_updates SET status='pending' WHERE status='processing'")
    conn.execute("""UPDATE parsing_version_chunks c SET embedding_state='pending',updated_at=now()
        FROM parsing_chunk_updates u WHERE c.embedding_job_id=u.id AND c.embedding_state='processing' AND u.status='pending'""")
    conn.commit()
    while True:
        publish_waiting(conn)
        update = claim_update(conn)
        if update:
            process_update(conn, update)
            continue
        with conn.transaction():
            job = conn.execute("""SELECT j.*,c.config,m.model_name,m.dimensions FROM parsing_jobs j
                JOIN parsing_configs c ON c.id=j.config_id JOIN ai_models m ON m.id=j.model_id
                WHERE j.status='pending' ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED""").fetchone()
            if job:
                conn.execute("""UPDATE parsing_jobs SET status='processing',stage='extracting',progress=0,error=NULL,
                    pages='[]',warnings='[]',metrics='{}',page_count=0,block_count=0,chunk_count=0,finished_at=NULL,
                    started_at=now(),updated_at=now() WHERE id=%s""", (job["id"],))
                conn.execute("INSERT INTO parsing_events(job_id,stage,progress) VALUES(%s,'extracting',0)", (job['id'],))
        if job:
            process_job(conn, job)
        else:
            time.sleep(2)


def main():
    while True:
        try:
            with psycopg.connect(DB, row_factory=dict_row) as connection:
                work(connection)
        except Exception as error:
            print(f"Indexer reconnecting: {error}", flush=True)
            time.sleep(5)
