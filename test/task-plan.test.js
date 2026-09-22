import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTaskPlan, prepareTaskPlan, planItemId, reviseTaskPlan, projectTaskPlan, validateStageOutput, validateCriterionReview, legacyPlanCandidate } from '../packages/dingtalk-dsh-assistant/task-plan.js'

const sourceRefs = [{ messageId: 'm1', messageVersion: 1 }]
const plan = () => ({ revision: 1, inputVersion: 1, runSequence: 1, sourceRefs, workflowRefs: [], criteria: [{ criterionId: 'c1', description: '结果可回读', sourceRefs, verificationPolicy: 'independent-check' }], stages: [{ stageId: 's1', title: '执行', criterionIds: ['c1'], dependsOn: [], expectedOutputs: ['资源版本'] }, { stageId: 's2', title: '核验', criterionIds: ['c1'], dependsOn: ['s1'], expectedOutputs: ['回读记录'] }] })
const evidence = () => ({ evidenceId: 'e1', producerKind: 'model', criterionIds: ['c1'], artifactRefs: ['a1'], sourceRef: 'tool-receipt-1', observedAt: '2026-09-22T00:00:00.000Z', outcome: 'pass', reason: '读取版本一致' })
const review = { criterionId: 'c1', evidenceRefs: ['e1'], verdict: 'pass', reason: '已独立回读' }

test('Host 准备计划注入身份版本，重复准备稳定且拒绝伪造旧 ID', () => {
  const draft = { criteria: [{ key: 'criterion', description: '结果可回读', sourceRefs, verificationPolicy: 'independent-check' }], stages: [{ key: 'stage', title: '执行', criterionKeys: ['criterion'], dependsOnKeys: [], expectedOutputs: ['记录'] }] }
  const binding = { creationId: 'host-request-1', revision: 1, inputVersion: 1, runSequence: 1, sourceRefs, workflowRefs: [] }
  const first = prepareTaskPlan(draft, binding)
  assert.deepEqual(prepareTaskPlan(draft, binding), first)
  assert.equal(first.stages[0].criterionIds[0], first.criteria[0].criterionId)
  assert.throws(() => prepareTaskPlan({ ...draft, stages: [{ ...draft.stages[0], stageId: 'forged' }] }, binding), /unallocated_identity/)
  assert.throws(() => prepareTaskPlan({ ...draft, stages: [{ ...draft.stages[0], dependsOnKeys: ['stage'] }] }, binding), /draft_reference_invalid/)
  const renamed = { criteria: [{ ...draft.criteria[0], criterionId: first.criteria[0].criterionId }], stages: [{ ...draft.stages[0], title: '改名', stageId: first.stages[0].stageId }] }
  assert.equal(prepareTaskPlan(renamed, { ...binding, creationId: 'host-request-2', revision: 2, previousPlan: first }).stages[0].stageId, first.stages[0].stageId)
})

test('计划来源、覆盖、前序依赖和额外字段必须合法', () => {
  assert.deepEqual(validateTaskPlan(plan(), { sourceRefs, workflowRefs: [] }), plan())
  for (const mutate of [p => { p.stages[0].dependsOn = ['s2'] }, p => { p.stages[0].criterionIds = ['missing'] }, p => { p.criteria.push({ ...p.criteria[0], criterionId: 'c2' }) }, p => { p.stages[1].stageId = 's1' }, p => { p.sourceRefs = [{ messageId: 'other', messageVersion: 1 }] }, p => { p.extra = true }]) {
    const p = plan(); mutate(p)
    assert.throws(() => validateTaskPlan(p, { sourceRefs }))
  }
})

test('ID 不依赖标题；改名保留身份，删除身份禁止复用', () => {
  assert.equal(planItemId('stage', 'creation-1', 0), planItemId('stage', 'creation-1', 0))
  const before = plan(), next = structuredClone(before)
  next.revision++; next.stages[0].title = '新的展示名称'
  const result = reviseTaskPlan(before, next)
  assert.deepEqual(result.retainedStageIds, ['s1', 's2'])
  assert.deepEqual(projectTaskPlan(result.plan, ['s1']).completedItems, ['新的展示名称'])
  next.stages.pop()
  assert.deepEqual(reviseTaskPlan(before, next).retiredIds, ['s2'])
  assert.throws(() => validateTaskPlan(before, { retiredIds: ['s2'] }), /retired_identity_reused/)
})

