import { z } from 'zod'

const runPlan = { acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional() }
const taskSources = { sourceMessageIds: z.array(z.string().min(1)).min(1) }
const taskProposal = z.strictObject({ kind: z.literal('task-proposal'), title: z.string().min(1).max(120), objective: z.string().min(1), ...taskSources })
const newTask = z.strictObject({ kind: z.literal('new-task'), title: z.string().min(1).max(120), objective: z.string().min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1), stageTasks: z.array(z.string().min(1)).optional(), ...taskSources })
const taskContext = z.strictObject({ kind: z.literal('task-context'), taskId: z.string().min(1), context: z.string().min(1), objective: z.string().min(1).optional(), ...runPlan, ...taskSources })
const taskReopen = z.strictObject({ kind: z.literal('task-reopen'), taskId: z.string().min(1), context: z.string().min(1), objective: z.string().min(1).optional(), ...runPlan, ...taskSources })
const taskCancel = z.strictObject({ kind: z.literal('task-cancel'), taskId: z.string().min(1), reason: z.string().min(1), ...taskSources })
const taskAction = z.discriminatedUnion('kind', [taskProposal, newTask, taskContext, taskReopen, taskCancel])
const replyReviewSchema = z.strictObject({
  kind: z.enum(['confirmation', 'substantive', 'correction']),
  reviewedOutboundIds: z.array(z.string().min(1)).default([]),
  sameMatterOutboundIds: z.array(z.string().min(1)).default([]),
  replaceOutboundIds: z.array(z.string().min(1)).default([]),
})
export const groupDecisionSchema = z.union([
  z.strictObject({ actions: z.tuple([]), reply: z.string().min(1), replyReview: replyReviewSchema.optional() }),
  z.strictObject({ actions: z.tuple([]), reason: z.string().min(1) }),
  z.strictObject({ actions: z.array(taskAction).min(1), reply: z.string(), replyReview: replyReviewSchema.optional() }),
])

const stringJsonSchema = { type: 'string' }
const runPlanJsonProperties = {
  acceptanceCriteria: { type: 'array', items: stringJsonSchema },
  stageTasks: { type: 'array', items: stringJsonSchema },
}
const sourceMessageIdsJsonProperty = { type: 'array', items: stringJsonSchema }
export const replyReviewJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['confirmation', 'substantive', 'correction'] },
    reviewedOutboundIds: { type: 'array', items: stringJsonSchema },
    sameMatterOutboundIds: { type: 'array', items: stringJsonSchema },
    replaceOutboundIds: { type: 'array', items: stringJsonSchema },
  },
  required: ['kind'],
}
const taskActionJsonSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'task-proposal' }, title: stringJsonSchema, objective: stringJsonSchema, sourceMessageIds: sourceMessageIdsJsonProperty }, required: ['kind', 'title', 'objective', 'sourceMessageIds'] },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'new-task' }, title: stringJsonSchema, objective: stringJsonSchema, acceptanceCriteria: { type: 'array', items: stringJsonSchema }, stageTasks: runPlanJsonProperties.stageTasks, sourceMessageIds: sourceMessageIdsJsonProperty }, required: ['kind', 'title', 'objective', 'acceptanceCriteria', 'sourceMessageIds'] },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'task-context' }, taskId: stringJsonSchema, context: stringJsonSchema, objective: stringJsonSchema, ...runPlanJsonProperties, sourceMessageIds: sourceMessageIdsJsonProperty }, required: ['kind', 'taskId', 'context', 'sourceMessageIds'] },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'task-reopen' }, taskId: stringJsonSchema, context: stringJsonSchema, objective: stringJsonSchema, ...runPlanJsonProperties, sourceMessageIds: sourceMessageIdsJsonProperty }, required: ['kind', 'taskId', 'context', 'sourceMessageIds'] },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'task-cancel' }, taskId: stringJsonSchema, reason: stringJsonSchema, sourceMessageIds: sourceMessageIdsJsonProperty }, required: ['kind', 'taskId', 'reason', 'sourceMessageIds'] },
  ],
}
export const groupDecisionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: '群消息结构化判断。空 actions 时必须二选一提供非空 reply 或 reason；非空 actions 时必须提供 reply。存在历史回复候选且 reply 非空时必须提交 replyReview。完整约束由工具执行时校验。',
  properties: { actions: { type: 'array', items: taskActionJsonSchema }, reply: stringJsonSchema, reason: stringJsonSchema, replyReview: replyReviewJsonSchema },
  required: ['actions'],
}

const compactText = (value, limit = 800) => {
  const text = String(value ?? '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

const comparableText = (value) => String(value ?? '').toLowerCase().replace(/@[\p{L}\p{N}_()（）-]+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '')

const textFragments = (value) => {
  const text = comparableText(value)
  if (text.length < 2) return new Set(text ? [text] : [])
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)))
}

