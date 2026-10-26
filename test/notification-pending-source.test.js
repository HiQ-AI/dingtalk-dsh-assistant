import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { deliverTaskNotification } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'

async function fixture(t, notificationId = 'old-clarification') {
  const root = await mkdtemp(join(tmpdir(), 'notification-pending-source-'))
  const config = { dbPath: join(root, 'task.sqlite'), instanceId: 'pending-source', initialize: true }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `command:${++sequence}`) => store.command({ kind, args, id })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const source = async (id, extra = {}) => (await command('source.record', { sourceId: id, groupId: 'g', messageId: id,
    actorId: 'owner', text: id, timestamp: '2026-10-23T08:00:00Z', ...extra })).result.source
  const reserve = async original => (await command('coordination.reserve', { unitId: `unit:${original.id}`, revision: 1,
    groupId: original.groupId, original: original.text, reservationId: `reservation:${original.id}`, reservationGeneration: 1,
    actorId: original.actorId, sourceRefs: [original.id], sourceMessageId: original.messageId })).result.source
  const complete = (original, units = []) => command('source.processingCompleted', { sourceId: original.id,
    messageVersion: original.version, routingRevision: 1, activeUnitRefs: units.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), units })
  const original = await source('original'), coordinated = await reserve(original)
  await command('coordination.source.clarify', { sourceId: coordinated.id, fence: 1, coordinationId: 'arrangement', question: '改到几点？' })
  const notification = (await command('notification.prepare', { notificationId, requirementRevision: 1, kind: 'coordination',
    payload: { conversationId: 'g', text: '改到几点？', sourceMessageId: original.messageId, actorId: original.actorId,
      fact: { coordinationId: 'arrangement', eventId: 'clarification:original', sourceUnitId: coordinated.unitId, sourceUnitRevision: 1 } } })).result.notification
  return { command, query, source, reserve, complete, notification, coordinated,
    async restart() { await store.close(); store = await openDynamicTaskStore(config) } }
}

for (const timestamp of ['2026-10-23T08:00:00Z', '2026-10-23T07:59:00Z']) test(`后续来源按准入顺序暂缓，相同start ID在重启和判定后可再次领取: ${timestamp}`, async t => {
  const f = await fixture(t), newer = await f.source('newer', { timestamp }), startId = 'notification-start:old-clarification:0'
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.command('notification.start', { notificationId: f.notification.id }, startId), { code: 'DYNAMIC_NOTIFICATION_SOURCE_PENDING' })
    assert.equal(await f.query('receipt.get', { id: startId }), null)
    const pending = await f.query('notification.get', { notificationId: f.notification.id })
    assert.equal(pending.state, 'prepared'); assert.equal(pending.sendAttemptCount, undefined)
    await f.restart()
  }
  await f.complete(newer)
  const started = await f.command('notification.start', { notificationId: f.notification.id }, startId)
  assert.equal(started.dispatchEligible, true); assert.equal(started.result.notification.sendAttemptCount, 1)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id }, startId)).dispatchEligible, false)
})

test('订正判定完成后旧澄清退役；暂缓不产生发送或错误重试', async t => {
  const f = await fixture(t), newer = await f.source('correction'), coordinated = await f.reserve(newer)
  let sends = 0
  await deliverTaskNotification({ notification: f.notification, command: f.command, notifications: { send: async () => { sends++ } } })
  assert.equal(sends, 0)
  await f.command('coordination.change', { sourceId: coordinated.id, fence: 1, coordinationId: 'arrangement', expectedRevision: 1,
    change: { action: 'resolve', members: [], readOnly: true } })
  await deliverTaskNotification({ notification: f.notification, command: f.command, notifications: { send: async () => { sends++ } } })
  assert.equal((await f.query('notification.get', { notificationId: f.notification.id })).state, 'superseded')
  assert.equal(sends, 0)
})

