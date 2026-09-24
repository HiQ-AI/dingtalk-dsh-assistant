import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'

const target = { instance: 'instances/prod', database: 'instances/prod/databases/app', environment: 'production' }
const config = { bytebase: { adapterId: 'bytebase', adapterVersion: '1', targets: [{
  id: 'app-prod', project: 'projects/app', target,
  isolation: { target: { instance: 'instances/isolated', database: 'instances/isolated/databases/app', environment: 'isolated' },
    proofRef: 'clone-proof' },
}] } }
const api = Object.fromEntries(['getDatabase', 'validateSql', 'rehearseIsolated', 'createIssueBundle',
  'getIssueBundle', 'getApproval', 'runTask', 'getTaskExecution', 'queryVerification',
  'findIssueByOperationKey'].map(name => [name, async () => ({})]))

test('未配置目标时不注册外部流程，缺受信端口时拒绝启动', () => {
  assert.equal(createTrustedWorkflowPlatforms({ config: {}, clients: {}, ownerActorId: 'owner' }), null)
  assert.throws(() => createTrustedWorkflowPlatforms({ config, clients: {}, ownerActorId: 'owner' }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => createTrustedWorkflowPlatforms({ config: { release: { targets: [{ kind: 'production-release' }] } },
    clients: {}, ownerActorId: 'owner' }), { code: 'PRODUCTION_APPROVER_NOT_CONFIGURED' })
})

test('数据变更输入只接受白名单目标、精确 SQL 来源与基线材料', async () => {
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase: api }, ownerActorId: 'owner' })
  const action = { arguments: { objective: '修正一条记录', targetId: 'app-prod',
    changeRef: 'sql-1', baselineRef: 'baseline-1' }, constraints: ['仅此数据库'] }
  const materials = [{ resourceRef: 'sql-1', text: 'UPDATE app SET x = 1 WHERE id = 1;' },
    { resourceRef: 'baseline-1', text: JSON.stringify({ snapshotId: 'snapshot-1', sha256: 'a'.repeat(64) }) }]
  const requirement = await platform.prepareRequirement({ workflowId: 'task-data-change', action, materials })
  assert.deepEqual(requirement.target, target)
  assert.equal(requirement.sources[0].id, 'sql-1')
  assert.deepEqual(requirement.constraints, ['仅此数据库'])
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-data-change',
    action: { ...action, arguments: { ...action.arguments, targetId: 'other' } }, materials }),
  { code: 'EXTERNAL_TARGET_NOT_ALLOWED' })
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-data-change', action, materials: materials.slice(0, 1) }),
    { code: 'EXTERNAL_MATERIAL_NOT_FOUND' })
})

test('效果授权固定绑定运行身份并要求主人逐次批准', async () => {
  const platform = createTrustedWorkflowPlatforms({ config, clients: { bytebase: api }, ownerActorId: 'owner' })
  const prepared = { workflowKind: 'data-change', runId: 'run-1', generation: 1, target }
  const grant = await platform.authorizeExternal({ binding: { runId: 'run-1', nodeRunId: 'node-1', generation: 1 }, prepared })
  assert.deepEqual(grant.approval.approverIds, ['owner'])
  await assert.rejects(platform.authorizeExternal({ binding: { runId: 'run-2', nodeRunId: 'node-1', generation: 1 }, prepared }),
    { code: 'EXTERNAL_AUTHORIZATION_IDENTITY_INVALID' })
})
