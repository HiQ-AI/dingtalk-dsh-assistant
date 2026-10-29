import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises'
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

testRunner('来源语义戳在首次Topic完成后落账，不等待同群其他判断',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'source-clock-immediate-'))
    let host, firstDecision, completedMessageId, slowBlocked = false
    const slowEntered = Promise.withResolvers(), releaseSlow = Promise.withResolvers()
    t.after(async () => { releaseSlow.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, async request => {
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
          delete item.args.decision.replyReview
        }
      }
      return calls ?? []
    })
    await Promise.all([host.service.ingest(message('fast-clock', '测试助手，记录物料名称显示反馈。')),
      host.service.ingest(message('slow-clock', '测试助手，记录另一个独立事项。'))])
    await slowEntered.promise
    try {
      await waitUntil(async () => (await host.query('source.list')).find(source => source.messageId === completedMessageId)?.processingCompleted,
        '已完成Topic的来源独立落戳', 5000)
    } catch (error) {
      t.diagnostic(JSON.stringify({ sources: (await host.query('source.list')).map(source => ({ messageId: source.messageId, routed: source.routed,
        processingPending: source.processingPending, processingCompleted: source.processingCompleted })),
        topics: host.residentStore.listTopics('native-group').map(topic => ({ title: topic.title, revision: topic.revision, processedRevision: topic.processedRevision,
          decisions: topic.decisions.map(record => ({ status: record.status, error: record.error, completedAt: record.completedAt })) })), tools: host.toolResults, alerts: host.service.listAlerts() }))
      throw error
    }
    assert.equal(slowBlocked, true)
    const completedTopic = host.residentStore.listTopics('native-group').find(topic => topic.entries.some(entry => entry.messageId === completedMessageId))
    assert.equal(completedTopic.decisions[0].status, 'completed')
    assert.equal(completedTopic.summary, '记录独立反馈，未开展业务动作。')
    const at = (await host.query('source.list')).find(source => source.messageId === completedMessageId).processingCompleted.at
    t.diagnostic(JSON.stringify({ metric: 'settled-topic-to-source-projection', delayMs: Date.parse(at) - Date.parse(completedTopic.decisions[0].completedAt), slowTopicStillBlocked: slowBlocked }))
    assert.ok(Date.parse(at) >= Date.parse(completedTopic.decisions[0].completedAt), '来源戳不能早于真实决策终态')
    assert.equal(host.sent.length, 0, '纯讨论无回复决策不产生通知')
    assert.equal((await host.query('source.list')).find(source => source.messageId === completedMessageId).processingCompleted.at, at)
    releaseSlow.resolve(); await host.service.whenIdle()
    await host.service.recover(); await host.service.whenIdle()
    assert.equal((await host.query('source.list')).find(source => source.messageId === completedMessageId).processingCompleted.at, at)
    assert.equal((await host.query('task.list')).length, 0)
  })

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
  { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
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
    await h.service.ingest(message('contract-source', '固定请求读取合同核验，无需办理业务。'))
    await h.service.whenIdle()
    assert.ok(routed && reviewed && readTopic && wrongRequestChecked)
    assert.ok(h.toolResults.filter(item => item.name === 'group_reply_review_get').some(item => JSON.stringify(item.result).includes('coordination_tool_wrong_request')))
    assert.equal(h.residentStore.listTopics('native-group')[0].decisions[0].status, 'completed')
    assert.equal((await h.query('task.list')).length, 0)
    assert.equal(h.sent.length, 0)
  })

