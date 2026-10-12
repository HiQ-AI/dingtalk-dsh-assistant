import { createHash } from 'node:crypto'
import { executionDigest, executionError } from './execution-artifacts.js'
const fail = code => { throw executionError(code) }
export const sg22SchemaScope = Object.freeze({
  taskId: 'task-f559fc2e93230cf2cdcd61c8ad51dc35', repository: 'HiQ-AI/dataset',
  branch: 'feature/uat3-base', candidateSha: '781d2b88938b98c1924793423854c11d5fd51640', pullRequestNumber: 382,
  environment: 'uat', host: '192.168.8.8', port: 30770, database: 'hiq_editor', schema: 'public',
  sqlPath: 'docs/sg22/activity-merge-result.sql', sqlSha256: '452330b9a3f34529d68440c68b2120da626f821f082184806cccf317354808a1',
  tables: ['te_activity_merge_candidate', 'te_activity_merge_submission', 'te_activity_merge_outcome'],
})
export function validateUatSchemaTarget(target) {
  if (!target || typeof target.id !== 'string' || !target.id.trim()
    || Object.keys(target).some(key => !['id', ...Object.keys(sg22SchemaScope)].includes(key))
    || Object.entries(sg22SchemaScope).some(([key, value]) => executionDigest(target[key]) !== executionDigest(value)))
    fail('UAT_SCHEMA_TARGET_NOT_ALLOWED')
  return target
}
export function validateUatSchemaSql(sql) {
  if (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== sg22SchemaScope.sqlSha256)
    fail('UAT_SCHEMA_SQL_NOT_APPROVED')
  return sql
}
export function createUatSchemaMigrationPlatform({ targets, postgres, github, readAcceptedSource }) {
  if (!Array.isArray(targets) || targets.length !== 1 || !postgres || !github || typeof readAcceptedSource !== 'function'
    || ['apply','reconcile'].some(name => typeof postgres[name] !== 'function')
    || ['readPullRequest','readBranch','readVersionedFile'].some(name => typeof github[name] !== 'function'))
    fail('UAT_SCHEMA_PLATFORM_REQUIRED')
  const target = validateUatSchemaTarget(targets[0])
  const identity = requirement => {
    if (requirement?.targetId !== target.id || requirement.taskId !== target.taskId
      || requirement.candidateSha !== target.candidateSha || !requirement.request?.trim()) fail('UAT_SCHEMA_REQUIREMENT_INVALID')
  }
  async function source() {
    const accepted = await readAcceptedSource(target)
    const [pr, branch, file] = await Promise.all([
      github.readPullRequest({ repository: target.repository, number: target.pullRequestNumber }),
      github.readBranch({ repository: target.repository, branch: target.branch }),
      github.readVersionedFile({ repository: target.repository, commitSha: target.candidateSha, path: target.sqlPath }),
    ])
    if (accepted?.candidateSha !== target.candidateSha || !accepted.evidenceRef
      || pr.merged !== true || pr.headCommitSha !== target.candidateSha || pr.mergeCommitSha !== target.candidateSha
      || pr.baseBranch !== target.branch || pr.baseRepository !== target.repository || pr.headRepository !== target.repository
      || branch.commitSha !== target.candidateSha || !pr.evidenceRef || !branch.evidenceRef || !file.evidenceRef)
      fail('UAT_SCHEMA_SOURCE_UNCONFIRMED')
    validateUatSchemaSql(file.content)
    return { sql: file.content, evidenceRefs: [accepted.evidenceRef, pr.evidenceRef, branch.evidenceRef, file.evidenceRef] }
  }
  const checkPrepared = prepared => {
    if (prepared?.action !== 'external' || prepared.workflowKind !== 'uat-schema-migration'
      || prepared.operation !== 'apply-approved-schema' || prepared.expected?.targetId !== target.id
      || prepared.expected?.migrationKey !== executionDigest(target)
      || typeof prepared.runId !== 'string' || !prepared.runId || !Number.isInteger(prepared.generation) || prepared.generation < 1
      || !/^[a-f0-9]{64}$/.test(prepared.requirementDigest ?? '') || !/^[a-f0-9]{64}$/.test(prepared.targetDigest ?? '')
      || prepared.expected?.taskId !== target.taskId || prepared.expected?.candidateSha !== target.candidateSha
      || prepared.resourceKey !== `external:uat-schema:${target.host}:${target.port}:${target.database}:${target.schema}`
      || prepared.operationKey !== executionDigest({ runId: prepared.runId, generation: prepared.generation,
        requirementDigest: prepared.requirementDigest, targetDigest: prepared.targetDigest, expected: prepared.expected }))
      fail('UAT_SCHEMA_OPERATION_INVALID')
    return prepared
  }
  const migrationKey = executionDigest(target)
  const reconcile = async prepared => {
    checkPrepared(prepared)
    const result = await postgres.reconcile({ target, migrationKey })
    const observation = result.status === 'unseen'
      ? { ...result, status: 'failed', reason: 'UAT_SCHEMA_NO_COMMITTED_EFFECT', noCommittedEffect: true }
      : result.status === 'succeeded' ? result : { ...result, status: 'unknown', reason: 'UAT_SCHEMA_BASELINE_CONFLICT' }
    return { ...observation, operationKey: prepared.operationKey, migrationKey }
  }
  const adapter = { id: 'trusted-uat-schema-migration', version: '1', rulesDigest: executionDigest(target),
    async inspect({ phase, requirement, prepared, receipt }) {
      if (phase === 'preflight') {
        identity(requirement)
        const verified = await source(), baseline = await postgres.reconcile({ target, migrationKey })
        if (!['unseen', 'succeeded'].includes(baseline.status)) fail('UAT_SCHEMA_BASELINE_CONFLICT')
        return { status: 'confirmed', evidenceRefs: [...verified.evidenceRefs, ...baseline.evidenceRefs] }
      }
      const result = await reconcile(prepared)
      if (result.status !== 'succeeded' || receipt?.status !== 'succeeded'
        || receipt.migrationKey !== migrationKey || result.schemaDigest !== receipt.schemaDigest)
        fail('UAT_SCHEMA_READBACK_UNCONFIRMED')
      return { ...result, taskId: target.taskId, targetId: target.id, candidateSha: target.candidateSha,
        database: target.database, schema: target.schema, tables: [...target.tables] }
    },
    async prepareOperation({ requirement, runId, generation, requirementDigest }) {
      identity(requirement)
      const expected = { targetId: target.id, taskId: target.taskId, candidateSha: target.candidateSha, migrationKey }
      const targetDigest = executionDigest(requirement)
      return { action: 'external', workflowKind: 'uat-schema-migration', operation: 'apply-approved-schema',
        runId, generation, requirementDigest, targetDigest, expected,
        resourceKey: `external:uat-schema:${target.host}:${target.port}:${target.database}:${target.schema}`,
        operationKey: executionDigest({ runId, generation, requirementDigest, targetDigest, expected }) }
    } }
  return { adapter, configuredTargetIds: [target.id], target,
    operationAdapter: { reconcile, async execute(prepared) {
      checkPrepared(prepared)
      const verified = await source()
      const result = await postgres.apply({ target, migrationKey, sql: verified.sql })
      return { ...result, operationKey: prepared.operationKey, migrationKey,
        evidenceRefs: [...result.evidenceRefs, ...verified.evidenceRefs] }
    } } }
}
