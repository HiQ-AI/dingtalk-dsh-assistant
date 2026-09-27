import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const developmentSha = 'a'.repeat(40)
const mergeSha = 'b'.repeat(40)
const treeSha = 'c'.repeat(40)
const target = { id: 'uat', kind: 'uat-deployment', repository: 'HiQ-AI/dataset', environment: 'uat',
  service: 'dataset', runbookId: 'dataset-uat', branch: 'uat',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1, cronName: 'build' },
  kubernetes: { namespace: 'uat', deployment: 'dataset' },
  registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' }, entryUrl: 'https://uat.example.test/health' }

function fixture({ tree = treeSha, e2e = true, mergeRun = false, localMerge = false } = {}) {
  const selectedTarget = localMerge ? { ...target, branch: 'feature/uat3-base' } : target
  const outputs = {
    'verify-candidate': { candidate: { digest: 'd'.repeat(64), tree: treeSha },
      verification: { digest: 'e'.repeat(64), passed: true, checks: e2e ? [{ id: 'business-e2e', version: '1', passed: true }] : [] } },
    'prepare-commit': { commitId: developmentSha, candidateDigest: 'd'.repeat(64), tree: treeSha, verification: { digest: 'e'.repeat(64) } },
    commit: { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded' } },
    'prepare-push': { commitId: developmentSha, verificationDigest: 'e'.repeat(64) },
    push: { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded' } },
    'prepare-pr': { commitId: developmentSha },
    'create-pr': { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded', number: 1, url: 'https://github.com/HiQ-AI/dataset/pull/1' } },
    finalize: { deliveryStatus: 'pr_verified', commitId: developmentSha, number: 1,
      url: 'https://github.com/HiQ-AI/dataset/pull/1', repo: 'HiQ-AI/dataset', head: 'feature/fix', base: 'uat', state: 'OPEN' },
    'verify-source': { status: 'confirmed', repository: target.repository, service: target.service,
      baseBranch: target.branch, pullRequestNumber: 1, headCommitSha: developmentSha,
      mergeCommitSha: mergeSha, treeSha, evidenceRefs: ['merge-pr', 'merge-tree'] },
  }
  const nodes = Object.keys(outputs).map(nodeId => ({ nodeId, status: 'succeeded', outputRef: `artifact:${nodeId}` }))
  if (localMerge) {
    outputs.finalize.base = selectedTarget.branch
    const plan = {cases:[{criterionId:'criterion-1',scenarioId:'business',steps:['业务验证'],expected:'通过',parameters:{}}]}
    const prepared = {taskId:'task-1',runId:'engineering-run',candidateDigest:'d'.repeat(64),identity:'a'.repeat(64),
      plan,planDigest:executionDigest(plan),uatEnvironment:'uat3'}
    outputs['define-local-acceptance']={localContext:{criteria:[{id:'criterion-1',description:'结果正确'}],scenarios:[{id:'business'}],uatEnvironment:'uat3'}}
    outputs['finalize-local-acceptance']={localPrepared:prepared,localAcceptance:{identity:prepared.identity,candidateDigest:prepared.candidateDigest,
      planDigest:prepared.planDigest,uatEnvironment:'uat3',passed:true,cleanup:{dataCleaned:true,processStopped:true},checks:[{...plan.cases[0],actual:'通过',passed:true}]}}
    for(const nodeId of ['define-local-acceptance','finalize-local-acceptance'])nodes.push({nodeId,status:'succeeded',outputRef:`artifact:${nodeId}`})
  }
  const clients = { release: {
    github: {
      readChecks:async()=>({complete:true,checks:[],evidenceRef:'checks'}),
      readRequiredChecks:async()=>({complete:true,checks:[],evidenceRef:'rules'}),
      mergePullRequest:async()=>{throw Error('test must not merge')},
      readBranch: async () => ({ commitSha: mergeSha, evidenceRef: 'branch' }),
      resolveApprovedPullRequest: async () => ({ number: 1, merged: true, unique: true, baseBranch: 'uat', mergeCommitSha: mergeSha, evidenceRef: 'unique-pr' }),
      readPullRequest: async () => ({ number: 1, merged: true, baseBranch: 'uat', headCommitSha: developmentSha, mergeCommitSha: mergeSha, evidenceRef: 'pr' }),
      readCommit: async ({ commitSha }) => ({ commitSha, treeSha: commitSha === mergeSha ? tree : treeSha, evidenceRef: `commit:${commitSha}` }),
    },
    woodpecker: { listPipelines: async () => ({ complete: true, hasMore: false, pipelines: [], evidenceRef: 'pipelines' }),
      readBuildEvidence: async () => ({}), triggerBuild: async () => ({}) },
    kubernetes: { readDeployment: async () => ({}), readPods: async () => ({}), readEntry: async () => ({}) },
    registry: { readManifest: async () => ({}) },
  } }
  const platform = createTrustedWorkflowPlatforms({ config: { release: { targets: [selectedTarget] },
    ...(localMerge?{uatMerge:{targets:[{targetId:target.id,requiredChecks:[],requiredScenarioIds:['business']}]}}:{}) }, clients, ownerActorId: 'owner' })
  const workflowId = `task-engineering-${executionDigest('engineering-source').slice(0, 40)}`
  const workflowDigest = 'f'.repeat(64)
  platform.bindExecution({ controller: { state: async runId => ({ run: { runId,
    taskId: 'task-1', workflowId: mergeRun && runId === 'merge-run' ? 'task-uat-pr-merge' : workflowId,
    workflowDigest, status: 'succeeded' }, nodes: mergeRun && runId === 'merge-run'
      ? [nodes.find(node => node.nodeId === 'verify-source')] : nodes }) },
    store: { query: async () => [{ workflowId, digest: workflowDigest,
      ...(localMerge?{definitionVersion:'12'}:{}),
      config: { kind: 'engineering', taskId: 'task-1', runId: 'engineering-run', sourceCommandId: 'engineering-source' } }] },
    artifacts: { read: async ref => outputs[ref.slice('artifact:'.length)] } })
  const requirement = { request: '部署 UAT', constraints: [], target: { repository: target.repository, environment: target.environment,
    service: target.service, runbookId: target.runbookId, commitSha: mergeSha },
  evidenceRefs: ['engineering-task:task-1:engineering-run'] }
  return { platform, requirement, outputs }
}

test('合并 Host 从同任务工程工件建立本地证明，拒绝参数伪造和跨任务引用',async()=>{
  const {platform,outputs}=fixture({localMerge:true})
  const request={workflowId:'task-uat-pr-merge',action:{taskId:'task-1',arguments:{objective:'合并',targetId:'uat',pullRequestNumber:1,headCommitSha:developmentSha,
    localEvidence:{passed:true}}},materials:[{resourceRef:'engineering-task:task-1:engineering-run'}]}
  const result=await platform.prepareRequirement(request)
  assert.deepEqual(result.requiredChecks,[])
  assert.equal(result.localEvidence.uatEnvironment,'uat3')
  assert.equal(result.localEvidence.passed,undefined)
  await assert.rejects(platform.prepareRequirement({...request,action:{...request.action,taskId:'other'}}),/UAT_LOCAL_EVIDENCE_REQUIRED/)
  await assert.rejects(platform.prepareRequirement({...request,action:{...request.action,arguments:{...request.action.arguments,headCommitSha:mergeSha}}}),/UAT_LOCAL_EVIDENCE_MISMATCH/)
  const saved=structuredClone(outputs['finalize-local-acceptance'])
  const receipt=outputs['finalize-local-acceptance']
  outputs['verify-candidate'].verification.checks.push({id:'business',version:'1',passed:true})
  outputs['define-local-acceptance'].localContext.scenarios.push({id:'uat-readonly-api'})
  receipt.localPrepared.plan.cases[0].scenarioId='uat-readonly-api'
  receipt.localPrepared.planDigest=executionDigest(receipt.localPrepared.plan)
  receipt.localAcceptance.planDigest=receipt.localPrepared.planDigest
  receipt.localAcceptance.checks[0].scenarioId='uat-readonly-api'
  await assert.rejects(platform.prepareRequirement(request),/UAT_LOCAL_SCENARIO_REQUIRED/)
  outputs['finalize-local-acceptance']=saved
  outputs['finalize-local-acceptance'].localAcceptance.cleanup.processStopped=false
  await assert.rejects(platform.prepareRequirement(request),/ENGINEERING_ACCEPTANCE_PROOF_REQUIRED/)
})

test('UAT 部署可衔接工程 Run，核对 PR 与相同 Git tree 且不要求业务 E2E', async () => {
  const { platform, requirement } = fixture()
  const prepared = await platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: 'engineering-task:task-1:engineering-run' }] })
  assert.equal(prepared.target.commitSha, mergeSha)
  assert.ok(prepared.evidenceRefs.includes('engineering-task:task-1:engineering-run'))
  assert.ok(prepared.evidenceRefs.some(ref => ref.startsWith('uat-source-proof:')))
  const result = await platform.releaseAdapters['uat-deployment'].inspect({ phase: 'preflight', requirement })
  assert.equal(result.facts.uatPrMerged, true)
  assert.equal(result.facts.localE2ePassed, undefined)
})

