import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareMessageContext } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { messageTimestamp, normalizeHistoryMessage } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import { isDirectedTaskRequest } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

test('群协调来源保留完整长正文、附件身份及独立发送者，不施加旧阶段字节限制', async () => {
  const body = '先执行两条，找我验证通过，再刷69条；行业审核保留。'.repeat(1000)
  const history = [{ sourceKey: 'file-source', sourceVersion: 2, actorId: 'other', text: '已有审核表', attachments: [{ resourceRef: 'file-id', name: '审核.xlsx' }] }]
  const snapshot = await prepareMessageContext({ sourceKey: 'now', sourceVersion: 1, body, actorId: 'requester', conversationId: 'group', context: { directedToAgent: true } }, { history: async () => history, splitBackground: async ({ history }) => history })
  assert.equal(snapshot.source.text, body)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 8000)
  assert.equal(snapshot.replyObligation.required, true)
  assert.equal(snapshot.history[0].actorId, 'other')
  assert.equal(snapshot.history[0].attachments[0].resourceRef, 'file-id')
})

test('来源时间统一epoch并保留文件消息准确fileId', () => {
  assert.equal(messageTimestamp('2026-09-30 17:15:14'), messageTimestamp('2026-09-30T09:15:14Z'))
  assert.equal(messageTimestamp('2026-09-30T17:49:43.607+08:00'), 1790761783607)
  const history = normalizeHistoryMessage({ messageId: 'm', createTime: '2026-09-30 17:15:14', text: '[文件] 审核.xlsx fileId: exact' }, 'group')
  assert.equal(history.occurredAt, '2026-09-30T09:15:14.000Z')
  assert.deepEqual(history.resourceRefs, [{ type: 'fileId', resourceId: 'exact', name: '审核.xlsx' }])
})

test('身份准入不限50字窗口，也不把对第三人的点名变成助手交办', () => {
  assert.equal(isDirectedTaskRequest('小小鹏你在嘛，现在帮忙看一下第一个sheet页，70条数据集的审核状态', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('小小鹏，' + '要求'.repeat(80) + '写完脚本，然后小鹏审批', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('@其他人 处理以上需求', ['小小鹏']), false)
})
