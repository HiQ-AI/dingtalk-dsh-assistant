import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { checkTaskStoreIntegrity } from '../packages/dingtalk-dsh-assistant/task-store-integrity.js'
import { createStartupMetrics } from '../packages/dingtalk-dsh-assistant/startup-metrics.js'

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-startup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('explicit maintenance integrity scan keeps Host timers responsive with synthetic history', async t => {
  const dbPath = join(await directory(t), 'history.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE history(id INTEGER PRIMARY KEY, body TEXT); BEGIN')
  const insert = db.prepare('INSERT INTO history(body) VALUES (?)'), body = 'x'.repeat(8192)
  for (let i = 0; i < 4096; i++) insert.run(body)
  db.exec('COMMIT'); db.close()
  let beats = 0
  const timer = setInterval(() => beats++, 1)
  const started = performance.now()
  try { await checkTaskStoreIntegrity(dbPath) } finally { clearInterval(timer) }
  assert.ok(beats > 0, 'timers run before the complete read-only scan returns')
  t.diagnostic(JSON.stringify({ syntheticRows: 4096, payloadBytes: 4096 * body.length, integrityMs: performance.now() - started, hostTimerTicks: beats }))
})

test('corruption and foreign-key violations remain fail-closed without leaking content', async t => {
  const root = await directory(t), corrupt = join(root, 'corrupt.sqlite'), foreign = join(root, 'foreign.sqlite')
  await writeFile(corrupt, 'private-business-value')
  const db = new DatabaseSync(foreign)
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(parent REFERENCES parent(id)); INSERT INTO child VALUES (42)')
  db.close()
  for (const dbPath of [corrupt, foreign]) await assert.rejects(checkTaskStoreIntegrity(dbPath), error => {
    assert.equal(error.code, 'DYNAMIC_STORE_CORRUPT')
    assert.equal(error.message, 'DYNAMIC_STORE_CORRUPT')
    return true
  })
})

test('startup metrics cannot change semantics and normal startup does not scan history', async t => {
  const { openDynamicTaskStore } = await import('../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const samples = [], root = await directory(t)
  const options = { dbPath: join(root, 'tasks.sqlite'), instanceId: 'synthetic', initialize: true,
    startupObserver: sample => { samples.push(sample); throw new Error('observer failed') } }
  const store = await openDynamicTaskStore(options)
  await store.close()
  assert.deepEqual(samples.map(sample => sample.phase), ['task-store.recovery'])
  for (const sample of samples) {
    assert.ok(Number.isFinite(sample.durationMs) && sample.durationMs >= 0)
    assert.equal(sample.status, 'ok')
    assert.ok(!JSON.stringify(sample).includes(root))
  }
  const metrics = createStartupMetrics()
  await assert.rejects(metrics.measure('probe', async () => { throw new Error('business detail') }), /business detail/)
  assert.equal(metrics.snapshot()[0].status, 'failed')
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('business detail'))
})

test('synthetic execution history is recovered once without changing completed results', async t => {
  const { openDynamicTaskStore } = await import('../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const root = await directory(t), dbPath = join(root, 'tasks.sqlite'), options = { dbPath, instanceId: 'scale', initialize: true }
  let store = await openDynamicTaskStore(options)
  let id = 0
  const command = (kind, args) => store.command({ id: `synthetic-${id++}`, kind, args })
  await command('task.create', { taskId: 'task', request: 'Synthetic scale fixture' })
  const owner = (await command('task.claim', { taskId: 'task' })).result.binding
  const execution = (await command('execution.dispatch', { binding: owner, key: 'original', prompt: 'Synthetic inspection' })).result.execution
  const binding = (await command('execution.claim', { executionId: execution.executionId })).result.binding
  await command('execution.result', { binding, output: { completed: true } })
  await command('execution.drained', { binding })
  const completed = await store.query({ kind: 'execution.get', executionId: execution.executionId })
  await store.close()
  const db = new DatabaseSync(dbPath), insert = db.prepare('INSERT INTO dynamic_executions(id,body) VALUES (?,?)')
  db.exec('BEGIN')
  for (let i = 0; i < 512; i++) {
    const copy = { ...completed, id: `history-${i}`, executionId: `history-${i}`, key: `history-${i}`, sessionId: `history-session-${i}` }
    insert.run(copy.id, JSON.stringify(copy))
  }
  db.exec('COMMIT'); db.close()
  const samples = []
  store = await openDynamicTaskStore({ ...options, initialize: false, startupObserver: sample => samples.push(sample) })
  try {
    assert.deepEqual(await store.query({ kind: 'execution.get', executionId: completed.executionId }), completed)
    assert.equal((await store.query({ kind: 'execution.list' })).length, 513)
    assert.equal(samples.find(sample => sample.phase === 'task-store.recovery').executions, 513)
    t.diagnostic(JSON.stringify(samples))
  } finally { await store.close() }
})
