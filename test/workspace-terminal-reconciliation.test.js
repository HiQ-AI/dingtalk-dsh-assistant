import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { reconcilePausedWorkspaceFailure } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-terminal-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.sqlite'), instanceId: 'workspace-terminal-test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  let controller
  t.after(async () => { await controller?.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  const workflow = { id: 'task-engineering-test', version: '1', nodes: [{
    id: 'prepare-workspace', version: '1', executor: 'code', allowedEffects: ['workspace.prepare'],
    inputSchema: { type: 'number' }, outputSchema: { type: 'number' }, mapInput: ({ requirement }) => requirement,
    execute: async ({ runId }) => {
      const state = await store.query({ kind: 'run', runId }), n = state.nodes.find(node => node.nodeId === 'prepare-workspace')
      const payload = { action: 'workspace', runId, generation: 1, digest: 'a'.repeat(64), directory: join(directory, 'repository') }
      const proof = { status: 'failed', reason: 'WORKSPACE_PREPARATION_ADDRESS_COLLISION', phase: 'preflight', mutationAttempted: false, directory: payload.directory, preparedDigest: payload.digest }
      const data = { payload, proof, status: 'failed' }; mutate(data)
      const evidence = await artifacts.put(data.proof)
      for (const effectId of data.extraEffect ? ['workspace-test','workspace-extra'] : ['workspace-test']) {
      await store.command({ id: 'effect-prepare-' + effectId, kind: 'effect.prepare', args: {
        effectId, kind: 'operation', runId, nodeId: n.nodeId, generation: 1, leaseEpoch: n.leaseEpoch, inputDigest: n.inputDigest,
        definition: { action: 'workspace', adapterId: 'managed-workspace', adapterVersion: '1', principalId: 'owner', payload: data.payload },
        resourceKeys: ['workspace:test'], authorizationRef: 'task-grant:synthetic',
      } })
      await store.command({ id: 'effect-begin-' + effectId, kind: 'effect.begin', args: { effectId, leaseEpoch: n.leaseEpoch, expectedSafetyEpoch: 0 } })
      await store.command({ id: 'effect-observe-' + effectId, kind: 'effect.observe', args: { effectId, receiptId: 'receipt-' + effectId, status: data.status, evidenceRef: evidence.ref, result: data.proof } })
      }
      throw Object.assign(new Error('DELIVERY_RECONCILIATION_REQUIRED'), { code: 'DELIVERY_RECONCILIATION_REQUIRED' })
    },
  }] }
  workflow.nodes.unshift({ id: 'prepare-generation', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'number' }, outputSchema: { type: 'number' }, mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input })
  controller = createExecutionController({ store, artifacts, workflows: [workflow], delivery: { execute: async () => { throw Error('TEST_DISPATCH_FORBIDDEN') } } })
  const requirement = await artifacts.put(1)
  await store.command({ id: 'accept', kind: 'task.accept', args: { taskId: 'task', requirementRef: requirement.ref, requirementRevision: 1, sessionId: 'owner-task', criteria: ['real release remains unfinished'], sourceKey: 'source', eventKey: 'created' } })
  await controller.initializeTaskPlan({ commandId: 'init', taskId: 'task', expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1, stages: [{ stageId: 'engineering', workflowId: workflow.id, input: 1 }] })
  const plan = await controller.advanceTaskPlan('task'), runId = plan.stages[0].runId
  await controller.whenIdle(runId)
  await controller.controlTask({ commandId: 'pause', taskId: 'task', intent: 'pause', expectedControlRevision: 1 })
  const state = await controller.state(runId), task = (await controller.taskPlan('task')).task, n = state.nodes.find(node => node.nodeId === 'prepare-workspace')
  const maintenance = await store.query({ kind: 'runtime.maintenance' })
  const permit = await store.command({ id: 'maintenance-enter', kind: 'runtime.maintenance.change', args: { active: true, expectedRevision: maintenance.revision, maintenanceId: 'terminal-test', actorId: 'owner', reason: 'formal failed preflight reconciliation' } })
  const args = { maintenanceId: 'terminal-test', maintenanceRevision: permit.result.revision, taskId: 'task', runId, runRevision: state.run.revision, nodeRunId: n.nodeRunId, generation: n.generation, leaseEpoch: n.leaseEpoch, inputDigest: n.inputDigest, effectId: 'workspace-test', expectedRequirementRevision: task.requirementRevision, expectedPlanRevision: task.planRevision, expectedControlRevision: task.controlRevision }
  return { store, controller, args, state }
}

