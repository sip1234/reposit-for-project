const pages = ['command', 'studio', 'documents', 'assistant'];
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
  if (pageName === 'documents') window.dispatchEvent(new Event('documents:open'));
  if (pageName === 'assistant') window.dispatchEvent(new Event('assistant:open'));
  if (pageName === 'studio') window.dispatchEvent(new Event('studio:open'));
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
  else if (label === '知识文档') selectPage('documents');
  else if (label === 'AI 助手') selectPage('assistant');
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

function openAssistant(question) {
  selectPage('assistant');
  if (question.trim()) document.getElementById('knowledge-query').value = question.trim();
  document.getElementById('knowledge-query').focus();
}
document.querySelectorAll('[data-ai]').forEach(button => button.addEventListener('click', () => openAssistant(button.dataset.ai)));
document.getElementById('command-ai-send').addEventListener('click', () => openAssistant(document.getElementById('command-ai-input').value));
document.getElementById('command-ai-input').addEventListener('keydown', event => { if (event.key === 'Enter') openAssistant(event.target.value); });

// 仿真推演页的参数处理与结果渲染已移至 studio.js（真实调用 BSM1 机理模型）。
// 此处保留通用的页面切换、导航、提示与设备详情弹窗逻辑。

