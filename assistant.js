(() => {
  const tabButtons = [...document.querySelectorAll('[data-assistant-tab]')];
  const chatPanel = document.getElementById('assistant-chat');
  const basesPanel = document.getElementById('assistant-bases');
  const baseOptions = document.getElementById('assistant-base-options');
  const baseList = document.getElementById('assistant-base-list');
  const documentOptions = document.getElementById('assistant-document-options');
  const selectedList = document.getElementById('assistant-selected-documents');
  const results = document.getElementById('knowledge-results');
  const form = document.getElementById('assistant-base-form');
  const message = document.getElementById('assistant-editor-message');
  let bases = [];
  let selectedBaseIds = new Set();
  let editingId = null;
  let selectedDocuments = new Map();
  let availableDocuments = [];
  let nextCursor = null;
  let documentSearchTimer;

  async function jsonRequest(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function setScopeHint() {
    const hint = document.createElement('p');
    hint.className = 'knowledge-hint';
    hint.textContent = !bases.length
      ? '先创建知识库并添加已解析文件。'
      : selectedBaseIds.size
        ? `已选择 ${selectedBaseIds.size} 个知识库，可以提问或检索段落。`
        : '请勾选至少一个知识库作为检索范围。';
    results.replaceChildren(hint);
  }

  function setTab(name) {
    const chat = name === 'chat';
    chatPanel.hidden = !chat;
    basesPanel.hidden = chat;
    for (const button of tabButtons) {
      const active = button.dataset.assistantTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    if (!chat) loadDocuments();
  }

  function renderBaseOptions() {
    baseOptions.replaceChildren();
    if (!bases.length) {
      const note = document.createElement('p');
      note.textContent = '还没有知识库。先到“知识库”分页创建，并添加已解析文件。';
      baseOptions.append(note);
      return;
    }
    for (const base of bases) {
      const label = document.createElement('label');
      label.className = 'assistant-base-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = base.id;
      checkbox.checked = selectedBaseIds.has(base.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedBaseIds.add(base.id);
        else selectedBaseIds.delete(base.id);
        setScopeHint();
      });
      const text = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = base.name;
      const count = document.createElement('small'); count.textContent = `${base.documents.length} 个文件`;
      text.append(name, count);
      label.append(checkbox, text);
      baseOptions.append(label);
    }
  }

  function renderBaseList() {
    baseList.replaceChildren();
    if (!bases.length) {
      const note = document.createElement('p');
      note.className = 'assistant-empty';
      note.textContent = '暂无知识库。点击“新建”创建第一组资料。';
      baseList.append(note);
      return;
    }
    for (const base of bases) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `assistant-base-item${editingId === base.id ? ' active' : ''}`;
      const title = document.createElement('strong'); title.textContent = base.name;
      const detail = document.createElement('span');
      detail.textContent = `${base.documents.length} 个文件${base.description ? ` · ${base.description}` : ''}`;
      button.append(title, detail);
      button.addEventListener('click', () => editBase(base.id));
      baseList.append(button);
    }
  }

  async function loadBases() {
    try {
      const data = await jsonRequest('/api/knowledge-bases');
      bases = data.knowledgeBases || [];
      const known = new Set(bases.map(base => base.id));
      selectedBaseIds = new Set([...selectedBaseIds].filter(id => known.has(id)));
      if (editingId && !known.has(editingId)) newBase();
      renderBaseOptions();
      renderBaseList();
    } catch (error) {
      baseOptions.textContent = `无法加载知识库：${error.message}`;
      baseList.textContent = `无法加载知识库：${error.message}`;
    }
  }

  function newBase() {
    editingId = null;
    selectedDocuments = new Map();
    document.getElementById('assistant-editor-title').textContent = '新建知识库';
    document.getElementById('assistant-base-name').value = '';
    document.getElementById('assistant-base-description').value = '';
    document.getElementById('assistant-delete-base').hidden = true;
    message.textContent = '';
    renderSelectedDocuments();
    renderDocumentOptions();
    renderBaseList();
  }

  function editBase(id) {
    const base = bases.find(item => item.id === id);
    if (!base) return;
    editingId = id;
    selectedDocuments = new Map(base.documents.map(item => [item.id, item.filename]));
    document.getElementById('assistant-editor-title').textContent = '编辑知识库';
    document.getElementById('assistant-base-name').value = base.name;
    document.getElementById('assistant-base-description').value = base.description;
    document.getElementById('assistant-delete-base').hidden = false;
    message.textContent = '';
    renderSelectedDocuments();
    renderDocumentOptions();
    renderBaseList();
  }

  function renderSelectedDocuments() {
    document.getElementById('assistant-selected-count').textContent = String(selectedDocuments.size);
    selectedList.replaceChildren();
    if (!selectedDocuments.size) {
      selectedList.textContent = '尚未选择文件。空知识库不会参与检索。';
      return;
    }
    for (const [id, filename] of selectedDocuments) {
      const chip = document.createElement('span'); chip.className = 'assistant-document-chip';
      const text = document.createElement('span'); text.textContent = filename;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${filename}`);
      remove.addEventListener('click', () => {
        selectedDocuments.delete(id);
        renderSelectedDocuments(); renderDocumentOptions();
      });
      chip.append(text, remove); selectedList.append(chip);
    }
  }

  function renderDocumentOptions() {
    documentOptions.replaceChildren();
    if (!availableDocuments.length) {
      documentOptions.textContent = '没有匹配的已解析文件。可先到“知识文档”上传并等待索引完成。';
      return;
    }
    for (const item of availableDocuments) {
      const label = document.createElement('label'); label.className = 'assistant-document-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedDocuments.has(item.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedDocuments.set(item.id, item.filename);
        else selectedDocuments.delete(item.id);
        renderSelectedDocuments();
      });
      const text = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = item.filename;
      const detail = document.createElement('small'); detail.textContent = `${item.indexChunks} 段已索引`;
      text.append(name, detail); label.append(checkbox, text);
      documentOptions.append(label);
    }
  }

  async function loadDocuments(more = false) {
    const params = new URLSearchParams();
    const query = document.getElementById('assistant-document-search').value.trim();
    if (query) params.set('q', query);
    if (more && nextCursor) params.set('cursor', nextCursor);
    try {
      const data = await jsonRequest(`/api/knowledge-bases/documents?${params}`);
      availableDocuments = more ? availableDocuments.concat(data.documents || []) : data.documents || [];
      nextCursor = data.nextCursor || null;
      document.getElementById('assistant-load-more-documents').hidden = !nextCursor;
      renderDocumentOptions();
    } catch (error) {
      documentOptions.textContent = `无法加载文件：${error.message}`;
    }
  }

  function renderResults(data, mode) {
    results.replaceChildren();
    if (mode === 'answer') {
      const heading = document.createElement('h3'); heading.textContent = '文档回答';
      const answer = document.createElement('p'); answer.className = 'knowledge-answer';
      answer.textContent = data.answer || data.answerError || '暂无回答';
      results.append(heading, answer);
    }
    const heading = document.createElement('h3');
    heading.textContent = `相关段落 · ${data.sources?.length || 0}`;
    results.append(heading);
    if (!data.sources?.length) {
      const empty = document.createElement('p'); empty.className = 'knowledge-hint';
      empty.textContent = '选中的知识库中没有找到段落。';
      results.append(empty);
    }
    for (const source of data.sources || []) {
      const card = document.createElement('article'); card.className = 'knowledge-source';
      const title = document.createElement('div'); title.className = 'knowledge-source-title';
      const label = document.createElement('strong');
      label.textContent = `[${source.number}] ${source.filename} · ${source.locator}${source.knowledgeBaseName ? ` · ${source.knowledgeBaseName}` : ''}`;
      const open = document.createElement('button'); open.type = 'button';
      open.textContent = '查看原件 ↗'; open.className = 'document-preview-button';
      open.addEventListener('click', () => window.openDocumentPreview({ id: source.documentId, filename: source.filename }, open));
      title.append(label, open);
      const excerpt = document.createElement('p'); excerpt.textContent = source.excerpt;
      card.append(title, excerpt); results.append(card);
    }
  }

  tabButtons.forEach(button => button.addEventListener('click', () => setTab(button.dataset.assistantTab)));
  document.getElementById('assistant-manage-bases').addEventListener('click', () => setTab('bases'));
  document.getElementById('assistant-new-base').addEventListener('click', newBase);
  document.getElementById('assistant-load-more-documents').addEventListener('click', () => loadDocuments(true));
  document.getElementById('assistant-document-search').addEventListener('input', () => {
    clearTimeout(documentSearchTimer);
    documentSearchTimer = setTimeout(() => loadDocuments(), 250);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = document.getElementById('assistant-base-name').value.trim();
    if (!name) return;
    const save = form.querySelector('button[type="submit"]');
    save.disabled = true; message.textContent = '正在保存…';
    try {
      const data = await jsonRequest(editingId ? `/api/knowledge-bases/${editingId}` : '/api/knowledge-bases', {
        method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: document.getElementById('assistant-base-description').value.trim(), documentIds: [...selectedDocuments.keys()] })
      });
      selectedBaseIds.add(data.id);
      await loadBases();
      editBase(data.id);
      setScopeHint();
      message.textContent = '已保存，可在问答页选择此知识库。';
    } catch (error) { message.textContent = error.message; }
    finally { save.disabled = false; }
  });
  document.getElementById('assistant-delete-base').addEventListener('click', async () => {
    const base = bases.find(item => item.id === editingId);
    if (!base || !window.confirm(`删除知识库“${base.name}”？原始文件仍保留。`)) return;
    try {
      await jsonRequest(`/api/knowledge-bases/${base.id}`, { method: 'DELETE' });
      selectedBaseIds.delete(base.id);
      newBase(); await loadBases();
      setScopeHint();
      message.textContent = '知识库已删除，原始文件仍保留。';
    } catch (error) { message.textContent = error.message; }
  });
  document.getElementById('knowledge-form').addEventListener('submit', async event => {
    event.preventDefault();
    const query = document.getElementById('knowledge-query').value.trim();
    if (!query) return;
    if (!selectedBaseIds.size) {
      results.textContent = '请先选择至少一个知识库。';
      return;
    }
    const mode = event.submitter?.value === 'search' ? 'search' : 'answer';
    const buttons = [...event.currentTarget.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    results.textContent = mode === 'answer' ? '正在从所选知识库检索并生成回答…' : '正在检索所选知识库…';
    try {
      const data = await jsonRequest('/api/knowledge/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode, knowledgeBaseIds: [...selectedBaseIds] })
      });
      renderResults(data, mode);
    } catch (error) { results.textContent = error.message; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
  window.addEventListener('assistant:open', () => loadBases());
  if (location.hash === '#assistant') loadBases();
})();
