// Uses only the local embedding model. Does not call an online LLM or read API keys.
const assert = require('node:assert/strict');
const api = process.env.TEST_API || 'http://localhost:3000';
const stamp = Date.now();
let baseId;
const created = [];
async function req(path,method='GET',body) {
  const response=await fetch(api+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json(); return {...data,status:response.status};
}
async function upload(text,name) {
  const bytes=Buffer.from(text);const tus='http://localhost:1080/files/';
  const res=await fetch(tus,{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(bytes.length),'Upload-Metadata':`filename ${Buffer.from(name).toString('base64')}`}});
  assert.equal(res.status,201,await res.text());const url=new URL(res.headers.get('location'),tus).href,id=url.split('/').pop();
  const patch=await fetch(url,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':'0','Content-Type':'application/offset+octet-stream'},body:bytes});assert.equal(patch.status,204);
  for(let i=0;i<50;i++){const list=await req('/api/documents');if(list.documents.some(x=>x.id===id&&x.status==='ready')){created.push({id,name});return id;}await new Promise(r=>setTimeout(r,200));}
  throw new Error('upload finalization timeout');
}
async function waitVersion(doc,id,status='ready') {
  for(let i=0;i<150;i++){const d=await req(`/api/documents/${doc}/parsing?version=${id}`);if(d.version?.status===status)return d;
    if(d.version?.status==='failed'&&status!=='failed')throw new Error(d.version.error);await new Promise(r=>setTimeout(r,1000));}
  throw new Error(`version ${id} timeout`);
}
async function run(){
  const configData=await req('/api/parsing/configs');assert.equal(configData.status,200);
  const bad=await req('/api/parsing/configs','POST',{name:'invalid',config:{targetLength:200,maxLength:100}});assert.equal(bad.status,400);
  const model=(await req('/api/models')).models.find(x=>x.kind==='embedding'&&x.active);assert(model);
  const config={...configData.defaults,targetLength:140,maxLength:220,overlapLength:30,sectionContext:false};
  const saved=await req('/api/parsing/configs','POST',{name:`验证配置-${stamp}`,config});assert.equal(saved.status,201);
  const content='Q: 生化池如何控制溶解氧？\nA: '+('生化池通过曝气调节溶解氧，运行范围参考工艺规程。 '.repeat(110));
  const a=await upload(content,`解析模块验证-A-${stamp}.txt`),b=await upload(content,`解析模块验证-B-${stamp}.txt`);
  const first=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:saved.id,force:true});assert.equal(first.status,202);
  const second=await req(`/api/documents/${b}/parse`,'POST',{modelId:model.id,configId:saved.id});assert.equal(second.jobId,first.jobId);assert(second.reused);
  const av=await waitVersion(a,first.versionId);assert.equal(av.document.active_parse_version_id,first.versionId);await waitVersion(b,second.versionId);
  let chunks=await req(`/api/documents/${a}/chunks`);assert(chunks.chunks.length>1);const original=chunks.chunks[0];
  assert(chunks.total>20);assert.equal(chunks.chunks.length,20);const nextPage=await req(`/api/documents/${a}/chunks?page=2`);assert.equal(nextPage.chunks[0].chunk_index,20);
  assert.equal((await req(`/api/documents/${a}/chunks?q=不存在的分块标记`)).total,0);
  const edited='独立修改验证：此段只属于文件 A，溶解氧建议结合运行数据核对。';
  const patch=await req(`/api/documents/${a}/chunks/0?version=${first.versionId}`,'PATCH',{revision:original.revision,rowVersion:original.row_version,content:edited});assert.equal(patch.status,202);
  let updated;
  for(let i=0;i<100;i++){updated=(await req(`/api/documents/${a}/chunks`)).chunks[0];if(updated.embedding_state==='ready'&&updated.revision===1)break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(updated.content,edited);assert.equal(updated.embedding_state,'ready');
  const bChunks=await req(`/api/documents/${b}/chunks`);assert.equal(bChunks.chunks[0].content,original.content);
  assert.equal((await req(`/api/documents/${a}/chunks/0?version=${first.versionId}`,'PATCH',{revision:0,rowVersion:0,content:'过期编辑'})).status,409);
  const c=await upload(content,`解析模块验证-C-${stamp}.txt`);const third=await req(`/api/documents/${c}/parse`,'POST',{modelId:model.id,configId:saved.id});await waitVersion(c,third.versionId);
  assert.equal((await req(`/api/documents/${c}/chunks`)).chunks[0].content,original.content,'editing must not poison shared cache');
  await req(`/api/documents/${a}/chunks/0?version=${first.versionId}`,'PATCH',{revision:1,rowVersion:updated.row_version,enabled:false});
  const search=await req(`/api/documents/${a}/retrieval-test`,'POST',{query:'溶解氧控制'});assert.equal(search.status,200);assert(!search.results.flatMap(x=>x.chunks).some(x=>x.chunk_index===0));
  const base=await req('/api/knowledge-bases','POST',{name:`解析验证知识库-${stamp}`,description:'自动验证，结束后删除',documentIds:[a,b]});baseId=base.id;
  const scoped=await req(`/api/documents/${a}/retrieval-test`,'POST',{query:'溶解氧',knowledgeBaseIds:[baseId]});assert.equal(scoped.status,200);assert(scoped.results.flatMap(x=>x.chunks).some(x=>x.document_id===b));
  const unparsed=await upload('此文件尚未解析，仅用于验证知识库检索入口。',`解析模块验证-未解析-${stamp}.txt`);
  assert.equal((await req(`/api/documents/${unparsed}/retrieval-test`,'POST',{query:'溶解氧',knowledgeBaseIds:[baseId]})).status,200);
  assert.equal((await req(`/api/documents/${unparsed}/retrieval-test`,'POST',{query:'溶解氧'})).status,409);
  const failedConfig=await req('/api/parsing/configs','POST',{name:`问答上限验证-${stamp}`,config:{...config,strategy:'qa',targetLength:100,maxLength:120,overlapLength:0}});
  const failure=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:failedConfig.id,acknowledgeEdits:true});assert(failure.activePreserved);
  const failed=await waitVersion(a,failure.versionId,'failed');assert.equal(failed.document.active_parse_version_id,first.versionId);assert.match(failed.version.error,/超过最大长度/);
  const fallback=await req('/api/knowledge/query','POST',{query:'溶解氧',mode:'search',knowledgeBaseIds:[baseId]});assert.equal(fallback.status,200);assert(fallback.sources.length);
  const recovery=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:saved.id,force:true,acknowledgeEdits:true});assert.notEqual(recovery.jobId,first.jobId);await waitVersion(a,recovery.versionId);
  const changedConfig=await req('/api/parsing/configs','POST',{name:`长分块验证-${stamp}`,config:{...config,targetLength:240,maxLength:360,overlapLength:40}});
  const newConfigRun=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:changedConfig.id});assert.notEqual(newConfigRun.jobId,recovery.jobId);const last=await waitVersion(a,newConfigRun.versionId);assert.equal(last.version.config_id,changedConfig.id);
  const olderPending=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:saved.id,force:true});
  const newestCached=await req(`/api/documents/${a}/parse`,'POST',{modelId:model.id,configId:changedConfig.id});assert(newestCached.reused);
  await waitVersion(a,newestCached.versionId);await waitVersion(a,olderPending.versionId);
  assert.equal((await req(`/api/documents/${a}/parsing`)).document.active_parse_version_id,newestCached.versionId,'an older job finishing later must not replace the newest request');
  assert.equal((await req(`/api/documents/${b}/chunks?version=${first.versionId}`)).status,404,'cross-document version access denied');
  assert.equal((await req(`/api/documents/${a}/chunks/0?version=${first.versionId}`,'PATCH',{revision:1,rowVersion:0,enabled:true})).status,409,'historical versions readonly');
  console.log(JSON.stringify({result:'PASS',checks:['config validation','upload+extract+chunk+embed','in-flight cache reuse','pagination','chunk search','edit isolation','cache remains immutable','optimistic revision','disabled retrieval','knowledge-base retrieval','knowledge-base test from unparsed file','failed reparse preserves active','recovery','force reparse','config cache invalidation','newest request wins','cross-document access','historical readonly'],documents:created},null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(baseId)await req(`/api/knowledge-bases/${baseId}`,'DELETE');});
