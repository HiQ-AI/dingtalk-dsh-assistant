import { z } from 'zod'

// 只投影计量元数据；正文、工具参数和结果不进入这个持久投影。
export const PERFORMANCE_EVENT_TYPES = new Set(['dingtalk/coordination-dispatched', 'user/message', 'step/start', 'assistant/chunk', 'assistant/message', 'step/end', 'tool/call', 'tool/result'])
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
const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const dayAt = time => dayFormatter.format(time)
const timestamp = value => typeof value === 'number' ? value : Date.parse(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value)
const stepKey = event => JSON.stringify([event.data?.turn, event.data?.step])
export const performanceChunkKey = input => JSON.stringify([input.sessionId, input.event.data?.turn, input.event.data?.step])
export function hasPerformanceFirstStream(projection, input) {
  const session = projection?.sessions[input.sessionId], step = session?.steps[stepKey(input.event)]
  return step?.firstStreamAt !== undefined || step?.completed === true || isCompletedStep(session, input.event)
}
const isCompletedStep = (session, event) => session?.completedSteps?.[String(event.data?.turn)]?.some(([start, end]) => event.data?.step >= start && event.data?.step <= end) ?? false
function mergeIntervals(intervals, start, end, adjacent = 0) {
  const result = []
  for (const interval of [...intervals, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1)
    if (last && interval[0] <= last[1] + adjacent) last[1] = Math.max(last[1], interval[1])
    else result.push([...interval])
  }
  return result
}
const distribution = () => ({ count: 0, sum: 0, max: 0, frequencies: {} })
const addSample = (target, value) => { target.count++; target.sum += value; target.max = Math.max(target.max, value); target.frequencies[value] = (target.frequencies[value] ?? 0) + 1 }
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
function bucketFor(projection, identity, time) {
  const day = dayAt(time), key = JSON.stringify([day, identity.sessionId, identity.groupId, identity.taskId, identity.requestId, identity.submissionId])
  return projection.buckets[key] ??= { ...identity, day, modelCalls: 0, missingUsage: 0, interrupted: 0, toolCalls: 0, toolResults: 0, toolErrors: 0,
    missingStepStart: 0, missingToolCall: 0, missingFirstStream: 0, missingToolResult: 0, coordinationMessages: 0, coordinationInputBytes: 0,
    missingCoordinationQueue: 0, coordinationQueueMs: distribution(),
    usage: { ...Object.fromEntries(fields.map(field => [field, 0])), totalInputTokens: 0, missingFields: {} },
    contextTokens: distribution(), firstStreamMs: distribution(), modelResponseMs: distribution(), toolMs: distribution(), modelIntervals: [], toolIntervals: [] }
}
function recordInterval(projection, identity, kind, start, end) {
  // 按上海自然日切分后求并集；跨日耗时不会全部算在完成日。
  while (start < end) {
    const bucket = bucketFor(projection, identity, start)
    const nextMidnight = Date.parse(`${bucket.day}T00:00:00+08:00`) + 86400000
    const stop = Math.min(end, nextMidnight)
    bucket[`${kind}Intervals`] = mergeIntervals(bucket[`${kind}Intervals`], start, stop)
    start = stop
  }
}

