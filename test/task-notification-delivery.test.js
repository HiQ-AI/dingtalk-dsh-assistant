import { taskNotificationOutbound } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { deliverTaskNotification, notificationRetryAt, safeNotificationDetail } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import * as notificationDelivery from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { readTaskNotificationDelivery } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { formatTaskGroupReply } from '../packages/dingtalk-dsh-assistant/group-reply-format.js'
import { persistedMentionSendRejectionProof } from '../packages/dingtalk-dsh-assistant/group-message.js'

test('发送时间随送达回执持久保存，历史记录不以创建时间或回读时间冒充', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T02:25:00Z') })
  const f = await fixture(t)
  t.mock.timers.tick(90000)
  const sendStartedAt = new Date().toISOString()
  const proof = { messageId: 'actual', conversationId: 'g', sentAt: '2026-10-19T02:27:14.000Z', observedAt: '2026-10-19T02:27:24.000Z' }
  await deliverTaskNotification({ notification: f.notification, command: f.command, notifications: { send: async () => ({ openTaskId: 'accepted' }), readback: async () => proof } })
  await f.reopen()
  const saved = await f.read(), outbound = taskNotificationOutbound(saved)
  assert.equal(outbound.sentAt, proof.sentAt)
  assert.equal(saved.sendStartedAt, sendStartedAt)
  assert.notEqual(saved.sendStartedAt, saved.createdAt)
  assert.equal(outbound.sendStartedAt, sendStartedAt)
  assert.equal(outbound.deliveredAt, proof.observedAt)
  assert.equal(taskNotificationOutbound({ ...saved, receipt: { messageId: 'old', observedAt: proof.observedAt } }).sentAt, undefined)
})

async function fixture(t, text = 'done') {
  const root = await mkdtemp(join(tmpdir(), 'notice-receipt-'))
  const config = { dbPath: join(root, 'tasks.sqlite'), instanceId: 'receipt-test', initialize: true }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `c-${++sequence}`) => store.command({ kind, args, id })
  const notification = (await command('notification.prepare', { notificationId: 'notice', taskId: null, requirementRevision: 1, kind: 'topic-reply',
    payload: { conversationId: 'g', text, sourceMessageId: 'source', actorId: 'owner', atOpenDingTalkIds: ['owner'], fact: { topicRefs: [{ topicId: 'topic', revision: 1 }] } } })).result.notification
  const read = async () => (await store.query({ kind: 'notification.list' }))[0]
  return { command, notification, read, async reopen() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }) } }
}

test('原单成员占位符校验拒绝跨重启只结清failed，不回读不重发', async t => {
  const f = await fixture(t), started = (await f.command('notification.start', { notificationId: f.notification.id })).result.notification
  const failure = { phase: 'send', exitCode: 3, stdout: '', message: 'dws_send_failed:3', stderr: JSON.stringify({ error: {
    category: 'validation', code: 3, message: '--at-open-dingtalk-ids 中的成员必须在正文中使用对应 <@openDingTalkId> 占位符；缺少: owner',
  } }) }
  await f.command('notification.receipt', { notificationId: started.id, dispatchToken: started.dispatchToken,
    state: 'unknown', error: failure, nextAttemptAt: '2099-01-01T00:00:00Z' })
  await f.reopen()
  const original = await f.read()
  assert.equal(persistedMentionSendRejectionProof(original).kind, 'dws-mention-validation-rejected')
  const invalid = [
    row => { row.ack = { openTaskId: 'accepted' } }, row => { row.receipt = { messageId: 'actual' } },
    row => { row.sendAttemptCount = 2 }, row => { row.sendPermit.attempt = 2 },
    row => { row.sendPermit.fence = 'other' }, row => { row.sendPermit.payloadDigest = 'a'.repeat(64) },
    row => { row.sendPermit.notificationId = 'other' }, row => { row.deliveryError.phase = 'readback' },
    row => { row.deliveryError.stdout = '{}' }, row => { row.deliveryError.exitCode = 1 },
    row => { row.deliveryError.stderr = 'not-json' }, row => { row.deliveryError.message = 'send failed' },
    row => { row.payload.atOpenDingTalkIds = ['owner', 'second'] }, row => { row.payload.atOpenDingTalkIds = ['other'] },
    row => { row.payload.text = '<@owner> done' },
    row => { row.deliveryError.stderr = JSON.stringify({ error: { category: 'validation', code: 3, message: 'other validation failure' } }) },
  ]
  for (const change of invalid) {
    const row = structuredClone(original); change(row)
    assert.equal(persistedMentionSendRejectionProof(row), undefined)
  }
  let sends = 0, reads = 0
  const notifications = { async send() { sends++ }, async readback() { reads++ } }
  await deliverTaskNotification({ notification: original, command: f.command, notifications })
  await f.reopen()
  const failed = await f.read()
  assert.equal(failed.state, 'failed'); assert.equal(failed.sendAttemptCount, 1)
  assert.equal(failed.deliveryError.knownNotSent, true); assert.equal(failed.deliveryError.retryable, false)
  assert.equal(failed.deliveryError.stderr, failure.stderr)
  assert.equal(failed.deliveryError.proof.kind, 'dws-mention-validation-rejected')
  assert.match(failed.evidenceRef, /^notification-readback:/u)
  await deliverTaskNotification({ notification: failed, command: f.command, notifications })
  assert.equal(sends, 0); assert.equal(reads, 0)
})

