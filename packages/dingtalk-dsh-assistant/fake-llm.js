import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

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
  const id = `fake-${name}-${randomUUID()}`
  const serialized = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function makeDecision(request, tasks) {
  const basisMessageIds = request.messages.map((message) => message.messageId)
  const basisUnitRefs = request.messages.filter(({ unitId, unitRevision }) => unitId && unitRevision).map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
  const text = request.messages.map((message) => message.text ?? message.message ?? '').join('\n')
  const message = request.messages.at(-1)?.text ?? request.messages.at(-1)?.message ?? ''
  const topicRefs = [{ topicId: request.topicId, revision: request.revision }]
  let decision
  if (!request.messages.length) decision = { actions: [], reason: '消息已移入其他 Topic，当前话题无需执行' }
  else if (message.startsWith('忽略：')) decision = { actions: [], reason: message.slice(3) || 'not addressed' }
  else if (message.startsWith('任务：')) decision = { actions: [{ kind: 'new-task', title: message.slice(3), objective: message.slice(3), acceptanceCriteria: ['任务目标已完成并有可核验证据'], topicRefs, basisUnitRefs }], reply: '已识别为正式任务。' }
  else if (message.startsWith('补充：')) {
    const task = tasks.find((item) => item.topicRefs?.some((ref) => ref.topicId === request.topicId))
    decision = task === undefined ? { actions: [], reply: '没有可补充的任务。' } : { actions: [{ kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: message.slice(3), topicRefs, basisUnitRefs }], reply: '已补充到现有任务。' }
  }
  else decision = { actions: [], reply: `fake-answer:${text}` }
  const unitBasis = basisUnitRefs.length ? basisUnitRefs : request.removedUnitRefs?.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })).filter(({ unitId, unitRevision }) => unitId && unitRevision)
  return { ...decision, ...(decision.reply ? { replyReview: { kind: decision.actions.length ? 'confirmation' : 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } : {}), basisMessageIds, ...(unitBasis?.length ? { basisUnitRefs: unitBasis } : {}) }
}

