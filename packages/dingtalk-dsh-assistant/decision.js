import { z } from 'zod'
import { toToolJsonSchema } from './tool-schema.js'
import { resolveTopicMessages, topicRefSchema } from './topic-model.js'

export const TOPIC_TITLE_MAX_CHARS = 30

const runPlan = { acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional() }
export { topicRefSchema }
const unitRefSchema = z.strictObject({ unitId: z.string().min(1), unitRevision: z.number().int().positive() })
const taskSources = { topicRefs: z.array(topicRefSchema).min(1), basisUnitRefs: z.array(unitRefSchema).min(1).optional() }
const impactEvidenceSchema = z.strictObject({ basisMessageIds: z.array(z.string().min(1)).min(1), reason: z.string().trim().min(1), affectedStageIds: z.array(z.string().min(1)).min(1) })
export const taskContextImpactFields = { progressImpact: z.enum(['preserve', 'replan']).optional(), impactEvidence: impactEvidenceSchema.optional() }
const taskVersion = { inputVersion: z.number().int().positive(), runSequence: z.number().int().positive() }
const topicUpdateSchema = z.strictObject({ summary: z.string().optional(), openQuestions: z.array(z.string().min(1)).optional(), status: z.enum(['active', 'waiting', 'closed']).optional() })
const decisionBasis = { topicUpdate: topicUpdateSchema.optional(), basisMessageIds: z.array(z.string().min(1)).min(1), basisUnitRefs: z.array(unitRefSchema).min(1).optional() }
const taskProposal = z.strictObject({ kind: z.literal('task-proposal'), title: z.string().min(1).max(120), objective: z.string().min(1), ...taskSources })
const newTask = z.strictObject({ kind: z.literal('new-task'), title: z.string().min(1).max(120), objective: z.string().min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1), stageTasks: z.array(z.string().min(1)).optional(), ...taskSources })
const taskContext = z.strictObject({ kind: z.literal('task-context'), taskId: z.string().min(1), ...taskVersion, context: z.string().min(1), title: z.string().min(1).max(120).optional(), objective: z.string().min(1).optional(), ...taskContextImpactFields, ...runPlan, ...taskSources })
const taskReopen = z.strictObject({ kind: z.literal('task-reopen'), taskId: z.string().min(1), ...taskVersion, context: z.string().min(1), title: z.string().min(1).max(120).optional(), objective: z.string().min(1).optional(), ...runPlan, ...taskSources })
const taskCancel = z.strictObject({ kind: z.literal('task-cancel'), taskId: z.string().min(1), ...taskVersion, reason: z.string().min(1), ...taskSources })
const taskAction = z.discriminatedUnion('kind', [taskProposal, newTask, taskContext, taskReopen, taskCancel])
const replyReviewSchema = z.strictObject({
  kind: z.enum(['confirmation', 'substantive', 'correction']),
  reviewedOutboundIds: z.array(z.string().min(1)).default([]),
  sameMatterOutboundIds: z.array(z.string().min(1)).default([]),
  replaceOutboundIds: z.array(z.string().min(1)).default([]),
})
export const groupDecisionSchema = z.union([
  z.strictObject({ ...decisionBasis, actions: z.tuple([]), reply: z.string().min(1), replyReview: replyReviewSchema.optional() }),
  z.strictObject({ ...decisionBasis, actions: z.tuple([]), reason: z.string().min(1) }),
  z.strictObject({ ...decisionBasis, actions: z.array(taskAction).min(1), reply: z.string(), replyReview: replyReviewSchema.optional() }),
])

const stringJsonSchema = { type: 'string' }
export const replyReviewJsonSchema = toToolJsonSchema(replyReviewSchema)
export const groupDecisionJsonSchema = toToolJsonSchema(groupDecisionSchema)

const topicRouteTargetSchema = z.union([
  z.strictObject({ topicId: z.string().min(1), relationship: z.enum(['continuation', 'affected']).optional(), reason: z.string().trim().min(1).optional() }),
  z.strictObject({ newTopicKey: z.string().min(1), title: z.string().trim().min(1).max(TOPIC_TITLE_MAX_CHARS), relationship: z.enum(['continuation', 'affected']).optional(), reason: z.string().trim().min(1).optional() }),
])
const topicRouteOwnerSchema = z.union([
  z.strictObject({ topicId: z.string().min(1) }),
  z.strictObject({ newTopicKey: z.string().min(1) }),
])
const unitSourceRefSchema = z.union([
  z.strictObject({ quote: z.string().min(1) }),
  z.strictObject({ imageRefId: z.string().min(1) }),
  z.strictObject({ wholeMessage: z.literal(true) }),
])
const sameRouteTarget = (left, right) => left?.topicId ? left.topicId === right.topicId : left?.newTopicKey === right.newTopicKey

