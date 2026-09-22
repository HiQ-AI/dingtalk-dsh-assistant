import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { installFakeLlm } from '../packages/dingtalk-dsh-assistant/fake-llm.js'
import { groupDecisionSubmissionSchema, topicRouteSubmissionSchema } from '../packages/dingtalk-dsh-assistant/decision.js'
import { taskCheckpointSchema, taskResultSchema } from '../packages/dingtalk-dsh-assistant/task-result.js'
import { prepareTaskPlan, validateStageOutput, validateCriterionReview } from '../packages/dingtalk-dsh-assistant/task-plan.js'

function adapter() {
  let value
  installFakeLlm({ llm: { registerAdapter(providers, instance) { assert.deepEqual(providers, ['fake-resident']); value = instance } } })
  return value
}
const user = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const run = async (value, messages, system) => {
  const chunks = []
  for await (const chunk of value.stream({ messages, system })) chunks.push(chunk)
  return chunks
}
const result = (id, content) => createToolResultMessage({ callId: id, content: [{ type: 'text', text: JSON.stringify(content) }], isError: false })
const assistant = (chunk) => ({ role: 'assistant', source: { kind: 'model' }, content: [chunk.block] })
const topicRequest = (kind, value) => user(`[GROUP_TOPIC_${kind}]\nTopic 请求：${JSON.stringify(value)}`)

test('fake 叶子按固定输入版本逐项 checkpoint 再提交 result，工具拒绝立即失败', async () => {
  const value = adapter(), history = [user('[TASK_TOPIC_CONTEXT]\nTask 输入：{"taskId":"t","inputVersion":2,"runSequence":3}')]
  const sourceRefs = [{ messageId: 'm', messageVersion: 1 }]
  const system = `### 当前执行轮次阶段任务\n\n- 读取（stageId: old1）\n- 核验（stageId: old2）\n\n### 当前执行轮次验收标准\n\n- 工具协议通过\n\n### 当前结构化计划与来源\n\n${JSON.stringify({ sourceRefs })}`
  const submissions = [], evidence = [], completedStageIds = []
  let plan, artifact
  for (let index = 0; index < 6; index++) {
    const chunks = await run(value, history, system)
    const args = JSON.parse(chunks[1].argumentsDelta)
    const name = chunks[1].name
    history.push(assistant(chunks[2]))
    if (name === 'task_plan_prepare') {
      plan = prepareTaskPlan(args.draft, { creationId: 'host-prepared', revision: 1, inputVersion: 2, runSequence: 3, sourceRefs, workflowRefs: [] })
      history.push(result(chunks[1].id, plan)); continue
    }
    if (name === 'task_artifact_register') { artifact = { artifactId: 'host-artifact', ...args.artifact }; history.push(result(chunks[1].id, artifact)); continue }
    const submitted = name === 'submit_task_checkpoint' ? taskCheckpointSchema.parse(args) : taskResultSchema.parse(args)
    submissions.push(submitted)
    if (submitted.kind === 'stage-completed') {
      validateStageOutput(submitted.stageOutput, { plan, artifacts: [artifact], evidence: submitted.modelEvidence, completedStageIds })
      completedStageIds.push(submitted.stageOutput.stageId); evidence.push(...submitted.modelEvidence)
    }
    if (submitted.status === 'completed') for (const review of submitted.criterionReviews) validateCriterionReview(review, { plan, modelEvidence: evidence, artifactIds: [artifact.artifactId] })
    const receipt = { submissionId: `submission-${index}`, received: true, reviewStatus: 'pending', applicationStatus: 'pending' }
    history.push(result(chunks[1].id, receipt))
    assert.equal((await run(value, history, system)).at(-1).reason.kind, 'stop', '仅收件不能推进')
    history.push(user(`[TASK_REPORT_REVIEWED]\n${JSON.stringify({ ...receipt, reviewStatus: 'approved', applicationStatus: 'applied' })}`))
  }
  assert.deepEqual(submissions.map((item) => item.remainingItems), [['读取', '核验'], ['核验'], [], undefined])
  assert.ok(submissions.every((item) => item.inputVersion === 2 && item.runSequence === 3))
  assert.equal((await run(value, history, system)).at(-1).reason.kind, 'stop')
  await assert.rejects(run(value, [history[0], createToolResultMessage({ callId: 'bad', content: [{ type: 'text', text: 'rejected' }], isError: true })], system), /fake_task_tool_rejected/u)
  const rejected = structuredClone(history)
  rejected.at(-1).content[0].text = `[TASK_REPORT_REVIEWED]\n${JSON.stringify({ submissionId: 'submission-5', reviewStatus: 'rejected', applicationStatus: 'blocked' })}`
  await assert.rejects(run(value, rejected, system), /fake_task_report_not_approved/)
})

