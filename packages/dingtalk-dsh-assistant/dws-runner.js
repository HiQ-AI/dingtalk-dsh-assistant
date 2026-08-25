import { spawn } from 'node:child_process'

function lineReader(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line !== '') onLine(line)
  })
  stream.on('end', () => { if (buffer !== '') onLine(buffer) })
}

export function createNodeDwsRunner({ executable = 'dws', cwd = process.cwd(), runTimeoutMs = 30_000 } = {}) {
  return {
    cwd,
    spawn(args, hooks = {}) {
      const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      lineReader(child.stdout, hooks.onStdoutLine ?? (() => undefined))
      lineReader(child.stderr, hooks.onStderrLine ?? (() => undefined))
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      return { done, terminate(signal = 'SIGTERM') { return child.kill(signal) } }
    },
    async run(args) {
      const stdout = []
      const stderr = []
      const child = this.spawn(args, { onStdoutLine: (line) => stdout.push(line), onStderrLine: (line) => stderr.push(line) })
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { child.terminate('SIGTERM'); reject(new Error(`dws_command_timeout:${runTimeoutMs}`)) }, runTimeoutMs); timer.unref?.() })
      const result = await Promise.race([child.done, timeout]).finally(() => clearTimeout(timer))
      return { ...result, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
    },
  }
}
