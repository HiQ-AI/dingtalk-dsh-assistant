import assert from 'node:assert/strict'
import test from 'node:test'
import { createDwsAdapter, dispatchOutbox } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'

test('DWS adapter 默认禁用且不会调用 runner', async () => {
  let calls = 0
  const runner = { run: async () => { calls += 1 }, spawn: () => { calls += 1 } }
  const adapter = createDwsAdapter({ runner })
  await assert.rejects(() => adapter.readGroup('cid-a'), /dws_adapter_disabled/)
  assert.throws(() => adapter.startGroupSubscription('cid-a', () => {}), /dws_adapter_disabled/)
  assert.equal(calls, 0)
})

test('群监听等待 ready 后逐行交付且坏行不吞后续事件', async () => {
  let hooks
  const runner = { run: async () => undefined, spawn(args, value) { hooks = value; return { done: Promise.resolve(), terminate: (signal) => signal } } }
  const adapter = createDwsAdapter({ enabled: true, runner })
  const events = []
  const errors = []
  const subscription = adapter.startGroupSubscription('cid-a', (event) => events.push(event))
  subscription.lifecycle.on('line-error', (error) => errors.push(error.message))
  hooks.onStdoutLine('{"message_id":"early"}')
  hooks.onStderrLine('[event] ready event_key=user_im_message_receive_group bus_pid=1 subscribe_id=s1')
  hooks.onStdoutLine('not-json')
  hooks.onStdoutLine('{"message_id":"m1","conversation_id":"cid-a"}')

  assert.deepEqual(events.map((event) => event.message_id), ['m1'])
  assert.deepEqual(errors, ['dws_event_before_ready', 'Unexpected token \'o\', "not-json" is not valid JSON'])
  assert.equal(subscription.stop(), 'SIGTERM')
})

