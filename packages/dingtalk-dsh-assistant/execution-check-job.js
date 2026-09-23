import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

const encodeOutput = bytes => {
  const value = bytes.toString('utf8')
  // 可读文本JSON比base64更大时使用base64，保留原始字节并限制编码膨胀。
  const encoded = bytes.toString('base64')
  return Buffer.from(value, 'utf8').equals(bytes) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) && Buffer.byteLength(JSON.stringify(value)) <= encoded.length + 2
    ? { value, encoding: 'utf8' } : { value: encoded, encoding: 'base64' }
}

/** 固定Host检查命令；只把冻结候选物化到独立目录，不运行模型提供的argv。 */
export function createVerificationJobCheck({ id, version, root, executable, args, steps, timeoutMs = 120000 }) {
  if (steps !== undefined && (executable !== undefined || args !== undefined)) throw executionError('VERIFY_JOB_CONFIG_INVALID')
  const commands = structuredClone(steps ?? [{ executable, args }])
  if (![id, version].every(value => typeof value === 'string' && value) || !isAbsolute(root ?? '') || !Array.isArray(commands) || !commands.length || commands.length > 8
    || commands.some(command => typeof command.executable !== 'string' || !command.executable || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string')
      || (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 1800000)))
    || Buffer.byteLength(JSON.stringify({ root, commands })) > 8000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2400000) throw executionError('VERIFY_JOB_CONFIG_INVALID')
  return { id, version, configurationDigest: executionDigest({ id, version, root, commands, timeoutMs }), async run(snapshot, { signal } = {}) {
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
    const results = []; let outputBytes = 0
    for (const command of commands) {
      signal?.throwIfAborted()
      const stepStart = Date.now(), stepStartedAt = new Date(stepStart).toISOString(), remainingMs = timeoutMs - (stepStart - start)
      if (remainingMs <= 0) { results.push({ ...command, startedAt: stepStartedAt, elapsedMs: 0, budgetMs: 0, timeoutScope: 'check', exitCode: null, reason: 'timeout', stdout: '', stderr: '' }); break }
      // 未声明单步预算时沿用原有共享总预算语义；显式单步预算不能借后续步骤延长。
      const budgetMs = Math.min(command.timeoutMs ?? timeoutMs, remainingMs), timeoutScope = budgetMs === remainingMs ? 'check' : 'step'
      const result = await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: directory, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = [], stderr = []
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
      const timer = setTimeout(() => stop('timeout'), Math.max(1, budgetMs - (Date.now() - stepStart)))
      for (const [stream, out] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
        bytes += chunk.length
        if (bytes + outputBytes > 32768) return stop('output_limit')
        if (out) stdout.push(chunk); else stderr.push(chunk)
      })
      child.once('error', error => { clearTimeout(timer); clearTimeout(drainTimer); signal?.removeEventListener('abort', onAbort); reject(error) })
      child.once('close', async (exitCode, exitSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await killPromise; clearTimeout(drainTimer)
        if (terminationError) return unconfirmed()
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr), encodedOut = encodeOutput(out), encodedErr = encodeOutput(err)
        resolve({ exitCode, signal: exitSignal, reason, terminationError, stdout: encodedOut.value, stdoutEncoding: encodedOut.encoding, stderr: encodedErr.value, stderrEncoding: encodedErr.encoding, outputBytes: out.length + err.length })
      })
      })
      results.push({ ...command, ...result, startedAt: stepStartedAt, elapsedMs: Date.now() - stepStart, budgetMs, timeoutScope: result.reason === 'timeout' ? timeoutScope : null }); outputBytes += result.outputBytes
      if (result.exitCode !== 0 || result.reason !== null) break
    }
    const result = results.at(-1)
    return { passed: results.length === commands.length && results.every(result => result.exitCode === 0 && result.reason === null),
      log: JSON.stringify({ candidateDigest: snapshot.candidateDigest, directory, exitCode: result.exitCode, reason: result.reason, timeoutScope: result.timeoutScope, startedAt, elapsedMs: Date.now() - start, timeoutMs, steps: results }) }
  } }
}
