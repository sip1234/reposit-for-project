const crypto = require('node:crypto');
const manifest = require('../worker/parser_manifest.json');
const models = require('./models');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supported = new Set(['.pdf','.docx','.xlsx','.csv','.pptx','.txt','.doc','.ppt','.xls','.rtf','.odt','.odp','.ods']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function httpError(status,message,reason,details={}) {
  return Object.assign(new Error(message),{httpStatus:status,reason,details});
}
const chunkFields = `chunk_index,content,content_type,source,section_path,strategy,char_length,enabled,
  revision,vector_revision,row_version,embedding_state,embedding_job_id,error,updated_at,maintained_at,last_action`;
function validIndex(value) {
  const index=Number(value);
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(index)||index>2147483647) throw httpError(400,'分块序号无效','invalid_chunk');
  return index;
}
async function chunkStats(db,versionId) {
  return (await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled,
    count(*) FILTER(WHERE NOT enabled)::int AS disabled,
    count(*) FILTER(WHERE embedding_state='pending')::int AS pending,
    count(*) FILTER(WHERE embedding_state='processing')::int AS processing,
    count(*) FILTER(WHERE embedding_state='failed')::int AS failed,
    count(*) FILTER(WHERE embedding_state='ready')::int AS ready,
    count(*) FILTER(WHERE enabled AND embedding_state='ready' AND revision=vector_revision AND vector_norm(embedding)>0
      AND vector_dims(embedding)=(SELECT m.dimensions FROM parsing_versions v JOIN parsing_jobs j ON j.id=v.job_id JOIN ai_models m ON m.id=j.model_id WHERE v.id=$1))::int AS retrievable,
    count(*) FILTER(WHERE revision>0 OR row_version>0 OR NOT enabled)::int AS maintained
    FROM parsing_version_chunks WHERE version_id=$1`,[versionId])).rows[0];
}

function validateConfig(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('解析配置必须是对象');
  for (const key of Object.keys(input)) if (!Object.hasOwn(manifest.defaults,key)) throw new Error(`未知配置字段：${key}`);
  const c = { ...manifest.defaults, ...input };
  if (!['auto','text','ocr'].includes(c.method) || !['paragraph','section','table','qa'].includes(c.strategy)) throw new Error('解析方式或分块策略无效');
  if (c.lengthUnit !== 'unicode_char') throw new Error('长度单位必须为 Unicode 字符数');
  for (const key of ['targetLength','maxLength','overlapLength','headerRows']) if (!Number.isInteger(c[key])) throw new Error(`${key} 必须为整数`);
  if (c.targetLength < 100 || c.maxLength < c.targetLength || c.maxLength > 16000 || c.overlapLength < 0 || c.overlapLength >= c.targetLength / 2 || c.headerRows < 1 || c.headerRows > 5) throw new Error('长度须满足 100 ≤ 目标 ≤ 最大 ≤ 16000，0 ≤ 重叠 < 目标/2，表头行数为 1–5');
  for (const key of ['ocrEnabled','headerContext','sectionContext']) if (typeof c[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
  if (!['chi_sim+eng','chi_sim','eng'].includes(c.ocrLanguage)) throw new Error('不支持的 OCR 语言');
  if (c.method === 'ocr' && !c.ocrEnabled) throw new Error('强制 OCR 时必须启用 OCR');
  return c;
}

async function setup(pool) {
  // All schema changes and the one-time legacy import commit together.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(84271931)");
    await db.query(`CREATE TABLE IF NOT EXISTS parsing_configs (
      id uuid PRIMARY KEY, name text NOT NULL, config jsonb NOT NULL, config_hash text NOT NULL,
      config_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(config_hash,config_version));
      CREATE TABLE IF NOT EXISTS parsing_jobs (
      id uuid PRIMARY KEY, cache_key text NOT NULL UNIQUE, sha256 text NOT NULL,
      source_document_id text NOT NULL REFERENCES documents(id), extension text NOT NULL,
      model_id uuid NOT NULL REFERENCES ai_models(id), config_id uuid NOT NULL REFERENCES parsing_configs(id), parser_version text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed')),
      stage text NOT NULL DEFAULT 'waiting', progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      error text, warnings jsonb NOT NULL DEFAULT '[]', pages jsonb NOT NULL DEFAULT '[]', metrics jsonb NOT NULL DEFAULT '{}',
      page_count integer NOT NULL DEFAULT 0, block_count integer NOT NULL DEFAULT 0, chunk_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS parsing_blocks (
      job_id uuid NOT NULL REFERENCES parsing_jobs(id) ON DELETE CASCADE, block_index integer NOT NULL,
      content text NOT NULL, content_type text NOT NULL, source jsonb NOT NULL, section_path jsonb NOT NULL, PRIMARY KEY(job_id,block_index));
      CREATE TABLE IF NOT EXISTS parsing_artifact_chunks (
      job_id uuid NOT NULL REFERENCES parsing_jobs(id) ON DELETE CASCADE, chunk_index integer NOT NULL,
      content text NOT NULL, embedding vector NOT NULL, content_type text NOT NULL, source jsonb NOT NULL,
      section_path jsonb NOT NULL, strategy text NOT NULL, char_length integer NOT NULL, PRIMARY KEY(job_id,chunk_index));
      CREATE TABLE IF NOT EXISTS parsing_versions (
      id uuid PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), job_id uuid NOT NULL REFERENCES parsing_jobs(id),
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
      reused boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz);
      CREATE TABLE IF NOT EXISTS parsing_version_chunks (
      version_id uuid NOT NULL REFERENCES parsing_versions(id) ON DELETE CASCADE, chunk_index integer NOT NULL,
      content text NOT NULL, embedding vector NOT NULL, content_type text NOT NULL, source jsonb NOT NULL,
      section_path jsonb NOT NULL, strategy text NOT NULL, char_length integer NOT NULL, enabled boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 0, vector_revision integer NOT NULL DEFAULT 0,
      embedding_state text NOT NULL DEFAULT 'ready' CHECK(embedding_state IN ('ready','pending','failed')), error text,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version_id,chunk_index));
      CREATE TABLE IF NOT EXISTS parsing_chunk_updates (
      id uuid PRIMARY KEY, version_id uuid NOT NULL, chunk_index integer NOT NULL, revision integer NOT NULL, content text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed','superseded')),
      error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      FOREIGN KEY(version_id,chunk_index) REFERENCES parsing_version_chunks(version_id,chunk_index) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS parsing_events (
      id bigserial PRIMARY KEY,job_id uuid NOT NULL REFERENCES parsing_jobs(id) ON DELETE CASCADE,stage text NOT NULL,progress integer NOT NULL,
      details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS parsing_audit (
      id bigserial PRIMARY KEY,version_id uuid NOT NULL REFERENCES parsing_versions(id),action text NOT NULL,
      details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS active_parse_version_id uuid REFERENCES parsing_versions(id);
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS requested_parse_version_id uuid REFERENCES parsing_versions(id);
      CREATE INDEX IF NOT EXISTS parsing_versions_document_idx ON parsing_versions(document_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS parsing_jobs_queue_idx ON parsing_jobs(status,created_at);
      CREATE INDEX IF NOT EXISTS parsing_updates_queue_idx ON parsing_chunk_updates(status,created_at);`);
    await db.query(`ALTER TABLE parsing_version_chunks ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 0;
      ALTER TABLE parsing_version_chunks ADD COLUMN IF NOT EXISTS embedding_job_id uuid;
      ALTER TABLE parsing_version_chunks ADD COLUMN IF NOT EXISTS maintained_at timestamptz;
      ALTER TABLE parsing_version_chunks ADD COLUMN IF NOT EXISTS last_action text NOT NULL DEFAULT 'parse';
      ALTER TABLE parsing_chunk_updates ADD COLUMN IF NOT EXISTS started_at timestamptz;
      ALTER TABLE parsing_version_chunks DROP CONSTRAINT IF EXISTS parsing_version_chunks_embedding_state_check;
      ALTER TABLE parsing_version_chunks ADD CONSTRAINT parsing_version_chunks_embedding_state_check
        CHECK(embedding_state IN ('pending','processing','ready','failed'));
      CREATE INDEX IF NOT EXISTS parsing_chunk_filter_idx ON parsing_version_chunks(version_id,enabled,embedding_state,chunk_index);`);
    if(!(await db.query("SELECT 1 FROM app_migrations WHERE name='chunk-maintenance-v1'")).rowCount) {
      await db.query(`UPDATE parsing_version_chunks c SET embedding_job_id=u.id FROM (
        SELECT DISTINCT ON(version_id,chunk_index) id,version_id,chunk_index,revision
        FROM parsing_chunk_updates WHERE status IN ('pending','processing') ORDER BY version_id,chunk_index,created_at DESC,id DESC
      ) u WHERE c.version_id=u.version_id AND c.chunk_index=u.chunk_index AND c.revision=u.revision;
      UPDATE parsing_version_chunks c SET maintained_at=a.created_at,last_action=a.action FROM (
        SELECT DISTINCT ON(version_id,(details->>'chunkIndex')::integer) version_id,(details->>'chunkIndex')::integer AS chunk_index,created_at,action
        FROM parsing_audit WHERE details ? 'chunkIndex' ORDER BY version_id,(details->>'chunkIndex')::integer,id DESC
      ) a WHERE c.version_id=a.version_id AND c.chunk_index=a.chunk_index;
      UPDATE parsing_version_chunks c SET embedding_state='failed',error='向量与正文修订不一致或向量无效，请重试更新'
        FROM parsing_versions v JOIN parsing_jobs j ON j.id=v.job_id JOIN ai_models m ON m.id=j.model_id
        WHERE c.version_id=v.id AND c.embedding_state='ready'
        AND (c.revision<>c.vector_revision OR vector_norm(c.embedding)=0 OR vector_dims(c.embedding)<>m.dimensions);
      INSERT INTO app_migrations(name) VALUES('chunk-maintenance-v1');`);
    }
    const defaultId = crypto.randomUUID();
    const normalized = validateConfig();
    await db.query(`INSERT INTO parsing_configs(id,name,config,config_hash,config_version) VALUES($1,'通用段落 默认配置',$2,$3,$4) ON CONFLICT DO NOTHING`, [defaultId,normalized,hash(normalized),manifest.configVersion]);
    const legacyConfig = {...normalized,method:'text',targetLength:700,overlapLength:150,ocrEnabled:false,headerContext:false,sectionContext:false};
    await db.query(`INSERT INTO parsing_configs(id,name,config,config_hash,config_version) VALUES($1,'旧版兼容配置（仅长段落有重叠）',$2,$3,0) ON CONFLICT DO NOTHING`,[crypto.randomUUID(),legacyConfig,hash(legacyConfig)]);
    const legacyConfigId=(await db.query('SELECT id FROM parsing_configs WHERE config_hash=$1 AND config_version=0',[hash(legacyConfig)])).rows[0].id;
    const migrated = await db.query("SELECT 1 FROM app_migrations WHERE name='structured-parsing-v2'");
    if (!migrated.rowCount) {
      const legacy = (await db.query(`SELECT p.document_id,p.selected_at,j.* FROM document_parses p JOIN document_parse_jobs j ON j.id=p.job_id`)).rows;
      for (const old of legacy) {
        const jobId = crypto.randomUUID(), versionId = crypto.randomUUID();
        const ready = old.status === 'ready';
        // Cached legacy results remain usable, but cannot be reused as output of the new parser.
        await db.query(`INSERT INTO parsing_jobs(id,cache_key,sha256,source_document_id,extension,model_id,config_id,parser_version,status,stage,progress,error,chunk_count,finished_at,warnings)
          VALUES($1,$2,$3,$4,$5,$6,$7,'legacy-1',$8,$9,$10,$11,$12,now(),$13)`,
        [jobId,`legacy:${old.id}:${old.document_id}`,old.sha256,old.document_id,old.extension,old.embedding_model_id,legacyConfigId,ready?'ready':'failed',ready?'complete':'failed',ready?100:0,ready?null:(old.error||'旧版未完成任务，请在解析详情重新提交'),old.chunk_count,JSON.stringify(['旧版导入结果：长度和结构元数据不完整，建议使用新配置重新解析'])]);
        await db.query(`INSERT INTO parsing_versions(id,document_id,job_id,status,activated_at) VALUES($1,$2,$3,$4,$5)`,[versionId,old.document_id,jobId,ready?'ready':'failed',ready?old.selected_at:null]);
        if (ready) {
          await db.query(`INSERT INTO parsing_version_chunks(version_id,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length)
            SELECT $1,chunk_index,content,embedding,'text',jsonb_build_object('locator',locator),'[]','legacy',char_length(content) FROM document_parse_chunks WHERE job_id=$2`,[versionId,old.id]);
          await db.query('UPDATE documents SET active_parse_version_id=$2 WHERE id=$1',[old.document_id,versionId]);
        }
        await db.query('UPDATE documents SET requested_parse_version_id=$2 WHERE id=$1',[old.document_id,versionId]);
      }
      await db.query("INSERT INTO app_migrations(name) VALUES('structured-parsing-v2')");
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}

async function attachSummaries(pool, rows) {
  if (!rows.length) return rows;
  const data = (await pool.query(`SELECT d.id,d.active_parse_version_id,d.requested_parse_version_id,
    CASE WHEN v.status='pending' AND j.status='ready' THEN 'processing' ELSE j.status END AS status,
    CASE WHEN v.status='pending' AND j.status='ready' THEN 'publishing' ELSE j.stage END AS stage,
    CASE WHEN v.status='pending' AND j.status='ready' THEN 99 ELSE j.progress END AS progress,
    j.error,j.chunk_count,j.model_id,m.name AS model_name,
    ac.chunk_count AS active_chunks
    FROM documents d LEFT JOIN parsing_versions v ON v.id=COALESCE(d.requested_parse_version_id,d.active_parse_version_id)
    LEFT JOIN parsing_jobs j ON j.id=v.job_id LEFT JOIN ai_models m ON m.id=j.model_id
    LEFT JOIN parsing_versions av ON av.id=d.active_parse_version_id LEFT JOIN parsing_jobs ac ON ac.id=av.job_id
    WHERE d.id=ANY($1::text[])`,[rows.map(r=>r.id)])).rows;
  const byId = new Map(data.map(d=>[d.id,d]));
  return rows.map(row=> { const d=byId.get(row.id); return { ...row,
    indexStatus:d?.status || row.indexStatus, indexChunks:d?.chunk_count ?? row.indexChunks,
    indexError:d?.error || null,indexModelId:d?.model_id || row.indexModelId,indexModelName:d?.model_name || row.indexModelName,
    parseStage:d?.stage,parseProgress:d?.progress,activeVersionId:d?.active_parse_version_id,
    requestedVersionId:d?.requested_parse_version_id,activeChunks:d?.active_chunks || 0 };
  });
}

async function publish(db, versionId, jobId, documentId) {
  await db.query(`INSERT INTO parsing_version_chunks(version_id,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length)
    SELECT $1,chunk_index,content,embedding,content_type,source,section_path,strategy,char_length FROM parsing_artifact_chunks WHERE job_id=$2`,[versionId,jobId]);
  await db.query("UPDATE parsing_versions SET status='ready',activated_at=now() WHERE id=$1",[versionId]);
  await db.query('UPDATE documents SET active_parse_version_id=$2 WHERE id=$1 AND requested_parse_version_id=$2',[documentId,versionId]);
}

async function requestParse(pool, documentId, body) {
  if (!uuid.test(body?.modelId || '')) throw new Error('请选择有效的向量模型');
  if (body.force !== undefined && typeof body.force !== 'boolean') throw new Error('force 必须为布尔值');
  if(body.acknowledgeEdits!==undefined&&typeof body.acknowledgeEdits!=='boolean') throw new Error('acknowledgeEdits 必须为布尔值');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const doc=(await db.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE",[documentId])).rows[0];
    if (!doc || doc.status!=='ready' || !doc.sha256) throw new Error('文件尚未保存完成');
    if (!supported.has(doc.extension)) throw new Error('不支持此文件格式');
    const maintained=doc.active_parse_version_id ? (await chunkStats(db,doc.active_parse_version_id)).maintained:0;
    if(maintained&&!body.acknowledgeEdits) throw httpError(409,
      `当前有效版本有 ${maintained} 个分块经过人工维护。新解析版本不继承正文编辑和启停状态，旧版本保留只读历史。请确认此行为后重新提交。`,
      'reparse_requires_ack',{maintainedChunks:maintained});
    const model=(await db.query("SELECT * FROM ai_models WHERE id=$1 AND kind='embedding' AND provider='ollama'",[body.modelId])).rows[0];
    if (!model) throw new Error('向量模型不存在');
    let config;
    if (body.configId) {
      if (!uuid.test(body.configId)) throw new Error('配置标识无效');
      config=(await db.query('SELECT * FROM parsing_configs WHERE id=$1',[body.configId])).rows[0];
    } else config=(await db.query('SELECT * FROM parsing_configs WHERE config_hash=$1 AND config_version=$2',[hash(validateConfig()),manifest.configVersion])).rows[0];
    if (!config) throw new Error('解析配置不存在');
    validateConfig(config.config);
    const baseKey=hash([doc.sha256,doc.extension,model.id,model.model_name,model.dimensions,config.config_hash,config.config_version,manifest.parserVersion]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[baseKey]);
    let job=!body.force && (await db.query("SELECT * FROM parsing_jobs WHERE (cache_key=$1 OR cache_key LIKE $1||':%') AND status<>'failed' ORDER BY created_at DESC LIMIT 1",[baseKey])).rows[0];
    if (job?.status==='failed') job=null;
    let reused=Boolean(job);
    if (!job) {
      const key=body.force || (await db.query('SELECT 1 FROM parsing_jobs WHERE cache_key=$1',[baseKey])).rowCount ? `${baseKey}:${crypto.randomUUID()}`:baseKey;
      job=(await db.query(`INSERT INTO parsing_jobs(id,cache_key,sha256,source_document_id,extension,model_id,config_id,parser_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[crypto.randomUUID(),key,doc.sha256,doc.id,doc.extension,model.id,config.id,manifest.parserVersion])).rows[0];
    }
    if(!reused) await db.query("INSERT INTO parsing_events(job_id,stage,progress) VALUES($1,'waiting',0)",[job.id]);
    const versionId=crypto.randomUUID();
    await db.query('INSERT INTO parsing_versions(id,document_id,job_id,reused) VALUES($1,$2,$3,$4)',[versionId,doc.id,job.id,reused]);
    await db.query("INSERT INTO parsing_audit(version_id,action,details) VALUES($1,'request',$2)",[versionId,{force:Boolean(body.force),reused}]);
    await db.query('UPDATE documents SET requested_parse_version_id=$2 WHERE id=$1',[doc.id,versionId]);
    if (job.status==='ready') await publish(db,versionId,job.id,doc.id);
    await db.query('COMMIT');
    return {versionId,jobId:job.id,status:job.status,reused,activePreserved:Boolean(doc.active_parse_version_id),editsInherited:false};
  } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
}

async function versionFor(pool,documentId,id) {
  return (await pool.query(`SELECT v.*,j.status AS job_status,
    CASE WHEN v.status='pending' AND j.status='ready' THEN 'publishing' ELSE j.stage END AS stage,
    CASE WHEN v.status='pending' AND j.status='ready' THEN 99 ELSE j.progress END AS progress,
    j.error,j.warnings,j.pages,j.metrics,j.page_count,j.block_count,j.chunk_count,
    j.started_at,j.finished_at,j.parser_version,j.model_id,j.config_id,c.name AS config_name,c.config,c.config_version,m.name AS model_name,m.model_name AS model_identifier,m.dimensions,
    d.active_parse_version_id=v.id AS active,d.requested_parse_version_id=v.id AS requested
    FROM parsing_versions v JOIN parsing_jobs j ON j.id=v.job_id JOIN parsing_configs c ON c.id=j.config_id
    JOIN ai_models m ON m.id=j.model_id JOIN documents d ON d.id=v.document_id WHERE v.document_id=$1 AND v.id=$2`,[documentId,id])).rows[0];
}

async function handle(pool,req,res,url,send,readBody) {
  const path=url.pathname;
  if (path==='/api/parsing/configs') {
    if(req.method==='GET') return send(res,200,{...manifest,configs:(await pool.query('SELECT * FROM parsing_configs ORDER BY created_at')).rows});
    if(req.method==='POST') {
      const body=await readBody(req); const config=validateConfig(body.config); const name=String(body.name||'').trim();
      if(!name || name.length>80) throw new Error('配置名称须为 1–80 字');
      const row=(await pool.query(`INSERT INTO parsing_configs(id,name,config,config_hash,config_version) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(config_hash,config_version) DO UPDATE SET config_hash=EXCLUDED.config_hash RETURNING *`,[crypto.randomUUID(),name,config,hash(config),manifest.configVersion])).rows[0];
      return send(res,201,row);
    }
    return send(res,405,{error:'不支持此操作'});
  }
  const match=/^\/api\/documents\/([A-Za-z0-9_-]{8,256})\/(parse|parsing|chunks|retrieval-test)(?:\/(\d+))?$/.exec(path);
  if(!match) return send(res,404,{error:'解析接口不存在或文件标识无效'});
  const [,docId,action,chunkIndex]=match;
  if(chunkIndex!==undefined&&action!=='chunks') return send(res,404,{error:'此接口不支持分块序号'});
  const doc=(await pool.query('SELECT id,filename,extension,status,active_parse_version_id,requested_parse_version_id FROM documents WHERE id=$1',[docId])).rows[0];
  if(!doc) return send(res,404,{error:'文件不存在'});
  if(action==='parse' && req.method==='POST') return send(res,202,await requestParse(pool,docId,await readBody(req)));
  if(action==='parsing' && req.method==='GET') {
    const id=url.searchParams.get('version') || doc.active_parse_version_id || doc.requested_parse_version_id;
    if(id && !uuid.test(id)) throw new Error('解析版本无效');
    const version=id?await versionFor(pool,docId,id):null;
    if(id && !version) return send(res,404,{error:'解析版本不存在或不属于此文件'});
    const versions=(await pool.query(`SELECT v.id,v.status,v.created_at,j.parser_version,j.stage,c.name AS config_name FROM parsing_versions v
      JOIN parsing_jobs j ON j.id=v.job_id JOIN parsing_configs c ON c.id=j.config_id WHERE v.document_id=$1 ORDER BY v.created_at DESC LIMIT 100`,[docId])).rows;
    const events=version?(await pool.query('SELECT stage,progress,details,created_at FROM parsing_events WHERE job_id=$1 ORDER BY id DESC LIMIT 100',[version.job_id])).rows.reverse():[];
    const audit=version?(await pool.query('SELECT action,details,created_at FROM parsing_audit WHERE version_id=$1 ORDER BY id DESC LIMIT 100',[version.id])).rows:[];
    const activeVersion=doc.active_parse_version_id===id?version:(doc.active_parse_version_id?await versionFor(pool,docId,doc.active_parse_version_id):null);
    const requestedVersion=doc.requested_parse_version_id===id?version:(doc.requested_parse_version_id?await versionFor(pool,docId,doc.requested_parse_version_id):null);
    const stats=version?await chunkStats(pool,version.id):null;
    const activeStats=activeVersion?(activeVersion.id===version?.id?stats:await chunkStats(pool,activeVersion.id)):null;
    return send(res,200,{document:doc,version,activeVersion,requestedVersion,versions,events,audit,
      stats,activeStats,editsInherited:false});
  }
  if(action==='retrieval-test' && req.method==='POST') {
    const body=await readBody(req,128*1024);
    if(!body?.knowledgeBaseIds&&!doc.active_parse_version_id)return send(res,409,{error:'此文件尚无有效解析版本，请先解析或选择知识库'});
    return send(res,200,await require('./retrieval').test(pool,docId,body));
  }
  const id=url.searchParams.get('version') || doc.active_parse_version_id;
  if(id&&!uuid.test(id)) throw httpError(400,'解析版本标识无效','invalid_version');
  if(!id) return send(res,409,{error:'此文件尚无可用解析版本'});
  const version=await versionFor(pool,docId,id);
  if(!version) return send(res,404,{error:'解析版本不存在或不属于此文档'});
  if(version.status!=='ready') return send(res,409,{error:'此解析版本尚未完成'});
  if(action==='chunks' && req.method==='GET') {
    if(chunkIndex!==undefined) {
      const index=validIndex(chunkIndex);
      const chunk=(await pool.query(`SELECT ${chunkFields} FROM parsing_version_chunks WHERE version_id=$1 AND chunk_index=$2`,[id,index])).rows[0];
      if(!chunk) return send(res,404,{error:'分块不存在或不属于此解析版本'});
      const audit=(await pool.query(`SELECT id,action,details,created_at FROM parsing_audit
        WHERE version_id=$1 AND details->>'chunkIndex'=$2 ORDER BY id DESC LIMIT 30`,[id,String(index)])).rows;
      const task=chunk.embedding_job_id?(await pool.query('SELECT id,status,error,created_at,started_at,finished_at FROM parsing_chunk_updates WHERE id=$1',[chunk.embedding_job_id])).rows[0]:null;
      return send(res,200,{chunk,versionId:id,editable:version.active,audit,task});
    }
    const page=Number(url.searchParams.get('page')||1),size=20;
    if(!Number.isInteger(page)||page<1||page>100000) throw new Error('分页参数无效');
    const q=(url.searchParams.get('q')||'').trim();
    const enabled=url.searchParams.get('enabled')||'all',state=url.searchParams.get('state')||'all';
    if(Array.from(q).length>200||!['all','enabled','disabled'].includes(enabled)||!['all','pending','processing','ready','failed'].includes(state)) throw new Error('搜索或筛选参数无效');
    const where=`version_id=$1 AND ($2='' OR position(lower($2) in lower(content))>0)
      AND ($3='all' OR enabled=($3='enabled')) AND ($4='all' OR embedding_state=$4)`;
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stats=await chunkStats(db,id);
      const count=await db.query(`SELECT count(*)::int AS total FROM parsing_version_chunks WHERE ${where}`,[id,q,enabled,state]);
      const chunks=(await db.query(`SELECT ${chunkFields} FROM parsing_version_chunks WHERE ${where} ORDER BY chunk_index LIMIT $5 OFFSET $6`,[id,q,enabled,state,size,(page-1)*size])).rows;
      await db.query('COMMIT');
      return send(res,200,{chunks,total:count.rows[0].total,stats,page,pageSize:size,versionId:id,editable:version.active});
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  if(action==='chunks' && chunkIndex!==undefined && req.method==='PATCH') {
    const body=await readBody(req,128*1024),index=validIndex(chunkIndex);
    if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error('请求必须为对象');
    if(Object.keys(body).some(key=>!['revision','rowVersion','content','enabled','retry'].includes(key))) throw new Error('未知的分块维护字段');
    if(!Number.isInteger(body.revision)||body.revision<0||!Number.isInteger(body.rowVersion)||body.rowVersion<0) throw new Error('缺少正文修订号或操作版本，请刷新后再试');
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean') throw new Error('启用状态无效');
    if(body.retry!==undefined&&typeof body.retry!=='boolean') throw new Error('retry 必须为布尔值');
    if(body.content!==undefined&&(typeof body.content!=='string'||!body.content.trim()||body.content.includes('\0')||Array.from(body.content).length>16000)) throw new Error('正文须为 1–16000 个 Unicode 字符，且不含 NUL 字符');
    if(body.content===undefined&&body.enabled===undefined&&body.retry!==true) throw new Error('没有需要保存的维护操作');
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const locked=(await db.query('SELECT active_parse_version_id FROM documents WHERE id=$1 FOR UPDATE',[docId])).rows[0];
      if(!locked||locked.active_parse_version_id!==id) throw httpError(409,'有效解析版本已改变或当前查看的是历史版本。请保留草稿，刷新并核对当前有效版本。','version_changed');
      const row=(await db.query('SELECT * FROM parsing_version_chunks WHERE version_id=$1 AND chunk_index=$2 FOR UPDATE',[id,index])).rows[0];
      if(!row) throw httpError(404,'分块不存在或不属于此文档版本','chunk_not_found');
      if(row.revision!==body.revision||row.row_version!==body.rowVersion) throw httpError(409,'分块已在另一个页面更新。草稿尚未保存，请刷新并核对内容和启用状态。','chunk_conflict',{revision:row.revision,rowVersion:row.row_version});
      const content=body.content??row.content,enabled=body.enabled??row.enabled;
      const changed=content!==row.content,toggled=enabled!==row.enabled,queue=changed||body.retry===true;
      if(!changed&&!toggled&&!queue){await db.query('COMMIT');return send(res,200,{revision:row.revision,rowVersion:row.row_version,embeddingState:row.embedding_state,changed:false});}
      const revision=row.revision+(changed?1:0),rowVersion=row.row_version+1,jobId=queue?crypto.randomUUID():row.embedding_job_id;
      const action=changed?'edit':body.retry===true?'retry_embedding':enabled?'enable':'disable';
      await db.query(`UPDATE parsing_version_chunks SET content=$3,char_length=char_length($3),enabled=$4,revision=$5,row_version=$6,
        embedding_state=CASE WHEN $7 THEN 'pending' ELSE embedding_state END,
        embedding_job_id=$8,error=CASE WHEN $7 THEN NULL ELSE error END,
        updated_at=now(),maintained_at=now(),last_action=$9 WHERE version_id=$1 AND chunk_index=$2`,
        [id,index,content,enabled,revision,rowVersion,queue,jobId,action]);
      if(queue) await db.query('INSERT INTO parsing_chunk_updates(id,version_id,chunk_index,revision,content) VALUES($1,$2,$3,$4,$5)',[jobId,id,index,revision,content]);
      await db.query('INSERT INTO parsing_audit(version_id,action,details) VALUES($1,$2,$3)',[id,action,{chunkIndex:index,revision,rowVersion,vectorRevision:row.vector_revision,previousRevision:row.revision,previousEnabled:row.enabled,enabled,jobId:queue?jobId:null,contentHash:hash(content)}]);
      await db.query('COMMIT');
      return send(res,202,{revision,rowVersion,embeddingState:queue?'pending':row.embedding_state,jobId:queue?jobId:null,changed:true,scope:'仅此文档的此解析版本；引用此文档的知识库同步生效'});
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }

  return send(res,405,{error:'不支持此操作'});
}

async function safeHandle(pool,req,res,url,send,readBody) {
  try { return await handle(pool,req,res,url,send,readBody); }
  catch(error) {
    if(error.code&&!error.httpStatus) console.error('Parsing database error', error);
    return send(res,error.httpStatus||(error.code?500:400),{error:error.code&&!error.httpStatus?'解析数据库操作失败，请检查服务日志':error.message,
      code:error.reason,runId:error.runId,retrieval:error.retrieval,...error.details});
  }
}
module.exports={setup,handle:safeHandle,requestParse,attachSummaries,validateConfig,manifest};
