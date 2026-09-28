import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

test('真实Controller/Store三文件工作流逐件持久化并核验收口', async () => {
 const script = fileURLToPath(new URL('../docs/acceptance/task-group-file-delivery/scripts/verify-file-workflow.mjs', import.meta.url))
 const { stdout } = await promisify(execFile)(process.execPath, [script, '--mock'], { windowsHide: true, timeout: 30000 })
 const result = JSON.parse(stdout.trim())
 assert.equal(result.mock, 'PASS')
 assert.equal(result.runStatus, 'succeeded')
 assert.equal(result.sends, 3)
 assert.deepEqual(result.effectStates, ['succeeded', 'succeeded', 'succeeded'])
 assert.deepEqual(result.roles, ['md', 'sql', 'png'])
 assert.equal(result.deliveryStatus, 'files_verified')
})
