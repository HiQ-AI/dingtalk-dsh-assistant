import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory, nativeRemove } from './fixtures/native-lifecycle.js'
import { available, reason, nativeTaskHost, latestInput, modelToolValues } from './fixtures/task-session-native-host.js'

const message = (id, text, extra = {}) => ({ groupId: 'native-group', messageId: id, text, senderName: '测试用户', senderOpenDingTalkId: 'native-user',
  sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z', ...extra })
const question = '请说明要核查哪一张发票？'
function hold(request, clarify = true) {
  const input = latestInput(request)
  const previous = modelToolValues(request).at(-1)
  if (previous?.status === 'context-required' && previous.nextCall) return [{ name: previous.nextCall.name, args: previous.nextCall.arguments }]
  const scope = [...(input.topics ?? []), ...(input.relatedTopics ?? []), ...(input.recalledTopics ?? [])].find(topic => topic.title === '独立范围事项')
  assert.ok(request.tools.some(tool => tool.name === 'group_topic_route_submit'))
  return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({
    messageId: item.messageId, messageVersion: item.messageVersion, deferred: { reason: '事项对象不明确', ...(scope && clarify ? { scope: [{ topicId: scope.topicId, revision: scope.revision }] } : {}), ...(clarify ? { clarification: {
      question, assignmentQuote: item.text, replyReview: { kind: 'substantive',
        reviewedOutboundIds: (input.clarificationReviewCandidates ?? []).map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
    } } : {}) },
  })) } }]
}

test('明确交办的澄清沿真实通知账送达；待判来源不结清，冷恢复不重问且自身回声不解锁',
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-native-'))
    let host
    t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => hold(request)))
    await t.step(() => scopeTopic(host))
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('clarify', '@测试助手 请核查那张发票。')))
    await t.step(() => host.service.whenIdle())
    const notification = (await t.step(() => host.query('notification.list')))[0]
    assert.ok(notification, JSON.stringify(host.service.listAlerts()))
    assert.equal(notification.kind, 'routing-clarification')
    assert.equal(notification.state, 'delivered')
    assert.equal(notification.taskId, null)
    assert.deepEqual(notification.payload.topicRefs, [])
    assert.equal(notification.payload.text, question)
    assert.equal(host.sent.length, 1)
    const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'clarify')
    assert.equal(held.routingStatus, 'needs-context')
    const source = (await t.step(() => host.query('source.list'))).find(item => item.messageId === 'clarify')
    assert.equal(source.routed, undefined)
    assert.equal(source.processingCompleted, undefined)
    assert.equal((await t.step(() => host.query('task.list'))).length, 0)
    assert.equal(host.residentStore.listTopics('native-group').length, 1)
    await t.step(() => host.service.ingest(message(notification.receipt.messageId, question, { quotedMessage: { messageId: 'clarify', content: '@测试助手 请核查那张发票。' } })))
    assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'clarify').routingStatus, 'needs-context')
    await t.step(() => host.close())
    host = await t.step(() => nativeTaskHost(root, () => assert.fail('冷恢复不得重新调用模型'), { initialize: false }))
    await t.step(() => host.service.recover())
    await t.step(() => host.service.whenIdle())
    assert.equal(host.sent.length, 0)
    assert.equal((await t.step(() => host.query('notification.list'))).length, 1)
    assert.equal((await t.step(() => host.query('notification.list')))[0].state, 'delivered')
    assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'clarify').routingStatus, 'needs-context')
    assert.equal((await t.step(() => host.query('source.list'))).find(item => item.messageId === 'clarify').processingCompleted, undefined)
  }))

