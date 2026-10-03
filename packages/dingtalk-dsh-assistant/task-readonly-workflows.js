import { executionError } from './execution-artifacts.js'

// 仅保留历史产物校验与部署切换门禁；此模块不再提供任何可执行 Workflow。
export const retiredWorkflowIds = Object.freeze(['task-investigation','task-analysis','task-general','task-general-intake','task-planning','task-pr-review','task-data-query','task-retrospective'])
export function assertRetiredWorkflowsDrained({ records, activeDefinitions, pendingStages = [], currentDefinitions = [] }) {
  const retired = record => retiredWorkflowIds.includes(record.workflowId)
    || ['task-investigation','task-general-capability'].includes(record.workflowId)
      && !currentDefinitions.some(current => current.id === record.workflowId && current.version === record.definitionVersion)
  const blocked = []
  for (const key of activeDefinitions) {
    const separator = key.indexOf(':'), workflowId = key.slice(0,separator), workflowDigest = key.slice(separator+1)
    const record = records.find(item => item.workflowId === workflowId && item.digest === workflowDigest)
    if (retiredWorkflowIds.includes(workflowId) || ['task-investigation','task-general-capability'].includes(workflowId) && (!record || retired(record)))
      blocked.push({ workflowId, workflowDigest })
  }
  for (const stage of pendingStages) if ((retiredWorkflowIds.includes(stage.workflowId)
    || !stage.workflowDigest && ['task-investigation','task-general-capability'].includes(stage.workflowId))
    && !blocked.some(item => item.workflowId === stage.workflowId && item.workflowDigest === stage.workflowDigest))
    blocked.push({ workflowId: stage.workflowId, workflowDigest: stage.workflowDigest ?? null })
  if (blocked.length) throw Object.assign(executionError('WORKFLOW_CUTOVER_ACTIVE_REFERENCES'), { details: blocked })
}

export const readOnlyWorkflowOwnerContract = Object.freeze({
  id: 'material-result', version: '1',
  async validateCompletion({ state, output, artifacts }) {
    const requirement = await artifacts.read(state.run.requirementRef)
    const known = new Set((requirement.materials ?? []).map(item => item.id))
    return typeof output?.summary === 'string' && !!output.summary.trim()
      && Array.isArray(output.evidenceIds) && output.evidenceIds.length > 0
      && output.evidenceIds.every(ref => known.has(ref))
      && output.outcome !== 'blocked' && output.status !== 'unverified'
  },
})
