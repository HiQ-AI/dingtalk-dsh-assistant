import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createDwsAdapter, dispatchOutbox, dwsIdempotencyKey, matchesOutbound } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { assertGroupReply, persistedUuidSendRejectionProof, sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'

test('DWS adapter 默认禁用且不会调用 runner', async () => {
  let calls = 0
  const runner = { run: async () => { calls += 1 }, spawn: () => { calls += 1 } }
  const adapter = createDwsAdapter({ runner })
  await assert.rejects(() => adapter.readGroup('cid-a'), /dws_adapter_disabled/)
  assert.throws(() => adapter.startGroupSubscription('cid-a', () => {}), /dws_adapter_disabled/)
  assert.throws(() => adapter.startHumanReplySubscription(() => {}), /dws_adapter_disabled/)
  assert.equal(calls, 0)
})

test('群监听等待 ready 后逐行交付且坏行不吞后续事件', async () => {
  let hooks
  const runner = { run: async () => undefined, spawn(args, value) { hooks = value; return { done: Promise.resolve(), terminate: (signal) => signal } } }
  const adapter = createDwsAdapter({ enabled: true, runner })
  const events = []
  const errors = []
  const subscription = adapter.startGroupSubscription('cid-a', (event) => events.push(event))
  subscription.lifecycle.on('line-error', (error) => errors.push(error.message))
  hooks.onStdoutLine('{"message_id":"early"}')
  hooks.onStderrLine('[event] ready event_key=user_im_message_receive_group bus_pid=1 subscribe_id=s1')
  hooks.onStdoutLine('not-json')
  hooks.onStdoutLine('{"message_id":"m1","conversation_id":"cid-a"}')

  assert.deepEqual(events.map((event) => event.message_id), ['m1'])
  assert.deepEqual(errors, ['dws_event_before_ready', 'Unexpected token \'o\', "not-json" is not valid JSON'])
  assert.equal(subscription.stop(), 'SIGTERM')
})

test('个人IM监听等待ready后交付引用回复', async () => {
  let hooks
  const runner = { run: async () => undefined, spawn(args, value) { hooks = value; assert.deepEqual(args, ['event', '+listen-im', '--kind', 'all-direct', '--events', 'message', '--format', 'ndjson']); return { done: Promise.resolve(), terminate: (signal) => signal } } }
  const adapter = createDwsAdapter({ enabled: true, runner })
  const events = []
  const errors = []
  const subscription = adapter.startHumanReplySubscription((event) => events.push(event))
  subscription.lifecycle.on('line-error', (error) => errors.push(error.message))
  hooks.onStdoutLine('{"message_id":"early"}')
  hooks.onStderrLine('[event] ready event_key=user_im_message_receive_o2o_all bus_pid=1 subscribe_id=s1')
  hooks.onStdoutLine('{"message_id":"reply-1","conversation_id":"self-cid","quotedMessage":{"messageId":"request-1"}}')

  assert.deepEqual(events.map((event) => event.message_id), ['reply-1'])
  assert.deepEqual(errors, ['dws_event_before_ready'])
  assert.equal(subscription.stop(), 'SIGTERM')
})

test('DWS profile固定附加到订阅、回读和发送命令', () => {
  const adapter = createDwsAdapter({ enabled: true, profile: 'corp:user', runner: { run: async () => undefined, spawn: () => undefined } })
  assert.deepEqual(adapter.compileGroupListen('cid-a').slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileHumanReplyListen().slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileGroupRead('cid-a').slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileGroupSend({ groupId: 'cid-a', text: 'reply', idempotencyKey: 'out-1' }).slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileSelfSend({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-1' }).slice(-2), ['--profile', 'corp:user'])
  assert.deepEqual(adapter.compileMessageRecall('message-1').slice(-2), ['--profile', 'corp:user'])
  const reply = adapter.compileGroupReply({ groupId: 'cid-a', text: 'done', idempotencyKey: 'out-2', replyToMessageId: 'm-source', replyToSenderOpenDingTalkId: 'od-requester', atOpenDingTalkIds: ['od-requester'] })
  assert.equal(reply.includes('--ref-msg-id'), true)
  assert.equal(reply.includes('--at-open-dingtalk-ids'), true)
})

test('Task完成通知使用DWS原生引用回复并@提出人', async () => {
  let reads = 0, sendAttempts = 0, readbackAttempts = 0
  let request
  const adapter = {
    async readGroup() { reads += 1; return { complete: true, messages: reads === 1 ? [] : [{ messageId: 'done-id', text: 'done', quotedMessage: { messageId: 'm-source' } }] } },
    async sendGroupReply(value) { request = value; return { deliveryStatus: 'success' } },
  }
  const result = await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-done', text: 'done', replyToMessageId: 'm-source', replyToSenderOpenDingTalkId: 'od-requester', atOpenDingTalkIds: ['od-requester'] }, beforeSend: async () => { sendAttempts += 1; return true }, beforeReadback: async () => { readbackAttempts += 1 } })
  assert.equal(result.status, 'sent')
  assert.equal(sendAttempts, 1)
  assert.equal(readbackAttempts, 2)
  assert.deepEqual(request.atOpenDingTalkIds, ['od-requester'])
  assert.equal(request.replyToMessageId, 'm-source')
})

test('普通群发仅传输正文编码原生提及，引用交由DWS补齐且持久业务正文不变', async () => {
  const commands = [], text = '提醒你查看云端专家的开发进度。'
  const recipients = ['open-person-a', 'open-person-b'], before = [...recipients]
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, profile: 'corp:user', runner: { run: async args => {
    commands.push(args); return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open' } }) }
  } } })
  for (const quoted of [false, true]) {
    const notification = { id: `notice-${quoted}`, payload: { conversationId: 'group-id', text,
      atOpenDingTalkIds: recipients, ...(quoted ? { sourceMessageId: 'source-message', actorId: recipients[0] } : {}) } }
    await sendWorkflowNotification(adapter, notification)
    const args = commands.at(-1)
    assert.equal(args[args.indexOf('--at-open-dingtalk-ids') + 1], recipients.join(','))
    assert.equal(args[args.indexOf(quoted ? '--content' : '--text') + 1], quoted ? text : `<@open-person-a> <@open-person-b> ${text}`)
    assert.equal(args.includes('--at-user-ids'), false)
    assert.equal(args.includes('--at-all'), false)
    assert.deepEqual(args.slice(-2), ['--profile', 'corp:user'])
    assert.equal(args.includes('--yes'), true)
    if (quoted) {
      assert.equal(args[args.indexOf('--ref-msg-id') + 1], 'source-message')
      assert.equal(args[args.indexOf('--ref-sender') + 1], recipients[0])
    } else assert.equal(args[args.indexOf('--as') + 1], 'user')
    assert.equal(notification.payload.text, text)
  }
  assert.deepEqual(recipients, before)
  assert.equal(commands.length, 2)
})

test('普通与引用发送空提及不添加任何@参数，非法列表在调用DWS前拒绝', async () => {
  let calls = 0
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => { calls++; return { exitCode: 0, stdout: '{}' } } } })
  const request = { groupId: 'group-id', text: '核验完成。', idempotencyKey: 'notice-id', replyToMessageId: 'source-message', replyToSenderOpenDingTalkId: 'open-person-a' }
  for (const compile of [args => adapter.compileGroupSend(args), args => adapter.compileGroupReply(args)]) {
    for (const atOpenDingTalkIds of [undefined, []]) {
      const args = compile({ ...request, atOpenDingTalkIds })
      assert.equal(args.some(arg => arg.startsWith('--at-')), false)
      assert.equal(args[args.indexOf(args.includes('--content') ? '--content' : '--text') + 1], request.text)
    }
  }
  for (const atOpenDingTalkIds of [null, 'open-person-a', {}, [null], [42], [''], [' '], ['open,a'], ['open a'], ['open\na'], ['"open"'], ['open>'], ['<open'], ['open@all']]) {
    await assert.rejects(adapter.sendGroup({ ...request, atOpenDingTalkIds }), /dws_at_open_dingtalk_ids_invalid/u)
    await assert.rejects(adapter.sendGroupReply({ ...request, atOpenDingTalkIds }), /dws_at_open_dingtalk_ids_invalid/u)
  }
  assert.equal(calls, 0)
})