test('独立 UAT 部署无需工程 Run；自动衔接的 Git tree 漂移仍阻断', async () => {
  const { platform } = fixture({ e2e: false })
  const standalone = await platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { arguments: { objective: '部署 UAT', targetId: 'uat', commitSha: mergeSha }, constraints: [] }, materials: [] })
  assert.equal(standalone.target.commitSha, mergeSha)
  assert.deepEqual(standalone.evidenceRefs, ['branch'])
  const linked = await platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: 'engineering-task:task-1:engineering-run' }] })
  assert.equal(linked.target.commitSha, mergeSha)
  const drift = fixture({ tree: 'f'.repeat(40) })
  await assert.rejects(drift.platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: 'engineering-task:task-1:engineering-run' }] }),
  { code: 'UAT_SOURCE_CHAIN_UNCONFIRMED' })
})

test('合并 Run 的不可变来源工件绑定同 Task UAT 部署，跨 Task 和 tree 漂移阻断', async () => {
  const { platform } = fixture({ mergeRun: true })
  const marker = 'uat-merge-task:task-1:merge-run'
  const prepared = await platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { taskId: 'task-1', arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: marker }] })
  assert.equal(prepared.target.commitSha, mergeSha)
  assert.ok(prepared.evidenceRefs.includes(marker))
  assert.ok(prepared.evidenceRefs.some(ref => ref.startsWith('uat-merge-source-proof:')))
  await assert.rejects(platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { taskId: 'task-2', arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: marker }] }), { code: 'UAT_MERGE_TASK_MISMATCH' })
  const drift = fixture({ mergeRun: true, tree: 'f'.repeat(40) })
  await assert.rejects(drift.platform.prepareRequirement({ workflowId: 'task-uat-deployment',
    action: { taskId: 'task-1', arguments: { objective: '部署 UAT' }, constraints: [] },
    materials: [{ resourceRef: marker }] }), { code: 'UAT_MERGE_SOURCE_CHAIN_UNCONFIRMED' })
})
