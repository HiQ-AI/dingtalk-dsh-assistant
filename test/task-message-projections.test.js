import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestTaskResidentMessage, taskNotificationOutbound, projectTaskNotification, stableTaskResourceIdentity, mergeTaskResources, taskBoardState, messageProcessingSources } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { retiredSourceOwnership, COORDINATION_RETIRED_REASON } from '../packages/dingtalk-dsh-assistant/coordination-retirement.js'

function memoryFacility(seed = new Map(), onWrite = () => {}) {
  const table = name => ({
    get: key => seed.get(`${name}:${key}`),
    entries: () => [...seed.entries()].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value])[Symbol.iterator](),
    async put(key, value) { seed.set(`${name}:${key}`, value) },
    async delete(key) { seed.delete(`${name}:${key}`) },
    async update(key, transform) { const id = `${name}:${key}`; const value = transform(seed.get(id)); onWrite(name, key); seed.set(id, value); return value },
  })
  return { async open() { return { table, close: async () => undefined } } }
}

test('retired coordination projection is bound to the exact source version and exposes no private ledger or retry token', () => {
  const source = { sourceId: 's', groupId: 'g', messageId: 'm', version: 2 }
  const ref = { unitId: 'u', unitRevision: 2 }
  const retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at: '2026-10-29T00:00:00Z' }
  const owner = { ...ref, reservationId: 'r', generation: 3, dispatchOwner: 'coordination', semanticState: 'reserved',
    retirement, sourceSnapshot: { groupId: 'g', messageId: 'm', messageVersion: 2 }, original: 'private', lastError: 'private' }
  const ledger = { id: 'old-ledger', original: 'private', lastError: 'private' }
  const read = () => messageProcessingSources(retiredSourceOwnership([source], [owner], 'g'), [], 'g', [ledger], [owner]).find(row => row.sourceId === 's')
  assert.deepEqual(read().coordinationRetirement, { ...retirement, units: [ref] })
  assert.equal(read().coordination, undefined)
  assert.equal(read().retryToken, undefined)
  assert.equal(read().processingCompleted, null, 'Feature retirement is not a semantic decision or business completion')
  assert.equal(JSON.stringify(read()).includes('private'), false)
  for (const patch of [{ groupId: 'other' }, { messageId: 'other' }, { messageVersion: 1 }]) {
    const previous = owner.sourceSnapshot
    owner.sourceSnapshot = { ...previous, ...patch }
    assert.equal(read().coordinationRetirement, null)
    owner.sourceSnapshot = previous
  }
  owner.dispatchOwner = 'legacy-topic'
  assert.equal(read().coordinationRetirement, null)
})

test('old clarification, partial acceptance and accepted facts stay in audit without being presented as current work', () => {
  const source = { sourceId: 's', groupId: 'g', messageId: 'm', version: 1 }
  const retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at: '2026-10-29T00:00:00Z' }
  for (const historical of [
    { state: 'needs_clarification', question: 'Which change should be deployed?' },
    { state: 'accepted', pendingClarifications: [{ question: 'Which environment?' }] },
    { state: 'accepted', resolvedBy: 'new-source' },
  ]) {
    const owner = { unitId: 'u', unitRevision: 1, dispatchOwner: 'coordination', retirement,
      sourceSnapshot: { messageId: 'm', messageVersion: 1 }, ...historical }
    const before = structuredClone(owner)
    const [result] = messageProcessingSources(retiredSourceOwnership([source], [owner], 'g'),
      [{ id: 'n', payload: { conversationId: 'g', sourceMessageId: 'm', text: 'Cannot infer a decision from this message' } }], 'g', [historical], [owner])
    assert.deepEqual(owner, before, 'Projection must not rewrite original audit facts')
    assert.equal(result.coordinationRetirement.reason, COORDINATION_RETIRED_REASON)
    assert.equal(result.processingCompleted, null)
    assert.equal(result.coordination, undefined)
    assert.equal(JSON.stringify(result).includes('Cannot infer'), false)
  }
})

