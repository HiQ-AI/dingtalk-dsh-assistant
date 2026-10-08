import { startDwsBridge } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { isBusinessTaskTerminal } from '../packages/dingtalk-dsh-assistant/message-ledger.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { createTaskDirectoryResolver } from '../packages/dingtalk-dsh-assistant/execution.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createEngineeringRegistry, engineeringWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { readOnlyWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/task-readonly-workflows.js'
import { externalWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { createTaskMarkdownFileAdapter } from '../packages/dingtalk-dsh-assistant/task-markdown-file.js'
import { createGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'

for (const version of ['4', '5', '6', '7', '8', '9']) for (const control of ['cancelled', 'complete', 'active', 'paused']) test(`Host拒绝恢复已退役调查v${version}，仅保留终态历史：${control}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'retired-owner-control-'))
  const model = { provider: 'fixture', model: 'fixture' }
  const config = { groupIds: ['group'], ownerActorId: 'owner', instanceId: 'retired-owner-control',
    dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts') }
  const store = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: config.artifactDirectory, initialize: true })
  const historical = { id: 'task-investigation', version, nodes: [{ id: 'historical', version: '1',
    executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    mapInput: ({ requirement }) => requirement, execute: async () => {
      if (control === 'complete') return { summary: '历史调查已完成' }
      throw Error('RETIRED_EXECUTION_FORBIDDEN')
    } }] }
  const definition = defineExecutionWorkflow(historical)
  const controller = createExecutionController({ store, artifacts, workflows: [historical] })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.command({ id: 'register-retired', kind: 'workflow.register', args: {
    workflowId: historical.id, definitionVersion: historical.version, digest: definition.digest, config: model } })
  await controller.createTaskPlan({ commandId: 'retired-plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: historical.id, input: {} }] })
  await store.command({ id: 'retired-owner', kind: 'task.owner.init', args: {
    taskId: 'task', sessionId: 'retired-owner', sourceKey: 'source', criteria: ['历史调查'] } })
  if (control === 'complete') {
    let plan = await controller.advanceTaskPlan('task')
    await controller.whenIdle(plan.stages[0].runId)
    plan = await controller.advanceTaskPlan('task')
    const evidenceRef = plan.stages[0].outputRef
    const lease = { taskId: 'task', turnId: 'historical-complete', leaseEpoch: 1 }
    for (const [kind, args] of [
      ['event', { taskId: 'task', eventKey: 'historical-finished', eventType: 'workflow.succeeded' }],
      ['claim', { taskId: 'task', turnId: lease.turnId, expectedLeaseEpoch: 0 }],
      ['sessionBound', { ...lease, sessionId: 'retired-owner' }],
      ['candidate', { ...lease, decision: { action: 'complete', summary: '历史调查已完成', evidenceRefs: [evidenceRef],
        assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: [evidenceRef] }] } }],
      ['accept', lease], ['applied', lease],
    ]) await store.command({ id: `complete-${kind}`, kind: `task.owner.${kind}`, args })
  } else if (control !== 'active') {
    const plan = await controller.taskPlan('task')
    await controller.controlTask({ commandId: 'retired-control', taskId: 'task', intent: control === 'cancelled' ? 'cancel' : 'pause',
      expectedControlRevision: plan.task.controlRevision })
  }
  const before = await controller.taskPlan('task')
  assert.equal(before.task.controlState, control === 'complete' ? 'active' : control)
  await controller.close(); await store.close()
  const open = () => openWorkflowService({ ctx: {}, config, legacy: { getAgentConfig: () => model },
    judge: async () => { throw Error('UNEXPECTED_MODEL') }, taskOwnerSessions: { async close() {} } })
  if (!['cancelled', 'complete'].includes(control)) {
    await assert.rejects(open(), { code: control === 'active' ? 'WORKFLOW_CUTOVER_ACTIVE_REFERENCES' : 'WORKFLOW_VERSION_UNAVAILABLE' })
    const unchanged = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId })
    try { assert.deepEqual(await unchanged.query({ kind: 'task.plan', taskId: 'task' }), before) }
    finally { await unchanged.close() }
    return
  }
  service = await open()
  assert.deepEqual(await service.execution.controller.taskPlan('task'), before)
  const saved = (await service.execution.store.query({ kind: 'workflow.list' })).find(item => item.digest === definition.digest)
  assert.equal(saved.definitionVersion, version); assert.deepEqual(saved.config, model)
  assert.throws(() => service.execution.controller.workflowDefinition(historical.id), { code: 'WORKFLOW_NOT_FOUND' })
  assert.throws(() => service.execution.controller.workflowDefinition(historical.id, definition.digest), { code: 'WORKFLOW_VERSION_UNAVAILABLE' })
})
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability } from '../packages/dingtalk-dsh-assistant/task-artifact-write.js'
import { createSourceDossierCapability, createTaskMessageResourceCapability, isDirectedTaskRequest, openWorkflowService,
  rankMessageCandidates, verifyDefaultGeneralCompletion, describeTaskNodeOutput } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { messageSchemas, taskWorkflowCatalog, candidateCards } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { createWorkflowNotifications, formatGroupReply, notificationOpenTaskId, sameDeliveredText, sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import { queryConversationTaskProgress } from '../packages/dingtalk-dsh-assistant/task-progress-query.js'
import { groupTaskExecutions } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { createInvestigationWorkflow } from '../packages/dingtalk-dsh-assistant/agent-work.js'
import { createDataChangeTaskWorkflowV6 } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'
import { createNativeDataChangeCompletionPolicy } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'

const schema = { type: 'object', additionalProperties: true }
const splitOne = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] })
const coordinatorQuestion = (source, value) => ({ kind: 'needs_clarification', reason: 'target_conflict',
  question: value.question ?? value.reason, missingField: value.reason, blockedAction: '确定本次事项', checkedSourceRefs: [source.sourceKey] })

test('数据变更升级v7后重启保留v6冻结定义和旧计划', async t => {
  const root = await mkdtemp(join(tmpdir(), 'data-change-v6-restore-'))
  const config = { groupIds: ['g'], ownerActorId: 'owner', dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts'), instanceId: 'data-change-restore' }
  const initial = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true }); await initial.close()
  await mkdir(config.artifactDirectory)
  const unexpected = async () => { throw Error('EXTERNAL_EFFECT_NOT_EXPECTED') }
  const adapter = { id: 'restore-data-change', version: '1', rulesDigest: 'a'.repeat(64), pluginApproval: true,
    validate: unexpected, validateExistingIssue: unexpected, readBaselineForCandidate: unexpected, prepareRehearsal: unexpected, readbackRehearsal: unexpected,
    inspect: unexpected, prepareIssue: unexpected, prepareApproval: unexpected, prepareExecute: unexpected, readback: unexpected }
  const external = { dataChangeAdapter: adapter, operationAdapter: { execute: unexpected, reconcile: unexpected }, authorizeExternal: unexpected, prepareRequirement: unexpected }
  const open = () => openWorkflowService({ ctx: {}, config, external, legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }) }, taskOwnerSessions: { async close() {} } })
  let service = await open(), oldController, oldStore
  t.after(async () => { await oldController?.close(); await oldStore?.close(); await service?.close(); await rm(root, { recursive: true, force: true }) })
  const saved = (await service.execution.store.query({ kind: 'workflow.list' })).find(item => item.workflowId === 'task-data-change' && item.definitionVersion === '7')
  assert.ok(saved)
  await service.close()
  oldStore = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId })
  const artifacts = await openExecutionArtifacts({ directory: config.artifactDirectory })
  const prior = { ...createDataChangeTaskWorkflowV6({ ...saved.config.modelConfig, adapter }), ownerContract: createNativeDataChangeCompletionPolicy(adapter) }
  const definition = defineExecutionWorkflow(prior)
  oldController = createExecutionController({ store: oldStore, artifacts, delivery: { execute: unexpected }, workflows: [prior] })
  await oldStore.command({ id: 'register-v6', kind: 'workflow.register', args: { workflowId: prior.id, definitionVersion: prior.version, config: { ...saved.config, ownerContractVersion: '4' }, digest: definition.digest } })
  await oldController.createTaskPlan({ commandId: 'old-plan', taskId: 'old-task', stages: [{ stageId: 'change', workflowId: prior.id,
    input: { request: '旧加列变更', constraints: [], target: { instance: 'instance', database: 'editor', environment: 'production' },
      sources: [{ id: 'original', content: '旧加列变更', sha256: createHash('sha256').update('旧加列变更').digest('hex') }] } }] })
  const before = await oldController.taskPlan('old-task')
  await oldController.close(); await oldStore.close(); service = await open()
  assert.deepEqual(await service.execution.controller.taskPlan('old-task'), before)
  assert.equal(service.execution.controller.workflowDefinition(prior.id, definition.digest).version, '6')
  assert.equal(service.execution.controller.workflowDefinition(prior.id).version, '7')
})

test('维护HTTP仅受信本机身份可改，严格参数、幂等与过期许可均校验', async t => {
  const { service } = await fixture(t,'owner',undefined,{config:{webActorId:'owner'}})
  const runtime={getWorkflowMaintenance:()=>service.maintenance(),changeWorkflowMaintenance:request=>service.changeMaintenance(request,{channel:'web',actorId:'owner'}),
    sealWorkflowMaintenance:request=>service.changeMaintenance(request,{channel:'web',actorId:'owner'},'seal'),resumeWorkflowMaintenance:request=>service.changeMaintenance(request,{channel:'web',actorId:'owner'},'resume')}
  const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const url=`http://127.0.0.1:${server.address().port}/runtime/maintenance`
  const body={requestId:'enter',active:true,expectedRevision:0,maintenanceId:'deploy',reason:'验证维护部署'}
  const post=(value,origin='http://127.0.0.1:3080')=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)})
  assert.equal((await post(body,'https://evil.invalid')).status,403)
  assert.equal((await post({...body,actorId:'owner'})).status,400)
  await assert.rejects(service.changeMaintenance(body,{channel:'web',actorId:'other'}),/FORBIDDEN/)
  assert.equal((await post(body)).status,200);assert.equal((await post(body)).status,200)
  assert.equal((await (await fetch(url)).json()).active,true)
  assert.deepEqual(await service.recoverExecutionTasks(),[])
  assert.equal((await post({...body,requestId:'stale',active:false})).status,409)
  assert.equal((await post({...body,requestId:'resume',active:false,expectedRevision:1})).status,200)
  assert.equal((await (await fetch(url)).json()).active,false)
  assert.equal((await post({...body,requestId:'enter-seal',expectedRevision:2})).status,200)
  const transition={requestId:'seal',maintenanceId:'deploy',expectedRevision:3,reason:'原子停机许可'}
  const call=(operation,value)=>fetch(`${url}/${operation}`,{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:3080'},body:JSON.stringify(value)})
  assert.equal((await call('seal',{...transition,processIncarnation:'fake'})).status,400)
  const sealResponse=await call('seal',transition);assert.equal(sealResponse.status,200)
  const sealed=(await sealResponse.json()).state
  assert.equal(sealed.stopPermitted,true);assert.equal(sealed.phase,'stopping')
  assert.equal((await post({...body,requestId:'old-leave',active:false,expectedRevision:4})).status,409)
  assert.equal((await call('resume',{...transition,requestId:'old-resume',expectedRevision:4})).status,409)
  assert.equal((await call('seal',transition)).status,200)
  assert.equal((await (await fetch(url)).json()).stopPermitted,true)
})
test('完成观察维护HTTP复用原生完成证明，拒绝跨源和伪造身份并校验CAS', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' } })
  const accepted = await service.ingest(message), state = await service.messages.process(accepted.runId)
  assert.equal(state.commands[0].result.runId, null)
  const taskId = state.commands[0].result.taskId
  const workflow = { id: 'completed-observation-fixture', version: '1', ownerContract: {
    id: 'completed-observation-result', version: '1', validateCompletion: async ({ output }) => output.observed === true }, nodes: [{
    id: 'observe', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async () => ({ observed: true, summary: '已核对测试记录' }) }] }
  execution.controller.registerWorkflow(workflow)
  await execution.controller.initializeTaskPlan({ commandId: 'observation-plan', taskId, expectedPlanRevision: 0,
    expectedRequirementRevision: 1, stages: [{ stageId: 'observe', workflowId: workflow.id, input: {} }] })
  let plan = await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.whenIdle(plan.stages[0].runId)
  await execution.controller.advanceTaskPlan(taskId)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  const before = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(before.decision.action, 'complete')
  const original = (await execution.store.query({ kind: 'task.owner.events', taskId })).find(event => event.eventType === 'workflow.succeeded')
  await execution.store.command({ id: 'duplicate-completion', kind: 'task.owner.event', args: { taskId,
    eventKey: `stage-${'d'.repeat(40)}`, eventType: original.eventType, payloadRef: original.payloadRef } })
  const identity = { channel: 'web', actorId: 'owner' }
  await service.changeMaintenance({ requestId: 'enter-recovery', active: true, expectedRevision: 0,
    maintenanceId: 'recovery', reason: '验证恢复' }, identity)
  await service.changeMaintenance({ requestId: 'seal-recovery', expectedRevision: 1,
    maintenanceId: 'recovery', reason: '验证封存后恢复' }, identity, 'seal')
  const runtime = { getCompletedWorkflowObservations: taskId => service.completedObservations(taskId),
    reconcileCompletedWorkflowObservations: request => service.reconcileCompletedObservations(request, identity) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/runtime/maintenance/tasks/${taskId}/completed-observations`
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.invalid' } })).status, 403)
  const proofResponse = await fetch(url); assert.equal(proofResponse.status, 200)
  const proof = await proofResponse.json()
  const body = { requestId: 'restore-completion', completeTurnId: proof.completeTurnId,
    expectedOwnerRevision: proof.expectedOwnerRevision, expectedEventWatermark: proof.expectedEventWatermark,
    maintenanceId: proof.maintenanceId, expectedMaintenanceRevision: proof.expectedMaintenanceRevision, reason: '处理重复成功观察' }
  const post = value => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: JSON.stringify(value) })
  assert.equal((await post({ ...body, actorId: 'owner' })).status, 400)
  assert.equal((await post({ ...body, taskId: 'other' })).status, 400)
  assert.equal((await post({ ...body, expectedMaintenanceRevision: 0 })).status, 409)
  await assert.rejects(service.reconcileCompletedObservations({ ...body, taskId }, { channel: 'web', actorId: 'other' }), /FORBIDDEN/)
  const response = await post(body); assert.equal(response.status, 200)
  const result = await response.json(); assert.equal(result.owner.status, 'idle')
  assert.deepEqual(result.owner.decision, before.decision)
  const repeated = await post(body); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).receipt.replayed, true)
  assert.equal((await service.maintenance()).phase, 'stopping')
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).processedWatermark, proof.expectedEventWatermark)
})

test('service真实恢复入口不重派确定性错误，只有明确暂态可有限重试', async t => {
  for (const [nodeId, code, skipped] of [['apply-changes', 'ENGINEERING_PATCH_AMBIGUOUS', true],
    ['analyze', 'ENGINEERING_PATCH_AMBIGUOUS', true], ['apply-changes', 'ENGINEERING_PATCH_BASE_CONFLICT', true],
    ['apply-changes','ENGINEERING_PATCH_CONFLICT',true],['apply-changes','EDIT_BASE_CONFLICT',true],['analyze','NODE_INPUT_SCHEMA_INVALID',true],['analyze','ECONNRESET',false],
    ['verify-candidate','ENGINEERING_REMOTE_READ_TRANSIENT',false],['verify-candidate','ENGINEERING_REMOTE_READ_FAILED',true],['verify-candidate','NODE_EXECUTION_FAILED',true]]) {
    let executions = 0
    const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, { nodeId, execute: async () => {
      executions++; throw Object.assign(new Error(code), { code })
    } })
    const task = await startCodeTask()
    await execution.controller.whenIdle(task.runId)
    const before = await execution.controller.state(task.runId), initialExecutions = executions
    assert.equal(before.run.status, 'waiting')
    assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
    await execution.controller.whenIdle(task.runId)
    const after = await execution.controller.state(task.runId)
    assert.equal(executions, initialExecutions + (skipped ? 0 : 1))
    if (skipped) {
      assert.equal(after.run.revision, before.run.revision)
      assert.equal(after.run.generation, before.run.generation)
      assert.equal(after.nodes.find(node => node.nodeId === nodeId).status, 'waiting')
    }
    for(let i=0;i<4;i++) { (await settleTaskOwners(service, service.execution)).failures; await execution.controller.whenIdle(task.runId) }
    assert.equal(executions, initialExecutions + (skipped ? 0 : 1))
  }
})

test('同Run超过旧54次领取仍完成、验收一次且保留真人阶段门禁', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  const original = (await service.state(received.runId)).commands[0].result
  assert.equal(original.runId, null); await execution.controller.advanceTaskPlan(original.taskId)
  await settleTaskOwners(service, service.execution)
  const requirement = await execution.artifacts.put({ request: 'budget fixture', acceptanceCriteria: ['通过'], constraints: [], scope: { sourceKeys: ['web:budget'] }, authorization: {} })
  const taskId = 'web-budget-fixture'
  await execution.store.command({ id: 'budget-web-origin', kind: 'task.web-rerun.accept', args: { taskId, rerunOfTaskId: original.taskId, actorId: 'owner',
    request: { expectedRunId: original.runId, objective: 'budget fixture' }, requirementRef: requirement.ref, criteria: ['通过'], sourceKey: 'web-rerun:budget' } })
  let firstClaims = 0, acceptances = 0
  const workflow = { id: 'budget-fixture', version: '1', nodes: Array.from({ length: 18 }, (_, index) => ({
    id: index === 11 ? 'prepare-commit' : `step-${index}`, version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async () => {
      if (index === 0 && ++firstClaims <= 43) throw Object.assign(new Error('fixture-retry'), { code: 'FIXTURE_RETRY' })
      if (index === 10) acceptances++
      return { index }
    } })) }
  execution.controller.registerWorkflow(workflow)
  await execution.controller.initializeTaskPlan({ commandId: 'budget-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1,
    stages: [{ stageId: 'current', workflowId: workflow.id, input: { request: 'fixture' } }, { stageId: 'later', workflowId: workflow.id, gate: 'confirmation' }] })
  const started = await execution.controller.advanceTaskPlan(taskId), runId = started.stages[0].runId
  await execution.controller.whenIdle(runId)
  for (let i = 0; i < 43; i++) { await execution.controller.recover({ commandId: `fixture-recover-${i}`, runId }); await execution.controller.whenIdle(runId) }
  const before = await execution.controller.state(runId)
  assert.equal(before.run.claimCount, 61); assert.equal(before.run.maxClaims, undefined); assert.equal(before.run.status,'succeeded'); assert.equal(acceptances, 1)
  const plan = await execution.controller.advanceTaskPlan(taskId)
  assert.equal(plan.stages[1].status,'waiting_confirmation')
  assert.equal(plan.stages[1].runId,null)
})

test('默认日常能力按当前原文生成 Markdown，并拒绝把排查目标当整理完成', async () => {
  let source = { sourceKey: 'source-1', text: '账号创建时间待排查' }
  const read = { authorize: async ({ input, scope }) => input.sourceKeys.every(key => scope.sourceKeys.includes(key)),
    execute: async () => ({ sources: [source] }) }
  const capability = createSourceDossierCapability(read)
  const input = { sourceKeys: ['source-1'] }, scope = { sourceKeys: ['source-1'] }
  const output = await capability.execute({ input, scope })
  assert.equal(output.markdown, '### source-1\n\n> 账号创建时间待排查')
  const verification = await capability.verify({ input, scope, output })
  assert.equal(verification.passed, true)
  const evidence = [{ capabilityId: capability.id, evidenceId: 'step-1', output, verification }]
  const report = { summary: output.markdown, evidenceIds: ['step-1'], limitations: [] }
  assert.equal((await verifyDefaultGeneralCompletion({ request: '整理本条材料',
    acceptanceCriteria: ['整理本条材料'], scope, evidence, report })).status, 'satisfied')
  assert.equal((await verifyDefaultGeneralCompletion({ request: '排查账号创建时间为空的原因',
    acceptanceCriteria: ['排查账号创建时间为空的原因'], scope, evidence, report })).status, 'unverified')
  source = { ...source, text: '完整材料'.repeat(5000) + '结尾条件：仅测试库' }
  const long = await capability.execute({ input, scope })
  assert.ok(long.markdown.includes(source.text))
  assert.ok(Buffer.byteLength(long.markdown)>32000)
  assert.equal((await capability.verify({input,scope,output:long})).passed,true)
  source = { ...source, text: '原文已被更正' }
  assert.equal((await capability.verify({ input, scope, output })).passed, false)
})
test('平台附件只读能力绑定当前 Task 消息、附件 ID 与来源版本，并独立二次回读', async () => {
  const source = { sourceKey: 's1', sourceVersion: 2, conversationId: 'g', status: 'active', body: '附件见本条',
    context: { sourceMessageId: 'm1', attachments: [{ source: { type: 'fileId', resourceId: 'f1' } }] } }
  const scope = { conversationId: 'g', sourceKeys: ['s1'], sourceVersions: { s1: 2 } }
  const input = { sourceKey: 's1', type: 'fileId', resourceId: 'f1' }
  let reads = 0
  const resourceText='记录内容'.repeat(5000)+'禁止生产写入'
  const message = { conversationId: 'g', messageId: 'm1', text: '附件见本条', resourceRefs: [{ type: 'fileId', resourceId: 'f1' }] }
  const capability = createTaskMessageResourceCapability({ store: { query: async () => source },
    readMessage: async () => message, readResource: async () => { reads++; return { text: resourceText } } })
  assert.deepEqual(capability.parameters.required, ['sourceKey', 'type', 'resourceId'])
  assert.equal(await capability.authorize({ input, scope }), true)
  const output = await capability.execute({ input, scope })
  assert.ok(output.markdown.includes(resourceText))
  assert.ok(Buffer.byteLength(output.markdown)>16000)
  assert.equal(output.contentDigest, executionDigest(resourceText))
  const verification = await capability.verify({ input, scope, output })
  assert.equal(reads, 2)
  assert.equal(verification.passed, true)
  assert.equal(verification.outputDigest, executionDigest(output))
  assert.equal(await capability.authorize({ input: { ...input, resourceId: 'other' }, scope }), false)
  assert.equal(await capability.authorize({ input, scope: { ...scope, conversationId: 'other' } }), false)
  assert.equal(await capability.authorize({ input, scope: { ...scope, sourceVersions: { s1: 1 } } }), false)
  assert.equal(await capability.authorize({ input: { ...input, type: 'url' }, scope }), false)
})
test('平台附件变更、跨群回读和二次内容漂移均不能成为通用任务证据', async () => {
  const source = { sourceKey: 's1', sourceVersion: 1, conversationId: 'g', body: '文件',
    context: { sourceMessageId: 'm1', attachments: [{ source: { type: 'fileId', resourceId: 'f1' } }] } }
  const scope = { conversationId: 'g', sourceKeys: ['s1'], sourceVersions: { s1: 1 } }
  const input = { sourceKey: 's1', type: 'fileId', resourceId: 'f1' }
  let changed = false
  const make = remote => createTaskMessageResourceCapability({ store: { query: async () => source },
    readMessage: async () => remote, readResource: async () => ({ text: changed ? '新正文' : '旧正文' }) })
  const remote = { conversationId: 'g', messageId: 'm1', text: '文件', resourceRefs: [{ type: 'fileId', resourceId: 'f1' }] }
  const capability = make(remote)
  const output = await capability.execute({ input, scope })
  changed = true
  assert.equal((await capability.verify({ input, scope, output })).passed, false)
  await assert.rejects(make({ ...remote, conversationId: 'other' }).execute({ input, scope }), /GENERAL_RESOURCE_SOURCE_CHANGED/u)
  await assert.rejects(make({ ...remote, resourceRefs: [] }).execute({ input, scope }), /GENERAL_RESOURCE_SOURCE_CHANGED/u)
  source.sourceVersion = 2
  assert.equal(await capability.authorize({ input, scope }), false)
})
test('旧消息正文中的钉钉文档由冻结来源派生，完整证据需独立回读且拒绝漂移', async () => {
  const body = '请核对 https://alidocs.dingtalk.com/i/nodes/node123?from=chat'
  const source = { sourceKey: 'doc-source', sourceVersion: 1, conversationId: 'g', body,
    context: { sourceMessageId: 'doc-message', attachments: [] } }
  const scope = { conversationId: 'g', sourceKeys: ['doc-source'], sourceVersions: { 'doc-source': 1 } }
  const input = { sourceKey: 'doc-source', type: 'dingtalkDoc', resourceId: 'node123' }
  let text = '完整正文与表格', complete = true, remoteBody = body, reads = 0
  const capability = createTaskMessageResourceCapability({ store: { query: async () => source },
    readMessage: async () => ({ conversationId: 'g', messageId: 'doc-message', text: remoteBody }),
    readResource: async (_g, _m, ref) => { assert.equal(ref.resourceId, 'node123'); reads++; return { text, complete } } })
  assert.equal(await capability.authorize({ input, scope }), true)
  const output = await capability.execute({ input, scope })
  assert.match(output.markdown, /完整正文与表格/u)
  assert.equal((await capability.verify({ input, scope, output })).passed, true)
  assert.equal(reads, 2)
  text = '正文已改变'
  assert.equal((await capability.verify({ input, scope, output })).passed, false)
  complete = false
  await assert.rejects(capability.execute({ input, scope }), /GENERAL_RESOURCE_READ_INCOMPLETE/u)
  remoteBody = '改为 https://alidocs.dingtalk.com/i/nodes/other'
  await assert.rejects(capability.execute({ input, scope }), /GENERAL_RESOURCE_SOURCE_CHANGED/u)
  assert.equal(await capability.authorize({ input: { ...input, resourceId: 'other' }, scope }), false)
  assert.equal(await capability.authorize({ input, scope: { ...scope, sourceVersions: { 'doc-source': 2 } } }), false)
})

test('短指代消息优先呈现紧邻来源的话题，显式引用仍优先', () => {
  const cards = Array.from({ length: 12 }, (_, index) => ({ candidateId: `old-${index}`, goal: '审核草稿排查', sourceRefs: [], explicitReferenceMatches: [], relevantTime: '2026-09-24T00:00:00Z' }))
  cards.push({ candidateId: 'account', topicId: 'account', goal: 'test3 账号创建时间为空', sourceRefs: ['previous'], explicitReferenceMatches: [], relevantTime: '2026-09-24T07:28:41Z' })
  assert.equal(rankMessageCandidates(cards, '这不是让你去查吗', 'previous')[0].candidateId, 'account')
  cards.find(item => item.candidateId === 'old-1').explicitReferenceMatches = ['quoted']
  assert.equal(rankMessageCandidates(cards, '这不是让你去查吗', 'previous')[0].candidateId, 'old-1')
})
test('准入接收者识别不代替I/IB业务语义判断',()=>{
  const names=['小助手','用户']
  assert.equal(isDirectedTaskRequest('@用户(用户) 小助手 数据集合并出现的这个问题需要修复',names),true)
  assert.equal(isDirectedTaskRequest('@用户(用户) 修复又引入了归一化计算问题：当前得到 0.001 t。',names),true)
  assert.equal(isDirectedTaskRequest('@用户 任务已创建，开始处理。',names),true)
  assert.equal(isDirectedTaskRequest('资料助理，请修复这个错误',['资料助理']),true)
  assert.equal(isDirectedTaskRequest('客服(乙)，请处理这个错误',['客服(乙)']),true)
  assert.equal(isDirectedTaskRequest('OpsX，请修复这个错误',['Ops.*']),false)
  assert.equal(isDirectedTaskRequest('Ops.*，请修复这个错误',['Ops.*']),true)
  assert.equal(isDirectedTaskRequest('资料助理，请修复这个错误'),false)
  assert.equal(isDirectedTaskRequest('cc: 请修复这个错误',['资料助理']),false)
})

test('群回复署名只取唯一明确职责，不默认身份，不重复或注入内部信息',()=>{
 const link='请查看 [PR #42](https://example.invalid/pull/42)。'
 assert.equal(formatGroupReply(link,'日常代答末尾空一行附 - 资料助理代回'),`${link}\n\n- 资料助理代回`)
 assert.equal(formatGroupReply('收到。','客服(乙)代回'),'收到。\n\n- 客服(乙)代回')
 assert.equal(formatGroupReply('收到。\n\n- 资料助理代回','署名 - 资料助理代回'),'收到。\n\n- 资料助理代回')
 assert.equal(formatGroupReply(link,'回答本群问题'),link)
 assert.throws(()=>formatGroupReply('收到。','署名 - 资料助理代回；署名 - 客服代回'),/WORKFLOW_REPLY_SIGNATURE_AMBIGUOUS/)
 assert.throws(()=>formatGroupReply('收到。','署名 - 任务会话代回'),/GROUP_REPLY_INTERNAL_DETAILS/)
})

test('状态问句支持任意配置名称及别名，改名和清空后不保留旧身份捷径',async t=>{
 let names=['资料助理','客服(乙)'],splitCalls=0
 const task={taskId:'old',groupId:'g',title:'审核草稿保存问题',objective:'修复审核问题',state:'completed',result:'已修复'}
 const {service,message}=await fixture(t,'participant',undefined,{legacy:{
  getAgentConfig:()=>({provider:'test',model:'test',agentNames:names}),listTasks:()=>[task],
 },judge:async({stage,input})=>{
  if(stage==='S'){splitCalls++;return splitOne(input.source.text)}
  if(stage==='R')return {kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:null,evidence:['本群任务']}
  return {kind:'intent',actions:[{intent: names.some(name => input.text.includes(name)) ? 'status' : 'no_action',arguments: names.some(name => input.text.includes(name)) ? {scope:'conversation'} : {},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
 }})
 const ask=async(id,name)=>{
  const input=await service.ingest({...message,messageId:id,text:`${name}，我审核的问题都改完部署到uat2了吗？`})
  return service.messages.process(input.runId)
 }
 assert.equal((await ask('name','资料助理')).commands[0].kind,'status')
 assert.equal((await ask('alias','客服(乙)')).commands[0].kind,'status')
 assert.equal(splitCalls,2)
 names=['流程助手']
 assert.equal((await ask('old-name','资料助理')).commands.length,0)
 assert.equal(splitCalls,3)
 assert.equal((await ask('new-name','流程助手')).commands[0].kind,'status')
 names=[]
 assert.equal((await ask('unset','流程助手')).commands.length,0)
 assert.equal(splitCalls,5)
 assert.equal((await service.tasks()).length,0)
})
test('内置进展查询限制本群与八项候选，流程结果可审计',()=>{
  const legacyTasks=Array.from({length:10},(_,index)=>({taskId:`t-${index}`,groupId:'g',title:`审核草稿保存 ${index}`,objective:'修复审核草稿保存',state:'completed'}))
  legacyTasks.push({taskId:'other',groupId:'other',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed'})
  const result=queryConversationTaskProgress({queryText:'审核草稿保存的问题进展如何？',conversationId:'g',actorId:'member',ownerActorId:'owner',occurredAt:'2026-09-24T00:00:00Z',workflowOrigins:[],workflowRuns:[],legacyTasks})
  assert.equal(result.items.length,8)
  assert.equal(result.flow.steps[1].count,10)
  assert.match(result.reply,/仅显示前 8 项/)
  assert.ok(result.items.every(item=>item.taskId!=='other'))
})
test('渠道回读归一化空白及已观察inline-code样式，正文差异仍阻止送达',()=>{
  assert.equal(sameDeliveredText('第一行 第二行','第一行\n第二行'),true)
  assert.equal(sameDeliveredText('第一行 第三行','第一行\n第二行'),false)
  assert.equal(sameDeliveredText('引用内容：这是待核对的原问题。回复内容：第一行 第二行','第一行\n第二行',true),false)
  assert.equal(sameDeliveredText('引用内容：原消息。回复内容：审核草稿和撤回通知已交付测试，分配撤回任务已取消。','审核草稿和撤回通知已交付测试，分配撤回任务已取消。',true),false)
  assert.equal(sameDeliveredText('@向春梅 更正审核问题：1. 草稿保存已部署。 2. 分配撤回未部署。','更正审核问题：1. 草稿保存已部署。\n2. 分配撤回未部署。',{sender:'向春梅'}),true)
  assert.equal(sameDeliveredText('', ''),true)
  assert.equal(sameDeliveredText(null,'第一行'),false)
  assert.equal(sameDeliveredText('Java **<java.version>11</java.version>** 与 **${java.version}**','Java `<java.version>11</java.version>` 与 `${java.version}`'),true)
  assert.equal(sameDeliveredText('Java **<java.version>17</java.version>**','Java `<java.version>11</java.version>`'),false)
  assert.equal(sameDeliveredText('Java <java.version>11</java.version>','Java `<java.version>11</java.version>`'),false)
  assert.equal(sameDeliveredText('**value**','```value```'),false)
  assert.equal(sameDeliveredText('**line1 line2**','`line1\nline2`'),false)
  assert.equal(sameDeliveredText('Java **value','Java `value`'),false)

})
test('DWS 发送 ACK 的实际 result.openTaskId 可用于独立回读',()=>{
  assert.equal(notificationOpenTaskId({success:true,result:{openTaskId:'task-1'}}),'task-1')
})
test('群职责指定的日常代答署名在通知准备时固化且不会重复附加',()=>{
  const rule='针对消息必须引用回复；日常代答末尾空一行附 - 小助手代回'
  assert.equal(formatGroupReply('任务状态已核对。',rule),'任务状态已核对。\n\n- 小助手代回')
  assert.equal(formatGroupReply('任务状态已核对。\n\n- 小助手代回',rule),'任务状态已核对。\n\n- 小助手代回')
  assert.equal(formatGroupReply('任务状态已核对。','普通群'),'任务状态已核对。')
})
test('群职责贯穿即时进展查询的持久通知正文与引用来源',async t=>{
  const sent=[]
  const notifications={canDisclose:async()=>true,send:async notice=>{sent.push(notice);return{messageId:'reply-1'}},readback:async()=>({messageId:'reply-1',conversationId:'g'})}
  const task={taskId:'review-1',groupId:'g',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed'}
  const {service,message}=await fixture(t,'participant',notifications,{legacy:{listTasks:()=>[task],getGroup:id=>({groupId:id,responsibility:'日常代答末尾空一行附 - 小助手代回；针对消息必须引用回复',messages:[]})},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:null,evidence:['本群任务']}:{kind:'intent',actions:[{intent:'status',arguments:{scope:'conversation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}})
  const received=await service.ingest({...message,text:'审核草稿保存进度如何？'})
  await service.messages.process(received.runId)
  await service.flushNotifications()
  assert.equal(sent.length,1)
  assert.match(sent[0].payload.text,/\n\n- 小助手代回$/u)
  assert.equal(sent[0].payload.sourceMessageId,message.messageId)
  assert.equal(sent[0].status,'sending')
})
test('群职责调整后已送达通知保留原正文，新通知仍可继续发送',async t=>{
  let responsibility='普通群'
  const sent=[]
  const notifications={canDisclose:async()=>true,send:async notice=>{sent.push(notice.payload.text);return{messageId:`reply-${sent.length}`}},readback:async notice=>({messageId:notice.ack.messageId,conversationId:'g'})}
  const task={taskId:'review',groupId:'g',title:'审核草稿',objective:'排查审核草稿',state:'completed'}
  const {service,message}=await fixture(t,'owner',notifications,{legacy:{listTasks:()=>[task],getGroup:id=>({groupId:id,responsibility,messages:[]})},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:null,evidence:['本群任务']}
    :{kind:'intent',actions:[{intent:'status',arguments:{scope:'conversation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}})
  const first=await service.ingest({...message,messageId:'first',text:'审核草稿进度如何？'})
  await service.messages.process(first.runId);await service.flushNotifications()
  responsibility='日常代答末尾空一行附 - 小助手代回'
  const second=await service.ingest({...message,messageId:'second',text:'审核草稿现在什么状态？'})
  await service.messages.process(second.runId);await service.flushNotifications()
  assert.equal(sent.length,2)
  assert.doesNotMatch(sent[0],/小助手代回/u)
  assert.match(sent[1],/\n\n- 小助手代回$/u)
})
test('工作流通知引用来源消息，缺来源才发送普通群消息',async()=>{
  const sent=[]
  const adapter={sendGroupReply:async value=>sent.push({kind:'reply',...value}),sendGroup:async value=>sent.push({kind:'group',...value})}
  await sendWorkflowNotification(adapter,{id:'n1',payload:{conversationId:'g',text:'已核对任务状态',sourceMessageId:'m1',actorId:'sender'}})
  await sendWorkflowNotification(adapter,{id:'n2',payload:{conversationId:'g',text:'系统通知'}})
  assert.equal(sent[0].kind,'reply')
  assert.equal(sent[0].replyToMessageId,'m1')
  assert.equal(sent[0].replyToSenderOpenDingTalkId,'sender')
  assert.equal(sent[1].kind,'group')
})
function investigationResult(input, result) {
  if (!input.acceptanceItems) return result
  return { ...result,
    findings: [{ kind: 'judgment', statement: result.summary, evidenceRefs: result.evidenceRefs }],
    openItems: [], criterionReviews: input.acceptanceItems.map(item => ({ itemId: item.itemId,
      status: result.evidenceRefs.length ? 'satisfied' : 'insufficient_evidence',
      reason: result.evidenceRefs.length ? '已核对本测试提供的当前来源材料' : '本测试未提供可验证证据', evidenceRefs: result.evidenceRefs })) }
}
async function queryOwnerSources({ binding, tools, queryInput, onQueryEvidence }) {
  const queried = await tools.find(tool => tool.name === 'read-topic-sources').execute({ binding, input: queryInput,
    args: { sourceKeys: queryInput.scope.sourceKeys } })
  await onQueryEvidence({ binding: Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key,binding[key]])), evidenceRef: queried.evidenceRef })
  return [queried.evidenceRef]
}

// 明确等待原生Owner账收敛；生产恢复入口本身不等待模型，也不将排队/重试冒充完成。
async function settleTaskOwners(service, execution) {
  const recovered = await service.recover()
  const deadline = Date.now() + 60000
  for (;;) {
    if ((await execution.store.query({ kind: 'runtime.maintenance' })).active) return recovered
    const owners = await execution.store.query({ kind: 'task.owners.list', limit: 200 })
    const actions = await execution.store.query({ kind: 'task.owner.actions.pending', limit: 200 })
    const delayedApplications = new Set(actions.filter(action => action.retryAt && Date.parse(action.retryAt) > Date.now()).map(action => action.taskId))
    const pending = []
    for (const owner of owners) {
      if ((await execution.controller.taskPlan(owner.taskId))?.task.controlState !== 'active') continue
      if (owner.status === 'running' || owner.applicationStatus === 'pending' && !delayedApplications.has(owner.taskId)
        || owner.status === 'pending' && owner.eventWatermark > owner.processedWatermark
          && (!owner.retryAt || Date.parse(owner.retryAt) <= Date.now())) pending.push(owner)
    }
    if (!pending.length) return recovered
    assert.ok(Date.now() < deadline, 'Owner尚未收敛：' + JSON.stringify(pending.map(owner => ({
      taskId: owner.taskId, status: owner.status, applicationStatus: owner.applicationStatus,
      lastFailure: owner.lastFailure, retryAt: owner.retryAt }))))
    await new Promise(resolve => setTimeout(resolve, 10))
    recovered.failures.push(...await service.recoverExecutionTasks())
  }
}

async function fixture(t, actor = 'owner', notifications, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'workflow-service-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true,
    taskWorkspaceRoot: root, getTaskDirectories: createTaskDirectoryResolver({ store, workspaceRoot: root }) })
  const delivery = options.delivery ?? (options.deliveryOptions ? createExecutionDelivery({ store, artifacts, ...options.deliveryOptions }) : undefined)
  let codeMode = false
  const investigationSessions = { async run({ input, binding, onSessionBound, onResult }) {
    await onSessionBound()
    const value = options.execute && !codeMode ? await options.execute({ input, signal: new AbortController().signal, ...binding })
      : { summary: `已分析：${input.request}`, evidenceIds: input.materials.map(item => item.id), limitations: [] }
    const result = { outcome: value.outcome ?? 'completed', summary: value.summary,
      evidenceRefs: value.evidenceRefs ?? value.evidenceIds ?? [], limitations: value.limitations ?? [], question: value.question ?? '' }
    await onResult(investigationResult(input, result))
    return { status: 'submitted' }
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions: options.executionSessions ?? investigationSessions, readTools: ['read-topic-sources', 'read-predecessor-artifact', 'organize-topic-sources', 'read-task-message-resource', ...(options.readTools ?? [])], ...(delivery ? { delivery } : options.external ? { delivery: { execute: async () => { throw new Error('EXTERNAL_EFFECT_NOT_EXPECTED') } } } : {}), workflows: [] })
  const execution = { store: options.storeQuery || options.storeCommand ? { ...store,
    ...(options.storeQuery ? { query: request => options.storeQuery(request, store.query) } : {}),
    ...(options.storeCommand ? { command: request => options.storeCommand(request, store.command) } : {}) } : store,
    artifacts, controller, ...(delivery ? { delivery } : {}) }
  const legacy = { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'], ...(options.taskFiles ? { workspaceDir: root } : {}) }), getGroup: id => ({ groupId: id, responsibility: '处理本人交办事项', messages: [] }), ...options.legacy }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理本条材料' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const legacyJudge = options.judge ?? judge
  // 仅将既有测试的业务脚本转换为原生协调会话候选；生产不运行旧阶段。
  const coordinatorSessions = options.coordinatorSessions ?? {async run({input,onSessionBound,onCandidate,readTools}) {
    await onSessionBound()
    const decisions=[]
    for(const source of input.sources){
      const scriptInput={...source.context,source:{...source.context.source,text:source.body},text:source.body,goalText:source.body,
        candidates:input.candidates,groupResponsibility:input.groupResponsibility,clarificationAnswers:source.requests.filter(r=>r.status==='resolved').map(r=>({answer:r.answer}))}
      const split=await legacyJudge({stage:'S',input:scriptInput})
      if(split.kind==='needs_clarification'){decisions.push({runId:source.runId,reason:split.reason,units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding:{disposition:'new',candidateId:null},intent:coordinatorQuestion(source,split)}]});continue}
      if(split.kind==='no_action'){decisions.push({runId:source.runId,reason:split.reason,units:[]});continue}
      const units=[]
      for(const unit of split.units){
        let routed=await legacyJudge({stage:'R',input:{...scriptInput,...unit}})
        if(routed.kind==='needs_context'){
          const answers=[]
          for(const need of routed.needs){const answer=await readTools.find(t=>t.name==='group_coordinator_read_material').execute({runId:source.runId,resourceRef:need.resourceRef});answers.push({answer})}
          scriptInput.clarificationAnswers.push(...answers)
          routed=await legacyJudge({stage:'R',input:{...scriptInput,...unit}})
        }
        if(routed.kind==='needs_clarification'){units.push({spans:unit.spans,goalText:unit.goalText,binding:{disposition:'new',candidateId:null},intent:coordinatorQuestion(source,routed)});continue}
        if(routed.kind!=='binding')throw Error(`OBSOLETE_ROUTING_FIXTURE:${routed.kind}`)
        const card=input.candidates.find(c=>c.candidateId===routed.candidateId)
        const facts=card?await readTools.find(t=>t.name==='group_coordinator_read_task').execute({runId:source.runId,candidateId:card.candidateId}):source.facts
        const intent=await legacyJudge({stage:'I',input:{...scriptInput,...unit,binding:{...routed,...(card?{taskId:card.taskId,engine:card.engine,target:card}: {})},facts}})
        units.push({spans:unit.spans,goalText:unit.goalText,binding:{disposition:routed.disposition,candidateId:routed.candidateId},intent:intent.kind==='needs_clarification'?coordinatorQuestion(source,intent):intent})
      }
      decisions.push({runId:source.runId,reason:'隔离业务脚本',units})
    }
    try { await onCandidate({decisions}) } catch(error) {
      if(!['GROUP_COORDINATOR_ACTION_INVALID','MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN'].includes(error.code))throw error
      // 隔离模型收到Host准入反馈后重新提交明确澄清；不绕过生产门禁。
      const question=error.code==='MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN'?'请由原交办人明确确认要替换的完整限制范围。':error.message.slice(error.message.indexOf(':')+1)
      const reason=error.code==='MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN'?'TOPIC_FACT_REVISION_UNCONFIRMED':question
      await onCandidate({decisions:decisions.map(d=>({...d,units:d.units.map(u=>({...u,intent:coordinatorQuestion(input.sources.find(source=>source.runId===d.runId),{reason,question})}))}))})
    }
    return {status:'submitted'}
  },async close(){}}
  const taskOwnerSessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    if (!input.stages.length) {
      const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
      const value = options.execute && !codeMode ? await options.execute({ input: input.goal, signal: new AbortController().signal, ...binding }) : { summary: `已分析：${input.goal.request}` }
      const decision = { action: value.outcome === 'needs_clarification' ? 'wait' : 'complete', summary: value.summary,
        evidenceRefs: refs, ...(value.outcome === 'needs_clarification' ? { condition: { kind: 'business-input', missing: value.question,
          responsibleParty: '交办人', resumeWhen: '补充后继续', evidenceRefs: refs } } : { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }) }
      await onCandidate(decision); return { status: 'submitted', decision }
    }
    const needsPlan = input.stages.length === 0
    const complete = !needsPlan && input.stages.every(stage => stage.status === 'succeeded')
    const activeStage = input.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status))
    if (complete) for (const ref of input.stages.flatMap(stage => stage.evidenceRefs ?? [])) await readArtifact(ref)
    const decision = { action: needsPlan ? 'advance' : complete ? 'complete' : activeStage?.status === 'blocked' ? 'block'
      : activeStage?.status === 'ready' ? 'advance' : 'wait',
      summary: complete ? '全部阶段已完成' : '按当前计划推进', evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []),
      ...(needsPlan ? { planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } } : {}),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId,
        status: 'satisfied', evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []) })) } : {}) }
    if (['wait', 'block'].includes(decision.action)) decision.condition = { kind: 'execution',
      missing: activeStage?.unavailableReason || '当前阶段完成证明', responsibleParty: '阶段执行方',
      resumeWhen: '当前阶段完成或恢复条件变化后重新评估', evidenceRefs: decision.evidenceRefs }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const service = await openWorkflowService({ ctx: { sessions: { get: () => ({ snapshotEvents: () => [] }) }, ...options.ctx }, config: { groupIds: ['g'], ownerActorId: 'owner', ...options.config }, legacy, coordinatorSessions, execution, notifications, readResource: options.readResource, readMessage: options.readMessage, external: options.external,
    generalCompletionCheck: Object.hasOwn(options, 'generalCompletionCheck') ? options.generalCompletionCheck : (async input => ({ status: 'satisfied', resultVerified: true,
      criteria: input.acceptanceItems.map(item => ({ criterion: item.criterion, passed: true, evidenceIds: item.evidenceRefs })) })),
    generalCompletionIdentity: 'test-general-completion-v1',
    messageAgentSessions: options.messageAgentSessions ?? { async run({ input, onSessionBound, onResult }) {
      await onSessionBound()
      await onResult({ outcome: 'completed', summary: input.request, evidenceRefs: [], limitations: [], question: '' })
      return { status: 'submitted' }
    }, async cancel() {}, async close() {} },
    taskOwnerSessions: options.taskOwnerSessions ?? taskOwnerSessions })
  const process = service.messages.process.bind(service.messages)
  service.messages.process = async runId => {
    await process(runId)
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await service.messages.state(runId)
      if (['needs_attention', 'superseded'].includes(state.run.status) || state.requests.some(item => item.status === 'pending')
        || state.run.status === 'settled' && state.commands.every(command => ['applied', 'rejected', 'failed', 'unknown', 'superseded'].includes(command.status))) return state
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return service.messages.state(runId)
  }
  t.after(async () => { await service.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'g', messageId: 'm', text: '整理本条材料', senderOpenDingTalkId: actor }
  async function startCodeTask() {
    codeMode = true
    const source = await service.ingest(message)
    await service.messages.process(source.runId)
    const original = (await service.state(source.runId)).commands[0].result
    assert.equal(original.runId, null)
    await controller.advanceTaskPlan(original.taskId)
    await settleTaskOwners(service, service.execution)
    const workflowId = options.codeWorkflowId ?? 'fixture-code-operation'
    controller.registerWorkflow({ id: workflowId, version: options.codeWorkflowVersion ?? '1', nodes: [
      { id: options.nodeId ?? 'analyze', version: '1', executor: 'code', allowedEffects: options.allowedEffects ?? ['pure'],
        inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement,
        execute: options.execute }, ...(options.extraNodes ?? [])] })
    const taskId = 'fixture-code-task'
    if (options.codePrefixCount) controller.registerWorkflow({ id: 'fixture-prefix', version: '1', nodes: [{ id: 'prefix-result', version: '1', executor: 'code',
      allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input }] })
    const requirement = await artifacts.put({ request: 'fixture', acceptanceCriteria: ['fixture'], constraints: [], target: {}, scope: { conversationId: 'g', sourceKeys: ['web-rerun:fixture-code'], sourceVersions: { 'web-rerun:fixture-code': 1 } }, authorization: {}, reportChannel: 'web', externalMessaging: false })
    await store.command({ id: 'fixture-code-origin', kind: 'task.web-rerun.accept', args: { taskId,
      rerunOfTaskId: original.taskId, actorId: 'owner', request: { expectedRunId: original.runId, objective: 'fixture' },
      requirementRef: requirement.ref, criteria: ['fixture'], sourceKey: 'web-rerun:fixture-code' } })
    await controller.initializeTaskPlan({ commandId: 'fixture-code-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1,
      stages: [...Array.from({ length: options.codePrefixCount ?? 0 }, (_, index) => ({ stageId: `prefix-${index}`, workflowId: 'fixture-prefix' })),
        { stageId: 'fixture', workflowId }].map((stage, index) => ({ ...stage, ...(index === 0 ? { input: { request: 'fixture', materials: [] } } : {}) })) })
    let plan = await controller.advanceTaskPlan(taskId)
    for (let index = 0; index < (options.codePrefixCount ?? 0); index++) {
      await controller.whenIdle(plan.stages[index].runId)
      plan = await controller.advanceTaskPlan(taskId)
      await controller.bindTaskStageInput({ commandId: `fixture-bind-${index}`, taskId, planRevision: plan.task.planRevision,
        expectedControlRevision: plan.task.controlRevision, stageId: plan.stages[index + 1].stageId,
        predecessorOutputRef: plan.stages[index].outputRef, input: { request: 'fixture', materials: [] } })
      plan = await controller.advanceTaskPlan(taskId)
    }
    return { taskId, runId: plan.stages.at(-1).runId }
  }
  return { service, execution, message, startCodeTask, root }
}

test('正式 Web 重执行新建独立任务，持久幂等、原任务不变、恢复只留 Web 且拒绝越权阶段', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-rerun-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source'), remote = join(directory, 'remote.git')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'a.js'), 'const value = 1\n'); await git('add', '.'); await git('commit', '-m', 'base')
  await git('init', '--bare', remote); await git('push', remote, 'HEAD:refs/heads/feature/uat3-base')
  const adapter = { id: 'test-uat', version: '1', rulesDigest: 'a'.repeat(64),
    inspect: async () => { throw new Error('UNEXPECTED_EXTERNAL') }, prepareOperation: async () => { throw new Error('UNEXPECTED_EXTERNAL') } }
  const external = { uatMergeAdapter: adapter, releaseAdapters: { 'uat-deployment': adapter },
    availableTargets: [{ workflowId: 'task-uat-pr-merge', targetId: 'merge-uat3', repository: 'example/dataset', branch: 'feature/uat3-base' },
      { workflowId: 'task-uat-deployment', targetId: 'deploy-uat3', repository: 'example/dataset', branch: 'feature/uat3-base' }],
    operationAdapter: { execute: async () => { throw new Error('UNEXPECTED_EXTERNAL') }, reconcile: async () => { throw new Error('UNEXPECTED_EXTERNAL') } },
    authorizeExternal: async () => false, prepareRequirement: async () => { throw new Error('UNEXPECTED_EXTERNAL') } }
  const config = { webActorId: 'owner', repositories: [{ id: 'dataset', sourceRepository: source, managedRoot: join(directory, 'managed'),
    remote, githubRepository: 'example/dataset', baseRef: 'main', editablePaths: ['a.js'], checks: [{ id: 'build', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] }
  let sent = 0
  const notices = { canDisclose: async () => true, send: async () => { sent++; return { messageId: `notice-${sent}` } },
    readback: async notice => ({ messageId: notice.ack.messageId, evidenceRef: 'readback' }) }
  const taskOwnerSessions = { async close() {}, async run({ input, binding, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound()
    if (input.goal.reportChannel === 'web') {
      const decision = { action: 'advance', summary: '验证Owner不得选择未授权阶段', evidenceRefs: [],
        planChange: { kind: 'initialize', stages: [{ workflowId: 'task-data-change', gate: 'none' }] } }
      await onCandidate(decision); return { status: 'submitted', decision }
    }
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const decision = { action: 'complete', summary: '已核对本次原文', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const { service, execution, message, root } = await fixture(t, 'owner', notices, { config, external, taskFiles: true, taskOwnerSessions })
  const received = await service.ingest(message), processed = await service.messages.process(received.runId)
  const original = processed.commands[0].result
  assert.equal(original.runId, null)
  await settleTaskOwners(service, service.execution); await service.flushNotifications()
  const ownerState = await execution.store.query({ kind: 'task.owner', taskId: original.taskId })
  assert.equal(ownerState.decision?.action, 'complete', JSON.stringify(ownerState))
  const originalPlan = await execution.controller.taskPlan(original.taskId)
  const originalEvidence = await execution.store.query({ kind: 'task.owner.query-evidence', taskId: original.taskId })
  const artifactPrefix = `tasks/${original.taskId}/`
  assert.ok(originalPlan.task.requirementRef.startsWith(artifactPrefix))
  assert.ok(originalEvidence.length)
  assert.ok(originalEvidence.every(item => item.artifactRef.startsWith(artifactPrefix)))
  const originalRegistry = createEngineeringRegistry({ repositories: config.repositories, ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }) })
  await originalRegistry.restore(execution.store, execution.artifacts)
  await originalRegistry.prepareTask({ taskId: original.taskId, arguments: { objective: '原开发任务', repositoryId: 'dataset', uatEnvironment: 'uat3', acceptanceCriteria: ['归一化结果为 1 t'] } },
    { commandId: 'old-engineering-definition', run: { actorId: 'owner' }, unit: {} }, { registerWorkflow() {} })
  const originalRecord = (await execution.store.query({ kind: 'workflow.list' })).find(record => record.config?.taskId === original.taskId)
  await git('push', remote, `HEAD:refs/heads/${originalRecord.config.head}`)
  const beforeMessages = await execution.store.query({ kind: 'message.list', limit: 200 })
  let sentBefore = sent
  const body = { requestId: 'rerun-request', expectedRunId: original.runId, objective: '修复归一化并提测', acceptanceCriteria: ['归一化结果为 1 t'],
    repositoryId: 'dataset', uatEnvironment: 'uat3', stages: ['task-engineering', 'task-uat-pr-merge', 'task-uat-deployment'],
    mergeTargetId: 'merge-uat3', deployTargetId: 'deploy-uat3' }
  const request = { ...body, action: 'rerun', taskId: original.taskId }, identity = { channel: 'web', actorId: 'owner' }
  await assert.rejects(service.submitWebTask(request, { channel: 'web', actorId: 'attacker' }), /FORBIDDEN/)
  await assert.rejects(service.submitWebTask({ ...request, uatEnvironment: undefined }, identity), /REQUEST_INVALID/)
  await assert.rejects(service.submitWebTask({ ...request, stages: ['task-main-pr-merge'] }, identity), /REQUEST_INVALID/)
  await assert.rejects(service.submitWebTask({ ...request, stages: undefined }, identity), /REQUEST_INVALID/)
  await assert.rejects(service.submitWebTask({ ...request, mergeTargetId: 'foreign' }, identity), /TARGET_NOT_ADMITTED/)
  await assert.rejects(service.submitWebTask({ ...request, uatEnvironment: 'uat2' }, identity), /TARGET_NOT_ADMITTED/)
  await assert.rejects(service.submitWebTask({ ...request, expectedRunId: 'stale-run' }, identity), /SOURCE_CHANGED/)
  const server = createServer((req, res) => handleRequest(req, res, { listTaskView: () => service.tasks(), isWorkflowTask: async () => true, submitWorkflowTask: value => service.submitWebTask(value, identity) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const post = (input, origin) => fetch(`http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/rerun`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(input) })
  assert.equal((await post(body, 'https://evil.example')).status, 403)
  assert.equal((await post({ ...body, actorId: 'owner' })).status, 400)
  const response = await post(body); assert.equal(response.status, 202)
  const accepted = await response.json()
  assert.notEqual(accepted.taskId, original.taskId); assert.equal(accepted.reportChannel, 'web')
  assert.equal(accepted.planningError, 'TASK_OWNER_STAGE_NOT_AUTHORIZED')
  assert.equal((await service.submitWebTask(request, identity)).taskId, accepted.taskId)
  assert.equal((await post({ ...body, objective: '冲突修改' })).status, 409)
  const origin = await execution.store.query({ kind: 'task.origin', taskId: accepted.taskId })
  assert.equal(origin.channel, 'web'); assert.equal(origin.rerunOfTaskId, original.taskId)
  const family = await execution.store.query({ kind: 'task.family', taskId: accepted.taskId })
  assert.equal(family.rootTaskId, original.taskId)
  assert.equal(origin.run.externalMessaging, false); assert.equal(origin.run.context.sourceMessageId, undefined)
  assert.equal(await execution.store.query({ kind: 'message.task', taskId: accepted.taskId }), null)
  assert.deepEqual(await execution.store.query({ kind: 'message.list', limit: 200 }), beforeMessages)
  assert.deepEqual(await execution.controller.taskPlan(original.taskId), originalPlan)
  const plan = await execution.controller.taskPlan(accepted.taskId), requirement = await execution.artifacts.read(plan.task.requirementRef)
  assert.ok(plan.task.requirementRef.startsWith(artifactPrefix))
  const requirementFile = join(root, 'tasks', original.taskId, 'work', 'artifacts', plan.task.requirementRef.split('/').at(-1))
  assert.deepEqual(JSON.parse(await readFile(requirementFile, 'utf8')), requirement)
  assert.deepEqual(requirement.stageTargets, { 'task-uat-pr-merge': 'merge-uat3', 'task-uat-deployment': 'deploy-uat3' })
  assert.equal(requirement.scope.conversationId, 'web:owner')
  assert.equal((await service.taskRuns(accepted.taskId)).taskId, accepted.taskId)
  const supplement = { action: 'context', taskId: accepted.taskId, requestId: 'supplement', inputVersion: 2, runSequence: 0, context: '补充检查单位换算边界' }
  await assert.rejects(service.submitWebTask(supplement, { channel: 'web', actorId: 'attacker' }), /FORBIDDEN/)
  await service.submitWebTask(supplement, identity); await service.submitWebTask(supplement, identity)
  await assert.rejects(service.submitWebTask({ ...supplement, context: '冲突' }, identity), /CONFLICT/)
  const updated = await execution.controller.taskPlan(accepted.taskId)
  assert.equal(updated.task.requirementRevision, 2)
  assert.ok(updated.task.requirementRef.startsWith(artifactPrefix))
  const updatedRequirement = await execution.artifacts.read(updated.task.requirementRef)
  assert.match(updatedRequirement.request, /补充检查单位換算边界|补充检查单位换算边界/)
  assert.equal(updatedRequirement.reportChannel, 'web'); assert.equal(updatedRequirement.externalMessaging, false)
  assert.deepEqual(updatedRequirement.stageTargets, requirement.stageTargets)
  // 独立 Web 任务沿真实控制器完成第一阶段，确认接口不能越过后续门禁。
  const confirmationSource = await service.ingest({ ...message, messageId: 'confirmation-source' })
  const confirmationProcessed = await service.messages.process(confirmationSource.runId)
  const confirmationBase = confirmationProcessed.commands[0].result
  assert.equal(confirmationBase.runId, null)
  await settleTaskOwners(service, service.execution)
  await service.flushNotifications(); sentBefore = sent
  await originalRegistry.prepareTask({ taskId: confirmationBase.taskId, arguments: { objective: '独立确认测试', repositoryId: 'dataset', uatEnvironment: 'uat3', acceptanceCriteria: ['确认'] } },
    { commandId: 'confirmation-engineering-definition', run: { actorId: 'owner' }, unit: {} }, { registerWorkflow() {} })
  const confirmationTask = await service.submitWebTask({ ...request, taskId: confirmationBase.taskId, expectedRunId: confirmationBase.runId, requestId: 'confirmation-task' }, identity)
  const confirmationAcceptance = await execution.store.query({ kind: 'task.owner.acceptance', taskId: confirmationTask.taskId })
  const confirmationWorkflow = { id: 'confirmation-operation-fixture', version: '1', ownerContract: {
    id: 'confirmation-operation-result', version: '1', validateCompletion: async ({ output }) => output.completed === true }, nodes: [{
      id: 'operation', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ requirement }) => requirement, execute: async ({ input }) => ({ completed: true, summary: input.request }) }] }
  execution.controller.registerWorkflow(confirmationWorkflow)
  await execution.controller.initializeTaskPlan({ commandId: 'confirmation-plan', taskId: confirmationTask.taskId,
    expectedPlanRevision: 0, expectedRequirementRevision: 1, stages: [
      { stageId: 'analysis', workflowId: confirmationWorkflow.id, input: { request: '确认前序产物' } },
      { stageId: 'merge', workflowId: confirmationWorkflow.id, gate: 'confirmation' },
      { stageId: 'deploy', workflowId: confirmationWorkflow.id, gate: 'confirmation' },
    ] })
  const firstStage = await execution.controller.advanceTaskPlan(confirmationTask.taskId)
  await execution.controller.whenIdle(firstStage.stages[0].runId)
  assert.equal((await execution.controller.state(firstStage.stages[0].runId)).run.status, 'succeeded', JSON.stringify(await execution.controller.state(firstStage.stages[0].runId)))
  const waiting = await execution.controller.advanceTaskPlan(confirmationTask.taskId)
  const taskViews = await (await fetch(`http://127.0.0.1:${server.address().port}/state/tasks`)).json()
  const binding = taskViews.find(task => task.taskId === confirmationTask.taskId).stageConfirmation
  assert.deepEqual(binding, { requirementRevision: waiting.task.requirementRevision, controlRevision: waiting.task.controlRevision,
    planRevision: waiting.task.planRevision, runSequence: 1, stageId: 'merge', outputRef: waiting.stages[0].outputRef })
  assert.equal(taskViews.find(task => task.taskId === original.taskId).stageConfirmation, null)
  const confirmBody = { requestId: 'confirm-current', ...binding,
    confirmationText: '明确确认当前合并阶段及其流水线通知；后续部署另行确认。' }
  const confirm = (body, originHeader) => fetch(`http://127.0.0.1:${server.address().port}/tasks/${confirmationTask.taskId}/confirm-stage`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(originHeader ? { origin: originHeader } : {}) }, body: JSON.stringify(body) })
  const confirmRequest = { ...confirmBody, action: 'confirm-stage', taskId: confirmationTask.taskId }
  assert.equal((await confirm(confirmBody, 'https://evil.example')).status, 403)
  assert.equal((await confirm({ ...confirmBody, actorId: 'owner' })).status, 400)
  await assert.rejects(service.submitWebTask(confirmRequest, { channel: 'web', actorId: 'attacker' }), /FORBIDDEN/)
  for (const change of [{ requirementRevision: 9 }, { controlRevision: 9 }, { planRevision: 9 }, { runSequence: 0 },
    { stageId: 'deploy' }, { outputRef: 'sha256-foreign.json' }]) {
    assert.equal((await confirm({ ...confirmBody, ...change })).status, 409)
  }
  await assert.rejects(service.submitWebTask({ ...confirmRequest, taskId: accepted.taskId }, identity), /CONFLICT|STALE/)
  const ownerBeforeConfirmation = await execution.store.query({ kind: 'task.owner', taskId: confirmationTask.taskId })
  assert.equal((await confirm(confirmBody)).status, 202)
  assert.equal((await confirm(confirmBody)).status, 202)
  assert.equal((await confirm({ ...confirmBody, confirmationText: '不同授权' })).status, 409)
  const confirmed = await execution.controller.taskPlan(confirmationTask.taskId)
  assert.equal(confirmed.stages[1].status, 'ready'); assert.equal(confirmed.stages[1].runId, null)
  assert.equal(confirmed.stages[2].status, 'blocked'); assert.equal(confirmed.stages[2].runId, null)
  assert.equal(confirmed.task.requirementRevision, waiting.task.requirementRevision)
  const afterConfirmViews = await (await fetch(`http://127.0.0.1:${server.address().port}/state/tasks`)).json()
  assert.equal(afterConfirmViews.find(task => task.taskId === confirmationTask.taskId).stageConfirmation, null)
  const ownerAfterConfirmation = await execution.store.query({ kind: 'task.owner', taskId: confirmationTask.taskId })
  assert.equal(ownerAfterConfirmation.inputFenceRevision, ownerBeforeConfirmation.inputFenceRevision + 1)
  assert.equal(ownerAfterConfirmation.status, 'pending')
  const confirmationEventId = `web-input:${executionDigest(['owner', confirmationTask.taskId, confirmBody.requestId])}`
  const confirmationEvent = await execution.store.query({ kind: 'task.web-input', eventId: confirmationEventId })
  assert.equal(confirmationEvent.status, 'accepted'); assert.equal(confirmationEvent.actorId, 'owner')
  assert.equal(confirmationEvent.request.confirmationText, confirmBody.confirmationText)
  // 已接纳但尚未应用的确认必须在新要求到达后拒绝，不能跨版本生效。
  await assert.rejects(execution.controller.confirmTaskStage({ commandId: 'stale-requirement-confirm', taskId: confirmationTask.taskId,
    stageId: 'deploy', planRevision: confirmed.task.planRevision, expectedControlRevision: confirmed.task.controlRevision,
    expectedRequirementRevision: confirmed.task.requirementRevision + 1, outputRef: confirmed.stages[0].outputRef }), /TASK_REQUIREMENT_STALE/)
  await execution.controller.bindTaskStageInput({ commandId: 'confirmation-bind-second', taskId: confirmationTask.taskId,
    planRevision: confirmed.task.planRevision, stageId: 'merge', predecessorOutputRef: confirmed.stages[0].outputRef,
    input: { request: '仅测试阶段产物' } })
  const secondStage = await execution.controller.advanceTaskPlan(confirmationTask.taskId)
  await execution.controller.whenIdle(secondStage.stages[1].runId)
  const nextWaiting = await execution.controller.advanceTaskPlan(confirmationTask.taskId)
  assert.equal(nextWaiting.stages[2].status, 'waiting_confirmation')
  const recoveredConfirmation = { ...confirmRequest, requestId: 'confirm-after-restart', runSequence: 2,
    stageId: 'deploy', outputRef: nextWaiting.stages[1].outputRef, confirmationText: '单独确认当前部署阶段。' }
  const recoveredConfirmationId = `web-input:${executionDigest(['owner', confirmationTask.taskId, recoveredConfirmation.requestId])}`
  await execution.store.command({ id: `web-prepare:${recoveredConfirmationId}`, kind: 'task.web-input.prepare', args: {
    eventId: recoveredConfirmationId, actorId: 'owner', request: recoveredConfirmation, input: null } })
  const cancel = { action: 'cancel', taskId: accepted.taskId, requestId: 'cancel-after-restart', inputVersion: 3, runSequence: 0, reason: '停止重执行' }
  const cancelEventId = `web-input:${executionDigest(['owner', accepted.taskId, cancel.requestId])}`
  await assert.rejects(execution.store.command({ id: 'bad-web-actor', kind: 'task.web-input.prepare', args: {
    eventId: 'bad-event', actorId: 'attacker', request: cancel, input: null } }), /FORBIDDEN/)
  await execution.store.command({ id: `web-prepare:${cancelEventId}`, kind: 'task.web-input.prepare', args: {
    eventId: cancelEventId, actorId: 'owner', request: cancel, input: null } })
  await service.close()
  const restarted = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', ...config },
    judge: async () => { throw new Error('UNEXPECTED_MESSAGE') },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'], workspaceDir: root }), getGroup: groupId => ({ groupId, messages: [] }) },
    execution, external, notifications: notices, taskOwnerSessions: { async run({ input, onSessionBound, onCandidate }) {
      if (input.task.controlState !== 'active' || input.stages.length) throw new Error('OWNER_WAITING')
      await onSessionBound()
      const decision = { action: 'advance', summary: '按明确的开发和UAT交付阶段执行', evidenceRefs: [],
        planChange: { kind: 'initialize', stages: input.goal.explicitStages.map(workflowId => ({ workflowId, gate: 'none' })) } }
      await onCandidate(decision); return { status: 'submitted', decision }
    }, async close() {} } })
  t.after(() => restarted.close())
  assert.equal((await restarted.submitWebTask(confirmRequest, identity)).status, 'accepted')
  await restarted.recoverExecutionTasks(); await restarted.flushNotifications()
  assert.equal((await execution.store.query({ kind: 'task.web-input', eventId: recoveredConfirmationId })).status, 'accepted')
  const recoveredPlan = await execution.controller.taskPlan(confirmationTask.taskId)
  assert.equal(recoveredPlan.stages[2].status, 'ready'); assert.equal(recoveredPlan.stages[2].runId, null)
  assert.equal((await restarted.submitWebTask(recoveredConfirmation, identity)).status, 'accepted')
  assert.equal((await execution.controller.taskPlan(accepted.taskId)).task.controlState, 'cancelled')
  assert.equal((await execution.store.query({ kind: 'task.web-input', eventId: cancelEventId })).status, 'accepted')
  await restarted.submitWebTask(cancel, identity)
  await assert.rejects(restarted.submitWebTask({ ...cancel, reason: '另一个请求' }, identity), /CONFLICT/)
  assert.equal((await restarted.submitWebTask(request, identity)).taskId, accepted.taskId)
  assert.equal((await restarted.tasks()).find(task => task.taskId === accepted.taskId).sourceChannel, 'web')
  assert.equal(sent, sentBefore)
  assert.throws(() => sendWorkflowNotification(notices, { id: 'forbidden', payload: { reportChannel: 'web', conversationId: 'g', text: '不可外发' } }), /WEB_NOTIFICATION_FORBIDDEN/)
  await assert.rejects(restarted.submitWebTask({ ...request, requestId: 'old-root-rerun' }, identity), /TASK_EXECUTION_STALE/)
  const development = await restarted.submitWebTask({ ...request, taskId: accepted.taskId, expectedRunId: null, requestId: 'real-branch-rerun' }, identity)
  assert.equal(development.planningError, null)
  assert.ok(development.runId)
  await execution.controller.whenIdle(development.runId)
  const newRecord = (await execution.store.query({ kind: 'workflow.list' })).find(record => record.config?.taskId === development.taskId)
  assert.equal(newRecord.config.head, originalRecord.config.head)
  assert.equal(newRecord.config.branchSource.taskId, original.taskId)
  assert.equal(newRecord.config.input.baseCommit, await git('rev-parse', 'HEAD'))
  assert.equal((await execution.store.query({ kind: 'task.family', taskId: development.taskId })).rootTaskId, original.taskId)
  assert.equal(newRecord.config.taskFiles.logicalTaskId, original.taskId)
  assert.equal(newRecord.config.taskFiles.root, join(root, 'tasks', original.taskId))
  for (const area of ['work', 'tmp', 'outputs']) assert.equal(newRecord.config.taskFiles[area], join(root, 'tasks', original.taskId, area))
  const developmentPlan = await execution.controller.taskPlan(development.taskId)
  assert.ok(developmentPlan.task.requirementRef.startsWith(artifactPrefix))
  assert.ok(developmentPlan.stages[0].requirementRef.startsWith(artifactPrefix))
  assert.equal((await execution.controller.taskPlan(development.taskId)).stages.length, 3)
  const view = (await restarted.tasks()).find(task => task.taskId === development.taskId)
  await assert.rejects(restarted.submitWebTask({ ...request, taskId: development.taskId, expectedRunId: development.runId,
    requestId: 'reject-active-source' }, identity), /SOURCE_CHANGED|SOURCE_NOT_COMPLETED/)
  await restarted.submitWebTask({ action: 'cancel', taskId: development.taskId, requestId: 'stop-development',
    inputVersion: view.inputVersion, runSequence: view.runSequence, reason: '本地验收结束' }, identity)
  await execution.controller.whenIdle(development.runId)
  assert.equal((await execution.controller.state(development.runId)).run.status, 'cancelled')
  await restarted.flushNotifications(); assert.equal(sent, sentBefore)
})

test('I 只能提交目标：Task 与 Owner 原子接纳，Owner 未建计划前没有业务 Run', async t => {
  const taskOwnerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    assert.equal(input.stages.length, 0)
    assert.equal(input.task.planRevision, 0)
    assert.equal(input.goal.request, '整理本条材料')
    const decision = { action: 'wait', summary: '等待明确下一步', evidenceRefs: [], condition: { kind: 'business-input', missing: '下一步目标', responsibleParty: '交办人', resumeWhen: '明确目标后继续', evidenceRefs: [] } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions })
  assert.equal(messageSchemas.I.safeParse({ kind: 'intent', actions: [{ intent: 'create',
    arguments: { objective: '整理本条材料', workflowPlan: [{ workflowId: 'task-investigation', gate: 'none' }] }, dependsOn: [] }],
  constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }).success, false)
  const accepted = await service.ingest(message)
  const state = await service.messages.process(accepted.runId)
  assert.equal(state.commands[0].status, 'applied')
  const taskId = state.commands[0].result.taskId
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.planRevision, 0)
  assert.deepEqual(plan.stages, [])
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
  assert.ok((await execution.store.query({ kind: 'task.owner', taskId })).sessionId)
})

test('真实同库消息接纳→固定Task执行→看板结果；重复入站不重复创建', async t => {
  const { service, execution, message } = await fixture(t)
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  const state = await service.state(accepted.runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(state.commands.length, 1)
  const topic=(await service.topics('g'))[0]
  assert.ok(topic)
  assert.equal((await service.mailboxes()).messages[0].topicRefs[0].topicId,topic.topicId)
  assert.equal((await service.topicContext({groupId:'g',topicId:topic.topicId})).messages[0].messageId,message.messageId)
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId: state.commands[0].result.taskId }), [])
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  const tasks = await service.tasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].state, 'completed')
  assert.equal(tasks[0].outcome, 'succeeded')
  assert.match(tasks[0].result, /已分析/)
  assert.equal((await service.ingest(message)).duplicate, true)
  assert.equal((await service.tasks()).length, 1)
})

test('没有 Owner 的已成功问答计划显示完成，结果中的未知不制造等待；确认阶段仍等待', async t => {
  const { service, execution } = await fixture(t, 'owner', undefined, {
    execute: async () => ({ summary: '现有信息无法确认账号创建人', limitations: ['缺少创建记录'] }),
  })
  execution.controller.registerWorkflow({ id: 'historical-answer-fixture', version: '1', nodes: [{ id: 'analyze', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '现有信息无法确认账号创建人', limitations: ['缺少创建记录'] }) }] })
  for (const confirmation of [false, true]) {
    const taskId = confirmation ? 'question-with-next-stage' : 'answered-question'
    await execution.controller.createTaskPlan({ commandId: `create-${taskId}`, taskId, stages: [
      { stageId: 'answer', workflowId: 'historical-answer-fixture', input: { request: '这个账号是你创建的吗？', materials: [], constraints: [], acceptanceCriteria: [], scope: {}, context: {} } },
      ...(confirmation ? [{ stageId: 'next', workflowId: 'historical-answer-fixture', gate: 'confirmation' }] : []),
    ] })
    let plan = await execution.controller.advanceTaskPlan(taskId)
    await execution.controller.whenIdle(plan.stages[0].runId)
    plan = await execution.controller.advanceTaskPlan(taskId)
    const before = await execution.store.query({ kind: 'run.list', taskId })
    const task = (await service.tasks()).find(item => item.taskId === taskId)
    assert.equal(plan.task.status, confirmation ? 'waiting_confirmation' : 'succeeded', JSON.stringify(await execution.controller.state(plan.stages[0].runId)))
    assert.equal(task.taskOwner, null)
    assert.equal(task.state, confirmation ? 'waiting' : 'completed')
    assert.equal(task.outcome, confirmation ? undefined : 'succeeded')
    assert.equal(task.waitingReason, confirmation ? '等待阶段确认' : undefined)
    assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), before)
    if (!confirmation) assert.match(task.result, /无法确认/)
  }
})

for (const [scenario, validWrite, expectedComplete, native = false, expectedFailure = 'TASK_OWNER_COMPLETION_UNVERIFIED'] of [
  ['无关备忘录不能证明生产修复', false, false], ['同项有效保存完成', true, true],
  ['引用调查不足产物不能完成保存项', true, false, true], ['业务检查返回错项不能完成', true, false],
  ['默认原生领域检查拒绝备忘录冒充生产修复', false, false, true], ['默认原生领域检查接纳有效保存并持久化凭证', true, true, true],
  ['原生领域模型非正常结束保留系统原因', false, false, true, 'DOMAIN_ACCEPTANCE_MODEL_INCOMPLETE'],
  ['原生领域模型配置故障保留系统原因', false, false, true, 'DOMAIN_ACCEPTANCE_CONFIGURATION_MISSING'],
  ['原生领域合法未核验保留实际判定工件', false, false, true],
]) test(`混合调查与写入通过真实服务Owner门禁：${scenario}`, async t => {
  const temporary = join(process.cwd(), 'docs', 'tmp')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'workflow-mixed-acceptance-'))
  const criterion = validWrite ? '调查记录已保存为 Markdown 文档' : '生产故障已修复并验证不再复现'
  const objective = validWrite ? '调查故障并保存 Markdown 文档' : '修复生产故障并保存 Markdown 文档'
  const content = '# 调查备忘录\n\n故障仍存在，尚未实施生产修复。\n'
  const semanticChecks = [], failures = [], rejectedErrors = []
  const statusServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: 'unresolved' }))
  })
  await new Promise(resolve => statusServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => statusServer.close(resolve)))
  let queryRef, diagnosticsRead = 0
  const ownerSessions = { async run({ binding, input, tools, queryInput, readArtifact, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound()
    const initialize = !input.stages.length
    if (initialize) {
      const tool = tools.find(item => item.name === 'query_runtime_status')
      const query = await tool.execute({ binding, input: queryInput, args: { resourceId: 'mixed-health' } })
      const identity = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key,binding[key]]))
      await onQueryEvidence({ binding: identity, evidenceRef: query.evidenceRef })
      queryRef = query.evidenceRef
      assert.equal(query.result.values.status, 'unresolved')
    }
    const complete = !initialize && input.stages.every(stage => stage.status === 'succeeded')
    const evidenceRefs = complete ? [scenario === '引用调查不足产物不能完成保存项' ? queryRef : input.stages[0].outputRef] : [queryRef]
    if (complete && evidenceRefs.includes(queryRef)) await readArtifact(queryRef)
    const decision = { action: initialize || input.stages.some(stage => ['ready','running'].includes(stage.status)) ? 'advance' : complete ? 'complete' : 'wait',
      summary: complete ? '声明目标已完成' : '已直接调查，保存文档', evidenceRefs,
      ...(initialize ? { planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-general-capability', gate: 'none', capabilityStep: {
          capabilityId: 'write-task-markdown', input: { content }, expectedEvidence: '独立回读 Markdown 文档' } },
      ] } } : {}),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) } : {}) }
    try { await onCandidate(decision) }
    catch (error) {
      rejectedErrors.push(error)
      if (error.ownerDiagnosticRef) {
        assert.equal((await readArtifact(error.ownerDiagnosticRef)).kind,'domain-acceptance-rejection')
        diagnosticsRead++
      }
      throw error
    }
    return { status: 'submitted', decision }
  }, async close() {} }
  const assess = async input => {
    semanticChecks.push(input)
    assert.deepEqual(input.acceptanceItems.map(item => item.criterion), [criterion])
    assert.equal(input.acceptanceItems[0].itemId, 'acceptance-1')
    assert.equal(input.evidence.length, 1)
    assert.deepEqual(input.acceptanceItems[0].evidenceRefs, [input.evidence[0].evidenceId])
    const writtenPath = input.evidence[0].output?.result?.path
    if (writtenPath) assert.equal(await readFile(writtenPath, 'utf8'), content)
    else { assert.equal(input.evidence[0].result.values.status, 'unresolved'); assert.ok(input.evidence[0].hostQuery.taskId) }
    const satisfied = validWrite && !!writtenPath
    return { status: satisfied ? 'satisfied' : 'unsatisfied', resultVerified: satisfied,
      criteria: [{ criterion: scenario === '业务检查返回错项不能完成' ? '另一项未经委托的标准' : criterion,
        passed: satisfied, evidenceIds: [input.evidence[0].evidenceId] }] }
  }
  const nativeLlm = { async *stream(request) {
    assert.deepEqual(request.tools, [])
    assert.equal(request.maxTokens, undefined)
    assert.match(request.system, /不能证明生产修复/)
    const input = JSON.parse(request.messages[0].content[0].text)
    assert.equal(input.request, objective)
    if (expectedFailure === 'DOMAIN_ACCEPTANCE_CONFIGURATION_MISSING') {
      semanticChecks.push(input)
      throw Object.assign(new Error('验收模型配置缺失'), { code: 'DOMAIN_ACCEPTANCE_CONFIGURATION_MISSING' })
    }
    const result = await assess(input)
    if (scenario === '原生领域合法未核验保留实际判定工件') result.criteria[0].reason = '当前证据尚未证明生产修复'
    if (scenario === '原生领域合法未核验保留实际判定工件') result.status = 'unverified'
    yield { type: 'text-delta', text: JSON.stringify(result) }
    yield { type: 'finish', reason: { kind: expectedFailure === 'DOMAIN_ACCEPTANCE_MODEL_INCOMPLETE' ? 'length' : 'stop' } }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    root, taskFiles: true, taskOwnerSessions: ownerSessions, config: { taskOutputDirectory: join(root, 'files'),
      directQueries: { resources: [], databases: [], statusResources: [{ id: 'mixed-health',
        url: `http://127.0.0.1:${statusServer.address().port}/health`, fields: ['status'] }],
        permissions: { resourceIds: [], databaseIds: [], statusIds: ['mixed-health'] } } },
    deliveryOptions: { fileAdapter: createTaskMarkdownFileAdapter({ root: join(root, 'files'), getTaskDirectories: taskId => ({ outputs: join(root,'tasks',taskId,'outputs') }) }), authorize: async () => null,
      authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
        ? { principalId: 'owner', authorizationRef: 'fixture-write-grant' } : null },
    judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective, acceptanceCriteria: [criterion] }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' },
    ...(native ? { ctx: { llm: nativeLlm }, generalCompletionCheck: null } : { generalCompletionCheck: assess }),
  })
  const accepted = await service.ingest({ ...message, text: objective })
  const state = await service.messages.process(accepted.runId)
  assert.equal(state.commands[0].status, 'applied', JSON.stringify(state.commands[0]))
  const taskId = state.commands[0].result.taskId
  for (let attempt = 0; attempt < 8; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages) if (stage.runId) await execution.controller.whenIdle(stage.runId)
    failures.push(...(await settleTaskOwners(service, service.execution)).failures)
    const owner = await execution.store.query({ kind: 'task.owner', taskId })
    if (owner.decision?.action === 'complete' || owner.lastFailure === expectedFailure) break
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 1, JSON.stringify({ plan, failures, owner: await execution.store.query({ kind: 'task.owner', taskId }) }))
  assert.ok(plan.stages.every(stage => stage.status === 'succeeded'), JSON.stringify({ plan, failures, state:await execution.controller.state(plan.stages[0].runId) }))
  const investigation = await execution.artifacts.read(queryRef)
  assert.equal(investigation.result.values.status, 'unresolved')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
  const output = await execution.artifacts.read(plan.stages[0].outputRef)
  assert.equal(output.verification.passed, true)
  assert.equal(await readFile(output.output.result.path, 'utf8'), content)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision?.action === 'complete', expectedComplete, JSON.stringify({ owner, failures }))
  assert.equal(semanticChecks.length, 1, '混合任务仅在最终统一验收时执行一次业务检查')
  const manifestRecord = await execution.store.query({ kind: 'task.owner.delivery-manifest', taskId })
  if (expectedComplete) {
    assert.deepEqual(failures, [])
    assert.ok(manifestRecord?.ref)
    const manifest = await execution.artifacts.read(manifestRecord.ref)
    assert.equal(manifest.businessValidation.status, 'accepted')
    assert.equal(manifest.businessValidation.policy, 'domain-items-v1')
    assert.equal(manifest.businessValidation.items.length, 1)
    assert.equal(manifest.businessValidation.items[0].itemId, 'acceptance-1')
  } else {
    assert.equal(owner.lastFailure, expectedFailure, JSON.stringify({ owner, failures }))
    if (expectedFailure.startsWith('DOMAIN_ACCEPTANCE_')) {
      assert.equal(owner.lastFailure, expectedFailure)
      assert.notEqual(owner.decision?.condition?.kind, 'business-input')
      assert.ok(!failures.some(item => item.code === 'TASK_OWNER_COMPLETION_UNVERIFIED'))
    }
    if (native && expectedFailure === 'TASK_OWNER_COMPLETION_UNVERIFIED') {
      assert.equal(diagnosticsRead,1,'原生最终拒绝诊断本轮可直接读取，以便在原会话纠正')
      const rejection = rejectedErrors.find(error => error.message.includes('原始验收结果与证据：'))
      assert.ok(rejection, rejectedErrors.map(error => error.message).join('\n'))
      const diagnosticRef = rejection.message.split('原始验收结果与证据：')[1]
      const diagnostic = await execution.artifacts.read(diagnosticRef)
      assert.equal(diagnostic.kind, 'domain-acceptance-rejection')
      assert.equal(diagnostic.taskId, taskId)
      assert.equal(diagnostic.assessment.status, scenario === '原生领域合法未核验保留实际判定工件' ? 'unverified' : 'unsatisfied')
      assert.equal(diagnostic.assessment.criteria[0].criterion, criterion)
      if (scenario === '原生领域合法未核验保留实际判定工件') {
        assert.equal(diagnostic.assessment.criteria[0].reason, '当前证据尚未证明生产修复')
        assert.match(rejection.message, /当前证据尚未证明生产修复/u)
      }
      if (scenario === '引用调查不足产物不能完成保存项') {
        assert.equal(diagnostic.evidence[0].hostQuery.taskId,taskId)
        assert.equal(diagnostic.evidence[0].evidenceId,queryRef)
      } else {
        assert.equal(diagnostic.evidence[0].hostExecution.runId, plan.stages[0].runId)
        assert.equal(diagnostic.evidence[0].evidenceId, plan.stages[0].outputRef)
        assert.ok(diagnostic.evidence[0].hostExecution.nodes.length)
        const stage = plan.stages[0]
        const contract = execution.controller.workflowDefinition(stage.workflowId, stage.workflowDigest).ownerContract
        const items = await execution.store.query({ kind: 'task.owner.acceptance', taskId })
        const directOutput = { ...output, hostExecution: { taskId: 'forged-task' } }
        assert.equal(await contract.validateCompletion({ output: directOutput, stage,
          requirement: { request: objective, acceptanceCriteria: [criterion], constraints: [], scope: {} },
          decision: { summary: '核对已保存文档', evidenceRefs: [stage.outputRef] },
          stages: [{ stage, output: directOutput, contractId: contract.id }],
          acceptanceItems: items.map(item => ({ itemId: item.itemId, criterion: item.criterion, evidenceRefs: [stage.outputRef] })) }), false,
        '普通能力合同调用保留合法拒绝，不依据伪造hostExecution写Owner诊断或抛新增错误')
        assert.equal(semanticChecks.at(-1).evidence[0].hostExecution, undefined,
          '非Owner路径在送入领域模型前移除外部伪造的hostExecution')
      }
    }
    assert.equal(manifestRecord, null)
  }
})

for (const workflowVersion of ['4', '5']) test(`正式服务重启恢复通用 v${workflowVersion} 成功前序且新任务使用 v6`, async t => {
  const temporary = join(process.cwd(), 'docs', 'tmp')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'general-version-restart-'))
  const dbPath = join(root, 'control.db'), artifactDirectory = join(root, 'artifacts'), taskOutputDirectory = join(root, 'files')
  const model = { provider: 'test', model: 'test' }
  const store = await openExecutionStore({ dbPath, instanceId: 'general-restart', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
  const fileAdapter = createTaskMarkdownFileAdapter({ root: taskOutputDirectory })
  const artifactAdapter = createTaskArtifactWriteAdapter({ files: createTaskArtifactFiles({ root: join(artifactDirectory, 'task-files') }) })
  const workflow = createGeneralCapabilityStepWorkflow({ capabilities: [createGeneralMarkdownWriteCapability({ fileAdapter }),
    createGeneralArtifactWriteCapability({ fileAdapter: artifactAdapter })],
    completionIdentity: 'task-result-verification-v3', workflowVersion })
  const definition = defineExecutionWorkflow(workflow)
  const delivery = createExecutionDelivery({ store, artifacts, fileAdapter, authorize: async () => null,
    authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
      ? { principalId: 'owner', authorizationRef: 'fixture-write-grant' } : null })
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.command({ id: 'old-definition', kind: 'workflow.register', args: { workflowId: workflow.id,
    definitionVersion: workflowVersion, digest: definition.digest, config: model } })
  const content = `# v${workflowVersion} 已保存产物\n`
  await controller.createTaskPlan({ commandId: 'old-plan', taskId: 'old-task', stages: [{ stageId: 'write', workflowId: workflow.id,
    input: { capabilityId: 'write-task-markdown', input: { content }, scope: { writeMarkdown: true }, expectedEvidence: '文件回读' } }] })
  await store.command({ id: 'old-owner', kind: 'task.owner.init', args: { taskId: 'old-task', sessionId: 'old-owner', sourceKey: 'old-source', criteria: ['产物已保存'] } })
  const started = await controller.advanceTaskPlan('old-task')
  const runId = started.stages[0].runId
  await controller.whenIdle(runId)
  const before = await controller.advanceTaskPlan('old-task')
  assert.equal(before.stages[0].status, 'succeeded')
  const output = await artifacts.read(before.stages[0].outputRef)
  assert.equal(await readFile(output.output.result.path, 'utf8'), content)
  const effectsBefore = await store.query({ kind: 'effect.list', runId })
  await controller.close(); await store.close()
  service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', dbPath, artifactDirectory,
    taskOutputDirectory, instanceId: 'general-restart' }, legacy: { getAgentConfig: () => model },
    judge: async () => { throw Error('UNEXPECTED_MODEL') }, taskOwnerSessions: { async close() {} } })
  const restored = service.execution.controller.workflowDefinition(workflow.id, definition.digest)
  assert.equal(restored.version, workflowVersion)
  assert.equal(restored.digest, definition.digest)
  assert.equal(service.execution.controller.workflowDefinition(workflow.id).version, '6')
  assert.deepEqual(await service.execution.controller.taskPlan('old-task'), before)
  assert.deepEqual(await service.execution.artifacts.read(before.stages[0].outputRef), output)
  assert.deepEqual(await service.execution.store.query({ kind: 'effect.list', runId }), effectsBefore)
  assert.equal(await readFile(output.output.result.path, 'utf8'), content)
})

test('流程成功后由同一Task负责人验收并只汇报一次最终结果', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true,
    send: async notice => { sent.push(notice.payload.text); return { messageId: `reply-${sent.length}` } },
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications)
  const received = await service.ingest(message)
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, 1)
  assert.equal((await service.tasks())[0].taskOwner.decision, 'complete')
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, 1)
})

test('最终报告领取前新增目标使旧完成通知失效，已完成流程不重跑', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true,
    send: async notice => { sent.push(notice.payload.text); return { messageId: `reply-${sent.length}` } },
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications)
  const received = await service.ingest(message)
  const state = await service.messages.process(received.runId)
  const taskId = state.commands[0].result.taskId
  assert.equal(state.commands[0].result.runId, null)
  await execution.store.command({ id: 'new-goal-event', kind: 'task.owner.event',
    args: { taskId, eventKey: 'new-goal-event', eventType: 'intent.received' } })
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, 0)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 0)
})

test('任务静默承接后仅交付最终报告，仍可按精确身份纠正', async t => {
  let serial = 0
  const recalls = []
  const notifications = { canDisclose: async () => true,
    send: async () => ({ messageId: `reply-${++serial}` }),
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }),
    recall: async request => { recalls.push(request.messageId); return { recallStatus: 'SUCCESS' } },
    readbackRecall: async request => ({ messageId: request.messageId, conversationId: 'g', recallStatus: 'SUCCESS' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message)
  const state = await service.messages.process(received.runId)
  await service.flushNotifications()
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  const delivered = await execution.store.query({ kind: 'message.notifications', states: ['delivered'] })
  const receipt = delivered.find(item => item.payload.phase === 'accepted')
  const final = delivered.find(item => item.payload.text.startsWith('任务已完成'))
  assert.equal(receipt, undefined)
  assert.ok(final)
  const auth = await service.ingest({ ...message, messageId: 'correct-final-only',
    text: `撤回通知 ${final.id}` })
  const authSource = (await execution.store.query({ kind: 'message.run', runId: auth.runId })).run.sourceKey
  const prepared = await service.prepareWorkflowNotificationOperation({ operationId: 'correct-final-only',
    notificationId: final.id, type: 'recall', reason: 'correction', authorizationRef: authSource })
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })).status, 'completed')
  const outbox = (await service.mailboxes()).outbox
  assert.equal(outbox.find(item => item.outboundId === final.id).recallStatus, 'recalled')
  assert.deepEqual(recalls, [final.ack.messageId])
})

for (const change of ['requirement', 'acceptance']) test(`报告重写不能复用${change}变化前的最终验收`, async t => {
  let completed = false
  const ownerSessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    if (completed) return { status: 'no_submission' }
    await onSessionBound()
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    for (const ref of refs) await readArtifact(ref)
    const decision = { action: 'complete', summary: '原始目标已完成', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); completed = true; return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['首次任务'] }
      : { kind: 'intent', actions: input.text === '报告改成中文'
        ? [{ intent: 'report', arguments: { language: 'zh-CN' }, dependsOn: [] }]
        : [{ intent: 'create', arguments: { objective: '整理本条材料' }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: ownerSessions })
  const first = await service.ingest({ ...message, text: '整理本条材料' })
  const initial = await service.messages.process(first.runId)
  await settleTaskOwners(service, service.execution)
  const taskId = initial.commands[0].result.taskId
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.action, 'complete')
  const plan = await execution.controller.taskPlan(taskId)
  if (change === 'requirement') {
    const goal = await execution.artifacts.read(plan.task.requirementRef)
    const updated = await execution.artifacts.put({ ...goal, request: '新增未完成业务目标' }, { taskId })
    await execution.store.command({ id: 'new-requirement', kind: 'task.requirement.update', args: {
      taskId, expectedRequirementRevision: plan.task.requirementRevision, requirementRef: updated.ref, eventKey: 'new-requirement' } })
  } else await execution.store.command({ id: 'new-acceptance', kind: 'task.owner.acceptance.extend', args: {
    taskId, itemId: 'new-item', criterion: '新增未验收条件', sourceKey: 'new-source', eventKey: 'new-acceptance' } })
  const next = await service.ingest({ ...message, messageId: 'new-report', text: '报告改成中文' })
  const state = await service.messages.process(next.runId)
  assert.equal(state.commands[0].status, 'unknown', JSON.stringify(state.commands[0]))
  assert.equal(state.commands[0].error, 'TASK_REPORT_NOT_READY')
})

test('仅把已完成任务报告改成中文只唤醒Owner，不重跑排查或新增Run', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true,
    send: async notice => { sent.push(notice.payload.text); return { messageId: `report-${sent.length}` } },
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['首次任务'] }
      : input.text.includes('报告改成中文')
        ? { kind: 'intent', actions: [{ intent: 'report', arguments: { language: 'zh-CN' }, dependsOn: [] }],
          constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '排查已给材料' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge })
  const first = await service.ingest({ ...message, text: '排查已给材料' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  assert.equal(accepted.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  const priorFinals = sent.filter(item => item.startsWith('任务已完成')).length
  const priorReports = await execution.store.query({ kind: 'task.owner.reports', taskId })
  const next = await service.ingest({ ...message, messageId: 'report-only', text: '报告改成中文' })
  const result = await service.messages.process(next.runId)
  assert.equal(result.commands[0].status, 'applied', JSON.stringify(result.commands[0]))
  assert.equal(result.commands[0].result.taskId, taskId)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 0)
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, priorFinals + 1)
  const reports = await execution.store.query({ kind: 'task.owner.reports', taskId })
  assert.equal(reports.filter(item => item.reportType === 'complete').length,
    priorReports.filter(item => item.reportType === 'complete').length + 1)
  const events = await execution.store.query({ kind: 'task.owner.events', taskId, limit: 20 })
  const language = events.find(item => item.eventType === 'report.preference.changed')
  assert.deepEqual(await execution.artifacts.read(language.payloadRef), {
    language: 'zh-CN', sourceRunId: next.runId, actorId: 'owner' })
})

test('Owner事件引用完整正文后推进同一Task水位，不重复内联正文', async t => {
  let largestEventCount = 0
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readPage, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    const events = [...input.events]
    assert.equal(input.eventPages,undefined)
    largestEventCount=Math.max(largestEventCount,events.length)
    for(const event of events.filter(item=>item.payloadRef)) { assert.equal(event.payload,undefined); const payload=await readArtifact(event.payloadRef); if(payload.text) assert.equal(payload.text,'积压事件原文'.repeat(180)) }
    assert.equal(events.at(-1).eventSeq, input.eventWatermark)
    const evidenceRefs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const decision = { action: 'complete', summary: '任务完成', evidenceRefs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest(message)
  const created = await service.messages.process(received.runId)
  const taskId = created.commands[0].result.taskId
  assert.equal(created.commands[0].result.runId, null)
  const payload = await execution.artifacts.put({ text: '积压事件原文'.repeat(180) })
  for (let index = 0; index < 120; index++) await execution.store.command({
    id: `backlog-${index}`, kind: 'task.owner.event', args: { taskId,
      eventKey: `backlog-${index}`, eventType: 'intent.received', payloadRef: payload.ref } })
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.ok(largestEventCount >= 120)
  assert.equal(owner.processedWatermark, owner.eventWatermark)
  assert.equal(owner.decision.action, 'complete')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 0)
})

test('账号问题与“这不是让你去查吗”回到同一Task，不重建或丢失原上下文', async t => {
  let followupInput
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原账号问题'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['首次问题'] }
    if (input.text.includes('这不是让你去查吗')) {
      followupInput = input
      return { kind: 'intent', actions: [{ intent: 'status', arguments: {}, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
    }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: {
      objective: '核对 test3 账号创建时间为空的原因' }, dependsOn: [] }],
      constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, messageId: 'synthetic-account-question',
    text: 'test3 account@example.invalid 示例研究院 小助手，这个账号是你创建的测试账号吗？为什么创建时间是空的呢？从什么渠道创建的账号时间会空呢？' })
  const firstState = await service.messages.process(first.runId)
  const taskId = firstState.commands[0].result.taskId
  assert.equal(firstState.commands[0].result.runId, null)
  await settleTaskOwners(service, service.execution)
  const second = await service.ingest({ ...message, messageId: 'synthetic-account-followup', text: '这不是让你去查吗' })
  const secondState = await service.messages.process(second.runId)
  assert.equal(secondState.commands[0].status, 'applied')
  assert.equal(secondState.commands[0].result.taskId, taskId)
  assert.equal((await service.tasks()).length, 1)
  assert.equal(followupInput.binding.taskId, taskId)
  assert.match(JSON.stringify(followupInput), /test3|账号创建时间/u)
})

test('同条消息两个独立目标分别建Task，明确追问只续A不默认最近Run', async t => {
  const coordinatorSessions = coordinatorFixtureSessions((source, input) => {
    if (source.body.includes('A呢')) {
      const target = input.candidates.find(item => item.taskId && item.goal?.includes('排查A'))
      assert.ok(target, '必须定位A的真实Task候选')
      return coordinatorUnit(source, 'status', {}, { disposition: 'existing', candidateId: target.candidateId })
    }
    const decision = coordinatorUnit(source, 'create', { objective: '排查A' })
    decision.units[0].spans = [{ start: 0, end: 4 }]; decision.units[0].goalText = '排查A'
    const second = structuredClone(decision.units[0])
    second.spans = [{ start: 4, end: 7 }]; second.goalText = '排查B'
    second.intent.actions[0].arguments.objective = '排查B'
    decision.units.push(second)
    return decision
  })
  const { service, execution, message } = await fixture(t, 'owner', undefined, { coordinatorSessions })
  const first = await service.ingest({ ...message, text: '排查A；排查B' })
  const created = await service.messages.process(first.runId)
  assert.equal(created.commands.length, 2)
  assert.ok(created.commands.every(item => item.status === 'applied'))
  assert.equal(new Set(created.units.map(unit => unit.topicId)).size, 2)
  const [a, b] = created.commands.map(item => item.result.taskId)
  assert.notEqual(a, b)
  assert.equal(created.commands[1].result.runId, null)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId: b }), [])
  const followup = await service.ingest({ ...message, messageId: 'ask-a-only', text: '排查A呢？' })
  const answer = await service.messages.process(followup.runId)
  assert.equal(answer.commands[0].status, 'applied')
  assert.equal(answer.commands[0].result.taskId, a)
  assert.equal((await service.tasks()).length, 2)
})

test('模型要求为非本人创建Task由Host等待授权，未受权群仍拒绝', async t => {
  const { service, execution, message } = await fixture(t, 'outsider')
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  const rejected = await service.state(accepted.runId)
  assert.equal(rejected.run.status, 'pending')
  assert.equal(rejected.commands.length, 0)
  assert.equal(rejected.requests[0].kind, 'needs_authorization')
  assert.equal(rejected.requests[0].status, 'pending')
  assert.deepEqual(rejected.requests[0].permittedActors, ['owner'])
  assert.equal((await service.tasks()).length, 0)
  await service.ingest(message)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  await assert.rejects(service.ingest({ ...message, groupId: 'another' }), /WORKFLOW_GROUP_NOT_ADMITTED/)
})

test('无可信消息编辑版本不能把变更正文当重复消息或新授权', async t => {
  const { service, message } = await fixture(t)
  await service.ingest(message)
  await assert.rejects(service.ingest({ ...message, text: '先不要执行' }), /WORKFLOW_EDIT_VERSION_REQUIRED/)
})

for (const eventFirst of [true, false]) test(`文件卡片下载提示展示差异不生成新版本或重复执行：eventFirst=${eventFirst}`, async t => {
  const { service, execution, message } = await fixture(t)
  const base = '[文件] 验收.xlsx fileId: file-1'
  const hint = ' 注意：如需下载使用dws drive download命令下载'
  const resources = [{ type: 'fileId', resourceId: 'file-1', name: '验收.xlsx' }]
  const first = { ...message, text: eventFirst ? base + hint : base, resourceRefs: resources }
  const repeated = { ...first, text: eventFirst ? base : base + hint }
  const accepted = await service.ingest(first)
  assert.deepEqual(await service.ingest(repeated), { accepted: true, duplicate: true, runId: accepted.runId, processing: 'pending' })
  const state = await service.state(accepted.runId)
  assert.equal(state.run.body, first.text)
  assert.equal(state.run.sourceVersion, 1)
  assert.deepEqual(state.run.context.attachments.map(item => item.source), resources)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  for (const changed of [
    { ...repeated, senderOpenDingTalkId: 'other' },
    { ...repeated, text: repeated.text.replace('验收.xlsx', '另一个.xlsx') },
    { ...repeated, resourceRefs: [{ ...resources[0], resourceId: 'other' }] },
    { ...repeated, resourceRefs: [{ ...resources[0], name: 'other.xlsx' }] },
    { ...repeated, resourceRefs: [] },
    { ...repeated, resourceRefs: [...resources, { type: 'fileId', resourceId: 'another', name: 'another.xlsx' }] },
    { ...repeated, text: repeated.text + ' 追加要求' },
  ]) await assert.rejects(service.ingest(changed), /WORKFLOW_EDIT_VERSION_REQUIRED/)
})

for (const eventFirst of [true, false]) test(`图片卡片下载提示不阻断历史回补：eventFirst=${eventFirst}`, async t => {
  const { service, message } = await fixture(t)
  const base='[图片消息](mediaId=media-1)',hint=' 注意：如需下载使用dws chat message download-media命令下载'
  const first={...message,text:eventFirst?base+hint:base,resourceRefs:[{type:'mediaId',resourceId:'media-1'}]}
  const accepted=await service.ingest(first)
  const repeated={...first,text:eventFirst?base:base+hint}
  assert.equal((await service.ingest(repeated)).duplicate,true)
  assert.equal((await service.state(accepted.runId)).run.body,first.text)
  for(const changed of [{...repeated,senderOpenDingTalkId:'other'},{...repeated,resourceRefs:[{type:'mediaId',resourceId:'another'}]},{...repeated,text:repeated.text+' 新要求'},{...repeated,resourceRefs:[]}])
    await assert.rejects(service.ingest(changed),/WORKFLOW_EDIT_VERSION_REQUIRED/)
})

test('Web与IM引用同一澄清首终态生效，无权拒绝且答复沿同来源重新协调', async t => {
  let splits = 0
  const notifications = { canDisclose: async () => true, send: async () => ({ messageId: 'question-message' }), readback: async () => ({ messageId: 'question-message', conversationId: 'g' }) }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') { splits++; return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] } }
    if (stage === 'R') return input.clarificationAnswers?.length ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['answer'] } : { kind: 'needs_clarification', reason: '请选择范围', question: '请选择第一个或第二个范围', needs: [] }
    return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge, config: { webActorId: 'owner' } })
  const received = await service.ingest(message); await service.messages.process(received.runId); await service.flushNotifications()
  const request = (await service.state(received.runId)).requests[0]
  await assert.rejects(service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'bad', answer: '第一' }, { channel: 'web', actorId: 'outsider' }), /FORBIDDEN/)
  const first = await service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'web-1', answer: '第一个' }, { channel: 'web', actorId: 'owner' })
  assert.equal(first.answer, '第一个')
  const second = await service.ingest({ ...message, messageId: 'im-answer', text: '第二个', quotedMessage: { messageId: 'question-message' } })
  assert.equal(second.answer, '第一个')
  assert.equal(splits, 2) // 同一来源收到回答后由群会话重新决策。
  assert.equal((await execution.store.query({ kind: 'message.list', limit: 100 })).length, 1)
})

test('纯话题事实同库沉淀，后续任务读取原文并强制继承话题约束', async t => {
  let sawSource = false
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return input.candidates.length ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['topic'] } : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    if (input.text.includes('只用中文')) return { kind: 'intent', actions: [{ intent: 'fact', arguments: { kind: 'constraint', text: '只用中文' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    sawSource = input.facts.topic.sources.some(ref => ref.text === '后续报告只用中文')
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理报告' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '后续报告只用中文' }); await service.messages.process(first.runId)
  const topics = await execution.store.query({ kind: 'message.topics', conversationId: 'g', limit: 20 })
  assert.equal(topics.length, 1)
  assert.ok(topics[0].facts.some(fact => fact.kind === 'constraint' && fact.text === '只用中文'))
  const second = await service.ingest({ ...message, messageId: 'followup', text: '开始整理报告' }); await service.messages.process(second.runId)
  const state = await service.state(second.runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(sawSource, true)
  const task = await execution.controller.taskPlan(state.commands[0].result.taskId)
  const input = await execution.artifacts.read(task.task.requirementRef)
  assert.ok(input.constraints.includes('只用中文'))
  assert.equal((await execution.store.query({ kind: 'message.topic.source', sourceKey: state.run.sourceKey })).length, 1)
})

test('旧完成Task只读候选返回旧结果，不调用新controller或恢复旧引擎', async t => {
  const old = { taskId: 'old-task', groupId: 'g', state: 'completed', outcome: 'succeeded', title: '翻译报告', result: '旧报告已翻译完成' }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') { assert.equal(input.candidates[0].engine, 'legacy'); return { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['old-result'] } }
    return { kind: 'intent', actions: [{ intent: 'result', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, legacy: { listTasks: () => [old], getTask: id => id === old.taskId ? old : null } })
  const { runId } = await service.ingest({ ...message, text: '翻译报告结果是什么' }); await service.messages.process(runId)
  const state = await service.state(runId)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.equal(state.commands[0].result.reply, old.result)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

test('群集合查询不要求单个Task身份', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'conversation', queryScope: 'agent_tasks', candidateId: null, evidence: ['查询本群'] }
      : { kind: 'intent', actions: [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  const { service, message } = await fixture(t, 'owner', undefined, { judge })
  const receipt = await service.ingest({ ...message, text: '本群任务进度如何？' })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.run.status, 'settled')
  assert.deepEqual(state.commands[0].result.items, [])
  assert.match(state.commands[0].result.reply, /没有/)
})

test('必需附件正文进入Task固定输入且保留意图约束', async t => {
  let reads = 0, ownerRead = false
  const originalText='附件正文：SELECT 1;'.repeat(20000)+'只允许测试库'
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新材料'] }
      : { kind: 'intent', actions: [{ intent: 'research', arguments: { objective: '分析附件' }, dependsOn: [] }], constraints: ['不可执行SQL'], requiredExecutionMaterials: ['file-1'], replyPolicy: 'result' }
  let remote
  const ownerSessions = { async run({ input, binding, queryInput, tools, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    assert.deepEqual(input.goal.constraints, ['不可执行SQL'])
    const material = input.goal.materials.find(item => item.id === 'file-1')
    assert.equal(material.text, undefined)
    assert.ok((await readArtifact(material.artifactRef)).text.includes(originalText))
    ownerRead = true
    assert.equal(queryInput.context.readableMessageResources[0].resourceId, 'file-1')
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    for (const ref of refs) await readArtifact(ref)
    const decision = { action: 'complete', summary: '附件内容已分析，未执行SQL', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: ownerSessions,
    generalCompletionCheck: async input => ({ status: 'satisfied', resultVerified: ownerRead,
      criteria: input.acceptanceItems.map(item => ({ criterion: item.criterion, passed: ownerRead, evidenceIds: item.evidenceRefs })) }),
    readMessage: async()=>remote, readResource: async () => ({ text: ++reads === 1 ? originalText : '已被替换的正文' }) })
  remote={...message,conversationId:'g',text:'分析附件',resourceRefs:[{type:'fileId',resourceId:'file-1'}]}
  const receipt = await service.ingest({ ...message, text: '分析附件', resourceRefs: [{ type: 'fileId', resourceId: 'file-1' }] })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.run.status, 'settled', JSON.stringify({reason:state.run.reason,commands:state.commands}))
  const taskId = state.commands[0].result.taskId
  await settleTaskOwners(service, service.execution)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision?.action, 'complete', JSON.stringify(owner))
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 0)
  const input = await execution.artifacts.read(plan.task.requirementRef)
  assert.deepEqual(input.constraints, ['不可执行SQL'])
  assert.ok(input.materials.find(item => item.id === 'file-1').text.includes(originalText))
  assert.equal(reads, 1)
})

test('附件证明正文被替换时仍拒绝Owner，不以冻结材料代替读取账证明', async t => {
  let remote, accepted = false, reads = 0
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新附件'] }
      : { kind: 'intent', actions: [{ intent: 'research', arguments: { objective: '分析附件' }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: ['file-1'], replyPolicy: 'result' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge,
    taskOwnerSessions: { async run() { throw Error('错误材料证明不得进入Owner') }, async close() {} },
    storeCommand: async (request, command) => {
      const result = await command(request)
      if (request.kind === 'task.accept') accepted = true
      return result
    },
    storeQuery: async (request, query) => {
      const result = await query(request)
      return accepted && request.kind === 'message.material' && result ? { ...result, text: '被替换的正文' } : result
    },
    readMessage: async () => remote, readResource: async () => { reads++; return { text: '原始附件正文' } } })
  remote = { ...message, conversationId: 'g', text: '分析附件', resourceRefs: [{ type: 'fileId', resourceId: 'file-1' }] }
  const receipt = await service.ingest(remote)
  const state = await service.messages.process(receipt.runId)
  const taskId = state.commands[0].result.taskId
  await settleTaskOwners(service, service.execution)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.lastFailure, 'TASK_MATERIAL_PROOF_MISSING')
  assert.equal(owner.sessionBound, false)
  assert.equal(reads, 1)
  assert.equal((await execution.controller.taskPlan(taskId)).stages.length, 0)
})

test('通知ACK丢失只回查不重发；当前披露不允许时零发送', async t => {
  let allowed = false, sends = 0, visible = false
  const { service, execution, message } = await fixture(t, 'owner', {
    canDisclose: async () => allowed,
    send: async () => { sends++; throw new Error('ACK_LOST') },
    readback: async notice => visible ? { messageId: `observed:${notice.id}`, conversationId: 'g' } : null,
  })
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  const state = await service.state(accepted.runId)
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  assert.equal(sends, 0)
  allowed = true
  await service.flushNotifications()
  assert.equal(sends, 1)
  assert.ok((await execution.store.query({ kind: 'message.notifications' })).every(item => item.status === 'unknown'))
  await service.flushNotifications()
  assert.equal(sends, 1)
  visible = true
  await service.flushNotifications()
  assert.equal(sends, 1)
  assert.deepEqual(await execution.store.query({ kind: 'message.notifications' }), [])
})

test('同文高版本编辑复用原Task且别名重投回原run', async t => {
  const { service, execution, message } = await fixture(t)
  const first = await service.ingest(message); await service.messages.process(first.runId)
  const command = (await service.state(first.runId)).commands[0]
  assert.equal(command.result.runId, null)
  const edited = await service.ingest({ ...message, messageVersion: 2 })
  assert.equal(edited.runId, first.runId); assert.equal(edited.duplicate, true)
  assert.equal((await service.ingest({ ...message, messageVersion: 2 })).runId, first.runId)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  assert.equal((await service.tasks()).length, 1)
  assert.equal((await execution.store.query({ kind: 'message.list' })).length, 1)
})
test('群职责允许明确点名交办创建任务，普通问题报告仍无创建权',async t=>{
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'new',candidateId:null,evidence:['新事项']}
    :{kind:'intent',actions:[{intent:'create',arguments:{objective:'核对归一化回归'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{judge,legacy:{
    getAgentConfig:()=>({provider:'test',model:'test',agentNames:['资料助理','客服(乙)']}),
    getGroup:id=>({groupId:id,responsibility:'## 任务准入\n消息明确要求当前 Agent 处理时可以创建任务。',messages:[]}),
  }})
  const passive=await service.ingest({...message,messageId:'report',text:'@用户(用户) 修复又引入了归一化计算问题：当前得到 0.001 t。'})
  await service.messages.process(passive.runId)
  const passiveState=await service.state(passive.runId)
  assert.equal(passiveState.commands.length,0)
  assert.equal(passiveState.requests.length,0)
  await service.flushNotifications()
  assert.deepEqual(await execution.store.query({kind:'message.notifications',runId:passive.runId}),[])
  const unconfigured=await service.ingest({...message,messageId:'unconfigured',text:'小助手，请修复这个问题'})
  const unknownState=await service.messages.process(unconfigured.runId)
  assert.equal(unknownState.commands.length,0)
  assert.equal(unknownState.requests[0].kind,'needs_authorization')
  assert.equal((await service.tasks()).length,0)
  const directed=await service.ingest({...message,messageId:'request',text:'客服(乙)，数据集合并出现的这个问题需要修复'})
  await service.messages.process(directed.runId)
  assert.equal((await service.state(directed.runId)).commands[0].status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,0)
  assert.equal((await service.tasks()).length,1)
})
test('本机操作者逐条重处理旧澄清，旧请求失效且有命令消息拒绝重跑',async t=>{
  let clarified=false
  const judge=async({stage,input})=>{
    if(stage==='S')return clarified?splitOne(input.source.text):{kind:'needs_clarification',reason:'旧上下文不足',question:'旧问题',needs:[]}
    if(stage==='R')return{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    return{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  }
  const {service,message}=await fixture(t,'owner',undefined,{judge,config:{webActorId:'owner'}})
  const first=await service.ingest(message);await service.messages.process(first.runId)
  await assert.rejects(service.reprocessMessage(first.runId,{channel:'web',actorId:'other'}),/FORBIDDEN/)
  clarified=true
  const replay=await service.reprocessMessage(first.runId,{channel:'web',actorId:'owner'})
  assert.notEqual(replay.runId,first.runId)
  const refreshed=(await service.state(replay.runId)).run
  assert.match(refreshed.context.compactPolicy,/任务准入由Host核验/u)
  assert.doesNotMatch(refreshed.context.compactPolicy,/只有已认证任务所有者可以要求执行/u)
  assert.equal(refreshed.actorId,message.senderOpenDingTalkId)
  assert.equal((await service.state(first.runId)).requests[0].status,'superseded')
  assert.equal((await service.state(replay.runId)).commands.length,1)
  assert.equal((await service.ingest(message)).duplicate,true)
  await assert.rejects(service.reprocessMessage(replay.runId,{channel:'web',actorId:'owner'}),/MESSAGE_REPROCESS_EFFECT_PENDING/)
})

test('无引用的先别管它静默收束，不追问也不创建任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions(source=>({runId:source.runId,reason:'无需回复',units:[]}))})
  const received=await service.ingest({...message,text:'先别管它'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.run.reason,'无需回复')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})
test('第三方任务已创建进展同步即使含@也静默，不生成澄清或业务任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions(source=>({runId:source.runId,reason:'无需回复',units:[]}))})
  const received=await service.ingest({...message,text:'@用户  任务已创建，开始处理。 任务：dingtalk_at_xcm:20260924130713-437 — 小煤球',quotedMessage:{messageId:'old-reply',content:'此前话题的回复'}})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.reason,'无需回复')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  const mailbox=(await service.mailboxes()).messages.find(item=>item.messageId===message.messageId)
  assert.equal(mailbox.routingStatus,'routed')
  assert.deepEqual(mailbox.topicRefs,[])
})
test('已送达通知回声准确关联原话题且不再次调用群协调',async t=>{
 let turns=0
 const notifications={canDisclose:async()=>true,send:async()=>({messageId:'known-out'}),readback:async()=>({messageId:'known-out',conversationId:'g'})}
 const {service,message,execution}=await fixture(t,'owner',notifications,{coordinatorSessions:coordinatorFixtureSessions(source=>{
  turns++;const d=coordinatorUnit(source,'answer',{objective:'审核状态已核对'});d.units[0].intent.replyPolicy='result';return d
 })})
 const original=await service.ingest({...message,text:'审核状态查询'})
 await service.messages.process(original.runId);await service.flushNotifications()
 const before=await service.state(original.runId),topics=await service.topics('g')
 const echo=await service.ingest({...message,senderOpenDingTalkId:'assistant-account',messageId:'known-out',text:'审核状态已核对'})
 assert.equal(echo.processing,'outbound-echo');await service.messages.recover()
 assert.equal(turns,1);assert.deepEqual(await service.topics('g'),topics)
 const notice=(await execution.store.query({kind:'message.notifications',states:['delivered']}))[0]
 assert.equal(notice.runId,original.runId);assert.equal(notice.commandId,before.commands[0].commandId)
 assert.equal((await service.mailboxes()).messages.length,1)
})


test('长旧任务候选按需回读全文，不按来源预写详情材料',async t=>{
 const task={taskId:'untitled',groupId:'g',objective:'历史目标。'.repeat(200)+'未经审批不得修改生产数据。',state:'completed',outcome:'succeeded'}
 let sawCandidate=false,f
 f=await fixture(t,'owner',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},coordinatorSessions:{async run({input,onSessionBound,onCandidate,readTools}){
  await onSessionBound()
  const source=input.sources[0],card=input.candidates.find(item=>item.candidateId==='legacy:untitled')
  assert.equal(card.detailRef,'task-history:untitled');assert.equal(card.historyRef,card.detailRef)
  assert.ok(card.goal.length<task.objective.length);assert.ok(card.omissions.some(item=>item.field==='goal'))
  assert.equal(await f.execution.store.query({kind:'message.material',runId:source.runId,resourceRef:card.detailRef}),null)
  const db=new DatabaseSync(join(f.root,'control.db'),{readOnly:true})
  try{assert.equal(db.prepare("SELECT count(*) n FROM message_items WHERE run_id=? AND kind='material'").get(source.runId).n,0)}finally{db.close()}
  const answer=await readTools.find(tool=>tool.name==='group_coordinator_read_material').execute({runId:source.runId,resourceRef:card.detailRef})
  assert.equal(answer.ready,true);assert.ok(JSON.stringify(answer).includes('未经审批不得修改生产数据'))
  assert.ok(JSON.stringify(answer).includes(task.objective))
  sawCandidate=true
  await onCandidate({decisions:[{runId:source.runId,reason:'本轮仅查材料，无新任务',units:[]}]})
  return {status:'submitted'}
 },async close(){}}})
 const received=await f.service.ingest({...f.message,text:'历史目标需要核对'})
 await f.service.messages.process(received.runId)
 assert.equal(sawCandidate,true)
 assert.equal((await f.service.state(received.runId)).run.status,'settled')
})


test('明确问小助手审核问题是否部署时由I识别状态动作后回读群任务',async t=>{
  const task={taskId:'old-review',groupId:'g',title:'审核草稿与撤回通知',objective:'修复审核草稿与撤回通知',state:'completed',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}}}
  const {service,message}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:null,evidence:['群审核任务']}:{kind:'intent',actions:[{intent:'status',arguments:{scope:'conversation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
  assert.deepEqual(service.catalog().builtInWorkflows[0].nodes.map(node=>node.id),['scope','candidates','readback','reply'])
  const received=await service.ingest({...message,text:'小助手，我审核的问题都改完部署到uat2了吗？'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].kind,'status')
  assert.match(state.commands[0].result.reply,/UAT2：已部署并交付测试/)
})
test('审核状态问句、两个任务说明和引用问题清单归为同一话题，不误建三个任务',async t=>{
  const tasks=[
    {taskId:'draft',groupId:'g',title:'审核草稿与撤回通知可靠化',objective:'修复审核草稿保存和撤回消息通知',state:'completed',outcome:'succeeded',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}}},
    {taskId:'withdraw',groupId:'g',title:'修复专家审核后仍可撤回分配',objective:'修复分配后打回修改撤回的问题',state:'completed',outcome:'cancelled'},
    {taskId:'draft-investigation',groupId:'g',title:'排查审核草稿保存问题',objective:'排查审核草稿保存问题，仅授权排查分析，不实施代码、配置或数据修改',state:'completed',outcome:'succeeded'},
    {taskId:'notice-investigation',groupId:'g',title:'排查撤回消息通知问题',objective:'核对撤回消息通知异常，不实施代码、配置或数据修改',state:'completed',outcome:'succeeded'},
    {taskId:'draft-unknown',groupId:'g',title:'排查审核草稿保存',objective:'核对审核草稿保存现象',state:'completed'},
  ]
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>tasks,getTask:id=>tasks.find(task=>task.taskId===id)},judge:async({stage,input})=>{
    if(stage==='S')return splitOne(input.source.text)
    if(stage==='R')return{kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:input.candidates.find(item=>item.topicId)?.candidateId??null,evidence:['原文明确补充前文任务查询范围']}
    return{kind:'intent',actions:[{intent:input.text==='审核问题会匹配到两个任务'?'fact':'status',arguments:input.text==='审核问题会匹配到两个任务'?{kind:'fact',text:input.text}:{scope:'conversation',objective:input.text+'，是否部署到uat2'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  const first=await service.ingest({...message,messageId:'review-question',text:'小助手，我审核的问题都改完部署到uat2了吗？'})
  await service.messages.process(first.runId)
  const firstState=await service.state(first.runId)
  assert.equal(firstState.commands[0].kind,'status')
  assert.equal(firstState.commands[0].result.flow.version,'task-progress-query@1')
  assert.deepEqual(firstState.commands[0].result.flow.steps.map(step=>step.nodeId),['scope','candidates','readback','reply'])
  assert.match(firstState.commands[0].result.reply,/审核草稿与撤回通知可靠化/)
  assert.match(firstState.commands[0].result.reply,/修复专家审核后仍可撤回分配/)
  const second=await service.ingest({...message,senderOpenDingTalkId:'owner',messageId:'two-tasks',text:'审核问题会匹配到两个任务'})
  await service.messages.process(second.runId)
  const secondState=await service.state(second.runId)
  assert.deepEqual(secondState.commands.map(item=>item.kind),['fact'])
  const third=await service.ingest({...message,messageId:'review-details',text:'审核草稿保存的问题，分配后打回修改撤回的问题，撤回消息通知的问题',quotedMessage:{messageId:'two-tasks',content:'审核问题会匹配到两个任务'}})
  await service.messages.process(third.runId)
  const thirdState=await service.state(third.runId)
  assert.equal(thirdState.units.length,1)
  assert.deepEqual(thirdState.commands.map(item=>item.kind),['status'])
  assert.match(thirdState.commands[0].result.reply,/UAT2：已部署并交付测试/)
  assert.match(thirdState.commands[0].result.reply,/已取消/)
  assert.equal(thirdState.commands[0].result.items.length,2)
  assert.equal(thirdState.commands[0].result.flow.version,'task-progress-query@1')
  assert.equal((await execution.store.query({kind:'run.list'})).length,0)
  const topicIds=[firstState,secondState,thirdState].map(state=>state.units[0].topicId)
  assert.equal(new Set(topicIds).size,1)
})
test('未知只读查询不自动重派，显式安全重试后完成原命令',async t=>{
  const task={taskId:'old-review',groupId:'g',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed',outcome:'succeeded'}
  const {service,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null}})
  const command=(kind,args)=>execution.store.command({id:`test-${kind}`,kind:`message.${kind}`,args})
  await command('receive',{runId:'recover-status',sourceKey:'recover-status',sourceVersion:1,conversationId:'g',actorId:'participant',body:'小助手，审核草稿保存的问题完成了吗？',policy:{initialWindowMs:45000}})
  await command('snapshot',{runId:'recover-status',snapshot:{snapshotId:'test-snapshot',source:{sourceKey:'recover-status',sourceVersion:1,text:'小助手，审核草稿保存的问题完成了吗？',actorId:'participant',conversationId:'g'},history:[],quotes:[],attachments:[],omissions:[],policy:'',actorPermissions:[]}})
  await command('split',{runId:'recover-status',units:[{unitId:'recover-unit',goalText:'小助手，审核草稿保存的问题完成了吗？',spans:[{start:0,end:22}],constraints:[],contextNeeds:[],sharedConstraints:[]}]})
  await command('accept',{runId:'recover-status',unitId:'recover-unit',commands:[{commandId:'recover-command',kind:'status',args:{taskId:null,arguments:{scope:'conversation'},binding:{disposition:'conversation'},replyPolicy:'none'}}]})
  const claimed=(await command('command.claim',{commandId:'recover-command'})).result.command
  await command('command.fail',{commandId:'recover-command',leaseEpoch:claimed.leaseEpoch,error:'INVALID_ARGUMENT'})
  await command('attention',{runId:'recover-status',reason:'recovery_exhausted'})
  await service.messages.recover()
  const unknown=await service.state('recover-status')
  assert.equal(unknown.commands[0].status,'unknown')
  assert.equal(unknown.commands[0].readonlyRetryCount,undefined)
  await command('command.retry.readonly',{commandId:'recover-command'})
  await service.messages.recover()
  const state=await service.state('recover-status')
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].status,'applied')
  assert.equal(state.commands[0].readonlyRetryCount,1)
})

test('来源变更隔离旧回声候选，群协调真实排空后旧lease不能落账', {timeout:10000},async t=>{
 let release,started;const gate=new Promise(r=>{release=r}),running=new Promise(r=>{started=r})
 t.after(()=>release())
 const f=await fixture(t,'owner',undefined,{coordinatorSessions:{async run({input,onSessionBound,onCandidate}){
  await onSessionBound();started();await gate
  await onCandidate({decisions:input.sources.map(source=>coordinatorUnit(source,'answer',{objective:'不能执行的旧回声'}))})
  return {status:'submitted'}
 },async close(){release()}}})
 const source=await f.service.ingest({...f.message,messageId:'late-echo',text:'已送达通知'})
 const processing=f.service.messages.process(source.runId);const outcome=processing.catch(error=>error)
 await running
 const before=await f.execution.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.equal(before.coordinator.status,'running')
 // 用原生来源替代使旧会话失效；真实runner未排空前保留lease。
 await f.execution.store.command({id:'source-new-version',kind:'message.receive',args:{runId:'replacement',sourceKey:(await f.service.state(source.runId)).run.sourceKey,sourceVersion:2,conversationId:'g',actorId:'owner',body:'修正来源',context:{sourceMessageId:'replacement'}}})
 assert.equal((await f.execution.store.query({kind:'message.coordinator',conversationId:'g'})).coordinator.status,'running')
 release();await outcome
 const after=await f.service.state(source.runId)
 assert.equal(after.commands.length,0);assert.equal(after.run.status,'superseded')
 assert.equal((await f.execution.store.query({kind:'message.coordinator',conversationId:'g'})).coordinator.status,'idle')
})

test('已回读的自身澄清通知不再作为新消息入站，收发信箱分别投影', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true, send: async notice => { const item = { messageId: 'out-1', text: notice.payload.text }; sent.push(item); return { messageId: item.messageId } }, readback: async () => ({ messageId: 'out-1', conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { coordinatorSessions: coordinatorFixtureSessions(source=>({runId:source.runId,reason:'缺少业务目标',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding:{disposition:'new',candidateId:null},intent:coordinatorQuestion(source,{reason:'问题不明确',question:'请说明具体任务'})}]})) })
  const original = await service.ingest(message)
  await service.messages.process(original.runId)
  await service.flushNotifications()
  const echo = await service.ingest({ ...message, messageId: 'out-1', text: sent[0].text })
  assert.equal(echo.processing, 'outbound-echo')
  const genuine = await service.ingest({ ...message, senderOpenDingTalkId: 'human-colleague', messageId: 'manual-2', text: sent[0].text })
  assert.equal(genuine.duplicate, false)
  assert.equal((await execution.store.query({ kind: 'message.list', conversationId: 'g', limit: 30 })).length, 2)
  const mailboxes = await service.mailboxes()
  assert.equal(mailboxes.messages.length, 2)
  assert.equal(mailboxes.outbox.length, 1)
  assert.equal(mailboxes.outbox[0].status, 'sent')
  await execution.store.command({ id: 'old-echo', kind: 'message.receive', args: { runId: 'old-echo', sourceKey: 'echo:out-1', sourceVersion: 1, conversationId: 'g', actorId: 'owner', body: sent[0].text, context: { sourceMessageId: 'out-1' } } })
  await service.messages.recover()
  assert.equal((await service.state('old-echo')).run.status, 'superseded')
  await execution.store.command({ id: 'recall-out-1', kind: 'message.notification.recall.record', args: { notificationId: mailboxes.outbox[0].outboundId, messageId: 'out-1', recallStatus: 'SUCCESS', evidenceRef: 'test-readback-recall' } })
  assert.equal((await service.mailboxes()).outbox[0].recallStatus, 'recalled')
})

test('受管撤回逐条核验负责人原消息，回读后补发保留原通知', async t => {
  let sends = 0, recalls = 0
  const sentNotifications = []
  const notifications = {
    canDisclose: async () => true,
    send: async notice => { const messageId = `out-${++sends}`; sentNotifications.push({ id: notice.id, messageId }); return { messageId } },
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }),
    recall: async () => { recalls++; return { recallStatus: 'SUCCESS' } },
    readbackRecall: async ({ messageId }) => ({ messageId, recallStatus: 'SUCCESS', conversationId: 'g' }),
  }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message)
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  const notice = (await execution.store.query({ kind: 'message.notifications', states: ['delivered'] }))[0]
  const originalSource = (await execution.store.query({ kind: 'message.run', runId: received.runId })).run.sourceKey
  await assert.rejects(service.prepareWorkflowNotificationOperation({ operationId: 'recall-1', notificationId: notice.id,
    type: 'recall', reason: 'explicit_user', authorizationRef: originalSource }), /AUTHORIZATION_REQUIRED/u)
  const authorization = await service.ingest({ ...message, messageId: 'auth-recall', text: `撤回通知 ${notice.id}` })
  const authSource = (await execution.store.query({ kind: 'message.run', runId: authorization.runId })).run.sourceKey
  const prepared = await service.prepareWorkflowNotificationOperation({ operationId: 'recall-1', notificationId: notice.id,
    type: 'recall', reason: 'explicit_user', authorizationRef: authSource })
  const executed = await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })
  assert.equal(executed.status, 'completed')
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })).status, 'completed')
  assert.equal(recalls, 1)
  assert.equal((await service.mailboxes()).outbox.find(item => item.outboundId === notice.id).recallStatus, 'recalled')
  const restoreAuthorization = await service.ingest({ ...message, messageId: 'auth-restore', text: `补发通知 ${notice.id}` })
  const restoreSource = (await execution.store.query({ kind: 'message.run', runId: restoreAuthorization.runId })).run.sourceKey
  const restore = await service.prepareWorkflowNotificationOperation({ operationId: 'restore-1', notificationId: notice.id,
    type: 'restore', reason: 'explicit_user', authorizationRef: restoreSource })
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: restore.id,
    expectedFactDigest: restore.snapshot.expectedFactDigest, authorizationRef: restoreSource })).status, 'completed')
  const replacement = (await service.mailboxes()).outbox.find(item => item.replacesNotificationId === notice.id)
  assert.equal(sentNotifications.filter(item => item.id === notice.id).length, 1)
  assert.equal(sentNotifications.filter(item => item.id === restore.id).length, 1)
  assert.equal(replacement.deliveredMessageId, sentNotifications.find(item => item.id === restore.id).messageId)
})

test('群协调获得职责并通过原生只读工具读取合法任务历史', async t => {
  let seen
  const longCondition='历史条件'.repeat(300)+'不得生产写入'
  const task = { taskId: 'old-1', groupId: 'g', title: '审核草稿保存', objective: longCondition, state: 'completed', outcome: '已完成', result:{summary:longCondition}, objectiveHistory: Array.from({length:5},(_,index)=>({objective:`定位保存失败${index}`+longCondition,revisedAt:'2026-09-23T00:00:00Z'})) }
  const { service, message } = await fixture(t, 'owner', undefined, { legacy: { listTasks: () => [task], getTask: id => id === task.taskId ? task : null }, judge: async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') { if (!input.clarificationAnswers?.length) return { kind: 'needs_context', reason: '核对任务历史', needs: [{ resourceRef: 'task-history:old-1', reason: '读取当前合法候选历史' }] }; seen = input; return { kind: 'binding', disposition: 'conversation', queryScope: 'agent_tasks', candidateId: null, evidence: ['群任务'] } }
    assert.match(input.groupResponsibility, /处理本人交办事项/)
    return { kind: 'intent', actions: [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  } })
  const received = await service.ingest(message)
  await service.messages.process(received.runId)
  await service.messages.recover()
  await service.messages.process(received.runId)
  assert.match(JSON.stringify(seen.clarificationAnswers), /定位保存失败0/)
  assert.ok(JSON.stringify(seen.clarificationAnswers).includes(longCondition))
  assert.equal((await service.state(received.runId)).run.status, 'settled')
})

test('群成员可核对本群旧任务摘要和UAT2交付状态，跨群历史不可读取', async t => {
  const task={taskId:'old-uat',groupId:'g',title:'审核草稿与撤回通知',objective:'修复审核草稿与撤回通知',state:'completed',outcome:'succeeded',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}},objectiveHistory:[]}
  const {service,message}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>{
    if(stage==='S')return splitOne(input.source.text)
    if(stage==='R')return{kind:'binding',disposition:'existing',candidateId:'legacy:old-uat',evidence:['同群旧任务']}
    assert.equal(input.facts.legacyTask.uat2Status,'deployed-and-handed-to-testing')
    return{kind:'intent',actions:[{intent:'status',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  const received=await service.ingest({...message,text:'审核问题部署UAT2了吗'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.match(state.commands[0].result.reply,/UAT2：已部署并交付测试/)
})

test('旧群历史缺发送人字段时仍能写入快照',async t=>{
  const {service,message}=await fixture(t,'owner',undefined,{legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[{messageId:'old',text:'历史问题'}]})}})
  const received=await service.ingest(message)
  await service.messages.process(received.runId)
  assert.ok((await service.state(received.runId)).run.snapshot)
})

test('群协调只提交目标，调查由Task会话直接执行且不导出独立调查目录', async t => {
  const { service, execution, message } = await fixture(t)
  const catalog = service.catalog()
  assert.equal(catalog.engine, 'workflow-v2')
  assert.deepEqual(catalog.messageStages.map(stage => stage.id), ['receive', 'context', 'coordinator', 'material', 'dispatch'])
  assert.equal(catalog.workflows.length, taskWorkflowCatalog.length)
  assert.equal(catalog.workflows.some(item => ['task-general', 'task-investigation'].includes(item.id)), false)
  assert.equal(catalog.workflows.find(item => item.id === 'task-data-change').status, 'unavailable')
  const received = await service.ingest(message), state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.commands[0].result.runId, null)
  await settleTaskOwners(service, service.execution)
  const taskId = state.commands[0].result.taskId
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.action, 'complete')
  assert.equal(messageSchemas.I.safeParse({ kind: 'intent', actions: [{ intent: 'create', arguments: {
    objective: '调查', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }).success, false)
  assert.equal(messageSchemas.I.safeParse({ kind: 'intent', actions: [{ intent: 'create', arguments: {
    objective: '生产数据变更', workflowId: 'task-data-change' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }).success, false)
})

test('受信外部适配器齐备时协调目录可见，语义提交不直接执行外部效果', async t => {
  const ids = ['task-uat-deployment', 'task-production-release', 'task-data-change', 'task-uat-rebuild']
  const digest = createHash('sha256').update('rules').digest('hex')
  const releaseAdapter = kind => ({ id: kind, version: '1', rulesDigest: digest,
    inspect: async () => { throw new Error('PREFLIGHT_NOT_AVAILABLE') }, prepareOperation: async () => { throw new Error('EFFECT_NOT_EXPECTED') } })
  const dataChangeAdapter = { id: 'bytebase-test', version: '1', rulesDigest: digest,
    validate: async () => { throw new Error('VALIDATION_NOT_EXPECTED') },
    prepareRehearsal: async () => { throw new Error('REHEARSAL_NOT_EXPECTED') },
    readbackRehearsal: async () => { throw new Error('REHEARSAL_NOT_EXPECTED') },
    inspect: async () => { throw new Error('INSPECT_NOT_EXPECTED') }, prepareIssue: async () => { throw new Error('ISSUE_NOT_EXPECTED') },
    prepareApproval: async () => { throw new Error('APPROVAL_NOT_EXPECTED') },
    prepareExecute: async () => { throw new Error('EXECUTE_NOT_EXPECTED') }, readback: async () => { throw new Error('READBACK_NOT_EXPECTED') } }
  const source = 'SELECT 1', hash = createHash('sha256').update(source).digest('hex')
  let selected = 0, prepared = 0, effects = 0
  const external = { releaseAdapters: Object.fromEntries(['uat-deployment', 'production-release', 'uat-rebuild'].map(kind => [kind, releaseAdapter(kind)])), dataChangeAdapter,
    operationAdapter: { execute: async () => { effects++; throw new Error('EFFECT_NOT_EXPECTED') }, reconcile: async () => { effects++; throw new Error('EFFECT_NOT_EXPECTED') } },
    authorizeExternal: async () => { throw new Error('AUTHORIZATION_NOT_EXPECTED') },
    prepareRequirement: async ({ workflowId, action }) => {
      prepared++
      assert.ok(ids.includes(workflowId))
      if (workflowId === 'task-data-change') return { request: action.arguments.objective, constraints: [], target: { instance: 'test', database: 'test', environment: 'uat' },
        sources: [{ id: 's', sha256: hash, content: source }], baseline: { snapshotId: 'baseline', sha256: hash } }
      return { request: action.arguments.objective, constraints: [], evidenceRefs: ['source'], target: { repository: 'org/repo', environment: workflowId === 'task-production-release' ? 'production' : 'uat', service: 'service', commitSha: 'a'.repeat(40), runbookId: 'runbook' } }
    } }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    assert.ok(ids.every(id => input.facts.availableWorkflows.some(item => item.id === id)))
    assert.ok(!input.facts.unavailableWorkflows.includes('生产发布'))
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: input.text, workflowId: ids[selected++] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { external, judge })
  assert.ok(ids.every(id => service.catalog().workflows.some(item => item.id === id && item.status === 'available' && item.version && item.nodes.length)))
  for (let index = 0; index < ids.length; index++) {
    const receipt = await service.ingest({ ...message, messageId: `external-${index}`, text: `处理外部任务 ${index}` })
    const state = await service.messages.process(receipt.runId)
    assert.equal(state.commands[0].status, 'applied', JSON.stringify(state.commands[0]))
    assert.equal(state.commands[0].result.runId, null)
    assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId: state.commands[0].result.taskId }), [])
  }
  assert.equal(prepared, 0)
  assert.equal(effects, 0)
})

test('原消息否定编辑取消原Task，不发第二个任务且屏障释放', async t => {
  const judge = async ({stage,input}) => stage === 'S' ? splitOne(input.source.text) : stage === 'R'
    ? {kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}
    : {kind:'intent',actions:[{intent:input.sourceEdit?'cancel':'create',arguments:input.sourceEdit?{}:{objective:'整理材料'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  const { service, execution, message } = await fixture(t,'owner',undefined,{judge})
  const first=await service.ingest(message); await service.messages.process(first.runId)
  const initial=(await service.state(first.runId)).commands[0]
  assert.equal(initial.result.runId, null)
  const edit=await service.ingest({...message,text:'不要执行原任务，取消',messageVersion:2});await service.messages.process(edit.runId)
  const state=await service.state(edit.runId)
  assert.equal(state.commands[0]?.kind,'cancel',JSON.stringify(state));assert.equal(state.commands[0]?.status,'applied',JSON.stringify(state.commands[0]))
  assert.equal((await execution.store.query({kind:'run.list'})).length,0)
  assert.ok(state.barriers.every(b=>b.status==='resolved'))
})

test('运行中原消息修订更新 Task 要求，原会话旧输入冻结且不能提交旧决定', async t => {
  let release, began, originalInput
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { began = resolve })
  t.after(() => release())
  const sessions = { async run({ input, binding, onSessionBound, onCandidate }) {
    await onSessionBound()
    if (!originalInput) {
      originalInput = structuredClone(input); began(); await gate
      await assert.rejects(onCandidate({ action: 'wait', summary: '仍按旧输入等待', evidenceRefs: [], condition: {
        kind: 'business-input', missing: '旧输入缺少业务选项', responsibleParty: '交办人', resumeWhen: '补充后继续', evidenceRefs: [] } }), /STALE/)
    }
    return { status: 'no_submission' }
  }, async close() {} }
  const judge = async ({stage,input}) => stage === 'S' ? splitOne(input.source.text) : stage === 'R'
    ? {kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}
    : {kind:'intent',actions:[{intent:input.sourceEdit?'revise':'create',arguments:{objective:input.sourceEdit?'按新增要求分析':'整理材料'},dependsOn:[]}],constraints:input.sourceEdit?['新增格式要求']:['禁止生产写入'],requiredExecutionMaterials:[],replyPolicy:'result'}
  const { service, execution, message } = await fixture(t,'owner',undefined,{judge,taskOwnerSessions:sessions})
  const first = await service.ingest(message); await service.messages.process(first.runId)
  const driving = service.recover()
  await started
  const original = (await service.state(first.runId)).commands[0].result
  const edit = await service.ingest({...message,text:'改为按新增要求分析',messageVersion:2})
  const editing = service.messages.process(edit.runId)
  let plan
  for (let i = 0; i < 100; i++) {
    plan = await execution.controller.taskPlan(original.taskId)
    if (plan.task.requirementRevision > 1) break
    await new Promise(resolve => setTimeout(resolve,10))
  }
  assert.equal(plan.task.requirementRevision,2)
  assert.equal(originalInput.goal.request,message.text)
  assert.equal(originalInput.goal.objective,'整理材料')
  release(); await driving; await editing
  const state = await service.state(edit.runId)
  assert.equal(state.commands[0].kind,'revise'); assert.equal(state.commands[0].status,'applied')
  assert.ok(state.barriers.every(item=>item.status==='resolved'))
  const goal = await execution.artifacts.read(plan.task.requirementRef)
  assert.equal(goal.request,'改为按新增要求分析')
  assert.equal(goal.objective,'按新增要求分析')
  assert.deepEqual(goal.constraints,['禁止生产写入','新增格式要求'])
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  assert.equal((await execution.store.query({kind:'task.owner',taskId:original.taskId})).decision,null)
})

for(const runCount of [1,2]) test(`新Task真实HTTP补充与取消同库幂等；无权/跨站/伪造输入不执行，暂停不恢复：${runCount}个Run`,async t=>{
 let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const sessions={async close(){},async run({input,onSessionBound,onCandidate}){await onSessionBound();const refs=input.stages.flatMap(stage=>stage.evidenceRefs??[]);const decision=!input.stages.length?{action:'advance',summary:'生成任务文档',evidenceRefs:[],planChange:{kind:'initialize',stages:[markdownStage('# 原始上下文任务')]}}:{action:'wait',summary:'等候后续业务步骤',evidenceRefs:refs,condition:{kind:'execution',missing:'业务结果',responsibleParty:'执行方',resumeWhen:'结果到达后评估',evidenceRefs:refs}};await onCandidate(decision);return{status:'submitted',decision}}}
 const {service,execution,message}=await managedMarkdownFixture(t,undefined,{config:{webActorId:'owner'},taskOwnerSessions:sessions})
 const writeWorkflow=execution.controller.workflowDefinition('task-general-capability'),writeNode=writeWorkflow.nodes[0]
 execution.controller.registerWorkflow({...writeWorkflow,id:'context-write',version:'1',nodes:[{...writeNode,async execute(context){
  started()
  await new Promise(resolve=>{gate.then(resolve);context.signal.addEventListener('abort',resolve,{once:true})})
  context.signal.throwIfAborted()
  return writeNode.execute(context)
 }}]})
 const received=await service.ingest(message);await service.messages.process(received.runId)
 const command=(await service.state(received.runId)).commands[0].result
 const acceptedPlan=await execution.controller.taskPlan(command.taskId),goal=await execution.artifacts.read(acceptedPlan.task.requirementRef)
 await execution.controller.initializeTaskPlan({commandId:'context-write-plan',taskId:command.taskId,expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'write',workflowId:'context-write',input:{capabilityId:'write-task-markdown',input:{content:'# 原始上下文任务'},scope:goal.scope,expectedEvidence:'文档独立回读'}}]})
 await execution.controller.advanceTaskPlan(command.taskId);await began
 assert.equal(command.runId,null)
 const original={...command,runId:(await execution.controller.taskPlan(command.taskId)).stages[0].runId}
 await execution.controller.pause({commandId:'pause-test',runId:original.runId,reason:'先暂停'});release();await execution.controller.whenIdle(original.runId)
 let legacyCalls=0
 const runtime={isWorkflowTask:service.isTask,submitWorkflowTask:r=>service.submitWebTask(r,{channel:'web',actorId:'owner'}),cancelTask:()=>{legacyCalls++;throw new Error('legacy')},appendTaskContext:()=>{legacyCalls++;throw new Error('legacy')}}
 const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const post=(action,body,origin)=>fetch(`http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/${action}`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
 if(runCount===2){
  await execution.controller.stop({commandId:'context-history-stop',runId:original.runId,reason:'保留旧运行历史'})
  await execution.controller.whenIdle(original.runId)
  await execution.controller.advanceTaskPlan(original.taskId)
  execution.controller.registerWorkflow({id:'context-history',version:'1',nodes:[{id:'done',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>({})}]})
  const previous=await execution.controller.taskPlan(original.taskId)
  await execution.controller.reviseTaskPlan({commandId:'context-history',taskId:original.taskId,expectedPlanRevision:previous.task.planRevision,requirementRevision:previous.task.requirementRevision,affectedFrom:0,stages:[{stageId:'history',workflowId:'context-history',input:{}}]})
  const history=await execution.controller.advanceTaskPlan(original.taskId)
  await execution.controller.whenIdle(history.stages[0].runId)
 }
 const task=(await service.tasks())[0],input={requestId:'web-context-1',inputVersion:task.inputVersion,runSequence:task.runSequence,context:'追加检查中文格式',topicRefs:[]}
 assert.equal(task.runSequence,runCount)
 if(runCount===2)assert.equal((await post('context',{...input,requestId:'stale-context',runSequence:1})).status,409)
 const acceptanceBefore=await execution.store.query({kind:'task.owner.acceptance',taskId:task.taskId})
 assert.equal((await post('context',input,'https://evil.example')).status,403)
 assert.equal((await post('context',{...input,actorId:'owner'})).status,400)
 await assert.rejects(service.submitWebTask({...input,action:'context',taskId:task.taskId},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 await assert.rejects(service.submitWebTask({action:'reissue-repository',taskId:task.taskId,repositoryId:'backend',requestId:'unauthorized'},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 const firstContext=await post('context',input);assert.equal(firstContext.status,202,await firstContext.text());assert.equal((await post('context',input)).status,202)
 assert.equal((await post('context',{...input,context:'冲突内容'})).status,409)
 let state=await execution.controller.state(original.runId);assert.equal(state.pendingInputCount,0)
 if(runCount===1)assert.equal(state.run.pauseRequested,true);else assert.equal(state.run.status,'cancelled')
 const revisedPlan=await execution.controller.taskPlan(task.taskId)
 assert.deepEqual(await execution.store.query({kind:'task.owner.acceptance',taskId:task.taskId}),acceptanceBefore)
 assert.equal(revisedPlan.task.requirementRevision,2)
 assert.match((await execution.artifacts.read(revisedPlan.task.requirementRef)).request,/追加检查中文格式/u)
 assert.equal((await execution.artifacts.read(state.run.requirementRef)).input.content,'# 原始上下文任务')
 assert.equal((await post('reopen',input)).status,409);assert.equal((await post('archive',{})).status,409)
 const cancel={requestId:'web-cancel-1',inputVersion:(await service.tasks())[0].inputVersion,runSequence:task.runSequence,reason:'停止'}
 assert.equal((await post('cancel',cancel)).status,202);assert.equal((await post('cancel',cancel)).status,202)
 await execution.controller.whenIdle(original.runId);state=await execution.controller.state(original.runId);assert.equal(state.run.status,'cancelled');assert.equal(legacyCalls,0)
})

for (const recoveryProof of ['clean','effects','external-stage','plan-receipt','unfixed-source']) test(`已有Task直接调查但Owner等待时经本机上下文修订目标和授权，保留原来源及查询成果：${recoveryProof}`,async t=>{
  const external = { releaseAdapters: { 'uat-deployment': { id: 'fixture', version: '1', rulesDigest: 'a'.repeat(64),
    inspect: async () => { throw Error('UNEXPECTED_EXTERNAL') }, prepareOperation: async () => { throw Error('UNEXPECTED_EXTERNAL') } } },
  dataChangeAdapter: { id: 'context-source-test', version: '1', rulesDigest: 'a'.repeat(64),
    validate: async () => { throw Error('UNEXPECTED_EXTERNAL') }, prepareRehearsal: async () => { throw Error('UNEXPECTED_EXTERNAL') },
    readbackRehearsal: async () => { throw Error('UNEXPECTED_EXTERNAL') }, inspect: async () => { throw Error('UNEXPECTED_EXTERNAL') },
    prepareIssue: async () => { throw Error('UNEXPECTED_EXTERNAL') }, prepareApproval: async () => { throw Error('UNEXPECTED_EXTERNAL') },
    prepareExecute: async () => { throw Error('UNEXPECTED_EXTERNAL') }, readback: async () => { throw Error('UNEXPECTED_EXTERNAL') } },
  availableTargets: [{ workflowId: 'task-uat-deployment', targetId: 'uat-test' }, { workflowId: 'task-data-change', targetId: 'production-db' }],
  operationAdapter: { execute: async () => { throw Error('UNEXPECTED_EXTERNAL') }, reconcile: async () => ({ status: 'unknown' }) },
  authorizeExternal: async () => false, prepareRequirement: async () => { throw Error('UNEXPECTED_EXTERNAL') } }
  const observed=[]
  const sessions={async close(){},async run(args){
    await args.onSessionBound();const refs=await queryOwnerSources(args);observed.push({binding:args.binding,refs})
    const decision={action:'wait',summary:'当前原文已核对，仍待业务批准',evidenceRefs:refs,
      condition:{kind:'approval',missing:'本轮操作批准',responsibleParty:'审批人',resumeWhen:'审批变化后继续',evidenceRefs:refs}}
    await args.onCandidate(decision);return{status:'submitted',decision}
  }}
  const {service,execution,message,root}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},external,taskOwnerSessions:sessions})
  const received=await service.ingest(message),initial=await service.messages.process(received.runId),taskId=initial.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const original=await execution.controller.taskPlan(taskId),originalInput=await execution.artifacts.read(original.task.requirementRef)
  const originalAcceptance=await execution.store.query({kind:'task.owner.acceptance',taskId}),preservedOutput=observed[0].refs[0]
  const revision={objective:'按批准方案部署至 UAT',acceptanceCriteria:['UAT 版本独立回读'],stageTargets:{'task-uat-deployment':'uat-test','task-data-change':'production-db'},stageAuthorizations:[
    {workflowId:'task-uat-deployment',sourceQuote:'按批准方案部署至 UAT',objective:'按批准方案部署至 UAT',gate:'none'},
    {workflowId:'task-data-change',sourceQuote:'按批准方案部署至 UAT',objective:'按批准方案部署至 UAT',gate:'none'}]}
  const runtime={isWorkflowTask:()=>true,submitWorkflowTask:request=>service.submitWebTask(request,{channel:'web',actorId:'owner'})}
  const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const post=body=>fetch(`http://127.0.0.1:${server.address().port}/tasks/${taskId}/context`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const input={requestId:'explicit-revision',inputVersion:2,runSequence:0,context:'按批准方案部署至 UAT。由本机执行人明确修订，保留已有成果。',requirement:revision}
  assert.equal((await post({...input,requirement:{...revision,stageTargets:{'task-uat-deployment':'unknown'}}})).status,400)
  const accepted=await post(input);assert.equal(accepted.status,202,await accepted.text());assert.equal((await post(input)).status,202)
  const revisedPlan=await execution.controller.taskPlan(taskId),goal=await execution.artifacts.read(revisedPlan.task.requirementRef)
  assert.equal(goal.objective,revision.objective);assert.deepEqual(goal.acceptanceCriteria,revision.acceptanceCriteria)
  const revisedAcceptance=await execution.store.query({kind:'task.owner.acceptance',taskId})
  assert.deepEqual(revisedAcceptance.map(item=>item.criterion),revision.acceptanceCriteria)
  assert.ok(revisedAcceptance.every(item=>item.sourceKey===goal.authorization.sourceKey&&!originalAcceptance.some(old=>old.itemId===item.itemId)))
  const auditDb=new DatabaseSync(join(root,'control.db'),{readOnly:true})
  try {
    const history=auditDb.prepare('SELECT item_id,criterion,active FROM task_acceptance_items WHERE task_id=? ORDER BY rowid').all(taskId)
    assert.equal(history.length,originalAcceptance.length+revisedAcceptance.length)
    for(const item of originalAcceptance)assert.deepEqual({...history.find(row=>row.item_id===item.itemId)},{item_id:item.itemId,criterion:item.criterion,active:0})
  }finally{auditDb.close()}
  assert.deepEqual(goal.sourceInstructions.slice(0,-1),originalInput.sourceInstructions)
  assert.deepEqual(await execution.artifacts.read(original.task.requirementRef),originalInput)
  assert.equal((await execution.artifacts.read(preservedOutput)).execution.requirementRevision,1)
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
  assert.equal((await post({...input,context:'冲突内容'})).status,409)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const source=await execution.store.query({kind:'task.source',sourceKey:goal.authorization.sourceKey})
  assert.equal(source.body,input.context);assert.equal(source.channel,'web');assert.equal(source.actorId,'owner')
  const priorOwner=await execution.store.query({kind:'task.owner',taskId}),turnId=`old-source-decision-${recoveryProof}`
  await execution.store.command({id:'recovery-event',kind:'task.owner.event',args:{taskId,eventKey:'recovery-event',eventType:'system.recovery'}})
  const claim=(await execution.store.command({id:'recovery-claim',kind:'task.owner.claim',args:{taskId,turnId,expectedLeaseEpoch:priorOwner.leaseEpoch}})).result
  await execution.store.command({id:recoveryProof==='plan-receipt'?`owner-plan:${turnId}`:'recovery-bound',kind:'task.owner.sessionBound',args:{taskId,turnId,leaseEpoch:claim.leaseEpoch,sessionId:priorOwner.sessionId}})
  const condition={sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:revision.objective,objective:revision.objective}
  const failedCondition={...condition,...(recoveryProof==='unfixed-source'?{sourceVersion:2}:{})}
  await execution.store.command({id:'recovery-candidate',kind:'task.owner.candidate',args:{taskId,turnId,leaseEpoch:claim.leaseEpoch,decision:{action:'advance',summary:'原来源解析拒绝的待执行计划',evidenceRefs:observed.at(-1).refs,
    planChange:{kind:'initialize',stages:[{workflowId:'task-data-change',gate:'none',sourceCondition:failedCondition}]}}}})
  await execution.store.command({id:'recovery-accept',kind:'task.owner.accept',args:{taskId,turnId,leaseEpoch:claim.leaseEpoch}})
  await execution.store.command({id:'recovery-fail',kind:'task.owner.action.fail',args:{taskId,turnId,leaseEpoch:claim.leaseEpoch,reason:'TASK_STAGE_SOURCE_CONDITION_INVALID'}})
  if(recoveryProof==='external-stage')await execution.controller.initializeTaskPlan({commandId:'historical-external',taskId,expectedPlanRevision:0,expectedRequirementRevision:2,expectedControlRevision:revisedPlan.task.controlRevision,
    stages:[{stageId:'external',workflowId:'task-data-change',input:{},gate:'none',sourceCondition:condition}]})
  if(recoveryProof==='effects'){
    const db=new DatabaseSync(join(root,'control.db'));const now=new Date().toISOString(),hash='a'.repeat(64)
    try{
      db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,created_at,updated_at) VALUES('effect-run',?,'task-data-change',?,?,'succeeded',?,?)").run(taskId,hash,revisedPlan.task.requirementRef,now,now)
      db.prepare("INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status,drained) VALUES('effect-node','effect-run','execute','1','operation',0,1,?,?,'succeeded',1)").run(revisedPlan.task.requirementRef,hash)
      db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('historical-effect','operation','effect-run','effect-node','execute',1,?,?,'{}','[]','test','succeeded',?,?)").run(hash,hash,now,now)
    }finally{db.close()}
  }
  const owner=await execution.store.query({kind:'task.owner',taskId})
  const request={taskId,recoveryKey:'accepted-web-context',reason:'按本轮原文授权重新评估待执行计划',expectedOwnerRevision:owner.revision,expectedLeaseEpoch:owner.leaseEpoch,expectedRequirementRevision:2,expectedControlRevision:revisedPlan.task.controlRevision}
  if(recoveryProof!=='clean'){
    await assert.rejects(service.reassessReadonly(request,{channel:'web',actorId:'owner'}),/TASK_OWNER_REASSESS_FORBIDDEN|TASK_OWNER_DISCARD_UNSAFE/)
    const checked=new DatabaseSync(join(root,'control.db'),{readOnly:true})
    try {assert.equal(checked.prepare('SELECT application_status FROM task_owner_turns WHERE turn_id=?').get(turnId).application_status,'blocked')}finally{checked.close()}
    return
  }
  const reassessed=await service.reassessReadonly(request,{channel:'web',actorId:'owner'})
  assert.equal(reassessed.discardedTurnId,turnId);assert.deepEqual(await service.reassessReadonly(request,{channel:'web',actorId:'owner'}),reassessed)
  assert.equal((await execution.store.query({kind:'task.owner',taskId})).sessionId,owner.sessionId)
  const stage={stageId:'submit-ddl',workflowId:'task-data-change',gate:'none',sourceCondition:condition}
  for(const patch of [{sourceVersion:2},{requiredActorId:'other'},{sourceQuote:'不存在的授权原文',objective:'不存在的授权原文'}])
    await assert.rejects(execution.controller.initializeTaskPlan({commandId:`invalid-web-source-${Object.keys(patch)[0]}`,taskId,expectedPlanRevision:0,expectedRequirementRevision:2,expectedControlRevision:revisedPlan.task.controlRevision,stages:[{...stage,input:{},sourceCondition:{...condition,...patch}}]}),/TASK_STAGE_SOURCE_CONDITION_INVALID/)
  await assert.rejects(execution.controller.createTaskPlan({commandId:'cross-task-web-source',taskId:'unrelated-context-task',stages:[{...stage,stageId:'foreign',input:{}}]}),/TASK_STAGE_SOURCE_CONDITION_INVALID/)
  await execution.controller.initializeTaskPlan({commandId:'accepted-web-context-stage',taskId,expectedPlanRevision:0,expectedRequirementRevision:2,expectedControlRevision:revisedPlan.task.controlRevision,stages:[{...stage,input:{}}]})
  const advanced=await execution.controller.taskPlan(taskId)
  assert.equal(advanced.stages.length,1);assert.deepEqual(advanced.stages[0].sourceCondition,condition);assert.equal(advanced.stages[0].status,'ready')
})

test('Controller未排空错误投影等待原因，不能显示正常执行',async t=>{
 const {service,execution,message}=await fixture(t,'owner')
 const workflow={id:'undrained-controller',version:'1',nodes:[{id:'execute',version:'1',executor:'code',allowedEffects:['pure'],
  inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,
  execute:async()=>{throw Object.assign(new Error('EXECUTOR_DRAIN_EVIDENCE_REQUIRED'),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED',executionDrained:false})}}]}
 execution.controller.registerWorkflow(workflow)
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result
 assert.equal(task.runId,null)
 await execution.controller.initializeTaskPlan({commandId:'undrained-plan',taskId:task.taskId,expectedPlanRevision:0,expectedRequirementRevision:1,
  stages:[{stageId:'operation',workflowId:workflow.id,input:{request:'核验执行排空'}}]})
 const plan=await execution.controller.advanceTaskPlan(task.taskId),runId=plan.stages[0].runId
 await assert.rejects(execution.controller.whenIdle(runId),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED'})
 assert.equal((await execution.controller.state(runId)).run.status,'running')
 assert.equal((await execution.controller.state(runId)).controllerError,'EXECUTOR_DRAIN_EVIDENCE_REQUIRED')
 const view=(await service.tasks())[0];assert.equal(view.state,'waiting');assert.equal(view.waitingReason,'处理程序异常，需要维护人员修复后重新评估。')
})

test('Web事件已准备后中断由恢复通路接纳一次，后续恢复不重复输入',async t=>{
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'}})
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result
 assert.equal(task.runId,null)
 await execution.controller.controlTask({commandId:'prepare-pause',taskId:task.taskId,intent:'pause',expectedControlRevision:(await execution.controller.taskPlan(task.taskId)).task.controlRevision})
 const plan=await execution.controller.taskPlan(task.taskId)
 assert.equal(plan.task.controlState,'paused')
 const prior=await execution.artifacts.read(plan.task.requirementRef)
 await execution.store.command({id:'prepare-only',kind:'message.web-task.prepare',args:{eventId:'web-crash',actorId:'owner',executionRunId:null,request:{taskId:task.taskId,action:'context',requestId:'crash',inputVersion:plan.task.requirementRevision+1,runSequence:0,context:'新要求'},input:{...prior,request:prior.request+'\n新要求'}}})
 assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
 assert.equal((await execution.store.query({kind:'message.web-task',eventId:'web-crash'})).status,'accepted')
 const before=await execution.controller.taskPlan(task.taskId),beforeOwner=await execution.store.query({kind:'task.owner',taskId:task.taskId})
 assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
 const after=await execution.controller.taskPlan(task.taskId),afterOwner=await execution.store.query({kind:'task.owner',taskId:task.taskId})
 assert.deepEqual(after,before);assert.equal(afterOwner.eventWatermark,beforeOwner.eventWatermark)
 assert.equal(after.task.controlState,'paused');assert.equal(after.task.requirementRevision,plan.task.requirementRevision+1)
 assert.match((await execution.artifacts.read(after.task.requirementRef)).request,/新要求/u)
 assert.deepEqual(await execution.store.query({kind:'run.list',taskId:task.taskId}),[])
})

test('C01 媒体连接器挂起不阻durable接收和独立SQLite读回',{timeout:5000},async t=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r)
 const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:'create',arguments:{objective:'读取附件'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:['file'],replyPolicy:'result'}
 let remote
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,readMessage:async()=>remote,readResource:async()=>{started();await gate;return{text:'完整材料'}}})
 remote={...message,conversationId:'g',resourceRefs:[{type:'fileId',resourceId:'file'}]}
 const received=await service.ingest({...message,resourceRefs:[{type:'fileId',resourceId:'file'}]})
 try{await began;const persisted=await execution.store.query({kind:'message.run',runId:received.runId});assert.equal(persisted.run.body,message.text);assert.equal(persisted.commands.length,1);assert.equal(persisted.commands[0].status,'pending');assert.equal((await execution.store.query({kind:'run.list'})).length,0)}finally{release()}
 await service.messages.process(received.runId)
 let settled
 for(let attempt=0;attempt<100;attempt++){
   settled=await service.state(received.runId)
   if(settled.commands[0]?.status==='applied')break
   await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.equal(settled.commands[0].status,'applied')
})

test('只关联话题时意图仍读到已执行Task及结果限制，运行成功不冒充目标达成', async t => {
  let observed, routingCard
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') {
      routingCard = input.candidates.find(item => item.taskId)
      return input.candidates.length
        ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates.find(item => item.topicId)?.candidateId ?? input.candidates[0].candidateId, evidence: ['同一账号问题'] }
        : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新问题'] }
    }
    if (input.text === '继续查这个账号') {
      observed = { ...input.facts, sharedTasks: input.sharedTasks }
      return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '查 test3 账号创建记录' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    judge, taskOwnerSessions: { async run({ binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
      await onSessionBound()
      const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
      for (const ref of refs) await readArtifact(ref)
      const decision = { action: 'block', summary: '仅整理了消息文字，账号创建日志仍缺失', evidenceRefs: refs,
        condition: { kind: 'capability', missing: '没有读取账号创建日志的受信能力', responsibleParty: '维护方',
          resumeWhen: '提供账号日志只读能力后继续', evidenceRefs: refs } }
      await onCandidate(decision); return { status: 'submitted', decision }
    }, async close() {} },
  })
  const first = await service.ingest({ ...message, text: '查 test3 账号创建记录' })
  const accepted = await service.messages.process(first.runId)
  assert.ok(accepted.commands.length, JSON.stringify({ run: accepted.run, requests: accepted.requests, nodes: accepted.nodes }))
  const taskId = accepted.commands[0].result.taskId
  assert.equal(accepted.commands[0].result.runId, null)
  await settleTaskOwners(service, service.execution)
  const second = await service.ingest({ ...message, messageId: 'followup', text: '继续查这个账号' })
  await service.messages.process(second.runId)
  const taskReference = observed?.tasks?.find(item => item.taskId === taskId) ?? observed?.topicTasks?.tasks?.find(item => item.taskId === taskId)
  const task = taskReference
  assert.ok(task, JSON.stringify(observed))
  assert.ok(routingCard.distinguishingFacts.some(item => item.includes('账号创建日志')), JSON.stringify({routingCard,task}))
  assert.equal(task.run, null)
  assert.notEqual(task.objectiveAssessment.status, 'satisfied')
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
  assert.notEqual((await service.tasks()).find(item => item.taskId === taskId)?.state, 'completed')
})

async function managedMarkdownFixture(t, notifications, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'owner-managed-markdown-'))
  const files = join(root, 'files')
  const adapter = createTaskMarkdownFileAdapter({ root: files,
    getTaskDirectories: taskId => ({ outputs: join(root, 'tasks', taskId, 'outputs') }) })
  return fixture(t, 'owner', notifications, { ...options, root, taskFiles: true,
    config: { ...options.config, taskOutputDirectory: files },
    deliveryOptions: { fileAdapter: options.fileAdapter ? options.fileAdapter(adapter) : adapter,
      authorize: async () => null, authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
        ? { principalId: 'owner', authorizationRef: 'fixture-write-grant' } : null },
  })
}
const markdownStage = (content, gate = 'none') => ({ workflowId: 'task-general-capability', gate,
  capabilityStep: { capabilityId: 'write-task-markdown', input: { content }, expectedEvidence: '完整文件已独立读回' } })

test('方案阶段完成后等待确认，确认沿用业务Task并只启动下一阶段', async t => {
  const sent = []
  let execution
  const notifications = { canDisclose: async () => true,
    send: async notice => { sent.push(notice.payload.text); return { messageId: `reply-${sent.length}` } },
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
    return input.text.startsWith('确认方案')
      ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '继续执行' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先给方案，确认后继续',
        explicitStages: ['先给方案，确认后继续'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  }
  const taskOwnerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const complete = input.stages.length === 2 && input.stages.every(stage => stage.status === 'succeeded')
    const decision = { action: complete ? 'complete'
      : input.stages.some(stage => stage.status === 'ready') ? 'advance' : 'wait',
      summary: complete ? '两段工作已核验' : '等待方案确认或流程完成',
      ...(!complete && input.stages.length && !input.stages.some(stage => stage.status === 'ready')
        ? { condition: { kind: 'approval', missing: '后续阶段方案确认', responsibleParty: '交办人',
          resumeWhen: '确认后续阶段后继续', evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []) } } : {}),
      evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
        evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []) })) } : {}),
    }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution: actual, message } = await managedMarkdownFixture(t, notifications, { judge, taskOwnerSessions })
  execution = actual
  const first = await service.ingest({ ...message, text: '生成Markdown文件，先给方案，确认后继续' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  const current = await execution.controller.taskPlan(taskId)
  const requirement = await execution.artifacts.read(current.task.requirementRef)
  await execution.controller.initializeTaskPlan({ commandId: 'confirmed-write-plan', taskId,
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: ['# 待确认方案', '# 确认后生成的执行文档'].map((content, index) => ({
      stageId: `file-${index + 1}`, workflowId: 'task-general-capability', gate: index ? 'confirmation' : 'none',
      ...(index ? {} : { input: { capabilityId: 'write-task-markdown', input: { content }, scope: { ...requirement.scope, predecessorOutputRef: null },
        expectedEvidence: '完整文件已独立读回' } }) })) })
  let initialPlan = await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.whenIdle(initialPlan.stages[0].runId)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('需要你确认：') && item.includes('方案确认')).length, 1)
  let plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.status, 'waiting_confirmation')
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
  // Host 明确登记的真人阶段确认绑定精确前序产物；不放宽 Owner 写能力的 none gate。
  await execution.controller.confirmTaskStage({ commandId: 'confirmed-file-stage', taskId, stageId: plan.stages[1].stageId,
    planRevision: plan.task.planRevision, expectedControlRevision: plan.task.controlRevision,
    expectedRequirementRevision: plan.task.requirementRevision, outputRef: plan.stages[0].outputRef })
  await execution.controller.bindTaskStageInput({ commandId: 'confirmed-file-input', taskId,
    planRevision: plan.task.planRevision, stageId: plan.stages[1].stageId, predecessorOutputRef: plan.stages[0].outputRef,
    input: { capabilityId: 'write-task-markdown', input: { content: '# 确认后生成的执行文档' },
      scope: { ...requirement.scope, predecessorOutputRef: plan.stages[0].outputRef }, expectedEvidence: '完整文件已独立读回' } })
  plan = await execution.controller.advanceTaskPlan(taskId)
  assert.equal(plan.stages[1].status, 'running')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded', JSON.stringify({owner:await execution.store.query({kind:'task.owner',taskId}),state:await execution.controller.state(plan.stages[1].runId)}))
})

test('UAT 缺受信适配器时直接查询证据保留，Owner 后续阶段明确受阻', async t => {
  let refs
  const sessions = { async run({ binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    for (const ref of refs) await readArtifact(ref)
    const decision = { action: 'advance', summary: '来源分析完成，尝试提测', evidenceRefs: refs,
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-uat-deployment', gate: 'none' }] } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest({ ...message, text: '分析并提测' })
  const result = await service.messages.process(received.runId)
  const taskId = result.commands[0].result.taskId
  await settleTaskOwners(service, execution)
  const task = (await service.tasks()).find(item => item.taskId === taskId)
  assert.equal(task.state, 'queued')
  assert.equal(task.plan.stages.length, 0)
  assert.equal(task.taskOwner.lastFailure, 'TASK_OWNER_STAGE_NOT_AUTHORIZED')
  const evidence = await execution.artifacts.read(refs[0])
  assert.equal(evidence.kind, 'agent-query-evidence')
  assert.ok(evidence.result.sources.some(item => item.text === '分析并提测'))
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 0)
})

test('阶段间取消后经原发送人重新授权，只替换未完成后缀', async t => {
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const ready = input.stages.some(stage => stage.status === 'ready')
    const decision = { action: ready ? 'advance' : 'wait', summary: '等待确认或执行结果', evidenceRefs: [],
      ...(!ready ? { condition: { kind: 'approval', missing: '后续阶段确认', responsibleParty: '交办人', resumeWhen: '确认后继续', evidenceRefs: [] } } : {}) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({stage,input}) => stage === 'S' ? splitOne(input.source.text) : stage === 'R' ? input.candidates.length
    ? {kind:'binding',disposition:'existing',candidateId:input.candidates[0].candidateId,evidence:['原任务']}
    : {kind:'binding',disposition:'new',candidateId:null,evidence:['新任务']}
    : {kind:'intent',actions:[{intent:input.text.startsWith('取消')?'cancel':input.text.startsWith('重新')?'reopen':'create',
      arguments:input.text.startsWith('取消')?{}:{objective:input.text.startsWith('重新')?'重新生成后续Markdown文件':'先保存方案'},
      dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}
  const {service,execution,message} = await managedMarkdownFixture(t, undefined, {judge,taskOwnerSessions:sessions})
  const source = await service.ingest({...message,text:'先生成Markdown文件，方案确认后继续生成第二份文件'})
  const accepted = await service.messages.process(source.runId), taskId = accepted.commands[0].result.taskId
  const current = await execution.controller.taskPlan(taskId), requirement = await execution.artifacts.read(current.task.requirementRef)
  await execution.controller.initializeTaskPlan({commandId:'cancel-suffix-plan',taskId,expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'first',workflowId:'task-general-capability',input:{capabilityId:'write-task-markdown',input:{content:'# 已保存方案'},scope:{...requirement.scope,predecessorOutputRef:null},expectedEvidence:'文件读回'}},
      {stageId:'second',workflowId:'task-general-capability',gate:'confirmation'}]})
  let plan = await execution.controller.advanceTaskPlan(taskId)
  const firstRunId = plan.stages[0].runId
  await execution.controller.whenIdle(firstRunId); await settleTaskOwners(service, service.execution)
  plan = await execution.controller.taskPlan(taskId)
  const firstOutput = plan.stages[0].outputRef
  assert.equal(plan.stages[1].status,'waiting_confirmation')
  const cancel = await service.ingest({...message,messageId:'cancel-between',text:'取消这个任务'})
  await service.messages.process(cancel.runId)
  assert.equal((await execution.controller.taskPlan(taskId)).task.controlState,'cancelled')
  const cancelled = (await service.tasks()).find(item=>item.taskId===taskId)
  assert.equal(cancelled.outcome,'cancelled')
  const reopen = await service.ingest({...message,messageId:'reopen-after-cancel',text:'重新生成后续Markdown文件'})
  const resumed = await service.messages.process(reopen.runId)
  assert.equal(resumed.commands[0].status,'applied',JSON.stringify(resumed.commands[0]))
  plan = await execution.controller.taskPlan(taskId)
  // 受信 Host 按重开消息授权替换未执行的文件阶段，不让模型绕过写入阶段边界。
  await execution.controller.reviseTaskPlan({commandId:'reopened-file-suffix',taskId,expectedPlanRevision:plan.task.planRevision,
    requirementRevision:plan.task.requirementRevision,expectedControlRevision:plan.task.controlRevision,affectedFrom:1,
    stages:[{stageId:plan.stages[0].stageId,workflowId:plan.stages[0].workflowId},
      {stageId:'replacement',workflowId:'task-general-capability'}]})
  plan = await execution.controller.taskPlan(taskId)
  const revisedRequirement = await execution.artifacts.read(plan.task.requirementRef)
  await execution.controller.bindTaskStageInput({commandId:'reopened-file-input',taskId,stageId:'replacement',
    planRevision:plan.task.planRevision,expectedControlRevision:plan.task.controlRevision,
    predecessorOutputRef:firstOutput,input:{capabilityId:'write-task-markdown',input:{content:'# 重新授权的后续文件'},
      scope:{...revisedRequirement.scope,predecessorOutputRef:firstOutput},expectedEvidence:'文件读回'}})
  await settleTaskOwners(service, service.execution)
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.planRevision,2)
  assert.equal(plan.task.controlState,'active')
  assert.equal(plan.stages[0].runId,firstRunId)
  assert.equal(plan.stages[0].outputRef,firstOutput)
  assert.equal(plan.stages[0].status,'succeeded')
  assert.ok(plan.stages[1].runId,JSON.stringify(plan))
  assert.equal((await execution.store.query({kind:'run.list',taskId})).length,2)
})

test('已绑定Owner会话确实缺失时换代并在原Task恢复，旧任务命令不重复创建', async t => {
  let first = true
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    if (first) {
      first = false
      await onSessionBound()
      throw Object.assign(new Error('missing'), { code: 'TASK_OWNER_SESSION_MISSING' })
    }
    await onSessionBound()
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    for (const ref of refs) await readArtifact(ref)
    const decision = { action: 'complete', summary: '恢复同一任务并核验原始来源', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest(message)
  const attempted = await service.messages.process(received.runId)
  assert.equal(attempted.commands[0].status, 'applied')
  assert.equal(attempted.commands[0].result.reply, '正在核对执行条件，处理尚未开始。')
  await settleTaskOwners(service, service.execution)
  const before = (await execution.store.query({ kind: 'task.owners.list', limit: 10 }))[0]
  assert.equal(before.ownerEpoch, 2)
  assert.equal(before.status, 'idle')
  assert.equal(before.decision.action, 'complete')
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  const after = await execution.store.query({ kind: 'task.owner', taskId: before.taskId })
  assert.equal(after.taskId, before.taskId)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.ownerEpoch, 2)
  assert.equal((await execution.store.query({ kind: 'task.owners.list', limit: 10 })).length, 1)
  assert.equal((await execution.controller.taskPlan(before.taskId)).stages.length, 0)
  assert.equal(after.decision.action, 'complete')
})

test('专业分析在同一 Task 会话回读查询证据，不依赖调查阶段或 general intake', async t => {
  let readCount = 0
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const queried = await readArtifact(refs[0]); readCount++
    assert.equal(queried.execution.taskId, binding.taskId)
    assert.equal(queried.execution.sessionId, binding.sessionId)
    assert.ok(queried.result.sources.some(item => item.text === '先分析再核对产物'))
    const decision = { action: 'complete', summary: '分析及原始查询证据回读均完成', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const receipt = await service.ingest({ ...message, text: '先分析再核对产物' })
  const handled = await service.messages.process(receipt.runId)
  const taskId = handled.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.equal(readCount, 1)
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 0)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision.action, 'complete')
  const evidence = await execution.artifacts.read(owner.decision.evidenceRefs[0])
  assert.equal(evidence.kind, 'agent-query-evidence')
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})

test('Owner 在零阶段 Task 直接查询来源并完成原文整理，不产生调查Run', async t => {
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    assert.equal(input.stages.length, 0)
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const evidence = await readArtifact(refs[0])
    const decision = { action: 'complete', summary: evidence.result.sources.map(item => item.text).join('\n'),
      evidenceRefs: refs, assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest({ ...message, text: '整理消息原文' })
  const handled = await service.messages.process(received.runId)
  const taskId = handled.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.deepEqual((await execution.controller.taskPlan(taskId)).stages, [])
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.action, 'complete')
})
test('执行中收到追加文件意图时保留当前Run，完成后从核验产物启动后继', async t => {
  let release, began, writes = 0
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { began = resolve })
  t.after(() => release())
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const refs = input.stages.map(stage => stage.outputRef).filter(Boolean)
    const ready = input.stages.some(stage => stage.status === 'ready')
    const completed = input.stages.every(stage => stage.status === 'succeeded')
    const decision = ready ? { action: 'advance', summary: '写入已授权文件', evidenceRefs: refs }
      : completed ? { action: 'complete', summary: '两份文件已读回', evidenceRefs: refs,
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
      : { action: 'wait', summary: '等待已授权写入', evidenceRefs: refs,
        condition: { kind: 'execution', missing: '文件写入结果', responsibleParty: '执行方',
          resumeWhen: '写入及回读完成后继续', evidenceRefs: refs } }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : { kind: 'intent', actions: [{ intent: input.text.startsWith('追加') ? 'reopen' : 'create',
        arguments: { objective: input.text }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, execution, message } = await managedMarkdownFixture(t, undefined, { judge, taskOwnerSessions: sessions,
    fileAdapter: adapter => ({ ...adapter, async execute(prepared) {
      if (++writes === 1) { began(); await gate }
      return adapter.execute(prepared)
    } }) })
  const first = await service.ingest({ ...message, text: '生成第一份Markdown文件' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  let plan = await execution.controller.taskPlan(taskId)
  const initial = await execution.artifacts.read(plan.task.requirementRef)
  await execution.controller.initializeTaskPlan({ commandId: 'running-file-plan', taskId,
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'first', workflowId: 'task-general-capability',
      input: { capabilityId: 'write-task-markdown', input: { content: '# 第一份文件' },
        scope: { ...initial.scope, predecessorOutputRef: null }, expectedEvidence: '文件读回' } }] })
  plan = await execution.controller.advanceTaskPlan(taskId); await started
  const firstRunId = plan.stages[0].runId
  const second = await service.ingest({ ...message, messageId: 'append-later', text: '追加生成第二份Markdown文件' })
  const appended = await service.messages.process(second.runId)
  assert.equal(appended.commands[0].status, 'applied')
  plan = await execution.controller.taskPlan(taskId)
  // Host 只增加消息明确授权的后续文件阶段；当前外部效果继续使用冻结输入。
  await execution.controller.extendTaskPlan({ commandId: 'append-file-stage', taskId,
    expectedPlanRevision: plan.task.planRevision, expectedControlRevision: plan.task.controlRevision,
    requirementRevision: plan.task.requirementRevision, stages: [{ stageId: 'second', workflowId: 'task-general-capability' }] })
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[1].status, 'blocked')
  assert.equal(writes, 1)
  release(); await execution.controller.whenIdle(firstRunId)
  await execution.controller.advanceTaskPlan(taskId)
  plan = await execution.controller.taskPlan(taskId)
  const requirement = await execution.artifacts.read(plan.task.requirementRef)
  await execution.controller.bindTaskStageInput({ commandId: 'bind-file-successor', taskId,
    planRevision: plan.task.planRevision, expectedControlRevision: plan.task.controlRevision, stageId: 'second',
    predecessorOutputRef: plan.stages[0].outputRef,
    input: { capabilityId: 'write-task-markdown', input: { content: '# 第二份文件' },
      scope: { ...requirement.scope, predecessorOutputRef: plan.stages[0].outputRef }, expectedEvidence: '文件读回' } })
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  plan = await execution.controller.taskPlan(taskId)
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.status, 'succeeded')
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
  assert.equal(writes, 2)
})

test('纯排查完成后续办仍用原业务Task，原查询证据冻结且不产生调查Run', async t => {
  const records = []
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const evidence = await readArtifact(refs[0])
    records.push({ sessionId: binding.sessionId, revision: binding.requirementRevision, ref: refs[0], evidence })
    const decision = { action: 'complete', summary: input.goal.request, evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : { kind: 'intent', actions: [{ intent: input.text.startsWith('继续') ? 'reopen' : 'create',
        arguments: { objective: input.text }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions })
  const first = await service.ingest({ ...message, text: '仅排查' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.equal((await service.tasks()).find(item => item.taskId === taskId).state, 'completed')
  const prior = records[0]
  const second = await service.ingest({ ...message, messageId: 'continue-task', text: '继续分析' })
  const resumed = await service.messages.process(second.runId)
  assert.equal(resumed.commands[0].status, 'applied')
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.equal((await service.tasks()).length, 1)
  assert.equal(records.length, 2)
  assert.equal(records[1].sessionId, prior.sessionId)
  assert.equal(records[1].revision, prior.revision + 1)
  assert.notEqual(records[1].ref, prior.ref)
  assert.deepEqual(await execution.artifacts.read(prior.ref), prior.evidence)
  assert.deepEqual((await execution.controller.taskPlan(taskId)).stages, [])
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})

test('C13 渠道读回挂起时新业务和取消继续，ACK不冒充送达', { timeout: 15000 }, async t => {
  let readStarted, releaseRead, executionStarted, releaseExecution, executions = 0, disclose = false
  const reading = new Promise(resolve => { readStarted = resolve }), readGate = new Promise(resolve => { releaseRead = resolve })
  const running = new Promise(resolve => { executionStarted = resolve }), executionGate = new Promise(resolve => { releaseExecution = resolve })
  t.after(() => { releaseExecution(); releaseRead() })
  const notices = { canDisclose: async () => disclose, send: async notice => ({ messageId: notice.id }),
    readback: async notice => { readStarted(); await readGate; return { messageId: notice.id, conversationId: 'g' } } }
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate, signal }) {
    await onSessionBound()
    if (++executions === 1) {
      executionStarted()
      await Promise.race([executionGate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      signal.throwIfAborted()
    }
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    for (const ref of refs) await readArtifact(ref)
    const decision = { action: 'complete', summary: '完成', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', notices,
    { config: { webActorId: 'owner' }, taskOwnerSessions: sessions })
  const first = await service.ingest(message)
  const accepted = await service.messages.process(first.runId)
  const task = accepted.commands[0].result
  const working = service.recover()
  await running
  // 单独构造既有必要业务确认通知，验证渠道读回不会占住任务推进；不恢复中间进展通知。
  await execution.store.command({ id: 'c13-needed-confirmation', kind: 'message.notification.prepare',
    args: { runId: first.runId, notificationId: 'c13-needed-confirmation', commandId: accepted.commands[0].commandId,
      payload: { text: '请确认业务授权', conversationId: 'g', sourceMessageId: message.messageId },
      disclosure: { conversationId: 'g', authorizationRef: 'source-business-confirmation' } } })
  await service.flushNotifications()
  assert.equal((await execution.store.query({ kind: 'message.notifications' }))[0].status, 'prepared')
  disclose = true
  const flushing = service.flushNotifications()
  try {
    await reading
    const pending = await execution.store.query({ kind: 'message.notifications' })
    assert.ok(pending.some(notice => notice.status === 'acknowledged'))
    assert.ok(!pending.some(notice => notice.status === 'delivered'))
    const next = await service.ingest({ ...message, messageId: 'second' })
    const acceptedNext = await service.messages.process(next.runId)
    const nextTaskId = acceptedNext.commands[0].result.taskId
    let nextOwner
    for (let attempt = 0; attempt < 100; attempt++) {
      nextOwner = await execution.store.query({ kind: 'task.owner', taskId: nextTaskId })
      if (nextOwner.decision?.action === 'complete' && nextOwner.applicationStatus === 'applied') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(nextOwner.decision?.action, 'complete', JSON.stringify(nextOwner))
    const view = (await service.tasks()).find(item => item.taskId === task.taskId)
    assert.equal(view.state, 'running')
    await service.submitWebTask({ action: 'cancel', taskId: task.taskId, requestId: 'cancel-during-readback',
      inputVersion: view.inputVersion, runSequence: view.runSequence, reason: '取消' }, { channel: 'web', actorId: 'owner' })
    assert.equal((await execution.controller.taskPlan(task.taskId)).task.controlState, 'cancelled')
  } finally { releaseExecution(); releaseRead() }
  await working; await flushing
  assert.equal((await execution.store.query({ kind: 'message.notifications', states: ['delivered'] })).length, 1)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId: task.taskId }), [])
})

test('慢Owner会话悬挂时，已有受管文件阶段仍由Service观察并完成验收', { timeout: 15000 }, async t => {
  let releaseOwner, ownerStarted, releaseWrite, writeStarted
  const slowGate = new Promise(resolve => { releaseOwner = resolve })
  const slowStarted = new Promise(resolve => { ownerStarted = resolve })
  const fileGate = new Promise(resolve => { releaseWrite = resolve })
  const writing = new Promise(resolve => { writeStarted = resolve })
  t.after(() => { releaseOwner(); releaseWrite() })
  const sessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate, signal }) {
    await onSessionBound()
    if (input.goal.request === '慢查询需要保持会话') {
      ownerStarted()
      await Promise.race([slowGate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      signal.throwIfAborted()
      const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
      for (const ref of refs) await readArtifact(ref)
      const decision = { action: 'complete', summary: '慢查询已完成', evidenceRefs: refs,
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
      await onCandidate(decision); return { status: 'submitted', decision }
    }
    const refs = input.stages.flatMap(stage => stage.evidenceRefs ?? [])
    const complete = input.stages.length > 0 && input.stages.every(stage => stage.status === 'succeeded')
    if (complete) for (const ref of refs) await readArtifact(ref)
    const decision = !input.stages.length
      ? { action: 'advance', summary: '保存已授权文件', evidenceRefs: [],
        planChange: { kind: 'initialize', stages: [markdownStage('# 并发恢复文件')] } }
      : complete ? { action: 'complete', summary: '文件写入、读回及验收均完成', evidenceRefs: refs,
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
      : { action: 'wait', summary: '等待文件写入结果', evidenceRefs: refs,
        condition: { kind: 'execution', missing: '文件阶段结果', responsibleParty: '执行方',
          resumeWhen: '阶段完成后回读并验收', evidenceRefs: refs } }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await managedMarkdownFixture(t, undefined, { taskOwnerSessions: sessions,
    fileAdapter: adapter => ({ ...adapter, async execute(prepared) {
      writeStarted(); await fileGate
      return adapter.execute(prepared)
    } }) })
  const slowSource = await service.ingest({ ...message, text: '慢查询需要保持会话' })
  const slow = await service.messages.process(slowSource.runId)
  const slowTaskId = slow.commands[0].result.taskId
  await slowStarted
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId: slowTaskId })).status, 'running')
  const earlierRecovery = service.recover()
  const fileSource = await service.ingest({ ...message, messageId: 'guarded-file', text: '生成Markdown文件' })
  const accepted = await service.messages.process(fileSource.runId)
  const taskId = accepted.commands[0].result.taskId
  await writing
  let plan = await execution.controller.taskPlan(taskId)
  const runId = plan.stages[0].runId
  assert.equal(plan.stages[0].status, 'running')
  releaseWrite(); await execution.controller.whenIdle(runId)
  // 这里只等待真实文件执行。恢复入口须独立返回并接纳完成事件，不能等慢Owner模型。
  let timeout
  try {
    const recovered = await Promise.race([service.recover(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('慢Owner占住受管阶段恢复')), 5000)
    })])
    assert.deepEqual(recovered.failures, [])
  } finally { clearTimeout(timeout) }
  let owner
  for (let attempt = 0; attempt < 100; attempt++) {
    owner = await execution.store.query({ kind: 'task.owner', taskId })
    if (owner.decision?.action === 'complete' && owner.applicationStatus === 'applied') break
    await service.recover()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(owner.decision?.action, 'complete', JSON.stringify(owner))
  assert.equal(owner.applicationStatus, 'applied')
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[0].runId, runId)
  assert.equal(plan.stages[0].status, 'succeeded')
  const manifest = await execution.store.query({ kind: 'task.owner.delivery-manifest', taskId })
  assert.equal((await execution.artifacts.read(manifest.ref)).businessValidation.status, 'accepted')
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId: slowTaskId })).status, 'running')
  releaseOwner(); await earlierRecovery
})

test('只读轨迹 API 回读协调来源命令与已绑定 Owner，并隔离其他群', async t => {
  const { service, execution, message: original } = await managedMarkdownFixture(t)
  const message = { ...original, text: '生成Markdown文件' }
  const receipt = await service.ingest(message)
  const processed = await service.messages.process(receipt.runId)
  const command = processed.commands.find(item => item.status === 'applied')
  assert.ok(command?.result.taskId)
  const initial = await execution.controller.taskPlan(command.result.taskId)
  const requirement = await execution.artifacts.read(initial.task.requirementRef)
  await execution.controller.initializeTaskPlan({ commandId: 'trace-file-plan', taskId: command.result.taskId,
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'file', workflowId: 'task-general-capability', input: { capabilityId: 'write-task-markdown',
      input: { content: '# 已核验的文件正文' }, scope: { ...requirement.scope, predecessorOutputRef: null }, expectedEvidence: '文件读回' } }] })
  const nativePlan = await execution.controller.advanceTaskPlan(command.result.taskId)
  const runId = nativePlan.stages[0].runId
  await execution.controller.whenIdle(runId); await settleTaskOwners(service, service.execution)
  const trace = await service.messageTrace(receipt.runId)
  assert.equal(trace.runId, receipt.runId)
  assert.equal(trace.message.text,message.text)
  assert.ok(!trace.items.some(item=>['split','route','intent'].includes(item.kind)))
  const coordination=await execution.store.query({kind:'message.coordinator',conversationId:'g'})
  assert.ok(coordination.coordinator.sessionId)
  const coordinatorItem=trace.items.find(item=>item.kind==='coordinator')
  assert.ok(coordinatorItem)
  assert.equal(coordinatorItem.sessionId,coordination.coordinator.sessionId)
  assert.deepEqual(coordinatorItem.sourceRunIds,[receipt.runId])
  assert.equal(coordinatorItem.sourceMessages[0].text,message.text)
  assert.equal(coordinatorItem.id,processed.run.coordinatorConsumed.turnId)
  assert.equal(coordination.coordinator.status,'idle')
  assert.ok(processed.units.some(unit=>unit.spans.some(span=>message.text.slice(span.start,span.end)===message.text)))
  for(const item of trace.items)for(const key of ['input','output','usage','evidenceRefs'])assert.equal(Object.hasOwn(item,key),false)
  assert.ok(trace.items.some(item => item.kind === 'command' && item.summary.rows.some(row=>row.label==='后续任务')))
  const page = await service.messageTrace(receipt.runId, { limit: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.nextCursor, 1)
  const topicId = processed.units[0].topicId
  const context = await service.workflowTopicContext(topicId)
  await assert.rejects(service.workflowTopicContext(topicId, { expectedRevision: context.revision + 1 }), /MESSAGE_TOPIC_CONTEXT_STALE/)
  assert.ok(context.facts.some(fact => fact.sourceRefs.some(ref => ref.text === message.text)))
  assert.deepEqual(context.intentRuns,[]) // 已移除独立IB账；来源与命令由群会话接纳。
  const runs = await service.taskRuns(command.result.taskId)
  assert.equal(runs.taskOwner.sessionBound, true)
  assert.ok(runs.taskOwner.sessionId)
  assert.ok(runs.runs.some(run => run.runId === runId && run.nodes.some(node => node.nodeId === 'execute')))
  const outputNode = (await execution.controller.state(runId)).nodes[0]
  const outputArgs = { outputRef: outputNode.outputRef, limit: 8 }
  const outputPage = await service.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, outputArgs)
  assert.ok(outputPage.text.length > 0, JSON.stringify(outputPage))
  assert.equal(outputPage.nextCursor, 8)
  const rest = await service.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, { ...outputArgs, offset: 8, limit: 8000 })
  assert.match(outputPage.text + rest.text, /文件|Markdown/, JSON.stringify(outputPage) + JSON.stringify(rest))
  assert.equal(rest.nextCursor, null)
  assert.equal(await service.taskNodeOutput('other-task', runId, outputNode.nodeRunId, outputArgs), null)
  assert.equal(await service.taskNodeOutput(command.result.taskId, runId, 'other-node', outputArgs), null)
  await assert.rejects(service.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, { outputRef: 'wrong' }), /TASK_OUTPUT_CHANGED/)
  await assert.rejects(service.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, { outputRef: 'wrong', document: true }), /TASK_OUTPUT_CHANGED/)
  assert.equal(await service.taskNodeOutput('other-task', runId, outputNode.nodeRunId, { ...outputArgs, document: true }), null)
  const other = await openWorkflowService({ ctx: {}, config: { groupIds: ['other'], ownerActorId: 'owner' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'] }), getGroup: () => ({ messages: [] }) },
    execution, judge: async () => { throw new Error('UNEXPECTED_MODEL_CALL') },
    taskOwnerSessions: { async run() { throw new Error('UNEXPECTED_OWNER_CALL') }, async close() {} } })
  try {
    assert.equal(await other.workflowTopicContext(topicId), null)
    assert.equal(await other.messageTrace(receipt.runId), null)
    assert.equal(await other.taskRuns(command.result.taskId), null)
    assert.equal(await other.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, outputArgs), null)
    assert.equal(await other.taskNodeOutput(command.result.taskId, runId, outputNode.nodeRunId, { ...outputArgs, document: true }), null)
  } finally { await other.close() }
})

test('步骤产出只投影业务正文及限制，不泄露任意对象字段', async t => {
  const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' },
    execute: async () => ({ summary: '已检查', findings: [{ statement: '无法确认创建人', evidenceIds: ['internal'] }],
      limitations: ['缺少创建日志'], toolArguments: { secret: 'not-for-ui' }, markdown: '正文内容',
      materials: [{ id: 'hidden-material-id', text: '核对材料正文' }], files: [{ path: 'app.js', text: '代码不直接展示' }, { path: 'new.js', text: null }],
      changes: [{ path: 'app.js', content: '完整修改方案' }, { path: 'old.js', content: null }],
      replacements: [{ path: 'merge.java', expectedHash: 'hidden-hash', from: '旧计算', to: '新计算' }],
      verification: { checks: [{ id: 'build', passed: true, log: 'log-not-for-ui' }, { id: 'lint', passed: false }] } }),
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  const node = (await execution.controller.state(runId)).nodes[0]
  const result = await service.taskNodeOutput(taskId, runId, node.nodeRunId, { outputRef: node.outputRef })
  assert.match(result.text, /已检查[\s\S]*正文内容[\s\S]*无法确认创建人[\s\S]*缺少创建日志/)
  assert.match(result.text, /材料正文\n核对材料正文/)
  assert.match(result.text, /涉及文件\napp.js\nnew.js（尚不存在）/)
  assert.match(result.text, /文件变更\n写入 app.js\n文件内容：\n完整修改方案\n\n文件变更\n删除 old.js/)
  assert.match(result.text, /修改方案\n文件：merge.java\n修改前：\n旧计算\n修改后：\n新计算/)
  assert.match(result.text, /检查结果\n配置检查 1：通过[\s\S]*配置检查 2：未通过/)
  assert.doesNotMatch(result.text, /not-for-ui|internal|toolArguments|hidden-material-id|hidden-hash|代码不直接展示/)
  assert.equal(await service.taskNodeOutput(taskId, 'missing-run', node.nodeRunId, { outputRef: node.outputRef }), null)
  await assert.rejects(service.taskNodeOutput(taskId, runId, node.nodeRunId, { outputRef: node.outputRef, offset: result.totalLength + 1 }), /TASK_OUTPUT_CURSOR_INVALID/)
})

test('当前工程和分析节点逐类投影，数量去重且准备态不冒充执行', () => {
  const project = (nodeId, output) => describeTaskNodeOutput({ nodeId }, output)
  const input = { request: '任务要求', constraints: ['只在范围内操作'], baseCommit: 'abc123', materials: [{ text: '材料原文' }] }
  assert.match(project('prepare', input).text, /任务要求/)
  assert.match(project('prepare-generation', input).text, /本轮修改起点/)
  assert.match(project('prepare-workspace', input).text, /未找到属于本次节点的成功目录回执/)
  const workspace = { directory: '/isolated', sourceRepository: '/source', status: 'succeeded', developmentBranch: 'codex/existing', branchDisposition: 'reused', targetBranch: 'feature/uat2-base' }
  assert.match(project('prepare-workspace', { workspace }).text, /开发分支\ncodex\/existing（复用已有分支）\n\n提测目标分支\nfeature\/uat2-base/)
  assert.match(project('prepare-workspace', { workspace: { ...workspace, branchDisposition: 'created' } }).text, /新建分支/)
  for (const nodeId of ['analyze', 'validate-result']) assert.match(project(nodeId, { summary: '结论', limitations: ['证据不足'] }).text, /结论[\s\S]*证据不足/)
  assert.equal(project('index-files', { directories: [{ directory: 'src/', names: ['a.js', 'a.js', 'b.js'] }], excludedCount: 3 }).overview, '已索引 2 个文件；排除 3 个文件')
  assert.equal(project('select-files', { existingPaths: ['a.js', 'a.js'], newPaths: ['b.js'] }).overview, '选择已有 1 个文件；计划新建 1 个文件')
  assert.equal(project('validate-selection', { paths: ['a.js', 'b.js'] }).overview, '已选择 2 个文件')
  assert.equal(project('read-files', { files: [{ path: 'a.js', text: '正文' }, { path: 'b.js', text: null }] }).overview, '已读取 1 个文件；尚不存在 1 个文件')
  for (const nodeId of ['propose-changes', 'inspect-and-propose']) {
    const result = project(nodeId, { changes: [{ path: 'a.js', content: '完整内容' }], replacements: [{ path: 'a.js', from: '旧', to: '新' }] })
    assert.match(result.overview, /原节点未保存方案说明.*修改方案涉及 1 个文件/)
    assert.match(result.text, /完整内容[\s\S]*修改前：[\s\S]*修改后：/)
  }
  const applied = project('apply-changes', { status: 'succeeded', files: [{ path: 'a.js', actualHash: 'secret' }] })
  assert.equal(applied.overview, '已修改 1 个文件')
  assert.match(applied.text, /已修改文件/)
  assert.doesNotMatch(applied.text, /已读取|secret/)
  assert.equal(project('apply-changes', { status: 'unknown', files: [{ path: 'a.js' }] }).overview, '涉及 1 个文件')
  const verification = { checks: [{ id: 'build', passed: true, log: 'private-log' }, { id: 'lint', passed: false }] }
  assert.match(project('verify-candidate', { verification }).text, /历史记录没有检查内容说明/)
  for (const [nodeId, label] of [['prepare-commit', '已生成提交计划'], ['prepare-push', '已生成推送计划']]) {
    const result = project(nodeId, { changedPaths: ['a.js'], message: '修改说明', ref: 'feature/fix', verification })
    assert.ok(result.overview.startsWith(label))
    assert.match(result.text, /feature\/fix/)
    assert.doesNotMatch(result.text, /private-log/)
  }
  for (const [nodeId, label] of [['commit', '已创建本地提交'], ['push', '已推送至远端']]) {
    const output = { prepared: { changedPaths: ['a.js'], ref: 'feature/fix' }, receipt: { status: 'succeeded', commitId: 'abc123' } }
    assert.ok(project(nodeId, output).overview.startsWith(label))
    output.receipt.status = 'unknown'
    assert.equal(project(nodeId, output).overview, '执行结果待核对；涉及 1 个文件')
  }
  assert.equal(project('prepare-pr', { title: '修复问题', body: 'PR 正文', base: 'main', head: 'feature/fix' }).overview, '已生成 PR 草稿')
  const receipt = { status: 'succeeded', number: 9, url: 'https://example.com/pr/9', state: 'OPEN' }
  for (const nodeId of ['create-pr', 'finalize']) {
    const result = project(nodeId, nodeId === 'finalize' ? receipt : { prepared: {}, receipt })
    assert.match(result.overview, /PR #9/)
    assert.match(result.text, /https:\/\/example.com\/pr\/9[\s\S]*待合并/)
    assert.doesNotMatch(result.text, /已合并|已部署/)
  }
  const many = project('read-files', { files: Array.from({ length: 200 }, (_, i) => ({ path: `src/file-${i}.js`, text: '隐藏正文' })) })
  assert.equal(many.overview, '已读取 200 个文件')
  assert.doesNotMatch(many.text, /隐藏正文/)
})

test('只有局部替换的工程方案仍展示真实产出，分页不丢修改前后内容', async t => {
  const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' },
    execute: async () => ({ changes: [], replacements: [{ path: 'merge.java', expectedHash: 'private-hash', from: '旧计算', to: '新计算'.repeat(600) }] }),
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  const node = (await execution.controller.state(runId)).nodes[0]
  const first = await service.taskNodeOutput(taskId, runId, node.nodeRunId, { outputRef: node.outputRef })
  assert.equal(first.nextCursor, 1200)
  const rest = await service.taskNodeOutput(taskId, runId, node.nodeRunId, { outputRef: node.outputRef, offset: first.nextCursor })
  assert.equal(first.text + rest.text, `修改方案\n文件：merge.java\n修改前：\n旧计算\n修改后：\n${'新计算'.repeat(600)}`)
  assert.equal(rest.nextCursor, null)
})

test('只读历史执行 API 不把预留 Owner 身份伪装成已绑定会话', async t => {
  const { service, message } = await fixture(t, 'owner', undefined, {
    taskOwnerSessions: { async run() { throw new Error('OWNER_NOT_STARTED') }, async close() {} },
  })
  const receipt = await service.ingest(message)
  const processed = await service.messages.process(receipt.runId)
  const taskId = processed.commands.find(item => item.status === 'applied')?.result.taskId
  assert.ok(taskId)
  const result = await service.taskRuns(taskId)
  assert.ok(result.taskOwner.sessionId)
  assert.equal(result.taskOwner.sessionBound, false)
  assert.deepEqual(result.runs, [])
})

test('消息证据 API 仅回读绑定原文并以 hash 固定分页版本', async t => {
  const { service, message } = await fixture(t)
  const text = '整理本条材料：乙租户😀，验收日期十一月十五日。'
  const receipt = await service.ingest({ ...message, text })
  await service.messages.process(receipt.runId)
  const state = await service.state(receipt.runId)
  const resourceRef = state.run.sourceKey
  const first = await service.messageEvidence(receipt.runId, resourceRef, { limit: 9 })
  assert.equal(first.text, text.slice(0, first.end))
  assert.equal(first.start, 0)
  assert.equal(first.complete, false)
  assert.ok(first.nextCursor)
  await assert.rejects(service.messageEvidence(receipt.runId, resourceRef, { offset: first.nextCursor, limit: 9 }), /MESSAGE_EVIDENCE_CURSOR_INVALID/)
  await assert.rejects(service.messageEvidence(receipt.runId, resourceRef, { offset: first.nextCursor, limit: 9, hash: 'wrong-hash' }), /MESSAGE_EVIDENCE_VERSION_CHANGED/)
  assert.equal(await service.messageEvidence(receipt.runId, 'forged-source'), null)
  const foreign = await service.ingest({ ...message, messageId: 'unrelated-evidence', text: '无关联的独立消息' })
  await service.messages.process(foreign.runId)
  const foreignState = await service.state(foreign.runId)
  assert.equal(await service.messageEvidence(receipt.runId, foreignState.run.sourceKey), null)
  let reconstructed = first.text
  let cursor = first.nextCursor
  while (cursor !== null) {
    const page = await service.messageEvidence(receipt.runId, resourceRef, { offset: cursor, limit: 9, hash: first.hash })
    assert.equal(page.start, cursor)
    assert.equal(page.hash, first.hash)
    assert.equal(page.sourceVersion, first.sourceVersion)
    reconstructed += page.text
    cursor = page.nextCursor
  }
  assert.equal(reconstructed, text)
  assert.equal(first.totalBytes, Buffer.byteLength(text))
  assert.equal(first.totalLength, text.length)
})

async function seedCompletedTopicFact(store, index, topicId, text, actorId='owner') {
 const runId=`seed-run-${index}`, unitId=`seed-unit-${index}`, messageId=`seed-message-${index}`
 const key=`dws:${executionDigest(['','g',messageId])}`
 const call=(kind,args)=>store.command({id:`seed:${index}:${kind}`,kind:`message.${kind}`,args})
 await call('receive',{runId,sourceKey:key,sourceVersion:1,conversationId:'g',actorId,body:text,context:{sourceMessageId:messageId}})
 await call('split',{runId,units:[{unitId}]})
 await call('topic.bind',{runId,unitId,expectedRevision:0,binding:{kind:'binding',disposition:'conversation',queryScope:'agent_tasks',candidateId:null},topic:{topicId,conversationId:'g',sourceRunId:runId,unitId,title:topicId,facts:[{kind:'constraint',text,sourceRefs:[{sourceKey:key,sourceVersion:1,text}]}]}})
 await call('accept',{runId,unitId,expectedRevision:0,commands:[],outcome:'ignored'})
 return {messageId,key}
}

test('超过 200 个话题时明确引用仍找回最早话题且不建新 Task',async t=>{
 let matched=false
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge:async({stage,input})=>{
  if(stage==='S')return splitOne(input.source.text)
  if(stage==='R'){
   const oldest=input.candidates.find(card=>card.topicId==='archive-topic-0')
   assert.ok(oldest,'最早话题必须进入明确引用候选')
   assert.ok(oldest.explicitReferenceMatches.length>0)
   matched=true
   return {kind:'binding',disposition:'existing',candidateId:oldest.candidateId,evidence:['明确引用最早原消息']}
  }
  return {kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
 }})
 for(let i=0;i<205;i++)await seedCompletedTopicFact(execution.store,`archive-${i}`,`archive-topic-${i}`,`历史事项 ${i}`)
 const receipt=await service.ingest({...message,messageId:'oldest-reference',text:'继续核对原事项',quotedMessage:{messageId:'seed-message-archive-0',content:'历史事项 0'}})
 const state=await service.messages.process(receipt.runId)
 assert.equal(matched,true,JSON.stringify(state))
 assert.equal(state.units[0].topicId,'archive-topic-0')
 assert.equal(state.commands.length,0)
 assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})

test('群协调读取一千条同话题事实合并投影，跨发送人或不同约束不合并',async t=>{
 const repeated='仅在 UAT 验证',different='禁止生产写入';let projected
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge:async({stage,input})=>{
  if(stage==='S')return splitOne(input.source.text)
  if(stage==='R'){
   const candidate=input.candidates.find(card=>card.topicId==='long-lived-topic')
   assert.ok(candidate)
   return {kind:'binding',disposition:'existing',candidateId:candidate.candidateId,evidence:['继续同一话题']}
  }
  projected=input.facts.topic
  return {kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
 }})
 for(let i=0;i<1000;i++)await seedCompletedTopicFact(execution.store,`repeat-${i}`,'long-lived-topic',repeated)
 await seedCompletedTopicFact(execution.store,'different-actor','long-lived-topic',repeated,'colleague')
 await seedCompletedTopicFact(execution.store,'different-constraint','long-lived-topic',different)
 const receipt=await service.ingest({...message,messageId:'long-lived-followup',text:'继续核对原条件',quotedMessage:{messageId:'seed-message-repeat-0',content:repeated}})
 const state=await service.messages.process(receipt.runId)
 assert.ok(projected,JSON.stringify(state))
 assert.equal(projected.historyFactCount,1002)
 assert.equal(projected.facts.length,3)
 const same=projected.facts.find(fact=>fact.actorId==='owner'&&fact.text===repeated)
 assert.equal(same.equivalentFactCount,1000)
 assert.equal(projected.facts.filter(fact=>fact.text===repeated).length,2)
 assert.ok(projected.facts.some(fact=>fact.actorId==='colleague'&&fact.text===repeated))
 assert.ok(projected.facts.some(fact=>fact.actorId==='owner'&&fact.text===different))
 assert.ok(Buffer.byteLength(JSON.stringify(projected))<10000)
 assert.equal(state.run.status,'settled',JSON.stringify(state))
 assert.equal(state.commands.length,0)
 const history=await execution.store.query({kind:'message.topic.facts',topicId:'long-lived-topic',status:'all',limit:1})
 assert.equal(history.total,1003)
})

test('原发送人撤销仅排查条件可替换历史，另一发送人不得替换或派发',async t=>{
 for(const actor of ['owner','colleague']){
  const priorText='仅排查，不允许开发',sourceQuote='现在允许开发，取消仅排查条件'
  const {service,execution,message}=await fixture(t,actor,undefined,{judge:async({stage,input})=>{
   if(stage==='S')return splitOne(input.source.text)
   if(stage==='R'){
    const card=input.candidates.find(item=>item.topicId==='revision-topic')
    assert.ok(card)
    return {kind:'binding',disposition:'existing',candidateId:card.candidateId,evidence:['引用原条件']}
   }
   const fact=input.facts.topic.facts.find(item=>item.text===priorText)
   assert.ok(fact)
   return {kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料'},dependsOn:[]}],constraints:[],factRevisions:[{factId:fact.id,sourceQuote,scope:'当前话题'}],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  await seedCompletedTopicFact(execution.store,`revision-${actor}`,'revision-topic',priorText,'owner')
  const receipt=await service.ingest({...message,messageId:`revision-answer-${actor}`,text:`请整理本条材料；${sourceQuote}`,quotedMessage:{messageId:`seed-message-revision-${actor}`,content:priorText}})
  const state=await service.messages.process(receipt.runId)
  const active=await execution.store.query({kind:'message.topic.facts',topicId:'revision-topic',status:'active'})
  const history=await execution.store.query({kind:'message.topic.facts',topicId:'revision-topic',status:'superseded'})
  if(actor==='owner'){
   assert.equal(state.commands.length,1,JSON.stringify(state))
   assert.equal(state.commands[0].status,'applied',JSON.stringify(state))
   assert.equal(state.commands[0].args.constraints.includes(priorText),false)
   assert.equal(active.facts.some(fact=>fact.text===priorText),false)
   assert.equal(history.facts.length,1)
   assert.equal(history.facts[0].text,priorText)
   assert.equal(history.facts[0].supersededBy.sourceQuote,sourceQuote)
  }else{
   assert.deepEqual(state.commands,[])
   assert.ok(state.requests.some(request=>request.reason==='target_conflict'&&request.missingField==='TOPIC_FACT_REVISION_UNCONFIRMED'&&request.status==='pending'),JSON.stringify(state))
   assert.equal(active.facts.some(fact=>fact.text===priorText),true)
   assert.equal(history.facts.length,0)
   assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  }
 }
})

test('局部撤销范围及模型误报整话题均保留其他任务限制且零派发',async t=>{
 for(const scope of ['仅任务A','当前话题']){
  const priorText='任务A和任务B都禁止生产写入',sourceQuote='仅任务A取消禁止生产写入，任务B保持原限制'
  const {service,execution,message}=await fixture(t,'owner',undefined,{judge:async({stage,input})=>{
   if(stage==='S')return splitOne(input.source.text)
   if(stage==='R'){const card=input.candidates.find(item=>item.topicId==='partial-revision-topic');assert.ok(card);return{kind:'binding',disposition:'existing',candidateId:card.candidateId,evidence:['引用共同限制']}}
   const fact=input.facts.topic.facts.find(item=>item.text===priorText)
   assert.ok(fact)
   return{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料'},dependsOn:[]}],constraints:[],factRevisions:[{factId:fact.id,sourceQuote,scope}],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  await seedCompletedTopicFact(execution.store,`partial-${scope}`,'partial-revision-topic',priorText)
  const receipt=await service.ingest({...message,messageId:`partial-answer-${scope}`,text:`请整理材料；${sourceQuote}`,quotedMessage:{messageId:`seed-message-partial-${scope}`,content:priorText}})
  const state=await service.messages.process(receipt.runId)
  assert.deepEqual(state.commands,[])
  assert.ok(state.requests.some(request=>request.reason==='target_conflict'&&request.missingField==='TOPIC_FACT_REVISION_UNCONFIRMED'&&request.status==='pending'),JSON.stringify(state))
  const active=await execution.store.query({kind:'message.topic.facts',topicId:'partial-revision-topic',status:'active'})
  const history=await execution.store.query({kind:'message.topic.facts',topicId:'partial-revision-topic',status:'superseded'})
  assert.ok(active.facts.some(fact=>fact.text===priorText))
  assert.equal(history.facts.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
 }
})

const ordinaryAnswerJudge = (text = '已收到', replyPolicy = 'result') => async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
  : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新消息'] }
    : { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: text }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy }

test('答案失败已落账不能在收信箱显示业务已处理', async t => {
  const { service, message } = await fixture(t, 'owner', undefined, {
    judge: ordinaryAnswerJudge('查询附件'),
    messageAgentSessions: { async run({ onSessionBound }) {
      await onSessionBound()
      throw Object.assign(new Error('execution_tool_failed'), { code: 'execution_tool_failed' })
    }, async close() {}, async cancel() {} },
  })
  const received = await service.ingest(message)
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.commands[0].result.status, 'blocked')
  const row = (await service.mailboxes()).messages.find(item => item.runId === received.runId)
  assert.equal(row.workflowStatus, 'execution_blocked')
  assert.ok(row.waiting.some(item => item.responsibility === 'system' && /安全重试/.test(item.recoveryCondition)))
  assert.equal(row.workflowStatusDetail, state.commands[0].result.reply)
})

test('普通 answer 的 Host 门禁拒绝已排队的旧参数与任务参数，且不豁免创建权限', async t => {
  const { service, execution } = await fixture(t, 'participant', undefined, { judge: async () => { throw new Error('QUEUED_COMMAND_MUST_NOT_REJUDGE') } })
  const cases = [
    { intent: 'answer', arguments: { answer: '已收到' } },
    { intent: 'answer', arguments: { objective: '' } },
    { intent: 'answer', arguments: { text: '已收到', workflowId: 'task-engineering', repositoryId: 'repo' } },
    { intent: 'create', arguments: { objective: '创建任务' } },
  ]
  for (const [index, action] of cases.entries()) {
    const runId = `queued-answer-${index}`, commandId = `${runId}-command`, unitId = `${runId}-unit`
    const command = (kind, args) => execution.store.command({ id: `${runId}:${kind}`, kind: `message.${kind}`, args })
    await command('receive', { runId, sourceKey: runId, sourceVersion: 1, actorId: 'participant', conversationId: 'g', body: '请回复这条消息', policy: { initialWindowMs: 45000 } })
    await command('split', { runId, units: [{ unitId }] })
    await command('accept', { runId, unitId, commands: [{ commandId, kind: action.intent,
      args: { arguments: action.arguments, binding: { disposition: 'new' }, taskId: null, replyPolicy: 'none' }, dependsOn: [] }] })
    const state = await service.messages.process(runId)
    assert.equal(state.commands[0].status, 'rejected', JSON.stringify({ run: state.run, command: state.commands[0] }))
    assert.match(state.commands[0].result.reply, action.intent === 'answer' ? /请说明需要回答的具体问题/u : /没有创建业务任务的权限/u)
  }
  assert.deepEqual(await service.tasks(), [])
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

test('普通 answer 回复原任务消息的编辑，不被误当新增事项也不修改原任务', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text) : stage === 'R'
    ? { kind: 'binding', disposition: input.sourceEdit ? 'existing' : 'new', candidateId: input.sourceEdit ? input.candidates.find(item => item.taskId)?.candidateId : null, evidence: ['source'] }
    : { kind: 'intent', actions: [input.sourceEdit ? { intent: 'answer', arguments: { objective: '已收到补充说明' }, dependsOn: [] }
      : { intent: 'create', arguments: { objective: '整理材料' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest(message), initial = (await service.messages.process(first.runId)).commands[0]
  assert.equal(initial.result.runId, null)
  const original = await execution.controller.taskPlan(initial.result.taskId)
  const edited = await service.ingest({ ...message, text: '整理材料，附注只是说明；请回复收到', messageVersion: 2 })
  const state = await service.messages.process(edited.runId)
  assert.equal(state.commands[0]?.kind, 'answer', JSON.stringify(state))
  assert.equal(state.commands[0].status, 'applied',JSON.stringify(state.commands[0]))
  assert.equal(state.commands[0].args.taskId, null)
  assert.equal(state.requests.filter(request => request.status === 'pending').length, 0)
  assert.ok(state.barriers.every(barrier => barrier.status === 'resolved'))
  const after = await execution.controller.taskPlan(initial.result.taskId)
  assert.equal(after.task.requirementRef, original.task.requirementRef)
  assert.equal(after.task.requirementRevision, original.task.requirementRevision)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  assert.deepEqual((await execution.store.query({ kind: 'message.task-candidates', conversationId: 'g' })).map(item => item.command.args.taskId), [initial.result.taskId])
})

test('普通 answer 对旧任务仅允许本群只读答复，跨群仍拒绝', async t => {
  const { service, execution } = await fixture(t, 'participant', undefined, { judge: async () => { throw new Error('QUEUED_COMMAND_MUST_NOT_REJUDGE') },
    legacy: { getTask: taskId => ({ taskId, groupId: taskId === 'same-group' ? 'g' : 'foreign' }) } })
  for (const taskId of ['same-group', 'other-group']) {
    const runId = `legacy-answer-${taskId}`, unitId = `${runId}-unit`, commandId = `${runId}-command`
    const command = (kind, args) => execution.store.command({ id: `${runId}:${kind}`, kind: `message.${kind}`, args })
    await command('receive', { runId, sourceKey: runId, sourceVersion: 1, actorId: 'participant', conversationId: 'g', body: '回复原消息', policy: { initialWindowMs: 45000 } })
    await command('split', { runId, units: [{ unitId }] })
    await command('accept', { runId, unitId, commands: [{ commandId, kind: 'answer', args: { taskId: null, arguments: { objective: '已收到' },
      binding: { engine: 'legacy', taskId, disposition: 'existing' }, replyPolicy: 'none' }, dependsOn: [] }] })
    const state = await service.messages.process(runId)
    assert.equal(state.commands[0].status, taskId === 'same-group' ? 'applied' : 'rejected', JSON.stringify(state.run))
    assert.equal(state.commands[0].result.reply, taskId === 'same-group' ? '已收到' : '请求未执行：无权读取该旧任务')
  }
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

for (const actor of ['owner', 'participant']) test(`普通 answer 可向 ${actor} 引用回复，重复处理不重发且不创建任务`, async t => {
  const sent = [], notifications = { canDisclose: async () => true,
    send: notice => sendWorkflowNotification({ sendGroupReply: async request => { sent.push(request); return { messageId: 'reply' } }, sendGroup: async () => { throw new Error('MUST_REPLY_TO_SOURCE') } }, notice),
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const { service, message, execution } = await fixture(t, actor, notifications, { judge: ordinaryAnswerJudge('已收到 E2E-0927-2212'),
    legacy: { getGroup: groupId => ({ groupId, responsibility: '引用回复；小助手代回；只处理本人交办事项', messages: [] }) } })
  const received = await service.ingest(message), state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.commands[0].args.taskId, null)
  assert.deepEqual(state.commands[0].result, { status: 'answered', reply: '已收到 E2E-0927-2212', resultRef: state.commands[0].result.resultRef, evidenceRefs: [], limitations: [], inputVersion: 1 })
  assert.equal((await execution.artifacts.read(state.commands[0].result.resultRef)).summary, '已收到 E2E-0927-2212')
  await service.flushNotifications()
  assert.equal((await service.ingest(message)).duplicate, true)
  await service.messages.process(received.runId); await service.recover(); await service.flushNotifications()
  assert.deepEqual(await service.tasks(), [])
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  assert.deepEqual(await execution.store.query({ kind: 'message.task-candidates', conversationId: 'g' }), [])
  assert.equal(sent.length, 1)
  assert.deepEqual({ ...sent[0], idempotencyKey: undefined }, { groupId: 'g', text: '已收到 E2E-0927-2212\n\n- 小助手代回', replyToMessageId: 'm', replyToSenderOpenDingTalkId: actor, idempotencyKey: undefined })
  const notices = await execution.store.query({ kind: 'message.notifications', states: ['delivered'] })
  assert.equal(notices.length, 1)
  assert.equal(notices[0].id, sent[0].idempotencyKey)
  assert.equal(notices[0].disclosure.authorizationRef, state.run.sourceKey)
})

for (const policy of ['none', 'denied']) test(`普通 answer 保留 ${policy} 通知门禁`, async t => {
  let sends = 0, reads = 0
  const notifications = { canDisclose: async () => false, send: async () => { sends++; return { messageId: 'forbidden' } }, readback: async () => { reads++; return null } }
  const { service, execution, message } = await fixture(t, 'participant', notifications, { judge: ordinaryAnswerJudge('已收到', policy === 'none' ? 'none' : 'result') })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  await service.flushNotifications(); await service.recover(); await service.flushNotifications()
  assert.equal(sends, 0); assert.equal(reads, 0)
  assert.equal((await execution.store.query({ kind: 'message.notifications' })).length, policy === 'none' ? 0 : 1)
  assert.deepEqual(await service.tasks(), [])
})

test('普通 answer 发送结果未知后重启只补读原通知，不重复派发', async t => {
  let sends = 0, reads = 0, delivered = false
  const notifications = { canDisclose: async () => true, send: async () => { sends++; throw new Error('CONNECTION_LOST_AFTER_SEND') },
    readback: async () => { reads++; return delivered ? { messageId: 'actual-reply', conversationId: 'g' } : null } }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge: ordinaryAnswerJudge() })
  const received = await service.ingest(message); await service.messages.process(received.runId); await service.flushNotifications()
  const unknown = await execution.store.query({ kind: 'message.notifications', states: ['unknown'] })
  assert.equal(unknown.length, 1); assert.equal(sends, 1)
  await service.close()
  const restarted = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'] }), getGroup: groupId => ({ groupId, responsibility: '', messages: [] }) },
    execution, notifications, judge: async () => { throw new Error('SETTLED_ANSWER_MUST_NOT_REJUDGE') } })
  t.after(() => restarted.close())
  await restarted.recover(); await restarted.flushNotifications()
  assert.equal(sends, 1); assert.ok(reads >= 2)
  delivered = true
  await restarted.flushNotifications(); await restarted.flushNotifications()
  assert.equal(sends, 1)
  const settled = await execution.store.query({ kind: 'message.notifications', states: ['delivered'] })
  assert.equal(settled.length, 1); assert.equal(settled[0].id, unknown[0].id)
  assert.equal(settled[0].evidence.messageId, 'actual-reply')
  assert.deepEqual(await restarted.tasks(), [])
})


test('方案节点仅返回真实工件路径，不附正文、摘要或下载名称', async t => {
  const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' },
    nodeId: 'inspect-and-propose', execute: async () => ({ changes: [], replacements: [{ path: 'a.js', from: 'old', to: 'new' }] }),
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  const node = (await execution.controller.state(runId)).nodes[0]
  const page = await service.taskNodeOutput(taskId, runId, node.nodeRunId, { outputRef: node.outputRef })
  assert.equal(page.text, `方案工件路径\n${join(execution.artifacts.root, node.outputRef)}`)
  assert.equal(page.overview, '')
  assert.equal(page.documentName, undefined)
  assert.equal(page.nextCursor, null)
  assert.equal(page.totalLength, page.text.length)
})


test('业务验收产出独立显示验收项、预期和实际结果', () => {
  const result = describeTaskNodeOutput({ nodeId: 'business-acceptance' }, { acceptance: { passed: true, checks: [{ passed: true, log: JSON.stringify({ acceptance: { criterion: '归一化结果', expected: '1 t', actual: '1 t', passed: true } }) }] } })
  assert.equal(result.overview, '业务验收通过 · 1 项')
  assert.equal(result.text, '归一化结果\n预期：1 t\n实际：1 t\n结果：通过')
  assert.doesNotMatch(result.text, /Java|打包|skipTests/)
})


for (const [body, environment] of [['修复合并问题', undefined], ['修复合并问题', 'uat1'], ['提交到uat1或uat2', 'uat1'], ['提交到uat1～9', 'uat1']]) test(`开发环境缺失或不明确先承接Task再由Owner询问具体UAT：${body}/${environment}`, async t => {
  const taskOwnerSessions = { async close() {}, async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    assert.equal(input.goal.target.uatEnvironment, undefined)
    const decision = { action: 'wait', summary: '请指定唯一目标UAT环境', evidenceRefs: [], condition: {
      kind: 'business-input', missing: 'uatEnvironment', responsibleParty: '交办人', resumeWhen: '指定唯一uat1至uat9后继续原任务', evidenceRefs: [] } }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions, judge: async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, repositoryId: 'repo', ...(environment ? { uatEnvironment: environment } : {}) }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  } })
  const receipt = await service.ingest({ ...message, text: body })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.requests.length, 0)
  await settleTaskOwners(service, execution)
  const taskId = state.commands[0].args.taskId
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision.condition.kind, 'business-input')
  assert.equal(owner.decision.condition.missing, 'uatEnvironment')
  assert.equal((await execution.controller.taskPlan(taskId)).stages.length, 0)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})


test('UAT补充绑定同一开发Task并更新目标，不新建澄清请求或第二任务', async t => {
  const snapshots = []
  const taskOwnerSessions = { async close() {}, async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound(); snapshots.push({ taskId: input.task.taskId, target: input.goal.target })
    const decision = { action: 'wait', summary: input.goal.target.uatEnvironment ? '已接收目标环境，继续核对文档' : '请指定目标UAT', evidenceRefs: [], condition: {
      kind: input.goal.target.uatEnvironment ? 'execution' : 'business-input', missing: input.goal.target.uatEnvironment ? '文档核对结果' : 'uatEnvironment', responsibleParty: '执行方', resumeWhen: '核对后继续原任务', evidenceRefs: [] } }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions, judge: async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: input.candidates.length ? 'existing' : 'new', candidateId: input.candidates[0]?.candidateId ?? null, evidence: ['同一开发事项'] }
    return { kind: 'intent', actions: [{ intent: input.text === 'uat4' ? 'revise' : 'create', arguments: { objective: '修复代码', repositoryId: 'repo', ...(input.text === 'uat4' ? { uatEnvironment: 'uat4' } : {}) }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  } })
  const receipt = await service.ingest({ ...message, text: '修复代码' })
  const before = await service.messages.process(receipt.runId)
  await settleTaskOwners(service, execution)
  const taskId = before.commands[0].args.taskId
  assert.equal(before.requests.length, 0)
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.condition.missing, 'uatEnvironment')
  const answer = await service.ingest({ ...message, messageId: 'choose-uat4', text: 'uat4' })
  const after = await service.messages.process(answer.runId)
  await settleTaskOwners(service, execution)
  assert.equal(after.commands[0].kind, 'revise')
  assert.equal(after.commands[0].status, 'applied')
  assert.equal(after.commands[0].args.taskId, taskId)
  assert.equal(after.requests.length, 0)
  assert.equal((await service.tasks()).length, 1)
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal((await execution.artifacts.read(plan.task.requirementRef)).target.uatEnvironment, 'uat4')
  assert.ok(snapshots.some(item => item.taskId === taskId && item.target.uatEnvironment === 'uat4'))
  assert.equal(plan.stages.length, 0)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})
test('本地验收产出：条件、方案与目录准确展示且不泄漏执行参数', () => {
  const hidden = 'secret-acceptance-parameter'
  const project = (nodeId, output) => describeTaskNodeOutput({ nodeId }, output)
  const context = project('define-local-acceptance', { localContext: { uatEnvironment: 'uat4', criteria: [{ id: 'normalize', description: '合并结果为 1 t' }], scenarios: [{ executable: hidden }] } })
  assert.equal(context.overview, '已核对 1 项任务验收条件')
  assert.match(context.text, /目标环境\nuat4/)
  assert.match(context.text, /normalize：合并结果为 1 t/)
  const plan = { cases: [{ criterionId: 'normalize', scenarioId: 'merge', steps: ['创建两个来源', '合并并读取结果'], expected: '1 t', parameters: { token: hidden } }] }
  const planned = project('plan-local-acceptance', plan)
  assert.equal(planned.overview, '已编写 1 项本地验收用例')
  assert.match(planned.text, /1\. 创建两个来源\n2\. 合并并读取结果\n预期：1 t/)
  const prepared = project('prepare-local-acceptance', { localPrepared: { directory: 'D:/acceptance/task-1', namespace: 'task-1', uatEnvironment: 'uat4', dataEnvironment: 'shared-uat', plan, env: { password: hidden } } })
  assert.match(prepared.text, /验收目录\nD:\/acceptance\/task-1/)
  assert.match(prepared.text, /数据环境\n共享 UAT 数据库/)
  assert.match(prepared.text, /任务数据标识\ntask-1/)
  for (const result of [context, planned, prepared]) assert.doesNotMatch(JSON.stringify(result), new RegExp(hidden))
})

const localAcceptanceDisplayReceipt = () => ({
  uatEnvironment: 'uat4', dataEnvironment: 'shared-uat', passed: true,
  checks: [{ criterionId: 'normalize', scenarioId: 'merge', steps: ['合并并读取结果'], expected: '1 t', actual: '1 t', passed: true }],
  phases: [
    { id: 'prepare', title: '准备目录', status: 'succeeded', elapsedMs: 999 },
    { id: 'start', title: '启动服务', status: 'succeeded', elapsedMs: 61000 },
    { id: 'execute', title: '执行业务验收', status: 'succeeded', elapsedMs: 3723000 },
    { id: 'cleanup', title: '清理数据', status: 'succeeded', elapsedMs: 1000 },
  ],
  cleanup: { dataCleaned: true, processStopped: true },
})

test('本地验收产出：阶段耗时、预期实际与清理结果进入同一报告', () => {
  const receipt = localAcceptanceDisplayReceipt()
  receipt.parameters = { password: 'secret-display-password' }
  const result = describeTaskNodeOutput({ nodeId: 'run-local-acceptance' }, { localAcceptance: receipt })
  assert.equal(result.overview, '本地业务验收通过 · 1 项')
  assert.match(result.text, /准备目录：完成 · 0 秒/)
  assert.match(result.text, /启动服务：完成 · 1 分 1 秒/)
  assert.match(result.text, /执行业务验收：完成 · 1 小时 2 分 3 秒/)
  assert.match(result.text, /预期：1 t\n实际：1 t\n结果：通过/)
  assert.match(result.text, /任务数据：已清理\n本地服务：已停止/)
  assert.equal(result.document.name, '本地验收报告.md')
  assert.equal(result.document.content, `# 本地验收报告\n\n${result.text}`)
  assert.doesNotMatch(JSON.stringify(result), /secret-display-password/)
  const finalized = describeTaskNodeOutput({ nodeId: 'finalize-local-acceptance' }, { localAcceptance: receipt })
  assert.match(finalized.overview, /验收通过/)
  assert.match(finalized.text, /允许进入代码提交/)
})

test('只读本地验收明确没有业务数据写入，不冒充删除数据', () => {
  const receipt = localAcceptanceDisplayReceipt()
  Object.assign(receipt.cleanup, { mode: 'read-only', createdResources: 0 })
  const result = describeTaskNodeOutput({ nodeId: 'run-local-acceptance' }, { localAcceptance: receipt })
  assert.match(result.text, /任务数据：无业务数据写入，会话已清理/)
})

for (const missing of ['dataCleaned', 'processStopped']) test(`本地验收产出：${missing}未确认不能显示整体通过`, () => {
  const receipt = localAcceptanceDisplayReceipt()
  receipt.cleanup[missing] = false
  const result = describeTaskNodeOutput({ nodeId: 'run-local-acceptance' }, { localAcceptance: receipt })
  assert.equal(result.overview, '本地业务验收未通过 · 1 项')
  assert.match(result.text, missing === 'dataCleaned' ? /任务数据：未确认清理完成/ : /本地服务：未确认停止/)
  const finalized = describeTaskNodeOutput({ nodeId: 'finalize-local-acceptance' }, { localAcceptance: receipt })
  assert.match(finalized.overview, /不能提交代码/)
  assert.doesNotMatch(finalized.text, /允许进入代码提交/)
})

test('本地验收产出：业务失败和缺失实际结果不伪装通过', () => {
  const receipt = localAcceptanceDisplayReceipt()
  receipt.passed = false
  receipt.checks[0].passed = false
  receipt.checks[0].actual = null
  receipt.phases = [{ title: '执行业务验收', status: 'failed' }, { title: '后续场景', status: 'skipped', elapsedMs: 0 }]
  const result = describeTaskNodeOutput({ nodeId: 'run-local-acceptance' }, { localAcceptance: receipt })
  assert.equal(result.overview, '本地业务验收未通过 · 1 项')
  assert.match(result.text, /实际：未取得实际结果\n结果：未通过/)
  assert.match(result.text, /执行业务验收：失败 · 耗时未记录/)
  assert.match(result.text, /后续场景：未执行 · 0 秒/)
})

test('本地验收产出：执行中、未知状态及空回执明确标记未确认', () => {
  const receipt = { uatEnvironment: 'uat4', passed: false, phases: [{ title: '启动服务', status: 'running', elapsedMs: 3600000 }, { title: '核对', status: 'unknown', elapsedMs: -1 }] }
  const result = describeTaskNodeOutput({ nodeId: 'run-local-acceptance' }, { localAcceptance: receipt })
  assert.equal(result.overview, '本地业务验收未通过 · 0 项')
  assert.match(result.text, /启动服务：执行中 · 1 小时 0 分 0 秒/)
  assert.match(result.text, /核对：结果未确认 · 耗时未记录/)
  assert.match(result.text, /未记录实际验收结果/)
  assert.match(result.text, /任务数据：未确认清理完成\n本地服务：未确认停止/)
})

for (const recoveryCode of ['ECONNRESET', 'ENGINEERING_REMOTE_READ_TRANSIENT', 'PR_CONNECTION_FAILED']) test(`暂态恢复无次数上限且退避持久化 ${recoveryCode}，重开控制账不能跳过退避`, async t => {
  let executions=0
  const {service,execution,message,startCodeTask}=await fixture(t,'owner',undefined,{execute:async()=>{executions++;throw Object.assign(Error(recoveryCode),{code:recoveryCode})},extraNodes:[{
    id:'finish',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:()=>({}),execute:async()=>({})
  }]})
  const task=await startCodeTask()
  await execution.controller.whenIdle(task.runId)
  for(const delay of [0,1100,2100,4100]) {
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay))
    await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId)
  }
  assert.equal(executions,5)
  await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId);assert.equal(executions,5)
  const state=await execution.controller.state(task.runId),node=state.nodes.find(n=>n.status==='waiting')
  assert.equal(state.run.claimCount,5)
  const directory=await mkdtemp(join(tmpdir(),'recovery-reopen-')),dbPath=join(directory,'control.db')
  const db=new DatabaseSync(join(execution.artifacts.root,'..','control.db'),{readOnly:true})
  try {
    const events=db.prepare("SELECT payload FROM execution_events WHERE kind='run.recovery.admitted' ORDER BY seq").all().map(row=>JSON.parse(row.payload))
    assert.deepEqual(events.map(event=>event.attempt),[1,2,3,4]);assert.equal(new Set(events.map(event=>event.key)).size,1)
    await backup(db,dbPath)
  } finally {db.close()}
  const reopened=await openExecutionStore({dbPath,instanceId:'test',initialize:false})
  try {await assert.rejects(reopened.command({id:'after-reopen',kind:'run.recovery.admit',args:{runId:task.runId,runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:state.run.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,errorCode:recoveryCode}}),/RECOVERY_RETRY_DEFERRED/)} finally {await reopened.close()}
  const offline=new DatabaseSync(dbPath)
  try {offline.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('unknown-retry','operation',?,?,?,?,?,'digest','{}','[]','fixture','unknown','now','now')").run(task.runId,node.nodeRunId,node.nodeId,state.run.generation,node.inputDigest)} finally {offline.close()}
  const unknown=await openExecutionStore({dbPath,instanceId:'test',initialize:false})
  try {await assert.rejects(unknown.command({id:'unknown-retry',kind:'run.recovery.admit',args:{runId:task.runId,runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:state.run.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,errorCode:recoveryCode}}),/run_effects_not_drained/)} finally {await unknown.close()}
})

for (const outcome of ['succeeded', 'unknown', 'failed', 'throws']) test(`交付只读恢复 ${outcome}：既有效果不重发且仅成功恢复原节点`, async t => {
  let sends = 0, reads = 0
  const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, {
    allowedEffects: ['external.operation'],
    deliveryOptions: { authorize: async () => false,
      authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'fixture' }),
      externalAdapter: { execute: async () => { sends++; return { status: 'unknown' } },
        reconcile: async () => { reads++; if (outcome === 'throws') throw Error('temporary read failure'); return { status: outcome } } } },
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external',
      prepared: { action: 'external', workflowKind: 'uat-pr-merge', resourceKey: 'external:fixture:uat', runId, generation, requirementDigest } }),
  })
  const task = await startCodeTask()
  await execution.controller.whenIdle(task.runId)
  const before = await execution.controller.state(task.runId)
  assert.equal(before.run.status, 'waiting'); assert.equal(sends, 1); assert.equal(reads, 0)
  assert.deepEqual(await service.recoverExecutionTasks(), [])
  await execution.controller.whenIdle(task.runId)
  const after = await execution.controller.state(task.runId)
  assert.equal(sends, 1); assert.equal(reads, 1)
  assert.equal(after.run.status, outcome === 'succeeded' ? 'succeeded' : 'waiting')
  assert.equal(after.run.generation, before.run.generation)
  assert.equal(after.nodes[0].nodeRunId, before.nodes[0].nodeRunId)
  assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId })).length, 1)
  await service.recoverExecutionTasks(); await execution.controller.whenIdle(task.runId)
  assert.equal(sends, 1)
  assert.equal(reads, ['unknown', 'throws'].includes(outcome) ? 2 : 1)
})

for (const reason of ['BYTEBASE_APPROVAL_PENDING', 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED'])
  for (const decision of ['approved', 'rejected']) test(`Bytebase 原生审批 Service 自动对账 ${reason}/${decision}`, async t => {
    let observed = false, sends = 0, reads = 0, production = 0, waitingDecision = "pending"
    const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
      nodeId: 'approval-gate', allowedEffects: ['external.operation'],
      deliveryOptions: { authorize: async () => false,
        authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'bytebase-approval-read' }),
        externalAdapter: {
          execute: async () => { sends++; return { status: 'unknown', reason } },
          reconcile: async () => { reads++; return observed
            ? { status: 'succeeded', result: { approval: { decision, source: 'bytebase', human: true } } }
            : { status: 'unknown', reason, result: { approval: { decision: waitingDecision } } } },
        } },
      execute: async ({ runId, generation, requirementDigest, perform }) => {
        try { return await perform({ action: 'external', prepared: { action: 'external', workflowKind: 'data-change',
          stage: 'approval-gate', resourceKey: 'external:fixture:bytebase', runId, generation, requirementDigest } }) }
        catch (error) {
          if (error.code === 'DELIVERY_RECONCILIATION_REQUIRED') throw Object.assign(Error(reason), { code: reason })
          throw error
        }
      },
      extraNodes: [{ id: 'consume-approval', version: '1', executor: 'code', allowedEffects: ['pure'],
        inputSchema: schema, outputSchema: schema, mapInput: ({ previousOutput }) => previousOutput,
        execute: async ({ input }) => { if (input.result.approval.decision === 'approved') production++; return {} } }],
    })
    const task = await startCodeTask()
    const before = await execution.controller.whenIdle(task.runId)
    assert.equal(before.nodes[0].waitReason.reference, reason)
    assert.equal(sends, 1); assert.equal(production, 0)
    assert.deepEqual(await service.recoverExecutionTasks(), [])
    assert.equal((await execution.controller.whenIdle(task.runId)).run.status, 'waiting')
    assert.equal(reads, 1); assert.equal(sends, 1); assert.equal(production, 0)
    waitingDecision = "unconfigured"
    assert.deepEqual(await service.recoverExecutionTasks(), [])
    assert.equal((await service.tasks())[0].waitingCondition.kind, "capability")
    assert.match((await service.tasks())[0].waitingReason, /Bytebase 管理员/u)
    assert.match((await service.tasks())[0].waitingCondition.resumeWhen, /重新送审/u)
    assert.equal(production, 0); assert.equal(sends, 1)
    observed = true
    assert.deepEqual(await service.recoverExecutionTasks(), [])
    const after = await execution.controller.whenIdle(task.runId)
    assert.equal(after.run.status, 'succeeded', JSON.stringify(after.nodes.map(node => [node.nodeId, node.waitReason])))
    assert.equal(after.run.generation, before.run.generation)
    assert.equal(after.nodes[0].nodeRunId, before.nodes[0].nodeRunId)
    assert.equal(reads, 3); assert.equal(sends, 1)
    assert.equal(production, decision === 'approved' ? 1 : 0)
    assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId })).length, 1)
    assert.equal((await execution.store.query({ kind: 'approval.list' })).length, 0)
    await service.recoverExecutionTasks(); await execution.controller.whenIdle(task.runId)
    assert.equal(reads, 3); assert.equal(sends, 1)
  })

test('生产Service组合真实转发只读审批收口，unknown效果原生观察为failed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'service-approval-composition-'))
  let service, sends = 0, closes = 0
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }) })
  const initialized = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'composition-test', initialize: true })
  await initialized.close()
  await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const external = { authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'readonly-approval' }),
    prepareRequirement: async () => { throw Error('UNEXPECTED_PREPARE') }, operationAdapter: {
      execute: async () => { sends++; return { status: 'unknown' } }, reconcile: async () => ({ status: 'unknown' }),
      closeReadonlyApproval: async prepared => {
        closes++; assert.equal(prepared.workflowKind, 'data-change'); assert.equal(prepared.stage, 'approval-gate')
        return { status: 'failed', reason: 'APPROVAL_CHANNEL_SUPERSEDED' }
      } } }
  service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', webActorId: 'owner',
    dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts'), instanceId: 'composition-test' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', workspaceDir: root }) }, external,
    coordinatorSessions: { async close() {} }, taskOwnerSessions: { async close() {} }, messageAgentSessions: { async close() {} } })
  const { controller, store, delivery } = service.execution
  controller.registerWorkflow({ id: 'composition-approval-gate', version: '1', nodes: [{ id: 'approval-gate', version: '1', executor: 'code',
    allowedEffects: ['external.operation'], inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement,
    execute: ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external', prepared: {
      action: 'external', workflowKind: 'data-change', stage: 'approval-gate', intent: { approvalSource: 'bytebase' },
      resourceKey: 'external:composition:approval', runId, generation, requirementDigest } }) }] })
  await controller.createTaskPlan({ commandId: 'composition-plan', taskId: 'composition-task', stages: [{ stageId: 'gate', workflowId: 'composition-approval-gate', input: {} }] })
  const plan = await controller.advanceTaskPlan('composition-task'), runId = plan.stages[0].runId
  assert.equal((await controller.whenIdle(runId)).run.status, 'waiting')
  const [effect] = await store.query({ kind: 'effect.list', runId })
  assert.equal(effect.state, 'unknown'); assert.equal(sends, 1)
  let barriers = 0
  await delivery.closeReadonlyApproval(effect.effectId, { beforeObserve: async () => { barriers++ } })
  const closed = await store.query({ kind: 'effect.get', effectId: effect.effectId })
  assert.equal(closes, 1); assert.equal(barriers, 1); assert.equal(sends, 1)
  assert.equal(closed.state, 'failed'); assert.equal(closed.result.result.reason, 'APPROVAL_CHANNEL_SUPERSEDED')
})

for (const pendingMode of ['resume', 'other']) test(`审批交接先真实上下文纠正，旧 unknown 不增加 pendingInput；dryRun零写、原生终止同Task并持久幂等：${pendingMode}`, async t => {
  let executionRef, sends = 0, closes = 0, verifies = 0, crash = false
  const adapter = { id: 'handoff-fixture', version: '1', pluginApproval: true, rulesDigest: 'a'.repeat(64) }
  for (const name of ['validate','prepareRehearsal','readbackRehearsal','inspect','prepareIssue','prepareApproval','prepareExecute','readback','readBaselineForCandidate','validateExistingIssue']) adapter[name] = async () => { throw Error('UNEXPECTED_ADAPTER_CALL') }
  const external = { dataChangeAdapter: adapter, authorizeExternal: async () => false, prepareRequirement: async () => { throw Error('UNEXPECTED_PREPARE') }, operationAdapter: { execute: async () => { throw Error('UNEXPECTED_SEND') }, reconcile: async () => ({ status: 'unknown' }) }, availableTargets: ['task-data-change', 'task-data-change-approval-resume'].map(workflowId => ({ workflowId, targetId: 'production-db' })),
    verifyDataChangeApprovalHandoff: async ({ taskId, runId }) => {
      verifies++
      const state = await executionRef.controller.state(runId), [effect] = await executionRef.store.query({ kind: 'effect.list', runId })
      return { kind: 'data-change-approval-handoff', taskId, originalRunId: runId, originalGeneration: state.run.generation,
        originalRequirementRef: state.run.requirementRef, effectId: effect.effectId, effectDigest: effect.definitionDigest,
        nodeRunId: state.nodes[0].nodeRunId, inputDigest: state.nodes[0].inputDigest, leaseEpoch: state.nodes[0].leaseEpoch,
        view: { prepared: { sql: 'ALTER TABLE fixture ADD COLUMN name text' }, issue: { issueId: '857' }, sheet: {}, plan: {} } }
    } }
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' }, external, codePrefixCount: 3, nodeId: 'approval-gate', allowedEffects: ['external.operation'],
    storeCommand: async (request, command) => {
      if (crash && request.kind === 'task.owner.event' && request.args.eventType === 'approval.channel.changed') {
        crash = false; throw Error('SIMULATED_AFTER_STOP_CRASH')
      }
      return command(request)
    },
    deliveryOptions: { authorize: async () => false, authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'fixture' }), externalAdapter: {
      execute: async () => { sends++; return { status: 'unknown' } }, reconcile: async () => ({ status: 'unknown' }),
      closeReadonlyApproval: async () => { closes++; return { status: 'failed', reason: 'APPROVAL_CHANNEL_SUPERSEDED' } } } },
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external', prepared: {
      action: 'external', workflowKind: 'data-change', stage: 'approval-gate', intent: { approvalSource: 'bytebase' },
      resourceKey: 'external:fixture:approval', runId, generation, requirementDigest } }) })
  executionRef = execution
  const task = await startCodeTask(), before = await execution.controller.whenIdle(task.runId)
  // Service 生命周期使用真实 Controller/效果账；冻结 v5 的定义证明由受信适配器独立测试覆盖。
  const taskPlan = execution.controller.taskPlan.bind(execution.controller)
  execution.controller.taskPlan = async taskId => {
    const plan = await taskPlan(taskId)
    if (taskId === task.taskId) return { ...plan, stages: plan.stages.map(stage => stage.stageId === 'fixture' ? { ...stage, workflowId: 'task-data-change' } : stage) }
    return plan
  }
  assert.equal(before.run.status, 'waiting'); assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId }))[0].state, 'unknown')
  const context = '添加 name 列，通过插件人工审批后执行；驳回按意见修改继续送审。'
  const revision = { objective: context, acceptanceCriteria: ['插件人工审批后执行并核验'],
    stageTargets: { 'task-data-change': 'production-db', 'task-data-change-approval-resume': 'production-db' },
    stageAuthorizations: ['task-data-change', 'task-data-change-approval-resume'].map(workflowId => ({ workflowId, objective: context, sourceQuote: context, gate: 'none' })) }
  const runtime = { isWorkflowTask: async taskId => taskId === task.taskId,
    submitWorkflowTask: request => service.submitWebTask(request, { channel: 'web', actorId: 'owner' }),
    handoffWorkflowDataChangeApproval: request => service.handoffDataChangeApproval(request, { channel: 'web', actorId: 'owner' }) }
  const server = createServer((request, response) => handleRequest(request, response, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const post = (action, body, origin) => fetch(`http://127.0.0.1:${server.address().port}/tasks/${task.taskId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  const contextResult = await post('context', { requestId: 'handoff-context', inputVersion: 2, runSequence: 4, context, requirement: revision })
  assert.equal(contextResult.status, 202, await contextResult.text())
  const afterContext = await execution.controller.state(task.runId), plan = await execution.controller.taskPlan(task.taskId)
  const priorOwner = await execution.store.query({ kind: 'task.owner', taskId: task.taskId })
  const claim = await execution.store.command({ id: 'handoff-pending-claim', kind: 'task.owner.claim', args: { taskId: task.taskId, turnId: 'handoff-pending', expectedLeaseEpoch: priorOwner.leaseEpoch } })
  const leaseEpoch = claim.result.leaseEpoch
  await execution.store.command({ id: 'handoff-pending-bound', kind: 'task.owner.sessionBound', args: { taskId: task.taskId, turnId: 'handoff-pending', leaseEpoch, sessionId: priorOwner.sessionId } })
  const goal = await execution.artifacts.read(plan.task.requirementRef)
  await execution.store.command({ id: 'handoff-pending-candidate', kind: 'task.owner.candidate', args: { taskId: task.taskId, turnId: 'handoff-pending', leaseEpoch, decision: {
    action: 'advance', summary: '保留成功调查和已有工单，替换审批阶段', evidenceRefs: [], planChange: { kind: 'replaceSuffix', affectedFrom: 3,
      stages: [{ workflowId: pendingMode === 'resume' ? 'task-data-change-approval-resume' : 'task-data-change', gate: 'none', sourceCondition: { sourceKey: goal.authorization.sourceKey, sourceVersion: 1, sourceQuote: context, objective: context } }] } } } })
  await execution.store.command({ id: 'handoff-pending-accept', kind: 'task.owner.accept', args: { taskId: task.taskId, turnId: 'handoff-pending', leaseEpoch } })
  const owner = await execution.store.query({ kind: 'task.owner', taskId: task.taskId })
  assert.equal(owner.applicationStatus, 'pending'); assert.equal(owner.decision.action, 'advance')
  const prefix = plan.stages.slice(0, 3)
  assert.ok(prefix.every(stage => stage.status === 'succeeded' && stage.outputRef))
  assert.equal(afterContext.pendingInputCount, 0); assert.equal(afterContext.run.requirementRef, before.run.requirementRef)
  assert.equal(plan.task.requirementRevision, 2); assert.deepEqual((await execution.store.query({ kind: 'task.owner.acceptance', taskId: task.taskId })).map(item => item.criterion), revision.acceptanceCriteria)
  const input = { taskId: task.taskId, runId: task.runId, recoveryKey: 'approval-channel', reason: context, dryRun: true,
    expectedRequirementRevision: 2, expectedControlRevision: plan.task.controlRevision, expectedPlanRevision: plan.task.planRevision,
    expectedOwnerRevision: owner.revision, expectedLeaseEpoch: owner.leaseEpoch, expectedRunRevision: afterContext.run.revision, generation: afterContext.run.generation }
  const { taskId: unusedTaskId, ...httpInput } = input
  const eventsBeforeCheck = await execution.store.query({ kind: 'task.owner.events', taskId: task.taskId })
  assert.equal((await post('handoff-data-change-approval', { ...httpInput, actorId: 'other' })).status, 400)
  assert.equal((await post('handoff-data-change-approval', httpInput, 'https://untrusted.invalid')).status, 403)
  const checked = await post('handoff-data-change-approval', httpInput)
  const check = await checked.json()
  if (pendingMode === 'other') {
    assert.equal(checked.status, 409, JSON.stringify(check)); assert.match(check.error, /UNSAFE/)
    assert.equal(closes, 0); assert.equal(sends, 1)
    assert.equal((await execution.controller.state(task.runId)).run.status, 'waiting')
    return
  }
  assert.equal(checked.status, 200, JSON.stringify(check))
  assert.equal(check.authorized, true); assert.equal(closes, 0); assert.equal(sends, 1)
  assert.deepEqual(await execution.store.query({ kind: 'task.owner.events', taskId: task.taskId }), eventsBeforeCheck)
  assert.equal((await execution.controller.state(task.runId)).run.revision, afterContext.run.revision)
  await assert.rejects(service.handoffDataChangeApproval({ ...input, expectedRequirementRevision: 1, dryRun: false }, { channel: 'web', actorId: 'owner' }), /STALE/)
  await assert.rejects(service.handoffDataChangeApproval(input, { channel: 'web', actorId: 'other' }), /FORBIDDEN/)
  const maintenance = await execution.store.query({ kind: 'runtime.maintenance' })
  await execution.store.command({ id: 'handoff-maintenance-enter', kind: 'runtime.maintenance.change', args: {
    maintenanceId: 'handoff', actorId: 'owner', active: true, expectedRevision: maintenance.revision, reason: 'fixture' } })
  assert.equal((await post('handoff-data-change-approval', httpInput)).status, 409)
  await execution.store.command({ id: 'handoff-maintenance-leave', kind: 'runtime.maintenance.change', args: {
    maintenanceId: 'handoff', actorId: 'owner', active: false, expectedRevision: maintenance.revision + 1, reason: 'fixture' } })
  const stop = execution.controller.stop.bind(execution.controller)
  execution.controller.stop = async () => { throw Error('SIMULATED_AFTER_CLOSE_CRASH') }
  await assert.rejects(service.handoffDataChangeApproval({ ...input, dryRun: false }, { channel: 'web', actorId: 'owner' }), /SIMULATED_AFTER_CLOSE_CRASH/)
  execution.controller.stop = stop
  assert.equal((await execution.controller.state(task.runId)).run.status, 'waiting')
  crash = true
  await assert.rejects(service.handoffDataChangeApproval({ ...input, dryRun: false }, { channel: 'web', actorId: 'owner' }), /SIMULATED_AFTER_STOP_CRASH/)
  assert.equal((await execution.controller.state(task.runId)).run.status, 'cancelled')
  assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId }))[0].state, 'failed')
  const applied = await service.handoffDataChangeApproval({ ...input, dryRun: false }, { channel: 'web', actorId: 'owner' })
  assert.equal(applied.accepted, true); assert.equal((await execution.controller.state(task.runId)).run.status, 'cancelled')
  const stoppedPlan = await execution.controller.taskPlan(task.taskId)
  assert.equal(stoppedPlan.stages[3].status, 'blocked'); assert.deepEqual(stoppedPlan.stages.slice(0, 3), prefix)
  assert.equal(closes, 3); assert.equal(sends, 1)
  const events = await execution.store.query({ kind: 'task.owner.events', taskId: task.taskId }), handoff = events.find(event => event.eventType === 'approval.channel.changed')
  const payload = await execution.artifacts.read(handoff.payloadRef)
  const changedOwner = await execution.store.query({ kind: 'task.owner', taskId: task.taskId })
  assert.ok(changedOwner.eventWatermark > owner.eventWatermark)
  const ownerController = createTaskOwnerController({ ctx: {}, store: execution.store, artifacts: execution.artifacts, controller: execution.controller,
    modelConfig: () => ({ provider: 'test', model: 'test' }), advanceTask: async () => { throw Error('STALE_PLAN_MUST_NOT_ADVANCE') },
    authorizeStages: async () => { throw Error('STALE_PLAN_MUST_NOT_AUTHORIZE') }, sessionRunner: { async close() {} } })
  try { assert.deepEqual(await ownerController.applyPending(), []) } finally { await ownerController.close() }
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId: task.taskId })).applicationStatus, 'discarded')
  assert.equal(await execution.store.query({ kind: 'receipt', commandId: 'owner-plan:handoff-pending' }), null)
  assert.equal(payload.requirementRef, plan.task.requirementRef); assert.equal(payload.originalRunId, task.runId); assert.equal(payload.view.issue.issueId, '857')
  assert.equal((await service.handoffDataChangeApproval({ ...input, dryRun: false }, { channel: 'web', actorId: 'owner' })).replayed, true)
  assert.equal(closes, 3); assert.equal(verifies, 4)
})

for (const gate of ['repaired', 'protocol-repaired', 'unrepaired', 'maintenance', 'pause', 'input', 'maintenance-during-read']) test(`Bytebase 已建工单身份只读恢复 ${gate}`, async t => {
  let repaired = false, reads = 0, executionRef
  const enter = () => executionRef.store.command({ id: 'identity-maintenance', kind: 'runtime.maintenance.change', args: {
    maintenanceId: 'identity', actorId: 'owner', active: true, expectedRevision: 0, reason: 'test' } })
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    codeWorkflowId: 'task-data-change', codeWorkflowVersion: '5', nodeId: 'readback-issue', allowedEffects: ['read'],
    execute: async ({ input }) => {
      reads++
      assert.equal(input.request, 'fixture')
      assert.equal(input.workflowDigest, undefined)
      if (!repaired) {
        const code = gate === 'protocol-repaired' ? 'BYTEBASE_TASK_RUN_LIST_UNCONFIRMED' : 'BYTEBASE_ISSUE_IDENTITY_UNCONFIRMED'
        throw Object.assign(Error(code), { code })
      }
      if (gate === 'maintenance-during-read') await enter()
      return input
    },
  })
  executionRef = execution
  const task = await startCodeTask(), before = await execution.controller.whenIdle(task.runId)
  assert.equal(before.run.status, 'waiting')
  repaired = gate !== 'unrepaired'
  if (gate === 'maintenance') await enter()
  if (gate === 'pause') await execution.store.command({ id: 'identity-pause', kind: 'run.pause', args: { runId: task.runId, reason: 'test' } })
  if (gate === 'input') {
    const replacement = await execution.artifacts.put({ request: 'changed' })
    await execution.store.command({ id: 'identity-input', kind: 'input.accept', args: {
      runId: task.runId, inputId: 'identity', sourceKey: 'web:identity', requirementRef: replacement.ref } })
  }
  await service.recoverExecutionTasks()
  const after = await execution.controller.whenIdle(task.runId)
  assert.equal(after.run.generation, before.run.generation)
  assert.equal(after.nodes[0].nodeRunId, before.nodes[0].nodeRunId)
  assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId })).length, 0)
  if (['repaired', 'protocol-repaired'].includes(gate)) { assert.equal(after.run.status, 'succeeded'); assert.equal(reads, 3) }
  else { assert.notEqual(after.run.status, 'succeeded'); assert.equal(reads, ['unrepaired', 'maintenance-during-read'].includes(gate) ? 2 : 1) }
})

for (const gate of ['maintenance', 'pause', 'stop', 'input', 'maintenance-during-read']) test(`交付只读恢复屏障 ${gate}`, async t => {
  let sends = 0, reads = 0, executionRef
  const enter = () => executionRef.store.command({ id: 'fixture-maintenance', kind: 'runtime.maintenance.change', args: {
    maintenanceId: 'fixture', actorId: 'owner', active: true, expectedRevision: 0, reason: 'test' } })
  const { service, execution, message, startCodeTask } = await fixture(t, 'owner', undefined, {
    allowedEffects: ['external.operation'],
    deliveryOptions: { authorize: async () => false,
      authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'fixture' }),
      externalAdapter: { execute: async () => { sends++; return { status: 'unknown' } },
        reconcile: async () => { reads++; if (gate === 'maintenance-during-read') await enter(); return { status: 'succeeded' } } } },
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external',
      prepared: { action: 'external', workflowKind: 'uat-deployment', resourceKey: 'external:fixture:uat', runId, generation, requirementDigest } }),
  })
  executionRef = execution
  const task = await startCodeTask()
  await execution.controller.whenIdle(task.runId)
  if (gate === 'maintenance') await enter()
  if (gate === 'pause' || gate === 'stop') await execution.store.command({ id: `fixture-${gate}`, kind: `run.${gate}`, args: { runId: task.runId, reason: 'test' } })
  if (gate === 'input') {
    const replacement = await execution.artifacts.put({ request: 'new input' })
    await execution.store.command({ id: 'fixture-input', kind: 'input.accept', args: { runId: task.runId, inputId: 'fixture', sourceKey: 'web:fixture', requirementRef: replacement.ref } })
  }
  await settleTaskOwners(service, service.execution); await execution.controller.whenIdle(task.runId)
  const after = await execution.controller.state(task.runId)
  assert.notEqual(after.run.status, 'succeeded'); assert.equal(sends, 1)
  assert.equal(reads, gate === 'maintenance-during-read' ? 1 : 0)
  assert.equal((await execution.store.query({ kind: 'effect.list', runId: task.runId }))[0].state,
    gate === 'maintenance-during-read' ? 'succeeded' : 'unknown')
})

for (const [firstDecision, workflowKind] of [['approved', 'uat-deployment'], ['rejected', 'uat-deployment'], ['approved', 'uat-rebuild']]) test(`UAT Web 审批完整请求ID ${workflowKind}/${firstDecision}：可见、授权、首终态与Owner事件幂等`, async t => {
  const requestId = `external:${'a'.repeat(64)}`, commitSha = 'b'.repeat(40)
  let sends = 0
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' },
    deliveryOptions: { authorize: async () => false,
      authorizeExternal: async () => ({ principalId: 'owner', approval: { requestId, approverIds: ['owner'] } }),
      externalAdapter: { execute: async () => { sends++; return { status: 'succeeded' } }, reconcile: async () => ({ status: 'unknown' }) } },
  })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  const original = (await service.state(received.runId)).commands[0].result
  assert.equal(original.runId,null)
  await settleTaskOwners(service, service.execution)
  const taskId = 'web-approval-fixture', target = { repository: 'HiQ-AI/dataset', environment: 'uat', service: 'dataset', commitSha, runbookId: 'dataset-uat3-deployment' }
  const requirement = await execution.artifacts.put({ request: '验证UAT3提测', target })
  await execution.store.command({ id: 'approval-web-origin', kind: 'task.web-rerun.accept', args: {
    taskId, rerunOfTaskId: original.taskId, actorId: 'owner', request: { expectedRunId: original.runId, objective: '验证UAT3提测', uatEnvironment: 'uat3' },
    requirementRef: requirement.ref, criteria: ['验证提测'], sourceKey: 'web-rerun:approval-fixture' } })
  execution.controller.registerWorkflow({ id: 'approval-fixture', version: '1', nodes: [{
    id: 'execute-build', version: '1', executor: 'code', allowedEffects: ['external.operation'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement,
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external', prepared: {
      action: 'external', workflowKind, operation: workflowKind === 'uat-rebuild' ? 'rebuild' : 'build', runId, generation, requirementDigest,
      resourceKey: 'external:uat:HiQ-AI/dataset:dataset', expected: { commitSha } } }),
  }] })
  await execution.controller.initializeTaskPlan({ commandId: 'approval-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1,
    stages: [{ stageId: 'uat', workflowId: 'approval-fixture', input: { request: '验证UAT3提测', target } }] })
  const started = await execution.controller.advanceTaskPlan(taskId), runId = started.stages[0].runId
  await execution.controller.whenIdle(runId)
  const frozenRun = await execution.controller.state(runId)
  const [frozenEffect] = await execution.store.query({ kind: 'effect.list', runId })
  const currentObjective = '按当前明确要求验证 UAT3 提测结果'
  const revisedGoal = await execution.artifacts.put({ request: currentObjective, objective: currentObjective, target, acceptanceCriteria: ['验证提测结果'] }, { taskId })
  await execution.store.command({ id: 'approval-current-goal', kind: 'task.requirement.update', args: {
    taskId, expectedRequirementRevision: 1, requirementRef: revisedGoal.ref, eventKey: 'approval-current-goal' } })
  const visible = await service.listApprovalRequests()
  assert.equal(visible.length, 1); assert.equal(visible[0].requestId, requestId)
  assert.equal(visible[0].objective, currentObjective); assert.match(visible[0].requestedAction, /UAT 目标 dataset-uat3-deployment/)
  assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRevision, 2)
  assert.equal((await execution.controller.state(runId)).run.requirementRef, frozenRun.run.requirementRef)
  assert.deepEqual(await execution.store.query({ kind: 'effect.get', effectId: frozenEffect.effectId }), frozenEffect)
  assert.match(visible[0].requestedAction, /HiQ-AI\/dataset/); assert.ok(visible[0].evidence.includes(commitSha))
  assert.equal(visible[0].status, 'pending-send'); assert.equal(sends, 0)
  await assert.rejects(service.decideApproval({ requestId, decision: 'approved', eventId: 'bad-web' }, { channel: 'web', actorId: 'outsider' }), /WORKFLOW_WEB_ACTOR_FORBIDDEN/)
  await assert.rejects(service.decideApproval({ requestId, decision: 'approved', eventId: 'bad-im' }, { channel: 'im', actorId: 'outsider', conversationId: 'web:owner' }), /WORKFLOW_APPROVAL_FORBIDDEN/)
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId })).decision, 'pending')
  await assert.rejects(execution.store.command({ id: 'old-approval-event', kind: 'task.owner.event', args: {
    taskId, eventKey: `approval:${requestId}:${'c'.repeat(64)}`, eventType: 'approval.resolved' } }), /TASK_OWNER_ID_INVALID/)
  const first = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'first' }, { channel: 'web', actorId: 'owner' })
  assert.equal(first.decision, firstDecision); assert.equal(first.applied, true)
  await execution.controller.whenIdle(runId)
  const exactReplay = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'first' }, { channel: 'web', actorId: 'owner' })
  assert.deepEqual(exactReplay, first)
  const repeated = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'repeat' }, { channel: 'web', actorId: 'owner' })
  const opposite = await service.decideApproval({ requestId, decision: firstDecision === 'approved' ? 'rejected' : 'approved', eventId: 'opposite' }, { channel: 'web', actorId: 'owner' })
  assert.equal(repeated.applied, false); assert.equal(opposite.decision, firstDecision); assert.equal(opposite.applied, false)
  assert.equal(sends, firstDecision === 'approved' ? 1 : 0)
  const db = new DatabaseSync(join(execution.artifacts.root, '..', 'control.db'), { readOnly: true })
  try {
    const events = db.prepare("SELECT event_key FROM task_events WHERE task_id=? AND event_type='approval.resolved'").all(taskId)
    assert.equal(events.length, 1); assert.ok(events[0].event_key.length <= 128)
  } finally { db.close() }
  assert.equal((await service.listApprovalRequests())[0].status, 'answered')
  // 相同真实控制账用另一 Web 身份读取：不可见，也不能批准。
  const hidden = await openWorkflowService({ ctx: {}, execution, judge: async () => { throw Error('UNEXPECTED_JUDGE') }, config: { groupIds: ['g'], ownerActorId: 'owner', webActorId: 'other' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }) } })
  try {
    assert.deepEqual(await hidden.listApprovalRequests(), [])
    await assert.rejects(hidden.decideApproval({ requestId, decision: 'approved', eventId: 'hidden' }, { channel: 'web', actorId: 'other' }), /WORKFLOW_APPROVAL_FORBIDDEN/)
  } finally { await hidden.close() }
})

for(const valid of [true,false,'observed'])test(`普通UAT构建失败收口 receipt=${valid}：单次发送、保留失败证据且不反复恢复`,async t=>{
 let sends=0,reads=0;const operationKey='a'.repeat(64),commitSha='b'.repeat(40)
 const receipt={status:'failed',reason:'RELEASE_PIPELINE_FAILED',operationKey,commitSha,pipelineNumber:319,pipelineStatus:valid?'killed':'running',evidenceRef:'woodpecker:list:319'}
 const {service,execution,message,startCodeTask}=await fixture(t,'owner',undefined,{allowedEffects:['external.operation'],deliveryOptions:{authorize:async()=>false,authorizeExternal:async()=>({principalId:'owner',authorizationRef:'fixture'}),externalAdapter:{execute:async()=>{sends++;return{status:'unknown'}},reconcile:async()=>{reads++;return receipt}}},execute:async({runId,generation,requirementDigest,perform})=>perform({action:'external',prepared:{action:'external',workflowKind:'uat-deployment',operation:'build',operationKey,expected:{commitSha},resourceKey:'external:fixture:uat',runId,generation,requirementDigest}})})
 const task=await startCodeTask();await execution.controller.whenIdle(task.runId);const before=await execution.controller.state(task.runId);assert.equal(before.run.status,'waiting')
 if(valid==='observed')await execution.delivery.reconcile((await execution.store.query({kind:'effect.list',runId:task.runId}))[0].effectId)
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId);const after=await execution.controller.state(task.runId)
 assert.equal(after.run.status,valid?'failed':'waiting');assert.equal(after.nodes[0].status,valid?'failed':'waiting');assert.equal(after.run.generation,before.run.generation);assert.equal(sends,1);assert.equal(reads,1)
 if(valid){assert.equal(after.nodes[0].waitReason.reference,'RELEASE_PIPELINE_FAILED');assert.deepEqual(await execution.artifacts.read(after.nodes[0].evidenceRefs[0]),receipt)}
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId);assert.equal(sends,1);assert.equal(reads,1)
})

test('任务投影只在真实等待时显示原因，完成后隐藏遗留原因且不改历史', async t => {
  let succeed = false, staleReadback = false
  const { service, execution, message, root } = await fixture(t, 'owner', undefined, {
    storeQuery: async (request, query) => {
      const value = await query(request)
      return staleReadback && request.kind === 'task.owner' && value
        ? { ...value, lastFailure: 'DELIVERY_RECONCILIATION_REQUIRED' } : value
    },
    execute: async () => succeed ? { summary: '已核对完成' }
      : { outcome: 'needs_clarification', summary: '尚需核对结果', question: '请提供核对结果' },
  })
  const accepted = await service.ingest(message), received = await service.messages.process(accepted.runId)
  const taskId = received.commands[0].result.taskId
  await settleTaskOwners(service, execution)
  const waiting = (await service.tasks()).find(item => item.taskId === taskId)
  assert.equal(waiting.state, 'waiting')
  assert.equal(waiting.waitingCondition.kind, 'business-input')
  assert.match(waiting.waitingReason, /请提供核对结果/)
  const prior = await execution.store.query({ kind: 'task.owner', taskId })
  const priorRef = prior.decision.evidenceRefs[0]
  const priorEvidence = await execution.artifacts.read(priorRef)
  succeed = true
  // Host 确认核对条件已变化，复用同一任务和会话；不创建虚构调查Run。
  await execution.store.command({ id: 'projection-condition-resolved', kind: 'task.owner.event',
    args: { taskId, eventKey: 'projection-condition-resolved', eventType: 'system.recovery' } })
  await settleTaskOwners(service, execution)
  const before = await execution.store.query({ kind: 'task.owner', taskId })
  const beforePlan = await execution.controller.taskPlan(taskId)
  assert.equal(before.decision.action, 'complete')
  assert.equal(before.applicationStatus, 'applied')
  const database = new DatabaseSync(join(root, 'control.db'), { readOnly: true })
  const readWaitTurn = () => database.prepare("SELECT * FROM task_owner_turns WHERE task_id=? AND json_extract(decision_json,'$.action')='wait' ORDER BY rowid DESC LIMIT 1").get(taskId)
  const waitTurn = readWaitTurn()
  assert.equal(JSON.parse(waitTurn.decision_json).condition.kind, 'business-input')
  assert.equal(waitTurn.application_status, 'applied')
  // 此替身只构造投影反例，不作为原生验收证据，也不修改或清除持久历史。
  staleReadback = true
  try {
    const completed = (await service.tasks()).find(item => item.taskId === taskId)
    assert.equal(completed.state, 'completed')
    assert.equal(completed.outcome, 'succeeded')
    assert.equal(completed.waitingReason, undefined)
    assert.equal(completed.stageConfirmation, null)
    assert.equal(completed.budgetContinuation, undefined)
  } finally { staleReadback = false }
  assert.deepEqual(await execution.store.query({ kind: 'task.owner', taskId }), before)
  assert.deepEqual(await execution.controller.taskPlan(taskId), beforePlan)
  try { assert.deepEqual(readWaitTurn(), waitTurn) } finally { database.close() }
  assert.deepEqual(await execution.artifacts.read(priorRef), priorEvidence)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})

test('真实Owner路径保留工程本地验收与合并前缀，失败第三阶段重建后可结案', async t => {
  const commitSha='a'.repeat(40), candidateDigest='b'.repeat(64), verificationDigest='c'.repeat(64), tree='d'.repeat(40)
  let rebuilds=0, deploymentSends=0;const ownerInputs=[], domainChecks=[]
  const criteria=['保存草稿成功','版本已部署UAT']
  const target={repository:'HiQ-AI/dataset-web',environment:'uat',service:'dataset-web',runbookId:'deploy-uat2',commitSha}
  const releaseAdapter=kind=>({id:`fixture-${kind}`,version:'1',rulesDigest:'e'.repeat(64),
    inspect:async({phase,requirement,effect})=>({phase,targetDigest:executionDigest(requirement.target),status:'confirmed',evidenceRefs:[`proof-${phase}`],facts:phase==='preflight'
      ?{targetBranchVerified:true,uatPrMerged:true,failurePipelineVerified:true,equivalentBuildAbsent:true,branchHeadMatches:true,noNewerRuntimeVersion:true,sourcePackageSupported:true}
      :{sourceSha:commitSha,registryDigest:'sha256:registry',runtimeDigest:'sha256:registry',observedGeneration:'1',ready:true,entryAccessible:true,imageChainVerified:true,
        operationKey:effect.prepared.operationKey,receiptDigest:executionDigest(effect.receipt)}}),
    prepareOperation:async({operation,requirement,runId,generation,requirementDigest,expected})=>({action:'external',workflowKind:kind,operation,runId,generation,requirementDigest,
      resourceKey:'external:uat:HiQ-AI/dataset-web:dataset-web',targetDigest:executionDigest(requirement.target),expected,operationKey:executionDigest([runId,operation])})})
  const external={releaseAdapters:Object.fromEntries(['uat-deployment','uat-rebuild'].map(kind=>[kind,releaseAdapter(kind)])),
    operationAdapter:{execute:async()=>{throw Error('UNEXPECTED_REMOTE')},reconcile:async()=>({status:'unknown'})},authorizeExternal:async()=>false,
    prepareRequirement:async()=>{throw Error('UNEXPECTED_INPUT')},
    prepareUatRebuildFromFailure:async({taskId,runId})=>({request:'开发并提测',target:{...target,runbookId:'rebuild-uat2'},constraints:[],evidenceRefs:[`uat-failed-task:${taskId}:${runId}`]})}
  const sessions={async run({binding,input,tools,queryInput,onQueryEvidence,readArtifact,onSessionBound,onCandidate}){
    ownerInputs.push(input);await onSessionBound();const done=input.stages.length>0&&input.stages.every(stage=>stage.status==='succeeded')
    const evidenceRefs=input.stages.length?input.stages.map(stage=>stage.outputRef).filter(Boolean):await queryOwnerSources({binding,tools,queryInput,onQueryEvidence})
    for(const ref of evidenceRefs) await readArtifact(ref)
    const complete=!input.stages.length||done
    const decision={action:complete?'complete':'wait',summary:'已核对阶段证据',evidenceRefs,
      ...(complete?{assessments:input.acceptanceItems.map(item=>({itemId:item.itemId,status:'satisfied',evidenceRefs:
        input.taskId==='owner-uat-rebuild'?[input.stages[item.criterion===criteria[0]?0:2].outputRef]:evidenceRefs}))}:{})}
    await onCandidate(decision);return{status:'submitted',decision}
  },async close(){}}
  const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},external,taskOwnerSessions:sessions,
    generalCompletionCheck:async input=>{
      if(!input.evidence.some(item=>item.workflowKind==='uat-rebuild')) return {status:'satisfied',resultVerified:true,criteria:input.acceptanceCriteria.map(criterion=>({criterion,passed:true,evidenceIds:input.evidence.map(item=>item.evidenceId)}))}
      domainChecks.push(input)
      assert.deepEqual(input.acceptanceCriteria,criteria)
      assert.equal(input.evidence.length,2)
      assert.equal(input.evidence.some(item=>item.mergeCommitSha),false)
      assert.equal(input.evidence.some(item=>item.deliveryStatus==='pr_verified'),true)
      const deployed=input.evidence.find(item=>item.workflowKind==='uat-rebuild')
      assert.equal(deployed?.status,'technical-delivery-confirmed')
      assert.equal(deployed.commitSha,commitSha)
      assert.deepEqual(deployed.evidenceRefs,['proof-runtime'])
      assert.deepEqual(input.acceptanceItems[1].evidenceRefs,[deployed.evidenceId])
      return{status:'satisfied',resultVerified:true,criteria:input.acceptanceItems.map(item=>({criterion:item.criterion,passed:true,evidenceIds:item.evidenceRefs}))}
    },deliveryOptions:{authorize:async()=>false,
    authorizeExternal:async()=>({principalId:'owner',authorizationRef:'isolated-test'}),externalAdapter:{
      execute:async prepared=>{if(prepared.operation==='rebuild'){rebuilds++;return{status:'succeeded'}}deploymentSends++;return{status:'failed',reason:'RELEASE_PIPELINE_FAILED',
        operationKey:prepared.operationKey,commitSha,pipelineNumber:319,pipelineStatus:'killed',evidenceRef:'pipeline-319'}},reconcile:async()=>({status:'unknown'})}}})
  const received=await service.ingest(message);await service.messages.process(received.runId)
  const original=(await service.state(received.runId)).commands[0].result
  await settleTaskOwners(service, execution)
  assert.equal(original.runId,null)
  const taskId='owner-uat-rebuild',sourceCommandId='owner-prefix',workflowId=`task-engineering-${executionDigest(sourceCommandId).slice(0,40)}`
  const engineeringRun=execution.controller.plannedTaskStageRunId({taskId,planRevision:1,stageId:'stage-1',attempt:1})
  const localPlan={cases:[{criterionId:'business',scenarioId:'browser',steps:['保存草稿'],expected:'保存成功',parameters:{}}]}
  const localPrepared={taskId,runId:engineeringRun,candidateDigest,identity:'f'.repeat(64),plan:localPlan,planDigest:executionDigest(localPlan),uatEnvironment:'uat2'}
  const outputs={
    'verify-candidate':{candidate:{digest:candidateDigest,tree},verification:{digest:verificationDigest,passed:true,checks:[{id:'build',version:'1',passed:true}]}},
    'define-local-acceptance':{localContext:{criteria:[{id:'business',description:'保存草稿成功'}],scenarios:[{id:'browser'}],uatEnvironment:'uat2'}},
    'finalize-local-acceptance':{localPrepared,localAcceptance:{identity:localPrepared.identity,candidateDigest,planDigest:localPrepared.planDigest,uatEnvironment:'uat2',passed:true,
      cleanup:{dataCleaned:true,processStopped:true},checks:[{...localPlan.cases[0],actual:'保存成功',passed:true}]}},
    'prepare-commit':{commitId:commitSha,candidateDigest,tree,verification:{digest:verificationDigest}},commit:{prepared:{commitId:commitSha},receipt:{status:'succeeded'}},
    'prepare-push':{commitId:commitSha,verificationDigest},push:{prepared:{commitId:commitSha},receipt:{status:'succeeded'}},'prepare-pr':{commitId:commitSha},
    'create-pr':{prepared:{commitId:commitSha},receipt:{status:'succeeded',number:368,url:'https://github.com/HiQ-AI/dataset-web/pull/368'}},
    finalize:{deliveryStatus:'pr_verified',commitId:commitSha,number:368,url:'https://github.com/HiQ-AI/dataset-web/pull/368',repo:target.repository,head:'codex/existing',base:'feature/uat2-base',state:'OPEN'},
  }
  const engineeringWorkflow={id:workflowId,version:'12',ownerContract:engineeringWorkflowOwnerContract,nodes:Object.entries(outputs).map(([id,value])=>({id,version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,
    mapInput:({requirement})=>requirement,execute:async()=>value}))}
  execution.controller.registerWorkflow(engineeringWorkflow)
  await execution.store.command({id:'owner-proof-record',kind:'workflow.register',args:{workflowId,definitionVersion:'12',digest:defineExecutionWorkflow(engineeringWorkflow).digest,
    config:{kind:'engineering',taskId,runId:engineeringRun,sourceCommandId}}})
  execution.controller.registerWorkflow({id:'task-uat-pr-merge',version:'fixture',ownerContract:externalWorkflowOwnerContract,nodes:[{id:'verify-source',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,
    mapInput:({requirement})=>requirement,execute:async()=>({status:'confirmed',mergeCommitSha:commitSha,baseBranch:'feature/uat2-base',evidenceRefs:['merge-proof']})}]})
  const originalGoal=await execution.artifacts.read((await execution.controller.taskPlan(original.taskId)).task.requirementRef)
  const goal=await execution.artifacts.put({...originalGoal,request:'开发并提测',target:{},acceptanceCriteria:criteria,constraints:[],explicitStages:[],authorization:{channel:'web'},reportChannel:'web',externalMessaging:false})
  await execution.store.command({id:'owner-rebuild-origin',kind:'task.web-rerun.accept',args:{taskId,rerunOfTaskId:original.taskId,actorId:'owner',
    request:{expectedRunId:original.runId,objective:'开发并提测',stages:['task-engineering','task-uat-pr-merge','task-uat-deployment']},requirementRef:goal.ref,criteria,sourceKey:'web-rerun:owner-rebuild'}})
  await execution.controller.initializeTaskPlan({commandId:'owner-rebuild-plan',taskId,expectedPlanRevision:0,expectedRequirementRevision:1,stages:[
    {stageId:'stage-1',workflowId,input:{request:'实现保存草稿',acceptanceCriteria:[criteria[0]]}},{stageId:'stage-2',workflowId:'task-uat-pr-merge',gate:'none'},{stageId:'stage-3',workflowId:'task-uat-deployment',gate:'none'}]})
  let plan=await execution.controller.advanceTaskPlan(taskId);await execution.controller.whenIdle(plan.stages[0].runId);plan=await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.bindTaskStageInput({commandId:'owner-bind-merge',taskId,planRevision:1,stageId:'stage-2',predecessorOutputRef:plan.stages[0].outputRef,input:{}})
  plan=await execution.controller.advanceTaskPlan(taskId);await execution.controller.whenIdle(plan.stages[1].runId);plan=await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.bindTaskStageInput({commandId:'owner-bind-deploy',taskId,planRevision:1,stageId:'stage-3',predecessorOutputRef:plan.stages[1].outputRef,
    input:{request:'开发并提测',target,constraints:[],evidenceRefs:[`uat-merge-task:${taskId}:${plan.stages[1].runId}`]}})
  plan=await execution.controller.advanceTaskPlan(taskId);const failedRun=plan.stages[2].runId;await execution.controller.whenIdle(failedRun)
  assert.equal((await execution.controller.state(failedRun)).run.status,'failed')
  const prefix=structuredClone(plan.stages.slice(0,2))
  for(let i=0;i<5;i++){await settleTaskOwners(service, execution);plan=await execution.controller.taskPlan(taskId);if(plan.stages[2].runId)await execution.controller.whenIdle(plan.stages[2].runId)}
  assert.equal(plan.task.planRevision,2);assert.equal(plan.task.status,'succeeded');assert.equal(plan.stages[2].workflowId,'task-uat-rebuild')
  assert.deepEqual(plan.stages.slice(0,2),prefix);assert.equal(deploymentSends,1);assert.equal(rebuilds,1)
  assert.equal((await execution.controller.state(failedRun)).run.status,'failed')
  await settleTaskOwners(service, execution)
  const owner=await execution.store.query({kind:'task.owner',taskId});assert.equal(owner.decision?.action,'complete',JSON.stringify({owner,domainChecks}))
  assert.equal(domainChecks.length,1)
  const detail = await service.taskDetail(taskId)
  const manifestBinding = await execution.store.query({ kind: 'task.owner.delivery-manifest', taskId })
  assert.deepEqual(detail.deliveryManifest, manifestBinding)
  const manifest = await execution.artifacts.read(manifestBinding.ref)
  assert.equal(manifest.complete, true); assert.equal(manifest.taskId, taskId)
  assert.equal(manifest.businessValidation.status,'accepted')
  assert.deepEqual(manifest.businessValidation.items.map(item=>item.criterion),criteria)
  assert.equal(manifest.planRevision, 2); assert.equal(manifest.artifacts.length, 3)
  const completedInput=ownerInputs.find(input=>input.taskId===taskId&&input.task.planRevision===2&&input.stages.every(stage=>stage.status==='succeeded'))
  assert.ok(completedInput.stageArtifacts[0].nodeArtifacts.some(node=>node.nodeId==='finalize-local-acceptance'))
})


test('Owner直接查询证据经真实Service与工程准备进入方案输入，伪造证据拒绝', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'investigation-engineering-handoff-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source'); await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'feature/uat2-base')
  const profile = join(directory, 'uat.json'); await writeFile(profile, JSON.stringify({ environment: 'uat', env: {} }))
  const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
  const localAcceptance = { version: '1', sharedDataProfilePath: profile, prepareSteps: [], service: { ...command, args: [...command.args, '{port}', '127.0.0.1'], readyPath: '/' }, scenarios: [{ id: 'value', description: '业务值', ...command }], cleanup: command, verifyCleanup: command }
  const repositories = [{ id: 'repo', sourceRepository: source, managedRoot: join(directory, 'managed'), remote: source,
    baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'], localAcceptance,
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }]
  let execution, proposalInput
  const deliveryResults=[]
  const registry = createEngineeringRegistry({ repositories, ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }) })
  const delivery = { async execute(request) {
    await registry.restore(execution.store, execution.artifacts)
    const result=await createExecutionDelivery({ store: execution.store, artifacts: execution.artifacts, ...registry.deliveryOptions }).execute(request)
    deliveryResults.push(result)
    return result
  } }
  const executionSessions = { async run({ binding, input, onSessionBound, onResult }) {
    await onSessionBound()
    if (binding.nodeId === 'plan-local-acceptance') { await onResult({ cases: [] }); return { status: 'submitted' } }
    proposalInput = input
    return { status: 'stopped', reason: 'TEST_STOP_AFTER_INPUT_READBACK' }
  }, async close() {}, async cancel() {} }
  const ownerSessions = { async run({ binding, input, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound()
    const evidenceRefs = !input.stages.length ? await queryOwnerSources({binding,tools,queryInput,onQueryEvidence}) : []
    const decision = !input.stages.length
      ? { action: 'advance', summary: '已读当前来源，继续开发', evidenceRefs, planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-engineering', gate: 'none' }] } }
      : { action: input.stages.some(stage => stage.status === 'ready' || stage.status === 'blocked') ? 'advance' : 'wait', summary: '按计划推进', evidenceRefs: [] }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const f = await fixture(t, 'owner', undefined, { delivery, executionSessions, taskOwnerSessions: ownerSessions,
    config: { repositories }, judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '调查后修复value', repositoryId: 'repo', uatEnvironment: 'uat2', acceptanceCriteria: ['value符合预期'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } })
  execution = f.execution
  const received = await f.service.ingest({ ...f.message, text: '调查后修复value，提交到uat2' }); await f.service.messages.process(received.runId)
  const taskId = (await f.service.state(received.runId)).commands[0].result.taskId
  for (let attempt = 0; attempt < 8 && !proposalInput; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages) if (stage.runId) await execution.controller.whenIdle(stage.runId)
    await settleTaskOwners(f.service, execution)
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.ok(proposalInput, JSON.stringify({deliveryResults}))
  assert.equal(plan.stages.length,1)
  const engineeringStage = plan.stages[0]
  const record = (await execution.store.query({ kind: 'workflow.list' })).find(item => item.config?.runId === engineeringStage.runId)
  assert.equal(record.definitionVersion, '18')
  assert.deepEqual(proposalInput.taskContext, record.config.taskContext)
  assert.equal(proposalInput.taskContext.taskId,taskId)
  assert.equal(proposalInput.taskContext.requirementRevision,plan.task.requirementRevision)
  const proof = proposalInput.taskContext.queryEvidence[0]
  const nativeProof = await execution.artifacts.read(proof.artifactRef)
  assert.equal(nativeProof.execution.taskId,taskId)
  assert.deepEqual(proof.result,nativeProof.result)
  assert.equal((await execution.store.query({kind:'run.list'})).some(run=>run.workflowId==='task-investigation'),false)
  const state = await execution.controller.state(engineeringStage.runId)
  const node = state.nodes.find(item => ['inspect-and-propose', 'propose-changes'].includes(item.nodeId))
  assert.deepEqual((await execution.artifacts.read(node.inputRef)).data.taskContext, proposalInput.taskContext)
  const info = { commandId: record.config.sourceCommandId, stageRunId: engineeringStage.runId, run: { actorId: 'owner' }, unit: {}, taskContext: record.config.taskContext }
  const action={taskId,arguments:{objective:record.config.input.request,repositoryId:'repo',uatEnvironment:'uat2',acceptanceCriteria:record.config.input.acceptanceCriteria},constraints:record.config.input.constraints}
  await assert.rejects(registry.prepareTask(action,{...info,taskContext:{...info.taskContext,queryEvidence:[{...proof,artifactRef:'sha256-'+'a'.repeat(64)+'.json'}]}},execution.controller),{code:'ENGINEERING_TASK_CONTEXT_INVALID'})
  await assert.rejects(registry.prepareTask({...action,taskId:'foreign-task'},info,execution.controller),{code:'ENGINEERING_TASK_CONTEXT_INVALID'})
  await assert.rejects(registry.prepareTask(action,{...info,taskContext:{...info.taskContext,requirementRevision:0}},execution.controller),{code:'ENGINEERING_TASK_CONTEXT_INVALID'})
  const replay = await registry.prepareTask(action,info,execution.controller)
  assert.equal(replay.runId, engineeringStage.runId)
  assert.deepEqual(replay.input, record.config.input)
})


test('渠道inline-code转换可独立回读，值变化仍拒绝',async()=>{
  const reply='按您选择的中文答复：example-project 登记代码版本 0123456789abcdef0123456789abcdef01234567 的根目录 pom.xml 第 20 行配置 `<java.version>11</java.version>`；Maven 编译配置的 source、target、release 均引用 `${java.version}`（第 363—365 行），即配置为 Java 11。'
  const observed={text:'按您选择的中文答复：example-project 登记代码版本 0123456789abcdef0123456789abcdef01234567 的根目录 pom.xml 第 20 行配置 **<java.version>11</java.version>**；Maven 编译配置的 source、target、release 均引用 **${java.version}**（第 363—365 行），即配置为 Java 11。  \n- 小助手代回'}
  const expected=formatGroupReply(reply,'小助手代回')
  assert.equal(sameDeliveredText(observed.text,expected,true),true)
  assert.equal(sameDeliveredText(observed.text.replace('<java.version>11','<java.version>17'),expected,true),false)
})


test('新版任务真实HTTP归档仅完成可用，幂等持久且不改变节点产物或发送消息', async t => {
  let sends = 0
  const notices = { canDisclose: async () => true, send: async () => { sends++; return { messageId: 'archive-notice' } },
    readback: async () => ({ messageId: 'archive-notice', conversationId: 'g' }) }
  const { service, execution, message, root } = await fixture(t, 'owner', notices, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message), state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].result.runId, null)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await service.flushNotifications()
  const task = (await service.tasks())[0]
  assert.equal(task.state, 'completed')
  const planBefore = await execution.controller.taskPlan(task.taskId)
  const ownerBefore = await execution.store.query({ kind: 'task.owner', taskId: task.taskId })
  const outputs = await Promise.all(ownerBefore.decision.evidenceRefs.map(ref => execution.artifacts.read(ref)))
  const noticesBefore = await execution.store.query({ kind: 'message.notifications' }), sendsBefore = sends
  const identity = { channel: 'web', actorId: 'owner' }
  await assert.rejects(service.submitWebTask({ action: 'archive', taskId: task.taskId }, { channel: 'web', actorId: 'attacker' }), /FORBIDDEN/)
  let legacyCalls = 0
  const runtime = { isWorkflowTask: service.isTask, listTaskView: () => service.tasks(),
    submitWorkflowTask: request => service.submitWebTask(request, identity), archiveTask: () => { legacyCalls++; throw new Error('LEGACY_NOT_ALLOWED') } }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, origin = 'http://127.0.0.1:3080') => fetch(`${base}/tasks/${task.taskId}/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  assert.equal((await post({}, 'https://evil.invalid')).status, 403)
  assert.equal((await post({ actorId: 'owner' })).status, 400)
  assert.equal((await post({ taskId: 'another' })).status, 400)
  const first = await post({}); assert.equal(first.status, 200, await first.clone().text())
  const archived = await first.json()
  assert.ok(Number.isFinite(Date.parse(archived.archivedAt)))
  const second = await post({}); assert.equal(second.status, 200)
  assert.equal((await second.json()).archivedAt, archived.archivedAt)
  const listed = await (await fetch(`${base}/state/tasks`)).json()
  assert.equal(listed.find(item => item.taskId === task.taskId).archivedAt, archived.archivedAt)
  assert.deepEqual(await execution.controller.taskPlan(task.taskId), planBefore)
  assert.deepEqual(await execution.store.query({ kind: 'task.owner', taskId: task.taskId }), ownerBefore)
  assert.deepEqual(await Promise.all(ownerBefore.decision.evidenceRefs.map(ref => execution.artifacts.read(ref))), outputs)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId: task.taskId }), [])
  assert.deepEqual(await execution.store.query({ kind: 'message.notifications' }), noticesBefore)
  assert.equal(sends, sendsBefore); assert.equal(legacyCalls, 0)
  await service.close(); await execution.controller.close(); await execution.store.close()
  const reopened = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'test', initialize: false })
  try {
    assert.deepEqual(await reopened.query({ kind: 'task.archives' }), [{ taskId: task.taskId, archivedAt: archived.archivedAt, actorId: 'owner' }])
  } finally { await reopened.close() }
})

test('新版任务归档拒绝运行中与等待中任务且不记录归档事件', async t => {
  let started, release
  const began = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve)
  t.after(() => release())
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' },
    execute: async () => { started(); await gate; return { summary: '等待后的结果' } } })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  const working = service.recoverExecutionTasks()
  await began
  const task = (await service.state(received.runId)).commands[0].result
  const request = { action: 'archive', taskId: task.taskId }, identity = { channel: 'web', actorId: 'owner' }
  assert.equal((await service.tasks())[0].state, 'running')
  await assert.rejects(execution.store.command({ id: 'archive-running-direct', kind: 'task.archive', args: { taskId: task.taskId, actorId: 'owner' } }), /NOT_COMPLETED|NOT_DRAINED/)
  await assert.rejects(service.submitWebTask(request, identity), /NOT_COMPLETED/)
  const currentPlan = await execution.controller.taskPlan(task.taskId)
  await execution.controller.controlTask({ commandId: 'archive-pause', taskId: task.taskId, intent: 'pause',
    expectedControlRevision: currentPlan.task.controlRevision })
  release(); await working
  assert.equal((await service.tasks())[0].state, 'waiting')
  await assert.rejects(execution.store.command({ id: 'archive-waiting-direct', kind: 'task.archive', args: { taskId: task.taskId, actorId: 'owner' } }), /NOT_COMPLETED|NOT_DRAINED/)
  await assert.rejects(service.submitWebTask(request, identity), /NOT_COMPLETED/)
  assert.deepEqual(await execution.store.query({ kind: 'task.archives' }), [])
  const waiting = (await service.tasks())[0]
  await service.submitWebTask({ action: 'cancel', taskId: task.taskId, requestId: 'archive-cancel-waiting',
    inputVersion: waiting.inputVersion, runSequence: waiting.runSequence, reason: '结束测试任务' }, identity)
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  const cancelled = (await service.tasks())[0]
  assert.equal(cancelled.state, 'completed'); assert.equal(cancelled.outcome, 'cancelled')
  const archived = await service.submitWebTask(request, identity)
  assert.ok(Number.isFinite(Date.parse(archived.archivedAt)))
})

test('同任务汇总卡片并分页历次执行：取消保留阶段成果、旧详情与权限隔离', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message), processed = await service.messages.process(received.runId)
  const original = processed.commands[0].result
  assert.equal(original.runId,null)
  await settleTaskOwners(service, service.execution)
  const rootView = (await service.tasks({ taskId: original.taskId }))[0]
  assert.equal(rootView.state, 'completed')
  assert.equal(rootView.topicRefs.length, 1)
  assert.equal(rootView.topicRefs[0].groupId, message.groupId)
  const add = async (taskId, parent, expectedRunId) => {
    const goal = await execution.artifacts.put({ request: `目标 ${taskId}`, acceptanceCriteria: ['正确'], constraints: [],
      scope: { conversationId: 'web:owner' }, authorization: {}, reportChannel: 'web', externalMessaging: false })
    await execution.store.command({ id: `accept-${taskId}`, kind: 'task.web-rerun.accept', args: {
      taskId, rerunOfTaskId: parent, actorId: 'owner', sourceKey: `web-rerun:${taskId}`,
      request: { expectedRunId, objective: `目标 ${taskId}` }, requirementRef: goal.ref, criteria: ['正确'] } })
  }
  const cancel = async taskId => {
    const plan = await execution.controller.taskPlan(taskId)
    await execution.controller.controlTask({ commandId: `cancel-${taskId}`, taskId, intent: 'cancel', expectedControlRevision: plan.task.controlRevision })
  }
  await add('history-2', original.taskId, original.runId)
  await cancel('history-2')
  await add('history-3', 'history-2', null)
  execution.controller.registerWorkflow({ id: 'history-engineering', version: '1', nodes: [{
    id: 'verify', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '工程完成', evidenceRefs: [] }) }] })
  await execution.controller.initializeTaskPlan({ commandId: 'history-plan', taskId: 'history-3', expectedPlanRevision: 0,
    expectedRequirementRevision: 1, stages: [
      { stageId: 'engineering', workflowId: 'history-engineering', input: { request: '执行第3次' } },
      { stageId: 'deployment', workflowId: 'history-engineering', gate: 'confirmation' } ] })
  const start = await execution.controller.advanceTaskPlan('history-3')
  await execution.controller.whenIdle(start.stages[0].runId)
  await execution.controller.advanceTaskPlan('history-3')
  await cancel('history-3')
  const physical = await service.tasks(), board = await service.boardTasks()
  assert.equal(physical.length, 3); assert.equal(board.length, 1)
  const latest = physical.find(task => task.taskId === 'history-3')
  for (const [key, value] of Object.entries(latest)) {
    if (key === 'topicRefs') { assert.deepEqual(board[0].topicRefs, rootView.topicRefs) } else if (key === 'executionTiming') {
      const { sampledAt, ...timing } = value
      const { sampledAt: boardSample, ...boardTiming } = board[0][key]
      assert.ok(Date.parse(sampledAt) && Date.parse(boardSample)); assert.deepEqual(boardTiming, timing)
    } else assert.deepEqual(board[0][key], value)
  }
  assert.equal(board[0].executionCount, 3); assert.equal(board[0].outcome, 'cancelled')
  assert.equal(board[0].sourceGroupId, original.groupId ?? message.groupId)
  assert.match(board[0].groupId, /^web:/u)
  const first = await service.taskExecutions('history-2', { limit: 2 })
  assert.deepEqual(first.executions.map(item => item.executionNumber), [3, 2])
  assert.equal(first.total, 3); assert.equal(first.nextOffset, 2)
  assert.equal(first.executions[0].outcome, 'cancelled')
  assert.equal(first.executions[0].stageOutcomes[0].status, 'succeeded')
  assert.deepEqual((await service.taskExecutions('history-3', { offset: 2, limit: 2 })).executions.map(item => item.taskId), [original.taskId])
  const oldDetail = await service.taskDetail(original.taskId)
  assert.equal(oldDetail.title, latest.title); assert.equal(oldDetail.executionNumber, 3)
  assert.equal(oldDetail.requestedTaskId, original.taskId)
  assert.equal(oldDetail.taskId, 'history-3')
  assert.equal(oldDetail.latestTaskId, 'history-3')
  assert.deepEqual(oldDetail.executionNodes.map(node => node.stageId), ['engineering', 'deployment'])
  assert.equal(oldDetail.executionNodes[0].status, 'succeeded')
  assert.equal(oldDetail.executionNodes[1].status, 'cancelled')
  assert.match(oldDetail.detailRevision, /^[a-f0-9]{64}$/u)
  await assert.rejects(service.taskExecutions('history-3', { limit: 101 }), /CURSOR_INVALID/)
  const scoped = await openWorkflowService({ ctx: {}, config: { groupIds: ['other'], ownerActorId: 'owner', webActorId: 'owner' },
    execution, legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: () => ({ messages: [] }) },
    judge: async () => { throw new Error('UNEXPECTED_MODEL') },
    taskOwnerSessions: { async run() { throw new Error('UNEXPECTED_OWNER') }, async close() {} } })
  t.after(() => scoped.close())
  assert.equal(await scoped.taskDetail(original.taskId), null)
  assert.equal(await scoped.taskExecutions(original.taskId), null)
  const visible = await scoped.taskExecutions('history-3')
  assert.equal(visible.total, 2); assert.equal(visible.rootTaskId, 'history-2')
  assert.deepEqual(visible.executions.map(item => item.executionNumber), [2, 1])
  assert.equal((await scoped.boardTasks())[0].executionCount, 2)
  assert.equal((await scoped.boardTasks())[0].sourceGroupId, null)
  assert.deepEqual((await scoped.boardTasks())[0].topicRefs, [])
  const server = createServer((req, res) => handleRequest(req, res, {
    getWorkflowTaskDetail: id => scoped.taskDetail(id), getWorkflowTaskExecutions: (id, page) => scoped.taskExecutions(id, page) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/state/tasks`
  assert.equal((await fetch(`${url}/${original.taskId}/detail`)).status, 404)
  assert.equal((await fetch(`${url}/history-3/detail`)).status, 200)
  const response = await fetch(`${url}/history-3/executions?offset=0&limit=1`)
  assert.equal(response.status, 200); assert.equal((await response.json()).nextOffset, 1)
  assert.equal((await fetch(`${url}/history-3/executions?offset=-1`)).status, 400)
  await assert.rejects(service.submitWebTask({ action: 'archive', taskId: original.taskId }, { channel: 'web', actorId: 'owner' }), /EXECUTION_STALE/)
  const archive = await service.submitWebTask({ action: 'archive', taskId: 'history-3' }, { channel: 'web', actorId: 'owner' })
  assert.ok(archive.archivedAt)
  assert.ok((await service.tasks()).every(task => task.archivedAt))
  assert.equal((await service.boardTasks()).length, 1)
  assert.equal((await service.taskExecutions('history-3')).total, 3)
})

test('当前完整详情保留已成功前段，替换删除新增后段并隔离同名步骤', async t => {
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' }, nodeId: 'verify', execute: async () => ({ summary: '第一阶段有效成果' }),
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  await execution.controller.advanceTaskPlan(taskId)
  const initial = await service.taskDetail(taskId), first = initial.executionNodes[0]
  assert.equal(initial.executionNodes.length, 1)
  assert.equal((await service.taskDetail(taskId)).detailRevision, initial.detailRevision)
  for (const id of ['detail-old-stage', 'detail-new-stage']) execution.controller.registerWorkflow({ id, version: '1', nodes: [{
    id: 'verify', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: `成果 ${id}` }),
  }] })
  let plan = await execution.controller.taskPlan(taskId)
  await execution.controller.extendTaskPlan({ commandId: 'detail-extend', taskId,
    expectedPlanRevision: plan.task.planRevision, requirementRevision: plan.task.requirementRevision,
    stages: [{ stageId: 'delivery', workflowId: 'detail-old-stage' }] })
  const extended = await service.taskDetail(taskId)
  assert.deepEqual(extended.executionNodes.map(node => node.status), ['succeeded', 'pending'])
  assert.equal(extended.executionNodes[0].nodeRunId, first.nodeRunId)
  assert.equal(extended.executionNodes[0].outputRef, first.outputRef)
  assert.equal(extended.result, null, '待执行后段不能展示前段旧成功为当前结果')
  plan = await execution.controller.taskPlan(taskId)
  await execution.controller.reviseTaskPlan({ commandId: 'detail-replace', taskId,
    expectedPlanRevision: plan.task.planRevision, requirementRevision: plan.task.requirementRevision, affectedFrom: 1,
    stages: [{ stageId: 'fixture', workflowId: 'fixture-code-operation' },
      { stageId: 'release', workflowId: 'detail-new-stage' },
      { stageId: 'unknown', workflowId: 'task-engineering' }] })
  const revised = await service.taskDetail(taskId)
  assert.deepEqual(revised.executionNodes.map(node => node.stageId), ['fixture', 'release', 'unknown'])
  assert.ok(revised.executionNodes.every(node => !node.stepKey.includes(':delivery:')))
  assert.equal(new Set(revised.executionNodes.map(node => node.stepKey)).size, 3)
  assert.equal(revised.executionNodes[0].stepKey, first.stepKey)
  assert.equal(revised.plan.stepsResolved, false)
  assert.equal(revised.executionNodes[2].definitionPending, true)
  await assert.rejects(service.taskNodeOutput(taskId, runId, first.nodeRunId,
    { outputRef: first.outputRef, detailRevision: initial.detailRevision }), /TASK_OUTPUT_CHANGED/)
  const currentPage = await service.taskNodeOutput(taskId, runId, first.nodeRunId,
    { outputRef: first.outputRef, detailRevision: revised.detailRevision })
  assert.match(currentPage.text, /第一阶段有效成果/)
  plan = await execution.controller.taskPlan(taskId)
  await execution.controller.bindTaskStageInput({ commandId: 'detail-bind-release', taskId,
    planRevision: plan.task.planRevision, stageId: 'release', predecessorOutputRef: first.outputRef,
    input: { request: '发布阶段', materials: [] } })
  const started = await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.whenIdle(started.stages[1].runId)
  const executed = await service.taskDetail(taskId)
  assert.deepEqual(executed.executionNodes.slice(0, 2).map(node => node.nodeId), ['verify', 'verify'])
  assert.deepEqual(executed.executionNodes.slice(0, 2).map(node => node.status), ['succeeded', 'succeeded'])
  assert.notEqual(executed.executionNodes[0].stepKey, executed.executionNodes[1].stepKey)
  assert.equal(executed.executionNodes[1].stepKey, revised.executionNodes[1].stepKey)
})

test('当前完整详情只取最新节点代次，需求更新后旧结果及正文立即失效', async t => {
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' },
    execute: async ({ input }) => {
      if (input.request === 'fixture') throw Object.assign(new Error('首次检查失败'), { code: 'CHECK_FAILED' })
      return { summary: input.request === 'retry' ? '最新修复结果' : '源任务成功' }
    },
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  const failed = await service.taskDetail(taskId), oldNode = failed.executionNodes[0]
  assert.equal(oldNode.status, 'waiting')
  const state = await execution.controller.state(runId)
  await execution.controller.changeInput({ commandId: 'detail-retry', runId, inputId: 'retry-input', sourceKey: 'retry-input',
    input: { request: 'retry', materials: [] }, expectedRevision: state.run.revision })
  await execution.controller.whenIdle(runId)
  const retry = await service.taskDetail(taskId), newNode = retry.executionNodes[0]
  assert.equal(retry.executionNodes.length, 1)
  assert.equal(newNode.status, 'succeeded')
  assert.ok(newNode.generation > oldNode.generation)
  assert.equal(newNode.stepKey, oldNode.stepKey)
  assert.notEqual(newNode.nodeRunId, oldNode.nodeRunId)
  assert.match(retry.result, /最新修复结果/)
  assert.equal(await service.taskNodeOutput(taskId, runId, oldNode.nodeRunId, { outputRef: oldNode.outputRef }), null)
  const plan = await execution.controller.taskPlan(taskId)
  const updated = await execution.artifacts.put({ request: '已改变需求', acceptanceCriteria: ['重新验证'], scope: { conversationId: 'g' } })
  await execution.store.command({ id: 'detail-requirement-change', kind: 'task.requirement.update', args: {
    taskId, expectedRequirementRevision: plan.task.requirementRevision, requirementRef: updated.ref,
    eventKey: 'detail-requirement-change' } })
  const changed = await service.taskDetail(taskId)
  assert.equal(changed.plan.requirementCurrent, false)
  assert.equal(changed.result, null)
  assert.equal(changed.executionNodes[0].status, 'blocked')
  assert.equal(changed.executionNodes[0].outputRef, null)
  await assert.rejects(service.taskNodeOutput(taskId, runId, newNode.nodeRunId,
    { outputRef: newNode.outputRef, detailRevision: retry.detailRevision }), /TASK_OUTPUT_CHANGED/)
  assert.equal(await service.taskNodeOutput(taskId, runId, newNode.nodeRunId, { outputRef: newNode.outputRef }), null)
})

test('详情在同次快照复用来源和当前阶段，不缓存跨请求授权与版本', async t => {
  const queries = []
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' }, execute: async () => ({ summary: '成功' }),
    storeQuery: async (request, query) => {
      if (request.kind !== 'task.origin' || /at origin |at project /.test(new Error().stack)) queries.push(request)
      return query(request)
    },
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  await execution.controller.advanceTaskPlan(taskId)
  const state = execution.controller.state
  let stateReads = 0
  execution.controller.state = async id => { if (id === runId) stateReads++; return state(id) }
  queries.length = 0
  const detail = await service.taskDetail(taskId)
  assert.equal(detail.executionNodes.length, 1)
  assert.equal(queries.filter(item => item.kind === 'task.origin' && item.taskId === taskId).length, 2,
    '每次只读取一次来源，交付前仍独立复核授权')
  assert.equal(stateReads, 1)
  assert.equal(queries.filter(item => item.kind === 'task.viewRevision').length, 2)
  queries.length = 0
  assert.equal((await service.taskDetail(taskId)).detailRevision, detail.detailRevision)
  assert.equal(queries.filter(item => item.kind === 'task.origin' && item.taskId === taskId).length, 2)
})

test('成功阶段后的业务等待展示缺失责任和恢复条件，系统异常保留独立诊断', async t => {
  let projectedOwner = null
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' }, execute: async () => ({ summary: '结构已查明' }),
    storeQuery: async (request, query) => request.kind === 'task.owner' && request.taskId === 'fixture-code-task' && projectedOwner
      ? projectedOwner : query(request),
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  await execution.controller.advanceTaskPlan(taskId)
  const plan = await execution.controller.taskPlan(taskId)
  const condition = { kind: 'business-input', missing: 'name 字段类型及是否允许为空', responsibleParty: '交办人',
    resumeWhen: '交办人确认字段定义后重新评估', evidenceRefs: [] }
  projectedOwner = { sessionId: 'owner', status: 'idle', applicationStatus: 'applied',
    requirementRevision: plan.task.requirementRevision, eventWatermark: 1, processedWatermark: 1,
    decision: { action: 'wait', summary: '请确认字段定义', condition } }
  const waiting = (await service.tasks({ taskId }))[0]
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.outcome, undefined)
  assert.deepEqual(waiting.waitingCondition, condition)
  assert.match(waiting.waitingReason, /name 字段类型及是否允许为空/)
  assert.match(waiting.waitingReason, /交办人/); assert.match(waiting.waitingReason, /确认字段定义后重新评估/)
  projectedOwner = { ...projectedOwner, status: 'blocked', applicationStatus: 'blocked', lastFailure: 'TASK_OWNER_BLOCK_CONFLICT' }
  const failed = (await service.tasks({ taskId }))[0]
  assert.equal(failed.waitingCondition, null)
  assert.equal(failed.waitingReason, '处理程序异常，需要维护人员修复后重新评估。')
  assert.equal(failed.taskOwner.lastFailure, 'TASK_OWNER_BLOCK_CONFLICT')
  assert.doesNotMatch(failed.waitingReason, /TASK_OWNER|字段类型/)
})

test('当前完整详情拒绝持续变化的版本，不交付混合计划快照', async t => {
  let changing = false, reads = 0
  const { service, execution, startCodeTask } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner' },
    execute: async () => ({ summary: '成功' }),
    storeQuery: async (request, query) => {
      const value = await query(request)
      return changing && request.kind === 'task.viewRevision' ? `${++reads}`.padStart(64, '0') : value
    },
  })
  const { taskId, runId } = await startCodeTask()
  await execution.controller.whenIdle(runId)
  changing = true
  await assert.rejects(service.taskDetail(taskId), /TASK_DETAIL_STALE/)
  assert.equal(reads, 6)
  changing = false
  assert.equal((await service.taskDetail(taskId)).executionNodes.length, 1)
})

test('历史并发分叉保持一张活动卡片，相同标题的独立任务不合并', () => {
  const rows = [{ taskId: 'root', title: '相同标题', state: 'running', outcome: undefined },
    { taskId: 'later', title: '相同标题', state: 'completed', outcome: 'succeeded' },
    { taskId: 'unrelated', title: '相同标题', state: 'completed', outcome: 'succeeded' }]
  const cards = groupTaskExecutions(rows, [{ taskIds: ['root', 'later'] }, { taskIds: ['unrelated'] }])
  assert.equal(cards.length, 2); assert.equal(cards[0].taskId, 'root')
  assert.equal(cards[0].latestTaskId, 'later'); assert.equal(cards[0].activeExecutionCount, 1)
  assert.equal(cards[0].state, 'running')
})

test('完整任务目录超过200条运行仍保留旧任务，投影不超过原生RPC队列', async t => {
  const { service, execution, message } = await fixture(t, 'owner')
  const received = await service.ingest(message), processed = await service.messages.process(received.runId)
  const original = processed.commands[0].result
  assert.equal(original.runId,null); (await settleTaskOwners(service, service.execution)).failures
  execution.controller.registerWorkflow({ id: 'catalog-noise', version: '1', nodes: [{
    id: 'pure', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '纯测试执行' }) }] })
  for (let i = 0; i < 201; i++) {
    const runId = `catalog-run-${i}`
    await execution.controller.createRun({ commandId: `catalog-create-${i}`, runId, taskId: `catalog-task-${i}`, workflowId: 'catalog-noise', input: {} })
    await execution.controller.whenIdle(runId)
  }
  assert.equal((await execution.store.query({ kind: 'run.list', limit: 200 })).some(run => run.taskId === original.taskId), false)
  assert.equal((await service.tasks()).length, 202)
  const board = await service.boardTasks()
  assert.equal(board.length, 1); assert.equal(board[0].taskId, original.taskId)
  assert.equal((await service.taskDetail(original.taskId)).executionCount, 1)
})


test('待澄清和待材料有各自状态及原因，真正失败仍为关联受阻',async t=>{
  const {service,message,execution}=await fixture(t,'owner');
  const received=await service.messages.receive({sourceKey:'projection',sourceVersion:1,actorId:'owner',conversationId:'g',body:message.text,context:{sourceMessageId:message.messageId}},{process:false});
  for(const [kind,status] of [['needs_clarification','waiting_clarification'],['needs_context','waiting_context']]){
    await execution.store.command({id:'wait-'+kind,kind:'message.wait',args:{runId:received.runId,unitId:'$',nodeId:'execute',request:{requestId:kind,kind,question:'请补充目标',permittedActors:['owner']}}});
    const mailbox=(await service.mailboxes()).messages.find(item=>item.runId===received.runId);
    assert.equal(mailbox.workflowStatus,status);assert.equal(mailbox.workflowStatusDetail,'请补充目标');
    await execution.store.command({id:'wake-'+kind,kind:'message.wake',args:{runId:received.runId,requestId:kind,actorId:'owner',eventId:kind,answer:'已补充'}});
  }
  await execution.store.command({id:'fail-status',kind:'message.attention',args:{runId:received.runId,reason:'recovery_exhausted'}});
  assert.equal((await service.mailboxes()).messages.find(item=>item.runId===received.runId).workflowStatus,'routing_blocked');
});

for (const intent of ['revise', 'reopen']) test(`${intent} 整批追加超过原32项仍在同Task原子保存需求和验收`, async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : { kind: 'intent', actions: [{ intent: input.text.startsWith('追加') ? intent : 'create', arguments: {
        objective: input.text, acceptanceCriteria: input.text.startsWith('追加') ? ['追加一', '追加二'] : Array.from({ length: 31 }, (_, i) => `条件${i}`),
      }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '建立验收边界任务' })
  const accepted = await service.messages.process(first.runId), taskId = accepted.commands[0].result.taskId
  assert.equal(accepted.commands[0].result.runId, null)
  await settleTaskOwners(service, service.execution)
  const before = await execution.controller.taskPlan(taskId)
  const second = await service.ingest({ ...message, messageId: 'overflow-addition', text: '追加两个条件' })
  const rejected = await service.messages.process(second.runId)
  assert.ok(rejected.commands[0], JSON.stringify(rejected))
  assert.equal(rejected.commands[0].status, 'applied')
  assert.equal(rejected.commands[0].args.taskId,taskId)
  assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRevision,before.task.requirementRevision+1)
  assert.equal((await execution.store.query({ kind: 'task.owner.acceptance', taskId })).length, 33)
})

test('明确查表和多阶段脚本交办保留来源原文，任务准入不等于生产批准', async t => {
  const body = '小小鹏，读取表格后写脚本，让小鹏审批。先执行两条，找原发送人验证通过再刷69条，不改行业审核记录。'
  const { service, message, execution } = await fixture(t, 'participant', undefined, { legacy: {
    getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小小鹏'] }),
    getGroup: id => ({ groupId: id, responsibility: '任务准入：明确交办可以准备材料', messages: [] }),
  } })
  const received = await service.ingest({ ...message, text: body })
  await service.messages.process(received.runId)
  const state = await service.state(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  const plan = await execution.controller.taskPlan(state.commands[0].args.taskId)
  const requirement = await execution.artifacts.read(plan.task.requirementRef)
  assert.equal(requirement.sourceInstructions[0].text, body)
  assert.equal(requirement.sourceInstructions[0].actorId, 'participant')
  assert.equal(requirement.authorization.ownerConfirmed, false)
  assert.deepEqual(plan.stages, [])
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
})

for (const actor of ['owner', 'participant']) test(`指向其他同事时不向所有者索要授权，明确转交才承接：${actor}`, async t => {
  const { service, message, execution } = await fixture(t, actor, undefined, { legacy: {
    getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['资料助理'] }),
    getGroup: id => ({ groupId: id, responsibility: '任务准入：明确交办可以创建任务', messages: [] }),
  } })
  const other = await service.ingest({ ...message, messageId: 'to-colleague', text: '@李辰 请处理这份文档' })
  await service.messages.process(other.runId)
  await service.flushNotifications()
  const state = await service.state(other.runId)
  assert.equal(state.commands.length, 0)
  assert.equal(state.requests.length, 0)
  assert.equal((await service.tasks()).length, 0)
  assert.deepEqual(await execution.store.query({ kind: 'message.notifications', runId: other.runId }), [])
  const forwarded = await service.ingest({ ...message, messageId: 'to-agent', text: '资料助理，请处理这份文档', quotedMessage: { messageId: 'to-colleague' } })
  await service.messages.process(forwarded.runId)
  assert.equal((await service.state(forwarded.runId)).commands[0].status, 'applied')
  assert.equal((await service.tasks()).length, 1)
})

test('同发送人精确引用已点名来源可续办，换人引用不继承创建权', async t => {
  const { service, message } = await fixture(t, 'participant', undefined, { legacy: {
    getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小小鹏'] }),
    getGroup: id => ({ groupId: id, responsibility: '任务准入：明确交办可以准备材料', messages: [] }),
  } })
  const first = await service.ingest({ ...message, messageId: 'direct', text: '小小鹏，整理本条材料' })
  await service.messages.process(first.runId)
  const follow = await service.ingest({ ...message, messageId: 'follow', text: '再整理这个独立交付物', quotedMessage: { messageId: 'direct' } })
  await service.messages.process(follow.runId)
  assert.equal((await service.state(follow.runId)).commands[0].status, 'applied')
  const other = await service.ingest({ ...message, messageId: 'other', senderOpenDingTalkId: 'outsider', text: '按他的授权创建另一个任务', quotedMessage: { messageId: 'direct' } })
  await service.messages.process(other.runId)
  const blocked=await service.state(other.runId)
  assert.equal(blocked.commands.length,0)
  assert.equal(blocked.requests[0].kind,'needs_authorization')
  assert.deepEqual(blocked.requests[0].permittedActors,['owner'])
  assert.equal((await service.tasks()).length,2)
})

test('历史缺附件消息只经独立DWS同源回读补元数据，不增版本不重放', async t => {
  const body = '[文件] 审核表.xlsx fileId: exact-file'
  let reads = 0
  const { service, execution } = await fixture(t, 'owner', undefined, { readMessage: async (groupId, messageId) => {
    reads++
    return { conversationId: groupId, messageId, senderOpenDingTalkId: 'owner', text: body,
      resourceRefs: [{ type: 'fileId', resourceId: 'exact-file', name: '审核表.xlsx' }] }
  } })
  const sourceKey = `dws:${executionDigest(['', 'g', 'old-file'])}`
  const initial = await service.messages.receive({ sourceKey, sourceVersion: 1, actorId: 'owner', conversationId: 'g', body,
    context: { sourceMessageId: 'old-file', attachments: [], quoteRefs: [] } }, { process: false })
  const before = await service.state(initial.runId)
  const received = await service.ingest({ groupId: 'g', messageId: 'old-file', text: body, senderOpenDingTalkId: 'owner' })
  const after = await service.state(initial.runId)
  assert.equal(received.duplicate, true)
  assert.equal(reads, 1)
  assert.equal(after.run.sourceVersion, before.run.sourceVersion)
  assert.equal(after.run.revision, before.run.revision)
  assert.equal(after.run.context.attachments[0].resourceRef, 'exact-file')
  assert.equal(after.commands.length, 0)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  await service.ingest({ groupId: 'g', messageId: 'old-file', text: body, senderOpenDingTalkId: 'owner' })
  assert.equal(reads, 1)
})

test('执行层材料等待可回读，恢复后同命令继续且不重复建Task',async t=>{
 let ready=false,remote
 const f=await fixture(t,'owner',undefined,{readMessage:async()=>remote,readResource:async()=>ready?{text:'完整表格内容'}:null,
 coordinatorSessions:coordinatorFixtureSessions(source=>{
  const d=coordinatorUnit(source,'research',{objective:'读取表格并分析'})
  d.units[0].intent.requiredExecutionMaterials=source.context.attachments.map(a=>a.resourceRef);return d
 })})
 remote={...f.message,conversationId:'g',text:'分析这个文件',resourceRefs:[{type:'fileId',resourceId:'file-material',name:'材料.xlsx'}]}
 const received=await f.service.ingest(remote)
 const waiting=await f.service.messages.process(received.runId)
 assert.equal(waiting.commands.length,1)
 assert.ok(waiting.requests.some(r=>r.nodeId==='execute'&&r.status==='pending'),JSON.stringify(waiting.requests))
 const commandId=waiting.commands[0].commandId
 assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,0)
 ready=true
 await f.service.messages.recover()
 const resumed=await f.service.messages.process(received.runId)
 assert.equal(resumed.commands[0].commandId,commandId)
 assert.equal(resumed.commands[0].status,'applied',JSON.stringify(resumed.requests))
 assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,1)
})

test('无引用回答通过合法待答候选语义选择恢复原请求，第三方看不到候选', async t => {
  let sawOwnCandidate = false, outsiderCandidates
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前来源'] }
    if (input.text === '查哪个表的审核状态') return { kind: 'needs_clarification', reason: 'BUSINESS_TABLE_UNKNOWN', question: '请给表名', needs: [] }
    const candidates = input.facts.clarificationRequests
    if (input.text === '就是审核条目表') {
      sawOwnCandidate = candidates.some(item => item.question === '请给表名')
      const request = candidates.find(item => item.question === '请给表名')
      return { kind: 'intent', actions: [{ intent: 'clarification', arguments: { runId: request.runId, requestId: request.requestId, answer: input.text }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    }
    if (input.text === '外人补充') outsiderCandidates = candidates
    return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, message } = await fixture(t, 'participant', undefined, { judge })
  const first = await service.ingest({ ...message, messageId: 'question', text: '查哪个表的审核状态' })
  await service.messages.process(first.runId)
  const pending = (await service.state(first.runId)).requests.find(item => item.status === 'pending')
  assert.ok(pending)
  const outsider = await service.ingest({ ...message, messageId: 'outsider-answer', text: '外人补充', senderOpenDingTalkId: 'outsider' })
  await service.messages.process(outsider.runId)
  assert.deepEqual(outsiderCandidates, [])
  const answer = await service.ingest({ ...message, messageId: 'answer-without-quote', text: '就是审核条目表' })
  await service.messages.process(answer.runId)
  assert.equal(sawOwnCandidate, true)
  const resolved = (await service.state(first.runId)).requests.find(item => item.id === pending.id)
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.answer, '就是审核条目表')
})

test('内部材料重试HTTP只由本机操作者恢复，保留原请求且真实读取失败不冒充ready', async t => {
  let reads = 0
  const { service, execution } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' }, coordinatorSessions:coordinatorFixtureSessions(source=>{const d=coordinatorUnit(source,'research',{objective:'读取文件'});d.units[0].intent.requiredExecutionMaterials=['retry-file'];return d}),
    readMessage: async () => ({ conversationId: 'g', messageId: 'retry-message', text: '读取这个文件', resourceRefs: [{ type: 'fileId', resourceId: 'retry-file' }] }),
    readResource: async () => { reads++; return null } })
  const source = await service.messages.receive({ sourceKey: 'retry-source', sourceVersion: 1, actorId: 'owner', conversationId: 'g', body: '读取这个文件',
    context: { sourceMessageId: 'retry-message', quoteRefs: [], attachments: [{ resourceRef: 'retry-file', source: { type: 'fileId', resourceId: 'retry-file' } }] } }, { process: false })
  const waiting=await service.messages.process(source.runId)
  const requestId=waiting.requests.find(r=>r.status==='pending').id
  await execution.store.command({ id: 'record-material-failure', kind: 'message.request.retry', args: { runId: source.runId, requestId, error: 'FILE_UNAVAILABLE', contractVersion: 'v1' } })
  const runtime = { retryWorkflowMaterialRequest: args => service.retryMaterialRequest(args, { channel: 'web', actorId: 'owner' }) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}/workflows/${source.runId}/requests/${requestId}/retry`
  const input = { sourceVersion: 1, reason: '已更新文件访问能力', dependencyRevision: 'reader-v2' }
  const post = (body, origin = 'http://127.0.0.1:3080') => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  assert.equal((await post(input, 'https://evil.invalid')).status, 403)
  assert.equal((await post({ ...input, actorId: 'owner' })).status, 400)
  await assert.rejects(service.retryMaterialRequest(input, { channel: 'web', actorId: 'other' }), /FORBIDDEN/)
  assert.equal((await post({ ...input, sourceVersion: 2 })).status, 409)
  const response = await post(input)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.request.id, requestId)
  assert.equal(result.request.status, 'pending')
  assert.equal(result.request.retryHistory.length, 1)
  assert.equal(result.request.attempts, 1)
  assert.equal(reads, 2)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  assert.equal((await post(input)).status, 409)
})

test('多事项执行要求按各自原文span保存，模型摘要不成为默认验收前提', async t => {
  const first = '删除生产Editor表的name列；', second = '整理本周报告', body = first + second
  const judge = async ({ stage, input }) => stage === 'S'
    ? { kind: 'split', units: [first, second].map((text, index) => ({ spans: [{ start: index ? first.length : 0, end: index ? body.length : first.length }], goalText: text, constraints: [], contextNeeds: [] })),
      sharedConstraints: [], coverage: [{ start: 0, end: first.length, role: 'unit' }, { start: first.length, end: body.length, role: 'unit' }] }
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['两个独立事项'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: input.goalText + '；先穷尽代码引用再处理' }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, message, execution } = await fixture(t, 'owner', undefined, { judge })
  const received = await service.ingest({ ...message, text: body })
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands.length, 2)
  for (const [index, command] of state.commands.entries()) {
    assert.equal(command.status, 'applied')
    const plan = await execution.controller.taskPlan(command.args.taskId), requirement = await execution.artifacts.read(plan.task.requirementRef)
    assert.equal(requirement.request, [first, second][index])
    assert.match(requirement.objective, /先穷尽代码引用/)
    assert.equal(requirement.sourceInstructions[0].text, body)
    const criteria = await execution.store.query({ kind: 'task.owner.acceptance', taskId: command.args.taskId })
    assert.deepEqual(criteria.map(item => item.criterion), ['完成当前事项原文要求的交付'])
    assert.equal(criteria[0].sourceKey, requirement.authorization.sourceKey)
  }
})

test('继续修订保存本次原文，不以摘要扩写覆盖原先真人确认条件', async t => {
  const first = '先测试两条，我验证通过再执行剩余数据', second = '继续'
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: input.candidates.length ? 'existing' : 'new', candidateId: input.candidates[0]?.candidateId ?? null, evidence: ['同一事项继续'] }
      : { kind: 'intent', actions: [{ intent: input.text === second ? 'revise' : 'create', arguments: {
        objective: input.text === second ? '先查询所有列数据再继续执行' : '执行分批变更',
        ...(input.text === first ? { stageAuthorizations: [{ workflowId: 'task-data-change', sourceQuote: first, objective: '执行剩余数据', gate: 'confirmation' }] } : {}) }, dependsOn: [] }],
        constraints: input.text === first ? ['我验证通过再执行剩余数据'] : [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, message, execution } = await fixture(t, 'owner', undefined, { judge })
  const started = await service.ingest({ ...message, text: first }), state = await service.messages.process(started.runId)
  const taskId = state.commands[0].args.taskId
  const continued = await service.ingest({ ...message, messageId: 'continue-original-gate', text: second })
  const revised = await service.messages.process(continued.runId)
  assert.equal(revised.commands[0].status, 'applied')
  assert.equal(revised.commands[0].args.taskId, taskId)
  const plan = await execution.controller.taskPlan(taskId), requirement = await execution.artifacts.read(plan.task.requirementRef)
  assert.equal(requirement.request, second)
  assert.equal(requirement.objective, '先查询所有列数据再继续执行')
  assert.deepEqual(requirement.sourceInstructions.map(source => source.text), [first, second])
  assert.ok(requirement.constraints.includes('我验证通过再执行剩余数据'))
  const authorization = requirement.stageAuthorizations.find(item => item.workflowId === 'task-data-change')
  assert.equal(authorization.gate, 'confirmation')
  assert.equal(authorization.requiredActorId, 'owner')
  assert.equal(authorization.sourceQuote, first)
  const criteria = await execution.store.query({ kind: 'task.owner.acceptance', taskId })
  assert.ok(criteria.every(item => !item.criterion.includes('查询所有列数据')))
  assert.ok(criteria.some(item => item.sourceKey === requirement.authorization.sourceKey))
})

test('原114与115连续交办复用同Task并保存审批与先两条后69条原文条件', async t => {
  const firstText = '线上，工作区。这批数据69条的行业专家审核记录和状态保留，LCA审核人改成Y列专家，已做完LCA审核的记录清掉。写完脚本，让小鹏哥审批，再线上执行工单。不改派单，不发业务通知，不改审核轮次。'
  const secondText = '线上脚本先用这两条测试：11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222。刷完找我验证，我验证通过，再刷这69条正式数据。'
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') {
      const target = input.candidates.find(item => item.taskId)
      return { kind: 'binding', disposition: target ? 'existing' : 'new', candidateId: target?.candidateId ?? null, evidence: ['同一批69条审核数据与当前脚本任务'] }
    }
    return { kind: 'intent', actions: [{ intent: input.text === secondText ? 'revise' : 'create',
      arguments: { objective: input.text === secondText ? firstText + '\n' + secondText : firstText,
        explicitStages: input.text === secondText ? [secondText] : [firstText],
        stageAuthorizations: [{ workflowId: 'task-data-change', sourceQuote: input.text, objective: input.text, gate: 'confirmation' }] }, dependsOn: [] }],
      constraints: ['行业审核记录和状态保留', '不改派单，不发业务通知，不改审核轮次', '生产执行需精确脚本审批'], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, message, execution } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, messageId: 'actual114', text: firstText })
  await service.messages.process(first.runId)
  const firstState = await service.state(first.runId)
  const taskId = firstState.commands.find(command => command.kind === 'create').args.taskId
  const next = await service.ingest({ ...message, messageId: 'actual115', text: secondText, quotedMessage: { messageId: 'actual114', content: firstText } })
  await service.messages.process(next.runId)
  const nextState = await service.state(next.runId)
  assert.equal(nextState.commands.find(command => command.kind === 'revise').args.taskId, taskId)
  assert.equal(nextState.commands.find(command => command.kind === 'revise').status, 'applied')
  const plan = await execution.controller.taskPlan(taskId)
  const requirement = await execution.artifacts.read(plan.task.requirementRef)
  assert.deepEqual(requirement.sourceInstructions.map(source => source.text), [firstText, secondText])
  assert.ok(requirement.explicitStages.includes(secondText))
  assert.deepEqual(plan.stages, [])
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  const origins = await execution.store.query({ kind: 'message.task-candidates', conversationId: 'g', limit: 200 })
  assert.equal(new Set(origins.map(item => item.command.args.taskId)).size, 1)
})

for (const proposedGate of ['none', 'confirmation']) test(`Owner不能删除I已落账的原发送人验证门槛：${proposedGate}`, async t => {
  let effects = 0, rejectedCode = null
  const forbidden = async () => { effects++; throw new Error('PRODUCTION_EFFECT_FORBIDDEN') }
  const dataChangeAdapter = { id: 'stage-gate-test', version: '1', rulesDigest: 'a'.repeat(64),
    validate: forbidden, prepareRehearsal: forbidden, readbackRehearsal: forbidden, inspect: forbidden,
    prepareIssue: forbidden, prepareApproval: forbidden, prepareExecute: forbidden, readback: forbidden }
  const body = '先核对测试结果并保存Markdown文档，我验证通过再刷69条正式数据'
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前明确请求'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, targetId: 'production-db',
        stageAuthorizations: [{ workflowId: 'task-data-change', sourceQuote: body, objective: '刷69条正式数据', gate: 'confirmation' }] }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const taskOwnerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const source = input.goal.sourceInstructions[0]
    const decision = { action: input.stages.some(stage => stage.workflowId === 'task-data-change') ? 'wait' : 'advance', summary: '按已登记条件处理', evidenceRefs: [],
      ...(!input.stages.some(stage => stage.workflowId === 'task-data-change') ? { appendStages: [
        { workflowId: 'task-data-change', gate: proposedGate, sourceCondition: { sourceKey: source.sourceKey, sourceVersion: source.sourceVersion,
          sourceQuote: body, objective: '刷69条正式数据', requiredActorId: source.actorId } },
      ] } : {}) }
    if (proposedGate !== 'confirmation') {
      await assert.rejects(onCandidate(decision), error => {
        rejectedCode = error.code; return error.code === 'TASK_OWNER_STAGE_NOT_AUTHORIZED'
      })
      const waiting = { action: 'wait', summary: '原发送人验证门槛仍保留', evidenceRefs: [], condition: {
        kind: 'approval', missing: '原发送人验证通过', responsibleParty: 'owner', resumeWhen: '原发送人明确确认测试结果后继续', evidenceRefs: [] } }
      await onCandidate(waiting); return { status: 'submitted', decision: waiting }
    }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await managedMarkdownFixture(t, undefined, { judge, taskOwnerSessions,
    external: { dataChangeAdapter, operationAdapter: { execute: forbidden, reconcile: forbidden }, authorizeExternal: forbidden, prepareRequirement: async ({ action }) => ({ request: action.arguments.objective, constraints: [], target: { instance: 'production', database: 'Editor', environment: 'production' }, sources: [{ id: 'source', content: 'SELECT 1', sha256: createHash('sha256').update('SELECT 1').digest('hex') }], baseline: { snapshotId: 'baseline', sha256: 'a'.repeat(64) } }) } })
  const received = await service.ingest({ ...message, text: body })
  await service.messages.process(received.runId)
  const command = (await service.state(received.runId)).commands[0]
  const goal = await execution.artifacts.read((await execution.controller.taskPlan(command.args.taskId)).task.requirementRef)
  await execution.controller.initializeTaskPlan({ commandId: 'source-verify-plan', taskId: command.args.taskId, expectedPlanRevision: 0,
    expectedRequirementRevision: 1, stages: [{ stageId: 'verify', workflowId: 'task-general-capability', input: {
      capabilityId: 'write-task-markdown', input: { content: '# 测试结果核对记录' }, scope: goal.scope, expectedEvidence: '文件独立读回' }, gate: 'none' }] })
  const started = await execution.controller.advanceTaskPlan(command.args.taskId)
  await execution.controller.whenIdle(started.stages[0].runId)
  await execution.controller.advanceTaskPlan(command.args.taskId)
  await settleTaskOwners(service, execution)
  const plan = await execution.controller.taskPlan(command.args.taskId)
  if (proposedGate !== 'confirmation') {
    assert.equal(plan.stages.length, 1)
    assert.equal(rejectedCode, 'TASK_OWNER_STAGE_NOT_AUTHORIZED')
    assert.equal((await execution.store.query({ kind: 'task.owner', taskId: command.args.taskId })).decision.action, 'wait')
  } else {
    assert.equal(plan.stages.length, 2, JSON.stringify(await execution.store.query({kind:'task.owner',taskId:command.args.taskId})))
    assert.equal(plan.stages[1].gate, 'confirmation')
    assert.equal(plan.stages[1].sourceCondition.requiredActorId, 'owner')
    assert.equal(plan.stages[1].runId, null)
  }
  assert.equal(effects, 0)
})

test('收信箱局部失败只显示受阻事项，独立事项不投影为同一故障', async t => {
  const { randomUUID } = await import('node:crypto')
  const { service, message, execution } = await fixture(t, 'owner')
  const received = await service.ingest({ ...message, text: '查A；查B' })
  const command = (kind, args) => execution.store.command({ id: randomUUID(), kind: `message.${kind}`, args })
  await command('split', { runId: received.runId, units: [{ unitId: 'u-a', goalText: '查A' }, { unitId: 'u-b', goalText: '查B' }] })
  await command('attention', { runId: received.runId, unitId: 'u-a', reason: 'MESSAGE_PROTOCOL_CORRECTION_EXHAUSTED:R:u-a' })
  const row = (await service.mailboxes()).messages.find(item => item.runId === received.runId)
  assert.equal(row.waiting.length, 1)
  assert.equal(row.waiting[0].unitId, 'u-a')
  assert.equal(row.waiting[0].goalText, '查A')
  assert.equal(row.waiting[0].responsibility, 'system')
  assert.match(row.waiting[0].recoveryCondition, /独立的其他事项可继续/)
})


for (const incomplete of [{complete:false},{hasMore:true},{failures:['正文页缺失']},{coverage:{complete:false}}]) test(`材料连接器返回部分正文不能伪装完整材料：${JSON.stringify(incomplete)}`, async t => {
 const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['独立附件']}:{kind:'intent',actions:[{intent:'research',arguments:{objective:'核对附件'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:['incomplete-file'],replyPolicy:'none'}
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,readResource:async()=>({text:'只有第一页',...incomplete})})
 const {runId}=await service.ingest({...message,text:'核对完整附件',resourceRefs:[{type:'fileId',resourceId:'incomplete-file'}]})
 const state=await service.messages.process(runId)
 assert.equal(state.commands.length,1);assert.equal(state.commands[0].status,'pending');assert.equal((await execution.store.query({kind:'run.list'})).length,0)
 assert.equal(state.requests.length,1)
 assert.equal(state.requests[0].status,'pending')
 assert.equal(await execution.store.query({kind:'message.material',runId,resourceRef:'incomplete-file'}),null)
})


test('群协调原生读取历史真实sourceKey，Task获得实际可读原文',async t=>{
 const original='前文材料：行业专家保留，先两条验证再69条正式数据。'
 const sourceKey=`dws:${executionDigest(['','g','source-before'])}`;let read=false
 const {service,execution,message}=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions(async(source,input,tools)=>{
  const evidence=await tools.find(t=>t.name==='group_coordinator_read_material').execute({runId:source.runId,resourceRef:sourceKey})
  assert.ok(JSON.stringify(evidence).includes(original));read=true
  const d=coordinatorUnit(source,'research',{objective:'依据前文形成调查交付'})
  d.units[0].intent.requiredExecutionMaterials=[sourceKey];return d
 }),legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[{messageId:'source-before',text:original,occurredAt:'2026-09-29T00:00:00Z'}]})}})
 const {runId}=await service.ingest({...message,text:'依据前文形成调查交付'})
 const state=await service.messages.process(runId);assert.equal(read,true)
 assert.equal(state.commands[0].result.runId,null)
 const plan=await execution.controller.taskPlan(state.commands[0].result.taskId)
 const input=await execution.artifacts.read(plan.task.requirementRef)
 assert.deepEqual(input.materials.find(item=>item.id===sourceKey),{id:sourceKey,text:original})
})

for(const failed of [false,true])test(`文件消息引用读取真实附件并拒用旧正文缓存：${failed?'系统等待':'进入执行材料'}`,async t=>{
 let fileKey,readCount=0
 const text='[文件] 审核.xlsx fileId: sheet-file',body='sheet:第一张; A2=dataset-1; Y2=expert@example.test'
 const judge=async({stage,input})=>{
  if(stage==='S') {if(input.source.text===text)return{kind:'no_action',reason:'文件材料',coverage:[{start:0,end:text.length}]};const out=splitOne(input.source.text);out.units[0].contextNeeds=[{resourceRef:'h1',reason:'读取工作簿'}];return out}
  if(stage==='R'){if(input.material)assert.match(input.material.resources[0].text,/Y2=expert/);return{kind:'binding',disposition:'new',candidateId:null,evidence:['明确工作簿核查']}}
  return{kind:'intent',actions:[{intent:'research',arguments:{objective:'核查工作簿'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[fileKey],replyPolicy:'none'}
 }
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,
  readMessage:async()=>({conversationId:'g',messageId:'sheet-source',text,resourceRefs:[{type:'fileId',resourceId:'sheet-file'}]}),
  readResource:async()=>{readCount++;if(failed)throw Error('connector_unavailable');return{text:body,complete:true}}})
 const file=await service.ingest({...message,messageId:'sheet-source',text,resourceRefs:[{type:'fileId',resourceId:'sheet-file'}]});await service.messages.process(file.runId)
 fileKey=(await execution.store.query({kind:'message.run',runId:file.runId})).run.sourceKey
 const request=await service.ingest({...message,messageId:'sheet-request',text:'核查工作簿'})
 await execution.store.command({id:'old-material-cache',kind:'message.material.record',args:{runId:request.runId,resourceRef:fileKey,material:{text}}})
 const state=await service.messages.process(request.runId)
 assert.ok(readCount>0,JSON.stringify({run:state.run,nodes:state.nodes.map(n=>({stage:n.nodeId,error:n.error})),requests:state.requests}))
 if(failed){assert.equal(state.commands.length,1);assert.equal(state.commands[0].status,'pending');assert.equal((await execution.store.query({kind:'run.list'})).length,0);assert.ok(state.requests.some(r=>r.kind==='needs_context'&&r.status==='pending'));return}
 assert.equal(state.run.status,'settled',JSON.stringify(state.run))
 assert.equal(state.commands[0].result.runId,null)
 const plan=await execution.controller.taskPlan(state.commands[0].result.taskId)
 const requirement=await execution.artifacts.read(plan.task.requirementRef)
 const actual=requirement.materials.find(item=>item.id===fileKey);assert.match(actual.text,/Y2=expert/);assert.ok(actual.text.includes(text))
 await settleTaskOwners(service, service.execution)
 const evidence=await execution.store.query({kind:'task.owner.query-evidence',taskId:state.commands[0].result.taskId})
 assert.equal(evidence.length,1)
 const query=await execution.artifacts.read(evidence[0].artifactRef)
 assert.ok(query.result.sources.some(source=>source.sourceKey===fileKey&&source.sourceVersion===1))
})

test('问答冻结附件精确范围与只读失败原命令续跑：不要求重发、不扩大普通历史',async t=>{
 const inputs=[],resourceReads=[];let attempts=0
 const fileText='[文件] 审核.xlsx fileId: selected-file'
 const readMessage=async(_group,messageId)=>({conversationId:'g',messageId,text:messageId==='provided-file'?fileText:'[文件] 无关失效.xlsx fileId: broken-file',resourceRefs:[{type:'fileId',resourceId:messageId==='provided-file'?'selected-file':'broken-file'}]})
 const readResource=async(_group,_message,ref)=>{resourceReads.push(ref.resourceId);if(ref.resourceId==='broken-file')throw Error('UNRELATED_FILE_UNAVAILABLE');return{text:'完整工作簿内容',complete:true}}
 const judge=async({stage,input})=>{
  if(stage==='S')return input.source.text.startsWith('[文件]')||input.source.text==='普通历史'?{kind:'no_action',reason:'资料',coverage:[{start:0,end:input.source.text.length}]}:splitOne(input.source.text)
  if(stage==='R')return{kind:'binding',disposition:'new',candidateId:null,evidence:['当前请求']}
  return{kind:'intent',actions:[{intent:'answer',arguments:{objective:'检查这批数据'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
 }
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},judge,
  readMessage,readResource,
  messageAgentSessions:{async run({input,onSessionBound,onResult}){
   inputs.push(input);await onSessionBound()
   const resource=input.context.readableMessageResources.find(item=>item.resourceId==='selected-file')
   const capability=createTaskMessageResourceCapability({store:execution.store,readMessage,readResource})
   const args={sourceKey:resource.sourceKey,type:resource.type,resourceId:resource.resourceId}
   assert.equal(await capability.authorize({input:{...args,sourceKey:input.source.sourceKey},scope:input.scope}),false)
   assert.equal(await capability.authorize({input:args,scope:input.scope}),true)
   assert.match((await capability.execute({input:args,scope:input.scope})).markdown,/完整工作簿内容/)
   if(++attempts===1)throw Object.assign(Error('execution_tool_failed'),{code:'execution_tool_failed'})
   await onResult({outcome:'completed',summary:'查询完成',evidenceRefs:[],limitations:[],question:''});return{status:'submitted'}
  },async cancel(){},async close(){}}})
 const file=await service.ingest({...message,messageId:'provided-file',text:fileText,resourceRefs:[{type:'fileId',resourceId:'selected-file'}]});await service.messages.process(file.runId)
 const fileRun=(await service.messages.state(file.runId)).run
 const ordinary=await service.ingest({...message,messageId:'ordinary-history',text:'普通历史'});await service.messages.process(ordinary.runId)
 const unrelated=await service.ingest({...message,messageId:'other-file',senderOpenDingTalkId:'other',text:'[文件] other.xlsx fileId: other-file',resourceRefs:[{type:'fileId',resourceId:'other-file'}]});await service.messages.process(unrelated.runId)
 const broken=await service.ingest({...message,messageId:'broken-file',text:'[文件] 无关失效.xlsx fileId: broken-file',resourceRefs:[{type:'fileId',resourceId:'broken-file'}]});await service.messages.process(broken.runId)
 const forbiddenKeys=await Promise.all([ordinary,unrelated].map(async item=>(await service.messages.state(item.runId)).run.sourceKey))
 const request=await service.ingest({...message,messageId:'question',text:'看看这批数据是否可行'})
 let state=await service.messages.process(request.runId)
 assert.equal(state.commands[0].result.reason,'execution_tool_failed')
 assert.ok(inputs[0].scope.sourceKeys.includes(fileRun.sourceKey))
 assert.ok(forbiddenKeys.every(key=>!inputs[0].scope.sourceKeys.includes(key)))
 assert.equal(inputs[0].materials.length,0,'可见附件按需读取，不把无关失效附件变为启动前必需材料')
 assert.deepEqual(inputs[0].context.readableMessageResources.find(item=>item.resourceId==='selected-file'),{sourceKey:fileRun.sourceKey,sourceVersion:1,type:'fileId',resourceId:'selected-file',name:''})
 assert.ok(inputs[0].context.readableMessageResources.some(item=>item.resourceId==='broken-file'))
 const commandId=state.commands[0].commandId,original=state.executions[0]
 const retry={runId:request.runId,commandId,sourceVersion:1,retryKey:'fixed-scope',reason:'已修复精确附件范围'}
 await assert.rejects(service.retryReadonlyAnswer(retry,{channel:'web',actorId:'other'}),/WORKFLOW_ACTION_FORBIDDEN/)
 await service.retryReadonlyAnswer(retry,{channel:'web',actorId:'owner'})
 state=await service.messages.process(request.runId)
 assert.equal(attempts,2);assert.equal(state.commands[0].result.status,'answered')
 assert.equal(state.executions[0].inputVersion,2);assert.notEqual(state.executions[0].sessionId,original.sessionId)
 assert.equal(state.executions[0].attemptHistory[0].status,'failed')
 assert.equal((await service.retryReadonlyAnswer(retry,{channel:'web',actorId:'owner'})).cached,true)
 assert.equal(attempts,2)
 assert.deepEqual(resourceReads,['selected-file','selected-file'])
})

test('同批群协调一个目标只建一Task，补充fact在首次Owner前完整落账',async t=>{
 const first='保留行业审核记录和状态，写脚本后由负责人审批，不改派单、不发业务通知、不改轮次。'
 const second='先执行两条测试数据，更换审核人为指定专家；我验证通过后再处理69条正式数据。'
 const fileText='[文件] 测试.sql fileId: provided-sql'
 const observed=[]
 const {service,execution,message}=await fixture(t,'owner',undefined,{readMessage:async(_group,messageId)=>({conversationId:'g',messageId,text:fileText,resourceRefs:[{type:'fileId',resourceId:'provided-sql',name:'测试.sql'}]}),readResource:async()=>({text:'SELECT 1; -- 已提供脚本',complete:true}),coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  assert.equal(input.sources.length,3)
  const primary=input.sources.find(item=>item.body===first)
  const d=coordinatorUnit(source,source.body===second?'create':'fact',source.body===second
   ?{objective:first+'\n'+second+'；调查当前生产只读证据及表结构',explicitStages:[second],stageAuthorizations:[{workflowId:'task-data-change',sourceQuote:second,objective:'处理69条正式数据',gate:'confirmation'}]}
   :{kind:source.body===fileText?'fact':'constraint',text:source.body},source.body!==first?{disposition:'conversation',candidateId:`source:${primary.runId}`}:{disposition:'new',candidateId:null})
  d.units[0].intent.constraints=[first,second]
  if(source.body===second)d.units[0].intent.requiredExecutionMaterials=['provided-sql']
  return d
 }),taskOwnerSessions:{async run({input,onSessionBound,onCandidate}){
  observed.push(input);assert.equal(input.goal.sourceInstructions.length,3)
  assert.deepEqual(new Set(input.goal.sourceInstructions.map(item=>item.text)),new Set([first,second,fileText]))
  assert.ok(input.goal.constraints.includes(first));assert.ok(input.goal.constraints.includes(second))
  const auth=input.goal.stageAuthorizations.find(item=>item.gate==='confirmation')
  assert.equal(auth.sourceQuote,second);assert.equal(auth.requiredActorId,'owner')
  await onSessionBound();const decision={action:'wait',summary:'保持只读分析，不执行生产阶段',evidenceRefs:[],condition:{kind:'approval',missing:'生产阶段批准',responsibleParty:'交办人',resumeWhen:'生产阶段明确授权后评估',evidenceRefs:[]}};await onCandidate(decision);return{status:'submitted',decision}
 },async close(){}}})
 const receive=async(id,body)=>{await service.messages.receive({sourceKey:`batch:${id}`,sourceVersion:1,conversationId:'g',actorId:'owner',body,context:{sourceMessageId:id}},{process:false});return service.messages.receive({sourceKey:`batch:${id}`,sourceVersion:2,conversationId:'g',actorId:'owner',body,context:{sourceMessageId:id}},{process:false})}
 const a=await receive('primary',first)
 await service.messages.receive({sourceKey:'batch:file',sourceVersion:1,conversationId:'g',actorId:'owner',body:fileText},{process:false})
 const file=await service.messages.receive({sourceKey:'batch:file',sourceVersion:2,conversationId:'g',actorId:'owner',body:fileText,context:{sourceMessageId:'file',attachments:[{resourceRef:'provided-sql',fileId:'provided-sql',sourceMessageId:'file',sourceVersion:2,state:'pending',source:{type:'fileId',resourceId:'provided-sql',name:'测试.sql'}}]}},{process:false})
 const b=await receive('supplement',second)
 await service.messages.process(a.runId);await service.messages.process(b.runId)
 await settleTaskOwners(service, service.execution)
 const states=await Promise.all([a,file,b].map(item=>service.messages.state(item.runId)))
 assert.ok(states.every(state=>state.barriers.filter(b=>b.reason==='source_edit').every(b=>b.status==='resolved')))
 const commands=states.flatMap(item=>item.commands)
 assert.equal(commands.filter(item=>item.kind==='create').length,1,JSON.stringify(states.map(s=>({run:s.run,requests:s.requests,nodes:s.nodes.map(n=>({stage:n.nodeId,error:n.error,output:n.output?.output}))}))))
 assert.equal(commands.filter(item=>item.kind==='fact').length,2)
 assert.equal(commands.filter(item=>item.kind==='revise').length,0)
 assert.ok(observed.length>0)
 const taskId=commands.find(item=>item.kind==='create').args.taskId
 const plan=await execution.controller.taskPlan(taskId)
 assert.equal(plan.stages.length,0)
 const requirement=await execution.artifacts.read(plan.task.requirementRef)
 assert.ok(requirement.sourceInstructions.some(source=>source.sourceKey==='batch:file'))
 assert.ok(requirement.materials.some(material=>material.text?.includes('SELECT 1;')))
})

test('无run的退避Owner可显式恢复且精确幂等，不改原需求与session', async t => {
 let failOwner = true
 const sessions = { async run({ onSessionBound, onCandidate }) {
   await onSessionBound()
   if (failOwner) return { status: 'no_submission' }
   const decision = { action: 'wait', summary: '系统修复完成，保留原任务继续核对', evidenceRefs: [], condition: { kind: 'execution', missing: '核对结果', responsibleParty: '执行方', resumeWhen: '完成核对后评估', evidenceRefs: [] } }
   await onCandidate(decision); return { status: 'submitted', decision }
 }, async close() {} }
 const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' }, taskOwnerSessions: sessions })
 const source = await service.ingest(message)
 const processed = await service.messages.process(source.runId)
 const taskId = processed.commands.find(c => c.kind === 'create').result.taskId
 for (let i = 0; i < 3; i++) await settleTaskOwners(service, service.execution)
 const owner = await execution.store.query({ kind: 'task.owner', taskId })
 assert.equal(owner.status, 'pending')
 assert.equal(owner.failureCount,1)
 assert.ok(Date.parse(owner.retryAt)>Date.now())
 const plan = await execution.controller.taskPlan(taskId)
 assert.equal(plan.stages.length, 0)
 const request = { taskId, retryKey: 'reference-contract-fixed', reason: '引用错误反馈修复完成',
   expectedOwnerRevision: owner.revision, expectedLeaseEpoch: owner.leaseEpoch,
   expectedRequirementRevision: owner.requirementRevision, expectedControlRevision: owner.controlRevision, expectedLastFailure: owner.lastFailure }
 await assert.rejects(service.retryOwner(request, { channel: 'web', actorId: 'other' }), /WORKFLOW_ACTION_FORBIDDEN/u)
 await assert.rejects(service.retryOwner({ ...request, expectedOwnerRevision: owner.revision - 1 }, { channel: 'web', actorId: 'owner' }), /TASK_OWNER_RETRY_STALE/u)
 failOwner = false
 const result = await service.retryOwner(request, { channel: 'web', actorId: 'owner' })
 assert.equal(result.status, 'pending')
 assert.deepEqual(await service.retryOwner(request, { channel: 'web', actorId: 'owner' }), result)
 await assert.rejects(service.retryOwner({ ...request, reason: 'different' }, { channel: 'web', actorId: 'owner' }), /COMMAND_ID_CONFLICT/u)
 await settleTaskOwners(service, service.execution)
 const after = await execution.store.query({ kind: 'task.owner', taskId })
 assert.equal(after.sessionId, owner.sessionId); assert.equal(after.failureCount, 0)
 assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRef, plan.task.requirementRef)
 const events = await execution.store.query({ kind: 'task.owner.events', taskId, limit: 200 })
 const recovery = events.filter(e => e.eventType === 'system.recovery')
 assert.equal(recovery.length, 1)
 assert.equal((await execution.artifacts.read(recovery[0].payloadRef)).reason, request.reason)
})

test('直接调查参数错误在同一Owner轮纠正，成功证据入账且无调查Run', async t => {
  let turns = 0
  const sessions = { async close() {}, async run(args) {
    const { binding, input, tools, queryInput, onSessionBound, onCandidate } = args
    await onSessionBound(); turns++
    const tool = tools.find(item => item.name === 'read-topic-sources')
    await assert.rejects(tool.execute({ binding, input: queryInput, args: { sourceKeys: 'invalid' } }), { code: 'QUERY_ARGUMENT_INVALID' })
    await assert.rejects(tool.execute({ binding, input: queryInput, args: { sourceKeys: ['unrelated-source'] } }), { code: 'QUERY_SCOPE_DENIED' })
    const evidenceRefs = await queryOwnerSources(args)
    const decision = { action: 'complete', summary: '纠正参数后核对原文', evidenceRefs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const accepted = await service.ingest(message), state = await service.messages.process(accepted.runId)
  const taskId = state.commands[0].result.taskId
  await settleTaskOwners(service, service.execution)
  assert.equal(turns,1)
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
  const owner = await execution.store.query({kind:'task.owner',taskId})
  assert.equal(owner.decision.action,'complete'); assert.equal(owner.failureCount,0)
  assert.equal((await execution.store.query({kind:'task.owner.query-evidence',taskId})).length,1)
})

test('直接Task附件scope仅纳入已证明材料，拒绝无关附件和旧会话读取', async t => {
  let fileKey, originalQuery, originalTool; const reads = []
  const judge = async ({stage,input}) => stage === 'S' ? (input.source.text.startsWith('[文件]')
    ? {kind:'no_action',reason:'附件',coverage:[{start:0,end:input.source.text.length}]} : splitOne(input.source.text))
    : stage === 'R' ? {kind:'binding',disposition:'new',candidateId:null,evidence:['独立调查']}
    : {kind:'intent',actions:[{intent:'create',arguments:{objective:'核对指定表格'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[fileKey],replyPolicy:'none'}
  const sessions = { async close() {}, async run(args) {
    const {binding,queryInput,tools,onSessionBound,onQueryEvidence,onCandidate} = args
    await onSessionBound(); originalQuery = {binding,input:queryInput}
    assert.ok(queryInput.scope.sourceKeys.includes(fileKey))
    assert.deepEqual(queryInput.context.readableMessageResources.map(item=>item.resourceId),['chosen'])
    const tool = tools.find(item=>item.name==='read-task-message-resource'); originalTool=tool
    await assert.rejects(tool.execute({...originalQuery,args:{sourceKey:fileKey,type:'fileId',resourceId:'other'}}),{code:'QUERY_SCOPE_DENIED'})
    const result = await tool.execute({...originalQuery,args:{sourceKey:fileKey,type:'fileId',resourceId:'chosen'}})
    await onQueryEvidence({binding:Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key=>[key,binding[key]])),evidenceRef:result.evidenceRef})
    const refs = [result.evidenceRef]
    const decision = {action:'wait',summary:'材料已核对，尚待业务选择',evidenceRefs:refs,
      condition:{kind:'business-input',missing:'业务选择',responsibleParty:'交办人',resumeWhen:'确认后继续',evidenceRefs:refs}}
    await onCandidate(decision); return {status:'submitted',decision}
  } }
  const {service,execution,message} = await fixture(t,'owner',undefined,{judge,taskOwnerSessions:sessions,
    readMessage:async(_group,messageId)=>({conversationId:'g',messageId,text:'[文件] 已选.xlsx fileId: chosen',resourceRefs:[{type:'fileId',resourceId:'chosen'}]}),
    readResource:async(_group,_message,ref)=>{reads.push(ref.resourceId);return{text:'完整表格',complete:true}}})
  const unrelated = await service.ingest({...message,messageId:'unrelated',text:'[文件] 无关.xlsx fileId: other',resourceRefs:[{type:'fileId',resourceId:'other'}]})
  await service.messages.process(unrelated.runId)
  const fileMessage = {...message,messageId:'selected',text:'[文件] 已选.xlsx fileId: chosen',resourceRefs:[{type:'fileId',resourceId:'chosen'}]}
  const file = await service.ingest(fileMessage); await service.messages.process(file.runId); fileKey=(await service.state(file.runId)).run.sourceKey
  const request = await service.ingest({...message,messageId:'task',text:'核对指定表格'}), state=await service.messages.process(request.runId)
  const taskId=state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  assert.ok(reads.length>=2); assert.deepEqual([...new Set(reads)],['chosen'])
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
  assert.ok(!originalQuery.input.scope.sourceKeys.includes((await service.state(unrelated.runId)).run.sourceKey))
  await service.ingest({...fileMessage,messageVersion:2,text:'[文件] 已编辑.xlsx fileId: chosen'})
  await assert.rejects(originalTool.execute({...originalQuery,args:{sourceKey:fileKey,type:'fileId',resourceId:'chosen'}}),{code:'QUERY_SCOPE_DENIED'})
  assert.equal((await execution.store.query({kind:'task.owner',taskId})).decision.action,'wait')
})

for (const projected of [false, true]) test(`文档链接进入原Task只读范围并记录正文证据：附件投影=${projected}`, async t => {
  const body = '规则文档 https://alidocs.dingtalk.com/i/nodes/linkedDoc?from=chat'
  let readCount = 0, turns = 0
  const f = await fixture(t, 'owner', undefined, {
    readMessage: async (_group, messageId) => ({ conversationId: 'g', messageId, text: body }),
    readResource: async () => { readCount++; return { text: '章节一：导入规则\n|列|规则|\n|a|保留|', complete: true } },
    coordinatorSessions: coordinatorFixtureSessions((source, input) => {
      const request = input.sources.find(item => item.body === '按文档调查')
      const primary = source.runId === request.runId
      return coordinatorUnit(source, primary ? 'research' : 'fact', primary ? { objective: '按文档调查' } : { kind: 'fact', text: source.body },
        primary ? { disposition: 'new', candidateId: null } : { disposition: 'conversation', candidateId: `source:${request.runId}` })
    }),
    taskOwnerSessions: { async close() {}, async run({ binding, queryInput, tools, onSessionBound, onQueryEvidence, onCandidate }) {
      await onSessionBound(); turns++
      const resource = queryInput.context.readableMessageResources.find(item => item.type === 'dingtalkDoc')
      assert.deepEqual(resource, { sourceKey: 'legacy-doc', sourceVersion: 1, type: 'dingtalkDoc', resourceId: 'linkedDoc', name: '' })
      const result = await tools.find(tool => tool.name === 'read-task-message-resource').execute({ binding, input: queryInput,
        args: { sourceKey: resource.sourceKey, type: resource.type, resourceId: resource.resourceId } })
      await onQueryEvidence({ binding: Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key,binding[key]])), evidenceRef: result.evidenceRef })
      const refs = [result.evidenceRef]
      await onCandidate({ action: 'wait', summary: '正文已读取，等待业务选择', evidenceRefs: refs,
        condition: { kind: 'business-input', missing: '业务选择', responsibleParty: '交办人', resumeWhen: '选择后继续', evidenceRefs: refs } })
      return { status: 'submitted' }
    } }
  })
  await f.service.messages.receive({ sourceKey: 'legacy-doc', sourceVersion: 1, conversationId: 'g', actorId: 'owner', body,
    context: { sourceMessageId: 'doc-message', attachments: projected ? [{ resourceRef: 'linkedDoc', sourceMessageId: 'doc-message',
      sourceVersion: 1, state: 'pending', source: { type: 'dingtalkDoc', resourceId: 'linkedDoc' } }] : [] } }, { process: false })
  const received = await f.service.messages.receive({ sourceKey: 'doc-request', sourceVersion: 1, conversationId: 'g', actorId: 'owner', body: '按文档调查',
    context: { sourceMessageId: 'request' } }, { process: false })
  const state = await f.service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(readCount, 0, '文档读取由Owner推进，不因链接被自动升级为Task准入门禁')
  const taskId = state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(f.service, f.execution)).failures, [])
  assert.equal(turns, 1); assert.equal(readCount, 2)
  assert.equal((await f.execution.store.query({ kind: 'task.owner.query-evidence', taskId })).length, 1)
  assert.equal((await f.execution.store.query({ kind: 'task.source', sourceKey: 'legacy-doc' })).context.attachments.length, projected ? 1 : 0)
})

test('旧已排队外部workflowId简写不能绕过完整授权新建Task', async t => {
  const { service, execution } = await fixture(t, 'owner')
  const runId = 'queued-external-shorthand', unitId = 'old-unit', commandId = 'old-external-create'
  const command = (kind, args) => execution.store.command({ id: `queued-external:${kind}`, kind: `message.${kind}`, args })
  await command('receive', { runId, sourceKey: runId, sourceVersion: 1, actorId: 'owner', conversationId: 'g', body: '生产表新增is_deleted默认0', context: {}, policy: { initialWindowMs: 45000 } })
  await command('split', { runId, units: [{ unitId }] })
  await command('accept', { runId, unitId, commands: [{ commandId, kind: 'create', args: { taskId: 'queued-malformed-task', arguments: { objective: '生产表新增is_deleted默认0', workflowId: 'task-data-change' }, binding: { disposition: 'new' }, replyPolicy: 'none' }, dependsOn: [] }] })
  await service.messages.process(runId)
  const state = await service.state(runId)
  assert.equal(state.commands[0].status, 'unknown')
  assert.match(state.commands[0].error, /TASK_STAGE_AUTHORIZATION_SOURCE_INVALID/)
  assert.equal(await execution.controller.taskPlan('queued-malformed-task'), null)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

for (const invalidFirstProposal of [false, true, 'preconditions']) test(`新生产加列完整原文授权经Owner直接建单进入插件待审且不执行SQL：恢复空候选=${invalidFirstProposal}`, async t => {
  let hostExecution, proposals = 0, repairedRunId, validations = 0
  const body = '小小鹏，生产环境的editor数据库的process_id_temp表要新增is_deleted列，默认值0'
  const applySql = 'ALTER TABLE public.process_id_temp ADD COLUMN is_deleted integer DEFAULT 0;'
  const target = { instance: 'prod', database: 'editor', environment: 'production' }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const sends = [], issue = { id: 'projects/test/issues/1', planId: 'plan-1' }, sheet = { id: 'sheet-1', sha256: sha(applySql), target }, plan = { id: 'plan-1', sheetId: 'sheet-1' }
  const forbidden = async () => { throw Error('PRODUCTION_EXECUTION_FORBIDDEN') }
  const adapter = { id: 'owner-add-column', version: '1', rulesDigest: sha('owner-add-column'), pluginApproval: true,
    requiresRehearsal: () => false, validateExistingIssue: forbidden,
    readBaselineForCandidate: async () => ({ snapshotId: 'current-columns', sha256: sha('id-only') }),
    validate: async args => {
      if (invalidFirstProposal === 'preconditions' && validations++ === 0) throw Object.assign(Error('整型默认常量旧预检不支持'), { code: 'BYTEBASE_PRECONDITIONS_UNCONFIRMED' })
      return { passed: true, packageDigest: args.packageDigest, receiptId: 'validated-current-sql' }
    },
    prepareRehearsal: forbidden, readbackRehearsal: forbidden,
    prepareIssue: async () => ({ sheetSha256: sha(applySql) }),
    readback: async args => { assert.equal(args.stage, 'create-issue'); return { issue, sheet, plan } },
    prepareApproval: async () => ({ issueId: issue.id, planId: plan.id, sheetId: sheet.id, scopeDigest: sha('scope'), operationKey: sha('approval') }),
    inspect: async args => { assert.equal(args.stage, 'approval-state'); return { decision: 'pending' } },
    prepareExecute: forbidden }
  const operationAdapter = { execute: async prepared => { sends.push(prepared.stage); assert.equal(prepared.stage, 'create-issue'); return { status: 'succeeded', result: { issueId: issue.id } } }, reconcile: forbidden }
  const authorizeExternal = async ({ prepared }) => prepared.stage === 'approval-gate'
    ? { principalId: 'owner', approval: { requestId: 'current-add-is-deleted-approval', approverIds: ['owner'] } }
    : { principalId: 'owner', authorizationRef: 'current-source-create-issue' }
  const sourceAuthorization = { workflowId: 'task-data-change', sourceQuote: body, objective: body, gate: 'none' }
  const intent = { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, targetId: 'production-db', stageAuthorizations: [sourceAuthorization] }, dependsOn: [] }], constraints: ['执行前须本次插件真人批准'], requiredExecutionMaterials: [], replyPolicy: 'none' }
  assert.equal(messageSchemas.I.safeParse(intent).success, true)
  const ownerSessions = { async run({ input, binding, tools, queryInput, onQueryEvidence, readArtifact, onSessionBound, onCandidate }) {
    await onSessionBound()
    if (input.currentExecution?.repairable) {
      for (const ref of input.currentExecution.evidenceRefs) await readArtifact(ref)
      const decision = { action: 'repairCurrentStage', summary: '当前public.process_id_temp已有id，结合本轮查询明确schema为public；重新生成is_deleted integer DEFAULT 0和完整目录回查，不重复空SQL', evidenceRefs: input.currentExecution.evidenceRefs, repair: input.currentExecution.repairBinding }
      repairedRunId = input.currentExecution.runId
      if (!input.queryEvidence.length) {
        await assert.rejects(onCandidate(decision), error => error.code === 'TASK_OWNER_STAGE_NOT_AUTHORIZED' && error.message.includes('查询'))
        decision.evidenceRefs = [...decision.evidenceRefs, ...await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })]
      } else {
        for (const item of input.queryEvidence) { await readArtifact(item.artifactRef); decision.evidenceRefs.push(item.artifactRef) }
      }
      await onCandidate(decision); return { status: 'submitted', decision }
    }
    if (invalidFirstProposal && !input.stages.length) { const decision = { action: 'wait', summary: '保留既有原文目标', evidenceRefs: [], condition: { kind: 'execution', missing: '历史冻结候选阶段待恢复', responsibleParty: '执行会话', resumeWhen: '读取当前Run并受管修复', evidenceRefs: [] } }; await onCandidate(decision); return { status: 'submitted', decision } }
    const auth = input.goal.stageAuthorizations[0]
    const { workflowId, gate, ...sourceCondition } = auth
    const decision = input.stages.length ? { action: 'wait', summary: '等待本次插件审批', evidenceRefs: [], condition: { kind: 'approval', missing: '本次SQL插件真人批准', responsibleParty: 'owner', resumeWhen: '真人批准本次精确SQL', evidenceRefs: [] } }
      : { action: 'advance', summary: '新增integer列DEFAULT 0作为明确候选送审', evidenceRefs: [], planChange: { kind: 'initialize', stages: [{ workflowId, gate, sourceCondition }] } }
    if (!input.stages.length) {
      await assert.rejects(onCandidate({ ...decision, planChange: { kind: 'initialize', stages: [{ workflowId, gate, sourceCondition: { ...sourceCondition, objective: applySql } }] } }), error => error.code === 'TASK_OWNER_STAGE_NOT_AUTHORIZED' && error.message.includes('sourceCondition.objective'))
      await assert.rejects(onCandidate(decision), error => error.code === 'TASK_OWNER_STAGE_NOT_AUTHORIZED' && error.message.includes('查询证据'))
      decision.evidenceRefs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text) : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['本次原文'] } : intent,
    taskOwnerSessions: ownerSessions,
    executionSessions: { async run({ input, onSessionBound, onResult }) { await onSessionBound(); proposals++; if (invalidFirstProposal === true && proposals === 1) { await onResult({ applySql: '', rollbackSql: '未确定schema，不执行', verificationSql: '', expectedChange: '{"rows":[]}' }); return { status: 'submitted' } } if (invalidFirstProposal && proposals > 1) assert.ok(input.sources.some(source => source.content.includes('verified-task-query'))); await onResult({ applySql, rollbackSql: 'ALTER TABLE public.process_id_temp DROP COLUMN is_deleted;', verificationSql: 'SELECT column_default FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=\'process_id_temp\' AND column_name=\'is_deleted\';', expectedChange: '{"rows":[{"column_default":"0"}]}' }); return { status: 'submitted' } }, async cancel() {}, async close() {} },
    deliveryOptions: { authorize: async () => ({ principalId: 'owner', authorizationRef: 'source' }), externalAdapter: operationAdapter, authorizeExternal },
    external: { dataChangeAdapter: adapter, operationAdapter, authorizeExternal, availableTargets: [{ workflowId: 'task-data-change', targetId: 'production-db' }], prepareRequirement: async ({ taskContext }) => { if (!taskContext.queryEvidence.length) throw Object.assign(Error('当前需求缺少查询证据，请先只读查询'), { code: 'TASK_OWNER_STAGE_NOT_AUTHORIZED' }); const sources = [{ id: 'current-request', content: body, sha256: sha(body) }]; for (const proof of taskContext.queryEvidence) { const artifact = await hostExecution.artifacts.read(proof.artifactRef), content = JSON.stringify({ kind: 'verified-task-query', capabilityId: artifact.capabilityId, result: artifact.result }); sources.push({ id: proof.artifactRef, content, sha256: sha(content) }) } return { request: body, constraints: ['插件真人批准后执行'], target, sources } } } })
  hostExecution = execution
  const received = await service.ingest({ ...message, text: body }), state = await service.messages.process(received.runId)
  const taskId = state.commands[0].result.taskId
  if (invalidFirstProposal) {
    await settleTaskOwners(service, execution)
    await execution.controller.initializeTaskPlan({ commandId: 'restore-old-v7-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1, stages: [{ stageId: 'stage-1', workflowId: 'task-data-change', gate: 'none', input: { request: body, constraints: ['插件真人批准后执行'], target, sources: [{ id: 'current-request', content: body, sha256: sha(body) }] } }] })
    const frozen = await execution.controller.advanceTaskPlan(taskId)
    await execution.controller.whenIdle(frozen.stages[0].runId)
  }
  assert.deepEqual((await settleTaskOwners(service, execution)).failures, [])
  const saved = await execution.controller.taskPlan(taskId)
  assert.equal(saved.stages.length, 1); assert.equal(saved.stages[0].workflowId, 'task-data-change')
  let run = await execution.controller.whenIdle(saved.stages[0].runId)
  if (invalidFirstProposal) { await settleTaskOwners(service, execution); run = await execution.controller.whenIdle(saved.stages[0].runId) }
  assert.equal(run.nodes.find(node => node.nodeId === 'approval-gate').waitReason?.reference, 'PLUGIN_APPROVAL_PENDING', JSON.stringify({ owner: await execution.store.query({ kind: 'task.owner', taskId }), generation: run.run.generation, status: run.run.status, waiting: run.nodes.filter(node => ['waiting', 'failed'].includes(node.status)).map(node => ({ id: node.nodeId, reason: node.waitReason })) }))
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId: 'current-add-is-deleted-approval' })).decision, 'pending')
  assert.deepEqual(sends, ['create-issue'])
  assert.equal(run.run.generation, invalidFirstProposal ? 2 : 1)
  assert.equal(proposals, invalidFirstProposal ? 2 : 1)
  if (invalidFirstProposal) assert.equal(saved.stages[0].runId, repairedRunId)
  assert.equal((await execution.artifacts.read(saved.task.requirementRef)).stageAuthorizations[0].objective, body)
})

test('受管授权投影修复只更新既有原文授权并保留Task和旧要求审计', async t => {
 const body='线上先执行这两条，刷完找我验证，我验证通过，再刷这69条正式数据'
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},
  judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['当前来源']}:
   {kind:'intent',actions:[{intent:'create',arguments:{objective:body,stageAuthorizations:[{workflowId:'task-data-change',sourceQuote:body,objective:body,gate:'confirmation'}]},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'},
  taskOwnerSessions:{async run({onSessionBound,onCandidate}){await onSessionBound();const decision={action:'wait',summary:'等待系统修复',evidenceRefs:[],condition:{kind:'capability',missing:'系统读取能力',responsibleParty:'维护方',resumeWhen:'能力修复后评估',evidenceRefs:[]}};await onCandidate(decision);return{status:'submitted',decision}},async close(){}}})
 const received=await service.ingest({...message,text:body});const state=await service.messages.process(received.runId)
 const taskId=state.commands.find(c=>c.kind==='create').args.taskId
 const before=await execution.controller.taskPlan(taskId),original=await execution.artifacts.read(before.task.requirementRef)
 const source=original.sourceInstructions[0]
 const request={taskId,repairKey:'projection-1',reason:'修复原消息结构化授权遗漏',expectedRequirementRevision:before.task.requirementRevision,expectedRequirementRef:before.task.requirementRef,
  stageAuthorizations:[{workflowId:'task-data-change',sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:'线上先执行这两条，刷完找我验证',objective:'线上先执行这两条',gate:'none'},
   {workflowId:'task-data-change',sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:'我验证通过，再刷这69条正式数据',objective:'刷这69条正式数据',gate:'confirmation'}]}
 await assert.rejects(service.repairStageAuthorizations(request,{channel:'web',actorId:'other'}),/FORBIDDEN/)
 await assert.rejects(service.repairStageAuthorizations({...request,expectedRequirementRevision:99},{channel:'web',actorId:'owner'}),/STALE/)
 await assert.rejects(service.repairStageAuthorizations({...request,stageAuthorizations:[{...request.stageAuthorizations[0],objective:'执行全库'}]},{channel:'web',actorId:'owner'}),/SOURCE_INVALID/)
 const result=await service.repairStageAuthorizations(request,{channel:'web',actorId:'owner'})
 assert.deepEqual(await service.repairStageAuthorizations(request,{channel:'web',actorId:'owner'}),result)
 await assert.rejects(service.repairStageAuthorizations({...request,reason:'different'},{channel:'web',actorId:'owner'}),/CONFLICT/)
 const after=await execution.controller.taskPlan(taskId),next=await execution.artifacts.read(after.task.requirementRef)
 assert.equal(after.task.requirementRevision,before.task.requirementRevision+1)
 assert.deepEqual({...next,stageAuthorizations:original.stageAuthorizations},original)
 assert.equal(next.stageAuthorizations[1].requiredActorId,'owner')
 assert.deepEqual(after.stages,before.stages)
 assert.deepEqual(await execution.artifacts.read(before.task.requirementRef),original)
 const events=await execution.store.query({kind:'task.owner.events',taskId,afterSequenceId:0,limit:200})
 assert.ok(JSON.stringify(events).includes('authorization.projection.repaired'))
 const repairEvent=events.find(e=>e.eventType==='authorization.projection.repaired')
 const audit=await execution.artifacts.read(repairEvent.payloadRef)
 assert.equal(audit.oldRef,before.task.requirementRef);assert.equal(audit.newRef,after.task.requirementRef)
 for(const [field,value] of [['bodyDigest','f'.repeat(64)],['sourceVersion',99],['actorId','other']]) {
  await assert.rejects(execution.store.command({id:'stale-source-'+field,kind:'task.authorization.repair',args:{taskId,
   expectedRequirementRevision:after.task.requirementRevision,expectedRequirementRef:after.task.requirementRef,requirementRef:before.task.requirementRef,
   eventKey:'stale-source-'+field,payloadRef:repairEvent.payloadRef,requestDigest:'a'.repeat(64),sources:audit.sources.map(source=>({...source,[field]:value}))}}),/SOURCE_STALE/)
 }
 await execution.store.command({id:'unsafe-plan',kind:'task.plan.initialize',args:{taskId,expectedPlanRevision:0,expectedRequirementRevision:after.task.requirementRevision,expectedControlRevision:after.task.controlRevision,
  stages:[{stageId:'external',workflowId:'task-data-change',workflowDigest:'a'.repeat(64),unavailableReason:null,requirementRef:after.task.requirementRef,gate:'none'}]}})
 await assert.rejects(service.repairStageAuthorizations({...request,repairKey:'unsafe',expectedRequirementRevision:after.task.requirementRevision,expectedRequirementRef:after.task.requirementRef},{channel:'web',actorId:'owner'}),/NOT_DRAINED/)
 const last=await execution.controller.taskPlan(taskId);assert.equal(last.task.requirementRef,after.task.requirementRef)
})

test('授权投影修复后同Task同Owner按新需求查询，旧证据不可用于新版本', async t => {
  const body='线上先执行这两条，刷完找我验证，我验证通过，再刷这69条正式数据'
  const observed=[]
  const sessions={async close(){},async run(args){
    const {input,binding,readArtifact,onSessionBound,onCandidate}=args
    await onSessionBound()
    if(observed.length) await assert.rejects(readArtifact(observed[0].refs[0]),{code:'TASK_OWNER_ARTIFACT_NOT_ALLOWED'})
    const refs=await queryOwnerSources(args)
    observed.push({binding,refs})
    const decision={action:'wait',summary:'已核对当前原文授权，等待业务步骤',evidenceRefs:refs,
      condition:{kind:'approval',missing:'本轮操作真人批准',responsibleParty:'审批人',resumeWhen:'取得本轮精确批准',evidenceRefs:refs}}
    await onCandidate(decision);return{status:'submitted',decision}
  }}
  const {service,execution,message,root}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},taskOwnerSessions:sessions,
    judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['当前来源']}:
      {kind:'intent',actions:[{intent:'create',arguments:{objective:body,stageAuthorizations:[{workflowId:'task-data-change',sourceQuote:body,objective:body,gate:'confirmation'}]},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
  const received=await service.ingest({...message,text:body}),state=await service.messages.process(received.runId),taskId=state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const before=await execution.controller.taskPlan(taskId),original=await execution.artifacts.read(before.task.requirementRef),source=original.sourceInstructions[0]
  await service.repairStageAuthorizations({taskId,repairKey:'direct-query-projection',reason:'保留原文两步执行与验证条件',expectedRequirementRevision:1,expectedRequirementRef:before.task.requirementRef,
    stageAuthorizations:[{workflowId:'task-data-change',sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:'线上先执行这两条，刷完找我验证',objective:'线上先执行这两条',gate:'none'},
      {workflowId:'task-data-change',sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:'我验证通过，再刷这69条正式数据',objective:'刷这69条正式数据',gate:'confirmation'}]},
    {channel:'web',actorId:'owner'})
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  assert.equal(observed.length,2)
  assert.equal(observed[1].binding.taskId,taskId);assert.equal(observed[1].binding.sessionId,observed[0].binding.sessionId)
  assert.equal(observed[1].binding.requirementRevision,2)
  const records=await execution.store.query({kind:'task.owner.query-evidence',taskId})
  assert.deepEqual(records.map(item=>item.artifactRef),observed[1].refs)
  assert.deepEqual(await execution.artifacts.read(before.task.requirementRef),original)
  assert.equal((await execution.artifacts.read(observed[0].refs[0])).execution.requirementRevision,1)
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
  await service.close(); await execution.controller.close(); await execution.store.close()
  const reopened=await openExecutionStore({dbPath:join(root,'control.db'),instanceId:'test'})
  try {
    assert.deepEqual((await reopened.query({kind:'task.owner.query-evidence',taskId})).map(item=>item.artifactRef),observed[1].refs)
    await assert.rejects(reopened.query({kind:'task.owner.query-evidence',taskId,requirementRevision:1}),{code:'TASK_OWNER_QUERY_STALE'})
  } finally {await reopened.close()}
})

for(const complete of [false,true]) test(`直接查询成功仍由任务最终决定验收，业务等待与完成独立：${complete}`,async t=>{
  let finish=complete
  const sessions={async close(){},async run(args){
    const {input,onSessionBound,onCandidate}=args;await onSessionBound()
    const refs=await queryOwnerSources(args)
    const decision=finish?{action:'complete',summary:'目标已核验',evidenceRefs:refs,assessments:input.acceptanceItems.map(item=>({itemId:item.itemId,status:'satisfied',evidenceRefs:refs}))}
      :{action:'wait',summary:'已核对来源，仍待业务选择',evidenceRefs:refs,condition:{kind:'business-input',missing:'选择方案',responsibleParty:'交办人',resumeWhen:'方案确认后继续',evidenceRefs:refs}}
    await onCandidate(decision);return{status:'submitted',decision}
  }}
  const {service,execution,message}=await fixture(t,'owner',undefined,{taskOwnerSessions:sessions})
  const received=await service.ingest(message),state=await service.messages.process(received.runId),taskId=state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const owner=await execution.store.query({kind:'task.owner',taskId})
  assert.equal(owner.decision.action,complete?'complete':'wait')
  assert.equal(owner.applicationStatus,'applied')
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
  if(!complete){
    finish=true
    await execution.store.command({id:'business-answer',kind:'task.owner.event',args:{taskId,eventKey:'business-answer',eventType:'task.context'}})
    assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
    const final=await execution.store.query({kind:'task.owner',taskId})
    assert.equal(final.decision.action,'complete');assert.equal(final.sessionId,owner.sessionId)
  }
})

for(const change of ['pause','cancel','requirement'])test(`直接查询在途完成拒绝已变更Task身份，原证据留存且不误入账：${change}`,async t=>{
  let query, binding, onQueryEvidence, seen
  const sessions={async close(){},async run(args){
    await args.onSessionBound();binding=args.binding;onQueryEvidence=args.onQueryEvidence
    const tool=args.tools.find(item=>item.name==='read-topic-sources')
    query=await tool.execute({binding,input:args.queryInput,args:{sourceKeys:args.queryInput.scope.sourceKeys}})
    const plan=await seen.execution.controller.taskPlan(binding.taskId)
    if(change==='requirement') await seen.execution.store.command({id:'new-input',kind:'task.owner.event',args:{taskId:binding.taskId,eventKey:'new-input',eventType:'intent.received'}})
    else await seen.execution.controller.controlTask({commandId:'mid-query-control',taskId:binding.taskId,intent:change,expectedControlRevision:plan.task.controlRevision})
    const identity=Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key=>[key,binding[key]]))
    await assert.rejects(onQueryEvidence({binding:identity,evidenceRef:query.evidenceRef}),error=>['TASK_OWNER_QUERY_STALE','TASK_OWNER_LEASE_STALE'].includes(error.code))
    return{status:'no_submission'}
  }}
  seen=await fixture(t,'owner',undefined,{taskOwnerSessions:sessions})
  const received=await seen.service.ingest(seen.message),state=await seen.service.messages.process(received.runId),taskId=state.commands[0].result.taskId
  await settleTaskOwners(seen.service, seen.execution)
  assert.ok(query)
  assert.deepEqual(await seen.execution.store.query({kind:'task.owner.query-evidence',taskId}),[])
  assert.equal((await seen.execution.artifacts.read(query.evidenceRef)).kind,'agent-query-evidence')
  assert.deepEqual(await seen.execution.store.query({kind:'run.list',taskId}),[])
})

test('已取消排空Task原生删除有零写预检且保留防重凭证',async t=>{
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},taskOwnerSessions:{async close(){},async run({onSessionBound,onCandidate}){
  await onSessionBound();const decision={action:'wait',summary:'等待业务选择',evidenceRefs:[],condition:{kind:'business-input',missing:'选择方案',responsibleParty:'交办人',resumeWhen:'确认后继续',evidenceRefs:[]}}
  await onCandidate(decision);return{status:'submitted',decision}
 }},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text)
  :stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['当前来源']}
  :{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
 const received=await service.ingest(message),state=await service.messages.process(received.runId),taskId=state.commands[0].result.taskId
 assert.equal(state.commands[0].result.runId, null)
 await settleTaskOwners(service, execution)
 let plan=await execution.controller.taskPlan(taskId)
 await assert.rejects(service.deleteCancelledTask({taskId,expectedControlRevision:plan.task.controlRevision,checkOnly:true},{channel:'web',actorId:'owner'}),/NOT_CANCELLED/)
 await execution.controller.controlTask({commandId:'delete-cancel',taskId,intent:'cancel',expectedControlRevision:plan.task.controlRevision})
 await settleTaskOwners(service, execution)
 const delivered = new Map()
 const delivery = createWorkflowNotifications({store:execution.store,controller:execution.controller,artifacts:execution.artifacts,
  adapter:{canDisclose:async()=>true,send:async notice=>{const receipt={messageId:`out-${notice.id}`};delivered.set(notice.id,receipt);return receipt},
   readback:async notice=>delivered.get(notice.id)}})
 await delivery.flush();await delivery.flush()
 plan=await execution.controller.taskPlan(taskId)
 assert.equal(plan.task.controlState,'cancelled',JSON.stringify({plan,owner:await execution.store.query({kind:'task.owner',taskId})}))
 const request={taskId,expectedControlRevision:plan.task.controlRevision,checkOnly:true}
 const before=await execution.store.query({kind:'task.catalog'})
 const revision=await execution.store.query({kind:'task.viewRevision',taskId})
 assert.ok((await execution.store.query({kind:'message.task-candidates',conversationId:message.conversationId??'g'})).some(item=>item.command.args.taskId===taskId))
 await assert.rejects(service.deleteCancelledTask(request,{channel:'web',actorId:'other'}),/FORBIDDEN/)
 const checked=await service.deleteCancelledTask(request,{channel:'web',actorId:'owner'})
 assert.equal(checked.taskId,taskId);assert.deepEqual(await execution.store.query({kind:'task.catalog'}),before)
 assert.equal(await execution.store.query({kind:'task.deleted',taskId}),null)
 await assert.rejects(service.deleteCancelledTask({...request,expectedControlRevision:99},{channel:'web',actorId:'owner'}),/STALE/)
 const removed=await service.deleteCancelledTask({...request,checkOnly:false},{channel:'web',actorId:'owner'})
 assert.ok(removed.deletedAt);assert.equal((await execution.store.query({kind:'task.catalog'})).length,0)
 assert.notEqual(await execution.store.query({kind:'task.viewRevision',taskId}),revision)
 assert.deepEqual(await service.tasks({taskId}),[])
 assert.ok(!(await execution.store.query({kind:'message.task-candidates',conversationId:message.conversationId??'g'})).some(item=>item.command.args.taskId===taskId))
 assert.deepEqual(await service.deleteCancelledTask({...request,checkOnly:false},{channel:'web',actorId:'owner'}),removed)
 assert.equal((await service.state(received.runId)).commands[0].status,'applied')
 await assert.rejects(execution.store.command({id:'deleted-recreate',kind:'task.plan.create',args:{taskId}}),/TASK_DELETED/)
 const noticesBefore=await execution.store.query({kind:'message.notifications'})
 const notifier=createWorkflowNotifications({store:execution.store,controller:execution.controller,artifacts:execution.artifacts})
 await notifier.flush();await notifier.flush()
 assert.deepEqual(await execution.store.query({kind:'message.notifications'}),noticesBefore)
 assert.deepEqual(await execution.store.query({kind:'message.notification.diagnostics',status:'unresolved'}),[])
 await assert.rejects(execution.store.command({id:'deleted-notice',kind:'message.notification.prepare',args:{runId:received.runId,commandId:state.commands[0].commandId,notificationId:'deleted-notice',payload:{fact:{taskId}}}}),/TASK_DELETED/)
})


function coordinatorFixtureSessions(decide) {
 return {async run({input,onSessionBound,onCandidate,readTools}) {
  await onSessionBound()
  await onCandidate({decisions:await Promise.all(input.sources.map(source=>decide(source,input,readTools)))})
  return {status:'submitted'}
 },async close(){}}
}
function coordinatorUnit(source,intent,args,binding={disposition:'new',candidateId:null}) {
 return {runId:source.runId,reason:'原文明确',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding,
  intent:{kind:'intent',actions:[{intent,arguments:args,dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}]}
}

test('任务准入授权：仅指定所有者批准冻结事项，恢复后只创建一个Task', async t => {
  const f = await fixture(t, 'guest', undefined, { coordinatorSessions: coordinatorFixtureSessions((source, input) => {
    const topic = input.candidates.find(item => item.topicId && !item.taskId)
    return coordinatorUnit(source, 'create', { objective: '核对这份材料' }, topic ? { disposition: 'existing', candidateId: topic.candidateId } : undefined)
  }) })
  const received = await f.service.ingest({ ...f.message, text: '核对这份材料' })
  let state = await f.service.messages.process(received.runId)
  const request = state.requests.find(item => item.status === 'pending')
  assert.equal(request.kind, 'needs_authorization')
  assert.deepEqual(request.permittedActors, ['owner'])
  assert.equal(state.commands.length, 0)
  assert.equal((await f.service.mailboxes()).messages.find(item => item.runId === received.runId).workflowStatus, 'waiting_authorization')
  const input = { runId: received.runId, requestId: request.id, eventId: 'owner-grant', answer: '同意' }
  await assert.rejects(f.service.resumeRequest(input, { channel: 'im', actorId: 'guest', conversationId: 'g' }), /WORKFLOW_ACTION_FORBIDDEN/)
  await assert.rejects(f.service.resumeRequest({ ...input, answer: '需求补充' }, { channel: 'im', actorId: 'owner', conversationId: 'g' }), { code: 'WORKFLOW_AUTHORIZATION_DECISION_REQUIRED' })
  await f.service.resumeRequest(input, { channel: 'im', actorId: 'owner', conversationId: 'g' })
  state = await f.service.messages.process(received.runId)
  assert.equal(state.requests.find(item => item.id === request.id).resolvedByActorId, 'owner')
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0].status, 'applied', JSON.stringify(state.commands))
  assert.equal(state.commands[0].args.authorizationRequestId, request.id)
  const plan = await f.execution.controller.taskPlan(state.commands[0].args.taskId)
  assert.equal((await f.execution.artifacts.read(plan.task.requirementRef)).authorization.ownerConfirmed, true)
  await f.service.resumeRequest(input, { channel: 'im', actorId: 'owner', conversationId: 'g' })
  assert.equal((await f.execution.store.query({ kind: 'task.catalog' })).length, 1)
})

test('任务准入授权：拒绝后收口，批准不能复用到修改后的动作', async t => {
  for (const rejected of [true, false]) {
    let change = false
    const f = await fixture(t, 'guest', undefined, { coordinatorSessions: coordinatorFixtureSessions((source, input) => {
      const topic = input.candidates.find(item => item.topicId && !item.taskId)
      return coordinatorUnit(source, 'create', { objective: change ? '修改其他功能' : '核对材料' }, topic ? { disposition: 'existing', candidateId: topic.candidateId } : undefined)
    }) })
    const received = await f.service.ingest(f.message)
    const before = await f.service.messages.process(received.runId)
    const request = before.requests[0]
    change = !rejected
    await f.service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'owner-answer', answer: rejected ? '拒绝' : '同意' },
      { channel: 'im', actorId: 'owner', conversationId: 'g' })
    const after = await f.service.messages.process(received.runId)
    assert.equal(after.commands.length, 0)
    assert.equal((await f.execution.store.query({ kind: 'task.catalog' })).length, 0)
    if (rejected) assert.equal(after.run.status, 'settled')
    else assert.ok(after.requests.some(item => item.id !== request.id && item.status === 'pending' && item.kind === 'needs_authorization'))
  }
})

test('任务准入沿同作者有效点名来源承接后续开发，其他作者不能借用', async t => {
  for (const actor of ['member', 'other']) {
    const f = await fixture(t, 'member', undefined, { legacy: { getGroup: id => ({ groupId: id, responsibility: '## 任务准入\n明确交办可以承接', messages: [] }) },
      coordinatorSessions: coordinatorFixtureSessions((source, input) => {
        const topic = input.candidates.find(item => item.topicId && !item.taskId)
        return coordinatorUnit(source, source.body.includes('按文档') ? 'create' : 'fact',
          source.body.includes('按文档') ? { objective: '按文档开发' } : { kind: 'fact', text: source.body },
          topic ? { disposition: 'existing', candidateId: topic.candidateId } : undefined)
      }) })
    const first = await f.service.ingest({ ...f.message, text: '@小助手 请看这份文档', messageId: 'doc-address' })
    const firstState = await f.service.messages.process(first.runId)
    assert.equal(firstState.commands[0]?.status, 'applied', JSON.stringify(firstState.commands))
    const second = await f.service.ingest({ ...f.message, text: '按文档开发', messageId: 'doc-develop', senderOpenDingTalkId: actor })
    const state = await f.service.messages.process(second.runId)
    if (actor === 'member') {
      assert.equal(state.commands[0]?.status, 'applied', JSON.stringify(state))
      assert.equal(state.requests.some(item => item.status === 'pending'), false)
    } else {
      assert.equal(state.commands.length, 0)
      assert.equal(state.requests.find(item => item.status === 'pending')?.kind, 'needs_authorization')
    }
  }
})

test('工程环境由来源确定，模型猜测不能补齐UAT且关联来源不必重复', async t => {
  for (const [body, supplied, expected] of [['按文档开发', 'uat2', undefined], ['按文档开发并提交uat3', undefined, 'uat3'], ['uat2或uat3尚未决定', 'uat2', undefined]]) {
    const f = await fixture(t, 'owner', undefined, { coordinatorSessions: coordinatorFixtureSessions(source =>
      coordinatorUnit(source, 'create', { objective: '按文档开发', ...(supplied ? { uatEnvironment: supplied } : {}) })) })
    const received = await f.service.ingest({ ...f.message, text: body })
    const state = await f.service.messages.process(received.runId)
    const plan = await f.execution.controller.taskPlan(state.commands[0].args.taskId)
    assert.equal((await f.execution.artifacts.read(plan.task.requirementRef)).target.uatEnvironment, expected)
  }
})
test('群协调真实store：闲聊及文件资料静默且旧judge零调用',async t=>{
 let oldCalls=0,turns=0
 const f=await fixture(t,'owner',undefined,{judge:async()=>{oldCalls++;throw Error('OLD_JUDGE_FORBIDDEN')},
  coordinatorSessions:coordinatorFixtureSessions(source=>{turns++;return {runId:source.runId,reason:'第三方闲聊或独立资料，无交办',units:[]}})})
 for(const [id,text] of [['chat','张三你下班了吗'],['file','[文件] 审核条目.xlsx']]){
  const r=await f.service.ingest({...f.message,messageId:id,text})
  const state=await f.service.messages.process(r.runId)
  assert.equal(state.run.status,'settled');assert.equal(state.commands.length,0)
 }
 const notifier=createWorkflowNotifications({store:f.execution.store,controller:f.execution.controller,artifacts:f.execution.artifacts})
 await notifier.flush()
 assert.equal((await f.execution.store.query({kind:'message.notifications'})).length,0)
 assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,0)
 assert.equal(turns,2);assert.equal(oldCalls,0)
})
test('群协调真实store：持续事项research后补充fact复用原Task及审批约束',async t=>{
 let oldCalls=0
 const f=await fixture(t,'owner',undefined,{judge:async()=>{oldCalls++;throw Error('OLD_JUDGE_FORBIDDEN')},coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  if(source.body.includes('更正')){
   const card=input.candidates.find(c=>c.taskId)
   assert.ok(card,'已有Task必须可见')
   return coordinatorUnit(source,'fact',{kind:'constraint',text:source.body},{disposition:'existing',candidateId:card.candidateId})
  }
  const d=coordinatorUnit(source,'research',{objective:source.body})
  d.units[0].intent.constraints=['生产执行前必须小鹏审批'];return d
 })})
 const first=await f.service.ingest({...f.message,messageId:'research',text:'分析审核材料，生产执行前必须小鹏审批'})
 const initial=await f.service.messages.process(first.runId)
 assert.equal(initial.commands[0].status,'applied',JSON.stringify(initial.commands))
 const taskId=initial.commands[0].result.taskId
 assert.equal(initial.commands[0].result.runId,null)
 const second=await f.service.ingest({...f.message,messageId:'correction',text:'更正表格标题为新的LCA专家，生产执行仍须小鹏审批'})
 const updated=await f.service.messages.process(second.runId)
 assert.equal(updated.commands[0].kind,'fact');assert.equal(updated.commands[0].args.taskId,taskId)
 assert.equal(updated.commands[0].status,'applied',JSON.stringify(updated.commands))
 assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,1)
 const plan=await f.execution.controller.taskPlan(taskId)
 const requirement=await f.execution.artifacts.read(plan.task.requirementRef)
 assert.ok(JSON.stringify(requirement).includes('小鹏审批'))
 assert.equal(oldCalls,0)
})


test('群协调真实store：长answer不等待执行结束且后续闲聊仍可归类',async t=>{
 let release,started=false,finished=false,oldCalls=0
 const gate=new Promise(resolve=>{release=resolve})
 const f=await fixture(t,'owner',undefined,{judge:async()=>{oldCalls++;throw Error('OLD_JUDGE_FORBIDDEN')},
  coordinatorSessions:coordinatorFixtureSessions(source=>source.body==='第三方闲聊'?{runId:source.runId,reason:'与助手无关',units:[]}:coordinatorUnit(source,'answer',{objective:source.body})),
  messageAgentSessions:{async run({onSessionBound,onResult}){await onSessionBound();started=true;await gate;await onResult({outcome:'completed',summary:'查询完毕',evidenceRefs:[],limitations:[],question:''});finished=true;return {status:'submitted'}},async cancel(){release()},async close(){release()}}})
 try{
  const first=await f.service.ingest({...f.message,messageId:'long-answer',text:'小助手查询审核状态'})
  const pending=await f.service.messages.process(first.runId)
  assert.equal(started,true);assert.equal(finished,false)
  assert.equal(pending.commands[0].kind,'answer');assert.equal(pending.commands[0].status,'running')
  const second=await f.service.ingest({...f.message,messageId:'parallel-chat',text:'第三方闲聊'})
  const quiet=await f.service.messages.process(second.runId)
  assert.equal(quiet.run.status,'settled');assert.equal(quiet.commands.length,0);assert.equal(finished,false)
  assert.equal(oldCalls,0)
 }finally{release()}
})


for(const mode of ['question','answer','permission'])test(`原生Task补充澄清后修订同身份并保留旧要求：${mode}`,async t=>{
 const f=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  if(source.body==='先排查草稿')return coordinatorUnit(source,'research',{objective:source.body})
  const card=input.candidates.find(c=>c.taskId);assert.ok(card)
  const binding={disposition:'existing',candidateId:card.candidateId}
  if(!source.requests.some(r=>r.status==='resolved'))return {runId:source.runId,reason:'补充目标尚未明确',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding,intent:coordinatorQuestion(source,{reason:'此前仅排查',question:'继续排查还是修复并验证？'})}]}
  return coordinatorUnit(source,'revise',{objective:'修复草稿并验证'},binding)
 })})
 const initial=await f.service.ingest({...f.message,text:'先排查草稿'})
 const accepted=await f.service.messages.process(initial.runId),taskId=accepted.commands[0].result.taskId
 assert.equal(accepted.commands[0].result.runId,null)
 const before=await f.execution.controller.taskPlan(taskId),oldRef=before.task.requirementRef
 const follow=await f.service.ingest({...f.message,messageId:'follow',text:'草稿仍有问题'})
 const pending=await f.service.messages.process(follow.runId),request=pending.requests.find(r=>r.status==='pending')
 assert.ok(request);assert.equal(pending.commands.length,0)
 if(mode==='question'){assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,1);return}
 if(mode==='permission')await assert.rejects(f.service.resumeRequest({runId:follow.runId,requestId:request.id,eventId:'outsider',answer:'修复'},{channel:'web',actorId:'outsider'}),/FORBIDDEN/)
 await f.service.resumeRequest({runId:follow.runId,requestId:request.id,eventId:'owner-answer',answer:'修复并验证'},{channel:'web',actorId:'owner'})
 const after=await f.service.messages.process(follow.runId)
 assert.equal(after.commands[0].kind,'revise');assert.equal(after.commands[0].args.taskId,taskId);assert.equal(after.commands[0].status,'applied')
 const plan=await f.execution.controller.taskPlan(taskId)
 assert.ok(plan.task.requirementRevision>before.task.requirementRevision)
 assert.ok(await f.execution.artifacts.read(oldRef));assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,1)
})

test('同一任务完整承接超过十六条真实来源且保留来源权限',async t=>{
 const total=17
 const f=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  const first=input.sources[0],primary=source.runId===first.runId
  return coordinatorUnit(source,primary?'create':'fact',primary?{objective:'核对全部补充要求'}:{kind:'constraint',text:source.body},primary?{disposition:'new',candidateId:null}:{disposition:'conversation',candidateId:`source:${first.runId}`})
 }),taskOwnerSessions:{async run({input,onSessionBound,onCandidate}){
  assert.equal(input.goal.sourceInstructions.length,total)
  assert.ok(input.goal.sourceInstructions.every(source=>source.actorId==='owner'))
  await onSessionBound();await onCandidate({action:'wait',summary:'已收到完整来源',evidenceRefs:[],condition:{kind:'approval',missing:'逐项审批',responsibleParty:'审批人',resumeWhen:'审批通过后评估',evidenceRefs:[]}});return{status:'submitted'}
 },async close(){}}})
 const runs=[]
 for(let i=0;i<total;i++)runs.push(await f.service.messages.receive({sourceKey:`many-sources:${i}`,sourceVersion:1,conversationId:'g',actorId:'owner',body:`要求${i}：未经审批不得执行第${i}项`,context:{sourceMessageId:`many-${i}`}},{process:false}))
 await f.service.messages.process(runs[0].runId)
 const state=await f.service.state(runs[0].runId)
 assert.equal(state.commands[0].status,'applied',JSON.stringify(state.commands))
 const taskId=state.commands[0].result.taskId,plan=await f.execution.controller.taskPlan(taskId)
 const requirement=await f.execution.artifacts.read(plan.task.requirementRef)
 assert.equal(requirement.sourceInstructions.length,total)
 assert.deepEqual(new Set(requirement.sourceInstructions.map(source=>source.sourceKey)),new Set(Array.from({length:total},(_,i)=>`many-sources:${i}`)))
 assert.equal((await f.execution.store.query({kind:'task.catalog'})).length,1)
})

test('收信箱只展示当前来源版本，旧材料阻塞与已发送审计分离',async t=>{
 const f=await fixture(t)
 const send=async(kind,args)=>(await f.execution.store.command({id:`mailbox-${kind}-${Math.random()}`,kind,args})).result
 await send('message.receive',{runId:'mailbox-old',sourceKey:'mailbox-source',sourceVersion:1,conversationId:'g',actorId:'owner',body:'核对材料',context:{sourceMessageId:'same-message'}})
 await send('message.wait',{runId:'mailbox-old',unitId:'$',nodeId:'coordinator',request:{requestId:'mailbox-request',kind:'needs_context',blocked:true,responsibility:'system',reason:'旧材料失败'}})
 assert.equal((await f.service.mailboxes()).messages.find(row=>row.runId==='mailbox-old').workflowStatus,'waiting_system')
 await send('message.notification.prepare',{runId:'mailbox-old',notificationId:'mailbox-notice',requestId:'mailbox-request',payload:{text:'处理受阻',conversationId:'g',sourceMessageId:'same-message'},disclosure:{conversationId:'g',authorizationRef:'mailbox-source'}})
 const notice=(await send('message.notification.claim',{notificationId:'mailbox-notice'})).notification
 await send('message.notification.sent',{notificationId:notice.id,leaseEpoch:notice.leaseEpoch,ack:{messageId:'old-delivered'}})
 await send('message.notification.readback',{notificationId:notice.id,leaseEpoch:notice.leaseEpoch,evidence:{messageId:'old-delivered',conversationId:'g'}})
 await send('message.receive',{runId:'mailbox-current',sourceKey:'mailbox-source',sourceVersion:2,conversationId:'g',actorId:'owner',body:'核对材料（当前）',context:{sourceMessageId:'same-message'}})
 const boxes=await f.service.mailboxes()
 assert.deepEqual(boxes.messages.filter(row=>row.messageId==='same-message').map(row=>row.runId),['mailbox-current'])
 assert.equal(boxes.messages[0].waiting.length,0)
 assert.equal(boxes.outbox.find(item=>item.outboundId==='mailbox-notice').status,'sent')
 assert.equal((await f.execution.store.query({kind:'message.run',runId:'mailbox-old'})).requests[0].status,'pending')
})

for(const requestFirst of [false,true])for(const requiredCount of [0,1,4])test(`创建目标仅含业务名称时，四附件正式fact保留材料权限且独立附件静默：前置${requiredCount}，请求${requestFirst?'在前':'在后'}`,async t=>{
 const ids=['provided-file-a','provided-file-b','provided-file-c','provided-file-d'],seen=[],reads=[]
 const filename=id=>`${id}.${id==='provided-file-d'?'xlsx':'sql'}`
 const f=await fixture(t,'owner',undefined,{readMessage:async(_group,id)=>({conversationId:'g',messageId:id,text:`[文件] ${filename(id)} fileId: ${id}`,resourceRefs:[{type:'fileId',resourceId:id}]}),readResource:async(_group,_message,{resourceId})=>{reads.push(resourceId);return {text:resourceId==='provided-file-d'?'Sheet1\n审核人\t状态\n专家甲\t待审核':'SELECT 1;',complete:true}},coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  const target=input.sources.find(item=>item.body==='请调查四份附件')
  if(source.body.includes('unrelated-file'))return{runId:source.runId,reason:'无关独立附件',units:[]}
  const primary=source.runId===target.runId
  const decision=coordinatorUnit(source,primary?'research':'fact',primary?{objective:'核对审核工作簿和配套脚本，调查现状后提交方案'}:{kind:'fact',text:source.body},primary?{disposition:'new',candidateId:null}:{disposition:'conversation',candidateId:`source:${target.runId}`})
  if(primary)decision.units[0].intent.requiredExecutionMaterials=ids.slice(0,requiredCount)
  return decision
 }),taskOwnerSessions:{async run({input,readArtifact,onSessionBound,onCandidate}){
  for(const material of input.goal.materials){ assert.equal(material.text,undefined); const original=await readArtifact(material.artifactRef); assert.equal(original.id,material.id); assert.ok(original.text.length) }
  assert.ok(input.events.every(event=>event.payload===undefined))
  seen.push(input);await onSessionBound();await onCandidate({action:'wait',summary:'按授权附件继续调查',evidenceRefs:[],condition:{kind:'execution',missing:'附件调查结果',responsibleParty:'调查方',resumeWhen:'调查完成后评估',evidenceRefs:[]}});return{status:'submitted'}
 },async close(){}}})
 const receiveRequest=()=>f.service.messages.receive({sourceKey:'four:request',sourceVersion:1,conversationId:'g',actorId:'owner',body:'请调查四份附件',context:{sourceMessageId:'request'}},{process:false})
 let source=requestFirst?await receiveRequest():null
 for(const id of [...ids,'unrelated-file'])await f.service.messages.receive({sourceKey:`four:${id}`,sourceVersion:1,conversationId:'g',actorId:'owner',body:`[文件] ${filename(id)} fileId: ${id}`,context:{sourceMessageId:id,attachments:[{resourceRef:id,fileId:id,sourceMessageId:id,sourceVersion:1,state:'pending',source:{type:'fileId',resourceId:id}}]}},{process:false})
 source??=await receiveRequest()
 await f.service.messages.process(source.runId);(await settleTaskOwners(f.service, f.execution)).failures
 const state=await f.service.state(source.runId)
 assert.equal(state.commands[0].status,'applied',JSON.stringify(state.commands))
 const plan=await f.execution.controller.taskPlan(state.commands[0].result.taskId)
 const requirement=await f.execution.artifacts.read(plan.task.requirementRef)
 assert.equal(requirement.sourceInstructions.length,5)
 assert.deepEqual(new Set(requirement.sourceInstructions.map(s=>s.sourceKey)),new Set(['four:request',...ids.map(id=>`four:${id}`)]))
 assert.deepEqual(new Set(requirement.materials.map(material=>material.id)),new Set(ids))
 assert.deepEqual(new Set(reads),new Set(ids))
 assert.ok(seen.length)
 assert.deepEqual(new Set(seen[0].materialAccess.readableMessageResources.map(r=>r.resourceId)),new Set(ids))
})

test('PR网络恢复由服务自动调度，无新条件且保留成功前缀、原节点身份与持久退避',async t=>{
 let prefix=0,attempts=0,suffix=0
 const {service,execution,startCodeTask}=await fixture(t,'owner',undefined,{execute:async()=>{prefix++;return{}},extraNodes:[
  {id:'pr-network',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:()=>({}),execute:async()=>{if(++attempts<3)throw Object.assign(Error('network'),{code:'PR_CONNECTION_FAILED'});return{}}},
  {id:'finish',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:()=>({}),execute:async()=>{suffix++;return{}}}
 ]})
 const task=await startCodeTask();await execution.controller.whenIdle(task.runId)
 const before=await execution.controller.state(task.runId)
 assert.equal(before.nodes[0].status,'succeeded');assert.equal(attempts,1)
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId);assert.equal(attempts,2)
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId);assert.equal(attempts,2)
 await new Promise(resolve=>setTimeout(resolve,1100))
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId)
 const after=await execution.controller.state(task.runId)
 assert.equal(after.run.status,'succeeded');assert.equal(attempts,3);assert.equal(prefix,1);assert.equal(suffix,1)
 assert.equal(after.run.generation,before.run.generation);assert.deepEqual(after.nodes.map(n=>n.nodeRunId),before.nodes.map(n=>n.nodeRunId))
 const db=new DatabaseSync(join(execution.artifacts.root,'..','control.db'),{readOnly:true})
 try{const events=db.prepare("SELECT payload FROM execution_events WHERE kind='run.recovery.admitted' ORDER BY seq").all().map(r=>JSON.parse(r.payload));assert.deepEqual(events.map(e=>e.attempt),[1,2]);assert.ok(events.every(e=>e.errorCode==='PR_CONNECTION_FAILED'));assert.equal(new Set(events.map(e=>e.key)).size,1)}finally{db.close()}
})

for(const proofState of ['verified-unsent','verified-failed','no-proof','sent'])test(`服务自动恢复PR未知预检 ${proofState}：仅可信未发送恢复原效果`,async t=>{
 let attempts=0,mutations=0,reads=0
 const {service,execution,startCodeTask}=await fixture(t,'owner',undefined,{
  allowedEffects:['github.pr'],deliveryOptions:{authorize:async()=>({principalId:'owner',authorizationRef:'fixture-pr'}),prAdapter:{
   execute:async()=>{if(++attempts===1)return proofState==='verified-failed'?{status:'failed',phase:'preflight',mutationAttempted:false,reason:'PR_CONNECTION_FAILED'}:{status:'unknown',reason:'PR_INTERRUPTED'};mutations++;return{status:'succeeded',url:'https://example.invalid/pr/1'}},
   reconcile:async()=>{reads++;return proofState==='sent'?{status:'unknown',phase:'after-send-intent',reason:'PR_CONNECTION_FAILED'}:{status:'failed',phase:'preflight',mutationAttempted:false,reason:'PR_PREFLIGHT_NOT_SENT'}},
   recoverUnsent:async prepared=>proofState.startsWith('verified-')?{operationKey:prepared.operationKey,preparedDigest:prepared.digest,mutationAttempted:false,reason:'PR_PREFLIGHT_NOT_SENT',evidenceRef:'verified-host-journal'}:null
  }},execute:async({runId,generation,requirementDigest,perform})=>{
   const data={action:'pr',repo:'test/repo',head:'test/head',runId,generation,requirementDigest,operationKey:'a'.repeat(64)}
   return perform({action:'pr',prepared:{...data,digest:executionDigest(data)}})
  }
 })
 const task=await startCodeTask();await execution.controller.whenIdle(task.runId)
 const before=await execution.controller.state(task.runId)
 assert.equal(before.nodes[0].waitReason.reference,proofState==='verified-failed'?'PR_CONNECTION_FAILED':'DELIVERY_RECONCILIATION_REQUIRED');assert.equal(attempts,1)
 const original=(await execution.store.query({kind:'effect.list',runId:task.runId}))[0]
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId)
 const after=await execution.controller.state(task.runId),effects=await execution.store.query({kind:'effect.list',runId:task.runId})
 assert.equal(after.run.status,proofState.startsWith('verified-')?'succeeded':'waiting')
 assert.equal(mutations,proofState.startsWith('verified-')?1:0);assert.equal(attempts,proofState.startsWith('verified-')?2:1)
 assert.equal(effects.length,1);assert.equal(effects[0].effectId,original.effectId);assert.equal(after.nodes[0].nodeRunId,before.nodes[0].nodeRunId)
 await settleTaskOwners(service, service.execution);await execution.controller.whenIdle(task.runId)
 assert.equal(mutations,proofState.startsWith('verified-')?1:0);assert.equal(attempts,proofState.startsWith('verified-')?2:1)
 if(proofState!=='verified-failed')assert.ok(reads>0)
})

test('新Task短名称独立于完整调查目标，数据库目录提供真实连接和结构范围',async t=>{
 const objective='调查生产环境Editor数据库process_id_temp表当前结构，并为新增name列准备受审批约束的变更方案。';
 const database={id:'editor-production',connectionId:'tianyi_editor_slave',environment:'production',metadataSchemas:['public'],tables:[{schema:'public',table:'approved',columns:['id']}]};
 let catalog;
 const {service,message,execution}=await fixture(t,'owner',undefined,{readTools:['query_readonly_database'],config:{directQueries:{resources:[],databases:[database],statusResources:[],credentialsPath:'D:/never-read-test-credentials.json',permissions:{resourceIds:[],databaseIds:['editor-production'],statusIds:[]}}},
  judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:'create',arguments:{title:'调查Editor临时表结构',objective},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'},
  taskOwnerSessions:{async close(){},async run({queryInput,onSessionBound,onCandidate}){await onSessionBound();catalog=queryInput.context;const decision={action:'wait',summary:'目录已核对，尚待调查',evidenceRefs:[],condition:{kind:'execution',missing:'只读调查结果',responsibleParty:'执行方',resumeWhen:'核对结果后继续',evidenceRefs:[]}};await onCandidate(decision);return{status:'submitted',decision}}}});
 const received=await service.ingest({...message,text:objective});const state=await service.messages.process(received.runId);const result=state.commands[0].result;
 assert.equal(result.runId,null);assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[]);
 const task=(await service.tasks({taskId:result.taskId}))[0];assert.equal(task.title,'调查Editor临时表结构');assert.equal(task.objective,objective);
 assert.equal(catalog.databases[0].connectionId,'tianyi_editor_slave');assert.deepEqual(catalog.databases[0].metadataSchemas,['public']);
 assert.match(catalog.databaseGuidance,/登记只读连接/);assert.equal(catalog.databases[0].environment,'production');assert.equal(JSON.stringify(catalog).includes('credentialsPath'),false);
});

test('没有Owner的历史业务Task仍按计划成功和取消判终态，不放开已完成上下文', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE business_tasks(task_id TEXT,status TEXT,requirement_revision INTEGER,plan_revision INTEGER,plan_requirement_revision INTEGER);
      CREATE TABLE task_controls(task_id TEXT,state TEXT,control_revision INTEGER);
      CREATE TABLE task_owners(task_id TEXT);
      INSERT INTO business_tasks VALUES('legacy','succeeded',1,1,1);
      INSERT INTO task_controls VALUES('legacy','active',1);`)
    assert.equal(isBusinessTaskTerminal(db, 'legacy'), true)
    db.prepare("UPDATE business_tasks SET status='failed' WHERE task_id='legacy'").run()
    assert.equal(isBusinessTaskTerminal(db, 'legacy'), false)
    db.prepare("UPDATE task_controls SET state='cancelled' WHERE task_id='legacy'").run()
    assert.equal(isBusinessTaskTerminal(db, 'legacy'), true)
  } finally { db.close() }
})

for (const ending of ['complete', 'cancelled']) test(`真正业务 ${ending} 后上下文入口仍拒绝修订`, async t => {
  const waitingOwner={async close(){},async run(args){
    await args.onSessionBound();const refs=await queryOwnerSources(args)
    const decision={action:'wait',summary:'业务尚待批准',evidenceRefs:refs,
      condition:{kind:'approval',missing:'本轮精确批准',responsibleParty:'审批人',resumeWhen:'批准后继续',evidenceRefs:refs}}
    await args.onCandidate(decision);return{status:'submitted',decision}
  }}
  const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},
    ...(ending==='cancelled'?{taskOwnerSessions:waitingOwner}:{})})
  const received=await service.ingest(message),state=await service.messages.process(received.runId),taskId=state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const plan=await execution.controller.taskPlan(taskId)
  if(ending==='cancelled') await service.submitWebTask({action:'cancel',taskId,requestId:'context-ending-cancel',inputVersion:plan.task.requirementRevision+1,runSequence:0,reason:'停止任务'}, {channel:'web',actorId:'owner'})
  else {
    const owner=await execution.store.query({kind:'task.owner',taskId})
    assert.equal(owner.decision.action,'complete');assert.equal(owner.applicationStatus,'applied')
    assert.equal(owner.eventWatermark,owner.processedWatermark)
  }
  const current=await execution.controller.taskPlan(taskId)
  await assert.rejects(service.submitWebTask({action:'context',taskId,requestId:'context-after-terminal',inputVersion:current.task.requirementRevision+1,
    runSequence:0,context:'追加要求',topicRefs:[]},{channel:'web',actorId:'owner'}),/RUN_TERMINAL/)
  assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRevision,current.task.requirementRevision)
  assert.deepEqual(await execution.store.query({kind:'run.list',taskId}),[])
})

for (const [firstDecision, workflowKind] of [['approved', 'uat-deployment'], ['rejected', 'uat-deployment'], ['approved', 'uat-rebuild'], ['approved', 'data-change'], ['rejected', 'data-change']]) test(`原生私聊审批实际服务完整请求ID ${workflowKind}/${firstDecision}：可见、授权、首终态与Owner事件幂等`, async t => {
  const requestId = `external:${'a'.repeat(64)}`, commitSha = 'b'.repeat(40)
  let sends = 0
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    config: { webActorId: 'owner', approvalRecipientUserId: 'human-user' },
    deliveryOptions: { authorize: async () => false,
      authorizeExternal: async () => ({ principalId: 'owner', approval: { requestId, approverIds: ['owner'] } }),
      externalAdapter: { execute: async () => { sends++; return { status: 'succeeded' } }, reconcile: async () => ({ status: 'unknown' }) } },
  })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  const original = (await service.state(received.runId)).commands[0].result
  assert.equal(original.runId,null)
  await settleTaskOwners(service, service.execution)
  const taskId = 'web-approval-fixture', target = { repository: 'HiQ-AI/dataset', environment: 'uat', service: 'dataset', commitSha, runbookId: 'dataset-uat3-deployment' }
  const requirement = await execution.artifacts.put({ request: '验证UAT3提测', target })
  await execution.store.command({ id: 'approval-web-origin', kind: 'task.web-rerun.accept', args: {
    taskId, rerunOfTaskId: original.taskId, actorId: 'owner', request: { expectedRunId: original.runId, objective: '验证UAT3提测', uatEnvironment: 'uat3' },
    requirementRef: requirement.ref, criteria: ['验证提测'], sourceKey: 'web-rerun:approval-fixture' } })
  execution.controller.registerWorkflow({ id: 'approval-fixture', version: '1', nodes: [{
    id: 'execute-build', version: '1', executor: 'code', allowedEffects: ['external.operation'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement,
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external', prepared: {
      action: 'external', workflowKind, operation: workflowKind === 'uat-rebuild' ? 'rebuild' : 'build', runId, generation, requirementDigest,
      resourceKey: 'external:uat:HiQ-AI/dataset:dataset', expected: { commitSha },
      ...(workflowKind === 'data-change' ? { stage: 'approval-gate', target: { database: 'production-editor' },
        intent: { approvalSource: 'assistant', issueId: 'projects/flbn/issues/857', applySql: firstDecision === 'approved' ? 'ALTER TABLE public.process_id_temp ADD COLUMN name character varying;' : 'ALTER TABLE public.process_id_temp DROP COLUMN name;', sheetSha256: 'c'.repeat(64), packageDigest: 'd'.repeat(64) } } : {}) } }),
  }] })
  await execution.controller.initializeTaskPlan({ commandId: 'approval-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1,
    stages: [{ stageId: 'uat', workflowId: 'approval-fixture', input: { request: '验证UAT3提测', target } }] })
  const started = await execution.controller.advanceTaskPlan(taskId), runId = started.stages[0].runId
  await execution.controller.whenIdle(runId)
  const frozenRun = await execution.controller.state(runId)
  const [frozenEffect] = await execution.store.query({ kind: 'effect.list', runId })
  const currentObjective = '按当前明确要求验证 UAT3 提测结果'
  const revisedGoal = await execution.artifacts.put({ request: currentObjective, objective: currentObjective, target, acceptanceCriteria: ['验证提测结果'] }, { taskId })
  await execution.store.command({ id: 'approval-current-goal', kind: 'task.requirement.update', args: {
    taskId, expectedRequirementRevision: 1, requirementRef: revisedGoal.ref, eventKey: 'approval-current-goal' } })
  const visible = await service.listApprovalRequests()
  assert.equal(visible.length, 1); assert.equal(visible[0].requestId, requestId)
  assert.equal(visible[0].objective, currentObjective); assert.match(visible[0].requestedAction, workflowKind === 'data-change' ? /projects\/flbn\/issues\/857/ : /UAT 目标 dataset-uat3-deployment/)
  assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRevision, 2)
  assert.equal((await execution.controller.state(runId)).run.requirementRef, frozenRun.run.requirementRef)
  assert.deepEqual(await execution.store.query({ kind: 'effect.get', effectId: frozenEffect.effectId }), frozenEffect)
  if (workflowKind !== 'data-change') { assert.match(visible[0].requestedAction, /HiQ-AI\/dataset/); assert.ok(visible[0].evidence.includes(commitSha)) }
  else {
    assert.ok(!visible[0].text.includes('执行 SQL'))
    assert.ok(!visible[0].text.includes(frozenEffect.definition.payload.intent.applySql))
    assert.ok(visible[0].evidence.includes(frozenEffect.definition.payload.intent.applySql))
    assert.match(visible[0].text, /\*\*目标数据库：\*\* production-editor/)
    assert.ok(!visible[0].text.includes('c'.repeat(64)))
    assert.ok(!visible[0].text.includes('d'.repeat(64)))
    if (firstDecision === 'rejected') {
      assert.match(visible[0].text, /\*\*删除影响：\*\* 永久删除该列及其中全部数据；重新添加同名列不能恢复原数据。/)
      assert.equal(visible[0].risk, '永久删除该列及其中全部数据；重新添加同名列不能恢复原数据。')
    } else assert.ok(!visible[0].text.includes('删除影响'))
  }
  assert.match(visible[0].text, /^\*\*待审批：/)
  assert.ok(visible[0].text.includes(`**事项：** ${currentObjective}`))
  assert.ok(visible[0].text.endsWith(`审批编号：${requestId.slice(-12)}`))
  assert.ok(!visible[0].text.includes(requestId))
  assert.equal(visible[0].status, 'pending-send'); assert.equal(sends, 0)
  await assert.rejects(service.decideApproval({ requestId, decision: 'approved', eventId: 'bad-web' }, { channel: 'web', actorId: 'outsider' }), /WORKFLOW_WEB_ACTOR_FORBIDDEN/)
  await assert.rejects(service.decideApproval({ requestId, decision: 'approved', eventId: 'bad-im' }, { channel: 'im', actorId: 'outsider', conversationId: 'web:owner' }), /WORKFLOW_APPROVAL_FORBIDDEN|WORKFLOW_APPROVAL_PRIVATE_REPLY_REQUIRED/)
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId })).decision, 'pending')
  await assert.rejects(execution.store.command({ id: 'old-approval-event', kind: 'task.owner.event', args: {
    taskId, eventKey: `approval:${requestId}:${'c'.repeat(64)}`, eventType: 'approval.resolved' } }), /TASK_OWNER_ID_INVALID/)
  await assert.rejects(service.prepareApprovalNotice({ requestId, recipientUserId: 'outsider', text: visible[0].text }), /WORKFLOW_APPROVAL_FORBIDDEN/)
  await assert.rejects(service.prepareApprovalNotice({ requestId, recipientUserId: 'human-user', text: '篡改审核内容' }), /WORKFLOW_APPROVAL_NOTICE_TEXT_INVALID/)
  if (workflowKind === 'data-change') {
    const notice = (await service.prepareApprovalNotice({ requestId, recipientUserId: 'human-user', text: visible[0].text })).notice
    const noticeDigest = notice.digest
    assert.equal((await service.approvalNoticeCommand('send', { requestId, noticeDigest })).dispatchEligible, true)
    const idempotencyKey = `workflow-approval:${requestId}:${noticeDigest}`
    const recovery = { requestId, noticeDigest, proof: { kind: 'dws-uuid-rejected', idempotencyKey, serverErrorCode: '1001',
      errorMessage: `sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is ${idempotencyKey.length}.`, traceId: 'syntheticrejectiontrace1234' } }
    await assert.rejects(service.reissueApprovalNotice(recovery, { channel: 'web', actorId: 'other' }), /WORKFLOW_WEB_ACTOR_FORBIDDEN/)
    await assert.rejects(service.reissueApprovalNotice(recovery, { channel: 'web', actorId: 'owner' }), /WORKFLOW_APPROVAL_NOTICE_MAINTENANCE_REQUIRED/)
    await execution.store.command({ id: 'notice-repair-maintenance', kind: 'runtime.maintenance.change', args: { expectedRevision: 0, maintenanceId: 'notice-repair', actorId: 'owner', reason: '验证明确未发送收据', active: true } })
    assert.equal((await service.reissueApprovalNotice(recovery, { channel: 'web', actorId: 'owner' })).notice.status, 'prepared')
    assert.equal((await service.reissueApprovalNotice(recovery, { channel: 'web', actorId: 'owner' })).dispatchEligible, false)
    await execution.store.command({ id: 'notice-repair-resume', kind: 'runtime.maintenance.change', args: { expectedRevision: 1, maintenanceId: 'notice-repair', actorId: 'owner', reason: '验证完成', active: false } })
  }
  if (workflowKind === 'uat-rebuild') {
    const notice = (await service.prepareApprovalNotice({ requestId, recipientUserId: 'human-user', text: visible[0].text })).notice
    await execution.controller.pause({ commandId: 'pause-notice', runId, reason: '验证暂停发送' })
    await execution.controller.whenIdle(runId)
    assert.equal((await service.approvalNoticeCommand('send', { requestId, noticeDigest: notice.digest })).dispatchEligible, false)
    assert.equal((await service.getApprovalNotice(requestId)).status, 'prepared')
    await execution.controller.resume({ commandId: 'resume-notice', runId })
    await execution.controller.whenIdle(runId)
  }
  let privateEvent, privateSends = 0
  const bridgeWarnings = []
  const bridgeRuntime = {
    listGroups: () => [], listTasks: () => [], onGroupSubscribed: () => () => {}, onOutboxAppended: () => () => {},
    listAuthorizationRequests: () => service.listApprovalRequests(),
    getWorkflowApprovalRequest: id => service.getApprovalRequest(id), getWorkflowApprovalNotice: id => service.getApprovalNotice(id),
    prepareWorkflowApprovalNotice: args => service.prepareApprovalNotice(args),
    beginWorkflowApprovalNotice: args => service.approvalNoticeCommand('send', args),
    recordWorkflowApprovalNoticeReceipt: args => service.approvalNoticeCommand('receipt', args),
    recordWorkflowApprovalNoticeDelivery: args => service.approvalNoticeCommand('delivered', args),
    recordWorkflowApprovalNoticeRecall: args => service.approvalNoticeCommand('recalled', args),
    decideWorkflowApprovalReply: ({ actorId, conversationId, quoteMessageId, ...input }) => service.decideApproval(input, { channel: 'im', actorId, conversationId, quoteMessageId }),
  }
  const stopBridge = startDwsBridge({ runtime: bridgeRuntime, humanUserId: 'human-user', humanPollIntervalMs: 0,
    groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, logger: { warn: value => bridgeWarnings.push(value) }, adapter: {
      startHumanReplySubscription(handler) { privateEvent = handler; return { stop() {}, done: Promise.resolve() } },
      async sendSelfIntent({ userId, text }) { privateSends++; assert.equal(userId, 'human-user'); assert.equal(text, visible[0].text); return { openTaskId: 'send-task' } },
      async confirmSelfDelivery() { const notice = await service.getApprovalNotice(requestId); assert.equal(notice.delivery.openTaskId, 'send-task'); return { openTaskId: 'send-task', conversationId: 'private-human', messageId: 'approval-message' } },
      async readConversation() { return [] },
    } })
  t.after(stopBridge)
  for (let attempt = 0; attempt < 100 && (await service.listApprovalRequests())[0].status !== 'waiting-reply'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await service.listApprovalRequests())[0].status, 'waiting-reply')
  assert.equal(privateSends, 1); assert.deepEqual(bridgeWarnings, [])
  assert.equal((await service.getApprovalNotice(requestId)).approverActorId, 'owner')
  const privateIdentity = { channel: 'im', actorId: 'owner', conversationId: 'private-human', quoteMessageId: 'approval-message' }
  for (const invalid of [{ ...privateIdentity, actorId: 'outsider' }, { ...privateIdentity, conversationId: 'g' }, { ...privateIdentity, quoteMessageId: 'other-message' }])
    await assert.rejects(service.decideApproval({ requestId, decision: 'approved', eventId: 'invalid-private' }, invalid), /WORKFLOW_APPROVAL_FORBIDDEN/)
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId })).decision, 'pending')
  await privateEvent({ conversation_id: 'private-human', message_id: 'ordinary', sender_open_dingtalk_id: 'owner', content: '看到了', quotedMessage: { messageId: 'approval-message' } })
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId })).decision, 'pending')
  const privateComment = firstDecision === 'rejected' ? '拒绝：请修改目标' : '批准'
  await privateEvent({ conversation_id: 'private-human', message_id: 'first', sender_open_dingtalk_id: 'owner', content: privateComment, quotedMessage: { messageId: 'approval-message' } })
  assert.equal((await execution.store.query({ kind: 'approval.get', requestId })).decision, firstDecision)
  const first = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'first', comment: privateComment }, privateIdentity)
  assert.equal(first.decision, firstDecision); assert.equal(first.applied, true)
  await execution.controller.whenIdle(runId)
  const exactReplay = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'first', comment: privateComment }, privateIdentity)
  assert.deepEqual(exactReplay, first)
  const repeated = await service.decideApproval({ requestId, decision: firstDecision, eventId: 'repeat' }, { channel: 'web', actorId: 'owner' })
  const opposite = await service.decideApproval({ requestId, decision: firstDecision === 'approved' ? 'rejected' : 'approved', eventId: 'opposite' }, privateIdentity)
  assert.equal(repeated.applied, false); assert.equal(opposite.decision, firstDecision); assert.equal(opposite.applied, false)
  assert.equal(sends, firstDecision === 'approved' ? 1 : 0)
  const db = new DatabaseSync(join(execution.artifacts.root, '..', 'control.db'), { readOnly: true })
  try {
    const events = db.prepare("SELECT event_key FROM task_events WHERE task_id=? AND event_type='approval.resolved'").all(taskId)
    assert.equal(events.length, 1); assert.ok(events[0].event_key.length <= 128)
  } finally { db.close() }
  assert.equal((await service.listApprovalRequests())[0].status, 'answered')
  // 相同真实控制账用另一 Web 身份读取：不可见，也不能批准。
  const hidden = await openWorkflowService({ ctx: {}, execution, judge: async () => { throw Error('UNEXPECTED_JUDGE') }, config: { groupIds: ['g'], ownerActorId: 'owner', webActorId: 'other' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }) } })
  try {
    assert.deepEqual(await hidden.listApprovalRequests(), [])
    await assert.rejects(hidden.decideApproval({ requestId, decision: 'approved', eventId: 'hidden' }, { channel: 'web', actorId: 'other' }), /WORKFLOW_APPROVAL_FORBIDDEN/)
  } finally { await hidden.close() }
})

for (const scenario of ['success','resume-success','copied-prefix','handoff-success','handoff-wrong-issue','handoff-missing-event','handoff-unknown','handoff-unsealed','unknown-effect','failed-effect','missing-observation','corrupt-observation','revoked','unapproved','actor-scope','stage-scope','active-node','pending-input','cancelled','wrong-workflow','stale-cas','stale-source','missing-query','stale-query','query-authorization-changed','query-input-changed']) test(`外部成功后的受管只读重评保留效果与审批：${scenario}`, async t => {
  const sessions={async close(){},async run(args){
    await args.onSessionBound()
    const refs=await queryOwnerSources(args)
    const decision={action:'wait',summary:'已核对原文，等待外部事实齐备',evidenceRefs:refs,
      condition:{kind:'execution',missing:'执行回执',responsibleParty:'执行方',resumeWhen:'只读对账后继续',evidenceRefs:refs}}
    await args.onCandidate(decision);return{status:'submitted',decision}
  }}
  const { service, execution, message, root } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' }, taskOwnerSessions:sessions })
  const received = await service.ingest(message), source = await service.messages.process(received.runId)
  const taskId = source.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures,[])
  const plan = await execution.controller.taskPlan(taskId), owner = await execution.store.query({ kind: 'task.owner', taskId })
  const requirement = await execution.artifacts.read(plan.task.requirementRef), instruction = requirement.sourceInstructions[0]
  const sourceCondition = JSON.stringify({ sourceKey: instruction.sourceKey, sourceVersion: instruction.sourceVersion, sourceQuote: instruction.text, objective: '已授权变更' })
  const now = '2026-10-02T00:00:00Z', hash = 'a'.repeat(64), externalId = 'finished-external'
  const observation = JSON.stringify({ effectId: 'finished-effect', status: 'succeeded', evidenceRef: 'proof/observed.json', result: { status: 'succeeded' } })
  const db = new DatabaseSync(join(root, 'control.db'))
  try {
    db.prepare("UPDATE business_tasks SET plan_revision=1,plan_requirement_revision=requirement_revision,status='succeeded' WHERE task_id=?").run(taskId)
    plan.task.planRevision=1
    const workflow = scenario === 'resume-success' || scenario.startsWith('handoff-') ? 'task-data-change-approval-resume' : 'task-data-change'
    db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,created_at,updated_at) VALUES(?,?,?,?,?,'succeeded',?,?)").run(externalId, taskId, workflow, hash, plan.task.requirementRef, now, now)
    db.prepare("INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status,drained) VALUES('finished-node',?,'execute','1','operation',0,1,'proof/input.json',?,'succeeded',1)").run(externalId, hash)
    db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,requirement_ref,gate,status,attempt,run_id,output_ref,source_condition) VALUES(?,?,'finished-stage',1,?,?,?,'none','succeeded',1,?,'proof/external.json',?)").run(taskId, plan.task.planRevision, workflow, hash, plan.task.requirementRef, externalId, sourceCondition)
    db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,request_id,state,result_json,created_at,updated_at) VALUES('finished-effect','operation',?,'finished-node','execute',1,?,?,'{}','[]','finished-approval','succeeded',?,?,?)").run(externalId, hash, hash, observation, now, now)
    db.prepare("INSERT INTO execution_approvals(request_id,effect_id,approver_ids_json,decision,decided_by,decision_source,created_at,updated_at) VALUES('finished-approval','finished-effect','[\"owner\"]','approved','owner','web',?,?)").run(now, now)
    db.prepare("INSERT INTO execution_effect_observations VALUES('finished-receipt','finished-effect',?,?,?)").run(executionDigest(JSON.parse(observation)), observation, now)
    if (scenario.startsWith('handoff-')) {
      const intent = { issueId: 'projects/p/issues/857', planId: 'projects/p/plans/1', sheetId: 'projects/p/sheets/1', applySqlSha256: hash, packageDigest: hash, target: { database: 'db' } }
      db.prepare("UPDATE execution_effects SET definition_json=? WHERE effect_id='finished-effect'").run(JSON.stringify({ payload: { stage: 'execute-task', intent } }))
      db.prepare("UPDATE execution_effects SET node_id='execute-task' WHERE effect_id='finished-effect'").run()
      db.prepare("UPDATE execution_nodes SET node_id='execute-task' WHERE node_run_id='finished-node'").run()
      db.prepare("INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status,drained,output_ref) VALUES('frozen-old',?,'freeze-existing-issue','1','code',1,1,'proof/input.json',?,'succeeded',1,'proof/frozen.json')").run(externalId, hash)
      db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,stop_requested,created_at,updated_at) VALUES('old-handoff',?,'task-data-change',?,?,'cancelled',1,?,?)").run(taskId, hash, plan.task.requirementRef, now, now)
      const proof = { kind: 'data-change-approval-handoff', taskId, originalRunId: 'old-handoff', originalGeneration: 1, originalRequirementRef: plan.task.requirementRef, effectId: 'old-gate', nodeRunId: 'old-gate-node', inputDigest: hash, effectDigest: executionDigest({}),
        view: { issue: { id: intent.issueId }, plan: { id: intent.planId }, sheet: { id: intent.sheetId }, prepared: { package: { applySqlSha256: hash, validation: { packageDigest: hash }, target: intent.target } } } }
      for (const [effectId,nodeId,nodeRunId,status,result] of [['old-gate','approval-gate','old-gate-node','failed',{ reason: 'APPROVAL_CHANNEL_SUPERSEDED', result: proof }],['old-created','create-issue','old-created-node','succeeded',{ result: { issueId: intent.issueId } }]]) {
        db.prepare("INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status,drained) VALUES(?,'old-handoff',?,'1','operation',?,1,'proof/old.json',?,?,1)").run(nodeRunId, nodeId, nodeId === 'approval-gate' ? 0 : 1, hash, status === 'failed' ? 'cancelled' : 'succeeded')
        const record = JSON.stringify({ effectId, status, evidenceRef: 'proof/handoff.json', result })
        db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,result_json,created_at,updated_at) VALUES(?,'operation','old-handoff',?,?,1,?,?,'{}','[]','source',?,?,?,?)").run(effectId, nodeRunId, nodeId, hash, hash, status, record, now, now)
        db.prepare('INSERT INTO execution_effect_observations VALUES(?,?,?,?,?)').run(effectId+'-receipt',effectId,executionDigest(JSON.parse(record)),record,now)
      }
      db.prepare("INSERT INTO task_events(task_id,event_key,event_type,payload_ref,created_at,handled_at) VALUES(?,'original-handoff','approval.channel.changed','proof/handoff-event.json',?,?)").run(taskId, now, now)
      db.prepare("INSERT INTO execution_receipts VALUES('original-handoff:stop',?,?,?)").run(hash,JSON.stringify({run:{runId:'old-handoff',taskId,requirementRef:plan.task.requirementRef,generation:1,stopRequested:true,recoveryReason:JSON.stringify({kind:'approval-channel-handoff'})}}),now)
      if (scenario === 'handoff-wrong-issue') db.prepare("UPDATE execution_effects SET definition_json=json_set(definition_json,'$.payload.intent.issueId','another') WHERE effect_id='finished-effect'").run()
      if (scenario === 'handoff-missing-event') db.prepare("DELETE FROM task_events WHERE event_key='original-handoff'").run()
      if (scenario === 'handoff-unknown') db.prepare("UPDATE execution_effects SET state='unknown' WHERE effect_id='old-created'").run()
      if (scenario === 'handoff-unsealed') db.prepare("UPDATE execution_runs SET stop_requested=0 WHERE run_id='old-handoff'").run()
    }
    const mutations = {
      'unknown-effect': "UPDATE execution_effects SET state='unknown'", 'failed-effect': "UPDATE execution_effects SET state='failed'",
      'missing-observation': 'DELETE FROM execution_effect_observations', revoked: 'UPDATE execution_approvals SET revoked=1',
      'corrupt-observation': "UPDATE execution_effect_observations SET payload_digest='" + 'b'.repeat(64) + "'",
      unapproved: "UPDATE execution_approvals SET decision='pending'", 'actor-scope': "UPDATE execution_approvals SET decided_by='other'",
      'stage-scope': "UPDATE task_plan_stages SET source_condition='{}' WHERE stage_id='finished-stage'",
      'active-node': "UPDATE execution_nodes SET drained=0 WHERE node_run_id='finished-node'",
      cancelled: "UPDATE task_controls SET state='cancelled' WHERE task_id='" + taskId + "'",
      'wrong-workflow': "UPDATE execution_runs SET workflow_id='task-release' WHERE run_id='finished-external'",
    }
    if (scenario==='missing-query') db.prepare("DELETE FROM task_events WHERE task_id=? AND event_type='query.succeeded'").run(taskId)
    if (scenario==='stale-query') db.prepare("UPDATE task_owner_turns SET requirement_revision=requirement_revision+1 WHERE task_id=?").run(taskId)
    if (scenario==='query-authorization-changed') db.prepare("UPDATE task_owners SET authorization_revision=authorization_revision+1 WHERE task_id=?").run(taskId)
    if (scenario==='query-input-changed') db.prepare("UPDATE task_owners SET input_fence_revision=input_fence_revision+1 WHERE task_id=?").run(taskId)
    if (mutations[scenario]) db.exec(mutations[scenario])
    if (scenario === 'copied-prefix') {
      db.prepare('INSERT INTO task_plan_stages SELECT task_id,plan_revision+1,stage_id,position,workflow_id,workflow_digest,unavailable_reason,requirement_ref,predecessor_output_ref,gate,status,attempt,run_id,output_ref,evidence_refs,confirmed_output_ref,source_condition FROM task_plan_stages WHERE task_id=? AND plan_revision=?').run(taskId, plan.task.planRevision)
      db.prepare('UPDATE business_tasks SET plan_revision=plan_revision+1 WHERE task_id=?').run(taskId)
    }
    if (scenario === 'pending-input') db.prepare("INSERT INTO execution_inputs(run_id,input_id,source_key,requirement_ref,status,accepted_at) VALUES(?,'pending','pending',?,'pending',?)").run(externalId, plan.task.requirementRef, now)
    const snapshot = () => JSON.stringify({ stages: db.prepare('SELECT * FROM task_plan_stages WHERE task_id=?').all(taskId), effects: db.prepare('SELECT * FROM execution_effects').all(), approvals: db.prepare('SELECT * FROM execution_approvals').all() })
    const before = snapshot()
    const args = { taskId, eventKey: 'post-external-readonly', payloadRef: plan.task.requirementRef, expectedOwnerRevision: owner.revision, expectedLeaseEpoch: owner.leaseEpoch,
      expectedRequirementRevision: plan.task.requirementRevision, expectedControlRevision: plan.task.controlRevision, requestDigest: hash,
      sources: requirement.sourceInstructions.map(instruction => ({ sourceKey: instruction.sourceKey, sourceVersion: instruction.sourceVersion, actorId: instruction.actorId, bodyDigest: executionDigest(instruction.text) })) }
    if (scenario === 'stale-cas') args.expectedOwnerRevision++
    if (scenario === 'stale-source') args.sources[0].bodyDigest = 'f'.repeat(64)
    const send = () => execution.store.command({ id: 'post-external-readonly', kind: 'task.owner.reassess', args })
    if (['success', 'resume-success', 'copied-prefix', 'handoff-success'].includes(scenario)) {
      const receipt = await send()
      assert.equal(receipt.result.status, 'pending')
      assert.equal(db.prepare('SELECT event_type FROM task_events WHERE task_id=? AND seq=?').get(taskId, receipt.result.eventSeq).event_type, 'system.recovery')
      assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).sessionId, owner.sessionId)
    } else await assert.rejects(send(), /REASSESS_FORBIDDEN|REASSESS_STALE|SOURCE_STALE/u)
    assert.equal(snapshot(), before)
  } finally { db.close() }
})


test('新v5数据变更仍经过实际Host原生证明选择，缺原节点不能退回通用领域合同', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    taskOwnerSessions: { async run() { throw new Error('未核验原始证明不得进入Owner模型') }, async close() {} },
  })
  execution.controller.registerWorkflow({ id: 'task-data-change', version: 'fixture',
    ownerContract: { id: 'external-result', version: '5', async validateCompletion() { return true } },
    nodes: [{ id: 'fake-final', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema,
      outputSchema: schema, mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '仅普通正文' }) }] })
  const received=await service.ingest({...message,text:'精确生产回查'})
  const source=await service.messages.process(received.runId)
  const taskId=source.commands[0].result.taskId
  await execution.controller.initializeTaskPlan({ commandId: 'v5-plan', taskId, expectedPlanRevision: 0,
    expectedRequirementRevision: 1, expectedControlRevision: 1, stages: [{ stageId: 'v5-stage', workflowId: 'task-data-change', input: {} }] })
  await execution.controller.advanceTaskPlan(taskId)
  const plan = await execution.controller.taskPlan(taskId)
  await execution.controller.whenIdle(plan.stages[0].runId)
  await execution.controller.advanceTaskPlan(taskId)
  await settleTaskOwners(service, execution)
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).lastFailure, 'DATA_CHANGE_COMPLETION_NODE_INVALID')
})


for (const verdict of [true, false]) test(`真实Task直接查询与前序受管执行共同最终验收一次：${verdict?'接纳':'事实不足拒绝'}`,async t=>{
  const criteria=['精确执行并回查表存在且列不存在','本次审批告知永久丢失数据']
  const server=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({tableExists:true,columnExists:false}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  let checks=0,taskId
  const sessions={async close(){},async run(args){
    await args.onSessionBound()
    const {binding,input,tools,queryInput,onQueryEvidence,onCandidate}=args
    const result=await tools.find(item=>item.name==='query_runtime_status').execute({binding,input:queryInput,args:{resourceId:'composite-readback'}})
    await onQueryEvidence({binding:Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key=>[key,binding[key]])),evidenceRef:result.evidenceRef})
    const refs=[input.stages[0].outputRef,result.evidenceRef]
    const decision={action:'complete',summary:'前序执行事实和当前只读结果联合核验',evidenceRefs:refs,
      assessments:input.acceptanceItems.map((item,index)=>({itemId:item.itemId,status:'satisfied',evidenceRefs:index===0?refs:refs.slice(0,1)}))}
    await onCandidate(decision);return{status:'submitted',decision}
  }}
  const {service,execution,message}=await fixture(t,'owner',undefined,{taskOwnerSessions:sessions,
    config:{directQueries:{resources:[],databases:[],statusResources:[{id:'composite-readback',url:`http://127.0.0.1:${server.address().port}/readback`,fields:['tableExists','columnExists']}],permissions:{resourceIds:[],databaseIds:[],statusIds:['composite-readback']}}},
    judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['本次事项']}:
      {kind:'intent',actions:[{intent:'create',arguments:{objective:'复合验收',acceptanceCriteria:criteria},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'},
    generalCompletionCheck:async input=>{
      checks++;assert.deepEqual(input.acceptanceItems.map(item=>item.itemId),['acceptance-1','acceptance-2']);assert.equal(input.evidence.length,2)
      const query=input.evidence.find(item=>item.hostQuery),ext=input.evidence.find(item=>item.hostExecution)
      assert.equal(query.hostQuery.taskId,taskId);assert.equal(ext.hostExecution.taskId,taskId)
      assert.deepEqual(query.result.values,{tableExists:true,columnExists:false});assert.equal(ext.executed,true)
      return{status:verdict?'satisfied':'unsatisfied',resultVerified:verdict,criteria:input.acceptanceItems.map(item=>({criterion:item.criterion,passed:verdict,evidenceIds:item.evidenceRefs}))}
    }})
  execution.controller.registerWorkflow({id:'fixture-external',version:'1',ownerContract:{id:'external-result',version:'2',async validateCompletion(context){return context.output.executed===true&&await context.verifyAcceptance(context)}},
    nodes:[{id:'execute',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:({requirement})=>requirement,execute:async()=>({executed:true,summary:'测试受管执行与批准事实'})}]})
  const received=await service.ingest({...message,text:'复合验收'}),state=await service.messages.process(received.runId);taskId=state.commands[0].result.taskId
  const initial=await execution.controller.taskPlan(taskId)
  await execution.controller.initializeTaskPlan({commandId:'composite-plan',taskId,expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'execute',workflowId:'fixture-external',input:{}}]})
  const started=await execution.controller.advanceTaskPlan(taskId)
  await execution.controller.whenIdle(started.stages[0].runId);await execution.controller.advanceTaskPlan(taskId)
  const failures=(await settleTaskOwners(service, service.execution)).failures,owner=await execution.store.query({kind:'task.owner',taskId})
  if(verdict){assert.deepEqual(failures,[]);assert.equal(owner.decision.action,'complete')}
  else {assert.equal(owner.lastFailure,'TASK_OWNER_COMPLETION_UNVERIFIED');assert.notEqual(owner.decision?.action,'complete')}
  assert.equal(checks,1)
  assert.equal((await execution.controller.taskPlan(taskId)).stages.length,1)
  assert.equal((await execution.store.query({kind:'run.list',taskId})).length,1)
  assert.equal((await execution.controller.taskPlan(taskId)).task.requirementRef,initial.task.requirementRef)
})

for (const reopen of [false, true]) test(`任务直接调查真实登记状态查询入账，无业务Run且${reopen ? '重启后' : '同会话'}唯一完成`, async t => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', secret: '不应透出' })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const queryConfig = { resources: [], databases: [], statusResources: [{ id: 'test-health',
    url: `http://127.0.0.1:${server.address().port}/health`, fields: ['status'] }],
    permissions: { resourceIds: [], databaseIds: [], statusIds: ['test-health'] } }
  const sent = []
  const notifications = { canDisclose: async () => true, send: async notice => { sent.push(notice); return { messageId: notice.id } },
    readback: async notice => ({ messageId: notice.id, conversationId: 'g' }) }
  let calls = 0, checks = 0, lastBinding, lastEvidenceRef
  const sessions = { async close() {}, async run({ binding, input, tools, queryInput, readArtifact, onSessionBound, onQueryEvidence, onCandidate }) {
    await onSessionBound(); calls++
    assert.deepEqual(input.stages, [])
    let refs = input.queryEvidence.map(item => item.evidenceRef)
    for (const ref of refs) await readArtifact(ref)
    if (!refs.length) {
      const tool = tools.find(item => item.name === 'query_runtime_status')
      assert.ok(tool, JSON.stringify(tools.map(item => item.name)))
      await assert.rejects(tool.execute({ binding, input: queryInput, args: { resourceId: 'not-authorized' } }), { code: 'QUERY_SCOPE_DENIED' })
      const queried = await tool.execute({ binding, input: queryInput, args: { resourceId: 'test-health' } })
      assert.deepEqual(queried.result.values, { status: 'ok' })
      const identity = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key, binding[key]]))
      await assert.rejects(onQueryEvidence({ binding: { ...identity, taskId: 'another-task' }, evidenceRef: queried.evidenceRef }), { code: 'TASK_OWNER_QUERY_EVIDENCE_INVALID' })
      await assert.rejects(onQueryEvidence({ binding: { ...identity, requirementRevision: binding.requirementRevision - 1 }, evidenceRef: queried.evidenceRef }), { code: 'TASK_OWNER_QUERY_EVIDENCE_INVALID' })
      assert.deepEqual((await f.execution.artifacts.read(queried.evidenceRef)).execution, identity)
      await onQueryEvidence({ binding: identity, evidenceRef: queried.evidenceRef })
      refs = [queried.evidenceRef]; lastBinding = binding; lastEvidenceRef = queried.evidenceRef
      if (reopen) {
        const decision = { action: 'wait', summary: '测试重启持久读取', evidenceRefs: refs,
          condition: { kind: 'business-input', missing: '测试重新接入', responsibleParty: '测试', resumeWhen: '恢复后验证', evidenceRefs: refs } }
        await onCandidate(decision); return { status: 'submitted', decision }
      }
    }
    const decision = { action: 'complete', summary: '登记状态端点返回ok', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '确认状态端点返回ok' }, dependsOn: [] }],
      constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  const generalCompletionCheck = async input => {
    checks++; assert.equal(input.evidence.length, 1); assert.equal(input.evidence[0].result.values.status, 'ok')
    assert.ok(input.evidence[0].hostQuery.taskId)
    return { status: 'satisfied', resultVerified: true, criteria: input.acceptanceItems.map(item => ({ criterion: item.criterion,
      passed: true, evidenceIds: item.evidenceRefs })) }
  }
  const f = await fixture(t, 'owner', notifications, { judge, taskOwnerSessions: sessions, taskFiles: true,
    config: { directQueries: queryConfig }, generalCompletionCheck })
  let service = f.service
  const source = await service.ingest({ ...f.message, text: '确认状态端点返回ok' })
  const state = await service.messages.process(source.runId), taskId = state.commands[0].result.taskId
  await settleTaskOwners(service, service.execution)
  if (reopen) {
    await service.close()
    service = await openWorkflowService({ ctx: { sessions: { get: () => ({ snapshotEvents: () => [] }) } },
      config: { groupIds: ['g'], ownerActorId: 'owner', directQueries: queryConfig },
      legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'] }), getGroup: () => ({ groupId: 'g', messages: [] }) },
      execution: f.execution, notifications, taskOwnerSessions: sessions, generalCompletionCheck, generalCompletionIdentity: 'test-general-completion-v1',
      coordinatorSessions: { async close() {} } })
    t.after(async () => service.close())
    const proof = await f.execution.store.query({ kind: 'task.owner.query-evidence', taskId, requirementRevision: lastBinding.requirementRevision })
    assert.equal(proof[0].artifactRef, lastEvidenceRef)
    await f.execution.store.command({ id: 'direct-restart-wake', kind: 'task.owner.event', args: { taskId, eventKey: 'direct-restart-wake', eventType: 'system.recovery' } })
    await settleTaskOwners(service, service.execution)
  }
  const owner = await f.execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision?.action, 'complete', JSON.stringify(owner))
  assert.deepEqual(await f.execution.store.query({ kind: 'run.list', taskId }), [])
  assert.deepEqual((await f.execution.controller.taskPlan(taskId)).stages, [])
  assert.equal(checks, 1)
  assert.equal((await f.execution.store.query({ kind: 'task.owner.reports', taskId })).filter(report => report.reportType === 'complete').length, 1)
  const paths = await (await import('node:fs/promises')).readdir(f.root, { recursive: true })
  assert.equal(paths.some(path => path.includes('task-investigation')), false)
  await settleTaskOwners(service, service.execution)
  const notifyResult = await service.flushNotifications()
  assert.equal(sent.length, 1, JSON.stringify({notifyResult, reports: await f.execution.store.query({kind:'task.owner.reports',taskId}), sourceState: await service.messages.state(source.runId), records: await f.execution.store.query({kind:'message.notifications'})}))
  await settleTaskOwners(service, service.execution)
  assert.equal(checks, 1)
  await service.flushNotifications()
  assert.equal(sent.length, 1)
})

test('任务直接调查慢回合不堵消息接纳或其它任务完成，暂停中断同一Owner', async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const sessions = { async close() {}, async run({ binding, input, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate, signal }) {
    await onSessionBound()
    if (input.goal.request === '慢调查') {
      entered(); signal.addEventListener('abort', release, { once: true }); await gate; signal.throwIfAborted()
    }
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    const decision = { action: 'complete', summary: '依据原文完成调查', evidenceRefs: refs,
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.source.text.includes('暂停') ? { kind: 'binding', disposition: 'existing',
      candidateId: input.candidates.find(item => item.goal === '慢调查').candidateId, evidence: ['指定慢调查'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['独立目标'] }
    : { kind: 'intent', actions: [{ intent: input.text.includes('暂停') ? 'pause' : 'create',
      arguments: input.text.includes('暂停') ? {} : { objective: input.text }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions })
  const first = await service.ingest({ ...message, text: '慢调查' }), firstState = await service.messages.process(first.runId)
  assert.equal(firstState.run.status, 'settled'); assert.equal(firstState.commands[0].result.runId, null)
  const slow = firstState.commands[0].result.taskId
  const second = await service.ingest({ ...message, messageId: 'fast-owner', text: '快调查' }), secondState = await service.messages.process(second.runId)
  assert.equal(secondState.run.status, 'settled')
  const fast = secondState.commands[0].result.taskId
  const recovering = service.recoverExecutionTasks()
  await started
  let fastOwner
  for (let attempt = 0; attempt < 100; attempt++) {
    fastOwner = await execution.store.query({ kind: 'task.owner', taskId: fast })
    if (fastOwner.applicationStatus === 'applied') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(fastOwner.decision?.action, 'complete', JSON.stringify(fastOwner)); assert.equal(fastOwner.applicationStatus, 'applied')
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId: slow })).status, 'running')
  const pause = await service.ingest({ ...message, messageId: 'pause-slow', text: '暂停慢调查' })
  const paused = await service.messages.process(pause.runId)
  assert.equal(paused.commands[0].status, 'applied', JSON.stringify(paused.commands[0]))
  await recovering
  assert.equal((await execution.controller.taskPlan(slow)).task.controlState, 'paused')
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

test('任务直接调查同族重执行复用工件目录，拒绝兄弟任务的查询证明', async t => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  let firstProof
  const sessions = { async close() {}, async run({ input, binding, tools, queryInput, onSessionBound, onQueryEvidence, onCandidate }) {
    await onSessionBound()
    const identity = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key,binding[key]]))
    if (firstProof) await assert.rejects(onQueryEvidence({ binding: identity, evidenceRef: firstProof }), { code: 'TASK_OWNER_QUERY_EVIDENCE_INVALID' })
    const value = await tools.find(tool => tool.name === 'query_runtime_status').execute({ binding, input: queryInput, args: { resourceId: 'family-health' } })
    await onQueryEvidence({ binding: identity, evidenceRef: value.evidenceRef })
    firstProof ??= value.evidenceRef
    const decision = { action: 'complete', summary: '状态为ok', evidenceRefs: [value.evidenceRef], assessments: input.acceptanceItems.map(item => ({
      itemId: item.itemId, status: 'satisfied', evidenceRefs: [value.evidenceRef] })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const f = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions, config: { directQueries: {
    resources: [], databases: [], statusResources: [{ id: 'family-health', url: `http://127.0.0.1:${server.address().port}/health`, fields: ['status'] }],
    permissions: { resourceIds: [], databaseIds: [], statusIds: ['family-health'] } } } })
  const received = await f.service.ingest(f.message), processed = await f.service.messages.process(received.runId)
  const original = processed.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(f.service, f.execution)).failures, [])
  const originalPlan = await f.execution.controller.taskPlan(original), newTaskId = 'family-rerun'
  const goal = await f.execution.artifacts.read(originalPlan.task.requirementRef)
  const saved = await f.execution.artifacts.put({ ...goal, reportChannel: 'web', externalMessaging: false,
    scope: { ...goal.scope, conversationId: 'web:owner', sourceKeys: ['web-rerun:family'], sourceVersions: { 'web-rerun:family': 1 } } },
    { taskId: newTaskId, reference: originalPlan.task.requirementRef })
  await f.execution.store.command({ id: 'family-rerun-accept', kind: 'task.web-rerun.accept', args: { taskId: newTaskId, rerunOfTaskId: original,
    actorId: 'owner', request: { expectedRunId: null, objective: goal.request, stages: [] }, requirementRef: saved.ref, criteria: goal.acceptanceCriteria, sourceKey: 'web-rerun:family' } })
  assert.deepEqual((await settleTaskOwners(f.service, f.execution)).failures, [])
  const owner = await f.execution.store.query({ kind: 'task.owner', taskId: newTaskId })
  assert.equal(owner.decision.action, 'complete'); assert.equal(owner.applicationStatus, 'applied')
  const [proof] = await f.execution.store.query({ kind: 'task.owner.query-evidence', taskId: newTaskId })
  assert.ok(proof.artifactRef.startsWith(`tasks/${original}/`))
  assert.equal((await f.execution.artifacts.read(proof.artifactRef)).execution.taskId, newTaskId)
  assert.notEqual(proof.artifactRef, firstProof)
  assert.deepEqual(await f.execution.store.query({ kind: 'run.list' }), [])
})


test('跨轮直接查询仅向Owner投影证明身份，完整结果须按引用读取', async t => {
  const body = '只读核验此业务原文。'.repeat(300)
  let proof, turns = 0
  const sessions = { async close() {}, async run(args) {
    const { input, readArtifact, onSessionBound, onCandidate } = args
    await onSessionBound(); turns++
    let refs
    if (turns === 1) refs = await queryOwnerSources(args)
    else {
      assert.equal(input.queryEvidence.length, 1)
      const metadata = input.queryEvidence[0]
      assert.equal(metadata.artifactRef, proof); assert.equal(metadata.evidenceRef, proof)
      assert.equal(metadata.taskId, args.binding.taskId)
      assert.equal(metadata.requirementRevision, args.binding.requirementRevision)
      assert.equal(Object.hasOwn(metadata, 'result'), false)
      assert.equal(Object.hasOwn(metadata, 'evidence'), false)
      assert.ok(JSON.stringify(metadata).length < 1024)
      const artifact = await readArtifact(proof)
      assert.equal(artifact.result.sources[0].text, body)
      refs = [proof]
    }
    proof ??= refs[0]
    const decision = turns === 1
      ? { action: 'wait', summary: '等待业务选择', evidenceRefs: refs, condition: {
        kind: 'business-input', missing: '选择方案', responsibleParty: '交办人', resumeWhen: '确认后继续', evidenceRefs: refs } }
      : { action: 'complete', summary: '原文已核验', evidenceRefs: refs,
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions,
    judge: async ({ stage, input }) => stage === 'S'
      ? { ...splitOne(input.source.text), units: [{ ...splitOne(input.source.text).units[0], goalText: '核验原文' }] }
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前来源'] }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理本条材料' }, dependsOn: [] }],
          constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } })
  const accepted = await service.ingest({ ...message, text: body })
  const state = await service.messages.process(accepted.runId), taskId = state.commands[0].result.taskId
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  await execution.store.command({ id: 'slim-query-answer', kind: 'task.owner.event', args: {
    taskId, eventKey: 'slim-query-answer', eventType: 'task.context' } })
  assert.deepEqual((await settleTaskOwners(service, service.execution)).failures, [])
  assert.equal(turns, 2)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision.action, 'complete'); assert.equal(owner.applicationStatus, 'applied')
  const records = await execution.store.query({ kind: 'task.owner.query-evidence', taskId })
  assert.deepEqual(records.map(item => item.artifactRef), [proof])
  assert.equal((await execution.artifacts.read(proof)).result.sources[0].text, body)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
})


test('Markdown能力真实回执投影文件证明，未核验结果不声明保存完成', () => {
  const envelope = { capabilityId: 'write-task-markdown', output: { status: 'succeeded', result: {
    path: 'D:/task/outputs/note.md', bytes: 34, contentDigest: 'abc123' } }, verification: { passed: true } }
  const result = describeTaskNodeOutput({ nodeId: 'execute' }, envelope)
  assert.equal(result.overview, 'Markdown 文件已保存并独立读回')
  assert.match(result.text, /D:\/task\/outputs\/note.md/)
  assert.match(result.text, /34 字节/); assert.match(result.text, /SHA-256\nabc123/)
  const unverified = describeTaskNodeOutput({ nodeId: 'execute' }, { ...envelope, verification: { passed: false } })
  assert.doesNotMatch(unverified.overview, /已保存/)
})

test('开发缺UAT先承接并等待具体环境，补充后原Task恢复且不提前准备工程', async t => {
  const root = await mkdtemp(join(tmpdir(), 'engineering-input-service-'))
  const source = join(root, 'source'), managedRoot = join(root, 'managed')
  await mkdir(source); await mkdir(managedRoot)
  await writeFile(join(source, 'value.txt'), 'unchanged')
  const first = '按文档开发', second = '目标环境使用uat2'
  const snapshots = []
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: input.candidates.length ? 'existing' : 'new', candidateId: input.candidates[0]?.candidateId ?? null, evidence: ['同一开发事项补充环境'] }
      : { kind: 'intent', actions: [{ intent: input.text === first ? 'create' : 'revise', arguments: {
        objective: first, repositoryId: 'repo', ...(input.text === second ? { uatEnvironment: 'uat2' } : {}),
      }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const sessions = { async close() {}, async run({ input, binding, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound()
    snapshots.push({ taskId: input.task.taskId, target: input.goal.target, revision: input.task.requirementRevision })
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    if (!input.goal.target.uatEnvironment) await assert.rejects(onCandidate({ action: 'advance', summary: '准备开发', evidenceRefs: refs,
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-engineering', gate: 'none' }] },
    }), { code: 'TASK_OWNER_ENGINEERING_INPUT_REQUIRED' })
    const decision = { action: 'wait', evidenceRefs: refs,
      summary: input.goal.target.uatEnvironment ? '已读取补充环境，继续核对文档' : '请指定本任务目标UAT环境',
      condition: input.goal.target.uatEnvironment
        ? { kind: 'execution', missing: '文档核对结果', responsibleParty: '执行方', resumeWhen: '文档核对后继续工程准备', evidenceRefs: refs }
        : { kind: 'business-input', missing: 'uatEnvironment', responsibleParty: '交办人', resumeWhen: '目标UAT补入当前Task需求后继续', evidenceRefs: refs } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { root, judge, taskOwnerSessions: sessions,
    config: { repositories: [{ id: 'repo', sourceRepository: source, managedRoot, remote: source,
      githubRepository: 'test/repo', baseRef: 'main', editablePaths: ['value.txt'],
      checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] } })
  const received = await service.ingest({ ...message, text: first })
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.requests.length, 0)
  const taskId = state.commands[0].args.taskId
  for (let attempt = 0; attempt < 100 && !(await execution.store.query({ kind: 'task.owner', taskId })).decision; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.ok(owner.decision, JSON.stringify(owner))
  assert.equal(owner.decision.action, 'wait')
  assert.equal(owner.decision.condition.missing, 'uatEnvironment')
  assert.equal((await execution.controller.taskPlan(taskId)).stages.length, 0)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 0)
  const continued = await service.ingest({ ...message, messageId: 'engineering-uat-answer', text: second })
  const revised = await service.messages.process(continued.runId)
  assert.equal(revised.commands[0].kind, 'revise')
  assert.equal(revised.commands[0].status, 'applied')
  assert.equal(revised.commands[0].args.taskId, taskId)
  const plan = await execution.controller.taskPlan(taskId), requirement = await execution.artifacts.read(plan.task.requirementRef)
  assert.equal(requirement.target.uatEnvironment, 'uat2')
  assert.equal(plan.task.requirementRevision, 2)
  assert.equal((await service.tasks()).length, 1)
  for (let attempt = 0; attempt < 100 && (await execution.store.query({ kind: 'task.owner', taskId })).decision?.condition?.kind !== 'execution'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.condition.kind, 'execution')
  assert.ok(snapshots.some(item => item.taskId === taskId && item.revision === 2 && item.target.uatEnvironment === 'uat2'))
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(managedRoot), [])
  assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'unchanged')
})


test('非owner获批后补环境保留原Task承接授权，新增外部阶段仍拒绝', async t => {
  let revisedTaskId, checkedExternal = 0
  const sessions = { async close() {}, async run(args) {
    await args.onSessionBound()
    const refs = await queryOwnerSources(args)
    if(args.input.goal.target.uatEnvironment){
      await assert.rejects(args.onCandidate({ action:'advance',summary:'尝试生产数据变更',evidenceRefs:refs,
        planChange:{kind:'initialize',stages:[{workflowId:'task-data-change',gate:'none'}]} }),{code:'TASK_OWNER_STAGE_NOT_AUTHORIZED'})
      checkedExternal++
    }
    const decision={action:'wait',summary:'继续核对当前事项',evidenceRefs:refs,
      condition:{kind:'business-input',missing:'核对结果',responsibleParty:'交办人',resumeWhen:'核对后继续',evidenceRefs:refs}}
    await args.onCandidate(decision);return{status:'submitted',decision}
  } }
  const f=await fixture(t,'guest',undefined,{taskOwnerSessions:sessions,coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
    const candidate=input.candidates.find(item=>revisedTaskId?item.taskId===revisedTaskId:item.topicId&&!item.taskId)
    return coordinatorUnit(source,revisedTaskId?'revise':'create',{objective:'按文档开发',...(revisedTaskId?{uatEnvironment:'uat2'}:{})},candidate?{disposition:'existing',candidateId:candidate.candidateId}:undefined)
  })})
  const received=await f.service.ingest({...f.message,text:'按文档开发'})
  const request=(await f.service.messages.process(received.runId)).requests[0]
  await f.service.resumeRequest({runId:received.runId,requestId:request.id,eventId:'grant',answer:'同意'},{channel:'im',actorId:'owner',conversationId:'g'})
  const accepted=await f.service.messages.process(received.runId)
  revisedTaskId=accepted.commands[0].args.taskId
  assert.equal(accepted.commands[0].status,'applied')
  await settleTaskOwners(f.service,f.execution)
  const reply=await f.service.ingest({...f.message,messageId:'environment-reply',text:'目标环境使用uat2'})
  const revised=await f.service.messages.process(reply.runId)
  assert.equal(revised.commands[0].status,'applied')
  assert.equal(revised.commands[0].args.taskId,revisedTaskId)
  await settleTaskOwners(f.service,f.execution)
  const plan=await f.execution.controller.taskPlan(revisedTaskId),requirement=await f.execution.artifacts.read(plan.task.requirementRef)
  assert.equal(requirement.authorization.ownerConfirmed,true)
  assert.equal(requirement.target.uatEnvironment,'uat2')
  assert.equal(plan.task.requirementRevision,2)
  assert.equal((await f.service.tasks()).length,1)
  assert.ok(checkedExternal>0)
  assert.deepEqual(plan.stages,[])
  assert.deepEqual(await f.execution.store.query({kind:'run.list',taskId:revisedTaskId}),[])
})

test('旧授权过期后再次批准当前授权，只创建一次Task',async t=>{
  const f=await fixture(t,'guest',undefined,{coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
    const topic=input.candidates.find(item=>item.topicId&&!item.taskId)
    return coordinatorUnit(source,'create',{objective:'核对这份材料'},topic?{disposition:'existing',candidateId:topic.candidateId}:undefined)
  })})
  const received=await f.service.ingest({...f.message,text:'核对这份材料'})
  const first=(await f.service.messages.process(received.runId)).requests[0]
  const approve=request=>f.service.resumeRequest({runId:received.runId,requestId:request.id,eventId:`grant-${request.id}`,answer:'同意'},{channel:'im',actorId:'owner',conversationId:'g'})
  // 模拟批准已持久化、协调恢复前新的同话题输入到达。
  await f.execution.store.command({id:'persist-first-grant',kind:'message.wake',args:{runId:received.runId,requestId:first.id,actorId:'owner',eventId:'first-grant',answer:'approved'}})
  const extra=await f.service.messages.receive({sourceKey:'new-topic-input',sourceVersion:1,actorId:'guest',conversationId:'g',body:'收到',context:{}},{process:false})
  await f.execution.store.command({id:'extra-split',kind:'message.split',args:{runId:extra.run.runId,units:[{unitId:'extra-unit'}]}})
  await f.execution.store.command({id:'extra-bind',kind:'message.topic.bind',args:{runId:extra.run.runId,unitId:'extra-unit',expectedRevision:0,binding:{kind:'binding',disposition:'conversation',candidateId:null},topic:{topicId:first.authorization.topicId,conversationId:'g',sourceRunId:extra.run.runId,unitId:'extra-unit',title:'核对材料',facts:[]}}})
  await f.execution.store.command({id:'extra-quiet',kind:'message.accept',args:{runId:extra.run.runId,unitId:'extra-unit',commands:[],outcome:'ignored'}})
  const next=await f.service.messages.process(received.runId)
  const second=next.requests.find(item=>item.status==='pending')
  assert.ok(second&&second.id!==first.id)
  await approve(second)
  const final=await f.service.messages.process(received.runId)
  assert.equal(final.commands.length,1)
  assert.equal(final.commands[0].status,'applied')
  assert.equal(final.commands[0].args.authorizationRequestId,second.id)
  await approve(second)
  assert.equal((await f.service.tasks()).length,1)
})

test('明确开发缺目标仓库先通过协调schema承接，Owner读取来源后等待仓库且无工程副作用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'engineering-repository-input-'))
  const source = join(root, 'source'), managedRoot = join(root, 'managed')
  await mkdir(source); await mkdir(managedRoot)
  await writeFile(join(source, 'value.txt'), 'unchanged')
  const body = '按文档开发，目标环境uat2'
  const intent = { kind: 'intent', actions: [{ intent: 'create', arguments: {
    objective: '按文档开发', workflowId: 'task-engineering', uatEnvironment: 'uat2',
  }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  assert.equal(messageSchemas.I.safeParse(intent).success, true)
  let sourceRead = false
  const sessions = { async close() {}, async run({ input, binding, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound()
    assert.equal(input.goal.target.repositoryId, undefined)
    assert.equal(input.goal.target.uatEnvironment, 'uat2')
    const refs = await queryOwnerSources({ binding, tools, queryInput, onQueryEvidence })
    assert.ok(refs.length)
    sourceRead = true
    await assert.rejects(onCandidate({ action: 'advance', summary: '准备开发', evidenceRefs: refs,
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-engineering', gate: 'none' }] },
    }), error => error.code === 'TASK_OWNER_ENGINEERING_INPUT_REQUIRED' && error.message.includes('仓库'))
    const decision = { action: 'wait', summary: '请指定本次开发的目标仓库', evidenceRefs: refs,
      condition: { kind: 'business-input', missing: 'repositoryId', responsibleParty: '交办人',
        resumeWhen: '目标仓库补入当前Task需求后继续', evidenceRefs: refs } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { root, taskOwnerSessions: sessions,
    judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前开发交办'] } : intent,
    config: { repositories: [{ id: 'available-repo', sourceRepository: source, managedRoot, remote: source,
      githubRepository: 'test/repo', baseRef: 'main', editablePaths: ['value.txt'],
      checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] } })
  const received = await service.ingest({ ...message, text: body })
  const state = await service.messages.process(received.runId)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.requests.length, 0)
  assert.deepEqual((await settleTaskOwners(service, execution)).failures, [])
  const taskId = state.commands[0].args.taskId
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(sourceRead, true)
  assert.equal(owner.decision.condition.missing, 'repositoryId')
  assert.equal((await service.tasks()).length, 1)
  assert.equal((await execution.controller.taskPlan(taskId)).stages.length, 0)
  assert.deepEqual(await execution.store.query({ kind: 'run.list', taskId }), [])
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(managedRoot), [])
  assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'unchanged')
})

test('同话题新消息更新名称摘要并进入后续协调候选，展示不创建任务', async t => {
 const seen=[]
 const f=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  const card=input.candidates.find(c=>c.state==='topic');seen.push(card)
  const decision=coordinatorUnit(source,'fact',{kind:'fact',text:source.body},card?{disposition:'conversation',candidateId:card.candidateId}:{disposition:'new',candidateId:null})
  if(source.body!=='继续补充')decision.units[0].topicPresentation=source.body==='来个任务'
    ?{title:'待明确的开发任务',summary:'已请求提供具体任务。'}
    :{title:'数据集过程导入导出开发',summary:'依据提供的规则文档实施数据集过程导入导出，保留边做边改进插件的工作方式。'}
  return decision
 })})
 for(const [index,text] of ['来个任务','按数据集导入导出文档开发','继续补充'].entries()){
  const r=await f.service.ingest({...f.message,messageId:`presentation-${index}`,text});await f.service.messages.process(r.runId)
 }
 const topics=await f.service.topics('g');assert.equal(topics.length,1)
 assert.equal(topics[0].title,'数据集过程导入导出开发');assert.equal(seen[2].summary,topics[0].summary)
 assert.equal(candidateCards([seen[2]])[0].summary,topics[0].summary)
 const context=await f.service.topicContext({groupId:'g',topicId:topics[0].topicId})
 assert.equal(context.total,3);assert.equal(context.topic.summary,topics[0].summary)
 assert.deepEqual(await f.service.tasks(),[])
})


test('受管话题关联服务封存后预检零写，旧链接读取四条且不派发业务',async t=>{
 const f=await fixture(t,'owner',undefined,{config:{webActorId:'operator'}})
 const store=f.execution.store, identity={channel:'web',actorId:'operator'}
 const runs=[]
 for(const [index,body] of ['来个任务，边做边修插件','数据集过程导入导出规则','按文档开发','目标环境uat2'].entries()){
  const state=await f.service.messages.receive({sourceKey:`reconcile-${index}`,sourceVersion:1,actorId:'owner',conversationId:'g',body,context:{sourceMessageId:`m-${index}`}},{process:false})
  const runId=state.run.runId; runs.push(runId)
  await store.command({id:`split-${index}`,kind:'message.split',args:{runId,units:[{unitId:`u-${index}`}]}})
  await store.command({id:`topic-${index}`,kind:'message.topic.upsert',args:{topicId:index===0?'old-topic':'current-topic',conversationId:'g',sourceRunId:runId,unitId:`u-${index}`,title:'开发',facts:[{kind:'fact',text:body,sourceRefs:[{sourceKey:`reconcile-${index}`,sourceVersion:1,text:body}]}]}})
 }
 const args={sourceTopicId:'old-topic',targetTopicId:'current-topic',maintenanceId:'reconcile-test',maintenanceRevision:2,reason:'修复同一事项关联',topicPresentation:{title:'数据集过程导入导出开发',summary:'依据规则文档开发，目标环境uat2，并持续改进插件。'}}
 for(const invalid of [{channel:'im',actorId:'operator'},{channel:'web',actorId:'other'},undefined]){
  await assert.rejects(f.service.reconcileTopic(args,invalid,true),{code:'WORKFLOW_WEB_ACTOR_FORBIDDEN'})
 }
 await assert.rejects(f.service.reconcileTopic(args,identity,true),{code:'MESSAGE_TOPIC_RECONCILE_MAINTENANCE_REQUIRED'})
 await f.service.changeMaintenance({requestId:'start',expectedRevision:0,maintenanceId:args.maintenanceId,reason:args.reason,active:true},identity)
 await assert.rejects(f.service.reconcileTopic(args,identity,true),{code:'MESSAGE_TOPIC_RECONCILE_MAINTENANCE_REQUIRED'})
 await f.service.changeMaintenance({requestId:'seal',expectedRevision:1,maintenanceId:args.maintenanceId,reason:args.reason},identity,'seal')
 const before=await Promise.all(runs.map(runId=>f.service.messages.state(runId)))
 const db=new DatabaseSync(store.info.dbPath,{readOnly:true})
 try{
  const count=()=>db.prepare('SELECT count(*) n FROM execution_events').get().n
  const previous=count()
  const check=await f.service.reconcileTopic({...args,actorId:'spoofed'},identity,true)
  assert.equal(count(),previous);assert.equal(check.counts.movedUnits,1)
  await assert.rejects(f.service.reconcileTopic({...args,requestId:'bad',expectedDigest:'stale'},identity),{code:'MESSAGE_TOPIC_RECONCILE_STALE'})
  const result=await f.service.reconcileTopic({...args,actorId:'spoofed',requestId:'apply',expectedDigest:check.expectedDigest},identity)
  assert.equal(result.actorId,'operator')
  assert.deepEqual(await f.service.reconcileTopic({...args,actorId:'spoofed',requestId:'apply',expectedDigest:check.expectedDigest},identity),result)
 }finally{db.close()}
 const context=await f.service.topicContext({groupId:'g',topicId:'old-topic'})
 assert.equal(context.topic.topicId,'current-topic');assert.equal(context.total,4)
 assert.deepEqual(new Set(context.messages.map(item=>item.messageId)),new Set(['m-0','m-1','m-2','m-3']))
 assert.equal(context.topic.summary,args.topicPresentation.summary)
 assert.deepEqual((await f.service.topics('g')).map(topic=>topic.topicId),['current-topic'])
 assert.equal(await f.service.topicContext({groupId:'foreign',topicId:'old-topic'}),null)
 for(const [index,runId] of runs.entries()){
  const after=await f.service.messages.state(runId)
  assert.deepEqual(after.run,before[index].run);assert.deepEqual(after.requests,before[index].requests)
  assert.deepEqual(after.commands,[])
 }
 assert.deepEqual(await f.service.tasks(),[])
 assert.deepEqual(await store.query({kind:'message.notifications'}),[])
 const mailbox=await f.service.mailboxes('g');assert.deepEqual(mailbox.outbox,[])
})


test('本机Web显式撤回绑定Host身份和快照摘要，重复执行不重复外发',async t=>{
 let recalls=0,reads=0
 const notifications={canDisclose:async()=>true,send:async()=>({messageId:'web-out'}),readback:async()=>({messageId:'web-out',conversationId:'g'}),
  recall:async()=>{recalls++;return {recallStatus:'SUCCESS'}},readbackRecall:async({messageId,ack})=>{reads++;assert.equal(ack.recallStatus,'SUCCESS');if(reads===1)return undefined;return {messageId,conversationId:'g',recallStatus:'SUCCESS'}}}
 const {service,execution,message}=await fixture(t,'owner',notifications,{config:{webActorId:'operator'}})
 const received=await service.ingest(message);await service.messages.process(received.runId)
 await settleTaskOwners(service,execution);await service.flushNotifications()
 const notice=(await execution.store.query({kind:'message.notifications',states:['delivered']}))[0]
 const input={operationId:'web-recall',notificationId:notice.id,type:'recall',reason:'explicit_user'},identity={channel:'web',actorId:'operator'}
 for(const invalid of [undefined,{channel:'im',actorId:'operator'},{channel:'web',actorId:'wrong'}])
  await assert.rejects(service.prepareWorkflowNotificationOperation(input,invalid),/AUTHORIZATION_REQUIRED/u)
 await assert.rejects(service.prepareWorkflowNotificationOperation({...input,reason:'correction'},identity),/AUTHORIZATION_REQUIRED/u)
 await assert.rejects(service.prepareWorkflowNotificationOperation({...input,authorizationRef:'host-web:wrong'},identity),/AUTHORIZATION_REQUIRED/u)
 const prepared=await service.prepareWorkflowNotificationOperation(input,identity)
 assert.equal(prepared.snapshot.authorizationRef,'host-web:operator')
 assert.deepEqual(await service.prepareWorkflowNotificationOperation(input,identity),prepared)
 const execute={operationId:prepared.id,expectedFactDigest:prepared.snapshot.expectedFactDigest}
 await assert.rejects(service.executeWorkflowNotificationOperation({...execute,expectedFactDigest:'old'},identity),/OPERATION_STALE/u)
 await assert.rejects(service.executeWorkflowNotificationOperation(execute,{channel:'web',actorId:'wrong'}),/AUTHORIZATION_REQUIRED/u)
 assert.equal(recalls,0)
 assert.equal((await service.executeWorkflowNotificationOperation(execute,identity)).status,'acknowledged')
 await assert.rejects(service.reconcileWorkflowNotificationOperation({operationId:prepared.id},{channel:'web',actorId:'wrong'}),/AUTHORIZATION_REQUIRED/u)
 assert.equal((await service.reconcileWorkflowNotificationOperation({operationId:prepared.id},identity)).status,'completed')
 assert.equal((await service.executeWorkflowNotificationOperation(execute,identity)).status,'completed')
 await assert.rejects(service.executeWorkflowNotificationOperation({...execute,expectedFactDigest:'old'},identity),/OPERATION_STALE/u)
 assert.equal(recalls,1);assert.equal(reads,2)
 const after=await execution.store.query({kind:'message.notification',notificationId:notice.id})
 assert.equal(after.recallStatus,'recalled');assert.ok(after.recallEvidenceRef)
})


for(const scenario of ['改写授权目标','跨消息借用','跨作者借用'])test(`工程授权原文回归：${scenario}拒绝且零副作用，当前原文证据可承接`,async t=>{
 let f,rejected=false
 const sourceText=scenario==='改写授权目标'?'按文档开发':'整理当前材料'
 const sessions={async close(){},async run({input,onSessionBound,onCandidate}){
  await onSessionBound()
  if(!input.sources.length){await onCandidate({decisions:[]});return {status:'submitted'}}
  const source=input.sources.find(item=>item.body===sourceText)
  assert.ok(source,JSON.stringify(input.sources.map(item=>({body:item.body,runId:item.runId}))))
  const proposal=(quote,objective)=>({decisions:[coordinatorUnit(source,'create',{
   objective:'按数据集过程导入导出规则文档开发相关功能。',workflowId:'task-engineering',
   stageAuthorizations:[{workflowId:'task-engineering',sourceQuote:quote,objective,gate:'none'}]
  })]})
  await assert.rejects(onCandidate(proposal('按文档开发',scenario==='改写授权目标'?'按数据集过程导入导出规则文档开发相关功能。':'按文档开发')),{code:'TASK_STAGE_AUTHORIZATION_SOURCE_INVALID'})
  rejected=true
  assert.deepEqual(await f.service.tasks(),[])
  const state=await f.service.messages.state(source.runId)
  assert.deepEqual(state.commands,[]);assert.deepEqual(state.requests,[])
  if(scenario==='改写授权目标')await onCandidate(proposal('按文档开发','按文档开发'))
  else await onCandidate({decisions:[{runId:source.runId,reason:'无有效外部授权',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding:{disposition:'new',candidateId:null},intent:{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:source.body},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}]}]})
  return {status:'submitted'}
 }}
 f=await fixture(t,'owner',undefined,{coordinatorSessions:sessions})
 if(scenario!=='改写授权目标'){
  const donor=await f.service.messages.receive({sourceKey:'other-development-source',sourceVersion:1,actorId:scenario==='跨作者借用'?'guest':'owner',conversationId:'g',body:'按文档开发',context:{}},{process:false})
  await f.execution.store.command({id:'donor-split',kind:'message.split',args:{runId:donor.run.runId,units:[{unitId:'donor-unit'}]}})
  await f.execution.store.command({id:'donor-ignore',kind:'message.accept',args:{runId:donor.run.runId,unitId:'donor-unit',commands:[],outcome:'ignored'}})
 }
 const received=await f.service.ingest({...f.message,text:sourceText})
 const state=await f.service.messages.process(received.runId)
 assert.equal(rejected,true)
 if(scenario==='改写授权目标'){
  assert.equal(state.commands.length,1);assert.equal(state.commands[0].status,'applied')
  assert.equal((await f.service.tasks()).length,1)
  const taskId=state.commands[0].args.taskId
  const plan=await f.execution.controller.taskPlan(taskId)
  const requirement=await f.execution.artifacts.read(plan.task.requirementRef)
  assert.equal(requirement.stageAuthorizations[0].objective,'按文档开发')
  assert.equal(requirement.stageAuthorizations[0].sourceQuote,'按文档开发')
 }else{assert.deepEqual(await f.service.tasks(),[]);assert.equal(state.commands.filter(item=>item.kind==='create').length,0)}
})

test('历史澄清恢复服务零写预检、幂等恢复后原来源创建唯一Task', async t => {
  const f = await fixture(t, 'owner', undefined, { config: { webActorId: 'operator' } })
  const store = f.execution.store, identity = { channel: 'web', actorId: 'operator' }
  let sequence = 0
  const call = (kind, args) => store.command({ id: `clarification-fixture-${++sequence}`, kind: `message.${kind}`, args })
  for (const [runId, body, occurredAt] of [['question', '整理规则材料还是开发？', '2026-10-08T01:23:00Z'], ['answer', '整理规则材料', '2026-10-08T01:23:43Z']]) {
    await call('receive', { runId, sourceKey: runId, sourceVersion: 1, actorId: 'owner', conversationId: 'g', body, context: { occurredAt }, policy: { initialWindowMs: 45000 } })
  }
  const sources = ['question', 'answer'].map(runId => ({ runId, sourceVersion: 1 }))
  const binding = (await call('coordinator.claim', { conversationId: 'g', expectedLeaseEpoch: 0, turnId: 'historical-clarification', sourceRuns: sources })).result.binding
  await call('coordinator.commit', { ...binding, decisions: sources.map((source, index) => ({ ...source, units: [{ unitId: `${source.runId}-unit`, spans: [{ start: 0, end: index ? 6 : 12 }], goalText: '整理规则材料', constraints: [], contextNeeds: [], topic: { topicId: 'recovery-topic', title: '规则材料' },
    commands: index ? [{ commandId: 'recover-create', kind: 'create', args: { taskId: 'recovered-task', arguments: { objective: '整理规则材料' }, binding: { disposition: 'new' }, replyPolicy: 'none' } }] : [],
    ...(!index ? { request: { requestId: 'old-question', kind: 'needs_clarification', question: '整理还是开发？', permittedActors: ['owner'] } } : {}),
  }] })) })
  await call('coordinator.release', { ...binding, drained: true })
  // 仅此测试的临时隔离库还原旧版本已领取后失败的历史状态；新门禁已禁止原生制造该状态。
  const db = new DatabaseSync(store.info.dbPath)
  try {
    const row = db.prepare("SELECT body FROM message_items WHERE item_id='command:recover-create'").get()
    const command = { ...JSON.parse(row.body), status: 'unknown', error: 'MESSAGE_INPUT_PENDING', result: null, leaseEpoch: 1 }
    db.prepare("UPDATE message_items SET body=? WHERE item_id='command:recover-create'").run(JSON.stringify(command))
    const input = { targetRunId: 'question', requestId: 'old-question', answerRunId: 'answer', commandId: 'recover-create', recoveryKey: 'recovery-once', reason: '采用真实后续回答恢复旧澄清', dryRun: true, maintenanceId: 'recovery', maintenanceRevision: 1 }
    await f.service.changeMaintenance({ requestId: 'recover-enter', expectedRevision: 0, maintenanceId: 'recovery', reason: input.reason, active: true }, identity)
    assert.equal((await store.query({ kind: 'runtime.maintenance' })).drained, true)
    const count = () => db.prepare('SELECT count(*) n FROM execution_events').get().n
    for (const invalidIdentity of [{ channel: 'im', actorId: 'operator' }, { channel: 'web', actorId: 'other' }]) {
      await assert.rejects(f.service.recoverClarification(input, invalidIdentity), { code: 'WORKFLOW_WEB_ACTOR_FORBIDDEN' })
    }
    const before = count(), checked = await f.service.recoverClarification(input, identity)
    assert.equal(count(), before)
    assert.deepEqual(await f.service.tasks(), [])
    const apply = { ...input, dryRun: false, expectedDigest: checked.expectedDigest }
    const recovered = await f.service.recoverClarification(apply, identity)
    assert.equal(recovered.command.status, 'pending')
    const appliedCount = count()
    assert.deepEqual(await f.service.recoverClarification(apply, identity), recovered)
    assert.equal(count(), appliedCount)
    await assert.rejects(f.service.recoverClarification({ ...apply, reason: '不同输入' }, identity), { code: 'MESSAGE_CLARIFICATION_RECOVERY_CONFLICT' })
    assert.deepEqual(await f.service.tasks(), [])
    await f.service.changeMaintenance({ requestId: 'recover-leave', expectedRevision: 1, maintenanceId: 'recovery', reason: '恢复完成', active: false }, identity)
    await f.service.messages.process('answer')
    await f.service.messages.process('answer')
    assert.equal((await f.service.tasks()).length, 1, JSON.stringify(await f.service.messages.state('answer')))
    const answer = await f.service.messages.state('answer'), question = await f.service.messages.state('question')
    assert.equal(answer.commands[0].status, 'applied')
    assert.equal(question.requests[0].status, 'resolved')
    assert.equal(question.requests[0].resolvedByActorId, 'owner')
    assert.equal(question.requests[0].answer, '整理规则材料')
    assert.equal(question.run.sourceVersion, 1)
    assert.equal(answer.run.sourceVersion, 1)
  } finally { db.close() }
})


test('公共话题fact与需求方环境revise同批通过，第三人revise仍拒绝',async t=>{
 let attack=false
 const f=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  if(source.body==='按文档开发')return coordinatorUnit(source,'create',{objective:'按文档开发'})
  const card=input.candidates.find(c=>c.taskId) ?? input.candidates.find(c=>c.topicId);assert.ok(card)
  return coordinatorUnit(source,!attack&&source.body!=='那就2吧'?'fact':'revise',!attack&&source.body!=='那就2吧'?{scope:'conversation',text:source.body}:{objective:'按文档开发，使用UAT2测试',uatEnvironment:'uat2',uatSourceRefs:[{sourceKey:'public-question',sourceVersion:1,sourceQuote:'辰姐，这个放在uat几测试'},{sourceKey:'public-open',sourceVersion:1,sourceQuote:'都行吧，现在几空着呢'},{sourceKey:'public-third',sourceVersion:1,sourceQuote:'uat1先别动'},{sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:source.body}]}, {disposition:'existing',candidateId:card.candidateId})
 })})
 const original=await f.service.ingest({...f.message,messageId:'public-seed',text:'按文档开发'});await f.service.messages.process(original.runId)
 const task=(await f.service.tasks())[0],taskId=task.taskId
 const before=await f.execution.controller.taskPlan(taskId)
 const question=await f.service.messages.receive({runId:'public-question',sourceKey:'public-question',sourceVersion:1,conversationId:'g',actorId:'owner',body:'辰姐，这个放在uat几测试',context:{}},{process:false})
 const open=await f.service.messages.receive({runId:'public-open',sourceKey:'public-open',sourceVersion:1,conversationId:'g',actorId:'owner',body:'都行吧，现在几空着呢',context:{}},{process:false})
 const third=await f.service.messages.receive({runId:'public-third',sourceKey:'public-third',sourceVersion:1,conversationId:'g',actorId:'third',body:'uat1先别动',context:{}},{process:false})
 const choice=await f.service.messages.receive({runId:'public-choice',sourceKey:'public-choice',sourceVersion:1,conversationId:'g',actorId:'owner',body:'那就2吧',context:{}},{process:false})
 await f.service.messages.process(choice.runId)
 const thirdState=await f.service.messages.state(third.runId),choiceState=await f.service.messages.state(choice.runId)
 assert.equal(thirdState.commands[0].status,'applied');assert.equal(thirdState.commands[0].args.taskId,null)
 assert.equal(choiceState.commands[0].status,'applied')
 const after=await f.execution.controller.taskPlan(taskId),requirement=await f.execution.artifacts.read(after.task.requirementRef)
 assert.ok(after.task.requirementRevision>before.task.requirementRevision)
 assert.equal(requirement.authorization.actorId,'owner')
 assert.deepEqual(requirement.sourceInstructions.slice(-4).map(source=>source.text),['辰姐，这个放在uat几测试','都行吧，现在几空着呢','uat1先别动','那就2吧'])
 assert.equal((await f.service.messages.state(question.runId)).commands[0].status,'applied')
 assert.equal((await f.service.messages.state(open.runId)).commands[0].status,'applied')
 assert.equal(requirement.target.uatEnvironment,'uat2');assert.equal((await f.service.tasks()).length,1)
 assert.equal((await f.service.topics('g')).length,1)
 attack=true
 const forbidden=await f.service.messages.receive({runId:'public-attack',sourceKey:'public-attack',sourceVersion:1,conversationId:'g',actorId:'third',body:'改成UAT3',context:{}},{process:false})
 await assert.rejects(f.service.messages.process(forbidden.runId),error=>['WORKFLOW_TASK_FORBIDDEN','TASK_UAT_SOURCE_INVALID'].includes(error.code))
 assert.equal((await f.service.messages.state(forbidden.runId)).commands.length,0)
 assert.equal((await f.execution.controller.taskPlan(taskId)).task.requirementRevision,after.task.requirementRevision)
})


for(const variant of ['unknown','version','quote','topic','explicit'])test(`语义环境来源拒绝无效证据且不更新需求：${variant}`,async t=>{
 let question
 const f=await fixture(t,'owner',undefined,{coordinatorSessions:coordinatorFixtureSessions((source,input)=>{
  if(source.body==='开发')return coordinatorUnit(source,'create',{objective:'开发'})
  const card=input.candidates.find(c=>c.taskId)
  if(source.body==='在哪个环境测试？')return coordinatorUnit(source,'fact',{scope:'conversation',text:source.body},variant==='topic'?{disposition:'new',candidateId:null}:{disposition:'existing',candidateId:card.candidateId})
  const ref={sourceKey:question.sourceKey,sourceVersion:question.sourceVersion,sourceQuote:question.body}
  if(variant==='unknown')ref.sourceKey='unknown-source'
  if(variant==='version')ref.sourceVersion++
  if(variant==='quote')ref.sourceQuote='哪个环境'
  return coordinatorUnit(source,'revise',{objective:'开发并使用UAT2测试',uatEnvironment:'uat2',uatSourceRefs:[ref,{sourceKey:source.sourceKey,sourceVersion:source.sourceVersion,sourceQuote:source.body}]},{disposition:'existing',candidateId:card.candidateId})
 })})
 const start=await f.service.ingest({...f.message,messageId:'semantic-start',text:'开发'});await f.service.messages.process(start.runId)
 const taskId=(await f.service.tasks())[0].taskId
 const q=await f.service.ingest({...f.message,messageId:'semantic-question',text:'在哪个环境测试？'});await f.service.messages.process(q.runId);question=(await f.service.messages.state(q.runId)).run
 const before=(await f.execution.controller.taskPlan(taskId)).task.requirementRevision
 const answer=await f.service.messages.receive({runId:'semantic-answer',sourceKey:'semantic-answer',sourceVersion:1,conversationId:'g',actorId:'owner',body:variant==='explicit'?'使用uat3':'选择第二个',context:{}},{process:false})
 await assert.rejects(f.service.messages.process(answer.runId),{code:'TASK_UAT_SOURCE_INVALID'})
 assert.equal((await f.service.messages.state(answer.runId)).commands.length,0)
 assert.equal((await f.execution.controller.taskPlan(taskId)).task.requirementRevision,before)
})
