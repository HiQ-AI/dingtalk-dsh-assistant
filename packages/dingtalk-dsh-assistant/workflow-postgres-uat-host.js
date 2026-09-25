import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { createPostgresUatPlatform } from './workflow-postgres-uat-platform.js'
import { executionDigest } from './execution-artifacts.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const exactName = value => /^[a-z][a-z0-9_]*$/u.test(value ?? '')
const allowedDatabases = new Set(['hiq_editor', 'hiq_background_db', 'hiq_admin'])
const updatePattern = /^UPDATE ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) SET ([a-z][a-z0-9_]*) = (-?[0-9]+) WHERE ([a-z][a-z0-9_]*) = (-?[0-9]+)(?: AND ([a-z][a-z0-9_]*) = (-?[0-9]+))?;?$/u
const selectPattern = /^SELECT ([a-z][a-z0-9_]*) FROM ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) WHERE ([a-z][a-z0-9_]*) = (-?[0-9]+);?$/u

export function narrowSql(applySql, verificationSql) {
  const update = updatePattern.exec(applySql ?? '')
  const select = selectPattern.exec(verificationSql ?? '')
  if (!update || !select || update[1] !== select[2] || update[2] !== select[3]
    || update[3] !== select[1] || update[5] !== select[4] || update[6] !== select[5]) return null
  return { schema: update[1], table: update[2], columns: [update[3], update[5], update[7]].filter(Boolean) }
}

export function narrowVerificationSql(verificationSql) {
  const match = selectPattern.exec(verificationSql ?? '')
  return match ? { schema: match[2], table: match[3], column: match[1],
    whereColumn: match[4], whereValue: match[5] } : null
}

/** 两端同一只读查询，固定排序用于比较全库关系列结构。 */
export function uatCatalogBaselineSql() {
  return `SELECT n.nspname AS schema_name, c.relname AS table_name,
    c.relkind AS relation_kind, a.attname AS column_name, a.atttypid::regtype::text AS data_type,
    a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY n.nspname, c.relname, a.attnum`
}

export function uatCatalogBaselineCountSql() {
  return `SELECT count(*)::integer AS expected_rows FROM (
    ${uatCatalogBaselineSql().replace(/ORDER BY n\.nspname, c\.relname, a\.attnum$/u, '')}
  ) AS catalog_rows`
}

export function uatCatalogBaselineDigest(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(row =>
    !exactName(row?.schema_name) || !exactName(row?.table_name)
    || !['r', 'p', 'v', 'm'].includes(row.relation_kind)
    || !exactName(row.column_name) || typeof row.data_type !== 'string' || !row.data_type
    || typeof row.not_null !== 'boolean'
    || (row.default_expression !== null && typeof row.default_expression !== 'string')))
    throw new Error('POSTGRES_UAT_CATALOG_INVALID')
  return executionDigest(rows)
}

/** 生产 Bytebase 只读查询与本地 UAT 必须逐字使用同一目录查询和 canonical JSON。 */
export function uatSchemaProofSql(schema, table) {
  if (!exactName(schema) || !exactName(table)) throw new Error('POSTGRES_UAT_SCHEMA_SCOPE_INVALID')
  return `SELECT jsonb_build_object(
    'schema', n.nspname, 'table', c.relname, 'relationKind', c.relkind,
    'rowSecurity', c.relrowsecurity, 'forceRowSecurity', c.relforcerowsecurity,
    'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'notNull', a.attnotnull, 'generated', a.attgenerated, 'identity', a.attidentity,
      'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum), '[]'::jsonb)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
    'constraints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', k.conname, 'kind', k.contype, 'definition', pg_get_constraintdef(k.oid))
      ORDER BY k.conname), '[]'::jsonb) FROM pg_constraint k WHERE k.conrelid = c.oid),
    'indexes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', i.relname, 'definition', pg_get_indexdef(i.oid)) ORDER BY i.relname), '[]'::jsonb)
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid),
    'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal),
    'inboundFks', (SELECT count(*) FROM pg_constraint k WHERE k.confrelid = c.oid AND k.contype = 'f'),
    'inheritanceLinks', (SELECT count(*) FROM pg_inherits h WHERE h.inhrelid = c.oid OR h.inhparent = c.oid),
    'generatedColumns', (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> ''),
    'rules', (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN'),
    'policies', (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid),
    'expressionIndexes', (SELECT count(*) FROM pg_index x WHERE x.indrelid = c.oid
      AND (x.indexprs IS NOT NULL OR x.indpred IS NOT NULL)),
    'unsafeIndexes', (SELECT count(*) FROM pg_index x
      JOIN pg_class ix ON ix.oid = x.indexrelid JOIN pg_am am ON am.oid = ix.relam
      WHERE x.indrelid = c.oid AND (am.amname <> 'btree'
        OR NOT (x.indisvalid AND x.indisready AND x.indislive)
        OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid
          AND k.contype IN ('p', 'u'))
        OR EXISTS (SELECT 1 FROM unnest(x.indclass) AS opclass_oid(oid)
          JOIN pg_opclass op ON op.oid = opclass_oid.oid
          JOIN pg_namespace ons ON ons.oid = op.opcnamespace
          WHERE ons.nspname <> 'pg_catalog')))) AS proof
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relname = '${table}'`
}

