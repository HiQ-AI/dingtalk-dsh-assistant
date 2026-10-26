import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'

function facility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'source-dispatch-test' })
}
async function fixture(t, snapshot = { tables: {}, global: null }) {
  const store = await openResidentStore(facility(snapshot))
  if (!store.getGroup('g')) await store.subscribe({ groupId: 'g' })
  t.after(() => store.close())
  return { store, snapshot }
}
const unitRef = unit => ({ unitId: unit.unitId, unitRevision: unit.unitRevision })
async function routed(store, withTopic = false) {
  await store.ingest({ groupId: 'g', messageId: 'message', text: '先A后B；讨论C', occurredAt: '2026-10-21T00:00:00Z', senderName: '甲', senderOpenDingTalkId: 'actor' })
  return store.routeMessages({ groupId: 'g', routeId: 'route', routingRevision: 0, routes: [{ messageId: 'message', messageVersion: 1,
    units: [
      { unitKey: 'arrangement', summary: '先A后B', sourceRefs: [{ quote: '先A后B；' }], dispatchOwner: 'coordination', reason: '独立安排',
        topics: withTopic ? [{ newTopicKey: 'shared', title: '讨论' }] : [] },
      { unitKey: 'discussion', summary: '讨论C', sourceRefs: [{ quote: '讨论C' }], topics: [{ newTopicKey: 'shared', title: '讨论' }] },
    ] }] })
}

