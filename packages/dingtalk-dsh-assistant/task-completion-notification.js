import { executionDigest } from './execution-artifacts.js'
import { assertGroupReply } from './workflow-notifications.js'

// Explicit local host action; never enumerates or drains the notification queue.
async function sendOne({ store, artifacts, adapter, task, taskId, notificationId, conversationId, authorization }) {
  const fail = code => { throw new Error(code) }
  let notice = await store.query({ kind: 'message.notification', notificationId })
  if (!notice || notice.payload?.fact?.taskId !== taskId || notice.payload.conversationId !== conversationId
    || notice.disclosure?.conversationId !== conversationId || task?.taskId !== taskId || task.state !== 'completed') fail('TASK_COMPLETION_NOTIFICATION_SCOPE_FORBIDDEN')
  const reports = await store.query({ kind: 'task.owner.reports', taskId })
  const report = reports.filter(item => item.reportType === 'complete').at(-1)
  if (!report || report.applicationStatus !== 'applied' || task.deliveryManifest?.turnId !== report.turnId
    || notice.payload.phase !== `owner:${report.reportId}`) fail('TASK_COMPLETION_NOTIFICATION_STALE')
  if (!authorization?.confirmationRef || authorization.confirmed !== true) fail('TASK_COMPLETION_NOTIFICATION_AUTHORIZATION_REQUIRED')
  assertGroupReply(notice.payload.text, [taskId])
  if (notice.status === 'superseded' && notice.leaseEpoch === 0 && !notice.ack && !notice.evidence) {
    // A fresh explicitly authorized attempt preserves the retired original receipt.
    const original = notice
    notificationId = `notice-${executionDigest(['explicit-completion', original.id])}`
    const prepared = await store.command({ id: `prepare:${notificationId}`, kind: 'message.notification.prepare', args: {
      runId: original.runId, commandId: original.commandId, notificationId,
      eventKey: `${original.eventKey}:explicit-completion`, payload: original.payload, disclosure: original.disclosure } })
    notice = prepared.result.notification
  }
  const command = (kind, args, suffix) => store.command({ id: `${suffix}:${notificationId}:${notice.leaseEpoch}`, kind, args })
  if (notice.status === 'delivered') return notice
  if (notice.status === 'prepared') {
    const receipt = await artifacts.put({ kind: 'task-completion-notification-authorization', taskId, notificationId, conversationId,
      text: notice.payload.text, authorization, observedAt: new Date().toISOString() })
    const claimed = await store.command({ id: `explicit-completion-claim:${notificationId}`, kind: 'message.notification.claim', args: { notificationId, completionAuthorizationRef: receipt.ref } })
    notice = claimed.result.notification
    if (!claimed.dispatchEligible) return notice
    let ack
    try { ack = await adapter.sendScoped(notice, { taskId, notificationId, conversationId, authorizationRef: receipt.ref }) }
    catch (error) {
      await command('message.notification.fail', { notificationId, leaseEpoch: notice.leaseEpoch, error: error.code ?? error.message }, 'unknown')
      return { ...notice, status: 'unknown', error: error.code ?? error.message }
    }
    await command('message.notification.sent', { notificationId, leaseEpoch: notice.leaseEpoch, ack }, 'sent')
    notice = { ...notice, status: 'acknowledged', ack }
  }
  // Sending or unknown acceptance is never retried. Only independently observed delivery settles it.
  if (['acknowledged', 'unknown'].includes(notice.status)) {
    const observation = await adapter.readback(notice)
    if (observation?.messageId && observation.conversationId === conversationId) {
      const evidence = await artifacts.put(observation)
      return (await command('message.notification.readback', { notificationId, leaseEpoch: notice.leaseEpoch,
        evidence: { ...observation, evidenceRef: evidence.ref } }, 'delivered')).result.notification
    }
  }
  return notice
}

const flights = new WeakMap()
export function sendTaskCompletionNotification(args) {
  if (args.authorization?.confirmed !== true || !args.authorization.confirmationRef) return Promise.reject(new Error('TASK_COMPLETION_NOTIFICATION_AUTHORIZATION_REQUIRED'))
  let pending = flights.get(args.store)
  if (!pending) { pending = new Map(); flights.set(args.store, pending) }
  const key = JSON.stringify([args.taskId, args.notificationId, args.conversationId])
  if (!pending.has(key)) pending.set(key, sendOne(args).finally(() => pending.delete(key)))
  return pending.get(key)
}
