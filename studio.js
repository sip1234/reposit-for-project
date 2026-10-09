// 仿真推演页：把滑块参数提交给 BSM1 机理模型，展示真实计算结果。
// 服务不可用时保持页面可用，并给出明确提示。
(() => {
  const endpoint = '/api/simulation';
  const defaults = { horizonDays: 13.9, evalDays: 7, influent: 'dry' };
  const parameterIds = ['aeration', 'reflux', 'dosage'];
  const POLL_MS = 2000;

  let pollTimer = null;
  let runningJobId = null;
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
      influent: defaults.influent
    };
  }

  function isBaselineParams(params) {
    return Number(params.doSetpoint) === 2 && Number(params.recycleRatio) === 3 &&
      Number(params.carbonDose) === 0 && Number(params.evalDays) === defaults.evalDays;
  }

  function setStatus(text) { el('simulation-status').textContent = text; }

  function setButton(label, disabled) {
    const button = el('run-simulation');
    button.disabled = disabled;
    button.innerHTML = label;
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
      `出水氨氮均值 ${snh.toFixed(2)} g N/m³。` +
      `以上为 IWA BSM1 基准模型的模拟结果，不代表本厂实际工况。`);

    setText('current-plan-label', `候选方案 ${String.fromCharCode(65 + (runCount % 26))} · 第 ${runCount} 次仿真`);
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
        job.status === 'ready' ? '已完成' : job.status === 'failed' ? '已失败' : '进行中'}`;
      const title = document.createElement('strong');
      title.textContent = `溶解氧 ${job.params.doSetpoint} mg/L · 内回流 ${job.params.recycleRatio}×Q`;
      const detail = document.createElement('p');
      detail.textContent = `外加碳源 ${job.params.carbonDose} m³/d · 评价 ${job.params.evalDays} 天`;
      entry.append(dot, meta, title, detail);
      timeline.append(entry);
    }
  }

  function fail(error) {
    clearTimeout(pollTimer);
    pollTimer = null;
    runningJobId = null;
    setButton('▶ 运行仿真 <span>约 30 秒</span>', false);
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
      if (job.status === 'ready' && result) {
        candidate = result;
        runCount += 1;
        if (!baseline && isBaselineParams(job.params)) baseline = result;
        clearTimeout(pollTimer);
        pollTimer = null;
        runningJobId = null;
        setButton('▶ 重新运行仿真 <span>约 30 秒</span>', false);
        setStatus(`仿真完成 · 共 ${result.metrics.steps} 步 · 评价最后 ${result.metrics.evalDays} 天。`);
        renderMetrics();
        drawChart();
        loadHistory();
        return;
      }
      setStatus(`模型正在计算… ${Math.round(Number(job.progress) * 100)}% · 约需 30 秒`);
      pollTimer = setTimeout(poll, POLL_MS);
    } catch (error) {
      fail(error);
    }
  }

  async function runSimulation() {
    if (runningJobId) return;
    clearTimeout(pollTimer);
    setButton('◌ 正在运行模型 <span>请稍候</span>', true);
    setStatus('正在提交仿真任务…');
    try {
      const data = await requestJson(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readParams())
      });
      runningJobId = data.job.id;
      setStatus('任务已排队，等待模型开始计算…');
      poll();
    } catch (error) {
      fail(error);
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
      const base = (data.jobs || []).find(job => job.status === 'ready' && isBaselineParams(job.params));
      if (base) {
        const detail = await requestJson(`${endpoint}/${base.id}`);
        if (detail.result) { baseline = detail.result; drawChart(); }
      }
    } catch (error) {
      setStatus(`仿真服务不可用：${error.message}。请确认 docker compose 的 simulator 服务已启动。`);
    }
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

  el('scenario-button').addEventListener('click',
    () => setStatus('当前仅支持 BSM1 干季入流工况（dryinfluent）。'));
  el('run-simulation').addEventListener('click', runSimulation);
  window.addEventListener('studio:open', initialize);
  if (location.hash === '#studio') initialize();
})();
