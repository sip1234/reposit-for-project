// 仿真推演页：把滑块参数提交给 BSM1 机理模型，展示真实计算结果。
// 服务不可用时保持页面可用，并给出明确提示。
(() => {
  const endpoint = '/api/simulation';
  const optimizationEndpoint = '/api/optimization';
  const defaults = { horizonDays: 13.9, evalDays: 7, influent: 'dry', plantProfileId: 'bsm1-default' };
  let scenario = defaults.influent;
  const parameterIds = ['aeration', 'reflux', 'dosage'];
  const POLL_MS = 2000;

  let pollTimer = null;
  let runningJobId = null;
  let optimizationJobId = null;
  let optimizationTimer = null;
  let baseline = null;
  let candidate = null;
  let runCount = 0;

  const el = id => document.getElementById(id);

  function readParams() {
    return {
      doSetpoint: Number(el('aeration').value),
      recycleRatio: Number(el('reflux').value),
      carbonDose: Number(el('dosage').value),
      horizonDays: defaults.horizonDays,
      evalDays: defaults.evalDays,
      influent: scenario,
      loadFactor: Number(el('load-factor').value),
      plantProfileId: defaults.plantProfileId
    };
  }

  function isBaselineParams(params, weather = scenario, load = Number(el('load-factor').value)) {
    return Number(params.doSetpoint) === 2 && Number(params.recycleRatio) === 3 &&
      Number(params.carbonDose) === 0 && Number(params.evalDays) === defaults.evalDays &&
      (params.influent || 'dry') === weather && Number(params.loadFactor ?? 1) === load;
  }

  function setStatus(text) { el('simulation-status').textContent = text; }

  function setButton(label, disabled) {
    const button = el('run-simulation');
    button.disabled = disabled;
    button.innerHTML = label;
  }

  function setCancelVisible(visible) {
    const button = el('cancel-simulation');
    if (button) button.hidden = !visible;
  }

  function setText(id, text) { el(id).textContent = text; }

  function energyText(value) {
    return `${Number(value).toFixed(1)}<span> kWh/d</span>`;
  }

  function changeNode(id, current, base, lowerIsBetter) {
    const node = el(id);
    if (!base) {
      node.className = 'outcome-change neutral';
      node.innerHTML = '无基准工况 <span>相对基准</span>';
      return;
    }
    const diff = (current / base - 1) * 100;
    const better = lowerIsBetter ? diff <= 0 : diff >= 0;
    node.className = `outcome-change ${better ? 'good' : 'bad'}`;
    node.innerHTML = `${diff >= 0 ? '↗ +' : '↘ '}${diff.toFixed(1)}% <span>相对基准</span>`;
  }

  function seriesPath(values, yMin, yMax) {
    if (!values || values.length < 2) return '';
    const width = 840, height = 240, span = yMax - yMin || 1;
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - yMin) / span) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  function clearResult() {
    el('baseline-path').setAttribute('d', '');
    el('candidate-path').setAttribute('d', '');
    el('candidate-point').style.display = 'none';
    el('studio-chart-x').replaceChildren();
    el('outcome-efficiency').innerHTML = '—<span> kWh/d</span>';
    el('outcome-energy').innerHTML = '—<span> kWh/d</span>';
    el('outcome-compliance').textContent = '—';
    el('compliance-change').className = 'outcome-change neutral';
    el('compliance-change').innerHTML = '限值 4 g N/m³ <span>待复核</span>';
    el('studio-metric-grid').replaceChildren();
    setExportEnabled(false);
    setText('model-insight', '已切换场景，运行仿真刷新结果。');
  }

  function drawChart() {
    const current = candidate?.series?.soTank5 || [];
    const reference = baseline?.series?.soTank5 || [];
    const all = [...current, ...reference];
    if (!all.length) return;
    let yMin = Math.min(...all), yMax = Math.max(...all);
    const padding = (yMax - yMin || 1) * 0.15;
    yMin -= padding; yMax += padding;

    el('baseline-path').setAttribute('d', seriesPath(reference, yMin, yMax));
    el('candidate-path').setAttribute('d', seriesPath(current, yMin, yMax));

    const point = el('candidate-point');
    if (current.length) {
      const y = 240 - ((current[current.length - 1] - yMin) / (yMax - yMin)) * 240;
      point.setAttribute('cx', '840');
      point.setAttribute('cy', y.toFixed(1));
      point.style.display = '';
    } else {
      point.style.display = 'none';
    }

    const axis = el('studio-chart-x');
    const times = candidate?.series?.time || baseline?.series?.time || [];
    axis.replaceChildren();
    if (times.length > 1) {
      // 每个整天一个标签，避免按索引取样时跳号（例如漏掉第 11 天）
      const firstDay = Math.floor(Number(times[0])) + 1;
      const lastDay = Math.floor(Number(times[times.length - 1])) + 1;
      for (let day = firstDay; day <= lastDay; day++) {
        const span = document.createElement('span');
        span.textContent = `第 ${day} 天`;
        axis.append(span);
      }
    }
  }

  function renderMetrics() {
    const metrics = candidate?.metrics;
    if (!metrics) return;
    const base = baseline?.metrics || null;

    el('outcome-efficiency').innerHTML = energyText(metrics.aerationEnergy);
    el('outcome-energy').innerHTML =
      energyText(Number(metrics.pumpingEnergy) + Number(metrics.mixingEnergy));

    changeNode('efficiency-change', metrics.aerationEnergy, base?.aerationEnergy, true);
    changeNode('energy-change',
      Number(metrics.pumpingEnergy) + Number(metrics.mixingEnergy),
      base ? Number(base.pumpingEnergy) + Number(base.mixingEnergy) : null, true);

    const snh = Number(metrics.effluentSnhMean);
    const compliance = el('outcome-compliance');
    compliance.textContent = `${snh.toFixed(2)} g N/m³`;
    compliance.style.color = snh < 4 ? '#53dfbe' : '#f0b774';
    const note = el('compliance-change');
    note.className = `outcome-change ${snh < 4 ? 'good' : 'bad'}`;
    note.innerHTML = snh < 4 ? '低于限值 4 <span>待复核</span>' : '超过限值 4 <span>需核查</span>';

    setText('model-insight',
      `BSM1 干季工况 · 评价最后 ${metrics.evalDays} 天：第 5 格溶解氧均值 ` +
      `${metrics.doTank5Mean} mg/L（设定 ${metrics.doSetpoint}，波动 ${metrics.doTank5Min}–${metrics.doTank5Max}）；` +
      `曝气能耗 ${Number(metrics.aerationEnergy).toFixed(1)} kWh/d；` +
      `出水氨氮均值 ${snh.toFixed(2)} g N/m³；EQI ${Number(metrics.eqi).toFixed(0)}` +
      `（${metrics.stabilized ? '已稳态初始化' : '未稳态'}；闭环参考 6123 / 开环参考 6700）；` +
      `OCI ${Number(metrics.oci || 0).toFixed(0)}（SP 估算）；Ntot ${Number(metrics.effluentNtotMean || 0).toFixed(2)}、TSS ${Number(metrics.effluentTssMean || 0).toFixed(2)} g/m³；` +
      `SNH/Ntot 超标 ${Number(metrics.violations?.snh?.percent || 0).toFixed(1)}%/${Number(metrics.violations?.ntot?.percent || 0).toFixed(1)}%；` +
      `单位水量能耗 ${Number(metrics.energyPerM3 || 0).toFixed(3)} kWh/m³。` +
      `以上为 IWA BSM1 基准模型的模拟结果，不代表本厂实际工况。`);

    setText('current-plan-label', `候选方案 ${String.fromCharCode(65 + (runCount % 26))} · 第 ${runCount} 次仿真`);
    renderMetricCards(metrics);
    setExportEnabled(true);
  }

  function setExportEnabled(enabled) {
    el('export-csv').disabled = !enabled;
    el('export-json').disabled = !enabled;
    el('export-status').textContent = enabled ? '导出当前结果（指标 + 曲线）' : '运行仿真后可导出';
  }

  function metricValue(value, digits = 2) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  }

  function renderMetricCards(metrics) {
    const grid = el('studio-metric-grid');
    grid.replaceChildren();
    const snh = metrics.violations?.snh || {};
    const ntot = metrics.violations?.ntot || {};
    const cards = [
      ['EQI', metricValue(metrics.eqi, 0), '', '闭环参考 6123 / 开环 6700', false],
      ['OCI', metricValue(metrics.oci, 0), '', 'SP 估算，不含库存变化', false],
      ['出水 Ntot', metricValue(metrics.effluentNtotMean), 'g N/m³', '限值 18', Number(metrics.effluentNtotMean) > 18],
      ['出水 TSS', metricValue(metrics.effluentTssMean), 'g/m³', '限值 30', Number(metrics.effluentTssMean) > 30],
      ['SNH 超标', metricValue(snh.percent, 2), '%', `${metricValue(snh.days, 2)} d · ${snh.count ?? 0} 次`, Number(snh.percent) > 0],
      ['Ntot 超标', metricValue(ntot.percent, 2), '%', `${metricValue(ntot.days, 2)} d · ${ntot.count ?? 0} 次`, Number(ntot.percent) > 0],
      ['单位水量能耗', metricValue(metrics.energyPerM3, 3), 'kWh/m³', `处理 ${metricValue(metrics.treatedVolume, 0)} m³`, false],
      ['处理水量', metricValue(metrics.treatedVolume, 0), 'm³', `${metricValue(metrics.evalDays, 0)} 天评价窗口`, false],
    ];
    for (const [label, value, unit, note, warn] of cards) {
      const card = document.createElement('article');
      card.className = `studio-metric-card${warn ? ' warn' : ''}`;
      const small = document.createElement('small');
      small.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = value;
      if (unit) {
        const span = document.createElement('span');
        span.textContent = ` ${unit}`;
        strong.append(span);
      }
      const p = document.createElement('p');
      p.textContent = note;
      card.append(small, strong, p);
      grid.append(card);
    }
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function csvCell(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function exportCsv() {
    if (!candidate) return;
    const metrics = candidate.metrics;
    const rows = [['指标', '值', '单位']];
    const defs = [
      ['profileId', 'profileId', ''], ['weather', '天气', ''], ['stabilized', '稳态初始化', ''],
      ['iqi', 'IQI', ''], ['eqi', 'EQI', ''], ['oci', 'OCI', ''],
      ['aerationEnergy', '曝气能耗', 'kWh/d'], ['pumpingEnergy', '泵送能耗', 'kWh/d'],
      ['mixingEnergy', '搅拌能耗', 'kWh/d'], ['energyTotal', '总能耗', 'kWh/d'],
      ['energyPerM3', '单位水量能耗', 'kWh/m³'], ['treatedVolume', '处理水量', 'm³'],
      ['effluentSnhMean', '出水 NH4 均值', 'g N/m³'], ['effluentNtotMean', '出水 Ntot 均值', 'g N/m³'],
      ['effluentTssMean', '出水 TSS 均值', 'g/m³'], ['effluentCodMean', '出水 COD 均值', 'g/m³'],
      ['effluentBod5Mean', '出水 BOD5 均值', 'g/m³'], ['snhP95', 'SNH 95% 分位', 'g N/m³'],
      ['ntotP95', 'Ntot 95% 分位', 'g N/m³'], ['tssP95', 'TSS 95% 分位', 'g/m³'],
      ['doTank5Mean', 'DO5 均值', 'mg/L'], ['doTank5Min', 'DO5 最小', 'mg/L'], ['doTank5Max', 'DO5 最大', 'mg/L'],
      ['sludgeProduction', 'SP（估算）', 'kg/d'], ['modelVersion', '模型版本', ''], ['influentFile', '入流文件', ''],
    ];
    for (const [key, label, unit] of defs) rows.push([label, metrics[key] ?? '', unit]);
    for (const key of ['snh', 'ntot', 'tss', 'cod', 'bod5']) {
      const item = metrics.violations?.[key] || {};
      rows.push([`${key} 超标天数`, item.days ?? '', 'd']);
      rows.push([`${key} 超标占比`, item.percent ?? '', '%']);
      rows.push([`${key} 超标次数`, item.count ?? '', '次']);
    }
    rows.push([]);
    const series = candidate.series || {};
    rows.push(['时间 (d)', 'DO5 (mg/L)', ...(series.effluentColumns || [])]);
    for (let i = 0; i < (series.time || []).length; i++) {
      rows.push([series.time[i], series.soTank5?.[i] ?? '', ...(series.effluent?.[i] || [])]);
    }
    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\n');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadFile(`bsm1-${metrics.weather || 'sim'}-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
  }

  function exportJson() {
    if (!candidate) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadFile(`bsm1-${candidate.metrics?.weather || 'sim'}-${stamp}.json`,
      JSON.stringify(candidate, null, 2), 'application/json;charset=utf-8');
  }

  function setOptimizationStatus(text) {
    el('optimization-status').textContent = text;
  }

  function setOptimizationBusy(busy) {
    el('run-optimization').disabled = busy;
    el('optimization-evaluations').disabled = busy;
    el('cancel-optimization').hidden = !busy;
  }

  function optimizationTable(result) {
    const target = el('optimization-result');
    target.replaceChildren();
    const summary = document.createElement('p');
    summary.textContent = `${result.evaluations} 次评估 · 可行 ${result.feasibleCount} 个 · Pareto ${result.pareto.length} 个 · ${result.elapsedSeconds} 秒`;
    target.append(summary);
    if (!result.pareto.length) {
      const empty = document.createElement('p');
      empty.textContent = '没有可行 Pareto 方案，请增加评估次数或放宽约束。';
      target.append(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'studio-optimization-table';
    const head = document.createElement('tr');
    for (const label of ['OCI', 'EQI', 'DO mg/L', '回流 ×Q', '碳源 m³/d', '可行']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);
    table.append(thead);
    const body = document.createElement('tbody');
    const bestOci = result.bestOci?.x;
    for (const point of result.pareto) {
      const row = document.createElement('tr');
      if (bestOci && point.x.doSetpoint === bestOci.doSetpoint
        && point.x.recycleRatio === bestOci.recycleRatio
        && point.x.carbonDose === bestOci.carbonDose) row.className = 'best';
      for (const value of [
        point.metrics.oci.toFixed(1),
        point.metrics.eqi.toFixed(1),
        point.x.doSetpoint.toFixed(2),
        point.x.recycleRatio.toFixed(2),
        point.x.carbonDose.toFixed(2),
        point.feasible ? '是' : '否',
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        row.append(td);
      }
      body.append(row);
    }
    table.append(body);
    target.append(table);
  }

  async function pollOptimization() {
    if (!optimizationJobId) return;
    try {
      const data = await requestJson(`${optimizationEndpoint}/${optimizationJobId}`);
      const job = data.job;
      if (job.status === 'ready') {
        clearTimeout(optimizationTimer);
        optimizationJobId = null;
        setOptimizationBusy(false);
        setOptimizationStatus(`优化完成 · ${job.params.evaluations} 次评估`);
        if (data.result) optimizationTable(data.result);
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        clearTimeout(optimizationTimer);
        optimizationJobId = null;
        setOptimizationBusy(false);
        setOptimizationStatus(job.status === 'cancelled' ? '优化已取消。' : `优化失败：${job.error || '未知错误'}`);
        return;
      }
      setOptimizationStatus(`优化进行中… ${Math.round(Number(job.progress) * 100)}% · ${job.cancelRequested ? '正在取消…' : '后台队列'}`);
      optimizationTimer = setTimeout(pollOptimization, 3000);
    } catch (error) {
      clearTimeout(optimizationTimer);
      optimizationJobId = null;
      setOptimizationBusy(false);
      setOptimizationStatus(`优化状态读取失败：${error.message}`);
    }
  }

  async function startOptimization() {
    if (optimizationJobId) return;
    clearTimeout(optimizationTimer);
    const evaluations = Number(el('optimization-evaluations').value);
    setOptimizationBusy(true);
    setOptimizationStatus('正在提交优化任务…');
    try {
      const data = await requestJson(optimizationEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluations,
          initial: Math.min(4, evaluations),
          weather: scenario,
          loadFactor: Number(el('load-factor').value),
          stabilize: true,
        })
      });
      optimizationJobId = data.job.id;
      setOptimizationStatus('任务已排队，等待优化开始…');
      pollOptimization();
    } catch (error) {
      setOptimizationBusy(false);
      setOptimizationStatus(`提交失败：${error.message}`);
    }
  }

  async function cancelOptimization() {
    if (!optimizationJobId) return;
    try {
      await requestJson(`${optimizationEndpoint}/${optimizationJobId}/cancel`, { method: 'POST' });
      setOptimizationStatus('已请求取消，等待优化停止…');
    } catch (error) {
      setOptimizationStatus(`取消失败：${error.message}`);
    }
  }

  async function loadLatestOptimization() {
    try {
      const data = await requestJson(optimizationEndpoint);
      const latest = (data.jobs || [])[0];
      if (!latest) return;
      if (latest.status === 'ready') {
        const detail = await requestJson(`${optimizationEndpoint}/${latest.id}`);
        if (detail.result) optimizationTable(detail.result);
        setOptimizationStatus(`最近任务已完成 · ${latest.params.evaluations} 次评估`);
      } else if (latest.status === 'queued' || latest.status === 'running') {
        optimizationJobId = latest.id;
        setOptimizationBusy(true);
        pollOptimization();
      } else {
        setOptimizationStatus(`最近任务：${latest.status === 'cancelled' ? '已取消' : '失败'}`);
      }
    } catch { /* 服务不可用时保持页面可用 */ }
  }

  function renderHistory(jobs) {
    const timeline = el('history-timeline');
    const current = timeline.querySelector('.current');
    timeline.replaceChildren();
    if (current) timeline.append(current);
    for (const job of jobs.slice(0, 4)) {
      const entry = document.createElement('div');
      entry.className = 'history-entry';
      const dot = document.createElement('span');
      dot.className = 'history-dot';
      const meta = document.createElement('small');
      meta.textContent = `${new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${
        job.status === 'ready' ? '已完成' : job.status === 'failed' ? '已失败' : job.status === 'cancelled' ? '已取消' : '进行中'}`;
      const title = document.createElement('strong');
      title.textContent = `溶解氧 ${job.params.doSetpoint} mg/L · 内回流 ${job.params.recycleRatio}×Q`;
      const detail = document.createElement('p');
      detail.textContent = `${job.params.influent === 'rain' ? '雨季' : '干季'} · 负荷 ${job.params.loadFactor ?? 1}× · 外加碳源 ${job.params.carbonDose} m³/d · 评价 ${job.params.evalDays} 天`;
      entry.append(dot, meta, title, detail);
      timeline.append(entry);
    }
  }

  function fail(error) {
    clearTimeout(pollTimer);
    pollTimer = null;
    runningJobId = null;
    setButton('▶ 运行仿真 <span>约 40 秒</span>', false);
    setCancelVisible(false);
    setStatus(`仿真服务不可用：${error.message}。请确认 docker compose 的 simulator 服务已启动。`);
  }

  async function requestJson(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    let data = null;
    try { data = await response.json(); } catch { /* 保持 data 为 null */ }
    if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`);
    return data;
  }

  async function poll() {
    if (!runningJobId) return;
    try {
      const { job, result } = await requestJson(`${endpoint}/${runningJobId}`);
      if (job.status === 'failed') throw new Error(job.error || '模型计算失败');
      if (job.status === 'cancelled') {
        clearTimeout(pollTimer);
        pollTimer = null;
        runningJobId = null;
        setButton('▶ 运行仿真 <span>约 40 秒</span>', false);
        setCancelVisible(false);
        setStatus('仿真已取消。');
        loadHistory();
        return;
      }
      if (job.status === 'ready' && result) {
        candidate = result;
        runCount += 1;
        if (!baseline && isBaselineParams(job.params, job.params.influent || scenario, Number(job.params.loadFactor ?? 1))) baseline = result;
        clearTimeout(pollTimer);
        pollTimer = null;
        runningJobId = null;
        setButton('▶ 重新运行仿真 <span>约 40 秒</span>', false);
        setCancelVisible(false);
        setStatus(`仿真完成 · ${result.metrics.profileId} · 负荷 ${result.metrics.loadFactor ?? 1}× · 模型 ${result.metrics.modelVersion} · ${result.metrics.stabilized ? '已稳态初始化' : '未稳态'} · 共 ${result.metrics.steps} 步 · 评价最后 ${result.metrics.evalDays} 天。`);
        renderMetrics();
        drawChart();
        loadHistory();
        return;
      }
      setStatus(`模型正在计算… ${Math.round(Number(job.progress) * 100)}% · ${job.cancelRequested ? '正在取消…' : '约需 40 秒'}`);
      pollTimer = setTimeout(poll, POLL_MS);
    } catch (error) {
      fail(error);
    }
  }

  async function runSimulation() {
    if (runningJobId) return;
    clearTimeout(pollTimer);
    setButton('◌ 正在运行模型 <span>请稍候</span>', true);
    setExportEnabled(false);
    setStatus('正在提交仿真任务…');
    try {
      const data = await requestJson(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readParams())
      });
      runningJobId = data.job.id;
      setCancelVisible(true);
      setStatus('任务已排队，等待模型开始计算…');
      poll();
    } catch (error) {
      fail(error);
    }
  }

  async function cancelSimulation() {
    if (!runningJobId) return;
    try {
      await requestJson(`${endpoint}/${runningJobId}/cancel`, { method: 'POST' });
      setStatus('已请求取消，等待模型停止…');
    } catch (error) {
      setStatus(`取消失败：${error.message}`);
    }
  }

  async function loadHistory() {
    try {
      const data = await requestJson(endpoint);
      renderHistory(data.jobs || []);
    } catch { /* 服务不可用时保持页面可用 */ }
  }

  async function initialize() {
    try {
      const data = await requestJson(endpoint);
      renderHistory(data.jobs || []);
      const base = (data.jobs || []).find(job => job.status === 'ready' && isBaselineParams(job.params, scenario, Number(el('load-factor').value)));
      if (base) {
        const detail = await requestJson(`${endpoint}/${base.id}`);
        if (detail.result) { baseline = detail.result; drawChart(); }
      }
    } catch (error) {
      setStatus(`仿真服务不可用：${error.message}。请确认 docker compose 的 simulator 服务已启动。`);
    }
    loadLatestOptimization();
  }

  for (const id of parameterIds) {
    const input = el(id);
    if (!input) continue;
    input.addEventListener('input', () => {
      el(`${id}-value`).value = id === 'aeration' || id === 'reflux'
        ? Number(input.value).toFixed(1)
        : Number(input.value).toFixed(1);
      el('current-plan-label').textContent = '候选方案 · 待仿真';
      setStatus('参数已更改，运行仿真可刷新结果。');
    });
  }

  el('scenario-button').addEventListener('click', () => {
    scenario = scenario === 'dry' ? 'rain' : 'dry';
    el('scenario-button').innerHTML = `BSM1 · ${scenario === 'dry' ? '干季' : '雨季'}工况 <span>⌄</span>`;
    baseline = null;
    candidate = null;
    clearResult();
    setStatus(`已切换到 BSM1 ${scenario === 'dry' ? '干季' : '雨季'}入流，运行仿真刷新结果。`);
    initialize();
  });
  el('load-factor').addEventListener('change', () => {
    baseline = null;
    candidate = null;
    clearResult();
    setStatus(`已切换到负荷 ${el('load-factor').value}×，运行仿真刷新结果。`);
    initialize();
  });
  el('run-simulation').addEventListener('click', runSimulation);
  el('cancel-simulation').addEventListener('click', cancelSimulation);
  el('run-optimization').addEventListener('click', startOptimization);
  el('cancel-optimization').addEventListener('click', cancelOptimization);
  el('export-csv').addEventListener('click', exportCsv);
  el('export-json').addEventListener('click', exportJson);
  window.addEventListener('studio:open', initialize);
  if (location.hash === '#studio') initialize();
})();
