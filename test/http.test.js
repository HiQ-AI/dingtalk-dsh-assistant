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
    getTaskSheetSyncState: () => ({ config: { enabled: true }, status: { state: 'success' } }),
    inspectTaskSheet: async () => ({ name: '任务表', sheets: [{ sheetId: 's1', title: 'Sheet1' }] }),
    updateTaskSheetSyncConfig: async (value) => value,
    runTaskSheetSync: async () => ({ state: 'success', taskCount: 2 }),
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

test('话题关联修复本机入口区分零写预检和摘要绑定执行，拒绝跨站与自报身份', async () => {
  const calls = [], input = { sourceTopicId: 'source', targetTopicId: 'target',
    topicPresentation: { title: '数据集导入导出开发', summary: '依据已提供规则文档开发。' },
    maintenanceId: 'maintenance', maintenanceRevision: 2, reason: '用户明确四条消息属于同一事项' }
  await withServer(false, async base => {
    const post = (suffix, body, origin) => fetch(base + '/runtime/topics/reconcile' + suffix, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post('/check', input)).status, 200)
    assert.equal((await post('', { ...input, requestId: 'apply', expectedDigest: 'a'.repeat(64) })).status, 200)
    assert.deepEqual(calls.map(call => call.check), [true, false])
    assert.equal((await post('/check', input, 'https://untrusted.example')).status, 403)
    assert.equal((await post('/check', { ...input, actorId: 'owner' })).status, 400)
    assert.equal((await post('', { ...input, requestId: 'apply' })).status, 400)
    assert.equal(calls.length, 2)
  }, { overrides: { reconcileWorkflowTopic: async (value, check) => { calls.push({ value, check }); return { checked: true } } } })
})

test('工作流只读状态与异步任务视图保留新节点真实完成状态', async () => {
  await withServer(false, async base => {
    const tasks = await (await fetch(base + '/state/tasks')).json()
    assert.equal(tasks[0].workflowProgress.stages[0].completed, true)
    assert.equal(tasks[0].workflowProgress.stages[1].completed, false)
    assert.deepEqual(await (await fetch(base + '/state/workflows?runId=r')).json(), { runId: 'r', status: 'waiting' })
    assert.deepEqual(await (await fetch(base + '/state/workflows/catalog')).json(), { engine: 'workflow-v2', workflows: [{ id: 'task-analysis' }] })
  }, { overrides: { listTaskView: async () => [{ taskId: 't', engine: 'workflow-v2', executionNodes: [{ nodeId: 'prepare', status: 'succeeded' }, { nodeId: 'execute', status: 'running' }] }], getWorkflowState: async runId => ({ runId, status: 'waiting' }), getWorkflowCatalog: () => ({ engine: 'workflow-v2', workflows: [{ id: 'task-analysis' }] }) } })
})

test('工程仓库重发仅接受本机同源严格参数并返回受管结果', async () => {
  const submitted = []
  await withServer(false, async base => {
    const post = (body, origin) => fetch(base + '/tasks/task-1/reissue-repository', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post({ repositoryId: 'dataset', requestId: 'reissue-1' }, 'https://evil.example')).status, 403)
    assert.equal((await post({ repositoryId: 'dataset', requestId: 'reissue-1', actorId: 'forged' })).status, 400)
    const response = await post({ repositoryId: 'dataset', requestId: 'reissue-1' })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { taskId: 'task-1', generation: 3 })
    assert.deepEqual(submitted, [{ repositoryId: 'dataset', requestId: 'reissue-1', taskId: 'task-1', action: 'reissue-repository' }])
  }, { overrides: { submitWorkflowTask: async value => { submitted.push(value); return { taskId: value.taskId, generation: 3 } } } })
})

