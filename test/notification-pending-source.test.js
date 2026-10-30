import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { deliverTaskNotification } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { currentCoordinationFixture } from './fixtures/current-coordination-contracts.js'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'

async function fixture(t, notificationId = 'old-clarification') {
  const root = await mkdtemp(join(tmpdir(), 'notification-pending-source-'))
  const config = { dbPath: join(root, 'task.sqlite'), instanceId: 'pending-source', initialize: true }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `command:${++sequence}`) => store.command({ kind, args, id })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const source = async (id, extra = {}) => (await command('source.record', { sourceId: id, groupId: 'g', messageId: id,
    actorId: 'owner', text: id, timestamp: '2026-10-23T08:00:00Z', ...extra })).result.source
  const complete = (original, units = []) => command('source.processingCompleted', { sourceId: original.id,
    messageVersion: original.version, routingRevision: 1, activeUnitRefs: units.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), units })
  const original = await source('original')
  const notification = (await command('notification.prepare', { notificationId, requirementRevision: 1, kind: 'topic-reply',
    payload: { conversationId: 'g', text: '原事项的已判断结果', sourceMessageId: original.messageId, actorId: original.actorId,
      atOpenDingTalkIds: [original.actorId], fact: { topicRefs: [{ topicId: 'matter', revision: 1 }] } } })).result.notification
  return { command, query, source, complete, notification,
    async restart() { await store.close(); store = await openDynamicTaskStore(config) } }
}

// Pending sources belong to Topic preparation. A durable, frozen notification is
// not globally stalled or retargeted by later messages from the same person.
for (const timestamp of ['2026-10-23T08:00:00Z', '2026-10-23T07:59:00Z']) test('frozen Topic reply keeps its original audience despite a later pending source: ' + timestamp, async t => {
  const f = await fixture(t), newer = await f.source('newer', { timestamp }), startId = 'notification-start:original:0'
  await f.restart()
  const started = await f.command('notification.start', { notificationId: f.notification.id }, startId)
  assert.equal(started.dispatchEligible, true); assert.equal(started.result.notification.sendAttemptCount, 1)
  assert.deepEqual(started.result.notification.payload, f.notification.payload)
  assert.equal((await f.query('source.get', { sourceId: newer.id })).processingCompleted, undefined)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id }, startId)).dispatchEligible, false)
})

test('a newer Topic revision rejects stale preparation before persisting any reply, then accepts one fresh decision', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.finish(binding)
  const stale = f.submission(await f.context(), { reply: '原结论', atOpenDingTalkIds: ['author'] }, 'stale-decision')
  await f.resident.ingest({ groupId: 'group', messageId: 'correction', text: '补充最新验收要求', senderOpenDingTalkId: 'author', occurredAt: '2026-10-23T08:00:00Z' })
  const group = f.resident.getGroup('group')
  await f.resident.routeMessages({ groupId: 'group', routeId: 'correction', routingRevision: group.routingRevision,
    routes: [{ messageId: 'correction', messageVersion: 1, topics: [{ topicId: f.topicId }] }] })
  assert.equal((await f.submit(stale)).status, 'topic-stale')
  assert.deepEqual(await f.query('notification.list'), [])
  assert.equal(await f.query('receipt.get', { id: 'fact-decision:stale-decision' }), null)
  const topic = f.resident.getTopic('group', f.topicId)
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision: topic.revision, decisionId: 'current-source',
    decision: { basisMessageIds: ['correction'], actions: [], reason: '已核对补充要求，等待本轮事实判断' } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'current-source' })
  await f.reopen()
  assert.equal((await f.submit(f.submission(await f.context(), { reply: '已核对新要求', atOpenDingTalkIds: ['author'] }))).status, 'accepted')
  const [notice] = await f.query('notification.list')
  assert.equal(notice.payload.text, '已核对新要求')
  assert.deepEqual(notice.payload.atOpenDingTalkIds, ['author'])
  assert.equal(notice.payload.sourceMessageId, undefined, 'evidence sources do not force a native quote')
})