test('DWS profile固定附加到订阅、回读和发送命令', () => {
  const adapter = createDwsAdapter({ enabled: true, profile: 'corp:user', runner: { run: async () => undefined, spawn: () => undefined } })
  assert.deepEqual(adapter.compileGroupListen('cid-a').slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileGroupRead('cid-a').slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileGroupSend({ groupId: 'cid-a', text: 'reply', idempotencyKey: 'out-1' }).slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileSelfSend({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-1' }).slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileMessageRecall('message-1').slice(-2), ['--profile', 'corp:user'])
  const reply = adapter.compileGroupReply({ groupId: 'cid-a', text: 'done', idempotencyKey: 'out-2', replyToMessageId: 'm-source', replyToSenderOpenDingTalkId: 'od-requester', atOpenDingTalkIds: ['od-requester'] })
  assert.equal(reply.includes('--ref-msg-id'), true)
  assert.equal(reply.includes('--at-open-dingtalk-ids'), true)
})

test('Task完成通知使用DWS原生引用回复并@提出人', async () => {
  let reads = 0
  let request
  const adapter = {
    async readGroup() { reads += 1; return { complete: true, messages: reads === 1 ? [] : [{ messageId: 'done-id', text: 'done' }] } },
    async sendGroupReply(value) { request = value; return { deliveryStatus: 'success' } },
  }
  const result = await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-done', text: 'done', replyToMessageId: 'm-source', replyToSenderOpenDingTalkId: 'od-requester', atOpenDingTalkIds: ['od-requester'] } })
  assert.equal(result.status, 'sent')
  assert.deepEqual(request.atOpenDingTalkIds, ['od-requester'])
  assert.equal(request.replyToMessageId, 'm-source')
})

test('本人私聊发送通过openTaskId回查真实会话与消息ID', async () => {
  const calls = []
  const runner = { async run(args) { calls.push(args); return calls.length === 1
    ? { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open-task-1' } }) }
    : { exitCode: 0, stdout: JSON.stringify({ messageRef: { openConversationId: 'self-conversation', openMessageId: 'blocker-message' }, result: { sendStatus: 'SUCCESS' } }) } } }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner })
  assert.deepEqual(await adapter.sendSelf({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-1' }), { openTaskId: 'open-task-1', conversationId: 'self-conversation', messageId: 'blocker-message' })
  assert.equal(calls[0].includes('--yes'), true)
})

test('本人私聊发送等待DWS异步投递完成后再记录消息ID', async () => {
  let calls = 0
  const runner = { async run() {
    calls += 1
    if (calls === 1) return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open-task-delayed' } }) }
    if (calls === 2) return { exitCode: 0, stdout: JSON.stringify({ result: { sendStatus: 'PROCESSING' } }) }
    return { exitCode: 0, stdout: JSON.stringify({ messageRef: { openConversationId: 'self-conversation', openMessageId: 'delayed-message' }, result: { sendStatus: 'SUCCESS' } }) }
  } }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner })
  const result = await adapter.sendSelf({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-delayed' })
  assert.equal(calls, 3)
  assert.equal(result.messageId, 'delayed-message')
})

test('本人私聊回读限定起止时间但不设置消息条数上限', () => {
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => undefined, spawn: () => undefined } })
  const args = adapter.compileConversationRead('self-conversation', { start: '2026-08-24T10:00:00.000Z', end: '2026-08-24T18:00:00.000Z' })
  assert.equal(args.includes('--page-all'), true)
  assert.equal(args.includes('--max-items'), false)
  assert.equal(args.includes('--page-limit'), false)
})

test('outbox 回读命中跳过发送，未命中则只发一次并回读真实消息 ID', async () => {
  const existing = { readGroup: async () => ({ complete: true, messages: [{ messageId: 'existing-id', text: 'reply' }] }), sendGroup: async () => { throw new Error('must not send') } }
  assert.deepEqual(await dispatchOutbox({ adapter: existing, groupId: 'cid-a', outbound: { outboundId: 'out-1', text: 'reply' } }), { status: 'sent', messageId: 'existing-id', deduplicated: true })

  let reads = 0
  let sends = 0
  const fresh = {
    async readGroup() { reads += 1; return { complete: true, messages: reads === 1 ? [] : [{ messageId: 'real-id', text: 'reply' }] } },
    async sendGroup(request) { sends += 1; assert.equal(request.idempotencyKey, 'out-2'); return { deliveryStatus: 'success' } },
  }
  assert.deepEqual(await dispatchOutbox({ adapter: fresh, groupId: 'cid-a', outbound: { outboundId: 'out-2', text: 'reply' } }), { status: 'sent', messageId: 'real-id', deduplicated: false })
  assert.equal(sends, 1)
})

test('outbox 历史不完整或投递未知时保持 pending 不盲重发', async () => {
  const partial = { readGroup: async () => ({ complete: false, messages: [] }) }
  assert.deepEqual(await dispatchOutbox({ adapter: partial, groupId: 'cid-a', outbound: { outboundId: 'out-3', text: 'reply' } }), { status: 'pending', reason: 'preflight_history_partial' })

  const unknown = { readGroup: async () => ({ complete: true, messages: [] }), sendGroup: async () => ({ deliveryStatus: 'unknown' }) }
  assert.deepEqual(await dispatchOutbox({ adapter: unknown, groupId: 'cid-a', outbound: { outboundId: 'out-4', text: 'reply' } }), { status: 'pending', reason: 'delivery_unknown', sendResult: { deliveryStatus: 'unknown' } })
})

test('outbox 可使用无失败的最近消息窗口完成去重与投递确认', async () => {
  let reads = 0
  const adapter = {
    async readGroup() {
      reads += 1
      return { complete: false, partial: false, failedCount: 0, failures: [], messages: reads === 1 ? [] : [{ messageId: 'recent-id', text: 'reply' }] }
    },
    async sendGroup() { return { deliveryStatus: 'success' } },
  }
  assert.deepEqual(await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-recent', text: 'reply' } }), { status: 'sent', messageId: 'recent-id', deduplicated: false })
})

test('outbox 可识别钉钉补充@、移除Markdown并附加Agent签名后的已发送消息', async () => {
  let sends = 0
  const adapter = {
    async readGroup() {
      return { complete: false, partial: false, failedCount: 0, failures: [], messages: [{
        messageId: 'rendered-id',
        quotedMessage: { messageId: 'source-id' },
        text: '@李辰  锂电池数据库中英文 i18n 回填已完成：英文写入 en_US、中文写入 zh_CN。\n- Agent代回',
      }] }
    },
    async sendGroupReply() { sends += 1; return { deliveryStatus: 'success' } },
  }
  const result = await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: {
    outboundId: 'out-rendered', replyToMessageId: 'source-id', replyToSenderOpenDingTalkId: 'requester',
    text: '锂电池数据库中英文 i18n 回填已完成：英文写入 `en_US`、中文写入 `zh_CN`。',
  } })
  assert.deepEqual(result, { status: 'sent', messageId: 'rendered-id', deduplicated: true })
  assert.equal(sends, 0)
})
