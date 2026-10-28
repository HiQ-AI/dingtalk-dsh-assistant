import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, waitUntil, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { requestSystemText, findSessionLog } from './fixtures/session-persistence.js'
const call = (name, args) => ({ name, args })
const requestHuman = (audience = 'operator') => call('task_request_human', { audience, reason: '目标环境尚未明确，不能自行扩大授权', question: '请明确本次允许的环境和操作范围', evidence: ['已读取原始交办'], attemptedActions: ['核对现有需求，未执行外部修改'] })
const finish = summary => call('task_session_submit', { decision: { action: 'complete', summary, evidence: ['已核对人工原文和原执行结果'], limitations: [] } })
function completionReviews() {
  const read = new Set(); let delegated = false
  const roles = ['独立核对原交办范围', '独立核对人工答复']
  const wait = () => call('task_session_submit', { decision: { action: 'wait', summary: '已安排按原文核对范围，等待结果', evidence: [], limitations: [] } })
  return {
    execution(input) {
      const index = roles.indexOf(input.objective)
      if (index < 0) return null
      const path = index === 0 ? input.materialPaths[0] : input.materialPaths.at(-1)
      assert.ok(path)
      if (!read.has(index)) { read.add(index); return [call('read', { file_path: path })] }
      return [call('execution_submit', { output: { status: 'completed', summary: `${roles[index]}已读取原始材料`, evidence: [path], limitations: [], artifacts: [] } })]
    },
    owner(input, summary) {
      if (!input.executions.every(item => item.status === 'succeeded' && item.drained)) return [wait()]
      if (input.executionCount >= 3) return [finish(summary)]
      if (delegated) return [wait()]
      delegated = true
      return [...roles.map((objective, index) => call('task_delegate', { key: `completion-review-${index}`, objective })), wait()]
    },
  }
}
async function fixture(t, decide, options) {
  const root = await mkdtemp(join(tmpdir(), 'task-human-native-'))
  const h = await nativeTaskHost(root, decide, options)
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return h
}
async function pending(h) { return (await h.service.listAuthorizationRequests()).find(item => item.status === 'waiting-reply') }

