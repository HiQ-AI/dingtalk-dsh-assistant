import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { installTaskOwnerSchema, validateTaskOwnerSchema } from '../packages/dingtalk-dsh-assistant/task-owner-store.js'
import { validateTaskPlanSchema } from '../packages/dingtalk-dsh-assistant/execution-task-plan.js'

const [mode, suppliedPath] = process.argv.slice(2)
if (!['--check', '--execute'].includes(mode) || !suppliedPath || process.argv.length !== 4) {
  console.error('用法: node scripts/migrate-task-owner-store.mjs --check|--execute <absolute-db-path>')
  process.exitCode = 2
} else {
  const path = resolve(suppliedPath)
  if (path !== suppliedPath || !existsSync(path) || !statSync(path).isFile())
    throw new Error('TASK_OWNER_MIGRATION_DATABASE_INVALID')
  const db = new DatabaseSync(path, { readOnly: mode === '--check' })
  let owner
  const one = sql => Object.values(db.prepare(sql).get())[0]
  const auditTable = (connection, table) => {
    const hash = createHash('sha256'), rows = connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    let count = 0
    for (const row of rows.iterate()) { hash.update(JSON.stringify(row)); hash.update('\n'); count++ }
    return { count, sha256: hash.digest('hex') }
  }
  try {
    const fromVersion = one('PRAGMA user_version')
    if (one('PRAGMA application_id') !== 0x44534845 || fromVersion !== 2
      || one('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 2)
      throw new Error('TASK_OWNER_MIGRATION_SOURCE_MISMATCH')
    if (one('PRAGMA integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('TASK_OWNER_MIGRATION_INTEGRITY_FAILED')
    for (const table of ['business_tasks', 'task_plan_stages', 'execution_runs', 'execution_effects', 'message_runs']) {
      if (!db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table))
        throw new Error('TASK_OWNER_MIGRATION_SOURCE_SCHEMA_INVALID')
    }
    const counts = {
      tasks: one('SELECT COUNT(*) FROM business_tasks'),
      runs: one('SELECT COUNT(*) FROM execution_runs'),
      unknownEffects: one("SELECT COUNT(*) FROM execution_effects WHERE state='unknown'"),
      pendingApprovals: one("SELECT COUNT(*) FROM execution_approvals WHERE decision='pending' AND revoked=0"),
    }
    const unchangedTables = ['business_tasks', 'task_plan_stages', 'execution_runs',
      'execution_effects', 'execution_approvals', 'message_runs', 'message_items']
    const baseline = Object.fromEntries(unchangedTables.map(table => [table, auditTable(db, table)]))
    if (mode === '--check') {
      console.log(JSON.stringify({ mode: 'check', path, fromVersion, toVersion: 3, ...counts,
        baseline, writes: 0 }))
    } else {
      owner = new DatabaseSync(path + '.owner.sqlite')
      owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
      // SQLite 的一致性备份包含 WAL 中已提交的行；保留唯一备份，绝不覆盖既有文件。
      const backupPath = `${path}.pre-task-owner-v3-${randomUUID()}.sqlite`
      db.prepare('VACUUM INTO ?').run(backupPath)
      const backup = new DatabaseSync(backupPath, { readOnly: true })
      try {
        for (const table of unchangedTables) if (JSON.stringify(auditTable(backup, table)) !== JSON.stringify(baseline[table]))
          throw new Error(`TASK_OWNER_MIGRATION_BACKUP_MISMATCH:${table}`)
      } finally { backup.close() }
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
      try {
        db.exec(`CREATE TABLE task_controls(task_id TEXT PRIMARY KEY,
          control_revision INTEGER NOT NULL CHECK(control_revision>0),
          state TEXT NOT NULL CHECK(state IN ('active','pausing','paused','cancelling','cancelled'))) STRICT;`)
        db.exec("INSERT INTO task_controls(task_id,control_revision,state) SELECT task_id,1,'active' FROM business_tasks")
        installTaskOwnerSchema(db)
        db.exec('PRAGMA user_version=3')
        db.prepare('UPDATE execution_meta SET schema_version=3 WHERE singleton=1').run()
        validateTaskPlanSchema(db)
        validateTaskOwnerSchema(db)
        db.exec('COMMIT')
      } catch (cause) { db.exec('ROLLBACK'); throw cause }
      if (one('PRAGMA user_version') !== 3 || one('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 3
        || one('SELECT COUNT(*) FROM task_controls') !== counts.tasks
        || one('SELECT COUNT(*) FROM execution_runs') !== counts.runs) throw new Error('TASK_OWNER_MIGRATION_READBACK_FAILED')
      for (const table of unchangedTables) if (JSON.stringify(auditTable(db, table)) !== JSON.stringify(baseline[table]))
        throw new Error(`TASK_OWNER_MIGRATION_READBACK_MISMATCH:${table}`)
      console.log(JSON.stringify({ mode: 'execute', path, fromVersion, toVersion: 3,
        ...counts, baseline, schemaReadback: 3, backupPath }))
    }
  } finally {
    db.close()
    if (owner) { try { owner.exec('ROLLBACK') } catch {} owner.close() }
  }
}
