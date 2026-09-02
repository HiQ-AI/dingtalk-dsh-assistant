import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { normalizeHistoryMessage, parseRedlineDecision, startDwsBridge } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'

test('本人消息增量补拉默认每10秒执行并使用30秒重叠窗口', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/dws-bridge.js', import.meta.url), 'utf8')
  assert.match(source, /groupBackfillIntervalMs = 10_000/)
  assert.match(source, /groupBackfillOverlapMs = 30_000/)
})

test('DWS历史消息senderId映射为持久化发送人ID', () => {
  assert.equal(normalizeHistoryMessage({ conversationId: 'cid-a', messageId: 'm1', text: 'hello', createTime: '2026-08-24 10:00:00', sender: '张三', senderId: 'sender-1' }, 'cid-a').senderOpenDingTalkId, 'sender-1')
})

test('DWS历史消息保留引用消息上下文', () => {
  const normalized = normalizeHistoryMessage({ messageId: 'm-quote', text: 'reply', createTime: '2026-08-24 10:22:32', sender: '孙鹏', senderOpenDingTalkId: 'sender-1', quotedMessage: { messageId: 'm-source', sender: '向春梅', createTime: '2026-08-24 09:32:53', content: 'quoted text' } }, 'cid-a')
  assert.deepEqual(normalized.quotedMessage, { messageId: 'm-source', senderName: '向春梅', occurredAt: '2026-08-24 09:32:53', content: 'quoted text' })
})

