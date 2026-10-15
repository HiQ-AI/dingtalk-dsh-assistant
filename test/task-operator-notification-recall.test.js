import test from 'node:test'
import assert from 'node:assert/strict'
import { recallOperatorNotification } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
import { recallTaskOperatorNotification } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
const notice = () => ({ id: 'operator:request-a', kind: 'question', state: 'delivered', createdAt: new Date().toISOString(),
  payload: { audience: 'operator', humanRequestId: 'request-a' }, receipt: { messageId: 'a', conversationId: 'private', senderActorId: 'self' } })
test('recall uses only exact private receipt; repeated recovery reads absence without recalling another message', async () => {
  let history = [{ messageId: 'a', senderId: 'self' }, { messageId: 'b', senderId: 'self' }], calls = []
  const adapter = { async readConversation(id) { assert.equal(id, 'private'); return history }, async recallMessage(id) {
    calls.push(id); history = history.filter(item => item.messageId !== id); return { result: { recallStatus: 'SUCCESS' } }
  } }
  assert.equal((await recallOperatorNotification(adapter, notice())).observation, 'recall-and-absence')
  assert.equal((await recallOperatorNotification(adapter, notice())).observation, 'already-absent')
  assert.deepEqual(calls, ['a']); assert.equal(history[0].messageId, 'b')
  await assert.rejects(recallOperatorNotification(adapter, { ...notice(), payload: { audience: 'requester' } }), /SCOPE_INVALID/)
})
test('unconfirmed, still visible, partial history and wrong sender never report recall success', async () => {
  const target = { messageId: 'a', senderId: 'self' }
  for (const [ack, history, error] of [[{}, target, /UNCONFIRMED/], [{ recallStatus: 'SUCCESS' }, target, /PENDING/], [{}, { ...target, senderId: 'other' }, /IDENTITY_MISMATCH/]]) {
    await assert.rejects(recallOperatorNotification({ async readConversation() { return [history] }, async recallMessage() { return ack } }, notice()), error)
  }
  await assert.rejects(recallOperatorNotification({ async readConversation() { throw new Error('dws_conversation_read_partial') } }, notice()), /partial/)
})
test('recall failure records separate durable error rather than marking success', async () => {
  const commands = [], notification = { ...notice(), recall: { token: 'claim', attempts: 1 } }
  const command = async (kind, args) => { commands.push({ kind, args }); return { dispatchEligible: true, result: { notification } } }
  await assert.rejects(recallTaskOperatorNotification({ notification, command, notifications: { async recall() { throw new Error('recall forbidden') } } }), /recall forbidden/)
  assert.equal(commands.at(-1).args.state, 'failed'); assert.equal(commands.at(-1).args.error.phase, 'recall')
})
