import { dispatchOutbox } from './dws-adapter.js'

const meaningful = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== 'null'

function normalizeResourceRefs(value, text) {
  const supplied = Array.isArray(value) ? value.filter((item) => item?.type === 'mediaId' && typeof item.resourceId === 'string') : []
  const found = [...String(text ?? '').matchAll(/\[图片消息\]\(mediaId=([^\)]+)\)/gu)].map((match) => ({ type: 'mediaId', resourceId: match[1] }))
  return [...new Map([...supplied, ...found].map((item) => [`${item.type}:${item.resourceId}`, item])).values()]
}

function normalizeEvent(event) {
  const groupId = event.conversation_id
  const messageId = event.message_id ?? event.event_id
  if (typeof groupId !== 'string' || groupId === '' || typeof messageId !== 'string' || messageId === '') throw new Error('dws_event_identity_missing')
  const quoted = event.quotedMessage ?? event.quoted_message
  const text = typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? '')
  const resourceRefs = normalizeResourceRefs(event.resourceRefs ?? event.resource_refs, text)
  return {
    groupId,
    messageId,
    text,
    occurredAt: event.event_time ?? event.create_time ?? event.timestamp ?? new Date().toISOString(),
    senderName: meaningful(event.sender) ? event.sender : undefined,
    senderOpenDingTalkId: event.sender_open_dingtalk_id ?? event.sender_id ?? undefined,
    ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
    ...(quoted ? { quotedMessage: { ...(quoted.messageId ?? quoted.message_id ? { messageId: quoted.messageId ?? quoted.message_id } : {}), ...(meaningful(quoted.sender ?? quoted.senderName) ? { senderName: quoted.sender ?? quoted.senderName } : {}), occurredAt: quoted.createTime ?? quoted.create_time, content: quoted.content ?? quoted.text ?? '' } } : {}),
  }
}

export function normalizeHistoryMessage(message, fallbackGroupId) {
  const groupId = message.conversationId ?? fallbackGroupId
  const messageId = message.messageId
  if (typeof groupId !== 'string' || groupId === '' || typeof messageId !== 'string' || messageId === '') throw new Error('dws_history_identity_missing')
  const quoted = message.quotedMessage
  const text = message.text ?? ''
  const resourceRefs = normalizeResourceRefs(message.resourceRefs, text)
  return {
    groupId, messageId, text, occurredAt: message.createTime ?? new Date().toISOString(),
    senderName: meaningful(message.sender ?? message.senderName) ? message.sender ?? message.senderName : undefined,
    senderOpenDingTalkId: message.senderOpenDingTalkId ?? message.sender_open_dingtalk_id ?? message.senderId ?? undefined,
    ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
    ...(quoted ? { quotedMessage: { ...(quoted.messageId ?? quoted.message_id ? { messageId: quoted.messageId ?? quoted.message_id } : {}), ...(meaningful(quoted.sender ?? quoted.senderName) ? { senderName: quoted.sender ?? quoted.senderName } : {}), occurredAt: quoted.createTime, content: quoted.content ?? quoted.text ?? '' } } : {}),
  }
}

export function parseRedlineDecision(text) {
  const normalized = String(text ?? '').trim()
  if (/^(批准|同意)(?:$|[：:，,。\s])/u.test(normalized)) return 'approved'
  if (/^(拒绝|不同意)(?:$|[：:，,。\s])/u.test(normalized)) return 'rejected'
  return undefined
}

