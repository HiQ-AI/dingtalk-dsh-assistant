import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { residentDomainSpec as v8 } from '../packages/dingtalk-dsh-assistant/storage-v8-schema.js'
import { fingerprint, stableId } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { legacyPlanCandidate } from '../packages/dingtalk-dsh-assistant/task-plan.js'

const DOMAIN = 'dingtalk_dsh_assistant'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function stripped(source, parsed) {
  if (Array.isArray(source)) return source.some((value, index) => stripped(value, parsed?.[index]))
  if (!record(source)) return false
  return Object.entries(source).some(([key, value]) => !Object.hasOwn(parsed ?? {}, key) || stripped(value, parsed[key]))
}
function terminalOutcome(task, group) {
  const cancelled = group?.topics.some(topic => topic.decisions.some(decision => decision.operations.some(operation => {
    const action = decision.decision.actions?.[operation.actionIndex]
    return operation.status === 'applied' && task.appliedOperations?.includes(operation.operationId) && action?.kind === 'task-cancel' && action.taskId === task.taskId && action.runSequence === task.runSequence && action.inputVersion + 1 === task.inputVersion
  })))
    || task.executionEvents?.some(event => event.kind === 'task-cancelled' && event.runSequence === task.runSequence)
  if (cancelled) return 'cancelled'
  const result = task.result
  if (result?.status === 'completed' && result.inputVersion === task.inputVersion && result.runSequence === task.runSequence && task.executionEvents?.some(event => event.kind === 'task-completed' && event.inputVersion === result.inputVersion && event.runSequence === result.runSequence)) return 'succeeded'
  return 'legacy-unknown'
}

