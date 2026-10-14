import { PERFORMANCE_EVENT_TYPES, listPerformance, coordinationCosts } from './performance.js'

/** Read-only views over current native identities. Performance uses the existing durable
 * resident ledger; the bounded activity window is explicitly process-local metadata.
 * resolveSessionIdentity must validate ownership against the current task/execution store.
 * No log discovery, historical replay, business-state inference or second durable store.
 */
export function createTaskSessionObservability({ store, listTasks, resolveSessionIdentity,
  observedSince = new Date().toISOString(), activityLimit = 500 } = {}) {
  if (!Number.isSafeInteger(activityLimit) || activityLimit < 1 || activityLimit > 500) throw new Error('activity_limit_invalid')
  const activities = new Map()
  const currentIds = () => new Set(listTasks().map(task => task.taskId))
  const performance = (filter = {}) => {
    const base = store.listPerformance?.(filter) ?? listPerformance(undefined, filter)
    const ids = currentIds(), rows = base.rows.filter(row => ids.has(row.taskId))
    const { workflow: _retired, coordination: _oldCoordination, ...result } = base
    return { ...result, rows, coordination: coordinationCosts(rows),
      completeness: 'incomplete', limitations: ['observed-native-events-only', 'business-wait-boundaries-unavailable'],
      ...(typeof store.recordPerformanceEvent !== 'function' || typeof store.listPerformance !== 'function' ? { status: 'unsupported' } : {}) }
  }
  return {
    async observe(session, event) {
      const sessionId = String(session?.id ?? ''), identity = resolveSessionIdentity(sessionId)
      if (!identity || !currentIds().has(identity.taskId) || !PERFORMANCE_EVENT_TYPES.has(event?.type)
        || !Number.isSafeInteger(event.seq) || event.seq < (session.firstLiveSeq ?? 0)) return { created: false }
      const time = typeof event.time === 'number' ? event.time : Date.parse(event.time)
      if (!Number.isFinite(time) || time < 0 || time > 8640000000000000) return { created: false }
      const eventKey = `${sessionId}:${event.seq}`
      if (!activities.has(eventKey)) {
        const data = event.data ?? {}, detail = {}
        for (const key of ['turn', 'step']) if (Number.isSafeInteger(data[key])) detail[key] = data[key]
        // No message bodies, arguments, outputs, tool names or opaque call identifiers.
        if (event.type === 'tool/result') detail.isError = !!(data.error || data.message?.isError)
        activities.set(eventKey, { activityId: eventKey, eventKey, sessionId, taskId: identity.taskId,
          ...(identity.groupId ? { groupId: identity.groupId } : {}), type: event.type, seq: event.seq,
          occurredAt: new Date(time).toISOString(), detail, observedSince, coverage: 'bounded-process-window', completeness: 'incomplete' })
        while (activities.size > activityLimit) activities.delete(activities.keys().next().value)
      }
      // Native session seq + seed boundary retain existing durable deduplication semantics.
      return store.recordPerformanceEvent?.({ ...identity, sessionId, event, seedSeq: (session.firstLiveSeq ?? 0) - 1 })
        ?? { created: false, status: 'unsupported' }
    },
    listActivities(taskId) {
      const ids = currentIds()
      return structuredClone([...activities.values()].filter(item => ids.has(item.taskId) && (taskId === undefined || item.taskId === taskId)))
    },
    listPerformance: performance,
    listTaskTimings() {
      const result = performance()
      return listTasks().map(task => {
        const rows = result.rows.filter(row => row.taskId === task.taskId)
        return { taskId: task.taskId, runSequence: task.runSequence ?? null,
          wallMs: null, queuedMs: null, runningMs: null, waitingMs: null, modelMs: null, toolMs: null, unclassifiedRunningMs: null,
          observedModelSessionMs: rows.some(row => row.modelCalls > 0) && !rows.some(row => row.missingStepStart > 0)
            ? rows.reduce((sum, row) => sum + row.modelActiveMs, 0) : null,
          observedToolSessionMs: rows.some(row => row.toolResults > 0) && !rows.some(row => row.missingToolCall > 0 || row.missingToolResult > 0 || row.toolCalls > row.toolResults)
            ? rows.reduce((sum, row) => sum + row.toolActiveMs, 0) : null,
          observedSince: result.observedSince, complete: false, completeness: 'incomplete',
          missing: ['state-history'], limitations: ['session-time-sums-not-wall-time', 'business-state-boundaries-unavailable', 'observed-native-events-only'] }
      })
    },
    getActivityAuditStatus: () => ({ status: 'unsupported', total: null, pending: null, audited: null,
      unavailable: [], observedSince, completeness: 'incomplete', reason: 'native-history-audit-not-installed' }),
  }
}