testRunner('native revised Topic supplies current linked Task reads without rescanning the catalogue',
  { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
    let topicId, taskId, contextReads = 0, decisions = 0
    const h = await extraHost(t, 'linked-task-reads-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId,
        routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ topicId }] })) })]
      if (names.includes('group_decision_submit')) {
        assert.equal(input.linkedTasks.total, 1)
        assert.equal(input.linkedTasks.reads[0].taskId, taskId)
        assert.deepEqual(input.linkedTasks.snapshots, [], '大正文不能被截成貌似完整的目标')
        const full = modelToolValues(request).flatMap(value => value.tasks ?? []).find(task => task.taskId === taskId && task.objective)
        if (!full) { contextReads++; return [call(input.linkedTasks.reads[0].readCall.name, input.linkedTasks.reads[0].readCall.arguments)] }
        assert.equal(full.objective, '必须完整核验的原目标'.repeat(800))
        decisions++
        return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '只核对讨论上下文，不执行新动作' } })]
      }
      return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续资料', evidence: [], limitations: [] } })]
    })
    const created = await h.service.createTask({ groupId: 'native-group', requestId: 'linked-original', title: '关联原任务', objective: '必须完整核验的原目标'.repeat(800) })
    await h.service.whenIdle()
    const task = await h.query('task.get', { taskId: created.taskId })
    taskId = task.taskId; topicId = task.topicRefs[0].topicId
    for (const id of ['linked-follow-317', 'linked-follow-318']) {
      await h.service.ingest(message(id, '补充原事项讨论，只核对上下文，不执行新动作。'))
      await h.service.whenIdle()
    }
    assert.equal(decisions, 2)
    assert.equal(contextReads, 2, '每个新版本从当前账本核对全文，不沿用旧会话读过的许可')
    assert.equal(h.toolResults.filter(item => item.name === 'group_task_list').length, 0)
    assert.equal((await h.query('task.list')).length, 1)
    assert.equal((await h.query('task.get', { taskId })).requirementRevision, task.requirementRevision)
    assert.equal(h.sent.length, 0)
    assert.equal(h.residentStore.listTopics('native-group').find(topic => topic.topicId === topicId).processedRevision, 3)
  })

testRunner('native task context reports invalid arguments and reads explicit archived identity', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
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
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'archive-contract-create', title: '归档测试', objective: '敏感原目标不应出现在归档上下文' })
  taskId = created.taskId
  await h.service.whenIdle()
  await h.service.archiveTask({ taskId })
  await h.residentStore.subscribe({ groupId: 'foreign-group', name: '隔离测试群', responsibility: '测试群边界' })
  const foreign = await h.service.createTask({ groupId: 'foreign-group', requestId: 'foreign-archive-create', title: '外群测试', objective: '跨群机密原目标' })
  foreignTaskId = foreign.taskId
  await h.service.whenIdle()
  await h.service.archiveTask({ taskId: foreignTaskId })
  assert.equal((await h.query('task.list')).some(task => task.taskId === taskId), false)
  await h.service.ingest(message('archive-contract-source', '只核对归档身份，无需执行。'))
  await h.service.whenIdle()
  assert.equal(checked, true)
  assert.equal(h.sent.length, 0)
})

