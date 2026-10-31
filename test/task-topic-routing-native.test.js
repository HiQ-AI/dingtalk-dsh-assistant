import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { taskDirectories } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTopicMessages } from '../packages/dingtalk-dsh-assistant/store.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { groupReplyScopeInstructions } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { taskIndexPage } from '../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'
import { fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'

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

testRunner('脚本化普通回复目标只选固定输入真人来源', () => {
  const human = { messageId: 'human', unitId: 'unit-human', unitRevision: 1, text: '核对', senderOpenDingTalkId: 'user-a', sourceKind: 'dingtalk' }
  const web = { messageId: 'web', unitId: 'unit-web', unitRevision: 1, text: '补充', senderOpenDingTalkId: 'web-actor', sourceKind: 'web' }
  const internal = { ...web, messageId: 'internal', sourceKind: 'internal' }
  for (const [messages, expected] of [[[human], 'human'], [[human, web], 'human'], [[human, internal], 'human'], [[web], undefined]]) {
    const input = { requestId: 'request', topicId: 'topic', revision: 1, messages }
    const request = { tools: [{ name: 'group_decision_submit' }], messages: [{ role: 'user', content: [{ type: 'text', text: `Topic 请求：${JSON.stringify(input)}` }] }] }
    const decision = topicTaskCalls(request)[0].args.decision
    assert.equal(decision.replyToMessageId, expected)
  }
})

testRunner('来源语义戳在首次Topic完成后落账，不等待同群其他判断',
  { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'source-clock-immediate-'))
    let host, firstDecision, completedMessageId, slowBlocked = false
    const slowEntered = Promise.withResolvers(), releaseSlow = Promise.withResolvers()
t.onCancel(() => releaseSlow.resolve())

    t.after(async () => { releaseSlow.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    host = await t.step(async () => nativeTaskHost(root, async request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      const calls = topicTaskCalls(request)
      if (names.includes('group_decision_submit')) {
        firstDecision ??= input.requestId
        if (input.requestId === firstDecision) completedMessageId = input.messages[0].messageId
        else {
          slowBlocked = true; slowEntered.resolve(); await releaseSlow.promise; slowBlocked = false
        }
        for (const item of calls) {
          item.args.decision.actions = []; item.args.decision.reason = '只记录独立反馈，不开展业务动作'
          item.args.decision.topicUpdate = { summary: '记录独立反馈，未开展业务动作。' }
          delete item.args.decision.reply
          delete item.args.decision.replyToMessageId
          delete item.args.decision.replyReview
        }
      }
      return calls ?? []
    }))
    await t.step(async () => Promise.all([host.service.ingest(message('fast-clock', '测试助手，记录物料名称显示反馈。')),
      host.service.ingest(message('slow-clock', '测试助手，记录另一个独立事项。'))]))
    await t.step(async () => slowEntered.promise)
    try {
      await t.step(async () => waitUntil(async () => (await host.query('source.list')).find(source => source.messageId === completedMessageId)?.processingCompleted,
        '已完成Topic的来源独立落戳', 5000))
    } catch (error) {
      t.diagnostic(JSON.stringify({ sources: (await t.step(async () => host.query('source.list'))).map(source => ({ messageId: source.messageId, routed: source.routed,
        processingPending: source.processingPending, processingCompleted: source.processingCompleted })),
        topics: host.residentStore.listTopics('native-group').map(topic => ({ title: topic.title, revision: topic.revision, processedRevision: topic.processedRevision,
          decisions: topic.decisions.map(record => ({ status: record.status, error: record.error, completedAt: record.completedAt })) })), tools: host.toolResults, alerts: host.service.listAlerts() }))
      throw error
    }
    assert.equal(slowBlocked, true)
    const completedTopic = host.residentStore.listTopics('native-group').find(topic => topic.entries.some(entry => entry.messageId === completedMessageId))
    assert.equal(completedTopic.decisions[0].status, 'completed')
    assert.equal(completedTopic.summary, '记录独立反馈，未开展业务动作。')
    const at = (await t.step(async () => host.query('source.list'))).find(source => source.messageId === completedMessageId).processingCompleted.at
    t.diagnostic(JSON.stringify({ metric: 'settled-topic-to-source-projection', delayMs: Date.parse(at) - Date.parse(completedTopic.decisions[0].completedAt), slowTopicStillBlocked: slowBlocked }))
    assert.ok(Date.parse(at) >= Date.parse(completedTopic.decisions[0].completedAt), '来源戳不能早于真实决策终态')
    assert.equal(host.sent.length, 0, '纯讨论无回复决策不产生通知')
    assert.equal((await t.step(async () => host.query('source.list'))).find(source => source.messageId === completedMessageId).processingCompleted.at, at)
    releaseSlow.resolve(); await t.step(async () => host.service.whenIdle())
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    assert.equal((await t.step(async () => host.query('source.list'))).find(source => source.messageId === completedMessageId).processingCompleted.at, at)
    assert.equal((await t.step(async () => host.query('task.list'))).length, 0)
  }))

testRunner('completed task catalogue stays within the tool budget and advances by returned entries without losing tasks', () => {
  const tasks = Array.from({ length: 14 }, (_, index) => ({ taskId: `task-${index}`, title: `原任务${index}`, state: 'completed',
    inputVersion: index + 1, runSequence: 2, topicRefs: [{ topicId: `topic-${index}`, revision: 3 }],
    objective: '核对原任务交付。'.repeat(1000), completion: { result: { summary: '已交付原 PR 及 UAT 证据。'.repeat(1000) } },
    sourceRefs: ['internal-source'], request: '长原文'.repeat(10000), appliedOperations: ['historical-operation'] }))
  const seen = []
  for (let offset = 0; offset < tasks.length;) {
    const page = taskIndexPage(tasks, offset, 100)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12 * 1024)
    assert.ok(page.tasks.length > 0 && page.tasks.length < 14)
    assert.equal(page.total, tasks.length)
    assert.equal(page.nextOffset, offset + page.tasks.length)
    assert.equal(page.hasMore, page.nextOffset < tasks.length)
    for (const item of page.tasks) {
      assert.equal(item.state, 'completed')
      assert.equal(item.inputVersion, tasks.find(task => task.taskId === item.taskId).inputVersion)
      assert.ok(item.objectivePreview && item.resultPreview)
      assert.equal(item.request, undefined)
      assert.equal(item.appliedOperations, undefined)
      seen.push(item.taskId)
    }
    offset = page.nextOffset
  }
  assert.deepEqual(seen, tasks.map(task => task.taskId))
  assert.equal(taskIndexPage(tasks, tasks.length, 100).hasMore, false)
  assert.equal(taskIndexPage([], 0, 100).nextOffset, 0)
  assert.ok(tasks[0].request.length > 20000, '目录缩减不得改写原任务正文')
})

testRunner('task catalogue continuation carries the exact normalized query and current snapshot identity', () => {
  const tasks = Array.from({ length: 18 }, (_, index) => ({ taskId: `task-${index}`, title: `数据集${index}`, state: 'completed',
    inputVersion: 1, runSequence: 1, objective: '完整目标'.repeat(300), result: { summary: '实际结果'.repeat(300) } }))
  const first = taskIndexPage(tasks, 0, 50, '数据集')
  assert.equal(first.hasMore, true); assert.equal(first.query, '数据集')
  assert.deepEqual(first.nextCall, { name: 'group_task_list', arguments: { query: '数据集', offset: first.nextOffset, limit: 50 } })
  const next = taskIndexPage(tasks, first.nextCall.arguments.offset, first.nextCall.arguments.limit, first.nextCall.arguments.query)
  assert.equal(next.snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(next.tasks[0].taskId, tasks[first.nextOffset].taskId)
  assert.deepEqual(taskIndexPage(tasks, 0, 50, '数据集'), first)
  tasks[0].inputVersion++
  assert.notEqual(taskIndexPage(tasks, 0, 50, '数据集').snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(taskIndexPage([], 0, 50, '数据集').nextCall, null)
})

testRunner('native request-bound review and Topic reads accept empty args while routing never guesses a Topic',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    let routed = false, reviewed = false, readTopic = false, wrongRequestChecked = false
    const h = await extraHost(t, 'bound-topic-read-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit')) {
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_topic_context_get').parameters.required, ['topicId'])
        if (!routed) { routed = true; return [call('group_topic_context_get', {})] }
        const missing = values.find(value => value.issues?.some(issue => issue.code === 'topic_id_required'))
        assert.equal(missing?.status, 'invalid-arguments')
        assert.deepEqual(missing.nextCall, { name: 'group_topic_list', arguments: { offset: 0, limit: 50 } })
        return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId,
          messageVersion: item.messageVersion, topics: [{ newTopicKey: 'bound-read', title: '只读承接合同核验' }] })) })]
      }
      if (names.includes('group_decision_submit')) {
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_reply_review_get').parameters.required, [])
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_topic_context_get').parameters.required, [])
        if (!wrongRequestChecked) { wrongRequestChecked = true; return [call('group_reply_review_get', { requestIds: ['cross-request'] })] }
        if (!reviewed) { reviewed = true; return [call('group_reply_review_get', {})] }
        const review = values.find(value => Array.isArray(value.requestIds) && Array.isArray(value.candidates))
        assert.deepEqual(review?.requestIds, [input.requestId])
        if (!readTopic) { readTopic = true; return [call('group_topic_context_get', {})] }
        const context = values.find(value => value.topic?.topicId === input.topicId && Array.isArray(value.messages))
        assert.equal(context?.topic.revision, input.revision)
        assert.equal(context.messages[0].messageId, 'contract-source')
        return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '仅核验固定请求读取合同，无业务交办' } })]
      }
      return topicTaskCalls(request) ?? []
    })
    await t.beginBusiness()

    await t.step(async () => h.service.ingest(message('contract-source', '固定请求读取合同核验，无需办理业务。')))
    await t.step(async () => h.service.whenIdle())
    assert.ok(routed && reviewed && readTopic && wrongRequestChecked)
    assert.ok(h.toolResults.filter(item => item.name === 'group_reply_review_get').some(item => JSON.stringify(item.result).includes('coordination_tool_wrong_request')))
    assert.equal(h.residentStore.listTopics('native-group')[0].decisions[0].status, 'completed')
    assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
    assert.equal(h.sent.length, 0)
  }))

