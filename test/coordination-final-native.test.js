import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'

const original = '九点查询原任务，不改变业务目标。'
const oldNotice = { id: 'legacy-query-notice', kind: 'coordination', state: 'prepared', requirementRevision: 1,
  payload: { conversationId: 'native-group', sourceMessageId: 'legacy-query-source', actorId: 'original-requester',
    text: '历史查询结果', atOpenDingTalkIds: ['original-recipient'], fact: { coordinationId: 'legacy-query', occurrenceId: 'legacy-slot' } } }
const rows = () => ({
  coordination: [{ id: 'legacy-query', groupId: 'native-group', state: 'active', revision: 1, readOnly: true }],
  coordination_sources: [{ id: 'legacy-source', unitId: 'legacy-unit', revision: 1, groupId: 'native-group',
    dispatchOwner: 'coordination', sourceMessageId: 'legacy-query-source', state: 'accepted', original, sourceRefs: [] }],
  coordination_schedules: [{ id: 'legacy-schedule', coordinationId: 'legacy-query', state: 'active', revision: 1, timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, nextDueAt: '2026-10-21T01:00:00.000Z',
    action: { kind: 'read-query', taskIds: ['A'] }, target: { conversationId: 'native-group', recipientIds: ['original-recipient'] } }],
  coordination_occurrences: [{ id: 'legacy-slot', coordinationId: 'legacy-query', scheduleId: 'legacy-schedule', scheduleRevision: 1,
    plannedAt: '2026-10-21T01:00:00.000Z', actionState: 'pending', deliveryState: 'pending', resultVersion: 1 }],
  coordination_jobs: [{ id: 'legacy-job', coordinationId: 'legacy-query', occurrenceId: 'legacy-slot', state: 'pending', fence: 1 }],
  notifications: [structuredClone(oldNotice)],
})
const message = (messageId, text) => ({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'current-reader',
  senderName: '当前查询人', text, timestamp: '2026-10-21T01:16:00Z' })

// Read through the actual scoped model tool, then submit an ordinary Topic reply.
// Task-fact replies use their separate schema through the shared fixture.
function readOnlyModel(request) {
  const input = latestInput(request), names = request.tools.map(tool => tool.name), values = modelToolValues(request)
  assert.ok(!names.includes('coordination_submit'))
  if (input.trigger === 'task-facts') return topicTaskCalls(request)
  if (names.includes('group_decision_submit')) {
    if (input.messages.every(message => message.messageId === 'context')) return [{ name: 'group_decision_submit', args: {
      requestId: input.requestId, topicId: input.topicId, revision: input.revision,
      decision: { basisMessageIds: ['context'], actions: [], reason: '保留历史上下文，无当前业务交办或回复要求。' },
    } }]
    const task = values.flatMap(value => value.tasks ?? []).find(item => item.taskId === 'A')
    if (!task) return [{ name: 'group_task_context_get', args: { taskIds: ['A'] } }]
    const review = values.findLast(value => Array.isArray(value.candidates))
    if (!review) return [{ name: 'group_reply_review_get', args: { requestIds: [input.requestId] } }]
    const source = input.messages.at(-1)
    return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
      decision: { basisMessageIds: [source.messageId], basisUnitRefs: [{ unitId: source.unitId, unitRevision: source.unitRevision }],
        actions: [], reply: `当前核验：${task.completion?.result?.summary ?? task.request}`, replyToMessageId: source.messageId,
        atOpenDingTalkIds: [source.senderOpenDingTalkId], replyReview: { kind: 'substantive',
          reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
  }
  return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: {
    action: 'complete', summary: '原材料已核验', evidence: ['original-completion'], limitations: [],
  } } }]
}

