// Integration check for model CRUD, key masking, activation, and embedding reindexing.
const assert = require('node:assert/strict');

const baseUrl = process.env.APP_URL || 'http://localhost:3000';
const created = [];
const original = new Map();

async function request(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000)
  });
  const text = await response.text();
  return { status: response.status, data: JSON.parse(text), raw: text };
}

async function waitForIndexed(count) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await request('/api/knowledge-bases/documents');
    if (result.data.documents.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Embedding reindex did not finish within two minutes');
}

async function run() {
  const initial = await request('/api/models');
  assert.equal(initial.status, 200);
  for (const model of initial.data.models.filter(item => item.active)) original.set(model.kind, model);
  assert(original.has('llm') && original.has('embedding'));
  const indexed = (await request('/api/knowledge-bases/documents')).data.documents.length;

  const rejected = await request('/api/models', 'POST', {
    name: 'Invalid DeepSeek embedding', provider: 'deepseek', kind: 'embedding',
    modelName: 'deepseek-flash', apiKey: 'dummy-test-key'
  });
  assert.equal(rejected.status, 400);

  const deepseek = await request('/api/models', 'POST', {
    name: 'Temporary DeepSeek', provider: 'deepseek', kind: 'llm',
    modelName: 'deepseek-flash', apiKey: 'dummy-test-key-never-send'
  });
  assert.equal(deepseek.status, 201, deepseek.raw);
  created.push(deepseek.data.id);
  const listing = await request('/api/models');
  assert(!listing.raw.includes('dummy-test-key'));
  assert(listing.data.models.find(item => item.id === deepseek.data.id).hasApiKey);

  const llm = await request('/api/models', 'POST', {
    name: 'Temporary local LLM', provider: 'ollama', kind: 'llm',
    modelName: original.get('llm').modelName
  });
  assert.equal(llm.status, 201, llm.raw);
  created.push(llm.data.id);
  assert.equal((await request(`/api/models/${llm.data.id}/activate`, 'POST')).status, 200);
  assert.equal((await request('/api/models')).data.models.find(item => item.id === llm.data.id).active, true);
  assert.equal((await request(`/api/models/${original.get('llm').id}/activate`, 'POST')).status, 200);

  const embedding = await request('/api/models', 'POST', {
    name: 'Temporary local embedding', provider: 'ollama', kind: 'embedding',
    modelName: original.get('embedding').modelName
  });
  assert.equal(embedding.status, 201, embedding.raw);
  created.push(embedding.data.id);
  assert.equal(embedding.data.id.length, 36);
  const dimensions = (await request('/api/models')).data.models.find(item => item.id === embedding.data.id).dimensions;
  assert.equal(dimensions, original.get('embedding').dimensions);
  assert.equal((await request(`/api/models/${embedding.data.id}/activate`, 'POST')).status, 200);
  await waitForIndexed(indexed);
  assert.equal((await request(`/api/models/${original.get('embedding').id}/activate`, 'POST')).status, 200);
  await waitForIndexed(indexed);
  console.log('Model CRUD, key masking, activation, and embedding reindex checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const model of original.values()) {
    try {
      const current = (await request('/api/models')).data.models.find(item => item.id === model.id);
      if (current && !current.active) await request(`/api/models/${model.id}/activate`, 'POST');
    } catch (error) { console.error('Could not restore original model', error); process.exitCode = 1; }
  }
  for (const id of created.reverse()) {
    try { assert.equal((await request(`/api/models/${id}`, 'DELETE')).status, 200); }
    catch (error) { console.error(`Could not clean up model ${id}`, error); process.exitCode = 1; }
  }
});