test('无引用outbox透传原生提及且空列表不会补为全员', async () => {
  for (const atOpenDingTalkIds of [undefined, [], ['open-person-a']]) {
    let reads = 0, sent
    const adapter = { readGroup: async () => ({ complete: true, messages: ++reads === 1 ? [] : [{ messageId: 'delivered', text: '提醒查看进度。' }] }),
      sendGroup: async request => { sent = request; return { deliveryStatus: 'success' } } }
    const result = await dispatchOutbox({ adapter, groupId: 'group-id', outbound: { outboundId: 'notice-id', text: '提醒查看进度。', atOpenDingTalkIds } })
    assert.equal(result.status, 'sent')
    assert.deepEqual(sent.atOpenDingTalkIds, atOpenDingTalkIds ?? [])
    assert.equal(sent.text, '提醒查看进度。')
  }
})

test('外发正文拒绝已知身份与运行时前缀，保留业务编号和普通链接而不静默改写', () => {
  const hash = 'a'.repeat(32)
  for (const id of [`coordination-${hash}`, `schedule:coordination-${hash}`, `time:${hash}`, `human-${hash}`,
    `coordination:coordination-${hash}:summary:1`, `task-${hash}`, `session-${hash}`]) {
    assert.throws(() => assertGroupReply(`当前安排：${id}`), error => error.code === 'GROUP_REPLY_INTERNAL_DETAILS')
  }
  for (const id of ['known-source-1', '329881099', 'open+person/id==', 'short'])
    assert.throws(() => assertGroupReply(`原始标识：${id}。`, [id]), /GROUP_REPLY_INTERNAL_DETAILS/u)
  assert.throws(() => assertGroupReply('附加xknown-source-1suffix', ['known-source-1']), /GROUP_REPLY_INTERNAL_DETAILS/u)
  const business = '业务单号 TIME-20261023-001，PR #255，https://example.com/docs/schedule-reference；请查看库存开票进度。'
  assert.doesNotThrow(() => assertGroupReply(business, ['id', 'time']))
  assert.equal(business.includes('TIME-20261023-001'), true)
})

