import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { compactTopicRouteSubmissionJsonSchema, compactGroupDecisionSubmissionSchema, compactGroupDecisionSubmissionJsonSchema, groupDecisionSchema, groupDecisionSubmissionSchema, groupDecisionSubmissionJsonSchema } from '../packages/dingtalk-dsh-assistant/decision.js'

const topicRefs = [{ topicId: 'topic-recall', revision: 1 }]
const basis = { basisMessageIds: ['message-recall'], basisUnitRefs: [{ unitId: 'unit-recall', unitRevision: 1 }] }
const submit = (decision) => ({ requestId: 'decision-recall', topicId: 'topic-recall', revision: 1, decision })
const actions = [
  { kind: 'task-proposal', title: '确认排查', objective: '排查撤回规则', topicRefs },
  { kind: 'new-task', title: '排查撤回规则', objective: '核查专家已评审后仍可撤回的原因', acceptanceCriteria: ['给出代码和复现证据'], topicRefs },
  { kind: 'task-context', taskId: 'task-recall', inputVersion: 1, runSequence: 1, context: '补充专家已审核事实', progressImpact: 'preserve', topicRefs },
  { kind: 'task-reopen', taskId: 'task-recall', inputVersion: 1, runSequence: 1, context: '继续核查新证据', topicRefs },
  { kind: 'task-cancel', taskId: 'task-recall', inputVersion: 1, runSequence: 1, reason: '用户取消', topicRefs },
]

test('路由原生结构允许显式共享定义并要求逐来源理由', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(compactTopicRouteSubmissionJsonSchema))
  const input = { requestId: 'coord-route-test', newTopics: [{ newTopicKey: 'new', title: '新事故', candidateComparisons: [{ topicId: 'old', revision: 1, reason: '不是同一事故' }] }], routes: [{ messageId: 'm', messageVersion: 1, units: [{ unitKey: 'u', summary: '本次事故', replacesUnitIds: [], sourceRefs: [{ wholeMessage: true }], topics: [{ newTopicKey: 'new', reason: '属于本次事故' }] }] }] }
  assert.deepEqual(validateJsonSchemaValue(compactTopicRouteSubmissionJsonSchema, input), [])
  delete input.routes[0].units[0].topics[0].reason
  assert.notDeepEqual(validateJsonSchemaValue(compactTopicRouteSubmissionJsonSchema, input), [])
})

test('精简决策合同可被原生工具使用且要求逐动作来源', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(compactGroupDecisionSubmissionJsonSchema))
  const replyBranch = compactGroupDecisionSubmissionJsonSchema.properties.decision.oneOf.find(branch => branch.properties.replyReview)
  const review = replyBranch.properties.replyReview.properties
  assert.match(review.kind.description, /confirmation/u)
  assert.match(review.sameMatterOutboundIds.description, /confirmation/u)
  assert.match(review.replaceOutboundIds.description, /类型未知/u)
  const input = { revision: 1, decision: { basisMessageIds: ['message-recall'], basisUnitRefs: ['unit-ref'], actions: [{ ...actions[2], topicRefs: ['topic-ref'], basisUnitRefs: ['unit-ref'] }], reply: '已收到' } }
  assert.deepEqual(validateJsonSchemaValue(compactGroupDecisionSubmissionJsonSchema, input), [])
  assert.equal(compactGroupDecisionSubmissionSchema.safeParse(input).success, true)
  delete input.decision.actions[0].basisUnitRefs
  assert.ok(validateJsonSchemaValue(compactGroupDecisionSubmissionJsonSchema, input).length > 0)
  assert.equal(compactGroupDecisionSubmissionSchema.safeParse(input).success, false)
})

test('task-context requires explicit semantics in both Zod and actual native tool JSON schema', () => {
  const action = actions.find(item => item.kind === 'task-context')
  const missing = { ...action }; delete missing.progressImpact
  const envelope = value => submit({ ...basis, actions: [value], reply: '已核对输入' })
  assert.equal(groupDecisionSubmissionSchema.safeParse(envelope(missing)).success, false)
  assert.ok(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, envelope(missing)).length > 0)
  assert.equal(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, envelope(action)).length, 0)
  for (const fields of [{ authorizationChange: 'changed' }, { objective: '新的目标' }, { acceptanceCriteria: ['新增验收'] }]) {
    assert.equal(groupDecisionSubmissionSchema.safeParse(envelope({ ...action, ...fields })).success, false)
    assert.equal(groupDecisionSubmissionSchema.safeParse(envelope({ ...action, ...fields, progressImpact: 'replan' })).success, true)
  }
})

test('决策公开契约保留 reply / reason 互斥，原生 DSH 与 Zod 均接受三条合法路径', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(groupDecisionSubmissionJsonSchema))
  assert.equal(groupDecisionSubmissionJsonSchema.properties.decision.oneOf.length, 2)
  const decisions = [
    { ...basis, actions: [], reply: '收到，我会核对。' },
    { ...basis, actions: [], reason: '该消息无需代理回复或动作。' },
    { ...basis, actions: [actions[1]], reason: '本来源由另一 Topic 统一确认；Host 仍核验回复归属。' },
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
  ]) assert.equal(groupDecisionSchema.safeParse(decision).success, false)
  const result = groupDecisionSchema.safeParse({ ...basis, actions: [], reply: '' })
  assert.deepEqual(result.error.issues[0].path, ['reply'])
  assert.match(result.error.issues[0].message, /actions 为空时 reply 必须非空/u)
})

test('原生JSON schema的reply和reason指引同时允许受限纯事实静默回流', () => {
  const descriptions = { reply: [], reason: [] }
  function collect(schema) {
    if (!schema || typeof schema !== 'object') return
    // 只检查真实Decision分支，不将cancel.reason等动作字段混入。
    if (schema.properties?.actions) for (const field of ['reply', 'reason']) {
      if (schema.properties[field]) descriptions[field].push(schema.properties[field].description)
    }
    for (const child of Object.values(schema)) {
      if (Array.isArray(child)) child.forEach(collect)
      else if (child && typeof child === 'object') collect(child)
    }
  }
  collect(groupDecisionSubmissionJsonSchema)
  for (const [field, values] of Object.entries(descriptions)) {
    assert.ok(values.length > 0, '原生工具应实际携带' + field + '分支说明')
    for (const description of values) for (const term of ['factFeedback:true', 'preserve', 'authorizationChange:none', '其他 Topic', 'task-context']) {
      assert.ok(description.includes(term), field + '指引遗漏事实回流条件：' + term)
    }
  }
  const action = { ...actions.find(item => item.kind === 'task-context'), factFeedback: true, authorizationChange: 'none' }
  const silent = submit({ ...basis, actions: [action], reason: '只向原Owner交付待核对事实，不重复群回复' })
  assert.deepEqual(validateJsonSchemaValue(groupDecisionSubmissionJsonSchema, silent), [])
  assert.deepEqual(groupDecisionSubmissionSchema.parse(silent), silent)
})