test('legacy missing-quote recovery cannot reopen retired coordination or fabricate current source evidence', () => {
  const quote = { messageId: 'delivery', content: 'Original result references' }
  const source = { sourceId: 's', groupId: 'g', messageId: 'm', version: 1, actorId: 'author', quote,
    activeUnitRefs: [{ unitId: 'u', unitRevision: 1 }] }
  const owner = { unitId: 'u', unitRevision: 1, reservationId: 'r', generation: 1, dispatchOwner: 'coordination',
    semanticState: 'needs_clarification', sourceSnapshot: { messageId: 'm', messageVersion: 1 } }
  const before = structuredClone(source)
  for (const ledger of [
    { fence: 1, state: 'needs_clarification', coordinationId: 'a' },
    { fence: 2, state: 'needs_clarification', contextReconsideration: { at: 'already-requested' } },
    { fence: 2, state: 'accepted', resolvedBy: 'answer' },
  ]) {
    const [row] = messageProcessingSources([source], [], 'g', [ledger], [owner], [{ id: 'a', revision: ledger.fence }])
    assert.equal(row.coordination, undefined)
    assert.equal(row.contextRecoveryToken, undefined)
    assert.equal(row.coordinationRetirement, null, 'An old row alone does not prove retirement occurred')
    assert.equal(row.processingCompleted, null)
  }
  assert.deepEqual(source, before)
})

