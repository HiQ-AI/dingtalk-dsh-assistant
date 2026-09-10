import { stableId } from './topic-model.js'

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
export const stagePlanFor = (task, titles) => {
  if (titles.some(title => typeof title !== 'string' || !title.trim()) || new Set(titles).size !== titles.length) throw new Error('task_revision_stage_titles_invalid')
  const plan = titles.map(title => task.stagePlan?.find(stage => stage.title === title)
    ?? { stageId: stableId('stage', `${task.taskId}:${task.runSequence}:${title}`), title })
  if (new Set(plan.map(stage => stage.stageId)).size !== plan.length) throw new Error('task_revision_stage_identity_conflict')
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

export function reviseTaskProgress(task, { objective = task.objective, acceptanceCriteria = task.acceptanceCriteria, stageTasks = task.stageTasks, progressImpact, impactEvidence }, basisIds) {
  const stages = stagePlanFor(task, task.stageTasks ?? [])
  const scopeChanged = objective !== task.objective || !same(acceptanceCriteria, task.acceptanceCriteria) || !same(stageTasks, task.stageTasks)
  if (impactEvidence) {
    if (!impactEvidence.basisMessageIds?.length || impactEvidence.basisMessageIds.some(id => !basisIds.has(id))) throw new Error('task_revision_basis_invalid')
    if (typeof impactEvidence.reason !== 'string' || !impactEvidence.reason.trim()) throw new Error('task_revision_reason_required')
    if (!impactEvidence.affectedStageIds?.length || impactEvidence.affectedStageIds.some(id => !stages.some(stage => stage.stageId === id))) throw new Error('task_revision_stage_invalid')
  }
  if (progressImpact === 'replan' && !scopeChanged && !impactEvidence?.affectedStageIds.length) throw new Error('task_revision_impact_required')
  const replan = scopeChanged || progressImpact === 'replan' || Boolean(impactEvidence)
  let firstAffected = stages.length
  if (replan) {
    // 明确的证据可限定目标/验收变化的影响；结构化阶段差异始终独立检查，不能被声明掩盖。
    firstAffected = !impactEvidence && (objective !== task.objective || !same(acceptanceCriteria, task.acceptanceCriteria)) ? 0 : stages.length
    const changedStage = stages.findIndex((stage, i) => stageTasks[i] !== stage.title)
    if (changedStage >= 0) firstAffected = Math.min(firstAffected, changedStage)
    if (firstAffected < 0) firstAffected = stages.length
    for (const id of impactEvidence?.affectedStageIds ?? []) firstAffected = Math.min(firstAffected, stages.findIndex(stage => stage.stageId === id))
  }
  const retainedTitles = new Set(stages.slice(0, firstAffected).map(stage => stage.title))
  const retainedIds = new Set(stages.slice(0, firstAffected).map(stage => stage.stageId))
  const checkpoints = (task.checkpoints ?? []).filter(checkpoint => ['acknowledge', 'guidance'].includes(checkpoint.coordinatorDecision)
    && checkpoint.runSequence === task.runSequence && (!replan || checkpoint.kind === 'stage-completed'
      && checkpoint.completedItems?.length > 0 && (!checkpoint.stageId || retainedIds.has(checkpoint.stageId))
      && (!checkpoint.stageTask || !stages.some(stage => stage.title === checkpoint.stageTask) || retainedTitles.has(checkpoint.stageTask))
      && (checkpoint.completedItems ?? []).every(title => retainedTitles.has(title))))
  return {
    scopeChanged, progressImpact: replan ? 'replan' : 'preserve', checkpoints,
    invalidatedCheckpoints: (task.checkpoints ?? []).filter(checkpoint => !checkpoints.includes(checkpoint)),
    reason: impactEvidence?.reason ?? (scopeChanged ? '目标、验收或阶段有明确变化。' : '补充输入，未改变目标、验收或已确认事实。'),
    affectedStageIds: replan ? stages.slice(firstAffected).map(stage => stage.stageId) : [],
    stagePlan: stagePlanFor(task, stageTasks ?? []),
  }
}
