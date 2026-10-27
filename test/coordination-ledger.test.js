import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { coordinationContextRecoveryIdentity } from '../packages/dingtalk-dsh-assistant/coordination-changes.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coordination-'))
  const options = { dbPath: join(dir, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ kind, args, id })
  const query = q => store.query(q)
  const task = async id => command('task.create', { taskId: id, groupId: 'group', request: id })
  const reserve = async (id = 'unit') => (await command('coordination.reserve', { unitId: id, revision: 1, groupId: 'group', original: '先 A 后 B' })).result.source
  const member = (id, dependencies = []) => ({ instructionId: id, taskId: id, progressImpact: 'preserve', dependencies,
    command: { id: `coordination-command:batch:${id}`, kind: 'task.supplement', args: { taskId: id, expectedRequirementRevision: 1, expectedControlRevision: 1,
      messageId: `input:${id}`, text: '补充材料', request: `${id}\n补充材料` } } })
  return { options, command, query, task, reserve, member,
    async reopen() { await store.close(); store = await openDynamicTaskStore(options) },
    async close() { await store.close() },
    async migrate() { store = await openDynamicTaskStore({ ...options, migrate: true }) } }
}

async function contextReconsiderationFixture(t) {
  const f = await fixture(t), refs = [{ unitId: 'quoted-unit', unitRevision: 1 }]
  await f.command('source.record', { sourceId: 'original', groupId: 'group', messageId: 'message', version: 1,
    actorId: 'author', text: '部署到UAT2', quote: { messageId: 'delivery', content: '后端 #417、前端 #389，尚未部署。' }, timestamp: '2026-10-27T04:15:53Z' })
  const source = (await f.command('coordination.reserve', { unitId: refs[0].unitId, revision: 1, groupId: 'group', original: '部署到UAT2',
    reservationId: 'reservation', reservationGeneration: 1, actorId: 'author', sourceRefs: ['original'], sourceMessageId: 'message' })).result.source
  await f.command('coordination.source.failed', { sourceId: source.id, fence: 1, code: 'old-parse-error' })
  await f.command('coordination.source.clarify', { sourceId: source.id, fence: 1, coordinationId: 'quoted-arrangement', question: '要部署哪项改动？' })
  await f.command('source.processingStarted', { sourceId: 'original', messageVersion: 1, activeUnitRefs: refs })
  await f.command('source.processingCompleted', { sourceId: 'original', messageVersion: 1, routingRevision: 1,
    activeUnitRefs: refs, units: [{ ...refs[0], dispatchOwner: 'coordination' }] })
  const current = await f.query({ kind: 'coordination.source', unitId: refs[0].unitId, revision: 1 })
  const arrangement = (await f.query({ kind: 'coordination.get', coordinationId: 'quoted-arrangement' })).coordination
  const original = (await f.query({ kind: 'source.list', groupId: 'group' }))[0]
  const token = createHash('sha256').update(JSON.stringify(coordinationContextRecoveryIdentity(current, arrangement, original))).digest('hex')
  const args = { sourceId: current.id, fence: 1, token, coordinationId: arrangement.id, expectedRevision: 1, messageSourceId: 'original',
    messageVersion: 1, reservationId: 'reservation', generation: 1, activeUnitRefs: refs, quotedSnapshotMissing: true }
  return { ...f, refs, current, arrangement, original, args }
}

