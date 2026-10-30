// Re-evaluate the retained labelled fixture without uploading/reparsing or changing model defaults.
const assert=require('node:assert/strict'),fs=require('node:fs');
const cases=require('../tests/retrieval-cases.json'),seed=JSON.parse(fs.readFileSync('artifacts/retrieval/evaluation.json','utf8'));
const api=process.env.TEST_API||'http://localhost:3000';
async function run(){const out={date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),queryCount:cases.queries.length,documentCount:Object.keys(seed.documents).filter(k=>k!=='long').length,baseId:seed.baseId,rerankerId:seed.rerankerId,queries:[],metrics:{}};
 const warm=await fetch(`${api}/api/documents/${seed.documents.pump.id}/retrieval-test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'预热本地检索模型',knowledgeBaseIds:[seed.baseId],retrievalConfig:{mode:'vector',minVectorSimilarity:-1,timeoutMs:120000}})});const warmed=await warm.json();assert.equal(warm.status,200);out.warmup={excludedFromMetrics:true,timings:warmed.retrieval.timings};
 for(const q of cases.queries){const relevant=new Set(q.relevant.map(k=>seed.documents[k].id)),item={query:q.query,type:q.type,relevant:q.relevant,modes:{}};
  for(const mode of ['keyword','vector','hybrid','rerank']){const response=await fetch(`${api}/api/documents/${seed.documents.pump.id}/retrieval-test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q.query,knowledgeBaseIds:[seed.baseId],diagnostics:true,retrievalConfig:{mode:mode==='rerank'?'hybrid':mode,rerankEnabled:mode==='rerank',rerankerModelId:mode==='rerank'?seed.rerankerId:null,keywordCandidates:40,vectorCandidates:30,fusionCandidates:80,rerankCandidates:40,finalCount:5,maxPerDocument:2,minVectorSimilarity:0.1,timeoutMs:60000,rerankTimeoutMs:30000}})});const d=await response.json();assert.equal(response.status,200,JSON.stringify(d));if(mode==='rerank')assert.equal(d.retrieval.rerank.status,'complete');
   const hit=s=>[s.documentId,...s.alternateSources.map(a=>a.documentId)].some(id=>relevant.has(id)),index=d.sources.slice(0,5).findIndex(hit),rank=index+1;
   item.modes[mode]={recallAt3:d.sources.slice(0,3).some(hit)?1:0,mrrAt5:rank?1/rank:0,ndcgAt5:rank?1/Math.log2(rank+1):0,timings:d.retrieval.timings,runId:d.retrieval.runId,
    candidateIds:d.retrieval.diagnostics.fused.map(c=>`${c.documentId}:${c.versionId}:${c.chunkIndex}`),sources:d.sources};
   if(mode==='rerank')assert.deepEqual(new Set(item.modes.rerank.candidateIds),new Set(item.modes.hybrid.candidateIds));
  }out.queries.push(item);console.log(`PASS same-pool comparison: ${q.type}`);
 }
 for(const mode of ['keyword','vector','hybrid','rerank']){const r=out.queries.map(q=>q.modes[mode]);out.metrics[mode]=Object.fromEntries(['recallAt3','mrrAt5','ndcgAt5'].map(k=>[k,r.reduce((n,x)=>n+x[k],0)/r.length]));out.metrics[mode].meanTimings=Object.fromEntries(['keyword','vector','fusion','deduplication','rerank','revalidation','total'].map(k=>[k,r.reduce((n,x)=>n+(x.timings[k]||0),0)/r.length]));}
 fs.writeFileSync('artifacts/retrieval/final-evaluation.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out.metrics,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
