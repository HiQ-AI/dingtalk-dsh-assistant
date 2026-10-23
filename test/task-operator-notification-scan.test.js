import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'

for (const scenario of ['stale-snapshot', 'late-readback-error', 'recall-error']) test(`已送达通知收敛且保留撤回失败: ${scenario}`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'notification-delivered-scan-'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let service, sends = 0, reads = 0, armed = false
  const row = { id: 'notice', kind: scenario === 'recall-error' ? 'question' : 'status',
    state: scenario === 'stale-snapshot' ? 'prepared' : scenario === 'recall-error' ? 'delivered' : 'unknown',
    payload: { conversationId: 'group', text: '核查完成', ...(scenario === 'recall-error' ? { audience: 'operator', humanRequestId: 'request' } : {}) },
    ...(scenario === 'recall-error' ? { taskId: 'task', receipt: { messageId: 'actual', conversationId: 'private' } } : {}) }
  t.after(async () => { release.resolve(); await service?.close(); await rm(root, { recursive: true, force: true }) })
  const store = {
    async query(q) {
      if (q.kind === 'notification.list') return [structuredClone(row)]
      if (q.kind === 'notification.get') return structuredClone(row)
      if (q.kind === 'task.get') return { taskId: 'task', humanRequests: [{ requestId: 'request', status: 'answered', replyChannel: 'web' }] }
      if (q.kind === 'coordination.runtime') return { mode: 'active' }
      if (q.kind === 'task.events') return { events: [], nextCursor: 0 }
      return []
    },
    async command({ kind, args }) {
      if (kind === 'notification.start') { row.state = 'starting'; row.dispatchToken = 'send' }
      if (kind === 'notification.ack') row.ack = args.ack
      if (kind === 'notification.receipt') { row.state = args.state; row.receipt = args.receipt }
      // 并行的精确送达证明已入账，随后旧快照的失败诊断只能保留历史事实。
      if (kind === 'notification.diagnostic' && scenario === 'late-readback-error') {
        row.state = 'delivered'; row.receipt = { messageId: 'actual', visible: true }
      }
      if (kind === 'notification.recall.start') row.recall = { state: 'starting', token: 'recall', attempts: 1 }
      if (kind === 'notification.recall.result') row.recall = { ...row.recall, state: args.state, nextAttemptAt: args.nextAttemptAt }
      return { dispatchEligible: ['notification.start', 'notification.recall.start'].includes(kind), result: { notification: structuredClone(row) } }
    },
  }
  const noop = async () => {}
  service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } },
    config: { dbPath: join(root, 'unused.sqlite'), workspaceDir: root, instanceId: 'delivered-scan' },
    legacy: { getAgentConfig: () => ({ workspaceDir: root }) }, store,
    residentStore: { getGroup() {}, listGroups: () => [], async projectTaskNotification({ outbound }) {
      if (armed && outbound.notificationState === 'starting') {
        armed = false; release.resolve()
        await waitUntil(() => row.state === 'delivered', '原发送完成')
        await new Promise(resolve => setImmediate(resolve))
      }
    } },
    persistence: { register: noop, close: noop }, taskSessions: { close: noop }, executionSessions: { close: noop },
    notifications: {
      async send() { sends++; return { messageId: 'actual' } },
      async readback() {
        reads++
        if (scenario === 'late-readback-error' || reads > 1) throw new Error('TASK_NOTIFICATION_INCOMPLETE_READBACK')
        entered.resolve(); await release.promise
        return { messageId: 'actual', visible: true }
      },
      ...(scenario === 'recall-error' ? { async recall() { throw new Error('TASK_NOTIFICATION_RECALL_UNCONFIRMED') } } : {}),
    },
  })
  const first = service.whenIdle()
  if (scenario === 'stale-snapshot') {
    await entered.promise; armed = true
    await Promise.all([first, service.whenIdle()])
  } else await first
  await service.whenIdle()
  assert.equal(row.state, 'delivered')
  assert.equal(sends, scenario === 'stale-snapshot' ? 1 : 0)
  assert.equal(reads, scenario === 'recall-error' ? 0 : 1)
  const failures = service.listAlerts().filter(item => item.alertId === 'failure:notice')
  assert.equal(failures.length, scenario === 'recall-error' ? 1 : 0)
  if (scenario === 'recall-error') assert.equal(failures[0].detail, 'TASK_NOTIFICATION_RECALL_UNCONFIRMED')
})

