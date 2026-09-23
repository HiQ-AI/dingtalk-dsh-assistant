import { checkForUpdates } from './version-check.js'
import { z } from 'zod'
import { taskContextImpactFields } from './decision.js'
import { isPendingDecision } from './topic-model.js'
import { taskBoardProgress } from './task-progress.js'

const WEB_ORIGINS = new Set(['http://127.0.0.1:3080', 'http://localhost:3080'])

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
    summary: String(topic.summary ?? '').slice(0, 1000),
    summaryRevision: topic.summaryRevision,
    openQuestionCount: topic.openQuestions?.length ?? 0,
    pendingRevisionCount: Math.max(0, topic.revision - topic.processedRevision),
    pendingUnitCount: pendingUnits.size,
    ...(unfinished ? { processing: { decisionId: unfinished.decisionId, status: unfinished.status, appliedOperations: (unfinished.operations ?? []).filter((item) => item.status === 'applied').length, totalOperations: unfinished.operations?.length ?? 0, ...(unfinished.error ? { error: String(unfinished.error).slice(0, 1000) } : {}) } } : {}),
    createdAt: topic.createdAt, updatedAt: topic.updatedAt,
  }
}

function groupSummary(group, runtime) {
  if (!group) return null
  const { topics: _topics, routeHistory: _routeHistory, taskReservations: _taskReservations, ...summary } = group
  const topics = runtime.listTopics(group.groupId)
  summary.messages = (summary.messages ?? []).map((message) => ({
    ...message,
    topicRefs: topics.flatMap((topic) => {
      const state = new Map()
      for (const entry of topic.entries?.filter((item) => item.messageId === message.messageId) ?? []) state.set(entry.unitId ?? `legacy:${entry.messageId}`, entry)
      return [...state.values()].filter((entry) => entry.action === 'add').map((entry) => ({ topicId: topic.topicId, revision: topic.revision, title: topic.title, unitId: entry.unitId, unitRevision: entry.unitRevision }))
    }),
  }))
  const pendingUnits = new Set(topics.flatMap((topic) => topic.entries.filter((entry) => entry.revision > topic.processedRevision).map((entry) => entry.unitId ?? `legacy:${entry.messageId}`)))
  summary.topicProgress = {
    total: topics.length,
    pending: topics.filter((topic) => topic.revision > topic.processedRevision).length,
    pendingRevisions: topics.reduce((count, topic) => count + Math.max(0, topic.revision - topic.processedRevision), 0),
    pendingUnits: pendingUnits.size,
    unroutedMessages: (group.messages ?? []).filter((message) => message.routingStatus === 'pending' || message.routingStatus === 'failed').length,
  }
  return summary
}

const requiredText = z.string().trim().min(1)
const topicRefsSchema = z.array(z.strictObject({ topicId: requiredText, revision: z.number().int().positive() })).min(1)
const taskInputFields = {
  requestId: requiredText, context: requiredText, topicRefs: topicRefsSchema,
  title: requiredText.max(120).optional(), objective: requiredText.optional(), acceptanceCriteria: z.array(requiredText).min(1).optional(), stageTasks: z.array(requiredText).min(1).optional(),
}
const createTaskInputSchema = z.strictObject({ ...taskInputFields, groupId: requiredText, title: requiredText, objective: requiredText, acceptanceCriteria: z.array(requiredText).min(1), topicRefs: topicRefsSchema.optional() })
const updateTaskInputSchema = z.strictObject({ ...taskInputFields, inputVersion: z.number().int().positive(), runSequence: z.number().int().positive() })
const contextTaskInputSchema = updateTaskInputSchema.extend(taskContextImpactFields)
const cancelTaskInputSchema = z.strictObject({ requestId: requiredText, reason: requiredText, inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), topicRefs: topicRefsSchema })

export function residentErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /^(group_has_(active_tasks|referenced_topics|pending_decisions|pending_outbox)|task-stale|task_input_version_(conflict|stale)|task_request_identity_conflict|task_input_pending|task_topic_version_invalid|task_result_context_changed|task_prompts_version_conflict|task_web_(task-stale|topic-stale|routing-required)|web_task_version_conflict)(:|$)/u.test(message) ? 409 : 400
}

