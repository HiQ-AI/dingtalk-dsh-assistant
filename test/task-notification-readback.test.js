import test from 'node:test'
import assert from 'node:assert/strict'
import { readTaskNotificationDelivery, verifyTaskNotificationReadback, readOperatorNotificationDelivery } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'
const notification = { id: 'n', payload: { conversationId: 'g', sourceMessageId: 's', text: '核验完成。', atOpenDingTalkIds: ['u'] } }
const observed = { messageId: 'm', conversationId: 'g', text: '核验完成。', quotedMessage: { messageId: 's', conversationId: 'g' }, atOpenDingTalkIds: ['u'] }

test('私聊申请按原发送收据回读，发送结果未知仅精确查找，不退回群聊或重发', async () => {
  const calls = [], privateNotice = { payload: { humanRequestId: 'human-request', recipientUserId: 'login-user', text: '技术申请' } }
  const proof = { messageId: 'notice', conversationId: 'self', senderActorId: 'actual-login-actor' }
  const adapter = { async confirmSelfDelivery(args) { calls.push(['confirm', args]); return proof },
    async findWorkflowApprovalNotice(args) { calls.push(['find', args]); return proof } }
  assert.deepEqual(await readOperatorNotificationDelivery(adapter, { ...privateNotice, ack: { openTaskId: 'send-ack' } }), proof)
  assert.deepEqual(await readOperatorNotificationDelivery(adapter, privateNotice), proof)
  assert.deepEqual(calls.map(item => item[0]), ['confirm', 'find'])
  assert.equal(calls[0][1].recipientUserId, 'login-user')
  adapter.confirmSelfDelivery = async () => ({ messageId: 'notice', conversationId: 'self' })
  assert.equal(await readOperatorNotificationDelivery(adapter, { ...privateNotice, ack: { openTaskId: 'send-ack' } }), undefined)
})
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

test('DWS无序列表只消除项间换行，正文、围栏和段落边界不可吞并', async () => {
  const { sameDeliveredText } = await import('../packages/dingtalk-dsh-assistant/group-message.js')
  const expected = '结论。\n\n- 验证 A B 通过。\n\n- 版本 `v1` 已读回。\n\n范围有限。\n\n- 署名'
  const rendered = '结论。\n- 验证 A B 通过。- 版本 **v1** 已读回。\n范围有限。\n- 署名'
  assert.equal(sameDeliveredText('@用户 '+rendered, expected, {sender:'用户'}), true)
  assert.equal(sameDeliveredText('- A- B', '- A\n- B'), true)
  assert.equal(sameDeliveredText('- A- B', '- A\r\n\r\n- B'), true)
  for (const changed of [rendered.replace('A B','AB'), rendered.replace('v1','v2'), rendered.replace('- 版本','版本'),
    rendered.replace('。\n范围','。范围'), rendered+'附加内容']) assert.equal(sameDeliveredText(changed, expected), false)
  for (const fence of ['```','~~~']) assert.equal(sameDeliveredText(`${fence}\n- A- B\n${fence}`,`${fence}\n- A\n\n- B\n${fence}`),false)
  assert.equal(sameDeliveredText('  - A- B','  - A\n  - B'),false)
  assert.equal(sameDeliveredText('- A正文- B','- A\n正文\n- B'),false)
})

test('未知列表通知仅按原发送回执回读结清，内容或身份不符不结清且不重发', async () => {
  const { deliverTaskNotification } = await import('../packages/dingtalk-dsh-assistant/notification-delivery.js')
  const pending = {...notification, state:'unknown', sendAttemptCount:1, ack:{openTaskId:'original-send'}, payload:{...notification.payload,text:'- A B\n\n- C'}}
  const message = {...observed, senderId:'bot', text:'- A B- C'}
  const adapter = {querySendStatus:async id=>{assert.equal(id,'original-send');return {result:{sendStatus:'SUCCESS'},messageRef:{openConversationId:'g',openMessageId:'m'}}}, readMessage:async()=>message}
  const notifications={send:async()=>assert.fail('unknown must never resend'),readback:n=>readTaskNotificationDelivery(adapter,n,{senderActorId:'bot'})}
  const commands=[]
  await deliverTaskNotification({notification:pending,notifications,command:async(kind,args)=>commands.push({kind,args})})
  assert.equal(commands[0].kind,'notification.reconcile');assert.equal(commands[0].args.receipt.messageId,'m')
  assert.equal(pending.sendAttemptCount,1)
  for(const patch of [{text:'- AB- C'},{senderId:'other'},{quotedMessage:{messageId:'wrong',conversationId:'g'}},{atOpenDingTalkIds:['wrong']}]) {
    const before={...message};Object.assign(message,patch);commands.length=0
    await deliverTaskNotification({notification:pending,notifications,command:async(kind,args)=>commands.push({kind,args})})
    assert.equal(commands[0].kind,'notification.diagnostic');Object.assign(message,before)
  }
})
