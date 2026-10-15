import { taskNotificationOutbound } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { deliverTaskNotification, notificationRetryAt, safeNotificationDetail } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { readTaskNotificationDelivery } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { formatTaskGroupReply } from '../packages/dingtalk-dsh-assistant/group-reply-format.js'

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