for (const [name, text, extra, clarify] of [
  ['普通讨论不追问', '小王，那张发票的情况大家再讨论一下。', {}, true],
  ['未声明需要澄清的交办不自动发问', '测试助手，请核查那张发票。', {}, false],
  ['其他助手通知不追问', '测试助手，请核查那张发票。', { messageAiSendFlag: 'DWS' }, true],
  ['正文仅提到助手不算向助手交办', '小王，请看测试助手之前说的那张发票。', { mentionedAgent: false }, true],
]) test(name, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-silent-'))
  let host
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, request => hold(request, clarify)))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('silent', text, extra)))
  await t.step(() => host.service.whenIdle())
  assert.equal(host.sent.length, 0)
  assert.deepEqual(await t.step(() => host.query('notification.list')), [])
  const routed = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'silent')
  assert.equal(routed.routingStatus, 'routed')
  assert.equal(routed.units.find(unit => unit.fixedTopic === 'out-of-scope')?.fixedTopic, 'out-of-scope')
}))

test('发送许可前 epoch 已恢复时拒绝旧澄清，不产生网络发送',
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-race-'))
    let host, disclosed = false, sends = 0, oldNotificationId
    const resumedRoute = Promise.withResolvers(), rejected = Promise.withResolvers()
    t.onCancel(() => resumedRoute.resolve())
    t.after(async () => { resumedRoute.resolve(); await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, async request => {
      if (disclosed) { await resumedRoute.promise; return hold(request, false) }
      return hold(request)
    }, { notifications: {
      async canDisclose(notification) {
        if (!disclosed) {
          disclosed = true
          oldNotificationId = notification.id
          const source = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'race')
          await host.residentStore.updateRoutingHold({ groupId: 'native-group', messageId: source.messageId,
            messageVersion: source.messageVersion, epoch: source.routingHold.epoch, resume: true })
        }
        return true
      },
      async send() { sends++; assert.fail('过期澄清不得外发') },
    } }))
    await t.step(() => scopeTopic(host))
    const withRoutingHold = host.residentStore.withRoutingHold
    host.residentStore.withRoutingHold = async args => {
      try { return await withRoutingHold(args) }
      catch (error) { if (disclosed && error.message === 'topic_routing_hold_stale') rejected.resolve(); throw error }
    }
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('race', '测试助手，请核查那张发票。')))
    await t.step(() => rejected.promise)
    assert.ok(disclosed)
    assert.equal(sends, 0)
    const notification = await t.step(() => host.query('notification.get', { notificationId: oldNotificationId }))
    assert.equal(notification.state, 'prepared')
    assert.equal(notification.sendAttemptCount, undefined)
    const source = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'race')
    assert.equal(source.routingStatus, 'pending')
    assert.equal(source.routingEpoch, 1)
    resumedRoute.resolve()
    await t.step(() => host.service.whenIdle())
    assert.equal(sends, 0)
  }))

test('只有冻结出箱尚未prepare的冷启动沿原正文恢复一次，不重调模型',
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-gap-'))
    let host
    t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => hold(request)))
    await t.step(() => scopeTopic(host))
    const original = host.residentStore.appendOutbox
    let stopped = false
    host.residentStore.appendOutbox = async args => {
      const result = await original(args)
      if (!stopped && args.outboundId?.startsWith('routing-clarification-')) { stopped = true; throw new Error('fixture-stop-after-durable-outbox') }
      return result
    }
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('gap', '测试助手，请核查那张发票。')))
    await t.step(() => host.service.whenIdle())
    assert.ok(stopped)
    assert.equal(host.sent.length, 0)
    assert.deepEqual(await t.step(() => host.query('notification.list')), [])
    const frozen = structuredClone(host.residentStore.getGroup('native-group').outbox[0])
    assert.equal(frozen.text, question)
    await t.step(() => host.close())
    host = await t.step(() => nativeTaskHost(root, () => assert.fail('恢复冻结问句不重调模型'), { initialize: false }))
    await t.step(() => host.service.recover())
    await t.step(() => host.service.whenIdle())
    assert.equal(host.sent.length, 1)
    const notification = (await t.step(() => host.query('notification.list')))[0]
    assert.equal(notification.id, frozen.outboundId)
    assert.equal(notification.payload.text, frozen.text)
    assert.equal(notification.state, 'delivered')
    assert.equal((await t.step(() => host.query('source.list'))).find(item => item.messageId === 'gap').processingCompleted, undefined)
  }))

