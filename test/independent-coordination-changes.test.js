import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openIndependentCoordination } from '../packages/dingtalk-dsh-assistant/independent-coordination-service.js'
import { assertCoordinationHandoffProof } from '../packages/dingtalk-dsh-assistant/coordination-changes.js'

function facility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'isolated-coordination-changes' })
}
async function fixture(t, { loseAckAt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-changes-')), snapshot = { tables: {}, global: null }
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'changes', initialize: true }
  let store = await openDynamicTaskStore(options), resident = await openResidentStore(facility(snapshot)), service, lost = false
  const errors = [], handoffs = [], applied = []
  await resident.subscribe({ groupId: 'group' })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const command = async (kind, args, id = randomUUID()) => {
    const receipt = await store.command({ kind, args, id })
    if (!lost && kind === loseAckAt) { lost = true; throw Object.assign(new Error('lost commit acknowledgement'), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN' }) }
    return receipt
  }
  const residentAdapter = new Proxy({}, { get(_target, key) {
    if (key === 'completeSourceDispatchHandoff') return async args => {
      const result = await resident.completeSourceDispatchHandoff(args)
      if (!lost && loseAckAt === 'resident.complete') { lost = true; throw new Error('resident acknowledgement lost') }
      return result
    }
    return resident[key]
  } })
  const open = () => service = openIndependentCoordination({ config: {}, residentStore: residentAdapter, query, command,
    ownerActorId: 'author', planner: { plan: () => assert.fail('Recovery must not ask a model to reinterpret accepted or rejected work'), close() {} },
    onApplied: async member => applied.push(member.id), onError: (id, error) => errors.push({ id, code: error.code ?? error.message }),
    onHandoff: groupId => handoffs.push(groupId) })
  open()
  t.after(async () => { await service.close(); await resident.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  for (const taskId of ['B','A']) await command('task.create', { taskId, groupId: 'group', ownerActorId: 'author', request: `original ${taskId}` })
  const message = async (id, text) => {
    await command('source.record', { sourceId: `source:${id}`, groupId: 'group', messageId: id, version: 1, actorId: 'author', text, timestamp: new Date().toISOString() })
    await resident.ingest({ groupId: 'group', messageId: id, text, occurredAt: new Date().toISOString(), senderName: 'Author', senderOpenDingTalkId: 'author' })
    await resident.routeMessages({ groupId: 'group', routeId: `route:${id}`, routingRevision: resident.getGroup('group').routingRevision,
      routes: [{ messageId: id, messageVersion: 1, units: [{ unitKey: 'request', summary: text, sourceRefs: [{ quote: text }],
        dispatchOwner: 'coordination', topics: [], reason: 'independent request' }] }] })
    return { ...resident.listSourceDispatchOwnership('group').find(entry => entry.sourceSnapshot.messageId === id), groupId: 'group' }
  }
  const arrangement = () => ({ kind: 'arrangement', commonContext: '', members: ['A','B'].map(taskId => ({ taskId,
    action: 'task-context', inputVersion: 1, runSequence: 1, progressImpact: 'preserve', impactReason: 'material only',
    context: `${taskId} material`, afterTaskIds: taskId === 'B' ? ['A'] : [] })) })
  return { command, query, message, arrangement, errors, handoffs, applied,
    get service() { return service }, get resident() { return resident },
    async runJobs() {
      for (const job of await query('coordination.job.list')) if (job.state === 'waiting') {
        const claimed = (await command('coordination.job.claim', { jobId: job.id })).result.job
        await command('coordination.job.command', { jobId: claimed.id, fence: claimed.fence })
      }
    },
    async restart() { await service.close(); await resident.close(); await store.close(); store = await openDynamicTaskStore(options); resident = await openResidentStore(facility(snapshot)); open() } }
}

for (const loseAckAt of [undefined, 'coordination.source.freezeHandoff', 'resident.complete', 'coordination.source.completeHandoff']) {
  test(`rejected source handoff reconciles frozen identity across ${loseAckAt ?? 'normal'} boundary`, async t => {
    const f = await fixture(t, { loseAckAt }), request = await f.message('wrong-route', '普通单项讨论，不是协调安排')
    const before = await f.query('task.list')
    if (loseAckAt) await assert.rejects(f.service.submit(request, { kind: 'reject', reason: '仅普通单项讨论' }))
    else assert.equal((await f.service.submit(request, { kind: 'reject', reason: '仅普通单项讨论' })).status, 'handed_back')
    await f.restart(); await f.service.recoverGroup('group')
    const resident = f.resident.getSourceDispatchOwnership('group', request.unitId, request.unitRevision)
    const ledger = await f.query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
    assert.equal(resident.dispatchOwner, 'legacy-topic'); assert.equal(resident.generation, 2)
    assert.equal(ledger.dispatchOwner, 'legacy-topic'); assert.equal(ledger.fence, 2)
    assert.equal(f.resident.getGroup('group').messages.find(message => message.messageId === 'wrong-route').routingStatus, 'pending')
    assert.deepEqual(await f.query('coordination.list'), [])
    assert.deepEqual(await f.query('task.list'), before)
    assert.deepEqual(await f.query('notification.list'), [])
    await assert.rejects(f.service.submit(request, { kind: 'reject', reason: 'stale worker' }), { code: 'COORDINATION_SOURCE_FENCED' })
    await f.service.recoverGroup('group')
    assert.equal((await f.query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })).fence, 2)
  })
}

test('unknown effect evidence cannot satisfy the explicit handoff proof', () => {
  const reservation = { reservationId: 'r', generation: 1, unitId: 'u', unitRevision: 1 }
  const source = { id: 's', state: 'rejected', dispatchOwner: 'coordination', frozen: true, reservationGeneration: 1,
    handoffProof: { kind: 'coordination.no-commands', dynamicSourceId: 's', reservationId: 'r', generation: 1, unitId: 'u', unitRevision: 1,
      freezeId: 'freeze', commandCount: 0, unknownCount: 1, checkedAt: new Date().toISOString() } }
  assert.throws(() => assertCoordinationHandoffProof(reservation, source, 'freeze'), { code: 'COORDINATION_HANDOFF_UNSAFE' })
})

test('follow-up ordinal resolves the original member order and pauses only that arrangement member', async t => {
  const f = await fixture(t), original = await f.message('original', '先A后B')
  await f.service.context(original, { taskIds: ['A','B'] })
  const accepted = await f.service.submit(original, f.arrangement())
  await f.service.recoverGroup('group')
  await f.runJobs(); await f.service.recoverGroup('group')
  const before = await f.query('coordination.get', { coordinationId: accepted.coordinationId })
  assert.equal(before.members[0].state, 'applied'); assert.equal(before.members[1].state, 'ready')
  const reply = await f.message('pause', '第二个先别动')
  await assert.rejects(f.service.submit(reply, { kind: 'change', coordinationId: accepted.coordinationId, expectedRevision: 1,
    change: { action: 'pause', selectors: [{ ordinal: 2 }], reason: '第二个先别动' } }), { code: 'COORDINATION_ARRANGEMENT_CONTEXT_REQUIRED' })
  const context = await f.service.context(reply, { coordinationIds: [accepted.coordinationId] })
  assert.deepEqual(context.arrangementContexts[0].members.map(member => [member.ordinal, member.taskId]), [[1,'A'],[2,'B']])
  await f.service.submit(reply, { kind: 'change', coordinationId: accepted.coordinationId, expectedRevision: 1,
    change: { action: 'pause', selectors: [{ ordinal: 2 }], reason: '第二个先别动' } })
  const paused = await f.query('coordination.get', { coordinationId: accepted.coordinationId })
  assert.equal(paused.coordination.revision, 2); assert.equal(paused.members[0].control ?? 'active', 'active')
  assert.equal(paused.members[1].control, 'paused')
  assert.equal((await f.query('task.get', { taskId: 'B' })).control, 'active')
  assert.equal(paused.coordination.history[0].original, '第二个先别动')
  await f.restart(); await f.service.recoverGroup('group')
  const notifications = (await f.query('notification.list')).filter(notification => notification.payload.fact.noticeKind === 'control')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].payload.fact.sourceUnitId, reply.unitId)
})

