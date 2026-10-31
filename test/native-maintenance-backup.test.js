import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { lifecycleStages } from './fixtures/lifecycle-stages.js'
import { nativeLifecycle, nativeTemporaryDirectory, registerNativeCleanup } from './fixtures/native-lifecycle.js'

test('maintenance backup preserves a fixed snapshot while WAL metadata changes', { timeout: 55000 }, async t => {
  let root, source, target, writer, child, timer, closed
  let writes = 0, stdout = '', stderr = ''
  await lifecycleStages(t, {
    limits: { business: 15000 },
    prepare: async () => {
      root = mkdtempSync(join(tmpdir(), 'maintenance-backup-'))
      source = join(root, 'source.sqlite'); target = join(root, 'backup.sqlite')
      writer = new DatabaseSync(source)
      writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,b BLOB); BEGIN')
      const insert = writer.prepare('INSERT INTO t VALUES(?,0,zeroblob(16384))')
      for (let i = 0; i < 4000; i++) insert.run(i)
      writer.exec('COMMIT')
    },
    business: async (_value, step) => {
      child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/backup-native-maintenance.mjs', import.meta.url)), source, target], { windowsHide: true })
      closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      timer = setInterval(() => {
        if (existsSync(target)) { writer.prepare('UPDATE t SET n=n+1 WHERE id=0').run(); writes++ }
      }, 1)
      const code = await step(() => closed)
      assert.equal(code, 0, stderr)
      assert.equal(JSON.parse(stdout).consistentSQLiteBackup, true)
      assert.ok(writes > 0, 'exercise actual concurrent metadata writes')
      const result = new DatabaseSync(target, { readOnly: true })
      try {
        assert.equal(result.prepare('SELECT COUNT(*) AS n FROM t').get().n, 4000)
        assert.equal(result.prepare('SELECT n FROM t WHERE id=0').get().n, 0)
        assert.equal(result.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      } finally { result.close() }
    },
    cleanup: async () => {
      clearInterval(timer)
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      if (closed) await closed.catch(() => {})
      writer?.close()
      if (root) rmSync(root, { recursive: true, force: true })
      t.diagnostic(JSON.stringify({ writes, childExit: child?.exitCode, childSignal: child?.signalCode, stderr: stderr.slice(-8192) }))
    },
  })
})

for (const phase of ['prepare', 'business']) test(`lifecycle ${phase} deadline fails and prevents subsequent work after drain`, async t => {
  let release, continued = false, cleaned = false
  const blocked = new Promise(resolve => { release = resolve })
  const action = async step => { await step(() => blocked); continued = true }
  await assert.rejects(lifecycleStages(t, {
    limits: { prepare: 20, business: 20, cleanup: 1000 },
    prepare: phase === 'prepare' ? action : async () => {},
    business: phase === 'business' ? (_value, step) => action(step) : async () => { continued = true },
    cleanup: async () => { cleaned = true; release() },
  }), error => error.code === 'TEST_STAGE_TIMEOUT' && error.phase === phase)
  assert.equal(cleaned, true); assert.equal(continued, false)
})

test('lifecycle cleanup has an independent deadline and preserves the original failure', async t => {
  await assert.rejects(lifecycleStages(t, {
    limits: { cleanup: 20 }, prepare: async () => {},
    business: async () => { throw Error('original acceptance failure') },
    cleanup: () => new Promise(() => {}),
  }), error => error instanceof AggregateError && error.errors[0].message === 'original acceptance failure'
    && error.errors[1].phase === 'cleanup')
})

test('lifecycle parent cancellation still drains resources within the cleanup budget', async t => {
  const parent = new AbortController(), failure = Error('outer test cancelled')
  let release, cleaned = false, continued = false
  const blocked = new Promise(resolve => { release = resolve })
  await assert.rejects(lifecycleStages({ signal: parent.signal, diagnostic: message => t.diagnostic(message) }, {
    prepare: async () => {},
    business: async (_value, step) => {
      parent.abort(failure)
      await step(() => blocked); continued = true
    },
    cleanup: async () => { cleaned = true; release() },
  }), error => error === failure)
  assert.equal(cleaned, true); assert.equal(continued, false)
})

test('lifecycle business timeout terminates its child and removes its temporary directory', async t => {
  let root, child, closed, continued = false
  await assert.rejects(lifecycleStages(t, {
    limits: { business: 20, cleanup: 1000 },
    prepare: async () => { root = mkdtempSync(join(tmpdir(), 'stage-child-')) },
    business: async (_value, step) => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
      closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      await step(() => closed); continued = true
    },
    cleanup: async () => { child.kill(); await closed; rmSync(root, { recursive: true, force: true }) },
  }), { code: 'TEST_STAGE_TIMEOUT', phase: 'business' })
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(existsSync(root), false); assert.equal(continued, false)
})

test('native lifecycle preparation cancellation drains a late fixture and never starts business', async t => {
  let root, closed = false, business = false, release, lateHook = false
  const pending = new Promise(resolve => { release = resolve })
  await assert.rejects(nativeLifecycle(1000, async n => {
    root = await nativeTemporaryDirectory(join(tmpdir(), 'native-preparation-contract-'))
    registerNativeCleanup(async () => { closed = true; release() })
    await pending
    n.after(() => { lateHook = true })
    await n.beginBusiness()
    business = true
  }, { prepare: 20, cleanup: 1000 })(t), { code: 'TEST_STAGE_TIMEOUT', phase: 'prepare' })
  assert.equal(closed, true); assert.equal(lateHook, true); assert.equal(business, false)
  assert.equal(existsSync(root), false)
})

