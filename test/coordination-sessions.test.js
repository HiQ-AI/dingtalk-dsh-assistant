import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoordinationSessions, createCoordinationStepGate, coordinationTools } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(t) {
  const requests = new Set(), handles = [], errors = []
  const manager = createCoordinationSessions({ isCurrent: request => requests.has(request), onError: error => errors.push(error),
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