testRunner('native revised Topic supplies current linked Task reads without rescanning the catalogue',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    let topicId, taskId, contextReads = 0, decisions = 0
    const h = await extraHost(t, 'linked-task-reads-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId,
        routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ topicId }] })) })]
      if (names.includes('group_decision_submit')) {
        assert.equal(input.linkedTasks.total, 1)
        assert.equal(input.linkedTasks.reads[0].taskId, taskId)
        assert.equal(input.linkedTasks.snapshots[0].summary, '等待后续资料')
        assert.equal(input.linkedTasks.snapshots[0].objective, undefined, '首包只含状态摘要，完整目标按需读')
        const full = modelToolValues(request).flatMap(value => value.tasks ?? []).find(task => task.taskId === taskId && task.objective)
        if (!full) { contextReads++; return [call(input.linkedTasks.reads[0].readCall.name, input.linkedTasks.reads[0].readCall.arguments)] }
        assert.equal(full.objective, '必须完整核验的原目标'.repeat(800))
        decisions++
        return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '只核对讨论上下文，不执行新动作' } })]
      }
      return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续资料', evidence: [], limitations: [] } })]
    })
    await t.beginBusiness()

    const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'linked-original', title: '关联原任务', objective: '必须完整核验的原目标'.repeat(800) }))
    await t.step(async () => h.service.whenIdle())
    const task = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
    taskId = task.taskId; topicId = task.topicRefs[0].topicId
    const ownerRuns = h.toolResults.filter(item => item.name === 'task_session_submit').length
    for (const [id, text] of [['linked-follow-317', '补充原事项讨论，只核对上下文，不执行新动作。'],
      ['linked-follow-318', '测试成员乙已处理原事项，后续由测试成员丙验收，未请求本助手推进。']]) {
      await t.step(async () => h.service.ingest(message(id, text)))
      await t.step(async () => h.service.whenIdle())
    }
    assert.equal(decisions, 2)
    assert.equal(contextReads, 2, '每个新版本从当前账本核对全文，不沿用旧会话读过的许可')
    assert.equal(h.toolResults.filter(item => item.name === 'group_task_list').length, 0)
    assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
    assert.equal((await t.step(async () => h.query('task.get', { taskId }))).requirementRevision, task.requirementRevision)
    assert.deepEqual(await t.step(async () => h.query('task.get', { taskId })), task, '他人进展只保留业务上下文，不改任务状态或完成证据')
    assert.equal(h.toolResults.filter(item => item.name === 'task_session_submit').length, ownerRuns, '只记上下文不能唤醒已有任务')
    assert.equal(h.sent.length, 0)
    assert.equal(h.residentStore.listTopics('native-group').find(topic => topic.topicId === topicId).processedRevision, 3)
  }))

testRunner('native task context reports invalid arguments and reads explicit archived identity', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const invalid = [{}, { taskIds: null }, { taskIds: 'x' }, { taskIds: [null] }, { taskIds: [] },
    { taskIds: ['same', 'same'] }, { taskIds: Array.from({ length: 9 }, (_, index) => `id-${index}`) }, { taskIds: ['x'], extra: true }]
  let taskId, foreignTaskId, requestedInvalid = false, requestedArchive = false, requestedForeign = false, checked = false
  const h = await extraHost(t, 'archived-context-contract-', async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId,
      routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'archive-read', title: '归档身份核验' }] })) })]
    if (names.includes('group_decision_submit')) {
      if (!requestedInvalid) { requestedInvalid = true; return invalid.map(args => call('group_task_context_get', args)) }
      if (!requestedArchive) {
        assert.equal(values.filter(value => value.status === 'invalid-arguments' && value.issues?.some(issue => issue.code === 'group_task_context_request_invalid')).length, invalid.length)
        requestedArchive = true
        return [call('group_task_context_get', { taskIds: [taskId] })]
      }
      const archived = values.flatMap(value => value.tasks ?? []).find(task => task.taskId === taskId)
      assert.ok(archived?.archivedAt)
      assert.deepEqual(archived.allowedActions, [])
      assert.equal(archived.groupId, 'native-group')
      assert.equal(archived.objective, undefined)
      if (!requestedForeign) {
        requestedForeign = true
        return [call('group_task_context_get', { taskIds: [foreignTaskId] }), call('group_task_context_get', { taskIds: ['missing-task-id'] })]
      }
      const toolResults = JSON.stringify(host.toolResults.filter(item => item.name === 'group_task_context_get'))
      assert.match(toolResults, /group_task_context_wrong_group/)
      assert.match(toolResults, /group_task_context_not_found/)
      assert.doesNotMatch(toolResults, /跨群机密原目标/)
      checked = true
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '仅核验归档身份' } })]
    }
    return [call('task_session_submit', { decision: { action: 'complete', summary: '已完成', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'archive-contract-create', title: '归档测试', objective: '敏感原目标不应出现在归档上下文' }))
  taskId = created.taskId
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => h.service.archiveTask({ taskId }))
  await t.step(async () => h.residentStore.subscribe({ groupId: 'foreign-group', name: '隔离测试群', responsibility: '测试群边界' }))
  const foreign = await t.step(async () => h.service.createTask({ groupId: 'foreign-group', requestId: 'foreign-archive-create', title: '外群测试', objective: '跨群机密原目标' }))
  foreignTaskId = foreign.taskId
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => h.service.archiveTask({ taskId: foreignTaskId }))
  assert.equal((await t.step(async () => h.query('task.list'))).some(task => task.taskId === taskId), false)
  await t.step(async () => h.service.ingest(message('archive-contract-source', '只核对归档身份，无需执行。')))
  await t.step(async () => h.service.whenIdle())
  assert.equal(checked, true)
  assert.equal(h.sent.length, 0)
}))

testRunner('native batch followup reopens each original completed task and session once from one coordination topic', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  let followup = false
  const reopenedInputs = []
  const h = await extraHost(t, 'task-batch-followup-', async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (input.trigger === 'task-facts') return topicTaskCalls(request)
    if (names.includes('group_topic_route_submit')) {
      assert.ok(JSON.stringify(request).includes('批量事项即使由新协调 Topic 承接'))
      if (!values.some(value => Array.isArray(value.tasks))) return [call('group_task_list', { limit: 100 })]
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({
        messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'batch-review', title: '原交付审查续办' }],
      })) })]
    }
    if (names.includes('group_decision_submit')) {
      const details = values.find(value => Array.isArray(value.tasks))
      if (!details) {
        const ids = (await host.query('task.list')).filter(task => task.title.startsWith('dataset ')).map(task => task.taskId)
        return [call('group_task_context_get', { taskIds: ids })]
      }
      const review = values.find(value => Array.isArray(value.candidates))
      if (!review) return [call('group_reply_review_get', { requestIds: [input.requestId] })]
      const refs = [{ topicId: input.topicId, revision: input.revision }]
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: input.messages.map(item => item.messageId),
          actions: details.tasks.map(task => {
            assert.equal(task.state, 'completed')
            assert.ok(task.request && task.completion.result.summary, '详情仍保留完整原始交付及完成证据')
            return { kind: 'task-reopen', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
              context: `仅跟进 ${task.title} 的原 PR；核查新评论，适用时修订、验证并提测原 UAT，无新评论则不重复修改或部署。`, topicRefs: refs }
          }),
          reply: '已分别交回两个原任务核查新增审查评论。', replyToMessageId: input.messages.at(-1).messageId,
          replyReview: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
        } })]
    }
    assert.ok(names.includes('task_session_submit'))
    if (followup) reopenedInputs.push({ taskId: input.task.taskId, sessionId: input.task.sessionId, request: input.task.request })
    return [call('task_session_submit', { decision: { action: 'complete', summary: followup ? '已核查，无新增适用评论，不修改或提测。' : '原 PR 与 UAT 交付证据。',
      evidence: ['隔离测试完成收据'], limitations: [] } })]
  })
  await t.beginBusiness()

  for (const title of ['dataset 名称校验', 'dataset 关联校验', '无关通知文案']) {
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: `seed-${title}`, title, objective: `${title}：完成原 PR 并交付原 UAT` }))
    await t.step(async () => h.service.whenIdle())
  }
  const originals = await t.step(async () => h.query('task.list'))
  assert.ok(originals.every(task => task.status === 'completed'))
  followup = true
  const source = message('batch-followup', '测试助手，云端对dataset项目当前活跃的PR做了代码审查，并给出了修复方案，你看看你当前已完成的项目中未合并的PR是否有新的评论，如果有，则逐个按照PR中的评论修改，然后重新提测对应UAT环境')
  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.whenIdle())
  const after = await t.step(async () => h.query('task.list'))
  assert.equal(after.length, originals.length)
  for (const original of originals) {
    const current = after.find(task => task.taskId === original.taskId), selected = original.title.startsWith('dataset ')
    assert.equal(current.sessionId, original.sessionId)
    assert.equal(current.runSequence, original.runSequence + Number(selected))
    assert.equal(current.requirementRevision, original.requirementRevision + Number(selected))
    assert.ok(current.request.startsWith(original.request))
    assert.ok(original.sourceRefs.every(ref => current.sourceRefs.includes(ref)))
    assert.ok(original.topicRefs.every(ref => current.topicRefs.some(item => item.topicId === ref.topicId)))
    assert.equal(current.status, 'completed')
  }
  assert.equal(reopenedInputs.length, 2)
  const decision = h.residentStore.listTopics('native-group').find(topic => topic.title === '原交付审查续办').decisions[0]
  assert.deepEqual(decision.decision.actions.map(action => action.kind), ['task-reopen', 'task-reopen'])
  assert.ok(decision.operations.every(operation => operation.status === 'applied'))
  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  assert.equal(reopenedInputs.length, 2)
  assert.deepEqual((await t.step(async () => h.query('task.list'))).map(task => [task.taskId, task.requirementRevision, task.runSequence]), after.map(task => [task.taskId, task.requirementRevision, task.runSequence]))
}))

