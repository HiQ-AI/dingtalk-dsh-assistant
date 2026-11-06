import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTopicRoleInstructions } from '../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'
import { coordinationTools } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'

for (const role of ['route','decision']) test('role prompt retains semantic boundaries and isolates executable decision details: ' + role, () => {
  const sections = new Map()
  registerTopicRoleInstructions({ systemPrompt: { section(value) { sections.set(value.name, typeof value.text === 'function' ? value.text() : value.text) } } },
    { role, request: { requestId: 'example' }, store: { getGroup: () => ({ responsibility: 'example responsibility' }), getAgentNames: () => ['example agent'] } })
  for (const name of ['dingtalk-task-boundary','dingtalk-topic-coordination','dingtalk-task-continuation','dingtalk-reply-ownership']) assert.ok(sections.has(name), name)
  assert.ok(sections.has('dingtalk-group-reply'))
  for (const name of ['dingtalk-running-input','dingtalk-reply-recipient','dingtalk-task-progress-query','dingtalk-task-fact-feedback']) assert.equal(sections.has(name), role === 'decision', name)
  const text = [...sections.values()].join('\n')
  assert.ok(text.includes('example responsibility'))
  if (role === 'route') {
    assert.ok(text.includes('不继承他人权限'))
    assert.ok(text.includes('effectOwner') && text.includes('replyTopic'))
    assert.ok(text.includes('group_task_list') && text.includes('group_task_context_get'))
    assert.ok(text.includes('initialReplies与initialReplySilences两个数组都必须提交'))
    assert.ok(text.includes('每个Topic恰好一项') && text.includes('给出具体reason'))
    assert.ok(text.includes('只有无业务Topic时两者才都为空') && text.includes('route_review同样逐Topic处置'))
    assert.ok(text.includes('不套用泛泛确认') && text.includes('静默仅供审计'))
    assert.ok(text.includes('足以形成有信息量的初诊时应提交草稿') && text.includes('不能给最终结论不能单独作为静默理由'))
    assert.ok(text.includes('initialReplies') && text.includes('非结论性') && text.includes('多Topic分别引用各自原消息'))
    assert.ok(text.includes('不直接发送群消息') && text.includes('不执行Task'))
    assert.ok(text.includes('batchRevision') && text.includes('每批最多15条'))
  } else {
    assert.ok(text.includes('progressImpact') && text.includes('atOpenDingTalkIds'))
    assert.ok(text.includes('task-proposal') && text.includes('inputVersion/runSequence'))
    assert.ok(text.includes('首次回复不必重写完整摘要'))
    assert.ok(text.includes('避免重复已发初诊') && text.includes('真实新事实'))
    assert.ok(text.includes('承接或静默的判断及分工依据写入规范决策'))
    assert.ok(text.includes('inlineDecisionContext.task 完整可见时可直接使用'))
    assert.ok(text.includes('inlineDecisionContext.replyReview 是同轮完整紧凑审阅'))
  }
  for (const name of ['read','glob','grep','skill','group_task_list','group_task_context_get','group_topic_list','group_topic_context_get','group_message_get','group_resource_get']) assert.ok(coordinationTools(role).includes(name), name)
})

// Task事实通知本身不得形成反向Task输入循环；只有真实消息Decision做影响判断。
test('任务事实通知不注入消息事实回流职责', () => {
  const sections = new Map()
  registerTopicRoleInstructions({ systemPrompt: { section(value) { sections.set(value.name, value.text) } } },
    { role: 'decision', request: { requestId: 'fact-notification', trigger: 'task-facts' }, store: { getGroup: () => ({}), getAgentNames: () => [] } })
  assert.equal(sections.has('dingtalk-task-fact-feedback'), false)
})
