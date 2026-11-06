import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { createCoordinationSessions, createCoordinationStepGate, coordinationTools, triageRole } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'
import { createConversationRouterSessions } from '../packages/dingtalk-dsh-assistant/conversation-router-session.js'
import { assertRouterDependencies, createRouterSourceExposure } from '../packages/dingtalk-dsh-assistant/conversation-router.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function routerFixture(t) {
  const handles = new Map()
  let durable = true
  let authoritative = { groupId: 'g', conversationType: 'group', conversationId: 'g', generation: 1, lease: 1, sessionId: 'old' }
  const make = binding => {
    const handle = { disposed: false, messages: [], agent: {
      session: { id: binding.sessionId, firstLiveSeq: 0, inheritedEventCount: 0, snapshotEvents: () => [] }, inbox: { nextTurn: [], nextStep: [] },
      steer(message) { handle.messages.push(message) }, cancel() {}, whenIdle: async () => {},
      runMaintenance: callback => callback(new AbortController().signal),
    }, async dispose() { handle.disposed = true } }
    handles.set(binding.sessionId, handle)
    return handle
  }
  const manager = createConversationRouterSessions({ ctx: { sessions: { flush: async () => durable } },
    create: async binding => make(binding), resume: async binding => make(binding),
    isCurrent: binding => JSON.stringify(binding) === JSON.stringify(authoritative),
  })
  t.after(() => manager.close())
  return { manager, handles, get binding() { return authoritative }, setBinding(value) { authoritative = value }, setDurable(value) { durable = value } }
}

for (const phase of ['create', 'resume']) test(`Router ${phase} 尚未返回句柄时关闭会中止并释放`, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const binding = { groupId: 'g', conversationType: 'group', conversationId: 'g', generation: 1, lease: 1, sessionId: 's' }
  let observed, disposed = false
  const open = async (_binding, signal) => {
    observed = signal
    entered.resolve()
    await release.promise
    return { agent: { session: { id: 's' }, cancel() {}, whenIdle: async () => {} }, async dispose() { disposed = true } }
  }
  const manager = createConversationRouterSessions({ ctx: { sessions: { flush: async () => true } }, create: open, resume: open, isCurrent: () => true })
  const running = phase === 'create' ? manager.prepare({ binding }) : manager.run({ binding, input: {} })
  const outcome = running.catch(error => error)
  await entered.promise
  const reason = new Error('closed')
  manager.stop(reason)
  assert.equal(observed.aborted, true)
  assert.equal(observed.reason, reason)
  release.resolve()
  assert.equal(await outcome, reason)
  await manager.close()
  assert.equal(disposed, true)
})

test('Router 依赖必须读取当前 surface 上的精确任务版本', () => {
  const dependency = { taskId: 'a', requirementRevision: 1, contextRevision: 2, controlRevision: 3, runSequence: 4 }
  const result = { task: { ...dependency, status: 'completed', drained: true }, executions: [], operations: [] }
  const reads = new Map([['a', { callId: 'call', result }]])
  let surface = [{ role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify(result) }] }]
  const agent = { session: { deriveMessages: () => surface } }
  assert.doesNotThrow(() => assertRouterDependencies(agent, reads, [dependency]))
  assert.throws(() => assertRouterDependencies(agent, reads, [{ ...dependency, runSequence: 5 }]), /dependency_stale/)
  assert.throws(() => assertRouterDependencies(agent, reads, [dependency, dependency]), /dependency_invalid/)
  result.operations.push({ state: 'unknown' })
  surface[0].content[0].text = JSON.stringify(result)
  assert.throws(() => assertRouterDependencies(agent, reads, [dependency]), /dependency_unsettled/)
  surface = []
  assert.throws(() => assertRouterDependencies(agent, reads, [dependency]), /dependency_unread/)
})

