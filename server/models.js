const crypto = require('node:crypto');

const ollamaUrl = (process.env.OLLAMA_URL || 'http://ollama:11434').replace(/\/$/, '');
const defaultLlmId = '00000000-0000-4000-8000-000000000001';
const defaultEmbeddingId = '00000000-0000-4000-8000-000000000002';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secret = process.env.HOOK_TOKEN;
if (!secret || secret.length < 32) throw new Error('HOOK_TOKEN must be set before model credentials can be stored');
const encryptionKey = crypto.createHash('sha256').update(`model-credentials-v1:${secret}`).digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decrypt(value) {
  const data = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

async function setup(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_models (
    id uuid PRIMARY KEY, name text NOT NULL, provider text NOT NULL CHECK (provider IN ('ollama','deepseek')),
    kind text NOT NULL CHECK (kind IN ('llm','embedding')), model_name text NOT NULL,
    encrypted_api_key text, dimensions integer, active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (provider <> 'deepseek' OR (kind='llm' AND encrypted_api_key IS NOT NULL))
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ai_models_one_active_kind ON ai_models(kind) WHERE active');
  await pool.query(`INSERT INTO ai_models (id,name,provider,kind,model_name,active)
    SELECT $1,'本地 Qwen3 4B','ollama','llm','qwen3:4b-instruct',true
    WHERE NOT EXISTS (SELECT 1 FROM ai_models WHERE kind='llm')`, [defaultLlmId]);
  await pool.query(`INSERT INTO ai_models (id,name,provider,kind,model_name,dimensions,active)
    SELECT $1,'本地 Qwen3 Embedding','ollama','embedding','qwen3-embedding:0.6b',1024,true
    WHERE NOT EXISTS (SELECT 1 FROM ai_models WHERE kind='embedding')`, [defaultEmbeddingId]);
  await pool.query('DROP INDEX IF EXISTS document_chunks_embedding_idx');
  const vectorColumn = await pool.query(`SELECT atttypmod FROM pg_attribute
    WHERE attrelid='document_chunks'::regclass AND attname='embedding' AND NOT attisdropped`);
  if (vectorColumn.rows[0]?.atttypmod !== -1) {
    await pool.query('ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector');
  }
  await pool.query('ALTER TABLE document_index_jobs ADD COLUMN IF NOT EXISTS embedding_model_id uuid REFERENCES ai_models(id) ON DELETE SET NULL');
  await pool.query(`UPDATE document_index_jobs SET embedding_model_id=$1
    WHERE status='ready' AND embedding_model_id IS NULL`, [defaultEmbeddingId]);
}

function publicModel(row) {
  return { id: row.id, name: row.name, provider: row.provider, kind: row.kind,
    modelName: row.model_name, dimensions: row.dimensions, active: row.active,
    hasApiKey: Boolean(row.encrypted_api_key) };
}

async function activeModel(pool, kind) {
  const result = await pool.query('SELECT * FROM ai_models WHERE kind=$1 AND active', [kind]);
  if (!result.rowCount) throw new Error(`没有启用的 ${kind} 模型`);
  return result.rows[0];
}

async function postOllama(endpoint, body, timeout = 120000) {
  const response = await fetch(`${ollamaUrl}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(String(data.error || `Ollama 错误 ${response.status}`).slice(0, 300));
  return data;
}

async function embed(model, input) {
  if (model.provider !== 'ollama') throw new Error('当前向量模型不受支持');
  const data = await postOllama('/api/embed', { model: model.model_name, input });
  const vector = data.embeddings?.[0];
  if (!Array.isArray(vector) || vector.length !== model.dimensions ||
      vector.some(value => !Number.isFinite(value))) throw new Error('向量模型返回的维度或数值无效');
  return vector;
}

async function chat(model, messages) {
  if (model.provider === 'ollama') {
    const data = await postOllama('/api/chat', {
      model: model.model_name, stream: false,
      options: { temperature: 0.1, num_predict: 900, num_ctx: 8192 }, messages
    }, 180000);
    return data.message?.content;
  }
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decrypt(model.encrypted_api_key)}` },
    body: JSON.stringify({ model: model.model_name, stream: false, max_tokens: 900, temperature: 0.1, messages }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`DeepSeek 请求失败 (${response.status})`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

function validate(body, existing) {
  const name = String(body?.name || '').trim();
  const provider = body?.provider;
  const kind = body?.kind;
  const modelName = String(body?.modelName || '').trim();
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!name || name.length > 80) return { error: '显示名称须为 1 至 80 字。' };
  if (!['ollama', 'deepseek'].includes(provider) || !['llm', 'embedding'].includes(kind)) return { error: '模型提供方或类型无效。' };
  if (provider === 'deepseek' && kind !== 'llm') return { error: 'DeepSeek 当前仅接入 LLM 问答模型。' };
  if (!modelName || modelName.length > 120 || !/^[\w.:-]+$/.test(modelName)) return { error: '模型标识格式无效。' };
  if (provider === 'deepseek' && !['deepseek-flash', 'deepseek-v4-pro'].includes(modelName)) return { error: '请选择 DeepSeek 支持的模型标识。' };
  if (apiKey.length > 512) return { error: 'API 密钥过长。' };
  if (provider === 'deepseek' && !apiKey && !existing?.encrypted_api_key) return { error: '请填写 DeepSeek API 密钥。' };
  if (existing?.active && (existing.provider !== provider || existing.kind !== kind || existing.model_name !== modelName)) {
    return { error: '请先启用另一模型，再修改当前模型的提供方、类型或标识。' };
  }
  return { name, provider, kind, modelName, apiKey };
}

async function save(pool, req, res, send, readBody, id) {
  let body;
  try { body = await readBody(req); }
  catch { return send(res, 400, { error: '请求格式无效' }); }
  const existing = id ? (await pool.query('SELECT * FROM ai_models WHERE id=$1', [id])).rows[0] : null;
  if (id && !existing) return send(res, 404, { error: '模型不存在' });
  const input = validate(body, existing);
  if (input.error) return send(res, 400, { error: input.error });
  let dimensions = null;
  if (input.kind === 'embedding') {
    try {
      const data = await postOllama('/api/embed', { model: input.modelName, input: '模型维度测试' });
      dimensions = data.embeddings?.[0]?.length;
      if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) throw new Error('维度不受支持');
    } catch { return send(res, 422, { error: '无法调用此 Ollama 向量模型。请先在 Ollama 中下载并确认模型支持 embedding。' }); }
  }
  if (input.provider === 'ollama' && input.kind === 'llm') {
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !data.models?.some(item => item.name === input.modelName || item.model === input.modelName)) {
        return send(res, 422, { error: 'Ollama 中未找到此模型，请先下载模型。' });
      }
    } catch { return send(res, 503, { error: '无法连接 Ollama，请确认本地服务正在运行。' }); }
  }
  const encrypted = input.provider === 'deepseek'
    ? (input.apiKey ? encrypt(input.apiKey) : existing.encrypted_api_key) : null;
  const modelId = id || crypto.randomUUID();
  if (id) {
    await pool.query(`UPDATE ai_models SET name=$2, provider=$3, kind=$4, model_name=$5,
      encrypted_api_key=$6, dimensions=$7, updated_at=now() WHERE id=$1`,
    [id, input.name, input.provider, input.kind, input.modelName, encrypted, dimensions]);
  } else {
    await pool.query(`INSERT INTO ai_models (id,name,provider,kind,model_name,encrypted_api_key,dimensions)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [modelId, input.name, input.provider, input.kind, input.modelName, encrypted, dimensions]);
  }
  return send(res, id ? 200 : 201, { id: modelId });
}

async function activate(pool, id, res, send) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM ai_models WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return send(res, 404, { error: '模型不存在' }); }
    const model = found.rows[0];
    if (model.active) { await client.query('COMMIT'); return send(res, 200, { active: true }); }
    await client.query('UPDATE ai_models SET active=false, updated_at=now() WHERE kind=$1 AND active', [model.kind]);
    await client.query('UPDATE ai_models SET active=true, updated_at=now() WHERE id=$1', [id]);
    if (model.kind === 'embedding') {
      await client.query(`UPDATE document_index_jobs SET status='pending', error=NULL, chunk_count=0,
        updated_at=now() WHERE status IN ('ready','failed') AND embedding_model_id IS DISTINCT FROM $1`, [id]);
    }
    await client.query('COMMIT');
    return send(res, 200, { active: true, reindexing: model.kind === 'embedding' });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function handle(pool, req, res, url, send, readBody) {
  if (url.pathname === '/api/models') {
    if (req.method === 'GET') {
      const result = await pool.query('SELECT * FROM ai_models ORDER BY kind, active DESC, created_at DESC');
      return send(res, 200, { models: result.rows.map(publicModel) });
    }
    if (req.method === 'POST') return save(pool, req, res, send, readBody);
    return send(res, 405, { error: '不支持此请求' });
  }
  const match = /^\/api\/models\/([^/]+)(?:\/(activate))?$/.exec(url.pathname);
  if (!match || !uuidPattern.test(match[1])) return send(res, 404, { error: '模型不存在' });
  if (match[2] === 'activate' && req.method === 'POST') return activate(pool, match[1], res, send);
  if (match[2]) return send(res, 405, { error: '不支持此请求' });
  if (req.method === 'PUT') return save(pool, req, res, send, readBody, match[1]);
  if (req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM ai_models WHERE id=$1 AND NOT active RETURNING id', [match[1]]);
    return result.rowCount ? send(res, 200, { deleted: true }) : send(res, 409, { error: '当前启用的模型不能删除；请先启用同类型的其他模型。' });
  }
  return send(res, 405, { error: '不支持此请求' });
}

module.exports = { setup, handle, activeModel, embed, chat, postOllama };