test('acceptance ack is durable before readback; readback errors survive restart and never resend', { timeout: 10000 }, async t => {
  const f = await fixture(t), ack = { sendReceipt: { openTaskId: 'accepted-operation' } }
  let sends = 0, release, observed
  const blocked = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { observed = resolve })
  const notifications = { async send() { sends++; return ack }, async readback() { observed(); await blocked; throw Object.assign(new Error('search collection missing'), { exitCode: 1, stderr: 'downstream collection field missing' }) } }
  const pending = deliverTaskNotification({ notification: f.notification, notifications, command: f.command })
  await entered
  assert.deepEqual((await f.read()).ack, ack)
  assert.deepEqual((await f.read()).receipt, ack)
  release()
  await assert.rejects(pending, /search collection missing/)
  await f.reopen()
  const unknown = await f.read()
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.deliveryError.phase, 'readback')
  assert.equal(unknown.deliveryError.exitCode, 1)
  assert.equal(unknown.deliveryError.stderr, 'downstream collection field missing')
  await f.command('notification.diagnostic', { notificationId: unknown.id, nextAttemptAt: '2000-01-01T00:00:00Z' })
  await assert.rejects(deliverTaskNotification({ notification: await f.read(), command: f.command, notifications: {
    send: notifications.send, async readback({ ack: durable }) { assert.deepEqual(durable, ack); throw new Error('still unavailable') },
  } }), /still unavailable/)
  assert.equal(sends, 1)
  assert.equal((await f.read()).lastReadbackError.message, 'still unavailable')
  assert.deepEqual((await f.read()).ack, ack)
})

test('send command diagnostics are bounded and redacted, and unknown never becomes a retry', async t => {
  const f = await fixture(t)
  let sends = 0
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run() {
    sends++; return { exitCode: 1, stdout: 'Authorization: Bearer hidden-token', stderr: JSON.stringify({ error: { server_error_code: 'CLI_ERROR', message: 'missing field', access_token: 'secret-token', url: 'https://host/file?sig=secret-signature' } }) + 'x'.repeat(9000) }
  } } })
  await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications: {
    send: () => adapter.sendGroup({ groupId: 'g', text: 'done', idempotencyKey: 'notice' }),
  } }), /dws_send_failed:1/)
  const unknown = await f.read(), error = unknown.deliveryError
  assert.equal(unknown.state, 'unknown')
  assert.equal(error.phase, 'send')
  assert.equal(error.exitCode, 1)
  assert.ok(error.stderr.length <= 4096)
  assert.doesNotMatch(JSON.stringify(error), /hidden-token|secret-token|secret-signature/)
  await deliverTaskNotification({ notification: unknown, command: f.command, notifications: { send: () => { sends++; }, readback: async () => undefined } })
  assert.equal(sends, 1)
  assert.equal((await f.read()).state, 'unknown')
  assert.equal(safeNotificationDetail({ Authorization: 'secret', apiKey: 'secret' }).Authorization, '[redacted]')
})

test('empty, failed or unobserved readback values cannot establish delivery', async t => {
  for (const proof of [{}, { messageId: 'm', visible: false }, { messageId: 'm', deliveryStatus: 'failed' }, { messageId: 'm', status: 'error' }, null]) {
    await t.test(JSON.stringify(proof), async t => {
      const f = await fixture(t)
      await deliverTaskNotification({ notification: f.notification, command: f.command, notifications: { send: async () => ({ openTaskId: 'operation' }), readback: async () => proof } })
      assert.equal((await f.read()).state, 'unknown')
    })
  }
})

