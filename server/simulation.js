// 机理模型（BSM1）仿真任务：建表、入队、查询状态与结果、取消任务。
// 表结构与 simulator/run.py 中的 DDL 保持一致（沿用仓库既有的双方各自保证建表可用的做法）。
const crypto = require('node:crypto');
const profile = require('../shared/plant_profile.json');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const weathers = new Set(['dry', 'rain']);
const codeVersion = process.env.CODE_VERSION || 'dev';
const jobColumns = `id, status, params, profile_id, model_version, code_version, influent_sha256,
  cancel_requested, progress, error_message, created_at, started_at, completed_at`;

async function setup(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS sim_jobs (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
    params jsonb NOT NULL,
    profile_id text NOT NULL DEFAULT 'bsm1-default',
    model_version text,
    code_version text,
    influent_sha256 text,
    cancel_requested boolean NOT NULL DEFAULT false,
    progress numeric NOT NULL DEFAULT 0,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sim_results (
    job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE CASCADE,
    schema_version integer NOT NULL DEFAULT 1,
    metrics jsonb NOT NULL,
    series jsonb NOT NULL,
    notes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // 兼容旧库：只加列，不重建表。
  await pool.query(`ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS profile_id text NOT NULL DEFAULT 'bsm1-default';
    ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS model_version text;
    ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS code_version text;
    ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS influent_sha256 text;
    ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE sim_results ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
    ALTER TABLE sim_jobs DROP CONSTRAINT IF EXISTS sim_jobs_status_check;
    ALTER TABLE sim_jobs ADD CONSTRAINT sim_jobs_status_check
      CHECK (status IN ('queued','running','ready','failed','cancelled'));`);
  await pool.query('CREATE INDEX IF NOT EXISTS sim_jobs_status_created_idx ON sim_jobs (status, created_at)');
}

function numberIn(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function range(name) {
  return profile.hardRanges[name];
}

function validParams(body) {
  const horizonDays = numberIn(body?.horizonDays, 1, profile.evaluation.horizonDays, profile.evaluation.horizonDays);
  const rawEval = numberIn(body?.evalDays, 1, Math.min(13, Math.floor(profile.evaluation.horizonDays)), profile.evaluation.evalDays);
  const doRange = range('doSetpoint');
  const recycleRange = range('recycleRatio');
  const carbonRange = range('carbonDose');
  const doSetpoint = numberIn(body?.doSetpoint, doRange.min, doRange.max, doRange.default);
  const recycleRatio = numberIn(body?.recycleRatio, recycleRange.min, recycleRange.max, recycleRange.default);
  const carbonDose = numberIn(body?.carbonDose, carbonRange.min, carbonRange.max, carbonRange.default);
  const influent = body?.influent === undefined ? profile.evaluation.influent : String(body.influent);
  const requestedProfile = body?.plantProfileId === undefined ? profile.profileId : String(body.plantProfileId);
  if (requestedProfile !== profile.profileId) return { error: `当前仅支持 plantProfileId=${profile.profileId}。` };
  if (horizonDays === null) return { error: `仿真时长须在 1 到 ${profile.evaluation.horizonDays} 天之间。` };
  // 底层库要求评价窗口为整天
  const evalDays = rawEval === null ? null : Math.round(rawEval);
  if (evalDays === null || evalDays > horizonDays) return { error: '评价窗口须为 1 到 13 之间的整天，且不超过仿真时长。' };
  if (doSetpoint === null) return { error: `溶解氧设定值须在 ${doRange.min} 到 ${doRange.max} mg/L 之间。` };
  if (recycleRatio === null) return { error: `内回流倍数须在 ${recycleRange.min} 到 ${recycleRange.max} 之间。` };
  if (carbonDose === null) return { error: `外加碳源投加量须在 ${carbonRange.min} 到 ${carbonRange.max} m³/d 之间。` };
  if (!weathers.has(influent)) return { error: '仅支持 dry 或 rain 两种天气文件。' };
  return {
    params: {
      horizonDays, evalDays, doSetpoint, recycleRatio, carbonDose, influent,
      profileId: profile.profileId
    }
  };
}

function publicJob(row) {
  return {
    id: row.id, status: row.status, params: row.params, profileId: row.profile_id,
    modelVersion: row.model_version || null, codeVersion: row.code_version || null,
    influentSha256: row.influent_sha256 || null, cancelRequested: Boolean(row.cancel_requested),
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
    `INSERT INTO sim_jobs (id, status, params, profile_id, model_version, code_version)
     VALUES ($1, 'queued', $2, $3, $4, $5) RETURNING ${jobColumns}`,
    [id, JSON.stringify(parsed.params), profile.profileId, profile.modelImplementation, codeVersion]);
  return send(res, 201, { job: publicJob(result.rows[0]), profile });
}

async function listJobs(pool, res, send) {
  const result = await pool.query(
    `SELECT ${jobColumns} FROM sim_jobs ORDER BY created_at DESC LIMIT 20`);
  return send(res, 200, { jobs: result.rows.map(publicJob), profile });
}

async function getJob(pool, res, send, id) {
  const job = await pool.query(`SELECT ${jobColumns} FROM sim_jobs WHERE id=$1`, [id]);
  if (!job.rowCount) return send(res, 404, { error: '仿真任务不存在。' });
  const result = await pool.query(
    'SELECT schema_version, metrics, series, notes, created_at FROM sim_results WHERE job_id=$1', [id]);
  return send(res, 200, {
    job: publicJob(job.rows[0]),
    result: result.rowCount ? {
      schemaVersion: result.rows[0].schema_version,
      metrics: result.rows[0].metrics, series: result.rows[0].series,
      notes: result.rows[0].notes, createdAt: result.rows[0].created_at
    } : null
  });
}

async function cancelJob(pool, res, send, id) {
  const updated = await pool.query(
    `UPDATE sim_jobs SET cancel_requested=true,
       status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
       completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END,
       error_message=CASE WHEN status='queued' THEN '用户取消' ELSE error_message END
     WHERE id=$1 AND status IN ('queued','running') RETURNING ${jobColumns}`, [id]);
  if (updated.rowCount) return send(res, 202, { job: publicJob(updated.rows[0]) });
  const existing = await pool.query(`SELECT ${jobColumns} FROM sim_jobs WHERE id=$1`, [id]);
  if (!existing.rowCount) return send(res, 404, { error: '仿真任务不存在。' });
  return send(res, 409, { error: '任务已结束，无法取消。', job: publicJob(existing.rows[0]) });
}

async function handle(pool, req, res, url, send, readBody) {
  if (url.pathname === '/api/simulation/profile') {
    if (req.method !== 'GET') return send(res, 405, { error: '不支持此请求' });
    return send(res, 200, { profile, codeVersion });
  }
  if (url.pathname === '/api/simulation') {
    if (req.method === 'POST') return await createJob(pool, req, res, send, readBody);
    if (req.method === 'GET') return await listJobs(pool, res, send);
    return send(res, 405, { error: '不支持此请求' });
  }
  const match = /^\/api\/simulation\/([A-Za-z0-9-]{8,64})(?:\/(cancel))?$/.exec(url.pathname);
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

module.exports = { setup, handle, profile, validParams, codeVersion };
