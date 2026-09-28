import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { defineExecutionWorkflow, createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-message-'))
  let store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'message', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  t.after(() => store.close())
  await store.command({ id: 'create', kind: 'run.create', args: { runId: 'run', taskId: 'task', workflowId: 'message', workflowDigest: 'a'.repeat(64), requirementRef: 'requirement.json', nodes: [{ nodeId: 'send', nodeVersion: '1', executor: 'code', inputRef: 'input.json', inputDigest: 'b'.repeat(64) }] } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'send', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  let sends = 0, reads = 0
  const messageAdapter = {
    execute: async () => { sends++; return { status: 'unknown', reason: 'MESSAGE_READBACK_REQUIRED', result: { ack: { openTaskId: 'real-ack' } } } },
    reconcile: async (prepared, { previousObservation }) => { reads++; assert.equal(previousObservation.result.ack.openTaskId, 'real-ack'); return { status: 'succeeded', result: { messageId: 'observed-message' } } },
    ...overrides.messageAdapter,
  }
  const options = { store, artifacts, authorize: async () => ({ principalId: 'generic', authorizationRef: 'generic' }), messageAdapter,
    authorizeMessage: overrides.authorizeMessage ?? (async () => ({ principalId: 'host-bound-profile', authorizationRef: 'source-request' })) }
  const gateway = createExecutionDelivery(options)
  const request = key => ({ binding: { ...binding, taskId: 'task', requirementDigest: 'a'.repeat(64) }, action: 'message', prepared: { action: 'message', taskId: 'task', runId: 'run', nodeRunId: binding.nodeRunId, generation: 1, requirementDigest: 'a'.repeat(64), deliveryKey: key.repeat(64), resourceKey: `message:${key.repeat(64)}`, groupId: 'bound-group' } })
  return { get store() { return store }, gateway, options, request, counts: () => ({ sends, reads }), reopen: async () => {
    await store.close()
    store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'message' })
    options.store = store
    return createExecutionDelivery(options)
  } }
}

test('同节点多文件独立领取效果，重复与并发调用复用已核验结果', async t => {
  const f = await fixture(t)
  const first = await Promise.all([f.gateway.execute(f.request('c')), f.gateway.execute(f.request('c'))])
  const second = await f.gateway.execute(f.request('d'))
  assert.ok(first.every(e => e.state === 'succeeded'))
  assert.notEqual(first[0].effectId, second.effectId)
  await f.gateway.execute(f.request('c'))
  assert.deepEqual(f.counts(), { sends: 2, reads: 2 })
})

test('ACK先落账再回读，回读错误保留ACK，网关重建只对账', async t => {
  let reads = 0
  const f = await fixture(t, { messageAdapter: { reconcile: async (prepared, { previousObservation }) => {
    assert.equal(previousObservation.result.ack.openTaskId, 'real-ack')
    const effects = await f.store.query({ kind: 'effect.list', runId: 'run' })
    assert.equal(effects[0].state, 'unknown')
    assert.equal(effects[0].result.result.result.ack.openTaskId, 'real-ack')
    if (++reads === 1) throw Object.assign(new Error('read timed out'), { code: 'READ_TIMEOUT' })
    return { status: 'succeeded', result: { messageId: 'observed' } }
  } } })
  const unknown = await f.gateway.execute(f.request('c'))
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.result.result.result.ack.openTaskId, 'real-ack')
  assert.equal((await (await f.reopen()).execute(f.request('c'))).state, 'succeeded')
  assert.equal(f.counts().sends, 1)
})

test('没有ACK保持unknown且重复调用不重发', async t => {
  let sends = 0
  const f = await fixture(t, { messageAdapter: {
    execute: async () => { sends++; throw Object.assign(new Error('lost ack'), { code: 'LOST_ACK' }) },
    reconcile: async (prepared, { previousObservation }) => { assert.equal(previousObservation.result, undefined); return { status: 'unknown', reason: 'ACK_MISSING' } },
  } })
  assert.equal((await f.gateway.execute(f.request('c'))).state, 'unknown')
  assert.equal((await f.gateway.execute(f.request('c'))).state, 'unknown')
  assert.equal(sends, 1)
})