test('群收发信箱合并新工作流持久消息与通知，按 ID 去重且保留旧群记录', async () => {
  const group = { groupId: 'g', messages: [{ messageId: 'old', text: '旧消息', senderName: '原发送者', attachments: [{ name: '参考.pdf' }], sequence: 1, occurredAt: '2026-09-23T11:00:00Z' }], outbox: [{ outboundId: 'old-out', sourceMessageId: 'old', text: '旧回复', status: 'sent' }] }
  const mailboxes = {
    messages: [
      { groupId: 'g', messageId: 'new', text: '新消息', sequence: 2, occurredAt: '2026-09-24T02:00:00Z', routingStatus: 'pending', topicRefs: [{topicId:'workflow-topic',revision:1,title:'新话题'}] },
      { groupId: 'g', messageId: 'old', text: '工作流当前消息', runId: 'native-run', workflowStatus: 'processed', senderName: undefined, topicRefs: [{ topicId: 'current-topic' }], sequence: 2, occurredAt: '2026-09-24T02:01:00Z', routingStatus: 'routed' },
      { groupId: 'elsewhere', messageId: 'old', text: '其他群', sequence: 3, occurredAt: '2026-09-24T02:02:00Z', routingStatus: 'routed' },
    ],
    outbox: [
      { groupId: 'g', outboundId: 'new-out', sourceMessageId: 'new', text: '新通知', status: 'pending' },
      { groupId: 'g', outboundId: 'old-out', sourceMessageId: 'old', text: '不得覆盖旧通知', status: 'sent' },
      { groupId: 'elsewhere', outboundId: 'other-out', sourceMessageId: 'other', text: '其他群', status: 'sent' },
    ],
  }
  await withServer(false, async base => {
    const item = await (await fetch(base + '/state/groups?groupId=g')).json()
    assert.deepEqual(item.messages.map(message => message.messageId), ['old', 'new'])
    assert.equal(item.messages[0].text, '工作流当前消息')
    assert.equal(item.messages[0].runId, 'native-run')
    assert.equal(item.messages[0].workflowStatus, 'processed')
    assert.equal(item.messages[0].sourceKind, 'workflow-v2')
    assert.equal(item.messages[0].senderName, '原发送者')
    assert.deepEqual(item.messages[0].attachments, [{ name: '参考.pdf' }])
    assert.deepEqual(item.messages[0].topicRefs, [{ topicId: 'current-topic' }])
    assert.equal(group.messages[0].text, '旧消息')
    assert.equal(group.messages[0].runId, undefined)
    assert.equal(item.messages[1].sourceKind, 'workflow-v2')
    assert.equal(item.messages[1].topicRefs[0].topicId,'workflow-topic')
    assert.deepEqual(item.outbox.map(message => message.outboundId), ['old-out', 'new-out'])
    assert.equal(item.outbox[0].text, '旧回复')
    const all = await (await fetch(base + '/state/groups')).json()
    assert.equal(all.length, 1)
    assert.deepEqual(all[0].messages.map(message => message.messageId), ['old', 'new'])
  }, { overrides: { listGroups: () => [group], getGroup: () => group, getWorkflowMailboxes: async () => mailboxes } })
})
test('新工作流话题进入列表与详情，跨群详情不可读',async()=>{
  const topic={topicId:'workflow-topic',conversationId:'g',title:'归一化回归',revision:2,createdAt:'2026-09-24T02:00:00Z',updatedAt:'2026-09-24T02:01:00Z',facts:[{text:'复现 0.001 t'}]}
  await withServer(false,async base=>{
    const listing=await(await fetch(base+'/state/topics?groupId=g')).json()
    assert.equal(listing.total,1)
    assert.equal(listing.topics[0].topicId,'workflow-topic')
    assert.equal(listing.topics[0].summary, '')
    const detail=await(await fetch(base+'/state/topics/workflow-topic?groupId=g')).json()
    assert.equal(detail.topic?.engine,'workflow-v2',JSON.stringify(detail))
    assert.equal(detail.messages[0].text,'原消息')
    topic.title = '数据集导入导出开发'
    topic.summary = '按已提供文档开发；先核对目标仓库。'
    topic.contextRevision = 4
    const refreshed = await (await fetch(base+'/state/topics?groupId=g')).json()
    const refreshedDetail = await (await fetch(base+'/state/topics/workflow-topic?groupId=g')).json()
    assert.equal(refreshed.topics[0].title, topic.title)
    assert.equal(refreshed.topics[0].summary, topic.summary)
    assert.equal(refreshed.topics[0].summaryRevision, 4)
    assert.equal(refreshedDetail.topic.summary, topic.summary)
    assert.equal((await fetch(base+'/state/topics/workflow-topic?groupId=other')).status,404)
  },{overrides:{listWorkflowTopics:async groupId=>groupId==='other'?[]:[topic],getWorkflowTopicContext:async({groupId})=>groupId==='g'?{topic,messages:[{messageId:'m',text:'原消息'}],total:1}:null}})
})

