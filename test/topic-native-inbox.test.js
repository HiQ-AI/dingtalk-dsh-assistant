import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { stableId } from '../packages/dingtalk-dsh-assistant/topic-model.js'

const notifications = { inserted() {}, discarded() {}, claimed() {} }
const input = (version = 1) => ({ id: stableId('message', `task-input:task-fixture:1:${version}`), role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `fixture input version ${version}` }] })
const wasInserted = (session, id) => session.snapshotEvents().some((event) => event.type === 'agent/inbox/spliced' && event.data.inserted.some((message) => message.id === id))
const enteredSurface = (session, id) => session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.id === id)

// 使用原生 Session 和 Inbox。只用隔离文件保存原生 header/events 并 fsync，
// 不冒充真实 profile 的异步 persistence plugin 或真实模型消费。
async function reopen(t, session) {
  const root = await mkdtemp(join(tmpdir(), 'topic-native-inbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'session-snapshot.json')
  const handle = await open(file, 'wx')
  try { await handle.writeFile(JSON.stringify({ header: session.header, events: session.snapshotEvents() })); await handle.sync() } finally { await handle.close() }
  const snapshot = JSON.parse(await readFile(file, 'utf8'))
  const restored = Session.fromRestore(session.id, snapshot.events, snapshot.header)
  return { session: restored, inbox: new Inbox(restored, notifications) }
}

test('原生Inbox插入稳定ID后跨文件重开恢复pending，重试不重复入队', async (t) => {
  const session = Session.create('session-native-pending'), inbox = new Inbox(session, notifications), message = input()
  inbox.append('next-step', message)
  assert.throws(() => inbox.append('next-step', message), /duplicate|already|identity/i)
  const restored = await reopen(t, session)
  assert.equal(restored.inbox.nextStep.length, 1)
  assert.equal(restored.inbox.nextStep[0].id, message.id)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  assert.notEqual(input(2).id, message.id)
})

test('原生Inbox已进入user/message后跨重开无pending，但稳定ID仍可确认曾下发', async (t) => {
  const session = Session.create('session-native-consumed'), inbox = new Inbox(session, notifications), message = input()
  inbox.append('next-step', message)
  session.append('turn/start', { turn: 1 })
  const claimed = inbox.claim('next-step', 1)
  for (const item of claimed) session.append('user/message', item, { surfaceOp: 'append' })
  const restored = await reopen(t, session)
  assert.equal(restored.inbox.hasPending, false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), true)
  const event = restored.session.snapshotEvents().find((item) => item.type === 'user/message')
  assert.equal(event.data.id, message.id)
  assert.equal(event.data.message, undefined)
})

test('原生Inbox取消保留历史inserted，不能凭此认定输入已消费或仍待执行', async (t) => {
  const session = Session.create('session-native-canceled'), inbox = new Inbox(session, notifications), message = input()
  inbox.append('next-step', message)
  assert.equal(inbox.remove(message.id), true)
  const restored = await reopen(t, session)
  assert.equal(restored.inbox.hasPending, false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  const cancellation = restored.session.snapshotEvents().find((event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
  assert.equal(cancellation.data.removedCount, 1)
  // Native Inbox允许相同ID在取消后再投递；是否重投必须由Task生命周期决定。
  restored.inbox.append('next-step', message)
  assert.equal(restored.inbox.nextStep.length, 1)
})

test('原生Inbox仅claim未进入surface时重开可见差异，不声称叶子已阅读', async (t) => {
  const session = Session.create('session-native-claimed'), inbox = new Inbox(session, notifications), message = input()
  inbox.append('next-step', message)
  session.append('turn/start', { turn: 1 })
  inbox.claim('next-step', 1)
  const restored = await reopen(t, session)
  assert.equal(restored.inbox.hasPending, false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  assert.equal(restored.session.snapshotEvents().some((event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'), false)
})
