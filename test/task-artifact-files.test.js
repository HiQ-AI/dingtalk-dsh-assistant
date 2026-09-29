import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const input = (bytes = Buffer.from('报告\r\n'), fileName = '处理 报告.md') => ({
  taskId: 'task-1', requirementRevision: 1, producer: { runId: 'run-1', nodeRunId: 'node-1', outputRef: 'sha256-output.json' },
  role: 'report', fileName, bytes })
async function fixture(t, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-artifact-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, files: createTaskArtifactFiles({ root: join(root, 'managed'), ...limits }) }
}

test('保留中文名称及原始文本/二进制，重复登记幂等，同名不同内容隔离', async t => {
  const { files } = await fixture(t)
  const source = input(), first = await files.register(source)
  source.bytes.fill(0)
  const resolved = await files.resolve(first)
  assert.deepEqual(await readFile(resolved.path), Buffer.from('报告\r\n'))
  assert.equal(resolved.fileName, '处理 报告.md')
  assert.equal(first.bytes, undefined)
  assert.deepEqual(await files.register(input()), first)
  const changed = await files.register(input(Buffer.from('其他')))
  assert.notEqual(changed.artifactId, first.artifactId)
  const binary = Buffer.from([0, 255, 0, 128, 10])
  const picture = await files.register(input(binary, '测试.png'))
  assert.deepEqual(await readFile((await files.resolve(picture)).path), binary)
  assert.equal(picture.mediaType, 'image/png')
})

test('清单绑定任务版本，拒绝重复、超数量和总大小', async t => {
  const { files } = await fixture(t, { maxFileBytes: 10, maxBatchBytes: 6, maxFiles: 2 })
  const first = await files.register(input(Buffer.from('1234')))
  const second = await files.register(input(Buffer.from('5678'), '其他.sql'))
  assert.deepEqual(await files.validateManifest([first], { taskId: 'task-1', requirementRevision: 1 }), [first])
  await assert.rejects(files.validateManifest([first], { taskId: 'task-2', requirementRevision: 1 }), { code: 'TASK_ARTIFACT_MANIFEST_SCOPE_DENIED' })
  await assert.rejects(files.validateManifest([first], { taskId: 'task-1', requirementRevision: 2 }), { code: 'TASK_ARTIFACT_MANIFEST_SCOPE_DENIED' })
  await assert.rejects(files.validateManifest([first, first], { taskId: 'task-1', requirementRevision: 1 }), { code: 'TASK_ARTIFACT_MANIFEST_DUPLICATE' })
  await assert.rejects(files.validateManifest([first, second], { taskId: 'task-1', requirementRevision: 1 }), { code: 'TASK_ARTIFACT_CAPACITY_EXCEEDED' })
  await assert.rejects(files.validateManifest([first, second, first], { taskId: 'task-1', requirementRevision: 1 }), { code: 'TASK_ARTIFACT_MANIFEST_INVALID' })
  await assert.rejects(files.register(input(Buffer.alloc(11))), { code: 'TASK_ARTIFACT_CAPACITY_EXCEEDED' })
})

test('拒绝路径、控制字符、Windows保留名及伪造元数据', async t => {
  const { files } = await fixture(t)
  for (const name of ['../report.md', 'a\\b.sql', 'CON.sql', 'lpt1.png', 'COM¹.txt', 'bad\u0000.txt', 'trailing.', 'x:sql', 'descriptor.json']) {
    await assert.rejects(files.register(input(Buffer.from('x'), name)), { code: 'TASK_ARTIFACT_INPUT_INVALID' })
  }
  const file = await files.register(input())
  await assert.rejects(files.resolve({ ...file, role: 'other' }), { code: 'TASK_ARTIFACT_DESCRIPTOR_MISMATCH' })
  await assert.rejects(files.resolve({ ...file, fileRef: 'arbitrary' }), { code: 'TASK_ARTIFACT_DESCRIPTOR_MISMATCH' })
  await writeFile((await files.resolve(file)).path, 'changed')
  await assert.rejects(files.resolve(file), { code: 'TASK_ARTIFACT_DIGEST_MISMATCH' })
  await assert.rejects(files.register(input()))
})

