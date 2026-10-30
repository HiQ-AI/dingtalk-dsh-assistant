import { ObserverMemoryPages } from './observer-memory-pages.js'
import { stableTaskResourceIdentity, mergeTaskResources } from './task-message-projections.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { activeFixedUnits, ensureFixedTopics, FIXED_TOPICS, fixedTopicIds, manuallySettled } from './fixed-topics.js'
import { createFixedTopicPages } from './observer-fixed-topic-pages.js'
import { correctOutOfScope } from './fixed-topic-correction.js'
import { personAliasesSchema } from './group-person-aliases.js'
import { taskPlanSchema } from './task-plan.js'
import { storedTaskCheckpointBaseSchema, storedTaskResultSchema } from './task-result.js'
import { topicSchema, topicRefSchema, topicMessages, topicMessageCount, validateTopicRefs, stableId, fingerprint, isPendingDecision, isWebTaskDecision, topicDecisionCoversEntry, sourceRangeSchema, attachmentRefId, resolveRouteBatch, webTaskTopicReusePlan, replyTopicForMessage } from './topic-model.js'
import { reviseTaskProgress, TaskRevisionError, normalizeRunPlan, stagePlanFor } from './task-input-revision.js'
import { PERFORMANCE_EVENT_TYPES, performanceProjectionSchema, performanceChunkKey, hasPerformanceFirstStream, projectPerformanceEvent, listPerformance, workflowPerformance, coordinationCosts } from './performance.js'

export { resolveTopicMessages } from './topic-model.js'

const missingText = (value) => typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'null'
// 撤销控制可以越过已停住的决策；原保留和未知操作仍留档，不能恢复成普通执行。
const blockedReservationsOnly = (group, taskId) => {
  const reservations = group.taskReservations.filter(item => item.taskId === taskId)
  return reservations.length > 0 && reservations.every(item => group.topics.some(topic => topic.decisions.some(record => record.decisionId === item.decisionId && record.status === 'blocked')))
}
// 先验证完整替换图，再派生唯一后继；发送事实与停止旧意图发送分别保存。
export function reconcileReplacementGraph(outbox) {
  const byId = new Map(outbox.map(item => [item.outboundId, item]))
  if (byId.size !== outbox.length) throw new Error('outbox_identity_duplicate')
  const successorsById = new Map()
  for (const candidate of outbox) for (const target of candidate.replacesOutboundIds ?? []) {
    const successors = successorsById.get(target) ?? new Set()
    successors.add(candidate.outboundId)
    successorsById.set(target, successors)
  }
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) throw new Error('outbox_replacement_cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of byId.get(id).replacesOutboundIds ?? []) {
      if (!byId.has(target)) throw new Error(`group_reply_replacement_unknown:${target}`)
      visit(target)
    }
    visiting.delete(id); visited.add(id)
  }
  for (const id of byId.keys()) visit(id)
  const reaches = (from, target) => (byId.get(from).replacesOutboundIds ?? []).some(id => id === target || reaches(id, target))
  const now = new Date().toISOString()
  return outbox.map(item => {
    const successors = [...(successorsById.get(item.outboundId) ?? [])]
    if (item.supersededByOutboundId) {
      if (!byId.has(item.supersededByOutboundId) || !reaches(item.supersededByOutboundId, item.outboundId)) throw new Error('outbox_replacement_successor_invalid')
      successors.push(item.supersededByOutboundId)
    }
    for (const left of successors) for (const right of successors) {
      if (left !== right && !reaches(left, right) && !reaches(right, left)) throw new Error('outbox_replacement_fork')
    }
    const successor = item.supersededByOutboundId ?? successors.find(id => successors.every(other => id === other || reaches(other, id)))
    return successor ? { ...item, status: item.status === 'pending' ? 'superseded' : item.status, supersededByOutboundId: successor, supersededAt: item.supersededAt ?? now } : item
  })
}
const replacementBusy = (group, replacesOutboundIds, decisionId) => replacesOutboundIds.length > 0 && (
  group.outbox.some((outbound) => outbound.status === 'pending' && !replacesOutboundIds.includes(outbound.outboundId) && (outbound.replacesOutboundIds ?? []).some((id) => replacesOutboundIds.includes(id)))
  || group.topics.some((topic) => topic.decisions.some((record) => isPendingDecision(record) && record.decisionId !== decisionId
    && (record.decision.replyReview?.replaceOutboundIds ?? []).some((id) => replacesOutboundIds.includes(id))))
)

const quotedMessageSchema = z.object({ messageId: z.string().min(1).optional(), senderName: z.string().min(1).optional(), occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(), content: z.string() })
const messageFactFields = {
  replyTopicId: z.string().min(1).optional(),
  mentionedAgent: z.boolean().optional(),
  taskSessionRefs: z.array(z.string().min(1)).optional(),
  resourceRefs: z.array(z.record(z.string(), z.unknown())).optional(),
  messageVersion: z.number().int().positive(), imageRefs: z.array(z.record(z.string(), z.unknown())).optional(), mediaUnavailable: z.array(z.string()).optional(),
  sourceKind: z.enum(['dingtalk', 'web', 'internal', 'migration']).optional(), migrationSource: z.string().optional(),
  ignoredRanges: z.array(sourceRangeSchema.extend({ reason: z.string().min(1) })).optional(),
  units: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive(), unitKey: z.string().min(1), fixedTopic: z.enum(fixedTopicIds).optional(), outOfScopeHelp: z.boolean().optional(), fixedTopicHandledAt: z.string().optional(), manualCorrection: z.object({ requestId: z.string().min(1), reason: z.string().min(1) }).optional(), dispatchOwner: z.enum(['legacy-topic', 'coordination']).optional(), summary: z.string().min(1), sourceRanges: z.array(sourceRangeSchema), sourceAttachments: z.array(z.object({ imageRefId: z.string().min(1) }).strict()).default([]), contextRanges: z.array(sourceRangeSchema.extend({ purpose: z.string().min(1) })).default([]), predecessorUnitRefs: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()).default([]), effectInheritance: z.enum(['inherit', 'new-scope']).optional(), revisionReason: z.string().min(1).optional() }).refine((unit) => unit.sourceRanges.length + unit.sourceAttachments.length > 0, 'topic_unit_source_required')).optional(),
  activeUnitRefs: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()).optional(),
}
const inboundSchema = z.object({
  ...messageFactFields, facts: z.array(z.record(z.string(), z.unknown())).default([]), routingStatus: z.enum(['pending', 'routed', 'failed']).default('pending'), routingError: z.string().optional(),
  messageId: z.string().min(1), sequence: z.number().int().positive(), text: z.string(), occurredAt: z.union([z.string().min(1), z.number().finite()]),
  messageAiSendFlag: z.literal('DWS').optional(),
  senderName: z.string().min(1).optional(), senderOpenDingTalkId: z.string().min(1).optional(), quotedMessage: quotedMessageSchema.optional(),
  agentDeliveryStatus: z.enum(['pending', 'steered', 'delivered', 'failed', 'decision-retrying', 'decision-failed', 'decision-commit-failed', 'skipped']).optional(),
  agentDeliveryAt: z.string().min(1).optional(), agentDeliveryError: z.string().min(1).optional(),
  agentDecisionAttemptCount: z.number().int().nonnegative().optional(), agentDecisionRetryAt: z.string().min(1).optional(),
})
const outboundSchema = z.object({
  replyTopicId: z.string().optional(), coveredEventIds: z.array(z.string()).optional(),
  topicRefs: z.array(topicRefSchema).optional(), decisionId: z.string().optional(), resultFingerprint: z.string().min(1).optional(),
  outboundId: z.string().min(1), sourceMessageId: z.string().min(1), text: z.string(), status: z.enum(['pending', 'sent', 'superseded']),
  taskInputVersion: z.number().int().positive().optional(), taskRunSequence: z.number().int().positive().optional(),
  supersededByOutboundId: z.string().min(1).optional(), supersededAt: z.string().min(1).optional(), supersededReason: z.string().min(1).optional(), sendStartedAt: z.string().min(1).optional(),
  readbackRequired: z.boolean().optional(),
  notificationState: z.enum(['prepared','starting','unknown','delivered','failed','superseded']).optional(),
  notificationRetryAt: z.string().optional(), notificationFailurePhase: z.enum(['send', 'readback']).optional(), notificationKnownNotSent: z.boolean().optional(),
  notificationTaskId: z.string().min(1).optional(),
  notificationRecovery: z.object({ action: z.enum(['send', 'readback']).nullable(), expectedToken: z.string().regex(/^[a-f0-9]{64}$/u), reason: z.string() }).optional(),
  deliveryAttemptCount: z.number().int().nonnegative().optional(), deliveryAttemptedAt: z.string().min(1).optional(),
  sendAttemptCount: z.number().int().nonnegative().optional(), readbackAttemptCount: z.number().int().nonnegative().optional(),
  deliveryPendingReason: z.string().min(1).optional(), deliveryError: z.string().min(1).optional(),
  deliveryBlockedAt: z.string().min(1).optional(),
  deliveredMessageId: z.string().min(1).optional(), deliveredAt: z.string().min(1).optional(), sentAt: z.string().datetime().optional(),
  sendReceipt: z.object({ openTaskId: z.string().min(1), conversationId: z.string().min(1), messageId: z.string().min(1) }).strict().optional(),
  replyToMessageId: z.string().min(1).optional(), replyToSenderOpenDingTalkId: z.string().min(1).optional(),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional(), atAll: z.boolean().optional(),
  sourceRef: z.object({ messageId: z.string().min(1), actorId: z.string().min(1), messageVersion: z.number().int().positive() }).strict().optional(),
  artifactFiles: z.array(z.object({ artifact: z.record(z.string(), z.unknown()), caption: z.string().min(1) })).optional(),
  replyKind: z.enum(['confirmation', 'substantive', 'correction']).optional(),
  matterSourceMessageIds: z.array(z.string().min(1)).optional(), matterUnitRefs: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()).optional(), taskIds: z.array(z.string().min(1)).optional(),
  replacesOutboundIds: z.array(z.string().min(1)).optional(),
  recallStatus: z.enum(['requested', 'recalled', 'failed']).optional(), recallReason: z.string().min(1).optional(),
  recalledAt: z.string().min(1).optional(), recallError: z.string().min(1).optional(),
  recallAttemptCount: z.number().int().nonnegative().optional(), recallRetryAt: z.string().min(1).optional(),
})
const legacyWaitingResultSchema = z.object({
  inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(),
  status: z.literal('waiting'), summary: z.string().min(1), evidence: z.array(z.string()), artifacts: z.array(z.string()), waitingReason: z.string().min(1),
}).strict()
const historicalCoordinationResultSchema = z.object({
  inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), submissionId: z.string().optional(),
  status: z.literal('waiting'), waitingKind: z.literal('coordination'), summary: z.string().min(1),
  evidence: z.array(z.string()), artifacts: z.array(z.string()), waitingReason: z.string().min(1), request: z.string().min(1),
}).strict()
const persistedTaskResultSchema = z.union([storedTaskResultSchema, historicalCoordinationResultSchema, legacyWaitingResultSchema])
const humanBlockerSchema = z.object({
  requestId: z.string().min(1), fingerprint: z.string().min(1).optional(), category: z.enum(['redline', 'network', 'disk', 'resource', 'unexpected', 'human-decision']),
  runSequence: z.number().int().positive().optional(),
  requestedAction: z.string().min(1), status: z.enum(['pending-send', 'waiting-reply', 'answered', 'superseded']),
  waitingReason: z.string().min(1).optional(), risk: z.string().min(1).optional(), evidence: z.array(z.string().min(1)).optional(), attemptedActions: z.array(z.string().min(1)).optional(), createdAt: z.string().min(1).optional(),
  formatVersion: z.number().int().positive().optional(),
  openTaskId: z.string().min(1).optional(), conversationId: z.string().min(1).optional(), messageId: z.string().min(1).optional(), sentAt: z.string().min(1).optional(),
  replyMessageId: z.string().min(1).optional(), reply: z.string().min(1).optional(), decision: z.enum(['approved', 'rejected']).optional(),
  decisionSource: z.enum(['web', 'dingtalk', 'migration', 'runtime']).optional(), decidedAt: z.string().min(1).optional(),
  recallStatus: z.enum(['pending', 'recalled', 'failed', 'not-required']).optional(), recalledAt: z.string().min(1).optional(), recallError: z.string().min(1).optional(),
  supersededAt: z.string().min(1).optional(), supersededBy: z.string().min(1).optional(), supersedeReason: z.string().min(1).optional(),
})
const sourceDispatchSchema = z.object({
  reservationId: z.string().min(1), unitId: z.string().min(1), unitRevision: z.number().int().positive(),
  generation: z.number().int().positive(), dispatchOwner: z.enum(['coordination', 'legacy-topic']),
  semanticState: z.enum(['reserved', 'needs_clarification', 'accepted', 'rejected']), settled: z.boolean(),
  sourceSnapshot: z.record(z.string(), z.unknown()), coordinationId: z.string().min(1).optional(),
  clarification: z.string().min(1).optional(), frozen: z.boolean().default(false),
  retirement: z.object({ kind: z.literal('feature-removed'), reason: z.string().min(1), at: z.string().min(1) }).optional(),
  handoff: z.record(z.string(), z.unknown()).optional(), history: z.array(z.record(z.string(), z.unknown())).default([]),
  createdAt: z.string().min(1), updatedAt: z.string().min(1),
})
const groupSchema = z.object({
  personAliases: personAliasesSchema.optional(),
  fixedTopics: z.array(z.object({ topicId: z.enum(fixedTopicIds), title: z.string().min(1), fixed: z.literal(true), createdAt: z.string().min(1) })).optional(),
  sourceDispatchOwnership: z.array(sourceDispatchSchema).default([]),
  coordinationRequests: z.record(z.string(), z.object({ attempt: z.number().int().nonnegative().default(0), resumeEpoch: z.number().int().nonnegative().default(0), updatedAt: z.string().optional(), nextRetryAt: z.string().optional(), status: z.enum(['pending', 'exhausted', 'completed', 'superseded']), messageId: z.string().optional(), lastError: z.string().optional(), failurePhase: z.enum(['startup', 'dispatch']).optional(), failureCode: z.string().optional(), startupAttempt: z.number().int().nonnegative().optional(), supersededBy: z.string().optional(), supersedeReason: z.string().optional() })).default({}),
  groupId: z.string().min(1), name: z.string().optional(), timezone: z.string().optional(), responsibility: z.string(), residentSessionId: z.string().min(1), residentAgentPreset: z.string().min(1).optional(), nextSequence: z.number().int().positive(),
  messages: z.array(inboundSchema), outbox: z.array(outboundSchema),
  routingRevision: z.number().int().nonnegative(), topics: z.array(topicSchema), routeHistory: z.array(z.record(z.string(), z.unknown())), taskReservations: z.array(z.record(z.string(), z.unknown())),
})
const taskObjectiveRevisionSchema = z.object({ objective: z.string().min(1), revisedAt: z.string().min(1), topicRefs: z.array(topicRefSchema).optional(), inputVersion: z.number().int().positive().optional(), decisionId: z.string().optional() })
const taskTitleRevisionSchema = z.object({ title: z.string().min(1), revisedAt: z.string().min(1), inputVersion: z.number().int().positive().optional(), runSequence: z.number().int().positive().optional(), decisionId: z.string().optional() })
const taskPromptSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(400), prompt: z.string().trim().min(1).max(40000), enabled: z.boolean(), revision: z.number().int().positive() })
const taskPromptRefSchema = z.object({ id: z.string().min(1), revision: z.number().int().positive() })
const persistedTaskCheckpointSchema = storedTaskCheckpointBaseSchema.extend({
  checkpointId: z.string().min(1), submittedAt: z.string().min(1),
  coordinatorDecision: z.enum(['acknowledge', 'guidance', 'reject']).optional(), coordinatorReason: z.string().min(1).optional(), guidance: z.string().min(1).optional(), reviewedAt: z.string().min(1).optional(),
})
const taskRunSchema = z.object({
  plan: taskPlanSchema.optional(), outcome: z.enum(['succeeded', 'cancelled', 'failed', 'legacy-unknown']).optional(),
  runSequence: z.number().int().positive(), startedAt: z.string().min(1), endedAt: z.string().min(1).optional(),
  topicRefs: z.array(topicRefSchema), inputVersion: z.number().int().positive(), title: z.string().min(1).optional(), objective: z.string().min(1), childSessionId: z.string().min(1),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)), stageTasks: z.array(z.string().min(1)), taskPromptRefs: z.array(taskPromptRefSchema).optional(), checkpoints: z.array(persistedTaskCheckpointSchema).optional(), result: persistedTaskResultSchema.optional(),
})
const taskStateEventSchema = z.object({ state: z.enum(['queued', 'running', 'waiting', 'completed']), waitingKind: z.enum(['information', 'coordination', 'human-intervention', 'system']).optional(), at: z.string().min(1), runSequence: z.number().int().positive() })
const taskWorktreeDocumentSchema = z.object({ source: z.string().min(1), archivePath: z.string().min(1).optional(), sha256: z.string().min(1).optional() })
const taskWorktreeSchema = z.object({
  path: z.string().min(1), repositoryRoot: z.string().min(1), gitDir: z.string().min(1), head: z.string().min(1),
  branch: z.string().optional(), originUrl: z.string().optional(), ownerTaskId: z.string().min(1),
  createdByTask: z.boolean(), runSequence: z.number().int().positive(), registeredAt: z.string().min(1),
  status: z.enum(['registered', 'cleaned']), documents: z.array(taskWorktreeDocumentSchema),
  cleanedAt: z.string().min(1).optional(),
})
const archiveCleanupSchema = z.object({ status: z.enum(['pending', 'running', 'failed', 'completed']), error: z.string().optional(), updatedAt: z.string().min(1) })
const activityProjectionSchema = z.object({
  lastSyncedAt: z.string(), latestEventKey: z.string().optional(), latestOccurredAt: z.string().optional(),
  truncated: z.boolean().default(false),
  sessions: z.record(z.string(), z.object({ lastSeq: z.number().int().nonnegative().optional() })).default({}),
  retentionFloor: z.object({ occurredAt: z.string(), sessionId: z.string(), eventKey: z.string() }).optional(),
  aggregate: z.object({
    total: z.number().int().nonnegative(),
    days: z.record(z.string(), z.object({ total: z.number().int().nonnegative(), byType: z.record(z.string(), z.number().int().nonnegative()) })),
    retainedEventKeys: z.array(z.string()),
    coverage: z.enum(['complete', 'retained-only']),
  }).optional(),
})
const taskSchema = z.object({
  contractVersion: z.literal(2).optional(), plan: taskPlanSchema.optional(), planHistory: z.array(taskPlanSchema).optional(), retiredPlanIds: z.array(z.string()).default([]),
  outcome: z.enum(['succeeded', 'cancelled', 'failed', 'legacy-unknown']).optional(),
  notificationIntents: z.array(z.strictObject({ intentId: z.string().min(1), outboundId: z.string().min(1), inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), resultFingerprint: z.string().min(1), sourceMessageId: z.string().min(1), status: z.enum(['pending', 'enqueued', 'delivered', 'superseded', 'blocked']), outbound: z.record(z.string(), z.unknown()).optional(), createdAt: z.string().min(1), updatedAt: z.string().min(1), lastError: z.string().optional() })).default([]),
  stopRequest: z.strictObject({ status: z.enum(['requested', 'reconciling', 'settled']), reason: z.string().min(1), requestedAt: z.string().min(1), settledAt: z.string().min(1).optional(), inputVersion: z.number().int().positive(), runSequence: z.number().int().positive() }).optional(),
  migrationReview: z.strictObject({ status: z.literal('required'), reason: z.string().min(1), candidate: z.record(z.string(), z.unknown()) }).optional(),
  taskId: z.string().min(1), groupId: z.string().min(1), topicRefs: z.array(topicRefSchema).min(1), inputVersion: z.number().int().positive(), appliedOperations: z.array(z.string()).default([]), title: z.string().min(1).optional(), objective: z.string().min(1),
  state: z.enum(['queued', 'running', 'waiting', 'completed']), childSessionId: z.string().min(1),
  waitingReason: z.string().optional(), waitingKind: z.enum(['information', 'coordination', 'human-intervention', 'system']).optional(),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  objectiveHistory: z.array(taskObjectiveRevisionSchema).optional(), titleHistory: z.array(taskTitleRevisionSchema).optional(),
  runSequence: z.number().int().positive().optional(), runStartedAt: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional(), taskPromptRefs: z.array(taskPromptRefSchema).optional(), runHistory: z.array(taskRunSchema).optional(),
  executionEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  stagePlan: z.array(z.object({ stageId: z.string().min(1), title: z.string().min(1) })).optional(),
  activityProjection: activityProjectionSchema.optional(),
  dispatchedInputVersion: z.number().int().positive().optional(), acknowledgedInputVersion: z.number().int().positive().optional(),
  checkpoints: z.array(persistedTaskCheckpointSchema).optional(),
  humanBlocker: humanBlockerSchema.optional(), humanBlockerHistory: z.array(humanBlockerSchema).optional(),
  completion: z.string().optional(), result: persistedTaskResultSchema.optional(), lastWaitingResult: persistedTaskResultSchema.optional(), lastCompletedResult: persistedTaskResultSchema.optional(),
  completionSequence: z.number().int().nonnegative().optional(),
  localWorktrees: z.array(taskWorktreeSchema).default([]), archiveCleanup: archiveCleanupSchema.optional(),
  stateHistory: z.array(taskStateEventSchema).optional(),
  reopenContext: z.string().min(1).optional(), resumeContext: z.string().min(1).optional(), archivedAt: z.string().min(1).optional(), createdAt: z.string().min(1), updatedAt: z.string().min(1),
})
const platformScheduleSchema = z.object({
  sessionId: z.string().min(1), requestId: z.string().min(1), groupId: z.string().min(1), messageId: z.string().min(1),
  messageVersion: z.number().int().positive(), unitId: z.string().min(1), unitRevision: z.number().int().positive(),
  timezone: z.string().min(1), title: z.string().min(1).max(120), prompt: z.string().min(1).max(8000), at: z.string().datetime(),
  scheduleId: z.string().optional(), outcome: z.enum(['replied', 'expired', 'superseded']).optional(), completedAt: z.string().optional(),
})
const schedulerSchema = z.object({
  platformSchedule: platformScheduleSchema.optional(),
  executionBackend: z.enum(['dsh', 'claude-code']).optional(),
  taskSessionModel: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningMode: z.enum(['inherit', 'model-default', 'explicit']), reasoningEffort: z.string().nullable() }).optional(),
  coordinationModel: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningMode: z.enum(['inherit', 'model-default', 'explicit']), reasoningEffort: z.string().nullable() }).optional(),
  performanceProjection: performanceProjectionSchema.optional(),
  tasks: z.array(taskSchema), groupConfigurationInitialized: z.boolean().optional(), agentNames: z.array(z.string().min(1)).optional(), replySignature: z.string().max(80).optional(), timezone: z.string().optional(), agentWorkspaceDir: z.string().optional(), taskWorkspaceDir: z.string().optional(), proxyUrl: z.string().optional(),
  leafSessionPrompt: z.string().optional(), taskPrompts: z.array(taskPromptSchema).optional(), taskPromptsVersion: z.number().int().nonnegative().optional(), taskExecutionGuidance: z.string().optional(), taskEvidenceGuidance: z.string().optional(), maxConcurrentTasks: z.number().int().positive().max(50).optional(),
  // 已移除任务表格同步；仅保留历史字段声明，避免读取旧数据时剥离配置和状态。
  taskSheetSyncConfig: z.object({ enabled: z.boolean(), documentUrl: z.string().url(), nodeId: z.string().min(1), documentName: z.string().min(1), sheetId: z.string().min(1), sheetTitle: z.string().min(1), intervalMs: z.literal(180000) }).optional(),
  taskSheetSyncStatus: z.object({ state: z.enum(['idle', 'running', 'success', 'failed']), trigger: z.enum(['startup', 'timer', 'manual']).optional(), lastAttemptAt: z.string().optional(), lastSuccessAt: z.string().optional(), snapshotAt: z.string().optional(), batchId: z.string().optional(), taskCount: z.number().int().nonnegative().optional(), lastError: z.string().optional() }).optional(),
})
const activitySchema = z.object({
  activityId: z.string().min(1), taskId: z.string().min(1), sessionId: z.string().min(1), eventKey: z.string().min(1),
  type: z.string().min(1), detail: z.record(z.string(), z.unknown()), occurredAt: z.string().min(1),
  seq: z.number().int().nonnegative().optional(),
})
const alertSchema = z.object({
  alertId: z.string().min(1), taskId: z.string().min(1), fingerprint: z.string().min(1), detail: z.string().min(1),
  count: z.number().int().positive(), firstSeenAt: z.string().min(1), lastSeenAt: z.string().min(1),
  status: z.enum(['active', 'resolved']).optional(), resolvedAt: z.string().min(1).optional(),
})
const ACTIVITY_PROJECTION_LIMIT_PER_TASK = 500
const activityTime = (occurredAt) => Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(occurredAt)
  ? `${occurredAt.replace(' ', 'T')}+08:00` : occurredAt)
