import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createReleaseTaskWorkflow, createLegacyReleaseTaskWorkflow, releaseWorkflowKinds, readScopedDataChangeCompletionEvidence, createScopedNativeDataChangeCompletionPolicy, createNativeDataChangeCompletionPolicy, readDataChangeCompletionEvidence } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'

import { createDataChangeTaskWorkflowV6 } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'

const commitSha = 'a'.repeat(40)

// 常量取自部署前正式包 column-delete-20261003-r23（b7fbd3a9…），不得随新策略更新。
test('冻结v4完成策略保留部署前函数正文及原v6工作流定义摘要，新作用域使用v5', () => {
  const sha = value => createHash('sha256').update(value).digest('hex')
  assert.equal(sha(readDataChangeCompletionEvidence.toString()), '0561d6cea70cc25ed978fea5710adc436e7df183911313902084e075603718f3')
  assert.equal(sha(createNativeDataChangeCompletionPolicy.toString()), 'f53d112d9cb548324b7547f83a7f7b53a07698873733bc8b03a92a98020b9581')
  const adapter = { id: 'frozen-test', version: '1', rulesDigest: 'a'.repeat(64), pluginApproval: true,
    nativeApproval: true, validate() {}, async readCompletion(){return {}} }
  for (const key of ['prepareRehearsal', 'readbackRehearsal', 'inspect', 'prepareIssue', 'prepareApproval',
    'prepareExecute', 'readback', 'readBaselineForCandidate']) adapter[key] = () => {}
  const ownerContract = createNativeDataChangeCompletionPolicy(adapter)
  assert.equal(ownerContract.version, '4')
  const workflow = createDataChangeTaskWorkflowV6({ provider: 'fixture', model: 'fixture', adapter })
  assert.equal(defineExecutionWorkflow({ ...workflow, ownerContract }).digest, '2de981104d4965b6ff44f0b3390bd21b85e8167a813bb2944dad887cda0f0f74')
  const scoped = createScopedNativeDataChangeCompletionPolicy(adapter)
  assert.equal(scoped.version, '5')
  assert.notEqual(scoped.rulesDigest, ownerContract.rulesDigest)
})

