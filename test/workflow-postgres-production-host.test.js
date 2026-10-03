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

test('精确表基线只读取参数化表目录，拒绝伪造范围及目录错表', async () => {
  let wrongTable = false
  const queries = [], scope = { schema: 'public', table: 't' }
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true }] }
      assert.deepEqual(values, ['public', 't'])
      assert.ok(sql.includes('n.nspname = $1 AND c.relname = $2'))
      if (sql.startsWith('SELECT count(')) return { rows: [{ expected_rows: 1 }] }
      return { rows: wrongTable ? [{ ...catalog[0], table_name: 'other' }] : catalog }
    }
  }
  const port = createProductionPostgresHost({ entries, Client }), args = { project: 'projects/flbn', target: target('hiq_editor'), scope }
  const result = await port.readBaseline(args)
  assert.deepEqual(result.scope, scope)
  assert.equal(result.schemaVersion, 'pg-catalog-table-columns-v1')
  assert.equal(queries.some(row => row.sql === uatCatalogBaselineSql() || row.sql === uatCatalogBaselineCountSql()), false)
  await assert.rejects(port.readBaseline({ ...args, scope: { ...scope, column: 'name' } }), /POSTGRES_PRODUCTION_SCOPE_INVALID/)
  await assert.rejects(port.readBaseline({ ...args, scope: { ...scope, table: 't;drop' } }), /POSTGRES_PRODUCTION_SCOPE_INVALID/)
  wrongTable = true
  await assert.rejects(port.readBaseline(args), /POSTGRES_PRODUCTION_SCOPE_UNCONFIRMED/)
})

test('简单加列只核对精确表列，真实从库回读完整列属性，拒绝已存在列和错误验收', async () => {
  const queries = [], expectedRow = { column_name: 'label', data_type: 'character varying', is_nullable: 'YES',
    column_default: null, character_maximum_length: null }
  let columnExists = false, observed = expectedRow
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true }] }
      if (sql.includes('AS column_exists')) return { rows: [{ relation_kind: 'r', column_exists: columnExists, has_children: false }] }
      if (sql.includes('FROM information_schema.columns')) return { rows: [observed] }
      throw Error('UNEXPECTED_BROAD_QUERY')
    }
  }
  const port = createProductionPostgresHost({ entries, Client })
  const sql = 'ALTER TABLE public.t ADD COLUMN label character varying;'
  const verificationSql = "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't' AND column_name = 'label'"
  const args = { project: 'projects/flbn', target: target('hiq_editor'), baseline: { evidenceRef: 'baseline' },
    applySql: sql, applySqlSha256: sha(sql), verificationSql, expectedChange: JSON.stringify({ rows: [expectedRow] }) }
  assert.equal((await port.checkPreconditions(args)).passed, true)
  assert.deepEqual(queries.at(-1).values, ['public', 't', 'label'])
  assert.equal(queries.some(row => row.sql === uatCatalogBaselineSql()), false)
  columnExists = true
  assert.equal((await port.checkPreconditions(args)).passed, false)
  const verify = { project: args.project, target: args.target, sql: verificationSql,
    expectedChange: args.expectedChange, packageDigest: 'a'.repeat(64), taskRunId: 'task-run-1' }
  assert.equal((await port.queryVerification(verify)).passed, true)
  observed = { ...expectedRow, is_nullable: 'NO' }
  await assert.rejects(port.queryVerification(verify), /POSTGRES_COLUMN_VERIFICATION_UNCONFIRMED/)
  await assert.rejects(port.queryVerification({ ...verify, sql: verificationSql + '; DROP TABLE public.t' }), /POSTGRES_COLUMN_VERIFICATION_INVALID/)
})

test('整型常量默认值前置核对与回查保持真实默认表达式，拒绝值漂移及表达式', async () => {
  let row
  const queries = []
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database, transaction_read_only: 'on', in_recovery: true }] }
      assert.deepEqual(values, ['public', 't', 'is_deleted'])
      if (sql.includes('AS column_exists')) return { rows: [{ relation_kind: 'r', column_exists: false, has_children: false }] }
      if (sql.includes('information_schema.columns')) return { rows: [row] }
      throw Error('UNEXPECTED_QUERY')
    }
  }
  const host = createProductionPostgresHost({ entries, Client })
  for (const [type, value, expression] of [['integer', '0', '0'], ['smallint', '-1', "'-1'::integer"],
    ['bigint', '9223372036854775807', "'9223372036854775807'::bigint"]]) {
    row = { column_name: 'is_deleted', data_type: type, is_nullable: 'YES', column_default: expression, character_maximum_length: null }
    const applySql = `ALTER TABLE public.t ADD COLUMN is_deleted ${type} DEFAULT ${value};`
    const sql = "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='t' AND column_name='is_deleted';"
    const args = { project: 'projects/flbn', target: target('hiq_editor'), baseline: { evidenceRef: 'baseline', scope: { schema: 'public', table: 't' } },
      applySql, applySqlSha256: sha(applySql), verificationSql: sql, expectedChange: JSON.stringify({ rows: [row] }) }
    assert.equal((await host.checkPreconditions(args)).passed, true)
    const verify = { project: args.project, target: args.target, sql, expectedChange: args.expectedChange, packageDigest: sha('pkg'), taskRunId: 'run-1' }
    assert.equal((await host.queryVerification(verify)).observedChange, JSON.stringify([row]))
    for (const column_default of [null, '1', '0+0', 'random()', "'0'::numeric"]) {
      assert.equal((await host.checkPreconditions({ ...args, expectedChange: JSON.stringify({ rows: [{ ...row, column_default }] }) })).passed, false)
    }
    row = { ...row, column_default: null }
    await assert.rejects(host.queryVerification(verify), /POSTGRES_COLUMN_VERIFICATION_UNCONFIRMED/)
  }
  assert.equal(queries.some(({ sql }) => /^\s*(ALTER|UPDATE|INSERT|DELETE|CREATE)/iu.test(sql)), false)
  assert.equal(queries.some(({ sql }) => sql === uatCatalogBaselineSql()), false)
})