test('遗漏knownIds时仍拦截源码确认的unit/topic/execution/coord-route精确格式', () => {
  for (const [prefix, length] of [['unit', 32], ['topic', 32], ['execution', 40], ['coord-route', 64]]) {
    assert.throws(() => assertGroupReply(`当前状态：${prefix}-${'a'.repeat(length)}`), /GROUP_REPLY_INTERNAL_DETAILS/u)
    assert.doesNotThrow(() => assertGroupReply(`业务单号 ${prefix}-20261023-001，链接 https://example.com/${prefix}-guide`))
    for (const otherLength of [length - 1, length + 1])
      assert.doesNotThrow(() => assertGroupReply(`参考编号 ${prefix}-${'a'.repeat(otherLength)}`))
  }
})

test('合法业务URL的同形编号保留，已知内部身份藏在URL中仍拒绝且正文不改写', () => {
  for (const [prefix, length] of [['unit', 32], ['topic', 32], ['execution', 40], ['coord-route', 64]]) {
    const id = `${prefix}-${'a'.repeat(length)}`, text = `查看业务记录：https://crm.example.com/${id}`
    assert.doesNotThrow(() => assertGroupReply(text))
    assert.throws(() => assertGroupReply(text, [id]), /GROUP_REPLY_INTERNAL_DETAILS/u)
    assert.throws(() => assertGroupReply(`链接：https://[invalid]/${id}`), /GROUP_REPLY_INTERNAL_DETAILS/u)
    assert.throws(() => assertGroupReply(`链接：https://crm.example.com/detail。内部标识：${id}`), /GROUP_REPLY_INTERNAL_DETAILS/u)
    assert.equal(text, `查看业务记录：https://crm.example.com/${id}`)
  }
})

test('通知正文检查全部已知身份和fact标识，结构化身份保留且零外发拒绝', async () => {
  let calls = 0
  const notification = { id: 'opaque-notification', taskId: 'opaque-task', payload: {
    conversationId: 'opaque-conversation', sourceMessageId: 'opaque-source', actorId: 'opaque-actor', recipientUserId: 'opaque-user',
    humanRequestId: 'opaque-human', atOpenDingTalkIds: ['opaque-mention'],
    fact: { coordinationId: 'opaque-coordination', occurrenceId: 'opaque-occurrence', eventId: 'opaque-event',
      resultDigest: 'b'.repeat(64), taskIds: ['opaque-task-list'], topicRefs: [{ topicId: 'opaque-topic' }], title: '业务进度', revision: 1 } } }
  const adapter = { sendGroup: async () => { calls++ }, sendGroupReply: async () => { calls++ } }
  const internalIds = ['opaque-notification', 'opaque-task', 'opaque-conversation', 'opaque-source', 'opaque-actor', 'opaque-user',
    'opaque-human', 'opaque-mention', 'opaque-coordination', 'opaque-occurrence', 'opaque-event', 'b'.repeat(64), 'opaque-task-list', 'opaque-topic']
  for (const id of internalIds) {
    notification.payload.text = `请查看进度：${id}。`
    const before = structuredClone(notification)
    assert.throws(() => sendWorkflowNotification(adapter, notification), /GROUP_REPLY_INTERNAL_DETAILS/u)
    assert.deepEqual(notification, before)
  }
  assert.equal(calls, 0)
  notification.payload.text = '业务进度已核实，数量 1。'
  await sendWorkflowNotification(adapter, notification)
  assert.equal(calls, 1)
})

test('私聊与群聊共用正文门禁，私聊已知身份拒绝前不调用DWS', async () => {
  let calls = 0
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => {
    calls++; return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open' } }) }
  } } })
  const request = { userId: 'recipient-id', idempotencyKey: 'notice-id', taskId: 'opaque-task', requestId: 'request-id', humanRequestId: 'human-id' }
  for (const value of [...Object.values(request), `human-${'c'.repeat(64)}`, `time:${'d'.repeat(64)}`])
    await assert.rejects(adapter.sendSelfIntent({ ...request, text: `需要确认：${value}` }), /GROUP_REPLY_INTERNAL_DETAILS/u)
  assert.equal(calls, 0)
  await adapter.sendSelfIntent({ ...request, text: '请核对业务单 20261023，链接 https://example.com/orders/20261023。' })
  assert.equal(calls, 1)
})

test('引用回复回读即使正文完全相同也必须匹配quoted message ID', () => {
  const outbound = { text: '完全相同的回复正文', replyToMessageId: 'expected-source' }
  assert.equal(matchesOutbound({ text: outbound.text }, outbound), false)
  assert.equal(matchesOutbound({ text: outbound.text, quotedMessage: { messageId: 'other-source' } }, outbound), false)
  assert.equal(matchesOutbound({ text: outbound.text, quotedMessage: { messageId: 'expected-source' } }, outbound), true)
})

