import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rename, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { currentCoordinationFixture as fixture } from './fixtures/current-coordination-contracts.js'

const source = (id, version = 1) => ({ sourceId: id, groupId: 'group', messageId: 'message', version, actorId: 'author',
  channel: 'im', text: '核验原需求', quote: { messageId: 'quoted-result', content: '验收依据 https://example.org/results/1' }, timestamp: '2026-10-21T00:00:00Z' })
const supplement = (taskId, id = taskId) => ({ taskId, messageId: `material-${id}`, text: '补充核验材料',
  expectedRequirementRevision: 1, expectedControlRevision: 1 })
const notices = state => ['notifications', `old-${state}`, { kind: 'coordination', state,
  ...(state === 'prepared' ? {} : { dispatchToken: 'historical-token', sendPermit: { notificationId: `old-${state}` } }),
  ...(state === 'acknowledged' ? { ack: { openTaskId: 'accepted-send' } } : {}),
  ...(state === 'delivered' ? { receipt: { messageId: 'delivered-once' } } : {}),
  payload: { text: '原澄清问题', conversationId: 'group', fact: { coordinationId: 'old', eventId: state } } }]
const currentRows = f => f.inspect(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))

async function dormantHistory(t, extra = []) {
  const f = await fixture(t)
  for (const taskId of ['A', 'B', 'C', 'D']) await f.command('task.create', { taskId, groupId: 'group', ownerActorId: 'author', request: taskId })
  const before = await f.query('task.list'), wakes = await f.query('wake.list')
  await f.historical([
    ['coordination', 'old', { groupId: 'group', state: 'active', revision: 3, clarification: '原问题', history: [{ kind: 'accepted', evidence: 'original' }], memberIds: ['old-A'] }],
    ['coordination_members', 'old-A', { coordinationId: 'old', taskId: 'A', state: 'observing', observation: true, originalInstruction: '保留原核验目标' }],
    ...extra,
  ])
  return { ...f, before, wakes }
}

test('retirement preserves four business Tasks, old questions, read-only history and send evidence atomically', async t => {
  const f = await dormantHistory(t, ['prepared', 'starting', 'unknown', 'delivered'].map(notices))
  const history = await f.query('coordination.get', { coordinationId: 'old' }), snapshot = currentRows(f)
  assert.equal(history.coordination.clarification, '原问题'); assert.equal(history.coordination.state, 'active')
  assert.equal(history.coordination.retirement.previousState, 'active'); assert.equal(history.members[0].eligible, false)
  for (let i = 0; i < 5; i++) await f.query('coordination.get', { coordinationId: 'old' })
  assert.deepEqual(currentRows(f), snapshot, '读取历史不产生命令回执或新调度')
  assert.deepEqual(await f.query('task.list'), f.before); assert.deepEqual(await f.query('wake.list'), f.wakes)
  const all = await f.query('notification.list')
  assert.equal(all.find(n => n.id === 'old-prepared').state, 'superseded')
  assert.equal(all.find(n => n.id === 'old-starting').state, 'unknown')
  assert.equal(all.find(n => n.id === 'old-unknown').state, 'unknown')
  assert.equal(all.find(n => n.id === 'old-delivered').receipt.messageId, 'delivered-once')
  await f.reopen()
  assert.deepEqual(await f.query('notification.list'), all)
  assert.deepEqual(await f.query('coordination.get', { coordinationId: 'old' }), history)
})

for (const patch of [{ taskId: 'B' }, { sessionId: 'other' }, { kind: 'task-execution' }, { leaseEpoch: 99 }])
test(`current Owner identity mismatch is rejected without writes: ${JSON.stringify(patch)}`, async t => {
  const f = await fixture(t), binding = await f.create('A')
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const before = currentRows(f)
  await assert.rejects(f.command('task.complete', { binding: { ...binding, ...patch }, summary: 'forged' }), { code: 'DYNAMIC_TASK_LEASE_STALE' })
  assert.deepEqual(currentRows(f), before)
})

