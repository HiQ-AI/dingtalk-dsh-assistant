import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindFileDelivery, selectTaskDeliveryFiles, verifyFileDeliveryOutput, describeTaskNodeOutput, openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability } from '../packages/dingtalk-dsh-assistant/task-artifact-write.js'
import { createGeneralCapabilityStepWorkflow } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskGroupFileDeliveryWorkflow } from '../packages/dingtalk-dsh-assistant/task-group-file-delivery.js'

const fileDelivery = { sourceQuote: '完成后把文件发到本群', files: [{ role: 'report', fileName: '报告.sql' }] }
const scope = { taskId: 'task', requirementRevision: 2, groupId: 'group', profile: 'test', fileDelivery }

test('仅原文明确群发授权可绑定文件，禁止否定授权和路径', () => {
  assert.deepEqual(bindFileDelivery(fileDelivery, '请完成后把文件发到本群。'), fileDelivery)
  assert.equal(bindFileDelivery(null, '只生成文件'), null)
  assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote: '发消息到群里' }, '发消息到群里'), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  assert.deepEqual(bindFileDelivery({ ...fileDelivery, sourceQuote: 'SQL文件发群里' }, 'SQL文件发群里'), { ...fileDelivery, sourceQuote: 'SQL文件发群里' })
  assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote: '发文件到本群' }, '不用发文件到本群'), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  for (const source of ['没有要求发文件', '不要完成后把文件发到本群', '禁止完成后把文件发到本群', '暂停完成后把文件发到本群'])
    assert.throws(() => bindFileDelivery(fileDelivery, source), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  for (const fileName of ['../secret.sql', 'C:\\secret.sql', 'bad\u0000.sql'])
    assert.throws(() => bindFileDelivery({ ...fileDelivery, files: [{ role: 'report', fileName }] }, fileDelivery.sourceQuote), { code: 'TASK_FILE_DELIVERY_MANIFEST_INVALID' })
  assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote: 1 }, fileDelivery.sourceQuote), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  const other = { ...fileDelivery, sourceQuote: '把文件发到另一个群' }
  assert.throws(() => bindFileDelivery(other, other.sourceQuote), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
})

test('附件授权接受带标点和跨句的精确原文，仍检查完整源句上下文', () => {
  const quotes = ['完成后把文件发到本群。', '根据以下合成数据生成 Markdown 报告，并把文件附件发送到本群。文件名为“任务文件收纳上线验收-20260929.md”。', '生成文件。\n把附件发送到本群。']
  for (const sourceQuote of quotes) {
    const candidate = { ...fileDelivery, sourceQuote }
    assert.deepEqual(bindFileDelivery(candidate, `请${sourceQuote}仅用于验收。`), candidate)
    for (const source of [`不要${sourceQuote}`, `禁止${sourceQuote}`])
      assert.throws(() => bindFileDelivery(candidate, source), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  }
  for (const sourceQuote of ['生成文件。把附件发送到另一个群。', '把文件发到本群。其他群也发送。'])
    assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote }, sourceQuote), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote: '生成文件。把附件发送到本群。' }, '生成文件。请把附件发送到本群。'), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
  assert.throws(() => bindFileDelivery({ ...fileDelivery, sourceQuote: '把文件发到本群。' }, '其他群需要把文件发到本群。'), { code: 'TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED' })
})