testRunner('native batch followup reopens each original completed task and session once from one coordination topic', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  let followup = false
  const reopenedInputs = []
  const h = await extraHost(t, 'task-batch-followup-', async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
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
          reply: '已分别交回两个原任务核查新增审查评论。',
          replyReview: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
        } })]
    }
    assert.ok(names.includes('task_session_submit'))
    if (followup) reopenedInputs.push({ taskId: input.task.taskId, sessionId: input.task.sessionId, request: input.task.request })
    return [call('task_session_submit', { decision: { action: 'complete', summary: followup ? '已核查，无新增适用评论，不修改或提测。' : '原 PR 与 UAT 交付证据。',
      evidence: ['隔离测试完成收据'], limitations: [] } })]
  })
  for (const title of ['dataset 名称校验', 'dataset 关联校验', '无关通知文案']) {
    await h.service.createTask({ groupId: 'native-group', requestId: `seed-${title}`, title, objective: `${title}：完成原 PR 并交付原 UAT` })
    await h.service.whenIdle()
  }
  const originals = await h.query('task.list')
  assert.ok(originals.every(task => task.status === 'completed'))
  followup = true
  const source = message('batch-followup', '测试助手，云端对dataset项目当前活跃的PR做了代码审查，并给出了修复方案，你看看你当前已完成的项目中未合并的PR是否有新的评论，如果有，则逐个按照PR中的评论修改，然后重新提测对应UAT环境')
  await h.service.ingest(source)
  await h.service.whenIdle()
  const after = await h.query('task.list')
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
  await h.service.ingest(source)
  await h.service.recover()
  await h.service.whenIdle()
  assert.equal(reopenedInputs.length, 2)
  assert.deepEqual((await h.query('task.list')).map(task => [task.taskId, task.requirementRevision, task.runSequence]), after.map(task => [task.taskId, task.requirementRevision, task.runSequence]))
})

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
  const firstSource = (await h.query('source.list'))[0]
  assert.equal(firstSource.routed, true)
  assert.ok(firstSource.processingCompleted)
  const firstStages = firstSource.stages
  for (const stage of ['ingress', 'queue', 'turn', 'host', 'send', 'readback']) {
    assert.ok(firstStages.some(item => item.stage === stage && item.completedAt), `missing observed ${stage}: ${JSON.stringify(firstStages)}`)
  }
  assert.ok(firstStages.filter(item => item.stage === 'turn').every(item => item.sessionId && item.spanId.includes(item.sessionId)))
  const dto = (await h.service.messageProcessingSources('native-group')).find(item => item.messageId === first.messageId)
  assert.equal(dto.version, firstSource.version)
  assert.deepEqual(dto.stages.map(item => item.spanId), firstStages.map(item => item.spanId))
  assert.ok(dto.notifications.every(item => item.versionMatched && item.notificationId && item.deliveredAt))
  assert.equal(dto.text, undefined)
  assert.equal(h.service.listAlerts().some(item => item.id?.startsWith('timing:')), false)
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
  const stagesBeforeReplay = (await h.query('source.list')).map(source => ({ sourceId: source.sourceId, stages: source.stages }))
  await h.service.ingest(first)
  await h.service.ingest(second)
  await h.service.recover()
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, before.tasks)
  assert.equal(residentStore.listTopics('native-group').length, before.topics)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).requirementRevision, before.revision)
  assert.equal(h.requests.length, before.requests)
  assert.deepEqual((await h.query('source.list')).map(source => ({ sourceId: source.sourceId, stages: source.stages })), stagesBeforeReplay)
  await waitUntil(async () => (await h.query('source.list')).every(source => source.routed), 'all sources durably marked routed')
  assert.ok(h.toolResults.filter(item => ['group_topic_route_submit', 'group_decision_submit'].includes(item.name)).every(item => !item.result.isError))
  const discussion = residentStore.getGroup('native-group').messages.find(item => item.messageId === 'discussion')
  const discussionSource = (await h.query('source.list')).find(item => item.messageId === discussion.messageId)
  assert.ok(discussionSource.processingCompleted)
  assert.equal(discussionSource.routed, true)
  const discussionTopic = residentStore.listTopics('native-group').find(topic => topic.title === '部署时间讨论')
  await residentStore.routeMessages({ groupId: 'native-group', routeId: 'same-version-reclassification',
    routingRevision: residentStore.getGroup('native-group').routingRevision, routes: [{ messageId: discussion.messageId,
      messageVersion: discussion.messageVersion, units: [{ unitKey: 'whole-message', summary: '重新核对讨论语义',
        sourceRefs: [{ quote: discussion.text }], topics: [{ topicId: discussionTopic.topicId }] }] }] })
  await h.service.recover(); await h.service.whenIdle()
  const reclassified = await h.query('source.get', { sourceId: discussionSource.sourceId })
  assert.equal(reclassified.version, discussionSource.version)
  assert.equal(reclassified.routed, true)
  assert.deepEqual(reclassified.processingHistory, [discussionSource.processingCompleted])
  assert.ok(reclassified.processingCompleted.activeUnitRefs.every(ref => ref.unitRevision === 2))
  assert.equal((await h.query('task.list')).length, before.tasks)
})

