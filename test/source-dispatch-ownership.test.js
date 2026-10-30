import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { COORDINATION_RETIRED_REASON, retiredSourceOwnership } from '../packages/dingtalk-dsh-assistant/coordination-retirement.js'
import { messageProcessingProjection } from '../packages/dingtalk-dsh-assistant/observer-message-projection.js'

function facility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'source-dispatch-test' })
}
const ref = unit => ({ unitId: unit.unitId, unitRevision: unit.unitRevision })
const retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at: '2026-10-29T00:00:00Z' }
async function fixture(t) {
  const snapshot = { tables: {}, global: null }
  let store = await openResidentStore(facility(snapshot))
  await store.subscribe({ groupId: 'g' })
  await store.close(); store = await openResidentStore(facility(snapshot))
  t.after(() => store.close())
  return { get store() { return store }, snapshot, async reopen(change = () => {}) {
    await store.close(); change(snapshot.tables.groups.g); store = await openResidentStore(facility(snapshot)); return store
  } }
}
async function routed(store) {
  await store.ingest({ groupId: 'g', messageId: 'message', text: 'First A then B; discuss C', occurredAt: '2026-10-21T00:00:00Z', senderOpenDingTalkId: 'actor' })
  await store.routeMessages({ groupId: 'g', routeId: 'route', routingRevision: 0, routes: [{ messageId: 'message', messageVersion: 1, replyTopic: { newTopicKey: 'delivery' },
    units: [
      { unitKey: 'delivery', summary: 'A then B in one delivery', sourceRefs: [{ quote: 'First A then B;' }], topics: [{ newTopicKey: 'delivery', title: 'Delivery' }] },
      { unitKey: 'discussion', summary: 'Discuss C', sourceRefs: [{ quote: 'discuss C' }], topics: [{ newTopicKey: 'discussion', title: 'Discussion' }] },
    ] }] })
  return store.getGroup('g')
}
async function historical(t, state = 'needs_clarification', extra = {}) {
  const f = await fixture(t), group = await routed(f.store), unit = group.messages[0].units[0]
  const owner = { reservationId: 'reservation', ...ref(unit), generation: 1, dispatchOwner: 'coordination', semanticState: state,
    settled: false, sourceSnapshot: { groupId: 'g', messageId: 'message', messageVersion: 1, text: group.messages[0].text },
    coordinationId: 'old-arrangement', clarification: 'Which target?', history: [], createdAt: retirement.at, updatedAt: retirement.at, ...extra }
  // Historical fixture only: new routing and reservation APIs must not recreate it.
  await f.reopen(g => { g.sourceDispatchOwnership = [owner]; g.messages[0].units[0].dispatchOwner = 'coordination' })
  return { ...f, get store() { return f.store }, owner }
}
async function finish(store, topic, decisionId) {
  const entry = topic.entries[0]
  await store.acceptTopicDecision({ groupId: 'g', topicId: topic.topicId, revision: topic.revision, decisionId,
    decision: { actions: [], reason: 'Recorded current discussion', basisMessageIds: ['message'], basisUnitRefs: [ref(entry)] } })
  await store.completeTopicDecision({ groupId: 'g', topicId: topic.topicId, decisionId })
}

test('retired coordination routing rejects the entire batch without claiming a source or dropping discussion', async t => {
  const f = await fixture(t)
  await f.store.ingest({ groupId: 'g', messageId: 'message', text: 'A; B', occurredAt: '2026-10-21T00:00:00Z', senderOpenDingTalkId: 'actor' })
  const before = structuredClone(f.store.getGroup('g'))
  await assert.rejects(f.store.routeMessages({ groupId: 'g', routeId: 'old-route', routingRevision: 0, routes: [{ messageId: 'message', messageVersion: 1,
    units: [{ unitKey: 'a', summary: 'A', sourceRefs: [{ quote: 'A;' }], dispatchOwner: 'coordination', topics: [] },
      { unitKey: 'b', summary: 'B', sourceRefs: [{ quote: 'B' }], topics: [{ newTopicKey: 'b', title: 'B' }] }] }] }), /INDEPENDENT_COORDINATION_RETIRED/)
  assert.deepEqual(f.store.getGroup('g'), before)
  await f.reopen()
  assert.deepEqual(f.store.getGroup('g'), before)
})

