import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeneralTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { createGeneralFileReadCapability, createGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability,
  createHistoricalGeneralCapabilityStepWorkflow } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskMarkdownFileAdapter } from '../packages/dingtalk-dsh-assistant/task-markdown-file.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
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

test('受信文件读取只接受双重授权路径，独立回读能发现修改和链接逃逸', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-general-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-general-outside-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'note.md'), '核验材料', 'utf8')
  await writeFile(join(outside, 'secret.md'), '不可读取', 'utf8')
  const capability = createGeneralFileReadCapability({ root, readablePaths: ['docs/note.md', 'docs/link.md'] })
  const scope = { readableFiles: ['docs/note.md', 'docs/link.md'] }
  const input = { path: 'docs/note.md' }
  assert.equal(await capability.authorize({ input, scope }), true)
  const output = await capability.execute({ input })
  assert.equal(output.content, '核验材料')
  assert.equal((await capability.verify({ input, scope, output })).passed, true)
  await writeFile(join(root, 'docs', 'note.md'), '已经改变', 'utf8')
  assert.equal((await capability.verify({ input, scope, output })).passed, false)
  assert.equal(await capability.authorize({ input: { path: 'docs/other.md' }, scope }), false)
  assert.equal(await capability.authorize({ input, scope: { readableFiles: [] } }), false)
  try {
    await symlink(join(outside, 'secret.md'), join(root, 'docs', 'link.md'))
    await assert.rejects(capability.execute({ input: { path: 'docs/link.md' } }), { code: 'GENERAL_FILE_SCOPE_DENIED' })
  } catch (error) { if (error.code !== 'EPERM') throw error } // Windows 未开放符号链接权限时仍执行其余路径门禁断言。
  assert.throws(() => createGeneralFileReadCapability({ root, readablePaths: ['../secret.md'] }), { code: 'GENERAL_FILE_CONFIG_INVALID' })
})

test('Owner 单步执行载体只有代码节点，按受信范围执行并独立核验', async () => {
  const calls = []
  const capabilities = [{ id: 'lookup', identity: 'lookup-v1', effectClass: 'read',
    authorize: async ({ input, scope }) => input.key === 'a' && scope.folder === 'docs',
    execute: async () => { calls.push('execute'); return { value: '已读回的值' } },
    verify: async ({ output }) => { calls.push('verify'); return { passed: true,
      outputDigest: executionDigest(output), sourceRefs: ['source:a'] } },
  }]
  const definition = createGeneralCapabilityStepWorkflow({ capabilities })
  assert.equal(definition.id, 'task-general-capability')
  assert.deepEqual(definition.nodes.map(node => node.executor), ['code'])
  assert.notEqual(defineExecutionWorkflow(definition).digest, defineExecutionWorkflow(workflow().definition).digest)
  const request = { capabilityId: 'lookup', input: { key: 'a' }, scope: { folder: 'docs' }, expectedEvidence: '源回读' }
  const result = await definition.nodes[0].execute({ input: request })
  assert.deepEqual(calls, ['execute', 'verify'])
  assert.equal(result.verification.sourceRefs[0], 'source:a')
  await assert.rejects(definition.nodes[0].execute({ input: { ...request, scope: { folder: 'forbidden' } } }),
    { code: 'GENERAL_SCOPE_NOT_ADMITTED' })
  await assert.rejects(definition.nodes[0].execute({ input: { ...request, capabilityId: 'shell' } }),
    { code: 'GENERAL_CAPABILITY_UNAVAILABLE' })
  assert.deepEqual(calls, ['execute', 'verify'])
  const failed = createGeneralCapabilityStepWorkflow({ capabilities: [{ ...capabilities[0],
    verify: async () => ({ passed: false }) }] })
  await assert.rejects(failed.nodes[0].execute({ input: request }), { code: 'GENERAL_EVIDENCE_UNVERIFIED' })
  assert.throws(() => createGeneralCapabilityStepWorkflow({ capabilities: [{ ...capabilities[0], effectClass: 'write' }] }),
    { code: 'GENERAL_CAPABILITY_INVALID' })
  assert.equal(createHistoricalGeneralCapabilityStepWorkflow({ capabilities }).version, '1')
})

