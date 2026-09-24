import { executionDigest, executionError } from './execution-artifacts.js'

const requireText = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw executionError(code)
  return value
}

/** 同一个受控效果请求的认证 Web/钉钉审批；来源只由 Host 传入。 */
export function createWorkflowApprovalService({ store, controller, authorizeTask }) {
  if (!store || !controller || typeof authorizeTask !== 'function') throw executionError('WORKFLOW_APPROVAL_DEPENDENCY_REQUIRED')

  async function get(requestId) {
    const approval = await store.query({ kind: 'approval.get', requestId: requireText(requestId, 'WORKFLOW_APPROVAL_REQUEST_REQUIRED') })
    const effect = await store.query({ kind: 'effect.get', effectId: approval.effectId })
    const state = await controller.state(effect.runId)
    if (state.run.runId !== effect.runId || state.run.taskId !== effect.definition.payload?.taskId && effect.definition.payload?.taskId !== undefined)
      throw executionError('WORKFLOW_APPROVAL_EFFECT_IDENTITY_INVALID')
    return { approval, effect, run: state.run }
  }

  async function decide({ requestId, decision, eventId }, identity) {
    if (!['approved', 'rejected'].includes(decision)) throw executionError('WORKFLOW_APPROVAL_DECISION_INVALID')
    if (!['web', 'im'].includes(identity?.channel)) throw executionError('WORKFLOW_APPROVAL_CHANNEL_INVALID')
    const actorId = requireText(identity.actorId, 'WORKFLOW_APPROVAL_ACTOR_REQUIRED')
    const item = await get(requestId)
    if (!await authorizeTask({ taskId: item.run.taskId, runId: item.run.runId, actorId,
      conversationId: identity.conversationId, channel: identity.channel })) throw executionError('WORKFLOW_APPROVAL_FORBIDDEN')
    if (!item.approval.approverIds.includes(actorId)) throw executionError('WORKFLOW_APPROVAL_FORBIDDEN')
    const source = identity.channel === 'web' ? 'web' : 'dingtalk'
    const commandId = `approval:${executionDigest([requestId, decision, actorId, source, requireText(eventId, 'WORKFLOW_APPROVAL_EVENT_REQUIRED')])}`
    const receipt = await store.command({ id: commandId, kind: 'approval.decide', args: { requestId, actorId, source, decision } })
    const approval = receipt.result.approval
    if (approval.decision === 'approved' && receipt.result.applied) await controller.recover({ commandId: `approval-recover:${requestId}`, runId: item.run.runId })
    return { requestId, taskId: item.run.taskId, runId: item.run.runId, decision: approval.decision,
      decidedBy: approval.decidedBy, decisionSource: approval.decisionSource, applied: receipt.result.applied }
  }

  return { get, decide }
}
