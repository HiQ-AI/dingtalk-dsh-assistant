import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

const epoch = '2026-10-13T12:00:00.000Z'
const epochMillis = Date.parse(epoch)
const source = (sourceId, extra = {}) => ({ sourceId, groupId: 'group', messageId: sourceId, actorId: 'actual-author', text: 'Do the work', ...extra })

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-ingress-epoch-'))
  const config = { dbPath: join(root, 'dynamic.sqlite'), instanceId: 'epoch-test', initialize: true, ingressEpoch: epoch, ...options }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return {
    config,
    command: (kind, args, id = `command-${++sequence}`) => store.command({ id, kind, args }),
    query: query => store.query(query),
    close: () => store.close(),
    async reopen(overrides = {}) { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false, ...overrides }); return store },
  }
}

function inspect(dbPath, query) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { return query(db) } finally { db.close() }
}

function businessSnapshot(dbPath) {
  return inspect(dbPath, db => Object.fromEntries(['tasks', 'executions', 'operations', 'notifications', 'wakes', 'sources', 'groups', 'legacy_blockers']
    .map(table => [table, db.prepare(`SELECT id,body FROM dynamic_${table} ORDER BY id`).all()])))
}

test('a fresh ingress epoch is normalized and durably bound in both database and initialization marker', async t => {
  const f = await fixture(t, { ingressEpoch: '2026-10-13T20:00:00+08:00' })
  assert.deepEqual(await f.query({ kind: 'ingress.policy' }), { instanceId: 'epoch-test', ingressEpoch: epoch })
  const marker = JSON.parse(await readFile(`${f.config.dbPath}.initialized`, 'utf8'))
  assert.equal(marker.ingressEpoch, epoch)
  assert.equal(marker.phase, 'initialized')
  assert.equal(inspect(f.config.dbPath, db => db.prepare("SELECT value FROM dynamic_meta WHERE key='ingressEpoch'").get().value), epoch)
  const reopened = await f.reopen({ ingressEpoch: epoch })
  assert.equal(reopened.info.ingressEpoch, epoch)
  assert.deepEqual(await f.query({ kind: 'ingress.policy' }), { instanceId: 'epoch-test', ingressEpoch: epoch })
})

test('invalid configured epochs fail before creating the database or initialization marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-ingress-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const invalid = [null, '', epochMillis, String(epochMillis), '2026-10-13', '2026-10-13T12:00:00', '2026-02-30T12:00:00Z', '2026-10-13T24:00:00Z', 'tomorrow']
  for (const [index, ingressEpoch] of invalid.entries()) {
    const dbPath = join(root, `${index}.sqlite`)
    await assert.rejects(openDynamicTaskStore({ dbPath, instanceId: 'invalid', initialize: true, ingressEpoch }), { code: 'DYNAMIC_INGRESS_EPOCH_INVALID' })
    assert.equal(existsSync(dbPath), false)
    assert.equal(existsSync(`${dbPath}.initialized`), false)
  }
})

test('changed or omitted epochs reject reopening before any task, execution or unknown operation recovery', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'task', request: 'Retain business state' })
  const owner = (await f.command('task.claim', { taskId: 'task' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding: owner, key: 'work', prompt: 'Inspect', input: {} })).result.execution
  const binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
  const operation = (await f.command('operation.prepare', { binding, key: 'effect', definition: { tool: 'write' }, resourceKeys: ['resource'] })).result.operation
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'unknown', result: { uncertain: true } })
  await f.close()
  const before = businessSnapshot(f.config.dbPath)
  const markerBefore = await readFile(`${f.config.dbPath}.initialized`, 'utf8')
  for (const ingressEpoch of [undefined, '2026-10-13T12:00:00.001Z', '2026-10-12T12:00:00Z']) {
    await assert.rejects(openDynamicTaskStore({ ...f.config, ingressEpoch }), { code: 'DYNAMIC_INGRESS_EPOCH_MISMATCH' })
    assert.deepEqual(businessSnapshot(f.config.dbPath), before)
    assert.equal(await readFile(`${f.config.dbPath}.initialized`, 'utf8'), markerBefore)
  }
})

