// 请求会话只管理模型运行句柄；业务版本、授权与提交仍由 Topic coordinator 持有。
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createTaskReportStepGate } from './task-report-step-gate.js'

export function createCoordinationStepGate(entry, isCurrent) {
  const yieldGate = createTaskReportStepGate({ isBlocked: () => entry.yieldRequested === true || entry.request.routingPaused === true, isResolutionMessage: () => false })
  return (event, next) => {
    if (!entry.active || !isCurrent(entry.request)) return { kind: 'reject' }
    // 只在原生 step 边界让出：上一轮工具、post-execute 和结果日志已经落稳。
    if ((entry.sliceSteps ?? 0) >= 1 && entry.hasContenders?.()) {
      entry.yieldRequested = true
    }
    // 路由也可能在首个 step 前抢占；原输入仍在 Inbox，必须按公平队列自动续行。
    if (entry.yieldRequested && !entry.request.routingPaused) entry.sliceYielded = true
    return yieldGate(event, () => { entry.sliceSteps = (entry.sliceSteps ?? 0) + 1; return next() })
  }
}

export const coordinationRole = request => request.kind && ['checkpoint', 'completion', 'waiting'].includes(request.kind)
  ? 'review' : /^coord-(route|title|summary)-/.test(request.requestId) ? 'route'
    : request.requestId.startsWith('coord-decision-') ? 'decision' : 'review'

export function coordinationTools(role) {
  const reads = ['read', 'glob', 'grep', 'skill', 'group_task_context_get', 'group_task_list', 'group_topic_list', 'group_topic_context_get', 'group_message_get', 'group_resource_get']
  const submits = role === 'route' ? ['group_topic_route_context_get', 'group_topic_route_submit', 'group_topic_title_submit', 'group_topic_summary_submit']
    : role === 'decision' ? ['group_decision_context_get', 'group_decision_submit', 'group_reply_review_get', 'group_topic_route_review']
      : ['group_reply_review_get', 'group_task_review_context_get', 'group_task_prompt_get', 'group_reply_submit', 'group_task_review_submit']
  return [...reads, ...submits]
}

