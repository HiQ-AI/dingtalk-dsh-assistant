import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { available, reason, nativeTaskHost as createNativeTaskHost, latestInput, modelToolValues, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost as createRetiredCoordinationHost } from './fixtures/retired-coordination-native.js'
import { coordinationContextSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'
import { taskNotificationRecovery } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'

const model = { enabled: true, provider: 'native-task-test', model: 'coordination-controlled' }
const diagnosedModel = decide => (...args) => {
  try { return decide(...args) } catch (error) { console.error(error.stack); throw error }
}
const nativeTaskHost = (root, decide, options) => createNativeTaskHost(root, diagnosedModel(decide), options)
const retiredCoordinationHost = (t, options) => createRetiredCoordinationHost(t,
  { ...options, ...(options.decide ? { decide: diagnosedModel(options.decide) } : {}) })

const routeMatter = (input, title) => [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
  routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
    units: [{ unitKey: message.messageId, summary: title, sourceRefs: [{ quote: message.text }],
      topics: [{ newTopicKey: message.messageId, title }], reason: '按当前业务事项接纳' }] })) } }]
function replyMatter(request, input, reply, actions = []) {
  const review = modelToolValues(request).find(value => Array.isArray(value.candidates))
  if (input.replyReviewCandidateCount && !review) return [{ name: 'group_reply_review_get', args: {} }]
  return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
    decision: { basisMessageIds: [...new Set(input.messages.map(message => message.messageId))],
      basisUnitRefs: input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })), actions, reply,
      replyToMessageId: input.messages.at(-1).messageId, atOpenDingTalkIds: ['native-user'],
      replyReview: { kind: actions.length ? 'confirmation' : 'substantive',
        reviewedOutboundIds: review?.candidates.map(item => item.outboundId) ?? [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
}

test('retired coordinator config cannot dispatch history or replay notices while a current Topic task continues',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    let host, routeAttempts = 0, turns = 0
    const f = await retiredCoordinationHost(t, { name: 'coordination-paused-', tasks: [{ taskId: 'old-task' }], rows: {
      coordination: [{ id: 'paused-old', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['paused-member'] }],
      coordination_members: [{ id: 'paused-member', coordinationId: 'paused-old', taskId: 'old-task', state: 'waiting',
        dependencies: [], instruction: '暂停期间不得应用', progressImpact: 'preserve' }],
      notifications: [{ id: 'paused-notice', kind: 'coordination', state: 'prepared', requirementRevision: 1,
        payload: { conversationId: 'native-group', text: '暂停期间不得外发', fact: { coordinationId: 'paused-old', eventId: 'paused-notice' } } }],
    }, decide: request => {
      assert.ok(++turns <= 24, JSON.stringify({ error: 'retired config fallback did not settle', tools: host?.toolResults.slice(-2) }))
      assert.ok(!request.tools.some(tool => tool.name === 'coordination_submit'))
      const routed = topicTaskCalls(request)
      if (routed) {
        if (request.tools.some(tool => tool.name === 'group_decision_submit') && latestInput(request).trigger !== 'task-facts')
          routed[0].args.decision.atOpenDingTalkIds = ['native-user']
        if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) {
          if (routeAttempts > 0) assert.match(JSON.stringify(request.messages.filter(message => message.role === 'tool')), /coordination_ingress_disabled/)
          if (++routeAttempts === 1) for (const route of routed[0].args.routes) for (const unit of route.units) {
            unit.dispatchOwner = 'coordination'; unit.topics = []; unit.reason = '旧独立安排尝试进入已退役派发方'
          }
        }
        return routed
      }
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待后续补充', evidence: [], limitations: [] } } }]
    } })
    host = f.host
    const history = await host.query('coordination.get', { coordinationId: 'paused-old' })
    assert.equal(history.members[0].retirement.previousState, 'waiting')
    await host.service.ingest({ groupId: 'native-group', messageId: 'ordinary', senderOpenDingTalkId: 'native-user',
      text: '测试助手，检查文件并等待补充', timestamp: '2026-10-28T01:00:00Z' })
    await host.service.whenIdle()
    const task = (await host.query('task.list')).find(task => task.taskId !== 'old-task')
    assert.ok(task, JSON.stringify(host.service.listAlerts()))
    assert.ok(routeAttempts >= 2, 'retired route ownership must be rejected before a current Topic accepts it')
    assert.deepEqual(await host.query('task.get', { taskId: 'old-task' }), f.beforeTasks[0])
    assert.deepEqual(await host.query('coordination.get', { coordinationId: 'paused-old' }), history)
    const notice = await host.query('notification.get', { notificationId: 'paused-notice' })
    assert.equal(notice.state, 'superseded'); assert.equal(notice.retirement.reason, 'coordination-feature-removed')
    assert.equal(host.sent.some(item => item.kind === 'coordination'), false)
    await assert.rejects(host.service.retryNotification({ groupId: 'native-group', notificationId: notice.id,
      expectedToken: taskNotificationRecovery(notice).expectedToken }), { code: 'INDEPENDENT_COORDINATION_RETIRED' })
    for (const phase of ['coordination', 'coordination-context']) await assert.rejects(host.service.retryMessageProcessing({
      groupId: 'native-group', messageId: 'ordinary', phase, requestId: 'paused-old', token: 'old-token',
    }), { code: 'MESSAGE_RETRY_STALE' })
    await host.service.appendTaskContext({ taskId: task.taskId, requestId: 'ordinary-context', context: '补充文件名',
      expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision, progressImpact: 'preserve' })
    await host.service.whenIdle()
    assert.match((await host.query('task.get', { taskId: task.taskId })).request, /补充文件名/)
    assert.equal((await host.query('task.list')).length, 2)
    assert.deepEqual(await host.query('coordination.get', { coordinationId: 'paused-old' }), history)
  })

