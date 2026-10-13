import { scriptedCoordinator } from './fixtures/group-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

// 只替代模型响应；恢复扫描、控制器、SQLite 和证据工件均为真实实现。
async function automaticRecoveryFixture(t, { repeatFailure = false, codeFailure = false, source = false, unknownEffect = false, noSubmission = false } = {}) {
 const root = await mkdtemp(join(tmpdir(), 'workflow-original-session-'))
 const dbPath = join(root, 'control.db'), visits = []
 let store, controller, service, prefixCalls = 0
 const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
 const number = { type: 'number' }
 const workflow = { id: 'automatic-review', version: '1', nodes: [
  { id: 'prepare', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number,
   mapInput: ({ requirement }) => requirement, execute: async ({ input }) => { prefixCalls++; return input + 1 } },
  { id: 'review', version: '1', executor: codeFailure ? 'code' : 'agent', allowedEffects: ['read'], inputSchema: number, outputSchema: number,
   mapInput: ({ previousOutput }) => previousOutput,
   ...(codeFailure ? { execute: async () => { throw Object.assign(new Error('必须修改实现'), { code: 'IMPLEMENTATION_BROKEN' }) } }
    : { provider: 'fixture', model: 'fixture', prompt: '核验输入', allowedTools: [] }) },
  { id: 'finish', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number,
   mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => input * 2 },
 ] }
 const command = (kind, args) => store.command({ id: randomUUID(), kind, args })
 const sessions = { async close() {}, async cancel() {}, async assertDrained() {}, async run(args) {
  await args.onSessionBound(); visits.push(args)
  if (unknownEffect && visits.length === 1) {
   const { runId, generation, leaseEpoch, inputDigest } = args.binding
   await command('effect.prepare', { effectId: 'uncertain', kind: 'operation', runId, nodeId: 'review', generation, leaseEpoch, inputDigest,
    definition: { adapterId: 'fixture', adapterVersion: '1', principalId: 'owner' }, resourceKeys: ['fixture:read'], authorizationRef: 'fixture-scope' })
   await command('effect.begin', { effectId: 'uncertain', leaseEpoch: 1, expectedSafetyEpoch: 0 })
   const evidence = await artifacts.put({ observed: 'unknown' })
   await command('effect.observe', { effectId: 'uncertain', receiptId: 'unknown-readback', status: 'unknown', evidenceRef: evidence.ref })
   return { status: 'no_submission', reason: 'execution_no_submission' }
  }
  if (noSubmission && (!args.recoveryContext || repeatFailure)) return { status: 'no_submission', reason: 'execution_no_submission' }
  await args.onResult(args.recoveryContext && !repeatFailure ? args.input + 1 : '错误类型')
  return { status: 'submitted' }
 } }
 const open = async initialize => {
  store = await openExecutionStore({ dbPath, instanceId: 'automatic-review', ...(initialize ? { initialize: true } : {}) })
  controller = createExecutionController({ store, artifacts, workflows: [workflow], sessions })
  service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'a' },
   legacy: { getAgentConfig: () => ({ provider: 'fixture', model: 'fixture' }), getGroup: () => ({ messages: [] }) },
   coordinatorSessions: scriptedCoordinator(), execution: { store, controller, artifacts } })
 }
 const close = async () => { await service?.close(); await controller?.close(); await store?.close() }
 t.after(async () => { await close(); await rm(root, { recursive: true, force: true }) })
 await open(true)
 if (source) await command('message.receive', { runId: 'source', sourceKey: 'source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '核验输入' })
 await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'review', workflowId: workflow.id, input: 1,
  ...(source ? { sourceCondition: { sourceKey: 'source', sourceVersion: 1, sourceQuote: '核验输入', objective: '核验输入' } } : {}) }] })
 const requirement = await artifacts.put({ request: '核验输入', acceptanceCriteria: ['结果为6'] })
 await command('task.requirement.bind-legacy', { taskId: 'task', expectedRequirementRevision: 1, requirementRef: requirement.ref,
  sessionId: 'task-session', criteria: ['结果为6'], sourceKey: 'fixture-source', eventKey: 'bind-fixture' })
 const started = await controller.advanceTaskPlan('task'), runId = started.stages[0].runId
 await controller.whenIdle(runId); await controller.advanceTaskPlan('task')
 return { artifacts, visits, runId, command, get controller() { return controller }, get store() { return store }, get prefixCalls() { return prefixCalls },
  async scan() { const failures = await service.recoverExecutionTasks(); await controller.whenIdle(runId); return failures },
  async reopen() { await close(); await open(false) } }
}

