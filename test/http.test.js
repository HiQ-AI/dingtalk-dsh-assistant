import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

// fetch会重写Host；用原生HTTP请求验证服务器收到的真实Host边界。
const rawRequest = (url, options = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(url, options, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  })
  request.on('error', reject)
  request.end(options.body)
})

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

test('旧话题关联修复入口全部410，预检、执行与身份变体均不能恢复旧服务', async () => {
  const calls = [], input = { sourceTopicId: 'source', targetTopicId: 'target',
    topicPresentation: { title: '数据集导入导出开发', summary: '依据已提供规则文档开发。' },
    maintenanceId: 'maintenance', maintenanceRevision: 2, reason: '用户明确四条消息属于同一事项' }
  await withServer(false, async base => {
    const post = (suffix, body, origin) => fetch(base + '/runtime/topics/reconcile' + suffix, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post('/check', input)).status, 410)
    assert.equal((await post('', { ...input, requestId: 'apply', expectedDigest: 'a'.repeat(64) })).status, 410)
    assert.equal(calls.length, 0)
    assert.equal((await post('/check', input, 'https://untrusted.example')).status, 410)
    assert.equal((await post('/check', { ...input, actorId: 'owner' })).status, 410)
    assert.equal((await post('', { ...input, requestId: 'apply' })).status, 410)
    assert.equal(calls.length, 0)
  }, { overrides: { reconcileWorkflowTopic: async (value, check) => { calls.push({ value, check }); return { checked: true } } } })
})

test('消息列表投影当前版本首个完成判断原文与时间，后续话题更新和通知不延长历时', async () => {
  const sent='2026-10-15T00:00:00Z',done='2026-10-15T00:01:23Z',later='2026-10-16T00:00:00Z'
  const group={groupId:'g',messages:[{messageId:'m',messageVersion:2,text:'资料',occurredAt:sent,routingStatus:'routed'},
    {messageId:'ignored',messageVersion:1,text:'谢谢',occurredAt:sent,routingStatus:'routed',ignoredRanges:[{reason:'日常闲聊，无具体事项'}],agentDeliveryStatus:'delivered',agentDeliveryAt:done},
    {messageId:'pending',messageVersion:1,text:'待处理',occurredAt:sent,routingStatus:'pending'},
    {messageId:'history',messageVersion:1,text:'历史',occurredAt:sent,routingStatus:'routed'}],outbox:[]}
  const topic={topicId:'t',revision:5,processedRevision:5,updatedAt:later,entries:[{messageId:'m',messageVersion:1,revision:1,action:'add'}, {messageId:'m',messageVersion:2,revision:3,action:'add'}],
    decisions:[{revision:1,status:'completed',updatedAt:sent,decision:{reason:'旧版本判断'}},
      {revision:3,status:'completed',updatedAt:done,decision:{reason:'本条资料无需进一步处理'}},
      {revision:5,status:'completed',updatedAt:later,decision:{reply:'后续判断不覆盖'}}]}
  const topics=[topic]
  await withServer(false,async base=>{
    const read=async()=>(await(await fetch(base+'/state/groups')).json())[0].messages
    const rows=await read(),row=rows.find(m=>m.messageId==='m')
    assert.equal(row.processingConclusion,'本条资料无需进一步处理');assert.equal(row.processingCompletedAt,new Date(done).toISOString());assert.equal(row.processingSentAt,sent)
    assert.equal(rows.find(m=>m.messageId==='ignored').processingConclusion,'日常闲聊，无具体事项')
    assert.equal(rows.find(m=>m.messageId==='ignored').processingCompletedAt,done)
    for(const id of ['pending','history'])assert.equal(rows.find(m=>m.messageId===id).processingCompletedAt,null)
    group.outbox.push({outboundId:'notification',deliveredAt:later});topic.updatedAt=later
    assert.deepEqual((await read()).find(m=>m.messageId==='m'),row)
    topic.decisions[1].decision={reply:'判断时的确认原文'}
    assert.equal((await read()).find(m=>m.messageId==='m').processingConclusion,'判断时的确认原文')
    topic.decisions[1].updatedAt=undefined
    assert.equal((await read()).find(m=>m.messageId==='m').processingCompletedAt,null)
    topic.processedRevision=2
    assert.equal((await read()).find(m=>m.messageId==='m').processingConclusion,null)
    topic.processedRevision=5;topic.decisions[1].updatedAt=done
    topics.push({...topic,topicId:'second',entries:[{messageId:'m',messageVersion:2,revision:1,action:'add'}],decisions:[{revision:1,status:'completed',updatedAt:'2026-10-15T00:02:00Z',decision:{reason:'另一事项的判断原文'}}]})
    const combined=(await read()).find(m=>m.messageId==='m')
    assert.equal(combined.processingConclusion,'判断时的确认原文；另一事项的判断原文')
    assert.equal(combined.processingCompletedAt,'2026-10-15T00:02:00.000Z')
  },{overrides:{listGroups:()=>[group],getGroup:()=>group,listTopics:()=>topics}})
})

