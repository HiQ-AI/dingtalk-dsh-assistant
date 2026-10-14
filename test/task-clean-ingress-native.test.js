import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { startDwsBridge, normalizeHistoryMessage } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'

const epoch = '2026-10-13T14:00:00.000Z'
test('clean ingress gates listener-ready history and raw missing timestamps before model, materials and legacy dedup', { timeout: 15000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-clean-ingress-'))
  let h, stop, modelCalls = 0, downloads = 0, callback, lifecycle
  const receipts = [], warnings = []
  t.after(async () => { await stop?.(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  const decide = async request => {
    modelCalls++
    const input = latestInput(request)
    return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, units: [], ignoredRefs: [{ quote: message.text, reason: '日常闲聊，无具体事项' }] })) } }]
  }
  h = await nativeTaskHost(root, decide, { config: { ingressEpoch: epoch, assistantActorId: 'native-assistant' } })
  const runtime = {
    isTaskSessionMode: () => true,
    listGroups: () => [{ groupId: 'native-group' }],
    getGroup: () => ({ groupId: 'native-group', messages: [{ messageId: 'fresh' }], outbox: [] }),
    onGroupSubscribed: () => () => {}, onOutboxAppended: () => () => {},
    async ingest(message) { const receipt = await h.service.ingest(JSON.parse(JSON.stringify(message))); receipts.push({ id: message.messageId, ...receipt }); return receipt },
  }
  const adapter = {
    startGroupSubscription(_id, handler) { callback = handler; lifecycle = new EventEmitter(); const done = Promise.withResolvers(); return { lifecycle, ready: new Promise(() => {}), done: done.promise, stop() { done.resolve() } } },
    async loadMessageImages() { downloads++; throw new Error('early download forbidden') },
    async readGroupRange() { return { complete: true, hasMore: false, failedCount: 0, messages: [
      { messageId: 'old', createTime: '2026-10-13 21:59:59', senderId: 'native-user', text: 'old work' },
      { messageId: 'missing', senderId: 'native-user', text: 'old work without timestamp' },
    ] } },
  }
  stop = startDwsBridge({ runtime, adapter, logger: { warn: value => warnings.push(value) }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0 })
  lifecycle.emit('ready')
  await waitUntil(() => receipts.length === 2, 'ready backfill processed')
  assert.deepEqual(receipts.map(r => [r.id, r.processing, r.reason]).sort(), [['missing', 'quarantined', 'invalid-ingress-timestamp'], ['old', 'quarantined', 'before-ingress-epoch']])
  assert.equal(modelCalls, 0); assert.equal(downloads, 0)
  assert.equal((await h.query('source.list')).length, 0)
  const envelope = { conversation_id: 'native-group', message_id: 'fresh', sender_id: 'native-user', content: '早上好', timestamp: String(Date.parse(epoch)) }
  for (const [index, timestamp] of ['2026-10-14', '2026-11-31T15:00:00Z', '2026-10-13T24:00:00'].entries()) {
    await callback({ ...envelope, message_id: 'invalid-' + index, timestamp })
    assert.equal(receipts.at(-1).reason, 'invalid-ingress-timestamp')
  }
  await callback({ ...envelope, message_id: 'own-echo', sender_id: 'native-assistant' })
  assert.equal(receipts.at(-1).reason, 'own-notification')
  assert.equal(modelCalls, 0)
  await callback(envelope)
  await h.service.whenIdle()
  assert.equal(modelCalls, 1)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.residentStore.getGroup('native-group').messages.find(message => message.messageId === 'fresh').routingStatus, 'routed')
  assert.deepEqual(h.residentStore.listTopics('native-group'), [])
  await callback(envelope); await h.service.whenIdle()
  assert.equal(modelCalls, 1, 'same source must not classify twice')
  await stop(); stop = undefined; await h.close()
  h = await nativeTaskHost(root, decide, { initialize: false, config: { ingressEpoch: epoch, assistantActorId: 'native-assistant' } })
  const replay = await h.service.ingest(normalizeHistoryMessage({ messageId: 'old', createTime: '2026-10-13 21:59:59', senderId: 'native-user', text: 'old work' }, 'native-group'))
  assert.equal(replay.reason, 'before-ingress-epoch')
  await h.service.whenIdle(); assert.equal(modelCalls, 1)
  assert.equal((await h.query('task.list')).length, 0)
  assert.deepEqual(warnings, [])
})
