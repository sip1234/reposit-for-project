(() => {
  const names={keyword:'仅关键词',vector:'仅向量',hybrid:'混合检索'};
  let counter=0;
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=node('button',text,'subtle-button');b.type='button';b.onclick=fn;return b;};
  async function request(url,options){const r=await fetch(url,{cache:'no-store',...options});const d=await r.json();if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;}
  const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function createControls(host,{diagnostics=false}={}){
    const id=`retrieval-${++counter}`;let presets=[],baseline,defaults,systemDefaultId,loading=true;
    host.classList.add('retrieval-controls');
    host.innerHTML=`<div class="retrieval-control-grid"><label>检索配置<select data-preset aria-label="${id} 已保存检索配置"></select></label><label>检索模式<select data-field="mode"><option value="keyword">仅关键词</option><option value="vector">仅向量</option><option value="hybrid">混合检索</option></select></label><label class="retrieval-check"><input data-field="rerankEnabled" type="checkbox">启用独立重排</label><label>重排模型<select data-field="rerankerModelId"><option value="">未配置</option></select></label></div>
      <p data-origin>正在加载检索配置…</p><details><summary>候选、融合、资源上限与保存配置</summary><div data-advanced class="retrieval-control-grid"></div>
      <label>配置名称<input data-name maxlength="80" value="我的检索配置"></label><div class="retrieval-actions"><button data-save type="button" class="subtle-button">保存为配置快照</button><button data-default type="button" class="subtle-button">将所选配置设为系统默认</button></div><p>优先级：本次参数覆盖 → 所选保存配置 → 系统默认。保存配置不自动切换系统默认；已有检索记录保留实际快照。关键词为中文字符词项／英文编号匹配，无自动同义词和拼写纠错。</p></details>
      <label class="retrieval-check"><input data-debug type="checkbox" ${diagnostics?'checked':''}>请求本次详细诊断（候选、各路分数、过滤与耗时）</label><p data-message role="status"></p>`;
    const find=s=>host.querySelector(s),advanced=find('[data-advanced]');
    const numeric={keywordCandidates:['关键词候选',1,100],vectorCandidates:['每模型向量候选',1,50],fusionCandidates:['融合候选上限',1,200],rrfK:['RRF k',1,200],keywordWeight:['关键词总权重',0,5,'any'],vectorWeight:['向量总权重',0,5,'any'],minVectorSimilarity:['向量最低余弦',-1,1,'any'],
      rerankCandidates:['重排候选',1,40],rerankTextChars:['每块重排字符上限',100,8000],rerankMaxTokens:['每对重排 token 上限',64,512],rerankBatchSize:['重排批大小',1,8],rerankTimeoutMs:['重排时限 ms',100,60000],finalCount:['最终资料数量',1,20],maxPerDocument:['每文件最多资料数',1,20],contextChars:['上下文字符预算',500,40000],timeoutMs:['检索总时限 ms',500,120000],overlapThreshold:['近似去重 Jaccard 阈值',0.8,1,'any']};
    for(const [key,[label,min,max,step=1]]of Object.entries(numeric)){const l=node('label',label),input=node('input');input.type='number';input.min=min;input.max=max;input.step=step;input.required=true;input.dataset.field=key;l.append(input);advanced.append(l);}
    const threshold=node('label','重排最低 logit（留空不筛分；非概率）'),thresholdInput=node('input');thresholdInput.type='number';thresholdInput.min=-1000000;thresholdInput.max=1000000;thresholdInput.step='any';thresholdInput.dataset.field='rerankMinScore';threshold.append(thresholdInput);advanced.append(threshold);
    for(const [key,label,options]of [['fusion','融合方式',[['rrf','RRF 排名融合']]],['failurePolicy','失败处理',[['fallback','降级并显示原因'],['error','返回明确错误']]],['dedup','内容去重',[['none','仅候选身份去重'],['exact','规范化完全相同'],['overlap','完全相同及高度重叠']]]]){const l=node('label',label),select=node('select');select.dataset.field=key;select.append(...options.map(([value,text])=>new Option(text,value)));l.append(select);advanced.append(l);}
    function fill(config){baseline={...defaults,...config};for(const input of host.querySelectorAll('[data-field]')){const v=baseline[input.dataset.field];if(input.type==='checkbox')input.checked=v;else input.value=v??'';}origin();}
    function config(){if(loading||!baseline)throw new Error('检索配置尚未加载，请稍后或重试加载。');const c={...baseline};for(const input of host.querySelectorAll('[data-field]')){if(!input.checkValidity())throw new Error(`${input.closest('label').firstChild.textContent} 参数无效`);c[input.dataset.field]=input.type==='checkbox'?input.checked:input.type==='number'?(input.dataset.field==='rerankMinScore'&&!input.value?null:Number(input.value)):input.value||null;}if(c.keywordWeight<=0||c.vectorWeight<=0)throw new Error('融合权重必须大于零。');if(c.rerankEnabled&&!c.rerankerModelId)throw new Error('启用重排时请先选择独立重排模型。');if(c.rerankEnabled&&c.rerankCandidates<c.finalCount)throw new Error('重排候选不能少于最终数量。');if(c.finalCount>c.fusionCandidates||c.rerankEnabled&&c.rerankCandidates>c.fusionCandidates)throw new Error('请核对融合候选、重排候选及最终数量的上限。');return c;}
    function origin(){if(!baseline)return;let changed=false,invalid=false;try{changed=JSON.stringify(config())!==JSON.stringify(baseline);}catch{invalid=true;}find('[data-origin]').textContent=`${find('[data-preset]').value?'已选择保存配置':'使用系统默认'}${invalid?'；本次参数尚未通过校验':changed?'；当前表单有本次覆盖参数':'；当前参数与所选配置一致'}。重排${find('[data-field="rerankEnabled"]').checked?'已启用，问题和候选仅发送至本地重排服务':'未启用'}。`;}
    async function refresh(keep=false){
      loading=true;find('[data-save]').disabled=true;find('[data-default]').disabled=true;
      const old=find('[data-preset]').value;
      try{const [data,modelData]=await Promise.all([request('/api/retrieval/configs'),request('/api/models')]);presets=data.configs;defaults=data.defaults;systemDefaultId=data.systemDefaultId;
        const preset=find('[data-preset]');preset.replaceChildren(new Option('系统默认（按当前服务器设置）',''),...presets.map(p=>new Option(`${p.name} · ${p.id.slice(0,8)}`,p.id)));
        const model=find('[data-field="rerankerModelId"]');model.replaceChildren(new Option('未配置'),...modelData.models.filter(m=>m.kind==='reranker').map(m=>new Option(`${m.name} · 本地`,m.id)));model.options[0].value='';
        if(keep&&presets.some(p=>p.id===old))preset.value=old;loading=false;fill(presets.find(p=>p.id===(preset.value||systemDefaultId))?.config||defaults);find('[data-message]').textContent='';
      }catch(e){find('[data-message]').replaceChildren(node('span',`检索配置加载失败：${e.message} `),button('重试加载',()=>refresh(keep)));}
      finally{find('[data-save]').disabled=find('[data-default]').disabled=loading;}
    }
    host.addEventListener('input',origin);find('[data-preset]').onchange=()=>{const p=presets.find(p=>p.id===(find('[data-preset]').value||systemDefaultId));if(p){fill(p.config);find('[data-name]').value=p.name;}};
    find('[data-save]').onclick=async()=>{const b=find('[data-save]');b.disabled=true;try{const c=config(),saved=await request('/api/retrieval/configs',json({name:find('[data-name]').value,config:c}));await refresh();find('[data-preset]').value=saved.id;fill(saved.config);find('[data-message]').textContent='配置快照已保存，当前页面使用此配置；系统默认未自动改变。';}catch(e){find('[data-message]').textContent=e.message;}finally{b.disabled=false;}};
    find('[data-default]').onclick=async()=>{try{if(!find('[data-preset]').value)throw new Error('请先选择已保存的配置快照。');await request('/api/retrieval/default',json({configId:find('[data-preset]').value}));await refresh();find('[data-message]').textContent='已切换系统检索默认值，历史检索快照不变。';}catch(e){find('[data-message]').textContent=e.message;}};
    refresh();
    return {refresh,read(){const c=config(),body={diagnostics:find('[data-debug]').checked};if(find('[data-preset]').value)body.retrievalConfigId=find('[data-preset]').value;if(JSON.stringify(c)!==JSON.stringify(baseline))body.retrievalConfig=c;return body;}};
  }
  function renderSummary(target,retrieval){
    if(!retrieval)return;const box=node('section',undefined,'retrieval-summary');const state={disabled:'未启用',complete:'已完成',failed_fallback:'失败，已降级为融合排序',failed:'失败',skipped_empty:'无候选，未运行',waiting:'等待中'}[retrieval.rerank?.status]||'未知';
    box.append(node('p',`${names[retrieval.config?.mode]||''} · 重排：${state} · 实际配置 ${retrieval.configId} · ${retrieval.origin||''} · 最终 ${retrieval.finalCount??0} 条 · ${retrieval.timings?.total??0} ms`));
    if(retrieval.rerank?.model)box.append(node('p',`实际重排模型：${retrieval.rerank.model.name} · ${retrieval.rerank.model.identifier||retrieval.rerank.model.model_name} · ${retrieval.rerank.model.revision||retrieval.rerank.model.resource_revision}`));
    for(const w of retrieval.warnings||[])box.append(node('p',`${retrieval.degraded?'已降级':'资料校验提示'} · ${w.stage}：${w.reason}`,'retrieval-warning'));
    box.append(node('p','RRF 为排名融合分数；余弦只比较同一模型的召回；重排为交叉编码器原始 logit，均不表示相关概率。'));
    const details=node('details');details.append(node('summary','配置快照、候选排名与阶段诊断'));details.append(node('pre',JSON.stringify(retrieval.diagnostics||{config:retrieval.config,note:'本次未请求候选诊断，可勾选详细诊断后重新检索。'},null,2)));
    const record=node('div');if(retrieval.runId)details.append(button('查看已保存的检索记录',async()=>{try{record.replaceChildren(node('pre',JSON.stringify(await request(`/api/retrieval/runs/${retrieval.runId}`),null,2)));}catch(e){record.textContent=e.message;}}));details.append(record);box.append(details);target.append(box);
  }
  function renderSources(target,data){
    renderSummary(target,data.retrieval);target.append(node('h3',`最终资料 · ${data.sources?.length||0}`));
    if(!data.sources?.length)target.append(node('p','所选范围没有符合条件的资料。请检查问题、阈值、维护状态或解析进度。'));
    for(const s of data.sources||[]){const card=node('article',undefined,'knowledge-source parsing-chunk'),title=node('div',undefined,'knowledge-source-title');
      const info=window.describeDocumentSource?.({id:s.documentId,filename:s.filename,extension:s.extension,source:s.source,sectionPath:s.sectionPath});
      title.append(node('strong',`[${s.number}] ${s.filename} · 分块 #${s.chunkIndex+1}${s.modified?' · 人工修订，可能与原件不同':''}`));
      title.append(button('查看原件 ↗',()=>window.openDocumentPreview?.({id:s.documentId,filename:s.filename,extension:s.extension,source:s.source,sectionPath:s.sectionPath})),button('查看分块',()=>window.openParsingDetails?.({id:s.documentId,filename:s.filename,extension:s.extension},null,{versionId:s.versionId,chunkIndex:s.chunkIndex})));
      card.append(title,node('p',`${info?.label||s.locator||'未记录'} · 版本 ${s.versionId} · 正文修订 ${s.revision}${s.knowledgeBaseName?' · 知识库：'+s.knowledgeBaseName:''}`),node('pre',s.excerpt));
      if(s.contextTruncated)card.append(node('p',`上下文已按字符预算裁剪，原分块 ${s.originalChars} 字符；查看分块可见完整正文。`));
      const score=node('details');score.append(node('summary','排序依据与原始分数'),node('p',`RRF 融合 #${s.fusionRank}：${Number(s.fusionScore).toPrecision(6)}${s.rerankScore!==null&&s.rerankScore!==undefined?` · 重排 #${s.rerankRank}，logit ${Number(s.rerankScore).toFixed(4)}`:' · 无重排分数'}\n关键词：${s.keywordRank?`#${s.keywordRank}，覆盖分 ${Number(s.keywordScore).toFixed(4)}`:'未召回'}\n向量模型：${s.embeddingModel?.name||'未记录'} · ${s.vectorRank?`#${s.vectorRank}，余弦 ${Number(s.cosine).toFixed(4)}`:'本结果未由向量路召回'}`));card.append(score);
      if(s.alternateSources?.length){const alt=node('details');alt.append(node('summary',`同内容或高度重叠的其他来源（${s.alternateSources.length}）`));for(const a of s.alternateSources){const row=node('div',undefined,'retrieval-actions');row.append(node('span',`${a.filename} · #${a.chunkIndex+1} · 修订 ${a.revision}`),button('查看对应分块',()=>window.openParsingDetails?.({id:a.documentId,filename:a.filename},null,{versionId:a.versionId,chunkIndex:a.chunkIndex})),button('预览对应原件',()=>window.openDocumentPreview?.({id:a.documentId,filename:a.filename,extension:a.extension,source:a.source,sectionPath:a.sectionPath})));alt.append(row);}card.append(alt);}target.append(card);
    }
  }
  function renderError(target,error){target.replaceChildren(node('p',error.message,'retrieval-warning'));if(error.retrieval)renderSummary(target,error.retrieval);}
  window.RetrievalUI={createControls,renderSummary,renderSources,renderError};
})();
