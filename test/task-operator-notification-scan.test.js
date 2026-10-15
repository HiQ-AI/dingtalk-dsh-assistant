import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

// Real service scheduler with injected durable-store boundary and transport. No native profile/model required.
for (const scenario of ['recalled', 'not-due', 'no-adapter', 'due', 'expired-claim']) test(`recall scan converges and permits ordinary delivery: ${scenario}`, { timeout: 3000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'operator-scan-'))
  let service, taskReads = 0, starts = 0, recalls = 0, sends = 0
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }) })
  const operator = { id: 'operator-request', taskId: 'task', kind: 'question', state: 'delivered',
    payload: { audience: 'operator', humanRequestId: 'request' },
    receipt: { messageId: 'private-message', conversationId: 'private', senderActorId: 'self' },
    ...(scenario === 'recalled' ? { recall: { state: 'recalled' } } : scenario === 'not-due'
      ? { recall: { state: 'failed', nextAttemptAt: new Date(Date.now() + 60000).toISOString() } } : scenario === 'expired-claim'
      ? { recall: { state: 'starting', token: 'old-process', nextAttemptAt: new Date(Date.now() - 1).toISOString() } } : {}) }
  const ordinary = { id: 'ordinary', taskId: 'task', kind: 'status', state: 'prepared', payload: { text: 'ordinary update' } }
  const rows = [operator, ordinary]
  const store = {
    async query(q) {
      if (q.kind === 'notification.list') return structuredClone(rows)
      if (q.kind === 'notification.get') return structuredClone(rows.find(row => row.id === q.notificationId))
      if (q.kind === 'task.get') { taskReads++; return { taskId: 'task', humanRequests: [{ requestId: 'request', status: 'answered', replyChannel: 'web' }] } }
      return []
    },
    async command({ kind, args }) {
      const row = rows.find(row => row.id === args.notificationId)
      if (kind === 'notification.recall.start') { starts++; row.recall = { state: 'starting', token: 'claim', attempts: 1 }; return { dispatchEligible: true, result: { notification: structuredClone(row) } } }
      if (kind === 'notification.recall.result') row.recall = { ...row.recall, state: args.state }
      if (kind === 'notification.start') { row.state = 'starting'; row.dispatchToken = 'send'; return { dispatchEligible: true, result: { notification: structuredClone(row) } } }
      if (kind === 'notification.ack') row.ack = args.ack
      if (kind === 'notification.receipt') { row.state = args.state; row.receipt = args.receipt }
      return { dispatchEligible: false, result: { notification: structuredClone(row) } }
    },
  }
  const noop = async () => {}
  const open = () => openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } },
    config: { dbPath: join(root, 'unused.sqlite'), workspaceDir: root, instanceId: 'scan' },
    legacy: { getAgentConfig: () => ({ workspaceDir: root }) }, residentStore: { getGroup() {} }, store,
    persistence: { register: noop, close: noop }, taskSessions: { close: noop }, executionSessions: { close: noop },
    notifications: { async send() { sends++; return { messageId: 'ordinary-sent' } },
      async readback() { return { messageId: 'ordinary-sent', visible: true } },
      ...(scenario === 'no-adapter' ? {} : { async recall(notification) { recalls++; return { ...notification.receipt, recallStatus: 'SUCCESS' } } }) },
  })
  service = await open()
  await service.whenIdle()
  await service.whenIdle()
  await service.close()
  service = await open()
  await service.whenIdle()
  assert.equal(sends, 1)
  assert.equal(ordinary.state, 'delivered')
  assert.equal(starts, ['due', 'expired-claim'].includes(scenario) ? 1 : 0)
  assert.equal(recalls, ['due', 'expired-claim'].includes(scenario) ? 1 : 0)
  assert.equal(taskReads, ['due', 'expired-claim'].includes(scenario) ? 1 : 0, 'ineligible recalls must not perform task reads or occupy transport slots')
})
