import test from 'node:test'
import assert from 'node:assert/strict'
import { assertGroupReply, formatGroupReply, sendWorkflowNotification, executeNotificationOperation, groupStatusText, workflowResultText, groupReplyInstructions } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import { agentWorkPrompt, classifyAgentWorkOutputError } from '../packages/dingtalk-dsh-assistant/agent-work.js'

test('公开正文拒绝明确内部标签，生成错误可修正', () => {
  for (const text of ['任务id：task-123', 'sessionId=abc', '执行会话已启动', '任务会话等待确认', '平台机制已处理', 'Outbox正在发送']) {
    assert.throws(() => formatGroupReply(text), error => error.code === 'GROUP_REPLY_INTERNAL_DETAILS' && classifyAgentWorkOutputError(error) === 'correctable')
  }
})
test('业务代码、文件、PR及业务编号保留，签名和回读正文不被重写', () => {
  for (const text of ['已交付 result.sql、说明.md 和图片.png。', '订单编号：123；SQL：SELECT task_id FROM business_tasks;', 'PR #123：https://github.com/example/repo/pull/123']) {
    assert.doesNotThrow(() => assertGroupReply(text))
    assert.equal(formatGroupReply(text), text)
    assert.equal(formatGroupReply(text, '小小鹏代回'), `${text}\n\n- 小小鹏代回`)
  }
})
test('外发与恢复在领取和发送前拒绝违规正文，未发生外部动作', async () => {
  let sends = 0, claims = 0
  const notification = { payload: { conversationId: 'g', text: '任务会话已启动' } }
  assert.throws(() => sendWorkflowNotification({ sendGroup() { sends++ } }, notification), /GROUP_REPLY_INTERNAL_DETAILS/)
  const operation = { status: 'prepared', snapshot: { type: 'restore', notificationId: 'n', body: notification.payload.text } }
  await assert.rejects(executeNotificationOperation({ store: { query: async ({ kind }) => kind === 'message.notificationOperation' ? operation : notification, command: async () => { claims++ } }, adapter: { canDisclose: async () => true, send() { sends++ }, readback() {} }, operationId: 'o' }), /GROUP_REPLY_INTERNAL_DETAILS/)
  assert.equal(sends, 0)
  assert.equal(claims, 0)
})
test('公开提示覆盖问答与澄清，状态不回显未知内部码', () => {
  assert.ok(agentWorkPrompt.includes(groupReplyInstructions))
  assert.equal(groupStatusText('running'), '正在处理')
  assert.equal(groupStatusText('INTERNAL_ERROR'), '暂未确认')
  assert.equal(groupStatusText('deployed-and-handed-to-testing'), '已部署并交付测试')
  assert.equal(workflowResultText({ deliveryStatus: 'pr_verified', url: 'https://example.test/pr/1', state: 'OPEN' }), '代码已验证并提交 PR：https://example.test/pr/1。当前状态：待合并。')
})