for (const failure of ['none', 'empty', 'tool-limit']) test(`群业务成员完整答复经只读复核解除，发起人无关消息不解除且不空转：${failure}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let original, topicId, resumed, reviewStep = 0
  const reviewLeases = [], answer = '测试助手，可以，但只允许 UAT2；点击编辑即持久化待提交，不能把变更延后到提交时。'
  const wait = summary => call('task_session_submit', { decision: { action: 'wait', summary, evidence: [], limitations: [] } })
  const h = await fixture(t, async request => {
    const incoming = latestInput(request)
    if (incoming.requestId?.startsWith('coord-title-')) return [call('group_topic_title_submit', { requestId: incoming.requestId, topicId: incoming.topicId, title: '核对编辑持久化方案' })]
    const names = request.tools.map(tool => tool.name), routed = topicTaskCalls(request)
    if (names.includes('group_topic_route_submit')) {
      for (const route of routed[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId }]
      return routed
    }
    if (names.includes('group_decision_submit')) {
      const review = modelToolValues(request).find(value => Array.isArray(value.candidates))
      if (!review) return [call('group_reply_review_get', { requestIds: [incoming.requestId] })]
      const args = routed[0].args
      args.decision.actions = [{ kind: 'task-context', taskId: original.taskId, inputVersion: original.requirementRevision,
        runSequence: original.runSequence, context: '业务已确认', progressImpact: 'preserve',
        topicRefs: [{ topicId: args.topicId, revision: args.revision }], basisUnitRefs: args.decision.basisUnitRefs }]
      args.decision.reply = incoming.messages.at(-1).text.includes('另外一件事')
        ? '已记录另一事项，原业务问题仍待答复。' : '已收到关于 UAT2 和编辑持久化条件的答复。'
      args.decision.replyReview = { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: review.candidates.map(item => item.outboundId), replaceOutboundIds: [] }
      return routed
    }
    if (routed) return routed
    const input = latestInput(request)
    if (!input.task.humanRequests.length) return [requestHuman('requester')]
    if (input.humanReview) {
      const source = input.sources.find(item => input.humanReview.sourceIds.includes(item.sourceId))
      assert.equal(input.task.humanRequests[0].status, 'waiting-reply')
      reviewLeases.push(input.humanReview.requestId)
      if (source.messageId === 'unrelated-owner') return [wait('原发起人说的是另一事项，未回答环境和编辑持久化条件，保留原问题')]
      assert.equal(source.actorId, 'business-responsible')
      assert.equal(source.text, answer, '完整限制不能被话题摘要代替')
      assert.match(requestSystemText(request), /真实作者的业务角色和权限/)
      if (failure === 'empty' && reviewStep++ === 0) return []
      if (failure === 'tool-limit') return [call('task_human_resolve', { requestId: input.humanReview.requestId,
        sourceId: 'forged-source', reason: '伪造来源必须拒绝', evidence: ['无效来源'] })]
      if (failure === 'none' && reviewStep++ === 0) return [call('task_delegate', { key: 'forbidden', objective: '不得提前执行' }),
        call('write', { file_path: join(h.root, 'forbidden.txt'), content: 'must not write' }), finish('不得提前完成')]
      if (failure === 'none') assert.match(JSON.stringify(request.messages), /task_human_review_read_only/)
      return [call('task_human_resolve', { requestId: input.humanReview.requestId, sourceId: source.sourceId,
        reason: '原任务明确该成员负责业务条件，答复对应待答问题并限定 UAT2 及点击编辑即持久化；未新增权限', evidence: [answer] }),
        call('task_delegate', { key: 'still-read-only', objective: '解除成功仍不能在复核轮执行' }),
        wait('已保存完整业务答复，等待下一统筹轮继续原任务')]
    }
    resumed = input
    return [wait('已在独立正常轮收到完整答复，按原目标及附加条件继续')]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'business-review', title: '编辑持久化核对', objective: '由业务负责人 business-responsible 确认编辑持久化方案，现有授权只在 UAT2 验证' })
  await h.service.whenIdle()
  original = await h.query('task.get', { taskId: created.taskId }); topicId = original.topicRefs[0].topicId
  await h.service.ingest({ groupId: 'native-group', messageId: 'unrelated-owner', senderOpenDingTalkId: 'native-user', text: '测试助手，另外一件事下周讨论', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const kept = await h.query('task.get', { taskId: original.taskId })
  assert.equal(kept.humanRequests[0].status, 'waiting-reply')
  assert.equal(kept.humanRequests.length, 1)
  assert.match(kept.lastDecision.summary, /未回答环境/)
  const count = h.requests.length
  await h.service.whenIdle()
  assert.equal(h.requests.length, count, '未回答问题时消费本次来源，不主动空转')
  await h.service.ingest({ groupId: 'native-group', messageId: 'business-answer', senderOpenDingTalkId: 'business-responsible', text: answer, occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  if (failure !== 'none') {
    const interrupted = await h.query('task.get', { taskId: original.taskId }), wakes = await h.query('wake.list', { taskId: original.taskId })
    assert.equal(interrupted.humanRequests[0].status, 'waiting-reply')
    assert.ok(wakes.some(item => item.kind === 'task.supplement' && item.state !== 'acked'))
    if (failure === 'tool-limit') {
      const recorded = interrupted.humanRequests[0].reviewFailures.at(-1)
      assert.equal(recorded.code, 'DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID')
      assert.equal(interrupted.providerRecovery, null)
      assert.deepEqual(interrupted.lastDecision.limitations, ['DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID'])
      const count = h.requests.length
      await h.service.recover(); await h.service.whenIdle()
      assert.equal(h.requests.length, count, '工具错误上限不冒充空返回自动重试')
      assert.equal((await h.query('execution.list')).length, 0)
      return
    }
    assert.equal(interrupted.providerRecovery.failure.code, 'TASK_SESSION_NO_SUBMISSION')
    await waitUntil(() => resumed, '空返回沿原会话在既有有界退避后重试', 15000)
    await h.service.whenIdle()
  }
  const after = await h.query('task.get', { taskId: original.taskId })
  assert.equal(after.humanRequests[0].status, 'answered')
  assert.equal(after.humanRequests[0].reply, answer)
  assert.ok(after.humanRequests[0].resolution.reason.includes('点击编辑即持久化'))
  assert.equal(after.sessionId, original.sessionId)
  assert.equal(after.requirementRevision, original.requirementRevision)
  assert.equal(after.controlRevision, original.controlRevision)
  assert.equal(after.humanRequests.length, 1)
  assert.equal(resumed.humanReview, undefined)
  assert.ok(resumed.wakes.some(item => item.kind === 'human.responded'))
  assert.equal(resumed.sources.find(item => item.actorId === 'business-responsible').text, answer)
  assert.equal((await h.query('execution.list')).length, 0, '复核工具无法派发执行')
  assert.equal((await h.query('operation.list')).length, 0, '复核没有写操作')
  if (failure === 'none') assert.match(JSON.stringify(h.toolResults.find(item => item.name === 'write')), /task_tool_outside_role/)
  const decisions = await h.query('task.decisions', { taskId: original.taskId })
  assert.ok(decisions.decisions.some(item => item.decision.summary.includes('未回答环境')))
  assert.ok(decisions.decisions.some(item => item.decision.summary.includes('已保存完整业务答复')))
  assert.ok(reviewLeases.length >= 2)
})

test('待实施批准期间事实追问立即引用回复，内部证据不外发且不恢复旧执行', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let original, topicId, reviewStep = 0
  const summary = '此前完成了 UPR 导入覆盖修复；当前点击编辑持久化只有方案，仍等你确认。'
  const wait = summary => call('task_session_submit', { decision: { action: 'wait', summary, evidence: [], limitations: [] } })
  const h = await fixture(t, async request => {
    const incoming = latestInput(request), names = request.tools.map(tool => tool.name), routed = topicTaskCalls(request)
    if (incoming.requestId?.startsWith('coord-title-')) return [call('group_topic_title_submit', { requestId: incoming.requestId, topicId: incoming.topicId, title: '核对编辑持久化方案' })]
    if (names.includes('group_topic_route_submit')) {
      for (const route of routed[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId }]
      return routed
    }
    if (names.includes('group_decision_submit')) {
      const review = modelToolValues(request).find(value => Array.isArray(value.candidates))
      if (!review) return [call('group_reply_review_get', { requestIds: [incoming.requestId] })]
      const args = routed[0].args
      args.decision.actions = [{ kind: 'task-context', taskId: original.taskId, inputVersion: original.requirementRevision,
        runSequence: original.runSequence, context: '追问此前已经实施的范围，未批准当前方案', progressImpact: 'preserve',
        topicRefs: [{ topicId: args.topicId, revision: args.revision }], basisUnitRefs: args.decision.basisUnitRefs }]
      args.decision.reply = '已收到，核对此前的实施记录。'
      args.decision.replyReview = { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: review.candidates.map(item => item.outboundId), replaceOutboundIds: [] }
      return routed
    }
    if (routed) return routed
    if (!names.includes('task_delegate')) return [call('execution_submit', { output: { status: 'completed', summary: '已核对此前 UPR 导入覆盖修复，当前编辑持久化仅提交方案。', evidence: ['既有提交与当前方案'], limitations: [], artifacts: [] } })]
    if (!incoming.task.humanRequests.length) {
      if (!incoming.executions.length) return [call('task_delegate', { key: 'original-review', objective: '核对此前已实施的范围' }), wait('等待实施范围核对结果')]
      return [requestHuman('requester')]
    }
    assert.ok(incoming.humanReview, '事实追问不得触发普通实施轮')
    const source = incoming.sources.find(item => incoming.humanReview.sourceIds.includes(item.sourceId))
    if (source.messageId === 'unrelated-followup') return [wait('这是另一事项，没有回答原方案确认，也无需向本追问发送实施结论')]
    assert.match(requestSystemText(request), /相关事实追问不是实施批准/)
    const executionId = incoming.executions[0].executionId
    const step = reviewStep++
    if (step === 0) return [call('task_execution_read', { executionId }),
      call('task_delegate', { executionId, key: 'forbidden-continuation', objective: '不得恢复实施' })]
    if (step === 1) return [call('model_content_read', { contentRef: modelToolValues(request).findLast(value => value.executionId === executionId && value.record?.contentRef).record.contentRef, path: '/result/payload/output/summary' })]
    assert.match(JSON.stringify(modelToolValues(request)), /此前 UPR 导入覆盖修复/)
    const decision = { action: 'wait', summary, replySourceId: source.sourceId, evidence: [`已读取原执行 ${executionId} 的结果`], limitations: [] }
    if (step === 2) return [call('task_session_submit', { decision: { ...decision, summary: `${summary} ${incoming.task.taskId}` } })]
    assert.match(JSON.stringify(request.messages), /GROUP_REPLY_INTERNAL_DETAILS/)
    return [call('task_session_submit', { decision })]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'fact-followup', title: '编辑持久化核对', objective: '核对当前方案，实施需要另行确认' })
  await h.service.whenIdle()
  original = await h.query('task.get', { taskId: created.taskId }); topicId = original.topicRefs[0].topicId
  const execution = (await h.query('execution.list'))[0]
  await h.service.ingest({ groupId: 'native-group', messageId: 'fact-question', senderOpenDingTalkId: 'native-user',
    text: '测试助手，方案没确认，你前面改动的是什么？', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const after = await h.query('task.get', { taskId: original.taskId })
  assert.equal(after.humanRequests[0].status, 'waiting-reply')
  assert.equal(after.humanRequests.length, 1)
  assert.equal(after.humanRequests[0].requestId, original.humanRequests[0].requestId)
  assert.equal(after.requirementRevision, original.requirementRevision)
  assert.equal(after.controlRevision, original.controlRevision)
  assert.equal(after.sessionId, original.sessionId)
  const replies = h.sent.filter(item => item.id.startsWith('human-followup:'))
  assert.equal(replies.length, 1)
  assert.equal(replies[0].payload.text, summary)
  assert.equal(replies[0].payload.replyToMessageId, 'fact-question')
  assert.deepEqual(replies[0].payload.atOpenDingTalkIds, ['native-user'])
  assert.ok(h.readbacks.some(item => item.id === replies[0].id))
  assert.equal((await h.query('notification.get', { notificationId: replies[0].id })).state, 'delivered')
  assert.match(after.lastDecision.evidence[0], new RegExp(execution.executionId))
  const saved = (await h.query('execution.list'))[0]
  assert.equal(saved.executionId, execution.executionId)
  assert.equal(saved.inputVersion, execution.inputVersion)
  assert.equal(saved.status, execution.status)
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal((await h.query('operation.list')).length, 0)
  assert.equal((await h.query('wake.list', { taskId: original.taskId })).filter(item => item.kind === 'human.responded').length, 0)
  assert.match(JSON.stringify(h.toolResults.filter(item => item.name === 'task_delegate')), /task_human_review_read_only/)
  await h.service.ingest({ groupId: 'native-group', messageId: 'unrelated-followup', senderOpenDingTalkId: 'native-user',
    text: '测试助手，另外一件事下周再聊', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  assert.equal(h.sent.filter(item => item.id.startsWith('human-followup:')).length, 1, '无关来源只记录判断，不发送事实答复')
  const count = h.requests.length
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, count, '完成的事实追问不反复处理')
  assert.equal((await h.query('task.get', { taskId: original.taskId })).humanRequests[0].status, 'waiting-reply')
})

for (const batched of [true, false]) test(`积压的两条事实追问均送达且无关来源不空转：同一唤醒=${batched}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const reviewed = [], sourceIds = ['batch-first', 'batch-second', 'batch-unrelated']
  const h = await fixture(t, async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const input = latestInput(request)
    if (!input.task.humanRequests.length) return [requestHuman('requester')]
    assert.ok(input.humanReview, '未答原问题时只允许事实核对')
    reviewed.push(input.humanReview.sourceIds)
    const sourceId = input.humanReview.sourceIds[0]
    const decision = { action: 'wait', summary: sourceId === sourceIds[0] ? '第一项目前只完成只读排查，仍待方案确认。'
      : sourceId === sourceIds[1] ? '第二项已查到既有实现，本轮尚未实施变更。' : '该条与原问题无关，保留原待答问题。',
      evidence: ['已核对当前待答问题和本条完整来源，未收到批准'], limitations: [] }
    if (sourceId !== sourceIds[2]) decision.replySourceId = sourceId
    return [call('task_session_submit', { decision })]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: `batch-followup-${batched}`, title: '核对待答期间追问', objective: '方案等待确认，允许只读回答事实追问' })
  await h.service.whenIdle()
  const original = await h.query('task.get', { taskId: created.taskId })
  // 在恢复调度前积压完整来源，精确覆盖一个 wake 含多来源和多个 wake 两种账本状态。
  const command = (kind, args, id) => h.service.store.command({ id: `batch:${id}`, kind, args })
  for (const [index, sourceId] of sourceIds.entries()) {
    await command('source.record', { sourceId, groupId: 'native-group', messageId: `message-${index}`, actorId: `member-${index}`,
      text: index < 2 ? `第 ${index + 1} 项目前已经实施了什么？` : '另一件事下周再聊', channel: 'im' }, `source-${index}`)
    await command('source.routed', { sourceId, receipt: [{ taskId: original.taskId }] }, `routed-${index}`)
  }
  for (const [index, refs] of (batched ? [sourceIds] : sourceIds.map((_, index) => sourceIds.slice(0, index + 1))).entries())
    await command('task.supplement', { taskId: original.taskId, expectedRequirementRevision: original.requirementRevision,
      expectedControlRevision: original.controlRevision, messageId: `batch-${index}`, text: '待答期间收到新来源',
      sourceRefs: [...original.sourceRefs, ...refs] }, `supplement-${index}`)
  await h.service.recover(); await h.service.whenIdle()
  assert.deepEqual(reviewed, [sourceIds, sourceIds.slice(1), sourceIds.slice(2)])
  const after = await h.query('task.get', { taskId: original.taskId })
  assert.equal(after.humanRequests[0].status, 'waiting-reply')
  assert.equal(after.humanRequests[0].requestId, original.humanRequests[0].requestId)
  assert.equal(after.sessionId, original.sessionId)
  assert.deepEqual(after.humanRequests[0].followupReplies.map(item => item.sourceId), sourceIds.slice(0, 2))
  const replies = h.sent.filter(item => item.id.startsWith('human-followup:'))
  assert.deepEqual(replies.map(item => item.payload.replyToMessageId), ['message-0', 'message-1'])
  assert.deepEqual(replies.map(item => item.payload.atOpenDingTalkIds), [['member-0'], ['member-1']])
  for (const reply of replies) assert.equal((await h.query('notification.get', { notificationId: reply.id })).state, 'delivered')
  assert.equal((await h.query('execution.list')).length, 0)
  assert.equal((await h.query('operation.list')).length, 0)
  const count = h.requests.length
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, count)
  assert.equal(h.sent.filter(item => item.id.startsWith('human-followup:')).length, 2)
})

