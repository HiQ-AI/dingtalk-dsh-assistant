import { quotedSendRejectionProof, persistedUuidSendRejectionProof } from './group-message.js'
import { createHash } from 'node:crypto'

// Diagnostics are bounded and scrubbed before they cross the durable/UI boundary.
export function safeNotificationDetail(value, depth = 0) {
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return value
    .replace(/\b(Bearer\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/giu, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, url => url.includes('?') ? url.split('?')[0] + '?[redacted]' : url)
    .slice(0, 4096)
  if (Array.isArray(value)) return value.slice(0, 32).map(item => safeNotificationDetail(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key,
    /^(?:authorization|password|secret|.*token|api[_-]?key|sig|signature|x-amz-signature|x-amz-credential)$/iu.test(key) ? '[redacted]' : safeNotificationDetail(item, depth + 1)]))
  return value ?? null
}
export function notificationErrorDetail(error, phase) {
  return safeNotificationDetail({ phase, name: error.name, message: error.message, code: error.code,
    serverErrorCode: error.serverErrorCode, reason: error.reason, origin: error.origin, operation: error.operation, retryable: error.retryable, knownNotSent: error.knownNotSent === true, proof: error.proof, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr })
}
const deliveredProof = proof => proof && typeof proof.messageId === 'string' && proof.messageId.trim() && proof.visible !== false && !proof.error && (proof.deliveryStatus === undefined && proof.status === undefined || ['success', 'delivered', 'sent', 'SUCCESS'].includes(proof.deliveryStatus ?? proof.status))
const evidence = proof => `notification-readback:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`

export function notificationRetryAt(notification, error, phase, now = Date.now()) {
  const rateLimited = error?.serverErrorCode === 'RATE_LIMIT_ERROR' || error?.code === 'RATE_LIMIT_ERROR'
  const base = rateLimited ? 60000 : error?.knownNotSent ? 60000 : 5000
  const attempt = phase === 'send' ? notification.sendAttemptCount ?? 1 : notification.readbackAttemptCount ?? 0
  const delay = Math.min(300000, base * 2 ** Math.min(6, Math.max(0, attempt - (phase === 'send' ? 1 : 0))))
  const serverDelay = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0
  return new Date(now + Math.max(delay, serverDelay)).toISOString()
}

const knownPreSendRejection = (error, notification) => error.knownNotSent === true && !!quotedSendRejectionProof(error, {
  groupId: notification.payload.conversationId, replyToMessageId: notification.payload.sourceMessageId,
  replyToSenderOpenDingTalkId: notification.payload.actorId, idempotencyKey: notification.id,
})

