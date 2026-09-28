import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskGroupFileAdapter, createTaskGroupFileDeliveryWorkflow } from '../packages/dingtalk-dsh-assistant/task-group-file-delivery.js'

const file = { taskId: 'task', requirementRevision: 1, artifactId: 'a'.repeat(64), sha256: 'b'.repeat(64), size: 10, fileName: '报告.sql', role: 'script' }
const binding = { taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 0, requirementDigest: 'c'.repeat(64) }
const input = { file, groupId: 'group', profile: 'corp:user', requirementRevision: 1 }
const ack = { sendReceipt: { openTaskId: 'send-task' } }
function harness(options = {}) {
  let sends = 0, reads = 0, allowed = true
  const files = { resolve: async artifact => { assert.deepEqual(artifact, file); return { ...file, directory: 'managed-directory' } }, validateManifest: async values => structuredClone(values) }
  const dws = { sendGroupFile: async request => { sends++; assert.equal(request.fileName, file.fileName); return ack },
    querySendStatus: async () => ({ result: { sendStatus: 'SUCCESS' }, messageRef: { openConversationId: options.groupId ?? 'group', openMessageId: 'message' } }),
    readMessageFile: async request => { reads++; assert.deepEqual(request.expected, { size: file.size, sha256: file.sha256 }); return { size: file.size, sha256: options.sha256 ?? file.sha256, message: { conversationId: 'group', messageId: 'message' }, resourceRef: { type: 'fileId', resourceId: 'resource' } } } }
  const adapter = createTaskGroupFileAdapter({ files, profile: 'corp:user', canDisclose: async () => allowed, createAdapter: ({ directory, profile }) => { assert.equal(directory, 'managed-directory'); assert.equal(profile, 'corp:user'); return dws } })
  return { adapter, files, sends: () => sends, reads: () => reads, revoke: () => { allowed = false } }
}

test('受理回执先unknown，原消息字节核验后成功，恢复绝不再次发送', async () => {
  const h = harness(), prepared = await h.adapter.prepare({ input, binding })
  const accepted = await h.adapter.execute(prepared)
  assert.equal(accepted.status, 'unknown')
  assert.deepEqual(accepted.result.ack, ack)
  const delivered = await h.adapter.reconcile(prepared, { previousObservation: accepted })
  assert.equal(delivered.status, 'succeeded')
  assert.equal(delivered.result.messageId, 'message')
  assert.equal(delivered.result.role, 'script')
  assert.equal(delivered.result.ack, undefined)
  await h.adapter.reconcile(prepared, { previousObservation: accepted })
  assert.equal(h.sends(), 1)
  assert.equal(h.reads(), 2)
  const next = await h.adapter.prepare({ input, binding: { ...binding, nodeRunId: 'next', generation: 2 } })
  assert.equal(next.deliveryKey, prepared.deliveryKey)
  assert.notEqual(next.digest, prepared.digest)
})

test('无ACK、错群、内容不匹配或授权撤销均unknown且零重发', async () => {
  const missing = harness(), p = await missing.adapter.prepare({ input, binding })
  assert.equal((await missing.adapter.reconcile(p)).reason, 'MESSAGE_ACK_UNAVAILABLE')
  assert.equal(missing.sends(), 0)
  for (const options of [{ groupId: 'other' }, { sha256: 'd'.repeat(64) }]) {
    const h = harness(options), prepared = await h.adapter.prepare({ input, binding })
    assert.equal((await h.adapter.reconcile(prepared, { previousObservation: { result: { ack } } })).status, 'unknown')
    assert.equal(h.sends(), 0)
  }
  const revoked = harness(), prepared = await revoked.adapter.prepare({ input, binding })
  revoked.revoke()
  await assert.rejects(revoked.adapter.execute(prepared), /DISCLOSURE_DENIED/u)
  assert.equal((await revoked.adapter.reconcile(prepared, { previousObservation: { result: { ack } } })).status, 'unknown')
  assert.equal(revoked.sends(), 0)
})

test('冻结准备拒绝跨profile、篡改group和旧需求文件', async () => {
  const h = harness()
  await assert.rejects(h.adapter.prepare({ input: { ...input, profile: 'other' }, binding }), /PROFILE_DENIED/u)
  await assert.rejects(h.adapter.prepare({ input: { ...input, requirementRevision: 2 }, binding }), /PREPARED_INVALID/u)
  const prepared = await h.adapter.prepare({ input, binding })
  await assert.rejects(h.adapter.execute({ ...prepared, groupId: 'other' }), /PREPARED_INVALID/u)
  assert.equal(h.sends(), 0)
})

test('固定三节点通过逐件效果与验收收口，未确认项阻止后续发送', async () => {
  const h = harness(), workflow = createTaskGroupFileDeliveryWorkflow({ files: h.files, messageAdapter: h.adapter })
  const request = { files: [file], groupId: 'group', profile: 'corp:user', requirementRevision: 1 }
  const prepared = await workflow.nodes[0].execute({ input: request, taskId: 'task' })
  const sent = await workflow.nodes[1].execute({ input: prepared, ...binding, perform: async ({ action, prepared }) => {
    assert.equal(action, 'message')
    const accepted = await h.adapter.execute(prepared)
    return h.adapter.reconcile(prepared, { previousObservation: accepted })
  } })
  const result = await workflow.nodes[2].execute({ input: sent, taskId: 'task' })
  assert.equal(result.deliveryStatus, 'files_verified')
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result }), true)
  assert.equal(await workflow.ownerContract.validateCompletion({ output: { ...result, receipts: [] } }), false)
  let attempts = 0
  await assert.rejects(workflow.nodes[1].execute({ input: { ...prepared, files: [file, file] }, ...binding,
    perform: async () => { attempts++; return { status: 'unknown' } } }), /DELIVERY_UNCONFIRMED/u)
  assert.equal(attempts, 1)
})
