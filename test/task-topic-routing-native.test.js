import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTopicMessages } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { groupReplyScopeInstructions } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'

const call = (name, args) => ({ name, args: name === 'group_decision_submit' ? { ...args, decision: { ...args.decision, topicUpdate: { summary: '围绕原始事项持续核对，当前结论以任务真实进展为准。' } } } : args })
function envelope(request, prefix) {
  for (const message of request.messages.toReversed()) for (const part of message.content ?? []) {
    if (part.type !== 'text' || !part.text.startsWith(prefix)) continue
    const line = part.text.split('\n').find(value => value.startsWith('Topic 请求：'))
    if (line) return JSON.parse(line.slice('Topic 请求：'.length))
  }
  throw new Error(`Missing native ${prefix} request`)
}
function jsonValues(value) {
  if (!value || typeof value !== 'object') return []
  const values = [value]
  for (const child of Object.values(value)) {
    if (typeof child === 'string') { try { values.push(...jsonValues(JSON.parse(child))) } catch {} }
    else if (typeof child === 'object') values.push(...jsonValues(child))
  }
  return values
}
const message = (messageId, text) => ({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'native-user', senderName: '真实用户', sourceKind: 'dingtalk', text,
  occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' })

testRunner('native task service preserves Topic routing, task association, ignored input and recovery idempotency', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-topic-native-'))
  let h, residentStore
  t.after(async () => { try { await h?.close(); await residentStore?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const reviewed = new Set(), ownerInputs = []
  h = await nativeTaskHost(root, async (request, host) => {
    const names = request.tools.map(tool => tool.name)
    assert.ok(JSON.stringify(request.messages.filter(message => message.role === 'system')).includes(groupReplyScopeInstructions),
      '话题承接及任务结果的原生模型请求都必须携带多事项与部分处理的回复范围规则')
    if (names.includes('group_topic_route_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_ROUTE]')
      const existing = residentStore.listTopics('native-group').find(topic => topic.title === '原生文件检查')
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({
        messageId: item.messageId, messageVersion: item.messageVersion,
        topics: item.messageId === 'noise' ? [] : item.messageId === 'discussion' ? [{ newTopicKey: 'discussion', title: '部署时间讨论' }]
          : existing ? [{ topicId: existing.topicId }] : [{ newTopicKey: 'native-check', title: '原生文件检查' }],
        ...(item.messageId === 'noise' ? { reason: '同事闲聊，没有交办或持续事项' } : {}),
      })) })]
    }
    if (names.includes('group_decision_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_DECISION]')
      const current = input.messages.at(-1)
      if (current.messageId === 'discussion') return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [current.messageId], actions: [], reason: '只是讨论时间，没有交办' } })]
      if (!reviewed.has(input.requestId)) {
        reviewed.add(input.requestId)
        return [call('group_reply_review_get', { requestIds: [input.requestId] })]
      }
      const reviewResult = host.toolResults.findLast(item => item.name === 'group_reply_review_get')
      const review = jsonValues(reviewResult?.result).find(value => Array.isArray(value.candidates))
      assert.ok(review, 'Real reply-review tool result must reach the scripted model')
      const candidateIds = review.candidates.map(value => value.outboundId)
      const task = residentStore.listTasks().find(value => value.groupId === 'native-group')
      const refs = [{ topicId: input.topicId, revision: input.revision }]
      const action = task ? { kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
        context: current.text, progressImpact: 'preserve', topicRefs: refs }
        : { kind: 'new-task', title: '原生文件检查', objective: '检查指定文件并等待补充', acceptanceCriteria: ['保留原始交办及后续补充'], topicRefs: refs }
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [current.messageId], actions: [action], reply: task ? '已收到补充。' : '已承接文件检查。',
          replyReview: { kind: 'confirmation', reviewedOutboundIds: candidateIds, sameMatterOutboundIds: candidateIds, replaceOutboundIds: candidateIds } } })]
    }
    const input = latestInput(request)
    assert.ok(names.includes('task_session_submit'), 'Task work must use a real native task session')
    ownerInputs.push(input)
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待用户补充检查资料', evidence: [], limitations: [] } })]
  }, { agentConfig: { agentPreset: 'native-test', agentNames: ['助手'] }, serviceFactory: async args => {
    residentStore = args.residentStore
    await residentStore.setAgentNames(['助手'])
    await residentStore.subscribe({ groupId: 'native-group', name: '真实话题测试群', responsibility: '助手负责用户明确交办的文件检查' })
    return openTaskSessionService({ ...args, residentStore })
  } })
  const first = message('first', '@助手 检查指定文件，先承接并等待我补充资料。')
  assert.equal((await h.service.ingest(first)).accepted, true)
  await h.service.whenIdle()
  await waitUntil(async () => (await h.query('task.list')).length > 0, 'Topic decision creates native task').catch(async error => { throw new Error(error.message + JSON.stringify({ results: h.toolResults, requests: h.requests.length, recovery: await h.service.recover() })) })
  await h.service.whenIdle()
  const tasks = await h.query('task.list')
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.drained, true)
  assert.equal(task.lastDecision.action, 'wait')
  assert.equal(ownerInputs.length, 1)
  const topics = residentStore.listTopics('native-group')
  assert.equal(topics.length, 1)
  const topicId = topics[0].topicId
  assert.ok(task.topicRefs.some(ref => ref.topicId === topicId))
  const stored = residentStore.getGroup('native-group').messages.find(item => item.messageId === first.messageId)
  assert.equal(stored.routingStatus, 'routed')
  assert.ok(resolveTopicMessages(residentStore.getGroup('native-group'), topicId, topics[0].revision).some(item => item.messageId === first.messageId))
  assert.equal(stored.taskSessionRefs, undefined)
  assert.equal(residentStore.getGroup('native-group').outbox[0].replyToMessageId, first.messageId)
  assert.equal(stored.taskIds, undefined)
  assert.equal((await h.query('source.list'))[0].routed, true)
  const second = message('second', '@助手 补充同一文件检查：只检查文件名称，不执行部署。')
  await h.service.ingest(second)
  await h.service.whenIdle()
  const revised = await h.query('task.get', { taskId: task.taskId })
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(revised.requirementRevision, task.requirementRevision, 'preserve补充不推进需求版本')
  assert.equal(revised.contextRevision, (task.contextRevision ?? 0) + 1, '独立上下文版本唤醒原统筹')
  assert.equal(residentStore.getTask(task.taskId).inputVersion, revised.requirementRevision)
  assert.equal(residentStore.getTopic('native-group', topicId).revision, 2)
  assert.match(revised.request, /只检查文件名称/)
  assert.ok(ownerInputs.length >= 2, 'Supplement must wake the real task owner session')
  await h.service.ingest(message('noise', '哈哈，今天午饭不错。'))
  await h.service.ingest(message('discussion', '我们讨论明天几点部署，暂时没有交办助手。'))
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 1)
  assert.ok(residentStore.listTopics('native-group').every(topic => !resolveTopicMessages(residentStore.getGroup('native-group'), topic.topicId, topic.revision).some(item => item.messageId === 'noise')))
  const before = { requests: h.requests.length, tasks: (await h.query('task.list')).length, topics: residentStore.listTopics('native-group').length, revision: revised.requirementRevision }
  await h.service.ingest(first)
  await h.service.ingest(second)
  await h.service.recover()
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, before.tasks)
  assert.equal(residentStore.listTopics('native-group').length, before.topics)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).requirementRevision, before.revision)
  assert.equal(h.requests.length, before.requests)
  await waitUntil(async () => (await h.query('source.list')).every(source => source.routed), 'all sources durably marked routed')
  assert.ok(h.toolResults.filter(item => ['group_topic_route_submit', 'group_decision_submit'].includes(item.name)).every(item => !item.result.isError))
})