test('expired historical query remains audit-only after restart; a current read replies once without reopening its Task',
  { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    await t.beginBusiness()
    const f = await t.step(async () => retiredCoordinationHost(t, { name: 'final-expired-native-', tasks: [{ taskId: 'A', request: '原目标' }], rows: rows(), decide: readOnlyModel }))
    const before = await t.step(async () => f.host.query('task.get', { taskId: 'A' })), wakes = await t.step(async () => f.host.query('wake.list', { taskId: 'A' }))
    assert.equal(before.status, 'completed')
    t.mock.timers.tick(76 * 60000)
    await t.step(async () => f.host.service.recover()); await t.step(async () => f.host.service.whenIdle())
    assert.equal(f.host.sent.length, 0, 'Expiry cannot reactivate the retired scheduler or publish its old result')
    assert.equal((await t.step(async () => f.host.query('notification.get', { notificationId: oldNotice.id }))).state, 'superseded')
    const source = (await t.step(async () => f.host.query('coordination.source.list')))[0]
    assert.equal(source.original, original); assert.equal(source.state, 'accepted')
    const history = await t.step(async () => f.host.query('coordination.occurrence.list'))
    assert.equal(history.length, 1); assert.equal(history[0].actionState, 'pending', 'Retirement does not manufacture an expired execution')
    const query = message('current-query', '测试助手，只读核对原材料当前完成情况。')
    await t.step(async () => f.host.service.ingest(query)); await t.step(async () => f.host.service.whenIdle())
    assert.equal(f.host.sent.length, 1, JSON.stringify(f.host.service.listAlerts()))
    const notice = f.host.sent[0]
    assert.equal(notice.kind, 'topic-reply'); assert.equal(notice.payload.sourceMessageId, query.messageId)
    assert.deepEqual(notice.payload.atOpenDingTalkIds, ['current-reader'])
    assert.match(notice.payload.text, /原材料已核验/)
    assert.ok(f.host.toolResults.some(item => item.name === 'group_task_context_get' && JSON.stringify(item.result).includes('original-completion')),
      'The reply must be based on an actual successful scoped Task read, not merely visible tools')
    assert.equal((await t.step(async () => f.host.query('notification.get', { notificationId: notice.id }))).state, 'delivered')
    assert.deepEqual(await t.step(async () => f.host.query('task.get', { taskId: 'A' })), before)
    assert.deepEqual(await t.step(async () => f.host.query('wake.list', { taskId: 'A' })), wakes)
    await t.step(async () => f.restart())
    await t.step(async () => Promise.all([f.host.service.recover(), f.host.service.ingest(query)])); await t.step(async () => f.host.service.whenIdle())
    assert.equal(f.host.sent.length, 0)
    assert.deepEqual(await t.step(async () => f.host.query('coordination.occurrence.list')), history)
    assert.deepEqual(await t.step(async () => f.host.query('task.get', { taskId: 'A' })), before)
    const outbox = f.host.residentStore.getGroup('native-group').outbox.filter(item => item.outboundId === notice.id)
    assert.equal(outbox.length, 1); assert.equal(outbox[0].notificationState, 'delivered')
  }))

test('competing actual ingress and recovery supplement one current Task and preserve its source receipt after restart',
  { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'final-ingress-native-'))
    let host, decisions = 0
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    const decide = request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name), values = modelToolValues(request)
      if (input.trigger === 'task-facts') return topicTaskCalls(request)
      if (names.includes('group_decision_submit')) {
        const task = values.flatMap(value => value.tasks ?? []).find(item => item.taskId === 'A')
        if (!task) return [{ name: 'group_task_context_get', args: { taskIds: ['A'] } }]
        const review = values.findLast(value => Array.isArray(value.candidates))
        if (!review) return [{ name: 'group_reply_review_get', args: { requestIds: [input.requestId] } }]
        decisions++
        const refs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: {
          basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs: refs,
          actions: [{ kind: 'task-context', taskId: 'A', inputVersion: task.inputVersion, runSequence: task.runSequence,
            context: '唯一定位材料', progressImpact: 'preserve', topicRefs: [{ topicId: input.topicId, revision: input.revision }], basisUnitRefs: refs }],
          reply: '已将定位材料补入原任务。', replyToMessageId: 'same', atOpenDingTalkIds: ['native-user'],
          replyReview: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
        } } }]
      }
      return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: {
        action: 'wait', summary: '原目标不变，保留定位材料', evidence: [], limitations: [],
      } } }]
    }
    await t.beginBusiness()
    host = await t.step(async () => nativeTaskHost(root, decide))
    await t.step(async () => host.service.store.command({ id: 'seed', kind: 'task.create', args: {
      taskId: 'A', groupId: 'native-group', ownerActorId: 'native-user', request: '原目标',
    } }))
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    const before = await t.step(async () => host.query('task.get', { taskId: 'A' }))
    const input = { ...message('same', '测试助手，给原任务补充唯一定位材料。'), senderOpenDingTalkId: 'native-user' }
    await t.step(async () => Promise.all([host.service.ingest(input), host.service.ingest(input), host.service.recover()])); await t.step(async () => host.service.whenIdle())
    assert.equal(decisions, 1, JSON.stringify(host.service.listAlerts()))
    const after = await t.step(async () => host.query('task.get', { taskId: 'A' }))
    assert.equal(after.contextRevision, 1); assert.equal(after.sessionId, before.sessionId)
    assert.equal(after.requirementRevision, before.requirementRevision); assert.equal(after.runSequence, before.runSequence)
    const sources = (await t.step(async () => host.query('source.list'))).filter(item => item.messageId === 'same')
    assert.equal(sources.length, 1); assert.equal(sources[0].text, input.text)
    assert.deepEqual(await t.step(async () => host.query('coordination.list')), [])
    const topic = host.residentStore.listTopics('native-group')[0]
    // Persistence omits transient undefined diagnostic properties, preserving
    // the complete JSON decision, operation proof and delivery identity.
    const receipt = JSON.parse(JSON.stringify(host.residentStore.getTopic('native-group', topic.topicId).decisions.at(-1)))
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.decision.actions[0].taskId, 'A')
    const notice = host.sent.find(item => item.payload.sourceMessageId === 'same')
    assert.equal(notice?.kind, 'topic-reply'); assert.deepEqual(notice.payload.atOpenDingTalkIds, ['native-user'])
    await t.step(async () => host.close()); host = await t.step(async () => nativeTaskHost(root, decide, { initialize: false }))
    await t.step(async () => Promise.all([host.service.recover(), host.service.ingest(input)])); await t.step(async () => host.service.whenIdle())
    assert.equal(decisions, 1); assert.equal(host.sent.length, 0)
    assert.equal((await t.step(async () => host.query('task.get', { taskId: 'A' }))).contextRevision, 1)
    assert.deepEqual(host.residentStore.getTopic('native-group', topic.topicId).decisions.at(-1), receipt)
    assert.equal((await t.step(async () => host.query('task.list'))).length, 1)
  }))