test('Router 授权仅认当前 surface 上完整首包与精确工具分页', async () => {
  const source = { sourceId: 's', messageId: 'm', version: 1, text: '甲'.repeat(3000) }
  const exposure = createRouterSourceExposure({ batchId: 'batch', sources: [source] })
  let surface = []
  const agent = { session: { deriveMessages: () => surface } }
  assert.throws(() => exposure.assertVisible(agent, ['s']), /unread/)
  surface = [exposure.message]
  exposure.assertContextVisible(agent)
  surface = [{ ...exposure.message, content: [{ type: 'text', text: '压缩后的内容' }] }]
  assert.throws(() => exposure.assertContextVisible(agent), /router_context_unread/)
  surface = []
  assert.throws(() => exposure.assertContextVisible(agent), /router_context_unread/)
  surface = [exposure.message]
  assert.throws(() => exposure.assertVisible(agent, ['s']), /unread/)
  const page = exposure.read({ sourceId: 's', offset: 1000 })
  const tool = exposure.tool(async () => {})
  assert.deepEqual(await tool.execute({ sourceId: 's', offset: 1000 }, { agent, signal: new AbortController().signal }), page)
  await assert.rejects(exposure.tool(async () => { throw new Error('stale') }).execute({ sourceId: 's', offset: 1000 }, { agent, signal: new AbortController().signal }), /stale/)
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'read', name: 'router_source_read' }] }
  const output = { role: 'tool', toolCallId: 'read', content: [{ type: 'text', text: JSON.stringify(page) }] }
  surface = [exposure.message, call, { ...output, isError: true }]
  assert.throws(() => exposure.assertVisible(agent, ['s']), /unread/)
  surface = [exposure.message, call, output]
  exposure.assertVisible(agent, ['s'])
  surface = [call, output]
  assert.throws(() => exposure.assertVisible(agent, ['s']), /unread/)
  assert.throws(() => exposure.assertVisible(agent, ['other']), /unadmitted/)
})

test('Router 换代失败保留旧会话，成功后围栏旧代并恢复新代', async t => {
  const h = routerFixture(t), oldBinding = h.binding
  await h.manager.run({ binding: oldBinding, input: { id: 'one' } })
  const old = h.handles.get('old')
  const candidate = { ...oldBinding, generation: 2, lease: undefined, sessionId: 'new' }
  h.setDurable(false)
  await assert.rejects(h.manager.prepare({ binding: candidate }), /NOT_DURABLE/)
  assert.equal(old.disposed, false)
  assert.equal(h.handles.get('new').disposed, true)
  h.setDurable(true)
  await h.manager.prepare({ binding: candidate })
  await h.manager.withIdle({ binding: oldBinding }, async () => false)
  await h.manager.abortPrepare({ binding: candidate })
  assert.equal(old.disposed, false)
  await h.manager.prepare({ binding: candidate })
  const newBinding = { ...candidate, lease: 2 }
  await h.manager.withIdle({ binding: oldBinding }, async () => h.setBinding(newBinding))
  await h.manager.activate({ oldBinding, newBinding })
  assert.equal(old.disposed, true)
  await assert.rejects(h.manager.assert(old.agent, oldBinding), /STALE/)
  await h.manager.run({ binding: newBinding, input: { id: 'two' } })
  assert.deepEqual(h.handles.get('new').messages, [{ id: 'two' }])
})

