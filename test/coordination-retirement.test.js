import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { retiredSourceOwnership, COORDINATION_RETIRED_REASON } from '../packages/dingtalk-dsh-assistant/coordination-retirement.js'
import { messageProcessingProjection } from '../packages/dingtalk-dsh-assistant/observer-message-projection.js'
import { createObserverGroupPages } from '../packages/dingtalk-dsh-assistant/observer-group-pages.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { resolveTaskArtifactScope } from '../packages/dingtalk-dsh-assistant/task-artifact-scope.js'

test('upgrade retires only independent coordination; old questions/receipts survive and linked Task Owner still executes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coordination-retirement-'))
  const options = { dbPath: join(root, 'ledger.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(options), seq = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args) => store.command({ id: `c${++seq}`, kind, args })
  await command('task.create', { taskId: 'business', groupId: 'g', request: 'Continue the actual business task' })
  const taskBefore = await store.query({ kind: 'task.get', taskId: 'business' })
  await store.close()
  const db = new DatabaseSync(options.dbPath)
  const put = (table, id, value) => db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(id, JSON.stringify({ id, ...value }))
  db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
  put('sources', 'source', { sourceId: 'source', groupId: 'g', messageId: 'm', version: 1, routed: false })
  put('coordination_sources', 'owner', { dispatchOwner: 'coordination', unitId: 'u', revision: 1, state: 'needs_clarification', clarification: 'Old question', groupId: 'g', sourceMessageId: 'm', sourceRefs: ['source'], coordinationId: 'arrangement' })
  put('coordination', 'arrangement', { state: 'active', groupId: 'g', revision: 1, clarification: 'Old question', memberIds: ['member'] })
  put('coordination_members', 'member', { taskId: 'business', coordinationId: 'arrangement', state: 'applied', instruction: 'Original business instruction' })
  put('coordination_schedules', 'schedule', { state: 'active', coordinationId: 'arrangement', rule: { kind: 'once' } })
  put('coordination_jobs', 'job', { state: 'pending', occurrenceId: 'occurrence' })
  for (const state of ['prepared', 'starting', 'unknown', 'delivered']) put('notifications', state, { kind: 'coordination', state,
    ...(state === 'delivered' ? { receipt: { messageId: 'sent-message' } } : {}), payload: { text: 'Old question', conversationId: 'g', fact: { coordinationId: 'arrangement', eventId: state } } })
  put('notifications', 'prepared-claimed', { kind: 'coordination', state: 'prepared', sendAttemptCount: 1, payload: { text: 'Uncertain', conversationId: 'g', fact: { coordinationId: 'arrangement', eventId: 'claimed' } } })
  put('wakes', 'old-coordination', { taskId: 'business', kind: 'coordination.changed', state: 'pending' })
  const untouchedNotices = ['starting','unknown','delivered','prepared-claimed'].map(id => JSON.parse(db.prepare('SELECT body FROM dynamic_notifications WHERE id=?').get(id).body))
  db.close()
  store = await openDynamicTaskStore({ ...options, initialize: false })
  const retirement = await store.query({ kind: 'coordination.retirement' })
  assert.equal(retirement.reason, COORDINATION_RETIRED_REASON)
  const oldSource = (await store.query({ kind: 'coordination.source.list', groupId: 'g' }))[0]
  assert.equal(oldSource.state, 'needs_clarification'); assert.equal(oldSource.clarification, 'Old question')
  assert.equal(oldSource.retirement.previousState, 'needs_clarification')
  assert.deepEqual((await store.query({ kind: 'source.get', sourceId: 'source' })).coordinationRetirement.units, [{ unitId: 'u', unitRevision: 1 }])
  assert.deepEqual(await store.query({ kind: 'task.get', taskId: 'business' }), taskBefore)
  const scope = await resolveTaskArtifactScope({ root, task: taskBefore, query: (kind, args) => store.query({ kind, ...args }) })
  assert.equal(scope.coordinationId, 'arrangement'); assert.deepEqual(scope.memberTaskIds, ['business'])
  assert.equal(scope.artifactRoot, join(root, 'tasks', 'arrangement', 'outputs'))
  assert.equal((await store.query({ kind: 'notification.get', notificationId: 'prepared' })).state, 'superseded')
  // Startup's existing uncertain-send recovery may turn starting into unknown;
  // retirement itself never revokes its attempt, receipt or frozen text.
  for (const before of untouchedNotices) {
    const notice = await store.query({ kind: 'notification.get', notificationId: before.id })
    assert.equal(notice.retirement, undefined); assert.deepEqual(notice.payload, before.payload)
    assert.deepEqual(notice.receipt, before.receipt)
    assert.equal(notice.state, before.state === 'starting' ? 'unknown' : before.state)
  }
  assert.equal((await store.query({ kind: 'wake.list', taskId: 'business' })).find(w => w.id === 'old-coordination').state, 'acked')
  for (const kind of ['coordination.accept','coordination.schedule.scan','coordination.job.claim','task.coordination.input'])
    await assert.rejects(command(kind, {}), { code: 'INDEPENDENT_COORDINATION_RETIRED' })
  await assert.rejects(command('notification.prepare', { kind: 'coordination' }), { code: 'INDEPENDENT_COORDINATION_RETIRED' })
  const owner = (await command('task.claim', { taskId: 'business' })).result
  const execution = (await command('execution.dispatch', { binding: owner.binding, key: 'business', prompt: 'Inspect the business result' })).result.execution
  const bound = (await command('execution.claim', { executionId: execution.executionId })).result.binding
  await command('execution.result', { binding: bound, output: {} })
  await command('execution.drained', { binding: bound })
  await command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await command('task.complete', { binding: owner.binding, summary: 'Business outcome', result: { summary: 'Business outcome', evidence: [], limitations: [] } })
  const completed = await store.query({ kind: 'task.get', taskId: 'business' })
  assert.equal(completed.status, 'completed')
  await store.close(); store = await openDynamicTaskStore({ ...options, initialize: false })
  assert.deepEqual(await store.query({ kind: 'coordination.retirement' }), retirement)
  assert.deepEqual((await store.query({ kind: 'coordination.source.list', groupId: 'g' }))[0], oldSource)
  assert.deepEqual(await resolveTaskArtifactScope({ root, task: completed, query: (kind, args) => store.query({ kind, ...args }) }), scope)
})

