import { createHash, randomUUID } from 'node:crypto'
import { executionError } from './execution-artifacts.js'

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const required = (ok, code) => { if (!ok) throw executionError(code) }
const sameTarget = (a, b) => a?.instance === b?.instance && a?.database === b?.database
  && a?.environment === b?.environment
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value

/**
 * UAT PostgreSQL 窄端口。connections 仅在受信 Host 内保存精确连接，不进入模型或效果请求。
 * connect 必须使用该连接建立会话；baselineReader、preconditionReader 与 sqlReview
 * 必须是受信只读实现。sqlReview 必须证明 SQL 及目标表触发器均无事务外副作用。
 * receiptStore.begin 是持久原子预留；未知结果只读对账，绝不自动重跑脚本。
 */
export function createPostgresUatPlatform({ connections, connect, baselineReader,
  preconditionReader, sqlReview, verify, receiptStore }) {
  required(Array.isArray(connections) && connections.length > 0
    && [connect, baselineReader, preconditionReader, sqlReview, verify].every(fn => typeof fn === 'function')
    && receiptStore?.durable === true
    && ['get', 'begin', 'complete'].every(name => typeof receiptStore[name] === 'function'),
  'POSTGRES_UAT_PORT_NOT_CONFIGURED')
  const byTarget = new Map()
  for (const entry of connections) {
    const target = entry?.target, connection = entry?.connection
    required(/^postgresql\/[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/.test(target?.instance ?? '')
      && /^[A-Za-z0-9_]+$/.test(target?.database ?? '') && target.environment === 'uat'
      && connection?.host && `${connection.host}:${connection.port}` === target.instance.slice('postgresql/'.length)
      && connection.database === target.database && text(connection.user) && text(connection.password)
      && /^projects\/[A-Za-z0-9._-]+$/.test(entry.project ?? ''),
    'POSTGRES_UAT_TARGET_INVALID')
    const key = `${target.instance}/${target.database}`
    required(!byTarget.has(key), 'POSTGRES_UAT_TARGET_DUPLICATE')
    byTarget.set(key, entry)
  }
  const entryFor = (project, target) => {
    const entry = byTarget.get(`${target?.instance}/${target?.database}`)
    required(entry?.project === project && sameTarget(entry.target, target), 'POSTGRES_UAT_TARGET_NOT_ALLOWED')
    return entry
  }
  const open = async entry => {
    const client = await connect(entry.connection)
    required(typeof client?.query === 'function' && typeof client?.end === 'function',
      'POSTGRES_UAT_CONNECTION_INVALID')
    return client
  }
  const getDatabase = async ({ project, target, signal }) => {
    signal?.throwIfAborted()
    const entry = entryFor(project, target)
    const client = await open(entry)
    try {
      const result = await client.query('SELECT current_database() AS database_name')
      required(result?.rows?.length === 1 && result.rows[0].database_name === target.database,
        'POSTGRES_UAT_DATABASE_IDENTITY_UNCONFIRMED')
      return { project, ...target }
    } finally { await client.end() }
  }
  const readBaseline = async ({ project, target, scope, signal }) => {
    const entry = entryFor(project, target)
    const result = await baselineReader({ connection: entry.connection, project, target, scope, signal })
    required(result?.project === project && sameTarget(result.target, target)
      && text(result.snapshotId) && /^[a-f0-9]{64}$/.test(result.sha256 ?? '')
      && text(result.schemaVersion) && /^[a-f0-9]{64}$/.test(result.schemaDigest ?? '')
      && text(result.evidenceRef), 'POSTGRES_UAT_BASELINE_UNCONFIRMED')
    return result
  }
  const checkPreconditions = async ({ project, target, baseline, applySql,
    applySqlSha256, expectedChange, verificationSql, signal }) => {
    const entry = entryFor(project, target)
    required(sha(applySql) === applySqlSha256, 'POSTGRES_UAT_SQL_IDENTITY_CHANGED')
    const result = await preconditionReader({ connection: entry.connection, project, target,
      baseline, applySql, applySqlSha256, expectedChange, verificationSql, signal })
    required(result?.passed === true && sameTarget(result.target, target)
      && result.sqlSha256 === applySqlSha256 && result.baselineEvidenceRef === baseline.evidenceRef
      && text(result.checkId), 'POSTGRES_UAT_PRECONDITIONS_UNCONFIRMED')
    return result
  }
  const validateSql = async ({ project, target, sql, sqlSha256, verificationSql }) => {
    const entry = entryFor(project, target)
    required(sha(sql) === sqlSha256 && text(verificationSql), 'POSTGRES_UAT_SQL_IDENTITY_CHANGED')
    const review = await sqlReview({ connection: entry.connection, target,
      applySql: sql, applySqlSha256: sqlSha256, verificationSql })
    required(review?.transactionSafe === true && review.sqlSha256 === sqlSha256
      && sameTarget(review.target, target) && text(review.reviewId)
      && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(review.lockTable ?? ''),
    'POSTGRES_UAT_SQL_NOT_TRANSACTION_SAFE')
    return { passed: true, target, sqlSha256, reviewId: review.reviewId,
      schemaProofDigest: review.schemaProofDigest }
  }
  const getUatRehearsalByOperationKey = async ({ project, operationKey }) => {
    required(text(operationKey), 'POSTGRES_UAT_OPERATION_INVALID')
    const result = await receiptStore.get(operationKey)
    if (!result?.passed) return null
    entryFor(project, result.target)
    required(result.operationKey === operationKey, 'POSTGRES_UAT_RECEIPT_IDENTITY_CHANGED')
    return result
  }
  const rehearseInUat = async intent => {
    const entry = entryFor(intent?.project, intent?.uatTarget)
    let expectedRows
    try { expectedRows = JSON.parse(intent?.expectedChange)?.rows } catch { /* 无法比较预期时拒绝执行。 */ }
    required(text(intent.operationKey) && sha(intent.applySql) === intent.applySqlSha256
      && typeof intent.verificationSql === 'string' && text(intent.packageDigest)
      && Array.isArray(expectedRows),
    'POSTGRES_UAT_OPERATION_INVALID')
    const existing = await receiptStore.get(intent.operationKey)
    if (existing?.passed) {
      required(existing.operationKey === intent.operationKey
        && existing.packageDigest === intent.packageDigest
        && existing.sqlSha256 === intent.applySqlSha256
        && sameTarget(existing.target, intent.uatTarget), 'POSTGRES_UAT_RECEIPT_IDENTITY_CHANGED')
      return existing
    }
    required(!existing, 'POSTGRES_UAT_OPERATION_UNKNOWN')
    const review = await sqlReview({ connection: entry.connection, target: intent.uatTarget,
      applySql: intent.applySql, verificationSql: intent.verificationSql,
      applySqlSha256: intent.applySqlSha256 })
    required(review?.transactionSafe === true && review.sqlSha256 === intent.applySqlSha256
      && review.target?.database === intent.uatTarget.database && text(review.reviewId)
      && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(review.lockTable ?? ''),
    'POSTGRES_UAT_SQL_NOT_TRANSACTION_SAFE')
    required(await receiptStore.begin(intent.operationKey, {
      target: intent.uatTarget, packageDigest: intent.packageDigest,
      sqlSha256: intent.applySqlSha256 }) === true, 'POSTGRES_UAT_OPERATION_UNKNOWN')
    const client = await open(entry)
    let began = false
    try {
      await client.query('BEGIN')
      began = true
      await client.query('SET LOCAL statement_timeout = 30000')
      await client.query(`LOCK TABLE ${review.lockTable} IN SHARE ROW EXCLUSIVE MODE`)
      const lockedReview = await sqlReview({ connection: entry.connection, target: intent.uatTarget,
        applySql: intent.applySql, verificationSql: intent.verificationSql,
        applySqlSha256: intent.applySqlSha256, client })
      required(lockedReview?.transactionSafe === true && lockedReview.reviewId === review.reviewId
        && lockedReview.lockTable === review.lockTable,
      'POSTGRES_UAT_SQL_NOT_TRANSACTION_SAFE')
      const applyResult = await client.query(intent.applySql)
      required(Number.isInteger(applyResult?.rowCount) && applyResult.rowCount > 0,
        'POSTGRES_UAT_VERIFICATION_UNCONFIRMED')
      const query = await client.query(intent.verificationSql)
      const verification = await verify({ intent, query, review: lockedReview, applyResult })
      required(verification?.passed === true && text(verification.observedChange)
        && text(verification.readbackId), 'POSTGRES_UAT_VERIFICATION_UNCONFIRMED')
      await client.query('ROLLBACK')
      began = false
      const result = { passed: true, uat: true, operationKey: intent.operationKey,
        target: intent.uatTarget, sourceTarget: intent.sourceTarget,
        productionBaselineEvidenceRef: intent.productionBaseline.evidenceRef,
        uatBaselineEvidenceRef: intent.uatBaseline.evidenceRef,
        schemaVersion: intent.uatBaseline.schemaVersion, schemaDigest: intent.uatBaseline.schemaDigest,
        sqlSha256: intent.applySqlSha256, packageDigest: intent.packageDigest,
        taskRunId: randomUUID(), verificationReadbackId: verification.readbackId,
        observedChange: verification.observedChange, receiptId: randomUUID() }
      await receiptStore.complete(intent.operationKey, result)
      return result
    } finally {
      if (began) await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
  }
  return { getDatabase, readBaseline, checkPreconditions, validateSql, rehearseInUat,
    getUatRehearsalByOperationKey }
}
