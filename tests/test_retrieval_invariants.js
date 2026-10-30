// Run inside an isolated API container. Fault injection is confined to this test process and tagged fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const {Pool}=require('pg'),retrieval=require('../server/retrieval'),models=require('../server/models'),knowledge=require('../server/knowledge');
const evaluation=JSON.parse(fs.readFileSync('/app/artifacts/retrieval/evaluation.json','utf8'));
const pool=new Pool({connectionString:process.env.DATABASE_URL}),doc=evaluation.documents.pump;
const scope={documentIds:[doc.id]},checks=[],report={checks};
let original,originalActive,server,originalFetch=global.fetch,originalEmbed=models.embed,originalChat=models.chat,originalRerankerUrl=models.rerankerUrl;
const config={mode:'hybrid',minVectorSimilarity:-1,rerankEnabled:true,rerankerModelId:evaluation.rerankerId,timeoutMs:60000,rerankTimeoutMs:30000};
const check=name=>{checks.push(name);console.log('PASS '+name);};
const run=(c={},s=scope)=>retrieval.run(pool,'P-101 42.8 提升泵',s,{retrievalConfig:{...config,...c},diagnostics:true});
async function restore(){if(!original)return;await pool.query(`UPDATE parsing_version_chunks SET enabled=$3,embedding_state=$4,revision=$5,vector_revision=$6,
 row_version=$7,content=$8,embedding=$9::vector,error=$10 WHERE version_id=$1 AND chunk_index=$2`,
 [original.version_id,original.chunk_index,original.enabled,original.embedding_state,original.revision,original.vector_revision,original.row_version,original.content,original.embedding,original.error]);await pool.query('UPDATE documents SET active_parse_version_id=$2 WHERE id=$1',[doc.id,originalActive]);}
