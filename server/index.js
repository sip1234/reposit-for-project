const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');
const knowledge = require('./knowledge');
const models = require('./models');

const root = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(root, '..', 'dachuang-data'));
const uploadRoot = path.join(dataRoot, 'uploads');
const rawRoot = path.join(dataRoot, 'raw');
const previewRoot = path.join(dataRoot, 'previews');
const maxSize = 10 * 1024 ** 3;
const maxOfficePreview = 100 * 1024 ** 2;
const maxTextPreview = 5 * 1024 ** 2;
const extensions = new Set(['.doc', '.docx', '.txt', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.rtf', '.odt', '.ods', '.odp']);
const officeExtensions = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp']);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const activeJobs = new Set();
const previewJobs = new Map();
const runFile = promisify(execFile);
let conversionChain = Promise.resolve();

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

async function readBody(req, maxBytes = 64 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > maxBytes) throw new Error('请求过大');
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
    error: row.error_message, indexStatus: row.index_status || (row.status === 'ready' ? (knowledge.supported.has(row.extension) ? 'pending' : 'unsupported') : null),
    indexChunks: row.index_chunks || 0, indexError: row.index_error || null };
}

async function convertOfficePreview(row) {
  const destination = path.join(previewRoot, row.id + '.pdf');
  try { if ((await fsp.stat(destination)).size > 0) return destination; } catch { /* Generate below. */ }
  const workDir = await fsp.mkdtemp(path.join(previewRoot, 'work-'));
  const profileDir = path.join(workDir, 'profile');
  try {
    await runFile('libreoffice', [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless', '--convert-to', 'pdf', '--outdir', workDir,
      path.join(rawRoot, row.id + row.extension)
    ], { timeout: 180000, maxBuffer: 1024 * 1024 });
    const output = path.join(workDir, row.id + '.pdf');
    const stat = await fsp.stat(output);
    if (stat.size === 0) throw new Error('转换结果为空');
    await fsp.rename(output, destination);
    return destination;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

function officePreview(row) {
  if (previewJobs.has(row.id)) return previewJobs.get(row.id);
  const task = conversionChain.then(() => convertOfficePreview(row));
  conversionChain = task.catch(() => {});
  previewJobs.set(row.id, task);
  task.finally(() => previewJobs.delete(row.id)).catch(() => {});
  return task;
}

async function streamPdf(req, res, filePath) {
  const stat = await fsp.stat(filePath);
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return send(res, 416, { error: '无效的读取范围' }, { 'Content-Range': `bytes */${stat.size}` });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else {
      const suffix = Number(match[2]);
      start = Math.max(0, stat.size - suffix);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      return send(res, 416, { error: '读取范围超出文件大小' }, { 'Content-Range': `bytes */${stat.size}` });
    }
    status = 206;
  }
  const headers = {
    'Content-Type': 'application/pdf',
    'Content-Length': end - start + 1,
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN'
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', error => { console.error('Preview stream failed', error); res.destroy(); });
  stream.pipe(res);
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
    const result = await pool.query(`SELECT d.*, d.created_at::text AS cursor_date,
      j.status AS index_status, j.chunk_count AS index_chunks, j.error AS index_error
      FROM documents d LEFT JOIN document_index_jobs j ON j.sha256=d.sha256
      WHERE ($1::text = '' OR position(lower($1) in lower(d.filename)) > 0)
        AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2::timestamptz, $3::text))
      ORDER BY d.created_at DESC, d.id DESC LIMIT 101`,
    [query, cursor?.date || null, cursor?.id || '']);
    const rows = result.rows.slice(0, 100);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > 100 && last
      ? Buffer.from(JSON.stringify({ date: last.cursor_date, id: last.id })).toString('base64url') : null;
    return send(res, 200, { documents: rows.map(publicRow), nextCursor, maxFileBytes: maxSize });
  }
  const match = /^\/api\/documents\/([A-Za-z0-9_-]{8,256})\/(download|preview|preview-file|preview-text)$/.exec(url.pathname);
  if ((req.method === 'GET' || req.method === 'HEAD') && match) {
    const result = await pool.query('SELECT * FROM documents WHERE id=$1', [match[1]]);
    const row = result.rows[0];
    if (!row || row.status !== 'ready') return send(res, 404, { error: '文件不存在或尚未保存完成' });
    const filePath = path.join(rawRoot, row.id + row.extension);
    if (match[2] === 'preview') {
      if (row.extension === '.pdf') return send(res, 200, { kind: 'pdf', url: `/api/documents/${row.id}/preview-file` });
      if (row.extension === '.txt' || row.extension === '.csv') {
        return send(res, 200, { kind: 'text', url: `/api/documents/${row.id}/preview-text`, truncated: Number(row.size_bytes) > maxTextPreview });
      }
      if (officeExtensions.has(row.extension)) {
        if (Number(row.size_bytes) > maxOfficePreview) {
          return send(res, 200, { kind: 'unavailable', message: 'Office 文件超过 100 MiB，预览可能消耗过多资源，请下载原件查看。' });
        }
        try {
          await officePreview(row);
          return send(res, 200, { kind: 'pdf', url: `/api/documents/${row.id}/preview-file` });
        } catch (error) {
          console.error('Preview conversion failed', row.id, error);
          return send(res, 422, { error: '无法生成此文件的预览，请下载原件查看。' });
        }
      }
      return send(res, 415, { error: '暂不支持预览此类文件' });
    }
    if (match[2] === 'preview-file') {
      if (row.extension === '.pdf') return streamPdf(req, res, filePath);
      if (officeExtensions.has(row.extension) && Number(row.size_bytes) <= maxOfficePreview) {
        const converted = await officePreview(row);
        return streamPdf(req, res, converted);
      }
      return send(res, 415, { error: '此文件没有 PDF 预览' });
    }
    if (match[2] === 'preview-text') {
      if (row.extension !== '.txt' && row.extension !== '.csv') return send(res, 415, { error: '此文件不是文本' });
      const stat = await fsp.stat(filePath);
      const length = Math.min(stat.size, maxTextPreview);
      const data = Buffer.alloc(length);
      const handle = await fsp.open(filePath, 'r');
      let received = 0;
      try {
        while (received < length) {
          const { bytesRead } = await handle.read(data, received, length - received, received);
          if (bytesRead === 0) break;
          received += bytesRead;
        }
      } finally { await handle.close(); }
      const input = data.subarray(0, received);
      let content;
      if (input[0] === 0xff && input[1] === 0xfe) content = new TextDecoder('utf-16le').decode(input);
      else if (input[0] === 0xfe && input[1] === 0xff) content = new TextDecoder('utf-16be').decode(input);
      else {
        content = new TextDecoder('utf-8').decode(input);
        if ((content.match(/\uFFFD/g) || []).length > 2) content = new TextDecoder('gb18030').decode(input);
      }
      const output = Buffer.from(content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': output.length,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      res.end(output);
      return;
    }
    if (req.method !== 'GET') return send(res, 405, { error: '不支持此请求' });
    const stat = await fsp.stat(filePath);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    const stream = fs.createReadStream(filePath);
    stream.on('error', error => { console.error('Download stream failed', error); res.destroy(); });
    stream.pipe(res);
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
  ['/assistant.js', ['assistant.js', 'application/javascript; charset=utf-8']],
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
    if (url.pathname === '/api/knowledge/query') return await knowledge.handle(pool, req, res, send, readBody);
    if (url.pathname.startsWith('/api/knowledge-bases')) return await knowledge.handleBases(pool, req, res, url, send, readBody);
    if (url.pathname.startsWith('/api/models')) return await models.handle(pool, req, res, url, send, readBody);
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
  await fsp.mkdir(previewRoot, { recursive: true });
  await pool.query(`CREATE TABLE IF NOT EXISTS documents (
    id text PRIMARY KEY, filename text NOT NULL, extension text NOT NULL,
    size_bytes bigint NOT NULL, mime_type text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('uploading','finalizing','ready','failed')),
    sha256 text, storage_path text, error_message text,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS documents_created_id_idx ON documents (created_at DESC, id DESC)');
  await knowledge.setup(pool);
  await models.setup(pool);
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