test('无引用回复不能认领其他话题的同文引用回复', () => {
  assert.equal(matchesOutbound({ text: '收到，开始处理', quotedMessage: { messageId: 'topic-b-source' } }, { text: '收到，开始处理' }), false)
  assert.equal(matchesOutbound({ text: '收到，开始处理' }, { text: '收到，开始处理' }), true)
})

test('话题 A 的同文回复不阻止话题 B 的发送和精确回读', async () => {
  let reads = 0, sends = 0
  const adapter = {
    async readGroup() { reads += 1; return { complete: true, messages: [{ messageId: 'sent-a', text: '开始处理', quotedMessage: { messageId: 'source-a' } }, ...(reads > 1 ? [{ messageId: 'sent-b', text: '开始处理', quotedMessage: { messageId: 'source-b' } }] : [])] } },
    async sendGroupReply() { sends += 1; return { deliveryStatus: 'success' } },
  }
  const result = await dispatchOutbox({ adapter, groupId: 'g', outbound: { outboundId: 'out-b', text: '开始处理', replyToMessageId: 'source-b', replyToSenderOpenDingTalkId: 'sender-b' } })
  assert.equal(sends, 1)
  assert.equal(result.messageId, 'sent-b')
})

test('短引用回复允许钉钉补充前导@但仍要求精确quoted message ID', () => {
  const outbound = { text: '这个事项是否需要我处理？\n\n- 小小鹏代回', replyToMessageId: 'expected-source' }
  assert.equal(matchesOutbound({ text: '@当前用户  这个事项是否需要我处理？\n- 小小鹏代回', quotedMessage: { messageId: 'expected-source' } }, outbound), true)
  assert.equal(matchesOutbound({ text: '@当前用户  这个事项是否需要我处理？\n- 小小鹏代回', quotedMessage: { messageId: 'other-source' } }, outbound), false)
})

test('本人私聊发送通过openTaskId回查真实会话与消息ID', async () => {
  const calls = []
  const runner = { async run(args) { calls.push(args); return calls.length === 1
    ? { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open-task-1' } }) }
    : { exitCode: 0, stdout: JSON.stringify({ messageRef: { openConversationId: 'self-conversation', openMessageId: 'blocker-message' }, result: { sendStatus: 'SUCCESS' } }) } } }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner })
  assert.deepEqual(await adapter.sendSelf({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-1' }), { openTaskId: 'open-task-1', conversationId: 'self-conversation', messageId: 'blocker-message' })
  assert.equal(calls[0].includes('--yes'), true)
})

test('本人私聊发送等待DWS异步投递完成后再记录消息ID', async () => {
  let calls = 0
  const runner = { async run() {
    calls += 1
    if (calls === 1) return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open-task-delayed' } }) }
    if (calls === 2) return { exitCode: 0, stdout: JSON.stringify({ result: { sendStatus: 'PROCESSING' } }) }
    return { exitCode: 0, stdout: JSON.stringify({ messageRef: { openConversationId: 'self-conversation', openMessageId: 'delayed-message' }, result: { sendStatus: 'SUCCESS' } }) }
  } }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner })
  const result = await adapter.sendSelf({ userId: 'self-user', text: 'blocked', idempotencyKey: 'blocker-delayed' })
  assert.equal(calls, 3)
  assert.equal(result.messageId, 'delayed-message')
})

test('原生私聊审批先取得openTaskId，确认只读回查真实ID及完整冻结正文',async()=>{
 const calls=[],text='**待审批**\n\n批准这项操作\nSQL: SELECT  process_id FROM public.process_id_temp;\r\n审批请求 ID：approval-1'
 let pending=true,observed=text
 const runner={async run(args){calls.push(args);if(args.includes('+messages-send'))return{exitCode:0,stdout:JSON.stringify({sendReceipt:{openTaskId:'operation'}})};
  if(args.includes('+messages-query-send-status'))return{exitCode:0,stdout:JSON.stringify({result:{sendStatus:pending?'PROCESSING':'SUCCESS'},messageRef:{openConversationId:'private',openMessageId:'notice'}})};
  return{exitCode:0,stdout:JSON.stringify({complete:true,hasMore:false,failedCount:0,failures:[],foundCount:1,notFoundMessageIds:[],messages:[{conversationId:'private',messageId:'notice',recipientUserId:'recipient',text:observed}]})}}}
 const adapter=createDwsAdapter({enabled:true,writesAuthorized:true,runner})
 assert.deepEqual(await adapter.sendSelfIntent({userId:'recipient',text,idempotencyKey:'frozen'}),{openTaskId:'operation'})
 assert.equal(calls.length,1)
 assert.equal(await adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),undefined)
 pending=false;assert.deepEqual(await adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),{openTaskId:'operation',conversationId:'private',messageId:'notice'})
 observed=text.replace(/\n\n/gu,'  \n');assert.deepEqual(await adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),{openTaskId:'operation',conversationId:'private',messageId:'notice'})
 observed=text.replace(/\r?\n/gu,' ');assert.deepEqual(await adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),{openTaskId:'operation',conversationId:'private',messageId:'notice'})
 for(const changed of [observed.replace('SELECT  ','SELECT '),observed.replace('process_id FROM','process_id2 FROM'),observed.replace(';','')]) {
  observed=changed;await assert.rejects(adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),/content_mismatch/)
 }
 observed='另一个审批';await assert.rejects(adapter.confirmSelfDelivery({openTaskId:'operation',recipientUserId:'recipient',text}),/content_mismatch/)
 assert.equal(calls.filter(args=>args.includes('+messages-send')).length,1)
})