test('retired observation HTTP mutations return gone while original task versions and historical observations remain intact',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const f = await retiredCoordinationHost(t, { name: 'retire-observation-native-',
      tasks: ['A', 'B', 'C', 'D'].map(taskId => ({ taskId, request: '原事项' + taskId })),
      rows: {
        coordination: [{ id: 'old-progress', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['A', 'B', 'C', 'D'] }],
        coordination_members: ['A', 'B', 'C', 'D'].map(taskId => ({ id: taskId, taskId, coordinationId: 'old-progress',
          state: 'waiting', observation: true, dependencies: [], expectedRequirementRevision: 1, expectedContextRevision: 0, expectedRunSequence: 1 })),
      },
    })
    const host = f.host
    await host.service.appendTaskContext({ taskId: 'A', requestId: 'changed-A', context: '新增事实',
      expectedRequirementRevision: 1, expectedControlRevision: 1, progressImpact: 'preserve' })
    await host.service.whenIdle()
    const before = await host.query('task.list'), wakes = await host.query('wake.list')
    const history = await host.query('coordination.get', { coordinationId: 'old-progress' }), modelCalls = f.requests.length
    const server = createServer((request, response) => handleRequest(request, response, host.service))
    t.after(() => new Promise(resolve => server.close(resolve)))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + server.address().port
    for (const suffix of ['/check', '']) for (const expectedRevision of [1, 2]) {
      const response = await fetch(url + '/coordination/old-progress/retire-observation' + suffix, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: 'native-group',
          expectedRevision, reason: '历史纯观察不再允许修改' }) })
      assert.equal(response.status, 410)
      assert.deepEqual(await response.json(), { error: 'INDEPENDENT_COORDINATION_RETIRED' })
    }
    for (const path of ['/state/coordination-sources', '/state/coordination-work/dispatch:old-progress']) {
      const response = await fetch(url + path)
      assert.equal(response.status, 410)
    }
    await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(await host.query('task.list'), before)
    assert.deepEqual(await host.query('wake.list'), wakes)
    assert.deepEqual(await host.query('coordination.get', { coordinationId: 'old-progress' }), history)
    assert.equal(history.members[0].expectedContextRevision, 0, 'historical stale version is preserved, not rewritten to the new Task version')
    assert.deepEqual(await host.query('notification.list'), [])
    assert.equal(host.sent.length, 0); assert.equal(f.requests.length, modelCalls)
  })

test('即时进度询问经原生路由与query工具一次答复四项任务，恢复不唤醒或重发',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'instant-task-progress-'))
    let host, ownerCalls = 0, queryTurns = 0, modelSteps = 0
    const taskIds = []
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      assert.ok(++modelSteps <= 40, JSON.stringify({ error: 'unexpected progress setup loop', tools: host.toolResults.slice(-2) }))
      if (input.trigger === 'task-facts' || input.requestId?.startsWith('coord-summary-')) return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'progress', summary: '查询导入事项进度', sourceRefs: [{ quote: message.text }],
            topics: [{ newTopicKey: 'progress', title: '导入事项进度查询' }], reason: '多个现有任务即时只读查询' }] })) } }]
      if (names.includes('group_decision_submit') && input.messages?.some(message => message.messageId === 'progress')) {
        assert.ok(++queryTurns <= 12, JSON.stringify({ error: 'unexpected query model loop', tools: host.toolResults.slice(-2) }))
        const page = modelToolValues(request).find(value => value.tasks?.length === taskIds.length)
        if (!page) return [{ name: 'group_task_context_get', args: { taskIds } }]
        assert.deepEqual(page.tasks.map(task => task.taskId).sort(), [...taskIds].sort())
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: ['progress'], basisUnitRefs: input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })),
            actions: [], reply: page.tasks.map(task => `${task.title}：${task.state}`).join('\n'),
            replyToMessageId: 'progress', atOpenDingTalkIds: ['native-user'],
            replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        ownerCalls++
        return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '原工作未结束', evidence: [], limitations: [] } } }]
      }
      return []
    }, { config: { coordination: model } })
    for (const title of ['终审只读UPR导入覆盖', '未保存草稿UPR导入', '草稿UPR物料名称回显', 'v4合并数据集UPR替换'])
      taskIds.push((await host.service.createTask({ groupId: 'native-group', requestId: title, title, objective: title })).taskId)
    await host.service.whenIdle()
    const tasks = await host.query('task.list'), wakes = await host.query('wake.list'), calls = ownerCalls
    await host.service.ingest({ groupId: 'native-group', messageId: 'progress', senderOpenDingTalkId: 'native-user', senderName: '同事',
      text: '昨天关于导入的其他问题 修复了没', timestamp: '2026-10-28T01:44:09Z' })
    await host.service.whenIdle()
    assert.equal(host.sent.length, 1)
    for (const task of tasks) assert.ok(host.sent[0].payload.text.includes(task.title))
    assert.deepEqual(await host.query('coordination.list'), [])
    assert.equal(host.residentStore.getGroup('native-group').outbox[0].status, 'sent')
    assert.deepEqual(await host.query('task.list'), tasks)
    assert.deepEqual(await host.query('wake.list'), wakes)
    assert.equal(ownerCalls, calls)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(host.sent.length, 1); assert.equal(ownerCalls, calls)
    assert.deepEqual(await host.query('execution.list'), [])
    assert.deepEqual(await host.query('coordination.schedule.list'), [])
    assert.deepEqual(await host.query('coordination.occurrence.list'), [])
  })