function completionEvidenceFixture({ expectedChange, observedChange } = {}) {
  const target = { instance: 'production', database: 'editor', environment: 'production' }
  const applySql = 'ALTER TABLE public.process_id_temp ADD COLUMN name text;'
  const applySqlSha256 = createHash('sha256').update(applySql).digest('hex')
  const rows = [{ column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null, character_maximum_length: null }]
  const body = { target, applySql, applySqlSha256, expectedChange: expectedChange ?? JSON.stringify({ rows }) }, packageDigest = executionDigest(body)
  const identity = { runId: 'run', generation: 1, issueId: '857', planId: 'plan', sheetId: 'sheet',
    target, sheetSha256: applySqlSha256, packageDigest }
  const scopeDigest = executionDigest(identity)
  const view = { prepared: { package: { ...body, validation: { receiptId: 'validation', packageDigest } } },
    issue: { id: '857', planId: 'plan' }, plan: { id: 'plan', sheetId: 'sheet' }, sheet: { id: 'sheet', sha256: applySqlSha256, target },
    approval: { decision: 'approved', human: true, source: 'assistant', issueId: '857', planId: 'plan', sheetId: 'sheet',
      target, sheetSha256: applySqlSha256, packageDigest, scopeDigest, requestId: 'approval', decidedBy: 'approver' } }
  const request = { runId: 'run', generation: 1, workflowKind: 'data-change', stage: 'execute-task',
    target, packageDigest, applySqlSha256, approvalRequestId: 'approval', intent: { approvalScopeDigest: scopeDigest, applySql } }
  const receipt = { status: 'succeeded', result: { taskId: '905' } }
  const final = { issueId: '857', planId: 'plan', sheetId: 'sheet', taskId: '905', taskRunId: '901', packageDigest, applySqlSha256,
    productionReadbackId: 'original-readback', observedChange: observedChange ?? JSON.stringify(rows) }
  const outputs = { 'readback-approval': view, 'prepare-execute': { view, request }, 'execute-task': { view, request, receipt }, 'readback-production': final }
  const nodes = Object.keys(outputs).map(nodeId => ({ nodeId, nodeRunId: `${nodeId}-run`, outputRef: nodeId,
    generation: 1, status: 'succeeded', executor: 'code', drained: true, inputDigest: `${nodeId}-input` }))
  const readbackInput = { workflowDigest: 'workflow-digest', nodeId: 'readback-production', data: structuredClone(outputs['execute-task']) }
  const readbackNode = nodes.find(node => node.nodeId === 'readback-production')
  Object.assign(readbackNode, { inputRef: 'readback-input', inputDigest: executionDigest(readbackInput) })
  const effects = [{ effectId: 'execute-effect', nodeId: 'execute-task', nodeRunId: 'execute-task-run', generation: 1,
    inputDigest: 'execute-task-input', state: 'succeeded', definition: { payload: request },
    result: { effectId: 'execute-effect', status: 'succeeded', evidenceRef: 'execution-receipt', result: receipt } },
    { effectId: 'gate-effect', nodeId: 'approval-gate', definition: { payload: { intent: { scopeDigest, issueId: '857' } } } }]
  const approvalProof = { gateEffectId: 'gate-effect', approval: { decidedBy: 'approver' } }
  const observed = { task: { id: '905', status: 'DONE' }, taskRun: { id: '901', status: 'DONE' },
    production: { passed: true, packageDigest }, applySql }
  let readbacks = 0
  const context = { taskId: 'task', stage: { runId: 'run', outputRef: 'readback-production' },
    acceptanceItems: [{ itemId: 'current', criterion: '当前列存在', evidenceRefs: ['readback-production'] }],
    state: { run: { taskId: 'task', runId: 'run', generation: 1, status: 'succeeded', workflowDigest: 'workflow-digest' }, nodes },
    artifacts: { async read(ref) { if (ref === 'readback-input') return readbackInput; assert.ok(Object.hasOwn(outputs, ref)); return outputs[ref] } },
    store: { async query(query) { return query.kind === 'effect.list' ? effects : approvalProof } } }
  const adapter = { async readCompletion(input) { readbacks++; assert.equal(input.request, request); return observed } }
  return { context, adapter, outputs, effects, approvalProof, observed, get readbacks() { return readbacks } }
}

test('数据变更完成证明读取原节点、原生批准和执行效果，完成引用仅保留最终产物', async () => {
  const f = completionEvidenceFixture(), proof = await readScopedDataChangeCompletionEvidence(f.context, f.adapter)
  assert.deepEqual(proof.completionEvidenceRefs, ['readback-production'])
  assert.deepEqual(proof.nodeArtifacts.map(item => item.nodeId), Object.keys(f.outputs))
  assert.equal(proof.domainEvidence.approval, f.approvalProof)
  assert.equal(proof.domainEvidence.taskRun.id, '901')
  const policy = createScopedNativeDataChangeCompletionPolicy(f.adapter)
  assert.equal(policy.version, '5')
  let semantic = 0
  assert.equal(await policy.validateCompletion({ ...f.context, output: f.outputs['readback-production'],
    acceptanceItems: f.context.acceptanceItems, verifyAcceptance: async () => { semantic++; return true } }), true)
  assert.equal(semantic, 1); assert.equal(f.readbacks, 2)
})