for (const quoted of [true, false]) testRunner('普通回复显式多收件人贯穿原生通知格式化 quoted=' + quoted, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  let rejectedQuote = false
  const h = await extraHost(t, 'topic-recipients-', async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_ROUTE]')
      const topic = h.residentStore.listTopics('native-group')[0]
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({
        messageId: item.messageId, messageVersion: item.messageVersion,
        topics: [topic ? { topicId: topic.topicId } : { newTopicKey: 'same', title: '资料核对' }],
      })) })]
    }
    if (names.includes('group_decision_submit')) {
      const input = envelope(request, '[GROUP_TOPIC_DECISION]')
      const current = input.messages.at(-1)
      const decision = current.messageId === 'recipient-a'
        ? { basisMessageIds: ['recipient-a'], actions: [], reason: '等待补充' }
        : { basisMessageIds: ['recipient-a', 'recipient-b'], actions: [], reply: '已收到资料。', ...(quoted ? { replyToMessageId: 'recipient-a' } : {}),
          atOpenDingTalkIds: ['user-a', 'user-b'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } }
      if (!quoted && current.messageId === 'recipient-b' && !rejectedQuote) {
        rejectedQuote = true
        decision.replyToMessageId = 'recipient-b'
        decision.atOpenDingTalkIds = ['user-a']
      }
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision })]
    }
    return []
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message('recipient-a', '@助手 请核对资料。'), senderOpenDingTalkId: 'user-a' }))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => h.service.ingest({ ...message('recipient-b', '资料已准备。'), senderOpenDingTalkId: 'user-b' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].payload.replyToMessageId, quoted ? 'recipient-a' : undefined)
  assert.deepEqual(h.sent[0].payload.atOpenDingTalkIds, ['user-a', 'user-b'])
  assert.equal(h.residentStore.getGroup('native-group').outbox[0].replyToMessageId, quoted ? 'recipient-a' : undefined)
  if (!quoted) assert.ok(h.toolResults.some(result => JSON.stringify(result).includes('group_reply_quote_author_not_in_recipients')))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(h.sent.length, 1)
}))

for (const mode of ['prepared', 'projected', 'revision-conflict', 'taskIds-conflict']) testRunner(`旧回复冻结恢复 ${mode}`, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'topic-frozen-recovery-'))
  let h, stage = 'initial host'
  t.after(async () => { t.diagnostic(`恢复测试结束阶段：${stage}`); await h?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, () => []))
  stage = 'seed'
  await t.step(async () => h.residentStore.ingest(message('frozen-a', '@助手 请核对资料。')))
  const routed = await t.step(async () => h.residentStore.routeMessages({ groupId: 'native-group', routeId: 'frozen-route', routingRevision: 0,
    routes: [{ messageId: 'frozen-a', messageVersion: 1, topics: [{ newTopicKey: 'frozen', title: '资料核对' }] }] }))
  const topicId = routed.topicIdsByKey.frozen
  const basisUnitRefs = resolveTopicMessages(h.residentStore.getGroup('native-group'), topicId, 1).map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
  const accepted = await t.step(async () => h.residentStore.acceptTopicDecision({ groupId: 'native-group', topicId, revision: 1, decisionId: 'old-decision',
    decision: { basisMessageIds: ['frozen-a'], basisUnitRefs, actions: [], reply: '旧决定文本' } }))
  const outboundId = accepted.record.outboundId
  const refs = [{ topicId, revision: mode === 'revision-conflict' ? 2 : 1 }]
  const row = (await t.step(async () => h.service.store.command({ id: 'prepare-frozen', kind: 'notification.prepare', args: { notificationId: outboundId, kind: 'topic-reply', requirementRevision: 1,
    payload: { conversationId: 'native-group', topicRefs: refs, taskIds: mode === 'taskIds-conflict' ? ['unrelated-fixture-task'] : [], text: '冻结文本', sourceMessageId: 'frozen-a', actorId: 'native-user',
      replyToMessageId: 'frozen-a', replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'], fact: { topicRefs: refs } } } }))).result.notification
  if (mode === 'projected') {
    await t.step(async () => projectTaskNotification({ residentStore: h.residentStore, notification: row }))
    const projected = h.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)
    assert.equal(projected.sourceMessageId, `task-notification:${outboundId}`)
    assert.equal(projected.decisionId, undefined)
  }
  stage = 'close first host'
  await t.step(async () => h.close())
  stage = 'reopen host'
  h = await t.step(async () => nativeTaskHost(root, () => [], { initialize: false }))
  stage = 'recover and service idle'
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  stage = 'wait decision terminal'
  await t.step(async () => waitUntil(() => ['blocked', 'completed'].includes(h.residentStore.getTopic('native-group', topicId).decisions.find(item => item.decisionId === 'old-decision').status), '旧决定恢复到终态', 5000))
  stage = 'assert recovery'
  const record = h.residentStore.getTopic('native-group', topicId).decisions.find(item => item.decisionId === 'old-decision')
  if (mode === 'revision-conflict' || mode === 'taskIds-conflict') {
    assert.notEqual(record.status, 'completed')
    assert.match(JSON.stringify(record), /group_reply_frozen_identity_conflict/)
    assert.equal(h.sent.length, 0)
  } else {
    assert.equal(record.status, 'completed', JSON.stringify(record))
    const outbox = h.residentStore.getGroup('native-group').outbox.filter(item => item.outboundId === outboundId)
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].text, '冻结文本')
    assert.equal(outbox[0].replyToMessageId, 'frozen-a')
    assert.equal(outbox[0].replyToSenderOpenDingTalkId, 'native-user')
    assert.deepEqual(outbox[0].atOpenDingTalkIds, ['native-user'])
    assert.ok(h.sent.length <= 1)
    await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
    assert.ok(h.sent.length <= 1)
  }
}))

testRunner('native task service preserves Topic routing, task association, ignored input and recovery idempotency', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-topic-native-'))
  let h, residentStore
  t.after(async () => { try { await h?.close(); await residentStore?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const reviewed = new Set(), ownerInputs = []
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, async (request, host) => {
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
        decision: { basisMessageIds: [current.messageId], actions: [action], reply: task ? '已收到补充。' : '已承接文件检查。', replyToMessageId: current.messageId,
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
  } }))
  const first = message('first', '@助手 检查指定文件，先承接并等待我补充资料。')
  assert.equal((await t.step(async () => h.service.ingest(first))).accepted, true)
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => (await h.query('task.list')).length > 0, 'Topic decision creates native task').catch(async error => { throw new Error(error.message + JSON.stringify({ results: h.toolResults, requests: h.requests.length, recovery: await h.service.recover() })) }))
  await t.step(async () => h.service.whenIdle())
  const tasks = await t.step(async () => h.query('task.list'))
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
  const firstSource = (await t.step(async () => h.query('source.list')))[0]
  assert.equal(firstSource.routed, true)
  assert.ok(firstSource.processingCompleted)
  const firstStages = firstSource.stages
  for (const stage of ['ingress', 'queue', 'turn', 'host', 'send', 'readback']) {
    assert.ok(firstStages.some(item => item.stage === stage && item.completedAt), `missing observed ${stage}: ${JSON.stringify(firstStages)}`)
  }
  assert.ok(firstStages.filter(item => item.stage === 'turn').every(item => item.sessionId && item.spanId.includes(item.sessionId)))
  const dto = (await t.step(async () => h.service.messageProcessingSources('native-group'))).find(item => item.messageId === first.messageId)
  assert.equal(dto.version, firstSource.version)
  assert.deepEqual(dto.stages.map(item => item.spanId), firstStages.map(item => item.spanId))
  assert.ok(dto.notifications.every(item => item.versionMatched && item.notificationId && item.deliveredAt))
  assert.equal(dto.text, undefined)
  assert.equal(h.service.listAlerts().some(item => item.id?.startsWith('timing:')), false)
  const second = message('second', '@助手 补充同一文件检查：只检查文件名称，不执行部署。')
  await t.step(async () => h.service.ingest(second))
  await t.step(async () => h.service.whenIdle())
  const revised = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(revised.requirementRevision, task.requirementRevision, 'preserve补充不推进需求版本')
  assert.equal(revised.contextRevision, (task.contextRevision ?? 0) + 1, '独立上下文版本唤醒原统筹')
  assert.equal(residentStore.getTask(task.taskId).inputVersion, revised.requirementRevision)
  assert.equal(residentStore.getTopic('native-group', topicId).revision, 2)
  assert.match(revised.request, /只检查文件名称/)
  assert.ok(ownerInputs.length >= 2, 'Supplement must wake the real task owner session')
  await t.step(async () => h.service.ingest(message('noise', '哈哈，今天午饭不错。')))
  await t.step(async () => h.service.ingest(message('discussion', '我们讨论明天几点部署，暂时没有交办助手。')))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.ok(residentStore.listTopics('native-group').every(topic => !resolveTopicMessages(residentStore.getGroup('native-group'), topic.topicId, topic.revision).some(item => item.messageId === 'noise')))
  const before = { requests: h.requests.length, tasks: (await t.step(async () => h.query('task.list'))).length, topics: residentStore.listTopics('native-group').length, revision: revised.requirementRevision }
  const stagesBeforeReplay = (await t.step(async () => h.query('source.list'))).map(source => ({ sourceId: source.sourceId, stages: source.stages }))
  await t.step(async () => h.service.ingest(first))
  await t.step(async () => h.service.ingest(second))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, before.tasks)
  assert.equal(residentStore.listTopics('native-group').length, before.topics)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).requirementRevision, before.revision)
  assert.equal(h.requests.length, before.requests)
  assert.deepEqual((await t.step(async () => h.query('source.list'))).map(source => ({ sourceId: source.sourceId, stages: source.stages })), stagesBeforeReplay)
  await t.step(async () => waitUntil(async () => (await h.query('source.list')).every(source => source.routed), 'all sources durably marked routed'))
  assert.ok(h.toolResults.filter(item => ['group_topic_route_submit', 'group_decision_submit'].includes(item.name)).every(item => !item.result.isError))
  const discussion = residentStore.getGroup('native-group').messages.find(item => item.messageId === 'discussion')
  const discussionSource = (await t.step(async () => h.query('source.list'))).find(item => item.messageId === discussion.messageId)
  assert.ok(discussionSource.processingCompleted)
  assert.equal(discussionSource.routed, true)
  const discussionTopic = residentStore.listTopics('native-group').find(topic => topic.title === '部署时间讨论')
  await t.step(async () => residentStore.routeMessages({ groupId: 'native-group', routeId: 'same-version-reclassification',
    routingRevision: residentStore.getGroup('native-group').routingRevision, routes: [{ messageId: discussion.messageId,
      messageVersion: discussion.messageVersion, units: [{ unitKey: 'whole-message', summary: '重新核对讨论语义',
        sourceRefs: [{ quote: discussion.text }], topics: [{ topicId: discussionTopic.topicId }] }] }] }))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  const reclassified = await t.step(async () => h.query('source.get', { sourceId: discussionSource.sourceId }))
  assert.equal(reclassified.version, discussionSource.version)
  assert.equal(reclassified.routed, true)
  assert.deepEqual(reclassified.processingHistory, [discussionSource.processingCompleted])
  assert.ok(reclassified.processingCompleted.activeUnitRefs.every(ref => ref.unitRevision === 2))
  assert.equal((await t.step(async () => h.query('task.list'))).length, before.tasks)
}))

