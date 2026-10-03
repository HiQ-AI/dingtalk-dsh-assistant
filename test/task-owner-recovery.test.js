import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'

test('Owner经真实恢复合同续行原Agent节点和会话，保留成功前缀与输入', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-agent-continuation-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.sqlite'), instanceId: 'owner-agent-continuation', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  let owner, prefixCalls = 0, finalCalls = 0
  const visits = []
  const agentSessions = { async close() {}, async cancel() {}, async run({ binding, input, recoveryContext, onSessionBound, onResult }) {
    await onSessionBound()
    visits.push({ binding, input, recoveryContext })
    if (visits.length === 1) await onResult({ ready: false, reason: '查询参数错误，需修正后继续' })
    else {
      assert.equal(recoveryContext.kind, 'execution-recovery-context')
      assert.equal(recoveryContext.nodeRunId, binding.nodeRunId)
      assert.equal(recoveryContext.strategy, '根据原始诊断修正查询参数并继续当前核验')
      await onResult({ ready: true, result: 7 })
    }
    return { status: 'submitted' }
  } }
  const object = { type: 'object' }
  const workflow = { id: 'review-inventory', version: '1', nodes: [
    { id: 'prepare', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: object, outputSchema: object,
      mapInput: ({ requirement }) => requirement, execute: async () => { prefixCalls++; return { prepared: true } } },
    { id: 'review', version: '1', executor: 'agent', allowedEffects: ['read'], allowedTools: [], provider: 'fixture', model: 'scripted', prompt: '核对当前库存',
      inputSchema: object, outputSchema: object, mapInput: ({ previousOutput }) => previousOutput,
      admitOutput: ({ output }) => output.ready ? { outcome: 'succeeded' } : { outcome: 'failed', waitReason: { kind: 'recovery', reference: 'AGENT_WORK_BLOCKED' } } },
    { id: 'finish', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: object, outputSchema: object,
      mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => { finalCalls++; return input } },
  ] }
  const controller = createExecutionController({ store, artifacts, workflows: [workflow], sessions: agentSessions })
  t.after(async () => { await owner?.close(); await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: workflow.id, input: { request: '核对库存' } }] })
  const started = await controller.advanceTaskPlan('task'), runId = started.stages[0].runId
  const failed = await controller.whenIdle(runId)
  await controller.advanceTaskPlan('task')
  assert.equal((await controller.taskPlan('task')).stages[0].status, 'blocked')
  const helpers = createTaskWorkflowContracts({ controller, store, artifacts })
  owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller, modelConfig: () => ({}),
    advanceTask: async () => {}, authorizeStages: async () => false,
    inspectCurrentExecution: helpers.inspectCurrentExecution, repairCurrentStage: helpers.repairCurrentStage,
    sessionRunner: { async close() {}, async run({ input, readArtifact, onSessionBound, onCandidate }) {
      await onSessionBound()
      assert.equal(input.currentExecution.repairable, true)
      for (const ref of input.currentExecution.evidenceRefs) await readArtifact(ref)
      const decision = { action: 'repairCurrentStage', summary: '根据原始诊断修正查询参数并继续当前核验',
        repair: input.currentExecution.repairBinding, evidenceRefs: input.currentExecution.evidenceRefs }
      await onCandidate(decision); return { status: 'submitted', decision }
    } } })
  await owner.ensure({ taskId: 'task', criteria: ['核对库存'], sourceKey: 'source', origin: {} })
  await owner.observe('task'); await owner.drive('task')
  assert.deepEqual(await owner.applyPending(), [])
  const resumed = await controller.whenIdle(runId)
  assert.equal(resumed.run.status, 'succeeded')
  assert.equal(resumed.run.generation, failed.run.generation)
  assert.equal(prefixCalls, 1); assert.equal(finalCalls, 1); assert.equal(visits.length, 2)
  for (const field of ['sessionId', 'nodeRunId', 'generation', 'inputDigest']) assert.equal(visits[1].binding[field], visits[0].binding[field], field)
  assert.ok(visits[1].binding.leaseEpoch > visits[0].binding.leaseEpoch)
  assert.deepEqual(visits[1].input, visits[0].input)
  assert.equal(resumed.nodes[0].outputRef, failed.nodes[0].outputRef)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).decision.action, 'repairCurrentStage')
})

