import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeDwsObserver, nativeDwsCommands, nativeDwsObservation, nativeDwsStatus } from '../packages/dingtalk-dsh-assistant/native-dws-send.js'

const binding = { sessionId: 'session' }
const send = (type = 'file') => type === 'reply'
  ? `dws chat message reply --group 'group' --ref-msg-id 'source' --ref-sender 'actor' --content 'result' --uuid 'key' --yes --format json`
  : `dws chat +messages-send --as user --group 'group' ${type === 'text' ? "--text 'result'" : '--file "C:\\evidence folder\\accepted.png"'} --msg-type ${type} --idempotency-key 'key' --yes --format json`
const query = `dws chat message send-status --open-task-id 'send-task' --format json`
const mget = `dws chat +messages-mget --msg-ids 'message' --no-reactions --no-threads --format json`
const ack = { ok: true, result: { success: true, result: { openTaskId: 'send-task' } }, sendReceipt: { openTaskId: 'send-task' } }
const status = (change = {}) => ({ contractVersion: 'im.message-send-status.v1', success: true, openTaskId: 'send-task',
  result: { sendStatus: 'SUCCESS', openConversationId: 'group', openMessageId: 'message' },
  messageRef: { openConversationId: 'group', openMessageId: 'message' }, ...change })
const event = (...values) => ({ binding, result: { value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false,
  stdout: { text: values.map(value => JSON.stringify(value)).join('\n') }, stderr: { text: '' } } } })
const observation = (command, ...values) => nativeDwsObservation(event(...values), nativeDwsCommands('pwsh', { command }))

test('literal native text, file, image and reply sends retain the original accepted task identity', () => {
  for (const type of ['text', 'file', 'image', 'reply']) {
    const commands = nativeDwsCommands('pwsh', { command: send(type) })
    assert.equal(commands.length, 1); assert.equal(commands[0].messageType, type)
    const observed = nativeDwsObservation(event(ack), commands)
    assert.equal(observed.nativeDwsSend.openTaskId, 'send-task')
    assert.equal(observed.nativeDwsSend.conversationId, 'group')
    assert.equal(observed.nativeDwsSend.messageId, undefined, 'Acceptance is not delivery')
  }
})

test('ordinary shell text, files, computed commands and mget results never become send receipts', () => {
  for (const command of ["Get-Content 'send-status.json'", "Write-Output 'dws chat +messages-send'", `${send()}; Write-Output '{}'`,
    `${send()} | ConvertFrom-Json`, send().replace("'group'", '$group'), send().replace("'group'", 'group*'), `if ($true) { ${send()} }`]) {
    assert.deepEqual(observation(command, ack), {})
  }
  assert.deepEqual(observation(mget, status()), {})
  assert.deepEqual(observation(`${query}; ${mget}`, status({ result: { sendStatus: 'PROCESSING' } }), status()), {})
  assert.deepEqual(observation(`${query}\n${mget}`, status(), { messages: [status({ openTaskId: 'other' })] }).nativeDwsStatuses,
    [{ openTaskId: 'send-task', conversationId: 'group', messageId: 'message', profile: null }])
})

test('conflicting send/status identities, failed or lossy native results are not accepted', () => {
  assert.deepEqual(observation(send(), { ...ack, sendReceipt: { openTaskId: 'other' } }), {})
  for (const value of [status({ openTaskId: 'other' }), status({ success: false }), status({ messageRef: { openConversationId: 'group', openMessageId: 'other' } })])
    assert.equal(nativeDwsStatus(value, 'send-task', 'group'), undefined)
  assert.equal(nativeDwsStatus(status(), 'send-task', 'different-group'), undefined)
  const e = event(ack); e.result.value.exitCode = 1
  assert.deepEqual(nativeDwsObservation(e, nativeDwsCommands('pwsh', { command: send() })), {})
  const job = { binding, result: { content: [{ type: 'text', text: JSON.stringify(ack) }] }, jobReceipt: {
    owner: 'session', status: 'completed', cancelled: false, lossy: false, chunks: [{ stream: 'stdout', text: JSON.stringify(ack) }] } }
  assert.equal(nativeDwsObservation(job, nativeDwsCommands('pwsh', { command: send() })).nativeDwsSend.openTaskId, 'send-task')
  for (const change of [{ lossy: true }, { owner: 'other' }, { status: 'running' }])
    assert.deepEqual(nativeDwsObservation({ ...job, jobReceipt: { ...job.jobReceipt, ...change } }, nativeDwsCommands('pwsh', { command: send() })), {})
})

