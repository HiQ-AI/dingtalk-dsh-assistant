import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openUatRehearsalReceipts, readUatCatalogBaseline, reviewUatSql,
  verifyUatRows, uatSchemaProofSql, uatCatalogBaselineDigest, uatCatalogBaselineSql,
  uatCatalogBaselineCountSql, narrowVerificationSql } from '../packages/dingtalk-dsh-assistant/workflow-postgres-uat-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const target = { instance: 'postgresql/192.168.8.8:30770', database: 'hiq_editor', environment: 'uat' }
const connection = { host: '192.168.8.8', port: 30770, database: 'hiq_editor', user: 'fixture', password: 'fixture' }
const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1 AND v = 1;'
const verificationSql = 'SELECT v FROM public.t WHERE id = 1'

test('UAT 演练回执跨进程重开后保留未知预留，拒绝重复执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uat-receipt-'))
  try {
    const file = join(dir, 'receipts.sqlite')
    const first = openUatRehearsalReceipts(file)
    assert.equal(await first.begin('op-1', { packageDigest: 'a' }), true)
    first.close()
    const second = openUatRehearsalReceipts(file)
    assert.deepEqual(await second.get('op-1'), { status: 'reserved', intent: { packageDigest: 'a' } })
    assert.equal(await second.begin('op-1', { packageDigest: 'a' }), false)
    await second.complete('op-1', { passed: true, receiptId: 'receipt-1' })
    second.close()
    const third = openUatRehearsalReceipts(file)
    assert.deepEqual(await third.get('op-1'), { passed: true, receiptId: 'receipt-1' })
    await assert.rejects(third.complete('op-1', { passed: true }), /POSTGRES_UAT_RECEIPT_UNKNOWN/u)
    third.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('本地 PostgreSQL 目录生成独立指纹，不冒充 Bytebase schema', async () => {
  const calls = []
  const connect = async (_connection, options) => { calls.push(options); return {
    async query(sql) { if (sql === uatCatalogBaselineCountSql()) return { rows: [{ expected_rows: 1 }] }
      assert.equal(sql, uatCatalogBaselineSql()); return { rows: [{
      schema_name: 'public', table_name: 't', relation_kind: 'r', column_name: 'v',
      data_type: 'integer', not_null: false, default_expression: null }] } },
    async end() {},
  } }
  const baseline = await readUatCatalogBaseline({ connection, project: 'projects/flbn', target, connect })
  assert.equal(baseline.schemaVersion, 'pg-catalog-columns-v1')
  assert.match(baseline.schemaDigest, /^[a-f0-9]{64}$/u)
  assert.equal(baseline.evidenceRef.startsWith('postgres-uat-catalog:'), true)
  assert.deepEqual(calls, [{ readOnly: true }])
  assert.equal(uatCatalogBaselineDigest([{ schema_name: 'public', table_name: 't',
    relation_kind: 'r', column_name: 'v', data_type: 'integer', not_null: false,
    default_expression: null }]), baseline.schemaDigest)
  assert.deepEqual(narrowVerificationSql('SELECT v FROM public.t WHERE id = 1'), {
    schema: 'public', table: 't', column: 'v', whereColumn: 'id', whereValue: '1' })
})

test('SQL 审查只放行单表整数 UPDATE 和同表 SELECT；触发器或额外语句均拒绝', async () => {
  const proof = { schema: 'public', table: 't', relationKind: 'r', rowSecurity: false,
    forceRowSecurity: false, columns: ['id', 'v'].map(name => ({ name, type: 'integer',
      generated: '', identity: '' })), constraints: [], indexes: [], triggers: 0,
    inboundFks: 0, inheritanceLinks: 0, generatedColumns: 0, rules: 0, policies: 0, expressionIndexes: 0,
    unsafeIndexes: 0 }
  assert.throws(() => uatSchemaProofSql('public;DROP TABLE x', 't'), /POSTGRES_UAT_SCHEMA_SCOPE_INVALID/u)
  const connect = async () => ({ async query() { return { rows: [{ proof }] } }, async end() {} })
  const input = { connection, target, applySql, verificationSql, applySqlSha256: sha(applySql), connect }
  assert.equal((await reviewUatSql(input)).transactionSafe, true)
  assert.equal((await reviewUatSql({ ...input, applySql: `${applySql} DELETE FROM public.t;` })).transactionSafe, false)
  assert.equal((await reviewUatSql({ ...input, applySql: 'UPDATE public.t SET v = now() WHERE id = 1;' })).transactionSafe, false)
  assert.equal((await reviewUatSql({ ...input, connect: async () => ({ async query() {
    return { rows: [{ proof: { ...proof, triggers: 1 } }] }
  }, async end() {} }) })).transactionSafe, false)
  assert.equal((await reviewUatSql({ ...input, connect: async () => ({ async query() {
    return { rows: [{ proof: { ...proof, inboundFks: 1 } }] }
  }, async end() {} }) })).transactionSafe, false)
  assert.equal((await reviewUatSql({ ...input, connect: async () => ({ async query() {
    return { rows: [{ proof: { ...proof, unsafeIndexes: 1 } }] }
  }, async end() {} }) })).transactionSafe, false)
})

test('事务内回查必须与显式 JSON 预期逐项一致', () => {
  assert.equal(verifyUatRows({ intent: { operationKey: 'x', expectedChange: '{"rows":[{"v":2}]}' },
    query: { rows: [{ v: 2 }] }, applyResult: { rowCount: 1 } }).passed, true)
  assert.equal(verifyUatRows({ intent: { expectedChange: '{"rows":[{"v":3}]}' },
    query: { rows: [{ v: 2 }] }, applyResult: { rowCount: 1 } }).passed, false)
  assert.equal(verifyUatRows({ intent: { expectedChange: 'v=2' }, query: { rows: [{ v: 2 }] },
    applyResult: { rowCount: 1 } }).passed, false)
  assert.equal(verifyUatRows({ intent: { expectedChange: '{"rows":[{"v":2}]}' },
    query: { rows: [{ v: 2 }] }, applyResult: { rowCount: 0 } }).passed, false)
})