test('缺引用旧澄清显式重判保留同来源、原安排、预算和旧语义戳审计，旧CAS不可重用', async t => {
  const f = await contextReconsiderationFixture(t)
  const oldQuestionId = `coordination:${f.arrangement.id}:clarification:reservation`
  await f.command('notification.prepare', { notificationId: oldQuestionId, kind: 'coordination', requirementRevision: 1,
    payload: { conversationId: 'group', sourceMessageId: 'message', sourceId: 'original', sourceVersion: 1, actorId: 'author',
      text: '要部署哪项改动？', fact: { coordinationId: f.arrangement.id, eventId: 'clarification:reservation' } } })
  const notification = (await f.command('notification.start', { notificationId: oldQuestionId })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: notification.dispatchToken,
    state: 'delivered', evidenceRef: 'readback:old-question', receipt: { messageId: 'already-sent' } })
  const beforeNotices = await f.query({ kind: 'notification.list' })
  const result = (await f.command('coordination.source.reconsiderContext', f.args)).result.source
  assert.equal(result.id, f.current.id); assert.equal(result.fence, 2); assert.equal(result.reservationGeneration, 1)
  assert.equal(result.state, 'reserved'); assert.equal(result.attemptCount, 1); assert.equal(result.nextRetryAt, f.current.nextRetryAt)
  assert.equal(result.contextReconsideration.coordinationId, f.arrangement.id)
  assert.equal(result.contextReconsideration.expectedRevision, 1); assert.equal(result.contextReconsideration.question, '要部署哪项改动？')
  const original = (await f.query({ kind: 'source.list', groupId: 'group' }))[0]
  assert.equal(original.sourceId, 'original'); assert.equal(original.processingCompleted, undefined); assert.equal(original.processingPending, true)
  assert.deepEqual(original.processingHistory, [f.original.processingCompleted]); assert.deepEqual(original.quote, f.original.quote)
  assert.deepEqual(await f.query({ kind: 'notification.list' }), beforeNotices)
  await assert.rejects(f.command('coordination.source.reconsiderContext', f.args), /SOURCE_STALE/)
  await f.reopen()
  assert.equal((await f.query({ kind: 'coordination.source', unitId: f.refs[0].unitId, revision: 1 })).contextReconsideration.question, '要部署哪项改动？')
  assert.equal((await f.query({ kind: 'coordination.list' })).length, 1)
  assert.equal((await f.query({ kind: 'coordination.get', coordinationId: f.arrangement.id })).coordination.history[0].question, '要部署哪项改动？')
})

for (const patch of [{ fence: 2 }, { token: 'bad' }, { expectedRevision: 2 }, { generation: 2 }, { messageVersion: 2 },
  { reservationId: 'other' }, { activeUnitRefs: [] }, { quotedSnapshotMissing: false }])
test(`引用重判拒绝不匹配CAS且零写 ${JSON.stringify(patch)}`, async t => {
  const f = await contextReconsiderationFixture(t)
  await assert.rejects(f.command('coordination.source.reconsiderContext', { ...f.args, ...patch }), /STALE/)
  assert.deepEqual(await f.query({ kind: 'coordination.source', unitId: f.refs[0].unitId, revision: 1 }), f.current)
  assert.deepEqual((await f.query({ kind: 'source.list', groupId: 'group' }))[0], f.original)
})

test('引用重判仍需原澄清时保留旧问题及重判审计，重启不丢history', async t => {
  const f = await contextReconsiderationFixture(t)
  const source = (await f.command('coordination.source.reconsiderContext', f.args)).result.source
  await f.command('coordination.source.clarify', { sourceId: source.id, fence: source.fence,
    coordinationId: f.arrangement.id, question: source.question })
  await f.reopen()
  const current = (await f.query({ kind: 'coordination.get', coordinationId: f.arrangement.id })).coordination
  assert.equal(current.revision, 1); assert.equal(current.sourceFence, 2); assert.equal(current.question, source.question)
  assert.equal(current.history[0].kind, 'context-reconsideration'); assert.equal(current.history[0].question, '要部署哪项改动？')
  assert.equal((await f.query({ kind: 'source.list', groupId: 'group' }))[0].processingHistory.length, 1)
})