test('未知澄清发送冷恢复仅只读核验，hold继续等待且不重发',
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-unknown-'))
    let host, sends = 0, reads = 0
    t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => hold(request), { notifications: {
      async send() { sends++; throw new Error('fixture-ambiguous-send') },
    } }))
    await t.step(() => scopeTopic(host))
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('unknown', '测试助手，请核查那张发票。')))
    await t.step(() => host.service.whenIdle())
    const original = (await t.step(() => host.query('notification.list')))[0]
    assert.equal(original.state, 'unknown')
    assert.equal(sends, 1)
    await t.step(() => host.close())
    host = await t.step(() => nativeTaskHost(root, () => assert.fail('未知发送不重调模型'), { initialize: false, notifications: {
      async send() { sends++; assert.fail('未知发送只许回读') },
      async readback(notification) { reads++; assert.equal(notification.id, original.id); return { messageId: 'confirmed-clarification', visible: true } },
    } }))
    const detail = host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === original.id)
    await t.step(() => host.service.retryNotification({ groupId: 'native-group', notificationId: original.id, expectedToken: detail.notificationRecovery.expectedToken }))
    await t.step(() => host.service.whenIdle())
    assert.equal(sends, 1)
    assert.equal(reads, 1)
    assert.equal((await t.step(() => host.query('notification.list')))[0].state, 'delivered')
    assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'unknown').routingStatus, 'needs-context')
    assert.equal((await t.step(() => host.query('source.list'))).find(item => item.messageId === 'unknown').processingCompleted, undefined)
  }))

for (const [name, text, mentionedAgent] of [
  ['cc前缀', '  cc: 请核查那张发票。', false],
  ['带前置空白的点名', '  @测试助手 请核查那张发票。', false],
]) test(`明确交办${name}不被无@元数据误否决`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-direction-'))
  let host
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, request => hold(request)))
  await t.step(() => scopeTopic(host))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('directed', text, { mentionedAgent })))
  await t.step(() => host.service.whenIdle())
  assert.equal(host.sent.length, 1, JSON.stringify(host.service.listAlerts()))
  assert.equal((await t.step(() => host.query('notification.list')))[0].state, 'delivered')
  assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'directed').routingStatus, 'needs-context')
}))

async function scopeTopic(host, title = '独立范围事项', messageId = 'scope-matter') {
  await host.residentStore.ingest(message(messageId, `${title}。`))
  const result = await host.residentStore.routeMessages({ groupId: 'native-group', routeId: `${messageId}-route`,
    routingRevision: host.residentStore.getGroup('native-group').routingRevision, routes: [{ messageId, messageVersion: 1,
      topics: [{ newTopicKey: 'scope', title, reason: '独立目标，无相关候选', candidateComparisons: [] }] }] })
  const topicId = result.topicIdsByKey.scope
  const decisionId = `${messageId}-decision`
  await host.residentStore.acceptTopicDecision({ groupId: 'native-group', topicId, revision: 1, decisionId, decision: { actions: [], reason: '仅记录范围上下文' } })
  await host.residentStore.completeTopicDecision({ groupId: 'native-group', topicId, decisionId })
  return topicId
}

