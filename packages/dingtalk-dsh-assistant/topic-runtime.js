import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveTopicMessages } from './store.js'
import { fingerprint } from './topic-model.js'
import { blockTaskDecisionForUnavailableMedia, groupDecisionSubmissionSchema, groupDecisionSubmissionJsonSchema, topicRouteSubmissionSchema, topicRouteSubmissionJsonSchema, isDirectedToOtherParticipants, isExplicitAgentDirection, replyReviewJsonSchema, TOPIC_TITLE_MAX_CHARS } from './decision.js'

const textMessage = (text, images = []) => Object.freeze({ id: randomUUID(), role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text }, ...images.map((attachment) => ({ type: 'image', attachment }))] })
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
const invalidArguments = (error) => ({
  status: 'invalid-arguments',
  issues: error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.') || '$', message: issue.message })),
  nextAction: 'correct-arguments',
})
const sameVersions = (left, right) => left.length === right.length && left.every((item) => right.some((other) => other.messageId === item.messageId && other.messageVersion === item.messageVersion))
const topicIndex = (topics) => topics.map(({ topicId, title, revision, processedRevision, status, summary }) => ({ topicId, title, revision, processedRevision, status, summary: summary?.slice(0, 240) }))
const boundedItems = (items, maxChars, maxCount, required = () => false) => {
  const selected = items.filter(required)
  for (const item of items) {
    if (selected.includes(item) || selected.length >= maxCount) continue
    if (selected.length > 0 && JSON.stringify([...selected, item]).length > maxChars) break
    selected.push(item)
  }
  return selected
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
  const messages = [], completedMessageIds = []
  let nextOffset = projected.offset, nextTextOffset
  const output = () => ({ ...base, messages, completedMessageIds, nextOffset, ...(nextTextOffset === undefined ? {} : { nextTextOffset }), hasMoreMessages: nextOffset < projected.total || nextTextOffset !== undefined })
  if (JSON.stringify(output()).length > maxChars) throw new Error('topic_context_metadata_too_large')
  for (let index = 0; index < projected.messages.length; index++) {
    const message = projected.messages[index]
    const start = index === 0 ? textOffset : 0
    const text = String(message.text ?? '')
    if (start > text.length) throw new Error('topic_text_offset_invalid')
    const complete = { ...message, text: text.slice(start), ...(start > 0 ? { textOffset: start, textTotal: text.length, textHasMore: false } : {}) }
    messages.push(complete); completedMessageIds.push(message.messageId); nextOffset = projected.offset + index + 1; nextTextOffset = undefined
    if (JSON.stringify(output()).length <= maxChars) continue
    messages.pop(); completedMessageIds.pop(); nextOffset = projected.offset + index
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
    if (low === 0) break
    const end = start + low
    messages.push({ ...message, text: text.slice(start, end), textOffset: start, textTotal: text.length, textHasMore: end < text.length })
    nextTextOffset = end
    break
  }
  const result = output()
  if (JSON.stringify(result).length > maxChars) throw new Error('topic_context_budget_exceeded')
  return result
}
const reviewSchema = z.union([
  z.strictObject({ accepted: z.boolean(), reason: z.string().trim().min(1) }),
  z.strictObject({ decision: z.enum(['acknowledge', 'guidance']), reason: z.string().trim().min(1), guidance: z.string().trim().min(1).optional() }),
])

export function projectTopicContext(context) {
  const { topicId, title, revision, processedRevision, status, summary, summaryRevision, openQuestions } = context.topic
  const pending = context.topic.decisions?.findLast((decision) => decision.status !== 'completed')
  const processing = pending ? { decisionId: pending.decisionId, status: pending.status, appliedOperations: pending.operations.filter((operation) => operation.status === 'applied').length, totalOperations: pending.operations.length, ...(pending.error ? { error: pending.error.slice(0, 1000) } : {}) } : undefined
  return JSON.parse(JSON.stringify({ ...context, topic: { topicId, title, revision, processedRevision, status, ...(summary === undefined ? {} : { summary }), summaryRevision, openQuestions, ...(processing ? { processing } : {}) } }))
}