test('formal workspace preflight reconciliation fails drained old run, preserves receipt and allows only new suffix', async t => {
  const { store, controller, args } = await fixture(t)
  const before = await store.query({ kind: 'effect.get', effectId: args.effectId })
  const result = await store.command({ id: 'terminal', kind: 'node.failure.reconcile-workspace', args })
  assert.equal(result.result.status, 'failed')
  const state = await controller.state(args.runId), plan = await controller.taskPlan('task')
  assert.equal(state.nodes.find(node => node.nodeId === 'prepare-generation').status, 'succeeded')
  assert.equal(state.run.status, 'failed'); assert.equal(state.nodes.find(node => node.nodeId === 'prepare-workspace').status, 'failed'); assert.equal(state.nodes.find(node => node.nodeId === 'prepare-workspace').outputRef, null)
  assert.ok(state.nodes.find(node => node.nodeId === 'prepare-workspace').evidenceRefs.includes(before.result.evidenceRef))
  assert.equal(plan.stages[0].status, 'blocked'); assert.equal(plan.task.controlState, 'paused')
  assert.deepEqual(await store.query({ kind: 'effect.get', effectId: args.effectId }), before)
  assert.equal((await store.command({ id: 'terminal', kind: 'node.failure.reconcile-workspace', args })).replayed, true)
  await store.command({ id: 'maintenance-exit', kind: 'runtime.maintenance.change', args: { active: false, expectedRevision: args.maintenanceRevision, maintenanceId: args.maintenanceId, actorId: 'owner', reason: 'reconciliation complete' } })
  await controller.controlTask({ commandId: 'resume-suffix', taskId: 'task', intent: 'resume', expectedControlRevision: plan.task.controlRevision })
  assert.equal((await controller.state(args.runId)).run.status, 'failed')
  controller.registerWorkflow({ id: 'task-uat-pr-merge', version: '1', nodes: [{ id: 'inspect', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'number' }, outputSchema: { type: 'number' }, mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input }] })
  const active = await controller.taskPlan('task')
  await controller.reviseTaskPlan({ commandId: 'release-suffix', taskId: 'task', expectedPlanRevision: active.task.planRevision, expectedControlRevision: active.task.controlRevision, requirementRevision: active.task.requirementRevision, affectedFrom: 0, stages: [{ stageId: 'release', workflowId: 'task-uat-pr-merge', input: 2 }] })
  assert.equal((await controller.taskPlan('task')).stages[0].workflowId, 'task-uat-pr-merge')
  assert.equal((await controller.state(args.runId)).run.status, 'failed')
})

for (const [name, mutate] of [
  ['additional-effect', d => { d.extraEffect = true }], ['success', d => { d.status = 'succeeded' }],
  ['mutation-attempted', d => { d.proof.mutationAttempted = true }], ['non-preflight', d => { d.proof.phase = 'execute' }],
  ['different-operation', d => { d.proof.preparedDigest = 'b'.repeat(64) }], ['different-directory', d => { d.proof.directory = 'foreign' }],
  ['different-run', d => { d.payload.runId = 'foreign' }],
]) test(`terminal reconciliation rejects ${name} without changing node/run/effect`, async t => {
  const { store, controller, args, state } = await fixture(t, mutate)
  const before = await store.query({ kind: 'effect.get', effectId: args.effectId })
  await assert.rejects(store.command({ id: 'reject', kind: 'node.failure.reconcile-workspace', args }), { code: 'WORKSPACE_TERMINAL_RECONCILIATION_UNPROVEN' })
  assert.deepEqual(await controller.state(args.runId), state)
  assert.deepEqual(await store.query({ kind: 'effect.get', effectId: args.effectId }), before)
})
for (const key of ['runRevision', 'leaseEpoch', 'generation', 'expectedRequirementRevision', 'expectedPlanRevision', 'expectedControlRevision']) test(`terminal reconciliation preserves ${key} CAS`, async t => {
  const { store, controller, args, state } = await fixture(t)
  await assert.rejects(store.command({ id: 'stale', kind: 'node.failure.reconcile-workspace', args: { ...args, [key]: args[key] + 1 } }), { code: 'WORKSPACE_TERMINAL_RECONCILIATION_STALE' })
  assert.deepEqual(await controller.state(args.runId), state)
})

test('unknown effect blocks formal drain before terminal reconciliation', async t => {
  await assert.rejects(fixture(t, d => { d.status = 'unknown' }), { code: 'run_effects_not_drained' })
})

test('terminal reconciliation requires exact current maintenance permit', async t => {
  const { store, args } = await fixture(t)
  await assert.rejects(store.command({ id: 'wrong-permit', kind: 'node.failure.reconcile-workspace', args: { ...args, maintenanceRevision: args.maintenanceRevision + 1 } }), { code: 'WORKSPACE_TERMINAL_MAINTENANCE_REQUIRED' })
})

test('real loopback control route finalizes via already-owned Store and reuses genuine receipt', async t => {
  const { store, controller, args } = await fixture(t)
  const server = createServer((request,response) => handleRequest(request,response,{controlWorkflowTaskExecution:async input=>{
    const receipt=await reconcilePausedWorkspaceFailure({store,taskId:input.taskId,request:input})
    return {status:receipt.result.status,state:await controller.state(input.runId)}
  }}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const {taskId,...binding}=args,url=`http://127.0.0.1:${server.address().port}/tasks/${taskId}/execution-control`
  const call=async(body,origin='http://127.0.0.1:3080')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)})
  const body={requestId:'native-finalize',action:'reconcile-failure',reason:'Actual synthetic native preflight failure fixture',...binding}
  assert.equal((await call(body,'https://foreign.example')).status,403)
  let response=await call(body);assert.equal(response.status,200);assert.equal((await response.json()).state.run.status,'failed')
  const current=await controller.state(args.runId)
  response=await call({...body,runRevision:current.run.revision,requestId:'native-retry'})
  assert.equal(response.status,200);assert.equal((await response.json()).state.run.status,'failed')
  assert.equal((await store.query({kind:'effect.get',effectId:args.effectId})).state,'failed')
})
