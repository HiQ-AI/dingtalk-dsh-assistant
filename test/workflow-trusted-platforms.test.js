import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createDataChangeApprovalResumeWorkflow } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

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
  const current = await platform.prepareRequirement({ workflowId: 'task-data-change', action, materials })
  assert.equal(current.baseline, undefined)
  assert.equal(platform.dataChangeAdapter.pluginApproval, true)
  const requirement = await platform.prepareRequirement({ workflowId: 'task-data-change', definitionVersion: '3', action, materials })
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
  await assert.rejects(guarded.prepareRequirement({ workflowId: 'task-data-change', definitionVersion: '3', action, materials }),
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
      result: { status: 'succeeded', result: { scopeDigest, operationKey: gate.intent.operationKey } } } }
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

for (const decision of ['pending', 'rejected']) test(`直接生产授权拒绝插件 ${decision} 决定`, async () => {
  const platform = createTrustedWorkflowPlatforms({ config,
    clients: { bytebase: api, productionPostgres, uatPostgres }, ownerActorId: 'owner' })
  const scope = { runId: 'run-1', generation: 1, issueId: 'issue-1', planId: 'plan-1', sheetId: 'sheet-1',
    target, sheetSha256: 'a'.repeat(64), packageDigest: 'b'.repeat(64) }
  const scopeDigest = executionDigest(scope)
  const gate = { workflowKind: 'data-change', ...scope, stage: 'approval-gate', requirementDigest: 'c'.repeat(64),
    resourceKey: 'database:app', applySqlSha256: scope.sheetSha256,
    intent: { ...scope, scopeDigest, operationKey: 'operation-1', approvalSource: 'assistant' } }
  gate.intent = { ...gate.intent, project: 'projects/app', target, applySqlSha256: scope.sheetSha256,
    operationKey: executionDigest({ stage: 'approval-gate', runId: scope.runId, generation: 1,
      requirementDigest: gate.requirementDigest, scopeDigest }) }
  const effect = { effectId: 'effect-1', generation: 1, state: 'unknown', requestId: 'request-1',
    definition: { action: 'external', payload: gate } }
  platform.bindStore({ query: async query => query.kind === 'effect.list' ? [effect]
    : { effectId: effect.effectId, requestId: effect.requestId, decision, decisionSource: 'web',
      decidedBy: 'owner', revoked: false, comment: '请改成 varchar' } })
  await assert.rejects(platform.authorizeExternal({ binding: { runId: scope.runId, generation: 1 },
    prepared: { ...gate, stage: 'execute-task', approvalRequestId: effect.requestId,
      intent: { ...gate.intent, approvalScopeDigest: scopeDigest } } }), { code: 'BYTEBASE_APPROVAL_PROOF_REQUIRED' })
  if (decision === 'rejected') assert.equal((await platform.dataChangeAdapter.inspect({ stage: 'approval-state',
    prepared: { package: { target } }, request: gate })).comment, '请改成 varchar')
})

