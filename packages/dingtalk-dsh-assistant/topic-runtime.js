import { acceptanceCriteriaSchema } from './task-input-contract.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { coordinationRole, coordinationTools } from './coordination-sessions.js'
import { z } from 'zod'
import { groupNotificationFields, groupNotificationRouting } from './group-notification.js'
import { FIXED_TOPICS, fixedTopicInstructions } from './fixed-topics.js'
import { personAliasInstructions, referencedPersonAliases } from './group-person-aliases.js'
import { toToolJsonSchema } from './tool-schema.js'
import { resolveTopicMessages, routingRecoveryBoundary, sourceDispatchOwnershipFor } from './store.js'
import { fingerprint, isPendingDecision, replyTopicForMessage, routingBlocksTopics, topicSummaryContext } from './topic-model.js'
import { factDecisionSchema, factDecisionJsonSchema } from './topic-facts.js'
import { TaskRevisionError } from './task-input-revision.js'
import { visiblePromptRefs, visibleSectionLength, visibleCoordinatorText, visibleToolOutputs, promptContent, compactSectionValue, buildMaterialManifest } from './coordination-context.js'
import { taskProgressSnapshot } from './task-progress.js'
import { assertCurrentTaskPrompts, isDiagnosticCheckpoint } from './task-result.js'
import { compactTopicRouteSubmissionJsonSchema, compactGroupDecisionSubmissionSchema, compactGroupDecisionSubmissionJsonSchema, compactReplyReviewCandidates, blockTaskDecisionForUnavailableMedia, groupDecisionSubmissionSchema, groupDecisionSubmissionJsonSchema, legacyGroupDecisionSubmissionSchema, legacyGroupDecisionSubmissionJsonSchema, topicRouteSubmissionSchema, topicRouteSubmissionJsonSchema, replyReviewJsonSchema, TOPIC_TITLE_MAX_CHARS, collectDecisionIssues, isSilentTaskFactFeedback } from './decision.js'

const sameJson = (text, value) => isDeepStrictEqual(JSON.parse(text), JSON.parse(JSON.stringify(value)))
const visibleRequestSectionLength = (agent, text, requestId, section, topicId) => {
  const pages = visibleToolOutputs(agent).filter(page => page.requestId === requestId && page.section === section
    && (topicId === undefined || page.topicId === topicId) && typeof page.text === 'string'
    && Number.isInteger(page.offset) && Number.isInteger(page.nextOffset) && page.nextOffset > page.offset
    && text.slice(page.offset, page.nextOffset) === page.text)
  let offset = 0
  while (true) {
    const next = Math.max(offset, ...pages.filter(page => page.offset <= offset).map(page => page.nextOffset))
    if (next === offset) return offset
    offset = next
  }
}
const textMessage = (text, images = []) => Object.freeze({ id: randomUUID(), role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text }, ...images.map((attachment) => ({ type: 'image', attachment }))] })
const DECISION_SECTIONS = ['messages', 'summary', 'removedUnitRefs', 'rejectedDecisions', 'ownership', 'quotedMessages', 'sourceMessages', 'promptIndex']
const objectOutput = { schema: { type: 'object' }, render: (_args, out) => [{ type: 'text', text: JSON.stringify(out) }] }
const jsonOutput = (value) => {
  if (value === undefined) throw new Error('tool_output_undefined')
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('tool_output_non_finite_number')
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new Error(`tool_output_not_json:${typeof item}`)
    return item
  })
  if (json === undefined) throw new Error('tool_output_not_json')
  return JSON.parse(json)
}
const invalidArguments = (error) => {
  const issues = []
  const visit = (items, prefix = [], branch = []) => {
    for (const issue of items) {
      const path = [...prefix, ...issue.path]
      if (issue.code === 'invalid_union' && issue.errors.length) {
        issue.errors.forEach((items, index) => visit(items, path, [...branch, index + 1]))
        continue
      }
      const paths = issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...path, key]) : [path]
      for (const field of paths) issues.push({ field: field.join('.') || '$', path: field.join('.') || '$', code: issue.code,
        message: issue.code === 'unrecognized_keys' ? '此分支不接受该字段；请移除或选择匹配的分支。' : issue.message,
        ...(branch.length ? { branch: branch.join('.') } : {}) })
    }
  }
  visit(error.issues)
  return { status: 'invalid-arguments', issues: issues.slice(0, 8), nextAction: 'correct-arguments' }
}
const sameVersions = (left, right) => left.length === right.length && left.every((item) => right.some((other) => other.messageId === item.messageId && other.messageVersion === item.messageVersion))
const routeGroupBaseline = group => fingerprint({ responsibility: group.responsibility, timezone: group.timezone, personAliases: group.personAliases, residentAgentPreset: group.residentAgentPreset, residentSessionId: group.residentSessionId, topics: group.topics })
const unitKey = (value) => value.unitId ? `${value.unitId}:${value.unitRevision}` : `legacy:${value.messageId}:${value.messageVersion}`
const topicReadCall = ({ topicId, revision }) => ({ name: 'group_topic_context_get', arguments: { topicId, revision } })
const topicIndex = (topics) => topics.map(({ topicId, title, revision, processedRevision, summaryRevision, status, summary, recallSources }) => ({ topicId, title, revision, processedRevision, summaryRevision, hasUnsummarized: summaryRevision < processedRevision, status,
  summary: summary?.slice(0, 240), readCall: topicReadCall({ topicId, revision }), ...(summaryRevision < processedRevision ? { unsummarizedReadCall: { name: 'group_topic_context_get', arguments: { topicId, revision, section: 'unsummarized', offset: 0 } } } : {}), ...(recallSources ? { recallSources } : {}) }))
const routeCandidateSnapshot = topic => Object.fromEntries(['title', 'revision', 'processedRevision', 'summaryRevision', 'hasUnsummarized', 'status', 'summary', 'openQuestions', 'processing'].filter(key => Object.hasOwn(topic, key)).map(key => [key, topic[key]]))
const topicMatches = (topics, queries) => topics.map((topic, index) => {
  const fields = { title: (topic.title ?? '').toLowerCase(), summary: (topic.summary ?? '').toLowerCase() }
  const matchedQueries = queries.flatMap(query => {
    const matchedFields = Object.keys(fields).filter(field => fields[field].includes(query.toLowerCase()))
    return matchedFields.length ? [{ query, fields: matchedFields }] : []
  })
  return { topic, index, matchedQueries }
}).filter(item => item.matchedQueries.length).sort((a, b) => b.matchedQueries.length - a.matchedQueries.length || a.index - b.index)
const routeRecallQueries = messages => {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const words = new Set()
  let remaining = 4000
  for (const message of messages) {
    if (remaining <= 0) break
    const text = message.text.slice(0, remaining)
    remaining -= text.length
    for (const part of segmenter.segment(text)) {
      const word = part.segment.trim()
      if (part.isWordLike && word.length >= 2 && word.length <= 32) words.add(word)
      if (words.size === 5) return [...words]
    }
  }
  return [...words]
}
const boundedItems = (items, maxChars, maxCount, required = () => false) => {
  const selected = items.filter(required)
  for (const item of items) {
    if (selected.includes(item) || selected.length >= maxCount) continue
    if (selected.length > 0 && JSON.stringify([...selected, item]).length > maxChars) break
    selected.push(item)
  }
  return selected
}
const routeBatch = (routable, pending) => {
  const links = new Map()
  for (const message of pending) {
    if (!message.routingRecoveryMessageId) continue
    for (const [left, right] of [[message.messageId, message.routingRecoveryMessageId], [message.routingRecoveryMessageId, message.messageId]]) {
      if (!links.has(left)) links.set(left, new Set())
      links.get(left).add(right)
    }
  }
  const selected = [], visited = new Set()
  for (const message of routable) {
    if (visited.has(message.messageId)) continue
    const ids = new Set([message.messageId]), queue = [message.messageId]
    for (const id of queue) for (const linked of links.get(id) ?? []) if (!ids.has(linked)) { ids.add(linked); queue.push(linked) }
    for (const id of ids) visited.add(id)
    const component = routable.filter(item => ids.has(item.messageId))
    if (component.length <= 15 && selected.length + component.length > 15) continue
    const part = component.slice(0, 15 - selected.length)
    if (selected.length && JSON.stringify([...selected, ...part]).length > 40_000) continue
    selected.push(...part)
  }
  return selected
}
const activeRouteBatch = (request, routable, pending) => {
  const byId = new Map(routable.map(message => [message.messageId, message]))
  const current = request.messages.map(message => byId.get(message.messageId)).filter(Boolean)
  const ids = new Set(current.map(message => message.messageId))
  return routeBatch([...current, ...routable.filter(message => !ids.has(message.messageId))], pending)
}
const strictlyBoundedItems = (items, maxChars, maxCount) => {
  const selected = []
  for (const item of items) {
    if (selected.length >= maxCount) break
    if (JSON.stringify([...selected, item]).length > maxChars) continue
    selected.push(item)
  }
  return selected
}
export const TOPIC_CONTEXT_MAX_CHARS = 40_000
export function boundedTopicContext(context, { textOffset = 0, maxChars = TOPIC_CONTEXT_MAX_CHARS } = {}) {
  if (!Number.isInteger(textOffset) || textOffset < 0) throw new Error('topic_text_offset_invalid')
  const projected = projectTopicContext(context)
  const taskRefs = strictlyBoundedItems(projected.taskRefs ?? [], 8_000, 50)
  const base = { ...projected, messages: [], taskRefs, totalTaskRefs: projected.taskRefs?.length ?? 0, hasMoreTaskRefs: taskRefs.length < (projected.taskRefs?.length ?? 0) }
  const messages = [], completedMessageIds = [], completedUnitRefs = []
  let nextOffset = projected.offset, nextTextOffset
  const output = () => ({ ...base, messages, completedMessageIds, completedUnitRefs, nextOffset, ...(nextTextOffset === undefined ? {} : { nextTextOffset }), hasMoreMessages: nextOffset < projected.total || nextTextOffset !== undefined })
  if (JSON.stringify(output()).length > maxChars) throw new Error('topic_context_metadata_too_large')
  for (let index = 0; index < projected.messages.length; index++) {
    const message = projected.messages[index]
    const start = index === 0 ? textOffset : 0
    const text = String(message.text ?? '')
    if (start > text.length) throw new Error('topic_text_offset_invalid')
    const complete = { ...message, text: text.slice(start), ...(start > 0 ? { textOffset: start, textTotal: text.length, textHasMore: false } : {}) }
    messages.push(complete); completedMessageIds.push(message.messageId); completedUnitRefs.push({ unitId: message.unitId, unitRevision: message.unitRevision }); nextOffset = projected.offset + index + 1; nextTextOffset = undefined
    if (JSON.stringify(output()).length <= maxChars) continue
    messages.pop(); completedMessageIds.pop(); completedUnitRefs.pop(); nextOffset = projected.offset + index
    let low = 0, high = text.length - start
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      messages.push({ ...message, text: text.slice(start, start + middle), textOffset: start, textTotal: text.length, textHasMore: start + middle < text.length })
      nextTextOffset = start + middle < text.length ? start + middle : undefined
      const fits = JSON.stringify(output()).length <= maxChars
      messages.pop()
      if (fits) low = middle
      else high = middle - 1
    }
    if (low === 0) {
      nextTextOffset = undefined
      break
    }
    const end = start + low
    messages.push({ ...message, text: text.slice(start, end), textOffset: start, textTotal: text.length, textHasMore: end < text.length })
    nextTextOffset = end
    break
  }
  const result = output()
  if (JSON.stringify(result).length > maxChars) throw new Error('topic_context_budget_exceeded')
  return result
}
const notificationDraftSchema = z.strictObject({
  reply: z.string().trim().min(1), replyReview: z.strictObject({
    kind: z.enum(['confirmation', 'substantive', 'correction']),
    reviewedOutboundIds: z.array(z.string().min(1)).default([]), sameMatterOutboundIds: z.array(z.string().min(1)).default([]), replaceOutboundIds: z.array(z.string().min(1)).default([]),
  }),
  ...groupNotificationFields,
})
const completionReviewSchema = z.union([
  z.strictObject({ accepted: z.literal(false), reason: z.string().trim().min(1) }),
  z.strictObject({ accepted: z.literal(true), reason: z.string().trim().min(1), notification: z.unknown().optional().describe('可选通知草稿 {reply,replyReview,replyToMessageId?,atOpenDingTalkIds?}，独立校验；无效草稿不改变业务审阅。') }),
])
const checkpointReviewSchema = z.strictObject({ decision: z.enum(['acknowledge', 'guidance', 'reject']), reason: z.string().trim().min(1), guidance: z.string().trim().min(1).optional() })
const waitingReviewSchema = z.union([
  z.strictObject({ decision: z.enum(['approve-wait', 'continue']), reason: z.string().trim().min(1) }),
  z.strictObject({ decision: z.literal('revise-scope'), reason: z.string().trim().min(1), basisMessageIds: z.array(z.string().trim().min(1)).min(1), affectedStageIds: z.array(z.string().trim().min(1)).min(1), title: z.string().trim().min(1).max(120), objective: z.string().trim().min(1), acceptanceCriteria: acceptanceCriteriaSchema, stageTasks: z.array(z.string().trim().min(1)).min(1) }),
])
const reviewSchemas = { completion: completionReviewSchema, checkpoint: checkpointReviewSchema, waiting: waitingReviewSchema }
const reviewSubmissionSchema = (kind) => z.strictObject({
  requestId: z.string().min(1),
  // 未绑定会话仅公开同源分支全集；实际提交仍按 Host 保存的请求种类解析。
  review: reviewSchemas[kind] ?? z.union([...completionReviewSchema.options, checkpointReviewSchema, ...waitingReviewSchema.options]),
})
const COMPLETION_MESSAGE_MAX_CHARS = 12_000
const DECISION_OUTPUT_MAX_BYTES = 12 * 1024
const DECISION_INITIAL_MAX_BYTES = 64 * 1024
const ROUTE_RECEIPT_MAX_BYTES = 1024
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const routeReceipt = (requestId, recovered = false) => {
  const value = { status: 'accepted', requestId, ...(recovered ? { recovered: true } : {}) }
  if (serializedBytes(value) > ROUTE_RECEIPT_MAX_BYTES) throw new Error('route_receipt_budget_exceeded')
  return value
}
const COMPLETION_MESSAGE_MAX_COUNT = 20
const ROUTE_CONTEXT_MAX_CHARS = 40_000
export const TASK_REVIEW_MAX_CHARS = 40_000
const diagnosticCheckpoint = (request) => request.kind === 'checkpoint' && isDiagnosticCheckpoint(request.value)
const reviewTextPage = (requestId, section, text, offset = 0) => {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error('task_review_offset_invalid')
  const output = (size) => ({ requestId, section, text: text.slice(offset, offset + size), offset, nextOffset: offset + size, totalChars: text.length, hasMore: offset + size < text.length })
  let low = 0, high = Math.min(text.length - offset, COMPLETION_MESSAGE_MAX_CHARS)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(output(middle)).length <= COMPLETION_MESSAGE_MAX_CHARS) low = middle
    else high = middle - 1
  }
  if (low === 0 && offset < text.length) throw new Error('task_review_metadata_too_large')
  return output(low)
}
const decisionTextPage = (requestId, section, content, offset = 0) => {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) throw new Error('decision_context_offset_invalid')
  const output = (size) => ({ requestId, section, offset, nextOffset: offset + size, totalChars: content.length,
    hasMore: offset + size < content.length, text: content.slice(offset, offset + size), contentFingerprint: fingerprint(content) })
  let low = 0, high = content.length - offset
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (serializedBytes(output(middle)) <= DECISION_OUTPUT_MAX_BYTES) low = middle
    else high = middle - 1
  }
  if (!low && offset < content.length) throw new Error('decision_context_metadata_too_large')
  return output(low)
}
const decisionMessage = (message) => {
  const { unitId, unitRevision, messageId, messageVersion, text, unitSummary, sourceRanges, contextRanges,
    senderName, senderOpenDingTalkId, sourceKind, quotedMessage, imageRefs, sourceAttachments,
    mediaUnavailable, predecessorUnitRefs, effectInheritance } = message
  return JSON.parse(JSON.stringify({ unitId, unitRevision, messageId, messageVersion, text, unitSummary,
    sourceRanges, contextRanges, senderName, senderOpenDingTalkId, sourceKind, quotedMessage,
    imageRefs, sourceAttachments, mediaUnavailable, predecessorUnitRefs, effectInheritance }))
}
const inlineReviewSection = (request, section, original, maxChars = 2_000, required = true) => {
  const text = JSON.stringify(original ?? null)
  request.sections[section] = text
  if (text.length <= maxChars) return compactSectionValue(request, section, original ?? null)
  if (required) request.requiredSections.add(section)
  return { section, totalChars: text.length, preview: text.slice(0, 500), nextOffset: 0, hasMore: true }
}

export function projectTopicContext(context) {
  const { topicId, title, revision, processedRevision, status, summary, summaryRevision, openQuestions } = context.topic
  const pending = context.topic.decisions?.findLast(isPendingDecision)
  const processing = pending ? { decisionId: pending.decisionId, status: pending.status, appliedOperations: pending.operations.filter((operation) => operation.status === 'applied').length, totalOperations: pending.operations.length, ...(pending.error ? { error: pending.error.slice(0, 1000) } : {}) } : undefined
  const messages = context.messages.map(({ _sourceMessageText: _hidden, ...message }) => message)
  return JSON.parse(JSON.stringify({ ...context, messages, topic: { topicId, title, revision, processedRevision, status, ...(summary === undefined ? {} : { summary }), summaryRevision, openQuestions, ...(processing ? { processing } : {}) } }))
}

