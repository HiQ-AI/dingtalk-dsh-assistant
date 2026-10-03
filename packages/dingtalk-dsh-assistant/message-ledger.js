import { createHash, randomUUID } from 'node:crypto'
import { executionDigest } from './execution-artifacts.js'
import { taskNotificationAllowed } from './workflow-notifications.js'
import { sameDwsFileProjection } from './coordination-resources.js'
import { maintenanceStatus } from './execution-maintenance.js'
import { installMessageTopics, validateMessageTopics, reduceMessageTopic, queryMessageTopics, bindQuietTopic, invalidateMessageSourceTopics, unbindMessageUnit, wholeTopicFactRevision } from './message-topics.js'

// Host 查询与阶段来源校验共用当前真实来源；Web 人工修订只在持久接纳后授予该 Task。
export function readCurrentTaskSource(db, sourceKey, { taskId } = {}) {
  if (sourceKey?.startsWith('web-context:')) {
    const eventId = sourceKey.slice('web-context:'.length)
    const row = db.prepare("SELECT payload FROM execution_events WHERE kind IN ('task.web-input.prepare','task.web-input.finish') AND json_extract(payload,'$.event.id')=? ORDER BY seq DESC LIMIT 1").get(eventId)
    const event = row ? JSON.parse(row.payload).event : queryMessages(db, { kind: 'message.web-task', eventId })
    if (!event || event.status !== 'accepted' || event.request.action !== 'context' || !event.request.requirement
      || taskId && event.request.taskId !== taskId
      || event.input?.authorization?.channel !== 'web' || event.input.authorization.sourceKey !== sourceKey
      || event.input.authorization.sourceVersion !== 1 || event.input.authorization.actorId !== event.actorId
      || !event.input.scope?.sourceKeys?.includes(sourceKey) || event.input.scope.sourceVersions?.[sourceKey] !== 1) return null
    return { sourceKey, sourceVersion: 1, actorId: event.actorId, channel: 'web',
      body: event.request.context, conversationId: event.input.scope.conversationId, status: 'active' }
  }
  const row = db.prepare("SELECT payload FROM execution_events WHERE kind='task.web-rerun.accept' AND json_extract(payload,'$.source.sourceKey')=? ORDER BY seq LIMIT 1").get(sourceKey)
  if (row) {
    const accepted = JSON.parse(row.payload), source = accepted.source
    if (taskId && accepted.taskId !== taskId || source.sourceVersion !== 1 || source.channel !== 'web') return null
    return source
  }
  return queryMessages(db, { kind: 'message.source', sourceKey })
}

// 阶段结束不代表业务结束；仅取消控制或当前需求/水位已应用的 Owner 完成决定封闭上下文修订。
export function isBusinessTaskTerminal(db, taskId) {
  const task = db.prepare('SELECT t.*,c.state AS control_state,c.control_revision FROM business_tasks t JOIN task_controls c USING(task_id) WHERE task_id=?').get(taskId)
  if (!task) return false
  if (['cancelling', 'cancelled'].includes(task.control_state)) return true
  if (!db.prepare('SELECT 1 FROM task_owners WHERE task_id=?').get(taskId)) return task.status === 'succeeded'
  return !!db.prepare(`SELECT 1 FROM task_owners o JOIN task_owner_turns r ON r.turn_id=(
      SELECT turn_id FROM task_owner_turns WHERE task_id=o.task_id AND status='accepted' ORDER BY rowid DESC LIMIT 1)
    WHERE o.task_id=? AND o.status='idle' AND o.current_turn_id IS NULL
      AND o.event_watermark=o.processed_watermark AND r.event_watermark=o.processed_watermark
      AND r.application_status='applied' AND json_extract(r.decision_json,'$.action')='complete'
      AND r.requirement_revision=? AND r.plan_revision=? AND r.control_revision=?`).get(
    taskId, task.requirement_revision, task.plan_revision, task.control_revision)
    && (task.plan_revision === 0 || task.plan_requirement_revision === task.requirement_revision)
}

// 排队和维护不算执行时间；旧账以真实模型领取时间推导，不能重置已用预算。
export function messageExecutionStartedAt(run, nodes) {
  const times = [run.executionStartedAt, ...nodes.filter(node => node.input?.deterministic !== true).map(node => node.startedAt)]
    .map(value => Date.parse(value)).filter(Number.isFinite)
  return times.length ? new Date(Math.min(...times)).toISOString() : null
}

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
// 影响记录沿用消息账。未判定输入不是无关输入；只由可回查的引用或关联证明缩小范围。
function impactCatalog(db, r) {
  const candidateTopics=db.prepare('SELECT topic_id,body FROM message_topics WHERE conversation_id=? ORDER BY topic_id').all(r.conversationId).map(row=>{
    const topic=JSON.parse(row.body)
    const sourceRefs=db.prepare(`SELECT DISTINCT b.source_key AS sourceKey,b.source_version AS sourceVersion,r.body FROM message_topic_bindings b
      JOIN message_runs r ON r.run_id=b.run_id WHERE b.topic_id=? ORDER BY b.source_key,b.source_version`).all(row.topic_id)
      .map(ref=>({sourceKey:ref.sourceKey,sourceVersion:ref.sourceVersion,text:JSON.parse(ref.body).body}))
    return {topicId:row.topic_id,inputRevision:topic.inputRevision??0,contextRevision:topic.contextRevision??0,sourceRefs}
  })
  return {candidateTopics,catalogRevision:digest(candidateTopics)}
}
export function registerMessageImpact(db,r,now) {
  if(rows(db,r.runId,'impact').length)return
  const refs=new Set([...(r.context?.quoteRefs??[]).map(ref=>ref.sourceKey).filter(Boolean),...(r.barriers??[]).map(b=>b.targetSourceKey).filter(Boolean)])
  const directTaskIds=[...new Set((r.barriers??[]).map(b=>b.targetTaskId).filter(Boolean))]
  const directTopicIds=new Set()
  for(const key of refs)for(const b of db.prepare('SELECT DISTINCT topic_id FROM message_topic_bindings WHERE source_key=?').all(key))directTopicIds.add(b.topic_id)
  for(const taskId of directTaskIds)for(const b of db.prepare(`SELECT DISTINCT b.topic_id FROM message_items i JOIN message_topic_bindings b ON b.unit_id=json_extract(i.body,'$.unitId')
    WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=?`).all(taskId))directTopicIds.add(b.topic_id)
  const catalog=impactCatalog(db,r)
  put(db,r.runId,'impact',{id:r.runId,runId:r.runId,sourceVersion:r.sourceVersion,revision:0,status:'unknown',
    directSourceKeys:[...refs],directTaskIds,directTopicIds:[...directTopicIds],candidateTopicIds:catalog.candidateTopics.map(t=>t.topicId),
    catalogRevision:catalog.catalogRevision,assessments:[],createdAt:now})
}
export function registerMessageAcceptance(db,taskId,requirementRevision,now){
  const origin=queryMessages(db,{kind:'message.task',taskId})
  if(!origin)return
  const id=`accepted:${taskId}:${requirementRevision}`
  if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('acceptance:'+id))return
  put(db,origin.run.runId,'acceptance',{id,runId:origin.run.runId,commandId:origin.command.id,taskId,requirementRevision,
    sourceVersion:origin.run.sourceVersion,status:'pending',createdAt:now})
}
function registerRelatedTaskInput(db,r,u,now){
  const targets=db.prepare(`SELECT DISTINCT o.task_id,t.requirement_ref FROM message_topic_bindings b JOIN message_items i ON i.run_id=b.run_id
    AND i.kind='command' AND json_extract(i.body,'$.unitId')=b.unit_id
    JOIN task_owners o ON o.task_id=json_extract(i.body,'$.args.taskId') JOIN business_tasks t ON t.task_id=o.task_id
    WHERE b.topic_id=?`).all(u.topicId)
  for(const target of targets){
    const key='scope-'+digest([r.runId,r.sourceVersion,u.id,target.task_id])
    if(db.prepare('SELECT 1 FROM task_events WHERE event_key=?').get(key))continue
    const event=db.prepare("INSERT INTO task_events(task_id,event_key,event_type,payload_ref,created_at) VALUES(?,?,'source.related',?,?)")
      .run(target.task_id,key,target.requirement_ref,now)
    db.prepare(`UPDATE task_owners SET event_watermark=?,input_fence_revision=input_fence_revision+1,revision=revision+1,
      status=CASE WHEN status IN ('idle','blocked') THEN 'pending' ELSE status END,updated_at=? WHERE task_id=?`)
      .run(Number(event.lastInsertRowid),now,target.task_id)
  }
}
function pendingAffectsTopic(db,r,topicId) {
  const impact=rows(db,r.runId,'impact')[0]
  if(!impact)return true // 旧账必须显式迁移，不把缺记录解释为独立。
  if(impact.coordinatorManaged)return impact.boundTopicIds.includes(topicId)
  const units=rows(db,r.runId,'unit').filter(u=>u.status!=='superseded')
  const unresolved=units.filter(u=>!u.topicId||u.blockedReason)
  const targets=unresolved.length?unresolved.map(u=>u.id):['$']
  const topic=queryMessageTopics(db,{kind:'message.topic',topicId})
  if(!topic)return true
  return targets.some(unitId=>{
    const unit=units.find(unit=>unit.id===unitId)
    if(unit?.topicId&&unit.blockedReason)return unit.topicId===topicId
    const proof=impact.assessments.find(p=>p.unitId===unitId&&p.topicId===topicId)
    if(proof&&proof.targetInputRevision===topic.inputRevision&&proof.targetContextRevision===topic.contextRevision
      &&proof.sourceRefs.every(ref=>db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(ref.sourceKey)?.current_version===ref.sourceVersion))return proof.relation!=='independent'
    // 引用只证明至少相关，不能证明只相关（同条消息还可能取消/修改其他事项）。
    // 即使已记录 directTopicIds，未覆盖的目标也须保留未知，等待逐 Unit 的完整来源证明。
    return true
  })
}
// 文件效果仅提供只读投影；发送权和原文件验收仍由 Delivery 持有。
function verifiedFileOutbound(db, conversationId, messageId) {
  const effects=db.prepare(`SELECT effect_id,run_id,node_run_id,generation,state,definition_json,result_json FROM execution_effects
    WHERE state IN ('succeeded','unknown') AND json_extract(definition_json,'$.action')='message'
    AND json_extract(definition_json,'$.adapterId')='task-group-file' AND json_extract(definition_json,'$.adapterVersion')='1'
    AND json_extract(definition_json,'$.payload.groupId')=?
    ${messageId===undefined?'':"AND (json_extract(result_json,'$.result.result.messageId')=? OR json_extract(result_json,'$.result.result.sendMessageRef.messageId')=?)"}
    ORDER BY rowid`).all(...(messageId===undefined?[conversationId]:[conversationId,messageId,messageId]))
  return effects.flatMap(effect=>{
    const prepared=JSON.parse(effect.definition_json).payload,receipt=JSON.parse(effect.result_json)?.result?.result
    if(!receipt||prepared.runId!==effect.run_id||prepared.nodeRunId!==effect.node_run_id||prepared.generation!==effect.generation
      ||typeof prepared.taskId!=='string'||!prepared.taskId||!/^[a-f0-9]{64}$/.test(prepared.deliveryKey??'')
      ||prepared.resourceKey!==`message:${prepared.deliveryKey}`)return []
    let evidence,status
    if(effect.state==='unknown') {
      const ref=receipt.sendMessageRef,ackId=receipt.ack?.sendReceipt?.openTaskId??receipt.ack?.result?.result?.openTaskId
      if(!ref||ref.conversationId!==conversationId||typeof ref.messageId!=='string'||!ref.messageId
        ||typeof ackId!=='string'||!ackId||ref.openTaskId!==ackId)return []
      evidence={conversationId,messageId:ref.messageId,openTaskId:ackId};status='pending'
    } else {
      if(typeof receipt.messageId!=='string'||!receipt.messageId||receipt.groupId!==conversationId||receipt.conversationId!==conversationId
        ||receipt.deliveryKey!==prepared.deliveryKey||receipt.taskId!==prepared.taskId
        ||!/^[a-f0-9]{64}$/.test(receipt.sha256??'')||!Number.isSafeInteger(receipt.size)||receipt.size<1)return []
      evidence={...receipt,conversationId};status='delivered'
    }
    const origin=queryMessages(db,{kind:'message.task',taskId:prepared.taskId})
    const source=origin?.run?.conversationId===conversationId?origin.run:null
    return [{id:effect.effect_id,effectId:effect.effect_id,taskId:prepared.taskId,runId:source?.runId??null,executionRunId:effect.run_id,
      kind:'task-file',status,payload:{conversationId,sourceMessageId:source?.context?.sourceMessageId??null},
      evidence,deliveredAt:status==='delivered'?receipt.verifiedAt??null:null}]
  })
}
function notificationFactDigest(db,n){
  const replacements=db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.restoresNotificationId')=? ORDER BY rowid").all(n.id).map(row=>JSON.parse(row.body).messageId)
  const command=n.commandId?get(db,'command',n.commandId):null,request=n.requestId?get(db,'request',n.requestId):null
  return digest({id:n.id,eventKey:n.eventKey??null,status:n.status,payload:n.payload,evidenceMessageId:n.evidence?.messageId??null,recallStatus:n.recallStatus??null,replacements,
    command:command?{status:command.status,kind:command.kind,args:command.args,result:command.result}:null,
    request:request?{status:request.status,kind:request.kind,revision:request.revision}:null})
}
function notificationTaskDeleted(db, taskId) {
  return !!taskId && !!db.prepare("SELECT 1 FROM execution_events WHERE kind='task.delete' AND json_extract(payload,'$.taskId')=? LIMIT 1").get(taskId)
}
function notificationStateCurrent(source,fact){
  if(fact.revision!==source.revision||fact.status!==source.status||(fact.reason??null)!==(source.reason??null)
    ||(fact.intentStatus??null)!==(source.intentStatus??null))return false
  if(fact.phase==='reply_obligation')return source.status==='settled'&&(source.snapshot?.replyObligation??source.context?.replyObligation)?.required===true
  if(fact.phase==='attention')return source.status==='needs_attention'
  return fact.phase==='routing_wait'&&source.intentStatus==='waiting_routing_barrier'
}
const unitMeaning=u=>Object.fromEntries(Object.entries(u).filter(([k])=>!['id','runId','revision','status','corrections','preservedUnitId','topicId'].includes(k)))

const unfinishedEchoNode = node => node.status === 'running' || node.status === 'waiting'
  || node.status === 'failed' && node.error === 'process_interrupted'
