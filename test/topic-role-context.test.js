import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTopicRoleInstructions } from '../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'
import { coordinationTools } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'

for (const role of ['route','decision']) test('role prompt retains semantic boundaries and isolates executable decision details: ' + role, () => {
  const sections = new Map()
  registerTopicRoleInstructions({ systemPrompt: { section(value) { sections.set(value.name, typeof value.text === 'function' ? value.text() : value.text) } } },
    { role, request: { requestId: 'example' }, store: { getGroup: () => ({ responsibility: 'example responsibility' }), getAgentNames: () => ['example agent'] } })
  for (const name of ['dingtalk-task-boundary','dingtalk-topic-coordination','dingtalk-task-continuation','dingtalk-reply-ownership']) assert.ok(sections.has(name), name)
  for (const name of ['dingtalk-group-reply','dingtalk-running-input','dingtalk-reply-recipient','dingtalk-task-progress-query','dingtalk-task-fact-feedback']) assert.equal(sections.has(name), role === 'decision', name)
  const text = [...sections.values()].join('\n')
  assert.ok(text.includes('example responsibility'))
  if (role === 'route') {
    assert.ok(text.includes('不继承他人权限'))
    assert.ok(text.includes('effectOwner') && text.includes('replyTopic'))
    assert.ok(text.includes('group_task_list') && text.includes('group_task_context_get'))
    assert.ok(text.includes('不回复群聊') && text.includes('不执行Task'))
  } else {
    assert.ok(text.includes('progressImpact') && text.includes('atOpenDingTalkIds'))
    assert.ok(text.includes('task-proposal') && text.includes('inputVersion/runSequence'))
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