test('ack ID/status takes priority over history; status errors remain visible and verified message is required', async () => {
  const notification = { id: 'notice', payload: { conversationId: 'g', sourceMessageId: 'source', text: 'done', atOpenDingTalkIds: ['owner'] }, ack: { openTaskId: 'operation' } }
  let statusReads = 0, messageReads = 0
  const adapter = {
    async querySendStatus(id) { statusReads++; assert.equal(id, 'operation'); return { result: { sendStatus: 'SUCCESS' }, messageRef: { openConversationId: 'g', openMessageId: 'actual' } } },
    async readGroup() { throw new Error('must not search with acknowledged id') },
    async readMessage(groupId, messageId) { messageReads++; return { conversationId: groupId, messageId, text: 'done', quotedMessage: { messageId: 'source', conversationId: 'g' }, atOpenDingTalkIds: ['owner'] } },
  }
  assert.equal((await readTaskNotificationDelivery(adapter, notification)).messageId, 'actual')
  assert.equal(statusReads, 1); assert.equal(messageReads, 1)
  adapter.querySendStatus = async () => { throw Object.assign(new Error('dws_send_status_failed'), { exitCode: 1 }) }
  await assert.rejects(readTaskNotificationDelivery(adapter, notification), error => error.exitCode === 1)
  notification.ack = { messageId: 'actual' }
  assert.equal((await readTaskNotificationDelivery(adapter, notification)).messageId, 'actual')
  notification.ack = null
  adapter.readGroup = async () => ({ complete: true, messages: [] })
  adapter.findOutboundMessage = async () => { throw new Error('missing collection field') }
  await assert.rejects(readTaskNotificationDelivery(adapter, notification), /missing collection field/)
  adapter.findOutboundMessage = async () => undefined
  assert.equal(await readTaskNotificationDelivery(adapter, notification), undefined)
})

test('successful send preserves actual process diagnostics and malformed stdout preserves failure details', async () => {
  let response = { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'actual-operation' } }), stderr: 'warning' }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => response } })
  const ack = await adapter.sendGroup({ groupId: 'g', text: 'done', idempotencyKey: 'notice' })
  assert.equal(ack.sendReceipt.openTaskId, 'actual-operation')
  assert.equal(ack.sendDiagnostic.exitCode, 0)
  assert.equal(ack.sendDiagnostic.stderr, 'warning')
  response = { exitCode: 0, stdout: 'bad-json', stderr: 'parse issue' }
  await assert.rejects(adapter.sendGroup({ groupId: 'g', text: 'done', idempotencyKey: 'notice' }), error => error.exitCode === 0 && error.stdout === 'bad-json' && error.stderr === 'parse issue')
})

test('restart in the ack/readback window reconciles with durable ack and never dispatches again', async t => {
  const f = await fixture(t), ack = { messageRef: { openMessageId: 'accepted-message' } }
  const claimed = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
  await f.command('notification.ack', { notificationId: 'notice', dispatchToken: claimed.dispatchToken, ack })
  await f.reopen()
  let sends = 0
  await deliverTaskNotification({ notification: await f.read(), command: f.command, notifications: {
    send: async () => { sends++ }, readback: async ({ ack: persisted }) => { assert.deepEqual(persisted, ack); return { messageId: 'accepted-message', conversationId: 'g' } },
  } })
  assert.equal(sends, 0)
  assert.equal((await f.read()).state, 'delivered')
  assert.deepEqual((await f.read()).ack, ack)
})

test('nested acknowledgement signature and cloud credentials are redacted by object key', () => {
  const value = safeNotificationDetail({ sendReceipt: { openTaskId: 'actual', nested: {
    sig: 'private-sig', signature: 'private-signature', 'x-amz-signature': 'private-cloud-signature',
    'x-amz-credential': 'private-credential', 'X-Amz-Security-Token': 'private-cloud-token',
  } } })
  assert.equal(value.sendReceipt.openTaskId, 'actual')
  assert.ok(Object.values(value.sendReceipt.nested).every(item => item === '[redacted]'))
  assert.doesNotMatch(JSON.stringify(value), /private-/)
})

test('rate-limited readback remains unknown, persists cooldown across restart, and never resends', async t => {
  const f = await fixture(t)
  let reads = 0, sends = 0
  const notifications = { async send() { sends++; return { openTaskId: 'operation' } }, async readback() {
    reads++; throw Object.assign(new Error('limited'), { serverErrorCode: 'RATE_LIMIT_ERROR', retryAfterMs: 90000 })
  } }
  const before = Date.now()
  await assert.rejects(deliverTaskNotification({ notification: f.notification, notifications, command: f.command }), /limited/)
  let row = await f.read()
  assert.equal(row.state, 'unknown')
  assert.ok(Date.parse(row.nextAttemptAt) >= before + 90000)
  assert.equal(row.readbackAttemptCount, 1)
  await f.reopen()
  for (let i = 0; i < 5; i++) await deliverTaskNotification({ notification: await f.read(), notifications, command: f.command })
  assert.equal(reads, 1); assert.equal(sends, 1)
  await f.command('notification.diagnostic', { notificationId: row.id, nextAttemptAt: '2000-01-01T00:00:00Z' })
  await assert.rejects(deliverTaskNotification({ notification: await f.read(), notifications, command: f.command }), /limited/)
  row = await f.read()
  assert.equal(sends, 1); assert.equal(reads, 2)
  assert.ok(Date.parse(row.nextAttemptAt) >= before + 120000)
})