function echoReconciliation(db, r, sealed = true) {
  const rejected = reason => ({ eligible: false, reason, runId: r.runId })
  if (sealed && (r.status !== 'superseded' || r.reason !== 'outbound_echo')) return rejected('MESSAGE_ECHO_NOT_QUARANTINED')
  const sourceMessageId = r.context?.sourceMessageId
  if (!sourceMessageId) return rejected('MESSAGE_ECHO_PROOF_REQUIRED')
  const outbound = db.prepare(`SELECT i.body,source.body AS source FROM message_items i JOIN message_runs source ON source.run_id=i.run_id
    WHERE i.kind='notification' AND json_extract(source.body,'$.conversationId')=?
    AND json_extract(i.body,'$.status')='delivered' AND json_extract(i.body,'$.evidence.messageId')=?`)
    .all(r.conversationId, sourceMessageId).map(row => ({ notification: JSON.parse(row.body), source: JSON.parse(row.source) }))
    .filter(item => item.notification.payload?.conversationId === r.conversationId && item.notification.evidence?.conversationId === r.conversationId)
  if (outbound.length !== 1) return rejected('MESSAGE_ECHO_PROOF_REQUIRED')
  const { notification, source } = outbound[0], barriers = rows(db,r.runId,'barrier').filter(item => item.status === 'pending')
  if (barriers.some(barrier => barrier.ownerRunId !== r.runId || barrier.previousOwnerRunId || barrier.targetTaskId
    || barrier.targetSourceKey !== source.sourceKey || barrier.id !== `fence-${digest([r.sourceKey,r.sourceVersion,barrier.targetSourceKey])}`
    || !r.barriers?.some(original => original.barrierId === barrier.id && original.targetSourceKey === barrier.targetSourceKey && !original.targetTaskId)
    || !r.context?.quoteRefs?.some(ref => ref.sourceKey === barrier.targetSourceKey && ref.messageId === notification.payload.sourceMessageId))) return rejected('MESSAGE_ECHO_BARRIER_MISMATCH')
  if (['command','notification','notification-operation','notification-replacement'].some(kind => rows(db,r.runId,kind).length)
    || db.prepare('SELECT 1 FROM execution_effects WHERE run_id=? LIMIT 1').get(r.runId)
    || db.prepare('SELECT 1 FROM execution_runs WHERE run_id=? LIMIT 1').get(r.runId)) return rejected('MESSAGE_ECHO_EFFECT_PRESENT')
  const nodes = rows(db,r.runId,'node').filter(unfinishedEchoNode)
  return { eligible: true, runId: r.runId, expectedDigest: digest({ run: r, nodes, barriers, notification, source }),
    notificationId: notification.id, sourceMessageId, nodeRunIds: nodes.map(node => node.nodeRunId), barrierIds: barriers.map(barrier => barrier.id),
    runningNodeRunIds: nodes.filter(node => node.status === 'running').map(node => node.nodeRunId), alreadyReconciled: nodes.length === 0 && barriers.length === 0 }
}
function finishEchoNodes(db, r, now) {
  const nodeRunIds = []
  for (const node of rows(db,r.runId,'node').filter(unfinishedEchoNode)) {
    node.priorStatus = node.status; node.status = 'superseded'; node.reason = 'outbound_echo'; node.completedAt = now; node.retryAt = null
    put(db,r.runId,'node',node); nodeRunIds.push(node.nodeRunId)
  }
  return nodeRunIds
}
function finishEchoBarriers(db, r, now) {
  const barrierIds = []
  for (const barrier of rows(db,r.runId,'barrier').filter(item => item.status === 'pending')) {
    barrier.status = 'resolved'; barrier.resolution = 'outbound_echo'; barrier.resolvedAt = now
    put(db,r.runId,'barrier',barrier); barrierIds.push(barrier.id)
  }
  return barrierIds
}

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
  for(const execution of rows(db,r.runId,'agent-execution')) {
    if(unitIds && !unitIds.includes(execution.unitId))continue
    if(['cancelled','superseded'].includes(execution.status))continue
    execution.priorStatus=execution.status;execution.status='superseded';execution.error='input_superseded'
    put(db,r.runId,'agent-execution',execution)
  }
  for(const kind of ['node','command']) for(const i of rows(db,r.runId,kind)) {
    if(unitIds && !unitIds.includes(i.unitId)) continue
    if((kind==='node'&&i.status!=='superseded')||['ready','running','pending','waiting','failed'].includes(i.status)) { i.priorStatus=i.status;i.status=kind==='command' && i.status==='running'?'unknown':'superseded'; put(db,r.runId,kind,i) }
  }
}
function agentEffectsPresent(db,r,command) {
  const retained=new Set((command.readonlyRetryHistory??[]).flatMap(item=>item.notificationIds??[]))
  return rows(db,r.runId,'notification').some(item=>item.commandId===command.id&&!(retained.has(item.id)&&['delivered','superseded'].includes(item.status)))
    || rows(db,r.runId,'notification-operation').some(item=>item.commandId===command.id)
    || db.prepare('SELECT 1 FROM execution_effects WHERE run_id=? LIMIT 1').get(r.runId)
    || db.prepare('SELECT 1 FROM execution_runs WHERE run_id=? LIMIT 1').get(r.runId)
}
function agentCommandSettled(db,r,c) {
  put(db,r.runId,'command',c)
  const unit=get(db,'unit',c.unitId)
  if(rows(db,r.runId,'command').filter(item=>item.unitId===unit.id).every(item=>['applied','cancelled','rejected'].includes(item.status))){unit.status='applied';put(db,r.runId,'unit',unit)}
  settle(db,r)
}
function agentIdentity(execution,a) {
  if(execution.leaseEpoch!==a.leaseEpoch || execution.commandLeaseEpoch!==a.commandLeaseEpoch
    || execution.inputVersion!==a.inputVersion || execution.inputDigest!==a.inputDigest || execution.sessionId!==a.sessionId)fail('MESSAGE_AGENT_STALE')
}
function agentInput(a) {
  if(!Number.isSafeInteger(a.inputVersion)||a.inputVersion<1||!/^[a-f0-9]{64}$/.test(a.inputDigest??''))fail('MESSAGE_AGENT_INPUT_INVALID')
  str(a.inputRef);str(a.sessionId)
}
function rememberAgentBinding(execution) {
  const binding={inputVersion:execution.inputVersion,inputDigest:execution.inputDigest,sessionId:execution.sessionId,leaseEpoch:execution.leaseEpoch}
  execution.bindingHistory??=[]
  if(!execution.bindingHistory.some(item=>json(item)===json(binding)))execution.bindingHistory.push(binding)
}
export function recoverMessages(db) {
  for(const row of db.prepare('SELECT conversation_id,body FROM message_groups').all()){
    const group=JSON.parse(row.body),c=group.coordinator
    if(c&&['running','committed'].includes(c.status)){
      c.status='idle';c.error='process_interrupted';c.leaseEpoch++
      db.prepare('UPDATE message_groups SET body=? WHERE conversation_id=?').run(json(group),row.conversation_id)
    }
  }
  for(const row of db.prepare('SELECT body FROM message_runs').all()) {
    const r=JSON.parse(row.body)
    for(const n of rows(db,r.runId,'node')) if(n.status==='running') { n.status='failed'; n.error='process_interrupted'; n.retryAt=new Date().toISOString(); put(db,r.runId,'node',n) }
    for(const n of rows(db,r.runId,'notification'))if(n.status==='sending'){n.status='unknown';put(db,r.runId,'notification',n)}
    for(const operation of rows(db,r.runId,'notification-operation'))if(operation.status==='in_flight'){operation.status='unknown';operation.error='process_interrupted';put(db,r.runId,'notification-operation',operation)}
    for(const c of rows(db,r.runId,'command')) if(c.status==='running') { c.status='unknown'; put(db,r.runId,'command',c) }
    for(const execution of rows(db,r.runId,'agent-execution')) {
      const command=get(db,'command',execution.commandId)
      if(execution.drained===false){execution.drained=true;execution.interruptedAt=new Date().toISOString();execution.error='process_interrupted'
        if(execution.status==='cancelling'){execution.status='cancelled';command.status='cancelled';agentCommandSettled(db,r,command)}
        else if(execution.status==='running')execution.status='interrupted'
        put(db,r.runId,'agent-execution',execution)
      }
      const source=db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(r.sourceKey)
      if(command.status==='unknown' && r.status!=='superseded' && source?.current_version===(r.validSourceVersion??r.sourceVersion)
        && command.revision===r.revision && execution.runRevision===r.revision && command.kind==='answer' && !command.args?.taskId
        && execution.mode==='read-only' && /^[a-f0-9]{64}$/.test(execution.toolPolicyDigest??'')
        && ['interrupted','succeeded','failed'].includes(execution.status) && !agentEffectsPresent(db,r,command)) {
        command.status='pending';command.error=null;put(db,r.runId,'command',command)
      }
    }
  }
}
export function inspectMessageBatchCleanup(db,a) {
  for(const key of ['runIds','sourceKeys','taskIds','topicIds'])if(!Array.isArray(a[key])||new Set(a[key]).size!==a[key].length||a[key].some(v=>typeof v!=='string'||!v))fail('MESSAGE_CLEANUP_MANIFEST_INVALID')
  if(!a.runIds.length||!a.sourceKeys.length)fail('MESSAGE_CLEANUP_MANIFEST_INVALID')
  const state=maintenanceStatus(db)
  if(!state.active||state.phase!=='stopping'||!state.drained||state.maintenanceId!==a.maintenanceId||state.revision!==a.maintenanceRevision)fail('MESSAGE_CLEANUP_MAINTENANCE_REQUIRED')
  const all=db.prepare('SELECT body FROM message_runs ORDER BY run_id').all().map(row=>JSON.parse(row.body))
  const selected=all.filter(r=>a.sourceKeys.includes(r.sourceKey))
  if(json(selected.map(r=>r.runId).sort())!==json([...a.runIds].sort())||new Set(selected.map(r=>r.sourceKey)).size!==a.sourceKeys.length)fail('MESSAGE_CLEANUP_SOURCE_CLOSURE')
  const items=db.prepare('SELECT item_id,run_id,kind,body FROM message_items ORDER BY item_id').all()
  const chosen=items.filter(i=>a.runIds.includes(i.run_id))
  const relatedTasks=new Set(chosen.filter(i=>i.kind==='command').flatMap(i=>{const c=JSON.parse(i.body);return[c.args?.taskId,c.result?.taskId].filter(Boolean)}))
  if([...relatedTasks].some(id=>!a.taskIds.includes(id)))fail('MESSAGE_CLEANUP_TASK_CLOSURE')
  const commands=chosen.filter(i=>i.kind==='command').map(i=>JSON.parse(i.body))
  if(commands.some(c=>['running','unknown'].includes(c.status)))fail('MESSAGE_CLEANUP_COMMAND_PENDING')
  const plannedTaskIds=[],actualTaskIds=[]
  for(const taskId of a.taskIds){
    if(!relatedTasks.has(taskId))fail('MESSAGE_CLEANUP_TASK_CLOSURE')
    const live=db.prepare('SELECT 1 FROM business_tasks WHERE task_id=? UNION ALL SELECT 1 FROM execution_runs WHERE task_id=? UNION ALL SELECT 1 FROM task_owners WHERE task_id=?').get(taskId,taskId,taskId)
    const deleted=notificationTaskDeleted(db,taskId)
    // Task 后端及原生命令回执是创建事实；消息命令预分配的 args.taskId 不是 Task。
    const accepted=db.prepare("SELECT 1 FROM execution_events WHERE kind IN ('task.accept','task.plan.accept','task.plan.create','task.web-rerun.accept','task.owner.init','run.create') AND (json_extract(payload,'$.taskId')=? OR json_extract(payload,'$.task.taskId')=?) LIMIT 1").get(taskId,taskId)
      || db.prepare("SELECT 1 FROM execution_receipts WHERE json_extract(result,'$.taskId')=? OR json_extract(result,'$.task.taskId')=? LIMIT 1").get(taskId,taskId)
    if(live||accepted||deleted){
      actualTaskIds.push(taskId)
      if(live||!deleted)fail('MESSAGE_CLEANUP_TASK_DELETE_REQUIRED')
    }else{
      const references=commands.filter(c=>c.args?.taskId===taskId||c.result?.taskId===taskId)
      if(references.some(c=>!['create','research'].includes(c.kind)||!['pending','superseded'].includes(c.status)||c.result?.taskId))fail('MESSAGE_CLEANUP_TASK_DELETE_REQUIRED')
      plannedTaskIds.push(taskId)
    }
  }
  for(const item of items.filter(i=>!a.runIds.includes(i.run_id))){
    const value=JSON.parse(item.body)
    if(value.kind&&item.kind==='command'&&a.taskIds.includes(value.args?.taskId)||item.kind==='barrier'&&value.status==='pending'&&(a.sourceKeys.includes(value.targetSourceKey)||a.taskIds.includes(value.targetTaskId)))fail('MESSAGE_CLEANUP_EXTERNAL_DEPENDENCY')
  }
  const bindings=db.prepare('SELECT * FROM message_topic_bindings ORDER BY unit_id').all().filter(b=>a.runIds.includes(b.run_id))
  const topicIds=[...new Set(bindings.map(b=>b.topic_id))].sort()
  if(json(topicIds)!==json([...a.topicIds].sort()))fail('MESSAGE_CLEANUP_TOPIC_CLOSURE')
  const facts=db.prepare('SELECT * FROM message_topic_facts ORDER BY topic_id,fact_id').all().filter(f=>a.topicIds.includes(f.topic_id))
  if(facts.some(row=>{const refs=JSON.parse(row.body).sourceRefs??[];return refs.some(ref=>a.sourceKeys.includes(ref.sourceKey))&&refs.some(ref=>!a.sourceKeys.includes(ref.sourceKey))}))fail('MESSAGE_CLEANUP_EXTERNAL_DEPENDENCY')
  const notices=chosen.filter(i=>i.kind==='notification').map(i=>JSON.parse(i.body))
  if(notices.some(n=>!['prepared','superseded','failed','delivered'].includes(n.status)))fail('MESSAGE_CLEANUP_NOTIFICATION_PENDING')
  const conversationIds=[...new Set(selected.map(r=>r.conversationId))].sort()
  const groups=conversationIds.map(id=>db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(id)?.body??null)
  if(groups.some(body=>body&&JSON.parse(body).coordinator&&JSON.parse(body).coordinator.status!=='idle'))fail('MESSAGE_CLEANUP_COORDINATOR_ACTIVE')
  return {runIds:a.runIds,sourceKeys:a.sourceKeys,taskIds:a.taskIds,plannedTaskIds,actualTaskIds,topicIds:a.topicIds,conversationIds,
    expectedDigest:digest({selected,chosen,bindings,facts,groups}),notificationAuditDigest:digest(notices.filter(n=>n.status==='delivered')),sentNotifications:notices.filter(n=>n.status==='delivered'),
    counts:{runs:selected.length,items:chosen.length,bindings:bindings.length},retained:['dws-history','execution-receipts','execution-events','artifact-files','native-sessions']}
}
function reviseTopicFacts(db,r,topicId,changes,appliedFactRevisions,now){
      for(const change of changes??[]){
        const revisionIdentity=json([r.actorId,change.sourceQuote,change.scope])
        if(appliedFactRevisions.has(change.factId)){
          if(appliedFactRevisions.get(change.factId)!==revisionIdentity||!r.body.includes(change.sourceQuote))fail('MESSAGE_TOPIC_FACT_REVISION_CONFLICT')
          continue
        }
        const row=db.prepare("SELECT body FROM message_topic_facts WHERE topic_id=? AND fact_id=? AND status='active'").get(topicId,str(change.factId))
        if(!row)fail('MESSAGE_TOPIC_FACT_REVISION_INVALID')
        const fact=JSON.parse(row.body)
        if(fact.actorId!==r.actorId||!r.body.includes(str(change.sourceQuote))||!/改为|修改|不再|取消|撤销|替换|现在允许/u.test(change.sourceQuote)||!wholeTopicFactRevision(r.body,change))fail('MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN')
        str(change.scope)
        for(const prior of db.prepare("SELECT fact_id,body FROM message_topic_facts WHERE topic_id=? AND status='active'").all(topicId)){
          const equivalent=JSON.parse(prior.body)
          if(equivalent.actorId!==fact.actorId||equivalent.kind!==fact.kind||equivalent.text!==fact.text)continue
          db.prepare("UPDATE message_topic_facts SET status='superseded',body=? WHERE topic_id=? AND fact_id=?").run(json({...equivalent,status:'superseded',supersededBy:{sourceKey:r.sourceKey,sourceVersion:r.sourceVersion,sourceQuote:change.sourceQuote,scope:change.scope},supersededAt:now}),topicId,prior.fact_id)
        }
        const revised=JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(topicId).body)
        revised.contextRevision=(revised.contextRevision??0)+1
        db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(revised),topicId)
        appliedFactRevisions.set(change.factId,revisionIdentity)
      }
}
function coordinatorState(db, conversationId) {
  str(conversationId)
  const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(conversationId)
  const group=row?JSON.parse(row.body):{conversationId,epoch:0,state:'active',engine:'workflow'}
  const coordinator=group.coordinator??{sessionId:null,sessionBound:false,leaseEpoch:0,turnId:null,status:'idle',consumedSequence:0}
  const sources=db.prepare(`SELECT r.rowid AS sequenceId,r.body FROM message_runs r JOIN message_sources s
    ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
    WHERE json_extract(r.body,'$.conversationId')=? AND json_extract(r.body,'$.status') NOT IN ('settled','superseded','alias','buffered')
    AND (json_extract(r.body,'$.coordinatorConsumed') IS NULL OR EXISTS(SELECT 1 FROM message_items i
      WHERE i.run_id=r.run_id AND i.kind='command' AND json_extract(i.body,'$.status')='superseded'
      AND json_extract(i.body,'$.priorStatus')='pending' AND json_extract(i.body,'$.reason')='topic_input_changed'))
    AND NOT EXISTS(SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='command'
      AND json_extract(i.body,'$.status')!='superseded') ORDER BY r.rowid`)
    .all(conversationId).map(row=>({...JSON.parse(row.body),sequenceId:row.sequenceId}))
  const unconsumedTaskEvents=[]
  for(const task of db.prepare('SELECT task_id FROM business_tasks ORDER BY task_id').all()){
    const origin=queryMessages(db,{kind:'message.task',taskId:task.task_id})
    if(origin?.run.conversationId!==conversationId||notificationTaskDeleted(db,task.task_id))continue
    for(const event of db.prepare('SELECT seq,event_type,payload_ref,created_at FROM task_events WHERE task_id=? AND seq>? ORDER BY seq').all(task.task_id,coordinator.taskEventWatermarks?.[task.task_id]??0))
      unconsumedTaskEvents.push({taskId:task.task_id,eventSeq:event.seq,eventType:event.event_type,payloadRef:event.payload_ref,createdAt:event.created_at})
  }
  unconsumedTaskEvents.sort((a,b)=>a.eventSeq-b.eventSeq)
  return {group,coordinator,sources,unconsumedTaskEvents}
}
function reduceCoordinator(db,kind,a,ctx) {
  const {group,coordinator:c,sources,unconsumedTaskEvents}=coordinatorState(db,a.conversationId),now=ctx.now
  const binding=()=>({conversationId:a.conversationId,...c})
  const saveGroup=()=>{group.coordinator=c;db.prepare('INSERT INTO message_groups VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body').run(a.conversationId,json(group))}
  if(kind==='message.coordinator.relocate') {
    if(group.state!=='active'||group.engine!=='workflow'||c.status!=='idle'||c.leaseEpoch!==a.expectedLeaseEpoch
      ||c.sessionId!==a.previousSessionId||!c.sessionBound||str(a.sessionId)===c.sessionId)fail('MESSAGE_COORDINATOR_STALE')
    c.sessionHistory=[...(c.sessionHistory??[]),{sessionId:c.sessionId,leaseEpoch:c.leaseEpoch,replacedAt:now}]
    c.sessionId=a.sessionId;c.sessionBound=true;c.leaseEpoch++;c.turnId=null;c.recovery=null;c.error=null;c.retryAt=null
    saveGroup();return {result:{binding:binding()}}
  }
  if(kind==='message.coordinator.claim') {
    if(group.state!=='active'||group.engine!=='workflow')fail('MESSAGE_ENGINE_NOT_ACTIVE')
    if(c.status!=='idle'||c.leaseEpoch!==a.expectedLeaseEpoch)fail('MESSAGE_COORDINATOR_STALE')
    const refs=a.taskEventRefs??[]
    if(!Array.isArray(a.sourceRuns)||!Array.isArray(refs)||!a.sourceRuns.length&&!refs.length||new Set(a.sourceRuns.map(s=>s.runId)).size!==a.sourceRuns.length||new Set(refs.map(e=>`${e.taskId}:${e.eventSeq}`)).size!==refs.length)fail('MESSAGE_INVALID_ARGUMENT')
    const events=refs.map(ref=>{const event=unconsumedTaskEvents.find(e=>e.taskId===ref.taskId&&e.eventSeq===ref.eventSeq);if(!event)fail('MESSAGE_COORDINATOR_EVENT_STALE');return event})
    // 水位只能推进连续已读事件，不允许挑选末项吞掉此前未消费事实。
    for(const event of events)if(unconsumedTaskEvents.some(e=>e.taskId===event.taskId&&e.eventSeq<event.eventSeq&&!events.includes(e)))fail('MESSAGE_COORDINATOR_EVENT_GAP')
    const selected=a.sourceRuns.map(ref=>{const r=sources.find(r=>r.runId===ref.runId&&r.sourceVersion===ref.sourceVersion);if(!r)fail('MESSAGE_STALE');return r})
    c.sessionId??=a.sessionId??`coordinator-${digest(a.conversationId)}`
    if(a.sessionId&&a.sessionId!==c.sessionId)fail('MESSAGE_COORDINATOR_STALE')
    c.turnId=str(a.turnId);c.leaseEpoch++;c.status='running';c.sources=a.sourceRuns;c.taskEventRefs=refs;c.startedAt=now;c.error=null;c.retryAt=null
    saveGroup();return {result:{binding:binding(),sources:selected,taskEvents:events}}
  }
  if(c.turnId!==a.turnId||c.leaseEpoch!==a.leaseEpoch||!['running','committed'].includes(c.status))fail('MESSAGE_COORDINATOR_STALE')
  if(kind==='message.coordinator.bound') {
    if(a.sessionId!==c.sessionId)fail('MESSAGE_COORDINATOR_STALE')
    c.sessionBound=true
  } else if(kind==='message.coordinator.release') {
    if(a.drained!==true)fail('MESSAGE_COORDINATOR_NOT_DRAINED')
    c.status='idle';c.error=a.error??null;c.retryAt=a.retryAt??null;c.recovery=a.recovery??null;c.completedAt=now
  } else if(kind==='message.coordinator.commit') {
    if(c.status!=='running')fail('MESSAGE_COORDINATOR_STALE')
    if(!Array.isArray(a.decisions)||a.decisions.length!==c.sources.length||new Set(a.decisions.map(d=>d.runId)).size!==c.sources.length)fail('MESSAGE_INVALID_DISPOSITION')
    for(const ref of c.taskEventRefs??[])if(!unconsumedTaskEvents.some(e=>e.taskId===ref.taskId&&e.eventSeq===ref.eventSeq))fail('MESSAGE_COORDINATOR_EVENT_STALE')
    for(const v of a.taskFactVersions??[])if(taskFactVersion(db,v.taskId).hash!==v.hash)fail('MESSAGE_TASK_FACTS_STALE')
    for(const v of a.topicVersions??[]){const t=queryMessageTopics(db,{kind:'message.topic',topicId:v.topicId});if(!t||t.conversationId!==a.conversationId||t.inputRevision!==v.inputRevision||t.contextRevision!==v.contextRevision)fail('MESSAGE_TOPIC_STALE')}
    const existingTopics=new Set(db.prepare('SELECT topic_id FROM message_topics').all().map(row=>row.topic_id))
    const accepted=[],commands=[],appliedFactRevisions=new Map()
    for(const decision of a.decisions) {
      const source=c.sources.find(s=>s.runId===decision.runId&&s.sourceVersion===decision.sourceVersion)
      const r=sources.find(s=>s.runId===decision.runId&&s.sourceVersion===decision.sourceVersion)
      if(!source||!r||r.correction)fail('MESSAGE_STALE')
      current(db,r)
      if(!Array.isArray(decision.units))fail('MESSAGE_INVALID_UNITS')
      for(const type of ['unit','node','request'])for(const item of rows(db,r.runId,type)) {
        if(type==='request'&&item.status!=='pending')continue
        if(type==='unit')unbindMessageUnit(db,item.id,now)
        item.priorStatus=item.status;item.status='superseded';item.reason='conversation_coordinator';put(db,r.runId,type,item)
      }
      r.status='pending';r.reason=null;r.attentionScope=null;r.routingStatus='routing_complete';r.intentStatus='processed'
      r.coordinatorConsumed={turnId:c.turnId,leaseEpoch:c.leaseEpoch,at:now}
      for(const barrier of rows(db,r.runId,'barrier').filter(item=>item.status==='pending'&&item.reason==='source_edit'
        &&item.ownerRunId===r.runId&&item.targetSourceKey===r.sourceKey&&!item.targetTaskId)){
        barrier.status='resolved';barrier.resolution='coordinator_source_edit_consumed';barrier.resolvedAt=now
        put(db,r.runId,'barrier',barrier)
      }
      for(const value of decision.units) {
        const id=str(value.unitId)
        if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('unit:'+id))fail('MESSAGE_INVALID_UNITS')
        if(!Array.isArray(value.commands))fail('MESSAGE_INVALID_DISPOSITION')
        const u={...value,id,runId:r.runId,revision:r.revision,status:value.commands.length?'accepted':value.request?'pending':value.outcome??'ignored'}
        if(!['accepted','pending','ignored','rejected','applied'].includes(u.status))fail('MESSAGE_INVALID_DISPOSITION')
        put(db,r.runId,'unit',u)
        if(value.topic){
          if(existingTopics.has(value.topic.topicId)&&!(a.topicVersions??[]).some(v=>v.topicId===value.topic.topicId))fail('MESSAGE_TOPIC_STALE')
          reviseTopicFacts(db,r,value.topic.topicId,value.topic.factRevisions,appliedFactRevisions,now)
          reduceMessageTopic(db,{kind:'message.topic.upsert',args:{...value.topic,facts:value.topic.facts??[],conversationId:r.conversationId,sourceRunId:r.runId,unitId:id}},ctx);u.topicId=value.topic.topicId;put(db,r.runId,'unit',u);registerRelatedTaskInput(db,r,u,now)
        }
        for(const x of value.commands) {
          str(x.commandId);str(x.kind)
          if(x.args?.taskId&&db.prepare("SELECT 1 FROM execution_events WHERE kind='task.delete' AND json_extract(payload,'$.taskId')=? LIMIT 1").get(x.args.taskId))fail('TASK_DELETED')
          if(x.args?.taskId&&db.prepare('SELECT 1 FROM business_tasks WHERE task_id=?').get(x.args.taskId)&&!(a.taskFactVersions??[]).some(v=>v.taskId===x.args.taskId))fail('MESSAGE_TASK_FACTS_STALE')
          if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('command:'+x.commandId))fail('MESSAGE_COMMAND_CONFLICT')
          const command={...x,id:x.commandId,runId:r.runId,unitId:id,revision:r.revision,...(u.topicId?{topicId:u.topicId}:{}),status:'pending',leaseEpoch:0,createdAt:now}
          put(db,r.runId,'command',command);commands.push(command)
        }
        if(value.request){const request={...value.request,id:str(value.request.requestId),runId:r.runId,unitId:id,nodeId:'coordinator',revision:r.revision,status:'pending',createdAt:now};if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('request:'+request.id))fail('MESSAGE_REQUEST_EXISTS');put(db,r.runId,'request',request)}
      }
      const impact=rows(db,r.runId,'impact')[0]
      if(impact){impact.coordinatorManaged=true;impact.boundTopicIds=[...new Set(decision.units.map(u=>u.topic?.topicId).filter(Boolean))];impact.status='decided';put(db,r.runId,'impact',impact)}
      settle(db,r)
      if(!decision.units.length){r.status='settled';r.reason=decision.reason??'coordinator_no_action';save(db,r)}
      c.consumedSequence=Math.max(c.consumedSequence,r.sequenceId);accepted.push(r)
    }
    const topicIds=new Set(a.decisions.flatMap(d=>d.units.map(u=>u.topic?.topicId).filter(Boolean)))
    for(const topicId of topicIds){
      const topic=JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(topicId).body)
      topic.processedRevision=topic.inputRevision;topic.updatedAt=now
      db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(topic),topicId)
    }
    for(const command of commands)if(command.topicId){command.topicInputRevision=queryMessageTopics(db,{kind:'message.topic',topicId:command.topicId}).inputRevision;put(db,command.runId,'command',command)}
    c.taskEventWatermarks??={}
    for(const ref of c.taskEventRefs??[])c.taskEventWatermarks[ref.taskId]=Math.max(c.taskEventWatermarks[ref.taskId]??0,ref.eventSeq)
    c.status='committed';c.committedAt=now;saveGroup()
    return {result:{binding:binding(),status:'committed',runs:accepted,commands}}
  } else fail('MESSAGE_UNKNOWN_COMMAND')
  saveGroup();return {result:{binding:binding()}}
}
function ownerReleasedWait(db,taskId) {
  const fact=db.prepare(`SELECT o.task_id,o.status AS owner_status,o.current_turn_id,o.failure_count,
    b.requirement_revision,b.plan_revision,b.status AS task_status,c.control_revision,c.state AS control_state
    FROM task_owners o JOIN business_tasks b ON b.task_id=o.task_id JOIN task_controls c ON c.task_id=o.task_id WHERE o.task_id=?`).get(taskId)
  if(!fact||fact.owner_status!=='blocked'||fact.current_turn_id||!['pending','active'].includes(fact.task_status)||fact.control_state!=='active')return null
  const last=db.prepare('SELECT status,application_status FROM task_owner_turns WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId)
  if(last?.status!=='released'||last.application_status!==null)return null
  if(db.prepare("SELECT 1 FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND status IN ('pending','ready','running') LIMIT 1").get(taskId,fact.plan_revision))return null
  return fact
}
export function reduceMessageCommand(db,{kind,args:a},ctx) {
  if(kind==='message.batch.cleanup'){
    const checked=inspectMessageBatchCleanup(db,a)
    if(a.expectedDigest!==checked.expectedDigest||a.notificationAuditDigest!==digest(checked.sentNotifications))fail('MESSAGE_CLEANUP_AUDIT_STALE')
    for(const runId of a.runIds){db.prepare('DELETE FROM message_topic_bindings WHERE run_id=?').run(runId);db.prepare('DELETE FROM message_items WHERE run_id=?').run(runId);db.prepare('DELETE FROM message_runs WHERE run_id=?').run(runId)}
    for(const key of a.sourceKeys)db.prepare('DELETE FROM message_sources WHERE source_key=?').run(key)
    for(const topicId of a.topicIds){
      if(!db.prepare('SELECT 1 FROM message_topic_bindings WHERE topic_id=?').get(topicId)){
        db.prepare('DELETE FROM message_topic_facts WHERE topic_id=?').run(topicId);db.prepare('DELETE FROM message_topics WHERE topic_id=?').run(topicId)
      }else {for(const row of db.prepare('SELECT fact_id,body FROM message_topic_facts WHERE topic_id=?').all(topicId)){
        const fact=JSON.parse(row.body)
        if(fact.sourceRefs?.some(ref=>a.sourceKeys.includes(ref.sourceKey)))db.prepare('DELETE FROM message_topic_facts WHERE topic_id=? AND fact_id=?').run(topicId,row.fact_id)
      }
      const topic=JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(topicId).body)
      topic.contextRevision++;topic.inputRevision++;topic.updatedAt=ctx.now
      db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(topic),topicId)
      }
    }
    const coordinatorResets=[]
    for(const conversationId of checked.conversationIds){
      const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(conversationId)
      if(!row)continue
      const group=JSON.parse(row.body),prior=group.coordinator
      if(!prior)continue
      if(prior.status!=='idle')fail('MESSAGE_CLEANUP_COORDINATOR_ACTIVE')
      const sessionId=`coordinator-${randomUUID()}`
      group.coordinator={sessionId,sessionBound:false,leaseEpoch:(prior.leaseEpoch??0)+1,turnId:null,status:'idle',
        consumedSequence:0,sources:[],taskEventRefs:[],taskEventWatermarks:Object.fromEntries(Object.entries(prior.taskEventWatermarks??{}).filter(([taskId])=>!a.taskIds.includes(taskId)))}
      db.prepare('UPDATE message_groups SET body=? WHERE conversation_id=?').run(json(group),conversationId)
      coordinatorResets.push({conversationId,previousSessionId:prior.sessionId,sessionId,leaseEpoch:group.coordinator.leaseEpoch})
    }
    return {result:{...checked,coordinatorResets,deletedAt:ctx.now}}
  }
  if(kind.startsWith('message.coordinator.'))return reduceCoordinator(db,kind,a,ctx)
  if(kind.startsWith('message.agent.')) {
    const c=get(db,'command',a.commandId),r=run(db,c.runId),now=ctx.now
    const row=db.prepare("SELECT body FROM message_items WHERE item_id=?").get('agent-execution:'+c.id)
    let execution=row?JSON.parse(row.body):null
    if(kind==='message.agent.drained') {
      if(!execution||execution.leaseEpoch!==a.leaseEpoch||execution.sessionId!==a.sessionId)fail('MESSAGE_AGENT_STALE')
      execution.drained=true;execution.drainedAt=now
      if(execution.status==='cancelling'){execution.status='cancelled';c.status='cancelled';c.completedAt=now;agentCommandSettled(db,r,c)}
      else if(execution.status==='running'){execution.status='interrupted';execution.error='session_interrupted'}
      put(db,r.runId,'agent-execution',execution);return {result:{execution,command:c}}
    }
    current(db,r,c.revision)
    if(kind==='message.agent.begin') {
      agentInput(a)
      if(c.kind!=='answer'||c.args?.taskId||c.status!=='running'||c.leaseEpoch!==a.commandLeaseEpoch
        ||a.mode!=='read-only'||!/^[a-f0-9]{64}$/.test(a.toolPolicyDigest??'')||agentEffectsPresent(db,r,c))fail('MESSAGE_AGENT_BEGIN_FORBIDDEN')
      if(execution){
        if(execution.inputVersion!==a.inputVersion||execution.inputDigest!==a.inputDigest||execution.inputRef!==a.inputRef
          ||execution.sessionId!==a.sessionId||execution.toolPolicyDigest!==a.toolPolicyDigest)fail('MESSAGE_AGENT_INPUT_CONFLICT')
        if(['succeeded','failed'].includes(execution.status))return {result:{execution,cached:true}}
        if(execution.status==='running'&&execution.commandLeaseEpoch===c.leaseEpoch)return {result:{execution,cached:false}}
        if(!['ready','interrupted'].includes(execution.status)||!execution.drained)fail('MESSAGE_AGENT_NOT_READY')
        if(execution.status==='interrupted')rememberAgentBinding(execution)
        execution.leaseEpoch++
      }else{
        if(db.prepare("SELECT 1 FROM message_items WHERE kind='agent-execution' AND json_extract(body,'$.sessionId')=?").get(a.sessionId))fail('MESSAGE_AGENT_SESSION_CONFLICT')
        execution={id:c.id,commandId:c.id,runId:r.runId,unitId:c.unitId,kind:'message-unit',mode:a.mode,toolPolicyDigest:a.toolPolicyDigest,
          runRevision:r.revision,sourceVersion:r.sourceVersion,inputVersion:a.inputVersion,inputDigest:a.inputDigest,inputRef:a.inputRef,
          sessionId:a.sessionId,sessionBound:false,leaseEpoch:1,createdAt:now,inputHistory:[],bindingHistory:[]}
      }
      execution.commandLeaseEpoch=c.leaseEpoch;execution.status='running';execution.drained=false;execution.startedAt=now;execution.error=null
      put(db,r.runId,'agent-execution',execution);return {result:{execution,cached:false}}
    }
    if(!execution)fail('MESSAGE_AGENT_NOT_FOUND')
    if(kind==='message.agent.cancel') {
      if(execution.leaseEpoch!==a.expectedLeaseEpoch)fail('MESSAGE_AGENT_STALE')
      if(execution.status==='cancelled')return {result:{execution,command:c}}
      if(['succeeded','failed','superseded'].includes(execution.status))fail('MESSAGE_AGENT_TERMINAL')
      execution.cancelReason=str(a.reason);execution.status=execution.drained?'cancelled':'cancelling'
      for(const request of rows(db,r.runId,'request').filter(q=>q.commandId===c.id&&q.status==='pending')){request.status='superseded';put(db,r.runId,'request',request)}
      if(execution.drained){c.status='cancelled';c.completedAt=now;agentCommandSettled(db,r,c)}
      put(db,r.runId,'agent-execution',execution);return {result:{execution,command:c}}
    }
    if(kind==='message.agent.resume') {
      const q=get(db,'request',a.requestId)
      if(q.runId!==r.runId||q.commandId!==c.id||q.nodeId!=='message-agent'||q.revision!==r.revision
        ||a.conversationId!==r.conversationId||!q.permittedActors.includes(a.actorId))fail('MESSAGE_AGENT_RESUME_FORBIDDEN')
      if(q.status==='resolved'&&q.eventId===a.eventId&&q.answer===a.answer&&execution.inputVersion===a.inputVersion&&execution.inputDigest===a.inputDigest&&execution.inputRef===a.inputRef)return {result:{execution,command:c,request:q}}
      if(q.status!=='pending'||execution.status!=='waiting_user'||c.status!=='waiting'||!execution.drained)fail('MESSAGE_AGENT_NOT_WAITING')
      agentInput({...a,sessionId:execution.sessionId})
      if(a.inputVersion!==execution.inputVersion+1)fail('MESSAGE_AGENT_INPUT_VERSION_INVALID')
      rememberAgentBinding(execution)
      execution.inputHistory.push({inputVersion:execution.inputVersion,inputDigest:execution.inputDigest,inputRef:execution.inputRef,requestId:q.id,eventId:str(a.eventId)})
      execution.inputVersion=a.inputVersion;execution.inputDigest=a.inputDigest;execution.inputRef=a.inputRef;execution.status='ready';execution.updatedAt=now
      q.status='resolved';q.answer=str(a.answer);q.eventId=a.eventId;q.resolvedAt=now;put(db,r.runId,'request',q)
      c.status='pending';put(db,r.runId,'command',c);r.status='pending';r.intentStatus='processed';save(db,r)
      put(db,r.runId,'agent-execution',execution);return {result:{execution,command:c,request:q}}
    }
    agentIdentity(execution,a)
    if(execution.status!=='running'||c.status!=='running'||c.leaseEpoch!==a.commandLeaseEpoch)fail('MESSAGE_AGENT_NOT_RUNNING')
    if(kind==='message.agent.bind'){execution.sessionBound=true;put(db,r.runId,'agent-execution',execution);return {result:{execution}}}
    if(!['message.agent.complete','message.agent.fail','message.agent.wait'].includes(kind))fail('MESSAGE_UNKNOWN_COMMAND')
    if(a.drained!==true)fail('MESSAGE_AGENT_NOT_DRAINED')
    execution.drained=true;execution.drainedAt=now;execution.completedAt=now
    if(kind==='message.agent.wait') {
      if(a.conversationId!==r.conversationId||!a.request||!Array.isArray(a.request.permittedActors)||!a.request.permittedActors.length
        ||a.request.permittedActors.some(actor=>typeof actor!=='string'||!actor))fail('MESSAGE_AGENT_WAIT_FORBIDDEN')
      const id=str(a.request.requestId)
      if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('request:'+id))fail('MESSAGE_REQUEST_EXISTS')
      const q={id,requestId:id,kind:'needs_clarification',question:str(a.request.question),permittedActors:[...new Set(a.request.permittedActors)],
        runId:r.runId,unitId:c.unitId,nodeId:'message-agent',commandId:c.id,revision:r.revision,inputVersion:execution.inputVersion,inputDigest:execution.inputDigest,status:'pending',createdAt:now}
      execution.status='waiting_user';execution.requestId=id;c.status='waiting';put(db,r.runId,'request',q);put(db,r.runId,'command',c)
      r.status='waiting';r.intentStatus='intent_blocked';save(db,r);put(db,r.runId,'agent-execution',execution);return {result:{execution,command:c,request:q}}
    }
    execution.status=kind.endsWith('complete')?'succeeded':'failed'
    if(execution.status==='succeeded'){execution.resultRef=str(a.resultRef);if(!a.result||typeof a.result!=='object')fail('MESSAGE_AGENT_RESULT_REQUIRED');execution.result=a.result}
    else {execution.error=str(a.error);execution.resultRef=a.resultRef??null;execution.result=a.result??null}
    put(db,r.runId,'agent-execution',execution);return {result:{execution}}
  }
  if(kind==='message.web-task.prepare') {
    const old=queryMessages(db,{kind:'message.web-task',eventId:a.eventId})
    if(old){if(json(canonical(old.request))!==json(canonical(a.request))||old.actorId!==a.actorId)fail('MESSAGE_WEB_EVENT_CONFLICT');return {result:{event:old}}}
    const origin=queryMessages(db,{kind:'message.task',taskId:a.request.taskId})
    if(!origin)fail('MESSAGE_TASK_NOT_FOUND')
    const task=db.prepare('SELECT * FROM execution_runs WHERE run_id=? AND task_id=?').get(a.executionRunId,a.request.taskId)
    const businessTask=db.prepare('SELECT requirement_revision,requirement_ref FROM business_tasks WHERE task_id=?').get(a.request.taskId)
    const runCount=db.prepare('SELECT count(*) AS count FROM execution_runs WHERE task_id=?').get(a.request.taskId).count
    if((runCount ? !task : a.executionRunId !== null)||!businessTask?.requirement_ref||a.request.runSequence!==runCount
      ||a.request.inputVersion!==businessTask.requirement_revision+1)fail('REVISION_CONFLICT')
    if(!['cancel','context'].includes(a.request.action))fail('MESSAGE_WEB_ACTION_UNSUPPORTED')
    if(a.request.action==='context'&&isBusinessTaskTerminal(db,a.request.taskId))fail('RUN_TERMINAL')
    const event={id:str(a.eventId),actorId:str(a.actorId),runId:origin.run.runId,executionRunId:task?.run_id??null,request:a.request,input:a.input??null,status:'pending'}
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
    registerRelatedTaskInput(db,r,bound,ctx.now)
    if(rows(db,r.runId,'unit').filter(item=>item.status!=='superseded').every(item=>db.prepare('SELECT 1 FROM message_topic_bindings WHERE unit_id=?').get(item.id))){r.routingStatus='routing_complete';r.intentStatus='waiting_routing_barrier';save(db,r)}
    return {result:{topic:result.result.topic,unit:bound}}
  }
  if(kind==='workflow.freezeCapabilities') {
    const old=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(str(a.digest))
    if(!old)fail('WORKFLOW_DEFINITION_CONFLICT')
    const record=JSON.parse(old.body)
    if(record.workflowId!=='task-investigation'||record.config.capabilityIdentity||executionDigest(record.config)!==a.expectedConfigDigest||!/^[a-f0-9]{64}$/.test(a.capabilityIdentity)
      ||!Array.isArray(a.allowedTools)||a.allowedTools.some(tool=>typeof tool!=='string'||!tool)||new Set(a.allowedTools).size!==a.allowedTools.length)fail('WORKFLOW_DEFINITION_CONFLICT')
    record.config={...record.config,capabilityIdentity:a.capabilityIdentity,allowedTools:a.allowedTools}
    db.prepare('UPDATE message_workflows SET body=? WHERE digest=?').run(json(record),a.digest)
    return {result:record}
  }
  if(kind==='workflow.register') { str(a.workflowId);str(a.definitionVersion);str(a.digest);const old=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(a.digest);if(old&&json(JSON.parse(old.body))!==json(a))fail('WORKFLOW_DEFINITION_CONFLICT');if(!old)db.prepare('INSERT INTO message_workflows VALUES(?,?)').run(a.digest,json(a));return {result:a} }
  if(!kind.startsWith('message.')) return null
  const now=ctx.now
  if(kind==='message.notification.diagnostic') {
    const r=run(db,a.runId),id=str(a.diagnosticId),fact=str(a.fact)
    const previous=rows(db,r.runId,'notification-diagnostic').find(item=>item.id===id)
    if(previous&&(previous.runId!==r.runId||previous.fact!==fact))fail('MESSAGE_NOTIFICATION_DIAGNOSTIC_CONFLICT')
    if(a.resolved===true){if(!previous)return {result:{diagnostic:null}};previous.status='resolved';previous.resolvedAt=now;put(db,r.runId,'notification-diagnostic',previous);return {result:{diagnostic:previous}}}
    if(previous?.status==='unresolved'&&previous.error===a.error)return {result:{diagnostic:previous}}
    const diagnostic={id,runId:r.runId,fact,error:str(a.error),status:'unresolved',attempts:(previous?.attempts??0)+1,createdAt:previous?.createdAt??now,updatedAt:now}
    put(db,r.runId,'notification-diagnostic',diagnostic);return {result:{diagnostic}}
  }
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
      const taskId=a.payload?.fact?.taskId??(a.commandId?get(db,'command',a.commandId).result?.taskId:a.acceptanceId?get(db,'acceptance',a.acceptanceId).taskId:null)
      if(notificationTaskDeleted(db,taskId))fail('TASK_DELETED')
      if([a.commandId,a.requestId,a.stateFact,a.acceptanceId].filter(Boolean).length!==1)fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')
      if(a.payload?.phase==='owner:application_wait:released'&&!ownerReleasedWait(db,taskId))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')
      if(a.commandId){const c=get(db,'command',a.commandId);if(c.runId!==r.runId||!['applied','rejected'].includes(c.status))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED');const fact=a.payload?.fact;if(fact?.commandLeaseEpoch!==undefined&&(c.leaseEpoch!==fact.commandLeaseEpoch||fact.commandInputVersion!==undefined&&c.result?.inputVersion!==fact.commandInputVersion))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      else if(a.requestId){const q=get(db,'request',a.requestId);current(db,r,q.revision);if(q.runId!==r.runId||q.status!=='pending'||!(q.kind==='needs_clarification'||q.kind==='needs_context'&&q.blocked===true))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      else if(a.acceptanceId){const fact=get(db,'acceptance',a.acceptanceId);if(fact.runId!==r.runId||db.prepare('SELECT requirement_revision FROM business_tasks WHERE task_id=?').get(fact.taskId)?.requirement_revision!==fact.requirementRevision)fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')}
      else if(!notificationStateCurrent(r,a.stateFact))fail('MESSAGE_NOTIFICATION_FACT_REQUIRED')
      if(!a.disclosure||a.disclosure.conversationId!==r.conversationId||!a.disclosure.authorizationRef)fail('MESSAGE_DISCLOSURE_REQUIRED')
      str(a.notificationId)
      const eventKey=str(a.eventKey??`${a.requestId?'request.clarification':'action.reply'}:${a.requestId??a.commandId}:${a.payload?.phase??'notice'}`)
      const sameEvent=db.prepare("SELECT body FROM message_items WHERE kind='notification' AND json_extract(body,'$.eventKey')=? LIMIT 1").get(eventKey)
      if(sameEvent){const old=JSON.parse(sameEvent.body);if(old.eventKey!==eventKey||json(canonical(old.payload))!==json(canonical(a.payload)))fail('MESSAGE_NOTIFICATION_EVENT_CONFLICT');return {result:{notification:old}}}
      if(db.prepare('SELECT 1 FROM message_items WHERE item_id=?').get('notification:'+a.notificationId)) {const old=get(db,'notification',a.notificationId);if(old.runId!==a.runId||old.commandId!==a.commandId||old.requestId!==a.requestId||json(canonical(old.payload))!==json(canonical(a.payload)))fail('MESSAGE_NOTIFICATION_CONFLICT');return {result:{notification:old}}}
      const n={id:a.notificationId,eventKey,runId:r.runId,...(a.commandId?{commandId:a.commandId}:a.requestId?{requestId:a.requestId}:a.acceptanceId?{acceptanceId:a.acceptanceId}:{stateFact:a.stateFact}),payload:a.payload,disclosure:a.disclosure,status:'prepared',leaseEpoch:0,createdAt:now};put(db,r.runId,'notification',n);return {result:{notification:n}}
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
    if(kind==='message.notification.claim') {if(n.status!=='prepared')fail('MESSAGE_NOTIFICATION_NOT_READY');const source=run(db,n.runId);if(source.status==='superseded'){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}if(n.requestId){const q=get(db,'request',n.requestId);if(q.status!=='pending'||q.revision!==source.revision||n.payload?.phase==='system_wait'&&(!q.blocked||rows(db,source.runId,'request').some(item=>item.status==='pending'&&item.kind==='needs_context'&&!item.blocked)||rows(db,source.runId,'command').some(item=>['pending','running'].includes(item.status))||rows(db,source.runId,'node').some(item=>item.status==='running'))){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}}
      const phase=n.payload?.phase
      const action=n.commandId?get(db,'command',n.commandId):null
      const row=phase?.startsWith('owner:')?db.prepare(`SELECT r.*,t.application_status FROM task_reports r
        JOIN task_owner_turns t ON t.turn_id=r.turn_id WHERE r.report_id=?`).get(phase.slice(6)):null
      const report=row?{reportType:row.report_type,applicationStatus:row.application_status,facts:JSON.parse(row.facts_json),
        triggerTypes:db.prepare('SELECT DISTINCT event_type FROM task_events WHERE turn_id=?').all(row.turn_id).map(e=>e.event_type)}:null
      if(!taskNotificationAllowed({phase,action,report})){
        n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n)
        return {result:{notification:n},dispatchEligible:false}
      }
      const taskId=n.payload?.fact?.taskId??(n.commandId?get(db,'command',n.commandId).result?.taskId:n.acceptanceId?get(db,'acceptance',n.acceptanceId).taskId:null)
      if(notificationTaskDeleted(db,taskId)){n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}
      const version=n.payload?.fact
      if(n.acceptanceId){const fact=get(db,'acceptance',n.acceptanceId);if(db.prepare('SELECT requirement_revision FROM business_tasks WHERE task_id=?').get(fact.taskId)?.requirement_revision!==fact.requirementRevision){n.status='superseded';put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}}
      if(n.stateFact&&!notificationStateCurrent(source,n.stateFact)||version&&(version.sourceVersion!==source.sourceVersion||version.runRevision!==source.revision
        ||version.taskId&&version.requirementRevision!==undefined&&db.prepare('SELECT requirement_revision FROM business_tasks WHERE task_id=?').get(version.taskId)?.requirement_revision!==version.requirementRevision)){
        n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}
      }
      if(version?.commandLeaseEpoch!==undefined&&(()=>{const command=get(db,'command',n.commandId);return command.status!=='applied'||command.leaseEpoch!==version.commandLeaseEpoch||version.commandInputVersion!==undefined&&command.result?.inputVersion!==version.commandInputVersion})()){n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}
      if(n.commandId&&n.payload?.phase==='receipt'){
        const action=get(db,'command',n.commandId)
        const latest=taskId?db.prepare('SELECT run_id FROM execution_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId):null
        if(action.status==='applied'&&action.kind==='revise'||['status','result'].includes(action.kind)&&action.result?.runId&&latest&&latest.run_id!==action.result.runId){
          n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}
        }
      }
      if(n.payload?.phase?.startsWith('owner:started:')){
        const executionRunId=n.payload.phase.slice('owner:started:'.length)
        const execution=db.prepare('SELECT status,pause_requested,stop_requested FROM execution_runs WHERE run_id=? AND task_id=?').get(executionRunId,taskId)
        const control=db.prepare('SELECT state AS control_state FROM task_controls WHERE task_id=?').get(taskId)
        const started=db.prepare(`SELECT 1 FROM execution_nodes n JOIN execution_events e
          ON e.kind='node.claim' AND json_extract(e.payload,'$.binding.nodeRunId')=n.node_run_id
          AND json_extract(e.payload,'$.binding.leaseEpoch')=n.lease_epoch
          WHERE n.run_id=? AND n.current=1 AND n.status='running' LIMIT 1`).get(executionRunId)
        if(execution?.status!=='running'||execution.pause_requested||execution.stop_requested||control?.control_state!=='active'||!started){
          n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}
        }
        assertMessageTaskUnfenced(db,taskId)
      }
      if(n.payload?.phase?.startsWith('owner:')&&!n.payload.phase.startsWith('owner:started:')){
        const applicationWait=n.payload.phase.startsWith('owner:application_wait:')
        const reportId=n.payload.phase.slice(applicationWait?'owner:application_wait:'.length:'owner:'.length)
        const releasedWait=n.payload.phase==='owner:application_wait:released'
        const fact=releasedWait?ownerReleasedWait(db,taskId):db.prepare(`SELECT r.task_id,r.turn_id,r.report_type,t.application_status,t.requirement_revision AS report_requirement_revision,o.event_watermark,o.processed_watermark,
          b.requirement_revision,b.plan_revision,b.plan_requirement_revision,c.control_revision,t.control_revision AS report_control_revision,o.status AS owner_status
          FROM task_reports r JOIN task_owner_turns t ON t.turn_id=r.turn_id
          JOIN task_owners o ON o.task_id=r.task_id
          JOIN business_tasks b ON b.task_id=r.task_id JOIN task_controls c ON c.task_id=r.task_id WHERE r.report_id=?`).get(reportId)
        const latest=fact?db.prepare("SELECT turn_id FROM task_owner_turns WHERE task_id=? AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(fact.task_id):null
        if(!fact||(!releasedWait&&((applicationWait ? fact.application_status!=='blocked'||fact.owner_status!=='blocked'||fact.report_control_revision!==fact.control_revision : fact.application_status!=='applied'||fact.event_watermark!==fact.processed_watermark)||latest?.turn_id!==fact.turn_id
            ||fact.report_requirement_revision!==fact.requirement_revision
            ||fact.report_type==='complete'&&fact.plan_revision>0&&fact.plan_requirement_revision!==fact.requirement_revision))){
          n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n)
          return {result:{notification:n},dispatchEligible:false}
        }
        if(applicationWait){
          const recovered=db.prepare("SELECT created_at FROM task_events WHERE task_id=? AND event_type='workflow.succeeded' ORDER BY seq DESC LIMIT 1").get(fact.task_id)
          const sent=db.prepare("SELECT body FROM message_items WHERE kind='notification' AND json_extract(body,'$.payload.fact.taskId')=? AND json_extract(body,'$.payload.phase') LIKE 'owner:application_wait:%' AND json_extract(body,'$.status') IN ('sending','acknowledged','unknown','delivered')").all(fact.task_id).some(row=>{const prior=JSON.parse(row.body);return !recovered||prior.createdAt>=recovered.created_at})
          if(sent){n.status='superseded';n.supersededAt=now;put(db,n.runId,'notification',n);return {result:{notification:n},dispatchEligible:false}}
        }
        if(!applicationWait&&(fact.report_type==='complete'||fact.report_type==='progress'))assertMessageTaskUnfenced(db,fact.task_id)
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
      for(const item of db.prepare("SELECT body FROM message_runs WHERE json_extract(body,'$.conversationId')=? AND json_extract(body,'$.status')='buffered'").all(a.conversationId)){const r=JSON.parse(item.body);r.status='pending';r.engineEpoch=g.epoch;save(db,r)}
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
    registerMessageImpact(db,alias,now)
    return {result:{run:original,alias}}
  }
  if(kind==='message.reprocess') {
    const old=run(db,str(a.runId));current(db,old)
    const oldUnits=rows(db,old.runId,'unit')
    const oldCommands=rows(db,old.runId,'command'),oldNotifications=rows(db,old.runId,'notification')
    const resolvedSplitRequests=rows(db,old.runId,'request').filter(item=>item.status==='resolved'&&item.nodeId==='S'&&item.unitId==='$'&&item.kind==='needs_clarification')
    const answeredNotice=item=>oldCommands.length===0&&item.status==='delivered'&&!item.commandId
      &&item.payload?.conversationId===old.conversationId&&resolvedSplitRequests.some(request=>request.id===item.requestId)
    const deliveredState=item=>oldCommands.length===0&&item.status==='delivered'&&!item.commandId
      &&item.payload?.conversationId===old.conversationId
      &&['attention','routing_wait','system_wait'].includes(item.payload?.phase)
      &&(item.stateFact?.phase===item.payload.phase||item.payload.phase==='system_wait'&&rows(db,old.runId,'request').some(request=>request.id===item.requestId&&request.kind==='needs_context'))
    if(oldNotifications.some(item=>!['prepared','superseded'].includes(item.status)&&!answeredNotice(item)&&!deliveredState(item)))fail('MESSAGE_REPROCESS_EFFECT_PENDING')
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
      budgetBaseline:spent,policy:{...old.policy,...a.policy}}
    delete next.activatedAt;delete next.executionStartedAt;delete next.reason;delete next.capacityRetryVersion;delete next.attentionScope;delete next.attentionUnitIds;delete next.coordinatorConsumed
    db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run(next.runId,next.sourceKey,next.sourceVersion,json(next))
    db.prepare('UPDATE message_sources SET current_version=? WHERE source_key=?').run(next.sourceVersion,next.sourceKey)
    registerMessageImpact(db,next,now)
    for(const request of resolvedSplitRequests){
      const id=createHash('sha256').update(json([next.runId,request.id])).digest('hex')
      put(db,next.runId,'request',{...request,id,requestId:id,runId:next.runId,revision:0})
    }
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
    const r={...a,revision:0,status:'pending',routingStatus:'routing_pending',intentStatus:null,createdAt:now,policy:{...a.policy},snapshot:null}
    const group=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(a.conversationId);if(group){const g=JSON.parse(group.body);r.engineEpoch=g.epoch;if(g.state!=='active'||g.engine!=='workflow')r.status='buffered'}
    db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run(a.runId,a.sourceKey,a.sourceVersion,json(r))
    registerMessageImpact(db,r,now)
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
      if(c.kind==='answer') {
        const execution=rows(db,r.runId,'agent-execution').find(item=>item.commandId===c.id)
        const requestDigest=textHash(json(canonical(a))),prior=(c.readonlyRetryHistory??[]).find(item=>item.retryKey===a.retryKey)
        if(prior){if(prior.requestDigest!==requestDigest)fail('MESSAGE_READONLY_RETRY_CONFLICT');return {result:{command:c,run:r,execution,cached:true}}}
        if(c.status!=='applied'||c.result?.status!=='blocked'||c.result?.reason!=='execution_tool_failed'||c.args?.taskId||c.result?.taskId||c.result?.runId
          ||!execution||execution.kind!=='message-unit'||execution.mode!=='read-only'||execution.status!=='failed'||execution.drained!==true||execution.error!=='execution_tool_failed'
          ||execution.runRevision!==r.revision||execution.sourceVersion!==r.sourceVersion||a.sourceVersion!==r.sourceVersion||a.expectedRunRevision!==r.revision
          ||a.expectedInputVersion!==execution.inputVersion||a.expectedInputDigest!==execution.inputDigest||a.expectedLeaseEpoch!==execution.leaseEpoch
          ||!/^([a-f0-9]{64})$/.test(execution.toolPolicyDigest??'')||!/^([a-f0-9]{64})$/.test(a.toolPolicyDigest??''))fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
        agentInput(a);str(a.retryKey);str(a.reason)
        if(a.inputVersion!==execution.inputVersion+1||a.sessionId===execution.sessionId
          ||db.prepare("SELECT body FROM message_items WHERE kind='agent-execution'").all().some(row=>{const item=JSON.parse(row.body);return [item,...(item.bindingHistory??[]),...(item.attemptHistory??[])].some(prior=>prior.sessionId===a.sessionId)}))fail('MESSAGE_AGENT_INPUT_VERSION_INVALID')
        if(c.topicId){const topic=queryMessageTopics(db,{kind:'message.topic',topicId:c.topicId});if(!topic||topic.inputRevision!==c.topicInputRevision
          ||queryMessages(db,{kind:'message.routing.pending',conversationId:r.conversationId,topicId:c.topicId}).length)fail('MESSAGE_INPUT_PENDING')}
        const notices=rows(db,r.runId,'notification').filter(item=>item.commandId===c.id)
        if(notices.some(item=>!['delivered','superseded','prepared'].includes(item.status))
          ||rows(db,r.runId,'notification-operation').some(item=>notices.some(n=>n.id===item.notificationId)||item.commandId===c.id)
          ||db.prepare('SELECT 1 FROM execution_effects WHERE run_id=? LIMIT 1').get(r.runId)
          ||db.prepare('SELECT 1 FROM execution_runs WHERE run_id=? LIMIT 1').get(r.runId)
          ||rows(db,r.runId,'request').some(item=>item.commandId===c.id&&item.status==='pending'))fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
        const previous={...execution};delete previous.attemptHistory
        execution.attemptHistory=[...(execution.attemptHistory??[]),previous]
        rememberAgentBinding(execution)
        execution.inputHistory.push({inputVersion:execution.inputVersion,inputDigest:execution.inputDigest,inputRef:execution.inputRef,retryKey:a.retryKey})
        c.readonlyRetryHistory=[...(c.readonlyRetryHistory??[]),{retryKey:a.retryKey,requestDigest,reason:a.reason,at:now,status:c.status,result:c.result,error:c.error,completedAt:c.completedAt,leaseEpoch:c.leaseEpoch,inputVersion:execution.inputVersion,notificationIds:notices.map(item=>item.id)}]
        for(const notice of notices.filter(item=>item.status==='prepared')){notice.status='superseded';notice.supersededAt=now;put(db,r.runId,'notification',notice)}
        Object.assign(execution,{inputVersion:a.inputVersion,inputDigest:a.inputDigest,inputRef:a.inputRef,sessionId:a.sessionId,toolPolicyDigest:a.toolPolicyDigest,
          sessionBound:false,status:'ready',drained:true,result:null,resultRef:null,error:null,updatedAt:now})
        delete execution.completedAt;delete execution.startedAt;delete execution.drainedAt
        c.status='pending';c.result=null;c.error=null;delete c.completedAt
        put(db,r.runId,'agent-execution',execution);put(db,r.runId,'command',c)
        const unit=get(db,'unit',c.unitId);unit.status='accepted';put(db,r.runId,'unit',unit)
        r.status='pending';r.intentStatus='processed';save(db,r)
        return {result:{command:c,run:r,execution,cached:false}}
      }
      if(!['status','result'].includes(c.kind)||c.status!=='unknown'||c.error!=='INVALID_ARGUMENT'||c.result!==null)fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
      if(rows(db,r.runId,'notification').some(item=>item.commandId===c.commandId||item.commandId===c.id))fail('MESSAGE_READONLY_RETRY_FORBIDDEN')
      c.readonlyRetryCount=(c.readonlyRetryCount??0)+1;c.status='pending';c.error=null;c.result=null;put(db,r.runId,'command',c)
      if(r.status==='needs_attention'&&r.reason==='recovery_exhausted'){r.status='pending';r.reason=null;save(db,r)}
      return {result:{command:c,run:r}}
    }
    if(kind==='message.command.claim') {
      current(db,r,c.revision)
      if(c.status!=='pending') fail('MESSAGE_COMMAND_NOT_READY')
      if(c.topicId){
        if(queryMessages(db,{kind:'message.routing.pending',conversationId:r.conversationId,topicId:c.topicId}).length
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
    if(get(db,'unit',c.unitId).blockedReason||r.status==='needs_attention'&&r.attentionScope!=='unit')fail('MESSAGE_NEEDS_ATTENTION')
      const fences=db.prepare("SELECT body FROM message_items WHERE kind='barrier'").all().map(x=>JSON.parse(x.body))
      if(fences.some(b=>b.status==='pending'&&b.ownerRunId!==c.runId&&((b.targetSourceKey===r.sourceKey&&(!b.unitIds||b.unitIds.includes(c.unitId)))||(b.targetTaskId&&b.targetTaskId===c.args?.taskId))))fail('MESSAGE_INPUT_PENDING')
      for(const id of c.dependsOn??[])if(get(db,'command',id).status!=='applied')fail('MESSAGE_DEPENDENCY_PENDING')
      c.status='running';c.leaseEpoch++;c.startedAt=now;put(db,r.runId,'command',c)
      return {result:{command:c},dispatchEligible:true}
    }
    if(c.status!=='running'||c.leaseEpoch!==a.leaseEpoch)fail('MESSAGE_COMMAND_STALE')
    if(!['message.command.complete','message.command.fail'].includes(kind))fail('MESSAGE_UNKNOWN_COMMAND')
    const agent=rows(db,r.runId,'agent-execution').find(e=>e.commandId===c.id)
    if(agent&&(!agent.drained||!['succeeded','failed'].includes(agent.status)))fail('MESSAGE_AGENT_NOT_DRAINED')
    c.status=kind.endsWith('fail')?'unknown':'applied';c.result=a.result??null;if(agent&&c.kind==='answer'&&c.result)c.result={...c.result,inputVersion:agent.inputVersion};c.error=a.error??null;c.completedAt=now;put(db,r.runId,'command',c)
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
  if(kind==='message.echo.reconcile') {
    if(!a||Object.keys(a).some(key=>!['runId','expectedDigest'].includes(key)))fail('MESSAGE_INVALID_ARGUMENT')
    const r=run(db,a.runId),check=echoReconciliation(db,r)
    if(!check.eligible)fail(check.reason)
    if(str(a.expectedDigest)!==check.expectedDigest)fail('MESSAGE_ECHO_RECONCILE_STALE')
    const nodeRunIds=finishEchoNodes(db,r,now),barrierIds=finishEchoBarriers(db,r,now)
    return {result:{runId:r.runId,status:nodeRunIds.length||barrierIds.length?'reconciled':'already-reconciled',nodeRunIds,barrierIds,
      notificationId:check.notificationId,sourceMessageId:check.sourceMessageId}}
  }
  const r=run(db,a.runId);current(db,r,a.expectedRevision)
  if(kind==='message.source.enrich'){
    const proof=a.independentReadback
    const exactBody=proof?.body===r.body||sameDwsFileProjection({sourceKind:'dingtalk',text:r.body},{text:proof?.body,resourceRefs:proof?.resourceRefs})
      ||sameDwsFileProjection({sourceKind:'dingtalk',text:proof?.body},{text:r.body,resourceRefs:proof?.resourceRefs})
    if(a.sourceKey!==r.sourceKey||a.sourceVersion!==r.sourceVersion||a.actorId!==r.actorId||proof?.provider!=='dws'
      ||proof.messageId!==r.context?.sourceMessageId||proof.conversationId!==r.conversationId||proof.actorId!==r.actorId||!exactBody
      ||!Array.isArray(a.attachments)||!Array.isArray(proof.fileIds))fail('MESSAGE_SOURCE_ENRICH_PROOF_REQUIRED')
    for(const attachment of a.attachments)if(!attachment.fileId||attachment.resourceRef!==attachment.fileId||!proof.fileIds.includes(attachment.fileId)
      ||!proof.resourceRefs?.some(ref=>ref.type==='fileId'&&ref.resourceId===attachment.fileId))fail('MESSAGE_SOURCE_ENRICH_PROOF_REQUIRED')
    r.context??={};const existing=r.context.attachments??[]
    r.context.attachments=[...existing,...a.attachments.filter(item=>!existing.some(old=>old.fileId===item.fileId))]
    r.resourceEnrichment={provider:proof.provider,messageId:proof.messageId,fileIds:proof.fileIds,verifiedAt:now}
    save(db,r);return {result:{run:r,enriched:r.context.attachments.length-existing.length}}
  }
  if(kind==='message.impact.resolve') {
    const catalog=impactCatalog(db,r)
    if(a.catalogRevision!==catalog.catalogRevision)fail('MESSAGE_IMPACT_CATALOG_STALE')
    const impact=rows(db,r.runId,'impact')[0];if(!impact)fail('MESSAGE_IMPACT_MISSING')
    const unitId=a.unitId??'$'
    if(unitId!=='$'&&get(db,'unit',unitId).runId!==r.runId)fail('MESSAGE_IMPACT_SCOPE_INVALID')
    if(!Array.isArray(a.assessments)||!a.assessments.length)fail('MESSAGE_IMPACT_EVIDENCE_REQUIRED')
    for(const assessment of a.assessments){
      const target=catalog.candidateTopics.find(topic=>topic.topicId===assessment.topicId)
      if(!target||!['related','independent'].includes(assessment.relation))fail('MESSAGE_IMPACT_SCOPE_INVALID')
      str(assessment.reason)
      if(!Array.isArray(assessment.sourceRefs)||!assessment.sourceRefs.length)fail('MESSAGE_IMPACT_EVIDENCE_REQUIRED')
      for(const ref of assessment.sourceRefs){
        const evidence=db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(str(ref.sourceKey),ref.sourceVersion)
        const source=evidence?JSON.parse(evidence.body):null
        if(!source||source.conversationId!==r.conversationId||!source.body.includes(str(ref.text))
          ||db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(ref.sourceKey)?.current_version!==ref.sourceVersion)fail('MESSAGE_IMPACT_EVIDENCE_STALE')
      }
      if(!assessment.sourceRefs.some(ref=>ref.sourceKey===r.sourceKey&&ref.sourceVersion===r.sourceVersion))fail('MESSAGE_IMPACT_EVIDENCE_REQUIRED')
      impact.assessments=impact.assessments.filter(p=>p.unitId!==unitId||p.topicId!==assessment.topicId)
      impact.assessments.push({...assessment,unitId,targetInputRevision:target.inputRevision,targetContextRevision:target.contextRevision})
    }
    impact.revision++;impact.catalogRevision=catalog.catalogRevision;impact.updatedAt=now;put(db,r.runId,'impact',impact)
    return {result:{impact}}
  }
  if(kind==='message.request.retry'||kind==='message.request.retry.reset'||kind==='message.request.supersede') {
    const q=get(db,'request',a.requestId)
    if(q.runId!==r.runId||q.revision!==r.revision||q.kind!=='needs_context')fail('MESSAGE_REQUEST_STALE')
    if(q.status!=='pending')return {result:{request:q,run:r}}
    if(kind==='message.request.retry.reset'){
      if(a.sourceVersion!==r.sourceVersion||!q.lastError)fail('MESSAGE_REQUEST_STALE')
      str(a.reason);str(a.dependencyRevision)
      if(q.dependencyRevision===a.dependencyRevision)fail('MESSAGE_REQUEST_DEPENDENCY_UNCHANGED')
      q.retryHistory=[...(q.retryHistory??[]),{attempts:q.attempts,lastError:q.lastError,contractVersion:q.contractVersion,dependencyRevision:q.dependencyRevision??null,resetAt:now,reason:a.reason}]
      q.dependencyRevision=a.dependencyRevision;q.attempts=0;q.blocked=false;q.responsibility='host';q.retryAt=null
      if(q.unitId!=='$'){const u=get(db,'unit',q.unitId);delete u.blockedReason;delete u.blockedAt;put(db,r.runId,'unit',u)}
    }else if(kind==='message.request.retry'){
      q.attempts=(q.attempts??0)+1;q.lastError=str(a.error);q.contractVersion=str(a.contractVersion);q.retryAt=a.retryAt??null
      q.blocked=false;q.responsibility='host';q.lastAttemptAt=now
    }else{
      q.status='superseded';q.reason=str(a.reason);q.resolvedAt=now
      for(const n of rows(db,r.runId,'node').filter(n=>n.unitId===q.unitId&&n.nodeId===q.nodeId&&n.revision===r.revision)){n.status='superseded';put(db,r.runId,'node',n)}
      r.status='pending';r.routingStatus='routing_pending';save(db,r)
    }
    put(db,r.runId,'request',q);return {result:{request:q,run:r}}
  }
  if(kind==='message.unit.no_action') {
    const u=get(db,'unit',a.unitId)
    const node=rows(db,r.runId,'node').findLast(item=>item.nodeId==='R'&&item.unitId===u.id&&item.revision===r.revision&&item.status==='succeeded')
    const output=node?.output?.output??node?.output
    const unitText=(u.spans??[]).map(span=>r.body.slice(span.start,span.end)).join('\n')
    const directed=(r.context?.directedToAgent===true||r.snapshot?.replyObligation?.required===true)&&(unitText===r.body||(r.snapshot?.agentNames??r.context?.agentNames??[]).some(name=>name&&unitText.includes(name)))
    if(directed||u.runId!==r.runId||u.status!=='pending'||u.topicId||rows(db,r.runId,'command').some(c=>c.unitId===u.id)
      ||output?.kind!=='no_action'||!output.reason?.trim()||!u.spans?.some(span=>r.body.slice(span.start,span.end)===output.sourceQuote))fail('MESSAGE_NO_ACTION_NOT_ALLOWED')
    for(const q of rows(db,r.runId,'request').filter(q=>q.unitId===u.id&&q.status==='pending')){q.status='superseded';q.reason='no_action';put(db,r.runId,'request',q)}
    u.status='ignored';u.reason=output.reason;put(db,r.runId,'unit',u)
    if(rows(db,r.runId,'unit').every(item=>['ignored','rejected','applied','superseded'].includes(item.status))){r.routingStatus='routing_complete';r.intentStatus='processed'}
    settle(db,r)
    return {result:{run:r,unit:u}}
  }
  if(kind==='message.no_action') {
    const node=rows(db,r.runId,'node').findLast(item=>item.nodeId==='S'&&item.revision===r.revision&&item.status==='succeeded')
    const output=node?.output?.output??node?.output
    if(output?.kind!=='no_action'||typeof output.reason!=='string'||!output.reason.trim()
      ||!['pending','waiting'].includes(r.status)||r.correction||rows(db,r.runId,'unit').length
      ||rows(db,r.runId,'command').length||rows(db,r.runId,'request').some(item=>item.status==='pending')||rows(db,r.runId,'barrier').some(item=>item.status==='pending'))fail('MESSAGE_NO_ACTION_NOT_ALLOWED')
    const covered=new Uint8Array(r.body.length)
    for(const span of output.coverage??[]){if(!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end>r.body.length||span.start>=span.end)fail('MESSAGE_SOURCE_SPAN_INVALID');covered.fill(1,span.start,span.end)}
    if(covered.some(value=>!value))fail('MESSAGE_SOURCE_COVERAGE_INCOMPLETE')
    r.status='settled';r.routingStatus='routing_complete';r.intentStatus='processed';r.reason=output.reason;save(db,r)
    return {result:{run:r}}
  }
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
    if(!a.material||typeof a.material.text!=='string')fail('MESSAGE_MATERIAL_INVALID')
    const id=json([r.runId,a.resourceRef]),old=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('material:'+id)
    if(old){const material=JSON.parse(old.body).material;if(json(canonical(material))!==json(canonical(a.material)))fail('MESSAGE_MATERIAL_CONFLICT');return {result:{material}}}
    put(db,r.runId,'material',{id,runId:r.runId,resourceRef:a.resourceRef,material:a.material,recordedAt:now});return {result:{material:a.material}}
  }
  if(kind==='message.attention') {
    if(a.unitId&&a.unitId!=='$'){
      const u=get(db,'unit',a.unitId);if(u.runId!==r.runId)fail('MESSAGE_STALE')
      u.blockedReason=str(a.reason);u.blockedAt=now;put(db,r.runId,'unit',u)
      if(r.attentionScope!=='run'){r.attentionScope='unit';r.attentionUnitIds=[...new Set([...(r.attentionUnitIds??[]),u.id])]}
    }else r.attentionScope='run'
    r.status='needs_attention';r.reason=a.reason;if(r.routingStatus!=='routing_complete')r.routingStatus='routing_blocked';else r.intentStatus='intent_blocked';save(db,r);return {result:{run:r}}
  }
  if(kind==='message.echo.quarantine') {
    const check=echoReconciliation(db,r,false)
    if(!check.eligible)fail('MESSAGE_ECHO_QUARANTINE_FORBIDDEN')
    for(const request of rows(db,r.runId,'request').filter(item=>item.status==='pending')) {request.status='superseded';put(db,r.runId,'request',request)}
    const nodeRunIds=finishEchoNodes(db,r,now),barrierIds=finishEchoBarriers(db,r,now)
    r.status='superseded';r.reason='outbound_echo';save(db,r)
    return {result:{run:r,nodeRunIds,barrierIds,notificationId:check.notificationId}}
  }
  if(kind==='message.activate') {
    if(r.status!=='pending'||r.activatedAt)return {result:{run:r}}
    current(db,r)
    r.activatedAt=now;save(db,r)
    return {result:{run:r}}
  }
  if(kind==='message.capacity.retry') {
    const stage=/^message-input-unbounded-v1:(S|R|I|IB):[a-f0-9]{16}$/.exec(a.projectionVersion??'')?.[1]??null
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
    r.policy={...r.policy,...a.policy}
    if(target){delete target.blockedReason;delete target.blockedAt;put(db,r.runId,'unit',target)}
    r.capacityRetryVersion=a.projectionVersion;r.status='pending';r.reason=null;save(db,r)
    return {result:{run:r,retry:true}}
  }
  if(kind==='message.relink') {const u=get(db,'unit',a.unitId);if(u.runId!==r.runId)fail('MESSAGE_STALE');if(rows(db,r.runId,'command').some(c=>c.unitId===u.id&&['running','unknown','applied'].includes(c.status)))fail('MESSAGE_CORRECTION_EFFECT_PENDING');revoke(db,r,[u.id]);unbindMessageUnit(db,u.id,now);const s=db.prepare('SELECT corrections FROM message_sources WHERE source_key=?').get(r.sourceKey);db.prepare('UPDATE message_sources SET corrections=corrections+1 WHERE source_key=?').run(r.sourceKey);u.status='pending';delete u.topicId;delete u.routingBinding;r.routingStatus='routing_pending';r.intentStatus=null;u.corrections=(u.corrections??0)+1;put(db,r.runId,'unit',u);save(db,r);return {result:{run:r,unit:u}}}
  if(kind==='message.recover') {
    if(r.status==='waiting'||r.status==='settled')fail('MESSAGE_NOT_RECOVERABLE')
    const started=messageExecutionStartedAt(r,rows(db,r.runId,'node'))??(rows(db,r.runId,'command').length?r.createdAt:null)
    const failures=rows(db,r.runId,'node').filter(node=>node.status==='failed'&&node.input?.deterministic!==true)
    // 历史 recoveryWindows 曾按扫描次数计费，不能作为模型失败证据。
    // 原生事件保留被后续重试覆盖的失败 lease，避免仅看当前节点漏算真实失败。
    const failedLeases=new Set([...db.prepare("SELECT payload FROM execution_events WHERE kind='message.node.fail' AND json_extract(payload,'$.node.runId')=?").all(r.runId)
      .map(row=>JSON.parse(row.payload).node),...failures].filter(node=>node.input?.deterministic!==true).map(node=>`${node.id}:${node.leaseEpoch}`))
    const recoveryCount=failedLeases.size||(rows(db,r.runId,'command').length>0?(r.recoveryWindows??0)+1:0)
    if(started)r.executionStartedAt=started
    r.recoveryWindows=recoveryCount
    for(const unit of rows(db,r.runId,'unit').filter(unit=>/^MESSAGE_DEADLINE_BEFORE_CLAIM:/u.test(unit.blockedReason??''))){delete unit.blockedReason;delete unit.blockedAt;put(db,r.runId,'unit',unit)}
    const blocked=rows(db,r.runId,'unit').filter(unit=>unit.blockedReason)
    if(blocked.length){r.attentionUnitIds=blocked.map(unit=>unit.id);r.attentionScope='unit';r.status='needs_attention';r.reason=blocked[0].blockedReason;save(db,r);return {result:{run:r}}}
    delete r.attentionScope;delete r.attentionUnitIds
    r.status='pending';r.reason=null;save(db,r);return {result:{run:r}}
  }
  if(kind==='message.snapshot') {r.snapshot=a.snapshot;save(db,r);return {result:{run:r}}}
  if(kind==='message.correction.begin') {
    const s=db.prepare('SELECT corrections FROM message_sources WHERE source_key=?').get(r.sourceKey)
    revoke(db,r,a.unitIds);r.correction={id:a.correctionId??randomUUID(),unitIds:a.unitIds??null,reason:a.reason,createdAt:now};r.revision++
    put(db,r.runId,'barrier',{id:'correction:'+r.correction.id,ownerRunId:r.runId,targetSourceKey:r.sourceKey,status:'pending',createdAt:now,reason:'correction',unitIds:r.correction.unitIds})
    db.prepare('UPDATE message_sources SET corrections=corrections+1 WHERE source_key=?').run(r.sourceKey)
    r.status='pending';save(db,r);return {result:{run:r}}
  }
  if(kind==='message.split'||kind==='message.correction.publish') {
    if(!Array.isArray(a.units)||!a.units.length)fail('MESSAGE_INVALID_UNITS')
    if(r.correction&&a.correctionId!==r.correction.id)fail('MESSAGE_CORRECTION_STALE')
    if(rows(db,r.runId,'unit').length&&!r.correction)fail('MESSAGE_SPLIT_ALREADY_PUBLISHED')
    const ids=a.units.map(u=>str(u.unitId));if(new Set(ids).size!==ids.length)fail('MESSAGE_INVALID_UNITS')
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
    if(a.unitId!=='$'&&get(db,'unit',a.unitId).blockedReason)fail('MESSAGE_NEEDS_ATTENTION')
    if(r.status==='needs_attention'&&(a.unitId==='$'||r.attentionScope!=='unit'))fail('MESSAGE_NEEDS_ATTENTION')
    if(!['S','R','I','IB','answer','material'].includes(a.nodeId))fail('MESSAGE_INVALID_NODE')
    if(a.unitId!=='$'&&get(db,'unit',a.unitId).runId!==r.runId)fail('MESSAGE_STALE')
    const executionStarted=messageExecutionStartedAt(r,rows(db,r.runId,'node'))
    const s=db.prepare('SELECT claims,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(r.sourceKey)
    const baseline=r.budgetBaseline??{claims:0,input_tokens:0,output_tokens:0}
    const deterministic=a.input?.deterministic===true
    if(deterministic&&(!a.input.inputHash||a.estimatedInputTokens!==0||a.maxOutputTokens!==0))fail('MESSAGE_INVALID_BUDGET')
    const reserve={input:a.estimatedInputTokens??0,output:a.maxOutputTokens??0};if(!Object.values(reserve).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET')
    const previous=rows(db,r.runId,'node').find(n=>n.unitId===a.unitId&&n.nodeId===a.nodeId&&n.revision===r.revision&&n.input?.topicInputRevision===a.input?.topicInputRevision&&n.input?.contextHash===a.input?.contextHash&&n.status!=='superseded')
    if(previous&&['running','succeeded','waiting'].includes(previous.status))fail('MESSAGE_NODE_NOT_READY')
    if(previous?.retryAt&&Date.parse(previous.retryAt)>Date.parse(now))fail('MESSAGE_RETRY_NOT_DUE')
    const n={id:previous?.id??randomUUID(),nodeRunId:previous?.id??null,runId:r.runId,unitId:a.unitId,nodeId:a.nodeId,revision:r.revision,leaseEpoch:(previous?.leaseEpoch??0)+1,status:'running',input:a.input,reservedTokens:reserve,createdAt:previous?.createdAt??now,startedAt:now};n.nodeRunId=n.id
    if(a.nodeId==='IB')topicRunsStatus(db,a.input.topicId,'intent_judging')
    db.prepare('UPDATE message_sources SET claims=claims+?,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(deterministic?0:1,reserve.input,reserve.output,r.sourceKey)
    const leaseWindowMs=a.leaseWindowMs
    if(!Number.isSafeInteger(leaseWindowMs)||leaseWindowMs<=0)fail('MESSAGE_INVALID_LEASE_WINDOW')
    n.leaseWindowMs=leaseWindowMs;n.deadline=new Date(Date.parse(now)+leaseWindowMs).toISOString()
    if(!deterministic){r.executionStartedAt=executionStarted??now;r.deadline=n.deadline;save(db,r)}
    put(db,r.runId,'node',n);return {result:{node:n}}
  }
  if(kind==='message.node.complete'||kind==='message.node.fail') {
    const n=get(db,'node',a.nodeRunId)
    if(n.runId!==r.runId||n.revision!==r.revision||n.leaseEpoch!==a.leaseEpoch||n.status!=='running')fail('MESSAGE_NODE_STALE')
    if(a.usage) { const used={input:a.usage.inputTokens,output:a.usage.outputTokens};if(!Object.values(used).every(x=>Number.isSafeInteger(x)&&x>=0))fail('MESSAGE_INVALID_BUDGET');db.prepare('UPDATE message_sources SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE source_key=?').run(used.input-n.reservedTokens.input,used.output-n.reservedTokens.output,r.sourceKey);n.usage=used }
    n.status=kind.endsWith('complete')?'succeeded':'failed';n.output=a.output??null;n.error=a.error??null;n.retryAt=a.retryAt??null;n.completedAt=now
    if(n.status==='succeeded'){save(db,r)}
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
    const pending=queryMessages(db,{kind:'message.routing.pending',conversationId:a.conversationId,topicId:a.topicId})
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
      reviseTopicFacts(db,r,a.topicId,decision.factRevisions,appliedFactRevisions,now)
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
    if(queryMessages(db,{kind:'message.routing.pending',conversationId:topic.conversationId,topicId:topic.topicId}).length
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
      ||queryMessages(db,{kind:'message.routing.pending',conversationId:r.conversationId,topicId:u.topicId}).length)fail('MESSAGE_TOPIC_STALE')
    for(const request of rows(db,r.runId,'request').filter(item=>item.unitId===u.id&&item.status==='pending')){request.status='superseded';request.reason='intent_rejudging';put(db,r.runId,'request',request)}
    topic.inputRevision++;topic.updatedAt=now
    db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(json(Object.fromEntries(Object.entries(topic).filter(([key])=>!['facts','hasMoreFacts'].includes(key)))),topic.topicId)
    u.status='pending';put(db,r.runId,'unit',u)
    r.status='pending';r.intentStatus='intent_rejudging';save(db,r)
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
    if(q.nodeId==='message-agent')fail('MESSAGE_AGENT_RESUME_REQUIRED')
    if(q.permittedActors?.length&&!q.permittedActors.includes(a.actorId)
      &&!(q.kind==='needs_clarification'&&a.ownerAnswer===true))fail('MESSAGE_ACTOR_FORBIDDEN')
    if(q.status!=='pending')return {result:{request:q,run:r}}
    q.status='resolved';q.answer=a.answer;q.eventId=str(a.eventId);q.resolvedAt=now;put(db,r.runId,'request',q)
    if(q.nodeId==='coordinator')delete r.coordinatorConsumed
    for(const n of rows(db,r.runId,'node')) if(n.unitId===q.unitId&&n.nodeId===q.nodeId&&n.revision===r.revision) {n.status='superseded';put(db,r.runId,'node',n)}
    r.status='pending';if(['S','R'].includes(q.nodeId))r.routingStatus='routing_pending';else r.intentStatus='intent_rejudging';save(db,r);return {result:{request:q,run:r}}
  }
  if(kind==='message.barrier.resolve') {
    const b=get(db,'barrier',a.barrierId);if(b.ownerRunId!==r.runId)fail('MESSAGE_BARRIER_OWNER');b.status='resolved';b.resolution=a.resolution;put(db,r.runId,'barrier',b);settle(db,r);return {result:{barrier:b}}
  }
  fail('MESSAGE_UNKNOWN_COMMAND')
}
export function queryMessages(db,a) {
  if(a.kind==='message.batch.cleanup.check')return inspectMessageBatchCleanup(db,a)
  if(a.kind==='message.coordinator')return coordinatorState(db,a.conversationId)
  if(a.kind==='message.agent.execution'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('agent-execution:'+str(a.commandId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.agent.executions')return rows(db,str(a.runId),'agent-execution')
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
  if(a.kind==='message.notification.diagnostics')return db.prepare("SELECT body FROM message_items WHERE kind='notification-diagnostic'").all().map(row=>JSON.parse(row.body)).filter(item=>(!a.runId||item.runId===a.runId)&&(!a.status||item.status===a.status))
  if(a.kind==='message.notification'){if(Boolean(a.notificationId)===Boolean(a.eventKey))fail('MESSAGE_NOTIFICATION_QUERY_INVALID');const row=a.eventKey?db.prepare("SELECT body FROM message_items WHERE kind='notification' AND json_extract(body,'$.eventKey')=? LIMIT 1").get(str(a.eventKey)):db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification:'+str(a.notificationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationOperation'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification-operation:'+str(a.operationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationReplacement'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('notification-replacement:'+str(a.replacementId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.notificationReplacements') {
    if(a.notificationIds !== undefined) {
      if(!Array.isArray(a.notificationIds) || a.notificationIds.length>200)fail('MESSAGE_NOTIFICATION_REPLACEMENTS_INVALID')
      const ids=a.notificationIds.map(str)
      return db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.restoresNotificationId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(JSON.stringify(ids)).map(row=>JSON.parse(row.body))
    }
    return db.prepare("SELECT body FROM message_items WHERE kind='notification-replacement' AND json_extract(body,'$.restoresNotificationId')=? ORDER BY rowid").all(str(a.notificationId)).map(row=>JSON.parse(row.body))
  }
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
  if(a.kind==='message.acceptances')return (a.runId?rows(db,a.runId,'acceptance'):db.prepare("SELECT body FROM message_items WHERE kind='acceptance' ORDER BY rowid").all().map(row=>JSON.parse(row.body)))
    .filter(fact=>db.prepare('SELECT requirement_revision FROM business_tasks WHERE task_id=?').get(fact.taskId)?.requirement_revision===fact.requirementRevision)
  if(a.kind==='message.task.inputs')return db.prepare(`SELECT DISTINCT r.body FROM message_topic_bindings b JOIN message_runs r ON r.run_id=b.run_id
    JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
    WHERE b.topic_id IN (SELECT b2.topic_id FROM message_items i JOIN message_topic_bindings b2 ON b2.unit_id=json_extract(i.body,'$.unitId')
      WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=?) AND json_extract(r.body,'$.status')!='superseded'
    ORDER BY r.rowid`).all(str(a.taskId)).map(row=>{const r=JSON.parse(row.body);return {sourceKey:r.sourceKey,sourceVersion:r.sourceVersion,actorId:r.actorId,body:r.body,runId:r.runId}})
  if(a.kind==='message.impact'){const r=run(db,a.runId);return {...impactCatalog(db,r),impact:rows(db,r.runId,'impact')[0]??null}}
  if(a.kind==='message.routing.pending')return db.prepare(`SELECT r.body FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
    WHERE json_extract(r.body,'$.conversationId')=? AND json_extract(r.body,'$.status') NOT IN ('buffered','alias','superseded')
    AND NOT (json_extract(r.body,'$.status')='settled' AND (json_extract(r.body,'$.reason')='message_quiet'
      OR (json_extract(r.body,'$.routingStatus')='routing_complete' AND json_extract(r.body,'$.intentStatus')='processed')))
    AND (NOT EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='unit')
      OR EXISTS (SELECT 1 FROM message_items i LEFT JOIN message_topic_bindings b ON b.unit_id=json_extract(i.body,'$.id')
        WHERE i.run_id=r.run_id AND i.kind='unit' AND json_extract(i.body,'$.status') NOT IN ('superseded','ignored','rejected','applied')
          AND (b.unit_id IS NULL OR json_extract(i.body,'$.blockedReason') IS NOT NULL)))
    ORDER BY r.rowid`).all(str(a.conversationId)).map(row=>JSON.parse(row.body)).filter(r=>!a.topicId||pendingAffectsTopic(db,r,a.topicId))
  if(a.kind==='message.task.version')return taskFactVersion(db,a.taskId)
  if(a.kind==='message.material'){const row=db.prepare('SELECT body FROM message_items WHERE item_id=?').get('material:'+json([str(a.runId),str(a.resourceRef)]));return row?JSON.parse(row.body).material:null}
  if(a.kind==='message.request')return get(db,'request',a.requestId)
  if(a.kind==='message.outboundByMessage') {
    const messageId=str(a.messageId),conversationId=str(a.conversationId)
    const row=db.prepare("SELECT i.body FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='notification' AND json_extract(r.body,'$.conversationId')=? AND (json_extract(i.body,'$.evidence.messageId')=? OR json_extract(i.body,'$.ack.messageId')=? OR json_extract(i.body,'$.ack.result.messageId')=?) LIMIT 1").get(conversationId,messageId,messageId,messageId)
    return row?JSON.parse(row.body):verifiedFileOutbound(db,conversationId,messageId)[0]??null
  }
  if(a.kind==='message.outboundIds') {
    const conversationId=str(a.conversationId)
    const notifications=db.prepare("SELECT json_extract(i.body,'$.evidence.messageId') AS message_id FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='notification' AND json_extract(r.body,'$.conversationId')=? AND json_extract(i.body,'$.evidence.messageId') IS NOT NULL").all(conversationId).map(row=>row.message_id)
    return [...new Set([...notifications,...verifiedFileOutbound(db,conversationId).map(item=>item.evidence.messageId)])]
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
    const scoped = (a.runId ? ' AND run_id=?' : '') + (a.sourceKey ? ' AND run_id IN (SELECT run_id FROM message_runs WHERE source_key=?)' : '') + (a.taskId ? " AND json_extract(body,'$.payload.fact.taskId')=?" : '')
    return db.prepare(`SELECT rowid AS seq,body FROM message_items WHERE kind='notification' AND rowid>? AND json_extract(body,'$.status') IN (SELECT value FROM json_each(?))${scoped} ORDER BY rowid LIMIT ?`)
      .all(after,json(states),...(a.runId?[str(a.runId)]:[]),...(a.sourceKey?[str(a.sourceKey)]:[]),...(a.taskId?[str(a.taskId)]:[]),limit).map(x=>({...JSON.parse(x.body),sequenceId:x.seq}))
  }
  if(a.kind==='message.group') {const row=db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(str(a.conversationId));return row?JSON.parse(row.body):null}
  if(a.kind==='message.task-candidates') {const limit=a.limit??30,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT');return db.prepare("SELECT i.rowid AS seq,r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen') AND json_type(i.body,'$.args.taskId')='text' AND length(json_extract(i.body,'$.args.taskId'))>0 AND json_extract(r.body,'$.conversationId')=? AND NOT EXISTS (SELECT 1 FROM execution_events e WHERE e.kind='task.delete' AND json_extract(e.payload,'$.taskId')=json_extract(i.body,'$.args.taskId')) AND i.rowid<? ORDER BY i.rowid DESC LIMIT ?").all(str(a.conversationId),before,limit).map(x=>({run:JSON.parse(x.run),command:JSON.parse(x.command),sequenceId:x.seq}))}
  if(a.kind==='message.list'||a.kind==='message.mailbox') {
    const limit=a.limit??30,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_INVALID_LIMIT')
    const sql=a.conversationId?"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND json_extract(body, '$.conversationId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?":"SELECT rowid AS seq,body FROM message_runs WHERE json_extract(body, '$.status')!='alias' AND rowid<? ORDER BY rowid DESC LIMIT ?"
    return db.prepare(sql).all(...(a.conversationId?[a.conversationId,before,limit]:[before,limit])).map(x=>{
      const source={...JSON.parse(x.body),sequenceId:x.seq}
      if(a.kind==='message.list')return source
      // 看板只读取业务状态；模型节点、执行输入和输出留在按需详情中。
      const units=db.prepare("SELECT json_extract(body,'$.unitId') AS unitId,json_extract(body,'$.id') AS id,json_extract(body,'$.goalText') AS goalText,json_extract(body,'$.blockedReason') AS blockedReason FROM message_items WHERE run_id=? AND kind='unit' AND json_type(body,'$.blockedReason')='text' ORDER BY rowid").all(source.runId)
      const requests=db.prepare("SELECT body FROM message_items WHERE run_id=? AND kind='request' AND json_extract(body,'$.status')='pending' ORDER BY rowid").all(source.runId).map(row=>JSON.parse(row.body))
      const commands=db.prepare("SELECT json_extract(body,'$.kind') AS kind,json_extract(body,'$.status') AS status,json_extract(body,'$.result') AS result FROM message_items WHERE run_id=? AND kind='command' AND json_extract(body,'$.kind')='answer' AND json_extract(body,'$.status')='applied' AND json_extract(body,'$.result.status')='blocked' ORDER BY rowid").all(source.runId).map(row=>({...row,result:JSON.parse(row.result)}))
      return {run:source,units,requests,commands,sequenceId:x.seq}
    })
  }
  if(a.kind==='message.task') {const row=db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen') ORDER BY i.rowid LIMIT 1").get(str(a.taskId));return row?{run:JSON.parse(row.run),command:JSON.parse(row.command)}:null}
  if(a.kind==='message.task.latest') {const row=db.prepare("SELECT r.body AS run,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? AND json_extract(i.body,'$.kind') IN ('create','research','answer','reopen','revise','pause','resume','cancel','confirm') AND json_extract(i.body,'$.status')='applied' ORDER BY i.rowid DESC LIMIT 1").get(str(a.taskId));return row?{run:JSON.parse(row.run),command:JSON.parse(row.command)}:null}
  if(a.kind==='message.echo.reconciliation')return echoReconciliation(db,run(db,a.runId))
  if(a.kind==='message.echo.unreconciled') {
    const limit=a.limit??100
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('MESSAGE_INVALID_LIMIT')
    return db.prepare(`SELECT r.body FROM message_runs r WHERE json_extract(r.body,'$.status')='superseded'
      AND json_extract(r.body,'$.reason')='outbound_echo' AND EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id
        AND ((i.kind='node' AND (json_extract(i.body,'$.status') IN ('running','waiting') OR (json_extract(i.body,'$.status')='failed' AND json_extract(i.body,'$.error')='process_interrupted')))
          OR (i.kind='barrier' AND json_extract(i.body,'$.status')='pending')))
      ORDER BY r.rowid LIMIT ?`).all(limit).map(row=>echoReconciliation(db,JSON.parse(row.body)))
  }
  if(a.kind==='message.owner.released-wait')return ownerReleasedWait(db,str(a.taskId))
  if(a.kind==='message.source.processing') {
    const currentRun=run(db,str(a.runId))
    current(db,currentRun)
    const versions=db.prepare('SELECT body FROM message_runs WHERE source_key=? ORDER BY source_version').all(currentRun.sourceKey).map(row=>{
      const source=JSON.parse(row.body)
      if(source.conversationId!==currentRun.conversationId||source.actorId!==currentRun.actorId)fail('MESSAGE_SOURCE_ACTOR_MISMATCH')
      return {runId:source.runId,sourceVersion:source.sourceVersion,status:source.status,commands:rows(db,source.runId,'command').map(command=>{
        const taskId=command.result?.taskId??command.args?.taskId??null
        const task=taskId?db.prepare('SELECT status FROM business_tasks WHERE task_id=?').get(taskId):null
        const deleted=Boolean(taskId&&db.prepare("SELECT 1 FROM execution_events WHERE kind='task.delete' AND json_extract(payload,'$.taskId')=? LIMIT 1").get(taskId))
        return {commandId:command.id,kind:command.kind,status:command.status,taskId,taskExists:Boolean(task),taskDeleted:deleted,taskStatus:task?.status??null}
      })}
    })
    return {authority:'current_persistent_backend',sourceKey:currentRun.sourceKey,currentSourceVersion:currentRun.sourceVersion,versions}
  }
  if(a.kind==='message.source') {const row=db.prepare('SELECT r.body FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=r.source_version WHERE r.source_key=?').get(str(a.sourceKey));return row?JSON.parse(row.body):null}
  if(a.kind==='message.pending')return db.prepare("SELECT r.body FROM message_runs r WHERE json_extract(r.body,'$.status') NOT IN ('settled','superseded','buffered','alias') OR (json_extract(r.body,'$.status')='settled' AND EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='barrier' AND json_extract(i.body,'$.status')='pending')) ORDER BY r.rowid").all().map(x=>JSON.parse(x.body))
  if(a.kind==='message.command')return get(db,'command',a.commandId)
  if(a.kind==='message.run') {const r=run(db,a.runId);return {run:r,notificationDiagnostics:rows(db,r.runId,'notification-diagnostic'),units:rows(db,r.runId,'unit'),nodes:rows(db,r.runId,'node'),commands:rows(db,r.runId,'command'),requests:rows(db,r.runId,'request'),executions:rows(db,r.runId,'agent-execution'),barriers:rows(db,r.runId,'barrier'),budget:db.prepare('SELECT claims,corrections,input_tokens,output_tokens FROM message_sources WHERE source_key=?').get(r.sourceKey)}}
  return undefined
}

/** 屏障直接保护执行控制账；创建命令须在 accept 时固定 args.taskId。 */
export function assertMessageTaskUnfenced(db,taskId,{allowRelatedProcessing=false,inputCommandId,ownerTurnId}={}) {
 const consuming=new Set(),consumingRuns=new Set(),consumingEvents=new Set()
 let acceptedWatermark=0
 const admit=command=>{
   const source=run(db,command.runId);current(db,source,command.revision)
   if(command.status!=='running'||command.args?.taskId!==taskId||!['revise','reopen','confirm','resume','pause','cancel','report'].includes(command.kind))fail('MESSAGE_INPUT_CONSUMPTION_INVALID')
   if(command.topicId&&queryMessageTopics(db,{kind:'message.topic',topicId:command.topicId})?.inputRevision!==command.topicInputRevision)fail('MESSAGE_INPUT_CONSUMPTION_STALE')
   consuming.add(command.id);consumingRuns.add(source.runId);consumingEvents.add('scope-'+digest([source.runId,source.sourceVersion,command.unitId,taskId]))
 }
 if(inputCommandId)admit(get(db,'command',inputCommandId))
 if(ownerTurnId){
   const turn=db.prepare(`SELECT t.*,o.input_fence_revision AS current_fence,o.authorization_revision AS current_authorization,o.lease_epoch AS current_lease FROM task_owner_turns t
     JOIN task_owners o ON o.task_id=t.task_id WHERE t.turn_id=? AND t.task_id=?`).get(ownerTurnId,taskId)
   if(!turn||!['running','candidate','accepted'].includes(turn.status)||turn.lease_epoch!==turn.current_lease
     ||turn.input_fence_revision!==turn.current_fence||turn.authorization_revision!==turn.current_authorization)fail('TASK_OWNER_CANDIDATE_STALE')
   if(turn.status==='accepted')acceptedWatermark=turn.event_watermark
   const events=new Set(db.prepare("SELECT event_key FROM task_events WHERE task_id=? AND event_type='source.related' AND seq<=?").all(taskId,turn.event_watermark).map(e=>e.event_key))
   for(const row of db.prepare("SELECT body FROM message_items WHERE kind='command' AND json_extract(body,'$.args.taskId')=? AND json_extract(body,'$.status')='running'").all(taskId)){
     const command=JSON.parse(row.body),source=run(db,command.runId)
     if(events.has('scope-'+digest([source.runId,source.sourceVersion,command.unitId,taskId])))admit(command)
   }
 }
 const unconsumed=db.prepare(`SELECT e.seq,e.event_key,e.handled_at,t.status,t.application_status FROM task_events e LEFT JOIN task_owner_turns t ON t.turn_id=e.turn_id
   WHERE e.task_id=? AND e.event_type='source.related' AND e.seq>COALESCE((SELECT MAX(event_watermark) FROM task_owner_turns
     WHERE task_id=e.task_id AND status='accepted' AND application_status='applied'),0)`).all(taskId)
   .filter(event=>!consumingEvents.has(event.event_key))
 if(unconsumed.length&&allowRelatedProcessing!=='owner'
   &&!(allowRelatedProcessing==='plan'&&unconsumed.every(event=>event.seq<=acceptedWatermark||event.handled_at&&event.status==='accepted')))fail('MESSAGE_INPUT_PENDING')
 const origins=db.prepare(`SELECT DISTINCT r.body,b.topic_id FROM message_items i JOIN message_runs r ON r.run_id=i.run_id
   LEFT JOIN message_topic_bindings b ON b.unit_id=json_extract(i.body,'$.unitId')
   WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=?`).all(taskId)
 for(const origin of origins){
   const source=JSON.parse(origin.body)
   if(!source.conversationId)continue
   if(origin.topic_id&&db.prepare(`SELECT 1 FROM message_topic_bindings b JOIN message_items i ON i.item_id='unit:'||b.unit_id
     JOIN message_runs r ON r.run_id=b.run_id WHERE b.topic_id=? AND json_extract(i.body,'$.status')='pending'
     AND json_extract(r.body,'$.status')!='superseded' LIMIT 1`).get(origin.topic_id))fail('MESSAGE_INPUT_PENDING')
   const pending=queryMessages(db,{kind:'message.routing.pending',conversationId:source.conversationId,topicId:origin.topic_id??undefined})
     .filter(candidate=>candidate.runId!==source.runId)
   if(pending.some(candidate=>{
     if(origin.topic_id)return true
     const scoped=rows(db,candidate.runId,'barrier').filter(b=>b.targetTaskId===taskId||b.targetSourceKey===source.sourceKey)
     return !scoped.length||scoped.some(b=>b.status==='pending')
   }))fail('MESSAGE_INPUT_PENDING')
 }
 if(db.prepare(`SELECT body FROM message_items WHERE kind='command' AND json_extract(body,'$.args.taskId')=?
   AND json_extract(body,'$.kind') IN ('revise','pause','cancel','resume')
   AND json_extract(body,'$.status') IN ('pending','running','unknown')`).all(taskId).some(row=>!consuming.has(JSON.parse(row.body).id)))fail('MESSAGE_INPUT_PENDING')
 const fences=db.prepare("SELECT body FROM message_items WHERE kind='barrier' AND json_extract(body,'$.status')='pending'").all().map(x=>JSON.parse(x.body))
 if(!fences.length)return
 const sources=db.prepare("SELECT r.source_key, json_extract(i.body,'$.unitId') AS unit_id FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=?").all(taskId)
 if(fences.some(b=>!consumingRuns.has(b.ownerRunId)&&(b.targetTaskId===taskId||sources.some(s=>s.source_key===b.targetSourceKey&&(!b.unitIds||b.unitIds.includes(s.unit_id))))))fail('MESSAGE_INPUT_PENDING')
}
