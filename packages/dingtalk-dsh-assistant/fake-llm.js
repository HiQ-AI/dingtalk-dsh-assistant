import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class FakeResidentAdapter extends LlmAdapter {
  async * stream(options) {
    const lastUser = options.messages.findLast((message) => message.role === 'user' && (message.source.kind === 'user' || message.source.kind === 'coordinator'))
    const input = lastUser?.content.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? ''
    const hasToolResultAfterInput = options.messages.slice(options.messages.lastIndexOf(lastUser) + 1)
      .some((message) => message.content.some((block) => block.type === 'tool-result'))
    if (input.startsWith('Report the result to your parent before ending.') && !hasToolResultAfterInput) {
      const id = `fake-report-${Date.now()}`
      const args = JSON.stringify({ output: `fake-leaf-report:${input.split('Task objective: ')[1] ?? input}` })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'report', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'report', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if ((input.startsWith('[GROUP_MESSAGE_STEER]') || input.startsWith('[GROUP_DECISION_RECHECK]')) && !hasToolResultAfterInput) {
      const requestId = input.match(/^判断请求 ID：([^\r\n]+)$/mu)?.[1]
      const message = input.match(/^内容：(.*)$/mu)?.[1] ?? ''
      const activeTasksText = options.system?.match(/## 本群全部任务关联索引\n\n([^\n]+)/u)?.[1]
      const activeTasks = activeTasksText?.startsWith('[') ? JSON.parse(activeTasksText) : []
      let decision
      if (message.startsWith('忽略：')) decision = { actions: [], reason: message.slice(3) || 'not addressed' }
      else if (message.startsWith('任务：')) decision = { actions: [{ kind: 'new-task', title: message.slice(3), objective: message.slice(3), acceptanceCriteria: ['任务目标已完成并有可核验证据'] }], reply: '已识别为正式任务。' }
      else if (message.startsWith('补充：')) {
        const task = activeTasks[0]
        decision = task === undefined ? { actions: [], reply: '没有可补充的任务。' } : { actions: [{ kind: 'task-context', taskId: task.taskId, context: message.slice(3) }], reply: '已补充到现有任务。' }
      }
      else decision = { actions: [], reply: `fake-answer:${message}` }
      if (requestId === undefined) throw new Error('fake_group_decision_request_id_missing')
      const id = `fake-decision-${Date.now()}`
      const args = JSON.stringify({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision }] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_decision_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_decision_submit', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (input.startsWith('[TASK_COORDINATION]') && !hasToolResultAfterInput) {
      const requestId = input.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
      const taskId = input.match(/^Task ID: ([^\r\n]+)$/mu)?.[1]
      if (requestId === undefined) throw new Error('fake_group_reply_request_id_missing')
      if (taskId === undefined) throw new Error('fake_group_reply_task_id_missing')
      const id = `fake-reply-${Date.now()}`
      const args = JSON.stringify({ requestId, observedRequestIds: [], reply: `coordinated:${taskId}` })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_reply_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_reply_submit', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `fake-main-reply:${input}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function installFakeLlm(ctx) {
  return ctx.llm.registerAdapter(['fake-resident'], new FakeResidentAdapter())
}