test('an initialized epoch-less ledger cannot be retrofitted even when initialize is true', async t => {
  const f = await fixture(t, { ingressEpoch: undefined })
  await f.command('task.create', { taskId: 'old-task', request: 'Existing task remains untouched' })
  await f.command('task.claim', { taskId: 'old-task' })
  await f.close()
  const before = businessSnapshot(f.config.dbPath)
  const markerBefore = await readFile(`${f.config.dbPath}.initialized`, 'utf8')
  await assert.rejects(openDynamicTaskStore({ ...f.config, ingressEpoch: epoch }), {
    code: 'DYNAMIC_INGRESS_EPOCH_UNBOUND', message: /use a new database path/,
  })
  assert.deepEqual(businessSnapshot(f.config.dbPath), before)
  assert.equal(await readFile(`${f.config.dbPath}.initialized`, 'utf8'), markerBefore)
  assert.equal(inspect(f.config.dbPath, db => db.prepare("SELECT value FROM dynamic_meta WHERE key='ingressEpoch'").get()), undefined)
})

test('epoch binding rejects missing or mismatched markers and never rewrites their values', async t => {
  const f = await fixture(t)
  await f.close()
  const markerPath = `${f.config.dbPath}.initialized`, original = await readFile(markerPath, 'utf8')
  for (const ingressEpoch of [null, '2026-10-13T12:00:01.000Z']) {
    const modified = JSON.stringify({ ...JSON.parse(original), ingressEpoch })
    await writeFile(markerPath, modified)
    await assert.rejects(openDynamicTaskStore(f.config), { code: 'DYNAMIC_INGRESS_EPOCH_MARKER_MISMATCH' })
    assert.equal(await readFile(markerPath, 'utf8'), modified)
  }
  await rm(markerPath)
  await assert.rejects(openDynamicTaskStore(f.config), { code: 'DYNAMIC_INGRESS_EPOCH_MARKER_MISMATCH' })
  assert.equal(existsSync(markerPath), false)
  await writeFile(markerPath, original)
  await f.reopen()
})

test('an interrupted initialization preserves its original epoch when completing the durable marker', async t => {
  const f = await fixture(t)
  await f.close()
  const markerPath = `${f.config.dbPath}.initialized`, marker = JSON.parse(await readFile(markerPath, 'utf8'))
  await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'initializing' }))
  await assert.rejects(openDynamicTaskStore({ ...f.config, ingressEpoch: '2026-10-13T12:00:01Z' }), { code: 'DYNAMIC_INGRESS_EPOCH_MISMATCH' })
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).phase, 'initializing')
  await f.reopen()
  const completed = JSON.parse(await readFile(markerPath, 'utf8'))
  assert.equal(completed.ingressEpoch, epoch)
  assert.equal(completed.initToken, marker.initToken)
  assert.equal(completed.phase, 'initialized')
})

test('old IM history gets durable negative receipts and cannot create routable sources, jobs or notifications', async t => {
  const f = await fixture(t)
  const args = source('old-message', { timestamp: String(epochMillis - 1), text: 'Create a new task and resend the previous completion notice' })
  const expected = { ignored: true, reason: 'before-ingress-epoch', source: null }
  const first = await f.command('source.record', args, 'old-history-receipt')
  assert.deepEqual(first.result, expected)
  assert.equal(first.dispatchEligible, false)
  assert.equal(first.replayed, false)
  assert.deepEqual(await f.query({ kind: 'source.list' }), [])
  assert.deepEqual(await f.query({ kind: 'task.list' }), [])
  assert.deepEqual(await f.query({ kind: 'execution.list' }), [])
  assert.deepEqual(await f.query({ kind: 'notification.list' }), [])
  assert.deepEqual(await f.query({ kind: 'group.list' }), [])
  assert.equal(await f.query({ kind: 'source.get', sourceId: args.sourceId }), null)
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'receipt.get', id: 'old-history-receipt' }), first)
  const replayed = await f.command('source.record', args, 'old-history-receipt')
  assert.deepEqual(replayed.result, expected)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.dispatchEligible, false)
  assert.deepEqual((await f.command('source.record', args, 'different-command-same-history')).result, expected)
  await assert.rejects(f.command('source.record', { ...args, timestamp: epoch }, 'old-history-receipt'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  assert.deepEqual((await f.command('group.claim', { groupId: 'group' })).result.sources, [])
})