async function extraHost(t, prefix, decide) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, decide)
  return host
}

testRunner('Topic外发标识在接纳前被拒绝，原轮修改后只创建一项任务且保留业务编号链接', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
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
  await h.service.ingest(message('business-request-with-identities', '测试助手，核查 PR #253 与订单 SG18 的关联。'))
  await h.service.whenIdle()
  assert.equal(attempts, 6)
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(h.residentStore.listTopics('native-group')[0].decisions.length, 1)
  const rejected = h.toolResults.filter(item => item.name === 'group_decision_submit' && item.result.isError)
  assert.equal(rejected.length, 5)
  assert.ok(rejected.every(item => JSON.stringify(item.result).includes('GROUP_REPLY_INTERNAL_DETAILS')))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].payload.text, publicText)
  assert.equal(h.sent[0].payload.sourceMessageId, 'business-request-with-identities')
})

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

for (const committed of [false, true]) testRunner(`replan fences an execution claim ${committed ? 'after commit' : 'before commit'}`, { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-claim-gate-'))
  const gate = Promise.withResolvers()
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
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
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
  } })
  const task = await host.service.createTask({ groupId: 'native-group', requestId: 'claim-create', title: '领取竞态', objective: '检查任务' })
  await waitUntil(() => entered && ownerDone, '旧 execution claim 与 Owner 已到达门闩', 10000)
  await waitUntil(async () => (await host.query('task.get', { taskId: task.taskId })).drained, '旧 Owner 已排空', 5000)
  const before = await host.query('task.get', { taskId: task.taskId })
  let accepted = false
  const pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'claim-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '更新要求' }).then(value => { accepted = true; return value })
  await waitUntil(() => revised, '任务修订已提交', 5000)
  if (committed) await waitUntil(() => cancels === 1, '已领取 execution 已收到取消', 5000)
  assert.equal(accepted, false)
  assert.equal(claims, 1)
  gate.resolve()
  await pending
  await host.service.whenIdle()
  if (committed) { assert.equal(executionRuns, 1); assert.equal(current, false) }
  else { assert.equal(executionRuns, 0); assert.equal(claimError, 'DYNAMIC_EXECUTION_BUSY') }
  assert.equal((await host.query('task.get', { taskId: task.taskId })).requirementRevision, before.requirementRevision + 1)
  assert.equal(ownerRuns, 2)
})

testRunner('concurrent same-topic revision is busy while a different task makes progress', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-admission-isolation-'))
  const gate = Promise.withResolvers()
  let host, store, entered = false, block = false
  const ownerRuns = new Map()
  const sessions = { async run({ binding, submit }) { ownerRuns.set(binding.taskId, (ownerRuns.get(binding.taskId) ?? 0) + 1); await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } }, async cancel() {}, async close() {} }
  t.after(async () => { gate.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      if (block && request.kind === 'task.revise' && !entered) { entered = true; await gate.promise }
      return store.command(request)
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
  } })
  const first = await host.service.createTask({ groupId: 'native-group', requestId: 'serial-create', title: '任务一', objective: '检查任务一' })
  await host.residentStore.subscribe({ groupId: 'independent-group', name: '独立群', responsibility: '隔离测试' })
  const second = await host.service.createTask({ groupId: 'independent-group', requestId: 'independent-create', title: '任务二', objective: '检查任务二' })
  await host.service.whenIdle()
  const a = await host.query('task.get', { taskId: first.taskId }), b = await host.query('task.get', { taskId: second.taskId })
  const params = { taskId: first.taskId, progressImpact: 'replan', expectedRequirementRevision: a.requirementRevision, expectedControlRevision: a.controlRevision }
  block = true
  const pending = host.service.appendTaskContext({ ...params, requestId: 'serial-first', context: '第一条变更' })
  await waitUntil(() => entered, '第一任务修订进入门闩', 5000)
  const duplicateRevision = host.service.appendTaskContext({ ...params, requestId: 'serial-second', context: '第二条变更' }).then(value => ({ value }), error => ({ error }))
  const independent = await host.service.appendTaskContext({ taskId: second.taskId, requestId: 'independent-replan', progressImpact: 'replan',
    expectedRequirementRevision: b.requirementRevision, expectedControlRevision: b.controlRevision, context: '独立任务变更' })
  assert.equal(independent.taskId, second.taskId)
  assert.equal((await host.query('task.get', { taskId: first.taskId })).requirementRevision, a.requirementRevision)
  assert.equal(ownerRuns.get(first.taskId), 1)
  gate.resolve()
  await pending
  const result = await duplicateRevision
  assert.ok(result.error)
  assert.equal(result.error.code, 'TASK_TOPIC_WEB_topic-busy')
  await host.service.whenIdle()
  assert.equal((await host.query('task.get', { taskId: first.taskId })).requirementRevision, a.requirementRevision + 1)
  assert.equal((await host.query('task.get', { taskId: second.taskId })).requirementRevision, b.requirementRevision + 1)
  assert.equal(ownerRuns.get(first.taskId), 2)
  assert.equal(ownerRuns.get(second.taskId), 2)
})

