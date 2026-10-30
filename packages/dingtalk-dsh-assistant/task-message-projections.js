import { createHash } from 'node:crypto'
import { taskNotificationRecovery } from './notification-delivery.js'

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const resourceIdentity = resource => {
  const key = ['resourceId', 'mediaId', 'fileId', 'attachmentId', 'id'].find(name => resource?.[name] !== undefined)
  return canonical(key ? [resource.type ?? '', key, resource[key]] : resource)
}

/** Transport download hints are enrichment, not another source fact. */
export const stableTaskResourceIdentity = resources => canonical([...new Set((resources ?? []).map(resourceIdentity))].sort())

const mergeMetadata = (previous, incoming) => Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(incoming)])].map(key => {
  const old = previous[key], value = incoming[key]
  return [key, value === undefined ? old : old && value && typeof old === 'object' && typeof value === 'object'
    && !Array.isArray(old) && !Array.isArray(value) ? mergeMetadata(old, value) : value]
}))

export function mergeTaskResources(previous = [], incoming = []) {
  const byIdentity = new Map(previous.map(resource => [resourceIdentity(resource), resource]))
  return incoming.map(resource => {
    const prior = byIdentity.get(resourceIdentity(resource))
    if (!prior) return resource
    return { ...prior, ...resource,
      ...(prior.download && resource.download ? { download: mergeMetadata(prior.download, resource.download) } : {}) }
  })
}

const imageFingerprint = image => createHash('sha256').update(image.mediaType ?? '').update('\0')
  .update(Buffer.from(image.data)).digest('hex')

async function saveStableImages(ctx, images, previousRefs = []) {
  const fingerprints = images.map(imageFingerprint)
  if (previousRefs.length === images.length && previousRefs.every((ref, index) => ref.taskMediaFingerprint === fingerprints[index])) return previousRefs
  const refs = await ctx.attachments.saveImages(images)
  return refs.map((ref, index) => ({ ...ref, taskMediaFingerprint: fingerprints[index] }))
}

/** 统筹会话排空只代表本轮结束；排队或仍在执行的小目标仍属于任务执行中。 */
export function taskBoardState(task, executions = [], pendingWake = false) {
  if (task.status === 'completed') return 'completed'
  if (task.control === 'cancelled') return 'cancelled'
  if (task.control === 'paused') return 'waiting'
  if (task.humanRequests?.some(request => request.status === 'waiting-reply')) return 'waiting'
  if (!task.drained) return 'running'
  if (pendingWake && !task.lastDecision) return 'running'
  if (task.lastDecision?.action === 'blocked' || task.lastDecision?.question?.trim()) return 'waiting'
  return executions.some(execution => ['queued', 'running'].includes(execution.status) || execution.drained === false) ? 'running' : 'waiting'
}

/** Thin adapters into the existing group timeline. No dispatch or retry policy lives here. */
export async function ingestTaskResidentMessage({ ctx, residentStore, message, readResource, onPhase }) {
  if (!residentStore) return undefined
  const measured = async (phase, action) => {
    const startedAt = new Date().toISOString()
    try { return await action() }
    finally { onPhase?.({ phase, startedAt, completedAt: new Date().toISOString() }) }
  }
  let imageRefs = message.imageRefs
  const previous = residentStore.getGroup?.(message.groupId)?.messages.find(item => item.messageId === message.messageId)
  const unavailable = [...(message.mediaUnavailable ?? [])]
  if (message.images?.length) {
    imageRefs = await measured('image-save', () => saveStableImages(ctx, message.images, previous?.imageRefs))
  } else if (!imageRefs?.length && readResource && message.mediaUnavailable === undefined) {
    // Documents remain lazy task materials; only image facts belong in this timeline.
    const images = []
    for (const resource of (message.resourceRefs ?? []).filter(item => item?.type === 'mediaId')) {
      try {
        const value = await measured('resource-read', () => readResource(message.groupId, message.messageId, resource))
        if (value?.image) images.push(value.image)
        else if (value?.imageRefs?.length) imageRefs = [...(imageRefs ?? []), ...value.imageRefs]
        else unavailable.push(`${resource.resourceId}: image_resource_unavailable`)
      } catch (error) { unavailable.push(`${resource.resourceId}: ${error.code ?? error.message ?? 'RESOURCE_READ_FAILED'}`) }
    }
    if (images.length) imageRefs = [...(imageRefs ?? []), ...await measured('image-save', () => saveStableImages(ctx, images, previous?.imageRefs))]
  }
  const { images: _images, ...facts } = message
  return measured('resident-store', () => residentStore.ingest({ ...facts,
    ...(imageRefs !== undefined ? { imageRefs } : {}),
    ...(unavailable.length || message.mediaUnavailable !== undefined ? { mediaUnavailable: unavailable } : {}) }))
}

