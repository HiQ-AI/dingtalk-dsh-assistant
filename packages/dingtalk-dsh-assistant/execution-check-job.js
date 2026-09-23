import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

/** 固定Host检查命令；只把冻结候选物化到独立目录，不运行模型提供的argv。 */
export function createVerificationJobCheck({ id, version, root, executable, args, steps, timeoutMs = 120000 }) {
  if (steps !== undefined && (executable !== undefined || args !== undefined)) throw executionError('VERIFY_JOB_CONFIG_INVALID')
  const commands = structuredClone(steps ?? [{ executable, args }])
  if (![id, version].every(value => typeof value === 'string' && value) || !isAbsolute(root ?? '') || !Array.isArray(commands) || !commands.length || commands.length > 8
    || commands.some(command => typeof command.executable !== 'string' || !command.executable || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string'))
    || Buffer.byteLength(JSON.stringify(commands)) > 8000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw executionError('VERIFY_JOB_CONFIG_INVALID')
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
      if (Date.now() - start >= timeoutMs) { results.push({ ...command, exitCode: null, reason: 'timeout', stdout: '', stderr: '' }); break }
      const result = await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: directory, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', bytes = 0, reason = null, terminationError = null, killPromise = Promise.resolve(), drainTimer
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
      const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs - (Date.now() - start)))
      for (const [stream, out] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
        bytes += chunk.length
        if (bytes + outputBytes > 20000) return stop('output_limit')
        if (out) stdout += chunk; else stderr += chunk
      })
      child.once('error', error => { clearTimeout(timer); clearTimeout(drainTimer); signal?.removeEventListener('abort', onAbort); reject(error) })
      child.once('close', async (exitCode, exitSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await killPromise; clearTimeout(drainTimer)
        if (terminationError) return unconfirmed()
        resolve({ exitCode, signal: exitSignal, reason, terminationError, stdout, stderr })
      })
      })
      results.push({ ...command, ...result }); outputBytes += Buffer.byteLength(result.stdout + result.stderr)
      if (result.exitCode !== 0 || result.reason !== null) break
    }
    const result = results.at(-1)
    return { passed: results.length === commands.length && results.every(result => result.exitCode === 0 && result.reason === null),
      log: JSON.stringify({ candidateDigest: snapshot.candidateDigest, directory, startedAt, elapsedMs: Date.now() - start, ...result, ...(commands.length > 1 ? { steps: results } : {}) }) }
  } }
}
