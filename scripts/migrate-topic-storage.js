import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { taskResultSchema } from '../packages/dingtalk-dsh-assistant/task-result.js'
import { stableId, fingerprint, validateTopicRefs } from '../packages/dingtalk-dsh-assistant/topic-model.js'

const DOMAIN = 'dingtalk_dsh_assistant'
const isSynthetic = (id) => /^(?:web(?:-reopen)?:|recovery:)/u.test(id ?? '')
const withVersion = (result, runSequence) => result ? { ...result, inputVersion: 1, runSequence } : undefined
const stripSource = ({ sourceMessageId, sourceMessageIds, triggerHistory, messageHistory, relatedContexts, ...rest }) => rest

// 只接受已核验的 SDK JSON unit 形态，不猜 profile 路径或修改原介质。
export function planTopicMigration(document) {
  if (document?.unit?.name !== DOMAIN || document.unit.version !== 6 || !document.tables || Array.isArray(document.tables)) throw new Error('migration_source_must_be_v6_json_unit')
  const output = structuredClone(document)
  output.unit.version = residentDomainSpec.version
  output.global ??= null
  const issues = [], mappings = []
  for (const table of Object.keys(document.tables)) if (!(table in residentDomainSpec.tables)) issues.push({ type: 'unknown-table', table })
  const groupById = new Map()
  for (const [key, group] of Object.entries(output.tables.groups ?? {})) {
    if (groupById.has(group.groupId)) issues.push({ type: 'duplicate-group', groupId: group.groupId })
    groupById.set(group.groupId, group)
    Object.assign(group, { topics: [], routingRevision: 0, routeHistory: [], taskReservations: [] })
    const known = new Set()
    group.messages = group.messages.map((message) => {
      if (known.has(message.messageId)) issues.push({ type: 'duplicate-message', groupId: group.groupId, messageId: message.messageId })
      known.add(message.messageId)
      if (message.agentDeliveryStatus === 'decision-commit-failed') issues.push({ type: 'unreconciled-commit', groupId: group.groupId, messageId: message.messageId })
      return { ...message, messageVersion: 1, facts: [], sourceKind: 'dingtalk', routingStatus: ['delivered', 'skipped'].includes(message.agentDeliveryStatus) ? 'routed' : 'pending' }
    })
    group.nextSequence = Math.max(group.nextSequence, ...group.messages.map((message) => message.sequence + 1), 1)
  }
  const sourceTasks = new Map(Object.entries(output.tables.tasks ?? {}).map(([key, task]) => [task.taskId, { key, task }]))
  for (const task of output.tables.scheduler?.runtime?.tasks ?? []) {
    // tasks 表是已有独立任务的权威位置，scheduler 是旧快照，仅补不存在项。
    if (!sourceTasks.has(task.taskId)) sourceTasks.set(task.taskId, { key: task.taskId, task })
  }
  output.tables.tasks = {}
  for (const [taskId, { key, task }] of sourceTasks) {
    const group = groupById.get(task.groupId)
    if (!group) { issues.push({ type: 'missing-group', taskId, groupId: task.groupId }); continue }
    const topicId = stableId('topic', `migration-v6:${task.groupId}:${taskId}`)
    const at = task.createdAt
    const topic = { topicId, groupId: task.groupId, title: task.title ?? task.objective.slice(0, 120), revision: 0, processedRevision: 0, status: 'active', summary: '', summaryRevision: 0, openQuestions: [], entries: [], decisions: [], createdAt: at, updatedAt: task.updatedAt, migrationBaseline: true }
    const append = (message) => {
      if (topic.entries.some((entry) => entry.messageId === message.messageId)) return
      topic.revision += 1
      topic.entries.push({ revision: topic.revision, messageId: message.messageId, messageVersion: 1, action: 'add', reason: 'migration-baseline' })
    }
    const sources = [...new Set([task.sourceMessageId, ...(task.triggerHistory ?? []).map((item) => item.sourceMessageId), ...(task.messageHistory ?? []).map((item) => item.messageId), ...(task.runHistory ?? []).map((item) => item.sourceMessageId), ...(task.objectiveHistory ?? []).map((item) => item.sourceMessageId)].filter(Boolean))]
    for (const messageId of sources) {
      if (isSynthetic(messageId)) continue
      let message = group.messages.find((item) => item.messageId === messageId)
      const copies = (task.messageHistory ?? []).filter((item) => item.messageId === messageId)
      const compareFields = ['text', 'senderName', 'senderOpenDingTalkId', 'occurredAt']
      for (const copy of copies) {
        const reference = message ?? copies[0]
        if (compareFields.some((field) => reference[field] !== undefined && copy[field] !== undefined && reference[field] !== copy[field])) issues.push({ type: 'conflicting-message-copy', taskId, messageId })
      }
      if (!message && copies.length) {
        const copy = copies[0]
        message = { messageId, sequence: group.nextSequence++, text: copy.text, occurredAt: copy.occurredAt ?? at, ...(copy.senderName ? { senderName: copy.senderName } : {}), ...(copy.senderOpenDingTalkId ? { senderOpenDingTalkId: copy.senderOpenDingTalkId } : {}),
          ...(copy.quotedMessageId ? { quotedMessage: { messageId: copy.quotedMessageId, content: '' } } : {}), messageVersion: 1, facts: [], sourceKind: 'migration', migrationSource: `task:${taskId}:messageHistory`, routingStatus: 'routed', agentDeliveryStatus: 'delivered' }
        group.messages.push(message)
      }
      if (!message) issues.push({ type: 'missing-message', taskId, messageId })
      else append(message)
    }
    const addInternal = (text, label, kind = 'internal') => {
      const message = { messageId: stableId('input', `migration-v6:${taskId}:${label}`), sequence: group.nextSequence++, text, occurredAt: at,
        messageVersion: 1, facts: [], sourceKind: kind, migrationSource: `task:${taskId}:${label}`, routingStatus: 'routed', agentDeliveryStatus: 'delivered' }
      group.messages.push(message); append(message)
    }
    for (const [index, text] of (task.relatedContexts ?? []).entries()) addInternal(text, `related-context:${index}`)
    if (!topic.entries.length) addInternal(task.objective, 'execution-baseline', sources.some((id) => id.startsWith('web')) ? 'web' : 'internal')
    topic.processedRevision = topic.revision
    group.topics.push(topic)
    const topicRefs = [{ topicId, revision: topic.revision }]
    const runSequence = task.runSequence ?? (task.completionSequence ?? 0) + 1
    const versionCheckpoints = (values, run) => values?.map((checkpoint) => ({ ...checkpoint, inputVersion: 1, runSequence: run }))
    const migrated = { ...stripSource(task), topicRefs, inputVersion: 1, appliedOperations: [], runSequence,
      runStartedAt: task.runStartedAt ?? task.createdAt, acceptanceCriteria: task.acceptanceCriteria?.length ? task.acceptanceCriteria : [task.objective], stageTasks: task.stageTasks?.length ? task.stageTasks : ['完成并验证当前轮目标'],
      checkpoints: versionCheckpoints(task.checkpoints, runSequence),
      runHistory: (task.runHistory ?? []).map((run) => ({ ...stripSource(run), topicRefs, inputVersion: 1, result: withVersion(run.result, run.runSequence), checkpoints: versionCheckpoints(run.checkpoints, run.runSequence) })),
      objectiveHistory: task.objectiveHistory?.map((entry) => ({ ...stripSource(entry), topicRefs, inputVersion: 1 })),
      ...Object.fromEntries(['result', 'lastWaitingResult', 'lastCompletedResult'].filter((field) => task[field]).map((field) => [field, withVersion(task[field], runSequence)])) }
    output.tables.tasks[key] = migrated
    mappings.push({ taskId, topicId, baselineRevision: topic.revision, historicalOrderExact: false })
    const currentResult = task.result ? taskResultSchema.safeParse(withVersion(task.result, runSequence)) : undefined
    let currentLegacyKey
    if (currentResult?.success && task.state === currentResult.data.status) {
      currentLegacyKey = currentResult.data.status === 'completed'
        ? `task-result:${taskId}:completed${(task.completionSequence ?? 0) > 0 ? `:${task.completionSequence}` : ''}`
        : `task-result:${taskId}:waiting:${createHash('sha256').update(task.result.waitingReason).digest('hex').slice(0, 16)}`
    }
    for (const outbound of group.outbox) {
      if (outbound.taskIds?.includes(taskId) || outbound.sourceMessageId?.startsWith(`task-result:${taskId}:`)) outbound.topicRefs = [...(outbound.topicRefs ?? []), ...topicRefs]
      if (currentLegacyKey && outbound.sourceMessageId === currentLegacyKey) {
        outbound.resultFingerprint = fingerprint(currentResult.data)
        outbound.taskIds = [...new Set([...(outbound.taskIds ?? []), taskId])]
      }
    }
  }
  if (output.tables.scheduler?.runtime) output.tables.scheduler.runtime.tasks = []
  for (const table of Object.keys(residentDomainSpec.tables)) output.tables[table] ??= {}
  if (!issues.length) {
    for (const [table, declaration] of Object.entries(residentDomainSpec.tables)) {
      for (const [key, value] of Object.entries(output.tables[table])) {
        const result = declaration.valueSchema.safeParse(value)
        if (!result.success) issues.push({ type: 'invalid-target-record', table, key, paths: result.error.issues.map((issue) => issue.path.join('.')) })
        else output.tables[table][key] = result.data
      }
    }
    for (const task of Object.values(output.tables.tasks)) validateTopicRefs(groupById.get(task.groupId), task.topicRefs)
  }
  const counts = { groups: Object.keys(output.tables.groups ?? {}).length, messages: [...groupById.values()].reduce((count, group) => count + group.messages.length, 0), tasks: sourceTasks.size, topics: mappings.length, outbox: [...groupById.values()].reduce((count, group) => count + group.outbox.length, 0) }
  return { document: output, report: { ready: issues.length === 0, sourceVersion: 6, targetVersion: residentDomainSpec.version, counts, mappings, issues } }
}