for (const repairable of [true, false]) test(`Owner读取诊断后推进可恢复问题，真实外部等待仍可保留：${repairable}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-continuation-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.sqlite'), instanceId: 'continuation', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workflow = { id: 'inspect', version: '1', nodes: [{ id: 'read', version: '1', executor: 'code', allowedEffects: ['read'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement,
    execute: async () => { if (repairable) return { parameter: 'column', reason: 'QUERY_PARAMETER_INVALID' }
      throw Object.assign(Error('等待真人审批'), { code: 'PLUGIN_APPROVAL_PENDING', evidence: [{ approval: 'pending' }] }) },
    ...(repairable ? { admitOutput: () => ({ outcome: 'failed', waitReason: { kind: 'recovery', reference: 'QUERY_PARAMETER_INVALID' } }) } : {}) }] }
  const controller = createExecutionController({ store, artifacts, workflows: [workflow] })
  let owner, repairCalls = 0
  t.after(async () => { await owner?.close(); await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: 'inspect', input: { request: '读取当前表' } }] })
  const started = await controller.advanceTaskPlan('task'), runId = started.stages[0].runId
  const state = await controller.whenIdle(runId)
  const failedPlan = await controller.advanceTaskPlan('task')
  assert.equal(failedPlan.stages[0].status, repairable ? 'blocked' : 'running')
  const evidenceRefs = state.nodes[0].evidenceRefs
  assert.ok(evidenceRefs.length)
  let observedReason = repairable ? 'QUERY_PARAMETER_INVALID' : 'PLUGIN_APPROVAL_PENDING'
  const inspectCurrentExecution = async () => ({ stageId: 'first', runId, mode: 'resume-agent', repairable, reason: observedReason, evidenceRefs,
    nodeRunId: state.nodes[0].nodeRunId, generation: state.run.generation, leaseEpoch: state.nodes[0].leaseEpoch, inputDigest: state.nodes[0].inputDigest,
    repairBinding: { stageId: 'first', runId, generation: state.run.generation, runRevision: state.run.revision, requirementRevision: 1 } })
  owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller,
    modelConfig: () => ({}), advanceTask: async () => {}, authorizeStages: async () => false, inspectCurrentExecution,
    repairCurrentStage: async () => { repairCalls++ },
    sessionRunner: { async close() {}, async run({ input, readArtifact, onSessionBound, onCandidate }) {
      await onSessionBound()
      const waiting = action => ({ action, summary: '等待当前必要条件', evidenceRefs,
        condition: { kind: 'approval', missing: '真人批准', responsibleParty: '审批人', resumeWhen: '插件审批结果到达', evidenceRefs } })
      if (!repairable) { const decision = waiting('wait'); await onCandidate(decision); return { status: 'submitted', decision } }
      for (const action of ['wait', 'block']) await assert.rejects(onCandidate(waiting(action)), { code: 'TASK_OWNER_RECOVERY_AVAILABLE' })
      const decision = { action: 'repairCurrentStage', summary: '读取错误并修正查询参数', evidenceRefs, repair: input.currentExecution.repairBinding }
      await assert.rejects(onCandidate(decision), { code: 'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD' })
      await readArtifact(state.nodes[0].outputRef)
      await assert.rejects(onCandidate({ ...decision, evidenceRefs: [state.nodes[0].outputRef] }), { code: 'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD' })
      for (const ref of evidenceRefs) await readArtifact(ref)
      await onCandidate(decision)
      return { status: 'submitted', decision }
    } } })
  await owner.ensure({ taskId: 'task', criteria: ['读取当前表'], sourceKey: 'source', origin: {} })
  await owner.observe('task')
  const before = await store.query({ kind: 'task.owner', taskId: 'task' })
  await owner.observe('task')
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).eventWatermark, before.eventWatermark)
  await owner.drive('task')
  assert.deepEqual(await owner.applyPending(), [])
  assert.equal(repairCalls, repairable ? 1 : 0)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).decision.action, repairable ? 'repairCurrentStage' : 'wait')
  observedReason = 'NEW_DIAGNOSTIC'
  await owner.observe('task')
  const changed = await store.query({ kind: 'task.owner', taskId: 'task' })
  assert.ok(changed.eventWatermark > before.eventWatermark)
  await owner.observe('task')
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).eventWatermark, changed.eventWatermark)
})

// 使用完整原生 Store 和持久文件，覆盖维护命令、事务 CAS 与重启；不连接外部服务。
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'owner-completion-recovery-'))
  const dbPath = join(directory, 'control.sqlite'), instanceId = 'recovery-test'
  const stores = [], controllers = []
  const open = async initialize => {
    const store = await openExecutionStore({ dbPath, instanceId, ...(initialize ? { initialize: true } : {}) })
    stores.push(store); return store
  }
  let store = await open(true)
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workflow = { id: 'historical', version: '1', nodes: [{ id: 'calculate', version: '1', executor: 'code',
    allowedEffects: ['pure'], inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
    mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input + 1 }] }
  const controller = createExecutionController({ store, artifacts, workflows: [workflow] }); controllers.push(controller)
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller,
    modelConfig: () => ({}), advanceTask: async () => {}, authorizeStages: async () => false,
    sessionRunner: { async run() { throw new Error('历史完成任务不应重新调用模型') }, async close() {} } })
  t.after(async () => { await owner.close(); for (const c of controllers) await c.close(); for (const s of stores) await s.close() })
  const send = async (kind, args, id = randomUUID()) => (await store.command({ id, kind, args })).result
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'one', workflowId: workflow.id, input: 1 }] })
  await owner.ensure({ taskId: 'task', criteria: ['结果为2'], sourceKey: 'source', origin: {} })
  const running = await controller.advanceTaskPlan('task')
  await controller.whenIdle(running.stages[0].runId)
  const plan = await controller.advanceTaskPlan('task'), stage = plan.stages[0]
  const payload = { taskId: 'task', planRevision: 1, stageId: stage.stageId, workflowId: stage.workflowId,
    status: stage.status, runId: stage.runId, outputRef: stage.outputRef, evidenceRefs: stage.evidenceRefs }
  const payloadRef = (await artifacts.put(payload)).ref
  const digest = value => createHash('sha256').update(JSON.stringify([value])).digest('hex').slice(0, 40)
  const eventKey = `stage-${digest(['task', 1, stage.stageId, stage.status])}`
  await send('task.owner.event', { taskId: 'task', eventKey, eventType: 'workflow.succeeded', payloadRef }, `owner-event:${eventKey}`)
  const claim = await send('task.owner.claim', { taskId: 'task', turnId: 'complete', expectedLeaseEpoch: 0 })
  await send('task.owner.sessionBound', { taskId: 'task', turnId: 'complete', leaseEpoch: claim.leaseEpoch, sessionId: claim.sessionId })
  await send('task.owner.candidate', { taskId: 'task', turnId: 'complete', leaseEpoch: claim.leaseEpoch,
    decision: { action: 'complete', summary: '已有完成证明', evidenceRefs: [stage.outputRef],
      assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: [stage.outputRef] }] } })
  await send('task.owner.accept', { taskId: 'task', turnId: 'complete', leaseEpoch: claim.leaseEpoch })
  await send('task.owner.applied', { taskId: 'task', turnId: 'complete', leaseEpoch: claim.leaseEpoch })
  const before = await store.query({ kind: 'task.owner', taskId: 'task' })
  const duplicate = () => send('task.owner.event', { taskId: 'task', eventKey: `stage-${digest(payload)}`,
    eventType: 'workflow.succeeded', payloadRef })
  const maintain = () => send('runtime.maintenance.change', { active: true, expectedRevision: 0,
    maintenanceId: 'repair-observations', actorId: 'owner', reason: '验证重复观察恢复' })
  const reopen = async mutate => {
    await owner.close(); await controller.close(); await store.close()
    if (mutate) { const db = new DatabaseSync(dbPath); try { mutate(db) } finally { db.close() } }
    store = await open(false)
  }
  return { owner, before, send, duplicate, maintain, reopen, dbPath,
    get store() { return store }, async proof() { return store.query({ kind: 'task.owner.completed-observations', taskId: 'task' }) } }
}
const recoveryArgs = proof => Object.fromEntries(['taskId', 'completeTurnId', 'expectedOwnerRevision', 'expectedEventWatermark',
  'maintenanceId', 'expectedMaintenanceRevision', 'actorId'].map(key => [key, proof[key]]).concat([['reason', '恢复稳定身份升级产生的重复成功事件']]))

test('历史成功阶段观察沿用旧事件身份，不唤醒已完成Owner', async t => {
  const f = await fixture(t)
  await f.owner.observe('task'); await f.owner.observe('task')
  assert.deepEqual(await f.store.query({ kind: 'task.owner', taskId: 'task' }), f.before)
  assert.deepEqual(await f.owner.recover(), [])
})

test('原生维护恢复仅处理重复观察，重启保留原complete及错误回合与事件', async t => {
  const f = await fixture(t)
  const duplicate = await f.duplicate()
  const claim = await f.send('task.owner.claim', { taskId: 'task', turnId: 'misawakened', expectedLeaseEpoch: 1 })
  await f.send('task.owner.release', { taskId: 'task', turnId: 'misawakened', leaseEpoch: claim.leaseEpoch, reason: 'WORKFLOW_OWNER_CONTRACT_UNAVAILABLE' })
  await assert.rejects(f.proof(), { code: 'TASK_OWNER_RECOVERY_REQUIRES_MAINTENANCE' })
  await f.maintain()
  const proof = await f.proof(), args = recoveryArgs(proof)
  assert.deepEqual(proof.duplicateEventSequences, [duplicate.eventSeq])
  for (const changed of [{ expectedOwnerRevision: 0 }, { expectedEventWatermark: 0 }, { expectedMaintenanceRevision: 0 },
    { completeTurnId: 'other' }, { maintenanceId: 'other' }, { actorId: 'other' }]) {
    await assert.rejects(f.send('task.owner.reconcile-completed-observations', { ...args, ...changed }), { code: 'TASK_OWNER_RECOVERY_STALE' })
  }
  const result = await f.send('task.owner.reconcile-completed-observations', args, 'recovery')
  assert.equal(result.status, 'reconciled')
  assert.equal((await f.send('task.owner.reconcile-completed-observations', args, 'recovery')).status, 'reconciled')
  await f.reopen()
  const after = await f.store.query({ kind: 'task.owner', taskId: 'task' })
  assert.equal(after.status, 'idle'); assert.equal(after.eventWatermark, after.processedWatermark)
  assert.deepEqual(after.decision, f.before.decision)
  const db = new DatabaseSync(f.dbPath, { readOnly: true })
  try {
    assert.equal(db.prepare("SELECT status FROM task_owner_turns WHERE turn_id='misawakened'").get().status, 'released')
    assert.equal(db.prepare('SELECT turn_id FROM task_events WHERE seq=?').get(duplicate.eventSeq).turn_id, 'complete')
    assert.equal(db.prepare("SELECT count(*) n FROM task_owner_turns WHERE status='accepted'").get().n, 1)
    assert.equal(db.prepare("SELECT count(*) n FROM execution_events WHERE kind='task.owner.reconcile-completed-observations'").get().n, 1)
  } finally { db.close() }
})

const unsafe = [
  ['新业务事件', db => db.prepare("UPDATE task_events SET event_type='intent.received' WHERE seq=(SELECT max(seq) FROM task_events)").run(), 'TASK_OWNER_RECOVERY_EVENT_CHANGED'],
  ['不同产出', db => db.prepare("UPDATE task_events SET payload_ref='sha256-different.json' WHERE seq=(SELECT max(seq) FROM task_events)").run(), 'TASK_OWNER_RECOVERY_EVENT_CHANGED'],
  ['权限变化', db => db.prepare('UPDATE task_owners SET authorization_revision=authorization_revision+1').run(), 'TASK_OWNER_RECOVERY_COMPLETION_CHANGED'],
  ['要求变化', db => db.prepare('UPDATE business_tasks SET requirement_revision=requirement_revision+1').run(), 'TASK_OWNER_RECOVERY_COMPLETION_CHANGED'],
  ['计划变化', db => { db.prepare('UPDATE business_tasks SET plan_revision=plan_revision+1').run(); db.prepare('UPDATE task_plan_stages SET plan_revision=plan_revision+1').run() }, 'TASK_OWNER_RECOVERY_COMPLETION_CHANGED'],
  ['新业务执行', db => db.prepare("UPDATE execution_runs SET updated_at='2099-01-01T00:00:00.000Z'").run(), 'TASK_OWNER_RECOVERY_EXECUTION_CHANGED'],
  ['节点未排空', db => db.prepare('UPDATE execution_nodes SET drained=0').run(), 'TASK_OWNER_RECOVERY_REQUIRES_MAINTENANCE'],
  ['阶段未成功', db => db.prepare("UPDATE task_plan_stages SET status='blocked'").run(), 'TASK_OWNER_RECOVERY_STAGE_CHANGED'],
  ['原完成证明未应用', db => db.prepare("UPDATE task_owner_turns SET application_status='pending' WHERE turn_id='complete'").run(), 'TASK_OWNER_RECOVERY_COMPLETION_CHANGED'],
  ['完成后接纳业务决定', db => db.exec(`INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,
    requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,
    decision_json,status,application_status,created_at,updated_at)
    SELECT 'new-action',task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,
    authorization_revision,input_fence_revision,'{"action":"advance"}','accepted','applied',created_at,updated_at
    FROM task_owner_turns WHERE turn_id='complete'`), 'TASK_OWNER_RECOVERY_COMPLETION_CHANGED'],
  ['不确定外部效果', db => db.exec(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,
    definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at)
    SELECT 'unknown','operation',run_id,node_run_id,node_id,generation,input_digest,input_digest,'{}','[]','authorized','unknown',
    '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM execution_nodes LIMIT 1`), 'TASK_OWNER_RECOVERY_REQUIRES_MAINTENANCE'],
]
for (const [name, mutate, code] of unsafe) test(`完成观察恢复拒绝${name}`, async t => {
  const f = await fixture(t); await f.duplicate(); await f.maintain(); await f.reopen(mutate)
  await assert.rejects(f.proof(), { code })
})