test('empty readback schedules bounded exponential observation instead of rapid polling', async t => {
  const f = await fixture(t)
  let reads = 0
  const notifications = { send: async () => ({ openTaskId: 'op' }), readback: async () => { reads++; return undefined } }
  await deliverTaskNotification({ notification: f.notification, notifications, command: f.command })
  for (let i = 0; i < 5; i++) await deliverTaskNotification({ notification: await f.read(), notifications, command: f.command })
  assert.equal(reads, 1)
  assert.equal(notificationRetryAt({ readbackAttemptCount: 100 }, null, 'readback', 0), new Date(300000).toISOString())
})

const guardError = { category: 'api', code: 1, hint: '确认消息与会话信息可读取后重试；Thread 回复请使用 chat thread reply',
  message: '无法确认引用回复目标是否属于话题圈，已阻止发送', operation: 'chat/get_conversation_info', origin: 'mcp_gateway', reason: 'topic_quote_guard_unavailable', retryable: true }

test('exact quote-guard refusal is durable not-sent, waits, and retries the same quoted send without fallback', async t => {
  const signed = formatTaskGroupReply({ source: { groupId: 'g', messageId: 'source', senderOpenDingTalkId: 'owner' },
    summary: 'done\n\n- Ada Support', evidence: ['verified'], limitations: ['not deployed'], signature: 'Ada Support' }).text
  const f = await fixture(t, signed)
  let blocked = true, reads = 0
  const calls = []
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run(args) {
    calls.push(args)
    return blocked ? { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: guardError }) } : { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'accepted-after-guard' } }) }
  } } })
  const notifications = { send: notice => adapter.sendGroupReply({ groupId: notice.payload.conversationId, replyToMessageId: notice.payload.sourceMessageId,
    replyToSenderOpenDingTalkId: notice.payload.actorId, atOpenDingTalkIds: notice.payload.atOpenDingTalkIds, text: notice.payload.text, idempotencyKey: notice.id }),
    readback: async () => { reads++; return { messageId: 'verified', conversationId: 'g' } } }
  await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications }), /dws_reply_failed/)
  let row = await f.read()
  assert.equal(row.state, 'failed'); assert.equal(row.deliveryError.knownNotSent, true)
  assert.equal(row.deliveryError.proof.idempotencyKey, 'notice')
  assert.equal(row.ack, undefined); assert.equal(row.receipt, null)
  assert.equal(reads, 0)
  for (let i = 0; i < 5; i++) await deliverTaskNotification({ notification: await f.read(), command: f.command, notifications })
  assert.equal(calls.length, 1)
  const due = Date.parse(row.nextAttemptAt)
  const digest = row.payloadDigest
  assert.equal(typeof digest, 'string')
  await f.reopen()
  assert.equal((await f.read()).payload.text, signed)
  assert.equal((await f.read()).payloadDigest, digest)
  t.mock.timers.enable({ apis: ['Date'], now: due + 1 })
  blocked = false
  await deliverTaskNotification({ notification: await f.read(), command: f.command, notifications })
  row = await f.read()
  assert.equal(row.state, 'delivered'); assert.equal(row.sendAttemptCount, 2); assert.equal(reads, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1], 'Retry preserves quote, owner mention, text and outbound idempotency key')
  assert.equal(calls[1][calls[1].indexOf('--content') + 1], signed)
  assert.deepEqual(calls[1].slice(0, 3), ['chat', 'message', 'reply'])
  assert.equal(calls[1][calls[1].indexOf('--ref-msg-id') + 1], 'source')
  assert.equal(calls[1][calls[1].indexOf('--at-open-dingtalk-ids') + 1], 'owner')
})