test('验收变化和授权收缩使关联阶段及依赖失效；不修改旧计划', () => {
  const before = plan(), snapshot = structuredClone(before), next = structuredClone(before)
  next.revision++; next.inputVersion++; next.criteria[0].description = '验证新资源版本'
  assert.deepEqual(reviseTaskPlan(before, next).invalidatedStageIds, ['s1', 's2'])
  assert.deepEqual(before, snapshot)
  next.criteria[0].description = before.criteria[0].description
  assert.deepEqual(reviseTaskPlan(before, next, { authorizationChanged: true }).invalidatedStageIds, ['s1', 's2'])
  assert.throws(() => reviseTaskPlan(before, { ...next, revision: 8 }), /revision_invalid/)
})

test('阶段报告必须符合当前版本、顺序及产物证据引用', () => {
  const output = { stageId: 's2', planRevision: 1, inputVersion: 1, runSequence: 1, artifactRefs: ['a1'], evidenceRefs: ['e1'], blockers: [] }
  const context = { plan: plan(), completedStageIds: ['s1'], artifacts: [{ artifactId: 'a1', uri: 'resource://test', version: 'v1' }], evidence: [evidence()] }
  assert.deepEqual(validateStageOutput(output, context), output)
  assert.throws(() => validateStageOutput(output, { ...context, completedStageIds: [] }), /stage_order_invalid/)
  assert.throws(() => validateStageOutput({ ...output, inputVersion: 2 }, context), /output_stale/)
  assert.throws(() => validateStageOutput({ ...output, artifactRefs: [] }, context), /evidence_artifact_missing/)
})

test('阶段拒绝夹带未引用模型证据及其他验收项的证据', () => {
  const output = { stageId: 's1', planRevision: 1, inputVersion: 1, runSequence: 1, artifactRefs: ['a1'], evidenceRefs: ['e1'], blockers: [] }
  const context = { plan: plan(), artifacts: [{ artifactId: 'a1', uri: 'file', version: '1' }], evidence: [evidence()] }
  assert.throws(() => validateStageOutput(output, { ...context, evidence: [...context.evidence, { ...evidence(), evidenceId: 'extra' }] }), /evidence_unreferenced/)
  assert.throws(() => validateStageOutput(output, { ...context, evidence: [{ ...evidence(), criterionIds: ['other'] }] }), /evidence_criterion_mismatch/)
  assert.deepEqual(validateStageOutput(output, context), output)
})

test('模型不能伪造检查器 PASS，UNKNOWN 和无关证据不通过独立验收', () => {
  const context = { plan: plan(), artifactIds: ['a1'], modelEvidence: [evidence()] }
  assert.throws(() => validateCriterionReview(review, context), /independent_check_required/)
  const checker = { ...evidence(), producerKind: 'checker', checkerId: 'readback', checkerVersion: '1', receiptId: 'receipt1' }
  assert.throws(() => validateCriterionReview(review, { ...context, modelEvidence: [checker] }))
  assert.deepEqual(validateCriterionReview(review, { ...context, modelEvidence: [], checkerResults: [checker] }), review)
  for (const outcome of ['unknown', 'fail', 'not-applicable']) assert.throws(() => validateCriterionReview(review, { ...context, modelEvidence: [], checkerResults: [{ ...checker, outcome }] }), /evidence_not_pass/)
  assert.throws(() => validateCriterionReview(review, { ...context, modelEvidence: [], checkerResults: [{ ...checker, criterionIds: ['c2'] }] }), /evidence_criterion_mismatch/)
  assert.throws(() => validateCriterionReview(review, { ...context, modelEvidence: [], checkerResults: [checker], artifactIds: [] }), /evidence_artifact_missing/)
})

test('旧计划只产生历史待确认候选，不虚构覆盖、来源或通过证据', () => {
  const task = { taskId: 't1', runSequence: 1, acceptanceCriteria: ['通过'], stageTasks: ['执行'], stagePlan: [{ stageId: 'original-id', title: '执行' }] }
  const result = legacyPlanCandidate(task)
  assert.equal(result.status, 'historical-unverified')
  assert.equal(result.stages[0].stageId, 'original-id')
  assert.equal(result.stages[0].criterionIds, undefined)
  assert.ok(result.missing.includes('evidence-review'))
  assert.throws(() => validateTaskPlan(result))
})
