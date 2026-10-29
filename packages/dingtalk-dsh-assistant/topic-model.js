import { createHash } from 'node:crypto'
import { z } from 'zod'

export const topicRefSchema = z.object({ topicId: z.string().min(1), revision: z.number().int().positive() }).strict()
export const unitRefSchema = z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()
export const sourceRangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict()
export const attachmentRefId = (ref) => ref?.id ?? ref?.attachmentId
export const topicEntrySchema = z.object({ revision: z.number().int().positive(), messageId: z.string().min(1), messageVersion: z.number().int().positive(), unitId: z.string().min(1).optional(), unitRevision: z.number().int().positive().optional(), action: z.enum(['add', 'remove']), relationship: z.enum(['continuation', 'affected']).optional(), effectOwner: z.boolean().optional(), reason: z.string().optional() })
const topicOperationSchema = z.looseObject({
  operationId: z.string().min(1), actionIndex: z.number().int().nonnegative(), taskId: z.string().min(1).optional(),
  status: z.enum(['pending', 'applying', 'applied', 'blocked']), attempt: z.number().int().nonnegative().optional(),
  reconciled: z.boolean().optional(), lastError: z.string().optional(), recoveryResolution: z.enum(['not-applied', 'applied']).optional(), recoveryReason: z.string().optional(),
})
export const topicDecisionSchema = z.object({
  decisionId: z.string().min(1), revision: z.number().int().positive(), decision: z.record(z.string(), z.unknown()), fingerprint: z.string(),
  status: z.enum(['accepted', 'applying', 'failed', 'blocked', 'completed', 'rejected']), operations: z.array(topicOperationSchema),
  attempt: z.number().int().nonnegative().optional(), retryBaseAttempt: z.number().int().nonnegative().optional(), nextRetryAt: z.string().optional(), recoveryReason: z.string().optional(), failureOperationId: z.string().min(1).optional(),
  outboundId: z.string().min(1), createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().datetime({ offset: true }).optional(), error: z.string().optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
})
export const topicSchema = z.object({
  lastFactDecisionId: z.string().optional(),
  topicId: z.string().min(1), groupId: z.string().min(1), title: z.string().min(1), revision: z.number().int().nonnegative(), processedRevision: z.number().int().nonnegative(),
  mergedInto: z.string().min(1).optional(), mergeReceipt: z.object({ requestId: z.string().min(1), digest: z.string(), targetRevision: z.number().int().positive(), at: z.string() }).optional(),
  status: z.enum(['active', 'waiting', 'closed']), summary: z.string(), summaryRevision: z.number().int().nonnegative(), openQuestions: z.array(z.string()),
  entries: z.array(topicEntrySchema), decisions: z.array(topicDecisionSchema), createdAt: z.string(), updatedAt: z.string(), migrationBaseline: z.boolean().optional(),
})
export const stableId = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const isPendingDecision = record => !['completed', 'rejected'].includes(record.status)

// Historical messages are usable only when their actual source ownership is unique.
// A task's many historical topicRefs are not notification subscribers.
export function canonicalReplyTopic(group, topicId) {
  const seen = new Set()
  while (topicId && !seen.has(topicId)) {
    seen.add(topicId)
    const topic = group?.topics.find(topic => topic.topicId === topicId)
    if (!topic) return null
    if (!topic.mergedInto) return topicId
    topicId = topic.mergedInto
  }
  return null
}
export function replyTopicForMessage(group, message) {
  if (message?.replyTopicId) return canonicalReplyTopic(group, message.replyTopicId)
  const owners = group.topics.filter(topic => !topic.mergedInto && indexedTopicRefs(group, topic, topic.revision).some(([, entry]) => entry.messageId === message?.messageId
    && entry.messageVersion === message.messageVersion && entry.effectOwner))
  return owners.length === 1 ? owners[0].topicId : null
}

// Only durable pre-effect failures or an already applied outbound identity are safe to resume.
export function topicDecisionRecovery(record) {
  const sourceMissing = ['TASK_TOPIC_SOURCE_VERSION_MISSING', 'TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED'].includes(record.error)
  const projectedReply = record.error === 'outbox_identity_duplicate' && record.failureOperationId === record.outboundId
    && record.operations.every(operation => operation.status === 'applied')
  return record.status === 'blocked' && (sourceMissing || projectedReply)
    ? { token: fingerprint(record), resolution: projectedReply ? 'applied' : 'not-applied' } : null
}

