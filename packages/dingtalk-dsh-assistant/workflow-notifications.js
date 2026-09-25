import { executionDigest } from './execution-artifacts.js'

export function workflowResultText(output) {
  if (typeof output?.summary === 'string') return output.summary
  if (output?.deliveryStatus === 'pr_verified' && typeof output.url === 'string') return `代码已验证并提交 PR${output.number ? ` #${output.number}` : ''}：${output.url}。当前状态：${output.state ?? '已回读'}。`
  return null
}
export function sameDeliveredText(observed, expected, quoted = false) {
  const normalize = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : null
  const actual = normalize(observed), wanted = normalize(expected)
  if (actual === null || wanted === null) return false
  if (actual === wanted) return true
  return quoted && wanted.length >= 24 && actual.replace(/\s+/gu, '').includes(wanted.replace(/\s+/gu, ''))
}
export function notificationOpenTaskId(ack) {
  return ack?.sendReceipt?.openTaskId ?? ack?.result?.openTaskId ?? ack?.result?.result?.openTaskId
}
export function formatGroupReply(text, responsibility = '') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('WORKFLOW_REPLY_TEXT_REQUIRED')
  const body = text.trim()
  if (!responsibility.includes('小小鹏代回') || /(?:^|\n)\s*- 小小鹏代回\s*$/u.test(body)) return body
  return `${body}\n\n- 小小鹏代回`
}
export function sendWorkflowNotification(adapter, notification) {
  const payload = notification.payload
  const base = { groupId: payload.conversationId, text: payload.text, idempotencyKey: notification.id }
  return payload.sourceMessageId && payload.actorId
    ? adapter.sendGroupReply({ ...base, replyToMessageId: payload.sourceMessageId, replyToSenderOpenDingTalkId: payload.actorId })
    : adapter.sendGroup(base)
}

/** 只执行预检过的单条操作。领取后异常进入待核对，调用方不能重试外部动作。 */
export async function executeNotificationOperation({ store, adapter, operationId, expectedFactDigest, authorizationRef }) {
  const operation=await store.query({kind:'message.notificationOperation',operationId})
  if(!operation)throw new Error('MESSAGE_NOTIFICATION_OPERATION_NOT_FOUND')
  if(operation.status==='completed')return operation
  if(operation.status!=='prepared')throw new Error('MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED')
  const notification=await store.query({kind:'message.notification',notificationId:operation.snapshot.notificationId})
  if(!adapter?.canDisclose||!await adapter.canDisclose(notification))throw new Error('MESSAGE_NOTIFICATION_DISCLOSURE_FORBIDDEN')
  const type=operation.snapshot.type
  if(type==='recall'&&(!adapter.recall||!adapter.readbackRecall))throw new Error('MESSAGE_NOTIFICATION_RECALL_ADAPTER_REQUIRED')
  if(type==='restore'&&(!adapter.send||!adapter.readback))throw new Error('MESSAGE_NOTIFICATION_SEND_ADAPTER_REQUIRED')
  const command=(kind,args,suffix)=>store.command({id:`notification-operation:${operationId}:${suffix}`,kind,args})
  const claimed=await command('message.notification.operation.claim',{operationId,expectedFactDigest,authorizationRef},'claim')
  if(!claimed.dispatchEligible)throw new Error('MESSAGE_NOTIFICATION_OPERATION_STALE')
  const snapshot=claimed.result.operation.snapshot
  let ack
  try {
    ack=type==='recall'
      ? await adapter.recall({conversationId:snapshot.conversationId,messageId:snapshot.messageId,operationId})
      : await adapter.send({id:operationId,payload:{conversationId:snapshot.conversationId,sourceMessageId:snapshot.sourceMessageId,actorId:notification.payload.actorId,text:snapshot.body}})
    await command('message.notification.operation.result',{operationId,ack},'result')
  }catch(error){
    await command('message.notification.operation.result',{operationId,error:error.code??error.message},'unknown')
    throw error
  }
  const evidence=type==='recall'
    ? await adapter.readbackRecall({conversationId:snapshot.conversationId,messageId:snapshot.messageId,operationId,ack})
    : await adapter.readback({id:operationId,payload:{conversationId:snapshot.conversationId,sourceMessageId:snapshot.sourceMessageId,text:snapshot.body},ack})
  if(!evidence)return (await store.query({kind:'message.notificationOperation',operationId}))
  return (await command('message.notification.operation.reconcile',{operationId,messageId:evidence.messageId,evidenceRef:evidence.evidenceRef, ...(type==='recall'?{recallStatus:evidence.recallStatus}:{})},'reconcile')).result.operation
}

/** 通知独立于任务执行。ACK不代表送达，未知发送只回查，不再次发送。 */
export function createWorkflowNotifications({ store, artifacts, controller, adapter, groupResponsibility = () => '' }) {
  let flight, beforeSequenceId, preparedCursor = 0, readbackCursor = 0
  const command = (kind, args, id) => store.command({ id, kind, args })
  async function prepare(run, action, phase, text) {
    const eventKey=phase.startsWith('terminal:') ? `task.result:${action.result.runId}:${phase}`
      : ['create','reopen'].includes(action.kind) && action.result?.runId ? `task.accepted:${action.result.runId}`
      : action.status==='rejected' ? `action.rejected:${action.commandId}` : `action.reply:${action.commandId}:${phase}`
    const notificationId = `notice-${executionDigest([action.commandId, phase])}`
    const existing = await store.query({ kind: 'message.notification', notificationId })
    if (existing) {
      if (existing.runId !== run.runId || existing.commandId !== action.commandId) throw new Error('MESSAGE_NOTIFICATION_CONFLICT')
      return
    }
    const responsibility = groupResponsibility(run.conversationId)
    if (responsibility.includes('引用回复') && (!run.context?.sourceMessageId || !run.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
    await command('message.notification.prepare', { runId: run.runId, commandId: action.commandId, notificationId, eventKey,
      payload: { text: formatGroupReply(text, responsibility), phase, conversationId: run.conversationId, sourceMessageId: run.context.sourceMessageId, actorId: run.actorId },
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
        const existing = await store.query({ kind: 'message.notification', notificationId })
        if (existing) {
          if (existing.runId !== run.runId || existing.requestId !== request.id) throw new Error('MESSAGE_NOTIFICATION_CONFLICT')
          continue
        }
        const responsibility = groupResponsibility(run.conversationId)
        if (responsibility.includes('引用回复') && (!run.context?.sourceMessageId || !run.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
        await command('message.notification.prepare', { runId: run.runId, requestId: request.id, notificationId, eventKey:`request.clarification:${request.id}:${request.revision}`,
          payload: { text: formatGroupReply(request.question ?? request.reason, responsibility), phase: 'clarification', conversationId: run.conversationId, sourceMessageId: run.context?.sourceMessageId, actorId: run.actorId },
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
