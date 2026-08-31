import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

async function withServer(testApiEnabled, run) {
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
    reopenTask: async ({ taskId, context, objective }) => ({ taskId, state: 'running', context, objective }),
    decideAuthorization: async (value) => value,
    reissueAuthorization: async (value) => value,
  }
  const server = createServer((request, response) => handleRequest(request, response, runtime, {
    testApiEnabled,
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
  const reopened = await fetch(`${baseUrl}/tasks/task-1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: '继续修复', objective: '修复并部署 UAT2' }) })
  assert.deepEqual(await reopened.json(), { taskId: 'task-1', state: 'running', context: '继续修复', objective: '修复并部署 UAT2' })
  const approval = await fetch(`${baseUrl}/authorizations/blocker-1/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved', comment: '页面批准' }) })
  assert.deepEqual(await approval.json(), { requestId: 'blocker-1', decision: 'approved', comment: '页面批准', source: 'web' })
  const reissued = await fetch(`${baseUrl}/authorizations/blocker-1/reissue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '迁移到统一授权审批' }) })
  assert.deepEqual(await reissued.json(), { requestId: 'blocker-1', reason: '迁移到统一授权审批' })
  assert.equal((await fetch(`${baseUrl}/test/tasks`, { method: 'POST', body: '{}' })).status, 404)
}))

test('显式testApiEnabled才开放测试写入口', async () => withServer(true, async (baseUrl) => {
  const response = await fetch(`${baseUrl}/test/subscriptions`, { method: 'POST', body: JSON.stringify({ groupId: 'g' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { created: true })
}))