for (const topology of ['closed', 'deleted']) test(`retired query cannot refresh or misaddress a current reply after restart with ${topology} optional Topic`,
  { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    await t.beginBusiness()
    const f = await t.step(async () => retiredCoordinationHost(t, { name: 'final-topology-native-', tasks: [{ taskId: 'A', request: '原目标' }], rows: rows(), decide: readOnlyModel }))
    const before = await t.step(async () => f.host.query('task.get', { taskId: 'A' }))
    await t.step(async () => f.host.residentStore.ingest({ ...message('context', '仅历史对话上下文'), occurredAt: '2026-10-21T00:00:00Z' }))
    await t.step(async () => f.host.residentStore.routeMessages({ groupId: 'native-group', routeId: 'context-route', routingRevision: 0,
      routes: [{ messageId: 'context', messageVersion: 1, topics: [{ newTopicKey: 'optional', title: '历史查询上下文' }] }] }))
    const topicId = f.host.residentStore.listTopics('native-group')[0].topicId
    // Isolated pre-upgrade outbox and Topic lifecycle facts, not a runtime deletion API.
    await t.step(async () => projectTaskNotification({ residentStore: f.host.residentStore,
      notification: { ...oldNotice, payload: { ...oldNotice.payload, topicRefs: [{ topicId, revision: 1 }] } } }))
    const groups = f.host.ctx.storageDomain.get(residentDomainSpec.name).table('groups')
    const group = structuredClone(groups.get('native-group'))
    if (topology === 'deleted') group.topics = []
    else group.topics[0].status = 'closed'
    await t.step(async () => groups.put('native-group', group))
    t.mock.timers.tick(76 * 60000); await t.step(async () => f.restart())
    await t.step(async () => f.host.service.recover()); await t.step(async () => f.host.service.whenIdle())
    const retired = await t.step(async () => f.host.query('notification.get', { notificationId: oldNotice.id }))
    assert.equal(retired.state, 'superseded'); assert.deepEqual(retired.payload, oldNotice.payload)
    assert.equal(f.host.sent.length, 0, 'An unavailable Topic cannot revive a retired prepared notification')
    const query = message('new-read', '测试助手，只读核对原材料现状，请回复当前查询。')
    await t.step(async () => f.host.service.ingest(query)); await t.step(async () => f.host.service.whenIdle())
    assert.equal(f.host.sent.length, 1, JSON.stringify(f.host.service.listAlerts()))
    const current = f.host.sent[0]
    assert.notEqual(current.id, oldNotice.id)
    assert.equal(current.payload.sourceMessageId, query.messageId)
    assert.deepEqual(current.payload.atOpenDingTalkIds, ['current-reader'])
    assert.notEqual(current.payload.replyTopicId, topicId)
    assert.deepEqual(await t.step(async () => f.host.query('task.get', { taskId: 'A' })), before)
    const oldOutbound = f.host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === oldNotice.id)
    assert.equal(oldOutbound.status, 'superseded'); assert.equal(oldOutbound.text, oldNotice.payload.text)
    const occurrence = (await t.step(async () => f.host.query('coordination.occurrence.list')))[0]
    assert.equal(occurrence.resultVersion, 1); assert.equal(occurrence.deliveryState, 'pending')
    await t.step(async () => f.restart()); await t.step(async () => f.host.service.recover()); await t.step(async () => f.host.service.whenIdle())
    assert.equal(f.host.sent.length, 0)
    assert.equal((await t.step(async () => f.host.query('notification.get', { notificationId: current.id }))).state, 'delivered')
    assert.equal((await t.step(async () => f.host.query('task.get', { taskId: 'A' }))).runSequence, before.runSequence)
  }))