async function extraHost(t, prefix, decide) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, decide)
  return host
}

testRunner('Topic外发标识在接纳前被拒绝，原轮修改后只创建一项任务且保留业务编号链接', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  let attempts = 0
  const publicText = '已安排核查 PR #253 与订单 SG18：https://example.com/orders/SG18'
  const h = await extraHost(t, 'topic-public-identities-', async (request, host) => {
    const calls = topicTaskCalls(request), input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'group_decision_submit')) {
      assert.equal((await host.query('task.list')).length, 0, '正文校验必须早于业务任务创建')
      assert.equal(host.residentStore.listTopics('native-group')[0].decisions.length, 0, '无效正文不能持久接纳为待执行决定')
      const source = (await host.query('source.list'))[0]
      const ids = [input.requestId, input.topicId, input.messages[0].unitId, input.messages[0].messageId, source.sourceId]
      calls[0].args.decision.reply = attempts < ids.length ? `已处理：${ids[attempts]}` : publicText
      attempts++
      return calls
    }
    if (calls) return calls
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待实际核验结果', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message('business-request-with-identities', '测试助手，核查 PR #253 与订单 SG18 的关联。')))
  await t.step(async () => h.service.whenIdle())
  assert.equal(attempts, 6)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(h.residentStore.listTopics('native-group')[0].decisions.length, 1)
  const rejected = h.toolResults.filter(item => item.name === 'group_decision_submit' && item.result.isError)
  assert.equal(rejected.length, 5)
  assert.ok(rejected.every(item => JSON.stringify(item.result).includes('GROUP_REPLY_INTERNAL_DETAILS')))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].payload.text, publicText)
  assert.equal(h.sent[0].payload.sourceMessageId, 'business-request-with-identities')
}))

testRunner('native Topic handoff keeps the explicit requester as task and completion notification owner', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const reviewed = new Set()
  const h = await extraHost(t, 'task-topic-owner-', async (request, host) => {
    const names = request.tools.map(tool => tool.name)
    if (latestInput(request).trigger === 'task-facts') return topicTaskCalls(request)
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
          topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '已承接检查。', replyToMessageId: current.messageId,
          replyReview: { kind: 'confirmation', reviewedOutboundIds: ids, sameMatterOutboundIds: ids, replaceOutboundIds: ids } } })]
    }
    assert.ok(names.includes('task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'complete', summary: '文件检查已完成，结论已核验。', evidence: ['已核对本轮原始交办'], limitations: [] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message('colleague-discussion', '我们正在讨论文件检查，稍后请负责人确认。'), senderOpenDingTalkId: 'native-colleague', senderName: '同事' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  const handoff = await t.step(async () => h.service.ingest(message('explicit-handoff', '@测试助手 请完成上述文件检查并告诉我结论。')))
  await t.step(async () => h.service.whenIdle())
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.status, 'completed')
  assert.equal(task.ownerActorId, 'native-user')
  assert.equal(task.metadata.authorizationSourceId, handoff.sourceId)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  const completion = (await t.step(async () => h.query('notification.list'))).find(item => item.payload.coveredEventIds?.length)
  if (!completion) t.diagnostic(JSON.stringify({ alerts: h.service.listAlerts(), binding: task.replyBindings,
    pending: await t.step(async () => h.query('topic.fact.pending', { groupId: task.groupId, topicId: task.replyBindings?.[0]?.topicId })),
    errors: h.toolResults.filter(item => item.result?.isError).map(item => ({ name: item.name, result: item.result })) }))
  assert.ok(completion, 'Topic must consume the completed fact and prepare its reply')
  assert.equal(completion.payload.sourceMessageId, undefined, 'Context provenance is not a transport quote or implicit recipient')
  assert.equal(completion.payload.actorId, undefined)
  assert.equal(completion.payload.replyToMessageId, undefined)
  assert.equal(completion.payload.replyToSenderOpenDingTalkId, undefined)
  assert.deepEqual(completion.payload.atOpenDingTalkIds, ['native-user'])
  const fact = await t.step(async () => h.query('topic.fact.get', { factId: completion.payload.coveredEventIds[0] }))
  assert.equal(fact.decision.decision.replyToMessageId, 'explicit-handoff')
  assert.ok(fact.sourceIds.includes(handoff.sourceId), 'The authenticated handoff remains linked to the completion fact')
  assert.ok(h.sent.some(item => item.id === completion.id && item.payload.atOpenDingTalkIds.includes('native-user')))
}))

for (const committed of [false, true]) testRunner(`replan fences an execution claim ${committed ? 'after commit' : 'before commit'}`, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'execution-claim-gate-'))
  const gate = Promise.withResolvers()
t.onCancel(() => gate.resolve())

  let host, store, entered = false, revised = false, ownerDone = false, claimError, current, claims = 0, executionRuns = 0, cancels = 0, ownerRuns = 0
  const sessions = {
    async run({ delegate, submit }) {
      ownerRuns++
      if (ownerRuns === 1) await delegate({ key: 'first', objective: '检查隔离测试' })
      await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] })
      if (ownerRuns === 1) ownerDone = true
      return { status: 'submitted' }
    },
    async cancel() {}, async close() {},
  }
  const executionSessions = {
    async run({ binding }) { executionRuns++; current = await store.query({ kind: 'execution.current', binding }); return { status: 'stale' } },
    async cancel() { cancels++ }, async feedback() {}, async close() {},
  }
  t.after(async () => { gate.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      if (request.kind === 'execution.claim') { claims++; if (!committed) { entered = true; await gate.promise } }
      let result
      try { result = await store.command(request) } catch (error) { if (request.kind === 'execution.claim') claimError = error.code ?? error.message; throw error }
      if (request.kind === 'execution.claim' && committed) { entered = true; await gate.promise }
      if (request.kind === 'task.revise') revised = true
      return result
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions, executionSessions })
  } }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'claim-create', title: '领取竞态', objective: '检查任务' }))
  await t.step(async () => waitUntil(() => entered && ownerDone, '旧 execution claim 与 Owner 已到达门闩', 10000))
  await t.step(async () => waitUntil(async () => (await host.query('task.get', { taskId: task.taskId })).drained, '旧 Owner 已排空', 5000))
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  let accepted = false
  const pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'claim-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '更新要求' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(() => revised, '任务修订已提交', 5000))
  if (committed) await t.step(async () => waitUntil(() => cancels === 1, '已领取 execution 已收到取消', 5000))
  assert.equal(accepted, false)
  assert.equal(claims, 1)
  gate.resolve()
  await t.step(async () => pending)
  await t.step(async () => host.service.whenIdle())
  if (committed) { assert.equal(executionRuns, 1); assert.equal(current, false) }
  else { assert.equal(executionRuns, 0); assert.equal(claimError, 'DYNAMIC_EXECUTION_BUSY') }
  assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).requirementRevision, before.requirementRevision + 1)
  assert.equal(ownerRuns, 2)
}))