test('新Task首轮输入不把未建立计划误判为需求过期，同turn纠正后接纳initialize',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'owner-initial-plan-'))
 const store=await openExecutionStore({dbPath:join(directory,'control.sqlite'),instanceId:'initial',initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true})
 const controller=createExecutionController({store,artifacts,workflows:[]})
 let owner
 t.after(async()=>{await owner?.close();await controller.close();await store.close()})
 const requirementRef=(await artifacts.put({request:'调查',acceptanceCriteria:['核实事实']})).ref
 await store.command({id:'accept',kind:'task.accept',args:{taskId:'initial',requirementRef,requirementRevision:1,sessionId:'initial-session',criteria:['核实事实'],sourceKey:'source',eventKey:'created'}})
 owner=createTaskOwnerController({ctx:{},store,artifacts,controller,advanceTask:async()=>{},modelConfig:()=>({}),authorizeStages:async()=>true,sessionRunner:{async close(){},async run({input,onSessionBound,onCandidate}){
  assert.equal(input.task.planRevision,0);assert.equal(input.stages.length,0);assert.equal(input.planReview,undefined)
  await onSessionBound()
  await assert.rejects(onCandidate({action:'advance',summary:'调查',evidenceRefs:[],planChange:{kind:'replaceSuffix',affectedFrom:0,stages:[{workflowId:'task-investigation',gate:'none'}]}}),{code:'TASK_OWNER_ADVANCE_CONFLICT'})
  const decision={action:'advance',summary:'调查',evidenceRefs:[],planChange:{kind:'initialize',stages:[{workflowId:'task-investigation',gate:'none'}]}}
  await onCandidate(decision);return {status:'submitted',decision}
 }}})
 await owner.drive('initial')
 const state=await store.query({kind:'task.owner',taskId:'initial'})
 assert.equal(state.failureCount,0)
 const actions=await store.query({kind:'task.owner.actions.pending'})
 assert.equal(actions.length,1);assert.equal(actions[0].decision.planChange.kind,'initialize')
})