// Only the former deterministic Web continuation path is eligible. Never merge by title.
export function webTaskTopicReusePlan(group, tasks) {
  if (group.messages.some(message => message.routingStatus !== 'routed')) throw new Error('task_topic_reconcile_busy')
  const synthetic = topic => topic.entries.length === 1 && topic.entries[0].reason === 'web-task-input'
    && topic.decisions.length === 1 && ['task-context', 'task-reopen', 'task-cancel'].includes(topic.decisions[0].decision.actions?.[0]?.kind)
  const transfers = []
  for (const source of group.topics.filter(topic => !topic.mergedInto && synthetic(topic))) {
    const record = source.decisions[0], action = record.decision.actions[0], task = tasks.find(task => task.taskId === action.taskId)
    if (record.decision.actions.length !== 1 || record.status !== 'completed' || record.operations.length !== 1
      || record.operations[0].status !== 'applied' || record.operations[0].taskId !== task?.taskId
      || !task?.appliedOperations?.includes(record.operations[0].operationId) || task.groupId !== group.groupId) continue
    const message = group.messages.find(message => message.messageId === source.entries[0].messageId)
    if (message?.sourceKind !== 'web' || message.routingStatus !== 'routed') continue
    const targets = group.topics.filter(topic => topic.topicId !== source.topicId && !topic.mergedInto && !synthetic(topic)
      && action.topicRefs?.some(ref => ref.topicId === topic.topicId)
      && task.topicRefs?.some(ref => ref.topicId === topic.topicId)
      && topic.entries.some(entry => group.messages.some(message => message.messageId === entry.messageId && message.sourceKind === 'dingtalk')))
    if (targets.length !== 1) continue
    const target = targets[0]
    if (!task.drained || task.recovering || source.processedRevision !== source.revision || target.processedRevision !== target.revision
      || source.decisions.some(isPendingDecision) || target.decisions.some(isPendingDecision)
      || group.taskReservations.some(item => item.taskId === task.taskId)) throw new Error('task_topic_reconcile_busy')
    transfers.push({ sourceTopicId: source.topicId, targetTopicId: target.topicId, taskId: task.taskId,
      taskInputVersion: task.inputVersion, sourceRevision: source.revision, targetRevision: target.revision,
      entry: source.entries[0], decisionId: record.decisionId, operationId: record.operations[0].operationId })
  }
  return { groupId: group.groupId, routingRevision: group.routingRevision, transfers }
}

function indexedTopicRefs(group, topic, revision) {
  let revisions = topicPageIndexes.get(topic)
  if (!revisions) { revisions = new Map(); topicPageIndexes.set(topic,revisions) }
  if(revisions.has(revision))return revisions.get(revision)
  if (!Number.isInteger(revision) || revision < 1 || revision > topic.revision) throw new Error('topic_revision_invalid')
  const refs = new Map()
  for (const entry of topic.entries) {
    if (entry.revision > revision) continue
    const entryUnitId = entry.unitId ?? `legacy:${entry.messageId}`
    const normalized = { ...entry, unitId: entryUnitId, unitRevision: entry.unitRevision ?? entry.messageVersion }
    if (entry.action === 'remove') refs.delete(entryUnitId)
    else refs.set(entryUnitId, normalized)
  }
  const sourceOrder = new Map(group.messages.map(message => [message.messageId, message.sequence]))
  const ordered = [...refs].sort(([, a], [, b]) => (sourceOrder.get(a.messageId) ?? 0) - (sourceOrder.get(b.messageId) ?? 0))
  revisions.set(revision,ordered)
  if(revisions.size>8)revisions.delete(revisions.keys().next().value)
  return ordered
}
const topicPageIndexes = new WeakMap(), topicMessageIndexes = new WeakMap()
export const topicMessageCount = (group,topic,revision) => indexedTopicRefs(group,topic,revision).length
export function topicMessages(group,topic,revision,{offset=0,limit=Infinity}={}) {
  let messages=topicMessageIndexes.get(group.messages)
  if(!messages){messages=new Map(group.messages.map(message=>[message.messageId,message]));topicMessageIndexes.set(group.messages,messages)}
  return indexedTopicRefs(group,topic,revision).slice(offset,offset+limit).map(([unitId, entry]) => {
    const { messageId, messageVersion: version, unitRevision } = entry
    const current = messages.get(messageId)
    const fact = current?.messageVersion === version ? current : current?.facts?.find((item) => item.messageVersion === version)
    if (!fact) throw new Error(`topic_message_fact_missing:${messageId}:${version}`)
    const unit = fact.units?.find((item) => item.unitId === unitId && item.unitRevision === unitRevision)
      ?? { unitId, unitRevision, unitKey: 'legacy-whole-message', summary: fact.text || '历史事项', sourceRanges: fact.text ? [{ start: 0, end: fact.text.length, quote: fact.text }] : [], sourceAttachments: (fact.imageRefs ?? []).map((ref) => ({ imageRefId: attachmentRefId(ref) })), contextRanges: [] }
    if (!unit) throw new Error(`topic_unit_fact_missing:${unitId}:${unitRevision}`)
    const { facts, units, ...snapshot } = fact
    const unitText = [...unit.sourceRanges, ...(unit.contextRanges ?? [])].map((range) => range.quote).join('\n') || unit.sourceAttachments.map((ref) => `[附件:${ref.imageRefId}]`).join('\n')
    const projectRange = ({ start, end, purpose }) => ({ start, end, ...(purpose ? { purpose } : {}) })
    return { ...snapshot, text: unitText, _sourceMessageText: snapshot.text, unitId, unitRevision, unitSummary: unit.summary, sourceRanges: unit.sourceRanges.map(projectRange), sourceAttachments: unit.sourceAttachments ?? [], contextRanges: (unit.contextRanges ?? []).map(projectRange), predecessorUnitRefs: unit.predecessorUnitRefs ?? [], effectInheritance: unit.effectInheritance, revisionReason: unit.revisionReason }
  })
}

