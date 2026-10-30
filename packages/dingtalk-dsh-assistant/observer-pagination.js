// Observer-only indexes. Historical payloads are fetched only after selecting a page.
// Existing installations must opt into the offline index migration; GET never runs DDL.
const error = code => Object.assign(new Error(code), { code })
const taskState = indexed => `CASE
 WHEN json_extract(t.body,'$.status')='completed' THEN 'completed'
 WHEN json_extract(t.body,'$.control')='cancelled' THEN 'cancelled'
 WHEN json_extract(t.body,'$.control')='paused' OR EXISTS(SELECT 1 FROM json_each(t.body,'$.humanRequests') h WHERE json_extract(h.value,'$.status')='waiting-reply') THEN 'waiting'
 WHEN json_extract(t.body,'$.drained')=0 THEN 'running'
 WHEN coalesce(json_type(t.body,'$.lastDecision'),'null')='null' AND EXISTS(SELECT 1 FROM dynamic_wakes w WHERE json_extract(w.body,'$.taskId')=t.id AND json_extract(w.body,'$.state')!='acked') THEN 'running'
 WHEN json_extract(t.body,'$.lastDecision.action')='blocked' OR length(trim(coalesce(json_extract(t.body,'$.lastDecision.question'),'')))>0 THEN 'waiting'
 WHEN EXISTS(SELECT 1 FROM ${indexed?'observer_execution_index e':"dynamic_executions e"} WHERE ${indexed?"e.task_id=t.id AND (e.state IN ('queued','running') OR e.drained=0)":"json_extract(e.body,'$.taskId')=t.id AND (json_extract(e.body,'$.status') IN ('queued','running') OR json_extract(e.body,'$.drained')=0)"}) THEN 'running'
 ELSE 'waiting' END`
const refreshTask = (where, table = 'dynamic_tasks', indexed = false) => `INSERT INTO observer_task_index(id,group_id,state,archived,sort_key)
 SELECT t.id,json_extract(t.body,'$.groupId'),${taskState(indexed)},coalesce(json_type(t.body,'$.archivedAt'),'null')!='null',coalesce(json_extract(t.body,'$.updatedAt'),'') FROM ${table} t ${where}
 ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,state=excluded.state,archived=excluded.archived,sort_key=excluded.sort_key;`

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

const hasExecutionControl = db => db.prepare('PRAGMA table_info(observer_execution_index)').all().some(column=>column.name==='drained')
function installExecutionControlTriggers(db) {
 for(const event of ['INSERT','UPDATE','DELETE']) {
  const row=event==='DELETE'?'OLD':'NEW', suffix=event.toLowerCase()
  const execution=event==='DELETE'?`DELETE FROM observer_execution_index WHERE id=OLD.id;`:`INSERT INTO observer_execution_index(id,task_id,sequence,state,drained) VALUES(NEW.id,json_extract(NEW.body,'$.taskId'),NEW.rowid,json_extract(NEW.body,'$.status'),json_extract(NEW.body,'$.drained')) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,state=excluded.state,drained=excluded.drained;`
  db.exec(`DROP TRIGGER IF EXISTS observer_execution_${suffix}; DROP TRIGGER IF EXISTS observer_executions_${suffix}; CREATE TRIGGER observer_execution_${suffix} AFTER ${event} ON dynamic_executions BEGIN ${execution}${refreshTask(`WHERE t.id=json_extract(${row}.body,'$.taskId')`,'dynamic_tasks',true)} END;`)
  db.exec(`DROP TRIGGER IF EXISTS observer_wakes_${suffix}; CREATE TRIGGER observer_wakes_${suffix} AFTER ${event} ON dynamic_wakes BEGIN ${refreshTask(`WHERE t.id=json_extract(${row}.body,'$.taskId')`,'dynamic_tasks',true)} END;`)
  db.exec(`DROP TRIGGER IF EXISTS observer_task_${suffix}; CREATE TRIGGER observer_task_${suffix} AFTER ${event} ON dynamic_tasks BEGIN ${event==='DELETE'?`DELETE FROM observer_task_index WHERE id=OLD.id;`:refreshTask('WHERE t.id=NEW.id','dynamic_tasks',true)} END;`)
 }
}
function migrateExecutionControl(db) {
 db.exec('SAVEPOINT observer_execution_control_migration')
 try {
  if(!hasExecutionControl(db))db.exec('ALTER TABLE observer_execution_index ADD COLUMN drained INTEGER')
  const archived=tableExists(db,'dynamic_archived_executions')?",(SELECT json_extract(body,'$.drained') FROM dynamic_archived_executions source WHERE source.id=observer_execution_index.id)":''
  db.exec(`UPDATE observer_execution_index SET drained=coalesce((SELECT json_extract(body,'$.drained') FROM dynamic_executions source WHERE source.id=observer_execution_index.id)${archived},NULL);
   CREATE INDEX IF NOT EXISTS observer_execution_state ON observer_execution_index(task_id,state,drained);`)
  installExecutionControlTriggers(db)
  installObserverArchivePagination(db)
  db.exec('RELEASE observer_execution_control_migration')
 } catch(cause) {db.exec('ROLLBACK TO observer_execution_control_migration; RELEASE observer_execution_control_migration');throw cause}
}