test('完成证明拒绝节点、身份、执行效果、批准范围及线上回查漂移', async () => {
  for (const [name, mutate, code] of [
    ['缺节点', f => f.context.state.nodes.pop(), 'NODE_INVALID'],
    ['重复节点', f => f.context.state.nodes.push({ ...f.context.state.nodes[0] }), 'NODE_INVALID'],
    ['旧代次', f => f.context.state.nodes[0].generation = 0, 'NODE_INVALID'],
    ['未排空', f => f.context.state.nodes[0].drained = false, 'NODE_INVALID'],
    ['跨任务', f => f.context.state.run.taskId = 'other', 'IDENTITY_INVALID'],
    ['执行包漂移', f => f.outputs['execute-task'].request.packageDigest = 'other', 'IDENTITY_INVALID'],
    ['效果缺失', f => f.effects.shift(), 'EFFECT_INVALID'],
    ['效果未知', f => f.effects[0].result = { status: 'unknown' }, 'EFFECT_INVALID'],
    ['效果输入漂移', f => f.effects[0].inputDigest = 'other', 'EFFECT_INVALID'],
    ['审批身份漂移', f => f.approvalProof.approval.decidedBy = 'other', 'APPROVAL_INVALID'],
    ['审批scope漂移', f => f.effects[1].definition.payload.intent.scopeDigest = 'other', 'APPROVAL_INVALID'],
    ['TaskRun未完成', f => f.observed.taskRun.status = 'RUNNING', 'READBACK_INVALID'],
    ['生产核验失败', f => f.observed.production.passed = false, 'READBACK_INVALID'],
    ['线上SQL漂移', f => f.observed.applySql = 'different SQL', 'READBACK_INVALID'],
  ]) {
    const f = completionEvidenceFixture(); mutate(f)
    await assert.rejects(readScopedDataChangeCompletionEvidence(f.context, f.adapter), new RegExp(`DATA_CHANGE_COMPLETION_${code}`), name)
  }
})

test('驳回待修订仅交接意见，不读取线上且不能完成业务', async () => {
  const f = completionEvidenceFixture()
  f.outputs['readback-production'] = { outcome: 'needs_revision', comment: '修改字段规格' }
  assert.equal((await readScopedDataChangeCompletionEvidence(f.context, f.adapter)).domainEvidence.comment, '修改字段规格')
  assert.equal(await createScopedNativeDataChangeCompletionPolicy(f.adapter).validateCompletion({ ...f.context,
    output: f.outputs['readback-production'] }), false)
  assert.equal(f.readbacks, 0)
})