class FakeResidentAdapter extends LlmAdapter {
  async * stream(options) {
    let lastUser = options.messages.findLast((message) => message.role === 'user' && (message.source.kind === 'user' || message.source.kind === 'coordinator'))
    if (lastUser?.content.some(block => block.type === 'text' && block.text.startsWith('[TASK_REPORT_REVIEWED]'))) {
      lastUser = options.messages.findLast(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.startsWith('[TASK_TOPIC_CONTEXT]')))
    }
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
      const systemSection = title => options.system?.split(`### ${title}\n\n`)[1]?.split('\n\n')[0]
      const binding = JSON.parse(systemSection('当前结构化计划与来源') ?? '{}')
      const stages = systemSection('当前执行轮次阶段任务')?.split('\n').map(line => line.replace(/^- /u, '').replace(/（stageId: .*）$/u, ''))
      const criteria = systemSection('当前执行轮次验收标准')?.split('\n').map(line => line.replace(/^- /u, ''))
      if (!ref || !stages?.length || !criteria?.length || !binding.sourceRefs?.length) throw new Error('fake_task_input_missing')
      const acknowledgements = afterInput.flatMap((message) => message.content.filter((block) => block.type === 'tool-result'))
      if (acknowledgements.some((block) => block.isError)) throw new Error('fake_task_tool_rejected')
      const version = { inputVersion: ref.inputVersion, runSequence: ref.runSequence }
      const resultFor = name => {
        const sent = calls.findLast(item => item.name === name), result = sent && results.findLast(item => item.toolCallId === sent.id)
        if (!result) return undefined
        const { toolCallId, ...body } = result
        return body
      }
      const resolutions = afterInput.flatMap(message => message.content.filter(block => block.type === 'text' && block.text.startsWith('[TASK_REPORT_REVIEWED]')).map(block => JSON.parse(block.text.split('\n')[1])))
      const approved = []
      for (const submitted of calls.filter(item => ['submit_task_checkpoint', 'submit_task_result'].includes(item.name))) {
        const receipt = results.findLast(item => item.toolCallId === submitted.id)
        const settled = resolutions.findLast(item => item.submissionId === receipt?.submissionId) ?? receipt
        if (['rejected', 'stale', 'failed'].includes(settled?.reviewStatus)) throw new Error('fake_task_report_not_approved')
        if (settled?.reviewStatus !== 'approved' || settled.applicationStatus !== 'applied') { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        approved.push(submitted)
      }
      const prepared = resultFor('task_plan_prepare')
      if (!prepared) {
        yield* call('task_plan_prepare', { ...version, draft: {
          criteria: criteria.map((description, index) => ({ key: `c${index}`, description, sourceRefs: binding.sourceRefs, verificationPolicy: 'semantic' })),
          stages: stages.map((title, index) => ({ key: `s${index}`, title, criterionKeys: criteria.map((_, i) => `c${i}`), dependsOnKeys: index ? [`s${index - 1}`] : [], expectedOutputs: ['隔离 fake 工具协议回执'] })),
        } })
        return
      }
      const plan = prepared.plan ?? prepared
      const checkpoints = approved.filter(item => item.name === 'submit_task_checkpoint')
      if (!checkpoints.length) {
        yield* call('submit_task_checkpoint', { ...version, kind: 'plan-confirmed', plan, summary: 'fake 模型协议计划', completedItems: [], evidence: ['已读取本轮 Topic 输入'], remainingItems: stages, nextStep: stages[0], needsCoordinatorDecision: false,
          workflowAssessment: { promptRefs: plan.workflowRefs, reusedEvidence: [], inapplicableSteps: [], exceptions: [] } })
        return
      }
      const artifact = resultFor('task_artifact_register')
      if (!artifact) { yield* call('task_artifact_register', { ...version, artifact: { uri: `fake://tool-protocol/${ref.taskId}`, version: `${ref.runSequence}:${ref.inputVersion}` } }); return }
      const index = checkpoints.length - 1
      if (index < plan.stages.length) {
        const stage = plan.stages[index], evidenceId = `fake-evidence-${stage.stageId}`
        yield* call('submit_task_checkpoint', { ...version, kind: 'stage-completed', stageTask: stage.title, summary: `fake 协议检查：${stage.title}`, completedItems: [stage.title], evidence: ['仅验证隔离 fake 模型工具协议'], remainingItems: stages.slice(index + 1), nextStep: stages[index + 1] ?? '提交结果', needsCoordinatorDecision: false,
          stageOutput: { ...version, stageId: stage.stageId, planRevision: plan.revision, artifactRefs: [artifact.artifactId], evidenceRefs: [evidenceId], blockers: [] },
          artifactRecords: [{ artifactId: artifact.artifactId, uri: artifact.uri, version: artifact.version }], modelEvidence: [{ evidenceId, producerKind: 'model', criterionIds: stage.criterionIds, artifactRefs: [artifact.artifactId], sourceRef: `fake-protocol:${stage.stageId}`, observedAt: new Date().toISOString(), outcome: 'pass', reason: '隔离fake协议夹具，不是实际业务验收' }],
        }); return
      }
      if (!approved.some(item => item.name === 'submit_task_result')) {
        yield* call('submit_task_result', { ...version, status: 'completed', planRevision: plan.revision, criterionReviews: plan.criteria.map(item => ({ criterionId: item.criterionId, evidenceRefs: plan.stages.filter(stage => stage.criterionIds.includes(item.criterionId)).map(stage => `fake-evidence-${stage.stageId}`), verdict: 'pass', reason: '隔离fake协议阶段已核准' })), workType: 'non-development', summary: '隔离 fake 模型协议检查完成', evidence: ['检查点已按顺序逐项提交并收到 Host 审阅回执'], artifacts: [artifact.uri] })
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
           return { messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [], units: [{ unitKey: 'whole-message', summary: text || '附件讨论', replacesUnitIds: [], sourceRefs: [{ quote: text || '[图片消息]' }], contextRefs: [], topics: topicId ? [{ topicId }] : [{ newTopicKey: `fake-${message.messageId}`, title: text.slice(0, 30) || '附件讨论' }] }] }
        })
        yield* call('group_topic_route_submit', { requestId: request.requestId, routes })
        return
      }
      const submitted = new Set(calls.filter((item) => item.name === 'group_decision_submit').map((item) => JSON.parse(item.arguments).requestId))
      const pending = input.startsWith('[GROUP_TOPIC_DECISION]') ? [request] : []
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
