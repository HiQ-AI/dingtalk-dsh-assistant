import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, topicTaskCalls, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { topicDecisionRecovery, fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { createHash, randomUUID } from 'node:crypto'

test('Host exact recovery rejects unknown effects and queue-stale facts, then resumes the original pre-effect failure once', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-host-retry-'))
  const h = await nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }])
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const groupId = 'native-group', messageId = 'host-original'
  await h.residentStore.ingest({ groupId, messageId, text: '测试助手，请核对结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() })
  await h.residentStore.routeMessages({ groupId, routeId: 'host-route', routingRevision: 0,
    routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: 'host', title: '核对结果' }] }] })
  const topic = h.residentStore.listTopics(groupId)[0], original = h.residentStore.getGroup(groupId).messages[0]
  const refs = original.activeUnitRefs, requestId = 'host-decision'
  await h.residentStore.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: topic.revision, decisionId: requestId,
    decision: { basisMessageIds: [messageId], basisUnitRefs: refs, reply: '已交回核对', replyReview: { kind: 'confirmation' },
      actions: [{ kind: 'new-task', title: '核对结果', objective: '核对结果', acceptanceCriteria: ['核对证据'], topicRefs: [{ topicId: topic.topicId, revision: topic.revision }], basisUnitRefs: refs }] } })
  const current = () => h.residentStore.getTopic(groupId, topic.topicId).decisions[0]
  const operation = current().operations[0]
  const blocked = error => h.residentStore.updateTopicDecision({ groupId, topicId: topic.topicId, decisionId: requestId,
    patch: { status: 'blocked', error, failureOperationId: operation.operationId, operations: [{ ...operation, status: 'blocked' }] } })
  const args = () => ({ groupId, messageId, messageVersion: 1, activeUnitRefs: refs, phase: 'host', requestId,
    token: topicDecisionRecovery(current())?.token ?? fingerprint(current()) })
  await blocked('unknown-effect')
  assert.equal(topicDecisionRecovery(current()), null)
  await assert.rejects(h.service.retryMessageProcessing(args()), /MESSAGE_RETRY_STALE/)
  assert.equal((await h.query('task.list')).length, 0)
  await blocked('TASK_TOPIC_SOURCE_VERSION_MISSING')
  for (const patch of [{ messageVersion: 2 }, { activeUnitRefs: [] }, { requestId: 'foreign' }, { token: 'a'.repeat(64) }])
    await assert.rejects(h.service.retryMessageProcessing({ ...args(), ...patch }), /MESSAGE_RETRY_STALE/)
  const stale = args()
  const mutation = h.residentStore.updateTopicDecision({ groupId, topicId: topic.topicId, decisionId: requestId, patch: { progress: { newer: true } } })
  const retry = h.service.retryMessageProcessing(stale)
  await mutation
  await assert.rejects(retry, /MESSAGE_RETRY_STALE/)
  await h.service.store.command({ id: 'admit-host-original', kind: 'source.record', args: { sourceId: 'host-source', groupId, messageId, version: 1,
    actorId: 'native-user', text: original.text } })
  const successful = args()
  const results = await Promise.allSettled([h.service.retryMessageProcessing(successful), h.service.retryMessageProcessing(successful)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1, results.map(item => item.reason?.stack ?? item.status).join('; '))
  await h.service.whenIdle()
  assert.equal(current().status, 'completed')
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.residentStore.getGroup(groupId).messages.length, 1)
  assert.equal(h.residentStore.getGroup(groupId).outbox.length, 1)
  await assert.rejects(h.service.retryMessageProcessing(successful), /MESSAGE_RETRY_STALE/)
})

