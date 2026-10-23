import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { safeNotificationDetail } from '../../../../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { notificationOpenTaskId } from '../../../../packages/dingtalk-dsh-assistant/group-message.js'

// 仅 GET 当前本机群投影并只读账本；不调用业务命令、发送、重试或对账接口。
const runtime = 'http://127.0.0.1:18998'
const dbPath = 'D:/baibu-agent/.dsh/task-sessions.sqlite'
const usage = 'node inspect-live-reminder.mjs --group-id <群ID> --marker <唯一验收标记> --since <UTC ISO时间Z> --output <新的.json路径>'
const { values } = parseArgs({ options: {
  'group-id': { type: 'string' }, marker: { type: 'string' }, since: { type: 'string' },
  output: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) { console.log(usage); process.exit(0) }
const groupId = values['group-id'], marker = values.marker, since = values.since
if (!groupId?.trim() || !marker?.trim() || marker.length > 256 || !values.output
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(since ?? '')
  || !Number.isFinite(Date.parse(since))) throw new Error(usage)
const output = resolve(values.output)
if (extname(output).toLowerCase() !== '.json') throw new Error('验收输出必须是新的 .json 文件')

const pick = (item, keys) => Object.fromEntries(keys.filter(key => item?.[key] !== undefined).map(key => [key, item[key]]))
const ids = items => [...new Set(items.filter(Boolean))]
const text = value => typeof value === 'string' ? safeNotificationDetail(value) : undefined
const afterSince = value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(since)
const elapsed = (start, end) => Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))
  ? Date.parse(end) - Date.parse(start) : null
const action = value => value && { kind: value.kind, ...(value.text ? { text: text(value.text) } : {}) }
const receiptProof = value => value && pick(value, ['messageId', 'conversationId', 'quoteMessageId', 'sentAt', 'observedAt', 'identity', 'mentionVerification'])
const preparedAt = notification => notification?.createdAt ?? null

const collectionStartedAt = new Date().toISOString()
const endpoint = new URL('/state/groups', runtime)
endpoint.searchParams.set('groupId', groupId)
const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) })
if (!response.ok) throw new Error(`群投影读取失败: HTTP ${response.status}`)
const group = await response.json()
if (group?.groupId !== groupId) throw new Error('群投影未返回指定群')
const projectionObservedAt = new Date().toISOString()
const messages = (group.messages ?? []).filter(message => typeof message.text === 'string'
  && message.text.includes(marker) && afterSince(message.occurredAt))
