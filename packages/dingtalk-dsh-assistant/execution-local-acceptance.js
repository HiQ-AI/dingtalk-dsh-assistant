import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile, writeFile, mkdir, realpath, lstat, rename, readdir } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { executionDigest, executionError } from './execution-artifacts.js'
import { readCandidate } from './execution-candidate.js'

const PREFIX = 'LOCAL_ACCEPTANCE_'
const fail = code => { throw Object.assign(executionError(PREFIX + code), code === 'COMMAND_DRAIN_UNCONFIRMED' || code === 'STOP_UNCONFIRMED' ? { executionDrained: false } : {}) }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype
const text = value => typeof value === 'string' && value.trim() && value.length <= 2000
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const unknownExecution = () => Object.assign(executionError(PREFIX + 'EXECUTION_UNKNOWN', '上次本地验收没有完整收据；请先人工核对并清理该任务命名空间及服务进程，再发起新一轮验收。'), { executionDrained: false })
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const commandValid = value => plain(value) && text(value.executable) && Array.isArray(value.args) && value.args.length <= 128
  && value.args.every(arg => typeof arg === 'string' && arg.length <= 4000 && !arg.includes('\0'))

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function optionalJson(path) { try { return await json(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function checkedDirectory(path) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path)) fail('DIRECTORY_UNSAFE')
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await checkedDirectory(path)
}
async function save(path, value) {
  const temporary = path + '.pending'
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}
async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const port = server.address().port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}
async function checkCompanionArtifact(service) {
  const metadata = await lstat(service.artifactPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || canonical(await realpath(service.artifactPath)) !== canonical(service.artifactPath)) fail('COMPANION_ARTIFACT_INVALID')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(service.artifactPath)) digest.update(chunk)
  if (digest.digest('hex') !== service.artifactSha256) fail('COMPANION_ARTIFACT_MISMATCH')
}
async function snapshotFiles(directory, current = directory, generated = []) {
  const result = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('CANDIDATE_MISMATCH')
    const name = relative(directory, path).replaceAll('\\', '/')
    if (entry.isDirectory() && generated.includes(name.toLowerCase())) continue
    if (entry.isDirectory()) result.push(...await snapshotFiles(directory, path, generated))
    else result.push(relative(directory, path).replaceAll('\\', '/'))
  }
  return result.sort()
}
async function powershell(script, maxBuffer = 16384) {
  const started = Date.now()
  return new Promise((resolveResult, reject) => execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000, maxBuffer }, (error, stdout) => {
      if (!error) return resolveResult(stdout.trim())
      const inspectionFailure = { kind: error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'timeout'
        : error.syscall?.startsWith('spawn') ? 'spawn' : 'exit', exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: typeof error.signal === 'string' && /^SIG[A-Z0-9]+$/.test(error.signal) ? error.signal : null, elapsedMs: Date.now() - started }
      reject(Object.assign(executionError(PREFIX + 'PROCESS_INSPECTION_FAILED'), { inspectionFailure }))
    }))
}
async function listening(port, pid) {
  // 服务须直接启动；不能把其他进程的健康端点误作当前候选的验收服务。
  if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED')
  const rows = JSON.parse(await powershell(`$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ${port} | Select-Object LocalAddress,OwningProcess); ConvertTo-Json -InputObject $rows -Compress`))
  return rows.length > 0 && rows.every(row => row.LocalAddress === '127.0.0.1' && row.OwningProcess === pid)
}
export function acceptanceProcessTree(rows, rootPid, launchedAt, closedAt = Infinity) {
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parent) || (row.born !== null && !Number.isSafeInteger(row.born)))) fail('PROCESS_INSPECTION_FAILED')
  if (rows.some(row => row.pid === rootPid && row.born === null)) fail('PROCESS_INSPECTION_FAILED')
  const parents = new Map([[rootPid, launchedAt]]), owned = new Map()
  const root = rows.find(row => row.pid === rootPid && row.born >= launchedAt && row.born <= closedAt)
  if (root) { parents.set(rootPid, root.born); owned.set(rootPid, root) }
  let added
  do {
    added = false
    for (const row of rows) {
      if (parents.has(row.parent) && row.born === null) fail('PROCESS_INSPECTION_FAILED')
      if (row.pid === rootPid || parents.has(row.pid) || !parents.has(row.parent) || row.born < parents.get(row.parent) || (row.parent === rootPid && row.born > closedAt)) continue
      parents.set(row.pid, row.born); owned.set(row.pid, row); added = true
    }
  } while (added)
  return [...owned.values()].map(({ pid, born }) => ({ pid, born }))
}
export function acceptanceProcessesAlive(owned, current) {
  if (owned.some(identity => current.some(row => row.pid === identity.pid && !Number.isSafeInteger(row.born)))) fail('PROCESS_INSPECTION_FAILED')
  return owned.some(identity => current.some(row => row.pid === identity.pid && row.born === identity.born))
}
async function processSnapshot(launchedAt) {
  return JSON.parse(await powershell(`$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { !$_.CreationDate -or ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -ge ${launchedAt} } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; born=$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null})} }) -Compress`, 1024 * 1024))
}
function launch(command, { directory, env, input, signal, service = false }) {
  const launchedAt = Date.now()
  const child = spawn(command.executable, command.args, { cwd: directory, env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false, closedAt = null, reason = null, stopPromise
  const chunks = []
  let finish, rejectCompletion
  const completion = new Promise((resolveDone, reject) => { finish = resolveDone; rejectCompletion = reject })
  const stop = () => stopPromise ??= (async () => {
    if (!child.pid) return closed
    // Windows 保留已退出父进程的 PID；复用同一个数值不能继承旧进程的子孙。
    const rows = await processSnapshot(launchedAt)
    const owned = acceptanceProcessTree(rows, child.pid, launchedAt, closedAt ?? Infinity)
    if (!owned.every(value => Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.born) && value.born >= launchedAt)) return false
    const gone = async () => {
      if (!owned.length) return closed
      return !acceptanceProcessesAlive(owned, await processSnapshot(launchedAt))
    }
    // 父进程退出后只回读，不向可能复用的 PID 或失去所有权的子进程发送终止。
    if (closed) return gone()
    if (!owned.some(identity => identity.pid === child.pid)) return false
    const stopped = await new Promise(resolveStop => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000 }, error => resolveStop(!error)))
    await bounded(completion, 10000)
    if (!stopped || !closed) return false
    return gone()
  })()
  const cancel = code => {
    reason ??= code
    void stop().then(stopped => { if (!stopped) rejectCompletion(Object.assign(executionError(PREFIX + 'COMMAND_DRAIN_UNCONFIRMED'), { executionDrained: false })) }, error => rejectCompletion(error))
  }
  const abort = () => cancel('CANCELLED')
  const complete = code => {
    if (closed) return
    closed = true; closedAt = Date.now(); signal?.removeEventListener('abort', abort)
    finish({ code, reason, stdout: service ? '' : Buffer.concat(chunks).toString('utf8') })
  }
  child.once('error', () => { reason ??= 'COMMAND_FAILED'; complete(null) })
  child.once('close', complete)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    // 持续排空服务与诊断 stderr；业务 stdout 保留完整结果，不能因输出量终止命令。
    if (!service && stream === child.stdout) chunks.push(chunk)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(input) + '\n')
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return { child, completion, stop, get closed() { return closed }, get reason() { return reason } }
}
async function run(command, context) {
  const process = launch(command, context)
  const result = await process.completion
  if (!result) fail('COMMAND_DRAIN_UNCONFIRMED')
  // 即使命令正常退出，也回读子孙进程；不能让遗留写入越过清理收据。
  let stopped
  try { stopped = await process.stop() } catch (error) {
    throw Object.assign(executionError(PREFIX + 'COMMAND_DRAIN_UNCONFIRMED'), { executionDrained: false,
      ...(error.inspectionFailure ? { inspectionFailure: error.inspectionFailure } : {}) })
  }
  if (!stopped) fail('COMMAND_DRAIN_UNCONFIRMED')
  if (result.reason || result.code !== 0) fail(result.reason ?? 'COMMAND_FAILED')
  return result.stdout
}

