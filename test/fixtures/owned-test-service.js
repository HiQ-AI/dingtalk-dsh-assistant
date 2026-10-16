import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { after } from 'node:test'
import { isAbsolute, relative, resolve } from 'node:path'

const registrations = new Set()
const originalSpawn = childProcess.spawn
const childModule = new URL('./owned-test-service-child.js', import.meta.url).href
let installed = false

function matches(template, actual) {
  if (!Array.isArray(actual) || template.length !== actual.length) return false
  return template.every((arg, index) => arg.includes('{port}')
    ? new RegExp('^' + arg.split('{port}').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[0-9]+') + '$').test(actual[index])
    : arg === actual[index])
}

async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned test service did not close')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export function trackTestService(t, service, root) {
  assert.equal(service.executable, process.execPath, 'Only synthetic Node test services may use this fixture')
  assert.ok(isAbsolute(root), 'Service owner must supply its isolated fixture root')
  const registration = { root: resolve(root), args: [...service.args], children: [] }
  registrations.add(registration)
  if (!installed) {
    installed = true
    childProcess.spawn = function (command, args, options) {
      const owner = command === process.execPath && [...registrations].find(row => {
        const path = relative(row.root, resolve(options?.cwd ?? process.cwd()))
        return path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path) && matches(row.args, args)
      })
      if (!owner) return Reflect.apply(originalSpawn, this, [command, args, options])
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
      const token = randomUUID()
      const env = options.env ?? process.env
      const child = Reflect.apply(originalSpawn, this, [command, args, { ...options,
        stdio: [...options.stdio, 'ipc'], env: { ...env, DSH_TEST_SERVICE_TOKEN: token,
          NODE_OPTIONS: [env.NODE_OPTIONS, `--import="${childModule}"`].filter(Boolean).join(' ') } }])
      const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
      owner.children.push({ child, token, closed })
      return child
    }
    syncBuiltinESMExports()
  }
  t.after(async () => {
    try {
      const results = await Promise.allSettled(registration.children.map(async ({ child, token, closed }) => {
        if (child.exitCode !== null || child.signalCode !== null) { await bounded(closed, 5000); return }
        try {
          assert.ok(child.connected, 'Owned test service lost its lifecycle channel')
          await new Promise((resolve, reject) => child.send({ type: 'dsh-test-service-close', token }, error => error ? reject(error) : resolve()))
          assert.deepEqual(await bounded(closed, 5000), { code: 0, signal: null }, 'Test service must close naturally')
        } catch (error) {
          child.kill() // Only this test's retained ChildProcess handle; never a PID lookup.
          await bounded(closed, 5000).catch(() => {})
          throw error
        }
      }))
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, 'Owned test service cleanup failed')
    } finally { registrations.delete(registration) }
  })
}

after(() => {
  assert.equal(registrations.size, 0, 'All test service owners must finish cleanup')
  if (installed) { childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
})