test('受信接续仅消费旧Run冻结工单，SKIPPED及未执行证明不产生任何写操作', async () => {
  const hash = text => createHash('sha256').update(text).digest('hex'), calls = []
  const sql = 'ALTER TABLE public.t ADD COLUMN name character varying;'
  const scope = { schema: 'public', table: 't' }
  const baseline = { snapshotId: 'snapshot-1', sha256: 'a'.repeat(64), scope }
  const body = { target, baseline, sourceDigest: hash('source'), applySql: sql, applySqlSha256: hash(sql),
    rollbackSql: 'ALTER TABLE public.t DROP COLUMN name;', verificationSql: 'SELECT 1;', expectedChange: '{}' }
  const prepared = { package: { ...body, validation: { adapterId: 'bytebase', adapterVersion: '1',
    receiptId: 'validated-1', packageDigest: executionDigest(body) } } }
  const view = { prepared, issue: { id: 'issue-857', planId: 'plan-878' },
    sheet: { id: 'sheet-1', sha256: hash(sql), target }, plan: { id: 'plan-878', sheetId: 'sheet-1' } }
  const task = { id: 'task-905', planId: view.plan.id, status: 'NOT_STARTED' }
  const creationKey = executionDigest({ stage: 'create-issue', runId: 'old-run', generation: 1,
    requirementDigest: hash('old-requirement'), packageDigest: executionDigest(body), target })
  let taskRun = null, decision = 'unconfigured'
  const bundle = { issue: { ...view.issue, project: 'projects/app', operationKey: creationKey,
    packageDigest: executionDigest(body) }, sheet: { ...view.sheet, project: 'projects/app' },
    plan: { ...view.plan, project: 'projects/app' }, task }
  const bytebase = { ...api,
    getIssueBundle: async () => { calls.push('read-issue'); return bundle },
    getTaskExecution: async () => { calls.push('read-task'); return { task, taskRun } },
    getIssueApproval: async args => { calls.push('read-native-approval'); return { ...args, decision, source: 'bytebase' } },
    createIssueBundle: async () => { throw new Error('must not create') },
    runTask: async () => { throw new Error('must not execute') } }
  const production = { ...productionPostgres,
    readBaseline: async args => { calls.push('read-exact-baseline'); assert.deepEqual(args.scope, scope)
      return { ...baseline, target, project: 'projects/app', evidenceRef: 'baseline-read',
        schemaVersion: 'catalog-1', schemaDigest: hash('catalog') } },
    checkPreconditions: async args => { calls.push('read-preconditions'); return { passed: true,
      target, sqlSha256: args.applySqlSha256, checkId: 'check-1', baselineEvidenceRef: args.baseline.evidenceRef,
      schemaProofDigest: hash('catalog') } } }
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase, productionPostgres: production, uatPostgres }, ownerActorId: 'owner' })
  assert.ok(platform.availableTargets.some(item => item.workflowId === 'task-data-change-approval-resume' && item.targetId === 'app-prod'))
  const request = { action: 'external', workflowKind: 'data-change', stage: 'approval-gate', runId: 'old-run',
    generation: 1, requirementDigest: hash('old-requirement'), resourceKey: 'external:database:app',
    packageDigest: executionDigest(body), applySqlSha256: hash(sql), target }
  request.intent = await platform.dataChangeAdapter.nativeAdapter.prepareApproval({ view,
    runId: request.runId, generation: 1, requirementDigest: request.requirementDigest })
  const envelope = { data: { view, request } }, inputDigest = executionDigest(envelope)
  const node = { nodeId: 'approval-gate', nodeRunId: 'node-1', generation: 1, leaseEpoch: 2,
    inputRef: 'input-ref', inputDigest, drained: true }
  const run = { runId: 'old-run', taskId: 'task-1', workflowId: 'task-data-change', workflowDigest: 'old-definition',
    generation: 1, requirementRef: 'old-req', status: 'waiting' }
  const effect = { effectId: 'effect-1', runId: run.runId, nodeRunId: node.nodeRunId, generation: 1,
    inputDigest, state: 'unknown', definition: { action: 'external', payload: request } }
  let handoff
  const source = { sourceKey: 'current-source', sourceVersion: 1, actorId: 'owner', text: '改用插件人工审批，继续已有工单' }
  const requirement = { sourceInstructions: [source], authorization: { actorId: 'owner' } }
  platform.bindExecution({ controller: { state: async () => ({ run, nodes: [node] }), workflowDefinition: () => ({ version: '5' }),
    taskPlan: async () => ({ task: { requirementRef: 'current-req', requirementRevision: 3 } }) },
    artifacts: { read: async ref => ref === 'event-ref' ? handoff : ref === 'current-req' ? requirement : envelope },
    store: { query: async query => query.kind === 'effect.get' ? effect
      : query.kind === 'task.owner.events' ? [{ eventSeq: 1, eventType: 'approval.channel.changed', payloadRef: 'event-ref' }]
      : query.kind === 'task.source' ? { ...source, body: source.text, status: 'active' } : [effect] } })
  const proof = await platform.verifyDataChangeApprovalHandoff({ taskId: 'task-1', runId: 'old-run' })
  assert.deepEqual(proof.view, view)
  assert.deepEqual(calls, ['read-issue', 'read-task', 'read-native-approval', 'read-exact-baseline', 'read-preconditions'])
  const resume = createDataChangeApprovalResumeWorkflow({ adapter: platform.dataChangeAdapter, provider: 'test', model: 'test' })
  assert.equal(resume.id, 'task-data-change-approval-resume')
  assert.equal(resume.nodes[0].id, 'freeze-existing-issue')
  assert.equal(resume.nodes[1].id, 'prepare-approval')
  assert.equal(defineExecutionWorkflow(resume).id, resume.id)
  assert.deepEqual(resume.nodes[0].mapInput({ requirement: view }), view)
  assert.ok(!resume.nodes.some(item => ['propose-sql', 'create-issue', 'validate-package'].includes(item.id)))
  handoff = { ...proof, requirementRef: 'current-req', requirementRevision: 3, sourceKey: source.sourceKey }
  effect.state = 'failed'; effect.result = { result: { reason: 'APPROVAL_CHANNEL_SUPERSEDED' } }; run.status = 'cancelled'
  const resumeInput = await platform.prepareRequirement({ workflowId: resume.id,
    action: { taskId: run.taskId, arguments: { objective: '继续审批', targetId: 'app-prod', issueId: 'model-fake-issue' } } })
  assert.deepEqual(resumeInput, view)
  assert.deepEqual(await resume.nodes[0].execute({ taskId: run.taskId, input: resumeInput }), view)
  await assert.rejects(resume.nodes[0].execute({ taskId: run.taskId, input: { ...view,
    issue: { ...view.issue, id: 'model-fake-issue' } } }), { code: 'DATA_CHANGE_APPROVAL_HANDOFF_IDENTITY_INVALID' })
  handoff.requirementRevision = 2
  await assert.rejects(platform.prepareRequirement({ workflowId: resume.id,
    action: { taskId: run.taskId, arguments: { objective: '继续审批', targetId: 'app-prod' } } }), { code: 'DATA_CHANGE_APPROVAL_HANDOFF_STALE' })
  handoff.requirementRevision = 3
  taskRun = { id: 'run-1' }
  await assert.rejects(platform.verifyDataChangeApprovalHandoff({ taskId: 'task-1', runId: 'old-run' }), { code: 'BYTEBASE_PREAPPROVAL_EXECUTION_DETECTED' })
  taskRun = null; decision = 'pending'
  await assert.rejects(platform.verifyDataChangeApprovalHandoff({ taskId: 'task-1', runId: 'old-run' }), { code: 'BYTEBASE_APPROVAL_HANDOFF_NOT_SKIPPED' })
  effect.definition.payload = { ...request, packageDigest: hash('different') }
  await assert.rejects(platform.verifyDataChangeApprovalHandoff({ taskId: 'task-1', runId: 'old-run' }), { code: 'DATA_CHANGE_APPROVAL_HANDOFF_IDENTITY_INVALID' })
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

