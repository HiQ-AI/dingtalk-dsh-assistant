// v8 离线归档契约，冻结于 83fc504。仅供历史迁移，禁止运行时导入；不引用可变业务 schema。
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
export const topicRefSchema = z.object({ topicId: z.string().min(1), revision: z.number().int().positive() }).strict()
export const unitRefSchema = z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()
export const sourceRangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict()
const attachmentRefId = (ref) => ref?.id ?? ref?.attachmentId
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

const number = z.number().finite().nonnegative()
const identitySchema = z.object({ sessionId: z.string().min(1), groupId: z.string().optional(), taskId: z.string().optional(), requestId: z.string().optional(), submissionId: z.string().optional() })
const distributionSchema = z.object({ count: number, sum: number, max: number, frequencies: z.record(z.string(), number) })
const intervalSchema = z.tuple([number, number])
const bucketSchema = identitySchema.extend({
  day: z.string(), modelCalls: number, missingUsage: number, interrupted: number, toolCalls: number, toolResults: number, toolErrors: number,
  missingStepStart: number, missingToolCall: number, missingFirstStream: number,
  missingToolResult: number.default(0), coordinationMessages: number.default(0), coordinationInputBytes: number.default(0),
  missingCoordinationQueue: number.default(0), coordinationQueueMs: distributionSchema.default(() => ({ count: 0, sum: 0, max: 0, frequencies: {} })),
  usage: z.object({ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, totalInputTokens: number,
    missingFields: z.record(z.string(), number) }),
  contextTokens: distributionSchema, firstStreamMs: distributionSchema, modelResponseMs: distributionSchema, toolMs: distributionSchema,
  modelIntervals: z.array(intervalSchema), toolIntervals: z.array(intervalSchema),
})
const stepSchema = z.object({ startedAt: number.optional(), firstStreamAt: number.optional(), completed: z.boolean().optional() })
export const performanceProjectionSchema = z.object({
  observedSince: z.string(), buckets: z.record(z.string(), bucketSchema),
  sessions: z.record(z.string(), z.object({ seen: z.array(intervalSchema), steps: z.record(z.string(), stepSchema), completedSteps: z.record(z.string(), z.array(intervalSchema)).default({}),
    calls: z.record(z.string(), identitySchema.extend({ startedAt: number, stepKey: z.string().optional() })) })),
})

