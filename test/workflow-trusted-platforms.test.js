import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const target = { instance: 'instances/prod', database: 'instances/prod/databases/app', environment: 'production' }
const config = { bytebase: { adapterId: 'bytebase', adapterVersion: '1', targets: [{
  id: 'app-prod', project: 'projects/app', target,
  uatTarget: { instance: 'postgresql/192.168.8.8:30770', database: 'app', environment: 'uat' },
}] } }
const api = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql', 'rehearseInUat',
  'getUatRehearsalByOperationKey', 'createIssueBundle', 'activateRollout',
  'getIssueBundle', 'getApproval', 'runTask', 'getTaskExecution', 'queryVerification',
  'findIssueByOperationKey'].map(name => [name, async () => ({})]))
api.readBaseline = async ({ project, target: requested }) => ({ project, target: requested,
  snapshotId: 'snapshot-1', sha256: 'a'.repeat(64), evidenceRef: 'bytebase:baseline:1' })
const uatPostgres = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql',
  'rehearseInUat', 'getUatRehearsalByOperationKey'].map(name => [name, async () => ({})]))
const productionPostgres = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions']
  .map(name => [name, api[name]]))

test('未配置目标时不注册外部流程，缺受信端口时拒绝启动', () => {
  assert.equal(createTrustedWorkflowPlatforms({ config: {}, clients: {}, ownerActorId: 'owner' }), null)
  assert.throws(() => createTrustedWorkflowPlatforms({ config, clients: {}, ownerActorId: 'owner' }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => createTrustedWorkflowPlatforms({ config: { productionApproverActorIds: [] },
    clients: {}, ownerActorId: 'owner' }), { code: 'PRODUCTION_APPROVER_INVALID' })
})

test('数据变更输入只接受白名单目标和精确 SQL 来源，基线由平台受信回读', async () => {
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase: api, productionPostgres, uatPostgres }, ownerActorId: 'owner' })
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
  const badApi = { ...productionPostgres, readBaseline: async () => ({ project: 'projects/other', target,
    snapshotId: 'snapshot-1', sha256: 'a'.repeat(64), evidenceRef: 'wrong-project' }) }
  const guarded = createTrustedWorkflowPlatforms({ config,
    clients: { bytebase: api, productionPostgres: badApi, uatPostgres }, ownerActorId: 'owner' })
  await assert.rejects(guarded.prepareRequirement({ workflowId: 'task-data-change', action, materials }),
    { code: 'EXTERNAL_BASELINE_UNCONFIRMED' })
})

test('数据变更工单在 Assistant 任务页审批，生产执行前重验精确范围', async () => {
  const platform = createTrustedWorkflowPlatforms({ config,
    clients: { bytebase: api, productionPostgres, uatPostgres }, ownerActorId: 'owner' })
  const prepared = { workflowKind: 'data-change', runId: 'run-1', generation: 1, target }
  const grant = await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }, prepared })
  assert.ok(grant.authorizationRef)
  assert.equal(grant.approval, undefined)
  const scope = { runId: 'run-1', generation: 1, issueId: 'issue-1',
    planId: 'plan-1', sheetId: 'sheet-1',
    target, sheetSha256: 'a'.repeat(64), packageDigest: 'b'.repeat(64) }
  const scopeDigest = executionDigest(scope)
  const gate = { ...prepared, stage: 'approval-gate', requirementDigest: 'c'.repeat(64),
    resourceKey: 'database:app', packageDigest: scope.packageDigest,
    applySqlSha256: scope.sheetSha256, intent: { ...scope, scopeDigest, operationKey: 'operation-1' } }
  assert.deepEqual((await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-2', generation: 1 },
    prepared: gate })).approval.approverIds, ['owner'])
  const execute = { ...gate, stage: 'execute-task', approvalRequestId: 'request-1',
    intent: { ...gate.intent, approvalScopeDigest: scopeDigest } }
  await assert.rejects(platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-3', generation: 1 },
    prepared: execute }), { code: 'BYTEBASE_APPROVAL_PROOF_REQUIRED' })
  const gateEffect = { effectId: 'effect-1', generation: 1, state: 'succeeded', requestId: 'request-1',
    definition: { action: 'external', payload: gate }, result: { status: 'succeeded',
      result: { scopeDigest, operationKey: gate.intent.operationKey } } }
  const approval = { effectId: 'effect-1', decision: 'approved', decisionSource: 'web',
    decidedBy: 'owner', revoked: false }
  platform.bindStore({ query: async query => query.kind === 'effect.list' ? [gateEffect] : approval })
  assert.ok((await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-3', generation: 1 },
    prepared: execute })).authorizationRef)
  approval.revoked = true
  await assert.rejects(platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-3', generation: 1 },
    prepared: execute }), { code: 'BYTEBASE_APPROVAL_PROOF_REQUIRED' })
  await assert.rejects(platform.authorizeExternal({ binding: { runId: 'run-2', nodeRunId: 'node-1', generation: 1 }, prepared }),
    { code: 'EXTERNAL_AUTHORIZATION_IDENTITY_INVALID' })
})

