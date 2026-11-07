import { DatabaseSync, assert, available, basename, call, createHash, createServer, decision, findSessionLog, httpGet, inspectSession, join, latestInput, lifecycleStages, message, mkdir, mkdtemp, modelToolValues, nativeCase, nativeLifecycle, nativeLifecycleTimeout, nativeShell, nativeTaskHost, nativeVerificationTeam, openDynamicTaskStore, openTaskResidentRuntime, openTaskSessionService, projectTaskNotification, readFile, readdir, reason, requestSystemText, requiredDecisionRead, resident, retireTaskContext, rm, taskNotificationRecovery, taskSessionLogRoot, test, testRunner, tmpdir, topicTaskCalls, waitUntil, writeFile } from './fixtures/task-session-service-history.js'

for (const [ownEcho, followupActor] of [[true, 'native-user'], [true, 'colleague'], [false, 'native-user']]) test(`话题历史${ownEcho ? '自身通知不阻断人工补充' : '未准入真实消息仍拒绝更新且不发送成功回复'}-${followupActor}`, { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-topic-source-')
  let topicId, originalTask, ownerCalls = 0
  const readReviews = new Set(), staleRequests = new Set()
  let h
  const model = async request => {
    assert.ok(h.requests.length < 12, JSON.stringify(h.toolResults.slice(-2)))
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (input.trigger === 'task-facts') return topicTaskCalls(request)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      if (topicId) for (const route of calls[0].args.routes) for (const unit of route.units)
        unit.topics = [{ topicId, relationship: 'continuation', reason: '原任务的人工补充' }]
      return calls
    }
    if (names.includes('group_decision_submit') && topicId) {
      const reviewKey = `${input.requestId}:${input.revision}`
      if (staleRequests.has(reviewKey)) return []
      if (!readReviews.has(reviewKey)) {
        readReviews.add(reviewKey)
        return [call('group_reply_review_get', { requestIds: [input.requestId] })]
      }
      const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      const review = h.toolResults.findLast(item => item.name === 'group_reply_review_get')
      const reviewedOutboundIds = JSON.parse(review.result.content[0].text).candidates.map(item => item.outboundId)
      return [call('group_decision_submit', { requestId: input.requestId, topicId, revision: input.revision, decision: {
        basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs,
        actions: [{ kind: 'task-context', taskId: originalTask.taskId, inputVersion: originalTask.requirementRevision,
          runSequence: originalTask.runSequence, context: '先核对正确开发分支，这不是批准例外', progressImpact: 'preserve',
          topicRefs: [{ topicId, revision: input.revision }], basisUnitRefs }],
        reply: '已补入原任务，先核对正确分支。', replyToMessageId: 'manual-followup', atOpenDingTalkIds: [followupActor],
        replyReview: { kind: 'substantive', reviewedOutboundIds, sameMatterOutboundIds: [], replaceOutboundIds: [] },
      } })]
    }
    const calls = topicTaskCalls(request)
    if (calls) return calls
    if (++ownerCalls === 1) return followupActor === 'colleague'
      ? [call('task_request_human', { audience: 'requester', reason: '需要核对开发来源', question: '是否批准分支例外？', evidence: [], attemptedActions: ['核对原始交办'] })]
      : [call('task_session_submit', { decision: { action: 'blocked', summary: '需要核对开发来源', question: '是否批准分支例外？', evidence: [], limitations: [] } })]
    assert.equal(input.task.sessionId, originalTask.sessionId)
    assert.ok(input.sources.some(source => source.text === '先核对分支，不是批准例外'))
    assert.ok(input.sources.every(source => source.messageId !== 'native-notification-1'))
    return [decision('complete', '已按补充要求核对分支')]
  }
  await t.beginBusiness()
  h = await t.step(async () => fixture.host(model, { config: { assistantActorId: 'native-user' } }))
  h.ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'group_decision_submit' && result.value?.status === 'topic-stale') {
      const args = exec.args ?? exec.arguments
      staleRequests.add(`${args.requestId}:${args.revision}`)
    }
  })
  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  ;[originalTask] = await t.step(async () => h.query('task.list'))
  topicId = originalTask.topicRefs[0].topicId
  const echo = { ...message, messageId: ownEcho ? 'native-notification-1' : 'unadmitted-user-message',
    text: ownEcho ? h.sent[0].payload.text : '需要保留的真实历史指令', quotedMessage: { messageId: message.messageId, content: message.text }, occurredAt: '2026-10-13T10:01:00Z' }
  await t.step(async () => h.residentStore.ingest(echo))
  await t.step(async () => h.residentStore.routeMessages({ groupId: message.groupId, routeId: 'historical-echo-route', routingRevision: h.residentStore.getGroup(message.groupId).routingRevision, routes: [{ messageId: echo.messageId, messageVersion: 1,
    topics: [{ topicId, relationship: 'continuation', reason: '历史话题上下文' }] }] }))
  const sentBefore = h.sent.filter(notification => notification.kind === 'topic-reply').length
  await t.step(async () => h.service.ingest({ ...message, senderOpenDingTalkId: followupActor, messageId: 'manual-followup', text: '先核对分支，不是批准例外', occurredAt: '2026-10-13T10:02:00Z' }))
  await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list'))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.ok(!(await t.step(async () => h.query('source.list'))).some(source => source.messageId === echo.messageId))
  if (ownEcho) {
    assert.equal(task.status, 'active', JSON.stringify(h.service.listAlerts()))
    assert.equal(task.humanRequests[0].status, 'waiting-reply', '普通定位补充既不改变授权，也不能代答或清除operator技术申请')
    assert.equal(task.requirementRevision, 1)
    assert.equal(ownerCalls, 1)
    assert.equal(h.residentStore.getTopic(message.groupId, topicId).processedRevision, 3)
  } else {
    assert.equal(task.humanRequests[0].status, 'waiting-reply')
    assert.equal(ownerCalls, 1)
    assert.equal(h.sent.filter(notification => notification.kind === 'topic-reply').length, sentBefore)
    const blocked = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.error, 'TASK_TOPIC_SOURCE_VERSION_MISSING')
    // 模拟旧版先回复再失败，投影后的来源身份已改变。
    const notificationId = blocked.outboundId, topicRefs = [{ topicId, revision: blocked.revision }]
    await t.step(async () => h.residentStore.appendOutbox({ groupId: message.groupId, outboundId: notificationId, decisionId: blocked.decisionId,
      sourceMessageId: `topic-decision:${blocked.decisionId}`, text: blocked.decision.reply, topicRefs, taskIds: [originalTask.taskId],
      replyToMessageId: 'manual-followup', replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'] }))
    await t.step(async () => h.service.store.command({ id: `prepare-notification:${notificationId}`, kind: 'notification.prepare', args: {
      notificationId, taskId: originalTask.taskId, requirementRevision: 1, kind: 'topic-reply', payload: {
        text: blocked.decision.reply, topicRefs, taskIds: [originalTask.taskId], replyKind: 'substantive', conversationId: message.groupId,
        sourceMessageId: 'manual-followup', actorId: 'native-user', replyToMessageId: 'manual-followup',
        replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'], fact: { topicRefs }, kind: 'topic-reply',
      },
    } }))
    const started = await t.step(async () => h.service.store.command({ id: 'fixture-old-reply-start', kind: 'notification.start', args: { notificationId } }))
    const delivered = await t.step(async () => h.service.store.command({ id: 'fixture-old-reply-delivered', kind: 'notification.delivered', args: {
      notificationId, dispatchToken: started.result.notification.dispatchToken, receipt: { messageId: 'historical-reply-id' },
    } }))
    await t.step(async () => projectTaskNotification({ residentStore: h.residentStore, notification: delivered.result.notification }))
    await t.step(async () => h.service.store.command({ id: 'fixture-admit-historical-source', kind: 'source.record', args: {
      sourceId: 'fixture-historical-source', groupId: message.groupId, messageId: echo.messageId, version: 1,
      actorId: message.senderOpenDingTalkId, text: echo.text, timestamp: echo.occurredAt,
    } }))
    // A legacy partial commit is observed only after a real service restart.
    // Retain the test's transport audit across both instances; expected counts stay unchanged.
    const sentHistory = h.sent.slice()
    await t.step(async () => h.close()); readReviews.clear()
    h = await t.step(async () => fixture.host(model, { initialize: false, config: { assistantActorId: 'native-user' } }))
    h.sent.unshift(...sentHistory) // Preserve the diagnostic recorder across the two real instances.
    const append = h.residentStore.appendOutbox
    let duplicateAppends = 0
    h.residentStore.appendOutbox = args => {
      if (args.outboundId === notificationId) { duplicateAppends++; throw new Error('outbox_identity_duplicate') }
      return append(args)
    }
    await t.step(async () => h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' })); await t.step(async () => h.service.whenIdle())
    h.residentStore.appendOutbox = append
    const recoveredReply = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
    assert.equal(duplicateAppends, 0, 'The frozen delivered notification is reused without appending its identity again')
    assert.equal(recoveredReply.error, undefined)
    assert.equal(recoveredReply.status, 'completed')
    assert.equal(recoveredReply.decisionId, blocked.decisionId)
    assert.ok(recoveredReply.operations.every(operation => operation.status === 'applied'))
    await t.step(async () => h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' })); await t.step(async () => h.service.whenIdle())
    assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'active', JSON.stringify(h.service.listAlerts()))
    assert.equal((await t.step(async () => h.query('task.list')))[0].humanRequests[0].status, 'waiting-reply')
    assert.equal(ownerCalls, 1)
    assert.equal((await t.step(async () => h.query('notification.get', { notificationId }))).state, 'delivered')
    assert.equal(h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === notificationId).deliveredMessageId, 'historical-reply-id')
    assert.equal(h.sent.filter(notification => notification.kind === 'topic-reply').length, sentBefore)
    const oldEcho = await t.step(async () => h.service.ingest({ ...message, messageId: 'historical-reply-id', text: blocked.decision.reply }))
    assert.equal(oldEcho.reason, 'own-notification', '重放 prepared 收据不能覆盖当前 delivered 的发送身份缓存')
    const sentAfter = h.sent.length
    await t.step(async () => h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' })); await t.step(async () => h.service.whenIdle())
    assert.equal(h.sent.length, sentAfter, '已应用动作和已送达回复不能因重复重试再次执行')
    assert.equal(ownerCalls, 1)
  }
}))
