import { createTaskReportStepGate } from './task-report-step-gate.js'

// 许可反映仍在执行或排空中的实际载体，不能用业务 state=running 代替。
export function createTaskPermits({ limit }) {
  const holders = new Map(), queue = [], draining = new Set()
  let generation = 0
  return {
    enqueue(taskId) { if (!holders.has(taskId) && !queue.includes(taskId)) queue.push(taskId) },
    request(taskId) {
      if (holders.has(taskId)) return draining.has(taskId) ? undefined : holders.get(taskId)
      if (!queue.includes(taskId)) queue.push(taskId)
      if (queue[0] !== taskId || holders.size >= limit()) return undefined
      queue.shift()
      const token = { taskId, generation: ++generation }
      holders.set(taskId, token)
      return token
    },
    has: taskId => holders.has(taskId) && !draining.has(taskId),
    token: taskId => holders.get(taskId),
    suspend(taskId) { if (holders.has(taskId)) draining.add(taskId); this.dequeue(taskId); return holders.get(taskId) },
    dequeue(taskId) { const index = queue.indexOf(taskId); if (index >= 0) queue.splice(index, 1) },
    release(token) {
      if (!token || holders.get(token.taskId) !== token) return false
      holders.delete(token.taskId); draining.delete(token.taskId); return true
    },
    snapshot: () => ({ holders: [...holders.keys()], draining: [...draining], queue: [...queue] }),
  }
}

// 即使是协调结果消息也不能绕过许可；拒绝时沿用原生 Inbox 回填防空转。
export const createTaskPermitStepGate = hasPermit => createTaskReportStepGate({ isBlocked: agent => !hasPermit(agent), isResolutionMessage: () => false })
