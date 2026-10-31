// GP-EI + Pareto optimization jobs: queue, status, result, cancel.
const crypto = require('node:crypto');
const profile = require('../shared/plant_profile.json');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const weathers = new Set(['dry', 'rain']);
const jobColumns = `id, status, params, progress, cancel_requested, error_message,
  created_at, started_at, completed_at`;

async function setup(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS opt_jobs (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
    params jsonb NOT NULL,
    progress numeric NOT NULL DEFAULT 0,
    cancel_requested boolean NOT NULL DEFAULT false,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS opt_results (
    job_id uuid PRIMARY KEY REFERENCES opt_jobs(id) ON DELETE CASCADE,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE opt_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE opt_jobs DROP CONSTRAINT IF EXISTS opt_jobs_status_check;
    ALTER TABLE opt_jobs ADD CONSTRAINT opt_jobs_status_check
      CHECK (status IN ('queued','running','ready','failed','cancelled'));`);
  await pool.query('CREATE INDEX IF NOT EXISTS opt_jobs_status_created_idx ON opt_jobs (status, created_at)');
}

function numberIn(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function intIn(value, min, max, fallback) {
  const parsed = numberIn(value, min, max, fallback);
  return parsed === null ? null : Math.round(parsed);
}

function validParams(body) {
  const evaluations = intIn(body?.evaluations, 4, 100, 8);
  const initial = intIn(body?.initial, 2, evaluations ?? 2, Math.min(4, evaluations ?? 4));
  const candidates = intIn(body?.candidates, 500, 10000, 4000);
  const seed = intIn(body?.seed, 0, 2147483647, 42);
  const horizon = numberIn(body?.horizonDays, 1, profile.evaluation.horizonDays, profile.evaluation.horizonDays);
  const evalDays = intIn(body?.evalDays, 1, Math.min(13, Math.floor(profile.evaluation.horizonDays)), profile.evaluation.evalDays);
  const loadFactor = numberIn(body?.loadFactor, 0.5, 2.0, profile.evaluation.loadFactor ?? 1);
  const weather = String(body?.influent ?? profile.evaluation.influent);
  const stabilize = body?.stabilize === undefined ? Boolean(profile.evaluation.stabilize) : body.stabilize;

  if (evaluations === null) return { error: '评估次数须在 4 到 100 之间。' };
  if (initial === null || initial > evaluations) return { error: '初始点数须在 2 到评估次数之间。' };
  if (candidates === null) return { error: '候选点数须在 500 到 10000 之间。' };
  if (seed === null) return { error: '随机种子须为非负整数。' };
  if (horizon === null) return { error: `仿真时长须在 1 到 ${profile.evaluation.horizonDays} 天之间。` };
  if (evalDays === null || evalDays > horizon) return { error: '评价窗口须为 1 到 13 之间的整天，且不超过仿真时长。' };
  if (loadFactor === null) return { error: '负荷系数须在 0.5 到 2.0 之间。' };
  if (!weathers.has(weather)) return { error: '仅支持 dry 或 rain 两种天气文件。' };
  if (typeof stabilize !== 'boolean') return { error: 'stabilize 必须为布尔值。' };

  return {
    params: {
      evaluations, initial, candidates, seed, horizonDays: horizon, evalDays,
      influent: weather, loadFactor, stabilize, no_stabilize: !stabilize,
      profileId: profile.profileId,
    }
  };
}

function publicJob(row) {
  return {
    id: row.id, status: row.status, params: row.params,
    progress: Number(row.progress), cancelRequested: Boolean(row.cancel_requested),
    error: row.error_message || null,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
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
    `INSERT INTO opt_jobs (id, status, params) VALUES ($1, 'queued', $2) RETURNING ${jobColumns}`,
    [id, JSON.stringify(parsed.params)]);
  return send(res, 201, { job: publicJob(result.rows[0]), profile });
}

async function listJobs(pool, res, send) {
  const result = await pool.query(`SELECT ${jobColumns} FROM opt_jobs ORDER BY created_at DESC LIMIT 20`);
  return send(res, 200, { jobs: result.rows.map(publicJob), profile });
}

async function getJob(pool, res, send, id) {
  const job = await pool.query(`SELECT ${jobColumns} FROM opt_jobs WHERE id=$1`, [id]);
  if (!job.rowCount) return send(res, 404, { error: '优化任务不存在。' });
  const result = await pool.query('SELECT result, created_at FROM opt_results WHERE job_id=$1', [id]);
  return send(res, 200, {
    job: publicJob(job.rows[0]),
    result: result.rowCount ? result.rows[0].result : null,
  });
}

async function cancelJob(pool, res, send, id) {
  const updated = await pool.query(
    `UPDATE opt_jobs SET cancel_requested=true,
       status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
       completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END,
       error_message=CASE WHEN status='queued' THEN '用户取消' ELSE error_message END
     WHERE id=$1 AND status IN ('queued','running') RETURNING ${jobColumns}`, [id]);
  if (updated.rowCount) return send(res, 202, { job: publicJob(updated.rows[0]) });
  const existing = await pool.query(`SELECT ${jobColumns} FROM opt_jobs WHERE id=$1`, [id]);
  if (!existing.rowCount) return send(res, 404, { error: '优化任务不存在。' });
  return send(res, 409, { error: '任务已结束，无法取消。', job: publicJob(existing.rows[0]) });
}

async function handle(pool, req, res, url, send, readBody) {
  if (url.pathname === '/api/optimization') {
    if (req.method === 'POST') return await createJob(pool, req, res, send, readBody);
    if (req.method === 'GET') return await listJobs(pool, res, send);
    return send(res, 405, { error: '不支持此请求' });
  }
  const match = /^\/api\/optimization\/([A-Za-z0-9-]{8,64})(?:\/(cancel))?$/.exec(url.pathname);
  if (match) {
    if (!uuidPattern.test(match[1])) return send(res, 400, { error: '无效的任务标识。' });
    if (match[2]) {
      if (req.method !== 'POST') return send(res, 405, { error: '不支持此请求' });
      return await cancelJob(pool, res, send, match[1]);
    }
    if (req.method !== 'GET') return send(res, 405, { error: '不支持此请求' });
    return await getJob(pool, res, send, match[1]);
  }
  return send(res, 404, { error: '未找到资源' });
}

module.exports = { setup, handle, profile, validParams };