for (const restart of [false, true]) test(`自动恢复扫描回原会话并保留成功前缀：重启=${restart}`, async t => {
 const f = await automaticRecoveryFixture(t), before = await f.controller.state(f.runId)
 assert.equal((await f.controller.inspectNodeRecovery(f.runId)).repairable, true)
 assert.deepEqual(await f.store.query({ kind: 'run.list', activeOnly: true }), [])
 assert.deepEqual((await f.store.query({ kind: 'run.list', activeOnly: true, includeFailed: true })).map(run => run.runId), [f.runId])
 if (restart) await f.reopen()
 assert.deepEqual(await f.scan(), [])
 const after = await f.controller.state(f.runId)
 assert.equal(after.run.status, 'succeeded'); assert.equal(f.visits.length, 2); assert.equal(f.prefixCalls, 1)
 assert.deepEqual(after.nodes[0], before.nodes[0]); assert.equal(after.run.generation, before.run.generation)
 for (const field of ['sessionId', 'nodeRunId', 'generation', 'inputDigest']) assert.equal(f.visits[1].binding[field], f.visits[0].binding[field], field)
 const context = f.visits[1].recoveryContext
 assert.equal(context.kind, 'execution-recovery-context'); assert.equal(context.taskId, 'task'); assert.equal(context.runId, f.runId)
 assert.equal(context.requirementRevision, 1); assert.equal(context.planRevision, 1); assert.equal(context.controlRevision, 1)
 assert.ok(context.diagnosis); assert.ok(context.strategy); assert.ok(context.evidenceRefs.length)
 const evidence = await Promise.all(context.evidenceRefs.map(ref => f.artifacts.read(ref)))
 assert.ok(evidence.some(item => item.kind === 'execution-failure' && item.code === 'NODE_SCHEMA_INVALID'))
 assert.deepEqual(context.evidence, context.evidenceRefs.map((artifactRef, index) => ({ artifactRef, value: evidence[index] })))
 const failure = context.evidence.find(item => item.value.kind === 'execution-failure').value
 assert.ok(failure.message); assert.equal(failure.phase, 'output-validation')
 assert.equal(await f.artifacts.read(after.nodes[2].outputRef), 6)
 assert.deepEqual(await f.store.query({ kind: 'run.list', activeOnly: true, includeFailed: true }), [])
 await f.scan(); assert.equal(f.visits.length, 2); assert.equal(f.prefixCalls, 1)
})

for (const noSubmission of [false, true]) test(`自动恢复同一问题二次失败跨重启不空转：无提交=${noSubmission}`, async t => {
 const f = await automaticRecoveryFixture(t, { repeatFailure: true, noSubmission })
 const first = await f.controller.inspectNodeRecovery(f.runId)
 if (noSubmission) await assert.rejects(f.command('run.recover', { runId: f.runId }), { code: 'NODE_RECOVERY_REQUIRES_CONTEXT' })
 await f.scan(); assert.equal(f.visits.length, 2)
 await f.reopen()
 const next = await f.controller.inspectNodeRecovery(f.runId)
 assert.equal(next.problemKey, first.problemKey); assert.equal(next.repairable, false); assert.equal(next.reason, 'strategy-change-required')
 if (noSubmission) await assert.rejects(f.command('run.recover', { runId: f.runId }), { code: 'NODE_RECOVERY_REQUIRES_CONTEXT' })
 await f.scan(); await f.scan()
 assert.equal(f.visits.length, 2); assert.equal(f.prefixCalls, 1)
 assert.equal((await f.controller.state(f.runId)).run.status, noSubmission ? 'waiting' : 'failed')
})