test('Topic reply preparation requires the exact quoted source version, not an older row with the same message id', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.finish(binding)
  await f.resident.ingest({ groupId: 'group', messageId: 'origin', messageVersion: 2, text: '核验原需求并报告结果（补充引用）', senderOpenDingTalkId: 'author', occurredAt: '2026-10-23T08:00:00Z' })
  const group = f.resident.getGroup('group')
  await f.resident.routeMessages({ groupId: 'group', routeId: 'version-2', routingRevision: group.routingRevision,
    routes: [{ messageId: 'origin', messageVersion: 2, topics: [{ topicId: f.topicId }] }] })
  const request = f.submission(await f.context(), { reply: '当前版本结论', replyToMessageId: 'origin', atOpenDingTalkIds: ['author'] }, 'exact-source')
  await assert.rejects(f.submit(request), { code: 'TOPIC_REPLY_SOURCE_INVALID' })
  assert.deepEqual(await f.query('notification.list'), [])
  await f.command('source.record', { sourceId: 'source-v2', groupId: 'group', messageId: 'origin', version: 2,
    actorId: 'author', channel: 'im', text: '核验原需求并报告结果（补充引用）' })
  const topic = f.resident.getTopic('group', f.topicId)
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision: topic.revision, decisionId: 'version-2-current',
    decision: { basisMessageIds: ['origin'], actions: [], reason: '当前版本已判断，等待事实回复' } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'version-2-current' })
  assert.equal((await f.submit(request)).status, 'accepted')
  assert.equal((await f.query('notification.list')).length, 1)
})

test('source completion requires every current Topic unit and exact message version', async t => {
  const f = await fixture(t), newer = await f.source('mixed')
  const units = ['first', 'second'].map(unitId => ({ unitId, unitRevision: 1, dispatchOwner: 'legacy-topic', processingComplete: false }))
  await f.command('source.processingStarted', { sourceId: newer.id, messageVersion: 1, activeUnitRefs: units.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) })
  await assert.rejects(f.command('source.processingCompleted', { sourceId: newer.id, messageVersion: 2, routingRevision: 1, activeUnitRefs: [], units: [] }), { code: 'DYNAMIC_SOURCE_REVISION_CONFLICT' })
  units[0].processingComplete = true
  await assert.rejects(f.complete(newer, units), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  units[1].processingComplete = true
  await assert.rejects(f.command('source.processingCompleted', { sourceId: newer.id, messageVersion: 1, routingRevision: 1,
    activeUnitRefs: units.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), units: [units[0]] }), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.complete(newer, units); await f.restart()
  assert.deepEqual((await f.query('source.get', { sourceId: newer.id })).processingCompleted.activeUnitRefs,
    units.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })))
})