test('本机澄清回答拒绝body伪造actor与外站Origin，只传固定路径身份', async () => {
  const calls = []
  await withServer(false, async base => {
    const post = (body, origin) => fetch(base + '/workflows/run/requests/question/answer', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post({ eventId: 'answer', answer: '第一个', actorId: 'owner' })).status, 400)
    assert.equal((await post({ eventId: 'answer', answer: '第一个' }, 'https://evil.example')).status, 403)
    assert.equal((await post({ eventId: 'answer', answer: '第一个' }, 'http://localhost:3080')).status, 200)
    assert.deepEqual(calls, [{ eventId: 'answer', answer: '第一个', runId: 'run', requestId: 'question' }])
  }, { overrides: { resumeWorkflowRequest: async args => { calls.push(args); return { accepted: true } } } })
})

test('通知操作仅本机逐条预检和按路径执行，拒绝额外对象字段',async()=>{
 const calls=[]
 await withServer(false,async base=>{
   const post=(path,body,origin)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
   const prepare={operationId:'op',notificationId:'notice',type:'recall',reason:'explicit_user',authorizationRef:'user-request'}
   assert.equal((await post('/workflows/notifications/operations',prepare,'https://evil.example')).status,403)
   assert.equal((await post('/workflows/notifications/operations',{...prepare,notificationIds:['other']})).status,400)
   assert.equal((await post('/workflows/notifications/operations',prepare)).status,200)
   assert.equal((await post('/workflows/notifications/operations/op/execute',{expectedFactDigest:'sha',authorizationRef:'user-request',notificationId:'other'})).status,400)
   assert.equal((await post('/workflows/notifications/operations/op/execute',{expectedFactDigest:'sha',authorizationRef:'user-request'})).status,202)
   assert.equal((await post('/workflows/notifications/operations/op/reconcile',{messageId:'out',evidenceRef:'readback',recallStatus:'SUCCESS'})).status,400)
   assert.equal((await post('/workflows/notifications/operations/op/reconcile',{authorizationRef:'user-request'})).status,200)
   assert.equal((await post('/workflows/notifications/operations',{...prepare,actorId:'owner'})).status,400)
   const {authorizationRef,...webPrepare}=prepare
   assert.equal((await post('/workflows/notifications/operations',webPrepare)).status,200)
   assert.equal((await post('/workflows/notifications/operations/op/execute',{expectedFactDigest:'sha'})).status,202)
   assert.equal((await post('/workflows/notifications/operations/op/reconcile',{})).status,200)
   assert.deepEqual(calls.map(item=>item[0]),['prepare','execute','reconcile','prepare','execute','reconcile'])
   assert.equal(calls[1][1].operationId,'op')
 },{overrides:{prepareWorkflowNotificationOperation:async args=>{calls.push(['prepare',args]);return {operationId:args.operationId}},executeWorkflowNotificationOperation:async args=>{calls.push(['execute',args]);return {status:'acknowledged'}},reconcileWorkflowNotificationOperation:async args=>{calls.push(['reconcile',args]);return {status:'completed'}}}})
})

test('通知恢复仅使用路径身份，受阻或过期意图返回冲突', async () => {
  const calls = []
  await withServer(false, async base => {
    assert.equal((await fetch(base + '/tasks/t/notifications/n/retry', { method: 'POST', body: JSON.stringify({ taskId: 'other' }) })).status, 202)
    assert.deepEqual(calls, [{ taskId: 't', intentId: 'n' }])
    assert.equal((await fetch(base + '/tasks/t/notifications/stale/retry', { method: 'POST' })).status, 409)
  }, { overrides: { retryCompletionNotification: async args => { if (args.intentId === 'stale') throw new Error('notification_retry_stale'); calls.push(args) } } })
})

test('控制账失效时健康状态降级并保留首因，不能只看群桥', async () => withServer(false, async base => {
  const response = await fetch(`${base}/health`), result = await response.json()
  assert.equal(result.dwsBridge.healthy, true)
  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.executionStore, { healthy: false, failure: { code: 'ERR_SQLITE_ERROR', sqliteCode: 13, kind: 'run.stop' } })
}, { transport: 'dws', overrides: { getWorkflowExecutionHealth: () => ({ healthy: false, failure: { code: 'ERR_SQLITE_ERROR', sqliteCode: 13, kind: 'run.stop' } }) } }))

