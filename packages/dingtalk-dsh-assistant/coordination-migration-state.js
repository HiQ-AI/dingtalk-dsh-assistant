import { createHash } from 'node:crypto'

// Fixed v1 ledger contents reviewed by offline migration. Excluding the process
// owner permits an orderly close/reopen; all business rows remain in the CAS.
export const migrationLedgerTables = Object.freeze({
  dynamic_meta: { columns: 'key,value', order: 'key', where: "WHERE key<>'owner'" },
  dynamic_tasks: { columns: 'id,body', order: 'id' },
  dynamic_executions: { columns: 'id,body', order: 'id' },
  dynamic_operations: { columns: 'id,body', order: 'id' },
  dynamic_wakes: { columns: 'id,body', order: 'id' },
  dynamic_notifications: { columns: 'id,body', order: 'id' },
  dynamic_legacy_blockers: { columns: 'id,body', order: 'id' },
  dynamic_sources: { columns: 'id,body', order: 'id' },
  dynamic_groups: { columns: 'id,body', order: 'id' },
  dynamic_receipts: { columns: 'id,digest,body', order: 'id' },
  dynamic_resource_locks: { columns: 'resource_key,holder', order: 'resource_key' },
})

export function migrationStateDigest(db) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ applicationId: db.prepare('PRAGMA application_id').get().application_id,
    schemaVersion: db.prepare('PRAGMA user_version').get().user_version }))
  for (const [table, { columns, order, where = '' }] of Object.entries(migrationLedgerTables)) {
    hash.update(`\n${table}\n`)
    for (const row of db.prepare(`SELECT ${columns} FROM ${table} ${where} ORDER BY ${order}`).iterate()) hash.update(JSON.stringify(row) + '\n')
  }
  return hash.digest('hex')
}