for (const state of ['prepared', 'starting', 'unknown', 'acknowledged'])
test(`引用重判精确处理旧澄清通知${state}，未知发送禁止重判`, async t => {
  const f = await contextReconsiderationFixture(t), notificationId = `coordination:${f.arrangement.id}:clarification:reservation`
  const payload = { conversationId: 'group', sourceMessageId: 'message', sourceId: 'original', sourceVersion: 1, actorId: 'author',
    text: '要部署哪项改动？', fact: { coordinationId: f.arrangement.id, eventId: 'clarification:reservation', sourceUnitId: f.refs[0].unitId, sourceUnitRevision: 1 } }
  await f.command('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1, payload })
  if (state !== 'prepared') {
    const started = (await f.command('notification.start', { notificationId })).result.notification
    if (state === 'unknown') await f.command('notification.receipt', { notificationId, dispatchToken: started.dispatchToken, state: 'unknown' })
    if (state === 'acknowledged') await f.command('notification.ack', { notificationId, dispatchToken: started.dispatchToken, ack: { messageId: 'send-ack' } })
  }
  const before = await f.query({ kind: 'notification.get', notificationId })
  if (state !== 'prepared') {
    await assert.rejects(f.command('coordination.source.reconsiderContext', f.args), /CONTEXT_RECONSIDERATION_UNSAFE/)
    assert.deepEqual(await f.query({ kind: 'coordination.source', unitId: f.refs[0].unitId, revision: 1 }), f.current)
    assert.deepEqual(await f.query({ kind: 'notification.get', notificationId }), before)
  } else {
    const reconsidered = (await f.command('coordination.source.reconsiderContext', f.args)).result
    assert.equal(reconsidered.notification.state, 'superseded'); assert.equal(reconsidered.notification.reason, 'stale_question')
    assert.deepEqual(reconsidered.notification.payload, payload)
    assert.equal((await f.command('notification.start', { notificationId })).dispatchEligible, false)
    await f.command('coordination.accept', { sourceId: f.current.id, fence: 2, coordinationId: f.arrangement.id,
      replaceClarificationRevision: 1, members: [], readOnly: true, proposal: { kind: 'query', answerText: '已接纳安排' } })
    const acceptedId = `coordination:${f.arrangement.id}:accepted:reservation`
    await f.command('notification.prepare', { notificationId: acceptedId, kind: 'coordination', requirementRevision: 1,
      payload: { ...payload, text: '已接纳安排', fact: { ...payload.fact, eventId: 'accepted:reservation' } } })
    assert.equal((await f.command('notification.start', { notificationId: acceptedId })).dispatchEligible, true, '新接纳通知不能因同来源修复被退休')
    assert.equal((await f.query({ kind: 'notification.get', notificationId })).state, 'superseded')
  }
})

test('引用重判遵守运行冻结且不为旧来源读取新版本引用', async t => {
  const f = await contextReconsiderationFixture(t)
  await f.command('coordination.runtime.set', { mode: 'frozen', reason: '测试冻结' })
  await assert.rejects(f.command('coordination.source.reconsiderContext', f.args), /FROZEN/)
  await f.command('coordination.runtime.set', { mode: 'active', reason: '测试恢复' })
  await f.command('source.record', { sourceId: 'v2', groupId: 'group', messageId: 'message', version: 2,
    actorId: 'author', text: '改部署到UAT3', quote: { messageId: 'other', content: '另一项改动' } })
  await assert.rejects(f.command('coordination.source.reconsiderContext', f.args), /STALE/)
})

for (const table of ['members', 'schedules', 'occurrences', 'jobs'])
test(`引用重判拒绝已有${table}效果账，不能重做业务`, async t => {
  const f = await contextReconsiderationFixture(t)
  await f.close()
  const db = new DatabaseSync(f.options.dbPath)
  db.prepare(`INSERT INTO dynamic_coordination_${table}(id,body) VALUES (?,?)`).run('effect', JSON.stringify({ id: 'effect', coordinationId: f.arrangement.id }))
  db.close(); await f.reopen()
  await assert.rejects(f.command('coordination.source.reconsiderContext', f.args), /CONTEXT_RECONSIDERATION_UNSAFE/)
  assert.deepEqual(await f.query({ kind: 'coordination.source', unitId: f.refs[0].unitId, revision: 1 }), f.current)
})

test('explicit source retry requires exact exhausted generation and never resets accepted or applied coordination', async t => {
  const f = await fixture(t)
  let source = await f.reserve('manual-source')
  const retryToken = item => createHash('sha256').update(JSON.stringify([item.id, item.fence, item.attemptCount ?? 0, item.retryEpoch ?? 0, item.nextRetryAt ?? null])).digest('hex')
  for (let i = 0; i < 3; i++) source = (await f.command('coordination.source.failed', { sourceId: source.id, fence: source.fence, code: 'network-offline' })).result.source
  const token = retryToken(source)
  const args = { sourceId: source.id, fence: source.fence, token }
  const results = await Promise.allSettled([f.command('coordination.source.retry', args), f.command('coordination.source.retry', args)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected').length, 1)
  source = (await f.query({ kind: 'coordination.source.list' }))[0]
  assert.equal(source.attemptCount, 0); assert.equal(source.retryEpoch, 1); assert.equal(source.nextRetryAt, null)
  assert.equal((await f.query({ kind: 'coordination.source.list' })).length, 1)
  await assert.rejects(f.command('coordination.source.retry', args), /STALE/)
  await assert.rejects(f.command('coordination.source.retry', { ...args, token: retryToken(source), fence: 99 }), /STALE/)
  await f.command('coordination.source.clarify', { sourceId: source.id, fence: source.fence, coordinationId: 'clarify', question: '确认权限' })
  await assert.rejects(f.command('coordination.source.retry', { ...args, token: retryToken(source) }), /STALE/)
  await f.task('A')
  const accepted = await f.reserve('accepted-manual-source')
  await f.command('coordination.accept', { sourceId: accepted.id, fence: accepted.fence, coordinationId: 'batch', members: [f.member('A')] })
  const readAccepted = async () => (await f.query({ kind: 'coordination.source.list' })).find(item => item.id === accepted.id)
  const acceptedRetry = async () => {
    const current = await readAccepted()
    await assert.rejects(f.command('coordination.source.retry', { sourceId: current.id, fence: current.fence, token: retryToken(current) }), /STALE/)
  }
  await acceptedRetry()
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  await acceptedRetry()
  assert.equal((await f.query({ kind: 'task.get', taskId: 'A' })).contextRevision, 1)
  assert.equal((await readAccepted()).retryEpoch, undefined)
})

test('runtime freeze atomically rejects an already-preflighted source retry without consuming its CAS', async t => {
  const f = await fixture(t)
  let source = await f.reserve('frozen-manual-source')
  for (let i = 0; i < 3; i++) source = (await f.command('coordination.source.failed', { sourceId: source.id, fence: source.fence, code: 'network-offline' })).result.source
  const token = createHash('sha256').update(JSON.stringify([source.id, source.fence, source.attemptCount ?? 0, source.retryEpoch ?? 0, source.nextRetryAt ?? null])).digest('hex')
  const args = { sourceId: source.id, fence: source.fence, token }, commandId = 'retry-after-freeze'
  await f.command('coordination.runtime.set', { mode: 'frozen', reason: 'freeze after successful read-only preflight' })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.command('coordination.source.retry', args, commandId), { code: 'DYNAMIC_COORDINATION_FROZEN' })
    assert.deepEqual((await f.query({ kind: 'coordination.source.list' }))[0], source)
    assert.equal(await f.query({ kind: 'receipt.get', id: commandId }), null)
    if (!i) await f.reopen()
  }
  await f.command('coordination.runtime.set', { mode: 'active', reason: 'explicitly unfreeze original source' })
  const retried = (await f.command('coordination.source.retry', args, commandId)).result.source
  assert.equal(retried.id, source.id); assert.equal(retried.fence, source.fence)
  assert.equal(retried.attemptCount, 0); assert.equal(retried.retryEpoch, 1)
})

test('source reservation and fixed member apply survive restart without replaying task mutation', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  assert.deepEqual(await f.reserve(), source)
  const args = { sourceId: source.id, fence: source.fence, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] }
  await f.command('coordination.accept', args)
  const receipt = await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  assert.equal(receipt.result.member.state, 'applied')
  await f.reopen()
  assert.equal((await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })).result.member.state, 'applied')
  assert.equal((await f.query({ kind: 'task.get', taskId: 'A' })).contextRevision, 1)
  assert.deepEqual((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.waiting, ['A'])
  await assert.rejects(f.command('task.supplement', { ...f.member('A').command.args, text: 'changed' }, 'coordination-command:batch:A'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
})

test('real process SIGKILL after third member commit resumes original six receipts without replay', {timeout:15000}, async t => {
  const f = await fixture(t)
  const ids = ['A','B','C','D','E','F']
  for (const id of ids) await f.task(id)
  const source = await f.reserve()
  await f.command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'batch',members:ids.map(id=>f.member(id))})
  await f.close()
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js',import.meta.url).href
  const script = `import {openDynamicTaskStore} from ${JSON.stringify(moduleUrl)};
    const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
    for(const id of ['A','B','C']) await store.command({id:'apply:'+id,kind:'coordination.apply',args:{instructionId:id,expectedRevision:1}});
    process.stderr.write('kill-ready',()=>process.kill(process.pid,'SIGKILL'));`
  const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.options)],{stdio:['ignore','ignore','pipe']})
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk})
  t.after(()=>child.kill('SIGKILL'))
  const [code,signal]=await once(child,'exit')
  assert.ok(errors.includes('kill-ready'),errors)
  assert.deepEqual([code,signal],process.platform === 'win32' ? [1,null] : [null,'SIGKILL'],errors)
  await f.reopen()
  assert.deepEqual((await f.query({kind:'coordination.get',coordinationId:'batch'})).members.map(m=>m.state),
    ['applied','applied','applied','ready','ready','ready'])
  for(const id of ids) await f.command('coordination.apply',{instructionId:id,expectedRevision:1})
  for(const id of ids) assert.equal((await f.query({kind:'task.get',taskId:id})).contextRevision,1,id)
  assert.ok((await f.query({kind:'coordination.get',coordinationId:'batch'})).members.every(m=>m.receipt && m.state==='applied'))
})

