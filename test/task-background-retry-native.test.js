import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, topicTaskCalls, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { topicDecisionRecovery, fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'

test('脚本区分事实证据来源与当前批新交办', () => {
  const values = [{ sourceId: 'fact-source', text: '已完成任务' }, { sourceId: 'new-source', text: '新的交办' }]
  const pages = values.map(value => {
    const text = JSON.stringify(value)
    return { batchId: 'batch', sourceId: value.sourceId, offset: 0, nextOffset: text.length, totalLength: text.length, text }
  })
  const request = newSourceIds => ({ tools: [{ name: 'router_submit' }], messages: [
    { role: 'user', content: [{ type: 'text', text: JSON.stringify({ batchId: 'batch', sources: pages.map(({ sourceId, totalLength }) => ({ sourceId, totalLength })), context: { newSourceIds } }) }] },
    ...pages.map(page => ({ role: 'tool', content: [{ type: 'text', text: JSON.stringify(page) }] })),
  ] })
  assert.deepEqual(topicTaskCalls(request([]))[0].args.actions, [])
  const [action] = topicTaskCalls(request(['new-source']))[0].args.actions
  assert.deepEqual(action.sourceIds, ['new-source'])
  assert.equal(action.objective, '新的交办')
})

test('历史 Host 决议缺少新入口证据时保留原记录且不重放', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-host-retry-'))
  const h = await nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }])
  await t.beginBusiness()

  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const groupId = 'native-group', messageId = 'host-original'
  await t.step(async () => h.residentStore.ingest({ groupId, messageId, text: '测试助手，请核对结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }))
  await t.step(async () => h.residentStore.routeMessages({ groupId, routeId: 'host-route', routingRevision: 0,
    routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: 'host', title: '核对结果' }] }] }))
  const topic = h.residentStore.listTopics(groupId)[0], original = h.residentStore.getGroup(groupId).messages[0]
  const refs = original.activeUnitRefs, requestId = 'host-decision'
  await t.step(async () => h.residentStore.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: topic.revision, decisionId: requestId,
    decision: { basisMessageIds: [messageId], basisUnitRefs: refs, reply: '已交回核对', replyToMessageId: messageId, atOpenDingTalkIds: ['native-user'], replyReview: { kind: 'confirmation' },
      actions: [{ kind: 'new-task', title: '核对结果', objective: '核对结果', acceptanceCriteria: ['核对证据'], topicRefs: [{ topicId: topic.topicId, revision: topic.revision }], basisUnitRefs: refs }] } }))
  const current = () => h.residentStore.getTopic(groupId, topic.topicId).decisions[0]
  const operation = current().operations[0]
  const blocked = error => h.residentStore.updateTopicDecision({ groupId, topicId: topic.topicId, decisionId: requestId,
    patch: { status: 'blocked', error, failureOperationId: operation.operationId, operations: [{ ...operation, status: 'blocked' }] } })
  const args = () => ({ groupId, messageId, messageVersion: 1, activeUnitRefs: refs, phase: 'host', requestId,
    token: topicDecisionRecovery(current())?.token ?? fingerprint(current()) })
  await t.step(async () => blocked('unknown-effect'))
  assert.equal(topicDecisionRecovery(current()), null)
  for (const error of ['unknown-effect', 'TASK_TOPIC_SOURCE_VERSION_MISSING']) {
    if (error !== 'unknown-effect') await t.step(async () => blocked(error))
    const before = structuredClone(current()), requests = h.requests.length
    await t.step(async () => assert.rejects(h.service.retryMessageProcessing(args()), /LEGACY_DECISION_RECONCILIATION_REQUIRED/))
    await t.step(async () => h.service.recover())
    await t.step(async () => h.service.whenIdle())
    assert.deepEqual(current(), before)
    assert.equal(h.requests.length, requests)
    assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
    assert.equal((await t.step(async () => h.query('source.list'))).length, 0)
    assert.equal(h.residentStore.getGroup(groupId).outbox.length, 0)
  }
}))