/** Message-version facts only; mutable timestamps and notification bodies are not timing evidence. */
export function messageProcessingSources(sources, notifications, groupId, coordinationSources = [], ownerships = [], arrangements = []) {
  return sources.filter(source => source.groupId === groupId).map(source => ({
    sourceId: source.sourceId, groupId: source.groupId, messageId: source.messageId, version: source.version, channel: source.channel,
    receivedAt: source.receivedAt ?? null, routed: source.routed === true, routedAt: source.routedAt ?? null,
    routePreparedAt: source.routePreparedAt ?? null,
    coordinationRetirement: source.coordinationRetirement ?? null,
    processingCompleted: source.processingCompleted ? { at: source.processingCompleted.at,
      routingRevision: source.processingCompleted.routingRevision,
      activeUnitRefs: (source.processingCompleted.activeUnitRefs ?? []).map(({ unitId, unitRevision }) => ({ unitId, unitRevision })) } : null,
    notifications: notifications.filter(notification => notification.payload?.conversationId === source.groupId
      && (notification.payload.sourceRef?.messageId ?? notification.payload.sourceMessageId) === source.messageId
      && (!notification.payload.sourceId || notification.payload.sourceId === source.sourceId)
      && (!notification.payload.sourceVersion || notification.payload.sourceVersion === source.version)).map(notification => ({
      notificationId: notification.id, state: notification.state, sourceMessageId: notification.payload.sourceRef?.messageId ?? notification.payload.sourceMessageId,
      sourceVersion: notification.payload.sourceVersion ?? null,
      versionMatched: notification.payload.sourceId === source.sourceId || notification.payload.sourceVersion === source.version,
      sendStartedAt: notification.sendStartedAt ?? null, ackedAt: notification.ackedAt ?? null,
      deliveredAt: notification.deliveredAt ?? null,
      sendAttemptCount: notification.sendAttemptCount ?? null, readbackAttemptCount: notification.readbackAttemptCount ?? null,
    })),
    stages: (source.stages ?? []).map(stage => ({ spanId: stage.spanId, stage: stage.stage, requestId: stage.requestId, attempt: stage.attempt,
      startedAt: stage.startedAt ?? null, completedAt: stage.completedAt ?? null, quality: stage.quality ?? 'unknown',
      shared: stage.shared === true, ...(stage.sessionId ? { sessionId: stage.sessionId } : {}),
      ...(stage.phase ? { phase: stage.phase } : {}), ...(stage.loopDelayMs !== undefined ? { loopDelayMs: stage.loopDelayMs } : {}) })),
  }))
}

