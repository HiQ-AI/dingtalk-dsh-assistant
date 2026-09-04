import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { blockTaskDecisionForUnavailableMedia, buildDecisionPrompt, buildLeafSourceEnvelope, buildReplyReviewCandidates, isDirectedToOtherParticipants, isExplicitAgentDirection, parseGroupDecision, REPLY_REVIEW_CANDIDATE_LIMIT, REPLY_REVIEW_MAX_CHARS, shouldRecheckTaskAssociation } from '../packages/dingtalk-dsh-assistant/decision.js'

test('群决策一次结构化输出可包含多个任务动作', () => {
  assert.deepEqual(parseGroupDecision('{"actions":[],"reply":"ok"}').actions, [])
  const decision = parseGroupDecision('{"actions":[{"kind":"task-context","taskId":"task-1","context":"more","sourceMessageIds":["m-1"]},{"kind":"task-reopen","taskId":"task-2","context":"rollback","sourceMessageIds":["m-2"]},{"kind":"new-task","title":"修复问题","objective":"fix","acceptanceCriteria":["有可核验证据"],"sourceMessageIds":["m-3"]},{"kind":"task-cancel","taskId":"task-3","reason":"群里明确说不用处理","sourceMessageIds":["m-4"]}],"reply":"已统一处理"}')
  assert.deepEqual(decision.actions.map((action) => action.kind), ['task-context', 'task-reopen', 'new-task', 'task-cancel'])
  assert.equal(parseGroupDecision('{"actions":[],"reason":"not addressed"}').reason, 'not addressed')
})

test('群决策拒绝无效 JSON、多余字段和缺失目标', () => {
  assert.throws(() => parseGroupDecision('answer'), /group_decision_invalid_json/)
  assert.throws(() => parseGroupDecision('{"actions":[],"reply":"ok","objective":"hidden"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"actions":[{"kind":"new-task","title":"修复问题","objective":"fix"}],"reply":"accepted"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"actions":[{"kind":"new-task","title":"修复问题","objective":"fix","acceptanceCriteria":["完成"],"sourceMessageIds":[]}],"reply":"accepted"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"actions":[{"kind":"task-cancel","reason":"不用处理","sourceMessageIds":["m-1"]}],"reply":"已停止"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"actions":[{"kind":"task-cancel","taskId":"task-1","sourceMessageIds":["m-1"]}],"reply":"已停止"}'), /group_decision_invalid_schema/)
})

test('决策 prompt 不重复写入活动 Task 快照并保留消息信封', () => {
  const prompt = buildDecisionPrompt({ messageId: 'm-unique', message: 'hello', senderName: '张三', senderOpenDingTalkId: 'od-user-1', occurredAt: '2026-08-24T13:00:00+08:00', quotedMessage: { messageId: 'm-quoted', senderName: '李四', occurredAt: '2026-08-24 12:59:00', content: 'quoted' }, mediaUnavailable: ['media-1: download failed'], replyReviewCandidateCount: 8 })
  assert.doesNotMatch(prompt, /当前活动任务|taskId/)
  assert.doesNotMatch(prompt, /Use new-task|Return one strict JSON/)
  assert.match(prompt, /消息唯一标识：m-unique\n发送者：张三\n发送者OpenDingTalkId：od-user-1/)
  assert.doesNotMatch(prompt, /消息 \d+/)
  assert.match(prompt, /时间：2026-08-24T05:00:00\.000Z/)
  assert.match(prompt, /引用消息ID：m-quoted/)
  assert.doesNotMatch(prompt, /发送者：李四|时间：2026-08-24 12:59:00|内容：quoted/)
  assert.match(prompt, /不得仅因附件暂不可读而断言消息与职责或活动任务无关/)
  assert.match(prompt, /必须先回答并明确告知对方哪些信息未获取到，不得创建、续接或重开任务/u)
  assert.match(prompt, /Runtime 已绑定 8 条候选/u)
  assert.match(prompt, /group_reply_review_get/u)
  assert.ok(prompt.length < 800, '候选正文不得重新进入普通消息信封')
})