test('Router 原生 Inbox 未空或会话忙时不能执行换代', async t => {
  const h = routerFixture(t), binding = h.binding
  await h.manager.run({ binding, input: { id: 'one' } })
  const handle = h.handles.get('old')
  handle.agent.inbox.nextStep.push({ id: 'parked' })
  let rotated = false
  await assert.rejects(h.manager.withIdle({ binding }, async () => { rotated = true }), /INBOX_PENDING/)
  assert.equal(rotated, false)
  handle.agent.inbox.nextStep.length = 0
  const started = deferred(), release = deferred()
  const rotating = h.manager.withIdle({ binding }, async () => { started.resolve(); await release.promise })
  await started.promise
  await assert.rejects(h.manager.run({ binding, input: { id: 'late' } }), /BUSY/)
  release.resolve()
  await rotating
  assert.equal(handle.disposed, false)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('仅普通两级分诊收紧通用工具并排除迁移提交', () => {
  for (const [role, request] of [['route', { requestId: 'coord-route-a' }], ['decision', { requestId: 'coord-decision-a' }]]) {
    assert.equal(triageRole(request), role)
    for (const name of ['read', 'glob', 'grep', 'skill', 'group_topic_title_submit', 'group_topic_summary_submit']) assert.ok(!coordinationTools(role, request).includes(name), name)
    assert.ok(coordinationTools(role, request).includes('group_message_get'))
  }
  for (const [role, request] of [['route', { requestId: 'coord-title-a' }], ['route', { requestId: 'coord-summary-a' }], ['decision', { requestId: 'coord-decision-f', trigger: 'task-facts' }], ['review', { requestId: 'coord-decision-review', kind: 'completion' }]]) {
    assert.equal(triageRole(request), null)
    assert.ok(coordinationTools(role, request).includes('read'))
  }
})

test('仅未获得句柄的创建错误标记为启动失败，steer 失败不可自动重放', async t => {
  const startup = Object.assign(new Error('invalid preset'), { code: 'agent-preset/invalid' })
  const request = { groupId: 'g', requestId: 'coord-route-startup' }
  const creating = createCoordinationSessions({ create: async () => { throw startup }, isCurrent: () => true, onError() {} })
  t.after(() => creating.close())
  await assert.rejects(creating.dispatch(request, { id: 'original' }), error => error === startup && error.coordinationStartupFailure === true && error.code === 'agent-preset/invalid')
  const steering = new Error('steer failed')
  const created = createCoordinationSessions({ isCurrent: () => true, onError() {}, create: async () => ({
    agent: { session: { snapshotEvents: () => [], append() {} }, inbox: {}, steer() { throw steering }, whenIdle: async () => {} }, dispose: async () => {},
  }) })
  t.after(() => created.close())
  await assert.rejects(created.dispatch(request, { id: 'original' }), error => error === steering && error.coordinationStartupFailure !== true)
})
function fixture(t, onStage) {
  const requests = new Set(), handles = [], errors = []
  const manager = createCoordinationSessions({ isCurrent: request => requests.has(request), onError: error => errors.push(error), ...(onStage ? { onStage } : {}),
    create: async entry => {
      const events = [], idle = deferred()
      const handle = { entry, events, idle, disposed: 0, cancellations: 0,
        agent: { session: { id: entry.sessionId, snapshotEvents: () => events, append(type, data) { events.push({ type, data }) } }, inbox: {},
          steer(message) { events.push({ type: 'user/message', data: message }) }, whenIdle: () => idle.promise,
          cancel() { handle.cancellations++; idle.resolve() } },
        async dispose() { handle.disposed++ },
      }
      handles.push(handle)
      return handle
    } })
  t.after(() => manager.close())
  const request = (role, id, groupId = 'g') => { const value = { requestId: `coord-${role}-${id}`, groupId }; requests.add(value); return value }
  return { manager, requests, handles, errors, request }
}

test('请求句柄按群和请求隔离，重复提醒复用；失效请求拒绝工具并释放一次', async t => {
  const h = fixture(t), a = h.request('route', 'a'), b = h.request('decision', 'b', 'b')
  const agent = await h.manager.dispatch(a, { id: 'a-1' })
  const other = await h.manager.dispatch(b, { id: 'b-1' })
  assert.notEqual(agent.session.id, other.session.id)
  assert.equal(h.manager.assert(agent, 'g', a.requestId).request, a)
  assert.throws(() => h.manager.assert(agent, 'b', b.requestId), /wrong_request/)
  assert.throws(() => h.manager.assert(agent, 'g', b.requestId), /wrong_request/)
  h.handles[0].idle.resolve(); await tick()
  assert.equal(await h.manager.dispatch(a, { id: 'a-1' }), agent)
  assert.equal(h.handles[0].events.filter(event => event.type === 'user/message').length, 1)
  h.requests.delete(a); h.manager.finish(a); h.manager.finish(a)
  assert.throws(() => h.manager.assert(agent, 'g', a.requestId), /wrong_request/)
  await tick(); await tick()
  assert.equal(h.handles[0].disposed, 1)
  assert.equal(h.errors.length, 0)
})

test('活跃路由追加立即进入原会话，稳定消息身份不重复投递', async t => {
  const h = fixture(t), route = h.request('route', 'live')
  const agent = await h.manager.dispatch(route, { id: 'initial' })
  const update = { id: 'batch-1' }
  assert.equal(await h.manager.dispatch(route, update, { inFlightRouteUpdate: true }), agent)
  assert.equal(await h.manager.dispatch(route, update, { inFlightRouteUpdate: true }), agent)
  assert.deepEqual(h.handles[0].events.filter(event => event.type === 'user/message').map(event => event.data.id), ['initial', 'batch-1'])
  assert.equal(h.handles.length, 1)
})

test('在途追加 steer 失败向调用方返回，不自动重放', async t => {
  const h = fixture(t), route = h.request('route', 'steer-error')
  const agent = await h.manager.dispatch(route, { id: 'initial' })
  const failure = new Error('update failed')
  let attempts = 0
  agent.steer = () => { attempts++; throw failure }
  await assert.rejects(h.manager.dispatch(route, { id: 'batch-1' }, { inFlightRouteUpdate: true }), error => error === failure)
  assert.equal(attempts, 1)
  assert.equal(h.handles.length, 1)
})

test('首包尚未投递时追加不能抢先进入会话', async t => {
  const entered = deferred(), release = deferred()
  let blocked = false
  const h = fixture(t, async (_request, stage) => {
    if (stage.completedAt && !blocked) { blocked = true; entered.resolve(); await release.promise }
  })
  t.after(() => release.resolve())
  const route = h.request('route', 'starting')
  const first = h.manager.dispatch(route, { id: 'initial' })
  await entered.promise
  const update = h.manager.dispatch(route, { id: 'batch-1' }, { inFlightRouteUpdate: true })
  assert.equal(h.handles[0].events.some(event => event.type === 'user/message'), false)
  release.resolve(); await first; await tick()
  assert.deepEqual(h.handles[0].events.filter(event => event.type === 'user/message').map(event => event.data.id), ['initial', 'batch-1'])
  await update
  h.handles[0].idle.resolve()
})

test('已让出或失效的路由追加不得绕过同群队列', async t => {
  const h = fixture(t), route = h.request('route', 'yield'), other = h.request('checkpoint', 'other')
  await h.manager.dispatch(route, { id: 'initial' })
  const pendingOther = h.manager.dispatch(other, { id: 'other' })
  h.handles[0].entry.yieldRequested = true
  let delivered = false
  const update = h.manager.dispatch(route, { id: 'batch-1' }, { inFlightRouteUpdate: true }).then(() => { delivered = true })
  await tick()
  assert.equal(delivered, false)
  assert.equal(h.handles[0].events.some(event => event.data?.id === 'batch-1'), false)
  h.requests.delete(route)
  const rejected = assert.rejects(update, /inactive/)
  h.handles[0].idle.resolve()
  await Promise.all([pendingOther, rejected])
  assert.equal(h.handles[0].events.some(event => event.data?.id === 'batch-1'), false)
})

test('同群模型串行，入站路由抢占当前审阅并先于排队审阅，不增加模型并发', async t => {
  const h = fixture(t), first = h.request('checkpoint', 'a'), second = h.request('checkpoint', 'b'), route = h.request('route', 'cancel')
  await h.manager.dispatch(first, { id: 'a' })
  let secondDelivered = false
  const pending = h.manager.dispatch(second, { id: 'b' }).then(value => { secondDelivered = true; return value })
  await tick(); assert.equal(secondDelivered, false)
  const routing = h.manager.dispatch(route, { id: 'cancel' })
  assert.equal(h.handles[0].entry.yieldRequested, true)
  assert.equal(h.handles[0].cancellations, 0, '先保留当前提交工具结果，再交还模型槽')
  h.handles[0].idle.resolve()
  const routed = await routing
  assert.equal(h.handles[1].agent, routed)
  assert.equal(secondDelivered, false)
  h.handles[1].idle.resolve(); await pending
  assert.equal(h.handles[2].entry.request, second)
})

test('同request耗尽后立即恢复等待旧句柄释放，创建新日志且旧agent永远失效', async t => {
  const h = fixture(t), request = h.request('checkpoint', 'retry')
  const old = await h.manager.dispatch(request, { id: 'original' })
  h.manager.finish(request)
  h.handles[0].idle.resolve()
  const current = await h.manager.dispatch(request, { id: 'original' })
  assert.notEqual(old.session.id, current.session.id)
  assert.equal(h.handles[0].disposed, 1)
  assert.throws(() => h.manager.assert(old, 'g', request.requestId), /wrong_request/)
  assert.equal(h.handles[1].events.filter(event => event.type === 'user/message').length, 1)
})

test('路由量子续行排到决策之后仍能选中路由，不在队首反复让位空转', async t => {
  const h = fixture(t), routing = h.request('route', 'sliced'), decision = h.request('decision', 'waiting')
  await h.manager.dispatch(routing, { id: 'route-first-step' })
  const waiting = h.manager.dispatch(decision, { id: 'decision-after-route' })
  h.handles[0].entry.sliceYielded = true
  h.handles[0].idle.resolve()
  const delivered = await waiting
  assert.equal(delivered, h.handles[1].agent)
  assert.equal(h.handles[0].events.filter(event => event.type === 'dingtalk/coordination-dispatched').length, 2)
  assert.equal(h.handles[1].events.find(event => event.type === 'dingtalk/coordination-dispatched').data.priorRouteBurst, 2)
  assert.deepEqual(h.errors, [])
})

test('角色工具集合不给工程写工具，三种角色只允许对应业务提交', () => {
  for (const role of ['route', 'decision', 'review']) {
    const tools = coordinationTools(role)
    for (const name of ['pwsh', 'write', 'edit', 'subagent', 'create_goal']) assert.ok(!tools.includes(name))
  }
  assert.ok(!coordinationTools('route').includes('group_decision_submit'))
  assert.ok(!coordinationTools('review').includes('group_decision_submit'))
  assert.ok(!coordinationTools('decision').includes('group_task_review_submit'))
})

test('连续两批路由后最老审阅获得公平轮，新增路由不能立即让它 yield', async t => {
  const h = fixture(t)
  const first = h.request('route', '1'), second = h.request('route', '2'), third = h.request('route', '3')
  const oldReview = h.request('checkpoint', 'old'), newReview = h.request('checkpoint', 'new')
  await h.manager.dispatch(first, { id: 'route1' })
  const oldPending = h.manager.dispatch(oldReview, { id: 'old' })
  const newPending = h.manager.dispatch(newReview, { id: 'new' })
  const secondPending = h.manager.dispatch(second, { id: 'route2' })
  const thirdPending = h.manager.dispatch(third, { id: 'route3' })
  h.handles[0].idle.resolve(); await secondPending
  assert.equal(h.handles[1].entry.request, second)
  h.handles[1].idle.resolve(); await oldPending
  const review = h.handles[2]
  assert.equal(review.entry.request, oldReview)
  assert.equal(review.entry.fairnessTurn, true)
  const fourthPending = h.manager.dispatch(h.request('route', '4'), { id: 'route4' })
  assert.equal(review.entry.yieldRequested, false)
  const dispatch = review.events.find(event => event.type === 'dingtalk/coordination-dispatched').data
  assert.equal(dispatch.priorRouteBurst, 2)
  assert.equal(dispatch.fairnessTurn, true)
  assert.equal(dispatch.role, 'review')
  assert.ok(dispatch.dispatchedAt >= dispatch.queuedAt)
  assert.equal(dispatch.queueDepth, 2)
  review.idle.resolve(); await thirdPending
  h.handles[3].idle.resolve(); await fourthPending
  h.handles[4].idle.resolve(); await newPending
  assert.equal(h.handles[5].entry.request, newReview)
})

test('过期公平轮不运行模型，最老有效请求接续；保护公平轮仍受版本门禁约束', async t => {
  const h = fixture(t), first = h.request('route', '1'), second = h.request('route', '2')
  await h.manager.dispatch(first, { id: 'r1' })
  const expired = h.request('checkpoint', 'expired'), current = h.request('checkpoint', 'current')
  const expiredPending = h.manager.dispatch(expired, { id: 'expired' })
  const rejection = assert.rejects(expiredPending, /inactive/)
  const currentPending = h.manager.dispatch(current, { id: 'current' })
  const secondPending = h.manager.dispatch(second, { id: 'r2' })
  h.requests.delete(expired)
  h.handles[0].idle.resolve(); await secondPending
  h.handles[1].idle.resolve(); await currentPending; await rejection
  assert.equal(h.handles.length, 3)
  const entry = h.handles[2].entry
  assert.equal(entry.fairnessTurn, true)
  h.requests.delete(current)
  const gate = createCoordinationStepGate(entry, request => h.requests.has(request))
  assert.deepEqual(gate({}, () => { throw new Error('expired must not proceed') }), { kind: 'reject' })
  assert.throws(() => h.manager.assert(h.handles[2].agent, 'g', current.requestId), /wrong_request/)
})

test('显式取消排队请求不创建会话，公平轮中取消仍结束正在执行的会话', async t => {
  const h = fixture(t)
  await h.manager.dispatch(h.request('route', '1'), { id: 'r1' })
  const cancelled = h.request('checkpoint', 'cancelled')
  const pending = h.manager.dispatch(cancelled, { id: 'cancelled' })
  const rejected = assert.rejects(pending, /inactive/)
  h.manager.finish(cancelled, { cancel: true }); await rejected
  const second = h.manager.dispatch(h.request('route', '2'), { id: 'r2' })
  const review = h.request('checkpoint', 'review'), reviewPending = h.manager.dispatch(review, { id: 'review' })
  h.handles[0].idle.resolve(); await second
  h.handles[1].idle.resolve(); await reviewPending
  assert.equal(h.handles.length, 3)
  assert.equal(h.handles[2].entry.fairnessTurn, true)
  h.manager.finish(review, { cancel: true })
  await tick(); await tick()
  assert.equal(h.handles[2].cancellations, 1)
  assert.equal(h.handles[2].disposed, 1)
})

test('两群路由计数和模型槽互相独立', async t => {
  const h = fixture(t)
  const a1 = await h.manager.dispatch(h.request('route', '1', 'a'), { id: 'a1' })
  const b1 = await h.manager.dispatch(h.request('checkpoint', '1', 'b'), { id: 'b1' })
  assert.notEqual(a1.session.id, b1.session.id)
  const a2Pending = h.manager.dispatch(h.request('route', '2', 'a'), { id: 'a2' })
  h.handles[0].idle.resolve(); await a2Pending
  const b2Pending = h.manager.dispatch(h.request('route', '2', 'b'), { id: 'b2' })
  assert.equal(h.handles[1].entry.yieldRequested, true, 'A 的连续路由计数不能保护 B 的普通审阅')
  h.handles[1].idle.resolve(); await b2Pending
  const b2 = h.handles.find(handle => handle.entry.request.groupId === 'b' && handle.entry.role === 'route')
  assert.equal(b2.events.find(event => event.type === 'dingtalk/coordination-dispatched').data.priorRouteBurst, 0)
})


test('决策短事务连续三步完成而非每次读取重新排队，超时和路由抢占仍在边界让出', async () => {
  const make = () => ({ active: true, role: 'decision', request: {}, sliceSteps: 0, sliceStartedAt: Date.now(), hasContenders: () => true })
  const entry = make(), gate = createCoordinationStepGate(entry, () => true)
  let calls = 0
  for (let step = 0; step < 3; step++) await gate({ messages: [], agent: { inbox: {} } }, () => { calls++; return {} })
  assert.equal(calls, 3, '读取、审阅、提交不需要遍历整群队列三次')
  assert.deepEqual(await gate({ messages: [], agent: { inbox: {} } }, () => { throw new Error('fourth step must yield') }), { kind: 'reject' })
  assert.equal(entry.sliceYielded, true)
  const timed = make(); timed.sliceSteps = 1; timed.sliceStartedAt -= 30_001
  assert.deepEqual(await createCoordinationStepGate(timed, () => true)({ messages: [], agent: { inbox: {} } }, () => { throw new Error('time budget') }), { kind: 'reject' })
  const preempted = make(); preempted.yieldRequested = true
  assert.deepEqual(await createCoordinationStepGate(preempted, () => true)({ messages: [], agent: { inbox: {} } }, () => { throw new Error('route preempts before budget') }), { kind: 'reject' })
})

test('排队阶段冻结开始时来源，延迟计时和在途追加不回填旧阶段', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), seen = []
  const manager = createCoordinationSessions({ eventPrefix: null, isCurrent: () => true, onError(error) { throw error },
    onStage: async (request, stage) => {
      if (!stage.completedAt) { entered.resolve(); await release.promise }
      seen.push({ completedAt: stage.completedAt, messages: request.messages.map(({ messageId, messageVersion }) => ({ messageId, messageVersion })) })
    },
    create: async entry => ({ agent: { session: { id: entry.sessionId, snapshotEvents: () => [] }, inbox: {}, steer() {}, whenIdle: async () => {} }, dispose: async () => {} }) })
  t.after(async () => { release.resolve(); await manager.close() })
  const request = { groupId: 'g', requestId: 'coord-route-timing', messages: [{ messageId: 'first', messageVersion: 1 }] }
  const pending = manager.dispatch(request, { id: 'input' })
  await entered.promise
  request.messages.push({ messageId: 'later', messageVersion: 1 })
  release.resolve()
  await pending
  await manager.whenSettled(request)
  assert.deepEqual(seen.map(item => item.messages), [[{ messageId: 'first', messageVersion: 1 }], [{ messageId: 'first', messageVersion: 1 }]])
  assert.equal(seen[0].completedAt, null)
  assert.ok(seen[1].completedAt)
})

