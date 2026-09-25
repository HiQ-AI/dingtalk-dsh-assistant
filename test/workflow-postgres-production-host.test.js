import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createProductionPostgresHost } from '../packages/dingtalk-dsh-assistant/workflow-postgres-production-host.js'
import { uatCatalogBaselineSql, uatCatalogBaselineCountSql,
  uatSchemaProofSql } from '../packages/dingtalk-dsh-assistant/workflow-postgres-uat-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const names = ['hiq_editor', 'hiq_background_db', 'hiq_admin']
const target = name => ({ instance: 'instances/flbnpguaf',
  database: `instances/flbnpguaf/databases/${name}`, environment: 'production' })
const entries = names.map(name => ({ project: 'projects/flbn', target: target(name),
  connection: { host: '101.89.215.147', port: 5432, database: name,
    user: 'fixture', password: 'secret' } }))
const catalog = [{ schema_name: 'public', table_name: 't', relation_kind: 'r',
  column_name: 'v', data_type: 'integer', not_null: false, default_expression: null }]
const proof = { schema: 'public', table: 't', relationKind: 'r', rowSecurity: false,
  forceRowSecurity: false, columns: ['v', 'id'].map(name => ({ name, type: 'integer',
    generated: '', identity: '' })), constraints: [], indexes: [], triggers: 0,
  inboundFks: 0, inheritanceLinks: 0, generatedColumns: 0,
  rules: 0, policies: 0, expressionIndexes: 0, unsafeIndexes: 0 }
const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1;'
const verificationSql = 'SELECT v FROM public.t WHERE id = 1'

test('生产从库端口只提供三项只读方法，并对每次连接核验从库身份', async () => {
  const opened = [], statements = []
  class Client {
    constructor(options) { opened.push(options); this.options = options }
    async connect() {}
    async query(sql) {
      statements.push(sql)
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true }] }
      if (sql === uatCatalogBaselineSql()) return { rows: catalog }
      if (sql === uatCatalogBaselineCountSql()) return { rows: [{ expected_rows: 1 }] }
      if (sql === uatSchemaProofSql('public', 't')) return { rows: [{ proof }] }
      throw Error('unexpected query')
    }
    async end() {}
  }
  const port = createProductionPostgresHost({ entries, Client })
  assert.deepEqual(Object.keys(port), ['getDatabase', 'readBaseline', 'checkPreconditions'])
  assert.deepEqual(await port.getDatabase({ project: 'projects/flbn', target: target('hiq_editor') }),
    { project: 'projects/flbn', ...target('hiq_editor') })
  const baseline = await port.readBaseline({ project: 'projects/flbn', target: target('hiq_editor') })
  assert.equal(baseline.schemaVersion, 'pg-catalog-columns-v1')
  const preconditions = await port.checkPreconditions({ project: 'projects/flbn',
    target: target('hiq_editor'), baseline, applySql, applySqlSha256: sha(applySql),
    expectedChange: '{"rows":[{"v":2}]}', verificationSql })
  assert.equal(preconditions.passed, true)
  assert.match(preconditions.schemaProofDigest, /^[a-f0-9]{64}$/u)
  assert.equal(opened.every(options => options.options === '-c default_transaction_read_only=on'), true)
  assert.equal(statements.filter(sql => sql.includes('pg_is_in_recovery()')).length, opened.length)
  await assert.rejects(port.getDatabase({ project: 'projects/flbn', target: target('other') }),
    /POSTGRES_PRODUCTION_TARGET_NOT_ALLOWED/u)
})

test('主库或读写会话身份不符时拒绝，且不读取基线', async () => {
  for (const override of [{ in_recovery: false }, { transaction_read_only: 'off' },
    { database_name: 'other' }]) {
    const statements = []
    class Client {
      constructor(options) { this.options = options }
      async connect() {}
      async query(sql) { statements.push(sql); return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true, ...override }] } }
      async end() {}
    }
    const port = createProductionPostgresHost({ entries, Client })
    await assert.rejects(port.readBaseline({ project: 'projects/flbn', target: target('hiq_admin') }),
      /POSTGRES_PRODUCTION_READ_ONLY_IDENTITY_UNCONFIRMED/u)
    assert.equal(statements.length, 1)
  }
})

test('拒绝错误目标、错误凭据范围和不完整目录结果', async () => {
  assert.throws(() => createProductionPostgresHost({ entries: [entries[0], entries[0], entries[2]],
    Client: class {} }), /POSTGRES_PRODUCTION_TARGET_INVALID/u)
  const bad = entries.map(entry => ({ ...entry, connection: { ...entry.connection } }))
  bad[0].connection.host = 'other'
  assert.throws(() => createProductionPostgresHost({ entries: bad, Client: class {} }),
    /POSTGRES_PRODUCTION_TARGET_INVALID/u)
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async query(sql) { if (sql.includes('pg_is_in_recovery()')) return { rows: [{
      database_name: this.options.database, transaction_read_only: 'on', in_recovery: true }] }
      if (sql === uatCatalogBaselineSql()) return { rows: catalog }
      return { rows: [{ expected_rows: 2 }] }
    }
    async end() {}
  }
  const port = createProductionPostgresHost({ entries, Client })
  await assert.rejects(port.readBaseline({ project: 'projects/flbn', target: target('hiq_admin') }),
    /POSTGRES_PRODUCTION_CATALOG_INCOMPLETE/u)
})