export const topicRouteSubmissionSchema = z.strictObject({
  requestId: z.string().min(1),
  routes: z.array(z.strictObject({
    messageId: z.string().min(1), messageVersion: z.number().int().positive(),
    ignoredRefs: z.array(z.strictObject({ quote: z.string().min(1), reason: z.string().trim().min(1) })).default([]),
    units: z.array(z.strictObject({
      unitKey: z.string().min(1), summary: z.string().trim().min(1),
      replacesUnitIds: z.array(z.string().min(1)).default([]), effectInheritance: z.enum(['inherit', 'new-scope']).optional(), revisionReason: z.string().trim().min(1).optional(),
      sourceRefs: z.array(unitSourceRefSchema).min(1),
      contextRefs: z.array(z.strictObject({ quote: z.string().min(1), purpose: z.string().min(1) })).default([]),
      topics: z.array(topicRouteTargetSchema), effectOwner: topicRouteOwnerSchema.optional(),
      reason: z.string().trim().min(1).optional(),
    }).superRefine((unit, ctx) => {
      if (unit.topics.length === 0 && !unit.reason) ctx.addIssue({ code: 'custom', message: '无 Topic 归属的事项必须说明原因', path: ['reason'] })
      if (unit.replacesUnitIds.length && (!unit.effectInheritance || !unit.revisionReason)) ctx.addIssue({ code: 'custom', message: '事项拆分或合并必须声明效果继承方式和修订原因', path: ['replacesUnitIds'] })
      if (unit.topics.length > 1) {
        if (unit.topics.some((topic) => !topic.relationship || !topic.reason)) ctx.addIssue({ code: 'custom', message: '多 Topic 归属必须逐项声明关系和理由', path: ['topics'] })
        if (!unit.effectOwner) ctx.addIssue({ code: 'custom', message: '多 Topic 归属必须指定唯一动作主归属', path: ['effectOwner'] })
      }
      if (unit.effectOwner && !unit.topics.some((topic) => sameRouteTarget(unit.effectOwner, topic))) ctx.addIssue({ code: 'custom', message: '动作主归属必须属于当前 Topic 集合', path: ['effectOwner'] })
    })).min(1).optional(),
    topics: z.array(topicRouteTargetSchema).optional(), effectOwner: topicRouteOwnerSchema.optional(),
    reason: z.string().trim().min(1).optional(),
  }).superRefine((route, ctx) => {
    if (Boolean(route.units) === Boolean(route.topics)) ctx.addIssue({ code: 'custom', message: '必须且只能提交 units 或单事项旧 topics', path: ['units'] })
    if (route.topics && route.topics.length === 0 && !route.reason) ctx.addIssue({ code: 'custom', message: '无 Topic 归属必须说明原因', path: ['reason'] })
    if (route.topics?.length > 1) {
      if (route.topics.some((topic) => !topic.relationship || !topic.reason)) ctx.addIssue({ code: 'custom', message: '多 Topic 归属必须逐项声明关系和理由', path: ['topics'] })
      if (!route.effectOwner) ctx.addIssue({ code: 'custom', message: '多 Topic 归属必须指定唯一动作主归属', path: ['effectOwner'] })
    }
    if (route.effectOwner && !route.topics?.some((topic) => sameRouteTarget(route.effectOwner, topic))) ctx.addIssue({ code: 'custom', message: '动作主归属必须属于当前 Topic 集合', path: ['effectOwner'] })
  })).min(1),
})
export const topicRouteSubmissionJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    requestId: stringJsonSchema,
    routes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        messageId: stringJsonSchema, messageVersion: { type: 'integer' },
        ignoredRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { quote: stringJsonSchema, reason: stringJsonSchema }, required: ['quote', 'reason'] } },
        units: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          unitKey: stringJsonSchema, summary: stringJsonSchema,
          replacesUnitIds: { type: 'array', items: stringJsonSchema }, effectInheritance: { type: 'string', enum: ['inherit', 'new-scope'] }, revisionReason: stringJsonSchema,
          sourceRefs: { type: 'array', items: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { quote: stringJsonSchema }, required: ['quote'] },
            { type: 'object', additionalProperties: false, properties: { imageRefId: stringJsonSchema }, required: ['imageRefId'] },
            { type: 'object', additionalProperties: false, properties: { wholeMessage: { type: 'boolean', const: true } }, required: ['wholeMessage'] },
          ] } },
          contextRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { quote: stringJsonSchema, purpose: stringJsonSchema }, required: ['quote', 'purpose'] } },
          topics: { type: 'array', items: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { topicId: stringJsonSchema, relationship: { type: 'string', enum: ['continuation', 'affected'] }, reason: stringJsonSchema }, required: ['topicId'] },
            { type: 'object', additionalProperties: false, properties: { newTopicKey: stringJsonSchema, title: { ...stringJsonSchema, description: '建议 8–20 字且不超过 30 字的简洁话题名称，只概括共同讨论对象，不复述消息详情。' }, relationship: { type: 'string', enum: ['continuation', 'affected'] }, reason: stringJsonSchema }, required: ['newTopicKey', 'title'] },
          ] } }, effectOwner: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { topicId: stringJsonSchema }, required: ['topicId'] },
            { type: 'object', additionalProperties: false, properties: { newTopicKey: stringJsonSchema }, required: ['newTopicKey'] },
          ] }, reason: stringJsonSchema,
        }, required: ['unitKey', 'summary', 'replacesUnitIds', 'sourceRefs', 'topics'] } }, reason: stringJsonSchema,
      }, required: ['messageId', 'messageVersion', 'units', 'ignoredRefs'],
    } },
  }, required: ['requestId', 'routes'],
}
export const groupDecisionSubmissionSchema = z.strictObject({
  requestId: z.string().min(1), topicId: z.string().min(1), revision: z.number().int().positive(), decision: groupDecisionSchema,
})
export const groupDecisionSubmissionJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: { requestId: stringJsonSchema, topicId: stringJsonSchema, revision: { type: 'integer' }, decision: groupDecisionJsonSchema },
  required: ['requestId', 'topicId', 'revision', 'decision'],
}