test('未知私聊审批只认完整正文及权威收件人，模糊/他人/缺身份/截断结果不能认领',async()=>{
 const text='审批编号：123456789abc\nSQL: SELECT  process_id FROM public.process_id_temp;\r\n完整范围',request={requestId:'external:full-request-123456789abc',recipientUserId:'recipient',text}
 let messages=[],partial=false
 const runner={async run(args){if(args.includes('+search-msg')){assert.equal(args[args.indexOf('--query')+1],'123456789abc');return{exitCode:0,stdout:JSON.stringify({complete:!partial,hasMore:partial,messages})}};return{exitCode:0,stdout:JSON.stringify({complete:true,failedCount:0,failures:[],foundCount:1,notFoundMessageIds:[],messages})}}}
 const adapter=createDwsAdapter({enabled:true,runner})
 for(const message of [{text:text+'多余字',recipientUserId:'recipient'},{text,recipientUserId:'other'},{text}]) {
  messages=[{conversationId:'private',messageId:'notice',...message}];assert.equal(await adapter.findWorkflowApprovalNotice(request),undefined)
 }
 messages=[{conversationId:'private',messageId:'notice',recipientUserId:'recipient',text}]
 assert.deepEqual(await adapter.findWorkflowApprovalNotice(request),{conversationId:'private',messageId:'notice'})
 messages[0].text=text.replace(/\r?\n/gu,' ')
 assert.deepEqual(await adapter.findWorkflowApprovalNotice(request),{conversationId:'private',messageId:'notice'})
 for(const changed of [messages[0].text.replace('SELECT  ','SELECT '),messages[0].text.replace('process_id FROM','process_id2 FROM'),messages[0].text.replace(';','')]) {
  messages[0].text=changed;assert.equal(await adapter.findWorkflowApprovalNotice(request),undefined)
 }
 partial=true;await assert.rejects(adapter.findWorkflowApprovalNotice(request),/search_partial/)
})

test('本人私聊回读限定起止时间但不设置消息条数上限', () => {
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => undefined, spawn: () => undefined } })
  const args = adapter.compileConversationRead('self-conversation', { start: '2026-08-24T10:00:00.000Z', end: '2026-08-24T18:00:00.000Z' })
  assert.equal(args.includes('--page-all'), true)
  assert.equal(args.includes('--max-items'), false)
  assert.equal(args.includes('--page-limit'), false)
})

test('群范围回补自动翻页但不设人为消息条数上限', () => {
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => undefined, spawn: () => undefined } })
  const args = adapter.compileGroupReadRange('group-a', { start: '2026-09-02T00:00:00.000Z', end: '2026-09-02T01:00:00.000Z' })
  assert.equal(args.includes('--page-all'), true)
  assert.equal(args.includes('--page-limit'), true)
  assert.equal(args.includes('--max-items'), false)
})

test('outbox 回读命中跳过发送，未命中则只发一次并回读真实消息 ID', async () => {
  const existing = { readGroup: async () => ({ complete: true, messages: [{ messageId: 'existing-id', text: 'reply' }] }), sendGroup: async () => { throw new Error('must not send') } }
  assert.deepEqual(await dispatchOutbox({ adapter: existing, groupId: 'cid-a', outbound: { outboundId: 'out-1', text: 'reply' } }), { status: 'sent', messageId: 'existing-id', deduplicated: true })

  let reads = 0
  let sends = 0
  const fresh = {
    async readGroup() { reads += 1; return { complete: true, messages: reads === 1 ? [] : [{ messageId: 'real-id', text: 'reply' }] } },
    async sendGroup(request) { sends += 1; assert.equal(request.idempotencyKey, 'out-2'); return { deliveryStatus: 'success' } },
  }
  assert.deepEqual(await dispatchOutbox({ adapter: fresh, groupId: 'cid-a', outbound: { outboundId: 'out-2', text: 'reply' } }), { status: 'sent', messageId: 'real-id', deduplicated: false })
  assert.equal(sends, 1)
})

test('outbox 历史不完整或投递未知时保持 pending 不盲重发', async () => {
  const partial = { readGroup: async () => ({ complete: false, messages: [] }) }
  assert.deepEqual(await dispatchOutbox({ adapter: partial, groupId: 'cid-a', outbound: { outboundId: 'out-3', text: 'reply' } }), { status: 'pending', reason: 'preflight_history_partial' })

  const unknown = { readGroup: async () => ({ complete: true, messages: [] }), sendGroup: async () => ({ deliveryStatus: 'unknown' }) }
  assert.deepEqual(await dispatchOutbox({ adapter: unknown, groupId: 'cid-a', outbound: { outboundId: 'out-4', text: 'reply' } }), { status: 'pending', reason: 'delivery_unknown', sendResult: { deliveryStatus: 'unknown' } })
})

