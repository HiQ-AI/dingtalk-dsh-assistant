import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskStageContracts, readTaskStageHandoff } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createLegacyInvestigationWorkflow, validateAgentWorkResult } from '../packages/dingtalk-dsh-assistant/agent-work.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

function fixture() {
  const stage = { stageId: 'first', runId: 'run', workflowId: 'domain', workflowDigest: 'digest', status: 'succeeded', outputRef: 'output' }
  const plan = { task: { taskId: 'task', requirementRevision: 2, planRequirementRevision: 2, planRevision: 3 }, stages: [stage] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: 'domain', workflowDigest: 'digest', status: 'succeeded', generation: 4 },
    nodes: [{ status: 'succeeded', outputRef: 'output', generation: 4 }], pendingInputCount: 0 }
  const definition = { version: '6', ownerContract: { id: 'owner', version: '1', resultContract: { id: 'result', version: '2', requiredFields: ['summary'] } },
    nodes: [{ mapInput: ({ requirement }) => requirement, inputSchema: { type: 'object', properties: { request: { type: 'string' }, materials: { type: 'array' } }, required: ['request'], additionalProperties: false } }] }
  const value = { summary: '已核验' }
  const controller = { state: async () => state, workflowDefinition: () => definition }
  const artifacts = { read: async ref => { assert.equal(ref, 'output'); return value } }
  return { taskId: 'task', stage, plan, state, definition, value, controller, artifacts }
}

test('交接绑定当前计划、Run、digest、generation与必交字段', async () => {
  const f = fixture()
  const handoff = await readTaskStageHandoff(f)
  assert.deepEqual(handoff, { kind: 'workflow-stage-result', contract: { id: 'result', version: '2' }, taskId: 'task', requirementRevision: 2,
    planRevision: 3, stageId: 'first', runId: 'run', workflowDigest: 'digest', outputRef: 'output', value: f.value })
  for (const mutate of [
    f => { f.state.run.runId = 'other' }, f => { f.state.run.taskId = 'other' },
    f => { f.state.run.workflowDigest = 'other' }, f => { f.state.run.workflowId = 'other' },
    f => { f.state.nodes[0].generation = 3 }, f => { f.state.nodes[0].outputRef = 'other' },
    f => { f.state.pendingInputCount = 1 }, f => { f.plan.task.planRequirementRevision = 1 },
    f => { f.stage.status = 'running' }, f => { f.state.run.status = 'running' },
  ]) { const f = fixture(); mutate(f); await assert.rejects(readTaskStageHandoff(f), { code: 'TASK_STAGE_HANDOFF_STALE' }) }
  delete f.value.summary
  await assert.rejects(readTaskStageHandoff(f), { code: 'WORKFLOW_RESULT_CONTRACT_INVALID' })
  delete f.definition.ownerContract
  await assert.rejects(readTaskStageHandoff(f), { code: 'WORKFLOW_OWNER_CONTRACT_UNAVAILABLE' })
})

test('领域准备前后都核验材料角色、容量，并以冻结输入Schema拒绝错型', async () => {
  const f = fixture(); let calls = 0, prepared = { input: { request: '执行', materials: [{ id: 'a', role: 'source' }] } }
  const contract = { id: 'domain', version: '1', materialPolicy: { roles: ['source'], required: ['source'], singleton: ['source'], maxCount: 2, maxBytes: 200 },
    prepare: async () => { calls++; return prepared } }
  const registry = createTaskStageContracts({ ...f, contracts: [contract] })
  const context = { ...f, requirement: { materials: [{ id: 'a', role: 'source' }] } }
  assert.deepEqual(await registry.prepare(context), prepared)
  assert.equal(calls, 1)
  for (const materials of [[], [{ role: 'unknown' }], [{ role: 'source' }, { role: 'source' }]]) {
    await assert.rejects(registry.prepare({ ...context, requirement: { materials } }), { code: 'TASK_STAGE_MATERIAL_ROLE_INVALID' })
    assert.equal(calls, 1)
  }
  await assert.rejects(registry.prepare({ ...context, requirement: { materials: [{ role: 'source', text: '长'.repeat(100) }] } }), { code: 'TASK_STAGE_MATERIAL_CAPACITY' })
  prepared = { input: { request: '执行', materials: [{ role: 'unknown' }] } }
  await assert.rejects(registry.prepare(context), { code: 'TASK_STAGE_MATERIAL_ROLE_INVALID' })
  prepared = { input: { request: '执行', materials: [{ role: 'source', text: '长'.repeat(100) }] } }
  await assert.rejects(registry.prepare(context), { code: 'TASK_STAGE_MATERIAL_CAPACITY' })
  prepared = { input: { request: 3, materials: [{ role: 'source' }] } }
  await assert.rejects(registry.prepare(context), { code: 'TASK_STAGE_INPUT_INVALID' })
})

