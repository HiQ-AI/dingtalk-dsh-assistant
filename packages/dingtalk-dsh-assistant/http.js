import { checkForUpdates } from './version-check.js'
import { z } from 'zod'
import { isPendingDecision, topicDecisionRecovery } from './topic-model.js'
import { taskContextProgressImpactSchema, taskContextSemanticsProblem } from './task-input-contract.js'

const WEB_ORIGINS = new Set(['http://127.0.0.1:3080', 'http://localhost:3080'])

function localConfigurationRequest(request) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)
    || request.headers.origin && !WEB_ORIGINS.has(request.headers.origin)) return false
  try {
    const host = request.headers.host
    if (typeof host !== 'string' || host.length > 200) return false
    const address = new URL(`http://${host}`)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && address.host === host.toLowerCase()
      && !address.username && !address.password && address.pathname === '/' && !address.search && !address.hash
      && (!request.socket.localPort || Number(address.port || 80) === request.socket.localPort)
  } catch { return false }
}

export function applyResidentCorsHeaders(request, response) {
  const origin = request.headers.origin
  if (WEB_ORIGINS.has(origin)) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'Origin')
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type')
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function pageNumber(url, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  if (!/^\d+$/u.test(raw)) throw new Error(`invalid_${name}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0) || value > maximum) throw new Error(`invalid_${name}`)
  return value
}

function topicSummary(topic) {
  const unfinished = topic.decisions?.findLast(isPendingDecision)
  const pendingUnits = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision).map((entry) => entry.unitId ?? `legacy:${entry.messageId}`))
  return {
    topicId: topic.topicId, groupId: topic.groupId, title: topic.title,
    revision: topic.revision, processedRevision: topic.processedRevision, status: topic.status,
    ...(topic.mergedInto ? { mergedInto: topic.mergedInto, mergeReceipt: topic.mergeReceipt } : {}),
    summary: String(topic.summary ?? '').slice(0, 1000),
    summaryRevision: topic.summaryRevision,
    openQuestionCount: topic.openQuestions?.length ?? 0,
    pendingRevisionCount: Math.max(0, topic.revision - topic.processedRevision),
    pendingUnitCount: pendingUnits.size,
    ...(unfinished ? { processing: { decisionId: unfinished.decisionId, status: unfinished.status, appliedOperations: (unfinished.operations ?? []).filter((item) => item.status === 'applied').length, totalOperations: unfinished.operations?.length ?? 0, ...(unfinished.error ? { error: String(unfinished.error).slice(0, 1000) } : {}) } } : {}),
    createdAt: topic.createdAt, updatedAt: topic.updatedAt,
  }
}
function workflowTopicSummary(topic) {
  return { topicId: topic.topicId, groupId: topic.conversationId, title: topic.title,
    revision: topic.revision, processedRevision: topic.revision, status: 'active',
    summary: String(topic.summary ?? ''), summaryRevision: topic.contextRevision ?? topic.revision,
    openQuestionCount: 0, pendingRevisionCount: 0, pendingUnitCount: 0,
    createdAt: topic.createdAt, updatedAt: topic.updatedAt, engine: 'workflow-v2' }
}

const instant = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
const timing = (start, end) => {
  const duration = instant(end) - instant(start)
  return { quality: !Number.isFinite(duration) ? 'missing' : duration < 0 ? 'negative' : 'valid', durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null }
}

// 状态在拥有 Topic/来源账的后端判定，通知及业务 Task 完成不作语义完成门禁。
function messageProcessingProjection(message, topics, source, requests) {
  const currentUnit = ref => !Array.isArray(message.activeUnitRefs) || message.activeUnitRefs.some(item => item.unitId === ref.unitId && item.unitRevision === ref.unitRevision)
  const related = topics.flatMap(topic => {
    const latest = new Map()
    for (const entry of topic.entries ?? []) if (entry.messageId === message.messageId) latest.set(entry.unitId ?? 'legacy', entry)
    return [...latest.values()].filter(entry => entry.action === 'add' && entry.messageVersion === message.messageVersion && currentUnit(entry)).map(entry => ({ topic, entry }))
  })
  const records = related.map(({ topic, entry }) => [...(topic.decisions ?? [])]
    .filter(record => record.status === 'completed' && record.revision >= entry.revision)
    .sort((a, b) => a.revision - b.revision)[0])
  const topicPending = related.some(({ topic, entry }, i) => !(topic.processedRevision >= entry.revision) || !records[i])
  const reasons = [...new Set((message.ignoredRanges ?? []).map(range => range.reason).filter(reason => typeof reason === 'string' && reason.trim()))]
  const refsKey = refs => refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision])).sort()
  const sourceDone = !!source?.processingCompleted && (!Array.isArray(message.activeUnitRefs)
    || Array.isArray(source.processingCompleted.activeUnitRefs)
      && JSON.stringify(refsKey(message.activeUnitRefs)) === JSON.stringify(refsKey(source.processingCompleted.activeUnitRefs)))
  const ignored = !related.length && reasons.length > 0 && message.agentDeliveryStatus === 'delivered'
  const unitsPending = message.activeUnitRefs?.some(ref => {
    const unit = message.units?.find(item => item.unitId === ref.unitId && item.unitRevision === ref.unitRevision)
    return !unit || unit.dispatchOwner === 'coordination' && !sourceDone
  })
  const issues = [], recovery = []
  const issue = (phase, code, status, requestId, attempt, retryAt) => {
    if (!issues.some(item => item.phase === phase && item.requestId === requestId)) issues.push({ phase, code, status, requestId, attempt: attempt ?? 0, retryAt: retryAt ?? null })
  }
  // Only current, unfinished owners can fail a message; group delivery errors are not ownership evidence.
  for (const request of requests) {
    if (!['pending', 'exhausted'].includes(request.status) || !request.messages.some(item => item.messageId === message.messageId
      && item.messageVersion === message.messageVersion && (!request.topicId || currentUnit(item)))) continue
    if (request.topicId ? !related.some(({ topic, entry }, i) => topic.topicId === request.topicId && topic.revision === request.revision
      && (topic.processedRevision < entry.revision || !records[i])) : message.routingStatus === 'routed') continue
    const startup = request.failurePhase === 'startup'
    if (request.status === 'exhausted' && request.retryToken) recovery.push({ requestId: request.requestId, token: request.retryToken, phase: request.topicId ? 'decision' : 'routing' })
    if (request.status === 'exhausted' || request.nextRetryAt) issue(request.topicId ? 'decision' : 'routing',
      startup ? 'startup-recovery' : request.status === 'exhausted' ? request.failurePhase === 'dispatch' ? 'dispatch-failed' : 'protocol-exhausted' : 'protocol-retry',
      startup || request.status === 'pending' ? 'retrying' : 'failed', request.requestId, request.attempt, request.nextRetryAt)
  }
  for (const { topic, entry } of related) {
    if (topic.processedRevision >= entry.revision) continue
    const record = topic.decisions?.findLast(isPendingDecision)
    if (!record || record.revision < entry.revision || record.revision > topic.revision
      || record.decision?.basisUnitRefs?.length && !record.decision.basisUnitRefs.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision)) continue
    const hostRecovery = topicDecisionRecovery(record)
    if (hostRecovery && record.revision === topic.revision) recovery.push({ requestId: record.decisionId, token: hostRecovery.token, phase: 'host' })
    if (record.status === 'blocked' || record.status === 'failed') issue('host', record.status === 'blocked' ? 'decision-blocked' : 'decision-retry',
      record.status === 'blocked' ? 'failed' : 'retrying', record.decisionId, record.attempt, record.nextRetryAt)
  }
  if (!sourceDone) for (const item of source?.coordination ?? []) {
    if (!currentUnit(item) || !message.units?.some(unit => unit.unitId === item.unitId && unit.unitRevision === item.unitRevision && unit.dispatchOwner === 'coordination')
      || item.state !== 'reserved' || item.resolved || item.frozen || !(item.attempt > 0)) continue
    const exhausted = item.attempt >= 3 && !item.nextRetryAt
    if (exhausted && item.retryToken) recovery.push({ requestId: item.reservationId, token: item.retryToken, phase: 'coordination' })
    issue('coordination', exhausted ? 'coordination-exhausted' : 'coordination-retry', exhausted ? 'failed' : 'retrying', item.reservationId, item.attempt, item.nextRetryAt)
  }
  if (message.routingStatus === 'failed' && !issues.some(item => item.phase === 'routing')) issue('routing', 'routing-failed', 'failed', null, 0, null)
  let state = 'unknown', basis = 'unknown', completedAt = null, conclusion = null
  if (issues.some(item => item.status === 'failed')) state = 'failed'
  else if (message.routingStatus !== 'routed') state = 'routing'
  else if (topicPending || unitsPending) state = 'processing'
  else if (sourceDone || related.length || ignored) {
    state = 'processed'
    basis = sourceDone ? 'source-semantic' : related.length ? 'topic-decision' : 'ignored-delivered'
    const times = [...records.map(record => record.updatedAt), ...(sourceDone ? [source.processingCompleted.at] : [])]
    completedAt = times.length ? times.every(time => Number.isFinite(instant(time))) ? new Date(Math.max(...times.map(instant))).toISOString() : null : message.agentDeliveryAt ?? null
    conclusion = [...new Set([...records.map(record => record?.decision?.reason ?? record?.decision?.reply), ...reasons].filter(text => typeof text === 'string' && text.trim()))].join('；') || null
  } else if (source && source.routed !== true || related.length || reasons.length) state = 'processing'
  const notices = source?.notifications ?? []
  const noticeTimes = notices.map(notice => notice.deliveredAt)
  const deliveredAt = notices.length && notices.every(notice => notice.versionMatched === true && notice.state === 'delivered') && noticeTimes.every(time => Number.isFinite(instant(time)))
    ? new Date(Math.max(...noticeTimes.map(instant))).toISOString() : null
  return { processingState: state, processingBasis: basis, processingConclusion: conclusion,
    processingSentAt: message.occurredAt ?? null, processingCompletedAt: completedAt,
    processingFacts: {
      sourceId: source?.sourceId ?? null, messageVersion: message.messageVersion ?? null,
      sourceState: !source ? 'unknown' : source.routed === true ? 'settled' : 'unsettled', sourceSettledAt: source?.routedAt ?? null,
      receivedAt: source?.receivedAt ?? message.receivedAt ?? null,
      notificationState: !notices.length ? 'unknown' : deliveredAt ? 'delivered' : 'unconfirmed', notifications: notices,
      semantic: timing(message.occurredAt, completedAt),
      notificationE2e: timing(source?.receivedAt ?? message.receivedAt, deliveredAt),
      stages: source?.stages ?? [], issues, recovery,
    } }
}

async function groupSummary(group, runtime, workflowMailboxes, workflowTopics = []) {
  if (!group) return null
  const { topics: _topics, routeHistory: _routeHistory, taskReservations: _taskReservations, ...summary } = group
  const coordinator = workflowMailboxes?.coordinators?.[group.groupId]
  if (coordinator) summary.coordinator = coordinator
  const topics = runtime.listTopics(group.groupId).filter(topic => !topic.mergedInto)
  const sources = await runtime.messageProcessingSources?.(group.groupId) ?? []
  const requests = await runtime.messageProcessingRequests?.(group.groupId) ?? []
  const sourceFor = message => {
    const matches = sources.filter(source => source.groupId === group.groupId && source.messageId === message.messageId && source.version === message.messageVersion)
    return matches.length === 1 ? matches[0] : undefined
  }
  summary.messages = (summary.messages ?? []).map((message) => ({
    ...message,
    ...messageProcessingProjection(message, topics, sourceFor(message), requests.filter(request => request.groupId === group.groupId)),
    topicRefs: topics.flatMap((topic) => {
      const state = new Map()
      for (const entry of topic.entries?.filter((item) => item.messageId === message.messageId) ?? []) state.set(entry.unitId ?? `legacy:${entry.messageId}`, entry)
      return [...state.values()].filter((entry) => entry.action === 'add' && entry.messageVersion === message.messageVersion).map((entry) => ({ topicId: topic.topicId, revision: topic.revision, title: topic.title, unitId: entry.unitId, unitRevision: entry.unitRevision }))
    }),
  }))
  const workflowMessages = (workflowMailboxes?.messages ?? []).filter((message) => message.groupId === group.groupId)
  const byMessageId = new Map(summary.messages.map(message => [message.messageId, message]))
  for (const message of workflowMessages) {
    // 补读的旧资料不能挡住原生控制账的会话入口和状态；缺省显示资料仍保留。
    const defined = Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined))
    const merged = { ...byMessageId.get(message.messageId), ...defined, sourceKind: 'workflow-v2' }
    byMessageId.set(message.messageId, { ...merged, ...messageProcessingProjection(merged, topics, sourceFor(merged), requests.filter(request => request.groupId === group.groupId)) })
  }
  summary.messages = [...byMessageId.values()]
  const existingOutboundIds = new Set((summary.outbox ?? []).map((message) => message.outboundId))
  summary.outbox = [...(summary.outbox ?? []), ...(workflowMailboxes?.outbox ?? []).filter((message) => message.groupId === group.groupId && !existingOutboundIds.has(message.outboundId))]
  const pendingUnits = new Set(topics.flatMap((topic) => topic.entries.filter((entry) => entry.revision > topic.processedRevision).map((entry) => entry.unitId ?? `legacy:${entry.messageId}`)))
  summary.topicProgress = {
    total: topics.length + workflowTopics.filter(topic=>topic.conversationId===group.groupId).length,
    pending: topics.filter((topic) => topic.revision > topic.processedRevision).length,
    pendingRevisions: topics.reduce((count, topic) => count + Math.max(0, topic.revision - topic.processedRevision), 0),
    pendingUnits: pendingUnits.size,
    unroutedMessages: (group.messages ?? []).filter((message) => message.routingStatus === 'pending' || message.routingStatus === 'failed').length + workflowMessages.filter(message=>!message.topicRefs?.length && ['pending','failed'].includes(message.routingStatus)).length,
  }
  return summary
}

const requiredText = z.string().trim().min(1)
const topicRefsSchema = z.array(z.strictObject({ topicId: requiredText, revision: z.number().int().positive() })).min(1)
const createTaskInputSchema = z.strictObject({
  requestId: requiredText.max(200), groupId: requiredText, title: requiredText.max(120), objective: requiredText.max(16000),
  context: z.string().max(32000).optional(), acceptanceCriteria: z.array(requiredText.max(2000)).max(100).optional(), topicRefs: topicRefsSchema.optional(),
})
const contextTaskInputSchema = z.strictObject({ requestId: requiredText.max(200), context: requiredText.max(32000),
  progressImpact: taskContextProgressImpactSchema, authorizationChange: z.enum(['none', 'changed']).optional(),
  expectedRequirementRevision: z.number().int().positive(), expectedControlRevision: z.number().int().positive() })
  .superRefine((value, ctx) => { const message = taskContextSemanticsProblem(value); if (message) ctx.addIssue({ code: 'custom', path: ['progressImpact'], message }) })
const cancelTaskInputSchema = z.strictObject({ requestId: requiredText.max(200), reason: requiredText.max(2000), expectedControlRevision: z.number().int().positive() })
const reopenTaskInputSchema = z.strictObject({ requestId: requiredText.max(200), context: requiredText.max(32000),
  expectedRequirementRevision: z.number().int().positive(), expectedControlRevision: z.number().int().positive() })

export function residentErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/^(?:MESSAGE_RETRY_|TASK_NOTIFICATION_RECOVERY_|DYNAMIC_NOTIFICATION_RECOVERY_)/.test(message)) return 409
  if (/^(?:DYNAMIC|TASK_SESSION)_.+(?:FORBIDDEN|AUTHENTICATED_SOURCE_REQUIRED|WEB_ACTOR_REQUIRED)$/.test(message)) return 403
  if (/^DYNAMIC_.*(?:STALE|CONFLICT|BUSY|TERMINAL|NOT_ACTIVE|NOT_QUIESCENT|UNRESOLVED|FENCED|RECONCILIATION_REQUIRED)$/.test(message)) return 409
  if (message === 'DYNAMIC_NOT_FOUND') return 404
  if (/TASK_(?:REQUIREMENT|CONTROL|REQUEST|SESSION).*?(?:CONFLICT|STALE|BUSY)|TASK_SESSION_TERMINAL/.test(message)) return 409
  if (/TASK_(?:(?:SESSION|NOTIFICATION)_)?NOT_FOUND/.test(message)) return 404
  if (/LEGACY_TASK_READONLY|WORKFLOW_RETIRED/.test(message)) return 410
  return /^(group_has_(active_tasks|referenced_topics|pending_decisions|pending_outbox)|task-stale|task_input_version_(conflict|stale)|task_request_identity_conflict|task_input_pending|task_topic_version_invalid|task_result_context_changed|task_prompts_version_conflict|task_web_(task-stale|topic-stale|routing-required)|web_task_version_conflict)(:|$)/u.test(message) ? 409 : 400
}

async function submitWebTask(request, response, runtime, kind, taskId) {
  try {
    if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
    if (taskId && ((await runtime.getTaskSessionDetail?.(taskId))?.legacyReadonly || !runtime.getTaskSessionDetail && await runtime.isWorkflowTask?.(taskId))) return send(response, 410, { error: 'LEGACY_TASK_READONLY' })
    const body = await readJson(request)
    const parsed = (kind === 'createTask' ? createTaskInputSchema : kind === 'cancelTask' ? cancelTaskInputSchema : kind === 'reopenTask' ? reopenTaskInputSchema : contextTaskInputSchema).safeParse(body)
    if (!parsed.success) return send(response, 400, { error: 'web_task_request_invalid', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
    const value = await runtime[kind]({ ...parsed.data, ...(taskId ? { taskId } : {}) })
    return send(response, value?.status === 'task-stale' ? 409 : value?.status === 'accepted' ? 202 : 200, value)
  } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
}

export async function handleRequest(request, response, store, { testApiEnabled = false, transport = 'fake-dws', outboundAuthorized = false, modelMode = 'fake', checkForUpdatesImpl = checkForUpdates } = {}) {
  applyResidentCorsHeaders(request, response)
  const url = new URL(request.url ?? '/', 'http://localhost')
  // 浏览器预检不执行业务操作，须先于旧写入口清退规则响应。
  if (request.method === 'OPTIONS') return send(response, 204, null)
  // Only current task sessions may use this endpoint. Legacy archive stays retired.
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/archive$/u.test(url.pathname) && store.isTaskSessionMode?.()) {
    try {
      if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
      const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/archive'.length))
      const task = await store.getTaskSessionDetail(taskId)
      if (task?.legacyReadonly || !task && (await store.getTask?.(taskId) || await store.isWorkflowTask?.(taskId))) return send(response, 410, { error: 'LEGACY_TASK_READONLY' })
      if (!z.strictObject({}).safeParse(await readJson(request)).success) return send(response, 400, { error: 'web_task_request_invalid' })
      return send(response, 200, await store.archiveTask({ taskId }))
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/reopen$/u.test(url.pathname) && store.isTaskSessionMode?.()) {
    return submitWebTask(request, response, store, 'reopenTask', decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/reopen'.length)))
  }
  // Retired configuration and fixed-run controls must never reach a runtime fallback.
  if (/^\/config\/workflow-(?:variables|bindings)(?:\/|$)/u.test(url.pathname)
    || ['/state/workflows', '/state/workflows/catalog', '/runtime/execution-purge', '/runtime/maintenance/task-run', '/runtime/topics/reconcile', '/runtime/topics/reconcile/check', '/runtime/maintenance/seal', '/runtime/maintenance/resume'].includes(url.pathname)
    || request.method !== 'GET' && url.pathname === '/runtime/maintenance'
    || /^\/config\/groups\/[^/]+\/(?:topics\/[^/]+\/decisions\/[^/]+\/operations\/[^/]+|coordination\/[^/]+)\/retry$/u.test(url.pathname)
    || testApiEnabled && /^\/test\/tasks(?:\/(?:wait|resume|followup|result))?$/u.test(url.pathname)
    || /^\/runtime\/maintenance\/tasks\/[^/]+\/completed-observations$/u.test(url.pathname)
    || /^\/tasks\/[^/]+\/(?:reset-execution|prepare-purged-run|rerun|execution-control|review-delivery|confirm-completion|confirm-stage|retry-investigation|handoff-data-change-approval|maintenance-constraint|reassess-readonly|repair-stage-authorizations|retire-prepared-effect|retry-owner|reissue-repository|reopen|pause|resume|archive|title)$/u.test(url.pathname)
    || /^\/workflows(?:\/|$)/u.test(url.pathname)
    || /^\/authorizations\/[^/]+\/(?:decision|reissue)$/u.test(url.pathname)
    || request.method !== 'GET' && /^\/tasks\/[^/]+\/(?:reports\/[^/]+\/retry|notifications\/[^/]+\/(?:retry|send-completion)|information-wait-notice)$/u.test(url.pathname)
    || request.method === 'DELETE' && /^\/tasks\/[^/]+$/u.test(url.pathname)) {
    response.setHeader('cache-control', 'no-store')
    return send(response, 410, { error: 'WORKFLOW_RETIRED', message: '旧工作流与参数管理已清退；历史记录仅供读取。' })
  }
  if (request.method === 'GET' && url.pathname === '/runtime/maintenance') {
    if (!localConfigurationRequest(request)) return send(response, 403, { error: 'workflow_local_identity_required' })
    if (!store.getWorkflowMaintenance) return send(response, 404, { error: 'workflow_maintenance_unavailable' })
    return send(response, 200, { ...await store.getWorkflowMaintenance(), legacyReadonly: true })
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    const recoveryIssues = store.listRecoveryIssues()
    const inboundConfigured = transport === 'dws'
    const dwsBridge = inboundConfigured ? store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] } : undefined
    const inboundProcessing = inboundConfigured && dwsBridge.healthy === true
    const activityAudit = store.getActivityAuditStatus?.()
    const executionStore = store.getWorkflowExecutionHealth?.()
    return send(response, 200, {
      status: recoveryIssues.length === 0 && (!executionStore || executionStore.healthy) && (!inboundConfigured || inboundProcessing) ? 'ok' : 'degraded', transport,
      inboundConfigured, inboundProcessing, outboundAuthorized, modelMode,
      recoveryIssueCount: recoveryIssues.length,
      ...(executionStore ? { executionStore } : {}),
      ...(activityAudit ? { activityAudit: { total: activityAudit.total, pending: activityAudit.pending, audited: activityAudit.audited, unavailableCount: activityAudit.unavailable.length } } : {}),
      ...(dwsBridge !== undefined ? { dwsBridge } : {}),
    })
  }
  if (request.method === 'GET' && url.pathname === '/state/recovery-issues') return send(response, 200, store.listRecoveryIssues())
  if (request.method === 'GET' && url.pathname === '/state/activity-audit') return send(response, 200, store.getActivityAuditStatus?.() ?? { total: 0, pending: 0, audited: 0, unavailable: [] })
  if (request.method === 'GET' && url.pathname === '/state/groups') {
    try {
      const groupId = url.searchParams.get('groupId')
      const workflowMailboxes = await store.getWorkflowMailboxes?.()
      const workflowTopics = await store.listWorkflowTopics?.(groupId ?? undefined) ?? []
      return send(response, 200, groupId ? await groupSummary(store.getGroup(groupId), store, workflowMailboxes, workflowTopics)
        : await Promise.all(store.listGroups().map(group => groupSummary(group, store, workflowMailboxes, workflowTopics))))
    } catch { return send(response, 503, { error: 'message_processing_unavailable' }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/topics') {
    try {
      const offset = pageNumber(url, 'offset', 0), limit = pageNumber(url, 'limit', 50, 100)
      const groupId=url.searchParams.get('groupId')??undefined
      const topics = [...store.listTopics(groupId).filter(topic => !topic.mergedInto || url.searchParams.get('includeMerged') === 'true').map(topicSummary), ...((await store.listWorkflowTopics?.(groupId))??[]).map(workflowTopicSummary)]
      topics.sort((a,b)=>String(b.updatedAt??b.createdAt).localeCompare(String(a.updatedAt??a.createdAt)))
      return send(response, 200, { topics: topics.slice(offset, offset + limit), total: topics.length, offset, limit })
    } catch (error) { return send(response, 400, { error: error.message }) }
  }
  if (request.method === 'GET' && /^\/state\/topics\/[^/]+$/u.test(url.pathname)) {
    try {
      const groupId = url.searchParams.get('groupId')
      if (!groupId) return send(response, 400, { error: 'group_id_required' })
      const topicId = decodeURIComponent(url.pathname.slice('/state/topics/'.length))
      const revision = pageNumber(url, 'revision', undefined), offset = pageNumber(url, 'offset', 0), limit = pageNumber(url, 'limit', 50, 100)
      if (!store.getTopic?.(groupId, topicId)) {
        const workflowContext=await store.getWorkflowTopicContext?.({groupId,topicId,offset,limit})
        if(!workflowContext)return send(response,404,{error:'topic_not_found'})
        return send(response,200,{...workflowContext,topic:{...workflowTopicSummary(workflowContext.topic),openQuestions:[]}})
      }
      const context = await store.getTopicContext({ groupId, topicId, ...(revision === undefined ? {} : { revision }), offset, limit })
      return send(response, 200, { ...context, topic: { ...topicSummary(context.topic), summary: context.topic.summary, openQuestions: context.topic.openQuestions } })
    } catch (error) { return send(response, 400, { error: error.message }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/coordination-sources') {
    if (!store.coordinationSources) return send(response, 503, { error: 'coordination_observer_unavailable' })
    let options
    try {
      if ([...url.searchParams.keys()].some(key => !['groupId', 'offset', 'limit'].includes(key))
        || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1))
        return send(response, 400, { error: 'coordination_query_invalid' })
      const groupId = url.searchParams.get('groupId') ?? undefined
      if (groupId !== undefined && !groupId.trim()) return send(response, 400, { error: 'coordination_query_invalid' })
      options = { groupId, offset: pageNumber(url, 'offset', 0), limit: pageNumber(url, 'limit', 20, 100) }
    } catch { return send(response, 400, { error: 'coordination_query_invalid' }) }
    try { return send(response, 200, await store.coordinationSources(options)) }
    catch { return send(response, 503, { error: 'coordination_observer_unavailable' }) }
  }
  const coordinationSource = request.method === 'GET' && /^\/state\/coordination-sources\/([^/]+)$/u.exec(url.pathname)
  if (coordinationSource) {
    if (!store.coordinationSourceDetail) return send(response, 503, { error: 'coordination_observer_unavailable' })
    try {
      if (url.searchParams.size) return send(response, 400, { error: 'coordination_query_invalid' })
      const value = await store.coordinationSourceDetail(decodeURIComponent(coordinationSource[1]))
      return send(response, value ? 200 : 404, value ?? { error: 'coordination_source_not_found' })
    } catch (error) { return send(response, error instanceof URIError ? 400 : 503, { error: error instanceof URIError ? 'coordination_query_invalid' : 'coordination_observer_unavailable' }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/coordination-work') {
    if (!store.coordinationWork) return send(response, 503, { error: 'coordination_observer_unavailable' })
    let options
    try {
      if ([...url.searchParams.keys()].some(key => !['groupId', 'offset', 'limit'].includes(key))
        || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1))
        return send(response, 400, { error: 'coordination_query_invalid' })
      const groupId = url.searchParams.get('groupId') ?? undefined
      if (groupId !== undefined && !groupId.trim()) return send(response, 400, { error: 'coordination_query_invalid' })
      options = { groupId, offset: pageNumber(url, 'offset', 0), limit: pageNumber(url, 'limit', 20, 100) }
    } catch { return send(response, 400, { error: 'coordination_query_invalid' }) }
    try { return send(response, 200, await store.coordinationWork(options)) }
    catch { return send(response, 503, { error: 'coordination_observer_unavailable' }) }
  }
  const coordinationWork = request.method === 'GET' && /^\/state\/coordination-work\/([^/]+)$/u.exec(url.pathname)
  if (coordinationWork) {
    if (!store.coordinationWorkDetail) return send(response, 503, { error: 'coordination_observer_unavailable' })
    try {
      if (url.searchParams.size) return send(response, 400, { error: 'coordination_query_invalid' })
      const value = await store.coordinationWorkDetail(decodeURIComponent(coordinationWork[1]))
      return send(response, value ? 200 : 404, value ?? { error: 'coordination_work_not_found' })
    } catch (error) { return send(response, error instanceof URIError || error.message === 'coordination_query_invalid' ? 400 : 503, { error: error instanceof URIError || error.message === 'coordination_query_invalid' ? 'coordination_query_invalid' : 'coordination_observer_unavailable' }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/tasks') return send(response, 200, await (store.listTaskView?.() ?? store.listTasks()))
  const topicState = request.method === 'GET' && /^\/state\/topics\/([^/]+)\/context$/u.exec(url.pathname)
  if (topicState) {
    try {
      const groupId = url.searchParams.get('groupId')
      if (!groupId) return send(response, 400, { error: 'group_id_required' })
      const topicId = decodeURIComponent(topicState[1]), topic = store.getTopic?.(groupId, topicId)
      if (!topic) return send(response, 404, { error: 'topic_not_found' })
      const revision = pageNumber(url, 'revision', topic.revision), offset = pageNumber(url, 'cursor', 0)
      const limit = pageNumber(url, 'limit', 50, 100), intentCursor = pageNumber(url, 'intentCursor', 0)
      if (revision !== topic.revision) return send(response, 409, { error: 'topic_context_stale' })
      const context = await store.getTopicContext({ groupId, topicId, revision, offset, limit })
      const decisions = context.topic.decisions ?? []
      const tasks = await (store.listTaskView?.() ?? store.listTasks())
      if (store.getTopic(groupId, topicId)?.revision !== revision) return send(response, 409, { error: 'topic_context_stale' })
      const taskRefs = tasks.filter(task => task.groupId === groupId && task.topicRefs?.some(ref => ref.topicId === topicId))
        .map(task => ({ taskId: task.taskId, title: task.title, state: task.state ?? task.status, inputVersion: task.inputVersion ?? task.requirementRevision }))
      return send(response, 200, { groupId, topicId, revision, current: { topicTitle: context.topic.title,
        summary: context.topic.summary, status: context.topic.status, openQuestions: context.topic.openQuestions,
        sourceCount: context.total, hasMoreFacts: offset + context.messages.length < context.total, tasks: taskRefs },
        facts: context.messages.map(message => ({ factId: message.messageId, kind: '来源消息', text: message.text,
          sourceRefs: [{ groupId, messageId: message.messageId, messageVersion: message.messageVersion }] })),
        intentRuns: decisions.slice(intentCursor, intentCursor + limit).map(item => ({ intentRunId: item.decisionId,
          createdAt: item.createdAt, status: item.status, sourceRunIds: item.decision?.basisMessageIds ?? [],
          reason: item.decision?.reason ?? item.error ?? null, decision: item.decision, operations: item.operations })),
        intentNextCursor: intentCursor + limit < decisions.length ? intentCursor + limit : null,
        nextCursor: offset + context.messages.length < context.total ? offset + context.messages.length : null, total: context.total })
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const workflowTrace = request.method === 'GET' && /^\/state\/workflows\/([^/]+)\/trace$/u.exec(url.pathname)
  if (workflowTrace) {
    if (!store.getWorkflowMessageTrace) return send(response, 404, { error: 'workflow_disabled' })
    try { const value = await store.getWorkflowMessageTrace(decodeURIComponent(workflowTrace[1]),
      { offset: pageNumber(url, 'cursor', 0), limit: pageNumber(url, 'limit', 50, 100) }); return send(response, value ? 200 : 404, value ?? { error: 'message_not_found' }) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const workflowEvidence = request.method === 'GET' && /^\/state\/workflows\/([^/]+)\/evidence\/([^/]+)$/u.exec(url.pathname)
  if (workflowEvidence) {
    if (!store.getWorkflowMessageEvidence) return send(response, 404, { error: 'workflow_disabled' })
    try { const value = await store.getWorkflowMessageEvidence(decodeURIComponent(workflowEvidence[1]), decodeURIComponent(workflowEvidence[2]),
      { offset: pageNumber(url, 'cursor', 0), limit: pageNumber(url, 'limit', 2000, 8000), hash: url.searchParams.get('hash') }); return send(response, value ? 200 : 404, value ?? { error: 'evidence_not_found' }) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const workflowTopicState = request.method === 'GET' && /^\/state\/workflows\/topics\/([^/]+)\/context$/u.exec(url.pathname)
  if (workflowTopicState) {
    if (!store.getWorkflowTopicState) return send(response, 404, { error: 'workflow_disabled' })
    try { const value = await store.getWorkflowTopicState(decodeURIComponent(workflowTopicState[1]),
      { offset: pageNumber(url, 'cursor', 0), limit: pageNumber(url, 'limit', 50, 100), intentCursor: pageNumber(url, 'intentCursor', 0), expectedRevision: url.searchParams.has('revision') ? pageNumber(url, 'revision', 0) : null }); return send(response, value ? 200 : 404, value ?? { error: 'topic_not_found' }) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const workflowNodeOutput = request.method === 'GET' && /^\/state\/tasks\/([^/]+)\/runs\/([^/]+)\/nodes\/([^/]+)\/(output|document)$/u.exec(url.pathname)
  if (workflowNodeOutput) {
    if (!store.getWorkflowTaskNodeOutput) return send(response, 404, { error: 'workflow_disabled' })
    try { const download = workflowNodeOutput[4] === 'document'
      const value = await store.getWorkflowTaskNodeOutput(...workflowNodeOutput.slice(1, 4).map(decodeURIComponent),
        { offset: pageNumber(url, 'cursor', 0), limit: pageNumber(url, 'limit', 1200, 8000), outputRef: url.searchParams.get('ref'),
          ...(url.searchParams.has('detailRevision') ? { detailRevision: url.searchParams.get('detailRevision') } : {}), ...(download ? { document: true } : {}) })
      if (download && value) {
        response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="node-output.md"; filename*=UTF-8''${encodeURIComponent(value.name)}`, 'Cache-Control': 'no-store' })
        return response.end(value.content)
      }
      return send(response, value ? 200 : 404, value ?? { error: 'output_not_found' }) }
    catch (error) { return send(response, error.code === 'TASK_OUTPUT_CHANGED' ? 409 : residentErrorStatus(error), { error: error.message }) }
  }
  const taskDecisions = request.method === 'GET' && /^\/state\/tasks\/([^/]+)\/decisions$/u.exec(url.pathname)
  if (taskDecisions) {
    if (!store.getTaskSessionDecisions) return send(response, 404, { error: 'task_session_disabled' })
    try {
      return send(response, 200, await store.getTaskSessionDecisions(decodeURIComponent(taskDecisions[1]), {
        ...(url.searchParams.has('before') ? { before: pageNumber(url, 'before', 0) } : {}), limit: pageNumber(url, 'limit', 20, 100),
      }))
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const taskHistory = request.method === 'GET' && /^\/state\/tasks\/([^/]+)\/(detail|executions)$/u.exec(url.pathname)
  if (taskHistory) {
    const detail = taskHistory[2] === 'detail'
    const method = detail ? 'getTaskSessionDetail' : 'getTaskSessionExecutions'
    const legacyMethod = detail ? 'getWorkflowTaskDetail' : 'getWorkflowTaskExecutions'
    try {
      const options = detail ? undefined : { offset: pageNumber(url, 'offset', 0), limit: pageNumber(url, 'limit', 20, 100) }
      const taskId = decodeURIComponent(taskHistory[1])
      const current = await store[method]?.(taskId, options)
      const legacy = current == null ? await store[legacyMethod]?.(taskId, options) : undefined
      const value = current ?? (legacy ? { ...legacy, legacyReadonly: true } : undefined)
      return send(response, value ? 200 : 404, value ?? { error: 'task_not_found' })
    } catch (error) { return send(response, error.code === 'TASK_DETAIL_STALE' ? 409 : residentErrorStatus(error), { error: error.message }) }
  }
  const workflowTaskRuns = request.method === 'GET' && /^\/state\/tasks\/([^/]+)\/runs$/u.exec(url.pathname)
  if (workflowTaskRuns) {
    if (!store.getWorkflowTaskRuns) return send(response, 404, { error: 'workflow_disabled' })
    try { const value = await store.getWorkflowTaskRuns(decodeURIComponent(workflowTaskRuns[1]),
      { offset: pageNumber(url, 'cursor', 0), limit: pageNumber(url, 'limit', 20, 100) }); return send(response, value ? 200 : 404, value ?? { error: 'task_not_found' }) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/task-timings') return send(response, 200, store.listTaskTimings())
  if (request.method === 'GET' && url.pathname === '/state/performance') return send(response, 200, store.listPerformance(Object.fromEntries(['day', 'sessionId', 'groupId', 'taskId', 'requestId', 'submissionId'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]))))
  if (request.method === 'GET' && url.pathname === '/state/authorizations') return send(response, 200, await store.listAuthorizationRequests())
  const reconcileTopics = request.method === 'POST' && /^\/runtime\/task-topics\/reconcile(\/check)?$/u.exec(url.pathname)
  if (reconcileTopics) {
    if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
    if (!store.reconcileWebTaskTopics) return send(response, 404, { error: 'task_session_disabled' })
    try {
      const parsed = z.strictObject({ groupId: requiredText, requestId: requiredText.optional(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).safeParse(await readJson(request))
      if (!parsed.success) return send(response, 400, { error: 'task_topic_reconcile_invalid' })
      return send(response, 200, await store.reconcileWebTaskTopics({ ...parsed.data, checkOnly: !!reconcileTopics[1] }))
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const dialogue = /^(?:\/state)?\/tasks\/([^/]+)\/dialogue$/u.exec(url.pathname)
  if (dialogue && ((request.method === 'GET' && url.pathname.startsWith('/state/')) || (request.method === 'POST' && !url.pathname.startsWith('/state/')))) {
    if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
    if (!store.getTaskDialogue || !store.sendTaskDialogue) return send(response, 404, { error: 'task_session_disabled' })
    const taskId = decodeURIComponent(dialogue[1])
    try {
      if (request.method === 'GET') return send(response, 200, await store.getTaskDialogue(taskId))
      const parsed = z.strictObject({ requestId: requiredText.max(200), text: requiredText.max(10000) }).safeParse(await readJson(request))
      if (!parsed.success) return send(response, 400, { error: 'task_dialogue_invalid' })
      return send(response, 202, await store.sendTaskDialogue({ ...parsed.data, taskId }))
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  const humanReply = request.method === 'POST' && /^\/tasks\/([^/]+)\/human-requests\/([^/]+)\/reply(\/check)?$/u.exec(url.pathname)
  if (humanReply) {
    if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
    if (!store.respondTaskHumanRequest) return send(response, 404, { error: 'task_session_disabled' })
    try {
      const parsed = z.strictObject({ requestId: requiredText.max(200), reply: requiredText.max(20000),
        expectedRequirementRevision: z.number().int().positive(), expectedControlRevision: z.number().int().positive(),
        artifactScopeCorrection: z.strictObject({ coordinationId: requiredText, expectedRevision: z.number().int().positive(), reason: requiredText.max(2000) }).optional(),
        nativeFailureResolutions: z.array(z.strictObject({ operationId: requiredText, expectedOperationDigest: z.string().regex(/^[a-f0-9]{64}$/u) })).min(1).max(8)
          .refine(items => new Set(items.map(item => item.operationId)).size === items.length).optional() }).safeParse(await readJson(request))
      if (!parsed.success) return send(response, 400, { error: 'human_reply_invalid' })
      return send(response, 200, await store.respondTaskHumanRequest({ ...parsed.data,
        taskId: decodeURIComponent(humanReply[1]), humanRequestId: decodeURIComponent(humanReply[2]), ...(humanReply[3] ? { checkOnly: true } : {}) }))
    } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/activities') return send(response, 200, store.listActivities(url.searchParams.get('taskId') ?? undefined))
  if (request.method === 'GET' && url.pathname === '/state/supervisor/alerts') return send(response, 200, store.listAlerts())
  if (request.method === 'GET' && url.pathname === '/state/dws-bridge') return send(response, 200, store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] })
  if (request.method === 'GET' && url.pathname === '/state/environment') return send(response, 200, await store.inspectEnvironment())
  if (request.method === 'GET' && url.pathname === '/state/task-model-options') return send(response, 200, await store.getTaskModelOptions({ provider: url.searchParams.get('provider'), model: url.searchParams.get('model') }))
  if (request.method === 'GET' && url.pathname === '/state/agent-config') {
    const { taskPrompts, taskPromptsVersion, taskGuidance, leafSessionPrompt, ...configuration } = store.getAgentConfig()
    return send(response, 200, configuration)
  }
  if (request.method === 'GET' && url.pathname === '/state/version') return send(response, 200, await checkForUpdatesImpl({ force: url.searchParams.get('refresh') === 'true' }))
  if (request.method === 'POST' && url.pathname === '/tasks') return submitWebTask(request, response, store, 'createTask')
  const reportRoute = /^\/tasks\/([^/]+)\/reports\/([^/]+)(\/retry)?$/u.exec(url.pathname)
  if (reportRoute && request.method === 'GET' && !reportRoute[3]) {
    try {
      // 此操作无 body 参数；身份仅由路径确定，禁止 body 覆盖 task/submission。
      const identity = { taskId: decodeURIComponent(reportRoute[1]), submissionId: decodeURIComponent(reportRoute[2]) }
      const value = await store.getTaskReport(identity)
      return value === undefined ? send(response, 404, { error: 'task_report_not_found' }) : send(response, 200, value)
    } catch (error) {
      const status = /^task_report_not_found(:|$)/u.test(error.message) ? 404 : /^task_report_retry_(stale|requires_failed)(:|$)/u.test(error.message) ? 409 : residentErrorStatus(error)
      return send(response, status, { error: error.message })
    }
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/context$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/context'.length))
    return submitWebTask(request, response, store, 'appendTaskContext', taskId)
  }
  if (request.method === 'PUT' && url.pathname === '/config/agent') {
    const body = await readJson(request)
    if (['taskPrompts', 'taskPromptsVersion', 'taskGuidance', 'leafSessionPrompt', 'workflowVariables', 'workflowBindings'].some(field => Object.hasOwn(body, field))) return send(response, 410, { error: 'WORKFLOW_RETIRED' })
    try { return send(response, 200, await store.updateAgentConfig(body)) }
    catch (error) { return send(response, error.message === 'AGENT_CONFIG_SAVE_FAILED' ? 500 : residentErrorStatus(error), { error: error.message, ...(error.readback ? { readback: error.readback } : {}) }) }
  }
  if (request.method === 'GET' && url.pathname === '/config/groups/search') return send(response, 200, await store.searchGroups(url.searchParams.get('q') ?? ''))
  if (request.method === 'POST' && url.pathname === '/config/groups') return send(response, 200, await store.subscribe(await readJson(request)))
  if (request.method === 'POST' && url.pathname.startsWith('/config/groups/') && url.pathname.endsWith('/backfill')) {
    const groupId = decodeURIComponent(url.pathname.slice('/config/groups/'.length, -'/backfill'.length))
    return send(response, 200, await store.backfillGroup({ groupId, ...(await readJson(request)) }))
  }
  if (request.method === 'POST' && url.pathname.startsWith('/config/groups/') && url.pathname.endsWith('/messages/agent-delivery')) {
    const groupId = decodeURIComponent(url.pathname.slice('/config/groups/'.length, -'/messages/agent-delivery'.length))
    return send(response, 200, await store.markMessagesAgentDelivery({ groupId, ...(await readJson(request)) }))
  }
  const messageRetry = request.method === 'POST' ? /^\/config\/groups\/([^/]+)\/messages\/([^/]+)\/retry$/u.exec(url.pathname) : null
  const notificationRetry = request.method === 'POST' ? /^\/config\/groups\/([^/]+)\/notifications\/([^/]+)\/retry$/u.exec(url.pathname) : null
  if (messageRetry || notificationRetry) {
    try {
      if (!localConfigurationRequest(request)) return send(response, 403, { error: 'TASK_LOCAL_IDENTITY_REQUIRED' })
      const token = z.string().regex(/^[a-f0-9]{64}$/u)
      const schema = messageRetry ? z.strictObject({ messageVersion: z.number().int().positive(),
        activeUnitRefs: z.array(z.strictObject({ unitId: requiredText, unitRevision: z.number().int().positive() }))
          .refine(refs => new Set(refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision]))).size === refs.length),
        phase: z.enum(['routing', 'decision', 'coordination', 'host']), requestId: requiredText, token })
        : z.strictObject({ expectedToken: token })
      const parsed = schema.safeParse(await readJson(request))
      if (!parsed.success) return send(response, 400, { error: 'MESSAGE_RECOVERY_REQUEST_INVALID' })
      const match = messageRetry ?? notificationRetry
      const identity = { groupId: decodeURIComponent(match[1]), [messageRetry ? 'messageId' : 'notificationId']: decodeURIComponent(match[2]) }
      const value = await store[messageRetry ? 'retryDecisionFailedMessage' : 'retryNotification']({ ...parsed.data, ...identity })
      return send(response, 200, value)
    } catch (error) {
      if (error instanceof SyntaxError) return send(response, 400, { error: 'MESSAGE_RECOVERY_REQUEST_INVALID' })
      // 外部鉴权/网络异常不向浏览器透传正文；原账保留诊断，页面提示先解除阻塞。
      const code = error.code ?? error.message
      const safe = /^(?:MESSAGE_RETRY_|TASK_NOTIFICATION_RECOVERY_|DYNAMIC_NOTIFICATION_RECOVERY_|TASK_(?:SESSION|NOTIFICATION)_NOT_FOUND|DYNAMIC_COORDINATION_(?:SOURCE_STALE|FROZEN))/.test(code)
      return send(response, safe ? residentErrorStatus(error) : 409, { error: safe ? code : 'MESSAGE_RECOVERY_BLOCKED' })
    }
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/cancel$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/cancel'.length))
    return submitWebTask(request, response, store, 'cancelTask', taskId)
  }
  if (request.method === 'POST' && url.pathname.startsWith('/config/groups/') && url.pathname.endsWith('/history/hydrate')) {
    const groupId = decodeURIComponent(url.pathname.slice('/config/groups/'.length, -'/history/hydrate'.length))
    return send(response, 200, await store.hydrateGroupHistory({ groupId }))
  }
  if (request.method === 'PUT' && url.pathname.startsWith('/config/groups/')) return send(response, 200, await store.updateGroup({ groupId: decodeURIComponent(url.pathname.slice('/config/groups/'.length)), ...(await readJson(request)) }))
  if (request.method === 'DELETE' && url.pathname.startsWith('/config/groups/')) {
    try { return send(response, 200, await store.unsubscribe({ groupId: decodeURIComponent(url.pathname.slice('/config/groups/'.length)) })) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
  }
  if (!testApiEnabled || !url.pathname.startsWith('/test/')) return send(response, 404, { error: 'not_found' })
  if (request.method === 'POST' && url.pathname === '/test/subscriptions') return send(response, 200, await store.subscribe(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/inbound') return send(response, 200, await store.ingest(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/outbox/ack') return send(response, 200, await store.acknowledge(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/supervisor/probe') return send(response, 200, await store.reportCarrierIssue(await readJson(request)))
  return send(response, 404, { error: 'not_found' })
}