test('组织未授权导致发送前检查失败时不发送，不绕过真实回读', async () => {
  let sends = 0
  const denied = () => { const error = new Error('dws_read_failed:1:CLI_ORG_NOT_AUTHORIZED'); error.serverErrorCode = 'CLI_ORG_NOT_AUTHORIZED'; throw error }
  const adapter = {
    readGroup: denied,
    async sendGroup(request) { sends += 1; assert.equal(request.idempotencyKey, 'out-permission'); return { deliveryStatus: 'success', messageRef: { openMessageId: 'sent-by-receipt' } } },
  }
  await assert.rejects(dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-permission', text: 'reply' } }),
    (error) => error.serverErrorCode === 'CLI_ORG_NOT_AUTHORIZED' && error.deliveryPendingReason === 'preflight_failed')
  assert.equal(sends, 0)
})

test('发送后组织未授权，空回执、失败回执、任务受理回执及成功回执均不能确认送达', async () => {
  for (const receipt of [{}, { deliveryStatus: 'failed' }, { openTaskId: 'accepted' }, { deliveryStatus: 'success', messageId: 'receipt-only' }]) {
    let reads = 0, sends = 0
    const adapter = {
      async readGroup() {
        if (++reads === 1) return { complete: true, messages: [] }
        const error = new Error('dws_read_failed:1:CLI_ORG_NOT_AUTHORIZED')
        error.serverErrorCode = 'CLI_ORG_NOT_AUTHORIZED'
        throw error
      },
      async sendGroup() { sends += 1; return receipt },
    }
    await assert.rejects(dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-receipt', text: 'reply' } }),
      (error) => error.serverErrorCode === 'CLI_ORG_NOT_AUTHORIZED' && error.deliveryPendingReason === 'postflight_failed')
    assert.equal(sends, 1)
  }
})

test('任意回执未在历史中匹配真实消息时保持 pending', async () => {
  for (const receipt of [null, {}, { deliveryStatus: 'failed' }, { openTaskId: 'accepted' }]) {
    const adapter = { readGroup: async () => ({ complete: true, messages: [] }), sendGroup: async () => receipt }
    const result = await dispatchOutbox({ adapter, groupId: 'g', outbound: { outboundId: 'out', text: 'reply' } })
    assert.equal(result.status, 'pending')
    assert.equal(result.reason, 'message_not_observed')
  }
})

test('历史命中但缺少真实消息ID时不得确认或盲目重发', async () => {
  for (const hit of ['before', 'history', 'after']) {
    let reads = 0, sends = 0
    const adapter = {
      async readGroup() { reads += 1; return { complete: true, messages: hit === 'before' || (hit === 'after' && reads > 1) ? [{ text: 'reply' }] : [] } },
      async findOutboundMessage() { return hit === 'history' ? { text: 'reply' } : undefined },
      async sendGroup() { sends += 1; return {} },
    }
    await assert.rejects(dispatchOutbox({ adapter, groupId: 'g', outbound: { outboundId: 'out', text: 'reply' } }), /outbox_message_id_required/)
    assert.equal(sends, hit === 'after' ? 1 : 0)
  }
})

test('DWS所有发送入口压缩超长uuid，128字符以内保持原值且不同后缀不碰撞', async () => {
  const sent = []
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async args => {
    sent.push(args); return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'open' } }) }
  } } })
  const compile = [
    key => adapter.compileGroupSend({ groupId: 'g', text: 't', idempotencyKey: key }),
    key => adapter.compileGroupReply({ groupId: 'g', text: 't', idempotencyKey: key, replyToMessageId: 'm', replyToSenderOpenDingTalkId: 'u' }),
    key => adapter.compileGroupFileSend({ groupId: 'g', fileName: 'report.txt', idempotencyKey: key }),
    key => adapter.compileSelfSend({ userId: 'u', text: 't', idempotencyKey: key }),
  ]
  const keyFrom = args => args[args.findIndex(value => value === '--uuid' || value === '--idempotency-key') + 1]
  for (const key of ['short', 'x'.repeat(128), 'x'.repeat(129), 'coordination:' + 'x'.repeat(124)]) {
    const expected = key.length <= 128 ? key : `dsh:sha256:${createHash('sha256').update(key).digest('hex')}`
    for (const build of compile) { assert.equal(keyFrom(build(key)), expected); assert.ok(keyFrom(build(key)).length <= 128) }
    assert.equal(dwsIdempotencyKey(dwsIdempotencyKey(key)), expected)
  }
  const prefix = 'x'.repeat(128)
  assert.notEqual(dwsIdempotencyKey(`${prefix}a`), dwsIdempotencyKey(`${prefix}b`))
  assert.deepEqual(await adapter.sendSelfIntent({ userId: 'u', text: 't', idempotencyKey: `${prefix}a` }), { openTaskId: 'open' })
  assert.equal(keyFrom(sent[0]), dwsIdempotencyKey(`${prefix}a`))
  for (const value of [undefined, '', ' ']) assert.throws(() => dwsIdempotencyKey(value), /idempotency_key_required/u)
})