test('生产HTTP开放只读状态与明确的本机群配置接口，测试控制面仍关闭', async () => withServer(false, async (baseUrl) => {
  const health = await fetch(`${baseUrl}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).transport, 'fake-dws')
  assert.equal((await fetch(`${baseUrl}/state/tasks`)).status, 200)
  assert.deepEqual(await (await fetch(`${baseUrl}/state/activity-audit`)).json(), { total: 0, pending: 0, audited: 0, unavailable: [] })
  assert.deepEqual(await (await fetch(`${baseUrl}/state/task-timings`)).json(), [{ taskId: 'task-1', wallMs: 1000 }])
  assert.equal((await fetch(`${baseUrl}/state/authorizations`)).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/groups/search?q=产品`)).status, 200)
  assert.equal((await fetch(`${baseUrl}/state/agent-config`)).status, 200)
  assert.deepEqual(await (await fetch(`${baseUrl}/state/task-sheet-sync`)).json(), { config: { enabled: true }, status: { state: 'success' } })
  assert.deepEqual(await (await fetch(`${baseUrl}/task-sheet-sync/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentUrl: 'https://alidocs.dingtalk.com/i/nodes/node' }) })).json(), { name: '任务表', sheets: [{ sheetId: 's1', title: 'Sheet1' }] })
  assert.deepEqual(await (await fetch(`${baseUrl}/config/task-sheet-sync`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, documentUrl: 'https://alidocs.dingtalk.com/i/nodes/node', sheetId: 's1' }) })).json(), { enabled: true, documentUrl: 'https://alidocs.dingtalk.com/i/nodes/node', sheetId: 's1' })
  assert.deepEqual(await (await fetch(`${baseUrl}/task-sheet-sync/run`, { method: 'POST' })).json(), { state: 'success', taskCount: 2 })
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

test('活动审计历史缺源计入单独状态但不误报当前健康故障', async () => withServer(false, async (baseUrl) => {
  const health = await (await fetch(`${baseUrl}/health`)).json()
  assert.equal(health.status, 'ok')
  assert.deepEqual(health.activityAudit, { total: 2, pending: 0, audited: 1, unavailableCount: 1 })
  assert.deepEqual(await (await fetch(`${baseUrl}/state/activity-audit`)).json(), { total: 2, pending: 0, audited: 1,
    unavailable: [{ taskId: 'old-task', reason: 'session-not-found' }] })
}, { overrides: { getActivityAuditStatus: () => ({ total: 2, pending: 0, audited: 1,
  unavailable: [{ taskId: 'old-task', reason: 'session-not-found' }] }) } }))

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

test('Host 原操作恢复固定路径身份且要求对账，模型字段不能覆盖作用域', async () => {
  const calls = []
  await withServer(false, async base => {
    const post = body => fetch(base + '/config/groups/g/topics/topic/decisions/d/operations/op/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post({ resolution: 'not-applied', reason: '已独立查询确认未应用' })).status, 202)
    assert.deepEqual(calls[0], { resolution: 'not-applied', reason: '已独立查询确认未应用', groupId: 'g', topicId: 'topic', decisionId: 'd', operationId: 'op' })
    for (const body of [{ resolution: 'not-applied' }, { resolution: 'unknown', reason: '不确定' }, { resolution: 'applied', reason: '覆盖', groupId: 'foreign' }]) assert.equal((await post(body)).status, 400)
    assert.equal(calls.length, 1)
    assert.equal((await post({ resolution: 'reconsider', reason: '零副作用，保留旧决策并重新判断' })).status, 202)
    assert.equal(calls[1].resolution, 'reconsider')
    assert.equal((await post({ resolution: 'applied', reason: '与账本矛盾' })).status, 409)
  }, { overrides: { retryDecisionOperation: async value => { if (value.resolution === 'applied') throw new Error('decision_recovery_evidence_conflict'); calls.push(value); return { status: 'completed' } } } })
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
    assert.deepEqual(projected.topicProgress, { total: 102, pending: 102, pendingRevisions: 204, pendingUnits: 0, unroutedMessages: 1 })
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

test('上下文只读 HTTP 路径完整传递分页与版本参数', async () => {
  const calls = []
  const record = name => async (...args) => { calls.push({ name, args }); return { ok: true } }
  await withServer(false, async base => {
    const paths = ['/state/workflows/run%3A1/trace?cursor=2&limit=3', '/state/workflows/topics/topic%3A1/context?cursor=4&limit=5&intentCursor=6&revision=7', '/state/workflows/run%3A1/evidence/source%3A1?cursor=8&limit=9&hash=abc', '/state/tasks/task%3A1/runs?cursor=10&limit=11', '/state/tasks/task%3A1/runs/run%3A1/nodes/node%3A1/output?ref=abc&cursor=12&limit=13&detailRevision=current']
    for (const path of paths) assert.equal((await fetch(base + path)).status, 200)
    assert.deepEqual(calls, [
      { name: 'trace', args: ['run:1', { offset: 2, limit: 3 }] },
      { name: 'topic', args: ['topic:1', { offset: 4, limit: 5, intentCursor: 6, expectedRevision: 7 }] },
      { name: 'evidence', args: ['run:1', 'source:1', { offset: 8, limit: 9, hash: 'abc' }] },
      { name: 'runs', args: ['task:1', { offset: 10, limit: 11 }] },
      { name: 'output', args: ['task:1', 'run:1', 'node:1', { offset: 12, limit: 13, outputRef: 'abc', detailRevision: 'current' }] },
    ])
  }, { overrides: { getWorkflowMessageTrace: record('trace'), getWorkflowTopicState: record('topic'), getWorkflowMessageEvidence: record('evidence'), getWorkflowTaskRuns: record('runs'), getWorkflowTaskNodeOutput: record('output') } })
})

test('当前任务详情与正文过期版本返回409，文档也不能绕过版本校验', async () => {
  const reject = code => async () => { throw Object.assign(new Error(code), { code }) }
  await withServer(false, async base => {
    assert.equal((await fetch(`${base}/state/tasks/t/detail`)).status, 409)
    for (const kind of ['output', 'document']) {
      const response = await fetch(`${base}/state/tasks/t/runs/r/nodes/n/${kind}?ref=old&detailRevision=old`)
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: 'TASK_OUTPUT_CHANGED' })
    }
  }, { overrides: { getWorkflowTaskDetail: reject('TASK_DETAIL_STALE'), getWorkflowTaskNodeOutput: reject('TASK_OUTPUT_CHANGED') } })
})

test('上下文只读 HTTP 对未启用接口和不存在资源返回404', async () => {
  const paths = ['/state/workflows/missing/trace', '/state/workflows/topics/missing/context', '/state/workflows/missing/evidence/missing', '/state/tasks/missing/runs', '/state/tasks/missing/runs/missing/nodes/missing/output']
  await withServer(false, async base => {
    for (const path of paths) assert.equal((await fetch(base + path)).status, 404, path)
  })
  await withServer(false, async base => {
    for (const path of paths) assert.equal((await fetch(base + path)).status, 404, path)
  }, { overrides: { getWorkflowMessageTrace: async () => null, getWorkflowTopicState: async () => null, getWorkflowMessageEvidence: async () => null, getWorkflowTaskRuns: async () => null, getWorkflowTaskNodeOutput: async () => null } })
})

test('节点文档下载沿用工件引用授权并以Markdown附件返回', async () => {
  await withServer(false, async base => {
    const response = await fetch(`${base}/state/tasks/task/runs/run/nodes/node/document?ref=ref`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/markdown/)
    assert.match(response.headers.get('content-disposition'), /attachment/)
    assert.equal(await response.text(), '# 修改方案\n真实文档')
  }, { overrides: { getWorkflowTaskNodeOutput: async (task, run, node, args) => {
    assert.deepEqual([task, run, node, args.document, args.outputRef], ['task', 'run', 'node', true, 'ref'])
    return { name: '修改方案.md', content: '# 修改方案\n真实文档' }
  } } })
})


test('新版任务归档HTTP仅接受空对象并转交正式工作流，不走旧版归档', async () => {
  const calls = []
  await withServer(false, async base => {
    const post = (body, origin = 'http://127.0.0.1:3080') => fetch(`${base}/tasks/current/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
    assert.equal((await post({}, 'https://evil.invalid')).status, 403)
    for (const body of [{ actorId: 'owner' }, { taskId: 'other' }, [], null, { reason: '测试' }])
      assert.equal((await post(body)).status, 400)
    const response = await post({}); assert.equal(response.status, 200)
    assert.equal((await response.json()).archivedAt, '2026-09-28T00:00:00.000Z')
    assert.deepEqual(calls, [{ action: 'archive', taskId: 'current' }])
  }, { overrides: { isWorkflowTask: async () => true,
    submitWorkflowTask: async request => { calls.push(request); return { taskId: request.taskId, archivedAt: '2026-09-28T00:00:00.000Z' } },
    archiveTask: () => { throw new Error('LEGACY_NOT_ALLOWED') } } })
})

