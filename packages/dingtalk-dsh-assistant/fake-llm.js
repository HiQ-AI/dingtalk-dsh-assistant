import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const jsonLine = (input, label) => {
  const line = input.split(/\r?\n/u).find((value) => value.startsWith(`${label}：`))
  return line === undefined ? undefined : JSON.parse(line.slice(label.length + 1))
}
const toolResults = (messages) => messages.flatMap((message) => message.content.filter((block) => block.type === 'tool-result')).flatMap((block) => {
  if (block.isError) return []
  const text = block.content.filter((item) => item.type === 'text').map((item) => item.text).join('')
  try { return [{ ...JSON.parse(text), toolCallId: block.toolCallId }] } catch { return [] }
})
const toolCalls = (messages) => messages.flatMap((message) => message.content.filter((block) => block.type === 'tool-call'))

function* call(name, args) {
  const id = `fake-${name}-${Date.now()}`
  const serialized = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function makeDecision(request, tasks) {
  const basisMessageIds = request.messages.map((message) => message.messageId)
  const text = request.messages.map((message) => message.text ?? message.message ?? '').join('\n')
  const message = request.messages.at(-1)?.text ?? request.messages.at(-1)?.message ?? ''
  const topicRefs = [{ topicId: request.topicId, revision: request.revision }]
  let decision
  if (!request.messages.length) decision = { actions: [], reason: '消息已移入其他 Topic，当前话题无需执行' }
  else if (message.startsWith('忽略：')) decision = { actions: [], reason: message.slice(3) || 'not addressed' }
  else if (message.startsWith('任务：')) decision = { actions: [{ kind: 'new-task', title: message.slice(3), objective: message.slice(3), acceptanceCriteria: ['任务目标已完成并有可核验证据'], topicRefs }], reply: '已识别为正式任务。' }
  else if (message.startsWith('补充：')) {
    const task = tasks.find((item) => item.topicRefs?.some((ref) => ref.topicId === request.topicId))
    decision = task === undefined ? { actions: [], reply: '没有可补充的任务。' } : { actions: [{ kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: message.slice(3), topicRefs }], reply: '已补充到现有任务。' }
  }
  else decision = { actions: [], reply: `fake-answer:${text}` }
  return { ...decision, ...(decision.reply ? { replyReview: { kind: decision.actions.length ? 'confirmation' : 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } : {}), basisMessageIds: basisMessageIds.length ? basisMessageIds : request.removedMessageIds }
}

class FakeResidentAdapter extends LlmAdapter {
  async * stream(options) {
    const lastUser = options.messages.findLast((message) => message.role === 'user' && (message.source.kind === 'user' || message.source.kind === 'coordinator'))
    const input = lastUser?.content.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? ''
    const afterInput = options.messages.slice(options.messages.lastIndexOf(lastUser) + 1)
    const results = toolResults(afterInput)
    const calls = toolCalls(afterInput)
    const reviewFor = (requestId) => {
      const query = calls.findLast((item) => item.name === 'group_reply_review_get' && JSON.parse(item.arguments).requestIds?.includes(requestId))
      return query ? results.findLast((item) => item.toolCallId === query.id && Array.isArray(item.candidates)) : undefined
    }
    const hasToolResultAfterInput = afterInput.some((message) => message.content.some((block) => block.type === 'tool-result'))
    const activeTasksText = options.system?.match(/## 本群全部任务关联索引\n\n([^\n]+)/u)?.[1]
    const tasks = activeTasksText?.startsWith('[') ? JSON.parse(activeTasksText) : []
    if (input.startsWith('[TASK_TOPIC_CONTEXT]')) {
      const ref = jsonLine(input, 'Task 输入')
      const stages = jsonLine(input, '本轮阶段任务')
      if (!ref || !Array.isArray(stages) || !stages.length) throw new Error('fake_task_input_missing')
      const acknowledgements = afterInput.flatMap((message) => message.content.filter((block) => block.type === 'tool-result'))
      if (acknowledgements.some((block) => block.isError)) throw new Error('fake_task_tool_rejected')
      const accepted = calls.filter((item) => acknowledgements.some((block) => block.toolCallId === item.id))
      const checkpoints = accepted.filter((item) => item.name === 'submit_task_checkpoint')
      const version = { inputVersion: ref.inputVersion, runSequence: ref.runSequence }
      const task = tasks.find((item) => item.taskId === ref.taskId)
      // 默认单阶段也拆成两个协议检查点；stageTask 始终引用 Host 给定阶段。
      const items = stages.length >= 2 ? stages : [`读取：${stages[0]}`, `核验：${stages[0]}`]
      if (!checkpoints.length) {
        yield* call('submit_task_checkpoint', { ...version, kind: 'plan-confirmed', summary: 'fake 模型协议计划', completedItems: [], evidence: ['已读取本轮 Topic 输入'], remainingItems: items, nextStep: items[0], needsCoordinatorDecision: false,
          workflowAssessment: { promptRefs: task?.taskPromptRefs ?? [], reusedEvidence: [], inapplicableSteps: [], exceptions: [] } })
        return
      }
      const index = checkpoints.length - 1
      if (index < items.length) {
        yield* call('submit_task_checkpoint', { ...version, kind: 'stage-completed', stageTask: stages[Math.min(index, stages.length - 1)], summary: `fake 协议检查：${items[index]}`, completedItems: [items[index]], evidence: ['仅验证隔离 fake 模型工具协议'], remainingItems: items.slice(index + 1), nextStep: items[index + 1] ?? '提交结果', needsCoordinatorDecision: false })
        return
      }
      if (!accepted.some((item) => item.name === 'submit_task_result')) {
        yield* call('submit_task_result', { ...version, status: 'completed', workType: 'non-development', summary: '隔离 fake 模型协议检查完成', evidence: ['检查点已按顺序逐项提交并收到 Host 审阅回执'], artifacts: [] })
        return
      }
    }
    if (input.startsWith('Report the result to your parent before ending.') && !hasToolResultAfterInput) {
      yield* call('report', { output: `fake-leaf-report:${input.split('Task objective: ')[1] ?? input}` })
      return
    }
    if (input.startsWith('[GROUP_TOPIC_ROUTE]') || input.startsWith('[GROUP_TOPIC_DECISION]')) {
      const request = jsonLine(input, 'Topic 请求')
      if (!request?.requestId) throw new Error('fake_topic_request_missing')
      if (input.startsWith('[GROUP_TOPIC_ROUTE]') && !hasToolResultAfterInput) {
        const routes = request.messages.map((message) => {
          const text = message.text ?? message.message ?? ''
          const quotedId = message.quotedMessage?.messageId ?? message.quotedMessageId
          const relatedTask = text.startsWith('补充：') ? tasks[0] : undefined
          const topic = request.topics?.find((item) => item.entries?.some((entry) => entry.messageId === quotedId))
          const topicId = relatedTask?.topicRefs?.[0]?.topicId ?? topic?.topicId
          return { messageId: message.messageId, messageVersion: message.messageVersion, topics: topicId ? [{ topicId }] : [{ newTopicKey: `fake-${message.messageId}`, title: text.slice(0, 30) || '附件讨论' }] }
        })
        yield* call('group_topic_route_submit', { requestId: request.requestId, routes })
        return
      }
      const submitted = new Set(calls.filter((item) => item.name === 'group_decision_submit').map((item) => JSON.parse(item.arguments).requestId))
      const pending = input.startsWith('[GROUP_TOPIC_DECISION]') ? [request] : results.flatMap((result) => result.pendingDecisions ?? [])
      const next = pending.find((item) => !submitted.has(item.requestId))
      if (next) {
        const decision = makeDecision(next, tasks)
        const review = reviewFor(next.requestId)
        if (next.replyReviewCandidateCount > 0 && review === undefined) {
          yield* call('group_reply_review_get', { requestIds: [next.requestId] })
          return
        }
        if (review && decision.reply) decision.replyReview = { kind: decision.actions.length ? 'confirmation' : 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] }
        yield* call('group_decision_submit', { requestId: next.requestId, topicId: next.topicId, revision: next.revision, decision })
        return
      }
    }
    if (input.startsWith('[TASK_COMPLETION_REVIEW]') || input.startsWith('[TASK_CHECKPOINT_REVIEW]')) {
      const request = jsonLine(input, '审阅请求')
      if (!request?.requestId) throw new Error('fake_task_review_request_missing')
      const submitted = calls.findLast((item) => item.name === 'group_task_review_submit' && JSON.parse(item.arguments).requestId === request.requestId)
      if (submitted && results.some((item) => item.toolCallId === submitted.id)) return
      const readPromptIds = new Set(calls.filter((item) => item.name === 'group_task_prompt_get' && JSON.parse(item.arguments).requestId === request.requestId)
        .filter((item) => results.some((result) => result.toolCallId === item.id)).flatMap((item) => JSON.parse(item.arguments).ids))
      const missingPromptIds = (request.promptRefs ?? []).filter((ref) => !readPromptIds.has(ref.id)).map((ref) => ref.id)
      if (missingPromptIds.length) {
        yield* call('group_task_prompt_get', { requestId: request.requestId, ids: missingPromptIds })
        return
      }
      if (input.startsWith('[TASK_COMPLETION_REVIEW]')) {
        const context = jsonLine(input, '通知上下文')
        const review = reviewFor(request.requestId)
        if (context?.replyReviewCandidateCount > 0 && !review) {
          yield* call('group_reply_review_get', { requestIds: [request.requestId] })
          return
        }
        const replyTarget = context?.messages?.findLast((item) => typeof item.senderOpenDingTalkId === 'string')
        const recipients = [...new Set((context?.messages ?? []).map((item) => item.senderOpenDingTalkId).filter(Boolean))]
        yield* call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: 'fake 审阅通过', notification: {
          reply: `coordinated:${request.taskId}`, replyReview: { kind: 'substantive', reviewedOutboundIds: review?.candidates.map((item) => item.outboundId) ?? [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
          ...(replyTarget ? { replyToMessageId: replyTarget.messageId, atOpenDingTalkIds: recipients } : {}),
        } } })
      } else yield* call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: 'fake 检查点已审阅' } })
      return
    }
    if (input.startsWith('[TASK_COORDINATION]') && !calls.some((item) => item.name === 'group_reply_submit')) {
      const requestId = input.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
      const taskId = input.match(/^Task ID: ([^\r\n]+)$/mu)?.[1]
      if (requestId === undefined) throw new Error('fake_group_reply_request_id_missing')
      if (taskId === undefined) throw new Error('fake_group_reply_task_id_missing')
      const request = jsonLine(input, 'Topic 请求')
      const review = reviewFor(requestId)
      if (request?.replyReviewCandidateCount > 0 && !review) {
        yield* call('group_reply_review_get', { requestIds: [requestId] })
        return
      }
      const timeline = request?.messages ?? []
      const replyTarget = timeline.findLast((item) => typeof item.senderOpenDingTalkId === 'string')
      const recipients = [...new Set(timeline.map((item) => item.senderOpenDingTalkId).filter(Boolean))]
      yield* call('group_reply_submit', { requestId, reply: `coordinated:${taskId}`, replyReview: { kind: 'substantive', reviewedOutboundIds: review?.candidates.map((item) => item.outboundId) ?? [], sameMatterOutboundIds: [], replaceOutboundIds: [] }, ...(replyTarget ? { replyToMessageId: replyTarget.messageId, atOpenDingTalkIds: recipients } : {}) })
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
