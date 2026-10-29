const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api='http://localhost:3000',stamp=Date.now(),report=[];
async function req(p,method='GET',body){const r=await fetch(api+p,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});assert(r.ok,await r.clone().text());return r.json();}
async function run(){
 const model=(await req('/api/models')).models.find(m=>m.kind==='embedding'&&m.active);
 for(const ext of ['pdf','docx','xlsx','pptx','csv']){
  const bytes=fs.readFileSync(path.join('artifacts/chunks/preview-samples',`source.${ext}`)),name=`来源预览验证-${stamp}.${ext}`,tus='http://localhost:1080/files/';
  const create=await fetch(tus,{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(bytes.length),'Upload-Metadata':`filename ${Buffer.from(name).toString('base64')}`}});assert.equal(create.status,201);const url=new URL(create.headers.get('location'),tus).href,id=url.split('/').pop();
  assert.equal((await fetch(url,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':'0','Content-Type':'application/offset+octet-stream'},body:bytes})).status,204);
  for(let i=0;i<40;i++){if((await req('/api/documents')).documents.some(d=>d.id===id&&d.status==='ready'))break;await new Promise(r=>setTimeout(r,250));}
  const v=await req(`/api/documents/${id}/parse`,'POST',{modelId:model.id});let done=false;
  for(let i=0;i<90;i++){const d=await req(`/api/documents/${id}/parsing?version=${v.versionId}`);assert.notEqual(d.version.status,'failed',d.version.error);if(d.version.status==='ready'){done=true;break;}await new Promise(r=>setTimeout(r,500));}assert(done);
  const chunks=(await req(`/api/documents/${id}/chunks`)).chunks;assert(chunks.length);const sources=chunks.map(c=>c.source);
  if(ext==='pdf'){assert(sources.some(s=>s.page===2||s.pages?.includes(2)));}
  if(ext==='docx'){assert(chunks.some(c=>c.section_path.includes('Operation manual')));assert(sources.every(s=>!s.page));assert(chunks.some(c=>c.content_type==='table'));}
  if(ext==='xlsx'){assert(sources.some(s=>s.sheet==='Bioreactor'&&s.row===2));assert(sources.some(s=>s.sheet==='Effluent'));assert(sources.every(s=>!s.page));}
  if(ext==='pptx')assert(sources.some(s=>s.slide===2));
  if(ext==='csv'){const positions=sources.flatMap(s=>s.positions||[s]);assert(positions.some(s=>s.row===4));}
  const preview=await req(`/api/documents/${id}/preview`);assert.equal(preview.kind,ext==='csv'?'text':'pdf');const file=await fetch(api+preview.url);assert.equal(file.status,200);const output=Buffer.from(await file.arrayBuffer());if(ext==='csv')assert(output.includes(Buffer.from('Second line')));else assert.equal(output.subarray(0,5).toString(),'%PDF-');
  report.push({id,name,versionId:v.versionId,kind:preview.kind,sources});console.log(`PASS ${ext}: actual parse metadata and ${preview.kind} original preview`);
 }
 fs.writeFileSync('artifacts/chunks/previews.json',JSON.stringify({result:'PASS',documents:report},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