for (const projected of [true, false]) test(`历史成功操作与已送达回复重启不重放：来源${projected ? '已路由' : '尚未路由'}`, { timeout: nativeLifecycleTimeout(20000), ...(!available ? { skip: reason } : {}) }, nativeLifecycle(20000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-legacy-receipt-'))
  const model = request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }]
  let h = await nativeTaskHost(root, model)
  await t.beginBusiness()
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const groupId = 'native-group', messageId = 'legacy-success', sourceId = 'legacy-success-source', decisionId = 'legacy-success-decision'
  const message = { groupId, messageId, text: '测试助手，请核对结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }
  await t.step(() => h.residentStore.ingest(message))
  await t.step(() => h.residentStore.routeMessages({ groupId, routeId: 'legacy-success-route', routingRevision: 0,
    routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: 'legacy-success', title: '核对结果' }] }] }))
  const topic = h.residentStore.listTopics(groupId)[0], refs = h.residentStore.getGroup(groupId).messages[0].activeUnitRefs
  const topicRefs = [{ topicId: topic.topicId, revision: topic.revision }]
  await t.step(() => h.residentStore.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: topic.revision, decisionId,
    decision: { basisMessageIds: [messageId], basisUnitRefs: refs, reply: '已收到', replyToMessageId: messageId,
      atOpenDingTalkIds: ['native-user'], replyReview: { kind: 'confirmation' }, actions: [{ kind: 'new-task', title: '核对结果',
        objective: '核对结果', acceptanceCriteria: ['核对证据'], topicRefs, basisUnitRefs: refs }] } }))
  const decision = h.residentStore.getTopic(groupId, topic.topicId).decisions[0], operation = decision.operations[0]
  await t.step(() => h.service.store.command({ id: 'legacy-source-receipt', kind: 'source.record', args: {
    sourceId, groupId, messageId, version: 1, actorId: 'native-user', text: message.text, timestamp: message.occurredAt } }))
  const operationId = `topic-operation:${operation.operationId}`
  const created = await t.step(() => h.service.store.command({ id: operationId, kind: 'task.create', args: {
    taskId: operation.taskId, groupId, ownerActorId: 'native-user', sourceRefs: [sourceId], topicRefs, operationId: operation.operationId,
    title: '核对结果', objective: '核对结果', request: message.text, requirements: ['核对证据'] } }))
  await t.step(() => h.service.store.command({ id: 'legacy-task-stop', kind: 'task.control', args: {
    taskId: operation.taskId, expectedRequirementRevision: 1, expectedControlRevision: 1, control: 'cancelled', reason: '历史任务已结束' } }))
  await t.step(() => h.residentStore.updateTopicDecision({ groupId, topicId: topic.topicId, decisionId,
    patch: { operations: [{ ...operation, status: 'applied' }] } }))
  const notificationId = decision.outboundId
  await t.step(() => h.residentStore.appendOutbox({ groupId, outboundId: notificationId, decisionId,
    sourceMessageId: `topic-decision:${decisionId}`, text: '已收到', topicRefs, taskIds: [operation.taskId],
    replyToMessageId: messageId, replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'] }))
  await t.step(() => h.service.store.command({ id: `prepare-notification:${notificationId}`, kind: 'notification.prepare', args: {
    notificationId, taskId: operation.taskId, requirementRevision: 1, kind: 'topic-reply', payload: {
      text: '已收到', topicRefs, taskIds: [operation.taskId], replyKind: 'confirmation', conversationId: groupId,
      sourceMessageId: messageId, actorId: 'native-user', replyToMessageId: messageId,
      replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'], fact: { topicRefs }, kind: 'topic-reply' } } }))
  await t.step(() => h.service.whenIdle())
  await t.step(() => waitUntil(async () => (await h.query('notification.get', { notificationId }))?.state === 'delivered', '历史通知真实送达'))
  await t.step(() => h.residentStore.completeTopicDecision({ groupId, topicId: topic.topicId, decisionId }))
  if (projected) await t.step(() => h.service.store.command({ id: `topic-routed:${sourceId}`, kind: 'source.routed', args: { sourceId, receipt: topicRefs } }))
  assert.equal(Boolean((await h.query('source.get', { sourceId })).routed), projected)
  const receipt = await t.step(() => h.query('receipt.get', { id: operationId }))
  assert.deepEqual(receipt, created)
  const original = { receipt, task: await h.query('task.get', { taskId: operation.taskId }), sources: await h.query('source.list'),
    notification: await h.query('notification.get', { notificationId }), decision: structuredClone(h.residentStore.getTopic(groupId, topic.topicId).decisions[0]) }
  assert.equal(h.sent.length, 1)
  assert.deepEqual((await h.query('task.list')).map(task => ({ taskId: task.taskId, request: task.request })), [{ taskId: operation.taskId, request: message.text }])
  assert.equal(h.requests.length, 0)
  await t.step(() => h.close())
  h = await t.step(() => nativeTaskHost(root, model, { initialize: false }))
  await t.step(() => h.service.recover())
  await t.step(() => h.service.whenIdle())
  assert.deepEqual(await h.query('receipt.get', { id: operationId }), original.receipt)
  assert.deepEqual(await h.query('task.get', { taskId: operation.taskId }), original.task)
  const restoredSources = await h.query('source.list')
  assert.equal(restoredSources.length, 1)
  if (projected) assert.deepEqual(restoredSources, original.sources)
  else {
    for (const key of ['sourceId', 'groupId', 'messageId', 'version', 'actorId', 'text', 'timestamp']) assert.deepEqual(restoredSources[0][key], original.sources[0][key])
    assert.equal(restoredSources[0].routed, true)
  }
  assert.deepEqual(await h.query('notification.get', { notificationId }), original.notification)
  assert.deepEqual(h.residentStore.getTopic(groupId, topic.topicId).decisions[0], original.decision)
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(h.requests.length, 0)
  assert.equal(h.sent.length, 0)
}))

test('已退役协调恢复不能重复消费直接进入 Task 的真实来源', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-coordination-retry-'))
  const h = await nativeTaskHost(root, request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: {
    decision: { action: 'wait', summary: '保留原任务，等待核对结果', evidence: [], limitations: [] },
  } }], { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } } })
  await t.beginBusiness()

  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const groupId = 'native-group', messageId = 'coord-original'
  await t.step(async () => h.service.ingest({ groupId, messageId, text: '测试助手，核对原文件后等我补充', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }))
  await t.step(async () => h.service.whenIdle())
  const original = structuredClone(h.residentStore.getGroup(groupId).messages[0])
  const snapshot = async () => ({ sources: await h.query('source.list'), tasks: await h.query('task.list'),
    wakes: await h.query('wake.list'), notifications: await h.query('notification.list'),
    message: structuredClone(h.residentStore.getGroup(groupId).messages[0]), requests: h.requests.length, sent: h.sent.length })
  const before = await t.step(async () => snapshot())
  assert.equal(before.sources.length, 1); assert.ok(before.sources[0].processingCompleted)
  assert.equal(before.tasks.length, 1)
  assert.deepEqual(before.tasks[0].topicRefs, [])
  assert.equal(h.residentStore.listTopics(groupId).length, 0)
  for (const phase of ['coordination', 'coordination-context']) {
    const args = { groupId, messageId, messageVersion: original.messageVersion, activeUnitRefs: original.activeUnitRefs,
      phase, requestId: 'former-reservation', token: 'a'.repeat(64) }
    for (const patch of [{}, { messageVersion: 2 }, { activeUnitRefs: [] }, { requestId: 'foreign' }])
      await t.step(async () => assert.rejects(h.service.retryMessageProcessing({ ...args, ...patch }), { code: 'MESSAGE_RETRY_STALE' }))
  }
  assert.deepEqual(await t.step(async () => snapshot()), before, '旧阶段恢复不能重派来源、任务或已冻结通知')
  assert.deepEqual(await t.step(async () => h.query('coordination.source.list')), [])
  assert.ok(h.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
}))

