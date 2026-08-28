import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildDecisionPrompt, buildLeafSourceEnvelope, isExplicitAgentDirection, parseGroupDecision, shouldRecheckTaskAssociation } from '../packages/dingtalk-dsh-assistant/decision.js'

test('群决策严格接受六类结构化结果', () => {
  assert.equal(parseGroupDecision('{"kind":"answer","reply":"ok"}').kind, 'answer')
  assert.equal(parseGroupDecision('{"kind":"task-proposal","title":"导出数据","objective":"导出 1.0.1 数据","reply":"这个事项是否需要我处理？"}').kind, 'task-proposal')
  assert.equal(parseGroupDecision('{"kind":"new-task","title":"修复问题","objective":"fix","reply":"accepted"}').kind, 'new-task')
  assert.equal(parseGroupDecision('{"kind":"task-context","taskId":"task-1","context":"more","reply":"added"}').kind, 'task-context')
  assert.equal(parseGroupDecision('{"kind":"task-context","taskId":"task-1","context":"fix it","objective":"修复并部署","reply":"added"}').objective, '修复并部署')
  assert.equal(parseGroupDecision('{"kind":"task-context","taskId":"task-1","context":"more","reply":""}').reply, '')
  assert.equal(parseGroupDecision('{"kind":"task-reopen","taskId":"task-1","context":"rollback","reply":"reopened"}').kind, 'task-reopen')
  assert.equal(parseGroupDecision('{"kind":"task-reopen","taskId":"task-1","context":"deploy","objective":"修复并部署 UAT2","reply":"reopened"}').objective, '修复并部署 UAT2')
  assert.equal(parseGroupDecision('{"kind":"task-reopen","taskId":"task-1","context":"rollback","reply":""}').reply, '')
  assert.equal(parseGroupDecision('{"kind":"ignore","reason":"not addressed"}').kind, 'ignore')
})

test('群决策拒绝无效 JSON、多余字段和缺失目标', () => {
  assert.throws(() => parseGroupDecision('answer'), /group_decision_invalid_json/)
  assert.throws(() => parseGroupDecision('{"kind":"answer","reply":"ok","objective":"hidden"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"kind":"new-task","reply":"accepted"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"kind":"new-task","objective":"fix","reply":"accepted"}'), /group_decision_invalid_schema/)
})

test('决策 prompt 不重复写入活动 Task 快照并保留消息信封', () => {
  const prompt = buildDecisionPrompt({ messageId: 'm-unique', message: 'hello', senderName: '张三', senderOpenDingTalkId: 'od-user-1', occurredAt: '2026-08-24T13:00:00+08:00', quotedMessage: { messageId: 'm-quoted', senderName: '李四', occurredAt: '2026-08-24 12:59:00', content: 'quoted' }, mediaUnavailable: ['media-1: download failed'] })
  assert.doesNotMatch(prompt, /当前活动任务|taskId/)
  assert.doesNotMatch(prompt, /Use new-task|Return one strict JSON/)
  assert.match(prompt, /消息唯一标识：m-unique\n发送者：张三\n发送者OpenDingTalkId：od-user-1/)
  assert.doesNotMatch(prompt, /消息 \d+/)
  assert.match(prompt, /时间：2026-08-24T05:00:00\.000Z/)
  assert.match(prompt, /引用消息ID：m-quoted/)
  assert.doesNotMatch(prompt, /发送者：李四|时间：2026-08-24 12:59:00|内容：quoted/)
  assert.match(prompt, /不得仅因附件暂不可读而断言消息与职责或活动任务无关/)
})

test('失败消息重试明确要求重新完成业务判断', () => {
  const prompt = buildDecisionPrompt({ message: '需要排查', occurredAt: '2026-08-27T04:00:00Z', deliveryRetry: true })
  assert.match(prompt, /这是一次失败消息重试/)
  assert.match(prompt, /不得仅因消息 ID 已在会话中出现[\s\S]*判定 ignore/)
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
  assert.match(source, /const sourceEnvelope = buildLeafSourceEnvelope/u)
  assert.match(source, /title: decision\.title, objective: decision\.objective/u)
  assert.match(source, /relatedContexts: \[sourceEnvelope\]/u)
  assert.doesNotMatch(source, /objective: sourceEnvelope/u)
  assert.match(source, /appendTaskContextInternal\(task, sourceEnvelope, trigger, decision\.objective, decision\.acceptanceCriteria, decision\.stageTasks\)/u)
  assert.match(source, /reopenCompletedTaskInternal\(task, sourceEnvelope, trigger, decision\.objective, decision\.acceptanceCriteria, decision\.stageTasks\)/u)
  assert.doesNotMatch(source, /appendTaskContextInternal\(task, decision\.context/u)
})

test('任务关联索引覆盖当前群全部状态并允许历史任务记录关联上下文', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /本群全部任务关联索引/)
  assert.match(source, /queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断/)
  assert.match(source, /relatedContexts/)
})

test('图片及紧邻图片的短消息在存在活动Task时触发关联复核', () => {
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: true }), true)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: false, occurredAt: '2026-08-25T01:41:27Z', previousMessage: { text: '[图片消息](mediaId=1)', occurredAt: '2026-08-25T01:41:05Z' } }), true)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 1, hasImage: false, occurredAt: '2026-08-25T01:45:27Z', previousMessage: { text: '[图片消息](mediaId=1)', occurredAt: '2026-08-25T01:41:05Z' } }), false)
  assert.equal(shouldRecheckTaskAssociation({ activeTaskCount: 0, hasImage: true }), false)
})