testRunner('concurrent same-topic revision is busy while a different task makes progress', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-admission-isolation-'))
  const gate = Promise.withResolvers()
t.onCancel(() => gate.resolve())

  let host, store, entered = false, block = false
  const ownerRuns = new Map()
  const sessions = { async run({ binding, submit }) { ownerRuns.set(binding.taskId, (ownerRuns.get(binding.taskId) ?? 0) + 1); await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } }, async cancel() {}, async close() {} }
  t.after(async () => { gate.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      if (block && request.kind === 'task.revise' && !entered) { entered = true; await gate.promise }
      return store.command(request)
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
  } }))
  const first = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'serial-create', title: '任务一', objective: '检查任务一' }))
  await t.step(async () => host.residentStore.subscribe({ groupId: 'independent-group', name: '独立群', responsibility: '隔离测试' }))
  const second = await t.step(async () => host.service.createTask({ groupId: 'independent-group', requestId: 'independent-create', title: '任务二', objective: '检查任务二' }))
  await t.step(async () => host.service.whenIdle())
  const a = await t.step(async () => host.query('task.get', { taskId: first.taskId })), b = await t.step(async () => host.query('task.get', { taskId: second.taskId }))
  const params = { taskId: first.taskId, progressImpact: 'replan', expectedRequirementRevision: a.requirementRevision, expectedControlRevision: a.controlRevision }
  block = true
  const pending = host.service.appendTaskContext({ ...params, requestId: 'serial-first', context: '第一条变更' })
  await t.step(async () => waitUntil(() => entered, '第一任务修订进入门闩', 5000))
  const duplicateRevision = host.service.appendTaskContext({ ...params, requestId: 'serial-second', context: '第二条变更' }).then(value => ({ value }), error => ({ error }))
  const independent = await t.step(async () => host.service.appendTaskContext({ taskId: second.taskId, requestId: 'independent-replan', progressImpact: 'replan',
    expectedRequirementRevision: b.requirementRevision, expectedControlRevision: b.controlRevision, context: '独立任务变更' }))
  assert.equal(independent.taskId, second.taskId)
  assert.equal((await t.step(async () => host.query('task.get', { taskId: first.taskId }))).requirementRevision, a.requirementRevision)
  assert.equal(ownerRuns.get(first.taskId), 1)
  gate.resolve()
  await t.step(async () => pending)
  const result = await t.step(async () => duplicateRevision)
  assert.ok(result.error)
  assert.equal(result.error.code, 'TASK_TOPIC_WEB_topic-busy')
  await t.step(async () => host.service.whenIdle())
  assert.equal((await t.step(async () => host.query('task.get', { taskId: first.taskId }))).requirementRevision, a.requirementRevision + 1)
  assert.equal((await t.step(async () => host.query('task.get', { taskId: second.taskId }))).requirementRevision, b.requirementRevision + 1)
  assert.equal(ownerRuns.get(first.taskId), 2)
  assert.equal(ownerRuns.get(second.taskId), 2)
}))

testRunner('failed old-drain ends its timing and releases admission for later work', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'old-drain-failure-'))
  let host, cancelAttempts = 0, runs = 0
  const sessions = {
    async run({ submit }) { runs++; await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } },
    async cancel() { if (++cancelAttempts === 1) throw Object.assign(new Error('fixture cancel failed'), { code: 'FIXTURE_CANCEL_FAILED' }) },
    async close() {},
  }
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: args => openTaskSessionService({ ...args, taskSessions: sessions }),
  }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'drain-create', title: '排空测试', objective: '检查排空' }))
  await t.step(async () => host.service.whenIdle())
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const request = { taskId: task.taskId, requestId: 'drain-replan', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '排空失败后补充' }
  await t.step(async () => assert.rejects(host.service.appendTaskContext(request), /fixture cancel failed/))
  const source = (await t.step(async () => host.query('source.list'))).find(item => item.text === request.context)
  const drain = source?.stages?.find(stage => stage.stage === 'host' && stage.phase === 'old-drain')
  const overall = source?.stages?.find(stage => stage.stage === 'host' && !stage.phase && stage.requestId === drain?.requestId)
  assert.ok(drain?.completedAt && overall?.completedAt)
  assert.ok(Date.parse(drain.completedAt) <= Date.parse(overall.completedAt))
  const failedTopic = host.residentStore.listTopics('native-group').find(topic => topic.decisions.some(record => record.error === 'fixture cancel failed'))
  const failedDecision = failedTopic.decisions.find(record => record.error === 'fixture cancel failed')
  assert.equal(failedDecision.status, 'failed')
  assert.equal(failedDecision.operations[0].status, 'applied')
  assert.equal(failedDecision.operations[0].reconciled, true)
  assert.ok(Date.parse(failedDecision.nextRetryAt) > Date.now())
  await t.step(async () => assert.rejects(host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-busy', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision + 1, expectedControlRevision: before.controlRevision, context: '不得绕过重试' }), { code: 'TASK_TOPIC_WEB_topic-busy' }))
  await t.step(async () => host.residentStore.updateTopicDecision({ groupId: 'native-group', topicId: failedTopic.topicId, decisionId: failedDecision.decisionId,
    patch: { nextRetryAt: new Date(0).toISOString() } }))
  await t.step(async () => host.service.recover())
  await t.step(async () => host.service.whenIdle())
  const current = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const later = await t.step(async () => host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-later', progressImpact: 'replan',
    expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision, context: '稍后继续处理' }))
  assert.equal(later.taskId, task.taskId)
  await t.step(async () => host.service.whenIdle())
  assert.ok(cancelAttempts >= 2)
  assert.ok(runs >= 2)
}))

testRunner('Web material failure recovers once and retries the same request without repeating work', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-material-recovery-'))
  let host, store, target, runs = 0, injected = false, restarting = false, originalSubmission
  const sessions = {
    async run({ submit }) { runs++; await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } },
    async cancel() {}, async close() {},
  }
  t.after(async () => { await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  const options = { serviceFactory: async args => {
    const submitWebTaskInput = args.residentStore.submitWebTaskInput
    args.residentStore.submitWebTaskInput = input => {
      if (input.requestId !== 'material-revision' || restarting) return submitWebTaskInput(input)
      const topicRefs = input.topicRefs.map(ref => Object.fromEntries(Object.entries(ref).reverse()))
      const action = Object.fromEntries(Object.entries({ ...input.action, topicRefs }).reverse())
      originalSubmission = structuredClone({ ...input, action, topicRefs })
      return submitWebTaskInput(originalSubmission)
    }
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: !restarting, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      const result = await store.command(request)
      if (request.kind === 'task.revise' && !injected) {
        injected = true
        const task = result.result.task, sourceId = task.sourceRefs.at(-1)
        const directories = await taskDirectories(root, task.taskId, { create: true })
        const digest = createHash('sha256').update(JSON.stringify(sourceId)).digest('hex').slice(0, 32)
        target = join(directories.materials, `source-${digest}.json`)
        await mkdir(target)
      }
      return result
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
  } }
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'material-create', title: '材料检查', objective: '检查材料' }))
  await t.step(async () => host.service.whenIdle())
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const request = { taskId: task.taskId, requestId: 'material-revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '更新检查要求' }
  await t.step(async () => assert.rejects(host.service.appendTaskContext(request), /TASK_MATERIAL_PATH_INVALID/))
  await t.step(async () => host.service.whenIdle())
  const revised = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  assert.equal(revised.requirementRevision, before.requirementRevision + 1)
  assert.equal(runs, 1)
  const failedSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === request.context)
  const originalFingerprint = fingerprint({ text: originalSubmission.text, action: originalSubmission.action, topicRefs: originalSubmission.topicRefs })
  const legacyRecord = host.residentStore.listTopics('native-group').flatMap(topic => topic.decisions).find(record => record.fingerprint === originalFingerprint)
  assert.ok(legacyRecord && legacyRecord.status !== 'completed')
  const canonicalAction = failedSource.requestIdentity.action
  assert.notEqual(fingerprint({ text: originalSubmission.text, action: canonicalAction, topicRefs: canonicalAction.topicRefs }), originalFingerprint)
  const failedMaterial = failedSource?.stages?.find(stage => stage.stage === 'host' && stage.phase === 'materialize')
  const failedHost = failedSource?.stages?.find(stage => stage.stage === 'host' && !stage.phase && stage.requestId === failedMaterial?.requestId)
  assert.ok(failedMaterial?.completedAt && failedHost?.completedAt, '材料失败后阶段与 Host 均须真实落终止时间')
  assert.ok(Date.parse(failedMaterial.startedAt) <= Date.parse(failedMaterial.completedAt))
  assert.ok(Date.parse(failedMaterial.completedAt) <= Date.parse(failedHost.completedAt))
  await t.step(async () => host.close()); await t.step(async () => store.close()); host = undefined; store = undefined
  await t.step(async () => rmdir(target))
  restarting = true
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options))
  const reordered = { context: request.context, expectedControlRevision: request.expectedControlRevision, expectedRequirementRevision: request.expectedRequirementRevision,
    progressImpact: request.progressImpact, requestId: request.requestId, taskId: request.taskId }
  assert.equal((await t.step(async () => host.service.appendTaskContext(reordered))).taskId, task.taskId)
  await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
  assert.equal(JSON.parse(await t.step(async () => readFile(target, 'utf8'))).taskId, task.taskId)
  assert.equal(runs, 2)
  assert.equal((await t.step(async () => host.service.appendTaskContext(reordered))).taskId, task.taskId)
  const recoveredRecord = host.residentStore.listTopics('native-group').flatMap(topic => topic.decisions).find(record => record.decisionId === legacyRecord.decisionId)
  assert.equal(recoveredRecord.fingerprint, originalFingerprint)
  await t.step(async () => assert.rejects(host.service.appendTaskContext({ ...reordered, context: '不同内容' }), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' }))
  await t.step(async () => host.service.whenIdle())
  assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).requirementRevision, revised.requirementRevision)
  assert.equal(runs, 2)
}))

