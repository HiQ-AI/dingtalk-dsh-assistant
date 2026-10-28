import {installObserverArtifactBindings} from './observer-artifact-bindings.js'
import {installObserverEvidencePages} from './observer-evidence-pages.js'
import {randomUUID} from 'node:crypto'
const incarnations=new WeakMap()
const problem=code=>Object.assign(new Error(code),{code})
export function installObserverTracePages(db,{migrate=false}={}){
 const ready=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_trace_index'").get()
 if(ready){
  const required=['observer_evidence_text','observer_evidence_chunks','observer_evidence_bindings','observer_artifact_page_bindings',...(db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_sources'").get()?['observer_topic_source_index','observer_topic_fact_sources']:[])]
  const complete=required.every(name=>db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))
  if(!complete&&migrate)throw problem('OBSERVER_PAGINATION_PARTIAL_SCHEMA_REQUIRES_REBUILD')
  return complete
 }
 if(!migrate)return false
 db.exec('SAVEPOINT observer_trace_migration')
 try{
  db.exec(`CREATE TABLE observer_trace_index(trace_run_id TEXT,item_id TEXT,kind TEXT,sort_key TEXT,id TEXT,PRIMARY KEY(trace_run_id,item_id));
  CREATE INDEX observer_trace_page ON observer_trace_index(trace_run_id,sort_key,id);`)
  const itemSelect=(where)=>`SELECT i.run_id,i.item_id,i.kind,coalesce(json_extract(i.body,'$.createdAt'),''),CASE i.kind WHEN 'node' THEN json_extract(i.body,'$.nodeRunId') WHEN 'agent-execution' THEN 'agent:'||json_extract(i.body,'$.commandId') ELSE coalesce(json_extract(i.body,'$.commandId'),json_extract(i.body,'$.id')) END FROM message_items i ${where} AND i.kind IN ('node','command','agent-execution')`
  const shared=(where)=>`SELECT DISTINCT json_extract(u.value,'$.runId'),i.item_id,i.kind,coalesce(json_extract(i.body,'$.createdAt'),''),json_extract(i.body,'$.nodeRunId') FROM message_items i,json_each(i.body,'$.input.units') u ${where} AND i.kind='node' AND json_extract(i.body,'$.nodeId')='IB' AND json_extract(u.value,'$.runId') IS NOT NULL`
  const coordinator=(where)=>`SELECT r.run_id,'@coordinator:'||r.run_id,'coordinator',coalesce(json_extract(r.body,'$.createdAt'),''),json_extract(r.body,'$.coordinatorConsumed.turnId') FROM message_runs r ${where} AND json_type(r.body,'$.coordinatorConsumed')='object'`
  db.exec(`INSERT OR REPLACE INTO observer_trace_index ${itemSelect('WHERE true')};INSERT OR REPLACE INTO observer_trace_index ${shared('WHERE true')};INSERT OR REPLACE INTO observer_trace_index ${coordinator('WHERE true')};`)
  for(const event of ['INSERT','UPDATE','DELETE']){
   const row=event==='DELETE'?'OLD':'NEW'
   db.exec(`CREATE TRIGGER observer_trace_item_${event.toLowerCase()} AFTER ${event} ON message_items BEGIN DELETE FROM observer_trace_index WHERE item_id=${row}.item_id;${event==='DELETE'?'':`INSERT OR REPLACE INTO observer_trace_index ${itemSelect('WHERE i.item_id=NEW.item_id')};INSERT OR REPLACE INTO observer_trace_index ${shared('WHERE i.item_id=NEW.item_id')};`} END;`)
   db.exec(`CREATE TRIGGER observer_trace_run_${event.toLowerCase()} AFTER ${event} ON message_runs BEGIN DELETE FROM observer_trace_index WHERE item_id='@coordinator:'||${row}.run_id;${event==='DELETE'?'':`INSERT OR REPLACE INTO observer_trace_index ${coordinator('WHERE r.run_id=NEW.run_id')};`} END;`)
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_sources'").get()){
   db.exec(`CREATE TABLE observer_topic_source_index(source_key TEXT PRIMARY KEY,run_id TEXT,sort_key TEXT);
   CREATE INDEX observer_topic_source_order ON observer_topic_source_index(sort_key,source_key);
   CREATE INDEX observer_topic_bindings_topic ON message_topic_bindings(topic_id,source_key);
   CREATE TABLE observer_topic_fact_sources(topic_id TEXT,fact_id TEXT,source_key TEXT,position INTEGER);
   CREATE INDEX observer_topic_fact_source_lookup ON observer_topic_fact_sources(topic_id,fact_id,source_key);
   INSERT INTO observer_topic_fact_sources SELECT f.topic_id,f.fact_id,json_extract(ref.value,'$.sourceKey'),f.rowid FROM message_topic_facts f,json_each(f.body,'$.sourceRefs') ref WHERE f.status='active';`)
   const refresh=where=>`INSERT OR REPLACE INTO observer_topic_source_index SELECT r.source_key,r.run_id,coalesce(json_extract(r.body,'$.context.occurredAt'),json_extract(r.body,'$.createdAt'),'') FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=r.source_version ${where};`
   for(const event of ['INSERT','UPDATE','DELETE']){
    const row=event==='DELETE'?'OLD':'NEW'
    db.exec(`CREATE TRIGGER observer_topic_fact_${event.toLowerCase()} AFTER ${event} ON message_topic_facts BEGIN DELETE FROM observer_topic_fact_sources WHERE topic_id=${row}.topic_id AND fact_id=${row}.fact_id;${event==='DELETE'?'':"INSERT INTO observer_topic_fact_sources SELECT NEW.topic_id,NEW.fact_id,json_extract(ref.value,'$.sourceKey'),NEW.rowid FROM json_each(NEW.body,'$.sourceRefs') ref WHERE NEW.status='active';"} END;`)
   }
   db.exec(refresh(''))
   for(const table of ['message_runs','message_sources'])for(const event of ['INSERT','UPDATE','DELETE']){
    const row=event==='DELETE'?'OLD':'NEW'
    db.exec(`CREATE TRIGGER observer_topic_source_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN DELETE FROM observer_topic_source_index WHERE source_key=${row}.source_key;${refresh('WHERE r.source_key='+row+'.source_key')} END;`)
   }
  }
  installObserverEvidencePages(db)
  installObserverArtifactBindings(db)
  db.exec('RELEASE observer_trace_migration');return true
 }catch(cause){db.exec('ROLLBACK TO observer_trace_migration; RELEASE observer_trace_migration');throw cause}
}
export function observerTracePage(db,{runId,offset=0,limit=50,revision,unitCursor=0}){
 if(!Number.isSafeInteger(unitCursor)||unitCursor<0)throw problem('MESSAGE_INVALID_LIMIT')
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw problem('MESSAGE_INVALID_LIMIT')
 if(!installObserverTracePages(db))throw problem('OBSERVER_PAGINATION_MIGRATION_REQUIRED')
 if(!incarnations.has(db))incarnations.set(db,randomUUID())
 const currentRevision=`${incarnations.get(db)}:${db.prepare('SELECT total_changes() n').get().n}`
 if(unitCursor>0&&!revision)throw problem('OBSERVER_PAGE_STALE')
 if(revision&&revision!==currentRevision)throw problem('OBSERVER_PAGE_STALE')
 const row=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
 if(!row)return null
 const run=JSON.parse(row.body), total=db.prepare('SELECT count(*) n FROM observer_trace_index WHERE trace_run_id=?').get(runId).n
 const entries=db.prepare('SELECT item_id,kind FROM observer_trace_index WHERE trace_run_id=? ORDER BY sort_key,id LIMIT ? OFFSET ?').all(runId,limit,offset)
 const data={run,nodes:[],commands:[],executions:[],requests:[],units:[]}
 if(!entries.some(item=>item.kind==='coordinator'))delete run.coordinatorConsumed
 for(const entry of entries){
  if(entry.kind==='coordinator'){
   const active="run_id=? AND kind='unit' AND coalesce(json_extract(body,'$.status'),'')!='superseded'"
   const rows=db.prepare(`SELECT rowid AS cursor,json_object('id',json_extract(body,'$.id'),'status',json_extract(body,'$.status'),'goalText',json_extract(body,'$.goalText'),'routingBinding',json_extract(body,'$.routingBinding')) body FROM message_items WHERE ${active} AND rowid>? ORDER BY rowid LIMIT 101`).all(runId,unitCursor)
   data.units=rows.slice(0,100).map(row=>JSON.parse(row.body))
   data.coordinatorUnits={cursor:unitCursor,limit:100,total:db.prepare(`SELECT count(*) n FROM message_items WHERE ${active}`).get(runId).n,returned:data.units.length,nextCursor:rows.length>100?rows[99].cursor:null,complete:unitCursor===0&&rows.length<=100}
   continue
  }
  const item=JSON.parse(db.prepare('SELECT body FROM message_items WHERE item_id=?').get(entry.item_id).body)
  if(entry.kind==='node')data.nodes.push({...item,carrierRunId:item.runId})
  else if(entry.kind==='command')data.commands.push(item)
  else{
   data.executions.push(item)
   const request=db.prepare('SELECT body FROM message_items WHERE item_id=?').get(`request:${item.requestId}`)
   if(request)data.requests.push(JSON.parse(request.body))
  }
 }
 return {data,total,offset,revision:currentRevision,nextCursor:offset+entries.length<total?offset+entries.length:null}
}
