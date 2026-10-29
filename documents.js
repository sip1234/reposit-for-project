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
  let records = [];
  let loaded = false;
  let nextCursor = null;
  let searchTimer;
  let previewToken = 0;
  let previewOpener;
  let embeddingModels = [];
  const positive = value => Number.isInteger(value) && value > 0 ? value : null;
  function describeSource(item) {
    const source=item.source||{},section=item.sectionPath||[],extension=(item.extension||('.'+item.filename.split('.').pop())).toLowerCase();
    const pages=Array.isArray(source.pages)?source.pages.filter(positive):[];
    const page=positive(source.page)||positive(item.page)||pages[0]||null;
    const slide=positive(source.slide),row=positive(source.row),line=positive(source.line_start)||positive(item.line);
    const range=(start,end)=>start?`${start}${positive(end)&&end>=start&&end!==start?'–'+end:''}`:'未记录';
    const fields={页码:page?(pages.length?pages.join('、'):String(page)):'未记录',章节路径:section.length?section.join(' / '):'未记录',
      工作表:source.sheet||'未记录',数据行:range(row,source.row_end),文本行:range(line,source.line_end),
      幻灯片:slide?String(slide):'未记录',段落:positive(source.paragraph)?String(source.paragraph):'未记录',表格:source.table?String(source.table):'未记录'};
    let keys=['页码','章节路径'],note='仅支持原件预览；来源位置未记录，无法精确定位。',previewPage=null,previewLine=null;
    if(extension==='.pdf') {previewPage=page;note=page?`尝试定位到 PDF 第 ${page} 页；不高亮页内具体文字，实际跳页由预览器支持。`:'PDF 页码未记录，将打开完整文件。';}
    else if(extension==='.pptx'||extension==='.ppt') {keys=['幻灯片','章节路径'];previewPage=slide||page;note=previewPage?`按幻灯片或转换页编号 ${previewPage} 尝试跳转到预览 PDF；转换后的页序可能变化，不定位具体对象。`:'幻灯片编号未记录，将打开转换预览。';}
    else if(extension==='.txt'||extension==='.csv') {keys=extension==='.csv'?['工作表','数据行']:['文本行','章节路径'];previewLine=line||(extension==='.csv'?row:null);note=previewLine?`按已记录的来源行 ${previewLine} 标记原始文本${extension==='.csv'?'；CSV 解析器记录数据字段的物理起始行，多行字段只定位起点':''}。超过前 5 MiB 的内容需下载查看。`:'文本行号未记录，将显示文件预览。';}
    else if(extension==='.xlsx'||extension==='.xls'||extension==='.ods') {keys=['工作表','数据行'];previewPage=page;note='显示转换后的 PDF；工作表、数据行不能可靠映射为 PDF 页码，请对照来源信息或下载原件。';}
    else if(extension==='.docx'||extension==='.doc'||extension==='.odt'||extension==='.rtf') {keys=['章节路径','段落','表格'];previewPage=page;note=page?'来源为转换 PDF 页码，尝试跳页；与 Word 原始分页可能不同。':'显示转换后的 PDF；章节和段落位置不等于物理页码，当前不支持按段落精确跳转。';}
    return {fields,label:keys.map(key=>`${key}：${fields[key]}`).join(' · '),note,page:previewPage,line:previewLine};
  }

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
      const [response, modelResponse] = await Promise.all([
        fetch(`/api/documents?${params}`, { cache: 'no-store' }),
        fetch('/api/models', { cache: 'no-store' })
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (modelResponse.ok) embeddingModels = (await modelResponse.json()).models.filter(model => model.kind === 'embedding');
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
      indexBadge.textContent = item.parseStage && item.indexStatus !== 'ready'
        ? window.parsingStageLabel?.(item.parseStage,item.parseProgress) || item.parseStage
        : ({ unparsed: '未解析', pending: '等待解析', processing: '解析中', ready: `${item.indexChunks} 段已索引`, failed: '解析失败', unsupported: '暂不支持' }[item.indexStatus] || '—');
      if (item.indexError) indexBadge.title = item.indexError;
      index.append(indexBadge);
      if(item.activeVersionId && item.indexStatus!=='ready'){const available=document.createElement('small');available.textContent=` · 旧版 ${item.activeChunks} 段可用`;index.append(available);}
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
        action.append(preview, link, createParseControls(item, embeddingModels, () => refresh()));
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
      const location=describeSource(item);
      const notice=document.createElement('p');notice.className='document-preview-location';
      notice.textContent=`${location.label}。${location.note}`;previewBody.append(notice);
      if (data.kind === 'pdf') {
        const frame = document.createElement('iframe');
        frame.className = 'document-preview-frame';
        frame.title = `${item.filename} 的内容预览`;
        frame.src = data.url + (location.page ? `#page=${location.page}` : '');
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
        if(location.line){const lines=content.split('\n'),n=location.line-1;
          if(n<lines.length){pre.replaceChildren(document.createTextNode(lines.slice(0,n).join('\n')+(n?'\n':'')));const mark=document.createElement('mark');mark.textContent=lines[n];pre.append(mark,document.createTextNode('\n'+lines.slice(n+1).join('\n')));mark.scrollIntoView({block:'center'});}
          else notice.textContent+=' 来源行不在当前预览范围中，请下载原件查看。';}
      } else {
        previewBody.textContent = data.message || '此文件暂时无法预览，请下载原件查看。';
      }
    } catch (error) {
      if (token === previewToken) previewBody.textContent = error.message || '预览失败，请下载原件查看。';
    }
  }

  function createParseControls(item, modelList, onDone) {
    const controls = document.createElement('span'); controls.className = 'document-parse-controls';
    if (item.indexStatus === 'unsupported') return controls;
    const available = modelList.filter(model => model.kind === 'embedding');
    const select = document.createElement('select'); select.setAttribute('aria-label', `${item.filename} 的 embedding 模型`);
    for (const model of available) {
      const option = document.createElement('option'); option.value = model.id; option.textContent = model.name;
      select.append(option);
    }
    select.value = available.some(model => model.id === item.indexModelId)
      ? item.indexModelId : (available.find(model => model.active)?.id || available[0]?.id || '');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle-button';
    function update() {
      const same = select.value === item.indexModelId;
      button.disabled = !select.value || (same && ['ready', 'pending', 'processing'].includes(item.indexStatus));
      button.textContent = same && item.indexStatus === 'ready' ? '已解析' : '解析';
    }
    select.addEventListener('change', update); update();
    button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = '提交中…';
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(item.id)}/parse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: select.value })
        });
        const data = await response.json();
        if(data.code==='reparse_requires_ack'){button.disabled=false;update();window.openParsingDetails?.(item,button);return;}
        if (!response.ok) throw new Error(data.error || '解析请求失败');
        onDone?.();
      } catch (error) { button.textContent = error.message; button.disabled = false; }
    });
    controls.append(select, button);
    const detail=document.createElement('button');detail.type='button';detail.className='document-preview-button';detail.textContent='解析详情 / 分块管理';
    detail.addEventListener('click',()=>window.openParsingDetails?.(item,detail));controls.append(detail);
    return controls;
  }

  function makeUploadRow(file, target) {
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
    row.append(top, track, bottom); target.prepend(row);
    return { row, state, fill, detail, control };
  }

  function addFiles(files, options = {}) {
    for (const file of files) {
      const ui = makeUploadRow(file, options.queue || queue);
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
          const id = upload.url ? new URL(upload.url).pathname.split('/').filter(Boolean).at(-1) : null;
          options.onUploaded?.(id);
          window.dispatchEvent(new CustomEvent('document:uploaded', { detail: { id } }));
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
  window.openDocumentPreview = (item, opener) => openPreview(item, opener);
  window.describeDocumentSource = describeSource;
  window.createDocumentParseControls = createParseControls;
  window.startDocumentUploads = (files, options) => addFiles(files, options);
  window.addEventListener('documents:open', () => refresh());
  window.addEventListener('parsing:changed', () => refresh());
  document.getElementById('document-preview-close').addEventListener('click', closePreview);
  previewModal.addEventListener('click', event => { if (event.target === previewModal) closePreview(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !previewModal.hidden) {event.stopImmediatePropagation();closePreview();} });
  if (location.hash === '#documents') refresh();
  setInterval(() => { if (!document.getElementById('documents').hidden && records.length <= 100) refresh(); }, 10000);
})();
