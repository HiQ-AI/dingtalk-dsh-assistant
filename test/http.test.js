import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

async function withServer(testApiEnabled, run, { transport = 'fake-dws', getDwsBridgeHealth, overrides = {} } = {}) {
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
    listTopics: () => [],
    ...overrides,
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
  const cancelled = await fetch(`${baseUrl}/tasks/task-2/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'cancel-1', reason: '误建任务', inputVersion: 1, runSequence: 1, topicRefs: [{ topicId: 'topic-1', revision: 1 }] }) })
  assert.deepEqual(await cancelled.json(), { taskId: 'task-2', state: 'completed', completion: '已取消：误建任务' })
  const reopened = await fetch(`${baseUrl}/tasks/task-1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'web-reopen-1', context: '继续修复', objective: '修复并部署 UAT2', topicRefs: [{ topicId: 'topic-1', revision: 2 }], inputVersion: 1, runSequence: 1 }) })
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

test('报告查询与显式恢复只采用路径身份，缺失返回404、不可恢复状态409', async () => {
  const calls = []
  await withServer(false, async base => {
    const reportPath = '/tasks/task%2Fa/reports/report%2Bb'
    assert.equal((await fetch(base + reportPath)).status, 200)
    assert.equal((await fetch(base + reportPath + '/retry', { method: 'POST', body: JSON.stringify({ taskId: 'forged', submissionId: 'forged' }) })).status, 202)
    assert.equal((await fetch(base + '/config/groups/group%2Fa/coordination/request%2Bb/retry', { method: 'POST', body: JSON.stringify({ groupId: 'forged', requestId: 'forged' }) })).status, 202)
    assert.deepEqual(calls, [ ['get', { taskId: 'task/a', submissionId: 'report+b' }], ['retry', { taskId: 'task/a', submissionId: 'report+b' }], ['coordination', { groupId: 'group/a', requestId: 'request+b' }] ])
    assert.equal((await fetch(base + '/tasks/t/reports/missing')).status, 404)
    assert.equal((await fetch(base + '/tasks/t/reports/missing/retry', { method: 'POST' })).status, 404)
    assert.equal((await fetch(base + '/tasks/t/reports/stale/retry', { method: 'POST' })).status, 409)
    assert.equal((await fetch(base + '/config/groups/g/coordination/missing/retry', { method: 'POST' })).status, 404)
  }, { overrides: {
    getTaskReport: async value => { if (value.submissionId === 'missing') return undefined; calls.push(['get', value]); return { status: 'failed' } },
    retryTaskReport: async value => { if (value.submissionId === 'missing') throw new Error('task_report_not_found:missing'); if (value.submissionId === 'stale') throw new Error('task_report_retry_stale:stale'); calls.push(['retry', value]); return { status: 'review-wait' } },
    retryCoordinationRequest: async value => { if (value.requestId === 'missing') throw new Error('topic_request_unknown_or_wrong_group'); calls.push(['coordination', value]); return { status: 'pending' } },
  } })
})

test('context支持同源影响证据，create/reopen拒绝这些字段', async () => {
  const calls = [], body = { requestId: 'r1', context: '证据修订', topicRefs: [{ topicId: 'topic1', revision: 2 }], inputVersion: 1, runSequence: 1, progressImpact: 'replan', impactEvidence: { basisMessageIds: ['m1'], reason: '该阶段证据失效', affectedStageIds: ['stage1'] } }
  await withServer(false, async base => {
    const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    assert.equal((await post('/tasks/t/context', body)).status, 200)
    assert.deepEqual(calls[0].impactEvidence, body.impactEvidence)
    assert.equal((await post('/tasks/t/reopen', body)).status, 400)
    assert.equal((await post('/tasks', { ...body, groupId: 'g', title: '任务', objective: '目标', acceptanceCriteria: ['结果'] })).status, 400)
    assert.equal((await post('/tasks/t/context', { ...body, impactEvidence: { ...body.impactEvidence, affectedStageIds: [] } })).status, 400)
    assert.equal(calls.length, 1)
  }, { overrides: { appendTaskContext: async value => { calls.push(value); return value } } })
})

