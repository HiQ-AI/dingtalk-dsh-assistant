import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { openDynamicTaskStore, ingressTimestamp } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { migrationLedgerTables, migrationStateDigest } from '../packages/dingtalk-dsh-assistant/coordination-migration-state.js'

const APPLICATION = 0x44535453
const fail = (code, detail = code) => { throw Object.assign(new Error(detail), { code }) }
const sha = value => createHash('sha256').update(value).digest('hex')
const nonterminalOperations = new Set(['succeeded','failed','cancelled'])
function inspect({ dbPath, instanceId, ingressEpoch }) {
  if (!isAbsolute(dbPath ?? '') || typeof instanceId !== 'string' || !instanceId.trim()) fail('MIGRATION_OPTIONS_INVALID')
  if (!existsSync(dbPath)) fail('MIGRATION_SOURCE_MISSING')
  const markerPath = `${dbPath}.initialized`
  if (!existsSync(markerPath)) fail('MIGRATION_MARKER_REQUIRED')
  let marker
  const markerBytes = readFileSync(markerPath)
  try { marker = JSON.parse(markerBytes.toString('utf8')) } catch { fail('MIGRATION_MARKER_INVALID') }
  if (marker.version !== 1 || marker.phase !== 'initialized' || marker.instanceId !== instanceId || !marker.initToken) fail('MIGRATION_MARKER_INVALID')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
    if (![1,2].includes(schemaVersion) || db.prepare('PRAGMA application_id').get().application_id !== APPLICATION) fail('MIGRATION_SCHEMA_INVALID')
    for (const table of Object.keys(migrationLedgerTables)) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail('MIGRATION_SCHEMA_INVALID')
    }
    if (schemaVersion === 2) {
      for (const name of ['coordination','coordination_sources','coordination_members','coordination_schedules','coordination_occurrences','coordination_slots','coordination_jobs','task_events','coordination_consumers']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`dynamic_${name}`)) fail('MIGRATION_SCHEMA_INVALID')
      }
      for (const name of ['coordination_source_unit','coordination_due','coordination_slot']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name)) fail('MIGRATION_SCHEMA_INVALID')
      }
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('MIGRATION_STORE_CORRUPT')
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM dynamic_meta').all().map(row => [row.key,row.value]))
    if (meta.instanceId !== instanceId || meta.initToken !== marker.initToken) fail('MIGRATION_IDENTITY_MISMATCH')
    const expectedEpoch = ingressEpoch === undefined ? null : ingressTimestamp(ingressEpoch, false)
    if (ingressEpoch !== undefined && !expectedEpoch) fail('MIGRATION_INGRESS_EPOCH_INVALID')
    if ((meta.ingressEpoch ?? null) !== expectedEpoch || (marker.ingressEpoch ?? null) !== expectedEpoch) fail('MIGRATION_INGRESS_EPOCH_MISMATCH')
    const records = table => db.prepare(`SELECT body FROM ${table}`).all().map(row => JSON.parse(row.body))
    const blockReasons = [], blockers = {
      tasks: records('dynamic_tasks').filter(task => !task.drained).length,
      executions: records('dynamic_executions').filter(execution => !execution.drained).length,
      groups: records('dynamic_groups').filter(group => !group.drained).length,
      operations: records('dynamic_operations').filter(operation => !nonterminalOperations.has(operation.state)).length,
      notifications: records('dynamic_notifications').filter(notification => ['starting','unknown'].includes(notification.state)).length,
    }
    let ownerAlive = false
    if (meta.owner) {
      const pid = Number(meta.owner.split(':')[0])
      if (!Number.isSafeInteger(pid) || pid < 1) fail('MIGRATION_OWNER_INVALID')
      try { process.kill(pid, 0); ownerAlive = true } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (ownerAlive) blockReasons.push('live_owner')
    }
    for (const [name,count] of Object.entries(blockers)) if (count) blockReasons.push(`unresolved_${name}`)
    const history = Object.fromEntries(Object.entries(migrationLedgerTables).map(([table,{ columns,order,where = '' }]) =>
      [table,db.prepare(`SELECT ${columns} FROM ${table} ${where} ORDER BY ${order}`).all()]))
    return { history, report: { kind: 'coordination-ledger-migration-check', dbPath, instanceId, schemaVersion,
      ingressEpoch: expectedEpoch, markerDigest: sha(markerBytes), expectedDigest: migrationStateDigest(db),
      ownerAlive, blockers, blockReasons, ready: blockReasons.length === 0,
      rowCounts: Object.fromEntries(Object.entries(history).map(([table,rows]) => [table,rows.length])) } }
  } finally { db.close() }
}

