import { randomUUID } from 'node:crypto'
import { installMessageTopics, validateMessageTopics, reduceMessageTopic, queryMessageTopics } from './message-topics.js'

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
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
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
const current = (db,r,revision) => { if(db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(r.sourceKey).current_version!==(r.validSourceVersion??r.sourceVersion) || r.status==='superseded' || (revision!==undefined && r.revision!==revision)) fail('MESSAGE_STALE') }
function settle(db,r) {
  const units=rows(db,r.runId,'unit').filter(u=>u.status!=='superseded')
  const requests=rows(db,r.runId,'request').filter(q=>q.status==='pending')
  if(r.status==='needs_attention'){save(db,r);return}
  r.status=units.length && units.every(u=>['applied','ignored','rejected'].includes(u.status)) && !requests.length && !r.correction ? 'settled' : 'pending'
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
    if(!task||a.request.runSequence!==1||a.request.inputVersion!==task.revision+1)fail('REVISION_CONFLICT')
    if(a.request.action==='context'&&db.prepare("SELECT 1 FROM execution_inputs WHERE run_id=? AND status='pending'").get(task.run_id))fail('INPUT_PENDING')
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
  if(kind==='workflow.register') { str(a.workflowId);str(a.definitionVersion);str(a.digest);const old=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(a.digest);if(old&&json(JSON.parse(old.body))!==json(a))fail('WORKFLOW_DEFINITION_CONFLICT');if(!old)db.prepare('INSERT INTO message_workflows VALUES(?,?)').run(a.digest,json(a));return {result:a} }
  if(!kind.startsWith('message.')) return null
  const now=ctx.now
  if(kind.startsWith('message.notification.')) {
    if(kind==='message.notification.prepare') {
      const r=run(db,a.runId)
      if(Boolean(a.commandId)===Boolean(a.requestId))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')
      if(a.commandId){const c=get(db,'command',a.commandId);if(c.runId!==r.runId||!['applied','rejected'].includes(c.status))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      else {const q=get(db,'request',a.requestId);current(db,r,q.revision);if(q.runId!==r.runId||q.status!=='pending'||q.kind!=='needs_clarification')fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      if(!a.disclosure||a.disclosure.conversationId!==r.conversationId||!a.disclosure.authorizationRef)fail('MESSAGE_DISCLOSURE_REQUIRED')
      str(a.notificationId)
      if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('notification:'+a.notificationId)) {const old=get(db,'notification',a.notificationId);if(old.runId!==a.runId||old.commandId!==a.commandId||old.requestId!==a.requestId||json(canonical(old.payload))!==json(canonical(a.payload)))fail('MESSAGE_NOTIFICATION_CONFLICT');return {result:{notification:old}}}
      const n={id:a.notificationId,runId:r.runId,...(a.commandId?{commandId:a.commandId}:{requestId:a.requestId}),payload:a.payload,disclosure:a.disclosure,status:'prepared',leaseEpoch:0,createdAt:now};put(db,r.runId,'notification',n);return {result:{notification:n}}
    }
    const n=get(db,'notification',a.notificationId)
    if(kind==='message.notification.recall.record') {
      if(n.status!=='delivered'||n.evidence?.messageId!==a.messageId||a.recallStatus!=='SUCCESS')fail('MESSAGE_RECALL_EVIDENCE_MISMATCH')
      if(n.recallStatus==='recalled')return {result:{notification:n}}
      n.recallStatus='recalled';n.recalledAt=now;put(db,n.runId,'notification',n)
      return {result:{notification:n}}
    }
    if(kind==='message.notification.claim') {if(n.status!=='prepared')fail('MESSAGE_NOTIFICATION_NOT_READY');if(n.requestId){const q=get(db,'request',n.requestId),r=run(db,n.runId);if(q.status!=='pending'||q.revision!==r.revision||r.status==='superseded'){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}}n.status='sending';n.leaseEpoch++;n.startedAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:true}}
    if(a.leaseEpoch!==n.leaseEpoch)fail('MESSAGE_NOTIFICATION_STALE')
    if(kind==='message.notification.sent') {if(n.status!=='sending')fail('MESSAGE_NOTIFICATION_STALE');n.status='acknowledged';n.ack=a.ack;n.ackAt=now}
    else if(kind==='message.notification.readback') {if(!['acknowledged','unknown'].includes(n.status)||!a.evidence)fail('MESSAGE_NOTIFICATION_EVIDENCE_REQUIRED');n.status='delivered';n.evidence=a.evidence;n.deliveredAt=now}
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
  if(kind==='message.receive') {
    for(const k of ['runId','sourceKey','conversationId','actorId','body']) str(a[k])
    if(!Number.isSafeInteger(a.sourceVersion)||a.sourceVersion<1) fail('MESSAGE_INVALID_ARGUMENT')
    const prior=db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(a.sourceKey,a.sourceVersion)
    if(prior) { const p=JSON.parse(prior.body); if(p.body!==a.body||p.actorId!==a.actorId) fail('MESSAGE_SOURCE_CONFLICT'); return {result:{run:p}} }
    const source=db.prepare('SELECT * FROM message_sources WHERE source_key=?').get(a.sourceKey)
    if(source && source.current_version>=a.sourceVersion) fail('MESSAGE_STALE')
    if(source){const old=queryMessages(db,{kind:'message.source',sourceKey:a.sourceKey});if(old.actorId!==a.actorId||old.conversationId!==a.conversationId)fail('MESSAGE_SOURCE_ACTOR_MISMATCH')}
    const inheritedBarriers=source?db.prepare("SELECT i.body FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE r.source_key=? AND i.kind='barrier' AND json_extract(i.body,'$.status')='pending'").all(a.sourceKey).map(x=>JSON.parse(x.body)):[]
    if(source) for(const row of db.prepare('SELECT body FROM message_runs WHERE source_key=?').all(a.sourceKey)) {const r=JSON.parse(row.body);revoke(db,r);r.status='superseded';save(db,r)}
    db.prepare('INSERT INTO message_sources(source_key,current_version) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET current_version=excluded.current_version').run(a.sourceKey,a.sourceVersion)
    const r={...a,revision:0,status:'pending',createdAt:now,policy:{maxClaims:21,maxCorrections:2,...a.policy},snapshot:null,deadline:new Date(Date.parse(now)+(a.barriers?.length?30000:45000)).toISOString()}
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
    if(kind==='message.command.claim') {
      current(db,r,c.revision)
      if(c.status!=='pending') fail('MESSAGE_COMMAND_NOT_READY')
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
  const r=run(db,a.runId);current(db,r,a.expectedRevision)
  if(kind==='message.material.record') {
    str(a.resourceRef)
    if(!a.material||typeof a.material.text!=='string'||Buffer.byteLength(a.material.text)>65536)fail('MESSAGE_MATERIAL_INVALID')
    const id=json([r.runId,a.resourceRef]),old=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('material:'+id)
    if(old){const material=JSON.parse(old.body).material;if(json(canonical(material))!==json(canonical(a.material)))fail('MESSAGE_MATERIAL_CONFLICT');return {result:{material}}}
    put(db,r.runId,'material',{id,runId:r.runId,resourceRef:a.resourceRef,material:a.material,recordedAt:now});return {result:{material:a.material}}
  }
  if(kind==='message.attention') {r.status='needs_attention';r.reason=a.reason;save(db,r);return {result:{run:r}}}
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
    const stage=a.projectionVersion==='s-compact-v1'?'S':['r-source-refs-v1','r-bounded-cards-v2'].includes(a.projectionVersion)?'R':a.projectionVersion==='i-bounded-facts-v1'?'I':null
    if(!stage||r.status!=='needs_attention'||!r.reason?.startsWith(`MESSAGE_CONTEXT_CAPACITY:${stage}:`))return {result:{run:r,retry:false}}
    current(db,r)
    if(!r.snapshot||['command','request','barrier'].some(type=>rows(db,r.runId,type).length))return {result:{run:r,retry:false}}
    if(stage==='S'&&['unit','node'].some(type=>rows(db,r.runId,type).length))return {result:{run:r,retry:false}}
    if(stage==='R'&&(!rows(db,r.runId,'unit').length||rows(db,r.runId,'node').some(node=>node.nodeId!=='S'||!['completed','succeeded'].includes(node.status))))return {result:{run:r,retry:false}}
    if(stage==='I'&&(!rows(db,r.runId,'unit').length||!rows(db,r.runId,'node').some(node=>node.nodeId==='R'&&['completed','succeeded'].includes(node.status))||rows(db,r.runId,'node').some(node=>!['S','R'].includes(node.nodeId)||!['completed','succeeded'].includes(node.status))))return {result:{run:r,retry:false}}
    if(r.capacityRetryVersion===a.projectionVersion)return {result:{run:r,retry:false}}
    r.capacityRetryVersion=a.projectionVersion;r.status='pending';r.reason=null;r.deadline=new Date(Date.parse(now)+r.policy.initialWindowMs).toISOString();save(db,r)
    return {result:{run:r,retry:true}}
  }
  if(kind==='message.relink') {const u=get(db,'unit',a.unitId);if(u.runId!==r.runId)fail('MESSAGE_STALE');if(rows(db,r.runId,'command').some(c=>c.unitId===u.id&&['running','unknown','applied'].includes(c.status)))fail('MESSAGE_CORRECTION_EFFECT_PENDING');revoke(db,r,[u.id]);const s=db.prepare('SELECT corrections FROM message_sources WHERE source_key=?').get(r.sourceKey);db.prepare('UPDATE message_sources SET corrections=corrections+1 WHERE source_key=?').run(r.sourceKey);u.status='pending';u.corrections=(u.corrections??0)+1;put(db,r.runId,'unit',u);if(u.corrections>1||s.corrections>=r.policy.maxCorrections){r.status='needs_attention';r.reason='correction_budget_exhausted';save(db,r);return {result:{run:r,unit:u}}}return {result:{run:r,unit:u}}}
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
    if(r.policy.effectiveMaxClaims===undefined)r.policy.effectiveMaxClaims=Math.min(r.policy.maxClaims,1+2*a.units.length+4)
    const previous=rows(db,r.runId,'unit'),preserved=new Set()
    for(const u of a.units)if(u.preservedUnitId) {
      const old=previous.find(x=>x.id===u.preservedUnitId)
      if(!old||u.unitId!==old.id||json(canonical(unitMeaning(old)))!==json(canonical(unitMeaning(u))))fail('MESSAGE_PRESERVATION_INVALID')
      preserved.add(old.id)
    }
    if(rows(db,r.runId,'command').some(c=>!preserved.has(c.unitId)&&['running','unknown','applied'].includes(c.status)))fail('MESSAGE_CORRECTION_EFFECT_PENDING')
    for(const u of previous)if(!preserved.has(u.id)){u.status='superseded';put(db,r.runId,'unit',u)}
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
    r.correction=null;save(db,r);return {result:{run:r,units:rows(db,r.runId,'unit')}}
  }
  if(kind==='message.node.claim') {
    if(r.status==='buffered')fail('MESSAGE_ENGINE_NOT_ACTIVE')
    if(r.status==='needs_attention')fail('MESSAGE_NEEDS_ATTENTION')
    if(!['S','R','I','answer','material'].includes(a.nodeId))fail('MESSAGE_INVALID_NODE')
    if(a.unitId!=='$'&&get(db,'unit',a.unitId).runId!==r.runId)fail('MESSAGE_STALE')
    if(Date.parse(r.deadline)<=Date.parse(now))fail('MESSAGE_DEADLINE_EXCEEDED')
    const s=db.prepare('SELECT claims,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(r.sourceKey)
    if(s.claims>=(r.policy.effectiveMaxClaims??r.policy.maxClaims))fail('MESSAGE_BUDGET_EXHAUSTED')
    const reserve={input:a.estimatedInputTokens??0,output:a.maxOutputTokens??0};if(!Object.values(reserve).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET');if(s.input_tokens+reserve.input>(r.policy.maxInputTokens??64000)||s.output_tokens+reserve.output>(r.policy.maxOutputTokens??12000))fail('MESSAGE_BUDGET_EXHAUSTED')
    const previous=rows(db,r.runId,'node').find(n=>n.unitId===a.unitId&&n.nodeId===a.nodeId&&n.revision===r.revision&&n.status!=='superseded')
    if(previous&&['running','succeeded','waiting'].includes(previous.status))fail('MESSAGE_NODE_NOT_READY')
    if(previous?.retryAt&&Date.parse(previous.retryAt)>Date.parse(now))fail('MESSAGE_RETRY_NOT_DUE')
    const n={id:previous?.id??randomUUID(),nodeRunId:previous?.id??null,runId:r.runId,unitId:a.unitId,nodeId:a.nodeId,revision:r.revision,leaseEpoch:(previous?.leaseEpoch??0)+1,status:'running',input:a.input,reservedTokens:reserve,createdAt:previous?.createdAt??now,startedAt:now};n.nodeRunId=n.id
    db.prepare('UPDATE message_sources SET claims=claims+1,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(reserve.input,reserve.output,r.sourceKey)
    put(db,r.runId,'node',n);return {result:{node:n}}
  }
  if(kind==='message.node.complete'||kind==='message.node.fail') {
    const n=get(db,'node',a.nodeRunId)
    if(n.runId!==r.runId||n.revision!==r.revision||n.leaseEpoch!==a.leaseEpoch||n.status!=='running')fail('MESSAGE_NODE_STALE')
    if(a.usage) { const used={input:a.usage.inputTokens,output:a.usage.outputTokens};if(!Object.values(used).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET');db.prepare('UPDATE message_sources SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(used.input-n.reservedTokens.input,used.output-n.reservedTokens.output,r.sourceKey);n.usage=used }
    if(kind.endsWith('complete')&&Date.parse(now)>Date.parse(r.deadline))fail('MESSAGE_DEADLINE_EXCEEDED')
    n.status=kind.endsWith('complete')?'succeeded':'failed';n.output=a.output??null;n.error=a.error??null;n.retryAt=a.retryAt??null;n.completedAt=now
    put(db,r.runId,'node',n);return {result:{node:n}}
  }
  if(kind==='message.accept') {
    const u=get(db,'unit',a.unitId);if(u.runId!==r.runId||u.revision!==r.revision||u.status!=='pending'||r.correction)fail('MESSAGE_UNIT_STALE')
    if(!Array.isArray(a.commands)||(!a.commands.length&&!['ignored','rejected'].includes(a.outcome)))fail('MESSAGE_INVALID_DISPOSITION')
    if(a.topic){if(a.topic.sourceRunId!==r.runId||a.topic.unitId!==u.id)fail('MESSAGE_TOPIC_SOURCE_REQUIRED');reduceMessageTopic(db,{kind:'message.topic.upsert',args:a.topic},ctx);u.topicId=a.topic.topicId}
    for(const x of a.commands) {str(x.commandId);str(x.kind);const c={...x,id:x.commandId,runId:r.runId,unitId:u.id,revision:r.revision,status:'pending',leaseEpoch:0,createdAt:now};if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('command:'+c.id))fail('MESSAGE_COMMAND_CONFLICT');put(db,r.runId,'command',c)}
    u.status=a.commands.length?'accepted':a.outcome;put(db,r.runId,'unit',u);settle(db,r);return {result:{unit:u,run:r,commands:rows(db,r.runId,'command').filter(c=>c.unitId===u.id)}}
  }
  if(kind==='message.wait'||kind==='message.request.open') {
    const requestedId=a.request?.requestId??a.requestId;if(requestedId&&db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('request:'+requestedId)){const existing=get(db,'request',requestedId);if(existing.runId!==r.runId||existing.unitId!==(a.unitId??'$')||existing.nodeId!==a.nodeId||existing.revision!==r.revision)fail('MESSAGE_REQUEST_EXISTS');return {result:{request:existing,run:r}}}
    const q={...a.request,id:a.request?.requestId??a.requestId??randomUUID(),runId:r.runId,unitId:a.unitId??'$',nodeId:a.nodeId,revision:r.revision,status:'pending',reason:a.reason,createdAt:now}
    put(db,r.runId,'request',q);r.status='waiting';save(db,r);return {result:{request:q,run:r}}
  }
  if(kind==='message.wake'||kind==='message.request.resolve') {
    const q=get(db,'request',a.requestId)
    if(q.runId!==r.runId||q.revision!==r.revision)fail('MESSAGE_REQUEST_STALE')
    if(q.permittedActors?.length&&!q.permittedActors.includes(a.actorId))fail('MESSAGE_ACTOR_FORBIDDEN')
    if(q.status!=='pending')return {result:{request:q,run:r}}
    q.status='resolved';q.answer=a.answer;q.eventId=str(a.eventId);q.resolvedAt=now;put(db,r.runId,'request',q)
    for(const n of rows(db,r.runId,'node')) if(n.unitId===q.unitId&&n.nodeId===q.nodeId&&n.revision===r.revision) {n.status='superseded';put(db,r.runId,'node',n)}
    r.status='pending';r.deadline=new Date(Date.parse(now)+30000).toISOString();save(db,r);return {result:{request:q,run:r}}
  }
  if(kind==='message.barrier.resolve') {
    const b=get(db,'barrier',a.barrierId);if(b.ownerRunId!==r.runId)fail('MESSAGE_BARRIER_OWNER');b.status='resolved';b.resolution=a.resolution;put(db,r.runId,'barrier',b);return {result:{barrier:b}}
  }
  fail('MESSAGE_UNKNOWN_COMMAND')
}
export function queryMessages(db,a) {
  if(a.kind==='message.web-task'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('web-task:'+str(a.eventId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.web-tasks.pending')return db.prepare("SELECT body FROM message_items WHERE kind='web-task' AND json_extract(body,'$.status')='pending' ORDER BY rowid LIMIT 100").all().map(row=>JSON.parse(row.body))
  const topic=queryMessageTopics(db,a)
  if(topic!==undefined)return topic
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
    return db.prepare("SELECT rowid AS seq,body FROM message_items WHERE kind='notification' AND rowid>? AND json_extract(body,'$.status') IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?").all(after,json(states),limit).map(x=>({...JSON.parse(x.body),sequenceId:x.seq}))
  }
  if(a.kind==='message.group') {const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(str(a.conversationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.task-candidates') {const limit=a.limit??30;if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('MESSAGE_INVALID_LIMIT');return db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.kind') IN ('create','research','reopen') AND json_extract(r.body,'$.conversationId')=? ORDER BY i.rowid DESC LIMIT ?").all(str(a.conversationId),limit).map(x=>({run:JSON.parse(x.run),command:JSON.parse(x.command)}))}
  if(a.kind==='message.list') {
    const limit=a.limit??30,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT')
    const sql=a.conversationId?"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND json_extract(body, '$.conversationId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?":"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND rowid<? ORDER BY rowid DESC LIMIT ?"
    return db.prepare(sql).all(...(a.conversationId?[a.conversationId,before,limit]:[before,limit])).map(x=>({...JSON.parse(x.body),sequenceId:x.seq}))
  }
  if(a.kind==='message.task') {const row=db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? AND json_extract(i.body,'$.kind') IN ('create','research','reopen') ORDER BY i.rowid LIMIT 1").get(str(a.taskId));return row?{run:JSON.parse(row.run),command:JSON.parse(row.command)}:null}
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