for (const mode of ['write', 'omitted', 'import']) test(`真实消息与Owner业务交付闭环：${mode}`, async t => {
  const omitDelivery = mode === 'omitted', importing = mode === 'import'
  const expectedDelivery = importing ? { ...fileDelivery, files: [{ role: 'image', fileName: '已有图片.png' }] }
    : mode === 'write' ? { ...fileDelivery, sourceQuote: '生成SQL报告，完成后把文件发到本群。文件名为报告.sql。' } : fileDelivery
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-file-'))
  const config = { groupIds: ['group'], ownerActorId: 'owner', profile: 'test', instanceId: 'owner-file',
    dbPath: join(root, 'control.db'), artifactDirectory: join(root, 'artifacts') }
  const binary = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQy7vzHwAEfgJodQLI1QAAAABJRU5ErkJggg==', 'base64')
  if (importing) {
    const sourceRoot = join(root, 'source')
    await mkdir(sourceRoot)
    await writeFile(join(sourceRoot, '原图.png'), binary)
    config.generalFileRead = { root: sourceRoot, readablePaths: ['原图.png'] }
  }
  const initialize = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true })
  await initialize.close()
  await openExecutionArtifacts({ directory: config.artifactDirectory, initialize: true })
  let sends = 0, reads = 0, ownerCalls = 0
  const ownerSessions = { async run({ input, onSessionBound, onCandidate }) {
    ownerCalls++
    await onSessionBound()
    const refs = input.stages.filter(stage => stage.status === 'succeeded').map(stage => stage.outputRef)
    const write = { workflowId: 'task-general-capability', gate: 'none', capabilityStep: { capabilityId: importing ? 'import-task-file' : 'write-task-file',
      input: importing ? { role: 'image', fileName: '已有图片.png', relativePath: '原图.png' }
        : { role: 'report', fileName: '报告.sql', content: '-- 原字节测试\nSELECT 1;\n' }, expectedEvidence: '原文件摘要核验' } }
    const complete = input.stages.length > 0 && input.stages.every(stage => stage.status === 'succeeded')
    const decision = !input.stages.length ? { action: 'advance', summary: '生成文件', evidenceRefs: [],
      planChange: { kind: 'initialize', stages: [write] } }
      : complete && !omitDelivery && input.stages.length === 1 ? { action: 'advance', summary: '文件已生成，追加交付', evidenceRefs: refs,
        planChange: { kind: 'append', stages: [{ workflowId: 'task-group-file-delivery', gate: 'none' }] } }
      : complete ? { action: 'complete', summary: '产物处理完毕', evidenceRefs: refs,
        assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs })) }
        : { action: input.stages.some(stage => stage.status === 'ready') ? 'advance' : 'wait', summary: '继续当前阶段', evidenceRefs: refs }
    await onCandidate(decision)
    return { status: 'submitted', decision }
  }, async close() {} }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text,
      constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId,
      intent: { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: importing ? '将已有图片发送本群' : '生成SQL报告并发送本群', fileDelivery: expectedDelivery }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } })) }
    throw new Error(`Unexpected stage: ${stage}`)
  }
  const service = await openWorkflowService({ ctx: {}, config, judge,
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: groupId => ({ groupId, messages: [] }) },
    taskOwnerSessions: ownerSessions,
    fileTransport: { createAdapter: ({ directory }) => ({
      sendGroupFile: async ({ fileName }) => { sends++; if (importing) assert.deepEqual(await readFile(join(directory, fileName)), binary); return { sendReceipt: { openTaskId: 'actual-ack' } } },
      querySendStatus: async () => ({ result: { sendStatus: 'SUCCESS' }, messageRef: { openConversationId: 'group', openMessageId: 'actual-file-message' } }),
      readMessageFile: async ({ expected }) => { reads++; return { ...expected, message: { conversationId: 'group', messageId: 'actual-file-message' },
        resourceRef: { type: 'fileId', resourceId: 'actual-resource' } } },
    }) },
    generalCompletionCheck: async ({ acceptanceCriteria, evidence }) => ({ status: 'satisfied', resultVerified: true,
      criteria: acceptanceCriteria.map(criterion => ({ criterion, passed: true, evidenceIds: evidence.map(item => item.evidenceId) })) }),
    generalCompletionIdentity: 'integration-file-verification-v1',
  })
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  const received = await service.ingest({ groupId: 'group', messageId: 'user-request', senderOpenDingTalkId: 'owner',
    text: '生成SQL报告，完成后把文件发到本群。文件名为报告.sql。' })
  await service.messages.process(received.runId)
  let taskId
  for (let attempt = 0; attempt < 40; attempt++) {
    const message = await service.messages.state(received.runId)
    taskId = message.commands[0]?.result?.taskId
    if (taskId) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(taskId, JSON.stringify(await service.messages.state(received.runId)))
  const execution = service.execution
  for (let attempt = 0; attempt < 12; attempt++) {
    const plan = await execution.controller.taskPlan(taskId)
    for (const stage of plan.stages.filter(item => item.runId)) await execution.controller.whenIdle(stage.runId)
    await service.recover()
    const owner = await execution.store.query({ kind: 'task.owner', taskId })
    if (owner.status === 'completed' || omitDelivery && (await execution.controller.taskPlan(taskId)).task.status === 'succeeded') break
  }
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.taskId, taskId)
  assert.equal(plan.stages[0]?.status, 'succeeded', JSON.stringify({ plan, owner: await execution.store.query({ kind: 'task.owner', taskId }),
    actions: await execution.store.query({ kind: 'task.owner.actions.pending', limit: 10 }) }))
  const reports = await execution.store.query({ kind: 'task.owner.reports', taskId })
  if (omitDelivery) {
    assert.equal(sends, 0)
    assert.equal(reports.some(report => report.reportType === 'complete'), false)
    assert.notEqual((await execution.store.query({ kind: 'task.owner', taskId })).status, 'completed')
  } else {
    assert.equal(plan.stages.length, 2, JSON.stringify({ plan, owner: await execution.store.query({ kind: 'task.owner', taskId }),
      actions: await execution.store.query({ kind: 'task.owner.actions.pending', limit: 10 }) }))
    assert.equal(plan.stages[1].status, 'succeeded', JSON.stringify(plan))
    assert.equal(sends, 1)
    assert.equal(reads, 1)
    assert.equal(reports.some(report => report.reportType === 'complete'), true, JSON.stringify(reports))
    const echo = await service.ingest({ groupId: 'group', messageId: 'actual-file-message', senderOpenDingTalkId: 'owner', text: '[文件]报告.sql' })
    assert.equal(echo.processing, 'outbound-echo')
  }
  assert.ok(ownerCalls > 1)
})

