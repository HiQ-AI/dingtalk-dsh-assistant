import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { archiveTaskWorktree, inspectTaskWorktree } from '../packages/dingtalk-dsh-assistant/task-worktree-archive.js'

const exec = promisify(execFile)
async function git(cwd, ...args) { return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim() }

async function fixture(t) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'dsh-worktree-archive-'))
  const primary = path.join(workspaceDir, 'primary')
  const remote = path.join(workspaceDir, 'remote.git')
  const location = path.join(workspaceDir, 'worktrees', 'feature')
  await mkdir(primary)
  await mkdir(path.dirname(location))
  await git(workspaceDir, 'init', '--bare', remote)
  await git(primary, 'init')
  await git(primary, 'config', 'user.name', 'Test')
  await git(primary, 'config', 'user.email', 'test@example.test')
  await writeFile(path.join(primary, 'README.md'), 'base\n')
  await git(primary, 'add', '.')
  await git(primary, 'commit', '-m', 'base')
  await git(primary, 'remote', 'add', 'origin', remote)
  await git(primary, 'push', '-u', 'origin', 'HEAD:refs/heads/main')
  await git(primary, 'worktree', 'add', '-b', 'feature', location)
  await git(location, 'push', '-u', 'origin', 'feature')
  t.after(async () => { await rm(workspaceDir, { recursive: true, force: true }) })
  return { workspaceDir, primary, location }
}

test('copies registered documents with matching digest then removes only linked worktree', async (t) => {
  const { workspaceDir, primary, location } = await fixture(t)
  const file = path.join(location, 'docs', 'spec', 'plan.md')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '方案\n')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source: 'docs/spec/plan.md' }] }
  const progress = []
  const checked = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true })
  assert.equal(checked.documents.length, 1)
  assert.equal((await lstat(location)).isDirectory(), true)
  const result = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, onProgress: async (value) => progress.push(value) })
  assert.equal(result.status, 'cleaned')
  assert.equal(progress.length, 2)
  assert.equal(await readFile(result.documents[0].archivePath, 'utf8'), '方案\n')
  await assert.rejects(lstat(location), { code: 'ENOENT' })
  assert.equal((await git(primary, 'worktree', 'list', '--porcelain')).includes(location), false)
  assert.equal(await git(primary, 'branch', '--list', 'feature'), 'feature')
})

test('refuses dirty code, unknown files, and unpushed commit', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [] }
  await writeFile(path.join(location, 'README.md'), 'dirty\n')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /worktree_dirty_code/)
  await git(location, 'checkout', '--', 'README.md')
  await writeFile(path.join(location, 'unknown.txt'), 'unknown')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /unknown_untracked/)
  await rm(path.join(location, 'unknown.txt'))
  await writeFile(path.join(location, 'README.md'), 'committed\n')
  await git(location, 'add', '.')
  await git(location, 'commit', '-m', 'unpublished')
  const changed = { ...entry, head: await git(location, 'rev-parse', 'HEAD') }
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry: changed, workspaceDir, checkOnly: true }), /unpushed/)
  assert.equal((await lstat(location)).isDirectory(), true)
})

test('rejects main checkout and paths outside managed worktrees', async (t) => {
  const { workspaceDir, primary } = await fixture(t)
  await assert.rejects(inspectTaskWorktree({ location: primary, workspaceDir }), /outside_managed_root/)
  await assert.rejects(inspectTaskWorktree({ location: path.join(workspaceDir, 'worktrees', '..', 'primary'), workspaceDir }), /outside_managed_root/)
})

test('registered start permits only published descendant commits and records the archived head', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const source = 'docs/spec/plan.md'
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source }] }
  await mkdir(path.join(location, 'docs/spec'), { recursive: true })
  await writeFile(path.join(location, source), 'latest accepted report\n')
  await git(location, 'add', '.')
  await git(location, 'commit', '-m', 'later task development')
  const latestHead = await git(location, 'rev-parse', 'HEAD')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /unpushed/)
  await git(location, 'push', 'origin', 'feature')
  await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true })
  const result = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir })
  assert.equal(result.head, latestHead)
  assert.equal(result.status, 'cleaned')
  assert.equal(await readFile(result.documents[0].archivePath, 'utf8'), 'latest accepted report\n')
})

test('same branch with rewritten history cannot replace registered identity', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [] }
  await git(location, 'checkout', '--orphan', 'rewritten')
  await git(location, 'commit', '-m', 'unrelated root')
  await git(location, 'branch', '-M', 'feature')
  await git(location, 'push', '--force', 'origin', 'feature')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /identity_changed:head/)
  assert.equal((await lstat(location)).isDirectory(), true)
})

test('different branch still rejects even when head is unchanged', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [] }
  await git(location, 'checkout', '-b', 'different')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /identity_changed:branch/)
  assert.equal((await lstat(location)).isDirectory(), true)
})

test('head advancement during document copy stops deletion even if already published', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const source = 'docs/spec/plan.md'
  await mkdir(path.join(location, 'docs/spec'), { recursive: true })
  await writeFile(path.join(location, source), 'report\n')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source }] }
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, onProgress: async () => {
    await writeFile(path.join(location, 'README.md'), 'development during archive\n')
    await git(location, 'add', '.')
    await git(location, 'commit', '-m', 'concurrent development')
    await git(location, 'push', 'origin', 'feature')
  } }), /identity_changed:head/)
  assert.equal((await lstat(location)).isDirectory(), true)
  assert.equal(await readFile(path.join(location, 'README.md'), 'utf8'), 'development during archive\n')
})

