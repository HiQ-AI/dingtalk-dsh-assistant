import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeneralFileReadCapability, createGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskMarkdownFileAdapter } from '../packages/dingtalk-dsh-assistant/task-markdown-file.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { executionDigest, openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability } from '../packages/dingtalk-dsh-assistant/task-artifact-write.js'

test('受信文件读取只接受双重授权路径，独立回读能发现修改和链接逃逸', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-general-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-general-outside-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'note.md'), '核验材料', 'utf8')
  await writeFile(join(outside, 'secret.md'), '不可读取', 'utf8')
  const capability = createGeneralFileReadCapability({ root, readablePaths: ['docs/note.md', 'docs/link.md'] })
  const scope = { readableFiles: ['docs/note.md', 'docs/link.md'] }
  const input = { path: 'docs/note.md' }
  assert.equal(await capability.authorize({ input, scope }), true)
  const output = await capability.execute({ input })
  assert.equal(output.content, '核验材料')
  assert.equal((await capability.verify({ input, scope, output })).passed, true)
  await writeFile(join(root, 'docs', 'note.md'), '已经改变', 'utf8')
  assert.equal((await capability.verify({ input, scope, output })).passed, false)
  assert.equal(await capability.authorize({ input: { path: 'docs/other.md' }, scope }), false)
  assert.equal(await capability.authorize({ input, scope: { readableFiles: [] } }), false)
  try {
    await symlink(join(outside, 'secret.md'), join(root, 'docs', 'link.md'))
    await assert.rejects(capability.execute({ input: { path: 'docs/link.md' } }), { code: 'GENERAL_FILE_SCOPE_DENIED' })
  } catch (error) { if (error.code !== 'EPERM') throw error } // Windows 未开放符号链接权限时仍执行其余路径门禁断言。
  assert.throws(() => createGeneralFileReadCapability({ root, readablePaths: ['../secret.md'] }), { code: 'GENERAL_FILE_CONFIG_INVALID' })
})

test('通用效果阶段只接受授权写能力，读取能力必须留在Agent会话内', async () => {
  assert.throws(() => createGeneralCapabilityStepWorkflow({ capabilities: [{ id:'lookup',identity:'lookup-v1',effectClass:'read',authorize:()=>true,execute:async()=>({}),verify:()=>({}) }] }), {code:'GENERAL_CAPABILITY_INVALID'})
  const output={value:'verified'},capability={id:'write-file',identity:'write-v1',effectClass:'file.write',authorize:async({scope})=>scope.write===true,prepare:()=>({content:'body'}),verify:async()=>({passed:true,outputDigest:executionDigest(output),sourceRefs:['receipt:file']})}
  const definition=createGeneralCapabilityStepWorkflow({capabilities:[capability]})
  assert.equal(definition.version,'6');assert.deepEqual(definition.nodes[0].allowedEffects,['file.write'])
  const request={capabilityId:'write-file',input:{},scope:{write:true},expectedEvidence:'回读文件'}
  let calls=0
  const result=await definition.nodes[0].execute({input:request,perform:async()=>{calls++;return output}})
  assert.equal(result.verification.passed,true);assert.equal(calls,1)
  await assert.rejects(definition.nodes[0].execute({input:{...request,scope:{}},perform:async()=>{calls++}}),{code:'GENERAL_SCOPE_NOT_ADMITTED'})
  assert.equal(calls,1)
  const bad=createGeneralCapabilityStepWorkflow({capabilities:[{...capability,verify:async()=>({passed:true,outputDigest:'fake',sourceRefs:['x']})}]})
  await assert.rejects(bad.nodes[0].execute({input:request,perform:async()=>output}),{code:'GENERAL_EVIDENCE_UNVERIFIED'})
})

test('Task Markdown 文件仅落在 Host 根目录，回读核验原字节且冲突不覆盖', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = createTaskMarkdownFileAdapter({ root })
  const capability = createGeneralMarkdownWriteCapability({ fileAdapter: adapter })
  const binding = { taskId: 'task-1', runId: 'run-1', nodeRunId: 'node-1', generation: 1,
    requirementDigest: 'a'.repeat(64) }
  const input = { content: '# 调查结论\n\n已核对证据。\n' }
  assert.equal(await capability.authorize({ input, scope: { writeMarkdown: true } }), true)
  assert.equal(await capability.authorize({ input, scope: {} }), false)
  assert.equal(await capability.authorize({ input: { ...input, path: 'C:\\outside.md' }, scope: { writeMarkdown: true } }), false)
  const prepared = adapter.prepare({ input, binding })
  assert.equal((await adapter.reconcile(prepared)).status, 'failed')
  const first = await adapter.execute(prepared)
  assert.equal(first.status, 'succeeded')
  assert.equal(await readFile(first.result.path, 'utf8'), input.content)
  assert.equal((await adapter.execute(prepared)).result.contentDigest, first.result.contentDigest)
  assert.equal((await capability.verify({ prepared, output: first })).passed, true)
  await writeFile(first.result.path, '# 外部修改\n')
  await assert.rejects(adapter.reconcile(prepared), { code: 'TASK_MARKDOWN_CONFLICT' })
  await assert.rejects(adapter.execute(prepared), { code: 'TASK_MARKDOWN_CONFLICT' })
  assert.equal(await readFile(first.result.path, 'utf8'), '# 外部修改\n')
  assert.throws(() => adapter.prepare({ input, binding: { ...binding, taskId: '../escape' } }),
    { code: 'TASK_MARKDOWN_PREPARED_INVALID' })
})