testRunner('Web replan blocks a new Owner while old-generation cancellation is in flight', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const releaseQuery = Promise.withResolvers(), releaseNew = Promise.withResolvers()
t.onCancel(() => releaseNew.resolve())

t.onCancel(() => releaseQuery.resolve())

  let host, store, intercept = false, blocked = false, runs = 0, accepted = false, started = false
  const cancellations = []
  const sessions = {
    async run({ submit }) {
      runs++
      if (runs === 1) {
        await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] })
        return { status: 'submitted' }
      }
      started = true
      await releaseNew.promise
      await submit({ action: 'wait', summary: '等待补充', evidence: [], limitations: [] })
      return { status: 'submitted' }
    },
    async cancel(taskId) { cancellations.push({ taskId, runs }) },
    async close() { releaseNew.resolve() },
  }
  const root = await mkdtemp(join(tmpdir(), 'web-replan-query-gate-'))
  t.after(async () => { releaseQuery.resolve(); releaseNew.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: async args => {
      store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
      const proxy = { ...store,
        async command(request) {
          const result = await store.command(request)
          if (request.kind === 'task.revise') intercept = true
          return result
        },
        async query(request) {
          if (intercept && !blocked && request.kind === 'execution.list' && request.taskId) {
            blocked = true
            await releaseQuery.promise
          }
          return store.query(request)
        },
      }
      return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
    },
  }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'query-gate-create', title: '检查文件', objective: '检查文件' }))
  await t.step(async () => host.service.whenIdle())
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'query-gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '新增文件名称检查' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(() => blocked, 'execution.list 门闩已进入', 5000))
  await t.step(async () => new Promise(resolve => setImmediate(resolve)))
  assert.equal(runs, 1, '旧代取消边界未完成时不能启动新 Owner')
  assert.equal(accepted, false)
  const pendingSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === '新增文件名称检查')
  const pendingDrain = pendingSource?.stages?.find(stage => stage.stage === 'host' && stage.phase === 'old-drain')
  assert.equal(pendingDrain?.completedAt, null, '排空仍被门闩阻塞时必须保持 open')
  assert.equal(pendingDrain.quality, 'open')
  await t.step(async () => assert.rejects(host.service.store.command({ id: 'invalid-host-phase', kind: 'source.stage', args: { sourceId: pendingSource.sourceId,
    stage: { spanId: 'invalid-host-phase', stage: 'host', phase: 'unknown', requestId: 'fixture', attempt: 0, startedAt: new Date().toISOString() } } }),
  { code: 'DYNAMIC_SOURCE_STAGE_INVALID' }))
  releaseQuery.resolve()
  await t.step(async () => waitUntil(() => started, '新 Owner 已启动', 5000))
  await t.step(async () => waitUntil(() => accepted, '新 Owner 未结束时接纳应返回', 5000))
  assert.deepEqual(cancellations.map(item => item.runs), [1], '新 Owner 不得被旧代取消')
  assert.equal((await t.step(async () => pending)).taskId, task.taskId)
  const revisedSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === '新增文件名称检查')
  const stages = revisedSource?.stages?.filter(stage => stage.stage === 'host') ?? []
  const phases = ['task-commit', 'old-drain', 'materialize'].map(phase => stages.find(stage => stage.phase === phase))
  const overall = stages.find(stage => !stage.phase && phases.every(phase => phase?.requestId === stage.requestId))
  assert.ok(overall?.completedAt, 'Host 总阶段必须有真实终止时间')
  for (const phase of phases) {
    assert.ok(phase?.completedAt && phase.quality === 'observed')
    assert.ok(Date.parse(overall.startedAt) <= Date.parse(phase.startedAt))
    assert.ok(Date.parse(phase.startedAt) <= Date.parse(phase.completedAt))
    assert.ok(Date.parse(phase.completedAt) <= Date.parse(overall.completedAt))
  }
  for (let index = 1; index < phases.length; index++) assert.ok(Date.parse(phases[index - 1].completedAt) <= Date.parse(phases[index].startedAt))
  releaseNew.resolve()
  await t.step(async () => host.service.whenIdle())
}))

testRunner('Web replan drains the old Owner without waiting for the new Owner', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const oldEntered = Promise.withResolvers(), releaseOld = Promise.withResolvers()
t.onCancel(() => releaseOld.resolve())

  const newEntered = Promise.withResolvers(), releaseNew = Promise.withResolvers()
t.onCancel(() => releaseNew.resolve())

  let turns = 0, accepted = false, newFinished = false
  t.after(() => { releaseOld.resolve(); releaseNew.resolve() })
  const h = await extraHost(t, 'web-replan-owner-gates-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    if (++turns === 1) { oldEntered.resolve(); await releaseOld.promise }
    else { newEntered.resolve(); await releaseNew.promise; newFinished = true }
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待补充', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'gate-create', title: '检查文件', objective: '检查文件并等待补充' }))
  await t.step(async () => oldEntered.promise)
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  const pending = h.service.appendTaskContext({ taskId: created.taskId, requestId: 'gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision, context: '补充检查文件名称' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(async () => (await h.query('task.get', { taskId: created.taskId })).requirementRevision > original.requirementRevision, 'replan 已提交', 5000))
  assert.equal(accepted, false, '旧 Owner 尚未排空时不能接纳')
  releaseOld.resolve()
  await t.step(async () => newEntered.promise)
  await t.step(async () => waitUntil(() => accepted, '新 Owner 尚未结束时接纳应返回', 5000))
  assert.equal(newFinished, false)
  const result = await t.step(async () => pending)
  assert.equal(result.taskId, created.taskId)
  releaseNew.resolve()
  await t.step(async () => h.service.whenIdle())
}))

testRunner('native Web Topic edits reject stale requirement and control revisions without changing task or topics', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const h = await extraHost(t, 'task-topic-web-stale-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续补充', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'web-create', title: 'Web 文件检查', objective: '检查文件并等待补充' }))
  await t.step(async () => h.service.whenIdle())
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(original.requirementRevision, 1)
  await t.step(async () => h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '新增文件名称检查要求' }))
  await t.step(async () => h.service.whenIdle())
  const revised = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(revised.requirementRevision, 2)
  const topics = h.residentStore.listTopics('native-group')
  assert.equal(topics.length, 1, 'Successful Web supplement retains the original Topic and source identity')
  const topicSnapshot = JSON.stringify(topics)
  await t.step(async () => assert.rejects(h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-stale-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '这条过期补充必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' }))
  await t.step(async () => assert.rejects(h.service.cancelTask({ taskId: created.taskId, requestId: 'web-stale-cancel', expectedRequirementRevision: revised.requirementRevision,
    expectedControlRevision: revised.controlRevision - 1, reason: '过期控制版本必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' }))
  const unchanged = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(unchanged.requirementRevision, revised.requirementRevision)
  assert.equal(unchanged.controlRevision, revised.controlRevision)
  assert.equal(unchanged.control, revised.control)
  assert.equal(unchanged.request, revised.request)
  assert.equal(JSON.stringify(h.residentStore.listTopics('native-group')), topicSnapshot)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
}))

testRunner('business notices 423–424 and named owners remain in the original Topic without assistant tasks or replies', { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  let topicId
  const h = await extraHost(t, 'business-topic-context-', async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const prompt = JSON.stringify(request)
    assert.ok(prompt.includes('话题归属与助手动作分开判断'))
    assert.ok(prompt.includes('不唤醒已有任务'))
    assert.ok(prompt.includes('不能自动作为本助手任务完成证据'))
    if (names.includes('group_topic_route_submit')) {
      assert.ok(prompt.includes('不能把“未交给本助手”当成“职责外”'))
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
        units: [{ unitKey: 'lci', summary: 'LCI 单位修复的讨论和处理记录', sourceRefs: [{ wholeMessage: true }], topics: [topicId ? { topicId } : { newTopicKey: 'lci', title: 'LCI 单位修复' }] }] })) })]
    }
    assert.ok(names.includes('group_decision_submit'))
    return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
      decision: { basisMessageIds: [...new Set(input.messages.map(item => item.messageId))], actions: [], reason: '同一业务事项由同事负责，保留完整上下文，不承接、不追问、不回复',
        topicUpdate: { summary: [input.summary, ...input.messages.map(item => item.text)].filter(Boolean).join('；') } } } }]
  })
  await t.beginBusiness()

  await t.step(async () => h.residentStore.updateGroup({ groupId: 'native-group', personAliases: [{ alias: '小甲', name: '测试成员甲' }] }))
  const texts = [
    ['lci-start', 'LCI 单位缺失问题正在讨论'],
    ['notice-423', '@测试成员乙 @测试成员丙 已修复 LCI 单位缺失并发布测试环境'],
    ['notice-424', '@测试成员丁 LCI 任务已创建，开始处理。任务codex:example — 另一测试助手'],
    ['named-owner', '后续 LCI 验收交给测试成员乙处理'],
    ['named-reference', '看小甲发的应该是这样吧'],
  ]
  for (const [messageId, text] of texts) {
    await t.step(async () => h.service.ingest({ ...message(messageId, text), ...(topicId ? { quotedMessage: { messageId: 'lci-start', content: texts[0][1] } } : {}) }))
    await t.step(async () => h.service.whenIdle())
    topicId ??= h.residentStore.listTopics('native-group')[0].topicId
  }
  const topics = h.residentStore.listTopics('native-group')
  assert.equal(topics.length, 1)
  assert.deepEqual(resolveTopicMessages(h.residentStore.getGroup('native-group'), topicId, topics[0].revision).map(item => [item.messageId, item.text]), texts)
  assert.ok(topics[0].summary.includes(texts.at(-1)[1]))
  assert.ok(topics[0].decisions.every(record => record.status === 'completed' && record.decision.actions.length === 0 && !record.decision.reply))
  assert.equal(topics[0].revision, topics[0].processedRevision)
  assert.equal((await t.step(async () => h.residentStore.listFixedTopicMessagesPage({ groupId: 'native-group', topicId: 'out-of-scope' }))).total, 0)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0); assert.equal(h.sent.length, 0)
  const before = JSON.stringify(topics)
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(JSON.stringify(h.residentStore.listTopics('native-group')), before)
  assert.equal(h.sent.length, 0)
}))