test('only the matching original task send can register a status; ingress waits for its receipt and recovery is idempotent', async () => {
  const operations = new Map(), outbox = []
  const residentStore = { getGroup: group => group === 'group' ? { outbox } : undefined,
    projectTaskNotification: async ({ outbound }) => outbox.push(structuredClone(outbound)) }
  const original = { id: 'send-op', taskId: 'task', state: 'succeeded', result: observation(send(), ack) }
  const statusOperation = { id: 'status-op', taskId: 'task', state: 'succeeded', result: observation(`${query}; ${mget}`, status(), { messages: [] }) }
  const observer = createNativeDwsObserver({ operations, residentStore })
  await observer.observe(statusOperation); assert.equal(outbox.length, 0, 'No original accepted send')
  operations.set(original.id, original)
  await observer.observe({ ...statusOperation, taskId: 'other-task' }); assert.equal(outbox.length, 0)
  await observer.observe(statusOperation)
  assert.equal(outbox.length, 1); assert.equal(outbox[0].sourceMessageId, `native-operation:${original.id}`)
  assert.equal(outbox[0].sendReceipt.openTaskId, 'send-task')
  assert.equal(outbox[0].deliveredMessageId, 'message')
  operations.set(statusOperation.id, statusOperation)
  await createNativeDwsObserver({ operations, residentStore }).recover()
  assert.equal(outbox.length, 1, 'Restart must not add a duplicate outgoing record')
  outbox.length = 0; operations.clear()
  const early = createNativeDwsObserver({ operations, residentStore, querySendStatus: async (id, options) => {
    assert.equal(id, 'send-task'); assert.deepEqual(options, { profile: null }); return status()
  } })
  early.start(original.id, nativeDwsCommands('pwsh', { command: send() }))
  let ingressed = false
  const waiting = early.beforeIngress('group').then(() => { ingressed = true })
  await Promise.resolve(); assert.equal(ingressed, false)
  operations.set(original.id, original); early.finish(original.id)
  await waiting
  assert.equal(outbox[0].deliveredMessageId, 'message')
})

test('a stalled send or status cannot freeze ingress, startup or shutdown', { timeout: 2000 }, async () => {
  const operations = new Map(), outbox = []
  const residentStore = { getGroup: () => ({ outbox }), projectTaskNotification: async ({ outbound }) => outbox.push(outbound) }
  let queries = 0
  const observer = createNativeDwsObserver({ operations, residentStore, ingressWaitMs: 10, probeWaitMs: 20,
    querySendStatus: () => { queries++; return new Promise(() => {}) } })
  observer.start('stalled-send', nativeDwsCommands('pwsh', { command: send() }))
  await observer.beforeIngress('group')
  assert.equal(queries, 0); assert.equal(outbox.length, 0)
  observer.finish('stalled-send')
  const original = { id: 'send-op', taskId: 'task', state: 'succeeded', result: observation(send(), ack) }
  operations.set(original.id, original)
  await observer.recover(); assert.equal(queries, 0, 'Recovery must not wait on network')
  await observer.beforeIngress('group'); await observer.beforeIngress('group')
  assert.equal(queries, 1, 'Keep one in-flight status query rather than accumulating retries')
  const waiting = observer.beforeIngress('group')
  observer.close(); await waiting
  assert.equal(outbox.length, 0, 'A timeout never manufactures a sent message identity')
})

test('original CLI profile is preserved for status lookup and cross-profile status evidence is rejected', async () => {
  const operations = new Map(), outbox = []
  const residentStore = { getGroup: () => ({ outbox }), projectTaskNotification: async ({ outbound }) => outbox.push(outbound) }
  const original = { id: 'send-op', taskId: 'task', state: 'succeeded', result: observation(`${send()} --profile 'sender-profile'`, ack) }
  operations.set(original.id, original)
  const observer = createNativeDwsObserver({ operations, residentStore, querySendStatus: async (id, options) => {
    assert.equal(id, 'send-task'); assert.deepEqual(options, { profile: 'sender-profile' }); return status()
  } })
  await observer.observe({ id: 'wrong-profile', taskId: 'task', state: 'succeeded', result: observation(query, status()) })
  assert.equal(outbox.length, 0)
  await observer.beforeIngress('group')
  assert.equal(outbox[0].deliveredMessageId, 'message')
  observer.close()
})

for (const kind of ['text', 'file', 'image']) test(`queued ${kind} echo identity is recorded before content verification without declaring delivery`, async () => {
  const outbox = [], notifications = new Map()
  const residentStore = { getGroup: () => ({ outbox }), projectTaskNotification: async ({ outbound }) => outbox.push(structuredClone(outbound)) }
  const notification = { id: 'notice', taskId: 'task', kind: 'topic-reply', state: 'starting',
    payload: { conversationId: 'group', text: 'final result', ...(kind !== 'text' ? { artifact: { fileName: `accepted.${kind}` } } : {}) } }
  notifications.set(notification.id, notification)
  const observer = createNativeDwsObserver({ operations: new Map(), residentStore, notificationCache: notifications,
    querySendStatus: async (id, options) => { assert.equal(id, 'send-task'); assert.equal(options, undefined); return status() } })
  observer.notificationChanged(notification)
  const early = observer.beforeIngress('group')
  notification.state = 'unknown'; notification.ack = ack
  observer.notificationChanged(notification)
  await early
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].deliveredMessageId, 'message')
  assert.equal(outbox[0].status, 'pending'); assert.equal(outbox[0].notificationState, 'unknown')
  assert.equal(notification.receipt, undefined, 'Identity is not the final content readback')
  assert.deepEqual(outbox[0].sendReceipt, { openTaskId: 'send-task', conversationId: 'group', messageId: 'message' })
  await observer.beforeIngress('group'); assert.equal(outbox.length, 1)
  observer.close()
})
