const pages = ['command', 'studio'];
const equipment = {
  '原水池': { description: '原水池液位保持稳定，当前示例测点为液位 78.2%。', status: '运行正常' },
  '提升泵': { description: '提升泵当前示例流量为 42.8 m³/h；2 号泵有待巡检提醒。', status: '运行中 · 待巡检' },
  '生化反应池': { description: '生化反应池溶解氧示例值为 2.3 mg/L，处于当前演示目标区间。', status: '运行正常' },
  '沉淀池': { description: '沉淀池浊度示例值为 4.8 NTU，接近演示关注阈值，建议结合进水负荷和加药记录检查。', status: '需要关注' },
  '出水口': { description: '出水口示例流量为 41.6 m³/h，当前演示结果显示达标。', status: '运行正常' }
};

function selectPage(pageName) {
  if (!pages.includes(pageName)) return;
  for (const name of pages) {
    const page = document.getElementById(name);
    const active = name === pageName;
    page.hidden = !active;
    page.classList.toggle('active', active);
  }
  document.body.dataset.page = pageName;
  history.replaceState(null, '', `#${pageName}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

selectPage(pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'command');

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2700);
}
const demoActionLabels = {
  '已生成演示版运行报告': '运行报告入口为界面演示',
  '已生成演示版运行摘要': '运行摘要入口为界面演示',
  '演示方案已暂存': '保存方案入口为界面演示'
};
document.querySelectorAll('[data-toast]').forEach(button => button.addEventListener('click', () => showToast(demoActionLabels[button.dataset.toast] || button.dataset.toast)));
document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => {
  const label = button.dataset.nav;
  if (label === '仿真推演') selectPage('studio');
  else if (label === '工艺总览') selectPage('command');
  else showToast(`${label}模块在当前原型中展示为导航入口`);
}));

const modal = document.getElementById('equipment-modal');
function closeModal() { modal.hidden = true; }
document.querySelectorAll('[data-equipment]').forEach(button => button.addEventListener('click', () => {
  const name = button.dataset.equipment;
  const item = equipment[name];
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-description').textContent = item.description;
  document.getElementById('modal-status').textContent = item.status;
  modal.hidden = false;
  document.getElementById('modal-close').focus();
}));
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-done').addEventListener('click', closeModal);
modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
  const container = button.parentElement;
  container.querySelectorAll('button').forEach(sibling => sibling.classList.remove('active', 'selected'));
  button.classList.add(container.classList.contains('segmented') ? 'selected' : 'active');
  showToast(`已切换到${button.dataset.period}视图（示意曲线）`);
}));

const aiReplies = [
  { match: /浊度|异常|告警/, answer: '建议先查询近 24 小时浊度与进水负荷曲线，再核对加药记录和测点质量标记。若持续升高，可在仿真环境评估参数调整。' },
  { match: /参数|调整|影响|仿真/, answer: '参数调整可能同时影响处理效果与能耗。先限定允许范围，再调用机理模型比较候选方案，并核对约束与测点数据。' },
  { match: /能耗|效率|优化/, answer: '可以读取最新数据与基准表现，生成约束内的候选参数，逐一仿真比较，再记录推荐方案与复核结果。' }
];
function answerAI(question) {
  if (!question.trim()) return;
  const found = aiReplies.find(item => item.match.test(question));
  document.getElementById('command-ai-reply').textContent = found?.answer || '这个问题可以结合运行数据、规程知识库与机理模型共同分析。当前原型仅展示交互形式，尚未接入真实检索或模型。';
  document.getElementById('command-ai-input').value = '';
}
document.querySelectorAll('[data-ai]').forEach(button => button.addEventListener('click', () => answerAI(button.dataset.ai)));
document.getElementById('command-ai-send').addEventListener('click', () => answerAI(document.getElementById('command-ai-input').value));
document.getElementById('command-ai-input').addEventListener('keydown', event => { if (event.key === 'Enter') answerAI(event.target.value); });

const parameterIds = ['aeration', 'reflux', 'dosage'];
parameterIds.forEach(id => {
  const input = document.getElementById(id);
  input.addEventListener('input', () => {
    document.getElementById(`${id}-value`).value = input.value;
    document.getElementById('simulation-status').textContent = '参数已更改，运行仿真可刷新结果。';
    document.getElementById('current-plan-label').textContent = '候选方案 A · 待仿真';
  });
});
document.getElementById('scenario-button').addEventListener('click', () => showToast('当前原型展示一个工艺场景'));

let simulationCount = 0;
document.getElementById('run-simulation').addEventListener('click', () => {
  const button = document.getElementById('run-simulation');
  button.disabled = true;
  button.innerHTML = '◌ 正在运行模型 <span>演示中</span>';
  document.getElementById('simulation-status').textContent = '正在比较基准工况与当前候选方案…';
  setTimeout(() => {
    const a = Number(document.getElementById('aeration').value);
    const r = Number(document.getElementById('reflux').value);
    const d = Number(document.getElementById('dosage').value);
    const efficiency = Math.max(88.5, Math.min(96.8, 94.1 + (a - 62) * .08 + (r - 48) * .045 + (d - 26) * .035));
    const energy = Math.max(1.56, Math.min(2.12, 1.7436 + (a - 62) * .008 - (r - 48) * .002 - (d - 26) * .001));
    const efficiencyDiff = efficiency - 92.6;
    const energyDiff = (energy / 1.82 - 1) * 100;
    const compliant = efficiency >= 91 && d >= 18;
    document.getElementById('outcome-efficiency').innerHTML = `${efficiency.toFixed(1)}<span>%</span>`;
    document.getElementById('outcome-energy').innerHTML = `${energy.toFixed(2)}<span> kWh/m³</span>`;
    document.getElementById('efficiency-change').innerHTML = `${efficiencyDiff >= 0 ? '↗ +' : '↘ '}${efficiencyDiff.toFixed(1)}% <span>相对基准</span>`;
    document.getElementById('energy-change').innerHTML = `${energyDiff >= 0 ? '↗ +' : '↘ '}${energyDiff.toFixed(1)}% <span>相对基准</span>`;
    document.getElementById('efficiency-change').classList.toggle('good', efficiencyDiff >= 0);
    document.getElementById('energy-change').classList.toggle('good', energyDiff <= 0);
    document.getElementById('outcome-compliance').textContent = compliant ? '预计达标' : '需进一步核查';
    document.getElementById('outcome-compliance').style.color = compliant ? '#53dfbe' : '#f0b774';
    document.getElementById('model-insight').textContent = compliant && efficiencyDiff > 0 && energyDiff < 0 ? '当前方案在演示模型中改善了效率与能耗。建议核对测点质量，并与基准工况复核。' : '当前方案未同时改善所有指标。建议回看参数约束与目标权重，继续比较候选方案。';
    document.getElementById('simulation-status').textContent = '仿真已完成 · 以下结果仅用于界面演示。';
    document.getElementById('current-plan-label').textContent = `候选方案 A · 第 ${++simulationCount} 次仿真`;
    button.disabled = false;
    button.innerHTML = '▶ 重新运行仿真 <span>约 2 秒</span>';
    showToast('演示仿真已完成');
  }, 900);
});
