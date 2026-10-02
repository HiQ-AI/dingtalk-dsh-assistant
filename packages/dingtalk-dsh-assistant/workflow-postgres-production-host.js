import { createHash } from 'node:crypto'
import { executionDigest } from './execution-artifacts.js'
import { simpleNullableColumnDefinition } from './workflow-data-change.js'
import { narrowSql, reviewUatSql, uatCatalogBaselineSql,
  uatCatalogBaselineCountSql, uatCatalogBaselineDigest } from './workflow-postgres-uat-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const databases = new Set(['hiq_editor', 'hiq_background_db', 'hiq_admin'])
const sameTarget = (a, b) => a?.instance === b?.instance && a?.database === b?.database
  && a?.environment === b?.environment

/** 加列验收只允许固定目录投影和三个精确名字，不开放任意 SELECT。 */
export function columnVerificationScope(sql) {
  const match = /^SELECT\s+column_name\s*,\s*data_type\s*,\s*is_nullable\s*,\s*column_default\s*,\s*character_maximum_length\s+FROM\s+information_schema\.columns\s+WHERE\s+table_schema\s*=\s*'([a-z][a-z0-9_]*)'\s+AND\s+table_name\s*=\s*'([a-z][a-z0-9_]*)'\s+AND\s+column_name\s*=\s*'([a-z][a-z0-9_]*)'\s*;?$/iu.exec(sql ?? '')
  return match ? { schema: match[1], table: match[2], column: match[3] } : null
}

