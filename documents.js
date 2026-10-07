(() => {
  const maxSize = 10 * 1024 ** 3;
  const allowed = new Set(['doc', 'docx', 'txt', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt', 'ods', 'odp']);
  const listBody = document.getElementById('document-rows');
  const fileInput = document.getElementById('document-files');
  const queue = document.getElementById('upload-queue');
  const dropzone = document.getElementById('document-dropzone');
  const serviceStatus = document.getElementById('documents-service-status');
  const serviceMessage = document.getElementById('documents-service-message');
  let records = [];
  let loaded = false;
  let nextCursor = null;
  let searchTimer;

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
      cell.colSpan = 5;
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
      const action = document.createElement('td');
      if (item.status === 'ready') {
        const link = document.createElement('a');
        link.href = `/api/documents/${encodeURIComponent(item.id)}/download`;
        link.textContent = '下载原件 ↗';
        link.className = 'document-download';
        action.append(link);
      } else action.textContent = '—';
      row.append(name, size, date, status, action);
      listBody.append(row);
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
    return { state, fill, detail, control };
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
          setTimeout(refresh, 2000);
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
  window.addEventListener('documents:open', () => refresh());
  if (location.hash === '#documents') refresh();
  setInterval(() => { if (!document.getElementById('documents').hidden && records.length <= 100) refresh(); }, 10000);
})();