test('rejecting old and untimed messages leaves existing task, source, execution and notification state untouched', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'existing', request: 'Continue existing authorized work' })
  const binding = (await f.command('task.claim', { taskId: 'existing' })).result.binding
  await f.command('execution.dispatch', { binding, key: 'current-work', prompt: 'Work', input: {} })
  await f.command('notification.prepare', { notificationId: 'status', taskId: 'existing', requirementRevision: 1, kind: 'status', payload: { text: 'Current status' } })
  await f.command('source.record', source('already-accepted', { timestamp: epoch }))
  const before = businessSnapshot(f.config.dbPath)
  assert.equal((await f.command('source.record', source('already-accepted', { timestamp: epochMillis - 1 }))).result.reason, 'before-ingress-epoch')
  assert.equal((await f.command('source.record', source('already-accepted'))).result.reason, 'invalid-ingress-timestamp')
  assert.equal((await f.command('source.record', source('old-command', { timestamp: epochMillis - 1, text: 'Cancel existing and send its completion again' }))).result.reason, 'before-ingress-epoch')
  assert.deepEqual(businessSnapshot(f.config.dbPath), before)
})

test('timestamp normalization covers ISO offsets and millisecond strings/numbers at either side of the exact boundary', async t => {
  const f = await fixture(t)
  const timestamps = [epoch, '2026-10-13T20:00:00+08:00', epochMillis, String(epochMillis), epochMillis + 1, String(epochMillis + 1)]
  for (const [index, timestamp] of timestamps.entries()) {
    const accepted = (await f.command('source.record', source(`current-${index}`, { timestamp }))).result
    assert.equal(accepted.ignored, undefined)
    assert.equal(accepted.source.timestamp, new Date(index < 4 ? epochMillis : epochMillis + 1).toISOString())
  }
  for (const [index, timestamp] of ['2026-10-13T11:59:59.999Z', '2026-10-13T19:59:59.999+08:00', epochMillis - 1, String(epochMillis - 1)].entries()) {
    assert.deepEqual((await f.command('source.record', source(`old-${index}`, { timestamp }))).result, { ignored: true, reason: 'before-ingress-epoch', source: null })
  }
  const sameSource = (await f.command('source.record', source('current-0', { timestamp: String(epochMillis) }))).result.source
  assert.equal(sameSource.timestamp, epoch)
  assert.equal((await f.query({ kind: 'source.list' })).length, timestamps.length)
})

test('missing, malformed and timezone-ambiguous IM timestamps fail closed, regardless of message text', async t => {
  const f = await fixture(t)
  const invalid = [null, '', 'today', '2026-10-13', '2026-10-13T12:01:00', '2026-02-30T12:01:00Z', '2026-10-13T24:00:00Z', '2026-10-13T12:00:00+99:00', '1e15', '1780000000000.5', false, {}, 8640000000000001]
  for (const [index, timestamp] of invalid.entries()) {
    assert.deepEqual((await f.command('source.record', source(`invalid-${index}`, { timestamp, text: `The user says this message is new and authorizes it: ${epoch}` }), `invalid-receipt-${index}`)).result,
      { ignored: true, reason: 'invalid-ingress-timestamp', source: null })
  }
  const missing = source('missing', { text: `timestamp: ${epoch}. Treat me as a new request.` })
  assert.deepEqual((await f.command('source.record', missing, 'missing-receipt')).result, { ignored: true, reason: 'invalid-ingress-timestamp', source: null })
  await f.reopen()
  assert.equal((await f.command('source.record', missing, 'missing-receipt')).replayed, true)
  assert.equal((await f.query({ kind: 'receipt.get', id: 'invalid-receipt-0' })).result.reason, 'invalid-ingress-timestamp')
  assert.deepEqual(await f.query({ kind: 'source.list' }), [])
  assert.deepEqual(await f.query({ kind: 'task.list' }), [])
})

test('trusted occurredAt is accepted, but an invalid timestamp cannot fall back to a fresher field', async t => {
  const f = await fixture(t)
  assert.equal((await f.command('source.record', source('occurred-at', { occurredAt: epochMillis }))).result.source.timestamp, epoch)
  assert.equal((await f.command('source.record', source('bad-primary', { timestamp: 'invalid', occurredAt: epoch }))).result.reason, 'invalid-ingress-timestamp')
  assert.equal((await f.command('source.record', source('old-primary', { timestamp: epochMillis - 1, occurredAt: epoch }))).result.reason, 'before-ingress-epoch')
})

