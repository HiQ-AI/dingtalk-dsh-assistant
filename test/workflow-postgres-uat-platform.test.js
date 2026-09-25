import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPostgresUatPlatform } from '../packages/dingtalk-dsh-assistant/workflow-postgres-uat-platform.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const project = 'projects/flbn'
const target = { instance: 'postgresql/192.168.8.8:30770', database: 'hiq_editor', environment: 'uat' }
const connection = { host: '192.168.8.8', port: 30770, database: 'hiq_editor', user: 'fixture', password: 'fixture' }
const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1 AND v = 1;'
const queries = []
const receipts = new Map()
function fixture(overrides = {}) {
  const store = { durable: true, async get(key) { return receipts.get(key) },
    async begin(key, identity) { if (receipts.has(key)) return false; receipts.set(key, { pending: true, identity }); return true },
    async complete(key, value) { receipts.set(key, value) } }
  return createPostgresUatPlatform({ connections: [{ project, target, connection }],
    connect: async () => ({ async query(sql) { queries.push(sql)
      if (sql.startsWith('SELECT current_database()')) return { rows: [{ database_name: target.database }] }
      return { rows: [{ v: 2 }] } }, async end() { queries.push('END_CONNECTION') } }),
    baselineReader: async () => ({ project, target, snapshotId: 'uat-snapshot', sha256: sha('snapshot'),
      schemaVersion: '42', schemaDigest: sha('schema'), evidenceRef: 'trusted:uat-baseline' }),
    preconditionReader: async args => ({ passed: true, target, sqlSha256: args.applySqlSha256,
      baselineEvidenceRef: args.baseline.evidenceRef, checkId: 'trusted:precondition' }),
    sqlReview: async args => ({ transactionSafe: true, target, sqlSha256: args.applySqlSha256,
      reviewId: 'trusted:transaction-safe-review' }),
    verify: async () => ({ passed: true, observedChange: 'v=2', readbackId: 'readback-1' }),
    receiptStore: store, ...overrides })
}
const intent = { project, uatTarget: target, sourceTarget: { instance: 'instances/flbnpguaf',
  database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' },
  operationKey: 'operation-1', applySql, applySqlSha256: sha(applySql),
  verificationSql: 'SELECT v FROM public.t WHERE id = 1', packageDigest: sha('package'),
  productionBaseline: { evidenceRef: 'bytebase:baseline' },
  uatBaseline: { evidenceRef: 'trusted:uat-baseline', schemaVersion: '42', schemaDigest: sha('schema') } }

test('UAT 端口限定精确连接、受信审核和持久效果账', async () => {
  assert.throws(() => fixture({ receiptStore: {} }), { code: 'POSTGRES_UAT_PORT_NOT_CONFIGURED' })
  const port = fixture()
  assert.deepEqual(await port.getDatabase({ project, target }), { project, ...target })
  await assert.rejects(port.getDatabase({ project, target: { ...target, database: 'hiq_admin' } }),
    { code: 'POSTGRES_UAT_TARGET_NOT_ALLOWED' })
  const baseline = await port.readBaseline({ project, target, scope: 'current' })
  assert.equal(baseline.schemaDigest, sha('schema'))
  const precondition = await port.checkPreconditions({ project, target, baseline,
    applySql, applySqlSha256: sha(applySql) })
  assert.equal(precondition.passed, true)
})

test('演练在同一事务回查并回滚，未知结果不重新执行', async () => {
  queries.length = 0; receipts.clear()
  const port = fixture()
  const result = await port.rehearseInUat(intent)
  assert.equal(result.passed, true)
  assert.deepEqual(queries.slice(0, -1), ['BEGIN', 'SET LOCAL statement_timeout = 30000',
    applySql, intent.verificationSql, 'ROLLBACK'])
  assert.equal((await port.getUatRehearsalByOperationKey({ project, operationKey: intent.operationKey })).receiptId,
    result.receiptId)
  const count = queries.length
  assert.equal((await port.rehearseInUat(intent)).receiptId, result.receiptId)
  assert.equal(queries.length, count)
  receipts.set('unknown-operation', { pending: true })
  await assert.rejects(port.rehearseInUat({ ...intent, operationKey: 'unknown-operation' }),
    { code: 'POSTGRES_UAT_OPERATION_UNKNOWN' })
  assert.equal(queries.length, count)
})

test('未证实事务安全或验证失败时没有成功回执', async () => {
  queries.length = 0; receipts.clear()
  const unsafe = fixture({ sqlReview: async () => ({ transactionSafe: false }) })
  await assert.rejects(unsafe.rehearseInUat(intent), { code: 'POSTGRES_UAT_SQL_NOT_TRANSACTION_SAFE' })
  assert.equal(queries.length, 0)
  const failed = fixture({ verify: async () => ({ passed: false }) })
  await assert.rejects(failed.rehearseInUat(intent), { code: 'POSTGRES_UAT_VERIFICATION_UNCONFIRMED' })
  assert.equal(queries.includes('ROLLBACK'), true)
  assert.equal(await failed.getUatRehearsalByOperationKey({ project, operationKey: intent.operationKey }), null)
  await assert.rejects(failed.rehearseInUat(intent), { code: 'POSTGRES_UAT_OPERATION_UNKNOWN' })
})
