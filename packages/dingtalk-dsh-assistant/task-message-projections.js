import { createHash } from 'node:crypto'

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
export async function ingestTaskResidentMessage({ ctx, residentStore, message, readResource }) {
  if (!residentStore) return undefined
  let imageRefs = message.imageRefs
  const previous = residentStore.getGroup?.(message.groupId)?.messages.find(item => item.messageId === message.messageId)
  const unavailable = [...(message.mediaUnavailable ?? [])]
  if (message.images?.length) {
    imageRefs = await saveStableImages(ctx, message.images, previous?.imageRefs)
  } else if (!imageRefs?.length && readResource && message.mediaUnavailable === undefined) {
    // Documents remain lazy task materials; only image facts belong in this timeline.
    const images = []
    for (const resource of (message.resourceRefs ?? []).filter(item => item?.type === 'mediaId')) {
      try {
        const value = await readResource(message.groupId, message.messageId, resource)
        if (value?.image) images.push(value.image)
        else if (value?.imageRefs?.length) imageRefs = [...(imageRefs ?? []), ...value.imageRefs]
        else unavailable.push(`${resource.resourceId}: image_resource_unavailable`)
      } catch (error) { unavailable.push(`${resource.resourceId}: ${error.code ?? error.message ?? 'RESOURCE_READ_FAILED'}`) }
    }
    if (images.length) imageRefs = [...(imageRefs ?? []), ...await saveStableImages(ctx, images, previous?.imageRefs)]
  }
  const { images: _images, ...facts } = message
  return residentStore.ingest({ ...facts,
    ...(imageRefs !== undefined ? { imageRefs } : {}),
    ...(unavailable.length || message.mediaUnavailable !== undefined ? { mediaUnavailable: unavailable } : {}) })
}

export function taskNotificationOutbound(notification) {
  const payload = notification.payload
  const receipt = notification.receipt
  const knownNotSent = notification.state === 'failed' && !notification.ack && !notification.receipt && notification.deliveryError?.knownNotSent === true
  const error = knownNotSent ? notification.deliveryError : notification.lastReadbackError ?? notification.deliveryError
  const delivered = notification.state === 'delivered'
  return {
    outboundId: notification.id,
    // One source can produce both a question and completion. Deduplicate by notification.
    sourceMessageId: `task-notification:${notification.id}`,
    text: payload.text,
    status: delivered ? 'sent' : 'pending',
    notificationState: notification.state,
    notificationRetryAt: !delivered ? notification.nextAttemptAt ?? undefined : undefined,
    notificationKnownNotSent: knownNotSent,
    ...(error && !delivered ? { notificationFailurePhase: error.phase,
      deliveryError: [error.serverErrorCode, error.reason, error.message].filter(Boolean).join(': ').slice(0, 512) } : {}),
    ...(notification.taskId ? { notificationTaskId: notification.taskId } : {}),
    ...(payload.topicRefs ? { topicRefs: payload.topicRefs } : {}),
    readbackRequired: true,
    replyToMessageId: payload.sourceMessageId,
    replyToSenderOpenDingTalkId: payload.actorId,
    atOpenDingTalkIds: payload.atOpenDingTalkIds ?? [],
    replyKind: payload.replyKind ?? 'substantive',
    matterSourceMessageIds: payload.sourceMessageId ? [payload.sourceMessageId] : [],
    ...(notification.dispatchToken ? { sendStartedAt: notification.createdAt } : {}),
    ...(delivered ? { deliveredAt: receipt?.observedAt ?? notification.updatedAt,
      ...(receipt?.messageId ? { deliveredMessageId: receipt.messageId } : {}) }
      : { deliveryPendingReason: notification.retirement ? `task-notification-${notification.retirement.reason}` : knownNotSent ? 'task-notification-pre-send-rejected' : `task-notification-${notification.state}` }),
  }
}

export async function projectTaskNotification({ residentStore, notification }) {
  if (notification?.payload?.audience === 'operator') return undefined
  if (!residentStore || !notification?.payload?.conversationId) return undefined
  return residentStore.projectTaskNotification({ groupId: notification.payload.conversationId,
    outbound: taskNotificationOutbound(notification) })
}
