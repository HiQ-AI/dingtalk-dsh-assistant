import { checkForUpdates } from './version-check.js'

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
    'access-control-allow-origin': 'http://127.0.0.1:3080',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  })
  response.end(JSON.stringify(value))
}

export async function handleRequest(request, response, store, { testApiEnabled = false, transport = 'fake-dws', outboundAuthorized = false, modelMode = 'fake', checkForUpdatesImpl = checkForUpdates } = {}) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'OPTIONS') return send(response, 204, null)
  if (request.method === 'GET' && url.pathname === '/health') {
    const recoveryIssues = store.listRecoveryIssues()
    return send(response, 200, {
      status: recoveryIssues.length === 0 ? 'ok' : 'degraded', transport,
      inboundProcessing: transport === 'dws', outboundAuthorized, modelMode,
      recoveryIssueCount: recoveryIssues.length,
    })
  }
  if (request.method === 'GET' && url.pathname === '/state/recovery-issues') return send(response, 200, store.listRecoveryIssues())
  if (request.method === 'GET' && url.pathname === '/state/groups') {
    const groupId = url.searchParams.get('groupId')
    return send(response, 200, groupId ? store.getGroup(groupId) ?? null : store.listGroups())
  }
  if (request.method === 'GET' && url.pathname === '/state/tasks') return send(response, 200, store.listTasks())
  if (request.method === 'GET' && url.pathname === '/state/authorizations') return send(response, 200, store.listAuthorizationRequests())
  if (request.method === 'GET' && url.pathname === '/state/activities') return send(response, 200, store.listActivities(url.searchParams.get('taskId') ?? undefined))
  if (request.method === 'GET' && url.pathname === '/state/supervisor/alerts') return send(response, 200, store.listAlerts())
  if (request.method === 'GET' && url.pathname === '/state/environment') return send(response, 200, await store.inspectEnvironment())
  if (request.method === 'GET' && url.pathname === '/state/agent-config') return send(response, 200, store.getAgentConfig())
  if (request.method === 'GET' && url.pathname === '/state/version') return send(response, 200, await checkForUpdatesImpl({ force: url.searchParams.get('refresh') === 'true' }))
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/archive$/u.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/archive'.length))
    return send(response, 200, await store.archiveTask({ taskId }))
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
    const message = store.getGroup(groupId)?.messages.find((item) => item.messageId === messageId)
    if (message === undefined) return send(response, 404, { error: `message_not_found:${messageId}` })
    const result = await store.ingest({ ...message, groupId })
    const current = store.getGroup(groupId)?.messages.find((item) => item.messageId === messageId)
    if (current?.agentDeliveryStatus === 'delivered' && current.agentDeliveryError) {
      await store.markMessageAgentDelivery({ groupId, messageId, status: 'delivered' })
    }
    return send(response, 200, result)
  }
  if (request.method === 'POST' && url.pathname.startsWith('/config/groups/') && url.pathname.endsWith('/history/hydrate')) {
    const groupId = decodeURIComponent(url.pathname.slice('/config/groups/'.length, -'/history/hydrate'.length))
    return send(response, 200, await store.hydrateGroupHistory({ groupId }))
  }
  if (request.method === 'PUT' && url.pathname.startsWith('/config/groups/')) return send(response, 200, await store.updateGroup({ groupId: decodeURIComponent(url.pathname.slice('/config/groups/'.length)), ...(await readJson(request)) }))
  if (request.method === 'DELETE' && url.pathname.startsWith('/config/groups/')) return send(response, 200, await store.unsubscribe({ groupId: decodeURIComponent(url.pathname.slice('/config/groups/'.length)) }))
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
