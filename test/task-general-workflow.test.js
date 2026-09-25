import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeneralTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { executionDigest, openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

function workflow(overrides = {}, completionCheck = async ({ acceptanceCriteria, evidence, report }) => ({
  status: 'satisfied', resultVerified: evidence[0]?.output.value === report.summary,
  criteria: acceptanceCriteria.map(criterion => ({ criterion, passed: true, evidenceIds: ['step-1'] })),
})) {
  const calls = []
  const definition = createGeneralTaskWorkflow({ provider: 'test', model: 'synthetic', maxSteps: 2,
    completionCheck, completionIdentity: 'lookup-completion-v1',
    capabilities: [{ id: 'lookup', description: '查询指定范围的资料', identity: 'lookup-v1',
      authorize: async ({ scope }) => scope.folder !== 'forbidden',
      execute: async args => { calls.push(['execute', args]); return { value: '实际读取值' } },
      verify: async args => { calls.push(['verify', args]); return { passed: true, outputDigest: executionDigest(args.output), sourceRefs: ['source:a'], readback: '实际读取值' } },
      ...overrides }],
  })
  return { definition, calls }
}

test('通用流程只调用登记能力，逐步独立核验并保存证据', async () => {
  const { definition, calls } = workflow()
  assert.equal(defineExecutionWorkflow(definition).nodes.length, 7)
  const requirement = { request: '查询一份资料', acceptanceCriteria: ['能证实资料值'], constraints: [], scope: { folder: 'docs' } }
  const state = await definition.nodes[0].execute({ input: requirement })
  const execute = definition.nodes.find(node => node.id === 'execute-1')
  const step = { done: false, objective: '读取资料', capabilityId: 'lookup', input: { name: 'a' }, expectedEvidence: '读取回执' }
  const next = await execute.execute({ input: { state, step } })
  assert.equal(next.evidence[0].evidenceId, 'step-1')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0][1].scope, requirement.scope)
  assert.equal(calls[1][1].output.value, '实际读取值')
  await assert.rejects(execute.execute({ input: { state: next, step } }), { code: 'GENERAL_NO_PROGRESS' })
  await assert.rejects(execute.execute({ input: { state, step: { ...step, capabilityId: 'shell' } } }), { code: 'GENERAL_CAPABILITY_UNAVAILABLE' })
  await assert.rejects(execute.execute({ input: { state: { ...state, scope: { folder: 'forbidden' } }, step } }), { code: 'GENERAL_SCOPE_NOT_ADMITTED' })
})

test('核验失败不能形成任务证据，预算终点不得无依据宣称完成', async () => {
  const { definition } = workflow({ verify: async () => ({ passed: false }) })
  const state = await definition.nodes[0].execute({ input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: {} } })
  const execute = definition.nodes.find(node => node.id === 'execute-1')
  await assert.rejects(execute.execute({ input: { state, step: { done: false, objective: '查询', capabilityId: 'lookup', input: {}, expectedEvidence: '回读' } } }), { code: 'GENERAL_EVIDENCE_UNVERIFIED' })
  const validate = definition.nodes.at(-1)
  await assert.rejects(validate.execute({ input: { state, report: { outcome: 'completed', summary: '完成', evidenceIds: [], limitations: ['仍缺证据'] } } }), { code: 'GENERAL_COMPLETION_UNVERIFIED' })
  await assert.rejects(validate.execute({ input: { state, report: { outcome: 'blocked', summary: '尚缺证据', evidenceIds: [], limitations: ['预算已耗尽'] } } }), { code: 'GENERAL_TASK_BLOCKED' })
})

test('模型标记完成且附带证据时，Host 验收失败仍拒绝完成', async () => {
  const { definition } = workflow({}, async () => ({ status: 'insufficient', resultVerified: false, criteria: [] }))
  const initial = await definition.nodes[0].execute({ input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: {} } })
  const next = await definition.nodes.find(node => node.id === 'execute-1').execute({ input: { state: initial,
    step: { done: false, objective: '查询', capabilityId: 'lookup', input: {}, expectedEvidence: '回读' } } })
  const completed = { ...next, done: true }
  await assert.rejects(definition.nodes.at(-1).execute({ input: { state: completed,
    report: { outcome: 'completed', summary: '实际读取值', evidenceIds: ['step-1'], limitations: ['存在待核事项'] } } }),
  { code: 'GENERAL_COMPLETION_UNVERIFIED' })
})

