import { checkForUpdates } from './version-check.js'
import { z } from 'zod'

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
  const unfinished = topic.decisions?.findLast((item) => item.status !== 'completed')
  return {
    topicId: topic.topicId, groupId: topic.groupId, title: topic.title,
    revision: topic.revision, processedRevision: topic.processedRevision, status: topic.status,
    summary: String(topic.summary ?? '').slice(0, 1000),
    summaryRevision: topic.summaryRevision,
    openQuestionCount: topic.openQuestions?.length ?? 0,
    pendingRevisionCount: Math.max(0, topic.revision - topic.processedRevision),
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
      const current = topic.entries?.findLast((entry) => entry.messageId === message.messageId)
      return current?.action === 'add' ? [{ topicId: topic.topicId, revision: topic.revision, title: topic.title }] : []
    }),
  }))
  summary.topicProgress = {
    total: topics.length,
    pending: topics.filter((topic) => topic.revision > topic.processedRevision).length,
    pendingRevisions: topics.reduce((count, topic) => count + Math.max(0, topic.revision - topic.processedRevision), 0),
    unroutedMessages: (group.messages ?? []).filter((message) => message.routingStatus === 'pending' || message.routingStatus === 'failed').length,
  }
  return summary
}

const requiredText = z.string().trim().min(1)
const topicRefsSchema = z.array(z.strictObject({ topicId: requiredText, revision: z.number().int().positive() })).min(1)
const taskInputFields = {
  requestId: requiredText, context: requiredText, topicRefs: topicRefsSchema,
  objective: requiredText.optional(), acceptanceCriteria: z.array(requiredText).min(1).optional(), stageTasks: z.array(requiredText).min(1).optional(),
}
const createTaskInputSchema = z.strictObject({ ...taskInputFields, groupId: requiredText, title: requiredText, objective: requiredText, acceptanceCriteria: z.array(requiredText).min(1), topicRefs: topicRefsSchema.optional() })
const updateTaskInputSchema = z.strictObject({ ...taskInputFields, inputVersion: z.number().int().positive(), runSequence: z.number().int().positive() })
const cancelTaskInputSchema = z.strictObject({ requestId: requiredText, reason: requiredText, inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), topicRefs: topicRefsSchema })

export function residentErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /^(group_has_(active_tasks|referenced_topics|pending_decisions|pending_outbox)|task-stale|task_input_version_(conflict|stale)|task_request_identity_conflict|task_input_pending|task_topic_version_invalid|task_result_context_changed|task_prompts_version_conflict|task_web_(task-stale|topic-stale|routing-required)|web_task_version_conflict)(:|$)/u.test(message) ? 409 : 400
}

async function submitWebTask(request, response, runtime, kind, taskId) {
  try {
    const body = await readJson(request)
    const parsed = (kind === 'createTask' ? createTaskInputSchema : kind === 'cancelTask' ? cancelTaskInputSchema : updateTaskInputSchema).safeParse(body)
    if (!parsed.success) return send(response, 400, { error: 'web_task_request_invalid', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
    const value = await runtime[kind]({ ...parsed.data, ...(taskId ? { taskId } : {}) })
    return send(response, value?.status === 'task-stale' ? 409 : value?.status === 'accepted' ? 202 : 200, value)
  } catch (error) { return send(response, residentErrorStatus(error), { error: error.message }) }
}

export async function handleRequest(request, response, store, { testApiEnabled = false, transport = 'fake-dws', outboundAuthorized = false, modelMode = 'fake', checkForUpdatesImpl = checkForUpdates } = {}) {
  applyResidentCorsHeaders(request, response)
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'OPTIONS') return send(response, 204, null)
  if (request.method === 'GET' && url.pathname === '/health') {
    const recoveryIssues = store.listRecoveryIssues()
    const inboundConfigured = transport === 'dws'
    const dwsBridge = inboundConfigured ? store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] } : undefined
    const inboundProcessing = inboundConfigured && dwsBridge.healthy === true
    return send(response, 200, {
      status: recoveryIssues.length === 0 && (!inboundConfigured || inboundProcessing) ? 'ok' : 'degraded', transport,
      inboundConfigured, inboundProcessing, outboundAuthorized, modelMode,
      recoveryIssueCount: recoveryIssues.length,
      ...(dwsBridge !== undefined ? { dwsBridge } : {}),
    })
  }
  if (request.method === 'GET' && url.pathname === '/state/recovery-issues') return send(response, 200, store.listRecoveryIssues())
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
  if (request.method === 'GET' && url.pathname === '/state/tasks') return send(response, 200, store.listTasks())
  if (request.method === 'GET' && url.pathname === '/state/task-timings') return send(response, 200, store.listTaskTimings())
  if (request.method === 'GET' && url.pathname === '/state/authorizations') return send(response, 200, store.listAuthorizationRequests())
  if (request.method === 'GET' && url.pathname === '/state/activities') return send(response, 200, store.listActivities(url.searchParams.get('taskId') ?? undefined))
  if (request.method === 'GET' && url.pathname === '/state/supervisor/alerts') return send(response, 200, store.listAlerts())
  if (request.method === 'GET' && url.pathname === '/state/dws-bridge') return send(response, 200, store.getDwsBridgeHealth?.() ?? { healthy: false, groups: [] })
  if (request.method === 'GET' && url.pathname === '/state/environment') return send(response, 200, await store.inspectEnvironment())
  if (request.method === 'GET' && url.pathname === '/state/agent-config') return send(response, 200, store.getAgentConfig())
  if (request.method === 'GET' && url.pathname === '/state/version') return send(response, 200, await checkForUpdatesImpl({ force: url.searchParams.get('refresh') === 'true' }))
  if (request.method === 'POST' && url.pathname === '/tasks') return submitWebTask(request, response, store, 'createTask')
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
