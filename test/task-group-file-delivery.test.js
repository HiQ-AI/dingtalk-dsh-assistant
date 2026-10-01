import { scriptedCoordinator } from './fixtures/group-coordinator.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskGroupFileAdapter, createTaskGroupFileDeliveryWorkflow, createLegacyTaskGroupFileDeliveryWorkflow } from '../packages/dingtalk-dsh-assistant/task-group-file-delivery.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result, acceptanceItems: [] }), true)
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result }), false)
  const acceptanceItems = [{ itemId: 'repair', criterion: '生产故障已经修复', evidenceRefs: ['delivered'] }]
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result, acceptanceItems }), false)
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result, acceptanceItems, verifyAcceptance: async () => false }), false)
  assert.equal(await workflow.ownerContract.validateCompletion({ output: result, acceptanceItems, verifyAcceptance: async args => {
    assert.deepEqual(args.acceptanceItems, acceptanceItems); return true
  } }), true)
  assert.equal(await workflow.ownerContract.validateCompletion({ output: { ...result, receipts: [] }, acceptanceItems: [], verifyAcceptance: async () => true }), false)
  let attempts = 0
  await assert.rejects(workflow.nodes[1].execute({ input: { ...prepared, files: [file, file] }, ...binding,
    perform: async () => { attempts++; return { status: 'unknown' } } }), /DELIVERY_UNCONFIRMED/u)
  assert.equal(attempts, 1)
})

test('文件投递历史 v1 与新 v2 分别冻结，业务验收变更不改旧效果定义', () => {
  const h = harness(), options = { files: h.files, messageAdapter: h.adapter }
  const previous = createLegacyTaskGroupFileDeliveryWorkflow(options), current = createTaskGroupFileDeliveryWorkflow(options)
  assert.equal(previous.version, '1'); assert.equal(previous.ownerContract.version, '1')
  assert.equal(defineExecutionWorkflow(previous).digest, '63292d0c2e3d0e4703cae7477e652b2f7c43b2d0a52c007b1458f4bfae7b6eab')
  assert.equal(current.version, '2'); assert.equal(current.ownerContract.version, '2')
  assert.notEqual(defineExecutionWorkflow(previous).digest, defineExecutionWorkflow(current).digest)
  assert.deepEqual(previous.nodes.map(node => node.version), current.nodes.map(node => node.version))
})

test('正式 Host 重启保留待执行文件投递 v1 的冻结定义，当前目录使用 v2', async t => {
  const root = await mkdtemp(join(tmpdir(), 'file-delivery-contract-restart-'))
  const config = { groupIds: ['group'], ownerActorId: 'owner', profile: 'test', instanceId: 'file-contract-restart',
    dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts') }
  const model = { provider: 'test', model: 'test' }
  const store = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: config.artifactDirectory, initialize: true })
  const h = harness(), workflow = createLegacyTaskGroupFileDeliveryWorkflow({ files: h.files, messageAdapter: h.adapter })
  const definition = defineExecutionWorkflow(workflow)
  const controller = createExecutionController({ store, artifacts, workflows: [workflow],
    delivery: { execute: async () => { throw Error('UNEXPECTED_DELIVERY') } } })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.command({ id: 'register-file-v1', kind: 'workflow.register', args: { workflowId: workflow.id,
    definitionVersion: workflow.version, digest: definition.digest, config: model } })
  await controller.createTaskPlan({ commandId: 'file-plan', taskId: 'task', stages: [{ stageId: 'delivery', workflowId: workflow.id, input: {} }] })
  await controller.close(); await store.close()
  service = await openWorkflowService({ ctx: {}, config, legacy: { getAgentConfig: () => model },
    judge: async () => { throw Error('UNEXPECTED_MODEL') }, taskOwnerSessions: { async close() {} },
    fileTransport: { createAdapter: () => { throw Error('UNEXPECTED_DELIVERY') } } })
  const restored = service.execution.controller.workflowDefinition(workflow.id, definition.digest)
  assert.equal(restored.version, '1'); assert.equal(restored.digest, definition.digest)
  assert.equal(service.execution.controller.workflowDefinition(workflow.id).version, '2')
  const plan = await service.execution.controller.taskPlan('task')
  assert.equal(plan.stages[0].workflowDigest, definition.digest)
  assert.equal(h.sends(), 0)
})