for (const permission of [false, true]) test(`operator technical reply retains business sources and shared scope protocol in the same resumed execution permission=${permission}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const objective = '测试助手，修复后部署到UAT2，隔离验证，不操作真实申请'
  const reply = '技术已恢复；本答复不新增部署批准，不撤销此前明确交办范围。用户纠正：说了部署到UAT就部署到UAT，这个申请不应该提。'
  const seen = [], scopes = []
  const h = await fixture(t, async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const input = latestInput(request)
    scopes.push(requestSystemText(request))
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      assert.match(request.tools.find(tool => tool.name === 'task_request_human').description, /已授权的目标持续完成/)
      const execution = input.executions[0]
      if (!execution) return [call('task_delegate', { key: 'prepare', objective: '准备原交付' }), call('task_session_submit', { decision: { action: 'wait', summary: '准备中', evidence: [], limitations: [] } })]
      if (!input.task.humanRequests.length) return [call('task_request_human', { reason: '准备已完成，工具配置需操作人恢复', question: '请恢复原工具配置', evidence: ['原生配置诊断'], attemptedActions: ['原配置检查'] })]
      if (execution.inputVersion === 1) return [call('task_delegate', { executionId: execution.executionId, key: 'continue', objective: '按原来源继续完整UAT交付' }), call('task_session_submit', { decision: { action: 'wait', summary: '沿原执行继续', evidence: [], limitations: [] } })]
      return [call('task_session_submit', { decision: { action: 'wait', summary: '原执行已收到完整来源，后续交付仍待统筹核验', evidence: [], limitations: ['本用例仅核验来源与原会话续办'] } })]
    }
    seen.push(input)
    return [call('execution_submit', { output: { status: 'completed', summary: '测试夹具仅记录输入，没有执行外部部署', evidence: [], limitations: [], artifacts: [] } })]
  }, { config: { webActorId: permission ? 'native-user' : 'operator-user' } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'business-authorization', senderOpenDingTalkId: 'native-user', text: objective, occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const before = (await h.query('task.list'))[0], original = (await h.query('execution.list'))[0], request = await pending(h)
  const responseArgs = { taskId: before.taskId, humanRequestId: request.requestId, requestId: 'scope-continuation', reply,
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision,
    ...(permission ? { executionPermissionCorrection: { executionId: original.executionId, expectedInputVersion: original.inputVersion,
      mode: 'danger-full-access', reason: '原发布成员原生权限纠正，保留原交付范围' } } : {}) }
  if (permission) {
    const server = createServer((req, res) => handleRequest(req, res, { respondTaskHumanRequest: args => h.service.respondHumanRequest(args) }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}/tasks/${before.taskId}/human-requests/${encodeURIComponent(request.requestId)}/reply/check`
    const wakes = await h.query('wake.list', { taskId: before.taskId })
    const { taskId, humanRequestId, ...body } = responseArgs
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    assert.deepEqual(await h.query('task.get', { taskId: before.taskId }), before)
    assert.deepEqual((await h.query('execution.list'))[0], original)
    assert.deepEqual(await h.query('wake.list', { taskId: before.taskId }), wakes)
    await assert.rejects(h.service.respondHumanRequest({ ...responseArgs, checkOnly: true,
      executionPermissionCorrection: { ...responseArgs.executionPermissionCorrection, expectedInputVersion: 99 } }), /TASK_EXECUTION_PERMISSION_CORRECTION_SCOPE/)
  }
  await h.service.respondHumanRequest(responseArgs)
  await h.service.whenIdle()
  const after = await h.query('task.get', { taskId: before.taskId }), executions = await h.query('execution.list')
  assert.equal(executions.length, 1)
  assert.equal(executions[0].executionId, original.executionId)
  assert.equal(executions[0].sessionId, original.sessionId)
  assert.equal(executions[0].inputVersion, 2)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.status, 'active')
  assert.equal(after.lastDecision.action, 'wait')
  assert.equal(after.humanRequests.length, 1)
  assert.equal(after.humanRequests[0].status, 'answered')
  assert.ok(h.toolResults.some(result => result.name === 'model_content_read'), '超预算上下文经过真实只读工具，不把引用视为已读')
  for (const request of h.requests) for (const message of request.messages.filter(message => message.source?.taskSession))
    assert.ok(Buffer.byteLength(message.content[0].text) <= 3000, '恢复后仍保留Host的UTF8预算')
  assert.equal(seen.at(-1).sources.find(source => source.messageId === 'business-authorization').text, objective)
  assert.equal(seen.at(-1).sources.find(source => source.text === reply).actorId, permission ? 'native-user' : 'operator-user')
  if (permission) {
    assert.equal(executions[0].permissionCorrection.mode, 'danger-full-access')
    const events = (await readFile(await findSessionLog(h.root, original.sessionId), 'utf8')).trim().split('\n').map(JSON.parse)
    const modes = events.filter(event => event.type === 'sandbox/mode')
    assert.equal(modes.at(-1).data.mode, 'danger-full-access', '受信 Host 在原会话持久化纠正，不仅记录 ledger')
    assert.equal(events[0].id, original.sessionId)
    await h.service.respondHumanRequest(responseArgs)
    await assert.rejects(h.service.respondHumanRequest({ ...responseArgs,
      executionPermissionCorrection: { ...responseArgs.executionPermissionCorrection, mode: 'read-only' } }), /DYNAMIC_COMMAND_ID_CONFLICT/)
  }
  assert.equal(seen.at(-1).task.objective, after.objective)
  assert.deepEqual(seen.map(input => input.objective), ['准备原交付', '按原来源继续完整UAT交付'], '技术恢复只续办剩余阶段，不重跑已完成准备')
  const continuations = h.toolResults.filter(result => result.name === 'task_delegate')
  assert.equal(continuations.length, 2, '初次委派和原执行续办各一次，不重复派发')
  assert.ok(continuations.every(result => !result.result.isError), '续办依据真实工具接收回执，不凭模型声明能力恢复')
  for (const scope of scopes) {
    assert.match(scope, /不自动撤销此前已明确授予的范围/)
    assert.match(scope, /明确暂停、撤销、仅准备或改变目标环境则优先/)
    assert.match(scope, /真实原生权限拒绝和尚未满足的审批条件不得绕过/)
    assert.match(scope, /作出任何授权判断前（包括认定可以继续）/)
    assert.match(scope, /用户说“部署到UAT”就是该任务的UAT部署授权/)
    assert.match(scope, /规则写“需批准”不等于当前“尚未批准”/)
    assert.match(scope, /具体规则、触发条件与已有授权尚缺什么/)
  }
  assert.deepEqual(await h.query('operation.list'), [], '输入与恢复证明不冒充真实发布或工具效果')
})