export async function migrateTopicStorage({ source, target, check = false }) {
  const sourcePath = await realpath(resolve(source)), targetPath = resolve(target)
  if (sourcePath.toLowerCase() === targetPath.toLowerCase() || basename(targetPath) !== `${DOMAIN}.json`) throw new Error('migration_target_must_be_independent_domain_file')
  try {
    const targetReal = await realpath(targetPath)
    if (targetReal.toLowerCase() === sourcePath.toLowerCase()) throw new Error('migration_source_target_alias')
    const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetReal)])
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) throw new Error('migration_source_target_alias')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const sourceText = await readFile(sourcePath, 'utf8')
  const plan = planTopicMigration(JSON.parse(sourceText))
  const existing = await stat(targetPath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (existing) {
    const current = JSON.parse(await readFile(targetPath, 'utf8'))
    if (!isDeepStrictEqual(current, JSON.parse(JSON.stringify(plan.document)))) throw new Error('migration_target_exists_different')
    if (check) return { ...plan.report, targetAlreadyMatches: true }
    return { ...plan.report, written: false, verified: true }
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
    return { ...plan.report, written: true, verified: true }
  } finally { await facility.closeAll(); await backend.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' }, check: { type: 'boolean', default: false } }, strict: true })
    if (!values.source || !values.target) throw new Error('usage: node scripts/migrate-topic-storage.js --source <v6-unit.json> --target <independent-root/dingtalk_dsh_assistant.json> [--check]')
    const report = await migrateTopicStorage(values)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ready) process.exitCode = 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
