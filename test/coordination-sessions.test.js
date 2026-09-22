import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoordinationSessions, coordinationTools } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'

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

test('角色工具集合不给工程写工具，三种角色只允许对应业务提交', () => {
  for (const role of ['route', 'decision', 'review']) {
    const tools = coordinationTools(role)
    for (const name of ['pwsh', 'write', 'edit', 'subagent', 'create_goal']) assert.ok(!tools.includes(name))
  }
  assert.ok(!coordinationTools('route').includes('group_decision_submit'))
  assert.ok(!coordinationTools('review').includes('group_decision_submit'))
  assert.ok(!coordinationTools('decision').includes('group_task_review_submit'))
})