test('真实产物写步骤输出经过发送三节点后满足服务完成门禁', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-integration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = createTaskArtifactFiles({ root })
  const adapter = createTaskArtifactWriteAdapter({ files })
  const capability = createGeneralArtifactWriteCapability({ fileAdapter: adapter })
  const workflow = createGeneralCapabilityStepWorkflow({ capabilities: [capability] })
  const binding = { taskId: 'task', runId: 'write', nodeRunId: 'write-node', generation: 0, requirementDigest: 'a'.repeat(64) }
  const writeOutput = await workflow.nodes[0].execute({ ...binding, input: { capabilityId: capability.id,
    input: { role: 'report', fileName: '报告.sql', content: '-- 测试产物\nSELECT 1;\n' },
    scope: { requirementRevision: 2, artifactFiles: fileDelivery.files }, expectedEvidence: '原文件字节核验' },
    perform: ({ prepared }) => adapter.execute(prepared) })
  assert.ok(writeOutput.output.result.artifact)
  const selected = selectTaskDeliveryFiles([writeOutput], scope)
  assert.equal(selected.length, 1)
  const deliveryWorkflow = createTaskGroupFileDeliveryWorkflow({ files, messageAdapter: { prepare: async ({ input }) => input } })
  const prepared = await deliveryWorkflow.nodes[0].execute({ taskId: 'task', input: { files: selected, ...scope } })
  const sent = await deliveryWorkflow.nodes[1].execute({ input: prepared, ...binding,
    perform: async ({ prepared }) => ({ status: 'succeeded', evidenceRef: 'message:real-message', result: {
      ...prepared.file, artifactId: prepared.file.artifactId, deliveryKey: 'b'.repeat(64), groupId: 'group', conversationId: 'group',
      profile: 'test', messageId: 'real-message', resourceRef: { type: 'fileId', resourceId: 'real-resource' } } }) })
  const output = await deliveryWorkflow.nodes[2].execute({ taskId: 'task', input: sent })
  assert.equal(verifyFileDeliveryOutput(output, scope), true)
  const view = describeTaskNodeOutput({ nodeId: 'verify-delivery' }, output)
  assert.match(view.overview, /1 个文件/u)
  assert.match(view.text, /报告.sql.*\nSHA-256/u)
  assert.match(view.text, /real-message/u)
  assert.ok(!view.text.includes(root))
  for (const field of [{ taskId: 'other' }, { requirementRevision: 3 }])
    assert.throws(() => selectTaskDeliveryFiles([writeOutput], { ...scope, ...field }), { code: 'TASK_REQUIRED_FILE_MISSING_OR_AMBIGUOUS' })
  assert.throws(() => selectTaskDeliveryFiles([writeOutput, writeOutput], scope), { code: 'TASK_REQUIRED_FILE_MISSING_OR_AMBIGUOUS' })
  for (const mutate of [o => o.receipts[0].status = 'unknown', o => o.receipts[0].result.sha256 = 'c'.repeat(64),
    o => o.receipts[0].result.size++, o => o.receipts[0].result.artifactId = 'c'.repeat(64),
    o => o.receipts[0].result.profile = 'other', o => o.receipts[0].result.conversationId = 'other',
    o => o.requirementRevision = 1, o => o.receipts.push(o.receipts[0]), o => o.files = [],
    o => delete o.receipts[0].evidenceRef, o => o.receipts[0].result.resourceRef = {}]) {
    const invalid = structuredClone(output); mutate(invalid)
    assert.equal(verifyFileDeliveryOutput(invalid, scope), false)
  }
})