// The removed coordinator no longer owns quoted deployment or re-evaluation.
// Current Topic decisions retain the same quoted evidence and reopen only the original Task.
for (const priorClarification of [false, true]) test(`quoted continuation reuses the original Task and preserves delivered history: priorClarification=${priorClarification}`,
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    let host, decisions = 0, pages = 0, turns = 0
    const originalId = 'original-delivery'
    const quote = { messageId: 'original-delivery-message', senderName: '原交付作者',
      content: '原编辑修复已交付：后端 https://github.com/example/backend/pull/17、前端 https://github.com/example/frontend/pull/19。尚未部署。' }
    const question = '要将哪项改动部署到测试环境？'
    const oldQuestion = { id: 'old-question', kind: 'coordination', state: 'delivered', sendAttemptCount: 1,
      ack: { messageId: 'old-question-message' }, receipt: { visible: true, messageId: 'old-question-message' },
      payload: { conversationId: 'native-group', text: question, fact: { coordinationId: 'old-clarification', eventId: 'question' } } }
    const tasks = [...(priorClarification ? [] : Array.from({ length: 21 }, (_, i) => ({ taskId: 'other-' + i, request: '其他独立事项' + i }))),
      { taskId: originalId, request: quote.content }]
    const f = await retiredCoordinationHost(t, { name: 'quoted-continuation-', tasks,
      rows: priorClarification ? {
        coordination: [{ id: 'old-clarification', groupId: 'native-group', state: 'needs_clarification', revision: 1, question, memberIds: [] }],
        coordination_sources: [{ id: 'old-source', unitId: 'old-unit', revision: 1, groupId: 'native-group',
          dispatchOwner: 'coordination', state: 'needs_clarification', sourceMessageId: 'old-deployment', original: '部署到测试环境', quotedMessage: quote }],
        notifications: [oldQuestion],
      } : {},
      decide: request => {
        const names = request.tools.map(tool => tool.name), input = latestInput(request)
        assert.ok(++turns <= 160, 'quoted continuation model did not settle')
        if (input.trigger === 'task-facts') return topicTaskCalls(request)
        if (names.includes('group_topic_route_submit')) {
          assert.ok(JSON.stringify(input).includes(quote.content))
          return routeMatter(input, '原交付部署到测试环境')
        }
        if (names.includes('group_decision_submit')) {
          assert.ok(JSON.stringify(input).includes(quote.content), 'quotation must survive current Topic projection')
          const values = modelToolValues(request), page = values.findLast(value => value.snapshotFingerprint && Array.isArray(value.tasks))
          if (!page) { pages++; return [{ name: 'group_task_list', args: { offset: 0, limit: 10 } }] }
          if (page.hasMore) { pages++; return [{ name: page.nextCall.name, args: page.nextCall.arguments }] }
          assert.ok(values.filter(value => value.snapshotFingerprint).flatMap(value => value.tasks).some(task => task.taskId === originalId))
          const full = values.findLast(value => !value.snapshotFingerprint && value.tasks?.some(task => task.taskId === originalId))
          if (!full) return [{ name: 'group_task_context_get', args: { taskIds: [originalId] } }]
          const task = full.tasks.find(task => task.taskId === originalId)
          assert.equal(task.state, 'completed')
          const actions = [{ kind: 'task-reopen', taskId: originalId, inputVersion: task.inputVersion, runSequence: task.runSequence,
            context: '当前授权：部署原引用交付到测试环境。' + quote.content, objective: '将原交付后端#17和前端#19部署到测试环境并核验',
            acceptanceCriteria: ['核对版本与健康，不部署生产'], topicRefs: [{ topicId: input.topicId, revision: input.revision }],
            basisUnitRefs: input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) }]
          const calls = replyMatter(request, input, '沿原任务承接本次测试环境部署。', actions)
          if (calls[0].name === 'group_decision_submit') decisions++
          return calls
        }
        return [{ name: 'task_session_submit', args: { decision: { action: input.task.runSequence === 1 ? 'complete' : 'wait',
          summary: input.task.runSequence === 1 ? '原交付已完成，尚未部署' : '已承接原部署范围，等待实际执行',
          evidence: [], limitations: ['隔离合同测试不进行外部部署'] } } }]
      },
    })
    host = f.host
    const before = await host.query('task.get', { taskId: originalId })
    assert.equal(before.status, 'completed')
    const history = priorClarification ? await host.query('coordination.get', { coordinationId: 'old-clarification' }) : null
    await host.service.ingest({ groupId: 'native-group', messageId: 'quoted-deploy', senderOpenDingTalkId: 'native-user',
      senderName: '当前部署人', text: '部署到测试环境', quotedMessage: quote, timestamp: '2026-10-27T04:15:53.180Z' })
    await host.service.whenIdle()
    assert.equal(decisions, 1, JSON.stringify(host.service.listAlerts()))
    assert.ok(pages >= (priorClarification ? 1 : 3), 'all necessary directory pages must be read')
    const current = await host.query('task.get', { taskId: originalId })
    assert.equal(current.runSequence, 2); assert.equal(current.sessionId, before.sessionId)
    assert.match(current.objective, /#17.*#19.*测试环境/)
    assert.equal((await host.query('task.list')).length, tasks.length)
    for (const task of f.beforeTasks.filter(task => task.taskId !== originalId))
      assert.deepEqual(await host.query('task.get', { taskId: task.taskId }), task)
    const source = (await host.query('source.list')).find(source => source.messageId === 'quoted-deploy')
    assert.deepEqual(source.quote, quote); assert.ok(source.processingCompleted)
    if (priorClarification) {
      assert.deepEqual(await host.query('notification.get', { notificationId: oldQuestion.id }), oldQuestion)
      assert.deepEqual(await host.query('coordination.get', { coordinationId: 'old-clarification' }), history)
      await assert.rejects(host.service.retryMessageProcessing({ groupId: 'native-group', messageId: 'old-deployment',
        phase: 'coordination-context', requestId: 'old-source', token: 'old-token' }), { code: 'MESSAGE_RETRY_STALE' })
    }
    const sent = host.sent.length
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(decisions, 1); assert.equal(host.sent.length, sent)
    assert.equal((await host.query('task.get', { taskId: originalId })).runSequence, 2)
    assert.equal(host.sent.some(notice => notice.payload.text === question), false)
  })

