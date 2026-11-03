import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { runScenario } from '../docs/acceptance/topic-routing-quality/scripts/run.mjs'
import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory, nativeRemove } from './fixtures/native-lifecycle.js'
import { available, reason, nativeTaskHost, topicTaskCalls, latestInput, waitUntil } from './fixtures/task-session-native-host.js'

test('评估宿主采集真实路由和决策终态，不访问付费模型', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'topic-eval-native-'))
  let host
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const calls = topicTaskCalls(request)
    if (request.tools.some(tool => tool.name === 'group_decision_submit')) {
      const decision = calls[0].args.decision
      decision.actions = []
      decision.reason = '只记录讨论'
      delete decision.reply
      delete decision.replyToMessageId
      delete decision.replyReview
    }
    return calls
  }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'eval-source', text: '测试助手，记录这条事项反馈，不创建任务。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  await t.step(() => host.service.whenIdle())
  const source = (await t.step(() => host.query('source.list'))).find(item => item.messageId === 'eval-source')
  const topic = host.residentStore.listTopics('native-group').find(item => item.entries.some(entry => entry.messageId === 'eval-source'))
  assert.ok(source?.processingCompleted)
  assert.equal(topic?.decisions.at(-1)?.status, 'completed')
  assert.ok(host.requests.some(request => request.tools.some(tool => tool.name === 'group_topic_route_submit')))
  assert.ok(host.requests.some(request => request.tools.some(tool => tool.name === 'group_decision_submit')))
  assert.equal((await t.step(() => host.query('task.list'))).length, 0)
  assert.equal(host.sent.length, 0)
}))

test('持久待判经受信引用恢复后进入真实决策终态', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'topic-eval-resume-'))
  let host, routeCalls = 0
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit') && routeCalls++ === 0) {
      const input = latestInput(request)
      return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({
        messageId: item.messageId, messageVersion: item.messageVersion, deferred: { reason: '无法确定目标事项' },
      })) } }]
    }
    const calls = topicTaskCalls(request)
    if (request.tools.some(tool => tool.name === 'group_decision_submit')) {
      Object.assign(calls[0].args.decision, { actions: [], reason: '只记录讨论' })
      delete calls[0].args.decision.reply
      delete calls[0].args.decision.replyToMessageId
      delete calls[0].args.decision.replyReview
    }
    return calls
  }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'pending-source', text: '测试助手，请核查那张发票。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  await t.step(() => host.service.whenIdle())
  const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'pending-source')
  assert.equal(held.routingStatus, 'needs-context')
  assert.equal(held.messageVersion, 1)
  assert.ok(Number.isInteger(held.routingHold.epoch))
  const source = (await t.step(() => host.query('source.list'))).find(item => item.messageId === 'pending-source')
  assert.notEqual(source.routed, true)
  assert.equal(source.processingCompleted, undefined)
  await assert.rejects(() => host.residentStore.updateRoutingHold({ groupId: 'native-group', messageId: 'pending-source', messageVersion: held.messageVersion, epoch: held.routingHold.epoch + 1, resume: true }), /topic_routing_hold_stale/)
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'clarification', text: '是北方供应商的发票。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:01:00Z', quotedMessage: { messageId: 'pending-source', content: '测试助手，请核查那张发票。' } }))
  await t.step(() => host.service.whenIdle())
  const after = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'pending-source')
  const topic = host.residentStore.listTopics('native-group').find(item => item.entries.some(entry => entry.messageId === 'pending-source'))
  assert.equal(after.routingStatus, 'routed')
  assert.ok(after.routingEpoch > held.routingHold.epoch)
  assert.equal(topic?.decisions.at(-1)?.status, 'completed')
  assert.ok((await t.step(() => host.query('source.list'))).find(item => item.messageId === 'pending-source')?.processingCompleted)
  assert.equal(host.sent.length, 0)
}))