test('coordination exact recovery retains reservation generation and rejects old facts, frozen runtime and consumed CAS', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-coordination-retry-'))
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'coordination_submit')) return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '要查询哪个任务？', candidates: [] } }]
    return topicTaskCalls(request) ?? []
  }, { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } } })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const groupId = 'native-group', messageId = 'coord-original'
  const command = (kind, args) => h.service.store.command({ id: randomUUID(), kind, args })
  await h.residentStore.ingest({ groupId, messageId, text: '测试助手，稍后查询那个任务', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() })
  await h.residentStore.routeMessages({ groupId, routeId: 'coord-route', routingRevision: 0, routes: [{ messageId, messageVersion: 1,
    units: [{ unitKey: 'query', summary: '稍后查询任务', sourceRefs: [{ quote: '测试助手，稍后查询那个任务' }], dispatchOwner: 'coordination', topics: [], reason: '对象待确认' }] }] })
  const owner = h.residentStore.listSourceDispatchOwnership(groupId)[0], original = h.residentStore.getGroup(groupId).messages[0]
  await command('source.record', { sourceId: 'coord-source', groupId, messageId, version: 1, actorId: 'native-user', text: original.text })
  let source = (await command('coordination.reserve', { unitId: owner.unitId, revision: owner.unitRevision, groupId, original: original.text,
    reservationId: owner.reservationId, reservationGeneration: owner.generation, actorId: 'native-user', sourceRefs: ['coord-source'], sourceMessageId: messageId })).result.source
  for (let i = 0; i < 3; i++) source = (await command('coordination.source.failed', { sourceId: source.id, fence: source.fence, code: 'fixture-auth-blocked' })).result.source
  const token = createHash('sha256').update(JSON.stringify([source.id, source.fence, source.attemptCount ?? 0, source.retryEpoch ?? 0, source.nextRetryAt ?? null])).digest('hex')
  const args = { groupId, messageId, messageVersion: 1, activeUnitRefs: original.activeUnitRefs, phase: 'coordination', requestId: owner.reservationId, token }
  for (const patch of [{ messageVersion: 2 }, { activeUnitRefs: [] }, { requestId: 'foreign' }, { token: 'a'.repeat(64) }])
    await assert.rejects(h.service.retryMessageProcessing({ ...args, ...patch }), /MESSAGE_RETRY_|DYNAMIC_COORDINATION_SOURCE_STALE/)
  await command('coordination.runtime.set', { mode: 'frozen', reason: 'fixture freeze' })
  await assert.rejects(h.service.retryMessageProcessing(args), /MESSAGE_RETRY_UNAVAILABLE/)
  await command('coordination.runtime.set', { mode: 'active', reason: 'fixture unfreeze' })
  const results = await Promise.allSettled([h.service.retryMessageProcessing(args), h.service.retryMessageProcessing(args)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1, results.map(item => item.reason?.stack ?? item.status).join('; '))
  await h.service.whenIdle()
  const saved = await h.query('coordination.source', { unitId: owner.unitId, revision: owner.unitRevision })
  assert.equal(saved.id, source.id); assert.equal(saved.reservationId, owner.reservationId); assert.equal(saved.reservationGeneration, owner.generation)
  assert.equal(saved.retryEpoch, 1); assert.equal(saved.state, 'needs_clarification')
  assert.equal((await h.query('coordination.source.list')).length, 1)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.residentStore.getGroup(groupId).messages.length, 1)
  assert.deepEqual(await h.query('task.list'), [])
  await assert.rejects(h.service.retryMessageProcessing(args), /MESSAGE_RETRY_STALE|DYNAMIC_COORDINATION_SOURCE_STALE/)
})

