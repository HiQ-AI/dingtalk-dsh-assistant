import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue as violations } from '@deepseek-ai/dsh-tools'
import { taskCheckpointJsonSchema, taskResultJsonSchema, parseTaskCheckpoint } from '../packages/dingtalk-dsh-assistant/task-result.js'
import { groupDecisionSubmissionJsonSchema, groupDecisionSchema, replyReviewJsonSchema } from '../packages/dingtalk-dsh-assistant/decision.js'
import { taskPlanFixture, stageOutputFixture } from './fixtures/task-plan.js'
const plan = taskPlanFixture()
const stage = stageOutputFixture(plan)
const validateJsonSchemaValue = (schema, value) => assert.deepEqual(violations(schema, value), [])

test('真实DSH接受同源生成的工具契约，无Zod元属性或不支持关键字', () => {
  for (const schema of [taskCheckpointJsonSchema, taskResultJsonSchema, groupDecisionSubmissionJsonSchema, replyReviewJsonSchema]) assert.doesNotThrow(() => assertSupportedJsonSchema(schema))
})
test('DSH wire保留checkpoint kind互斥、错误字段拒绝；长度由Zod精确执行', () => {
  const diagnostic = { inputVersion: 1, runSequence: 1, kind: 'risk-changed', summary: '风险', nextStep: '核对', stageTask: '部署' }
  assert.doesNotThrow(() => validateJsonSchemaValue(taskCheckpointJsonSchema, diagnostic))
  assert.throws(() => validateJsonSchemaValue(taskCheckpointJsonSchema, { ...diagnostic, kind: 'unknown' }))
  assert.throws(() => validateJsonSchemaValue(taskCheckpointJsonSchema, { ...diagnostic, workflowAssessment: { promptRefs: [] } }))
  assert.throws(() => parseTaskCheckpoint({ ...diagnostic, completedItems: ['已完成'] }))
})
test('DSH wire保留result status/waitingKind区分，群动作仍按kind校验', () => {
  assert.doesNotThrow(() => validateJsonSchemaValue(taskResultJsonSchema, { inputVersion: 1, runSequence: 1, status: 'completed', planRevision: plan.revision, criterionReviews: [{ criterionId: plan.criteria[0].criterionId, evidenceRefs: [stage.evidence.evidenceId], verdict: 'pass', reason: '已核验' }], summary: '完成', evidence: ['proof'] }))
  assert.throws(() => validateJsonSchemaValue(taskResultJsonSchema, { inputVersion: 1, runSequence: 1, status: 'waiting', summary: '等待' }))
  const decision = { actions: [{ kind: 'task-cancel', taskId: 't1', inputVersion: 1, runSequence: 1, reason: '取消', topicRefs: [{ topicId: 'topic1', revision: 1 }] }], basisMessageIds: ['m1'], reply: '' }
  const request = { requestId: 'r1', topicId: 'topic1', revision: 1, decision }
  assert.doesNotThrow(() => validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, request))
  assert.throws(() => validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, { ...request, decision: { ...decision, actions: [{ ...decision.actions[0], kind: 'shell' }] } }))
  // wire不支持minItems及anyOf，精确空actions/reply/reason关系不能假称由DSH执行。
  assert.throws(() => groupDecisionSchema.parse({ actions: [], basisMessageIds: ['m1'] }))
})

test('DSH wire要求新计划与阶段输出和完成验收字段，不接受仅旧字符串的提交', () => {
  const checkpoint = { inputVersion: 1, runSequence: 1, kind: 'plan-confirmed', summary: '计划', nextStep: '执行' }
  assert.throws(() => validateJsonSchemaValue(taskCheckpointJsonSchema, checkpoint))
  assert.doesNotThrow(() => validateJsonSchemaValue(taskCheckpointJsonSchema, { ...checkpoint, plan }))
  const stageReport = { ...checkpoint, kind: 'stage-completed', evidence: ['证明'] }
  assert.throws(() => validateJsonSchemaValue(taskCheckpointJsonSchema, stageReport))
  assert.doesNotThrow(() => validateJsonSchemaValue(taskCheckpointJsonSchema, { ...stageReport, stageOutput: stage.output, artifactRecords: [stage.artifact], modelEvidence: [stage.evidence] }))
  const result = { inputVersion: 1, runSequence: 1, status: 'completed', summary: '完成', evidence: ['证明'] }
  assert.throws(() => validateJsonSchemaValue(taskResultJsonSchema, result))
  assert.throws(() => validateJsonSchemaValue(taskResultJsonSchema, { ...result, planRevision: 1 }))
})