export function createCoordinationSessions({ create, isCurrent, onError }) {
  const entries = new Map(), bySession = new Map(), tails = new Map(), queues = new Map(), active = new Map(), pending = new Set(), routeBursts = new Map()
  let closed = false
  const keyOf = request => `${request.groupId}:${request.requestId}`
  async function obtain(request) {
    const key = keyOf(request)
    let entry = entries.get(key)
    if (entry && !entry.active) { await entry.disposal; entry = entries.get(key) }
    if (entry) return entry.ready
    const suffix = createHash('sha256').update(key).digest('hex').slice(0, 24)
    entry = { request, role: coordinationRole(request), sessionId: `session-coordination-${suffix}-${randomUUID().slice(0, 8)}`, active: true }
    entries.set(key, entry)
    entry.ready = (async () => {
      try {
        entry.handle = await create(entry)
        if (closed || !entry.active || !isCurrent(request)) { await entry.handle.dispose(); throw new Error('coordination_request_inactive') }
        bySession.set(entry.sessionId, entry)
        return entry
      } catch (error) { if (entries.get(key) === entry) entries.delete(key); throw error }
    })()
    return entry.ready
  }
  function get(groupId, request) { return entries.get(`${groupId}:${request.requestId}`)?.handle?.agent }
  async function whenSettled(request) {
    const entry = entries.get(keyOf(request))
    if (!entry) return
    await entry.ready
    await entry.settlement?.promise
  }
  function settle(entry) {
    entry?.settlement?.resolve()
    if (entry) entry.settlement = undefined
  }
  function identity(agent) { return bySession.get(String(agent?.session?.id)) }
  function assert(agent, groupId, requestId) {
    const entry = identity(agent)
    if (!entry?.active || entry.request.groupId !== groupId || !isCurrent(entry.request)
      || requestId !== undefined && entry.request.requestId !== requestId) throw new Error('coordination_tool_wrong_request')
    return entry
  }
  function finish(request, { cancel = false } = {}) {
    if (cancel) {
      const queue = queues.get(request.groupId)
      for (let index = (queue?.length ?? 0) - 1; index >= 0; index--) {
        if (keyOf(queue[index].request) === keyOf(request)) queue.splice(index, 1)[0].reject(new Error('coordination_request_inactive'))
      }
    }
    const entry = entries.get(keyOf(request))
    if (!entry) return
    if (!entry.active) { if (cancel) entry.ready.then(() => entry.handle.agent.cancel({ kind: 'user' })).catch(() => {}); return }
    entry.active = false
    // 当前工具结果必须先返回；pre-step gate 会阻止终态后的额外模型调用。
    const disposal = entry.ready.then(async () => {
      if (cancel) entry.handle.agent.cancel({ kind: 'user' })
      await entry.handle.agent.whenIdle()
      await entry.handle.dispose()
    }).catch(error => { if (error.message !== 'coordination_request_inactive') onError(error) }).finally(() => { settle(entry); entry.release?.(); bySession.delete(entry.sessionId); if (entries.get(keyOf(request)) === entry) entries.delete(keyOf(request)); pending.delete(disposal) })
    pending.add(disposal)
    entry.disposal = disposal
  }
  function dispatch(request, message) {
    const queuedAt = Date.now()
    let resolve, reject
    const delivered = new Promise((yes, no) => { resolve = yes; reject = no })
    const groupId = request.groupId
    const queue = queues.get(groupId) ?? []
    queues.set(groupId, queue)
    const job = { request, message, resolve, reject, queuedAt }
    if (coordinationRole(request) === 'route') {
      const index = queue.findIndex(item => coordinationRole(item.request) !== 'route')
      queue.splice(index < 0 ? queue.length : index, 0, job)
      // 入站撤销/变更在当前 step 落稳后优先；不取消正在持久化的提交工具结果。
      const running = active.get(groupId)
      if (running && running.role !== 'route' && !running.fairnessTurn) running.yieldRequested = true
    } else queue.push(job)
    if (!tails.has(groupId)) {
      const run = Promise.resolve().then(async () => {
        while (queue.length) {
          const nonRouteIndex = queue.findIndex(item => coordinationRole(item.request) !== 'route')
          const fairnessTurn = (routeBursts.get(groupId) ?? 0) >= 2 && nonRouteIndex >= 0
          const { request, message, resolve, reject, queuedAt } = queue.splice(fairnessTurn ? nonRouteIndex : 0, 1)[0]
          let entry
          try {
            if (closed || !isCurrent(request)) throw new Error('coordination_request_inactive')
            entry = await obtain(request)
            if (closed || !entry.active || !isCurrent(request)) throw new Error('coordination_request_inactive')
            if (!fairnessTurn && entry.role !== 'route' && queue.some(item => coordinationRole(item.request) === 'route')) {
              const index = queue.findIndex(item => coordinationRole(item.request) !== 'route')
              queue.splice(index < 0 ? queue.length : index, 0, { request, message, resolve, reject, queuedAt })
              continue
            }
            entry.yieldRequested = false
            entry.settlement ??= Promise.withResolvers()
            entry.sliceSteps = 0
            entry.sliceYielded = false
            entry.hasContenders = () => queue.some(item => keyOf(item.request) !== keyOf(request) && isCurrent(item.request))
            entry.fairnessTurn = fairnessTurn
            const priorRouteBurst = routeBursts.get(groupId) ?? 0
            routeBursts.set(groupId, entry.role === 'route' ? Math.min(2, priorRouteBurst + 1) : 0)
            let release
            const released = new Promise(done => { release = done })
            entry.release = release
            active.set(groupId, entry)
            const agent = entry.handle.agent
            const exists = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(item => item.id === message.id)
              || agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.id === message.id)
            if (!exists) {
              agent.session.append('dingtalk/coordination-dispatched', { requestId: request.requestId, queuedAt, dispatchedAt: Date.now(), role: entry.role, fairnessTurn, priorRouteBurst, queueDepth: queue.length })
              agent.steer(message)
            }
            resolve(agent)
            await Promise.race([agent.whenIdle(), released])
            if (entry.release === release) entry.release = undefined
            if (entry.sliceYielded && !entry.request.routingPaused && !closed && entry.active && isCurrent(request)
              && !queue.some(item => keyOf(item.request) === keyOf(request))) {
              // 续行仍排队获同群槽；steer 仅在下次获槽后调用，不并发唤醒旧会话。
              queue.push({ request, message: createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '继续当前协调请求，读取已有工具结果并按当前请求约束提交。' }] }), resolve() {}, reject() {}, queuedAt: Date.now() })
            }
            if (!queue.some(item => keyOf(item.request) === keyOf(request))) settle(entry)
          } catch (error) { settle(entry ?? entries.get(keyOf(request))); reject(error); if (error.message !== 'coordination_request_inactive') onError(error) }
          finally { if (active.get(groupId) === entry) active.delete(groupId) }
        }
        tails.delete(groupId); queues.delete(groupId)
      })
      tails.set(groupId, run)
    }
    return delivered
  }
  return { get, identity, assert, dispatch, finish, whenSettled,
    async close() {
      closed = true
      for (const entry of entries.values()) finish(entry.request, { cancel: true })
      await Promise.allSettled([...tails.values(), ...pending])
      routeBursts.clear()
    },
  }
}
