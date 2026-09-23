import { executionDigest } from './execution-artifacts.js'

export function workflowResultText(output) {
  if (typeof output?.summary === 'string') return output.summary
  if (output?.deliveryStatus === 'pr_verified' && typeof output.url === 'string') return `代码已验证并提交 PR${output.number ? ` #${output.number}` : ''}：${output.url}。当前状态：${output.state ?? '已回读'}。`
  return null
}

/** 通知独立于任务执行。ACK不代表送达，未知发送只回查，不再次发送。 */
export function createWorkflowNotifications({ store, artifacts, controller, adapter }) {
  let flight, beforeSequenceId, preparedCursor = 0, readbackCursor = 0
  const command = (kind, args, id) => store.command({ id, kind, args })
  async function prepare(run, action, phase, text) {
    const notificationId = `notice-${executionDigest([action.commandId, phase])}`
    await command('message.notification.prepare', { runId: run.runId, commandId: action.commandId, notificationId,
      payload: { text, phase, conversationId: run.conversationId, sourceMessageId: run.context.sourceMessageId, actorId: run.actorId },
      disclosure: { conversationId: run.conversationId, authorizationRef: run.sourceKey },
    }, `prepare:${notificationId}`)
  }
  async function drain() {
    const page = await store.query({ kind: 'message.list', limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
    beforeSequenceId = page.length === 200 ? page.at(-1).sequenceId : undefined
    for (const run of page) {
      const state = await store.query({ kind: 'message.run', runId: run.runId })
      for (const request of state.requests.filter(item => item.status === 'pending' && item.kind === 'needs_clarification')) {
        const notificationId = `clarify-${executionDigest([run.runId, request.id, request.revision])}`
        await command('message.notification.prepare', { runId: run.runId, requestId: request.id, notificationId,
          payload: { text: request.question ?? request.reason, phase: 'clarification', conversationId: run.conversationId, sourceMessageId: run.context?.sourceMessageId, actorId: run.actorId },
          disclosure: { conversationId: run.conversationId, authorizationRef: run.sourceKey },
        }, `prepare:${notificationId}`)
      }
      for (const action of state.commands.filter(item => ['applied', 'rejected'].includes(item.status) && (item.status === 'rejected' || item.args.replyPolicy !== 'none'))) {
        if (action.result?.reply) await prepare(run, action, 'receipt', action.result.reply)
        if (!['create', 'research', 'answer', 'reopen'].includes(action.kind) || !action.result?.runId) continue
        const task = await controller.state(action.result.runId)
        if (!['succeeded', 'failed', 'cancelled'].includes(task.run.status)) continue
        const last = task.nodes.filter(node => node.outputRef).at(-1)
        const output = last ? await artifacts.read(last.outputRef) : null
        const text = task.run.status === 'succeeded' ? workflowResultText(output) ?? '任务流程已完成，结果可在任务详情查看。'
          : `任务${task.run.status === 'cancelled' ? '已取消' : '执行失败'}${task.run.recoveryReason ? `：${task.run.recoveryReason}` : ''}`
        await prepare(run, action, `terminal:${task.run.runId}:${task.run.revision}`, text)
      }
    }
    if (!adapter) return
    const prepared = await store.query({ kind: 'message.notifications', states: ['prepared'], afterSequenceId: preparedCursor, limit: 100 })
    const readbacks = await store.query({ kind: 'message.notifications', states: ['acknowledged', 'unknown'], afterSequenceId: readbackCursor, limit: 100 })
    preparedCursor = prepared.length === 100 ? prepared.at(-1).sequenceId : 0
    readbackCursor = readbacks.length === 100 ? readbacks.at(-1).sequenceId : 0
    for (const notification of [...prepared, ...readbacks]) {
      // 同群来源也不替代当前披露校验；群已撤销或配置变化时不外发内容。
      if (!await adapter.canDisclose(notification)) continue
      let current = notification
      if (current.status === 'prepared') {
        const claimed = await command('message.notification.claim', { notificationId: current.id }, `claim:${current.id}`)
        if (!claimed.dispatchEligible) continue
        current = claimed.result.notification
        try {
          const ack = await adapter.send(current)
          await command('message.notification.sent', { notificationId: current.id, leaseEpoch: current.leaseEpoch, ack }, `sent:${current.id}:${current.leaseEpoch}`)
          current = { ...current, status: 'acknowledged', ack }
        } catch (error) {
          await command('message.notification.fail', { notificationId: current.id, leaseEpoch: current.leaseEpoch, error: error.code ?? error.message }, `unknown:${current.id}:${current.leaseEpoch}`)
          current = { ...current, status: 'unknown' }
        }
      }
      if (['acknowledged', 'unknown'].includes(current.status)) {
        const evidence = await adapter.readback(current)
        if (evidence) await command('message.notification.readback', { notificationId: current.id, leaseEpoch: current.leaseEpoch, evidence }, `delivered:${current.id}:${current.leaseEpoch}`)
      }
    }
  }
  return { flush() { return flight ??= drain().finally(() => { flight = undefined }) } }
}