test('群消息判断不注入失败重试行为说明', () => {
  const prompt = buildDecisionPrompt({ message: '需要排查', occurredAt: '2026-08-27T04:00:00Z' })
  assert.doesNotMatch(prompt, /失败消息重试|重新完成原业务判断/)
})

test('引用消息信封只保留引用消息 ID', () => {
  const prompt = buildDecisionPrompt({ message: 'reply', occurredAt: '2026-08-25T05:32:10Z', quotedMessage: { messageId: 'm-source', senderName: '向春梅', occurredAt: '2026-08-24 10:42:37', content: '提示用户需要保存 @485388732' } })
  assert.match(prompt, /引用消息ID：m-source/u)
  assert.doesNotMatch(prompt, /向春梅|2026-08-24 10:42:37|@485388732/u)
  const withoutId = buildDecisionPrompt({ message: 'reply', occurredAt: '2026-08-25T05:32:10Z', quotedMessage: { content: '无 ID 引用' } })
  assert.doesNotMatch(withoutId, /引用消息/u)
})

test('叶子来源信封只传原始事实并要求独立核验', () => {
  const envelope = buildLeafSourceEnvelope({ messageId: 'm-source', message: '看一下是不是缓存导致的', senderName: '张三', senderOpenDingTalkId: 'od-1', occurredAt: '2026-08-26T04:00:00Z', quotedMessage: { messageId: 'm-quoted' }, mediaUnavailable: ['media-1: timeout'] })
  assert.match(envelope, /^\[TASK_SOURCE_EVIDENCE\]/u)
  assert.match(envelope, /消息ID：m-source[\s\S]*原始消息：\n看一下是不是缓存导致的/u)
  assert.match(envelope, /引用消息ID：m-quoted/u)
  assert.match(envelope, /附件读取异常：media-1: timeout/u)
  assert.match(envelope, /不是已经核验的根因、完成状态或实施方案/u)
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
  const decision = parseGroupDecision(JSON.stringify({
    actions: [], reply: '已收到，我会结合补充继续处理。',
    replyReview: { kind: 'confirmation', reviewedOutboundIds: ['out-1'], sameMatterOutboundIds: ['out-1'], replaceOutboundIds: ['out-1'] },
  }))
  assert.equal(decision.replyReview.kind, 'confirmation')
  assert.deepEqual(parseGroupDecision(JSON.stringify({
    actions: [], reply: '收到',
    replyReview: { kind: 'confirmation' },
  })).replyReview, { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] })
})

