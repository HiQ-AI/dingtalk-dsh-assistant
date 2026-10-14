import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyTaskNotificationReadback } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
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
