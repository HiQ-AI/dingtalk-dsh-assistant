import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGitDelivery } from '../packages/dingtalk-dsh-assistant/execution-git.js'
import { freezeCandidate, verifyCandidate } from '../packages/dingtalk-dsh-assistant/execution-candidate.js'

const exec = promisify(execFile)
const git = async (repo, ...args) => (await exec('git', ['-C', repo, ...args], { windowsHide: true })).stdout.trim()
const requiredChecks = [{ id: 'content', version: '1' }]
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-execution-git-')), repository = join(directory, 'source'), remote = join(directory, 'remote.git')
  await mkdir(repository); await mkdir(remote)
  await git(repository, 'init', '-b', 'main'); await git(remote, 'init', '--bare')
  await git(repository, 'config', 'user.name', 'Synthetic'); await git(repository, 'config', 'user.email', 'synthetic@example.invalid')
  await writeFile(join(repository, 'value.txt'), 'base\n'); await git(repository, 'add', 'value.txt'); await git(repository, 'commit', '-m', 'base')
  const baseCommit = await git(repository, 'rev-parse', 'HEAD')
  await writeFile(join(repository, 'value.txt'), 'verified\n')
  const candidate = await freezeCandidate({ repository, baseCommit, generation: 1, requirementDigest: 'a'.repeat(64) })
  const verification = await verifyCandidate({ candidate, checks: [{ ...requiredChecks[0], run: async ({ readFile }) => ({ passed: (await readFile('value.txt')).toString() === 'verified\n', log: 'fixed bytes verified' }) }] })
  const scope = { repository, remote, branch: 'delivery', author: { name: 'Synthetic', email: 'synthetic@example.invalid' } }
  return { ...scope, directory, scope, candidate, verification, adapter: await createGitDelivery(scope), baseCommit }
}
test('Git交付仅提交已验证tree，冻结日期/身份，工作目录与用户索引不变；push独立回读', async () => {
  const f = await setup(), indexBefore = await readFile(join(f.repository, '.git', 'index'))
  const prepared = await f.adapter.prepareCommit({ candidate: f.candidate, verification: f.verification, requiredChecks, date: '1790150400 +0000', message: 'verified delivery' })
  assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.author))
  assert.ok(Object.isFrozen(prepared.verification.checks))
  const restored = JSON.parse(JSON.stringify(prepared))
  assert.deepEqual(restored.verification, f.verification)
  assert.equal(restored.verification.digest, f.verification.digest)
  assert.deepEqual(restored.verification.checks, [{ ...requiredChecks[0], passed: true, log: 'fixed bytes verified' }])
  await assert.rejects(git(f.repository, 'cat-file', '-e', prepared.commitId)) // 准备不生成commit
  await writeFile(join(f.repository, 'value.txt'), 'later user change\n')
  assert.equal((await f.adapter.executeCommit(restored)).status, 'succeeded')
  assert.equal(await git(f.repository, 'show', `${prepared.commitId}:value.txt`), 'verified')
  assert.equal(await readFile(join(f.repository, 'value.txt'), 'utf8'), 'later user change\n')
  assert.deepEqual(await readFile(join(f.repository, '.git', 'index')), indexBefore)
  assert.equal((await f.adapter.reconcileCommit(restored)).status, 'succeeded')
  const push = await f.adapter.preparePush({ commit: restored, expectedRemoteSha: null })
  assert.equal(push.verificationDigest, f.verification.digest)
  assert.equal(push.verification, undefined)
  assert.equal((await f.adapter.executePush(push)).status, 'succeeded')
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/delivery'), prepared.commitId)
  assert.equal((await f.adapter.reconcilePush(JSON.parse(JSON.stringify(push)))).status, 'succeeded')
})
test('没有真实验证ticket或要求版本不符时，提交准备失败且无ref', async () => {
  const f = await setup()
  await assert.rejects(f.adapter.prepareCommit({ candidate: f.candidate, verification: structuredClone(f.verification), requiredChecks, date: '1790150400 +0000', message: 'fake' }), { code: 'CANDIDATE_VERIFICATION_UNTRUSTED' })
  await assert.rejects(f.adapter.prepareCommit({ candidate: f.candidate, verification: f.verification, requiredChecks: [{ id: 'content', version: '2' }], date: '1790150400 +0000', message: 'wrong' }), { code: 'CANDIDATE_REQUIRED_CHECKS_MISMATCH' })
  const oversized = await verifyCandidate({ candidate: f.candidate, checks: [{ ...requiredChecks[0], run: async () => ({ passed: true, log: 'x'.repeat(65536) }) }] })
  await assert.rejects(f.adapter.prepareCommit({ candidate: f.candidate, verification: oversized, requiredChecks, date: '1790150400 +0000', message: 'oversized evidence' }), { code: 'GIT_PREPARED_TOO_LARGE' })
  await assert.rejects(git(f.repository, 'show-ref', '--verify', 'refs/heads/delivery'))
})
test('准备后本地ref改变，CAS拒绝且保留外部ref', async () => {
  const f = await setup(), prepared = await f.adapter.prepareCommit({ candidate: f.candidate, verification: f.verification, requiredChecks, date: '1790150400 +0000', message: 'delivery' })
  await git(f.repository, 'update-ref', 'refs/heads/delivery', f.baseCommit)
  await assert.rejects(f.adapter.executeCommit(prepared), { code: 'GIT_LOCAL_CONFLICT' })
  assert.equal(await git(f.repository, 'rev-parse', 'refs/heads/delivery'), f.baseCommit)
  assert.equal((await f.adapter.reconcileCommit(prepared)).status, 'unknown')
})
test('准备后远端ref改变，精确lease拒绝覆盖', async () => {
  const f = await setup(), prepared = await f.adapter.prepareCommit({ candidate: f.candidate, verification: f.verification, requiredChecks, date: '1790150400 +0000', message: 'delivery' })
  await f.adapter.executeCommit(prepared)
  const push = await f.adapter.preparePush({ commit: prepared, expectedRemoteSha: null })
  await git(f.repository, 'push', f.remote, `${f.baseCommit}:refs/heads/delivery`)
  await assert.rejects(f.adapter.executePush(push), { code: 'GIT_COMMAND_FAILED' })
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/delivery'), f.baseCommit)
  assert.equal((await f.adapter.reconcilePush(push)).status, 'unknown')
  const next = await f.adapter.preparePush({ commit: prepared, expectedRemoteSha: f.baseCommit })
  assert.equal((await f.adapter.executePush(next)).status, 'succeeded')
  const sibling = await git(f.repository, 'commit-tree', f.candidate.tree, '-p', f.baseCommit, '-m', 'independent external change')
  await git(f.repository, 'push', f.remote, `${sibling}:refs/heads/external`)
  await git(f.remote, 'update-ref', 'refs/heads/delivery', sibling, prepared.commitId)
  await assert.rejects(f.adapter.preparePush({ commit: prepared, expectedRemoteSha: sibling }), { code: 'GIT_NON_FAST_FORWARD' })
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/delivery'), sibling)
})
test('不准入hooks或URL协议；准备后新增hook同样阻断', async () => {
  const f = await setup()
  await assert.rejects(createGitDelivery({ ...f.scope, remote: 'ext::malicious' }), { code: 'GIT_LOCAL_SCOPE_REQUIRED' })
  await assert.rejects(createGitDelivery({ ...f.scope, branch: 'main' }), { code: 'GIT_CHECKED_OUT_REF' })
  await git(f.repository, 'config', 'commit.gpgsign', 'true')
  await assert.rejects(createGitDelivery(f.scope), { code: 'GIT_SIGNING_UNSUPPORTED' })
  await git(f.repository, 'config', '--unset', 'commit.gpgsign')
  const prepared = await f.adapter.prepareCommit({ candidate: f.candidate, verification: f.verification, requiredChecks, date: '1790150400 +0000', message: 'delivery' })
  await writeFile(join(f.repository, '.git', 'hooks', 'pre-commit'), '# synthetic hook')
  await assert.rejects(f.adapter.executeCommit(prepared), { code: 'GIT_HOOKS_UNSUPPORTED' })
  await assert.rejects(git(f.repository, 'show-ref', '--verify', 'refs/heads/delivery'))
})
