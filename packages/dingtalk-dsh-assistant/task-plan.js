import { z } from 'zod'
import { stableId } from './topic-model.js'
import { toToolJsonSchema } from './tool-schema.js'

const text = z.string().trim().min(1)
const version = z.number().int().positive()
const ids = z.array(text)
export const planSourceRefSchema = z.object({ messageId: text, messageVersion: version }).strict()
const workflowRef = z.object({ id: text, revision: version }).strict()
export const taskPlanSchema = z.object({
  revision: version, inputVersion: version, runSequence: version,
  sourceRefs: z.array(planSourceRefSchema).min(1), workflowRefs: z.array(workflowRef),
  criteria: z.array(z.object({ criterionId: text, description: text, sourceRefs: z.array(planSourceRefSchema).min(1), verificationPolicy: z.enum(['semantic', 'independent-check']) }).strict()).min(1),
  stages: z.array(z.object({ stageId: text, title: text, criterionIds: ids.min(1), dependsOn: ids, expectedOutputs: ids.min(1) }).strict()).min(1),
}).strict()
export const taskArtifactSchema = z.object({ artifactId: text, uri: text, version: text, digest: text.optional() }).strict()
export const modelEvidenceSchema = z.object({ evidenceId: text, producerKind: z.literal('model'), criterionIds: ids.min(1), artifactRefs: ids.min(1), sourceRef: text, observedAt: z.string().datetime(), outcome: z.enum(['pass', 'fail', 'unknown', 'not-applicable']), reason: text }).strict()
export const hostCheckEvidenceSchema = modelEvidenceSchema.extend({ producerKind: z.literal('checker'), checkerId: text, checkerVersion: text, receiptId: text })
export const stageOutputSchema = z.object({ stageId: text, planRevision: version, inputVersion: version, runSequence: version, artifactRefs: ids, evidenceRefs: ids.min(1), blockers: ids }).strict()
export const criterionReviewSchema = z.object({ criterionId: text, evidenceRefs: ids.min(1), verdict: z.enum(['pass', 'fail', 'unknown']), reason: text }).strict()
export const taskPlanDraftSchema = z.object({
  criteria: z.array(taskPlanSchema.shape.criteria.element.omit({ criterionId: true }).extend({ key: text, criterionId: text.optional() })).min(1),
  stages: z.array(taskPlanSchema.shape.stages.element.omit({ stageId: true, criterionIds: true, dependsOn: true }).extend({ key: text, stageId: text.optional(), criterionKeys: ids.min(1), dependsOnKeys: ids })).min(1),
}).strict()

export class TaskPlanValidationError extends Error {}
const fail = code => { throw new TaskPlanValidationError(`task_plan_${code}`) }
const unique = (values, code) => { if (new Set(values).size !== values.length) fail(code) }
const sourceKey = ref => `${ref.messageId}:${ref.messageVersion}`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// IDs 由 Host 的创建身份及序号决定，标题只作为可修改的展示字段。
export const planItemId = (kind, creationId, ordinal) => {
  if (!['criterion', 'stage'].includes(kind) || !creationId || !Number.isInteger(ordinal) || ordinal < 0) fail('identity_invalid')
  return stableId(kind, `${creationId}:${ordinal}`)
}

export const taskPlanDraftJsonSchema = toToolJsonSchema(taskPlanDraftSchema)

// 草稿通过本地 key 明确关联；Host 注入身份/版本，旧 ID 只能引用当前计划中的条目。
export function prepareTaskPlan(value, { creationId, revision, inputVersion, runSequence, sourceRefs, workflowRefs, previousPlan, retiredIds = [] }) {
  const draft = taskPlanDraftSchema.parse(value)
  for (const [items, previous, key] of [[draft.criteria, previousPlan?.criteria, 'criterionId'], [draft.stages, previousPlan?.stages, 'stageId']]) {
    if (items.some(item => item[key] && !previous?.some(old => old[key] === item[key]))) fail('unallocated_identity')
  }
  unique(draft.criteria.map(item => item.key), 'draft_key_duplicate')
  unique(draft.stages.map(item => item.key), 'draft_key_duplicate')
  const criteria = draft.criteria.map(({ key, ...item }, index) => ({ ...item, criterionId: item.criterionId ?? planItemId('criterion', creationId, index) }))
  const stageIds = draft.stages.map((item, index) => item.stageId ?? planItemId('stage', creationId, index))
  const stages = draft.stages.map(({ key, criterionKeys, dependsOnKeys, ...item }, index) => {
    const criterionIndexes = criterionKeys.map(key => draft.criteria.findIndex(item => item.key === key))
    const dependsOnIndexes = dependsOnKeys.map(key => draft.stages.findIndex(item => item.key === key))
    if (criterionIndexes.some(i => i < 0) || dependsOnIndexes.some(i => i < 0 || i >= index)) fail('draft_reference_invalid')
    return { ...item, stageId: stageIds[index], criterionIds: criterionIndexes.map(i => criteria[i].criterionId), dependsOn: dependsOnIndexes.map(i => stageIds[i]) }
  })
  return validateTaskPlan({ revision, inputVersion, runSequence, sourceRefs, workflowRefs, criteria, stages }, { sourceRefs, workflowRefs, previousPlan, retiredIds })
}