test('私聊负回执只对服务端精确uuid拒绝声明确定未发送', async () => {
  const key = 'x'.repeat(156)
  for (const [serverErrorCode, errorMsg, known] of [
    ['1001', "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 156.", true],
    ['1001', 'network unknown', false],
    ['500', "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 156.", false],
    ['1001', "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 157.", false],
  ]) {
    const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => ({ exitCode: 1, stderr: JSON.stringify({ error: { server_error_code: serverErrorCode, errorMsg, trace_id: 'trace' } }) }) } })
    // 模拟旧版本已经编译的156字符请求；新发送会使用完整摘要后的有界键。
    adapter.compileSelfSend = () => ['existing-compiled-command', '--idempotency-key', key]
    await assert.rejects(adapter.sendSelfIntent({ userId: 'u', text: 't', idempotencyKey: key }), error => {
      assert.equal(error.serverErrorCode, serverErrorCode)
      assert.equal(error.knownNotSent === true, known)
      if (known) assert.deepEqual(error.proof, { kind: 'dws-uuid-rejected', idempotencyKey: key, serverErrorCode, errorMessage: errorMsg, traceId: 'trace' })
      return true
    })
  }
})

test('已压缩发送键不能以原内部ID长度构造确定未发送的负回执', async () => {
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => ({ exitCode: 1,
    stderr: JSON.stringify({ error: { server_error_code: '1001', trace_id: 'trace',
      errorMsg: "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 156." } }) }) } })
  await assert.rejects(adapter.sendSelfIntent({ userId: 'u', text: 't', idempotencyKey: 'x'.repeat(156) }), error => {
    assert.equal(error.knownNotSent, undefined); assert.equal(error.proof, undefined); return true
  })
})

test('持久uuid校验拒绝只认完整原尝试证据，缺失冲突或可能已发均保持未知', () => {
  const id = `coordination:${'x'.repeat(124)}`
  const error = { category: 'api', code: 1, origin: 'dingtalk_api', operation: 'tools/call', reason: 'invalid_request',
    retryable: false, server_error_code: 'PARAM_ERROR', server_key: 'chat', stage: 'tool_validation',
    message: "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 137." }
  const notification = { id, state: 'unknown', sendAttemptCount: 1, receipt: null, payloadDigest: 'a'.repeat(64), dispatchToken: 'original-fence',
    sendPermit: { notificationId: id, payloadDigest: 'a'.repeat(64), attempt: 1, fence: 'original-fence' },
    deliveryError: { phase: 'send', exitCode: 1, stdout: '', message: 'dws_send_failed:1:PARAM_ERROR', serverErrorCode: 'PARAM_ERROR',
      origin: 'dingtalk_api', operation: 'tools/call', reason: 'invalid_request', retryable: false, stderr: JSON.stringify({ error }) } }
  const before = structuredClone(notification), proof = persistedUuidSendRejectionProof(notification)
  assert.equal(proof.kind, 'dws-uuid-validation-rejected'); assert.equal(proof.actualLength, 137)
  assert.equal(proof.notificationId, id); assert.equal(proof.fence, notification.dispatchToken)
  assert.deepEqual(notification, before)
  for (const patch of [
    { state: 'starting' }, { state: 'delivered' }, { sendAttemptCount: 2 }, { sendAttemptCount: undefined },
    { ack: {} }, { receipt: {} }, { sendPermit: undefined }, { payloadDigest: 'b'.repeat(64) }, { dispatchToken: 'other-fence' },
  ]) assert.equal(persistedUuidSendRejectionProof({ ...notification, ...patch }), undefined)
  for (const patch of [{ notificationId: 'other' }, { payloadDigest: 'b'.repeat(64) }, { attempt: 2 }, { fence: 'other' }])
    assert.equal(persistedUuidSendRejectionProof({ ...notification, sendPermit: { ...notification.sendPermit, ...patch } }), undefined)
  for (const patch of [{ phase: 'readback' }, { exitCode: 0 }, { stdout: '{}' }, { serverErrorCode: 'TIMEOUT' }, { retryable: true },
    { origin: 'transport' }, { stderr: '{truncated' }])
    assert.equal(persistedUuidSendRejectionProof({ ...notification, deliveryError: { ...notification.deliveryError, ...patch } }), undefined)
  for (const patch of [{ stage: undefined }, { stage: 'execution' }, { message: 'PARAM_ERROR' }, { message: error.message.replace('137', '138') },
    { message: error.message.replace('137', '128') }, { message: error.message + ' extra' }, { category: 'network' }, { code: 2 },
    { origin: 'mcp_gateway' }, { operation: 'chat/get_conversation_info' }, { reason: 'timeout' }, { retryable: true },
    { server_error_code: '1001' }, { server_key: 'other' }])
    assert.equal(persistedUuidSendRejectionProof({ ...notification, deliveryError: { ...notification.deliveryError,
      stderr: JSON.stringify({ error: { ...error, ...patch } }) } }), undefined)
  const shortId = 'x'.repeat(128)
  assert.equal(persistedUuidSendRejectionProof({ ...notification, id: shortId, sendPermit: { ...notification.sendPermit, notificationId: shortId },
    deliveryError: { ...notification.deliveryError, stderr: JSON.stringify({ error: { ...error, message: error.message.replace('137', '128') } }) } }), undefined)
})