test('生产从库端口只提供目录及验收只读方法，并对每次连接核验从库身份', async () => {
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
  assert.deepEqual(Object.keys(port), ['getDatabase', 'readBaseline', 'checkPreconditions', 'queryVerification'])
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

test('明确单列删除只读核对存在与依赖，拒绝自动依赖、继承及超出范围的 SQL', async () => {
  const safe = { relation_kind: 'r', identity_kind: '', generated_kind: '', has_inheritance: false, has_dependencies: false }
  let observed = [safe]
  const queries = []
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true }] }
      assert.deepEqual(values, ['public', 't', 'label'])
      assert.match(sql, /d\.refobjsubid = a\.attnum/)
      assert.doesNotMatch(sql, /d\.deptype|COUNT\(|FROM public\./i)
      assert.match(sql, /h\.inhparent = c\.oid OR h\.inhrelid = c\.oid/)
      return { rows: observed }
    }
  }
  const port = createProductionPostgresHost({ entries, Client })
  const sql = 'ALTER TABLE public.t DROP COLUMN label;'
  const args = { project: 'projects/flbn', target: target('hiq_editor'), baseline: { evidenceRef: 'baseline', scope: { schema: 'public', table: 't' } },
    applySql: sql, applySqlSha256: sha(sql), expectedChange: '{"rows":[]}',
    verificationSql: "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't' AND column_name = 'label'" }
  const receipt = await port.checkPreconditions(args)
  assert.equal(receipt.passed, true);assert.equal(receipt.baselineEvidenceRef, 'baseline')
  assert.match(receipt.checkId, /^postgres-production-drop-column-preconditions:/)
  for (const rows of [[], [safe, safe], ...[{ relation_kind: 'p' }, { identity_kind: 'a' }, { generated_kind: 's' },
    { has_inheritance: true }, { has_dependencies: true }].map(change => [{ ...safe, ...change }])]) {
    observed = rows
    assert.equal((await port.checkPreconditions(args)).passed, false)
  }
  observed = [safe]
  const before = queries.length
  for (const change of [
    { baseline: { ...args.baseline, scope: { schema: 'public', table: 'other' } } },
    { applySqlSha256: 'a'.repeat(64) }, { expectedChange: '{"rows":[{}]}' },
    { expectedChange: '{"rows":[],"columnEmpty":true}' },
    { verificationSql: args.verificationSql.replace("column_name = 'label'", "column_name = 'other'") },
    ...['ALTER TABLE public.t DROP COLUMN label CASCADE;', 'ALTER TABLE public.t DROP COLUMN IF EXISTS label;',
      'ALTER TABLE public.t DROP COLUMN label; DROP TABLE public.t;'].map(applySql => ({ applySql, applySqlSha256: sha(applySql) })),
  ]) assert.equal((await port.checkPreconditions({ ...args, ...change })).passed, false)
  assert.equal(queries.length, before)
})

test('删除列验收同一只读目录快照确认表仍存在与列消失，拒绝整表消失', async () => {
  let observed = [{ relation_kind: 'r', column_exists: false, columns: [] }]
  const queries = []
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push(sql)
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database,
        transaction_read_only: 'on', in_recovery: true }] }
      assert.deepEqual(values, ['public', 't', 'label'])
      assert.match(sql, /FROM information_schema\.columns/)
      assert.match(sql, /FROM pg_class c JOIN pg_namespace/)
      return { rows: observed }
    }
  }
  const port = createProductionPostgresHost({ entries, Client })
  const args = { project: 'projects/flbn', target: target('hiq_editor'), expectedChange: '{"rows":[]}',
    packageDigest: 'a'.repeat(64), taskRunId: 'delete-task-run',
    sql: "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't' AND column_name = 'label'" }
  const receipt = await port.queryVerification(args)
  assert.equal(receipt.passed, true);assert.equal(receipt.observedChange, '[]')
  assert.equal(queries.length, 2)
  for (const rows of [[], [{ relation_kind: 'v', column_exists: false, columns: [] }],
    [{ relation_kind: 'r', column_exists: true, columns: [] }],
    [{ relation_kind: 'r', column_exists: true, columns: [{ column_name: 'label' }] }]]) {
    observed = rows
    await assert.rejects(port.queryVerification(args), /POSTGRES_COLUMN_VERIFICATION_UNCONFIRMED/)
  }
  const before = queries.length
  await assert.rejects(port.queryVerification({ ...args, sql: args.sql + '; DROP TABLE public.t;' }), /POSTGRES_COLUMN_VERIFICATION_INVALID/)
  assert.equal(queries.length, before)
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
