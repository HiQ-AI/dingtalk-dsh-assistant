import { createHash, randomUUID } from 'node:crypto'
import { installMessageTopics, validateMessageTopics, reduceMessageTopic, queryMessageTopics, bindQuietTopic, invalidateMessageSourceTopics, unbindMessageUnit, wholeTopicFactRevision } from './message-topics.js'

export function isPassiveTaskProgress(body) {
  if (typeof body !== 'string') return false
  const text = body.trim()
  const withoutMention = text.replace(/^@[^\s，,]+(?:\([^)]*\))?\s*/u, '')
  return /^任务已创建[，,]\s*开始处理[。.!！]?\s*任务[:：]\s*\S+\s*[—-]\s*\S+$/u.test(withoutMention)
}
export function isQuietGroupMessage(body) {
  return typeof body === 'string' && (/^先别管(?:它|这个|这件事|了)[。.!！\s]*$/u.test(body.trim()) || isPassiveTaskProgress(body))
}

// 仅供已认证 Host 调用；外层 execution_receipts 事务提供命令幂等和崩溃原子性。
// command({id,kind,args}) -> {result,replayed,dispatchEligible}；重投旧 receipt 不重新授予派发。
// receive: runId/sourceKey/sourceVersion/conversationId/actorId/body/context/policy/barriers。
// node.claim: runId/unitId/nodeId/expectedRevision/input/estimatedInputTokens/maxOutputTokens。
// node.complete|fail: runId/nodeRunId/leaseEpoch/expectedRevision/output|error/usage/retryAt。
// accept: runId/unitId/expectedRevision/commands[{commandId,kind,args,dependsOn}]/outcome。
// correction.begin 先撤权；publish 显式 preservedUnitId 只允许完全相同的单元复用。
// request/wake 的 permittedActors 来自 Host 身份策略；模型不得调用本模块或选择真实身份。
// notification.sent 只记 ACK，只有 readback 的独立 evidence 才记 delivered。
// group.begin 的 legacySealRef 必须由 Host 先冻结旧入口并取得；这里不伪称跨库原子性。
// 正常打开只校验 schema；installMessageSchema 只供显式新库初始化/离线迁移调用。
const fail = code => { throw Object.assign(new Error(code), { code }) }
const str = v => { if (typeof v !== 'string' || !v.trim()) fail('MESSAGE_INVALID_ARGUMENT'); return v }
const json = v => JSON.stringify(v)
function taskFactVersion(db, taskId) {
  const task = db.prepare('SELECT requirement_revision,requirement_ref,plan_revision,plan_requirement_revision,status FROM business_tasks WHERE task_id=?').get(str(taskId)) ?? null
  const control = db.prepare('SELECT * FROM task_controls WHERE task_id=?').get(taskId) ?? null
  const owner = db.prepare('SELECT authorization_revision,input_fence_revision FROM task_owners WHERE task_id=?').get(taskId) ?? null
  const runs = db.prepare('SELECT run_id,revision,status,pause_requested,stop_requested FROM execution_runs WHERE task_id=? ORDER BY rowid').all(taskId)
  const nodes = db.prepare('SELECT n.node_run_id,n.status,n.output_ref,n.wait_reason FROM execution_nodes n JOIN execution_runs r ON r.run_id=n.run_id WHERE r.task_id=? AND n.current=1 ORDER BY n.rowid').all(taskId)
  return { taskId, hash: createHash('sha256').update(json({ task, control, owner, runs, nodes })).digest('hex') }
}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
const textHash=v=>createHash('sha256').update(str(v)).digest('hex')
const digest=v=>createHash('sha256').update(json(canonical(v))).digest('hex')
function notificationFactDigest(db,n){
  const replacements=db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.restoresNotificationId')=? ORDER BY rowid").all(n.id).map(row=>JSON.parse(row.body).messageId)
  const command=n.commandId?get(db,'command',n.commandId):null,request=n.requestId?get(db,'request',n.requestId):null
  return digest({id:n.id,eventKey:n.eventKey??null,status:n.status,payload:n.payload,evidenceMessageId:n.evidence?.messageId??null,recallStatus:n.recallStatus??null,replacements,
    command:command?{status:command.status,kind:command.kind,args:command.args,result:command.result}:null,
    request:request?{status:request.status,kind:request.kind,revision:request.revision}:null})
}
const unitMeaning=u=>Object.fromEntries(Object.entries(u).filter(([k])=>!['id','runId','revision','status','corrections','preservedUnitId','topicId'].includes(k)))

