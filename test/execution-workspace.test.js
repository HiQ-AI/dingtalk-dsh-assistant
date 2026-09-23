import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, unlink, readdir, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'

const exec = promisify(execFile)
const git = async (directory, ...args) => (await exec('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim()
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-managed-workspace-')), root = join(directory, 'managed'), sourceRepository = join(directory, 'source')
  await mkdir(root); await mkdir(sourceRepository)
  await git(sourceRepository, 'init', '-b', 'main'); await git(sourceRepository, 'config', 'user.name', 'Synthetic'); await git(sourceRepository, 'config', 'user.email', 'synthetic@example.invalid')
  await writeFile(join(sourceRepository, 'value.txt'), 'base\n'); await writeFile(join(sourceRepository, 'deleted.txt'), 'keep base\n')
  await git(sourceRepository, 'add', '.'); await git(sourceRepository, 'commit', '-m', 'base')
  const baseCommit = await git(sourceRepository, 'rev-parse', 'HEAD'), adapter = await createManagedWorkspaces({ root, sourceRepository })
  const input = { runId: 'run-synthetic', generation: 1, requirementDigest: 'a'.repeat(64), baseCommit }
  return { directory, root, sourceRepository, adapter, input }
}
test('受管代际只取固定base，不带源未提交文件；旧代删除与用户变更不污染新代', async () => {
  const f = await setup()
  await writeFile(join(f.sourceRepository, 'value.txt'), 'source user edit\n'); await writeFile(join(f.sourceRepository, 'private.txt'), 'untracked\n')
  const index = await readFile(join(f.sourceRepository, '.git', 'index'))
  const first = await f.adapter.prepare(f.input)
  assert.ok(Object.isFrozen(first)); assert.deepEqual(await readdir(f.root), [])
  assert.equal((await f.adapter.execute(first)).status, 'succeeded')
  await unlink(join(first.directory, 'deleted.txt')); await writeFile(join(first.directory, 'value.txt'), 'old user edit\n'); await writeFile(join(first.directory, 'old.txt'), 'old\n')
  assert.equal((await f.adapter.reconcile(first)).status, 'succeeded')
  assert.equal(await readFile(join(first.directory, 'value.txt'), 'utf8'), 'old user edit\n')
  const second = await f.adapter.prepare({ ...f.input, generation: 2, requirementDigest: 'b'.repeat(64) })
  await f.adapter.execute(second)
  assert.notEqual(second.directory, first.directory)
  assert.equal(await readFile(join(second.directory, 'deleted.txt'), 'utf8'), 'keep base\n')
  assert.equal(await readFile(join(second.directory, 'value.txt'), 'utf8'), 'base\n')
  await assert.rejects(readFile(join(second.directory, 'old.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(second.directory, 'private.txt')), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(f.sourceRepository, '.git', 'index')), index)
  assert.equal(await git(f.sourceRepository, 'rev-parse', 'HEAD'), f.input.baseCommit)
  assert.equal(await readFile(join(f.sourceRepository, 'value.txt'), 'utf8'), 'source user edit\n')
})
test('同一目录并发只允许一个执行者，重复只能对账；残缺目录不覆盖', async () => {
  const f = await setup(), prepared = await f.adapter.prepare(f.input)
  const results = await Promise.allSettled([f.adapter.execute(prepared), f.adapter.execute(prepared)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EEXIST')
  const next = await f.adapter.prepare({ ...f.input, generation: 2 })
  await mkdir(dirname(next.directory)); await writeFile(join(dirname(next.directory), 'evidence.txt'), 'preserve')
  assert.equal((await f.adapter.reconcile(next)).status, 'unknown')
  await assert.rejects(f.adapter.execute(next), { code: 'EEXIST' })
  assert.equal(await readFile(join(dirname(next.directory), 'evidence.txt'), 'utf8'), 'preserve')
})
test('身份或真实HEAD冲突明确拒绝，不能伪装恢复成功', async () => {
  const f = await setup(), prepared = await f.adapter.prepare(f.input)
  await f.adapter.execute(prepared)
  await writeFile(join(dirname(prepared.directory), 'metadata.json'), '{}')
  await assert.rejects(f.adapter.reconcile(prepared), { code: 'WORKSPACE_IDENTITY_CONFLICT' })
  await writeFile(join(dirname(prepared.directory), 'metadata.json'), JSON.stringify(prepared))
  await git(prepared.directory, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'foreign')
  await assert.rejects(f.adapter.reconcile(prepared), { code: 'WORKSPACE_BASE_CONFLICT' })
})
test('源hook/filter与链接目录不准入；prepare也不会修改源index', async () => {
  const f = await setup(), index = await readFile(join(f.sourceRepository, '.git', 'index'))
  await git(f.sourceRepository, 'config', 'filter.bad.smudge', 'invalid-tool')
  await assert.rejects(f.adapter.prepare(f.input), { code: 'WORKSPACE_UNSUPPORTED_CONFIG' })
  await git(f.sourceRepository, 'config', '--unset', 'filter.bad.smudge')
  await writeFile(join(f.sourceRepository, '.git', 'hooks', 'post-checkout'), 'invalid-tool')
  await assert.rejects(f.adapter.prepare(f.input), { code: 'WORKSPACE_HOOKS_UNSUPPORTED' })
  const linked = join(f.directory, 'linked'); await symlink(f.root, linked, 'junction')
  await assert.rejects(createManagedWorkspaces({ root: linked, sourceRepository: f.sourceRepository }), { code: 'WORKSPACE_LINK_UNSUPPORTED' })
  assert.deepEqual(await readFile(join(f.sourceRepository, '.git', 'index')), index)
})
test('base tree的symlink/gitlink在任何目的写入之前拒绝', async () => {
  const f = await setup()
  await git(f.sourceRepository, 'update-index', '--add', '--cacheinfo', `160000,${f.input.baseCommit},submodule`)
  await git(f.sourceRepository, 'commit', '-m', 'unsupported gitlink')
  const baseCommit = await git(f.sourceRepository, 'rev-parse', 'HEAD')
  await assert.rejects(f.adapter.prepare({ ...f.input, baseCommit }), { code: 'WORKSPACE_ENTRY_UNSUPPORTED' })
  assert.deepEqual(await readdir(f.root), [])
})
