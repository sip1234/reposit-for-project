const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const models=require('./models');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const documentId=/^[A-Za-z0-9_-]{8,256}$/;
const VERSION='hybrid-1';
const DEFAULTS=Object.freeze({mode:'hybrid',keywordCandidates:40,vectorCandidates:20,fusion:'rrf',rrfK:60,
  keywordWeight:1,vectorWeight:1,minVectorSimilarity:0.25,fusionCandidates:80,rerankEnabled:false,rerankerModelId:null,
  rerankCandidates:20,rerankTextChars:4000,rerankMaxTokens:512,rerankBatchSize:4,rerankTimeoutMs:15000,rerankMinScore:null,
  finalCount:8,timeoutMs:30000,failurePolicy:'fallback',dedup:'overlap',overlapThreshold:0.9,
  maxPerDocument:3,contextChars:12000});
const bounds={keywordCandidates:[1,100],vectorCandidates:[1,50],fusionCandidates:[1,200],rrfK:[1,200],rerankCandidates:[1,40],
  rerankTextChars:[100,8000],rerankMaxTokens:[64,512],rerankBatchSize:[1,8],rerankTimeoutMs:[100,60000],
  finalCount:[1,20],timeoutMs:[500,120000],maxPerDocument:[1,20],contextChars:[500,40000]};
const chars=s=>Array.from(s);
const cut=(s,n)=>chars(s).slice(0,n).join('');
const key=c=>`${c.document_id}:${c.version_id}:${c.chunk_index}`;
const error=(status,message,code)=>Object.assign(new Error(message),{httpStatus:status,reason:code});
const canonical=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const stop=new Set(['什么','怎么','如何','多少','是否','需要','应该','可以','进行','一个','我们','以及','相关','的是','了什','为什','么是','的时','时候','请问','请说','一下']);
let inflight=0;

function validateConfig(input={},base=DEFAULTS){
  if(!input||Array.isArray(input)||typeof input!=='object')throw error(400,'检索配置必须为对象','invalid_config');
  if(Object.keys(input).some(k=>!Object.hasOwn(DEFAULTS,k)))throw error(400,'检索配置包含未知字段','invalid_config');
  const c={...base,...input};
  for(const [k,[min,max]]of Object.entries(bounds))if(!Number.isInteger(c[k])||c[k]<min||c[k]>max)throw error(400,`${k} 必须为 ${min}–${max} 的整数`,'invalid_config');
  if(!['keyword','vector','hybrid'].includes(c.mode)||c.fusion!=='rrf'||!['fallback','error'].includes(c.failurePolicy)||!['none','exact','overlap'].includes(c.dedup))throw error(400,'检索模式、融合、降级或去重方式无效','invalid_config');
  for(const k of ['keywordWeight','vectorWeight'])if(typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<=0||c[k]>5)throw error(400,`${k} 须大于 0 且不超过 5`,'invalid_config');
  if(typeof c.minVectorSimilarity!=='number'||!Number.isFinite(c.minVectorSimilarity)||c.minVectorSimilarity< -1||c.minVectorSimilarity>1||typeof c.overlapThreshold!=='number'||!Number.isFinite(c.overlapThreshold)||c.overlapThreshold<0.8||c.overlapThreshold>1)throw error(400,'相似度阈值无效','invalid_config');
  if(typeof c.rerankEnabled!=='boolean'||(c.rerankerModelId!==null&&(typeof c.rerankerModelId!=='string'||!uuid.test(c.rerankerModelId))))throw error(400,'重排开关或模型标识无效','invalid_config');
  if(c.rerankEnabled&&!c.rerankerModelId)throw error(400,'启用重排时必须明确选择重排模型','reranker_not_configured');
  if(c.rerankMinScore!==null&&(typeof c.rerankMinScore!=='number'||!Number.isFinite(c.rerankMinScore)||Math.abs(c.rerankMinScore)>1000000))throw error(400,'重排最低 logit 必须为空或有限数值','invalid_config');
  if(c.finalCount>c.fusionCandidates||c.rerankEnabled&&(c.finalCount>c.rerankCandidates||c.rerankCandidates>c.fusionCandidates))throw error(400,'最终数量不能超过融合候选，重排候选须介于最终数量与融合候选之间','invalid_config');
  return c;
}