/** 生产从库端口仅提供目录/前置条件只读回读，没有任何 SQL 写方法。 */
export function createProductionPostgresHost({ entries, Client }) {
  if (!Array.isArray(entries) || entries.length !== 3 || typeof Client !== 'function'
    || new Set(entries.map(entry => entry.connection?.database)).size !== 3
    || entries.some(entry => !databases.has(entry.connection?.database)
      || entry.project !== 'projects/flbn'
      || entry.target?.instance !== 'instances/flbnpguaf'
      || entry.target?.database !== `instances/flbnpguaf/databases/${entry.connection.database}`
      || entry.target?.environment !== 'production'
      || entry.connection.host !== '101.89.215.147' || Number(entry.connection.port) !== 5432
      || typeof entry.connection.user !== 'string' || !entry.connection.user
      || typeof entry.connection.password !== 'string' || !entry.connection.password))
    throw new Error('POSTGRES_PRODUCTION_TARGET_INVALID')
  const byDatabase = new Map(entries.map(entry => [entry.target.database, entry]))
  const entryFor = (project, target) => {
    const entry = byDatabase.get(target?.database)
    if (project !== entry?.project || !sameTarget(entry.target, target))
      throw new Error('POSTGRES_PRODUCTION_TARGET_NOT_ALLOWED')
    return entry
  }
  const connect = async connection => {
    const client = new Client({ host: connection.host, port: 5432, database: connection.database,
      user: connection.user, password: connection.password, options: '-c default_transaction_read_only=on',
      connectionTimeoutMillis: 10000, statement_timeout: 30000 })
    try {
      await client.connect()
      const identity = await client.query(`SELECT current_database() AS database_name,
        current_setting('transaction_read_only') AS transaction_read_only,
        pg_is_in_recovery() AS in_recovery`)
      if (identity.rows.length !== 1 || identity.rows[0].database_name !== connection.database
        || identity.rows[0].transaction_read_only !== 'on' || identity.rows[0].in_recovery !== true)
        throw Error('identity')
      return client
    } catch {
      await client.end().catch(() => {})
      throw new Error('POSTGRES_PRODUCTION_READ_ONLY_IDENTITY_UNCONFIRMED')
    }
  }
  const getDatabase = async ({ project, target, signal }) => {
    signal?.throwIfAborted()
    const entry = entryFor(project, target)
    const client = await connect(entry.connection)
    try { return { project, ...target } } finally { await client.end() }
  }
  const readBaseline = async ({ project, target, scope = 'current', signal }) => {
    signal?.throwIfAborted()
    const scoped = scope !== 'current'
    if (scoped && (!scope || Object.keys(scope).sort().join(',') !== 'schema,table'
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(scope.schema ?? '')
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(scope.table ?? ''))) throw new Error('POSTGRES_PRODUCTION_SCOPE_INVALID')
    const entry = entryFor(project, target)
    const client = await connect(entry.connection)
    try {
      const sql = uatCatalogBaselineSql(scoped ? scope : undefined)
      const values = scoped ? [scope.schema, scope.table] : undefined
      const countSql = scoped ? uatCatalogBaselineSql(scope, true) : uatCatalogBaselineCountSql()
      const [catalog, count] = await Promise.all([
        client.query(sql, values), client.query(countSql, values),
      ])
      if (count.rows.length !== 1 || count.rows[0].expected_rows !== catalog.rows.length)
        throw new Error('POSTGRES_PRODUCTION_CATALOG_INCOMPLETE')
      if (scoped && catalog.rows.some(row => row.schema_name !== scope.schema || row.table_name !== scope.table))
        throw new Error('POSTGRES_PRODUCTION_SCOPE_UNCONFIRMED')
      const catalogDigest = uatCatalogBaselineDigest(catalog.rows)
      const schemaDigest = scoped ? executionDigest({ scope, catalogDigest }) : catalogDigest
      const schemaVersion = scoped ? 'pg-catalog-table-columns-v1' : 'pg-catalog-columns-v1'
      return { project, target, snapshotId: `${schemaVersion}:${entry.connection.database}:${schemaDigest}`,
        sha256: schemaDigest, schemaVersion, schemaDigest, ...(scoped ? { scope } : {}),
        evidenceRef: `postgres-production-readonly:${target.database}:${schemaDigest}` }
    } finally { await client.end() }
  }
  const checkPreconditions = async ({ project, target, baseline, applySql,
    applySqlSha256, expectedChange, verificationSql, signal }) => {
    signal?.throwIfAborted()
    const entry = entryFor(project, target)
    const column = simpleNullableColumnDefinition(applySql), verification = columnVerificationScope(verificationSql)
    if (column) {
      if (baseline?.scope && (baseline.scope.schema !== column.schema || baseline.scope.table !== column.table)) return { passed: false }
      if (sha(applySql) !== applySqlSha256 || !verification
        || column.schema !== verification.schema || column.table !== verification.table || column.column !== verification.column)
        return { passed: false }
      let expected
      try { expected = JSON.parse(expectedChange) } catch { return { passed: false } }
      const type = column.type.replace(/\s*\(.*$/u, '')
      const dataType = ({ varchar: 'character varying', char: 'character', decimal: 'numeric',
        timestamp: 'timestamp without time zone' })[type] ?? type
      const length = /\(\s*([0-9]+)\s*\)/u.exec(column.type)
      const expectedRow = { column_name: column.column, data_type: dataType, is_nullable: 'YES', column_default: null,
        character_maximum_length: ['varchar', 'character varying', 'char', 'character'].includes(type)
          ? length ? Number(length[1]) : ['char', 'character'].includes(type) ? 1 : null : null }
      if (executionDigest(expected) !== executionDigest({ rows: [expectedRow] })) return { passed: false }
      const client = await connect(entry.connection)
      try {
        const result = await client.query(`SELECT c.relkind AS relation_kind,
          EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = $3
            AND a.attnum > 0 AND NOT a.attisdropped) AS column_exists,
          EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhparent = c.oid) AS has_children
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`, [column.schema, column.table, column.column])
        signal?.throwIfAborted()
        if (result.rows.length !== 1 || !['r', 'p'].includes(result.rows[0].relation_kind)
          || result.rows[0].column_exists !== false || result.rows[0].has_children !== false) return { passed: false }
        const schemaProofDigest = executionDigest({ column, before: result.rows })
        return { passed: true, target, sqlSha256: applySqlSha256, baselineEvidenceRef: baseline.evidenceRef,
          schemaProofDigest, checkId: `postgres-production-column-preconditions:${schemaProofDigest}` }
      } finally { await client.end() }
    }
    const statement = narrowSql(applySql, verificationSql)
    if (!statement || sha(applySql) !== applySqlSha256
      || typeof expectedChange !== 'string') return { passed: false }
    let expected
    try { expected = JSON.parse(expectedChange) } catch { return { passed: false } }
    if (!Array.isArray(expected?.rows)) return { passed: false }
    const actual = await readBaseline({ project, target, scope: 'current', signal })
    if (actual.snapshotId !== baseline?.snapshotId || actual.sha256 !== baseline?.sha256)
      return { passed: false }
    const review = await reviewUatSql({ connection: entry.connection, target,
      applySql, applySqlSha256, verificationSql,
      connect: connection => connect(connection) })
    if (review.transactionSafe !== true || !/^[a-f0-9]{64}$/u.test(review.schemaProofDigest ?? ''))
      return { passed: false }
    return { passed: true, target, sqlSha256: applySqlSha256,
      baselineEvidenceRef: baseline.evidenceRef,
      schemaProofDigest: review.schemaProofDigest,
      checkId: `postgres-production-preconditions:${executionDigest({ target,
        baseline: actual.evidenceRef, applySqlSha256, schemaProofDigest: review.schemaProofDigest })}` }
  }
  const queryVerification = async ({ project, target, sql, expectedChange, packageDigest, taskRunId, signal }) => {
    signal?.throwIfAborted()
    const scope = columnVerificationScope(sql), entry = entryFor(project, target)
    let expected
    try { expected = JSON.parse(expectedChange) } catch { throw new Error('POSTGRES_COLUMN_VERIFICATION_INVALID') }
    const columns = ['column_name', 'data_type', 'is_nullable', 'column_default', 'character_maximum_length']
    if (!scope || !/^[a-f0-9]{64}$/u.test(packageDigest ?? '') || !taskRunId
      || !Array.isArray(expected?.rows) || expected.rows.length !== 1
      || executionDigest(Object.keys(expected.rows[0]).sort()) !== executionDigest([...columns].sort())
      || expected.rows[0].column_name !== scope.column)
      throw new Error('POSTGRES_COLUMN_VERIFICATION_INVALID')
    const client = await connect(entry.connection)
    try {
      // 参数绑定只查询本次列；SQL正文经过固定结构识别后不直接执行。
      const result = await client.query(`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
        FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [scope.schema, scope.table, scope.column])
      signal?.throwIfAborted()
      if (executionDigest(result.rows) !== executionDigest(expected.rows))
        throw new Error('POSTGRES_COLUMN_VERIFICATION_UNCONFIRMED')
      return { passed: true, target, packageDigest, observedChange: JSON.stringify(result.rows),
        readbackId: `postgres-production-column:${executionDigest({ taskRunId, target, rows: result.rows })}` }
    } finally { await client.end() }
  }
  return Object.freeze({ getDatabase, readBaseline, checkPreconditions, queryVerification })
}