// Real service scheduler with injected durable-store boundary and transport. No native profile/model required.
for (const scenario of ['recalled', 'not-due', 'no-adapter', 'due', 'expired-claim']) test(`recall scan converges and permits ordinary delivery: ${scenario}`, { timeout: 3000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'operator-scan-'))
  let service, taskReads = 0, starts = 0, recalls = 0, sends = 0
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }) })
  const operator = { id: 'operator-request', taskId: 'task', kind: 'question', state: 'delivered',
    payload: { audience: 'operator', humanRequestId: 'request' },
    receipt: { messageId: 'private-message', conversationId: 'private', senderActorId: 'self' },
    ...(scenario === 'recalled' ? { recall: { state: 'recalled' } } : scenario === 'not-due'
      ? { recall: { state: 'failed', nextAttemptAt: new Date(Date.now() + 60000).toISOString() } } : scenario === 'expired-claim'
      ? { recall: { state: 'starting', token: 'old-process', nextAttemptAt: new Date(Date.now() - 1).toISOString() } } : {}) }
  const ordinary = { id: 'ordinary', taskId: 'task', kind: 'status', state: 'prepared', payload: { text: 'ordinary update' } }
  const rows = [operator, ordinary]
  const store = {
    async query(q) {
      if (q.kind === 'notification.list') return structuredClone(rows)
      if (q.kind === 'notification.get') return structuredClone(rows.find(row => row.id === q.notificationId))
      if (q.kind === 'task.get') { taskReads++; return { taskId: 'task', humanRequests: [{ requestId: 'request', status: 'answered', replyChannel: 'web' }] } }
      if (q.kind === 'coordination.runtime') return { mode: 'active' }
      if (q.kind === 'task.events') return { events: [], nextCursor: 0 }
      return []
    },
    async command({ kind, args }) {
      const row = rows.find(row => row.id === args.notificationId)
      if (kind === 'notification.recall.start') { starts++; row.recall = { state: 'starting', token: 'claim', attempts: 1 }; return { dispatchEligible: true, result: { notification: structuredClone(row) } } }
      if (kind === 'notification.recall.result') row.recall = { ...row.recall, state: args.state }
      if (kind === 'notification.start') { row.state = 'starting'; row.dispatchToken = 'send'; return { dispatchEligible: true, result: { notification: structuredClone(row) } } }
      if (kind === 'notification.ack') row.ack = args.ack
      if (kind === 'notification.receipt') { row.state = args.state; row.receipt = args.receipt }
      return { dispatchEligible: false, result: { notification: structuredClone(row) } }
    },
  }
  const noop = async () => {}
  const open = () => openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } },
    config: { dbPath: join(root, 'unused.sqlite'), workspaceDir: root, instanceId: 'scan' },
    legacy: { getAgentConfig: () => ({ workspaceDir: root }) }, residentStore: { getGroup() {}, listGroups: () => [] }, store,
    persistence: { register: noop, close: noop }, taskSessions: { close: noop }, executionSessions: { close: noop },
    notifications: { async send() { sends++; return { messageId: 'ordinary-sent' } },
      async readback() { return { messageId: 'ordinary-sent', visible: true } },
      ...(scenario === 'no-adapter' ? {} : { async recall(notification) { recalls++; return { ...notification.receipt, recallStatus: 'SUCCESS' } } }) },
  })
  service = await open()
  await service.whenIdle()
  await service.whenIdle()
  await service.close()
  service = await open()
  await service.whenIdle()
  assert.equal(sends, 1)
  assert.equal(ordinary.state, 'delivered')
  assert.equal(starts, ['due', 'expired-claim'].includes(scenario) ? 1 : 0)
  assert.equal(recalls, ['due', 'expired-claim'].includes(scenario) ? 1 : 0)
  assert.equal(taskReads, ['due', 'expired-claim'].includes(scenario) ? 1 : 0, 'ineligible recalls must not perform task reads or occupy transport slots')
})

