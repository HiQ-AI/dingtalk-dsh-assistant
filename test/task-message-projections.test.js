import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestTaskResidentMessage, taskNotificationOutbound, projectTaskNotification, stableTaskResourceIdentity, mergeTaskResources, taskBoardState } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'

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