const executionVersion = { inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), submissionId: z.string().trim().min(1).optional() }
const resultTaskPromptRefSchema = z.object({ id: z.string().trim().min(1), revision: z.number().int().positive() }).strict()
const workflowAssessmentSchema = z.object({
  promptRefs: z.array(resultTaskPromptRefSchema),
  reusedEvidence: z.array(z.string().trim().min(1)).default([]),
  inapplicableSteps: z.array(z.object({ promptId: z.string().trim().min(1), step: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict()).default([]),
  exceptions: z.array(z.object({ requirement: z.string().trim().min(1), basisMessageIds: z.array(z.string().trim().min(1)).min(1), reason: z.string().trim().min(1) }).strict()).default([]),
}).strict()
const blockedItemSchema = z.object({
  stageId: z.string().trim().min(1).optional(),
  requirement: z.string().trim().min(1),
  basisMessageIds: z.array(z.string().trim().min(1)).min(1),
  dependency: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  attemptedSources: z.array(z.string().trim().min(1)).optional(),
}).strict()

const completedResultSchema = z.object({
  ...executionVersion,
  status: z.literal('completed'),
  workType: z.enum(['development', 'non-development']).optional(),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  localWorktrees: z.array(z.string().trim().min(1)).optional(),
  delivery: z.record(z.string(), z.unknown()).optional(),
}).strict()

const informationWaitingResultSchema = z.object({
  ...executionVersion,
  status: z.literal('waiting'),
  waitingKind: z.literal('information'),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  waitingReason: z.string().trim().min(1),
  questions: z.array(z.string().trim().min(1)).min(1),
  blockedItems: z.array(blockedItemSchema).default([]),
}).strict()

const humanInterventionWaitingResultSchema = z.object({
  ...executionVersion,
  status: z.literal('waiting'),
  waitingKind: z.literal('human-intervention'),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  waitingReason: z.string().trim().min(1),
  blockerCategory: z.enum(['redline', 'network', 'disk', 'resource', 'unexpected', 'human-decision']),
  risk: z.string().trim().min(1).default('未单独说明；以阻塞原因、现场证据和申请范围为准。'),
  attemptedActions: z.array(z.string().trim().min(1)).default([]),
  requestedAction: z.string().trim().min(1),
  blockedItems: z.array(blockedItemSchema).default([]),
}).strict()

export const taskResultSchema = z.union([completedResultSchema, informationWaitingResultSchema, humanInterventionWaitingResultSchema])


export const storedTaskCheckpointBaseSchema = z.object({
  ...executionVersion,
  kind: z.enum(['plan-confirmed', 'stage-completed', 'scope-conflict', 'evidence-gap', 'risk-changed']),
  stageTask: z.string().trim().min(1).optional(),
  stageId: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  completedItems: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).default([]),
  remainingItems: z.array(z.string().trim().min(1)).default([]),
  nextStep: z.string().trim().min(1),
  needsCoordinatorDecision: z.boolean().default(false),
  workflowAssessment: workflowAssessmentSchema.optional(),
}).strict()


const quotedMessageSchema = z.object({ messageId: z.string().min(1).optional(), senderName: z.string().min(1).optional(), occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(), content: z.string() })
const messageFactFields = {
  messageVersion: z.number().int().positive(), imageRefs: z.array(z.record(z.string(), z.unknown())).optional(), mediaUnavailable: z.array(z.string()).optional(),
  sourceKind: z.enum(['dingtalk', 'web', 'internal', 'migration']).optional(), migrationSource: z.string().optional(),
  ignoredRanges: z.array(sourceRangeSchema.extend({ reason: z.string().min(1) })).optional(),
  units: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive(), unitKey: z.string().min(1), summary: z.string().min(1), sourceRanges: z.array(sourceRangeSchema), sourceAttachments: z.array(z.object({ imageRefId: z.string().min(1) }).strict()).default([]), contextRanges: z.array(sourceRangeSchema.extend({ purpose: z.string().min(1) })).default([]), predecessorUnitRefs: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()).default([]), effectInheritance: z.enum(['inherit', 'new-scope']).optional(), revisionReason: z.string().min(1).optional() }).refine((unit) => unit.sourceRanges.length + unit.sourceAttachments.length > 0, 'topic_unit_source_required')).optional(),
  activeUnitRefs: z.array(z.object({ unitId: z.string().min(1), unitRevision: z.number().int().positive() }).strict()).optional(),
}
const inboundSchema = z.object({
  ...messageFactFields, facts: z.array(z.record(z.string(), z.unknown())).default([]), routingStatus: z.enum(['pending', 'routed', 'failed']).default('pending'), routingError: z.string().optional(),
  messageId: z.string().min(1), sequence: z.number().int().positive(), text: z.string(), occurredAt: z.union([z.string().min(1), z.number().finite()]),
  senderName: z.string().min(1).optional(), senderOpenDingTalkId: z.string().min(1).optional(), quotedMessage: quotedMessageSchema.optional(),
  agentDeliveryStatus: z.enum(['pending', 'steered', 'delivered', 'failed', 'decision-retrying', 'decision-failed', 'decision-commit-failed', 'skipped']).optional(),
  agentDeliveryAt: z.string().min(1).optional(), agentDeliveryError: z.string().min(1).optional(),
  agentDecisionAttemptCount: z.number().int().nonnegative().optional(), agentDecisionRetryAt: z.string().min(1).optional(),
})
const outboundSchema = z.object({
  topicRefs: z.array(topicRefSchema).optional(), decisionId: z.string().optional(), resultFingerprint: z.string().min(1).optional(),
  outboundId: z.string().min(1), sourceMessageId: z.string().min(1), text: z.string(), status: z.enum(['pending', 'sent', 'superseded']),
  taskInputVersion: z.number().int().positive().optional(), taskRunSequence: z.number().int().positive().optional(),
  supersededByOutboundId: z.string().min(1).optional(), supersededAt: z.string().min(1).optional(), supersededReason: z.string().min(1).optional(), sendStartedAt: z.string().min(1).optional(),
  readbackRequired: z.boolean().optional(),
  deliveryAttemptCount: z.number().int().nonnegative().optional(), deliveryAttemptedAt: z.string().min(1).optional(),
  sendAttemptCount: z.number().int().nonnegative().optional(), readbackAttemptCount: z.number().int().nonnegative().optional(),
  deliveryPendingReason: z.string().min(1).optional(), deliveryError: z.string().min(1).optional(),
  deliveryBlockedAt: z.string().min(1).optional(),
  deliveredMessageId: z.string().min(1).optional(), deliveredAt: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(), replyToSenderOpenDingTalkId: z.string().min(1).optional(),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional(),
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
const persistedTaskResultSchema = z.union([taskResultSchema, historicalCoordinationResultSchema, legacyWaitingResultSchema])
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
const groupSchema = z.object({
  coordinationRequests: z.record(z.string(), z.object({ attempt: z.number().int().nonnegative().default(0), resumeEpoch: z.number().int().nonnegative().default(0), updatedAt: z.string().optional(), nextRetryAt: z.string().optional(), status: z.enum(['pending', 'exhausted', 'completed', 'superseded']), messageId: z.string().optional(), lastError: z.string().optional(), supersededBy: z.string().optional(), supersedeReason: z.string().optional() })).default({}),
  groupId: z.string().min(1), name: z.string().optional(), responsibility: z.string(), residentSessionId: z.string().min(1), residentAgentPreset: z.string().min(1).optional(), nextSequence: z.number().int().positive(),
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
const schedulerSchema = z.object({
  performanceProjection: performanceProjectionSchema.optional(),
  tasks: z.array(taskSchema), groupConfigurationInitialized: z.boolean().optional(), agentNames: z.array(z.string().min(1)).optional(), agentWorkspaceDir: z.string().optional(), proxyUrl: z.string().optional(),
  leafSessionPrompt: z.string().optional(), taskPrompts: z.array(taskPromptSchema).optional(), taskPromptsVersion: z.number().int().nonnegative().optional(), taskExecutionGuidance: z.string().optional(), taskEvidenceGuidance: z.string().optional(), maxConcurrentTasks: z.number().int().positive().max(50).optional(),
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

export const residentDomainSpec = defineDomain({
  name: 'dingtalk_dsh_assistant', version: 8, tables: {
    groups: domainTable(groupSchema), scheduler: domainTable(schedulerSchema), tasks: domainTable(taskSchema), alerts: domainTable(alertSchema), activities: domainTable(activitySchema),
  },
})