test('DWS读取错误保留结构化服务端错误码', async () => {
  const stderr = JSON.stringify({ error: { server_error_code: 'CLI_ORG_NOT_AUTHORIZED' } })
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => ({ exitCode: 1, stdout: '', stderr }), spawn: () => undefined } })
  await assert.rejects(adapter.readGroup('cid-a'), (error) => error.message === 'dws_read_failed:1:CLI_ORG_NOT_AUTHORIZED' && error.serverErrorCode === 'CLI_ORG_NOT_AUTHORIZED')
})

test('DWS引用回复错误保留结构化服务端错误码', async () => {
  const stderr = JSON.stringify({ error: { server_error_code: 'CLI_ORG_NOT_AUTHORIZED' } })
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async () => ({ exitCode: 1, stdout: '', stderr }), spawn: () => undefined } })
  await assert.rejects(adapter.sendGroupReply({ groupId: 'cid-a', text: 'reply', idempotencyKey: 'out-1', replyToMessageId: 'm-1', replyToSenderOpenDingTalkId: 'user-1' }),
    (error) => error.message === 'dws_reply_failed:1:CLI_ORG_NOT_AUTHORIZED' && error.serverErrorCode === 'CLI_ORG_NOT_AUTHORIZED')
})

test('outbox 可使用无失败的最近消息窗口完成去重与投递确认', async () => {
  let reads = 0
  const adapter = {
    async readGroup() {
      reads += 1
      return { complete: false, partial: false, failedCount: 0, failures: [], messages: reads === 1 ? [] : [{ messageId: 'recent-id', text: 'reply' }] }
    },
    async sendGroup() { return { deliveryStatus: 'success' } },
  }
  assert.deepEqual(await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: { outboundId: 'out-recent', text: 'reply' } }), { status: 'sent', messageId: 'recent-id', deduplicated: false })
})

test('历史检查期间被替代的旧消息不能继续发送，领取持久失败同样零外发', async () => {
  let sends = 0
  const adapter = { readGroup: async () => ({ complete: true, messages: [] }), sendGroup: async () => { sends++ } }
  const args = { adapter, groupId: 'g', outbound: { outboundId: 'old', text: 'old' } }
  assert.deepEqual(await dispatchOutbox({ ...args, beforeSend: async () => false }), { status: 'superseded' })
  await assert.rejects(dispatchOutbox({ ...args, beforeSend: async () => { throw new Error('disk_full') } }), /disk_full/)
  assert.equal(sends, 0)
})

test('outbox 可识别钉钉补充@、移除Markdown并附加Agent签名后的已发送消息', async () => {
  let sends = 0
  const adapter = {
    async readGroup() {
      return { complete: false, partial: false, failedCount: 0, failures: [], messages: [{
        messageId: 'rendered-id',
        quotedMessage: { messageId: 'source-id' },
        text: '@李辰  锂电池数据库中英文 i18n 回填已完成：英文写入 en_US、中文写入 zh_CN。\n- Agent代回',
      }] }
    },
    async sendGroupReply() { sends += 1; return { deliveryStatus: 'success' } },
  }
  const result = await dispatchOutbox({ adapter, groupId: 'cid-a', outbound: {
    outboundId: 'out-rendered', replyToMessageId: 'source-id', replyToSenderOpenDingTalkId: 'requester',
    text: '锂电池数据库中英文 i18n 回填已完成：英文写入 `en_US`、中文写入 `zh_CN`。',
  } })
  assert.deepEqual(result, { status: 'sent', messageId: 'rendered-id', deduplicated: true })
  assert.equal(sends, 0)
})


test('历史待发正文在领取前拒绝内部机制，已发送记录仍可回读', async () => {
 let sends=0,claims=0
 const outbound={outboundId:'out-public',text:'执行会话已启动'}
 const adapter={readGroup:async()=>({complete:true,messages:[]}),sendGroup:async()=>{sends++}}
 await assert.rejects(dispatchOutbox({adapter,groupId:'g',outbound,beforeSend:async()=>{claims++;return true}}),error=>error.code==='GROUP_REPLY_INTERNAL_DETAILS' && error.deliveryPendingReason==='preflight_failed')
 assert.equal(sends,0);assert.equal(claims,0)
 const delivered={...adapter,readGroup:async()=>({complete:true,messages:[{messageId:'m',outboundId:'out-public',text:outbound.text}]})}
 assert.equal((await dispatchOutbox({adapter:delivered,groupId:'g',outbound})).deduplicated,true)
})
