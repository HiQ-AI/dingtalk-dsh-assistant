import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { lifecycleStages } from './fixtures/lifecycle-stages.js'

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
