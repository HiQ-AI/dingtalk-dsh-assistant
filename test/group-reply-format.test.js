import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTaskGroupReply } from '../packages/dingtalk-dsh-assistant/group-reply-format.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'

const source = { groupId: 'cid-group', messageId: 'm-original', senderName: '原发起人', senderOpenDingTalkId: 'od-sender' }
const format = options => formatTaskGroupReply({ source, summary: '核验结论：问题部分存在。', ...options })

test('原生引用已绑定时删除正文重复原文，保留其他证据引文', () => {
  const original = { ...source, text: '先查清楚开发分之再说' }
  const args = { source: original, summary: '> 先查清楚开发分之再说\n\n收到，先核清开发分支。\n\n- 小小鹏代回' }
  const value = formatTaskGroupReply(args)
  assert.equal(value.text, '收到，先核清开发分支。\n\n- 小小鹏代回')
  assert.equal(value.replyToMessageId, source.messageId)
  assert.deepEqual(value.atOpenDingTalkIds, ['od-sender'])
  assert.equal(formatTaskGroupReply({ source: original, summary: '> 另一份资料的证据\n\n结论。' }).text, '> 另一份资料的证据\n\n结论。')
  assert.equal(formatTaskGroupReply({ source: { ...source, text: '第一行\n第二行' }, summary: '> 第一行\n> 第二行\n\n已核验。' }).text, '已核验。')
})

test('binds the native quote and true mention to the same source without faking display-name mentions', () => {
  assert.deepEqual(format(), { groupId: 'cid-group', text: '核验结论：问题部分存在。', replyToMessageId: 'm-original', replyToSenderOpenDingTalkId: 'od-sender', atOpenDingTalkIds: ['od-sender'] })
})

test('orders conclusion, evidence and explicit boundaries while preserving supplied links and code', () => {
  const result = format({ evidence: ['`origin/feature/uat2-base@28ebb9bb` 已校验查看权限。', '13 项测试通过。', '变更来自 [#357](https://example.com/pull/357)。'], limitations: ['未执行数据库写入。', '本轮仅完成排查，未修改代码。'] })
  assert.equal(result.text, '核验结论：问题部分存在。\n\n- `origin/feature/uat2-base@28ebb9bb` 已校验查看权限。\n\n- 13 项测试通过。\n\n- 变更来自 [#357](https://example.com/pull/357)。\n\n未执行数据库写入。\n\n本轮仅完成排查，未修改代码。')
})

test('does not invent URLs, evidence, questions or acceptance messages', () => {
  const result = format({ summary: '变更来自 #357。', evidence: ['', ' '], limitations: [] })
  assert.equal(result.text, '变更来自 #357。')
})


test('requires full source binding rather than silently falling back to unquoted sending', () => {
  for (const field of ['groupId', 'messageId', 'senderOpenDingTalkId']) {
    assert.throws(() => format({ source: { ...source, [field]: '' } }), /REQUIRED/u)
  }
})

test('rejects private runtime references and UI chrome but preserves legitimate business identifiers', () => {
  for (const summary of ['通过AI发送', '全部已读', '查看本地任务详情', '调度编号 SG18 已完成', '文件在 /workspace/task/result.md', 'taskId: private-task']) {
    assert.throws(() => format({ summary }), /GROUP_REPLY_/u)
  }
  assert.throws(() => format({ summary: '已完成 internal-run-012345', internalIds: ['internal-run-012345'] }), /INTERNAL_DETAILS/u)
  assert.match(format({ summary: 'GB/T 1234、SG18 型号和 PR #357 已核验。' }).text, /SG18/u)
})

test('rejects malformed content rather than stringifying objects into a public message', () => {
  assert.throws(() => format({ summary: '' }), /SUMMARY_REQUIRED/u)
  assert.throws(() => format({ evidence: [{ text: 'evidence' }] }), /EVIDENCE_INVALID/u)
  assert.throws(() => format({ limitations: 'unverified' }), /LIMITATIONS_INVALID/u)
})

test('uses the existing DWS quote and mention protocol without unsupported formatting flags', () => {
  const adapter = createDwsAdapter({ runner: { run: async () => { throw new Error('unexpected external send') } } })
  const args = adapter.compileGroupReply({ ...format(), idempotencyKey: 'reply-1' })
  assert.equal(args[args.indexOf('--ref-msg-id') + 1], 'm-original')
  assert.equal(args[args.indexOf('--ref-sender') + 1], 'od-sender')
  assert.equal(args[args.indexOf('--at-open-dingtalk-ids') + 1], 'od-sender')
  assert.equal(args[args.indexOf('--content') + 1], format().text)
})






test('正文列表、引用与代码中的署名样例原样保留', () => {
  for (const summary of [
    '小王代回',
    '分工安排：\n- 小王代回\n- 阿明复核',
    '分工安排：\n- 阿明复核\n- 小王代回',
    '分工安排：\n\n- 阿明复核\n\n- 小王代回',
    '分工安排：\n\n- 小王代回',
    '示例命令：\n\n    - 示例助理代回\n\n以上是配置内容。',
    '示例命令：\n\n    - 示例助理代回',
    '示例命令：\n\n```text\n\n- 示例助理代回',
  ]) {
    assert.equal(format({ summary }).text, summary)
    assert.equal(format({ summary, signature: 'Ada Support' }).text, summary)
  }
})


test('不同群模型署名保持原文，历史全局字段不追加或覆盖署名', () => {
  for (const [groupId, footer] of [['group-a', '小小鹏代回'], ['group-b', '数据助理代回']]) {
    for (const signature of [undefined, '', '   ']) {
      const summary = `已核验。\n\n- ${footer}`
      const result = format({ source: { ...source, groupId }, summary, signature, responsibility: '固定署名：无关助理代回' })
      assert.equal(result.text, summary)
      assert.equal(result.groupId, groupId)
    }
  }
  assert.equal(format({ responsibility: '使用小小鹏代回署名' }).text, '核验结论：问题部分存在。')
  const summary = '分工：\n\n- 小王代回\n\n- 阿明复核\n\n> - 引用助理代回\n\n```text\n- 示例助理代回\n```'
  assert.equal(format({ summary, signature: '' }).text, summary)
  assert.equal(format({ summary: '已核验。', evidence: ['证据仍有效。\n\n- 小小鹏代回'], limitations: ['未部署。\n\n- 数据助理代回'] }).text,
    '已核验。\n\n- 证据仍有效。\n  \n  - 小小鹏代回\n\n未部署。\n\n- 数据助理代回')
})