test('历史回复候选保留真实消息内容且引用ID不参与同一事项定论', () => {
  const group = {
    messages: [
      { messageId: 'm-old', text: '优先处理编辑器数据源字段刷数', occurredAt: '2026-09-04T01:00:00Z', senderName: '李辰', quotedMessage: { messageId: 'quote-a', content: '旧的编辑器需求' } },
      { messageId: 'm-unrelated', text: '构建失败需要上传新的代码包', occurredAt: '2026-09-04T01:01:00Z', senderName: '孙鹏', quotedMessage: { messageId: 'quote-shared', content: '构建问题' } },
    ],
    outbox: [
      { outboundId: 'out-same', sourceMessageId: 'm-old', text: '收到，我会处理编辑器数据源字段。', status: 'sent', deliveredMessageId: 'sent-1', replyKind: 'confirmation', matterSourceMessageIds: ['m-old'], taskIds: ['task-editor'] },
      { outboundId: 'out-quote-only', sourceMessageId: 'm-unrelated', text: '收到，我会检查构建包。', status: 'sent', deliveredMessageId: 'sent-2', replyKind: 'confirmation', matterSourceMessageIds: ['m-unrelated'] },
    ],
  }
  const tasks = [{ taskId: 'task-editor', sourceMessageId: 'm-old', title: '编辑器刷数', objective: '给编辑器数据集关联已有 source', state: 'running', messageHistory: [group.messages[0]] }]
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
    messageId: `m-${index}`, text: `事项 ${index} 的真实来源正文 ${'细节'.repeat(500)}`,
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
  const tasks = [{ taskId: 'task-focus', sourceMessageId: 'm-20', objective: `聚焦任务 ${'范围'.repeat(500)}`, state: 'running', messageHistory: [messages[20]] }]
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

test('群消息到叶子只使用Runtime原始证据信封', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /const sourceEnvelope = sourceMessages\.map\(\(source\) => buildLeafSourceEnvelope/u)
  assert.match(source, /title: action\.title, objective: action\.objective/u)
  assert.match(source, /relatedContexts: \[sourceEnvelope\]/u)
  assert.doesNotMatch(source, /objective: sourceEnvelope/u)
  assert.match(source, /appendTaskContextInternal\(task, sourceEnvelope, trigger, action\.objective, action\.acceptanceCriteria, action\.stageTasks, sourceMessages\)/u)
  assert.match(source, /reopenCompletedTaskInternal\(task, sourceEnvelope, trigger, action\.objective, action\.acceptanceCriteria, action\.stageTasks, sourceMessages\)/u)
  assert.doesNotMatch(source, /appendTaskContextInternal\(task, decision\.context/u)
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
  assert.match(source, /任何任务所需资源无法访问、下载、解析或读取不完整时，必须选择 answer/u)
  assert.match(source, /不得假设资源内容、不得用文件名、链接标题、缩略图或消息中的零散文字替代未读取的正文/u)
  assert.match(source, /relatedContexts/)
})

test('图片及紧邻图片的短消息在存在活动Task时触发关联复核', () => {
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: true }), true)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: false, occurredAt: '2026-08-25T01:41:27Z', previousMessage: { text: '[图片消息](mediaId=1)', occurredAt: '2026-08-25T01:41:05Z' } }), true)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: false, occurredAt: '2026-08-25T01:45:27Z', previousMessage: { text: '[图片消息](mediaId=1)', occurredAt: '2026-08-25T01:41:05Z' } }), false)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 0, hasImage: true }), false)
})

test('任务所需附件读取失败时硬拦截任务动作并反馈缺失信息', () => {
  const failures = ['图片 media-1 下载失败', '文档 spec.docx 无法解析']
  for (const decision of [
    { actions: [{ kind: 'new-task', title: '修复问题', objective: '按附件修复', acceptanceCriteria: ['修复有证据'], sourceMessageIds: ['m-1'] }], reply: '开始处理' },
    { actions: [{ kind: 'task-context', taskId: 'task-1', context: '附件补充', sourceMessageIds: ['m-1'] }], reply: '继续处理' },
    { actions: [{ kind: 'task-reopen', taskId: 'task-1', context: '附件要求返工', sourceMessageIds: ['m-1'] }], reply: '重新处理' },
  ]) {
    const blocked = blockTaskDecisionForUnavailableMedia(decision, failures)
    assert.deepEqual(blocked.actions, [])
    assert.match(blocked.reply, /图片 media-1 下载失败；文档 spec\.docx 无法解析/u)
    assert.match(blocked.reply, /信息补齐后我再开始处理/u)
  }
  const answer = { actions: [], reply: '我没有获取到文档正文，请重新发送。' }
  assert.equal(blockTaskDecisionForUnavailableMedia(answer, failures), answer)
  const complete = { actions: [{ kind: 'new-task', title: '文本任务', objective: '执行文本任务', acceptanceCriteria: ['完成'], sourceMessageIds: ['m-1'] }], reply: '开始处理' }
  assert.equal(blockTaskDecisionForUnavailableMedia(complete, []), complete)
})