for (const variant of ['downstream', 'schedule', 'executable']) test(`historical ${variant} records retire without cancelling or completing linked business work`, async t => {
  const extra = variant === 'schedule'
    ? [['coordination_schedules', 'dependent', { coordinationId: 'old', state: 'active', rule: { kind: 'daily', time: '09:00' } }]]
    : [['coordination_members', 'dependent', { coordinationId: 'old', taskId: 'B', state: variant === 'executable' ? 'applied' : 'waiting',
      dependencies: ['old-A'], command: { kind: 'task.supplement', args: supplement('B') }, receipt: variant === 'executable' ? { commandId: 'historical-apply' } : null }]]
  const f = await dormantHistory(t, extra)
  const view = variant === 'schedule' ? (await f.query('coordination.schedule.list'))[0] : (await f.query('coordination.get', { coordinationId: 'old' })).members[1]
  assert.equal(view.retirement.previousState, extra[0][2].state)
  assert.equal(view.state, extra[0][2].state)
  if (variant !== 'schedule') assert.deepEqual(view.command, extra[0][2].command)
  await f.reopen()
  assert.deepEqual(await f.query('task.list'), f.before); assert.deepEqual(await f.query('wake.list'), f.wakes)
  assert.deepEqual(await f.query('coordination.job.list'), [])
})

test('exact source version retains original author, quote and historical processing evidence across restart', async t => {
  const f = await fixture(t), original = source('original')
  await f.command('source.record', original, 'source-original')
  const before = await f.query('source.get', { sourceId: original.sourceId })
  await f.command('source.record', { ...source('later', 2), quote: { messageId: 'new-quote', content: '新版本的依据' } })
  await f.reopen()
  assert.deepEqual(await f.query('source.get', { sourceId: original.sourceId }), before)
  assert.equal((await f.command('source.record', original, 'source-original')).replayed, true)
  assert.deepEqual((await f.query('source.get', { sourceId: 'original' })).quote, original.quote)
})

for (const patch of [
  { requirementRevision: 0 }, { requirementRevision: 2 }, { controlRevision: 0 }, { controlRevision: 2 },
  { contextRevision: 1 }, { contextRevision: -1 }, { leaseEpoch: 0 },
]) test(`current completion CAS rejects mismatched version without a fact or notification: ${JSON.stringify(patch)}`, async t => {
  const f = await fixture(t), binding = await f.create(), before = currentRows(f)
  await assert.rejects(f.finish({ ...binding, ...patch }), { code: patch.leaseEpoch !== undefined ? 'DYNAMIC_TASK_LEASE_STALE' : 'DYNAMIC_TASK_REVISION_STALE' })
  assert.deepEqual(currentRows(f), before)
  assert.deepEqual(await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId }), [])
  assert.deepEqual(await f.query('notification.list'), [])
})

test('unanswered Owner clarification preserves its original question and source after restart without success', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.command('task.wait', { binding, action: 'blocked', summary: '缺少验收条件', question: '请明确验收条件',
    humanRequest: { requestId: 'question', audience: 'requester', reason: '需要业务信息', attemptedActions: [] }, topicFacts: true })
  await f.command('task.drained', { binding })
  const before = await f.query('task.get', { taskId: 'A' })
  await f.reopen()
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), before)
  assert.equal(before.humanRequests[0].question, '请明确验收条件')
  assert.equal(before.humanRequests[0].status, 'waiting-reply')
  assert.equal(before.status, 'active'); assert.equal(before.completion, undefined)
  assert.deepEqual(await f.query('notification.list'), [])
  assert.match((await f.context()).input.tasks[0].pendingRequests[0].question, /验收条件/)
})

