import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateTaskOwnerSchema } from '../packages/dingtalk-dsh-assistant/task-owner-store.js'
import { validateTaskPlanSchema } from '../packages/dingtalk-dsh-assistant/execution-task-plan.js'

const [mode, suppliedPath] = process.argv.slice(2)
if (!['--check', '--execute'].includes(mode) || !suppliedPath || process.argv.length !== 4) {
  console.error('用法: node scripts/migrate-task-workflow-v4.mjs --check|--execute <absolute-db-path>')
  process.exitCode = 2
} else {
  const path = resolve(suppliedPath)
  if (path !== suppliedPath || !existsSync(path) || !statSync(path).isFile())
    throw new Error('TASK_WORKFLOW_MIGRATION_DATABASE_INVALID')
  const db = new DatabaseSync(path, { readOnly: mode === '--check' })
  const one = sql => Object.values(db.prepare(sql).get())[0]
  const audit = (connection, table) => {
    const hash = createHash('sha256')
    let count = 0
    for (const row of connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row) + '\n'); count++
    }
    return { count, sha256: hash.digest('hex') }
  }
  try {
    if (one('PRAGMA application_id') !== 0x44534845 || one('PRAGMA user_version') !== 3
      || one('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 3)
      throw new Error('TASK_WORKFLOW_MIGRATION_SOURCE_MISMATCH')
    if (one('PRAGMA integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('TASK_WORKFLOW_MIGRATION_INTEGRITY_FAILED')
    const tables = ['business_tasks', 'task_plan_stages', 'task_controls', 'task_owners',
      'task_owner_turns', 'task_events', 'execution_runs', 'execution_effects', 'execution_approvals',
      'message_items']
    for (const table of tables) if (!db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table))
      throw new Error(`TASK_WORKFLOW_MIGRATION_SOURCE_SCHEMA_INVALID:${table}`)
    const baseline = Object.fromEntries(tables.map(table => [table, audit(db, table)]))
    const counts = {
      tasks: baseline.business_tasks.count,
      zeroStageTasks: one(`SELECT COUNT(*) FROM business_tasks t WHERE NOT EXISTS
        (SELECT 1 FROM task_plan_stages s WHERE s.task_id=t.task_id AND s.plan_revision=t.plan_revision)`),
      futureStages: one(`SELECT COUNT(*) FROM task_plan_stages s JOIN business_tasks t ON t.task_id=s.task_id
        WHERE s.plan_revision=t.plan_revision AND s.status IN ('ready','waiting_confirmation','blocked')`),
      unknownEffects: one("SELECT COUNT(*) FROM execution_effects WHERE state='unknown'"),
      pendingApprovals: one("SELECT COUNT(*) FROM execution_approvals WHERE decision='pending' AND revoked=0"),
      pendingOwnerActions: one("SELECT COUNT(*) FROM task_owner_turns WHERE status='accepted' AND application_status='pending'"),
    }
    if (counts.zeroStageTasks) throw new Error('TASK_WORKFLOW_MIGRATION_SOURCE_INVARIANT')
    if (mode === '--check') console.log(JSON.stringify({ mode: 'check', path, fromVersion: 3,
      toVersion: 4, writes: 0, counts, baseline }))
    else {
      const owner = new DatabaseSync(path + '.owner.sqlite')
      try {
        owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
        const backupPath = `${path}.pre-task-workflow-v4-${randomUUID()}.sqlite`
        db.prepare('VACUUM INTO ?').run(backupPath)
        const backup = new DatabaseSync(backupPath, { readOnly: true })
        try {
          for (const table of tables) if (JSON.stringify(audit(backup, table)) !== JSON.stringify(baseline[table]))
            throw new Error(`TASK_WORKFLOW_MIGRATION_BACKUP_MISMATCH:${table}`)
        } finally { backup.close() }
        db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;')
        try {
          db.exec(`CREATE TABLE business_tasks_v4(
            task_id TEXT PRIMARY KEY,requirement_revision INTEGER NOT NULL CHECK(requirement_revision>0),
            requirement_ref TEXT,plan_revision INTEGER NOT NULL CHECK(plan_revision>=0),
            plan_requirement_revision INTEGER NOT NULL CHECK(plan_requirement_revision>=0),
            status TEXT NOT NULL CHECK(status IN ('pending','active','waiting_confirmation','succeeded','blocked')),
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
            INSERT INTO business_tasks_v4(task_id,requirement_revision,requirement_ref,plan_revision,plan_requirement_revision,status,created_at,updated_at)
              SELECT task_id,requirement_revision,NULL,plan_revision,requirement_revision,status,created_at,updated_at FROM business_tasks ORDER BY rowid;
            DROP TABLE business_tasks;
            ALTER TABLE business_tasks_v4 RENAME TO business_tasks;
            PRAGMA user_version=4;
            UPDATE execution_meta SET schema_version=4 WHERE singleton=1;`)
          validateTaskPlanSchema(db)
          validateTaskOwnerSchema(db)
          if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('TASK_WORKFLOW_MIGRATION_FOREIGN_KEY_FAILED')
          db.exec('COMMIT')
        } catch (cause) { db.exec('ROLLBACK'); throw cause }
        db.exec('PRAGMA foreign_keys=ON;')
        if (one('PRAGMA user_version') !== 4 || one('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 4
          || one('PRAGMA integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('TASK_WORKFLOW_MIGRATION_READBACK_FAILED')
        for (const table of tables.filter(table => table !== 'business_tasks'))
          if (JSON.stringify(audit(db, table)) !== JSON.stringify(baseline[table]))
            throw new Error(`TASK_WORKFLOW_MIGRATION_READBACK_MISMATCH:${table}`)
        console.log(JSON.stringify({ mode: 'execute', path, fromVersion: 3, toVersion: 4,
          counts, backupPath, schemaReadback: 4 }))
      } finally { try { owner.exec('ROLLBACK') } catch {} owner.close() }
    }
  } finally { db.close() }
}