test('Web Task 入口强制稳定请求与执行版本且拒绝伪造来源和Session', async () => {
  const calls = []
  const update = { requestId: 'web-1', context: '只处理本月', topicRefs: [{ topicId: 'topic-1', revision: 2 }], inputVersion: 1, runSequence: 1 }
  await withServer(false, async (baseUrl) => {
    const post = (path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/tasks', { requestId: 'create-1', groupId: 'g', title: '数据导出', objective: '导出本月', context: '请导出本月数据', acceptanceCriteria: ['文件可读'] })).status, 200)
    assert.equal(calls[0].topicRefs, undefined)
    assert.equal((await post('/tasks/task-1/context', update)).status, 200)
    assert.equal(calls[1].taskId, 'task-1')
    assert.equal(calls[1].inputVersion, 1)
    assert.equal((await post('/tasks/task-1/reopen', update)).status, 200)
    for (const extra of [{ childSessionId: 'other-session' }, { taskId: 'other-task' }, { sourceKind: 'dingtalk' }, { sourceMessageId: 'fake-message' }]) assert.equal((await post('/tasks/task-1/context', { ...update, ...extra })).status, 400)
    for (const field of ['requestId', 'context', 'topicRefs', 'inputVersion', 'runSequence']) {
      const invalid = { ...update }; delete invalid[field]
      assert.equal((await post('/tasks/task-1/reopen', invalid)).status, 400)
    }
    assert.equal(calls.length, 3)
  }, { overrides: {
    createTask: async (value) => { calls.push(value); return { taskId: 'created' } },
    appendTaskContext: async (value) => { calls.push(value); return value },
    reopenTask: async (value) => { calls.push(value); return value },
  } })
})

test('移除群遇到Topic引用或未完成决策返回409而非普通参数错误', async () => {
  for (const reason of ['group_has_referenced_topics', 'group_has_pending_decisions', 'group_has_pending_outbox', 'group_has_active_tasks:g']) {
    await withServer(false, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/config/groups/g`, { method: 'DELETE' })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error, reason)
    }, { overrides: { unsubscribe: async () => { throw new Error(reason) } } })
  }
})

test('Web输入版本与幂等身份冲突返回409，可靠接收尚未完成返回202', async () => {
  let result = new Error('task_input_version_stale')
  await withServer(false, async (baseUrl) => {
    const post = () => fetch(`${baseUrl}/tasks/task-1/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r1', context: '补充', topicRefs: [{ topicId: 't1', revision: 1 }], inputVersion: 1, runSequence: 1 }) })
    assert.equal((await post()).status, 409)
    result = new Error('task_request_identity_conflict')
    assert.equal((await post()).status, 409)
    result = { status: 'accepted', decisionId: 'd1', topicId: 't1' }
    assert.equal((await post()).status, 202)
  }, { overrides: { appendTaskContext: async () => { if (result instanceof Error) throw result; return result } } })
})

test('Topic 查询有界分页且群摘要不泄漏内部决策、归类和预约记录', async () => {
  const topics = Array.from({ length: 102 }, (_, index) => ({ groupId: 'g', topicId: `topic-${index}`, title: `话题 ${index}`, revision: 3, processedRevision: 1, status: 'active', summary: '摘'.repeat(1100), openQuestions: ['待确认'], entries: [{ revision: 1, messageId: 'm1', action: index === 0 ? 'add' : 'remove' }], decisions: [{ decisionId: 'old', status: 'failed', operations: [] }, { decisionId: 'current', status: 'failed', error: '失败'.repeat(600), operations: [{ status: 'applied', action: { secretInternal: true } }, { status: 'pending' }] }, { decisionId: 'done', status: 'completed', operations: [] }] }))
  const group = { groupId: 'g', topics, routeHistory: [{ request: 'internal' }], taskReservations: [{ taskId: 't' }], messages: [{ messageId: 'm1', routingStatus: 'pending' }], outbox: [] }
  for (const topic of topics) topic.decisions.push({ decisionId: 'rejected-latest', status: 'rejected', operations: [], error: 'task_revision_stage_invalid' })
  let request
  await withServer(false, async (baseUrl) => {
    const listing = await (await fetch(`${baseUrl}/state/topics?groupId=g&offset=100&limit=2`)).json()
    assert.equal(listing.total, 102)
    assert.deepEqual(listing.topics.map((topic) => topic.topicId), ['topic-100', 'topic-101'])
    assert.equal(listing.topics[0].summary.length, 1000)
    assert.equal(listing.topics[0].decisions, undefined)
    assert.equal(listing.topics[0].entries, undefined)
    assert.deepEqual(listing.topics[0].processing, { decisionId: 'current', status: 'failed', appliedOperations: 1, totalOperations: 2, error: '失败'.repeat(500) })
    const projected = await (await fetch(`${baseUrl}/state/groups?groupId=g`)).json()
    assert.equal(projected.topics, undefined)
    assert.equal(projected.routeHistory, undefined)
    assert.equal(projected.taskReservations, undefined)
    assert.deepEqual(projected.messages, [{ ...group.messages[0], topicRefs: [{ topicId: 'topic-0', revision: 3, title: '话题 0' }] }])
    assert.deepEqual(projected.topicProgress, { total: 102, pending: 102, pendingRevisions: 204, unroutedMessages: 1 })
    const detail = await (await fetch(`${baseUrl}/state/topics/topic-0?groupId=g&revision=2&offset=1&limit=3`)).json()
    assert.deepEqual(request, { groupId: 'g', topicId: 'topic-0', revision: 2, offset: 1, limit: 3 })
    assert.equal(detail.topic.decisions, undefined)
    assert.equal(detail.topic.entries, undefined)
    assert.deepEqual(detail.topic.processing, listing.topics[0].processing)
    assert.deepEqual(detail.messages, [{ messageId: 'm1', text: '原始消息' }])
    assert.equal((await fetch(`${baseUrl}/state/topics/topic-0?groupId=other`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/state/topics/topic-0`)).status, 400)
    for (const query of ['limit=101', 'limit=0', 'offset=-1', 'offset=1.5', 'offset=9999999999999999999999']) assert.equal((await fetch(`${baseUrl}/state/topics?${query}`)).status, 400)
    assert.equal((await fetch(`${baseUrl}/state/topics/topic-0?groupId=g&revision=NaN`)).status, 400)
  }, { overrides: {
    listGroups: () => [group], getGroup: (groupId) => groupId === 'g' ? group : undefined,
    listTopics: (groupId) => !groupId || groupId === 'g' ? topics : [], getTopic: (groupId, topicId) => groupId === 'g' ? topics.find((topic) => topic.topicId === topicId) : undefined,
    getTopicContext: async (value) => { request = value; return { ...value, topic: topics[0], messages: [{ messageId: 'm1', text: '原始消息' }], total: 4, taskRefs: [] } },
  } })
})

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