async function extraHost(t, prefix, decide) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, decide)
  return host
}

testRunner('native Topic handoff keeps the explicit requester as task and completion notification owner', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const reviewed = new Set()
  const h = await extraHost(t, 'task-topic-owner-', async (request, host) => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_ROUTE]')
      const existing = host.residentStore.listTopics('native-group')[0]
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
        topics: [existing ? { topicId: existing.topicId } : { newTopicKey: 'handoff', title: '文件检查交接' }] })) })]
    }
    if (names.includes('group_decision_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_DECISION]'), current = input.messages.at(-1)
      if (current.messageId === 'colleague-discussion') return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [current.messageId], actions: [], reason: '同事只在讨论检查事项，没有交办助手' } })]
      if (!reviewed.has(input.requestId)) { reviewed.add(input.requestId); return [call('group_reply_review_get', { requestIds: [input.requestId] })] }
      const review = jsonValues(host.toolResults.findLast(item => item.name === 'group_reply_review_get')?.result).find(value => Array.isArray(value.candidates))
      assert.ok(review)
      const ids = review.candidates.map(value => value.outboundId)
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [current.messageId], actions: [{ kind: 'new-task', title: '文件检查交接', objective: '确认文件检查已完成', acceptanceCriteria: ['向明确交办人报告检查结论'],
          topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '已承接检查。',
          replyReview: { kind: 'confirmation', reviewedOutboundIds: ids, sameMatterOutboundIds: ids, replaceOutboundIds: ids } } })]
    }
    assert.ok(names.includes('task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'complete', summary: '文件检查已完成，结论已核验。', evidence: ['已核对本轮原始交办'], limitations: [] } })]
  })
  await h.service.ingest({ ...message('colleague-discussion', '我们正在讨论文件检查，稍后请负责人确认。'), senderOpenDingTalkId: 'native-colleague', senderName: '同事' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 0)
  const handoff = await h.service.ingest(message('explicit-handoff', '@测试助手 请完成上述文件检查并告诉我结论。'))
  await h.service.whenIdle()
  const tasks = await h.query('task.list')
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.status, 'completed')
  assert.equal(task.ownerActorId, 'native-user')
  assert.equal(task.metadata.authorizationSourceId, handoff.sourceId)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  const completion = (await h.query('notification.list')).find(item => item.kind === 'completion')
  assert.ok(completion, 'Native task completion must prepare its real notification')
  assert.equal(completion.payload.sourceMessageId, 'explicit-handoff')
  assert.equal(completion.payload.actorId, 'native-user')
  assert.equal(completion.payload.replyToMessageId, 'explicit-handoff')
  assert.ok(h.sent.some(item => item.kind === 'completion' && item.payload.sourceMessageId === 'explicit-handoff'))
})