for (const state of ['prepared', 'starting', 'unknown', 'acknowledged']) test(`retirement preserves the original clarification ${state} send boundary`, async t => {
  const f = await dormantHistory(t, [notices(state)])
  const notice = await f.query('notification.get', { notificationId: `old-${state}` })
  assert.equal(notice.state, state === 'prepared' ? 'superseded' : state === 'starting' ? 'unknown' : state)
  assert.deepEqual(notice.payload, notices(state)[2].payload)
  if (state !== 'prepared') assert.equal(notice.dispatchToken, 'historical-token')
  if (state === 'acknowledged') assert.deepEqual(notice.ack, { openTaskId: 'accepted-send' })
  await f.reopen()
  assert.deepEqual(await f.query('notification.get', { notificationId: notice.id }), notice)
  assert.deepEqual(await f.query('task.list'), f.before)
})

test('new source version never supplies missing quote or author facts for an older source identity', async t => {
  const f = await fixture(t)
  await f.command('source.record', { ...source('old-version'), quote: null })
  await f.command('source.record', source('new-version', 2))
  await f.reopen()
  const old = await f.query('source.get', { sourceId: 'old-version' })
  assert.equal(old.version, 1); assert.equal(old.quote, null)
  const newer = await f.query('source.get', { sourceId: 'new-version' })
  assert.equal(newer.version, 2); assert.deepEqual(newer.quote, source('new-version', 2).quote)
})

for (const table of ['members', 'schedules', 'occurrences', 'jobs']) test(`existing historical ${table} effect evidence is not replayed during current startup`, async t => {
  const row = { coordinationId: 'old', state: 'running', actionState: 'running', taskId: 'B', attempt: 1,
    receipt: { commandId: 'already-applied' }, dependencies: [], result: null }
  const f = await dormantHistory(t, [[`coordination_${table}`, 'historical-effect', row]])
  const read = () => f.inspect(db => JSON.parse(db.prepare(`SELECT body FROM dynamic_coordination_${table} WHERE id=?`).get('historical-effect').body))
  const before = read()
  await f.reopen()
  assert.deepEqual(read(), before); assert.deepEqual(before.receipt, row.receipt)
  assert.equal(before.state, 'running'); assert.equal(before.result, null)
  assert.deepEqual(await f.query('task.list'), f.before)
  assert.deepEqual(await f.query('wake.list'), f.wakes)
})

test('Owner provider retry keeps its durable backoff across restart and never resets accepted work', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const f = await fixture(t), binding = await f.create()
  await f.command('task.provider-failure', { binding, failure: { code: 'TRANSIENT', message: 'retry later' } })
  await f.command('task.drained', { binding })
  const before = await f.query('task.get', { taskId: 'A' })
  await f.reopen()
  await assert.rejects(f.command('task.claim', { taskId: 'A' }), { code: 'DYNAMIC_TASK_PROVIDER_RETRY_NOT_DUE' })
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), before)
  t.mock.timers.tick(5001)
  const next = (await f.command('task.claim', { taskId: 'A' })).result.binding
  assert.equal(next.leaseEpoch, binding.leaseEpoch + 1)
  assert.equal((await f.query('task.get', { taskId: 'A' })).providerRecovery.attempts, 1)
})

test('pause fences an already-preflighted Owner completion without consuming that command id', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.command('task.control', { taskId: 'A', control: 'paused', expectedControlRevision: 1 })
  const before = currentRows(f)
  await assert.rejects(f.finish(binding, 'stale complete', 'stale-complete'), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  assert.deepEqual(currentRows(f), before)
  assert.equal(await f.query('receipt.get', { id: 'stale-complete' }), null)
})

test('source admission and Task supplement survive restart without replaying the accepted mutation', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'A', groupId: 'group', request: 'A' }, 'create-A')
  const args = supplement('A')
  await f.command('task.supplement', args, 'supplement-A')
  const task = await f.query('task.get', { taskId: 'A' }), wakes = await f.query('wake.list')
  await f.reopen()
  assert.equal((await f.command('task.supplement', args, 'supplement-A')).replayed, true)
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), task)
  assert.deepEqual(await f.query('wake.list'), wakes); assert.equal(task.contextRevision, 1)
})