test('explicit source recovery holds the message-version queue through the separate ledger CAS', async t => {
  const { store } = await fixture(t)
  await routed(store)
  const owner = store.listSourceDispatchOwnership('g')[0], message = store.getGroup('g').messages[0]
  const args = { groupId: 'g', messageId: message.messageId, messageVersion: 1, activeUnitRefs: message.activeUnitRefs, reservationId: owner.reservationId }
  let calls = 0
  for (const patch of [{ messageVersion: 2 }, { activeUnitRefs: [] }, { reservationId: 'foreign' }])
    await assert.rejects(store.retrySourceDispatch({ ...args, ...patch }, () => { calls++ }), /MESSAGE_RETRY_STALE/)
  assert.equal(calls, 0)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const retry = store.retrySourceDispatch(args, async snapshot => { entered.resolve(); await release.promise; return snapshot })
  await entered.promise
  const changed = store.ingest({ groupId: 'g', messageId: message.messageId, messageVersion: 2, text: '已订正原消息', occurredAt: message.occurredAt, senderOpenDingTalkId: 'actor' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getGroup('g').messages[0].messageVersion, 1)
  release.resolve()
  assert.equal((await retry).reservationId, owner.reservationId)
  await changed
  assert.equal(store.getGroup('g').messages[0].messageVersion, 2)
  await assert.rejects(store.retrySourceDispatch(args, () => { calls++ }), /MESSAGE_RETRY_STALE/)
  assert.equal(calls, 0)
})

for (const state of ['accepted', 'needs_clarification', 'frozen']) test(`explicit source recovery never resets ${state} ownership`, async t => {
  const { store } = await fixture(t)
  await routed(store)
  const owner = store.listSourceDispatchOwnership('g')[0], message = store.getGroup('g').messages[0]
  if (state === 'frozen') {
    await store.updateSourceDispatch({ groupId: 'g', ...unitRef(owner), expectedGeneration: 1, semanticState: 'rejected' })
    await store.beginSourceDispatchHandoff({ groupId: 'g', ...unitRef(owner), expectedGeneration: 1, freezeId: 'freeze', reason: 'fixture handoff' })
  } else await store.updateSourceDispatch({ groupId: 'g', ...unitRef(owner), expectedGeneration: 1, semanticState: state,
    ...(state === 'accepted' ? { coordinationId: 'accepted', settled: true } : { clarification: '对象不明' }) })
  const before = store.listSourceDispatchOwnership('g')
  await assert.rejects(store.retrySourceDispatch({ groupId: 'g', messageId: message.messageId, messageVersion: 1,
    activeUnitRefs: message.activeUnitRefs, reservationId: owner.reservationId }, () => assert.fail('must not reach ledger')), /MESSAGE_RETRY_STALE/)
  assert.deepEqual(store.listSourceDispatchOwnership('g'), before)
})

test('route atomically reserves coordination unit; no Topic required and discussion remains separate', async t => {
  const { store } = await fixture(t)
  await routed(store)
  const group = store.getGroup('g'), units = group.messages[0].units
  const reservation = store.listSourceDispatchOwnership('g')[0]
  assert.equal(group.topics.length, 1)
  assert.equal(group.topics[0].entries.length, 1)
  assert.equal(group.topics[0].entries[0].unitId, units[1].unitId)
  assert.equal(reservation.unitId, units[0].unitId)
  assert.equal(reservation.semanticState, 'reserved')
  assert.equal(reservation.settled, false)
  assert.equal(reservation.sourceSnapshot.text, '先A后B；讨论C')
  assert.equal(reservation.sourceSnapshot.unitText, '先A后B；')
  assert.equal(group.messages[0].agentDeliveryStatus, 'pending')
  assert.equal((await store.reserveSourceDispatch({ groupId: 'g', ...unitRef(units[0]) })).reservationId, reservation.reservationId)
  await assert.rejects(store.reserveSourceDispatch({ groupId: 'g', ...unitRef(units[0]), expectedGeneration: 2 }), /generation_stale/)
  await assert.rejects(store.reserveSourceDispatch({ groupId: 'g', unitId: 'unknown', unitRevision: 1 }), /unit_not_found/)
})

test('needs clarification survives restart and Topic completion cannot settle it', async t => {
  const { store, snapshot } = await fixture(t)
  await routed(store)
  const reservation = store.listSourceDispatchOwnership('g')[0]
  await store.updateSourceDispatch({ groupId: 'g', ...unitRef(reservation), expectedGeneration: 1, semanticState: 'needs_clarification', clarification: '哪个A？' })
  const topic = store.getGroup('g').topics[0], discussion = store.getGroup('g').messages[0].units[1]
  const args = { groupId: 'g', topicId: topic.topicId, revision: topic.revision, decisionId: 'discussion',
    decision: { actions: [], reason: '讨论', basisMessageIds: ['message'], basisUnitRefs: [unitRef(discussion)] } }
  await store.acceptTopicDecision(args)
  await store.completeTopicDecision({ groupId: 'g', topicId: topic.topicId, decisionId: 'discussion' })
  assert.equal(store.getGroup('g').messages[0].agentDeliveryStatus, 'pending')
  await store.close()
  const reopened = await openResidentStore(facility(snapshot)); t.after(() => reopened.close())
  assert.equal(reopened.listSourceDispatchOwnership('g')[0].semanticState, 'needs_clarification')
  assert.equal(reopened.listSourceDispatchOwnership('g')[0].settled, false)
  await assert.rejects(reopened.updateSourceDispatch({ groupId: 'g', ...unitRef(reservation), expectedGeneration: 1, semanticState: 'needs_clarification', clarification: '哪个A？', settled: true }), /state_invalid/)
  await reopened.updateSourceDispatch({ groupId: 'g', ...unitRef(reservation), expectedGeneration: 1, semanticState: 'accepted', coordinationId: 'c', settled: true })
  assert.equal(reopened.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})

test('coordination ownership suppresses new Topic decisions and acknowledgement outbox', async t => {
  const { store } = await fixture(t)
  await routed(store, true)
  const group = store.getGroup('g'), topic = group.topics[0], reservation = store.listSourceDispatchOwnership('g')[0]
  await assert.rejects(store.acceptTopicDecision({ groupId: 'g', topicId: topic.topicId, revision: topic.revision, decisionId: 'old-chain',
    decision: { actions: [], reply: '已承接', basisMessageIds: ['message'], basisUnitRefs: [unitRef(reservation)] } }), /owned_by_coordination/)
  const result = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'topic-decision:old-chain', outboundId: 'ack', decisionId: 'old-chain', text: '已承接', matterUnitRefs: [unitRef(reservation)] })
  assert.equal(result.status, 'coordination-owned')
  assert.equal(store.getGroup('g').outbox.length, 0)
  const errors = []
  const coordinator = createTopicCoordinator({ store, getAgent: () => ({ steer() {}, whenIdle: () => new Promise(() => {}) }), assertSession() {}, serializeTasks: fn => fn(),
    reviewCandidates: () => [],
    applyAction: () => assert.fail('coordination unit must not reach legacy apply'), appendOutbox: args => store.appendOutbox(args),
    cancelTask() {}, onError(_groupId, error) { errors.push(error) }, isClosing: () => false })
  t.after(() => coordinator.close())
  const requests = await coordinator.schedule('g')
  assert.deepEqual(errors, [])
  assert.equal(requests[0].ownedDeltaUnitRefs.some(ref => ref.unitId === reservation.unitId), false)
})

