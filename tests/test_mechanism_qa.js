const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.HOOK_TOKEN ||= 'only-a-unit-test-placeholder-not-a-real-key';
const qa = require('../server/mechanism-qa');
const simulation = require('../server/simulation');

const runId = '11111111-1111-4111-8111-111111111111';
const simId = '22222222-2222-4222-8222-222222222222';
const baseId = '33333333-3333-4333-8333-333333333333';
const params = { horizonDays: 13.9, evalDays: 7, doSetpoint: 2, recycleRatio: 3, carbonDose: 0,
  influent: 'dry', profileId: 'bsm1-default', loadFactor: 1, stabilize: true };
const observed = { metric: 'effluentSnhMean', value: 3.2, unit: 'mg/L', windowDays: 7,
  statistic: 'mean', dataContext: 'benchmark', definition: 'bsm1', influent: 'dry',
  loadFactor: 1, initialization: 'stabilized' };
const metrics = { effluentSnhMean: 3, weather: 'dry', horizonDays: 13.9, evalDays: 7,
  doSetpoint: 2, recycleRatio: 3, carbonDose: 0, schemaVersion: 1, profileId: 'bsm1-default',
  loadFactor: 1, stabilized: true, modelVersion: '0.0.16', codeVersion: 'dev',
  influentSha256: 'a'.repeat(64), paramsHash: 'b'.repeat(64) };
const run = () => ({ id: runId, status: 'queued', question: '出水氨氮是否一致？', knowledge_base_ids: [baseId],
  params: { ...params }, observed: { ...observed }, simulation_job_id: simId,
  sources: [{ number: 1, documentId: 'doc-12345678', versionId: runId, chunkIndex: 0,
    revision: 0, filename: '工况记录.txt', locator: '第 1 行', excerpt: '出水氨氮记录为 10 mg/L。' }],
  initial_retrieval_run_id: runId, retrieval_run_id: runId });
function fakePool(record, sim = { status: 'ready', params: { ...params }, profile_id: 'bsm1-default',
  model_version: '0.0.16', code_version: 'dev', influent_sha256: 'a'.repeat(64), progress: 1 }, result = metrics) {
  const writes = [];
  return { writes, async query(sql, values = []) {
    if (sql.startsWith('SELECT * FROM mechanism_qa_runs')) return { rows: [record], rowCount: 1 };
    if (sql.startsWith('SELECT status,params,profile_id,model_version')) return { rows: [sim], rowCount: 1 };
    if (sql.startsWith('SELECT schema_version,metrics FROM sim_results')) return { rows: result ? [{ schema_version: 1, metrics: result }] : [], rowCount: result ? 1 : 0 };
    writes.push({ sql, values });
    if (sql.includes("SET status='failed'")) { record.status = 'failed'; record.error_message = values[1]; }
    return { rows: [], rowCount: 1 };
  } };
}

test('explicit valid input and metric specific comparison rules', () => {
  const input = qa.validateInput({ query: ' 出水氨氮是否一致？ ', knowledgeBaseIds: [baseId], params, observed });
  assert.equal(input.question, '出水氨氮是否一致？');
  const match = qa.compare(params, observed, metrics);
  assert.equal(match.verdict, 'match');
  assert.equal(match.absoluteDifference, 0.2);
  assert.deepEqual(match.threshold, { kind: 'absolute', value: 0.5, unit: 'mg/L' });
  assert.equal(qa.compare(params, { ...observed, value: 10 }, metrics).verdict, 'mismatch');
  assert.equal(qa.METRICS.aerationEnergy.threshold.kind, 'relative');
  assert.notEqual(qa.METRICS.aerationEnergy.threshold.value, qa.METRICS.mixingEnergy.threshold.value);
  assert.throws(() => qa.validateInput({ query: '测试', knowledgeBaseIds: [baseId], params: { evalDays: 7 }, observed }), /完整填写/);
  assert.throws(() => qa.validateInput({ query: '测试', knowledgeBaseIds: [baseId], params, observed: { ...observed, metric: 'eqi' } }), /EQI/);
});

