import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { continueFailedUatStage } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const target = { id: 'deploy', kind: 'uat-deployment', repository: 'HiQ-AI/dataset-web', environment: 'uat',
  service: 'dataset-web', runbookId: 'web-uat2-deployment', branch: 'feature/uat2-base',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 2, cronName: 'uat2' },
  kubernetes: { namespace: 'uat2', deployment: 'dataset-web' },
  registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web' }, entryUrl: 'https://editor2.example.test/' }
const commitSha = 'a'.repeat(40)
function proofFixture(mutate = () => {}) {
  const requirement = { request: '验收并提测原任务', constraints: ['仅 UAT2'],
    target: { repository: target.repository, environment: 'uat', service: target.service, runbookId: target.runbookId, commitSha },
    evidenceRefs: ['uat-merge-task:task:merge'] }
  const state = { run: { runId: 'failed-run', taskId: 'task', workflowId: 'task-uat-deployment', status: 'failed', generation: 1, requirementRef: 'requirement' },
    nodes: [{ nodeId: 'execute-build', nodeRunId: 'build-node', inputDigest: 'input', drained: true, status: 'failed', waitReason: { reference: 'RELEASE_PIPELINE_FAILED' } }] }
  const prepared = { workflowKind: 'uat-deployment', operation: 'build', operationKey: 'b'.repeat(64), runId: 'failed-run', generation: 1,
    expected: { commitSha }, requirementDigest: executionDigest(requirement), targetDigest: executionDigest(requirement.target) }
  const effect = { runId: 'failed-run', nodeRunId: 'build-node', generation: 1, inputDigest: 'input', state: 'failed',
    definition: { action: 'external', adapterId: 'external-operation', adapterVersion: '1', payload: prepared },
    result: { result: { status: 'failed', reason: 'RELEASE_PIPELINE_FAILED', operationKey: prepared.operationKey,
      commitSha, pipelineNumber: 319, pipelineStatus: 'killed', evidenceRef: 'pipeline-319' } } }
  const rebuilt = { ...structuredClone(target), id: 'rebuild', kind: 'uat-rebuild', runbookId: 'web-uat2-rebuild' }
  const data = { state, requirement, effect, rebuilt, branchSha: commitSha }; mutate(data)
  const noWrite = async () => { throw Error('REMOTE_WRITE_FORBIDDEN') }
  const clients = { release: {
    github: { readBranch: async () => ({ commitSha: data.branchSha, evidenceRef: 'branch' }), resolveApprovedPullRequest: noWrite, readPullRequest: noWrite },
    woodpecker: { listPipelines: noWrite, readBuildEvidence: noWrite, triggerBuild: noWrite },
    registry: { readManifest: noWrite }, kubernetes: { readDeployment: noWrite, readPods: noWrite, readEntry: noWrite },
  } }
  const platform = createTrustedWorkflowPlatforms({ config: { release: { targets: [target, rebuilt] } }, clients, ownerActorId: 'owner' })
  platform.bindExecution({ controller: { state: async () => state }, artifacts: { read: async () => requirement }, store: { query: async () => [effect] } })
  return { platform, ...data }
}

test('失败部署可信绑定同任务、同UAT、同提交的重建输入，不触发远端写', async () => {
  const { platform } = proofFixture()
  const input = await platform.prepareUatRebuildFromFailure({ taskId: 'task', runId: 'failed-run', mergeRunId: 'merge' })
  assert.equal(input.target.commitSha, commitSha)
  assert.equal(input.target.runbookId, 'web-uat2-rebuild')
  assert.deepEqual(input.constraints, ['仅 UAT2'])
  assert.ok(input.evidenceRefs.includes('uat-failed-task:task:failed-run'))
})

