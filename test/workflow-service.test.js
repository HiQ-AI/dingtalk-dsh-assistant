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
import { createTaskMarkdownFileAdapter } from '../packages/dingtalk-dsh-assistant/task-markdown-file.js'
import { createGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'

for (const control of ['cancelled', 'active', 'paused']) test(`Host恢复已退役调查定义按任务控制状态处理：${control}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'retired-owner-control-'))
  const model = { provider: 'fixture', model: 'fixture' }
  const config = { groupIds: ['group'], ownerActorId: 'owner', instanceId: 'retired-owner-control',
    dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts') }
  const store = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: config.artifactDirectory, initialize: true })
  const historical = { id: 'task-investigation', version: '4', nodes: [{ id: 'historical', version: '1',
    executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    mapInput: ({ requirement }) => requirement, execute: async () => { throw Error('RETIRED_EXECUTION_FORBIDDEN') } }] }
  const definition = defineExecutionWorkflow(historical)
  const controller = createExecutionController({ store, artifacts, workflows: [historical] })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.command({ id: 'register-retired', kind: 'workflow.register', args: {
    workflowId: historical.id, definitionVersion: historical.version, digest: definition.digest, config: model } })
  await controller.createTaskPlan({ commandId: 'retired-plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: historical.id, input: {} }] })
  await store.command({ id: 'retired-owner', kind: 'task.owner.init', args: {
    taskId: 'task', sessionId: 'retired-owner', sourceKey: 'source', criteria: ['历史调查'] } })
  if (control !== 'active') {
    const plan = await controller.taskPlan('task')
    await controller.controlTask({ commandId: 'retired-control', taskId: 'task', intent: control === 'cancelled' ? 'cancel' : 'pause',
      expectedControlRevision: plan.task.controlRevision })
  }
  const before = await controller.taskPlan('task')
  assert.equal(before.task.controlState, control)
  await controller.close(); await store.close()
  const open = () => openWorkflowService({ ctx: {}, config, legacy: { getAgentConfig: () => model },
    judge: async () => { throw Error('UNEXPECTED_MODEL') }, taskOwnerSessions: { async close() {} } })
  if (control !== 'cancelled') {
    await assert.rejects(open(), { code: control === 'active' ? 'WORKFLOW_CUTOVER_ACTIVE_REFERENCES' : 'WORKFLOW_VERSION_UNAVAILABLE' })
    return
  }
  service = await open()
  assert.deepEqual(await service.execution.controller.taskPlan('task'), before)
  const saved = (await service.execution.store.query({ kind: 'workflow.list' })).find(item => item.digest === definition.digest)
  assert.equal(saved.definitionVersion, '4'); assert.deepEqual(saved.config, model)
  assert.equal(service.execution.controller.workflowDefinition(historical.id).version, '6')
  assert.throws(() => service.execution.controller.workflowDefinition(historical.id, definition.digest), { code: 'WORKFLOW_VERSION_UNAVAILABLE' })
})
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability } from '../packages/dingtalk-dsh-assistant/task-artifact-write.js'
import { createSourceDossierCapability, createTaskMessageResourceCapability, isDirectedTaskRequest, openWorkflowService,
  rankMessageCandidates, verifyDefaultGeneralCompletion, describeTaskNodeOutput } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { messageSchemas, taskWorkflowCatalog } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { formatGroupReply, notificationOpenTaskId, sameDeliveredText, sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import { queryConversationTaskProgress } from '../packages/dingtalk-dsh-assistant/task-progress-query.js'
import { groupTaskExecutions } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

const schema = { type: 'object', additionalProperties: true }
const splitOne = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] })
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  const taskId = (await service.tasks())[0].taskId
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
    assert.deepEqual(await service.recoverExecutionTasks(), [])
    await execution.controller.whenIdle(task.runId)
    const after = await execution.controller.state(task.runId)
    assert.equal(executions, initialExecutions + (skipped ? 0 : 1))
    if (skipped) {
      assert.equal(after.run.revision, before.run.revision)
      assert.equal(after.run.generation, before.run.generation)
      assert.equal(after.nodes.find(node => node.nodeId === nodeId).status, 'waiting')
    }
    for(let i=0;i<4;i++) { await service.recoverExecutionTasks(); await execution.controller.whenIdle(task.runId) }
    assert.equal(executions, initialExecutions + (skipped ? 0 : 1))
  }
})

test('预算续行真实HTTP与Controller保留54次消耗、验收一次、旧失败领取及阶段门禁', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message); await service.messages.process(received.runId)
  const original = (await service.state(received.runId)).commands[0].result
  await execution.controller.whenIdle(original.runId); await execution.controller.advanceTaskPlan(original.taskId)
  await service.recoverExecutionTasks()
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
    stages: [{ stageId: 'current', workflowId: workflow.id, input: { request: 'fixture' } }, { stageId: 'later', workflowId: 'task-investigation', gate: 'confirmation' }] })
  const started = await execution.controller.advanceTaskPlan(taskId), runId = started.stages[0].runId
  await execution.controller.whenIdle(runId)
  for (let i = 0; i < 43; i++) { await execution.controller.recover({ commandId: `fixture-recover-${i}`, runId }); await execution.controller.whenIdle(runId) }
  const before = await execution.controller.state(runId)
  assert.equal(before.run.claimCount, 54); assert.equal(before.run.maxClaims, 54); assert.equal(acceptances, 1)
  const binding = (await service.tasks()).find(task => task.taskId === taskId).budgetContinuation
  assert.equal(binding.nodeId, 'prepare-commit')
  const identity = { channel: 'web', actorId: 'owner' }, body = { requestId: 'budget-continue', continuationText: '授权当前已验收候选有限续行一次', budgetBinding: binding }
  // 独立复制本测试临时库，构造先授权后出现unknown的事务竞态；绝不连接运行库。
  const cloneRoot = await mkdtemp(join(tmpdir(), 'budget-unknown-')), clonePath = join(cloneRoot, 'control.db')
  t.after(() => rm(cloneRoot, { recursive:true,force:true }))
  const sourceDb = new DatabaseSync(join(execution.artifacts.root, '..', 'control.db'), { readOnly:true })
  try { await backup(sourceDb, clonePath) } finally { sourceDb.close() }
  let clone = await openExecutionStore({ dbPath:clonePath,instanceId:'test' })
  await clone.command({ id:'unknown-prepare',kind:'task.web-input.prepare',args:{eventId:'unknown-event',actorId:'owner',request:{...body,action:'continue-budget',taskId},input:null} })
  await clone.close()
  const offline = new DatabaseSync(clonePath)
  try { offline.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('unknown-fixture','operation',?,?,?,?,?,'digest','{}','[]','fixture','unknown','now','now')")
    .run(runId,binding.nodeRunId,binding.nodeId,binding.generation,before.nodes.find(n=>n.nodeId===binding.nodeId).inputDigest) } finally { offline.close() }
  clone = await openExecutionStore({ dbPath:clonePath,instanceId:'test' })
  try {
    assert.equal(await clone.query({kind:'run.budget-continuation',runId}),null)
    await assert.rejects(clone.command({id:'unknown-continue',kind:'run.budget.continue',args:{eventId:'unknown-event'}}),/RUN_BUDGET_CONTINUATION_STALE/)
    assert.equal((await clone.query({kind:'run',runId})).run.maxClaims,54)
  } finally { await clone.close() }
  const runtime = { listTaskView:()=>service.tasks(), isWorkflowTask: async () => true, submitWorkflowTask: request => service.submitWebTask(request, identity) }
  const server = createServer((req,res) => handleRequest(req,res,runtime)); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const post = (value, origin) => fetch(`http://127.0.0.1:${server.address().port}/tasks/${taskId}/continue-budget`, { method: 'POST', headers: { 'content-type':'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(value) })
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${server.address().port}/state/tasks`)).json()).find(task=>task.taskId===taskId).budgetContinuation,binding)
  assert.equal((await post(body,'https://evil.example')).status,403)
  assert.equal((await post({ ...body, additionalClaims: 100 })).status,400)
  assert.equal((await post({ ...body, continuationText: '' })).status,400)
  await assert.rejects(service.submitWebTask({ ...body, action:'continue-budget', taskId }, { channel:'web',actorId:'attacker' }), /FORBIDDEN/)
  for (const field of ['controlRevision','requirementRevision','planRevision','runRevision','generation','leaseEpoch']) {
    assert.equal((await post({ ...body, requestId:`stale-${field}`, budgetBinding:{...binding,[field]:binding[field]+1} })).status,409)
  }
  await assert.rejects(execution.controller.continueRunBudget({ commandId:'untrusted-budget',eventId:'missing' }), /NOT_AUTHORIZED/)
  const response = await post(body); assert.equal(response.status,202,await response.text())
  const extended = await execution.controller.state(runId)
  assert.equal(extended.run.claimCount,54); assert.equal(extended.run.maxClaims,75); assert.equal(extended.run.generation,before.run.generation)
  assert.equal(extended.nodes.find(node=>node.nodeId==='prepare-commit').leaseEpoch,1)
  assert.equal((await post(body)).status,202)
  assert.equal((await post({ ...body,requestId:'second' })).status,409)
  await service.recoverExecutionTasks(); await execution.controller.whenIdle(runId)
  const after = await execution.controller.state(runId)
  assert.equal(after.run.status,'succeeded'); assert.equal(after.run.claimCount,61); assert.equal(after.run.maxClaims,75); assert.equal(acceptances,1)
  assert.equal(after.nodes.find(node=>node.nodeId==='prepare-commit').leaseEpoch,2)
  assert.equal((await execution.store.query({kind:'receipt',commandId:`claim:${binding.nodeRunId}:1`})).result.status,'budget_exhausted')
  assert.equal((await execution.store.query({kind:'receipt',commandId:`claim:${binding.nodeRunId}:2`})).result.status,'applied')
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
  assert.equal(sameDeliveredText('引用内容：原消息。回复内容：审核草稿和撤回通知已交付测试，分配撤回任务已取消。','审核草稿和撤回通知已交付测试，分配撤回任务已取消。',true),true)
  assert.equal(sameDeliveredText('@向春梅 更正审核问题：1. 草稿保存已部署。2. 分配撤回未部署。','更正审核问题：1. 草稿保存已部署。\n2. 分配撤回未部署。',true),true)
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
async function fixture(t, actor = 'owner', notifications, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'workflow-service-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true,
    ...(options.taskFiles ? { taskWorkspaceRoot: root, getTaskDirectories: createTaskDirectoryResolver({ store, workspaceRoot: root }) } : {}) })
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
  const controller = createExecutionController({ store, artifacts, sessions: options.executionSessions ?? investigationSessions, readTools: ['read-topic-sources', 'read-predecessor-artifact', 'organize-topic-sources', 'read-task-message-resource'], ...(delivery ? { delivery } : options.external ? { delivery: { execute: async () => { throw new Error('EXTERNAL_EFFECT_NOT_EXPECTED') } } } : {}), workflows: [] })
  const execution = { store: options.storeQuery ? { ...store, query: request => options.storeQuery(request, store.query) } : store,
    artifacts, controller, ...(delivery ? { delivery } : {}) }
  const legacy = { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'], ...(options.taskFiles ? { workspaceDir: root } : {}) }), getGroup: id => ({ groupId: id, responsibility: '处理本人交办事项', messages: [] }), ...options.legacy }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理本条材料', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const legacyJudge = options.judge ?? judge
  const batchJudge = async request => {
    if (request.stage !== 'IB') return legacyJudge(request)
    const shared = request.input
    const resolveTask = task => task?.ref ? shared.sharedTasks[task.ref] : task
    const resolveMaterial = value => {
      if (!value || typeof value !== 'object') return value
      if (Array.isArray(value)) return value.map(resolveMaterial)
      const { taskFactsRef, ...rest } = value
      return { ...rest, ...(taskFactsRef ? { text: JSON.stringify(shared.sharedTasks[taskFactsRef]) } : {}),
        ...(value.resources ? { resources: value.resources.map(resolveMaterial) } : {}) }
    }
    const topic = shared.sharedTopic && { ...shared.sharedTopic, facts: shared.sharedTopic.facts.map(fact => {
      if (fact.sourceIndexes) { const { sourceIndexes, ...rest } = fact; fact = { ...rest, sourceRefs: sourceIndexes.map(index => {
        const { sourceKey, sourceVersion } = shared.sharedTopic.sources[index]; return { sourceKey, sourceVersion }
      }) } }
      if (fact.actorFromTopic) { const { actorFromTopic, ...rest } = fact; fact = { ...rest, actorId: shared.sharedTopic.actorId } }
      if (!fact.textFromSource) return fact
      const ref = fact.sourceRefs[0], { textFromSource, ...rest } = fact
      return { ...rest, text: shared.sharedTopic.sources.find(source => source.sourceKey === ref.sourceKey && source.sourceVersion === ref.sourceVersion).text }
    }) }
    return { kind: 'topic_intents', decisions: await Promise.all(shared.units.map(async unit => {
      const facts = unit.input.facts
      return { unitId: unit.unitId, intent: await legacyJudge({ ...request, stage: 'I', input: { ...unit.input,
        sharedTasks: shared.sharedTasks, groupResponsibility: unit.input.groupResponsibility ?? shared.groupResponsibility,
        ...(unit.input.resolvedEvidence ? { resolvedEvidence: unit.input.resolvedEvidence.map(evidence => ({ ...evidence, answer: resolveMaterial(evidence.answer) })) } : {}),
        facts: { ...facts, ...(facts.task ? { task: resolveTask(facts.task) } : {}),
          ...(facts.tasks ? { tasks: facts.tasks.map(resolveTask) } : {}),
          ...(facts.topicTasks ? { topicTasks: { ...facts.topicTasks, tasks: facts.topicTasks.tasks.map(resolveTask) } } : {}),
          ...(topic ? { topic } : {}) } } }) }
    })) }
  }
  const taskOwnerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const needsPlan = input.stages.length === 0
    const complete = !needsPlan && input.stages.every(stage => stage.status === 'succeeded')
    const activeStage = input.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status))
    const decision = { action: needsPlan ? 'advance' : complete ? 'complete' : activeStage?.status === 'blocked' ? 'block'
      : activeStage?.status === 'ready' ? 'advance' : 'wait',
      summary: complete ? '全部阶段已完成' : '按当前计划推进', evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []),
      ...(needsPlan ? { planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } } : {}),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId,
        status: 'satisfied', evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []) })) } : {}) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const service = await openWorkflowService({ ctx: options.ctx ?? {}, config: { groupIds: ['g'], ownerActorId: 'owner', ...options.config }, legacy, judge: batchJudge, execution, notifications, readResource: options.readResource, readMessage: options.readMessage, external: options.external,
    ...(options.generalCompletionCheck ? { generalCompletionCheck: options.generalCompletionCheck,
      generalCompletionIdentity: 'test-general-completion-v1' } : {}),
    messageAgentSessions: { async run({ input, onSessionBound, onResult }) {
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
    await controller.whenIdle(original.runId)
    await controller.advanceTaskPlan(original.taskId)
    await service.recoverExecutionTasks()
    const workflowId = 'fixture-code-operation'
    controller.registerWorkflow({ id: workflowId, version: '1', nodes: [
      { id: options.nodeId ?? 'analyze', version: '1', executor: 'code', allowedEffects: options.allowedEffects ?? ['pure'],
        inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement,
        execute: options.execute }, ...(options.extraNodes ?? [])] })
    const taskId = 'fixture-code-task'
    const requirement = await artifacts.put({ request: 'fixture', acceptanceCriteria: ['fixture'], constraints: [], scope: { conversationId: 'g' }, authorization: {}, reportChannel: 'web', externalMessaging: false })
    await store.command({ id: 'fixture-code-origin', kind: 'task.web-rerun.accept', args: { taskId,
      rerunOfTaskId: original.taskId, actorId: 'owner', request: { expectedRunId: original.runId, objective: 'fixture' },
      requirementRef: requirement.ref, criteria: ['fixture'], sourceKey: 'web-rerun:fixture-code' } })
    await controller.initializeTaskPlan({ commandId: 'fixture-code-plan', taskId, expectedPlanRevision: 0, expectedRequirementRevision: 1,
      stages: [{ stageId: 'fixture', workflowId, input: { request: 'fixture', materials: [] } }] })
    const plan = await controller.advanceTaskPlan(taskId)
    return { taskId, runId: plan.stages[0].runId }
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
  const { service, execution, message, root } = await fixture(t, 'owner', notices, { config, external, taskFiles: true })
  const received = await service.ingest(message), processed = await service.messages.process(received.runId)
  const original = processed.commands[0].result
  await execution.controller.whenIdle(original.runId)
  await service.recoverExecutionTasks(); await service.flushNotifications()
  const ownerState = await execution.store.query({ kind: 'task.owner', taskId: original.taskId })
  assert.equal(ownerState.decision?.action, 'complete', JSON.stringify(ownerState))
  const originalState = await execution.store.query({ kind: 'run', runId: original.runId })
  assert.equal(originalState.run.status, 'succeeded')
  const artifactPrefix = `tasks/${original.taskId}/`
  assert.ok(originalState.run.requirementRef.startsWith(artifactPrefix))
  for (const node of originalState.nodes) {
    assert.ok(node.inputRef.startsWith(artifactPrefix))
    assert.ok(node.outputRef.startsWith(artifactPrefix))
    for (const reference of node.evidenceRefs) assert.ok(reference.startsWith(artifactPrefix))
  }
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
  assert.deepEqual(await execution.store.query({ kind: 'run', runId: original.runId }), originalState)
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
  await execution.controller.whenIdle(confirmationBase.runId)
  await service.recoverExecutionTasks()
  await service.flushNotifications(); sentBefore = sent
  await originalRegistry.prepareTask({ taskId: confirmationBase.taskId, arguments: { objective: '独立确认测试', repositoryId: 'dataset', uatEnvironment: 'uat3', acceptanceCriteria: ['确认'] } },
    { commandId: 'confirmation-engineering-definition', run: { actorId: 'owner' }, unit: {} }, { registerWorkflow() {} })
  const confirmationTask = await service.submitWebTask({ ...request, taskId: confirmationBase.taskId, expectedRunId: confirmationBase.runId, requestId: 'confirmation-task' }, identity)
  const confirmationAcceptance = await execution.store.query({ kind: 'task.owner.acceptance', taskId: confirmationTask.taskId })
  await execution.controller.initializeTaskPlan({ commandId: 'confirmation-plan', taskId: confirmationTask.taskId,
    expectedPlanRevision: 0, expectedRequirementRevision: 1, stages: [
      { stageId: 'analysis', workflowId: 'task-investigation', input: { request: '确认前序产物', materials: [{ id: 'confirmation-source', text: '确认前序产物' }], constraints: [], acceptanceCriteria: confirmationAcceptance.map(item => item.criterion), acceptanceItems: confirmationAcceptance.map(({ itemId, criterion }) => ({ itemId, criterion })), scope: { actorId: 'owner', conversationId: 'web:owner', resourceIds: [], databaseIds: [], statusIds: [] }, context: {} } },
      { stageId: 'merge', workflowId: 'task-investigation', gate: 'confirmation' },
      { stageId: 'deploy', workflowId: 'task-investigation', gate: 'confirmation' },
    ] })
  const firstStage = await execution.controller.advanceTaskPlan(confirmationTask.taskId)
  await execution.controller.whenIdle(firstStage.stages[0].runId)
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
    input: { request: '仅测试阶段产物', materials: [{ id: 'confirmation-source', text: '仅测试阶段产物' }], constraints: [], acceptanceCriteria: confirmationAcceptance.map(item => item.criterion), acceptanceItems: confirmationAcceptance.map(({ itemId, criterion }) => ({ itemId, criterion })), scope: { actorId: 'owner', conversationId: 'web:owner', resourceIds: [], databaseIds: [], statusIds: [] }, context: {} } })
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
    const decision = { action: 'wait', summary: '等待明确下一步', evidenceRefs: [] }
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
  const taskRunId = state.commands[0].result.runId
  await execution.controller.whenIdle(taskRunId)
  assert.deepEqual((await service.recover()).failures, [])
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

for (const [scenario, validWrite, expectedComplete, native = false] of [
  ['无关备忘录不能证明生产修复', false, false], ['同项有效保存完成', true, true],
  ['引用调查不足产物不能完成保存项', true, false], ['业务检查返回错项不能完成', true, false],
  ['默认原生领域检查拒绝备忘录冒充生产修复', false, false, true], ['默认原生领域检查接纳有效保存并持久化凭证', true, true, true],
]) test(`混合调查与写入通过真实服务Owner门禁：${scenario}`, async t => {
  const temporary = join(process.cwd(), 'docs', 'tmp')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'workflow-mixed-acceptance-'))
  const criterion = validWrite ? '调查记录已保存为 Markdown 文档' : '生产故障已修复并验证不再复现'
  const objective = validWrite ? '调查故障并保存 Markdown 文档' : '修复生产故障并保存 Markdown 文档'
  const content = '# 调查备忘录\n\n故障仍存在，尚未实施生产修复。\n'
  const semanticChecks = [], failures = []
  const sessions = { async run({ input, onSessionBound, onResult }) {
    await onSessionBound()
    const refs = input.materials.map(item => item.id)
    await onResult({ outcome: 'completed', summary: '调查已结束，后续任务尚未实施', evidenceRefs: refs,
      limitations: ['尚未实施后续任务'], question: '',
      findings: [{ kind: 'fact', statement: '故障仍存在', evidenceRefs: refs }],
      openItems: [{ description: criterion, reason: '调查阶段尚未实施', evidenceRefs: [] }],
      criterionReviews: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'insufficient_evidence',
        reason: '尚无后续实施证据', evidenceRefs: [] })) })
    return { status: 'submitted' }
  }, async cancel() {}, async close() {} }
  const ownerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const initialize = !input.stages.length, stagesDone = !initialize && input.stages.every(stage => stage.status === 'succeeded')
    const appendWrite = stagesDone && input.stages.length === 1, complete = stagesDone && input.stages.length === 2
    const evidenceRefs = complete ? [scenario === '引用调查不足产物不能完成保存项' ? input.stages[0].outputRef : input.stages.at(-1).outputRef]
      : input.stages.flatMap(stage => stage.evidenceRefs ?? [])
    const decision = { action: initialize || appendWrite || input.stages.some(stage => stage.status === 'ready') ? 'advance' : complete ? 'complete' : 'wait',
      summary: complete ? '声明目标已完成' : '推进调查及写入', evidenceRefs,
      ...(initialize ? { planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-investigation', gate: 'none' },
      ] } } : {}),
      ...(appendWrite ? { appendStages: [
        { workflowId: 'task-general-capability', gate: 'none', capabilityStep: {
          capabilityId: 'write-task-markdown', input: { content }, expectedEvidence: '独立回读 Markdown 文档' } },
      ] } : {}),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) } : {}) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const assess = async input => {
    semanticChecks.push(input)
    assert.deepEqual(input.acceptanceItems.map(item => item.criterion), [criterion])
    assert.equal(input.acceptanceItems[0].itemId, 'acceptance-1')
    assert.equal(input.evidence.length, 1)
    assert.deepEqual(input.acceptanceItems[0].evidenceRefs, [input.evidence[0].evidenceId])
    assert.equal(await readFile(input.evidence[0].output.result.path, 'utf8'), content)
    return { status: validWrite ? 'satisfied' : 'unsatisfied', resultVerified: validWrite,
      criteria: [{ criterion: scenario === '业务检查返回错项不能完成' ? '另一项未经委托的标准' : criterion,
        passed: validWrite, evidenceIds: [input.evidence[0].evidenceId] }] }
  }
  const nativeLlm = { async *stream(request) {
    assert.deepEqual(request.tools, [])
    assert.equal(request.maxTokens, 4096)
    assert.match(request.system, /不能证明生产修复/)
    const input = JSON.parse(request.messages[0].content[0].text)
    assert.equal(input.request, objective)
    yield { type: 'text-delta', text: JSON.stringify(await assess(input)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    root, executionSessions: sessions, taskOwnerSessions: ownerSessions, config: { taskOutputDirectory: join(root, 'files') },
    deliveryOptions: { fileAdapter: createTaskMarkdownFileAdapter({ root: join(root, 'files') }), authorize: async () => null,
      authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
        ? { principalId: 'owner', authorizationRef: 'fixture-write-grant' } : null },
    judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective, acceptanceCriteria: [criterion] }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' },
    ...(native ? { ctx: { llm: nativeLlm } } : { generalCompletionCheck: assess }),
  })
  const accepted = await service.ingest({ ...message, text: objective })
  const state = await service.messages.process(accepted.runId)
  assert.equal(state.commands[0].status, 'applied', JSON.stringify(state.commands[0]))
  const taskId = state.commands[0].result.taskId
  for (let attempt = 0; attempt < 8; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages) if (stage.runId) await execution.controller.whenIdle(stage.runId)
    failures.push(...(await service.recover()).failures)
    const owner = await execution.store.query({ kind: 'task.owner', taskId })
    if (owner.decision?.action === 'complete' || failures.some(item => item.code === 'TASK_OWNER_COMPLETION_UNVERIFIED')) break
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 2, JSON.stringify({ plan, failures, owner: await execution.store.query({ kind: 'task.owner', taskId }) }))
  assert.ok(plan.stages.every(stage => stage.status === 'succeeded'), JSON.stringify({ plan, failures }))
  const investigation = await execution.artifacts.read(plan.stages[0].outputRef)
  assert.equal(investigation.criterionReviews[0].status, 'insufficient_evidence')
  const output = await execution.artifacts.read(plan.stages[1].outputRef)
  assert.equal(output.verification.passed, true)
  assert.equal(await readFile(output.output.result.path, 'utf8'), content)
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.equal(owner.decision?.action === 'complete', expectedComplete, JSON.stringify({ owner, failures }))
  if (scenario !== '引用调查不足产物不能完成保存项') assert.ok(semanticChecks.length > 0, '混合流程必须执行所属验收项的业务检查')
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
    assert.ok(failures.some(item => item.code === 'TASK_OWNER_COMPLETION_UNVERIFIED'), JSON.stringify(failures))
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, 0)
  assert.deepEqual((await service.recover()).failures, [])
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  await execution.store.command({ id: 'new-goal-event', kind: 'task.owner.event',
    args: { taskId, eventKey: 'new-goal-event', eventType: 'intent.received' } })
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务已完成')).length, 0)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
})

test('同一任务承接与最终报告并存时只按精确通知身份纠正最终报告', async t => {
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  await service.flushNotifications()
  const delivered = await execution.store.query({ kind: 'message.notifications', states: ['delivered'] })
  const receipt = delivered.find(item => item.payload.phase === 'accepted')
  const final = delivered.find(item => item.payload.text.startsWith('任务已完成'))
  assert.ok(receipt && final && receipt.id !== final.id)
  const auth = await service.ingest({ ...message, messageId: 'correct-final-only',
    text: `撤回通知 ${final.id}` })
  const authSource = (await execution.store.query({ kind: 'message.run', runId: auth.runId })).run.sourceKey
  const prepared = await service.prepareWorkflowNotificationOperation({ operationId: 'correct-final-only',
    notificationId: final.id, type: 'recall', reason: 'correction', authorizationRef: authSource })
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })).status, 'completed')
  const outbox = (await service.mailboxes()).outbox
  assert.equal(outbox.find(item => item.outboundId === final.id).recallStatus, 'recalled')
  assert.equal(outbox.find(item => item.outboundId === receipt.id).recallStatus, undefined)
  assert.deepEqual(recalls, [final.ack.messageId])
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
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '排查已给材料',
          workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge })
  const first = await service.ingest({ ...message, text: '排查已给材料' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  await service.flushNotifications()
  const priorFinals = sent.filter(item => item.startsWith('任务已完成')).length
  const priorReports = await execution.store.query({ kind: 'task.owner.reports', taskId })
  const next = await service.ingest({ ...message, messageId: 'report-only', text: '报告改成中文' })
  const result = await service.messages.process(next.runId)
  assert.equal(result.commands[0].status, 'applied', JSON.stringify(result.commands[0]))
  assert.equal(result.commands[0].result.taskId, taskId)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
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

test('Owner长事件完整输入后推进同一Task水位，不按字节强制分页', async t => {
  let largestEventCount = 0
  const sessions = { async run({ input, readPage, onSessionBound, onCandidate }) {
    await onSessionBound()
    const events = [...input.events]
    assert.equal(input.eventPages,undefined)
    largestEventCount=Math.max(largestEventCount,events.length)
    for(const event of events.filter(item=>item.payload?.text)) assert.equal(event.payload.text,'积压事件原文'.repeat(180))
    assert.equal(events.at(-1).eventSeq, input.eventWatermark)
    const complete = input.stages.length > 0 && input.stages.every(stage => stage.status === 'succeeded')
    const evidenceRefs = input.stages.flatMap(stage => stage.evidenceRefs ?? [])
    const decision = { action: complete ? 'complete' : 'advance', summary: complete ? '任务完成' : '开始执行',
      ...(!input.stages.length ? { planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } } : {}),
      evidenceRefs, ...(complete ? { assessments: input.acceptanceItems.map(item => ({
        itemId: item.itemId, status: 'satisfied', evidenceRefs })) } : {}) }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest(message)
  const created = await service.messages.process(received.runId)
  const taskId = created.commands[0].result.taskId
  await execution.controller.whenIdle(created.commands[0].result.runId)
  const payload = await execution.artifacts.put({ text: '积压事件原文'.repeat(180) })
  for (let index = 0; index < 120; index++) await execution.store.command({
    id: `backlog-${index}`, kind: 'task.owner.event', args: { taskId,
      eventKey: `backlog-${index}`, eventType: 'intent.received', payloadRef: payload.ref } })
  assert.deepEqual((await service.recover()).failures, [])
  const owner = await execution.store.query({ kind: 'task.owner', taskId })
  assert.ok(largestEventCount >= 120)
  assert.equal(owner.processedWatermark, owner.eventWatermark)
  assert.equal(owner.decision.action, 'complete')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
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
      objective: '核对 test3 账号创建时间为空的原因', workflowId: 'task-investigation' }, dependsOn: [] }],
      constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, messageId: 'synthetic-account-question',
    text: 'test3 account@example.invalid 示例研究院 小助手，这个账号是你创建的测试账号吗？为什么创建时间是空的呢？从什么渠道创建的账号时间会空呢？' })
  const firstState = await service.messages.process(first.runId)
  const taskId = firstState.commands[0].result.taskId
  await execution.controller.whenIdle(firstState.commands[0].result.runId)
  await service.recover()
  const second = await service.ingest({ ...message, messageId: 'synthetic-account-followup', text: '这不是让你去查吗' })
  const secondState = await service.messages.process(second.runId)
  assert.equal(secondState.commands[0].status, 'applied')
  assert.equal(secondState.commands[0].result.taskId, taskId)
  assert.equal((await service.tasks()).length, 1)
  assert.equal(followupInput.binding.taskId, taskId)
  assert.match(JSON.stringify(followupInput), /test3|账号创建时间/u)
})

test('同一话题含两个Task时按明确目标绑定短追问，不默认最近执行Run', async t => {
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') {
      if (!input.candidates.length) return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['两个独立目标'] }
      const target = input.candidates.find(item => item.goal?.includes('排查A'))
      return { kind: 'binding', disposition: 'existing', candidateId: target?.candidateId ?? input.candidates[0].candidateId,
        evidence: ['追问明确指向排查A'] }
    }
    return input.text.includes('A呢')
      ? { kind: 'intent', actions: [{ intent: 'status', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
      : { kind: 'intent', actions: [
        { intent: 'create', arguments: { objective: '排查A', workflowId: 'task-investigation' }, dependsOn: [] },
        { intent: 'create', arguments: { objective: '排查B', workflowId: 'task-investigation' }, dependsOn: [] },
      ], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '排查A；排查B' })
  const created = await service.messages.process(first.runId)
  assert.equal(created.commands.length, 2)
  assert.ok(created.commands.every(item => item.status === 'applied'))
  const [a, b] = created.commands.map(item => item.result.taskId)
  assert.notEqual(a, b)
  const bRun = created.commands[1].result.runId
  await execution.controller.whenIdle(bRun)
  const followup = await service.ingest({ ...message, messageId: 'ask-a-only', text: '排查A呢？' })
  const answer = await service.messages.process(followup.runId)
  assert.equal(answer.commands[0].status, 'applied')
  assert.equal(answer.commands[0].result.taskId, a)
  assert.equal((await service.tasks()).length, 2)
})

test('模型要求为非本人创建Task仍被Host拒绝，未受权群也拒绝', async t => {
  const { service, execution, message } = await fixture(t, 'outsider')
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  const rejected = await service.state(accepted.runId)
  assert.equal(rejected.run.status, 'settled')
  assert.equal(rejected.commands[0].status, 'rejected')
  assert.match(rejected.commands[0].result.reply, /权限/)
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

test('Web与IM引用同一澄清首终态生效，无权拒绝且答复不新建消息或重跑S', async t => {
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
  assert.equal(splits, 1)
  assert.equal((await execution.store.query({ kind: 'message.list', limit: 100 })).length, 1)
})

test('纯话题事实同库沉淀，后续任务读取原文并强制继承话题约束', async t => {
  let sawSource = false
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return input.candidates.length ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['topic'] } : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    if (input.text.includes('只用中文')) return { kind: 'intent', actions: [{ intent: 'fact', arguments: { kind: 'constraint', text: '只用中文' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    sawSource = input.facts.topic.sources.some(ref => ref.text === '后续报告只用中文')
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理报告', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
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
  const task = await execution.controller.state(state.commands[0].result.runId)
  const input = await execution.artifacts.read(task.run.requirementRef)
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
  let reads = 0
  const originalText='附件正文：SELECT 1;'.repeat(20000)+'只允许测试库'
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新材料'] }
      : { kind: 'intent', actions: [{ intent: 'research', arguments: { objective: '分析附件', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: ['不可执行SQL'], requiredExecutionMaterials: ['file-1'], replyPolicy: 'result' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, readResource: async () => ({ text: ++reads === 1 ? originalText : '已被替换的正文' }) })
  const receipt = await service.ingest({ ...message, text: '分析附件', resourceRefs: [{ type: 'fileId', resourceId: 'file-1' }] })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.run.status, 'settled', JSON.stringify({reason:state.run.reason,commands:state.commands}))
  assert.ok(state.commands[0].result.runId,JSON.stringify({result:state.commands[0].result,owner:await execution.store.query({kind:'task.owner',taskId:state.commands[0].result.taskId})}))
  const task = await execution.controller.whenIdle(state.commands[0].result.runId)
  const input = await execution.artifacts.read(task.run.requirementRef)
  assert.deepEqual(input.constraints, ['不可执行SQL'])
  assert.deepEqual(input.materials.find(item => item.id === 'file-1'), { id: 'file-1', text: originalText })
  assert.equal(reads, 1)
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
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
  await execution.controller.whenIdle(command.result.runId)
  const edited = await service.ingest({ ...message, messageVersion: 2 })
  assert.equal(edited.runId, first.runId); assert.equal(edited.duplicate, true)
  assert.equal((await service.ingest({ ...message, messageVersion: 2 })).runId, first.runId)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 1)
  assert.equal((await execution.store.query({ kind: 'message.list' })).length, 1)
})
test('群职责允许明确点名交办创建任务，普通问题报告仍无创建权',async t=>{
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'new',candidateId:null,evidence:['新事项']}
    :{kind:'intent',actions:[{intent:'create',arguments:{objective:'核对归一化回归',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{judge,legacy:{
    getAgentConfig:()=>({provider:'test',model:'test',agentNames:['资料助理','客服(乙)']}),
    getGroup:id=>({groupId:id,responsibility:'## 任务准入\n消息明确要求当前 Agent 处理时可以创建任务。',messages:[]}),
  }})
  const passive=await service.ingest({...message,messageId:'report',text:'@用户(用户) 修复又引入了归一化计算问题：当前得到 0.001 t。'})
  await service.messages.process(passive.runId)
  assert.equal((await service.state(passive.runId)).commands[0].status,'rejected')
  const unconfigured=await service.ingest({...message,messageId:'unconfigured',text:'小助手，请修复这个问题'})
  assert.equal((await service.messages.process(unconfigured.runId)).commands[0].status,'rejected')
  const directed=await service.ingest({...message,messageId:'request',text:'客服(乙)，数据集合并出现的这个问题需要修复'})
  await service.messages.process(directed.runId)
  assert.equal((await service.state(directed.runId)).commands[0].status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
})
test('本机操作者逐条重处理旧澄清，旧请求失效且有命令消息拒绝重跑',async t=>{
  let clarified=false
  const judge=async({stage,input})=>{
    if(stage==='S')return clarified?splitOne(input.source.text):{kind:'needs_clarification',reason:'旧上下文不足',question:'旧问题',needs:[]}
    if(stage==='R')return{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    return{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  }
  const {service,message}=await fixture(t,'owner',undefined,{judge,config:{webActorId:'owner'}})
  const first=await service.ingest(message);await service.messages.process(first.runId)
  await assert.rejects(service.reprocessMessage(first.runId,{channel:'web',actorId:'other'}),/FORBIDDEN/)
  clarified=true
  const replay=await service.reprocessMessage(first.runId,{channel:'web',actorId:'owner'})
  assert.notEqual(replay.runId,first.runId)
  assert.equal((await service.state(first.runId)).requests[0].status,'superseded')
  assert.equal((await service.state(replay.runId)).commands.length,1)
  assert.equal((await service.ingest(message)).duplicate,true)
  await assert.rejects(service.reprocessMessage(replay.runId,{channel:'web',actorId:'owner'}),/MESSAGE_REPROCESS_EFFECT_PENDING/)
})

test('无引用的先别管它静默收束，不追问也不创建任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge:async()=>{throw new Error('MODEL_MUST_NOT_RUN')}})
  const received=await service.ingest({...message,text:'先别管它'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.run.reason,'message_quiet')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})
test('第三方任务已创建进展同步即使含@也静默，不生成澄清或业务任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge:async()=>{throw new Error('PROGRESS_SYNC_MUST_NOT_CALL_MODEL')}})
  const received=await service.ingest({...message,text:'@用户  任务已创建，开始处理。 任务：dingtalk_at_xcm:20260924130713-437 — 小煤球',quotedMessage:{messageId:'old-reply',content:'此前话题的回复'}})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.reason,'message_quiet')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  const mailbox=(await service.mailboxes()).messages.find(item=>item.messageId===message.messageId)
  assert.equal(mailbox.routingStatus,'pending')
  assert.deepEqual(mailbox.topicRefs,[])
})
test('已送达回复引用可将第三方进展静默绑定到唯一话题，且旧消息可确定性补录',async t=>{
  const outbox=[]
  let calls=0
  const judge=async({stage,input})=>{calls++;return stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:input.text},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge,legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[],outbox})}})
  const origin=await service.ingest({...message,messageId:'source-1',text:'审核草稿保存的问题'})
  await service.messages.process(origin.runId)
  const topic=(await service.topics('g'))[0]
  assert.ok(topic)
  const progress={...message,messageId:'progress-1',text:'@用户  任务已创建，开始处理。 任务：external-1 — 小煤球',quotedMessage:{messageId:'reply-1',content:'审核问题已核对'}}
  const received=await service.ingest(progress)
  await service.messages.process(received.runId)
  assert.equal((await service.mailboxes()).messages.find(item=>item.messageId==='progress-1').routingStatus,'pending')
  const priorCalls=calls
  outbox.push({status:'sent',deliveredMessageId:'reply-1',sourceMessageId:'source-1'})
  await service.messages.recover()
  const routed=(await service.mailboxes()).messages.find(item=>item.messageId==='progress-1')
  assert.equal(routed.routingStatus,'routed')
  assert.deepEqual(routed.topicRefs.map(item=>item.topicId),[topic.topicId])
  assert.ok((await service.topicContext({groupId:'g',topicId:topic.topicId})).messages.some(item=>item.messageId==='progress-1'))
  assert.equal(calls,priorCalls)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  await service.messages.recover()
  assert.equal((await service.mailboxes()).messages.find(item=>item.messageId==='progress-1').topicRefs.length,1)
})
test('已完成的纯排查任务再次收到相同问题反馈时提出修复授权问题',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查评审意见草稿再次进入未回显问题',objective:'排查草稿未回显，仅授权排查分析，不实施修改',state:'completed',outcome:'succeeded'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:'问题仍然存在'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}})
  const received=await service.ingest({...message,text:'@用户(用户) 审核草稿保存依然有问题，填写评审意见点击保存草稿后，再次进入没有显示草稿内容'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'waiting')
  assert.equal(state.commands.length,0)
  assert.equal(state.requests.length,1)
  assert.match(state.requests[0].question,/是否需要我继续实施修复并验证/u)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})
test('旧任务缺标题且长目标进入R候选时仍能计算材料摘要',async t=>{
  const task={taskId:'untitled',groupId:'g',objective:'历史目标'.repeat(90),state:'completed',outcome:'succeeded'}
  let sawCandidate=false
  const {service,message}=await fixture(t,'owner',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?(sawCandidate=true,assert.equal(input.candidates.find(item=>item.candidateId==='legacy:untitled').title,task.objective),{kind:'binding',disposition:'new',candidateId:null,evidence:['新消息']})
    :{kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
  const received=await service.ingest({...message,text:'历史目标需要核对'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.notEqual(state.run.reason,'MESSAGE_CONTEXT_OR_DISPATCH_FAILED:INVALID_JSON_VALUE')
  assert.notEqual(state.run.status,'needs_attention')
  assert.equal(sawCandidate,true)
})
test('旧排查任务的肯定答复只授权同一消息继续准入，随后可创建新工作流任务',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查草稿未回显',objective:'排查草稿未回显，仅授权排查分析',state:'completed',outcome:'succeeded'}
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :input.clarificationAnswers?.length
      ?{kind:'intent',actions:[{intent:'create',arguments:{objective:'核验草稿未回显新反馈',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
      :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:'问题仍然存在'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{getGroup:id=>({groupId:id,responsibility:'任务准入：肯定答复后准入',messages:[]}),listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge})
  const received=await service.ingest({...message,text:'@用户(用户) 草稿未回显依然有问题'})
  await service.messages.process(received.runId)
  const request=(await service.state(received.runId)).requests[0]
  await service.messages.resume({runId:received.runId,requestId:request.id,eventId:'confirm-1',actorId:'participant',answer:'需要，请继续修复'})
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
})

test('本人可答复他人旧排查澄清，其他群成员不能冒用且不阻断消息接收',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查草稿未回显',objective:'仅授权排查分析',state:'completed',outcome:'succeeded'}
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :input.clarificationAnswers?.length
      ?{kind:'intent',actions:[{intent:'create',arguments:{objective:'修复草稿未回显',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
      :{kind:'needs_clarification',reason:'消息未明确授权；此前对应任务仅授权排查分析，不能据此实施修改。',question:'继续排查还是修复？',needs:[]}
  const notifications={canDisclose:async()=>true,send:async()=>({messageId:'clarify-sent'}),readback:async()=>({messageId:'clarify-sent',conversationId:'g'})}
  const {service,message,execution}=await fixture(t,'participant',notifications,{legacy:{getGroup:id=>({groupId:id,responsibility:'任务准入',messages:[]}),listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge})
  const received=await service.ingest({...message,text:'@用户(用户) 审核草稿保存依然有问题，评审意见再次进入未回显'})
  await service.messages.process(received.runId)
  const request=(await service.state(received.runId)).requests[0]
  await service.flushNotifications()
  await assert.rejects(service.resumeRequest({runId:received.runId,requestId:request.id,eventId:'outsider',answer:'修复'}, {channel:'im',actorId:'outsider',conversationId:'g'}),/WORKFLOW_ACTION_FORBIDDEN/u)
  const other=await service.ingest({...message,messageId:'other-reply',senderOpenDingTalkId:'outsider',text:'我也要修复',quotedMessage:{messageId:'clarify-sent'}})
  assert.equal(other.duplicate,false)
  await service.messages.process(other.runId)
  assert.equal((await service.state(received.runId)).requests[0].status,'pending')
  const answer='修复并验证，完成后发uat提测'
  const eventId=`dws:${executionDigest(['','g','owner-reply'])}`
  const originalSource=(await service.state(received.runId)).run.sourceKey
  await execution.store.command({id:'old-misrouted-answer',kind:'message.receive',args:{runId:'old-misrouted-answer',sourceKey:eventId,sourceVersion:1,conversationId:'g',actorId:'owner',body:answer,
    barriers:[{barrierId:'fold-answer-fence',targetSourceKey:originalSource}],
    context:{sourceMessageId:'owner-reply',quoteRefs:[{sourceKey:'quote',messageId:'clarify-sent'}]}}})
  const accepted=await service.ingest({...message,messageId:'owner-reply',senderOpenDingTalkId:'owner',text:'修复并验证，完成后发uat提测',quotedMessage:{messageId:'clarify-sent'}})
  assert.equal(accepted.status,'resolved')
  assert.equal((await service.state('old-misrouted-answer')).run.status,'superseded')
  assert.equal((await execution.store.query({kind:'message.clarifications.unlinked'})).length,1)
  await service.recover()
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
  assert.deepEqual(await execution.store.query({kind:'message.clarifications.unlinked'}),[])
  const folded=await service.state('old-misrouted-answer')
  assert.equal(folded.barriers[0].status,'resolved')
  const origin=await service.state(received.runId)
  assert.deepEqual((await execution.store.query({kind:'message.topic.source',sourceKey:eventId}))
    .map(topic=>topic.topicId),[origin.units[0].topicId])
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
test('恢复扫描先重试一次无回执只读查询，再完成原命令',async t=>{
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
  const state=await service.state('recover-status')
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].status,'applied')
  assert.equal(state.commands[0].readonlyRetryCount,1)
})

test('回声先启动模型而通知随后读回时，隔离取消原调用且迟到结果不影响 drained', { timeout: 10000 }, async t => {
  let releaseSend, sendStarted, releaseEcho, echoStarted, echoSignal, modelCalls = 0
  const sendGate = new Promise(resolve => { releaseSend = resolve }), sending = new Promise(resolve => { sendStarted = resolve })
  const echoGate = new Promise(resolve => { releaseEcho = resolve }), judgingEcho = new Promise(resolve => { echoStarted = resolve })
  t.after(() => { releaseSend(); releaseEcho() })
  const notifications = { canDisclose: async () => true,
    send: async () => { sendStarted(); await sendGate; return { messageId: 'racing-outbound' } },
    readback: async () => ({ messageId: 'racing-outbound', conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge: async ({ stage, input, signal }) => {
    modelCalls++
    if (stage === 'S' && input.source.text === '已收到测试消息') {
      echoSignal = signal; echoStarted(); await echoGate
      return splitOne(input.source.text)
    }
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: '已收到测试消息' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  } })
  const original = await service.ingest(message); await service.messages.process(original.runId)
  const notifying = service.flushNotifications(); await sending
  const echo = await service.ingest({ ...message, messageId: 'racing-outbound', text: '已收到测试消息', quotedMessage: { messageId: message.messageId, content: message.text } })
  const processing = service.messages.process(echo.runId); await judgingEcho
  const before = await service.state(echo.runId)
  assert.equal(before.nodes[0].status, 'running')
  releaseSend(); await notifying
  await service.messages.recover()
  assert.equal(echoSignal.aborted, true)
  releaseEcho(); await processing
  const after = await service.state(echo.runId)
  assert.equal(after.run.status, 'superseded'); assert.equal(after.run.reason, 'outbound_echo')
  assert.equal(after.nodes[0].status, 'superseded'); assert.equal(after.commands.length, 0)
  assert.equal(after.barriers.length, 1); assert.equal(after.barriers[0].status, 'resolved')
  assert.equal(after.budget.claims, before.budget.claims)
  assert.equal((await execution.store.query({ kind: 'runtime.maintenance' })).busy.messages, 0)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal(modelCalls, 4)
})

test('已回读的自身澄清通知不再作为新消息入站，收发信箱分别投影', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true, send: async notice => { const item = { messageId: 'out-1', text: notice.payload.text }; sent.push(item); return { messageId: item.messageId } }, readback: async () => ({ messageId: 'out-1', conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge: async ({ stage }) => stage === 'S' ? { kind: 'needs_clarification', reason: '问题不明确', question: '请说明具体任务', needs: [] } : null })
  const original = await service.ingest(message)
  await service.messages.process(original.runId)
  await service.flushNotifications()
  const echo = await service.ingest({ ...message, messageId: 'out-1', text: sent[0].text })
  assert.equal(echo.processing, 'outbound-echo')
  const genuine = await service.ingest({ ...message, messageId: 'manual-2', text: sent[0].text })
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
  await service.messages.process(received.runId)
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

test('群职责进入 I 而不占用 S/R；任务历史可由固定材料键读取', async t => {
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

test('I 的流程提示不直接派发；专业目录供 Owner 选择，缺适配器不执行外部效果', async t => {
  const ids = ['task-investigation']
  let selected = 0
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    const available = input.facts.availableWorkflows.map(item => item.id)
    assert.ok(ids.every(id => available.includes(id)))
    assert.ok(input.facts.unavailableWorkflows.includes('生产发布'))
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: input.text, workflowId: ids[selected++] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const catalog = service.catalog()
  assert.equal(catalog.engine, 'workflow-v2')
  assert.deepEqual(catalog.messageStages.map(stage => stage.id), ['receive', 'context', 'S', 'R', 'material', 'routing-barrier', 'IB', 'intent-check', 'dispatch'])
  assert.equal(catalog.workflows.length, taskWorkflowCatalog.length)
  assert.equal(catalog.workflows.some(item => item.id === 'task-general'), false)
  assert.ok(ids.every(id => catalog.workflows.some(item => item.id === id && item.status === 'available' && item.version && item.nodes.length)))
  assert.equal(catalog.workflows.find(item => item.id === 'task-data-change').status, 'unavailable')
  for (let index = 0; index < ids.length; index++) {
    const receipt = await service.ingest({ ...message, messageId: `readonly-${index}`, text: `审阅材料 ${index}` })
    const state = await service.messages.process(receipt.runId)
    assert.equal(state.run.status, 'settled')
    const run = await execution.store.query({ kind: 'run', runId: state.commands[0].result.runId })
    assert.equal(run.run.workflowId, 'task-investigation')
    const view = (await service.tasks()).find(task => task.taskId === run.run.taskId)
    assert.equal(view.workflowId, 'task-investigation')
    assert.equal(view.workflowVersion, run.run.definitionVersion)
  }
  assert.deepEqual(taskWorkflowCatalog.filter(item => item.mode === 'read-only').map(item => item.id), ids)
  const envelope = { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '生产数据变更', workflowId: 'task-data-change' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  assert.equal(messageSchemas.I.safeParse(envelope).success, true)
  const denied = await fixture(t, 'owner', undefined, { judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] } : envelope })
  const blocked = await denied.service.ingest({ ...denied.message, messageId: 'external-denied', text: '执行生产数据变更' })
  const deniedState = await denied.service.messages.process(blocked.runId)
  assert.equal(deniedState.commands[0].status, 'applied')
  assert.equal((await denied.execution.store.query({ kind: 'run.list' })).length, 1)
  assert.equal((await denied.execution.store.query({ kind: 'run.list' }))[0].workflowId, 'task-investigation')
})

test('受信外部适配器齐备时目录可见，I 仍不能直接启动外部效果', async t => {
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
    const run = await execution.store.query({ kind: 'run', runId: state.commands[0].result.runId })
    assert.equal(run.run.workflowId, 'task-investigation')
  }
  assert.equal(prepared, 0)
  assert.equal(effects, 0)
})

test('原消息否定编辑取消原Task，不发第二个任务且屏障释放', async t => {
  const judge = async ({stage,input}) => stage === 'S' ? splitOne(input.source.text) : stage === 'R'
    ? {kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}
    : {kind:'intent',actions:[{intent:input.sourceEdit?'cancel':'create',arguments:input.sourceEdit?{}:{objective:'整理材料',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  const { service, execution, message } = await fixture(t,'owner',undefined,{judge})
  const first=await service.ingest(message); await service.messages.process(first.runId)
  const initial=(await service.state(first.runId)).commands[0]
  await execution.controller.whenIdle(initial.result.runId)
  const edit=await service.ingest({...message,text:'不要执行原任务，取消',messageVersion:2});await service.messages.process(edit.runId)
  const state=await service.state(edit.runId)
  assert.equal(state.commands[0]?.kind,'cancel',JSON.stringify(state));assert.equal(state.commands[0]?.status,'applied',JSON.stringify(state.commands[0]))
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
  assert.ok(state.barriers.every(b=>b.status==='resolved'))
})

test('运行中原消息修订更新 Task 要求并保持旧 Run 输入冻结', async t => {
  let release,started
  const began=new Promise(r=>started=r), gate=new Promise(r=>release=r)
  t.after(()=>release())
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:input.sourceEdit?'revise':'create',arguments:{objective:input.sourceEdit?'按新增要求分析':'整理材料',workflowId:'task-investigation'},dependsOn:[]}],constraints:input.sourceEdit?['新增格式要求']:['禁止生产写入'],requiredExecutionMaterials:[],replyPolicy:'result'}
  const {service,execution,message}=await fixture(t,'owner',undefined,{judge,execute:async({input})=>{started();await gate;return{summary:input.request}}})
  const first=await service.ingest(message);await service.messages.process(first.runId);await began
  const original=(await service.state(first.runId)).commands[0]
  const edit=await service.ingest({...message,text:'改为按新增要求分析',messageVersion:2});await service.messages.process(edit.runId)
  const state=await service.state(edit.runId)
  assert.equal(state.commands[0]?.kind,'revise',JSON.stringify(state.run));assert.equal(state.commands[0]?.status,'applied')
  assert.ok(state.barriers.every(b=>b.status==='resolved'))
  const runs=await execution.store.query({kind:'run.list'});assert.equal(runs.length,1);assert.equal(runs[0].taskId,original.result.taskId)
  release();await execution.controller.whenIdle(original.result.runId)
  const final=await execution.store.query({kind:'run',runId:original.result.runId})
  assert.equal((await execution.artifacts.read(final.run.requirementRef)).request,'整理材料')
  const plan=await execution.controller.taskPlan(original.result.taskId)
  assert.equal((await execution.artifacts.read(plan.task.requirementRef)).request,'按新增要求分析')
  assert.deepEqual((await execution.artifacts.read(plan.task.requirementRef)).constraints,['禁止生产写入','新增格式要求'])
  assert.ok(plan.task.planRequirementRevision<plan.task.requirementRevision)
})

test('新Task真实HTTP补充与取消同库幂等；无权/跨站/伪造输入不执行，暂停不恢复',async t=>{
 let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},execute:async()=>{started();await gate;return {summary:'done'}}})
 const received=await service.ingest(message);await service.messages.process(received.runId);await began
 const original=(await service.state(received.runId)).commands[0].result
 await execution.controller.pause({commandId:'pause-test',runId:original.runId,reason:'先暂停'});release();await execution.controller.whenIdle(original.runId)
 let legacyCalls=0
 const runtime={isWorkflowTask:service.isTask,submitWorkflowTask:r=>service.submitWebTask(r,{channel:'web',actorId:'owner'}),cancelTask:()=>{legacyCalls++;throw new Error('legacy')},appendTaskContext:()=>{legacyCalls++;throw new Error('legacy')}}
 const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const post=(action,body,origin)=>fetch(`http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/${action}`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
 const task=(await service.tasks())[0],input={requestId:'web-context-1',inputVersion:task.inputVersion,runSequence:1,context:'追加检查中文格式',topicRefs:[]}
 assert.equal((await post('context',input,'https://evil.example')).status,403)
 assert.equal((await post('context',{...input,actorId:'owner'})).status,400)
 await assert.rejects(service.submitWebTask({...input,action:'context',taskId:task.taskId},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 await assert.rejects(service.submitWebTask({action:'reissue-repository',taskId:task.taskId,repositoryId:'backend',requestId:'unauthorized'},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 const firstContext=await post('context',input);assert.equal(firstContext.status,202,await firstContext.text());assert.equal((await post('context',input)).status,202)
 assert.equal((await post('context',{...input,context:'冲突内容'})).status,409)
 let state=await execution.controller.state(original.runId);assert.equal(state.pendingInputCount,0);assert.equal(state.run.pauseRequested,true)
 const revisedPlan=await execution.controller.taskPlan(task.taskId)
 assert.equal(revisedPlan.task.requirementRevision,2)
 assert.match((await execution.artifacts.read(revisedPlan.task.requirementRef)).request,/追加检查中文格式/u)
 assert.equal((await execution.artifacts.read(state.run.requirementRef)).request,'整理本条材料')
 assert.equal((await post('reopen',input)).status,409);assert.equal((await post('archive',{})).status,409)
 const cancel={requestId:'web-cancel-1',inputVersion:(await service.tasks())[0].inputVersion,runSequence:1,reason:'停止'}
 assert.equal((await post('cancel',cancel)).status,202);assert.equal((await post('cancel',cancel)).status,202)
 await execution.controller.whenIdle(original.runId);state=await execution.controller.state(original.runId);assert.equal(state.run.status,'cancelled');assert.equal(legacyCalls,0)
})

test('Controller未排空错误投影等待原因，不能显示正常执行',async t=>{
 const {service,execution,message}=await fixture(t,'owner',undefined,{execute:async()=>{throw Object.assign(new Error('EXECUTOR_DRAIN_EVIDENCE_REQUIRED'),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED',executionDrained:false})}})
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result;await execution.controller.whenIdle(task.runId).catch(error=>assert.equal(error.code,'EXECUTOR_DRAIN_EVIDENCE_REQUIRED'))
 assert.equal((await execution.controller.state(task.runId)).run.status,'running')
 const view=(await service.tasks())[0];assert.equal(view.state,'waiting');assert.equal(view.waitingReason,'EXECUTOR_DRAIN_EVIDENCE_REQUIRED')
})

test('Web事件已准备后中断由恢复通路接纳一次，后续恢复不重复输入',async t=>{
 let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},execute:async()=>{started();await gate;return{summary:'done'}}})
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result;await began
 await execution.controller.pause({commandId:'prepare-pause',runId:task.runId,reason:'暂停'});release();await execution.controller.whenIdle(task.runId)
 const state=await execution.controller.state(task.runId),plan=await execution.controller.taskPlan(task.taskId)
 const prior=await execution.artifacts.read(plan.task.requirementRef)
 await execution.store.command({id:'prepare-only',kind:'message.web-task.prepare',args:{eventId:'web-crash',actorId:'owner',executionRunId:task.runId,request:{taskId:task.taskId,action:'context',requestId:'crash',inputVersion:plan.task.requirementRevision+1,runSequence:1,context:'新要求'},input:{...prior,request:prior.request+'\n新要求'}}})
 assert.deepEqual(await service.recoverExecutionTasks(),[]);await execution.controller.whenIdle(task.runId)
 assert.equal((await execution.store.query({kind:'message.web-task',eventId:'web-crash'})).status,'accepted')
 const before=await execution.controller.state(task.runId);assert.deepEqual(await service.recoverExecutionTasks(),[]);await execution.controller.whenIdle(task.runId)
 const after=await execution.controller.state(task.runId)
 assert.equal(after.run.revision,before.run.revision);assert.equal(after.pendingInputCount,before.pendingInputCount)
 const revised=await execution.controller.taskPlan(task.taskId)
 assert.equal(revised.task.requirementRevision,plan.task.requirementRevision+1)
 assert.match((await execution.artifacts.read(revised.task.requirementRef)).request,/新要求/u)
})

test('C01 媒体连接器挂起不阻durable接收和独立SQLite读回',{timeout:5000},async t=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r)
 const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:'create',arguments:{objective:'读取附件',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:['file'],replyPolicy:'result'}
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,readResource:async()=>{started();await gate;return{text:'完整材料'}}})
 const received=await service.ingest({...message,resourceRefs:[{type:'fileId',resourceId:'file'}]})
 try{await began;const persisted=await execution.store.query({kind:'message.run',runId:received.runId});assert.equal(persisted.run.body,message.text);assert.equal(persisted.commands.length,0);assert.equal((await execution.store.query({kind:'run.list'})).length,0)}finally{release()}
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
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '查 test3 账号创建记录', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    judge, execute: async () => ({ outcome: 'blocked', summary: '仅整理了消息文字', evidenceRefs: [], limitations: ['没有读取账号创建日志'], question: '' }),
  })
  const first = await service.ingest({ ...message, text: '查 test3 账号创建记录' })
  const accepted = await service.messages.process(first.runId)
  assert.ok(accepted.commands.length, JSON.stringify({ run: accepted.run, requests: accepted.requests, nodes: accepted.nodes }))
  const taskId = accepted.commands[0].result.taskId
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  await service.recover()
  const second = await service.ingest({ ...message, messageId: 'followup', text: '继续查这个账号' })
  await service.messages.process(second.runId)
  const taskReference = observed?.tasks?.find(item => item.taskId === taskId) ?? observed?.topicTasks?.tasks?.find(item => item.taskId === taskId)
  const task = taskReference
  assert.ok(task, JSON.stringify(observed))
  assert.ok(routingCard.distinguishingFacts.some(item => item.includes('执行状态：blocked')), JSON.stringify({routingCard,task}))
  assert.equal(task.run.status, 'failed')
  const failed = await execution.controller.state(accepted.commands[0].result.runId)
  assert.equal(failed.nodes.find(node => node.nodeId === 'investigate').status, 'failed')
  assert.equal(task.objectiveAssessment.status, 'insufficient_evidence')
  assert.notEqual((await service.tasks()).find(item => item.taskId === taskId)?.state, 'completed')
})

test('方案阶段完成后等待确认，确认沿用业务Task并只启动下一阶段', async t => {
  const sent = []
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
    const decision = { action: !input.stages.length ? 'advance' : complete ? 'complete'
      : input.stages.some(stage => stage.status === 'ready') ? 'advance' : 'wait',
      summary: complete ? '两段工作已核验' : '等待方案确认或流程完成',
      evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []),
      ...(!input.stages.length ? { planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-investigation', gate: 'none' }, { workflowId: 'task-investigation', gate: 'confirmation' },
      ] } } : {}),
      ...(complete ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
        evidenceRefs: input.stages.flatMap(stage => stage.evidenceRefs ?? []) })) } : {}),
    }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge, taskOwnerSessions })
  const first = await service.ingest({ ...message, text: '先给方案，确认后继续' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  assert.ok(accepted.commands[0]?.result?.runId, JSON.stringify({ run: accepted.run, requests: accepted.requests, commands: accepted.commands }))
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  await service.flushNotifications()
  assert.equal(sent.filter(item => item.startsWith('任务等待确认')).length, 1)
  let plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.status, 'waiting_confirmation')
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
  const second = await service.ingest({ ...message, messageId: 'confirm-stage', text: '确认方案，继续执行' })
  const confirmed = await service.messages.process(second.runId)
  assert.equal(confirmed.commands[0].status, 'applied', JSON.stringify(confirmed.commands))
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[1].status, 'running')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded', JSON.stringify({owner:await execution.store.query({kind:'task.owner',taskId}),state:await execution.controller.state(plan.stages[1].runId)}))
})

test('UAT 缺受信适配器时已完成分析保留，Owner 后续阶段明确受阻', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先分析再提测',
        explicitStages: ['先分析，随后部署 UAT 提测'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const decision = !input.stages.length
      ? { action: 'advance', summary: '先分析', evidenceRefs: [], planChange: { kind: 'initialize',
        stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
      : { action: 'advance', summary: '准备 UAT', evidenceRefs: [], planChange: { kind: 'append',
        stages: [{ workflowId: 'task-uat-deployment', gate: 'none' }] } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions })
  const received = await service.ingest({ ...message, text: '分析并提测' })
  const result = await service.messages.process(received.runId)
  assert.equal(result.commands[0].status, 'applied')
  await execution.controller.whenIdle(result.commands[0].result.runId)
  const recovered = await service.recover()
  assert.ok(recovered.failures.some(item => item.code === 'TASK_OWNER_STAGE_NOT_AUTHORIZED'))
  const task = (await service.tasks())[0]
  assert.equal(task.state, 'waiting')
  assert.equal(task.plan.stages.length, 1)
  assert.equal(task.plan.stages[0].status, 'succeeded')
  assert.match(task.waitingReason, /TASK_OWNER_STAGE_NOT_AUTHORIZED/u)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId: task.taskId })).length, 1)
})

test('阶段间取消后经原发送人重新授权，只替换未完成后缀', async t => {
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const stages = input.stages
    const decision = !stages.length
      ? { action: 'advance', summary: '先分析，待确认', evidenceRefs: [],
        planChange: { kind: 'initialize', stages: [
          { workflowId: 'task-investigation', gate: 'none' }, { workflowId: 'task-investigation', gate: 'confirmation' }] } }
      : input.goal.request === '重新开展后续分析'
        ? { action: 'advance', summary: '仅替换未执行后缀', evidenceRefs: [],
          planChange: { kind: 'replaceSuffix', affectedFrom: 1,
            stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
        : { action: 'wait', summary: '等待确认', evidenceRefs: [] }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : input.text.startsWith('取消')
        ? { kind: 'intent', actions: [{ intent: 'cancel', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : input.text.startsWith('重新')
          ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '重新开展后续分析',
            workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
          : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先分析',
            explicitStages: ['先分析，确认后继续'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions })
  const initial = await service.ingest({ ...message, text: '先分析' })
  const created = await service.messages.process(initial.runId)
  const taskId = created.commands[0].result.taskId, firstRunId = created.commands[0].result.runId
  await execution.controller.whenIdle(firstRunId)
  assert.deepEqual((await service.recover()).failures, [])
  const cancel = await service.ingest({ ...message, messageId: 'cancel-between', text: '取消这个任务' })
  await service.messages.process(cancel.runId)
  assert.equal((await execution.controller.taskPlan(taskId)).task.controlState, 'cancelled')
  const cancelledView = (await service.tasks()).find(item => item.taskId === taskId)
  assert.equal(cancelledView.state, 'completed')
  assert.equal(cancelledView.outcome, 'cancelled')
  assert.equal(cancelledView.waitingReason, undefined)
  assert.equal((await execution.controller.taskPlan(taskId)).task.controlRevision, 2)
  const reopen = await service.ingest({ ...message, messageId: 'reopen-after-cancel', text: '重新开展后续分析' })
  const resumed = await service.messages.process(reopen.runId)
  assert.equal(resumed.commands[0].status, 'applied', JSON.stringify({ command: resumed.commands[0], plan: await execution.controller.taskPlan(taskId) }))
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.planRevision, 2)
  assert.equal(plan.task.controlState, 'active')
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.ok(plan.stages[1].runId, JSON.stringify({plan,owner:await execution.store.query({kind:'task.owner',taskId})}))
})

test('已绑定Owner会话确实缺失时换代并在原Task恢复，旧任务命令不重复创建', async t => {
  let first = true
  const sessions = { async run({ binding, onSessionBound, onCandidate }) {
    if (first) {
      first = false
      await onSessionBound()
      throw Object.assign(new Error('missing'), { code: 'TASK_OWNER_SESSION_MISSING' })
    }
    await onSessionBound()
    const decision = { action: 'advance', summary: '恢复同一任务', evidenceRefs: [],
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions })
  const received = await service.ingest(message)
  const attempted = await service.messages.process(received.runId)
  assert.equal(attempted.commands[0].status, 'applied')
  assert.match(attempted.commands[0].result.reply, /暂时无法开始处理/u)
  const before = (await execution.store.query({ kind: 'task.owners.list', limit: 10 }))[0]
  assert.equal(before.ownerEpoch, 2)
  assert.equal(before.status, 'pending')
  assert.deepEqual((await service.recover()).failures, [])
  const after = await execution.store.query({ kind: 'task.owner', taskId: before.taskId })
  assert.equal(after.taskId, before.taskId)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.ownerEpoch, 2)
  assert.equal((await execution.store.query({ kind: 'task.owners.list', limit: 10 })).length, 1)
  assert.equal((await execution.controller.taskPlan(before.taskId)).stages.length, 1)
})

test('专业分析后在同一 Task 读取前序产物，不依赖 general intake', async t => {
  let execution
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const stages = input.stages
    const completed = stages.length > 0 && stages.every(stage => stage.status === 'succeeded')
    let decision
    if (!stages.length) decision = { action: 'advance', summary: '先分析', evidenceRefs: [],
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }, { workflowId: 'task-investigation', gate: 'none' }] } }
    else if (completed) decision = { action: 'complete', summary: '分析与产物回读均完成',
      evidenceRefs: stages.map(stage => stage.outputRef),
      assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
        evidenceRefs: stages.map(stage => stage.outputRef) })) }
    else decision = { action: stages.some(stage => stage.status === 'ready' || stage.status === 'blocked') ? 'advance' : 'wait', summary: '推进或等待当前流程', evidenceRefs: [] }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution: actual, message } = await fixture(t, 'owner', undefined, {
    taskOwnerSessions: sessions, execute: async ({ input }) => {
      if (input.scope.predecessorOutputRef) {
        const previous = await execution.artifacts.read(input.scope.predecessorOutputRef)
        assert.equal(input.handoff.outputRef, input.scope.predecessorOutputRef)
        return { outcome: 'completed', summary: `已回读：${previous.summary}`, evidenceRefs: [input.scope.predecessorOutputRef], limitations: [], question: '' }
      }
      return { outcome: 'completed', summary: '已分析原材料', evidenceRefs: input.materials.map(item => item.id), limitations: [], question: '' }
    }, judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先分析再核对产物' },
          dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' },
  })
  execution = actual
  const received = await service.ingest({ ...message, text: '先分析再核对产物' })
  const handled = await service.messages.process(received.runId)
  const taskId = handled.commands[0].result.taskId
  for (let attempt = 0; attempt < 8; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages) if (stage.runId) await execution.controller.whenIdle(stage.runId)
    assert.deepEqual((await service.recover()).failures, [])
    if ((await execution.controller.taskPlan(taskId)).stages.length === 2
      && (await execution.store.query({ kind: 'task.owner', taskId })).decision?.action === 'complete') break
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.deepEqual(plan.stages.map(stage => stage.workflowId), ['task-investigation', 'task-investigation'])
  const step = await execution.artifacts.read(plan.stages[1].requirementRef)
  assert.equal(step.scope.predecessorOutputRef, plan.stages[0].outputRef)
  assert.deepEqual((await execution.artifacts.read(plan.stages[1].outputRef)).evidenceRefs, [plan.stages[0].outputRef])
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.action, 'complete')
})

test('Owner 可在零阶段 Task 选择共享调查并按来源完成原文整理', async t => {
  let execution
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const stage = input.stages[0]
    let decision
    if (!stage) decision = { action: 'advance', summary: '整理来源原文', evidenceRefs: [],
      planChange: { kind: 'initialize', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
    else if (stage.status === 'succeeded') {
      const output = await execution.artifacts.read(stage.outputRef)
      decision = { action: 'complete', summary: output.summary, evidenceRefs: [stage.outputRef],
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
          evidenceRefs: [stage.outputRef] })) }
    } else decision = { action: 'wait', summary: '等待执行', evidenceRefs: [] }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const result = await fixture(t, 'owner', undefined, { taskOwnerSessions: sessions, execute: async ({ input }) => ({ outcome: 'completed', summary: input.materials.map(item => item.text).join('\n'), evidenceRefs: input.materials.map(item => item.id), limitations: [], question: '' }),
    judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理消息原文' },
          dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' } })
  execution = result.execution
  const received = await result.service.ingest({ ...result.message, text: '整理消息原文' })
  const handled = await result.service.messages.process(received.runId)
  const taskId = handled.commands[0].result.taskId
  await execution.controller.whenIdle(handled.commands[0].result.runId)
  assert.deepEqual((await result.service.recover()).failures, [])
  const plan = await execution.controller.taskPlan(taskId)
  assert.deepEqual(plan.stages.map(stage => stage.workflowId), ['task-investigation'])
  assert.equal((await execution.store.query({ kind: 'task.owner', taskId })).decision.action, 'complete')
})
test('执行中收到追加阶段意图时保留当前Run，完成后从核验产物启动后继', async t => {
  let release, began
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { began = resolve })
  t.after(() => release())
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const stages = input.stages
    const extra = input.goal.request === '追加后续分析'
    const decision = !stages.length
      ? { action: 'advance', summary: '先排查', evidenceRefs: [], planChange: { kind: 'initialize',
        stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
      : extra && stages.length === 1
        ? { action: 'advance', summary: '保留当前执行并追加分析', evidenceRefs: [],
          planChange: { kind: 'append', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
        : stages.length === 2 && stages[1].status === 'ready'
          ? { action: 'advance', summary: '执行追加分析', evidenceRefs: [] }
        : stages.length === 2 && stages.every(stage => stage.status === 'succeeded')
          ? { action: 'complete', summary: '两段分析完成', evidenceRefs: stages.map(stage => stage.outputRef),
            assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
              evidenceRefs: stages.map(stage => stage.outputRef) })) }
          : { action: 'wait', summary: '等待执行', evidenceRefs: [] }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : input.text.startsWith('追加')
        ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '追加后续分析' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先排查', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions,
    execute: async ({ input }) => { if (input.request === '先排查') { began(); await gate }; return { summary: input.request, evidenceIds: input.materials.map(item => item.id), limitations: [] } } })
  const first = await service.ingest({ ...message, text: '先排查' })
  const accepted = await service.messages.process(first.runId)
  await started
  const taskId = accepted.commands[0].result.taskId
  const firstRunId = accepted.commands[0].result.runId
  const second = await service.ingest({ ...message, messageId: 'append-later', text: '追加后续分析' })
  const appended = await service.messages.process(second.runId)
  assert.equal(appended.commands[0].status, 'applied')
  let plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 2)
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[1].status, 'blocked')
  release(); await execution.controller.whenIdle(firstRunId)
  assert.deepEqual((await service.recover()).failures, [])
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[1].status, 'running')
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
})

test('纯排查完成后续办仍用原业务Task，原Run成功证据不重跑', async t => {
  const sessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const stages = input.stages
    const continued = input.goal.request === '继续分析'
    const decision = !stages.length
      ? { action: 'advance', summary: '仅排查', evidenceRefs: [], planChange: { kind: 'initialize',
        stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
      : continued && stages.length === 1
        ? { action: 'advance', summary: '保留旧证据并继续', evidenceRefs: [],
          planChange: { kind: 'append', stages: [{ workflowId: 'task-investigation', gate: 'none' }] } }
        : stages.every(stage => stage.status === 'succeeded')
          ? { action: 'complete', summary: '当前目标已完成', evidenceRefs: stages.map(stage => stage.outputRef),
            assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied',
              evidenceRefs: stages.map(stage => stage.outputRef) })) }
          : { action: 'wait', summary: '等待执行', evidenceRefs: [] }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : input.text.startsWith('继续')
        ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '继续分析', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '仅排查', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions: sessions })
  const first = await service.ingest({ ...message, text: '仅排查' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId, firstRunId = accepted.commands[0].result.runId
  await execution.controller.whenIdle(firstRunId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded')
  const second = await service.ingest({ ...message, messageId: 'continue-task', text: '继续分析' })
  const resumed = await service.messages.process(second.runId)
  assert.equal(resumed.commands[0].status, 'applied')
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.planRevision, 1)
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'running')
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await service.tasks()).length, 1)
})

test('C13 渠道读回挂起时新业务和取消继续，ACK不冒充送达',{timeout:7000},async t=>{
 let readStarted,releaseRead,executionStarted,releaseExecution,executions=0,disclose=false
 const reading=new Promise(r=>readStarted=r),readGate=new Promise(r=>releaseRead=r),running=new Promise(r=>executionStarted=r),executionGate=new Promise(r=>releaseExecution=r)
 const notices={canDisclose:async()=>disclose,send:async n=>({messageId:n.id}),readback:async n=>{readStarted();await readGate;return{messageId:n.id,conversationId:'g'}}}
 const {service,execution,message}=await fixture(t,'owner',notices,{config:{webActorId:'owner'},execute:async({input})=>{if(++executions===1){executionStarted();await executionGate}return{summary:'完成',evidenceRefs:input.materials.map(item=>item.id)}}})
 const first=await service.ingest(message);await service.messages.process(first.runId);await running
 const task=(await service.state(first.runId)).commands[0].result;await service.flushNotifications();assert.equal((await execution.store.query({kind:'message.notifications'}))[0].status,'prepared');disclose=true;const flushing=service.flushNotifications()
 try{await reading
 const pending=await execution.store.query({kind:'message.notifications'});assert.ok(pending.some(n=>n.status==='acknowledged'));assert.ok(!pending.some(n=>n.status==='delivered'))
 const next=await service.ingest({...message,messageId:'second'});await service.messages.process(next.runId);const nextTask=(await service.state(next.runId)).commands[0].result;await execution.controller.whenIdle(nextTask.runId)
 assert.equal((await execution.controller.state(nextTask.runId)).run.status,'succeeded')
 const view=(await service.tasks()).find(t=>t.taskId===task.taskId);assert.equal(view.state,'running')
 await service.submitWebTask({action:'cancel',taskId:task.taskId,requestId:'cancel-during-readback',inputVersion:view.inputVersion,runSequence:1,reason:'取消'},{channel:'web',actorId:'owner'})
 assert.equal((await execution.controller.state(task.runId)).run.stopRequested,true)
 }finally{releaseExecution();releaseRead()}
 await flushing;await execution.controller.whenIdle(task.runId);assert.equal((await execution.controller.state(task.runId)).run.status,'cancelled')
 assert.equal((await execution.store.query({kind:'message.notifications',states:['delivered']})).length,1)
})

test('只读轨迹 API 回读真实节点、话题批次与已绑定 Owner，并隔离其他群', async t => {
  const { service, execution, message } = await fixture(t)
  const receipt = await service.ingest(message)
  const processed = await service.messages.process(receipt.runId)
  const command = processed.commands.find(item => item.status === 'applied')
  assert.ok(command?.result.taskId)
  await execution.controller.whenIdle(command.result.runId)
  const trace = await service.messageTrace(receipt.runId)
  assert.equal(trace.runId, receipt.runId)
  assert.equal(trace.message.text,message.text)
  assert.ok(trace.items.some(item => item.kind === 'split' && item.summary?.conclusion))
  assert.ok(trace.items.some(item => item.kind === 'route' && item.summary?.conclusion))
  const intent = trace.items.find(item => item.kind === 'intent')
  assert.ok(intent?.summary?.conclusion)
  for(const item of trace.items)for(const key of ['input','output','usage','evidenceRefs'])assert.equal(Object.hasOwn(item,key),false)
  assert.ok(intent.sourceRunIds.includes(receipt.runId))
  assert.equal(intent.sourceMessages.find(item=>item.runId===receipt.runId).text,message.text)
  assert.equal(intent.sourceMessages.find(item=>item.runId===receipt.runId).current,true)
  assert.ok(intent.startedAt)
  assert.ok(trace.items.some(item => item.kind === 'command' && item.summary.rows.some(row=>row.label==='后续任务')))
  const page = await service.messageTrace(receipt.runId, { limit: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.nextCursor, 1)
  const topicId = processed.units[0].topicId
  const context = await service.workflowTopicContext(topicId)
  await assert.rejects(service.workflowTopicContext(topicId, { expectedRevision: context.revision + 1 }), /MESSAGE_TOPIC_CONTEXT_STALE/)
  assert.ok(context.facts.some(fact => fact.sourceRefs.some(ref => ref.text === message.text)))
  assert.ok(context.intentRuns.some(batch => batch.sourceRunIds.includes(receipt.runId)))
  const runs = await service.taskRuns(command.result.taskId)
  assert.equal(runs.taskOwner.sessionBound, true)
  assert.ok(runs.taskOwner.sessionId)
  assert.ok(runs.runs.some(run => run.runId === command.result.runId && run.nodes.some(node => node.nodeId === 'investigate')))
  const outputNode = (await execution.controller.state(command.result.runId)).nodes[0]
  const outputArgs = { outputRef: outputNode.outputRef, limit: 8 }
  const outputPage = await service.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, outputArgs)
  assert.ok(outputPage.text.startsWith('产出摘要'))
  assert.equal(outputPage.nextCursor, 8)
  const rest = await service.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, { ...outputArgs, offset: 8, limit: 8000 })
  assert.match(outputPage.text + rest.text, /已分析/)
  assert.equal(rest.nextCursor, null)
  assert.equal(await service.taskNodeOutput('other-task', command.result.runId, outputNode.nodeRunId, outputArgs), null)
  assert.equal(await service.taskNodeOutput(command.result.taskId, command.result.runId, 'other-node', outputArgs), null)
  await assert.rejects(service.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, { outputRef: 'wrong' }), /TASK_OUTPUT_CHANGED/)
  await assert.rejects(service.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, { outputRef: 'wrong', document: true }), /TASK_OUTPUT_CHANGED/)
  assert.equal(await service.taskNodeOutput('other-task', command.result.runId, outputNode.nodeRunId, { ...outputArgs, document: true }), null)
  const other = await openWorkflowService({ ctx: {}, config: { groupIds: ['other'], ownerActorId: 'owner' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test', agentNames: ['小助手', '用户'] }), getGroup: () => ({ messages: [] }) },
    execution, judge: async () => { throw new Error('UNEXPECTED_MODEL_CALL') },
    taskOwnerSessions: { async run() { throw new Error('UNEXPECTED_OWNER_CALL') }, async close() {} } })
  try {
    assert.equal(await other.workflowTopicContext(topicId), null)
    assert.equal(await other.messageTrace(receipt.runId), null)
    assert.equal(await other.taskRuns(command.result.taskId), null)
    assert.equal(await other.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, outputArgs), null)
    assert.equal(await other.taskNodeOutput(command.result.taskId, command.result.runId, outputNode.nodeRunId, { ...outputArgs, document: true }), null)
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

test('同话题一千条相同事实在 IB 合并投影，跨发送人或不同约束不合并',async t=>{
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
 assert.equal(projected.historyFactCount,1003)
 assert.equal(projected.facts.length,4)
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
   return {kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],factRevisions:[{factId:fact.id,sourceQuote,scope:'当前话题'}],requiredExecutionMaterials:[],replyPolicy:'none'}
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
   assert.ok(state.requests.some(request=>request.reason==='TOPIC_FACT_REVISION_UNCONFIRMED'&&request.status==='pending'),JSON.stringify(state))
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
   return{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],factRevisions:[{factId:fact.id,sourceQuote,scope}],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  await seedCompletedTopicFact(execution.store,`partial-${scope}`,'partial-revision-topic',priorText)
  const receipt=await service.ingest({...message,messageId:`partial-answer-${scope}`,text:`请整理材料；${sourceQuote}`,quotedMessage:{messageId:`seed-message-partial-${scope}`,content:priorText}})
  const state=await service.messages.process(receipt.runId)
  assert.deepEqual(state.commands,[])
  assert.ok(state.requests.some(request=>request.reason==='TOPIC_FACT_REVISION_UNCONFIRMED'&&request.status==='pending'),JSON.stringify(state))
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

test('普通 answer 的 Host 门禁拒绝已排队的旧参数与任务参数，且不豁免创建权限', async t => {
  const { service, execution } = await fixture(t, 'participant', undefined, { judge: async () => { throw new Error('QUEUED_COMMAND_MUST_NOT_REJUDGE') } })
  const cases = [
    { intent: 'answer', arguments: { answer: '已收到' } },
    { intent: 'answer', arguments: { objective: '旧材料任务', workflowId: 'task-investigation' } },
    { intent: 'answer', arguments: { text: '已收到', workflowId: 'task-engineering', repositoryId: 'repo' } },
    { intent: 'create', arguments: { objective: '创建任务', workflowId: 'task-investigation' } },
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
      : { intent: 'create', arguments: { objective: '整理材料', workflowId: 'task-investigation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest(message), initial = (await service.messages.process(first.runId)).commands[0]
  await execution.controller.whenIdle(initial.result.runId)
  const original = await execution.controller.taskPlan(initial.result.taskId)
  const edited = await service.ingest({ ...message, text: '整理材料，附注只是说明；请回复收到', messageVersion: 2 })
  const state = await service.messages.process(edited.runId)
  assert.equal(state.commands[0]?.kind, 'answer', JSON.stringify(state))
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.commands[0].args.taskId, null)
  assert.equal(state.requests.filter(request => request.status === 'pending').length, 0)
  assert.ok(state.barriers.every(barrier => barrier.status === 'resolved'))
  const after = await execution.controller.taskPlan(initial.result.taskId)
  assert.equal(after.task.requirementRef, original.task.requirementRef)
  assert.equal(after.task.requirementRevision, original.task.requirementRevision)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 1)
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
  assert.deepEqual(state.commands[0].result, { status: 'answered', reply: '已收到 E2E-0927-2212', resultRef: state.commands[0].result.resultRef, evidenceRefs: [], limitations: [] })
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


for (const [body, environment] of [['修复合并问题', undefined], ['修复合并问题', 'uat1'], ['提交到uat1或uat2', 'uat1'], ['提交到uat1～9', 'uat1']]) test(`开发目标缺失或不明确先询问具体UAT：${body}/${environment}`, async t => {
  const { service, message } = await fixture(t, 'owner', undefined, { judge: async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, workflowId: 'task-engineering', repositoryId: 'repo', ...(environment ? { uatEnvironment: environment } : {}) }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  } })
  const receipt = await service.ingest({ ...message, text: body })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.commands.length, 0)
  const question = state.requests.find(item => item.kind === 'needs_clarification' && item.status === 'pending')
  assert.equal(question.reason, 'ENGINEERING_UAT_ENVIRONMENT_REQUIRED')
  assert.match(question.question, /uat1～uat9/)
})


test('UAT澄清回答绑定同一请求并进入任务目标，不猜环境或重新拆消息', async t => {
  let environment, splits=0
  const { service, execution, message }=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},judge:async({stage,input})=>{
    if(stage==='S'){splits++;return splitOne(input.source.text)}
    if(stage==='R')return {kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    return {kind:'intent',actions:[{intent:'create',arguments:{objective:'修复代码',workflowId:'task-engineering',repositoryId:'repo',...(environment?{uatEnvironment:environment}:{})},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  }})
  const receipt=await service.ingest({...message,text:'修复代码'})
  const before=await service.messages.process(receipt.runId)
  const request=before.requests.find(item=>item.status==='pending')
  environment='uat4'
  await service.resumeRequest({runId:receipt.runId,requestId:request.id,eventId:'choose-uat4',answer:'uat4'},{channel:'web',actorId:'owner'})
  const after=await service.messages.process(receipt.runId)
  assert.equal(after.requests.filter(item=>item.status==='pending').length,0)
  assert.equal(splits,1)
  const command=after.commands.find(item=>item.status==='applied')
  assert.ok(command,JSON.stringify(after.commands))
  const plan=await execution.controller.taskPlan(command.result.taskId)
  assert.equal((await execution.artifacts.read(plan.task.requirementRef)).target.uatEnvironment,'uat4')
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

for (const recoveryCode of ['ECONNRESET', 'ENGINEERING_REMOTE_READ_TRANSIENT']) test(`暂态恢复三次上限与退避持久化 ${recoveryCode}，重开控制账不能重置额度`, async t => {
  let executions=0
  const {service,execution,message,startCodeTask}=await fixture(t,'owner',undefined,{execute:async()=>{executions++;throw Object.assign(Error(recoveryCode),{code:recoveryCode})},extraNodes:[{
    id:'finish',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:()=>({}),execute:async()=>({})
  }]})
  const task=await startCodeTask()
  await execution.controller.whenIdle(task.runId)
  for(const delay of [0,1100,2100]) {
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay))
    await service.recoverExecutionTasks();await execution.controller.whenIdle(task.runId)
  }
  assert.equal(executions,4)
  await service.recoverExecutionTasks();await execution.controller.whenIdle(task.runId);assert.equal(executions,4)
  const state=await execution.controller.state(task.runId),node=state.nodes.find(n=>n.status==='waiting')
  assert.equal(state.run.claimCount,4)
  const directory=await mkdtemp(join(tmpdir(),'recovery-reopen-')),dbPath=join(directory,'control.db')
  const db=new DatabaseSync(join(execution.artifacts.root,'..','control.db'),{readOnly:true})
  try {
    const events=db.prepare("SELECT payload FROM execution_events WHERE kind='run.recovery.admitted' ORDER BY seq").all().map(row=>JSON.parse(row.payload))
    assert.deepEqual(events.map(event=>event.attempt),[1,2,3]);assert.equal(new Set(events.map(event=>event.key)).size,1)
    await backup(db,dbPath)
  } finally {db.close()}
  const reopened=await openExecutionStore({dbPath,instanceId:'test',initialize:false})
  try {await assert.rejects(reopened.command({id:'after-reopen',kind:'run.recovery.admit',args:{runId:task.runId,runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:state.run.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,errorCode:recoveryCode}}),/RECOVERY_RETRY_LIMIT/)} finally {await reopened.close()}
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
  await service.recoverExecutionTasks(); await execution.controller.whenIdle(task.runId)
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
  await execution.controller.whenIdle(original.runId)
  await service.recoverExecutionTasks()
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
  const visible = await service.listApprovalRequests()
  assert.equal(visible.length, 1); assert.equal(visible[0].requestId, requestId)
  assert.equal(visible[0].objective, '验证UAT3提测'); assert.match(visible[0].requestedAction, /UAT 目标 dataset-uat3-deployment/)
  assert.match(visible[0].requestedAction, /HiQ-AI\/dataset/); assert.ok(visible[0].evidence.includes(commitSha))
  assert.equal(visible[0].status, 'waiting-reply'); assert.equal(sends, 0)
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
 await service.recoverExecutionTasks();await execution.controller.whenIdle(task.runId);const after=await execution.controller.state(task.runId)
 assert.equal(after.run.status,valid?'failed':'waiting');assert.equal(after.nodes[0].status,valid?'failed':'waiting');assert.equal(after.run.generation,before.run.generation);assert.equal(sends,1);assert.equal(reads,1)
 if(valid){assert.equal(after.nodes[0].waitReason.reference,'RELEASE_PIPELINE_FAILED');assert.deepEqual(await execution.artifacts.read(after.nodes[0].evidenceRefs[0]),receipt)}
 await service.recoverExecutionTasks();await execution.controller.whenIdle(task.runId);assert.equal(sends,1);assert.equal(reads,1)
})

test('任务投影只在真实等待时显示原因，完成后隐藏遗留原因且不改历史', async t => {
  let succeed = false, staleReadback = false
  const { service, execution, message } = await fixture(t, 'owner', undefined, { storeQuery: async (request, query) => {
    const value = await query(request)
    return staleReadback && request.kind === 'run.list' ? value.map(run => ({ ...run,
      recoveryReason: 'DELIVERY_RECONCILIATION_REQUIRED' })) : value
  }, execute: async ({ input }) => {
    if (!succeed) throw Object.assign(new Error('DELIVERY_RECONCILIATION_REQUIRED'), { code: 'DELIVERY_RECONCILIATION_REQUIRED' })
    return { summary: '已核对完成', evidenceIds: input.materials.map(item=>item.id), limitations: [] }
  } })
  const accepted = await service.ingest(message); await service.messages.process(accepted.runId)
  const task = (await service.state(accepted.runId)).commands[0].result
  await execution.controller.whenIdle(task.runId)
  const waiting = (await service.tasks()).find(item => item.taskId === task.taskId)
  assert.equal(waiting.state, 'waiting')
  assert.equal(waiting.waitingReason, 'DELIVERY_RECONCILIATION_REQUIRED')
  succeed = true
  await execution.controller.recover({ commandId: 'projection-recover', runId: task.runId })
  await execution.controller.whenIdle(task.runId)
  await service.recoverExecutionTasks()
  const before = await execution.store.query({ kind: 'run', runId: task.runId })
  // 只读替身复现历史 Run 留有 recoveryReason；不往控制库补造或清除数据。
  staleReadback = true
  try {
    const completed = (await service.tasks()).find(item => item.taskId === task.taskId)
    assert.equal(completed.state, 'completed'); assert.equal(completed.outcome, 'succeeded')
    assert.equal(completed.waitingReason, undefined)
    assert.equal(completed.stageConfirmation, null); assert.equal(completed.budgetContinuation, null)
    assert.deepEqual(await execution.store.query({ kind: 'run', runId: task.runId }), before)
  } finally { staleReadback = false }
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
  const sessions={async run({input,onSessionBound,onCandidate}){
    ownerInputs.push(input);await onSessionBound();const done=input.stages.length>0&&input.stages.every(stage=>stage.status==='succeeded')
    const evidenceRefs=input.stages.map(stage=>stage.outputRef).filter(Boolean)
    const decision={action:input.stages.length===0?'advance':done?'complete':'wait',summary:'已核对阶段证据',evidenceRefs,
      ...(input.stages.length===0?{planChange:{kind:'initialize',stages:[{workflowId:'task-investigation',gate:'none'}]}}:{}),
      ...(done?{assessments:input.acceptanceItems.map(item=>({itemId:item.itemId,status:'satisfied',evidenceRefs:
        input.taskId==='owner-uat-rebuild'?[input.stages[item.criterion===criteria[0]?0:2].outputRef]:evidenceRefs}))}:{})}
    await onCandidate(decision);return{status:'submitted',decision}
  },async close(){}}
  const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},external,taskOwnerSessions:sessions,
    generalCompletionCheck:async input=>{
      domainChecks.push(input)
      assert.deepEqual(input.acceptanceCriteria,[criteria[1]])
      assert.equal(input.evidence.length,1)
      assert.equal(input.evidence.some(item=>item.mergeCommitSha),false)
      assert.equal(input.evidence.some(item=>item.deliveryStatus==='pr_verified'),false)
      const deployed=input.evidence.find(item=>item.workflowKind==='uat-rebuild')
      assert.equal(deployed?.status,'technical-delivery-confirmed')
      assert.equal(deployed.commitSha,commitSha)
      assert.deepEqual(deployed.evidenceRefs,['proof-runtime'])
      assert.deepEqual(input.acceptanceItems[0].evidenceRefs,[deployed.evidenceId])
      return{status:'satisfied',resultVerified:true,criteria:[{criterion:criteria[1],passed:true,evidenceIds:[deployed.evidenceId]}]}
    },deliveryOptions:{authorize:async()=>false,
    authorizeExternal:async()=>({principalId:'owner',authorizationRef:'isolated-test'}),externalAdapter:{
      execute:async prepared=>{if(prepared.operation==='rebuild'){rebuilds++;return{status:'succeeded'}}deploymentSends++;return{status:'failed',reason:'RELEASE_PIPELINE_FAILED',
        operationKey:prepared.operationKey,commitSha,pipelineNumber:319,pipelineStatus:'killed',evidenceRef:'pipeline-319'}},reconcile:async()=>({status:'unknown'})}}})
  const received=await service.ingest(message);await service.messages.process(received.runId)
  const original=(await service.state(received.runId)).commands[0].result;await execution.controller.whenIdle(original.runId);await execution.controller.advanceTaskPlan(original.taskId)
  await service.recoverExecutionTasks()
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
  const goal=await execution.artifacts.put({request:'开发并提测',acceptanceCriteria:criteria,constraints:[],explicitStages:[],authorization:{channel:'web'},reportChannel:'web',externalMessaging:false})
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
  for(let i=0;i<5;i++){await service.recoverExecutionTasks();plan=await execution.controller.taskPlan(taskId);if(plan.stages[2].runId)await execution.controller.whenIdle(plan.stages[2].runId)}
  assert.equal(plan.task.planRevision,2);assert.equal(plan.task.status,'succeeded');assert.equal(plan.stages[2].workflowId,'task-uat-rebuild')
  assert.deepEqual(plan.stages.slice(0,2),prefix);assert.equal(deploymentSends,1);assert.equal(rebuilds,1)
  assert.equal((await execution.controller.state(failedRun)).run.status,'failed')
  const owner=await execution.store.query({kind:'task.owner',taskId});assert.equal(owner.decision.action,'complete',JSON.stringify(owner))
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


test('调查成功产物经真实Service与工程准备进入方案节点输入，伪造前序引用拒绝', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'investigation-engineering-handoff-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source'); await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'feature/uat2-base')
  const profile = join(directory, 'uat.json'); await writeFile(profile, JSON.stringify({ environment: 'uat', env: {} }))
  const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
  const localAcceptance = { version: '1', sharedDataProfilePath: profile, timeoutMs: 90000, prepareSteps: [], service: { ...command, args: [...command.args, '{port}', '127.0.0.1'], readyPath: '/' }, scenarios: [{ id: 'value', description: '业务值', ...command }], cleanup: command, verifyCleanup: command }
  const repositories = [{ id: 'repo', sourceRepository: source, managedRoot: join(directory, 'managed'), remote: source,
    baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'], localAcceptance,
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }]
  let execution, proposalInput
  const registry = createEngineeringRegistry({ repositories, ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }) })
  const delivery = { async execute(request) {
    await registry.restore(execution.store, execution.artifacts)
    return createExecutionDelivery({ store: execution.store, artifacts: execution.artifacts, ...registry.deliveryOptions }).execute(request)
  } }
  const executionSessions = { async run({ binding, input, onSessionBound, onResult }) {
    await onSessionBound()
    if (binding.nodeId === 'investigate') {
      await onResult({ ...investigationResult(input, { outcome: 'completed', summary: '方案：按当前基线修复value；证据来自已读原文；尚需业务验收',
        evidenceRefs: input.materials.map(item => item.id), limitations: ['当前建议尚未实施'], question: '' }),
        openItems: [{ description: '修复value并业务验收', reason: '当前仅完成调查', evidenceRefs: [] }],
        criterionReviews: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'insufficient_evidence', reason: '尚需完成开发及业务验收', evidenceRefs: [] })) })
      return { status: 'submitted' }
    }
    if (binding.nodeId === 'plan-local-acceptance') { await onResult({ cases: [] }); return { status: 'submitted' } }
    proposalInput = input
    return { status: 'stopped', reason: 'TEST_STOP_AFTER_INPUT_READBACK' }
  }, async close() {}, async cancel() {} }
  const ownerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const decision = !input.stages.length
      ? { action: 'advance', summary: '调查后开发', evidenceRefs: [], planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-investigation', gate: 'none' }, { workflowId: 'task-engineering', gate: 'none' }] } }
      : { action: input.stages.some(stage => stage.status === 'ready' || stage.status === 'blocked') ? 'advance' : 'wait', summary: '按计划推进', evidenceRefs: [] }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const f = await fixture(t, 'owner', undefined, { delivery, executionSessions, taskOwnerSessions: ownerSessions,
    config: { repositories }, judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
      : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '调查后修复value', repositoryId: 'repo', uatEnvironment: 'uat2', acceptanceCriteria: ['value符合预期'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } })
  execution = f.execution
  const received = await f.service.ingest(f.message); await f.service.messages.process(received.runId)
  const taskId = (await f.service.state(received.runId)).commands[0].result.taskId
  for (let attempt = 0; attempt < 8 && !proposalInput; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages) if (stage.runId) await execution.controller.whenIdle(stage.runId)
    await f.service.recoverExecutionTasks()
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.ok(proposalInput, JSON.stringify({ plan, state: plan.stages[1]?.runId ? await execution.controller.state(plan.stages[1].runId) : null }))
  const sourceStage = plan.stages[0], engineeringStage = plan.stages[1]
  const record = (await execution.store.query({ kind: 'workflow.list' })).find(item => item.config?.runId === engineeringStage.runId)
  assert.equal(record.definitionVersion, '17')
  assert.deepEqual(proposalInput.investigation, record.config.investigationHandoff)
  assert.equal(proposalInput.investigation.source.outputRef, sourceStage.outputRef)
  assert.deepEqual(proposalInput.investigation.result, await execution.artifacts.read(sourceStage.outputRef))
  assert.match(proposalInput.investigation.objective, /调查后修复/)
  assert.deepEqual(proposalInput.investigation.result.limitations, ['当前建议尚未实施'])
  const state = await execution.controller.state(engineeringStage.runId)
  const node = state.nodes.find(item => ['inspect-and-propose', 'propose-changes'].includes(item.nodeId))
  assert.deepEqual((await execution.artifacts.read(node.inputRef)).data.investigation, proposalInput.investigation)
  const info = { commandId: record.config.sourceCommandId, stageRunId: engineeringStage.runId, run: { actorId: 'owner' }, unit: {}, investigationHandoff: {
    planRevision: plan.task.planRevision, stageId: engineeringStage.stageId, predecessorStageId: sourceStage.stageId,
    outputRef: 'sha256-' + 'a'.repeat(64) + '.json' } }
  await assert.rejects(registry.prepareTask({ taskId, arguments: { objective: '调查后修复value', repositoryId: 'repo', uatEnvironment: 'uat2' } }, info, execution.controller), { code: 'ENGINEERING_INVESTIGATION_HANDOFF_INVALID' })
  await assert.rejects(registry.prepareTask({ taskId: 'foreign-task', arguments: { objective: '调查后修复value', repositoryId: 'repo', uatEnvironment: 'uat2' } }, { ...info, investigationHandoff: { ...info.investigationHandoff, outputRef: sourceStage.outputRef } }, execution.controller), { code: 'ENGINEERING_INVESTIGATION_HANDOFF_INVALID' })
  const replay = await registry.prepareTask({ taskId, arguments: { objective: '调查后修复value', repositoryId: 'repo', uatEnvironment: 'uat2', acceptanceCriteria: ['value符合预期'] } }, { ...info, investigationHandoff: { ...info.investigationHandoff, outputRef: sourceStage.outputRef } }, execution.controller)
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
  await execution.controller.whenIdle(state.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  await service.flushNotifications()
  const task = (await service.tasks())[0]
  assert.equal(task.state, 'completed')
  const planBefore = await execution.controller.taskPlan(task.taskId)
  const stateBefore = await execution.controller.state(state.commands[0].result.runId)
  const outputs = await Promise.all(planBefore.stages.map(stage => execution.artifacts.read(stage.outputRef)))
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
  assert.deepEqual(await execution.controller.state(state.commands[0].result.runId), stateBefore)
  assert.deepEqual(await Promise.all(planBefore.stages.map(stage => execution.artifacts.read(stage.outputRef))), outputs)
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
  const received = await service.ingest(message); await service.messages.process(received.runId); await began
  const task = (await service.state(received.runId)).commands[0].result
  const request = { action: 'archive', taskId: task.taskId }, identity = { channel: 'web', actorId: 'owner' }
  assert.equal((await service.tasks())[0].state, 'running')
  await assert.rejects(execution.store.command({ id: 'archive-running-direct', kind: 'task.archive', args: { taskId: task.taskId, actorId: 'owner' } }), /NOT_COMPLETED|NOT_DRAINED/)
  await assert.rejects(service.submitWebTask(request, identity), /NOT_COMPLETED/)
  await execution.controller.pause({ commandId: 'archive-pause', runId: task.runId, reason: '暂停等待确认' })
  release(); await execution.controller.whenIdle(task.runId)
  assert.equal((await service.tasks())[0].state, 'waiting')
  await assert.rejects(execution.store.command({ id: 'archive-waiting-direct', kind: 'task.archive', args: { taskId: task.taskId, actorId: 'owner' } }), /NOT_COMPLETED|NOT_DRAINED/)
  await assert.rejects(service.submitWebTask(request, identity), /NOT_COMPLETED/)
  assert.deepEqual(await execution.store.query({ kind: 'task.archives' }), [])
  const waiting = (await service.tasks())[0]
  await service.submitWebTask({ action: 'cancel', taskId: task.taskId, requestId: 'archive-cancel-waiting',
    inputVersion: waiting.inputVersion, runSequence: 1, reason: '结束测试任务' }, identity)
  await execution.controller.whenIdle(task.runId)
  assert.deepEqual((await service.recover()).failures, [])
  const cancelled = (await service.tasks())[0]
  assert.equal(cancelled.state, 'completed'); assert.equal(cancelled.outcome, 'cancelled')
  const archived = await service.submitWebTask(request, identity)
  assert.ok(Number.isFinite(Date.parse(archived.archivedAt)))
})

test('同任务汇总卡片并分页历次执行：取消保留阶段成果、旧详情与权限隔离', async t => {
  const { service, execution, message } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message), processed = await service.messages.process(received.runId)
  const original = processed.commands[0].result
  await execution.controller.whenIdle(original.runId)
  await service.recoverExecutionTasks()
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
  await execution.controller.whenIdle(original.runId); await service.recoverExecutionTasks()
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
  const received=await service.ingest(message);
  for(const [kind,status] of [['needs_clarification','waiting_clarification'],['needs_context','waiting_context']]){
    await execution.store.command({id:'wait-'+kind,kind:'message.wait',args:{runId:received.runId,unitId:'$',nodeId:'S',request:{requestId:kind,kind,question:'请补充目标',permittedActors:['owner']}}});
    const mailbox=(await service.mailboxes()).messages.find(item=>item.runId===received.runId);
    assert.equal(mailbox.workflowStatus,status);assert.equal(mailbox.workflowStatusDetail,'请补充目标');
    await execution.store.command({id:'wake-'+kind,kind:'message.wake',args:{runId:received.runId,requestId:kind,actorId:'owner',eventId:kind,answer:'已补充'}});
  }
  await execution.store.command({id:'fail-status',kind:'message.attention',args:{runId:received.runId,reason:'recovery_exhausted'}});
  assert.equal((await service.mailboxes()).messages.find(item=>item.runId===received.runId).workflowStatus,'routing_blocked');
});

for (const intent of ['revise', 'reopen']) test(`${intent} 整批追加超过累计32项时需求与验收均不写入`, async t => {
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
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  await service.recover()
  const before = await execution.controller.taskPlan(taskId)
  const second = await service.ingest({ ...message, messageId: 'overflow-addition', text: '追加两个条件' })
  const rejected = await service.messages.process(second.runId)
  assert.ok(rejected.commands[0], JSON.stringify(rejected))
  assert.equal(rejected.commands[0].status, 'unknown')
  assert.match(JSON.stringify(rejected.commands[0]), /TASK_OWNER_CRITERIA_INVALID/)
  assert.deepEqual(await execution.controller.taskPlan(taskId), before)
  assert.equal((await execution.store.query({ kind: 'task.owner.acceptance', taskId })).length, 31)
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
  assert.ok(plan.stages.every(stage => stage.workflowId === 'task-investigation'))
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
  assert.equal((await service.state(other.runId)).commands[0].status, 'rejected')
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

test('收信箱材料读取责任与通知送达独立投影，恢复后保留历史通知', async t => {
  const { randomUUID } = await import('node:crypto')
  const { createWorkflowNotifications } = await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
  const { service, message, execution } = await fixture(t, 'owner')
  const received = await service.ingest(message)
  const command = (kind, args) => execution.store.command({ id: randomUUID(), kind: `message.${kind}`, args })
  await command('wait', { runId: received.runId, unitId: '$', nodeId: 'S', reason: '读取原始文件', request: { requestId: 'projection-context', kind: 'needs_context', needs: [] } })
  let row = (await service.mailboxes()).messages.find(item => item.runId === received.runId)
  assert.equal(row.workflowStatus, 'waiting_context')
  assert.equal(row.waiting[0].responsibility, 'host')
  assert.equal(row.notifications.length, 0)
  await command('request.retry', { runId: received.runId, requestId: 'projection-context', maxAttempts: 1, error: 'READ_FAILED', contractVersion: 'test' })
  await createWorkflowNotifications({ store: execution.store }).flush()
  row = (await service.mailboxes()).messages.find(item => item.runId === received.runId)
  assert.equal(row.workflowStatus, 'waiting_system')
  assert.equal(row.waiting[0].responsibility, 'system')
  assert.match(row.waiting[0].recoveryCondition, /修复材料读取/)
  assert.ok(row.notifications.some(item => item.status === 'prepared' && !item.delivered))
  await command('request.resolve', { runId: received.runId, requestId: 'projection-context', actorId: 'owner', eventId: 'material-ready', answer: { ready: true } })
  row = (await service.mailboxes()).messages.find(item => item.runId === received.runId)
  assert.equal(row.waiting.length, 0)
  assert.ok(row.notifications.some(item => !item.delivered))
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
  const { service, execution } = await fixture(t, 'owner', undefined, { config: { webActorId: 'owner' }, readResource: async () => { reads++; return null } })
  const source = await service.messages.receive({ sourceKey: 'retry-source', sourceVersion: 1, actorId: 'owner', conversationId: 'g', body: '读取这个文件',
    context: { sourceMessageId: 'retry-message', quoteRefs: [], attachments: [{ resourceRef: 'retry-file', source: { type: 'fileId', resourceId: 'retry-file' } }] } }, { process: false })
  await execution.store.command({ id: 'open-retry', kind: 'message.wait', args: { runId: source.runId, unitId: '$', nodeId: 'S', expectedRevision: 0,
    reason: 'MATERIAL_UNAVAILABLE', request: { requestId: 'retry-request', kind: 'needs_context', needs: [{ resourceRef: 'retry-file', reason: '核对内容' }], permittedActors: ['owner'] } } })
  await execution.store.command({ id: 'exhaust-retry', kind: 'message.request.retry', args: { runId: source.runId, requestId: 'retry-request', error: 'FILE_UNAVAILABLE', contractVersion: 'v1', maxAttempts: 1 } })
  const runtime = { retryWorkflowMaterialRequest: args => service.retryMaterialRequest(args, { channel: 'web', actorId: 'owner' }) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}/workflows/${source.runId}/requests/retry-request/retry`
  const input = { sourceVersion: 1, reason: '已更新文件访问能力', dependencyRevision: 'reader-v2' }
  const post = (body, origin = 'http://127.0.0.1:3080') => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  assert.equal((await post(input, 'https://evil.invalid')).status, 403)
  assert.equal((await post({ ...input, actorId: 'owner' })).status, 400)
  await assert.rejects(service.retryMaterialRequest(input, { channel: 'web', actorId: 'other' }), /FORBIDDEN/)
  assert.equal((await post({ ...input, sourceVersion: 2 })).status, 409)
  const response = await post(input)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.request.id, 'retry-request')
  assert.equal(result.request.status, 'pending')
  assert.equal(result.request.retryHistory.length, 1)
  assert.equal(result.request.attempts, 1)
  assert.equal(reads, 1)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 0)
  assert.equal((await post(input)).status, 409)
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
      arguments: { objective: input.text === secondText ? firstText + '\n' + secondText : firstText, workflowId: 'task-investigation',
        explicitStages: input.text === secondText ? [secondText] : [firstText],
        stageAuthorizations: [{ workflowId: 'task-data-change', sourceQuote: input.text }] }, dependsOn: [] }],
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
  assert.ok(plan.stages.every(stage => stage.workflowId === 'task-investigation'))
  const origins = await execution.store.query({ kind: 'message.task-candidates', conversationId: 'g', limit: 200 })
  assert.equal(new Set(origins.map(item => item.command.args.taskId)).size, 1)
})