test('Task Markdown 写入经过效果账，重启对账不重放写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-ledger-'))
  let store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'markdown', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const fileAdapter = createTaskMarkdownFileAdapter({ root: join(root, 'task-files') })
  const capability = createGeneralMarkdownWriteCapability({ fileAdapter })
  const delivery = createExecutionDelivery({ store, artifacts, fileAdapter,
    authorize: async () => null,
    authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
      ? { principalId: 'host', authorizationRef: 'task-markdown-grant' } : null })
  const definition = createGeneralCapabilityStepWorkflow({ capabilities: [capability] })
  let controller = createExecutionController({ store, artifacts, delivery, workflows: [definition] })
  t.after(async () => { await controller?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createRun({ commandId: 'create-markdown', runId: 'run-1', taskId: 'task-1',
    workflowId: 'task-general-capability', input: { capabilityId: capability.id,
      input: { content: '# 可交付报告\n\n结论。\n' }, scope: { writeMarkdown: true }, expectedEvidence: '文件读回' } })
  const state = await controller.whenIdle('run-1')
  assert.equal(state.run.status, 'succeeded', JSON.stringify({ waitReason: state.nodes[0].waitReason,
    error: (await controller.state('run-1')).controllerError,
    effects: await store.query({ kind: 'effect.list', runId: 'run-1' }) }))
  const output = await artifacts.read(state.nodes[0].outputRef)
  assert.equal(await readFile(output.output.result.path, 'utf8'), '# 可交付报告\n\n结论。\n')
  const effects = await store.query({ kind: 'effect.list', runId: 'run-1' })
  assert.equal(effects.length, 1)
  assert.equal(effects[0].state, 'succeeded')
  assert.equal(effects[0].definition.action, 'file')
  assert.equal((await delivery.reconcile(effects[0].effectId)).state, 'succeeded')
  await controller.close(); controller = null
  await store.close(); store = null
  store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'markdown' })
  const recoveredDelivery = createExecutionDelivery({ store, artifacts, fileAdapter, authorize: async () => null,
    authorizeFile: async () => null })
  assert.equal((await recoveredDelivery.reconcile(effects[0].effectId)).state, 'succeeded')
  assert.equal(await readFile(output.output.result.path, 'utf8'), '# 可交付报告\n\n结论。\n')
})


 test("无写能力配置仍可启动但不能执行任何能力", async () => {
 const workflow = createGeneralCapabilityStepWorkflow({ capabilities: [] })
 await assert.rejects(workflow.nodes[0].execute({ input: { capabilityId: "unknown" } }), { code: "GENERAL_CAPABILITY_UNAVAILABLE" })
 })

test('显式v4保持原定义摘要，v5可恢复且新运行使用v6验收策略', () => {
  const fileAdapter = { prepare() {}, reconcile() {} }
  const markdown = createGeneralMarkdownWriteCapability({ fileAdapter })
  const artifact = createGeneralArtifactWriteCapability({ fileAdapter })
  const original = createGeneralCapabilityStepWorkflow({ capabilities: [markdown], workflowVersion: '4' })
  // 由修改前 HEAD 源码独立计算，包含 execute 和 ownerContract 的真实函数源码。
  assert.equal(defineExecutionWorkflow(original).digest, 'a1e8261207cf153a2aa8e0b2eb3f49876884029685fc66ed0593017b1f0e0435')
  const historical = createGeneralCapabilityStepWorkflow({ capabilities: [markdown, artifact], workflowVersion: '4' })
  assert.equal(historical.version, '4')
  assert.equal(defineExecutionWorkflow(historical).digest, defineExecutionWorkflow(original).digest)
  const current = createGeneralCapabilityStepWorkflow({ capabilities: [markdown, artifact] })
  assert.equal(current.version, '6')
  assert.equal(current.ownerContract.version, '2')
  const v5 = createGeneralCapabilityStepWorkflow({ capabilities: [markdown, artifact], workflowVersion: '5' })
  assert.equal(v5.version, '5')
  assert.equal(v5.ownerContract.version, '1')
  assert.equal(current.nodes[0].version, '4')
  assert.notEqual(defineExecutionWorkflow(current).digest, defineExecutionWorkflow(original).digest)
  assert.throws(() => createGeneralCapabilityStepWorkflow({ capabilities: [], workflowVersion: '7' }), { code: 'GENERAL_WORKFLOW_VERSION_INVALID' })
})