test('精确收件恢复沿原生会话处理：外部启动阻塞未修再次失败，修复后成功且不复制事实', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-exact-retry-'))
  const agentConfig = { agentPreset: 'missing-fixture-preset' }
  const h = await nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对', evidence: [], limitations: [] } } }], { agentConfig })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'native-group', messageId: 'exact-source', text: '测试助手，请核对测试结果', senderOpenDingTalkId: 'native-user', occurredAt: new Date().toISOString() }
  await h.service.ingest(message)
  await h.service.whenIdle()
  await waitUntil(() => h.service.messageProcessingRequests(message.groupId).some(item => item.status === 'exhausted' && h.residentStore.getCoordinationRequest(message.groupId, item.requestId)?.startupAttempt === 1), 'initial durable startup failure')
  const original = structuredClone(h.residentStore.getGroup(message.groupId).messages[0])
  const args = () => {
    const request = h.service.messageProcessingRequests(message.groupId).find(item => item.status === 'exhausted')
    assert.ok(request)
    return { groupId: message.groupId, messageId: message.messageId, messageVersion: original.messageVersion, activeUnitRefs: original.activeUnitRefs ?? [],
      phase: request.topicId ? 'decision' : 'routing', requestId: request.requestId, token: request.retryToken }
  }
  const first = args()
  for (const patch of [{ groupId: 'foreign' }, { messageVersion: 999 }, { token: 'b'.repeat(64) }, { activeUnitRefs: [{ unitId: 'foreign', unitRevision: 1 }] }, { phase: 'decision' }])
    await assert.rejects(h.service.retryMessageProcessing({ ...first, ...patch }), /MESSAGE_RETRY_/)
  const attempts = await Promise.allSettled([h.service.retryMessageProcessing(first), h.service.retryMessageProcessing(first)])
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1, attempts.map(item => item.reason?.stack ?? item.status).join('; '))
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1)
  await h.service.whenIdle()
  await waitUntil(() => h.residentStore.getCoordinationRequest(message.groupId, first.requestId)?.startupAttempt >= 2, 'second durable startup failure')
  const second = args()
  assert.notEqual(second.token, first.token)
  await assert.rejects(h.service.retryMessageProcessing(first), /MESSAGE_RETRY_STALE/)
  agentConfig.agentPreset = 'native-test'
  await h.service.retryMessageProcessing(second)
  await h.service.whenIdle()
  await waitUntil(async () => (await h.query('source.list'))[0]?.processingCompleted, 'original source semantic completion')
  await h.service.whenIdle()
  await assert.rejects(h.service.retryMessageProcessing(second), /MESSAGE_RETRY_STALE/)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.residentStore.getGroup(message.groupId).messages.length, 1)
  const current = h.residentStore.getGroup(message.groupId).messages[0]
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId']) assert.deepEqual(current[key], original[key])
  assert.equal(current.routingStatus, 'routed')
  assert.ok(h.residentStore.listTopics(message.groupId).every(topic => topic.processedRevision === topic.revision))
  assert.ok((await h.query('source.list'))[0].processingCompleted)
})

test('explicit background message retry admits original facts through topics once without opening automatic history ingress', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-background-retry-'))
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) { const input = latestInput(request); return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'explicit-history', title: '原图位置调整' }] })) } }] }
    return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对原图位置', evidence: [], limitations: [] } } }] }, { config: { ingressEpoch: '2026-10-14T02:00:00.000Z' } })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const runtime = await openTaskResidentRuntime(h.ctx, h.residentStore, root)
  const message = { groupId: 'native-group', messageId: 'saved-history', text: '测试助手，请合并后调整描述输入框位置', senderOpenDingTalkId: 'native-user', senderName: '现场用户', occurredAt: '2026-10-14T01:25:51.750Z', sourceKind: 'dingtalk', quotedMessage: { messageId: 'prior', content: '原布局' }, imageRefs: [{ path: 'images/original.png', mediaType: 'image/png' }], resourceRefs: [{ type: 'fileId', resourceId: 'original-image', download: { ready: true } }] }
  await runtime.backfill([message])
  const before = structuredClone(h.residentStore.getGroup('native-group').messages[0])
  assert.equal(before.agentDeliveryStatus, 'skipped')
  assert.equal((await h.query('source.list')).length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal((await h.service.ingest(message)).accepted, false)
  await h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId })
  await h.service.whenIdle()
  const sources = await h.query('source.list'), tasks = await h.query('task.list')
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
  for (let i = 0; i < 2; i++) { await h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId }); await h.service.whenIdle() }
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.requests.length, requests)
  await runtime.backfill([{ ...message, messageId: 'another-old-message' }])
  await h.service.whenIdle()
  assert.equal(h.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'another-old-message').agentDeliveryStatus, 'skipped')
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.requests.length, requests)
})