test('a genuine clarification reply resolves the same coordination identity and settles both source units', async t => {
  const f = await fixture(t), original = await f.message('ambiguous', '先处理那个任务')
  const clarification = await f.service.submit(original, { kind: 'clarify', question: '哪个已有任务？', candidates: ['A','B'] })
  const reply = await f.message('answer', '明确是任务A，只加材料')
  await f.service.context(reply, { taskIds: ['A'], coordinationIds: [clarification.coordinationId] })
  const resolution = f.arrangement(); resolution.members = resolution.members.slice(0,1)
  await f.service.submit(reply, { kind: 'resolve', coordinationId: clarification.coordinationId, expectedRevision: 1, resolution })
  const arrangements = await f.query('coordination.list')
  assert.equal(arrangements.length, 1); assert.equal(arrangements[0].id, clarification.coordinationId); assert.equal(arrangements[0].revision, 2)
  await f.restart(); await f.service.recoverGroup('group')
  const originalState = f.resident.getSourceDispatchOwnership('group', original.unitId, original.unitRevision)
  assert.equal(originalState.semanticState, 'accepted'); assert.equal(originalState.settled, true)
  assert.equal(f.resident.getSourceDispatchOwnership('group', reply.unitId, reply.unitRevision).coordinationId, clarification.coordinationId)
  assert.equal((await f.query('task.get', { taskId: 'B' })).contextRevision ?? 0, 0)
})

test('persisted frozen mode blocks new semantic submit and accepted member dispatch while reconciliation remains readable', async t => {
  const f = await fixture(t), request = await f.message('freeze', '先A后B')
  await f.service.context(request, { taskIds: ['A','B'] })
  const accepted = await f.service.submit(request, f.arrangement())
  await f.command('coordination.runtime.set', { mode: 'frozen', reason: 'compatible rollback' })
  await f.restart(); await f.service.recoverGroup('group')
  assert.deepEqual(f.applied, [])
  assert.deepEqual((await f.query('coordination.get', { coordinationId: accepted.coordinationId })).members.map(member => member.state), ['ready','ready'])
  const next = await f.message('frozen-new', '继续A')
  await assert.rejects(f.service.submit(next, { kind: 'reject', reason: 'not admitted while frozen' }), { code: 'COORDINATION_RUNTIME_FROZEN' })
})
