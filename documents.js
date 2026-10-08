(() => {
  const maxSize = 10 * 1024 ** 3;
  const allowed = new Set(['doc', 'docx', 'txt', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt', 'ods', 'odp']);
  const listBody = document.getElementById('document-rows');
  const fileInput = document.getElementById('document-files');
  const queue = document.getElementById('upload-queue');
  const dropzone = document.getElementById('document-dropzone');
  const serviceStatus = document.getElementById('documents-service-status');
  const serviceMessage = document.getElementById('documents-service-message');
  const previewModal = document.getElementById('document-preview');
  const previewBody = document.getElementById('document-preview-body');
  const knowledgeForm = document.getElementById('knowledge-form');
  const knowledgeResults = document.getElementById('knowledge-results');
  let records = [];
  let loaded = false;
  let nextCursor = null;
  let searchTimer;
  let previewToken = 0;
  let previewOpener;

  function bytes(size) {
    if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GiB`;
    if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${size} B`;
  }

  function setService(ok, message) {
    serviceStatus.textContent = ok ? '服务已连接' : '服务未连接';
    serviceMessage.hidden = ok;
    serviceMessage.textContent = ok ? '' : message;
  }

  async function refresh(more = false) {
    try {
      const params = new URLSearchParams();
      const query = document.getElementById('document-search').value.trim();
      if (query) params.set('q', query);
      if (more && nextCursor) params.set('cursor', nextCursor);
      const response = await fetch(`/api/documents?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      records = more ? records.concat(data.documents || []) : data.documents || [];
      nextCursor = data.nextCursor || null;
      loaded = true;
      setService(true, '');
      render();
    } catch {
      loaded = true;
      setService(false, '请运行 scripts/start.ps1 并通过 http://localhost:3000 打开本地服务，才能上传和查看文档。');
      render();
    }
  }

  function render() {
    const visible = records;
    document.getElementById('document-count').textContent = `${records.length}${nextCursor ? '+' : ''}`;
    document.getElementById('documents-summary').textContent = `已加载 ${records.length} 个文件 · 原件保留在本机`;
    document.getElementById('load-more-documents').hidden = !nextCursor;
    listBody.replaceChildren();
    if (!visible.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'document-empty';
      cell.textContent = !loaded ? '正在加载文件…' : document.getElementById('document-search').value.trim() ? '没有匹配的文件' : '暂无文档。点击“上传文档”添加第一份资料。';
      row.append(cell);
      listBody.append(row);
      return;
    }
    for (const item of visible) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const icon = document.createElement('span');
      icon.className = 'document-file-icon';
      icon.textContent = (item.filename.split('.').pop() || 'DOC').slice(0, 4).toUpperCase();
      const label = document.createElement('span');
      label.className = 'document-filename';
      label.textContent = item.filename;
      name.append(icon, label);
      const size = document.createElement('td'); size.textContent = bytes(item.sizeBytes);
      const date = document.createElement('td'); date.textContent = new Date(item.createdAt).toLocaleString('zh-CN');
      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `document-status ${item.status}`;
      badge.textContent = { uploading: '上传中', finalizing: '校验保存中', ready: '已保存', failed: '保存失败' }[item.status] || item.status;
      if (item.error) badge.title = item.error;
      status.append(badge);
      const index = document.createElement('td');
      const indexBadge = document.createElement('span');
      indexBadge.className = `document-status ${item.indexStatus || ''}`;
      indexBadge.textContent = { pending: '等待索引', processing: '解析中', ready: `${item.indexChunks} 段已索引`, failed: '索引失败', unsupported: '暂不支持' }[item.indexStatus] || '—';
      if (item.indexError) indexBadge.title = item.indexError;
      index.append(indexBadge);
      const action = document.createElement('td');
      if (item.status === 'ready') {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'document-preview-button';
        preview.textContent = '预览';
        preview.addEventListener('click', () => openPreview(item, preview));
        const link = document.createElement('a');
        link.href = `/api/documents/${encodeURIComponent(item.id)}/download`;
        link.textContent = '下载原件 ↗';
        link.className = 'document-download';
        action.append(preview, link);
      } else action.textContent = '—';
      row.append(name, size, date, status, index, action);
      listBody.append(row);
    }
  }

  function closePreview() {
    previewToken++;
    previewModal.hidden = true;
    previewBody.replaceChildren();
    previewOpener?.focus();
  }

  async function openPreview(item, opener) {
    const token = ++previewToken;
    previewOpener = opener;
    previewModal.hidden = false;
    document.getElementById('document-preview-name').textContent = item.filename;
    document.getElementById('document-preview-download').href = `/api/documents/${encodeURIComponent(item.id)}/download`;
    previewBody.textContent = '正在准备预览…';
    document.getElementById('document-preview-close').focus();
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(item.id)}/preview`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '预览失败');
      if (token !== previewToken) return;
      previewBody.replaceChildren();
      if (data.kind === 'pdf') {
        const frame = document.createElement('iframe');
        frame.className = 'document-preview-frame';
        frame.title = `${item.filename} 的内容预览`;
        frame.src = data.url;
        previewBody.append(frame);
      } else if (data.kind === 'text') {
        const textResponse = await fetch(data.url, { cache: 'no-store' });
        if (!textResponse.ok) throw new Error('无法读取文本内容');
        const content = await textResponse.text();
        if (token !== previewToken) return;
        if (data.truncated) {
          const notice = document.createElement('p');
          notice.className = 'document-preview-notice';
          notice.textContent = '文件较大，这里显示前 5 MiB；下载原件可查看全部内容。';
          previewBody.append(notice);
        }
        const pre = document.createElement('pre');
        pre.className = 'document-preview-text';
        pre.textContent = content;
        previewBody.append(pre);
      } else {
        previewBody.textContent = data.message || '此文件暂时无法预览，请下载原件查看。';
      }
    } catch (error) {
      if (token === previewToken) previewBody.textContent = error.message || '预览失败，请下载原件查看。';
    }
  }

  function makeUploadRow(file) {
    const row = document.createElement('div'); row.className = 'upload-row';
    const top = document.createElement('div'); top.className = 'upload-row-top';
    const title = document.createElement('strong'); title.textContent = file.name;
    const state = document.createElement('span'); state.textContent = '准备上传';
    top.append(title, state);
    const track = document.createElement('div'); track.className = 'upload-track';
    const fill = document.createElement('span'); track.append(fill);
    const bottom = document.createElement('div'); bottom.className = 'upload-row-bottom';
    const detail = document.createElement('span'); detail.textContent = bytes(file.size);
    const control = document.createElement('button'); control.type = 'button'; control.textContent = '暂停';
    bottom.append(detail, control);
    row.append(top, track, bottom); queue.prepend(row);
    return { row, state, fill, detail, control };
  }

  function renderKnowledge(data, mode) {
    knowledgeResults.replaceChildren();
    if (mode === 'answer') {
      const heading = document.createElement('h3'); heading.textContent = '文档回答';
      const answer = document.createElement('p');
      answer.className = 'knowledge-answer';
      answer.textContent = data.answer || data.answerError || '暂无回答';
      knowledgeResults.append(heading, answer);
    }
    const heading = document.createElement('h3');
    heading.textContent = `相关段落 · ${data.sources?.length || 0}`;
    knowledgeResults.append(heading);
    if (!data.sources?.length) {
      const empty = document.createElement('p'); empty.className = 'knowledge-hint';
      empty.textContent = '已索引文档中没有找到段落。';
      knowledgeResults.append(empty);
    }
    for (const source of data.sources || []) {
      const card = document.createElement('article'); card.className = 'knowledge-source';
      const title = document.createElement('div'); title.className = 'knowledge-source-title';
      const label = document.createElement('strong');
      label.textContent = `[${source.number}] ${source.filename} · ${source.locator}`;
      const open = document.createElement('button'); open.type = 'button';
      open.textContent = '查看原件 ↗'; open.className = 'document-preview-button';
      open.addEventListener('click', () => {
        const item = records.find(record => record.id === source.documentId) || { id: source.documentId, filename: source.filename };
        openPreview(item, open);
      });
      title.append(label, open);
      const excerpt = document.createElement('p'); excerpt.textContent = source.excerpt;
      card.append(title, excerpt); knowledgeResults.append(card);
    }
  }

  function addFiles(files) {
    for (const file of files) {
      const ui = makeUploadRow(file);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!allowed.has(ext) || file.size <= 0 || file.size > maxSize) {
        ui.state.textContent = '无法上传';
        ui.detail.textContent = '文件格式不支持，或大小超过 10 GiB';
        ui.control.remove();
        continue;
      }
      if (!window.tus || location.protocol === 'file:') {
        ui.state.textContent = '服务未连接';
        ui.detail.textContent = '请从 http://localhost:3000 打开本页';
        ui.control.remove();
        continue;
      }
      const upload = new window.tus.Upload(file, {
        endpoint: `${location.protocol}//${location.hostname}:1080/files/`,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        chunkSize: 16 * 1024 * 1024,
        metadata: { filename: file.name, filetype: file.type || 'application/octet-stream' },
        storeFingerprintForResuming: true,
        onError(error) {
          mode = 'error';
          ui.state.textContent = '上传中断';
          ui.detail.textContent = error.message || '请点击重试';
          ui.control.textContent = '重试';
          refresh();
        },
        onProgress(sent, total) {
          const percent = Math.round(sent / total * 100);
          ui.fill.style.width = `${percent}%`;
          ui.state.textContent = `${percent}%`;
          ui.detail.textContent = `${bytes(sent)} / ${bytes(total)}`;
        },
        onSuccess() {
          ui.state.textContent = '上传完成';
          ui.detail.textContent = '正在校验并保存原件';
          ui.control.remove();
          refresh();
          setTimeout(() => {
            ui.row.remove();
            refresh();
          }, 5000);
        }
      });
      let mode = 'uploading';
      ui.control.addEventListener('click', async () => {
        if (mode === 'uploading') {
          try {
            await upload.abort();
            mode = 'paused';
            ui.state.textContent = '已暂停';
            ui.control.textContent = '继续';
          } catch (error) {
            mode = 'error';
            ui.detail.textContent = error.message;
            ui.control.textContent = '重试';
          }
        } else {
          mode = 'uploading';
          ui.control.textContent = '暂停';
          upload.start();
        }
      });
      upload.findPreviousUploads().then(previous => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }).catch(() => upload.start());
    }
    fileInput.value = '';
  }

  document.getElementById('choose-files').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => addFiles(fileInput.files));
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('dragging'); });
  for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
  dropzone.addEventListener('drop', event => addFiles(event.dataTransfer.files));
  document.getElementById('refresh-documents').addEventListener('click', () => refresh());
  document.getElementById('load-more-documents').addEventListener('click', () => refresh(true));
  document.getElementById('document-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 250);
  });
  knowledgeForm.addEventListener('submit', async event => {
    event.preventDefault();
    const mode = event.submitter?.value === 'search' ? 'search' : 'answer';
    const query = document.getElementById('knowledge-query').value.trim();
    if (!query) return;
    const buttons = [...knowledgeForm.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    knowledgeResults.textContent = mode === 'answer' ? '正在检索段落并生成回答…' : '正在检索段落…';
    try {
      const response = await fetch('/api/knowledge/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '请求失败');
      renderKnowledge(data, mode);
    } catch (error) {
      knowledgeResults.textContent = error.message || '检索失败';
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  });
  window.addEventListener('documents:open', () => refresh());
  document.getElementById('document-preview-close').addEventListener('click', closePreview);
  previewModal.addEventListener('click', event => { if (event.target === previewModal) closePreview(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !previewModal.hidden) closePreview(); });
  if (location.hash === '#documents') refresh();
  setInterval(() => { if (!document.getElementById('documents').hidden && records.length <= 100) refresh(); }, 10000);
})();
