import { DatabaseSync } from 'node:sqlite'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { stableTaskResourceIdentity } from '../../../../packages/dingtalk-dsh-assistant/task-message-projections.js'

function compact(value, limit) {
  const text = String(value ?? '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function boundedFirstReplyFixture(snapshot) {
  return buildBoundedFirstReplyFixture(snapshot)
}

export function boundedBenchmarkFirstReplyFixture(snapshot) {
  if (![773, 774].includes(snapshot.message.sequence) || !snapshot.relatedDecision) throw new Error('bounded_benchmark_not_applicable')
  return buildBoundedFirstReplyFixture(snapshot, 'active')
}

function buildBoundedFirstReplyFixture(snapshot, benchmarkRelatedStatus) {
  const { currentGroup, currentTopic, message, envelope, results, route, currentOutbox } = snapshot
  let context = route.results.find(item => item.topic?.topicId === currentTopic.topicId && Array.isArray(item.messages))
  const contextFromLedger = !context
  if (!context && [774, 780, 783].includes(message.sequence)) {
    const projection = [...route.envelope.topics, ...route.envelope.relatedTopics, ...route.envelope.recalledTopics].find(item => item.topicId === currentTopic.topicId)
    if (!projection || projection.revision !== envelope.processedRevision || projection.title !== envelope.title) throw new Error('bounded_topic_snapshot_mismatch')
    const refs = new Map()
    for (const entry of currentTopic.entries.filter(item => item.revision <= envelope.processedRevision)) {
      if (!entry.unitId || !entry.unitRevision) throw new Error('bounded_legacy_topic_entry')
      if (entry.action === 'remove') refs.delete(entry.unitId)
      else refs.set(entry.unitId, entry)
    }
    const messages = [...refs.values()].map(entry => {
      const source = currentGroup.messages.find(item => item.messageId === entry.messageId)
      const fact = source?.messageVersion === entry.messageVersion ? source : source?.facts?.find(item => item.messageVersion === entry.messageVersion)
      const unit = fact?.units?.find(item => item.unitId === entry.unitId && item.unitRevision === entry.unitRevision)
      if (!fact || !unit || ['migration-baseline', 'legacy-whole-message'].includes(unit.unitKey) || unit.sourceAttachments?.length) throw new Error('bounded_ledger_unit_missing')
      const ranges = [...unit.sourceRanges, ...(unit.contextRanges ?? [])]
      if (ranges.some(item => fact.text.slice(item.start, item.end) !== item.quote)) throw new Error('bounded_ledger_range_mismatch')
      if (source.messageVersion !== entry.messageVersion) throw new Error('bounded_ledger_message_version_missing')
      return { messageId: entry.messageId, messageVersion: entry.messageVersion, unitId: entry.unitId, unitRevision: entry.unitRevision, text: ranges.map(item => item.quote).join('\n') }
    })
    context = { topic: { topicId: currentTopic.topicId, title: envelope.title, status: projection.status, revision: envelope.processedRevision, processedRevision: envelope.processedRevision, summary: envelope.summary, summaryRevision: envelope.summaryRevision, openQuestions: envelope.openQuestions }, messages }
  }
  const review = results.find(item => item.replyReview)?.replyReview
  if (!context || !review || context.topic.revision !== envelope.processedRevision || context.topic.summary !== envelope.summary || context.topic.summaryRevision !== envelope.summaryRevision) throw new Error('bounded_topic_snapshot_mismatch')
  const known = new Map(), contextUnits = new Map()
  for (const historic of context.messages) {
    const current = currentGroup.messages.find(item => item.messageId === historic.messageId && item.messageVersion === historic.messageVersion)
    const unit = current?.units?.find(item => item.unitId === historic.unitId && item.unitRevision === historic.unitRevision)
    if (!unit || [...unit.sourceRanges, ...(unit.contextRanges ?? [])].map(item => item.quote).join('\n') !== historic.text) throw new Error('bounded_context_unit_mismatch')
    known.set(current.messageId, current)
    const units = contextUnits.get(current.messageId) ?? []
    units.push(unit)
    contextUnits.set(current.messageId, units)
  }
  let relatedTopic, relatedStatusAssumed = false
  if (snapshot.relatedDecision) {
    const { topic: historicTopic, record, envelope: relatedEnvelope } = snapshot.relatedDecision
    const historicEntries = historicTopic.entries.filter(item => item.revision <= record.revision)
    const active = new Map()
    for (const entry of historicEntries) {
      if (!entry.unitId || !entry.unitRevision || entry.action === 'remove' || active.has(entry.unitId)) throw new Error('bounded_legacy_topic_entry')
      active.set(entry.unitId, entry)
    }
    for (const entry of active.values()) {
      const source = currentGroup.messages.find(item => item.messageId === entry.messageId)
      const unit = source?.messageVersion === entry.messageVersion && source.units?.find(item => item.unitId === entry.unitId && item.unitRevision === entry.unitRevision)
      if (!unit || ['migration-baseline', 'legacy-whole-message'].includes(unit.unitKey) || unit.sourceAttachments?.length) throw new Error('bounded_ledger_unit_missing')
      if ([...unit.sourceRanges, ...(unit.contextRanges ?? [])].some(item => source.text.slice(item.start, item.end) !== item.quote)) throw new Error('bounded_ledger_range_mismatch')
      known.set(source.messageId, source)
      const units = contextUnits.get(source.messageId) ?? []
      if (!units.some(item => item.unitId === unit.unitId && item.unitRevision === unit.unitRevision)) units.push(unit)
      contextUnits.set(source.messageId, units)
    }
    const update = record.appliedTopicUpdate ?? record.decision?.topicUpdate ?? {}
    const status = update.status ?? benchmarkRelatedStatus
    if (!status) throw new Error('bounded_related_status_unknown')
    relatedStatusAssumed = update.status === undefined
    if (!status || !record.completedAt || !historicTopic.createdAt || !relatedEnvelope.title) throw new Error('bounded_related_metadata_missing')
    relatedTopic = { topicId: historicTopic.topicId, groupId: currentGroup.groupId, title: update.title ?? relatedEnvelope.title, revision: record.revision, processedRevision: record.revision, status,
      summary: update.summary ?? relatedEnvelope.summary, summaryRevision: update.summary !== undefined ? record.revision : relatedEnvelope.summaryRevision,
      openQuestions: update.openQuestions ?? relatedEnvelope.openQuestions, entries: historicEntries, decisions: [], createdAt: historicTopic.createdAt, updatedAt: record.completedAt }
  }
  for (const historic of route.envelope.recentMessages) {
    const current = currentGroup.messages.find(item => item.messageId === historic.messageId)
    if (!current || current.sourceKind !== historic.sourceKind || current.text !== historic.text && !(contextFromLedger && known.has(current.messageId) && historic.textTruncated && current.text.slice(0, 600) === historic.text)) throw new Error('bounded_recent_message_mismatch')
    known.set(current.messageId, current)
  }
  let omittedReviewSources = 0
  for (const { value } of review.sourceMessages) {
    const current = currentGroup.messages.find(item => item.messageId === value.messageId)
    if (!current || compact(current.text, 480) !== value.text || !known.has(value.messageId) && current.text.trim() !== value.text) { omittedReviewSources++; continue }
    known.set(current.messageId, current)
  }
  known.delete(message.messageId)
  const messages = [...known.values()].sort((a, b) => a.sequence - b.sequence).map(item => {
    const units = contextUnits.get(item.messageId) ?? []
    return { messageId: item.messageId, sequence: item.sequence, text: item.text, occurredAt: item.occurredAt, messageVersion: item.messageVersion,
      ...(item.senderName ? { senderName: item.senderName } : {}), ...(item.senderOpenDingTalkId ? { senderOpenDingTalkId: item.senderOpenDingTalkId } : {}),
      ...(item.sourceKind ? { sourceKind: item.sourceKind } : {}), ...(item.quotedMessage ? { quotedMessage: item.quotedMessage } : {}),
      ...(route.envelope.recentMessages.find(message => message.messageId === item.messageId)?.messageAiSendFlag !== undefined ? { messageAiSendFlag: route.envelope.recentMessages.find(message => message.messageId === item.messageId).messageAiSendFlag } : {}), units, activeUnitRefs: units.map(unit => ({ unitId: unit.unitId, unitRevision: unit.unitRevision })), facts: [], routingStatus: 'routed' }
  })
  const selectedIds = new Set(messages.map(item => item.messageId))
  const entries = currentTopic.entries.filter(entry => entry.revision <= context.topic.revision && selectedIds.has(entry.messageId) && contextUnits.get(entry.messageId)?.some(unit => unit.unitId === entry.unitId && unit.unitRevision === entry.unitRevision))
  const topic = { ...context.topic, groupId: currentGroup.groupId, entries, decisions: [], createdAt: currentTopic.createdAt, updatedAt: currentTopic.createdAt }
  const visible = [...route.envelope.topics, ...route.envelope.relatedTopics, ...route.envelope.recalledTopics]
  const byId = new Map()
  for (const item of visible) {
    const previous = byId.get(item.topicId)
    if (previous && (previous.revision !== item.revision || previous.title !== item.title || previous.summary !== item.summary || previous.status !== item.status)) throw new Error('bounded_candidate_conflict')
    byId.set(item.topicId, item)
  }
  const targetInitiallyVisible = byId.has(topic.topicId)
  if (!targetInitiallyVisible) {
    const searchedTarget = route.results.flatMap(item => item.topics ?? []).find(item => item.topicId === topic.topicId)
    if (!searchedTarget) throw new Error('bounded_target_not_visible')
    if (searchedTarget.revision !== topic.revision || searchedTarget.title !== topic.title || searchedTarget.status !== topic.status) throw new Error('bounded_searched_target_mismatch')
    byId.set(topic.topicId, searchedTarget)
  }
  const unavailableTopicIds = []
  const topics = [...byId.values()].map((item, index) => {
    const updatedAt = new Date(Date.parse(message.occurredAt) - index * 1000).toISOString()
    if (item.topicId === topic.topicId) return { ...topic, updatedAt }
    const current = currentGroup.topics.find(value => value.topicId === item.topicId)
    if (!current || current.createdAt > message.occurredAt) throw new Error('bounded_candidate_metadata_missing')
    unavailableTopicIds.push(item.topicId)
    return { topicId: item.topicId, groupId: currentGroup.groupId, title: item.title, revision: item.revision, processedRevision: item.revision, status: item.status,
      summary: item.summary ?? '', summaryRevision: item.revision, openQuestions: [], entries: [], decisions: [], createdAt: current.createdAt, updatedAt }
  })
  if (relatedTopic) {
    topics.push(relatedTopic)
    unavailableTopicIds.push(relatedTopic.topicId)
  }
  const candidates = new Map(review.candidates.map(item => [item.outboundId, item]))
  const outbox = currentOutbox.map(item => {
    const candidate = candidates.get(item.outboundId)
    const sourceMessages = (candidate.sourceMessageRefs ?? []).map(ref => review.sourceMessages.find(item => item.ref === ref)?.value?.messageId).filter(id => selectedIds.has(id))
    return { outboundId: item.outboundId, sourceMessageId: candidate.sourceMessageId, text: candidate.reply, status: candidate.status,
      ...(candidate.topicRefs ? { topicRefs: candidate.topicRefs } : {}), ...(candidate.deliveredMessageId ? { deliveredMessageId: candidate.deliveredMessageId } : {}),
      ...(candidate.replyKind ? { replyKind: candidate.replyKind } : {}), ...(candidate.matterUnitRefs ? { matterUnitRefs: candidate.matterUnitRefs } : {}),
      taskIds: candidate.taskIds ?? [], matterSourceMessageIds: sourceMessages }
  })
  const fixedTopics = (currentGroup.fixedTopics ?? []).filter(item => route.envelope.fixedTopics?.some(historic => historic.topicId === item.topicId && historic.title === item.title) && item.createdAt <= message.occurredAt)
  if (fixedTopics.length !== (route.envelope.fixedTopics?.length ?? 0)) throw new Error('bounded_fixed_topic_mismatch')
  const tasks = results.filter(item => Array.isArray(item.tasks) && !Object.hasOwn(item, 'total')).flatMap(item => item.tasks).map(task => {
    const { state, inputVersion, acceptanceCriteria, taskPromptRefs, ...stored } = task
    if (state !== 'completed' || stored.status !== 'completed' || !stored.drained || inputVersion !== stored.requirementRevision || JSON.stringify(acceptanceCriteria) !== JSON.stringify(stored.requirements)) throw new Error('bounded_task_snapshot_invalid')
    return stored
  })
  if (!tasks.length) throw new Error('bounded_tasks_missing')
  if (!Number.isInteger(route.routingRevision) || currentTopic.createdAt > message.occurredAt) throw new Error('bounded_historical_metadata_missing')
  const group = { groupId: currentGroup.groupId, responsibility: '处理群内明确交办给助手的事项', residentSessionId: 'bounded-evaluation', nextSequence: message.sequence,
    fixedTopics, messages, topics, outbox, routingRevision: route.routingRevision, routeHistory: [], taskReservations: [], sourceDispatchOwnership: [], coordinationRequests: {} }
  const input = { groupId: currentGroup.groupId, messageId: message.messageId, text: message.text, occurredAt: message.occurredAt,
    ...(message.senderName ? { senderName: message.senderName } : {}), ...(message.senderOpenDingTalkId ? { senderOpenDingTalkId: message.senderOpenDingTalkId } : {}),
    ...(message.sourceKind ? { sourceKind: message.sourceKind } : {}), ...(message.quotedMessage ? { quotedMessage: message.quotedMessage } : {}) }
  return { group, tasks, input, targetTopicId: topic.topicId, unavailableTopicIds, scope: { topicCount: topics.length, originalTopicCount: route.envelope.totalTopics, messages: messages.length, topicEntries: entries.length, omittedReviewSources,
    historicalResponsibilityVerified: false, syntheticResponsibility: true, contextFromLedger, relatedTopicRecovered: !!relatedTopic, relatedStatusAssumed, retainedHistoricalDecisions: false, outboundTextBounded: true, candidateDetailsUnavailable: unavailableTopicIds.length, candidateProcessingAndOrderSynthetic: true, targetInitiallyVisible } }
}

export function readBoundedHistoricalSources(path, fixture) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const query = db.prepare("SELECT body FROM dynamic_sources WHERE json_extract(body,'$.groupId') = ? AND json_extract(body,'$.messageId') = ? AND json_extract(body,'$.version') = ?")
    const cutoff = Date.parse(fixture.input.occurredAt)
    if (!Number.isFinite(cutoff)) throw new Error('bounded_source_cutoff_invalid')
    const entries = fixture.group.topics.flatMap(topic => topic.entries)
    const messages = new Map(fixture.group.messages.map(message => [message.messageId, message]))
    const notifications = new Set(fixture.group.outbox.map(item => item.deliveredMessageId).filter(Boolean))
    const sources = new Map()
    for (const entry of entries) {
      if (notifications.has(entry.messageId)) continue
      const message = messages.get(entry.messageId)
      if (!message || message.messageVersion !== entry.messageVersion || !Number.isFinite(Date.parse(message.occurredAt)) || Date.parse(message.occurredAt) > cutoff) throw new Error('bounded_source_message_invalid')
      const matches = query.all(fixture.group.groupId, entry.messageId, entry.messageVersion).map(row => JSON.parse(row.body))
      if (matches.length !== 1) throw new Error('bounded_source_not_unique')
      const source = matches[0]
      if (source.text !== message.text || !source.actorId || message.senderOpenDingTalkId && message.senderOpenDingTalkId !== source.actorId || !(Date.parse(source.routedAt) <= cutoff || Date.parse(source.processingCompleted?.at) <= cutoff)) throw new Error('bounded_source_historical_evidence_missing')
      const resources = source.resources?.map(resource => {
        const key = ['resourceId', 'mediaId', 'fileId', 'attachmentId', 'id'].find(name => resource?.[name] !== undefined)
        if (!key) throw new Error('bounded_source_resource_identity_unverified')
        return { ...(resource.type !== undefined ? { type: resource.type } : {}), [key]: resource[key] }
      })
      if (stableTaskResourceIdentity(resources) !== stableTaskResourceIdentity(source.resources)) throw new Error('bounded_source_resource_identity_mismatch')
      const { id, sourceId, groupId, messageId, version, actorId, senderName, channel, text, quote, timestamp } = source
      sources.set(sourceId, { id, sourceId, groupId, messageId, version, actorId, senderName, channel, text, quote, resources, timestamp, routed: true })
    }
    return [...sources.values()]
  } finally { db.close() }
}