test('dependency gate rejects claim before resource acquisition and cancellation does not cancel task', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const owner = (await f.command('task.claim', { taskId: 'B' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding: owner, key: 'B-work', prompt: 'work', input: {}, resourceKeys: ['shared'] })).result.execution
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await assert.rejects(f.command('execution.claim', { executionId: execution.executionId }), { code: 'DYNAMIC_COORDINATION_WAITING' })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
  await f.command('coordination.cancel', { coordinationId: 'batch', expectedRevision: 1 })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'B' })).control, 'active')
  await f.command('execution.claim', { executionId: execution.executionId })
})

test('scope, impact and cycles reject the complete batch before any member exists', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  const accept = members => f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members })
  await assert.rejects(accept([f.member('A', ['B']), f.member('B', ['A'])]), { code: 'DYNAMIC_COORDINATION_CYCLE' })
  await assert.rejects(accept([{ ...f.member('A'), progressImpact: 'unknown' }]), { code: 'DYNAMIC_COORDINATION_IMPACT_REQUIRED' })
  await f.command('task.create', { taskId: 'foreign', groupId: 'other', request: 'foreign' })
  await assert.rejects(accept([f.member('foreign')]), { code: 'DYNAMIC_COORDINATION_SCOPE' })
  assert.deepEqual(await f.query({ kind: 'coordination.list' }), [])
})

