import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

// A read-only snapshot check remains a mandatory gate before owner recovery.
// Only the scanning work moves off the Host event loop; no check is omitted.
let db
try {
  db = new DatabaseSync(workerData.dbPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000; BEGIN;')
  const check = db.prepare('PRAGMA quick_check').get()
  if (check.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('DYNAMIC_STORE_CORRUPT')
  db.exec('ROLLBACK')
  parentPort.postMessage({ ok: true })
} catch {
  // SQLite errors can contain paths or row data. Return a stable public code only.
  parentPort.postMessage({ ok: false, code: 'DYNAMIC_STORE_CORRUPT' })
} finally { db?.close() }