test('Task Markdown 文件仅落在 Host 根目录，回读核验原字节且冲突不覆盖', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = createTaskMarkdownFileAdapter({ root })
  const capability = createGeneralMarkdownWriteCapability({ fileAdapter: adapter })
  const binding = { taskId: 'task-1', runId: 'run-1', nodeRunId: 'node-1', generation: 1,
    requirementDigest: 'a'.repeat(64) }
  const input = { content: '# 调查结论\n\n已核对证据。\n' }
  assert.equal(await capability.authorize({ input, scope: { writeMarkdown: true } }), true)
  assert.equal(await capability.authorize({ input, scope: {} }), false)
  assert.equal(await capability.authorize({ input: { ...input, path: 'C:\\outside.md' }, scope: { writeMarkdown: true } }), false)
  const prepared = adapter.prepare({ input, binding })
  assert.equal((await adapter.reconcile(prepared)).status, 'failed')
  const first = await adapter.execute(prepared)
  assert.equal(first.status, 'succeeded')
  assert.equal(await readFile(first.result.path, 'utf8'), input.content)
  assert.equal((await adapter.execute(prepared)).result.contentDigest, first.result.contentDigest)
  assert.equal((await capability.verify({ prepared, output: first })).passed, true)
  await writeFile(first.result.path, '# 外部修改\n')
  await assert.rejects(adapter.reconcile(prepared), { code: 'TASK_MARKDOWN_CONFLICT' })
  await assert.rejects(adapter.execute(prepared), { code: 'TASK_MARKDOWN_CONFLICT' })
  assert.equal(await readFile(first.result.path, 'utf8'), '# 外部修改\n')
  assert.throws(() => adapter.prepare({ input, binding: { ...binding, taskId: '../escape' } }),
    { code: 'TASK_MARKDOWN_PREPARED_INVALID' })
})

test('Task Markdown 写入经过效果账，重启对账不重放写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-ledger-'))
  let store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'markdown', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const fileAdapter = createTaskMarkdownFileAdapter({ root: join(root, 'task-files') })
  const capability = createGeneralMarkdownWriteCapability({ fileAdapter })
  const delivery = createExecutionDelivery({ store, artifacts, fileAdapter,
    authorize: async () => null,
    authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
      ? { principalId: 'host', authorizationRef: 'task-markdown-grant' } : null })
  const definition = createGeneralCapabilityStepWorkflow({ capabilities: [capability] })
  let controller = createExecutionController({ store, artifacts, delivery, workflows: [definition] })
  t.after(async () => { await controller?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create-markdown', runId: 'run-1', taskId: 'task-1',
    workflowId: 'task-general-capability', input: { capabilityId: capability.id,
      input: { content: '# 可交付报告\n\n结论。\n' }, scope: { writeMarkdown: true }, expectedEvidence: '文件读回' } })
  const state = await controller.whenIdle('run-1')
  assert.equal(state.run.status, 'succeeded', JSON.stringify({ waitReason: state.nodes[0].waitReason,
    error: (await controller.state('run-1')).controllerError,
    effects: await store.query({ kind: 'effect.list', runId: 'run-1' }) }))
  const output = await artifacts.read(state.nodes[0].outputRef)
  assert.equal(await readFile(output.output.result.path, 'utf8'), '# 可交付报告\n\n结论。\n')
  const effects = await store.query({ kind: 'effect.list', runId: 'run-1' })
  assert.equal(effects.length, 1)
  assert.equal(effects[0].state, 'succeeded')
  assert.equal(effects[0].definition.action, 'file')
  assert.equal((await delivery.reconcile(effects[0].effectId)).state, 'succeeded')
  await controller.close(); controller = null
  await store.close(); store = null
  store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'markdown' })
  const recoveredDelivery = createExecutionDelivery({ store, artifacts, fileAdapter, authorize: async () => null,
    authorizeFile: async () => null })
  assert.equal((await recoveredDelivery.reconcile(effects[0].effectId)).state, 'succeeded')
  assert.equal(await readFile(output.output.result.path, 'utf8'), '# 可交付报告\n\n结论。\n')
})

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
