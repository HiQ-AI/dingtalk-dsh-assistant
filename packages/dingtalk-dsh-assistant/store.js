import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { taskCheckpointSchema, taskResultSchema } from './task-result.js'
import { topicSchema, topicRefSchema, topicMessages, validateTopicRefs, stableId, fingerprint } from './topic-model.js'

export { resolveTopicMessages } from './topic-model.js'

const missingText = (value) => typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'null'
const replacementBusy = (group, replacesOutboundIds, decisionId) => replacesOutboundIds.length > 0 && (
  group.outbox.some((outbound) => outbound.status === 'pending' && (outbound.replacesOutboundIds ?? []).some((id) => replacesOutboundIds.includes(id)))
  || group.topics.some((topic) => topic.decisions.some((record) => record.status !== 'completed' && record.decisionId !== decisionId
    && (record.decision.replyReview?.replaceOutboundIds ?? []).some((id) => replacesOutboundIds.includes(id))))
)

const quotedMessageSchema = z.object({ messageId: z.string().min(1).optional(), senderName: z.string().min(1).optional(), occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(), content: z.string() })
const messageFactFields = {
  messageVersion: z.number().int().positive(), imageRefs: z.array(z.record(z.string(), z.unknown())).optional(), mediaUnavailable: z.array(z.string()).optional(),
  sourceKind: z.enum(['dingtalk', 'web', 'internal', 'migration']).optional(), migrationSource: z.string().optional(),
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
  outboundId: z.string().min(1), sourceMessageId: z.string().min(1), text: z.string(), status: z.enum(['pending', 'sent']),
  readbackRequired: z.boolean().optional(),
  deliveredMessageId: z.string().min(1).optional(), deliveredAt: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(), replyToSenderOpenDingTalkId: z.string().min(1).optional(),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional(),
  replyKind: z.enum(['confirmation', 'substantive', 'correction']).optional(),
  matterSourceMessageIds: z.array(z.string().min(1)).optional(), taskIds: z.array(z.string().min(1)).optional(),
  replacesOutboundIds: z.array(z.string().min(1)).optional(),
  recallStatus: z.enum(['requested', 'recalled', 'failed']).optional(), recallReason: z.string().min(1).optional(),
  recalledAt: z.string().min(1).optional(), recallError: z.string().min(1).optional(),
})
const legacyWaitingResultSchema = z.object({
  inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(),
  status: z.literal('waiting'), summary: z.string().min(1), evidence: z.array(z.string()), artifacts: z.array(z.string()), waitingReason: z.string().min(1),
}).strict()
const persistedTaskResultSchema = z.union([taskResultSchema, legacyWaitingResultSchema])
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
  groupId: z.string().min(1), name: z.string().optional(), responsibility: z.string(), residentSessionId: z.string().min(1), residentAgentPreset: z.string().min(1).optional(), nextSequence: z.number().int().positive(),
  messages: z.array(inboundSchema), outbox: z.array(outboundSchema),
  routingRevision: z.number().int().nonnegative(), topics: z.array(topicSchema), routeHistory: z.array(z.record(z.string(), z.unknown())), taskReservations: z.array(z.record(z.string(), z.unknown())),
})
const taskObjectiveRevisionSchema = z.object({ objective: z.string().min(1), revisedAt: z.string().min(1), topicRefs: z.array(topicRefSchema).optional(), inputVersion: z.number().int().positive().optional(), decisionId: z.string().optional() })
const taskPromptSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(400), prompt: z.string().trim().min(1).max(40000), enabled: z.boolean(), revision: z.number().int().positive() })
const taskPromptRefSchema = z.object({ id: z.string().min(1), revision: z.number().int().positive() })
const persistedTaskCheckpointSchema = taskCheckpointSchema.extend({
  checkpointId: z.string().min(1), submittedAt: z.string().min(1),
  coordinatorDecision: z.enum(['acknowledge', 'guidance', 'reject']).optional(), coordinatorReason: z.string().min(1).optional(), guidance: z.string().min(1).optional(), reviewedAt: z.string().min(1).optional(),
})
const taskRunSchema = z.object({
  runSequence: z.number().int().positive(), startedAt: z.string().min(1), endedAt: z.string().min(1).optional(),
  topicRefs: z.array(topicRefSchema), inputVersion: z.number().int().positive(), objective: z.string().min(1), childSessionId: z.string().min(1),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)), stageTasks: z.array(z.string().min(1)), taskPromptRefs: z.array(taskPromptRefSchema).optional(), checkpoints: z.array(persistedTaskCheckpointSchema).optional(), result: persistedTaskResultSchema.optional(),
})
const taskStateEventSchema = z.object({ state: z.enum(['queued', 'running', 'waiting', 'completed']), at: z.string().min(1), runSequence: z.number().int().positive() })
const taskSchema = z.object({
  taskId: z.string().min(1), groupId: z.string().min(1), topicRefs: z.array(topicRefSchema).min(1), inputVersion: z.number().int().positive(), appliedOperations: z.array(z.string()).default([]), title: z.string().min(1).optional(), objective: z.string().min(1),
  state: z.enum(['queued', 'running', 'waiting', 'completed']), childSessionId: z.string().min(1),
  waitingReason: z.string().optional(), waitingKind: z.enum(['information', 'human-intervention']).optional(),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  objectiveHistory: z.array(taskObjectiveRevisionSchema).optional(),
  runSequence: z.number().int().positive().optional(), runStartedAt: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional(), taskPromptRefs: z.array(taskPromptRefSchema).optional(), runHistory: z.array(taskRunSchema).optional(),
  executionEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  dispatchedInputVersion: z.number().int().positive().optional(), acknowledgedInputVersion: z.number().int().positive().optional(),
  checkpoints: z.array(persistedTaskCheckpointSchema).optional(),
  humanBlocker: humanBlockerSchema.optional(), humanBlockerHistory: z.array(humanBlockerSchema).optional(),
  completion: z.string().optional(), result: persistedTaskResultSchema.optional(), lastWaitingResult: persistedTaskResultSchema.optional(), lastCompletedResult: persistedTaskResultSchema.optional(),
  completionSequence: z.number().int().nonnegative().optional(),
  stateHistory: z.array(taskStateEventSchema).optional(),
  reopenContext: z.string().min(1).optional(), resumeContext: z.string().min(1).optional(), archivedAt: z.string().min(1).optional(), createdAt: z.string().min(1), updatedAt: z.string().min(1),
})
const schedulerSchema = z.object({
  tasks: z.array(taskSchema), groupConfigurationInitialized: z.boolean().optional(), agentNames: z.array(z.string().min(1)).optional(), agentWorkspaceDir: z.string().optional(), proxyUrl: z.string().optional(),
  leafSessionPrompt: z.string().optional(), taskPrompts: z.array(taskPromptSchema).optional(), taskPromptsVersion: z.number().int().nonnegative().optional(), taskExecutionGuidance: z.string().optional(), taskEvidenceGuidance: z.string().optional(), maxConcurrentTasks: z.number().int().positive().max(50).optional(),
})
const activitySchema = z.object({
  activityId: z.string().min(1), taskId: z.string().min(1), sessionId: z.string().min(1), eventKey: z.string().min(1),
  type: z.string().min(1), detail: z.record(z.string(), z.unknown()), occurredAt: z.string().min(1),
})
const alertSchema = z.object({
  alertId: z.string().min(1), taskId: z.string().min(1), fingerprint: z.string().min(1), detail: z.string().min(1),
  count: z.number().int().positive(), firstSeenAt: z.string().min(1), lastSeenAt: z.string().min(1),
  status: z.enum(['active', 'resolved']).optional(), resolvedAt: z.string().min(1).optional(),
})
const ACTIVITY_PROJECTION_LIMIT_PER_TASK = 500

