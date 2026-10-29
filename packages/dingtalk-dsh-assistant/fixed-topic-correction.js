import { z } from 'zod'
import { attachmentRefId, fingerprint, isPendingDecision, stableId } from './topic-model.js'

export const fixedTopicCorrectionSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000),
  routingRevision: z.number().int().nonnegative(),
  messages: z.array(z.strictObject({ messageId: z.string().min(1), messageVersion: z.number().int().positive() })).min(1).max(20)
    .refine(items => new Set(items.map(item => item.messageId)).size === items.length),
})

// Explicit local operator correction, never a model decision or a replay request.
// Called within the group's serialized atomic update. No task/outbox side effects.
export function correctOutOfScope(group, input, tasks) {
  const parsed = fixedTopicCorrectionSchema.safeParse(input)
  if (!parsed.success) throw new Error('FIXED_TOPIC_CORRECTION_INVALID')
  const { requestId, reason, routingRevision, messages: refs } = parsed.data
  const digest = fingerprint(parsed.data), routeId = stableId('fixed-topic-correction', requestId)
  const previous = group.routeHistory.find(item => item.routeId === routeId)
  if (previous) {
    if (previous.fingerprint !== digest) throw new Error('FIXED_TOPIC_CORRECTION_IDENTITY_CONFLICT')
    return { group, receipt: previous }
  }
  if (group.routingRevision !== routingRevision) throw new Error('FIXED_TOPIC_CORRECTION_STALE')
  const selected = new Map(refs.map(ref => {
    const message = group.messages.find(item => item.messageId === ref.messageId)
    if (!message || message.messageVersion !== ref.messageVersion) throw new Error('FIXED_TOPIC_CORRECTION_STALE')
    if (!message.text && !message.imageRefs?.length) throw new Error('FIXED_TOPIC_CORRECTION_SOURCE_REQUIRED')
    return [ref.messageId, message]
  }))
  if (group.sourceDispatchOwnership.some(item => !item.settled && selected.has(item.sourceSnapshot.messageId))
    || group.outbox.some(item => item.status === 'pending' && [item.sourceMessageId, item.replyToMessageId, ...(item.matterSourceMessageIds ?? [])].some(id => selected.has(id)))) {
    throw new Error('FIXED_TOPIC_CORRECTION_BUSY')
  }
  const at = new Date().toISOString()
  // The hot task cache excludes archives. Retain topics with durable task audit
  // evidence as well; correction must not guess that an archived relationship vanished.
  const taskTopics = new Set(tasks.filter(task => task.groupId === group.groupId).flatMap(task => (task.topicRefs ?? []).map(ref => ref.topicId)))
  for (const topic of group.topics) {
    if (topic.migrationBaseline) taskTopics.add(topic.topicId)
    for (const record of topic.decisions) {
      if (record.operations.some(operation => operation.taskId)) taskTopics.add(topic.topicId)
      for (const action of record.decision.actions ?? []) if (action.taskId || action.kind === 'new-task') {
        taskTopics.add(topic.topicId)
        for (const ref of action.topicRefs ?? []) taskTopics.add(ref.topicId)
      }
    }
  }
  const topics = group.topics.map(topic => {
    const active = new Map()
    for (const entry of topic.entries) active.set(entry.unitId ?? `legacy:${entry.messageId}`, entry)
    const removed = [...active.values()].filter(entry => entry.action === 'add' && selected.has(entry.messageId))
    if (!removed.length) return topic
    if (topic.decisions.some(isPendingDecision)) throw new Error('FIXED_TOPIC_CORRECTION_BUSY')
    let revision = topic.revision
    const entries = [...topic.entries, ...removed.map(entry => ({ ...entry, action: 'remove', revision: ++revision, reason }))]
    const empty = [...active.values()].every(entry => entry.action === 'remove' || selected.has(entry.messageId))
    const close = empty && !taskTopics.has(topic.topicId)
    return { ...topic, entries, revision, updatedAt: at, ...(close ? { status: 'closed' } : {}),
      processedRevision: empty || topic.processedRevision === topic.revision ? revision : topic.processedRevision }
  })
  const messages = group.messages.map(message => {
    if (!selected.has(message.messageId)) return message
    const unit = { unitId: stableId('manual-fixed-unit', JSON.stringify([group.groupId, requestId, message.messageId])), unitRevision: 1,
      unitKey: 'manual-out-of-scope', summary: '职责外话题（人工归类纠正）', fixedTopic: 'out-of-scope', fixedTopicHandledAt: at,
      manualCorrection: { requestId, reason }, sourceRanges: message.text ? [{ start: 0, end: message.text.length, quote: message.text }] : [],
      sourceAttachments: (message.imageRefs ?? []).map(ref => ({ imageRefId: attachmentRefId(ref) })), contextRanges: [],
      predecessorUnitRefs: message.activeUnitRefs ?? [] }
    return { ...message, units: [...(message.units ?? []), unit], activeUnitRefs: [{ unitId: unit.unitId, unitRevision: 1 }],
      replyTopicId: undefined, ignoredRanges: [], routingStatus: 'routed', routingError: undefined,
      agentDeliveryStatus: 'delivered', agentDeliveryAt: at, agentDeliveryError: undefined, agentDecisionRetryAt: undefined }
  })
  const receipt = { routeId, requestId, fingerprint: digest, kind: 'manual-fixed-topic-correction', fixedTopic: 'out-of-scope',
    reply: 'silent', reason, routingRevision: routingRevision + 1, createdAt: at,
    sources: [...selected.values()].map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
      activeUnitRefs: message.activeUnitRefs ?? [], replyTopicId: message.replyTopicId, routingStatus: message.routingStatus,
      routingError: message.routingError, ignoredRanges: message.ignoredRanges, agentDeliveryStatus: message.agentDeliveryStatus,
      agentDeliveryError: message.agentDeliveryError, agentDeliveryAt: message.agentDeliveryAt, agentDecisionRetryAt: message.agentDecisionRetryAt })),
    closedTopicIds: topics.filter((topic, i) => topic.status === 'closed' && group.topics[i].status !== 'closed').map(topic => topic.topicId) }
  return { group: { ...group, messages, topics, routingRevision: routingRevision + 1, routeHistory: [...group.routeHistory, receipt] }, receipt }
}