// Prompt assertions check the guidance delivered to the model. Scripted choices
// below verify the real context/action pipeline, not free-running model semantics.
testRunner('scripted native aggregation keeps list requirements, screenshot delivery and later acceptance in one Topic and Task',
  { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
    const initial = '测试助手，请把资料列表按更新时间倒序，并增加标题关键字筛选，作为本轮列表优化一起交付。'
    const inputs = [['list-work', initial], ['screenshot-delivery', '这轮列表优化完成后，请附上验收通过的截图。'], ['acceptance-addition', '再补一项验收：筛选没有匹配项时显示空状态。']]
    const initialCriteria = ['记录按更新时间倒序', '标题关键字筛选生效']
    const extraCriteria = { 'screenshot-delivery': '交付验收通过的截图', 'acceptance-addition': '筛选无匹配项时显示空状态' }
    const summary = '资料列表整体优化，包含最近优先和标题筛选，后续验收与截图仍沿原事项。'
    let topicId, taskId, rounds = 0
    const h = await extraHost(t, 'matter-aggregation-', async request => {
      assert.ok(++rounds < 30)
      const input = latestInput(request), names = request.tools.map(tool => tool.name), prompt = JSON.stringify(request.messages)
      if (input.trigger === 'task-facts' || input.requestId?.startsWith('coord-summary-')) return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) {
        for (const rule of ['按共同业务事项和目标聚合Topic', '不能仅因可独立验收', '同一页面或截图只是上下文线索', '后续截图、验收和交付要求沿原事项补充']) assert.ok(prompt.includes(rule), rule)
        assert.equal(prompt.includes('才将可独立补充、取消、验收或反馈的事项'), false)
        if (topicId) {
          assert.equal(input.relatedTopics[0].topicId, topicId)
          assert.equal(input.relatedTopics[0].summary, summary)
          assert.equal(input.messages[0].quotedMessage.messageId, 'list-work')
        }
        return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({
          messageId: item.messageId, messageVersion: item.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'list-work', summary: '资料列表整体优化', sourceRefs: [{ quote: item.text }], topics: [topicId ? { topicId } : { newTopicKey: 'list-work', title: '资料列表优化' }] }],
        })) })]
      }
      if (names.includes('group_decision_submit')) {
        for (const rule of ['不逐功能点创建Task', '优先按任务状态使用task-context/task-reopen', '同一事项的后续截图交付沿原Task补充', '内部并行交给同一Owner的执行会话', 'Unit用于引用来源，不是逐项建Task的指令']) assert.ok(prompt.includes(rule), rule)
        assert.ok(JSON.stringify(request.tools.find(tool => tool.name === 'group_decision_submit').parameters).includes('不逐功能点创建'))
        assert.equal(input.messages.length, 1, 'only the current requirement is inline alongside the Topic summary')
        const current = input.messages[0], values = modelToolValues(request)
        let task, candidates = []
        if (taskId) {
          assert.equal(input.linkedTasks.total, 1); assert.equal(input.linkedTasks.snapshots[0].taskId, taskId)
          assert.equal(input.linkedTasks.snapshots[0].objective, undefined)
          task = values.flatMap(value => value.tasks ?? []).find(task => task.taskId === taskId)
          if (!task) return [call(input.linkedTasks.reads[0].readCall.name, input.linkedTasks.reads[0].readCall.arguments)]
          const review = values.find(value => Array.isArray(value.candidates))
          if (!review) return [call('group_reply_review_get', {})]
          candidates = review.candidates.map(value => value.outboundId)
        }
        const topicRefs = [{ topicId: input.topicId, revision: input.revision }]
        const action = task ? { kind: 'task-context', taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
          context: current.text, progressImpact: 'replan', acceptanceCriteria: [...task.acceptanceCriteria, extraCriteria[current.messageId]], topicRefs }
          : { kind: 'new-task', title: '资料列表优化', objective: initial, acceptanceCriteria: initialCriteria, topicRefs }
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: [current.messageId], actions: [action], topicUpdate: { summary }, reply: task ? '补充要求已并入原事项。' : '已承接这轮列表优化。', replyToMessageId: current.messageId,
            replyReview: { kind: 'confirmation', reviewedOutboundIds: candidates, sameMatterOutboundIds: candidates, replaceOutboundIds: candidates } } } }]
      }
      return [call('task_session_submit', { decision: { action: 'wait', summary: '等待测试资料', evidence: [], limitations: [] } })]
    })
    await t.beginBusiness()

    for (const [messageId, text] of inputs) {
      await t.step(async () => h.service.ingest({ ...message(messageId, text), ...(topicId ? { quotedMessage: { messageId: 'list-work', content: initial } } : {}) }))
      await t.step(async () => h.service.whenIdle())
      const topics = h.residentStore.listTopics('native-group'), tasks = await t.step(async () => h.query('task.list'))
      assert.equal(topics.length, 1); assert.equal(tasks.length, 1)
      topicId ??= topics[0].topicId; taskId ??= tasks[0].taskId
      assert.equal(tasks[0].taskId, taskId); assert.equal(tasks[0].topicRefs[0].topicId, topicId)
    }
    const task = await t.step(async () => h.query('task.get', { taskId })), topic = h.residentStore.getTopic('native-group', topicId)
    assert.equal(task.requirementRevision, 3)
    assert.equal(task.objective, initial)
    assert.deepEqual(task.requirements, [...initialCriteria, ...Object.values(extraCriteria)])
    assert.deepEqual(topic.decisions.flatMap(record => record.decision.actions.map(action => action.kind)), ['new-task', 'task-context', 'task-context'])
    assert.equal(h.toolResults.filter(item => item.name === 'group_task_context_get').length, 2)
    assert.equal(h.toolResults.some(item => ['group_task_list', 'group_topic_context_get'].includes(item.name)), false, 'sufficient summary/quote context does not force catalogue or full history reads')
    assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
  }))

testRunner('scripted native routing checks scope before reusing an old Topic and reconsiders a new technical matter', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  let routeTurns = 0, decisionTurns = 0, oldTopicId
  const technical = '另外资料列表保存报错，测试成员乙负责排查。'
  const h = await extraHost(t, 'topic-scope-', async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      routeTurns++
      const prompt = request.messages.flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      assert.match(prompt, /复用旧Topic前也必须核对职责范围/)
      assert.match(prompt, /既往职责外分类不永久继承/)
      assert.match(prompt, /职责内具体事项无论交给谁处理，都保留在对应业务 Topic/)
      assert.ok(input.topics.some(topic => topic.topicId === oldTopicId))
      if (routeTurns === 1) assert.equal(input.relatedTopics[0].topicId, oldTopicId)
      else assert.ok(input.recentMessages.some(message => message.messageId === 'expense-followup'))
      assert.ok(JSON.stringify(input.recentMessages).length <= 4_000)
      const source = input.messages[0], mixed = source.text.includes(technical)
      return [call('group_topic_route_submit', { requestId: input.requestId, routes: [{ messageId: source.messageId, messageVersion: source.messageVersion,
        units: [{ unitKey: 'expense', summary: '同事间票据整理', sourceRefs: [{ quote: mixed ? '可以了。' : source.text }],
          topics: [], fixedTopic: 'out-of-scope', reason: '引用和前序对话表明是报销协作，旧话题不能覆盖技术职责边界' },
        ...(mixed ? [{ unitKey: 'technical', summary: '资料列表保存报错', sourceRefs: [{ quote: technical }], topics: [{ newTopicKey: 'save-error', title: '资料列表保存故障' }] }] : [])] }] })]
    }
    if (names.includes('group_decision_submit')) {
      decisionTurns++
      assert.equal(input.messages.length, 1)
      assert.equal(input.messages[0].text, technical)
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [input.messages[0].messageId], actions: [], reason: '技术事项保留业务上下文，明确由同事排查，无需助手动作' } })]
    }
    throw new Error('unexpected execution session')
  })
  await t.beginBusiness()

  await t.step(async () => h.residentStore.updateGroup({ groupId: 'native-group', responsibility: '负责业务系统技术问题排查及实现' }))
  await t.step(async () => h.residentStore.ingest(message('expense-origin', '差旅报销单的电子票据请由同事统一上传。')))
  await t.step(async () => h.residentStore.routeMessages({ groupId: 'native-group', routeId: 'historical-route', routingRevision: h.residentStore.getGroup('native-group').routingRevision,
    routes: [{ messageId: 'expense-origin', messageVersion: 1, topics: [{ newTopicKey: 'expense', title: '差旅票据报销协作' }] }] }))
  oldTopicId = h.residentStore.listTopics('native-group')[0].topicId
  await t.step(async () => h.residentStore.acceptTopicDecision({ groupId: 'native-group', topicId: oldTopicId, revision: 1, decisionId: 'historical-decision',
    decision: { actions: [], reason: '历史分类', topicUpdate: { summary: '同事核对电子票据、删除旧附件后统一上传。' } } }))
  await t.step(async () => h.residentStore.completeTopicDecision({ groupId: 'native-group', topicId: oldTopicId, decisionId: 'historical-decision' }))
  for (const source of [
    { ...message('expense-followup', '旧附件已删除，请统一上传。'), quotedMessage: { messageId: 'expense-origin', content: '电子票据请统一上传' } },
    message('expense-short', '试试'), message('mixed-followup', '可以了。' + technical),
  ]) { await t.step(async () => h.service.ingest(source)); await t.step(async () => h.service.whenIdle()) }
  assert.equal(routeTurns, 3)
  assert.equal(decisionTurns, 1, 'only the new technical matter needs a business decision')
  assert.equal(h.residentStore.getTopic('native-group', oldTopicId).revision, 1)
  const outside = await t.step(async () => h.residentStore.listFixedTopicMessagesPage({ groupId: 'native-group', topicId: 'out-of-scope' }))
  assert.equal(outside.total, 3)
  assert.ok(outside.items.every(item => item.state === 'silent'))
  assert.equal(h.sent.length, 0)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
}))

testRunner('scripted native routing permits distinct delivery goals on the same page',
  { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
    const parts = ['资料列表的检索体验优化单独排期；', '同一资料列表的权限风险另做审计报告。']
    const h = await extraHost(t, 'independent-page-matters-', async request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      if (names.includes('group_topic_route_submit')) {
        assert.ok(JSON.stringify(request.messages).includes('确有不同业务目标或独立交付约定时可分Topic'))
        return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
          replyTopic: { newTopicKey: 'work-0' }, ignoredRefs: [], units: parts.map((quote, index) => ({ unitKey: 'work-' + index, summary: ['检索体验优化', '权限风险审计'][index],
            sourceRefs: [{ quote }], topics: [{ newTopicKey: 'work-' + index, title: ['检索体验优化', '权限风险审计'][index] }] })) })) })]
      }
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '保留两个独立交付约定，当前未要求助手执行' } })]
    })
    await t.beginBusiness()

    await t.step(async () => h.service.ingest(message('independent-page-work', parts.join('')))); await t.step(async () => h.service.whenIdle())
    assert.deepEqual(h.residentStore.listTopics('native-group').map(topic => topic.title), ['检索体验优化', '权限风险审计'])
    assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  }))

