import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

test('maintenance backup preserves a fixed snapshot while WAL metadata changes', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-backup-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'backup.sqlite')
  const writer = new DatabaseSync(source)
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER,b BLOB); BEGIN')
  const insert = writer.prepare('INSERT INTO t VALUES(?,0,zeroblob(16384))')
  for (let i = 0; i < 4000; i++) insert.run(i)
  writer.exec('COMMIT')
  let writes = 0
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/backup-native-maintenance.mjs', import.meta.url)), source, target], { windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setInterval(() => {
    if (existsSync(target)) { writer.prepare('UPDATE t SET n=n+1 WHERE id=0').run(); writes++ }
  }, 1)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0, stderr)
    assert.equal(JSON.parse(stdout).consistentSQLiteBackup, true)
    assert.ok(writes > 0, 'exercise actual concurrent metadata writes')
    const result = new DatabaseSync(target, { readOnly: true })
    try {
      assert.equal(result.prepare('SELECT COUNT(*) AS n FROM t').get().n, 4000)
      assert.equal(result.prepare('SELECT n FROM t WHERE id=0').get().n, 0)
      assert.equal(result.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    } finally { result.close() }
  } finally {
    clearInterval(timer)
    if (child.exitCode === null) child.kill()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})