// 请求是可丢弃的模型输入；已经接受的业务意图只以 Store 中的 decision 为准。
export function createTopicCoordinator({ store, getAgent, assertSession, dispatchRequest, waitRequestIdle, onRequestFinished, serializeTasks, applyAction, appendOutbox, readFrozenReply, reviewCandidates, validateReplyReview, cancelTask, onError, isClosing, onDecisionRequest, onInputSettled, checkStartupRecovery, quotedReminderContext, taskFacts, taskDecisionView, readArchivedTask, workflowPromptsEnabled = true, fixedTopicsEnabled = false, retryDelayMs = 30_000, maxRequestAttempts = 3 }) {
  const routes = new Map(), decisions = new Map(), replies = new Map(), reviews = new Map(), titleMigrations = new Map(), summaryMigrations = new Map()
  const collections = [routes, decisions, replies, reviews, titleMigrations, summaryMigrations]
  const isCurrentRequest = request => collections.some(collection => collection.get(request.requestId) === request)
  const requestRecoveryToken = (requestId, state) => fingerprint([requestId, state?.status, state?.attempt ?? 0, state?.resumeEpoch ?? 0, state?.failurePhase ?? null, state?.failureCode ?? null, state?.startupAttempt ?? 0, state?.messageId ?? null, state?.nextRetryAt ?? null])
  const retire = request => { if (request) onRequestFinished?.(request) }
  for (const collection of collections) {
    const remove = collection.delete.bind(collection)
    collection.delete = id => { const request = collection.get(id); const deleted = remove(id); if (deleted) retire(request); return deleted }
  }
  const activeToolCalls = new Set()
  const decisionPersistenceFaults = new Set()
  const decisionSubmitters = new Map()
  const scheduled = new Map(), scheduleAgain = new Set(), applying = new Map(), timers = new Set(), retries = new Map(), retryTimers = new Map(), groupsBeingChanged = new Map()
  let closed = false
  const live = () => !closed && !isClosing()
  const topicMessages = (groupId, topicId, revision) => resolveTopicMessages(store.getGroup(groupId), topicId, revision)
  const taskMessages = (task) => [...new Map(task.topicRefs.flatMap((ref) => topicMessages(task.groupId, ref.topicId, ref.revision)).map((message) => [unitKey(message), message])).values()]
  const scopedCandidates = (groupId, messages, topicRefs, focusTaskIds = []) => {
    const topicIds = new Set(topicRefs.map((ref) => ref.topicId))
    const sourceIds = new Set(messages.flatMap((message) => [message.messageId, message.quotedMessage?.messageId]).filter(Boolean))
    const unitIds = new Set(messages.map(unitKey))
    const taskIds = new Set([...focusTaskIds, ...store.listTasks().filter((task) => task.groupId === groupId && task.topicRefs.some((ref) => topicIds.has(ref.topicId))).map((task) => task.taskId)])
    const sourceLinked = focusTaskIds.length === 0
    return reviewCandidates(groupId, messages, [...taskIds]).filter((candidate) =>
      candidate.topicRefs?.some((ref) => topicIds.has(ref.topicId)) || candidate.taskIds?.some((id) => taskIds.has(id))
      || (sourceLinked && (candidate.matterUnitRefs?.length
        ? candidate.matterUnitRefs.some((ref) => unitIds.has(unitKey(ref)))
        : sourceIds.has(candidate.sourceMessageId) || candidate.sourceMessages?.some((message) => sourceIds.has(message.messageId)))))
  }
  const reviewRequired = request => ({ status: 'review-required', nextAction: 'group_reply_review_get', requestIds: [request.requestId] })
  const refreshReview = (request, identityOnly = false) => {
    const candidates = scopedCandidates(request.groupId, request.messages, request.topicRefs ?? request.task.topicRefs, request.task ? [request.task.taskId] : [])
    // Task运行态不是回复事实；正文、来源、归属及投递证据仍参与审阅失效。
    const snapshot = (items) => JSON.stringify([...items].sort((left, right) => left.outboundId.localeCompare(right.outboundId)).map((item) => identityOnly ? item.outboundId
      : { ...item, ...(item.tasks ? { tasks: item.tasks.map(({ state, ...facts }) => ({ ...facts, state: ['running', 'waiting'].includes(state) ? 'active' : state })) } : {}) }))
    if (snapshot(candidates) === snapshot(request.candidates)) return false
    request.candidates = candidates
    request.readReview = false
    return true
  }
  const effectOwnership = (groupId, topicId, revision, messages) => {
    const group = store.getGroup(groupId)
    const ownerByFact = new Map(), consumedFacts = new Set()
    // 已接受的业务效果随原始事实版本保留，归属纠正不能重新授予执行权。
    for (const topic of group.topics) {
      for (const record of topic.decisions) {
        if (record.status === 'rejected') continue
        if (!record.decision.actions.length && record.decision.replyReview?.kind !== 'confirmation') continue
        const basis = new Set(record.decision.basisUnitRefs?.map(unitKey) ?? [])
        for (const message of topicMessages(groupId, topic.topicId, record.revision)) {
          const key = unitKey(message)
          if (!basis.has(key)) continue
          consumedFacts.add(key)
          if (!ownerByFact.has(key)) ownerByFact.set(key, topic.topicId)
        }
      }
    }
    for (const topic of group.topics) for (const message of topicMessages(groupId, topic.topicId, topic.revision)) {
      if (message.effectInheritance === 'inherit' && message.predecessorUnitRefs.some((ref) => consumedFacts.has(unitKey(ref)))) consumedFacts.add(unitKey(message))
    }
    for (const topic of group.topics) {
      for (const message of topicMessages(groupId, topic.topicId, topic.revision)) {
        const key = unitKey(message)
        const entry = [...topic.entries].reverse().find((item) => item.revision <= topic.revision && item.unitId === message.unitId)
        if (!ownerByFact.has(key) && entry?.action === 'add' && entry.unitRevision === message.unitRevision && entry.effectOwner === true) ownerByFact.set(key, topic.topicId)
      }
    }
    // 旧数据没有显式主归属标记时保留原有稳定回退，新的多 Topic 路由必须显式指定。
    for (const topic of group.topics) {
      for (const message of topicMessages(groupId, topic.topicId, topic.revision)) {
        const key = unitKey(message)
        if (!ownerByFact.has(key)) ownerByFact.set(key, topic.topicId)
      }
    }
    const topic = group.topics.find((item) => item.topicId === topicId)
    for (const message of messages) if (sourceDispatchOwnershipFor(group, message)?.dispatchOwner === 'coordination') ownerByFact.set(unitKey(message), 'coordination')
    const delta = new Set(topic.entries.filter((entry) => entry.action === 'add' && entry.revision > topic.processedRevision && entry.revision <= revision).map(unitKey))
    return {
      effectOwnerTopicIds: Object.fromEntries(messages.flatMap((message) => [[message.unitId, ownerByFact.get(unitKey(message))], [message.messageId, ownerByFact.get(unitKey(message))]])),
      ownedDeltaUnitRefs: messages.filter((message) => !consumedFacts.has(unitKey(message)) && ownerByFact.get(unitKey(message)) === topicId && delta.has(unitKey(message))).map(({ unitId, unitRevision }) => ({ unitId, unitRevision })),
      ownedDeltaMessageIds: [...new Set(messages.filter((message) => !consumedFacts.has(unitKey(message)) && ownerByFact.get(unitKey(message)) === topicId && delta.has(unitKey(message))).map((message) => message.messageId))],
    }
  }
  const initialReplyPending = (groupId, topicId) => {
    const group = store.getGroup(groupId)
    return group?.routeHistory.some(receipt => receipt.initialReplies?.some(reply => reply.topicId === topicId
      && !group.outbox.some(outbound => outbound.outboundId === reply.outboundId
        && (outbound.notificationState || outbound.status === 'superseded' && outbound.notificationKnownNotSent === true)))) ?? false
  }
  const pendingInput = (groupId) => (store.getGroup(groupId)?.messages ?? []).filter((message) => !message.ownNotificationRetirement && message.routingStatus !== 'routed')
  const routableInput = (groupId) => pendingInput(groupId).filter(message => message.routingStatus !== 'needs-context')
  const pendingFor = (groupId, topicIds) => pendingInput(groupId).filter(message => routingBlocksTopics(message, topicIds))
  const pendingInputAt = (groupId, sequence, topicIds = []) => pendingFor(groupId, topicIds).filter(message => message.routingStatus === 'needs-context' || message.sequence <= sequence)
  const latestSequence = (groupId) => Math.max(0, ...(store.getGroup(groupId)?.messages ?? []).map((message) => message.sequence))
  const unfinished = (topic) => topic.decisions.find(isPendingDecision)
  const requestFor = (groupId, requestId) => {
    const request = decisions.get(requestId) ?? replies.get(requestId) ?? reviews.get(requestId)
    if (!request || request.groupId !== groupId) throw new Error('topic_request_unknown_or_wrong_group')
    return request
  }
  const requestIdentity = (kind, value) => `coord-${kind}-${fingerprint(value)}`
  const createShortReferences = () => {
    const prefix = `~ref-${randomUUID().replaceAll('-', '').slice(0, 16)}-`, byValue = new Map(), byRef = new Map()
    return {
      add(kind, value) {
        const key = JSON.stringify([kind, value])
        if (!byValue.has(key)) {
          const ref = `${prefix}${byValue.size.toString(36)}`
          byValue.set(key, ref); byRef.set(ref, { kind, value })
        }
        return byValue.get(key)
      },
      expose(ref) {
        byRef.get(ref).exposed = true
      },
      resolve(kind, value) {
        if (typeof value !== 'string' || !value.startsWith('~ref-') || byValue.has(JSON.stringify([kind, value]))) return value
        const entry = byRef.get(value)
        if (!entry?.exposed || entry.kind !== kind) throw new Error('coordination_reference_invalid')
        return entry.value
      },
    }
  }
  const supersedeRequest = (request, supersededBy, reason) => {
    if (!request?.requestId || request.requestId === supersededBy) return Promise.resolve()
    return (store.updateCoordinationRequest?.(request.groupId, request.requestId, {
      status: 'superseded', supersededBy, supersedeReason: reason, nextRetryAt: undefined, lastError: undefined,
    }) ?? Promise.resolve()).catch((error) => onError(request.groupId, error))
  }
  async function settleCoordinationRequest(groupId, requestId) {
    const state = requestId && store.getCoordinationRequest?.(groupId, requestId)
    if (state?.status === 'pending' && !collections.some(collection => collection.has(requestId))) {
      await store.updateCoordinationRequest(groupId, requestId, { status: 'completed', nextRetryAt: undefined })
    }
  }
  const replyRouting = (messages, replyToMessageId, atOpenDingTalkIds, atAll) => groupNotificationRouting(messages, { replyToMessageId, atOpenDingTalkIds, atAll })
  function reviewRequestIdentity(kind, task, value) {
    const { submittedAt: _submittedAt, reviewedAt: _reviewedAt, ...content } = value
    return requestIdentity(kind, { groupId: task.groupId, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
      value: content, taskPromptRefs: task.taskPromptRefs ?? [], lastCheckpointId: task.checkpoints?.at(-1)?.checkpointId,
      observedTopics: task.topicRefs.map(ref => ({ topicId: ref.topicId, revision: store.getTopic(task.groupId, ref.topicId)?.revision })),
      ...(kind === 'completion' ? { candidates: scopedCandidates(task.groupId, taskMessages(task), task.topicRefs, [task.taskId]) } : {}),
    })
  }
  function refreshVisibleReads(request) {
    const agent = getAgent(request.groupId, request)
    if (!agent?.session?.deriveMessages) return
    if (request.readPromptRefs) {
      const prompts = (store.getTaskPrompts?.() ?? []).filter((prompt) => prompt.enabled && request.promptCatalog.some((ref) => ref.id === prompt.id && ref.revision === prompt.revision))
      request.readPromptRefs = new Map(visiblePromptRefs(agent, prompts).map((ref) => [ref.id, ref]))
      for (const [id, ref] of request.readPromptRefs) request.readPromptVersions.set(id, ref)
    }
    if (request.readSectionOffsets) for (const [section, text] of Object.entries(request.sections)) request.readSectionOffsets.set(section, visibleSectionLength(agent, text))
  }
  function materialManifest(request) {
    const agent = getAgent(request.groupId, request)
    const outputs = visibleToolOutputs(agent)
    return buildMaterialManifest({ requestId: request.requestId, materials: Object.entries(request.sections).map(([id, text]) => ({
      id, version: request.inputVersion ?? request.task?.inputVersion ?? 1, text,
      pages: outputs.filter(out => out.requestId === request.requestId && out.section === id && typeof out.text === 'string'
        && Number.isInteger(out.offset) && text.slice(out.offset, out.offset + out.text.length) === out.text).map(out => ({ offset: out.offset, text: out.text })),
    })) })
  }
  function inlineCurrentSection(request, ...args) {
    const result = inlineReviewSection(request, ...args)
    if (!result?.section) return result
    const text = request.sections[result.section]
    if (visibleSectionLength(getAgent(request.groupId, request), text) < text.length) return result
    request.readSectionOffsets.set(result.section, text.length)
    return { section: result.section, totalChars: text.length, contentFingerprint: fingerprint(text), reused: true, hasMore: false }
  }
  const send = (groupId, text, images, request) => {
    if (!live()) throw new Error('resident_runtime_closed')
    const agent = getAgent(groupId)
    if (!agent) throw new Error(`resident_not_active:${groupId}`)
    if (!request) { agent.steer(textMessage(text, images)); return agent }
    request.text = text; request.images = images
    const messageId = `message-${request.requestId}${request.roundUpdate ? `-revision-${request.revision}` : ''}`
    request.messageId = messageId
    const state = store.getCoordinationRequest?.(groupId, request.requestId)
    if (state?.status === 'exhausted') { request.exhausted = true; return agent }
    if (dispatchRequest) return dispatchRequest(request, Object.freeze({ ...textMessage(text, images), id: messageId }))
    const pending = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
    const recorded = pending.some((message) => message.id === messageId) || agent.session?.snapshotEvents?.().some((event) => event.type === 'user/message' && event.data?.id === messageId)
    if (!recorded) agent.steer(Object.freeze({ ...textMessage(text, images), id: messageId }))
    return agent
  }
  function monitor(agentOrPromise, request, collection) {
    if (request.monitoring) return
    request.monitoring = true
    let agent = agentOrPromise?.then ? undefined : agentOrPromise
    // Provider 请求重试由 DSH 完成；这里只在整个 agent 真正停稳后补有限次协议提醒。
    // 保留同一请求和 Promise，绝不每秒删除请求、重建身份及整包原文。
    const current = () => live() && collection.get(request.requestId) === request
    const persist = (patch) => store.updateCoordinationRequest?.(request.groupId, request.requestId, patch) ?? Promise.resolve()
    const exhausted = async () => {
      request.monitoring = false
      request.exhausted = true
      const state = store.getCoordinationRequest?.(request.groupId, request.requestId)
      const startup = state?.failurePhase === 'startup' || !state?.failurePhase && state?.attempt === 0 && !state?.messageId
      const error = new Error(startup && state.lastError ? state.lastError : `topic_request_retry_exhausted:${request.requestId}`)
      if (state?.failureCode) error.code = state.failureCode
      await persist({ status: 'exhausted', lastError: error.message })
      retire(request)
      request.reject?.(error)
      onError(request.groupId, error)
    }
    const wait = async () => {
      if (!agent) agent = await agentOrPromise
      if (!current()) { request.monitoring = false; return }
      const state = store.getCoordinationRequest?.(request.groupId, request.requestId)
      request.attempt = state?.attempt ?? request.attempt ?? 0
      request.resumeEpoch = state?.resumeEpoch ?? 0
      if (state?.status === 'exhausted' || request.exhausted) { await exhausted(); return }
      await persist({ status: 'pending', attempt: request.attempt, messageId: request.messageId, failurePhase: undefined, failureCode: undefined, startupAttempt: undefined, nextRetryAt: undefined })
      await (waitRequestIdle ? waitRequestIdle(request) : agent.whenIdle())
      if (!current()) { request.monitoring = false; return }
      if (collection === decisions && (pendingFor(request.groupId, request.topicId ? [request.topicId] : []).length || request.retryAfterRouting || request.retryingAfterRouting)) { request.monitoring = false; request.routingPaused = true; return }
      if (request.attempt >= maxRequestAttempts) { await exhausted(); return }
      const delay = Math.max(0, state?.nextRetryAt ? Date.parse(state.nextRetryAt) - Date.now() : Math.min(retryDelayMs * 2 ** request.attempt, 300_000))
      await persist({ nextRetryAt: new Date(Date.now() + delay).toISOString() })
      const timer = setTimeout(() => {
        timers.delete(timer)
        const retry = async () => {
          if (!current()) { request.monitoring = false; return }
          if (waitRequestIdle) await waitRequestIdle(request)
          else if (agent.status === 'running') await agent.whenIdle()
          if (!current()) { request.monitoring = false; return }
          if (collection === decisions && (pendingFor(request.groupId, request.topicId ? [request.topicId] : []).length || request.retryAfterRouting || request.retryingAfterRouting)) { request.monitoring = false; request.routingPaused = true; return }
          request.attempt++
          await persist({ attempt: request.attempt, nextRetryAt: undefined })
          if (!current()) return
          const id = `message-${request.requestId}-resume-${request.resumeEpoch}-${request.attempt}`
          const pending = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
          const hasBody = (message) => message.id === request.messageId || (message.content ?? []).some((part) => part.type === 'text' && part.text === request.text)
          const visible = pending.some(hasBody) || agent.session?.deriveMessages?.().some(hasBody)
          // 原文仍在 surface 时仅发送短提醒；压缩已移出则恢复正文，不能靠历史已消费记录假定可见。
          const text = visible ? `[COORDINATION_RESUME]\n请求 ${request.requestId} 仍待提交；继续处理当前可见的原请求，不重复执行已完成的外部动作。` : request.text
          const consumed = agent.session?.snapshotEvents?.().some((event) => event.type === 'user/message' && event.data?.id === id)
          if (!pending.some((message) => message.id === id) && !consumed) {
            const message = Object.freeze({ ...textMessage(text, visible ? [] : request.images), id })
            if (dispatchRequest) agent = await dispatchRequest(request, message)
            else agent.steer(message)
          }
          await wait()
        }
        retry().catch(fail)
      }, delay)
      timer.unref?.(); timers.add(timer)
    }
    const fail = (error) => {
      request.monitoring = false
      if (!current()) return
      request.exhausted = true
      retire(request)
      const state = store.getCoordinationRequest?.(request.groupId, request.requestId)
      const startupAttempt = (state?.startupAttempt ?? 0) + 1
      persist({ status: 'exhausted', lastError: String(error.message).slice(0, 1000), failurePhase: 'dispatch', failureCode: error.code ?? 'COORDINATION_DISPATCH_FAILED',
        ...(error.coordinationStartupFailure && !state?.messageId ? { failurePhase: 'startup', failureCode: error.code ?? 'COORDINATION_STARTUP_FAILED', startupAttempt,
          nextRetryAt: new Date(Date.now() + Math.min(retryDelayMs * 2 ** Math.min(startupAttempt - 1, 10), 300_000)).toISOString() } : {})
      }).catch((failure) => onError(request.groupId, failure))
      request.reject?.(error); onError(request.groupId, error)
    }
    wait().catch(fail)
  }
  const personAliasesCurrent = request => fingerprint(request.personAliases ?? []) === fingerprint(referencedPersonAliases(store.getGroup(request.groupId), request.personAliasMessages ?? []))
  async function createDecisionRequest(groupId, topic) {
    const promptCatalog = (store.getTaskPrompts?.() ?? []).filter((item) => item.enabled).map(({ id, name, description, revision }) => ({ id, name, description, revision }))
    const rejected = topic.decisions.filter(record => record.status === 'rejected' && record.revision > topic.processedRevision)
    const messages = topicMessages(groupId, topic.topicId, topic.revision)
    const deltaIds = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= topic.revision).map(unitKey))
    const deltaMessages = messages.filter((message) => deltaIds.has(unitKey(message)))
    const personAliases = referencedPersonAliases(store.getGroup(groupId), deltaMessages)
    const presentationFingerprint = fingerprint({ summary: topic.summary, summaryRevision: topic.summaryRevision, openQuestions: topic.openQuestions })
    let requestId = requestIdentity('decision', { groupId, topicId: topic.topicId, revision: topic.revision, promptCatalog, presentationFingerprint, contract: fingerprint(workflowPromptsEnabled ? legacyGroupDecisionSubmissionJsonSchema : groupDecisionSubmissionJsonSchema),
      ...(personAliases.length ? { personAliases } : {}),
      ...(rejected.length ? { rejectedDecisionIds: rejected.map(record => record.decisionId) } : {}) })
    const versionRequestId = requestId
    let continuing
    for (const [id, request] of decisions) {
      if (request.groupId !== groupId || request.topicId !== topic.topicId) continue
      if ((request.versionRequestId ?? request.requestId) === requestId) { request.dispatch?.(); return request }
      if (request.trigger !== 'task-facts' && !request.exhausted && request.revision < topic.revision) {
        continuing = request
        requestId = request.requestId
        break
      }
      supersedeRequest(request, requestId, 'topic-revision-replaced')
      decisions.delete(id)
    }
    const removedUnitRefs = topic.entries.filter((entry) => entry.action === 'remove' && entry.revision > topic.processedRevision && entry.revision <= topic.revision).map(({ unitId, unitRevision, messageId }) => ({ unitId, unitRevision, messageId }))
    const removedMessageIds = [...new Set(topic.entries.filter((entry) => entry.action === 'remove' && entry.revision > topic.processedRevision && entry.revision <= topic.revision).map((entry) => entry.messageId))]
    const nextRequest = { requestId, versionRequestId, presentationFingerprint, groupId, topicId: topic.topicId, revision: topic.revision, messages, personAliasMessages: deltaMessages, personAliases, removedUnitRefs, removedMessageIds, promptCatalog, readPromptRefs: new Map(), readPromptVersions: new Map(),
      topicRefs: [{ topicId: topic.topicId, revision: topic.revision }], candidates: scopedCandidates(groupId, messages, [{ topicId: topic.topicId, revision: topic.revision }]), readReview: false, shortReferences: createShortReferences(), taskContextReads: new Map(), reviewReadFingerprints: new Map() }
    // Keep the actual request object: native session/tool closures are bound to it.
    const request = continuing ?? nextRequest
    if (continuing) {
      Object.assign(request, nextRequest, { roundUpdate: true, routingPaused: false, dispatchState: 'pending' })
      delete request.retryAfterRouting
      delete request.retryingAfterRouting
    }
    decisions.set(request.requestId, request)
    const ownership = effectOwnership(groupId, topic.topicId, topic.revision, deltaMessages)
    const removedUnitsForWire = removedUnitRefs.map(item => ({ ...item, messageShortRef: request.shortReferences.add('message', item.messageId), unitShortRef: request.shortReferences.add('unit', { unitId: item.unitId, unitRevision: item.unitRevision }) }))
    const quoted = new Map(), sources = new Map()
    const projected = deltaMessages.map((message) => {
      const item = { ...decisionMessage(message), messageShortRef: request.shortReferences.add('message', message.messageId), unitShortRef: request.shortReferences.add('unit', { unitId: message.unitId, unitRevision: message.unitRevision }), effectOwnerTopicId: ownership.effectOwnerTopicIds[message.unitId] }
      if (item.quotedMessage) {
        const id = item.quotedMessage.messageId ?? fingerprint(item.quotedMessage)
        const quoteId = quoted.has(id) && JSON.stringify(quoted.get(id)) !== JSON.stringify(item.quotedMessage)
          ? `${id}:${fingerprint(item.quotedMessage)}` : id
        quoted.set(quoteId, item.quotedMessage)
        item.quotedMessageId = quoteId
        delete item.quotedMessage
      }
      const original = message._sourceMessageText
      if (original && original !== item.text) sources.set(item.messageId, { messageId: item.messageId, messageVersion: item.messageVersion, text: original })
      return item
    })
    const quotedMessages = [...quoted].map(([quoteId, message]) => ({ ...message, quoteId }))
    const sourceMessages = [...sources.values()]
    // Initial context contains status summaries only; full contracts/evidence are explicit reads.
    const linked = taskFacts?.tasks ? (await taskFacts.tasks(groupId, topic.topicId)).map(task => ({
      taskId: task.taskId, title: task.title, inputVersion: task.requirementRevision, runSequence: task.runSequence,
      state: task.status === 'completed' ? 'completed' : task.control === 'cancelled' ? 'cancelled' : task.control === 'paused' ? 'waiting' : 'running', summary: task.summary,
      ...(task.archivedAt ? { archivedAt: task.archivedAt, allowedActions: [] } : {}),
    })) : store.listTasks().filter(task => task.groupId === groupId
      && task.topicRefs?.some(ref => ref.topicId === topic.topicId)).map(task => ({ taskId: task.taskId,
        title: task.title?.slice(0, 200), inputVersion: task.inputVersion, runSequence: task.runSequence,
        state: task.state, summary: (task.completion?.summary ?? task.lastDecision?.summary ?? '').slice(0, 800) }))
    const linkedReads = boundedItems(linked.map(task => ({ taskId: task.taskId, shortRef: request.shortReferences.add('task', task.taskId), inputVersion: task.inputVersion,
      runSequence: task.runSequence, state: task.state,
      ...(task.archivedAt ? { archivedAt: task.archivedAt, allowedActions: [] } : { readCall: { name: 'group_task_context_get', arguments: { taskIds: [task.taskId] } } }) })), 1_600, 8)
    const linkedIds = new Set(linkedReads.map(task => task.taskId))
    const linkedSnapshots = []
    for (const task of linked.filter(task => linkedIds.has(task.taskId))) {
      if (serializedBytes([...linkedSnapshots, task]) <= 3_000) linkedSnapshots.push(task)
    }
    const linkedTasks = { total: linked.length, reads: linkedReads, snapshots: linkedSnapshots,
      hasMore: linkedReads.length < linked.length || !!taskFacts?.tasks && linked.length === 8 }
    request.hasSourceContext = quotedMessages.length > 0 || sourceMessages.length > 0
    const summaryContext = topic.processedRevision > topic.summaryRevision ? topicSummaryContext(store.getGroup(groupId), topic) : undefined
    request.sections = { promptIndex: JSON.stringify(promptCatalog), messages: JSON.stringify(projected), summary: JSON.stringify(summaryContext ?? { summary: topic.summary, openQuestions: topic.openQuestions }),
      removedUnitRefs: JSON.stringify(removedUnitsForWire), rejectedDecisions: JSON.stringify(rejected.map(record => ({ decisionId: record.decisionId, error: record.error }))),
      ownership: JSON.stringify({ ownedDeltaUnitRefs: ownership.ownedDeltaUnitRefs, ownedDeltaMessageIds: ownership.ownedDeltaMessageIds }),
      quotedMessages: JSON.stringify(quotedMessages), sourceMessages: JSON.stringify(sourceMessages) }
    request.readSectionOffsets = new Map()
    request.requiredSections = new Set()
    request.readUnitRefs = new Set()
    const pointer = (section) => ({ section, totalChars: request.sections[section].length, contentFingerprint: fingerprint(request.sections[section]), nextOffset: 0, hasMore: true })
    const envelope = { requestId, topicId: topic.topicId, revision: topic.revision, topicShortRef: request.shortReferences.add('topic-version', { topicId: topic.topicId, revision: topic.revision }), processedRevision: topic.processedRevision,
      ...(request.personAliases.length ? { personAliases: request.personAliases, personAliasGuide: personAliasInstructions } : {}),
      replyOwnership: [...new Map(deltaMessages.map(message => [message.messageId, { messageId: message.messageId,
        replyTopicId: replyTopicForMessage(store.getGroup(groupId), message) }])).values()],
      readCalls: { topic: { name: 'group_topic_context_get', arguments: { topicId: topic.topicId, revision: topic.revision } },
        replyReview: { name: 'group_reply_review_get', arguments: { requestIds: [requestId] } } },
      title: topic.title, linkedTasks, ...(workflowPromptsEnabled ? { promptIndex: promptCatalog } : {}), contextSections: workflowPromptsEnabled ? DECISION_SECTIONS : DECISION_SECTIONS.filter(section => section !== 'promptIndex'), summaryRevision: topic.summaryRevision, replyReviewCandidateCount: request.candidates.length,
      totalMessages: messages.length, historyAvailable: messages.length > deltaMessages.length,
      ownedDeltaUnitRefs: ownership.ownedDeltaUnitRefs, ownedDeltaMessageIds: ownership.ownedDeltaMessageIds,
      messages: projected, quotedMessages, sourceMessages, summary: topic.summary, openQuestions: topic.openQuestions, ...(summaryContext ? { unsummarized: summaryContext.unsummarized } : {}),
      removedUnitRefs: removedUnitsForWire, removedMessageIds, ...(rejected.length ? { rejectedDecisions: rejected.map(record => ({ decisionId: record.decisionId, error: record.error, recoveryReason: record.recoveryReason })),
        recoveryInstruction: '此前决策被拒绝，Task 动作未执行；先读取当前 Task 的版本与上下文，按当前合同重新判断全部未处理输入。涉及阶段时使用真实 stageId。已发送回复仍须审阅，不重复确认。' } : {}) }
    const sectionFields = { promptIndex: ['promptIndex'], summary: ['summary', 'openQuestions', 'unsummarized'], quotedMessages: ['quotedMessages'], sourceMessages: ['sourceMessages'],
      removedUnitRefs: ['removedUnitRefs'], rejectedDecisions: ['rejectedDecisions'], ownership: ['ownedDeltaUnitRefs', 'ownedDeltaMessageIds'], messages: ['messages'] }
    // Optional Task snapshots must not displace the new source/authorization facts.
    if (serializedBytes(envelope) > DECISION_OUTPUT_MAX_BYTES - 1500) linkedTasks.snapshots = []
    if (serializedBytes(envelope) > DECISION_OUTPUT_MAX_BYTES - 1500) delete envelope.linkedTasks
    const externalizedSections = new Set()
    while (serializedBytes(envelope) > DECISION_OUTPUT_MAX_BYTES - 1500) {
      const section = Object.entries(sectionFields).filter(([name, fields]) => !externalizedSections.has(name) && fields.some((field) => Object.hasOwn(envelope, field)))
        .map(([name, fields]) => ({ name, size: serializedBytes(fields.map((field) => envelope[field])) }))
        .sort((left, right) => right.size - left.size)[0]?.name
      if (!section) throw new Error('decision_context_metadata_too_large')
      for (const field of sectionFields[section]) delete envelope[field]
      envelope[section === 'summary' ? 'summaryContext' : section] = pointer(section)
      externalizedSections.add(section)
      if (section !== 'messages' && (section !== 'summary' || summaryContext)) request.requiredSections.add(section)
    }
    const restoredLinkedTasks = { ...linkedTasks, snapshots: linkedSnapshots }
    if (serializedBytes({ ...envelope, linkedTasks: restoredLinkedTasks }) <= DECISION_OUTPUT_MAX_BYTES - 1500) envelope.linkedTasks = restoredLinkedTasks
    else if (!envelope.linkedTasks && serializedBytes({ ...envelope, linkedTasks }) <= DECISION_OUTPUT_MAX_BYTES - 1500) envelope.linkedTasks = linkedTasks
    if (serializedBytes(envelope) > DECISION_OUTPUT_MAX_BYTES - 1500) throw new Error('decision_context_metadata_too_large')
    delete request.inlineDecisionSnapshot
    delete request.inlineSummary
    const task = linked.length === 1 && !linkedTasks.hasMore && !linked[0].archivedAt && taskDecisionView ? store.getTask(linked[0].taskId) : undefined
    if (task?.groupId === groupId && !task.archivedAt && task.inputVersion === linked[0].inputVersion && task.runSequence === linked[0].runSequence) {
      refreshReview(request)
      const view = taskDecisionView(task)
      const candidates = request.candidates.map(candidate => ({ ...candidate, shortRef: request.shortReferences.add('outbound', candidate.outboundId) }))
      const inlineDecisionContext = { task: view, replyReview: { requestIds: [requestId], ...compactReplyReviewCandidates(candidates), candidateCount: candidates.length } }
      if (serializedBytes({ ...envelope, inlineDecisionContext }) <= DECISION_INITIAL_MAX_BYTES) {
        envelope.inlineDecisionContext = inlineDecisionContext
        request.inlineDecisionSnapshot = { requestId, versionRequestId, revision: topic.revision, taskId: task.taskId, taskText: JSON.stringify(view), reviewFingerprint: fingerprint(request.candidates) }
      }
    }
    request.visibleMessages = Array.isArray(envelope.messages) ? envelope.messages : []
    request.inlineDelta = Array.isArray(envelope.messages)
    envelope.omittedDeltaCount = request.inlineDelta ? 0 : deltaMessages.length
    const workflowAssessment = workflowPromptsEnabled ? '和适用流程 ID/版本及选择原因' : ''
    const workflowReading = workflowPromptsEnabled ? '流程索引为 promptIndex，按本请求 requestId 用 group_task_prompt_get 一次读取候选流程正文；不要猜测 section。' : ''
    const instruction = `按此 Topic 固定版本处理本次事项增量。仅本 Topic 拥有的当前事项可创建或更新 Task；每个 action 携带各自 basisUnitRefs。Unit用于引用来源，不是逐项建Task的指令；同一业务事项的多个需求项或Unit可共同支撑一个Task，优先补充适配的原任务。同一消息拆出多个事项时，new-task 必须提供 dispatchAssessment，分别写明业务对象、当前 Agent 交付、他人后续事项、来源 Unit${workflowAssessment}；不得把其他事项或他人验收写入当前目标。单事项任务也应按此核对。首包内联的 messages 和其他正文可直接使用，无需重复读取；仅遇到 section 指针时，用 group_decision_context_get 按 nextOffset 续读完整内容。${workflowReading}group_decision_context_get 只接受 contextSections 列出的 section。查询已有 Task 用 group_task_list 和 group_task_context_get；inlineDecisionContext 如存在，已包含完整Task视图与回复审阅候选，可直接判断，其他或变化后的任务仍须读取。需要历史时用 group_topic_context_get。`
    const makeBody = () => `[GROUP_TOPIC_DECISION]\nTopic 请求：${JSON.stringify(envelope)}\n${continuing ? "同轮更新：保留本会话已读事实，当前完整快照替代旧版本；旧草稿不得提交，必须结合本次新增或修订来源重新判断，以当前revision提交。\n" : ""}${instruction}${workflowPromptsEnabled ? '' : ' 提交时只需当前revision和decision；basisUnitRefs与每个action的basisUnitRefs、dispatchAssessment.sourceUnitRefs填写消息或移除事项的unitShortRef字符串，分别明确选择来源，不能自动扩大来源。basisMessageIds、replyToMessageId及impactEvidence中的消息ID可用已展示的messageShortRef。回复审阅读取后的候选shortRef可用于sameMatterOutboundIds与replaceOutboundIds，须明确选择同事项和替换对象；完整审阅候选身份由Host在确认候选已完整可见且未变化后填入。当前话题使用topicShortRef，已展示任务可用linkedTasks.reads的shortRef替代taskId；其他话题仍使用完整topicRefs。'}`
    let body = makeBody()
    if (envelope.inlineDecisionContext && Buffer.byteLength(body, 'utf8') > DECISION_INITIAL_MAX_BYTES) {
      delete envelope.inlineDecisionContext
      delete request.inlineDecisionSnapshot
      body = makeBody()
    }
    if (envelope.inlineDecisionContext && request.requiredSections.has('summary')) {
      const pointer = envelope.summaryContext
      const summary = JSON.parse(request.sections.summary)
      const previous = Object.fromEntries(Object.keys(summary).filter(key => Object.hasOwn(envelope, key)).map(key => [key, envelope[key]]))
      delete envelope.summaryContext
      Object.assign(envelope, summary)
      const expandedBody = makeBody()
      if (Buffer.byteLength(expandedBody, 'utf8') <= DECISION_INITIAL_MAX_BYTES) {
        request.inlineSummary = true
        body = expandedBody
      } else {
        for (const key of Object.keys(summary)) delete envelope[key]
        Object.assign(envelope, previous)
        envelope.summaryContext = pointer
      }
    }
    if (Buffer.byteLength(body, 'utf8') > (envelope.inlineDecisionContext ? DECISION_INITIAL_MAX_BYTES : DECISION_OUTPUT_MAX_BYTES)) throw new Error('decision_context_budget_exceeded')
    const dispatch = () => {
      const agent = send(groupId, body, deltaMessages.flatMap((message) => message.imageRefs ?? []), request)
      if (request.inlineSummary) request.readSectionOffsets.set('summary', request.sections.summary.length)
      if (request.inlineDelta) for (const message of deltaMessages) request.readUnitRefs.add(unitKey(message))
      request.shortReferences.expose(envelope.topicShortRef)
      for (const item of envelope.linkedTasks?.reads ?? []) request.shortReferences.expose(item.shortRef)
      for (const item of envelope.inlineDecisionContext?.replyReview.candidates ?? []) request.shortReferences.expose(item.shortRef)
      for (const item of [...(Array.isArray(envelope.messages) ? envelope.messages : []), ...(Array.isArray(envelope.removedUnitRefs) ? envelope.removedUnitRefs : [])]) {
        request.shortReferences.expose(item.unitShortRef)
        request.shortReferences.expose(item.messageShortRef)
      }
      request.dispatchState = 'dispatched'
      monitor(agent, request, decisions)
    }
    request.dispatchState = 'pending'
    request.dispatch = () => {
      if (request.dispatchState !== 'pending' || decisions.get(requestId) !== request || store.getTopic(groupId, topic.topicId)?.revision !== topic.revision) return
      if (!onDecisionRequest) { dispatch(); return }
      request.dispatchState = 'checking'
      const pending = Promise.resolve().then(() => onDecisionRequest({ groupId, requestId: request.requestId })).catch((error) => { onError(groupId, error); return false }).then((handled) => {
        if (!live() || decisions.get(request.requestId) !== request) return
        if (store.getTopic(groupId, topic.topicId)?.revision !== topic.revision) { request.dispatchState = 'pending'; return }
        if (handled === true) request.dispatchState = 'dispatched'
        else { request.dispatchState = 'pending'; dispatch() }
      })
      activeToolCalls.add(pending)
      pending.then(() => activeToolCalls.delete(pending), (error) => { activeToolCalls.delete(pending); onError(groupId, error) })
    }
    request.dispatch()
    return request
  }
  function prepareRecoveryBoundary(request, group) {
    const selected = new Set(request.messages.map(message => message.messageId))
    request.recoveryBoundary = routingRecoveryBoundary(group, [...selected])
    const ids = new Set(request.recoveryBoundary.flatMap(edge => [edge.sourceMessageId, edge.answerMessageId]).filter(id => !selected.has(id)))
    const dependencies = group.messages.filter(message => ids.has(message.messageId)).map(({ facts, ...message }) => message)
    request.recoveryBoundaryText = JSON.stringify({ edges: request.recoveryBoundary, messages: dependencies })
    request.recoveryBoundaryOffset = request.recoveryBoundary.length ? 0 : request.recoveryBoundaryText.length
    request.recoveryImages = dependencies.flatMap(message => message.imageRefs ?? [])
  }
  async function createRouteRequest(groupId, messages, reason) {
    if (messages.length > 15) throw new Error('topic_route_batch_limit')
    const group = store.getGroup(groupId)
    messages = structuredClone(messages.map(({ facts, ...message }) => message))
    const request = { requestId: requestIdentity('route', { groupId, routingRevision: group.routingRevision, contract: fingerprint(topicRouteSubmissionJsonSchema), messages: messages.map(({ messageId, messageVersion, routingEpoch }) => ({ messageId, messageVersion, epoch: routingEpoch ?? 0 })), reason }), groupId, routingRevision: group.routingRevision, batchRevision: 0, messages, readOffsets: new Map(), shortReferences: createShortReferences(), ...(reason ? { reason } : {}) }
    routes.set(request.requestId, request)
    try {
    // 仅复用已送达通知的精确来源关联；这只是缩小首屏，不替模型判定本次是否订正。
    const quotedReminders = new Map()
    if (quotedReminderContext) await Promise.all(messages.filter(message => message.quotedMessage?.messageId).map(async message => {
      const reminder = await quotedReminderContext({ groupId, messageId: message.messageId, messageVersion: message.messageVersion, actorId: message.senderOpenDingTalkId })
      if (reminder) quotedReminders.set(message.messageId, { coordinationId: reminder.coordinationId, quotedMessageId: reminder.quotedMessageId })
    }))
    if (!live() || routes.get(request.requestId) !== request) return
    const currentGroup = store.getGroup(groupId)
    const currentMessages = messages.map(message => currentGroup?.messages.find(item => item.messageId === message.messageId)).filter(Boolean)
    if (!currentGroup || request.routingRevision !== currentGroup.routingRevision || !sameVersions(messages, currentMessages)) {
      routes.delete(request.requestId)
      // await 期间的富化会使原快照失效；只重取原批次，后来的独立消息仍由提交后的调度接续。
      const retained = currentMessages.filter(message => !message.ownNotificationRetirement)
      if (currentGroup && currentMessages.length === messages.length && retained.length) return createRouteRequest(groupId, retained, reason)
      return
    }
    request.routeGroupBaseline = routeGroupBaseline(currentGroup)
    prepareRecoveryBoundary(request, currentGroup)
    const allTopics = store.listTopics(groupId).filter(topic => !topic.mergedInto)
    const referencedIds = new Set(messages.flatMap(message => [message.messageId, message.quotedMessage?.messageId]).filter(Boolean))
    const relatedIds = new Set(allTopics.filter(topic => {
      const active = new Map(topic.entries.map(entry => [entry.unitId ?? entry.messageId, entry]))
      return [...active.values()].some(entry => entry.action === 'add' && referencedIds.has(entry.messageId))
    }).map(topic => topic.topicId))
    const quotedReplies = group.outbox.filter(outbound => outbound.deliveredMessageId && referencedIds.has(outbound.deliveredMessageId))
    for (const reply of quotedReplies) {
      if (reply.replyTopicId) relatedIds.add(reply.replyTopicId)
      else for (const ref of reply.topicRefs ?? []) relatedIds.add(ref.topicId)
    }
    for (const message of messages) {
      const reply = quotedReplies.find(reply => reply.deliveredMessageId === message.quotedMessage?.messageId)
      if (reply) message.quotedReply = { topicId: reply.replyTopicId ?? reply.topicRefs?.[0]?.topicId,
        taskIds: reply.taskIds ?? [], coveredEventIds: reply.coveredEventIds ?? [] }
    }
    const directIds = new Set(relatedIds)
    const linkedTasks = store.listTasks().filter(task => task.groupId === groupId && task.topicRefs.some(ref => relatedIds.has(ref.topicId)))
    for (const task of linkedTasks) for (const ref of task.topicRefs) relatedIds.add(ref.topicId)
    const allRelatedTopics = topicIndex(allTopics.filter(topic => relatedIds.has(topic.topicId)).map(topic => ({ ...topic,
      recallSources: [...(directIds.has(topic.topicId) ? ['reference'] : []), ...(linkedTasks.some(task => task.topicRefs.some(ref => ref.topicId === topic.topicId)) ? ['task'] : [])] })))
    request.relatedTopics = allRelatedTopics
    const relatedTopics = boundedItems(allRelatedTopics.map(topic => ({ ...topic, shortRef: request.shortReferences.add('topic', topic.topicId) })), 3_000, 20)
    const quotedReminderOnly = messages.length > 0 && quotedReminders.size === messages.length && allRelatedTopics.length === 0
    const recallQueries = quotedReminderOnly ? [] : routeRecallQueries(messages)
    const matches = topicMatches(allTopics.filter(topic => !relatedIds.has(topic.topicId)), recallQueries)
    const recalledTopics = boundedItems(matches.map(({ topic, matchedQueries }) => ({ ...topicIndex([topic])[0], matchedQueries, shortRef: request.shortReferences.add('topic', topic.topicId) })), 1_500, 20)
    const topics = quotedReminderOnly ? [] : boundedItems(topicIndex(allTopics).map(({ processedRevision: _processed, ...item }) => ({ ...item, shortRef: request.shortReferences.add('topic', item.topicId) })), 5_000 - JSON.stringify(recalledTopics).length, 100)
    // Fixed-category continuations have no business Topic history to recall.
    // A small preceding window supplies context for short replies without adding a model turn.
    const firstSequence = Math.min(...messages.map(message => message.sequence))
    const recentMessages = strictlyBoundedItems(group.messages.filter(message => message.sequence < firstSequence).slice(-8).reverse()
      .map(({ messageId, senderName, text, sourceKind, messageAiSendFlag }) => ({ messageId, senderName,
        text: text.slice(0, 600), ...(text.length > 600 ? { textTruncated: true } : {}), sourceKind, messageAiSendFlag })), 4_000, 8).reverse()
    request.clarificationReviewCandidates = reviewCandidates(groupId, messages, [])
    const candidateText = JSON.stringify(request.clarificationReviewCandidates)
    const inlineCandidates = candidateText.length <= 6_000
    request.clarificationReviewText = candidateText
    request.clarificationReviewOffset = inlineCandidates ? candidateText.length : 0
    const personAliases = referencedPersonAliases(group, messages)
    const peopleContext = personAliases.length ? { personAliases, personAliasGuide: personAliasInstructions } : {}
    request.metadataPages = new Map()
    const metadata = messages.map(message => {
      const { text: _text, ...rest } = message
      return { ...rest, shortRef: request.shortReferences.add('message', message.messageId), ...(quotedReminders.has(message.messageId) ? { quotedReminder: quotedReminders.get(message.messageId) } : {}) }
    })
    const visibleMessages = messages.map((message, index) => ({ ...metadata[index], text: '',
      ...(message.text.length ? { textOffset: 0, textTotal: message.text.length, textHasMore: true } : {}) }))
    const envelope = { ...peopleContext, ...(fixedTopicsEnabled ? { fixedTopics: FIXED_TOPICS } : {}), requestId: request.requestId, batchRevision: request.batchRevision, messages: visibleMessages, recentMessages, totalMessages: messages.length, hasMoreMessages: false, topics, relatedTopics, recalledTopics, recallQueries,
      ...(inlineCandidates ? { clarificationReviewCandidates: request.clarificationReviewCandidates } : { clarificationReviewCandidateCount: request.clarificationReviewCandidates.length, clarificationReviewReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'clarificationReviewCandidates', offset: 0 } } }),
      ...(request.recoveryBoundary.length ? { recoveryBoundaryReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'recoveryBoundary', offset: 0 } } } : {}),
      totalRelatedTopics: allRelatedTopics.length, hasMoreRelatedTopics: relatedTopics.length < allRelatedTopics.length, nextRelatedTopicOffset: relatedTopics.length, totalTopics: allTopics.length, hasMoreTopics: topics.length < allTopics.length, nextTopicOffset: topics.length, ...(reason ? { reason } : {}) }
    if (quotedReminders.size) envelope.quotedReminderGuide = 'quotedReminder 是 Host 按原生引用和已送达回执核验的原提醒，仅为关联背景，不代表本条消息必然订正。只改变原提醒的事项可交 coordination；新增或混合事项仍逐项判断，必要时用 group_topic_list 省略 requestId 查询完整话题目录。首屏省略目录不表示没有旧话题，不得自动把同人新要求归入旧提醒。'
    const largestMetadata = metadata.map((item, index) => ({ index, size: JSON.stringify(item).length })).sort((a, b) => b.size - a.size)
    for (const { index } of largestMetadata) {
      if (JSON.stringify(envelope).length <= ROUTE_CONTEXT_MAX_CHARS) break
      const message = messages[index], text = JSON.stringify(metadata[index])
      request.metadataPages.set(message.messageId, { text, offset: 0 })
      visibleMessages[index] = { messageId: message.messageId, messageVersion: message.messageVersion, shortRef: request.shortReferences.add('message', message.messageId), text: '',
        ...(message.text.length ? { textOffset: 0, textTotal: message.text.length, textHasMore: true } : {}),
        metadataReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, messageId: message.messageId, section: 'messageMetadata', offset: 0 } } }
    }
    if (JSON.stringify(envelope).length > ROUTE_CONTEXT_MAX_CHARS) throw new Error('topic_route_context_metadata_too_large')
    for (const [index, message] of messages.entries()) {
      const { text: _text, textOffset: _offset, textTotal: _total, textHasMore: _more, ...base } = visibleMessages[index]
      const project = size => ({ ...base, text: message.text.slice(0, size), ...(size === message.text.length ? {} : { textOffset: 0, textTotal: message.text.length, textHasMore: true }) })
      visibleMessages[index] = project(0)
      if (JSON.stringify(envelope).length > ROUTE_CONTEXT_MAX_CHARS) throw new Error('topic_route_context_metadata_too_large')
      let low = 0, high = message.text.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        visibleMessages[index] = project(middle)
        if (JSON.stringify(envelope).length <= ROUTE_CONTEXT_MAX_CHARS) low = middle
        else high = middle - 1
      }
      visibleMessages[index] = project(low)
      request.readOffsets.set(message.messageId, low)
    }
    envelope.hasMoreMessages = visibleMessages.some(message => message.textHasMore)
    request.seenTopicVersions = new Map([...topics, ...relatedTopics, ...recalledTopics].map(item => [item.topicId, item.revision]))
    request.seenTopicSnapshots = new Map([...topics, ...relatedTopics, ...recalledTopics].map(item => [item.topicId, { kind: 'index', value: routeCandidateSnapshot(item) }]))
    for (const item of [...visibleMessages, ...topics, ...relatedTopics, ...recalledTopics]) request.shortReferences.expose(item.shortRef)
    const agent = send(groupId, `[GROUP_TOPIC_ROUTE]\n无法根据来源安全确定事项归属时，优先结合上下文区分职责外闲聊与需要发问的具体信息缺口；待判须提供 deferred:{reason,scope:[{topicId,revision}],clarification:{question,assignmentQuote,replyReview}}，scope 只可选本请求已见话题及版本，不得猜测；无法明确范围时说明不确定原因，Host按策略处置，不生成任务或回复；该消息不提交 units、ignoredRefs 或 topics；已能确认具体事项或本次事件及连续承接时，项目或页面名称未知、未交办助手、执行细节缺失或图片读取失败，不能单独作为 deferred 理由；按已证事实归入本次事项，未知身份和未核实的同事报告如实保留。相同症状不能证明是同一次事故，缺少同一事件依据时不要续接旧事故。首包 recentMessages 已完整提供的正文可以直接使用，越界重复补读被拒不代表正文不可见。明确向助手提出的停止、取消、别部署可能约束在途任务时，不得猜测或执行取消；只在能够确定范围时提交澄清。不要仅因附件未读就假设存在取消。需要向原作者询问时提交 clarification:{question,assignmentQuote,replyReview}，assignmentQuote 必须唯一匹配原文并指明待澄清内容，不代表已确认业务交办；replyReview 必须按 clarificationReviewCandidates 完整审阅且 kind=substantive、不替换旧通知；如果给出 clarificationReviewReadCall，须沿 nextOffset 读完全部候选后才能提交澄清；普通同事讨论不得主动追问。\n${fixedTopicsEnabled ? fixedTopicInstructions + '\n' : ''}Topic 请求：${JSON.stringify(envelope)}\n消息和候选的 shortRef 可在本请求的 messageId 或 topicId 字段中代替对应完整ID；仍须填写原版本，不能用于其他请求。所选或比较的候选若 hasUnsummarized 为 true，须按 unsummarizedReadCall 连续读完固定历史再提交；这些历史不是新授权。消息包含 metadataReadCall 时必须沿 nextOffset 读完冻结元数据后再提交；目录按 group_topic_list 相同顺序分页，nextTopicOffset 是下一页 offset；relatedTopics 是引用及关联任务命中的首包，recallSources 说明来源；recalledTopics 是有限词面候选，matchedQueries 不是同一事项的证明。必要时使用 group_topic_list 的 queries 多词检索，比较业务目标后决定复用或新建，${!workflowPromptsEnabled ? '每个 Topic target 必填本来源的 reason；新建事项在顶层 newTopics 中用 newTopicKey、title、candidateComparisons 定义一次，各 unit 的 topics 显式引用该 newTopicKey 和各自 reason。已见候选时定义内比较至少填写一个已见 topicId、revision 和排除理由；引用代表该比较适用于此来源，不同事项或排除依据不能合并，不得猜造候选；' : '每个 Topic target 必填 reason；新建且已见候选时 candidateComparisons 至少填写一个已见 topicId、revision 和排除理由，不得猜造候选；'}hasMoreRelatedTopics 时必须用 group_topic_list 携带本 requestId 和 nextRelatedTopicOffset 继续读取全部关系。无法判断旧事项归属时先检索或分页读取目录，不能因首包无候选直接新建。先判断当前消息是否涉及具体事项或任务。日常寒暄、随口聊天、没有具体事项对象的情绪表达或泛泛感谢，不新建 Topic，也不为了归档闲聊强行关联已有 Topic；${fixedTopicsEnabled ? '纯闲聊使用 fixedTopic="out-of-scope"，完整引用来源并保持沉默' : '将这些原文放入 ignoredRefs 并说明“日常闲聊，无具体事项”，纯闲聊提交 units=[]'}。消息混有闲聊和具体事项时，仅将事项拆为 units，闲聊部分放入 ignoredRefs，完整覆盖原文。明确涉及具体问题、需求、调查、执行、结果、验收或后续跟进时，按共同业务事项和目标聚合Topic，不逐功能点拆分。同次交办、共享上下文且适合整体交付的多个需求项保持在同一Topic；不能仅因可独立验收、补充或实现就拆开。结合本批原文、引用、候选的目标/需求摘要判断；需要消解“这个也是”等承接时再按现有readCall读取相关近期原文，不读取全执行历史。在符合本群职责的业务事项内优先复用同一事项的已有Topic，后续截图、验收和交付要求沿原事项补充。${fixedTopicsEnabled ? '话题归属与助手动作分开判断：职责内具体事项无论交给谁处理，都保留在对应业务 Topic；他人负责、状态通知或同事信息引用不是转入职责外话题或丢弃原文的理由。是否需要本助手动作或回复由 Topic Decision 再判断，不把归属或状态通知当成新授权。' : '不要用是否出现“任务”等关键词或是否要求助手执行判断事项：群成员讨论具体问题也可形成话题；“谢谢，那个问题修好了”、引用任务后的“收到”“继续”等需结合引用和上下文归入原事项，不能当作闲聊丢掉。'}同一页面或截图只是上下文线索，不是强制合并边界；确有不同业务目标或独立交付约定时可分Topic，共同领域也不能替代目标判断。先定事项归属再划分units；同一事项的多个需求项可用一个unit完整引用，也可按来源需要保留多个unit归同一Topic。每个 unit 提供稳定 unitKey、简短 summary、能在当前消息原文中唯一定位的 sourceRefs.quote、共享约束 contextRefs 和 topics，并由 effectOwner 指定唯一动作主归属；contextRefs.quote 也只能引用当前消息 text 中唯一出现的片段，quotedMessage 是单独提供的背景，不要把被引用消息的正文填入 contextRefs。其余非空原文必须放入 ignoredRefs 并说明原因。纯背景不得冒充事项；需要查询历史资料时不得把资料来源 Topic 加入归属，可以检索资料后只处理当前请求。通过 group_topic_route_submit 一次完整提交本批消息；需要初步回复时在 initialReplies 按具体消息版本、unitKey 和所属 Topic 提交结构化草稿及完整回复审阅，逐 Topic 绑定真实来源；只能说明初步理解、缺失信息与下一步，不得声称原因已确认、任务已创建或完成、问题已修复；不得替换旧回复。Host 审阅后负责发送，你不得执行任务或直接回复群聊。${reason ? `这是归属复核：${reason}` : ''}`, messages.flatMap((message) => message.imageRefs ?? []).concat(request.recoveryImages), request)
    request.routeReady = true
    monitor(agent, request, routes)
    return envelope
    } catch (error) {
      if (routes.get(request.requestId) === request) routes.delete(request.requestId)
      throw error
    }
  }
  function dispatchRouteUpdate(request) {
    const groupId = request.groupId
    const id = `message-${request.requestId}-batch-${request.batchRevision}-exposure-${++request.exposureAttempt}`
    const text = request.batchUpdateText
    const message = Object.freeze({ ...textMessage(text, request.messages.flatMap(item => item.imageRefs ?? []).concat(request.recoveryImages)), id })
    request.batchUpdateMessage = message
    request.batchDispatchFailed = false
    const agent = getAgent(groupId, request)
    if (dispatchRequest) {
      const pending = Promise.resolve().then(() => dispatchRequest(request, message, { inFlightRouteUpdate: true }))
      activeToolCalls.add(pending)
      pending.then(() => activeToolCalls.delete(pending), error => { activeToolCalls.delete(pending); if (request.batchUpdateMessage?.id === id) request.batchDispatchFailed = true; onError(groupId, error) })
    } else agent.steer(message)
  }
  function updateRouteBatch(request, batch) {
    request.messages = structuredClone(batch.map(({ facts, ...message }) => message))
    request.batchRevision++
    prepareRecoveryBoundary(request, store.getGroup(request.groupId))
    request.exposureAttempt = 0
    request.metadataPages = new Map()
    request.clarificationReviewCandidates = reviewCandidates(request.groupId, request.messages, [])
    request.clarificationReviewText = JSON.stringify(request.clarificationReviewCandidates)
    const inlineCandidates = request.clarificationReviewText.length <= 6_000
    request.batchCandidatesInline = inlineCandidates
    request.clarificationReviewOffset = inlineCandidates ? request.clarificationReviewText.length : 0
    request.batchVisibleText = new Map()
    const messages = request.messages.map(message => {
      const { text, ...metadata } = message
      const metadataText = JSON.stringify(metadata)
      const projected = metadataText.length <= 2_000 ? metadata : { messageId: message.messageId, messageVersion: message.messageVersion,
        metadataReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, messageId: message.messageId, section: 'messageMetadata', offset: 0 } } }
      if (metadataText.length > 2_000) request.metadataPages.set(message.messageId, { text: metadataText, offset: 0 })
      const visible = text.slice(0, 1_000)
      request.batchVisibleText.set(message.messageId, visible.length)
      request.readOffsets.set(message.messageId, visible.length)
      return { ...projected, text: visible, ...(visible.length < text.length ? { textOffset: 0, textTotal: text.length, textHasMore: true } : {}) }
    })
    const group = store.getGroup(request.groupId)
    const allTopics = store.listTopics(request.groupId).filter(topic => !topic.mergedInto)
    const referencedIds = new Set(request.messages.flatMap(message => [message.messageId, message.quotedMessage?.messageId]).filter(Boolean))
    const relatedIds = new Set(allTopics.filter(topic => {
      const active = new Map(topic.entries.map(entry => [entry.unitId ?? entry.messageId, entry]))
      return [...active.values()].some(entry => entry.action === 'add' && referencedIds.has(entry.messageId))
    }).map(topic => topic.topicId))
    for (const reply of group.outbox.filter(outbound => outbound.deliveredMessageId && referencedIds.has(outbound.deliveredMessageId))) {
      if (reply.replyTopicId) relatedIds.add(reply.replyTopicId)
      else for (const ref of reply.topicRefs ?? []) relatedIds.add(ref.topicId)
    }
    const directIds = new Set(relatedIds)
    const linkedTasks = store.listTasks().filter(task => task.groupId === request.groupId && task.topicRefs.some(ref => relatedIds.has(ref.topicId)))
    for (const task of linkedTasks) for (const ref of task.topicRefs) relatedIds.add(ref.topicId)
    request.relatedTopics = topicIndex(allTopics.filter(topic => relatedIds.has(topic.topicId)).map(topic => ({ ...topic,
      recallSources: [...(directIds.has(topic.topicId) ? ['reference'] : []), ...(linkedTasks.some(task => task.topicRefs.some(ref => ref.topicId === topic.topicId)) ? ['task'] : [])] })))
    const relatedTopics = boundedItems(request.relatedTopics.map(topic => ({ ...topic, shortRef: request.shortReferences.add('topic', topic.topicId) })), 3_000, 20)
    const recallQueries = routeRecallQueries(request.messages)
    const recalledTopics = boundedItems(topicMatches(allTopics.filter(topic => !relatedIds.has(topic.topicId)), recallQueries)
      .map(({ topic, matchedQueries }) => ({ ...topicIndex([topic])[0], matchedQueries, shortRef: request.shortReferences.add('topic', topic.topicId) })), 1_500, 20)
    for (const item of [...relatedTopics, ...recalledTopics]) {
      request.shortReferences.expose(item.shortRef)
      request.seenTopicVersions.set(item.topicId, item.revision)
      request.seenTopicSnapshots.set(item.topicId, { kind: 'index', value: routeCandidateSnapshot(item) })
    }
    const aliases = referencedPersonAliases(group, request.messages)
    const envelope = { requestId: request.requestId, batchRevision: request.batchRevision, messages, relatedTopics, recalledTopics, recallQueries,
      totalRelatedTopics: request.relatedTopics.length, hasMoreRelatedTopics: relatedTopics.length < request.relatedTopics.length, nextRelatedTopicOffset: relatedTopics.length,
      ...(aliases.length ? { personAliases: aliases, personAliasGuide: personAliasInstructions } : {}),
      ...(request.recoveryBoundary.length ? { recoveryBoundaryReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'recoveryBoundary', offset: 0 } } } : {}),
      ...(inlineCandidates ? { clarificationReviewCandidates: request.clarificationReviewCandidates } : {
        clarificationReviewCandidateCount: request.clarificationReviewCandidates.length,
        clarificationReviewReadCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'clarificationReviewCandidates', offset: 0 } },
      }) }
    request.batchUpdateText = `[GROUP_TOPIC_ROUTE_UPDATE]\n批次已有新来源；本次完整覆盖以下消息并提交 batchRevision，按原要求补读截断正文、元数据和审阅候选，继续在同一请求中分诊。\nTopic 请求：${JSON.stringify(envelope)}`
    dispatchRouteUpdate(request)
  }
  function routeUpdateVisible(request) {
    const agent = getAgent(request.groupId, request), message = request.batchUpdateMessage
    const pending = [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].some(item => item.id === message.id)
    const visible = agent?.session?.deriveMessages
      ? agent.session.deriveMessages().some(item => item.id === message.id && item.role === 'user' && isDeepStrictEqual(item.content, message.content))
      : agent?.session?.snapshotEvents?.().some(event => event.type === 'user/message' && event.data?.id === message.id && isDeepStrictEqual(event.data.content, message.content))
    return { agent, message, pending, visible }
  }
  function missingRouteUpdateReads(request) {
    if (!request.batchRevision) return
    const agent = getAgent(request.groupId, request)
    if (!agent?.session?.deriveMessages) return
    const outputs = visibleToolOutputs(agent).filter(page => page.requestId === request.requestId)
    const covered = (text, pages, start) => {
      let offset = start
      while (true) {
        const next = Math.max(offset, ...pages.filter(page => Number.isInteger(page.offset) && Number.isInteger(page.nextOffset)
          && page.offset <= offset && page.nextOffset > page.offset && text.slice(page.offset, page.nextOffset) === page.text).map(page => page.nextOffset))
        if (next === offset) return offset
        offset = next
      }
    }
    for (const message of request.messages) {
      const metadata = request.metadataPages.get(message.messageId)
      if (metadata) {
        const pages = outputs.filter(page => page.section === 'messageMetadata' && page.messageId === message.messageId)
        const offset = covered(metadata.text, pages, 0)
        if (offset < metadata.text.length) {
          metadata.offset = offset
          return { status: 'context-required', error: 'topic_route_metadata_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, messageId: message.messageId, section: 'messageMetadata', offset } } }
        }
      }
      const pages = outputs.filter(page => page.messageId === message.messageId && page.messageVersion === message.messageVersion && Number.isInteger(page.textOffset))
        .map(page => ({ ...page, offset: page.textOffset }))
      const offset = covered(message.text, pages, request.batchVisibleText.get(message.messageId))
      if (offset < message.text.length) {
        request.readOffsets.set(message.messageId, offset)
        return { status: 'context-required', error: 'topic_route_source_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, messageId: message.messageId, offset } } }
      }
    }
  }
  function createTitleMigrationRequest(groupId, topic) {
    const request = { requestId: requestIdentity('title', { groupId, topicId: topic.topicId, title: topic.title, summary: topic.summary }), groupId, topicId: topic.topicId, expectedTitle: topic.title, expectedSummary: topic.summary }
    titleMigrations.set(request.requestId, request)
    const agent = send(groupId, `[GROUP_TOPIC_TITLE_MIGRATION]\nTopic 请求：${JSON.stringify({ requestId: request.requestId, topicId: topic.topicId, summary: topic.summary })}\n仅根据 summary 理解话题核心，生成一个像任务名称的简短标题：采用“对象 + 事项”，建议 8–20 个字符，最多 ${TOPIC_TITLE_MAX_CHARS} 个字符。必须重新概括，不能截取 summary 前缀或省略号截断。通过 group_topic_title_submit 提交；不执行任务、不回复群聊。`, [], request)
    monitor(agent, request, titleMigrations)
    return request
  }
  function createSummaryMigrationRequest(groupId, topic) {
    const messages = topicMessages(groupId, topic.topicId, topic.revision)
    const request = { requestId: requestIdentity('summary', { groupId, topicId: topic.topicId, revision: topic.revision, summary: topic.summary }), groupId, topicId: topic.topicId, expectedRevision: topic.revision, expectedSummary: topic.summary }
    summaryMigrations.set(request.requestId, request)
    const envelope = { requestId: request.requestId, topicId: topic.topicId, revision: topic.revision, messages: messages.slice(-50), totalMessages: messages.length }
    const agent = send(groupId, `[GROUP_TOPIC_SUMMARY_MIGRATION]\nTopic 请求：${JSON.stringify(envelope)}\n根据这个 Topic 的引用消息生成独立 summary，概括讨论对象、当前结论、范围和仍需处理的事项，不复制长段原文，不生成标题。通过 group_topic_summary_submit 提交；消息超过 50 条时先用 group_topic_context_get 分页读取完整固定版本。不执行任务、不回复群聊。`, [], request)
    monitor(agent, request, summaryMigrations)
    return request
  }
  async function wake(groupId) {
    if (!live() || groupsBeingChanged.has(groupId) || !getAgent(groupId) || !store.getGroup(groupId)) return []
    await store.reconcileMessageDeliveries({ groupId })
    const group = store.getGroup(groupId)
    if (!group) return []
    const pending = pendingInput(groupId)
    const routable = routableInput(groupId)
    for (const [id, request] of routes) {
      if (request.groupId !== groupId) continue
      if (request.messages.some(message => group.messages.some(current => current.messageId === message.messageId && current.ownNotificationRetirement))) {
        supersedeRequest(request, 'own-notification', 'own-notification-retired')
        routes.delete(id)
      } else if (request.exhausted && !sameVersions(request.messages, routable)) routes.delete(id)
    }
    const activeRoute = [...routes.values()].find(request => request.groupId === groupId)
    if (activeRoute?.routeReady && !activeRoute.exhausted && !activeRoute.reason && routable.length) {
      const batch = activeRouteBatch(activeRoute, routable, pending)
      const retained = activeRoute.messages.every(message => batch.some(item => item.messageId === message.messageId
        && item.messageVersion === message.messageVersion && (item.routingEpoch ?? 0) === (message.routingEpoch ?? 0)))
      if (!retained) {
        routes.delete(activeRoute.requestId)
        void supersedeRequest(activeRoute, 'routing-batch-changed', 'routing-batch-changed')
      } else {
        if (routeGroupBaseline(group) === activeRoute.routeGroupBaseline) activeRoute.routingRevision = group.routingRevision
        if (batch.length > activeRoute.messages.length || !isDeepStrictEqual(activeRoute.recoveryBoundary, routingRecoveryBoundary(group, batch.map(message => message.messageId)))) updateRouteBatch(activeRoute, batch)
      }
    }
    if (routable.length && ![...routes.values()].some((request) => request.groupId === groupId)) {
      const batch = routeBatch(routable, pending)
      if (batch.length) await createRouteRequest(groupId, batch)
    }
    const metadataMigrationPending = [...summaryMigrations.values(), ...titleMigrations.values()].some((request) => request.groupId === groupId)
    if (!metadataMigrationPending) {
      const topics = store.listTopics(groupId)
      const longTitle = topics.find((topic) => topic.title.length > TOPIC_TITLE_MAX_CHARS && topic.summary?.trim())
      if (longTitle) createTitleMigrationRequest(groupId, longTitle)
      else {
        const missingSummary = topics.find((topic) => topic.processedRevision >= topic.revision && !topic.summary.trim() && topic.revision > 0
          && (workflowPromptsEnabled || !topic.decisions.some(record => record.revision > topic.summaryRevision && record.revision <= topic.revision)))
        if (missingSummary) createSummaryMigrationRequest(groupId, missingSummary)
      }
    }
    const result = []
    for (const topic of store.listTopics(groupId)) {
      const commit = unfinished(topic)
      if (!commit && initialReplyPending(groupId, topic.topicId)) continue
      if (commit) {
        if (commit.status === 'blocked' || decisionPersistenceFaults.has(commit.decisionId)) continue
        const due = commit.nextRetryAt ? Date.parse(commit.nextRetryAt) : 0
        if (due <= Date.now()) resume(groupId, topic.topicId, commit.decisionId)
        else armDecisionRetry(groupId, commit.decisionId, due)
      } else if (topic.processedRevision < topic.revision) {
        const request = await createDecisionRequest(groupId, topic)
        result.push(request)
        if (!pendingFor(groupId, [topic.topicId]).length && request.retryAfterRouting && !request.retryingAfterRouting) {
          // 草稿未被接纳；路由完成后重新走完整校验，不让模型重算同一份决策。
          const retry = request.retryAfterRouting
          request.retryAfterRouting = undefined
          request.retryingAfterRouting = true
          const work = Promise.resolve().then(() => live() && decisions.get(request.requestId) === request ? retry() : undefined).catch(error => onError(groupId, error)).finally(() => {
            activeToolCalls.delete(work)
            request.retryingAfterRouting = false
            if (live() && decisions.get(request.requestId) === request && !request.retryAfterRouting) {
              request.routingPaused = false
              const agent = getAgent(groupId, request)
              if (agent) monitor(agent, request, decisions)
              else { request.dispatchState = 'pending'; request.dispatch() }
            }
          })
          activeToolCalls.add(work)
        }
      } else if (taskFacts && !pendingFor(groupId, [topic.topicId]).length && !topic.mergedInto && topic.revision > 0) {
        const active = [...decisions.values()].find(request => request.groupId === groupId && request.topicId === topic.topicId)
        if (!active) {
          const context = await taskFacts.context(groupId, topic)
          if (context) {
            const requestId = requestIdentity('decision', { groupId, topicId: topic.topicId, revision: topic.revision,
              factIds: context.eventIds, generation: context.generation, summary: topic.summary, replySnapshot: context.replySnapshot, taskSnapshot: context.taskSnapshot })
            const request = { requestId, groupId, topicId: topic.topicId, revision: topic.revision, trigger: 'task-facts',
              factContext: context, messages: [], removedUnitRefs: [], removedMessageIds: [], candidates: [],
              readUnitRefs: new Set(), readSectionOffsets: new Map(), sections: {},
              topicRefs: [{ topicId: topic.topicId, revision: topic.revision }] }
            const summaryContext = topic.summaryRevision < topic.revision ? topicSummaryContext(store.getGroup(groupId), topic) : undefined
            if (summaryContext) request.sections.summary = JSON.stringify(summaryContext)
            decisions.set(requestId, request)
            const envelope = { requestId, topicId: topic.topicId, revision: topic.revision, trigger: 'task-facts', ...context.input,
              summaryRevision: topic.summaryRevision, hasUnsummarized: !!summaryContext,
              ...(summaryContext ? { summaryContext: { readCall: { name: 'group_decision_context_get', arguments: { requestId, section: 'summary', offset: 0 } } } } : {}) }
            const body = `[GROUP_TOPIC_DECISION]\nTopic 请求：${JSON.stringify(envelope)}\n${summaryContext ? '必须沿summaryContext的readCall完整读取未汇总历史；历史不构成新动作授权。\n' : ''}本轮是任务事实，不是用户新请求。needs-input且audience=topic时，统筹交来的是协调请求：核对目标、证据、阻塞和可选路线，结合原话题上下文判断应联系请求者、基础设施负责人或其他适合的人，不能默认发起人、最近发言者或atAll。用现有reply及结构化提及在本话题原群沟通；信息不足先沿readCall补读，不猜身份。后续收到真实答复时结合问题、作者职责及限制解读，通过原Task的task-context回流统筹，不新建任务、不代为扩权，不仅回一句收到。完成事实中的files是Host已冻结的最终附件；结合最新上下文说明完成范围、实际部署环境和验收结果。非空最终回复之后，Host将连续发送该批附件并逐件记录回执，自动附上文件名与验收对应说明，不必另派任务或让执行单独群发。文件存在、业务完成和通知送达分别表述，不提前宣称附件已经送达；已送历史仅引用原记录，不重复发送。结合最新补充、相关任务和已发/待发回复，决定直接回复、合并这些结果或沉默。actions 必须为空；不创建、补充、重开或取消任务。提交 group_decision_submit：decision 包含 actions:[]、topicUpdate.summary、reason，可选 reply。有reply时显式选择atOpenDingTalkIds；本次明确面向全群时选择atAll=true并省略成员提及和引用。最终事实通知固定使用普通Markdown群消息与所选多人原生提及，不使用原生引用，避免引用隐式提及和显式提及叠加；省略replyToMessageId。保留事实中已核验的PR及产物完整链接，用Markdown链接和清晰段落列表组织，不降为只有编号，不按编号猜URL；配置签名由Host添加。旧决策中的上下文来源仍会校验并留档，但不会转换成发送引用，不因来源作者改变通知集合。结合原始需求、验收反馈、明确交付或知会约定选择本次结果的收件人集合，可多人。sources是任务事实的触发来源，不是默认收件人；最近补充者、恢复条件提供者或截图要求者不自动替换原需求人和验收人。originMessages、recentMessages提供本话题原文及受信ID；不足时沿readCall读取相关话题原文，不读取全执行历史。按ID区分同名/近似名，不猜ID，不自动@所有历史参与者，身份不确定时不伪装通知。正文不要用@姓名代替原生提及；Host校验并冻结所选身份，经现有通知路径投递。reason解释回复或沉默及收件人选择依据。不使用 basisMessageIds/replyReview。不得把任务事实当新授权。通常无需额外读取；确需完整事实可用 group_decision_context_get 的 facts section。`
            context.metrics.inputBytes = Buffer.byteLength(body, 'utf8')
            taskFacts.observe?.(context.metrics)
            monitor(send(groupId, body, [], request), request, decisions)
          }
        }
      }
    }
    resumePausedDecisionMonitors(groupId)
    if (pending.length || result.length) onInputSettled?.(groupId)
    return result.map(({ requestId, topicId, revision, messages, candidates, removedUnitRefs, removedMessageIds, visibleMessages, readUnitRefs }) => {
      const topic = store.getTopic(groupId, topicId)
      const deltaIds = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= revision).map(unitKey))
      const omittedDeltaUnitRefs = messages.filter((message) => deltaIds.has(unitKey(message)) && !readUnitRefs.has(unitKey(message))).map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      return { requestId, topicId, revision, removedUnitRefs, removedMessageIds, omittedDeltaUnitRefs, omittedDeltaMessageIds: [...new Set(messages.filter((message) => deltaIds.has(unitKey(message)) && !readUnitRefs.has(unitKey(message))).map((message) => message.messageId))], ...effectOwnership(groupId, topicId, revision, visibleMessages), replyReviewCandidateCount: candidates.length, messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: visibleMessages.length < messages.length }
    })
  }
  function schedule(groupId) {
    if (!live()) return Promise.resolve([])
    if (scheduled.has(groupId)) { scheduleAgain.add(groupId); return scheduled.get(groupId) }
    const promise = Promise.resolve().then(async () => {
      let result
      do { scheduleAgain.delete(groupId); result = await wake(groupId) } while (scheduleAgain.has(groupId) && live())
      return result
    }).catch((error) => { onError(groupId, error); return [] }).finally(() => { scheduleAgain.delete(groupId); scheduled.delete(groupId) })
    scheduled.set(groupId, promise)
    return promise
  }
  function resumePausedDecisionMonitors(groupId) {
    for (const request of decisions.values()) {
      if (request.groupId !== groupId || !request.routingPaused || request.retryAfterRouting || request.retryingAfterRouting || pendingFor(groupId, request.topicId ? [request.topicId] : []).length) continue
      request.routingPaused = false
      monitor(getAgent(groupId, request), request, decisions)
    }
  }
  function armDecisionRetry(groupId, decisionId, due) {
    if (!live() || retryTimers.has(decisionId)) return
    const timer = setTimeout(() => {
      timers.delete(timer); retryTimers.delete(decisionId)
      if (live()) schedule(groupId)
    }, Math.max(0, due - Date.now()))
    timer.unref?.(); timers.add(timer); retryTimers.set(decisionId, timer)
  }
  function resume(groupId, topicId, decisionId) {
    if (applying.has(decisionId)) return applying.get(decisionId).promise
    let activeOperation
    const promise = (async () => {
      let record = store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
      if (!record || !isPendingDecision(record) || record.status === 'blocked') return record
      if ((record.decision.basisUnitRefs ?? []).some(ref => sourceDispatchOwnershipFor(store.getGroup(groupId), ref)?.dispatchOwner === 'coordination')) {
        return store.updateTopicDecision({ groupId, topicId, decisionId, patch: { status: 'blocked', error: 'source_dispatch_owned_by_coordination' } })
      }
      if ((record.attempt ?? 0) - (record.retryBaseAttempt ?? 0) >= 3) {
        return store.updateTopicDecision({ groupId, topicId, decisionId, patch: { status: 'blocked', nextRetryAt: undefined, error: 'decision_attempts_exhausted', failureOperationId: record.operations.find(item => item.status !== 'applied')?.operationId ?? record.outboundId } })
      }
      if (await store.rejectInvalidTopicDecision({ groupId, topicId, decisionId })) return store.getTopic(groupId, topicId).decisions.find(item => item.decisionId === decisionId)
      record = await store.updateTopicDecision({ groupId, topicId, decisionId, patch: { status: 'applying', error: undefined, attempt: (record.attempt ?? 0) + 1, nextRetryAt: undefined } })
      record = store.getTopic(groupId, topicId).decisions.find(item => item.decisionId === decisionId)
      if (!isPendingDecision(record)) return record
      const decision = record.decision
      for (const action of decision.actions) if (action.kind === 'task-cancel') cancelTask(action.taskId)
      for (let index = 0; index < record.operations.length; index++) {
        record = store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
        if (!isPendingDecision(record)) return record
        const operation = record.operations[index]
        if (operation.status === 'applied') continue
        activeOperation = operation
        if (operation.status === 'blocked') throw new Error('decision_operation_reconciliation_required')
        if (store.getTask(operation.taskId)?.appliedOperations?.includes(operation.operationId)) {
          await store.updateTopicDecision({ groupId, topicId, decisionId, patch: { operations: record.operations.map((item, at) => at === index ? { ...item, status: 'applied', reconciled: true } : item) } })
          continue
        }
        await store.updateTopicDecision({ groupId, topicId, decisionId, patch: { operations: record.operations.map((item, at) => at === index ? { ...item, status: 'applying', attempt: (item.attempt ?? 0) + 1 } : item) } })
        await applyAction(groupId, record.decision.actions[operation.actionIndex], operation, record)
        record = store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
        if (!isPendingDecision(record)) return record
        await store.updateTopicDecision({ groupId, topicId, decisionId, patch: {
          operations: record.operations.map((item, at) => at === index ? { ...item, status: 'applied' } : item),
        } })
      }
      record = store.getTopic(groupId, topicId).decisions.find(item => item.decisionId === decisionId)
      if (!isPendingDecision(record)) return record
      // 回复可能声明任务已承接；必须先确认全部动作落账。失败恢复沿原 operationId 对账。
      activeOperation = undefined
      if (decision.reply?.trim()) {
        const messages = topicMessages(groupId, topicId, record.revision).filter(message => {
          const owner = replyTopicForMessage(store.getGroup(groupId), message)
          return !owner || owner === topicId
        })
        const frozen = await readFrozenReply?.({ groupId, topicRefs: [{ topicId, revision: record.revision }], decisionId, outboundId: record.outboundId })
          ?? store.getGroup(groupId)?.outbox.find(item => item.outboundId === record.outboundId)
        if (!frozen && !Object.hasOwn(decision, 'atOpenDingTalkIds') && !decision.atAll) throw new Error('group_reply_routing_reconciliation_required')
        const route = frozen ? { replyToMessageId: frozen.replyToMessageId, replyToSenderOpenDingTalkId: frozen.replyToSenderOpenDingTalkId, atOpenDingTalkIds: frozen.atOpenDingTalkIds ?? [], ...(frozen.atAll ? { atAll: true } : {}) }
          : (() => { const { target, recipients, atAll } = replyRouting(messages, decision.replyToMessageId, decision.atOpenDingTalkIds, decision.atAll); return { ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.senderOpenDingTalkId } : {}), atOpenDingTalkIds: recipients, ...(atAll ? { atAll } : {}) } })()
        const persisted = await appendOutbox({ groupId, sourceMessageId: `topic-decision:${decisionId}`, outboundId: record.outboundId, decisionId,
          topicRefs: [{ topicId, revision: record.revision }], text: decision.reply, replyKind: decision.replyReview?.kind,
          matterSourceMessageIds: [...new Set(messages.filter((message) => decision.basisUnitRefs.some((ref) => unitKey(ref) === unitKey(message))).map((message) => message.messageId))],
          matterUnitRefs: decision.basisUnitRefs.filter(ref => messages.some(message => unitKey(ref) === unitKey(message))),
          taskIds: record.operations.map((operation) => operation.taskId).filter(Boolean), replacesOutboundIds: decision.replyReview?.replaceOutboundIds,
          ...route })
        if (persisted?.status) throw new Error(`topic_outbox_${persisted.status}`)
      }
      await store.completeTopicDecision({ groupId, topicId, decisionId, ...decision.topicUpdate })
      onInputSettled?.(groupId)
      retries.delete(decisionId)
      const retryTimer = retryTimers.get(decisionId)
      if (retryTimer) { clearTimeout(retryTimer); timers.delete(retryTimer); retryTimers.delete(decisionId) }
      return store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
    })().catch(async (error) => {
      const current = store.getTopic(groupId, topicId).decisions.find(item => item.decisionId === decisionId)
      const action = activeOperation && current.decision.actions[activeOperation.actionIndex]
      const reconciled = activeOperation && store.getTask(activeOperation.taskId)?.appliedOperations?.includes(activeOperation.operationId)
      const localRetry = (!activeOperation || ['new-task', 'task-context', 'task-reopen', 'task-cancel'].includes(action?.kind)) && error.code === 'storage_transient'
      const canRetry = (reconciled || localRetry) && (current.attempt ?? 0) - (current.retryBaseAttempt ?? 0) < 3
      const due = Date.now() + retryDelayMs
      try {
        await store.updateTopicDecision({ groupId, topicId, decisionId, patch: {
          status: canRetry ? 'failed' : 'blocked', error: error.message ?? String(error), failureOperationId: activeOperation?.operationId ?? current.outboundId, nextRetryAt: canRetry ? new Date(due).toISOString() : undefined,
          operations: current.operations.map(item => item.operationId !== activeOperation?.operationId ? item : { ...item, status: reconciled ? 'applied' : canRetry ? 'pending' : 'blocked', lastError: error.message ?? String(error), ...(reconciled ? { reconciled: true } : {}) }),
        } })
      } catch (storageError) { decisionPersistenceFaults.add(decisionId); onError(groupId, storageError); return }
      onError(groupId, error)
      if (canRetry) armDecisionRetry(groupId, decisionId, due)
    }).finally(() => { applying.delete(decisionId); if (live()) schedule(groupId) })
    applying.set(decisionId, { groupId, promise })
    return promise
  }
  function validateBasis(request, decision, archivedTasks) {
    const topic = store.getTopic(request.groupId, request.topicId)
    const delta = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= request.revision).map(unitKey))
    const agent = getAgent(request.groupId, request)
    if (!request.statusQueryRead && agent?.session?.deriveMessages) {
      const inlineVisible = request.inlineDelta && visibleCoordinatorText(agent, request.text)
      const sectionVisible = visibleRequestSectionLength(agent, request.sections.messages, request.requestId, 'messages') === request.sections.messages.length
      const topicPages = visibleToolOutputs(agent).filter(output => output.requestId === request.requestId && output.topic?.topicId === request.topicId && output.topic?.revision === request.revision)
      const visibleUnits = new Set()
      for (const message of request.messages) {
        const text = String(message.text ?? '')
        const chunks = topicPages.flatMap(page => page.messages ?? []).filter(item => unitKey(item) === unitKey(message) && typeof item.text === 'string'
          && text.slice(item.textOffset ?? 0, (item.textOffset ?? 0) + item.text.length) === item.text)
        let offset = 0
        while (true) {
          const next = Math.max(offset, ...chunks.filter(item => (item.textOffset ?? 0) <= offset).map(item => (item.textOffset ?? 0) + item.text.length))
          if (next === offset) break
          offset = next
        }
        if (chunks.length && offset === text.length) visibleUnits.add(unitKey(message))
      }
      if (inlineVisible || sectionVisible || visibleUnits.size) request.surfaceTracked = true
      for (const message of request.messages) if (delta.has(unitKey(message))) {
        if (inlineVisible || sectionVisible || visibleUnits.has(unitKey(message))) request.readUnitRefs.add(unitKey(message))
        else request.readUnitRefs.delete(unitKey(message))
      }
      for (const section of request.requiredSections) request.readSectionOffsets.set(section, section === 'summary' && request.inlineSummary && visibleCoordinatorText(agent, request.text) ? request.sections.summary.length : visibleRequestSectionLength(agent, request.sections[section], request.requestId, section))
    }
    const unreadDelta = request.messages.filter((message) => delta.has(unitKey(message)) && !request.readUnitRefs.has(unitKey(message)))
    if (unreadDelta.length) throw new Error('topic_decision_delta_unread')
    const unreadSection = [...request.requiredSections].find((section) => (request.readSectionOffsets.get(section) ?? 0) < request.sections[section].length)
    if (unreadSection) throw Object.assign(new Error('topic_decision_context_unread'), { contextRequired: { status: 'context-required', error: 'topic_decision_context_unread', nextCall: { name: 'group_decision_context_get', arguments: { requestId: request.requestId, section: unreadSection, offset: request.readSectionOffsets.get(unreadSection) ?? 0 } } } })

    const issues = collectDecisionIssues(request, decision, { store, delta, ownership: effectOwnership(request.groupId, request.topicId, request.revision, request.messages), unitKey, archivedTasks, workflowPromptsEnabled })
    if (issues.length) { const error = new Error(issues[0].message); error.issues = issues; throw error }
  }
  const presentationCurrent = request => {
    const topic = store.getTopic(request.groupId, request.topicId)
    return topic && request.presentationFingerprint === fingerprint({ summary: topic.summary, summaryRevision: topic.summaryRevision, openQuestions: topic.openQuestions })
  }
  const inlineDecisionCurrent = request => {
    if (request.statusQueryRead) return true
    const snapshot = request.inlineDecisionSnapshot
    const agent = getAgent(request.groupId, request)
    const messages = agent?.session?.deriveMessages?.() ?? []
    const calls = new Map(messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool-call').map(block => [block.id, block.name]))
    const visibleReads = messages.filter(message => message.role === 'tool' && !message.isError && calls.get(message.toolCallId) === 'group_task_context_get').flatMap(message => {
      try {
        const result = JSON.parse((message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'))
        const read = request.taskContextReads?.get(result.readId)
        return read && read.fingerprint === fingerprint(result) ? [read] : []
      } catch { return [] }
    })
    const visibleReview = messages.filter(message => message.role === 'tool' && !message.isError && calls.get(message.toolCallId) === 'group_reply_review_get').some(message => {
      try {
        const result = JSON.parse((message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'))
        return request.reviewReadFingerprints?.get(fingerprint(result)) === fingerprint(request.candidates)
      } catch { return false }
    })
    if (agent?.session?.deriveMessages && !request.statusQueryRead) request.readReview = visibleReview || visibleReads.some(read => read.reviewFingerprint === fingerprint(request.candidates))
    if (!snapshot) return true
    const inlineVisible = visibleCoordinatorText(agent, request.text)
    if (inlineVisible && snapshot.reviewFingerprint === fingerprint(request.candidates)) request.readReview = true
    const task = store.getTask(snapshot.taskId)
    if (!task || task.groupId !== request.groupId || task.archivedAt) return false
    const current = taskDecisionView(task)
    return inlineVisible && snapshot.requestId === request.requestId && snapshot.versionRequestId === request.versionRequestId && snapshot.revision === request.revision && sameJson(snapshot.taskText, current)
      || visibleReads.some(read => read.tasks.some(item => item.taskId === snapshot.taskId && sameJson(item.text, current)))
  }
  function readReplyReview(groupId, requestIds, compact = false) {
    if (typeof compact !== 'boolean') throw new Error('topic_review_format_invalid')
    if (!Array.isArray(requestIds) || !requestIds.length || requestIds.length > 8 || new Set(requestIds).size !== requestIds.length) throw new Error('topic_review_request_invalid')
    const requests = requestIds.map((id) => requestFor(groupId, id))
    for (const request of requests) { refreshReview(request); request.readReview = true }
    const request = requests.length === 1 ? requests[0] : undefined
    const candidates = [...new Map(requests.flatMap((request) => request.candidates).map((candidate) => [candidate.outboundId, candidate])).values()]
      .map(candidate => {
        if (!request?.shortReferences) return candidate
        const shortRef = request.shortReferences.add('outbound', candidate.outboundId)
        request.shortReferences.expose(shortRef)
        return { ...candidate, shortRef }
      })
    const result = { requestIds, ...(compact ? compactReplyReviewCandidates(candidates) : { candidates }), candidateCount: candidates.length }
    if (request?.shortReferences) {
      request.reviewReadFingerprints ??= new Map()
      request.reviewReadFingerprints.set(fingerprint(result), fingerprint(request.candidates))
    }
    return result
  }
  function register(agentCtx, groupId, scope) {
    const tool = (name, description, parameters, execute) => {
      if (scope && !coordinationTools(coordinationRole(scope), scope).includes(name)) return
      if (scope && name === 'group_topic_title_submit' && !scope.requestId.startsWith('coord-title-')) return
      if (scope && name === 'group_topic_summary_submit' && !scope.requestId.startsWith('coord-summary-')) return
      if (scope && name === 'group_task_prompt_get' && !workflowPromptsEnabled) return
      if (name === 'group_decision_submit' && !scope) decisionSubmitters.set(groupId, execute)
      return agentCtx.tools.register({ name, description, parameters, output: objectOutput, execute: async (args, exec) => {
      if (!live()) throw new Error('resident_runtime_closed')
      assertSession(exec, groupId, scope, name)
      if (scope && (args.requestId !== undefined && args.requestId !== scope.requestId
        || args.requestIds?.some(id => id !== scope.requestId))) throw new Error('coordination_tool_wrong_request')
      if (scope && name === 'group_topic_route_review' && args.messageIds?.some(id => !scope.messages.some(message => message.messageId === id))) throw new Error('coordination_message_outside_request')
      if (dispatchRequest && !scope && (args.requestId || args.requestIds)) throw new Error('coordination_tool_request_session_required')
      const pending = Promise.resolve().then(() => execute(args))
      activeToolCalls.add(pending)
      try {
        const result = jsonOutput(await pending)
        await settleCoordinationRequest(groupId, args.requestId)
        return result
      }
      catch (error) {
        if (error.contextRequired) return error.contextRequired
        if (error instanceof z.ZodError) return invalidArguments(error)
        if (error.issues) return { status: 'invalid-arguments', issues: error.issues, nextAction: 'correct-arguments' }
        if (error instanceof TaskRevisionError) return { status: 'invalid-arguments', error: error.message, nextAction: '读取 group_task_context_get 的当前 stagePlan，纠正修订参数后用同一 requestId 重提；未接受决策、未预约 Task。' }
        throw error
      }
      finally { activeToolCalls.delete(pending) }
    } })
    }
    tool('group_topic_route_review', '按明确原因复核本群已存在消息的 Topic 归属；先返回冻结请求，再通过 group_topic_route_submit 完整提交。', {
      type: 'object', additionalProperties: false,
      properties: { messageIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['messageIds', 'reason'],
    }, (input) => {
      const { messageIds, reason } = z.strictObject({ messageIds: z.array(z.string().min(1)).min(1).max(15), reason: z.string().trim().min(1) }).parse(input)
      if (new Set(messageIds).size !== messageIds.length) throw new Error('topic_route_review_duplicate')
      const group = store.getGroup(groupId)
      const messages = messageIds.map((id) => {
        const message = group.messages.find((item) => item.messageId === id)
        if (!message) throw new Error(`message_not_found:${id}`)
        return message
      })
      return createRouteRequest(groupId, messages, reason)
    })
    tool('group_topic_route_context_get', '连续读取冻结路由原文或澄清审阅候选；按 nextOffset 续读。', {
      type: 'object', additionalProperties: false, properties: { requestId: { type: 'string' }, messageId: { type: 'string' }, section: { type: 'string', enum: ['clarificationReviewCandidates', 'messageMetadata', 'recoveryBoundary'] }, offset: { type: 'integer' } }, required: ['requestId', 'offset'],
    }, ({ requestId, messageId, section, offset }) => {
      const request = routes.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('topic_route_request_unknown')
      if (messageId !== undefined) messageId = request.shortReferences.resolve('message', messageId)
      if (section === 'messageMetadata') {
        const page = request.metadataPages.get(messageId)
        if (!page || offset !== page.offset) throw new Error('topic_route_metadata_offset_invalid')
        const result = { ...reviewTextPage(requestId, section, page.text, offset), messageId }
        page.offset = result.nextOffset
        return result
      }
      if (section === 'recoveryBoundary') {
        if (messageId !== undefined || offset !== request.recoveryBoundaryOffset) throw new Error('topic_route_recovery_offset_invalid')
        const result = reviewTextPage(requestId, section, request.recoveryBoundaryText, offset)
        request.recoveryBoundaryOffset = result.nextOffset
        return result
      }
      if (section === 'clarificationReviewCandidates') {
        if (messageId !== undefined || offset !== request.clarificationReviewOffset) throw new Error('topic_route_review_offset_invalid')
        const result = reviewTextPage(requestId, section, request.clarificationReviewText, offset)
        request.clarificationReviewOffset = result.nextOffset
        return result
      }
      const message = request.messages.find((item) => item.messageId === messageId)
      if (!message) throw new Error('topic_route_message_unknown')
      const expected = request.readOffsets.get(messageId) ?? 0
      if (!Number.isInteger(offset) || offset !== expected) throw new Error('topic_route_text_offset_invalid')
      let low = 0, high = message.text.length - offset
      const output = (size) => ({ requestId, messageId, messageVersion: message.messageVersion, text: message.text.slice(offset, offset + size), textOffset: offset, textTotal: message.text.length, nextOffset: offset + size, hasMore: offset + size < message.text.length })
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (JSON.stringify(output(middle)).length <= ROUTE_CONTEXT_MAX_CHARS) low = middle
        else high = middle - 1
      }
      if (low === 0 && offset < message.text.length) throw new Error('topic_route_context_metadata_too_large')
      const result = output(low)
      request.readOffsets.set(messageId, result.nextOffset)
      return result
    })
    tool('group_topic_route_submit', '提交完整消息批次的 Topic 归属及可选初诊草稿；Host 负责审阅和发送，不执行 Task。', scope?.requestId?.startsWith('coord-route-') ? compactTopicRouteSubmissionJsonSchema : topicRouteSubmissionJsonSchema, async (input) => {
      const request = routes.get(input.requestId)
      if (!request && typeof input.requestId === 'string' && store.getGroup(groupId)?.routeHistory.some(item => item.routeId === input.requestId)) {
        await schedule(groupId)
        return routeReceipt(input.requestId, true)
      }
      const expanded = structuredClone(input)
      if (expanded.newTopics !== undefined) {
        const { newTopics: definitions } = z.object({ newTopics: z.array(z.strictObject({ newTopicKey: z.string().min(1), title: z.string().trim().min(1).max(TOPIC_TITLE_MAX_CHARS), candidateComparisons: z.array(z.strictObject({ topicId: z.string().min(1), revision: z.number().int().positive(), reason: z.string().trim().min(1) })) })) }).parse({ newTopics: expanded.newTopics })
        const byKey = new Map(), used = new Set()
        for (const definition of definitions) {
          if (byKey.has(definition.newTopicKey)) throw Object.assign(new Error('topic_route_definition_duplicate'), { issues: [{ field: 'newTopics', code: 'topic_route_definition_duplicate', message: '新 Topic key 必须唯一' }] })
          byKey.set(definition.newTopicKey, definition)
        }
        for (const route of expanded.routes ?? []) for (const unit of route.units ?? (route.topics ? [{ topics: route.topics }] : [])) for (const target of unit.topics ?? []) {
          if (!target.newTopicKey) continue
          const definition = byKey.get(target.newTopicKey)
          if (!definition && target.title !== undefined) continue
          if (!definition || target.title !== undefined || target.candidateComparisons !== undefined) throw Object.assign(new Error('topic_route_definition_invalid'), { issues: [{ field: 'newTopics', code: 'topic_route_definition_invalid', message: '新 Topic 必须引用唯一声明，引用处不能重复定义标题或比较' }] })
          used.add(target.newTopicKey)
          target.title = definition.title
          target.candidateComparisons = structuredClone(definition.candidateComparisons)
        }
        if (used.size !== byKey.size) throw Object.assign(new Error('topic_route_definition_unused'), { issues: [{ field: 'newTopics', code: 'topic_route_definition_unused', message: '新 Topic 定义必须被明确引用' }] })
        delete expanded.newTopics
      }
      if (request?.groupId === groupId && Array.isArray(expanded.routes)) {
        const resolve = (kind, value) => request.shortReferences.resolve(kind, value)
        const target = item => {
          if (!item || typeof item !== 'object') return
          if (item.topicId !== undefined) item.topicId = resolve('topic', item.topicId)
          if (Array.isArray(item.candidateComparisons)) for (const comparison of item.candidateComparisons) target(comparison)
        }
        for (const reply of expanded.initialReplies ?? []) {
          reply.messageId = resolve('message', reply.messageId)
          target(reply.target)
        }
        for (const route of expanded.routes) {
          if (!route || typeof route !== 'object') continue
          route.messageId = resolve('message', route.messageId)
          for (const ref of route.deferred?.scope ?? []) target(ref)
          target(route.replyTopic); target(route.effectOwner)
          if (Array.isArray(route.topics)) for (const item of route.topics) target(item)
          if (Array.isArray(route.units)) for (const unit of route.units) {
            if (!unit || typeof unit !== 'object') continue
            target(unit.effectOwner)
            if (Array.isArray(unit.topics)) for (const item of unit.topics) target(item)
          }
        }
      }
      const args = topicRouteSubmissionSchema.parse(expanded)
      if (!request || request.groupId !== groupId) {
        const receipt = store.getGroup(groupId)?.routeHistory.find((item) => item.routeId === args.requestId)
        if (receipt) { await schedule(groupId); return routeReceipt(args.requestId, true) }
        await schedule(groupId)
        const current = [...routes.values()].find((item) => item.groupId === groupId)
        return current
          ? { status: 'superseded', currentRequest: { requestId: current.requestId, routingRevision: current.routingRevision }, nextAction: 'use-current-request' }
          : { status: 'request-unavailable', nextAction: 'wait-for-current-request' }
      }
      const batchRevision = request.batchRevision
      if (batchRevision > 0) {
        if (args.batchRevision !== batchRevision) return { status: 'route-batch-stale', batchRevision, nextAction: 'consume-current-update' }
        const { agent, message, pending, visible } = routeUpdateVisible(request)
        if (!visible || pending) {
          const recorded = agent?.session?.snapshotEvents?.().some(event => event.type === 'user/message' && event.data?.id === message.id)
          if (!pending && (request.batchDispatchFailed || recorded && agent?.session?.deriveMessages)) dispatchRouteUpdate(request)
          return { status: 'route-update-unread', batchRevision, nextAction: 'consume-current-update' }
        }
      } else if (args.batchRevision !== undefined && args.batchRevision !== 0) return { status: 'route-batch-stale', batchRevision: 0, nextAction: 'use-current-request' }
      const missingUpdateRead = missingRouteUpdateReads(request)
      if (missingUpdateRead) return missingUpdateRead
      if (request.recoveryBoundary.length) {
        const agent = getAgent(groupId, request)
        const visible = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, request.recoveryBoundaryText, request.requestId, 'recoveryBoundary') : request.recoveryBoundaryOffset
        if (visible < request.recoveryBoundaryText.length) {
          request.recoveryBoundaryOffset = visible
          return { status: 'context-required', error: 'topic_route_recovery_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'recoveryBoundary', offset: visible } } }
        }
      }
      if (!fixedTopicsEnabled && args.routes.some(route => route.units?.some(unit => unit.fixedTopic))) throw new Error('fixed_topic_routes_unavailable')
      if (!sameVersions(request.messages, args.routes)) throw new Error('topic_route_batch_incomplete')
      if ([...request.metadataPages.values()].some(page => page.offset < page.text.length)) throw new Error('topic_route_metadata_unread')
      if (request.messages.some((message) => (request.readOffsets.get(message.messageId) ?? 0) < message.text.length)) throw new Error('topic_route_source_unread')
      const seenTopics = [...request.seenTopicVersions].map(([topicId, revision]) => ({ topicId, revision }))
      const audit = { candidates: seenTopics, selections: [] }
      const issues = []
      for (const [routeIndex, route] of args.routes.entries()) {
        if (route.deferred?.scope && new Set(route.deferred.scope.map(ref => ref.topicId)).size !== route.deferred.scope.length)
          issues.push({ field: `routes[${routeIndex}].deferred.scope`, code: 'topic_route_scope_duplicate', message: '澄清范围不得重复' })
        for (const ref of route.deferred?.scope ?? []) if (request.seenTopicVersions.get(ref.topicId) !== ref.revision)
          issues.push({ field: `routes[${routeIndex}].deferred.scope`, code: 'topic_route_scope_unseen', message: '澄清范围必须选择本请求已见的话题及版本' })
        const units = route.units ?? (route.topics ? [{ unitKey: 'whole-message', topics: route.topics }] : [])
        for (const [unitIndex, unit] of units.entries()) for (const [targetIndex, target] of unit.topics.entries()) {
          const field = `routes[${routeIndex}]${route.units ? `.units[${unitIndex}]` : ''}.topics[${targetIndex}]`
          const comparisons = target.candidateComparisons ?? []
          if (!workflowPromptsEnabled && !target.reason?.trim()) issues.push({ field: `${field}.reason`, code: 'topic_route_audit_reason_required', message: '请在此目标填写本来源归属理由' })
          if (!workflowPromptsEnabled && target.newTopicKey && seenTopics.length && !comparisons.length) issues.push({ field: `${field}.candidateComparisons`, code: 'topic_route_audit_reason_required', message: '请提供新 Topic 对已见候选的排除比较；共享定义填入对应 newTopics 项' })
          if (new Set(comparisons.map(item => item.topicId)).size !== comparisons.length || comparisons.some(item => request.seenTopicVersions.get(item.topicId) !== item.revision)) issues.push({ field: `${field}.candidateComparisons`, code: 'topic_route_audit_candidate_invalid', message: '候选不可重复，且必须是本请求已见的对应版本' })
          if (!workflowPromptsEnabled && target.topicId && !request.seenTopicVersions.has(target.topicId)) issues.push({ field: `${field}.topicId`, code: 'topic_route_audit_candidate_unseen', message: '请选择本请求已见的 Topic' })
          audit.selections.push({ messageId: route.messageId, unitKey: unit.unitKey, ...(target.topicId ? { topicId: target.topicId } : { newTopicKey: target.newTopicKey }), ...(target.reason ? { reason: target.reason } : {}), candidateComparisons: comparisons })
        }
      }
      if (issues.length) throw Object.assign(new Error(issues[0].code), { issues })
      const referencedTopics = new Set()
      for (const route of args.routes) {
        for (const ref of route.deferred?.scope ?? []) referencedTopics.add(ref.topicId)
        for (const owner of [route.replyTopic, route.effectOwner]) if (owner?.topicId) referencedTopics.add(owner.topicId)
        for (const unit of route.units ?? [{ topics: route.topics ?? [] }]) {
          if (unit.effectOwner?.topicId) referencedTopics.add(unit.effectOwner.topicId)
          for (const target of unit.topics) {
            if (target.topicId) referencedTopics.add(target.topicId)
            for (const comparison of target.candidateComparisons ?? []) referencedTopics.add(comparison.topicId)
          }
        }
      }
      const checkUnsummarized = (group = store.getGroup(groupId)) => {
        for (const topicId of referencedTopics) {
          const topic = group.topics.find(item => item.topicId === topicId)
          const read = request.unsummarizedReads?.get(topicId)
          if (read && (!topic || !sameJson(read.text, topicSummaryContext(group, topic)))) throw new Error('topic_routing_stale')
          if (!topic || topic.summaryRevision >= topic.processedRevision) continue
          const nextCall = { name: 'group_topic_context_get', arguments: { topicId, revision: topic.revision, section: 'unsummarized', offset: read?.offset ?? 0 } }
          if (!read) return { status: 'context-required', error: 'topic_route_context_unread', nextCall }
          const agent = getAgent(groupId, request)
          const readLength = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, read.text, request.requestId, 'unsummarized', topicId) : read.offset
          if (readLength < read.text.length) return { status: 'context-required', error: 'topic_route_context_unread', nextCall: { ...nextCall, arguments: { ...nextCall.arguments, offset: readLength } } }
        }
      }
      let missingContext
      try { missingContext = checkUnsummarized() }
      catch (error) {
        if (error.message !== 'topic_routing_stale') throw error
        routes.delete(args.requestId)
        await schedule(groupId)
        return { status: 'stale', reason: 'routing-context-changed', nextAction: 'use-current-request' }
      }
      if (missingContext) return missingContext
      const needsReview = args.routes.some(route => route.deferred?.clarification) || !!args.initialReplies?.length
      if (needsReview && request.batchRevision && !request.batchCandidatesInline) {
        const agent = getAgent(groupId, request)
        const visible = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, request.clarificationReviewText, request.requestId, 'clarificationReviewCandidates') : request.clarificationReviewOffset
        if (visible < request.clarificationReviewText.length) {
          request.clarificationReviewOffset = visible
          return { status: 'context-required', error: 'topic_route_clarification_review_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'clarificationReviewCandidates', offset: visible } } }
        }
      }
      if (needsReview && request.clarificationReviewOffset < request.clarificationReviewText.length) throw new Error('topic_route_clarification_review_unread')
      const candidates = request.clarificationReviewCandidates
      const submittedRoutes = []
      for (const [routeIndex, route] of args.routes.entries()) {
        if (!route.deferred) { submittedRoutes.push(request.reason ? { ...route, reason: `${request.reason}${route.reason ? `；${route.reason}` : ''}` } : route); continue }
        const message = request.messages.find(item => item.messageId === route.messageId)
        const clarification = route.deferred.clarification
        let replyReview
        if (clarification) {
          const offset = message.text.indexOf(clarification.assignmentQuote)
          if (offset < 0 || message.text.indexOf(clarification.assignmentQuote, offset + 1) >= 0 || clarification.replyReview.kind !== 'substantive') throw new Error('topic_route_clarification_invalid')
          replyReview = validateReplyReview(clarification.replyReview, candidates, { confirmationTaskIds: [] })
          if (replyReview.replaceOutboundIds.length) throw new Error('topic_route_clarification_review_invalid')
        }
        if (!fixedTopicsEnabled && !clarification) { submittedRoutes.push(route); continue }
        if (fixedTopicsEnabled && (!clarification || !route.deferred.scope?.length || !store.clarificationPolicyEligible(groupId, message))) {
          if (store.getGroup(groupId).messages.find(item => item.messageId === route.messageId)?.activeUnitRefs?.length) throw Object.assign(new Error('topic_route_policy_existing_units'), { issues: [{
            field: `routes[${routeIndex}]`, code: 'topic_route_policy_existing_units',
            message: '已有活跃事项不可静默覆盖；请提交可发送的澄清问句及已见话题版本范围，或完整重分类并按原合同继承效果'
          }] })
          if (message.mediaUnavailable?.length) throw new Error('topic_route_policy_resource_unavailable')
          const imageIds = [...new Set([...(message.imageRefs ?? []).map(item => item.id ?? item.attachmentId),
            ...(message.mediaUnavailable ?? []).map(item => String(item).split(':', 1)[0])].filter(Boolean))]
          const sourceRefs = [...(message.text ? [{ wholeMessage: true }] : []), ...imageIds.map(imageRefId => ({ imageRefId }))]
          if (!sourceRefs.length) throw new Error('topic_unit_source_required')
          const reason = 'Host策略：未形成可发送且范围明确的澄清，按职责外静默处理'
          submittedRoutes.push({ messageId: route.messageId, messageVersion: route.messageVersion,
            units: [{ unitKey: 'host-uncertain-policy', summary: '待判来源按策略静默归类', sourceRefs, contextRefs: [], topics: [], fixedTopic: 'out-of-scope', reason }] })
          audit.selections.push({ messageId: route.messageId, kind: 'host-uncertain-policy', reason, modelReason: route.deferred.reason, candidateComparisons: [] })
          continue
        }
        submittedRoutes.push({ ...route, deferred: { ...route.deferred, clarification: { ...clarification, ...(fixedTopicsEnabled ? { authorization: 'routing-policy' } : {}), replyReview, reviewFingerprint: fingerprint(candidates), reviewMessageIds: request.messages.map(message => message.messageId), reviewMessageVersions: request.messages.map(({ messageId, messageVersion }) => ({ messageId, messageVersion })) } } })
      }
      const initialReplies = (args.initialReplies ?? []).map(reply => {
        const source = request.messages.find(message => message.messageId === reply.messageId && message.messageVersion === reply.messageVersion)
        if (!source) throw new Error('topic_initial_reply_source_invalid')
        const replyReview = validateReplyReview(reply.replyReview, candidates, { confirmationTaskIds: [] })
        if (replyReview.kind !== 'substantive' || replyReview.replaceOutboundIds.length) throw new Error('topic_initial_reply_review_invalid')
        return { ...reply, replyReview, reviewFingerprint: fingerprint(candidates),
          reviewMessageIds: request.messages.map(message => message.messageId),
          reviewMessageVersions: request.messages.map(({ messageId, messageVersion }) => ({ messageId, messageVersion })) }
      })
      let result
      try {
        result = await store.routeMessages({ groupId, routeId: request.requestId, routingRevision: request.routingRevision, initialReplies, recoveryBoundary: request.recoveryBoundary, expectedRoutingEpochs: request.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, epoch: message.routingEpoch ?? 0 })),
          preflight: latest => {
            if (request.batchRevision) {
              const { pending, visible } = routeUpdateVisible(request)
              if (pending || !visible) throw Object.assign(new Error('topic_route_update_unread'), { contextRequired: { status: 'route-update-unread', batchRevision: request.batchRevision, nextAction: 'consume-current-update' } })
            }
            const missingUpdateRead = missingRouteUpdateReads(request)
            if (missingUpdateRead) throw Object.assign(new Error(missingUpdateRead.error), { contextRequired: missingUpdateRead })
            if (request.recoveryBoundary.length) {
              const agent = getAgent(groupId, request)
              const visible = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, request.recoveryBoundaryText, request.requestId, 'recoveryBoundary') : request.recoveryBoundaryOffset
              if (visible < request.recoveryBoundaryText.length) {
                request.recoveryBoundaryOffset = visible
                throw Object.assign(new Error('topic_route_recovery_unread'), { contextRequired: { status: 'context-required', error: 'topic_route_recovery_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'recoveryBoundary', offset: visible } } } })
              }
            }
            if (request.messages.some(message => latest.messages.find(item => item.messageId === message.messageId)?.messageVersion !== message.messageVersion)) throw new Error('topic_message_version_stale')
            if (!request.reason) {
              const pending = latest.messages.filter(message => !message.ownNotificationRetirement && message.routingStatus !== 'routed')
              const currentBatch = activeRouteBatch(request, pending.filter(message => message.routingStatus !== 'needs-context'), pending)
              if (request.batchRevision !== batchRevision || !sameVersions(request.messages, currentBatch)
                || request.messages.some(message => currentBatch.find(item => item.messageId === message.messageId)?.routingEpoch !== message.routingEpoch)) throw new Error('topic_route_batch_changed')
            }
            if ([...referencedTopics].some(topicId => {
              const snapshot = request.seenTopicSnapshots.get(topicId)
              const topic = latest.topics.find(item => item.topicId === topicId && !item.mergedInto)
              if (!snapshot || !topic) return true
              const current = routeCandidateSnapshot(snapshot.kind === 'context' ? projectTopicContext({ topic, messages: [] }).topic : topicIndex([topic])[0])
              return !isDeepStrictEqual(snapshot.value, Object.fromEntries(Object.keys(snapshot.value).map(key => [key, current[key]])))
            })) throw new Error('topic_routing_stale')
            if (args.routes.some(route => route.deferred?.scope?.some(ref => !latest.topics.some(topic => topic.topicId === ref.topicId && topic.revision === ref.revision && !topic.mergedInto)))) throw new Error('topic_routing_stale')
            if (audit.selections.some(selection => selection.candidateComparisons.some(comparison => !latest.topics.some(topic => topic.topicId === comparison.topicId && topic.revision === comparison.revision && !topic.mergedInto)))) throw new Error('topic_routing_stale')
            const missing = checkUnsummarized(latest)
            if (missing) throw Object.assign(new Error('topic_route_context_unread'), { contextRequired: missing })
            if (needsReview && request.batchRevision && !request.batchCandidatesInline) {
              const agent = getAgent(groupId, request)
              const visible = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, request.clarificationReviewText, request.requestId, 'clarificationReviewCandidates') : request.clarificationReviewOffset
              if (visible < request.clarificationReviewText.length) {
                request.clarificationReviewOffset = visible
                throw Object.assign(new Error('topic_route_clarification_review_unread'), { contextRequired: { status: 'context-required', error: 'topic_route_clarification_review_unread', nextCall: { name: 'group_topic_route_context_get', arguments: { requestId: request.requestId, section: 'clarificationReviewCandidates', offset: visible } } } })
              }
            }
            if (needsReview && fingerprint(reviewCandidates(groupId, request.messages, [])) !== fingerprint(candidates)) throw new Error('topic_routing_stale')
          }, audit, routes: submittedRoutes })
      } catch (error) {
        if (error.contextRequired) return error.contextRequired
        if (error.message === 'topic_route_batch_changed' || error.message === 'topic_routing_recovery_stale') {
          await schedule(groupId)
          const current = routes.get(args.requestId)
          return current ? { status: 'route-batch-stale', batchRevision: current.batchRevision, nextAction: 'consume-current-update' }
            : { status: 'stale', reason: 'routing-context-changed', nextAction: 'use-current-request' }
        }
        if (!['topic_message_version_stale', 'topic_routing_stale'].includes(error.message)) throw error
        routes.delete(args.requestId)
        await schedule(groupId)
        const current = [...routes.values()].find((item) => item.groupId === groupId)
        return { status: 'stale', reason: error.message === 'topic_routing_stale' ? 'routing-context-changed' : 'message-version-changed', ...(current ? { currentRequest: { requestId: current.requestId, routingRevision: current.routingRevision } } : {}), nextAction: 'use-current-request' }
      }
      if (result.status !== 'routed' && result.status !== 'duplicate') { routes.delete(args.requestId); await schedule(groupId); return result }
      routes.delete(args.requestId)
      await schedule(groupId)
      resumePausedDecisionMonitors(groupId)
      return routeReceipt(args.requestId)
    })
    tool('group_topic_title_submit', '提交基于历史 Topic summary 重新概括的简短标题；不执行任务、不发送回复。', {
      type: 'object', additionalProperties: false,
      properties: { requestId: { type: 'string' }, topicId: { type: 'string' }, title: { type: 'string', description: `基于 summary 重新概括的 8–20 字标题，最多 ${TOPIC_TITLE_MAX_CHARS} 字；禁止直接截断摘要。` } },
      required: ['requestId', 'topicId', 'title'],
    }, async (input) => {
      const args = z.strictObject({ requestId: z.string().min(1), topicId: z.string().min(1), title: z.string().trim().min(1).max(TOPIC_TITLE_MAX_CHARS) }).parse(input)
      const request = titleMigrations.get(args.requestId)
      if (!request || request.groupId !== groupId || request.topicId !== args.topicId) throw new Error('topic_title_request_unknown')
      const title = args.title.trim()
      const summary = request.expectedSummary.trim()
      if (summary.length > TOPIC_TITLE_MAX_CHARS && title.length === TOPIC_TITLE_MAX_CHARS && summary.startsWith(title)) throw new Error('topic_title_truncation_rejected')
      const result = await store.updateTopicTitle({ groupId, topicId: args.topicId, expectedTitle: request.expectedTitle, expectedSummary: request.expectedSummary, title })
      titleMigrations.delete(args.requestId)
      await schedule(groupId)
      return result
    })
    tool('group_topic_summary_submit', '提交根据历史 Topic 固定版本引用消息生成的摘要；不执行任务、不发送回复。', {
      type: 'object', additionalProperties: false,
      properties: { requestId: { type: 'string' }, topicId: { type: 'string' }, summary: { type: 'string', description: '概括讨论对象、当前结论、范围和仍需处理事项的独立话题摘要。' } },
      required: ['requestId', 'topicId', 'summary'],
    }, async (input) => {
      const args = z.strictObject({ requestId: z.string().min(1), topicId: z.string().min(1), summary: z.string().trim().min(1).max(4000) }).parse(input)
      const request = summaryMigrations.get(args.requestId)
      if (!request || request.groupId !== groupId || request.topicId !== args.topicId) throw new Error('topic_summary_request_unknown')
      const result = await store.updateTopicSummary({ groupId, topicId: args.topicId, expectedRevision: request.expectedRevision, expectedSummary: request.expectedSummary, summary: args.summary.trim() })
      summaryMigrations.delete(args.requestId)
      await schedule(groupId)
      return result
    })
    tool('group_decision_submit', '提交一个 Topic 固定版本的独立业务决策；accepted 表示意图已持久化，动作进度可查询。', scope?.trigger === 'task-facts' ? factDecisionJsonSchema : !workflowPromptsEnabled && scope && coordinationRole(scope) === 'decision' ? compactGroupDecisionSubmissionJsonSchema : workflowPromptsEnabled ? legacyGroupDecisionSubmissionJsonSchema : groupDecisionSubmissionJsonSchema, async function submitDecision(input, { validateSnapshot } = {}) {
      if (!workflowPromptsEnabled && scope && coordinationRole(scope) === 'decision' && input.requestId === undefined) {
        const compact = compactGroupDecisionSubmissionSchema.parse(input)
        const current = decisions.get(scope.requestId)
        if (!current || current.groupId !== groupId || compact.revision !== current.revision) return { status: 'topic-stale', nextAction: 'use-current-request' }
        const expand = refs => refs.map(ref => current.shortReferences.resolve('unit', ref))
        const review = compact.decision.replyReview
        if (review) {
          refreshReview(current)
          if (!inlineDecisionCurrent(current)) return { status: 'task-stale', nextAction: 'group_task_context_get' }
          if (current.candidates.length && !current.readReview) return reviewRequired(current)
        }
        const replyReview = review && { ...review, reviewedOutboundIds: current.candidates.map(candidate => candidate.outboundId), ...Object.fromEntries(['sameMatterOutboundIds', 'replaceOutboundIds'].map(key => [key, review[key].map(ref => current.shortReferences.resolve('outbound', ref))])) }
        const messageIds = refs => refs.map(ref => current.shortReferences.resolve('message', ref))
        const decision = { ...compact.decision, basisMessageIds: messageIds(compact.decision.basisMessageIds), ...(compact.decision.replyToMessageId ? { replyToMessageId: current.shortReferences.resolve('message', compact.decision.replyToMessageId) } : {}), ...(review ? { replyReview } : {}), basisUnitRefs: expand(compact.decision.basisUnitRefs), actions: compact.decision.actions.map(action => ({ ...action, ...(action.impactEvidence ? { impactEvidence: { ...action.impactEvidence, basisMessageIds: messageIds(action.impactEvidence.basisMessageIds) } } : {}), ...(action.taskId ? { taskId: current.shortReferences.resolve('task', action.taskId) } : {}), topicRefs: action.topicRefs.map(ref => typeof ref === 'string' ? current.shortReferences.resolve('topic-version', ref) : ref), basisUnitRefs: expand(action.basisUnitRefs),
          ...(action.dispatchAssessment ? { dispatchAssessment: { ...action.dispatchAssessment, sourceUnitRefs: expand(action.dispatchAssessment.sourceUnitRefs) } } : {}) })) }
        input = { requestId: current.requestId, topicId: current.topicId, revision: compact.revision, decision }
      }
      const factRequest = decisions.get(input.requestId)
      if (factRequest?.trigger === 'task-facts') {
        const args = factDecisionSchema.parse(input)
        if (args.topicId !== factRequest.topicId || args.revision !== factRequest.revision || factRequest.groupId !== groupId) return { status: 'topic-stale' }
        const preflight = () => {
          const topic = store.getTopic(groupId, factRequest.topicId)
          if (decisions.get(factRequest.requestId) !== factRequest || !topic || topic.revision !== factRequest.revision || initialReplyPending(groupId, factRequest.topicId)) return false
          if (!factRequest.sections.summary) return topic.summaryRevision >= topic.revision
          if (!sameJson(factRequest.sections.summary, topicSummaryContext(store.getGroup(groupId), topic))) return false
          const agent = getAgent(groupId, factRequest)
          const read = agent?.session?.deriveMessages ? visibleRequestSectionLength(agent, factRequest.sections.summary, factRequest.requestId, 'summary') : factRequest.readSectionOffsets.get('summary') ?? 0
          if (read < factRequest.sections.summary.length) throw Object.assign(new Error('topic_decision_context_unread'), { contextRequired: { status: 'context-required', error: 'topic_decision_context_unread', nextCall: { name: 'group_decision_context_get', arguments: { requestId: factRequest.requestId, section: 'summary', offset: read } } } })
          return true
        }
        let result
        try { result = await taskFacts.submit(factRequest, args, { preflight }) }
        catch (error) {
          if (error.factDecisionCommitted) decisions.delete(args.requestId)
          throw error
        }
        decisions.delete(args.requestId)
        await schedule(groupId)
        return result
      }
      const args = (workflowPromptsEnabled ? legacyGroupDecisionSubmissionSchema : groupDecisionSubmissionSchema).parse(input)
      const request = decisions.get(args.requestId)
      if (!request || request.groupId !== groupId || request.topicId !== args.topicId || request.revision !== args.revision) { await schedule(groupId); return { status: 'topic-stale', nextAction: 'use-current-request' } }
      if (request.roundUpdate) {
        const agent = getAgent(groupId, request)
        // Derive from the current revision even while its async envelope is being built.
        const updateMessageId = `message-${request.requestId}-revision-${request.revision}`
        const pending = [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
        const consumed = agent?.session?.snapshotEvents?.().some(event => event.type === 'user/message' && event.data.id === updateMessageId)
        if (!consumed || pending.some(message => message.id === updateMessageId))
          return { status: 'decision-update-unread', revision: request.revision, nextAction: 'consume-current-update' }
      }
      if (!presentationCurrent(request)) { await schedule(groupId); return { status: 'topic-stale', reason: 'topic-presentation-changed', nextAction: 'use-current-request' } }
      if (!personAliasesCurrent(request)) { await schedule(groupId); return { status: 'topic-stale', reason: 'person-aliases-changed', nextAction: 'use-current-request' } }
      refreshReview(request)
      if (!inlineDecisionCurrent(request)) return { status: 'task-stale', nextAction: 'group_task_context_get' }
      const basis = new Set(args.decision.basisMessageIds)
      const inferred = args.decision.basisMessageIds.flatMap((messageId) => {
        const matches = [...request.messages, ...request.removedUnitRefs].filter((message) => message.messageId === messageId)
        return matches.length === 1 ? matches.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) : []
      })
      if (!args.decision.basisUnitRefs && inferred.length !== args.decision.basisMessageIds.length) throw new Error('topic_decision_basis_invalid')
      const basisUnitRefs = args.decision.basisUnitRefs ?? inferred
      let decision = { ...args.decision, basisUnitRefs, actions: args.decision.actions.map((action) => ({ ...action, basisUnitRefs: action.basisUnitRefs ?? basisUnitRefs })) }
      const basisMessages = request.messages.filter((message) => basisUnitRefs.some((ref) => unitKey(ref) === unitKey(message)))
      const attachmentIds = new Set(basisMessages.flatMap((message) => message.sourceAttachments ?? []).map((ref) => ref.imageRefId))
      const unavailable = basisMessages.flatMap((message) => message.mediaUnavailable ?? []).filter((value) => attachmentIds.has(String(value).split(':', 1)[0]))
      decision = blockTaskDecisionForUnavailableMedia(decision, unavailable)
      const archivedTasks = new Map()
      if (readArchivedTask) for (const taskId of new Set(decision.actions.map(action => action.taskId).filter(Boolean))) {
        if (store.getTask(taskId)) continue
        const task = await readArchivedTask(taskId)
        if (task) archivedTasks.set(taskId, task)
      }
      validateBasis(request, decision, archivedTasks)
      const foreignReply = basisMessages.length > 0 && basisMessages.every(message => {
        const owner = replyTopicForMessage(store.getGroup(groupId), message)
        return owner && owner !== args.topicId
      })
      if (decision.actions.length && !decision.reply?.trim() && !foreignReply && !decision.actions.every(isSilentTaskFactFeedback)) return { status: 'reply-required' }
      if (decision.reply?.trim()) {
        if (foreignReply) {
          decisions.delete(args.requestId)
          await schedule(groupId)
          return { status: 'reply-owned-by-other-topic', decisionId: args.requestId }
        }
        try {
          const messages = request.messages.filter(message => { const owner = replyTopicForMessage(store.getGroup(groupId), message); return !owner || owner === args.topicId })
          const { target, recipients, atAll } = replyRouting(messages, decision.replyToMessageId, decision.atOpenDingTalkIds, decision.atAll)
          decision = { ...decision, ...(target ? { replyToMessageId: target.messageId } : {}), atOpenDingTalkIds: recipients, ...(atAll ? { atAll } : {}) }
        }
        catch (error) { return { status: 'invalid-arguments', issues: [{ field: 'decision.replyToMessageId', code: error.message, message: error.message }], nextAction: 'correct-arguments' } }
        if (!decision.replyReview) return { status: 'review-required', error: 'reply_kind_required' }
        if (refreshReview(request)) return reviewRequired(request)
        if (request.candidates.length && !request.readReview) return reviewRequired(request)
        try { decision = { ...decision, replyReview: validateReplyReview(decision.replyReview, request.candidates, { confirmationTaskIds: decision.actions.map((action) => action.taskId).filter(Boolean) }) } }
        catch (error) {
          const guidance = {
            group_reply_review_replacement_incomplete: 'confirmation 或 correction 的 replaceOutboundIds 必须与 sameMatterOutboundIds 集合相等；先逐条核对同事项，不要自动全选。',
            group_reply_review_same_task_confirmation_missing: 'confirmation 的 sameMatterOutboundIds 必须包含本次任务已有的 confirmation 候选；重新核对任务与候选。',
            group_reply_review_replace_invalid: 'replaceOutboundIds 只能选择 sameMatterOutboundIds 中经核对的候选。',
            group_reply_review_confirmation_replace_kind_invalid: 'confirmation 只能替换已明确标记为 confirmation 的候选；不可替换实质结果、订正或类型未知的回复。',
          }
          return { status: 'review-required', error: error.message, ...(guidance[error.message] ? { message: guidance[error.message] } : {}) }
        }
      }
      const result = await (validateSnapshot || request.inlineDecisionSnapshot ? serializeTasks : (operation) => Promise.resolve().then(operation))(() => {
        if (validateSnapshot && validateSnapshot() !== true) return { status: 'task-stale' }
        if (!inlineDecisionCurrent(request)) return { status: 'task-stale', nextAction: 'group_task_context_get' }
        if (decision.reply?.trim() && refreshReview(request)) return reviewRequired(request)
        return store.acceptTopicDecision({ groupId, topicId: args.topicId, revision: args.revision, decisionId: args.requestId, decision,
        expectedTaskVersions: decision.actions.filter((action) => action.taskId).map((action) => ({ taskId: action.taskId, inputVersion: action.inputVersion, runSequence: action.runSequence })),
        preflight: () => {
          if (initialReplyPending(groupId, args.topicId)) return { status: 'initial-reply-pending' }
          if (!presentationCurrent(request)) return { status: 'topic-stale', reason: 'topic-presentation-changed' }
          if (!personAliasesCurrent(request)) return { status: 'topic-stale', reason: 'person-aliases-changed' }
          if (validateSnapshot && validateSnapshot() !== true) return { status: 'task-stale' }
          if (!inlineDecisionCurrent(request)) return { status: 'task-stale', nextAction: 'group_task_context_get' }
          validateBasis(request, decision, archivedTasks)
          return decision.reply?.trim() && refreshReview(request) ? reviewRequired(request) : undefined
        } })
      })
      if (result.status === 'accepted' || result.status === 'duplicate') {
        decisions.delete(args.requestId)
        resume(groupId, args.topicId, args.requestId)
      } else {
        if (result.status === 'routing-required') {
          const prepared = structuredClone(args)
          request.retryAfterRouting = async () => {
            const result = await submitDecision(prepared, { validateSnapshot })
            await settleCoordinationRequest(groupId, args.requestId)
            return result
          }
          request.routingPaused = true
        }
        if (!['routing-required', 'review-required'].includes(result.status)) decisions.delete(args.requestId)
        await schedule(groupId)
      }
      if (result.status === 'routing-required') {
        const current = [...routes.values()].find((item) => item.groupId === groupId && !item.exhausted)
        return { status: result.status, decisionId: args.requestId, ...(current ? { routeRequestId: current.requestId } : {}), nextAction: 'wait-for-routing', retryScheduled: true }
      }
      return { status: result.status, decisionId: args.requestId }
    })
    tool('group_topic_list', '搜索本群 Topic 摘要，按需召回历史话题。query 按原文整串匹配；queries 最多五个词组按命中数排序，词面命中不代表同一事项。', { type: 'object', properties: { requestId: { type: 'string', description: '读取当前路由引用命中的关联目录；省略则查询全群目录' }, query: { type: 'string' }, queries: { type: 'array', items: { type: 'string' }, description: '1..5 个非空词组，每项最多32字符；不能与 query 同时使用。' }, offset: { type: 'integer', description: 'Topic条目偏移，非负整数，默认0；续页使用返回的nextOffset。' }, limit: { type: 'integer', description: '请求的Topic条数，整数1..100，默认50；关联目录仍受字符预算限制，实际条数可能更少。' } }, additionalProperties: false }, ({ requestId, query, queries, offset = 0, limit = 50 }) => {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('topic_page_invalid')
      if (queries !== undefined && (query !== undefined || !Array.isArray(queries) || queries.length < 1 || queries.length > 5 || queries.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 32))) throw new Error('topic_query_invalid')
      const route = requestId ? routes.get(requestId) : undefined
      if (requestId && (!route || route.groupId !== groupId)) throw new Error('topic_route_request_unknown')
      const selected = route ? route.relatedTopics : store.listTopics(groupId)
      const terms = queries?.map(value => value.trim()).filter((value, index, values) => values.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index)
      const matched = terms ? topicMatches(selected, terms) : undefined
      const all = matched ?? selected.filter((topic) => `${topic.title ?? ''}\n${topic.summary ?? ''}`.toLowerCase().includes((query ?? '').toLowerCase()))
      const page = all.slice(offset, offset + limit)
      const indexed = matched ? page.map(({ topic, matchedQueries }) => ({ ...topicIndex([topic])[0], matchedQueries })) : topicIndex(page)
      const activeRoute = scope?.requestId ? routes.get(scope.requestId) : route
      const candidates = activeRoute?.groupId === groupId
        ? indexed.map(item => ({ ...item, shortRef: activeRoute.shortReferences.add('topic', item.topicId) }))
        : indexed
      const topics = route ? boundedItems(candidates, 3_000, limit) : candidates
      const nextOffset = Math.min(all.length, offset + topics.length)
      if (activeRoute?.groupId === groupId) for (const item of topics) {
        activeRoute.seenTopicVersions.set(item.topicId, item.revision)
        const previous = activeRoute.seenTopicSnapshots.get(item.topicId)
        if (previous?.kind !== 'context' || previous.value.revision !== item.revision) activeRoute.seenTopicSnapshots.set(item.topicId, { kind: 'index', value: routeCandidateSnapshot(item) })
        activeRoute.shortReferences.expose(item.shortRef)
      }
      return { topics, total: all.length, offset, limit, nextOffset, hasMore: nextOffset < all.length, ...(terms ? { queries: terms } : {}) }
    })
    tool('group_decision_context_get', '按当前群固定决策请求读取超长事项或上下文段；按 nextOffset 连续读取。', {
      type: 'object', additionalProperties: false, required: ['requestId', 'section'], properties: {
        requestId: { type: 'string' }, section: { type: 'string', enum: taskFacts ? [...DECISION_SECTIONS, 'facts'] : DECISION_SECTIONS }, offset: { type: 'integer' },
      },
    }, async ({ requestId, section, offset = 0 }) => {
      const request = decisions.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('decision_context_request_unknown')
      if (store.getTopic(groupId, request.topicId)?.revision !== request.revision) throw new Error('decision_context_topic_stale')
      if (request.trigger === 'task-facts' && section === 'facts') {
        const facts = await taskFacts.read(request.factContext.eventIds)
        return decisionTextPage(requestId, section, JSON.stringify(facts), offset)
      }
      if (!Object.hasOwn(request.sections, section)) throw new Error(`decision_context_section_unknown:allowed=${DECISION_SECTIONS.join(',')}`)
      if (getAgent(groupId, request)?.session?.deriveMessages && visibleCoordinatorText(getAgent(groupId, request), request.text)) request.surfaceTracked = true
      if (getAgent(groupId, request)?.session?.deriveMessages) request.readSectionOffsets.set(section, visibleRequestSectionLength(getAgent(groupId, request), request.sections[section], requestId, section))
      if ((request.readSectionOffsets.get(section) ?? 0) !== offset) throw new Error('decision_context_offset_out_of_order')
      const page = decisionTextPage(requestId, section, request.sections[section], offset)
      request.readSectionOffsets.set(section, page.nextOffset)
      if (!page.hasMore && (section === 'messages' || section === 'removedUnitRefs')) {
        for (const item of JSON.parse(request.sections[section])) {
          request.shortReferences.expose(item.unitShortRef)
          request.shortReferences.expose(item.messageShortRef)
        }
      }
      if (section === 'messages' && !page.hasMore) {
        const topic = store.getTopic(groupId, request.topicId)
        if (!topic || topic.revision !== request.revision) throw new Error('decision_context_topic_stale')
        const delta = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= request.revision).map(unitKey))
        for (const message of request.messages) if (delta.has(unitKey(message))) request.readUnitRefs.add(unitKey(message))
      }
      return page
    })
    const currentTopic = scope && coordinationRole(scope) === 'decision' ? scope : null
    tool('group_topic_context_get', `按需读取本群 Topic 固定版本及消息原文；摘要足以排除不同业务目标时直接路由，不因词面接近强读全文。返回不超过字符预算，按需用 nextOffset/nextTextOffset 续读相关原文；不为路由候选判断默认读取全部历史。${currentTopic ? '本会话唯一当前Topic与revision由Host绑定，{}直接读取当前固定版本；显式topicId可读取本群其他历史。' : '当前会话没有唯一Topic；确需历史时从输入topics或group_topic_list选择对应候选，原样复制其readCall.arguments（含topicId/revision），不可传{}。'}`, { type: 'object', properties: { section: { type: 'string', enum: ['unsummarized'], description: '读取未汇总历史时 offset 为 JSON 字符偏移。' }, topicId: { type: 'string', description: '从明确候选readCall.arguments.topicId复制，不从标题猜ID。' }, revision: { type: 'integer', description: '固定Topic版本，整数1..当前Topic revision；当前决策省略使用Host绑定版本，其他Topic省略使用当前版本。续读同一历史须保留原revision。' }, offset: { type: 'integer', description: '消息条目偏移，非负整数，默认0；续页使用返回的nextOffset。' }, limit: { type: 'integer', description: '请求的消息条数，非字符数，整数1..500，默认10；字符预算可能提前截断，按nextOffset/nextTextOffset续读。' }, textOffset: { type: 'integer', description: '本页首条消息的UTF-16字符偏移，非负整数且不超过该消息原文长度，默认0；仅按返回的nextTextOffset续读。' } }, required: currentTopic ? [] : ['topicId'], additionalProperties: false }, (args) => {
      const activeRoute = scope?.requestId ? routes.get(scope.requestId) : undefined
      if (activeRoute?.groupId === groupId && args.topicId !== undefined) args = { ...args, topicId: activeRoute.shortReferences.resolve('topic', args.topicId) }
      const bound = currentTopic && (args.topicId === undefined || args.topicId === currentTopic.topicId)
      if (bound && (!decisions.has(scope.requestId) || store.getTopic(groupId, currentTopic.topicId)?.revision !== currentTopic.revision
        || args.revision !== undefined && args.revision !== currentTopic.revision)) throw new Error('decision_context_topic_stale')
      if (!args.topicId && !bound) return { status: 'invalid-arguments', issues: [{ code: 'topic_id_required', field: 'topicId', message: '当前路由没有唯一Topic，请从输入topics或group_topic_list选择明确topicId。' }],
        nextAction: 'group_topic_list', nextCall: { name: 'group_topic_list', arguments: { offset: 0, limit: 50 } } }
      if (args.section === 'unsummarized') {
        if (!activeRoute || activeRoute.groupId !== groupId || !args.topicId || !Number.isInteger(args.revision)) throw new Error('topic_route_request_unknown')
        const topic = store.getTopic(groupId, args.topicId)
        if (!topic || topic.revision !== args.revision || activeRoute.seenTopicVersions.get(args.topicId) !== args.revision) throw new Error('topic_routing_stale')
        activeRoute.unsummarizedReads ??= new Map()
        let read = activeRoute.unsummarizedReads.get(args.topicId)
        if (!read) {
          read = { text: JSON.stringify(topicSummaryContext(store.getGroup(groupId), topic)), offset: 0 }
          activeRoute.unsummarizedReads.set(args.topicId, read)
        }
        if (!sameJson(read.text, topicSummaryContext(store.getGroup(groupId), topic))) throw new Error('topic_routing_stale')
        const offset = args.offset ?? 0
        const agent = getAgent(groupId, activeRoute)
        if (agent?.session?.deriveMessages) read.offset = visibleRequestSectionLength(agent, read.text, activeRoute.requestId, 'unsummarized', args.topicId)
        if (offset !== read.offset) throw new Error('topic_route_context_offset_invalid')
        const page = decisionTextPage(activeRoute.requestId, 'unsummarized', read.text, offset)
        read.offset = page.nextOffset
        return { ...page, topicId: args.topicId, revision: args.revision }
      }
      const input = { ...args, ...(bound ? { topicId: currentTopic.topicId, revision: args.revision ?? currentTopic.revision } : {}) }
      const context = boundedTopicContext({ ...store.getTopicContext({ ...input, groupId, limit: input.limit ?? 10 }), ...(currentTopic ? { requestId: scope.requestId } : {}) }, { textOffset: input.textOffset ?? 0 })
      if (activeRoute?.groupId === groupId && store.getTopic(groupId, context.topic.topicId)?.revision === context.topic.revision) {
        activeRoute.seenTopicVersions.set(context.topic.topicId, context.topic.revision)
        activeRoute.seenTopicSnapshots.set(context.topic.topicId, { kind: 'context', value: routeCandidateSnapshot(context.topic) })
      }
      for (const request of decisions.values()) {
        if (request.groupId !== groupId || request.topicId !== context.topic.topicId || request.revision !== context.topic.revision) continue
        request.readTextOffsets ??= new Map()
        for (const message of context.messages) {
          const key = unitKey(message)
          const expected = request.readTextOffsets.get(key) ?? 0
          if ((message.textOffset ?? 0) !== expected) continue
          if (message.textHasMore) request.readTextOffsets.set(key, context.nextTextOffset)
          else request.readUnitRefs.add(key)
        }
      }
      return context
    })
    tool('group_reply_review_get', `读取 Topic 判断或 Task 通知绑定的完整历史回复候选。${scope ? '本会话唯一request由Host绑定，直接传{}；显式requestIds只能是当前请求。' : '必须显式提供requestIds。'}`, { type: 'object', properties: { requestIds: { type: 'array', items: { type: 'string' } }, compact: { type: 'boolean', description: '共享来源与任务事实用ref索引去重；false保留原展开格式，原文仍可通过消息/任务工具读取。' } }, required: scope ? [] : ['requestIds'], additionalProperties: false }, ({ requestIds = scope ? [scope.requestId] : undefined, compact = false }) => {
      return readReplyReview(groupId, requestIds, compact)
    })
    tool('group_task_review_context_get', '按审阅请求和 section 续读目标、证据、消息或流程索引的完整 JSON 原文；按 nextOffset 连续读取。section=manifest 返回当前请求材料摘要、版本、当前上下文可见分页与缺口，不把摘要当正文。', { type: 'object', additionalProperties: false, required: ['requestId', 'section'], properties: {
      requestId: { type: 'string' }, section: { type: 'string' }, offset: { type: 'integer' },
    } }, ({ requestId, section, offset = 0 }) => {
      const request = reviews.get(requestId) ?? replies.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('task_review_request_unknown')
      if (section === 'manifest') return materialManifest(request)
      if (!Object.hasOwn(request.sections, section)) throw new Error('task_review_section_unknown')
      const page = reviewTextPage(requestId, section, request.sections[section], offset)
      if (visibleSectionLength(getAgent(groupId, request), request.sections[section]) >= page.nextOffset && page.nextOffset > offset) {
        request.readSectionOffsets.set(section, Math.max(request.readSectionOffsets.get(section) ?? 0, page.nextOffset))
        return { ...page, text: undefined, reused: true, contentFingerprint: fingerprint(page.text) }
      }
      if ((request.readSectionOffsets.get(section) ?? 0) === offset) request.readSectionOffsets.set(section, page.nextOffset)
      return page
    })
    tool('group_task_prompt_get', '按决策或审阅请求的固定流程版本批量读取索引中候选任务流程正文；一次传入本轮需要的全部流程 ID，核查是否漏选适用流程，允许多个组合或确无匹配。', { type: 'object', additionalProperties: false, required: ['requestId', 'ids'], properties: {
      requestId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } },
    } }, async ({ requestId, ids }) => {
      const decisionRequest = decisions.get(requestId)
      const request = decisionRequest ?? reviews.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('task_review_request_unknown')
      if (decisionRequest && store.getTopic(groupId, request.topicId)?.revision !== request.revision) throw new Error('decision_context_topic_stale')
      if (ids.length < 1) throw new Error('task_review_prompt_ids_required')
      const uniqueIds = [...new Set(ids)]
      const refs = uniqueIds.map((id) => request.promptCatalog.find((item) => item.id === id))
      if (refs.some((ref) => !ref)) throw new Error('task_review_prompt_not_available')
      const currentPrompts = store.getTaskPrompts?.() ?? []
      const prompts = refs.map((ref) => currentPrompts.find((item) => item.id === ref.id && item.enabled && item.revision === ref.revision))
      const unavailable = refs.filter((_ref, index) => !prompts[index]).map((ref) => ref.id)
      if (unavailable.length) {
        if (decisionRequest) {
          await supersedeRequest(request, undefined, 'decision-prompt-catalog-changed')
          decisions.delete(requestId)
          await schedule(groupId)
          return { status: 'decision-stale', error: 'decision_prompt_catalog_changed', nextAction: 'wait-for-current-request' }
        }
        if (diagnosticCheckpoint(request)) return { status: 'prompt-unavailable', ids: unavailable, nextAction: 'continue-diagnostic-review' }
        const error = `task_prompt_selection_stale:${unavailable.join(',')}`
        void supersedeRequest(request, undefined, error)
        reviews.delete(requestId); request.reject(new Error(error))
        return { status: 'task-stale', error }
      }
      const reused = new Set(visiblePromptRefs(getAgent(groupId, request), prompts).map((ref) => ref.id))
      for (const prompt of prompts) {
        const ref = { id: prompt.id, revision: prompt.revision }
        request.readPromptRefs.set(prompt.id, ref); request.readPromptVersions.set(prompt.id, ref)
      }
      return { prompts: prompts.map((prompt) => reused.has(prompt.id) ? { id: prompt.id, revision: prompt.revision, reused: true, contentFingerprint: fingerprint(promptContent(prompt)) } : promptContent(prompt)) }
    })
    tool('group_reply_submit', '提交绑定 Topic 与 Task 输入版本的结果通知；不依赖全群 observedRequestIds。', { type: 'object', additionalProperties: false, required: ['requestId', 'reply'], properties: {
      requestId: { type: 'string' }, reply: { type: 'string' }, replyReview: replyReviewJsonSchema, replyToMessageId: { type: 'string' }, atOpenDingTalkIds: { type: 'array', items: { type: 'string' } }, atAll: { type: 'boolean' },
    } }, async (args) => {
      const request = replies.get(args.requestId)
      if (!request || request.groupId !== groupId) {
        const outbound = store.getGroup(groupId)?.outbox.find((item) => item.outboundId === (scope?.outboundId ?? `reply-${args.requestId}`))
        return outbound
          ? { status: 'accepted', recovered: true, outboundId: outbound.outboundId, deliveryStatus: outbound.status }
          : { status: 'request-unavailable', nextAction: 'wait-for-current-request' }
      }
      if (!args.reply?.trim()) throw new Error('group_reply_text_required')
      if (!args.replyReview) return { status: 'review-required', error: 'reply_kind_required' }
      const preflight = () => {
        refreshVisibleReads(request)
        if (pendingInputAt(groupId, request.inputSequence, (request.task.topicRefs ?? []).map(ref => ref.topicId)).length) return { status: 'routing-required' }
        const current = store.getTask(request.task.taskId)
        if (!current || current.inputVersion !== request.task.inputVersion || current.runSequence !== request.task.runSequence || current.state !== request.resultState || JSON.stringify(current.result) !== request.resultFingerprint) {
          void supersedeRequest(request, undefined, 'task-result-context-changed')
          replies.delete(args.requestId); request.reject(new Error('task_result_context_changed')); return { status: 'task-stale' }
        }
        const unreadSections = [...request.requiredSections].filter((section) => (request.readSectionOffsets.get(section) ?? 0) < request.sections[section].length)
        if (unreadSections.length) return { status: 'context-review-required', unreadSections }
        if (request.observedTopics.some((ref) => store.getTopic(groupId, ref.topicId)?.revision !== ref.revision)) {
          request.observedTopics = current.topicRefs.map((ref) => ({ topicId: ref.topicId, revision: store.getTopic(groupId, ref.topicId).revision }))
          refreshReview(request); request.readReview = false
          return { status: 'topic-stale', topics: request.observedTopics }
        }
        if (current.topicRefs.some((ref) => { const topic = store.getTopic(groupId, ref.topicId); return topic.processedRevision < topic.revision })) return { status: 'topic-pending' }
        if (refreshReview(request) || (request.candidates.length && !request.readReview)) return { status: 'review-required' }
      }
      const rejected = preflight()
      if (rejected) { await schedule(groupId); return rejected }
      const task = store.getTask(request.task.taskId)
      let replyReview
      try { replyReview = validateReplyReview(args.replyReview, request.candidates, { confirmationTaskIds: [task.taskId] }) } catch (error) { return { status: 'review-required', error: error.message } }
      const { target, recipients, atAll } = replyRouting(request.messages, args.replyToMessageId, args.atOpenDingTalkIds, args.atAll)
      const outbound = { groupId, outboundId: request.outboundId ?? `reply-${args.requestId}`, sourceMessageId: request.resultKey, resultFingerprint: fingerprint(request.task.result), text: args.reply.trim(), taskIds: [task.taskId], taskInputVersion: task.inputVersion, taskRunSequence: task.runSequence, topicRefs: task.topicRefs,
        matterSourceMessageIds: [...new Set(request.messages.map((message) => message.messageId))], matterUnitRefs: request.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })),
        replyKind: replyReview?.kind, replacesOutboundIds: replyReview?.replaceOutboundIds,
        ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.senderOpenDingTalkId } : {}), atOpenDingTalkIds: recipients, ...(atAll ? { atAll } : {}) }
      // 对外调用在短状态提交之后；独立通知的失败不消费其他 Topic 请求。
      const persisted = await appendOutbox({ ...outbound, preflight })
      if (persisted?.status) { await schedule(groupId); return persisted }
      await store.updateCoordinationRequest?.(groupId, args.requestId, { status: 'completed', nextRetryAt: undefined, lastError: undefined })
      replies.delete(args.requestId); request.resolve(outbound)
      return { status: 'accepted', outboundId: outbound.outboundId }
    })
    tool('group_task_review_submit', '提交内部完成、等待或检查点审阅；请求绑定执行版本，不能产生群消息。', toToolJsonSchema(reviewSubmissionSchema(scope?.kind)), async ({ requestId, review: input }) => {
      const request = reviews.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('task_review_request_unknown')
      const task = store.getTask(request.task.taskId)
      const diagnostic = diagnosticCheckpoint(request)
      refreshVisibleReads(request)
      if (!task || task.inputVersion !== request.task.inputVersion || task.runSequence !== request.task.runSequence || task.checkpoints?.at(-1)?.checkpointId !== request.task.checkpoints?.at(-1)?.checkpointId || (!diagnostic && JSON.stringify(task.taskPromptRefs ?? []) !== JSON.stringify(request.promptRefs))) { await supersedeRequest(request, undefined, 'task-review-context-changed'); reviews.delete(requestId); request.reject(new Error('task_review_context_changed')); return { status: 'task-stale' } }
      try {
        if (!diagnostic) {
          assertCurrentTaskPrompts(task, store.getTaskPrompts?.() ?? [])
          assertCurrentTaskPrompts({ taskPromptRefs: [...request.readPromptRefs.values()] }, store.getTaskPrompts?.() ?? [])
          assertCurrentTaskPrompts({ taskPromptRefs: [...request.readPromptVersions.values()] }, store.getTaskPrompts?.() ?? [])
        }
      } catch (error) { await supersedeRequest(request, undefined, error.message); reviews.delete(requestId); request.reject(error); return { status: 'task-stale', error: error.message } }
      const missingPromptRefs = diagnosticCheckpoint(request) ? [] : request.promptRefs.filter((ref) => !request.readPromptRefs.has(ref.id))
      if (missingPromptRefs.length) return { status: 'prompt-review-required', missingPromptRefs }
      if ((request.kind === 'completion') !== Object.hasOwn(input ?? {}, 'accepted')) throw new Error('task_review_kind_invalid')
      const review = reviewSchemas[request.kind].parse(input)
      const unreadSections = [...request.requiredSections].filter((section) => (request.readSectionOffsets.get(section) ?? 0) < request.sections[section].length)
      if (!diagnostic && unreadSections.length && (review.accepted === true || ['acknowledge', 'guidance', 'approve-wait', 'revise-scope'].includes(review.decision))) return { status: 'context-review-required', unreadSections }
      if (request.kind === 'waiting' && review.decision === 'approve-wait') {
        const sourceIds = new Set(taskMessages(task).map(message => message.messageId))
        if (!request.value.blockedItems?.length || request.value.blockedItems.some(item => item.basisMessageIds.some(id => !sourceIds.has(id))
          || item.stageId && !task.stagePlan?.some(stage => stage.stageId === item.stageId))) throw new Error('task_waiting_blocked_items_invalid')
      }
      if (request.kind === 'waiting' && review.decision === 'revise-scope') {
        const sourceIds = new Set(taskMessages(task).map(message => message.messageId))
        if (review.basisMessageIds.some(id => !sourceIds.has(id))) throw new Error('task_waiting_scope_basis_invalid')
      }
      if ('decision' in review && ((review.decision === 'guidance' && !review.guidance) || (review.decision !== 'guidance' && review.guidance))) throw new Error('task_review_guidance_invalid')
      if ('decision' in review && review.decision === 'reject' && request.value.kind !== 'plan-confirmed') throw new Error('task_review_reject_plan_only')
      if (reviewRequestIdentity(request.kind, diagnostic ? { ...task, taskPromptRefs: request.promptRefs } : task, request.value) !== requestId) { await supersedeRequest(request, undefined, 'task-review-context-changed'); reviews.delete(requestId); request.reject(new Error('task_review_context_changed')); return { status: 'task-stale' } }
      if (request.kind === 'completion' && review.accepted) {
        const rejected = completionPreflight(request, task, request.value, request.task.state === 'waiting' ? 'waiting' : 'running', false)
        if (rejected) return rejected
        const draft = notificationDraftSchema.safeParse(review.notification)
        delete review.notification
        if (draft.success) {
          // 业务验收与通知分开；草稿的来源/替换关系失败时只重做通知。
          try {
            if (!completionPreflight(request, task, request.value, request.task.state === 'waiting' ? 'waiting' : 'running')) {
              const outbound = taskOutbound(request, task, draft.data)
              review.notification = draft.data
              Object.defineProperty(review, 'preparedNotification', { value: { request, outbound, fence: notificationFence(request) }, enumerable: false })
            }
          } catch { /* 下游通知意图保存为 pending，随后独立生成合法草稿。 */ }
        }
      }
      const durableReview = jsonOutput(review)
      await serializeTasks(() => store.updateTask(task.taskId, current => {
        if (reviewRequestIdentity(request.kind, diagnostic ? { ...current, taskPromptRefs: request.promptRefs } : current, request.value) !== requestId) throw new Error('task_review_context_changed')
        const accepted = current.executionEvents?.find(event => event.kind === 'coordination-review-accepted' && event.requestId === requestId)
        if (accepted) {
          if (fingerprint(accepted.review) !== fingerprint(durableReview)) throw new Error('task_review_response_conflict')
          return current
        }
        return { ...current, executionEvents: [...(current.executionEvents ?? []), { kind: 'coordination-review-accepted', requestId, review: durableReview, inputVersion: task.inputVersion, runSequence: task.runSequence, at: new Date().toISOString() }] }
      }))
      await store.updateCoordinationRequest?.(groupId, requestId, { status: 'completed', nextRetryAt: undefined, lastError: undefined })
      reviews.delete(requestId); request.resolve(review)
      return { status: 'accepted' }
    })
  }
  function completionPreflight(request, task, result, expectedState, notification = true) {
    if (pendingInputAt(request.groupId, request.inputSequence, (task.topicRefs ?? []).map(ref => ref.topicId)).length) return { status: 'routing-required' }
    const current = store.getTask(task.taskId)
    if (!current || current.inputVersion !== request.task.inputVersion || current.runSequence !== request.task.runSequence || current.state !== expectedState || JSON.stringify(current.taskPromptRefs ?? []) !== JSON.stringify(request.promptRefs)
      || (expectedState === 'completed' && JSON.stringify(current.result) !== JSON.stringify(result))) return { status: 'task-stale' }
    if (request.observedTopics.some((ref) => store.getTopic(request.groupId, ref.topicId)?.revision !== ref.revision)) return { status: 'topic-stale' }
    if (current.topicRefs.some((ref) => { const topic = store.getTopic(request.groupId, ref.topicId); return topic.processedRevision < topic.revision })) return { status: 'topic-pending' }
    if (notification && (refreshReview(request, expectedState === 'completed') || (request.candidates.length && !request.readReview))) return { status: 'review-required' }
  }
  function taskOutbound(request, task, draft) {
    const replyReview = validateReplyReview(draft.replyReview, request.candidates, { confirmationTaskIds: [task.taskId] })
    const { target, recipients, atAll } = replyRouting(request.messages, draft.replyToMessageId, draft.atOpenDingTalkIds, draft.atAll)
    const sources = taskMessages(task)
    return { groupId: task.groupId, outboundId: `reply-${request.requestId}`, sourceMessageId: request.resultKey, resultFingerprint: fingerprint(request.value), text: draft.reply.trim(), taskIds: [task.taskId], taskInputVersion: task.inputVersion, taskRunSequence: task.runSequence, topicRefs: task.topicRefs,
      matterSourceMessageIds: [...new Set(sources.map((message) => message.messageId))], matterUnitRefs: sources.map(({ unitId, unitRevision }) => ({ unitId, unitRevision })),
      replyKind: replyReview.kind, replacesOutboundIds: replyReview.replaceOutboundIds,
      ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.senderOpenDingTalkId } : {}), atOpenDingTalkIds: recipients, ...(atAll ? { atAll } : {}) }
  }
  function notificationFence(request) {
    return { observedTopics: request.observedTopics, outboxFingerprint: fingerprint(store.getGroup(request.groupId)?.outbox ?? []) }
  }
  async function commitCompletionNotification(prepared, task, result) {
    if (!prepared) return { status: 'notification-missing' }
    const { request, outbound } = prepared
    const preflight = () => completionPreflight(request, task, result, 'completed')
    const rejected = preflight()
    if (rejected) { await schedule(task.groupId); return rejected }
    const persisted = await appendOutbox({ ...outbound, preflight })
    if (persisted?.status) { await schedule(task.groupId); return persisted }
    return outbound
  }
  function prepareReview(kind, task, value) {
    const requestId = reviewRequestIdentity(kind, task, value)
    const messages = taskMessages(task)
    const messageContext = boundedTopicContext({ topic: {}, messages: [...messages].reverse().slice(0, COMPLETION_MESSAGE_MAX_COUNT), offset: 0, total: messages.length, taskRefs: [] }, { maxChars: COMPLETION_MESSAGE_MAX_CHARS })
    const visibleMessages = messageContext.messages.reverse()
    const promptRefs = [...(task.taskPromptRefs ?? [])]
    const promptCatalog = (store.getTaskPrompts?.() ?? []).filter((item) => item.enabled).map(({ id, name, description, revision }) => ({ id, name, description, revision }))
    const selection = task.executionEvents?.findLast((event) => event.kind === 'task-prompts-selected' && event.inputVersion === task.inputVersion)
    const request = { requestId, groupId: task.groupId, task, kind, value, inputSequence: latestSequence(task.groupId),
      promptRefs, promptCatalog, readPromptRefs: new Map(), readPromptVersions: new Map(), sections: {}, readSectionOffsets: new Map(), requiredSections: new Set(),
      ...(kind === 'completion' ? { resultKey: `task-result:${task.taskId}:completed${(task.completionSequence ?? 0) > 0 ? `:${task.completionSequence}` : ''}`, messages,
        candidates: scopedCandidates(task.groupId, messages, task.topicRefs, [task.taskId]), readReview: false,
        observedTopics: task.topicRefs.map((ref) => ({ topicId: ref.topicId, revision: store.getTopic(task.groupId, ref.topicId).revision })) } : {}) }
    refreshVisibleReads(request)
    const inline = (...args) => inlineCurrentSection(request, ...args)
    const label = kind === 'completion' ? '[TASK_COMPLETION_REVIEW]' : kind === 'waiting' ? '[TASK_WAITING_REVIEW]' : '[TASK_CHECKPOINT_REVIEW]'
    const reviewInfo = { requestId: request.requestId, kind, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, promptRefs: inline('promptRefs', promptRefs, 2_000, !diagnosticCheckpoint(request)), visiblePromptRefs: [...request.readPromptRefs.values()] }
    request.sections.messages = JSON.stringify(messages)
    const context = { topicRefs: inline('topicRefs', task.topicRefs), messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: messageContext.hasMoreMessages, messagesSection: 'messages', ...(kind === 'completion' ? { replyReviewCandidateCount: request.candidates.length } : {}) }
    const originalContext = `\n${kind === 'completion' ? '通知上下文' : '任务原始上下文'}：${JSON.stringify(context)}`
    const instruction = kind === 'completion'
      ? "完成审阅拒绝：{accepted:false,reason:string}。完成审阅通过：{accepted:true,reason:string,notification:{reply:string,replyReview:{kind,reviewedOutboundIds,sameMatterOutboundIds,replaceOutboundIds},replyToMessageId?:string,atOpenDingTalkIds?:string[]}}。当前 Agent 的交付及必要自验证完成即可通过；他人后续检查不构成完成条件。可以同时准备群通知，notification为可选且独立校验；通知草稿缺失或不合法不影响业务验收，通过后Host会单独恢复通知；按通知上下文选择收件人；确需引用时选择 replyToMessageId，并把作者计入收件人，省略 atOpenDingTalkIds 时默认提醒作者。没有合适引用或需避免隐式提及叠加时可不引用，显式填写 atOpenDingTalkIds。存在历史回复候选时先用 group_reply_review_get 读取当前请求。通知保留实际完成内容、交付状态和未验证边界。"
      : kind === 'waiting'
        ? "等待审阅：真实必要依赖用 {decision:'approve-wait',reason:string}；可自行继续用 {decision:'continue',reason:string}；已完成自身工作、仅等他人后续检查时用 {decision:'revise-scope',reason:string,basisMessageIds:string[],affectedStageIds:string[],title:string,objective:string,acceptanceCriteria:string[],stageTasks:string[]}。revise-scope 必须以原始消息明确的本 Agent 交付重写完整目标、验收和剩余阶段，并用 affectedStageIds 指明旧阶段中从哪一项起受影响，保留之前有效的证据；不要把实际未完成的本职工作删去。只有 blockedItems 中确有当前 Agent 尚未完成的交付，且所列依赖必要，才可 approve-wait。先核对仍可独立完成的阶段、已尝试的取证入口及失败证据，不能从一个入口不可用推断所有入口不可用；不得把排查方法扩大成原始要求。审阅不代替业务完成，也不得因为没有 blockedItems 批准等待。"
        : `检查点审阅：{decision:'acknowledge'|'guidance'|'reject',reason:string,guidance?:string}。计划与原始消息或任务流程冲突时必须 reject；只有原始消息明确支持的 workflowAssessment.exceptions 才能覆盖流程。`
    const unreadPrompts = promptRefs.filter((ref) => !request.readPromptRefs.has(ref.id))
    const promptInstruction = diagnosticCheckpoint(request) ? '这是异常报告，即使未选流程、旧流程过期或未读完也必须保持协调通道可用，不批准阶段推进。' : `${promptRefs.length ? (unreadPrompts.length ? `按 requestId 用 group_task_prompt_get 批量读取尚不可见的流程 ${JSON.stringify(unreadPrompts)}；visiblePromptRefs 指明当前 surface 中已具备正文的流程，无需重读。` : `全部已选流程正文仍在当前 surface 中，直接复用 visiblePromptRefs，不再调用 group_task_prompt_get。`) : '当前未选择专用流程，需结合索引核查是否确无匹配。'}核查选择原因和可用流程索引；如需读取未选候选，也应合并到一次批量调用。若漏选适用流程应要求重新规划，允许多个流程组合，也允许有明确理由的无匹配。`
    const contextInstruction = diagnosticCheckpoint(request) ? '异常报告的 section 原文按需续读，不以读完索引或旧流程作为协调前提。' : '通过审阅前必须读完超限的目标、验收、阶段、待审阅内容和流程索引。'
    const text = `${label}\n审阅请求：${JSON.stringify(reviewInfo)}\nTask ID: ${task.taskId}\n当前有效目标：${JSON.stringify(inline('objective', task.objective))}\n验收标准：${JSON.stringify(inline('acceptanceCriteria', task.acceptanceCriteria))}\n本轮阶段任务：${JSON.stringify(inline('stageTasks', task.stageTasks))}\n当前事实与审批快照：${JSON.stringify(inline('currentFacts', taskProgressSnapshot(task, { maxItems: 3 }), 6_000))}\n待审阅内容：${JSON.stringify(inline('value', value))}${originalContext}\n可用流程索引：${JSON.stringify(inline('promptIndex', promptCatalog, 6_000))}\n流程选择依据：${JSON.stringify(inline('promptSelection', { reason: selection?.reason ?? '未记录显式选择原因；请结合目标与索引核实是否漏选', promptRefs: selection?.taskPromptRefs ?? promptRefs }))}\n${promptInstruction}\nmaterialRef 仅引用本请求另一 section 的精确正文与路径；原文不在首包时按 section 读取。遇到 section 指针用 group_task_review_context_get 按 nextOffset 续读完整 JSON；${contextInstruction}更多消息可用 messages section 或固定 Topic 版本原文分页读取。\n通过 group_task_review_submit 提交内部判断。${instruction}核对原始消息、当前授权、已选流程、计划和证据；主会话生成的目标或验收标准不能作为覆盖流程的例外依据。不用自然语言结束请求。`
    if (text.length > TASK_REVIEW_MAX_CHARS) throw new Error('task_review_envelope_too_large')
    return { request, text }
  }
  function requestReview(kind, task, value) {
    const requestId = reviewRequestIdentity(kind, task, value)
    const existing = reviews.get(requestId)
    if (existing) return existing.promise
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    let prepared
    try { prepared = prepareReview(kind, task, value) } catch (error) { reject(error); return promise }
    const { request, text } = prepared
    Object.assign(request, { resolve, reject, promise })
    try {
      const accepted = store.getTask(task.taskId)?.executionEvents?.find(event => event.kind === 'coordination-review-accepted' && event.requestId === requestId)
      if (accepted) {
        const restored = reviewSchemas[kind].parse(accepted.review)
        if (kind === 'completion' && restored.accepted) {
          // 原审阅与当前候选、Topic、流程身份相同，重新构造非持久的通知准备态。
          request.readReview = true
          const rejected = completionPreflight(request, task, value, request.task.state === 'waiting' ? 'waiting' : 'running', false)
          if (rejected) throw new Error(`task_review_context_changed:${rejected.status}`)
          if (restored.notification) {
            try { Object.defineProperty(restored, 'preparedNotification', { value: { request, outbound: taskOutbound(request, task, notificationDraftSchema.parse(restored.notification)), fence: notificationFence(request) }, enumerable: false }) }
            catch { delete restored.notification }
          }
        }
        void store.updateCoordinationRequest?.(task.groupId, requestId, { status: 'completed', nextRetryAt: undefined, lastError: undefined })
        resolve(restored)
        return promise
      }
      reviews.set(request.requestId, request)
      reviews.set(request.requestId, request)
      const agent = send(task.groupId, text, [], request)
      monitor(agent, request, reviews)
    } catch (error) { reviews.delete(request.requestId); reject(error) }
    return promise
  }
  function requestReply(task, result, resultKey) {
    const existing = [...replies.values()].find((request) => request.resultKey === resultKey && request.groupId === task.groupId)
    if (existing) return existing.promise
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    promise.catch(() => undefined)
    const messages = taskMessages(task)
    const messageContext = boundedTopicContext({ topic: {}, messages: [...messages].reverse().slice(0, COMPLETION_MESSAGE_MAX_COUNT), offset: 0, total: messages.length, taskRefs: [] }, { maxChars: COMPLETION_MESSAGE_MAX_CHARS })
    const visibleMessages = messageContext.messages.reverse()
    const request = { requestId: requestIdentity('reply', { groupId: task.groupId, resultKey, result, inputVersion: task.inputVersion, runSequence: task.runSequence }), groupId: task.groupId, task, resultKey, resultState: result.status === 'completed' ? 'completed' : 'waiting', resultFingerprint: JSON.stringify(result), messages, resolve, reject, promise, inputSequence: latestSequence(task.groupId),
      sections: { messages: JSON.stringify(messages) }, readSectionOffsets: new Map(), requiredSections: new Set(),
      candidates: scopedCandidates(task.groupId, messages, task.topicRefs, [task.taskId]), readReview: false,
      observedTopics: task.topicRefs.map((ref) => ({ topicId: ref.topicId, revision: store.getTopic(task.groupId, ref.topicId).revision })) }
    request.outboundId = task.notificationIntents?.find(intent => intent.sourceMessageId === resultKey && intent.resultFingerprint === fingerprint(result))?.outboundId
    replies.set(request.requestId, request)
    try {
      const inline = (...args) => inlineCurrentSection(request, ...args)
      const instruction = '通过 group_reply_submit 提交结果或真实阻塞通知；保留实际完成内容、证据、交付状态和未验证边界。'
      const text = `[TASK_COORDINATION]\n回复请求 ID：${request.requestId}\nTask ID: ${task.taskId}\nTopic 请求：${JSON.stringify({ requestId: request.requestId, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, topicRefs: inline('topicRefs', task.topicRefs), messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: messageContext.hasMoreMessages, messagesSection: 'messages', replyReviewCandidateCount: request.candidates.length })}\n当前目标：${JSON.stringify(inline('objective', task.objective))}\n核验结果：${JSON.stringify(inline('result', result))}\n${instruction}先按 requestId 读取 ${request.candidates.length} 条历史回复候选。materialRef 仅引用本请求另一 section 的精确正文与路径；原文不在首包时按 section 读取。遇到 section 指针用 group_task_review_context_get 按 nextOffset 续读完整 JSON；提交前读完超限目标、核验结果和 Topic 引用。更多消息可用 messages section 或固定 Topic 版本原文分页读取。`
      if (text.length > TASK_REVIEW_MAX_CHARS) throw new Error('task_review_envelope_too_large')
      const agent = send(task.groupId, text, [], request)
      monitor(agent, request, replies)
    } catch (error) { replies.delete(request.requestId); reject(error) }
    return promise
  }
  async function retryRequest(groupId, requestId, validateSnapshot) {
      const collection = [routes, decisions, reviews, replies, titleMigrations, summaryMigrations].find((items) => items.get(requestId)?.groupId === groupId)
      const request = collection?.get(requestId)
      if (!request) throw new Error('topic_request_unknown_or_wrong_group')
      validateSnapshot?.()
      if (!request.exhausted) return { status: 'pending', requestId }
      await store.updateCoordinationRequest(groupId, requestId, { status: 'pending', attempt: 0, resumeEpoch: (store.getCoordinationRequest(groupId, requestId)?.resumeEpoch ?? 0) + 1, nextRetryAt: new Date().toISOString(), lastError: undefined }, validateSnapshot)
      if (!isCurrentRequest(request)) throw new Error('MESSAGE_RETRY_STALE')
      request.exhausted = false; request.attempt = 0
      if (request.reject) {
        collection.delete(requestId)
        const promise = collection === reviews ? requestReview(request.kind, store.getTask(request.task.taskId), request.value) : requestReply(store.getTask(request.task.taskId), JSON.parse(request.resultFingerprint), request.resultKey)
        promise.catch((error) => onError(groupId, error))
      } else monitor(send(groupId, request.text, request.images, request), request, collection)
      return { status: 'pending', requestId }
    }
  function messageProcessingRequests(groupId) {
      const group = store.getGroup(groupId)
      if (!group) return []
      const result = []
      for (const request of [...routes.values(), ...decisions.values()]) {
        if (request.groupId !== groupId) continue
        const state = store.getCoordinationRequest?.(groupId, request.requestId)
        if (['completed', 'superseded'].includes(state?.status)) continue
        const topic = request.topicId ? group.topics.find(item => item.topicId === request.topicId) : null
        if (request.topicId && (!topic || topic.mergedInto || topic.revision !== request.revision || topic.processedRevision >= request.revision)) continue
        const entries = new Map()
        for (const entry of topic?.entries ?? []) if (entry.revision <= request.revision) entries.set(entry.unitId ?? `legacy:${entry.messageId}`, entry)
        const delta = [...entries.values()].filter(entry => entry.action === 'add' && entry.revision > topic.processedRevision)
        const messages = request.messages.filter(message => {
          const current = group.messages.find(item => item.messageId === message.messageId && item.messageVersion === message.messageVersion)
          if (!current || current.ownNotificationRetirement) return false
          if (!topic) return current.routingStatus !== 'routed'
          return current.routingStatus === 'routed'
            && (!Array.isArray(current.activeUnitRefs) || current.activeUnitRefs.some(ref => ref.unitId === message.unitId && ref.unitRevision === message.unitRevision))
            && delta.some(entry => entry.messageId === message.messageId && entry.messageVersion === message.messageVersion
              && (!entry.unitId || entry.unitId === message.unitId && entry.unitRevision === message.unitRevision))
        }).map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
          ...(message.unitId !== undefined ? { unitId: message.unitId, unitRevision: message.unitRevision } : {}) }))
        if (!messages.length) continue
        result.push({ requestId: request.requestId, groupId,
          ...(topic ? { topicId: topic.topicId, revision: request.revision } : {}),
          status: state?.status ?? (request.exhausted ? 'exhausted' : 'pending'), attempt: state?.attempt ?? request.attempt ?? 0,
          failurePhase: state?.failurePhase ?? (state?.status === 'exhausted' && state.attempt === 0 && !state.messageId ? 'startup' : null),
          nextRetryAt: state?.nextRetryAt ?? null, retryToken: requestRecoveryToken(request.requestId, state), messages })
      }
      return result
  }
  return {
    register, readReplyReview, schedule, prepareReview, requestReview, requestReply, commitCompletionNotification, taskMessages, applyAccepted: resume, isCurrentRequest, messageProcessingRequests,
    recordTaskContextRead(request, captured, result) {
      if (decisions.get(captured.requestId) !== request || request.revision !== captured.revision || request.versionRequestId !== captured.versionRequestId) return
      request.taskContextReads ??= new Map()
      request.taskContextReads.set(result.readId, { fingerprint: fingerprint(result), reviewFingerprint: result.replyReview ? fingerprint(request.candidates) : undefined, tasks: result.tasks.map(task => ({ taskId: task.taskId, text: JSON.stringify(task) })) })
      if (result.replyReview) request.readReview = false
    },
    async retryMessageRequest({ groupId, messageId, messageVersion, activeUnitRefs, requestId, token }) {
      const validate = () => {
        const message = store.getGroup(groupId)?.messages.find(item => item.messageId === messageId)
        const request = messageProcessingRequests(groupId).find(item => item.requestId === requestId && item.status === 'exhausted'
          && item.messages.some(source => source.messageId === messageId && source.messageVersion === messageVersion))
        const keys = refs => refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision])).sort()
        if (!message || message.messageVersion !== messageVersion || !request || request.retryToken !== token
          || JSON.stringify(keys(message.activeUnitRefs ?? [])) !== JSON.stringify(keys(activeUnitRefs))) throw new Error('MESSAGE_RETRY_STALE')
      }
      validate()
      return retryRequest(groupId, requestId, validate)
    },
    async resetReviewRequest(groupId, requestId) {
      const state = store.getCoordinationRequest?.(groupId, requestId)
      const request = reviews.get(requestId) ?? replies.get(requestId)
      if (!store.getGroup(groupId) || request && request.groupId !== groupId || !state && !request) throw new Error('topic_request_unknown_or_wrong_group')
      if (state?.status !== 'exhausted' && !request?.exhausted) return { status: 'pending', requestId }
      await store.updateCoordinationRequest(groupId, requestId, { status: 'pending', attempt: 0, resumeEpoch: (state?.resumeEpoch ?? 0) + 1, nextRetryAt: new Date().toISOString(), lastError: undefined })
      reviews.delete(requestId)
      replies.delete(requestId)
      return { status: 'reset', requestId }
    },
    getReadOnlyDecisionContext(groupId, requestId) {
      const request = decisions.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('topic_request_unknown_or_wrong_group')
      refreshReview(request)
      const topic = store.getTopic(groupId, request.topicId)
      const deltaIds = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= request.revision).map(unitKey))
      return structuredClone({ requestId, groupId, topicId: request.topicId, revision: request.revision, messages: request.visibleMessages,
        deltaUnitRefs: request.messages.filter((message) => deltaIds.has(unitKey(message))).map(({ unitId, unitRevision }) => ({ unitId, unitRevision })),
        deltaMessageIds: [...new Set(request.messages.filter((message) => deltaIds.has(unitKey(message))).map((message) => message.messageId))],
        policyContext: { responsibility: store.getGroup(groupId).responsibility, agentNames: store.getAgentNames(), ...(request.personAliases?.length ? { personAliases: request.personAliases, personAliasGuide: personAliasInstructions } : {}) },
        hasOmittedMessages: topic.processedRevision > topic.summaryRevision || request.hasSourceContext || request.requiredSections.size > 0 || !request.inlineDelta && request.messages.some((message) => deltaIds.has(unitKey(message)) && !request.readUnitRefs.has(unitKey(message))),
        summary: topic.summary, candidates: request.candidates, candidateFingerprint: fingerprint(request.candidates) })
    },
    async submitReadOnlyDecision(groupId, input, candidateFingerprint, validateSnapshot) {
      if (!live()) throw new Error('resident_runtime_closed')
      const args = groupDecisionSubmissionSchema.parse(input)
      if (typeof validateSnapshot !== 'function') throw new Error('read_only_snapshot_validator_required')
      if (args.decision.actions.length || args.decision.replyReview?.kind === 'confirmation') throw new Error('read_only_decision_action_forbidden')
      const request = decisions.get(args.requestId)
      if (!request || request.groupId !== groupId) return { status: 'topic-stale' }
      refreshReview(request)
      if (candidateFingerprint !== fingerprint(request.candidates)) return { status: 'review-required' }
      const submit = decisionSubmitters.get(groupId)
      if (!submit) throw new Error('resident_tools_not_registered')
      if (request.inlineDelta) {
        const topic = store.getTopic(groupId, request.topicId)
        if (!topic || topic.revision !== request.revision) return { status: 'topic-stale' }
        const delta = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= request.revision).map(unitKey))
        for (const message of request.messages) if (delta.has(unitKey(message))) request.readUnitRefs.add(unitKey(message))
      }
      request.readReview = true
      request.statusQueryRead = true
      try { return jsonOutput(await submit(args, { validateSnapshot })) }
      finally { request.statusQueryRead = false }
    },
    retryRequest,
    invalidateTaskReviews(taskId, reason = 'task_review_context_changed') {
      for (const [requestId, request] of reviews) {
        if (request.task.taskId !== taskId) continue
        void supersedeRequest(request, undefined, reason)
        reviews.delete(requestId)
        request.reject(new Error(reason))
      }
    },
    hasPendingTaskInput(task) {
      const group = store.getGroup(task.groupId)
      return pendingFor(task.groupId, (task.topicRefs ?? []).map(ref => ref.topicId)).length > 0 || (group?.taskReservations ?? []).some((item) => item.taskId === task.taskId)
        || task.topicRefs.some((ref) => { const topic = store.getTopic(task.groupId, ref.topicId); return !topic || topic.processedRevision < topic.revision })
    },
    async retryOperation({ groupId, topicId, decisionId, operationId, resolution, reason, validateSnapshot }) {
      validateSnapshot?.()
      if (!reason?.trim() || !['not-applied', 'applied', 'reconsider'].includes(resolution)) throw new Error('decision_recovery_evidence_required')
      if (resolution === 'reconsider') {
        if (applying.has(decisionId)) throw new Error('decision_recovery_not_blocked')
        const result = await store.reconsiderBlockedTopicDecision({ groupId, topicId, decisionId, operationId, reason })
        await schedule(groupId)
        return result
      }
      const record = store.getTopic(groupId, topicId)?.decisions.find(item => item.decisionId === decisionId)
      if (!record || record.status !== 'blocked' || applying.has(decisionId)) throw new Error('decision_recovery_not_blocked')
      if (operationId !== record.failureOperationId) throw new Error('decision_recovery_wrong_failed_operation')
      const operation = record.operations.find(item => item.operationId === operationId)
      if (!operation && operationId !== record.outboundId) throw new Error('decision_recovery_operation_unknown')
      const action = operation && record.decision.actions[operation.actionIndex]
      const task = operation && store.getTask(operation.taskId)
      const applied = operation ? store.getTask(operation.taskId)?.appliedOperations?.includes(operationId) : store.getGroup(groupId).outbox.some(item => item.outboundId === operationId)
      if (!applied && action && action.kind !== 'new-task' && (!task || task.stopRequest || task.inputVersion !== action.inputVersion || task.runSequence !== action.runSequence)) throw new Error('decision_recovery_task_stale')
      if (resolution === 'applied' && !applied || resolution === 'not-applied' && applied) throw new Error('decision_recovery_evidence_conflict')
      await store.updateTopicDecision({ groupId, topicId, decisionId, expectedStatus: 'blocked', validateSnapshot, patch: {
        status: 'accepted', retryBaseAttempt: record.attempt ?? 0, nextRetryAt: undefined, recoveryReason: reason.trim(),
        operations: record.operations.map(item => item.operationId === operationId ? { ...item, status: applied ? 'applied' : 'pending', recoveryResolution: resolution, recoveryReason: reason.trim() } : item),
      } })
      return resume(groupId, topicId, decisionId)
    },
    async retryMessage(groupId, messageId) {
      const group = store.getGroup(groupId)
      if (!group?.messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      for (const collection of [routes, decisions]) for (const [id, request] of collection) {
        if (request.groupId !== groupId || !request.messages.some((message) => message.messageId === messageId)) continue
        await store.updateCoordinationRequest(groupId, id, { status: 'pending', attempt: 0, resumeEpoch: (store.getCoordinationRequest(groupId, id)?.resumeEpoch ?? 0) + 1, nextRetryAt: new Date().toISOString(), lastError: undefined })
        collection.delete(id)
      }
      for (const topic of group.topics.filter((item) => item.entries.some((entry) => entry.messageId === messageId))) {
        for (const record of topic.decisions.filter((item) => item.status === 'failed')) {
          retries.delete(record.decisionId)
          const timer = retryTimers.get(record.decisionId)
          if (timer) { clearTimeout(timer); timers.delete(timer); retryTimers.delete(record.decisionId) }
        }
      }
      return schedule(groupId)
    },
    async recover() {
      const result = await Promise.all(store.listGroups().map(group => schedule(group.groupId)))
      for (const collection of collections) for (const request of collection.values()) {
        const state = store.getCoordinationRequest?.(request.groupId, request.requestId)
        if (state?.status !== 'exhausted' || state.messageId || !request.exhausted || request.monitoring) continue
        // 旧记录无messageId且attempt=0，证明尚未得到Agent并持久登记派发输入。
        if (state.failurePhase !== 'startup' && !(state.failurePhase === undefined && state.attempt === 0 && !state.messageId)) continue
        if (Date.parse(state.nextRetryAt ?? '') > Date.now() || request.startupRecovering) continue
        request.startupRecovering = true
        try {
          if (checkStartupRecovery && !await checkStartupRecovery(request.groupId, request.requestId)) continue
          await retryRequest(request.groupId, request.requestId)
        } finally { request.startupRecovering = false }
      }
      return result
    },
    async drain(groupId) {
      await Promise.allSettled([...scheduled.entries()].filter(([id]) => !groupId || id === groupId).map(([, value]) => value))
      await Promise.allSettled([...applying.values()].filter((item) => !groupId || item.groupId === groupId).map((item) => item.promise))
    },
    pause(groupId) {
      groupsBeingChanged.set(groupId, (groupsBeingChanged.get(groupId) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = groupsBeingChanged.get(groupId) - 1
        if (remaining > 0) groupsBeingChanged.set(groupId, remaining)
        else { groupsBeingChanged.delete(groupId); schedule(groupId) }
      }
    },
    async close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear(); retryTimers.clear(); retries.clear()
      await Promise.allSettled([...activeToolCalls])
      for (const request of [...reviews.values(), ...replies.values()]) request.reject(new Error('resident_runtime_closed'))
      for (const collection of collections) for (const request of collection.values()) retire(request)
      routes.clear(); decisions.clear(); reviews.clear(); replies.clear(); titleMigrations.clear(); summaryMigrations.clear()
      await Promise.allSettled([...applying.values()].map((item) => item.promise))
    },
  }
}
