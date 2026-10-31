import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

test('maintenance backup preserves a fixed snapshot while WAL metadata changes', { timeout: 15000 }, async t => {
  const started = performance.now()
  let phase = 'initialization', child, timer, closed
  let writes = 0, stdout = '', stderr = ''
  const mark = next => { phase = next; t.diagnostic(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), writes })) }
  const describe = () => t.diagnostic(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), writes, pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) }))
  const abort = () => { describe(); clearInterval(timer); if (child && child.exitCode === null && child.signalCode === null) child.kill() }
  t.signal.addEventListener('abort', abort, { once: true })
  const root = mkdtempSync(join(tmpdir(), 'maintenance-backup-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'backup.sqlite')
  const writer = new DatabaseSync(source)
  let cleanupPromise
  const cleanup = () => cleanupPromise ??= (async () => {
    clearInterval(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    if (closed) await closed.catch(() => {})
    writer.close()
    rmSync(root, { recursive: true, force: true })
    t.signal.removeEventListener('abort', abort)
    mark('cleanup-complete')
  })()
  t.after(cleanup)
  try {
    mark('seed-start')
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,b BLOB); BEGIN')
    const insert = writer.prepare('INSERT INTO t VALUES(?,0,zeroblob(16384))')
    for (let i = 0; i < 4000; i++) insert.run(i)
    writer.exec('COMMIT')
    mark('seed-complete')
    t.signal.throwIfAborted()
    const script = new URL('../scripts/backup-native-maintenance.mjs', import.meta.url).href
    const entry = `process.argv.splice(1, 0, 'backup-diagnostic-wrapper'); console.error('backup-child-start'); await import(${JSON.stringify(script)}); console.error('backup-child-complete')`
    child = spawn(process.execPath, ['--input-type=module', '-e', entry, source, target], { windowsHide: true })
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    mark('child-spawned')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    let targetSeen = false
    timer = setInterval(() => {
      if (existsSync(target)) { if (!targetSeen) { targetSeen = true; mark('target-created') }; writer.prepare('UPDATE t SET n=n+1 WHERE id=0').run(); writes++ }
    }, 1)
    const code = await closed
    mark('child-closed')
    t.signal.throwIfAborted()
    assert.equal(code, 0, stderr)
    assert.equal(JSON.parse(stdout).consistentSQLiteBackup, true)
    assert.ok(writes > 0, 'exercise actual concurrent metadata writes')
    const result = new DatabaseSync(target, { readOnly: true })
    try {
      assert.equal(result.prepare('SELECT COUNT(*) AS n FROM t').get().n, 4000)
      assert.equal(result.prepare('SELECT n FROM t WHERE id=0').get().n, 0)
      assert.equal(result.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    } finally { result.close() }
    mark('verified')
  } catch (error) {
    describe()
    throw error
  } finally {
    await cleanup()
  }
})
