// DSH pre-step 在此处已 claim 消息。直接回填 Inbox 不会 wakeDriver；禁止用 steer 回填。
// Goal.block 只阻止自动续轮，此门禁结束等待报告期间当前 turn 的后续模型步骤。
export function createTaskReportStepGate({ isBlocked, isResolutionMessage }) {
  return async ({ agent, messages }, next) => {
    if (!isBlocked(agent) || messages.some(message => isResolutionMessage(agent, message))) return next()
    const pending = new Set([...(agent.inbox.nextStep ?? []), ...(agent.inbox.nextTurn ?? [])].map(message => message.id))
    for (const message of messages.toReversed()) {
      if (message.source?.kind === 'goal' || pending.has(message.id)) continue
      agent.inbox.prepend('next-step', message)
      pending.add(message.id)
    }
    return { kind: 'reject' }
  }
}