async function setup(pool){
  const db=await pool.connect();
  try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(84271933)');
    if(!(await db.query("SELECT 1 FROM app_migrations WHERE name='hybrid-retrieval-v1'")).rowCount){
      await db.query(fs.readFileSync(path.join(__dirname,'retrieval-schema.sql'),'utf8'));
      await db.query("INSERT INTO app_migrations(name) VALUES('hybrid-retrieval-v1')");
    }
    // Repair a pre-release derivation without reparsing or changing content/revision/vector state.
    if(!(await db.query("SELECT 1 FROM app_migrations WHERE name='hybrid-lexical-v1-verified'")).rowCount){
      const probe=(await db.query("SELECT retrieval_terms_v1('中文 P-101') AS terms")).rows[0].terms;
      if(!probe.includes('c:中文')||!probe.includes('a:p-101')){
        const functions=fs.readFileSync(path.join(__dirname,'retrieval-schema.sql'),'utf8').split('ALTER TABLE')[0].replaceAll('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
        await db.query(functions);await db.query('UPDATE parsing_version_chunks SET content=content');
      }
      await db.query("INSERT INTO app_migrations(name) VALUES('hybrid-lexical-v1-verified')");
    }
    const hash=crypto.createHash('sha256').update(JSON.stringify(DEFAULTS)).digest('hex');
    const saved=(await db.query(`INSERT INTO retrieval_configs(id,name,config,config_hash) VALUES($1,'混合检索 默认配置',$2,$3)
      ON CONFLICT(config_hash) DO UPDATE SET config_hash=EXCLUDED.config_hash RETURNING id`,[crypto.randomUUID(),DEFAULTS,hash])).rows[0];
    await db.query('INSERT INTO retrieval_defaults(singleton,config_id) VALUES(true,$1) ON CONFLICT DO NOTHING',[saved.id]);
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}

async function resolveConfig(pool,body){
  const defaults=(await pool.query('SELECT c.* FROM retrieval_defaults d JOIN retrieval_configs c ON c.id=d.config_id')).rows[0];
  let selected=defaults;
  if(body.retrievalConfigId!==undefined){if(typeof body.retrievalConfigId!=='string'||!uuid.test(body.retrievalConfigId))throw error(400,'保存的检索配置标识无效','invalid_config');
    selected=(await pool.query('SELECT * FROM retrieval_configs WHERE id=$1',[body.retrievalConfigId])).rows[0];if(!selected)throw error(404,'检索配置不存在','config_not_found');}
  const config=validateConfig(body.retrievalConfig??{},validateConfig(selected.config));
  let reranker=null;
  if(config.rerankerModelId){reranker=(await pool.query("SELECT id,name,model_name,resource_revision FROM ai_models WHERE id=$1 AND kind='reranker' AND provider='local'",[config.rerankerModelId])).rows[0];
    if(!reranker)throw error(400,'所选模型不是有效的本地重排模型','invalid_reranker');}
  return {config,configId:selected.id,origin:body.retrievalConfig!==undefined?'request_override':body.retrievalConfigId?'saved_config':'system_default',
    systemDefaultId:defaults.id,reranker};
}

function validateIds(ids,pattern,label,max){if(!Array.isArray(ids)||!ids.length||ids.length>max||ids.some(id=>typeof id!=='string'||!pattern.test(id))||new Set(ids).size!==ids.length)throw error(400,`${label}范围无效或包含重复标识`,'invalid_scope');}
async function scopeFor(pool,scope){
  if(scope.knowledgeBaseIds!==undefined){validateIds(scope.knowledgeBaseIds,uuid,'知识库',1000);
    const count=(await pool.query('SELECT count(*)::int AS n FROM knowledge_bases WHERE id=ANY($1::uuid[])',[scope.knowledgeBaseIds])).rows[0].n;
    if(count!==scope.knowledgeBaseIds.length)throw error(400,'所选知识库不存在，请刷新','invalid_scope');return {type:'knowledgeBases',ids:scope.knowledgeBaseIds};}
  validateIds(scope.documentIds,documentId,'文件',100);
  const count=(await pool.query("SELECT count(*)::int AS n FROM documents WHERE id=ANY($1::text[]) AND status='ready'",[scope.documentIds])).rows[0].n;
  if(count!==scope.documentIds.length)throw error(404,'文件不存在或尚未保存','invalid_scope');return {type:'documents',ids:scope.documentIds};
}
const scopeSQL=(scope,slot=1)=>scope.type==='documents'?`d.id=ANY($${slot}::text[])`:
  `EXISTS(SELECT 1 FROM knowledge_base_documents kb WHERE kb.document_id=d.id AND kb.knowledge_base_id=ANY($${slot}::uuid[]))`;
const FROM=`FROM parsing_version_chunks c JOIN parsing_versions v ON v.id=c.version_id
  JOIN parsing_jobs j ON j.id=v.job_id JOIN ai_models m ON m.id=j.model_id JOIN documents d ON d.active_parse_version_id=v.id AND d.id=v.document_id`;
const ELIGIBLE=`d.status='ready' AND v.status='ready' AND j.status='ready' AND m.kind='embedding' AND c.enabled
  AND c.embedding_state='ready' AND c.revision=c.vector_revision AND vector_dims(c.embedding)=m.dimensions AND vector_norm(c.embedding)>0`;
const FIELDS=`d.id AS document_id,d.filename,d.extension,v.id AS version_id,c.chunk_index,c.revision,c.row_version,c.embedding_job_id,
  c.content,c.source,c.section_path,c.content_type,m.id AS model_id,m.name AS model_name,m.model_name AS model_identifier,md5(c.content) AS content_hash`;
const baseNamesField=scope=>scope.type==='knowledgeBases'?`(SELECT array_agg(DISTINCT b.name ORDER BY b.name) FROM knowledge_base_documents bm JOIN knowledge_bases b ON b.id=bm.knowledge_base_id WHERE bm.document_id=d.id AND bm.knowledge_base_id=ANY($1::uuid[])) AS knowledge_base_names`:`ARRAY[]::text[] AS knowledge_base_names`;

async function queryDB(pool,text,values,deadline){
  const ms=Math.min(10000,Math.floor(deadline-Date.now()));if(ms<1)throw error(504,'检索总时限已到','retrieval_timeout');
  const db=await pool.connect();try{await db.query('BEGIN READ ONLY');await db.query("SELECT set_config('statement_timeout',$1,true)",[String(ms)]);const r=await db.query(text,values);await db.query('COMMIT');return r;
  }catch(e){await db.query('ROLLBACK');if(e.code==='57014')throw error(504,'检索数据库查询超时','retrieval_timeout');throw e;}finally{db.release();}
}
const slim=c=>({documentId:c.document_id,versionId:c.version_id,chunkIndex:c.chunk_index,revision:c.revision,rowVersion:c.row_version,
  filename:c.filename,modelId:c.model_id,contentHash:c.content_hash,excerpt:cut(c.content,160),keywordRank:c.keywordRank??null,
  keywordScore:c.keywordScore??null,vectorRank:c.vectorRank??null,cosine:c.cosine??null,fusionRank:c.fusionRank??null,
  fusionScore:c.fusionScore??null,rerankRank:c.rerankRank??null,rerankScore:c.rerankScore??null,rerankInput:c.rerankInput??null});

function fuse(legs,config){
  const map=new Map();
  for(const leg of legs)for(let i=0;i<leg.candidates.length;i++){
    const row=leg.candidates[i],id=key(row);if(!map.has(id))map.set(id,{...row,fusionScore:0,legs:[],alternates:[]});const c=map.get(id),rank=i+1;
    if(c.revision!==row.revision||c.row_version!==row.row_version||c.content_hash!==row.content_hash)c.snapshotConflict=true;
    c.fusionScore+=leg.weight/(config.rrfK+rank);c.legs.push({route:leg.route,modelId:leg.modelId??null,rank,rawScore:row.rawScore,weight:leg.weight});
    if(leg.route==='keyword'){c.keywordRank=rank;c.keywordScore=row.rawScore;}else{c.vectorRank=rank;c.cosine=row.rawScore;}
  }
  return [...map.values()].sort((a,b)=>b.fusionScore-a.fusionScore||key(a).localeCompare(key(b))).map((c,i)=>({...c,fusionRank:i+1}));
}
function shingles(text){const a=chars(canonical(text)),counts=new Map();for(let i=0;i<a.length-3;i++){const s=a.slice(i,i+4).join('');counts.set(s,(counts.get(s)||0)+1);}return {counts,total:Math.max(0,a.length-3)};}
function near(a,b,threshold,cache){if(Math.min(a.length,b.length)<30)return false;
  const critical=s=>[...new Set((canonical(s).match(/[a-z0-9μ]+(?:[._/:-][a-z0-9μ]+)*/g)||[]).filter(t=>/\d/.test(t)))].sort().join('|');
  if(critical(a)!==critical(b))return false; // Never hide different device IDs or recorded numeric values as near duplicates.
  const get=s=>{if(!cache)return shingles(s);if(!cache.has(s))cache.set(s,shingles(s));return cache.get(s);};const sa=get(a),sb=get(b);let same=0;for(const [s,n]of sa.counts)same+=Math.min(n,sb.counts.get(s)||0);return same/Math.max(1,sa.total+sb.total-same)>=threshold;}
function deduplicate(rows,config,trace){
  const kept=[],cache=new Map();for(const c of rows){const duplicate=config.dedup==='none'?null:kept.find(k=>canonical(k.content)===canonical(c.content)||(config.dedup==='overlap'&&near(k.content,c.content,config.overlapThreshold,cache)));
    if(duplicate){duplicate.alternates.push(c);trace.push({identity:key(c),reason:'duplicate_content_source_preserved',representative:key(duplicate)});}else kept.push({...c,alternates:[...(c.alternates||[])]});}return kept;
}

async function rerank(rows,query,config,model,deadline){
  const timeout=Math.min(config.rerankTimeoutMs,deadline-Date.now()-500);if(timeout<100)throw error(504,'重排可用时间不足','rerank_timeout');
  const submitted=rows.slice(0,config.rerankCandidates),texts=submitted.map(c=>cut(c.content,config.rerankTextChars));
  let response,data;try{response=await fetch(`${models.rerankerUrl}/rerank`,{method:'POST',headers:{'Content-Type':'application/json'},
    signal:AbortSignal.timeout(timeout),body:JSON.stringify({model:model.model_name,query,documents:texts,maxTokens:config.rerankMaxTokens,batchSize:config.rerankBatchSize,timeoutMs:timeout})});
  data=await response.json();}catch(e){throw error(['TimeoutError','AbortError'].includes(e.name)?504:503,`本地重排请求失败：${e.cause?.code||e.message}`,e.name==='SyntaxError'?'rerank_invalid_response':'rerank_unavailable');}
  if(!response.ok)throw error(response.status===504?504:503,`本地重排失败 (${response.status})：${String(data.error||'未知错误').slice(0,500)}`,'rerank_unavailable');
  if(data.model!==model.model_name||data.revision!==model.resource_revision||data.scoreType!=='cross_encoder_logit'||!Array.isArray(data.scores)||data.scores.length!==submitted.length)throw error(503,'重排服务模型版本或返回数量不一致','rerank_invalid_response');
  const seen=new Set();for(const entry of data.scores){if(!Number.isInteger(entry.index)||entry.index<0||entry.index>=submitted.length||seen.has(entry.index)||typeof entry.score!=='number'||!Number.isFinite(entry.score)||Math.abs(entry.score)>1000000||!Number.isInteger(entry.originalTokens)||entry.originalTokens<0||!Number.isInteger(entry.usedTokens)||entry.usedTokens<0||entry.usedTokens>config.rerankMaxTokens||entry.usedTokens>entry.originalTokens||typeof entry.truncated!=='boolean')throw error(503,'重排服务返回非法排名、分数或截断信息','rerank_invalid_response');seen.add(entry.index);}
  const result=data.scores.map(s=>({...submitted[s.index],rerankScore:s.score,rerankInput:{originalChars:chars(submitted[s.index].content).length,
    submittedChars:chars(texts[s.index]).length,charTruncated:texts[s.index]!==submitted[s.index].content,originalTokens:s.originalTokens,usedTokens:s.usedTokens,
    tokenTruncated:s.truncated,queryTruncated:Boolean(data.queryTruncated),maxTokens:data.maxTokens}}))
    .sort((a,b)=>b.rerankScore-a.rerankScore||a.fusionRank-b.fusionRank).map((c,i)=>({...c,rerankRank:i+1}));
  return {rows:result,model:{id:model.id,name:model.name,identifier:model.model_name,revision:model.resource_revision,scoreType:'cross_encoder_logit'},elapsedMs:data.elapsedMs};
}

async function revalidate(pool,rows,scope,deadline=Date.now()+2000){
  if(!rows.length)return {valid:[],removed:[]};
  const identities=rows.map(c=>({version_id:c.version_id,chunk_index:c.chunk_index,revision:c.revision,row_version:c.row_version,document_id:c.document_id,content_hash:c.content_hash}));
  const r=await queryDB(pool,`SELECT i.document_id,i.version_id,i.chunk_index,
    CASE WHEN d.id IS NULL THEN 'scope_or_document_changed' WHEN d.active_parse_version_id IS DISTINCT FROM i.version_id THEN 'active_version_changed'
    WHEN c.revision<>i.revision OR c.row_version<>i.row_version OR md5(c.content)<>i.content_hash THEN 'edited_or_toggled'
    WHEN v.document_id IS DISTINCT FROM i.document_id OR NOT coalesce((${ELIGIBLE}),false) THEN 'vector_or_chunk_unavailable' ELSE NULL END AS reason
    FROM jsonb_to_recordset($2::jsonb) AS i(document_id text,version_id uuid,chunk_index integer,revision integer,row_version integer,content_hash text)
    LEFT JOIN documents d ON d.id=i.document_id AND ${scopeSQL(scope)}
    LEFT JOIN parsing_versions v ON v.id=i.version_id LEFT JOIN parsing_jobs j ON j.id=v.job_id LEFT JOIN ai_models m ON m.id=j.model_id
    LEFT JOIN parsing_version_chunks c ON c.version_id=i.version_id AND c.chunk_index=i.chunk_index`,[scope.ids,JSON.stringify(identities)],deadline);
  const invalid=new Map(r.rows.filter(c=>c.reason).map(c=>[key(c),c.reason]));
  return {valid:rows.filter(c=>!invalid.has(key(c))),removed:[...invalid].map(([identity,reason])=>({identity,reason}))};
}
function selectContext(rows,config,trace){
  const selected=[],counts=new Map();let used=0;
  for(const c of rows){if(selected.length>=config.finalCount){trace.push({identity:key(c),reason:'final_count_limit'});continue;}
    if((counts.get(c.document_id)||0)>=config.maxPerDocument){trace.push({identity:key(c),reason:'per_document_limit'});continue;}
    const number=selected.length+1,header=`[${number}] ${c.filename} · ${c.source?.locator||'未记录'} · 版本 ${c.version_id} · 分块 ${c.chunk_index+1} · 修订 ${c.revision}${c.revision>0?'（人工修订，可能与原件不同）':''}\n`;
    const room=config.contextChars-used-chars(header).length-2;if(room<40){trace.push({identity:key(c),reason:'context_character_budget'});continue;}
    const contextText=cut(c.content,room),contextTruncated=contextText!==c.content;selected.push({...c,number,contextHeader:header,contextText,contextTruncated,contextChars:chars(contextText).length});used+=chars(header+contextText+'\n\n').length;counts.set(c.document_id,(counts.get(c.document_id)||0)+1);
  }return {selected,used};
}

async function run(pool,query,scopeInput,body={}){
  if(typeof query!=='string'||!query.trim()||chars(query).length>500||query.includes('\0'))throw error(400,'检索问题须为 1–500 个字符且不含 NUL','invalid_query');query=query.trim();
  if(body.diagnostics!==undefined&&typeof body.diagnostics!=='boolean')throw error(400,'diagnostics 必须为布尔值','invalid_config');
  const scope=await scopeFor(pool,scopeInput),resolved=await resolveConfig(pool,body),config=resolved.config;
  if(inflight>=4)throw error(503,'检索并发已达上限 4，请稍后重试','retrieval_busy');inflight++;
  const started=performance.now(),id=crypto.randomUUID(),deadline=Date.now()+config.timeoutMs;
  const trace={algorithmVersion:VERSION,origin:resolved.origin,systemDefaultId:resolved.systemDefaultId,timings:{},warnings:[],degraded:false,
    rerank:{status:config.rerankEnabled?'waiting':'disabled',note:config.rerankEnabled?'待执行':'未启用'},legs:[],filtered:[],
    rules:{fusion:`Σ weight/(k+rank), k=${config.rrfK}; 向量路总权重平均分给实际模型`,dedup:config.dedup,overlapThreshold:config.overlapThreshold,maxPerDocument:config.maxPerDocument,
      maxModels:8,maxConcurrentRequests:4,keywordScore:'加权词项覆盖率 + 原问题规范化子串奖励(1)',cosine:'同一向量模型内余弦相似度',rerankScore:'交叉编码器原始 logit，非概率',contextUnit:'Unicode 字符，包含引用头'}};
  const snapshot={schemaVersion:1,algorithmVersion:VERSION,...resolved,reranker:resolved.reranker};
  let result;
  async function stage(name,fn){const t=performance.now();try{return await fn();}finally{trace.timings[name]=Math.round((performance.now()-t)*100)/100;}}
  function fallback(stageName,e){if(config.failurePolicy==='error')throw e;trace.degraded=true;trace.warnings.push({stage:stageName,code:e.reason||e.name,reason:e.message});}
  try{
    const initial=await stage('scopeAndEligibility',()=>queryDB(pool,`SELECT c.embedding_state,c.enabled,c.revision=c.vector_revision AS consistent,
      vector_dims(c.embedding)=m.dimensions AND vector_norm(c.embedding)>0 AS valid_vector,count(*)::int AS n ${FROM}
      WHERE ${scopeSQL(scope)} AND d.status='ready' AND v.status='ready' AND j.status='ready' GROUP BY 1,2,3,4`,[scope.ids],deadline));
    trace.eligibility=initial.rows;trace.activeChunkCount=initial.rows.reduce((n,r)=>n+r.n,0);
    trace.excludedAtRecall=initial.rows.map(r=>({count:r.n,reasons:[...(!r.enabled?['disabled']:[]),...(r.embedding_state!=='ready'?[`vector_${r.embedding_state}`]:[]),...(!r.consistent?['body_vector_revision_mismatch']:[]),...(!r.valid_vector?['invalid_vector_norm_or_dimension']:[])]})).filter(r=>r.reasons.length);
    const legs=[];
    if(config.mode!=='vector')await stage('keyword',async()=>{
      const analyzed=(await queryDB(pool,'SELECT retrieval_terms_v1($1) AS terms,retrieval_normalize_v1($1) AS normalized',[query],deadline)).rows[0];
      const terms=analyzed.terms.filter(t=>!t.startsWith('c:')||(!stop.has(t.slice(2))&&(chars(query.replace(/\s/gu,'')).length===1||chars(t.slice(2)).length===2)));
      const limited=terms.slice(0,100),weights=limited.map(t=>t.startsWith('a:')&&/[a-z].*\d|\d.*[a-z]/.test(t)?4:t.startsWith('a:')?2:1);
      trace.queryTerms={terms:limited,omitted:terms.length-limited.length,tokenizer:'CJK 一元/二元字符词项 + NFKC 英文/编号/数值词项 v1；无词典分词、拼写纠错或自动同义词扩展'};
      const rows=limited.length?(await queryDB(pool,`SELECT ${FIELDS},${baseNamesField(scope)},
        (SELECT sum(w) FROM unnest($2::text[],$3::float8[]) AS x(t,w) WHERE c.lexical_terms @> ARRAY[x.t]) / $4::float8
        + CASE WHEN position($5 IN retrieval_normalize_v1(c.content))>0 THEN 1 ELSE 0 END AS raw_score
        ${FROM} WHERE ${scopeSQL(scope)} AND ${ELIGIBLE} AND c.lexical_terms && $2::text[]
        ORDER BY raw_score DESC,d.id,c.chunk_index LIMIT $6`,[scope.ids,limited,weights,weights.reduce((a,b)=>a+b,0),analyzed.normalized,config.keywordCandidates],deadline)).rows:[];
      legs.push({route:'keyword',weight:config.keywordWeight,candidates:rows.map(c=>({...c,rawScore:Number(c.raw_score)}))});
    });
    if(config.mode!=='keyword')await stage('vector',async()=>{
      const used=(await queryDB(pool,`SELECT DISTINCT m.* ${FROM} WHERE ${scopeSQL(scope)} AND ${ELIGIBLE} ORDER BY m.id LIMIT 9`,[scope.ids],deadline)).rows;
      if(used.length>8)throw error(422,'所选范围超过 8 个向量模型，请缩小范围','resource_limit');
      for(const model of used){const t=performance.now();try{
        const timeout=Math.floor(deadline-Date.now()-500);if(timeout<1)throw error(504,'向量召回超时','vector_timeout');
        const vector=await models.embed(model,query,{timeoutMs:timeout});
        const distance=`CASE WHEN vector_dims(c.embedding)=m.dimensions AND vector_dims(c.embedding)=$6 THEN c.embedding <=> $2::vector ELSE NULL END`;
        const rows=(await queryDB(pool,`SELECT ${FIELDS},${baseNamesField(scope)},1-(${distance}) AS raw_score ${FROM}
          WHERE ${scopeSQL(scope)} AND ${ELIGIBLE} AND j.model_id=$3 AND 1-(${distance})>=$4
          ORDER BY (${distance}),d.id,c.chunk_index LIMIT $5`,[scope.ids,`[${vector.join(',')}]`,model.id,config.minVectorSimilarity,config.vectorCandidates,model.dimensions],deadline)).rows;
        legs.push({route:'vector',modelId:model.id,modelName:model.name,modelIdentifier:model.model_name,dimensions:model.dimensions,
          weight:config.vectorWeight/Math.max(1,used.length),elapsedMs:Math.round(performance.now()-t),candidates:rows.map(c=>({...c,rawScore:Number(c.raw_score)}))});
      }catch(e){fallback(`vector:${model.name}`,e.httpStatus?e:error(503,`向量模型 ${model.name} 召回失败：${e.message}`,'vector_unavailable'));}}
      if(used.length&&config.mode==='vector'&&!legs.length)throw error(503,'所有向量模型均不可用，无法降级到可用召回路','vector_unavailable');
    });
    trace.legs=legs.map(l=>({...l,candidates:l.candidates.map((c,i)=>({...slim(c),rank:i+1,rawScore:c.rawScore}))}));
    let rows=await stage('fusion',async()=>fuse(legs,config));trace.fused=rows.map(slim);trace.candidateCount=rows.length;
    trace.filtered.push(...rows.filter(c=>c.snapshotConflict).map(c=>({identity:key(c),reason:'recall_revision_snapshot_conflict'})));rows=rows.filter(c=>!c.snapshotConflict);
    trace.filtered.push(...rows.slice(config.fusionCandidates).map(c=>({identity:key(c),reason:'fusion_candidate_limit'})));rows=rows.slice(0,config.fusionCandidates);
    rows=await stage('deduplication',async()=>deduplicate(rows,config,trace.filtered));trace.uniqueCandidateCount=rows.length;
    if(config.rerankEnabled&&rows.length){const checked=await stage('preRerankValidation',()=>revalidate(pool,rows.flatMap(c=>[c,...c.alternates]),scope,deadline));
      const valid=new Set(checked.valid.map(key));trace.filtered.push(...checked.removed.map(r=>({...r,phase:'before_rerank'})));rows=rows.filter(c=>valid.has(key(c))).map(c=>({...c,alternates:c.alternates.filter(a=>valid.has(key(a)))}));}
    trace.rerankInputCount=config.rerankEnabled?Math.min(rows.length,config.rerankCandidates):0;
    if(config.rerankEnabled&&rows.length){try{const ranking=await stage('rerank',()=>rerank(rows,query,config,resolved.reranker,deadline));
      trace.filtered.push(...rows.slice(config.rerankCandidates).map(c=>({identity:key(c),reason:'rerank_candidate_limit'})));
      rows=ranking.rows;trace.rerank={status:'complete',model:ranking.model,modelElapsedMs:ranking.elapsedMs};trace.reranked=rows.map(slim);
      if(config.rerankMinScore!==null){trace.filtered.push(...rows.filter(c=>c.rerankScore<config.rerankMinScore).map(c=>({identity:key(c),reason:'below_rerank_logit_threshold',score:c.rerankScore,threshold:config.rerankMinScore})));rows=rows.filter(c=>c.rerankScore>=config.rerankMinScore);}
    }catch(e){trace.rerank={status:config.failurePolicy==='fallback'?'failed_fallback':'failed',reason:e.message,model:resolved.reranker};fallback('rerank',e);}}
    else if(config.rerankEnabled)trace.rerank={status:'skipped_empty',note:'没有候选，不调用重排模型'};
    const all=rows.flatMap(c=>[c,...c.alternates]);
    const checked=await stage('revalidation',()=>revalidate(pool,all,scope,Math.max(deadline,Date.now()+2000)));
    const validKeys=new Set(checked.valid.map(key));trace.filtered.push(...checked.removed);
    // Discard invalid representatives and their scores. A surviving alternate is not promoted with another body's score.
    rows=rows.filter(c=>validKeys.has(key(c))).map(c=>({...c,alternates:c.alternates.filter(a=>validKeys.has(key(a)))}));
    const selected=selectContext(rows,config,trace.filtered);trace.contextChars=selected.used;trace.finalCount=selected.selected.length;
    result={id,query,scope,config,configId:resolved.configId,trace,snapshot,rows:selected.selected};
    trace.timings.total=Math.round(performance.now()-started);await persist(pool,result,'complete');return result;
  }catch(e){trace.timings.total=Math.round(performance.now()-started);trace.error={code:e.reason||e.code||e.name,message:e.message};
    await persist(pool,{id,query,scope,configId:resolved.configId,snapshot,trace,rows:[]},'failed');e.runId=id;e.retrieval={runId:id,configId:resolved.configId,config,origin:resolved.origin,
      degraded:trace.degraded,warnings:trace.warnings,error:trace.error,rerank:trace.rerank,timings:trace.timings,finalCount:0,...(body.diagnostics?{diagnostics:trace}:{})};throw e;
  }finally{inflight--;}
}

async function persist(pool,result,status){await pool.query(`INSERT INTO retrieval_runs(id,query,scope,config_id,config_snapshot,status,trace,results)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET trace=EXCLUDED.trace,results=EXCLUDED.results,status=EXCLUDED.status`,
  [result.id,result.query,result.scope,result.configId,result.snapshot,status,result.trace,JSON.stringify(result.rows.map(c=>({...slim(c),contextChars:c.contextChars,contextTruncated:c.contextTruncated,alternateSources:c.alternates.map(slim)})))]);}
async function refresh(pool,result,phase='before_answer'){
  const checked=await revalidate(pool,result.rows.flatMap(c=>[c,...c.alternates]),result.scope);const valid=new Set(checked.valid.map(key));
  const removed=result.rows.some(c=>!valid.has(key(c)));result.rows=result.rows.filter(c=>valid.has(key(c))).map(c=>({...c,alternates:c.alternates.filter(a=>valid.has(key(a)))}));
  const selected=selectContext(result.rows,result.config,result.trace.filtered);result.rows=selected.selected;result.trace.contextChars=selected.used;result.trace.finalCount=result.rows.length;
  if(checked.removed.length){result.trace.filtered.push(...checked.removed.map(r=>({...r,phase})));result.trace.warnings.push({stage:phase,reason:'部分资料在检索后发生变化，已剔除；未自动补召回。'});}
  await persist(pool,result,'complete');return removed;
}
function provenance(c){return {documentId:c.document_id,filename:c.filename,extension:c.extension,versionId:c.version_id,chunkIndex:c.chunk_index,revision:c.revision,
  source:c.source,sectionPath:c.section_path,locator:c.source?.locator||'未记录',modified:c.revision>0,knowledgeBaseNames:c.knowledge_base_names||[],knowledgeBaseName:(c.knowledge_base_names||[]).join('、')};}
function sources(result){return result.rows.map((c,i)=>({...provenance(c),number:i+1,excerpt:c.contextText,originalChars:chars(c.content).length,
  contextTruncated:c.contextTruncated,similarity:c.cosine??null,scoreType:c.rerankScore!==undefined?'cross_encoder_logit':'rrf_rank_score',
  fusionRank:c.fusionRank,fusionScore:c.fusionScore,rerankRank:c.rerankRank??null,rerankScore:c.rerankScore??null,
  keywordRank:c.keywordRank??null,keywordScore:c.keywordScore??null,vectorRank:c.vectorRank??null,cosine:c.cosine??null,
  embeddingModel:{id:c.model_id,name:c.model_name,identifier:c.model_identifier},alternateSources:c.alternates.map(provenance)}));}
function summary(result,debug=false){return {runId:result.id,configId:result.configId,config:result.config,origin:result.trace.origin,algorithmVersion:VERSION,
  degraded:result.trace.degraded,warnings:result.trace.warnings,rerank:result.trace.rerank,timings:result.trace.timings,finalCount:result.rows.length,
  contextChars:result.trace.contextChars,...(debug?{diagnostics:result.trace}:{})};}
async function test(pool,docId,body){
  const scope=body.knowledgeBaseIds!==undefined?{knowledgeBaseIds:body.knowledgeBaseIds}:{documentIds:[docId]};
  const result=await run(pool,body.query,scope,body);await refresh(pool,result,'before_return');const grouped=new Map();
  for(const chosen of result.rows)for(const c of [chosen,...chosen.alternates]){if(!grouped.has(c.model_id))grouped.set(c.model_id,{modelId:c.model_id,modelName:c.model_name,chunks:[]});
    grouped.get(c.model_id).chunks.push({...c,alternates:undefined,score:c.cosine??null,scoreType:'cosine_within_model',finalRank:chosen.number,isAlternateSource:c!==chosen});}
  return {sources:sources(result),results:[...grouped.values()],retrieval:summary(result,Boolean(body.diagnostics)),
    note:'最终顺序按排名融合或交叉编码重排；余弦值仅用于各模型内部召回，不跨模型直接比较。'};
}

async function handle(pool,req,res,url,send,readBody){try{
  if(url.pathname==='/api/retrieval/configs'){
    if(req.method==='GET'){const data=await pool.query('SELECT * FROM retrieval_configs ORDER BY created_at DESC');const d=(await pool.query('SELECT config_id FROM retrieval_defaults')).rows[0];return send(res,200,{defaults:DEFAULTS,systemDefaultId:d.config_id,configs:data.rows,schemaVersion:1,algorithmVersion:VERSION});}
    if(req.method==='POST'){const body=await readBody(req);const name=typeof body?.name==='string'?body.name.trim():'';if(!name||name.includes('\0')||chars(name).length>80)throw error(400,'配置名称须为 1–80 字且不含 NUL','invalid_config');
      const config=validateConfig(body.config);await resolveConfig(pool,{retrievalConfig:config});const hash=crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const saved=(await pool.query(`INSERT INTO retrieval_configs(id,name,config,config_hash) VALUES($1,$2,$3,$4) ON CONFLICT(config_hash) DO UPDATE SET config_hash=EXCLUDED.config_hash RETURNING *`,[crypto.randomUUID(),name,config,hash])).rows[0];return send(res,201,saved);}
  }
  if(url.pathname==='/api/retrieval/default'&&req.method==='POST'){const body=await readBody(req);if(typeof body?.configId!=='string'||!uuid.test(body.configId))throw error(400,'配置标识无效','invalid_config');const changed=await pool.query('UPDATE retrieval_defaults SET config_id=$1 WHERE EXISTS(SELECT 1 FROM retrieval_configs WHERE id=$1)',[body.configId]);if(!changed.rowCount)throw error(404,'检索配置不存在','config_not_found');return send(res,200,{configId:body.configId});}
  const match=/^\/api\/retrieval\/runs\/([0-9a-f-]+)$/.exec(url.pathname);
  if(match&&uuid.test(match[1])&&req.method==='GET'){const row=(await pool.query('SELECT * FROM retrieval_runs WHERE id=$1',[match[1]])).rows[0];return row?send(res,200,row):send(res,404,{error:'检索记录不存在'});}
  return send(res,405,{error:'不支持此检索配置操作'});
}catch(e){return send(res,e.httpStatus||500,{error:e.httpStatus?e.message:'检索配置数据库操作失败',code:e.reason});}}
module.exports={setup,run,test,refresh,sources,summary,handle,validateConfig,DEFAULTS,fuse,deduplicate,selectContext,revalidate,resolveConfig,scopeFor,VERSION};