test('fake adapter 产出完整 dsh 流式 chunk 协议', async () => {
  const direct = user('hello')
  const reminder = createUserMessage({ content: [{ type: 'text', text: 'system reminder' }], source: { kind: 'plugin', plugin: 'test' } })
  const chunks = await run(adapter(), [direct, reminder])
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'fake-main-reply:hello')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('fake adapter 先归类，再读取工具正式 Topic 标识独立提交', async () => {
  const value = adapter()
  const messages = [{ messageId: 'm1', messageVersion: 1, text: '任务：核验提交协议' }]
  const request = topicRequest('ROUTE', { requestId: 'route-1', messages, topics: [] })
  const routing = await run(value, [request])
  assert.equal(routing[1].name, 'group_topic_route_submit')
  const args = topicRouteSubmissionSchema.parse(JSON.parse(routing[1].argumentsDelta))
  assert.deepEqual(args.routes[0].units[0].topics, [{ newTopicKey: 'fake-m1', title: '任务：核验提交协议' }])
  const pendingDecisions = [{ requestId: 'decision-1', topicId: 'topic-persisted', revision: 1, messages: [{ ...messages[0], unitId: 'unit-m1', unitRevision: 1 }] }]
  const decision = await run(value, [request, assistant(routing[2]), result(routing[1].id, { status: 'accepted', requestId: 'route-1' }), topicRequest('DECISION', pendingDecisions[0])])
  assert.equal(decision[1].name, 'group_decision_submit')
  const submission = groupDecisionSubmissionSchema.parse(JSON.parse(decision[1].argumentsDelta))
  assert.equal(submission.requestId, 'decision-1')
  assert.equal(submission.topicId, 'topic-persisted')
  assert.deepEqual(submission.decision.basisMessageIds, ['m1'])
  assert.deepEqual(submission.decision.actions[0].topicRefs, [{ topicId: 'topic-persisted', revision: 1 }])
  assert.equal(submission.decision.actions[0].sourceMessageIds, undefined)
})

test('fake adapter 一批多个话题处理完一个提交一个', async () => {
  const value = adapter()
  const messages = [{ messageId: 'm1', messageVersion: 1, text: '你好' }, { messageId: 'm2', messageVersion: 1, text: '第二个问题' }]
  const request = topicRequest('ROUTE', { requestId: 'route-1', messages, topics: [] })
  const routing = await run(value, [request])
  const pendingDecisions = messages.map((message, index) => ({ requestId: `d${index}`, topicId: `t${index}`, revision: 1, messages: [message] }))
  const history = [request, assistant(routing[2]), result(routing[1].id, { status: 'accepted', requestId: 'route-1' })]
  const firstHistory = [...history, topicRequest('DECISION', pendingDecisions[0])]
  const first = await run(value, firstHistory)
  const secondHistory = [...firstHistory, assistant(first[2]), result(first[1].id, { status: 'accepted' }), topicRequest('DECISION', pendingDecisions[1])]
  const second = await run(value, secondHistory)
  assert.equal(JSON.parse(first[1].argumentsDelta).topicId, 't0')
  assert.equal(JSON.parse(second[1].argumentsDelta).topicId, 't1')
  const done = await run(value, [...secondHistory, assistant(second[2]), result(second[1].id, { status: 'accepted' })])
  assert.equal(done.at(-1).reason.kind, 'stop')
})

test('fake adapter 补充任务携带当前 Task 版本与新 Topic 版本', async () => {
  const tasks = [{ taskId: 'task-1', inputVersion: 3, runSequence: 2, topicRefs: [{ topicId: 'topic-a', revision: 1 }] }]
  const request = topicRequest('DECISION', { requestId: 'd1', topicId: 'topic-a', revision: 2, messages: [{ messageId: 'm2', messageVersion: 1, unitId: 'unit-m2', unitRevision: 1, text: '补充：仅核验本月' }] })
  const chunks = await run(adapter(), [request], `## 本群全部任务关联索引\n\n${JSON.stringify(tasks)}`)
  const { decision } = groupDecisionSubmissionSchema.parse(JSON.parse(chunks[1].argumentsDelta))
  assert.equal(decision.actions[0].inputVersion, 3)
  assert.equal(decision.actions[0].runSequence, 2)
  assert.deepEqual(decision.actions[0].topicRefs, [{ topicId: 'topic-a', revision: 2 }])
})

test('fake adapter 内部审阅必须使用结构化工具回执', async () => {
  for (const kind of ['COMPLETION', 'CHECKPOINT']) {
    const request = user(`[TASK_${kind}_REVIEW]\n审阅请求：${JSON.stringify({ requestId: 'review-1', taskId: 'task-1', inputVersion: 1, runSequence: 1 })}`)
    const chunks = await run(adapter(), [request])
    assert.equal(chunks[1].name, 'group_task_review_submit')
    const args = JSON.parse(chunks[1].argumentsDelta)
    assert.equal(args.requestId, 'review-1')
    assert.equal(kind === 'COMPLETION' ? args.review.accepted : args.review.decision, kind === 'COMPLETION' ? true : 'acknowledge')
  }
})

test('fake adapter 对 Task 协调通知引用 Topic 消息且不提交全群观察集合', async () => {
  const timeline = [{ messageId: 'm1', senderOpenDingTalkId: 'od1' }]
  const request = user(`[TASK_COORDINATION]\n回复请求 ID：reply-1\nTask ID: task-1\nTopic 请求：${JSON.stringify({ messages: timeline })}`)
  const chunks = await run(adapter(), [request])
  assert.equal(chunks[1].name, 'group_reply_submit')
  assert.deepEqual(JSON.parse(chunks[1].argumentsDelta), { requestId: 'reply-1', reply: 'coordinated:task-1', replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] }, replyToMessageId: 'm1', atOpenDingTalkIds: ['od1'] })
})

test('fake adapter 读取候选后提交完整 replyReview', async () => {
  const value = adapter()
  const request = topicRequest('DECISION', { requestId: 'd1', topicId: 'topic-a', revision: 2, messages: [{ messageId: 'm2', messageVersion: 1, text: '新的问题' }], replyReviewCandidateCount: 1 })
  const query = await run(value, [request])
  assert.equal(query[1].name, 'group_reply_review_get')
  const chunks = await run(value, [request, assistant(query[2]), result(query[1].id, { candidates: [{ outboundId: 'out-a' }] })])
  assert.equal(chunks[1].name, 'group_decision_submit')
  assert.deepEqual(JSON.parse(chunks[1].argumentsDelta).decision.replyReview, { kind: 'substantive', reviewedOutboundIds: ['out-a'], sameMatterOutboundIds: [], replaceOutboundIds: [] })
})