for (const proposedGate of ['none', 'confirmation']) test(`Owner不能删除I已落账的原发送人验证门槛：${proposedGate}`, async t => {
  let effects = 0
  const forbidden = async () => { effects++; throw new Error('PRODUCTION_EFFECT_FORBIDDEN') }
  const dataChangeAdapter = { id: 'stage-gate-test', version: '1', rulesDigest: 'a'.repeat(64),
    validate: forbidden, prepareRehearsal: forbidden, readbackRehearsal: forbidden, inspect: forbidden,
    prepareIssue: forbidden, prepareApproval: forbidden, prepareExecute: forbidden, readback: forbidden }
  const body = '先核对测试结果，我验证通过再刷69条正式数据'
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前明确请求'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, workflowId: 'task-investigation', targetId: 'production-db',
        stageAuthorizations: [{ workflowId: 'task-data-change', sourceQuote: body, objective: '刷69条正式数据', gate: 'confirmation' }] }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  const taskOwnerSessions = { async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    const source = input.goal.sourceInstructions[0]
    const decision = { action: input.stages.length ? 'wait' : 'advance', summary: '按已登记条件处理', evidenceRefs: [],
      ...(!input.stages.length ? { planChange: { kind: 'initialize', stages: [
        { workflowId: 'task-investigation', gate: 'none' },
        { workflowId: 'task-data-change', gate: proposedGate, sourceCondition: { sourceKey: source.sourceKey, sourceVersion: source.sourceVersion,
          sourceQuote: body, objective: '刷69条正式数据', requiredActorId: source.actorId } },
      ] } } : {}) }
    await onCandidate(decision); return { status: 'submitted', decision }
  }, async close() {} }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, taskOwnerSessions,
    external: { dataChangeAdapter, operationAdapter: { execute: forbidden, reconcile: forbidden }, authorizeExternal: forbidden, prepareRequirement: forbidden } })
  const received = await service.ingest({ ...message, text: body })
  await service.messages.process(received.runId)
  const command = (await service.state(received.runId)).commands[0]
  const plan = await execution.controller.taskPlan(command.args.taskId)
  if (proposedGate === 'none') {
    assert.equal(plan.stages.length, 0)
    assert.equal((await execution.store.query({ kind: 'task.owner', taskId: command.args.taskId })).lastFailure, 'TASK_OWNER_STAGE_NOT_AUTHORIZED')
  } else {
    assert.equal(plan.stages.length, 2)
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
 const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['独立附件']}:{kind:'intent',actions:[{intent:'research',arguments:{objective:'核对附件',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:['incomplete-file'],replyPolicy:'none'}
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,readResource:async()=>({text:'只有第一页',...incomplete})})
 const {runId}=await service.ingest({...message,text:'核对完整附件',resourceRefs:[{type:'fileId',resourceId:'incomplete-file'}]})
 const state=await service.messages.process(runId)
 assert.equal(state.commands.length,0)
 assert.equal(state.requests.length,1)
 assert.equal(state.requests[0].status,'pending')
 assert.equal(await execution.store.query({kind:'message.material',runId,resourceRef:'incomplete-file'}),null)
})


