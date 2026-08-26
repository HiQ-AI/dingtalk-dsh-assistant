import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildDecisionPrompt, buildLeafSourceEnvelope, isExplicitAgentDirection, parseGroupDecision, shouldRecheckTaskAssociation } from '../packages/dingtalk-dsh-assistant/decision.js'

test('群决策严格接受五类结构化结果', () => {
  assert.equal(parseGroupDecision('{"kind":"answer","reply":"ok"}').kind, 'answer')
  assert.equal(parseGroupDecision('{"kind":"new-task","objective":"fix","reply":"accepted"}').kind, 'new-task')
  assert.equal(parseGroupDecision('{"kind":"task-context","taskId":"task-1","context":"more","reply":"added"}').kind, 'task-context')
  assert.equal(parseGroupDecision('{"kind":"task-context","taskId":"task-1","context":"more","reply":""}').reply, '')
  assert.equal(parseGroupDecision('{"kind":"task-reopen","taskId":"task-1","context":"rollback","reply":"reopened"}').kind, 'task-reopen')
  assert.equal(parseGroupDecision('{"kind":"task-reopen","taskId":"task-1","context":"rollback","reply":""}').reply, '')
  assert.equal(parseGroupDecision('{"kind":"ignore","reason":"not addressed"}').kind, 'ignore')
})

test('群决策拒绝无效 JSON、多余字段和缺失目标', () => {
  assert.throws(() => parseGroupDecision('answer'), /group_decision_invalid_json/)
  assert.throws(() => parseGroupDecision('{"kind":"answer","reply":"ok","objective":"hidden"}'), /group_decision_invalid_schema/)
  assert.throws(() => parseGroupDecision('{"kind":"new-task","reply":"accepted"}'), /group_decision_invalid_schema/)
})

test('决策 prompt 不重复写入活动 Task 快照并保留消息信封', () => {
  const prompt = buildDecisionPrompt({ sequence: 7, message: 'hello', senderName: '张三', senderOpenDingTalkId: 'od-user-1', occurredAt: '2026-08-24T13:00:00+08:00', quotedMessage: { messageId: 'm-quoted', senderName: '李四', occurredAt: '2026-08-24 12:59:00', content: 'quoted' }, mediaUnavailable: ['media-1: download failed'] })
  assert.doesNotMatch(prompt, /当前活动任务|taskId/)
  assert.doesNotMatch(prompt, /Use new-task|Return one strict JSON/)
  assert.match(prompt, /消息 7\n发送者：张三\n发送者OpenDingTalkId：od-user-1/)
  assert.match(prompt, /时间：2026-08-24T05:00:00\.000Z/)
  assert.match(prompt, /引用消息ID：m-quoted/)
  assert.doesNotMatch(prompt, /发送者：李四|时间：2026-08-24 12:59:00|内容：quoted/)
  assert.match(prompt, /不得仅因附件暂不可读而断言消息与职责或活动任务无关/)
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

test('任务发起必须明确指名配置名称、别名、DWS登录人或使用cc指令', () => {
  const names = ['数字助理', '小助手', '当前登录人']
  assert.equal(isExplicitAgentDirection('数字助理，帮忙排查这个问题', names), true)
  assert.equal(isExplicitAgentDirection('@小助手 请处理', names), true)
  assert.equal(isExplicitAgentDirection('@当前登录人(当前登录人) 帮忙看看', names), true)
  assert.equal(isExplicitAgentDirection('cc: 请处理', []), true)
  assert.equal(isExplicitAgentDirection('这个编辑器问题需要有人排查', names), false)
})

test('诊断请求不得被主会话或叶子会话扩大为修复授权', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务/)
  assert.match(source, /Task objective 是本任务的动作授权上限/)
  assert.match(source, /不得修改代码或数据、提交 PR、合并、构建、部署、执行修复方案/)
})

test('群消息到叶子只使用Runtime原始证据信封', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /const sourceEnvelope = buildLeafSourceEnvelope/u)
  assert.match(source, /objective: sourceEnvelope/u)
  assert.match(source, /appendTaskContextInternal\(task, sourceEnvelope, trigger\)/u)
  assert.match(source, /reopenCompletedTaskInternal\(task, sourceEnvelope, trigger\)/u)
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
