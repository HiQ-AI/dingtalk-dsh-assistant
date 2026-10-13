// 只读远端、临时 Git 归档并清理；在任何 PUT 之前明确停止。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { uploadUatSource, sourceUploadTarget } from '../../../../packages/dingtalk-dsh-assistant/workflow-source-upload.js'

const [mode, repository, branch] = process.argv.slice(2)
assert.equal(mode, '--check')
const target = { repository, branch }
assert.ok(sourceUploadTarget(target), '仅检查已支持的 UAT 目标')
const run = promisify(execFile)
try {
  const githubToken = (await run('gh', ['auth', 'token'], { windowsHide: true })).stdout.trim()
  const commitSha = (await run('gh', ['api', `repos/${repository}/branches/${encodeURIComponent(branch)}`,
    '--jq', '.commit.sha'], { windowsHide: true })).stdout.trim()
  let prepared = false, uploadRequests = 0
  try {
    await uploadUatSource({ target, commitSha, githubToken, sourceUploadToken: 'read-only-never-sent',
      beforeUpload: async () => { prepared = true; throw Error('READ_ONLY_CHECK_COMPLETE') },
      fetchImpl: async () => { uploadRequests++; throw Error('NETWORK_WRITE_FORBIDDEN') } })
    throw Error('CHECK_DID_NOT_STOP')
  } catch (error) {
    assert.equal(error.message, 'READ_ONLY_CHECK_COMPLETE')
  }
  assert.equal(prepared, true)
  assert.equal(uploadRequests, 0)
  console.log(JSON.stringify({ repository, branch, commitSha, sourcePreparation: 'PASS', uploadRequests }))
} catch (error) {
  // CLI 或断言错误对象可能包含认证命令输出；只输出固定结果。
  console.error(JSON.stringify({ repository, branch, sourcePreparation: 'FAIL', error: 'READ_ONLY_SOURCE_CHECK_FAILED' }))
  process.exitCode = 1
}
