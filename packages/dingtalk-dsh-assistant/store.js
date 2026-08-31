import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { taskCheckpointSchema, taskResultSchema } from './task-result.js'

const missingText = (value) => typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'null'

const quotedMessageSchema = z.object({ messageId: z.string().min(1).optional(), senderName: z.string().min(1).optional(), occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(), content: z.string() })
const inboundSchema = z.object({ messageId: z.string().min(1), sequence: z.number().int().positive(), text: z.string(), occurredAt: z.union([z.string().min(1), z.number().finite()]), senderName: z.string().min(1).optional(), senderOpenDingTalkId: z.string().min(1).optional(), quotedMessage: quotedMessageSchema.optional(), agentDeliveryStatus: z.enum(['pending', 'delivered', 'failed', 'skipped']).optional(), agentDeliveryAt: z.string().min(1).optional(), agentDeliveryError: z.string().min(1).optional() })
const outboundSchema = z.object({
  outboundId: z.string().min(1), sourceMessageId: z.string().min(1), text: z.string(), status: z.enum(['pending', 'sent']),
  readbackRequired: z.boolean().optional(),
  deliveredMessageId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(), replyToSenderOpenDingTalkId: z.string().min(1).optional(),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional(),
  recallStatus: z.enum(['requested', 'recalled', 'failed']).optional(), recallReason: z.string().min(1).optional(),
  recalledAt: z.string().min(1).optional(), recallError: z.string().min(1).optional(),
})
const legacyWaitingResultSchema = z.object({
  status: z.literal('waiting'), summary: z.string().min(1), evidence: z.array(z.string()), artifacts: z.array(z.string()), waitingReason: z.string().min(1),
}).strict()
const persistedTaskResultSchema = z.union([taskResultSchema, legacyWaitingResultSchema])
const humanBlockerSchema = z.object({
  requestId: z.string().min(1), fingerprint: z.string().min(1).optional(), category: z.enum(['redline', 'network', 'disk', 'resource', 'unexpected', 'human-decision']),
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
})
const taskTriggerSchema = z.object({
  sourceMessageId: z.string().min(1), requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(),
})
const taskObjectiveRevisionSchema = z.object({
  objective: z.string().min(1), revisedAt: z.string().min(1), sourceMessageId: z.string().min(1).optional(),
})
const persistedTaskCheckpointSchema = taskCheckpointSchema.extend({
  checkpointId: z.string().min(1), submittedAt: z.string().min(1),
  coordinatorDecision: z.enum(['acknowledge', 'guidance']).optional(), coordinatorReason: z.string().min(1).optional(), guidance: z.string().min(1).optional(), reviewedAt: z.string().min(1).optional(),
})
const taskRunSchema = z.object({
  runSequence: z.number().int().positive(), startedAt: z.string().min(1), endedAt: z.string().min(1).optional(),
  sourceMessageId: z.string().min(1), objective: z.string().min(1), childSessionId: z.string().min(1),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)), stageTasks: z.array(z.string().min(1)), checkpoints: z.array(persistedTaskCheckpointSchema).optional(), result: persistedTaskResultSchema.optional(),
})
const taskStateEventSchema = z.object({ state: z.enum(['queued', 'running', 'waiting', 'completed']), at: z.string().min(1), runSequence: z.number().int().positive() })
const taskSchema = z.object({
  taskId: z.string().min(1), groupId: z.string().min(1), sourceMessageId: z.string().min(1), title: z.string().min(1).optional(), objective: z.string().min(1),
  state: z.enum(['queued', 'running', 'waiting', 'completed']), childSessionId: z.string().min(1),
  waitingReason: z.string().optional(), waitingKind: z.enum(['information', 'human-intervention']).optional(),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  triggerHistory: z.array(taskTriggerSchema).optional(),
  objectiveHistory: z.array(taskObjectiveRevisionSchema).optional(),
  runSequence: z.number().int().positive().optional(), runStartedAt: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional(), runHistory: z.array(taskRunSchema).optional(),
  relatedContexts: z.array(z.string().min(1)).optional(),
  checkpoints: z.array(persistedTaskCheckpointSchema).optional(),
  humanBlocker: humanBlockerSchema.optional(), humanBlockerHistory: z.array(humanBlockerSchema).optional(),
  completion: z.string().optional(), result: persistedTaskResultSchema.optional(), lastWaitingResult: persistedTaskResultSchema.optional(), lastCompletedResult: persistedTaskResultSchema.optional(),
  completionSequence: z.number().int().nonnegative().optional(),
  stateHistory: z.array(taskStateEventSchema).optional(),
  reopenContext: z.string().min(1).optional(), archivedAt: z.string().min(1).optional(), createdAt: z.string().min(1), updatedAt: z.string().min(1),
})
const schedulerSchema = z.object({
  tasks: z.array(taskSchema), groupConfigurationInitialized: z.boolean().optional(), agentNames: z.array(z.string().min(1)).optional(), agentWorkspaceDir: z.string().optional(), proxyUrl: z.string().optional(),
  taskExecutionGuidance: z.string().optional(), taskEvidenceGuidance: z.string().optional(), maxConcurrentTasks: z.number().int().positive().max(50).optional(),
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

export function taskSessionId(taskId) {
  if (typeof taskId !== 'string' || !taskId.startsWith('task-')) throw new Error(`task_id_invalid:${taskId}`)
  return `session-${taskId}`
}

const syntheticTaskSource = (value) => typeof value === 'string' && value.startsWith('web:')
const cleanRequiredList = (value, error) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(error)
  const cleaned = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
  if (cleaned.length !== value.length) throw new Error(error)
  return cleaned
}
const validateTaskMetadata = ({ group, sourceMessageId, title, objective, requesterName, requesterOpenDingTalkId, acceptanceCriteria }) => {
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  const cleanObjective = typeof objective === 'string' ? objective.trim() : ''
  if (cleanTitle === '' || cleanTitle.length > 120 || cleanTitle.startsWith('[TASK_SOURCE_EVIDENCE]')) throw new Error('task_title_invalid')
  if (cleanObjective === '' || cleanObjective.startsWith('[TASK_SOURCE_EVIDENCE]')) throw new Error('task_objective_invalid')
  if (typeof sourceMessageId !== 'string' || sourceMessageId.trim() === '') throw new Error('task_source_message_required')
  const source = group.messages.find((message) => message.messageId === sourceMessageId)
  if (!syntheticTaskSource(sourceMessageId) && source === undefined) throw new Error(`task_source_message_not_found:${sourceMessageId}`)
  if (syntheticTaskSource(sourceMessageId) && (typeof requesterName !== 'string' || requesterName.trim() === '' || typeof requesterOpenDingTalkId !== 'string' || requesterOpenDingTalkId.trim() === '')) throw new Error('task_synthetic_source_requester_required')
  const effectiveRequesterName = source?.senderName ?? requesterName
  const effectiveRequesterId = source?.senderOpenDingTalkId ?? requesterOpenDingTalkId
  if (typeof effectiveRequesterName !== 'string' || effectiveRequesterName.trim() === '' || typeof effectiveRequesterId !== 'string' || effectiveRequesterId.trim() === '') throw new Error('task_requester_required')
  return { title: cleanTitle, objective: cleanObjective, requesterName: effectiveRequesterName.trim(), requesterOpenDingTalkId: effectiveRequesterId.trim(), acceptanceCriteria: cleanRequiredList(acceptanceCriteria, 'task_acceptance_criteria_required') }
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
  for (const activity of activities.filter((item) => item.taskId === task.taskId && item.sessionId === task.childSessionId)) {
    const at = Date.parse(activity.occurredAt)
    if (!Number.isFinite(at) || at < startedAt || at > endedAt) continue
    const callId = activity.detail?.callId
    if ((activity.type === 'tool/call' || activity.type === 'tool/result') && !callId) toolIdentityMissing = true
    if (activity.type === 'tool/call' && callId) calls.set(callId, at)
    if (activity.type === 'tool/result' && callId && calls.has(callId)) { toolMs += Math.max(0, at - calls.get(callId)); calls.delete(callId) }
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
  if (persistedRuntime !== undefined) {
    for (const task of persistedRuntime.tasks) {
      if (tasks.get(task.taskId) === undefined) await tasks.put(task.taskId, task)
    }
    let changed = false
    const migratedTasks = [...tasks.entries()].map(([, task]) => {
      const withRun = task.runSequence === undefined ? {
        ...task,
        runSequence: (task.completionSequence ?? 0) + 1,
        runStartedAt: task.updatedAt ?? task.createdAt,
        acceptanceCriteria: task.acceptanceCriteria?.length ? task.acceptanceCriteria : [task.objective],
        stageTasks: task.stageTasks?.length ? task.stageTasks : ['完成并验证当前轮目标'],
        runHistory: task.runHistory ?? [],
      } : task
      if (withRun !== task) changed = true
      const realTriggers = (withRun.triggerHistory ?? []).filter((item) => !/^(?:web(?:-reopen)?:|recovery:)/u.test(item.sourceMessageId))
      const latestRealTrigger = [...realTriggers].reverse().find((item) => typeof item.requesterOpenDingTalkId === 'string')
      const withRealTrigger = latestRealTrigger && /^(?:web(?:-reopen)?:|recovery:)/u.test(withRun.sourceMessageId) ? {
        ...withRun,
        sourceMessageId: latestRealTrigger.sourceMessageId,
        ...(latestRealTrigger.requesterName ? { requesterName: latestRealTrigger.requesterName } : {}),
        requesterOpenDingTalkId: latestRealTrigger.requesterOpenDingTalkId,
        triggerHistory: realTriggers,
        updatedAt: new Date().toISOString(),
      } : withRun
      if (withRealTrigger !== withRun) changed = true
      if (withRealTrigger.state !== 'waiting' && withRealTrigger.result?.status === 'waiting') {
        changed = true
        return { ...withRealTrigger, lastWaitingResult: withRealTrigger.result, result: undefined, updatedAt: new Date().toISOString() }
      }
      if (withRealTrigger.result?.status !== 'waiting' || withRealTrigger.result.waitingKind !== undefined) return withRealTrigger
      changed = true
      return {
        ...withRealTrigger,
        state: 'running',
        waitingKind: undefined,
        waitingReason: undefined,
        humanBlocker: undefined,
        result: undefined,
        updatedAt: new Date().toISOString(),
      }
    })
    if (changed) {
      for (const task of migratedTasks) await tasks.put(task.taskId, task)
    }
  }
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
    getTaskExecutionGuidance: () => scheduler.get('runtime')?.taskExecutionGuidance ?? '',
    getTaskEvidenceGuidance: () => scheduler.get('runtime')?.taskEvidenceGuidance ?? '',
    setTaskGuidance: async ({ taskExecutionGuidance, taskEvidenceGuidance }) => {
      await scheduler.update('runtime', (current) => ({ ...current, taskExecutionGuidance, taskEvidenceGuidance }))
      return { taskExecutionGuidance, taskEvidenceGuidance }
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
      const group = { groupId, ...(name ? { name } : {}), responsibility, residentSessionId: residentSessionId ?? `session-${randomUUID()}`, ...(residentAgentPreset ? { residentAgentPreset } : {}), nextSequence: 1, messages: [], outbox: [] }
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
      await groups.delete(entry[0])
      return { removed: true, groupId }
    }),
    ingest: ({ groupId, messageId, text, occurredAt, senderName, senderOpenDingTalkId, quotedMessage }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      const duplicate = current.messages.find((message) => message.messageId === messageId)
      if (duplicate !== undefined) {
        const enrichSenderName = !duplicate.senderName && senderName
        const enrichSenderId = !duplicate.senderOpenDingTalkId && senderOpenDingTalkId
        const enrichQuotedMessage = quotedMessage && (
          !duplicate.quotedMessage
          || (!duplicate.quotedMessage.messageId && quotedMessage.messageId)
          || (missingText(duplicate.quotedMessage.senderName) && !missingText(quotedMessage.senderName))
          || (!duplicate.quotedMessage.occurredAt && quotedMessage.occurredAt)
        )
        if (!enrichSenderName && !enrichSenderId && !enrichQuotedMessage) return { duplicate: true, enriched: false, sequence: duplicate.sequence, group: current }
        const next = await groups.update(storageKey, (latest) => ({
          ...latest,
          messages: latest.messages.map((message) => message.messageId === messageId ? {
            ...message,
            ...(enrichSenderName ? { senderName } : {}),
            ...(enrichSenderId ? { senderOpenDingTalkId } : {}),
            ...(enrichQuotedMessage ? { quotedMessage: { ...(duplicate.quotedMessage ?? {}), ...quotedMessage } } : {}),
          } : message),
        }))
        return { duplicate: true, enriched: true, sequence: duplicate.sequence, group: next }
      }
      const accepted = { messageId, sequence: current.nextSequence, text, occurredAt, ...(senderName ? { senderName } : {}), ...(senderOpenDingTalkId ? { senderOpenDingTalkId } : {}), ...(quotedMessage ? { quotedMessage } : {}), agentDeliveryStatus: 'pending' }
      const next = await groups.update(storageKey, (latest) => ({
        ...latest, nextSequence: latest.nextSequence + 1,
        messages: [...latest.messages, accepted],
      }))
      return { duplicate: false, sequence: accepted.sequence, group: next }
    }),
    markMessageAgentDelivery: ({ groupId, messageId, status, error }) => serialize(groupId, async () => {
      if (!['delivered', 'failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      if (!entry[1].messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      return groups.update(entry[0], (latest) => ({
        ...latest,
        messages: latest.messages.map((message) => {
          if (message.messageId !== messageId) return message
          const { agentDeliveryError: _previousError, ...current } = message
          return {
            ...current,
            agentDeliveryStatus: status,
            agentDeliveryAt: new Date().toISOString(),
            ...(error ? { agentDeliveryError: error } : {}),
          }
        }),
      }))
    }),
    markMessagesAgentDelivery: ({ groupId, status = 'delivered', onlyMissing = true, messageIds }) => serialize(groupId, async () => {
      if (!['delivered', 'failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
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
          const { agentDeliveryError: _previousError, ...current } = message
          return { ...current, agentDeliveryStatus: status, agentDeliveryAt: at }
        }),
      }))
      return { groupId, status, onlyMissing, ...(messageIds !== undefined ? { messageIds } : {}), updated, total: group.messages.length, group }
    }),
    appendOutbox: ({ groupId, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      const existing = current.outbox.find((item) => item.sourceMessageId === sourceMessageId)
      if (existing !== undefined) return current
      return groups.update(storageKey, (latest) => ({
        ...latest,
        outbox: [...latest.outbox, {
          outboundId: `outbound-${randomUUID()}`, sourceMessageId, text, status: 'pending', readbackRequired: true,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(replyToSenderOpenDingTalkId ? { replyToSenderOpenDingTalkId } : {}),
          ...(Array.isArray(atOpenDingTalkIds) && atOpenDingTalkIds.length > 0 ? { atOpenDingTalkIds } : {}),
        }],
      }))
    }),
    acknowledge: ({ groupId, outboundId, deliveredMessageId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? { ...item, status: 'sent', ...(deliveredMessageId ? { deliveredMessageId } : {}) } : item) }))
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
    createTask: async ({ groupId, sourceMessageId, title, objective, requesterName, requesterOpenDingTalkId, occurredAt, acceptanceCriteria = [], stageTasks = [], relatedContexts = [] }) => {
      const group = findGroupEntry(groupId)?.[1]
      if (group === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const duplicate = [...tasks.entries()].map(([, task]) => task).find((task) => task.groupId === groupId && task.sourceMessageId === sourceMessageId)
      if (duplicate !== undefined) return { created: false, task: duplicate }
      const now = new Date().toISOString()
      const taskId = `task-${randomUUID()}`
      const metadata = validateTaskMetadata({ group, sourceMessageId, title, objective, requesterName, requesterOpenDingTalkId, acceptanceCriteria })
      const trigger = { sourceMessageId, requesterName: metadata.requesterName, requesterOpenDingTalkId: metadata.requesterOpenDingTalkId, ...(occurredAt !== undefined ? { occurredAt } : {}) }
      const task = { taskId, groupId, sourceMessageId, title: metadata.title, objective: metadata.objective, state: 'queued', childSessionId: taskSessionId(taskId), requesterName: metadata.requesterName, requesterOpenDingTalkId: metadata.requesterOpenDingTalkId, triggerHistory: [trigger], runSequence: 1, runStartedAt: now, acceptanceCriteria: metadata.acceptanceCriteria, stageTasks: stageTasks.length > 0 ? stageTasks : ['完成并验证当前轮目标'], runHistory: [], stateHistory: [{ state: 'queued', at: now, runSequence: 1 }], ...(relatedContexts.length > 0 ? { relatedContexts } : {}), createdAt: now, updatedAt: now }
      await tasks.put(taskId, task)
      return { created: true, task }
    },
    updateTask: async (taskId, transform) => {
      if (tasks.get(taskId) === undefined) throw new Error(`task_not_found:${taskId}`)
      return tasks.update(taskId, (task) => {
        const at = new Date().toISOString()
        const next = transform(task)
        const stateChangedAt = next.runSequence !== task.runSequence && next.runStartedAt ? next.runStartedAt : at
        const stateHistory = next.state !== task.state ? [...(task.stateHistory ?? []), { state: next.state, at: stateChangedAt, runSequence: next.runSequence ?? task.runSequence ?? 1 }] : task.stateHistory
        return { ...next, ...(stateHistory ? { stateHistory } : {}), updatedAt: at }
      })
    },
    migrateTaskProvenance: async ({ taskId, sourceMessageId, completionDelivered = false }) => {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const entry = findGroupEntry(task.groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${task.groupId}`)
      const [storageKey, group] = entry
      const source = group.messages.find((message) => message.messageId === sourceMessageId)
      if (source === undefined) throw new Error(`task_source_message_not_found:${sourceMessageId}`)
      if (!source.senderName || !source.senderOpenDingTalkId) throw new Error(`task_source_sender_missing:${sourceMessageId}`)
      const migrated = await tasks.update(taskId, (current) => ({ ...current, sourceMessageId, requesterName: source.senderName, requesterOpenDingTalkId: source.senderOpenDingTalkId, updatedAt: new Date().toISOString() }))
      const resultKey = `task-result:${taskId}:completed`
      await groups.update(storageKey, (latest) => ({
        ...latest,
        outbox: latest.outbox.map((outbound) => outbound.sourceMessageId === resultKey ? {
          ...outbound,
          replyToMessageId: sourceMessageId,
          replyToSenderOpenDingTalkId: source.senderOpenDingTalkId,
          atOpenDingTalkIds: [source.senderOpenDingTalkId],
          ...(completionDelivered ? { status: 'sent' } : {}),
        } : outbound),
      }))
      return migrated
    },
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