testRunner('native Web Topic edits reject stale requirement and control revisions without changing task or topics', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const h = await extraHost(t, 'task-topic-web-stale-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续补充', evidence: [], limitations: [] } })]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'web-create', title: 'Web 文件检查', objective: '检查文件并等待补充' })
  await h.service.whenIdle()
  const original = await h.query('task.get', { taskId: created.taskId })
  assert.equal(original.requirementRevision, 1)
  await h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '新增文件名称检查要求' })
  await h.service.whenIdle()
  const revised = await h.query('task.get', { taskId: created.taskId })
  assert.equal(revised.requirementRevision, 2)
  const topics = h.residentStore.listTopics('native-group')
  assert.equal(topics.length, 1, 'Successful Web supplement retains the original Topic and source identity')
  const topicSnapshot = JSON.stringify(topics)
  await assert.rejects(h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-stale-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '这条过期补充必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await assert.rejects(h.service.cancelTask({ taskId: created.taskId, requestId: 'web-stale-cancel', expectedRequirementRevision: revised.requirementRevision,
    expectedControlRevision: revised.controlRevision - 1, reason: '过期控制版本必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  const unchanged = await h.query('task.get', { taskId: created.taskId })
  assert.equal(unchanged.requirementRevision, revised.requirementRevision)
  assert.equal(unchanged.controlRevision, revised.controlRevision)
  assert.equal(unchanged.control, revised.control)
  assert.equal(unchanged.request, revised.request)
  assert.equal(JSON.stringify(h.residentStore.listTopics('native-group')), topicSnapshot)
  assert.equal((await h.query('task.list')).length, 1)
})

testRunner('native proposal prompt preserves original authorization and asks without claiming task execution', { timeout: 15000, ...(!available ? { skip: reason } : {}) }, async t => {
  let checked = false
  const h = await extraHost(t, 'task-topic-proposal-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'proposal', title: '描述框位置调整' }] })) })]
    assert.ok(names.includes('group_decision_submit'))
    const prompt = JSON.stringify(request)
    for (const rule of ['才允许选择 new-task', '必须选择 task-proposal', '这个事项是否需要我处理？', '暂不创建任务', '不承诺', '消息明确 @其他同事', '测试助手', '不追加未经授权的业务验收']) assert.ok(prompt.includes(rule), rule)
    checked = true
    return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [{ kind: 'task-proposal', title: '描述框位置调整', objective: '按原图将描述框放在文字右侧并顶部对齐', topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '这个事项是否需要我处理？', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
  })
  await h.service.ingest(message('proposal-only', '合并后描述输入框放在该项文字右侧，和文字顶部对齐。'))
  await h.service.whenIdle()
  assert.equal(checked, true)
  assert.equal((await h.query('task.list')).length, 0)
  const topic = h.residentStore.listTopics('native-group')[0]
  assert.equal(topic.decisions[0].decision.actions[0].kind, 'task-proposal')
  assert.equal(topic.decisions[0].status, 'completed')
  assert.equal(topic.summary, '围绕原始事项持续核对，当前结论以任务真实进展为准。')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].kind, 'topic-reply')
  assert.ok(h.sent[0].payload.text.includes('这个事项是否需要我处理？'))
  await h.service.retryMessage({ groupId: 'native-group', messageId: 'proposal-only' }); await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 0)
  assert.equal(h.sent.length, 1)
})