test('伪造回读摘要、空来源或漏验收项均不能完成', async () => {
  for (const verification of [
    { passed: true, outputDigest: '0'.repeat(64), sourceRefs: ['source:a'] },
    { passed: true, outputDigest: executionDigest({ value: '实际读取值' }), sourceRefs: [] },
  ]) {
    const { definition } = workflow({ verify: async () => verification })
    const state = await definition.nodes[0].execute({ input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: {} } })
    await assert.rejects(definition.nodes.find(node => node.id === 'execute-1').execute({ input: { state,
      step: { done: false, objective: '查询', capabilityId: 'lookup', input: {}, expectedEvidence: '回读' } } }),
    { code: 'GENERAL_EVIDENCE_UNVERIFIED' })
  }
  const { definition } = workflow({}, async () => ({ status: 'satisfied', resultVerified: true, criteria: [] }))
  const state = await definition.nodes[0].execute({ input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: {} } })
  const next = await definition.nodes.find(node => node.id === 'execute-1').execute({ input: { state,
    step: { done: false, objective: '查询', capabilityId: 'lookup', input: {}, expectedEvidence: '回读' } } })
  await assert.rejects(definition.nodes.at(-1).execute({ input: { state: { ...next, done: true },
    report: { outcome: 'completed', summary: '实际读取值', evidenceIds: ['step-1'], limitations: [] } } }),
  { code: 'GENERAL_COMPLETION_UNVERIFIED' })
})

test('真实控制账将只读步骤、回读和报告作为独立检查点', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-general-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'general', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const { definition, calls } = workflow()
  let agentCalls = 0
  const sessions = { async run({ input, onSessionBound, onResult }) {
    await onSessionBound()
    agentCalls++
    if (agentCalls === 1) onResult({ done: false, objective: '查询', capabilityId: 'lookup', input: { name: 'a' }, expectedEvidence: '回读' })
    else if (agentCalls === 2) onResult({ done: true, objective: '', capabilityId: '', input: {}, expectedEvidence: '' })
    else onResult({ outcome: 'completed', summary: input.evidence[0].output.value, evidenceIds: ['step-1'], limitations: [] })
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: [definition] })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-general', input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: { folder: 'docs' } } })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(agentCalls, 3)
  assert.equal(calls.length, 2)
  assert.equal(state.nodes.length, 7)
  assert.deepEqual(await artifacts.read(state.nodes.at(-1).outputRef), { outcome: 'completed', summary: '实际读取值', evidenceIds: ['step-1'], limitations: [] })
  assert.deepEqual(await store.query({ kind: 'effect.list', runId: 'run' }), [])
})

test('缺能力或预算耗尽停在 waiting，并保留受阻报告', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-general-blocked-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'blocked', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const { definition } = workflow()
  let calls = 0
  const sessions = { async run({ onSessionBound, onResult }) {
    await onSessionBound()
    calls++
    if (calls <= 2) onResult({ done: true, objective: '', capabilityId: '', input: {}, expectedEvidence: '' })
    else onResult({ outcome: 'blocked', summary: '缺少可用能力', evidenceIds: [], limitations: ['该范围没有已登记的读取能力'] })
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: [definition] })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-general', input: { request: '查询资料', acceptanceCriteria: ['提供资料值'], constraints: [], scope: {} } })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes.at(-1).waitReason.reference, 'GENERAL_TASK_BLOCKED')
  assert.deepEqual(await artifacts.read(state.nodes.at(-2).outputRef), {
    outcome: 'blocked', summary: '缺少可用能力', evidenceIds: [], limitations: ['该范围没有已登记的读取能力'],
  })
})
