import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createReleaseTaskWorkflow, createLegacyReleaseTaskWorkflow, releaseWorkflowKinds } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'

const commitSha = 'a'.repeat(40)
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
    assert.equal(definition.digest, stable[kind])
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