test('old unknown exact pre-send refusal reclassifies in place without history reads or manufactured ACK', async t => {
  const f = await fixture(t)
  const started = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
  const originalError = { phase: 'send', exitCode: 1, message: 'dws_reply_failed:1', stderr: JSON.stringify({ error: guardError }) }
  await f.command('notification.receipt', { notificationId: 'notice', dispatchToken: started.dispatchToken, state: 'unknown', receipt: null, error: originalError })
  await f.command('notification.diagnostic', { notificationId: 'notice', nextAttemptAt: '2000-01-01T00:00:00Z', error: { phase: 'readback', message: 'limited' } })
  let calls = 0
  await deliverTaskNotification({ notification: await f.read(), command: f.command, notifications: { send: async () => { calls++ }, readback: async () => { calls++ } } })
  const row = await f.read()
  assert.equal(calls, 0); assert.equal(row.state, 'failed')
  assert.equal(row.id, 'notice'); assert.equal(row.deliveryError.stderr, originalError.stderr)
  assert.equal(row.lastReadbackError.message, 'limited')
  assert.equal(row.deliveryError.knownNotSent, true); assert.equal(row.receipt, null); assert.equal(row.ack, undefined)
})

test('generic exits, altered guard envelopes, accepted evidence and arbitrary knownNotSent flags never authorize resend', async t => {
  for (const [label, error, stdout] of [
    ['wrong origin', { ...guardError, origin: 'untrusted' }, ''],
    ['wrong operation', { ...guardError, operation: 'chat/send_message' }, ''],
    ['not retryable', { ...guardError, retryable: false }, ''],
    ['accepted stdout', guardError, JSON.stringify({ sendReceipt: { openTaskId: 'accepted' } })],
    ['ordinary rate limit', { category: 'api', code: 1, server_error_code: 'RATE_LIMIT_ERROR', retryable: true }, ''],
  ]) await t.test(label, async t => {
    const f = await fixture(t)
    const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => ({ exitCode: 1, stdout, stderr: JSON.stringify({ error }) }) } })
    await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications: {
      send: notice => adapter.sendGroupReply({ groupId: 'g', replyToMessageId: 'source', replyToSenderOpenDingTalkId: 'owner', text: 'done', idempotencyKey: notice.id }),
    } }))
    assert.equal((await f.read()).state, 'unknown')
    assert.equal((await f.read()).deliveryError.knownNotSent, false)
  })
  await t.test('unverified flag', async t => {
    const f = await fixture(t)
    await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications: {
      send: async () => { throw Object.assign(new Error('maybe sent'), { knownNotSent: true, proof: { kind: 'dws-topic-quote-guard-rejected' }, retryable: true }) },
    } }))
    assert.equal((await f.read()).state, 'unknown')
  })
})

test('accepted evidence prevents legacy pre-send reclassification and failed retry', async t => {
  const f = await fixture(t), claimed = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
  const error = { phase: 'send', exitCode: 1, stderr: JSON.stringify({ error: guardError }), knownNotSent: true, retryable: true }
  await f.command('notification.ack', { notificationId: 'notice', dispatchToken: claimed.dispatchToken, ack: { openTaskId: 'accepted' } })
  await f.command('notification.receipt', { notificationId: 'notice', dispatchToken: claimed.dispatchToken, state: 'unknown', receipt: { openTaskId: 'accepted' }, error })
  const result = await f.command('notification.rejectBeforeSend', { notificationId: 'notice' })
  assert.equal(result.result.notification.state, 'unknown')
  assert.equal((await f.read()).ack.openTaskId, 'accepted')
  await assert.rejects(f.command('notification.retireUnsent', { notificationId: 'notice', reason: 'superseded', evidenceRef: 'replacement' }), /DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED/)
})

test('outbox projection distinguishes guard refusal, unknown observation, and retired confirmation without exposing ACK', () => {
  const base = { id: 'notice', payload: { text: 'done', conversationId: 'g', sourceMessageId: 'source', actorId: 'owner' },
    state: 'failed', ack: null, deliveryError: { phase: 'send', knownNotSent: true, retryable: true, reason: 'topic_quote_guard_unavailable', message: 'blocked' },
    lastReadbackError: { phase: 'readback', message: 'old rate limit' }, nextAttemptAt: '2026-10-14T06:00:00Z' }
  const blocked = taskNotificationOutbound(base)
  assert.equal(blocked.deliveryPendingReason, 'task-notification-pre-send-rejected')
  assert.equal(blocked.notificationFailurePhase, 'send')
  assert.equal(blocked.notificationKnownNotSent, true)
  assert.match(blocked.deliveryError, /topic_quote_guard_unavailable/)
  assert.equal(blocked.ack, undefined)
  const retired = taskNotificationOutbound({ ...base, retirement: { reason: 'task-terminal' }, nextAttemptAt: null })
  assert.equal(retired.deliveryPendingReason, 'task-notification-task-terminal')
  assert.equal(retired.notificationRetryAt, undefined)
  const unknown = taskNotificationOutbound({ ...base, state: 'unknown', ack: { openTaskId: 'private-ack' } })
  assert.equal(unknown.notificationKnownNotSent, false)
  assert.equal(unknown.notificationFailurePhase, 'readback')
  assert.doesNotMatch(JSON.stringify(unknown), /private-ack/)
})

