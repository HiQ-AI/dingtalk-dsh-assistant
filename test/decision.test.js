import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { blockTaskDecisionForUnavailableMedia, buildReplyReviewCandidates, isDirectedToOtherParticipants, isExplicitAgentDirection, groupDecisionSchema, REPLY_REVIEW_CANDIDATE_LIMIT, REPLY_REVIEW_MAX_CHARS, TOPIC_TITLE_MAX_CHARS, groupDecisionSubmissionSchema, topicRouteSubmissionSchema } from '../packages/dingtalk-dsh-assistant/decision.js'

const topicRefs = [{ topicId: 'topic-a', revision: 2 }]
const executionVersion = { inputVersion: 1, runSequence: 1 }

test('Topic 决策独立提交并以固定 Topic 版本关联任务', () => {
  const decision = { basisMessageIds: ['m-1'], actions: [
    { kind: 'task-context', taskId: 'task-1', context: 'more', topicRefs, ...executionVersion },
    { kind: 'task-reopen', taskId: 'task-2', context: 'rollback', topicRefs, ...executionVersion },
    { kind: 'new-task', title: '修复问题', objective: 'fix', acceptanceCriteria: ['有可核验证据'], topicRefs },
    { kind: 'task-cancel', taskId: 'task-3', reason: '群里明确说不用处理', topicRefs, ...executionVersion },
  ], reply: '已统一处理', topicUpdate: { summary: '已明确执行范围', openQuestions: [], status: 'active' } }
  assert.deepEqual(groupDecisionSchema.parse(decision), decision)
  assert.deepEqual(groupDecisionSubmissionSchema.parse({ requestId: 'request-a', topicId: 'topic-a', revision: 2, decision }).decision, decision)
  assert.equal(groupDecisionSchema.parse({ basisMessageIds: ['m-1'], actions: [], reason: 'not addressed' }).reason, 'not addressed')
})

test('Topic 决策拒绝缺失来源依据、消息副本和缺失执行版本', () => {
  assert.throws(() => groupDecisionSchema.parse('answer'))
  assert.throws(() => groupDecisionSchema.parse({ actions: [], reply: 'ok' }))
  const action = { kind: 'new-task', title: '修复问题', objective: 'fix', acceptanceCriteria: ['完成'], topicRefs }
  const parseAction = (value) => groupDecisionSchema.parse({ basisMessageIds: ['m-1'], actions: [value], reply: '已接受' })
  assert.throws(() => parseAction({ ...action, sourceMessageIds: ['m-1'] }))
  assert.throws(() => parseAction({ ...action, topicRefs: [] }))
  assert.throws(() => parseAction({ ...action, topicRefs: [{ topicId: 'topic-a', revision: 0 }] }))
  assert.throws(() => parseAction({ kind: 'task-context', taskId: 'task-1', context: '继续', topicRefs }))
})

test('归类可新建、追加或多归属，空归属必须有原因', () => {
  const route = { messageId: 'm-1', messageVersion: 1, topics: [
    { topicId: 'topic-a', relationship: 'continuation', reason: '延续当前讨论目标' },
    { newTopicKey: 'local-b', title: '第二个话题', relationship: 'affected', reason: '同时改变第二事项范围' },
  ], effectOwner: { newTopicKey: 'local-b' } }
  assert.deepEqual(topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [route] }).routes, [route])
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, effectOwner: undefined }] }))
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, topics: route.topics.map(({ relationship: _relationship, reason: _reason, ...topic }) => topic) }] }))
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, effectOwner: { topicId: 'topic-other' } }] }))
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, topics: [] }] }))
  assert.equal(topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, topics: [], effectOwner: undefined, reason: '无可延续讨论的噪声' }] }).routes[0].topics.length, 0)
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, topics: [{ topicId: 'topic-a', newTopicKey: 'invalid', title: '冲突' }] }] }))
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'route-a', routes: [{ ...route, topics: [{ newTopicKey: 'too-long', title: '长'.repeat(TOPIC_TITLE_MAX_CHARS + 1) }] }] }))
})

test('显式任务指向识别配置名称、别名、DWS登录人或cc指令', () => {
  const names = ['数字助理', '小助手', '当前登录人']
  assert.equal(isExplicitAgentDirection('数字助理，帮忙排查这个问题', names), true)
  assert.equal(isExplicitAgentDirection('@小助手 请处理', names), true)
  assert.equal(isExplicitAgentDirection('@当前登录人(当前登录人) 帮忙看看', names), true)
  assert.equal(isExplicitAgentDirection('cc: 请处理', []), true)
  assert.equal(isExplicitAgentDirection('这个编辑器问题需要有人排查', names), false)
})