export function projectPerformanceEvent(previous, input) {
  const { event, seedSeq = -1 } = input
  if (!PERFORMANCE_EVENT_TYPES.has(event?.type) || event.seq <= seedSeq) return { created: false, projection: previous }
  const identity = identitySchema.parse(input), time = timestamp(event.time)
  if (!Number.isInteger(event.seq) || event.seq < 0 || !Number.isFinite(time) || time < 0) throw new Error('performance_event_identity_invalid')
  const existing = previous?.sessions[identity.sessionId]
  if (existing?.seen.some(([start, end]) => event.seq >= start && event.seq <= end)
    || (event.type === 'assistant/chunk' && hasPerformanceFirstStream(previous, input))) return { created: false, projection: previous }
  const projection = structuredClone(previous ?? { observedSince: new Date().toISOString(), buckets: {}, sessions: {} })
  const session = projection.sessions[identity.sessionId] ??= { seen: [], steps: {}, completedSteps: {}, calls: {} }
  session.seen = mergeIntervals(session.seen, event.seq, event.seq, 1)
  const bucket = bucketFor(projection, identity, time), key = stepKey(event), data = event.data ?? {}
  const step = session.steps[key] ?? {}
  if (['step/start', 'assistant/chunk', 'assistant/message'].includes(event.type) && !isCompletedStep(session, event)) session.steps[key] = step
  if (event.type === 'user/message' && data.source?.kind === 'coordinator') {
    bucket.coordinationMessages++
    bucket.coordinationInputBytes += Buffer.byteLength(JSON.stringify(data.content ?? []), 'utf8')
  }
  if (event.type === 'dingtalk/coordination-dispatched') {
    if (Number.isFinite(data.queuedAt) && data.queuedAt >= 0 && Number.isFinite(data.dispatchedAt) && data.dispatchedAt >= data.queuedAt
      && typeof identity.requestId === 'string' && data.requestId === identity.requestId) addSample(bucket.coordinationQueueMs, data.dispatchedAt - data.queuedAt)
    else bucket.missingCoordinationQueue++
  }
  if (event.type === 'step/start') step.startedAt ??= time
  if (event.type === 'assistant/chunk') {
    step.firstStreamAt = time
    if (step.startedAt !== undefined && time >= step.startedAt) addSample(bucket.firstStreamMs, time - step.startedAt)
  }
  if (event.type === 'assistant/message') {
    // 同一步的投影替换即使有新 seq 也不当作新模型调用。
    if (!step.completed && !isCompletedStep(session, event)) {
      step.completed = true
      bucket.modelCalls++
      if (data.interrupted) bucket.interrupted++
      if (!data.usage) bucket.missingUsage++
      for (const field of fields) {
        const value = data.usage?.[field]
        if (Number.isFinite(value) && value >= 0) bucket.usage[field] += value
        else bucket.usage.missingFields[field] = (bucket.usage.missingFields[field] ?? 0) + 1
      }
      const inputFields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      const totalInput = inputFields.reduce((sum, field) => sum + (Number.isFinite(data.usage?.[field]) && data.usage[field] >= 0 ? data.usage[field] : 0), 0)
      bucket.usage.totalInputTokens += totalInput
      if (Number.isFinite(data.usage?.inputTokens) && data.usage.inputTokens >= 0) addSample(bucket.contextTokens, totalInput)
      if (step.firstStreamAt === undefined) bucket.missingFirstStream++
      if (step.startedAt !== undefined && time >= step.startedAt) {
        addSample(bucket.modelResponseMs, time - step.startedAt)
        recordInterval(projection, identity, 'model', step.startedAt, time)
      } else bucket.missingStepStart++
    }
  }
  if (event.type === 'tool/call' && typeof data.callId === 'string') {
    if (!session.calls[data.callId]) { session.calls[data.callId] = { ...identity, startedAt: time, stepKey: key }; bucket.toolCalls++ }
  }
  if (event.type === 'tool/result') {
    const callId = data.message?.source?.callId, call = session.calls[callId]
    bucket.toolResults++
    if (data.error || data.message?.content?.some(block => block.type === 'tool-result' && block.isError)) bucket.toolErrors++
    if (call && time >= call.startedAt) {
      addSample(bucket.toolMs, time - call.startedAt)
      recordInterval(projection, identitySchema.parse(call), 'tool', call.startedAt, time)
      delete session.calls[callId]
    } else bucket.missingToolCall++
  }
  if (event.type === 'step/end') {
    // 原生step/end是模型及工具阶段的明确终点；保留缺失计数，不让未配对call永久挂住。
    for (const [callId, call] of Object.entries(session.calls)) if (call.stepKey === key) { bucket.missingToolResult++; delete session.calls[callId] }
    if (step.completed && Number.isInteger(data.turn) && Number.isInteger(data.step)) {
      session.completedSteps ??= {}
      session.completedSteps[String(data.turn)] = mergeIntervals(session.completedSteps[String(data.turn)] ?? [], data.step, data.step, 1)
    }
    delete session.steps[key]
  }
  return { created: true, projection }
}