test('coordination context shares exact bounded inputs, including paired source identity', () => {
  assert.ok(coordinationContextSchema.safeParse({ limit: 50, offset: 0, taskIds: Array.from({length:8}, (_, i) => `t${i}`),
    coordinationIds: ['a','b','c','d'], arrangementSourceUnitId: 'source', arrangementSourceUnitRevision: 1 }).success)
  for (const args of [{limit:0},{limit:100},{taskIds:Array(17).fill('t')},{coordinationIds:Array(5).fill('c')},
    {taskIds:'t'},{arrangementSourceUnitId:'s'},{arrangementSourceUnitRevision:1},{arrangementSourceUnitRevision:0,arrangementSourceUnitId:'s'},
    ...['offset','sourceOffset','arrangementSourceOffset','arrangementOffset','memberOffset'].flatMap(key => [-1,0.5,Number.MAX_SAFE_INTEGER+1].map(value => ({[key]:value})))])
    assert.equal(coordinationContextSchema.safeParse(args).success, false, JSON.stringify(args))
})

// Scheduled coordinator queries are gone. The retained read-only directory
// guarantee is exercised through current Topic pagination; native platform timing has its own suite.
for (const taskCount of [17, 41]) test(`current Topic reads ${taskCount} task summaries through bounded pages without full detail or Owner wake`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'topic-directory-query-'))
    let host, decisionTurns = 0, ownerCalls = 0
    const startedAt = performance.now(), phases = {}
    const observed = new Set(), offsets = []
    t.after(async () => { t.diagnostic(JSON.stringify({ taskCount, phases, ownerCalls, elapsedMs: performance.now() - startedAt })); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (input.trigger === 'task-facts') return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) return routeMatter(input, '当前群任务目录查询')
      if (names.includes('group_decision_submit')) {
        assert.ok(++decisionTurns <= 15, 'directory pagination did not terminate')
        const page = modelToolValues(request).findLast(value => value.snapshotFingerprint && Array.isArray(value.tasks))
        if (!page) { offsets.push(0); return [{ name: 'group_task_list', args: { offset: 0, limit: 10 } }] }
        assert.ok(page.tasks.length > 0 && page.tasks.length <= 10)
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12 * 1024)
        for (const task of page.tasks) {
          assert.equal(task.request, undefined); assert.equal(task.requirements, undefined)
          assert.equal(task.execution, undefined); observed.add(task.taskId)
        }
        if (page.hasMore) {
          assert.equal(page.nextOffset, page.offset + page.tasks.length)
          assert.equal(page.nextCall.arguments.offset, page.nextOffset)
          offsets.push(page.nextOffset)
          return [{ name: page.nextCall.name, args: page.nextCall.arguments }]
        }
        assert.equal(observed.size, taskCount)
        return replyMatter(request, input, '已核对本群' + observed.size + '项任务的当前目录状态。')
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      ownerCalls++
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '保持原任务',
        evidence: [], limitations: [] } } }]
    })
    phases.hostReadyMs = performance.now() - startedAt
    for (let i = 0; i < taskCount; i++) {
      const taskId = 'T' + i
      await host.service.store.command({ id: 'seed:' + i, kind: 'task.create',
        args: { taskId, groupId: 'native-group', request: '原任务' + i } })
      if (i === 0) continue
      // These are already-waiting directory entries, not new work to execute.
      // Use real ledger transitions for their setup; one native Owner below
      // remains the live guard against a read-only query restarting work.
      const { binding, wakeIds } = (await host.service.store.command({ id: 'seed-claim:' + i,
        kind: 'task.claim', args: { taskId } })).result
      await host.service.store.command({ id: 'seed-wait:' + i, kind: 'task.wait',
        args: { binding, action: 'wait', summary: '保持原任务', evidence: [], limitations: [] } })
      await host.service.store.command({ id: 'seed-ack:' + i, kind: 'wake.ack', args: { binding, wakeIds } })
      await host.service.store.command({ id: 'seed-drained:' + i, kind: 'task.drained', args: { binding } })
    }
    phases.tasksSeededMs = performance.now() - startedAt
    await host.service.recover(); await host.service.whenIdle()
    phases.ownersIdleMs = performance.now() - startedAt
    const before = await host.query('task.list'), wakes = await host.query('wake.list'), calls = ownerCalls
    assert.equal(calls, 1, 'one original Owner must really run and settle before the query')
    assert.equal(before.length, taskCount)
    assert.ok(before.every(task => task.drained && task.status === 'active' && task.lastDecision.action === 'wait'))
    assert.equal(wakes.length, taskCount); assert.ok(wakes.every(wake => wake.state === 'acked'))
    await host.service.ingest({ groupId: 'native-group', messageId: 'directory-query', senderOpenDingTalkId: 'native-user',
      text: '测试助手，查询当前群所有任务进度，通知我。', timestamp: '2026-10-21T00:00:00Z' })
    await host.service.whenIdle()
    phases.queryCompleteMs = performance.now() - startedAt
    assert.equal(observed.size, taskCount)
    assert.deepEqual(offsets, Array.from({ length: Math.ceil(taskCount / 10) }, (_, i) => i * 10))
    assert.equal(host.toolResults.some(tool => tool.name === 'group_task_context_get'), false)
    assert.deepEqual(await host.query('task.list'), before); assert.deepEqual(await host.query('wake.list'), wakes)
    assert.equal(ownerCalls, calls); assert.equal(host.sent.length, 1)
    assert.deepEqual(await host.query('coordination.schedule.list'), [])
    assert.deepEqual(await host.query('execution.list'), [])
  })

