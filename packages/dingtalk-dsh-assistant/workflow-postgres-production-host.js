import { createHash } from 'node:crypto'
import { executionDigest } from './execution-artifacts.js'
import { narrowSql, reviewUatSql, uatCatalogBaselineSql,
  uatCatalogBaselineCountSql, uatCatalogBaselineDigest } from './workflow-postgres-uat-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const databases = new Set(['hiq_editor', 'hiq_background_db', 'hiq_admin'])
const sameTarget = (a, b) => a?.instance === b?.instance && a?.database === b?.database
  && a?.environment === b?.environment

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
    if (scope !== 'current') throw new Error('POSTGRES_PRODUCTION_SCOPE_INVALID')
    const entry = entryFor(project, target)
    const client = await connect(entry.connection)
    try {
      const [catalog, count] = await Promise.all([
        client.query(uatCatalogBaselineSql()), client.query(uatCatalogBaselineCountSql()),
      ])
      if (count.rows.length !== 1 || count.rows[0].expected_rows !== catalog.rows.length)
        throw new Error('POSTGRES_PRODUCTION_CATALOG_INCOMPLETE')
      const schemaDigest = uatCatalogBaselineDigest(catalog.rows)
      return { project, target, snapshotId: `pg-catalog-columns-v1:${entry.connection.database}:${schemaDigest}`,
        sha256: schemaDigest, schemaVersion: 'pg-catalog-columns-v1', schemaDigest,
        evidenceRef: `postgres-production-readonly:${target.database}:${schemaDigest}` }
    } finally { await client.end() }
  }
  const checkPreconditions = async ({ project, target, baseline, applySql,
    applySqlSha256, expectedChange, verificationSql, signal }) => {
    signal?.throwIfAborted()
    const entry = entryFor(project, target)
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
  return Object.freeze({ getDatabase, readBaseline, checkPreconditions })
}
