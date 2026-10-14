// Historical cutover checks; not a current resident entry or a published package asset.
import { readWorkflowSeal, workflowSealPath, inspectLegacyDrain } from './workflow-cutover.js'
import { join, resolve } from 'node:path'

export async function verifyResidentWorkflowSeal(ctx, workflowConfig) {
  const domain = ctx.storageDomain
  const backendName = domain.config?.routes?.dingtalk_dsh_assistant ?? domain.config?.backend
  const backend = ctx.storage?.backend.get(backendName)
  if (!backend?.root) throw new Error('workflow_seal_storage_path_unavailable')
  const sealPath = workflowSealPath(join(resolve(backend.root), 'dingtalk_dsh_assistant.json'))
  const seal = await readWorkflowSeal({ sealPath })
  if (seal) {
    if (!workflowConfig || seal.groupIds.some(id => !workflowConfig.groupIds?.includes(id))) throw new Error('workflow_sealed_group_configuration_required')
    if (resolve(workflowConfig.dbPath) !== resolve(seal.dbPath) || workflowConfig.instanceId !== seal.instanceId) throw new Error('workflow_seal_instance_mismatch')
    if (seal.phase !== 'active') throw new Error('workflow_cutover_requires_offline_resume')
  }
  if (workflowConfig && (!seal || workflowConfig.groupIds.some(id => !seal.groupIds.includes(id)))) throw new Error('workflow_group_seal_required')
  return { seal, sealPath }
}

export async function verifyWorkflowActivation(store, control, groupIds) {
  for (const groupId of groupIds) {
    const state = await control.query({ kind: 'message.group', conversationId: groupId })
    if (state?.state !== 'active' || state.engine !== 'workflow' || !state.legacySealRef) throw new Error(`workflow_group_not_activated:${groupId}`)
    const group = store.getGroup(groupId)
    if (!group) throw new Error(`workflow_group_not_subscribed:${groupId}`)
    const report = inspectLegacyDrain({ unit: { name: 'dingtalk_dsh_assistant', version: 9 }, tables: {
      groups: { [groupId]: { ...group, groupId } },
      tasks: Object.fromEntries(store.listTasks().map((task, index) => [task.taskId ?? index, task])),
    } }, [groupId])
    if (!report.ready) throw Object.assign(new Error(`workflow_legacy_not_drained:${groupId}`), { details: report.issues })
  }
}