export const residentDomainSpec = defineDomain({
  name: 'dingtalk_dsh_assistant', version: 7, tables: {
    groups: domainTable(groupSchema), scheduler: domainTable(schedulerSchema), tasks: domainTable(taskSchema), alerts: domainTable(alertSchema), activities: domainTable(activitySchema),
  },
})

function settleCompletedMessageDeliveries(messages, topics) {
  const deliveredAt = new Date().toISOString()
  return messages.map((message) => {
    if (message.routingStatus !== 'routed' || ['delivered', 'skipped'].includes(message.agentDeliveryStatus)) return message
    const activeEntries = topics.flatMap((topic) => {
      const entry = [...topic.entries].reverse().find((item) => item.messageId === message.messageId)
      return entry?.action === 'add' && entry.messageVersion === message.messageVersion ? [{ topic, entry }] : []
    })
    if (activeEntries.some(({ topic, entry }) => topic.processedRevision < entry.revision)) return message
    const { agentDeliveryError: _error, agentDecisionRetryAt: _retryAt, ...current } = message
    return { ...current, agentDeliveryStatus: 'delivered', agentDeliveryAt: deliveredAt }
  })
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
  const groups = domain.table('groups')
  const scheduler = domain.table('scheduler')
  const tasks = domain.table('tasks')
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

  return {
    getGroup: (groupId) => findGroupEntry(groupId)?.[1],
    listGroups: () => [...groups.entries()].map(([, value]) => value),
    hasGroupConfiguration: () => scheduler.get('runtime')?.groupConfigurationInitialized === true,
    getAgentWorkspaceDir: () => scheduler.get('runtime')?.agentWorkspaceDir,
    getAgentNames: () => scheduler.get('runtime')?.agentNames ?? [],
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
          const revision = old && old.name === base.name?.trim() && old.description === base.description?.trim() && old.prompt === base.prompt?.trim() && old.enabled === base.enabled ? old.revision : (old?.revision ?? 0) + 1
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
    getTask: (taskId) => tasks.get(taskId),
    listTasks: () => [...tasks.entries()].map(([, task]) => task),
    listTaskTimings: () => {
      const projected = [...activities.entries()].map(([, value]) => value)
      return [...tasks.entries()].map(([, task]) => ({ taskId: task.taskId, ...taskTiming(task, projected) }))
    },
    listAlerts: () => [...alerts.entries()].map(([, value]) => value),
    listActivities: (taskId) => [...activities.entries()].map(([, value]) => value)
      .filter((activity) => taskId === undefined || activity.taskId === taskId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .slice(-ACTIVITY_PROJECTION_LIMIT_PER_TASK),
    subscribe: ({ groupId, name, responsibility = '', residentSessionId, residentAgentPreset }) => serialize(groupId, async () => {
      const existing = findGroupEntry(groupId)?.[1]
      if (existing !== undefined) return { created: false, group: existing }
      const group = { groupId, ...(name ? { name } : {}), responsibility, residentSessionId: residentSessionId ?? `session-${randomUUID()}`, ...(residentAgentPreset ? { residentAgentPreset } : {}), nextSequence: 1, messages: [], outbox: [], topics: [], routingRevision: 0, routeHistory: [], taskReservations: [] }
      await groups.put(groupId, group)
      return { created: true, group }
    }),
    updateGroup: ({ groupId, name, responsibility, residentSessionId, residentAgentPreset }) => serialize(groupId, async () => {
      if (name === undefined && responsibility === undefined && residentSessionId === undefined && residentAgentPreset === undefined) throw new Error('group_update_empty')
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
        ...(residentSessionId !== undefined ? { residentSessionId } : {}),
        ...(residentAgentPreset !== undefined ? { residentAgentPreset } : {}),
      }))
    }),
    removeGroup: ({ groupId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      if ([...tasks.entries()].some(([, task]) => task.groupId === groupId)) throw new Error('group_has_referenced_topics')
      if (entry[1].topics.some((topic) => topic.decisions.some((decision) => decision.status !== 'completed'))) throw new Error('group_has_pending_decisions')
      if (entry[1].outbox.some((outbound) => outbound.status === 'pending')) throw new Error('group_has_pending_outbox')
      await groups.delete(entry[0])
      return { removed: true, groupId }
    }),
    ingest: ({ groupId, messageId, text, occurredAt, senderName, senderOpenDingTalkId, quotedMessage, imageRefs, mediaUnavailable, sourceKind = 'dingtalk' }) => serialize(groupId, async () => {
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
          const next = { ...previous, ...(senderName ? { senderName } : {}), ...(senderOpenDingTalkId ? { senderOpenDingTalkId } : {}),
            ...(nextQuote ? { quotedMessage: nextQuote } : {}), ...(imageRefs !== undefined ? { imageRefs } : {}), ...(mediaUnavailable !== undefined ? { mediaUnavailable } : {}) }
          if (JSON.stringify(next) === JSON.stringify(previous)) return latest
          enriched = true
          const { facts, ...oldFact } = previous
          next.facts = [...(facts ?? []), oldFact]
          next.messageVersion = previous.messageVersion + 1
          next.routingStatus = 'pending'
          const now = new Date().toISOString()
          return { ...latest, messages: latest.messages.map((item) => item.messageId === messageId ? next : item),
            topics: latest.topics.map((topic) => {
              const currentRef = [...topic.entries].reverse().find((item) => item.messageId === messageId)
              if (!currentRef || currentRef.action === 'remove') return topic
              return { ...topic, revision: topic.revision + 1, status: 'active', updatedAt: now,
                entries: [...topic.entries, { revision: topic.revision + 1, messageId, messageVersion: next.messageVersion, action: 'add', reason: 'message-fact-enriched' }] }
            }) }
        }
        sequence = latest.nextSequence
        const accepted = inboundSchema.parse({ messageId, sequence, text, occurredAt, senderName, senderOpenDingTalkId, quotedMessage,
          imageRefs, mediaUnavailable, sourceKind, messageVersion: 1, facts: [], routingStatus: 'pending', agentDeliveryStatus: 'pending' })
        return { ...latest, nextSequence: sequence + 1, messages: [...latest.messages, accepted] }
      })
      return { duplicate, enriched, sequence, group }
    }),
    listTopics: (groupId) => [...groups.entries()].flatMap(([, group]) => groupId === undefined || group.groupId === groupId ? group.topics : []),
    getTopic: (groupId, topicId) => findGroupEntry(groupId)?.[1].topics.find((topic) => topic.topicId === topicId),
    getTopicContext: ({ groupId, topicId, revision, offset = 0, limit = 100 }) => {
      const group = findGroupEntry(groupId)?.[1]
      const topic = group?.topics.find((item) => item.topicId === topicId)
      if (!topic) throw new Error(`topic_not_found:${topicId}`)
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('topic_page_invalid')
      const selectedRevision = revision ?? topic.revision
      const messages = topicMessages(group, topic, selectedRevision)
      const visibleDecisions = topic.decisions.filter((item) => item.revision <= selectedRevision)
      const priorUpdate = [...visibleDecisions].reverse().find((item) => item.status === 'completed' && item.decision.topicUpdate)?.decision.topicUpdate
      const snapshot = { ...topic, revision: selectedRevision, processedRevision: Math.min(topic.processedRevision, selectedRevision),
        summary: topic.summaryRevision <= selectedRevision ? topic.summary : '', summaryRevision: topic.summaryRevision <= selectedRevision ? topic.summaryRevision : 0,
        status: selectedRevision === topic.revision ? topic.status : priorUpdate?.status ?? 'active', openQuestions: selectedRevision === topic.revision ? topic.openQuestions : priorUpdate?.openQuestions ?? [],
        entries: topic.entries.filter((item) => item.revision <= selectedRevision), decisions: visibleDecisions }
      return { groupId, topicId, revision: selectedRevision, topic: snapshot, messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit,
        taskRefs: [...tasks.entries()].map(([, task]) => task).filter((task) => task.groupId === groupId && task.topicRefs.some((ref) => ref.topicId === topicId)).map((task) => ({ taskId: task.taskId, inputVersion: task.inputVersion, topicRefs: task.topicRefs })) }
    },
    routeMessages: ({ groupId, routeId, routingRevision, routes }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (!routeId || !Array.isArray(routes) || routes.length === 0) throw new Error('topic_routes_invalid')
      const requestFingerprint = fingerprint({ routingRevision, routes })
      let receipt
      const group = await groups.update(entry[0], (latest) => {
        const previous = latest.routeHistory.find((item) => item.routeId === routeId)
        if (previous) {
          if (previous.fingerprint !== requestFingerprint) throw new Error('topic_route_identity_conflict')
          receipt = previous; return latest
        }
        if (latest.routingRevision !== routingRevision) throw new Error('topic_routing_stale')
        if (new Set(routes.map((route) => route.messageId)).size !== routes.length) throw new Error('topic_route_message_duplicate')
        const newTopics = new Map(), topicIdsByKey = {}
        for (const route of routes) {
          const message = latest.messages.find((item) => item.messageId === route.messageId)
          if (!message) throw new Error(`message_not_found:${route.messageId}`)
          if (message.messageVersion !== route.messageVersion) throw new Error('topic_message_version_stale')
          if (!Array.isArray(route.topics) || (route.topics.length === 0 && !route.reason?.trim())) throw new Error('topic_route_reason_required')
          if (route.topics.length > 1 && route.topics.some((ref) => !['continuation', 'affected'].includes(ref.relationship) || !ref.reason?.trim())) throw new Error('topic_route_relationship_required')
          if (route.topics.length > 1 && !route.effectOwner) throw new Error('topic_route_effect_owner_required')
          const selected = new Set()
          for (const ref of route.topics) {
            if (!!ref.topicId === !!ref.newTopicKey) throw new Error('topic_route_target_invalid')
            if (ref.topicId && !latest.topics.some((topic) => topic.topicId === ref.topicId)) throw new Error(`topic_not_found:${ref.topicId}`)
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
          if (route.effectOwner) {
            const ownerId = route.effectOwner.topicId ?? topicIdsByKey[route.effectOwner.newTopicKey]
            if (!ownerId || !selected.has(ownerId)) throw new Error('topic_route_effect_owner_invalid')
          }
        }
        let topics = [...latest.topics, ...newTopics.values()]
        for (const route of routes) {
          const targetIds = route.topics.map((ref) => ref.topicId ?? topicIdsByKey[ref.newTopicKey])
          const effectOwnerId = route.effectOwner
            ? route.effectOwner.topicId ?? topicIdsByKey[route.effectOwner.newTopicKey]
            : targetIds[0]
          topics = topics.map((topic) => {
            const old = [...topic.entries].reverse().find((item) => item.messageId === route.messageId)
            const selected = targetIds.includes(topic.topicId)
            const target = route.topics.find((ref) => (ref.topicId ?? topicIdsByKey[ref.newTopicKey]) === topic.topicId)
            const owner = selected && topic.topicId === effectOwnerId
            if ((!selected && (!old || old.action === 'remove')) || (selected && old?.action === 'add' && old.messageVersion === route.messageVersion && Boolean(old.effectOwner) === owner && old.relationship === target?.relationship)) return topic
            const revision = topic.revision + 1
            const reason = target?.reason ?? route.reason
            return { ...topic, revision, status: 'active', updatedAt: new Date().toISOString(), entries: [...topic.entries, { revision, messageId: route.messageId, messageVersion: route.messageVersion, action: selected ? 'add' : 'remove', ...(selected ? { effectOwner: owner, ...(target?.relationship ? { relationship: target.relationship } : {}) } : {}), ...(reason ? { reason } : {}) }] }
          })
        }
        receipt = { routeId, fingerprint: requestFingerprint, routingRevision: latest.routingRevision + 1, topicIdsByKey, createdAt: new Date().toISOString() }
        const routedMessages = latest.messages.map((message) => routes.some((route) => route.messageId === message.messageId) ? { ...message, routingStatus: 'routed', routingError: undefined } : message)
        return { ...latest, topics, routingRevision: latest.routingRevision + 1, routeHistory: [...latest.routeHistory, receipt],
          messages: settleCompletedMessageDeliveries(routedMessages, topics) }
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
        if (latest.messages.some((message) => message.routingStatus !== 'routed')) { result = { status: 'routing-required' }; return latest }
        const veto = preflight?.(latest)
        if (veto !== undefined) { result = veto; return latest }
        for (const ref of (decision.actions ?? []).flatMap((action) => action.topicRefs ?? [])) {
          const dependency = latest.topics.find((item) => item.topicId === ref.topicId)
          if (!dependency || dependency.revision !== ref.revision) { result = { status: 'topic-stale', topicId: ref.topicId }; return latest }
        }
        if (topic.revision !== revision) { result = { status: 'topic-stale', revision: topic.revision }; return latest }
        if (topic.decisions.some((item) => item.status !== 'completed')) { result = { status: 'topic-busy' }; return latest }
        const replacing = decision.replyReview?.replaceOutboundIds ?? []
        if (replacementBusy(latest, replacing, decisionId)) {
          result = { status: 'reply-busy' }; return latest
        }
        const targetTaskIds = (decision.actions ?? []).map((action) => action.taskId).filter(Boolean)
        if (new Set(targetTaskIds).size !== targetTaskIds.length) throw new Error('topic_task_action_duplicate')
        for (const action of decision.actions ?? []) {
          if (action.taskId && !expectedTaskVersions.some((item) => item.taskId === action.taskId)) throw new Error('topic_task_version_required')
        }
        for (const expected of expectedTaskVersions) {
          const task = tasks.get(expected.taskId)
          if (!task || task.groupId !== groupId || task.inputVersion !== expected.inputVersion || (expected.runSequence !== undefined && task.runSequence !== expected.runSequence)) { result = { status: 'task-stale', taskId: expected.taskId }; return latest }
          if (latest.taskReservations.some((item) => item.taskId === expected.taskId)) { result = { status: 'task-busy', taskId: expected.taskId }; return latest }
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
    submitWebTaskInput: ({ groupId, requestId, text, action, topicRefs = [] }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (typeof requestId !== 'string' || !requestId.trim() || typeof text !== 'string' || !text.trim()) throw new Error('web_task_input_invalid')
      const identity = `${groupId}:${requestId}`
      const messageId = stableId('web', identity), decisionId = stableId('decision', identity), topicId = stableId('topic', `web:${identity}`)
      const digest = fingerprint({ text, action, topicRefs })
      let result
      await groups.update(entry[0], (latest) => {
        const previous = latest.topics.flatMap((topic) => topic.decisions).find((record) => record.decisionId === decisionId)
        if (previous) {
          if (previous.fingerprint !== digest) throw new Error('web_task_request_identity_conflict')
          result = { status: 'duplicate', topicId, messageId, record: previous }; return latest
        }
        if (latest.messages.some((message) => message.routingStatus !== 'routed')) { result = { status: 'routing-required' }; return latest }
        if (new Set(topicRefs.map((ref) => ref.topicId)).size !== topicRefs.length) throw new Error('task_topic_duplicate')
        for (const ref of topicRefs) {
          const topic = latest.topics.find((item) => item.topicId === ref.topicId)
          if (!topic || topic.revision !== ref.revision) { result = { status: 'topic-stale', topicId: ref.topicId }; return latest }
        }
        const task = action.taskId ? tasks.get(action.taskId) : undefined
        if (action.kind !== 'new-task') {
          if (!task || task.groupId !== groupId || task.inputVersion !== action.inputVersion || task.runSequence !== action.runSequence) { result = { status: 'task-stale', taskId: action.taskId }; return latest }
          if (latest.taskReservations.some((reservation) => reservation.taskId === task.taskId)) { result = { status: 'task-busy', taskId: task.taskId }; return latest }
          if ((action.kind === 'task-reopen' && task.state !== 'completed') || (['task-context', 'task-cancel'].includes(action.kind) && task.state === 'completed')) { result = { status: 'task-state-invalid', taskId: task.taskId }; return latest }
        }
        const now = new Date().toISOString(), refs = [...topicRefs, { topicId, revision: 1 }]
        const decision = { actions: [{ ...action, topicRefs: refs }], reply: '', basisMessageIds: [messageId] }
        const operation = { operationId: `${decisionId}:action:0`, actionIndex: 0, taskId: task?.taskId ?? stableId('task', `${decisionId}:0`), status: 'pending' }
        const record = { decisionId, revision: 1, decision, fingerprint: digest, status: 'accepted', operations: [operation], outboundId: stableId('outbound', decisionId), createdAt: now, updatedAt: now }
        const message = inboundSchema.parse({ messageId, sequence: latest.nextSequence, text, occurredAt: now, sourceKind: 'web', messageVersion: 1, facts: [], routingStatus: 'routed', agentDeliveryStatus: 'delivered' })
        const topic = topicSchema.parse({ topicId, groupId, title: action.title ?? task?.title ?? text.slice(0, 120), revision: 1, processedRevision: 0, status: 'active', summary: '', summaryRevision: 0, openQuestions: [],
          entries: [{ revision: 1, messageId, messageVersion: 1, action: 'add', reason: 'web-task-input' }], decisions: [record], createdAt: now, updatedAt: now })
        result = { status: 'accepted', topicId, messageId, record }
        return { ...latest, messages: [...latest.messages, message], nextSequence: latest.nextSequence + 1, topics: [...latest.topics, topic], routingRevision: latest.routingRevision + 1,
          taskReservations: [...latest.taskReservations, { taskId: operation.taskId, inputVersion: task?.inputVersion ?? 1, runSequence: task?.runSequence ?? 1, decisionId, topicId }] }
      })
      return result
    }),
    updateTopicDecision: ({ groupId, topicId, decisionId, patch }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      if (Object.keys(patch).some((key) => !['status', 'operations', 'progress', 'error'].includes(key))) throw new Error('topic_decision_patch_invalid')
      let result
      await groups.update(entry[0], (latest) => ({ ...latest, topics: latest.topics.map((topic) => topic.topicId !== topicId ? topic : { ...topic, decisions: topic.decisions.map((record) => {
        if (record.decisionId !== decisionId) return record
        if (record.status === 'completed') { result = record; return record }
        result = { ...record, ...patch, updatedAt: new Date().toISOString() }; return result
      }) }) }))
      if (!result) throw new Error(`topic_decision_not_found:${decisionId}`)
      return result
    }),
    completeTopicDecision: ({ groupId, topicId, decisionId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      let result
      await groups.update(entry[0], (latest) => {
        const topic = latest.topics.find((item) => item.topicId === topicId)
        const record = topic?.decisions.find((item) => item.decisionId === decisionId)
        if (!record) throw new Error(`topic_decision_not_found:${decisionId}`)
        if (record.operations.some((operation) => operation.status !== 'applied')) throw new Error('topic_decision_operations_pending')
        result = { ...record, status: 'completed', updatedAt: new Date().toISOString() }
        const update = record.decision.topicUpdate ?? {}
        const topics = latest.topics.map((item) => item.topicId !== topicId ? item : {
          ...item, ...(update.summary !== undefined ? { summary: update.summary, summaryRevision: record.revision } : {}), ...(update.status && item.revision === record.revision ? { status: update.status } : {}), ...(update.openQuestions ? { openQuestions: update.openQuestions } : {}),
          processedRevision: Math.max(item.processedRevision, record.revision), decisions: item.decisions.map((previous) => previous.decisionId === decisionId ? result : previous), updatedAt: result.updatedAt })
        return { ...latest, taskReservations: latest.taskReservations.filter((item) => item.decisionId !== decisionId), topics,
          messages: settleCompletedMessageDeliveries(latest.messages, topics) }
      })
      return result
    }),
    reconcileMessageDeliveries: ({ groupId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (!entry) throw new Error(`group_not_subscribed:${groupId}`)
      return groups.update(entry[0], (latest) => ({ ...latest, messages: settleCompletedMessageDeliveries(latest.messages, latest.topics) }))
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
    markMessageAgentDelivery: ({ groupId, messageId, status, error, retryAt }) => serialize(groupId, async () => {
      if (!['pending', 'steered', 'delivered', 'failed', 'decision-retrying', 'decision-failed', 'decision-commit-failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
      if (retryAt !== undefined && (status !== 'decision-retrying' || Number.isNaN(new Date(retryAt).valueOf()))) throw new Error('message_agent_decision_retry_at_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      if (!entry[1].messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      return groups.update(entry[0], (latest) => ({
        ...latest,
        messages: latest.messages.map((message) => {
          if (message.messageId !== messageId) return message
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
    appendOutbox: ({ groupId, preflight, outboundId, topicRefs, decisionId, resultFingerprint, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, replyKind, matterSourceMessageIds, taskIds, replacesOutboundIds }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      const existing = current.outbox.find((item) => item.sourceMessageId === sourceMessageId)
      if (existing !== undefined) return current
      let veto
      const group = await groups.update(storageKey, (latest) => {
        veto = preflight?.(latest)
        if (veto !== undefined) return latest
        if (replacementBusy(latest, replacesOutboundIds ?? [], decisionId)) { veto = { status: 'reply-busy' }; return latest }
        return { ...latest,
        outbox: [...latest.outbox, {
          outboundId: outboundId ?? `outbound-${randomUUID()}`, ...(topicRefs ? { topicRefs } : {}), ...(decisionId ? { decisionId } : {}), ...(resultFingerprint ? { resultFingerprint } : {}), sourceMessageId, text, status: 'pending', readbackRequired: true,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(replyToSenderOpenDingTalkId ? { replyToSenderOpenDingTalkId } : {}),
          ...(Array.isArray(atOpenDingTalkIds) && atOpenDingTalkIds.length > 0 ? { atOpenDingTalkIds } : {}),
          ...(replyKind ? { replyKind } : {}),
          ...(Array.isArray(matterSourceMessageIds) && matterSourceMessageIds.length > 0 ? { matterSourceMessageIds: [...new Set(matterSourceMessageIds)] } : {}),
          ...(Array.isArray(taskIds) && taskIds.length > 0 ? { taskIds: [...new Set(taskIds)] } : {}),
          ...(Array.isArray(replacesOutboundIds) && replacesOutboundIds.length > 0 ? { replacesOutboundIds: [...new Set(replacesOutboundIds)] } : {}),
        }],
      } })
      return veto ?? group
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
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? { ...item, status: 'sent', deliveredAt, ...(deliveredMessageId ? { deliveredMessageId } : {}) } : item) }))
    }),
    updateOutboundRecall: async ({ groupId, outboundId, status, reason, error }) => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      const now = new Date().toISOString()
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? {
        ...item, recallStatus: status, ...(reason ? { recallReason: reason } : {}),
        ...(status === 'recalled' ? { recalledAt: now, recallError: undefined } : {}),
        ...(status === 'failed' ? { recallError: error || 'unknown' } : {}),
      } : item) }))
    },
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
      const now = new Date().toISOString()
      const task = taskSchema.parse({ taskId, groupId, topicRefs: refs, inputVersion, appliedOperations: operationId ? [operationId] : [], ...metadata,
        ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), state: 'queued', childSessionId: taskSessionId(taskId),
        runSequence: 1, runStartedAt: now, stageTasks: stageTasks.length ? stageTasks : ['完成并验证当前轮目标'], runHistory: [], stateHistory: [{ state: 'queued', at: now, runSequence: 1 }], createdAt: now, updatedAt: now })
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
          stateHistory: next.state !== latest.state ? [...(latest.stateHistory ?? []), { state: next.state, at, runSequence: next.runSequence ?? 1 }] : latest.stateHistory })
      })
      return { applied: !duplicate, task }
    }),
    updateTask: (taskId, transform) => serialize(tasks.get(taskId)?.groupId ?? taskId, async () => {
      if (tasks.get(taskId) === undefined) throw new Error(`task_not_found:${taskId}`)
      return tasks.update(taskId, (task) => {
        const at = new Date().toISOString()
        const next = transform(task)
        const stateChangedAt = next.runSequence !== task.runSequence && next.runStartedAt ? next.runStartedAt : at
        const stateHistory = next.state !== task.state ? [...(task.stateHistory ?? []), { state: next.state, at: stateChangedAt, runSequence: next.runSequence ?? task.runSequence ?? 1 }] : task.stateHistory
        validateTopicRefs(findGroupEntry(task.groupId)[1], next.topicRefs)
        return taskSchema.parse({ ...next, ...(stateHistory ? { stateHistory } : {}), updatedAt: at })
      })
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
    recordActivity: async ({ taskId, sessionId, eventKey, type, detail = {}, occurredAt }) => {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const key = `${taskId}:${eventKey}`
      const existing = activities.get(key)
      if (existing !== undefined) return { created: false, activity: existing }
      const projectedCount = [...activities.entries()].filter(([, activity]) => activity.taskId === taskId).length
      if (projectedCount >= ACTIVITY_PROJECTION_LIMIT_PER_TASK) return { created: false, capped: true }
      const activity = { activityId: `activity-${randomUUID()}`, taskId, sessionId, eventKey, type, detail, occurredAt: occurredAt ?? new Date().toISOString() }
      await activities.put(key, activity)
      return { created: true, activity }
    },
    close: () => domain.close(),
  }
}
