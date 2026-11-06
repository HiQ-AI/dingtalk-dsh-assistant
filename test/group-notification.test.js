import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupNotificationRouting, finalNotificationRouting, prepareGroupNotification, groupNotificationParts } from '../packages/dingtalk-dsh-assistant/group-notification.js'
import { createPlatformNotifier, platformNotificationContext } from '../packages/dingtalk-dsh-assistant/platform-notification.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { sessionWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { verifyTaskNotificationReadback } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'

const messages = [
  { messageId: 'request', senderOpenDingTalkId: 'origin-id', senderName: '成员甲', messageVersion: 1 },
  { messageId: 'review', senderOpenDingTalkId: 'review-id', senderName: '成员甲', messageVersion: 1 },
  { messageId: 'web', senderOpenDingTalkId: 'untrusted-id', sourceKind: 'web' },
]
test('shared audience selection retains intent instead of inferring the latest author or all participants', () => {
  assert.throws(() => finalNotificationRouting(messages, {}), /routing_required/)
  assert.deepEqual(finalNotificationRouting(messages, { atOpenDingTalkIds: ['review-id', 'origin-id', 'review-id'] }).recipients, ['review-id', 'origin-id'])
  assert.throws(() => finalNotificationRouting(messages, { atOpenDingTalkIds: ['成员甲'] }), /recipient_not_in_topic/)
  assert.throws(() => finalNotificationRouting(messages, { atOpenDingTalkIds: ['untrusted-id'] }), /recipient_not_in_topic/)
  assert.deepEqual(finalNotificationRouting(messages, { atOpenDingTalkIds: [] }).recipients, [])
  assert.equal(finalNotificationRouting(messages, { atAll: true }).atAll, true)
  assert.throws(() => finalNotificationRouting(messages, { atAll: true, atOpenDingTalkIds: ['origin-id'] }), /audience_conflict/)
  assert.throws(() => groupNotificationRouting(messages, { replyToMessageId: 'request', atOpenDingTalkIds: ['review-id'] }), /quote_author_not_in_recipients/)
  assert.deepEqual(finalNotificationRouting(messages, { replyToMessageId: 'request', atOpenDingTalkIds: ['review-id'] }).recipients, ['review-id'], 'context reference does not change the actual final audience')
})

test('shared whole-group transport preserves Markdown/signature and uses the real DWS at-all parameter', async () => {
  const calls = [], adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run(args) {
    calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ success: true, result: { openTaskId: 'send-operation' } }) }
  } } })
  const text = '## 工作成果\n\n- [变更记录](https://example.org/change/12)\n\n- 核验通过'
  const reply = prepareGroupNotification({ groupId: 'group', text, atAll: true, signature: '助手代回' })
  const notification = { id: 'all-notice', payload: { ...reply, conversationId: 'group' } }
  await sendWorkflowNotification(adapter, notification)
  const args = calls[0]
  assert.ok(args.includes('--at-all')); assert.ok(!args.includes('--at-open-dingtalk-ids')); assert.ok(!args.includes('--ref-msg-id'))
  assert.equal(args[args.indexOf('--msg-type') + 1], 'markdown')
  assert.equal(args[args.indexOf('--markdown') + 1], text + '\n\n- 助手代回')
  assert.equal(notification.payload.text, text + '\n\n- 助手代回', 'transport does not rewrite the frozen body')
  const observed = { messageId: 'delivered', conversationId: 'group', text: reply.text, uuid: notification.id }
  assert.equal(verifyTaskNotificationReadback(notification, observed), undefined, 'absence of metadata does not prove all were mentioned')
  assert.equal(verifyTaskNotificationReadback(notification, { ...observed, atAll: false }), undefined)
  assert.equal(verifyTaskNotificationReadback(notification, { ...observed, atAll: true }).atAll, true)
  assert.equal(verifyTaskNotificationReadback(notification, observed, { acknowledgedMessageId: 'delivered', sendStatusConfirmed: true }).mentionVerification, 'unavailable')
})

