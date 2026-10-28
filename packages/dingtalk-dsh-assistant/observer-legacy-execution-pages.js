import {randomUUID} from 'node:crypto'
const instances=new WeakMap()
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function installObserverLegacyExecutionPages(db,{migrate=false}={}){
 const ready=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_legacy_tasks'").get()
 if(ready||!migrate)return ready
 const required=['business_tasks','task_owners','execution_runs','execution_nodes','execution_events','message_items','message_runs']
 if(required.some(name=>!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)))return false
 db.exec('SAVEPOINT observer_legacy_execution_migration')
 try{
  db.exec(`CREATE TABLE observer_legacy_tasks(task_id TEXT PRIMARY KEY,parent_task_id TEXT,accepted_seq INTEGER,channel TEXT,conversation_id TEXT,actor_id TEXT,report_channel TEXT,external_messaging INTEGER);
  CREATE INDEX observer_legacy_family ON observer_legacy_tasks(parent_task_id,accepted_seq,task_id);
  CREATE INDEX observer_legacy_event_task ON execution_events(kind,json_extract(payload,'$.taskId'),seq);
  CREATE INDEX observer_legacy_command_task ON message_items(kind,json_extract(body,'$.args.taskId'));
  CREATE INDEX observer_legacy_run_task ON execution_runs(task_id);
  CREATE TABLE observer_legacy_archived_runs(run_id TEXT PRIMARY KEY,task_id TEXT);
  INSERT OR REPLACE INTO observer_legacy_archived_runs SELECT value,json_extract(e.payload,'$.taskId') FROM execution_events e,json_each(e.payload,'$.archivedRunIds') WHERE e.kind='task.execution.reset';
  `)
  const known='(SELECT task_id FROM business_tasks UNION SELECT task_id FROM task_owners UNION SELECT task_id FROM execution_runs)'
  const refresh=where=>`INSERT INTO observer_legacy_tasks SELECT k.task_id,json_extract(e.payload,'$.rerunOfTaskId'),coalesce(e.seq,0),CASE WHEN e.seq IS NOT NULL THEN 'web' ELSE 'message' END,
   CASE WHEN e.seq IS NOT NULL THEN json_extract(e.payload,'$.source.conversationId') ELSE json_extract(r.body,'$.conversationId') END,
   CASE WHEN e.seq IS NOT NULL THEN json_extract(e.payload,'$.source.actorId') ELSE json_extract(r.body,'$.actorId') END,
   CASE WHEN e.seq IS NOT NULL THEN json_extract(e.payload,'$.source.reportChannel') ELSE NULL END,
   CASE WHEN e.seq IS NOT NULL THEN json_extract(e.payload,'$.source.externalMessaging') ELSE NULL END
   FROM ${known} k LEFT JOIN execution_events e ON e.seq=(SELECT seq FROM execution_events WHERE kind='task.web-rerun.accept' AND json_extract(payload,'$.taskId')=k.task_id ORDER BY seq LIMIT 1)
   LEFT JOIN message_items i ON i.rowid=(SELECT rowid FROM message_items WHERE kind='command' AND json_extract(body,'$.args.taskId')=k.task_id AND json_extract(body,'$.kind') IN ('create','research','answer','reopen') ORDER BY rowid LIMIT 1)
   LEFT JOIN message_runs r ON r.run_id=i.run_id ${where||'WHERE true'} ON CONFLICT(task_id) DO UPDATE SET parent_task_id=excluded.parent_task_id,accepted_seq=excluded.accepted_seq,channel=excluded.channel,conversation_id=excluded.conversation_id,actor_id=excluded.actor_id,report_channel=excluded.report_channel,external_messaging=excluded.external_messaging;`
  db.exec(refresh(''))
  for(const table of ['business_tasks','task_owners','execution_runs'])for(const event of ['INSERT','UPDATE','DELETE']){
   const row=event==='DELETE'?'OLD':'NEW'
   db.exec(`CREATE TRIGGER observer_legacy_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN DELETE FROM observer_legacy_tasks WHERE task_id=${row}.task_id;${refresh('WHERE k.task_id='+row+'.task_id')} END;`)
  }
  for(const event of ['INSERT','UPDATE','DELETE']){
   const row=event==='DELETE'?'OLD':'NEW'
   db.exec(`CREATE TRIGGER observer_legacy_event_${event.toLowerCase()} AFTER ${event} ON execution_events WHEN ${row}.kind='task.web-rerun.accept' BEGIN ${refresh("WHERE k.task_id=json_extract("+row+".payload,'$.taskId')")} END;`)
   db.exec(`CREATE TRIGGER observer_legacy_command_${event.toLowerCase()} AFTER ${event} ON message_items WHEN ${row}.kind='command' BEGIN ${refresh("WHERE k.task_id=json_extract("+row+".body,'$.args.taskId')")} END;`)
   db.exec(`CREATE TRIGGER observer_legacy_source_${event.toLowerCase()} AFTER ${event} ON message_runs BEGIN ${refresh("WHERE k.task_id IN (SELECT json_extract(body,'$.args.taskId') FROM message_items WHERE run_id="+row+".run_id AND kind='command')")} END;`)
  }
  for(const event of ['INSERT','UPDATE','DELETE']){
   const row=event==='DELETE'?'OLD':'NEW'
   db.exec(`CREATE TRIGGER observer_legacy_reset_${event.toLowerCase()} AFTER ${event} ON execution_events WHEN ${row}.kind='task.execution.reset' BEGIN DELETE FROM observer_legacy_archived_runs WHERE task_id=json_extract(${row}.payload,'$.taskId');INSERT INTO observer_legacy_archived_runs SELECT value,json_extract(e.payload,'$.taskId') FROM execution_events e,json_each(e.payload,'$.archivedRunIds') WHERE e.kind='task.execution.reset' AND json_extract(e.payload,'$.taskId')=json_extract(${row}.payload,'$.taskId') ON CONFLICT(run_id) DO UPDATE SET task_id=excluded.task_id; END;`)
  }
  db.exec('RELEASE observer_legacy_execution_migration');return true
 }catch(cause){db.exec('ROLLBACK TO observer_legacy_execution_migration; RELEASE observer_legacy_execution_migration');throw cause}
}
function pageVersion(db,revision){
 if(!installObserverLegacyExecutionPages(db))fail('OBSERVER_PAGINATION_MIGRATION_REQUIRED')
 if(!instances.has(db))instances.set(db,randomUUID())
 const current=`${instances.get(db)}:${db.prepare('SELECT total_changes() n').get().n}`
 if(revision&&revision!==current)fail('OBSERVER_PAGE_STALE')
 return current
}
function scope(q){
 if(!Array.isArray(q.groupIds)||q.groupIds.some(id=>typeof id!=='string')||q.webActorId!==undefined&&typeof q.webActorId!=='string')fail('TASK_EXECUTION_CURSOR_INVALID')
 return [JSON.stringify(q.groupIds),q.webActorId??null]
}
const permission="((i.channel='web' AND i.actor_id=? AND i.report_channel='web' AND i.external_messaging=0) OR (i.channel='message' AND i.conversation_id IN (SELECT value FROM json_each(?))))"
export function observerLegacyFamilyPage(db,q){
 const {taskId,offset=0,limit=20}=q
 if(typeof taskId!=='string'||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('TASK_EXECUTION_CURSOR_INVALID')
 const revision=pageVersion(db,q.revision),[groupIds,actor]=scope(q)
 if(!db.prepare(`SELECT task_id FROM observer_legacy_tasks i WHERE task_id=? AND ${permission}`).get(taskId,actor,groupIds))return null
 const ancestors=db.prepare(`WITH RECURSIVE ancestors(task_id,parent_task_id) AS (SELECT task_id,parent_task_id FROM observer_legacy_tasks WHERE task_id=? UNION SELECT i.task_id,i.parent_task_id FROM observer_legacy_tasks i JOIN ancestors a ON i.task_id=a.parent_task_id) SELECT task_id FROM ancestors WHERE parent_task_id IS NULL`).all(taskId)
 if(ancestors.length!==1)fail('TASK_FAMILY_INVALID')
 const root=ancestors[0].task_id
 const cte=`WITH RECURSIVE family(task_id) AS (SELECT ? UNION SELECT i.task_id FROM observer_legacy_tasks i JOIN family f ON i.parent_task_id=f.task_id), readable AS MATERIALIZED (SELECT i.task_id,i.accepted_seq,row_number() OVER (ORDER BY i.accepted_seq,i.task_id) execution_number FROM observer_legacy_tasks i JOIN family f ON i.task_id=f.task_id WHERE ${permission}) `
 const args=[root,actor,groupIds]
 const page=db.prepare(cte+`SELECT (SELECT count(*) FROM readable) total,
  (SELECT task_id FROM readable ORDER BY execution_number LIMIT 1) rootTaskId,
  (SELECT task_id FROM readable ORDER BY execution_number DESC LIMIT 1) latestTaskId,
  (SELECT json_group_array(json_object('taskId',task_id,'executionNumber',execution_number)) FROM (SELECT task_id,execution_number FROM readable ORDER BY execution_number DESC LIMIT ? OFFSET ?)) selected`).get(...args,limit,offset)
 const selected=JSON.parse(page.selected)
 return {rootTaskId:page.rootTaskId,latestTaskId:page.latestTaskId,total:page.total,offset,limit,revision,selected,nextOffset:offset+selected.length<page.total?offset+selected.length:null}
}
export function observerLegacyRunPage(db,q){
 const {taskId,before=Number.MAX_SAFE_INTEGER,limit=20}=q
 if(typeof taskId!=='string'||!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('TASK_EXECUTION_CURSOR_INVALID')
 const revision=pageVersion(db,q.revision),[groupIds,actor]=scope(q)
 if(!db.prepare(`SELECT task_id FROM observer_legacy_tasks i WHERE task_id=? AND ${permission}`).get(taskId,actor,groupIds))return null
 // Projection deliberately excludes requirement/result JSON and node evidence lists.
 const runs=db.prepare('SELECT run_id AS runId,status,created_at AS startedAt,rowid AS sequenceId FROM execution_runs r WHERE task_id=? AND rowid<? AND NOT EXISTS(SELECT 1 FROM observer_legacy_archived_runs a WHERE a.run_id=r.run_id) ORDER BY rowid DESC LIMIT ?').all(taskId,before,limit+1)
 const selected=runs.slice(0,limit)
 const nodes=db.prepare("SELECT node_id AS nodeId,status,session_bound AS sessionBound,session_id AS sessionId FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position")
 return {taskId,runs:selected.map(run=>({...run,nodes:nodes.all(run.runId).map(node=>({...node,label:node.nodeId,sessionBound:node.sessionBound===1,sessionId:node.sessionBound===1?node.sessionId:null}))})),revision,nextCursor:runs.length>limit?selected.at(-1).sequenceId:null,total:db.prepare('SELECT count(*) n FROM execution_runs r WHERE task_id=? AND NOT EXISTS(SELECT 1 FROM observer_legacy_archived_runs a WHERE a.run_id=r.run_id)').get(taskId).n}
}
