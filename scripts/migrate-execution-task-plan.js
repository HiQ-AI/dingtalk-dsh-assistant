import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
// 历史 v2 schema 固定于此；不能调用随后新增控制表的当前安装器。
function installV2TaskPlan(db) {
  db.exec(`CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY,
    requirement_revision INTEGER NOT NULL CHECK(requirement_revision>0),
    plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
    status TEXT NOT NULL CHECK(status IN ('active','waiting_confirmation','succeeded','blocked')),
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE task_plan_stages(task_id TEXT NOT NULL REFERENCES business_tasks(task_id),
      plan_revision INTEGER NOT NULL CHECK(plan_revision>0),stage_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position>=0),workflow_id TEXT NOT NULL,
      workflow_digest TEXT,unavailable_reason TEXT,requirement_ref TEXT,predecessor_output_ref TEXT,
      gate TEXT NOT NULL CHECK(gate IN ('none','confirmation')),
      status TEXT NOT NULL CHECK(status IN ('ready','waiting_confirmation','running','succeeded','invalidated','blocked')),
      attempt INTEGER NOT NULL CHECK(attempt>0),run_id TEXT,
      output_ref TEXT,evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
      confirmed_output_ref TEXT,
      PRIMARY KEY(task_id,plan_revision,stage_id),UNIQUE(task_id,plan_revision,position),
      UNIQUE(task_id,plan_revision,run_id)) STRICT;
    CREATE INDEX task_plan_stages_current ON task_plan_stages(task_id,plan_revision,status);`)
}
function validateV2TaskPlan(db) {
  db.prepare('SELECT task_id,requirement_revision,plan_revision,status FROM business_tasks LIMIT 0').all()
  db.prepare('SELECT task_id,plan_revision,stage_id,workflow_id,status FROM task_plan_stages LIMIT 0').all()
  if (db.prepare(`SELECT t.task_id FROM business_tasks t
    LEFT JOIN task_plan_stages s ON s.task_id=t.task_id AND s.plan_revision=t.plan_revision
    GROUP BY t.task_id HAVING COUNT(s.stage_id)=0 LIMIT 1`).get()) throw new Error('TASK_PLAN_INVARIANT_FAILED')
}

const args = process.argv.slice(2)
if (args.length !== 2 || !['--check', '--execute'].includes(args[0])) {
  console.error('用法: node scripts/migrate-execution-task-plan.js --check|--execute <absolute-db-path>')
  process.exitCode = 2
} else {
  const path = resolve(args[1])
  if (path !== args[1] || !existsSync(path) || !statSync(path).isFile()) throw new Error('MIGRATION_DATABASE_INVALID')
  const db = new DatabaseSync(path, { readOnly: args[0] === '--check' })
  let owner
  try {
    const one = sql => Object.values(db.prepare(sql).get())[0]
    const version = one('PRAGMA user_version')
    const applicationId = one('PRAGMA application_id')
    if (applicationId !== 0x44534845 || ![1, 2].includes(version)) throw new Error('MIGRATION_SOURCE_MISMATCH')
    if (one('PRAGMA integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('MIGRATION_INTEGRITY_FAILED')
    const taskCount = one('SELECT COUNT(*) FROM execution_runs')
    if (args[0] === '--check') {
      console.log(JSON.stringify({ mode: 'check', path, fromVersion: version, toVersion: 2, executionRuns: taskCount, writable: false }))
    } else {
      owner = new DatabaseSync(path + '.owner.sqlite')
      owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
      const backupPath = version === 1 ? `${path}.pre-task-plan-v2-${randomUUID()}.sqlite` : null
      if (backupPath) db.prepare('VACUUM INTO ?').run(backupPath)
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
      try {
        if (version === 1) {
          installV2TaskPlan(db)
          db.exec('PRAGMA user_version=2')
          db.prepare('UPDATE execution_meta SET schema_version=2 WHERE singleton=1').run()
        }
        validateV2TaskPlan(db)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      if (one('PRAGMA user_version') !== 2 || one('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 2) throw new Error('MIGRATION_READBACK_FAILED')
      console.log(JSON.stringify({ mode: 'execute', path, fromVersion: version, toVersion: 2, executionRuns: taskCount, schemaReadback: 2, backupPath }))
    }
  } finally {
    db.close()
    if (owner) { try { owner.exec('ROLLBACK') } catch {} owner.close() }
  }
}
