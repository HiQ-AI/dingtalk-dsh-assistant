import { matchesOutbound } from './dws-adapter.js'
import { notificationOpenTaskId } from './group-message.js'
import { sameDeliveredText } from './group-message.js'

export async function readOperatorNotificationDelivery(adapter, notification) {
  const payload = notification.payload, openTaskId = notificationOpenTaskId(notification.ack ?? notification.receipt)
  const proof = openTaskId
    ? await adapter.confirmSelfDelivery({ openTaskId, recipientUserId: payload.recipientUserId, text: payload.text })
    : await adapter.findWorkflowApprovalNotice({ requestId: payload.humanRequestId, recipientUserId: payload.recipientUserId, text: payload.text })
  return proof?.senderActorId ? proof : undefined
}

/** Never infer a native quote or mention merely from matching prose. */
export function verifyTaskNotificationReadback(notification, observed, { acknowledgedMessageId, senderActorId, sendStatusConfirmed = false } = {}) {
  const payload = notification.payload
  const messageId = observed?.messageId
  if (!messageId || observed.conversationId !== payload.conversationId) return undefined
  const quote = observed.quotedMessage
  if (quote?.messageId !== payload.sourceMessageId || quote?.conversationId !== payload.conversationId) return undefined
  const expected = payload.atOpenDingTalkIds ?? []
  const actual = observed.atOpenDingTalkIds ?? observed.at?.atOpenDingTalkIds
    ?? (Array.isArray(observed.mentions) ? observed.mentions.map(item => typeof item === 'string' ? item : item.openDingTalkId ?? item.userId) : undefined)
  const exactReceipt = acknowledgedMessageId === messageId
  const exactUuid = (observed.uuid ?? observed.idempotencyKey) === notification.id
  const ownSender = senderActorId && (observed.senderOpenDingTalkId ?? observed.senderId) === senderActorId
  if (senderActorId && !ownSender) return undefined
  // DWS 查询不暴露原生 @ 元数据；只在 SUCCESS 的精确发送回执和发送者均核实时确认送达。
  // 这不证明 @ 已核验；历史匹配仍须提供原生 @，显式错误的 @ 始终拒绝。
  const unavailableMention = expected.length > 0 && actual === undefined
  if (expected.length && (unavailableMention ? !(exactReceipt && sendStatusConfirmed && ownSender)
    : !Array.isArray(actual) || expected.some(id => !actual.includes(id)))) return undefined
  if (!exactReceipt && !exactUuid && !ownSender) return undefined
  if (!sameDeliveredText(observed.text, payload.text, quote)) return undefined
  return { messageId, conversationId: payload.conversationId, quoteMessageId: quote.messageId,
    atOpenDingTalkIds: unavailableMention ? [] : [...expected], mentionVerification: unavailableMention ? 'unavailable' : 'verified',
    identity: exactReceipt ? 'send-receipt' : exactUuid ? 'idempotency-key' : 'configured-sender', observedAt: new Date().toISOString() }
}

export async function readTaskNotificationDelivery(adapter, notification, { senderActorId } = {}) {
  const ack = notification.ack ?? notification.receipt
  let messageId = ack?.messageId ?? ack?.messageRef?.openMessageId ?? ack?.sendReceipt?.messageId ?? ack?.result?.messageId ?? ack?.result?.openMessageId
  const openTaskId = notificationOpenTaskId(ack)
  let sendStatusConfirmed = false
  if (openTaskId) {
    const status = await adapter.querySendStatus(openTaskId)
    const conversationId = status.messageRef?.openConversationId ?? status.result?.openConversationId
    if (status.result?.sendStatus !== 'SUCCESS' || conversationId !== notification.payload.conversationId) return undefined
    const sentMessageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
    if (messageId && sentMessageId !== messageId) return undefined
    messageId = sentMessageId
    sendStatusConfirmed = true
  }
  const acknowledgedMessageId = messageId
  if (!messageId) {
    const outbound = { outboundId: notification.id, text: notification.payload.text,
      replyToMessageId: notification.payload.sourceMessageId, replyToSenderOpenDingTalkId: notification.payload.actorId,
      atOpenDingTalkIds: notification.payload.atOpenDingTalkIds ?? [] }
    const history = await adapter.readGroup(notification.payload.conversationId)
    if (history.complete !== true || history.hasMore === true || !Array.isArray(history.messages) || history.failedCount > 0 || history.failures?.length) throw new Error('TASK_NOTIFICATION_INCOMPLETE_READBACK')
    const exact = history.messages?.filter(message => matchesOutbound(message, outbound)) ?? []
    if (exact.length > 1) throw new Error('TASK_NOTIFICATION_AMBIGUOUS_READBACK')
    const found = exact[0] ?? await adapter.findOutboundMessage(notification.payload.conversationId, outbound)
    messageId = found?.messageId
    if (!messageId) return undefined
  }
  const observed = await adapter.readMessage(notification.payload.conversationId, messageId)
  return verifyTaskNotificationReadback(notification, observed, { acknowledgedMessageId, senderActorId, sendStatusConfirmed })
}
