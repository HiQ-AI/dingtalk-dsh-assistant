import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { migrateExecutionEventsIndex, verifyExecutionEventsIndex, assertStoppedMigrationPid } from '../scripts/migrate-execution-events-index.mjs'
import { holdDeploymentOwnerLock } from '../docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs'

async function fixture(t, seal = true) {
  const root = await mkdtemp(join(tmpdir(), 'event-index-migration-')), path = join(root, 'control.sqlite')
  const store = await openExecutionStore({ dbPath: path, instanceId: 'migration-test', initialize: true })
  if (seal) {
    await store.command({ id: 'maintain', kind: 'runtime.maintenance.change', args: { active: true, expectedRevision: 0, maintenanceId: 'index', actorId: 'owner', reason: 'migration' } })
    await store.command({ id: 'seal', kind: 'runtime.maintenance.seal', args: { expectedRevision: 1, maintenanceId: 'index', actorId: 'owner', reason: 'migration' } })
  }
  await store.close()
  const db = new DatabaseSync(path)
  db.exec('DROP INDEX execution_events_kind_seq; PRAGMA user_version=7; UPDATE execution_meta SET schema_version=7')
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  return { path, db }
}
test('事件索引7→8 check零写，全表/自增序列保留，幂等及在线新增事件结构复核', async t => {
  const { db, path } = await fixture(t)
  const check = migrateExecutionEventsIndex(db, { mode: 'check' })
  assert.equal(check.writes, 0); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
  const readOnly = new DatabaseSync(path, { readOnly: true })
  try { assert.deepEqual(migrateExecutionEventsIndex(readOnly, { mode: 'check' }), check) } finally { readOnly.close() }
  const result = migrateExecutionEventsIndex(db, { mode: 'execute' })
  assert.deepEqual(result.baseline, check.baseline); assert.equal(result.version, 8)
  assert.equal(migrateExecutionEventsIndex(db, { mode: 'execute' }).alreadyMigrated, true)
  db.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)').run('runtime.test', '{}', 'now')
  assert.equal(verifyExecutionEventsIndex(db).verified, true)
  assert.throws(() => verifyExecutionEventsIndex(db, { baseline: check.baseline }), /DATA_CHANGED/)
})
for (const shape of ['wrong-columns', 'unique', 'partial', 'missing']) test(`schema8错误索引严格拒绝：${shape}`, async t => {
  const { db } = await fixture(t)
  migrateExecutionEventsIndex(db, { mode: 'execute' }); db.exec('DROP INDEX execution_events_kind_seq')
  if (shape === 'wrong-columns') db.exec('CREATE INDEX execution_events_kind_seq ON execution_events(seq,kind)')
  if (shape === 'unique') db.exec('CREATE UNIQUE INDEX execution_events_kind_seq ON execution_events(kind,seq)')
  if (shape === 'partial') db.exec("CREATE INDEX execution_events_kind_seq ON execution_events(kind,seq) WHERE kind='x'")
  assert.throws(() => migrateExecutionEventsIndex(db, { mode: 'check' }), /INDEX_MISMATCH/)
})
test('未封存拒绝execute、已有同名索引拒绝静默补丁、PID必须已退出', async t => {
  const { db } = await fixture(t, false)
  assert.throws(() => migrateExecutionEventsIndex(db, { mode: 'execute' }), /NATIVE_SEAL/)
  db.exec('CREATE INDEX execution_events_kind_seq ON execution_events(kind,seq)')
  assert.throws(() => migrateExecutionEventsIndex(db, { mode: 'check' }), /ALREADY_PRESENT/)
  assert.throws(() => assertStoppedMigrationPid(process.pid), /OLD_PROCESS_ALIVE/)
  assert.throws(() => assertStoppedMigrationPid(0), /STOPPED_PID_REQUIRED/)
})
test('迁移发现业务行漂移时事务回滚，版本和索引均保持schema7', async t => {
  const { db } = await fixture(t)
  const before = migrateExecutionEventsIndex(db, { mode: 'check' })
  db.exec("CREATE TRIGGER migration_corruption AFTER UPDATE OF schema_version ON execution_meta BEGIN INSERT INTO execution_events(kind,payload,created_at) VALUES('unexpected','{}','now'); END")
  assert.throws(() => migrateExecutionEventsIndex(db, { mode: 'execute' }), /DATA_CHANGED/)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
  assert.equal(db.prepare('SELECT schema_version FROM execution_meta').get().schema_version, 7)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='execution_events_kind_seq'").get(), undefined)
  assert.deepEqual(migrateExecutionEventsIndex(db, { mode: 'check' }).baseline, before.baseline)
})
test('既有部署owner锁持续持有时执行索引迁移并独立回读，冲突锁拒绝', async t => {
  const { path, db } = await fixture(t), input = new PassThrough(), lines = []
  let ready, finished
  const locked = new Promise(resolve => { ready = resolve }), migrated = new Promise(resolve => { finished = resolve })
  const run = holdDeploymentOwnerLock({ dbPath: path, input, writeLine: line => { lines.push(line); if (line === 'LOCKED') ready(); else finished() } })
  await locked
  await assert.rejects(holdDeploymentOwnerLock({ dbPath: path, input: new PassThrough(), writeLine() {} }), /locked/)
  // 该Windows不存在的PID仅作为已退出进程证据；生产脚本绑定真实封存旧PID。
  input.write(JSON.stringify({ command: 'migrate-execution-events-index', expectedStoppedPid: 2147483647 }) + '\n')
  await migrated; input.end(); await run
  const proof = JSON.parse(lines[1]); assert.equal(proof.version, 8)
  assert.equal(verifyExecutionEventsIndex(db, { baseline: proof.baseline }).verified, true)
})