test('same-version rerouting invalidates only exact semantic refs without changing a frozen notification', async t => {
  const f = await fixture(t), newer = await f.source('rerouted')
  const first = { unitId: 'legacy', unitRevision: 1, dispatchOwner: 'legacy-topic', processingComplete: true }
  await f.complete(newer, [first])
  const original = (await f.query('source.get', { sourceId: newer.id })).processingCompleted
  await f.command('source.routed', { sourceId: newer.id, receipt: [] })
  await f.command('source.processingStarted', { sourceId: newer.id, messageVersion: 1, activeUnitRefs: original.activeUnitRefs })
  assert.deepEqual((await f.query('source.get', { sourceId: newer.id })).processingCompleted, original)
  const next = { ...first, unitRevision: 2 }
  await f.command('source.processingStarted', { sourceId: newer.id, messageVersion: 1,
    activeUnitRefs: [{ unitId: next.unitId, unitRevision: 2 }] })
  const pending = await f.query('source.get', { sourceId: newer.id })
  assert.equal(pending.routed, true)
  assert.equal(pending.processingCompleted, undefined)
  assert.deepEqual(pending.processingHistory, [original])
  assert.deepEqual((await f.query('notification.get', { notificationId: f.notification.id })).payload, f.notification.payload)
  await assert.rejects(f.complete(newer, [first]), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await assert.rejects(f.complete(newer, [{ ...next, processingComplete: false }]), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.complete(newer, [next])
  assert.deepEqual((await f.query('source.get', { sourceId: newer.id })).processingCompleted.activeUnitRefs, [{ unitId: 'legacy', unitRevision: 2 }])
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

for (const routed of [false, true]) test(`superseded pending source preserves its route receipt and does not rewrite the frozen reply: routed=${routed}`, async t => {
  const f = await fixture(t), old = await f.source('later-v1', { messageId: 'later' })
  const receipt = [{ topicId: 'original-topic', revision: 1 }]
  if (routed) await f.command('source.routed', { sourceId: old.id, receipt }, `topic-routed:${old.id}`)
  await f.command('source.processingStarted', { sourceId: old.id, messageVersion: 1, activeUnitRefs: [] })
  const replacement = await f.source('later-v2', { messageId: 'later', version: 2 })
  const args = { sourceId: old.id, receipt: routed ? receipt : [{ supersededByVersion: 2 }], supersededByVersion: 2 }
  await f.command('source.routed', args, `source-superseded:${old.id}:2`)
  assert.deepEqual((await f.query('notification.get', { notificationId: f.notification.id })).payload, f.notification.payload)
  await f.complete(replacement)
  await f.restart()
  await f.command('source.routed', args, `source-superseded:${old.id}:2`)
  const retired = await f.query('source.get', { sourceId: old.id })
  assert.equal(retired.routed, true)
  assert.equal(retired.processingPending, false)
  assert.equal(retired.processingCompleted, undefined)
  assert.deepEqual(retired.routeReceipt, args.receipt)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

test('supersession requires a newer source for the same group and message', async t => {
  const f = await fixture(t), old = await f.source('later-v1', { messageId: 'later' })
  await f.command('source.processingStarted', { sourceId: old.id, messageVersion: 1, activeUnitRefs: [] })
  for (const [index, extra] of [{ groupId: 'other' }, { messageId: 'other' }, { actorId: 'other' }].entries()) {
    await f.source(`unrelated-${index}`, { messageId: 'later', version: 2, ...extra })
    await assert.rejects(f.command('source.routed', { sourceId: old.id, receipt: [], supersededByVersion: 2 }), { code: 'DYNAMIC_SOURCE_REVISION_CONFLICT' })
  }
  await assert.rejects(f.command('source.routed', { sourceId: old.id, receipt: [], supersededByVersion: 1 }), { code: 'DYNAMIC_SOURCE_REVISION_CONFLICT' })
  assert.equal((await f.query('source.get', { sourceId: old.id })).processingPending, true)
})

for (const extra of [{ actorId: 'another' }, { groupId: 'another-group' }]) test(`不同作者或群不阻塞: ${JSON.stringify(extra)}`, async t => {
  const f = await fixture(t)
  await f.source('unrelated', extra)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

test('已开始和unknown只对账，后续来源不使原发送重放', async t => {
  const f = await fixture(t)
  const started = (await f.command('notification.start', { notificationId: f.notification.id })).result.notification
  await f.source('later')
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, false)
  await f.command('notification.receipt', { notificationId: started.id, dispatchToken: started.dispatchToken, state: 'unknown' })
  let sends = 0, readbacks = 0
  await deliverTaskNotification({ notification: await f.query('notification.get', { notificationId: started.id }), command: f.command,
    notifications: { send: async () => { sends++ }, readback: async () => { readbacks++; return { messageId: 'actual', visible: true } } } })
  assert.equal(sends, 0); assert.equal(readbacks, 1)
})

test('明确原uuid长度校验拒绝在重启后只结清failed，保留证据且绝不发送', async t => {
  const f = await fixture(t, `coordination:${'x'.repeat(124)}`)
  const started = (await f.command('notification.start', { notificationId: f.notification.id })).result.notification
  const error = { category: 'api', code: 1, origin: 'dingtalk_api', operation: 'tools/call', reason: 'invalid_request',
    retryable: false, server_error_code: 'PARAM_ERROR', server_key: 'chat', stage: 'tool_validation',
    message: "sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is 137." }
  const persisted = { phase: 'send', exitCode: 1, stdout: '', message: 'dws_send_failed:1:PARAM_ERROR', serverErrorCode: 'PARAM_ERROR',
    origin: 'dingtalk_api', operation: 'tools/call', reason: 'invalid_request', retryable: false, stderr: JSON.stringify({ error }) }
  await f.command('notification.receipt', { notificationId: started.id, dispatchToken: started.dispatchToken,
    state: 'unknown', error: persisted, nextAttemptAt: '2099-01-01T00:00:00Z' })
  await f.restart()
  let sends = 0, reads = 0
  const notifications = { send: async () => { sends++ }, readback: async () => { reads++ } }
  await deliverTaskNotification({ notification: await f.query('notification.get', { notificationId: started.id }), command: f.command, notifications })
  await f.restart()
  const failed = await f.query('notification.get', { notificationId: started.id })
  assert.equal(failed.state, 'failed'); assert.equal(failed.sendAttemptCount, 1)
  assert.equal(failed.deliveryError.stderr, persisted.stderr); assert.equal(failed.deliveryError.knownNotSent, true)
  assert.equal(failed.deliveryError.retryable, false); assert.equal(failed.deliveryError.proof.kind, 'dws-uuid-validation-rejected')
  assert.match(failed.evidenceRef, /^notification-readback:/u)
  await deliverTaskNotification({ notification: failed, command: f.command, notifications })
  assert.equal(sends, 0); assert.equal(reads, 0)
})

for (const sameAuthor of [true, false]) test('native later Topic admission keeps two decisions and exact original recipients: sameAuthor=' + sameAuthor,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'notification-topic-admission-native-'))
    const releaseFirst = Promise.withResolvers(), releaseSecond = Promise.withResolvers()
    let host, firstStarted = false, secondStarted = false
    t.after(async () => { releaseFirst.resolve(); releaseSecond.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, async request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      const calls = topicTaskCalls(request)
      if (names.includes('group_decision_submit') && input.trigger !== 'task-facts') {
        const message = input.messages.at(-1)
        if (message.messageId === 'original') { firstStarted = true; await releaseFirst.promise }
        else { secondStarted = true; await releaseSecond.promise }
        calls[0].args.decision = { basisMessageIds: [message.messageId],
          basisUnitRefs: [{ unitId: message.unitId, unitRevision: message.unitRevision }],
          actions: [], reply: message.messageId === 'original' ? '原事项已核对。' : '另一事项已核对。',
          replyToMessageId: message.messageId, atOpenDingTalkIds: [message.senderOpenDingTalkId],
          replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } }
      }
      return calls ?? []
    })
    const envelope = { groupId: 'native-group', senderOpenDingTalkId: 'native-user', timestamp: new Date().toISOString() }
    await host.service.ingest({ ...envelope, messageId: 'original', text: '测试助手，请确认原事项。' })
    await waitUntil(() => firstStarted, 'original Topic decision entered', 4000)
    await host.service.ingest({ ...envelope, senderOpenDingTalkId: sameAuthor ? 'native-user' : 'other-user', messageId: 'newer', text: '测试助手，另一个独立事项也请确认。' })
    releaseFirst.resolve()
    await waitUntil(() => secondStarted, 'later Topic decision entered', 6000)
    releaseSecond.resolve(); await host.service.whenIdle()
    const diagnostics = JSON.stringify({ alerts: host.service.listAlerts(), tools: host.toolResults.slice(-4) })
    const [original] = host.sent.filter(item => item.payload.sourceMessageId === 'original')
    const [newer] = host.sent.filter(item => item.payload.sourceMessageId === 'newer')
    assert.ok(original && newer, diagnostics)
    assert.deepEqual(original.payload.atOpenDingTalkIds, ['native-user'])
    assert.deepEqual(newer.payload.atOpenDingTalkIds, [sameAuthor ? 'native-user' : 'other-user'])
    assert.equal(host.sent.length, 2, diagnostics); assert.deepEqual(await host.query('task.list'), [])
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(host.sent.length, 2)
    for (const source of await host.query('source.list')) assert.ok(source.processingCompleted)
  })

test('native enrichment retires an already routed pending version with an independent command identity',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'notification-source-superseded-native-'))
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, async request => {
      const input = latestInput(request)
      return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
          units: [], ignoredRefs: [{ quote: item.text, reason: '日常寒暄，无待执行事项' }] })) } }]
    })
    const envelope = { groupId: 'native-group', messageId: 'greeting', senderOpenDingTalkId: 'native-user',
      timestamp: new Date().toISOString(), text: '测试助手，早上好。' }
    await host.service.ingest(envelope)
    await host.service.whenIdle()
    const first = (await host.query('source.list'))[0]
    assert.equal(first.routed, true)
    assert.ok(await host.query('receipt.get', { id: `topic-routed:${first.sourceId}` }))
    await host.service.store.command({ id: 'reroute-old-version', kind: 'source.processingStarted',
      args: { sourceId: first.sourceId, messageVersion: 1, activeUnitRefs: [{ unitId: 'reclassified', unitRevision: 2 }] } })
    assert.equal((await host.query('source.get', { sourceId: first.sourceId })).processingPending, true)
    await host.service.ingest({ ...envelope, quotedMessage: { messageId: 'prior-greeting', content: '早安。' } })
    await host.service.whenIdle()
    await host.service.recover()
    await host.service.whenIdle()
    const retired = await host.query('source.get', { sourceId: first.sourceId })
    const current = (await host.query('source.list')).find(item => item.version === 2)
    assert.ok(current?.processingCompleted)
    assert.equal(retired.processingPending, false)
    assert.equal(retired.processingCompleted, undefined)
    assert.deepEqual(retired.routeReceipt, first.routeReceipt)
    assert.deepEqual(retired.processingHistory, [first.processingCompleted])
    assert.ok(await host.query('receipt.get', { id: `source-superseded:${first.sourceId}:2` }))
    assert.equal(host.service.listAlerts().length, 0)
    assert.equal(host.sent.length, 0)
  })
