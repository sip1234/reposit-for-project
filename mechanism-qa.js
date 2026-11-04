// 独立的机理校验问答 UI；普通文档问答仍由 assistant.js 管理。
(() => {
  const $ = id => document.getElementById(id);
  const form = $('mechanism-qa-form');
  const results = $('mechanism-results');
  const status = $('mechanism-status');
  const selectedBases = new Set();
  const baseNames = new Map();
  let metrics = {};
  let activeRunId = null;
  let pollTimer = null;

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  }
  async function loadBases() {
    try {
      const data = await request('/api/knowledge-bases');
      const host = $('mechanism-base-options');
      host.replaceChildren();
      baseNames.clear();
      const availableIds = new Set((data.knowledgeBases || []).map(base => base.id));
      for (const id of selectedBases) if (!availableIds.has(id)) selectedBases.delete(id);
      for (const base of data.knowledgeBases || []) {
        baseNames.set(base.id, base.name);
        const label = node('label', undefined, 'assistant-base-option');
        const check = node('input'); check.type = 'checkbox'; check.value = base.id;
        check.checked = selectedBases.has(base.id);
        check.addEventListener('change', () => check.checked ? selectedBases.add(base.id) : selectedBases.delete(base.id));
        label.append(check, node('strong', base.name));
        host.append(label);
      }
      if (!host.children.length) host.textContent = '暂无知识库，请先在“知识库”分页建立并解析资料。';
    } catch (error) { $('mechanism-base-options').textContent = `知识库加载失败：${error.message}`; }
  }
  function updateRule() {
    const metric = metrics[$('mechanism-metric').value];
    if (!metric) return;
    const threshold = metric.threshold;
    $('mechanism-rule').textContent = `${metric.label}：${threshold.kind === 'absolute' ? `绝对差 ≤ ${threshold.value} ${threshold.unit}` : `相对差 ≤ ${threshold.value}%`} 视为数值相符。该阈值仅用于 BSM1 基准场景对照，不代表测量不确定度。`;
  }
  async function loadMetrics() {
    try {
      const [data, simulationData] = await Promise.all([
        request('/api/mechanism-qa/metrics'), request('/api/simulation/profile')
      ]);
      metrics = data.metrics;
      const profile = simulationData.profile;
      for (const [key, id] of [['doSetpoint', 'mechanism-do'], ['recycleRatio', 'mechanism-recycle'], ['carbonDose', 'mechanism-carbon']]) {
        const range = profile.hardRanges[key];
        $(id).min = range.min; $(id).max = range.max; $(id).step = range.step;
      }
      $('mechanism-horizon').max = profile.evaluation.horizonDays;
      const select = $('mechanism-metric');
      select.replaceChildren();
      for (const [key, item] of Object.entries(metrics)) {
        const option = node('option', `${item.label} (${item.unit})`); option.value = key; select.append(option);
      }
      updateRule();
    } catch (error) { status.textContent = `指标规则加载失败：${error.message}`; }
  }
  function params() {
    return { influent: $('mechanism-influent').value, doSetpoint: Number($('mechanism-do').value),
      recycleRatio: Number($('mechanism-recycle').value), carbonDose: Number($('mechanism-carbon').value),
      horizonDays: Number($('mechanism-horizon').value), evalDays: Number($('mechanism-eval').value),
      loadFactor: Number($('mechanism-load').value), stabilize: $('mechanism-stabilize').value === 'true' };
  }
  function observed() {
    return { metric: $('mechanism-metric').value, value: Number($('mechanism-value').value), unit: $('mechanism-unit').value,
      windowDays: $('mechanism-window').value === '' ? null : Number($('mechanism-window').value),
      statistic: $('mechanism-statistic').value, dataContext: $('mechanism-context').value,
      definition: $('mechanism-definition').value, influent: $('mechanism-observed-influent').value,
      loadFactor: $('mechanism-observed-load').value === 'unknown' ? null : Number($('mechanism-observed-load').value),
      initialization: $('mechanism-observed-initialization').value };
  }
  const verdictNames = { match: '结果相符', mismatch: '存在偏差', insufficient: '条件不足', not_applicable: '模型不适用' };
  const statusNames = { queued: '任务已排队', running: '模型正在计算', answering: '模型已完成，正在复查资料并生成回答', ready: '校验问答完成', partial: '部分完成', failed: '校验失败' };
  function pair(list, label, value) {
    list.append(node('dt', label), node('dd', value == null ? '—' : String(value)));
  }
  function render(run) {
    status.textContent = `${statusNames[run.status] || run.status}${['queued', 'running'].includes(run.status) ? ` · ${Math.round(run.progress * 100)}%` : ''}${run.error ? `：${run.error}` : ''}`;
    results.replaceChildren();
    const card = node('section', undefined, `mechanism-card ${run.comparison?.verdict || ''}`);
    card.append(node('h3', '结构化校验'));
    if (run.comparison) card.append(node('strong', verdictNames[run.comparison.verdict] || run.comparison.verdict, 'mechanism-verdict'));
    const dl = node('dl', undefined, 'mechanism-evidence');
    pair(dl, '问题', run.question || $('mechanism-query').value.trim());
    pair(dl, '知识库', (run.knowledgeBaseIds || [...selectedBases]).map(id => baseNames.get(id) || id).join('、'));
    pair(dl, '校验记录', run.id);
    pair(dl, '检索记录', run.retrievalRunId);
    pair(dl, '仿真任务', run.simulationJobId);
    pair(dl, '工况', `${run.params.influent === 'dry' ? '干季' : '雨季'}入流 · 负荷 ${run.params.loadFactor}× · ${run.params.stabilize ? '先稳态初始化' : '不稳态初始化'} · DO ${run.params.doSetpoint} mg/L · 内回流 ${run.params.recycleRatio}×Q · 碳源 ${run.params.carbonDose} m³/d · 仿真 ${run.params.horizonDays} 天 · 评价 ${run.params.evalDays} 天`);
    pair(dl, '待核对', `${metrics[run.observed.metric]?.label || run.observed.metric} ${run.observed.value} ${run.observed.unit} · ${run.observed.windowDays ?? '未知'} 天 · ${run.observed.statistic}`);
    pair(dl, '数据场景', ({ benchmark: 'BSM1 标准场景', plant: '本厂监测数据', unknown: '未知' })[run.observed.dataContext]);
    pair(dl, '指标定义', ({ bsm1: '与 BSM1 一致', other: '定义不同', unknown: '未确认' })[run.observed.definition]);
    pair(dl, '数值对应入流', ({ dry: '干季标准入流', rain: '雨季标准入流', unknown: '未知' })[run.observed.influent]);
    pair(dl, '数值对应负荷', run.observed.loadFactor == null ? '未知' : `${run.observed.loadFactor}×`);
    pair(dl, '数值对应初始化', ({ stabilized: '已稳态初始化', unstabilized: '未稳态初始化', unknown: '未知' })[run.observed.initialization]);
    if (run.comparison) {
      pair(dl, '模型计算值', `${run.comparison.modelValue} ${run.comparison.unit}`);
      pair(dl, '绝对差', run.comparison.absoluteDifference == null ? '不可比较' : `${run.comparison.absoluteDifference} ${run.comparison.unit}`);
      pair(dl, '相对差', run.comparison.relativeDifferencePercent == null ? '不可比较' : `${run.comparison.relativeDifferencePercent}%`);
      pair(dl, '比较规则', `${run.comparison.threshold.kind === 'absolute' ? '绝对差' : '相对差'} ≤ ${run.comparison.threshold.value} ${run.comparison.threshold.unit}`);
      pair(dl, '模型溯源', `${run.comparison.modelProvenance?.profileId || '—'} · ${run.comparison.modelProvenance?.modelVersion || '—'} · 代码 ${run.comparison.modelProvenance?.codeVersion || '—'}`);
      pair(dl, '适用性', run.comparison.reasons.join(' ') + ' ' + run.comparison.applicability);
    }
    card.append(dl);
    if (run.rawMetrics) {
      const { eqi: _unverifiedEqi, ...visibleMetrics } = run.rawMetrics;
      const details = node('details'); details.append(node('summary', '查看模型原始指标（EQI 不参与首版比较）'), node('pre', JSON.stringify(visibleMetrics, null, 2))); card.append(details);
    }
    results.append(card);
    if (run.answer || run.answerError) {
      const answer = node('section', undefined, 'mechanism-card');
      answer.append(node('h3', '自然语言回答'));
      answer.append(node('p', run.answer || run.answerError, run.answer ? 'knowledge-answer' : 'mechanism-error'));
      results.append(answer);
    }
    const sources = node('section', undefined, 'mechanism-card');
    sources.append(node('h3', `文档出处 · ${run.sources?.length || 0}`));
    if (!run.sources?.length) sources.append(node('p', '当前未取得可引用的知识库段落。'));
    for (const source of run.sources || []) {
      const item = node('article', undefined, 'knowledge-source');
      const title = node('div', undefined, 'knowledge-source-title');
      title.append(node('strong', `[文档${source.number}] ${source.filename} · 版本 ${source.versionId} · 段落 ${source.chunkIndex + 1}`));
      const open = node('button', '查看分块', 'subtle-button'); open.type = 'button';
      open.addEventListener('click', () => window.openParsingDetails?.({ id: source.documentId, filename: source.filename }, null, { versionId: source.versionId, chunkIndex: source.chunkIndex }));
      title.append(open);
      item.append(title, node('p', `${source.locator} · 修订 ${source.revision}`), node('pre', source.excerpt));
      sources.append(item);
    }
    results.append(sources);
    if (run.answerError) results.append(node('p', run.answerError, 'mechanism-error'));
  }
  async function poll() {
    if (!activeRunId) return;
    try {
      const data = await request(`/api/mechanism-qa/${activeRunId}`);
      render(data.run);
      if (['ready', 'partial', 'failed'].includes(data.run.status)) {
        $('mechanism-submit').disabled = false;
        sessionStorage.removeItem('mechanismQaRunId');
        activeRunId = null;
        return;
      }
      pollTimer = setTimeout(poll, 2000);
    } catch (error) {
      status.textContent = `任务状态获取失败：${error.message}`;
      $('mechanism-submit').disabled = false;
      activeRunId = null;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedBases.size) { status.textContent = '请先选择至少一个知识库。'; return; }
    if (!Object.keys(metrics).length) { status.textContent = '指标规则尚未加载。'; return; }
    clearTimeout(pollTimer);
    $('mechanism-submit').disabled = true;
    status.textContent = '正在检索知识库并创建仿真任务…';
    results.replaceChildren();
    try {
      const data = await request('/api/mechanism-qa', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: $('mechanism-query').value.trim(), knowledgeBaseIds: [...selectedBases], params: params(), observed: observed() }) });
      activeRunId = data.run.id;
      sessionStorage.setItem('mechanismQaRunId', activeRunId);
      poll();
    } catch (error) {
      status.textContent = `提交失败：${error.message}`;
      $('mechanism-submit').disabled = false;
    }
  });
  $('mechanism-metric').addEventListener('change', updateRule);
  window.addEventListener('mechanism:open', loadBases);
  loadMetrics();
  if (location.hash === '#assistant') loadBases();
  const restored = sessionStorage.getItem('mechanismQaRunId');
  if (restored) { activeRunId = restored; $('mechanism-submit').disabled = true; poll(); }
})();