test('技术申请进入Web和登录人私聊，精确引用及真实作者恢复原任务，零技术群询问', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let ownerTurns = 0, resumed, h
  const sent = []
  h = await fixture(t, async request => {
    const calls = topicTaskCalls(request)
    if (calls) return calls
    if (++ownerTurns === 1) return [call('task_request_human', { audience: 'operator', reason: '原生能力需修复', question: '请恢复GitHub查询能力', evidence: ['已核实Host拒绝'], attemptedActions: ['读取原操作日志'] })]
    resumed = latestInput(request)
    return [finish('人工技术处理结果已接纳')]
  }, { config: { operatorUserId: 'actual-login-user' }, notifications: {
    async send(notification) { sent.push(notification); return { messageId: notification.payload.audience === 'operator' ? 'operator-notice' : `group-${sent.length}` } },
    async readback(notification) { return notification.payload.audience === 'operator'
      ? { messageId: 'operator-notice', conversationId: 'self-private', senderActorId: 'actual-operator', observedAt: new Date().toISOString() }
      : { messageId: notification.ack.messageId, visible: true } },
  } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'business-request', senderOpenDingTalkId: 'native-user', text: '测试助手，核查既有业务目标', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const request = await pending(h), waiting = (await h.query('task.list'))[0]
  assert.equal(request.audience, 'operator')
  assert.equal(request.notification.state, 'delivered')
  const privateNotice = sent.find(item => item.payload.audience === 'operator')
  assert.equal(privateNotice.payload.recipientUserId, 'actual-login-user')
  assert.equal(privateNotice.payload.humanRequestId, request.requestId, '内部申请关联保留在元数据')
  assert.ok(!privateNotice.payload.text.includes(request.requestId), '原生引用即可定位申请，无需在正文展示编号')
  assert.match(privateNotice.payload.text, /引用本消息回复/)
  assert.equal(h.residentStore.getGroup('native-group').outbox.length, 1, '私聊通知不投影为业务群发件箱')
  assert.ok(!h.residentStore.getGroup('native-group').outbox.some(item => item.text.includes('恢复GitHub')))
  const reply = { groupId: 'self-private', messageId: 'human-private-answer', senderOpenDingTalkId: 'actual-operator',
    quotedMessage: { messageId: 'operator-notice' }, text: '技术能力已修复，请沿原任务继续只读核查', occurredAt: new Date().toISOString() }
  for (const change of [{ groupId: 'native-group' }, { senderOpenDingTalkId: 'native-user' }, { quotedMessage: { messageId: 'other' } }])
    await assert.rejects(h.service.respondPrivateHumanReply({ ...reply, ...change }), /DYNAMIC_HUMAN_RESPONSE_FORBIDDEN|TASK_HUMAN_PRIVATE_REQUEST_NOT_FOUND/)
  await h.service.respondPrivateHumanReply(reply); await h.service.whenIdle()
  const completed = (await h.query('task.list'))[0]
  assert.equal(completed.sessionId, waiting.sessionId)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.humanRequests[0].replyChannel, 'private')
  assert.equal(completed.humanRequests[0].actorId, 'actual-operator')
  assert.equal(resumed.sources.find(item => item.messageId === reply.messageId).actorId, 'actual-operator')
  await h.service.respondPrivateHumanReply(reply); await h.service.whenIdle()
  assert.equal(ownerTurns, 2)
  assert.equal(sent.filter(item => item.payload.audience === 'operator').length, 1)
})