test('DWS bridge 不额外查询引用详情并只保留事件已有的引用 ID', async () => {
  let onEvent
  let received
  const runtime = {
    listGroups: () => [{ groupId: 'cid-a', messages: [] }],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { received = message; return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription(_groupId, callback) { onEvent = callback; return { lifecycle: new EventEmitter(), done: Promise.resolve(undefined), stop() {} } },
    async readGroup() { throw new Error('引用消息不得触发额外查询') },
    async loadMessageImages() { return { images: [], mediaUnavailable: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} } })
  onEvent({ conversation_id: 'cid-a', message_id: 'm-reply', content: 'reply', event_time: '2026-08-25T05:32:10Z', quotedMessage: { messageId: 'm-source', content: '提示用户需要保存 @485388732 前面缓存草稿' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(received.quotedMessage.messageId, 'm-source')
  await stop()
})

test('DWS历史图片消息保留可下载资源引用', () => {
  const normalized = normalizeHistoryMessage({ messageId: 'm-image', text: '[图片消息](mediaId=media-1)', resourceRefs: [{ type: 'mediaId', resourceId: 'media-1' }] }, 'cid-a')
  assert.deepEqual(normalized.resourceRefs, [{ type: 'mediaId', resourceId: 'media-1' }])
})

test('DWS bridge 将稳定事件交给 resident 并在真实回读后确认 outbox', async () => {
  let onEvent
  let stopped = false
  let subscribedListener
  let outboxListener
  const acknowledged = []
  const runtime = {
    listGroups: () => [{ groupId: 'cid-a' }],
    onGroupSubscribed(listener) { subscribedListener = listener; return () => { subscribedListener = undefined } },
    onOutboxAppended(listener) { outboxListener = listener; return () => { outboxListener = undefined } },
    async ingest(message) {
      assert.deepEqual(message, { groupId: 'cid-a', messageId: 'm1', text: 'hello', occurredAt: '2026-08-24T13:00:00+08:00', senderName: '张三', senderOpenDingTalkId: 'od-user-1' })
      await outboxListener({ groupId: 'cid-a', outbound: { outboundId: 'out-1', sourceMessageId: 'm1', text: 'reply' } })
      return { duplicate: false, group: { messages: [{ messageId: 'm1' }], outbox: [{ outboundId: 'out-1', sourceMessageId: 'm1', text: 'reply' }] } }
    },
    async acknowledge(value) { acknowledged.push(value) },
  }
  let reads = 0
  const adapter = {
    startGroupSubscription(groupId, callback) {
      assert.equal(groupId, 'cid-a')
      onEvent = callback
      return { lifecycle: new EventEmitter(), done: Promise.resolve(), stop() { stopped = true } }
    },
    async readGroup() { reads += 1; return { complete: true, messages: reads === 1 ? [] : [{ messageId: 'sent-id', text: 'reply' }] } },
    async sendGroup() { return { deliveryStatus: 'success' } },
  }
  const warnings = []
  const stop = startDwsBridge({ runtime, adapter, logger: { warn: (error) => warnings.push(error) } })
  onEvent({ conversation_id: 'cid-a', message_id: 'm1', content: 'hello', event_time: '2026-08-24T13:00:00+08:00', sender: '张三', sender_open_dingtalk_id: 'od-user-1' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(acknowledged, [{ groupId: 'cid-a', outboundId: 'out-1', deliveredMessageId: 'sent-id' }])
  assert.equal(warnings.length, 0)
  assert.equal(typeof subscribedListener, 'function')
  await stop()
  assert.equal(stopped, true)
})

test('主会话回复首次无法确认时会绑定同一outbox持续回读并避免重复发送', async () => {
  const outbound = { outboundId: 'out-reply', sourceMessageId: 'msg-source', text: '主会话回复', status: 'pending', readbackRequired: true }
  const group = { groupId: 'cid-a', messages: [], outbox: [outbound] }
  const acknowledged = []
  const runtime = {
    listGroups: () => [group], getGroup: () => group,
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async acknowledge(value) { acknowledged.push(value); outbound.status = 'sent' },
  }
  let reads = 0
  let sends = 0
  const adapter = {
    startGroupSubscription() { return { lifecycle: new EventEmitter(), done: Promise.resolve(undefined), stop() {} } },
    async readGroup() {
      reads += 1
      return { complete: true, messages: reads >= 2 ? [{ messageId: 'sent-id', text: outbound.text }] : [] }
    },
    async sendGroup() { sends += 1; return { deliveryStatus: 'unknown' } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 5 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  await stop()
  assert.deepEqual(acknowledged, [{ groupId: 'cid-a', outboundId: 'out-reply', deliveredMessageId: 'sent-id' }])
  assert.equal(sends, 1, '重试前的历史回读命中后不得重复发送')
})

test('启动时先建立 live consumer 再补拉，重叠消息由持久 ingress 去重', async () => {
  const order = []
  const ingested = []
  let lifecycle
  const runtime = {
    listGroups: () => [{ groupId: 'cid-a', messages: [{ messageId: 'old' }] }],
    onGroupSubscribed() { return () => undefined },
    onOutboxAppended() { return () => undefined },
    async ingest(message) { ingested.push(message.messageId); return { duplicate: message.messageId === 'overlap' } },
    async acknowledge() {},
  }
  const adapter = {
    startGroupSubscription() { lifecycle = new EventEmitter(); order.push('live'); return { lifecycle, ready: new Promise(() => undefined), done: Promise.resolve(), stop() {} } },
    async readGroupRange() { order.push('backfill'); return { complete: true, hasMore: false, failedCount: 0, messages: [{ messageId: 'overlap', conversationId: 'cid-a', text: 'same', createTime: '2026-08-24T13:00:00+08:00', sender: '李四', senderOpenDingTalkId: 'od-user-2' }] } },
  }
  const warnings = []
  const stop = startDwsBridge({ runtime, adapter, logger: { warn: (error) => warnings.push(error) } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['live'])
  lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(order, ['live', 'backfill'])
  assert.deepEqual(ingested, ['overlap'])
  assert.equal(warnings.length, 0)
  await stop()
})

test('定时增量补拉可接收本人消息并在附件处理前按持久 messageId 去重', async () => {
  const group = { groupId: 'cid-a', messages: [{ messageId: 'old', occurredAt: '2026-08-25T05:00:00Z' }] }
  const ingested = []
  let mediaLoads = 0
  let rangeReads = 0
  const runtime = {
    listGroups: () => [group], getGroup: () => group,
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { ingested.push(message.messageId); group.messages.push(message); return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription() { return { lifecycle: new EventEmitter(), done: Promise.resolve(undefined), stop() {} } },
    async readGroup() { return { complete: true, messages: [] } },
    async readGroupRange(_groupId, range) {
      rangeReads += 1
      const latest = Math.max(...group.messages.map((message) => new Date(message.occurredAt).valueOf()))
      assert.equal(new Date(range.start).valueOf(), latest - 30_000)
      return { complete: true, messages: [{ conversationId: 'cid-a', messageId: 'm-self', text: '本人消息', createTime: '2026-08-25T05:01:00Z', sender: '当前登录人', senderId: 'self-id' }] }
    },
    async loadMessageImages() { mediaLoads += 1; return { images: [], mediaUnavailable: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 5 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  await stop()
  assert.ok(rangeReads >= 2)
  assert.deepEqual(ingested, ['m-self'])
  assert.equal(mediaLoads, 1)
})

test('定时增量补拉按已持久化发送消息ID过滤Agent本人账号消息', async () => {
  const group = { groupId: 'cid-a', messages: [], outbox: [{ outboundId: 'out-1', sourceMessageId: 'source-1', text: 'Agent回复', status: 'sent', deliveredMessageId: 'm-agent' }] }
  const ingested = []
  let imageLoads = 0
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined }, onHumanBlockerRequested() { return () => undefined },
    async ingest(message) { ingested.push(message.messageId); return { duplicate: false } },
  }
  let backfill
  let rangeReads = 0
  const adapter = {
    startGroupSubscription() { const lifecycle = new EventEmitter(); return { lifecycle, ready: Promise.resolve(), done: Promise.resolve(), stop() {} } },
    async readGroup() { return { complete: true, messages: [] } },
    async readGroupRange() {
      rangeReads += 1
      if (rangeReads === 1) return { complete: true, hasMore: false, failedCount: 0, messages: [] }
      return { complete: true, messages: [
        { conversationId: 'cid-a', messageId: 'm-agent', text: 'Agent回复', createTime: '2026-08-25T05:01:00Z', sender: '当前登录人' },
        { conversationId: 'cid-a', messageId: 'm-human', text: '本人手工消息', createTime: '2026-08-25T05:01:01Z', sender: '当前登录人' },
      ] }
    },
    async loadMessageImages() { imageLoads += 1; return { images: [], mediaUnavailable: [] } },
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = (callback) => { backfill = callback; return { unref() {} } }
  try {
    const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 1, outboxRetryIntervalMs: 0 })
    await backfill()
    assert.deepEqual(ingested, ['m-human'])
    assert.equal(imageLoads, 1, 'Agent发送消息应在附件下载前过滤')
    await stop()
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

test('增量补拉过滤已投递及判断失败消息，只重试插话前失败项和投递新项', async () => {
  const group = { groupId: 'cid-a', messages: [
    { messageId: 'm-delivered', occurredAt: '2026-08-27T04:00:00Z', agentDeliveryStatus: 'delivered' },
    { messageId: 'm-decision-failed', occurredAt: '2026-08-27T04:00:00Z', agentDeliveryStatus: 'decision-failed' },
    { messageId: 'm-failed', occurredAt: '2026-08-27T04:00:01Z', agentDeliveryStatus: 'failed' },
  ], outbox: [] }
  const ingested = []
  let rangeReads = 0
  const runtime = {
    listGroups: () => [group], getGroup: () => group,
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { ingested.push(message.messageId); return { duplicate: message.messageId === 'm-failed' } },
  }
  const adapter = {
    startGroupSubscription() { return { lifecycle: new EventEmitter(), done: Promise.resolve(undefined), stop() {} } },
    async readGroup() { return { complete: true, messages: [] } },
    async readGroupRange() {
      rangeReads += 1
      return { complete: true, messages: [
        { conversationId: 'cid-a', messageId: 'm-delivered', text: '已投递', createTime: '2026-08-27T04:00:00Z', sender: '甲' },
        { conversationId: 'cid-a', messageId: 'm-decision-failed', text: '判断失败', createTime: '2026-08-27T04:00:00Z', sender: '甲' },
        { conversationId: 'cid-a', messageId: 'm-failed', text: '失败重试', createTime: '2026-08-27T04:00:01Z', sender: '乙' },
        { conversationId: 'cid-a', messageId: 'm-new', text: '新消息', createTime: '2026-08-27T04:00:02Z', sender: '丙' },
      ] }
    },
    async loadMessageImages() { return { images: [], mediaUnavailable: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 5 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await stop()
  assert.ok(rangeReads > 0)
  assert.ok(!ingested.includes('m-delivered'))
  assert.ok(!ingested.includes('m-decision-failed'))
  assert.ok(ingested.includes('m-failed'))
  assert.ok(ingested.includes('m-new'))
})

test('补拉命中当前账号的pending outbox时先确认发送并修正历史失败状态', async () => {
  const outbound = { outboundId: 'out-pending', sourceMessageId: 'source-1', text: 'Agent回复\n\n- 小小鹏代回', status: 'pending' }
  const message = { messageId: 'm-agent', text: 'Agent回复  - 小小鹏代回', senderName: '孙鹏', agentDeliveryStatus: 'failed' }
  const group = { groupId: 'cid-a', messages: [message], outbox: [outbound] }
  const acknowledged = [], marked = [], ingested = []
  let backfill
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined }, onHumanBlockerRequested() { return () => undefined },
    async acknowledge(value) { acknowledged.push(value); Object.assign(outbound, { status: 'sent', deliveredMessageId: value.deliveredMessageId }) },
    async markMessageAgentDelivery(value) { marked.push(value); message.agentDeliveryStatus = value.status },
    async ingest(value) { ingested.push(value.messageId); return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription() { return { lifecycle: new EventEmitter(), ready: Promise.resolve(), done: Promise.resolve(), stop() {} } },
    async readGroup() { return { complete: true, messages: [] } },
    async readGroupRange() { return { complete: true, messages: [{ conversationId: 'cid-a', messageId: 'm-agent', text: 'Agent回复  - 小小鹏代回', createTime: '2026-08-26T03:28:22Z', sender: '孙鹏' }] } },
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = (callback) => { backfill = callback; return { unref() {} } }
  try {
    const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, currentDwsUserName: '孙鹏', humanPollIntervalMs: 0, groupBackfillIntervalMs: 1, outboxRetryIntervalMs: 0 })
    await backfill()
    assert.deepEqual(acknowledged, [{ groupId: 'cid-a', outboundId: 'out-pending', deliveredMessageId: 'm-agent' }])
    assert.deepEqual(marked, [{ groupId: 'cid-a', messageId: 'm-agent', status: 'skipped' }])
    assert.deepEqual(ingested, [])
    await stop()
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

test('DWS consumer 异常退出只记录活动 Task 告警', async () => {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const alerts = []
  const runtime = {
    listGroups: () => [{ groupId: 'cid-a', messages: [] }],
    onGroupSubscribed() { return () => undefined },
    onOutboxAppended() { return () => undefined },
    listTasks: () => [{ taskId: 'task-running', groupId: 'cid-a', state: 'running' }, { taskId: 'task-done', groupId: 'cid-a', state: 'completed' }],
    async reportCarrierIssue(value) { alerts.push(value) },
  }
  const adapter = { startGroupSubscription() { return { lifecycle: new EventEmitter(), done, stop() {} } } }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} } })
  resolveDone({ exitCode: 7, signal: null })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(alerts, [{ taskId: 'task-running', fingerprint: 'dws-consumer-exit:7:none', detail: 'DWS consumer exited for group cid-a' }])
  await stop()
})

test('没有订阅群时 bridge 也会发布初始健康状态', async () => {
  let health
  const runtime = {
    listGroups: () => [], listTasks: () => [],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
  }
  const stop = startDwsBridge({ runtime, adapter: {}, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, onHealthChange: (value) => { health = value } })
  assert.deepEqual(health, { healthy: true, groups: [] })
  await stop()
})

test('无活动Task时 DWS listener 退出也会重连并恢复入站健康', async () => {
  const group = { groupId: 'cid-a', messages: [], outbox: [] }
  const listeners = []
  const received = []
  const warnings = []
  let health
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { received.push(message.messageId); group.messages.push(message); return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription(_groupId, callback) {
      const lifecycle = new EventEmitter()
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const listener = { callback, lifecycle, resolveDone, stopped: false }
      listener.subscription = { lifecycle, ready: new Promise(() => undefined), done, stop() { listener.stopped = true; resolveDone(undefined) } }
      listeners.push(listener)
      return listener.subscription
    },
    async readGroupRange() { return { complete: true, hasMore: false, failedCount: 0, messages: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn: (error) => warnings.push(error) }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, listenerReconnectBaseMs: 0, listenerReconnectMaxMs: 0, listenerReadyTimeoutMs: 0, onHealthChange: (value) => { health = value } })
  await new Promise((resolve) => setImmediate(resolve))
  listeners[0].lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(health.healthy, true)

  listeners[0].resolveDone({ exitCode: 7, signal: null })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(listeners.length, 2)
  assert.equal(health.healthy, false)
  assert.equal(health.groups[0].listener.state, 'starting')

  listeners[1].lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(health.healthy, true)
  await listeners[1].callback({ conversation_id: 'cid-a', message_id: 'm-after-reconnect', content: '恢复后消息', event_time: '2026-09-02T10:00:00Z', sender: '李四', sender_open_dingtalk_id: 'od-user-2' })
  assert.deepEqual(received, ['m-after-reconnect'])

  await stop()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(listeners.length, 2, 'stop 后不得复活新的 listener')
  assert.equal(warnings.length, 0)
})

test('DWS listener 的 done 拒绝会重连，并在告警落盘后关闭 carrier 告警', async () => {
  const group = { groupId: 'cid-a', messages: [] }
  const listeners = []
  const reports = []
  const resolutions = []
  let releaseReport
  let health
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [{ taskId: 'task-running', groupId: 'cid-a', state: 'running' }],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async reportCarrierIssue(value) { reports.push(value); await new Promise((resolve) => { releaseReport = resolve }) },
    async resolveGroupCarrierIssues(value) { resolutions.push(value) },
  }
  const adapter = {
    startGroupSubscription() {
      const lifecycle = new EventEmitter()
      let resolveDone
      let rejectDone
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
      const listener = { lifecycle, rejectDone, stopped: false }
      listener.subscription = { lifecycle, ready: new Promise(() => undefined), done, stop() { listener.stopped = true; resolveDone(undefined) } }
      listeners.push(listener)
      return listener.subscription
    },
    async readGroupRange() { return { complete: true, hasMore: false, failedCount: 0, messages: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, listenerReconnectBaseMs: 0, listenerReconnectMaxMs: 0, listenerReadyTimeoutMs: 0, onHealthChange: (value) => { health = value } })
  await new Promise((resolve) => setImmediate(resolve))
  listeners[0].lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(health.healthy, true)
  resolutions.length = 0

  listeners[0].rejectDone(new Error('dws_spawn_pipe_closed'))
  for (let attempts = 0; attempts < 20 && listeners.length < 2; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(listeners.length, 2)
  for (let attempts = 0; attempts < 20 && reports.length === 0; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(reports.length, 1)
  listeners[1].lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolutions.length, 0, '恢复必须等待失败告警落盘，避免先恢复后记录告警')
  releaseReport()
  for (let attempts = 0; attempts < 20 && resolutions.length === 0; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.deepEqual(resolutions, [{ groupId: 'cid-a' }])
  assert.equal(health.healthy, true)
  await stop()
})

test('listener 在旧恢复执行中再次失败时，新 carrier 告警保持活动', async () => {
  const group = { groupId: 'cid-a', messages: [] }
  const listeners = []
  const events = []
  let alertStatus = 'active'
  let releaseResolution
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [{ taskId: 'task-running', groupId: 'cid-a', state: 'running' }],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async resolveGroupCarrierIssues() { events.push('resolve'); await new Promise((resolve) => { releaseResolution = resolve }); alertStatus = 'resolved' },
    async reportCarrierIssue() { events.push('report'); alertStatus = 'active' },
  }
  const adapter = {
    startGroupSubscription() {
      const lifecycle = new EventEmitter()
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const listener = { lifecycle, resolveDone, stopped: false }
      listener.subscription = { lifecycle, ready: new Promise(() => undefined), done, stop() { listener.stopped = true; resolveDone(undefined) } }
      listeners.push(listener)
      return listener.subscription
    },
    async readGroupRange() { return { complete: true, hasMore: false, failedCount: 0, messages: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, listenerReconnectBaseMs: 0, listenerReconnectMaxMs: 0, listenerReadyTimeoutMs: 0 })
  listeners[0].lifecycle.emit('ready')
  for (let attempts = 0; attempts < 20 && events.length === 0; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.deepEqual(events, ['resolve'])

  listeners[0].resolveDone({ exitCode: 7, signal: null })
  for (let attempts = 0; attempts < 20 && listeners.length < 2; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(events.includes('report'), false)
  releaseResolution()
  for (let attempts = 0; attempts < 20 && events.length < 2; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.deepEqual(events, ['resolve', 'report'])
  assert.equal(alertStatus, 'active')
  await stop()
})

test('listener 未收到 ready 时超时重连，旧 generation 不得阻塞新订阅', async () => {
  const group = { groupId: 'cid-a', messages: [] }
  const listeners = []
  const received = []
  let health
  const runtime = {
    listGroups: () => [group], getGroup: () => group, listTasks: () => [],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { received.push(message.messageId); return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription(_groupId, callback) {
      const lifecycle = new EventEmitter()
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const listener = { callback, lifecycle, resolveDone, stopped: false }
      listener.subscription = { lifecycle, ready: new Promise(() => undefined), done, stop() { listener.stopped = true; resolveDone(undefined) } }
      listeners.push(listener)
      return listener.subscription
    },
    async readGroupRange() { return { complete: true, hasMore: false, failedCount: 0, messages: [] } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0, listenerReconnectBaseMs: 0, listenerReconnectMaxMs: 0, listenerReadyTimeoutMs: 30, onHealthChange: (value) => { health = value } })
  for (let attempts = 0; attempts < 40 && listeners.length < 2; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(listeners.length, 2)
  assert.equal(listeners[0].stopped, true)
  listeners[0].lifecycle.emit('ready')
  await listeners[0].callback({ conversation_id: 'cid-a', message_id: 'm-old-generation', content: '旧订阅事件', event_time: '2026-09-02T10:00:00Z', sender: '甲' })
  assert.equal(health.healthy, false)
  assert.deepEqual(received, [])
  listeners[1].lifecycle.emit('ready')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(health.healthy, true)
  await stop()
})

test('单群补拉失败不会饿死其他群，下一轮成功后恢复健康', async () => {
  const groups = [{ groupId: 'cid-a', messages: [] }, { groupId: 'cid-b', messages: [] }]
  let aFails = true
  let backfill
  let health
  const ingested = []
  const runtime = {
    listGroups: () => groups,
    getGroup: (groupId) => groups.find((group) => group.groupId === groupId),
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    async ingest(message) { ingested.push(message.messageId); this.getGroup(message.groupId).messages.push(message); return { duplicate: false } },
  }
  const adapter = {
    startGroupSubscription() { return { lifecycle: new EventEmitter(), done: Promise.resolve(undefined), stop() {} } },
    async readGroupRange(groupId) {
      if (groupId === 'cid-a' && aFails) throw new Error('dws_backfill_partial:cid-a')
      if (groupId === 'cid-a') return { complete: true, hasMore: false, failedCount: 0, messages: [{ conversationId: 'cid-a', messageId: 'm-a', text: 'A恢复', createTime: '2026-09-02T10:01:00Z', sender: '甲' }] }
      return { complete: true, hasMore: false, failedCount: 0, messages: groups[1].messages.length === 0 ? [{ conversationId: 'cid-b', messageId: 'm-b', text: 'B正常', createTime: '2026-09-02T10:01:01Z', sender: '乙' }] : [] }
    },
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = (callback) => { backfill = callback; return { unref() {} } }
  try {
    const stop = startDwsBridge({ runtime, adapter, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 1, outboxRetryIntervalMs: 0, onHealthChange: (value) => { health = value } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(ingested.includes('m-b'))
    assert.equal(health.healthy, false)
    assert.equal(health.groups.find((item) => item.groupId === 'cid-a').backfill.state, 'failed')

    aFails = false
    await backfill()
    assert.ok(ingested.includes('m-a'))
    assert.equal(health.healthy, true)
    await stop()
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

test('本人私聊阻塞不设超时并只用引用消息恢复原Task', async () => {
  const task = { taskId: 'task-human', state: 'waiting', waitingKind: 'human-intervention', objective: 'fix issue', waitingReason: 'disk full', result: { risk: '写入可能失败并遗留不完整产物', evidence: ['0 bytes free'], attemptedActions: ['removed task temp'] }, humanBlocker: { requestId: 'blocker-1', category: 'disk', requestedAction: 'confirm cleanup plan', status: 'pending-send' } }
  let blockerListener
  const resolutions = []
  const runtime = {
    listGroups: () => [], listTasks: () => [task],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined },
    onHumanBlockerRequested(listener) { blockerListener = listener; return () => { blockerListener = undefined } },
    async recordHumanBlockerDelivery(value) { Object.assign(task.humanBlocker, { status: 'waiting-reply', conversationId: value.conversationId, messageId: value.messageId, openTaskId: value.openTaskId, formatVersion: value.formatVersion, sentAt: new Date().toISOString() }) },
    async resolveHumanBlocker(value) { resolutions.push(value); task.state = 'running' },
  }
  let reads = 0
  const adapter = {
    async sendSelf(request) { assert.match(request.text, /【风险】\n写入可能失败并遗留不完整产物/); return { openTaskId: 'open-task-1', conversationId: 'self-conversation', messageId: 'blocker-message' } },
    async readConversation() { reads += 1; return reads === 1 ? [] : [{ messageId: 'reply-message', text: '按方案清理', quotedMessage: { messageId: 'blocker-message' } }] },
  }
  const warnings = []
  const stop = startDwsBridge({ runtime, adapter, logger: { warn: (error) => warnings.push(error) }, humanUserId: 'self-user', humanPollIntervalMs: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(task.humanBlocker.status, 'waiting-reply')
  assert.equal(task.state, 'waiting', '没有引用回复时必须无限期保持等待')
  blockerListener()
  await new Promise((resolve) => setImmediate(resolve))
  blockerListener()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolutions.length, 1)
  assert.equal(resolutions[0].quotedMessageId, 'blocker-message')
  assert.equal(warnings.length, 0)
  await stop()
})

test('阻塞单已真实发送并获引用批准时自动补记投递并恢复原Task', async () => {
  const task = { taskId: 'task-human', state: 'waiting', waitingKind: 'human-intervention', objective: 'release', waitingReason: 'redline', result: {}, humanBlocker: { requestId: 'blocker-1', category: 'redline', requestedAction: 'approve release', status: 'pending-send' } }
  const deliveries = [], resolutions = []
  const runtime = {
    listGroups: () => [], listTasks: () => [task],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined }, onHumanBlockerRequested() { return () => undefined },
    async recordHumanBlockerDelivery(value) { deliveries.push(value); Object.assign(task.humanBlocker, { status: 'waiting-reply', conversationId: value.conversationId, messageId: value.messageId, formatVersion: value.formatVersion }) },
    async resolveHumanBlocker(value) { resolutions.push(value); task.state = 'running' },
  }
  const adapter = {
    async findHumanBlockerExchange() { return { conversationId: 'self-cid', messageId: 'request-msg', sentAt: '2026-08-25 15:25:22', replyMessageId: 'reply-msg', reply: '批准' } },
    async sendSelf() { throw new Error('已有申请时不得重复发送') },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanUserId: 'self-user', humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  await stop()
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].sentAt, '2026-08-25 15:25:22')
  assert.deepEqual(resolutions, [{ taskId: 'task-human', requestId: 'blocker-1', quotedMessageId: 'request-msg', replyMessageId: 'reply-msg', reply: '批准', decision: 'approved' }])
  assert.equal(task.state, 'running')
})

test('已补记错误恢复时间的阻塞单会改用原申请时间回读批准', async () => {
  const task = { taskId: 'task-human', state: 'waiting', waitingKind: 'human-intervention', objective: 'release', waitingReason: 'redline', result: {}, humanBlocker: { requestId: 'blocker-1', category: 'redline', requestedAction: 'approve release', status: 'waiting-reply', conversationId: 'self-cid', messageId: 'request-msg', sentAt: '2026-08-25T07:36:02Z', formatVersion: 3 } }
  const deliveries = [], resolutions = []
  const runtime = {
    listGroups: () => [], listTasks: () => [task],
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined }, onHumanBlockerRequested() { return () => undefined },
    async recordHumanBlockerDelivery(value) { deliveries.push(value); task.humanBlocker.sentAt = value.sentAt },
    async resolveHumanBlocker(value) { resolutions.push(value); task.state = 'running' },
  }
  const adapter = {
    async findHumanBlockerExchange() { return { conversationId: 'self-cid', messageId: 'request-msg', sentAt: '2026-08-25 15:25:22' } },
    async readConversation(_conversationId, range) {
      assert.equal(range.start, '2026-08-25 15:25:22')
      return [{ messageId: 'reply-msg', text: '批准', quotedMessage: { messageId: 'request-msg' } }]
    },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanUserId: 'self-user', humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  await stop()
  assert.equal(deliveries[0].sentAt, '2026-08-25 15:25:22')
  assert.equal(resolutions[0].decision, 'approved')
  assert.equal(task.state, 'running')
})

test('redline 阻塞只接受引用消息中的明确批准或拒绝', () => {
  assert.equal(parseRedlineDecision('批准'), 'approved')
  assert.equal(parseRedlineDecision('批准：做好回滚机制'), 'approved')
  assert.equal(parseRedlineDecision('拒绝，风险过高'), 'rejected')
  assert.equal(parseRedlineDecision('先等等'), undefined)
})

test('Web在DWS发送过程中批复时撤回已落地申请并停止等待', async () => {
  const task = { taskId: 'task-race', state: 'waiting', waitingKind: 'human-intervention', objective: '发布受控版本', waitingReason: '等待授权', result: { risk: '生产风险', evidence: ['范围已核验'], attemptedActions: [] }, humanBlocker: { requestId: 'blocker-race', category: 'redline', requestedAction: '仅发布版本v1', status: 'pending-send' } }
  let decisionListener
  const recalled = []
  const runtime = {
    listGroups: () => [], listTasks: () => [task], getTask: () => task,
    listAuthorizationRequests: () => [{ ...task.humanBlocker, taskId: task.taskId }],
    getAuthorizationRequest: () => ({ ...task.humanBlocker, taskId: task.taskId }),
    onGroupSubscribed() { return () => undefined }, onOutboxAppended() { return () => undefined }, onHumanBlockerRequested() { return () => undefined },
    onAuthorizationDecided(listener) { decisionListener = listener; return () => { decisionListener = undefined } },
    async recordHumanBlockerDelivery(value) { Object.assign(task.humanBlocker, { messageId: value.messageId, conversationId: value.conversationId, status: task.humanBlocker.status === 'answered' ? 'answered' : 'waiting-reply', recallStatus: task.humanBlocker.status === 'answered' ? 'pending' : undefined }) },
    async recordAuthorizationRecall({ status }) { task.humanBlocker.recallStatus = status },
  }
  const adapter = {
    async findHumanBlockerExchange() { return undefined },
    async sendSelf() {
      Object.assign(task, { state: 'running', waitingKind: undefined })
      Object.assign(task.humanBlocker, { status: 'answered', decision: 'approved', decisionSource: 'web', reply: '页面批准' })
      decisionListener({ authorization: { ...task.humanBlocker, taskId: task.taskId }, task })
      return { openTaskId: 'open-race', conversationId: 'self-race', messageId: 'message-race' }
    },
    async recallMessage(messageId) { recalled.push(messageId); return { recalled: true } },
  }
  const stop = startDwsBridge({ runtime, adapter, logger: { warn(error) { throw error } }, humanUserId: 'self-user', humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  await stop()
  assert.deepEqual(recalled, ['message-race'])
  assert.equal(task.humanBlocker.recallStatus, 'recalled')
})