testRunner('failed old-drain ends its timing and releases admission for later work', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'old-drain-failure-'))
  let host, cancelAttempts = 0, runs = 0
  const sessions = {
    async run({ submit }) { runs++; await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } },
    async cancel() { if (++cancelAttempts === 1) throw Object.assign(new Error('fixture cancel failed'), { code: 'FIXTURE_CANCEL_FAILED' }) },
    async close() {},
  }
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: args => openTaskSessionService({ ...args, taskSessions: sessions }),
  })
  const task = await host.service.createTask({ groupId: 'native-group', requestId: 'drain-create', title: '排空测试', objective: '检查排空' })
  await host.service.whenIdle()
  const before = await host.query('task.get', { taskId: task.taskId })
  const request = { taskId: task.taskId, requestId: 'drain-replan', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '排空失败后补充' }
  await assert.rejects(host.service.appendTaskContext(request), /fixture cancel failed/)
  const source = (await host.query('source.list')).find(item => item.text === request.context)
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
  await assert.rejects(host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-busy', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision + 1, expectedControlRevision: before.controlRevision, context: '不得绕过重试' }), { code: 'TASK_TOPIC_WEB_topic-busy' })
  await host.residentStore.updateTopicDecision({ groupId: 'native-group', topicId: failedTopic.topicId, decisionId: failedDecision.decisionId,
    patch: { nextRetryAt: new Date(0).toISOString() } })
  await host.service.recover()
  await host.service.whenIdle()
  const current = await host.query('task.get', { taskId: task.taskId })
  const later = await host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-later', progressImpact: 'replan',
    expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision, context: '稍后继续处理' })
  assert.equal(later.taskId, task.taskId)
  await host.service.whenIdle()
  assert.ok(cancelAttempts >= 2)
  assert.ok(runs >= 2)
})

