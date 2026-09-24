import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { executionDigest, executionError } from './execution-artifacts.js'

function invoke(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, ...args], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } })
    let stdout = '', stderr = '', size = 0, failure
    const timer = setTimeout(() => { failure = executionError('PR_COMMAND_TIMEOUT'); child.kill() }, 30000)
    for (const [stream, out] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', bytes => {
      size += bytes.length
      if (size > 1024 * 1024) { failure = executionError('PR_OUTPUT_LIMIT'); child.kill(); return }
      if (out) stdout += bytes; else stderr += bytes
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout, stderr }) })
  })
}

/** repo/base/head及CLI由Host静态配置；Agent只提供候选，不拥有gh能力。 */
export function createGithubPullRequests({ repository, repo, base, head, previousOperationKey, ghCommand = { executable: 'gh', args: [] } }) {
  if (!isAbsolute(repository ?? '') || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? '')
    || ![base, head].every(value => typeof value === 'string' && value && !value.startsWith('-') && !/[\s\0]/.test(value))
    || typeof ghCommand.executable !== 'string' || !ghCommand.executable || !Array.isArray(ghCommand.args) || ghCommand.args.some(value => typeof value !== 'string')) throw executionError('PR_CONFIG_INVALID')
  if (previousOperationKey !== undefined && !/^[a-f0-9]{64}$/.test(previousOperationKey)) throw executionError('PR_CONFIG_INVALID')
  const command = structuredClone(ghCommand), scope = { repository, repo, base, head, ...(previousOperationKey ? { previousOperationKey } : {}) }
  const marker = prepared => `<!-- dsh-operation:${prepared.operationKey} -->`
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (digest !== executionDigest(body) || body.version !== 1 || body.action !== 'pr' || Object.entries(scope).some(([key, value]) => body[key] !== value)
      || !/^[a-f0-9]{40}$/.test(body.commitId ?? '') || !/^[a-f0-9]{64}$/.test(body.requirementDigest ?? '')
      || !Number.isSafeInteger(body.generation) || body.generation < 1 || typeof body.runId !== 'string' || !body.runId || typeof body.title !== 'string' || !body.title.trim() || /[\0\r\n]/.test(body.title) || typeof body.body !== 'string'
      || body.operationKey !== executionDigest({ ...scope, runId: body.runId, generation: body.generation, requirementDigest: body.requirementDigest, commitId: body.commitId })
      || Buffer.byteLength(JSON.stringify(prepared)) > 60000) throw executionError('PR_PREPARED_INVALID')
  }
  function prepare({ runId, generation, requirementDigest, commitId, title, body }) {
    const operationKey = executionDigest({ ...scope, runId, generation, requirementDigest, commitId })
    const value = { version: 1, action: 'pr', ...scope, runId, generation, requirementDigest, commitId, title, body, operationKey }
    const prepared = { ...value, digest: executionDigest(value) }; validate(prepared)
    return prepared
  }
  async function json(args) {
    const result = await invoke(command, args, repository)
    if (result.code !== 0) throw executionError('PR_READBACK_FAILED')
    try { return JSON.parse(result.stdout) } catch { throw executionError('PR_READBACK_INVALID') }
  }
  async function reconcile(prepared, { allowHeadChange = false } = {}) {
    validate(prepared)
    const list = await json(['pr', 'list', '--repo', repo, '--head', head, '--base', base, '--state', 'all', '--limit', '100', '--json', 'number,url,state,headRefOid,headRefName,baseRefName,body'])
    if (!Array.isArray(list)) throw executionError('PR_READBACK_INVALID')
    const matching = list.filter(item => item.body?.includes(marker(prepared)))
    if (matching.length > 1) throw executionError('PR_IDENTITY_AMBIGUOUS')
    if (!matching.length) {
      if (previousOperationKey) {
        const old = list.filter(item => item.body?.includes(`<!-- dsh-operation:${previousOperationKey} -->`))
        if (old.length !== 1 || old[0].state !== 'OPEN' || old[0].headRefOid !== prepared.commitId || old[0].headRefName !== head || old[0].baseRefName !== base) throw executionError('PR_PREVIOUS_IDENTITY_CONFLICT')
        return { status: 'unknown', reason: 'pr_revision_not_observed', previousNumber: old[0].number }
      }
      if (list.some(item => item.state === 'OPEN')) throw executionError('PR_BRANCH_ALREADY_USED')
      return { status: 'unknown', reason: 'pr_not_observed', repo, head, commitId: prepared.commitId }
    }
    const result = await json(['pr', 'view', String(matching[0].number), '--repo', repo, '--json', 'number,url,state,headRefOid,headRefName,baseRefName,body'])
    if (result.headRefName !== head || result.baseRefName !== base || (!allowHeadChange && result.headRefOid !== prepared.commitId) || !result.body?.includes(marker(prepared))
      || !['OPEN', 'MERGED'].includes(result.state) || !Number.isSafeInteger(result.number) || !/^https:\/\//.test(result.url ?? '')) throw executionError('PR_RESULT_CONFLICT')
    return { status: 'succeeded', number: result.number, url: result.url, state: result.state, commitId: result.headRefOid, repo, head, base }
  }
  async function execute(prepared) {
    validate(prepared)
    const existing = await reconcile(prepared)
    if (existing.status === 'succeeded') return existing
    const branch = await json(['api', `repos/${repo}/git/ref/heads/${head.split('/').map(encodeURIComponent).join('/')}`])
    if (branch.object?.sha !== prepared.commitId) throw executionError('PR_HEAD_CHANGED')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-')), path = join(directory, 'body.md')
    try {
      await writeFile(path, `${prepared.body}\n\n${marker(prepared)}\n`, { flag: 'wx' })
      try { await invoke(command, existing.previousNumber ? ['pr', 'edit', String(existing.previousNumber), '--repo', repo, '--title', prepared.title, '--body-file', path] : ['pr', 'create', '--repo', repo, '--base', base, '--head', head, '--title', prepared.title, '--body-file', path], repository) }
      catch { /* 发送结果不确定，一律只读回，不二次create。 */ }
      return reconcile(prepared)
    } finally { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }); await rmdir(directory) }
  }
  return { prepare, execute, reconcile }
}