test('自动恢复无提交等待时仍回原会话，已有准入不依赖旧provider重分类', async t => {
 const f = await automaticRecoveryFixture(t, { noSubmission: true })
 assert.equal((await f.controller.state(f.runId)).run.status, 'waiting')
 assert.equal((await f.controller.inspectNodeRecovery(f.runId)).repairable, true)
 assert.deepEqual(await f.scan(), [])
 assert.equal((await f.controller.state(f.runId)).run.status, 'succeeded')
 assert.equal(f.visits.length, 2); assert.equal(f.prefixCalls, 1)
 assert.equal(f.visits[1].binding.sessionId, f.visits[0].binding.sessionId)
})

for (const barrier of ['pause', 'cancel', 'requirement', 'source', 'unknown-effect', 'code-failure']) test(`自动恢复保留准入边界：${barrier}`, async t => {
 const f = await automaticRecoveryFixture(t, { source: barrier === 'source', unknownEffect: barrier === 'unknown-effect', codeFailure: barrier === 'code-failure' })
 if (barrier === 'pause' || barrier === 'cancel') await f.command(`task.control.${barrier}`, { taskId: 'task', expectedControlRevision: 1 })
 if (barrier === 'requirement') {
  const ref = await f.artifacts.put({ request: '新的需求' })
  await f.command('task.requirement.update', { taskId: 'task', expectedRequirementRevision: 1, requirementRef: ref.ref, eventKey: 'new-requirement' })
 }
 if (barrier === 'source') await f.command('message.receive', { runId: 'source-v2', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '输入已经改变' })
 const recovery = await f.controller.inspectNodeRecovery(f.runId)
 assert.equal(recovery.repairable, false)
 if (barrier === 'source') assert.equal(recovery.reason, 'task-source-not-current')
 if (barrier === 'requirement') assert.equal(recovery.reason, 'task-plan-not-current')
 if (barrier === 'unknown-effect') assert.equal((await f.store.query({ kind: 'effect.get', effectId: 'uncertain' })).state, 'unknown')
 if (barrier === 'pause' || barrier === 'cancel') assert.deepEqual(await f.store.query({ kind: 'run.list', activeOnly: true, includeFailed: true }), [])
 const before = await f.controller.state(f.runId), calls = f.visits.length
 await f.scan(); await f.scan()
 const after = await f.controller.state(f.runId)
 assert.equal(f.visits.length, calls); assert.equal(f.prefixCalls, 1)
 assert.deepEqual(after.nodes.map(node => [node.nodeRunId, node.leaseEpoch, node.outputRef]), before.nodes.map(node => [node.nodeRunId, node.leaseEpoch, node.outputRef]))
})