test('回复审阅结构严格区分确认、结果与订正', () => {
  const decision = groupDecisionSchema.parse({
    basisMessageIds: ['m-1'], actions: [], reply: '已收到，我会结合补充继续处理。',
    replyReview: { kind: 'confirmation', reviewedOutboundIds: ['out-1'], sameMatterOutboundIds: ['out-1'], replaceOutboundIds: ['out-1'] },
  })
  assert.equal(decision.replyReview.kind, 'confirmation')
  assert.deepEqual(groupDecisionSchema.parse({
    basisMessageIds: ['m-1'], actions: [], reply: '收到',
    replyReview: { kind: 'confirmation' },
  }).replyReview, { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] })
})

test('历史回复候选保留真实消息内容且引用ID不参与同一事项定论', () => {
  const group = {
    messages: [
      { messageId: 'm-old', messageVersion: 1, text: '优先处理编辑器数据源字段刷数', occurredAt: '2026-09-04T01:00:00Z', senderName: '李辰', quotedMessage: { messageId: 'quote-a', content: '旧的编辑器需求' } },
      { messageId: 'm-unrelated', text: '构建失败需要上传新的代码包', occurredAt: '2026-09-04T01:01:00Z', senderName: '孙鹏', quotedMessage: { messageId: 'quote-shared', content: '构建问题' } },
    ],
    outbox: [
      { outboundId: 'out-same', sourceMessageId: 'm-old', text: '收到，我会处理编辑器数据源字段。', status: 'sent', deliveredMessageId: 'sent-1', replyKind: 'confirmation', matterSourceMessageIds: ['m-old'], taskIds: ['task-editor'] },
      { outboundId: 'out-quote-only', sourceMessageId: 'm-unrelated', text: '收到，我会检查构建包。', status: 'sent', deliveredMessageId: 'sent-2', replyKind: 'confirmation', matterSourceMessageIds: ['m-unrelated'] },
    ],
  }
  group.topics = [{ topicId: 'topic-old', revision: 1, entries: [{ revision: 1, messageId: 'm-old', messageVersion: 1, action: 'add' }] }]
  const tasks = [{ taskId: 'task-editor', topicRefs: [{ topicId: 'topic-old', revision: 1 }], title: '编辑器刷数', objective: '给编辑器数据集关联已有 source', state: 'running' }]
  const candidates = buildReplyReviewCandidates({
    group, tasks,
    currentMessages: [{ messageId: 'm-current', text: '这个数据源关联不用重复确认，继续原任务', occurredAt: '2026-09-04T01:02:00Z', quotedMessage: { messageId: 'quote-shared', content: '与构建无关的引用' } }],
    focusTaskIds: ['task-editor'], recentLimit: 10,
  })
  assert.deepEqual(candidates.map((candidate) => candidate.outboundId), ['out-quote-only', 'out-same'])
  assert.deepEqual(candidates.find((candidate) => candidate.outboundId === 'out-same').sourceMessages[0], {
    messageId: 'm-old', text: '优先处理编辑器数据源字段刷数', senderName: '李辰', occurredAt: '2026-09-04T01:00:00.000Z', quotedMessageId: 'quote-a', quotedContent: '旧的编辑器需求',
  })
  assert.equal(candidates.find((candidate) => candidate.outboundId === 'out-same').tasks[0].objective, '给编辑器数据集关联已有 source')
  assert.equal(candidates.find((candidate) => candidate.outboundId === 'out-quote-only').sourceMessages[0].quotedMessageId, 'quote-shared')
  assert.deepEqual(buildReplyReviewCandidates({ group, recentLimit: 0, similarityLimit: 0 }).map((candidate) => candidate.outboundId), ['out-quote-only', 'out-same'], '结构化历史确认不能因窗口或词面召回而遗漏')
})

