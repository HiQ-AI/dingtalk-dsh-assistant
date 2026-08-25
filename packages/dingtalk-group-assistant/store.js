import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { taskResultSchema } from './task-result.js'

const missingText = (value) => typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'null'

const quotedMessageSchema = z.object({ messageId: z.string().min(1).optional(), senderName: z.string().min(1).optional(), occurredAt: z.union([z.string().min(1), z.number().finite()]).optional(), content: z.string() })
const inboundSchema = z.object({ messageId: z.string().min(1), sequence: z.number().int().positive(), text: z.string(), occurredAt: z.union([z.string().min(1), z.number().finite()]), senderName: z.string().min(1).optional(), senderOpenDingTalkId: z.string().min(1).optional(), quotedMessage: quotedMessageSchema.optional(), agentDeliveryStatus: z.enum(['pending', 'delivered', 'failed', 'skipped']).optional(), agentDeliveryAt: z.string().min(1).optional(), agentDeliveryError: z.string().min(1).optional() })
const outboundSchema = z.object({
  outboundId: z.string().min(1), sourceMessageId: z.string().min(1), text: z.string(), status: z.enum(['pending', 'sent']),
  replyToMessageId: z.string().min(1).optional(), replyToSenderOpenDingTalkId: z.string().min(1).optional(),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional(),
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
  groupId: z.string().min(1), name: z.string().optional(), responsibility: z.string(), residentSessionId: z.string().min(1), nextSequence: z.number().int().positive(),
  messages: z.array(inboundSchema), outbox: z.array(outboundSchema),
})
const taskSchema = z.object({
  taskId: z.string().min(1), groupId: z.string().min(1), sourceMessageId: z.string().min(1), objective: z.string().min(1),
  state: z.enum(['queued', 'running', 'waiting', 'completed']), childSessionId: z.string().min(1),
  waitingReason: z.string().optional(), waitingKind: z.enum(['information', 'human-intervention']).optional(),
  requesterName: z.string().min(1).optional(), requesterOpenDingTalkId: z.string().min(1).optional(),
  relatedContexts: z.array(z.string().min(1)).optional(),
  humanBlocker: humanBlockerSchema.optional(), humanBlockerHistory: z.array(humanBlockerSchema).optional(),
  completion: z.string().optional(), result: persistedTaskResultSchema.optional(), lastWaitingResult: persistedTaskResultSchema.optional(), lastCompletedResult: persistedTaskResultSchema.optional(),
  completionSequence: z.number().int().nonnegative().optional(),
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
  name: 'dingtalk_group_assistant', version: 5, tables: {
    groups: domainTable(groupSchema), scheduler: domainTable(schedulerSchema), tasks: domainTable(taskSchema), alerts: domainTable(alertSchema), activities: domainTable(activitySchema),
  },
})