test('failed rows with acceptance evidence cannot re-enter send dispatch', async t => {
  const f = await fixture(t), claimed = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
  await f.command('notification.ack', { notificationId: 'notice', dispatchToken: claimed.dispatchToken, ack: { openTaskId: 'accepted' } })
  await f.command('notification.receipt', { notificationId: 'notice', dispatchToken: claimed.dispatchToken, state: 'failed', receipt: { openTaskId: 'accepted' },
    error: { phase: 'send', exitCode: 1, stderr: JSON.stringify({ error: guardError }), knownNotSent: true, retryable: true } })
  const retried = await f.command('notification.retry', { notificationId: 'notice' })
  assert.equal(retried.result.notification.state, 'failed')
  let sends = 0
  await deliverTaskNotification({ notification: await f.read(), command: f.command, notifications: { send: async () => { sends++ } } })
  assert.equal(sends, 0)
  assert.equal(taskNotificationOutbound(await f.read()).notificationKnownNotSent, false)
})

test('send and readback phases observe independent attempts; unknown recovery measures only readback', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T01:00:00Z') })
  const f = await fixture(t), stages = []
  let sends = 0, reads = 0
  const onStage = async (_notification, stage) => stages.push(structuredClone(stage))
  await deliverTaskNotification({ notification: f.notification, command: f.command, onStage, notifications: {
    async send() { sends++; t.mock.timers.tick(20); return { messageId: 'ack' } },
    async readback() { reads++; t.mock.timers.tick(30); return null },
  } })
  const saved = await f.read()
  assert.equal(saved.state, 'unknown')
  assert.deepEqual(stages.map(stage => stage.stage), ['send', 'send', 'readback', 'readback'])
  assert.equal(Date.parse(stages[1].completedAt) - Date.parse(stages[1].startedAt), 20)
  assert.equal(Date.parse(stages[3].completedAt) - Date.parse(stages[3].startedAt), 30)
  t.mock.timers.tick(10000)
  await deliverTaskNotification({ notification: await f.read(), command: f.command, onStage, notifications: {
    async send() { assert.fail('unknown must never resend') },
    async readback() { reads++; return { messageId: 'ack' } },
  } })
  assert.equal(sends, 1); assert.equal(reads, 2)
  assert.deepEqual(stages.slice(4).map(stage => stage.stage), ['readback', 'readback'])
  assert.equal(stages[4].attempt, 2)
  const delivered = await f.read()
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.readbackAttemptCount, 2)
  assert.equal(delivered.sendAttemptCount, 1)
  assert.notEqual(stages[2].spanId, stages[4].spanId)
})

const recovery = notification => notificationDelivery.taskNotificationRecovery(notification)
const retry = (f, notification, notifications, extra = {}) => notificationDelivery.retryTaskNotification({ notification,
  expectedToken: recovery(notification).expectedToken, notifications, command: f.command, ...extra })

function guardedNotifications(blocked, sends) {
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run(args) {
    sends.push(args)
    return blocked() ? { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { ...guardError, hint: 'upstream HTTP 401' } }) }
      : { exitCode: 0, stdout: JSON.stringify({ openTaskId: 'recovered' }) }
  } } })
  return { send: notice => adapter.sendGroupReply({ groupId: notice.payload.conversationId, text: notice.payload.text,
    replyToMessageId: notice.payload.sourceMessageId, replyToSenderOpenDingTalkId: notice.payload.actorId,
    atOpenDingTalkIds: notice.payload.atOpenDingTalkIds, idempotencyKey: notice.id }),
  readback: async () => ({ messageId: 'verified', conversationId: 'g' }) }
}

test('manual notification recovery descriptor is a private-data-free proof-gated whitelist', () => {
  const base = { id: 'notice', state: 'failed', payload: { text: 'PRIVATE', actorId: 'PRIVATE', conversationId: 'g', sourceMessageId: 'source' },
    deliveryError: { knownNotSent: true, retryable: true, message: 'PRIVATE' }, dispatchToken: 'PRIVATE', updatedAt: 'stamp' }
  assert.equal(recovery(base).action, null, 'flags alone do not authorize a send')
  assert.deepEqual(Object.keys(recovery(base)).sort(), ['action', 'expectedToken', 'reason'])
  assert.doesNotMatch(JSON.stringify(recovery(base)), /PRIVATE|payload|dispatchToken|deliveryError/)
  assert.match(recovery(base).expectedToken, /^[a-f0-9]{64}$/)
  for (const row of [{ ...base, state: 'delivered' }, { ...base, state: 'superseded' },
    { ...base, state: 'prepared', retirement: { reason: 'superseded' } }, { ...base, state: 'unknown', recall: { state: 'failed' } }])
    assert.equal(recovery(row).action, null)
  assert.equal(recovery({ ...base, state: 'unknown' }).action, 'readback')
  assert.equal(recovery({ ...base, state: 'starting' }).action, 'readback')
  assert.equal(recovery({ ...base, state: 'prepared' }).action, 'send')
})

