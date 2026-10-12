import test from 'node:test'
import assert from 'node:assert/strict'
import { sendTaskCompletionNotification } from '../packages/dingtalk-dsh-assistant/task-completion-notification.js'
function fixture(status = 'prepared') {
  let notice = { id: 'n', status, leaseEpoch: 0, disclosure: { conversationId: 'g' }, payload: { text: 'Completed within approved scope.', phase: 'owner:r', conversationId: 'g', fact: { taskId: 't' } } }
  const counts = { sends: 0, claims: 0, writes: [] }
  const args = { taskId: 't', notificationId: 'n', conversationId: 'g', authorization: { confirmed: true, confirmationRef: 'explicit-human-confirmation' },
    task: { taskId: 't', state: 'completed', deliveryManifest: { turnId: 'turn' } },
    artifacts: { put: async () => ({ ref: 'evidence' }) },
    store: { query: async q => q.kind === 'message.notification' ? notice : [{ reportId: 'r', turnId: 'turn', reportType: 'complete', applicationStatus: 'applied' }],
      command: async c => { counts.writes.push(c.kind); if (c.kind.endsWith('.prepare')) { notice = { ...notice, id: c.args.notificationId, status: 'prepared' }; return { result: { notification: notice } } } if (c.kind.endsWith('.claim')) { counts.claims++; notice = { ...notice, status: 'sending', leaseEpoch: 1 }; return { dispatchEligible: true, result: { notification: notice } } }
        if (c.kind.endsWith('.sent')) notice = { ...notice, status: 'acknowledged', ack: c.args.ack }
        if (c.kind.endsWith('.readback')) notice = { ...notice, status: 'delivered', evidence: c.args.evidence }
        return { result: { notification: notice } } } },
    adapter: { sendScoped: async () => { counts.sends++; return { openTaskId: 'actual-platform-ack' } }, readback: async () => ({ messageId: 'platform-message', conversationId: 'g' }) } }
  return { args, counts }
}
test('scoped send persists ACK and independently observed delivery, then never resends', async () => {
  const { args, counts } = fixture(); const done = await sendTaskCompletionNotification(args)
  assert.equal(done.status, 'delivered'); assert.equal(done.ack.openTaskId, 'actual-platform-ack'); assert.equal(done.evidence.messageId, 'platform-message')
  await sendTaskCompletionNotification(args); assert.equal(counts.sends, 1); assert.equal(counts.claims, 1)
})
for (const state of ['unknown', 'acknowledged', 'sending']) test(`${state} never sends`, async () => {
  const { args, counts } = fixture(state); await sendTaskCompletionNotification(args); assert.equal(counts.sends, 0); assert.equal(counts.claims, 0)
})
for (const change of [a => a.taskId = 'other', a => a.conversationId = 'other', a => a.task.state = 'running', a => a.task.deliveryManifest.turnId = 'old', a => a.authorization.confirmed = false]) test('reject scope, stale completion or missing confirmation before any effect', async () => {
  const { args, counts } = fixture(); change(args); await assert.rejects(sendTaskCompletionNotification(args)); assert.deepEqual(counts.writes, []); assert.equal(counts.sends, 0)
})
test('send exception records unknown and does not retry', async () => {
  const { args, counts } = fixture(); args.adapter.sendScoped = async () => { counts.sends++; throw new Error('platform-uncertain') }
  const result = await sendTaskCompletionNotification(args); assert.equal(result.status, 'unknown'); assert.equal(counts.sends, 1); assert.ok(counts.writes.includes('message.notification.fail'))
})
test('ACK without readback stays acknowledged; wrong group readback cannot settle', async () => {
  const { args } = fixture(); args.adapter.readback = async () => ({ messageId: 'm', conversationId: 'wrong' })
  assert.equal((await sendTaskCompletionNotification(args)).status, 'acknowledged')
})

test('concurrent same scoped requests claim and send only once', async () => {
  const { args, counts } = fixture()
  await Promise.all([sendTaskCompletionNotification(args), sendTaskCompletionNotification(args)])
  assert.equal(counts.claims, 1); assert.equal(counts.sends, 1)
})

test('never-claimed retired notice uses one stable formal fresh attempt', async () => {
  const { args, counts } = fixture('superseded')
  const result = await sendTaskCompletionNotification(args)
  assert.equal(result.status, 'delivered'); assert.notEqual(result.id, 'n')
  assert.equal(counts.writes[0], 'message.notification.prepare'); assert.equal(counts.sends, 1)
  await sendTaskCompletionNotification(args); assert.equal(counts.sends, 1)
})
test('retired notice with an earlier claim or ACK is never automatically reprepared', async () => {
  const { args, counts } = fixture('superseded'); const query = args.store.query
  args.store.query = async q => { const n = await query(q); if (q.kind === 'message.notification') return { ...n, leaseEpoch: 1 }; return n }
  await sendTaskCompletionNotification(args); assert.equal(counts.sends, 0); assert.deepEqual(counts.writes, [])
})