export function validateTaskPlan(value, { sourceRefs, workflowRefs, previousPlan, retiredIds = [] } = {}) {
  const plan = taskPlanSchema.parse(value)
  const allowed = new Set((sourceRefs ?? plan.sourceRefs).map(sourceKey))
  const declared = new Set(plan.sourceRefs.map(sourceKey))
  unique(plan.sourceRefs.map(sourceKey), 'source_duplicate')
  if (plan.sourceRefs.some(ref => !allowed.has(sourceKey(ref)))) fail('source_invalid')
  if (workflowRefs && !same(plan.workflowRefs, workflowRefs)) fail('workflow_stale')
  unique(plan.workflowRefs.map(ref => ref.id), 'workflow_duplicate')
  unique(plan.criteria.map(item => item.criterionId), 'criterion_duplicate')
  unique(plan.stages.map(item => item.stageId), 'stage_duplicate')
  const criteria = new Set(plan.criteria.map(item => item.criterionId)), seen = new Set(), covered = new Set()
  for (const criterion of plan.criteria) {
    unique(criterion.sourceRefs.map(sourceKey), 'source_duplicate')
    if (criterion.sourceRefs.some(ref => !declared.has(sourceKey(ref)))) fail('criterion_source_invalid')
  }
  for (const stage of plan.stages) {
    unique(stage.dependsOn, 'dependency_duplicate')
    unique(stage.criterionIds, 'coverage_duplicate')
    if (stage.dependsOn.some(id => !seen.has(id))) fail('dependency_not_preceding')
    if (stage.criterionIds.some(id => !criteria.has(id))) fail('criterion_reference_invalid')
    stage.criterionIds.forEach(id => covered.add(id))
    seen.add(stage.stageId)
  }
  if ([...criteria].some(id => !covered.has(id))) fail('criterion_uncovered')
  if ([...criteria, ...seen].some(id => retiredIds.includes(id))) fail('retired_identity_reused')
  if (previousPlan && (plan.runSequence !== previousPlan.runSequence || plan.revision !== previousPlan.revision + 1 || plan.inputVersion < previousPlan.inputVersion)) fail('revision_invalid')
  return plan
}

export function validateStageOutput(value, { plan, completedStageIds = [], artifacts = [], evidence = [] }) {
  const output = stageOutputSchema.parse(value)
  if (output.planRevision !== plan.revision || output.inputVersion !== plan.inputVersion || output.runSequence !== plan.runSequence) fail('output_stale')
  const index = plan.stages.findIndex(stage => stage.stageId === output.stageId)
  if (index < 0) fail('stage_reference_invalid')
  if (plan.stages.slice(0, index).some(stage => !completedStageIds.includes(stage.stageId))) fail('stage_order_invalid')
  if (completedStageIds.includes(output.stageId)) fail('stage_already_completed')
  unique(output.artifactRefs, 'artifact_duplicate')
  unique(output.evidenceRefs, 'evidence_duplicate')
  const artifactIds = new Set(artifacts.map(item => taskArtifactSchema.parse(item).artifactId))
  unique(artifacts.map(item => item.artifactId), 'artifact_duplicate')
  unique(evidence.map(item => item.evidenceId), 'evidence_duplicate')
  for (const item of evidence.filter(item => item.producerKind === 'model')) {
    modelEvidenceSchema.parse(item)
    if (!output.evidenceRefs.includes(item.evidenceId)) fail('evidence_unreferenced')
    if (item.criterionIds.some(id => !plan.stages[index].criterionIds.includes(id))) fail('evidence_criterion_mismatch')
  }
  if (output.artifactRefs.some(id => !artifactIds.has(id))) fail('artifact_reference_invalid')
  for (const id of output.evidenceRefs) {
    const item = evidence.find(item => item.evidenceId === id)
    if (!item) fail('evidence_reference_invalid')
    ;(item.producerKind === 'checker' ? hostCheckEvidenceSchema : modelEvidenceSchema).parse(item)
    if (item.criterionIds.some(id => !plan.stages[index].criterionIds.includes(id))) fail('evidence_criterion_mismatch')
    if (item.artifactRefs.some(ref => !output.artifactRefs.includes(ref))) fail('evidence_artifact_missing')
  }
  return output
}