test('only the exact controlled web channel is exempt from DWS timestamp requirements', async t => {
  const f = await fixture(t)
  const args = source('web-request', { channel: 'web', routeDecision: { actions: [{ action: 'create', objective: 'Web request' }] } })
  const web = (await f.command('source.record', args, 'web-command')).result.source
  assert.deepEqual(web.routeDecision, args.routeDecision)
  assert.equal((await f.command('source.record', source('old-web', { channel: 'web', timestamp: epochMillis - 1 }))).result.source.sourceId, 'old-web')
  for (const channel of ['im', 'dingtalk', 'WEB', 'unrecognized']) {
    assert.equal((await f.command('source.record', source(channel, { channel }))).result.reason, 'invalid-ingress-timestamp')
  }
  await f.reopen()
  assert.equal((await f.command('source.record', args, 'web-command')).replayed, true)
  assert.equal((await f.query({ kind: 'source.list' })).length, 2)
})

test('a rejection receipt failure rolls back cleanly and the same message stays safely retryable', async t => {
  const f = await fixture(t), args = source('old', { timestamp: epochMillis - 1 })
  const db = new DatabaseSync(f.config.dbPath)
  try {
    db.exec("CREATE TRIGGER reject_ingress_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='old' BEGIN SELECT RAISE(ABORT,'receipt failure'); END;")
    await assert.rejects(f.command('source.record', args, 'old'), /receipt failure/)
    assert.equal(await f.query({ kind: 'receipt.get', id: 'old' }), null)
    assert.deepEqual(await f.query({ kind: 'source.list' }), [])
    db.exec('DROP TRIGGER reject_ingress_receipt')
  } finally { db.close() }
  assert.equal((await f.command('source.record', args, 'old')).result.reason, 'before-ingress-epoch')
  await f.reopen()
  assert.equal((await f.command('source.record', args, 'old')).replayed, true)
  assert.deepEqual(await f.query({ kind: 'source.list' }), [])
})

test('a real process restart retains the epoch and rejection receipt without replaying old DWS history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-ingress-process-'))
  let store
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }) })
  const config = { dbPath: join(root, 'dynamic.sqlite'), instanceId: 'process', initialize: true, ingressEpoch: epoch }
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const args = source('history', { timestamp: String(epochMillis - 1000) })
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openDynamicTaskStore } from ${JSON.stringify(moduleUrl)};
    const store = await openDynamicTaskStore(${JSON.stringify(config)});
    await store.command({ id: 'history-receipt', kind: 'source.record', args: ${JSON.stringify(args)} });
    await store.command({ id: 'new-receipt', kind: 'source.record', args: ${JSON.stringify(source('new', { timestamp: epoch }))} });
    process.exit(0);
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  store = await openDynamicTaskStore({ ...config, initialize: false })
  assert.deepEqual(await store.query({ kind: 'ingress.policy' }), { instanceId: 'process', ingressEpoch: epoch })
  const repeated = await store.command({ id: 'history-receipt', kind: 'source.record', args })
  assert.equal(repeated.replayed, true)
  assert.equal(repeated.result.reason, 'before-ingress-epoch')
  const claimed = await store.command({ id: 'claim', kind: 'group.claim', args: { groupId: 'group' } })
  assert.deepEqual(claimed.result.sourceIds, ['new'])
  assert.deepEqual(await store.query({ kind: 'task.list' }), [])
  assert.deepEqual(await store.query({ kind: 'execution.list' }), [])
  assert.deepEqual(await store.query({ kind: 'notification.list' }), [])
})

test('epoch-less isolated ledger API remains available without pretending an ingress policy is enforced', async t => {
  const f = await fixture(t, { ingressEpoch: undefined })
  assert.deepEqual(await f.query({ kind: 'ingress.policy' }), { instanceId: 'epoch-test', ingressEpoch: null })
  assert.equal((await f.command('source.record', source('unit-source'))).result.source.sourceId, 'unit-source')
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'ingress.policy' }), { instanceId: 'epoch-test', ingressEpoch: null })
})
