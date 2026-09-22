import { stableId } from './topic-model.js'
import { acceptedTaskStageOutputs } from './task-progress.js'

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
export class TaskRevisionError extends Error {}
export function normalizeRunPlan(objective, acceptanceCriteria, stageTasks) {
  const clean = values => Array.isArray(values) ? values.map(item => String(item).trim()).filter(Boolean) : []
  const criteria = clean(acceptanceCriteria), stages = clean(stageTasks)
  return { acceptanceCriteria: criteria.length ? criteria : [objective], stageTasks: stages.length ? stages : ['完成并验证当前轮目标'] }
}
export const stagePlanFor = (task, titles) => {
  if (titles.some(title => typeof title !== 'string' || !title.trim()) || new Set(titles).size !== titles.length) throw new TaskRevisionError('task_revision_stage_titles_invalid')
  const plan = titles.map(title => task.stagePlan?.find(stage => stage.title === title)
    ?? { stageId: stableId('stage', `${task.taskId}:${task.runSequence}:${title}`), title })
  if (new Set(plan.map(stage => stage.stageId)).size !== plan.length) throw new TaskRevisionError('task_revision_stage_identity_conflict')
  return plan
}

// 旧版本把主任务阶段与已批准的细计划分开保存；只规范化执行索引，不改历史报告。
export function reconcileLegacyStagePlan(task) {
  if (task.stagePlan?.length) return undefined
  const checkpoints = task.checkpoints ?? []
  const index = checkpoints.findLastIndex(item => item.kind === 'plan-confirmed' && ['acknowledge', 'guidance'].includes(item.coordinatorDecision))
  if (index < 0) return undefined
  const plan = checkpoints[index]
  const completedBefore = checkpoints.slice(0, index).filter(item => item.kind === 'stage-completed' && ['acknowledge', 'guidance'].includes(item.coordinatorDecision)).flatMap(item => item.completedItems ?? [])
  const titles = [...new Set([...completedBefore, ...plan.remainingItems])]
  if (!titles.length) return undefined
  return { stageTasks: titles, stagePlan: stagePlanFor(task, titles), planCheckpointId: plan.checkpointId }
}

export function reviseTaskProgress(task, { objective = task.objective, acceptanceCriteria = task.acceptanceCriteria, stageTasks = task.stageTasks, progressImpact, impactEvidence, authorizationChange }, basisIds) {
  const stages = stagePlanFor(task, task.stageTasks ?? [])
  const affectedStageIds = impactEvidence?.affectedStageIds
  const scopeChanged = objective !== task.objective || !same(acceptanceCriteria, task.acceptanceCriteria) || !same(stageTasks, task.stageTasks)
  if (authorizationChange !== undefined && !['none', 'changed'].includes(authorizationChange)) throw new TaskRevisionError('task_revision_authorization_change_invalid')
  if (impactEvidence) {
    if (!impactEvidence.basisMessageIds?.length || impactEvidence.basisMessageIds.some(id => !basisIds.has(id))) throw new TaskRevisionError('task_revision_basis_invalid')
    if (typeof impactEvidence.reason !== 'string' || !impactEvidence.reason.trim()) throw new TaskRevisionError('task_revision_reason_required')
    if (!affectedStageIds?.length || affectedStageIds.some(id => !stages.some(stage => stage.stageId === id))) throw new TaskRevisionError('task_revision_stage_invalid')
  }
  if (progressImpact === 'replan' && !scopeChanged && !affectedStageIds?.length) throw new TaskRevisionError('task_revision_impact_required')
  const replan = scopeChanged || progressImpact === 'replan' || Boolean(impactEvidence) || authorizationChange === 'changed'
  const nextStages = stagePlanFor(task, stageTasks ?? [])
  const affected = new Set(affectedStageIds ?? [])
  if (replan) {
    if (authorizationChange === 'changed') for (const stage of stages) affected.add(stage.stageId)
    if (!impactEvidence && (objective !== task.objective || !same(acceptanceCriteria, task.acceptanceCriteria))) for (const stage of stages) affected.add(stage.stageId)
    const nextIds = new Set(nextStages.map(stage => stage.stageId))
    for (const stage of stages) if (!nextIds.has(stage.stageId)) affected.add(stage.stageId)
    // 结构化阶段按前序依赖排序；上游事实失效时依赖其产物的下游一并失效。
    for (const stage of task.plan?.stages ?? []) if (stage.dependsOn.some(id => affected.has(id))) affected.add(stage.stageId)
  }
  const retainedIds = new Set(stages.filter(stage => !affected.has(stage.stageId)).map(stage => stage.stageId))
  const retainedTitles = new Set(stages.filter(stage => retainedIds.has(stage.stageId)).map(stage => stage.title))
  const validOutputs = task.plan ? new Set(acceptedTaskStageOutputs(task).map(item => item.checkpointId)) : undefined
  const checkpoints = (task.checkpoints ?? []).filter(checkpoint => ['acknowledge', 'guidance'].includes(checkpoint.coordinatorDecision)
    && (!validOutputs || checkpoint.kind !== 'stage-completed' || validOutputs.has(checkpoint.checkpointId))
    && checkpoint.runSequence === task.runSequence && (!replan || checkpoint.kind === 'stage-completed'
      && checkpoint.completedItems?.length > 0 && (!checkpoint.stageId || retainedIds.has(checkpoint.stageId))
      && (!checkpoint.stageTask || !stages.some(stage => stage.title === checkpoint.stageTask) || retainedTitles.has(checkpoint.stageTask))
      && (checkpoint.completedItems ?? []).every(title => retainedTitles.has(title))))
  return {
    scopeChanged, progressImpact: replan ? 'replan' : 'preserve', checkpoints,
    invalidatedCheckpoints: (task.checkpoints ?? []).filter(checkpoint => !checkpoints.includes(checkpoint)),
    reason: impactEvidence?.reason ?? (authorizationChange === 'changed' ? '授权发生变化，原阶段批准和证据须重新核对。' : scopeChanged ? '目标、验收或阶段有明确变化。' : '补充输入，未改变目标、验收或已确认事实。'),
    authorizationChange: authorizationChange ?? 'none',
    affectedStageIds: replan ? stages.filter(stage => affected.has(stage.stageId)).map(stage => stage.stageId) : [],
    stagePlan: nextStages,
  }
}