test('current native source retry preserves failed attempt evidence and clears the alert after one clarification',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'topic-recovered-alert-'))
    const agentConfig = { agentPreset: 'missing-fixture-preset' }
    const releaseFailureWrite = Promise.withResolvers()
    let host, decisions = 0, delayedFailure
    t.after(async () => { releaseFailureWrite.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return routeMatter(input, '查询对象待确认')
      if (names.includes('group_decision_submit')) {
        decisions++; assert.ok(decisions <= 4, 'clarification did not settle')
        return replyMatter(request, input, '要查询哪个原任务？')
      }
      return topicTaskCalls(request) ?? []
    }, { agentConfig })
    const updateRequest = host.residentStore.updateCoordinationRequest
    host.residentStore.updateCoordinationRequest = async (groupId, requestId, patch, ...rest) => {
      if (patch.status === 'exhausted' && patch.failurePhase === 'startup') {
        delayedFailure = { groupId, requestId }
        await releaseFailureWrite.promise
      }
      return updateRequest(groupId, requestId, patch, ...rest)
    }
    await host.service.ingest({ groupId: 'native-group', messageId: 'retry-query', senderOpenDingTalkId: 'native-user',
      text: '测试助手，查那个任务。', timestamp: '2026-10-21T00:00:00Z' })
    await host.service.whenIdle()
    // The native monitor exposes exhaustion before its asynchronous record write
    // completes. Exercise that window explicitly rather than racing Windows I/O.
    await waitUntil(() => delayedFailure, 'native startup failure reached persistence')
    assert.equal(host.service.messageProcessingRequests('native-group').find(item => item.requestId === delayedFailure.requestId)?.status, 'exhausted')
    assert.notEqual(host.residentStore.getCoordinationRequest('native-group', delayedFailure.requestId)?.startupAttempt, 1)
    releaseFailureWrite.resolve()
    const { failed, recorded } = await waitUntil(() => {
      const failed = host.service.messageProcessingRequests('native-group').find(item => item.requestId === delayedFailure.requestId && item.status === 'exhausted')
      const recorded = failed && host.residentStore.getCoordinationRequest('native-group', failed.requestId)
      return recorded?.status === 'exhausted' && recorded.startupAttempt === 1 && recorded.failurePhase === 'startup'
        ? { failed, recorded: structuredClone(recorded) } : null
    }, 'durable native startup failure')
    host.residentStore.updateCoordinationRequest = updateRequest
    assert.equal(recorded.startupAttempt, 1); assert.equal(recorded.failurePhase, 'startup')
    assert.ok(host.service.listAlerts().length > 0)
    const original = (await host.query('source.list'))[0], stages = structuredClone(original.stages)
    assert.equal(decisions, 0)
    const message = host.residentStore.getGroup('native-group').messages[0]
    const retry = { groupId: 'native-group', messageId: message.messageId, messageVersion: message.messageVersion,
      activeUnitRefs: message.activeUnitRefs ?? [], phase: 'routing', requestId: failed.requestId, token: failed.retryToken }
    agentConfig.agentPreset = 'native-test'
    await host.service.retryMessageProcessing(retry)
    await host.service.whenIdle()
    const current = (await host.query('source.list'))[0]
    assert.equal(current.sourceId, original.sourceId); assert.equal(current.version, original.version)
    for (const stage of stages) assert.ok(current.stages.some(saved => saved.spanId === stage.spanId), 'failed attempt evidence must remain')
    assert.ok(current.processingCompleted)
    const state = host.residentStore.getCoordinationRequest('native-group', failed.requestId)
    assert.equal(state.resumeEpoch, 1); assert.equal(state.status, 'completed')
    assert.equal(host.service.listAlerts().length, 0)
    assert.equal(decisions, 1)
    assert.equal(host.sent.filter(notice => notice.payload.text === '要查询哪个原任务？').length, 1)
    await assert.rejects(host.service.retryMessageProcessing(retry), /MESSAGE_RETRY_STALE/)
    assert.deepEqual(await host.query('task.list'), [])
  })