test('新的待澄清事项算本轮已判定；所有units和来源版本必须准确', async t => {
  const f = await fixture(t), newer = await f.source('different'), coordinated = await f.reserve(newer)
  const unit = { unitId: coordinated.unitId, unitRevision: 1, dispatchOwner: 'coordination' }
  await assert.rejects(f.complete(newer, [unit]), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.command('coordination.source.clarify', { sourceId: coordinated.id, fence: 1, coordinationId: 'other', question: '另一件事需要什么？' })
  await assert.rejects(f.command('source.processingCompleted', { sourceId: newer.id, messageVersion: 2, routingRevision: 1, activeUnitRefs: [], units: [] }), { code: 'DYNAMIC_SOURCE_REVISION_CONFLICT' })
  await assert.rejects(f.command('source.processingCompleted', { sourceId: newer.id, messageVersion: 1, routingRevision: 1,
    activeUnitRefs: [{ unitId: unit.unitId, unitRevision: 1 }], units: [] }), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.complete(newer, [unit])
  assert.equal((await f.query('coordination.source', { unitId: coordinated.unitId, revision: 1 })).settled, false)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

test('全部协调units判定后才释放，rejected完成持久handoff后不永挂', async t => {
  const f = await fixture(t), newer = await f.source('mixed'), first = await f.reserve(newer)
  const second = (await f.command('coordination.reserve', { unitId: 'second-unit', revision: 1, groupId: 'g', original: newer.text,
    reservationId: 'second-reservation', reservationGeneration: 1, actorId: 'owner', sourceRefs: [newer.id], sourceMessageId: newer.messageId })).result.source
  const units = [first, second].map(item => ({ unitId: item.unitId, unitRevision: 1, dispatchOwner: 'coordination' }))
  await f.command('coordination.source.clarify', { sourceId: first.id, fence: 1, coordinationId: 'different', question: '需要哪个对象？' })
  await assert.rejects(f.complete(newer, units), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.command('coordination.source.reject', { sourceId: second.id, fence: 1, reason: '交回普通话题处理' })
  units[1].dispatchOwner = 'legacy-topic'
  await assert.rejects(f.complete(newer, units), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  const frozen = await f.command('coordination.source.freezeHandoff', { sourceId: second.id, fence: 1, freezeId: 'handoff-proof' })
  await f.command('coordination.source.completeHandoff', { sourceId: second.id, fence: 1, handoffProof: frozen.result.handoffProof })
  await assert.rejects(f.complete(newer, units), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  units[1].processingComplete = true
  await f.complete(newer, units)
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

test('同版重路由只按精确refs失效旧语义戳，已routed来源也重新拦住旧通知', async t => {
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
  await assert.rejects(f.command('notification.start', { notificationId: f.notification.id }), { code: 'DYNAMIC_NOTIFICATION_SOURCE_PENDING' })
  await assert.rejects(f.complete(newer, [first]), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await assert.rejects(f.complete(newer, [{ ...next, processingComplete: false }]), { code: 'DYNAMIC_SOURCE_PROCESSING_INCOMPLETE' })
  await f.complete(newer, [next])
  assert.deepEqual((await f.query('source.get', { sourceId: newer.id })).processingCompleted.activeUnitRefs, [{ unitId: 'legacy', unitRevision: 2 }])
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, true)
})

for (const routed of [false, true]) test(`superseded pending source releases notifications without rewriting its route receipt: routed=${routed}`, async t => {
  const f = await fixture(t), old = await f.source('later-v1', { messageId: 'later' })
  const receipt = [{ topicId: 'original-topic', revision: 1 }]
  if (routed) await f.command('source.routed', { sourceId: old.id, receipt }, `topic-routed:${old.id}`)
  await f.command('source.processingStarted', { sourceId: old.id, messageVersion: 1, activeUnitRefs: [] })
  const replacement = await f.source('later-v2', { messageId: 'later', version: 2 })
  const args = { sourceId: old.id, receipt: routed ? receipt : [{ supersededByVersion: 2 }], supersededByVersion: 2 }
  await f.command('source.routed', args, `source-superseded:${old.id}:2`)
  await assert.rejects(f.command('notification.start', { notificationId: f.notification.id }), { code: 'DYNAMIC_NOTIFICATION_SOURCE_PENDING' })
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

for (const correction of [true, false]) test(`原生同群慢规划期间后续入站拦住旧回复并自动续跑: ${correction ? '订正' : '不同待澄清事项'}`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'notification-source-fence-native-'))
    const releaseFirst = Promise.withResolvers(), releaseSecond = Promise.withResolvers()
    let host, firstStarted = false, secondStarted = false
    t.after(async () => { releaseFirst.resolve(); releaseSecond.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, async request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: message.messageId, summary: '提醒验收', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '协调请求' }] })) } }]
      if (names.includes('coordination_submit')) {
        if (input.source.messageId === 'original') {
          firstStarted = true; await releaseFirst.promise
          return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '旧请求改到几点？', candidates: [] } }]
        }
        secondStarted = true; await releaseSecond.promise
        if (!correction) return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '另一件事请提供对象。', candidates: [] } }]
        const context = modelToolValues(request).find(value => value.arrangementContexts?.length)
        if (!context) return [{ name: 'coordination_context_get', args: { coordinationIds: [input.unresolved[0].coordinationId] } }]
        const original = context.arrangementContexts[0]
        return [{ name: 'coordination_submit', args: { kind: 'resolve', coordinationId: original.coordination.id,
          expectedRevision: original.coordination.revision, resolution: { kind: 'schedule', actionKind: 'message-reminder',
            timezone: 'Asia/Shanghai', rule: { kind: 'once', at: new Date(Math.ceil(Date.now() / 1000) * 1000 + 600000).toISOString() },
            recipientIds: [input.source.actorId], reminderText: '验收提醒', interpretation: '订正旧提醒' } } }]
      }
      return topicTaskCalls(request) ?? []
    }, { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } } })
    const envelope = { groupId: 'native-group', senderOpenDingTalkId: 'native-user', timestamp: new Date().toISOString() }
    await host.service.ingest({ ...envelope, messageId: 'original', text: '测试助手，三点提醒我验收。' })
    await waitUntil(() => firstStarted, '第一条规划已进入', 4000)
    await host.service.ingest({ ...envelope, messageId: 'newer', text: correction ? '测试助手，订正为十分钟后提醒。' : '测试助手，另一件事帮我查询。' })
    releaseFirst.resolve()
    await waitUntil(() => secondStarted, '新入站自动续跑，无需恢复轮询', 6000)
    assert.equal(host.sent.length, 0, '后续已入账但尚未判定时旧澄清不能发送')
    releaseSecond.resolve()
    await host.service.whenIdle()
    const diagnostics = JSON.stringify({ alerts: host.service.listAlerts(), notifications: await host.query('notification.list'), sources: await host.query('source.list'), tools: host.toolResults.slice(-3) })
    assert.equal(host.sent.filter(item => item.payload.sourceMessageId === 'original').length, correction ? 0 : 1,
      diagnostics)
    assert.equal(host.sent.filter(item => item.payload.sourceMessageId === 'newer').length, 1, diagnostics)
    const newer = (await host.query('source.list')).find(item => item.messageId === 'newer')
    assert.ok(newer.processingCompleted, 'needs_clarification也有本轮判定完成事实')
    for (const stage of ['ingress', 'queue', 'turn', 'host', 'send', 'readback'])
      assert.ok(newer.stages.some(item => item.stage === stage && item.completedAt), `missing ${stage}`)
    assert.ok(newer.stages.some(item => item.stage === 'turn' && item.sessionId.startsWith('independent-')))
    assert.ok(newer.stages.some(item => item.stage === 'host' && item.sessionId?.startsWith('independent-')))
    assert.equal(host.service.listAlerts().some(item => item.id?.startsWith('timing:')), false)
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
