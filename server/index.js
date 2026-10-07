const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(root, '..', 'dachuang-data'));
const uploadRoot = path.join(dataRoot, 'uploads');
const rawRoot = path.join(dataRoot, 'raw');
const maxSize = 10 * 1024 ** 3;
const extensions = new Set(['.doc', '.docx', '.txt', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.rtf', '.odt', '.ods', '.odp']);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const activeJobs = new Set();

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 255);
}

function validUpload(upload, requireId = true) {
  const name = cleanName(upload?.MetaData?.filename);
  const ext = path.extname(name).toLowerCase();
  const size = Number(upload?.Size);
  if (!name || !extensions.has(ext)) return { error: '仅支持 Word、TXT、PDF、Excel、PPT、CSV、RTF 和 OpenDocument 文件。' };
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxSize || upload?.SizeIsDeferred) return { error: '文件大小必须在 0 到 10 GiB 之间，并在上传前确定。' };
  if (requireId && !/^[A-Za-z0-9_-]{8,256}$/.test(String(upload?.ID || ''))) return { error: '无效的上传标识。' };
  return { id: upload.ID, name, ext, size, mime: String(upload?.MetaData?.filetype || '').slice(0, 120) };
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new Error('请求过大');
  }
  return JSON.parse(data);
}

async function registerUpload(file) {
  await pool.query(`INSERT INTO documents (id, filename, extension, size_bytes, mime_type, status)
    VALUES ($1,$2,$3,$4,$5,'uploading')
    ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, extension=EXCLUDED.extension,
      size_bytes=EXCLUDED.size_bytes, mime_type=EXCLUDED.mime_type`,
    [file.id, file.name, file.ext, file.size, file.mime]);
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function finalize(id) {
  const result = await pool.query('SELECT * FROM documents WHERE id=$1', [id]);
  const row = result.rows[0];
  if (!row || row.status === 'ready') return;
  const source = path.join(uploadRoot, id);
  const destination = path.join(rawRoot, id + row.extension);
  try {
    await fsp.mkdir(rawRoot, { recursive: true });
    let filePath = destination;
    try { await fsp.access(destination); }
    catch {
      const stat = await fsp.stat(source);
      if (stat.size !== Number(row.size_bytes)) throw new Error('上传文件大小与记录不符');
      filePath = source;
    }
    const digest = await sha256(filePath);
    if (filePath === source) await fsp.rename(source, destination);
    await pool.query(`UPDATE documents SET status='ready', sha256=$2, storage_path=$3,
      completed_at=COALESCE(completed_at, now()), error_message=NULL WHERE id=$1`, [id, digest, destination]);
    await fsp.rm(path.join(uploadRoot, id + '.info'), { force: true }).catch(() => {});
  } catch (error) {
    console.error('Finalization failed', id, error);
    await pool.query("UPDATE documents SET status='failed', error_message=$2 WHERE id=$1", [id, String(error.message).slice(0, 500)]);
  }
}

function queueFinalize(id) {
  if (activeJobs.has(id)) return;
  activeJobs.add(id);
  setImmediate(() => finalize(id).catch(error => console.error('Finalize job failed', id, error)).finally(() => activeJobs.delete(id)));
}

async function hook(req, res, url) {
  if (!process.env.HOOK_TOKEN || url.searchParams.get('token') !== process.env.HOOK_TOKEN) return send(res, 403, { error: 'Forbidden' });
  const body = await readBody(req);
  const event = body?.Event?.Upload;
  const file = validUpload(event, body.Type !== 'pre-create');
  if (body.Type === 'pre-create') {
    if (file.error) return send(res, 200, { RejectUpload: true, HTTPResponse: { StatusCode: 400, Body: file.error } });
    return send(res, 200, {});
  }
  if (file.error) return send(res, 400, { error: file.error });
  if (body.Type === 'post-create' || body.Type === 'post-finish') {
    await registerUpload(file);
    if (body.Type === 'post-finish') {
      await pool.query("UPDATE documents SET status='finalizing' WHERE id=$1 AND status<>'ready'", [file.id]);
      queueFinalize(file.id);
    }
  }
  return send(res, 200, {});
}

function publicRow(row) {
  return { id: row.id, filename: row.filename, sizeBytes: Number(row.size_bytes), mimeType: row.mime_type,
    status: row.status, sha256: row.sha256, createdAt: row.created_at, completedAt: row.completed_at,
    error: row.error_message };
}

async function documents(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 200);
    let cursor;
    try {
      if (url.searchParams.has('cursor')) {
        cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString('utf8'));
        if (!Number.isFinite(Date.parse(cursor.date)) || !/^[A-Za-z0-9_-]{8,256}$/.test(cursor.id)) throw new Error();
      }
    } catch { return send(res, 400, { error: '无效的分页位置' }); }
    const result = await pool.query(`SELECT *, created_at::text AS cursor_date FROM documents
      WHERE ($1::text = '' OR position(lower($1) in lower(filename)) > 0)
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
      ORDER BY created_at DESC, id DESC LIMIT 101`,
    [query, cursor?.date || null, cursor?.id || '']);
    const rows = result.rows.slice(0, 100);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > 100 && last
      ? Buffer.from(JSON.stringify({ date: last.cursor_date, id: last.id })).toString('base64url') : null;
    return send(res, 200, { documents: rows.map(publicRow), nextCursor, maxFileBytes: maxSize });
  }
  const match = /^\/api\/documents\/([A-Za-z0-9_-]{8,256})\/download$/.exec(url.pathname);
  if (req.method === 'GET' && match) {
    const result = await pool.query('SELECT * FROM documents WHERE id=$1', [match[1]]);
    const row = result.rows[0];
    if (!row || row.status !== 'ready') return send(res, 404, { error: '文件不存在或尚未保存完成' });
    const filePath = path.join(rawRoot, row.id + row.extension);
    const stat = await fsp.stat(filePath);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  return send(res, 404, { error: '未找到资源' });
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/documents.js', ['documents.js', 'application/javascript; charset=utf-8']],
  ['/vendor/tus.min.js', ['node_modules/tus-js-client/dist/tus.min.js', 'application/javascript; charset=utf-8']]
]);

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/internal/tusd-hook') return await hook(req, res, url);
    if (url.pathname.startsWith('/api/')) return await documents(req, res, url);
    const asset = staticFiles.get(url.pathname);
    if (req.method !== 'GET' || !asset) return send(res, 404, { error: '未找到资源' });
    const filePath = path.join(root, asset[0]);
    const stat = await fsp.stat(filePath);
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: '服务暂时不可用' });
    else res.destroy();
  }
}

async function start() {
  await fsp.mkdir(uploadRoot, { recursive: true });
  await fsp.mkdir(rawRoot, { recursive: true });
  await pool.query(`CREATE TABLE IF NOT EXISTS documents (
    id text PRIMARY KEY, filename text NOT NULL, extension text NOT NULL,
    size_bytes bigint NOT NULL, mime_type text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('uploading','finalizing','ready','failed')),
    sha256 text, storage_path text, error_message text,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS documents_created_id_idx ON documents (created_at DESC, id DESC)');
  const unfinished = await pool.query("SELECT id, status FROM documents WHERE status <> 'ready'");
  for (const row of unfinished.rows) {
    if (row.status !== 'uploading') { queueFinalize(row.id); continue; }
    try {
      const info = JSON.parse(await fsp.readFile(path.join(uploadRoot, row.id + '.info'), 'utf8'));
      if (Number(info.Offset) === Number(info.Size)) queueFinalize(row.id);
    } catch { /* A partial upload remains resumable in tusd. */ }
  }
  const server = http.createServer(handler);
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Document API listening'));
}

start().catch(error => { console.error(error); process.exit(1); });
