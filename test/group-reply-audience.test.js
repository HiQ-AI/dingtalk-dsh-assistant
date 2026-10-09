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

test('完成通知用既有string摘要展示重点，排查与修复结论不互相改写',async()=>{
 const {ownerReportNotificationText,sameDeliveredText}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 const {ownerDecisionSchema}=await import('../packages/dingtalk-dsh-assistant/task-owner-session.js')
 const {createDwsAdapter}=await import('../packages/dingtalk-dsh-assistant/dws-adapter.js')
 assert.equal(ownerDecisionSchema.properties.summary.type,'string')
 // 人工期望展示fixture，不冒充从旧长文自动提取的语义摘要或现场验收。
 const summaries=[
 '【结论】\n排查完成（尚未修复）\n【结果】\n1. 已确认撤回通知的触发条件。\n2. 已保留复现记录，交给开发处理。\n【下一步】\n请开发负责人修复后按原复现步骤验证。',
 '【结论】\n本次修复已完成\n【结果】\n1. 已修正提示显示。\n2. 已验证正常和失败两种操作结果。\n【下一步】\n请需求方关注后续使用结果，无需补充资料。'
 ]
 for(const summary of summaries){
  const report=Object.freeze({reportType:'complete',facts:Object.freeze({summary})}),text=ownerReportNotificationText(report)
  assert.ok(text.length<350);assert.doesNotMatch(text,/(?<!\n)\n(?!\n)/)
  for(const line of summary.split('\n'))assert.ok(text.includes(line))
  const adapter=createDwsAdapter({runner:{}}),args=adapter.compileGroupReply({groupId:'group',text,idempotencyKey:'notice',replyToMessageId:'original',replyToSenderOpenDingTalkId:'sender'})
  assert.equal(args[args.indexOf('--content')+1],text);assert.equal(args[args.indexOf('--ref-msg-id')+1],'original')
  // 已知DWS mget把段落空行表示为Markdown硬换行，正文仍必须逐项一致。
  const observed=text.replaceAll('\n\n','  \n')
  assert.equal(sameDeliveredText(observed,text),true)
  assert.equal(sameDeliveredText(observed.replace('【下一步】',''),text),false)
  assert.equal(report.facts.summary,summary)
 }
 const sql='历史核验：`SELECT id FROM approvals FOR UPDATE SKIP LOCKED`，未执行写入。'
 const args=createDwsAdapter({runner:{}}).compileGroupReply({groupId:'group',text:sql,idempotencyKey:'notice',replyToMessageId:'original',replyToSenderOpenDingTalkId:'sender'})
 assert.equal(args[args.indexOf('--content')+1],sql)
 assert.equal(sameDeliveredText(sql.replace('FOR UPDATE SKIP LOCKED',''),sql),false)
})

test('补充通知逐项提出信息并保留责任方与下一步，不贴内部分析',async()=>{
 const {ownerReportNotificationText}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 const text=ownerReportNotificationText({reportType:'wait',facts:{summary:'内部调查过程'.repeat(200),condition:{kind:'business-input',missing:'1. 数据集编号。\n2. 操作发生的大致时间。',responsibleParty:'原交办人',resumeWhen:'收到以上信息后继续核对原操作记录。'}}})
 assert.equal(text,'【需补充】\n\n请原交办人补充以下信息：\n\n1. 数据集编号。\n\n2. 操作发生的大致时间。\n\n【下一步】\n\n收到以上信息后继续核对原操作记录。')
 assert.doesNotMatch(text,/内部调查过程/)
})
