import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { installTaskPlanSchema, validateTaskPlanSchema } from '../packages/dingtalk-dsh-assistant/execution-task-plan.js'

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
          installTaskPlanSchema(db)
          db.exec('PRAGMA user_version=2')
          db.prepare('UPDATE execution_meta SET schema_version=2 WHERE singleton=1').run()
        }
        validateTaskPlanSchema(db)
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