export function installObserverArchivePagination(db) {
 if (!tableExists(db,'observer_task_index') || !tableExists(db,'dynamic_archived_tasks') || !tableExists(db,'dynamic_archived_executions')) return false
 const indexed=hasExecutionControl(db), installed=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observer_archived_execution_delete'").get(), active=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observer_task_delete'").get()
 if(installed&&installed.sql.includes('e.drained')===indexed&&active?.sql.includes('dynamic_archived_tasks'))return true
 const taskRows = id => [ ['dynamic_tasks',`WHERE t.id=${id}`], ['dynamic_archived_tasks',`WHERE t.id=${id} AND NOT EXISTS(SELECT 1 FROM dynamic_tasks live WHERE live.id=t.id)`] ]
 const reconcileTask = id => `DELETE FROM observer_task_index WHERE id=${id} AND NOT EXISTS(SELECT 1 FROM dynamic_tasks WHERE id=${id}) AND NOT EXISTS(SELECT 1 FROM dynamic_archived_tasks WHERE id=${id});`+taskRows(id).map(([table,where])=>refreshTask(where,table,indexed)).join('')
 const reconcileRefs = id => `DELETE FROM observer_task_topics WHERE task_id=${id}; DELETE FROM observer_human_index WHERE task_id=${id};`+taskRows(id).map(([table,where])=>`
 INSERT OR REPLACE INTO observer_task_topics SELECT t.id,json_extract(ref.value,'$.topicId'),coalesce(json_extract(ref.value,'$.groupId'),json_extract(t.body,'$.sourceGroupId'),json_extract(t.body,'$.groupId')) FROM ${table} t,json_each(t.body,'$.topicRefs') ref ${where};
 INSERT OR REPLACE INTO observer_human_index SELECT json_array(t.id,json_extract(h.value,'$.requestId')),t.id,json_extract(t.body,'$.groupId'),h.key,json_extract(h.value,'$.status'),json_extract(h.value,'$.status') IN ('pending-send','sending-unknown','waiting-reply'),coalesce(json_extract(h.value,'$.createdAt'),'') FROM ${table} t,json_each(t.body,'$.humanRequests') h ${where};`).join('')
 for (const table of ['dynamic_tasks','dynamic_archived_tasks']) for(const event of ['INSERT','UPDATE','DELETE']) {
  const old=event==='DELETE'?'OLD':'NEW', name=table==='dynamic_tasks'?'task':'archived_task', suffix=event.toLowerCase()
  db.exec(`DROP TRIGGER IF EXISTS observer_${name}_${suffix}; DROP TRIGGER IF EXISTS observer_${name}_topics_${suffix}; DROP TRIGGER IF EXISTS observer_${name}_human_${suffix};
   CREATE TRIGGER observer_${name}_${suffix} AFTER ${event} ON ${table} BEGIN ${reconcileTask(old+'.id')}${reconcileRefs(old+'.id')} END;`)
 }
 // These two original trigger families are now folded into the task trigger.
 for (const event of ['insert','update','delete']) db.exec(`DROP TRIGGER IF EXISTS observer_task_topics_${event}; DROP TRIGGER IF EXISTS observer_human_${event};`)
 const drained=indexed?",json_extract(body,'$.drained')":'', updateDrained=indexed?',drained=excluded.drained':''
 const reconcileExecution = id => `DELETE FROM observer_execution_index WHERE id=${id} AND NOT EXISTS(SELECT 1 FROM dynamic_executions WHERE id=${id}) AND NOT EXISTS(SELECT 1 FROM dynamic_archived_executions WHERE id=${id});
 INSERT INTO observer_execution_index SELECT id,json_extract(body,'$.taskId'),rowid,json_extract(body,'$.status')${drained} FROM dynamic_executions WHERE id=${id} ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,sequence=excluded.sequence,state=excluded.state${updateDrained};
 INSERT INTO observer_execution_index SELECT id,json_extract(body,'$.taskId'),sequence,json_extract(body,'$.status')${drained} FROM dynamic_archived_executions WHERE id=${id} AND NOT EXISTS(SELECT 1 FROM dynamic_executions live WHERE live.id=dynamic_archived_executions.id) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,sequence=excluded.sequence,state=excluded.state${updateDrained};`
 for (const table of ['dynamic_executions','dynamic_archived_executions']) for(const event of ['INSERT','UPDATE','DELETE']) {
  const row=event==='DELETE'?'OLD':'NEW',name=table==='dynamic_executions'?'execution':'archived_execution',suffix=event.toLowerCase()
  db.exec(`DROP TRIGGER IF EXISTS observer_${name}_${suffix}; CREATE TRIGGER observer_${name}_${suffix} AFTER ${event} ON ${table} BEGIN ${reconcileExecution(row+'.id')}${reconcileTask(`json_extract(${row}.body,'$.taskId')`)} END;`)
 }
 if(tableExists(db,'dynamic_archived_wakes'))for(const event of ['INSERT','UPDATE','DELETE']){
  const row=event==='DELETE'?'OLD':'NEW',name='observer_archived_wakes_'+event.toLowerCase()
  db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} AFTER ${event} ON dynamic_archived_wakes BEGIN ${reconcileTask(`json_extract(${row}.body,'$.taskId')`)} END;`)
 }
 db.exec(`CREATE INDEX IF NOT EXISTS observer_archived_execution_task ON dynamic_archived_executions(json_extract(body,'$.taskId'),json_extract(body,'$.status'));`)
 if(tableExists(db,'dynamic_archived_notifications'))db.exec(`CREATE INDEX IF NOT EXISTS observer_archived_human_notice ON dynamic_archived_notifications(json_extract(body,'$.taskId'),json_extract(body,'$.payload.humanRequestId'),json_extract(body,'$.payload.audience')); CREATE INDEX IF NOT EXISTS observer_archived_message_notification ON dynamic_archived_notifications(json_extract(body,'$.payload.conversationId'),json_extract(body,'$.payload.sourceMessageId'));`)
 return true
}

export function installObserverPagination(db, { migrate = false } = {}) {
 const ready = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observer_task_index'").get()
 if(ready){if(migrate)migrateExecutionControl(db);return true}
 if(!migrate)return false
 db.exec('SAVEPOINT observer_pagination_migration')
 try {
 db.exec(`CREATE INDEX IF NOT EXISTS observer_wake_task ON dynamic_wakes(json_extract(body,'$.taskId'));
 CREATE INDEX IF NOT EXISTS observer_execution_task ON dynamic_executions(json_extract(body,'$.taskId'),json_extract(body,'$.status'));
 CREATE TABLE observer_execution_index(id TEXT PRIMARY KEY,task_id TEXT,sequence INTEGER NOT NULL,state TEXT,drained INTEGER);
 CREATE INDEX observer_execution_page ON observer_execution_index(task_id,sequence,id);
 CREATE INDEX observer_execution_state ON observer_execution_index(task_id,state,drained);
 INSERT INTO observer_execution_index SELECT id,json_extract(body,'$.taskId'),rowid,json_extract(body,'$.status'),json_extract(body,'$.drained') FROM dynamic_executions;
 CREATE TRIGGER observer_execution_insert AFTER INSERT ON dynamic_executions BEGIN INSERT INTO observer_execution_index VALUES(NEW.id,json_extract(NEW.body,'$.taskId'),NEW.rowid,json_extract(NEW.body,'$.status'),json_extract(NEW.body,'$.drained')); END;
 CREATE TRIGGER observer_execution_update AFTER UPDATE ON dynamic_executions BEGIN UPDATE observer_execution_index SET task_id=json_extract(NEW.body,'$.taskId'),state=json_extract(NEW.body,'$.status'),drained=json_extract(NEW.body,'$.drained') WHERE id=NEW.id; END;
 CREATE TRIGGER observer_execution_delete AFTER DELETE ON dynamic_executions BEGIN DELETE FROM observer_execution_index WHERE id=OLD.id; END;
 CREATE INDEX IF NOT EXISTS observer_source_global ON dynamic_coordination_sources(json_extract(body,'$.createdAt') DESC,id);
 CREATE INDEX IF NOT EXISTS observer_source_group ON dynamic_coordination_sources(json_extract(body,'$.groupId'),json_extract(body,'$.createdAt') DESC,id);
 CREATE TABLE observer_task_index(id TEXT PRIMARY KEY,group_id TEXT,state TEXT,archived INTEGER NOT NULL,sort_key TEXT NOT NULL);
 CREATE INDEX observer_task_page ON observer_task_index(archived,state,sort_key DESC,id);
 CREATE INDEX observer_task_group_page ON observer_task_index(group_id,archived,state,sort_key DESC,id);
 ${refreshTask('WHERE true')}
 CREATE TRIGGER observer_task_insert AFTER INSERT ON dynamic_tasks BEGIN ${refreshTask('WHERE t.id=NEW.id')} END;
 CREATE TRIGGER observer_task_update AFTER UPDATE ON dynamic_tasks BEGIN ${refreshTask('WHERE t.id=NEW.id')} END;
 CREATE TRIGGER observer_task_delete AFTER DELETE ON dynamic_tasks BEGIN DELETE FROM observer_task_index WHERE id=OLD.id; END;`)
 for (const table of ['executions','wakes']) for (const event of ['INSERT','UPDATE','DELETE']) {
  const row = event === 'DELETE' ? 'OLD' : 'NEW'
  db.exec(`CREATE TRIGGER observer_${table}_${event.toLowerCase()} AFTER ${event} ON dynamic_${table} BEGIN ${refreshTask(`WHERE t.id=json_extract(${row}.body,'$.taskId')`)} END;`)
 }
 db.exec(`CREATE TABLE observer_task_topics(task_id TEXT,topic_id TEXT,group_id TEXT,PRIMARY KEY(task_id,topic_id));
 CREATE INDEX observer_task_topic_scope ON observer_task_topics(group_id,topic_id,task_id);
 CREATE INDEX observer_task_all ON observer_task_index(sort_key DESC,id);`)
 const refreshTopicRefs=where=>`INSERT OR REPLACE INTO observer_task_topics SELECT t.id,json_extract(ref.value,'$.topicId'),coalesce(json_extract(ref.value,'$.groupId'),json_extract(t.body,'$.sourceGroupId'),json_extract(t.body,'$.groupId')) FROM dynamic_tasks t,json_each(t.body,'$.topicRefs') ref ${where};`
 db.exec(refreshTopicRefs(''))
 for(const event of ['INSERT','UPDATE','DELETE']){const row=event==='DELETE'?'OLD':'NEW';db.exec(`CREATE TRIGGER observer_task_topics_${event.toLowerCase()} AFTER ${event} ON dynamic_tasks BEGIN DELETE FROM observer_task_topics WHERE task_id=${row}.id;${event==='DELETE'?'':refreshTopicRefs('WHERE t.id=NEW.id')} END;`)}
 db.exec(`CREATE TABLE observer_human_index(id TEXT PRIMARY KEY,task_id TEXT,group_id TEXT,position INTEGER,status TEXT,pending INTEGER,sort_key TEXT);
 CREATE INDEX observer_human_page ON observer_human_index(pending DESC,sort_key DESC,id);
 CREATE INDEX observer_human_status ON observer_human_index(status,pending DESC,sort_key DESC,id);
 CREATE INDEX observer_human_task ON observer_human_index(task_id);
 CREATE INDEX observer_human_notice ON dynamic_notifications(json_extract(body,'$.taskId'),json_extract(body,'$.payload.humanRequestId'),json_extract(body,'$.payload.audience'));`)
 const refreshHumans=where=>`INSERT INTO observer_human_index SELECT json_array(t.id,json_extract(h.value,'$.requestId')),t.id,json_extract(t.body,'$.groupId'),h.key,json_extract(h.value,'$.status'),json_extract(h.value,'$.status') IN ('pending-send','sending-unknown','waiting-reply'),coalesce(json_extract(h.value,'$.createdAt'),'') FROM dynamic_tasks t,json_each(t.body,'$.humanRequests') h ${where};`
 db.exec(refreshHumans(''))
 for(const event of ['INSERT','UPDATE','DELETE']){
  const row=event==='DELETE'?'OLD':'NEW'
  db.exec(`CREATE TRIGGER observer_human_${event.toLowerCase()} AFTER ${event} ON dynamic_tasks BEGIN DELETE FROM observer_human_index WHERE task_id=${row}.id; ${event==='DELETE'?'':refreshHumans('WHERE t.id=NEW.id')} END;`)
 }
 db.exec(`CREATE TABLE observer_group_versions(group_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
 CREATE INDEX observer_message_source ON dynamic_sources(json_extract(body,'$.groupId'),json_extract(body,'$.messageId'),json_extract(body,'$.version'));
 CREATE INDEX observer_message_notification ON dynamic_notifications(json_extract(body,'$.payload.conversationId'),json_extract(body,'$.payload.sourceMessageId'));
 CREATE INDEX observer_message_coordination ON dynamic_coordination_sources(json_extract(body,'$.groupId'),json_extract(body,'$.sourceMessageId'));
 CREATE INDEX observer_coordination_group ON dynamic_coordination(json_extract(body,'$.groupId'));`)
 for(const [table,path] of [['sources','groupId'],['coordination_sources','groupId'],['coordination','groupId']])for(const event of ['INSERT','UPDATE','DELETE']){
  const row=event==='DELETE'?'OLD':'NEW'
  db.exec(`CREATE TRIGGER observer_group_${table}_${event.toLowerCase()} AFTER ${event} ON dynamic_${table} BEGIN INSERT INTO observer_group_versions VALUES(coalesce(json_extract(${row}.body,'$.${path}'),''),1) ON CONFLICT(group_id) DO UPDATE SET revision=revision+1; END;`)
 }
 for(const table of ['coordination_members','coordination_schedules','coordination_occurrences','coordination_sources']){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(`dynamic_${table}`))db.exec(`CREATE INDEX IF NOT EXISTS observer_${table}_parent ON dynamic_${table}(json_extract(body,'$.coordinationId'));`)
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='dynamic_coordination_jobs'").get())db.exec("CREATE INDEX IF NOT EXISTS observer_coordination_job_parent ON dynamic_coordination_jobs(json_extract(body,'$.occurrenceId'))")
 installExecutionControlTriggers(db)
 if(installObserverArchivePagination(db)) {
  db.exec(refreshTask('WHERE NOT EXISTS(SELECT 1 FROM dynamic_tasks live WHERE live.id=t.id)','dynamic_archived_tasks'))
  db.exec(`INSERT OR REPLACE INTO observer_execution_index SELECT id,json_extract(body,'$.taskId'),sequence,json_extract(body,'$.status'),json_extract(body,'$.drained') FROM dynamic_archived_executions WHERE id NOT IN (SELECT id FROM dynamic_executions);
   INSERT OR REPLACE INTO observer_task_topics SELECT t.id,json_extract(ref.value,'$.topicId'),coalesce(json_extract(ref.value,'$.groupId'),json_extract(t.body,'$.sourceGroupId'),json_extract(t.body,'$.groupId')) FROM dynamic_archived_tasks t,json_each(t.body,'$.topicRefs') ref WHERE t.id NOT IN(SELECT id FROM dynamic_tasks);
   INSERT OR REPLACE INTO observer_human_index SELECT json_array(t.id,json_extract(h.value,'$.requestId')),t.id,json_extract(t.body,'$.groupId'),h.key,json_extract(h.value,'$.status'),json_extract(h.value,'$.status') IN ('pending-send','sending-unknown','waiting-reply'),coalesce(json_extract(h.value,'$.createdAt'),'') FROM dynamic_archived_tasks t,json_each(t.body,'$.humanRequests') h WHERE t.id NOT IN(SELECT id FROM dynamic_tasks);`)
 }
 db.exec('RELEASE observer_pagination_migration')
 return true
 } catch (cause) {db.exec('ROLLBACK TO observer_pagination_migration; RELEASE observer_pagination_migration');throw cause}
}

export function observerPage(db, q, instance) {
 const { offset = 0, limit = 20, revision } = q
 if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('OBSERVER_PAGE_INVALID')
 if (!installObserverPagination(db)) throw error('OBSERVER_PAGINATION_MIGRATION_REQUIRED')
 const currentRevision = `${instance}:${db.prepare('SELECT total_changes() AS n').get().n}`
 if (revision && revision !== currentRevision) throw error('OBSERVER_PAGE_STALE')
 const args = [], conditions = []
 let from, order, body
 const taskArchive=tableExists(db,'dynamic_archived_tasks'), executionArchive=tableExists(db,'dynamic_archived_executions')
 const taskBody=taskArchive?'coalesce(d.body,a.body)':'d.body', executionBody=executionArchive?'coalesce(d.body,a.body)':'d.body'
 if (q.collection === 'tasks') {
  from = taskArchive?'observer_task_index i LEFT JOIN dynamic_tasks d ON d.id=i.id LEFT JOIN dynamic_archived_tasks a ON a.id=i.id':'observer_task_index i JOIN dynamic_tasks d ON d.id=i.id'; order = 'i.sort_key DESC,i.id'; body = `json_remove(${taskBody},'$.dialogue')`
  if (q.summary) body = `json_object('taskId',i.id,'title',json_extract(${taskBody},'$.title'),'state',i.state,'archivedAt',json_extract(${taskBody},'$.archivedAt'),'updatedAt',i.sort_key)`
  if(q.archived!=='all'){conditions.push('i.archived=?');args.push(q.archived?1:0)}
  if (q.state) { conditions.push(q.state === 'completed' ? "i.state IN ('completed','cancelled')" : 'i.state=?'); if(q.state !== 'completed') args.push(q.state) }
  if(q.topicId){conditions.push('EXISTS(SELECT 1 FROM observer_task_topics ref WHERE ref.task_id=i.id AND ref.topic_id=?'+(q.groupId?' AND ref.group_id=?':'')+')');args.push(q.topicId);if(q.groupId)args.push(q.groupId)}else if(q.groupId) { conditions.push('i.group_id=?'); args.push(q.groupId) }
 } else if (q.collection === 'executions') {
  if (!q.taskId) throw error('OBSERVER_PAGE_INVALID')
  from = executionArchive?'observer_execution_index i LEFT JOIN dynamic_executions d ON d.id=i.id LEFT JOIN dynamic_archived_executions a ON a.id=i.id':'observer_execution_index i JOIN dynamic_executions d ON d.id=i.id'; order = 'i.sequence,i.id'; body = q.summary ? "json_object('executionId',json_extract(d.body,'$.executionId'),'sessionId',json_extract(d.body,'$.sessionId'),'title',json_extract(d.body,'$.title'),'key',json_extract(d.body,'$.key'),'input',json_object('title',json_extract(d.body,'$.input.title')),'status',json_extract(d.body,'$.status'),'drained',json_extract(d.body,'$.drained'),'recovering',json_extract(d.body,'$.recovering'),'definition',json_object('executionBackend',json_extract(d.body,'$.definition.executionBackend')),'createdAt',json_extract(d.body,'$.createdAt'),'runTiming',json_extract(d.body,'$.runTiming'),'timeline',json_object('segments',json((SELECT coalesce(json_group_array(json(segment.value)),'[]') FROM json_each(d.body,'$.timeline.segments') segment WHERE json_extract(segment.value,'$.leaseEpoch')=json_extract(d.body,'$.leaseEpoch')))),'leaseEpoch',json_extract(d.body,'$.leaseEpoch'))" : 'd.body'; body=body.replaceAll('d.body',executionBody); conditions.push('i.task_id=?'); args.push(q.taskId)
 } else if(q.collection==='authorizations'){
  from=taskArchive?'observer_human_index i LEFT JOIN dynamic_tasks d ON d.id=i.task_id LEFT JOIN dynamic_archived_tasks a ON a.id=i.task_id':'observer_human_index i JOIN dynamic_tasks d ON d.id=i.task_id';order='i.pending DESC,i.sort_key DESC,i.id'
  const noticeWhere=table=>`json_extract(${table}.body,'$.taskId')=i.task_id AND json_extract(${table}.body,'$.payload.humanRequestId')=json_extract(${taskBody},'$.humanRequests['||i.position||'].requestId') AND json_extract(${table}.body,'$.payload.audience')='operator'`
  const notice=tableExists(db,'dynamic_archived_notifications')?`SELECT body FROM (SELECT rowid AS sequence,body FROM dynamic_notifications n WHERE ${noticeWhere('n')} UNION ALL SELECT sequence,body FROM dynamic_archived_notifications n WHERE ${noticeWhere('n')}) ORDER BY sequence LIMIT 1`:`SELECT n.body FROM dynamic_notifications n WHERE ${noticeWhere('n')} ORDER BY rowid LIMIT 1`
  body=`json_object('taskId',i.task_id,'groupId',i.group_id,'objective',json_extract(${taskBody},'$.objective'),'humanRequests',json_array(json_extract(${taskBody},'$.humanRequests['||i.position||']')),'observerNotice',json((${notice})))`
  if(q.requestId){if(!q.taskId)throw error('OBSERVER_PAGE_INVALID');conditions.push('i.id=json_array(?,?)');args.push(q.taskId,q.requestId)}
  if(q.filter==='pending')conditions.push('i.pending=1')
  else if(q.filter&&q.filter!=='all'){conditions.push('i.status=?');args.push(q.filter)}
 } else if (q.collection === 'coordination-sources') {
  from = 'dynamic_coordination_sources d'; order = "json_extract(d.body,'$.createdAt') DESC,d.id"; body = 'd.body'
  if (q.groupId) {conditions.push("json_extract(d.body,'$.groupId')=?");args.push(q.groupId)}
 } else throw error('OBSERVER_PAGE_INVALID')
 const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
 // COUNT reads the narrow covering index, never deserializes a historical body.
 const countFrom = q.collection === 'tasks' ? 'observer_task_index i' : q.collection === 'executions' ? 'observer_execution_index i' : q.collection==='authorizations'?'observer_human_index i':from
 const total = db.prepare(`SELECT count(*) AS n FROM ${countFrom} ${where}`).get(...args).n
 const indexed = ['tasks','executions','authorizations'].includes(q.collection)
 const prefix = indexed ? `WITH page_ids AS MATERIALIZED (SELECT i.* FROM ${countFrom} ${where} ORDER BY ${order} LIMIT ? OFFSET ?) ` : ''
 const pageFrom = indexed ? from.replace(countFrom,'page_ids i') : from
 const suffix = indexed ? `ORDER BY ${order}` : `${where} ORDER BY ${order} LIMIT ? OFFSET ?`
 // Historical cards have no execution panel. Mixed task pages only count sessions for unarchived rows.
 const executionCounts = q.collection === 'tasks' && !q.summary && q.archived !== true
  ? ",CASE WHEN i.archived=0 THEN (SELECT count(*) FROM observer_execution_index e WHERE e.task_id=i.id) END AS execution_count,CASE WHEN i.archived=0 THEN (SELECT count(*) FROM observer_execution_index e WHERE e.task_id=i.id AND e.state IN ('succeeded','completed')) END AS completed_count" : ''
 const rows = db.prepare(`${prefix}SELECT ${body} AS body${q.collection === 'tasks' && !q.summary ? ',i.state AS board_state' : ''}${executionCounts} FROM ${pageFrom} ${suffix}`).all(...args,limit,offset)
 if(rows.some(row=>row.body==null))throw error('OBSERVER_PAGE_DATA_MISSING')
 return { items: rows.map(row => ({...JSON.parse(row.body), ...(q.summary && q.collection === 'executions' ? {drained:!!JSON.parse(row.body).drained,recovering:!!JSON.parse(row.body).recovering} : row.board_state ? {state:row.board_state,...(row.execution_count == null ? {} : {executionCount:row.execution_count,completedExecutionCount:row.completed_count})} : {})})), total,offset,limit,revision:currentRevision,nextOffset:offset+rows.length<total?offset+rows.length:null }
}

export function observerGroupQuery(db,q) {
 if(!installObserverPagination(db))throw error('OBSERVER_PAGINATION_MIGRATION_REQUIRED')
 if(typeof q.groupId!=='string'||!q.groupId)throw error('OBSERVER_PAGE_INVALID')
 if(q.kind==='observer.group-version')return String(db.prepare('SELECT revision FROM observer_group_versions WHERE group_id=?').get(q.groupId)?.revision??0)
 const fields=(names)=>`json_object(${names.map(name=>`'${name}',json_extract(body,'$.${name}')`).join(',')}) AS body`
 const read=(table,select,where,args)=>{
  if(table==='dynamic_notifications'&&tableExists(db,'dynamic_archived_notifications'))return db.prepare(`SELECT body FROM (SELECT rowid AS sequence,${select} FROM dynamic_notifications WHERE ${where} UNION ALL SELECT sequence,${select} FROM dynamic_archived_notifications WHERE ${where}) ORDER BY sequence`).all(...args,...args).map(row=>JSON.parse(row.body))
  return db.prepare(`SELECT ${select} FROM ${table} WHERE ${where}`).all(...args).map(row=>JSON.parse(row.body))
 }
 if(q.kind==='observer.group-metadata')return {
  sources:read('dynamic_sources',fields(['sourceId','groupId','messageId','version','routed','processingCompleted','coordinationRetirement']),"json_extract(body,'$.groupId')=?",[q.groupId]).map(source=>({...source,routed:source.routed===1||source.routed===true})),
 }
 if(!['observer.message-contexts','observer.message-list-contexts'].includes(q.kind)||!Array.isArray(q.messageIds)||q.messageIds.length>100||q.messageIds.some(id=>typeof id!=='string'))throw error('OBSERVER_PAGE_INVALID')
 const ids=JSON.stringify(q.messageIds), args=[q.groupId,ids]
 if(q.kind==='observer.message-list-contexts')return {
  sources:read('dynamic_sources',fields(['sourceId','groupId','messageId','version','routed','processingCompleted','coordinationRetirement']),"json_extract(body,'$.groupId')=? AND json_extract(body,'$.messageId') IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(?) requested WHERE json_extract(requested.value,'$.messageId')=json_extract(dynamic_sources.body,'$.messageId') AND json_extract(requested.value,'$.version')=json_extract(dynamic_sources.body,'$.version'))",[...args,JSON.stringify(q.messages??[])]).map(source=>({...source,routed:source.routed===1||source.routed===true})),
 }
 const sources=read('dynamic_sources','body',"json_extract(body,'$.groupId')=? AND json_extract(body,'$.messageId') IN (SELECT value FROM json_each(?))"+(q.messages?" AND EXISTS(SELECT 1 FROM json_each(?) requested WHERE json_extract(requested.value,'$.messageId')=json_extract(dynamic_sources.body,'$.messageId') AND json_extract(requested.value,'$.version')=json_extract(dynamic_sources.body,'$.version'))":''),q.messages?[...args,JSON.stringify(q.messages)]:args)
 const notifications=read('dynamic_notifications','body',"json_extract(body,'$.payload.conversationId')=? AND json_extract(body,'$.payload.sourceMessageId') IN (SELECT value FROM json_each(?))",args)
 const coordinationSources=read('dynamic_coordination_sources','body',"json_extract(body,'$.groupId')=? AND json_extract(body,'$.sourceMessageId') IN (SELECT value FROM json_each(?))",args)
 const arrangements=read('dynamic_coordination','body','id IN (SELECT value FROM json_each(?))',[JSON.stringify([...new Set(coordinationSources.map(source=>source.coordinationId).filter(Boolean))])])
 return {sources,notifications,coordinationSources,arrangements}
}