const compareActivity = (a, b) => activityTime(a.occurredAt) - activityTime(b.occurredAt) || a.sessionId.localeCompare(b.sessionId) || a.eventKey.localeCompare(b.eventKey)
const activityDayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const activityDay = (occurredAt) => activityDayFormatter.format(activityTime(occurredAt))
const countActivity = (aggregate, activity) => {
  const day = activityDay(activity.occurredAt)
  const current = aggregate.days[day] ?? { total: 0, byType: {} }
  return {
    ...aggregate, total: aggregate.total + 1,
    days: { ...aggregate.days, [day]: { total: current.total + 1, byType: { ...current.byType, [activity.type]: (current.byType[activity.type] ?? 0) + 1 } } },
  }
}

export const residentDomainSpec = defineDomain({
  name: 'dingtalk_dsh_assistant', version: 9, tables: {
    groups: domainTable(groupSchema), scheduler: domainTable(schedulerSchema), tasks: domainTable(taskSchema), alerts: domainTable(alertSchema), activities: domainTable(activitySchema),
  },
})

export function sourceDispatchOwnershipFor(group, unit) {
  return (group.sourceDispatchOwnership ?? []).find(item => item.unitId === unit.unitId && item.unitRevision === unit.unitRevision)
}
const coordinationOwns = (group, unit) => sourceDispatchOwnershipFor(group, unit)?.dispatchOwner === 'coordination'
const decisionUnitRefs = (group, decision) => decision.basisUnitRefs?.length ? decision.basisUnitRefs
  : group.messages.filter(message => decision.basisMessageIds?.includes(message.messageId)).flatMap(message => message.activeUnitRefs ?? message.units ?? [])
function assertLegacyDecisionOwnership(group, decision) {
  if (decisionUnitRefs(group, decision).some(ref => coordinationOwns(group, ref))) throw new Error('source_dispatch_owned_by_coordination')
}
function reserveSourceDispatchRecord(group, message, unit) {
  const previous = sourceDispatchOwnershipFor(group, unit)
  if (previous) {
    if (previous.dispatchOwner !== 'coordination') throw new Error('source_dispatch_legacy_owned')
    return previous
  }
  if (group.topics.some(topic => topic.decisions.some(record => record.status !== 'rejected'
    && decisionUnitRefs(group, record.decision).some(ref => ref.unitId === unit.unitId && ref.unitRevision === unit.unitRevision)))) {
    throw new Error('source_dispatch_legacy_decision_exists')
  }
  const stamp = new Date().toISOString()
  return sourceDispatchSchema.parse({ reservationId: stableId('source-dispatch', `${group.groupId}:${unit.unitId}:${unit.unitRevision}`),
    unitId: unit.unitId, unitRevision: unit.unitRevision, generation: 1, dispatchOwner: 'coordination', semanticState: 'reserved', settled: false,
    sourceSnapshot: { messageId: message.messageId, messageVersion: message.messageVersion, text: message.text,
      ...(message.quotedMessage ? { quotedMessage: JSON.parse(JSON.stringify(message.quotedMessage)) } : {}),
      ...(message.resourceRefs ? { resourceRefs: JSON.parse(JSON.stringify(message.resourceRefs)) } : {}),
      ...(message.imageRefs ? { imageRefs: JSON.parse(JSON.stringify(message.imageRefs)) } : {}),
      unitText: unit.sourceRanges.map(range => message.text.slice(range.start, range.end)).join('\n'),
      sourceRefs: unit.sourceRanges, unit: JSON.parse(JSON.stringify(unit)),
      ...(message.senderOpenDingTalkId ? { actorId: message.senderOpenDingTalkId } : {}),
      ...(message.senderName ? { senderName: message.senderName } : {}), occurredAt: message.occurredAt }, createdAt: stamp, updatedAt: stamp })
}

function settleCompletedMessageDeliveries(messages, topics, sourceDispatchOwnership = []) {
  const deliveredAt = new Date().toISOString()
  return messages.map((message) => {
    const owned = sourceDispatchOwnership.filter(item => item.dispatchOwner === 'coordination'
      && item.sourceSnapshot.messageId === message.messageId && (message.activeUnitRefs ?? []).some(ref => ref.unitId === item.unitId && ref.unitRevision === item.unitRevision))
    if (activeFixedUnits(message).length) return { ...message, agentDeliveryStatus: 'pending' }
    if (owned.some(item => !item.settled)) return { ...message, agentDeliveryStatus: 'pending' }
    if (message.routingStatus !== 'routed' || ['delivered', 'skipped'].includes(message.agentDeliveryStatus)) return message
    const activeEntries = topics.flatMap((topic) => {
      const latestByUnit = new Map()
      for (const entry of topic.entries) if (entry.messageId === message.messageId) latestByUnit.set(entry.unitId, entry)
      return [...latestByUnit.values()].filter((entry) => entry.action === 'add' && entry.messageVersion === message.messageVersion).map((entry) => ({ topic, entry }))
    })
    if (activeEntries.some(({ topic, entry }) => !sourceDispatchOwnership.some(item => item.unitId === entry.unitId && item.unitRevision === entry.unitRevision && item.dispatchOwner === 'coordination') && topic.processedRevision < entry.revision)) return message
    const { agentDeliveryError: _error, agentDecisionRetryAt: _retryAt, ...current } = message
    return { ...current, agentDeliveryStatus: 'delivered', agentDeliveryAt: deliveredAt }
  })
}