test('任务列表保留任务会话投影，不再合成固定阶段进度', async () => {
  const task = { taskId: 't', engine: 'task-session', session: { sessionId: 's' }, executions: [{ executionId: 'e', status: 'running' }] }
  await withServer(false, async base => {
    assert.deepEqual(await (await fetch(base + '/state/tasks')).json(), [task])
    for (const path of ['/state/workflows', '/state/workflows/catalog']) assert.equal((await fetch(base + path)).status, 410)
  }, { overrides: { listTaskView: async () => [task] } })
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

test('控制账失效时健康状态降级并保留首因，不能只看群桥', async () => withServer(false, async base => {
  const response = await fetch(`${base}/health`), result = await response.json()
  assert.equal(result.dwsBridge.healthy, true)
  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.executionStore, { healthy: false, failure: { code: 'ERR_SQLITE_ERROR', sqliteCode: 13, kind: 'run.stop' } })
}, { transport: 'dws', overrides: { getWorkflowExecutionHealth: () => ({ healthy: false, failure: { code: 'ERR_SQLITE_ERROR', sqliteCode: 13, kind: 'run.stop' } }) } }))

test('已移除的任务表格同步接口在生产和测试模式均返回404', async () => {
  for (const testApiEnabled of [false, true]) await withServer(testApiEnabled, async (baseUrl) => {
    for (const [method, path] of [['GET', '/state/task-sheet-sync'], ['POST', '/task-sheet-sync/check'], ['PUT', '/config/task-sheet-sync'], ['POST', '/task-sheet-sync/run']]) {
      const response = await fetch(`${baseUrl}${path}`, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, documentUrl: 'https://alidocs.dingtalk.com/i/nodes/node', sheetId: 's1' }) }) })
      assert.equal(response.status, 404, `${method} ${path}`)
      assert.deepEqual(await response.json(), { error: 'not_found' })
    }
  })
})

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
  assert.deepEqual(await (await fetch(`${baseUrl}/state/version`)).json(), { currentVersion: '0.4.0', latestVersion: null, updateAvailable: false })
  assert.equal((await fetch(`${baseUrl}/config/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceDir: 'D:\\baibu-agent' }) })).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proxyUrl: 'http://127.0.0.1:10808' }) })).status, 200)
  assert.equal((await fetch(`${baseUrl}/config/groups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: 'g', responsibility: 'r' }) })).status, 200)
  const archived = await fetch(`${baseUrl}/tasks/task-1/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(archived.status, 410)
  const cancelled = await fetch(`${baseUrl}/tasks/task-2/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'cancel-1', reason: '误建任务', expectedControlRevision: 1 }) })
  assert.deepEqual(await cancelled.json(), { taskId: 'task-2', state: 'completed', completion: '已取消：误建任务' })
  const reopened = await fetch(`${baseUrl}/tasks/task-1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'web-reopen-1', context: '继续修复', objective: '修复并部署 UAT2', topicRefs: [{ topicId: 'topic-1', revision: 2 }], inputVersion: 1, runSequence: 1 }) })
  assert.equal(reopened.status, 410)
  const approval = await fetch(`${baseUrl}/authorizations/blocker-1/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved', comment: '页面批准' }) })
  assert.equal(approval.status, 410)
  const reissued = await fetch(`${baseUrl}/authorizations/blocker-1/reissue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '迁移到统一授权审批' }) })
  assert.equal(reissued.status, 410)
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

test('历史任务报告仅可读取，显式恢复入口已退役', async () => {
  const calls = []
  await withServer(false, async base => {
    const report = await (await fetch(base + '/tasks/task-1/reports/submission-1')).json()
    assert.deepEqual(report, { taskId: 'task-1', submissionId: 'submission-1' })
    for (const path of ['/tasks/task-1/reports/submission-1/retry', '/tasks/task-1/notifications/n/retry', '/tasks/task-1/notifications/n/send-completion', '/tasks/task-1/information-wait-notice']) assert.equal((await fetch(base + path, { method: 'POST', body: '{}' })).status, 410)
    assert.equal(calls.length, 1)
  }, { overrides: { getTaskReport: async value => { calls.push(value); return value }, retryTaskReport: () => { throw Error('must not recover history') } } })
})

test('旧话题操作恢复统一410，任何参数均不能绕过清退', async () => {
  const calls = []
  await withServer(false, async base => {
    const post = body => fetch(base + '/config/groups/g/topics/topic/decisions/d/operations/op/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post({ resolution: 'not-applied', reason: '已独立查询确认未应用' })).status, 410)
    for (const body of [{ resolution: 'not-applied' }, { resolution: 'unknown', reason: '不确定' }, { resolution: 'applied', reason: '覆盖', groupId: 'foreign' }]) assert.equal((await post(body)).status, 410)
    assert.equal(calls.length, 0)
    assert.equal((await post({ resolution: 'reconsider', reason: '零副作用，保留旧决策并重新判断' })).status, 410)
    assert.equal((await post({ resolution: 'applied', reason: '与账本矛盾' })).status, 410)
  }, { overrides: { retryDecisionOperation: async value => { if (value.resolution === 'applied') throw new Error('decision_recovery_evidence_conflict'); calls.push(value); return { status: 'completed' } } } })
})

test('Web Task 入口强制稳定请求与执行版本且拒绝伪造来源和Session', async () => {
  const calls = []
  const update = { requestId: 'web-1', context: '只处理本月', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: 1 }
  await withServer(false, async (baseUrl) => {
    const post = (path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/tasks', { requestId: 'create-1', groupId: 'g', title: '数据导出', objective: '导出本月', context: '请导出本月数据', acceptanceCriteria: ['文件可读'] })).status, 200)
    assert.equal(calls[0].topicRefs, undefined)
    assert.equal((await post('/tasks/task-1/context', update)).status, 200)
    assert.equal(calls[1].taskId, 'task-1')
    assert.equal(calls[1].expectedRequirementRevision, 1)
    assert.equal((await post('/tasks/task-1/reopen', update)).status, 410)
    for (const extra of [{ childSessionId: 'other-session' }, { taskId: 'other-task' }, { sourceKind: 'dingtalk' }, { sourceMessageId: 'fake-message' }]) assert.equal((await post('/tasks/task-1/context', { ...update, ...extra })).status, 400)
    for (const field of ['requestId', 'context', 'progressImpact', 'expectedRequirementRevision', 'expectedControlRevision']) {
      const invalid = { ...update }; delete invalid[field]
      assert.equal((await post('/tasks/task-1/context', invalid)).status, 400)
    }
    assert.equal(calls.length, 2)
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
    const post = () => fetch(`${baseUrl}/tasks/task-1/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r1', context: '补充', progressImpact: 'preserve', expectedRequirementRevision: 1, expectedControlRevision: 1 }) })
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
    assert.deepEqual(projected.messages, [{ ...group.messages[0], processingConclusion: null, processingCompletedAt: null, processingSentAt: null, topicRefs: [{ topicId: 'topic-0', revision: 3, title: '话题 0' }] }])
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


test('Web 新任务验收入参接受 16/17/32/100 条并接受长文本且拒绝空白和非法类型', async () => {
  const received = []
  await withServer(false, async baseUrl => {
    const post = acceptanceCriteria => fetch(`${baseUrl}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'criteria-boundary', groupId: 'g', title: '验收边界', objective: '目标', context: '创建任务', acceptanceCriteria }) })
    for (const count of [16, 17, 32, 100]) {
      assert.equal((await post(Array.from({ length: count }, (_, i) => `条件 ${i}`))).status, 200)
      assert.equal(received.at(-1).acceptanceCriteria.length, count)
    }
    assert.equal((await post([])).status, 200)
    for (const value of [[' '], [42], null, '条件']) assert.equal((await post(value)).status, 400)
    assert.equal((await post(['x'.repeat(2001)])).status, 400)
    assert.equal(received.length, 5)
  }, { overrides: { createTask: async value => { received.push(value); return { taskId: 'created' } } } })
})

test('旧人工介入decision和reissue退役，不能批准新执行', async () => {
  await withServer(false, async base => {
    for (const action of ['decision', 'reissue']) assert.equal((await fetch(base + `/authorizations/old/${action}`, { method: 'POST', body: '{}' })).status, 410)
  }, { overrides: { decideAuthorization: () => { throw Error('old authority must not run') }, reissueAuthorization: () => { throw Error('old authority must not run') } } })
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


test('退役工作流配置和固定执行入口统一410且不调用任何旧服务', async () => {
  const retired = ['/runtime/topics/reconcile', '/runtime/topics/reconcile/check', '/runtime/maintenance/seal', '/runtime/maintenance/resume', '/config/groups/g/topics/t/decisions/d/operations/o/retry', '/config/groups/g/coordination/r/retry', '/workflows/message/requests/question/answer', '/workflows/message/reprocess', '/workflows/notifications/operations', '/workflows/clarifications/recover', '/config/workflow-variables', '/config/workflow-variables/secret', '/config/workflow-variables/secret/enabled', '/config/workflow-bindings/template', '/state/workflows', '/state/workflows/catalog', '/runtime/execution-purge', '/runtime/maintenance/task-run', '/runtime/maintenance/tasks/t/completed-observations',
    ...['reset-execution', 'prepare-purged-run', 'rerun', 'execution-control', 'review-delivery', 'confirm-completion', 'confirm-stage', 'retry-investigation', 'handoff-data-change-approval', 'maintenance-constraint', 'reassess-readonly', 'repair-stage-authorizations', 'retire-prepared-effect', 'retry-owner', 'reissue-repository', 'reopen', 'pause', 'resume', 'archive', 'title'].map(action => `/tasks/t/${action}`)]
  let calls = 0
  await withServer(false, async base => {
    for (const path of retired) for (const method of ['GET', 'POST', 'PUT', 'DELETE']) for (const origin of [undefined, 'http://127.0.0.1:3080', 'https://foreign.invalid']) {
      const response = await fetch(base + path, { method, headers: origin ? { origin } : {}, ...(method === 'GET' ? {} : { body: '{"actorId":"forged","value":"must-not-echo-secret"}' }) })
      assert.equal(response.status, 410, `${method} ${path}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /must-not-echo-secret/)
    }
    assert.equal((await fetch(base + '/tasks/t', { method: 'DELETE' })).status, 410)
    assert.equal(calls, 0)
  }, { overrides: Object.fromEntries(['reconcileWorkflowTopic', 'changeWorkflowMaintenance', 'sealWorkflowMaintenance', 'resumeWorkflowMaintenance', 'retryDecisionOperation', 'retryCoordinationRequest', 'getWorkflowConfiguration', 'saveWorkflowVariable', 'bindWorkflowConfiguration', 'getWorkflowState', 'getWorkflowCatalog', 'submitWorkflowTask', 'deleteWorkflowTask', 'controlWorkflowTaskExecution'].map(name => [name, () => { calls++; throw Error('retired path reached') }])) })
})

test('任务会话详情与分页执行直接读取新服务，历史fallback明确只读', async () => {
  const calls = []
  const detail = { taskId: 'live', session: { sessionId: 'session-live', workspaceDir: '/tasks/live', logPath: '/tasks/live/session.jsonl' }, executions: [], requirementRevision: 2, controlRevision: 3, controlState: 'active', result: { summary: '已核对', evidence: ['evidence.md'], limitations: [] } }
  await withServer(false, async base => {
    assert.deepEqual(await (await fetch(base + '/state/tasks/live/detail')).json(), detail)
    const page = await (await fetch(base + '/state/tasks/live/executions?offset=20&limit=10')).json()
    assert.equal(page.executions[0].executionId, 'e21')
    assert.deepEqual(calls, [{ id: 'live', options: { offset: 20, limit: 10 } }])
    assert.equal((await fetch(base + '/state/tasks/live/executions?limit=101')).status, 400)
    const legacy = await (await fetch(base + '/state/tasks/old/detail')).json()
    assert.equal(legacy.legacyReadonly, true)
    assert.equal((await fetch(base + '/state/tasks/missing/detail')).status, 404)
  }, { overrides: { getTaskSessionDetail: async id => id === 'live' ? detail : undefined,
    getTaskSessionExecutions: async (id, options) => { calls.push({ id, options }); return { executions: [{ executionId: 'e21', objective: '核对文件', status: 'running', sessionId: 'execution-session', workspaceDir: '/execution/e21', logPath: '/execution/e21/session.jsonl', requirementRevision: 2 }], total: 25, ...options } },
    getWorkflowTaskDetail: async id => id === 'old' ? { taskId: 'old', state: 'completed', result: '历史结果' } : undefined } })
})

test('新任务只接受目标资料与普通验收要求，拒绝模板运行快照及伪造会话身份', async () => {
  const calls = []
  await withServer(false, async base => {
    const body = { requestId: 'create-task', groupId: 'g', title: '检查服务', objective: '核对运行状态' }
    const post = (value, headers = {}) => fetch(base + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
    assert.equal((await post(body)).status, 200)
    assert.equal((await post({ ...body, context: '资料不是授权', acceptanceCriteria: ['状态可查'] })).status, 200)
    for (const extra of [{ workflowId: 'task-general' }, { stages: ['prepare', 'execute'] }, { stageTasks: ['执行'] }, { runSequence: 1 }, { configurationSnapshot: {} }, { sessionId: 'forged' }, { actorId: 'forged' }]) assert.equal((await post({ ...body, ...extra })).status, 400)
    for (const headers of [{ origin: 'https://other.example' }, { origin: 'null' }]) assert.equal((await post(body, headers)).status, 403)
    assert.equal((await rawRequest(base + '/tasks', { method: 'POST', headers: { host: 'other.example', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403)
    assert.equal(calls.length, 2)
  }, { overrides: { createTask: async value => { calls.push(value); return { taskId: 'new-task', session: { sessionId: 's' } } } } })
})

test('任务修订和取消携带CAS版本，路径身份不可覆盖，历史任务不可操作', async () => {
  const calls = []
  await withServer(false, async base => {
    const post = (id, action, value) => fetch(base + `/tasks/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    const revision = { requestId: 'revise', context: '补充实际限制', progressImpact: 'replan', expectedRequirementRevision: 2, expectedControlRevision: 3 }
    const cancel = { requestId: 'cancel', reason: '不再需要', expectedControlRevision: 3 }
    assert.equal((await post('live', 'context', revision)).status, 200)
    assert.equal((await post('live', 'cancel', cancel)).status, 200)
    assert.deepEqual(calls.map(value => value.taskId), ['live', 'live'])
    for (const action of ['context', 'cancel']) {
      const body = action === 'context' ? revision : cancel
      assert.equal((await post('old', action, body)).status, 410)
      assert.equal((await post('live', action, { ...body, taskId: 'another' })).status, 400)
      assert.equal((await post('live', action, { ...body, expectedControlRevision: 1 })).status, 409)
    }
    assert.equal(calls.length, 2)
  }, { overrides: { getTaskSessionDetail: async id => ({ taskId: id, legacyReadonly: id === 'old' }),
    appendTaskContext: async value => { if (value.expectedControlRevision !== 3) throw Error('TASK_CONTROL_REVISION_CONFLICT'); calls.push(value); return value },
    cancelTask: async value => { if (value.expectedControlRevision !== 3) throw Error('TASK_CONTROL_REVISION_CONFLICT'); calls.push(value); return value } } })
})

test('Agent设置不再读取或修改流程提示词，但保留连接配置', async () => {
  const calls = []
  await withServer(false, async base => {
    assert.deepEqual(await (await fetch(base + '/state/agent-config')).json(), { model: 'test', proxyUrl: 'http://localhost:1080' })
    for (const field of ['taskPrompts', 'taskPromptsVersion', 'leafSessionPrompt', 'workflowBindings', 'workflowVariables']) {
      const response = await fetch(base + '/config/agent', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: 'retired' }) })
      assert.equal(response.status, 410)
    }
    assert.equal(calls.length, 0)
  }, { overrides: { getAgentConfig: () => ({ model: 'test', proxyUrl: 'http://localhost:1080', taskPrompts: ['old'], taskPromptsVersion: 2, leafSessionPrompt: 'old' }), updateAgentConfig: value => calls.push(value) } })
})

test('新任务写入拒绝远程连接，即使Origin和Host声称本机也不触发服务', async () => {
  for (const path of ['/tasks', '/tasks/t/context', '/tasks/t/cancel']) {
    let status, body, called = 0
    const response = { setHeader() {}, writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } }
    await handleRequest({ method: 'POST', url: path, headers: { host: '127.0.0.1:18998', origin: 'http://127.0.0.1:3080' }, socket: { remoteAddress: '192.0.2.7', localPort: 18998 } }, response,
      { createTask: () => called++, appendTaskContext: () => called++, cancelTask: () => called++ })
    assert.equal(status, 403)
    assert.equal(body.error, 'TASK_LOCAL_IDENTITY_REQUIRED')
    assert.equal(called, 0)
  }
})


test('历史维护仅允许受信只读GET，旧test动作无旁路而inbound仍由testApi开关保护', async () => {
  let writes = 0, inbound = 0
  const blocked = () => { writes++; throw Error('retired write invoked') }
  const overrides = { getWorkflowMaintenance: () => ({ active: true, revision: 4 }), changeWorkflowMaintenance: blocked,
    createTask: blocked, waitTask: blocked, resumeTask: blocked, followupTask: blocked, submitTaskResult: blocked,
    ingest: async () => { inbound++; return { received: true } } }
  for (const enabled of [false, true]) await withServer(enabled, async base => {
    const maintenance = await fetch(base + '/runtime/maintenance')
    assert.equal(maintenance.status, 200)
    assert.deepEqual(await maintenance.json(), { active: true, revision: 4, legacyReadonly: true })
    assert.equal((await fetch(base + '/runtime/maintenance', { headers: { origin: 'https://foreign.invalid' } })).status, 403)
    for (const origin of [undefined, 'http://127.0.0.1:3080', 'https://foreign.invalid']) {
      const options = { method: 'POST', headers: origin ? { origin } : {}, body: '{"actorId":"forged"}' }
      assert.equal((await fetch(base + '/runtime/maintenance', options)).status, 410)
      for (const action of ['', '/wait', '/resume', '/followup', '/result']) {
        assert.equal((await fetch(base + '/test/tasks' + action, options)).status, enabled ? 410 : 404)
      }
    }
    assert.equal((await fetch(base + '/test/inbound', { method: 'POST', body: '{}' })).status, enabled ? 200 : 404)
  }, { overrides })
  assert.equal(writes, 0)
  assert.equal(inbound, 1)
})

test('current task archive checks local identity, strict body, legacy protection and conflict feedback', async () => {
  let writes = 0
  await withServer(false, async base => {
    const post = (body, headers = {}) => fetch(`${base}/tasks/current/archive`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const origin = 'http://127.0.0.1:3080'
    const preflight = await fetch(`${base}/tasks/current/archive`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/)
    assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/)
    assert.equal(writes, 0)
    assert.equal((await post({}, { origin: 'https://untrusted.example' })).status, 403)
    assert.equal((await post({ actorId: 'spoof' })).status, 400)
    assert.equal(writes, 0)
    assert.equal((await fetch(`${base}/tasks/legacy/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 410)
    const success = await post({}, { origin }); assert.equal(success.status, 200); assert.ok((await success.json()).archivedAt)
    assert.equal(writes, 1)
  }, { overrides: { isTaskSessionMode: () => true, getTaskSessionDetail: async id => ({ legacyReadonly: id === 'legacy' }), archiveTask: async ({ taskId }) => { writes++; return { taskId, archivedAt: '2026-10-15T00:00:00Z' } } } })
  await withServer(false, async base => {
    const response = await fetch(`${base}/tasks/live/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT')
  }, { overrides: { isTaskSessionMode: () => true, getTaskSessionDetail: async () => ({}), archiveTask: async () => { throw new Error('DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT') } } })
})