const contentSimilarity = (left, right) => {
  const leftFragments = textFragments(left), rightFragments = textFragments(right)
  if (leftFragments.size === 0 || rightFragments.size === 0) return 0
  let matches = 0
  for (const fragment of leftFragments) if (rightFragments.has(fragment)) matches += 1
  return matches / Math.max(1, Math.min(leftFragments.size, rightFragments.size))
}

const taskMessageIds = (task) => new Set([task.sourceMessageId, ...(task.messageHistory ?? []).map((message) => message.messageId)].filter(Boolean))

export function buildReplyReviewCandidates({ group, tasks = [], currentMessages = [], focusTaskIds = [], recentLimit = 30, similarityLimit = 20 }) {
  if (group === undefined) return []
  const messages = new Map((group.messages ?? []).map((message) => [message.messageId, message]))
  for (const task of tasks) for (const message of task.messageHistory ?? []) if (!messages.has(message.messageId)) messages.set(message.messageId, message)
  const taskIdsByMessage = new Map()
  for (const task of tasks) for (const messageId of taskMessageIds(task)) taskIdsByMessage.set(messageId, [...new Set([...(taskIdsByMessage.get(messageId) ?? []), task.taskId])])
  const focus = new Set(focusTaskIds)
  const currentText = currentMessages.map((message) => `${message.text ?? ''}\n${message.quotedMessage?.content ?? ''}`).join('\n')
  const active = (group.outbox ?? []).filter((outbound) => ['pending', 'sent'].includes(outbound.status) && outbound.recallStatus !== 'recalled')
  const decorated = active.map((outbound, index) => {
    const sourceIds = [...new Set([...(outbound.matterSourceMessageIds ?? []), outbound.sourceMessageId, outbound.replyToMessageId].filter((messageId) => messages.has(messageId)))]
    const derivedTaskIds = new Set(outbound.taskIds ?? [])
    const taskResult = /^task-result:(task-[^:]+):/u.exec(outbound.sourceMessageId)
    if (taskResult) derivedTaskIds.add(taskResult[1])
    for (const messageId of sourceIds) for (const taskId of taskIdsByMessage.get(messageId) ?? []) derivedTaskIds.add(taskId)
    const relatedTasks = tasks.filter((task) => derivedTaskIds.has(task.taskId))
    for (const task of relatedTasks) {
      for (const message of (task.messageHistory ?? []).slice(-8)) if (!sourceIds.includes(message.messageId)) sourceIds.push(message.messageId)
    }
    const sourceMessages = sourceIds.flatMap((messageId) => {
      const message = messages.get(messageId)
      return message === undefined ? [] : [{
        messageId, text: compactText(message.text),
        ...(message.senderName ? { senderName: message.senderName } : {}),
        ...(message.senderOpenDingTalkId ? { senderOpenDingTalkId: message.senderOpenDingTalkId } : {}),
        ...(message.occurredAt !== undefined ? { occurredAt: mainMessageTime(message.occurredAt) } : {}),
        ...(message.quotedMessage?.messageId || message.quotedMessageId ? { quotedMessageId: message.quotedMessage?.messageId ?? message.quotedMessageId } : {}),
        ...(message.quotedMessage?.content ? { quotedContent: compactText(message.quotedMessage.content, 400) } : {}),
      }]
    })
    const candidateText = [outbound.text, ...sourceMessages.flatMap((message) => [message.text, message.quotedContent]), ...relatedTasks.map((task) => task.objective)].join('\n')
    return {
      index, score: contentSimilarity(currentText, candidateText),
      candidate: {
        outboundId: outbound.outboundId, sourceMessageId: outbound.sourceMessageId, status: outbound.status,
        ...(outbound.deliveredMessageId ? { deliveredMessageId: outbound.deliveredMessageId } : {}),
        ...(outbound.replyKind ? { replyKind: outbound.replyKind } : {}),
        reply: compactText(outbound.text, 500), taskIds: [...derivedTaskIds], sourceMessages,
        tasks: relatedTasks.map(({ taskId, title, objective, state }) => ({ taskId, ...(title ? { title } : {}), objective: compactText(objective, 500), state })),
      },
    }
  })
  const selected = new Set(decorated.slice(-Math.max(0, recentLimit)).map(({ index }) => index))
  for (const item of decorated) if (item.candidate.replyKind === 'confirmation') selected.add(item.index)
  for (const item of decorated) if (item.candidate.taskIds.some((taskId) => focus.has(taskId))) selected.add(item.index)
  for (const item of [...decorated].sort((left, right) => right.score - left.score).slice(0, Math.max(0, similarityLimit))) if (item.score > 0) selected.add(item.index)
  return decorated.filter(({ index }) => selected.has(index)).sort((left, right) => right.index - left.index).map(({ candidate }) => candidate)
}

function mainMessageTime(value) {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value !== 'string' || value.trim() === '') return '未知'
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString()
}