test('分诊策略问句真实送达后以精确引用恢复原来源',
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-policy-'))
    let host, topicId, resumed
    t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => {
      const input = latestInput(request)
      const result = modelToolValues(request).at(-1)
      if (result?.status === 'context-required' && result.nextCall) return [{ name: result.nextCall.name, args: result.nextCall.arguments }]
      if (input.messages.some(item => item.messageId === 'answer')) {
        resumed = structuredClone(input)
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({
          messageId: item.messageId, messageVersion: item.messageVersion, units: [{ unitKey: 'discussion', summary: '澄清后归档讨论',
            sourceRefs: [{ wholeMessage: true }], contextRefs: [], topics: [], fixedTopic: 'out-of-scope', reason: '讨论无需处理' }] })) } }]
      }
      const topic = [...(input.topics ?? []), ...(input.relatedTopics ?? []), ...(input.recalledTopics ?? [])].find(item => item.topicId === topicId)
      assert.ok(topic)
      const calls = hold(request)
      calls[0].args.routes[0].deferred.scope = [{ topicId, revision: topic.revision }]
      return calls
    }))
    topicId = await t.step(() => scopeTopic(host))
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('original', '请核查那张发票。')))
    await t.step(() => host.service.whenIdle())
    const notification = (await t.step(() => host.query('notification.list'))).find(item => item.kind === 'routing-clarification')
    assert.equal(notification.state, 'delivered')
    assert.equal(notification.payload.fact.policyApproved, true)
    assert.equal(notification.payload.fact.agentDirected, undefined)
    const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'original')
    assert.deepEqual(held.routingHold.scope, [topicId])
    await t.step(() => host.service.ingest(message('answer', '是十月份的发票。', { quotedMessage: { messageId: notification.receipt.messageId, content: question } })))
    await t.step(() => host.service.whenIdle())
    assert.ok(resumed, JSON.stringify(host.service.listAlerts()))
    assert.deepEqual(new Set(resumed.messages.map(item => item.messageId)), new Set(['original', 'answer']))
    const reply = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'answer')
    assert.equal(reply.quotedMessage.messageId, notification.receipt.messageId)
    assert.equal((await t.step(() => host.query('task.list'))).length, 0)
    assert.equal(host.sent.length, 1)
  }))

for (const beforeSend of [false, true]) test(`范围声明只更新屏障CAS，不改变澄清通知身份：发送前=${beforeSend}`,
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'routing-clarification-scope-'))
    let host, initialScope, scope, changed = false, sends = 0
    t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => hold(request), { notifications: {
      async canDisclose() {
        if (beforeSend && !changed) {
          changed = true
          const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'scope-clarify')
          assert.deepEqual(held.routingHold.scope, [initialScope])
          await host.residentStore.updateRoutingHold({ groupId: 'native-group', messageId: held.messageId,
            messageVersion: held.messageVersion, epoch: held.routingHold.epoch, scope: [scope] })
        }
        return true
      },
      async send() { sends++; return { messageId: 'scope-question-delivered' } },
      async readback(notification) { return { messageId: notification.ack.messageId, visible: true } },
    } }))
    initialScope = await t.step(() => scopeTopic(host))
    scope = await t.step(() => scopeTopic(host, '其他范围事项', 'scope-other'))
    assert.notEqual(initialScope, scope)
    await t.beginBusiness()
    await t.step(() => host.service.ingest(message('scope-clarify', '测试助手，请核查那张发票。')))
    await t.step(() => host.service.whenIdle())
    const first = (await t.step(() => host.query('notification.list')))[0]
    assert.equal(first.state, 'delivered')
    if (!beforeSend) {
      const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'scope-clarify')
      assert.deepEqual(held.routingHold.scope, [initialScope])
      await t.step(() => host.service.updateMessageRoutingHold({ groupId: 'native-group', messageId: held.messageId,
        messageVersion: held.messageVersion, epoch: held.routingHold.epoch, scope: [scope] }))
      await t.step(() => host.service.whenIdle())
      await t.step(() => host.service.recover())
      await t.step(() => host.service.whenIdle())
    }
    assert.equal(sends, 1)
    const notices = await t.step(() => host.query('notification.list'))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].id, first.id)
    const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'scope-clarify')
    assert.equal(held.routingStatus, 'needs-context')
    assert.deepEqual(held.routingHold.scope, [scope])
    assert.ok(held.routingHold.epoch > held.routingHold.clarification.epoch)
    assert.equal(first.payload.fact.epoch, held.routingHold.clarification.epoch)
    assert.ok(!JSON.stringify(host.service.listAlerts()).includes('routing_clarification_stale'))
  }))