const stageCases = [
  { name: 'software', objective: '需求X先方案评审，然后开发，开发完部署UAT', requirements: ['先完成方案评审', '评审后开发', '开发完成后部署UAT并验证'] },
  { name: 'translation-two', objective: '这份稿件先翻译，再校对', requirements: ['翻译稿件', '翻译后校对'] },
  { name: 'research-four', objective: '本次调研先设计问卷，再访谈，然后分析，最后撰写报告', requirements: ['设计问卷', '问卷后访谈', '访谈后分析', '分析后撰写报告'] },
  { name: 'translation-reversed', objective: '这份已有译稿先校对，再翻译修订内容', requirements: ['先校对已有译稿', '校对后翻译修订内容'] },
]
for (const stageCase of stageCases) for (const existing of [false, true]) test(`one delivery preserves arbitrary user stages: ${stageCase.name}, existing=${existing}`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'single-task-stages-'))
    let host, admitted = false, delegated = false, ownerInput, stageTurns = 0
    const prompts = { route: '', decision: '', owner: '' }
    const { objective, requirements } = stageCase
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      assert.ok(++stageTurns <= 24, JSON.stringify({ error: 'unexpected stage model loop', tools: host.toolResults.slice(-2) }))
      if (input.trigger === 'task-facts' || input.requestId?.startsWith('coord-summary-')) return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) {
        prompts.route = JSON.stringify(request)
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
          routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
            ignoredRefs: [], units: [{ unitKey: 'delivery', summary: objective, sourceRefs: [{ quote: message.text }],
              topics: [{ newTopicKey: 'delivery', title: '完整阶段交付' }], reason: '一个完整交付目标' }] })) } }]
      }
      if (names.includes('group_decision_submit')) {
        prompts.decision = JSON.stringify(request)
        const full = modelToolValues(request).find(value => value.tasks?.some(task => task.taskId === 'original'))
        if (existing && !full) return [{ name: 'group_task_context_get', args: { taskIds: ['original'] } }]
        const task = full?.tasks.find(task => task.taskId === 'original')
        const topicRefs = [{ topicId: input.topicId, revision: input.revision }]
        const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
        admitted = true
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: {
          basisMessageIds: ['stages'], basisUnitRefs, actions: [existing
            ? { kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
                progressImpact: 'replan', context: objective, objective, acceptanceCriteria: requirements, topicRefs, basisUnitRefs }
            : { kind: 'new-task', title: '完整阶段交付', objective, acceptanceCriteria: requirements, topicRefs, basisUnitRefs }],
          reply: '已将全部指定阶段交给同一任务继续处理。', replyToMessageId: 'stages', atOpenDingTalkIds: ['native-user'],
          replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
        } } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        prompts.owner = JSON.stringify(request)
        if (admitted) {
          ownerInput = input
          if (!delegated) {
            delegated = true
            return [{ name: 'task_delegate', args: { key: 'first-stage', objective: requirements[0], resourceKeys: [] } }]
          }
        }
        return [{ name: 'task_session_submit', args: { decision: { action: 'wait',
          summary: '首阶段结果仅是证据，后续阶段尚未交付', evidence: [], limitations: requirements.slice(1) } } }]
      }
      if (names.includes('execution_submit')) return [{ name: 'execution_submit', args: { output: {
        status: 'completed', summary: requirements[0], evidence: ['synthetic-first-stage'], limitations: requirements.slice(1), artifacts: [] } } }]
      return []
    })
    if (existing) await host.service.store.command({ id: 'original-create', kind: 'task.create',
      args: { taskId: 'original', groupId: 'native-group', ownerActorId: 'native-user', request: requirements[0] } })
    if (existing) { await host.service.recover(); await host.service.whenIdle() }
    await host.service.ingest({ groupId: 'native-group', messageId: 'stages', senderOpenDingTalkId: 'native-user',
      text: `测试助手，${objective}`, timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    const tasks = await host.query('task.list')
    assert.match(prompts.route, /任意用户指定阶段/)
    assert.match(prompts.decision, /不按内部阶段分别生成new-task/)
    assert.match(prompts.decision, /不得套用默认阶段模板/)
    assert.match(prompts.owner, /阶段执行结果仅为证据/)
    assert.equal(tasks.length, 1, JSON.stringify(host.service.listAlerts()))
    const task = tasks[0]
    if (existing) assert.equal(task.taskId, 'original')
    assert.equal(task.objective, objective)
    assert.deepEqual(task.requirements, requirements)
    assert.equal(ownerInput.task.objective, objective)
    assert.deepEqual(ownerInput.task.requirements, requirements)
    assert.ok(ownerInput.sources.some(source => source.text.includes(objective)))
    assert.equal(task.status, 'active')
    assert.equal(task.completion, undefined)
    const executions = await host.query('execution.list', { taskId: task.taskId })
    assert.equal(executions.length, 1)
    assert.equal(executions[0].status, 'succeeded')
    await host.service.recover(); await host.service.whenIdle()
    assert.equal((await host.query('task.list')).length, 1)
    assert.equal((await host.query('task.get', { taskId: task.taskId })).status, 'active')
  })

