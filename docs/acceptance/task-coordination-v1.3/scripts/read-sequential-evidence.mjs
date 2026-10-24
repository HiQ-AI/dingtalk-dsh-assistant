import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'

const [dbPath, coordinationId, groupId] = process.argv.slice(2)
if (!dbPath || !isAbsolute(dbPath) || !coordinationId || !groupId)
  throw new Error('Usage: node read-sequential-evidence.mjs <absolute-db> <coordination-id> <group-id>')

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  db.exec('PRAGMA query_only=ON; BEGIN')
  const parse = row => row ? JSON.parse(row.body) : null
  const get = (table, id) => parse(db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id))
  const coordination = get('dynamic_coordination', coordinationId)
  if (!coordination || coordination.groupId !== groupId) throw new Error('COORDINATION_GROUP_MISMATCH')
  const members = db.prepare("SELECT body FROM dynamic_coordination_members WHERE json_extract(body,'$.coordinationId')=?")
    .all(coordinationId).map(parse)
  const taskIds = [...new Set(members.map(member => member.taskId))]
  if (!taskIds.length) throw new Error('COORDINATION_HAS_NO_TASKS')
  const slots = taskIds.map(() => '?').join(',')
  const taskRows = table => db.prepare(`SELECT body FROM ${table} WHERE json_extract(body,'$.taskId') IN (${slots})`)
    .all(...taskIds).map(parse)
  const occurrences = db.prepare("SELECT body FROM dynamic_coordination_occurrences WHERE json_extract(body,'$.coordinationId')=?")
    .all(coordinationId).map(parse)
  const jobs = occurrences.map(occurrence => get('dynamic_coordination_jobs', `job:${occurrence.id}`)).filter(Boolean)
  const receipts = db.prepare(`SELECT id,body FROM dynamic_receipts WHERE json_extract(body,'$.result.task.taskId') IN (${slots})
    OR json_extract(body,'$.result.member.taskId') IN (${slots})
    OR json_extract(body,'$.result.occurrence.coordinationId')=?`)
    .all(...taskIds, ...taskIds, coordinationId).map(row => ({ id: row.id, ...parse(row) }))
  const events = db.prepare(`SELECT sequence,body FROM dynamic_task_events WHERE json_extract(body,'$.taskId') IN (${slots}) ORDER BY sequence`)
    .all(...taskIds).map(row => ({ ...parse(row), sequence: row.sequence }))
  const notifications = db.prepare(`SELECT body FROM dynamic_notifications WHERE json_extract(body,'$.taskId') IN (${slots})
    OR json_extract(body,'$.payload.fact.coordinationId')=?`).all(...taskIds, coordinationId).map(parse)
  const sources = db.prepare("SELECT body FROM dynamic_sources WHERE json_extract(body,'$.groupId')=?")
    .all(groupId).map(parse).filter(source => members.some(member => member.command.args.sourceRefs?.includes(source.sourceId))
      || source.text?.includes('ABC1024R2'))
  const tasks = taskIds.map(id => get('dynamic_tasks', id))
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), groupId, coordination, members, tasks,
    sources, occurrences, jobs, receipts, events, executions: taskRows('dynamic_executions'),
    operations: taskRows('dynamic_operations'), notifications }, null, 2))
  db.exec('ROLLBACK')
} finally {
  db.close()
}