test('manual notification recovery repeats proven 401 refusal safely and succeeds after authorization repair', async t => {
  const f = await fixture(t), sends = [], stages = []
  let blocked = true
  const notifications = guardedNotifications(() => blocked, sends)
  await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications }), /dws_reply_failed/)
  const failed = await f.read(), digest = failed.payloadDigest
  assert.equal(recovery(failed).action, 'send'); assert.ok(Date.parse(failed.nextAttemptAt) > Date.now())
  await assert.rejects(retry(f, failed, notifications), /dws_reply_failed/)
  const refusedAgain = await f.read()
  assert.equal(refusedAgain.state, 'failed'); assert.equal(refusedAgain.sendAttemptCount, 2)
  assert.notEqual(recovery(refusedAgain).expectedToken, recovery(failed).expectedToken)
  blocked = false
  const result = await retry(f, refusedAgain, notifications, { onStage: async (_row, stage) => stages.push(stage) })
  assert.equal(result.status, 'attempted'); assert.equal(result.action, 'send')
  const delivered = await f.read()
  assert.equal(delivered.state, 'delivered'); assert.equal(delivered.sendAttemptCount, 3)
  assert.equal(delivered.payloadDigest, digest); assert.equal(sends.length, 3)
  assert.deepEqual(sends[0], sends[1]); assert.deepEqual(sends[1], sends[2])
  assert.deepEqual(stages.map(stage => stage.stage), ['send', 'send', 'readback', 'readback'])
  await assert.rejects(retry(f, delivered, notifications), { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN' })
  assert.equal(sends.length, 3)
})

test('manual notification recovery never treats network timeout as not-sent and retries readback only', async t => {
  const f = await fixture(t)
  let sends = 0, reads = 0, broken = true
  const notifications = { send: async () => { sends++; throw new Error('network timeout') }, readback: async () => {
    reads++; if (broken) throw new Error('HTTP 401'); return { messageId: 'verified', conversationId: 'g' }
  } }
  await assert.rejects(deliverTaskNotification({ notification: f.notification, command: f.command, notifications }), /network timeout/)
  const unknown = await f.read()
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.deliveryError.knownNotSent, false)
  await assert.rejects(retry(f, unknown, notifications), /HTTP 401/)
  const stillUnknown = await f.read()
  assert.equal(stillUnknown.state, 'unknown'); assert.equal(stillUnknown.readbackAttemptCount, 1)
  broken = false
  assert.equal((await retry(f, stillUnknown, notifications)).action, 'readback')
  const delivered = await f.read()
  assert.equal(delivered.state, 'delivered'); assert.equal(delivered.readbackAttemptCount, 2)
  assert.equal(sends, 1); assert.equal(reads, 2)
})

test('manual notification recovery of starting and legacy guard-unknown remains readback-only', async t => {
  for (const state of ['starting', 'unknown']) await t.test(state, async t => {
    const f = await fixture(t)
    const started = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
    if (state === 'unknown') await f.command('notification.receipt', { notificationId: 'notice', dispatchToken: started.dispatchToken,
      state: 'unknown', receipt: null, error: { phase: 'send', exitCode: 1, stderr: JSON.stringify({ error: guardError }) } })
    const result = await retry(f, await f.read(), { send: async () => assert.fail('must never send'), readback: async () => null })
    assert.equal(result.action, 'readback')
    const saved = await f.read()
    assert.equal(saved.sendAttemptCount, 1); assert.equal(saved.readbackAttemptCount, 1)
    assert.ok(['starting', 'unknown'].includes(saved.state))
  })
})