export async function seedBoundedStores({ storageDomain, root, fixture, residentDomainSpec, openResidentStore, openDynamicTaskStore, historicalSources = [] }) {
  const actualRoot = await realpath(root), tempRoot = await realpath(tmpdir()), subpath = relative(tempRoot, actualRoot)
  if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('bounded_root_not_temporary')
  const config = { dbPath: join(actualRoot, 'dynamic.db'), instanceId: 'bounded-evaluation', initialize: true }
  try { await lstat(config.dbPath); throw new Error('bounded_database_already_exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const domain = await storageDomain.open(residentDomainSpec)
  try {
    const groups = domain.table('groups')
    if ([...groups.entries()].length) throw new Error('bounded_resident_not_empty')
    await groups.put(fixture.group.groupId, fixture.group)
  } finally { await domain.close() }
  const initial = await openDynamicTaskStore(config)
  await initial.close()
  const db = new DatabaseSync(config.dbPath)
  try {
    db.exec('BEGIN')
    const insert = db.prepare('INSERT INTO dynamic_tasks (id, body) VALUES (?, ?)')
    for (const task of fixture.tasks) insert.run(task.taskId, JSON.stringify(task))
    const insertSource = db.prepare('INSERT INTO dynamic_sources (id, body) VALUES (?, ?)')
    for (const source of historicalSources) insertSource.run(source.sourceId, JSON.stringify(source))
    db.exec('COMMIT')
  } finally { db.close() }
  return { residentStore: await openResidentStore(storageDomain), config }
}