test('历史回复候选按真实关联优先且严格限制数量和序列化体积', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    messageId: `m-${index}`, messageVersion: 1, text: `事项 ${index} 的真实来源正文 ${'细节'.repeat(500)}`,
    senderName: `成员 ${index}`, occurredAt: `2026-09-04T01:${String(index).padStart(2, '0')}:00Z`,
    quotedMessage: { messageId: `quote-${index}`, content: `引用 ${index} ${'依据'.repeat(300)}` },
  }))
  const group = {
    messages,
    outbox: messages.map((message, index) => ({
      outboundId: `out-${index}`, sourceMessageId: message.messageId, matterSourceMessageIds: [message.messageId],
      text: `第 ${index} 条确认 ${'结果'.repeat(500)}`, status: 'sent', replyKind: 'confirmation',
      ...(index === 20 ? { taskIds: ['task-focus'] } : {}),
    })),
  }
  group.topics = [{ topicId: 'topic-focus', revision: 1, entries: [{ revision: 1, messageId: 'm-20', messageVersion: 1, action: 'add' }] }]
  const tasks = [{ taskId: 'task-focus', topicRefs: [{ topicId: 'topic-focus', revision: 1 }], objective: `聚焦任务 ${'范围'.repeat(500)}`, state: 'running' }]
  const candidates = buildReplyReviewCandidates({
    group, tasks, focusTaskIds: ['task-focus'],
    currentMessages: [{ messageId: 'm-current', text: '继续聚焦任务，同时核对最早引用', quotedMessage: { messageId: 'm-0' } }],
  })
  assert.ok(candidates.length <= REPLY_REVIEW_CANDIDATE_LIMIT)
  assert.ok(JSON.stringify(candidates).length <= REPLY_REVIEW_MAX_CHARS)
  assert.ok(candidates.some((candidate) => candidate.outboundId === 'out-0'), '当前引用直接关联的旧候选不能被近期窗口挤掉')
  assert.ok(candidates.some((candidate) => candidate.outboundId === 'out-20'), '当前聚焦 Task 的候选不能被近期窗口挤掉')
  assert.ok(candidates.some((candidate) => candidate.outboundId === 'out-39'), '仍保留最近候选供无显式关联时语义审阅')
  assert.ok(candidates.every((candidate) => candidate.sourceMessages.length <= 4 && candidate.tasks.length <= 3))
})

test('图片mediaId不算@对象且明确询问其他同事不算Agent授权', () => {
  const message = '[图片消息](mediaId=@lQLPJyFx1LlkTRfNBWjNC3qwS5c44-MgXl8Kat4grwTGAA)@李辰 @郑耀彬 只是计算了，没有改信息，为啥要提示这个呢？'
  assert.equal(isDirectedToOtherParticipants(message, ['小小鹏']), true)
  assert.equal(isDirectedToOtherParticipants('@小小鹏 看下这个', ['小小鹏']), false)
  assert.equal(isDirectedToOtherParticipants('[图片消息](mediaId=@asset-id) 这是截图', ['小小鹏']), false)
})

test('叶子任务不得绕过Runtime直接发送群通知', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /群聊通知只有 Runtime 这一个出口/u)
  assert.match(source, /不得调用 DWS 或其他消息工具向来源群发送、回复、编辑或撤回/u)
  assert.match(source, /不得把自行发送群通知作为完成证据/u)
})

test('同事AI回复必须进入模型并由群决策协议判断', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /同事或其 AI 助理发送的回复、任务回执和状态通知都是正常群消息/u)
  assert.match(source, /不得按固定文案或发送者在模型外预先过滤/u)
  assert.doesNotMatch(source, /isAutomatedTaskReceipt|automated_task_receipt/u)
})

test('未点名但应处理时先询问且不得由 Runtime 静默降级', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /未明确指名、但你判断事项应形成任务时，必须选择 task-proposal/u)
  assert.match(source, /询问“这个事项是否需要我处理？”/u)
  assert.match(source, /收到肯定答复后再结合原消息及其后补充选择 new-task/u)
  assert.doesNotMatch(source, /decision\.kind === 'new-task'[\s\S]{0,200}isExplicitAgentDirection/u)
})

test('主会话对任务补充发送简短且不复述信息的确认', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /理解消息、关联任务和回复群聊是三个独立决定/u)
  assert.match(source, /新的执行线索、补充信息或处理要求时，简短确认已收到并会继续处理/u)
  assert.match(source, /过程确认和信息确认必须简短/u)
  assert.match(source, /不得复述、改写或逐项罗列对方提供的信息/u)
  assert.match(source, /给活动 Task 补充 IP、库名、schema、文件、截图、字段范围或其他执行线索时，应返回简短确认/u)
  assert.match(source, /仅因消息提及当前 DWS 登录人姓名/u)
  assert.match(source, /文件或图片前后的短句不得分别追问/u)
  assert.match(source, /确认回复只表达“已收到并会继续处理”这一必要状态，使用一句短句/u)
})

