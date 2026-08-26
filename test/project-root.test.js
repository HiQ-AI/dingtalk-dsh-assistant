import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions'

test('worktree 子目录只用唯一标记回溯到 baibu-agent 根 AGENTS.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-root-'))
  const cwd = join(root, 'dsh-resident-runtime', 'test', 'fixtures', 'worktree', 'repo')
  try {
    await mkdir(cwd, { recursive: true })
    await writeFile(join(root, '.dsh-project-root'), '')
    await writeFile(join(root, 'AGENTS.md'), '# test instructions')
    const files = await discoverBaselineInstructionFiles({
      cwd,
      dshHome: join(root, 'dsh-resident-runtime', '.dsh'),
      projectRootMarkers: ['.dsh-project-root'],
      instructionFileCandidates: ['AGENTS.md'],
      localInstructionFileCandidates: [],
    })

    assert.ok(files.some((file) => file.absolutePath === join(root, 'AGENTS.md')))
    assert.ok(files.every((file) => !file.absolutePath.includes('agent-studio-next')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
