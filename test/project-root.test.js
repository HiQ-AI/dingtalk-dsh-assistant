import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions'

test('worktree 子目录只用唯一标记回溯到 baibu-agent 根 AGENTS.md', async () => {
  const cwd = 'D:\\baibu-agent\\dsh-resident-runtime\\test\\fixtures\\worktree\\repo'
  const files = await discoverBaselineInstructionFiles({
    cwd,
    dshHome: 'D:\\baibu-agent\\dsh-resident-runtime\\.dsh',
    projectRootMarkers: ['.dsh-project-root'],
    instructionFileCandidates: ['AGENTS.md'],
    localInstructionFileCandidates: [],
  })

  assert.ok(files.some((file) => file.absolutePath === 'D:\\baibu-agent\\AGENTS.md'))
  assert.ok(files.every((file) => !file.absolutePath.includes('agent-studio-next')))
})