test('six fixed members recover after the third apply; later conflict reports partial effects without compensation', async t => {
  const f = await fixture(t)
  const ids = ['A','B','C','D','E','F']
  for (const id of ids) await f.task(id)
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: ids.map(id => f.member(id)) })
  for (const id of ids.slice(0,3)) await f.command('coordination.apply', { instructionId: id, expectedRevision: 1 })
  await f.reopen()
  for (const id of ids.slice(0,4)) await f.command('coordination.apply', { instructionId: id, expectedRevision: 1 })
  await f.command('task.revise', { taskId: 'E', request: 'concurrent new goal' })
  await assert.rejects(f.command('coordination.apply', { instructionId: 'E', expectedRevision: 1 }), { code: 'DYNAMIC_COORDINATION_VERSION_STALE' })
  const batch = await f.query({ kind: 'coordination.get', coordinationId: 'batch' })
  assert.deepEqual(batch.members.map(m => m.state), ['applied','applied','applied','applied','ready','ready'])
  for (const id of ids.slice(0,4)) assert.equal((await f.query({ kind: 'task.get', taskId: id })).contextRevision, 1)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'F' })).contextRevision ?? 0, 0)
})

test('formal current Owner completion releases B; reopening A invalidates its old proof', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding: owner, summary: 'A accepted', result: { evidence: ['proof:A'] } })
  assert.equal((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.member.state, 'applied')
  await f.command('task.drained', { binding: owner })
  await f.command('task.reopen', { taskId: 'A', request: 'A changed' })
  const bOwner = (await f.command('task.claim', { taskId: 'B' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding: bOwner, key: 'B-work', prompt: 'B', input: {}, resourceKeys: ['shared'] })).result.execution
  await assert.rejects(f.command('execution.claim', { executionId: execution.executionId }), { code: 'DYNAMIC_COORDINATION_WAITING' })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
})

