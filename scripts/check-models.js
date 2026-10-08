// Integration check for model CRUD, key masking, and default-model activation.
const assert = require('node:assert/strict');

const baseUrl = process.env.APP_URL || 'http://localhost:3000';
const created = [];
const original = new Map();
let temporaryBase = null;
let switchedDocument = null;

async function request(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000)
  });
  const text = await response.text();
  return { status: response.status, data: JSON.parse(text), raw: text };
}

async function waitForParse(documentId, modelId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await request('/api/knowledge-bases/documents');
    const file = result.data.documents.find(item => item.id === documentId);
    if (file?.indexModelId === modelId && file.indexStatus === 'ready') return;
    if (file?.indexModelId === modelId && file.indexStatus === 'failed') throw new Error(file.indexError);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Manual parsing did not finish');
}

async function run() {
  const initial = await request('/api/models');
  assert.equal(initial.status, 200);
  for (const model of initial.data.models.filter(item => item.active)) original.set(model.kind, model);
  assert(original.has('llm') && original.has('embedding'));
  const indexed = (await request('/api/knowledge-bases/documents')).data.documents.filter(item => item.indexStatus === 'ready').length;

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
  assert.equal((await request('/api/knowledge-bases/documents')).data.documents.filter(item => item.indexStatus === 'ready').length, indexed);
  assert.equal((await request(`/api/models/${original.get('embedding').id}/activate`, 'POST')).status, 200);
  const files = (await request('/api/knowledge-bases/documents')).data.documents;
  const first = files.find(item => item.extension === '.docx' && item.indexStatus === 'ready');
  const second = files.find(item => item.extension === '.pptx' && item.indexStatus === 'ready');
  assert(first && second, 'Need parsed DOCX and PPTX documents');
  switchedDocument = { id: first.id, originalModelId: first.indexModelId };
  assert.equal((await request(`/api/documents/${first.id}/parse`, 'POST', { modelId: embedding.data.id })).status, 202);
  await waitForParse(first.id, embedding.data.id);
  const base = await request('/api/knowledge-bases', 'POST', {
    name: `临时混合模型知识库-${Date.now()}`, description: 'Temporary model integration check',
    documentIds: [first.id, second.id]
  });
  assert.equal(base.status, 201, base.raw);
  temporaryBase = base.data.id;
  const query = await request('/api/knowledge/query', 'POST', {
    query: '项目的研究目标与开发计划', mode: 'search', knowledgeBaseIds: [temporaryBase]
  });
  assert.equal(query.status, 200, query.raw);
  assert(query.data.sources.some(source => source.documentId === first.id));
  assert(query.data.sources.some(source => source.documentId === second.id));
  console.log('Model CRUD, key masking, per-file parsing, and mixed-model retrieval checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (temporaryBase) {
    try { assert.equal((await request(`/api/knowledge-bases/${temporaryBase}`, 'DELETE')).status, 200); }
    catch (error) { console.error('Could not remove temporary knowledge base', error); process.exitCode = 1; }
  }
  if (switchedDocument) {
    try {
      assert.equal((await request(`/api/documents/${switchedDocument.id}/parse`, 'POST',
        { modelId: switchedDocument.originalModelId })).status, 202);
    } catch (error) { console.error('Could not restore original document model', error); process.exitCode = 1; }
  }
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
