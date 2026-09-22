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
