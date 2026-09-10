import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue as violations } from '@deepseek-ai/dsh-tools'
import { taskCheckpointJsonSchema, taskResultJsonSchema, parseTaskCheckpoint } from '../packages/dingtalk-dsh-assistant/task-result.js'
import { groupDecisionSubmissionJsonSchema, groupDecisionSchema, replyReviewJsonSchema } from '../packages/dingtalk-dsh-assistant/decision.js'
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
  assert.doesNotThrow(() => validateJsonSchemaValue(taskResultJsonSchema, { inputVersion: 1, runSequence: 1, status: 'completed', summary: '完成', evidence: ['proof'] }))
  assert.throws(() => validateJsonSchemaValue(taskResultJsonSchema, { inputVersion: 1, runSequence: 1, status: 'waiting', summary: '等待' }))
  const decision = { actions: [{ kind: 'task-cancel', taskId: 't1', inputVersion: 1, runSequence: 1, reason: '取消', topicRefs: [{ topicId: 'topic1', revision: 1 }] }], basisMessageIds: ['m1'], reply: '' }
  const request = { requestId: 'r1', topicId: 'topic1', revision: 1, decision }
  assert.doesNotThrow(() => validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, request))
  assert.throws(() => validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, { ...request, decision: { ...decision, actions: [{ ...decision.actions[0], kind: 'shell' }] } }))
  // wire不支持minItems及anyOf，精确空actions/reply/reason关系不能假称由DSH执行。
  assert.throws(() => groupDecisionSchema.parse({ actions: [], basisMessageIds: ['m1'] }))
})