async function submitWebTask(request, response, runtime, kind, taskId) {
  try {
    const body = await readJson(request)
    const parsed = (kind === 'createTask' ? createTaskInputSchema : kind === 'cancelTask' ? cancelTaskInputSchema : kind === 'appendTaskContext' ? contextTaskInputSchema : updateTaskInputSchema).safeParse(body)
    if (!parsed.success) return send(response, 400, { error: 'web_task_request_invalid', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
    const value = await runtime[kind]({ ...parsed.data, ...(taskId ? { taskId } : {}) })
    return send(response, value?.status === 'task-stale' ? 409 : value?.status === 'accepted' ? 202 : 200, value)
  } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
}

export async function handleRequest(request, response, store, { testApiEnabled = false, transport = 'fake-dws', outboundAuthorized = false, modelMode = 'fake', checkForUpdatesImpl = checkForUpdates } = {}) {
  applyResidentCorsHeaders(request, response)
  const url = new URL(request.url ?? '/', 'http://localhost')
  const workflowTaskAction = /^\/tasks\/([^/]+)\/(context|cancel|reopen|archive|title)$/u.exec(url.pathname)
  if (workflowTaskAction && ['POST', 'PUT'].includes(request.method) && await store.isWorkflowTask?.(decodeURIComponent(workflowTaskAction[1]))) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress) || (request.headers.origin && !WEB_ORIGINS.has(request.headers.origin))) return send(response, 403, { error: 'workflow_local_identity_required' })
    const action = workflowTaskAction[2]
    if (request.method !== 'POST' || !['cancel', 'context'].includes(action)) return send(response, 409, { error: 'WORKFLOW_WEB_ACTION_UNSUPPORTED' })
    try {
      const fields = { requestId: requiredText, inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), topicRefs: z.array(z.strictObject({ topicId: requiredText, revision: z.number().int().positive() })).optional() }
      const body = z.strictObject({ ...fields, ...(action === 'cancel' ? { reason: requiredText.max(16000) } : { context: requiredText.max(16000) }) }).parse(await readJson(request))
      const result = await store.submitWorkflowTask({ ...body, action, taskId: decodeURIComponent(workflowTaskAction[1]) })
      return send(response, 202, result)
    } catch(error) { return send(response, /FORBIDDEN|ACTOR/u.test(error.message) ? 403 : /CONFLICT|PENDING|TERMINAL/u.test(error.message) ? 409 : 400, { error: error.message }) }
  }
  const workflowReply = /^\/workflows\/([^/]+)\/requests\/([^/]+)\/answer$/u.exec(url.pathname)
  if (request.method === 'POST' && workflowReply) {
    const address = request.socket?.remoteAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || (request.headers.origin && !WEB_ORIGINS.has(request.headers.origin))) return send(response, 403, { error: 'workflow_local_identity_required' })
    if (!store.resumeWorkflowRequest) return send(response, 404, { error: 'workflow_disabled' })
    try {
      const body = z.strictObject({ eventId: requiredText, answer: requiredText.max(16000) }).parse(await readJson(request))
      return send(response, 200, await store.resumeWorkflowRequest({ ...body, runId: decodeURIComponent(workflowReply[1]), requestId: decodeURIComponent(workflowReply[2]) }))
    } catch (error) { return send(response, /FORBIDDEN|ACTOR/u.test(error.message) ? 403 : 400, { error: error.message }) }
  }
  if (request.method === 'OPTIONS') return send(response, 204, null)
  if (request.method === 'GET' && url.pathname === '/health') {
    const recoveryIssues = store.listRecoveryIssues()
    const inboundConfigured = transport === 'dws'
    const dwsBridge = inboundConfigured ? store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] } : undefined
    const inboundProcessing = inboundConfigured && dwsBridge.healthy === true
    const activityAudit = store.getActivityAuditStatus?.()
    return send(response, 200, {
      status: recoveryIssues.length === 0 && (!inboundConfigured || inboundProcessing) ? 'ok' : 'degraded', transport,
      inboundConfigured, inboundProcessing, outboundAuthorized, modelMode,
      recoveryIssueCount: recoveryIssues.length,
      ...(activityAudit ? { activityAudit: { total: activityAudit.total, pending: activityAudit.pending, audited: activityAudit.audited, unavailableCount: activityAudit.unavailable.length } } : {}),
      ...(dwsBridge !== undefined ? { dwsBridge } : {}),
    })
  }
  if (request.method === 'GET' && url.pathname === '/state/recovery-issues') return send(response, 200, store.listRecoveryIssues())
  if (request.method === 'GET' && url.pathname === '/state/activity-audit') return send(response, 200, store.getActivityAuditStatus?.() ?? { total: 0, pending: 0, audited: 0, unavailable: [] })
  if (request.method === 'GET' && url.pathname === '/state/groups') {
    const groupId = url.searchParams.get('groupId')
    return send(response, 200, groupId ? groupSummary(store.getGroup(groupId), store) : store.listGroups().map((group) => groupSummary(group, store)))
  }
  if (request.method === 'GET' && url.pathname === '/state/topics') {
    try {
      const offset = pageNumber(url, 'offset', 0), limit = pageNumber(url, 'limit', 50, 100)
      const topics = store.listTopics(url.searchParams.get('groupId') ?? undefined)
      return send(response, 200, { topics: topics.slice(offset, offset + limit).map(topicSummary), total: topics.length, offset, limit })
    } catch (error) { return send(response, 400, { error: error.message }) }
  }
  if (request.method === 'GET' && /^\/state\/topics\/[^/]+$/u.test(url.pathname)) {
    try {
      const groupId = url.searchParams.get('groupId')
      if (!groupId) return send(response, 400, { error: 'group_id_required' })
      const topicId = decodeURIComponent(url.pathname.slice('/state/topics/'.length))
      const revision = pageNumber(url, 'revision', undefined), offset = pageNumber(url, 'offset', 0), limit = pageNumber(url, 'limit', 50, 100)
      if (!store.getTopic(groupId, topicId)) return send(response, 404, { error: 'topic_not_found' })
      const context = await store.getTopicContext({ groupId, topicId, ...(revision === undefined ? {} : { revision }), offset, limit })
      return send(response, 200, { ...context, topic: { ...topicSummary(context.topic), summary: context.topic.summary, openQuestions: context.topic.openQuestions } })
    } catch (error) { return send(response, 400, { error: error.message }) }
  }
  if (request.method === 'GET' && url.pathname === '/state/tasks') return send(response, 200, (await (store.listTaskView?.() ?? store.listTasks())).map(task => ({ ...task, workflowProgress: taskBoardProgress(task) })))
  if (request.method === 'GET' && url.pathname === '/state/workflows') return send(response, 200, await store.getWorkflowState?.(url.searchParams.get('runId') ?? undefined) ?? { enabled: false })
  if (request.method === 'GET' && url.pathname === '/state/task-timings') return send(response, 200, store.listTaskTimings())
  if (request.method === 'GET' && url.pathname === '/state/performance') return send(response, 200, store.listPerformance(Object.fromEntries(['day', 'sessionId', 'groupId', 'taskId', 'requestId', 'submissionId'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]))))
  if (request.method === 'GET' && url.pathname === '/state/authorizations') return send(response, 200, store.listAuthorizationRequests())
  if (request.method === 'GET' && url.pathname === '/state/activities') return send(response, 200, store.listActivities(url.searchParams.get('taskId') ?? undefined))
  if (request.method === 'GET' && url.pathname === '/state/supervisor/alerts') return send(response, 200, store.listAlerts())
  if (request.method === 'GET' && url.pathname === '/state/dws-bridge') return send(response, 200, store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] })
  if (request.method === 'GET' && url.pathname === '/state/environment') return send(response, 200, await store.inspectEnvironment())
  if (request.method === 'GET' && url.pathname === '/state/agent-config') return send(response, 200, store.getAgentConfig())
  if (request.method === 'GET' && url.pathname === '/state/task-sheet-sync') return send(response, 200, store.getTaskSheetSyncState())
  if (request.method === 'GET' && url.pathname === '/state/version') return send(response, 200, await checkForUpdatesImpl({ force: url.searchParams.get('refresh') === 'true' }))
  if (request.method === 'POST' && url.pathname === '/tasks') return submitWebTask(request, response, store, 'createTask')
  const reportRoute = /^\/tasks\/([^/]+)\/reports\/([^/]+)(\/retry)?$/u.exec(url.pathname)
  const notificationRetry = request.method === 'POST' && /^\/tasks\/([^/]+)\/notifications\/([^/]+)\/retry$/u.exec(url.pathname)
  if (notificationRetry) {
    try {
      await store.retryCompletionNotification({ taskId: decodeURIComponent(notificationRetry[1]), intentId: decodeURIComponent(notificationRetry[2]) })
      return send(response, 202, { received: true })
    } catch (error) { return send(response, 409, { error: error.message }) }
  }
  if (reportRoute && (request.method === 'GET' && !reportRoute[3] || request.method === 'POST' && reportRoute[3])) {
    try {
      // 此操作无 body 参数；身份仅由路径确定，禁止 body 覆盖 task/submission。
      const identity = { taskId: decodeURIComponent(reportRoute[1]), submissionId: decodeURIComponent(reportRoute[2]) }
      const value = await store[request.method === 'GET' ? 'getTaskReport' : 'retryTaskReport'](identity)
      return value === undefined ? send(response, 404, { error: 'task_report_not_found' }) : send(response, request.method === 'GET' ? 200 : 202, value)
    } catch (error) {
      const status = /^task_report_not_found(:|$)/u.test(error.message) ? 404 : /^task_report_retry_(stale|requires_failed)(:|$)/u.test(error.message) ? 409 : residentErrorStatus(error)
      return send(response, status, { error: error.message })
    }
  }
  const operationRetry = request.method === 'POST' && /^\/config\/groups\/([^/]+)\/topics\/([^/]+)\/decisions\/([^/]+)\/operations\/([^/]+)\/retry$/u.exec(url.pathname)
  if (operationRetry) {
    try {
      const body = z.strictObject({ resolution: z.enum(['not-applied', 'applied', 'reconsider']), reason: z.string().trim().min(1) }).parse(await readJson(request))
      const value = await store.retryDecisionOperation({ ...body, groupId: decodeURIComponent(operationRetry[1]), topicId: decodeURIComponent(operationRetry[2]), decisionId: decodeURIComponent(operationRetry[3]), operationId: decodeURIComponent(operationRetry[4]) })
      return send(response, 202, value)
    } catch (error) { return send(response, error instanceof z.ZodError ? 400 : 409, { error: error.message }) }
  }
  const coordinationRetry = request.method === 'POST' ? /^\/config\/groups\/([^/]+)\/coordination\/([^/]+)\/retry$/u.exec(url.pathname) : null
  if (coordinationRetry) {
    try {
      const value = await store.retryCoordinationRequest({ groupId: decodeURIComponent(coordinationRetry[1]), requestId: decodeURIComponent(coordinationRetry[2]) })
      return send(response, 202, value)
    } catch (error) { return send(response, error.message === 'topic_request_unknown_or_wrong_group' ? 404 : residentErrorStatus(error), { error: error.message }) }
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/context$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/context'.length))
    return submitWebTask(request, response, store, 'appendTaskContext', taskId)
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/archive$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/archive'.length))
    return send(response, 200, await store.archiveTask({ taskId }))
  }
  if (request.method === 'PUT' && /^\/tasks\/[^/]+\/title$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/title'.length))
    return send(response, 200, await store.renameTask({ taskId, ...(await readJson(request)) }))
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/reopen$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/reopen'.length))
    return submitWebTask(request, response, store, 'reopenTask', taskId)
  }
  if (request.method === 'POST' && /^\/authorizations\/[^/]+\/decision$/u.test(url.pathname)) {
    const requestId = decodeURIComponent(url.pathname.slice('/authorizations/'.length, -'/decision'.length))
    return send(response, 200, await store.decideAuthorization({ requestId, ...(await readJson(request)), source: 'web' }))
  }
  if (request.method === 'POST' && /^\/authorizations\/[^/]+\/reissue$/u.test(url.pathname)) {
    const requestId = decodeURIComponent(url.pathname.slice('/authorizations/'.length, -'/reissue'.length))
    return send(response, 200, await store.reissueAuthorization({ requestId, ...(await readJson(request)) }))
  }
  if (request.method === 'PUT' && url.pathname === '/config/agent') return send(response, 200, await store.updateAgentConfig(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/task-sheet-sync/check') return send(response, 200, await store.inspectTaskSheet(await readJson(request)))
  if (request.method === 'PUT' && url.pathname === '/config/task-sheet-sync') return send(response, 200, await store.updateTaskSheetSyncConfig(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/task-sheet-sync/run') return send(response, 200, await store.runTaskSheetSync())
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
  if (messageRetry) {
    const groupId = decodeURIComponent(messageRetry[1])
    const messageId = decodeURIComponent(messageRetry[2])
    return send(response, 200, await store.retryDecisionFailedMessage({ groupId, messageId }))
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/cancel$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/cancel'.length))
    return submitWebTask(request, response, store, 'cancelTask', taskId)
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/information-wait-notice$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/information-wait-notice'.length))
    try { return send(response, 202, await store.reconcileInformationWaitNotice({ taskId })) }
    catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
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
  if (request.method === 'POST' && url.pathname === '/test/tasks') return send(response, 200, await store.createTask(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/tasks/wait') return send(response, 200, await store.waitTask(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/tasks/resume') return send(response, 200, await store.resumeTask(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/tasks/followup') return send(response, 200, await store.followupTask(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/tasks/result') return send(response, 200, await store.submitTaskResult(await readJson(request)))
  if (request.method === 'POST' && url.pathname === '/test/supervisor/probe') return send(response, 200, await store.reportCarrierIssue(await readJson(request)))
  return send(response, 404, { error: 'not_found' })
}
