import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rmdir, mkdir, lstat, open, readFile, realpath } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { executionDigest, executionError } from './execution-artifacts.js'

const operation = new AsyncLocalStorage()
function invoke(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, ...args], { cwd, shell: false, windowsHide: true, signal: operation.getStore()?.signal, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } })
    const stdout = []; let stderr = '', stderrTruncated = false, failure
    for (const [stream, out] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', bytes => {
      if (out) stdout.push(bytes)
      else { const value = stderr + bytes.toString('utf8'); stderrTruncated ||= value.length > 8192; stderr = value.slice(0, 8192) }
    })
    child.once('error', error => { failure = error })
    child.once('close', code => {
      if (failure) return reject(failure.name === 'AbortError' ? executionError('PR_CANCELLED') : failure)
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr + (stderrTruncated ? '\n[诊断输出已截断]' : '') })
    })
  })
}

/** repo/base/head及CLI由Host静态配置；Agent只提供候选，不拥有gh能力。 */
export function createGithubPullRequests({ repository, repo, base, head, previousOperationKey, previousPullRequest, ghCommand = { executable: 'gh', args: [] } }) {
  if (!isAbsolute(repository ?? '') || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? '')
    || ![base, head].every(value => typeof value === 'string' && value && !value.startsWith('-') && !/[\s\0]/.test(value))
    || typeof ghCommand.executable !== 'string' || !ghCommand.executable || !Array.isArray(ghCommand.args) || ghCommand.args.some(value => typeof value !== 'string')) throw executionError('PR_CONFIG_INVALID')
  if (previousOperationKey !== undefined && !/^[a-f0-9]{64}$/.test(previousOperationKey)) throw executionError('PR_CONFIG_INVALID')
  if (previousPullRequest && (previousOperationKey !== undefined || !Number.isSafeInteger(previousPullRequest.number) || previousPullRequest.number < 1
    || previousPullRequest.repo !== repo || previousPullRequest.head !== head || typeof previousPullRequest.base !== 'string' || !previousPullRequest.base
    || !/^[a-f0-9]{64}$/.test(previousPullRequest.operationKey ?? '') || !/^feature\/uat[1-9]-base$/.test(base))) throw executionError('PR_CONFIG_INVALID')
  const command = structuredClone(ghCommand), scope = { repository, repo, base, head, ...(previousOperationKey ? { previousOperationKey } : {}),
    ...(previousPullRequest ? { previousPullRequest: structuredClone(previousPullRequest) } : {}) }
  const marker = prepared => `<!-- dsh-operation:${prepared.operationKey} -->`
  // repository 由 Host 绑定；日志位于工作树之外，不进入候选或提交。
  const journalRoot = join(dirname(repository), '.dsh-pr-journal')
  async function journal(prepared, phase, value) {
    if (value !== undefined) await mkdir(journalRoot, { recursive: true })
    let rootStat
    try { rootStat = await lstat(journalRoot) }
    catch (error) { if (value === undefined && error.code === 'ENOENT') return null; throw error }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(dirname(journalRoot)) !== await realpath(dirname(repository))) throw executionError('PR_JOURNAL_INVALID')
    const path = join(journalRoot, `${prepared.operationKey}.${phase}.json`)
    const identity = { version: 1, operationKey: prepared.operationKey, preparedDigest: prepared.digest, phase }
    if (value !== undefined) {
      let file
      try { file = await open(path, 'wx'); await file.writeFile(JSON.stringify({ ...identity, ...value })); await file.sync() }
      finally { await file?.close() }
      return
    }
    try {
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw executionError('PR_JOURNAL_INVALID')
      const data = JSON.parse(await readFile(path, 'utf8'))
      if (Object.entries(identity).some(([key, expected]) => data[key] !== expected)) throw executionError('PR_JOURNAL_INVALID')
      if (phase === 'preflight-failed' && (data.observation?.status !== 'failed' || data.observation.phase !== 'preflight'
        || data.observation.mutationAttempted !== false || !Number.isSafeInteger(data.observation.readAttempts)
        || data.observation.readAttempts !== 1
        || !['PR_READBACK_FAILED', 'PR_READBACK_INVALID', 'PR_PERMISSION_DENIED'].includes(data.observation.reason))) throw executionError('PR_JOURNAL_INVALID')
      return data
    } catch (error) { if (error.code === 'ENOENT') return null; throw executionError('PR_JOURNAL_INVALID') }
  }
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (digest !== executionDigest(body) || body.version !== 1 || body.action !== 'pr' || Object.entries(scope).some(([key, value]) => key === 'previousPullRequest'
      ? !body[key] || executionDigest(body[key]) !== executionDigest(value) : body[key] !== value)
      || !/^[a-f0-9]{40}$/.test(body.commitId ?? '') || !/^[a-f0-9]{64}$/.test(body.requirementDigest ?? '')
      || !Number.isSafeInteger(body.generation) || body.generation < 1 || typeof body.runId !== 'string' || !body.runId || typeof body.title !== 'string' || !body.title.trim() || /[\0\r\n]/.test(body.title) || typeof body.body !== 'string'
      || body.operationKey !== executionDigest({ ...scope, runId: body.runId, generation: body.generation, requirementDigest: body.requirementDigest, commitId: body.commitId })
) throw executionError('PR_PREPARED_INVALID')
  }
  function prepare({ runId, generation, requirementDigest, commitId, title, body }) {
    const operationKey = executionDigest({ ...scope, runId, generation, requirementDigest, commitId })
    const value = { version: 1, action: 'pr', ...scope, runId, generation, requirementDigest, commitId, title, body, operationKey }
    const prepared = { ...value, digest: executionDigest(value) }; validate(prepared)
    return prepared
  }
  async function json(args) {
    let result
    try { result = await invoke(command, args, repository) }
    catch (error) {
      if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(error.code)) throw Object.assign(executionError('PR_CONNECTION_FAILED'), { readAttempts: 1 })
      throw error
    }
    if (result.code === 0) {
      try { return JSON.parse(result.stdout) } catch { throw executionError('PR_READBACK_INVALID') }
    }
    const connection = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|TLS handshake timeout|connection reset|i\/o timeout|HTTP (?:429|502|503|504)\b|Could not resolve|connection refused|failed to connect|network is unreachable/i.test(result.stderr)
    const permission = /HTTP (?:401|403)\b|authentication|not authenticated|permission denied|insufficient.*scope|authorization/i.test(result.stderr)
    throw Object.assign(executionError(connection ? 'PR_CONNECTION_FAILED' : permission ? 'PR_PERMISSION_DENIED' : 'PR_READBACK_FAILED'), { readAttempts: 1 })
  }
  async function reconcile(prepared, { allowHeadChange = false, preflight = false } = {}) {
    validate(prepared)
    // 仅回读已存在的完整未发送证据；不得为历史 unknown 创建日志。
    if (!await journal(prepared, 'send-intent')) {
      const failure = await journal(prepared, 'preflight-failed')
      if (failure) {
        if (!await journal(prepared, 'attempt-start') || await journal(prepared, 'send-complete')) throw executionError('PR_JOURNAL_INVALID')
        if (!await journal(prepared, 'send-intent')) return failure.observation
      }
      if (!preflight && await journal(prepared, 'attempt-start') && !await journal(prepared, 'send-complete') && !await journal(prepared, 'send-intent')) {
        return { status: 'failed', phase: 'preflight', mutationAttempted: false, reason: 'PR_PREFLIGHT_NOT_SENT', readAttempts: 1 }
      }
    }
    const query = new URLSearchParams({ state: 'all', head: repo.split('/')[0] + ':' + head, ...(previousPullRequest ? {} : { base }), per_page: '100' })
    const pages = await json(['api', '--paginate', '--slurp', 'repos/' + repo + '/pulls?' + query])
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw executionError('PR_READBACK_INVALID')
    const rows = pages.flat()
    if (rows.some(item => !item || !Number.isSafeInteger(item.number) || typeof item.head?.ref !== 'string' || typeof item.base?.ref !== 'string')) throw executionError('PR_READBACK_INVALID')
    const list = rows.map(item => ({ number: item.number, url: item.html_url, state: item.merged_at ? 'MERGED' : item.state?.toUpperCase(),
      headRefOid: item.head.sha, headRefName: item.head.ref, baseRefName: item.base.ref, body: item.body }))
      .filter(item => item.headRefName === head && (previousPullRequest || item.baseRefName === base))
    if (previousPullRequest) {
      if (list.some(item => item.state === 'OPEN' && item.number !== previousPullRequest.number)) throw executionError('PR_IDENTITY_AMBIGUOUS')
      const current = await json(['pr', 'view', String(previousPullRequest.number), '--repo', repo, '--json', 'number,url,state,headRefOid,headRefName,baseRefName,body'])
      if (current.number !== previousPullRequest.number || current.headRefName !== head
        || typeof current.url !== 'string' || !/^https:\/\//.test(current.url)
        || (!allowHeadChange && current.headRefOid !== prepared.commitId)) throw executionError('PR_PREVIOUS_IDENTITY_CONFLICT')
      if (current.body?.includes(marker(prepared)) && current.baseRefName === base && ['OPEN', 'MERGED'].includes(current.state)) {
        return { status: 'succeeded', number: current.number, url: current.url, state: current.state, commitId: current.headRefOid, repo, head, base }
      }
      if (current.state !== 'OPEN' || current.baseRefName !== previousPullRequest.base
        || !current.body?.includes(`<!-- dsh-operation:${previousPullRequest.operationKey} -->`)) throw executionError('PR_PREVIOUS_IDENTITY_CONFLICT')
      return { status: 'unknown', reason: 'pr_retarget_not_observed', previousNumber: current.number }
    }
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
  async function recoverUnsent(prepared) {
    validate(prepared)
    if (await journal(prepared, 'send-intent') || await journal(prepared, 'send-complete')) return null
    const started = await journal(prepared, 'attempt-start')
    if (!started) return null
    const failure = await journal(prepared, 'preflight-failed')
    if (failure && !['PR_CONNECTION_FAILED', 'PR_PREFLIGHT_NOT_SENT'].includes(failure.observation.reason)) return null
    if (await journal(prepared, 'send-intent') || await journal(prepared, 'send-complete')) return null
    return { operationKey: prepared.operationKey, preparedDigest: prepared.digest, mutationAttempted: false,
      reason: failure?.observation.reason ?? 'PR_PREFLIGHT_NOT_SENT', evidenceRef: join(journalRoot, prepared.operationKey + '.attempt-start.json') }
  }
  async function execute(prepared) {
    validate(prepared)
    if (await journal(prepared, 'send-intent')) {
      try { return await operation.run({}, () => reconcile(prepared)) }
      catch (error) { if (!['PR_READBACK_FAILED', 'PR_READBACK_INVALID', 'PR_PERMISSION_DENIED', 'PR_CONNECTION_FAILED', 'PR_CANCELLED'].includes(error.code)) throw error; return { status: 'unknown', phase: 'after-send-intent', reason: error.code } }
    }
    try { await journal(prepared, 'attempt-start', { createdAt: new Date().toISOString() }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!await journal(prepared, 'attempt-start')) throw executionError('PR_JOURNAL_INVALID')
      const failure = await journal(prepared, 'preflight-failed')
      if (failure) return failure.observation
    }
    let existing
    try {
      existing = await reconcile(prepared, { preflight: true })
      if (existing.status === 'succeeded') return existing
      const branch = await json(['api', `repos/${repo}/git/ref/heads/${head.split('/').map(encodeURIComponent).join('/')}`])
      if (branch.object?.sha !== prepared.commitId) throw executionError('PR_HEAD_CHANGED')
      if (previousPullRequest) {
        const checked = await reconcile(prepared, { preflight: true })
        if (checked.status === 'succeeded') return checked
      }
    } catch (error) {
      if (['PR_READBACK_FAILED', 'PR_READBACK_INVALID', 'PR_PERMISSION_DENIED', 'PR_CONNECTION_FAILED', 'PR_CANCELLED'].includes(error.code)) {
        const observation = { status: 'failed', phase: 'preflight', mutationAttempted: false, reason: error.code, readAttempts: error.readAttempts ?? 1 }
        if (!['PR_CONNECTION_FAILED', 'PR_CANCELLED'].includes(error.code)) await journal(prepared, 'preflight-failed', { observation })
        return observation
      }
      throw error
    }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-')), path = join(directory, 'body.md')
    try {
      await writeFile(path, `${prepared.body}\n\n${marker(prepared)}\n`, { flag: 'wx' })
      try { await journal(prepared, 'send-intent', { createdAt: new Date().toISOString() }) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (!await journal(prepared, 'send-intent')) throw executionError('PR_JOURNAL_INVALID')
        return await reconcile(prepared)
      }
      let completion
      try { const result = await invoke(command, existing.previousNumber ? ['pr', 'edit', String(existing.previousNumber), '--repo', repo,
        ...(previousPullRequest ? ['--base', base] : []), '--title', prepared.title, '--body-file', path] : ['pr', 'create', '--repo', repo, '--base', base, '--head', head, '--title', prepared.title, '--body-file', path], repository); completion = { exitCode: result.code } }
      catch (error) { completion = { reason: error.code ?? 'PR_SEND_UNKNOWN' } }
      await journal(prepared, 'send-complete', { completedAt: new Date().toISOString(), ...(completion ?? { returned: true }) })
      try { return await operation.run({}, () => reconcile(prepared)) }
      catch (error) { if (!['PR_READBACK_FAILED', 'PR_READBACK_INVALID', 'PR_PERMISSION_DENIED', 'PR_CONNECTION_FAILED', 'PR_CANCELLED'].includes(error.code)) throw error; return { status: 'unknown', phase: 'after-send-intent', reason: error.code } }
    } finally { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }); await rmdir(directory) }
  }
  return { prepare, recoverUnsent: async (prepared, context = {}) => { context.signal?.throwIfAborted(); const proof = await recoverUnsent(prepared); context.signal?.throwIfAborted(); return proof }, execute: (prepared, context = {}) => operation.run(context, () => execute(prepared)),
    reconcile: (prepared, context = {}) => operation.run(context, () => reconcile(prepared, context)) }
}
