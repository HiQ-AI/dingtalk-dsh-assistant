import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { groupDecisionSchema, groupDecisionSubmissionSchema, groupDecisionSubmissionJsonSchema } from '../packages/dingtalk-dsh-assistant/decision.js'

const topicRefs = [{ topicId: 'topic-recall', revision: 1 }]
const basis = { basisMessageIds: ['message-recall'], basisUnitRefs: [{ unitId: 'unit-recall', unitRevision: 1 }] }
const submit = (decision) => ({ requestId: 'decision-recall', topicId: 'topic-recall', revision: 1, decision })
const actions = [
  { kind: 'task-proposal', title: '确认排查', objective: '排查撤回规则', topicRefs },
  { kind: 'new-task', title: '排查撤回规则', objective: '核查专家已评审后仍可撤回的原因', acceptanceCriteria: ['给出代码和复现证据'], topicRefs },
  { kind: 'task-context', taskId: 'task-recall', inputVersion: 1, runSequence: 1, context: '补充专家已审核事实', topicRefs },
  { kind: 'task-reopen', taskId: 'task-recall', inputVersion: 1, runSequence: 1, context: '继续核查新证据', topicRefs },
  { kind: 'task-cancel', taskId: 'task-recall', inputVersion: 1, runSequence: 1, reason: '用户取消', topicRefs },
]

test('决策公开契约保留 reply / reason 互斥，原生 DSH 与 Zod 均接受三条合法路径', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(groupDecisionSubmissionJsonSchema))
  assert.equal(groupDecisionSubmissionJsonSchema.properties.decision.oneOf.length, 2)
  const decisions = [
    { ...basis, actions: [], reply: '收到，我会核对。' },
    { ...basis, actions: [], reason: '该消息无需代理回复或动作。' },
    ...actions.map((action) => ({ ...basis, actions: [action], reply: '' })),
    { ...basis, actions: [actions[1]], reply: '我会排查原因。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } },
  ]
  for (const decision of decisions) {
    assert.deepEqual(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, submit(decision)), [])
    assert.deepEqual(groupDecisionSubmissionSchema.parse(submit(decision)), submit(decision), '合法输入格式与持久化决策保持一致')
  }
})

test('真实重试形态 reply + reason 在原生 DSH 和 Zod 都被拒绝，不静默删字段', () => {
  const decision = {
    ...basis, topicUpdate: { summary: '停止越界处理', openQuestions: [], status: 'closed' },
    actions: [], reply: '这次盘点我不该接，也不会继续处理。',
    replyReview: { kind: 'correction', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
    reason: '纠正此前承诺；该事项不形成任务。',
  }
  assert.notDeepEqual(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, submit(decision)), [])
  assert.equal(groupDecisionSubmissionSchema.safeParse(submit(decision)).success, false)
  const { reason: _reason, ...replyOnly } = decision
  assert.deepEqual(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, submit(replyOnly)), [])
  assert.deepEqual(groupDecisionSchema.parse(replyOnly), replyOnly)
  assert.equal(decision.reason, '纠正此前承诺；该事项不形成任务。', '校验不修改输入')
})

test('分支字段和动作判别均严格拒绝错误输入', () => {
  for (const decision of [
    { ...basis, actions: [] },
    { ...basis, actions: [], reason: '无需回复', replyReview: { kind: 'confirmation' } },
    { ...basis, actions: [actions[1]], reply: '处理', reason: '同时填写错误分支字段' },
    { ...basis, actions: [{ ...actions[1], kind: 'shell' }], reply: '处理' },
    { ...basis, actions: [actions[1]], reply: '处理', sourceMessageIds: ['message-recall'] },
  ]) {
    assert.notDeepEqual(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, submit(decision)), [])
    assert.equal(groupDecisionSubmissionSchema.safeParse(submit(decision)).success, false)
  }
})

test('DSH 不支持的长度关系仍由 Zod 严格执行并指明空回复问题', () => {
  for (const decision of [
    { ...basis, actions: [], reply: '' },
    { ...basis, actions: [], reason: '' },
    { ...basis, actions: [actions[1]], reason: '不得带任务动作' },
  ]) assert.equal(groupDecisionSchema.safeParse(decision).success, false)
  const result = groupDecisionSchema.safeParse({ ...basis, actions: [], reply: '' })
  assert.deepEqual(result.error.issues[0].path, ['reply'])
  assert.match(result.error.issues[0].message, /actions 为空时 reply 必须非空/u)
})
