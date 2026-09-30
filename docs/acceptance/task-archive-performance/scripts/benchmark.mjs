import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as optimized from '../../../../packages/dingtalk-dsh-assistant/task-worktree-archive.js'

// 基线文件由 git show 导出到 docs/tmp；只操作本脚本创建的一次性仓库。
const baseline = await import(pathToFileURL(path.resolve(process.argv[2])).href)
const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim()
const workspaceDir = await mkdtemp(path.join(tmpdir(), 'dsh-archive-benchmark-'))
const primary = path.join(workspaceDir, 'primary')
const samples = { baseline: [], optimized: [] }
try {
  await mkdir(primary)
  await git(workspaceDir, 'init', '--bare', path.join(workspaceDir, 'remote.git'))
  await git(primary, 'init')
  await git(primary, 'config', 'user.name', 'Test')
  await git(primary, 'config', 'user.email', 'test@example.test')
  await writeFile(path.join(primary, 'README.md'), 'base\n')
  await git(primary, 'add', '.')
  await git(primary, 'commit', '-m', 'base')
  await git(primary, 'remote', 'add', 'origin', path.join(workspaceDir, 'remote.git'))
  await git(primary, 'push', 'origin', 'HEAD:refs/heads/main')
  for (let round = 0; round < 3; round++) {
    for (const name of round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
      const implementation = name === 'baseline' ? baseline : optimized
      const branch = `${name}-${round}`
      const location = path.join(workspaceDir, 'worktrees', branch)
      await git(primary, 'worktree', 'add', '-b', branch, location)
      await git(location, 'push', 'origin', branch)
      await mkdir(path.join(location, 'docs', 'spec'), { recursive: true })
      await writeFile(path.join(location, 'docs', 'spec', 'plan.md'), '归档方案\n')
      const entry = { ...await implementation.inspectTaskWorktree({ location, workspaceDir }),
        createdByTask: true, status: 'registered', documents: [{ source: 'docs/spec/plan.md' }] }
      const input = { taskId: branch, entry, workspaceDir }
      const start = performance.now()
      if (name === 'baseline') await implementation.archiveTaskWorktree({ ...input, checkOnly: true })
      const result = await implementation.archiveTaskWorktree(input)
      samples[name].push(Math.round(performance.now() - start))
      assert.equal(result.status, 'cleaned')
      assert.equal(await readFile(result.documents[0].archivePath, 'utf8'), '归档方案\n')
      await assert.rejects(lstat(location), { code: 'ENOENT' })
      assert.equal((await git(primary, 'worktree', 'list', '--porcelain')).includes(branch), false)
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[1]
  const before = median(samples.baseline), after = median(samples.optimized)
  console.log(JSON.stringify({ samplesMs: samples, medianMs: { baseline: before, optimized: after },
    reductionPercent: Math.round((before - after) / before * 100), scope: '单目录、单文档、本地 bare 远端；不含建库和登记耗时' }, null, 2))
} finally {
  await rm(workspaceDir, { recursive: true, force: true })
}