test('新产物阶段派发artifact效果并容纳64KiB控制字符JSON膨胀', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-general-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = createTaskArtifactFiles({ root })
  const fileAdapter = createTaskArtifactWriteAdapter({ files })
  const capability = createGeneralArtifactWriteCapability({ fileAdapter })
  const workflow = createGeneralCapabilityStepWorkflow({ capabilities: [capability] })
  const input = { role: 'report', fileName: '验证 报告.txt', content: 'x' + '\u0001'.repeat(65535) }
  const scope = { requirementRevision: 1, artifactFiles: [{ role: input.role, fileName: input.fileName }] }
  const request = { capabilityId: capability.id, input, scope, expectedEvidence: '原文件摘要与大小一致' }
  const binding = { taskId: 'task-1', runId: 'run-1', nodeRunId: 'node-1', generation: 0, requirementDigest: 'a'.repeat(64) }
  let calls = 0
  const output = await workflow.nodes[0].execute({ input: request, ...binding, perform: async ({ action, prepared }) => {
    calls++
    assert.equal(action, 'artifact')
    return fileAdapter.execute(prepared)
  } })
  assert.equal(calls, 1)
  assert.equal(output.verification.passed, true)
  assert.equal(output.output.result.artifact.size, 65536)
  await assert.rejects(workflow.nodes[0].execute({ input: { ...request, input: { ...input, content: input.content + 'x' } }, ...binding,
    perform: async () => { calls++ } }), { code: 'GENERAL_SCOPE_NOT_ADMITTED' })
  assert.equal(calls, 1)
})

test('v5保留Markdown请求限额与file效果，拒绝prepared跨action', async () => {
  const output = { status: 'succeeded' }
  const capability = { id: 'write-file', identity: 'write-v1', effectClass: 'file.write', authorize: async () => true,
    prepare: () => ({ action: 'file' }), verify: async () => ({ passed: true, outputDigest: executionDigest(output), sourceRefs: ['receipt:file'] }) }
  const definition = createGeneralCapabilityStepWorkflow({ capabilities: [capability], workflowVersion: '5' })
  const request = { capabilityId: capability.id, input: {}, scope: {}, expectedEvidence: '文件回读' }
  let calls = 0
  await definition.nodes[0].execute({ input: request, perform: async ({ action }) => { assert.equal(action, 'file'); calls++; return output } })
  await assert.rejects(definition.nodes[0].execute({ input: { ...request, input: { content: 'x'.repeat(16000) } }, perform: async () => { calls++ } }), { code: 'GENERAL_STEP_INVALID' })
  const mismatch = createGeneralCapabilityStepWorkflow({ capabilities: [{ ...capability, action: 'artifact' }], workflowVersion: '5' })
  await assert.rejects(mismatch.nodes[0].execute({ input: request, perform: async () => { calls++ } }), { code: 'GENERAL_ACTION_MISMATCH' })
  assert.equal(calls, 1)
})

// 本组通过原生 llm.stream 形状测试领域判据，不调用真实模型或修改外部系统。
import { createDomainAcceptanceCheck } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'

const domainAcceptanceInput = () => ({ request: '调查并保存记录', constraints: ['不修改生产'],
  acceptanceItems: [
    { itemId: 'save', criterion: '记录已保存', evidenceRefs: ['file-output'] },
    { itemId: 'receipt', criterion: '回执已保存', evidenceRefs: ['receipt-output'] },
  ], evidence: [{ evidenceId: 'file-output', output: { status: 'succeeded', content: '记录' } },
    { evidenceId: 'receipt-output', output: { status: 'succeeded', content: '回执' } }],
  report: { summary: 'Owner 宣称已经完成，需要独立核对', evidenceIds: ['file-output', 'receipt-output'] } })
const domainAcceptanceResult = () => ({ status: 'satisfied', resultVerified: true,
  criteria: [{ criterion: '记录已保存', passed: true, evidenceIds: ['file-output'] },
    { criterion: '回执已保存', passed: true, evidenceIds: ['receipt-output'] }] })