test('native lifecycle abort interrupts an await so business finally can release its close gate', async t => {
  const gate = Promise.withResolvers(), events = []
  let closed, continued = false
  await assert.rejects(nativeLifecycle(20, async n => {
    registerNativeCleanup(() => closed ??= gate.promise.then(() => { events.push('close') }))
    n.after(() => { events.push('after-1') })
    n.after(() => { events.push('after-2') })
    await n.beginBusiness()
    try { await n.step(() => gate.promise); continued = true }
    finally { gate.resolve() }
  }, { cleanup: 1000 })(t), { code: 'TEST_STAGE_TIMEOUT', phase: 'business' })
  assert.equal(continued, false)
  assert.deepEqual(events, ['close', 'after-1', 'after-2'])
})

test('native lifecycle cancellation releases teardown gates before closing resources', async t => {
  const gate = Promise.withResolvers(), events = []
  let closing
  await assert.rejects(nativeLifecycle(20, async n => {
    registerNativeCleanup(() => closing ??= gate.promise.then(() => { events.push('close') }))
    n.onCancel(() => { events.push('release'); gate.resolve() })
    n.after(() => { gate.resolve(); events.push('after') })
    await n.beginBusiness()
    await n.step(() => gate.promise)
  }, { cleanup: 1000 })(t), { code: 'TEST_STAGE_TIMEOUT', phase: 'business' })
  assert.deepEqual(events, ['release', 'close', 'after'])
})

test('native lifecycle cleanup timeout stays bounded and does not run later cleanup', async t => {
  let later = false
  await assert.rejects(nativeLifecycle(1000, async n => {
    n.after(() => new Promise(() => {}))
    n.after(() => { later = true })
    await n.beginBusiness()
  }, { cleanup: 20 })(t), { code: 'TEST_STAGE_TIMEOUT', phase: 'cleanup' })
  assert.equal(later, false)
})

test('native lifecycle pre-cancelled parent never invokes the callback', async t => {
  const parent = new AbortController(), reason = Error('parent already cancelled')
  parent.abort(reason)
  let invoked = false
  await assert.rejects(nativeLifecycle(1000, async () => { invoked = true })({
    signal: parent.signal, diagnostic: message => t.diagnostic(message),
  }), error => error === reason)
  assert.equal(invoked, false)
})

test('native lifecycle scopes own only their fresh roots and keep independent FIFO cleanup', async t => {
  const roots = [], events = []
  await Promise.all(['a', 'b'].map(key => nativeLifecycle(1000, async n => {
    const root = await nativeTemporaryDirectory(join(tmpdir(), 'native-scope-' + key + '-'))
    roots.push(root)
    n.after(() => { events.push(key + '-1') }); n.after(() => { events.push(key + '-2') })
    await n.beginBusiness()
    await n.step(() => Promise.resolve())
  })(t)))
  assert.ok(roots.every(root => !existsSync(root)))
  for (const key of ['a', 'b']) assert.deepEqual(events.filter(value => value.startsWith(key)), [key + '-1', key + '-2'])
})

test('native lifecycle onCancel failure still closes resources and preserves cleanup evidence', async t => {
  const pending = Promise.withResolvers(), releaseError = Error('release failed')
  let root, closed = false
  await assert.rejects(nativeLifecycle(20, async n => {
    root = await nativeTemporaryDirectory(join(tmpdir(), 'native-release-failure-'))
    registerNativeCleanup(async () => { closed = true; pending.resolve() })
    n.onCancel(() => { throw releaseError })
    await n.beginBusiness()
    await n.step(() => pending.promise)
  }, { cleanup: 1000 })(t), error => error instanceof AggregateError
    && error.errors[0].phase === 'business' && error.errors[1] instanceof AggregateError
    && error.errors[1].errors.includes(releaseError))
  assert.equal(closed, true)
  assert.equal(existsSync(root), true, 'uncertain cleanup retains its owned directory as evidence')
  rmSync(root, { recursive: true, force: true })
})

test('native nested lifecycle inherits the parent business cancellation without sharing roots', async t => {
  const pending = Promise.withResolvers(), roots = []
  let childClosed = false, continued = false
  await assert.rejects(nativeLifecycle(20, async parent => {
    roots.push(await nativeTemporaryDirectory(join(tmpdir(), 'native-parent-scope-')))
    await parent.beginBusiness()
    await parent.step(() => nativeLifecycle(1000, async child => {
      roots.push(await nativeTemporaryDirectory(join(tmpdir(), 'native-child-scope-')))
      registerNativeCleanup(async () => { childClosed = true; pending.resolve() })
      await child.beginBusiness()
      await child.step(() => pending.promise)
      continued = true
    }, { cleanup: 1000 })(t))
  }, { cleanup: 1000 })(t), { code: 'TEST_STAGE_TIMEOUT', phase: 'business' })
  assert.equal(childClosed, true); assert.equal(continued, false)
  assert.equal(roots.length, 2); assert.ok(roots.every(root => !existsSync(root)))
})