test('create flow saves retrieved source identity and simulation job in one transaction', async () => {
  const events = [];
  const source = run().sources[0];
  const client = { async query(sql, values) { events.push({ sql, values }); return { rowCount: 1 }; }, release() { events.push({ sql: 'release' }); } };
  const input = qa.validateInput({ query: '出水氨氮是否一致？', knowledgeBaseIds: [baseId], params, observed });
  const created = await qa.createRun({ connect: async () => client }, input, {
    retrieve: async (_pool, question, scope) => { assert.equal(question, input.question); assert.deepEqual(scope.knowledgeBaseIds, [baseId]); return { id: runId }; },
    refresh: async () => {}, snapshot: () => [source],
    enqueue: async (_client, p) => { assert.deepEqual(p, params); return { id: simId, status: 'queued' }; }
  });
  assert.equal(created.simulationJobId, simId);
  assert.deepEqual(events.map(e => e.sql.startsWith('INSERT') ? 'INSERT' : e.sql), ['BEGIN', 'INSERT', 'COMMIT', 'release']);
  assert.equal(events[1].values[6], runId);
  assert.equal(JSON.parse(events[1].values[7])[0].versionId, runId);
});

test('shared simulation enqueue retains trace metadata and existing POST response', async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ id: simId, status: 'queued', params: values[1] && JSON.parse(values[1]),
      profile_id: 'bsm1-default', model_version: 'bsm2-python==0.0.16', code_version: 'dev', progress: 0 }] };
  } };
  let response;
  await simulation.handle(pool, { method: 'POST' }, {}, new URL('http://localhost/api/simulation'),
    (_res, status, body) => { response = { status, body }; }, async () => params);
  assert.equal(response.status, 201);
  assert.equal(response.body.profile.profileId, 'bsm1-default');
  assert.equal(response.body.job.profileId, 'bsm1-default');
  assert.match(calls[0].sql, /profile_id, model_version, code_version/);
  assert.equal(calls[0].values[2], 'bsm1-default');
});

test('unit, time window, definition, influent and plant applicability block numerical verdicts', () => {
  assert.equal(qa.compare(params, { ...observed, unit: 'kWh/d' }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, unit: 'g/m³' }, metrics).verdict, 'match');
  assert.equal(qa.compare(params, { ...observed, windowDays: 3 }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, windowDays: null }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, statistic: 'daily_mean' }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, definition: 'unknown' }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, influent: 'rain' }, metrics).verdict, 'not_applicable');
  assert.equal(qa.compare(params, { ...observed, loadFactor: null }, metrics).verdict, 'insufficient');
  assert.equal(qa.compare(params, { ...observed, loadFactor: 1.3 }, metrics).verdict, 'not_applicable');
  assert.equal(qa.compare(params, { ...observed, initialization: 'unknown' }, metrics).verdict, 'insufficient');
  const plant = qa.compare(params, { ...observed, dataContext: 'plant' }, metrics);
  assert.equal(plant.verdict, 'not_applicable');
  assert.equal(plant.absoluteDifference, null);
});

test('simulation evidence is read by task ID and checked against stored parameters and metric echoes', async () => {
  const record = run();
  assert.deepEqual((await qa.readSimulation(fakePool(record), record)).metrics, metrics);
  const job = { status: 'ready', params, profile_id: 'bsm1-default', model_version: '0.0.16',
    code_version: 'dev', influent_sha256: 'a'.repeat(64), progress: 1 };
  await assert.rejects(() => qa.readSimulation(fakePool(record, { ...job, params: { ...params, doSetpoint: 4 } }), record), /参数.*不一致/);
  await assert.rejects(() => qa.readSimulation(fakePool(record, job, { ...metrics, weather: 'rain' }), record), /结果记录的工况/);
  await assert.rejects(() => qa.readSimulation(fakePool(record, job, { ...metrics, schemaVersion: 0 }), record), /结果记录的工况/);
  await assert.rejects(() => qa.readSimulation(fakePool(record, { ...job, model_version: 'other' }), record), /结果记录的工况/);
  await assert.rejects(() => qa.readSimulation(fakePool(record, job, { ...metrics, loadFactor: 1.3 }), record), /负荷系数/);
  await assert.rejects(() => qa.readSimulation(fakePool(record, job, null), record), /结果尚未保存/);
});

