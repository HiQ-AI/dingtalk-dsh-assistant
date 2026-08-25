import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class FakeResidentAdapter extends LlmAdapter {
  async * stream(options) {
    const lastUser = options.messages.findLast((message) => message.role === 'user' && message.source.kind === 'user')
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
    if (input.startsWith('[GROUP_DECISION]')) {
      const message = input.match(/^Message: (.*)$/m)?.[1] ?? ''
      const activeTasks = JSON.parse(input.match(/^Active tasks: (.*)$/m)?.[1] ?? '[]')
      let decision
      if (message.startsWith('忽略：')) decision = { kind: 'ignore', reason: message.slice(3) || 'not addressed' }
      else if (message.startsWith('任务：')) decision = { kind: 'new-task', objective: message.slice(3), reply: '已识别为正式任务。' }
      else if (message.startsWith('补充：')) {
        const task = activeTasks[0]
        decision = task === undefined ? { kind: 'answer', reply: '没有可补充的进行中任务。' } : { kind: 'task-context', taskId: task.taskId, context: message.slice(3), reply: '已补充到现有任务。' }
      } else decision = { kind: 'answer', reply: `fake-answer:${message}` }
      const text = JSON.stringify(decision)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
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