async function crash(t, f, script, args = [], { signal = t.signal, onSpawn = () => {} } = {}) {
  await f.close()
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const code = `import {openDynamicTaskStore} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs';
    const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
    ${script}
    process.stderr.write('kill-ready',()=>process.kill(process.pid,'SIGKILL'));`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.options), ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])))
  let launchError
  child.once('error', error => { launchError = error })
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  // Fixture cleanup also awaits this on timeout, before SQLite close/rm. A later
  // t.after(kill) would run after the fixture has already tried to remove its DB.
  const unregister = f.beforeClose(stop), abort = () => { void stop() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    onSpawn(child)
    if (signal.aborted) abort()
    const result = await closed
    if (launchError) throw launchError
    if (signal.aborted) throw signal.reason
    assert.ok(errors.includes('kill-ready'), errors)
    assert.deepEqual(result, process.platform === 'win32' ? [1, null] : [null, 'SIGKILL'], errors)
  } finally {
    await stop()
    unregister(); signal.removeEventListener('abort', abort)
  }
  await f.reopen()
}

test('SIGKILL fixture abort before kill-ready waits for child close before database cleanup', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController()
  let childClosed = false
  await assert.rejects(crash(t, f, "setInterval(()=>{},1000); process.stderr.write('holding-db'); await new Promise(()=>{});", [], {
    signal: controller.signal,
    onSpawn: child => {
      child.once('close', () => { childClosed = true })
      child.stderr.on('data', chunk => { if (String(chunk).includes('holding-db')) controller.abort(new Error('synthetic timeout')) })
    },
  }), /synthetic timeout/)
  assert.equal(childClosed, true, 'the process must release SQLite before fixture cleanup starts')
  await f.close()
  const moved = `${f.options.dbPath}.released`
  await rename(f.options.dbPath, moved)
  await rm(moved)
})

test('real SIGKILL after third Task supplement resumes six original receipts without replay', { timeout: 15000 }, async t => {
  const f = await fixture(t), ids = ['A', 'B', 'C', 'D', 'E', 'F']
  for (const taskId of ids) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  await crash(t, f, `for(const taskId of ['A','B','C'])await store.command({id:'apply:'+taskId,kind:'task.supplement',
    args:{taskId,messageId:'material-'+taskId,text:'补充核验材料',expectedRequirementRevision:1,expectedControlRevision:1}});`)
  assert.deepEqual((await f.query('task.list')).map(task => task.contextRevision ?? 0), [1, 1, 1, 0, 0, 0])
  for (const id of ids) await f.command('task.supplement', supplement(id), `apply:${id}`)
  for (const id of ids) {
    assert.equal((await f.query('task.get', { taskId: id })).contextRevision, 1)
    assert.ok(await f.query('receipt.get', { id: `apply:${id}` }))
  }
})

test('another Task cannot acquire a claimed resource and cancelling one Task does not cancel the other', async t => {
  const f = await fixture(t), a = await f.create('A'), b = await f.create('B')
  const first = (await f.command('execution.dispatch', { binding: a, key: 'first', prompt: 'A', resourceKeys: ['same-resource'] })).result.execution
  await f.command('execution.claim', { executionId: first.executionId })
  const second = (await f.command('execution.dispatch', { binding: b, key: 'second', prompt: 'B', resourceKeys: ['same-resource'] })).result.execution
  await assert.rejects(f.command('execution.claim', { executionId: second.executionId }), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const bBefore = await f.query('task.get', { taskId: 'B' })
  await f.command('task.control', { taskId: 'A', control: 'cancelled' })
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), bBefore)
  assert.equal((await f.query('resource.list')).length, 1)
})

test('cross-group source binding rejects the whole Task creation before any Task or wake exists', async t => {
  const f = await fixture(t), before = currentRows(f)
  await assert.rejects(f.command('task.create', { taskId: 'wrong-scope', groupId: 'group', request: 'do work',
    replyBindings: [{ groupId: 'other', topicId: f.topicId, sourceIds: ['source'] }] }), { code: 'TOPIC_REPLY_SOURCE_INVALID' })
  assert.deepEqual(currentRows(f), before)
  assert.equal(await f.query('task.get', { taskId: 'wrong-scope' }), null)
})