export function validateTopicRefs(group, value) {
  const refs = z.array(topicRefSchema).min(1).parse(value)
  if (new Set(refs.map((ref) => ref.topicId)).size !== refs.length) throw new Error('task_topic_duplicate')
  for (const ref of refs) {
    const topic = group.topics.find((item) => item.topicId === ref.topicId)
    if (!topic) throw new Error(`topic_not_found:${ref.topicId}`)
    topicMessages(group, topic, ref.revision)
  }
  return refs
}

export function resolveTopicMessages(group, topicId, revision) {
  const topic = group.topics.find((item) => item.topicId === topicId)
  if (!topic) throw new Error(`topic_not_found:${topicId}`)
  return topicMessages(group, topic, revision)
}

const resolveSourceRef = (text, ref, error = 'topic_unit_source_ambiguous') => {
  const quote = ref?.quote
  if (typeof quote !== 'string' || quote.length === 0) throw new Error('topic_unit_source_required')
  const start = text.indexOf(quote)
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) {
    const failure = new Error(error)
    failure.candidates = []
    for (let offset = text.indexOf(quote); offset >= 0; offset = text.indexOf(quote, offset + 1)) failure.candidates.push({ start: offset, end: offset + quote.length })
    throw failure
  }
  return { start, end: start + quote.length, quote }
}