// 请求是可丢弃的模型输入；已经接受的业务意图只以 Store 中的 decision 为准。
export function createTopicCoordinator({ store, getAgent, assertSession, serializeTasks, applyAction, appendOutbox, reviewCandidates, validateReplyReview, cancelTask, onError, isClosing, retryDelayMs = 1000 }) {
  const routes = new Map(), decisions = new Map(), replies = new Map(), reviews = new Map(), titleMigrations = new Map(), summaryMigrations = new Map()
  const activeToolCalls = new Set()
  const scheduled = new Map(), applying = new Map(), timers = new Set(), retries = new Map(), retryTimers = new Map(), groupsBeingChanged = new Map()
  let closed = false
  const live = () => !closed && !isClosing()
  const topicMessages = (groupId, topicId, revision) => resolveTopicMessages(store.getGroup(groupId), topicId, revision)
  const taskMessages = (task) => [...new Map(task.topicRefs.flatMap((ref) => topicMessages(task.groupId, ref.topicId, ref.revision)).map((message) => [`${message.messageId}:${message.messageVersion}`, message])).values()]
  const scopedCandidates = (groupId, messages, topicRefs, focusTaskIds = []) => {
    const topicIds = new Set(topicRefs.map((ref) => ref.topicId))
    const sourceIds = new Set(messages.flatMap((message) => [message.messageId, message.quotedMessage?.messageId]).filter(Boolean))
    const taskIds = new Set([...focusTaskIds, ...store.listTasks().filter((task) => task.groupId === groupId && task.topicRefs.some((ref) => topicIds.has(ref.topicId))).map((task) => task.taskId)])
    return reviewCandidates(groupId, messages, [...taskIds]).filter((candidate) =>
      candidate.topicRefs?.some((ref) => topicIds.has(ref.topicId)) || candidate.taskIds?.some((id) => taskIds.has(id))
      || sourceIds.has(candidate.sourceMessageId) || candidate.sourceMessages?.some((message) => sourceIds.has(message.messageId)))
  }
  const refreshReview = (request) => {
    const candidates = scopedCandidates(request.groupId, request.messages, request.topicRefs ?? request.task.topicRefs, request.task ? [request.task.taskId] : [])
    const snapshot = (items) => JSON.stringify([...items].sort((left, right) => left.outboundId.localeCompare(right.outboundId)))
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
        if (!record.decision.actions.length && record.decision.replyReview?.kind !== 'confirmation') continue
        const basis = new Set(record.decision.basisMessageIds)
        for (const message of topicMessages(groupId, topic.topicId, record.revision)) {
          if (!basis.has(message.messageId)) continue
          const key = `${message.messageId}:${message.messageVersion}`
          consumedFacts.add(key)
          if (!ownerByFact.has(key)) ownerByFact.set(key, topic.topicId)
        }
      }
    }
    for (const topic of group.topics) {
      for (const message of topicMessages(groupId, topic.topicId, topic.revision)) {
        const key = `${message.messageId}:${message.messageVersion}`
        const entry = [...topic.entries].reverse().find((item) => item.revision <= topic.revision && item.messageId === message.messageId)
        if (!ownerByFact.has(key) && entry?.action === 'add' && entry.messageVersion === message.messageVersion && entry.effectOwner === true) ownerByFact.set(key, topic.topicId)
      }
    }
    // 旧数据没有显式主归属标记时保留原有稳定回退，新的多 Topic 路由必须显式指定。
    for (const topic of group.topics) {
      for (const message of topicMessages(groupId, topic.topicId, topic.revision)) {
        const key = `${message.messageId}:${message.messageVersion}`
        if (!ownerByFact.has(key)) ownerByFact.set(key, topic.topicId)
      }
    }
    const topic = group.topics.find((item) => item.topicId === topicId)
    const delta = new Set(topic.entries.filter((entry) => entry.action === 'add' && entry.revision > topic.processedRevision && entry.revision <= revision).map((entry) => `${entry.messageId}:${entry.messageVersion}`))
    return {
      effectOwnerTopicIds: Object.fromEntries(messages.map((message) => [message.messageId, ownerByFact.get(`${message.messageId}:${message.messageVersion}`)])),
      ownedDeltaMessageIds: messages.filter((message) => !consumedFacts.has(`${message.messageId}:${message.messageVersion}`) && ownerByFact.get(`${message.messageId}:${message.messageVersion}`) === topicId && delta.has(`${message.messageId}:${message.messageVersion}`)).map((message) => message.messageId),
    }
  }
  const pendingInput = (groupId) => (store.getGroup(groupId)?.messages ?? []).filter((message) => message.routingStatus !== 'routed')
  const unfinished = (topic) => topic.decisions.find((decision) => decision.status !== 'completed')
  const requestFor = (groupId, requestId) => {
    const request = decisions.get(requestId) ?? replies.get(requestId)
    if (!request || request.groupId !== groupId) throw new Error('topic_request_unknown_or_wrong_group')
    return request
  }
  const send = (groupId, text, images) => {
    if (!live()) throw new Error('resident_runtime_closed')
    const agent = getAgent(groupId)
    if (!agent) throw new Error(`resident_not_active:${groupId}`)
    agent.steer(textMessage(text, images))
    return agent
  }
  function monitor(agent, request, collection) {
    // whenIdle 只检测未提交请求，绝不用于提取业务结果。
    agent.whenIdle().then(() => {
      if (!live() || collection.get(request.requestId) !== request) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!live() || collection.get(request.requestId) !== request) return
        collection.delete(request.requestId)
        request.reject?.(new Error(`topic_request_not_submitted:${request.requestId}`))
        onError(request.groupId, new Error(`topic_request_not_submitted:${request.requestId}`))
        schedule(request.groupId)
      }, retryDelayMs)
      timer.unref?.()
      timers.add(timer)
    }).catch((error) => {
      if (collection.get(request.requestId) !== request) return
      collection.delete(request.requestId)
      request.reject?.(error)
      onError(request.groupId, error)
    })
  }
  function createDecisionRequest(groupId, topic) {
    for (const [id, request] of decisions) {
      if (request.groupId !== groupId || request.topicId !== topic.topicId) continue
      if (request.revision === topic.revision) return request
      decisions.delete(id)
    }
    const messages = topicMessages(groupId, topic.topicId, topic.revision)
    const removedMessageIds = [...new Set(topic.entries.filter((entry) => entry.action === 'remove' && entry.revision > topic.processedRevision && entry.revision <= topic.revision).map((entry) => entry.messageId))]
    const request = { requestId: randomUUID(), groupId, topicId: topic.topicId, revision: topic.revision, messages, removedMessageIds,
      topicRefs: [{ topicId: topic.topicId, revision: topic.revision }], candidates: scopedCandidates(groupId, messages, [{ topicId: topic.topicId, revision: topic.revision }]), readReview: false }
    decisions.set(request.requestId, request)
    const deltaIds = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= topic.revision).map((entry) => entry.messageId))
    const visibleMessages = strictlyBoundedItems([...messages].reverse(), 40_000, 50).reverse()
    request.visibleMessages = visibleMessages
    request.readMessageIds = new Set(visibleMessages.map((message) => message.messageId))
    const omittedDeltaMessageIds = messages.filter((message) => deltaIds.has(message.messageId) && !request.readMessageIds.has(message.messageId)).map((message) => message.messageId)
    const envelope = { requestId: request.requestId, topicId: topic.topicId, revision: topic.revision,
      removedMessageIds, omittedDeltaMessageIds, ...effectOwnership(groupId, topic.topicId, topic.revision, visibleMessages), replyReviewCandidateCount: request.candidates.length, messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: visibleMessages.length < messages.length, processedRevision: topic.processedRevision, summary: topic.summary, openQuestions: topic.openQuestions }
    const agent = send(groupId, `[GROUP_TOPIC_DECISION]\nTopic 请求：${JSON.stringify(envelope)}\n按此 Topic 固定版本处理本次增量。共享消息由 effectOwnerTopicIds 指定唯一动作主归属；只有 ownedDeltaMessageIds 中的本次依据允许创建或更新 Task、发送确认，其他 Topic 只关联已有 Task 或分别作实质回答。omittedDeltaMessageIds 非空时，必须先用 group_topic_context_get 分页读取全部缺失增量，Host 才接受决策。removedMessageIds 是本次已移出输入，可作为无动作静默决策的依据；不得从移出消息派生任务。非空 reply 必须声明 replyReview.kind。通过 group_decision_submit 独立提交。历史回复候选 ${request.candidates.length} 条，回复前读取 group_reply_review_get。`, visibleMessages.flatMap((message) => message.imageRefs ?? []))
    monitor(agent, request, decisions)
    return request
  }
  function createRouteRequest(groupId, messages, reason) {
    const group = store.getGroup(groupId)
    messages = structuredClone(messages.map(({ facts, ...message }) => message))
    const request = { requestId: randomUUID(), groupId, routingRevision: group.routingRevision, messages, ...(reason ? { reason } : {}) }
    routes.set(request.requestId, request)
    const topics = boundedItems(topicIndex(store.listTopics(groupId)).reverse(), 16_000, 100).reverse()
    const envelope = { requestId: request.requestId, messages, topics, totalTopics: store.listTopics(groupId).length, hasMoreTopics: topics.length < store.listTopics(groupId).length, ...(reason ? { reason } : {}) }
    const agent = send(groupId, `[GROUP_TOPIC_ROUTE]\nTopic 请求：${JSON.stringify(envelope)}\n先结合本批全部消息、已有 Topic 和任务目标归类。Topic 归属只表示消息延续同一讨论目标（continuation），或实质改变该 Topic 的事实、范围、结论或动作（affected）；仅为了查询旧分支、PR、任务或其他历史资料时，调用 group_topic_list / group_topic_context_get，不得把资料来源 Topic 加入归属。通过 group_topic_route_submit 一次覆盖本批消息。多 Topic 归属必须逐项填写 relationship 和 reason，并用 effectOwner 指定唯一动作主归属；主归属应是消息当前直接推动的事项，不是资料来源。此阶段不执行任务、不回复群聊。${reason ? `本次是显式归属复核，原因：${reason}；提交后保留原关系历史。` : ''}`, messages.flatMap((message) => message.imageRefs ?? []))
    monitor(agent, request, routes)
    return envelope
  }
  function createTitleMigrationRequest(groupId, topic) {
    const request = { requestId: randomUUID(), groupId, topicId: topic.topicId, expectedTitle: topic.title, expectedSummary: topic.summary }
    titleMigrations.set(request.requestId, request)
    const agent = send(groupId, `[GROUP_TOPIC_TITLE_MIGRATION]\nTopic 请求：${JSON.stringify({ requestId: request.requestId, topicId: topic.topicId, summary: topic.summary })}\n仅根据 summary 理解话题核心，生成一个像任务名称的简短标题：采用“对象 + 事项”，建议 8–20 个字符，最多 ${TOPIC_TITLE_MAX_CHARS} 个字符。必须重新概括，不能截取 summary 前缀或省略号截断。通过 group_topic_title_submit 提交；不执行任务、不回复群聊。`)
    monitor(agent, request, titleMigrations)
    return request
  }
  function createSummaryMigrationRequest(groupId, topic) {
    const messages = topicMessages(groupId, topic.topicId, topic.revision)
    const request = { requestId: randomUUID(), groupId, topicId: topic.topicId, expectedRevision: topic.revision, expectedSummary: topic.summary }
    summaryMigrations.set(request.requestId, request)
    const envelope = { requestId: request.requestId, topicId: topic.topicId, revision: topic.revision, messages: messages.slice(-50), totalMessages: messages.length }
    const agent = send(groupId, `[GROUP_TOPIC_SUMMARY_MIGRATION]\nTopic 请求：${JSON.stringify(envelope)}\n根据这个 Topic 的引用消息生成独立 summary，概括讨论对象、当前结论、范围和仍需处理的事项，不复制长段原文，不生成标题。通过 group_topic_summary_submit 提交；消息超过 50 条时先用 group_topic_context_get 分页读取完整固定版本。不执行任务、不回复群聊。`)
    monitor(agent, request, summaryMigrations)
    return request
  }
  async function wake(groupId) {
    if (!live() || groupsBeingChanged.has(groupId) || !getAgent(groupId)) return []
    const group = store.getGroup(groupId)
    if (!group) return []
    const pending = pendingInput(groupId)
    if (pending.length && ![...routes.values()].some((request) => request.groupId === groupId)) {
      createRouteRequest(groupId, boundedItems(pending, 40_000, 50))
    }
    const metadataMigrationPending = [...summaryMigrations.values(), ...titleMigrations.values()].some((request) => request.groupId === groupId)
    if (!metadataMigrationPending) {
      const topics = store.listTopics(groupId)
      const longTitle = topics.find((topic) => topic.title.length > TOPIC_TITLE_MAX_CHARS && topic.summary?.trim())
      if (longTitle) createTitleMigrationRequest(groupId, longTitle)
      else {
        const missingSummary = topics.find((topic) => topic.migrationBaseline && topic.processedRevision >= topic.revision && !topic.summary.trim() && topic.revision > 0)
        if (missingSummary) createSummaryMigrationRequest(groupId, missingSummary)
      }
    }
    const result = []
    for (const topic of store.listTopics(groupId)) {
      const commit = unfinished(topic)
      if (commit) {
        if ((retries.get(commit.decisionId) ?? 0) <= Date.now()) resume(groupId, topic.topicId, commit.decisionId)
      } else if (topic.processedRevision < topic.revision) result.push(createDecisionRequest(groupId, topic))
    }
    return result.map(({ requestId, topicId, revision, messages, candidates, removedMessageIds, visibleMessages, readMessageIds }) => {
      const topic = store.getTopic(groupId, topicId)
      const deltaIds = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= revision).map((entry) => entry.messageId))
      const omittedDeltaMessageIds = messages.filter((message) => deltaIds.has(message.messageId) && !readMessageIds.has(message.messageId)).map((message) => message.messageId)
      return { requestId, topicId, revision, removedMessageIds, omittedDeltaMessageIds, ...effectOwnership(groupId, topicId, revision, visibleMessages), replyReviewCandidateCount: candidates.length, messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: visibleMessages.length < messages.length }
    })
  }
  function schedule(groupId) {
    if (!live()) return Promise.resolve([])
    if (scheduled.has(groupId)) return scheduled.get(groupId)
    const promise = Promise.resolve().then(() => wake(groupId)).catch((error) => { onError(groupId, error); return [] }).finally(() => scheduled.delete(groupId))
    scheduled.set(groupId, promise)
    return promise
  }
  function resume(groupId, topicId, decisionId) {
    if (applying.has(decisionId)) return applying.get(decisionId).promise
    const promise = (async () => {
      let record = store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
      if (!record || record.status === 'completed') return record
      await store.updateTopicDecision({ groupId, topicId, decisionId, patch: { status: 'applying', error: undefined } })
      const decision = record.decision
      for (const action of decision.actions) if (action.kind === 'task-cancel') cancelTask(action.taskId)
      if (decision.reply?.trim()) {
        const messages = topicMessages(groupId, topicId, record.revision)
        const target = messages.findLast((message) => decision.basisMessageIds.includes(message.messageId) && message.senderOpenDingTalkId && message.sourceKind !== 'internal' && message.sourceKind !== 'web')
        const persisted = await appendOutbox({ groupId, sourceMessageId: `topic-decision:${decisionId}`, outboundId: record.outboundId, decisionId,
          topicRefs: [{ topicId, revision: record.revision }], text: decision.reply, replyKind: decision.replyReview?.kind,
          taskIds: record.operations.map((operation) => operation.taskId).filter(Boolean), replacesOutboundIds: decision.replyReview?.replaceOutboundIds,
          ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.senderOpenDingTalkId, atOpenDingTalkIds: [target.senderOpenDingTalkId] } : {}) })
        if (persisted?.status) throw new Error(`topic_outbox_${persisted.status}`)
      }
      for (let index = 0; index < record.operations.length; index++) {
        record = store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
        const operation = record.operations[index]
        if (operation.status === 'applied') continue
        await applyAction(groupId, record.decision.actions[operation.actionIndex], operation, record)
        await store.updateTopicDecision({ groupId, topicId, decisionId, patch: {
          operations: record.operations.map((item, at) => at === index ? { ...item, status: 'applied' } : item),
        } })
      }
      await store.completeTopicDecision({ groupId, topicId, decisionId, ...decision.topicUpdate })
      retries.delete(decisionId)
      const retryTimer = retryTimers.get(decisionId)
      if (retryTimer) { clearTimeout(retryTimer); timers.delete(retryTimer); retryTimers.delete(decisionId) }
      return store.getTopic(groupId, topicId).decisions.find((item) => item.decisionId === decisionId)
    })().catch(async (error) => {
      retries.set(decisionId, Date.now() + retryDelayMs)
      try { await store.updateTopicDecision({ groupId, topicId, decisionId, patch: { status: 'failed', error: error.message ?? String(error) } }) } catch (storageError) { onError(groupId, storageError) }
      onError(groupId, error)
      if (live() && !retryTimers.has(decisionId)) {
        const timer = setTimeout(() => {
          timers.delete(timer); retryTimers.delete(decisionId)
          if (live()) schedule(groupId)
        }, Math.max(0, (retries.get(decisionId) ?? 0) - Date.now()))
        timer.unref?.()
        timers.add(timer); retryTimers.set(decisionId, timer)
      }
    }).finally(() => { applying.delete(decisionId); if (live()) schedule(groupId) })
    applying.set(decisionId, { groupId, promise })
    return promise
  }
  function validateBasis(request, decision) {
    const targets = decision.actions.map((action) => action.taskId).filter(Boolean)
    if (new Set(targets).size !== targets.length) throw new Error('topic_decision_task_target_duplicate')
    const basis = new Set(decision.basisMessageIds)
    if (basis.size !== decision.basisMessageIds.length || decision.basisMessageIds.some((id) => !request.messages.some((message) => message.messageId === id) && !request.removedMessageIds.includes(id))) throw new Error('topic_decision_basis_invalid')
    const topic = store.getTopic(request.groupId, request.topicId)
    const delta = new Set(topic.entries.filter((entry) => entry.revision > topic.processedRevision && entry.revision <= request.revision).map((entry) => entry.messageId))
    const unreadDelta = request.messages.filter((message) => delta.has(message.messageId) && !request.readMessageIds.has(message.messageId))
    if (unreadDelta.length) throw new Error('topic_decision_delta_unread')
    if (![...basis].some((id) => delta.has(id))) throw new Error('topic_decision_current_basis_required')
    if (decision.actions.length || decision.replyReview?.kind === 'confirmation') {
      const ownership = effectOwnership(request.groupId, request.topicId, request.revision, request.messages)
      if (!ownership.ownedDeltaMessageIds.some((id) => basis.has(id))) throw new Error('topic_effect_owner_required')
    }
    for (const action of decision.actions) {
      if (!action.topicRefs.some((ref) => ref.topicId === request.topicId && ref.revision === request.revision)) throw new Error('task_current_topic_required')
      if (new Set(action.topicRefs.map((ref) => ref.topicId)).size !== action.topicRefs.length) throw new Error('task_topic_duplicate')
      for (const ref of action.topicRefs) {
        const current = store.getTopic(request.groupId, ref.topicId)
        if (!current || current.revision !== ref.revision) throw new Error('task_topic_version_invalid')
      }
      if (action.taskId) {
        const task = store.getTask(action.taskId)
        if (!task || task.groupId !== request.groupId) throw new Error('task_topic_wrong_group')
        if (action.kind === 'task-reopen' && task.state !== 'completed') throw new Error('task_not_completed')
        if (['task-context', 'task-cancel'].includes(action.kind) && task.state === 'completed') throw new Error('task_not_active')
      }
      if (decision.actions.length) {
        const directedAway = request.messages.filter((message) => basis.has(message.messageId) && isDirectedToOtherParticipants(message.text, store.getAgentNames()))
        for (const other of directedAway) if (!request.messages.some((message) => basis.has(message.messageId) && message.quotedMessage?.messageId === other.messageId && isExplicitAgentDirection(message.text, store.getAgentNames()))) throw new Error('task_action_directed_to_other_participants')
      }
      if (action.kind === 'new-task') {
        const group = store.getGroup(request.groupId)
        if (!group.responsibility?.trim()) throw new Error('task_group_responsibility_required')
        const directed = request.messages.some((message) => basis.has(message.messageId) && isExplicitAgentDirection(message.text, store.getAgentNames()))
        const confirmsProposal = request.messages.some((message) => {
          if (!basis.has(message.messageId) || !message.quotedMessage?.messageId) return false
          const outbound = group.outbox.find((item) => item.deliveredMessageId === message.quotedMessage.messageId && item.status === 'sent')
          if (!outbound?.decisionId) return false
          return group.topics.some((topic) => topic.decisions.some((record) => record.decisionId === outbound.decisionId && record.decision.actions.some((candidate) => candidate.kind === 'task-proposal')))
        })
        if (!directed && !confirmsProposal) throw new Error('task_explicit_authorization_required')
      }
    }
  }
  function register(agentCtx, groupId) {
    const tool = (name, description, parameters, execute) => agentCtx.tools.register({ name, description, parameters, output: objectOutput, execute: async (args, exec) => {
      if (!live()) throw new Error('resident_runtime_closed')
      assertSession(exec, groupId)
      const pending = Promise.resolve().then(() => execute(args))
      activeToolCalls.add(pending)
      try { return jsonOutput(await pending) }
      catch (error) { if (error instanceof z.ZodError) return invalidArguments(error); throw error }
      finally { activeToolCalls.delete(pending) }
    } })
    tool('group_topic_route_review', '按明确原因复核本群已存在消息的 Topic 归属；先返回冻结请求，再通过 group_topic_route_submit 完整提交。', {
      type: 'object', additionalProperties: false,
      properties: { messageIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['messageIds', 'reason'],
    }, (input) => {
      const { messageIds, reason } = z.strictObject({ messageIds: z.array(z.string().min(1)).min(1).max(50), reason: z.string().trim().min(1) }).parse(input)
      if (new Set(messageIds).size !== messageIds.length) throw new Error('topic_route_review_duplicate')
      const group = store.getGroup(groupId)
      const messages = messageIds.map((id) => {
        const message = group.messages.find((item) => item.messageId === id)
        if (!message) throw new Error(`message_not_found:${id}`)
        return message
      })
      return createRouteRequest(groupId, messages, reason)
    })
    tool('group_topic_route_submit', '先提交完整消息批次的 Topic 归属；不发送回复或执行 Task。', topicRouteSubmissionJsonSchema, async (input) => {
      const args = topicRouteSubmissionSchema.parse(input)
      const request = routes.get(args.requestId)
      if (!request || request.groupId !== groupId) {
        const receipt = store.getGroup(groupId)?.routeHistory.find((item) => item.routeId === args.requestId)
        if (receipt) return { status: 'accepted', recovered: true, topicIdsByKey: receipt.topicIdsByKey ?? {}, pendingDecisions: await schedule(groupId) }
        await schedule(groupId)
        const current = [...routes.values()].find((item) => item.groupId === groupId)
        return current
          ? { status: 'superseded', currentRequest: { requestId: current.requestId, routingRevision: current.routingRevision, messages: current.messages.map(({ messageId, messageVersion }) => ({ messageId, messageVersion })) }, nextAction: 'use-current-request' }
          : { status: 'request-unavailable', nextAction: 'wait-for-current-request' }
      }
      if (!sameVersions(request.messages, args.routes)) throw new Error('topic_route_batch_incomplete')
      let result
      try {
        result = await store.routeMessages({ groupId, routeId: request.requestId, routingRevision: request.routingRevision, routes: args.routes.map((route) => request.reason ? { ...route, reason: `${request.reason}${route.reason ? `；${route.reason}` : ''}` } : route) })
      } catch (error) {
        if (error.message !== 'topic_message_version_stale') throw error
        routes.delete(args.requestId)
        await schedule(groupId)
        const current = [...routes.values()].find((item) => item.groupId === groupId)
        return { status: 'stale', reason: 'message-version-changed', ...(current ? { currentRequest: { requestId: current.requestId, routingRevision: current.routingRevision, messages: current.messages.map(({ messageId, messageVersion }) => ({ messageId, messageVersion })) } } : {}), nextAction: 'use-current-request' }
      }
      if (result.status !== 'routed' && result.status !== 'duplicate') { routes.delete(args.requestId); await schedule(groupId); return result }
      routes.delete(args.requestId)
      return { status: 'accepted', topicIdsByKey: result.topicIdsByKey, pendingDecisions: await schedule(groupId) }
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
    tool('group_decision_submit', '提交一个 Topic 固定版本的独立业务决策；accepted 表示意图已持久化，动作进度可查询。', groupDecisionSubmissionJsonSchema, async (input) => {
      const args = groupDecisionSubmissionSchema.parse(input)
      const request = decisions.get(args.requestId)
      if (!request || request.groupId !== groupId || request.topicId !== args.topicId || request.revision !== args.revision) return { status: 'topic-stale', pendingDecisions: await schedule(groupId) }
      const basis = new Set(args.decision.basisMessageIds)
      let decision = blockTaskDecisionForUnavailableMedia(args.decision, request.messages.filter((message) => basis.has(message.messageId)).flatMap((message) => message.mediaUnavailable ?? []))
      validateBasis(request, decision)
      if (decision.actions.length && !decision.reply?.trim()) return { status: 'reply-required' }
      if (decision.reply?.trim()) {
        if (!decision.replyReview) return { status: 'review-required', error: 'reply_kind_required' }
        if (refreshReview(request)) return { status: 'review-required' }
        if (request.candidates.length && !request.readReview) return { status: 'review-required' }
        try { decision = { ...decision, replyReview: validateReplyReview(decision.replyReview, request.candidates, { confirmationTaskIds: decision.actions.map((action) => action.taskId).filter(Boolean) }) } }
        catch (error) { return { status: 'review-required', error: error.message } }
      }
      const result = await Promise.resolve().then(() => {
        if (decision.reply?.trim() && refreshReview(request)) return { status: 'review-required' }
        return store.acceptTopicDecision({ groupId, topicId: args.topicId, revision: args.revision, decisionId: args.requestId, decision,
        expectedTaskVersions: decision.actions.filter((action) => action.taskId).map((action) => ({ taskId: action.taskId, inputVersion: action.inputVersion, runSequence: action.runSequence })),
        preflight: () => { validateBasis(request, decision); return decision.reply?.trim() && refreshReview(request) ? { status: 'review-required' } : undefined } })
      })
      if (result.status === 'accepted' || result.status === 'duplicate') {
        decisions.delete(args.requestId)
        resume(groupId, args.topicId, args.requestId)
      } else {
        if (!['routing-required', 'review-required'].includes(result.status)) decisions.delete(args.requestId)
        await schedule(groupId)
      }
      return { status: result.status, decisionId: args.requestId }
    })
    tool('group_topic_list', '搜索本群 Topic 摘要，按需召回历史话题。', { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false }, ({ query = '', offset = 0, limit = 50 }) => {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('topic_page_invalid')
      const all = store.listTopics(groupId).filter((topic) => `${topic.title}\n${topic.summary ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      return { topics: topicIndex(all.slice(offset, offset + limit)), total: all.length, offset, limit }
    })
    tool('group_topic_context_get', '读取本群 Topic 固定版本及消息原文；返回不超过字符预算，按 nextOffset/nextTextOffset 连续读取完整历史。', { type: 'object', properties: { topicId: { type: 'string' }, revision: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, textOffset: { type: 'integer' } }, required: ['topicId'], additionalProperties: false }, (args) => {
      const context = boundedTopicContext(store.getTopicContext({ ...args, groupId, limit: args.limit ?? 10 }), { textOffset: args.textOffset ?? 0 })
      for (const request of decisions.values()) {
        if (request.groupId !== groupId || request.topicId !== context.topic.topicId || request.revision !== context.topic.revision) continue
        request.readTextOffsets ??= new Map()
        for (const message of context.messages) {
          const expected = request.readTextOffsets.get(message.messageId) ?? 0
          if ((message.textOffset ?? 0) !== expected) continue
          if (message.textHasMore) request.readTextOffsets.set(message.messageId, context.nextTextOffset)
          else request.readMessageIds.add(message.messageId)
        }
      }
      return context
    })
    tool('group_reply_review_get', '读取 Topic 判断或 Task 通知绑定的完整历史回复候选。', { type: 'object', properties: { requestIds: { type: 'array', items: { type: 'string' } } }, required: ['requestIds'], additionalProperties: false }, ({ requestIds }) => {
      if (!Array.isArray(requestIds) || !requestIds.length || requestIds.length > 8 || new Set(requestIds).size !== requestIds.length) throw new Error('topic_review_request_invalid')
      const requests = requestIds.map((id) => requestFor(groupId, id))
      for (const request of requests) { refreshReview(request); request.readReview = true }
      const candidates = [...new Map(requests.flatMap((request) => request.candidates).map((candidate) => [candidate.outboundId, candidate])).values()]
      return { requestIds, candidates, candidateCount: candidates.length }
    })
    tool('group_reply_submit', '提交绑定 Topic 与 Task 输入版本的结果通知；不依赖全群 observedRequestIds。', { type: 'object', additionalProperties: false, required: ['requestId', 'reply'], properties: {
      requestId: { type: 'string' }, reply: { type: 'string' }, replyReview: replyReviewJsonSchema, replyToMessageId: { type: 'string' }, atOpenDingTalkIds: { type: 'array', items: { type: 'string' } },
    } }, async (args) => {
      const request = replies.get(args.requestId)
      if (!request || request.groupId !== groupId) {
        const outbound = store.getGroup(groupId)?.outbox.find((item) => item.outboundId === `reply-${args.requestId}`)
        return outbound
          ? { status: 'accepted', recovered: true, outboundId: outbound.outboundId, deliveryStatus: outbound.status }
          : { status: 'request-unavailable', nextAction: 'wait-for-current-request' }
      }
      if (!args.reply?.trim()) throw new Error('group_reply_text_required')
      if (!args.replyReview) return { status: 'review-required', error: 'reply_kind_required' }
      const preflight = () => {
        if (pendingInput(groupId).length) return { status: 'routing-required' }
        const current = store.getTask(request.task.taskId)
        if (!current || current.inputVersion !== request.task.inputVersion || current.runSequence !== request.task.runSequence || current.state !== request.resultState || JSON.stringify(current.result) !== request.resultFingerprint) {
          replies.delete(args.requestId); request.reject(new Error('task_result_context_changed')); return { status: 'task-stale' }
        }
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
      const candidates = request.messages.filter((message) => message.senderOpenDingTalkId && !['web', 'internal'].includes(message.sourceKind))
      const target = candidates.find((message) => message.messageId === args.replyToMessageId)
      if (candidates.length && (!target || !args.atOpenDingTalkIds?.length)) throw new Error('group_reply_routing_required')
      if (args.replyToMessageId && !target) throw new Error('group_reply_target_not_in_topic')
      if (args.atOpenDingTalkIds && (new Set(args.atOpenDingTalkIds).size !== args.atOpenDingTalkIds.length || args.atOpenDingTalkIds.some((id) => !candidates.some((message) => message.senderOpenDingTalkId === id)))) throw new Error('group_reply_recipient_not_in_topic')
      const outbound = { groupId, outboundId: `reply-${args.requestId}`, sourceMessageId: request.resultKey, resultFingerprint: fingerprint(request.task.result), text: args.reply.trim(), taskIds: [task.taskId], topicRefs: task.topicRefs,
        replyKind: replyReview?.kind, replacesOutboundIds: replyReview?.replaceOutboundIds,
        ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.senderOpenDingTalkId, atOpenDingTalkIds: args.atOpenDingTalkIds } : {}) }
      // 对外调用在短状态提交之后；独立通知的失败不消费其他 Topic 请求。
      const persisted = await appendOutbox({ ...outbound, preflight })
      if (persisted?.status) { await schedule(groupId); return persisted }
      replies.delete(args.requestId); request.resolve(outbound)
      return { status: 'accepted', outboundId: outbound.outboundId }
    })
    tool('group_task_review_submit', '提交内部完成验收或检查点审阅；请求绑定执行版本，不能产生群消息。', { type: 'object', properties: { requestId: { type: 'string' }, review: { type: 'object' } }, required: ['requestId', 'review'], additionalProperties: false }, ({ requestId, review: input }) => {
      const request = reviews.get(requestId)
      if (!request || request.groupId !== groupId) throw new Error('task_review_request_unknown')
      const task = store.getTask(request.task.taskId)
      if (!task || task.inputVersion !== request.task.inputVersion || task.runSequence !== request.task.runSequence) { reviews.delete(requestId); request.reject(new Error('task_review_context_changed')); return { status: 'task-stale' } }
      const review = reviewSchema.parse(input)
      if ((request.kind === 'completion') !== ('accepted' in review)) throw new Error('task_review_kind_invalid')
      if ('decision' in review && ((review.decision === 'guidance' && !review.guidance) || (review.decision === 'acknowledge' && review.guidance))) throw new Error('task_review_guidance_invalid')
      reviews.delete(requestId); request.resolve(review)
      return { status: 'accepted' }
    })
  }
  function requestReview(kind, task, value) {
    const existing = [...reviews.values()].find((request) => request.kind === kind && request.task.taskId === task.taskId
      && request.task.inputVersion === task.inputVersion && request.task.runSequence === task.runSequence
      && JSON.stringify(request.value) === JSON.stringify(value))
    if (existing) return existing.promise
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const request = { requestId: randomUUID(), groupId: task.groupId, task, kind, value, resolve, reject, promise }
    try {
      reviews.set(request.requestId, request)
      const label = kind === 'completion' ? '[TASK_COMPLETION_REVIEW]' : '[TASK_CHECKPOINT_REVIEW]'
      const reviewInfo = { requestId: request.requestId, kind, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence }
      const agent = send(task.groupId, `${label}\n审阅请求：${JSON.stringify(reviewInfo)}\nTask ID: ${task.taskId}\n当前有效目标：${task.objective}\n验收标准：${JSON.stringify(task.acceptanceCriteria)}\n本轮阶段任务：${JSON.stringify(task.stageTasks)}\n待审阅内容：${JSON.stringify(value)}\n通过 group_task_review_submit 提交内部判断。完成审阅：{accepted:boolean,reason:string}；检查点审阅：{decision:'acknowledge'|'guidance',reason:string,guidance?:string}。核对全部当前范围和证据，不发群消息，不用自然语言结束请求。`)
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
    const visibleMessages = boundedItems([...messages].reverse(), 40_000, 50).reverse()
    const request = { requestId: randomUUID(), groupId: task.groupId, task, resultKey, resultState: result.status === 'completed' ? 'completed' : 'waiting', resultFingerprint: JSON.stringify(result), messages, resolve, reject, promise,
      candidates: scopedCandidates(task.groupId, messages, task.topicRefs, [task.taskId]), readReview: false,
      observedTopics: task.topicRefs.map((ref) => ({ topicId: ref.topicId, revision: store.getTopic(task.groupId, ref.topicId).revision })) }
    replies.set(request.requestId, request)
    try {
      const agent = send(task.groupId, `[TASK_COORDINATION]\n回复请求 ID：${request.requestId}\nTask ID: ${task.taskId}\nTopic 请求：${JSON.stringify({ requestId: request.requestId, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, topicRefs: task.topicRefs, messages: visibleMessages, totalMessages: messages.length, hasMoreMessages: visibleMessages.length < messages.length, replyReviewCandidateCount: request.candidates.length })}\n当前目标：${task.objective}\n核验结果：${JSON.stringify(result)}\n通过 group_reply_submit 提交结果或阻塞通知；先按 requestId 读取 ${request.candidates.length} 条历史回复候选。需要更多原文时按固定 Topic 版本分页读取。保留实际完成内容、证据、交付状态和未验证边界。`)
      monitor(agent, request, replies)
    } catch (error) { replies.delete(request.requestId); reject(error) }
    return promise
  }
  return {
    register, schedule, requestReview, requestReply, taskMessages, applyAccepted: resume,
    hasPendingTaskInput(task) {
      const group = store.getGroup(task.groupId)
      return pendingInput(task.groupId).length > 0 || (group?.taskReservations ?? []).some((item) => item.taskId === task.taskId)
        || task.topicRefs.some((ref) => { const topic = store.getTopic(task.groupId, ref.topicId); return !topic || topic.processedRevision < topic.revision })
    },
    async retryMessage(groupId, messageId) {
      const group = store.getGroup(groupId)
      if (!group?.messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      for (const [id, request] of routes) if (request.groupId === groupId && request.messages.some((message) => message.messageId === messageId)) routes.delete(id)
      for (const topic of group.topics.filter((item) => item.entries.some((entry) => entry.messageId === messageId))) {
        for (const record of topic.decisions.filter((item) => item.status === 'failed')) {
          retries.delete(record.decisionId)
          const timer = retryTimers.get(record.decisionId)
          if (timer) { clearTimeout(timer); timers.delete(timer); retryTimers.delete(record.decisionId) }
        }
      }
      return schedule(groupId)
    },
    async recover() { return Promise.all(store.listGroups().map((group) => schedule(group.groupId))) },
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
      routes.clear(); decisions.clear(); reviews.clear(); replies.clear(); titleMigrations.clear(); summaryMigrations.clear()
      await Promise.allSettled([...applying.values()].map((item) => item.promise))
    },
  }
}