test('remote branch may advance or be deleted when the registered commit remains published', async (t) => {
  const { workspaceDir, primary, location } = await fixture(t)
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [] }
  await writeFile(path.join(primary, 'README.md'), 'remote next\n')
  await git(primary, 'add', '.')
  await git(primary, 'commit', '-m', 'remote advance')
  await git(primary, 'push', 'origin', 'HEAD:refs/heads/feature')
  await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true })
  await git(primary, 'push', 'origin', 'HEAD:refs/heads/main')
  await git(primary, 'push', 'origin', '--delete', 'feature')
  await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true })
  assert.equal((await lstat(location)).isDirectory(), true)
  const result = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir })
  assert.equal(result.status, 'cleaned')
})

test('remote rewrite does not allow deleting a commit no longer contained in any published branch', async (t) => {
  const { workspaceDir, primary, location } = await fixture(t)
  await writeFile(path.join(location, 'README.md'), 'local commit\n')
  await git(location, 'add', '.')
  await git(location, 'commit', '-m', 'feature commit')
  await git(location, 'push', 'origin', 'feature')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [] }
  await git(primary, 'push', '--force', 'origin', 'HEAD:refs/heads/feature')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true }), /unpushed_or_remote_changed/)
  assert.equal((await lstat(location)).isDirectory(), true)
})

test('removed directory recovers registered tracked document bytes from exact commit with zero-write check', async (t) => {
  const { workspaceDir, primary, location } = await fixture(t)
  const source = 'docs/acceptance/case/file.bin'
  const bytes = Buffer.from([0, 255, 13, 10, 128])
  await mkdir(path.join(location, 'docs/acceptance/case'), { recursive: true })
  await writeFile(path.join(location, source), bytes)
  await git(location, 'add', '.')
  await git(location, 'commit', '-m', 'document')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source }] }
  await git(primary, 'worktree', 'remove', location)
  const progress = []
  const checked = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, checkOnly: true, onProgress: async value => progress.push(value) })
  await assert.rejects(lstat(checked.documents[0].archivePath), { code: 'ENOENT' })
  assert.equal(progress.length, 0)
  const result = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir, onProgress: async value => progress.push(value) })
  assert.equal(result.status, 'cleaned')
  assert.deepEqual(await readFile(result.documents[0].archivePath), bytes)
  assert.equal(progress.length, 1)
  assert.equal((await archiveTaskWorktree({ taskId: 'task-1', entry: { ...result, status: 'registered' }, workspaceDir, checkOnly: true })).status, 'cleaned')
})

test('removed directory rejects missing blobs and conflicting recovery targets without overwriting', async (t) => {
  const { workspaceDir, primary, location } = await fixture(t)
  const source = 'docs/acceptance/case/plan.md'
  await mkdir(path.join(location, 'docs/acceptance/case'), { recursive: true })
  await writeFile(path.join(location, source), 'registered version\n')
  await git(location, 'add', '.')
  await git(location, 'commit', '-m', 'document')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source }] }
  await git(primary, 'worktree', 'remove', location)
  const target = path.join(workspaceDir, 'docs/acceptance/task-1/primary/case/plan.md')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, 'unrelated version\n')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir }), /document_target_conflict/)
  assert.equal(await readFile(target, 'utf8'), 'unrelated version\n')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry: { ...entry, documents: [{ source: 'docs/acceptance/case/missing.md' }] }, workspaceDir }), /removed_document_unverified/)
})

test('existing identical target is reusable and conflicting target stops before removal', async (t) => {
  const { workspaceDir, location } = await fixture(t)
  const file = path.join(location, 'docs', 'spec', 'plan.md')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'content')
  const entry = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source: 'docs/spec/plan.md' }] }
  const target = path.join(workspaceDir, 'docs', 'spec', 'task-1', 'primary', 'plan.md')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, 'other')
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir }), /document_target_conflict/)
  assert.equal(await readFile(file, 'utf8'), 'content')
  await writeFile(target, 'content')
  const result = await archiveTaskWorktree({ taskId: 'task-1', entry, workspaceDir })
  assert.equal(result.status, 'cleaned')
  assert.equal(await readFile(target, 'utf8'), 'content')
})

test('Git 已删目录但最终状态写入失败时按已保存文档摘要恢复', async t => {
  const { workspaceDir, location } = await fixture(t)
  const source = path.join(location, 'docs', 'spec', 'plan.md')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '可恢复方案')
  let saved = { ...await inspectTaskWorktree({ location, workspaceDir }), createdByTask: true, status: 'registered', documents: [{ source: 'docs/spec/plan.md' }] }
  await assert.rejects(archiveTaskWorktree({ taskId: 'task-1', entry: saved, workspaceDir, onProgress: async value => {
    if (value.status === 'cleaned') throw new Error('status_write_interrupted')
    saved = value
  } }), /status_write_interrupted/)
  await assert.rejects(lstat(location), { code: 'ENOENT' })
  const checked = await archiveTaskWorktree({ taskId: 'task-1', entry: saved, workspaceDir, checkOnly: true })
  assert.equal(checked.status, 'cleaned')
  const recovered = await archiveTaskWorktree({ taskId: 'task-1', entry: saved, workspaceDir })
  assert.equal(recovered.status, 'cleaned')
  assert.equal(await readFile(recovered.documents[0].archivePath, 'utf8'), '可恢复方案')
})
