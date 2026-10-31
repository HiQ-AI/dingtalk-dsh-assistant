import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, topicTaskCalls, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { topicDecisionRecovery, fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'

test('Host exact recovery rejects unknown effects and queue-stale facts, then resumes the original pre-effect failure once', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
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
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(args()), /MESSAGE_RETRY_STALE/))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  await t.step(async () => blocked('TASK_TOPIC_SOURCE_VERSION_MISSING'))
  for (const patch of [{ messageVersion: 2 }, { activeUnitRefs: [] }, { requestId: 'foreign' }, { token: 'a'.repeat(64) }])
    await t.step(async () => assert.rejects(h.service.retryMessageProcessing({ ...args(), ...patch }), /MESSAGE_RETRY_STALE/))
  const stale = args()
  const mutation = h.residentStore.updateTopicDecision({ groupId, topicId: topic.topicId, decisionId: requestId, patch: { progress: { newer: true } } })
  const retry = h.service.retryMessageProcessing(stale)
  await t.step(async () => mutation)
  await t.step(async () => assert.rejects(retry, /MESSAGE_RETRY_STALE/))
  await t.step(async () => h.service.store.command({ id: 'admit-host-original', kind: 'source.record', args: { sourceId: 'host-source', groupId, messageId, version: 1,
    actorId: 'native-user', text: original.text } }))
  const successful = args()
  const results = await t.step(async () => Promise.allSettled([h.service.retryMessageProcessing(successful), h.service.retryMessageProcessing(successful)]))
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1, results.map(item => item.reason?.stack ?? item.status).join('; '))
  await t.step(async () => h.service.whenIdle())
  assert.equal(current().status, 'completed')
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
  assert.equal(h.residentStore.getGroup(groupId).messages.length, 1)
  assert.equal(h.residentStore.getGroup(groupId).outbox.length, 1)
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(successful), /MESSAGE_RETRY_STALE/))
}))

test('retired coordination recovery cannot consume or replay a source already handled by the native Topic and Owner', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
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
  const h = await nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }], { agentConfig })
  await t.beginBusiness()

  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'native-group', messageId: 'exact-source', text: '测试助手，请核对测试结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }
  await t.step(async () => h.service.ingest(message))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(() => h.service.messageProcessingRequests(message.groupId).some(item => item.status === 'exhausted' && h.residentStore.getCoordinationRequest(message.groupId, item.requestId)?.startupAttempt === 1), 'initial durable startup failure'))
  const original = structuredClone(h.residentStore.getGroup(message.groupId).messages[0])
  const args = () => {
    const request = h.service.messageProcessingRequests(message.groupId).find(item => item.status === 'exhausted')
    assert.ok(request)
    return { groupId: message.groupId, messageId: message.messageId, messageVersion: original.messageVersion, activeUnitRefs: original.activeUnitRefs ?? [],
      phase: request.topicId ? 'decision' : 'routing', requestId: request.requestId, token: request.retryToken }
  }
  const first = args()
  for (const patch of [{ groupId: 'foreign' }, { messageVersion: 999 }, { token: 'b'.repeat(64) }, { activeUnitRefs: [{ unitId: 'foreign', unitRevision: 1 }] }, { phase: 'decision' }])
    await t.step(async () => assert.rejects(h.service.retryMessageProcessing({ ...first, ...patch }), /MESSAGE_RETRY_/))
  const attempts = await t.step(async () => Promise.allSettled([h.service.retryMessageProcessing(first), h.service.retryMessageProcessing(first)]))
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1, attempts.map(item => item.reason?.stack ?? item.status).join('; '))
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1)
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(() => h.residentStore.getCoordinationRequest(message.groupId, first.requestId)?.startupAttempt >= 2, 'second durable startup failure'))
  const second = args()
  assert.notEqual(second.token, first.token)
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(first), /MESSAGE_RETRY_STALE/))
  agentConfig.agentPreset = 'native-test'
  await t.step(async () => h.service.retryMessageProcessing(second))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => (await h.query('source.list'))[0]?.processingCompleted, 'original source semantic completion'))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(second), /MESSAGE_RETRY_STALE/))
  assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
  assert.equal(h.residentStore.getGroup(message.groupId).messages.length, 1)
  const current = h.residentStore.getGroup(message.groupId).messages[0]
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId']) assert.deepEqual(current[key], original[key])
  assert.equal(current.routingStatus, 'routed')
  assert.ok(h.residentStore.listTopics(message.groupId).every(topic => topic.processedRevision === topic.revision))
  assert.ok((await t.step(async () => h.query('source.list')))[0].processingCompleted)
}))

test('explicit background message retry admits original facts through topics once without opening automatic history ingress', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-background-retry-'))
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) { const input = latestInput(request); return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'explicit-history', title: '原图位置调整' }] })) } }] }
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
  await t.step(async () => h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId }))
  await t.step(async () => h.service.whenIdle())
  const sources = await t.step(async () => h.query('source.list')), tasks = await t.step(async () => h.query('task.list'))
  assert.equal(sources.length, 1)
  assert.equal(tasks.length, 1)
  assert.equal(sources[0].timestamp, message.occurredAt)
  assert.equal(sources[0].actorId, message.senderOpenDingTalkId)
  assert.equal(sources[0].text, message.text)
  assert.deepEqual(sources[0].quote, before.quotedMessage)
  assert.deepEqual(sources[0].resources, before.resourceRefs)
  const after = h.residentStore.getGroup('native-group').messages.find(item => item.messageId === message.messageId)
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId', 'imageRefs', 'resourceRefs', 'quotedMessage']) assert.deepEqual(after[key], before[key], key)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.equal(tasks[0].topicRefs.length, 1)
  const requests = h.requests.length
  for (let i = 0; i < 2; i++) { await t.step(async () => h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId })); await t.step(async () => h.service.whenIdle()) }
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
  assert.equal(h.requests.length, requests)
  await t.step(async () => runtime.backfill([{ ...message, messageId: 'another-old-message' }]))
  await t.step(async () => h.service.whenIdle())
  assert.equal(h.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'another-old-message').agentDeliveryStatus, 'skipped')
  assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
  assert.equal(h.requests.length, requests)
}))
