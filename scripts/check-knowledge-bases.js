// Integration check: creates temporary knowledge bases, verifies scope, then removes them.
const assert = require('node:assert/strict');

const baseUrl = process.env.APP_URL || 'http://localhost:3000';
const created = [];

async function request(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240000)
  });
  return { status: response.status, data: await response.json() };
}

async function run() {
  const files = (await request('/api/knowledge-bases/documents')).data.documents.filter(item => item.indexStatus === 'ready');
  const first = files[0];
  const second = files.find(file => file.filename !== first?.filename);
  assert(first && second, 'Need two different indexed document types for this check');
  const prefix = `验证知识库-${Date.now()}`;
  for (const [name, file] of [[`${prefix}-A`, first], [`${prefix}-B`, second]]) {
    const result = await request('/api/knowledge-bases', 'POST', {
      name, description: 'Temporary integration check', documentIds: [file.id]
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    created.push(result.data.id);
  }
  const noScope = await request('/api/knowledge/query', 'POST', { query: '开发计划', mode: 'search' });
  assert.equal(noScope.status, 400);
  const missingBase = await request('/api/knowledge/query', 'POST', {
    query: '开发计划', mode: 'search', knowledgeBaseIds: ['00000000-0000-4000-8000-000000000000']
  });
  assert.equal(missingBase.status, 400);
  const invalidMember = await request(`/api/knowledge-bases/${created[0]}`, 'PUT', {
    name: `${prefix}-A`, description: '', documentIds: ['not-a-real-document']
  });
  assert.equal(invalidMember.status, 400);
  const allBases = (await request('/api/knowledge-bases')).data.knowledgeBases;
  assert.equal(allBases.find(base => base.id === created[0]).documents.length, 1);
  for (const [baseId, file] of [[created[0], first], [created[1], second]]) {
    const result = await request('/api/knowledge/query', 'POST', {
      query: '项目的研究目标与开发计划', mode: 'search', knowledgeBaseIds: [baseId]
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert(result.data.sources.length > 0);
    assert(result.data.sources.every(source => source.documentId === file.id), 'Retrieval escaped the selected base');
  }
  const combined = await request('/api/knowledge/query', 'POST', {
    query: '项目的研究目标与开发计划', mode: 'search', knowledgeBaseIds: created
  });
  assert.equal(combined.status, 200);
  assert(combined.data.sources.some(source => source.documentId === first.id));
  assert(combined.data.sources.some(source => source.documentId === second.id));
  const moved = await request(`/api/knowledge-bases/${created[0]}`, 'PUT', {
    name: `${prefix}-A`, description: 'Moved to another file', documentIds: [second.id]
  });
  assert.equal(moved.status, 200);
  const afterMove = await request('/api/knowledge/query', 'POST', {
    query: '项目的研究目标与开发计划', mode: 'search', knowledgeBaseIds: [created[0]]
  });
  assert(afterMove.data.sources.length > 0);
  assert(afterMove.data.sources.every(source => source.documentId === second.id));
  const answer = await request('/api/knowledge/query', 'POST', {
    query: '这份资料主要讲什么？', mode: 'answer', knowledgeBaseIds: [created[0]]
  });
  assert.equal(answer.status, 200);
  assert(answer.data.answer || answer.data.answerError);
  assert(answer.data.sources.every(source => source.documentId === second.id));
  const empty = await request('/api/knowledge-bases', 'POST', {
    name: `${prefix}-空`, description: '', documentIds: []
  });
  assert.equal(empty.status, 201);
  created.push(empty.data.id);
  const emptyQuery = await request('/api/knowledge/query', 'POST', {
    query: '开发计划', mode: 'search', knowledgeBaseIds: [empty.data.id]
  });
  assert.equal(emptyQuery.status, 409);
  console.log('Knowledge-base create, scope, multi-select, edit, and Q&A checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const id of created) {
    try { assert.equal((await request(`/api/knowledge-bases/${id}`, 'DELETE')).status, 200); }
    catch (error) { console.error(`Temporary base cleanup failed: ${id}`, error); process.exitCode = 1; }
  }
});