test('后阶段准备获得真实交接和冻结历史定义版本', async () => {
  const f = fixture(), next = { stageId: 'next', workflowId: 'domain', workflowDigest: 'digest', status: 'pending' }
  f.plan.stages.push(next); f.definition.version = '5'
  let received
  const registry = createTaskStageContracts({ ...f, contracts: [{ id: 'domain', version: '1', prepare: async args => { received = args; return { input: { request: '后续' } } } }] })
  await registry.prepare({ ...f, stage: next, requirement: {} })
  assert.equal(received.definitionVersion, '5'); assert.equal(received.handoff.outputRef, 'output')
  f.plan.task.planRequirementRevision = 1
  await assert.rejects(registry.prepare({ ...f, stage: next, requirement: {} }), { code: 'TASK_STAGE_REQUIREMENT_STALE' })
})


for (const pending of [true, false]) test(`正式 Host 重启恢复 v5 成功前序：${pending ? '后续待确认' : '阶段全成功但 Owner 未完成'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'investigation-v5-restart-'))
  const dbPath = join(root, 'control.db'), artifactDirectory = join(root, 'artifacts'), model = { provider: 'test', model: 'test' }
  const store = await openExecutionStore({ dbPath, instanceId: 'v5-restart', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
  const identities = ['read-topic-sources', 'read-predecessor-artifact']
  const workflow = createLegacyInvestigationWorkflow({ ...model, allowedTools: identities,
    capabilityIdentity: executionDigest(identities.map(id => ({ id, identity: `${id}-v1` }))),
    verifyResult: async ({ result }) => validateAgentWorkResult(result, { sourceRefs: ['source'] }) })
  const definition = defineExecutionWorkflow(workflow)
  const controller = createExecutionController({ store, artifacts, workflows: [workflow], readTools: identities,
    sessions: { async run({ onSessionBound, onResult }) { await onSessionBound(); await onResult({ outcome: 'completed', summary: '已核验原始材料', evidenceRefs: ['source'], limitations: [], question: '' }); return { status: 'submitted' } }, async close() {}, async cancel() {} } })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.command({ id: 'register-v5', kind: 'workflow.register', args: { workflowId: workflow.id, definitionVersion: workflow.version, digest: definition.digest, config: model } })
  const input = { request: '核验', acceptanceCriteria: ['调查完成'], constraints: [], scope: {}, context: {}, materials: [{ id: 'source', text: '原始材料' }] }
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: workflow.id, input },
    ...(pending ? [{ stageId: 'later', workflowId: workflow.id, gate: 'confirmation' }] : [])] })
  await store.command({ id: 'owner', kind: 'task.owner.init', args: { taskId: 'task', sessionId: 'owner-session', sourceKey: 'source', criteria: input.acceptanceCriteria } })
  const running = await controller.advanceTaskPlan('task')
  await controller.whenIdle(running.stages[0].runId)
  const before = await controller.advanceTaskPlan('task')
  assert.equal(before.stages[0].status, 'succeeded')
  assert.equal(before.task.status, pending ? 'waiting_confirmation' : 'succeeded')
  const outputBefore = await artifacts.read(before.stages[0].outputRef)
  await controller.close(); await store.close()
  service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', dbPath, artifactDirectory, instanceId: 'v5-restart' },
    legacy: { getAgentConfig: () => model }, judge: async () => { throw Error('UNEXPECTED_MODEL') }, taskOwnerSessions: { async close() {} } })
  const restored = service.execution.controller.workflowDefinition(workflow.id, definition.digest)
  assert.equal(restored.version, '5'); assert.equal(restored.digest, definition.digest)
  assert.equal(service.execution.controller.workflowDefinition(workflow.id).version, '6')
  const plan = await service.execution.controller.taskPlan('task')
  assert.deepEqual(plan, before)
  const handoff = await readTaskStageHandoff({ taskId: 'task', plan, stage: plan.stages[0], controller: service.execution.controller, artifacts: service.execution.artifacts })
  assert.deepEqual(handoff.value, outputBefore)
  assert.deepEqual(handoff.contract, { id: 'agent-investigation-result', version: '1' })
  assert.equal(await restored.ownerContract.validateCompletion({ output: handoff.value }), true)
})

test('产物声明拒绝未知字段和重复必交字段，声明变化进入 workflow digest', () => {
  const base = createLegacyInvestigationWorkflow({ provider: 'test', model: 'test', allowedTools: [], capabilityIdentity: 'fixture', verifyResult: async () => {} })
  const withContract = value => ({ ...base, ownerContract: { ...base.ownerContract, resultContract: value } })
  const declaration = { id: 'result', version: '1', requiredFields: ['summary'] }
  const first = defineExecutionWorkflow(withContract(declaration))
  const second = defineExecutionWorkflow(withContract({ ...declaration, requiredFields: ['summary', 'evidenceRefs'] }))
  assert.notEqual(first.digest, second.digest)
  for (const invalid of [{ ...declaration, surprise: true }, { ...declaration, requiredFields: ['summary', 'summary'] }])
    assert.throws(() => defineExecutionWorkflow(withContract(invalid)), { code: 'WORKFLOW_RESULT_CONTRACT_INVALID' })
})