export function inspectCoordinationMigration(options) { return inspect(options).report }

function historyPreserved(before, after) {
  for (const [table, rows] of Object.entries(before)) {
    if (table === 'dynamic_meta') {
      if (rows.some(row => !after[table].some(current => current.key === row.key && current.value === row.value))) return false
      continue
    }
    const normalized = values => values.map(row => {
      if (table !== 'dynamic_executions') return row
      const body = JSON.parse(row.body)
      // v1 never attributed instruction scope; migration may only label the
      // existing input, never claim that it covered newly accepted work.
      delete body.instructionScope
      return { ...row, body: JSON.stringify(body) }
    })
    if (JSON.stringify(normalized(rows)) !== JSON.stringify(normalized(after[table]))) return false
  }
  return true
}

export async function migrateCoordinationLedger(options) {
  const before = inspect(options)
  if (!before.report.ready) fail('MIGRATION_PRECHECK_BLOCKED', before.report.blockReasons.join(','))
  if (typeof options.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedDigest)) fail('MIGRATION_EXPECTED_DIGEST_REQUIRED')
  if (before.report.expectedDigest !== options.expectedDigest) fail('DYNAMIC_MIGRATION_STATE_CHANGED')
  if (before.report.schemaVersion === 2) return { ...before.report, kind: 'coordination-ledger-migration-result', migrated: false, unchanged: true, historyPreserved: true }
  // TaskStore repeats the digest comparison inside its exclusive owner-fenced
  // migration transaction. No second writer, schema bypass or initialize path.
  const store = await openDynamicTaskStore({ dbPath: options.dbPath, instanceId: options.instanceId,
    ingressEpoch: options.ingressEpoch, initialize: false, migrate: true, migrationExpectedDigest: options.expectedDigest })
  try {
    if (store.info.version !== 2) fail('MIGRATION_SCHEMA_INVALID')
  } finally { await store.close() }
  const after = inspect(options)
  const preserved = historyPreserved(before.history, after.history) && before.report.markerDigest === after.report.markerDigest
  return { ...after.report, kind: 'coordination-ledger-migration-result', migrated: true, committed: true,
    previousDigest: before.report.expectedDigest, historyPreserved: preserved, ...(preserved ? {} : { error: 'MIGRATION_HISTORY_CHANGED' }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { db: { type: 'string' }, 'instance-id': { type: 'string' },
      'ingress-epoch': { type: 'string' }, 'expected-digest': { type: 'string' }, check: { type: 'boolean' }, execute: { type: 'boolean' } } })
    if (values.check && values.execute) fail('MIGRATION_OPTIONS_INVALID')
    const options = { dbPath: values.db, instanceId: values['instance-id'], ingressEpoch: values['ingress-epoch'], expectedDigest: values['expected-digest'] }
    const report = values.execute ? await migrateCoordinationLedger(options) : inspectCoordinationMigration(options)
    console.log(JSON.stringify(report, null, 2))
    if (!report.ready || report.historyPreserved === false) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ kind: 'coordination-ledger-migration-error', code: error.code ?? 'MIGRATION_FAILED', message: error.message }))
    process.exitCode = 1
  }
}