test('历史加列成果不再要求当前仍存在；当前验收及历史批准执行证明继续独立核验', async () => {
  const f = completionEvidenceFixture()
  f.adapter.readCompletion = async () => { throw new Error('当前已删除原列') }
  const historical = { ...f.context, acceptanceItems: [] }
  const proof = await readScopedDataChangeCompletionEvidence(historical, f.adapter)
  assert.equal(proof.domainEvidence.timeScope, 'at-execution')
  assert.equal(proof.domainEvidence.historicalReadback.observedChange, f.outputs['readback-production'].observedChange)
  assert.equal(await createScopedNativeDataChangeCompletionPolicy(f.adapter).validateCompletion({ ...historical,
    output: f.outputs['readback-production'], verifyAcceptance: async () => { throw new Error('历史无当前验收项') } }), true)
  await assert.rejects(readScopedDataChangeCompletionEvidence(f.context, f.adapter), /当前已删除原列/)
  f.effects[0].result.status = 'unknown'
  await assert.rejects(readScopedDataChangeCompletionEvidence(historical, f.adapter), /DATA_CHANGE_COMPLETION_EFFECT_INVALID/)
  const corrupted = completionEvidenceFixture()
  corrupted.outputs['readback-production'].productionReadbackId = ''
  await assert.rejects(readScopedDataChangeCompletionEvidence({ ...corrupted.context, acceptanceItems: [] }, corrupted.adapter), /DATA_CHANGE_COMPLETION_READBACK_INVALID/)
})
test('历史受信适配器的非JSON回查正文保留，不收窄为固定列查询协议', async () => {
  const f = completionEvidenceFixture({ expectedChange: '业务记录更新为已归档', observedChange: '已确认记录更新为已归档' })
  const proof = await readScopedDataChangeCompletionEvidence({ ...f.context, acceptanceItems: [] }, f.adapter)
  assert.equal(proof.domainEvidence.historicalReadback.observedChange, '已确认记录更新为已归档')
  assert.equal(f.readbacks, 0)
  f.context.state.nodes.find(node => node.nodeId === 'readback-production').inputDigest = 'forged'
  await assert.rejects(readScopedDataChangeCompletionEvidence({ ...f.context, acceptanceItems: [] }, f.adapter), /READBACK_INVALID/)
})
test('生产与重建旧定义摘要仍可恢复，新定义使用稳定换行摘要', () => {
  const frozenRules = '0e5ce6311e8a9d3d67e67fa22cd9422fad4b8951cd53cb93b91ddcf99ffc05c8'
  const expected = { 'production-release': '3ed7ab9e46b14c27e1d770b9c1302785f523a5b20abb7b6bb9fc5902860ca38b',
    'uat-rebuild': 'd0cf2f30ea1dc047ec7917f31d1171cfec69dfce0a1148872bef9f96f3009f17' }
  const stable = { 'production-release': 'cfc445fccb8aad25bd3fb646f148a3682de2b1c8de26f799710838e1a37c0c26',
    'uat-rebuild': '09ca4ce3df58c448fef049bd3502652c89849b514a90474d49f4d2bd3ec23d43' }
  for (const [kind, digest] of Object.entries(expected)) {
    const adapter = { id: `trusted-release-${kind}`, version: '1', rulesDigest: frozenRules,
      inspect() {}, prepareOperation() {} }
    const definition = defineExecutionWorkflow(createLegacyReleaseTaskWorkflow({ kind, adapter }))
    assert.ok([definition.digest, ...definition.legacyDigests].includes(stable[kind]))
    assert.ok([definition.digest, ...definition.legacyDigests].includes(digest))
  }
  const adapter = { id: 'trusted-release-production-release', version: '1', rulesDigest: frozenRules,
    inspect() {}, prepareOperation() {} }
  const next = createReleaseTaskWorkflow({ kind: 'production-release', adapter })
  const historical = createLegacyReleaseTaskWorkflow({ kind: 'production-release', adapter })
  assert.equal(next.version, '2')
  assert.equal(historical.version, '1')
  assert.ok(next.nodes.some(node => node.id === 'execute-verify-main-merge'))
  assert.ok(historical.nodes.some(node => node.id === 'execute-merge-main'))
})
const operations = {
  'uat-deployment': ['build'], 'production-release': ['verify-main-merge', 'approval-gate', 'tag', 'build'], 'uat-rebuild': ['rebuild'],
}
const phases = {
  'uat-deployment': ['preflight', 'built', 'runtime'],
  'production-release': ['preflight', 'merged', 'approved', 'tagged', 'built', 'runtime'],
  'uat-rebuild': ['preflight', 'built', 'runtime'],
}
const requirement = kind => ({ request: '按精确提交完成部署', target: {
  repository: 'hiq/repo', environment: kind === 'production-release' ? 'production' : 'uat',
  service: 'dataset-web', commitSha, runbookId: 'runbook-v1',
  ...(kind === 'production-release' ? { releaseTag: 'v20260925-1' } : {}),
}, constraints: [], evidenceRefs: ['source:1'] })
const preflight = {
  targetBranchVerified: true, uatPrMerged: true, sourcePackageSupported: true,
  equivalentBuildAbsent: true, releaseSetVerified: true, uatAccepted: true, productionBaselineVerified: true,
  dependencyOrderVerified: true, rollbackBoundaryVerified: true, failurePipelineVerified: true,
  branchHeadMatches: true, noNewerRuntimeVersion: true,
}
const runtime = { sourceSha: commitSha, registryDigest: 'sha256:digest', runtimeDigest: 'sha256:digest',
  observedGeneration: '12', ready: true, entryAccessible: true, imageChainVerified: true }