export function taskSessionId(taskId) {
  if (typeof taskId !== 'string' || !taskId.startsWith('task-')) throw new Error(`task_id_invalid:${taskId}`)
  return `session-${taskId}`
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
      if (task.state !== 'waiting' && task.result?.status === 'waiting') {
        changed = true
        return { ...task, lastWaitingResult: task.result, result: undefined, updatedAt: new Date().toISOString() }
      }
      if (task.result?.status !== 'waiting' || task.result.waitingKind !== undefined) return task
      changed = true
      return {
        ...task,
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
    listAlerts: () => [...alerts.entries()].map(([, value]) => value),
    listActivities: (taskId) => [...activities.entries()].map(([, value]) => value)
      .filter((activity) => taskId === undefined || activity.taskId === taskId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .slice(-ACTIVITY_PROJECTION_LIMIT_PER_TASK),
    subscribe: ({ groupId, name, responsibility = '', residentSessionId }) => serialize(groupId, async () => {
      const existing = findGroupEntry(groupId)?.[1]
      if (existing !== undefined) return { created: false, group: existing }
      const group = { groupId, ...(name ? { name } : {}), responsibility, residentSessionId: residentSessionId ?? `session-${randomUUID()}`, nextSequence: 1, messages: [], outbox: [] }
      await groups.put(groupId, group)
      return { created: true, group }
    }),
    updateGroup: ({ groupId, name, responsibility, residentSessionId }) => serialize(groupId, async () => {
      if (name === undefined && responsibility === undefined && residentSessionId === undefined) throw new Error('group_update_empty')
      if (name !== undefined && typeof name !== 'string') throw new Error('group_name_invalid')
      if (responsibility !== undefined && typeof responsibility !== 'string') throw new Error('group_responsibility_invalid')
      if (residentSessionId !== undefined && typeof residentSessionId !== 'string') throw new Error('group_resident_session_invalid')
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      return groups.update(entry[0], (group) => ({
        ...group,
        ...(name !== undefined ? { name } : {}),
        ...(responsibility !== undefined ? { responsibility } : {}),
        ...(residentSessionId !== undefined ? { residentSessionId } : {}),
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
    markMessagesAgentDelivery: ({ groupId, status = 'delivered', onlyMissing = true }) => serialize(groupId, async () => {
      if (!['delivered', 'failed', 'skipped'].includes(status)) throw new Error(`message_agent_delivery_status_invalid:${status}`)
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      let updated = 0
      const at = new Date().toISOString()
      const group = await groups.update(entry[0], (latest) => ({
        ...latest,
        messages: latest.messages.map((message) => {
          if (onlyMissing && message.agentDeliveryStatus) return message
          updated += 1
          return { ...message, agentDeliveryStatus: status, agentDeliveryAt: at }
        }),
      }))
      return { groupId, status, onlyMissing, updated, total: group.messages.length, group }
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
          outboundId: `outbound-${randomUUID()}`, sourceMessageId, text, status: 'pending',
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(replyToSenderOpenDingTalkId ? { replyToSenderOpenDingTalkId } : {}),
          ...(Array.isArray(atOpenDingTalkIds) && atOpenDingTalkIds.length > 0 ? { atOpenDingTalkIds } : {}),
        }],
      }))
    }),
    acknowledge: ({ groupId, outboundId }) => serialize(groupId, async () => {
      const entry = findGroupEntry(groupId)
      if (entry === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const [storageKey, current] = entry
      if (!current.outbox.some((item) => item.outboundId === outboundId)) throw new Error(`outbound_not_found:${outboundId}`)
      return groups.update(storageKey, (latest) => ({ ...latest, outbox: latest.outbox.map((item) => item.outboundId === outboundId ? { ...item, status: 'sent' } : item) }))
    }),
    createTask: async ({ groupId, sourceMessageId, objective, requesterName, requesterOpenDingTalkId }) => {
      if (findGroupEntry(groupId) === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const duplicate = [...tasks.entries()].map(([, task]) => task).find((task) => task.groupId === groupId && task.sourceMessageId === sourceMessageId)
      if (duplicate !== undefined) return { created: false, task: duplicate }
      const now = new Date().toISOString()
      const taskId = `task-${randomUUID()}`
      const task = { taskId, groupId, sourceMessageId, objective, state: 'queued', childSessionId: taskSessionId(taskId), ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), createdAt: now, updatedAt: now }
      await tasks.put(taskId, task)
      return { created: true, task }
    },
    updateTask: async (taskId, transform) => {
      if (tasks.get(taskId) === undefined) throw new Error(`task_not_found:${taskId}`)
      return tasks.update(taskId, (task) => ({ ...transform(task), updatedAt: new Date().toISOString() }))
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
    recordActivity: async ({ taskId, sessionId, eventKey, type, detail = {} }) => {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const key = `${taskId}:${eventKey}`
      const existing = activities.get(key)
      if (existing !== undefined) return { created: false, activity: existing }
      const projectedCount = [...activities.entries()].filter(([, activity]) => activity.taskId === taskId).length
      if (projectedCount >= ACTIVITY_PROJECTION_LIMIT_PER_TASK) return { created: false, capped: true }
      const activity = { activityId: `activity-${randomUUID()}`, taskId, sessionId, eventKey, type, detail, occurredAt: new Date().toISOString() }
      await activities.put(key, activity)
      return { created: true, activity }
    },
    close: () => domain.close(),
  }
}
