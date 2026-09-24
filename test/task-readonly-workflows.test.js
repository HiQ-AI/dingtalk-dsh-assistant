import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createReadOnlyTaskWorkflows } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { readOnlyTaskCatalog } from '../packages/dingtalk-dsh-assistant/task-readonly-workflows.js'

const ids = ['task-investigation', 'task-planning', 'task-pr-review', 'task-data-query', 'task-retrospective']
const input = { request: '分析这份已提供的材料', constraints: [], materials: [{ id: 'source-1', text: '本次提供的可核材料' }] }

test('五类只读流程均为固定三节点，无读写工具及外部副作用能力', () => {
  const definitions = createReadOnlyTaskWorkflows({ provider: 'test', model: 'synthetic' })
  assert.deepEqual(definitions.map(item => item.id), ids)
  assert.deepEqual(readOnlyTaskCatalog.map(item => item.id), ids)
  assert.ok(Object.isFrozen(readOnlyTaskCatalog) && readOnlyTaskCatalog.every(Object.isFrozen))
  for (const item of definitions) {
    assert.equal(defineExecutionWorkflow(item).id, item.id)
    assert.deepEqual(item.nodes.map(node => node.id), ['prepare', 'assess', 'validate-result'])
    assert.ok(item.nodes.every(node => node.allowedEffects.every(effect => effect === 'pure')))
    assert.deepEqual(item.nodes[1].allowedTools, [])
    assert.match(item.nodes[1].prompt, /execution_node_submit/)
  }
})

for (const workflowId of ids) for (const invalid of [false, true]) test(`${workflowId}：真实控制账${invalid ? '拒绝伪造来源引用' : '记录验证后的证据产出'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-readonly-workflow-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: workflowId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let calls = 0
  const sessions = { async run({ input: received, definition, onSessionBound, onResult }) {
    calls++
    assert.deepEqual(received, input)
    assert.deepEqual(definition.allowedTools, [])
    await onSessionBound()
    const evidenceId = invalid ? 'source-not-provided' : 'source-1'
    onResult({ summary: '材料仅支持此结论', findings: [{ statement: '可回查事实', evidenceIds: [evidenceId] }], evidenceIds: [evidenceId], limitations: ['未直接访问仓库或数据库'] })
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: createReadOnlyTaskWorkflows({ provider: 'test', model: 'synthetic' }) })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId, input })
  const state = await controller.whenIdle('run')
  assert.equal(calls, 1)
  assert.equal(state.run.status, invalid ? 'waiting' : 'succeeded')
  assert.equal(state.nodes[2].status, invalid ? 'waiting' : 'succeeded')
  if (invalid) assert.equal(state.nodes[2].waitReason.reference, 'TASK_READONLY_EVIDENCE_INVALID')
  else assert.deepEqual(await artifacts.read(state.nodes[2].outputRef), { summary: '材料仅支持此结论', findings: [{ statement: '可回查事实', evidenceIds: ['source-1'] }], evidenceIds: ['source-1'], limitations: ['未直接访问仓库或数据库'] })
  assert.deepEqual(await store.query({ kind: 'effect.list', runId: 'run' }), [])
})

test('缺少材料的只读流程停在准备节点，Agent 不启动', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-readonly-empty-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'empty', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let called = false
  const sessions = { async run() { called = true }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: createReadOnlyTaskWorkflows({ provider: 'test', model: 'synthetic' }) })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-investigation', input: { ...input, materials: [] } })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes[0].waitReason.reference, 'TASK_READONLY_REQUIREMENT_INVALID')
  assert.equal(called, false)
})