export function taskNotificationOutbound(notification) {
  const payload = notification.payload
  const receipt = notification.receipt
  const delivered = notification.state === 'delivered'
  const retired = ['failed', 'superseded'].includes(notification.state)
  const cancelledReason = { coordination_cancelled: 'coordination-cancelled', stale_question: 'stale-question' }[notification.reason]
  // 失效不等于未发送：只有未领取发送许可，或已有严格拒发结论且无接纳回执，才投影未发送事实。
  const unclaimed = !notification.sendPermit && !notification.dispatchToken && !notification.sendStartedAt && !(notification.sendAttemptCount > 0)
  const knownNotSent = retired && !notification.ack && !receipt && (notification.deliveryError?.knownNotSent === true
    || unclaimed && (notification.state === 'superseded' || !!cancelledReason))
  const error = knownNotSent ? notification.deliveryError : notification.lastReadbackError ?? notification.deliveryError
  const retryable = !delivered && notification.state !== 'superseded'
    && (notification.state !== 'failed' || knownNotSent && notification.deliveryError?.retryable === true && !notification.retirement && !cancelledReason)
  const pendingReason = retired && notification.retirement ? notification.retirement.reason
    : notification.state === 'failed' && cancelledReason ? cancelledReason
      : knownNotSent && notification.state === 'failed' ? 'pre-send-rejected' : notification.state
  return {
    outboundId: notification.id,
    notificationRecovery: taskNotificationRecovery(notification),
    ...(notification.supersededBy ? { supersededByOutboundId: notification.supersededBy, supersededAt: notification.updatedAt } : {}),
    // One source can produce both a question and completion. Deduplicate by notification.
    sourceMessageId: `task-notification:${notification.id}`,
    text: payload.text,
    status: delivered ? 'sent' : notification.state === 'superseded' || notification.supersededBy ? 'superseded' : 'pending',
    notificationState: notification.state,
    notificationRetryAt: retryable ? notification.nextAttemptAt ?? undefined : undefined,
    notificationKnownNotSent: knownNotSent,
    // 显式清空可选字段，避免与旧发信箱记录合并时残留上一阶段的失败诊断。
    notificationFailurePhase: !delivered ? error?.phase : undefined,
    deliveryError: error && !delivered ? [error.serverErrorCode, error.reason, error.message].filter(Boolean).join(': ').slice(0, 512) || undefined : undefined,
    deliveryPendingReason: !delivered ? `task-notification-${pendingReason}` : undefined,
    ...(notification.taskId ? { notificationTaskId: notification.taskId } : {}),
    ...(payload.topicRefs ? { topicRefs: payload.topicRefs } : {}),
    ...(payload.replyTopicId ? { replyTopicId: payload.replyTopicId } : {}),
    ...(payload.taskIds ? { taskIds: payload.taskIds } : notification.taskId ? { taskIds: [notification.taskId] } : {}),
    ...(payload.coveredEventIds ? { coveredEventIds: payload.coveredEventIds } : {}),
    readbackRequired: true,
    replyToMessageId: payload.sourceMessageId,
    replyToSenderOpenDingTalkId: payload.actorId,
    atOpenDingTalkIds: payload.atOpenDingTalkIds ?? [], ...(payload.atAll ? { atAll: true } : {}),
    ...(payload.sourceRef ? { sourceRef: payload.sourceRef } : {}), ...(payload.artifactFiles?.length ? { artifactFiles: payload.artifactFiles } : {}),
    replyKind: payload.replyKind ?? 'substantive',
    matterSourceMessageIds: payload.sourceRef ? [payload.sourceRef.messageId] : payload.sourceMessageId ? [payload.sourceMessageId] : [],
    ...(notification.kind === 'fixed-topic-reply' ? { matterUnitRefs: [{ unitId: payload.fact.unitId, unitRevision: payload.fact.unitRevision }] } : {}),
    // 创建通知到获得发送许可之间可能排队；历史缺失时不伪造发送开始。
    sendStartedAt: notification.sendStartedAt,
    ...(delivered ? { deliveredAt: receipt?.observedAt ?? notification.updatedAt,
      ...(receipt?.sentAt ? { sentAt: receipt.sentAt } : {}),
      ...(receipt?.messageId ? { deliveredMessageId: receipt.messageId } : {}) } : {}),
  }
}

export async function projectTaskNotification({ residentStore, notification }) {
  if (notification?.payload?.audience === 'operator') return undefined
  if (!residentStore || !notification?.payload?.conversationId) return undefined
  return residentStore.projectTaskNotification({ groupId: notification.payload.conversationId,
    outbound: taskNotificationOutbound(notification) })
}