test('精确收件恢复沿原生会话处理：外部启动阻塞未修再次失败，修复后成功且不复制事实', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-exact-retry-'))
  const agentConfig = { agentPreset: 'missing-fixture-preset' }
  let h = await nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }], { agentConfig })
  await t.beginBusiness()

  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'native-group', messageId: 'exact-source', text: '测试助手，请核对测试结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }
  await t.step(async () => h.service.ingest(message))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(() => h.residentStore.getRouterState(message.groupId).failures?.some(item => item.status === 'failed'), 'initial durable startup failure'))
  const original = structuredClone(h.residentStore.getGroup(message.groupId).messages[0])
  const originalSources = await t.step(async () => h.query('source.list'))
  assert.equal(originalSources.length, 1)
  const originalSourceId = originalSources[0].sourceId
  const args = () => {
    const failure = h.residentStore.getRouterState(message.groupId).failures.find(item => item.status === 'failed')
    assert.ok(failure)
    return { groupId: message.groupId, messageId: message.messageId, messageVersion: original.messageVersion,
      phase: failure.phase, requestId: failure.requestId, token: failure.retryToken }
  }
  const first = args()
  for (const patch of [{ messageVersion: 999 }, { token: 'b'.repeat(64) }, { phase: 'decision' }, { requestId: 'foreign' }])
    await t.step(async () => assert.rejects(h.service.retryMessageProcessing({ ...first, ...patch }), /MESSAGE_RETRY_STALE/))
  const attempts = await t.step(async () => Promise.allSettled([h.service.retryMessageProcessing(first), h.service.retryMessageProcessing(first)]))
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 2)
  await t.step(async () => h.service.whenIdle())
  const second = args()
  assert.equal(h.residentStore.getRouterState(message.groupId).failures[0].attempt, 2)
  assert.notEqual(second.token, first.token)
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(first), /MESSAGE_RETRY_STALE/))
  await t.step(async () => h.close())
  agentConfig.agentPreset = 'native-test'
  h = await t.step(async () => nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }], { agentConfig }))
  assert.equal(args().token, second.token)
  await t.step(async () => h.service.retryMessageProcessing(second))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => (await h.query('source.list'))[0]?.processingCompleted, 'original source semantic completion'))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(second), /MESSAGE_RETRY_STALE/))
  const sources = await t.step(async () => h.query('source.list'))
  assert.equal(sources.length, 1)
  assert.equal(sources[0].sourceId, originalSourceId)
  assert.equal(sources[0].messageId, message.messageId)
  assert.equal(sources[0].version, original.messageVersion)
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  assert.deepEqual(tasks[0].sourceRefs, [originalSourceId])
  assert.equal(h.residentStore.getGroup(message.groupId).messages.length, 1)
  const current = h.residentStore.getGroup(message.groupId).messages[0]
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId']) assert.deepEqual(current[key], original[key])
  assert.equal(h.residentStore.listTopics(message.groupId).length, 0)
  assert.deepEqual(h.residentStore.getRouterState(message.groupId).failures ?? [], [])
  assert.ok((await t.step(async () => h.query('source.list')))[0].processingCompleted)
}))

