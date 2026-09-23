import { spawn } from 'node:child_process'
import { realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { canonicalExecutionJson, executionDigest, executionError } from './execution-artifacts.js'
import { assertVerifiedCandidate } from './execution-candidate.js'

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const fail = code => { throw executionError(code) }
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value) }
const checkPreparedSize = value => { if (Buffer.byteLength(canonicalExecutionJson(value)) > 65536) fail('GIT_PREPARED_TOO_LARGE') }

// 只供受信Host效果网关调用；无shell、无凭据、无任意Git参数入口。
function git(directory, args, { input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    const child = spawn('git', ['--no-pager', '-C', directory, ...args], { shell: false, windowsHide: true, env: { ...clean, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', size = 0, failure
    const stop = code => { failure ??= executionError(code); child.kill() }
    const timer = setTimeout(() => stop('GIT_TIMEOUT'), 15000)
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) return stop('GIT_OUTPUT_LIMIT')
      if (output) stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
    })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdin.on('error', () => {})
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }) })
    child.stdin.end(input)
  })
}
async function command(directory, args, options) {
  const result = await git(directory, args, options)
  if (result.code !== 0) throw executionError('GIT_COMMAND_FAILED', result.stderr || `git ${args[0]} failed`)
  return result.stdout
}
async function admit(repository, bare) {
  if ((await command(repository, ['rev-parse', '--is-bare-repository'])) !== String(bare)) fail('GIT_REPOSITORY_KIND')
  if ((await command(repository, ['rev-parse', '--show-object-format'])) !== 'sha1') fail('GIT_OBJECT_FORMAT')
  const config = await command(repository, ['config', '--list', '--show-origin'])
  if (/(?:^|\n)[^\n]*\t(?:core\.(?:hookspath|sshcommand|gitproxy)|url\..*\.(?:insteadof|pushinsteadof)|include(?:if\..*)?\.path|remote\..*\.(?:receivepack|uploadpack)|extensions\.[^=]+)=/i.test(config)) fail('GIT_UNMANAGED_CONFIG')
  const gitDir = await realpath(resolve(repository, await command(repository, ['rev-parse', '--git-common-dir'])))
  const hooks = await readdir(join(gitDir, 'hooks')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (hooks.some(name => !name.endsWith('.sample'))) fail('GIT_HOOKS_UNSUPPORTED')
}

export async function createGitDelivery({ repository, remote, branch, author }) {
  if (!isAbsolute(repository ?? '') || !isAbsolute(remote ?? '') || /[\0\r\n]/.test(repository + remote)) fail('GIT_LOCAL_SCOPE_REQUIRED')
  repository = await realpath(repository); remote = await realpath(remote)
  if (!(await stat(repository)).isDirectory() || !(await stat(remote)).isDirectory() || repository === remote) fail('GIT_SCOPE_INVALID')
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\0\r\n]/.test(branch)) fail('GIT_BRANCH_INVALID')
  const ref = `refs/heads/${branch}`
  await command(repository, ['check-ref-format', ref])
  if (!author || !['name', 'email'].every(key => typeof author[key] === 'string' && author[key].trim() && !/[<>\0\r\n]/.test(author[key]))) fail('GIT_AUTHOR_INVALID')
  author = { name: author.name, email: author.email }
  const scope = { repository, remote, ref, author }
  const check = async () => {
    await admit(repository, false); await admit(remote, true)
    const signing = await git(repository, ['config', '--bool', '--get', 'commit.gpgsign'])
    if ((signing.code !== 0 && signing.code !== 1) || signing.stdout === 'true') fail('GIT_SIGNING_UNSUPPORTED')
    const worktrees = await command(repository, ['worktree', 'list', '--porcelain', '-z'])
    if (worktrees.split('\0').includes(`branch ${ref}`)) fail('GIT_CHECKED_OUT_REF')
  }
  await check()
  const currentLocal = async () => { const result = await git(repository, ['rev-parse', '--verify', '--quiet', ref]); if (result.code === 1) return null; if (result.code || !oid(result.stdout)) fail('GIT_REF_READ_FAILED'); return result.stdout }
  const currentRemote = async () => {
    const result = await command(repository, ['ls-remote', '--refs', '--', remote, ref])
    if (!result) return null
    const parts = result.split(/\s+/)
    if (parts.length !== 2 || !oid(parts[0]) || parts[1] !== ref) fail('GIT_REMOTE_READ_INVALID')
    return parts[0]
  }
  const validate = (prepared, action) => {
    checkPreparedSize(prepared)
    if (!prepared || prepared.action !== action || prepared.version !== 1 || prepared.repository !== repository || prepared.remote !== remote || prepared.ref !== ref || executionDigest(prepared.author) !== executionDigest(author)) fail('GIT_PREPARED_SCOPE_MISMATCH')
    const { digest, ...body } = prepared
    if (executionDigest(body) !== digest || !oid(prepared.commitId)) fail('GIT_PREPARED_INVALID')
    if (!Number.isSafeInteger(prepared.generation) || prepared.generation < 1 || !/^[a-f0-9]{64}$/.test(prepared.requirementDigest ?? '')) fail('GIT_PREPARED_INVALID')
    if (action === 'commit' && (!oid(prepared.tree) || !oid(prepared.baseCommit) || (prepared.expectedLocalSha !== null && !oid(prepared.expectedLocalSha)) || !/^\d{10} \+0000$/.test(prepared.date) || typeof prepared.message !== 'string' || prepared.message.includes('\0'))) fail('GIT_PREPARED_INVALID')
    if (action === 'push' && prepared.expectedRemoteSha !== null && !oid(prepared.expectedRemoteSha)) fail('GIT_PREPARED_INVALID')
  }
  async function prepareCommit({ candidate, verification, requiredChecks, message, date }) {
    await assertVerifiedCandidate({ candidate, verification, requiredChecks })
    if (candidate.repository !== repository || !oid(candidate.tree) || !oid(candidate.baseCommit)) fail('GIT_CANDIDATE_SCOPE_MISMATCH')
    if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 16384) fail('GIT_MESSAGE_INVALID')
    if (typeof date !== 'string' || !/^\d{10} \+0000$/.test(date)) fail('GIT_FROZEN_DATE_REQUIRED')
    await check()
    const expectedLocalSha = await currentLocal()
    if (expectedLocalSha !== null && expectedLocalSha !== candidate.baseCommit) fail('GIT_LOCAL_CONFLICT')
    await command(repository, ['cat-file', '-e', `${candidate.tree}^{tree}`])
    await command(repository, ['cat-file', '-e', `${candidate.baseCommit}^{commit}`])
    message = `${message.trimEnd()}\n`
    const identity = `${author.name} <${author.email}> ${date}`
    const raw = `tree ${candidate.tree}\nparent ${candidate.baseCommit}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`
    const commitId = await command(repository, ['hash-object', '-t', 'commit', '--stdin'], { input: raw })
    const body = { version: 1, action: 'commit', ...scope, candidateDigest: candidate.digest, generation: candidate.generation, requirementDigest: candidate.requirementDigest, tree: candidate.tree, baseCommit: candidate.baseCommit, expectedLocalSha, date, message, commitId, verification: structuredClone(verification) }
    const prepared = { ...body, digest: executionDigest(body) }
    // 与节点工件一致的64KiB上限；完整验证日志超限时拒绝，不能截断审计证据。
    checkPreparedSize(prepared)
    return freeze(prepared)
  }
  async function reconcileCommit(prepared) {
    validate(prepared, 'commit')
    const localSha = await currentLocal()
    const object = await git(repository, ['cat-file', '-p', prepared.commitId])
    const expectedHeader = `tree ${prepared.tree}\nparent ${prepared.baseCommit}\n`
    return { status: localSha === prepared.commitId && object.code === 0 && object.stdout.startsWith(expectedHeader) ? 'succeeded' : 'unknown', commitId: prepared.commitId, localSha }
  }
  async function executeCommit(prepared) {
    validate(prepared, 'commit'); await check()
    if (await currentLocal() !== prepared.expectedLocalSha) fail('GIT_LOCAL_CONFLICT')
    const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_AUTHOR_DATE: prepared.date, GIT_COMMITTER_DATE: prepared.date }
    const commitId = await command(repository, ['commit-tree', prepared.tree, '-p', prepared.baseCommit, '-F', '-'], { input: prepared.message, env })
    if (commitId !== prepared.commitId) fail('GIT_COMMIT_ID_MISMATCH')
    await command(repository, ['update-ref', ref, commitId, prepared.expectedLocalSha ?? '0'.repeat(40)])
    return reconcileCommit(prepared)
  }
  async function preparePush({ commit, expectedRemoteSha }) {
    validate(commit, 'commit')
    if (expectedRemoteSha !== null && !oid(expectedRemoteSha)) fail('GIT_REMOTE_BASE_REQUIRED')
    await check()
    if ((await reconcileCommit(commit)).status !== 'succeeded') fail('GIT_COMMIT_NOT_DELIVERED')
    if (await currentRemote() !== expectedRemoteSha) fail('GIT_REMOTE_CONFLICT')
    if (expectedRemoteSha && (await git(repository, ['merge-base', '--is-ancestor', expectedRemoteSha, commit.commitId])).code !== 0) fail('GIT_NON_FAST_FORWARD')
    const body = { version: 1, action: 'push', ...scope, commitId: commit.commitId, expectedRemoteSha, candidateDigest: commit.candidateDigest, generation: commit.generation, requirementDigest: commit.requirementDigest, verificationDigest: commit.verification.digest }
    return freeze({ ...body, digest: executionDigest(body) })
  }
  async function reconcilePush(prepared) {
    validate(prepared, 'push'); await check()
    const remoteSha = await currentRemote()
    return { status: remoteSha === prepared.commitId ? 'succeeded' : 'unknown', commitId: prepared.commitId, remoteSha }
  }
  async function executePush(prepared) {
    validate(prepared, 'push'); await check()
    if (prepared.expectedRemoteSha !== null && (!oid(prepared.expectedRemoteSha) || (await git(repository, ['merge-base', '--is-ancestor', prepared.expectedRemoteSha, prepared.commitId])).code !== 0)) fail('GIT_NON_FAST_FORWARD')
    // lease仅实现精确旧值条件；上面的祖先检查禁止借此覆盖历史。
    await command(repository, ['push', '--porcelain', `--force-with-lease=${ref}:${prepared.expectedRemoteSha ?? ''}`, '--', remote, `${prepared.commitId}:${ref}`])
    return reconcilePush(prepared)
  }
  return Object.freeze({ prepareCommit, executeCommit, reconcileCommit, preparePush, executePush, reconcilePush })
}