export function listPerformance(projection, filter = {}) {
  const unionMs = intervals => intervals.reduce((sum, [start, end]) => sum + end - start, 0)
  const summarize = ({ frequencies, ...value }) => {
    const entries = Object.entries(frequencies).map(([sample, count]) => [Number(sample), count]).sort((a, b) => a[0] - b[0])
    const percentile = ratio => {
      if (!value.count) return null
      let count = 0
      for (const [sample, frequency] of entries) { count += frequency; if (count >= Math.ceil(value.count * ratio)) return sample }
      return null
    }
    return { ...value, p50: percentile(0.5), p95: percentile(0.95) }
  }
  return { observedSince: projection?.observedSince ?? null, coverage: 'observed-events-only', timezone: 'Asia/Shanghai',
    retention: { policy: 'full-observed-metadata', writePartition: 'session', closedStepDetails: 'compacted-to-step-ranges', limitation: 'Exact frequencies, deduplication ranges and daily interval unions grow with retained history; no arbitrary truncation.' },
    rows: Object.values(projection?.buckets ?? {}).filter(row => ['day', 'sessionId', 'groupId', 'taskId', 'requestId', 'submissionId'].every(field => filter[field] === undefined || row[field] === filter[field]))
      .map(({ modelIntervals, toolIntervals, ...row }) => ({ ...structuredClone(row), ...Object.fromEntries(['contextTokens', 'firstStreamMs', 'modelResponseMs', 'toolMs', 'coordinationQueueMs'].map(field => [field, summarize(row[field] ?? distribution())])), modelActiveMs: unionMs(modelIntervals), toolActiveMs: unionMs(toolIntervals),
        combinedActiveMs: unionMs(toolIntervals.reduce((all, [start, end]) => mergeIntervals(all, start, end), modelIntervals)) })) }
}

// 业务等待与回复只从已持久化的边界派生；不以running减工具时间冒充模型或等待时间。
export function workflowPerformance({ tasks, groups }, filter = {}, now = Date.now()) {
  const rows = new Map(), responses = [], missing = new Set()
  const matches = (item, keys) => keys.every(key => filter[key] === undefined || item[key] === filter[key])
  const addInterval = (task, runSequence, kind, start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { missing.add('invalid-or-missing-event-time'); return }
    while (start < end) {
      const day = dayAt(start), stop = Math.min(end, Date.parse(`${day}T00:00:00+08:00`) + 86400000)
      const identity = { taskId: task.taskId, groupId: task.groupId, runSequence, day }
      if (matches(identity, ['taskId', 'groupId', 'day'])) {
        const key = JSON.stringify([task.taskId, runSequence, day])
        const row = rows.get(key) ?? { ...identity, intervals: {}, missing: new Set() }
        row.intervals[kind] = mergeIntervals(row.intervals[kind] ?? [], start, stop)
        if (kind === 'unknownWait') row.missing.add('historical-waiting-kind')
        rows.set(key, row)
      }
      start = stop
    }
  }
  // request/session过滤不能可靠下推到Task状态历史，宁可缺失而不混入其它执行时间。
  if (filter.requestId || filter.sessionId || filter.submissionId) missing.add('task-state-has-no-request-session-submission-link')
  else for (const task of tasks.filter(item => matches(item, ['taskId', 'groupId']))) {
    const states = [...(task.stateHistory ?? [])].sort((a, b) => timestamp(a.at) - timestamp(b.at))
    if (!states.length) missing.add('task-state-history')
    for (let index = 0; index < states.length; index++) {
      const event = states[index], start = timestamp(event.at), end = Math.min(now, index + 1 < states.length ? timestamp(states[index + 1].at) : now)
      const kind = event.state === 'queued' ? 'queued' : event.state === 'running' ? 'running'
        : event.state === 'waiting' ? ({ system: 'systemWait', 'human-intervention': 'humanWait', information: 'informationWait', coordination: 'coordinationWait' }[event.waitingKind] ?? 'unknownWait') : undefined
      if (kind) addInterval(task, event.runSequence, kind, start, end)
    }
    const pending = new Map()
    for (const event of [...(task.executionEvents ?? [])].filter(event => ['task-report-received', 'task-report-settled'].includes(event.kind)).sort((a, b) => timestamp(a.at) - timestamp(b.at))) {
      const existing = pending.get(event.submissionId)
      if (existing) {
        addInterval(task, existing.runSequence, existing.kind, existing.start, Math.min(timestamp(event.at), now))
        pending.delete(event.submissionId)
      }
      const kind = event.status === 'review-wait' ? 'reviewWait' : event.status === 'input-wait' ? 'reportInputWait' : undefined
      if (kind) pending.set(event.submissionId, { kind, start: timestamp(event.at), runSequence: event.runSequence })
    }
    for (const wait of pending.values()) {
      const completion = states.find(event => event.runSequence === wait.runSequence && event.state === 'completed' && timestamp(event.at) >= wait.start)
      if (completion) missing.add('unsettled-report-after-completion')
      addInterval(task, wait.runSequence, wait.kind, wait.start, Math.min(completion ? timestamp(completion.at) : now, now))
    }
  }
  if (filter.requestId || filter.sessionId || filter.submissionId || filter.taskId) missing.add('reply-has-no-exact-request-session-submission-link')
  else for (const group of groups.filter(item => matches(item, ['groupId']))) {
    const delivered = group.outbox.filter(item => item.status === 'sent' && item.deliveredMessageId && Number.isFinite(timestamp(item.deliveredAt)))
    for (const message of group.messages) {
      if (message.sourceKind && message.sourceKind !== 'dingtalk') continue
      const start = timestamp(message.occurredAt)
      if (!Number.isFinite(start)) { missing.add('inbound-event-time'); continue }
      const day = dayAt(start)
      if (filter.day && filter.day !== day) continue
      const replies = delivered.filter(item => item.replyToMessageId === message.messageId && timestamp(item.deliveredAt) >= start).sort((a, b) => timestamp(a.deliveredAt) - timestamp(b.deliveredAt))
      const first = replies[0], substantive = replies.find(item => item.replyKind === 'substantive')
      responses.push({ groupId: group.groupId, messageId: message.messageId, day,
        firstReplyMs: first ? timestamp(first.deliveredAt) - start : null,
        firstLabeledSubstantiveReplyMs: substantive ? timestamp(substantive.deliveredAt) - start : null,
        ...(first ? { outboundId: first.outboundId, deliveredMessageId: first.deliveredMessageId } : {}),
        missing: [...(!first ? ['no-delivered-exact-reply-match'] : []), ...(!substantive ? ['no-substantive-label-match'] : [])] })
    }
  }
  missing.add('historical-coordination-queue-boundaries-not-backfilled')
  missing.add('substantive-reply-label-is-not-manual-content-verification')
  return { asOf: new Date(now).toISOString(), scope: 'retained-persisted-events',
    taskWaits: [...rows.values()].map(({ intervals, missing: rowMissing, ...identity }) => ({ ...identity,
      ...Object.fromEntries(['queued', 'running', 'systemWait', 'humanWait', 'informationWait', 'coordinationWait', 'unknownWait', 'reviewWait', 'reportInputWait'].map(kind => [`${kind}Ms`, (intervals[kind] ?? []).reduce((sum, [start, end]) => sum + end - start, 0)])),
      missing: [...rowMissing] })), responses,
    missing: [...missing], semantics: { waits: 'Each category uses interval union; report waits may overlap running or other waits and must not be added as disjoint wall time.', responses: 'Exact replyToMessageId plus persisted deliveredMessageId/deliveredAt; date follows inbound message.' } }
}