test('resident retirement settles exact old ownership idempotently; list/detail agree and other pending Topic stays pending', async t => {
  const snapshot = { tables: {}, global: null }
  const facility = () => new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { open: async () => ({
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    putRecord: async (table,key,value) => { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    deleteRecord: async (table,key) => { delete snapshot.tables[table][key] },
  }) } }) } } }, { backend: 'retirement-test' })
  let store = await openResidentStore(facility())
  await store.subscribe({ groupId: 'g', responsibility: 'Business' }); await store.close()
  const at = '2026-10-29T00:01:00Z', retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at }
  const unit = { unitId: 'u', unitRevision: 1, unitKey: 'u', dispatchOwner: 'coordination', summary: 'Old clarification', sourceRanges: [{ start: 0, end: 3, quote: 'Old' }] }
  const message = { messageId: 'm', messageVersion: 1, sequence: 1, text: 'Old question', occurredAt: '2026-10-29T00:00:00Z', routingStatus: 'routed', agentDeliveryStatus: 'pending', activeUnitRefs: [{ unitId: 'u', unitRevision: 1 }], units: [unit] }
  const group = snapshot.tables.groups.g
  group.routingRevision = 1
  group.messages = [message]
  group.sourceDispatchOwnership = [{ reservationId: 'r', unitId: 'u', unitRevision: 1, generation: 1, dispatchOwner: 'coordination', semanticState: 'needs_clarification', settled: false, clarification: 'Old question', sourceSnapshot: { messageId: 'm', messageVersion: 1 }, history: [], createdAt: at, updatedAt: at }]
  store = await openResidentStore(facility()); t.after(() => store.close())
  await store.retireIndependentCoordination(retirement)
  const once = structuredClone(store.getGroup('g'))
  await store.retireIndependentCoordination(retirement)
  assert.deepEqual(store.getGroup('g'), once)
  assert.equal(once.sourceDispatchOwnership[0].settled, true)
  assert.equal(once.sourceDispatchOwnership[0].semanticState, 'needs_clarification')
  assert.equal(once.sourceDispatchOwnership[0].clarification, 'Old question')
  assert.equal(once.messages[0].agentDeliveryStatus, 'delivered')
  const source = retiredSourceOwnership([], once.sourceDispatchOwnership, 'g')[0]
  const detail = messageProcessingProjection(once.messages[0], [], source, [])
  assert.equal(detail.processingState, 'processed'); assert.equal(detail.processingConclusion, COORDINATION_RETIRED_REASON)
  const page = createObserverGroupPages({ readGroup: () => once, readVersion: () => 1, readMetadata: () => ({ sources: [] }), readSources: () => [], readRequests: () => [], isOwnNotification: () => false })
  t.after(() => page.close())
  page.update({ group: once })
  assert.equal((await page('g', { filter: 'needs_clarification' })).total, 0)
  assert.equal((await page('g', { filter: 'processed' })).items[0].processingConclusion, detail.processingConclusion)
  const businessRef = { unitId: 'business-unit', unitRevision: 1 }
  const mixed = { ...message, activeUnitRefs: [...message.activeUnitRefs, businessRef], units: [...message.units, { ...businessRef }] }
  const topic = { topicId: 'business-topic', revision: 1, processedRevision: 0, entries: [{ ...businessRef, messageId: 'm', messageVersion: 1, revision: 1, action: 'add' }], decisions: [] }
  assert.equal(messageProcessingProjection(mixed, [topic], source, []).processingState, 'processing')
  assert.equal(messageProcessingProjection({ ...message, messageVersion: 2, activeUnitRefs: [{ unitId: 'u', unitRevision: 2 }] }, [], source, []).processingState, 'processing')
  await assert.rejects(store.reserveSourceDispatch({}), /INDEPENDENT_COORDINATION_RETIRED/)

  // A crash may persist Resident ownership before its coordination reservation.
  // Recovery must settle the durable source fence too, without a model or send.
  const root = await mkdtemp(join(tmpdir(), 'retired-orphan-'))
  const noop = async () => {}, forbidden = async () => assert.fail('retirement must not run a model, task or notification')
  const service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } }, residentStore: store,
    legacy: { getGroup: id => store.getGroup(id), getAgentConfig: () => ({ workspaceDir: root }) },
    config: { dbPath: join(root, 'ledger.sqlite'), workspaceDir: root, instanceId: 'retired-orphan', initialize: true },
    persistence: { register: noop, close: noop }, groupSessions: { run: forbidden, close: noop },
    taskSessions: { run: forbidden, close: noop, cancel: noop }, executionSessions: { run: forbidden, close: noop, cancel: noop },
    notifications: { send: forbidden, readback: forbidden } })
  try {
    await service.store.command({ id: 'record-orphan', kind: 'source.record', args: { sourceId: 'orphan', groupId: 'g', messageId: 'm', version: 1, actorId: 'example', text: 'Old question' } })
    await service.store.command({ id: 'pending-orphan', kind: 'source.processingStarted', args: { sourceId: 'orphan', messageVersion: 1, activeUnitRefs: message.activeUnitRefs } })
    assert.equal((await service.store.query({ kind: 'coordination.source.list' })).length, 0)
    await service.recover(); await service.whenIdle()
    const settled = await service.store.query({ kind: 'source.get', sourceId: 'orphan' })
    assert.equal(settled.processingPending, false); assert.equal(settled.routed, true)
    assert.deepEqual(settled.coordinationRetirement.units, message.activeUnitRefs)
    await service.recover(); await service.whenIdle()
    assert.deepEqual((await service.store.query({ kind: 'source.get', sourceId: 'orphan' })).processingCompleted, settled.processingCompleted)
    assert.deepEqual(await service.store.query({ kind: 'task.list' }), [])
    assert.deepEqual(await service.store.query({ kind: 'notification.list' }), [])
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
