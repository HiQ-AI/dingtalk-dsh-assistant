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
import { createReleaseTaskWorkflow, releaseWorkflowKinds } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'

const commitSha = 'a'.repeat(40)
const operations = {
  'uat-delivery': ['integrate', 'build'], 'production-release': ['merge-main', 'tag', 'build'], 'uat-rebuild': ['rebuild'],
}
const phases = {
  'uat-delivery': ['preflight', 'integrated', 'built', 'runtime'],
  'production-release': ['preflight', 'merged', 'tagged', 'built', 'runtime'],
  'uat-rebuild': ['preflight', 'built', 'runtime'],
}
const requirement = kind => ({ request: '按精确提交完成交付', target: {
  repository: 'hiq/repo', environment: kind === 'production-release' ? 'production' : 'uat',
  service: 'dataset-web', commitSha, runbookId: 'runbook-v1',
}, constraints: [], evidenceRefs: ['source:1'] })
const preflight = {
  localE2ePassed: true, developmentPrVerified: true, uatPrVerified: true, sourcePackageSupported: true,
  equivalentBuildAbsent: true, releaseSetVerified: true, uatAccepted: true, productionBaselineVerified: true,
  dependencyOrderVerified: true, rollbackBoundaryVerified: true, failurePipelineVerified: true,
  branchHeadMatches: true, noNewerRuntimeVersion: true,
}
const runtime = { sourceSha: commitSha, registryDigest: 'sha256:digest', runtimeDigest: 'sha256:digest',
  observedGeneration: '12', ready: true, entryAccessible: true }

function adapterFor(kind, overrides = {}) {
  const seen = { phases: [], operations: [] }
  return { id: 'synthetic-release', version: '1', rulesDigest: 'b'.repeat(64), seen,
    async inspect({ phase, requirement: input, effect }) {
      seen.phases.push(phase)
      return { phase, targetDigest: executionDigest(input.target), status: 'confirmed',
        evidenceRefs: [`readback:${phase}`], facts: phase === 'preflight' ? { ...preflight, ...overrides.preflight }
          : { ...(phase === 'runtime' ? { ...runtime, ...overrides.runtime } : { stage: phase }),
            operationKey: effect.prepared.operationKey, receiptDigest: executionDigest(effect.receipt) } }
    },
    async prepareOperation({ kind: actualKind, operation, requirement: input, observation,
      runId, generation, requirementDigest, expected }) {
      assert.equal(actualKind, kind)
      seen.operations.push(operation)
      return { action: 'external', workflowKind: kind, operation, runId, generation, requirementDigest,
        resourceKey: `external:${input.target.environment}:${input.target.repository}:${input.target.service}`,
        targetDigest: executionDigest(input.target), expected: { ...expected, ...overrides.expected },
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
    return { state: 'succeeded', result: { result: { operation: prepared.operation, status: 'accepted' } } }
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
  assert.equal(result.status, 'technical-delivery-confirmed')
  assert.equal(result.commitSha, commitSha)
})

test('无 Host adapter 拒绝注册；生产预检缺正式 UAT 结论不发生副作用', async t => {
  assert.throws(() => createReleaseTaskWorkflow({ kind: 'production-release' }), { code: 'RELEASE_ADAPTER_REQUIRED' })
  const adapter = adapterFor('production-release', { preflight: { uatAccepted: false } })
  const { controller, calls } = await harness(t, 'production-release', adapter)
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes[1].waitReason.reference, 'RELEASE_REQUIRED_FACT_MISSING')
  assert.deepEqual(calls, [])
})

test('UAT 运行版本和制品不一致时停留在回读节点，不声明交付', async t => {
  const adapter = adapterFor('uat-rebuild', { runtime: { runtimeDigest: 'sha256:other' } })
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
  assert.deepEqual(calls, ['merge-main'])
})

test('生产流程经真实效果账等待 Web 审批，批准后同一精确动作只发送一次', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-gateway-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'release-gateway', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  const adapter = adapterFor('production-release')
  const sends = []
  const externalAdapter = { async execute(prepared) {
    sends.push(prepared.operation)
    return { status: 'succeeded', evidenceRef: `effect:${prepared.operation}` }
  }, async reconcile(prepared) { return { status: 'succeeded', evidenceRef: `effect:${prepared.operation}` } } }
  const delivery = createExecutionDelivery({ store, artifacts, externalAdapter,
    authorize: async () => ({ principalId: 'host', authorizationRef: 'unused' }),
    authorizeExternal: async ({ prepared }) => prepared.operation === 'merge-main'
      ? { principalId: 'owner', approval: { requestId: 'release-approval', approverIds: ['owner'] } }
      : { principalId: 'owner', authorizationRef: `approved-scope:${prepared.operation}` },
  })
  const workflow = createReleaseTaskWorkflow({ kind: 'production-release', adapter })
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id, input: requirement('production-release') })
  const before = await controller.whenIdle('run')
  assert.equal(before.run.status, 'waiting')
  assert.equal(before.nodes.find(node => node.nodeId === 'execute-merge-main').waitReason.reference, 'effect_approval_required')
  assert.deepEqual(sends, [])
  const held = (await store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(held.state, 'prepared')
  assert.equal(held.requestId, 'release-approval')
  await store.command({ id: 'approve', kind: 'approval.decide', args: { requestId: 'release-approval', actorId: 'owner', source: 'web', decision: 'approved' } })
  await controller.recover({ commandId: 'recover', runId: 'run' })
  const after = await controller.whenIdle('run')
  assert.equal(after.run.status, 'succeeded', JSON.stringify(after.nodes.map(node => [node.nodeId, node.waitReason])))
  assert.deepEqual(sends, operations['production-release'])
  assert.equal((await store.query({ kind: 'effect.list', runId: 'run' })).length, 3)
})