testRunner('Web material failure recovers once and retries the same request without repeating work', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
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
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options)
  const task = await host.service.createTask({ groupId: 'native-group', requestId: 'material-create', title: '材料检查', objective: '检查材料' })
  await host.service.whenIdle()
  const before = await host.query('task.get', { taskId: task.taskId })
  const request = { taskId: task.taskId, requestId: 'material-revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '更新检查要求' }
  await assert.rejects(host.service.appendTaskContext(request), /TASK_MATERIAL_PATH_INVALID/)
  await host.service.whenIdle()
  const revised = await host.query('task.get', { taskId: task.taskId })
  assert.equal(revised.requirementRevision, before.requirementRevision + 1)
  assert.equal(runs, 1)
  const failedSource = (await host.query('source.list')).find(source => source.text === request.context)
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
  await host.close(); await store.close(); host = undefined; store = undefined
  await rmdir(target)
  restarting = true
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options)
  const reordered = { context: request.context, expectedControlRevision: request.expectedControlRevision, expectedRequirementRevision: request.expectedRequirementRevision,
    progressImpact: request.progressImpact, requestId: request.requestId, taskId: request.taskId }
  assert.equal((await host.service.appendTaskContext(reordered)).taskId, task.taskId)
  await host.service.recover(); await host.service.whenIdle()
  assert.equal(JSON.parse(await readFile(target, 'utf8')).taskId, task.taskId)
  assert.equal(runs, 2)
  assert.equal((await host.service.appendTaskContext(reordered)).taskId, task.taskId)
  const recoveredRecord = host.residentStore.listTopics('native-group').flatMap(topic => topic.decisions).find(record => record.decisionId === legacyRecord.decisionId)
  assert.equal(recoveredRecord.fingerprint, originalFingerprint)
  await assert.rejects(host.service.appendTaskContext({ ...reordered, context: '不同内容' }), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await host.service.whenIdle()
  assert.equal((await host.query('task.get', { taskId: task.taskId })).requirementRevision, revised.requirementRevision)
  assert.equal(runs, 2)
})

testRunner('Web replan blocks a new Owner while old-generation cancellation is in flight', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const releaseQuery = Promise.withResolvers(), releaseNew = Promise.withResolvers()
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
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
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
  })
  const task = await host.service.createTask({ groupId: 'native-group', requestId: 'query-gate-create', title: '检查文件', objective: '检查文件' })
  await host.service.whenIdle()
  const before = await host.query('task.get', { taskId: task.taskId })
  const pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'query-gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '新增文件名称检查' }).then(value => { accepted = true; return value })
  await waitUntil(() => blocked, 'execution.list 门闩已进入', 5000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 1, '旧代取消边界未完成时不能启动新 Owner')
  assert.equal(accepted, false)
  const pendingSource = (await host.query('source.list')).find(source => source.text === '新增文件名称检查')
  const pendingDrain = pendingSource?.stages?.find(stage => stage.stage === 'host' && stage.phase === 'old-drain')
  assert.equal(pendingDrain?.completedAt, null, '排空仍被门闩阻塞时必须保持 open')
  assert.equal(pendingDrain.quality, 'open')
  await assert.rejects(host.service.store.command({ id: 'invalid-host-phase', kind: 'source.stage', args: { sourceId: pendingSource.sourceId,
    stage: { spanId: 'invalid-host-phase', stage: 'host', phase: 'unknown', requestId: 'fixture', attempt: 0, startedAt: new Date().toISOString() } } }),
  { code: 'DYNAMIC_SOURCE_STAGE_INVALID' })
  releaseQuery.resolve()
  await waitUntil(() => started, '新 Owner 已启动', 5000)
  await waitUntil(() => accepted, '新 Owner 未结束时接纳应返回', 5000)
  assert.deepEqual(cancellations.map(item => item.runs), [1], '新 Owner 不得被旧代取消')
  assert.equal((await pending).taskId, task.taskId)
  const revisedSource = (await host.query('source.list')).find(source => source.text === '新增文件名称检查')
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
  await host.service.whenIdle()
})