test('document number conflicts with BSM1 value: deterministic verdict and provenance reach LLM', async () => {
  const record = run(); record.observed.value = 10;
  const pool = fakePool(record);
  let evidence;
  await qa.finalize(pool, runId, {
    retrieve: async () => ({ id: baseId }), refresh: async () => {}, snapshot: () => record.sources,
    activeModel: async () => ({ name: 'fake' }),
    chat: async (_model, messages) => { evidence = JSON.parse(messages[1].content); return '文档记录与标准工况模拟值存在偏差。[文档1] [仿真:22222222-2222-4222-8222-222222222222]'; }
  });
  assert.equal(evidence.comparison.verdict, 'mismatch');
  assert.equal(evidence.simulation.rawMetrics.effluentSnhMean, 3);
  assert.equal(evidence.documents[0].versionId, runId);
  assert.match(evidence.documents[0].excerpt, /10 mg\/L/);
  assert(pool.writes.some(w => w.sql.includes('raw_metrics=$2,comparison=$3') && w.values[2].verdict === 'mismatch'));
  assert(pool.writes.some(w => w.sql.includes("status='ready'") && w.values[1].includes(`[仿真:${simId}]`)));
});

test('LLM failure keeps comparison, model metrics and sources as a partial result', async () => {
  const record = run(); const pool = fakePool(record);
  await qa.finalize(pool, runId, {
    retrieve: async () => ({ id: baseId }), refresh: async () => {}, snapshot: () => record.sources,
    activeModel: async () => ({ name: 'fake' }), chat: async () => { throw new Error('服务不可用'); }
  });
  assert(pool.writes.some(w => w.sql.includes('raw_metrics=$2,comparison=$3')));
  assert(pool.writes.some(w => w.sql.includes("status='partial'") && w.values[1].includes('服务不可用')));
  assert.deepEqual(record.sources[0].documentId, 'doc-12345678');
});

test('changed document after LLM call suppresses stale answer and retains numerical comparison', async () => {
  const record = run(); const pool = fakePool(record);
  await qa.finalize(pool, runId, {
    retrieve: async () => ({ id: baseId }),
    refresh: async (_pool, _result, phase) => phase === 'mechanism_after_answer',
    snapshot: () => record.sources, activeModel: async () => ({ name: 'fake' }),
    chat: async () => '旧资料生成的回答'
  });
  assert(pool.writes.some(w => w.sql.includes('raw_metrics=$2,comparison=$3')));
  assert(pool.writes.some(w => w.sql.includes("status='partial',sources=$2") && w.values[2].includes('资料发生变化')));
  assert(!pool.writes.some(w => w.sql.includes("status='ready'")));
});

test('failed simulator is reported without discarding retrieved sources', async () => {
  for (const [jobStatus, message] of [['failed', '积分器失败'], ['cancelled', '用户取消']]) {
    const record = run();
    const pool = fakePool(record, { status: jobStatus, params, progress: 0.3, error_message: message });
    let response;
    await qa.handle(pool, { method: 'GET' }, {}, new URL(`http://localhost/api/mechanism-qa/${runId}`),
      (_res, status, body) => { response = { status, body }; }, async () => ({}));
    assert.equal(response.status, 200);
    assert.equal(response.body.run.status, 'failed');
    assert.match(response.body.run.error, new RegExp(message));
    assert.equal(response.body.run.sources.length, 1);
  }
});