test('同Run换节点绑定复用原交付键，已成功或未知效果均不再次发送', async t => {
  for (const unknown of [false, true]) {
    const f = await fixture(t, unknown ? { messageAdapter: { reconcile: async () => ({ status: 'unknown', reason: 'WAITING' }) } } : {})
    const original = f.request('c')
    const before = await f.gateway.execute(original)
    const changed = { ...original, binding: { ...original.binding, nodeRunId: 'new-node-binding', generation: 2 },
      prepared: { ...original.prepared, nodeRunId: 'new-node-binding', generation: 2 } }
    const after = await f.gateway.execute(changed)
    assert.equal(after.effectId, before.effectId)
    assert.equal(after.state, unknown ? 'unknown' : 'succeeded')
    assert.equal(f.counts().sends, 1)
    assert.equal((await f.store.query({ kind: 'effect.list', runId: 'run' })).length, 1)
  }
})

test('专用Host授权必需，通用授权不能代替文件外发授权', async t => {
  const f = await fixture(t, { authorizeMessage: async () => null })
  await assert.rejects(f.gateway.execute(f.request('c')), { code: 'DELIVERY_NOT_AUTHORIZED' })
  assert.equal(f.counts().sends, 0)
})

test('任务、节点、群身份改变与非法清单键均被拒绝', async t => {
  const f = await fixture(t)
  for (const fields of [{ taskId: 'other' }, { nodeRunId: 'other' }, { deliveryKey: 'bad' }, { resourceKey: 'message:other' }])
    await assert.rejects(f.gateway.execute({ ...f.request('c'), prepared: { ...f.request('c').prepared, ...fields } }), { code: 'DELIVERY_INPUT_INVALID' })
  await f.gateway.execute(f.request('c'))
  await assert.rejects(f.gateway.execute({ ...f.request('c'), prepared: { ...f.request('c').prepared, groupId: 'other' } }), { code: 'DELIVERY_IDENTITY_CONFLICT' })
  assert.equal(f.counts().sends, 1)
})

test('明确发送失败保持失败终态，不重复调用发送或读回', async t => {
  let sends = 0
  const f = await fixture(t, { messageAdapter: { execute: async () => { sends++; return { status: 'failed', reason: 'REMOTE_REJECTED' } } } })
  assert.equal((await f.gateway.execute(f.request('c'))).state, 'failed')
  assert.equal((await f.gateway.execute(f.request('c'))).state, 'failed')
  assert.equal(sends, 1)
  assert.equal(f.counts().reads, 0)
})

for (const control of ['stop', 'input', 'revoke']) test(`${control}先落账阻止文件发送`, async t => {
  const f = await fixture(t)
  const operation = control === 'stop' ? { kind: 'run.stop', args: { runId: 'run', reason: 'test' } }
    : control === 'input' ? { kind: 'input.accept', args: { runId: 'run', inputId: 'changed', sourceKey: 'source', requirementRef: 'changed.json' } }
      : { kind: 'safety.revoke', args: { scope: 'run', key: 'run', reason: 'test' } }
  await f.store.command({ id: 'control', ...operation })
  await assert.rejects(f.gateway.execute(f.request('c')))
  assert.equal(f.counts().sends, 0)
})