testRunner('Web replan drains the old Owner without waiting for the new Owner', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const oldEntered = Promise.withResolvers(), releaseOld = Promise.withResolvers()
  const newEntered = Promise.withResolvers(), releaseNew = Promise.withResolvers()
  let turns = 0, accepted = false, newFinished = false
  t.after(() => { releaseOld.resolve(); releaseNew.resolve() })
  const h = await extraHost(t, 'web-replan-owner-gates-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    if (++turns === 1) { oldEntered.resolve(); await releaseOld.promise }
    else { newEntered.resolve(); await releaseNew.promise; newFinished = true }
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待补充', evidence: [], limitations: [] } })]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'gate-create', title: '检查文件', objective: '检查文件并等待补充' })
  await oldEntered.promise
  const original = await h.query('task.get', { taskId: created.taskId })
  const pending = h.service.appendTaskContext({ taskId: created.taskId, requestId: 'gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision, context: '补充检查文件名称' }).then(value => { accepted = true; return value })
  await waitUntil(async () => (await h.query('task.get', { taskId: created.taskId })).requirementRevision > original.requirementRevision, 'replan 已提交', 5000)
  assert.equal(accepted, false, '旧 Owner 尚未排空时不能接纳')
  releaseOld.resolve()
  await newEntered.promise
  await waitUntil(() => accepted, '新 Owner 尚未结束时接纳应返回', 5000)
  assert.equal(newFinished, false)
  const result = await pending
  assert.equal(result.taskId, created.taskId)
  releaseNew.resolve()
  await h.service.whenIdle()
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

testRunner('native Web reopen preserves task identity and rejects stale input; HTTP retry is idempotent', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const { createServer } = await import('node:http')
  const { handleRequest } = await import('../packages/dingtalk-dsh-assistant/http.js')
  const h = await extraHost(t, 'web-reopen-', async () => [call('task_session_submit', { decision: { action: 'complete', summary: '原事项已核对', evidence: ['fixture'], limitations: [] } })])
  const created = await h.service.createTask({ requestId: 'original', groupId: 'native-group', title: '原PR', objective: '核对原PR', acceptanceCriteria: ['核对完成'] })
  await h.service.whenIdle()
  const original = await h.query('task.get', { taskId: created.taskId })
  assert.equal(original.status, 'completed')
  const runtime = { isTaskSessionMode: () => true, getTaskSessionDetail: id => h.service.taskDetail(id), reopenTask: args => h.service.reopenTask(args) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/reopen`
  const args = { requestId: 'review-followup', context: '只处理新增审查，保留原提测证据', expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision }
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ ...args, actorId: 'other' })).status, 400)
  assert.equal((await post({ ...args, expectedControlRevision: original.controlRevision + 1 })).status, 409)
  assert.equal((await post(args)).status, 200)
  await h.service.whenIdle()
  assert.equal((await post(args)).status, 200)
  await h.service.whenIdle()
  const reopened = await h.query('task.get', { taskId: original.taskId })
  assert.equal(reopened.runSequence, original.runSequence + 1)
  assert.equal(reopened.sessionId, original.sessionId)
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(reopened.sourceRefs.length, original.sourceRefs.length + 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
})

testRunner('协调暂停时混合消息拒绝协调来源，普通话题Host重试仍按原版本完成', { timeout: 30000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mixed-semantic-source-'))
  let host, store, blocked = true, routeAttempts = 0
  t.after(async () => { try { await host?.close(); await store?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, async request => {
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
  } })
  await host.service.ingest(message('mixed', '测试助手，查询提醒；测试助手，核查文件。'))
  await host.service.whenIdle()
  const pending = (await host.query('source.list')).find(source => source.messageId === 'mixed')
  assert.equal((await host.query('task.list')).length, 0)
  assert.equal(pending.processingCompleted, undefined)
  assert.equal(pending.processingPending, true)
  assert.ok(routeAttempts >= 2)
  assert.equal((await host.query('coordination.source.list')).length, 0)
  assert.equal(host.residentStore.listTopics('native-group')[0].decisions[0].status, 'blocked')
  blocked = false
  await host.service.retryMessage({ groupId: 'native-group', messageId: 'mixed' })
  await host.service.whenIdle()
  const completed = (await host.query('source.list')).find(source => source.messageId === 'mixed')
  assert.ok(completed.processingCompleted, JSON.stringify({ completed: completed.processingCompleted, topicStatus: host.residentStore.listTopics('native-group').map(topic => ({ processedRevision: topic.processedRevision, decisions: topic.decisions.map(record => ({ status: record.status, error: record.error })) })), alerts: host.service.listAlerts() }))
  assert.equal(completed.processingCompleted.activeUnitRefs.length, 2)
  assert.equal((await host.query('coordination.source.list')).length, 0)
  assert.equal((await host.query('task.list'))[0].status, 'active')
})