test('授权根导入复制实际文件，源变化不改变快照，摘要及穿越失败', async t => {
  const { root, files } = await fixture(t)
  const sourceRoot = join(root, 'source')
  await mkdir(sourceRoot)
  const bytes = Buffer.from([0, 255, 32]), source = join(sourceRoot, '授权.png')
  await writeFile(source, bytes)
  const request = { ...input(undefined, '授权.png'), sourceRoot, relativePath: '授权.png', expectedSha256: digest(bytes) }
  const file = await files.importFile(request)
  await writeFile(source, 'later')
  assert.deepEqual(await readFile((await files.resolve(file)).path), bytes)
  await assert.rejects(files.importFile(request), { code: 'TASK_ARTIFACT_SOURCE_DIGEST_MISMATCH' })
  await assert.rejects(files.importFile({ ...request, relativePath: '../授权.png' }), { code: 'TASK_ARTIFACT_SOURCE_INVALID' })
  await assert.rejects(files.importFile({ ...request, relativePath: source }), { code: 'TASK_ARTIFACT_SOURCE_INVALID' })
})

test('拒绝导入和受管目录的链接/junction逃逸', async t => {
  const { root, files } = await fixture(t)
  const outside = join(root, 'outside'), sourceRoot = join(root, 'source')
  await mkdir(outside); await mkdir(sourceRoot)
  await writeFile(join(outside, 'escape.sql'), 'sql')
  await symlink(outside, join(sourceRoot, 'junction'), 'junction')
  await assert.rejects(files.importFile({ ...input(Buffer.from('sql'), 'escape.sql'), sourceRoot,
    relativePath: 'junction/escape.sql', expectedSha256: digest(Buffer.from('sql')) }), { code: 'TASK_ARTIFACT_SCOPE_DENIED' })
  await mkdir(join(root, 'managed'))
  await symlink(outside, join(root, 'managed', 'task-1'), 'junction')
  await assert.rejects(files.register(input()), { code: 'TASK_ARTIFACT_SCOPE_DENIED' })
})

test('并发重复登记不覆盖且均可独立回读', async t => {
  const { files } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 4 }, () => files.register(input())))
  for (const file of results) assert.deepEqual(file, results[0])
  await files.resolve(results[0])
})

test('任务交付目录按受信任务布局选择，重启回读、旧任务保留且新目录缺文件不回退', async t => {
  const { root, files: legacy } = await fixture(t)
  const oldFile = await legacy.register(input())
  const outputs = join(root, 'tasks', 'family-1', 'outputs')
  const getTaskDirectories = async taskId => taskId === 'task-1' ? null : { outputs }
  const create = () => createTaskArtifactFiles({ root: join(root, 'managed'), getTaskDirectories })
  const files = create()
  assert.deepEqual(await readFile((await files.resolve(oldFile)).path), input().bytes)
  const newInput = { ...input(), taskId: 'task-2' }
  // 旧位置存在同身份文件也不允许掩盖新位置缺失。
  const shadow = await legacy.register(newInput)
  await assert.rejects(files.resolve(shadow), { code: 'ENOENT' })
  const current = await files.register(newInput)
  assert.equal((await create().resolve(current)).path, join(outputs, 'task-2', current.artifactId, current.fileName))
  const rerun = await files.register({ ...newInput, taskId: 'task-3' })
  assert.notEqual((await files.resolve(rerun)).path, (await files.resolve(current)).path)
  const broken = createTaskArtifactFiles({ root: join(root, 'managed'), getTaskDirectories: async () => { throw new Error('lookup failed') } })
  await assert.rejects(broken.resolve(oldFile), /lookup failed/)
})

test('任务输出根拒绝相对目录和祖先 junction', async t => {
  const { root } = await fixture(t)
  const invalid = createTaskArtifactFiles({ root, getTaskDirectories: async () => ({ outputs: '../escape' }) })
  await assert.rejects(invalid.register(input()), { code: 'TASK_ARTIFACT_CONFIG_INVALID' })
  const outside = join(root, 'outside'), link = join(root, 'link')
  await mkdir(outside)
  await symlink(outside, link, 'junction')
  const linked = createTaskArtifactFiles({ root, getTaskDirectories: async () => ({ outputs: join(link, 'outputs') }) })
  await assert.rejects(linked.register(input()), { code: 'TASK_ARTIFACT_SCOPE_DENIED' })
})