test('message.send仅允许受信code节点，Agent不可申请且必须注册网关', () => {
  const node = { id: 'send', version: '1', executor: 'code', allowedEffects: ['message.send'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }
  assert.doesNotThrow(() => defineExecutionWorkflow({ id: 'message', version: '1', nodes: [node] }))
  assert.throws(() => defineExecutionWorkflow({ id: 'message', version: '1', nodes: [{ ...node, executor: 'agent' }] }), { code: 'EFFECT_NOT_ADMITTED' })
  assert.throws(() => createExecutionController({ workflows: [{ id: 'message', version: '1', nodes: [node] }] }), { code: 'DELIVERY_ADAPTER_REQUIRED' })
})

const fileReceipt = prepared => ({ status: 'succeeded', result: { taskId: prepared.taskId, deliveryKey: prepared.deliveryKey,
  groupId: prepared.groupId, conversationId: prepared.groupId, messageId: 'file-message', sha256: 'e'.repeat(64), size: 32 } })

test('文件出站只读投影精确绑定消息与群，引用关联真实任务来源', async t => {
  const f = await fixture(t, { messageAdapter: { reconcile: async prepared => fileReceipt(prepared) } })
  await f.store.command({ id: 'source', kind: 'message.receive', args: { runId: 'source-run', sourceKey: 'source-key', sourceVersion: 1,
    conversationId: 'bound-group', actorId: 'requester', body: '完成后发文件', context: { sourceMessageId: 'source-message' } } })
  await f.store.command({ id: 'split', kind: 'message.split', args: { runId: 'source-run', units: [{ unitId: 'source-unit' }] } })
  await f.store.command({ id: 'accept', kind: 'message.accept', args: { runId: 'source-run', unitId: 'source-unit', commands: [{ commandId: 'create-task', kind: 'create', args: { taskId: 'task' } }] } })
  await f.gateway.execute(f.request('c'))
  const outbound = await f.store.query({ kind: 'message.outboundByMessage', conversationId: 'bound-group', messageId: 'file-message' })
  assert.equal(outbound.kind, 'task-file')
  assert.equal(outbound.taskId, 'task')
  assert.equal(outbound.runId, 'source-run')
  assert.equal(outbound.payload.sourceMessageId, 'source-message')
  assert.deepEqual(await f.store.query({ kind: 'message.outboundIds', conversationId: 'bound-group' }), ['file-message'])
  assert.equal(await f.store.query({ kind: 'message.outboundByMessage', conversationId: 'other-group', messageId: 'file-message' }), null)
  assert.equal(await f.store.query({ kind: 'message.outboundByMessage', conversationId: 'bound-group', messageId: 'other-message' }), null)
  assert.deepEqual(await f.store.query({ kind: 'message.outboundIds', conversationId: 'other-group' }), [])
})

for (const invalid of ['unknown', 'group', 'task', 'delivery', 'digest', 'size']) test(`文件出站投影拒绝未验收或绑定不足：${invalid}`, async t => {
  const f = await fixture(t, { messageAdapter: { reconcile: async prepared => {
    if (invalid === 'unknown') return { status: 'unknown', result: { messageId: 'file-message' } }
    const observation = fileReceipt(prepared)
    if (invalid === 'group') observation.result.conversationId = 'other-group'
    if (invalid === 'task') observation.result.taskId = 'other-task'
    if (invalid === 'delivery') observation.result.deliveryKey = 'f'.repeat(64)
    if (invalid === 'digest') delete observation.result.sha256
    if (invalid === 'size') observation.result.size = -1
    return observation
  } } })
  await f.gateway.execute(f.request('c'))
  assert.equal(await f.store.query({ kind: 'message.outboundByMessage', conversationId: 'bound-group', messageId: 'file-message' }), null)
  assert.deepEqual(await f.store.query({ kind: 'message.outboundIds', conversationId: 'bound-group' }), [])
})

for (const invalid of [null, 'ack', 'group', 'task-id']) test(`精确已观察文件消息用于回声隔离，内容待核验保持pending：${invalid ?? 'valid'}`, async t => {
  const f = await fixture(t, { messageAdapter: { reconcile: async () => ({ status: 'unknown', reason: 'DOWNLOAD_PENDING', result: {
    ack: { sendReceipt: { openTaskId: 'real-ack' } }, sendMessageRef: { conversationId: invalid === 'group' ? 'foreign' : 'bound-group',
      messageId: 'pending-message', openTaskId: invalid === 'task-id' ? 'foreign-task' : 'real-ack' } } }) } })
  // 缺 ACK 的读回不得仅凭查询出的消息 ID 认领；它没有绑定真实发送身份。
  if (invalid === 'ack') f.options.messageAdapter.reconcile = async () => ({ status: 'unknown', result: {
    ack: { sendReceipt: { openTaskId: '' } }, sendMessageRef: { conversationId: 'bound-group', messageId: 'pending-message', openTaskId: 'real-ack' } } })
  await f.gateway.execute(f.request('c'))
  const outbound = await f.store.query({ kind: 'message.outboundByMessage', conversationId: 'bound-group', messageId: 'pending-message' })
  const ids = await f.store.query({ kind: 'message.outboundIds', conversationId: 'bound-group' })
  if (invalid) { assert.equal(outbound, null); assert.deepEqual(ids, []) }
  else { assert.equal(outbound.status, 'pending'); assert.equal(outbound.deliveredAt, null); assert.deepEqual(ids, ['pending-message']) }
})
