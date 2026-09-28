import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { createGeneralCapabilityStepWorkflow } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability,
  createTaskArtifactImportAdapter, createGeneralArtifactImportCapability } from '../packages/dingtalk-dsh-assistant/task-artifact-write.js'

const input = { role: 'migration-script', fileName: '数据库 迁移.sql', content: '-- 测试\r\nSELECT 1;\r\n' }
const scope = { requirementRevision: 1, artifactFiles: [{ role: input.role, fileName: input.fileName }] }
const binding = { taskId: 'task-1', runId: 'run-1', nodeRunId: 'node-1', generation: 0, requirementDigest: executionDigest('requirement') }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = createTaskArtifactFiles({ root: join(root, 'managed') })
  const adapter = createTaskArtifactWriteAdapter({ files })
  return { root, files, adapter, capability: createGeneralArtifactWriteCapability({ fileAdapter: adapter }) }
}

test('授权文本生成、登记及独立回读；结果不含内容，执行重复幂等', async t => {
  const { files, adapter, capability } = await fixture(t)
  assert.equal(capability.id, 'write-task-file')
  assert.equal(capability.action, 'artifact')
  assert.equal(await capability.authorize({ input, scope }), true)
  const prepared = adapter.prepare({ input, scope, binding })
  const output = await adapter.execute(prepared)
  assert.equal(output.status, 'succeeded')
  assert.equal(output.result.content, undefined)
  assert.equal(output.result.artifact.bytes, undefined)
  assert.equal(await readFile((await files.resolve(output.result.artifact)).path, 'utf8'), input.content)
  assert.deepEqual(await adapter.execute(prepared), output)
  assert.deepEqual(await adapter.reconcile(prepared), output)
  const verification = await capability.verify({ input, scope, prepared, output })
  assert.equal(verification.passed, true)
  assert.equal(verification.inputDigest, executionDigest({ capabilityId: capability.id, input, scope }))
  assert.equal(verification.outputDigest, executionDigest(output))
  assert.deepEqual(verification.sourceRefs, [output.evidenceRef])
})

test('缺文件对账只读，不生成目录或登记文件', async t => {
  const { root, adapter } = await fixture(t)
  const prepared = adapter.prepare({ input, scope, binding })
  assert.deepEqual(await adapter.reconcile(prepared), { status: 'failed', reason: 'TASK_ARTIFACT_WRITE_NOT_FOUND' })
  assert.deepEqual(await readdir(root), [])
})

test('精确角色/文件名/版本授权；路径、Office及图片、空白及超容量被拒绝', async t => {
  const { adapter, capability } = await fixture(t)
  const badRequests = [
    { input, scope: {} }, { input, scope: { ...scope, requirementRevision: 0 } },
    { input, scope: { ...scope, artifactFiles: [] } },
    { input: { ...input, role: 'other' }, scope },
    { input: { ...input, fileName: 'other.sql' }, scope },
    { input: { ...input, content: '   ' }, scope },
    { input: { ...input, content: '字'.repeat(65536) }, scope },
    { input: { ...input, extra: true }, scope },
  ]
  for (const fileName of ['../报告.sql', '报告.docx', '报告.png', 'CON.sql', 'descriptor.json']) {
    badRequests.push({ input: { ...input, fileName }, scope: { ...scope, artifactFiles: [{ role: input.role, fileName }] } })
  }
  for (const request of badRequests) {
    assert.equal(await capability.authorize(request), false)
    assert.throws(() => adapter.prepare({ ...request, binding }), { code: 'TASK_ARTIFACT_WRITE_SCOPE_DENIED' })
  }
})

test('所有支持的文本扩展及64KiB边界允许', async t => {
  const { adapter } = await fixture(t)
  for (const extension of ['md', 'txt', 'sql', 'csv', 'json']) {
    const fileName = `报告.${extension}`, item = { ...input, fileName, content: 'x'.repeat(65536) }
    const prepared = adapter.prepare({ input: item, scope: { ...scope, artifactFiles: [{ role: input.role, fileName }] }, binding })
    assert.equal((await adapter.execute(prepared)).result.artifact.size, 65536)
  }
})

test('版本与节点身份参与操作ID；prepared伪造、已写字节篡改不被认领', async t => {
  const { files, adapter, capability } = await fixture(t)
  const prepared = adapter.prepare({ input, scope, binding })
  assert.notEqual(adapter.prepare({ input, scope: { ...scope, requirementRevision: 2 }, binding }).operationId, prepared.operationId)
  assert.notEqual(adapter.prepare({ input, scope, binding: { ...binding, nodeRunId: 'node-2' } }).operationId, prepared.operationId)
  await assert.rejects(adapter.execute({ ...prepared, content: 'forged' }), { code: 'TASK_ARTIFACT_WRITE_PREPARED_INVALID' })
  const output = await adapter.execute(prepared)
  assert.equal((await capability.verify({ input, scope, prepared, output: { ...output, evidenceRef: 'forged' } })).passed, false)
  assert.equal((await capability.verify({ input, scope: { ...scope, requirementRevision: 2 }, prepared, output })).passed, false)
  await writeFile((await files.resolve(output.result.artifact)).path, 'changed')
  await assert.rejects(adapter.reconcile(prepared), { code: 'TASK_ARTIFACT_DIGEST_MISMATCH' })
})

