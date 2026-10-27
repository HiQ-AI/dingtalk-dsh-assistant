import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
if (existsSync(process.argv[3])) throw Error('DEPLOY_BACKUP_ALREADY_EXISTS')
const db = new DatabaseSync(process.argv[2], { readOnly: true })
try {
  await backup(db, process.argv[3])
  const check = new DatabaseSync(process.argv[3], { readOnly: true })
  try {
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('DEPLOY_BACKUP_CORRUPT')
  } finally { check.close() }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(process.argv[3])) hash.update(chunk)
  console.log(JSON.stringify({ backupCreated: true, consistentSQLiteBackup: true, sha256: hash.digest('hex') }))
} finally { db.close() }