function adapterFor(kind, overrides = {}) {
  const seen = { phases: [], operations: [] }
  return { id: 'synthetic-release', version: '1', rulesDigest: 'b'.repeat(64), seen,
    async inspect({ phase, requirement: input, effect }) {
      seen.phases.push(phase)
      return { phase, targetDigest: executionDigest(input.target), status: 'confirmed',
        evidenceRefs: [`readback:${phase}`], facts: phase === 'preflight' ? { ...preflight, ...overrides.preflight }
          : { ...(phase === 'runtime' ? { ...runtime, ...overrides.runtime } : { stage: phase }),
            ...(phase === 'approved' ? { approvalScopeDigest: executionDigest({ target: input.target, operation: 'tag' }),
              approvalReceiptDigest: executionDigest(effect.receipt) } : {}),
            operationKey: effect.prepared.operationKey, receiptDigest: executionDigest(effect.receipt) } }
    },
    async prepareOperation({ kind: actualKind, operation, requirement: input, observation,
      runId, generation, requirementDigest, expected }) {
      assert.equal(actualKind, kind)
      seen.operations.push(operation)
      return { action: 'external', workflowKind: kind, operation, runId, generation, requirementDigest,
        resourceKey: `external:${input.target.environment}:${input.target.repository}:${input.target.service}`,
        targetDigest: executionDigest(input.target), expected: { ...expected,
          ...(kind === 'production-release' && ['approval-gate', 'tag'].includes(operation) ? { tag: input.target.releaseTag } : {}),
          ...overrides.expected },
        operationKey: `${kind}:${operation}:${input.target.commitSha}` }
    } }
}

async function harness(t, kind, adapter, authorize = () => true) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'release', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  const calls = []
  const delivery = { async execute({ binding, action, prepared }) {
    assert.equal(action, 'external'); assert.equal(prepared.runId, binding.runId)
    if (!authorize(prepared)) throw Object.assign(new Error('denied'), { code: 'DELIVERY_NOT_AUTHORIZED' })
    calls.push(prepared.operation)
    return { state: 'succeeded', ...(prepared.operation === 'approval-gate'
      ? { result: { result: { status: 'succeeded', scopeDigest: prepared.expected.approvalScopeDigest } } }
      : { result: { result: { operation: prepared.operation, status: 'accepted' } } }) }
  } }
  const workflow = createReleaseTaskWorkflow({ kind, adapter })
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id, input: requirement(kind) })
  return { controller, artifacts, calls, workflow }
}

for (const kind of releaseWorkflowKinds) test(`${kind}: 固定节点按顺序交付，真实回读后才完成`, async t => {
  const adapter = adapterFor(kind)
  const { controller, artifacts, calls, workflow } = await harness(t, kind, adapter)
  assert.equal(defineExecutionWorkflow(workflow).nodes.length, 2 + phases[kind].length + 2 * operations[kind].length)
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(n => [n.nodeId, n.waitReason])))
  assert.deepEqual(adapter.seen.phases, phases[kind])
  assert.deepEqual(adapter.seen.operations, operations[kind])
  assert.deepEqual(calls, operations[kind])
  const result = await artifacts.read(state.nodes.at(-1).outputRef)
  assert.equal(result.status, kind === 'uat-deployment' ? 'uat-deployed' : 'technical-delivery-confirmed')
  assert.equal(result.commitSha, commitSha)
})

test('无 Host adapter 拒绝注册；生产业务放行由真人审批门禁决定', async t => {
  assert.throws(() => createReleaseTaskWorkflow({ kind: 'production-release' }), { code: 'RELEASE_ADAPTER_REQUIRED' })
  const adapter = adapterFor('production-release', { preflight: { uatAccepted: false } })
  const { controller, calls } = await harness(t, 'production-release', adapter, prepared => prepared.operation !== 'approval-gate')
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes.find(node => node.nodeId === 'execute-approval-gate').waitReason.reference, 'DELIVERY_NOT_AUTHORIZED')
  assert.deepEqual(calls, ['verify-main-merge'])
})

