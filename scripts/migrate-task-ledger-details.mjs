import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTaskLedgerDetails, detailTables } from '../packages/dingtalk-dsh-assistant/task-ledger-details.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const defaultRoot = path => basename(dirname(path)) === '.dsh' ? dirname(dirname(path)) : dirname(path)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Offline, copy-on-write conversion. Source is immutable, destination is new;
// rollback is selecting the original DB + its original detail root. Never delete
// source rows, checkpoint/vacuum a live DB, or switch production configuration.
export async function migrateTaskLedgerDetails({ source, destination, detailRoot, sourceDetailRoot,
  offline = false, resume = false, maxRows = 1000, batchSize = 50, maxMilliseconds = 30000 } = {}) {
  if (!offline) fail('DETAIL_MIGRATION_OFFLINE_REQUIRED')
  if (![source, destination, detailRoot].every(p => isAbsolute(p ?? ''))
    || !Number.isSafeInteger(maxMilliseconds) || maxMilliseconds < 1 || maxMilliseconds > 300000
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) fail('DETAIL_MIGRATION_ARGUMENT_INVALID')
  source = resolve(source); destination = resolve(destination)
  if (relative(dirname(destination), realpathSync(dirname(destination))) !== '') fail('DETAIL_MIGRATION_DESTINATION_INVALID')
  if (realpathSync(source) === (existsSync(destination) ? realpathSync(destination) : destination)) fail('DETAIL_MIGRATION_SOURCE_EQUALS_DESTINATION')
  if (existsSync(source + '-wal') && lstatSync(source + '-wal').size !== 0) fail('DETAIL_MIGRATION_SOURCE_WAL_PRESENT')
  const sourceStat = lstatSync(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('DETAIL_MIGRATION_SOURCE_INVALID')
  const input = new DatabaseSync(pathToFileURL(source).href + '?mode=ro&immutable=1', { readOnly: true })
  let output, target, original
  try {
    if (![2,3].includes(input.prepare('PRAGMA user_version').get().user_version)) fail('DETAIL_MIGRATION_SCHEMA_INVALID')
    if (input.prepare('PRAGMA application_id').get().application_id !== 0x44535453) fail('DETAIL_MIGRATION_SCHEMA_INVALID')
    const meta = Object.fromEntries(input.prepare('SELECT key,value FROM dynamic_meta WHERE key IN (\'instanceId\',\'initToken\',\'ingressEpoch\')').all().map(r => [r.key,r.value]))
    if (!meta.instanceId || !meta.initToken) fail('DETAIL_MIGRATION_IDENTITY_MISSING')
    const identity = digest({ source, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, meta, sourceDetailRoot: resolve(sourceDetailRoot ?? defaultRoot(source)) })
    const schema = input.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()
    const tables = schema.filter(r => r.type === 'table' && r.name !== 'dynamic_meta').map(r => r.name)
    if (schema.some(r => /CREATE VIRTUAL TABLE|WITHOUT ROWID/i.test(r.sql))) fail('DETAIL_MIGRATION_SCHEMA_UNSUPPORTED')
    const quote = name => '"' + name.replaceAll('"','""') + '"'
    if (existsSync(destination) && (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink())) fail('DETAIL_MIGRATION_DESTINATION_INVALID')
    if (existsSync(destination) && !resume) fail('DETAIL_MIGRATION_DESTINATION_EXISTS')
    if (!existsSync(destination)) {
      // Build an empty control database, rather than copying 9 GB of payload pages
      // and leaving a same-size freelist behind. No VACUUM or source mutation.
      writeFileSync(destination, '', { flag: 'wx' })
      output = new DatabaseSync(destination)
      output.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      try {
        output.exec('PRAGMA application_id=1146311763; PRAGMA user_version=3')
        for (const entry of schema.filter(r => r.type === 'table')) output.exec(entry.sql)
        for (const row of input.prepare("SELECT rowid,key,value FROM dynamic_meta WHERE key NOT IN ('owner','detailMigration')").all())
          output.prepare('INSERT INTO dynamic_meta(rowid,key,value) VALUES (?,?,?)').run(row.rowid,row.key,row.value)
        output.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('detailMigration',?)").run(JSON.stringify({ identity, detailRoot: resolve(detailRoot), table: 0, rowid: 0, complete: false }))
        output.exec('COMMIT')
      } catch (e) { output.exec('ROLLBACK'); throw e }
    } else output = new DatabaseSync(destination)
    target = createTaskLedgerDetails(detailRoot); original = createTaskLedgerDetails(sourceDetailRoot ?? defaultRoot(source))
    const stateRow = output.prepare("SELECT value FROM dynamic_meta WHERE key='detailMigration'").get()
    if (!stateRow) fail('DETAIL_MIGRATION_NOT_RESUMABLE')
    const state = JSON.parse(stateRow.value)
    if (state.identity !== identity || state.detailRoot !== resolve(detailRoot)) fail('DETAIL_MIGRATION_INPUT_CHANGED')
    if (output.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value) fail('DETAIL_MIGRATION_DESTINATION_IN_USE')
    if (state.complete) return { converted: 0, complete: true, nextTable: null, nextRowid: state.rowid }
    let converted = 0
    const deadline = Date.now() + maxMilliseconds
    while (!state.complete && converted < maxRows && Date.now() < deadline) {
      const current = lstatSync(source)
      if (current.size !== sourceStat.size || current.mtimeMs !== sourceStat.mtimeMs) fail('DETAIL_MIGRATION_INPUT_CHANGED')
      const table = tables[state.table]
      if (!table) { state.complete = true; break }
      const rows = input.prepare(`SELECT rowid AS _migrationRowid,* FROM ${quote(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`)
        .all(state.rowid, Math.min(batchSize, maxRows - converted))
      if (!rows.length) { state.table++; state.rowid = 0; continue }
      output.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) {
          if (Date.now() >= deadline) break
          const { _migrationRowid, ...values } = row
          if (!Number.isSafeInteger(_migrationRowid)) fail('DETAIL_MIGRATION_ROWID_INVALID')
          if (detailTables.includes(table)) {
            const value = original.decode(JSON.parse(row.body), { table, id: row.id })
            const body = target.encode(table, value, { id: row.id })
            values.body = JSON.stringify(body)
            state.sourceBodyBytes = (state.sourceBodyBytes ?? 0) + Buffer.byteLength(row.body)
            state.targetBodyBytes = (state.targetBodyBytes ?? 0) + Buffer.byteLength(values.body)
          }
          // All local objects commit before publishing the compact row and its
          // cursor in one control transaction. Orphans are invisible and reusable.
          const columns = Object.keys(values)
          output.prepare(`INSERT INTO ${quote(table)}(rowid,${columns.map(quote).join(',')}) VALUES (${Array(columns.length+1).fill('?').join(',')})`)
            .run(_migrationRowid,...Object.values(values))
          state.rowid = _migrationRowid; converted++
          state.counts ??= {}; state.counts[table] = (state.counts[table] ?? 0) + 1
        }
        output.prepare("UPDATE dynamic_meta SET value=? WHERE key='detailMigration'").run(JSON.stringify(state))
        output.exec('COMMIT')
      } catch (e) { output.exec('ROLLBACK'); throw e }
    }
    if (state.complete) {
      output.exec('BEGIN IMMEDIATE')
      try {
        for (const entry of schema.filter(r => r.type !== 'table')) output.exec(entry.sql)
        if (input.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
          for (const row of input.prepare('SELECT name,seq FROM sqlite_sequence').all()) {
            output.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name)
            output.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(row.name,row.seq)
          }
        }
        output.prepare("UPDATE dynamic_meta SET value=? WHERE key='detailMigration'").run(JSON.stringify(state))
        output.exec('COMMIT')
      } catch(e) {output.exec('ROLLBACK');throw e}
    } else output.prepare("UPDATE dynamic_meta SET value=? WHERE key='detailMigration'").run(JSON.stringify(state))
    // A partially converted copy must never be opened by the runtime.
    if (state.complete && !existsSync(destination + '.initialized')) writeFileSync(destination + '.initialized', JSON.stringify({ version: 1,
      instanceId: meta.instanceId, initToken: meta.initToken, phase: 'initialized', ingressEpoch: meta.ingressEpoch ?? null }), { flag: 'wx', mode: 0o600 })
    return { converted, complete: state.complete, counts: state.counts ?? {}, sourceBodyBytes: state.sourceBodyBytes ?? 0, targetBodyBytes: state.targetBodyBytes ?? 0, nextTable: tables[state.table] ?? null, nextRowid: state.rowid }
  } finally { target?.close(); original?.close(); output?.close(); input.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), get = key => args[args.indexOf(key) + 1]
  try {
    const result = await migrateTaskLedgerDetails({ source: get('--source'), destination: get('--destination'), detailRoot: get('--detail-root'),
      sourceDetailRoot: args.includes('--source-detail-root') ? get('--source-detail-root') : undefined,
      offline: args.includes('--offline'), resume: args.includes('--resume'), maxRows: args.includes('--max-rows') ? Number(get('--max-rows')) : 1000 })
    console.log(JSON.stringify(result))
  } catch (e) { console.error(e.code ?? e.message); process.exitCode = 1 }
}