export function installMessageSchema(db) {
  db.exec(`CREATE TABLE message_meta(version INTEGER NOT NULL CHECK(version=1)) STRICT;
    INSERT INTO message_meta VALUES(1);
    CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_version INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),UNIQUE(source_key,source_version)) STRICT;
    CREATE TABLE message_sources(source_key TEXT PRIMARY KEY,current_version INTEGER NOT NULL,claims INTEGER NOT NULL DEFAULT 0,corrections INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES message_runs(run_id),kind TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
    CREATE INDEX message_items_run_kind ON message_items(run_id,kind);
    CREATE INDEX message_command_task ON message_items(json_extract(body,'$.args.taskId')) WHERE kind='command';
    CREATE INDEX message_pending_barrier ON message_items(json_extract(body,'$.status')) WHERE kind='barrier';
    CREATE INDEX message_run_conversation ON message_runs(json_extract(body,'$.conversationId'));
    CREATE TABLE message_groups(conversation_id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
    CREATE TABLE message_workflows(digest TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;`)
  installMessageTopics(db)
}
export function validateMessageSchema(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='message_meta'").get()) fail('MESSAGE_SCHEMA_MISSING')
  if (db.prepare('SELECT version FROM message_meta').get()?.version !== 1) fail('MESSAGE_SCHEMA_MISMATCH')
  db.prepare('SELECT run_id,source_key,source_version,body FROM message_runs LIMIT 0').all()
  db.prepare('SELECT source_key,current_version,claims,corrections,input_tokens,output_tokens FROM message_sources LIMIT 0').all()
  db.prepare('SELECT item_id,run_id,kind,body FROM message_items LIMIT 0').all()
  db.prepare('SELECT digest,body FROM message_workflows LIMIT 0').all()
  db.prepare('SELECT conversation_id,body FROM message_groups LIMIT 0').all()
  validateMessageTopics(db)
}
const rows = (db,runId,kind) => db.prepare('SELECT body FROM message_items WHERE run_id=? AND kind=? ORDER BY rowid').all(runId,kind).map(r=>JSON.parse(r.body))
const put = (db,runId,kind,item) => { const existing=db.prepare('SELECT run_id FROM message_items WHERE item_id=?').get(kind+':'+item.id);if(existing&&existing.run_id!==runId)fail('MESSAGE_IDENTITY_CONFLICT');return db.prepare('INSERT INTO message_items VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET body=excluded.body').run(kind+':'+item.id,runId,kind,json(item)) }
const get = (db,kind,id) => { const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get(kind+':'+id); if(!row) fail('MESSAGE_ITEM_NOT_FOUND'); return JSON.parse(row.body) }
const run = (db,id) => { const r=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(str(id)); if(!r) fail('MESSAGE_RUN_NOT_FOUND'); return JSON.parse(r.body) }
const save = (db,r) => db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(json(r),r.runId)
function topicRunsStatus(db,topicId,intentStatus){
  for(const row of db.prepare("SELECT DISTINCT r.body FROM message_topic_bindings b JOIN message_runs r ON r.run_id=b.run_id JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version) WHERE b.topic_id=?").all(topicId)){
    const r=JSON.parse(row.body);if(r.status==='superseded')continue;r.intentStatus=intentStatus;save(db,r)
  }
}
const current = (db,r,revision) => { if(db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(r.sourceKey).current_version!==(r.validSourceVersion??r.sourceVersion) || r.status==='superseded' || (revision!==undefined && r.revision!==revision)) fail('MESSAGE_STALE') }
const controlKinds=new Set(['pause','cancel','resume','revise'])
function authorizedPriorityControl(db,control,unit,source){
 if(!control||!controlKinds.has(control.action)||!control.taskId||!unit||!source
   ||(unit.routingBinding?.taskId??unit.routingBinding?.target?.taskId)!==control.taskId)return false
 const origin=queryMessages(db,{kind:'message.task',taskId:control.taskId})
 return !!origin&&origin.run.conversationId===source.conversationId&&origin.run.actorId===source.actorId
}
function priorityTopicControls(db,topic,controls){
 if(!Array.isArray(controls))return null
 const entries=queryMessageTopics(db,{kind:'message.topic.units',topicId:topic.topicId})
 if(!entries.length||entries.length!==controls.length||new Set(controls.map(control=>control.unitId)).size!==controls.length)return null
 const byUnit=new Map(controls.map(control=>[control.unitId,control]))
 return entries.every(({run:source,unit})=>authorizedPriorityControl(db,byUnit.get(unit.id),unit,source))?byUnit:null
}
function settle(db,r) {
  const units=rows(db,r.runId,'unit').filter(u=>u.status!=='superseded')
  const requests=rows(db,r.runId,'request').filter(q=>q.status==='pending')
  const barriers=rows(db,r.runId,'barrier').filter(b=>b.status==='pending')
  if(r.status==='needs_attention'){save(db,r);return}
  r.status=units.length && units.every(u=>['applied','ignored','rejected'].includes(u.status)) && !requests.length && !barriers.length && !r.correction ? 'settled' : 'pending'
  save(db,r)
}
function revoke(db,r,unitIds) {
  for(const kind of ['node','command']) for(const i of rows(db,r.runId,kind)) {
    if(unitIds && !unitIds.includes(i.unitId)) continue
    if((kind==='node'&&i.status!=='superseded')||['ready','running','pending','waiting','failed'].includes(i.status)) { i.priorStatus=i.status;i.status=kind==='command' && i.status==='running'?'unknown':'superseded'; put(db,r.runId,kind,i) }
  }
}
export function recoverMessages(db) {
  for(const row of db.prepare('SELECT body FROM message_runs').all()) {
    const r=JSON.parse(row.body)
    for(const n of rows(db,r.runId,'node')) if(n.status==='running') { n.status='failed'; n.error='process_interrupted'; n.retryAt=new Date().toISOString(); put(db,r.runId,'node',n) }
    for(const n of rows(db,r.runId,'notification'))if(n.status==='sending'){n.status='unknown';put(db,r.runId,'notification',n)}
    for(const operation of rows(db,r.runId,'notification-operation'))if(operation.status==='in_flight'){operation.status='unknown';operation.error='process_interrupted';put(db,r.runId,'notification-operation',operation)}
    for(const c of rows(db,r.runId,'command')) if(c.status==='running') { c.status='unknown'; put(db,r.runId,'command',c) }
  }
}
export function reduceMessageCommand(db,{kind,args:a},ctx) {
  if(kind==='message.web-task.prepare') {
    const old=queryMessages(db,{kind:'message.web-task',eventId:a.eventId})
    if(old){if(json(canonical(old.request))!==json(canonical(a.request))||old.actorId!==a.actorId)fail('MESSAGE_WEB_EVENT_CONFLICT');return {result:{event:old}}}
    const origin=queryMessages(db,{kind:'message.task',taskId:a.request.taskId})
    if(!origin)fail('MESSAGE_TASK_NOT_FOUND')
    const task=db.prepare('SELECT * FROM execution_runs WHERE run_id=? AND task_id=?').get(a.executionRunId,a.request.taskId)
    const businessTask=db.prepare('SELECT requirement_revision,requirement_ref FROM business_tasks WHERE task_id=?').get(a.request.taskId)
    if(!task||!businessTask?.requirement_ref||a.request.runSequence!==1
      ||a.request.inputVersion!==businessTask.requirement_revision+1)fail('REVISION_CONFLICT')
    if(!['cancel','context'].includes(a.request.action))fail('MESSAGE_WEB_ACTION_UNSUPPORTED')
    if(a.request.action==='context'&&['succeeded','failed','cancelled'].includes(task.status))fail('RUN_TERMINAL')
    const event={id:str(a.eventId),actorId:str(a.actorId),runId:origin.run.runId,executionRunId:task.run_id,request:a.request,input:a.input??null,status:'pending'}
    put(db,event.runId,'web-task',event);return {result:{event}}
  }
  if(kind==='message.web-task.finish') {
    const event=get(db,'web-task',a.eventId)
    if(event.status==='pending'){event.status=a.error?'rejected':'accepted';event.result=a.result??null;event.error=a.error??null;put(db,event.runId,'web-task',event)}
    return {result:{event}}
  }
  const topic = reduceMessageTopic(db,{kind,args:a},ctx)
  if(topic!==null)return topic
  if(kind==='message.topic.bind') {
    const r=run(db,a.runId);current(db,r,a.expectedRevision)
    const u=get(db,'unit',a.unitId)
    if(u.runId!==r.runId||u.status!=='pending'||a.topic?.sourceRunId!==r.runId||a.topic?.unitId!==u.id)fail('MESSAGE_TOPIC_SOURCE_REQUIRED')
    if(db.prepare('SELECT 1 FROM message_topic_bindings WHERE unit_id=?').get(u.id))return {result:{topic:queryMessageTopics(db,{kind:'message.topic',topicId:u.topicId}),unit:u}}
    const result=reduceMessageTopic(db,{kind:'message.topic.upsert',args:a.topic},ctx)
    const bound=get(db,'unit',u.id);bound.routingBinding=a.binding;put(db,r.runId,'unit',bound)
    if(rows(db,r.runId,'unit').filter(item=>item.status!=='superseded').every(item=>db.prepare('SELECT 1 FROM message_topic_bindings WHERE unit_id=?').get(item.id))){r.routingStatus='routing_complete';r.intentStatus='waiting_routing_barrier';save(db,r)}
    return {result:{topic:result.result.topic,unit:bound}}
  }
  if(kind==='workflow.register') { str(a.workflowId);str(a.definitionVersion);str(a.digest);const old=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(a.digest);if(old&&json(JSON.parse(old.body))!==json(a))fail('WORKFLOW_DEFINITION_CONFLICT');if(!old)db.prepare('INSERT INTO message_workflows VALUES(?,?)').run(a.digest,json(a));return {result:a} }
  if(!kind.startsWith('message.')) return null
  const now=ctx.now
  if(kind.startsWith('message.notification.')) {
    if(kind==='message.notification.operation.prepare') {
      const n=get(db,'notification',a.notificationId),type=str(a.type),operationId=str(a.operationId),reason=str(a.reason),authorizationRef=str(a.authorizationRef)
      const existing=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification-operation:'+operationId)
      if(existing){
        const prior=JSON.parse(existing.body),s=prior.snapshot
        if(s.notificationId!==n.id||s.type!==type||s.reason!==reason||s.authorizationRef!==authorizationRef||s.evidenceRef!==(a.evidenceRef??null)||s.keepNotificationId!==(a.keepNotificationId??null)||s.body!==(a.body??(type==='restore'?n.payload.text:null)))fail('MESSAGE_NOTIFICATION_OPERATION_CONFLICT')
        return {result:{operation:prior}}
      }
      if(!['recall','restore'].includes(type)||n.status!=='delivered'||!n.evidence?.messageId)fail('MESSAGE_NOTIFICATION_OPERATION_NOT_READY')
      if(type==='recall'&&n.recallStatus==='recalled')fail('MESSAGE_NOTIFICATION_ALREADY_RECALLED')
      if(type==='restore'&&n.recallStatus!=='recalled')fail('MESSAGE_NOTIFICATION_NOT_RECALLED')
      if(!['fact_conflict','duplicate_event','explicit_user','correction'].includes(reason))fail('MESSAGE_NOTIFICATION_REASON_REQUIRED')
      if(reason==='fact_conflict'&&!a.evidenceRef)fail('MESSAGE_NOTIFICATION_EVIDENCE_REQUIRED')
      if(reason==='duplicate_event'){
        const kept=get(db,'notification',str(a.keepNotificationId))
        if(!n.eventKey||kept.id===n.id||kept.eventKey!==n.eventKey||kept.status!=='delivered'||kept.recallStatus==='recalled')fail('MESSAGE_NOTIFICATION_NOT_DUPLICATE')
      }
      if(type==='restore'&&a.body!==undefined&&a.body!==n.payload.text&&reason!=='correction')fail('MESSAGE_NOTIFICATION_CORRECTION_REQUIRED')
      const body=type==='restore'?str(a.body??n.payload.text):null
      const snapshot={notificationId:n.id,eventKey:n.eventKey??null,commandId:n.commandId??null,requestId:n.requestId??null,executionRunId:n.commandId?get(db,'command',n.commandId).result?.runId??null:null,
        type,reason,authorizationRef,evidenceRef:a.evidenceRef??null,keepNotificationId:a.keepNotificationId??null,body,bodyHash:body?textHash(body):null,
        originalBody:n.payload.text,originalBodyHash:textHash(n.payload.text),expectedFactDigest:notificationFactDigest(db,n),messageId:n.evidence.messageId,conversationId:n.payload.conversationId,sourceMessageId:n.payload.sourceMessageId??null}
      const operation={id:operationId,runId:n.runId,snapshot,status:'prepared',createdAt:now}
      put(db,n.runId,'notification-operation',operation);return {result:{operation}}
    }
    if(kind==='message.notification.operation.claim') {
      const op=get(db,'notification-operation',a.operationId),n=get(db,'notification',op.snapshot.notificationId)
      if(op.status!=='prepared'||a.expectedFactDigest!==op.snapshot.expectedFactDigest||a.authorizationRef!==op.snapshot.authorizationRef||notificationFactDigest(db,n)!==op.snapshot.expectedFactDigest)fail('MESSAGE_NOTIFICATION_OPERATION_STALE')
      op.status='in_flight';op.claimedAt=now;put(db,op.runId,'notification-operation',op);return {result:{operation:op},dispatchEligible:true}
    }
    if(kind==='message.notification.operation.result') {
      const op=get(db,'notification-operation',a.operationId)
      if(op.status!=='in_flight')fail('MESSAGE_NOTIFICATION_OPERATION_STALE')
      op.status=a.ack?'acknowledged':'unknown';op.ack=a.ack??null;op.error=a.error??null;op.resultAt=now;put(db,op.runId,'notification-operation',op);return {result:{operation:op}}
    }
    if(kind==='message.notification.operation.reconcile') {
      const op=get(db,'notification-operation',a.operationId),n=get(db,'notification',op.snapshot.notificationId)
      if(op.status==='completed'){if(op.externalMessageId!==a.messageId||op.evidenceRef!==a.evidenceRef)fail('MESSAGE_NOTIFICATION_OPERATION_CONFLICT');return {result:{operation:op}}}
      if(!['in_flight','acknowledged','unknown'].includes(op.status)||!a.evidenceRef||!a.messageId)fail('MESSAGE_NOTIFICATION_OPERATION_EVIDENCE_REQUIRED')
      if(op.snapshot.type==='recall'){
        if(a.messageId!==op.snapshot.messageId||a.recallStatus!=='SUCCESS'||n.recallStatus==='recalled')fail('MESSAGE_RECALL_EVIDENCE_MISMATCH')
        n.recallStatus='recalled';n.recalledAt=now;n.recallEvidenceRef=str(a.evidenceRef);put(db,n.runId,'notification',n)
      }else{
        if(a.messageId===op.snapshot.messageId||n.recallStatus!=='recalled')fail('MESSAGE_REPLACEMENT_EVIDENCE_MISMATCH')
        if(db.prepare("SELECT 1 FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.messageId')=?").get(a.messageId))fail('MESSAGE_REPLACEMENT_CONFLICT')
        const replacement={id:op.id,restoresNotificationId:n.id,eventKey:`${n.eventKey??n.id}:replacement:${op.id}`,messageId:str(a.messageId),body:op.snapshot.body,bodyHash:op.snapshot.bodyHash,conversationId:op.snapshot.conversationId,sourceMessageId:op.snapshot.sourceMessageId,evidenceRef:str(a.evidenceRef),status:'delivered',recordedAt:now}
        put(db,n.runId,'notification-replacement',replacement)
      }
      op.status='completed';op.externalMessageId=a.messageId;op.evidenceRef=a.evidenceRef;op.completedAt=now;put(db,op.runId,'notification-operation',op)
      return {result:{operation:op}}
    }
    if(kind==='message.notification.prepare') {
      const r=run(db,a.runId)
      if(Boolean(a.commandId)===Boolean(a.requestId))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')
      if(a.commandId){const c=get(db,'command',a.commandId);if(c.runId!==r.runId||!['applied','rejected'].includes(c.status))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      else {const q=get(db,'request',a.requestId);current(db,r,q.revision);if(q.runId!==r.runId||q.status!=='pending'||q.kind!=='needs_clarification')fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      if(!a.disclosure||a.disclosure.conversationId!==r.conversationId||!a.disclosure.authorizationRef)fail('MESSAGE_DISCLOSURE_REQUIRED')
      str(a.notificationId)
      const eventKey=str(a.eventKey??`${a.requestId?'request.clarification':'action.reply'}:${a.requestId??a.commandId}:${a.payload?.phase??'notice'}`)
      const sameEvent=db.prepare("SELECT body FROM message_items WHERE kind='notification' AND json_extract(body,'$.eventKey')=? LIMIT 1").get(eventKey)
      if(sameEvent){const old=JSON.parse(sameEvent.body);if(old.eventKey!==eventKey||json(canonical(old.payload))!==json(canonical(a.payload)))fail('MESSAGE_NOTIFICATION_EVENT_CONFLICT');return {result:{notification:old}}}
      if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('notification:'+a.notificationId)) {const old=get(db,'notification',a.notificationId);if(old.runId!==a.runId||old.commandId!==a.commandId||old.requestId!==a.requestId||json(canonical(old.payload))!==json(canonical(a.payload)))fail('MESSAGE_NOTIFICATION_CONFLICT');return {result:{notification:old}}}
      const n={id:a.notificationId,eventKey,runId:r.runId,...(a.commandId?{commandId:a.commandId}:{requestId:a.requestId}),payload:a.payload,disclosure:a.disclosure,status:'prepared',leaseEpoch:0,createdAt:now};put(db,r.runId,'notification',n);return {result:{notification:n}}
    }
    const n=get(db,'notification',a.notificationId)
    if(kind==='message.notification.recall.record') {
      if(n.status!=='delivered'||n.evidence?.messageId!==a.messageId||a.recallStatus!=='SUCCESS'||!a.evidenceRef)fail('MESSAGE_RECALL_EVIDENCE_MISMATCH')
      if(n.recallStatus==='recalled') {if(n.recallEvidenceRef!==a.evidenceRef)fail('MESSAGE_RECALL_EVIDENCE_CONFLICT');return {result:{notification:n}}}
      n.recallStatus='recalled';n.recalledAt=now;n.recallEvidenceRef=str(a.evidenceRef);put(db,n.runId,'notification',n)
      return {result:{notification:n}}
    }
    if(kind==='message.notification.replacement.record') {
      if(n.status!=='delivered'||n.recallStatus!=='recalled'||!a.evidenceRef||a.conversationId!==n.payload.conversationId||a.sourceMessageId!==n.payload.sourceMessageId)fail('MESSAGE_REPLACEMENT_EVIDENCE_MISMATCH')
      const replacementId=str(a.replacementId),messageId=str(a.messageId),body=str(a.body),evidenceRef=str(a.evidenceRef)
      if(messageId===n.evidence?.messageId)fail('MESSAGE_REPLACEMENT_EVIDENCE_MISMATCH')
      const previous=db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND (item_id=? OR json_extract(body,'$.messageId')=?) LIMIT 1").get('notification-replacement:'+replacementId,messageId)
      if(previous){const prior=JSON.parse(previous.body);if(prior.id!==replacementId||prior.restoresNotificationId!==n.id||prior.messageId!==messageId||prior.bodyHash!==textHash(body)||prior.evidenceRef!==evidenceRef)fail('MESSAGE_REPLACEMENT_CONFLICT');return {result:{replacement:prior}}}
      const replacement={id:replacementId,restoresNotificationId:n.id,eventKey:`${n.eventKey??n.id}:replacement:${replacementId}`,messageId,body,bodyHash:textHash(body),conversationId:a.conversationId,sourceMessageId:a.sourceMessageId,evidenceRef,status:'delivered',recordedAt:now}
      put(db,n.runId,'notification-replacement',replacement)
      return {result:{replacement}}
    }
    if(kind==='message.notification.claim') {if(n.status!=='prepared')fail('MESSAGE_NOTIFICATION_NOT_READY');const source=run(db,n.runId);if(source.status==='superseded'){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}if(n.requestId){const q=get(db,'request',n.requestId);if(q.status!=='pending'||q.revision!==source.revision){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}}
      if(n.payload?.phase?.startsWith('owner:')){
        const reportId=n.payload.phase.slice('owner:'.length)
        const fact=db.prepare(`SELECT r.task_id,r.turn_id,r.report_type,t.application_status,o.event_watermark,o.processed_watermark,
          b.requirement_revision,b.plan_requirement_revision
          FROM task_reports r JOIN task_owner_turns t ON t.turn_id=r.turn_id
          JOIN task_owners o ON o.task_id=r.task_id
          JOIN business_tasks b ON b.task_id=r.task_id WHERE r.report_id=?`).get(reportId)
        const latest=fact?db.prepare("SELECT turn_id FROM task_owner_turns WHERE task_id=? AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(fact.task_id):null
        if(!fact||fact.application_status!=='applied'||fact.report_type==='complete'
          &&(fact.event_watermark!==fact.processed_watermark||latest?.turn_id!==fact.turn_id
            ||fact.plan_requirement_revision!==fact.requirement_revision)){
          n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n)
          return {result:{notification:n},dispatchEligible:false}
        }
      }
      n.status='sending';n.leaseEpoch++;n.startedAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:true}}
    if(a.leaseEpoch!==n.leaseEpoch)fail('MESSAGE_NOTIFICATION_STALE')
    if(kind==='message.notification.sent') {if(n.status!=='sending')fail('MESSAGE_NOTIFICATION_STALE');n.status='acknowledged';n.ack=a.ack;n.ackAt=now}
    else if(kind==='message.notification.readback') {if(!['acknowledged','unknown'].includes(n.status)||!a.evidence?.messageId)fail('MESSAGE_NOTIFICATION_EVIDENCE_REQUIRED');n.status='delivered';n.evidence=a.evidence;n.deliveredAt=now}
    else if(kind==='message.notification.fail') {if(n.status!=='sending')fail('MESSAGE_NOTIFICATION_STALE');n.status='unknown';n.error=a.error}
    else fail('MESSAGE_UNKNOWN_COMMAND')
    put(db,n.runId,'notification',n);return {result:{notification:n}}
  }
  if(kind.startsWith('message.group.')) {
    str(a.conversationId)
    const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(a.conversationId)
    const g=row?JSON.parse(row.body):{conversationId:a.conversationId,epoch:0,state:'active',engine:'legacy'}
    if(a.expectedEpoch!==g.epoch)fail('MESSAGE_ENGINE_EPOCH_STALE')
    if(kind==='message.group.begin') {
      if(g.state!=='active')fail('MESSAGE_GROUP_TRANSITION_PENDING')
      g.previousEngine=g.engine;g.state='draining';g.legacySealRef=str(a.legacySealRef);g.cutoffRowId=db.prepare('SELECT COALESCE(MAX(rowid),0) AS seq FROM message_runs').get().seq
    } else if(kind==='message.group.activate') {
      if(g.state!=='draining'||g.legacySealRef!==a.legacySealRef)fail('MESSAGE_GROUP_TRANSITION_INVALID')
      const pending=db.prepare("SELECT body FROM message_runs WHERE rowid<=? AND json_extract(body,'$.conversationId')=? AND json_extract(body,'$.status') NOT IN ('settled','superseded','alias')").all(g.cutoffRowId,a.conversationId)
      const active=db.prepare("SELECT e.run_id FROM execution_runs e JOIN message_items i ON json_extract(i.body,'$.args.taskId')=e.task_id JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(r.body,'$.conversationId')=? AND e.status NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(a.conversationId)
      const barriers=db.prepare("SELECT 1 FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='barrier' AND json_extract(i.body,'$.status')='pending' AND json_extract(r.body,'$.conversationId')=? AND r.rowid<=? LIMIT 1").get(a.conversationId,g.cutoffRowId)
      if(pending.length||active||barriers)fail('MESSAGE_GROUP_NOT_DRAINED')
      g.state='active';g.engine='workflow';g.epoch++
      for(const item of db.prepare("SELECT body FROM message_runs WHERE json_extract(body,'$.conversationId')=? AND json_extract(body,'$.status')='buffered'").all(a.conversationId)){const r=JSON.parse(item.body);r.status='pending';r.engineEpoch=g.epoch;r.deadline=new Date(Date.parse(now)+30000).toISOString();save(db,r)}
    } else if(kind==='message.group.abort') {
      if(g.state!=='draining')fail('MESSAGE_GROUP_TRANSITION_INVALID')
      g.state='active';g.engine=g.previousEngine;g.abortedAt=now
      // buffered 记录不自动变成新引擎 runnable，旧引擎交接必须逐条确认。
    } else fail('MESSAGE_UNKNOWN_COMMAND')
    db.prepare('INSERT INTO message_groups VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body').run(a.conversationId,json(g))
    return {result:{group:g}}
  }
  if(kind==='message.source.alias') {
    const old=queryMessages(db,{kind:'message.source',sourceKey:a.sourceKey})
    if(!old||old.body!==a.body||old.actorId!==a.actorId||old.conversationId!==a.conversationId)fail('MESSAGE_ALIAS_NOT_EQUIVALENT')
    if(!Number.isSafeInteger(a.sourceVersion)||a.sourceVersion<=old.sourceVersion)fail('MESSAGE_STALE')
    const original=run(db,old.aliasOf??old.runId)
    original.validSourceVersion=a.sourceVersion;save(db,original)
    const alias={...old,runId:str(a.runId),sourceVersion:a.sourceVersion,aliasOf:original.runId,status:'alias',createdAt:now}
    delete alias.validSourceVersion
    db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run(alias.runId,alias.sourceKey,alias.sourceVersion,json(alias))
    db.prepare('UPDATE message_sources SET current_version=? WHERE source_key=?').run(alias.sourceVersion,alias.sourceKey)
    return {result:{run:original,alias}}
  }
  if(kind==='message.reprocess') {
    const old=run(db,str(a.runId));current(db,old)
    const stalledContext=old.sourceVersion===6 && old.status==='waiting' && rows(db,old.runId,'node').some(node=>node.nodeId==='S'&&node.output?.output?.kind==='needs_context')
    if(old.sourceVersion>=5 && !(old.sourceVersion===5 && old.reason==='recovery_exhausted' && !old.budgetBaseline) && !stalledContext)fail('MESSAGE_REPROCESS_EXHAUSTED')
    const oldUnits=rows(db,old.runId,'unit')
    const oldCommands=rows(db,old.runId,'command'),oldNotifications=rows(db,old.runId,'notification')
    if(oldNotifications.some(item=>!['prepared','superseded'].includes(item.status)))fail('MESSAGE_REPROCESS_EFFECT_PENDING')
    const rejectedFacts=old.status==='settled'&&oldUnits.length>0&&oldCommands.length>0
      && oldCommands.every(item=>item.kind==='fact'&&item.status==='rejected')
      && oldNotifications.every(item=>item.status==='prepared')
    const reconciledNoEffect=oldCommands.length>0
      && oldCommands.every(item=>item.status==='superseded'&&item.priorStatus==='failed'&&item.evidenceRef)
      && oldNotifications.every(item=>['prepared','superseded'].includes(item.status))
    if((!['waiting','needs_attention','pending'].includes(old.status) && !(old.status==='settled'&&oldUnits.length&&oldUnits.every(item=>item.status==='ignored')) && !rejectedFacts)
      || oldCommands.length&&!rejectedFacts&&!reconciledNoEffect)fail('MESSAGE_REPROCESS_EFFECT_PENDING')
    if(db.prepare('SELECT 1 FROM message_runs WHERE run_id=?').get(str(a.newRunId)))fail('MESSAGE_REPROCESS_EXISTS')
    const sequence=old.context?.replayOfSequenceId??db.prepare('SELECT rowid AS seq FROM message_runs WHERE run_id=?').get(old.runId).seq
    const origin=old.context?.replayOf?run(db,old.context.replayOf):old
    const spent=db.prepare('SELECT claims,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(old.sourceKey)
    for(const request of rows(db,old.runId,'request').filter(item=>item.status==='pending')){request.status='superseded';request.reason='message_reprocessed';put(db,old.runId,'request',request)}
    for(const notice of oldNotifications.filter(item=>item.status==='prepared')){notice.status='superseded';notice.supersededAt=now;put(db,old.runId,'notification',notice)}
    old.status='superseded';old.routingStatus='routing_superseded';old.reason='message_reprocessed';save(db,old);invalidateMessageSourceTopics(db,old.sourceKey,now)
    const next={...old,runId:a.newRunId,sourceVersion:old.sourceVersion+1,revision:0,status:'pending',routingStatus:'routing_pending',intentStatus:null,createdAt:now,
      context:{...old.context,occurredAt:old.context?.occurredAt??origin.context?.occurredAt??origin.createdAt,replayOf:origin.runId,replayOfSequenceId:sequence},snapshot:null,
      budgetBaseline:spent,policy:{...old.policy,effectiveMaxClaims:undefined},deadline:new Date(Date.parse(now)+(old.policy.initialWindowMs??45000)).toISOString()}
    delete next.activatedAt;delete next.reason;delete next.capacityRetryVersion
    db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run(next.runId,next.sourceKey,next.sourceVersion,json(next))
    db.prepare('UPDATE message_sources SET current_version=? WHERE source_key=?').run(next.sourceVersion,next.sourceKey)
    return {result:{run:next,previousRunId:old.runId}}
  }
  if(kind==='message.receive') {
    for(const k of ['runId','sourceKey','conversationId','actorId','body']) str(a[k])
    if(!Number.isSafeInteger(a.sourceVersion)||a.sourceVersion<1) fail('MESSAGE_INVALID_ARGUMENT')
    const prior=db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(a.sourceKey,a.sourceVersion)
    if(prior) { const p=JSON.parse(prior.body); if(p.body!==a.body||p.actorId!==a.actorId) fail('MESSAGE_SOURCE_CONFLICT'); return {result:{run:p}} }
    const source=db.prepare('SELECT * FROM message_sources WHERE source_key=?').get(a.sourceKey)
    if(source && source.current_version>=a.sourceVersion) fail('MESSAGE_STALE')
    if(source){const old=queryMessages(db,{kind:'message.source',sourceKey:a.sourceKey});if(old.actorId!==a.actorId||old.conversationId!==a.conversationId)fail('MESSAGE_SOURCE_ACTOR_MISMATCH')}
    const inheritedBarriers=source?db.prepare("SELECT i.body FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE r.source_key=? AND i.kind='barrier' AND json_extract(i.body,'$.status')='pending'").all(a.sourceKey).map(x=>JSON.parse(x.body)):[]
    if(source){invalidateMessageSourceTopics(db,a.sourceKey,now);for(const row of db.prepare('SELECT body FROM message_runs WHERE source_key=?').all(a.sourceKey)) {const r=JSON.parse(row.body);revoke(db,r);r.status='superseded';r.routingStatus='routing_superseded';save(db,r)}}
    db.prepare('INSERT INTO message_sources(source_key,current_version) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET current_version=excluded.current_version').run(a.sourceKey,a.sourceVersion)
    const r={...a,revision:0,status:'pending',routingStatus:'routing_pending',intentStatus:null,createdAt:now,policy:{maxClaims:21,maxCorrections:2,...a.policy},snapshot:null,deadline:new Date(Date.parse(now)+(a.barriers?.length?30000:45000)).toISOString()}
    const group=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(a.conversationId);if(group){const g=JSON.parse(group.body);r.engineEpoch=g.epoch;if(g.state!=='active'||g.engine!=='workflow')r.status='buffered'}
    db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run(a.runId,a.sourceKey,a.sourceVersion,json(r))
    for(const b of inheritedBarriers){b.previousOwnerRunId=b.ownerRunId;b.ownerRunId=r.runId;db.prepare('UPDATE message_items SET run_id=?,body=? WHERE item_id=?').run(r.runId,json(b),'barrier:'+b.id)}
    if(source)put(db,r.runId,'barrier',{id:'edit:'+r.runId,ownerRunId:r.runId,targetSourceKey:r.sourceKey,status:'pending',createdAt:now,reason:'source_edit'})
    for(const b of a.barriers??[]) {if(!b.targetSourceKey&&!b.targetTaskId)fail('MESSAGE_INVALID_BARRIER');put(db,r.runId,'barrier',{...b,id:str(b.barrierId),ownerRunId:r.runId,status:'pending',createdAt:now})}
    return {result:{run:r}}
  }
  if(kind==='message.task.control') {
    const origin=queryMessages(db,{kind:'message.task',taskId:a.taskId})
    if(!origin)fail('MESSAGE_TASK_NOT_FOUND')
    const r=origin.run,c=origin.command
    if(r.actorId!==a.actorId)fail('MESSAGE_ACTOR_FORBIDDEN')
    const controlSource=run(db,a.sourceRunId)
    if(controlSource.actorId!==a.actorId||controlSource.conversationId!==r.conversationId)fail('MESSAGE_ACTOR_FORBIDDEN')
    if(a.expectedSourceVersion!==undefined&&a.expectedSourceVersion!==r.sourceVersion)fail('MESSAGE_STALE')
    const editedPending=c.status==='superseded'&&['pending','paused'].includes(c.priorStatus)&&controlSource.sourceKey===r.sourceKey&&controlSource.sourceVersion>r.sourceVersion
    if(!['pending','paused'].includes(c.status)&&!editedPending)fail('MESSAGE_TASK_ALREADY_DISPATCHED')
    if(!['cancel','pause','resume','revise'].includes(a.action))fail('MESSAGE_INVALID_TASK_CONTROL')
    if(a.action==='revise'&&(!a.arguments||typeof a.arguments!=='object'||Array.isArray(a.arguments)))fail('MESSAGE_INVALID_TASK_CONTROL')
    if(editedPending||(r.status==='superseded'&&controlSource.sourceKey===r.sourceKey&&controlSource.sourceVersion>r.sourceVersion)){current(db,controlSource);if(editedPending)c.status=c.priorStatus;r.validSourceVersion=controlSource.sourceVersion;r.status='pending';c.args={...c.args,sourceInputRunId:controlSource.runId};save(db,r)}
    c.controlHistory=[...(c.controlHistory??[]),{action:a.action,actorId:a.actorId,sourceRunId:a.sourceRunId,priorArgs:c.args,priorStatus:c.status,at:now}]
    c.commandRevision=(c.commandRevision??0)+1
    if(a.action==='cancel'){c.status='cancelled';c.result={taskId:a.taskId,state:'cancelled',beforeStart:true};const u=get(db,'unit',c.unitId);if(rows(db,r.runId,'command').filter(x=>x.unitId===u.id&&x.id!==c.id).every(x=>['applied','cancelled'].includes(x.status)))u.status='applied';put(db,r.runId,'unit',u)}
    if(a.action==='pause')c.status='paused'
    if(a.action==='resume'){if(c.status!=='paused')fail('MESSAGE_TASK_NOT_PAUSED');c.status='pending'}
    if(a.action==='revise')c.args={...c.args,arguments:a.arguments,...(a.constraints?{constraints:a.constraints}:{})}
    put(db,r.runId,'command',c);settle(db,r);return {result:{command:c,run:r}}
  }
  if(kind.startsWith('message.command.')) {
    const c=get(db,'command',a.commandId),r=run(db,c.runId)
    if(kind==='message.command.reject') {
      if(c.status!=='pending')fail('MESSAGE_COMMAND_NOT_READY')
      c.status='rejected';c.result={status:'rejected',reason:str(a.reason),reply:`请求未执行：${a.reason}`};put(db,r.runId,'command',c)
      const u=get(db,'unit',c.unitId),all=rows(db,r.runId,'command').filter(x=>x.unitId===u.id)
      if(all.every(x=>['applied','rejected','cancelled'].includes(x.status))){u.status='rejected';put(db,r.runId,'unit',u)}
      settle(db,r);return {result:{command:c,run:r}}
    }
    if(kind==='message.command.reconcile') {if(c.status!=='unknown')fail('MESSAGE_COMMAND_NOT_UNKNOWN');if(!['applied','failed'].includes(a.status)||!a.evidenceRef)fail('MESSAGE_RECONCILE_EVIDENCE_REQUIRED');c.status=a.status;c.result=a.result??null;c.evidenceRef=a.evidenceRef;put(db,r.runId,'command',c);const u=get(db,'unit',c.unitId);if(rows(db,r.runId,'command').filter(x=>x.unitId===u.id).every(x=>x.status==='applied')){u.status='applied';put(db,r.runId,'unit',u)}settle(db,r);return {result:{command:c}}}
    if(kind==='message.command.retry.readonly') {
      current(db,r,c.revision)
      if(!['status','result'].includes(c.kind)||c.status!=='unknown'||c.error!=='INVALID_ARGUMENT'||(c.readonlyRetryCount??0)>=1||c.result!==null)fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
      if(rows(db,r.runId,'notification').some(item=>item.commandId===c.commandId||item.commandId===c.id))fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
      c.readonlyRetryCount=(c.readonlyRetryCount??0)+1;c.status='pending';c.error=null;c.result=null;put(db,r.runId,'command',c)
      if(r.status==='needs_attention'&&r.reason==='recovery_exhausted'){r.status='pending';r.reason=null;r.deadline=new Date(Date.parse(now)+30000).toISOString();save(db,r)}
      return {result:{command:c,run:r}}
    }
    if(kind==='message.command.claim') {
      current(db,r,c.revision)
      if(c.status!=='pending') fail('MESSAGE_COMMAND_NOT_READY')
      if(c.topicId){
        if(queryMessages(db,{kind:'message.routing.pending',conversationId:r.conversationId}).length
          && !authorizedPriorityControl(db,c.priorityControl,get(db,'unit',c.unitId),r))fail('MESSAGE_INPUT_PENDING')
        const topic=queryMessageTopics(db,{kind:'message.topic',topicId:c.topicId})
        if(!topic||topic.inputRevision!==c.topicInputRevision){
          c.priorStatus=c.status;c.status='superseded';c.reason='topic_input_changed';put(db,r.runId,'command',c)
          const u=get(db,'unit',c.unitId)
          u.status='pending';put(db,r.runId,'unit',u)
          settle(db,r)
          return {result:{command:c},dispatchEligible:false}
        }
      }
      if(r.correction)fail('MESSAGE_CORRECTION_PENDING')
      if(r.status==='buffered')fail('MESSAGE_ENGINE_NOT_ACTIVE')
    if(r.status==='needs_attention')fail('MESSAGE_NEEDS_ATTENTION')
      const fences=db.prepare("SELECT body FROM message_items WHERE kind='barrier'").all().map(x=>JSON.parse(x.body))
      if(fences.some(b=>b.status==='pending'&&b.ownerRunId!==c.runId&&((b.targetSourceKey===r.sourceKey&&(!b.unitIds||b.unitIds.includes(c.unitId)))||(b.targetTaskId&&b.targetTaskId===c.args?.taskId))))fail('MESSAGE_INPUT_PENDING')
      for(const id of c.dependsOn??[])if(get(db,'command',id).status!=='applied')fail('MESSAGE_DEPENDENCY_PENDING')
      c.status='running';c.leaseEpoch++;c.startedAt=now;put(db,r.runId,'command',c)
      return {result:{command:c},dispatchEligible:true}
    }
    if(c.status!=='running'||c.leaseEpoch!==a.leaseEpoch)fail('MESSAGE_COMMAND_STALE')
    if(!['message.command.complete','message.command.fail'].includes(kind))fail('MESSAGE_UNKNOWN_COMMAND')
    c.status=kind.endsWith('fail')?'unknown':'applied';c.result=a.result??null;c.error=a.error??null;c.completedAt=now;put(db,r.runId,'command',c)
    const u=get(db,'unit',c.unitId)
    if(rows(db,r.runId,'command').filter(x=>x.unitId===u.id).every(x=>x.status==='applied')) {u.status='applied';put(db,r.runId,'unit',u)}
    settle(db,r);return {result:{command:c,run:r}}
  }
  if(kind==='message.clarification.fold') {
    const r=run(db,a.runId),target=run(db,a.targetRunId),q=get(db,'request',a.requestId)
    if(r.status==='superseded'&&r.reason==='clarification_answer_reconciled')return {result:{run:r}}
    if(r.runId===target.runId||r.sourceKey!==a.eventId||r.conversationId!==target.conversationId
      ||q.runId!==target.runId||q.kind!=='needs_clarification'||q.status!=='pending'
      ||!r.context?.quoteRefs?.some(ref=>ref.messageId===a.replyToMessageId)
      ||rows(db,r.runId,'command').length||rows(db,r.runId,'notification').some(n=>!['prepared','delivered'].includes(n.status)))fail('MESSAGE_CLARIFICATION_FOLD_FORBIDDEN')
    current(db,r)
    revoke(db,r)
    for(const request of rows(db,r.runId,'request').filter(item=>item.status==='pending')){request.status='superseded';request.reason='clarification_answer_reconciled';put(db,r.runId,'request',request)}
    for(const notice of rows(db,r.runId,'notification').filter(item=>item.status==='prepared')){notice.status='superseded';notice.supersededAt=now;put(db,r.runId,'notification',notice)}
    for(const barrier of rows(db,r.runId,'barrier').filter(item=>item.status==='pending')){
      barrier.status='resolved';barrier.resolution='clarification_answer_reconciled';put(db,r.runId,'barrier',barrier)
    }
    r.status='superseded';r.reason='clarification_answer_reconciled';r.routingStatus='routing_complete';r.intentStatus='processed';save(db,r)
    return {result:{run:r}}
  }
  if(kind==='message.clarification.reconcile') {
    const r=run(db,a.runId),target=run(db,a.targetRunId),q=get(db,'request',a.requestId)
    if(r.status!=='superseded'||r.reason!=='clarification_answer_reconciled'
      ||q.runId!==target.runId||q.kind!=='needs_clarification'||q.status!=='resolved'
      ||q.eventId!==r.sourceKey||r.conversationId!==target.conversationId
      ||db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(r.sourceKey)?.current_version!==r.sourceVersion)
      fail('MESSAGE_CLARIFICATION_RECONCILE_FORBIDDEN')
    const notices=rows(db,target.runId,'notification').filter(item=>item.requestId===q.id
      && item.status==='delivered' && item.evidence?.messageId
      && r.context?.quoteRefs?.some(ref=>ref.messageId===item.evidence.messageId))
    if(notices.length!==1)fail('MESSAGE_CLARIFICATION_RECONCILE_PROOF_MISSING')
    const topics=db.prepare(`SELECT DISTINCT b.topic_id FROM message_topic_bindings b
      JOIN message_topics t ON t.topic_id=b.topic_id WHERE b.run_id=?
      AND (?='$' OR b.unit_id=?) AND t.conversation_id=?`).all(target.runId,q.unitId,q.unitId,r.conversationId)
    if(topics.length!==1)fail('MESSAGE_CLARIFICATION_TOPIC_NOT_UNIQUE')
    const unitId=`clarification:${r.runId}`
    const bound=db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(unitId)
    if(bound&&bound.topic_id!==topics[0].topic_id)fail('MESSAGE_CLARIFICATION_TOPIC_CONFLICT')
    if(!bound)db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)')
      .run(unitId,r.runId,topics[0].topic_id,r.sourceKey,r.sourceVersion)
    for(const barrier of rows(db,r.runId,'barrier').filter(item=>item.status==='pending')){
      barrier.status='resolved';barrier.resolution='clarification_answer_reconciled';put(db,r.runId,'barrier',barrier)
    }
    r.routingStatus='routing_complete';r.intentStatus='processed';r.foldedIntoRunId=target.runId;save(db,r)
    return {result:{run:r,topicId:topics[0].topic_id,bound:!bound}}
  }
  const r=run(db,a.runId);current(db,r,a.expectedRevision)
  if(kind==='message.quiet') {
    const original=str(a.body)
    if(r.body!==original||(r.context?.quoteRefs?.length&&!isPassiveTaskProgress(original))||rows(db,r.runId,'command').length||!['pending','waiting'].includes(r.status))fail('MESSAGE_QUIET_NOT_ALLOWED')
    if(!isQuietGroupMessage(original)||a.topic&&!isPassiveTaskProgress(original))fail('MESSAGE_QUIET_NOT_ALLOWED')
    for(const request of rows(db,r.runId,'request').filter(item=>item.status==='pending')){request.status='superseded';request.reason='message_quiet';put(db,r.runId,'request',request)}
    for(const unit of rows(db,r.runId,'unit').filter(item=>item.status==='pending')){unit.status='ignored';put(db,r.runId,'unit',unit)}
    r.status='settled';r.routingStatus='routing_complete';r.intentStatus='processed';r.reason='message_quiet';save(db,r)
    const binding=a.topic?bindQuietTopic(db,{runId:r.runId,...a.topic}):null
    return {result:{run:r,binding}}
  }
  if(kind==='message.quiet.topic.bind') {
    if(!isPassiveTaskProgress(r.body))fail('MESSAGE_QUIET_TOPIC_FORBIDDEN')
    return {result:{binding:bindQuietTopic(db,{runId:r.runId,...a.topic})}}
  }
  if(kind==='message.material.record') {
    str(a.resourceRef)
    if(!a.material||typeof a.material.text!=='string'||Buffer.byteLength(a.material.text)>65536)fail('MESSAGE_MATERIAL_INVALID')
    const id=json([r.runId,a.resourceRef]),old=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('material:'+id)
    if(old){const material=JSON.parse(old.body).material;if(json(canonical(material))!==json(canonical(a.material)))fail('MESSAGE_MATERIAL_CONFLICT');return {result:{material}}}
    put(db,r.runId,'material',{id,runId:r.runId,resourceRef:a.resourceRef,material:a.material,recordedAt:now});return {result:{material:a.material}}
  }
  if(kind==='message.attention') {r.status='needs_attention';r.reason=a.reason;if(r.routingStatus!=='routing_complete')r.routingStatus='routing_blocked';else r.intentStatus='intent_blocked';save(db,r);return {result:{run:r}}}
  if(kind==='message.echo.quarantine') {
    const id=r.context?.sourceMessageId
    const outbound=id&&db.prepare("SELECT 1 FROM message_items i JOIN message_runs source ON source.run_id=i.run_id WHERE i.kind='notification' AND json_extract(source.body,'$.conversationId')=? AND json_extract(i.body,'$.evidence.messageId')=? LIMIT 1").get(r.conversationId,id)
    if(!outbound||rows(db,r.runId,'command').length)fail('MESSAGE_ECHO_QUARANTINE_FORBIDDEN')
    if(r.status==='superseded')return {result:{run:r}}
    for(const request of rows(db,r.runId,'request').filter(item=>item.status==='pending')) {request.status='superseded';put(db,r.runId,'request',request)}
    r.status='superseded';r.reason='outbound_echo';save(db,r)
    return {result:{run:r}}
  }
  if(kind==='message.activate') {
    if(r.status!=='pending'||r.activatedAt)return {result:{run:r}}
    current(db,r)
    r.activatedAt=now;r.deadline=new Date(Date.parse(now)+r.policy.initialWindowMs).toISOString();save(db,r)
    return {result:{run:r}}
  }
  if(kind==='message.capacity.retry') {
    const stage=['s-compact-v1','s-budget-v2'].includes(a.projectionVersion)?'S':['r-source-refs-v1','r-bounded-cards-v2','r-budget-v3'].includes(a.projectionVersion)?'R':['i-bounded-facts-v1','i-budget-v2'].includes(a.projectionVersion)?'I':null
    if(!stage||r.status!=='needs_attention'||!r.reason?.startsWith(`MESSAGE_CONTEXT_CAPACITY:${stage}:`))return {result:{run:r,retry:false}}
    current(db,r)
    if(!r.snapshot||r.correction)return {result:{run:r,retry:false}}
    const units=rows(db,r.runId,'unit'),nodes=rows(db,r.runId,'node')
    const target=stage==='S'?null:units.find(unit=>r.reason.startsWith(`MESSAGE_CONTEXT_CAPACITY:${stage}:${unit.id}:`))
    if(stage==='S'&&(units.length||nodes.length))return {result:{run:r,retry:false}}
    if(stage!=='S'&&(!target||target.status!=='pending'||rows(db,r.runId,'command').some(command=>command.unitId===target.id)||rows(db,r.runId,'request').some(request=>request.unitId===target.id&&request.status==='pending')||nodes.some(node=>node.unitId===target.id&&node.nodeId!==stage&&node.nodeId!=='R'&&node.nodeId!=='S')))return {result:{run:r,retry:false}}
    if(stage==='R'&&!nodes.some(node=>node.nodeId==='S'&&['completed','succeeded'].includes(node.status)))return {result:{run:r,retry:false}}
    if(stage==='I'&&!nodes.some(node=>node.unitId===target.id&&node.nodeId==='R'&&['completed','succeeded'].includes(node.status)))return {result:{run:r,retry:false}}
    if(r.capacityRetryVersion===a.projectionVersion)return {result:{run:r,retry:false}}
    r.capacityRetryVersion=a.projectionVersion;r.status='pending';r.reason=null;r.deadline=new Date(Date.parse(now)+r.policy.initialWindowMs).toISOString();save(db,r)
    return {result:{run:r,retry:true}}
  }
  if(kind==='message.relink') {const u=get(db,'unit',a.unitId);if(u.runId!==r.runId)fail('MESSAGE_STALE');if(rows(db,r.runId,'command').some(c=>c.unitId===u.id&&['running','unknown','applied'].includes(c.status)))fail('MESSAGE_CORRECTION_EFFECT_PENDING');revoke(db,r,[u.id]);unbindMessageUnit(db,u.id,now);const s=db.prepare('SELECT corrections FROM message_sources WHERE source_key=?').get(r.sourceKey);db.prepare('UPDATE message_sources SET corrections=corrections+1 WHERE source_key=?').run(r.sourceKey);u.status='pending';delete u.topicId;delete u.routingBinding;r.routingStatus='routing_pending';r.intentStatus=null;u.corrections=(u.corrections??0)+1;put(db,r.runId,'unit',u);save(db,r);if(u.corrections>1||s.corrections>=r.policy.maxCorrections){r.status='needs_attention';r.reason='correction_budget_exhausted';r.routingStatus='routing_blocked';save(db,r);return {result:{run:r,unit:u}}}return {result:{run:r,unit:u}}}
  if(kind==='message.recover') { if(r.status==='waiting'||r.status==='settled')fail('MESSAGE_NOT_RECOVERABLE'); if((r.recoveryWindows??0)>=2||Date.parse(now)-Date.parse(r.createdAt)>600000){r.status='needs_attention';r.reason='recovery_exhausted';save(db,r);return {result:{run:r}}}r.recoveryWindows=(r.recoveryWindows??0)+1;r.deadline=new Date(Date.parse(now)+30000).toISOString();r.status='pending';save(db,r);return {result:{run:r}} }
  if(kind==='message.snapshot') {r.snapshot=a.snapshot;save(db,r);return {result:{run:r}}}
  if(kind==='message.correction.begin') {
    const s=db.prepare('SELECT corrections FROM message_sources WHERE source_key=?').get(r.sourceKey)
    revoke(db,r,a.unitIds);r.correction={id:a.correctionId??randomUUID(),unitIds:a.unitIds??null,reason:a.reason,createdAt:now};r.revision++
    put(db,r.runId,'barrier',{id:'correction:'+r.correction.id,ownerRunId:r.runId,targetSourceKey:r.sourceKey,status:'pending',createdAt:now,reason:'correction',unitIds:r.correction.unitIds})
    db.prepare('UPDATE message_sources SET corrections=corrections+1 WHERE source_key=?').run(r.sourceKey)
    r.status=s.corrections>=r.policy.maxCorrections?'needs_attention':'pending';save(db,r);return {result:{run:r}}
  }
  if(kind==='message.split'||kind==='message.correction.publish') {
    if(!Array.isArray(a.units)||!a.units.length||a.units.length>8)fail('MESSAGE_INVALID_UNITS')
    if(r.correction&&a.correctionId!==r.correction.id)fail('MESSAGE_CORRECTION_STALE')
    if(rows(db,r.runId,'unit').length&&!r.correction)fail('MESSAGE_SPLIT_ALREADY_PUBLISHED')
    const ids=a.units.map(u=>str(u.unitId));if(new Set(ids).size!==ids.length)fail('MESSAGE_INVALID_UNITS')
    if(r.policy.effectiveMaxClaims===undefined)r.policy.effectiveMaxClaims=r.policy.maxClaims
    const previous=rows(db,r.runId,'unit'),preserved=new Set()
    for(const u of a.units)if(u.preservedUnitId) {
      const old=previous.find(x=>x.id===u.preservedUnitId)
      if(!old||u.unitId!==old.id||json(canonical(unitMeaning(old)))!==json(canonical(unitMeaning(u))))fail('MESSAGE_PRESERVATION_INVALID')
      preserved.add(old.id)
    }
    if(rows(db,r.runId,'command').some(c=>!preserved.has(c.unitId)&&['running','unknown','applied'].includes(c.status)))fail('MESSAGE_CORRECTION_EFFECT_PENDING')
    for(const u of previous)if(!preserved.has(u.id)){unbindMessageUnit(db,u.id,now);u.status='superseded';put(db,r.runId,'unit',u)}
    for(const u of a.units) {
      const old=previous.find(x=>x.id===u.preservedUnitId)
      put(db,r.runId,'unit',old?{...old,revision:r.revision}:{...u,id:u.unitId,runId:r.runId,revision:r.revision,status:'pending'})
    }
    for(const type of ['node','command'])for(const item of rows(db,r.runId,type))if(preserved.has(item.unitId)) {
      item.revision=r.revision
      if(item.status==='superseded'&&item.priorStatus!=='running'&&r.correction?.unitIds&&!r.correction.unitIds.includes(item.unitId))item.status=item.priorStatus??item.status
      put(db,r.runId,type,item)
    }
    if(r.correction){const b=get(db,'barrier','correction:'+r.correction.id);b.status='resolved';b.resolution='validated_correction';put(db,r.runId,'barrier',b)}
    r.correction=null;r.routingStatus='routing_pending';r.intentStatus=null;save(db,r);return {result:{run:r,units:rows(db,r.runId,'unit')}}
  }
  if(kind==='message.node.claim') {
    if(r.status==='buffered')fail('MESSAGE_ENGINE_NOT_ACTIVE')
    if(r.status==='needs_attention')fail('MESSAGE_NEEDS_ATTENTION')
    if(!['S','R','I','IB','answer','material'].includes(a.nodeId))fail('MESSAGE_INVALID_NODE')
    if(a.unitId!=='$'&&get(db,'unit',a.unitId).runId!==r.runId)fail('MESSAGE_STALE')
    if(a.nodeId!=='IB'&&Date.parse(r.deadline)<=Date.parse(now))fail('MESSAGE_DEADLINE_EXCEEDED')
    const s=db.prepare('SELECT claims,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(r.sourceKey)
    const baseline=r.budgetBaseline??{claims:0,input_tokens:0,output_tokens:0}
    const deterministic=a.input?.deterministic===true
    if(deterministic&&(!a.input.inputHash||a.estimatedInputTokens!==0||a.maxOutputTokens!==0))fail('MESSAGE_INVALID_BUDGET')
    if(!deterministic&&s.claims-baseline.claims>=(r.policy.effectiveMaxClaims??r.policy.maxClaims))fail('MESSAGE_BUDGET_EXHAUSTED')
    const reserve={input:a.estimatedInputTokens??0,output:a.maxOutputTokens??0};if(!Object.values(reserve).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET');if(s.input_tokens-baseline.input_tokens+reserve.input>(r.policy.maxInputTokens??64000)||s.output_tokens-baseline.output_tokens+reserve.output>(r.policy.maxOutputTokens??12000))fail('MESSAGE_BUDGET_EXHAUSTED')
    const previous=rows(db,r.runId,'node').find(n=>n.unitId===a.unitId&&n.nodeId===a.nodeId&&n.revision===r.revision&&n.input?.topicInputRevision===a.input?.topicInputRevision&&n.input?.contextHash===a.input?.contextHash&&n.status!=='superseded')
    if(previous&&['running','succeeded','waiting'].includes(previous.status))fail('MESSAGE_NODE_NOT_READY')
    if(previous?.retryAt&&Date.parse(previous.retryAt)>Date.parse(now))fail('MESSAGE_RETRY_NOT_DUE')
    const n={id:previous?.id??randomUUID(),nodeRunId:previous?.id??null,runId:r.runId,unitId:a.unitId,nodeId:a.nodeId,revision:r.revision,leaseEpoch:(previous?.leaseEpoch??0)+1,status:'running',input:a.input,reservedTokens:reserve,createdAt:previous?.createdAt??now,startedAt:now};n.nodeRunId=n.id
    if(a.nodeId==='IB')topicRunsStatus(db,a.input.topicId,'intent_judging')
    db.prepare('UPDATE message_sources SET claims=claims+?,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(deterministic?0:1,reserve.input,reserve.output,r.sourceKey)
    put(db,r.runId,'node',n);return {result:{node:n}}
  }
  if(kind==='message.node.complete'||kind==='message.node.fail') {
    const n=get(db,'node',a.nodeRunId)
    if(n.runId!==r.runId||n.revision!==r.revision||n.leaseEpoch!==a.leaseEpoch||n.status!=='running')fail('MESSAGE_NODE_STALE')
    if(a.usage) { const used={input:a.usage.inputTokens,output:a.usage.outputTokens};if(!Object.values(used).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET');db.prepare('UPDATE message_sources SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(used.input-n.reservedTokens.input,used.output-n.reservedTokens.output,r.sourceKey);n.usage=used }
    if(kind.endsWith('complete')&&n.nodeId!=='IB'&&Date.parse(now)>Date.parse(r.deadline))fail('MESSAGE_DEADLINE_EXCEEDED')
    n.status=kind.endsWith('complete')?'succeeded':'failed';n.output=a.output??null;n.error=a.error??null;n.retryAt=a.retryAt??null;n.completedAt=now
    if(n.status==='succeeded'){r.deadline=new Date(Date.parse(now)+(r.policy.linkedWindowMs??30000)).toISOString();save(db,r)}
    put(db,r.runId,'node',n);return {result:{node:n}}
  }
  if(kind==='message.accept') {
    const u=get(db,'unit',a.unitId);if(u.runId!==r.runId||u.revision!==r.revision||u.status!=='pending'||r.correction)fail('MESSAGE_UNIT_STALE')
    if(!Array.isArray(a.commands)||(!a.commands.length&&!['ignored','rejected'].includes(a.outcome)))fail('MESSAGE_INVALID_DISPOSITION')
    if(a.topic){if(a.topic.sourceRunId!==r.runId||a.topic.unitId!==u.id)fail('MESSAGE_TOPIC_SOURCE_REQUIRED');reduceMessageTopic(db,{kind:'message.topic.upsert',args:a.topic},ctx);u.topicId=a.topic.topicId}
    for(const x of a.commands) {str(x.commandId);str(x.kind);const c={...x,id:x.commandId,runId:r.runId,unitId:u.id,revision:r.revision,status:'pending',leaseEpoch:0,createdAt:now};if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('command:'+c.id))fail('MESSAGE_COMMAND_CONFLICT');put(db,r.runId,'command',c)}
    u.status=a.commands.length?'accepted':a.outcome;put(db,r.runId,'unit',u);settle(db,r);return {result:{unit:u,run:r,commands:rows(db,r.runId,'command').filter(c=>c.unitId===u.id)}}
  }
  if(kind==='message.topic.intent.accept') {
    for(const version of a.taskFactVersions??[])if(taskFactVersion(db,version.taskId).hash!==version.hash)fail('MESSAGE_TASK_FACTS_STALE')
    const topic=queryMessageTopics(db,{kind:'message.topic',topicId:a.topicId})
    if(!topic||topic.conversationId!==a.conversationId)fail('MESSAGE_TOPIC_SCOPE_MISMATCH')
    if(topic.inputRevision!==a.inputRevision)fail('MESSAGE_TOPIC_STALE')
    if(a.contextRevision!==undefined&&topic.contextRevision!==a.contextRevision)fail('MESSAGE_TOPIC_CONTEXT_STALE')
    if(topic.processedRevision===a.inputRevision)return {result:{status:'accepted',topic,decisions:a.decisions}}
    const pending=queryMessages(db,{kind:'message.routing.pending',conversationId:a.conversationId})
    const priority=pending.length?priorityTopicControls(db,topic,a.priorityControls):null
    if(pending.length&&(!priority||a.decisions?.some(decision=>{
      const control=priority.get(decision.unitId)
      return !control||decision.commands?.length!==1||decision.commands[0].kind!==control.action||decision.commands[0].args?.taskId!==control.taskId
    }))){topicRunsStatus(db,a.topicId,'waiting_routing_barrier');return {result:{status:'WAIT_ROUTING',pending:pending.length}}}
    if(!Array.isArray(a.decisions)||!a.decisions.length)fail('MESSAGE_INVALID_DISPOSITION')
    const currentUnits=queryMessageTopics(db,{kind:'message.topic.units',topicId:a.topicId})
    if(currentUnits.length!==a.decisions.length||new Set(a.decisions.map(item=>item.unitId)).size!==a.decisions.length
      ||currentUnits.some(({unit})=>!a.decisions.some(item=>item.unitId===unit.id)))fail('MESSAGE_TOPIC_STALE')
    const appliedFactRevisions=new Map()
    for(const decision of a.decisions){
      const item=currentUnits.find(({unit})=>unit.id===decision.unitId)
      const r=item.run,u=item.unit
      current(db,r,decision.expectedRevision)
      if(!Array.isArray(decision.commands)||(!decision.commands.length&&!['ignored','rejected','applied'].includes(decision.outcome)))fail('MESSAGE_INVALID_DISPOSITION')
      for(const change of decision.factRevisions??[]){
        const revisionIdentity=json([r.actorId,change.sourceQuote,change.scope])
        if(appliedFactRevisions.has(change.factId)){
          if(appliedFactRevisions.get(change.factId)!==revisionIdentity||!r.body.includes(change.sourceQuote))fail('MESSAGE_TOPIC_FACT_REVISION_CONFLICT')
          continue
        }
        const row=db.prepare("SELECT body FROM message_topic_facts WHERE topic_id=? AND fact_id=? AND status='active'").get(a.topicId,str(change.factId))
        if(!row)fail('MESSAGE_TOPIC_FACT_REVISION_INVALID')
        const fact=JSON.parse(row.body)
        if(fact.actorId!==r.actorId||!r.body.includes(str(change.sourceQuote))||!/改为|修改|不再|取消|撤销|替换|现在允许/u.test(change.sourceQuote)||!wholeTopicFactRevision(r.body,change))fail('MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN')
        str(change.scope)
        for(const prior of db.prepare("SELECT fact_id,body FROM message_topic_facts WHERE topic_id=? AND status='active'").all(a.topicId)){
          const equivalent=JSON.parse(prior.body)
          if(equivalent.actorId!==fact.actorId||equivalent.kind!==fact.kind||equivalent.text!==fact.text)continue
          db.prepare("UPDATE message_topic_facts SET status='superseded',body=? WHERE topic_id=? AND fact_id=?").run(json({...equivalent,status:'superseded',supersededBy:{sourceKey:r.sourceKey,sourceVersion:r.sourceVersion,sourceQuote:change.sourceQuote,scope:change.scope},supersededAt:now}),a.topicId,prior.fact_id)
        }
        const revised=JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(a.topicId).body)
        revised.contextRevision=(revised.contextRevision??0)+1
        db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(revised),a.topicId)
        appliedFactRevisions.set(change.factId,revisionIdentity)
      }
      const outstanding=rows(db,r.runId,'command').filter(command=>command.unitId===u.id&&command.status==='superseded'&&command.reason==='topic_input_changed'&&command.priorStatus==='pending'&&!command.replacedBy)
      const remaining=[...decision.commands]
      for(const old of outstanding){const index=remaining.findIndex(command=>command.kind===old.kind);if(index<0)fail('MESSAGE_OUTSTANDING_ACTION_UNRESOLVED');old.replacedBy=remaining[index].commandId;put(db,r.runId,'command',old);remaining.splice(index,1)}
      if(decision.topicFacts?.length)reduceMessageTopic(db,{kind:'message.topic.upsert',args:{topicId:a.topicId,conversationId:a.conversationId,sourceRunId:r.runId,unitId:u.id,title:topic.title,facts:decision.topicFacts}},ctx)
      for(const x of decision.commands){
        str(x.commandId);str(x.kind)
        if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('command:'+x.commandId))fail('MESSAGE_COMMAND_CONFLICT')
        put(db,r.runId,'command',{...x,id:x.commandId,runId:r.runId,unitId:u.id,revision:r.revision,topicId:a.topicId,topicInputRevision:a.inputRevision,
          ...(priority?{priorityControl:priority.get(u.id)}:{}),status:'pending',leaseEpoch:0,createdAt:now})
      }
      u.status=decision.commands.length?'accepted':decision.outcome;put(db,r.runId,'unit',u);settle(db,r)
    }
    const latest=queryMessageTopics(db,{kind:'message.topic',topicId:a.topicId})
    latest.processedRevision=a.inputRevision;latest.updatedAt=now
    db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(Object.fromEntries(Object.entries(latest).filter(([key])=>!['facts','hasMoreFacts'].includes(key)))),latest.topicId)
    topicRunsStatus(db,a.topicId,'processed')
    return {result:{status:'accepted',topic:latest,decisions:a.decisions}}
  }
  if(kind==='message.topic.refresh') {
    const topic=queryMessageTopics(db,{kind:'message.topic',topicId:a.topicId})
    if(!topic||topic.inputRevision!==a.inputRevision)fail('MESSAGE_TOPIC_STALE')
    if(queryMessages(db,{kind:'message.routing.pending',conversationId:topic.conversationId}).length
      && !priorityTopicControls(db,topic,a.priorityControls))return {result:{status:'WAIT_ROUTING'}}
    let count=0
    for(const row of db.prepare("SELECT i.body FROM message_items i WHERE i.kind='command' AND json_extract(i.body,'$.topicId')=? AND json_extract(i.body,'$.status')='pending'").all(topic.topicId)){
      const c=JSON.parse(row.body)
      if(c.topicInputRevision===topic.inputRevision)continue
      c.priorStatus=c.status;c.status='superseded';c.reason='topic_input_changed';put(db,c.runId,'command',c)
      const u=get(db,'unit',c.unitId)
      u.status='pending';put(db,u.runId,'unit',u)
      const owner=run(db,u.runId);settle(db,owner);count++
    }
    if(count)topicRunsStatus(db,a.topicId,'intent_rejudging')
    return {result:{status:'ready',superseded:count}}
  }
  if(kind==='message.topic.intent.retry') {
    const u=get(db,'unit',a.unitId),r=run(db,u.runId)
    current(db,r,a.expectedRevision)
    if(!['ignored','pending'].includes(u.status)||!u.topicId||rows(db,r.runId,'command').some(c=>c.unitId===u.id)
      ||rows(db,r.runId,'notification').some(n=>!['prepared','superseded'].includes(n.status)))fail('MESSAGE_INTENT_RETRY_EFFECT_PENDING')
    const topic=queryMessageTopics(db,{kind:'message.topic',topicId:u.topicId})
    if(!topic||topic.conversationId!==r.conversationId||topic.processedRevision>topic.inputRevision
      ||queryMessages(db,{kind:'message.routing.pending',conversationId:r.conversationId}).length)fail('MESSAGE_TOPIC_STALE')
    for(const request of rows(db,r.runId,'request').filter(item=>item.unitId===u.id&&item.status==='pending')){request.status='superseded';request.reason='intent_rejudging';put(db,r.runId,'request',request)}
    topic.inputRevision++;topic.updatedAt=now
    db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(Object.fromEntries(Object.entries(topic).filter(([key])=>!['facts','hasMoreFacts'].includes(key)))),topic.topicId)
    u.status='pending';put(db,r.runId,'unit',u)
    r.status='pending';r.intentStatus='intent_rejudging';r.deadline=new Date(Date.parse(now)+30000).toISOString();save(db,r)
    return {result:{run:r,unit:u,topic}}
  }
  if(kind==='message.wait'||kind==='message.request.open') {
    const requestedId=a.request?.requestId??a.requestId;if(requestedId&&db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('request:'+requestedId)){const existing=get(db,'request',requestedId);if(existing.runId!==r.runId||existing.unitId!==(a.unitId??'$')||existing.nodeId!==a.nodeId||existing.revision!==r.revision)fail('MESSAGE_REQUEST_EXISTS');return {result:{request:existing,run:r}}}
    const q={...a.request,id:a.request?.requestId??a.requestId??randomUUID(),runId:r.runId,unitId:a.unitId??'$',nodeId:a.nodeId,revision:r.revision,status:'pending',reason:a.reason,createdAt:now}
    put(db,r.runId,'request',q);r.status='waiting';if(['S','R'].includes(a.nodeId))r.routingStatus='routing_blocked';else r.intentStatus='intent_blocked';save(db,r);return {result:{request:q,run:r}}
  }
  if(kind==='message.wake'||kind==='message.request.resolve') {
    const q=get(db,'request',a.requestId)
    if(q.runId!==r.runId||q.revision!==r.revision)fail('MESSAGE_REQUEST_STALE')
    if(q.permittedActors?.length&&!q.permittedActors.includes(a.actorId)
      &&!(q.kind==='needs_clarification'&&a.ownerAnswer===true))fail('MESSAGE_ACTOR_FORBIDDEN')
    if(q.status!=='pending')return {result:{request:q,run:r}}
    q.status='resolved';q.answer=a.answer;q.eventId=str(a.eventId);q.resolvedAt=now;put(db,r.runId,'request',q)
    for(const n of rows(db,r.runId,'node')) if(n.unitId===q.unitId&&n.nodeId===q.nodeId&&n.revision===r.revision) {n.status='superseded';put(db,r.runId,'node',n)}
    r.status='pending';if(['S','R'].includes(q.nodeId))r.routingStatus='routing_pending';else r.intentStatus='intent_rejudging';r.deadline=new Date(Date.parse(now)+30000).toISOString();save(db,r);return {result:{request:q,run:r}}
  }
  if(kind==='message.barrier.resolve') {
    const b=get(db,'barrier',a.barrierId);if(b.ownerRunId!==r.runId)fail('MESSAGE_BARRIER_OWNER');b.status='resolved';b.resolution=a.resolution;put(db,r.runId,'barrier',b);settle(db,r);return {result:{barrier:b}}
  }
  fail('MESSAGE_UNKNOWN_COMMAND')
}
export function queryMessages(db,a) {
  if(a.kind==='message.clarifications.unlinked') {
    const limit=a.limit??100
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('MESSAGE_INVALID_LIMIT')
    return db.prepare(`SELECT answer.run_id AS run_id,target.run_id AS target_run_id,
      json_extract(request.body,'$.id') AS request_id
      FROM message_runs answer
      JOIN message_items request ON request.kind='request'
        AND json_extract(request.body,'$.kind')='needs_clarification'
        AND json_extract(request.body,'$.status')='resolved'
        AND json_extract(request.body,'$.eventId')=answer.source_key
      JOIN message_runs target ON target.run_id=request.run_id
      JOIN message_topic_bindings binding ON binding.run_id=target.run_id
        AND (json_extract(request.body,'$.unitId')='$'
          OR binding.unit_id=json_extract(request.body,'$.unitId'))
      WHERE json_extract(answer.body,'$.status')='superseded'
        AND json_extract(answer.body,'$.reason')='clarification_answer_reconciled'
        AND json_extract(answer.body,'$.conversationId')=json_extract(target.body,'$.conversationId')
        AND NOT EXISTS(SELECT 1 FROM message_topic_bindings linked WHERE linked.run_id=answer.run_id)
      GROUP BY answer.run_id,target.run_id,request.item_id
      HAVING COUNT(DISTINCT binding.topic_id)=1
      ORDER BY answer.rowid LIMIT ?`).all(limit)
      .map(row=>({runId:row.run_id,targetRunId:row.target_run_id,requestId:row.request_id}))
  }
  if(a.kind==='message.notification'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification:'+str(a.notificationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationOperation'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification-operation:'+str(a.operationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationReplacement'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification-replacement:'+str(a.replacementId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationReplacements')return db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.restoresNotificationId')=? ORDER BY rowid").all(str(a.notificationId)).map(row=>JSON.parse(row.body))
  if(a.kind==='message.web-task'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('web-task:'+str(a.eventId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.web-tasks.pending')return db.prepare("SELECT body FROM message_items WHERE kind='web-task' AND json_extract(body,'$.status')='pending' ORDER BY rowid LIMIT 100").all().map(row=>JSON.parse(row.body))
  const topic=queryMessageTopics(db,a)
  if(topic!==undefined)return topic
  if(a.kind==='message.intent.runs') {
    const limit=a.limit??50,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT')
    return db.prepare(`SELECT i.rowid AS seq,i.body FROM message_items i WHERE i.kind='node' AND i.rowid<?
      AND json_extract(i.body,'$.nodeId')='IB' AND EXISTS (
        SELECT 1 FROM json_each(i.body,'$.input.units') u WHERE json_extract(u.value,'$.runId')=?
      ) ORDER BY i.rowid DESC LIMIT ?`).all(before,str(a.runId),limit)
      .map(row=>({...JSON.parse(row.body),carrierRunId:JSON.parse(row.body).runId,sequenceId:row.seq}))
  }
  if(a.kind==='message.routing.pending')return db.prepare(`SELECT r.body FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
    WHERE json_extract(r.body,'$.conversationId')=? AND json_extract(r.body,'$.status') NOT IN ('buffered','alias','superseded')
    AND NOT (json_extract(r.body,'$.status')='settled' AND json_extract(r.body,'$.reason')='message_quiet')
    AND (NOT EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='unit')
      OR EXISTS (SELECT 1 FROM message_items i LEFT JOIN message_topic_bindings b ON b.unit_id=json_extract(i.body,'$.id')
        WHERE i.run_id=r.run_id AND i.kind='unit' AND json_extract(i.body,'$.status')!='superseded' AND b.unit_id IS NULL))
    ORDER BY r.rowid`).all(str(a.conversationId)).map(row=>JSON.parse(row.body))
  if(a.kind==='message.task.version')return taskFactVersion(db,a.taskId)
  if(a.kind==='message.material'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('material:'+json([str(a.runId),str(a.resourceRef)]));return row?JSON.parse(row.body).material:null}
  if(a.kind==='message.request')return get(db,'request',a.requestId)
  if(a.kind==='message.outboundByMessage') {
    const messageId=str(a.messageId),conversationId=str(a.conversationId)
    const row=db.prepare("SELECT i.body FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='notification' AND json_extract(r.body,'$.conversationId')=? AND (json_extract(i.body,'$.evidence.messageId')=? OR json_extract(i.body,'$.ack.messageId')=? OR json_extract(i.body,'$.ack.result.messageId')=?) LIMIT 1").get(conversationId,messageId,messageId,messageId)
    return row?JSON.parse(row.body):null
  }
  if(a.kind==='message.outboundIds') {
    return db.prepare("SELECT json_extract(i.body,'$.evidence.messageId') AS message_id FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='notification' AND json_extract(r.body,'$.conversationId')=? AND json_extract(i.body,'$.evidence.messageId') IS NOT NULL").all(str(a.conversationId)).map(row=>row.message_id)
  }
  if(a.kind==='message.quiet.unbound') {
    const limit=a.limit??100
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('MESSAGE_QUERY_INVALID')
    return db.prepare(`SELECT r.body FROM message_runs r LEFT JOIN message_topic_bindings b ON b.run_id=r.run_id
      WHERE b.run_id IS NULL AND json_extract(r.body,'$.status')='settled' AND json_extract(r.body,'$.reason')='message_quiet'
      ORDER BY r.rowid DESC LIMIT ?`).all(limit).map(row=>JSON.parse(row.body))
  }
  if(a.kind==='message.requestByReply') {
    const found=db.prepare("SELECT i.body FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='notification' AND json_extract(i.body,'$.requestId') IS NOT NULL AND json_extract(i.body,'$.evidence.messageId')=? AND json_extract(r.body,'$.conversationId')=?").all(str(a.messageId),str(a.conversationId))
    const requestIds=[...new Set(found.map(x=>JSON.parse(x.body).requestId))]
    if(requestIds.length>1)fail('MESSAGE_REQUEST_AMBIGUOUS')
    if(!requestIds.length)return null
    const request=get(db,'request',requestIds[0]);return {request,run:run(db,request.runId)}
  }
  if(a.kind==='workflow.list')return db.prepare('SELECT body FROM message_workflows ORDER BY digest').all().map(x=>JSON.parse(x.body))
  if(a.kind==='message.notifications') {
    const limit=a.limit??100,after=a.afterSequenceId??0,states=a.states??['prepared','sending','acknowledged','unknown']
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(after)||after<0||!Array.isArray(states)||!states.length||states.some(s=>!['prepared','sending','acknowledged','unknown','delivered','superseded'].includes(s)))fail('MESSAGE_INVALID_LIMIT')
    const scoped = a.runId ? ' AND run_id=?' : ''
    return db.prepare(`SELECT rowid AS seq,body FROM message_items WHERE kind='notification' AND rowid>? AND json_extract(body,'$.status') IN (SELECT value FROM json_each(?))${scoped} ORDER BY rowid LIMIT ?`)
      .all(after,json(states),...(a.runId?[str(a.runId)]:[]),limit).map(x=>({...JSON.parse(x.body),sequenceId:x.seq}))
  }
  if(a.kind==='message.group') {const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(str(a.conversationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.task-candidates') {const limit=a.limit??30,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT');return db.prepare("SELECT i.rowid AS seq,r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen') AND json_extract(r.body,'$.conversationId')=? AND i.rowid<? ORDER BY i.rowid DESC LIMIT ?").all(str(a.conversationId),before,limit).map(x=>({run:JSON.parse(x.run),command:JSON.parse(x.command),sequenceId:x.seq}))}
  if(a.kind==='message.list') {
    const limit=a.limit??30,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT')
    const sql=a.conversationId?"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND json_extract(body, '$.conversationId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?":"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND rowid<? ORDER BY rowid DESC LIMIT ?"
    return db.prepare(sql).all(...(a.conversationId?[a.conversationId,before,limit]:[before,limit])).map(x=>({...JSON.parse(x.body),sequenceId:x.seq}))
  }
  if(a.kind==='message.task') {const row=db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen') ORDER BY i.rowid LIMIT 1").get(str(a.taskId));return row?{run:JSON.parse(row.run),command:JSON.parse(row.command)}:null}
  if(a.kind==='message.task.latest') {const row=db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen') AND json_extract(i.body,'$.status')='applied' ORDER BY i.rowid DESC LIMIT 1").get(str(a.taskId));return row?{run:JSON.parse(row.run),command:JSON.parse(row.command)}:null}
  if(a.kind==='message.source') {const row=db.prepare('SELECT r.body FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=r.source_version WHERE r.source_key=?').get(str(a.sourceKey));return row?JSON.parse(row.body):null}
  if(a.kind==='message.pending')return db.prepare("SELECT r.body FROM message_runs r WHERE json_extract(r.body,'$.status') NOT IN ('settled','superseded','buffered','alias') OR (json_extract(r.body,'$.status')='settled' AND EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='barrier' AND json_extract(i.body,'$.status')='pending')) ORDER BY r.rowid").all().map(x=>JSON.parse(x.body))
  if(a.kind==='message.command')return get(db,'command',a.commandId)
  if(a.kind==='message.run') {const r=run(db,a.runId);return {run:r,units:rows(db,r.runId,'unit'),nodes:rows(db,r.runId,'node'),commands:rows(db,r.runId,'command'),requests:rows(db,r.runId,'request'),barriers:rows(db,r.runId,'barrier'),budget:db.prepare('SELECT claims,corrections,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(r.sourceKey)}}
  return undefined
}

/** 屏障直接保护执行控制账；创建命令须在 accept 时固定 args.taskId。 */
export function assertMessageTaskUnfenced(db,taskId) {
 const fences=db.prepare("SELECT body FROM message_items WHERE kind='barrier' AND json_extract(body,'$.status')='pending'").all().map(x=>JSON.parse(x.body))
 if(!fences.length)return
 const sources=db.prepare("SELECT r.source_key, json_extract(i.body,'$.unitId') AS unit_id FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=?").all(taskId)
 if(fences.some(b=>b.targetTaskId===taskId||sources.some(s=>s.source_key===b.targetSourceKey&&(!b.unitIds||b.unitIds.includes(s.unit_id)))))fail('MESSAGE_INPUT_PENDING')
}