test('Web 新任务验收入参接受 16/17/32/100 条并拒绝非法字段、空白、超长和非法类型', async () => {
  const received = []
  await withServer(false, async baseUrl => {
    const post = acceptanceCriteria => fetch(`${baseUrl}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'criteria-boundary', groupId: 'g', title: '验收边界', objective: '目标', context: '创建任务', acceptanceCriteria }) })
    for (const count of [16, 17, 32, 100]) {
      assert.equal((await post(Array.from({ length: count }, (_, i) => `条件 ${i}`))).status, 200)
      assert.equal(received.at(-1).acceptanceCriteria.length, count)
    }
    for (const value of [[], [' '], ['x'.repeat(2001)], [' '.repeat(2000) + 'x'], [42], null, '条件']) assert.equal((await post(value)).status, 400)
    assert.equal(received.length, 4)
  }, { overrides: { createTask: async value => { received.push(value); return { taskId: 'created' } } } })
})

test('只读问答重试仅接收本地精确来源与幂等键，不接受调用者scope',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const url=base+'/workflows/run/commands/answer/retry-readonly'
  const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
  const request={sourceVersion:3,retryKey:'fixed-scope',reason:'读取合同已修复'}
  assert.equal((await post(request,{origin:'https://untrusted.invalid'})).status,403)
  assert.equal((await post({...request,scope:{sourceKeys:['other']}})).status,400)
  assert.equal((await post(request)).status,202)
  assert.deepEqual(calls,[{...request,runId:'run',commandId:'answer'}])
 },{overrides:{retryWorkflowReadonlyAnswer:async value=>{calls.push(value);return{accepted:true}}}})
})

test('Owner恢复API仅接纳本地版本化系统修复请求，不接受新需求或会话',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const post=(body,headers={})=>fetch(base+'/tasks/t/retry-owner',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
  const request={retryKey:'fixed-reader',reason:'已修复引用反馈',expectedOwnerRevision:8,expectedLeaseEpoch:3,expectedRequirementRevision:1,expectedControlRevision:1,expectedLastFailure:'TASK_OWNER_NO_DECISION'}
  assert.equal((await post(request,{origin:'https://untrusted.invalid'})).status,403)
  assert.equal((await post({...request,requirement:{}})).status,400)
  assert.equal((await post({...request,sessionId:'replacement'})).status,400)
  assert.equal((await post(request)).status,202)
  assert.equal((await post({...request,expectedLastFailure:'UNKNOWN_FAILURE'})).status,400)
  assert.equal((await post({...request,expectedLastFailure:'ENGINEERING_REPOSITORY_SCOPE_MISMATCH'})).status,202)
  assert.deepEqual(calls,[{...request,taskId:'t'},{...request,taskId:'t',expectedLastFailure:'ENGINEERING_REPOSITORY_SCOPE_MISMATCH'}])
 },{overrides:{retryWorkflowOwner:async value=>{calls.push(value);return{accepted:true}}}})
})

test('只读调查恢复API拒绝外域和注入业务输入',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const post=(body,headers={})=>fetch(base+'/tasks/t/retry-investigation',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
  const request={retryKey:'fixed-scope',reason:'系统修复',runId:'r',nodeRunId:'n',generation:1,runRevision:0,inputDigest:'a'.repeat(64),requirementRevision:1,controlRevision:1,planRevision:1}
  assert.equal((await post(request,{origin:'https://untrusted.invalid'})).status,403)
  assert.equal((await post({...request,input:{scope:{sourceKeys:['other']}}})).status,400)
  assert.equal((await post(request)).status,202)
  assert.deepEqual(calls,[{...request,taskId:'t'}])
 },{overrides:{retryWorkflowInvestigation:async value=>{calls.push(value);return{accepted:true}}}})
})

test('授权投影修复API拒绝外域和新需求字段，确认身份只能由原来源绑定',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const post=(body,headers={})=>fetch(base+'/tasks/t/repair-stage-authorizations',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
  const request={repairKey:'projection',reason:'修复遗漏投影',expectedRequirementRevision:1,expectedRequirementRef:'old-ref',stageAuthorizations:[{workflowId:'task-data-change',sourceKey:'source',sourceVersion:1,sourceQuote:'验证后执行',objective:'执行',gate:'confirmation'}]}
  assert.equal((await post(request,{origin:'https://untrusted.invalid'})).status,403)
  assert.equal((await post({...request,objective:'新需求'})).status,400)
  assert.equal((await post({...request,stageAuthorizations:[{...request.stageAuthorizations[0],requiredActorId:'other'}]})).status,400)
  assert.equal((await post(request)).status,202)
  assert.deepEqual(calls,[{...request,taskId:'t'}])
 },{overrides:{repairWorkflowStageAuthorizations:async value=>{calls.push(value);return{accepted:true}}}})
})

test('只读Owner再评估API只接受本机CAS，不接受调用者材料或授权',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const post=(body,headers={})=>fetch(base+'/tasks/t/reassess-readonly',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
  const request={recoveryKey:'materials',reason:'系统范围已修复',expectedOwnerRevision:3,expectedLeaseEpoch:1,expectedRequirementRevision:1,expectedControlRevision:1}
  assert.equal((await post(request,{origin:'https://untrusted.invalid'})).status,403)
  for(const extra of [{materialAccess:{}},{sourceKeys:['other']},{requirementRef:'new'},{actorId:'owner'}])assert.equal((await post({...request,...extra})).status,400)
  assert.equal((await post(request)).status,202)
  assert.deepEqual(calls,[{...request,taskId:'t'}])
 },{overrides:{reassessWorkflowReadonly:async value=>{calls.push(value);return{accepted:true}}}})
})

test('删除Task接口强制本机身份和显式零写检查参数',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  const remove=(body,origin)=>fetch(base+'/tasks/t',{method:'DELETE',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
  assert.equal((await remove({expectedControlRevision:3,checkOnly:true},'https://untrusted.invalid')).status,403)
  assert.equal((await remove({expectedControlRevision:3,checkOnly:true,actorId:'other'})).status,409)
  for(const checkOnly of [true,false])assert.equal((await remove({expectedControlRevision:3,checkOnly})).status,200)
  assert.deepEqual(calls,[{taskId:'t',expectedControlRevision:3,checkOnly:true},{taskId:'t',expectedControlRevision:3,checkOnly:false}])
 },{overrides:{deleteWorkflowTask:async value=>{calls.push(value);return{taskId:value.taskId}}}})
})


test('审批重新投递入口拒绝外部Origin且保留明确未发送证明参数', async () => {
  const calls = []
  await withServer(false, async base => {
    const body = { noticeDigest: 'a'.repeat(64), proof: { kind: 'dws-uuid-rejected', traceId: 'synthetic-only' } }
    const post = origin => fetch(base + '/authorizations/request/reissue', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post('https://untrusted.invalid')).status, 403)
    assert.equal(calls.length, 0)
    assert.equal((await post('http://127.0.0.1:3080')).status, 200)
    assert.deepEqual(calls, [{ requestId: 'request', ...body }])
  }, { overrides: { reissueAuthorization: async input => { calls.push(input); return input } } })
})

test('历史话题CLI只检查不写入，apply核对digest并独立读回且不自动维护', async () => {
  const { reconcileTopic } = await import('../docs/acceptance/message-clarification-admission/scripts/reconcile-topic.mjs')
  const args = ['--source-topic', 'source', '--target-topic', 'target', '--title', '数据集导入导出开发', '--summary', '按文档开发并在过程中修复插件', '--reason', '修复确定的同事项历史归属']
  const calls = [], digest = 'a'.repeat(64)
  let active = true
  const request = async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: options.body && JSON.parse(options.body) })
    const value = url.pathname === '/runtime/maintenance' ? { active, maintenanceId: 'maintenance', revision: 3 }
      : url.pathname.endsWith('/check') ? { expectedDigest: digest }
        : url.pathname === '/runtime/topics/reconcile' ? { sourceTopicId: 'source', targetTopicId: 'target' }
          : { topicId: 'target', current: { topicTitle: '数据集导入导出开发' } }
    return new Response(JSON.stringify(value), { status: 200 })
  }
  assert.deepEqual(await reconcileTopic([...args, '--check'], request), { expectedDigest: digest })
  assert.deepEqual(calls.map(item => item.path), ['/runtime/maintenance', '/runtime/topics/reconcile/check'])
  assert.equal(calls[1].body.maintenanceRevision, 3)
  calls.length = 0
  await assert.rejects(reconcileTopic([...args, '--apply'], request), /expected-digest/)
  assert.equal(calls.length, 0)
  await assert.rejects(reconcileTopic([...args, '--apply', '--expected-digest', 'b'.repeat(64), '--request-id', 'one'], request), /摘要已变化/)
  assert.ok(calls.every(item => item.path !== '/runtime/topics/reconcile'))
  calls.length = 0
  const applied = await reconcileTopic([...args, '--apply', '--expected-digest', digest, '--request-id', 'one'], request)
  assert.equal(applied.target.topicId, 'target')
  assert.deepEqual(calls.map(item => item.path), ['/runtime/maintenance', '/runtime/topics/reconcile/check', '/runtime/topics/reconcile', '/state/workflows/topics/target/context'])
  assert.equal(calls[2].body.requestId, 'one')
  calls.length = 0; active = false
  await assert.rejects(reconcileTopic([...args, '--check'], request), /不会自动进入维护/)
  assert.deepEqual(calls.map(item => item.path), ['/runtime/maintenance'])
  await assert.rejects(reconcileTopic([...args, '--check', '--endpoint', 'http://example.com'], request), /本机回环/)
})


test('通知操作拒绝非本机连接且不进入受管方法',async()=>{
 for(const path of ['/workflows/notifications/operations','/workflows/notifications/operations/op/execute','/workflows/notifications/operations/op/reconcile']){
  let status,payload,calls=0
  const response={setHeader(){},writeHead(code){status=code},end(body){payload=JSON.parse(body)}}
  const forbidden=async()=>{calls++;throw new Error('must not invoke')}
  await handleRequest({method:'POST',url:path,headers:{},socket:{remoteAddress:'192.0.2.1'}},response,{
   prepareWorkflowNotificationOperation:forbidden,executeWorkflowNotificationOperation:forbidden,reconcileWorkflowNotificationOperation:forbidden})
  assert.equal(status,403);assert.equal(payload.error,'workflow_local_identity_required');assert.equal(calls,0)
 }
})

test('受管澄清来源恢复严格转交持久来源身份，区分预检与执行', async () => {
  const calls = []
  const input = { targetRunId: 'target', requestId: 'question', answerRunId: 'answer-source', commandId: 'command',
    recoveryKey: 'recovery', reason: '恢复已存在的用户回答来源', dryRun: true, maintenanceId: 'maintenance', maintenanceRevision: 4 }
  await withServer(false, async base => {
    const post = (body, origin = 'http://localhost:3080') => fetch(base + '/workflows/clarifications/recover', {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
    const checked = await post(input)
    assert.equal(checked.status, 200)
    assert.deepEqual(await checked.json(), { expectedDigest: 'a'.repeat(64) })
    const apply = { ...input, dryRun: false, expectedDigest: 'a'.repeat(64) }
    const applied = await post(apply)
    assert.equal(applied.status, 202)
    assert.deepEqual(await applied.json(), { accepted: true })
    assert.deepEqual(calls, [input, apply])
    for (const extra of [{ actorId: 'forged' }, { answer: '伪造答案' }, { evidenceRef: 'forged' }]) {
      assert.equal((await post({ ...input, ...extra })).status, 400)
    }
    for (const invalid of [{ dryRun: 'true' }, { maintenanceRevision: 1.5 }, { expectedDigest: 'not-digest' }]) {
      assert.equal((await post({ ...input, ...invalid })).status, 400)
    }
    assert.equal((await post(input, 'https://untrusted.example')).status, 403)
    assert.equal(calls.length, 2)
  }, { overrides: { recoverWorkflowClarification: async value => {
    calls.push(value)
    return value.dryRun ? { expectedDigest: 'a'.repeat(64) } : { accepted: true }
  } } })
})

test('受管澄清来源恢复拒绝非本机连接，不调用Host', async () => {
  let status, calls = 0
  const response = { setHeader() {}, writeHead(code) { status = code }, end() {} }
  await handleRequest({ method: 'POST', url: '/workflows/clarifications/recover', headers: {}, socket: { remoteAddress: '192.0.2.1' } }, response, {
    recoverWorkflowClarification: async () => { calls++; throw new Error('must not invoke') },
  })
  assert.equal(status, 403)
  assert.equal(calls, 0)
})

test('正式暂停恢复HTTP仅接受本机配置身份和控制版本',async()=>{
 const calls=[]
 await withServer(false,async base=>{
  for(const action of ['pause','resume']){
   const body={requestId:action,reason:'用户要求',expectedControlRevision:1}
   assert.equal((await fetch(`${base}/tasks/task-1/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,202)
   assert.equal((await fetch(`${base}/tasks/task-1/${action}`,{method:'POST',headers:{'content-type':'application/json',origin:'https://other.invalid'},body:JSON.stringify(body)})).status,403)
   assert.equal((await fetch(`${base}/tasks/task-1/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,actorId:'owner'})})).status,400)
  }
 },{overrides:{isWorkflowTask:async()=>true,submitWorkflowTask:async value=>{calls.push(value);return{accepted:true}}}})
 assert.deepEqual(calls.map(x=>x.action),['pause','resume'])
})