// checkerResults 只能由 Host 注册检查器执行后传入；模型提交不得合并进此集合。
export function validateCriterionReview(value, { plan, modelEvidence = [], checkerResults = [], artifactIds = [] }) {
  const review = criterionReviewSchema.parse(value)
  const criterion = plan.criteria.find(item => item.criterionId === review.criterionId)
  if (!criterion) fail('criterion_reference_invalid')
  const evidence = [...modelEvidence.map(item => modelEvidenceSchema.parse(item)), ...checkerResults.map(item => hostCheckEvidenceSchema.parse(item))]
  unique(evidence.map(item => item.evidenceId), 'evidence_duplicate')
  unique(review.evidenceRefs, 'evidence_duplicate')
  const selected = review.evidenceRefs.map(id => evidence.find(item => item.evidenceId === id))
  if (selected.some(item => !item)) fail('evidence_reference_invalid')
  if (selected.some(item => !item.criterionIds.includes(review.criterionId))) fail('evidence_criterion_mismatch')
  if (selected.some(item => item.artifactRefs.some(id => !artifactIds.includes(id)))) fail('evidence_artifact_missing')
  if (review.verdict === 'pass') {
    if (selected.some(item => item.outcome !== 'pass')) fail('evidence_not_pass')
    if (criterion.verificationPolicy === 'independent-check' && !selected.some(item => item.producerKind === 'checker')) fail('independent_check_required')
  }
  return review
}

export function reviseTaskPlan(previousPlan, value, { affectedCriterionIds = [], authorizationChanged = false, ...options } = {}) {
  const plan = validateTaskPlan(value, { ...options, previousPlan })
  if (affectedCriterionIds.some(id => !previousPlan.criteria.some(item => item.criterionId === id))) fail('impact_reference_invalid')
  const affected = new Set(affectedCriterionIds)
  for (const item of previousPlan.criteria) {
    const next = plan.criteria.find(candidate => candidate.criterionId === item.criterionId)
    if (authorizationChanged || !next || !same(item, next)) affected.add(item.criterionId)
  }
  const invalidated = new Set(previousPlan.stages.filter(stage => stage.criterionIds.some(id => affected.has(id)) || !plan.stages.some(next => next.stageId === stage.stageId && same(next.criterionIds, stage.criterionIds) && same(next.expectedOutputs, stage.expectedOutputs) && same(next.dependsOn, stage.dependsOn))).map(stage => stage.stageId))
  for (const stage of plan.stages) if (stage.dependsOn.some(id => invalidated.has(id))) invalidated.add(stage.stageId)
  const retiredIds = [...previousPlan.criteria.filter(item => !plan.criteria.some(next => next.criterionId === item.criterionId)).map(item => item.criterionId), ...previousPlan.stages.filter(item => !plan.stages.some(next => next.stageId === item.stageId)).map(item => item.stageId)]
  return { plan, affectedCriterionIds: [...affected], invalidatedStageIds: [...invalidated], retainedStageIds: previousPlan.stages.filter(item => !invalidated.has(item.stageId)).map(item => item.stageId), retiredIds }
}

export function projectTaskPlan(plan, completedStageIds = []) {
  const completed = new Set(completedStageIds)
  return { acceptanceCriteria: plan.criteria.map(item => item.description), stageTasks: plan.stages.map(item => item.title), stagePlan: plan.stages.map(({ stageId, title }) => ({ stageId, title })), completedItems: plan.stages.filter(item => completed.has(item.stageId)).map(item => item.title), remainingItems: plan.stages.filter(item => !completed.has(item.stageId)).map(item => item.title) }
}

// 历史字符串没有来源/覆盖证明。仅提供待确认候选，不把旧完成记录转换为已核验计划。
export function legacyPlanCandidate(task) {
  return { status: 'historical-unverified', taskId: task.taskId, runSequence: task.runSequence, criteria: (task.acceptanceCriteria ?? []).map((description, i) => ({ criterionId: planItemId('criterion', `${task.taskId}:${task.runSequence}:legacy`, i), description })), stages: (task.stageTasks ?? []).map((title, i) => ({ stageId: task.stagePlan?.[i]?.title === title ? task.stagePlan[i].stageId : planItemId('stage', `${task.taskId}:${task.runSequence}:legacy`, i), title })), missing: ['sourceRefs', 'criterion-stage-coverage', 'verificationPolicy', 'expectedOutputs', 'evidence-review'] }
}