async function update(set,values=[]){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1000ms'");await db.query(`UPDATE parsing_version_chunks SET ${set} WHERE version_id=$1 AND chunk_index=0`,[original.version_id,...values]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function startStub(handler){server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));models.rerankerUrl=`http://127.0.0.1:${server.address().port}`;}
async function closeStub(){models.rerankerUrl=originalRerankerUrl;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}}
async function main(){
 originalActive=(await pool.query('SELECT active_parse_version_id FROM documents WHERE id=$1',[doc.id])).rows[0].active_parse_version_id;
 original=(await pool.query('SELECT * FROM parsing_version_chunks WHERE version_id=$1 AND chunk_index=0',[originalActive])).rows[0];
 assert(original&&original.embedding_state==='ready');
 const terms=(await pool.query("SELECT retrieval_terms_v1('中文 P-101 DO 2.3 mg/L m³/h') AS t")).rows[0].t;assert(terms.includes('c:中文'));assert(terms.includes('a:p-101'));assert(terms.includes('a:2.3'));assert(terms.includes('a:m3/h'));
 const plan=await pool.query("EXPLAIN (ANALYZE,FORMAT JSON) SELECT version_id FROM parsing_version_chunks WHERE lexical_terms && ARRAY['a:p-101']");report.indexPlan=plan.rows[0]['QUERY PLAN'];assert(JSON.stringify(report.indexPlan).includes('parsing_chunk_lexical_gin'));check('CJK / identifier / decimal / Unicode unit terms and actual GIN execution plan');
 for(const [label,set,values]of [['disabled','enabled=false',[]],['pending',"embedding_state='pending'",[]],['processing',"embedding_state='processing'",[]],['failed',"embedding_state='failed'",[]],['revision mismatch','vector_revision=revision+1',[]],['zero vector','embedding=$2::vector',['['+Array(1024).fill(0).join(',')+']']],['wrong dimensions',"embedding='[1,0,1]'::vector",[]]]){
  await update(set,values);for(const mode of ['keyword','vector','hybrid']){const r=await run({mode,rerankEnabled:false});assert.equal(r.rows.length,0,`${label}/${mode}`);assert(r.trace.legs.every(l=>!l.candidates.length));}
  const reranked=await run();assert.equal(reranked.rows.length,0);await restore();
 }check('every recall route excludes disabled / pending / processing / failed / stale / zero / wrong-dimension vectors');
 // Gate the real embedding operation, after keyword recall has read the original body.
 for(const mutation of ['edit','disable','version']){
  let release,started;const barrier=new Promise(r=>release=r),atModel=new Promise(r=>started=r);
  models.embed=async(...args)=>{const value=await originalEmbed(...args);started();await barrier;return value;};
  const pending=run({rerankEnabled:false});await atModel;
  try{if(mutation==='edit')await update("content='竞态编辑 NEW-808',revision=revision+1,row_version=row_version+1,embedding_state='pending'");
   if(mutation==='disable')await update('enabled=false,row_version=row_version+1');
   if(mutation==='version'){const old=(await pool.query("SELECT id FROM parsing_versions WHERE document_id=$1 AND id<>$2 AND status='ready' ORDER BY created_at DESC LIMIT 1",[doc.id,originalActive])).rows[0];assert(old);await pool.query('UPDATE documents SET active_parse_version_id=$2 WHERE id=$1',[doc.id,old.id]);}
  }finally{release();models.embed=originalEmbed;}
  const r=await pending;assert(!r.rows.some(c=>c.version_id===original.version_id),'stale identity leaked');assert(r.trace.filtered.some(f=>['edited_or_toggled','active_version_changed'].includes(f.reason)));await restore();
 }check('real embedding in flight + concurrent edit / disable / version switch: final revalidation drops stale identity without holding row locks');
 let release,started;const barrier=new Promise(r=>release=r),atModel=new Promise(r=>started=r);models.embed=async(...args)=>{const v=await originalEmbed(...args);started();await barrier;return v;};
 const kbPending=run({rerankEnabled:false},{knowledgeBaseIds:[evaluation.otherBaseId]});await atModel;try{await pool.query('DELETE FROM knowledge_base_documents WHERE knowledge_base_id=$1 AND document_id=$2',[evaluation.otherBaseId,doc.id]);}finally{release();models.embed=originalEmbed;}
 const kbResult=await kbPending;assert.equal(kbResult.rows.length,0);assert(kbResult.trace.filtered.some(f=>f.reason==='scope_or_document_changed'));await pool.query('INSERT INTO knowledge_base_documents(knowledge_base_id,document_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[evaluation.otherBaseId,doc.id]);check('knowledge-base membership changes revalidated before final return');
 let changed=false;global.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).endsWith('/rerank')&&!changed){changed=true;await update('enabled=false,row_version=row_version+1');}return response;};
 const afterRerank=await run();assert.equal(afterRerank.trace.rerank.status,'complete');assert.equal(afterRerank.rows.length,0);await restore();global.fetch=originalFetch;check('real cross-encoder computed scores, then concurrent disable: old reranked result excluded');
 const row=(await pool.query('SELECT id,name,model_name,resource_revision FROM ai_models WHERE id=$1',[evaluation.rerankerId])).rows[0];
 for(const fault of ['unavailable','wrong_count','illegal_score','duplicate_index','wrong_revision','bad_json']){
  await startStub((request,response)=>{let data='';request.on('data',b=>data+=b);request.on('end',()=>{const body=JSON.parse(data);response.setHeader('Content-Type','application/json');if(fault==='unavailable'){response.writeHead(503);return response.end(JSON.stringify({error:'故障注入：资源不可用'}));}if(fault==='bad_json')return response.end('invalid-json');
   const scores=body.documents.map((s,i)=>({index:i,score:i,originalTokens:10,usedTokens:10,truncated:false}));if(fault==='wrong_count')scores.pop();if(fault==='illegal_score')scores[0].score='NaN';if(fault==='duplicate_index'){if(scores.length>1)scores[1].index=scores[0].index;else scores[0].index=99;}
   response.end(JSON.stringify({model:row.model_name,revision:fault==='wrong_revision'?'wrong':row.resource_revision,scoreType:'cross_encoder_logit',scores,maxTokens:512,queryTruncated:false}));});});
  const faultScope=fault==='duplicate_index'?{documentIds:[doc.id,evaluation.documents.turbidity.id]}:scope;
  const fallback=await run({failurePolicy:'fallback'},faultScope);assert(fallback.trace.degraded);assert.equal(fallback.trace.rerank.status,'failed_fallback');assert(fallback.rows.every(c=>c.rerankScore===undefined));assert(fallback.trace.warnings[0].reason);await assert.rejects(run({failurePolicy:'error'},faultScope));await closeStub();
 }check('isolated HTTP fault injection: unavailable / wrong count / illegal score / invalid index / resource mismatch / malformed JSON with explicit fallback and strict errors');
 await startStub((request,response)=>{request.resume();setTimeout(()=>{if(!response.destroyed)response.end('{}');},500);});const timed=await run({rerankTimeoutMs:100});assert(timed.trace.degraded);assert.equal(timed.trace.rerank.status,'failed_fallback');await assert.rejects(run({rerankTimeoutMs:100,failurePolicy:'error'}),e=>e.httpStatus===504);await closeStub();check('real HTTP abort timeout and explicit fallback, no fabricated rerank score');
 models.embed=async()=>{throw new Error('故障注入：向量资源不可用');};const partial=await run({rerankEnabled:false});assert(partial.rows.length&&partial.trace.degraded&&partial.rows.every(c=>c.keywordRank));await assert.rejects(run({mode:'vector',rerankEnabled:false}));models.embed=originalEmbed;check('vector failure falls back only to eligible keyword results; vector-only all-failed returns an error');
 const local=(await pool.query("SELECT * FROM ai_models WHERE provider='ollama' AND kind='llm' LIMIT 1")).rows[0];assert(local);
 const beforeAnswer=await run();models.chat=async(...args)=>{const text=await originalChat(...args);await update('enabled=false,row_version=row_version+1');return text;};
 const answered=await knowledge.answer(pool,'P-101 的额定流量是多少？',beforeAnswer,local);assert.equal(answered.answer,null);assert.match(answered.answerError,/资料发生变化/);assert.equal(answered.sources.length,0);assert(beforeAnswer.trace.answerSuppressed);models.chat=originalChat;await restore();check('real local answer followed by concurrent source change is suppressed; no stale citations returned');
 const tiny=await run({contextChars:500,rerankEnabled:false});assert(tiny.trace.contextChars<=500);assert(tiny.rows.every((c,i)=>c.number===i+1));check('character budget includes reference headers and preserves numbering');
 const thresholded=await run({rerankMinScore:1000000});assert.equal(thresholded.rows.length,0);assert.equal(thresholded.trace.rerank.status,'complete');assert(thresholded.trace.filtered.some(f=>f.reason==='below_rerank_logit_threshold'));check('optional logit threshold filters real reranker scores, never fusion scores');
 let enterCount=0,releaseAll,allEntered;const held=new Promise(r=>releaseAll=r),entered=new Promise(r=>allEntered=r);
 models.embed=async(...args)=>{if(++enterCount===4)allEntered();await held;return originalEmbed(...args);};const simultaneous=Array.from({length:4},()=>run({rerankEnabled:false}));
 await entered;try{await assert.rejects(run({rerankEnabled:false}),e=>e.reason==='retrieval_busy'&&e.httpStatus===503);}finally{releaseAll();models.embed=originalEmbed;}await Promise.all(simultaneous);check('real retrieval concurrency cap: four active requests, fifth rejected without unbounded queue');
 const requestBody={model:row.model_name,query:'并发验证运行资料',documents:Array(40).fill('真实模型批处理并发测试资料。'.repeat(300)),maxTokens:512,batchSize:4,timeoutMs:30000};
 const requests=await Promise.all([0,1].map(()=>originalFetch(originalRerankerUrl+'/rerank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody)})));assert.deepEqual(requests.map(r=>r.status).sort(),[200,429]);const completed=requests.find(r=>r.status===200);assert.equal((await completed.json()).scores.length,40);check('actual local cross-encoder semaphore and 40-candidate batch inference: one succeeds, concurrent request gets 429');
 const active=(await pool.query('SELECT kind,name FROM ai_models WHERE active ORDER BY kind')).rows;report.activeModels=active;
 console.log(JSON.stringify({result:'PASS',...report},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{global.fetch=originalFetch;models.embed=originalEmbed;models.chat=originalChat;models.rerankerUrl=originalRerankerUrl;await closeStub();await restore();if(evaluation.otherBaseId)await pool.query('INSERT INTO knowledge_base_documents(knowledge_base_id,document_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[evaluation.otherBaseId,doc.id]);await pool.end();});