test('platform source admission uses shared files, freezes selected members and resumes the original content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'platform-notification-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = await sessionWorkspace(root, 'platform')
  await writeFile(join(directory, 'acceptance.png'), Buffer.from([137,80,78,71]))
  const group = { messages: [...messages, ...Array.from({ length: 22 }, (_, i) => ({ messageId: `later-${i}`, senderOpenDingTalkId: `later-member-${i}`, text: '近期背景' }))], outbox: [] }, store = { getGroup: () => group }, calls = []
  assert.ok(!platformNotificationContext(group, messages[0]).some(message => message.senderOpenDingTalkId === 'review-id'), 'bounded first context is not a hard recipient whitelist')
  const notify = createPlatformNotifier({ store, root, appendOutbox: async args => { calls.push(args); group.outbox.push(args) } })
  const input = { groupId: 'group', outboundId: 'fixed-notice', message: messages[0], unit: { unitId: 'fixed-unit', unitRevision: 1, fixedTopic: 'agent-platform' }, sessionId: 'platform-session',
    decision: { text: '验收通过。', replyToMessageId: 'request', atOpenDingTalkIds: ['review-id'], files: [{ path: 'acceptance.png', caption: '验收结果' }] } }
  await notify(input)
  const first = calls[0], artifact = first.artifactFiles[0].artifact
  assert.equal(first.sourceRef.messageId, 'request'); assert.equal(first.sourceRef.actorId, 'origin-id')
  assert.deepEqual(first.atOpenDingTalkIds, ['review-id']); assert.equal(first.replyToMessageId, undefined, 'final context source is not a native quote')
  assert.equal(artifact.taskId, undefined); assert.equal(artifact.platformSource.sessionId, 'platform-session')
  await writeFile(join(directory, 'acceptance.png'), 'changed later')
  await notify({ ...input, decision: { text: 'different', atAll: true } })
  assert.deepEqual(calls[1].artifactFiles, first.artifactFiles); assert.deepEqual(calls[1].atOpenDingTalkIds, ['review-id']); assert.equal(calls[1].atAll, undefined)
  const files = createTaskArtifactFiles({ root: join(root, 'delivery-files') }), stored = await files.resolve(artifact)
  assert.deepEqual(await readFile(stored.path), Buffer.from([137,80,78,71]))
  await assert.rejects(files.validateManifest([artifact], { platformSource: { ...artifact.platformSource, groupId: 'foreign' } }), /MANIFEST_SCOPE_DENIED/)
  await assert.rejects(files.validateManifest([artifact], { taskId: 'fake-task', requirementRevision: 1 }), /MANIFEST_SCOPE_DENIED/)
  await assert.rejects(notify({ ...input, outboundId: 'other-notice', decision: { text: '文件结果', atOpenDingTalkIds: [], files: [{ path: '../outside.png', caption: '结果' }] } }), /OUTSIDE_SESSION/)
})


test('私聊文件分片保留真实会话和对端身份', () => {
  const notification = { id: 'reply', kind: 'router-reply', payload: { groupId: 'direct:internal-key',
    conversationId: 'private-real-id', conversationType: 'direct', recipientActorId: 'peer-id' } }
  const [, file] = groupNotificationParts(notification, [{ artifact: { artifactId: 'artifact', fileName: 'result.txt' }, caption: '结果' }])
  assert.equal(file.id, 'reply:file:artifact')
  assert.equal(file.payload.groupId, 'direct:internal-key')
  assert.equal(file.payload.conversationId, 'private-real-id')
  assert.equal(file.payload.conversationType, 'direct')
  assert.equal(file.payload.recipientActorId, 'peer-id')
})

test('直接任务通知由真实会话和对端选择私聊传输，引用与普通发送都不使用内部key', async () => {
  const calls = [], adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run(args) {
    calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ success: true, result: { openTaskId: 'direct-send' } }) }
  } } })
  const notification = { id: 'direct-task-notice', payload: { groupId: 'direct:internal-key', conversationType: 'direct',
    conversationId: 'private-real-id', recipientActorId: 'peer-id', text: '核对完成。' } }
  await sendWorkflowNotification(adapter, notification)
  const args = calls[0]
  assert.equal(args[args.indexOf('--open-dingtalk-id') + 1], 'peer-id')
  assert.equal(args.includes('--group'), false)
  assert.equal(args.includes('direct:internal-key'), false)
  await sendWorkflowNotification(adapter, { ...notification, payload: { ...notification.payload, sourceMessageId: 'source-id', actorId: 'peer-id' } })
  const quote = calls[1]
  assert.equal(quote[quote.indexOf('--group') + 1], 'private-real-id')
  assert.equal(quote[quote.indexOf('--ref-msg-id') + 1], 'source-id')
  assert.equal(quote[quote.indexOf('--ref-sender') + 1], 'peer-id')
  for (const patch of [{ atAll: true }, { atOpenDingTalkIds: ['other-id'] }, { recipientActorId: '' }]) {
    assert.throws(() => sendWorkflowNotification(adapter, { ...notification, payload: { ...notification.payload, ...patch } }), /DWS_DIRECT_NOTIFICATION_TARGET_INVALID/)
  }
  assert.equal(calls.length, 2, '错误私聊收件人或群提及意图不得触发发送')
})