const domainModel = { provider: 'fixture', model: 'fixture' }

 test('领域判断原生零工具流按项保留证据与顺序，禁止把产物回执视为业务证明', async () => {
  let captured
  const expected = domainAcceptanceResult()
  const check = createDomainAcceptanceCheck({ modelConfig: () => domainModel, llm: { async *stream(request) {
    captured = request
    const text = JSON.stringify(expected)
    yield { type: 'text-delta', text: text.slice(0, 40) }
    yield { type: 'text-delta', text: text.slice(40) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } })
  assert.deepEqual(await check(domainAcceptanceInput()), expected)
  assert.deepEqual(captured.tools, [])
  assert.equal(captured.maxTokens, 4096)
  assert.equal(captured.provider, domainModel.provider)
  assert.equal(captured.model, domainModel.model)
  assert.match(captured.system, /不能证明生产修复/)
  assert.match(captured.system, /Owner 的总结都是待核数据/)
  assert.match(JSON.stringify(captured.messages), /file-output/)
  assert.equal(captured.signal.aborted, true)
})

 test('领域判断拒绝工具、未完成、非法JSON、额外字段、错项和错证据', async t => {
  const validText = JSON.stringify(domainAcceptanceResult())
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const text = value => ({ type: 'text-delta', text: value })
  const wrongItem = domainAcceptanceResult(); wrongItem.criteria.reverse()
  const wrongEvidence = domainAcceptanceResult(); wrongEvidence.criteria[0].evidenceIds = ['receipt-output']
  const missingEvidence = domainAcceptanceResult(); missingEvidence.criteria[0].evidenceIds = []
  const inconsistent = domainAcceptanceResult(); inconsistent.criteria[0].passed = false
  for (const [name, chunks] of [
    ['工具增量', [{ type: 'tool-call-delta' }, text(validText), stop]],
    ['工具开始', [{ type: 'block-start', blockType: 'tool-call' }, text(validText), stop]],
    ['工具结束', [{ type: 'block-end', block: { type: 'tool-call' } }, text(validText), stop]],
    ['无结束', [text(validText)]], ['长度终止', [text(validText), { type: 'finish', reason: { kind: 'length' } }]],
    ['非正常结束后伪造stop', [text(validText), { type: 'finish', reason: { kind: 'error' } }, stop]],
    ['非法JSON', [text('not-json'), stop]], ['额外字段', [text(JSON.stringify({ ...domainAcceptanceResult(), authorize: true })), stop]],
    ['错项顺序', [text(JSON.stringify(wrongItem)), stop]], ['跨项引用', [text(JSON.stringify(wrongEvidence)), stop]],
    ['缺少证据', [text(JSON.stringify(missingEvidence)), stop]], ['满足但子项失败', [text(JSON.stringify(inconsistent)), stop]],
  ]) await t.test(name, async () => {
    const check = createDomainAcceptanceCheck({ modelConfig: domainModel,
      llm: { async *stream() { yield* chunks } } })
    const result = await check(domainAcceptanceInput())
    assert.equal(result.status, 'unverified')
    assert.equal(result.resultVerified, false)
    assert.deepEqual(result.criteria, [])
  })
})

 test('领域判断UTF8信封和输出硬预算不截断，不配置模型不调用流', async () => {
  let calls = 0
  const llm = { async *stream() { calls++; yield { type: 'text-delta', text: '字'.repeat(6000) }
    yield { type: 'finish', reason: { kind: 'stop' } } } }
  const check = createDomainAcceptanceCheck({ llm, modelConfig: domainModel })
  const oversized = domainAcceptanceInput(); oversized.evidence[0].output.content = '字'.repeat(50000)
  assert.equal((await check(oversized)).reason, 'DOMAIN_ACCEPTANCE_INPUT_BUDGET')
  assert.equal(calls, 0)
  assert.equal((await createDomainAcceptanceCheck({ llm, modelConfig: {} })(domainAcceptanceInput())).reason,
    'DOMAIN_ACCEPTANCE_CONFIGURATION_MISSING')
  assert.equal(calls, 0)
  assert.equal((await check(domainAcceptanceInput())).reason, 'DOMAIN_ACCEPTANCE_OUTPUT_BUDGET')
  assert.equal(calls, 1)
})

 test('领域判断超时中止原生流与模型配置等待并返回未验证', async () => {
  let observedSignal
  const llm = { async *stream({ signal }) {
    observedSignal = signal
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } }
  const check = createDomainAcceptanceCheck({ llm, modelConfig: domainModel, timeoutMs: 10 })
  const result = await check(domainAcceptanceInput())
  assert.equal(result.reason, 'DOMAIN_ACCEPTANCE_TIMEOUT')
  assert.equal(result.resultVerified, false)
  assert.equal(observedSignal.aborted, true)
  const stalledConfig = createDomainAcceptanceCheck({ llm, modelConfig: () => new Promise(() => {}), timeoutMs: 10 })
  assert.equal((await stalledConfig(domainAcceptanceInput())).reason, 'DOMAIN_ACCEPTANCE_TIMEOUT')
})