test('partial multi-Task application preserves committed receipts and exposes a later version conflict without compensation', async t => {
  const f = await fixture(t), ids = ['A', 'B', 'C', 'D', 'E', 'F']
  for (const taskId of ids) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  for (const id of ids.slice(0, 3)) await f.command('task.supplement', supplement(id), `apply:${id}`)
  await f.command('task.revise', { taskId: 'D', expectedRequirementRevision: 1, request: 'new D target' })
  await assert.rejects(f.command('task.supplement', supplement('D'), 'apply:D'), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.reopen()
  for (const id of ids.slice(0, 3)) assert.equal((await f.command('task.supplement', supplement(id), `apply:${id}`)).replayed, true)
  assert.deepEqual((await f.query('task.list')).map(task => task.contextRevision ?? 0), [1, 1, 1, 0, 0, 0])
  assert.equal(await f.query('receipt.get', { id: 'apply:D' }), null)
})

test('formal Owner completion remains scoped to its Task and reopening invalidates its old proof', async t => {
  const f = await fixture(t), binding = await f.create('A')
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const b = await f.query('task.get', { taskId: 'B' }), wakes = await f.query('wake.list', { taskId: 'B' })
  const receipt = await f.finish(binding); await f.command('task.drained', { binding })
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), b)
  assert.deepEqual(await f.query('wake.list', { taskId: 'B' }), wakes)
  await f.command('task.reopen', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'new acceptance' })
  const reopened = await f.query('task.get', { taskId: 'A' })
  assert.equal(reopened.completion, null); assert.equal(reopened.runSequence, 2)
  assert.deepEqual((await f.query('receipt.get', { id: receipt.taskDecision.id })).taskDecision, receipt.taskDecision)
})

test('v1 migration requires opt in, validates identity and preserves history atomically', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'history', groupId: 'group', request: 'history' }); await f.close()
  const db = new DatabaseSync(f.options.dbPath)
  db.exec('DROP TABLE dynamic_coordination; DROP TABLE dynamic_coordination_sources; DROP TABLE dynamic_coordination_members; DROP TABLE dynamic_coordination_schedules; DROP TABLE dynamic_coordination_occurrences; DROP TABLE dynamic_coordination_slots; DROP TABLE dynamic_coordination_jobs; PRAGMA user_version=1')
  db.close()
  await assert.rejects(openDynamicTaskStore(f.options), { code: 'DYNAMIC_MIGRATION_REQUIRED' })
  await assert.rejects(openDynamicTaskStore({ ...f.options, instanceId: 'wrong', migrate: true }), { code: 'DYNAMIC_INITIALIZATION_MARKER_INVALID' })
  const migrated = await openDynamicTaskStore({ ...f.options, migrate: true })
  try {
    assert.equal((await migrated.query({ kind: 'task.get', taskId: 'history' })).taskId, 'history')
    assert.deepEqual(await migrated.query({ kind: 'coordination.list' }), [])
  } finally { await migrated.close() }
})

test('current fact queries read task outcomes without scheduling, mutation or a synthetic completion', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding); await f.command('task.drained', { binding })
  const before = currentRows(f)
  const tasks = await f.query('topic.fact.tasks', { taskIds: ['A'], groupId: 'group', topicId: f.topicId })
  assert.equal(tasks[0].status, 'completed'); assert.equal(tasks[0].summary, '核验完成')
  assert.deepEqual(currentRows(f), before)
  assert.deepEqual(await f.query('coordination.job.list'), [])
})