const compactText = (value, limit = 800) => {
  const text = String(value ?? '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export const REPLY_REVIEW_CANDIDATE_LIMIT = 8
export const REPLY_REVIEW_MAX_CHARS = 16_000
const REPLY_REVIEW_CONFIRMATION_LIMIT = 6
const REPLY_REVIEW_SOURCE_MESSAGE_LIMIT = 4
const REPLY_REVIEW_TASK_LIMIT = 3
const uniqueValues = (values) => [...new Set(values.filter(Boolean))]

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

const taskMessages = (group, task) => (task.topicRefs ?? []).flatMap(({ topicId, revision }) => resolveTopicMessages(group, topicId, revision))
const taskMessageIds = (group, task) => new Set(taskMessages(group, task).map((message) => message.messageId))

export function buildReplyReviewCandidates({ group, tasks = [], currentMessages = [], focusTaskIds = [], recentLimit = 6, similarityLimit = 6, candidateLimit = REPLY_REVIEW_CANDIDATE_LIMIT, maxChars = REPLY_REVIEW_MAX_CHARS }) {
  if (group === undefined) return []
  const messages = new Map((group.messages ?? []).map((message) => [message.messageId, message]))
  const taskIdsByMessage = new Map()
  for (const task of tasks) for (const messageId of taskMessageIds(group, task)) taskIdsByMessage.set(messageId, [...new Set([...(taskIdsByMessage.get(messageId) ?? []), task.taskId])])
  const focus = new Set(focusTaskIds)
  const currentReferences = new Set(currentMessages.flatMap((message) => [message.messageId, message.quotedMessage?.messageId, message.quotedMessageId]).filter(Boolean))
  const contextualTaskIds = new Set(focusTaskIds)
  for (const messageId of currentReferences) for (const taskId of taskIdsByMessage.get(messageId) ?? []) contextualTaskIds.add(taskId)
  const currentText = currentMessages.map((message) => `${message.text ?? ''}\n${message.quotedMessage?.content ?? ''}`).join('\n')
  const active = (group.outbox ?? []).filter((outbound) => ['pending', 'sent'].includes(outbound.status) && outbound.recallStatus !== 'recalled')
  const decorated = active.map((outbound, index) => {
    const sourceIds = uniqueValues([...(outbound.matterSourceMessageIds ?? []), outbound.sourceMessageId, outbound.replyToMessageId]).filter((messageId) => messages.has(messageId))
    const derivedTaskIds = new Set(outbound.taskIds ?? [])
    const taskResult = /^task-result:(task-[^:]+):/u.exec(outbound.sourceMessageId)
    if (taskResult) derivedTaskIds.add(taskResult[1])
    for (const messageId of sourceIds) for (const taskId of taskIdsByMessage.get(messageId) ?? []) derivedTaskIds.add(taskId)
    const allRelatedTasks = tasks.filter((task) => derivedTaskIds.has(task.taskId))
    const sourceFacts = new Map(messages)
    for (const task of allRelatedTasks) {
      for (const message of taskMessages(group, task).slice(-8)) {
        sourceFacts.set(message.messageId, message)
        if (!sourceIds.includes(message.messageId)) sourceIds.push(message.messageId)
      }
    }
    for (const ref of outbound.topicRefs ?? []) {
      for (const message of resolveTopicMessages(group, ref.topicId, ref.revision)) {
        sourceFacts.set(message.messageId, message)
        if (!sourceIds.includes(message.messageId)) sourceIds.push(message.messageId)
      }
    }
    const projectedSourceIds = uniqueValues([
      ...sourceIds.filter((messageId) => currentReferences.has(messageId)),
      outbound.sourceMessageId,
      outbound.replyToMessageId,
      ...[...sourceIds].reverse(),
    ]).filter((messageId) => messages.has(messageId)).slice(0, REPLY_REVIEW_SOURCE_MESSAGE_LIMIT)
    const sourceMessages = projectedSourceIds.flatMap((messageId) => {
      const message = sourceFacts.get(messageId)
      return message === undefined ? [] : [{
        messageId, text: compactText(message.text, 480),
        ...(message.senderName ? { senderName: message.senderName } : {}),
        ...(message.senderOpenDingTalkId ? { senderOpenDingTalkId: message.senderOpenDingTalkId } : {}),
        ...(message.occurredAt !== undefined ? { occurredAt: mainMessageTime(message.occurredAt) } : {}),
        ...(message.quotedMessage?.messageId || message.quotedMessageId ? { quotedMessageId: message.quotedMessage?.messageId ?? message.quotedMessageId } : {}),
        ...(message.quotedMessage?.content ? { quotedContent: compactText(message.quotedMessage.content, 240) } : {}),
      }]
    })
    const projectedTaskIds = uniqueValues([
      ...[...derivedTaskIds].filter((taskId) => contextualTaskIds.has(taskId)),
      ...[...derivedTaskIds].reverse(),
    ]).slice(0, REPLY_REVIEW_TASK_LIMIT)
    const relatedTasks = allRelatedTasks.filter((task) => projectedTaskIds.includes(task.taskId))
    const candidateText = [compactText(outbound.text, 800), ...sourceMessages.flatMap((message) => [message.text, message.quotedContent]), ...relatedTasks.map((task) => task.objective)].join('\n')
    return {
      index, score: contentSimilarity(currentText, candidateText),
      directlyLinked: sourceIds.some((messageId) => currentReferences.has(messageId)) || [...derivedTaskIds].some((taskId) => contextualTaskIds.has(taskId)),
      focused: [...derivedTaskIds].some((taskId) => focus.has(taskId)),
      confirmation: outbound.replyKind === 'confirmation',
      candidate: {
        outboundId: outbound.outboundId, ...(outbound.topicRefs ? { topicRefs: outbound.topicRefs } : {}), sourceMessageId: outbound.sourceMessageId, status: outbound.status,
        ...(outbound.matterUnitRefs ? { matterUnitRefs: outbound.matterUnitRefs } : {}),
        ...(outbound.deliveredMessageId ? { deliveredMessageId: outbound.deliveredMessageId } : {}),
        ...(outbound.replyKind ? { replyKind: outbound.replyKind } : {}),
        reply: compactText(outbound.text, 360), taskIds: projectedTaskIds, sourceMessages,
        tasks: relatedTasks.map(({ taskId, title, objective, state }) => ({ taskId, ...(title ? { title: compactText(title, 120) } : {}), objective: compactText(objective, 360), state })),
      },
    }
  })
  const newest = [...decorated].sort((left, right) => right.index - left.index)
  const prioritized = uniqueValues([
    ...newest.filter((item) => item.focused || item.directlyLinked),
    ...newest.filter((item) => item.confirmation).slice(0, REPLY_REVIEW_CONFIRMATION_LIMIT),
    ...[...decorated].filter((item) => item.score > 0).sort((left, right) => right.score - left.score || right.index - left.index).slice(0, Math.max(0, similarityLimit)),
    ...newest.slice(0, Math.max(0, recentLimit)),
  ])
  const bounded = []
  for (const item of prioritized) {
    if (bounded.length >= Math.max(0, candidateLimit)) break
    const next = [...bounded, item]
    if (JSON.stringify(next.map(({ candidate }) => candidate)).length <= Math.max(0, maxChars)) bounded.push(item)
  }
  return bounded.sort((left, right) => right.index - left.index).map(({ candidate }) => candidate)
}

function mainMessageTime(value) {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value !== 'string' || value.trim() === '') return '未知'
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString()
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

export function blockTaskDecisionForUnavailableMedia(decision, mediaUnavailable) {
  const unavailable = Array.isArray(mediaUnavailable) ? mediaUnavailable.map((item) => String(item).trim()).filter(Boolean) : []
  if (unavailable.length === 0 || !decision.actions.some((action) => ['new-task', 'task-context', 'task-reopen'].includes(action.kind))) return decision
  return { basisMessageIds: decision.basisMessageIds, basisUnitRefs: decision.basisUnitRefs, actions: [], reply: `我没能获取到以下任务信息：${unavailable.join('；')}。请重新发送可访问的内容，信息补齐后我再开始处理。`, ...(decision.replyReview ? { replyReview: decision.replyReview } : {}) }
}
