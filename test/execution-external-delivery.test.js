import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, { grant, execute, reconcile } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-external-delivery-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'external-test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  t.after(() => store.close())
  await store.command({ id: 'create', kind: 'run.create', args: {
    runId: 'run', taskId: 'task', workflowId: 'release', workflowDigest: 'a'.repeat(64), requirementRef: 'requirement',
    nodes: [{ nodeId: 'release', nodeVersion: '1', executor: 'code', inputRef: 'input', inputDigest: 'b'.repeat(64) }],
  } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: {
    runId: 'run', nodeId: 'release', expectedGeneration: 1, expectedLeaseEpoch: 0,
  } })
  let sends = 0
  const adapter = {
    execute: async prepared => { sends++; return execute ? execute(prepared) : { status: 'succeeded', evidenceRef: 'external-task-1' } },
    reconcile: reconcile ?? (async () => ({ status: 'succeeded', evidenceRef: 'external-task-1' })),
  }
  const gateway = createExecutionDelivery({ store, artifacts, authorize: async () => ({ principalId: 'owner', authorizationRef: 'old-git-only' }),
    externalAdapter: adapter, authorizeExternal: async () => grant ?? { principalId: 'owner', approval: { requestId: 'approval-1', approverIds: ['owner'] } },
  })
  const request = { binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared: {
    action: 'external', workflowKind: 'production-release', runId: 'run', generation: 1, requirementDigest: 'c'.repeat(64),
    resourceKey: 'external:production:service-a', targetCommit: 'd'.repeat(40),
  } }
  return { store, gateway, request, sends: () => sends }
}

test('外部效果只能给受信 code 节点，审批前零发送，Web 首次终态后只发送一次', async t => {
  const node = { id: 'release', version: '1', executor: 'code', allowedEffects: ['external.operation'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }
  assert.doesNotThrow(() => defineExecutionWorkflow({ id: 'release', version: '1', nodes: [node] }))
  assert.throws(() => defineExecutionWorkflow({ id: 'release', version: '1', nodes: [{ ...node, executor: 'agent' }] }), { code: 'EFFECT_NOT_ADMITTED' })
  const f = await fixture(t)
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_approval_required' })
  assert.equal(f.sends(), 0)
  const effect = (await f.store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(effect.state, 'prepared')
  assert.equal(effect.requestId, 'approval-1')
  await f.store.command({ id: 'approve', kind: 'approval.decide', args: { requestId: 'approval-1', actorId: 'owner', source: 'web', decision: 'approved' } })
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal(f.sends(), 1)
})

test('外部效果身份变化与撤权阻止发送', async t => {
  const f = await fixture(t, { grant: { principalId: 'owner', authorizationRef: 'exact-target-grant' } })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, runId: 'other' } }), { code: 'DELIVERY_INPUT_INVALID' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, resourceKey: 'workspace:unscoped' } }), { code: 'DELIVERY_INPUT_INVALID' })
  await f.store.command({ id: 'revoke', kind: 'safety.revoke', args: { scope: 'resource', key: f.request.prepared.resourceKey, reason: 'test' } })
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_safety_revoked' })
  assert.equal(f.sends(), 0)
})

test('外部回执未知时只回读，不二次执行', async t => {
  const f = await fixture(t, { grant: { principalId: 'owner', authorizationRef: 'exact-target-grant' },
    execute: async () => { throw new Error('lost ack') }, reconcile: async () => ({ status: 'succeeded', evidenceRef: 'readback-1' }) })
  assert.equal((await f.gateway.execute(f.request)).state, 'unknown')
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal(f.sends(), 1)
})