test('S历史短引用经R读取后I只选择真实sourceKey，Task获得实际可读原文', async t => {
 const original='前文材料：行业专家保留，先两条验证再69条正式数据。'
 const sourceKey=`dws:${executionDigest(['','g','source-before'])}`
 let sawR=false,sawI=false
 const judge=async({stage,input})=>{
  if(stage==='S') {
   assert.equal(input.background[0].sourceKey,'h1')
   const output=splitOne(input.source.text);output.units[0].contextNeeds=[{resourceRef:'h1',reason:'核对前文条件'}];return output
  }
  assert.ok(input.executionMaterialRefs.includes(sourceKey))
  assert.equal(input.executionMaterialRefs.includes('h1'),false)
  if(stage==='R') {
   sawR=true
   assert.equal(input.material.resources[0].resourceRef,sourceKey)
   assert.equal(input.material.resources[0].text,original)
   return {kind:'binding',disposition:'new',candidateId:null,evidence:['独立调查交付']}
  }
  sawI=true
  return {kind:'intent',actions:[{intent:'research',arguments:{objective:'依据前文形成调查交付',workflowId:'task-investigation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[sourceKey],replyPolicy:'none'}
 }
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[{messageId:'source-before',text:original,occurredAt:'2026-09-29T00:00:00Z'}]})}})
 const {runId}=await service.ingest({...message,text:'依据前文形成调查交付'})
 const state=await service.messages.process(runId)
 assert.equal(state.run.status,'settled',JSON.stringify({reason:state.run.reason,nodes:state.nodes.map(n=>({nodeId:n.nodeId,error:n.error}))}))
 assert.equal(sawR,true);assert.equal(sawI,true)
 assert.ok(state.commands[0].result.runId)
 const task=await execution.controller.whenIdle(state.commands[0].result.runId)
 const input=await execution.artifacts.read(task.run.requirementRef)
 assert.deepEqual(input.materials.find(item=>item.id===sourceKey),{id:sourceKey,text:original})
})
