// 机理模型（BSM1）仿真任务：建表、入队、查询状态与结果。
// 表结构与 simulator/run.py 中的 DDL 保持一致（沿用仓库既有的双方各自保证建表可用的做法）。
const crypto = require('node:crypto');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const weathers = new Set(['dry', 'rain']);

async function setup(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS sim_jobs (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('queued','running','ready','failed')),
    params jsonb NOT NULL,
    progress numeric NOT NULL DEFAULT 0,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sim_results (
    job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE CASCADE,
    metrics jsonb NOT NULL,
    series jsonb NOT NULL,
    notes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS sim_jobs_status_created_idx ON sim_jobs (status, created_at)');
}

function numberIn(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function validParams(body) {
  const horizonDays = numberIn(body?.horizonDays, 1, 13.9, 13.9);
  const rawEval = numberIn(body?.evalDays, 1, 13, 7);
  const doSetpoint = numberIn(body?.doSetpoint, 0.5, 4, 2);
  const recycleRatio = numberIn(body?.recycleRatio, 0, 5, 3);
  const carbonDose = numberIn(body?.carbonDose, 0, 5, 0);
  const influent = body?.influent === undefined ? 'dry' : String(body.influent);
  if (horizonDays === null) return { error: '仿真时长须在 1 到 13.9 天之间。' };
  // 底层库要求评价窗口为整天
  const evalDays = rawEval === null ? null : Math.round(rawEval);
  if (evalDays === null || evalDays > horizonDays) return { error: '评价窗口须为 1 到 13 之间的整天，且不超过仿真时长。' };
  if (doSetpoint === null) return { error: '溶解氧设定值须在 0.5 到 4 mg/L 之间。' };
  if (recycleRatio === null) return { error: '内回流倍数须在 0 到 5 之间。' };
  if (carbonDose === null) return { error: '外加碳源投加量须在 0 到 5 m³/d 之间。' };
  if (!weathers.has(influent)) return { error: '仅支持 dry 或 rain 两种天气文件。' };
  return { params: { horizonDays, evalDays, doSetpoint, recycleRatio, carbonDose, influent } };
}

function publicJob(row) {
  return {
    id: row.id, status: row.status, params: row.params,
    progress: Number(row.progress), error: row.error_message || null,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at
  };
}

async function createJob(pool, req, res, send, readBody) {
  let body;
  try { body = await readBody(req); }
  catch { return send(res, 400, { error: '请求体不是合法 JSON。' }); }
  const parsed = validParams(body);
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO sim_jobs (id, status, params) VALUES ($1, 'queued', $2)
     RETURNING id, status, params, progress, error_message, created_at, started_at, completed_at`,
    [id, JSON.stringify(parsed.params)]);
  return send(res, 201, { job: publicJob(result.rows[0]) });
}

async function listJobs(pool, res, send) {
  const result = await pool.query(
    `SELECT id, status, params, progress, error_message, created_at, started_at, completed_at
     FROM sim_jobs ORDER BY created_at DESC LIMIT 20`);
  return send(res, 200, { jobs: result.rows.map(publicJob) });
}

async function getJob(pool, res, send, id) {
  const job = await pool.query(
    `SELECT id, status, params, progress, error_message, created_at, started_at, completed_at
     FROM sim_jobs WHERE id=$1`, [id]);
  if (!job.rowCount) return send(res, 404, { error: '仿真任务不存在。' });
  const result = await pool.query(
    'SELECT metrics, series, notes, created_at FROM sim_results WHERE job_id=$1', [id]);
  return send(res, 200, {
    job: publicJob(job.rows[0]),
    result: result.rowCount ? {
      metrics: result.rows[0].metrics, series: result.rows[0].series,
      notes: result.rows[0].notes, createdAt: result.rows[0].created_at
    } : null
  });
}

async function handle(pool, req, res, url, send, readBody) {
  if (url.pathname === '/api/simulation') {
    if (req.method === 'POST') return await createJob(pool, req, res, send, readBody);
    if (req.method === 'GET') return await listJobs(pool, res, send);
    return send(res, 405, { error: '不支持此请求' });
  }
  const match = /^\/api\/simulation\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
  if (match) {
    if (!uuidPattern.test(match[1])) return send(res, 400, { error: '无效的任务标识。' });
    if (req.method !== 'GET') return send(res, 405, { error: '不支持此请求' });
    return await getJob(pool, res, send, match[1]);
  }
  return send(res, 404, { error: '未找到资源' });
}

module.exports = { setup, handle };
