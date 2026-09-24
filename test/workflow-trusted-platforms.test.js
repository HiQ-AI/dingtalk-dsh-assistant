import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'

const target = { instance: 'instances/prod', database: 'instances/prod/databases/app', environment: 'production' }
const config = { bytebase: { adapterId: 'bytebase', adapterVersion: '1', targets: [{
  id: 'app-prod', project: 'projects/app', target,
  uatTarget: { instance: 'instances/uat', database: 'instances/uat/databases/app', environment: 'uat' },
}] } }
const api = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql', 'rehearseInUat',
  'getUatRehearsalByOperationKey', 'createIssueBundle',
  'getIssueBundle', 'getApproval', 'runTask', 'getTaskExecution', 'queryVerification',
  'findIssueByOperationKey'].map(name => [name, async () => ({})]))
api.readBaseline = async ({ project, target: requested }) => ({ project, target: requested,
  snapshotId: 'snapshot-1', sha256: 'a'.repeat(64), evidenceRef: 'bytebase:baseline:1' })

test('未配置目标时不注册外部流程，缺受信端口时拒绝启动', () => {
  assert.equal(createTrustedWorkflowPlatforms({ config: {}, clients: {}, ownerActorId: 'owner' }), null)
  assert.throws(() => createTrustedWorkflowPlatforms({ config, clients: {}, ownerActorId: 'owner' }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => createTrustedWorkflowPlatforms({ config: { productionApproverActorIds: [] },
    clients: {}, ownerActorId: 'owner' }), { code: 'PRODUCTION_APPROVER_INVALID' })
})

test('数据变更输入只接受白名单目标和精确 SQL 来源，基线由平台受信回读', async () => {
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase: api }, ownerActorId: 'owner' })
  const action = { arguments: { objective: '修正一条记录', targetId: 'app-prod',
    changeRef: 'sql-1' }, constraints: ['仅此数据库'] }
  const materials = [{ resourceRef: 'sql-1', text: 'UPDATE app SET x = 1 WHERE id = 1;' }]
  const requirement = await platform.prepareRequirement({ workflowId: 'task-data-change', action, materials })
  assert.deepEqual(requirement.target, target)
  assert.equal(requirement.sources[0].id, 'sql-1')
  assert.deepEqual(requirement.baseline, { snapshotId: 'snapshot-1', sha256: 'a'.repeat(64) })
  assert.deepEqual(requirement.constraints, ['仅此数据库'])
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-data-change',
    action: { ...action, arguments: { ...action.arguments, targetId: 'other' } }, materials }),
  { code: 'EXTERNAL_TARGET_NOT_ALLOWED' })
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-data-change', action, materials: [] }),
    { code: 'EXTERNAL_MATERIAL_NOT_FOUND' })
  const badApi = { ...api, readBaseline: async () => ({ project: 'projects/other', target,
    snapshotId: 'snapshot-1', sha256: 'a'.repeat(64), evidenceRef: 'wrong-project' }) }
  const guarded = createTrustedWorkflowPlatforms({ config, clients: { bytebase: badApi }, ownerActorId: 'owner' })
  await assert.rejects(guarded.prepareRequirement({ workflowId: 'task-data-change', action, materials }),
    { code: 'EXTERNAL_BASELINE_UNCONFIRMED' })
})

test('数据变更效果固定绑定运行身份，真人审批由 Bytebase 工单承担', async () => {
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase: api }, ownerActorId: 'owner' })
  const prepared = { workflowKind: 'data-change', runId: 'run-1', generation: 1, target }
  const grant = await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }, prepared })
  assert.ok(grant.authorizationRef)
  assert.equal(grant.approval, undefined)
  await assert.rejects(platform.authorizeExternal({ binding: { runId: 'run-2', nodeRunId: 'node-1', generation: 1 }, prepared }),
    { code: 'EXTERNAL_AUTHORIZATION_IDENTITY_INVALID' })
})

test('生产发布仅审批节点等待真人，Tag 必须带审批回读身份', async () => {
  const releaseTarget = { id: 'prod', kind: 'production-release', repository: 'HiQ-AI/dataset',
    environment: 'production', service: 'dataset', runbookId: 'dataset-prod', branch: 'main',
    woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1 },
    kubernetes: { namespace: 'prod', deployment: 'dataset' },
    registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' },
    entryUrl: 'https://prod.example.test/health', productionTriggerVerified: true,
    releaseTag: 'v20260925-1' }
  const releaseClients = {
    github: Object.fromEntries(['readBranch', 'resolveApprovedPullRequest', 'readPullRequest', 'readTag', 'createTag']
      .map(name => [name, async () => ({})])),
    woodpecker: Object.fromEntries(['listPipelines', 'readBuildEvidence'].map(name => [name, async () => ({})])),
    kubernetes: Object.fromEntries(['readDeployment', 'readPods', 'readEntry'].map(name => [name, async () => ({})])),
    registry: { readManifest: async () => ({}) },
  }
  const platform = createTrustedWorkflowPlatforms({ config: { release: { targets: [releaseTarget] } },
    clients: { release: releaseClients }, ownerActorId: 'owner' })
  const binding = { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }
  const base = { workflowKind: 'production-release', runId: 'run-1', generation: 1, expected: {} }
  const gate = await platform.authorizeExternal({ binding, prepared: { ...base, operation: 'approval-gate' } })
  assert.deepEqual(gate.approval.approverIds, ['owner'])
  const merge = await platform.authorizeExternal({ binding, prepared: { ...base, operation: 'merge-main' } })
  assert.ok(merge.authorizationRef)
  assert.equal(merge.approval, undefined)
  await assert.rejects(platform.authorizeExternal({ binding, prepared: { ...base, operation: 'tag' } }),
    { code: 'RELEASE_APPROVAL_PROOF_REQUIRED' })
})
