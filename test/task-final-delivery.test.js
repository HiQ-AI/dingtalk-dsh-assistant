import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { freezeTaskDeliveryFiles, readTaskFileDelivery, withTaskFileNotifications } from '../packages/dingtalk-dsh-assistant/task-final-delivery.js'

test('final attachments freeze reported task files, retain original bytes and reject unrelated paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'final-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'task'); await mkdir(directory)
  await writeFile(join(directory, 'acceptance.png'), Buffer.from([137,80,78,71,13,10,26,10]))
  const files = createTaskArtifactFiles({ root: join(root, 'frozen') })
  const task = { taskId: 'task', requirementRevision: 2 }
  const executions = [{ taskId: 'task', executionId: 'execution', status: 'succeeded', drained: true,
    result: { inputVersion: 1, payload: { output: { status: 'completed', artifacts: ['acceptance.png'] } } } }]
  const selected = [{ executionId: 'execution', path: 'acceptance.png', caption: '验收页面结果' }]
  const freeze = input => freezeTaskDeliveryFiles({ selected, task, executions, directory, files, ...input })
  const result = await freeze(); assert.equal(result.length, 1)
  await writeFile(join(directory, 'acceptance.png'), 'later changed')
  const stored = await files.resolve(result[0].artifact)
  assert.equal((await readFile(stored.path)).length, 8)
  assert.equal(result[0].caption, '验收页面结果')
  await assert.rejects(freeze({ selected: [{ ...selected[0], path: 'not-reported.png' }] }), { code: 'TASK_DELIVERY_ARTIFACT_NOT_REPORTED' })
  executions[0].result.payload.output.artifacts.push('../outside.png', 'link.png')
  await assert.rejects(freeze({ selected: [{ ...selected[0], path: '../outside.png' }] }), { code: 'TASK_DELIVERY_ARTIFACT_OUTSIDE_TASK' })
  await writeFile(join(root, 'outside.png'), 'outside')
  await symlink(join(root, 'outside.png'), join(directory, 'link.png'))
  await assert.rejects(freeze({ selected: [{ ...selected[0], path: 'link.png' }] }), { code: 'TASK_ARTIFACT_SCOPE_DENIED' })
  executions[0].drained = false
  await assert.rejects(freeze(), { code: 'TASK_DELIVERY_ARTIFACT_NOT_REPORTED' })
})

test('attachment transport selects frozen files and requires exact original receipt, group and bytes', async () => {
  const artifact = { artifactId: 'file', fileName: 'acceptance.png', size: 8, sha256: 'a'.repeat(64) }
  const notice = { id: 'notice:file', payload: { conversationId: 'group', artifact }, ack: { sendReceipt: { openTaskId: 'send-task' } } }
  const calls = [], verified = { message: { conversationId: 'group', messageId: 'file-message' }, size: 8, sha256: artifact.sha256, resourceRef: { type: 'fileId', resourceId: 'resource' } }
  let status = { contractVersion: 'im.message-send-status.v1', success: true, openTaskId: 'send-task', result: { sendStatus: 'SUCCESS' }, messageRef: { openConversationId: 'group', openMessageId: 'file-message' } }
  const adapter = { querySendStatus: async id => { assert.equal(id, 'send-task'); return status }, readMessageFile: async input => { calls.push(input); return verified } }
  const transport = withTaskFileNotifications({ send: async () => 'text-ack', sendFile: async (n, file) => { assert.equal(n, notice); assert.equal(file.directory, '/frozen'); return 'file-ack' }, readbackFile: n => readTaskFileDelivery(adapter, n) }, { resolve: async file => { assert.equal(file, artifact); return { ...file, directory: '/frozen' } } })
  assert.equal(await transport.send(notice), 'file-ack'); assert.equal(await transport.send({ payload: {} }), 'text-ack')
  assert.equal((await transport.readback(notice)).messageId, 'file-message')
  assert.deepEqual(calls[0].expected, { size: 8, sha256: artifact.sha256 })
  status.openTaskId = 'unrelated-send'
  assert.equal(await transport.readback(notice), undefined); assert.equal(calls.length, 1)
  status.openTaskId = 'send-task'; status.result.openMessageId = 'conflicting-message'
  assert.equal(await transport.readback(notice), undefined); assert.equal(calls.length, 1)
  delete status.result.openMessageId
  status.messageRef.openConversationId = 'other'
  assert.equal(await transport.readback(notice), undefined); assert.equal(calls.length, 1)
  status.messageRef.openConversationId = 'group'; verified.sha256 = 'b'.repeat(64)
  assert.equal(await transport.readback(notice), undefined)
  status.result.sendStatus = 'SENDING'; assert.equal(await transport.readback(notice), undefined)
})