test('真实来源账本中排队跨度不因在途追加改变身份或回溯新来源', async t => {
  const root = await mkdtemp(join(tmpdir(), 'queue-stage-'))
  const store = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.sqlite'), instanceId: 'fixture', initialize: true })
  let sequence = 0
  const command = (kind, args) => store.command({ id: `command-${++sequence}`, kind, args })
  for (const sourceId of ['first', 'later']) await command('source.record', { sourceId, groupId: 'g', messageId: sourceId, actorId: 'a', text: 'test' })
  const opened = Promise.withResolvers(), release = Promise.withResolvers(), errors = []
  const manager = createCoordinationSessions({ eventPrefix: null, isCurrent: () => true, onError: error => errors.push(error),
    onStage: async (request, stage) => {
      const sources = await store.query({ kind: 'source.list', groupId: request.groupId })
      const matched = sources.filter(source => request.messages.some(ref => ref.messageId === source.messageId && ref.messageVersion === source.version))
      for (const source of matched) await command('source.stage', { sourceId: source.sourceId, stage: { ...stage, shared: matched.length > 1 } })
      if (!stage.completedAt) { opened.resolve(); await release.promise }
    },
    create: async entry => ({ agent: { session: { id: entry.sessionId, snapshotEvents: () => [] }, inbox: {}, steer() {}, cancel() {}, whenIdle: async () => {} }, dispose: async () => {} }) })
  t.after(async () => { release.resolve(); await manager.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const request = { groupId: 'g', requestId: 'coord-route-ledger', messages: [{ messageId: 'first', messageVersion: 1 }] }
  const pending = manager.dispatch(request, { id: 'input' })
  await opened.promise
  request.messages.push({ messageId: 'later', messageVersion: 1 })
  release.resolve()
  await pending
  await manager.close()
  assert.deepEqual(errors.map(error => error.code), [])
  const first = await store.query({ kind: 'source.get', sourceId: 'first' })
  const later = await store.query({ kind: 'source.get', sourceId: 'later' })
  assert.equal(first.stages.length, 1)
  assert.equal(first.stages[0].shared, false)
  assert.ok(first.stages[0].completedAt)
  assert.equal((later.stages ?? []).length, 0)
})

test('eventPrefix null still observes real queue intervals with no prompt and unchanged dispatch count', async t => {
  const stages = [], events = []
  let sequence = 0
  const manager = createCoordinationSessions({ eventPrefix: null, isCurrent: () => true, onError(error) { throw error },
    onStage: async (request, stage) => stages.push({ requestId: request.requestId, ...stage }),
    create: async entry => ({ agent: { session: { id: entry.sessionId, snapshotEvents: () => events, append() { assert.fail('eventPrefix null must not append custom events') } },
      inbox: {}, steer(message) { sequence++; events.push({ type: 'user/message', data: message }) }, whenIdle: async () => {} }, dispose: async () => {} }) })
  t.after(() => manager.close())
  const request = { groupId: 'g', requestId: 'coord-route-timing', messages: [{ messageId: 'm', messageVersion: 1, text: 'private' }] }
  await manager.dispatch(request, { id: 'input', text: 'private' })
  await manager.whenSettled(request)
  assert.equal(sequence, 1)
  assert.equal(stages.length, 2)
  assert.equal(stages[0].completedAt, null)
  assert.equal(stages[0].spanId, stages[1].spanId)
  assert.ok(Date.parse(stages[1].completedAt) >= Date.parse(stages[1].startedAt))
  assert.equal(JSON.stringify(stages).includes('private'), false)
})