const db = new DatabaseSync(dbPath, { readOnly: true })
let report
try {
  // BEGIN 只建立一致的只读快照；不实例化生产 Store，避免恢复逻辑修改运行态。
  db.exec('PRAGMA query_only=ON; BEGIN')
  const ledgerObservedAt = new Date().toISOString()
  const rows = (table, where, bindings) => db.prepare(`SELECT body FROM ${table} WHERE ${where}`).all(...bindings).map(row => JSON.parse(row.body))
  const inIds = (table, field, values) => values.length ? rows(table,
    `${field} IN (SELECT value FROM json_each(?))`, [JSON.stringify(values)]) : []
  const sources = rows('dynamic_sources', "json_extract(body,'$.groupId')=? AND instr(json_extract(body,'$.text'),?)>0 AND julianday(json_extract(body,'$.timestamp'))>=julianday(?)",
    [groupId, marker, since])
  const messageIds = ids([...messages.map(item => item.messageId), ...sources.map(item => item.messageId)])
  const sourceIds = ids(sources.map(item => item.id))
  const sourceSeeds = messageIds.length ? rows('dynamic_coordination_sources',
    "json_extract(body,'$.groupId')=? AND json_extract(body,'$.sourceMessageId') IN (SELECT value FROM json_each(?))", [groupId, JSON.stringify(messageIds)]) : []
  const coordinationIds = ids(sourceSeeds.map(item => item.coordinationId))
  const coordinations = inIds('dynamic_coordination', 'id', coordinationIds)
  const coordinationSources = [...new Map([...sourceSeeds, ...inIds('dynamic_coordination_sources', "json_extract(body,'$.coordinationId')", coordinationIds)]
    .filter(item => item.groupId === groupId).map(item => [item.id, item])).values()]
  const schedules = inIds('dynamic_coordination_schedules', "json_extract(body,'$.coordinationId')", coordinationIds)
  const occurrences = inIds('dynamic_coordination_occurrences', "json_extract(body,'$.coordinationId')", coordinationIds)
  const occurrenceIds = ids(occurrences.map(item => item.id))
  const jobs = inIds('dynamic_coordination_jobs', "json_extract(body,'$.occurrenceId')", occurrenceIds)
  const members = inIds('dynamic_coordination_members', "json_extract(body,'$.coordinationId')", coordinationIds)
  const notifications = messageIds.length || coordinationIds.length ? rows('dynamic_notifications',
    "json_extract(body,'$.payload.conversationId')=? AND (json_extract(body,'$.payload.sourceMessageId') IN (SELECT value FROM json_each(?)) OR json_extract(body,'$.payload.fact.coordinationId') IN (SELECT value FROM json_each(?)))",
    [groupId, JSON.stringify(messageIds), JSON.stringify(coordinationIds)]) : []
  const notificationIds = ids(notifications.map(item => item.id))
  const relatedSourceIds = ids([...sourceIds, ...coordinationSources.map(item => item.id)])
  const receipts = relatedSourceIds.length || notificationIds.length ? db.prepare(`SELECT rowid AS sequence,id,body FROM dynamic_receipts WHERE
    json_extract(body,'$.result.notification.id') IN (SELECT value FROM json_each(?))
    OR json_extract(body,'$.result.source.id') IN (SELECT value FROM json_each(?))
    OR json_extract(body,'$.result.coordination.id') IN (SELECT value FROM json_each(?))
    OR json_extract(body,'$.result.schedule.coordinationId') IN (SELECT value FROM json_each(?))
    OR json_extract(body,'$.result.occurrence.coordinationId') IN (SELECT value FROM json_each(?))
    OR json_extract(body,'$.result.job.occurrenceId') IN (SELECT value FROM json_each(?)) ORDER BY rowid`).all(
    JSON.stringify(notificationIds), JSON.stringify(relatedSourceIds), JSON.stringify(coordinationIds),
    JSON.stringify(coordinationIds), JSON.stringify(coordinationIds), JSON.stringify(occurrenceIds))
    .map(row => ({ sequence: row.sequence, id: row.id, ...JSON.parse(row.body) })) : []
  const taskIds = ids(members.map(item => item.taskId))
  const tasks = sourceIds.length || taskIds.length ? rows('dynamic_tasks',
    "id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(json_extract(body,'$.sourceRefs')) ref WHERE ref.value IN (SELECT value FROM json_each(?)))",
    [JSON.stringify(taskIds), JSON.stringify(sourceIds)]) : []
  const byMessage = new Map(sources.map(item => [item.messageId, item]))
  const byUnit = new Map(coordinationSources.map(item => [`${item.unitId}:${item.revision}`, item]))
  const byOccurrence = new Map(occurrences.map(item => [item.id, item]))
  const projectedNotifications = notifications.map(notification => {
    const fact = notification.payload?.fact ?? {}
    const origin = byMessage.get(notification.payload?.sourceMessageId)
      ?? byMessage.get(byUnit.get(`${fact.sourceUnitId}:${fact.sourceUnitRevision}`)?.sourceMessageId)
    const samples = receipts.filter(item => item.result?.notification?.id === notification.id)
    // ACK 时刻来自不可变命令回执的快照；当前 updatedAt 已可能被回读覆盖。
    const acknowledged = samples.filter(item => item.id.startsWith(`notification-ack:${notification.id}:`)).at(-1)
    const ackAt = acknowledged?.result.notification.updatedAt ?? null
    const deliveredAt = notification.state === 'delivered' ? notification.receipt?.observedAt ?? notification.updatedAt : null
    const sentAt = notification.state === 'delivered' ? notification.receipt?.sentAt ?? null : null
    const plannedAt = byOccurrence.get(fact.occurrenceId)?.plannedAt ?? null
    return {
      ...pick(notification, ['id', 'kind', 'taskId', 'state', 'createdAt', 'sendStartedAt', 'updatedAt', 'sendAttemptCount', 'readbackAttemptCount', 'nextAttemptAt']),
      text: text(notification.payload?.text), sourceMessageId: notification.payload?.sourceMessageId ?? null,
      coordinationId: fact.coordinationId ?? null, occurrenceId: fact.occurrenceId ?? null,
      sourceUnitId: fact.sourceUnitId ?? null, sourceUnitRevision: fact.sourceUnitRevision ?? null,
      sourceAt: origin?.timestamp ?? null, preparedAt: preparedAt(notification), ackAt, sentAt, deliveredAt, plannedAt,
      openTaskId: notificationOpenTaskId(notification.ack) ?? null,
      receipt: receiptProof(notification.receipt),
      retirement: notification.retirement && pick(notification.retirement, ['reason', 'resolvedBy', 'at']),
      milliseconds: {
        sourceToPrepared: elapsed(origin?.timestamp, preparedAt(notification)),
        preparedToRealStart: elapsed(preparedAt(notification), notification.sendStartedAt),
        realStartToAck: elapsed(notification.sendStartedAt, ackAt),
        ackToDelivered: elapsed(ackAt, deliveredAt), sourceToDelivered: elapsed(origin?.timestamp, deliveredAt),
        sourceToSent: elapsed(origin?.timestamp, sentAt), plannedToSent: elapsed(plannedAt, sentAt),
        plannedToDelivered: elapsed(plannedAt, deliveredAt),
      },
    }
  })
  const associatedOutbox = (group.outbox ?? []).filter(item => notificationIds.includes(item.outboundId)
    || messageIds.includes(item.replyToMessageId)
    || (item.matterSourceMessageIds ?? []).some(id => messageIds.includes(id)))
  report = {
    status: messages.length || sources.length ? 'observed' : 'waiting',
    scope: { groupId, marker: text(marker), since },
    collection: { collectionStartedAt, projectionObservedAt, ledgerObservedAt, runtime, dbPath,
      readOnly: true, businessWrites: 0, independentDwsReadback: false,
      note: '群投影与 SQLite 是分别取样；送达时间来自持久回执，独立 DWS 精确回读需另行采集。缺失时刻保持 null，不以创建时间代替真实发送开始。' },
    counts: { messages: messages.length, sources: sources.length, coordinationSources: coordinationSources.length,
      coordinations: coordinations.length, schedules: schedules.length, occurrences: occurrences.length, jobs: jobs.length,
      notifications: notifications.length, receipts: receipts.length, linkedTasks: tasks.length,
      deliveredReminders: projectedNotifications.filter(item => item.occurrenceId && item.state === 'delivered').length },
    messages: messages.map(item => ({ ...pick(item, ['messageId', 'messageVersion', 'occurredAt', 'sequence', 'routingStatus', 'agentDeliveryStatus', 'agentDeliveryAt']), text: text(item.text) })),
    sources: sources.map(item => ({ ...pick(item, ['id', 'sourceId', 'messageId', 'version', 'timestamp', 'channel', 'routed', 'routePreparedAt']), text: text(item.text) })),
    coordinationSources: coordinationSources.map(item => ({ ...pick(item, ['id', 'unitId', 'revision', 'sourceMessageId', 'sourceRefs', 'coordinationId', 'state', 'settled', 'createdAt', 'resolvedBy', 'attemptCount', 'nextRetryAt']),
      ...(messageIds.includes(item.sourceMessageId) ? { original: text(item.original), question: text(item.question) } : {}),
      proposalKind: item.acceptedProposal?.kind ?? null, resolutionKind: item.acceptedProposal?.resolution?.kind ?? null })),
    coordinations: coordinations.map(item => ({ ...pick(item, ['id', 'revision', 'sourceId', 'state', 'lifecycleState', 'createdAt', 'memberIds', 'pendingSourceId']),
      pendingClarificationCount: item.pendingClarifications?.length ?? (item.question ? 1 : 0),
      history: (item.history ?? []).map(entry => pick(entry, ['eventId', 'sourceId', 'revision', 'reason', 'at'])) })),
    schedules: schedules.map(item => ({ ...pick(item, ['id', 'coordinationId', 'revision', 'state', 'createdAt', 'effectiveFrom', 'nextDueAt', 'timezone', 'rule']), action: action(item.action),
      history: (item.history ?? []).map(entry => ({ ...pick(entry, ['revision', 'rule', 'timezone', 'state', 'effectiveFrom', 'nextDueAt', 'scope', 'changedAt']), action: action(entry.action) })) })),
    occurrences: occurrences.map(item => ({ ...pick(item, ['id', 'coordinationId', 'scheduleId', 'acceptedScheduleRevision', 'plannedAt', 'acceptedAt', 'actionState', 'deliveryState', 'jobId', 'notificationId', 'cancelledAt', 'resultVersion']),
      action: action(item.action), result: action(item.result) })),
    jobs: jobs.map(item => ({ ...pick(item, ['id', 'occurrenceId', 'state', 'attempt', 'fence', 'leaseUntil']), result: action(item.result) })),
    notifications: projectedNotifications,
    receipts: receipts.map(item => ({ id: item.id, sequence: item.sequence, replayed: item.replayed,
      ...Object.fromEntries(['source', 'coordination', 'schedule', 'occurrence', 'job'].filter(key => item.result?.[key]).map(key => [key,
        pick(item.result[key], ['id', 'coordinationId', 'state', 'revision', 'settled', 'resolvedBy', 'createdAt', 'updatedAt', 'plannedAt', 'actionState', 'deliveryState', 'attempt'])])),
      ...(item.result?.notification ? { notification: {
        ...pick(item.result.notification, ['id', 'state', 'createdAt', 'sendStartedAt', 'updatedAt', 'sendAttemptCount', 'readbackAttemptCount']),
        ackPresent: Boolean(item.result.notification.ack), receipt: receiptProof(item.result.notification.receipt),
      } } : {}) })),
    outbox: associatedOutbox.map(item => ({ ...pick(item, ['outboundId', 'replyToMessageId', 'notificationState', 'status', 'sendStartedAt', 'sentAt', 'deliveredAt', 'deliveredMessageId']), text: text(item.text) })),
    linkedTasks: tasks.map(item => pick(item, ['id', 'taskId', 'status', 'createdAt'])),
  }
} finally { db.close() }
report.collection.completedAt = new Date().toISOString()
await mkdir(dirname(output), { recursive: true })
// 每次取样使用新文件，拒绝覆盖已有证据；唯一落盘副作用是本次验收 JSON。
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: report.status, counts: report.counts, output, readOnly: true, businessWrites: 0 }))
