import {createHash} from 'node:crypto'
const error=code=>Object.assign(new Error(code),{code})
const ready=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_evidence_text'").get()
const hash=text=>createHash('sha256').update(JSON.stringify(text)).digest('hex')
export function installObserverEvidencePages(db){
 if(ready(db))return
 db.exec(`CREATE TABLE observer_evidence_text(run_id TEXT,resource_ref TEXT,origin TEXT,priority INTEGER,position TEXT,hash TEXT,total_length INTEGER,total_bytes INTEGER,source_version INTEGER,PRIMARY KEY(run_id,resource_ref,origin));
 CREATE INDEX observer_evidence_origin ON observer_evidence_text(origin);
 CREATE INDEX observer_evidence_lookup ON observer_evidence_text(run_id,resource_ref,priority,position);
 CREATE TABLE observer_evidence_chunks(run_id TEXT,resource_ref TEXT,origin TEXT,start INTEGER,end INTEGER,text TEXT,PRIMARY KEY(run_id,resource_ref,origin,start));
 CREATE INDEX observer_evidence_chunk_range ON observer_evidence_chunks(run_id,resource_ref,origin,start,end);
 CREATE TABLE observer_evidence_bindings(run_id TEXT,resource_ref TEXT,origin TEXT,kind TEXT,evidence_refs TEXT,PRIMARY KEY(run_id,resource_ref,origin));
 CREATE TRIGGER observer_evidence_item_delete AFTER DELETE ON message_items BEGIN
 DELETE FROM observer_evidence_text WHERE origin=OLD.kind||':'||coalesce(json_extract(OLD.body,'$.id'),json_extract(OLD.body,'$.nodeRunId'),json_extract(OLD.body,'$.commandId'));
 DELETE FROM observer_evidence_chunks WHERE origin=OLD.kind||':'||coalesce(json_extract(OLD.body,'$.id'),json_extract(OLD.body,'$.nodeRunId'),json_extract(OLD.body,'$.commandId'));
 DELETE FROM observer_evidence_bindings WHERE origin=OLD.kind||':'||coalesce(json_extract(OLD.body,'$.id'),json_extract(OLD.body,'$.nodeRunId'),json_extract(OLD.body,'$.commandId')); END;
 CREATE TRIGGER observer_evidence_run_delete AFTER DELETE ON message_runs BEGIN
 DELETE FROM observer_evidence_text WHERE run_id=OLD.run_id;
 DELETE FROM observer_evidence_chunks WHERE run_id=OLD.run_id;
 DELETE FROM observer_evidence_bindings WHERE run_id=OLD.run_id; END;`)
 // Materialize a bounded batch before writing derived tables. Never keep a
 // live read iterator across writes, or retain every historical JSON body.
 const backfill=(table,columns,condition,consume)=>{
  const last=db.prepare(`SELECT coalesce(max(rowid),0) n FROM ${table}`).get().n
  const select=db.prepare(`SELECT rowid AS sequence_id,${columns} FROM ${table} WHERE rowid>? AND rowid<=? AND (${condition}) ORDER BY rowid LIMIT 32`)
  let cursor=0
  for(;;){const batch=select.all(cursor,last);if(!batch.length)break;for(const row of batch)consume(row);cursor=batch.at(-1).sequence_id}
 }
 backfill('message_runs','body',"json_type(body,'$.snapshot.source.text')='text' OR EXISTS(SELECT 1 FROM json_each(body,'$.snapshot.quotes') ref WHERE CASE WHEN ref.type='object' THEN json_type(ref.value,'$.text') END='text') OR EXISTS(SELECT 1 FROM json_each(body,'$.snapshot.history') ref WHERE CASE WHEN ref.type='object' THEN json_type(ref.value,'$.text') END='text')",row=>indexObserverRunEvidence(db,JSON.parse(row.body)))
 backfill('message_items','run_id,kind,body',"(kind='material' AND json_type(body,'$.material.text')='text') OR (kind='node' AND json_array_length(body,'$.input.sharedTopic.sources')>0) OR (kind='agent-execution' AND (json_type(body,'$.resultRef')='text' OR json_array_length(body,'$.result.evidenceRefs')>0))",row=>indexObserverItemEvidence(db,row.run_id,row.kind,JSON.parse(row.body)))
}
function record(db,runId,resourceRef,origin,priority,position,material){
 if(typeof resourceRef!=='string'||typeof material?.text!=='string')return
 const currentHash=hash(material.text),old=db.prepare('SELECT hash,source_version,priority,position FROM observer_evidence_text WHERE run_id=? AND resource_ref=? AND origin=?').get(runId,resourceRef,origin)
 if(old?.hash===currentHash){if(old.source_version!==(material.sourceVersion??null)||old.priority!==priority||old.position!==String(position))db.prepare('UPDATE observer_evidence_text SET source_version=?,priority=?,position=? WHERE run_id=? AND resource_ref=? AND origin=?').run(material.sourceVersion??null,priority,String(position),runId,resourceRef,origin);return}
 db.prepare('DELETE FROM observer_evidence_chunks WHERE run_id=? AND resource_ref=? AND origin=?').run(runId,resourceRef,origin)
 db.prepare('INSERT OR REPLACE INTO observer_evidence_text VALUES(?,?,?,?,?,?,?,?,?)').run(runId,resourceRef,origin,priority,position,currentHash,material.text.length,Buffer.byteLength(material.text),material.sourceVersion??null)
 const put=db.prepare('INSERT INTO observer_evidence_chunks VALUES(?,?,?,?,?,?)')
 for(let start=0;start<material.text.length;){let end=Math.min(material.text.length,start+4096);if(end<material.text.length&&/[\uD800-\uDBFF]/u.test(material.text[end-1]))end--;put.run(runId,resourceRef,origin,start,end,material.text.slice(start,end));start=end}
}
function pruneOrigin(db,runId,origin,refs){
 const encoded=JSON.stringify(refs)
 for(const table of ['observer_evidence_text','observer_evidence_chunks'])db.prepare(`DELETE FROM ${table} WHERE run_id=? AND origin=? AND resource_ref NOT IN (SELECT value FROM json_each(?))`).run(runId,origin,encoded)
}
export function indexObserverRunEvidence(db,run){
 if(!ready(db))return
 const seen=new Set(),origin='snapshot'
 for(const [position,ref]of [run.snapshot?.source,...(run.snapshot?.quotes??[]),...(run.snapshot?.history??[])].entries())if(ref&&typeof ref.text==='string'&&!seen.has(ref.sourceKey)){seen.add(ref.sourceKey);record(db,run.runId,ref.sourceKey,origin,2,String(position).padStart(10,'0'),ref)}
 pruneOrigin(db,run.runId,origin,[...seen])
}
export function indexObserverItemEvidence(db,runId,kind,item){
 if(!ready(db)||!['material','node','agent-execution'].includes(kind))return
 const origin=kind+':'+(item.id??item.nodeRunId??item.commandId)
 const runIds=new Set([runId,...(kind==='node'&&item.nodeId==='IB'?(item.input?.units??[]).map(unit=>unit.runId).filter(Boolean):[])])
 const previous=db.prepare('SELECT DISTINCT run_id FROM observer_evidence_text WHERE origin=?').all(origin)
 for(const {run_id}of previous)if(!runIds.has(run_id))pruneOrigin(db,run_id,origin,[])
 db.prepare('DELETE FROM observer_evidence_bindings WHERE origin=?').run(origin)
 for(const target of runIds){
  const seen=new Set()
  if(kind==='material'){seen.add(item.resourceRef);record(db,target,item.resourceRef,origin,0,'0',item.material)}
  if(kind==='node')for(const [position,ref]of (item.input?.sharedTopic?.sources??[]).entries())if(typeof ref?.text==='string'&&!seen.has(ref.sourceKey)){seen.add(ref.sourceKey);record(db,target,ref.sourceKey,origin,3,`${item.createdAt??''}\0${item.nodeRunId??item.id}\0${String(position).padStart(10,'0')}`,ref)}
  pruneOrigin(db,target,origin,[...seen])
 }
 if(kind==='agent-execution'){
  const put=db.prepare('INSERT OR REPLACE INTO observer_evidence_bindings VALUES(?,?,?,?,?)')
  if(item.resultRef)put.run(runId,item.resultRef,origin,'output',JSON.stringify(item.result?.evidenceRefs??[]))
  for(const ref of item.result?.evidenceRefs??[])put.run(runId,ref,origin,'query',null)
 }
}
export function observerEvidenceBinding(db,{runId,resourceRef}){
 if(!ready(db))throw error('OBSERVER_TEXT_MIGRATION_REQUIRED')
 const row=db.prepare("SELECT kind,evidence_refs FROM observer_evidence_bindings WHERE run_id=? AND resource_ref=? ORDER BY CASE kind WHEN 'output' THEN 0 ELSE 1 END LIMIT 1").get(runId,resourceRef)
 return row?{kind:row.kind,evidenceRefs:row.evidence_refs?JSON.parse(row.evidence_refs):undefined}:null
}
export function observerEvidencePage(db,{runId,resourceRef,offset=0,limit=2000,hash:expectedHash,materialOnly=false}){
 if(!ready(db))throw error('OBSERVER_TEXT_MIGRATION_REQUIRED')
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<2||limit>8000)throw error('MESSAGE_EVIDENCE_CURSOR_INVALID')
 const meta=db.prepare('SELECT * FROM observer_evidence_text WHERE run_id=? AND resource_ref=?'+(materialOnly?' AND priority=0':'')+' ORDER BY priority,position LIMIT 1').get(runId,resourceRef)
 if(!meta)return null
 if(expectedHash&&expectedHash!==meta.hash)throw error('MESSAGE_EVIDENCE_VERSION_CHANGED')
 if(offset>meta.total_length||offset>0&&!expectedHash)throw error('MESSAGE_EVIDENCE_CURSOR_INVALID')
 // 4096-unit non-overlapping chunks: at most three for an 8000-unit page.
 const chunks=db.prepare('SELECT start,text FROM observer_evidence_chunks WHERE run_id=? AND resource_ref=? AND origin=? AND start>=? AND start<=? AND end>? ORDER BY start LIMIT 4').all(runId,resourceRef,meta.origin,Math.max(0,offset-4096),offset+limit,Math.max(0,offset-1))
 const start=offset-(chunks[0]?.start??offset),text=chunks.map(row=>row.text).join('')
 if(offset>0&&/[\uDC00-\uDFFF]/u.test(text[start]??''))throw error('MESSAGE_EVIDENCE_CURSOR_INVALID')
 let end=Math.min(meta.total_length,offset+limit);if(end<meta.total_length&&/[\uD800-\uDBFF]/u.test(text[start+end-offset-1]??''))end--
 return {runId,resourceRef,hash:meta.hash,sourceVersion:meta.source_version,totalLength:meta.total_length,totalBytes:meta.total_bytes,start:offset,end,text:text.slice(start,start+end-offset),complete:offset===0&&end===meta.total_length,nextCursor:end<meta.total_length?end:null}
}
