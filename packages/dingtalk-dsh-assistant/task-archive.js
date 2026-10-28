// Cold task history stays in the same SQLite transaction and file as live state.
export const archiveTable = table => ({
  dynamic_tasks: 'dynamic_archived_tasks', dynamic_executions: 'dynamic_archived_executions',
  dynamic_operations: 'dynamic_archived_operations', dynamic_wakes: 'dynamic_archived_wakes',
  dynamic_notifications: 'dynamic_archived_notifications', dynamic_task_events: 'dynamic_archived_task_events',
})[table]
const owners = ['taskDecision.taskId', 'result.task.taskId', 'result.execution.taskId', 'result.operation.taskId', 'result.binding.taskId', 'result.notification.taskId']
export const receiptOwnerSql = `coalesce(${owners.map(path => `json_extract(body,'$.${path}')`).join(',')})`
const independentReceipt = owners.map(path => `(json_extract(body,'$.${path}') IS NULL OR json_extract(body,'$.${path}')=${receiptOwnerSql})`).join(' AND ')
const sharedResult = ['coordination', 'members', 'member', 'occurrence', 'schedule', 'job', 'runtime', 'source']
const ownReceipt = `${independentReceipt} AND ${sharedResult.map(key => `json_type(body,'$.result.${key}') IS NULL`).join(' AND ')}`
const fail = code => { throw Object.assign(new Error(code), { code }) }