test('v1 migration requires opt in, validates identity and preserves history atomically', async t => {
  const f = await fixture(t)
  await f.task('history'); await f.close()
  const db = new DatabaseSync(f.options.dbPath)
  db.exec('DROP TABLE dynamic_coordination; DROP TABLE dynamic_coordination_sources; DROP TABLE dynamic_coordination_members; DROP TABLE dynamic_coordination_schedules; DROP TABLE dynamic_coordination_occurrences; DROP TABLE dynamic_coordination_slots; DROP TABLE dynamic_coordination_jobs; PRAGMA user_version=1')
  db.close()
  await assert.rejects(openDynamicTaskStore(f.options), { code: 'DYNAMIC_MIGRATION_REQUIRED' })
  await assert.rejects(openDynamicTaskStore({ ...f.options, instanceId: 'wrong', migrate: true }), { code: 'DYNAMIC_INITIALIZATION_MARKER_INVALID' })
  await f.migrate()
  assert.equal((await f.query({ kind: 'task.get', taskId: 'history' })).taskId, 'history')
  assert.deepEqual(await f.query({ kind: 'coordination.list' }), [])
})

async function querySchedule(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const f = await fixture(t)
  await f.task('A')
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'query', members: [], readOnly: true })
  await f.command('coordination.schedule.create', { coordinationId: 'query', scheduleId: 'schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, action: { kind: 'read-query', taskIds: ['A'] },
    target: { conversationId: 'group', recipientIds: ['member-id'] } })
  t.mock.timers.tick(3600000)
  return f
}

test('due scan is durable, read-query observes current facts without changing Task, no Topic required', async t => {
  const f = await querySchedule(t)
  const before = await f.query({ kind: 'task.get', taskId: 'A' })
  const first = await f.command('coordination.schedule.scan', {})
  assert.equal(first.result.occurrences.length, 1)
  assert.equal((await f.command('coordination.schedule.scan', {})).result.occurrences.length, 0)
  await f.reopen()
  const occurrence = (await f.query({ kind: 'coordination.occurrence.list' }))[0]
  const claim = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.read', { jobId: claim.id, fence: claim.fence })
  assert.deepEqual(await f.query({ kind: 'task.get', taskId: 'A' }), before)
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  assert.equal(notification.taskId, null)
  assert.equal(notification.payload.fact.occurrenceId, occurrence.id)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, ['member-id'])
  assert.equal((await f.query({ kind: 'coordination.occurrence.list' }))[0].deliveryState, 'pending')
})

test('cancel before permit prevents send; permit before cancel becomes unknown after restart and never replays', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const permit = await f.command('notification.start', { notificationId: notification.id }, 'send-permit')
  assert.equal(permit.dispatchEligible, true)
  await f.command('coordination.occurrence.cancel', { occurrenceId: occurrence.id, expectedControlRevision: 1 })
  await f.reopen()
  assert.equal((await f.query({ kind: 'notification.get', notificationId: notification.id })).state, 'unknown')
  assert.equal((await f.command('notification.start', { notificationId: notification.id }, 'send-permit')).dispatchEligible, false)
  assert.equal((await f.command('notification.start', { notificationId: notification.id })).dispatchEligible, false)
})