test('自动恢复扫描不纳入已归档失败Run，历史仍可显式读取', async t => {
 const f = await automaticRecoveryFixture(t)
 const current = await f.controller.taskPlan('task')
 await f.command('task.control.pause', { taskId: 'task', expectedControlRevision: current.task.controlRevision })
 const paused = await f.controller.taskPlan('task')
 assert.equal(paused.task.controlState, 'paused')
 await f.command('runtime.maintenance.change', { active: true, expectedRevision: 0, maintenanceId: 'archive-test', actorId: 'a', reason: '测试隔离归档' })
 const args = { taskId: 'task', expectedControlRevision: paused.task.controlRevision, actorId: 'a', reason: '归档历史失败执行' }
 assert.deepEqual((await f.store.query({ kind: 'task.execution.reset.check', ...args })).archivedRunIds, [f.runId])
 await f.command('task.execution.reset', args)
 await f.command('runtime.maintenance.change', { active: false, expectedRevision: 1, maintenanceId: 'archive-test', actorId: 'a', reason: '恢复测试扫描' })
 assert.deepEqual(await f.store.query({ kind: 'run.list', activeOnly: true, includeFailed: true }), [])
 assert.deepEqual(await f.store.query({ kind: 'run.list' }), [])
 assert.equal((await f.store.query({ kind: 'run.list', includeArchived: true }))[0].runId, f.runId)
 const before = await f.controller.state(f.runId)
 assert.equal(before.run.recoveryReason, 'execution-archived')
 await f.scan(); await f.reopen(); await f.scan()
 assert.equal(f.visits.length, 1); assert.deepEqual((await f.controller.state(f.runId)).nodes, before.nodes)
})
test('单Task恢复失败和正在执行Task不能阻止其它恢复与通知扫描',async()=>{
 const recovered=[],queries=[]
 const store={command:async()=>({result:{}}),query:async q=>{queries.push(q.kind);if(q.kind==='run.list')return [{runId:'running',status:'running'},{runId:'bad',status:'waiting'},{runId:'good',status:'waiting'},{runId:'check-failed',status:'waiting'}];if(q.kind==='run')return {run:{revision:1,generation:1},nodes:[{status:'waiting',nodeRunId:`node-${q.runId}`,leaseEpoch:1,inputDigest:'a'.repeat(64),waitReason:{reference:q.runId==='check-failed'?'ENGINEERING_VERIFICATION_FAILED':'ECONNRESET'}}]};return []}}
 // 本用例只验证恢复扫描，模拟控制器不注册领域结果合同。
 const controller={inspectNodeRecovery:async()=>({repairable:false}),workflowDefinition:()=>({ownerContract:null}),pendingTaskPlans:async()=>[],recover:async({runId})=>{recovered.push(runId);if(runId!=='good')throw Object.assign(new Error('busy'),{code:runId==='running'?'EXECUTOR_STILL_ACTIVE':'EFFECT_UNKNOWN'})}}
 const service=await openWorkflowService({ctx:{},config:{groupIds:['g'],ownerActorId:'a'},legacy:{getAgentConfig:()=>({provider:'test',model:'test'}),getGroup:()=>({messages:[]})},coordinatorSessions: scriptedCoordinator(),execution:{store,controller,artifacts:{put:async()=>{throw new Error('RECOVERY_SCAN_MUST_NOT_WRITE_ARTIFACT')}}}})
 try {const result=await service.recover();assert.deepEqual(recovered,['bad','good']);assert.ok(queries.includes('message.list'));assert.equal(result.failures.length,1)}finally{await service.close()}
})
test('大量unknown通知不能挤掉新prepared；对账游标可到下一页',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-notice-fairness-'));const store=await openExecutionStore({dbPath:join(root,'control.db'),instanceId:'test',initialize:true});t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 const c=(kind,args)=>store.command({id:randomUUID(),kind:'message.'+kind,args})
 await c('receive',{runId:'m',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'a',body:'test'});await c('split',{runId:'m',units:[{unitId:'u'}]});await c('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'status',args:{}}]});const command=(await c('command.claim',{commandId:'c'})).result.command;await c('command.complete',{commandId:'c',leaseEpoch:command.leaseEpoch,result:{}})
 for(let i=0;i<202;i++){await c('notification.prepare',{runId:'m',commandId:'c',notificationId:'n'+i,eventKey:'test.notice:n'+i,payload:{text:'notice'+i},disclosure:{conversationId:'g',authorizationRef:'proof'}});if(i<201){const n=(await c('notification.claim',{notificationId:'n'+i})).result.notification;await c('notification.fail',{notificationId:'n'+i,leaseEpoch:n.leaseEpoch,error:'unknown'})}}
 const prepared=await store.query({kind:'message.notifications',states:['prepared'],limit:100});assert.deepEqual(prepared.map(n=>n.id),['n201'])
 const one=await store.query({kind:'message.notifications',states:['unknown'],limit:100}),two=await store.query({kind:'message.notifications',states:['unknown'],afterSequenceId:one.at(-1).sequenceId,limit:100});assert.equal(one.length,100);assert.equal(two.length,100);assert.notEqual(one[0].id,two[0].id)
})
test('旧活动Task不会被超过200条新终态任务挤出恢复索引',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-active-index-'));const store=await openExecutionStore({dbPath:join(root,'control.db'),instanceId:'test',initialize:true});t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
 const create=i=>command('run.create',{runId:'run'+i,taskId:'task'+i,workflowId:'w',workflowDigest:'a'.repeat(64),requirementRef:'sha/input',nodes:[{nodeId:'n',nodeVersion:'1',executor:'code',inputRef:'sha/input',inputDigest:'a'.repeat(64)}]})
 await create('old')
 for(let i=0;i<201;i++){await create(i);await command('run.stop',{runId:'run'+i,reason:'cancel'});await command('run.stopped',{runId:'run'+i})}
 assert.equal((await store.query({kind:'run.list',limit:200})).some(r=>r.runId==='runold'),false)
 assert.deepEqual((await store.query({kind:'run.list',limit:200,activeOnly:true})).map(r=>r.runId),['runold'])
})