export function startDwsBridge({ runtime, adapter, logger, humanUserId, humanPollIntervalMs = 30_000, groupBackfillIntervalMs = 10_000, groupBackfillOverlapMs = 30_000, outboxRetryIntervalMs = 10_000 }) {
  const subscriptions = new Map()
  let stopping = false
  let humanPollTimer
  let humanPollTail = Promise.resolve()
  let groupBackfillTimer
  let groupBackfillTail = Promise.resolve()
  let outboxRetryTimer
  let outboxRetryTail = Promise.resolve()
  const processMessage = async (message) => {
    if (runtime.getGroup?.(message.groupId)?.messages?.some((item) => item.messageId === message.messageId)) return
    const media = typeof adapter.loadMessageImages === 'function' ? await adapter.loadMessageImages(message) : { images: [], mediaUnavailable: [] }
    const accepted = await runtime.ingest({
      ...message,
      ...(media.images.length > 0 ? { images: media.images } : {}),
      ...(media.mediaUnavailable.length > 0 ? { mediaUnavailable: media.mediaUnavailable } : {}),
    })
    if (accepted.duplicate) return
  }
  const processOutbound = async ({ groupId, outbound }) => {
    const delivery = await dispatchOutbox({ adapter, groupId, outbound })
    if (delivery.status === 'sent') await runtime.acknowledge({ groupId, outboundId: outbound.outboundId })
  }
  const processPendingCompletedOutbox = () => {
    outboxRetryTail = outboxRetryTail.then(async () => {
      if (stopping) return
      const jobs = []
      for (const group of runtime.listGroups()) {
        const pending = (runtime.getGroup?.(group.groupId) ?? group).outbox ?? []
        for (const outbound of pending.filter((item) => item.status === 'pending' && /^task-result:task-.*:completed(?::\d+)?$/.test(item.sourceMessageId))) {
          jobs.push(processOutbound({ groupId: group.groupId, outbound }))
        }
      }
      const settled = await Promise.allSettled(jobs)
      for (const result of settled) if (result.status === 'rejected') logger.warn(result.reason)
    }).catch((error) => logger.warn(error))
    return outboxRetryTail
  }
  const blockerText = (task) => {
    const result = task.result
    const redline = task.humanBlocker.category === 'redline'
    const currentItems = (items = []) => items.filter((item) => !/AP-\d|Approval Server|SSE|审批申请消息|完整审批号/u.test(item))
    const evidence = currentItems(result?.evidence)
    const attemptedActions = currentItems(result?.attemptedActions)
    const requestedAction = redline
      ? task.humanBlocker.requestedAction.replace(/^请[^，。\n]+引用.*?明确批准\/拒绝/u, '请明确回复“批准”或“拒绝”：')
      : task.humanBlocker.requestedAction
    return [
      redline ? '【群聊个人助理受控操作阻塞，等待真人审批】' : '【群聊个人助理任务阻塞，等待真人处理】',
      '',
      `Task ID：${task.taskId}`,
      `阻塞请求 ID：${task.humanBlocker.requestId}`,
      '',
      '【任务目标】',
      task.objective,
      '',
      '【阻塞信息】',
      `阻塞分类：${task.humanBlocker.category}`,
      `阻塞原因：${task.waitingReason}`,
      '',
      '【风险】',
      result?.risk ?? '未单独说明；以阻塞原因、现场证据和申请范围为准。',
      '',
      '【现场证据】',
      ...(evidence.length > 0 ? evidence.map((item) => `- ${item}`) : ['- 暂无']),
      '',
      '【已尝试】',
      ...(attemptedActions.length > 0 ? attemptedActions.map((item) => `- ${item}`) : ['- 无可安全执行的尝试']),
      '',
      redline ? '【审批范围】' : '【需要真人答复】',
      requestedAction,
      '',
      redline
        ? '请直接引用本消息回复“批准”或“拒绝”，可在其后补充条件；只有引用回复且决定明确时才会恢复对应任务。该等待不设超时。'
        : '请直接引用本消息回复处理方案；只有引用回复会恢复对应任务。该等待不设超时。',
    ].join('\n')
  }
  const quotedMessageId = (message) => message.quotedMessage?.messageId ?? message.quotedMessage?.message_id ?? message.quoted_message?.messageId ?? message.quoted_message?.message_id
  const recallInactiveAuthorization = async (authorization) => {
    const shouldRecall = (authorization?.status === 'answered' && authorization.decisionSource === 'web') || authorization?.status === 'superseded'
    if (!shouldRecall || !authorization.messageId || authorization.recallStatus === 'recalled') return
    try {
      await adapter.recallMessage(authorization.messageId)
      await runtime.recordAuthorizationRecall({ requestId: authorization.requestId, status: 'recalled' })
    } catch (error) {
      await runtime.recordAuthorizationRecall({ requestId: authorization.requestId, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  const processHumanBlockers = () => {
    humanPollTail = humanPollTail.then(async () => {
      if (stopping) return
      const authorizations = runtime.listAuthorizationRequests?.() ?? (runtime.listTasks?.() ?? [])
        .filter((task) => task.humanBlocker)
        .map((task) => ({ ...task.humanBlocker, taskId: task.taskId }))
      for (const authorization of authorizations.filter((item) => item.status === 'pending-send' || item.status === 'waiting-reply')) {
        const task = runtime.getTask?.(authorization.taskId) ?? (runtime.listTasks?.() ?? []).find((item) => item.taskId === authorization.taskId)
        if (task?.state !== 'waiting' || task.waitingKind !== 'human-intervention') continue
        const blocker = task.humanBlocker
        if (blocker?.status === 'pending-send' || blocker?.formatVersion !== 3) {
          if (typeof humanUserId !== 'string' || humanUserId.trim() === '') throw new Error('dws_human_user_id_required')
          if (runtime.getAuthorizationRequest?.(blocker.requestId)?.status === 'answered') continue
          const recovered = typeof adapter.findHumanBlockerExchange === 'function' ? await adapter.findHumanBlockerExchange(blocker.requestId) : undefined
          if (recovered !== undefined) {
            await runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: blocker.requestId, formatVersion: 3, ...recovered })
            const current = runtime.getAuthorizationRequest?.(blocker.requestId)
            if (current?.status === 'answered') { await recallInactiveAuthorization(current); continue }
            if (recovered.replyMessageId && recovered.reply) {
              const decision = blocker.category === 'redline' ? parseRedlineDecision(recovered.reply) : undefined
              if (blocker.category !== 'redline' || decision !== undefined) await runtime.resolveHumanBlocker({ taskId: task.taskId, requestId: blocker.requestId, quotedMessageId: recovered.messageId, replyMessageId: recovered.replyMessageId, reply: recovered.reply, decision })
            }
            continue
          }
          if (runtime.getAuthorizationRequest?.(blocker.requestId)?.status === 'answered') continue
          const delivery = await adapter.sendSelf({ userId: humanUserId, text: blockerText(task), idempotencyKey: `${blocker.requestId}:formatted-v3` })
          await runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: blocker.requestId, formatVersion: 3, ...delivery })
          await recallInactiveAuthorization(runtime.getAuthorizationRequest?.(blocker.requestId))
          continue
        }
        if (blocker?.status !== 'waiting-reply' || !blocker.conversationId || !blocker.messageId || !blocker.sentAt) continue
        const recovered = typeof adapter.findHumanBlockerExchange === 'function' ? await adapter.findHumanBlockerExchange(blocker.requestId) : undefined
        if (recovered?.sentAt && recovered.sentAt !== blocker.sentAt) await runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: blocker.requestId, formatVersion: 3, ...recovered })
        const start = recovered?.sentAt ?? blocker.sentAt
        const messages = await adapter.readConversation(blocker.conversationId, { start, end: new Date().toISOString() })
        const reply = messages.find((message) => quotedMessageId(message) === blocker.messageId && message.messageId !== blocker.messageId)
        if (reply === undefined) continue
        const text = typeof reply.text === 'string' ? reply.text.trim() : typeof reply.content === 'string' ? reply.content.trim() : ''
        if (text === '') continue
        const decision = blocker.category === 'redline' ? parseRedlineDecision(text) : undefined
        if (blocker.category === 'redline' && decision === undefined) continue
        await runtime.resolveHumanBlocker({ taskId: task.taskId, requestId: blocker.requestId, quotedMessageId: blocker.messageId, replyMessageId: reply.messageId, reply: text, decision })
      }
    }).catch((error) => logger.warn(error))
    return humanPollTail
  }
  const processIncrementalGroupBackfill = () => {
    groupBackfillTail = groupBackfillTail.then(async () => {
      if (stopping) return
      for (const group of runtime.listGroups()) {
        const persisted = runtime.getGroup?.(group.groupId) ?? group
        const latest = [...(persisted.messages ?? [])]
          .map((message) => new Date(message.occurredAt).valueOf())
          .filter(Number.isFinite)
          .sort((left, right) => right - left)[0]
        const end = new Date().toISOString()
        const start = new Date(Number.isFinite(latest) ? Math.max(0, latest - groupBackfillOverlapMs) : new Date().setHours(0, 0, 0, 0)).toISOString()
        const history = await adapter.readGroupRange(group.groupId, { start, end })
        const ordered = [...history.messages].sort((left, right) => String(left.createTime ?? '').localeCompare(String(right.createTime ?? '')))
        for (const message of ordered) await processMessage(normalizeHistoryMessage(message, group.groupId))
      }
    }).catch((error) => logger.warn(error))
    return groupBackfillTail
  }
  const attach = (group, { backfill = false } = {}) => {
    if (subscriptions.has(group.groupId)) return
    const subscription = adapter.startGroupSubscription(group.groupId, async (event) => {
      try {
        await processMessage(normalizeEvent(event))
      } catch (error) {
        logger.warn(error)
      }
    })
    subscription.lifecycle.on('ready', () => {
      runtime.resolveGroupCarrierIssues?.({ groupId: group.groupId }).catch((error) => logger.warn(error))
    })
    subscription.ready?.then(() => runtime.resolveGroupCarrierIssues?.({ groupId: group.groupId })).catch((error) => logger.warn(error))
    subscription.lifecycle.on('line-error', (error) => logger.warn(error))
    subscription.done.then(async (result) => {
      if (stopping || result === undefined) return
      const fingerprint = `dws-consumer-exit:${result.exitCode ?? 'null'}:${result.signal ?? 'none'}`
      const tasks = runtime.listTasks().filter((task) => task.groupId === group.groupId && (task.state === 'running' || task.state === 'waiting'))
      for (const task of tasks) await runtime.reportCarrierIssue({ taskId: task.taskId, fingerprint, detail: `DWS consumer exited for group ${group.groupId}` })
    }).catch((error) => logger.warn(error))
    subscriptions.set(group.groupId, subscription)
    if (backfill && (group.messages?.length ?? 0) > 0) {
      adapter.readGroup(group.groupId).then(async (history) => {
        if (history.complete !== true) throw new Error(`dws_backfill_partial:${group.groupId}`)
        const ordered = [...history.messages].sort((left, right) => String(left.createTime ?? '').localeCompare(String(right.createTime ?? '')))
        for (const message of ordered) await processMessage(normalizeHistoryMessage(message, group.groupId))
      }).catch((error) => logger.warn(error))
    }
  }

  for (const group of runtime.listGroups()) attach(group, { backfill: true })
  const detachListener = runtime.onGroupSubscribed(attach)
  const detachUnsubscribeListener = (runtime.onGroupUnsubscribed ?? (() => () => undefined))(({ groupId }) => {
    const subscription = subscriptions.get(groupId)
    if (subscription === undefined) return
    subscription.stop()
    subscriptions.delete(groupId)
  })
  const detachOutboxListener = runtime.onOutboxAppended(async (event) => {
    try { await processOutbound(event) } catch (error) { logger.warn(error) }
  })
  processPendingCompletedOutbox()
  const detachHumanBlockerListener = (runtime.onHumanBlockerRequested ?? (() => () => undefined))(() => {
    processHumanBlockers().catch((error) => logger.warn(error))
  })
  const detachAuthorizationDecisionListener = (runtime.onAuthorizationDecided ?? (() => () => undefined))(({ authorization }) => {
    humanPollTail = humanPollTail.then(() => recallInactiveAuthorization(authorization)).catch((error) => logger.warn(error))
  })
  processHumanBlockers()
  if (humanPollIntervalMs > 0) {
    humanPollTimer = setInterval(processHumanBlockers, humanPollIntervalMs)
    humanPollTimer.unref?.()
  }
  if (groupBackfillIntervalMs > 0) {
    groupBackfillTimer = setInterval(processIncrementalGroupBackfill, groupBackfillIntervalMs)
    groupBackfillTimer.unref?.()
  }
  if (outboxRetryIntervalMs > 0) {
    outboxRetryTimer = setInterval(processPendingCompletedOutbox, outboxRetryIntervalMs)
    outboxRetryTimer.unref?.()
  }
  return async () => {
    stopping = true
    if (humanPollTimer !== undefined) clearInterval(humanPollTimer)
    if (groupBackfillTimer !== undefined) clearInterval(groupBackfillTimer)
    if (outboxRetryTimer !== undefined) clearInterval(outboxRetryTimer)
    detachListener()
    detachUnsubscribeListener()
    detachOutboxListener()
    detachHumanBlockerListener()
    detachAuthorizationDecisionListener()
    for (const subscription of subscriptions.values()) subscription.stop()
    await Promise.allSettled([...subscriptions.values()].map((subscription) => subscription.done))
    await humanPollTail
    await groupBackfillTail
    await outboxRetryTail
    subscriptions.clear()
  }
}
