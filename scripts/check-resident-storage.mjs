import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'

// v7 可选扩展无需数据重写。只读预检与 v6→v7 迁移脚本分开，避免误用写入路径。
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function removedFields(source, parsed) {
  if (Array.isArray(source)) return source.reduce((count, value, index) => count + removedFields(value, parsed?.[index]), 0)
  if (!record(source)) return 0
  return Object.entries(source).reduce((count, [key, value]) => count + (Object.hasOwn(parsed ?? {}, key) ? removedFields(value, parsed[key]) : 1), 0)
}

export function checkResidentStorage(document) {
  const output = { ok: true, mode: 'read-only', domainVersion: residentDomainSpec.version, tableCounts: {}, invalidRecords: 0, strippedFields: 0, unknownTables: 0, issueCodes: {}, extensions: { activityProjection: 0, stagePlan: 0, coordinationRequests: 0, reportEvents: 0 } }
  const issue = code => { output.ok = false; output.issueCodes[code] = (output.issueCodes[code] ?? 0) + 1 }
  if (document?.unit?.name !== residentDomainSpec.name || document?.unit?.version !== residentDomainSpec.version || !record(document.tables)) {
    issue('current_domain_required')
    return output
  }
  for (const table of Object.keys(document.tables)) if (!Object.hasOwn(residentDomainSpec.tables, table)) { output.unknownTables += 1; issue('unknown_table') }
  for (const [table, definition] of Object.entries(residentDomainSpec.tables)) {
    const rows = document.tables[table] ?? {}
    if (!record(rows)) { issue('invalid_table_shape'); continue }
    output.tableCounts[table] = Object.keys(rows).length
    for (const value of Object.values(rows)) {
      const parsed = definition.valueSchema.safeParse(value)
      if (!parsed.success) {
        output.invalidRecords += 1
        for (const error of parsed.error.issues) issue(error.code)
        continue
      }
      const removed = removedFields(value, parsed.data)
      output.strippedFields += removed
      if (removed) issue('schema_would_strip_fields')
      if (table === 'tasks') {
        if (value.activityProjection) output.extensions.activityProjection += 1
        if (value.stagePlan) output.extensions.stagePlan += 1
        output.extensions.reportEvents += (value.executionEvents ?? []).filter(event => ['task-report-received', 'task-report-settled', 'task-report-notified'].includes(event.kind)).length
      }
      if (table === 'groups') output.extensions.coordinationRequests += Object.keys(value.coordinationRequests ?? {}).length
    }
  }
  return output
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, source: { type: 'string' } }, allowPositionals: false })
  if (!values.check || !values.source) throw new Error('check_and_source_required')
  let document
  try { document = JSON.parse(await readFile(values.source, 'utf8')) } catch { throw new Error('source_read_or_json_invalid') }
  const output = checkResidentStorage(document)
  console.log(JSON.stringify(output))
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, mode: 'read-only', code: ['check_and_source_required', 'source_read_or_json_invalid'].includes(error.message) ? error.message : 'check_failed' })); process.exitCode = 1 })
}