test('人工外发问题在入账前拒绝已知运行标识，内部证据与业务链接原样保留', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const operationId = 'opaque-internal-operation-identity', business = '请核对 PR #253 与订单 SG18：https://example.com/orders/SG18'
  let step = 0
  const h = await fixture(t, async (request, host) => {
    const input = latestInput(request)
    if (step === 0) {
      const binding = await host.query('task.binding', { taskId: input.task.taskId })
      await host.service.store.command({ id: 'prepare-test-operation', kind: 'operation.prepare', args: {
        binding, operationId, key: 'known-operation', definition: { toolName: 'fixture', effectClass: 'read' }, resourceKeys: [],
      } })
      await host.service.store.command({ id: 'cancel-test-operation', kind: 'operation.cancelPrepared', args: {
        binding, operationId, key: 'known-operation', reason: '隔离用例不执行外部操作',
      } })
    }
    assert.equal((await host.query('task.get', { taskId: input.task.taskId })).humanRequests.length, 0,
      '泄漏正文不能先生成待答申请，再让外发卡住')
    const args = { reason: '需要核对业务信息', question: business, evidence: [`内部诊断：${operationId}`], attemptedActions: ['已核对现有资料'] }
    if (step === 0) args.question = `请处理 ${operationId}`
    if (step === 1) args.attemptedActions = [`已检查 ${operationId}`]
    step++
    return [call('task_request_human', args)]
  }, { config: { operatorUserId: 'actual-login-user' } })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'public-human-copy', title: '业务信息核对', objective: '核对业务信息' })
  await h.service.whenIdle()
  assert.equal(step, 3)
  const current = await h.query('task.get', { taskId: created.taskId })
  assert.equal(current.humanRequests.length, 1)
  assert.deepEqual(current.humanRequests[0].evidence, [`内部诊断：${operationId}`])
  const notices = h.sent.filter(item => item.payload.audience === 'operator')
  assert.equal(notices.length, 1)
  assert.match(notices[0].payload.text, /PR #253 与订单 SG18：https:\/\/example\.com\/orders\/SG18/)
  assert.ok(!notices[0].payload.text.includes(operationId))
  assert.ok(!notices[0].payload.text.includes(current.humanRequests[0].requestId))
  const rejected = h.toolResults.filter(item => item.name === 'task_request_human' && item.result.isError)
  assert.equal(rejected.length, 2)
  assert.ok(rejected.every(item => JSON.stringify(item.result).includes('GROUP_REPLY_INTERNAL_DETAILS')))
})