test('生产发布仅审批节点等待真人，Tag 必须带审批回读身份', async () => {
  const releaseTarget = { id: 'prod', kind: 'production-release', repository: 'HiQ-AI/dataset',
    environment: 'production', service: 'dataset', runbookId: 'dataset-prod', branch: 'main',
    woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1 },
    kubernetes: { namespace: 'prod', deployment: 'dataset' },
    registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' },
    entryUrl: 'https://prod.example.test/health', productionTriggerVerified: true }
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
  const gateReceipt = { status: 'succeeded', scopeDigest: 'b'.repeat(64), evidenceRef: 'approval:gate:1' }
  const tagPrepared = { ...base, operation: 'tag', targetDigest: 'c'.repeat(64),
    requirementDigest: 'd'.repeat(64), resourceKey: 'external:production:HiQ-AI/dataset:dataset',
    expected: { commitSha: 'a'.repeat(40), tag: 'v20260925-1', approvalScopeDigest: gateReceipt.scopeDigest,
      approvalReceiptDigest: executionDigest(gateReceipt) } }
  const gateEffect = { effectId: 'effect-gate', generation: 1, state: 'succeeded', requestId: 'approval-gate',
    definition: { action: 'external', payload: { ...tagPrepared, operation: 'approval-gate' } },
    result: { status: 'succeeded', result: gateReceipt } }
  const approval = { effectId: 'effect-gate', decision: 'approved', revoked: false,
    decisionSource: 'web', decidedBy: 'owner' }
  platform.bindStore({ query: async query => query.kind === 'effect.list' ? [gateEffect] : approval })
  assert.ok((await platform.authorizeExternal({ binding, prepared: tagPrepared })).authorizationRef)
  approval.revoked = true
  await assert.rejects(platform.authorizeExternal({ binding, prepared: tagPrepared }),
    { code: 'RELEASE_APPROVAL_PROOF_REQUIRED' })
  approval.revoked = false
  await assert.rejects(platform.authorizeExternal({ binding, prepared: { ...tagPrepared,
    expected: { ...tagPrepared.expected, tag: 'v20260926-2' } } }),
  { code: 'RELEASE_APPROVAL_PROOF_REQUIRED' })
  releaseClients.github.readBranch = async () => ({ commitSha: 'a'.repeat(40), evidenceRef: 'github:main:a' })
  for (const releaseTag of ['v20260925-1', 'v20260926-2']) {
    const input = await platform.prepareRequirement({ workflowId: 'task-production-release',
      action: { arguments: { objective: '生产发布', targetId: 'prod', commitSha: 'a'.repeat(40), releaseTag } }, materials: [] })
    assert.equal(input.target.releaseTag, releaseTag)
  }
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-production-release',
    action: { arguments: { objective: '生产发布', targetId: 'prod', commitSha: 'a'.repeat(40) } }, materials: [] }),
  { code: 'EXTERNAL_RELEASE_TAG_REQUIRED' })
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-production-release',
    action: { arguments: { objective: '生产发布', targetId: 'prod', commitSha: 'a'.repeat(40), releaseTag: 'latest' } }, materials: [] }),
  { code: 'RELEASE_PLATFORM_IDENTITY_INVALID' })
})

test('UAT 合并目标只来自受信白名单并在效果前等待 Assistant 真人审批', async () => {
  const releaseTarget = { id: 'dataset-uat', kind: 'uat-deployment', repository: 'HiQ-AI/dataset',
    environment: 'uat', service: 'dataset', runbookId: 'dataset-uat', branch: 'uat',
    woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1, cronName: 'dataset-uat' },
    kubernetes: { namespace: 'hiqlcd-app-uat2', deployment: 'dataset' },
    registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' },
    entryUrl: 'https://uat.example.test/health' }
  const clients = { release: {
    github: Object.fromEntries(['readBranch', 'resolveApprovedPullRequest', 'readPullRequest', 'readCommit',
      'readChecks', 'mergePullRequest'].map(name => [name, async () => ({})])),
    woodpecker: Object.fromEntries(['listPipelines', 'readBuildEvidence', 'triggerBuild']
      .map(name => [name, async () => ({})])),
    kubernetes: Object.fromEntries(['readDeployment', 'readPods', 'readEntry']
      .map(name => [name, async () => ({})])),
    registry: { readManifest: async () => ({}) },
  } }
  const config = { release: { targets: [releaseTarget] },
    uatMerge: { targets: [{ targetId: 'dataset-uat', requiredChecks: ['unit'] }] } }
  const platform = createTrustedWorkflowPlatforms({ config, clients, ownerActorId: 'owner' })
  assert.ok(platform.uatMergeAdapter)
  assert.ok(platform.availableTargets.some(item => item.workflowId === 'task-uat-pr-merge'))
  const input = await platform.prepareRequirement({ workflowId: 'task-uat-pr-merge',
    action: { arguments: { objective: '合入 UAT', targetId: 'dataset-uat',
      pullRequestNumber: 42, headCommitSha: 'a'.repeat(40) } }, materials: [] })
  assert.deepEqual(input.requiredChecks, ['unit'])
  const prepared = { workflowKind: 'uat-pr-merge', operation: 'merge-uat-pr', runId: 'run-1', generation: 1,
    expected: { targetId: 'dataset-uat' } }
  const approval = await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }, prepared })
  assert.deepEqual(approval.approval.approverIds, ['owner'])
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-uat-pr-merge',
    action: { arguments: { objective: '合入 UAT', targetId: 'other',
      pullRequestNumber: 42, headCommitSha: 'a'.repeat(40) } }, materials: [] }),
  { code: 'UAT_MERGE_TARGET_NOT_ALLOWED' })
})
