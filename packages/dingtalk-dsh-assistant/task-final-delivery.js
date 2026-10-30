import { basename, isAbsolute, relative, resolve } from 'node:path'
import { notificationOpenTaskId } from './group-message.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }

/** Freeze only files reported by this task's completed executions, before recording completion. */
export async function freezeTaskDeliveryFiles({ selected = [], task, executions, directory, files }) {
  if (!Array.isArray(selected) || selected.length > 20) fail('TASK_DELIVERY_FILES_INVALID')
  const frozen = [], seen = new Set()
  for (const item of selected) {
    const execution = executions.find(value => value.executionId === item.executionId && value.taskId === task.taskId)
    const output = execution?.result?.payload?.output
    if (!execution || execution.status !== 'succeeded' || !execution.drained || output?.status !== 'completed'
      || !Array.isArray(output.artifacts) || !output.artifacts.includes(item.path)) fail('TASK_DELIVERY_ARTIFACT_NOT_REPORTED')
    const path = resolve(directory, item.path), relativePath = relative(directory, path)
    if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) fail('TASK_DELIVERY_ARTIFACT_OUTSIDE_TASK')
    const input = { taskId: task.taskId, requirementRevision: task.requirementRevision,
      producer: { runId: task.taskId, nodeRunId: execution.executionId, outputRef: `${execution.executionId}:${execution.result.inputVersion}` },
      role: 'final-delivery', fileName: basename(path), sourceRoot: directory, relativePath }
    const prepared = await files.prepareImport(input)
    const artifact = await files.importFile({ ...input, expectedSha256: prepared.sha256 })
    if (seen.has(artifact.artifactId)) continue
    seen.add(artifact.artifactId)
    frozen.push({ artifact, caption: item.caption })
  }
  if (frozen.length) await files.validateManifest(frozen.map(item => item.artifact), task)
  return frozen
}

/** The existing notification queue owns each part; transport never retries a send on its own. */
export function withTaskFileNotifications(notifications, files) {
  if (!notifications) return notifications
  return { ...notifications,
    send: async notification => {
      if (!notification.payload.artifact) return notifications.send(notification)
      if (!notifications.sendFile) fail('TASK_DELIVERY_FILE_TRANSPORT_UNAVAILABLE')
      return notifications.sendFile(notification, await files.resolve(notification.payload.artifact))
    },
    readback: notification => notification.payload.artifact
      ? notifications.readbackFile?.(notification) : notifications.readback?.(notification),
  }
}

export async function readTaskFileDelivery(adapter, notification) {
  const openTaskId = notificationOpenTaskId(notification.ack ?? notification.receipt)
  if (!openTaskId) return undefined
  const status = await adapter.querySendStatus(openTaskId)
  const conversationId = status.messageRef?.openConversationId ?? status.result?.openConversationId
  const messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
  if (status.result?.sendStatus !== 'SUCCESS' || !messageId || conversationId !== notification.payload.conversationId) return undefined
  const artifact = notification.payload.artifact
  const verified = await adapter.readMessageFile({ groupId: conversationId, messageId, expected: { size: artifact.size, sha256: artifact.sha256 } })
  if (verified.size !== artifact.size || verified.sha256 !== artifact.sha256
    || verified.message?.conversationId !== conversationId || verified.message?.messageId !== messageId) return undefined
  return { messageId, conversationId, openTaskId, artifactId: artifact.artifactId,
    sha256: verified.sha256, size: verified.size, resourceRef: verified.resourceRef, observedAt: new Date().toISOString() }
}