// Delayed coordinator creation is retired. Historical templates must not create
// or start Tasks on recovery; current explicit creation carries the full start constraint to one Owner.
for (const scheduled of [false, true]) test(`retired creation never auto-starts while current explicit scope keeps its constraint: scheduled=${scheduled}`,
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    let admitted = false, ownerInput
    const objective = scheduled ? '创建新交付C，仅在明日明确授权的时间开始；现在等待，不执行'
      : '创建新交付C，仅在前置A的验收证据确认后开始；现在等待，不执行'
    const template = { id: 'create-B', coordinationId: 'old-create', state: 'waiting', creationKey: 'B',
      instruction: '旧明确交付B', dependencies: scheduled ? [] : ['A'], taskId: 'B' }
    const f = await retiredCoordinationHost(t, { name: 'retired-creation-', tasks: [{ taskId: 'A' }, { taskId: 'B' }], rows: {
      coordination: [{ id: 'old-create', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['create-B'] }],
      coordination_members: [template],
      coordination_schedules: scheduled ? [{ id: 'create-later', coordinationId: 'old-create', state: 'active',
        nextDueAt: '2026-10-21T00:01:00.000Z', rule: { kind: 'once', at: '2026-10-21T00:01:00.000Z' },
        action: { kind: 'task-command', instructionIds: ['create-B'] } }] : [],
    }, decide: request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (input.trigger === 'task-facts') return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) return routeMatter(input, '新交付C及启动条件')
      if (names.includes('group_decision_submit')) {
        admitted = true
        return replyMatter(request, input, '已保留新交付的完整启动条件，当前等待。',
          [{ kind: 'new-task', title: '新交付C', objective, acceptanceCriteria: ['先核对启动条件，未满足不得开始执行'],
            topicRefs: [{ topicId: input.topicId, revision: input.revision }],
            basisUnitRefs: input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) }])
      }
      if (admitted && !['A', 'B'].includes(input.task.taskId)) ownerInput = input
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '明确启动条件未满足',
        evidence: [], limitations: ['不把旧日程或依赖事件视为新授权'] } } }]
    } })
    const host = f.host
    const history = await host.query('coordination.get', { coordinationId: 'old-create' })
    t.mock.timers.tick(60000); await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(await host.query('task.list'), f.beforeTasks)
    assert.deepEqual(await host.query('execution.list'), [])
    assert.deepEqual(await host.query('coordination.occurrence.list'), [])
    await host.service.ingest({ groupId: 'native-group', messageId: 'new-create', senderOpenDingTalkId: 'native-user',
      text: '测试助手，' + objective, timestamp: '2026-10-21T00:01:00Z' })
    await host.service.whenIdle()
    const tasks = await host.query('task.list'), created = tasks.find(task => !['A', 'B'].includes(task.taskId))
    assert.equal(tasks.length, 3); assert.equal(created.objective, objective)
    assert.equal(created.status, 'active'); assert.equal(created.lastDecision.action, 'wait')
    assert.equal(ownerInput.task.objective, objective)
    assert.deepEqual(created.requirements, ['先核对启动条件，未满足不得开始执行'])
    assert.deepEqual(await host.query('execution.list'), [])
    assert.deepEqual(await host.query('coordination.get', { coordinationId: 'old-create' }), history)
    for (const task of f.beforeTasks) assert.deepEqual(await host.query('task.get', { taskId: task.taskId }), task)
    const count = host.sent.length
    await host.service.recover(); await host.service.whenIdle()
    assert.equal((await host.query('task.list')).length, 3); assert.equal(host.sent.length, count)
  })

test('current explicit A then B follow-ups use original Owners while retired completion dependencies never replay B',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const completions = []
    let decisions = 0
    const f = await retiredCoordinationHost(t, { name: 'original-owner-sequence-', tasks: [
      { taskId: 'A', request: '原目标A' }, { taskId: 'B', request: '原目标B' }],
      rows: {
        coordination: [{ id: 'old-sequence', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['a', 'b'] }],
        coordination_members: [{ id: 'a', coordinationId: 'old-sequence', taskId: 'A', state: 'applied', dependencies: [] },
          { id: 'b', coordinationId: 'old-sequence', taskId: 'B', state: 'waiting', dependencies: ['a'], instruction: 'A完成后再处理B' }],
      },
      decide: request => {
        const names = request.tools.map(tool => tool.name), input = latestInput(request)
        if (input.trigger === 'task-facts') return topicTaskCalls(request)
        if (names.includes('group_topic_route_submit')) return routeMatter(input, '原事项补充材料')
        if (names.includes('group_decision_submit')) {
          assert.ok(++decisions <= 8, JSON.stringify({ error: 'sequence decision did not settle',
            tools: host.toolResults.slice(-3), messageIds: input.messages.map(message => message.messageId) }))
          const target = input.messages.at(-1).messageId === 'continue-A' ? 'A' : 'B'
          const full = modelToolValues(request).findLast(value => value.tasks?.some(task => task.taskId === target))
          if (!full) return [{ name: 'group_task_context_get', args: { taskIds: [target] } }]
          const task = full.tasks.find(task => task.taskId === target)
          return replyMatter(request, input, '已将本次补充交给原事项继续核对。', [{ kind: 'task-context', taskId: target,
            inputVersion: task.inputVersion, runSequence: task.runSequence, progressImpact: 'preserve', context: target + '补充定位材料',
            topicRefs: [{ topicId: input.topicId, revision: input.revision }],
            basisUnitRefs: input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) }])
        }
        const supplemented = input.wakes.some(wake => wake.kind === 'task.supplement')
        if (supplemented) completions.push(input.task.taskId)
        return [{ name: 'task_session_submit', args: { decision: { action: supplemented ? 'complete' : 'wait',
          summary: supplemented ? '已核验明确追加的材料' : '等候原任务补充', evidence: supplemented ? ['本轮材料已核对'] : [], limitations: [] } } }]
      },
    })
    const host = f.host, old = await host.query('coordination.get', { coordinationId: 'old-sequence' })
    const ingest = (messageId, text) => host.service.ingest({ groupId: 'native-group', messageId,
      senderOpenDingTalkId: 'native-user', text, timestamp: '2026-10-21T01:00:00Z' })
    await ingest('continue-A', '测试助手，先核对A这份定位材料，B当前不要动。')
    await host.service.whenIdle()
    assert.equal((await host.query('task.get', { taskId: 'A' })).status, 'completed')
    assert.deepEqual(await host.query('task.get', { taskId: 'B' }), f.beforeTasks.find(task => task.taskId === 'B'))
    assert.deepEqual(completions, ['A'])
    await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(completions, ['A'], 'completion facts cannot restart retired dependency dispatch')
    await ingest('continue-B', '测试助手，A已核验，现在继续B这份定位材料。')
    await host.service.whenIdle()
    const tasks = await host.query('task.list')
    assert.equal(tasks.length, 2); assert.ok(tasks.every(task => task.status === 'completed'))
    assert.deepEqual(completions, ['A', 'B'])
    for (const task of tasks) {
      assert.equal(task.objective, '原目标' + task.taskId); assert.equal(task.runSequence, 1)
      assert.equal(task.contextRevision, 1)
      assert.equal(task.sessionId, f.beforeTasks.find(original => original.taskId === task.taskId).sessionId)
    }
    assert.deepEqual(await host.query('coordination.get', { coordinationId: 'old-sequence' }), old)
    assert.deepEqual(await host.query('coordination.occurrence.list'), [])
    const sent = host.sent.length
    await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(completions, ['A', 'B']); assert.equal(host.sent.length, sent)
  })