test('manual notification recovery rejects stale CAS and concurrent clicks without duplicate effects', async t => {
  const f = await fixture(t)
  await deliverTaskNotification({ notification: f.notification, command: f.command, notifications: {
    send: async () => ({ openTaskId: 'accepted' }), readback: async () => null,
  } })
  const stale = await f.read(), oldToken = recovery(stale).expectedToken
  await f.command('notification.diagnostic', { notificationId: 'notice', nextAttemptAt: '2099-01-01T00:00:00Z' })
  await assert.rejects(notificationDelivery.retryTaskNotification({ notification: stale, expectedToken: oldToken,
    notifications: { readback: async () => assert.fail('stale state must not call channel') }, command: f.command }), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  const row = await f.read(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let reads = 0
  const notifications = { readback: async () => { reads++; entered.resolve(); await release.promise; return null } }
  const pending = retry(f, row, notifications)
  await entered.promise
  await assert.rejects(retry(f, row, notifications), { code: 'TASK_NOTIFICATION_RECOVERY_IN_PROGRESS' })
  assert.deepEqual(await deliverTaskNotification({ notification: row, notifications, command: f.command }), { inProgress: true })
  release.resolve(); await pending
  assert.equal(reads, 1)
  await assert.rejects(retry(f, row, notifications), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  await retry(f, await f.read(), { readback: async () => ({ messageId: 'verified' }) })
  assert.equal((await f.read()).state, 'delivered')
})

test('manual notification recovery CAS refuses forged caller flags and retired original notifications', async t => {
  const f = await fixture(t)
  const started = (await f.command('notification.start', { notificationId: 'notice' })).result.notification
  await f.command('notification.receipt', { notificationId: 'notice', dispatchToken: started.dispatchToken,
    state: 'failed', error: { phase: 'send', knownNotSent: true, retryable: true } })
  let row = await f.read()
  await assert.rejects(f.command('notification.recovery.start', { notificationId: 'notice', expectedToken: recovery(row).expectedToken }),
    { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN' })
  await f.command('notification.retireUnsent', { notificationId: 'notice', reason: 'superseded', evidenceRef: 'retirement-proof' })
  row = await f.read()
  assert.equal(recovery(row).action, null)
  await assert.rejects(retry(f, row, { send: async () => assert.fail('retired never sends') }), { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN' })
})


test('manual notification recovery consumes CAS across restart even at the same timestamp', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T12:00:00Z') })
  const f = await fixture(t), row = await f.read(), expectedToken = recovery(row).expectedToken
  const started = await f.command('notification.recovery.start', { notificationId: row.id, expectedToken })
  assert.equal(started.result.notification.updatedAt, row.updatedAt)
  assert.notEqual(recovery(started.result.notification).expectedToken, expectedToken)
  await f.reopen()
  await assert.rejects(f.command('notification.recovery.start', { notificationId: row.id, expectedToken }),
    { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE', statusCode: 409 })
})

test('manual notification recovery uses persisted payload and rejects adapter absence without consuming CAS', async t => {
  const f = await fixture(t), row = await f.read(), original = structuredClone(row.payload)
  await assert.rejects(retry(f, row, {}), { code: 'TASK_NOTIFICATION_RECOVERY_UNAVAILABLE' })
  assert.deepEqual(await f.read(), row)
  row.payload.text = 'caller-forged'; row.payload.actorId = 'caller-forged'
  await retry(f, row, { send: async notice => { assert.deepEqual(notice.payload, original); return { openTaskId: 'accepted' } },
    readback: async () => ({ messageId: 'verified' }) })
  assert.equal((await f.read()).state, 'delivered')
})

test('manual notification recovery cannot read back while the original automatic send is still in flight', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const notifications = { send: async () => { entered.resolve(); await release.promise; throw new Error('network timeout') },
    readback: async () => ({ messageId: 'verified' }) }
  const pending = deliverTaskNotification({ notification: f.notification, command: f.command, notifications })
  const rejected = assert.rejects(pending, /network timeout/)
  await entered.promise
  await assert.rejects(retry(f, await f.read(), notifications), { code: 'TASK_NOTIFICATION_RECOVERY_IN_PROGRESS', statusCode: 409 })
  release.resolve(); await rejected
  await retry(f, await f.read(), notifications)
  assert.equal((await f.read()).state, 'delivered')
})


test('manual notification recovery never replays effects from a replayed command receipt', async t => {
  const f = await fixture(t)
  await deliverTaskNotification({ notification: f.notification, command: f.command,
    notifications: { send: async () => ({ openTaskId: 'accepted' }), readback: async () => null } })
  const notification = await f.read(), expectedToken = recovery(notification).expectedToken
  const command = (kind, args) => f.command(kind, args, kind === 'notification.recovery.start' ? 'same-recovery-command' : undefined)
  let reads = 0
  const options = { notification, expectedToken, command, notifications: { readback: async () => { reads++; return null } } }
  await notificationDelivery.retryTaskNotification(options)
  await assert.rejects(notificationDelivery.retryTaskNotification(options), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  assert.equal(reads, 1)
})
