const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const api = 'http://localhost:3000';
const tusd = 'http://localhost:1080/files/';
const filename = `upload-check-${Date.now()}.txt`;
const data = Buffer.from('Knowledge document upload integration check.\n', 'utf8');

async function run() {
  const health = await fetch(`${api}/api/health`);
  assert.equal(health.status, 200);
  const rejected = await fetch(tusd, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': '12',
      'Upload-Metadata': `filename ${Buffer.from('blocked.exe').toString('base64')}`
    }
  });
  assert.equal(rejected.status, 400, await rejected.text());
  const created = await fetch(tusd, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(data.length),
      'Upload-Metadata': `filename ${Buffer.from(filename).toString('base64')},filetype ${Buffer.from('text/plain').toString('base64')}`
    }
  });
  assert.equal(created.status, 201, await created.text());
  const location = new URL(created.headers.get('location'), tusd).toString();
  const id = location.split('/').pop();
  let response = await fetch(location, {
    method: 'PATCH',
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
    body: data.subarray(0, 12)
  });
  assert.equal(response.status, 204, await response.text());
  response = await fetch(location, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
  assert.equal(response.headers.get('upload-offset'), '12');
  response = await fetch(location, {
    method: 'PATCH',
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '12', 'Content-Type': 'application/offset+octet-stream' },
    body: data.subarray(12)
  });
  assert.equal(response.status, 204, await response.text());
  let document;
  for (let i = 0; i < 30; i++) {
    const listing = await (await fetch(`${api}/api/documents`)).json();
    document = listing.documents.find(item => item.id === id);
    if (document?.status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(document?.status, 'ready', JSON.stringify(document));
  assert.equal(document.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  const downloaded = await fetch(`${api}/api/documents/${id}/download`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), data);
  console.log(JSON.stringify({ id, filename, status: document.status, bytes: data.length }));
}

run().catch(error => { console.error(error); process.exitCode = 1; });