test('accepted legacy decision cannot be claimed by coordination and retains original operation identity', async t => {
  const { store } = await fixture(t)
  await store.ingest({ groupId: 'g', messageId: 'm', text: 'legacy', occurredAt: '2026-10-21T00:00:00Z', senderName: '甲', senderOpenDingTalkId: 'actor' })
  await store.routeMessages({ groupId: 'g', routeId: 'legacy', routingRevision: 0, routes: [{ messageId: 'm', messageVersion: 1, topics: [{ newTopicKey: 't', title: '任务' }] }] })
  const group = store.getGroup('g'), topic = group.topics[0], unit = group.messages[0].units[0]
  await store.acceptTopicDecision({ groupId: 'g', topicId: topic.topicId, revision: topic.revision, decisionId: 'legacy-decision',
    decision: { actions: [], reason: 'legacy', basisMessageIds: ['m'], basisUnitRefs: [unitRef(unit)] } })
  await assert.rejects(store.reserveSourceDispatch({ groupId: 'g', ...unitRef(unit) }), /legacy_decision_exists/)
  assert.equal(store.getGroup('g').topics[0].decisions[0].decisionId, 'legacy-decision')
  assert.deepEqual(store.listSourceDispatchOwnership('g'), [])
})

test('rejected source remains exclusive until frozen handoff with matching durable proof and generation CAS', async t => {
  const { store } = await fixture(t)
  await routed(store)
  const reservation = store.listSourceDispatchOwnership('g')[0], ref = unitRef(reservation)
  await store.updateSourceDispatch({ groupId: 'g', ...ref, expectedGeneration: 1, semanticState: 'rejected' })
  assert.equal(store.getSourceDispatchOwnership('g', ref.unitId, ref.unitRevision).dispatchOwner, 'coordination')
  await store.beginSourceDispatchHandoff({ groupId: 'g', ...ref, expectedGeneration: 1, freezeId: 'freeze', reason: '不属于协调意图' })
  await assert.rejects(store.updateSourceDispatch({ groupId: 'g', ...ref, expectedGeneration: 1, semanticState: 'accepted', coordinationId: 'late' }), /generation_stale/)
  await assert.rejects(store.completeSourceDispatchHandoff({ groupId: 'g', ...ref, expectedGeneration: 1, proof: 'no commands' }), /proof_invalid/)
  const proof = { kind: 'coordination.no-commands', reservationId: reservation.reservationId, generation: 1, ...ref,
    freezeId: 'freeze', dynamicSourceId: 'dynamic-source', commandCount: 0, unknownCount: 0, checkedAt: '2026-10-21T00:00:00Z' }
  const handedBack = await store.completeSourceDispatchHandoff({ groupId: 'g', ...ref, expectedGeneration: 1, proof })
  assert.equal(handedBack.dispatchOwner, 'legacy-topic'); assert.equal(handedBack.generation, 2)
  assert.equal(handedBack.history.length, 1)
  await assert.rejects(store.updateSourceDispatch({ groupId: 'g', ...ref, expectedGeneration: 1, semanticState: 'accepted' }), /generation_stale/)
})