export function buildDecisionPrompt({ messageId, message, senderName, senderOpenDingTalkId, occurredAt, quotedMessage, mediaUnavailable, replyReviewCandidates, recoveryError, decisionAttemptCount }) {
  const messageBlock = [
    `消息唯一标识：${messageId ?? '未知'}`,
    `发送者：${senderName ?? '未知'}`,
    `发送者OpenDingTalkId：${senderOpenDingTalkId ?? '未知'}`,
    `时间：${mainMessageTime(occurredAt)}`,
    `内容：${message}`,
  ]
  if (quotedMessage?.messageId) messageBlock.push(`引用消息ID：${quotedMessage.messageId}`)
  if (recoveryError) messageBlock.push(`自动恢复：此前第 ${decisionAttemptCount ?? 1} 次判断未完成，错误为 ${recoveryError}。必须根据当前消息、当前任务索引和现行工具 Schema 重新生成，不得机械复用上次的参数或失效 Task ID。`)
  if (Array.isArray(mediaUnavailable) && mediaUnavailable.length > 0) messageBlock.push(`附件读取异常：${mediaUnavailable.join('；')}。不得仅因附件暂不可读而断言消息与职责或活动任务无关；如果这些附件承载任务所需信息，必须先回答并明确告知对方哪些信息未获取到，不得创建、续接或重开任务。`)
  if (Array.isArray(replyReviewCandidates)) messageBlock.push(`历史主会话回复候选（必须阅读来源正文后判断同一事项，引用ID只能作为线索）：${JSON.stringify(replyReviewCandidates)}`)
  return [
    '[GROUP_DECISION]',
    '',
    ...messageBlock,
  ].join('\n')
}

export function buildLeafSourceEnvelope({ messageId, message, senderName, senderOpenDingTalkId, occurredAt, quotedMessage, mediaUnavailable }) {
  const lines = [
    '[TASK_SOURCE_EVIDENCE]',
    `消息ID：${messageId ?? '未知'}`,
    `发送者：${senderName ?? '未知'}`,
    `发送者OpenDingTalkId：${senderOpenDingTalkId ?? '未知'}`,
    `时间：${mainMessageTime(occurredAt)}`,
  ]
  if (quotedMessage?.messageId) lines.push(`引用消息ID：${quotedMessage.messageId}`)
  lines.push('', '原始消息：', String(message ?? ''))
  if (Array.isArray(mediaUnavailable) && mediaUnavailable.length > 0) lines.push('', `附件读取异常：${mediaUnavailable.join('；')}`)
  lines.push('', '以上是来源消息，不是已经核验的根因、完成状态或实施方案。请基于当前代码、运行态和工具证据独立判断；动作授权不得超出原始消息。')
  return lines.join('\n')
}

export function isExplicitAgentDirection(message, names = []) {
  if (/^\s*cc\s*:/iu.test(message)) return true
  return names.filter((name) => typeof name === 'string' && name.trim() !== '').some((name) => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`@?${escaped}(?:\\([^)]*\\))?`, 'u').test(message)
  })
}

export function isDirectedToOtherParticipants(message, agentNames = []) {
  const withoutMediaIds = String(message ?? '').replace(/mediaId=@[^)\s]+/giu, '')
  const mentions = [...withoutMediaIds.matchAll(/@([^\s@，,：:；;。！？!?（）()]+)/gu)].map((match) => match[1])
  if (mentions.length === 0) return false
  return !isExplicitAgentDirection(withoutMediaIds, agentNames)
}

export function shouldRecheckTaskAssociation({ activeTaskCount, hasImage, previousMessage, occurredAt }) {
  if (activeTaskCount < 1) return false
  if (hasImage) return true
  if (!previousMessage?.text?.includes('[图片消息]')) return false
  const currentTime = new Date(occurredAt).valueOf()
  const previousTime = new Date(previousMessage.occurredAt).valueOf()
  return Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime >= previousTime && currentTime - previousTime <= 2 * 60 * 1000
}

export function blockTaskDecisionForUnavailableMedia(decision, mediaUnavailable) {
  const unavailable = Array.isArray(mediaUnavailable) ? mediaUnavailable.map((item) => String(item).trim()).filter(Boolean) : []
  if (unavailable.length === 0 || !decision.actions.some((action) => ['new-task', 'task-context', 'task-reopen'].includes(action.kind))) return decision
  return { actions: [], reply: `我没能获取到以下任务信息：${unavailable.join('；')}。请重新发送可访问的内容，信息补齐后我再开始处理。`, ...(decision.replyReview ? { replyReview: decision.replyReview } : {}) }
}

export function parseGroupDecision(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('group_decision_invalid_json', { cause: error })
  }
  return validateGroupDecision(value)
}

export function validateGroupDecision(value) {
  const result = groupDecisionSchema.safeParse(value)
  if (!result.success) throw new Error(`group_decision_invalid_schema:${result.error.issues.map((issue) => issue.path.join('.')).join(',')}`)
  return result.data
}