for (const barrier of ['future-retry', 'pending-message']) test(`真实控制账Owner派发不空转且原恢复可继续：${barrier}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-dispatch-barrier-'))
  const dbPath = join(directory, 'control.sqlite')
  const store = await openExecutionStore({ dbPath, instanceId: 'dispatch-barrier', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [] })
  let owner, calls = 0, scans = 0, claims = 0
  t.after(async () => { await owner?.close(); await controller.close(); await store.close() })
  const command = (kind, args) => store.command({ id: randomUUID(), kind, args })
  const receive = id => command('message.receive', { runId: id, sourceKey: id, sourceVersion: 1,
    conversationId: 'group', actorId: 'actor', body: `来源 ${id}` })
  await receive('origin')
  await command('message.split', { runId: 'origin', units: [{ unitId: 'origin-unit' }] })
  await command('message.topic.bind', { runId: 'origin', unitId: 'origin-unit', expectedRevision: 0,
    binding: { type: 'topic' }, topic: { topicId: 'topic', conversationId: 'group', sourceRunId: 'origin',
      unitId: 'origin-unit', title: '原任务', facts: [] } })
  await command('message.topic.intent.accept', { runId: 'origin', topicId: 'topic', conversationId: 'group', inputRevision: 1,
    decisions: [{ unitId: 'origin-unit', expectedRevision: 0, commands: [{ commandId: 'create', kind: 'create', args: { taskId: 'task' } }] }] })
  const requirementRef = (await artifacts.put({ request: '调查原任务', acceptanceCriteria: ['确认事实'] })).ref
  await command('task.accept', { taskId: 'task', requirementRef, requirementRevision: 1,
    sessionId: 'session', criteria: ['确认事实'], sourceKey: 'origin', eventKey: 'created' })
  if (barrier === 'future-retry') {
    await command('task.owner.claim', { taskId: 'task', turnId: 'failed', expectedLeaseEpoch: 0 })
    await command('task.owner.release', { taskId: 'task', turnId: 'failed', leaseEpoch: 1, reason: 'ETIMEDOUT' })
    assert.ok(Date.parse((await store.query({ kind: 'task.owner', taskId: 'task' })).retryAt) > Date.now())
  } else await receive('new-input')
  // 仅计量实际控制账调用，所有查询及命令仍原样进入SQLite事务。
  const observedStore = { query: request => {
    if (request.kind === 'task.owners.pending') scans++
    return store.query(request)
  }, command: request => {
    if (request.kind === 'task.owner.claim') claims++
    return store.command(request)
  } }
  owner = createTaskOwnerController({ ctx: {}, store: observedStore, artifacts, controller,
    advanceTask: async () => {}, authorizeStages: async () => false, modelConfig: () => ({}), sessionRunner: { async close() {}, async run({ onSessionBound, onCandidate }) {
      calls++; await onSessionBound()
      const decision = { action: 'wait', summary: '等待真实业务选择', evidenceRefs: [], condition: {
        kind: 'business-input', missing: '选择方案', responsibleParty: '交办人', resumeWhen: '确认后继续', evidenceRefs: [] } }
      await onCandidate(decision); return { status: 'submitted', decision }
    } } })
  await owner.recover()
  const before = { scans, claims }
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual({ scans, claims }, before)
  assert.equal(calls, 0); assert.equal(scans, 1)
  assert.equal(claims, barrier === 'future-retry' ? 0 : 1)
  if (barrier === 'future-retry') {
    const db = new DatabaseSync(dbPath)
    try { db.prepare("UPDATE task_owners SET updated_at=? WHERE task_id='task'").run(new Date(Date.now() - 2000).toISOString()) }
    finally { db.close() }
  } else {
    const impact = await store.query({ kind: 'message.impact', runId: 'new-input' })
    const source = (await store.query({ kind: 'message.run', runId: 'new-input' })).run
    await command('message.impact.resolve', { runId: 'new-input', expectedRevision: source.revision,
      unitId: '$', catalogRevision: impact.catalogRevision, assessments: [{ topicId: 'topic', relation: 'independent',
        reason: '核对对象与原任务不同', sourceRefs: [{ sourceKey: 'new-input', sourceVersion: 1, text: source.body }] }] })
  }
  await owner.recover()
  assert.equal(calls, 1)
  const state = await store.query({ kind: 'task.owner', taskId: 'task' })
  assert.equal(state.decision.action, 'wait'); assert.equal(state.applicationStatus, 'applied')
  assert.equal(state.sessionId, 'session')
})
