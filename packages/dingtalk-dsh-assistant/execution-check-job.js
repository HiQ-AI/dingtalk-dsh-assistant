import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

/** 只解释已保存的执行记录，不把检查器内部名称当作业务结论。 */
export function describeVerificationChecks(verification) {
  return (verification?.checks ?? []).map((check, index) => {
    let log
    try { log = JSON.parse(check.log) } catch { /* 自定义检查器可能只保存纯文本。 */ }
    const steps = (Array.isArray(log?.steps) ? log.steps : []).map((step, stepIndex) => {
      const args = Array.isArray(step.args) ? step.args : []
      const skippedTests = args.some(arg => /^-D(?:skipTests|maven\.test\.skip)(?:=true)?$/.test(arg))
      const title = args.includes('package') ? 'Java 项目打包'
        : args.includes('install') || args.includes('ci') ? '安装项目依赖'
          : args.includes('build') ? '构建项目'
            : args.includes('test') ? '执行项目测试' : `执行配置检查 ${stepIndex + 1}`
      return { title: skippedTests ? `${title}（跳过测试）` : title, passed: step.exitCode === 0 && !step.reason, elapsedMs: step.elapsedMs,
        ...(skippedTests ? { limitation: '此命令跳过了测试，不能作为测试通过的证据' } : {}) }
    })
    return { title: steps.length ? steps.map(step => step.title).join('、') : `配置检查 ${index + 1}`,
      passed: check.passed === true, steps,
      limitation: steps.length ? '以上仅代表已执行命令的结果；业务验收须有对应验证记录' : '历史记录没有检查内容说明，无法确定验证范围' }
  })
}

const encodeOutput = bytes => {
  const value = bytes.toString('utf8')
  // 可读文本JSON比base64更大时使用base64，保留原始字节并限制编码膨胀。
  const encoded = bytes.toString('base64')
  return Buffer.from(value, 'utf8').equals(bytes) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) && Buffer.byteLength(JSON.stringify(value)) <= encoded.length + 2
    ? { value, encoding: 'utf8' } : { value: encoded, encoding: 'base64' }
}

/** 固定Host检查命令；只把冻结候选物化到独立目录，不运行模型提供的argv。 */
export function createVerificationJobCheck(config) { return verificationJobCheck(config) }

function verificationJobCheck({ id, version, root, executable, args, steps, ...unsupported }, captureResult = false) {
  if (steps !== undefined && (executable !== undefined || args !== undefined)) throw executionError('VERIFY_JOB_CONFIG_INVALID')
  const commands = structuredClone(steps ?? [{ executable, args }])
  if (![id, version].every(value => typeof value === 'string' && value) || !isAbsolute(root ?? '') || !Array.isArray(commands) || !commands.length
    || commands.some(command => typeof command.executable !== 'string' || !command.executable || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string')
      || command.timeoutMs !== undefined)
    || unsupported.timeoutMs !== undefined) throw executionError('VERIFY_JOB_CONFIG_INVALID')
  return { id, version, configurationDigest: executionDigest({ id, version, root, commands, captureResult }), async run(snapshot, { signal } = {}) {
    signal?.throwIfAborted()
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'verify-'))
    for (const file of snapshot.files) {
      signal?.throwIfAborted()
      const path = join(directory, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, await snapshot.readFile(file.path), { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 })
    }
    const startedAt = new Date().toISOString(), start = Date.now()
    const results = []; let outputBytes = 0, resultOutput
    for (const command of commands) {
      signal?.throwIfAborted()
      const stepStart = Date.now(), stepStartedAt = new Date(stepStart).toISOString()
      const result = await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: directory, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = [], stderr = [], completeStdout = []
      let bytes = 0, reason = null, terminationError = null, killPromise = Promise.resolve(), drainTimer
      const unconfirmed = () => {
        const error = executionError('VERIFY_JOB_DRAIN_UNCONFIRMED', terminationError ?? 'Process tree did not close after termination')
        error.executionDrained = false
        reject(error)
      }
      const stop = value => {
        if (reason) return
        reason = value
        drainTimer = setTimeout(unconfirmed, 15000)
        killPromise = new Promise(done => {
          if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, error => { if (error) terminationError = String(error.message); done() })
          else { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') terminationError = String(error.message) } done() }
        })
      }
      const onAbort = () => stop('cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      for (const [stream, out] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
        bytes += chunk.length
        // 末步业务 JSON 独立完整采集；诊断截断不影响实际值核验。
        if (captureResult && command === commands.at(-1) && out) completeStdout.push(chunk)
        const retained = stdout.reduce((n, value) => n + value.length, 0) + stderr.reduce((n, value) => n + value.length, 0)
        const available = Math.max(0, 32768 - outputBytes - retained)
        if (available) { if (out) stdout.push(chunk.subarray(0, available)); else stderr.push(chunk.subarray(0, available)) }
      })
      child.once('error', error => { clearTimeout(drainTimer); signal?.removeEventListener('abort', onAbort); reject(error) })
      child.once('close', async (exitCode, exitSignal) => {
        signal?.removeEventListener('abort', onAbort); await killPromise; clearTimeout(drainTimer)
        if (terminationError) return unconfirmed()
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr), encodedOut = encodeOutput(out), encodedErr = encodeOutput(err)
        if (captureResult && command === commands.at(-1)) resultOutput = Buffer.concat(completeStdout).toString('utf8')
        resolve({ exitCode, signal: exitSignal, reason, terminationError, stdout: encodedOut.value, stdoutEncoding: encodedOut.encoding, stderr: encodedErr.value, stderrEncoding: encodedErr.encoding, outputBytes: out.length + err.length, observedOutputBytes: bytes, outputTruncated: bytes > out.length + err.length })
      })
      })
      results.push({ ...command, ...result, startedAt: stepStartedAt, elapsedMs: Date.now() - stepStart }); outputBytes += result.outputBytes
      if (result.exitCode !== 0 || result.reason !== null) break
    }
    const result = results.at(-1)
    return { passed: results.length === commands.length && results.every(result => result.exitCode === 0 && result.reason === null),
      log: JSON.stringify({ candidateDigest: snapshot.candidateDigest, directory, exitCode: result.exitCode, reason: result.reason, startedAt, elapsedMs: Date.now() - start, steps: results }), ...(captureResult ? { resultOutput } : {}) }
  } }
}

/** Host 固定验收项；命令退出成功且实际值匹配预期才通过。 */
export function createBusinessAcceptanceCheck({ criterion, expected, ...config }) {
  if (![criterion, expected].every(value => typeof value === 'string' && value.trim())) throw executionError('ENGINEERING_ACCEPTANCE_CONFIG_INVALID')
  const check = verificationJobCheck(config, true)
  return { ...check, configurationDigest: executionDigest({ command: check.configurationDigest, implementation: check.run.toString(), criterion, expected }), async run(snapshot, context) {
    const result = await check.run(snapshot, context), log = JSON.parse(result.log)
    let actual = null
    try {
      const parsed = JSON.parse(result.resultOutput)
      if (typeof parsed.actual === 'string') actual = parsed.actual
    } catch { /* 无结构化实际值时验收不通过。 */ }
    const passed = result.passed && actual !== null && actual === expected
    log.acceptance = { criterion, expected, actual, passed }
    return { passed, log: JSON.stringify(log) }
  } }
}