/** Host 固定命令管理服务生命周期；模型只提供用例参数，不可提供命令和数据库凭据。 */
export function createLocalAcceptanceRunner({ root, config }) {
  if (config === undefined || config === null) return undefined
  const settings = structuredClone(config)
  const generated = settings.generatedOutputDirectories ?? []
  if (!Array.isArray(generated) || generated.some(path => typeof path !== 'string'
    || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path)
    || path.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase())))
    || new Set(generated.map(path => path.toLowerCase())).size !== generated.length) fail('CONFIG_INVALID')
  const generatedNames = generated.map(path => path.toLowerCase())
  if (settings.instructions !== undefined && (typeof settings.instructions !== 'string' || settings.instructions.length > 8000)) fail('CONFIG_INVALID')
  if (!isAbsolute(root ?? '') || !plain(settings) || !text(settings.version) || !isAbsolute(settings.sharedDataProfilePath ?? '')
    || !Array.isArray(settings.prepareSteps) || !settings.prepareSteps.every(commandValid)
    || !commandValid(settings.service) || !settings.service.args.some(arg => arg.includes('{port}'))
    || !settings.service.args.some(arg => arg.includes('127.0.0.1')) || typeof settings.service.readyPath !== 'string'
    || !/^\/(?!\/)[^\r\n#]*$/.test(settings.service.readyPath) || settings.service.readyPath.includes('\\')
    || !Array.isArray(settings.scenarios) || !settings.scenarios.length
    || settings.scenarios.some(item => !commandValid(item) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id ?? '') || !text(item.description))
    || new Set(settings.scenarios.map(item => item.id)).size !== settings.scenarios.length
    || !commandValid(settings.cleanup) || !commandValid(settings.verifyCleanup)
    || settings.timeoutMs !== undefined) fail('CONFIG_INVALID')
  const companions = settings.companionServices ?? []
  if (!Array.isArray(companions) || new Set(companions.map(item => item?.id)).size !== companions.length
    || companions.some(item => !commandValid(item) || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id ?? '') || !isAbsolute(item.artifactPath ?? '')
      || !/^[a-f0-9]{64}$/.test(item.artifactSha256 ?? '') || !item.args.includes(item.artifactPath)
      || !item.args.some(arg => arg.includes('{port}')) || !item.args.some(arg => arg.includes('127.0.0.1'))
      || typeof item.readyPath !== 'string' || !/^\/(?!\/)[^\r\n#]*$/.test(item.readyPath) || item.readyPath.includes('\\'))) fail('CONFIG_INVALID')
  const scenarios = settings.scenarios.map(({ id, description }) => ({ id, description }))
  // 摘要包含整个实现，改动命令执行/清理语义后不能复用之前的验收记录。
  const identity = executionDigest({ configuration: settings, implementation: readFileImplementation() })
  const roots = resolve(root)
  function validatePlan(plan) {
    if (!plain(plan) || !Array.isArray(plan.cases) || !plan.cases.length
      || plan.cases.some(item => !plain(item) || !text(item.criterionId) || !scenarios.some(scenario => scenario.id === item.scenarioId)
        || !text(item.expected) || !Array.isArray(item.steps) || !item.steps.length || !item.steps.every(text) || !plain(item.parameters))
      || new Set(plan.cases.map(item => item.criterionId)).size !== plan.cases.length) fail('PLAN_INVALID')
  }
  function paths(prepared) {
    if (!prepared || !/^[a-f0-9]{64}$/.test(prepared.identity ?? '')) fail('PREPARED_INVALID')
    const control = join(roots, prepared.identity)
    return { control, directory: join(control, 'candidate'), preparedPath: join(control, 'prepared.json'), receiptPath: join(control, 'receipt.json') }
  }
  async function trustedPrepared(prepared) {
    const location = paths(prepared)
    await checkedDirectory(location.control)
    const stored = await json(location.preparedPath)
    const supplied = Object.fromEntries(Object.keys(stored).map(key => [key, prepared[key]]))
    if (executionDigest(stored) !== executionDigest(supplied) || stored.directory !== location.directory || stored.runnerIdentity !== identity) fail('PREPARED_MISMATCH')
    return location
  }
  async function profile() {
    const path = settings.sharedDataProfilePath
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size > 65536 || metadata.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path)) fail('DATA_PROFILE_UNSAFE')
    const value = await json(path)
    if (!plain(value) || value.environment !== 'uat' || !plain(value.env) || !Object.keys(value.env).length
      || Object.entries(value.env).some(([key, entry]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof entry !== 'string' || entry.includes('\0'))
      || Buffer.byteLength(JSON.stringify(value)) > 65536) fail('DATA_PROFILE_INVALID')
    return value.env
  }
  async function verifySourceManifest(prepared) {
    const manifest = await json(join(paths(prepared).control, 'snapshot-files.json'))
    if (executionDigest(manifest) !== prepared.manifestDigest) fail('CANDIDATE_MISMATCH')
    const originalPaths = manifest.map(file => file.path).filter(path => !generatedNames.some(directory => path.toLowerCase().startsWith(directory + '/'))).sort()
    if (executionDigest(await snapshotFiles(prepared.directory, prepared.directory, generatedNames)) !== executionDigest(originalPaths)) fail('CANDIDATE_MISMATCH')
    // 依赖、编译产物允许新增；冻结的原始文件不能被构建/用例/清理改写或替换。
    for (const file of manifest) {
      const path = join(prepared.directory, file.path)
      try {
        if (canonical(await realpath(path)) !== canonical(path) || (await lstat(path)).isSymbolicLink()
          || hash(await readFile(path)) !== file.hash) fail('CANDIDATE_MISMATCH')
      } catch { fail('CANDIDATE_MISMATCH') }
    }
  }
  return { identity, scenarios: structuredClone(scenarios), ...(settings.instructions === undefined ? {} : { instructions: settings.instructions }),
    async prepare({ candidate, plan, taskId, runId, generation, uatEnvironment, signal }) {
      if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED')
      signal?.throwIfAborted(); validatePlan(plan)
      if (!text(taskId) || !text(runId) || !Number.isSafeInteger(generation) || generation < 1 || !/^uat[1-9]$/.test(uatEnvironment ?? '')) fail('CONTEXT_INVALID')
      const profileDigest = executionDigest(await profile())
      for (const companion of companions) await checkCompanionArtifact(companion)
      const snapshot = await readCandidate(candidate, { signal })
      if (candidate.generation !== generation) fail('CANDIDATE_MISMATCH')
      const planDigest = executionDigest(plan), runIdentity = executionDigest({ runner: identity, candidate: candidate.digest, planDigest, taskId, runId, generation, uatEnvironment })
      const manifest = []
      for (const file of snapshot.files) manifest.push({ path: file.path, hash: hash(await snapshot.readFile(file.path)) })
      const prepared = { identity: runIdentity, runnerIdentity: identity, candidateDigest: candidate.digest, planDigest, profileDigest, taskId, runId, generation, manifestDigest: executionDigest(manifest),
        directory: join(roots, runIdentity, 'candidate'), namespace: `acceptance-${runIdentity.slice(0, 32)}`,
        uatEnvironment, dataEnvironment: 'shared-uat', plan: structuredClone(plan) }
      const { control, preparedPath } = paths(prepared)
      await privateDirectory(roots); await privateDirectory(control)
      const existing = await optionalJson(preparedPath)
      if (existing) { if (executionDigest(existing) !== executionDigest(prepared)) fail('PREPARED_MISMATCH'); return existing }
      // 中断的物化不可作为完整候选继续；目录占用需人工检查，不覆盖已有文件。
      try { await mkdir(prepared.directory, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') fail('PREPARATION_INCOMPLETE'); throw error }
      for (const file of snapshot.files) {
        signal?.throwIfAborted()
        const path = join(prepared.directory, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, await snapshot.readFile(file.path), { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 })
      }
      await save(join(control, 'snapshot-files.json'), manifest)
      await save(preparedPath, prepared)
      return prepared
    },
    async execute(prepared, { signal } = {}) {
      prepared = structuredClone(prepared)
      const { control, receiptPath } = await trustedPrepared(prepared)
      const prior = await optionalJson(receiptPath)
      if (prior) {
        if (prior.identity !== prepared.identity || prior.candidateDigest !== prepared.candidateDigest || prior.planDigest !== prepared.planDigest) fail('RECEIPT_MISMATCH')
        return prior
      }
      const reservationPath = join(control, 'execution-reserved.json')
      try { await lstat(reservationPath); throw unknownExecution() } catch (error) { if (error.code !== 'ENOENT') throw error }
      const manifest = await json(join(control, 'snapshot-files.json'))
      if (executionDigest(manifest) !== prepared.manifestDigest) fail('CANDIDATE_MISMATCH')
      if (executionDigest(await snapshotFiles(prepared.directory)) !== executionDigest(manifest.map(file => file.path).sort())) fail('CANDIDATE_MISMATCH')
      for (const file of manifest) {
        const path = join(prepared.directory, file.path)
        if (canonical(await realpath(path)) !== canonical(path) || (await lstat(path)).isSymbolicLink() || hash(await readFile(path)) !== file.hash) fail('CANDIDATE_MISMATCH')
      }
      for (const companion of companions) await checkCompanionArtifact(companion)
      // 预约先于一切共享库写入。进程崩溃后不能靠重试重新执行有副作用的用例。
      try { await writeFile(reservationPath, JSON.stringify({ identity: prepared.identity, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw unknownExecution(); throw error }
      const result = { identity: prepared.identity, candidateDigest: prepared.candidateDigest, planDigest: prepared.planDigest,
        namespace: prepared.namespace, directory: prepared.directory, uatEnvironment: prepared.uatEnvironment, dataEnvironment: 'shared-uat',
        baseUrl: null, passed: false, checks: [], phases: [], cleanup: { dataCleaned: false, processStopped: true } }
      let service, environment, failure, context, cleanupCompleted = false
      const companionProcesses = []
      const phase = async (id, title, work) => {
        const start = Date.now(), record = { id, title, status: 'failed', elapsedMs: 0 }; result.phases.push(record)
        try { const value = await work(); record.status = 'succeeded'; return value }
        catch (error) { if (error.inspectionFailure) { record.inspectionFailure = error.inspectionFailure; result.inspectionFailure = error.inspectionFailure } throw error }
        finally { record.elapsedMs = Date.now() - start }
      }
      const checkCancellation = () => signal?.throwIfAborted()
      try {
        environment = await profile()
        if (executionDigest(environment) !== prepared.profileDigest) fail('DATA_PROFILE_CHANGED')
        const port = await freePort(); result.baseUrl = `http://127.0.0.1:${port}`
        context = { namespace: prepared.namespace, baseUrl: result.baseUrl, uatEnvironment: prepared.uatEnvironment, plan: prepared.plan }
        if (companions.length) { context.services = {}; result.services = context.services }
        const commandContext = () => ({ directory: prepared.directory, env: { ...process.env, ...environment }, input: context, signal })
        const ready = async (process, port, readyPath) => {
          while (true) {
            checkCancellation()
            if (process.closed || process.reason) fail('SERVICE_EXITED')
            let response
            try { response = await fetch(new URL(readyPath, `http://127.0.0.1:${port}`), { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]) }) } catch { /* 就绪前只做无凭据 HTTP 轮询。 */ }
            if (response) {
              await response.body?.cancel()
              if (response.ok) {
                if (!await listening(port, process.child.pid) || process.closed || process.reason) fail('SERVICE_IDENTITY_CHANGED')
                return
              }
            }
            await pause(250)
          }
        }
        await phase('prepare', '准备本地验收环境', async () => { for (const command of settings.prepareSteps) await run(command, commandContext()) })
        await verifySourceManifest(prepared)
        for (const companion of companions) {
          await phase(`start-${companion.id}`, `启动本地依赖服务 ${companion.id}`, async () => {
            await checkCompanionArtifact(companion)
            let companionPort
            while (!companionPort) {
              signal?.throwIfAborted()
              const allocated = await freePort()
              if (allocated !== port && companionProcesses.every(item => item.port !== allocated)) companionPort = allocated
              else await pause(250)
            }
            const process = launch({ ...companion, args: companion.args.map(arg => arg.replaceAll('{port}', String(companionPort))) },
              { ...commandContext(), signal: undefined, service: true })
            companionProcesses.push({ id: companion.id, process, port: companionPort })
            result.cleanup.processStopped = false
            context.services[companion.id] = { baseUrl: `http://127.0.0.1:${companionPort}`, artifactSha256: companion.artifactSha256 }
            await ready(process, companionPort, companion.readyPath)
          })
        }
        await phase('start', '启动本地候选服务', async () => {
          // 取消业务用例后仍给 finally 留出清理 API 的服务窗口；最终始终核对停止结果。
          service = launch({ ...settings.service, args: settings.service.args.map(arg => arg.replaceAll('{port}', String(port))) },
            { ...commandContext(), signal: undefined, service: true })
          result.cleanup.processStopped = false
          await ready(service, port, settings.service.readyPath)
        })
        await phase('cases', '执行本地业务验收', async () => {
          for (const item of prepared.plan.cases) {
            if (service.closed || service.reason || !await listening(port, service.child.pid)) fail('SERVICE_IDENTITY_CHANGED')
            for (const companion of companionProcesses) if (companion.process.closed || companion.process.reason || !await listening(companion.port, companion.process.child.pid)) fail('SERVICE_IDENTITY_CHANGED')
            const command = settings.scenarios.find(scenario => scenario.id === item.scenarioId)
            let actual = null
            const output = await run(command, { ...commandContext(), input: { namespace: prepared.namespace, baseUrl: result.baseUrl, uatEnvironment: prepared.uatEnvironment, case: item, ...(context.services ? { services: context.services } : {}) } })
            let parsed
            try { parsed = JSON.parse(output) } catch { fail('SCENARIO_RESULT_INVALID') }
            if (parsed.namespace !== prepared.namespace || parsed.baseUrl !== result.baseUrl || !text(parsed.actual)) fail('SCENARIO_RESULT_INVALID')
            if (Object.values(environment).some(value => value.length > 0 && parsed.actual.includes(value))) fail('SCENARIO_SECRET_OUTPUT')
            actual = parsed.actual
            result.checks.push({ criterionId: item.criterionId, scenarioId: item.scenarioId, steps: item.steps, expected: item.expected, actual, passed: actual === item.expected })
          }
          if (result.checks.some(check => !check.passed)) fail('EXPECTATION_MISMATCH')
        })
      } catch (error) {
        failure = error.code?.startsWith(PREFIX) ? error.code : PREFIX + (signal?.aborted ? 'CANCELLED' : 'EXECUTION_FAILED')
        if (error.executionDrained === false) result.executionDrained = false
      }
      finally {
        if (environment && context) {
          try {
            await phase('cleanup', '清理任务验收数据', async () => {
              const cleanupContext = { directory: prepared.directory, env: { ...process.env, ...environment }, input: context }
              await run(settings.cleanup, cleanupContext)
              cleanupCompleted = true
            })
          } catch (error) { failure = PREFIX + 'CLEANUP_UNCONFIRMED'; if (error.executionDrained === false) result.executionDrained = false }
        }
        if (service) {
          try { await phase('stop', '停止本地验收服务', async () => { if (!await service.stop()) fail('STOP_UNCONFIRMED'); result.cleanup.processStopped = true }) }
          catch { failure = PREFIX + 'STOP_UNCONFIRMED' }
        }
        let companionsStopped = true
        for (const companion of [...companionProcesses].reverse()) {
          try { await phase(`stop-${companion.id}`, `停止本地依赖服务 ${companion.id}`, async () => { if (!await companion.process.stop()) fail('STOP_UNCONFIRMED') }) }
          catch { companionsStopped = false; failure = PREFIX + 'STOP_UNCONFIRMED' }
        }
        if (companionProcesses.length) result.cleanup.processStopped = (!service || result.cleanup.processStopped) && companionsStopped
        if (cleanupCompleted && result.cleanup.processStopped && result.executionDrained !== false) {
          try {
            await phase('verify-cleanup', '回读共享 UAT 数据清理结果', async () => {
              // 服务停止后直接读共享数据库，避免服务后台任务在清理核对后再次写入。
              const raw = await run(settings.verifyCleanup, { directory: prepared.directory, env: { ...process.env, ...environment }, input: context })
              let receipt; try { receipt = JSON.parse(raw) } catch { fail('CLEANUP_UNCONFIRMED') }
              if (receipt.namespace !== prepared.namespace || receipt.empty !== true) fail('CLEANUP_UNCONFIRMED')
              if (receipt.mode !== undefined || receipt.createdResources !== undefined) {
                if (receipt.mode !== 'read-only' || receipt.createdResources !== 0) fail('CLEANUP_UNCONFIRMED')
                result.cleanup.mode = 'read-only'; result.cleanup.createdResources = 0
              }
              result.cleanup.dataCleaned = true
            })
          } catch (error) { failure = PREFIX + 'CLEANUP_UNCONFIRMED'; if (error.executionDrained === false) result.executionDrained = false }
        }
      }
      try { await verifySourceManifest(prepared) } catch (error) { failure ??= error.code }
      result.passed = !failure && result.checks.length === prepared.plan.cases.length && result.checks.every(check => check.passed)
        && result.cleanup.dataCleaned && result.cleanup.processStopped
      if (!result.passed) result.failureCode = failure ?? PREFIX + 'INCOMPLETE'
      if (result.cleanup.processStopped !== true || failure === PREFIX + 'COMMAND_DRAIN_UNCONFIRMED') result.executionDrained = false
      await save(receiptPath, result)
      return result
    },
    async readReceipt(prepared) {
      const { receiptPath } = await trustedPrepared(prepared), receipt = await optionalJson(receiptPath)
      if (receipt && (receipt.identity !== prepared.identity || receipt.candidateDigest !== prepared.candidateDigest || receipt.planDigest !== prepared.planDigest)) fail('RECEIPT_MISMATCH')
      return receipt
    },
    async assertPassed(prepared, receipt) {
      const { receiptPath } = await trustedPrepared(prepared), trusted = await optionalJson(receiptPath)
      const supplied = trusted && receipt && Object.fromEntries(Object.keys(trusted).map(key => [key, receipt[key]]))
      if (!trusted || !supplied || executionDigest(trusted) !== executionDigest(supplied) || trusted.identity !== prepared.identity
        || trusted.candidateDigest !== prepared.candidateDigest || trusted.planDigest !== prepared.planDigest) fail('RECEIPT_INVALID')
      if (trusted.cleanup?.dataCleaned !== true || trusted.cleanup?.processStopped !== true) fail('CLEANUP_UNCONFIRMED')
      if (trusted.passed !== true) fail('FAILED')
      await verifySourceManifest(prepared)
      return true
    }
  }
}

// 同步读取源码只用于构造规则身份，不读取环境配置或凭据。
function readFileImplementation() { return readFileSync(fileURLToPath(import.meta.url), 'utf8') }