test('UAT 合并目标只来自受信白名单，授权不要求真人审批', async () => {
  const releaseTarget = { id: 'dataset-uat', kind: 'uat-deployment', repository: 'HiQ-AI/dataset',
    environment: 'uat', service: 'dataset', runbookId: 'dataset-uat', branch: 'uat',
    woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1, cronName: 'dataset-uat' },
    kubernetes: { namespace: 'hiqlcd-app-uat2', deployment: 'dataset' },
    registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' },
    entryUrl: 'https://uat.example.test/health' }
  const clients = { release: {
    github: Object.fromEntries(['readBranch', 'resolveApprovedPullRequest', 'readPullRequest', 'readCommit',
      'readChecks', 'readRequiredChecks', 'mergePullRequest'].map(name => [name, async () => ({})])),
    woodpecker: Object.fromEntries(['listPipelines', 'readBuildEvidence', 'triggerBuild']
      .map(name => [name, async () => ({})])),
    kubernetes: Object.fromEntries(['readDeployment', 'readPods', 'readEntry']
      .map(name => [name, async () => ({})])),
    registry: { readManifest: async () => ({}) },
  } }
  const config = { release: { targets: [releaseTarget] },
    uatMerge: { targets: [{ targetId: 'dataset-uat', requiredChecks: ['unit'], requiredScenarioIds: ['business'] }] } }
  const platform = createTrustedWorkflowPlatforms({ config, clients, ownerActorId: 'owner' })
  assert.ok(platform.uatMergeAdapter)
  assert.ok(platform.availableTargets.some(item => item.workflowId === 'task-uat-pr-merge'))
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-uat-pr-merge',
    action: { arguments: { objective: '合入 UAT', targetId: 'dataset-uat',
      pullRequestNumber: 42, headCommitSha: 'a'.repeat(40) } }, materials: [] }), { code: 'UAT_LOCAL_EVIDENCE_REQUIRED' })
  const prepared = { workflowKind: 'uat-pr-merge', operation: 'merge-uat-pr', runId: 'run-1', generation: 1,
    expected: { targetId: 'dataset-uat' } }
  const grant = await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }, prepared })
  assert.equal(grant.approval, undefined)
  assert.match(grant.authorizationRef, /^uat-merge:/)
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-uat-pr-merge',
    action: { arguments: { objective: '合入 UAT', targetId: 'other',
      pullRequestNumber: 42, headCommitSha: 'a'.repeat(40) } }, materials: [] }),
  { code: 'UAT_MERGE_TARGET_NOT_ALLOWED' })
})