test('native human request waits without repeat wakes; authenticated HTTP reply resumes the original session from actual source text', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let turns = 0, replyInput
  const h = await fixture(t, async request => {
    const input = latestInput(request); turns++
    if (turns === 1) return [requestHuman()]
    replyInput = input
    return [finish('仅按人工明确的 UAT3 范围完成核对')]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-native', objective: '按明确范围核对' })
  await h.service.whenIdle()
  const request = await pending(h), waiting = await h.query('task.get', { taskId: created.taskId })
  assert.ok(request)
  assert.equal(waiting.lastDecision.action, 'blocked')
  assert.equal(waiting.drained, true)
  assert.deepEqual(request.attemptedActions, ['核对现有需求，未执行外部修改'])
  for (let i = 0; i < 3; i++) { await h.service.recover(); await h.service.whenIdle() }
  assert.equal(turns, 1)
  const server = createServer((req, res) => handleRequest(req, res, { respondTaskHumanRequest: args => h.service.respondHumanRequest(args) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tasks/${created.taskId}/human-requests/${encodeURIComponent(request.requestId)}/reply`
  const body = { requestId: 'real-human-response', reply: '仅允许 UAT3 的只读核对；不得修改生产或发布', expectedRequirementRevision: waiting.requirementRevision, expectedControlRevision: waiting.controlRevision }
  const forbidden = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://outside.invalid' }, body: JSON.stringify(body) })
  assert.equal(forbidden.status, 403)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  await h.service.whenIdle()
  const completed = await h.query('task.get', { taskId: created.taskId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, waiting.sessionId)
  assert.equal(completed.requirementRevision, 1)
  assert.equal(completed.humanRequests[0].status, 'answered')
  assert.equal(replyInput.sources.find(source => source.text === body.reply)?.actorId, 'native-user')
  assert.ok(!JSON.stringify(replyInput).includes('unlimitedApproval'))
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 0)
})

test('an execution result cannot bypass human waiting; reply reads the original execution and continues the original task', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const released = Promise.withResolvers(); let turns = 0, executionId, afterReply, originalSummary
  const reviewers = completionReviews()
  t.after(() => released.resolve())
  const h = await fixture(t, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      const review = reviewers.execution(latestInput(request)); if (review) return review
      await released.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行已完成只读核对', evidence: ['原执行事实'], limitations: [], artifacts: [] } })]
    }
    const input = latestInput(request)
    turns++
    if (turns === 1) return [call('task_delegate', { key: 'original-inspection', objective: '只读核对原目标' })]
    if (turns === 2) return [requestHuman()]
    afterReply = input
    const execution = input.executions[0], ref = execution.resultRef ?? input.catalogRef
    const path = (execution.resultRef ? '' : '/executions/' + execution.executionId + '/result') + '/payload/output/summary'
    const page = modelToolValues(request).find(value => value.contentRef === ref.contentRef && value.path === path)
    if (!page) return [call('model_content_read', { contentRef: ref.contentRef, path })]
    originalSummary = page.text
    return reviewers.owner(input, '已读取原执行结果并按人工范围收束')
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-execution', objective: '核对原目标，边界不清时申请人工' })
  const request = await waitUntil(() => pending(h), 'persisted human request')
  released.resolve()
  await h.service.whenIdle(); await h.service.recover(); await h.service.whenIdle()
  assert.equal(turns, 2, 'execution-result wake must remain held while waiting for the human reply')
  const [execution] = await h.query('execution.list'); executionId = execution.executionId
  assert.equal(execution.status, 'succeeded')
  const waiting = await h.query('task.get', { taskId: created.taskId })
  await h.service.respondHumanRequest({ taskId: created.taskId, humanRequestId: request.requestId, requestId: 'reply-original-execution', reply: '仅使用现有只读结果，不追加写入', expectedRequirementRevision: waiting.requirementRevision, expectedControlRevision: waiting.controlRevision })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), toolErrors: h.toolResults.filter(item => item.result?.isError).map(({ name, result }) => ({ name, error: result.error })) }))
  assert.equal(afterReply.executions[0].executionId, executionId)
  assert.equal(originalSummary, '原执行已完成只读核对')
  const completed = await h.query('execution.list')
  assert.equal(completed.length, 3)
  assert.equal(completed.filter(item => item.key === 'original-inspection').length, 1)
  assert.equal(completed.find(item => item.key === 'original-inspection').executionId, executionId)
})

test('a native blocked decision without a human question is corrected into an explicit durable request', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let steps = 0
  const h = await fixture(t, async request => {
    steps++
    if (steps === 1) return [call('task_session_submit', { decision: { action: 'blocked', summary: '需要人工', evidence: [], limitations: [] } })]
    assert.match(JSON.stringify(request.messages), /blocked requires a specific human question/)
    return [requestHuman()]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-correction', objective: '按实际边界处理' })
  await h.service.whenIdle()
  assert.equal(steps, 2)
  const task = await h.query('task.get', { taskId: created.taskId })
  assert.equal(task.humanRequests.length, 1)
  assert.equal(task.humanRequests[0].status, 'waiting-reply')
  assert.equal(task.lastDecision.question, '请明确本次允许的环境和操作范围')
  assert.ok(h.toolResults.some(item => item.name === 'task_session_submit' && item.result.isError))
})

for (const changed of [false, true]) test(`original-group human input preserves clarification but fences explicit authorization change: changed=${changed}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const release = Promise.withResolvers(); t.after(() => release.resolve())
  const reviewers = completionReviews()
  let ownerTurns = 0, originalTask, originalTopic, answeredInput
  const replyText = '测试助手，本次只允许 UAT3 只读核对，保持现有执行，不得发布生产。'
  const h = await fixture(t, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      for (const route of calls[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId: originalTopic }]
      return calls
    }
    if (names.includes('group_decision_submit')) {
      // Reproduce a coordinator slower than the former 100ms executor release.
      if (changed) await new Promise(resolve => setTimeout(resolve, 500))
      const calls = topicTaskCalls(request), submitted = calls[0].args
      submitted.decision.actions = [{ kind: 'task-context', taskId: originalTask.taskId, inputVersion: originalTask.requirementRevision,
        runSequence: originalTask.runSequence, context: replyText, progressImpact: 'preserve', topicRefs: [{ topicId: submitted.topicId, revision: submitted.revision }],
        ...(changed ? { authorizationChange: 'changed', progressImpact: 'replan' } : {}),
        basisUnitRefs: submitted.decision.basisUnitRefs }]
      submitted.decision.reply = '已收到本次范围答复，将沿原任务继续。'
      return calls
    }
    if (!names.includes('task_delegate')) {
      const review = reviewers.execution(latestInput(request)); if (review) return review
      await release.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行按只读范围完成', evidence: ['原执行结果'], limitations: [], artifacts: [] } })]
    }
    const input = latestInput(request); ownerTurns++
    if (ownerTurns === 1) return [call('task_delegate', { key: 'live-original', objective: '保持原有只读核对' })]
    if (ownerTurns === 2) return [requestHuman('requester')]
    if (input.humanReview) return [call('task_human_resolve', { requestId: input.humanReview.requestId,
      sourceId: input.humanReview.sourceIds[0], reason: '原需求人对同一环境问题明确限定 UAT3，只读且不发布生产',
      evidence: [replyText] }), call('task_session_submit', { decision: { action: 'wait', summary: '已核对完整范围限制，下一轮沿原任务继续', evidence: [replyText], limitations: [] } })]
    if (!input.executions.every(execution => execution.drained)) {
      answeredInput = input
      return [call('task_session_submit', { decision: { action: 'wait', summary: '已读取原群答复，等待原执行完成', evidence: [], limitations: [] } })]
    }
    return reviewers.owner(input, '原任务与原执行沿人工明确范围完成')
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'original-group-answer', objective: '原群原任务核对' })
  await waitUntil(() => pending(h), 'human wait before original-group reply')
  originalTask = await h.query('task.get', { taskId: created.taskId }); originalTopic = originalTask.topicRefs[0].topicId
  const [before] = await h.query('execution.list')
  assert.equal(before.drained, false)
  const ingestion = h.service.ingest({ groupId: 'native-group', messageId: 'real-group-human-answer', senderOpenDingTalkId: 'native-user', text: replyText,
    occurredAt: new Date().toISOString(), timestamp: new Date().toISOString() })
  if (changed) {
    // Keep the provider live until cancellation is actually requested, then let Host drain it.
    await waitUntil(async () => (await h.query('execution.list')).find(execution => execution.executionId === before.executionId)?.cancelRequested,
      'original execution receives authorization cancellation')
    release.resolve()
    await ingestion; await h.service.whenIdle()
    const task = await h.query('task.get', { taskId: created.taskId }), [execution] = await h.query('execution.list')
    assert.equal(task.requirementRevision, originalTask.requirementRevision + 1)
    assert.equal(task.humanRequests[0].status, 'superseded')
    assert.equal(execution.cancelRequested, true)
    assert.equal(execution.result.current, false)
    return
  }
  await ingestion
  await waitUntil(() => answeredInput, 'owner receives authenticated group answer').catch(async error => {
    error.message += JSON.stringify({ toolErrors: h.toolResults.filter(item => item.name === 'group_decision_submit').slice(-1),
      alerts: await h.service.listAlerts(), task: (await h.query('task.get', { taskId: created.taskId })).humanRequests,
      topics: h.residentStore.listTopics('native-group').map(topic => ({ id: topic.topicId, decisions: topic.decisions?.map(decision => ({ status: decision.status, error: decision.error })) })) })
    throw error
  })
  const answered = await h.query('task.get', { taskId: created.taskId }), [stillLive] = await h.query('execution.list')
  assert.equal(answered.humanRequests[0].status, 'answered')
  assert.equal(answered.humanRequests[0].actorId, 'native-user')
  assert.equal(answered.requirementRevision, originalTask.requirementRevision)
  assert.equal(answered.controlRevision, originalTask.controlRevision)
  assert.equal(answered.sessionId, originalTask.sessionId)
  assert.equal(stillLive.executionId, before.executionId)
  assert.equal(stillLive.sessionId, before.sessionId)
  assert.equal(stillLive.cancelRequested, false)
  assert.equal(stillLive.drained, false)
  assert.equal(answeredInput.sources.find(source => source.messageId === 'real-group-human-answer')?.text, replyText)
  assert.equal(answered.topicRefs[0].topicId, originalTopic)
  assert.ok(answered.appliedOperations.length > originalTask.appliedOperations.length)
  release.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), toolErrors: h.toolResults.filter(item => item.result?.isError).map(({ name, result }) => ({ name, error: result.error })) }))
  assert.equal((await h.query('task.list')).length, 1)
  const completed = await h.query('execution.list')
  assert.equal(completed.length, 3)
  assert.equal(completed.find(item => item.key === 'live-original').executionId, before.executionId)
  assert.equal(completed.find(item => item.key === 'live-original').sessionId, before.sessionId)
})