test('任务发起人的取消通过真实授权和任务控制链', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'topic-eval-cancel-'))
  let host, taskId, topicId
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const input = latestInput(request)
      return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({
        messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ topicId, reason: '取消消息指向同一任务' }],
      })) } }]
    }
    if (names.includes('group_decision_submit')) {
      const input = latestInput(request), task = await host.query('task.get', { taskId })
      const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs,
          actions: [{ kind: 'task-cancel', taskId, inputVersion: task.requirementRevision, runSequence: task.runSequence,
            reason: '发起人撤销任务', topicRefs: [{ topicId: input.topicId, revision: input.revision }], basisUnitRefs }],
          reply: '已停止任务。', replyToMessageId: 'owner-cancel', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
    }
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待资料', evidence: [], limitations: [] } } }]
  }))
  await t.beginBusiness()
  const created = await t.step(() => host.service.createTask({ groupId: 'native-group', requestId: 'cancel-seed', title: '核对月报', objective: '核对财务月报' }))
  await t.step(() => host.service.whenIdle())
  const before = await t.step(() => host.query('task.get', { taskId: created.taskId }))
  assert.equal(before.ownerActorId, 'native-user')
  taskId = before.taskId; topicId = before.topicRefs[0].topicId
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'owner-cancel', text: '测试助手，取消我发起的财务月报核对任务。', senderName: '发起人', senderOpenDingTalkId: before.ownerActorId, sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  try {
    await t.step(() => waitUntil(async () => (await host.query('task.get', { taskId })).control === 'cancelled', '任务取消', 5000))
  } catch (error) {
    error.message += `; tools=${JSON.stringify(host.toolResults)}; task=${JSON.stringify(await host.query('task.get', { taskId }))}`
    throw error
  }
  await t.step(() => host.service.whenIdle())
  const after = await t.step(() => host.query('task.get', { taskId }))
  assert.equal(after.control, 'cancelled')
  assert.ok((await t.step(() => host.query('source.list'))).find(item => item.messageId === 'owner-cancel')?.processingCompleted)
}))

test('评估 runner 同路径离线播种多消息并采集真实请求', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const scenarios = JSON.parse(await readFile(new URL('../docs/acceptance/topic-routing-quality/fixtures/scenarios.json', import.meta.url)))
  const scenario = scenarios.find(item => item.id === 'quote-01')
  const profile = new URL('./fixtures/native-profile/package.json', import.meta.url)
  await t.beginBusiness()
  const result = await t.step(() => runScenario(scenario, { provider: 'unused', model: 'unused' }, fileURLToPath(profile), { maxStreams: 100 }, { offline: true }))
  assert.deepEqual(result.failures, [])
  assert.equal(result.mode, 'offline-contract')
  assert.equal(result.streams, 0)
  assert.equal(result.summary, null)
  assert.deepEqual(result.cleanups, [{ id: 'quote-01', absent: true }])
  assert.equal(result.results[0].modelQuality, 'not-measured')
  assert.deepEqual(new Set(result.results[0].observation.routes.map(route => route.messageId)), new Set(['m1', 'm2']))
  assert.ok(result.results[0].observation.requestTools.includes('group_topic_route_submit'))
  assert.ok(result.results[0].observation.requestTools.includes('group_decision_submit'))
  assert.ok(result.wire.length >= 2)
}))

for (const id of ['task-02', 'cross-01', 'context-02']) {
  test(`评估 runner 同路径验证状态与隔离：${id}`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const scenarios = JSON.parse(await readFile(new URL('../docs/acceptance/topic-routing-quality/fixtures/scenarios.json', import.meta.url)))
    const scenario = scenarios.find(item => item.id === id)
    await t.beginBusiness()
    const result = await t.step(() => runScenario(scenario, { provider: 'unused', model: 'unused' }, fileURLToPath(new URL('./fixtures/native-profile/package.json', import.meta.url)), { maxStreams: 100 }, { offline: true }))
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.cleanups, [{ id, absent: true }])
    const observation = result.results[0].observation
    assert.equal(result.results[0].modelQuality, 'not-measured')
    if (id === 'task-02') assert.deepEqual(observation.seededTasks, [{ id: scenario.input.tasks[0].id, ownerActorId: scenario.input.tasks[0].ownerActorId, state: 'running' }])
    if (id === 'cross-01') {
      assert.equal(observation.seededForeignTopics, 1)
      assert.ok(observation.candidates.includes('exhibit-release'))
    }
    if (id === 'context-02') {
      assert.equal(observation.recovery.messageVersion, 1)
      assert.equal(observation.recovery.observedUnrelatedHold, true)
      assert.ok(observation.recovery.recoveredEpoch > observation.recovery.previousEpoch)
      assert.equal(observation.routeStatus, 'routed')
    }
  }))
}
