import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { maintenanceStatus } from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'

const fail = code => { throw Error(code) }
const indexName = 'execution_one_active_task'
const indexSql = `CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id) WHERE status NOT IN ('succeeded','failed','cancelled') AND NOT (status='waiting' AND COALESCE(recovery_reason,'')='stage-dependency')`
function version(db) {
  if (Object.values(db.prepare('PRAGMA application_id').get())[0] !== 0x44534845) fail('MIGRATION_APPLICATION_MISMATCH')
  const value = Object.values(db.prepare('PRAGMA user_version').get())[0]
  if (value !== db.prepare('SELECT schema_version FROM execution_meta WHERE singleton=1').get()?.schema_version || ![8, 9].includes(value)) fail('MIGRATION_SCHEMA_MISMATCH')
  return value
}
function integrity(db) {
  if (db.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) fail('MIGRATION_INTEGRITY_FAILED')
}
function audit(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const hash = createHash('sha256')
    for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()) {
      if (name === 'execution_meta') delete row.schema_version
      hash.update(JSON.stringify(row)); hash.update('\n')
    }
    return [name, hash.digest('hex')]
  }))
}
export function verifyExecutionDependencyIndex(db, { baseline } = {}) {
  if (version(db) !== 9) fail('MIGRATION_SCHEMA_MISMATCH')
  const index = db.prepare('PRAGMA index_list(execution_runs)').all().find(row => row.name === indexName)
  const columns = db.prepare(`PRAGMA index_info(${indexName})`).all().map(row => row.name)
  if (!index || index.unique !== 1 || index.partial !== 1 || index.origin !== 'c' || JSON.stringify(columns) !== JSON.stringify(['task_id'])) fail('MIGRATION_INDEX_MISMATCH')
  if (db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(indexName)?.sql.replace(/\s+/g, ' ').trim() !== indexSql) fail('MIGRATION_INDEX_MISMATCH')
  integrity(db)
  if (baseline && JSON.stringify(audit(db)) !== JSON.stringify(baseline)) fail('MIGRATION_DATA_CHANGED')
  return { verified: true, version: 9, indexName, columns }
}
export function migrateExecutionDependencyIndex(db, { mode } = {}) {
  if (!['check', 'execute'].includes(mode)) fail('MIGRATION_MODE_INVALID')
  const current = version(db)
  integrity(db)
  const baseline = audit(db)
  if (current === 9) return { ...verifyExecutionDependencyIndex(db), alreadyMigrated: true, writes: 0, baseline }
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(indexName)) fail('MIGRATION_INDEX_MISSING')
  const previousIndex = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(indexName).sql.replace(/\s+/g, ' ').trim()
  if (previousIndex !== "CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id) WHERE status NOT IN ('succeeded','failed','cancelled')") fail('MIGRATION_INDEX_MISMATCH')
  if (db.prepare("SELECT 1 FROM execution_runs WHERE recovery_reason='stage-dependency'").get()) fail('MIGRATION_LEGACY_DEPENDENCY_INVALID')
  if (mode === 'check') return { writes: 0, fromVersion: 8, toVersion: 9, indexName, baseline }
  const maintenance = maintenanceStatus(db)
  if (!maintenance.active || maintenance.phase !== 'stopping' || !maintenance.drained) fail('MIGRATION_REQUIRES_NATIVE_SEAL')
  if (db.prepare("SELECT 1 FROM execution_nodes WHERE status='running' OR drained=0 LIMIT 1").get()
    || db.prepare("SELECT 1 FROM task_owners WHERE status='running' OR current_turn_id IS NOT NULL LIMIT 1").get()) fail('MIGRATION_NOT_DRAINED')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (version(db) !== 8 || JSON.stringify(audit(db)) !== JSON.stringify(baseline)) fail('MIGRATION_SOURCE_CHANGED')
    db.exec(`DROP INDEX ${indexName}; ${indexSql}; PRAGMA user_version=9; UPDATE execution_meta SET schema_version=9 WHERE singleton=1`)
    verifyExecutionDependencyIndex(db, { baseline })
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return { ...verifyExecutionDependencyIndex(db, { baseline }), fromVersion: 8, toVersion: 9, baseline, backupCreated: false }
}
export function assertStoppedMigrationPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('EXPECTED_STOPPED_PID_REQUIRED')
  try { process.kill(pid, 0); fail('OLD_PROCESS_ALIVE') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, path, pid] = process.argv.slice(2)
  if (!['--check', '--execute'].includes(mode) || !isAbsolute(path ?? '')) fail('ARGUMENT_INVALID')
  let owner, db
  try {
    if (mode === '--execute') {
      assertStoppedMigrationPid(Number(pid))
      owner = new DatabaseSync(path + '.owner.sqlite'); owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    }
    db = new DatabaseSync(path, { readOnly: mode === '--check' })
    console.log(JSON.stringify(migrateExecutionDependencyIndex(db, { mode: mode.slice(2) })))
  } finally { db?.close(); if (owner) { owner.exec('ROLLBACK'); owner.close() } }
}