async function importFixture(t) {
  const { root, files } = await fixture(t)
  const sourceRoot = join(root, 'source')
  await mkdir(sourceRoot)
  const bytes = Buffer.from([0, 255, 80, 75, 3, 4, 128]), relativePath = '已有 报告.docx'
  await writeFile(join(sourceRoot, relativePath), bytes)
  const fileAdapter = createTaskArtifactImportAdapter({ files, sourceRoot, readablePaths: [relativePath, '其他.pdf', 'junction/outside.png'] })
  const capability = createGeneralArtifactImportCapability({ fileAdapter })
  const request = { input: { role: 'report', fileName: '交付 报告.docx', relativePath },
    scope: { requirementRevision: 1, artifactFiles: [{ role: 'report', fileName: '交付 报告.docx' }], readableFiles: [relativePath] }, binding }
  return { root, files, sourceRoot, bytes, relativePath, fileAdapter, capability, request }
}

test('已有二进制导入由Host冻结摘要，prepare只读，登记后源删除不影响恢复', async t => {
  const { root, files, sourceRoot, bytes, relativePath, fileAdapter, capability, request } = await importFixture(t)
  assert.equal(await capability.authorize(request), true)
  const prepared = await fileAdapter.prepare(request)
  assert.equal(prepared.kind, 'import')
  assert.equal(prepared.artifact.size, bytes.length)
  assert.equal(prepared.content, undefined)
  assert.equal(prepared.bytes, undefined)
  assert.equal(prepared.artifact.bytes, undefined)
  assert.deepEqual(await readdir(root), ['source'])
  assert.equal((await fileAdapter.reconcile(prepared)).status, 'failed')
  assert.deepEqual(await readdir(root), ['source'])
  const output = await fileAdapter.execute(prepared)
  assert.deepEqual(await readFile((await files.resolve(output.result.artifact)).path), bytes)
  const workflow = createGeneralCapabilityStepWorkflow({ capabilities: [capability] })
  const stageOutput = await workflow.nodes[0].execute({ ...binding,
    input: { capabilityId: capability.id, input: request.input, scope: request.scope, expectedEvidence: '已有文件原字节登记与回读' },
    perform: async ({ action, prepared: stagePrepared }) => {
      assert.equal(action, 'artifact')
      assert.equal(stagePrepared.kind, 'import')
      return fileAdapter.execute(stagePrepared)
    } })
  assert.equal(stageOutput.verification.passed, true)
  assert.deepEqual(stageOutput.output, output)
  await unlink(join(sourceRoot, relativePath))
  assert.deepEqual(await fileAdapter.reconcile(prepared), output)
  assert.deepEqual(await fileAdapter.execute(prepared), output)
  assert.equal((await capability.verify({ ...request, prepared, output })).passed, true)
})

test('双重路径授权和角色名称精确授权；模型不能指定根、摘要或未批准文件', async t => {
  const { capability, request, fileAdapter } = await importFixture(t)
  const bad = [
    { ...request, input: { ...request.input, sourceRoot: 'D:/other' } },
    { ...request, input: { ...request.input, expectedSha256: 'a'.repeat(64) } },
    { ...request, input: { ...request.input, relativePath: '../outside.png' } },
    { ...request, input: { ...request.input, relativePath: '未登记.pdf' }, scope: { ...request.scope, readableFiles: ['未登记.pdf'] } },
    { ...request, scope: { ...request.scope, readableFiles: [] } },
    { ...request, scope: { ...request.scope, artifactFiles: [] } },
    { ...request, scope: { ...request.scope, requirementRevision: 0 } },
    { ...request, input: { ...request.input, fileName: '其他.docx' } },
    { ...request, input: { ...request.input, fileName: '假图片.png' },
      scope: { ...request.scope, artifactFiles: [{ role: 'report', fileName: '假图片.png' }] } },
  ]
  for (const item of bad) {
    assert.equal(await capability.authorize(item), false)
    await assert.rejects(fileAdapter.prepare(item), { code: 'TASK_ARTIFACT_IMPORT_SCOPE_DENIED' })
  }
})

test('prepare后源字节变化不登记，junction拒绝，prepared伪造拒绝', async t => {
  const { root, sourceRoot, relativePath, fileAdapter, request } = await importFixture(t)
  const prepared = await fileAdapter.prepare(request)
  await assert.rejects(fileAdapter.execute({ ...prepared, sourceRoot: root }), { code: 'TASK_ARTIFACT_IMPORT_PREPARED_INVALID' })
  await writeFile(join(sourceRoot, relativePath), 'changed')
  await assert.rejects(fileAdapter.execute(prepared), { code: 'TASK_ARTIFACT_SOURCE_DIGEST_MISMATCH' })
  assert.deepEqual(await readdir(root), ['source'])
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'outside.png'), Buffer.from([0, 255]))
  await symlink(outside, join(sourceRoot, 'junction'), 'junction')
  await assert.rejects(fileAdapter.prepare({ ...request, input: { ...request.input, fileName: '已有图.png', relativePath: 'junction/outside.png' },
    scope: { ...request.scope, artifactFiles: [{ role: 'report', fileName: '已有图.png' }], readableFiles: ['junction/outside.png'] } }), { code: 'TASK_ARTIFACT_SCOPE_DENIED' })
})
