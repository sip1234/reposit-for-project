(() => {
  const stages = {waiting:'等待',extracting:'提取',ocr:'OCR',chunking:'分块',embedding:'向量化',publishing:'发布版本',complete:'完成',failed:'失败'};
  const strategies = {paragraph:'通用段落',section:'标题与章节',table:'表格优先',qa:'问答对'};
  const panel = document.createElement('div');
  panel.className = 'parsing-backdrop'; panel.hidden = true;
  panel.innerHTML = `<section class="parsing-dialog" role="dialog" aria-modal="true" aria-labelledby="parsing-title">
    <header class="parsing-header"><div><span class="panel-kicker">DOCUMENT PARSING</span><h2 id="parsing-title">文档解析与分块</h2><p id="parsing-scope"></p><p id="parsing-message" role="status" aria-live="polite"></p></div><div class="parsing-header-actions"><button id="parsing-close" class="subtle-button" aria-label="关闭解析详情">关闭 ×</button><button id="parsing-jump" class="subtle-button">分块与检索 ↓</button></div></header>
    <div class="parsing-layout"><aside class="parsing-settings"><h3>解析配置</h3><p>长度统一按 Unicode 字符计数，包含补充的表头和章节。保存配置后生成新版本。</p>
    <label>已保存配置<select id="parsing-preset"></select></label>
    <form id="parsing-form"><label>配置名称<input id="parsing-config-name" maxlength="80" required></label>
    <label>解析方式<select name="method"><option value="auto">自动：缺少文本的 PDF 页面使用 OCR</option><option value="text">仅提取文本层</option><option value="ocr">PDF 全页强制 OCR</option></select></label>
    <label>分块策略<select name="strategy"><option value="paragraph">通用段落</option><option value="section">标题与章节</option><option value="table">表格优先</option><option value="qa">问答对 Q:/A:、问:/答:</option></select></label>
    <div class="parsing-number-grid"><label>目标字符数<input type="number" name="targetLength" min="100" max="16000" required></label><label>最大字符数<input type="number" name="maxLength" min="100" max="16000" required></label><label>重叠字符数<input type="number" name="overlapLength" min="0" required></label><label>表头行数<input type="number" name="headerRows" min="1" max="5" required></label></div>
    <label class="parsing-check"><input type="checkbox" name="ocrEnabled">启用本地 OCR</label><label>OCR 语言<select name="ocrLanguage"><option value="chi_sim+eng">简体中文＋英文</option><option value="chi_sim">简体中文</option><option value="eng">英文</option></select></label>
    <label class="parsing-check"><input type="checkbox" name="headerContext">补充表头（单元格仍保留列名与值）</label><label class="parsing-check"><input type="checkbox" name="sectionContext">补充章节路径</label>
    <label>向量模型<select id="parsing-model" required></select></label><p id="parsing-engine"></p><button class="subtle-button" type="submit">保存配置</button></form>
    <p>新版本不继承人工正文编辑和启停状态；成功后切换生效，失败保留上一有效版本，旧版本保留只读历史。</p><label class="parsing-check" id="parsing-ack-label" hidden><input id="parsing-ack" type="checkbox">已了解新版本不继承人工维护</label>
    <div class="parsing-actions"><button id="parsing-run" class="button-primary">按此配置解析 / 重试</button><button id="parsing-force" class="subtle-button">强制重新解析</button></div>
    <p>普通解析可复用相同文件、模型、配置及解析器的缓存。强制解析会重新计算。人工编辑仅作用于当前文档的当前有效版本。</p></aside>
    <div class="parsing-content"><div class="parsing-toolbar"><label>查看解析版本<select id="parsing-version"></select></label><button id="parsing-refresh" class="subtle-button">刷新</button><button id="parsing-preview" class="subtle-button">预览原件 ↗</button></div>
    <p id="parsing-active"></p><div id="parsing-status" role="status"></div><progress id="parsing-progress" max="100" value="0"></progress><pre id="parsing-actual" class="parsing-metadata"></pre><div id="parsing-stats" class="parsing-stats"></div>
    <details><summary>完整配置快照与版本标识</summary><pre id="parsing-config-raw" class="parsing-metadata"></pre></details>
    <details><summary>页面诊断与处理记录</summary><pre id="parsing-diagnostics" class="parsing-metadata"></pre></details>
    <div class="parsing-toolbar" id="parsing-chunk-heading"><h3>分块内容</h3><input id="parsing-search" maxlength="200" type="search" aria-label="搜索分块正文" placeholder="搜索分块正文"><span id="parsing-count"></span></div>
    <div class="parsing-toolbar"><label>启用状态<select id="parsing-enabled"><option value="all">全部</option><option value="enabled">启用</option><option value="disabled">停用</option></select></label><label>向量状态<select id="parsing-state"><option value="all">全部</option><option value="pending">等待更新</option><option value="processing">处理中</option><option value="ready">更新成功</option><option value="failed">更新失败</option></select></label></div>
    <p id="parsing-edit-scope"></p><section id="parsing-detail" class="parsing-chunk parsing-detail" hidden aria-label="分块全文与维护"></section><div id="parsing-chunks"></div><div class="parsing-toolbar"><button id="parsing-prev" class="subtle-button">上一页</button><span id="parsing-page"></span><button id="parsing-next" class="subtle-button">下一页</button></div>
    <section class="parsing-test"><h3>检索验证</h3><p>仅检索当前有效版本；使用共用混合检索与重排流程，保留各阶段分数。</p><form id="parsing-test-form"><div id="parsing-retrieval-controls"></div><label>检索范围<select id="parsing-test-scope"><option value="file">当前文件</option><option value="kb">所选知识库</option></select></label><label id="parsing-test-kb-label" hidden>知识库（可多选）<select id="parsing-test-kbs" multiple></select></label><label>测试问题<input id="parsing-test-query" maxlength="500" required placeholder="例如：溶解氧控制范围是多少？"></label><button class="button-primary" type="submit">运行检索</button></form><div id="parsing-test-results" role="status"></div></section>
    </div></div></section>`;
  document.body.append(panel);
  const el = id => document.getElementById(`parsing-${id}`);
  const vectorStates={pending:'等待更新',processing:'处理中',ready:'更新成功',failed:'更新失败'};
  const actions={parse:'解析生成',edit:'编辑正文',enable:'启用',disable:'停用',retry_embedding:'重试向量',embedding_started:'开始更新向量',embedding_complete:'向量更新成功',embedding_failed:'向量更新失败'};
  let item,opener,presets=[],versionId=null,page=1,total=0,current=null,detail=null,editing=false,saving=false,conflicted=false,generation=0,sequence=0,selection=0,signature='',queryTimer,previousOverflow='',pendingIndex=null;
  let vectorWatch=null;
  const form=el('form');
  const retrievalControls=window.RetrievalUI.createControls(el('retrieval-controls'),{diagnostics:true});
  const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const button=(text,fn,disabled=false)=>{const b=node('button',text,'subtle-button');b.type='button';b.disabled=disabled;b.onclick=fn;return b;};
  const time=value=>value?new Date(value).toLocaleString():'未记录';
  const sourceInfo=(chunk,doc=item)=>window.describeDocumentSource?.({...doc,source:chunk.source||{},sectionPath:chunk.section_path||[]})||{label:'未记录',note:'无法精确定位。',fields:{来源:'未记录'}};
  function message(text){el('message').textContent=text;}
  async function request(url,options){const response=await fetch(url,{cache:'no-store',...options});const data=await response.json();if(!response.ok){const error=new Error(data.error||`HTTP ${response.status}`);Object.assign(error,{status:response.status,code:data.code,retrieval:data.retrieval,runId:data.runId});throw error;}return data;}
  function guarded(){if(editing||saving){message(saving?'正在保存，请等待结果。':'正文编辑尚未结束。请先保存或取消编辑，再切换、刷新或关闭。');el('detail').scrollIntoView({block:'nearest'});return true;}return false;}
  function navigation(){for(const id of ['version','search','enabled','state','refresh','run','force'])el(id).disabled=editing||saving;el('prev').disabled=editing||saving||page<=1;el('next').disabled=editing||saving||page*20>=total;}
  function fill(config){for(const [key,value]of Object.entries(config)){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}}}
  function draft(){const config={lengthUnit:'unicode_char'};for(const name of ['method','strategy','ocrLanguage'])config[name]=form.elements.namedItem(name).value;for(const name of ['targetLength','maxLength','overlapLength','headerRows'])config[name]=Number(form.elements.namedItem(name).value);for(const name of ['ocrEnabled','headerContext','sectionContext'])config[name]=form.elements.namedItem(name).checked;return config;}
  function renderPresets(){el('preset').replaceChildren(...presets.map(p=>new Option(`${p.name} · 配置 v${p.config_version}`,p.id)));}
  async function saveConfig(){const saved=await request('/api/parsing/configs',json('POST',{name:el('config-name').value.trim(),config:draft()}));if(!presets.some(p=>p.id===saved.id)){presets.push(saved);renderPresets();}el('preset').value=saved.id;return saved;}
  async function submitParse(force){
    if(guarded()||!form.reportValidity())return;
    if(current?.activeStats?.maintained&&!el('ack').checked){message('请先勾选确认：新版本不继承人工正文编辑和启停状态，旧版本保留只读历史。');return;}
    saving=true;navigation();const session=generation;
    try{const config=await saveConfig();const result=await request(`/api/documents/${item.id}/parse`,json('POST',{modelId:el('model').value,configId:config.id,force,acknowledgeEdits:el('ack').checked}));if(session!==generation)return;
      versionId=result.versionId;page=1;detail=null;pendingIndex=null;signature='';el('detail').hidden=true;el('ack').checked=false;
      message(`${result.reused?'已复用缓存或在途任务':'已提交新任务'}。新结果完成前保留上一有效版本；新版本不继承人工维护。`);await load();window.dispatchEvent(new Event('parsing:changed'));
    }catch(error){message(error.message);}finally{saving=false;navigation();}
  }
  function preview(chunk={},doc=item,from=el('preview')){window.openDocumentPreview?.({...doc,source:chunk.source||{},sectionPath:chunk.section_path||[]},from);}
  function stats(data){el('stats').replaceChildren(...[['总数','total'],['启用','enabled'],['停用','disabled'],['等待更新','pending'],['处理中','processing'],['更新失败','failed'],['可检索','retrievable']].map(([label,key])=>{const box=node('div');box.append(node('strong',String(data?.[key]||0)),node('span',label));return box;}));}
  async function load(initial=false){
    const run=++sequence,session=generation,doc=item;if(!doc)return;
    try{const data=await request(`/api/documents/${doc.id}/parsing${versionId?'?version='+versionId:''}`);if(session!==generation||run!==sequence)return;current=data;const v=data.version;
      if(v)versionId=v.id;
      el('version').replaceChildren(...data.versions.map(x=>new Option(`${x.id===data.document.active_parse_version_id?'[当前有效] ':''}${time(x.created_at)} · ${stages[x.stage]||x.status} · ${x.id.slice(0,8)}`,x.id)));
      if(v)el('version').value=v.id;
      el('scope').textContent=`${doc.filename} · 人工维护仅影响本文件的指定版本，引用本文件的知识库同步生效`;
      el('active').textContent=`当前有效版本：${data.activeVersion?.id||'未记录'} · 向量模型：${data.activeVersion?`${data.activeVersion.model_name} (${data.activeVersion.model_identifier})`:'未记录'}${data.requestedVersion&&data.requestedVersion.id!==data.activeVersion?.id?`\n最近请求：${data.requestedVersion.id} · ${stages[data.requestedVersion.stage]||data.requestedVersion.status}${data.requestedVersion.error?' · '+data.requestedVersion.error:''}`:''}`;
      stats(data.stats);el('ack-label').hidden=!data.activeStats?.maintained;
      if(!v){el('status').textContent='尚未解析。选择配置和模型后开始。';el('chunks').textContent='暂无分块';el('actual').textContent='';el('config-raw').textContent='';el('diagnostics').textContent='';el('count').textContent='0 段';el('progress').value=0;el('page').textContent='暂无分块';total=0;navigation();return;}
      el('status').textContent=`${stages[v.stage]||v.stage} ${v.progress}% · ${v.active?'当前有效版本，可维护':v.status==='ready'?'历史版本，只读':'尚未完成，只读'}${v.error?' · '+v.error:''}`;
      el('progress').value=v.progress;
      el('actual').textContent=`查看版本：${v.id}\n实际配置：${v.config_name} · ${strategies[v.config.strategy]||v.config.strategy}\n目标 ${v.config.targetLength} / 最大 ${v.config.maxLength} / 重叠 ${v.config.overlapLength} · 单位 ${v.config.lengthUnit==='unicode_char'?'Unicode 字符':v.config.lengthUnit}\n解析方式 ${v.config.method} · OCR ${v.config.ocrEnabled?'启用':'关闭'} · 解析器 ${v.parser_version} · 配置格式 v${v.config_version}\n向量模型：${v.model_name} (${v.model_identifier})`;
      el('config-raw').textContent=JSON.stringify({解析版本:v.id,共享缓存任务:v.job_id,配置标识:v.config_id,配置:v.config},null,2);
      el('diagnostics').textContent=JSON.stringify({页或工作表数:v.page_count,结构块数:v.block_count,开始:v.started_at,完成:v.finished_at,耗时与阶段:v.metrics,提示:v.warnings,页面:v.pages,阶段事件:data.events,版本操作:data.audit},null,2);
      if(initial){const preset=presets.find(p=>p.id===v.config_id);if(preset){el('preset').value=preset.id;el('config-name').value=preset.name;fill(preset.config);}el('model').value=v.model_id;}
      el('edit-scope').textContent=v.active?'维护对象：本文件的当前有效版本；共享原始解析缓存不受影响。停用、等待向量、向量失败或修订不一致的分块不参与检索。':'此版本只读。检索使用当前有效版本。新版本完成后切换，解析失败保留上一有效版本。';
      if(v.status!=='ready'){el('chunks').textContent='此版本暂无可用分块，请查看进度或诊断。';el('count').textContent='0 段';total=0;signature='';el('detail').hidden=true;navigation();return;}
      if(!editing){await loadChunks(session,run,v);if(session!==generation||run!==sequence)return;
        if(pendingIndex!==null){const index=pendingIndex;pendingIndex=null;await selectChunk(index);}else if(detail)await refreshDetail(session,v.id);
      }navigation();
    }catch(error){if(session===generation){message(error.message);if(!current)el('chunks').textContent='加载失败，请点击刷新重试。';}}
  }
  async function loadChunks(session,run,v){
    const params=new URLSearchParams({version:v.id,page,q:el('search').value,enabled:el('enabled').value,state:el('state').value});const data=await request(`/api/documents/${item.id}/chunks?${params}`);
    if(session!==generation||run!==sequence||editing)return;total=data.total;stats(data.stats);
    if(page>1&&(page-1)*20>=total){page=Math.max(1,Math.ceil(total/20));signature='';return loadChunks(session,run,v);}
    el('count').textContent=`匹配 ${total} 段`;el('page').textContent=`第 ${page} / ${Math.max(1,Math.ceil(total/20))} 页（每页 20 段）`;
    const next=JSON.stringify([v.id,page,params.toString(),data.editable,data.chunks]);if(next===signature)return;signature=next;
    el('chunks').replaceChildren();if(!data.chunks.length)el('chunks').textContent='没有匹配的分块。可调整搜索或筛选条件。';
    for(const c of data.chunks){const card=node('article',undefined,'parsing-chunk');card.append(node('strong',`#${c.chunk_index+1} · ${c.content_type} · ${c.char_length} 字符 · ${strategies[c.strategy]||c.strategy}`),node('p',`${sourceInfo(c).label} · 章节：${c.section_path?.join(' / ')||'未记录'}`),node('p',`${c.enabled?'启用':'停用'} · 向量${vectorStates[c.embedding_state]||c.embedding_state} · 正文修订 ${c.revision} / 向量修订 ${c.vector_revision} · ${actions[c.last_action]||c.last_action} · ${time(c.maintained_at)}`),node('pre',Array.from(c.content).slice(0,220).join('')+(Array.from(c.content).length>220?'…':'')));
      if(c.error)card.append(node('p',c.error,'parsing-error'));
      const tools=node('div',undefined,'parsing-toolbar');tools.append(button('查看全文',()=>selectChunk(c.chunk_index)),button('编辑正文',async()=>{if(await selectChunk(c.chunk_index))beginEdit();},!data.editable),button(c.enabled?'停用':'启用',()=>change(c,{enabled:!c.enabled}),!data.editable));if(c.embedding_state==='failed')tools.append(button('重试向量更新',()=>change(c,{retry:true}),!data.editable));card.append(tools);el('chunks').append(card);
    }
  }
  async function selectChunk(index,scroll=true){if(guarded())return false;const session=generation,v=versionId,selected=++selection;detail=null;el('detail').hidden=false;el('detail').textContent='正在加载完整正文…';try{const data=await request(`/api/documents/${item.id}/chunks/${index}?version=${v}`);if(session!==generation||v!==versionId||selected!==selection)return false;detail=data;renderDetail();if(scroll)el('detail').scrollIntoView({block:'start'});return true;}catch(error){if(session===generation&&selected===selection){message(error.message);el('detail').textContent='全文加载失败，请从列表重新打开。';}return false;}}
  async function refreshDetail(session,v){const index=detail.chunk.chunk_index;const data=await request(`/api/documents/${item.id}/chunks/${index}?version=${v}`);if(session!==generation||editing||v!==versionId||detail?.chunk.chunk_index!==index)return;if(JSON.stringify(data)!==JSON.stringify(detail)){detail=data;renderDetail();}}
  function renderDetail(){
    if(vectorWatch&&detail.versionId===vectorWatch.versionId&&detail.chunk.chunk_index===vectorWatch.index&&detail.chunk.embedding_job_id===vectorWatch.jobId&&['ready','failed'].includes(detail.chunk.embedding_state)){
      message(detail.chunk.embedding_state==='ready'?`向量已更新完成，正文与向量修订一致。${detail.chunk.enabled?'该分块可重新参与检索。':'分块仍停用，不参与检索。'}`:`向量更新失败：${detail.chunk.error||'请查看任务记录'}。可在全文详情中重试。`);vectorWatch=null;
    }
    const target=el('detail');target.hidden=false;target.replaceChildren();const c=detail.chunk,info=sourceInfo(c);target.append(node('h3',`分块 #${c.chunk_index+1} · 全文与维护`),node('p',`${detail.editable?'当前有效版本，可维护':'历史版本，只读'} · 版本 ${detail.versionId}\n${c.enabled?'启用':'停用'} · 向量${vectorStates[c.embedding_state]} · 正文修订 ${c.revision} / 向量修订 ${c.vector_revision} / 操作版本 ${c.row_version}\n最近人工操作：${actions[c.last_action]||c.last_action} · ${time(c.maintained_at)} · 最近更新 ${time(c.updated_at)}`));
    target.append(node('p',`${c.content_type} · ${c.char_length} Unicode 字符 · ${strategies[c.strategy]||c.strategy}`));
    const fields=node('dl',undefined,'parsing-source');for(const [key,value]of Object.entries(info.fields||{}))fields.append(node('dt',key),node('dd',value));target.append(fields,node('p',info.note),node('pre',c.content,'parsing-full-content'));
    const raw=node('details');raw.append(node('summary','完整来源元数据'),node('pre',JSON.stringify(c.source,null,2)));target.append(raw);
    const tools=node('div',undefined,'parsing-toolbar');tools.append(button('编辑正文',beginEdit,!detail.editable),button(c.enabled?'停用':'启用',()=>change(c,{enabled:!c.enabled}),!detail.editable));if(c.embedding_state==='failed')tools.append(button('重试向量更新',()=>change(c,{retry:true}),!detail.editable));const original=button('查看原文位置 ↗',()=>preview(c,item,original));tools.append(original);target.append(tools);
    if(c.error)target.append(node('p',`向量更新失败：${c.error}`,'parsing-error'));
    if(detail.task)target.append(node('p',`向量任务：${vectorStates[detail.task.status]||detail.task.status} · 提交 ${time(detail.task.created_at)} · 开始 ${time(detail.task.started_at)} · 完成 ${time(detail.task.finished_at)}`));
    const history=node('details'),summary=node('summary','此分块的操作记录（最近 30 条）');history.append(summary);if(!detail.audit.length)history.append(node('p','暂无人工维护记录。'));for(const event of detail.audit){history.append(node('p',`${time(event.created_at)} · ${actions[event.action]||event.action}`),node('pre',JSON.stringify(event.details,null,2)));}target.append(history);
  }
  function beginEdit(){
    if(guarded()||!detail?.editable)return;editing=true;conflicted=false;navigation();const c=detail.chunk,target=el('detail');target.querySelector('.parsing-full-content').hidden=true;target.querySelector('.parsing-toolbar').hidden=true;
    const editor=node('div',undefined,'parsing-editor'),label=node('label','编辑完整正文（1–16000 个 Unicode 字符）'),area=node('textarea');area.id='parsing-editor-content';area.value=c.content;area.setAttribute('aria-label',`分块 ${c.chunk_index+1} 正文`);label.append(area);const count=node('p');function countChars(){count.textContent=`${Array.from(area.value).length} / 16000 字符 · 保存后等待后台更新向量，完成前不参与检索。`;}area.oninput=countChars;countChars();
    const feedback=node('p');feedback.id='parsing-save-status';feedback.setAttribute('role','status');const tools=node('div',undefined,'parsing-toolbar');tools.append(button('保存并更新向量',()=>change(detail.chunk,{content:area.value},true)),button('取消编辑',()=>{if(saving)return;editing=false;conflicted=false;renderDetail();navigation();load();message('已取消编辑。');}));editor.append(label,count,tools,feedback);target.append(editor);area.focus();
  }
  async function change(c,body,fromEditor=false){
    if(saving||(!fromEditor&&guarded()))return;
    if(fromEditor&&(conflicted||!body.content.trim()||body.content.includes('\0')||Array.from(body.content).length>16000)){message(conflicted?'请先核对服务器内容，选择以最新修订继续或取消编辑。':'正文须为 1–16000 个 Unicode 字符，且不含 NUL 字符。');return;}
    const session=generation,v=versionId;const contentBody={revision:c.revision,rowVersion:c.row_version,...body};saving=true;navigation();el('detail').querySelectorAll('button').forEach(b=>b.disabled=true);el('chunks').querySelectorAll('button').forEach(b=>b.disabled=true);if(fromEditor)el('save-status').textContent='正在保存正文…';
    try{const result=await request(`/api/documents/${item.id}/chunks/${c.chunk_index}?version=${v}`,json('PATCH',contentBody));if(session!==generation)return;editing=false;conflicted=false;signature='';if(detail?.chunk.chunk_index===c.chunk_index)detail=null;pendingIndex=c.chunk_index;
      if(result.jobId)vectorWatch={versionId:v,index:c.chunk_index,jobId:result.jobId};
      message(result.embeddingState==='pending'?`${body.content!==undefined?'正文已保存':'已提交向量任务'}，向量等待后台更新；完成前该分块不参与检索。`:`${body.enabled===false?'已停用，检索立即排除':body.enabled===true?'已启用，仅向量有效且修订一致时参与检索':'操作已保存'}。维护仅作用于此文档的此版本。`);
    }catch(error){if(session!==generation)return;message(error.message);
      if(fromEditor){el('save-status').textContent=error.message;if(error.status===409){conflicted=true;await showConflict(c,session,v,error.code);}}
    }finally{saving=false;if(session===generation){navigation();signature='';if(!editing){if(detail)renderDetail();await load();}else el('detail').querySelectorAll('button').forEach(b=>b.disabled=false);}}
  }
  async function showConflict(c,session,v,code){
    const target=el('detail').querySelector('.parsing-editor');target.querySelector('.parsing-conflict')?.remove();const box=node('div',undefined,'parsing-conflict');box.append(node('p','保存冲突，草稿仍保留在编辑框中。请核对服务器正文及启用状态。','parsing-error'));target.append(box);
    try{const latest=await request(`/api/documents/${item.id}/chunks/${c.chunk_index}?version=${v}`);if(session!==generation)return;box.append(node('p',`服务器：正文修订 ${latest.chunk.revision} / 操作版本 ${latest.chunk.row_version} · ${latest.chunk.enabled?'启用':'停用'}${latest.editable?'':' · 此版本现为只读'}`),node('pre',latest.chunk.content));
      if(latest.editable&&code!=='version_changed')box.append(button('已核对，基于最新修订继续编辑',()=>{detail=latest;conflicted=false;box.remove();el('save-status').textContent='已采用最新修订号，草稿保留；再次保存将替换以上服务器正文。';}));
    }catch(error){box.append(node('p',`核对加载失败：${error.message}。草稿保留，请取消后重新加载。`));}
  }
  async function open(doc,from,options={}){
    if(!panel.hidden&&guarded())return false;
    retrievalControls.refresh(true);
    clearTimeout(queryTimer);generation++;item=doc;opener=from;versionId=options.versionId||null;pendingIndex=Number.isInteger(options.chunkIndex)?options.chunkIndex:null;page=pendingIndex===null?1:Math.floor(pendingIndex/20)+1;detail=null;current=null;vectorWatch=null;editing=saving=conflicted=false;signature='';
    if(panel.hidden){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';document.querySelectorAll('main').forEach(main=>main.inert=true);}panel.hidden=false;
    el('title').textContent=`解析与分块 · ${doc.filename}`;el('chunks').textContent='加载中…';el('detail').hidden=true;el('test-results').replaceChildren();el('search').value='';el('enabled').value=el('state').value='all';el('ack').checked=false;message('');el('close').focus();navigation();const session=generation;
    try{const [configs,models,bases]=await Promise.all([request('/api/parsing/configs'),request('/api/models'),request('/api/knowledge-bases')]);if(session!==generation)return false;
      presets=configs.configs;renderPresets();fill(configs.defaults);el('config-name').value=presets[0]?.name||'我的解析配置';const embedding=models.models.filter(m=>m.kind==='embedding');el('model').replaceChildren(...embedding.map(m=>new Option(m.name,m.id)));el('model').value=embedding.find(m=>m.active)?.id||embedding[0]?.id||'';
      el('engine').textContent=`本机解析器 ${configs.parserVersion} · 配置格式 v${configs.configVersion} · 单位 Unicode 字符`;el('test-kbs').replaceChildren(...bases.knowledgeBases.map(k=>new Option(k.name,k.id)));await load(true);return true;
    }catch(error){message(error.message);el('chunks').textContent='加载失败，请点击刷新重试。';return false;}
  }
  function close(){if(guarded())return;clearTimeout(queryTimer);panel.hidden=true;generation++;item=null;detail=null;document.body.style.overflow=previousOverflow;document.querySelectorAll('main').forEach(main=>main.inert=false);if(opener?.isConnected)opener.focus();window.dispatchEvent(new Event('parsing:changed'));}
  el('close').onclick=close;panel.addEventListener('click',event=>{if(event.target===panel)close();});
  el('jump').onclick=()=>el('chunk-heading').scrollIntoView({block:'start'});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden&&document.getElementById('document-preview')?.hidden)close();});
  window.addEventListener('beforeunload',event=>{if(editing||saving){event.preventDefault();event.returnValue='';}});
  el('preset').onchange=()=>{const p=presets.find(p=>p.id===el('preset').value);if(p){fill(p.config);el('config-name').value=p.name;}};
  form.onsubmit=async event=>{event.preventDefault();if(guarded())return;try{await saveConfig();message('配置已保存为不可变快照，应用时需要提交解析任务。');}catch(error){message(error.message);}};
  el('run').onclick=()=>submitParse(false);el('force').onclick=()=>submitParse(true);el('preview').onclick=()=>preview();
  el('refresh').onclick=()=>{if(guarded())return;if(!current){open(item,opener,{versionId});return;}signature='';load();};
  function changeView(reset=true){if(guarded())return;if(reset)page=1;detail=null;el('detail').hidden=true;signature='';load();}
  el('version').onchange=()=>{if(guarded())return;versionId=el('version').value;changeView();};el('enabled').onchange=el('state').onchange=()=>changeView();
  el('search').oninput=()=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>changeView(),250);};el('prev').onclick=()=>{if(guarded())return;page--;changeView(false);};el('next').onclick=()=>{if(guarded())return;page++;changeView(false);};
  el('test-scope').onchange=()=>{el('test-kb-label').hidden=el('test-scope').value!=='kb';};
  el('test-form').onsubmit=async event=>{event.preventDefault();const target=el('test-results'),submit=event.submitter||event.currentTarget.querySelector('button[type="submit"]'),session=generation;submit.disabled=true;target.textContent='正在召回、融合并按配置重排…';
    try{const body={query:el('test-query').value,...retrievalControls.read()};if(el('test-scope').value==='kb')body.knowledgeBaseIds=[...el('test-kbs').selectedOptions].map(o=>o.value);const result=await request(`/api/documents/${item.id}/retrieval-test`,json('POST',body));if(session!==generation)return;target.replaceChildren();window.RetrievalUI.renderSources(target,result);
    }catch(error){if(session===generation)window.RetrievalUI.renderError(target,error);}finally{submit.disabled=false;}
  };
  setInterval(()=>{if(!panel.hidden&&item&&!saving)load();},3000);
  window.openParsingDetails=open;window.parsingStageLabel=(stage,progress)=>`${stages[stage]||stage}${progress!==undefined?' '+progress+'%':''}`;
})();