function recoverWebSkippedTopicInputs(group) {
  const messages = new Map(group.messages.map(message => [message.messageId, message]))
  const topics = group.topics.map(topic => {
    if (topic.mergedInto) return topic
    const completed = topic.decisions.filter(record => record.status === 'completed')
    const web = completed.filter(isWebTaskDecision)
    if (!web.length) return topic
    const latest = new Map()
    for (const entry of topic.entries) latest.set(entry.unitId ?? `legacy:${entry.messageId}`, entry)
    const skipped = [...latest.values()].filter(entry => {
      const message = messages.get(entry.messageId)
      return entry.action === 'add' && entry.reason !== 'migration-baseline' && entry.revision <= topic.processedRevision
        && message?.messageVersion === entry.messageVersion && !manuallySettled(message)
        && (!message.activeUnitRefs || message.activeUnitRefs.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision))
        && !group.sourceDispatchOwnership?.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision && ref.dispatchOwner === 'coordination')
        && web.some(record => record.revision >= entry.revision) && !completed.some(record => topicDecisionCoversEntry(record, entry))
    })
    // Repair only a provable Web overrun. Keep all decisions/effects and let the
    // normal coordinator judge the current inputs; never manufacture a conclusion.
    return skipped.length ? { ...topic, processedRevision: Math.min(...skipped.map(entry => entry.revision)) - 1 } : topic
  })
  return topics.some((topic, index) => topic !== group.topics[index]) ? { ...group, topics } : group
}

export function taskSessionId(taskId) {
  if (typeof taskId !== 'string' || !taskId.startsWith('task-')) throw new Error(`task_id_invalid:${taskId}`)
  return `session-${taskId}`
}

const cleanRequiredList = (value, error) => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(error)
  return value.map((item) => item.trim())
}
const validateTaskMetadata = ({ title, objective, acceptanceCriteria }) => {
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.startsWith('[TASK_SOURCE_EVIDENCE]')) throw new Error('task_title_invalid')
  if (typeof objective !== 'string' || !objective.trim() || objective.startsWith('[TASK_SOURCE_EVIDENCE]')) throw new Error('task_objective_invalid')
  return { title: title.trim(), objective: objective.trim(), acceptanceCriteria: cleanRequiredList(acceptanceCriteria, 'task_acceptance_criteria_required') }
}
const assertTaskRevisionMetadata = (task, action) => {
  if (!['task-context', 'task-reopen'].includes(action.kind)) return
  const objective = typeof action.objective === 'string' ? action.objective.trim() : ''
  const title = typeof action.title === 'string' ? action.title.trim() : ''
  const objectiveChanged = Boolean(objective && objective !== task.objective)
  if (title && !objectiveChanged) throw new Error('task_title_requires_objective_revision')
  if (objectiveChanged && !title) throw new Error('task_objective_title_required')
  if (action.kind === 'task-reopen') stagePlanFor({ taskId: task.taskId, runSequence: task.runSequence + 1 }, normalizeRunPlan(objective || task.objective, action.acceptanceCriteria, action.stageTasks).stageTasks)
}
const assertNewTaskMetadata = action => {
  const metadata = validateTaskMetadata(action)
  stagePlanFor({ taskId: 'new-task', runSequence: 1 }, normalizeRunPlan(metadata.objective, metadata.acceptanceCriteria, action.stageTasks).stageTasks)
}

// 接纳和恢复共用执行层的纯校验；必须在任何预约或渠道副作用之前调用。
export function assertTaskContextRevision(task, action, basisIds) {
  assertTaskRevisionMetadata(task, action)
  if (action.kind === 'task-context') {
    const objective = action.objective?.trim() || task.objective
    reviseTaskProgress(task, { ...action, objective, ...normalizeRunPlan(objective, action.acceptanceCriteria ?? task.acceptanceCriteria, action.stageTasks ?? task.stageTasks) }, basisIds)
  }
}
const taskRevisionBasis = (group, task, action) => {
  const refs = [...new Map([...task.topicRefs, ...action.topicRefs ?? []].map(ref => [ref.topicId, ref])).values()]
  return new Set(refs.flatMap(ref => topicMessages(group, group.topics.find(topic => topic.topicId === ref.topicId), ref.revision).map(message => message.messageId)))
}


function taskTiming(task, activities, now = Date.now()) {
  const runSequence = task.runSequence ?? 1
  const startedAt = Date.parse(task.runStartedAt ?? task.createdAt)
  const stateEvents = (task.stateHistory ?? []).filter((event) => event.runSequence === runSequence).sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const completedAt = [...stateEvents].reverse().find((event) => event.state === 'completed')?.at
  const endedAt = completedAt ? Date.parse(completedAt) : task.state === 'completed' ? Date.parse(task.updatedAt) : now
  const totals = { queuedMs: 0, runningMs: 0, waitingMs: 0 }
  let complete = Number.isFinite(startedAt) && stateEvents.length > 0 && Date.parse(stateEvents[0].at) <= startedAt
  for (let index = 0; index < stateEvents.length; index += 1) {
    const event = stateEvents[index]
    const from = Math.max(startedAt, Date.parse(event.at))
    const to = Math.min(endedAt, index + 1 < stateEvents.length ? Date.parse(stateEvents[index + 1].at) : endedAt)
    const key = `${event.state}Ms`
    if (key in totals && Number.isFinite(from) && Number.isFinite(to) && to >= from) totals[key] += to - from
  }
  const calls = new Map()
  let toolMs = 0
  let toolIdentityMissing = false
  const runActivities = activities
    .filter((item) => item.taskId === task.taskId && item.sessionId === task.childSessionId)
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
  for (const activity of runActivities) {
    const at = Date.parse(activity.occurredAt)
    if (!Number.isFinite(at) || at < startedAt) continue
    const callId = activity.detail?.callId
    if (activity.type === 'tool/call') {
      if (at > endedAt) continue
      if (!callId) toolIdentityMissing = true
      else calls.set(callId, at)
    }
    if (activity.type === 'tool/result') {
      if (at <= endedAt && !callId) toolIdentityMissing = true
      if (callId && calls.has(callId)) { toolMs += Math.max(0, Math.min(at, endedAt) - calls.get(callId)); calls.delete(callId) }
    }
  }
  if (calls.size > 0 || toolIdentityMissing) complete = false
  return {
    runSequence, complete, wallMs: Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : 0,
    ...totals, toolMs, unclassifiedRunningMs: Math.max(0, totals.runningMs - toolMs),
    missing: [...(!stateEvents.length ? ['state-history'] : []), ...(calls.size || toolIdentityMissing ? ['unpaired-tool-events'] : [])],
  }
}