test('new requirements and discussion retain independent Topic source ownership without a coordinator reservation', async t => {
  const f = await fixture(t), group = await routed(f.store)
  assert.equal(group.topics.length, 2)
  for (const unit of group.messages[0].units) {
    assert.equal(group.topics.filter(topic => topic.entries.some(entry => entry.unitId === unit.unitId)).length, 1)
    assert.equal(f.store.getSourceDispatchOwnership('g', unit.unitId, unit.unitRevision), undefined)
  }
  assert.deepEqual(f.store.listSourceDispatchOwnership('g'), [])
  assert.equal(group.messages[0].agentDeliveryStatus, 'pending')
  await finish(f.store, group.topics[0], 'delivery-decision')
  assert.equal(f.store.getGroup('g').messages[0].agentDeliveryStatus, 'pending', 'Another Topic still needs a real decision')
  await finish(f.store, group.topics[1], 'discussion-decision')
  assert.equal(f.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})

for (const state of ['accepted', 'needs_clarification', 'reserved']) test('retirement preserves ' + state + ' audit and does not rewrite it as business acceptance', async t => {
  const f = await historical(t, state)
  await f.store.retireIndependentCoordination(retirement)
  const owner = f.store.listSourceDispatchOwnership('g')[0]
  assert.equal(owner.semanticState, state)
  assert.equal(owner.clarification, f.owner.clarification)
  assert.equal(owner.coordinationId, f.owner.coordinationId)
  assert.deepEqual(owner.sourceSnapshot, f.owner.sourceSnapshot)
  assert.equal(owner.settled, true)
  assert.equal(owner.history.length, 1)
  assert.equal(owner.history[0].previousSemanticState, state)
  assert.equal(owner.history[0].previousSettled, false)
  const once = structuredClone(f.store.getGroup('g'))
  await f.store.retireIndependentCoordination(retirement)
  await f.reopen()
  assert.deepEqual(f.store.getGroup('g'), once)
})

test('retirement settles only old ownership; another Topic keeps the original message pending until its decision', async t => {
  const f = await historical(t)
  await f.store.retireIndependentCoordination(retirement)
  assert.equal(f.store.getGroup('g').messages[0].agentDeliveryStatus, 'pending')
  const discussion = f.store.getGroup('g').topics.find(topic => topic.title === 'Discussion')
  await finish(f.store, discussion, 'discussion-current')
  const group = f.store.getGroup('g'), source = retiredSourceOwnership([], group.sourceDispatchOwnership, 'g')[0]
  assert.equal(group.messages[0].agentDeliveryStatus, 'delivered')
  const projected = messageProcessingProjection(group.messages[0], group.topics, source, [])
  assert.equal(projected.processingState, 'processed')
  assert.match(projected.processingConclusion, /协调功能已移除/)
  assert.equal(group.topics.find(topic => topic.title === 'Delivery').decisions.length, 0, 'Retirement must not invent a Topic decision')
})

test('a changed message version never inherits the retired source completion or an old decision', async t => {
  const f = await historical(t)
  await f.store.retireIndependentCoordination(retirement)
  const audit = f.store.listSourceDispatchOwnership('g')
  await f.store.ingest({ groupId: 'g', messageId: 'message', messageVersion: 2, text: 'Revised business request', occurredAt: '2026-10-21T00:01:00Z', senderOpenDingTalkId: 'actor' })
  const group = f.store.getGroup('g'), message = group.messages[0]
  assert.equal(message.messageVersion, 2)
  assert.equal(message.routingStatus, 'pending')
  assert.equal(message.agentDeliveryStatus, 'pending')
  assert.deepEqual(f.store.listSourceDispatchOwnership('g'), audit)
  const source = retiredSourceOwnership([], audit, 'g')[0]
  assert.notEqual(messageProcessingProjection(message, group.topics, source, []).processingState, 'processed')
})

test('all former recovery and handoff entry points reject without invoking a ledger callback or mutating audit', async t => {
  const f = await historical(t), before = structuredClone(f.store.getGroup('g'))
  for (const name of ['retrySourceDispatch', 'reserveSourceDispatch', 'updateSourceDispatch', 'beginSourceDispatchHandoff', 'completeSourceDispatchHandoff']) {
    await assert.rejects(f.store[name]({ groupId: 'g', ...ref(f.owner), expectedGeneration: 1, reservationId: f.owner.reservationId },
      () => assert.fail('Retired recovery must not reach another ledger')), /INDEPENDENT_COORDINATION_RETIRED/)
    assert.deepEqual(f.store.getGroup('g'), before)
  }
})

test('a current Topic decision retains its operation identity when an old coordinator tries to reclaim it', async t => {
  const f = await fixture(t), group = await routed(f.store), topic = group.topics[0], unit = group.messages[0].units[0]
  await finish(f.store, topic, 'current-decision')
  const before = structuredClone(f.store.getGroup('g'))
  await assert.rejects(f.store.reserveSourceDispatch({ groupId: 'g', ...ref(unit) }), /INDEPENDENT_COORDINATION_RETIRED/)
  assert.deepEqual(f.store.getGroup('g'), before)
  assert.equal(before.topics[0].decisions[0].decisionId, 'current-decision')
  assert.deepEqual(before.sourceDispatchOwnership, [])
})

test('frozen historical handoff keeps original proof and generation; retirement cannot authorize new commands', async t => {
  const handoff = { freezeId: 'freeze', reason: 'Original handoff', proof: { commandCount: 0, checkedAt: '2026-10-21T00:00:00Z' } }
  const f = await historical(t, 'rejected', { frozen: true, handoff, generation: 3 })
  await f.store.retireIndependentCoordination(retirement)
  const owner = f.store.listSourceDispatchOwnership('g')[0]
  assert.equal(owner.generation, 3)
  assert.equal(owner.frozen, true)
  assert.equal(owner.semanticState, 'rejected')
  assert.deepEqual(owner.handoff, handoff)
  assert.equal(owner.dispatchOwner, 'coordination')
  await assert.rejects(f.store.completeSourceDispatchHandoff({ groupId: 'g', ...ref(owner), expectedGeneration: 3, proof: handoff.proof }), /INDEPENDENT_COORDINATION_RETIRED/)
  assert.deepEqual(f.store.listSourceDispatchOwnership('g')[0], owner)
})
