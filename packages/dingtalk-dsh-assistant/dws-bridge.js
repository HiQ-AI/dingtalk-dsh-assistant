import { dispatchOutbox, matchesOutbound } from './dws-adapter.js'

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
  if (normalized === '') return undefined
  if (/^(拒绝|不同意|不批准)(?:$|[：:，,。\s])/u.test(normalized)) return 'rejected'
  return 'approved'
}

export function startDwsBridge({ runtime, adapter, logger, humanUserId, currentDwsUserName, humanPollIntervalMs = 30_000, groupBackfillIntervalMs = 10_000, groupBackfillOverlapMs = 30_000, outboxRetryIntervalMs = 10_000, listenerReconnectBaseMs = 1_000, listenerReconnectMaxMs = 30_000, listenerReadyTimeoutMs = 15_000, onHealthChange }) {
  const subscriptions = new Map()
  const bridgeEntries = new Map()
  const inflightMessages = new Map()
  const inflightHumanReplies = new Map()
  const humanReplyEntry = {
    generation: 0,
    listenerState: typeof adapter.startHumanReplySubscription === 'function' ? 'starting' : 'unavailable',
    reconnectAttempt: 0,
  }
  let stopping = false
  let humanPollTimer
  let humanPollTail = Promise.resolve()
  let groupBackfillTimer
  let outboxRetryTimer
  let outboxRetryTail = Promise.resolve()
  const detachGroupMessageRecaller = (runtime.registerGroupMessageRecaller ?? (() => () => undefined))(async ({ groupId, messageId, outbound }) => {
    await adapter.recallMessage(messageId)
    if (typeof adapter.findOutboundMessage === 'function') {
      const found = await adapter.findOutboundMessage(groupId, outbound)
      if (found !== undefined) throw new Error(`dws_recall_readback_message_present:${messageId}`)
    }
  })
  const processMessage = (message) => {
    const key = `${message.groupId}\u0000${message.messageId}`
    const existing = inflightMessages.get(key)
    if (existing !== undefined) return existing
    const operation = (async () => {
      const group = runtime.getGroup?.(message.groupId)
      const persisted = group?.messages?.find((item) => item.messageId === message.messageId)
      const deliveredOutbound = group?.outbox?.find((item) => item.deliveredMessageId === message.messageId)
      const pendingOutbound = typeof currentDwsUserName === 'string' && currentDwsUserName.trim() !== '' && message.senderName === currentDwsUserName
        ? group?.outbox?.find((item) => item.status === 'pending' && matchesOutbound(message, item))
        : undefined
      const outbound = deliveredOutbound ?? pendingOutbound
      if (outbound !== undefined) {
        if (pendingOutbound !== undefined) await runtime.acknowledge({ groupId: message.groupId, outboundId: outbound.outboundId, deliveredMessageId: message.messageId })
        if (['failed', 'decision-failed'].includes(persisted?.agentDeliveryStatus)) await runtime.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'skipped' })
        return
      }
      if (persisted !== undefined && persisted.agentDeliveryStatus !== 'failed') return
      const media = typeof adapter.loadMessageImages === 'function' ? await adapter.loadMessageImages(message) : { images: [], mediaUnavailable: [] }
      const accepted = await runtime.ingest({
        ...message,
        ...(media.images.length > 0 ? { images: media.images } : {}),
        ...(media.mediaUnavailable.length > 0 ? { mediaUnavailable: media.mediaUnavailable } : {}),
      })
      if (accepted.duplicate) return
    })()
    inflightMessages.set(key, operation)
    operation.finally(() => { if (inflightMessages.get(key) === operation) inflightMessages.delete(key) }).catch(() => undefined)
    return operation
  }
  const currentGroup = (groupId) => runtime.getGroup?.(groupId) ?? runtime.listGroups().find((group) => group.groupId === groupId)
  const describeError = (error) => error instanceof Error ? error.message : String(error)
  const now = () => new Date().toISOString()
  const asTimestamp = (value) => new Date(value).valueOf()
  const earlierIso = (left, right) => {
    const leftAt = asTimestamp(left), rightAt = asTimestamp(right)
    if (!Number.isFinite(leftAt)) return Number.isFinite(rightAt) ? new Date(rightAt).toISOString() : undefined
    if (!Number.isFinite(rightAt)) return new Date(leftAt).toISOString()
    return new Date(Math.min(leftAt, rightAt)).toISOString()
  }
  const defaultBackfillStart = (groupId) => {
    const persisted = currentGroup(groupId)
    const latest = [...(persisted?.messages ?? [])]
      .map((message) => asTimestamp(message.occurredAt))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0]
    return new Date(Number.isFinite(latest) ? Math.max(0, latest - groupBackfillOverlapMs) : new Date().setHours(0, 0, 0, 0)).toISOString()
  }
  const beforeOverlap = (value) => {
    const timestamp = asTimestamp(value)
    return Number.isFinite(timestamp) ? new Date(Math.max(0, timestamp - groupBackfillOverlapMs)).toISOString() : undefined
  }
  const entryFor = (groupId) => {
    let entry = bridgeEntries.get(groupId)
    if (entry !== undefined) return entry
    entry = {
      groupId,
      generation: 0,
      listenerState: 'starting',
      backfillState: 'never',
      reconnectAttempt: 0,
      backfillRunning: false,
      recoveryQueued: false,
      recoveryEpoch: 0,
      recoveryRequired: false,
      backfillPromise: Promise.resolve(),
      carrierIssueTail: Promise.resolve(),
    }
    bridgeEntries.set(groupId, entry)
    return entry
  }
  const clearReadyTimer = (entry) => {
    if (entry.readyTimer !== undefined) clearTimeout(entry.readyTimer)
    entry.readyTimer = undefined
  }
  const clearRetryTimer = (entry) => {
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
    delete entry.nextRetryAt
  }
  const healthSnapshot = () => {
    const groups = runtime.listGroups().map((group) => {
      const entry = bridgeEntries.get(group.groupId)
      return {
        groupId: group.groupId,
        listener: {
          state: entry?.listenerState ?? 'starting',
          generation: entry?.generation ?? 0,
          ...(entry?.listenerStartedAt ? { startedAt: entry.listenerStartedAt } : {}),
          ...(entry?.listenerReadyAt ? { readyAt: entry.listenerReadyAt } : {}),
          ...(entry?.lastEventAt ? { lastEventAt: entry.lastEventAt } : {}),
          ...(entry?.lastEventError ? { lastEventError: entry.lastEventError } : {}),
          ...(entry?.lastListenerExitAt ? { lastExitAt: entry.lastListenerExitAt } : {}),
          ...(entry?.lastListenerError ? { lastError: entry.lastListenerError } : {}),
        },
        backfill: {
          state: entry?.backfillState ?? 'never',
          ...(entry?.backfillRunning ? { inProgress: true } : {}),
          ...(entry?.recoveryRequired ? { recoveryRequired: true, ...(entry.recoveryFromAt ? { recoveryFromAt: entry.recoveryFromAt } : {}) } : {}),
          ...(entry?.lastBackfillStartedAt ? { startedAt: entry.lastBackfillStartedAt } : {}),
          ...(entry?.lastBackfillAt ? { succeededAt: entry.lastBackfillAt } : {}),
          ...(entry?.lastBackfillErrorAt ? { failedAt: entry.lastBackfillErrorAt } : {}),
          ...(entry?.lastBackfillError ? { lastError: entry.lastBackfillError } : {}),
        },
        reconnect: {
          attempt: entry?.reconnectAttempt ?? 0,
          ...(entry?.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
        },
      }
    })
    const humanReplies = {
      state: humanReplyEntry.listenerState,
      generation: humanReplyEntry.generation,
      ...(humanReplyEntry.listenerStartedAt ? { startedAt: humanReplyEntry.listenerStartedAt } : {}),
      ...(humanReplyEntry.listenerReadyAt ? { readyAt: humanReplyEntry.listenerReadyAt } : {}),
      ...(humanReplyEntry.lastEventAt ? { lastEventAt: humanReplyEntry.lastEventAt } : {}),
      ...(humanReplyEntry.lastEventError ? { lastEventError: humanReplyEntry.lastEventError } : {}),
      ...(humanReplyEntry.lastListenerExitAt ? { lastExitAt: humanReplyEntry.lastListenerExitAt } : {}),
      ...(humanReplyEntry.lastListenerError ? { lastError: humanReplyEntry.lastListenerError } : {}),
      reconnect: {
        attempt: humanReplyEntry.reconnectAttempt,
        ...(humanReplyEntry.nextRetryAt ? { nextRetryAt: humanReplyEntry.nextRetryAt } : {}),
      },
    }
    const groupsHealthy = groups.length === 0 || groups.every((group) => group.listener.state === 'ready' && group.backfill.state === 'ok' && group.backfill.recoveryRequired !== true)
    return {
      healthy: groupsHealthy && (humanReplies.state === 'ready' || humanReplies.state === 'unavailable'),
      groups,
      humanReplies,
    }
  }
  const publishHealth = () => {
    if (typeof onHealthChange !== 'function') return
    try { onHealthChange(healthSnapshot()) } catch (error) { logger.warn(error) }
  }
  const queueGroupBackfill = (groupId, { queueAfterActive = false, recovery = false } = {}) => {
    const entry = entryFor(groupId)
    if (typeof adapter.readGroupRange !== 'function') {
      entry.backfillState = 'unavailable'
      publishHealth()
      return entry.backfillPromise
    }
    if (entry.backfillRunning) {
      if (queueAfterActive) entry.recoveryQueued = true
      return entry.backfillPromise
    }
    const isRecovery = recovery || entry.recoveryRequired
    const recoveryEpoch = entry.recoveryEpoch
    const hadSuccessfulBackfill = entry.lastBackfillAt !== undefined
    entry.backfillRunning = true
    if (isRecovery || (entry.lastBackfillAt === undefined && entry.backfillState !== 'failed')) entry.backfillState = 'running'
    publishHealth()
    entry.backfillPromise = (async () => {
      if (stopping || currentGroup(groupId) === undefined) return
      entry.lastBackfillStartedAt = now()
      publishHealth()
      try {
        const end = new Date().toISOString()
        const start = earlierIso(defaultBackfillStart(groupId), isRecovery ? entry.recoveryFromAt : undefined)
        entry.activeBackfillStartAt = start
        const history = await adapter.readGroupRange(groupId, { start, end })
        if (!Array.isArray(history.messages) || history.complete !== true || history.hasMore === true || (history.failedCount ?? 0) !== 0) throw new Error(`dws_backfill_partial:${groupId}`)
        const ordered = [...history.messages].sort((left, right) => String(left.createTime ?? '').localeCompare(String(right.createTime ?? '')))
        for (const message of ordered) await processMessage(normalizeHistoryMessage(message, groupId))
        entry.backfillState = 'ok'
        entry.lastBackfillAt = now()
        entry.lastSuccessfulBackfillEndAt = end
        let recoveryCompleted = false
        if (isRecovery && entry.recoveryEpoch === recoveryEpoch && entry.listenerState === 'ready') {
          entry.recoveryRequired = false
          delete entry.recoveryFromAt
          recoveryCompleted = true
        }
        delete entry.lastBackfillError
        delete entry.lastBackfillErrorAt
        publishHealth()
        if (!entry.recoveryRequired && (!hadSuccessfulBackfill || recoveryCompleted)) {
          const completedRecoveryEpoch = entry.recoveryEpoch
          entry.carrierIssueTail = entry.carrierIssueTail
            .then(async () => {
              if (stopping || bridgeEntries.get(groupId) !== entry || entry.listenerState !== 'ready' || entry.recoveryRequired || entry.recoveryEpoch !== completedRecoveryEpoch) return
              await runtime.resolveGroupCarrierIssues?.({ groupId })
            })
            .catch((error) => logger.warn(error))
        }
      } catch (error) {
        entry.backfillState = 'failed'
        entry.lastBackfillError = describeError(error)
        entry.lastBackfillErrorAt = now()
        publishHealth()
        logger.warn(error)
      }
    })().finally(() => {
      delete entry.activeBackfillStartAt
      entry.backfillRunning = false
      const rerunAfterActive = entry.recoveryQueued
      entry.recoveryQueued = false
      publishHealth()
      if (rerunAfterActive && !stopping && currentGroup(groupId) !== undefined) queueGroupBackfill(groupId)
    })
    return entry.backfillPromise
  }
  const processOutbound = async ({ groupId, outbound }) => {
    const delivery = await dispatchOutbox({ adapter, groupId, outbound })
    if (delivery.status === 'sent') await runtime.acknowledge({ groupId, outboundId: outbound.outboundId, deliveredMessageId: delivery.messageId })
  }
  const processPendingCompletedOutbox = () => {
    outboxRetryTail = outboxRetryTail.then(async () => {
      if (stopping) return
      const jobs = []
      for (const group of runtime.listGroups()) {
        const pending = (runtime.getGroup?.(group.groupId) ?? group).outbox ?? []
        for (const outbound of pending.filter((item) => item.status === 'pending' && (item.readbackRequired === true || /^task-result:task-.*:completed(?::\d+)?$/.test(item.sourceMessageId)))) {
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
    const requestedAction = task.humanBlocker.requestedAction
    return [
      redline ? '【群聊个人助理受控操作阻塞，等待人工介入】' : '【群聊个人助理任务阻塞，等待人工介入】',
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
      result?.risk ?? '未单独说明；以阻塞原因、现场证据和处理范围为准。',
      '',
      '【现场证据】',
      ...(evidence.length > 0 ? evidence.map((item) => `- ${item}`) : ['- 暂无']),
      '',
      '【已尝试】',
      ...(attemptedActions.length > 0 ? attemptedActions.map((item) => `- ${item}`) : ['- 无可安全执行的尝试']),
      '',
      '【需要人工处理】',
      requestedAction,
      '',
      redline
        ? '请直接引用本消息回复处理意见；明确回复“拒绝”“不同意”或“不批准”时不执行该操作，其余非空引用回复使任务继续，并将完整原文交给任务重新核验。该等待不设超时。'
        : '请直接引用本消息回复处理方案；只有引用回复会恢复对应任务。该等待不设超时。',
    ].join('\n')
  }
  const quotedMessageId = (message) => message.quotedMessage?.messageId ?? message.quotedMessage?.message_id ?? message.quoted_message?.messageId ?? message.quoted_message?.message_id
  const processHumanReplyEvent = (event) => {
    const message = normalizeEvent(event)
    const quotedId = quotedMessageId(message)
    const reply = typeof message.text === 'string' ? message.text.trim() : ''
    if (!quotedId || !reply) return Promise.resolve()
    const existing = inflightHumanReplies.get(message.messageId)
    if (existing !== undefined) return existing
    const operation = (async () => {
      const task = (runtime.listTasks?.() ?? []).find((item) => item.state === 'waiting'
        && item.waitingKind === 'human-intervention'
        && item.humanBlocker?.status === 'waiting-reply'
        && item.humanBlocker.messageId === quotedId)
      if (task === undefined) return
      const decision = task.humanBlocker.category === 'redline' ? parseRedlineDecision(reply) : 'approved'
      if (decision === undefined) return
      await runtime.resolveHumanBlocker({
        taskId: task.taskId,
        requestId: task.humanBlocker.requestId,
        quotedMessageId: quotedId,
        replyMessageId: message.messageId,
        reply,
        decision,
      })
    })()
    inflightHumanReplies.set(message.messageId, operation)
    operation.finally(() => { if (inflightHumanReplies.get(message.messageId) === operation) inflightHumanReplies.delete(message.messageId) }).catch(() => undefined)
    return operation
  }
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
              const decision = blocker.category === 'redline' ? parseRedlineDecision(recovered.reply) : 'approved'
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
        const decision = blocker.category === 'redline' ? parseRedlineDecision(text) : 'approved'
        if (blocker.category === 'redline' && decision === undefined) continue
        await runtime.resolveHumanBlocker({ taskId: task.taskId, requestId: blocker.requestId, quotedMessageId: blocker.messageId, replyMessageId: reply.messageId, reply: text, decision })
      }
    }).catch((error) => logger.warn(error))
    return humanPollTail
  }
  const processIncrementalGroupBackfill = () => {
    if (stopping) return Promise.resolve([])
    return Promise.allSettled(runtime.listGroups().map((group) => queueGroupBackfill(group.groupId)))
  }
  const reportConsumerExit = async (groupId, result, error) => {
    const fingerprint = result === undefined
      ? 'dws-consumer-error'
      : `dws-consumer-exit:${result.exitCode ?? 'null'}:${result.signal ?? 'none'}`
    const tasks = (runtime.listTasks?.() ?? []).filter((task) => task.groupId === groupId && (task.state === 'running' || task.state === 'waiting'))
    for (const task of tasks) await runtime.reportCarrierIssue?.({ taskId: task.taskId, fingerprint, detail: error ? `DWS consumer failed for group ${groupId}: ${describeError(error)}` : `DWS consumer exited for group ${groupId}` })
  }
  let attach
  const scheduleReconnect = (entry) => {
    if (stopping || entry.retryTimer !== undefined || entry.subscription !== undefined || bridgeEntries.get(entry.groupId) !== entry) return
    const base = Math.max(0, listenerReconnectBaseMs)
    const maximum = Math.max(base, listenerReconnectMaxMs)
    const delay = Math.min(maximum, base * (2 ** Math.max(0, entry.reconnectAttempt - 1)))
    entry.nextRetryAt = new Date(Date.now() + delay).toISOString()
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined
      delete entry.nextRetryAt
      if (stopping || bridgeEntries.get(entry.groupId) !== entry) return
      const group = currentGroup(entry.groupId)
      if (group !== undefined) attach(group)
    }, delay)
    entry.retryTimer.unref?.()
    publishHealth()
  }
  const listenerFailed = (entry, generation, subscription, { result, error } = {}) => {
    if (stopping || bridgeEntries.get(entry.groupId) !== entry || entry.generation !== generation) return
    if (subscription !== undefined && entry.subscription !== subscription) return
    clearReadyTimer(entry)
    if (subscription !== undefined) subscriptions.delete(entry.groupId)
    entry.subscription = undefined
    entry.listenerState = 'reconnecting'
    entry.lastListenerExitAt = now()
    entry.lastListenerError = error ? describeError(error) : `dws_consumer_exit:${result?.exitCode ?? 'null'}:${result?.signal ?? 'none'}`
    entry.recoveryRequired = true
    entry.recoveryEpoch += 1
    entry.recoveryFromAt = earlierIso(entry.recoveryFromAt, entry.activeBackfillStartAt ?? beforeOverlap(entry.lastSuccessfulBackfillEndAt) ?? defaultBackfillStart(entry.groupId))
    entry.reconnectAttempt += 1
    publishHealth()
    entry.carrierIssueTail = entry.carrierIssueTail
      .then(() => reportConsumerExit(entry.groupId, result, error))
      .catch((reportError) => logger.warn(reportError))
    scheduleReconnect(entry)
  }
  const markListenerReady = (entry, generation, subscription) => {
    if (stopping || bridgeEntries.get(entry.groupId) !== entry || entry.generation !== generation || entry.subscription !== subscription || entry.listenerState === 'ready') return
    clearReadyTimer(entry)
    entry.listenerState = 'ready'
    entry.listenerReadyAt = now()
    entry.reconnectAttempt = 0
    delete entry.lastListenerError
    publishHealth()
    queueGroupBackfill(entry.groupId, { queueAfterActive: true, recovery: entry.recoveryRequired })
  }
  attach = (group) => {
    const entry = entryFor(group.groupId)
    if (stopping || entry.subscription !== undefined || entry.retryTimer !== undefined) return
    const generation = entry.generation + 1
    entry.generation = generation
    entry.listenerState = 'starting'
    entry.listenerStartedAt = now()
    delete entry.lastListenerError
    publishHealth()
    let subscription
    try {
      subscription = adapter.startGroupSubscription(group.groupId, async (event) => {
        if (stopping || bridgeEntries.get(group.groupId) !== entry || entry.generation !== generation || entry.subscription !== subscription) return
        try {
          const message = normalizeEvent(event)
          entry.lastEventAt = now()
          delete entry.lastEventError
          publishHealth()
          await processMessage(message)
        } catch (error) {
          entry.lastEventError = describeError(error)
          publishHealth()
          logger.warn(error)
        }
      })
    } catch (error) {
      listenerFailed(entry, generation, undefined, { error })
      return
    }
    entry.subscription = subscription
    subscriptions.set(group.groupId, subscription)
    const ready = () => markListenerReady(entry, generation, subscription)
    subscription.lifecycle?.on?.('ready', ready)
    subscription.lifecycle?.on?.('line-error', (error) => {
      if (bridgeEntries.get(group.groupId) !== entry || entry.generation !== generation || entry.subscription !== subscription) return
      entry.lastEventError = describeError(error)
      publishHealth()
      logger.warn(error)
    })
    if (subscription.ready === undefined) ready()
    else Promise.resolve(subscription.ready).then(ready, (error) => listenerFailed(entry, generation, subscription, { error })).catch((error) => logger.warn(error))
    if (listenerReadyTimeoutMs > 0 && entry.listenerState === 'starting') {
      entry.readyTimer = setTimeout(() => {
        if (entry.listenerState !== 'starting' || bridgeEntries.get(group.groupId) !== entry || entry.generation !== generation || entry.subscription !== subscription) return
        listenerFailed(entry, generation, subscription, { error: new Error('dws_listener_ready_timeout') })
        try { subscription.stop() } catch (error) { logger.warn(error) }
      }, listenerReadyTimeoutMs)
      entry.readyTimer.unref?.()
    }
    Promise.resolve(subscription.done).then((result) => {
      if (result !== undefined) listenerFailed(entry, generation, subscription, { result })
    }, (error) => listenerFailed(entry, generation, subscription, { error })).catch((error) => logger.warn(error))
  }
  const clearHumanReplyReadyTimer = () => {
    if (humanReplyEntry.readyTimer !== undefined) clearTimeout(humanReplyEntry.readyTimer)
    humanReplyEntry.readyTimer = undefined
  }
  const clearHumanReplyRetryTimer = () => {
    if (humanReplyEntry.retryTimer !== undefined) clearTimeout(humanReplyEntry.retryTimer)
    humanReplyEntry.retryTimer = undefined
    delete humanReplyEntry.nextRetryAt
  }
  let attachHumanReplies
  const scheduleHumanReplyReconnect = () => {
    if (stopping || humanReplyEntry.retryTimer !== undefined || humanReplyEntry.subscription !== undefined || typeof attachHumanReplies !== 'function') return
    const base = Math.max(0, listenerReconnectBaseMs)
    const maximum = Math.max(base, listenerReconnectMaxMs)
    const delay = Math.min(maximum, base * (2 ** Math.max(0, humanReplyEntry.reconnectAttempt - 1)))
    humanReplyEntry.nextRetryAt = new Date(Date.now() + delay).toISOString()
    humanReplyEntry.retryTimer = setTimeout(() => {
      humanReplyEntry.retryTimer = undefined
      delete humanReplyEntry.nextRetryAt
      attachHumanReplies()
    }, delay)
    humanReplyEntry.retryTimer.unref?.()
    publishHealth()
  }
  const humanReplyListenerFailed = (generation, subscription, { result, error } = {}) => {
    if (stopping || humanReplyEntry.generation !== generation) return
    if (subscription !== undefined && humanReplyEntry.subscription !== subscription) return
    clearHumanReplyReadyTimer()
    humanReplyEntry.subscription = undefined
    humanReplyEntry.listenerState = 'reconnecting'
    humanReplyEntry.lastListenerExitAt = now()
    humanReplyEntry.lastListenerError = error ? describeError(error) : `dws_human_reply_consumer_exit:${result?.exitCode ?? 'null'}:${result?.signal ?? 'none'}`
    humanReplyEntry.reconnectAttempt += 1
    publishHealth()
    scheduleHumanReplyReconnect()
  }
  attachHumanReplies = () => {
    if (stopping || typeof adapter.startHumanReplySubscription !== 'function' || humanReplyEntry.subscription !== undefined || humanReplyEntry.retryTimer !== undefined) return
    const generation = humanReplyEntry.generation + 1
    humanReplyEntry.generation = generation
    humanReplyEntry.listenerState = 'starting'
    humanReplyEntry.listenerStartedAt = now()
    delete humanReplyEntry.lastListenerError
    publishHealth()
    let subscription
    try {
      subscription = adapter.startHumanReplySubscription(async (event) => {
        if (stopping || humanReplyEntry.generation !== generation || humanReplyEntry.subscription !== subscription) return
        try {
          humanReplyEntry.lastEventAt = now()
          delete humanReplyEntry.lastEventError
          publishHealth()
          await processHumanReplyEvent(event)
        } catch (error) {
          humanReplyEntry.lastEventError = describeError(error)
          publishHealth()
          logger.warn(error)
        }
      })
    } catch (error) {
      humanReplyListenerFailed(generation, undefined, { error })
      return
    }
    humanReplyEntry.subscription = subscription
    const ready = () => {
      if (stopping || humanReplyEntry.generation !== generation || humanReplyEntry.subscription !== subscription) return
      clearHumanReplyReadyTimer()
      humanReplyEntry.listenerState = 'ready'
      humanReplyEntry.listenerReadyAt = now()
      humanReplyEntry.reconnectAttempt = 0
      delete humanReplyEntry.lastListenerError
      publishHealth()
    }
    subscription.lifecycle?.on?.('ready', ready)
    subscription.lifecycle?.on?.('line-error', (error) => {
      if (humanReplyEntry.generation !== generation || humanReplyEntry.subscription !== subscription) return
      humanReplyEntry.lastEventError = describeError(error)
      publishHealth()
      logger.warn(error)
    })
    if (subscription.ready === undefined) ready()
    else Promise.resolve(subscription.ready).then(ready, (error) => humanReplyListenerFailed(generation, subscription, { error })).catch((error) => logger.warn(error))
    if (listenerReadyTimeoutMs > 0 && humanReplyEntry.listenerState === 'starting') {
      humanReplyEntry.readyTimer = setTimeout(() => {
        if (humanReplyEntry.listenerState !== 'starting' || humanReplyEntry.generation !== generation || humanReplyEntry.subscription !== subscription) return
        humanReplyListenerFailed(generation, subscription, { error: new Error('dws_human_reply_listener_ready_timeout') })
        try { subscription.stop() } catch (error) { logger.warn(error) }
      }, listenerReadyTimeoutMs)
      humanReplyEntry.readyTimer.unref?.()
    }
    Promise.resolve(subscription.done).then((result) => {
      if (result !== undefined) humanReplyListenerFailed(generation, subscription, { result })
    }, (error) => humanReplyListenerFailed(generation, subscription, { error })).catch((error) => logger.warn(error))
  }
  const stopEntry = (groupId, { remove = false } = {}) => {
    const entry = bridgeEntries.get(groupId)
    if (entry === undefined) return undefined
    entry.generation += 1
    clearReadyTimer(entry)
    clearRetryTimer(entry)
    const subscription = entry.subscription
    entry.subscription = undefined
    entry.listenerState = 'stopped'
    subscriptions.delete(groupId)
    if (remove) bridgeEntries.delete(groupId)
    try { subscription?.stop() } catch (error) { logger.warn(error) }
    return entry
  }

  for (const group of runtime.listGroups()) attach(group)
  attachHumanReplies()
  const detachListener = runtime.onGroupSubscribed(attach)
  const detachUnsubscribeListener = (runtime.onGroupUnsubscribed ?? (() => () => undefined))(({ groupId }) => {
    stopEntry(groupId, { remove: true })
    publishHealth()
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
  publishHealth()
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
    detachGroupMessageRecaller()
    const entries = [...bridgeEntries.values()]
    const closingSubscriptions = entries.map((entry) => entry.subscription).filter(Boolean)
    const closingHumanReplySubscription = humanReplyEntry.subscription
    humanReplyEntry.generation += 1
    clearHumanReplyReadyTimer()
    clearHumanReplyRetryTimer()
    humanReplyEntry.subscription = undefined
    humanReplyEntry.listenerState = 'stopped'
    try { closingHumanReplySubscription?.stop() } catch (error) { logger.warn(error) }
    for (const entry of entries) stopEntry(entry.groupId)
    publishHealth()
    await Promise.allSettled(closingSubscriptions.map((subscription) => subscription.done))
    if (closingHumanReplySubscription !== undefined) await Promise.allSettled([closingHumanReplySubscription.done])
    await humanPollTail
    await Promise.allSettled(entries.map((entry) => entry.backfillPromise))
    await outboxRetryTail
    subscriptions.clear()
    bridgeEntries.clear()
    inflightMessages.clear()
    inflightHumanReplies.clear()
  }
}