test('retiring a proven unsent effect prevents retry; a permitted effect stays unknown and cannot be retired or replayed', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding)
  await f.submit(f.submission(await f.context(), { reply: '已完成', atOpenDingTalkIds: ['author'] }))
  const [notice] = await f.query('notification.list')
  const started = (await f.command('notification.start', { notificationId: notice.id })).result.notification
  await f.command('notification.receipt', { notificationId: notice.id, dispatchToken: started.dispatchToken, state: 'failed',
    error: { phase: 'send', knownNotSent: true, retryable: true, message: 'transport rejected before sending' } })
  const retire = { notificationId: notice.id, reason: 'superseded', evidenceRef: 'fixture:verified' }
  await f.command('notification.retireUnsent', retire)
  assert.equal(Boolean((await f.command('notification.start', { notificationId: notice.id })).dispatchEligible), false)
  assert.equal((await f.query('notification.get', { notificationId: notice.id })).retirement.reason, 'superseded')
  assert.equal((await f.query('notification.get', { notificationId: notice.id })).deliveryError.retryable, false)
  await f.command('notification.prepare', { notificationId: 'other', taskId: 'A', requirementRevision: 1, kind: 'status',
    payload: { conversationId: 'group', text: '另一条明确结果' } })
  await f.command('notification.start', { notificationId: 'other' })
  await f.command('task.drained', { binding }); await f.reopen()
  await assert.rejects(f.command('notification.retireUnsent', { ...retire, notificationId: 'other' }), { code: 'DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED' })
  assert.equal((await f.query('notification.get', { notificationId: 'other' })).state, 'unknown')
  assert.equal(Boolean((await f.command('notification.start', { notificationId: 'other' })).dispatchEligible), false)
})

test('stale Topic decision cannot publish after another decision consumes its facts', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding)
  const context = await f.context(), args = { reply: '验收通过', atOpenDingTalkIds: ['author'] }
  await f.submit(f.submission(context, args, 'first'))
  const before = await f.query('notification.list')
  assert.equal((await f.submit(f.submission(context, args, 'stale'))).status, 'topic-stale')
  assert.deepEqual(await f.query('notification.list'), before)
})

for (const fakeNetworkCalled of [false, true]) test(`real SIGKILL after current send permit: fake network called=${fakeNetworkCalled}; recovery never issues a new send`, { timeout: 15000 }, async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding); await f.command('task.drained', { binding })
  await f.submit(f.submission(await f.context(), { reply: '已完成', atOpenDingTalkIds: ['author'] }))
  const [notice] = await f.query('notification.list'), marker = `${f.options.dbPath}.fake-network`
  await crash(t, f, `const permit=await store.command({id:'crash-permit',kind:'notification.start',args:{notificationId:process.argv[2]}});
    if(!permit.dispatchEligible)throw new Error('permit missing');
    if(process.argv[3]==='true')writeFileSync(process.argv[4],'one isolated fake send');`, [notice.id, String(fakeNetworkCalled), marker])
  assert.equal((await f.query('notification.get', { notificationId: notice.id })).state, 'unknown')
  for (const commandId of ['crash-permit', 'new-recovery-attempt']) assert.equal(Boolean((await f.command('notification.start', { notificationId: notice.id }, commandId)).dispatchEligible), false)
  if (fakeNetworkCalled) assert.equal(await readFile(marker, 'utf8'), 'one isolated fake send')
  else await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('real SIGKILL after execution claim preserves the original lease and cannot invent a successful result', { timeout: 15000 }, async t => {
  const f = await fixture(t), binding = await f.create()
  const execution = (await f.command('execution.dispatch', { binding, key: 'original', prompt: '原执行' })).result.execution
  await f.command('task.drained', { binding })
  await crash(t, f, `await store.command({id:'crash-claim',kind:'execution.claim',args:{executionId:process.argv[2]}});`, [execution.executionId])
  const recovered = await f.query('execution.get', { executionId: execution.executionId })
  assert.equal(recovered.leaseEpoch, 1); assert.equal(recovered.recovering, true)
  assert.equal(recovered.result, undefined); assert.equal(recovered.status, 'running')
  assert.equal((await f.query('execution.list', { taskId: 'A' })).length, 1)
  assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'active')
})
