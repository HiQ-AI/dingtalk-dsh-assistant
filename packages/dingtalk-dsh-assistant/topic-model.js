import { createHash } from 'node:crypto'
import { z } from 'zod'

export const topicRefSchema = z.object({ topicId: z.string().min(1), revision: z.number().int().positive() }).strict()
export const unitRefSchema = z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()
export const sourceRangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict()
export const topicEntrySchema = z.object({ revision: z.number().int().positive(), messageId: z.string().min(1), messageVersion: z.number().int().positive(), unitId: z.string().min(1).optional(), unitRevision: z.number().int().positive().optional(), action: z.enum(['add', 'remove']), relationship: z.enum(['continuation', 'affected']).optional(), effectOwner: z.boolean().optional(), reason: z.string().optional() })
export const topicDecisionSchema = z.object({
  decisionId: z.string().min(1), revision: z.number().int().positive(), decision: z.record(z.string(), z.unknown()), fingerprint: z.string(),
  status: z.enum(['accepted', 'applying', 'failed', 'completed', 'rejected']), operations: z.array(z.record(z.string(), z.unknown())),
  outboundId: z.string().min(1), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
})
export const topicSchema = z.object({
  topicId: z.string().min(1), groupId: z.string().min(1), title: z.string().min(1), revision: z.number().int().nonnegative(), processedRevision: z.number().int().nonnegative(),
  status: z.enum(['active', 'waiting', 'closed']), summary: z.string(), summaryRevision: z.number().int().nonnegative(), openQuestions: z.array(z.string()),
  entries: z.array(topicEntrySchema), decisions: z.array(topicDecisionSchema), createdAt: z.string(), updatedAt: z.string(), migrationBaseline: z.boolean().optional(),
})
export const stableId = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const isPendingDecision = record => !['completed', 'rejected'].includes(record.status)

export function topicMessages(group, topic, revision) {
  if (!Number.isInteger(revision) || revision < 1 || revision > topic.revision) throw new Error('topic_revision_invalid')
  const refs = new Map()
  for (const entry of topic.entries) {
    if (entry.revision > revision) continue
    const entryUnitId = entry.unitId ?? `legacy:${entry.messageId}`
    const normalized = { ...entry, unitId: entryUnitId, unitRevision: entry.unitRevision ?? entry.messageVersion }
    if (entry.action === 'remove') refs.delete(entryUnitId)
    else refs.set(entryUnitId, normalized)
  }
  return [...refs].map(([unitId, entry]) => {
    const { messageId, messageVersion: version, unitRevision } = entry
    const current = group.messages.find((message) => message.messageId === messageId)
    const fact = current?.messageVersion === version ? current : current?.facts?.find((item) => item.messageVersion === version)
    if (!fact) throw new Error(`topic_message_fact_missing:${messageId}:${version}`)
    const unit = fact.units?.find((item) => item.unitId === unitId && item.unitRevision === unitRevision)
      ?? { unitId, unitRevision, unitKey: 'legacy-whole-message', summary: fact.text || '历史事项', sourceRanges: fact.text ? [{ start: 0, end: fact.text.length, quote: fact.text }] : [], sourceAttachments: (fact.imageRefs ?? []).map((ref) => ({ imageRefId: ref.id })), contextRanges: [] }
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