export function coordinationCosts(rows) {
  const requests = new Map()
  for (const row of rows) {
    if (!row.requestId) continue
    const key = JSON.stringify([row.groupId, row.requestId]), request = requests.get(key) ?? { groupId: row.groupId, requestId: row.requestId, sessions: new Set(), modelCalls: 0, totalInputTokens: 0, uncachedInputTokens: 0, coordinationMessages: 0, coordinationInputBytes: 0, queueSamples: 0, queueMs: 0, missingQueueBoundaries: 0 }
    request.sessions.add(row.sessionId)
    request.modelCalls += row.modelCalls; request.totalInputTokens += row.usage.totalInputTokens; request.uncachedInputTokens += row.usage.inputTokens
    request.coordinationMessages += row.coordinationMessages ?? 0; request.coordinationInputBytes += row.coordinationInputBytes ?? 0
    request.queueSamples += row.coordinationQueueMs?.count ?? 0; request.queueMs += row.coordinationQueueMs?.sum ?? 0; request.missingQueueBoundaries += row.missingCoordinationQueue ?? 0
    requests.set(key, request)
  }
  return { requests: [...requests.values()].map(({ sessions, ...request }) => ({ ...request, sessionCount: sessions.size, additionalSessions: Math.max(0, sessions.size - 1) })),
    coverage: 'Observed coordinator user-message content bytes and model usage; excludes unobserved seeds, transport headers, billing and unlinked legacy requests.' }
}