test('Web answer recalls its delivered operator notification once without recalling group replies', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let turns = 0
  const recalls = []
  const h = await fixture(t, async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    return ++turns === 1 ? [requestHuman()] : [finish('已按人工答复继续')]
  }, { config: { operatorUserId: 'login', webActorId: 'web-user' }, notifications: {
    async send(notification) { return { messageId: notification.id } },
    async readback(notification) { return { messageId: notification.id, conversationId: notification.payload.audience === 'operator' ? 'self-private' : 'native-group', senderActorId: 'login', visible: true } },
    async recall(notification) { recalls.push(notification); return { ...notification.receipt, recallStatus: 'SUCCESS' } },
  } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'request', senderOpenDingTalkId: 'native-user', text: '测试助手，检查原业务需求', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const request = await pending(h), task = (await h.query('task.list'))[0]
  const reply = { taskId: task.taskId, humanRequestId: request.requestId, requestId: 'web-reply', reply: '已修复原能力',
    expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision }
  await Promise.all([h.service.respondHumanRequest(reply), h.service.respondHumanRequest(reply)])
  await h.service.whenIdle()
  await h.service.respondHumanRequest(reply)
  await h.service.whenIdle()
  assert.equal(recalls.length, 1)
  assert.equal(recalls[0].payload.humanRequestId, request.requestId)
  assert.equal(recalls[0].payload.audience, 'operator')
  assert.equal(recalls[0].receipt.conversationId, 'self-private')
  const answered = (await h.service.listAuthorizationRequests()).find(item => item.requestId === request.requestId)
  assert.equal(answered.status, 'answered')
  assert.equal(answered.notification.recall.state, 'recalled')
})
