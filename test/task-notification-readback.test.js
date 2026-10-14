import test from 'node:test'
import assert from 'node:assert/strict'
import { readTaskNotificationDelivery, verifyTaskNotificationReadback } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
const notification = { id: 'n', payload: { conversationId: 'g', sourceMessageId: 's', text: '核验完成。', atOpenDingTalkIds: ['u'] } }
const observed = { messageId: 'm', conversationId: 'g', text: '核验完成。', quotedMessage: { messageId: 's', conversationId: 'g' }, atOpenDingTalkIds: ['u'] }
test('native quote and mention must be verified independently of text', () => {
  const verify = value => verifyTaskNotificationReadback(notification, value, { acknowledgedMessageId: 'm' })
  assert.ok(verify(observed))
  for (const change of [{quotedMessage: undefined}, {quotedMessage:{messageId:'other',conversationId:'g'}}, {quotedMessage:{messageId:'s',conversationId:'other'}}, {atOpenDingTalkIds:undefined}, {atOpenDingTalkIds:['other']}, {conversationId:'other'}]) assert.equal(verify({...observed,...change}),undefined)
})
test('unknown send cannot be reconciled from somebody else quoting identical text', () => {
  assert.equal(verifyTaskNotificationReadback(notification,observed),undefined)
  assert.ok(verifyTaskNotificationReadback(notification,{...observed,uuid:'n'}))
  assert.ok(verifyTaskNotificationReadback(notification,{...observed,senderId:'bot'},{senderActorId:'bot'}))
  assert.equal(verifyTaskNotificationReadback(notification,{...observed,senderId:'other'},{senderActorId:'bot'}),undefined)
})

test('exact successful delivery can distinguish unavailable mention metadata from verification', async () => {
  const message = { ...observed, senderId: 'bot', atOpenDingTalkIds: undefined }
  const pending = { ...notification, ack: { openTaskId: 'send-task' } }
  const status = { result: { sendStatus: 'SUCCESS', openConversationId: 'g', openMessageId: 'm' } }
  const adapter = { querySendStatus: async id => { assert.equal(id, 'send-task'); return status }, readMessage: async (group, id) => {
    assert.equal(group, 'g'); assert.equal(id, 'm'); return message
  } }
  const proof = await readTaskNotificationDelivery(adapter, pending, { senderActorId: 'bot' })
  assert.equal(proof.messageId, 'm')
  assert.equal(proof.mentionVerification, 'unavailable')
  assert.deepEqual(proof.atOpenDingTalkIds, [])
  const options = { acknowledgedMessageId: 'm', senderActorId: 'bot', sendStatusConfirmed: true }
  for (const change of [{ quotedMessage: undefined }, { quotedMessage: { messageId: 'wrong', conversationId: 'g' } },
    { text: 'wrong' }, { senderId: 'other' }, { atOpenDingTalkIds: ['other'] }, { conversationId: 'other' }]) {
    assert.equal(verifyTaskNotificationReadback(notification, { ...message, ...change }, options), undefined)
  }
  assert.equal(verifyTaskNotificationReadback(notification, message, { ...options, sendStatusConfirmed: false }), undefined)
  assert.equal(verifyTaskNotificationReadback(notification, { ...message, uuid: 'n' }, { senderActorId: 'bot' }), undefined)
  assert.equal(await readTaskNotificationDelivery(adapter, pending), undefined)
  status.result.sendStatus = 'SENDING'
  assert.equal(await readTaskNotificationDelivery(adapter, pending, { senderActorId: 'bot' }), undefined)
})

test('send status cannot replace a different acknowledged message identity', async () => {
  const adapter = { querySendStatus: async () => ({ result: { sendStatus: 'SUCCESS', openConversationId: 'g', openMessageId: 'other' } }),
    readMessage: async () => { throw new Error('must not read a conflicting message') } }
  assert.equal(await readTaskNotificationDelivery(adapter, { ...notification, ack: { messageId: 'm', openTaskId: 'send-task' } }), undefined)
})