export function canonicalSchemaProof(row) {
  const proof = typeof row?.proof === 'string' ? JSON.parse(row.proof) : row?.proof
  if (!proof || proof.relationKind !== 'r' || proof.rowSecurity !== false
    || proof.forceRowSecurity !== false || !Array.isArray(proof.columns)
    || !Array.isArray(proof.constraints) || !Array.isArray(proof.indexes)
    || [proof.triggers, proof.inboundFks, proof.inheritanceLinks, proof.generatedColumns, proof.rules,
      proof.policies, proof.expressionIndexes, proof.unsafeIndexes].some(value => Number(value) !== 0)
    || proof.constraints.some(item => !['p', 'u'].includes(item.kind))) return null
  return proof
}

/** 预留先于 SQL 执行落盘。预留后发生任何未知结果，重试只会拒绝。 */
export function openUatRehearsalReceipts(dbPath) {
  if (!isAbsolute(dbPath ?? '')) throw new Error('POSTGRES_UAT_RECEIPT_PATH_INVALID')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE IF NOT EXISTS uat_rehearsal_receipts (
    operation_key TEXT PRIMARY KEY, intent_json TEXT NOT NULL,
    result_json TEXT, reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT)`)
  return Object.freeze({
    durable: true,
    async get(key) {
      const row = db.prepare('SELECT intent_json, result_json FROM uat_rehearsal_receipts WHERE operation_key = ?').get(key)
      return row ? (row.result_json ? JSON.parse(row.result_json) : { status: 'reserved', intent: JSON.parse(row.intent_json) }) : null
    },
    async begin(key, intent) {
      const row = db.prepare('INSERT OR IGNORE INTO uat_rehearsal_receipts (operation_key, intent_json) VALUES (?, ?)')
        .run(key, JSON.stringify(intent))
      return row.changes === 1
    },
    async complete(key, result) {
      const row = db.prepare('UPDATE uat_rehearsal_receipts SET result_json = ?, completed_at = CURRENT_TIMESTAMP WHERE operation_key = ? AND result_json IS NULL')
        .run(JSON.stringify(result), key)
      if (row.changes !== 1) throw new Error('POSTGRES_UAT_RECEIPT_UNKNOWN')
    },
    close() { db.close() },
  })
}

/** 只采集 PostgreSQL 目录的确定性结构；不把该摘要冒充 Bytebase 的 /schema 摘要。 */
export async function readUatCatalogBaseline({ connection, project, target, signal, connect }) {
  signal?.throwIfAborted()
  const client = await connect(connection, { readOnly: true })
  try {
    const [result, count] = await Promise.all([
      client.query(uatCatalogBaselineSql()), client.query(uatCatalogBaselineCountSql()),
    ])
    if (count.rows.length !== 1 || count.rows[0].expected_rows !== result.rows.length)
      throw new Error('POSTGRES_UAT_CATALOG_INCOMPLETE')
    const schemaDigest = uatCatalogBaselineDigest(result.rows)
    const snapshotId = `pg-catalog-columns-v1:${target.database}:${schemaDigest}`
    return { project, target, snapshotId, sha256: schemaDigest,
      schemaVersion: 'pg-catalog-columns-v1', schemaDigest,
      evidenceRef: `postgres-uat-catalog:${target.instance}/${target.database}:${schemaDigest}` }
  } finally { await client.end() }
}

/** 只支持单表整数列 UPDATE 和同表 SELECT；拒绝触发器、规则、RLS 等隐式写出口。 */
export async function reviewUatSql({ connection, target, applySql, verificationSql,
  applySqlSha256, connect, client: lockedClient }) {
  const statement = narrowSql(applySql, verificationSql)
  if (!statement || digest(applySql) !== applySqlSha256) return { transactionSafe: false }
  const client = lockedClient ?? await connect(connection, { readOnly: true })
  try {
    const result = await client.query(uatSchemaProofSql(statement.schema, statement.table))
    if (result.rows.length !== 1) return { transactionSafe: false }
    const proof = canonicalSchemaProof(result.rows[0])
    if (!proof || proof.schema !== statement.schema || proof.table !== statement.table
      || !statement.columns.every(name => proof.columns.some(column => column.name === name
        && ['smallint', 'integer', 'bigint'].includes(column.type)
        && column.generated === '' && column.identity === ''))) return { transactionSafe: false }
    return { transactionSafe: true, target, sqlSha256: applySqlSha256,
      lockTable: `${statement.schema}.${statement.table}`,
      schemaProofDigest: executionDigest(proof),
      reviewId: `postgres-uat-sql-review:${digest(`${target.database}:${applySqlSha256}:${verificationSql}`)}` }
  } finally { if (!lockedClient) await client.end() }
}

export async function checkUatPreconditions({ connection, project, target, baseline,
  applySql, applySqlSha256, verificationSql, signal, connect }) {
  if (!narrowSql(applySql, verificationSql) || digest(applySql) !== applySqlSha256)
    return { passed: false }
  const actual = await readUatCatalogBaseline({ connection, project, target, signal, connect })
  if (actual.schemaDigest !== baseline.schemaDigest || actual.schemaVersion !== baseline.schemaVersion)
    return { passed: false }
  const review = await reviewUatSql({ connection, target, applySql, verificationSql,
    applySqlSha256, connect })
  if (!review.transactionSafe) return { passed: false }
  return { passed: true, target, sqlSha256: applySqlSha256,
    baselineEvidenceRef: baseline.evidenceRef,
    schemaProofDigest: review.schemaProofDigest,
    checkId: `postgres-uat-preconditions:${digest(`${actual.evidenceRef}:${applySqlSha256}`)}` }
}

export function verifyUatRows({ intent, query, applyResult }) {
  if (!Number.isInteger(applyResult?.rowCount) || applyResult.rowCount < 1) return { passed: false }
  let expected
  try { expected = JSON.parse(intent.expectedChange) } catch { return { passed: false } }
  if (!Array.isArray(expected?.rows) || JSON.stringify(query?.rows) !== JSON.stringify(expected.rows))
    return { passed: false }
  const observedChange = JSON.stringify(query.rows)
  return { passed: true, observedChange,
    readbackId: `postgres-uat-transaction-readback:${digest(`${intent.operationKey}:${observedChange}`)}` }
}

/** 仅允许运行时提供额外的已验证审查器；默认不放行任意用户 SQL。 */
export function createUatPostgresHost({ entries, receiptDbPath, Client,
  baselineReader = readUatCatalogBaseline,
  preconditionReader = checkUatPreconditions, sqlReview = reviewUatSql,
  verify = verifyUatRows }) {
  if (!Array.isArray(entries) || entries.length !== 3 || !entries.every(entry =>
    allowedDatabases.has(entry?.target?.database) && exactName(entry.target.database)
    && entry.target.environment === 'uat' && entry.connection.database === entry.target.database)
    || new Set(entries.map(entry => entry.target.database)).size !== 3
    || typeof Client !== 'function' || typeof baselineReader !== 'function'
    || typeof preconditionReader !== 'function' || typeof sqlReview !== 'function'
    || typeof verify !== 'function') throw new Error('POSTGRES_UAT_HOST_NOT_CONFIGURED')
  const receipts = openUatRehearsalReceipts(receiptDbPath)
  const connect = async (connection, { readOnly = false } = {}) => {
    const client = new Client({ host: connection.host, port: connection.port,
      database: connection.database, user: connection.user, password: connection.password,
      connectionTimeoutMillis: 10000, statement_timeout: 30000,
      options: readOnly ? '-c default_transaction_read_only=on' : undefined })
    try { await client.connect(); return client } catch { await client.end().catch(() => {}); throw Error('POSTGRES_UAT_CONNECTION_UNAVAILABLE') }
  }
  const platform = createPostgresUatPlatform({ connections: entries, connect,
    baselineReader: input => baselineReader({ ...input, connect }),
    preconditionReader: input => preconditionReader({ ...input, connect }),
    sqlReview: input => sqlReview({ ...input, connect }),
    verify, receiptStore: receipts })
  return { platform, close: () => receipts.close() }
}