test('诊断请求不得被主会话或叶子会话扩大为修复授权', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务/)
  assert.match(source, /Task objective 是本任务的动作授权上限/)
  assert.match(source, /不得修改代码或数据、提交 PR、合并、构建、部署、执行修复方案/)
  assert.match(source, /后续消息可能明确扩大或收窄同一任务的动作范围/)
})

test('任务关联索引覆盖当前群全部状态并允许历史任务记录关联上下文', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /本群全部任务关联索引/)
  assert.match(source, /queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断/)
  assert.match(source, /结合当前消息的前后文、引用关系、连续消息构成的信息组、当时讨论与执行场景/u)
  assert.match(source, /候选任务的标题、完整目标、动作范围、状态、消息与参与人时间线和已记录上下文/u)
  assert.match(source, /不得根据某几个关键词、词面重合、标题相似或单一字段直接决定复用已有任务或新建任务/u)
  assert.match(source, /关键词只能作为查找候选任务的线索，不能代替关联结论/u)
  assert.match(source, /图片、文档、文件、链接或其他外部资源如果承载任务目标、范围、对象、输入数据或验收要求/u)
  assert.match(source, /任何任务所需资源无法访问、下载、解析或读取不完整时，必须提交 actions:\[\] 和非空 reply/u)
  assert.match(source, /不得假设资源内容、不得用文件名、链接标题、缩略图或消息中的零散文字替代未读取的正文/u)
  assert.match(source, /topicRefs/)
})

test('任务所需附件读取失败时硬拦截任务动作并反馈缺失信息', () => {
  const failures = ['图片 media-1 下载失败', '文档 spec.docx 无法解析']
  for (const decision of [
    { actions: [{ kind: 'new-task', title: '修复问题', objective: '按附件修复', acceptanceCriteria: ['修复有证据'], topicRefs }], reply: '开始处理' },
    { actions: [{ kind: 'task-context', taskId: 'task-1', context: '附件补充', topicRefs }], reply: '继续处理' },
    { actions: [{ kind: 'task-reopen', taskId: 'task-1', context: '附件要求返工', topicRefs }], reply: '重新处理' },
  ]) {
    const blocked = blockTaskDecisionForUnavailableMedia(decision, failures)
    assert.deepEqual(blocked.actions, [])
    assert.match(blocked.reply, /图片 media-1 下载失败；文档 spec\.docx 无法解析/u)
    assert.match(blocked.reply, /信息补齐后我再开始处理/u)
  }
  const answer = { actions: [], reply: '我没有获取到文档正文，请重新发送。' }
  assert.equal(blockTaskDecisionForUnavailableMedia(answer, failures), answer)
  const complete = { actions: [{ kind: 'new-task', title: '文本任务', objective: '执行文本任务', acceptanceCriteria: ['完成'], topicRefs }], reply: '开始处理' }
  assert.equal(blockTaskDecisionForUnavailableMedia(complete, []), complete)
})

test('历史回复审阅从 Task 固定 Topic 版本读取事实，不偷换为最新消息', () => {
  const group = {
    messages: [{ messageId: 'm1', messageVersion: 2, text: '只导出本月', occurredAt: '2026-09-07T02:00:00Z', facts: [{ messageId: 'm1', messageVersion: 1, text: '导出全部数据', occurredAt: '2026-09-07T01:00:00Z' }] }],
    topics: [{ topicId: 't1', revision: 2, entries: [{ revision: 1, messageId: 'm1', messageVersion: 1, action: 'add' }, { revision: 2, messageId: 'm1', messageVersion: 2, action: 'add' }] }],
    outbox: [{ outboundId: 'out1', sourceMessageId: 'task-result:task-1:1', text: '已完成全部数据导出', status: 'sent', taskIds: ['task-1'], topicRefs: [{ topicId: 't1', revision: 1 }] }],
  }
  const tasks = [{ taskId: 'task-1', objective: '导出数据', state: 'completed', topicRefs: [{ topicId: 't1', revision: 2 }] }]
  const [candidate] = buildReplyReviewCandidates({ group, tasks, focusTaskIds: ['task-1'] })
  assert.equal(candidate.sourceMessages[0].text, '导出全部数据')
  assert.equal(candidate.sourceMessages[0].occurredAt, '2026-09-07T01:00:00.000Z')
  assert.equal(group.messages[0].text, '只导出本月')
})