export async function openResidentStore(storageDomain) {
  const domain = await storageDomain.open(residentDomainSpec)
  const groupTable = domain.table('groups')
  const groupCommitted = new Set()
  const fixedTopicPages = createFixedTopicPages(groupId => findGroupEntry(groupId)?.[1])
  const groups = new Proxy(groupTable, { get(target, name) {
    if (name === 'put' || name === 'update') return async (key, value) => {
      const previous = target.get(key)
      let next = value
      const result = await target[name](key, name === 'update' ? current => { next = value(current); return next } : value)
      fixedTopicPages.update(target.get(key))
      for (const listener of groupCommitted) listener({ previous, next, group: target.get(key) })
      return result
    }
    if (name === 'delete') return async key => {
      const groupId = target.get(key)?.groupId, result = await target.delete(key)
      if (result) fixedTopicPages.remove(groupId)
      if (result) for (const listener of groupCommitted) listener({ removed: groupId })
      return result
    }
    return Reflect.get(target, name)
  } })
  for (const [key, group] of groups.entries()) {
    const recovered = recoverWebSkippedTopicInputs(ensureFixedTopics(group))
    if (recovered !== group) await groups.update(key, () => recovered)
    else fixedTopicPages.update(group)
  }
  const topicPages = new ObserverMemoryPages(),topicPageScopes=new Map()
  const scheduler = domain.table('scheduler')
  const tasks = domain.table('tasks')
  let taskSessionReader
  const currentTask = id => taskSessionReader ? taskSessionReader.getTask(id) : tasks.get(id)
  const currentTasks = () => taskSessionReader ? taskSessionReader.listTasks() : [...tasks.entries()].map(([, task]) => task)
  // A cancelled task can reject context before any write. Reopen may supersede
  // only that proven-unapplied decision; its original messages still need review.
  async function inactiveTaskContexts(group, taskId) {
    if (!taskSessionReader?.hasAppliedOperation) return new Set()
    const task = currentTask(taskId), ids = new Set()
    if (!task || task.groupId !== group.groupId) return ids
    for (const topic of group.topics) for (const record of topic.decisions) {
      const operation = record.operations[0], action = record.decision.actions?.[0]
      if (record.status !== 'blocked' || record.error !== 'DYNAMIC_TASK_NOT_ACTIVE' || record.operations.length !== 1
        || record.decision.actions.length !== 1 || action.kind !== 'task-context' || action.taskId !== taskId
        || operation.taskId !== taskId || operation.actionIndex !== 0 || operation.status !== 'blocked'
        || record.failureOperationId !== operation.operationId || Object.keys(record.progress ?? {}).length
        || task.appliedOperations?.includes(operation.operationId)
        || group.outbox.some(item => item.outboundId === record.outboundId || item.decisionId === record.decisionId || item.sourceMessageId === `topic-decision:${record.decisionId}`)
        || await taskSessionReader.hasAppliedOperation(operation.operationId)) continue
      ids.add(record.decisionId)
    }
    return ids
  }
  const alerts = domain.table('alerts')
  const activities = domain.table('activities')
  for (const [key, alert] of alerts.entries()) {
    if (alert.status !== undefined) continue
    const recovered = alert.fingerprint.startsWith('leaf-goal-recovered:')
      || alert.fingerprint === 'leaf-session-recovered'
      || alert.fingerprint.startsWith('leaf-paused-restarted:')
    await alerts.put(key, { ...alert, status: recovered ? 'resolved' : 'active', ...(recovered ? { resolvedAt: alert.lastSeenAt } : {}) })
  }
  let persistedRuntime = scheduler.get('runtime')
  if (persistedRuntime === undefined) {
    await scheduler.put('runtime', { tasks: [] })
    persistedRuntime = scheduler.get('runtime')
  }
  // v6 数据只能通过离线迁移进入；启动不再猜测旧消息来源。
  const tails = new Map()
  const pendingPerformanceChunks = new Set()
  const performanceBatches = new Map()
  let performanceWriter, closing = false, closePromise
  function flushPerformanceBatches() {
    if (performanceWriter) return performanceWriter
    // Domain 的所有表共用写链；一次仅提交一个计量批次，给已排队的业务写让路。
    performanceWriter = Promise.resolve().then(async () => {
      while (performanceBatches.size) {
        const [partition, batch] = performanceBatches.entries().next().value
        performanceBatches.delete(partition)
        try {
          let projection = scheduler.get(partition)?.performanceProjection
          const results = batch.map(item => {
            const result = projectPerformanceEvent(projection, item.input)
            projection = result.projection
            return { created: result.created }
          })
          if (results.some(result => result.created)) await scheduler.put(partition, { tasks: [], ...scheduler.get(partition), performanceProjection: projection })
          batch.forEach((item, index) => item.resolve(results[index]))
        } catch (error) {
          // 不发布失败投影；后续批次从持久状态重算，原事件可由调用方重试。
          batch.forEach(item => item.reject(error))
        } finally {
          for (const item of batch) if (item.chunkKey) pendingPerformanceChunks.delete(item.chunkKey)
        }
      }
    }).finally(() => {
      performanceWriter = undefined
      if (performanceBatches.size) flushPerformanceBatches()
    })
    return performanceWriter
  }
  const findGroupEntry = (groupId) => {
    const direct = groups.get(groupId)
    if (direct !== undefined) return [groupId, direct]
    return [...groups.entries()].find(([, value]) => value.groupId === groupId)
  }
  const serialize = (groupId, operation) => {
    const previous = tails.get(groupId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    tails.set(groupId, current)
    const cleanup = () => { if (tails.get(groupId) === current) tails.delete(groupId) }
    current.then(cleanup, cleanup)
    return current
  }
  const supersedeStaleTaskOutbox = async (task) => {
    const groupEntry = findGroupEntry(task.groupId)
    if (!groupEntry) return
    await groups.update(groupEntry[0], (group) => ({ ...group, outbox: group.outbox.map((outbound) => {
      if (outbound.status !== 'pending' || !outbound.taskIds?.includes(task.taskId)) return outbound
      if (outbound.taskInputVersion === undefined || outbound.taskRunSequence === undefined) return outbound
      const sameVersion = outbound.taskInputVersion === task.inputVersion && outbound.taskRunSequence === task.runSequence
      const obsoleteWait = outbound.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)
        && (task.state !== 'waiting' || task.waitingKind !== 'information' || outbound.resultFingerprint !== fingerprint(task.result))
      const obsoleteSystemWait = outbound.sourceMessageId.startsWith(`task-system:${task.taskId}:`)
        && (task.state !== 'waiting' || task.waitingKind !== 'system')
      if (sameVersion && !obsoleteWait && !obsoleteSystemWait) return outbound
      return { ...outbound, status: 'superseded', supersededAt: new Date().toISOString(), supersededReason: obsoleteWait ? 'task-information-wait-ended' : obsoleteSystemWait ? 'task-system-wait-ended' : 'task-execution-version-changed' }
    }) }))
  }

  return {
    onGroupCommitted(listener) { groupCommitted.add(listener); return () => groupCommitted.delete(listener) },
    listPerformance: (filter) => {
      const projections = [...scheduler.entries()].map(([, value]) => value.performanceProjection).filter(Boolean)
      const base = listPerformance(undefined, filter)
      const rows = projections.flatMap(value => listPerformance(value, filter).rows)
      return { ...base, observedSince: projections.map(value => value.observedSince).sort()[0] ?? null,
        rows, coordination: coordinationCosts(rows), workflow: workflowPerformance({ tasks: [...tasks.entries()].map(([, value]) => value), groups: [...groups.entries()].map(([, value]) => value) }, filter),
      }
    },
    recordPerformanceEvent: (input) => {
      if (closing) return Promise.reject(new Error('resident_store_closed'))
      if (!PERFORMANCE_EVENT_TYPES.has(input.event?.type) || input.event.seq <= (input.seedSeq ?? -1)) return Promise.resolve({ created: false })
      const partition = `performance:${input.sessionId}`
      const chunkKey = input.event.type === 'assistant/chunk' ? performanceChunkKey(input) : undefined
      if (chunkKey && (pendingPerformanceChunks.has(chunkKey) || hasPerformanceFirstStream(scheduler.get(partition)?.performanceProjection, input))) return Promise.resolve({ created: false })
      if (chunkKey) pendingPerformanceChunks.add(chunkKey)
      const batch = performanceBatches.get(partition) ?? []
      performanceBatches.set(partition, batch)
      const persisted = new Promise((resolve, reject) => batch.push({ input, chunkKey, resolve, reject }))
      flushPerformanceBatches()
      return persisted
    },
    getCoordinationRequest: (groupId, requestId) => findGroupEntry(groupId)?.[1].coordinationRequests?.[requestId],
    getSourceDispatchOwnership: (groupId, unitId, unitRevision) => {
      const group = findGroupEntry(groupId)?.[1]
      const value = group ? sourceDispatchOwnershipFor(group, { unitId, unitRevision }) : undefined
      return value ? JSON.parse(JSON.stringify(value)) : undefined
    },
    retrySourceDispatch: async () => { throw new Error('INDEPENDENT_COORDINATION_RETIRED') },
    listSourceDispatchOwnership: groupId => JSON.parse(JSON.stringify(findGroupEntry(groupId)?.[1].sourceDispatchOwnership ?? [])),
    reserveSourceDispatch: async () => { throw new Error('INDEPENDENT_COORDINATION_RETIRED') },
    // Upgrade-only domain operation: preserve original questions and Task links.
    async retireIndependentCoordination(retirement) {
      if (retirement?.kind !== 'feature-removed') throw new Error('coordination_retirement_required')
      for (const [, group] of groups.entries()) {
        if (!(group.sourceDispatchOwnership ?? []).some(owner => owner.dispatchOwner === 'coordination' && !owner.retirement)) continue
        await serialize(group.groupId, async () => {
          const entry = findGroupEntry(group.groupId)
          await groups.update(entry[0], latest => {
            const ownership = latest.sourceDispatchOwnership.map(owner => owner.dispatchOwner !== 'coordination' || owner.retirement ? owner
              : sourceDispatchSchema.parse({ ...owner, settled: true, retirement, updatedAt: retirement.at,
                history: [...owner.history, { ...retirement, previousSemanticState: owner.semanticState, previousSettled: owner.settled }] }))
            return { ...latest, sourceDispatchOwnership: ownership, messages: settleCompletedMessageDeliveries(latest.messages, latest.topics, ownership) }
          })
        })
      }
    },
    updateSourceDispatch: async () => { throw new Error('INDEPENDENT_COORDINATION_RETIRED') },
    beginSourceDispatchHandoff: async () => { throw new Error('INDEPENDENT_COORDINATION_RETIRED') },
    completeSourceDispatchHandoff: async () => { throw new Error('INDEPENDENT_COORDINATION_RETIRED') },
    updateCoordinationRequest: (groupId, requestId, patch, validateSnapshot) => serialize(groupId, async () => {
      validateSnapshot?.()
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_found:${groupId}`)
      const [key, group] = entry
      const requests = { ...group.coordinationRequests, [requestId]: { ...group.coordinationRequests?.[requestId], ...patch, updatedAt: new Date().toISOString() } }
      const terminal = Object.entries(requests).filter(([, value]) => ['completed', 'superseded'].includes(value.status)).sort((a, b) => a[0] === requestId ? 1 : b[0] === requestId ? -1 : (a[1].updatedAt ?? '').localeCompare(b[1].updatedAt ?? '') || a[0].localeCompare(b[0]))
      for (const [expired] of terminal.slice(0, Math.max(0, terminal.length - 500))) delete requests[expired]
      const updated = groupSchema.parse({ ...group, coordinationRequests: requests })
      await groups.put(key, updated)
      return updated.coordinationRequests[requestId]
    }),
    getGroup: (groupId) => findGroupEntry(groupId)?.[1],
    listGroups: () => [...groups.entries()].map(([, value]) => value),
    hasGroupConfiguration: () => scheduler.get('runtime')?.groupConfigurationInitialized === true,
    getAgentWorkspaceDir: () => scheduler.get('runtime')?.agentWorkspaceDir,
    getTaskWorkspaceDir: () => scheduler.get('runtime')?.taskWorkspaceDir,
    getTimezone: () => scheduler.get('runtime')?.timezone,
    getPlatformSchedule: sessionId => scheduler.get(`platform-schedule:${sessionId}`)?.platformSchedule,
    preparePlatformSchedule: input => serialize(`platform-schedule:${input.sessionId}`, async () => {
      const value = platformScheduleSchema.parse(input), key = `platform-schedule:${value.sessionId}`
      const current = scheduler.get(key)?.platformSchedule
      if (current) {
        const { scheduleId, outcome, completedAt, ...identity } = current
        if (!isDeepStrictEqual(identity, value)) throw new Error('platform_schedule_identity_conflict')
      } else await scheduler.put(key, { tasks: [], platformSchedule: value })
      return scheduler.get(key).platformSchedule
    }),
    updatePlatformSchedule: async (sessionId, changes) => {
      if (Object.keys(changes).some(key => !['scheduleId', 'outcome', 'completedAt'].includes(key))) throw new Error('platform_schedule_update_invalid')
      await scheduler.update(`platform-schedule:${sessionId}`, current => {
        if (!current?.platformSchedule) throw new Error('platform_schedule_missing')
        return { ...current, platformSchedule: platformScheduleSchema.parse({ ...current.platformSchedule, ...changes }) }
      })
    },
    setAgentSettings: async patch => {
      await scheduler.update('runtime', current => ({ ...current, ...patch }))
    },
    getAgentNames: () => scheduler.get('runtime')?.agentNames ?? [],
    getReplySignature: () => scheduler.get('runtime')?.replySignature,
    setReplySignature: async (replySignature) => {
      await scheduler.update('runtime', (current) => ({ ...current, replySignature }))
      return { replySignature }
    },
    getMaxConcurrentTasks: () => scheduler.get('runtime')?.maxConcurrentTasks,
    setMaxConcurrentTasks: async (maxConcurrentTasks) => {
      await scheduler.update('runtime', (current) => ({ ...current, maxConcurrentTasks }))
      return { maxConcurrentTasks }
    },
    setAgentNames: async (agentNames) => {
      await scheduler.update('runtime', (current) => ({ ...current, agentNames }))
      return { agentNames }
    },
    setAgentWorkspaceDir: async (agentWorkspaceDir) => {
      await scheduler.update('runtime', (current) => ({ ...current, agentWorkspaceDir }))
      return { workspaceDir: agentWorkspaceDir }
    },
    getProxyUrl: () => scheduler.get('runtime')?.proxyUrl,
    getExecutionBackend: () => scheduler.get('runtime')?.executionBackend,
    getTaskSessionModelConfig: () => scheduler.get('runtime')?.taskSessionModel,
    getCoordinationModelConfig: () => scheduler.get('runtime')?.coordinationModel,
    setTaskSessionModelConfig: async (taskSessionModel) => {
      await scheduler.update('runtime', current => ({ ...current, taskSessionModel }))
    },
    setProxyUrl: async (proxyUrl) => {
      await scheduler.update('runtime', (current) => ({ ...current, proxyUrl }))
      return { proxyUrl }
    },
    getLeafSessionPrompt: () => {
      const current = scheduler.get('runtime')
      if (current?.leafSessionPrompt !== undefined) return current.leafSessionPrompt
      return [current?.taskExecutionGuidance, current?.taskEvidenceGuidance].filter((value) => value?.trim()).join('\n\n')
    },
    setLeafSessionPrompt: async (leafSessionPrompt) => {
      await scheduler.update('runtime', (current) => {
        const { taskExecutionGuidance: _execution, taskEvidenceGuidance: _evidence, ...rest } = current
        return { ...rest, leafSessionPrompt }
      })
      return { leafSessionPrompt }
    },
    getTaskPrompts: () => scheduler.get('runtime')?.taskPrompts ?? [],
    getTaskPromptsVersion: () => scheduler.get('runtime')?.taskPromptsVersion ?? 0,
    setTaskPrompts: async (taskPrompts, expectedVersion) => {
      if (!Array.isArray(taskPrompts)) throw new Error('task_prompts_must_be_array')
      let saved
      await scheduler.update('runtime', (current) => {
        const version = current?.taskPromptsVersion ?? 0
        if (expectedVersion !== undefined && expectedVersion !== version) throw new Error('task_prompts_version_conflict')
        const previous = new Map((current?.taskPrompts ?? []).map((item) => [item.id, item]))
        const ids = new Set()
        const normalized = taskPrompts.map((input) => {
          const id = typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : `task-prompt-${randomUUID()}`
          if (ids.has(id)) throw new Error('task_prompt_id_duplicate')
          ids.add(id)
          const base = { id, name: input?.name, description: input?.description, prompt: input?.prompt, enabled: input?.enabled !== false }
          const old = previous.get(id)
          const revision = old && old.name === base.name?.trim() && old.description === base.description?.trim() && old.prompt === base.prompt?.trim() && old.enabled === base.enabled ? old.revision : (old?.revision ?? version) + 1
          return taskPromptSchema.parse({ ...base, revision })
        })
        const indexChars = normalized.filter((item) => item.enabled).reduce((sum, item) => sum + item.id.length + item.name.length + item.description.length + 8, 0)
        if (indexChars > 12000) throw new Error('task_prompt_index_too_large')
        saved = { taskPrompts: normalized, taskPromptsVersion: version + 1 }
        return { ...current, ...saved }
      })
      return saved
    },
    initializeGroupConfiguration: async () => {
      await scheduler.update('runtime', (current) => ({ ...current, groupConfigurationInitialized: true }))
    },
    setTaskSessionReader: reader => { taskSessionReader = reader },
    getTopicTasksPage: async options => {
      if(taskSessionReader?.listTaskPage)return taskSessionReader.listTaskPage(options)
      if(taskSessionReader)throw Object.assign(new Error('topic_task_pagination_provider_required'),{code:'OBSERVER_PAGE_PROVIDER_REQUIRED'})
      // This retired in-memory task table has no body decoding at iteration. Select
      // narrow IDs before returning the requested task objects; native readers must
      // provide a storage-level page method above.
      const rows=[...tasks.entries()].map(([id,task])=>({id,taskId:task.taskId,groupId:task.groupId,refs:task.topicRefs,sort:task.updatedAt??task.createdAt??''})).filter(item=>item.groupId===options.groupId&&item.refs?.some(ref=>ref.topicId===options.topicId))
      const key=JSON.stringify(['topic-tasks',options.groupId,options.topicId])
      topicPages.replace(key,JSON.stringify(rows),rows)
      return topicPages.page(key,options,id=>tasks.get(id))
    },
    getTask: currentTask,
    listTasks: currentTasks,
    listTaskTimings: () => {
      const projected = [...activities.entries()].map(([, value]) => value)
      return [...tasks.entries()].map(([, task]) => ({ taskId: task.taskId, ...taskTiming(task, projected) }))
    },
    listAlerts: () => [...alerts.entries()].map(([, value]) => value),
    listActivities: (taskId) => [...activities.entries()].map(([, value]) => value)
      .filter((activity) => taskId === undefined || activity.taskId === taskId)
      .sort(compareActivity)
      .slice(-ACTIVITY_PROJECTION_LIMIT_PER_TASK),
    subscribe: ({ groupId, name, responsibility = '', timezone, personAliases, residentSessionId, residentAgentPreset }) => serialize(groupId, async () => {
      if (timezone !== undefined) new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
      if (personAliases !== undefined) personAliases = personAliasesSchema.parse(personAliases)
      const existing = findGroupEntry(groupId)?.[1]
      if (existing !== undefined) return { created: false, group: existing }
      const group = ensureFixedTopics({ groupId, ...(timezone ? { timezone } : {}), ...(name ? { name } : {}), ...(personAliases !== undefined ? { personAliases } : {}), responsibility, residentSessionId: residentSessionId ?? `session-${randomUUID()}`, ...(residentAgentPreset ? { residentAgentPreset } : {}), nextSequence: 1, messages: [], outbox: [], topics: [], routingRevision: 0, routeHistory: [], taskReservations: [] })
      await groups.put(groupId, group)
      return { created: true, group }
    }),
    updateGroup: ({ groupId, name, responsibility, timezone, personAliases, residentSessionId, residentAgentPreset }) => serialize(groupId, async () => {
      if (name === undefined && responsibility === undefined && timezone === undefined && personAliases === undefined && residentSessionId === undefined && residentAgentPreset === undefined) throw new Error('group_update_empty')
      if (timezone !== undefined) new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
      if (personAliases !== undefined) personAliases = personAliasesSchema.parse(personAliases)
      if (name !== undefined && typeof name !== 'string') throw new Error('group_name_invalid')
      if (responsibility !== undefined && typeof responsibility !== 'string') throw new Error('group_responsibility_invalid')
      if (residentSessionId !== undefined && typeof residentSessionId !== 'string') throw new Error('group_resident_session_invalid')
      if (residentAgentPreset !== undefined && (typeof residentAgentPreset !== 'string' || residentAgentPreset.trim() === '')) throw new Error('group_resident_agent_preset_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      return groups.update(entry[0], (group) => ({
        ...group,
        ...(name !== undefined ? { name } : {}),
        ...(responsibility !== undefined ? { responsibility } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(personAliases !== undefined ? { personAliases, routingRevision: group.routingRevision + (isDeepStrictEqual(group.personAliases ?? [], personAliases) ? 0 : 1) } : {}),
        ...(residentSessionId !== undefined ? { residentSessionId } : {}),
        ...(residentAgentPreset !== undefined ? { residentAgentPreset } : {}),
      }))
    }),
    removeGroup: ({ groupId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      if ([...tasks.entries()].some(([, task]) => task.groupId === groupId)) throw new Error('group_has_referenced_topics')
      if (entry[1].topics.some((topic) => topic.decisions.some(isPendingDecision))) throw new Error('group_has_pending_decisions')
      if (entry[1].outbox.some((outbound) => outbound.status === 'pending')) throw new Error('group_has_pending_outbox')
      await groups.delete(entry[0])
      return { removed: true, groupId }
    }),
    ingest: ({ groupId, messageId, text, occurredAt, senderName, senderOpenDingTalkId, messageAiSendFlag, mentionedAgent, quotedMessage, imageRefs, mediaUnavailable, resourceRefs, messageVersion, sourceKind = 'dingtalk' }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let duplicate = false, enriched = false, sequence
      const group = await groups.update(entry[0], (latest) => {
        const previous = latest.messages.find((item) => item.messageId === messageId)
        if (previous) {
          duplicate = true; sequence = previous.sequence
          const sameQuote = quotedMessage && (!quotedMessage.messageId || !previous.quotedMessage?.messageId || quotedMessage.messageId === previous.quotedMessage.messageId)
          const nextQuote = quotedMessage ? { ...(sameQuote ? previous.quotedMessage ?? {} : {}), ...quotedMessage,
            ...(sameQuote && missingText(quotedMessage.content) && !missingText(previous.quotedMessage?.content) ? { content: previous.quotedMessage.content } : {}),
            ...(sameQuote && missingText(quotedMessage.senderName) && !missingText(previous.quotedMessage?.senderName) ? { senderName: previous.quotedMessage.senderName } : {}),
            ...(sameQuote && !quotedMessage.occurredAt && previous.quotedMessage?.occurredAt ? { occurredAt: previous.quotedMessage.occurredAt } : {}) } : previous.quotedMessage
          const next = { ...previous, ...(mentionedAgent !== undefined ? { mentionedAgent } : {}), ...(messageAiSendFlag ? { messageAiSendFlag } : {}), ...(messageVersion > previous.messageVersion ? { text } : {}), ...(resourceRefs !== undefined ? { resourceRefs: mergeTaskResources(previous.resourceRefs, resourceRefs) } : {}), ...(senderName ? { senderName } : {}), ...(senderOpenDingTalkId ? { senderOpenDingTalkId } : {}),
            ...(nextQuote ? { quotedMessage: nextQuote } : {}), ...(imageRefs !== undefined ? { imageRefs } : {}), ...(mediaUnavailable !== undefined ? { mediaUnavailable } : {}) }
          if (JSON.stringify(next) === JSON.stringify(previous) && !(messageVersion > previous.messageVersion)) return latest
          const { resourceRefs: previousResources, messageAiSendFlag: _previousSendFlag, ...previousFacts } = previous
          const { resourceRefs: nextResources, messageAiSendFlag: _nextSendFlag, ...nextFacts } = next
          if (!(messageVersion > previous.messageVersion) && JSON.stringify(previousFacts) === JSON.stringify(nextFacts) && stableTaskResourceIdentity(previousResources) === stableTaskResourceIdentity(nextResources))
            return { ...latest, messages: latest.messages.map(item => item.messageId === messageId ? next : item) }
          enriched = true
          const { facts, ...oldFact } = previous
          next.facts = [...(facts ?? []), oldFact]
          next.messageVersion = Math.max(previous.messageVersion + 1, messageVersion ?? 1)
          // Sender/@/quote enrichment must not undo an explicit silent correction.
          // Changed message content still requires a new routing decision.
          next.routingStatus = manuallySettled(previous) && next.text === previous.text && isDeepStrictEqual(next.imageRefs ?? [], previous.imageRefs ?? []) ? 'routed' : 'pending'
          const now = new Date().toISOString()
          return { ...latest, messages: latest.messages.map((item) => item.messageId === messageId ? next : item),
            topics: latest.topics.map((topic) => {
              const active = [...new Map(topic.entries.filter((item) => item.messageId === messageId).map((item) => [item.unitId, item])).values()].filter((item) => item.action === 'add')
              if (!active.length) return topic
              let revision = topic.revision
              return { ...topic, revision: revision + active.length, status: 'active', updatedAt: now,
                entries: [...topic.entries, ...active.map((item) => ({ revision: ++revision, messageId, messageVersion: next.messageVersion, unitId: item.unitId, unitRevision: item.unitRevision, action: 'add', effectOwner: item.effectOwner, relationship: item.relationship, reason: 'message-fact-enriched' }))] }
            }) }
        }
        sequence = latest.nextSequence
        const accepted = inboundSchema.parse({ messageId, sequence, text, occurredAt, senderName, senderOpenDingTalkId, messageAiSendFlag, mentionedAgent, quotedMessage,
          imageRefs, mediaUnavailable, resourceRefs, sourceKind, messageVersion: messageVersion ?? 1, facts: [], routingStatus: 'pending', agentDeliveryStatus: 'pending' })
        return { ...latest, nextSequence: sequence + 1, messages: [...latest.messages, accepted] }
      })
      return { duplicate, enriched, sequence, group }
    }),
    listTopics: (groupId) => [...groups.entries()].flatMap(([, group]) => groupId === undefined || group.groupId === groupId ? group.topics : []),
    listFixedTopicMessagesPage: options => fixedTopicPages.page(options),
    listFixedTopics: groupId => groupId ? findGroupEntry(groupId)?.[1].fixedTopics ?? null : FIXED_TOPICS.map(topic => ({ ...topic, fixed: true })),
    listTopicsPage: async ({groupId,offset=0,limit=50,includeMerged=false,revision}={}) => {
      const key=groupId??'*',entries=[...groups.entries()].map(([,value])=>value).filter(group=>!groupId||group.groupId===groupId)
      let cache=topicPageScopes.get(key)
      if(!cache||entries.length!==cache.sources.length||entries.some((group,i)=>group.topics!==cache.sources[i])){
        const lookup=new Map(),rows=[]
        for(const group of entries)for(const topic of group.topics){const id=JSON.stringify([group.groupId,topic.topicId]);lookup.set(id,topic);rows.push({id,sort:topic.updatedAt??topic.createdAt,filters:[topic.mergedInto?'merged':'visible']})}
        const signature=JSON.stringify(entries.flatMap(group=>group.topics.map(topic=>[group.groupId,topic.topicId,topic.updatedAt,topic.revision,topic.processedRevision,topic.summaryRevision,topic.mergedInto])))
        topicPages.replace(key,signature,rows)
        cache={sources:entries.map(group=>group.topics),lookup};topicPageScopes.set(key,cache)
      }
      return topicPages.page(key,{offset,limit,revision,filter:includeMerged?'all':'visible'},id=>cache.lookup.get(id))
    },
    getTopic: (groupId, topicId) => findGroupEntry(groupId)?.[1].topics.find((topic) => topic.topicId === topicId),
    getTopicContext: ({ groupId, topicId, revision, offset = 0, limit = 100, intentOffset, intentLimit, includeTaskRefs = true }) => {
      const group = findGroupEntry(groupId)?.[1]
      const topic = group?.topics.find((item) => item.topicId === topicId)
      if (!topic) throw new Error(`topic_not_found:${topicId}`)
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('topic_page_invalid')
      const selectedRevision = revision ?? topic.revision
      const messages = topicMessages(group, topic, selectedRevision,{offset,limit})
      const visibleDecisions = selectedRevision===topic.revision?topic.decisions:topic.decisions.filter((item) => item.revision <= selectedRevision)
      const priorUpdate = selectedRevision===topic.revision?undefined:[...visibleDecisions].reverse().find((item) => item.status === 'completed' && item.decision.topicUpdate)?.decision.topicUpdate
      const snapshot = { ...topic, revision: selectedRevision, processedRevision: Math.min(topic.processedRevision, selectedRevision),
        summary: topic.summaryRevision <= selectedRevision ? topic.summary : '', summaryRevision: topic.summaryRevision <= selectedRevision ? topic.summaryRevision : 0,
        status: selectedRevision === topic.revision ? topic.status : priorUpdate?.status ?? 'active', openQuestions: selectedRevision === topic.revision ? topic.openQuestions : priorUpdate?.openQuestions ?? [],
        entries: selectedRevision===topic.revision?topic.entries:topic.entries.filter((item) => item.revision <= selectedRevision), decisions: intentOffset === undefined ? visibleDecisions : visibleDecisions.slice(intentOffset,intentOffset+intentLimit) }
      return { groupId, topicId, revision: selectedRevision, topic: snapshot, messages, total: topicMessageCount(group,topic,selectedRevision), intentTotal: visibleDecisions.length, offset, limit,
        taskRefs: !includeTaskRefs ? [] : currentTasks().filter((task) => task.groupId === groupId && task.topicRefs.some((ref) => ref.topicId === topicId)).map((task) => ({ taskId: task.taskId, inputVersion: task.inputVersion, topicRefs: task.topicRefs })) }
    },
    correctFixedTopicClassification: ({ groupId, ...input }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error('FIXED_TOPIC_CORRECTION_GROUP_NOT_FOUND')
      let receipt
      await groups.update(entry[0], latest => {
        const result = correctOutOfScope(latest, input, currentTasks())
        receipt = result.receipt
        return result.group
      })
      return receipt
    }),
    routeMessages: ({ groupId, routeId, routingRevision, requireAllPending, routes }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (!routeId || !Array.isArray(routes) || routes.length === 0) throw new Error('topic_routes_invalid')
      const requestFingerprint = fingerprint({ routingRevision, routes, ...(requireAllPending === true ? { requireAllPending: true } : {}) })
      let receipt
      const group = await groups.update(entry[0], (latest) => {
        const previous = latest.routeHistory.find((item) => item.routeId === routeId)
        if (previous) {
          if (previous.fingerprint !== requestFingerprint) throw new Error('topic_route_identity_conflict')
          receipt = previous; return latest
        }
        if (routes.some(route => route.units?.some(unit => unit.dispatchOwner === 'coordination'))) throw new Error('INDEPENDENT_COORDINATION_RETIRED')
        if (latest.routingRevision !== routingRevision) throw new Error('topic_routing_stale')
        // Host 直达入口必须在提交时覆盖全部待路由来源，包含新入站和旧消息富化产生的 pending。
        if (requireAllPending === true) {
          const pending = latest.messages.filter(message => message.routingStatus !== 'routed')
          if (pending.length !== routes.length || pending.some(message => !routes.some(route => route.messageId === message.messageId
            && route.messageVersion === message.messageVersion))) throw new Error('topic_routing_stale')
        }
        if (new Set(routes.map((route) => route.messageId)).size !== routes.length) throw new Error('topic_route_message_duplicate')
        const { newTopics, topicIdsByKey, unitsByMessage, ignoredByMessage } = resolveRouteBatch(latest, { groupId, routeId, routes })
        const replyTopics = new Map()
        for (const route of routes) {
          const ids = [...new Set(unitsByMessage.get(route.messageId).filter(unit => unit.dispatchOwner !== 'coordination')
            .flatMap(unit => unit.topics.map(ref => ref.topicId ?? topicIdsByKey[ref.newTopicKey])))]
          const selected = route.replyTopic ?? route.effectOwner
          const replyTopicId = selected ? selected.topicId ?? topicIdsByKey[selected.newTopicKey] : ids.length === 1 ? ids[0] : undefined
          if (ids.length > 1 && !replyTopicId) throw new Error('topic_route_reply_owner_required')
          if (replyTopicId && !ids.includes(replyTopicId)) throw new Error('topic_route_reply_owner_invalid')
          replyTopics.set(route.messageId, replyTopicId)
        }
        const sourceDispatchOwnership = [...(latest.sourceDispatchOwnership ?? [])]
        for (const route of routes) {
          const message = latest.messages.find(message => message.messageId === route.messageId)
          for (const unit of unitsByMessage.get(route.messageId)) {
            const previousOwned = sourceDispatchOwnership.filter(item => item.unitId === unit.unitId && item.dispatchOwner === 'coordination')
            if (previousOwned.length && unit.dispatchOwner !== 'coordination') throw new Error('source_dispatch_coordination_owned')
            if (unit.dispatchOwner !== 'coordination') continue
            const reservation = reserveSourceDispatchRecord({ ...latest, sourceDispatchOwnership }, message, unit)
            if (!sourceDispatchOwnership.some(item => item.reservationId === reservation.reservationId)) sourceDispatchOwnership.push(reservation)
          }
        }
        let topics = [...latest.topics, ...newTopics.values()]
        for (const route of routes) {
          const resolvedUnits = unitsByMessage.get(route.messageId)
          topics = topics.map((topic) => {
            const nextEntries = []
            const desiredIds = new Set(resolvedUnits.filter((unit) => unit.topics.some((ref) => (ref.topicId ?? topicIdsByKey[ref.newTopicKey]) === topic.topicId)).map((unit) => unit.unitId))
            const oldIds = new Set(topic.entries.filter((entry) => entry.messageId === route.messageId && entry.action === 'add').map((entry) => entry.unitId))
            for (const unitId of oldIds) {
              if (desiredIds.has(unitId)) continue
              const prior = [...topic.entries].reverse().find((entry) => entry.unitId === unitId)
              if (prior?.action === 'add') nextEntries.push({ messageId: route.messageId, messageVersion: route.messageVersion, unitId, unitRevision: prior.unitRevision, action: 'remove', reason: route.reason ?? 'unit-routing-revised' })
            }
            for (const unit of resolvedUnits) {
              const target = unit.topics.find((ref) => (ref.topicId ?? topicIdsByKey[ref.newTopicKey]) === topic.topicId)
              if (!target) continue
              const targetIds = unit.topics.map((ref) => ref.topicId ?? topicIdsByKey[ref.newTopicKey])
              const ownerId = unit.effectOwner ? unit.effectOwner.topicId ?? topicIdsByKey[unit.effectOwner.newTopicKey] : targetIds[0]
              const owner = topic.topicId === ownerId
              const old = [...topic.entries].reverse().find((entry) => entry.unitId === unit.unitId)
              if (old?.action === 'add' && old.messageVersion === route.messageVersion && old.unitRevision === unit.unitRevision && Boolean(old.effectOwner) === owner && old.relationship === target.relationship) continue
              nextEntries.push({ messageId: route.messageId, messageVersion: route.messageVersion, unitId: unit.unitId, unitRevision: unit.unitRevision, action: 'add', effectOwner: owner, ...(target.relationship ? { relationship: target.relationship } : {}), reason: target.reason ?? unit.reason ?? route.reason })
            }
            if (nextEntries.length === 0) return topic
            let revision = topic.revision
            const entries = [...topic.entries, ...nextEntries.map((entry) => ({ ...entry, revision: ++revision }))]
            return { ...topic, revision, status: 'active', updatedAt: new Date().toISOString(), entries }
          })
        }
        receipt = { routeId, fingerprint: requestFingerprint, routingRevision: latest.routingRevision + 1, topicIdsByKey, createdAt: new Date().toISOString() }
        const routedMessages = latest.messages.map((message) => {
          if (!unitsByMessage.has(message.messageId)) return message
          const current = unitsByMessage.get(message.messageId).map(({ topics: _topics, effectOwner: _owner, reason: _reason, ...unit }) => unit)
          const historical = [...(message.units ?? [])]
          for (const unit of current) if (!historical.some((item) => item.unitId === unit.unitId && item.unitRevision === unit.unitRevision)) historical.push(unit)
          return { ...message, replyTopicId: replyTopics.get(message.messageId), units: historical, activeUnitRefs: current.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), ignoredRanges: ignoredByMessage.get(message.messageId), routingStatus: 'routed', routingError: undefined }
        })
        return { ...latest, topics, sourceDispatchOwnership, routingRevision: latest.routingRevision + 1, routeHistory: [...latest.routeHistory, receipt],
          messages: settleCompletedMessageDeliveries(routedMessages, topics, sourceDispatchOwnership) }
      })
      return { status: 'routed', group, topics: group.topics, ...receipt }
    }),
    acceptTopicDecision: ({ groupId, topicId, revision, decisionId, decision, expectedTaskVersions = [], preflight }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let result
      const digest = fingerprint({ topicId, revision, decision, expectedTaskVersions })
      await groups.update(entry[0], (latest) => {
        const topic = latest.topics.find((item) => item.topicId === topicId)
        if (!topic) throw new Error(`topic_not_found:${topicId}`)
        const previous = latest.topics.flatMap((item) => item.decisions).find((item) => item.decisionId === decisionId)
        if (previous) {
          if (previous.fingerprint !== digest) throw new Error('topic_decision_identity_conflict')
          result = { status: 'duplicate', record: previous }; return latest
        }
        assertLegacyDecisionOwnership(latest, decision)
        if (latest.messages.some((message) => message.routingStatus !== 'routed')) { result = { status: 'routing-required' }; return latest }
        const veto = preflight?.(latest)
        if (veto !== undefined) { result = veto; return latest }
        for (const ref of (decision.actions ?? []).flatMap((action) => action.topicRefs ?? [])) {
          const dependency = latest.topics.find((item) => item.topicId === ref.topicId)
          if (!dependency || dependency.revision !== ref.revision) { result = { status: 'topic-stale', topicId: ref.topicId }; return latest }
        }
        if (topic.revision !== revision) { result = { status: 'topic-stale', revision: topic.revision }; return latest }
        const basis = latest.messages.filter(message => decision.basisMessageIds?.includes(message.messageId))
        if (decision.reply?.trim() && basis.length && basis.every(message => {
          const owner = replyTopicForMessage(latest, message)
          return owner && owner !== topicId
        })) { result = { status: 'reply-owned-by-other-topic' }; return latest }
        if (topic.decisions.some(isPendingDecision)) { result = { status: 'topic-busy' }; return latest }
        const replacing = decision.replyReview?.replaceOutboundIds ?? []
        if (replacementBusy(latest, replacing, decisionId)) {
          result = { status: 'reply-busy' }; return latest
        }
        if (replacing.length) reconcileReplacementGraph([...latest.outbox, { outboundId: stableId('outbound', decisionId), status: 'pending', replacesOutboundIds: replacing }])
        const targetTaskIds = (decision.actions ?? []).map((action) => action.taskId).filter(Boolean)
        if (new Set(targetTaskIds).size !== targetTaskIds.length) throw new Error('topic_task_action_duplicate')
        for (const action of decision.actions ?? []) {
          if (action.kind === 'new-task') taskSessionReader ? validateTaskMetadata(action) : assertNewTaskMetadata(action)
          if (action.taskId && !expectedTaskVersions.some((item) => item.taskId === action.taskId)) throw new Error('topic_task_version_required')
          const task = action.taskId ? currentTask(action.taskId) : undefined
          if (task && !taskSessionReader) assertTaskRevisionMetadata(task, action)
        }
        for (const expected of expectedTaskVersions) {
          const task = currentTask(expected.taskId)
          if (!task || task.groupId !== groupId || task.inputVersion !== expected.inputVersion || (expected.runSequence !== undefined && task.runSequence !== expected.runSequence)) { result = { status: 'task-stale', taskId: expected.taskId }; return latest }
          if (latest.taskReservations.some((item) => item.taskId === expected.taskId) && !(decision.actions.some(action => action.kind === 'task-cancel' && action.taskId === expected.taskId) && decision.actions.filter(action => action.taskId === expected.taskId).every(action => action.kind === 'task-cancel') && blockedReservationsOnly(latest, expected.taskId))) { result = { status: 'task-busy', taskId: expected.taskId }; return latest }
        }
        for (const action of decision.actions ?? []) {
          const task = action.taskId ? currentTask(action.taskId) : undefined
          if (task && !taskSessionReader && action.kind === 'task-context') assertTaskContextRevision(task, action, taskRevisionBasis(latest, task, action))
        }
        const now = new Date().toISOString()
        const operations = (decision.actions ?? []).map((action, actionIndex) => ({ operationId: `${decisionId}:action:${actionIndex}`, actionIndex, status: 'pending',
          ...(action.kind === 'new-task' ? { taskId: stableId('task', `${decisionId}:${actionIndex}`) } : action.taskId ? { taskId: action.taskId } : {}) }))
        const record = { decisionId, revision, decision, fingerprint: digest, status: 'accepted', operations, outboundId: stableId('outbound', decisionId), createdAt: now, updatedAt: now }
        result = { status: 'accepted', record }
        return { ...latest, topics: latest.topics.map((item) => item.topicId === topicId ? { ...item, decisions: [...item.decisions, record] } : item),
          taskReservations: [...latest.taskReservations, ...expectedTaskVersions.map((item) => ({ ...item, decisionId, topicId })),
            ...operations.filter((item) => item.taskId && decision.actions[item.actionIndex].kind === 'new-task').map((item) => ({ taskId: item.taskId, inputVersion: 1, runSequence: 1, decisionId, topicId }))] }
      })
      return result
    }),
    commitTopicFactDecision: ({ groupId, topicId, revision, expectedSummary, commit }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId), topic = entry?.[1].topics.find(item => item.topicId === topicId)
      if (!topic || topic.mergedInto || topic.revision !== revision || topic.summary !== expectedSummary
        || topic.processedRevision < topic.revision || topic.decisions.some(isPendingDecision)
        || entry[1].messages.some(message => message.routingStatus !== 'routed')) return { status: 'topic-stale' }
      // Only local ledger I/O inside the existing group lock. No model or channel wait.
      return commit()
    }),
    applyTopicFactSummary: ({ groupId, topicId, revision, requestId, expectedSummary, decision }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) return { status: 'missing' }
      await groups.update(entry[0], group => ({ ...group, topics: group.topics.map(topic => {
        if (topic.topicId !== topicId || topic.lastFactDecisionId === requestId || topic.revision !== revision
          || topic.summary !== expectedSummary || topic.processedRevision < topic.revision) return topic
        return { ...topic, ...decision.topicUpdate, summaryRevision: revision, lastFactDecisionId: requestId, updatedAt: new Date().toISOString() }
      }) }))
      return { status: 'projected' }
    }),
    reconcileWebTaskTopics: ({ groupId, requestId, expectedDigest, checkOnly = false }) => serialize(groupId, async () => {
      if (!taskSessionReader) throw new Error('task_session_required')
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      const inspect = group => { const plan = webTaskTopicReusePlan(group, currentTasks().map(task => ({ ...task,
        drained: task.drained && (taskSessionReader.isTaskQuiescent?.(task.taskId) ?? true) }))); return { ...plan, expectedDigest: fingerprint(plan) } }
      if (checkOnly) return { checkOnly: true, writes: 0, ...inspect(entry[1]) }
      if (!requestId?.trim() || !expectedDigest) throw new Error('task_topic_reconcile_identity_required')
      let result
      await groups.update(entry[0], latest => {
        const previous = latest.topics.filter(topic => topic.mergeReceipt?.requestId === requestId)
        if (previous.length) {
          if (previous.some(topic => topic.mergeReceipt.digest !== expectedDigest)) throw new Error('task_topic_reconcile_identity_conflict')
          result = { replayed: true, expectedDigest, mergedTopicIds: previous.map(topic => topic.topicId) }; return latest
        }
        const plan = inspect(latest)
        if (!plan.transfers.length) throw new Error('task_topic_reconcile_empty')
        if (plan.expectedDigest !== expectedDigest) throw new Error('task_topic_reconcile_stale')
        const topics = structuredClone(latest.topics), now = new Date().toISOString()
        for (const transfer of plan.transfers) {
          const source = topics.find(topic => topic.topicId === transfer.sourceTopicId), target = topics.find(topic => topic.topicId === transfer.targetTopicId)
          target.revision++; target.processedRevision = target.revision; target.updatedAt = now
          target.entries.push({ ...transfer.entry, revision: target.revision, reason: `web-task-reuse-reconciled:${source.topicId}` })
          source.revision++; source.processedRevision = source.revision
          source.entries.push({ ...transfer.entry, revision: source.revision, action: 'remove', reason: `web-task-reuse-reconciled:${target.topicId}` })
          source.status = 'closed'; source.mergedInto = target.topicId; source.updatedAt = now
          source.mergeReceipt = { requestId, digest: expectedDigest, targetRevision: target.revision, at: now }
        }
        result = { replayed: false, expectedDigest, mergedTopicIds: plan.transfers.map(item => item.sourceTopicId), transfers: plan.transfers }
        return { ...latest, topics }
      })
      return result
    }),
    submitWebTaskInput: ({ groupId, requestId, text, action, topicRefs = [] }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (typeof requestId !== 'string' || !requestId.trim() || typeof text !== 'string' || !text.trim()) throw new Error('web_task_input_invalid')
      const identity = `${groupId}:${requestId}`
      const messageId = stableId('web', identity), decisionId = stableId('decision', identity)
      const reuseTopics = !!taskSessionReader && topicRefs.length > 0
      const topicId = reuseTopics ? topicRefs[0].topicId : stableId('topic', `web:${identity}`)
      const digest = fingerprint({ text, action, topicRefs })
      const reconsiderable = action.kind === 'task-reopen' ? await inactiveTaskContexts(entry[1], action.taskId) : new Set()
      let result
      await groups.update(entry[0], (latest) => {
        const previous = latest.topics.flatMap((topic) => topic.decisions).find((record) => record.decisionId === decisionId)
        if (previous) {
          if (previous.fingerprint !== digest) throw new Error('web_task_request_identity_conflict')
          result = { status: 'duplicate', topicId, messageId, record: previous }; return latest
        }
        if (latest.messages.some((message) => message.routingStatus !== 'routed')) { result = { status: 'routing-required' }; return latest }
        if (new Set(topicRefs.map((ref) => ref.topicId)).size !== topicRefs.length) throw new Error('task_topic_duplicate')
        const task = action.taskId ? currentTask(action.taskId) : undefined
        const reopenBlockedContext = action.kind === 'task-reopen' && task?.state === 'cancelled' && task.restartRecoveryEligible === true
          && latest.taskReservations.filter(item => item.taskId === task.taskId).every(item => reconsiderable.has(item.decisionId))
        for (const ref of topicRefs) {
          const topic = latest.topics.find((item) => item.topicId === ref.topicId)
          if (!topic || topic.mergedInto || topic.revision !== ref.revision) { result = { status: 'topic-stale', topicId: ref.topicId }; return latest }
          if (reuseTopics && topic.decisions.some(isPendingDecision) && !(reopenBlockedContext && topic.decisions.filter(isPendingDecision).every(record => reconsiderable.has(record.decisionId))) && !(action.kind === 'task-cancel' && task
            && blockedReservationsOnly(latest, task.taskId) && topic.decisions.filter(isPendingDecision).every(record => record.status === 'blocked'
              && record.operations.length === 1 && record.operations[0].taskId === task.taskId
              && latest.taskReservations.filter(item => item.decisionId === record.decisionId).every(item => item.taskId === task.taskId)))) { result = { status: 'topic-busy', topicId: ref.topicId }; return latest }
        }
        if (action.kind === 'new-task') taskSessionReader ? validateTaskMetadata(action) : assertNewTaskMetadata(action)
        if (action.kind !== 'new-task') {
          if (!task || task.groupId !== groupId || task.inputVersion !== action.inputVersion || task.runSequence !== action.runSequence) { result = { status: 'task-stale', taskId: action.taskId }; return latest }
          if (latest.taskReservations.some((reservation) => reservation.taskId === task.taskId) && !reopenBlockedContext && !(action.kind === 'task-cancel' && blockedReservationsOnly(latest, task.taskId))) { result = { status: 'task-busy', taskId: task.taskId }; return latest }
          if ((action.kind === 'task-reopen' && task.state !== 'completed' && !(taskSessionReader && task.state === 'cancelled' && task.restartRecoveryEligible === true)) || (['task-context', 'task-cancel'].includes(action.kind) && task.state === 'completed')) { result = { status: 'task-state-invalid', taskId: task.taskId }; return latest }
          const basisIds = new Set([messageId, ...taskRevisionBasis(latest, task, { ...action, topicRefs })])
          if (!taskSessionReader) assertTaskContextRevision(task, action, basisIds)
        }
        const now = new Date().toISOString(), refs = reuseTopics ? topicRefs.map(ref => ({ topicId: ref.topicId, revision: ref.revision + (ref.topicId === topicId ? 1 : 0) })) : [...topicRefs, { topicId, revision: 1 }]
        const revision = reuseTopics ? refs[0].revision : 1
        const unit = { unitId: stableId('unit', `web:${identity}`), unitRevision: 1, unitKey: 'web-input', summary: text, sourceRanges: [{ start: 0, end: text.length, quote: text }], contextRanges: [] }
        const unitRef = { unitId: unit.unitId, unitRevision: 1 }
        const decision = { actions: [{ ...action, topicRefs: refs, basisUnitRefs: [unitRef] }], reply: '', basisMessageIds: [messageId], basisUnitRefs: [unitRef] }
        const operation = { operationId: `${decisionId}:action:0`, actionIndex: 0, taskId: task?.taskId ?? stableId('task', `${decisionId}:0`), status: 'pending' }
        const record = { decisionId, revision, decision, fingerprint: digest, status: 'accepted', operations: [operation], outboundId: stableId('outbound', decisionId), createdAt: now, updatedAt: now }
        const message = inboundSchema.parse({ messageId, sequence: latest.nextSequence, text, occurredAt: now, sourceKind: 'web', messageVersion: 1, units: [unit], facts: [], routingStatus: 'routed', agentDeliveryStatus: 'delivered' })
        const topic = topicSchema.parse({ topicId, groupId, title: action.title ?? task?.title ?? text.slice(0, 120), revision: 1, processedRevision: 0, status: 'active', summary: '', summaryRevision: 0, openQuestions: [],
          entries: [{ revision: 1, messageId, messageVersion: 1, ...unitRef, action: 'add', effectOwner: true, reason: 'web-task-input' }], decisions: [record], createdAt: now, updatedAt: now })
        result = { status: 'accepted', topicId, messageId, record }
        const topics = reuseTopics ? latest.topics.map(item => {
          const ref = item.topicId === topicId ? refs.find(ref => ref.topicId === item.topicId) : undefined
          return ref ? { ...item, revision: ref.revision, updatedAt: now, entries: [...item.entries, { revision: ref.revision, messageId, messageVersion: 1, ...unitRef, action: 'add', effectOwner: item.topicId === topicId, reason: 'web-task-authorization' }], decisions: item.topicId === topicId ? [...item.decisions, record] : item.decisions } : item
        }) : [...latest.topics, topic]
        return { ...latest, messages: [...latest.messages, message], nextSequence: latest.nextSequence + 1, topics, routingRevision: latest.routingRevision + 1,
          taskReservations: [...latest.taskReservations, { taskId: operation.taskId, inputVersion: task?.inputVersion ?? 1, runSequence: task?.runSequence ?? 1, decisionId, topicId }] }
      })
      return result
    }),
    updateTopicDecision: ({ groupId, topicId, decisionId, patch, expectedStatus, validateSnapshot }) => serialize(groupId, async () => {
      validateSnapshot?.()
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (Object.keys(patch).some((key) => !['status', 'operations', 'progress', 'error', 'attempt', 'retryBaseAttempt', 'nextRetryAt', 'recoveryReason', 'failureOperationId'].includes(key))) throw new Error('topic_decision_patch_invalid')
      if (patch.status === 'rejected') throw new Error('topic_decision_rejection_requires_validation')
      let result
      await groups.update(entry[0], (latest) => ({ ...latest, topics: latest.topics.map((topic) => topic.topicId !== topicId ? topic : { ...topic, decisions: topic.decisions.map((record) => {
        if (record.decisionId !== decisionId) return record
        if (expectedStatus !== undefined && record.status !== expectedStatus) throw new Error('decision_recovery_status_changed')
        if (!isPendingDecision(record)) { result = record; return record }
        if (record.status === 'blocked' && patch.status === 'accepted' && latest.taskReservations.some(reservation =>
          reservation.decisionId !== decisionId && record.operations.some(operation => operation.taskId === reservation.taskId)
          && latest.topics.some(item => item.decisions.some(pending => pending.decisionId === reservation.decisionId && isPendingDecision(pending)
            && pending.decision.actions.some(action => action.kind === 'task-reopen' && action.taskId === reservation.taskId))))) throw new Error('decision_recovery_task_reopening')
        if (patch.operations && (patch.operations.length !== record.operations.length || record.operations.some((operation, index) => {
          const next = patch.operations[index]
          return next.operationId !== operation.operationId || next.actionIndex !== operation.actionIndex || next.taskId !== operation.taskId || operation.status === 'applied' && next.status !== 'applied'
        }))) throw new Error('topic_operation_identity_or_applied_state_changed')
        result = { ...record, ...patch, updatedAt: new Date().toISOString() }; return result
      }) }) }))
      if (!result) throw new Error(`topic_decision_not_found:${decisionId}`)
      return result
    }),
    reconsiderBlockedTopicDecision: ({ groupId, topicId, decisionId, operationId, reason }) => serialize(groupId, async () => {
      if (!reason?.trim()) throw new Error('decision_recovery_evidence_required')
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let result
      await groups.update(entry[0], (latest) => {
        const topic = latest.topics.find(item => item.topicId === topicId)
        const record = topic?.decisions.find(item => item.decisionId === decisionId)
        if (!record || !['blocked', 'rejected'].includes(record.status)) throw new Error('decision_recovery_not_blocked')
        if (operationId !== record.failureOperationId || operationId !== record.outboundId) throw new Error('decision_recovery_wrong_failed_operation')
        if (record.decision.actions.length || record.operations.length || Object.keys(record.progress ?? {}).length
          || topic.processedRevision >= record.revision
          || latest.taskReservations.some(item => item.decisionId === decisionId)
          || [...tasks.entries()].some(([, task]) => task.appliedOperations?.some(id => id.startsWith(`${decisionId}:action:`)))
          || latest.outbox.some(item => item.outboundId === record.outboundId || item.decisionId === decisionId || item.sourceMessageId === `topic-decision:${decisionId}`)) throw new Error('decision_reconsider_side_effect_or_unknown')
        if (record.status === 'rejected') {
          if (!record.recoveryReason) throw new Error('decision_recovery_not_blocked')
          result = record
          return latest
        }
        result = { ...record, status: 'rejected', recoveryReason: reason.trim(), nextRetryAt: undefined, updatedAt: new Date().toISOString() }
        return { ...latest, topics: latest.topics.map(item => item.topicId !== topicId ? item : { ...item, decisions: item.decisions.map(value => value.decisionId === decisionId ? result : value) }) }
      })
      return result
    }),
    rejectInvalidTopicDecision: ({ groupId, topicId, decisionId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let rejected = false
      await groups.update(entry[0], (latest) => {
        const record = latest.topics.find(topic => topic.topicId === topicId)?.decisions.find(item => item.decisionId === decisionId)
        if (!record) throw new Error(`topic_decision_not_found:${decisionId}`)
        if (record.status === 'rejected') { rejected = true; return latest }
        if (taskSessionReader || !isPendingDecision(record) || !record.decision.actions.length || record.decision.actions.some(action => action.kind !== 'task-context')) return latest
        if (record.operations.length !== record.decision.actions.length || record.operations.some((operation, index) => operation.actionIndex !== index || operation.taskId !== record.decision.actions[index].taskId)) return latest
        // Task 写入与 operation 写回之间崩溃时，以 Task 的持久幂等账为准。
        if (record.operations.some(operation => operation.status !== 'pending' || currentTask(operation.taskId)?.appliedOperations.includes(operation.operationId))) return latest
        for (const action of record.decision.actions) {
          const task = currentTask(action.taskId)
          if (!task || task.groupId !== groupId || task.inputVersion !== action.inputVersion || task.runSequence !== action.runSequence) return latest
        }
        let failure
        try {
          for (const action of record.decision.actions) assertTaskContextRevision(currentTask(action.taskId), action, taskRevisionBasis(latest, currentTask(action.taskId), action))
        } catch (error) {
          if (!(error instanceof TaskRevisionError)) throw error
          failure = error.message
        }
        if (!failure) return latest
        rejected = true
        return { ...latest, taskReservations: latest.taskReservations.filter(item => item.decisionId !== decisionId),
          topics: latest.topics.map(topic => topic.topicId !== topicId ? topic : { ...topic,
            decisions: topic.decisions.map(item => item.decisionId !== decisionId ? item : { ...item, status: 'rejected', error: failure, updatedAt: new Date().toISOString() }),
          }) }
      })
      return rejected
    }),
    completeTopicDecision: ({ groupId, topicId, decisionId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      const previous = entry[1].topics.find(item => item.topicId === topicId)?.decisions.find(item => item.decisionId === decisionId)
      // 重复恢复不是新的语义完成；历史缺少首次时钟也不能以本次恢复时间补写。
      if (previous?.status === 'completed') return previous
      const reopened = previous?.decision.actions?.length === 1 && previous.decision.actions[0].kind === 'task-reopen'
        && previous.operations.length === 1 && previous.operations[0].status === 'applied' ? currentTask(previous.operations[0].taskId) : undefined
      const reconsiderable = reopened?.control === 'active' ? await inactiveTaskContexts(entry[1], reopened.taskId) : new Set()
      let result
      await groups.update(entry[0], (latest) => {
        const topic = latest.topics.find((item) => item.topicId === topicId)
        const record = topic?.decisions.find((item) => item.decisionId === decisionId)
        if (!record) throw new Error(`topic_decision_not_found:${decisionId}`)
        if (record.status === 'rejected') throw new Error('topic_decision_rejected')
        if (record.operations.some((operation) => operation.status !== 'applied')) throw new Error('topic_decision_operations_pending')
        const completedAt = new Date().toISOString()
        result = { ...record, status: 'completed', completedAt, updatedAt: completedAt }
        const update = record.decision.topicUpdate ?? {}
        const stillPending = topic.decisions.some(item => item.decisionId !== decisionId && isPendingDecision(item))
        const uncovered = topic.entries.some(entry => entry.revision > topic.processedRevision && entry.revision <= record.revision
          && !topicDecisionCoversEntry(record, entry))
        const processedRevision = stillPending || uncovered ? topic.processedRevision : Math.max(topic.processedRevision, record.revision)
        const topics = latest.topics.map(item => ({ ...item, decisions: item.decisions.map(value => reconsiderable.has(value.decisionId)
          ? { ...value, status: 'rejected', recoveryReason: '任务已恢复；原补充未写入，保留消息按当前任务版本重新判断。', nextRetryAt: undefined, updatedAt: completedAt } : value) }))
          .map((item) => item.topicId !== topicId ? item : {
          ...item, ...(update.summary !== undefined ? { summary: update.summary, summaryRevision: record.revision } : {}), ...(update.status && item.revision === record.revision ? { status: update.status } : {}), ...(update.openQuestions ? { openQuestions: update.openQuestions } : {}),
          processedRevision, decisions: item.decisions.map((previous) => previous.decisionId === decisionId ? result : previous), updatedAt: result.updatedAt })
        return { ...latest, taskReservations: latest.taskReservations.filter((item) => item.decisionId !== decisionId && !reconsiderable.has(item.decisionId)), topics,
          messages: settleCompletedMessageDeliveries(latest.messages, topics, latest.sourceDispatchOwnership) }
      })
      return result
    }),
    reconcileMessageDeliveries: ({ groupId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      return groups.update(entry[0], (latest) => ({ ...latest, messages: settleCompletedMessageDeliveries(latest.messages, latest.topics, latest.sourceDispatchOwnership) }))
    }),
    updateTopicTitle: ({ groupId, topicId, expectedTitle, expectedSummary, title }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let result = { status: 'topic-stale' }
      await groups.update(entry[0], (latest) => ({ ...latest, topics: latest.topics.map((topic) => {
        if (topic.topicId !== topicId) return topic
        if (topic.title !== expectedTitle || topic.summary !== expectedSummary) return topic
        result = { status: 'accepted', topic: { ...topic, title, updatedAt: new Date().toISOString() } }
        return result.topic
      }) }))
      return result
    }),
    updateTopicSummary: ({ groupId, topicId, expectedRevision, expectedSummary, summary }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let result = { status: 'topic-stale' }
      await groups.update(entry[0], (latest) => ({ ...latest, topics: latest.topics.map((topic) => {
        if (topic.topicId !== topicId) return topic
        if (topic.revision !== expectedRevision || topic.summary !== expectedSummary) return topic
        result = { status: 'accepted', topic: { ...topic, summary, summaryRevision: topic.revision, updatedAt: new Date().toISOString() } }
        return result.topic
      }) }))
      return result
    }),
    retryBackgroundMessageRouting: ({ groupId, messageId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      const message = entry[1].messages.find(item => item.messageId === messageId)
      if (!message) throw new Error(`message_not_found:${messageId}`)
      if (message.routingStatus !== 'routed' || message.agentDeliveryStatus !== 'skipped') return message
      const updated = { ...message, routingStatus: 'pending', routingError: undefined, agentDeliveryStatus: 'pending' }
      await groups.update(entry[0], group => ({ ...group, messages: group.messages.map(item => item.messageId === messageId ? updated : item) }))
      return updated
    }),
    recordTaskSessionRouting: ({ groupId, messageId, taskIds }) => serialize(groupId, async () => {
      if (!Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string' || !id)) throw new Error('task_session_refs_invalid')
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_found:${groupId}`)
      const message = entry[1].messages.find(item => item.messageId === messageId)
      if (!message) throw new Error(`message_not_found:${messageId}`)
      const refs = [...new Set(taskIds)]
      if (message.routingStatus === 'routed' && JSON.stringify(message.taskSessionRefs ?? []) === JSON.stringify(refs)) return message
      const updated = { ...message, taskSessionRefs: refs, routingStatus: 'routed', agentDeliveryStatus: 'delivered' }
      await groups.update(entry[0], group => ({ ...group, messages: group.messages.map(item => item.messageId === messageId ? updated : item) }))
      return updated
    }),
    markFixedTopicHandled: ({ groupId, messageId, messageVersion, unitId, unitRevision }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error('group_not_subscribed')
      return groups.update(entry[0], latest => {
        const source = latest.messages.find(message => message.messageId === messageId)
        if (!source || source.messageVersion !== messageVersion || !activeFixedUnits(source).some(unit => unit.unitId === unitId && unit.unitRevision === unitRevision)) return latest
        const messages = latest.messages.map(message => message !== source ? message : { ...message, units: message.units.map(unit => unit.unitId === unitId && unit.unitRevision === unitRevision ? { ...unit, fixedTopicHandledAt: new Date().toISOString() } : unit) })
        return { ...latest, messages: settleCompletedMessageDeliveries(messages, latest.topics, latest.sourceDispatchOwnership) }
      })
    }),
    markMessageAgentDelivery: ({ groupId, messageId, status, error, retryAt }) => serialize(groupId, async () => {
      if (!['pending', 'steered', 'delivered', 'failed', 'decision-retrying', 'decision-failed', 'decision-commit-failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
      if (retryAt !== undefined && (status !== 'decision-retrying' || Number.isNaN(new Date(retryAt).valueOf()))) throw new Error('message_agent_decision_retry_at_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      if (!entry[1].messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      return groups.update(entry[0], (latest) => ({
        ...latest,
        messages: latest.messages.map((message) => {
          if (message.messageId !== messageId || manuallySettled(message)) return message
          const { agentDeliveryError: _previousError, agentDecisionRetryAt: _previousRetryAt, ...current } = message
          return {
            ...current,
            agentDeliveryStatus: status,
            agentDeliveryAt: new Date().toISOString(),
            ...(status === 'steered' ? { agentDecisionAttemptCount: (message.agentDecisionAttemptCount ?? 0) + 1 } : {}),
            ...(error ? { agentDeliveryError: error } : {}),
            ...(retryAt ? { agentDecisionRetryAt: retryAt } : {}),
          }
        }),
      }))
    }),
    markMessagesAgentDelivery: ({ groupId, status = 'delivered', onlyMissing = true, messageIds }) => serialize(groupId, async () => {
      if (!['steered', 'delivered', 'failed', 'decision-retrying', 'decision-failed', 'decision-commit-failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
      if (messageIds !== undefined && (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.some((messageId) => typeof messageId !== 'string' || messageId.trim() === ''))) throw new Error('message_ids_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      let updated = 0
      const at = new Date().toISOString()
      const group = await groups.update(entry[0], (latest) => ({
        ...latest,
        messages: latest.messages.map((message) => {
          if (messageIds !== undefined && !messageIds.includes(message.messageId)) return message
          if (onlyMissing && message.agentDeliveryStatus) return message
          updated += 1
          const { agentDeliveryError: _previousError, agentDecisionRetryAt: _previousRetryAt, ...current } = message
          return { ...current, agentDeliveryStatus: status, agentDeliveryAt: at }
        }),
      }))
      return { groupId, status, onlyMissing, ...(messageIds !== undefined ? { messageIds } : {}), updated, total: group.messages.length, group }
    }),
    projectTaskNotification: ({ groupId, outbound }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      const value = outboundSchema.parse(outbound)
      const previous = entry[1].outbox.find(item => item.outboundId === value.outboundId)
      if (previous && previous.text !== value.text) throw new Error('task_notification_projection_conflict')
      if (previous?.notificationState === 'delivered' && value.notificationState !== 'delivered'
        || previous?.notificationState === 'superseded' && value.notificationState !== 'superseded') return entry[1]
      const next = Object.fromEntries(Object.entries({ ...previous, ...value,
        ...(value.status === 'sent' ? { deliveryPendingReason: undefined, deliveryError: undefined } : {}) }).filter(([, item]) => item !== undefined))
      // storage-domain.update 即使返回原对象也写盘，必须在调用之前跳过无变化投影。
      if (isDeepStrictEqual(previous, next)) return entry[1]
      return groups.update(entry[0], latest => ({ ...latest,
        outbox: previous ? latest.outbox.map(item => item.outboundId === value.outboundId ? next : item) : [...latest.outbox, next] }))
    }),
    appendOutbox: ({ groupId, preflight, outboundId, topicRefs, decisionId, resultFingerprint, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, atAll, sourceRef, artifactFiles, replyKind, matterSourceMessageIds, matterUnitRefs, taskIds, taskInputVersion, taskRunSequence, replacesOutboundIds }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      const sameId = outboundId && current.outbox.find(item => item.outboundId === outboundId)
      if (sameId) {
        if (sameId.text !== text || sameId.decisionId !== decisionId || sameId.replyToMessageId !== replyToMessageId
          || sameId.replyToSenderOpenDingTalkId !== replyToSenderOpenDingTalkId || !!sameId.atAll !== !!atAll
          || JSON.stringify(sameId.atOpenDingTalkIds ?? []) !== JSON.stringify(atOpenDingTalkIds ?? [])
          || ['messageId', 'actorId', 'messageVersion'].some(key => sameId.sourceRef?.[key] !== sourceRef?.[key])
          || !isDeepStrictEqual(sameId.artifactFiles ?? [], artifactFiles ?? [])) throw new Error('outbox_identity_conflict')
        return current
      }
      const existing = current.outbox.find((item) => item.sourceMessageId === sourceMessageId)
      if (existing !== undefined) return current
      let veto
      const group = await groups.update(storageKey, (latest) => {
        if (decisionId && (matterUnitRefs ?? []).some(ref => coordinationOwns(latest, ref))) {
          veto = { status: 'coordination-owned' }; return latest
        }
        veto = preflight?.(latest)
        if (veto !== undefined) return latest
        if (latest.topics.some(topic => topic.decisions.some(record => record.status === 'rejected'
          && (record.decisionId === decisionId || record.outboundId === outboundId || sourceMessageId === `topic-decision:${record.decisionId}`)))) {
          veto = { status: 'decision-rejected' }; return latest
        }
        if (replacementBusy(latest, replacesOutboundIds ?? [], decisionId)) { veto = { status: 'reply-busy' }; return latest }
        return { ...latest,
        outbox: reconcileReplacementGraph([...latest.outbox, {
          outboundId: outboundId ?? `outbound-${randomUUID()}`, ...(topicRefs ? { topicRefs } : {}), ...(decisionId ? { decisionId } : {}), ...(resultFingerprint ? { resultFingerprint } : {}), sourceMessageId, text, status: 'pending', readbackRequired: true,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(replyToSenderOpenDingTalkId ? { replyToSenderOpenDingTalkId } : {}),
          ...(Array.isArray(atOpenDingTalkIds) && atOpenDingTalkIds.length > 0 ? { atOpenDingTalkIds } : {}),
          ...(replyKind ? { replyKind } : {}),
          ...(atAll ? { atAll: true } : {}), ...(sourceRef ? { sourceRef } : {}), ...(artifactFiles?.length ? { artifactFiles } : {}),
          ...(Array.isArray(matterSourceMessageIds) && matterSourceMessageIds.length > 0 ? { matterSourceMessageIds: [...new Set(matterSourceMessageIds)] } : {}),
          ...(Array.isArray(matterUnitRefs) && matterUnitRefs.length > 0 ? { matterUnitRefs: [...new Map(matterUnitRefs.map((ref) => [`${ref.unitId}:${ref.unitRevision}`, ref])).values()] } : {}),
          ...(taskInputVersion ? { taskInputVersion } : {}), ...(taskRunSequence ? { taskRunSequence } : {}),
          ...(Array.isArray(taskIds) && taskIds.length > 0 ? { taskIds: [...new Set(taskIds)] } : {}),
          ...(Array.isArray(replacesOutboundIds) && replacesOutboundIds.length > 0 ? { replacesOutboundIds: [...new Set(replacesOutboundIds)] } : {}),
        }]),
      } })
      return veto ?? group
    }),
    reconcileOutboxReplacements: ({ groupId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      const outbox = reconcileReplacementGraph(entry[1].outbox)
      if (outbox.every((item, index) => item.status === entry[1].outbox[index].status && item.supersededByOutboundId === entry[1].outbox[index].supersededByOutboundId && item.supersededAt === entry[1].outbox[index].supersededAt)) return entry[1]
      return groups.update(entry[0], latest => ({ ...latest, outbox: reconcileReplacementGraph(latest.outbox) }))
    }),
    beginOutboundSend: ({ groupId, outboundId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let started = false
      await groups.update(entry[0], latest => {
        const outbound = latest.outbox.find(item => item.outboundId === outboundId)
        if (!outbound) throw new Error(`outbound_not_found:${outboundId}`)
        if (outbound.status !== 'pending' || outbound.supersededByOutboundId) return latest
        if (outbound.decisionId && (outbound.matterUnitRefs ?? []).some(ref => coordinationOwns(latest, ref))) return latest
        started = true
        return { ...latest, outbox: latest.outbox.map(item => item.outboundId === outboundId ? { ...item, sendStartedAt: item.sendStartedAt ?? new Date().toISOString(), sendAttemptCount: (item.sendAttemptCount ?? 0) + 1 } : item) }
      })
      return started
    }),
    recordOutboundReadbackAttempt: ({ groupId, outboundId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      return groups.update(entry[0], latest => {
        if (!latest.outbox.some(item => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
        return { ...latest, outbox: latest.outbox.map(item => item.outboundId === outboundId
          ? { ...item, readbackAttemptCount: (item.readbackAttemptCount ?? 0) + 1 } : item) }
      })
    }),
    attachOutboxTasks: ({ groupId, sourceMessageId, taskIds }) => serialize(groupId, async () => {
      if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((taskId) => typeof taskId !== 'string' || taskId.trim() === '')) throw new Error('outbox_task_ids_invalid')
      const uniqueTaskIds = [...new Set(taskIds)]
      if (uniqueTaskIds.length !== taskIds.length) throw new Error('outbox_task_ids_duplicate')
      if (uniqueTaskIds.some((taskId) => tasks.get(taskId)?.groupId !== groupId)) throw new Error('outbox_task_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.sourceMessageId === sourceMessageId)) throw new Error(`outbox_source_not_found:${sourceMessageId}`)
      return groups.update(storageKey, (latest) => ({
        ...latest,
        outbox: latest.outbox.map((item) => item.sourceMessageId === sourceMessageId
          ? { ...item, taskIds: [...new Set([...(item.taskIds ?? []), ...uniqueTaskIds])] }
          : item),
      }))
    }),
    acknowledge: ({ groupId, outboundId, deliveredMessageId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      const deliveredAt = new Date().toISOString()
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? { ...item, status: item.status === 'superseded' ? 'superseded' : 'sent', deliveredAt: item.deliveredAt ?? deliveredAt, ...(deliveredMessageId ? { deliveredMessageId: item.deliveredMessageId ?? deliveredMessageId } : {}), deliveryPendingReason: undefined, deliveryError: undefined, deliveryBlockedAt: undefined } : item) }))
    }),
    recordOutboundDeliveryAttempt: ({ groupId, outboundId, reason, error, blocked }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      const attemptedAt = new Date().toISOString()
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? {
        ...item, deliveryAttemptCount: (item.deliveryAttemptCount ?? 0) + 1, deliveryAttemptedAt: attemptedAt,
        ...(blocked === true ? { deliveryBlockedAt: item.deliveryBlockedAt ?? attemptedAt } : {}),
        ...(reason ? { deliveryPendingReason: reason } : { deliveryPendingReason: undefined }),
        ...(error ? { deliveryError: error } : { deliveryError: undefined }),
      } : item) }))
    }),
    updateOutboundRecall: ({ groupId, outboundId, status, reason, error, retryAt }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      const now = new Date().toISOString()
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? {
        ...item, recallStatus: status, ...(reason ? { recallReason: reason } : {}),
        ...(status === 'requested' ? { recallAttemptCount: (item.recallAttemptCount ?? 0) + 1 } : {}),
        ...(status === 'recalled' ? { recalledAt: now, recallError: undefined, recallRetryAt: undefined } : {}),
        ...(status === 'failed' ? { recallError: error || 'unknown', recallRetryAt: retryAt } : {}),
      } : item) }))
    }),
    createTask: ({ groupId, taskId = `task-${randomUUID()}`, operationId, topicRefs, inputVersion = 1, title, objective, requesterName, requesterOpenDingTalkId, acceptanceCriteria = [], stageTasks = [] }) => serialize(groupId, async () => {
      const group = findGroupEntry(groupId)?.[1]
      if (!group) throw new Error(`group_not_subscribed:${groupId}`)
      const existing = tasks.get(taskId)
      if (existing) {
        if (existing.groupId !== groupId || !operationId || !existing.appliedOperations.includes(operationId)) throw new Error('task_identity_conflict')
        return { created: false, task: existing }
      }
      const refs = validateTopicRefs(group, topicRefs)
      const metadata = validateTaskMetadata({ title, objective, acceptanceCriteria })
      const plan = normalizeRunPlan(metadata.objective, metadata.acceptanceCriteria, stageTasks)
      const stagePlan = stagePlanFor({ taskId, runSequence: 1 }, plan.stageTasks)
      const now = new Date().toISOString()
      const task = taskSchema.parse({ contractVersion: 2, taskId, groupId, topicRefs: refs, inputVersion, appliedOperations: operationId ? [operationId] : [], ...metadata,
        ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), state: 'queued', childSessionId: taskSessionId(taskId),
        runSequence: 1, runStartedAt: now, ...plan, stagePlan, runHistory: [], stateHistory: [{ state: 'queued', at: now, runSequence: 1 }], createdAt: now, updatedAt: now })
      await tasks.put(taskId, task)
      return { created: true, task }
    }),
    applyTaskOperation: ({ taskId, operationId, expectedInputVersion, expectedRunSequence, transform }) => serialize(tasks.get(taskId)?.groupId ?? taskId, async () => {
      const current = tasks.get(taskId)
      if (!current) throw new Error(`task_not_found:${taskId}`)
      let duplicate = false
      const task = await tasks.update(taskId, (latest) => {
        if (latest.appliedOperations.includes(operationId)) { duplicate = true; return latest }
        if (latest.inputVersion !== expectedInputVersion || (expectedRunSequence !== undefined && latest.runSequence !== expectedRunSequence)) throw new Error('task_version_stale')
        const next = transform(latest)
        validateTopicRefs(findGroupEntry(latest.groupId)[1], next.topicRefs)
        const at = new Date().toISOString()
        return taskSchema.parse({ ...next, appliedOperations: [...latest.appliedOperations, operationId], updatedAt: at,
          stateHistory: next.state !== latest.state || next.waitingKind !== latest.waitingKind ? [...(latest.stateHistory ?? []), { state: next.state, ...(next.waitingKind ? { waitingKind: next.waitingKind } : {}), at, runSequence: next.runSequence ?? 1 }] : latest.stateHistory })
      })
      await supersedeStaleTaskOutbox(task)
      return { applied: !duplicate, task }
    }),
    updateTask: (taskId, transform) => serialize(tasks.get(taskId)?.groupId ?? taskId, async () => {
      if (tasks.get(taskId) === undefined) throw new Error(`task_not_found:${taskId}`)
      const updated = await tasks.update(taskId, (task) => {
        const at = new Date().toISOString()
        const next = transform(task)
        const stateChangedAt = next.runSequence !== task.runSequence && next.runStartedAt ? next.runStartedAt : at
        const stateHistory = next.state !== task.state || next.waitingKind !== task.waitingKind ? [...(task.stateHistory ?? []), { state: next.state, ...(next.waitingKind ? { waitingKind: next.waitingKind } : {}), at: stateChangedAt, runSequence: next.runSequence ?? task.runSequence ?? 1 }] : task.stateHistory
        validateTopicRefs(findGroupEntry(task.groupId)[1], next.topicRefs)
        return taskSchema.parse({ ...next, ...(stateHistory ? { stateHistory } : {}), updatedAt: at })
      })
      await supersedeStaleTaskOutbox(updated)
      return updated
    }),
    recordAlert: async ({ taskId, fingerprint, detail, status = 'active' }) => {
      const task = tasks.get(taskId)
      if (task === undefined || (task.state !== 'running' && task.state !== 'waiting')) throw new Error(`task_not_active:${taskId}`)
      const key = `${taskId}:${fingerprint}`
      const existing = alerts.get(key)
      const now = new Date().toISOString()
      if (existing !== undefined) {
        const { resolvedAt: _resolvedAt, ...existingWithoutResolution } = existing
        const alert = { ...existingWithoutResolution, detail, count: existing.count + 1, lastSeenAt: now, status, ...(status === 'resolved' ? { resolvedAt: now } : {}) }
        await alerts.put(key, alert)
        return { created: false, alert, taskState: task.state }
      }
      const alert = { alertId: `alert-${randomUUID()}`, taskId, fingerprint, detail, count: 1, firstSeenAt: now, lastSeenAt: now, status, ...(status === 'resolved' ? { resolvedAt: now } : {}) }
      await alerts.put(key, alert)
      return { created: true, alert, taskState: task.state }
    },
    resolveAlerts: async ({ taskId, fingerprintPrefix }) => {
      const now = new Date().toISOString()
      let resolved = 0
      for (const [key, alert] of alerts.entries()) {
        if (alert.taskId !== taskId || !alert.fingerprint.startsWith(fingerprintPrefix) || alert.status === 'resolved') continue
        await alerts.put(key, { ...alert, status: 'resolved', resolvedAt: now })
        resolved += 1
      }
      return { taskId, fingerprintPrefix, resolved }
    },
    recordActivity: ({ taskId, sessionId, eventKey, type, detail = {}, occurredAt, seq }) => serialize(tasks.get(taskId)?.groupId ?? taskId, async () => {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const key = JSON.stringify([taskId, sessionId, eventKey])
      const entries = [...activities.entries()].filter(([, item]) => item.taskId === taskId)
      const existing = entries.find(([, item]) => item.sessionId === sessionId && item.eventKey === eventKey)?.[1]
      const activity = activitySchema.parse({ activityId: `activity-${randomUUID()}`, taskId, sessionId, eventKey, type, detail, seq, occurredAt: occurredAt ?? new Date().toISOString() })
      if (!Number.isFinite(activityTime(activity.occurredAt))) throw new Error('activity_occurred_at_invalid')
      const previous = task.activityProjection
      if (previous?.retentionFloor && compareActivity(activity, previous.retentionFloor) <= 0) {
        // 水位已落盘而删除尚未完成时，旧事件重放负责补齐删除。
        if (seq !== undefined && seq > (previous.sessions?.[sessionId]?.lastSeq ?? -1)) {
          await tasks.update(taskId, (current) => ({ ...current, activityProjection: activityProjectionSchema.parse({
            ...previous, lastSyncedAt: new Date().toISOString(),
            sessions: { ...previous.sessions, [sessionId]: { ...previous.sessions?.[sessionId], lastSeq: seq } },
          }) }))
        }
        for (const [expiredKey, item] of entries) if (compareActivity(item, previous.retentionFloor) <= 0) await activities.delete(expiredKey)
        return { created: false, expired: true }
      }
      // 先落事件再落水位；中途退出后重放已有事件仍会修复裁剪和水位。
      if (!existing) await activities.put(key, activity)
      const ordered = (existing ? entries : [...entries, [key, activity]]).sort((a, b) => compareActivity(a[1], b[1]))
      const removed = ordered.slice(0, Math.max(0, ordered.length - ACTIVITY_PROJECTION_LIMIT_PER_TASK))
      const latest = ordered.at(-1)?.[1]
      const floor = removed.at(-1)?.[1] ?? previous?.retentionFloor
      const session = previous?.sessions?.[sessionId] ?? {}
      const retained = ordered.slice(-ACTIVITY_PROJECTION_LIMIT_PER_TASK)
      const baseline = previous?.aggregate ?? entries
        .filter(([, item]) => !previous?.retentionFloor || compareActivity(item, previous.retentionFloor) > 0)
        .reduce((summary, [entryKey, item]) => ({ ...countActivity(summary, item), retainedEventKeys: [...summary.retainedEventKeys, entryKey] }), {
          total: 0, days: {}, retainedEventKeys: [], coverage: previous?.truncated ? 'retained-only' : 'complete',
        })
      const aggregate = (baseline.retainedEventKeys.includes(key) ? baseline : countActivity(baseline, existing ?? activity))
      const activityProjection = activityProjectionSchema.parse({
        ...previous, lastSyncedAt: new Date().toISOString(), latestEventKey: latest?.eventKey, latestOccurredAt: latest?.occurredAt,
        truncated: previous?.truncated || removed.length > 0,
        sessions: { ...previous?.sessions, [sessionId]: { ...session, ...(seq === undefined ? {} : { lastSeq: Math.max(session.lastSeq ?? 0, seq) }) } },
        aggregate: { ...aggregate, retainedEventKeys: retained.map(([entryKey]) => entryKey) },
        ...(floor ? { retentionFloor: { occurredAt: floor.occurredAt, sessionId: floor.sessionId, eventKey: floor.eventKey } } : {}),
      })
      await tasks.update(taskId, (current) => ({ ...current, activityProjection }))
      for (const [expiredKey] of removed) await activities.delete(expiredKey)
      return { created: !existing && !removed.some(([removedKey]) => removedKey === key), ...(existing ? { activity: existing } : { activity }), truncated: activityProjection.truncated }
    }),
    close: () => {
      closing = true
      return closePromise ??= (async () => {
        while (performanceWriter) await performanceWriter
        await Promise.allSettled([...tails.values()])
        await domain.close()
      })()
    },
  }
}