test('历史回填缺少入站凭据时拒绝重试且保留原始事实', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-background-retry-'))
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) { const input = latestInput(request); return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'explicit-history', title: '原图位置调整', reason: '历史消息明确要求调整原图位置' }] })) } }] }
    return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对原图位置', evidence: [], limitations: [] } } }] }, { config: { ingressEpoch: '2026-10-14T02:00:00.000Z' } })
    await t.beginBusiness()

  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, h.residentStore, root))
  const message = { groupId: 'native-group', messageId: 'saved-history', text: '测试助手，请合并后调整描述输入框位置', senderOpenDingTalkId: 'native-user', senderName: '现场用户', occurredAt: '2026-10-14T01:25:51.750Z', sourceKind: 'dingtalk', quotedMessage: { messageId: 'prior', content: '原布局' }, imageRefs: [{ path: 'images/original.png', mediaType: 'image/png' }], resourceRefs: [{ type: 'fileId', resourceId: 'original-image', download: { ready: true } }] }
  await t.step(async () => runtime.backfill([message]))
  const before = structuredClone(h.residentStore.getGroup('native-group').messages[0])
  assert.equal(before.agentDeliveryStatus, 'skipped')
  assert.equal((await t.step(async () => h.query('source.list'))).length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal((await t.step(async () => h.service.ingest(message))).accepted, false)
  for (let i = 0; i < 2; i++) {
    await t.step(async () => assert.rejects(h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId }), /LEGACY_DECISION_RECONCILIATION_REQUIRED/))
    await t.step(async () => h.service.whenIdle())
  }
  const after = h.residentStore.getGroup('native-group').messages.find(item => item.messageId === message.messageId)
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId', 'imageRefs', 'resourceRefs', 'quotedMessage']) assert.deepEqual(after[key], before[key], key)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('source.list'))).length, 0)
  assert.equal(h.requests.length, 0)
  await t.step(async () => runtime.backfill([{ ...message, messageId: 'another-old-message' }]))
  await t.step(async () => h.service.whenIdle())
  assert.equal(h.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'another-old-message').agentDeliveryStatus, 'skipped')
  assert.equal((await t.step(async () => h.query('source.list'))).length, 0)
  assert.equal(h.requests.length, 0)
}))