test('cancel wins send-permit CAS and stale query worker cannot publish after lease reclaim', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  const first = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  t.mock.timers.tick(60001)
  const second = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await assert.rejects(f.command('coordination.job.read', { jobId: first.id, fence: first.fence }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  await f.command('coordination.job.read', { jobId: second.id, fence: second.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  await f.command('coordination.occurrence.cancel', { occurrenceId: occurrence.id, expectedControlRevision: 1 })
  assert.equal((await f.command('notification.start', { notificationId: notification.id })).dispatchEligible, false)
})

for (const fakeNetworkCalled of [false,true]) test(`real SIGKILL after permit: fake network called=${fakeNetworkCalled}; recovery never issues a new send`, async t => {
  const f=await querySchedule(t)
  const occurrence=(await f.command('coordination.schedule.scan',{})).result.occurrences[0]
  const job=(await f.command('coordination.job.claim',{jobId:occurrence.jobId})).result.job
  await f.command('coordination.job.read',{jobId:job.id,fence:job.fence})
  const notification=(await f.command('coordination.notification.freeze',{occurrenceId:occurrence.id})).result.notification
  const marker=`${f.options.dbPath}.fake-network`
  await f.close()
  const moduleUrl=new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js',import.meta.url).href
  const script=`import {openDynamicTaskStore} from ${JSON.stringify(moduleUrl)};import {writeFileSync} from 'node:fs';import {mock} from 'node:test';
    mock.timers.enable({apis:['Date'],now:Number(process.argv[5])});
    const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
    const permit=await store.command({id:'crash-permit',kind:'notification.start',args:{notificationId:process.argv[2]}});
    if(!permit.dispatchEligible)throw new Error('permit missing');
    if(process.argv[3]==='true')writeFileSync(process.argv[4],'one isolated fake send');
    process.stderr.write('kill-ready',()=>process.kill(process.pid,'SIGKILL'));`
  const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.options),notification.id,String(fakeNetworkCalled),marker,String(Date.now())],{stdio:['ignore','ignore','pipe']})
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk})
  t.after(()=>child.kill('SIGKILL'))
  const [code,signal]=await once(child,'exit');assert.ok(errors.includes('kill-ready'),errors)
  assert.deepEqual([code,signal],process.platform === 'win32' ? [1,null] : [null,'SIGKILL'],errors)
  await f.reopen()
  assert.equal((await f.query({kind:'notification.get',notificationId:notification.id})).state,'unknown')
  for(const commandId of ['crash-permit','new-recovery-attempt'])
    assert.equal((await f.command('notification.start',{notificationId:notification.id},commandId)).dispatchEligible,false)
  if(fakeNetworkCalled) assert.equal(await readFile(marker,'utf8'),'one isolated fake send')
  else await assert.rejects(readFile(marker),{code:'ENOENT'})
})

test('SIGKILL after job claim recovers the same occurrence and preserves the lease instead of inventing success', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  await f.close()
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const script = `import { openDynamicTaskStore } from ${JSON.stringify(moduleUrl)};
    const store = await openDynamicTaskStore(JSON.parse(process.argv[1]));
    await store.command({id:'crash-claim',kind:'coordination.job.claim',args:{jobId:process.argv[2]}});
    process.stdout.write('claimed'); setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(f.options), occurrence.jobId], { stdio: ['ignore','pipe','pipe'] })
  const exited = once(child, 'exit')
  t.after(() => child.kill('SIGKILL'))
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
    exited.then(([code, signal]) => { throw new Error(`child exited before claim: ${code}/${signal}`) }),
  ])
  assert.equal(ready, 'claimed')
  child.kill('SIGKILL')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  await f.reopen()
  assert.equal((await f.command('coordination.schedule.scan', {})).result.occurrences.length, 0)
  const recovered = await f.query({ kind: 'coordination.occurrence.list' })
  assert.equal(recovered.length, 1); assert.equal(recovered[0].id, occurrence.id)
  assert.equal(recovered[0].actionState, 'running')
  const job = (await f.query({ kind: 'coordination.job.list' }))[0]
  assert.equal(job.attempt, 1); assert.equal(job.state, 'running'); assert.equal(job.result, undefined)
})