// 完整批次先解析为局部投影，任何问题都阻止 Store 写入。
export function resolveRouteBatch(latest, { groupId, routeId, routes }) {
  const issues = []
  const newTopics = new Map(), topicIdsByKey = {}, unitsByMessage = new Map(), ignoredByMessage = new Map()
  for (const [routeIndex, route] of routes.entries()) {
    try {
    const message = latest.messages.find((item) => item.messageId === route.messageId)
    if (!message) throw new Error(`message_not_found:${route.messageId}`)
    if (message.messageVersion !== route.messageVersion) throw new Error('topic_message_version_stale')
    const routeUnits = route.units ?? [{ unitKey: 'whole-message', summary: message.text.slice(0, 240) || '附件事项', sourceRefs: [...(message.text ? [{ quote: message.text }] : []), ...(message.imageRefs ?? []).map((ref) => ({ imageRefId: attachmentRefId(ref) })), ...(message.mediaUnavailable ?? []).map((value) => ({ imageRefId: String(value).split(':', 1)[0] }))], contextRefs: [], topics: route.topics, effectOwner: route.effectOwner, reason: route.reason }]
    if (!Array.isArray(routeUnits) || routeUnits.length === 0 && !route.ignoredRefs?.length) throw new Error('topic_route_units_required')
    if (new Set(routeUnits.map((unit) => unit.unitKey)).size !== routeUnits.length) throw new Error('topic_route_unit_key_duplicate')
    const readRange = (ref, field, code) => {
      try { return resolveSourceRef(message.text, ref, code) }
      catch (error) {
        issues.push({ field, code: error.message.split(':')[0], message: error.message, candidates: error.candidates ?? [] })
        return null
      }
    }
    const existingUnits = message.units ?? []
    const resolvedUnits = []
    const ignoredRanges = (route.ignoredRefs ?? []).flatMap((ref, index) => { const range = readRange(ref, `routes.${routeIndex}.ignoredRefs.${index}`, 'topic_ignored_source_ambiguous'); return range ? [{ ...range, reason: ref.reason }] : [] })
    for (const [unitIndex, unit] of routeUnits.entries()) {
      try {
      if (!Array.isArray(unit.topics) || (unit.topics.length === 0 && !unit.reason?.trim())) throw new Error('topic_route_reason_required')
      if (unit.topics.length > 1 && unit.topics.some((ref) => !['continuation', 'affected'].includes(ref.relationship) || !ref.reason?.trim())) throw new Error('topic_route_relationship_required')
      if (unit.topics.length > 1 && !unit.effectOwner && unit.dispatchOwner !== 'coordination') throw new Error('topic_route_effect_owner_required')
      if (unit.dispatchOwner !== undefined && !['legacy-topic','coordination'].includes(unit.dispatchOwner)
        || unit.dispatchOwner === 'coordination' && unit.effectOwner) throw new Error('topic_route_dispatch_owner_invalid')
      const prior = existingUnits.findLast((item) => item.unitKey === unit.unitKey)
      const replacesUnitIds = unit.replacesUnitIds ?? []
      const predecessors = replacesUnitIds.map((unitId) => existingUnits.findLast((item) => item.unitId === unitId)).filter(Boolean)
      if (predecessors.length !== replacesUnitIds.length || new Set(replacesUnitIds).size !== replacesUnitIds.length) throw new Error('topic_unit_revision_mapping_invalid')
      if (prior && replacesUnitIds.length && !replacesUnitIds.includes(prior.unitId)) throw new Error('topic_unit_revision_mapping_invalid')
      const sourceRanges = unit.sourceRefs.flatMap((ref, index) => ref.quote ? [readRange(ref, `routes.${routeIndex}.units.${unitIndex}.sourceRefs.${index}`, 'topic_unit_source_ambiguous')].filter(Boolean) : [])
      if (unit.sourceRefs.some((ref) => ref.wholeMessage)) {
        if (unit.sourceRefs.filter((ref) => ref.wholeMessage).length !== 1 || !message.text) throw new Error('topic_unit_whole_message_invalid')
        sourceRanges.push({ start: 0, end: message.text.length, quote: message.text })
      }
      const sourceAttachments = unit.sourceRefs.filter((ref) => ref.imageRefId).map(({ imageRefId }) => {
        const available = (message.imageRefs ?? []).filter((ref) => attachmentRefId(ref) === imageRefId).length
        const unavailable = (message.mediaUnavailable ?? []).filter((value) => String(value).split(':', 1)[0] === imageRefId).length
        if (available + unavailable !== 1) throw new Error('topic_unit_attachment_invalid')
        return { imageRefId }
      })
      const contextRanges = (unit.contextRefs ?? []).flatMap((ref, index) => { const range = readRange(ref, `routes.${routeIndex}.units.${unitIndex}.contextRefs.${index}`, 'topic_unit_context_ambiguous:contextRefs.quote must uniquely match current message.text; quotedMessage content is separate'); return range ? [{ ...range, purpose: ref.purpose }] : [] })
      const comparable = { summary: unit.summary.trim(), sourceRanges, sourceAttachments, contextRanges, predecessorUnitRefs: predecessors.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), ...(unit.effectInheritance ? { effectInheritance: unit.effectInheritance } : {}), ...(unit.revisionReason ? { revisionReason: unit.revisionReason } : {}), ...(unit.dispatchOwner ? { dispatchOwner: unit.dispatchOwner } : {}), ...(unit.fixedTopic ? { fixedTopic: unit.fixedTopic } : {}) }
      const same = prior && JSON.stringify({ summary: prior.summary, sourceRanges: prior.sourceRanges, sourceAttachments: prior.sourceAttachments ?? [], contextRanges: prior.contextRanges ?? [], predecessorUnitRefs: prior.predecessorUnitRefs ?? [], effectInheritance: prior.effectInheritance, revisionReason: prior.revisionReason, ...(prior.dispatchOwner ? { dispatchOwner: prior.dispatchOwner } : {}), ...(prior.fixedTopic ? { fixedTopic: prior.fixedTopic } : {}) }) === JSON.stringify(comparable)
      const stored = { unitId: prior?.unitId ?? stableId('unit', `${groupId}:${route.messageId}:${unit.unitKey}`), unitRevision: same ? prior.unitRevision : (prior?.unitRevision ?? 0) + 1, unitKey: unit.unitKey, ...comparable, ...(same && prior.fixedTopicHandledAt ? { fixedTopicHandledAt: prior.fixedTopicHandledAt } : {}) }
      const selected = new Set()
      for (const ref of unit.topics) {
        if (!!ref.topicId === !!ref.newTopicKey) throw new Error('topic_route_target_invalid')
        if (ref.topicId && !latest.topics.some((topic) => topic.topicId === ref.topicId && !topic.mergedInto)) throw new Error(`topic_not_found:${ref.topicId}`)
        if (ref.newTopicKey) {
          if (!ref.title?.trim()) throw new Error('topic_title_required')
          if (newTopics.has(ref.newTopicKey) && newTopics.get(ref.newTopicKey).title !== ref.title.trim()) throw new Error('topic_title_conflict')
          const topicId = stableId('topic', `${groupId}:${routeId}:${ref.newTopicKey}`)
          topicIdsByKey[ref.newTopicKey] = topicId
          newTopics.set(ref.newTopicKey, { topicId, groupId, title: ref.title.trim(), revision: 0, processedRevision: 0, status: 'active', summary: '', summaryRevision: 0, openQuestions: [], entries: [], decisions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        }
        const id = ref.topicId ?? topicIdsByKey[ref.newTopicKey]
        if (selected.has(id)) throw new Error('topic_route_target_duplicate')
        selected.add(id)
      }
      if (unit.effectOwner) {
        const ownerId = unit.effectOwner.topicId ?? topicIdsByKey[unit.effectOwner.newTopicKey]
        if (!ownerId || !selected.has(ownerId)) throw new Error('topic_route_effect_owner_invalid')
      }
      resolvedUnits.push({ ...stored, topics: unit.topics, effectOwner: unit.effectOwner, reason: unit.reason })
      } catch (error) { issues.push({ field: `routes.${routeIndex}.units.${unitIndex}`, code: error.message.split(":")[0], message: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) }) }
    }
    if (route.units && resolvedUnits.length === routeUnits.length) {
      const activeExistingIds = new Set((message.activeUnitRefs ?? existingUnits.map(({ unitId }) => ({ unitId }))).map((ref) => ref.unitId))
      const retained = new Set(resolvedUnits.filter((unit) => activeExistingIds.has(unit.unitId)).map((unit) => unit.unitId))
      const replaced = new Set(resolvedUnits.flatMap((unit) => unit.predecessorUnitRefs).map((ref) => ref.unitId))
      if ([...activeExistingIds].some((unitId) => !retained.has(unitId) && !replaced.has(unitId))) throw new Error('topic_unit_revision_mapping_required')
      const covered = new Uint8Array(message.text.length)
      for (const range of [...resolvedUnits.flatMap((unit) => [...unit.sourceRanges, ...unit.contextRanges]), ...ignoredRanges]) for (let index = range.start; index < range.end; index++) covered[index] = 1
      let offset = 0
      const uncoveredRanges = []
      for (const character of message.text) {
        if (!/\s/u.test(character) && covered[offset] !== 1) {
          const previous = uncoveredRanges.at(-1)
          if (previous?.end === offset) previous.end += character.length
          else uncoveredRanges.push({ start: offset, end: offset + character.length })
        }
        offset += character.length
      }
      if (uncoveredRanges.length) {
        const error = new Error('topic_route_uncovered_text')
        error.uncoveredRanges = uncoveredRanges.map(range => ({ ...range, quote: message.text.slice(range.start, range.end) }))
        throw error
      }
    }
    unitsByMessage.set(route.messageId, resolvedUnits)
    ignoredByMessage.set(route.messageId, ignoredRanges)
    } catch (error) { issues.push({ field: `routes.${routeIndex}`, code: error.message.split(":")[0], message: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.uncoveredRanges ? { uncoveredRanges: error.uncoveredRanges } : {}) }) }
  }

  if (issues.length) { const error = new Error(issues[0].message); error.issues = issues; throw error }
  return { newTopics, topicIdsByKey, unitsByMessage, ignoredByMessage }
}
