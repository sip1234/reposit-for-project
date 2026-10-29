// Real PostgreSQL + worker + local Ollama integration. Never reads keys or calls an online LLM.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const api=process.env.TEST_API||'http://localhost:3000',stamp=Date.now(),alias=`chunk-maintenance-test:${stamp}`;
let originalModel,modelId,baseId,paused=false,aliasRemoved=false;
const checks=[],documents=[];
const docker=(...args)=>execFileSync('docker',['compose',...args],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',timeout:120000}).trim();
async function req(path,method='GET',body){const r=await fetch(api+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});return {...await r.json(),http:r.status};}
const patch=(doc,v,c,body)=>req(`/api/documents/${doc}/chunks/${c.chunk_index}?version=${v}`,'PATCH',{revision:c.revision,rowVersion:c.row_version,...body});
const chunk=async(doc,v,index=0)=>(await req(`/api/documents/${doc}/chunks/${index}?version=${v}`));
async function wait(fn,test,label){for(let i=0;i<150;i++){const x=await fn();if(test(x))return x;await new Promise(r=>setTimeout(r,500));}throw new Error(`Timeout: ${label}`);}
async function upload(name,text){const bytes=Buffer.from(text),tus='http://localhost:1080/files/';const r=await fetch(tus,{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(bytes.length),'Upload-Metadata':`filename ${Buffer.from(name).toString('base64')}`}});assert.equal(r.status,201);const url=new URL(r.headers.get('location'),tus).href,id=url.split('/').pop();assert.equal((await fetch(url,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':'0','Content-Type':'application/offset+octet-stream'},body:bytes})).status,204);await wait(()=>req('/api/documents'),x=>x.documents.some(d=>d.id===id&&d.status==='ready'),'upload');documents.push({id,name});return id;}
async function parse(doc,body){const p=await req(`/api/documents/${doc}/parse`,'POST',{modelId,...body});assert.equal(p.http,202,JSON.stringify(p));return p;}
async function ready(doc,id){return wait(()=>req(`/api/documents/${doc}/parsing?version=${id}`),x=>x.version?.status==='ready','parse ready');}
async function search(doc,query,knowledgeBaseIds){const r=await req(`/api/documents/${doc}/retrieval-test`,'POST',{query,...knowledgeBaseIds&&{knowledgeBaseIds}});assert.equal(r.http,200,JSON.stringify(r));return r;}
function check(name){checks.push(name);console.log(`PASS ${name}`);}
async function run(){
  originalModel=(await req('/api/models')).models.find(m=>m.kind==='embedding'&&m.active);assert(originalModel?.provider==='ollama');
  docker('exec','-T','ollama','ollama','cp',originalModel.modelName,alias);
  const model=await req('/api/models','POST',{name:`分块维护验证-${stamp}`,provider:'ollama',kind:'embedding',modelName:alias});assert.equal(model.http,201,JSON.stringify(model));modelId=model.id;
  const defaults=(await req('/api/parsing/configs')).defaults;
  const config=await req('/api/parsing/configs','POST',{name:`分块维护配置-${stamp}`,config:{...defaults,targetLength:120,maxLength:180,overlapLength:20,sectionContext:false}});assert.equal(config.http,201);
  const content=Array.from({length:65},(_,i)=>`第${i+1}条记录：曝气系统的溶解氧控制需要结合温度与负荷进行调整，定期核对仪表和工艺运行记录。`).join('\n\n');
  const a=await upload(`分块维护验证-A-${stamp}.txt`,content),b=await upload(`分块维护验证-B-${stamp}.txt`,content);
  const av=await parse(a,{configId:config.id,force:true}),bv=await parse(b,{configId:config.id});assert.equal(av.jobId,bv.jobId);await ready(a,av.versionId);await ready(b,bv.versionId);
  let list=await req(`/api/documents/${a}/chunks`);assert(list.total>20);assert.equal(list.chunks.length,20);assert.equal(list.stats.total,list.total);assert.equal(list.stats.retrievable,list.total);
  const page2=await req(`/api/documents/${a}/chunks?page=2`);assert.equal(page2.chunks[0].chunk_index,20);
  assert.equal((await req(`/api/documents/${a}/chunks?q=不存在的测试正文`)).total,0);
  let d=await chunk(a,av.versionId);assert.equal(d.chunk.content,list.chunks[0].content);assert(d.chunk.source.line_start>0);assert(d.editable);check('list / search / pagination / full body / stats / recorded source');
  for(const suffix of ['?enabled=invalid','?state=invalid','?page=0','?q='+encodeURIComponent('长'.repeat(201))])assert.equal((await req(`/api/documents/${a}/chunks${suffix}`)).http,400);
  assert.equal((await chunk(b,av.versionId)).http,404);assert.equal((await chunk(a,av.versionId,99999)).http,404);
  for(const body of [{content:''},{content:'x'.repeat(16001)},{content:42},{enabled:'true'},{retry:'true'},{unknown:true}])assert.equal((await patch(a,av.versionId,d.chunk,body)).http,400);
  assert.equal((await req(`/api/documents/${a}/chunks/0`,'PATCH',{revision:0,content:'missing operation version'})).http,400);check('input validation / document-version-chunk ownership');
  // Keep the real worker paused briefly to inspect the pending state and stale-vector exclusion deterministically.
  docker('pause','indexer');paused=true;
  const edited=`人工修订 ${stamp}：碳源投加阈值为零点四二，核对新正文与向量一致。\n\n保持段落换行。`;
  const old=d.chunk;assert.equal((await patch(a,av.versionId,old,{content:edited})).http,202);
  d=await chunk(a,av.versionId);assert.equal(d.chunk.embedding_state,'pending');assert.equal(d.chunk.revision,1);assert.equal(d.chunk.vector_revision,0);assert.equal(d.task.status,'pending');
  const pending=await req(`/api/documents/${a}/chunks?state=pending`);assert.equal(pending.total,1);assert.equal(pending.stats.pending,1);
  assert(!(await search(a,edited)).results.flatMap(g=>g.chunks).some(c=>c.chunk_index===0));
  assert.equal((await patch(a,av.versionId,old,{content:'过期页面'})).http,409);
  // Two retries of the same body produce different task tokens. Only the latest may publish.
  const retry1=await patch(a,av.versionId,d.chunk,{retry:true});assert.equal(retry1.http,202);let newer=await chunk(a,av.versionId);
  assert.equal((await patch(a,av.versionId,d.chunk,{retry:true})).http,409);
  const retry2=await patch(a,av.versionId,newer.chunk,{retry:true});assert.equal(retry2.http,202);assert.notEqual(retry1.jobId,retry2.jobId);
  docker('unpause','indexer');paused=false;
  d=await wait(()=>chunk(a,av.versionId),x=>x.chunk.embedding_state==='ready','edit ready');assert.equal(d.chunk.vector_revision,1);assert.equal(d.chunk.embedding_job_id,retry2.jobId);assert(d.task.started_at);assert(d.audit.some(e=>e.action==='embedding_started'));assert(d.audit.some(e=>e.action==='embedding_complete'));
  assert((await search(a,edited)).results.flatMap(g=>g.chunks).some(c=>c.chunk_index===0&&c.content===edited));check('real vector update / pending exclusion / task progress / stale task tokens / edit conflicts');
  assert.equal((await chunk(b,bv.versionId)).chunk.content,old.content);
  const c=await upload(`分块维护验证-C-${stamp}.txt`,content),cv=await parse(c,{configId:config.id});await ready(c,cv.versionId);assert.equal(cv.jobId,av.jobId);assert.equal((await chunk(c,cv.versionId)).chunk.content,old.content);check('shared cache immutable / document edit isolation');
  const staleToggle=d.chunk;assert.equal((await patch(a,av.versionId,d.chunk,{enabled:false})).http,202);d=await chunk(a,av.versionId);
  assert.equal(d.chunk.revision,staleToggle.revision);assert.equal(d.chunk.row_version,staleToggle.row_version+1);
  assert.equal((await patch(a,av.versionId,staleToggle,{enabled:true})).http,409);
  assert.equal((await req(`/api/documents/${a}/chunks?enabled=disabled`)).total,1);assert(!(await search(a,edited)).results.flatMap(g=>g.chunks).some(x=>x.chunk_index===0));
  assert.equal((await patch(a,av.versionId,d.chunk,{enabled:true})).http,202);d=await chunk(a,av.versionId);assert((await search(a,edited)).results.flatMap(g=>g.chunks).some(x=>x.chunk_index===0));check('disable / re-enable / toggle concurrency');
  // Remove only the disposable local alias. Worker sees a real Ollama 404; original model stays available.
  docker('exec','-T','ollama','ollama','rm',alias);aliasRemoved=true;
  assert.equal((await patch(a,av.versionId,d.chunk,{content:'向量失败验证：这里是新的正文，旧向量绝不能参与检索。'})).http,202);
  d=await wait(()=>chunk(a,av.versionId),x=>x.chunk.embedding_state==='failed','real model failure');assert.match(d.chunk.error,/404|not found/i);assert.equal(d.chunk.revision,2);assert.equal(d.chunk.vector_revision,1);assert(d.audit.some(e=>e.action==='embedding_failed'));
  assert.equal((await req(`/api/documents/${a}/chunks?state=failed`)).total,1);
  docker('exec','-T','ollama','ollama','cp',originalModel.modelName,alias);aliasRemoved=false;
  assert(!(await search(a,d.chunk.content)).results.flatMap(g=>g.chunks).some(x=>x.chunk_index===0));
  assert.equal((await patch(a,av.versionId,d.chunk,{enabled:false})).http,202);d=await chunk(a,av.versionId);assert.equal((await patch(a,av.versionId,d.chunk,{enabled:true})).http,202);d=await chunk(a,av.versionId);
  assert(!(await search(a,d.chunk.content)).results.flatMap(g=>g.chunks).some(x=>x.chunk_index===0),'enabling failed vector must not make it retrievable');
  assert.equal((await patch(a,av.versionId,d.chunk,{retry:true})).http,202);d=await wait(()=>chunk(a,av.versionId),x=>x.chunk.embedding_state==='ready','retry ready');assert.equal(d.chunk.vector_revision,2);assert.equal(d.chunk.error,null);assert((await search(a,d.chunk.content)).results.flatMap(g=>g.chunks).some(x=>x.chunk_index===0));check('real failure reason / failed-vector exclusion / retry recovery / invalid re-enable exclusion');
  // A separate actual model id forms a separate score group, even when using the same base weights.
  const other=await parse(c,{modelId:originalModel.id,configId:config.id});await ready(c,other.versionId);
  const base=await req('/api/knowledge-bases','POST',{name:`分块维护验证库-${stamp}`,documentIds:[a,c]});assert.equal(base.http,201);baseId=base.id;
  const grouped=await search(a,d.chunk.content,[baseId]);assert.equal(grouped.results.length,2);assert(grouped.results.every(g=>g.chunks.every(x=>x.version_id&&x.source)));
  const normal=await req('/api/knowledge/query','POST',{query:d.chunk.content,mode:'search',knowledgeBaseIds:[baseId]});assert.equal(normal.http,200);assert(normal.sources.some(x=>x.documentId===a&&x.versionId===av.versionId));check('file / knowledge-base retrieval grouped by model / exact chunk-version links');
  const ack=await req(`/api/documents/${a}/parse`,'POST',{modelId,configId:config.id});assert.equal(ack.http,409);assert.equal(ack.code,'reparse_requires_ack');
  const bad=await req('/api/parsing/configs','POST',{name:`失败配置-${stamp}`,config:{...defaults,strategy:'qa',targetLength:100,maxLength:120,overlapLength:0}});
  // Ordinary paragraph fixture does not fail QA fallback. Use a strict very long QA source on its own document instead below.
  const reparsed=await parse(a,{configId:config.id,acknowledgeEdits:true});await ready(a,reparsed.versionId);assert.equal((await chunk(a,reparsed.versionId)).chunk.content,old.content);assert((await chunk(a,reparsed.versionId)).chunk.enabled);
  assert.equal((await patch(a,av.versionId,d.chunk,{enabled:false})).http,409);assert.equal((await chunk(a,av.versionId)).editable,false);check('reparse acknowledgment / edits not inherited / historical readonly');
  const qa=await upload(`分块维护验证-失败恢复-${stamp}.txt`,'Q: 运行条件是什么？\nA: '+'需要核对温度负荷和仪表记录。'.repeat(80));const qaReady=await parse(qa,{configId:config.id});await ready(qa,qaReady.versionId);
  const fail=await parse(qa,{configId:bad.id});await wait(()=>req(`/api/documents/${qa}/parsing?version=${fail.versionId}`),x=>x.version?.status==='failed','parse failed');assert.equal((await req(`/api/documents/${qa}/parsing`)).document.active_parse_version_id,qaReady.versionId);check('successful atomic version switch / failed reparse preserves active');
  const preview=await req(`/api/documents/${a}/preview`);assert.equal(preview.http,200);assert.equal(preview.kind,'text');const raw=await fetch(api+preview.url);assert.equal(raw.status,200);assert.equal(await raw.text(),content);check('original text preview remains unchanged after manual edits');
  const report={result:'PASS',checks,documents,model:{id:modelId,alias},versionId:reparsed.versionId,retainedHistoryVersion:av.versionId};fs.mkdirSync('artifacts/chunks',{recursive:true});fs.writeFileSync('artifacts/chunks/integration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(paused)docker('unpause','indexer');if(aliasRemoved&&originalModel)docker('exec','-T','ollama','ollama','cp',originalModel.modelName,alias);if(baseId)await req(`/api/knowledge-bases/${baseId}`,'DELETE');});
