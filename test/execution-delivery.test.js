import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delivery-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'delivery', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  t.after(() => store.close())
  await store.command({ id: 'create', kind: 'run.create', args: { runId: 'run', taskId: 'task', workflowId: 'git', workflowDigest: 'a'.repeat(64), requirementRef: 'requirement.json', nodes: [{ nodeId: 'commit', nodeVersion: '1', executor: 'code', inputRef: 'input.json', inputDigest: 'b'.repeat(64) }] } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'commit', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  let sent = 0, authorized = 0
  const adapter = { executeCommit: async () => { sent++; return { status: 'succeeded', commitId: 'c'.repeat(40) } }, reconcileCommit: async () => ({ status: 'succeeded', commitId: 'c'.repeat(40) }), ...overrides.adapter }
  const authorize = overrides.authorize ?? (async () => { authorized++; return { principalId: 'synthetic', authorizationRef: 'task-grant' } })
  const gateway = createExecutionDelivery({ store, artifacts, adapter, authorize })
  const request = { binding: { ...binding, requirementDigest: 'a'.repeat(64) }, action: 'commit', prepared: { action: 'commit', generation: 1, requirementDigest: 'a'.repeat(64), repository: 'synthetic-repo', remote: 'synthetic-remote', ref: 'refs/heads/task', candidateDigest: 'd'.repeat(64) } }
  return { store, artifacts, gateway, request, counts: () => ({ sent, authorized }) }
}

test('效果网关同操作并发/重投只执行一次，授权不逐步骤重复索取', async t => {
  const f = await fixture(t)
  const results = await Promise.all([f.gateway.execute(f.request), f.gateway.execute(f.request)])
  assert.ok(results.every(r => r.state === 'succeeded'))
  await f.gateway.execute(f.request)
  assert.deepEqual(f.counts(), { sent: 1, authorized: 1 })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, candidateDigest: 'e'.repeat(64) } }), { code: 'DELIVERY_IDENTITY_CONFLICT' })
})

test('缺少授权和generation不符不调用写适配器', async t => {
  const f = await fixture(t, { authorize: async () => null })
  await assert.rejects(f.gateway.execute(f.request), { code: 'DELIVERY_NOT_AUTHORIZED' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, generation: 2 } }), { code: 'DELIVERY_INPUT_INVALID' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, requirementDigest: 'c'.repeat(64) } }), { code: 'DELIVERY_INPUT_INVALID' })
  assert.equal(f.counts().sent, 0)
})

for (const control of ['stop', 'input', 'revoke']) test(`${control}先提交阻止Git发送资格`, async t => {
  const f = await fixture(t)
  const operation = control === 'stop' ? { kind: 'run.stop', args: { runId: 'run', reason: 'synthetic' } }
    : control === 'input' ? { kind: 'input.accept', args: { runId: 'run', inputId: 'input', sourceKey: 'source', requirementRef: 'changed.json' } }
      : { kind: 'safety.revoke', args: { scope: 'run', key: 'run', reason: 'synthetic revoke' } }
  await f.store.command({ id: 'control', ...operation })
  await assert.rejects(f.gateway.execute(f.request))
  assert.equal(f.counts().sent, 0)
})

test('效果已发生但适配器回执丢失，只对账不重复发送', async t => {
  let sent = 0
  const f = await fixture(t, { adapter: { executeCommit: async () => { sent++; throw Object.assign(new Error('lost ACK'), { code: 'LOST_ACK' }) } } })
  const unknown = await f.gateway.execute(f.request)
  assert.equal(unknown.state, 'unknown')
  const recovered = await f.gateway.execute(f.request)
  assert.equal(recovered.state, 'succeeded')
  assert.equal(sent, 1)
})

test('Git能力仅给显式注册网关的受信code节点，Agent不能领取Git能力', () => {
  const node = { id: 'git', version: '1', executor: 'code', allowedEffects: ['git.commit'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }
  assert.throws(() => createExecutionController({ workflows: [{ id: 'git', version: '1', nodes: [node] }] }), { code: 'DELIVERY_ADAPTER_REQUIRED' })
  assert.throws(() => defineExecutionWorkflow({ id: 'git', version: '1', nodes: [{ ...node, executor: 'agent' }] }), { code: 'EFFECT_NOT_ADMITTED' })
})