export function planWorkflowMigration(document) {
  if (document?.unit?.name !== DOMAIN || document.unit.version !== 8 || !record(document.tables)) throw new Error('migration_source_must_be_v8_json_unit')
  const output = structuredClone(document), issues = []
  const issue = (type, table, key) => issues.push({ type, table, key })
  for (const table of Object.keys(document.tables)) if (!Object.hasOwn(v8.tables, table)) issue('unknown-table', table)
  for (const [table, declaration] of Object.entries(v8.tables)) {
    const rows = document.tables[table] ?? {}
    if (!record(rows)) { issue('invalid-table', table); continue }
    for (const [key, value] of Object.entries(rows)) {
      const parsed = declaration.valueSchema.safeParse(value)
      if (!parsed.success) issue('invalid-source-record', table, key)
      else if (stripped(value, parsed.data)) issue('source-schema-would-strip-fields', table, key)
    }
  }
  const report = { ready: false, sourceVersion: 8, targetVersion: 9, counts: { tasks: 0, reviewRequired: 0, succeeded: 0, cancelled: 0, legacyUnknown: 0 }, issues }
  if (issues.length) return { document: output, report }
  for (const [key, group] of Object.entries(output.tables.groups ?? {})) {
    if (group.topics.some(topic => topic.decisions.some(decision => !['completed', 'rejected'].includes(decision.status)))) issue('unreconciled-decision', 'groups', key)
    if (group.taskReservations.length) issue('unreconciled-reservation', 'groups', key)
    if (group.outbox.some(item => item.status === 'pending' || item.recallStatus === 'requested')) issue('unreconciled-outbound', 'groups', key)
    for (const request of Object.values(group.coordinationRequests ?? {})) if (['pending', 'exhausted'].includes(request.status)) {
      request.status = 'superseded'; request.supersedeReason = 'workflow-contract-v9-cutover'; delete request.nextRetryAt
    }
  }
  for (const [key, scheduler] of Object.entries(output.tables.scheduler ?? {})) if (scheduler.tasks.length) issue('embedded-task-snapshot-requires-reconciliation', 'scheduler', key)
  for (const [key, task] of Object.entries(output.tables.tasks ?? {})) {
    report.counts.tasks++
    if (task.humanBlocker && ['pending-send', 'waiting-reply'].includes(task.humanBlocker.status)) issue('unreconciled-human-blocker', 'tasks', key)
    const group = Object.values(output.tables.groups ?? {}).find(group => group.groupId === task.groupId)
    if (!group) { issue('missing-group', 'tasks', key); continue }
    task.runHistory = (task.runHistory ?? []).map(run => ({ ...run, outcome: 'legacy-unknown' }))
    if (task.state === 'completed') {
      task.outcome = terminalOutcome(task, group)
      report.counts[task.outcome === 'legacy-unknown' ? 'legacyUnknown' : task.outcome]++
    } else {
      const snapshot = structuredClone(document.tables.tasks[key])
      const reason = 'v8 活动任务尚未确认结构化计划、来源及证据；禁止自动继续执行'
      task.migrationReview = { status: 'required', reason, candidate: legacyPlanCandidate(snapshot) }
      task.executionEvents = [...(task.executionEvents ?? []), { kind: 'workflow-v9-migration', at: task.updatedAt, snapshot }]
      task.inputVersion++
      task.childSessionId = stableId('session-migration-review', `${task.taskId}:${task.runSequence}:${task.inputVersion}`)
      task.state = 'waiting'; task.waitingKind = 'system'; task.waitingReason = reason
      task.stateHistory = [...(task.stateHistory ?? []), { state: 'waiting', waitingKind: 'system', at: task.updatedAt, runSequence: task.runSequence ?? 1 }]
      task.contractVersion = 2
      report.counts.reviewRequired++
    }
  }
  output.unit.version = 9
  output.global ??= null
  for (const [table, declaration] of Object.entries(residentDomainSpec.tables)) {
    output.tables[table] ??= {}
    for (const [key, value] of Object.entries(output.tables[table])) {
      const parsed = declaration.valueSchema.safeParse(value)
      if (!parsed.success) issue('invalid-target-record', table, key)
      else if (stripped(value, parsed.data)) issue('target-schema-would-strip-fields', table, key)
      else output.tables[table][key] = parsed.data
    }
  }
  report.ready = issues.length === 0
  return { document: output, report }
}
export async function migrateWorkflowStorage({ source, target, check = false }) {
  const sourcePath = await realpath(resolve(source)), targetPath = resolve(target)
  if (sourcePath.toLowerCase() === targetPath.toLowerCase() || basename(targetPath) !== `${DOMAIN}.json`) throw new Error('migration_target_must_be_independent_domain_file')
  try {
    const targetReal = await realpath(targetPath)
    if (targetReal.toLowerCase() === sourcePath.toLowerCase()) throw new Error('migration_source_target_alias')
    const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetReal)])
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) throw new Error('migration_source_target_alias')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const sourceText = await readFile(sourcePath, 'utf8')
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex')
  const plan = planWorkflowMigration(JSON.parse(sourceText))
  plan.report.sourceSha256 = sourceSha256
  const existing = await stat(targetPath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (existing) {
    throw new Error('migration_target_exists_choose_new_directory')
  }
  if (check) return plan.report
  if (!plan.report.ready) throw new Error(`migration_check_failed:${JSON.stringify(plan.report.issues)}`)
  await mkdir(dirname(targetPath), { recursive: true })
  const targetHandle = await open(targetPath, 'wx', 0o600)
  try {
    await targetHandle.writeFile(`${JSON.stringify(plan.document, null, 2)}\n`, 'utf8')
    await targetHandle.sync()
  } finally {
    await targetHandle.close()
  }
  const backend = new JsonStorageBackend(dirname(targetPath))
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => backend } } }, { backend: 'json' })
  try {
    const reopened = await facility.open(residentDomainSpec)
    for (const [table, records] of Object.entries(plan.document.tables)) {
      if (fingerprint(Object.fromEntries(reopened.table(table).entries())) !== fingerprint(records)) throw new Error(`migration_readback_mismatch:${table}`)
    }
    await reopened.close()
    if (await readFile(sourcePath, 'utf8') !== sourceText) throw new Error('migration_source_changed_during_run')
    return { ...plan.report, written: true, verified: true, sourceUnchanged: true }
  } finally { await facility.closeAll(); await backend.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' }, check: { type: 'boolean', default: false } }, strict: true })
    if (!values.source || !values.target) throw new Error('usage: node scripts/migrate-workflow-storage.mjs --source <v8-unit.json> --target <independent-root/dingtalk_dsh_assistant.json> [--check]')
    const report = await migrateWorkflowStorage(values)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ready) process.exitCode = 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
