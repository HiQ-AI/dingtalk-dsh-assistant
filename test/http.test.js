import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

async function withServer(testApiEnabled, run, { transport = 'fake-dws', getDwsBridgeHealth } = {}) {
  const runtime = {
    listRecoveryIssues: () => [], listGroups: () => [], getGroup: () => undefined, listTasks: () => [], listTaskTimings: () => [{ taskId: 'task-1', wallMs: 1000 }], listActivities: () => [], listAlerts: () => [], listAuthorizationRequests: () => [{ requestId: 'blocker-1', status: 'pending-send' }],
    subscribe: async () => ({ created: true }),
    updateGroup: async (value) => value,
    unsubscribe: async (value) => ({ removed: true, ...value }),
    getAgentConfig: () => ({ workspaceDir: 'D:\\baibu-agent' }),
    updateAgentConfig: async (value) => value,
    inspectEnvironment: async () => ({ dws: { installed: true }, skills: [] }),
    searchGroups: async (query) => ({ complete: true, groups: [{ groupId: 'g', name: query }] }),
    archiveTask: async ({ taskId }) => ({ taskId, state: 'completed', archivedAt: '2026-08-25T00:00:00.000Z' }),
    cancelTask: async ({ taskId, reason }) => ({ taskId, state: 'completed', completion: `已取消：${reason}` }),
    reopenTask: async ({ taskId, context, objective }) => ({ taskId, state: 'running', context, objective }),
    decideAuthorization: async (value) => value,
    reissueAuthorization: async (value) => value,
    retryDecisionFailedMessage: async (value) => ({ retried: true, ...value }),
    getDwsBridgeHealth: getDwsBridgeHealth ?? (() => ({ healthy: true, groups: [] })),
  }
  const server = createServer((request, response) => handleRequest(request, response, runtime, {
    testApiEnabled,
    transport,
    checkForUpdatesImpl: async () => ({ currentVersion: '0.4.0', latestVersion: null, updateAvailable: false }),
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) } finally { await new Promise((resolve) => server.close(resolve)) }
}

test('生产HTTP开放只读状态与明确的本机群配置接口，测试控制面仍关闭', async () => withServer(false, async (baseUrl) => {
  const health = await fetch(`${baseUrl}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).transport, 'fake-dws')
  assert.equal((await fetch(`${baseUrl}/state/tasks`)).status, 200)
  assert.deepEqual(await (await fetch(`${baseUrl}/state/task-timings`)).json(), [{ taskId: 'task-1', wallMs: 1000 }])
  assert.equal((await fetch(`${baseUrl}/state/authorizations`)).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/groups/search?q=产品`)).status, 200)
  assert.equal((await fetch(`${baseUrl}/state/agent-config`)).status, 200)
  assert.deepEqual(await (await fetch(`${baseUrl}/state/version`)).json(), { currentVersion: '0.4.0', latestVersion: null, updateAvailable: false })
  assert.equal((await fetch(`${baseUrl}/config/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceDir: 'D:\\baibu-agent' }) })).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proxyUrl: 'http://127.0.0.1:10808' }) })).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/groups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: 'g', responsibility: 'r' }) })).status, 200)
  const archived = await fetch(`${baseUrl}/tasks/task-1/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(archived.status, 200)
  assert.equal((await archived.json()).archivedAt, '2026-08-25T00:00:00.000Z')
  const cancelled = await fetch(`${baseUrl}/tasks/task-2/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '误建任务' }) })
  assert.deepEqual(await cancelled.json(), { taskId: 'task-2', state: 'completed', completion: '已取消：误建任务' })
  const reopened = await fetch(`${baseUrl}/tasks/task-1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: '继续修复', objective: '修复并部署 UAT2' }) })
  assert.deepEqual(await reopened.json(), { taskId: 'task-1', state: 'running', context: '继续修复', objective: '修复并部署 UAT2' })
  const approval = await fetch(`${baseUrl}/authorizations/blocker-1/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved', comment: '页面批准' }) })
  assert.deepEqual(await approval.json(), { requestId: 'blocker-1', decision: 'approved', comment: '页面批准', source: 'web' })
  const reissued = await fetch(`${baseUrl}/authorizations/blocker-1/reissue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '迁移到统一授权审批' }) })
  assert.deepEqual(await reissued.json(), { requestId: 'blocker-1', reason: '迁移到统一授权审批' })
  const retried = await fetch(`${baseUrl}/config/groups/${encodeURIComponent('cid/a')}/messages/${encodeURIComponent('msg+b')}/retry`, { method: 'POST' })
  assert.deepEqual(await retried.json(), { retried: true, groupId: 'cid/a', messageId: 'msg+b' })
  assert.equal((await fetch(`${baseUrl}/test/tasks`, { method: 'POST', body: '{}' })).status, 404)
}))

test('显式testApiEnabled才开放测试写入口', async () => withServer(true, async (baseUrl) => {
  const response = await fetch(`${baseUrl}/test/subscriptions`, { method: 'POST', body: JSON.stringify({ groupId: 'g' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { created: true })
}))

test('本机Web的127.0.0.1与localhost来源均可读取resident，其他来源不开放CORS', async () => withServer(false, async (baseUrl) => {
  for (const origin of ['http://127.0.0.1:3080', 'http://localhost:3080']) {
    const response = await fetch(`${baseUrl}/health`, { headers: { origin } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
    assert.equal(response.headers.get('vary'), 'Origin')
  }
  const preflight = await fetch(`${baseUrl}/health`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3080' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3080')
  const foreign = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://example.com' } })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
}))

test('DWS健康状态以实际 bridge 存活和补拉状态为准', async () => {
  let bridgeHealth = {
    healthy: false,
    groups: [{ groupId: 'cid-a', listener: { state: 'reconnecting' }, backfill: { state: 'failed', lastError: 'dws_backfill_partial:cid-a' }, reconnect: { attempt: 1 } }],
  }
  await withServer(false, async (baseUrl) => {
    const degraded = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(degraded.status, 'degraded')
    assert.equal(degraded.inboundConfigured, true)
    assert.equal(degraded.inboundProcessing, false)
    assert.deepEqual(degraded.dwsBridge, bridgeHealth)
    assert.deepEqual(await (await fetch(`${baseUrl}/state/dws-bridge`)).json(), bridgeHealth)

    bridgeHealth = {
      healthy: true,
      groups: [{ groupId: 'cid-a', listener: { state: 'ready' }, backfill: { state: 'ok' }, reconnect: { attempt: 0 } }],
    }
    const healthy = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(healthy.status, 'ok')
    assert.equal(healthy.inboundProcessing, true)
  }, { transport: 'dws', getDwsBridgeHealth: () => bridgeHealth })
})