export function installTaskArchive(db, { indexes = false } = {}) {
  for (const name of ['tasks', 'executions', 'operations', 'wakes', 'notifications', 'receipts']) {
    db.exec(`CREATE TABLE IF NOT EXISTS dynamic_archived_${name}(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)));`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS dynamic_archived_task_events(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL CHECK(json_valid(body))); CREATE INDEX IF NOT EXISTS dynamic_archived_task_events_task ON dynamic_archived_task_events(json_extract(body,'$.taskId'),sequence);
`)
  for (const name of ['executions', 'operations', 'wakes', 'notifications']) db.exec(`CREATE INDEX IF NOT EXISTS dynamic_archived_${name}_task ON dynamic_archived_${name}(json_extract(body,'$.taskId'),sequence);`)
  db.exec(`CREATE INDEX IF NOT EXISTS dynamic_archived_receipt_owner ON dynamic_archived_receipts(${receiptOwnerSql});`)
  // Existing large live ledgers build this during their explicit offline migration.
  if (indexes) db.exec(`CREATE INDEX IF NOT EXISTS dynamic_receipt_owner ON dynamic_receipts(${receiptOwnerSql}); CREATE INDEX IF NOT EXISTS dynamic_task_events_task ON dynamic_task_events(json_extract(body,'$.taskId'),sequence);`)
}

export function readReceiptRow(db, id) {
  const row = db.prepare(`SELECT r.digest,r.rowid AS sequence,r.body AS live_body,a.body AS archive_body,
    json_extract(r.body,'$.archivedTaskId') AS archived_task
    FROM dynamic_receipts r LEFT JOIN dynamic_archived_receipts a ON a.id=r.id WHERE r.id=?`).get(id)
  if (!row) return null
  if (row.archived_task && !row.archive_body) fail('DYNAMIC_ARCHIVE_RECEIPT_MISSING')
  return { digest: row.digest, sequence: row.sequence, body: row.archive_body ?? row.live_body }
}

function receiptTask(value) {
  const result = value.result ?? {}
  if (sharedResult.some(key => result[key] !== undefined)) return null
  const ids = [value.taskDecision?.taskId, result.task?.taskId, result.execution?.taskId,
    result.operation?.taskId, result.binding?.taskId, result.notification?.taskId].filter(id => id != null)
  return ids.length && ids.every(id => id === ids[0]) ? ids[0] : null
}

export function insertReceipt(db, id, digest, body, value = JSON.parse(body)) {
  const inserted = db.prepare('INSERT INTO dynamic_receipts(id,digest,body) VALUES (?,?,?)').run(id, digest, body)
  const taskId = receiptTask(value)
  if (taskId && db.prepare('SELECT 1 FROM dynamic_archived_tasks WHERE id=?').get(taskId)) {
    db.prepare('INSERT INTO dynamic_archived_receipts(id,sequence,body) VALUES (?,?,?)').run(id, Number(inserted.lastInsertRowid), body)
    const stub = { archivedTaskId: taskId }
    if (value.taskDecision) stub.taskDecision = { id: value.taskDecision.id, taskId, recordedAt: value.taskDecision.recordedAt }
    db.prepare('UPDATE dynamic_receipts SET body=? WHERE id=?').run(JSON.stringify(stub), id)
  }
  return inserted
}

export function canArchiveRecord(table, value) {
  if (table === 'dynamic_executions') return value.drained === true && ['succeeded', 'failed', 'cancelled'].includes(value.status)
  if (table === 'dynamic_operations') return ['succeeded', 'failed', 'cancelled'].includes(value.state)
  if (table === 'dynamic_wakes') return value.state === 'acked'
  if (table === 'dynamic_notifications') return ['delivered', 'failed', 'superseded'].includes(value.state)
    && (value.kind !== 'question' || value.recall?.state === 'recalled')
  return false
}

export function archiveTaskRows(db, taskId) {
  if (db.prepare('SELECT 1 FROM dynamic_archived_tasks WHERE id=?').get(taskId)) return false
  // The caller has already applied the existing archive eligibility checks and
  // archivedAt marker. No completed task is moved merely because it completed.
  db.prepare('INSERT INTO dynamic_archived_tasks(id,sequence,body) SELECT id,rowid,body FROM dynamic_tasks WHERE id=?').run(taskId)
  const eligible = {
    executions: "json_extract(body,'$.drained')=1 AND json_extract(body,'$.status') IN ('succeeded','failed','cancelled')",
    operations: "json_extract(body,'$.state') IN ('succeeded','failed','cancelled')",
    wakes: "json_extract(body,'$.state')='acked'",
    notifications: "json_extract(body,'$.state') IN ('delivered','failed','superseded') AND (json_extract(body,'$.kind')!='question' OR json_extract(body,'$.recall.state')='recalled')",
  }
  for (const [name, where] of Object.entries(eligible)) {
    db.prepare(`INSERT INTO dynamic_archived_${name}(id,sequence,body) SELECT id,rowid,body FROM dynamic_${name} WHERE json_extract(body,'$.taskId')=? AND (${where})`).run(taskId)
    db.prepare(`DELETE FROM dynamic_${name} WHERE id IN (SELECT id FROM dynamic_archived_${name} WHERE json_extract(body,'$.taskId')=?)`).run(taskId)
  }
  db.prepare(`INSERT INTO dynamic_archived_receipts(id,sequence,body) SELECT id,rowid,body FROM dynamic_receipts WHERE ${receiptOwnerSql}=? AND ${ownReceipt}`).run(taskId)
  db.prepare(`UPDATE dynamic_receipts SET body=CASE WHEN json_type(body,'$.taskDecision')='object' THEN json_object('archivedTaskId',?,'taskDecision',json_object('id',json_extract(body,'$.taskDecision.id'),'taskId',json_extract(body,'$.taskDecision.taskId'),'recordedAt',json_extract(body,'$.taskDecision.recordedAt'))) ELSE json_object('archivedTaskId',?) END WHERE id IN (SELECT id FROM dynamic_archived_receipts WHERE ${receiptOwnerSql}=?)`).run(taskId, taskId, taskId)
  db.prepare('INSERT INTO dynamic_archived_task_events(sequence,id,body) SELECT sequence,id,body FROM dynamic_task_events WHERE json_extract(body,\'$.taskId\')=?').run(taskId)
  db.prepare('DELETE FROM dynamic_task_events WHERE id IN (SELECT id FROM dynamic_archived_task_events WHERE json_extract(body,\'$.taskId\')=?)').run(taskId)
  db.prepare('DELETE FROM dynamic_tasks WHERE id=?').run(taskId)
  // Older binaries must not silently ignore physically archived tasks. This is
  // distinct from the never-deployed external-detail draft (which had no marker).
  db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('taskArchiveSchema','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
  db.exec('PRAGMA user_version=3')
  return true
}
