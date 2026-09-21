// 请求会话只管理模型运行句柄；业务版本、授权与提交仍由 Topic coordinator 持有。
import { createHash, randomUUID } from 'node:crypto'
import { createTaskReportStepGate } from './task-report-step-gate.js'

export function createCoordinationStepGate(entry, isCurrent) {
  const yieldGate = createTaskReportStepGate({ isBlocked: () => entry.yieldRequested === true, isResolutionMessage: () => false })
  return (event, next) => entry.active && isCurrent(entry.request) ? yieldGate(event, next) : { kind: 'reject' }
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
  const entries = new Map(), bySession = new Map(), tails = new Map(), queues = new Map(), active = new Map(), pending = new Set()
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
  function identity(agent) { return bySession.get(String(agent?.session?.id)) }
  function assert(agent, groupId, requestId) {
    const entry = identity(agent)
    if (!entry?.active || entry.request.groupId !== groupId || !isCurrent(entry.request)
      || requestId !== undefined && entry.request.requestId !== requestId) throw new Error('coordination_tool_wrong_request')
    return entry
  }
  function finish(request, { cancel = false } = {}) {
    const entry = entries.get(keyOf(request))
    if (!entry) return
    if (!entry.active) { if (cancel) entry.ready.then(() => entry.handle.agent.cancel({ kind: 'user' })).catch(() => {}); return }
    entry.active = false
    // 当前工具结果必须先返回；pre-step gate 会阻止终态后的额外模型调用。
    const disposal = entry.ready.then(async () => {
      if (cancel) entry.handle.agent.cancel({ kind: 'user' })
      await entry.handle.agent.whenIdle()
      await entry.handle.dispose()
    }).catch(error => { if (error.message !== 'coordination_request_inactive') onError(error) }).finally(() => { entry.release?.(); bySession.delete(entry.sessionId); if (entries.get(keyOf(request)) === entry) entries.delete(keyOf(request)); pending.delete(disposal) })
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
      if (running && running.role !== 'route') running.yieldRequested = true
    } else queue.push(job)
    if (!tails.has(groupId)) {
      const run = Promise.resolve().then(async () => {
        while (queue.length) {
          const { request, message, resolve, reject, queuedAt } = queue.shift()
          let entry
          try {
            if (closed || !isCurrent(request)) throw new Error('coordination_request_inactive')
            entry = await obtain(request)
            if (entry.role !== 'route' && queue.some(item => coordinationRole(item.request) === 'route')) {
              const index = queue.findIndex(item => coordinationRole(item.request) !== 'route')
              queue.splice(index < 0 ? queue.length : index, 0, { request, message, resolve, reject, queuedAt })
              continue
            }
            entry.yieldRequested = false
            let release
            const released = new Promise(done => { release = done })
            entry.release = release
            active.set(groupId, entry)
            const agent = entry.handle.agent
            const exists = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(item => item.id === message.id)
              || agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.id === message.id)
            if (!exists) {
              agent.session.append('dingtalk/coordination-dispatched', { requestId: request.requestId, queuedAt, dispatchedAt: Date.now() })
              agent.steer(message)
            }
            resolve(agent)
            await Promise.race([agent.whenIdle(), released])
            if (entry.release === release) entry.release = undefined
          } catch (error) { reject(error); if (error.message !== 'coordination_request_inactive') onError(error) }
          finally { if (active.get(groupId) === entry) active.delete(groupId) }
        }
        tails.delete(groupId); queues.delete(groupId)
      })
      tails.set(groupId, run)
    }
    return delivered
  }
  return { get, identity, assert, dispatch, finish,
    async close() {
      closed = true
      for (const entry of entries.values()) finish(entry.request, { cancel: true })
      await Promise.allSettled([...tails.values(), ...pending])
    },
  }
}