for (const [name, mutate] of [
  ['unknown', f => { f.effect.state = 'unknown' }],
  ['other-task', f => { f.state.run.taskId = 'other' }],
  ['other-node', f => { f.effect.nodeRunId = 'other' }],
  ['other-commit', f => { f.effect.result.result.commitSha = 'c'.repeat(40) }],
  ['undrained', f => { f.state.nodes[0].drained = false }],
  ['wrong-merge', f => { f.requirement.evidenceRefs = ['uat-merge-task:task:other'] }],
  ['wrong-environment', f => { f.rebuilt.kubernetes.namespace = 'uat3' }],
  ['changed-head', f => { f.branchSha = 'd'.repeat(40) }],
]) test(`重建接续拒绝 ${name}`, async () => {
  const { platform } = proofFixture(mutate)
  await assert.rejects(platform.prepareUatRebuildFromFailure({ taskId: 'task', runId: 'failed-run', mergeRunId: 'merge' }))
})

function continuationFixture({ crashAfterRevise = false, gate = 'none' } = {}) {
  const plan = { task: { controlState: 'active', planRevision: 1, controlRevision: 1, requirementRevision: 1 }, stages: [
    { stageId: 'stage-1', workflowId: 'task-engineering-test', status: 'succeeded', runId: 'engineering', outputRef: 'engineering-out', gate: 'none' },
    { stageId: 'stage-2', workflowId: 'task-uat-pr-merge', status: 'succeeded', runId: 'merge', outputRef: 'merge-out', gate: 'none' },
    { stageId: 'stage-3', workflowId: 'task-uat-deployment', status: 'blocked', runId: 'failed-run', attempt: 1, gate },
  ] }
  const calls = [], saved = structuredClone(plan.stages.slice(0, 2)), { platform } = proofFixture()
  const store = { query: async () => ({ channel: 'web', run: { request: { stages: ['task-engineering', 'task-uat-pr-merge', 'task-uat-deployment'] } } }) }
  const controller = {
    reviseTaskPlan: async args => { calls.push(['revise', args]); plan.task.planRevision++; plan.stages[2] = { ...args.stages[2],
      status: gate === 'confirmation' ? 'waiting_confirmation' : 'ready', attempt: 2, requirementRef: null }; if (crashAfterRevise) { crashAfterRevise = false; throw Error('CRASH_AFTER_REVISION') } },
    taskPlan: async () => plan,
    plannedTaskStageRunId: args => { assert.deepEqual(args, { taskId: 'task', planRevision: 1, stageId: 'stage-3', attempt: 1 }); return 'failed-run' },
    bindTaskStageInput: async args => { calls.push(['bind', args]); plan.stages[2].requirementRef = 'rebuild-input' },
    advanceTaskPlan: async () => { calls.push(['advance']); plan.stages[2].status = 'running'; return plan },
  }
  const run = () => continueFailedUatStage({ taskId: 'task', plan, store, controller, external: platform })
  return { plan, calls, saved, run }
}

test('原任务仅替换失败第三阶段，前两阶段及失败历史保留；重复调用不重建', async () => {
  const f = continuationFixture(); await f.run(); await f.run()
  assert.deepEqual(f.plan.stages.slice(0, 2), f.saved)
  assert.deepEqual(f.calls.map(c => c[0]), ['revise', 'bind', 'advance'])
  assert.equal(f.calls[0][1].affectedFrom, 2)
  assert.equal(f.calls[1][1].predecessorOutputRef, 'merge-out')
  f.plan.stages[2].status = 'blocked'; await f.run()
  assert.equal(f.calls.length, 3)
})

test('修订后绑定前中断可同固定失败源接续，不重复计划修订', async () => {
  const f = continuationFixture({ crashAfterRevise: true })
  await assert.rejects(f.run(), /CRASH_AFTER_REVISION/); await f.run()
  assert.deepEqual(f.calls.map(c => c[0]), ['revise', 'bind', 'advance'])
  assert.deepEqual(f.plan.stages.slice(0, 2), f.saved)
})

test('保留原阶段确认门禁，未确认不启动重建', async () => {
  const f = continuationFixture({ gate: 'confirmation' }); await f.run()
  assert.deepEqual(f.calls.map(c => c[0]), ['revise'])
  assert.equal(f.plan.stages[2].status, 'waiting_confirmation')
  f.plan.stages[2].status = 'ready'; await f.run()
  assert.deepEqual(f.calls.map(c => c[0]), ['revise', 'bind', 'advance'])
})