export async function deliverTaskNotification({ notification, notifications, command }) {
  if (!notifications || notification.state === 'delivered') return
  const uuidRejection = persistedUuidSendRejectionProof(notification)
  if (uuidRejection) {
    // 原尝试的完整参数拒绝证据只能结清为未发送失败，不能借升级重放历史提醒。
    await command('notification.reconcile', { notificationId: notification.id, state: 'failed', receipt: null,
      error: { ...notification.deliveryError, knownNotSent: true, retryable: false, proof: uuidRejection }, evidenceRef: evidence(uuidRejection) })
    return
  }
  if (notification.state === 'unknown' && !notification.ack && !notification.receipt && notification.deliveryError?.phase === 'send'
    && quotedSendRejectionProof(notification.deliveryError, { groupId: notification.payload.conversationId, replyToMessageId: notification.payload.sourceMessageId,
      replyToSenderOpenDingTalkId: notification.payload.actorId, idempotencyKey: notification.id })) {
    notification = (await command('notification.rejectBeforeSend', { notificationId: notification.id })).result.notification
  }
  if (Date.parse(notification.nextAttemptAt ?? '') > Date.now()) return
  if (notification.state === 'failed') {
    if (notifications.canDisclose && !await notifications.canDisclose(notification)) return
    if (notification.deliveryError?.knownNotSent !== true || notification.deliveryError?.retryable !== true) return
    const retried = await command('notification.retry', { notificationId: notification.id })
    notification = retried.result.notification
    if (notification.state !== 'prepared') return
  }
  if (notification.state === 'unknown' || notification.state === 'starting') {
    try {
      const proof = await notifications.readback?.({ ...notification, ack: notification.ack ?? notification.receipt })
      if (deliveredProof(proof)) await command('notification.reconcile', { notificationId: notification.id, state: 'delivered', receipt: safeNotificationDetail(proof), evidenceRef: evidence(proof) })
      else await command('notification.diagnostic', { notificationId: notification.id, nextAttemptAt: notificationRetryAt(notification, null, 'readback') })
    } catch (error) {
      error.notificationRetryAt = notificationRetryAt(notification, error, 'readback')
      await command('notification.diagnostic', { notificationId: notification.id, error: notificationErrorDetail(error, 'readback'), nextAttemptAt: error.notificationRetryAt })
      throw error
    }
    return
  }
  if (notifications.canDisclose && !await notifications.canDisclose(notification)) return
  let started
  try { started = await command('notification.start', { notificationId: notification.id }, `notification-start:${notification.id}:${notification.sendAttemptCount ?? 0}`) }
  catch (error) {
    // 后续来源仍在处理时保持 prepared；本轮不占发送槽重试，完成事实会重新唤醒。
    if (error.code === 'DYNAMIC_NOTIFICATION_SOURCE_PENDING') return { sourcePending: true }
    throw error
  }
  if (!started.dispatchEligible) return
  const claimed = started.result.notification
  let ack, phase = 'send'
  try {
    ack = await notifications.send(claimed)
    await command('notification.ack', { notificationId: claimed.id, dispatchToken: claimed.dispatchToken, ack: safeNotificationDetail(ack) }, `notification-ack:${claimed.id}:${claimed.dispatchToken}`)
    phase = 'readback'
    const proof = await notifications.readback?.({ ...claimed, ack })
    await command('notification.receipt', { notificationId: claimed.id, dispatchToken: claimed.dispatchToken,
      phase: 'readback', state: deliveredProof(proof) ? 'delivered' : 'unknown', receipt: safeNotificationDetail(deliveredProof(proof) ? proof : ack),
      ...(deliveredProof(proof) ? {} : { nextAttemptAt: notificationRetryAt(claimed, null, 'readback') }) }, `notification-receipt:${claimed.id}:${claimed.dispatchToken}`)
  } catch (error) {
    const rejected = phase === 'send' && knownPreSendRejection(error, claimed)
    if (!rejected) error.knownNotSent = false
    error.notificationRetryAt = notificationRetryAt(claimed, error, phase)
    await command('notification.receipt', { notificationId: claimed.id, dispatchToken: claimed.dispatchToken,
      phase, state: rejected ? 'failed' : 'unknown', receipt: safeNotificationDetail(ack), error: notificationErrorDetail(error, phase),
      nextAttemptAt: error.notificationRetryAt }, `notification-receipt:${claimed.id}:${claimed.dispatchToken}`)
    throw error
  }
}

// Recall is a separate durable effect: the human answer is already committed.
export async function recallTaskOperatorNotification({ notification, notifications, command }) {
  if (!notifications?.recall || notification.recall?.state === 'recalled'
    || Date.parse(notification.recall?.nextAttemptAt ?? '') > Date.now()) return
  const started = await command('notification.recall.start', { notificationId: notification.id })
  if (!started.dispatchEligible) return
  const claimed = started.result.notification
  try {
    const proof = await notifications.recall(claimed)
    if (proof?.messageId !== claimed.receipt.messageId || proof.conversationId !== claimed.receipt.conversationId
      || proof.recallStatus !== 'SUCCESS') throw new Error('TASK_NOTIFICATION_RECALL_UNCONFIRMED')
    await command('notification.recall.result', { notificationId: claimed.id, token: claimed.recall.token,
      state: 'recalled', evidenceRef: evidence(proof), proof: safeNotificationDetail(proof) })
  } catch (error) {
    await command('notification.recall.result', { notificationId: claimed.id, token: claimed.recall.token,
      state: 'failed', error: notificationErrorDetail(error, 'recall'),
      nextAttemptAt: notificationRetryAt({ readbackAttemptCount: claimed.recall.attempts }, error, 'readback') })
    throw error
  }
}