test('message processing DTO keeps exact source versions, unknown history and no private content', () => {
  const sources = [1, 2].map(version => ({ sourceId: `s${version}`, groupId: 'g', messageId: 'm', version, channel: 'im', text: 'private', actorId: 'private',
    routed: version === 1, updatedAt: 'not-a-stage', processingCompleted: version === 1 ? { at: 'completed', routingRevision: 3, activeUnitRefs: [{ unitId: 'u', unitRevision: 1 }] } : null }))
  const notices = [{ id: 'old', state: 'delivered', updatedAt: 'not-delivery', payload: { conversationId: 'g', sourceMessageId: 'm', text: 'secret' } },
    { id: 'exact', state: 'delivered', deliveredAt: 'verified', payload: { conversationId: 'g', sourceMessageId: 'm', sourceId: 's1', sourceVersion: 1 } }]
  sources[0].stages = [{ spanId: 'span', stage: 'turn', requestId: 'request', attempt: 0, startedAt: 'start', completedAt: null, quality: 'open', shared: true, text: 'secret' }]
  const result = messageProcessingSources(sources, notices, 'g')
  assert.equal(result.length, 2)
  assert.deepEqual(result[0].stages, [{ spanId: 'span', stage: 'turn', requestId: 'request', attempt: 0, startedAt: 'start', completedAt: null, quality: 'open', shared: true }])
  assert.deepEqual(result[1].stages, [])
  assert.equal(result[0].processingCompleted.at, 'completed')
  assert.equal(result[1].processingCompleted, null)
  for (const row of result) { assert.equal(row.receivedAt, null); assert.equal(row.routedAt, null); assert.equal(row.text, undefined); assert.equal(row.actorId, undefined) }
  assert.equal(result[0].notifications.find(n => n.notificationId === 'old').deliveredAt, null)
  assert.equal(result[0].notifications.find(n => n.notificationId === 'old').versionMatched, false)
  assert.equal(result[0].notifications.find(n => n.notificationId === 'exact').versionMatched, true)
  assert.equal(result[1].notifications.some(n => n.notificationId === 'exact'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(messageProcessingSources(sources, notices, 'other'), [])
})

test('new inbound image bytes become existing attachment references without losing quote facts', async () => {
  const quote = { messageId: 'quoted', senderName: 'Alice', content: '事实' }
  const images = [{ data: new Uint8Array([1]), mediaType: 'image/png' }]
  const refs = [{ id: 'attachment-1' }]
  let saved, stored
  await ingestTaskResidentMessage({ ctx: { attachments: { saveImages: async value => { saved = value; return refs } } },
    residentStore: { ingest: async value => { stored = value; return { sequence: 1 } } },
    message: { groupId: 'g', messageId: 'm', text: '图片', images, quotedMessage: quote } })
  assert.equal(saved, images)
  assert.equal(stored.quotedMessage, quote)
  assert.deepEqual(stored.imageRefs.map(({ taskMediaFingerprint, ...ref }) => ref), refs)
  assert.match(stored.imageRefs[0].taskMediaFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(stored.images, undefined)
})

test('image references can be hydrated while documents remain lazy and failures are visible', async () => {
  let stored
  const read = []
  await ingestTaskResidentMessage({ ctx: { attachments: { saveImages: async value => value.map((_, i) => ({ id: `i${i}` })) } },
    residentStore: { ingest: async value => { stored = value } },
    readResource: async (_g, _m, ref) => { read.push(ref.resourceId); if (ref.resourceId === 'bad') throw new Error('offline'); return { image: { data: new Uint8Array([2]) } } },
    message: { groupId: 'g', messageId: 'm', resourceRefs: [{ type: 'mediaId', resourceId: 'ok' }, { type: 'dingtalkDoc', resourceId: 'doc' }, { type: 'mediaId', resourceId: 'bad' }] } })
  assert.deepEqual(read, ['ok', 'bad'])
  assert.equal(stored.imageRefs[0].id, 'i0')
  assert.deepEqual(stored.mediaUnavailable, ['bad: offline'])
})

test('already-loaded failure facts do not trigger another download during ingress', async () => {
  await ingestTaskResidentMessage({ residentStore: { ingest: async value => assert.deepEqual(value.mediaUnavailable, ['offline']) },
    readResource: () => assert.fail('must not redownload'),
    message: { mediaUnavailable: ['offline'], resourceRefs: [{ type: 'mediaId', resourceId: 'r' }] } })
})

test('notification projections retain unknown and only verified delivery becomes sent', async () => {
  const notification = { id: 'n', taskId: 't', state: 'unknown', createdAt: 'start', updatedAt: 'end', dispatchToken: 'claim',
    payload: { conversationId: 'g', sourceMessageId: 'm', actorId: 'u', text: '结果', topicRefs: [{ topicId: 'topic', revision: 1 }] }, receipt: { messageId: 'ack' } }
  const unknown = taskNotificationOutbound(notification)
  assert.equal(unknown.status, 'pending')
  assert.equal(unknown.notificationState, 'unknown')
  assert.equal(unknown.deliveredMessageId, undefined)
  assert.equal(unknown.sendStartedAt, undefined, '历史通知缺少真实开始时间，不使用创建时间')
  assert.equal(taskNotificationOutbound({ ...notification, sendStartedAt: 'actual-start' }).sendStartedAt, 'actual-start')
  assert.equal(unknown.deliveryPendingReason, 'task-notification-unknown')
  assert.deepEqual(unknown.topicRefs, notification.payload.topicRefs)
  const delivered = taskNotificationOutbound({ ...notification, state: 'delivered', receipt: { messageId: 'proof', observedAt: 'seen' } })
  assert.equal(delivered.status, 'sent')
  assert.equal(delivered.deliveredMessageId, 'proof')
  assert.equal(delivered.deliveredAt, 'seen')
  const calls = []
  await projectTaskNotification({ residentStore: { projectTaskNotification: async value => calls.push(value) }, notification })
  assert.deepEqual(calls, [{ groupId: 'g', outbound: unknown }])
})

test('通知重复投影不再持久写，真实状态变化只写一次并保留既有业务关联', async t => {
  let writes = 0
  const seed = new Map(), facility = memoryFacility(seed, name => { if (name === 'groups') writes++ })
  const store = await openResidentStore(facility); t.after(() => store.close())
  await store.subscribe({ groupId: 'g' })
  await store.appendOutbox({ groupId: 'g', outboundId: 'n', sourceMessageId: 'source', text: '回复', decisionId: 'decision' })
  const notification = { id: 'n', state: 'prepared', payload: { conversationId: 'g', text: '回复' } }
  await projectTaskNotification({ residentStore: store, notification })
  const initialWrites = writes
  for (let i = 0; i < 100; i++) await projectTaskNotification({ residentStore: store, notification })
  assert.equal(writes, initialWrites)
  const delivered = { ...notification, state: 'delivered', sendStartedAt: '2026-10-23T07:12:52Z',
    receipt: { messageId: 'sent', observedAt: '2026-10-23T07:12:56Z' } }
  await projectTaskNotification({ residentStore: store, notification: delivered })
  await projectTaskNotification({ residentStore: store, notification: delivered })
  await projectTaskNotification({ residentStore: store, notification })
  assert.equal(writes, initialWrites + 1)
  assert.equal(store.getGroup('g').outbox[0].decisionId, 'decision')
  assert.equal(store.getGroup('g').outbox[0].notificationState, 'delivered')
})

test('retired coordination notification projects terminal superseded even before a replacement exists', async t => {
  const store=await openResidentStore(memoryFacility());t.after(()=>store.close())
  await store.subscribe({groupId:'g'})
  const candidate={id:'retired-summary',state:'prepared',payload:{conversationId:'g',text:'earlier facts'}}
  await projectTaskNotification({residentStore:store,notification:candidate})
  await projectTaskNotification({residentStore:store,notification:{...candidate,state:'superseded',retirement:{reason:'coordination-facts-changed'}}})
  let outbound=store.getGroup('g').outbox[0]
  assert.equal(outbound.notificationState,'superseded');assert.equal(outbound.status,'superseded')
  await projectTaskNotification({residentStore:store,notification:candidate})
  outbound=store.getGroup('g').outbox[0]
  assert.equal(outbound.notificationState,'superseded');assert.equal(outbound.status,'superseded')
})

test('取消投影只使用未领取发送许可或明确拒发事实，保留原通知生命周期', () => {
  const base = { id: 'cancelled', state: 'superseded', payload: { conversationId: 'g', text: '旧确认' },
    retirement: { reason: 'coordination-source-resolved' }, nextAttemptAt: '2099-01-01T00:00:00Z' }
  const cancelled = taskNotificationOutbound(base)
  assert.equal(cancelled.notificationState, 'superseded')
  assert.equal(cancelled.notificationKnownNotSent, true)
  assert.equal(cancelled.deliveryPendingReason, 'task-notification-coordination-source-resolved')
  assert.equal(cancelled.notificationRetryAt, undefined)
  for (const evidence of [{ ack: {} }, { receipt: {} }, { sendPermit: {} }, { dispatchToken: 'claimed' },
    { sendStartedAt: '2026-10-24T01:00:00Z' }, { sendAttemptCount: 1 }]) {
    assert.equal(taskNotificationOutbound({ ...base, ...evidence }).notificationKnownNotSent, false, JSON.stringify(evidence))
  }
  const rejected = { ...base, sendPermit: {}, sendAttemptCount: 1, deliveryError: { phase: 'send', knownNotSent: true, retryable: false } }
  assert.equal(taskNotificationOutbound(rejected).notificationKnownNotSent, true)
  for (const evidence of [{ ack: {} }, { receipt: {} }]) {
    assert.equal(taskNotificationOutbound({ ...rejected, ...evidence }).notificationKnownNotSent, false)
  }
  for (const [reason, projected] of [['coordination_cancelled', 'coordination-cancelled'], ['stale_question', 'stale-question']]) {
    const failed = { ...base, state: 'failed', reason, retirement: undefined }
    assert.equal(taskNotificationOutbound(failed).notificationKnownNotSent, true)
    assert.equal(taskNotificationOutbound(failed).deliveryPendingReason, `task-notification-${projected}`)
    assert.equal(taskNotificationOutbound(failed).notificationRetryAt, undefined)
    assert.equal(taskNotificationOutbound({ ...failed, sendPermit: {} }).notificationKnownNotSent, false)
  }
})

test('旧取消原因不能覆盖当前待发送、发送中、未知和已送达事实', () => {
  const base = { id: 'current', payload: { conversationId: 'g', text: '通知' }, reason: 'coordination_cancelled',
    retirement: { reason: 'task-terminal' }, deliveryError: { phase: 'send', knownNotSent: true, message: '旧错误' },
    nextAttemptAt: '2099-01-01T00:00:00Z', supersededBy: 'new' }
  for (const state of ['prepared', 'starting', 'unknown']) {
    const outbound = taskNotificationOutbound({ ...base, state })
    assert.equal(outbound.notificationKnownNotSent, false)
    assert.equal(outbound.deliveryPendingReason, `task-notification-${state}`)
    assert.equal(outbound.notificationRetryAt, base.nextAttemptAt)
  }
  const delivered = taskNotificationOutbound({ ...base, state: 'delivered', receipt: { messageId: 'actual', observedAt: 'seen' } })
  assert.equal(delivered.status, 'sent')
  assert.equal(delivered.notificationKnownNotSent, false)
  assert.equal(delivered.notificationRetryAt, undefined)
  assert.equal(delivered.deliveryPendingReason, undefined)
  assert.equal(delivered.deliveryError, undefined)
  assert.equal(delivered.notificationFailurePhase, undefined)
  assert.equal(delivered.deliveredMessageId, 'actual')
})

test('正式终止与可重试拒发分开投影，重投影清除已失效的诊断和重试计划', async t => {
  const base = { id: 'retired', state: 'failed', payload: { conversationId: 'g', text: '旧确认' },
    deliveryError: { phase: 'send', knownNotSent: true, retryable: true, message: '发送前检查失败' },
    nextAttemptAt: '2099-01-01T00:00:00Z' }
  assert.equal(taskNotificationOutbound(base).notificationRetryAt, base.nextAttemptAt)
  for (const reason of ['task-terminal', 'superseded', 'confirmation-reassessment-required']) {
    const retired = taskNotificationOutbound({ ...base, retirement: { reason } })
    assert.equal(retired.notificationState, 'failed')
    assert.equal(retired.notificationKnownNotSent, true)
    assert.equal(retired.deliveryPendingReason, `task-notification-${reason}`)
    assert.equal(retired.notificationRetryAt, undefined)
  }
  assert.equal(taskNotificationOutbound({ ...base, deliveryError: { ...base.deliveryError, retryable: false } }).notificationRetryAt, undefined)
  const seed = new Map(), store = await openResidentStore(memoryFacility(seed)); t.after(() => store.close())
  await store.subscribe({ groupId: 'g' })
  await projectTaskNotification({ residentStore: store, notification: base })
  assert.equal(store.getGroup('g').outbox[0].notificationFailurePhase, 'send')
  await projectTaskNotification({ residentStore: store, notification: { ...base, state: 'superseded', deliveryError: undefined,
    retirement: { reason: 'coordination-source-resolved' } } })
  const saved = store.getGroup('g').outbox[0]
  assert.equal(saved.notificationState, 'superseded')
  assert.equal(saved.notificationKnownNotSent, true)
  for (const key of ['notificationRetryAt', 'notificationFailurePhase', 'deliveryError']) assert.equal(Object.hasOwn(saved, key), false, key)
  await store.close()
  const reopened = await openResidentStore(memoryFacility(seed)); t.after(() => reopened.close())
  assert.deepEqual(reopened.getGroup('g').outbox[0], saved)
})

test('question and completion for the same source have separate stable timeline identities', () => {
  const payload = { conversationId: 'g', sourceMessageId: 'm', text: '?' }
  assert.notEqual(taskNotificationOutbound({ id: 'question', state: 'prepared', payload }).sourceMessageId,
    taskNotificationOutbound({ id: 'completion', state: 'prepared', payload }).sourceMessageId)
})

test('话题回复投影改写来源后沿 outboundId 恢复，拒绝正文或引用冲突', async () => {
  const store = await openResidentStore(memoryFacility())
  try {
    await store.subscribe({ groupId: 'g' })
    const args = { groupId: 'g', outboundId: 'reply', decisionId: 'decision', sourceMessageId: 'topic-decision:decision',
      text: '原回复', replyToMessageId: 'm', replyToSenderOpenDingTalkId: 'u' }
    await store.appendOutbox(args)
    await projectTaskNotification({ residentStore: store, notification: { id: 'reply', state: 'delivered',
      receipt: { messageId: 'delivered-reply' }, payload: { conversationId: 'g', sourceMessageId: 'm', actorId: 'u', text: '原回复' } } })
    assert.equal(store.getGroup('g').outbox[0].sourceMessageId, 'task-notification:reply')
    await store.appendOutbox(args)
    for (const change of [{ text: '其他回复' }, { decisionId: 'other' }, { replyToMessageId: 'other' }, { replyToSenderOpenDingTalkId: 'other' }])
      await assert.rejects(store.appendOutbox({ ...args, ...change }), /outbox_identity_conflict/)
    assert.equal(store.getGroup('g').outbox.length, 1)
    assert.equal(store.getGroup('g').outbox[0].deliveredMessageId, 'delivered-reply')
  } finally { await store.close() }
})

test('existing resident timeline persists new images, quotes and notification readback states across reopen', async () => {
  const seed = new Map()
  let store = await openResidentStore(memoryFacility(seed))
  await store.subscribe({ groupId: 'g' })
  await ingestTaskResidentMessage({ ctx: { attachments: { saveImages: async () => [{ id: 'image' }] } }, residentStore: store,
    message: { groupId: 'g', messageId: 'm', text: '截图', occurredAt: '2026-10-14T00:00:00Z',
      images: [{ data: new Uint8Array([1]) }], quotedMessage: { messageId: 'q', content: '原文' } } })
  const notification = { id: 'new-n', state: 'unknown', taskId: 'new-task', createdAt: '2026-10-14T00:00:01Z', updatedAt: '2026-10-14T00:00:02Z',
    payload: { conversationId: 'g', sourceMessageId: 'm', actorId: 'u', text: '回复' } }
  await projectTaskNotification({ residentStore: store, notification })
  await projectTaskNotification({ residentStore: store, notification })
  assert.equal(store.getGroup('g').outbox.length, 1)
  assert.equal(store.getGroup('g').outbox[0].notificationState, 'unknown')
  await store.close()
  store = await openResidentStore(memoryFacility(seed))
  assert.equal(store.getGroup('g').messages[0].imageRefs[0].id, 'image')
  assert.equal(store.getGroup('g').messages[0].quotedMessage.content, '原文')
  await projectTaskNotification({ residentStore: store, notification: { ...notification, state: 'delivered', receipt: { messageId: 'selfecho', sentAt: '2026-10-14T00:00:02.000Z', observedAt: '2026-10-14T00:00:03Z' } } })
  const outbound = store.getGroup('g').outbox[0]
  assert.equal(outbound.status, 'sent')
  assert.equal(outbound.notificationState, 'delivered')
  assert.equal(outbound.deliveredMessageId, 'selfecho')
  assert.equal(outbound.deliveryPendingReason, undefined)
  await store.close()
  store = await openResidentStore(memoryFacility(seed))
  assert.equal(store.getGroup('g').outbox[0].sentAt, '2026-10-14T00:00:02.000Z')
  assert.equal(store.getGroup('g').outbox[0].deliveredAt, '2026-10-14T00:00:03Z')
  await store.close()
})

test('stable resource identity ignores transport enrichment and input ordering, but distinguishes real changes', () => {
  const original = [{ type: 'mediaId', resourceId: 'r' }, { type: 'file', fileId: 'f' }]
  const enriched = [{ type: 'file', fileId: 'f', download: { token: 'new' } }, { type: 'mediaId', resourceId: 'r', resourceIdType: 'media', download: { metadata: { name: 'image' } } }]
  assert.equal(stableTaskResourceIdentity(original), stableTaskResourceIdentity(enriched))
  assert.notEqual(stableTaskResourceIdentity(original), stableTaskResourceIdentity([{ type: 'mediaId', resourceId: 'other' }]))
  assert.notEqual(stableTaskResourceIdentity(original), stableTaskResourceIdentity([{ type: 'doc', resourceId: 'r' }, original[1]]))
})

test('resource merge preserves deep download hints only for identical real resource identities', () => {
  const previous = [{ type: 'mediaId', resourceId: 'r', download: { metadata: { name: 'a', size: 10 }, token: 'old' } }]
  const incoming = [{ type: 'mediaId', resourceId: 'r', resourceIdType: 'media', download: { metadata: { name: 'b' } } }]
  assert.deepEqual(mergeTaskResources(previous, incoming)[0].download, { metadata: { name: 'b', size: 10 }, token: 'old' })
  const changed = [{ type: 'mediaId', resourceId: 'new' }]
  assert.deepEqual(mergeTaskResources(previous, changed), changed)
  assert.deepEqual(mergeTaskResources(previous, []), [])
})

test('same image bytes reuse persisted refs across reopen, changed bytes produce a new fact', async () => {
  const seed = new Map()
  let saves = 0, store = await openResidentStore(memoryFacility(seed))
  await store.subscribe({ groupId: 'images' })
  const ctx = { attachments: { saveImages: async () => [{ id: `saved-${++saves}` }] } }
  const message = { groupId: 'images', messageId: 'm', text: '', occurredAt: '2026-10-14T00:00:00Z', images: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] }
  await ingestTaskResidentMessage({ ctx, residentStore: store, message })
  await store.close()
  store = await openResidentStore(memoryFacility(seed))
  const duplicate = await ingestTaskResidentMessage({ ctx, residentStore: store, message })
  assert.equal(saves, 1)
  assert.equal(duplicate.enriched, false)
  assert.equal(store.getGroup('images').messages[0].messageVersion, 1)
  const changed = await ingestTaskResidentMessage({ ctx, residentStore: store, message: { ...message, images: [{ data: new Uint8Array([2]), mediaType: 'image/png' }] } })
  assert.equal(saves, 2)
  assert.equal(changed.enriched, true)
  assert.equal(store.getGroup('images').messages[0].messageVersion, 2)
  await store.close()
})


test('任务等待小目标排队、执行或排空时仍在执行中，真正业务等待单独显示', () => {
  const task = { status: 'active', control: 'active', drained: true, lastDecision: { action: 'wait', summary: '等待执行结果' } }
  for (const execution of [{ status: 'queued', drained: true }, { status: 'running', drained: false }, { status: 'succeeded', drained: false }]) {
    assert.equal(taskBoardState(task, [execution]), 'running')
  }
  assert.equal(taskBoardState(task, [{ status: 'succeeded', drained: true }]), 'waiting')
  assert.equal(taskBoardState(task, []), 'waiting')
  assert.equal(taskBoardState({ ...task, drained: false }, []), 'running')
  const active = [{ status: 'running', drained: false }]
  assert.equal(taskBoardState({ ...task, lastDecision: { action: 'wait', question: '需要选择哪个目标？' } }, active), 'waiting')
  assert.equal(taskBoardState({ ...task, lastDecision: { action: 'blocked' } }, active), 'waiting')
  assert.equal(taskBoardState({ ...task, control: 'paused' }, active), 'waiting')
  assert.equal(taskBoardState({ ...task, control: 'cancelled' }, active), 'cancelled')
  assert.equal(taskBoardState({ ...task, status: 'completed' }, active), 'completed')
})

test('ingress phase facts include failed reads, retry attempts and concurrent store waiting without resource content', async () => {
  const spans = [[], []]
  let release
  const gate = new Promise(resolve => { release = resolve })
  let queued = Promise.resolve(), failRead = true
  const store = { ingest(value) {
    const work = queued.then(async () => { if (value.messageId === 'first') await gate; return value })
    queued = work.catch(() => {})
    return work
  } }
  const run = (messageId, index) => ingestTaskResidentMessage({
    residentStore: store, ctx: { attachments: { saveImages: async () => [{ id: 'saved' }] } },
    message: { groupId: 'g', messageId, resourceRefs: [{ type: 'mediaId', resourceId: 'private-media' }] },
    readResource: async () => { if (failRead) throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); return { image: { data: new Uint8Array([1]) } } },
    onPhase: phase => spans[index].push(phase),
  })
  const first = run('first', 0)
  await new Promise(resolve => setImmediate(resolve))
  failRead = false
  const second = run('retry', 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(spans[1].some(item => item.phase === 'resident-store'), false)
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results[0].mediaUnavailable, ['private-media: OFFLINE'])
  assert.equal(results[1].imageRefs[0].id, 'saved')
  assert.deepEqual(spans.map(items => items.map(item => item.phase)), [['resource-read', 'resident-store'], ['resource-read', 'image-save', 'resident-store']])
  const waiting = spans[1].find(item => item.phase === 'resident-store')
  assert.ok(Date.parse(waiting.completedAt) - Date.parse(waiting.startedAt) >= 20)
  for (const phase of spans.flat()) {
    assert.deepEqual(Object.keys(phase).sort(), ['completedAt', 'phase', 'startedAt'])
    assert.ok(Date.parse(phase.completedAt) >= Date.parse(phase.startedAt))
  }
  assert.equal(JSON.stringify(spans).includes('private-media'), false)
  const projected = messageProcessingSources([{ sourceId: 's', groupId: 'g', stages: [{ ...waiting, spanId: 'stored', stage: 'ingress', loopDelayMs: 12.5 }] }], [], 'g')[0].stages[0]
  assert.equal(projected.phase, 'resident-store')
  assert.equal(projected.loopDelayMs, 12.5)
})