// The model decisions are scripted; this exercises the native context and task pipeline.
testRunner('native Topic context accepts a requirement that only mentions notification recipients', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  let topicId, historyRead = false
  const assignment = '测试助手，列表功能的明确展示需求由你实现，测试成员甲和测试成员乙接收同步。'
  const summary = '助手负责实现列表需求，两位成员接收同步，等待具体展示要求。'
  const requirement = '@测试成员甲 @测试成员乙 状态列需要显示等待中的记录。'
  const h = await extraHost(t, 'topic-participation-', async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({
      messageId: item.messageId, messageVersion: item.messageVersion, topics: [topicId ? { topicId } : { newTopicKey: 'list', title: '列表状态展示' }],
    })) })]
    if (names.includes('group_decision_submit')) {
      if (input.trigger === 'task-facts') return topicTaskCalls(request)
      const current = input.messages.at(-1)
      if (current.messageId === 'assignment') return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: [current.messageId], actions: [], reason: '等待具体需求', topicUpdate: { summary } } } }]
      assert.equal(current.text, requirement)
      assert.equal(input.summary, summary)
      assert.equal(input.historyAvailable, true)
      assert.equal(input.linkedTasks.total, 0)
      if (!historyRead) { historyRead = true; return [call('group_topic_context_get', {})] }
      assert.ok(modelToolValues(request, 'group_topic_context_get').some(value => value.messages?.some(item => item.text === assignment)), '原分工必须可从真实上下文工具读回')
      return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: ['assignment', current.messageId], topicUpdate: { summary: '原分工由助手实现，当前需求明确，同事仅同步，已承接列表状态任务。' },
          actions: [{ kind: 'new-task', title: '列表状态展示', objective: '在列表状态列显示等待中的记录', acceptanceCriteria: ['等待中的记录可见'], topicRefs: [{ topicId: input.topicId, revision: input.revision }] }],
          reply: '已承接列表状态展示需求。', replyToMessageId: current.messageId,
          replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
    }
    assert.ok(names.includes('task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续测试资料', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message('assignment', assignment))); await t.step(async () => h.service.whenIdle())
  topicId = h.residentStore.listTopics('native-group')[0].topicId
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  await t.step(async () => h.service.ingest(message('requirement', requirement))); await t.step(async () => h.service.whenIdle())
  assert.equal(historyRead, true)
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  assert.ok(tasks[0].topicRefs.some(ref => ref.topicId === topicId))
  const topic = h.residentStore.getTopic('native-group', topicId)
  const decision = topic.decisions.find(item => item.decision.actions.some(action => action.kind === 'new-task'))
  assert.equal(decision.status, 'completed')
  assert.deepEqual(decision.decision.basisMessageIds, ['assignment', 'requirement'])
  assert.equal(h.sent.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
}))

testRunner('native proposal prompt preserves original authorization and asks without claiming task execution', { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  let checked = false
  const h = await extraHost(t, 'task-topic-proposal-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'proposal', title: '描述框位置调整' }] })) })]
    assert.ok(names.includes('group_decision_submit'))
    const prompt = JSON.stringify(request)
    for (const rule of ['结合需求原文、引用、已有任务及前后分工判断', '不能把最后一个 @ 当作事项负责人', '不因当前只 @ 同事或省略助手称呼而重复索要确认', '才选择 task-proposal', '这个事项是否需要我处理？', '暂不创建任务', '不承诺', '没你的事', '不是找你', 'topicUpdate.summary 记录承接或静默的判断及分工依据', '测试助手', '不追加未经授权的业务验收']) assert.ok(prompt.includes(rule), rule)
    for (const rule of ['不能只因 @ 别人就硬过滤', '已有任务的新事实仍归原业务 Topic', '仅提到人名不等于指定负责人']) assert.ok(prompt.includes(rule), rule)
    assert.ok(prompt.includes('仍保留对应业务 Topic 的完整上下文'))
    assert.ok(!prompt.includes('未指向 Agent 时必须忽略'))
    checked = true
    return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [{ kind: 'task-proposal', title: '描述框位置调整', objective: '按原图将描述框放在文字右侧并顶部对齐', topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '这个事项是否需要我处理？', replyToMessageId: input.messages.at(-1).messageId, replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message('proposal-only', '合并后描述输入框放在该项文字右侧，和文字顶部对齐。')))
  await t.step(async () => h.service.whenIdle())
  assert.equal(checked, true)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  const topic = h.residentStore.listTopics('native-group')[0]
  assert.equal(topic.decisions[0].decision.actions[0].kind, 'task-proposal')
  assert.equal(topic.decisions[0].status, 'completed')
  assert.equal(topic.summary, '围绕原始事项持续核对，当前结论以任务真实进展为准。')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].kind, 'topic-reply')
  assert.ok(h.sent[0].payload.text.includes('这个事项是否需要我处理？'))
  await t.step(async () => h.service.retryMessage({ groupId: 'native-group', messageId: 'proposal-only' })); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal(h.sent.length, 1)
}))

testRunner('native Web reopen preserves task identity and rejects stale input; HTTP retry is idempotent', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  await t.beginBusiness()
  const { createServer } = await t.step(async () => import('node:http'))
  const { handleRequest } = await t.step(async () => import('../packages/dingtalk-dsh-assistant/http.js'))
  const h = await t.step(async () => extraHost(t, 'web-reopen-', async () => [call('task_session_submit', { decision: { action: 'complete', summary: '原事项已核对', evidence: ['fixture'], limitations: [] } })]))
  const created = await t.step(async () => h.service.createTask({ requestId: 'original', groupId: 'native-group', title: '原PR', objective: '核对原PR', acceptanceCriteria: ['核对完成'] }))
  await t.step(async () => h.service.whenIdle())
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(original.status, 'completed')
  const runtime = { isTaskSessionMode: () => true, getTaskSessionDetail: id => h.service.taskDetail(id), reopenTask: args => h.service.reopenTask(args) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await t.step(async () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/reopen`
  const args = { requestId: 'review-followup', context: '只处理新增审查，保留原提测证据', expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision }
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await t.step(async () => post({ ...args, actorId: 'other' }))).status, 400)
  assert.equal((await t.step(async () => post({ ...args, expectedControlRevision: original.controlRevision + 1 }))).status, 409)
  assert.equal((await t.step(async () => post(args))).status, 200)
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => post(args))).status, 200)
  await t.step(async () => h.service.whenIdle())
  const reopened = await t.step(async () => h.query('task.get', { taskId: original.taskId }))
  assert.equal(reopened.runSequence, original.runSequence + 1)
  assert.equal(reopened.sessionId, original.sessionId)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(reopened.sourceRefs.length, original.sourceRefs.length + 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
}))

testRunner('协调暂停时混合消息拒绝协调来源，普通话题Host重试仍按原版本完成', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixed-semantic-source-'))
  let host, store, blocked = true, routeAttempts = 0
  t.after(async () => { try { await host?.close(); await store?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_topic_route_submit')) {
      const rejectedCandidate = ++routeAttempts === 1
      return [call('group_topic_route_submit', { requestId: input.requestId,
      routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, ignoredRefs: [], units: [
        { unitKey: 'reminder', summary: '查询提醒', sourceRefs: [{ quote: '测试助手，查询提醒；' }],
          ...(rejectedCandidate ? { dispatchOwner: 'coordination', topics: [], reason: '暂停功能候选必须拒绝' } : { topics: [{ newTopicKey: 'file', title: '文件核查' }] }) },
        { unitKey: 'file', summary: '核查文件', sourceRefs: [{ quote: '测试助手，核查文件。' }], topics: [{ newTopicKey: 'file', title: '文件核查' }] },
      ] })) })]
    }
    assert.ok(!names.includes('coordination_submit'))
    return topicTaskCalls(request) ?? [call('task_session_submit', { decision: { action: 'wait', summary: '等待业务核查', evidence: [], limitations: [] } })]
  }, { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } }, serviceFactory: async args => {
    store = await openDynamicTaskStore(args.config)
    return openTaskSessionService({ ...args, store: { ...store, async command(input) {
      if (blocked && input.kind === 'task.create') throw Object.assign(new Error('TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED'), { code: 'TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED' })
      return store.command(input)
    } } })
  } }))
  await t.step(async () => host.service.ingest(message('mixed', '测试助手，查询提醒；测试助手，核查文件。')))
  await t.step(async () => host.service.whenIdle())
  const pending = (await t.step(async () => host.query('source.list'))).find(source => source.messageId === 'mixed')
  assert.equal((await t.step(async () => host.query('task.list'))).length, 0)
  assert.equal(pending.processingCompleted, undefined)
  assert.equal(pending.processingPending, true)
  assert.ok(routeAttempts >= 2)
  assert.equal((await t.step(async () => host.query('coordination.source.list'))).length, 0)
  assert.equal(host.residentStore.listTopics('native-group')[0].decisions[0].status, 'blocked')
  blocked = false
  await t.step(async () => host.service.retryMessage({ groupId: 'native-group', messageId: 'mixed' }))
  await t.step(async () => host.service.whenIdle())
  const completed = (await t.step(async () => host.query('source.list'))).find(source => source.messageId === 'mixed')
  assert.ok(completed.processingCompleted, JSON.stringify({ completed: completed.processingCompleted, topicStatus: host.residentStore.listTopics('native-group').map(topic => ({ processedRevision: topic.processedRevision, decisions: topic.decisions.map(record => ({ status: record.status, error: record.error })) })), alerts: host.service.listAlerts() }))
  assert.equal(completed.processingCompleted.activeUnitRefs.length, 2)
  assert.equal((await t.step(async () => host.query('coordination.source.list'))).length, 0)
  assert.equal((await t.step(async () => host.query('task.list')))[0].status, 'active')
}))