test('生产 Run 必须冻结本次精确 Tag，UAT 不接收生产 Tag', async () => {
  const production = createReleaseTaskWorkflow({ kind: 'production-release', adapter: adapterFor('production-release') })
  const input = requirement('production-release')
  delete input.target.releaseTag
  await assert.rejects(production.nodes[0].execute({ input }), { code: 'RELEASE_REQUIREMENT_INVALID' })
  const uat = createReleaseTaskWorkflow({ kind: 'uat-deployment', adapter: adapterFor('uat-deployment') })
  const withTag = requirement('uat-deployment')
  withTag.target.releaseTag = 'v20260925-1'
  await assert.rejects(uat.nodes[0].execute({ input: withTag }), { code: 'RELEASE_REQUIREMENT_INVALID' })
})

test('UAT 运行源码与冻结版本不一致时停留在回读节点，不声明交付', async t => {
  const adapter = adapterFor('uat-rebuild', { runtime: { sourceSha: 'b'.repeat(40) } })
  const { controller, calls } = await harness(t, 'uat-rebuild', adapter)
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes.at(-2).waitReason.reference, 'RELEASE_RUNTIME_IDENTITY_MISMATCH')
  assert.deepEqual(calls, ['rebuild'])
})

test('生产每个外部动作均重新由交付网关按精确范围授权', async t => {
  const adapter = adapterFor('production-release')
  const { controller, calls } = await harness(t, 'production-release', adapter, prepared => prepared.operation !== 'tag')
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes.find(n => n.nodeId === 'execute-tag').waitReason.reference, 'DELIVERY_NOT_AUTHORIZED')
  assert.deepEqual(calls, ['verify-main-merge', 'approval-gate'])
})

test('生产流程经真实效果账等待 Web 审批，批准后同一精确动作只发送一次', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-gateway-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'release-gateway', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  const adapter = adapterFor('production-release')
  const sends = []
  const externalAdapter = { async execute(prepared) {
    sends.push(prepared.operation)
    return { status: 'succeeded', evidenceRef: `effect:${prepared.operation}`,
      ...(prepared.operation === 'approval-gate' ? { scopeDigest: prepared.expected.approvalScopeDigest } : {}) }
  }, async reconcile(prepared) { return { status: 'succeeded', evidenceRef: `effect:${prepared.operation}`,
    ...(prepared.operation === 'approval-gate' ? { scopeDigest: prepared.expected.approvalScopeDigest } : {}) } } }
  const delivery = createExecutionDelivery({ store, artifacts, externalAdapter,
    authorize: async () => ({ principalId: 'host', authorizationRef: 'unused' }),
    authorizeExternal: async ({ prepared }) => prepared.operation === 'approval-gate'
      ? { principalId: 'owner', approval: { requestId: 'release-approval', approverIds: ['owner'] } }
      : { principalId: 'owner', authorizationRef: `approved-scope:${prepared.operation}` },
  })
  const workflow = createReleaseTaskWorkflow({ kind: 'production-release', adapter })
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id, input: requirement('production-release') })
  const before = await controller.whenIdle('run')
  assert.equal(before.run.status, 'waiting')
  assert.equal(before.nodes.find(node => node.nodeId === 'execute-approval-gate').waitReason.reference, 'effect_approval_required')
  assert.deepEqual(sends, ['verify-main-merge'])
  const held = (await store.query({ kind: 'effect.list', runId: 'run' })).find(effect => effect.definition.payload.operation === 'approval-gate')
  assert.equal(held.state, 'prepared')
  assert.equal(held.requestId, 'release-approval')
  await store.command({ id: 'approve', kind: 'approval.decide', args: { requestId: 'release-approval', actorId: 'owner', source: 'web', decision: 'approved' } })
  await controller.recover({ commandId: 'recover', runId: 'run' })
  const after = await controller.whenIdle('run')
  assert.equal(after.run.status, 'succeeded', JSON.stringify(after.nodes.map(node => [node.nodeId, node.waitReason])))
  assert.deepEqual(sends, operations['production-release'])
  assert.equal((await store.query({ kind: 'effect.list', runId: 'run' })).length, 4)
})