test('协调通知提交后即可发送，不等待同群下一条慢规划或恢复轮询', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'notification-plan-wake-'))
  const slowRelease = Promise.withResolvers()
  let host, slowFinished = false, slowStarted = false
  t.after(async () => { slowRelease.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await nativeTaskHost(root, async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
      routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
        units: ['测试助手，第一条；', '第二条'].map(quote => ({ unitKey: quote, summary: quote, sourceRefs: [{ quote }], dispatchOwner: 'coordination', topics: [], reason: '独立安排' })) })) } }]
    if (names.includes('coordination_submit')) {
      if (input.source.unitText.includes('第二条')) { slowStarted = true; await slowRelease.promise; slowFinished = true }
      return [{ name: 'coordination_submit', args: { kind: 'clarify', question: `${input.source.unitText}需要的内容`, candidates: [] } }]
    }
    return topicTaskCalls(request) ?? []
  }, { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } } })
  await host.service.ingest({ groupId: 'native-group', messageId: 'source', senderOpenDingTalkId: 'native-user',
    text: '测试助手，第一条；第二条', timestamp: new Date().toISOString() })
  await waitUntil(() => slowStarted, '下一条规划已挂起', 4000).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(host.service.listAlerts())}`) })
  await waitUntil(async () => (await host.query('notification.list')).some(item => item.state === 'delivered'), '第一条通知独立送达', 2000)
  assert.equal(slowFinished, false)
  assert.equal(host.sent.length, 1)
  slowRelease.resolve()
  await host.service.whenIdle()
})

for (const firstOutcome of ['delivered', 'unknown', 'rate-limited']) test(`通知释放串行槽后自动递进并保留发送边界: ${firstOutcome}`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'notification-drain-'))
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), sent = [], reads = []
    let host
    t.after(async () => { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => topicTaskCalls(request) ?? [], { notifications: {
      async send(notification) {
        sent.push(notification.id)
        if (notification.id === 'first') {
          entered.resolve(); await release.promise
          if (firstOutcome === 'rate-limited') throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT_ERROR' })
        }
        return { messageId: notification.id }
      },
      async readback(notification) { reads.push(notification.id); return notification.id === 'first' && firstOutcome === 'unknown'
        ? undefined : { messageId: notification.id, visible: true } },
    } })
    for (const id of ['first', 'second']) await host.service.store.command({ id: `prepare-${id}`, kind: 'notification.prepare', args: {
      notificationId: id, taskId: null, requirementRevision: 1, kind: 'topic-reply',
      payload: { conversationId: 'native-group', sourceMessageId: 'source', actorId: 'native-user', text: id, fact: { topicRefs: [{ topicId: 'topic', revision: 1 }] } } } })
    await host.service.recover()
    await entered.promise
    assert.deepEqual(sent, ['first'])
    release.resolve()
    if (firstOutcome === 'rate-limited') {
      await waitUntil(async () => (await host.query('notification.get', { notificationId: 'first' })).state === 'unknown', '限流结果落盘')
      await host.service.recover()
      assert.deepEqual(sent, ['first'], '主动续队不能绕过全局限流')
    } else {
      await waitUntil(async () => (await host.query('notification.get', { notificationId: 'second' })).state === 'delivered', '无需第二轮恢复即可投递下一条', 2000)
      assert.deepEqual(sent, ['first', 'second'])
      assert.deepEqual(reads, ['first', 'second'], '未知效果等待退避，不在续队时重发或循环回读')
    }
  })