test('ambiguous current Topic asks one clarification without mutating either candidate Task',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    const f = await retiredCoordinationHost(t, { name: 'topic-clarify-', tasks: [{ taskId: 'A' }, { taskId: 'B' }],
      decide: request => {
        const names = request.tools.map(tool => tool.name), input = latestInput(request)
        if (names.includes('group_topic_route_submit')) return routeMatter(input, '对象待澄清')
        if (names.includes('group_decision_submit')) return replyMatter(request, input, '“第二个”指哪项已有任务？')
        return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: {
          action: 'wait', summary: '保持原任务', evidence: [], limitations: [] } } }]
      },
    })
    const host = f.host, wakes = await host.query('wake.list'), owners = f.requests.filter(request => request.tools.some(tool => tool.name === 'task_session_submit')).length
    await host.service.ingest({ groupId: 'native-group', messageId: 'ambiguous', senderOpenDingTalkId: 'native-user',
      text: '测试助手，第二个先别动。', timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    assert.deepEqual(await host.query('task.list'), f.beforeTasks); assert.deepEqual(await host.query('wake.list'), wakes)
    assert.equal(f.requests.filter(request => request.tools.some(tool => tool.name === 'task_session_submit')).length, owners)
    assert.deepEqual(await host.query('coordination.list'), [])
    assert.deepEqual(await host.query('execution.list'), [])
    const source = (await host.query('source.list')).find(source => source.messageId === 'ambiguous')
    assert.equal(source.routed, true); assert.ok(source.processingCompleted)
    assert.equal(host.sent.length, 1); assert.equal(host.sent[0].kind, 'topic-reply')
    assert.equal(host.sent[0].payload.text, '“第二个”指哪项已有任务？')
    assert.equal(host.residentStore.listTopics('native-group').filter(topic => topic.decisions.some(decision =>
      decision.decision.basisMessageIds?.includes('ambiguous') && decision.status === 'completed')).length, 1)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(host.sent.length, 1)
  })

test('retired due query keeps its original occurrence and receipt without reopening the observed Task',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    const occurrence = { id: 'due-query', scheduleId: 'old-schedule', coordinationId: 'old-query',
      plannedAt: '2026-10-21T00:01:00.000Z', actionState: 'succeeded', deliveryState: 'delivered',
      action: { kind: 'query', taskIds: ['A'] }, notificationId: 'old-delivery' }
    const delivery = { id: 'old-delivery', kind: 'coordination', state: 'delivered', sendAttemptCount: 1,
      ack: { messageId: 'old-delivery-message' }, receipt: { messageId: 'old-delivery-message', visible: true },
      payload: { conversationId: 'native-group', atOpenDingTalkIds: ['native-user'], text: '原任务A等待补充',
        fact: { coordinationId: 'old-query', eventId: 'due-query', occurrenceId: 'due-query' } } }
    const f = await retiredCoordinationHost(t, { name: 'retired-query-', tasks: [{ taskId: 'A' }], rows: {
      coordination: [{ id: 'old-query', groupId: 'native-group', state: 'active', revision: 1, memberIds: [] }],
      coordination_schedules: [{ id: 'old-schedule', coordinationId: 'old-query', state: 'active',
        nextDueAt: occurrence.plannedAt, rule: { kind: 'once', at: occurrence.plannedAt }, action: occurrence.action }],
      coordination_occurrences: [occurrence], notifications: [delivery],
    } })
    let host = f.host
    const calls = f.requests.length
    t.mock.timers.tick(60000)
    await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(await host.query('task.list'), f.beforeTasks)
    assert.equal(f.requests.length, calls); assert.equal(host.sent.length, 0)
    assert.deepEqual((await host.query('coordination.occurrence.list'))[0], occurrence)
    assert.deepEqual(await host.query('notification.get', { notificationId: delivery.id }), delivery)
    const schedule = (await host.query('coordination.schedule.list'))[0]
    assert.equal(schedule.state, 'active'); assert.equal(schedule.retirement.previousState, 'active')
    host = await f.restart(); await host.service.recover(); await host.service.whenIdle()
    assert.deepEqual(await host.query('task.list'), f.beforeTasks)
    assert.equal(f.requests.length, calls); assert.equal(host.sent.length, 0)
    assert.deepEqual((await host.query('coordination.occurrence.list'))[0], occurrence)
    assert.deepEqual(await host.query('notification.get', { notificationId: delivery.id }), delivery)
  })
