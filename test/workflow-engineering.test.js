import { readTaskOwnerStageArtifacts } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEngineeringRegistry, readEngineeringDeliveryProof, readEngineeringRemoteRefs, uatBranchFor, isUatBranch, engineeringWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'

test('重执行复用受信开发分支最新提交并冻结远端，保留源检出与历史定义', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-branch-reuse-')), source = join(directory, 'source'), remote = join(directory, 'remote.git')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base')
  await git('init', '--bare', remote); await git('push', remote, 'HEAD:refs/heads/feature/uat2-base')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'branches', initialize: true }); t.after(() => store.close())
  const options = { ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }), author: { name: 'Test', email: 'test@example.invalid' },
    repositories: [{ id: 'repo', sourceRepository: source, managedRoot: join(directory, 'managed'), remote, baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'],
      checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] }
  const registry = createEngineeringRegistry(options); await registry.restore(store)
  let workflow
  const controller = { registerWorkflow(value) { workflow = value } }
  const prepare = (taskId, commandId, rerunOfTaskId) => registry.prepareTask({ taskId, arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修改代码' } },
    { commandId, ...(rerunOfTaskId ? { rerunOfTaskId } : {}), run: { actorId: 'owner' }, unit: {} }, controller)
  const original = await prepare('original', 'first')
  const oldRecord = (await store.query({ kind: 'workflow.list' }))[0], head = oldRecord.config.head
  await git('push', remote, `HEAD:refs/heads/${head}`)
  await writeFile(join(source, 'value.txt'), 'latest'); await git('commit', '-am', 'latest'); await git('push', remote, `HEAD:refs/heads/${head}`)
  const latest = await git('rev-parse', 'HEAD'), sourceBranch = await git('symbolic-ref', 'HEAD')
  const rerun = await prepare('new-task', 'second', 'original')
  const record = (await store.query({ kind: 'workflow.list' })).find(item => item.config.taskId === 'new-task')
  assert.notEqual(rerun.runId, original.runId); assert.equal(record.config.head, head); assert.equal(rerun.input.baseCommit, latest)
  assert.deepEqual(record.config.branchSource, { taskId: 'original', expectedRemoteSha: latest })
  assert.equal(record.config.taskBase, oldRecord.config.input.baseCommit)
  assert.equal(record.config.targetCommit, oldRecord.config.targetCommit)
  assert.equal(await git('symbolic-ref', 'HEAD'), sourceBranch)
  const start = workflow.nodes.find(node => node.id === 'prepare-generation')
  const output = await start.execute({ input: rerun.input, runId: rerun.runId, generation: 1 })
  assert.equal(output.requirement.expectedRemoteSha, latest)
  const workspaceNode = workflow.nodes.find(node => node.id === 'prepare-workspace')
  const workspaceContext = { input: output.requirement, runId: rerun.runId, generation: 1, requirementDigest: 'a'.repeat(64),
    perform: effect => registry.deliveryOptions.workspaceAdapter.execute(effect.prepared) }
  const workspaceOutput = await workspaceNode.execute(workspaceContext)
  assert.equal(workspaceOutput.workspace.developmentBranch, head)
  assert.equal(workspaceOutput.workspace.branchDisposition, 'reused')
  assert.equal(workspaceOutput.workspace.targetBranch, 'feature/uat2-base')
  assert.equal((await exec('git', ['-C', workspaceOutput.workspace.directory, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true })).stdout.trim(), 'HEAD')
  assert.deepEqual((await store.query({ kind: 'workflow.list' })).find(item => item.workflowId === oldRecord.workflowId), oldRecord)
  const restored = createEngineeringRegistry(options); await restored.restore(store)
  await assert.rejects(prepare('missing-source', 'missing-source', 'unknown-task'), { code: 'ENGINEERING_BRANCH_SOURCE_INVALID' })
  const legacy = structuredClone(oldRecord)
  delete legacy.config.repositoryIdentity
  legacy.config.repositoryDigest = 'old-config-digest'
  for (const [index, evidence] of [
    { state: 'failed', remote, ref: `refs/heads/${head}` },
    { state: 'succeeded', remote: 'https://github.com/foreign/repo.git', ref: `refs/heads/${head}` },
    { state: 'succeeded', remote, ref: 'refs/heads/foreign' },
    { state: 'succeeded', remote, ref: `refs/heads/${head}` },
  ].entries()) {
    const migrated = createEngineeringRegistry(options)
    await migrated.restore({ command: value => store.command(value), query: value => {
      if (value.kind === 'workflow.list') return [legacy]
      if (value.kind === 'run') return { run: { status: 'succeeded', workflowDigest: legacy.digest } }
      if (value.kind === 'effect.list') return [{ state: evidence.state, definition: { action: 'push', payload: { remote: evidence.remote, ref: evidence.ref } } },
        ...(index === 3 ? [{ state: 'succeeded', generation: 1, definition: { action: 'pr', payload: { repo: 'example/repo', head, base: 'main', operationKey: 'f'.repeat(64) } }, result: { result: { status: 'succeeded', number: 371 } } }] : [])]
      return store.query(value)
    } })
    const request = migrated.prepareTask({ taskId: `legacy-${index}`, arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修改代码' } },
      { commandId: `legacy-${index}`, rerunOfTaskId: 'original', run: { actorId: 'owner' }, unit: {} }, controller)
    if (index < 3) await assert.rejects(request, { code: 'ENGINEERING_BRANCH_SOURCE_INVALID' })
    else {
      assert.equal((await request).input.baseCommit, latest)
      const selected = (await store.query({ kind: 'workflow.list' })).find(record => record.config?.taskId === 'legacy-3')
      assert.deepEqual(selected.config.previousPullRequest, { number: 371, repo: 'example/repo', head, base: 'main', operationKey: 'f'.repeat(64) })
    }
  }
  await writeFile(join(source, 'value.txt'), 'concurrent'); await git('commit', '-am', 'concurrent'); await git('push', remote, `HEAD:refs/heads/${head}`)
  await assert.rejects(start.execute({ input: rerun.input, runId: rerun.runId, generation: 1 }), { code: 'GIT_REMOTE_CONFLICT' })
  await assert.rejects(workspaceNode.execute(workspaceContext), { code: 'GIT_REMOTE_CONFLICT' })
  await git('push', remote, `:refs/heads/${head}`)
  await prepare('after-delete', 'third', 'original')
  const deleted = (await store.query({ kind: 'workflow.list' })).find(item => item.config.taskId === 'after-delete')
  assert.notEqual(deleted.config.head, head); assert.equal(deleted.config.branchSource, undefined)
  await prepare('original', 'fourth')
  await assert.rejects(prepare('ambiguous', 'fifth', 'original'), { code: 'ENGINEERING_BRANCH_SOURCE_AMBIGUOUS' })
})

test('工程交付证明复用同一 Run 工件并要求显式业务 E2E 检查', async () => {
  const commitId = 'a'.repeat(40), candidateDigest = 'b'.repeat(64), verificationDigest = 'c'.repeat(64)
  const output = {
    'verify-candidate': { candidate: { digest: candidateDigest, tree: 'd'.repeat(40) },
      verification: { digest: verificationDigest, passed: true, checks: [{ id: 'business-e2e', version: '1', passed: true }] } },
    'prepare-commit': { commitId, candidateDigest, tree: 'd'.repeat(40), verification: { digest: verificationDigest } },
    commit: { prepared: { commitId }, receipt: { status: 'succeeded' } },
    'prepare-push': { commitId, verificationDigest },
    push: { prepared: { commitId }, receipt: { status: 'succeeded' } },
    'prepare-pr': { commitId },
    'create-pr': { prepared: { commitId }, receipt: { status: 'succeeded', number: 42, url: 'https://github.com/a/b/pull/42' } },
    finalize: { deliveryStatus: 'pr_verified', commitId, number: 42, url: 'https://github.com/a/b/pull/42',
      repo: 'a/b', head: 'feature/test', base: 'main', state: 'OPEN' },
  }
  const nodes = Object.keys(output).map(nodeId => ({ nodeId, status: 'succeeded', outputRef: `artifact:${nodeId}` }))
  const artifacts = { read: async ref => output[ref.slice('artifact:'.length)] }
  const workflowId = `task-engineering-${executionDigest('source').slice(0, 40)}`
  const state = { run: { runId: 'r', taskId: 't', workflowId, workflowDigest: 'f'.repeat(64), status: 'succeeded' }, nodes }
  const record = { workflowId, digest: state.run.workflowDigest,
    config: { kind: 'engineering', taskId: 't', runId: 'r', sourceCommandId: 'source' } }
  const store = { query: async () => [record] }
  const proof = await readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't', requiredE2eCheckIds: ['business-e2e'] })
  assert.equal(proof.commitSha, commitId)
  assert.equal(proof.localE2ePassed, true)
  assert.equal(proof.evidenceRefs.length, 8)
  assert.equal((await readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't' })).localE2ePassed, false)
  const reissueId = `task-engineering-reissue-${executionDigest(['r', 'reissue-request']).slice(0, 40)}`
  const reissued = { ...state, run: { ...state.run, workflowId: reissueId } }
  const reissueStore = { query: async () => [{ ...record, workflowId: reissueId,
    config: { ...record.config, reissueRequestId: 'reissue-request' } }] }
  assert.equal((await readEngineeringDeliveryProof({ state: reissued, artifacts, store: reissueStore, taskId: 't' })).commitSha, commitId)
  await assert.rejects(readEngineeringDeliveryProof({ state: { ...state, run: { ...state.run,
    workflowId: 'task-engineering' } }, artifacts, store, taskId: 't' }),
  { code: 'ENGINEERING_DELIVERY_PROOF_UNAVAILABLE' })
  await assert.rejects(readEngineeringDeliveryProof({ state, artifacts, store: { query: async () => [{ ...record,
    digest: 'e'.repeat(64) }] }, taskId: 't' }), { code: 'ENGINEERING_DELIVERY_PROOF_UNAVAILABLE' })
  record.definitionVersion = '10'
  await assert.rejects(readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't' }), { code: 'ENGINEERING_ACCEPTANCE_PROOF_REQUIRED' })
  output['business-acceptance'] = { acceptance: { passed: true, candidateDigest, checks: [{ id: 'acceptance', passed: true }] } }
  state.nodes.push({ nodeId: 'business-acceptance', status: 'succeeded', outputRef: 'artifact:business-acceptance' })
  assert.equal((await readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't', requiredE2eCheckIds: ['acceptance'] })).localE2ePassed, true)
  output['business-acceptance'].acceptance.candidateDigest = 'e'.repeat(64)
  await assert.rejects(readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't' }), { code: 'ENGINEERING_ACCEPTANCE_PROOF_REQUIRED' })
  record.definitionVersion = '12'
  output.finalize.base = 'feature/uat3-base'
  const plan = { cases: [{ criterionId: 'criterion-1', scenarioId: 'business', steps: ['执行真实业务'], expected: '通过', parameters: {} }] }
  const localPrepared = { taskId:'t',runId:'r',candidateDigest,identity:'f'.repeat(64),plan,
    planDigest:executionDigest(plan),uatEnvironment:'uat3' }
  output['define-local-acceptance'] = {localContext:{criteria:[{id:'criterion-1',description:'业务结果正确'}],scenarios:[{id:'business'}],uatEnvironment:'uat3'}}
  output['finalize-local-acceptance'] = {localPrepared,localAcceptance:{identity:localPrepared.identity,
    candidateDigest,planDigest:localPrepared.planDigest,uatEnvironment:'uat3',passed:true,cleanup:{dataCleaned:true,processStopped:true},
    checks:[{...plan.cases[0],actual:'通过',passed:true}]}}
  for (const nodeId of ['define-local-acceptance','finalize-local-acceptance'])state.nodes.push({nodeId,status:'succeeded',outputRef:`artifact:${nodeId}`})
  const localProof=await readEngineeringDeliveryProof({state,artifacts,store,taskId:'t'})
  assert.deepEqual(localProof.localEvidence.scenarioIds,['business'])
  assert.equal(localProof.localEvidence.commitSha,commitId)
  state.nodes = [...state.nodes.filter(node=>node.nodeId!=='finalize'),state.nodes.find(node=>node.nodeId==='finalize')]
  const stage = {stageId:'engineering',status:'succeeded',runId:'r',workflowId:state.run.workflowId,workflowDigest:state.run.workflowDigest,outputRef:'artifact:finalize',evidenceRefs:[]}
  const controller = {state:async()=>state,workflowDefinition:()=>({ownerContract:engineeringWorkflowOwnerContract})}
  const ownerArgs = {taskId:'t',stages:[stage],controller,readStageArtifacts:createTaskWorkflowContracts({controller,artifacts,store}).readStageArtifacts}
  const ownerArtifacts = await readTaskOwnerStageArtifacts(ownerArgs)
  assert.equal(await engineeringWorkflowOwnerContract.validateCompletion({taskId:'t',state,artifacts,store}),true)
  assert.deepEqual(ownerArtifacts[0].nodeArtifacts.map(item=>item.nodeId).sort(),['define-local-acceptance','finalize-local-acceptance','verify-candidate'])
  assert.ok(ownerArtifacts[0].nodeArtifacts.every(item=>item.description && ownerArtifacts[0].evidenceRefs.includes(item.artifactRef)))
  assert.ok(!ownerArtifacts[0].evidenceRefs.includes('artifact:prepare-push'))
  assert.deepEqual(ownerArtifacts[0].completionEvidenceRefs,['artifact:finalize'])
  await assert.rejects(readTaskOwnerStageArtifacts({...ownerArgs,taskId:'other'}),/TASK_OWNER_STAGE_RUN_MISMATCH/)
  await assert.rejects(readTaskOwnerStageArtifacts({...ownerArgs,stages:[{...stage,outputRef:'artifact:other'}]}),/WORKFLOW_OWNER_STAGE_MISMATCH/)

  for(const mutate of [
    ()=>{localPrepared.taskId='other'},
    ()=>{output['define-local-acceptance'].localContext.criteria.push({id:'criterion-2',description:'遗漏'})},
    ()=>{output['finalize-local-acceptance'].localAcceptance.checks[0].actual='未通过'},
    ()=>{output['finalize-local-acceptance'].localAcceptance.cleanup.dataCleaned=false},
  ]){
    const savedLocal=structuredClone(output['finalize-local-acceptance']),savedDefine=structuredClone(output['define-local-acceptance'])
    mutate()
    await assert.rejects(readEngineeringDeliveryProof({state,artifacts,store,taskId:'t'}),{code:'ENGINEERING_ACCEPTANCE_PROOF_REQUIRED'})
    await assert.rejects(readTaskOwnerStageArtifacts(ownerArgs),{code:'ENGINEERING_ACCEPTANCE_PROOF_REQUIRED'})
    await assert.rejects(engineeringWorkflowOwnerContract.validateCompletion({taskId:'t',state,artifacts,store}),{code:'ENGINEERING_ACCEPTANCE_PROOF_REQUIRED'})
    Object.assign(localPrepared,savedLocal.localPrepared)
    output['finalize-local-acceptance']={...savedLocal,localPrepared};output['define-local-acceptance']=savedDefine
  }
  record.definitionVersion='13';record.config.targetCommit='e'.repeat(40);record.config.taskBase='f'.repeat(40)
  output['prepare-commit'].mergeParent=record.config.targetCommit
  output['prepare-workspace']={workspace:{targetCommit:record.config.targetCommit,taskBase:record.config.taskBase,mergeTree:'d'.repeat(40),conflictPaths:[]}}
  state.nodes.push({nodeId:'prepare-workspace',status:'succeeded',outputRef:'artifact:prepare-workspace'})
  assert.equal((await readEngineeringDeliveryProof({state,artifacts,store,taskId:'t'})).localEvidence.taskBase,record.config.taskBase)
  output['prepare-workspace'].workspace.taskBase='a'.repeat(40)
  await assert.rejects(readEngineeringDeliveryProof({state,artifacts,store,taskId:'t'}),/ENGINEERING_UAT_BASELINE_PROOF_REQUIRED/)
  delete record.definitionVersion
  output['prepare-push'].commitId = 'e'.repeat(40)
  await assert.rejects(readEngineeringDeliveryProof({ state, artifacts, store, taskId: 't' }), { code: 'ENGINEERING_DELIVERY_PROOF_MISMATCH' })
})

test('已终结工程 Run 的旧定义不参与启动恢复', async () => {
  const registry = createEngineeringRegistry({ ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }), repositories: [] })
  const records = ['5', '6', '7', '8'].map(version => ({ digest: `old-${version}`, definitionVersion: version,
    config: { kind: 'engineering', runId: `run-${version}`, repoId: 'removed-repository' } }))
  const store = { async query({ kind, runId }) {
    if (kind === 'workflow.list') return records
    if (kind === 'run') return { run: { runId, workflowDigest: `old-${runId.slice(-1)}`, status: 'succeeded' }, nodes: [] }
    throw new Error(`unexpected query: ${kind}`)
  } }
  assert.deepEqual(await registry.restore(store), [])
})

test('工程空方案重发保留原任务并冻结新仓库定义', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-engineering-reissue-')), source = join(directory, 'source')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await mkdir(join(source, 'src')); await writeFile(join(source, 'src', 'value.txt'), 'old'); await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'feature/uat1-base')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'reissue', initialize: true }); t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const repositories = ['frontend', 'backend'].map(id => ({ id, sourceRepository: source, managedRoot: join(directory, id),
    remote: source, baseRef: 'main', githubRepository: `example/${id}`,
    editablePaths: [], discovery: { allowedPrefixes: ['src/'] }, purpose: id, routingTerms: [id === 'backend' ? '归一化' : '页面'],
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }))
  const registry = createEngineeringRegistry({ ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }),
    author: { name: 'Test', email: 'test@example.invalid' }, repositories })
  await registry.restore(store, artifacts)
  let workflow
  const controller = { registerWorkflow(value) { workflow = value }, async recover() {} }
  const prepared = await registry.prepareTask({ taskId: 'task', arguments: { repositoryId: 'frontend', uatEnvironment: 'uat1', objective: '修改数据' } },
    { commandId: 'source', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }, controller)
  const definition = defineExecutionWorkflow(workflow), requirement = await artifacts.put(prepared.input)
  const first = await artifacts.put({ workflowDigest: definition.digest, nodeId: workflow.nodes[0].id, nodeVersion: workflow.nodes[0].version,
    requirementRef: requirement.ref, data: prepared.input })
  await store.command({ id: 'create', kind: 'run.create', args: { taskId: 'task', runId: prepared.runId, workflowId: prepared.workflowId,
    workflowDigest: definition.digest, requirementRef: requirement.ref, nodes: workflow.nodes.map((node, index) => ({ nodeId: node.id,
      nodeVersion: node.version, executor: node.executor, inputRef: index ? null : first.ref, inputDigest: index ? null : first.digest })) } })
  const applyIndex = workflow.nodes.findIndex(node => node.id === 'apply-changes')
  for (let index = 0; index <= applyIndex; index++) {
    const node = workflow.nodes[index], claimed = (await store.command({ id: `claim-${index}`, kind: 'node.claim', args: {
      runId: prepared.runId, nodeId: node.id, expectedGeneration: 1, expectedLeaseEpoch: 0 } })).result.binding
    if (node.executor === 'agent') await store.command({ id: `bind-${index}`, kind: 'node.sessionBound', args: {
      runId: prepared.runId, nodeId: node.id, generation: 1, leaseEpoch: 1, sessionId: claimed.sessionId } })
    await store.command({ id: `drain-${index}`, kind: 'node.drained', args: { runId: prepared.runId, nodeId: node.id,
      generation: 1, leaseEpoch: 1, evidenceRef: requirement.ref } })
    await store.command({ id: `commit-${index}`, kind: 'node.commit', args: { runId: prepared.runId, nodeId: node.id,
      generation: 1, leaseEpoch: 1, inputDigest: claimed.inputDigest, outcome: index === applyIndex ? 'waiting' : 'succeeded', evidenceRefs: [],
      ...(index === applyIndex ? { waitReason: { kind: 'recovery', reference: 'ENGINEERING_NO_CHANGES_PROPOSED' } }
        : { outputRef: requirement.ref, nextInput: { nodeId: workflow.nodes[index + 1].id, inputRef: first.ref, inputDigest: first.digest } }) } })
  }
  const result = await registry.reissueTask({ taskId: 'task', repositoryId: 'backend', requestId: 'user-reissue' }, controller, artifacts)
  assert.equal(result.generation, 2)
  const state = await store.query({ kind: 'run', runId: prepared.runId, includeHistory: true })
  assert.equal(state.run.taskId, 'task'); assert.equal(state.run.generation, 2)
  assert.equal(state.nodes[0].status, 'ready')
  assert.equal(state.nodeHistory.some(node => node.nodeId === 'inspect-and-propose' && node.status === 'superseded'), true)
  assert.equal((await artifacts.read(state.run.requirementRef)).baseCommit, await git('rev-parse', 'HEAD'))
  const currentRequirement = await artifacts.read(state.run.requirementRef)
  const frozen = (await store.query({ kind: 'workflow.list' })).find(record => record.digest === state.run.workflowDigest)?.config
  assert.ok(frozen?.taskBase); assert.ok(frozen?.targetCommit)
  const workspace = await createManagedWorkspaces({ root: join(directory, 'backend'), sourceRepository: source, targetCommit: frozen.targetCommit, taskBase: frozen.taskBase })
  await workspace.execute(await workspace.prepare({ runId: prepared.runId, generation: 2,
    requirementDigest: executionDigest(currentRequirement), baseCommit: currentRequirement.baseCommit }))
  const inspection = await registry.repositoryInspect({ taskId: 'task', runId: prepared.runId, generation: 2,
    inputDigest: state.nodes[0].inputDigest, requirementDigest: executionDigest(currentRequirement) }, { operation: 'list', query: 'value' }, undefined,
  currentRequirement)
  assert.deepEqual(inspection.paths, ['src/value.txt'])
  const apply = workflow.nodes.find(node => node.id === 'apply-changes')
  const binding = { runId: prepared.runId, generation: 2, requirementDigest: executionDigest(currentRequirement) }
  const proposal = { changeDisposition: 'modify', reviewedPaths: ['src/value.txt'], reason: '更新要求值', document: { name: '修改方案.md', markdown: '修改 src/value.txt 并验收' }, changes: [], replacements: [{ path: 'src/value.txt',
    expectedHash: createHash('sha256').update('old').digest('hex'), from: 'old', to: 'new' }] }
  const applied = await apply.execute({ input: { requirement: currentRequirement, proposal }, ...binding,
    perform: async effect => effect.prepared.changes })
  assert.deepEqual(applied, [{ path: 'src/value.txt', expectedHash: proposal.replacements[0].expectedHash, content: 'new' }])
  await assert.rejects(apply.execute({ input: { requirement: currentRequirement, proposal: { ...proposal, changes: [],
    replacements: [{ ...proposal.replacements[0], from: 'missing' }] } }, ...binding,
  perform: async () => { throw new Error('must not edit') } }), { code: 'ENGINEERING_PATCH_AMBIGUOUS' })
  await assert.rejects(apply.execute({ input: { requirement: currentRequirement, proposal: { ...proposal, changes: [], replacements: [] } },
    ...binding, perform: async () => {} }), { code: 'ENGINEERING_PROPOSAL_DOCUMENT_INVALID' })
  assert.deepEqual(await registry.reissueTask({ taskId: 'task', repositoryId: 'backend', requestId: 'user-reissue' }, controller, artifacts), result)
})

test('工程registry按Task冻结配置，重启重建同digest，模型变化不改历史，owner/目录/argv不由消息提升', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-engineering-registry-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'old'); await git('add', 'value.txt'); await git('commit', '-m', 'base'); await git('branch', 'feature/uat1-base')
  const options = { dbPath: join(directory, 'control.db'), instanceId: 'registry', initialize: true }
  const store = await openExecutionStore(options); t.after(() => store.close())
  const config = { ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'v1', reasoningEffort: 'low' }), repositories: [{
    id: 'project', sourceRepository: source, managedRoot: root, remote: source, githubRepository: 'test/repo', baseRef: 'main', editablePaths: ['value.txt'],
    purpose: '前端页面', routingTerms: ['页面'],
    checks: [{ id: 'fixed', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }, {
    id: 'project-backend', sourceRepository: source, managedRoot: join(directory, 'backend'), remote: source, githubRepository: 'test/backend', baseRef: 'main', editablePaths: ['value.txt'],
    purpose: '后端归一化计算', routingTerms: ['归一化'],
    checks: [{ id: 'fixed', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }] }
  const registry = createEngineeringRegistry(config), admitted = []
  await registry.restore(store)
  assert.equal(registry.availableWorkflows().find(item => item.repositoryId === 'project-backend').purpose, '后端归一化计算')
  await assert.rejects(registry.prepareTask({ taskId: 'wrong', arguments: { repositoryId: 'project', uatEnvironment: 'uat1', objective: '修复归一化计算' } },
    { commandId: 'wrong', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }, { registerWorkflow() {} }), { code: 'ENGINEERING_REPOSITORY_SCOPE_MISMATCH' })
  const controller = { registerWorkflow: workflow => admitted.push(defineExecutionWorkflow(workflow).digest) }
  const action = { taskId: 'task', constraints: ['I节点新增限制'], arguments: { repositoryId: 'project', uatEnvironment: 'uat1', objective: '修改value', sourceRepository: 'C:/ignored', checks: ['malicious'] } }
  const info = { commandId: 'command', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }
  for (const uatEnvironment of [null, 'uat0', 'uat10', 'main']) await assert.rejects(registry.prepareTask({ ...action, arguments: { ...action.arguments, uatEnvironment } }, info, controller), /ENGINEERING_UAT_ENVIRONMENT_REQUIRED/)
  await assert.rejects(registry.prepareTask({ ...action, arguments: { ...action.arguments, uatEnvironment: 'uat9' } }, info, controller), /ENGINEERING_UAT_BRANCH_NOT_FOUND/)
  const prepared = await registry.prepareTask(action, info, controller)
  assert.deepEqual(prepared.input.editablePaths, ['value.txt'])
  assert.deepEqual(prepared.input.constraints, ['I节点新增限制'])
  assert.deepEqual(await registry.prepareTask(action, info, controller), prepared)
  assert.equal(admitted[0], admitted[1])
  const [record] = await store.query({ kind: 'workflow.list' })
  assert.equal(record.config.provider, 'test'); assert.equal(record.config.model, 'v1')
  assert.equal(record.config.reasoningEffort, 'low')
  assert.equal(record.config.uatEnvironment, 'uat1'); assert.equal(record.config.uatBranch, 'feature/uat1-base')
  assert.equal(record.config.input.baseCommit, await git('rev-parse', 'HEAD'))
  assert.equal(record.config.head, `codex/task-${executionDigest(info.commandId).slice(0, 24)}`)
  await store.close()
  const reopened = await openExecutionStore({ ...options, initialize: false }); t.after(() => reopened.close())
  const second = createEngineeringRegistry({ ...config, modelConfig: () => ({ provider: 'other', model: 'v2' }) })
  assert.equal(defineExecutionWorkflow((await second.restore(reopened))[0]).digest, record.digest)
  assert.deepEqual(await second.prepareTask(action, info, controller), prepared)
  await assert.rejects(second.prepareTask(action, { ...info, run: { actorId: 'outsider' } }, controller), { code: 'WORKFLOW_ACTION_FORBIDDEN' })
  await assert.rejects(second.prepareTask({ ...action, arguments: { ...action.arguments, repositoryId: 'unlisted' } }, info, controller), { code: 'ENGINEERING_REPOSITORY_NOT_ADMITTED' })
  const effect = { runId: prepared.runId, generation: 1, directory: join(root, `ws-${executionDigest({ runId: prepared.runId, generation: 1 })}`, 'repository') }
  assert.equal((await second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'task' }, prepared: effect })).principalId, 'owner')
  await assert.rejects(second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'other-task' }, prepared: effect }), { code: 'ENGINEERING_EFFECT_NOT_AUTHORIZED' })
  await assert.rejects(second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'task' }, prepared: { ...effect, directory: source } }), { code: 'ENGINEERING_DELIVERY_SCOPE_INVALID' })
  const changed = createEngineeringRegistry({ ...config, repositories: [{ ...config.repositories[0], editablePaths: ['another.txt'] }] })
  await assert.rejects(changed.restore(reopened), { code: 'ENGINEERING_DEFINITION_CONFIG_DRIFT' })
})

test('工程交付后补充：固定分支祖先条件续写、PR原位修订且新代读取旧代结果', { timeout: 240000 }, async t => {
  const { readFile } = await import('node:fs/promises')
  const { openExecutionArtifacts } = await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
  const { createExecutionController } = await import('../packages/dingtalk-dsh-assistant/execution-controller.js')
  const { createExecutionDelivery } = await import('../packages/dingtalk-dsh-assistant/execution-delivery.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-revision-')), source = join(directory,'source'), root=join(directory,'managed'), remote=join(directory,'remote.git'), script=join(directory,'gh.cjs'), stateFile=join(directory,'pr.json')
  await mkdir(source); await mkdir(root)
  const exec=promisify(execFile), git=async (repo,...args)=>(await exec('git',['-C',repo,...args],{windowsHide:true})).stdout.trim()
  await git(source,'init','-b','main');await git(source,'config','user.name','Test');await git(source,'config','user.email','test@example.invalid')
  await writeFile(join(source,'value.txt'),'old');await git(source,'add','.');await git(source,'commit','-m','base');await exec('git',['init','--bare',remote]);await git(source,'push',remote,'HEAD:refs/heads/feature/uat1-base')
  const head=`codex/task-${executionDigest('revision-command').slice(0,24)}`
  await writeFile(script,`const fs=require('node:fs'),cp=require('node:child_process');const [file,remote,head,...args]=process.argv.slice(2);let s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;const sha=()=>cp.execFileSync('git',['ls-remote',remote,'refs/heads/'+head],{encoding:'utf8'}).trim().split(/\\s+/)[0];const value=x=>args[args.indexOf(x)+1];if(s)s.headRefOid=sha();if(args[0]==='api')console.log(JSON.stringify({object:{sha:sha()}}));else if(args[1]==='list')console.log(JSON.stringify(s?[s]:[]));else if(args[1]==='view')console.log(JSON.stringify(s));else if(['create','edit'].includes(args[1])){s={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:sha(),headRefName:head,baseRefName:'feature/uat1-base',body:fs.readFileSync(value('--body-file'),'utf8'),title:value('--title'),creates:(s?.creates??0)+(args[1]==='create'?1:0),edits:(s?.edits??0)+(args[1]==='edit'?1:0)};fs.writeFileSync(file,JSON.stringify(s));process.exit(1)}else process.exit(2)`)
  const store=await openExecutionStore({dbPath:join(directory,'control.db'),instanceId:'revision',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true});t.after(()=>store.close())
  const profile = join(directory, 'uat-profile.json')
  await writeFile(profile, JSON.stringify({ environment: 'uat', env: { TEST_ACCEPTANCE_PROFILE: 'isolated-test-profile' } }))
  const readInput = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const input=JSON.parse(s);"
  const command = code => ({ executable: process.execPath, args: ['-e', code] })
  const localAcceptance = { version: '1', sharedDataProfilePath: profile, timeoutMs: 90000, prepareSteps: [],
    service: { ...command("require('node:http').createServer((req,res)=>res.end(require('node:fs').readFileSync('value.txt','utf8'))).listen(Number(process.argv[1]),process.argv[2])"), args: ['-e', "require('node:http').createServer((req,res)=>res.end(require('node:fs').readFileSync('value.txt','utf8'))).listen(Number(process.argv[1]),process.argv[2])", '{port}', '127.0.0.1'], readyPath: '/' },
    scenarios: [{ id: 'value', description: '读取候选服务业务值', ...command(readInput + "const actual=await(await fetch(input.baseUrl)).text();console.log(JSON.stringify({namespace:input.namespace,baseUrl:input.baseUrl,actual}));});") }],
    cleanup: command(readInput + "console.log(JSON.stringify({namespace:input.namespace}));});"),
    verifyCleanup: command(readInput + "console.log(JSON.stringify({namespace:input.namespace,empty:true}));});") }
  const registry=createEngineeringRegistry({ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,stateFile,remote,head]},repositories:[{id:'repo',sourceRepository:source,managedRoot:root,remote,githubRepository:'test/repo',baseRef:'main',editablePaths:['value.txt'],localAcceptance,acceptanceChecks:[{id:'value-acceptance',version:'1',criterion:'修改后的值符合约定',expected:'true',executable:process.execPath,args:['-e',"console.log(JSON.stringify({actual:String(['one','two'].includes(require('node:fs').readFileSync('value.txt','utf8')))}))"]}],checks:[{id:'check',version:'1',executable:process.execPath,args:['-e',"if(!['one','two'].includes(require('node:fs').readFileSync('value.txt','utf8')))process.exit(1)"]}]}]})
  await registry.restore(store)
  const reached=Promise.withResolvers(),release=Promise.withResolvers();let firstCommit
  const sessions={async run({input,onSessionBound,onResult}){await onSessionBound();if(input.criteria){onResult({cases:input.criteria.map(item=>({criterionId:item.id,scenarioId:'value',steps:['读取候选服务 value'],expected:input.request==='first'?'one':'two',parameters:{}}))});return}assert.equal(input.files[0].text,input.request==='first'?'old':'one');onResult({changeDisposition:'modify',reviewedPaths:['value.txt'],reason:'按本轮要求更新',document:{name:'修改方案.md',markdown:'# 修改方案\n将 value.txt 更新为本轮需要的值，使用配置检查核对文件内容。'},changes:[{path:'value.txt',expectedHash:input.files[0].expectedHash,content:input.request==='first'?'one':'two'}]})},async cancel(){},async close(){}}
  const controller=createExecutionController({store,artifacts,sessions,delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:[],changeQuietMs:0,maxChangeDelayMs:0});t.after(()=>controller.close())
  const prepared=await registry.prepareTask({taskId:'task',arguments:{repositoryId:'repo',uatEnvironment:'uat1',objective:'first',acceptanceCriteria:['候选服务返回本轮修改值']}},{commandId:'revision-command',run:{actorId:'owner'},unit:{}},{registerWorkflow(workflow){const node=workflow.nodes.at(-1),original=node.execute;node.execute=async args=>{const result=await original(args);if(args.generation===1){firstCommit=result.commitId;reached.resolve();await release.promise}return result};controller.registerWorkflow(workflow)}})
  await controller.createRun({commandId:'create',...prepared})
  await Promise.race([reached.promise, controller.whenIdle(prepared.runId).then(state => { if(state.run.status !== 'running') throw new Error(JSON.stringify(state)) })])
  await controller.changeInput({commandId:'revise',runId:prepared.runId,inputId:'revision',sourceKey:'revision',input:{...prepared.input,request:'second'}});release.resolve()
  const state=await controller.whenIdle(prepared.runId)
  assert.equal(state.run.status,'succeeded',JSON.stringify(await controller.state(prepared.runId)));assert.equal(state.run.generation,2)
  const directoryOutput = await artifacts.read(state.nodes.find(node => node.nodeId === 'prepare-workspace').outputRef)
  assert.equal(directoryOutput.workspace.kind, 'independent-git-repository')
  assert.ok(directoryOutput.workspace.directory.startsWith(root))
  const localOutput = await artifacts.read(state.nodes.find(node => node.nodeId === 'finalize-local-acceptance').outputRef)
  assert.equal(localOutput.localAcceptance.passed, true)
  assert.equal(localOutput.localAcceptance.candidateDigest, localOutput.candidate.digest)
  assert.deepEqual(localOutput.localAcceptance.cleanup, { dataCleaned: true, processStopped: true })
  assert.equal(localOutput.localPrepared.resourceKey, 'external:local-acceptance:shared-uat')
  assert.equal(localOutput.localAcceptance.checks[0].actual, 'two')
  const planOutput = await artifacts.read(state.nodes.find(node => node.nodeId === 'propose-changes').outputRef)
  assert.match(planOutput.document.markdown, /value.txt/)
  assert.equal(state.nodes.find(node => node.nodeId === 'validate-proposal').status, 'succeeded')
  const startOutput = await artifacts.read(state.nodes.find(node => node.nodeId === 'prepare-generation').outputRef)
  assert.equal(startOutput.startingPoint.mode, 'continue')
  assert.equal(startOutput.startingPoint.repository, 'test/repo')
  const result=await artifacts.read(state.nodes.at(-1).outputRef),pr=JSON.parse(await readFile(stateFile,'utf8'))
  assert.notEqual(result.commitId,firstCommit);assert.equal(await git(remote,'rev-parse',result.commitId+'^'),firstCommit)
  assert.equal(await git(remote,'show',result.commitId+':value.txt'),'two');assert.equal(pr.creates,1);assert.equal(pr.edits,1);assert.equal(pr.title,'second');assert.match(pr.body,/second/)
  assert.equal(await readFile(join(source,'value.txt'),'utf8'),'old')
})


test('九个 UAT 环境精确映射固定分支，缺失和其他名称不能猜测', () => {
  for (let n=1;n<=9;n++) { assert.equal(uatBranchFor(`uat${n}`), `feature/uat${n}-base`); assert.equal(isUatBranch(`feature/uat${n}-base`), true) }
  for (const value of [undefined, '', 'uat', 'uat0', 'uat10', 'main', 'feature/uat1-base']) assert.equal(uatBranchFor(value), null)
  for (const value of ['main', 'master', 'uat1', 'feature/uat10-base', 'feature/uat1-base/other']) assert.equal(isUatBranch(value), false)
})

test('v11 缺本地验收配置时真实 controller 阻塞且不准备工作区', async t => {
  const { createEngineeringLocalAcceptanceWorkflow } = await import('../packages/dingtalk-dsh-assistant/task-workflow.js')
  const { createExecutionController } = await import('../packages/dingtalk-dsh-assistant/execution-controller.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-gate-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'gate', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  t.after(() => store.close())
  let prepared = 0
  const workflow = createEngineeringLocalAcceptanceWorkflow({ provider: 'test', model: 'test', adapterIdentity: 'gate',
    workspaceAdapter: { async prepare() { prepared++; throw new Error('must not prepare') } }, editAdapter: {},
    checks: [{ id: 'check', version: '1', run: async () => ({ passed: true }) }], project: { uatEnvironment: 'uat1' } })
  const controller = createExecutionController({ store, artifacts, workflows: [workflow], delivery: {} })
  t.after(() => controller.close())
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id,
    input: { request: '业务验收', constraints: [], baseCommit: 'a'.repeat(40), editablePaths: ['value.txt'], acceptanceCriteria: ['值正确'] } })
  const state = await controller.whenIdle('run')
  assert.equal(state.nodes.find(node => node.nodeId === 'define-local-acceptance').status, 'waiting')
  assert.match(JSON.stringify(state), /LOCAL_ACCEPTANCE_CONFIG_REQUIRED/)
  assert.equal(prepared, 0)
  assert.equal(state.nodes.find(node => node.nodeId === 'prepare-workspace').status, 'blocked')
})

test('v11 输入映射、候选绑定和失败验收不能进入提交；v10 工厂摘要保持稳定', async () => {
  const { createEngineeringLocalAcceptanceWorkflow, createEngineeringAcceptanceWorkflow } = await import('../packages/dingtalk-dsh-assistant/task-workflow.js')
  let commitCalls = 0
  const options = { provider: 'test', model: 'test', adapterIdentity: 'contract', workspaceAdapter: {}, editAdapter: {},
    checks: [{ id: 'check', version: '1', run: async () => ({ passed: true }) }], project: { uatEnvironment: 'uat1' },
    deliveryPlan: { identity: 'delivery', expectedRemoteSha: null, date: '1700000000 +0000', commitMessage: 'change', title: 'change', body: 'change',
      gitAdapterFor: async () => ({ async prepareCommit() { commitCalls++ } }), prAdapterFor: async () => ({}) },
    localAcceptance: { identity: 'local', instructions: '必须关闭后台消费任务', scenarios: [{ id: 'value', description: '业务值' }],
      async assertPassed(prepared, receipt) { if (!receipt.passed) throw Object.assign(new Error('mismatch'), { code: 'LOCAL_ACCEPTANCE_EXPECTATION_MISMATCH' }) } } }
  const oldDigest = defineExecutionWorkflow(createEngineeringAcceptanceWorkflow(options)).digest
  const workflow = createEngineeringLocalAcceptanceWorkflow(options)
  assert.ok(workflow.nodes.some(node => node.prompt?.includes('必须关闭后台消费任务')))
  const requirement = { request: '修改值', constraints: [], baseCommit: 'a'.repeat(40), editablePaths: ['value.txt'], acceptanceCriteria: ['业务值正确'] }
  const mapped = workflow.nodes.find(node => node.id === 'prepare-workspace').mapInput({ requirement, previousOutput: { cases: [] }, dependencyOutputs: {} })
  assert.deepEqual(mapped, { request: '修改值', constraints: [], baseCommit: 'a'.repeat(40), editablePaths: ['value.txt'] })
  const prepare = workflow.nodes.find(node => node.id === 'prepare-commit')
  await assert.rejects(prepare.execute({ input: { candidate: { digest: 'new' }, localPrepared: { candidateDigest: 'old' }, localAcceptance: { passed: true } } }), { code: 'LOCAL_ACCEPTANCE_RECEIPT_INVALID' })
  await assert.rejects(prepare.execute({ input: { candidate: { digest: 'same' }, localPrepared: { candidateDigest: 'same' }, localAcceptance: { passed: false } } }), { code: 'LOCAL_ACCEPTANCE_EXPECTATION_MISMATCH' })
  assert.equal(commitCalls, 0)
  assert.equal(defineExecutionWorkflow(createEngineeringAcceptanceWorkflow({ ...options, localAcceptance: { ...options.localAcceptance, identity: 'different-profile' } })).digest, oldDigest)
})

test('本地验收经 delivery 对共享 UAT 加锁，另一个 Run 在首个排空前零发送', async t => {
  const { createExecutionDelivery } = await import('../packages/dingtalk-dsh-assistant/execution-delivery.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-lock-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'lock', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  t.after(() => store.close())
  const requests = []
  for (const runId of ['first', 'second']) {
    await store.command({ id: `create-${runId}`, kind: 'run.create', args: { runId, taskId: runId, workflowId: 'local', workflowDigest: 'a'.repeat(64), requirementRef: 'requirement',
      nodes: [{ nodeId: 'run-local-acceptance', nodeVersion: '1', executor: 'code', inputRef: 'input', inputDigest: 'b'.repeat(64) }] } })
    const { result: { binding } } = await store.command({ id: `claim-${runId}`, kind: 'node.claim', args: { runId, nodeId: 'run-local-acceptance', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
    requests.push({ binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared: { action: 'external', workflowKind: 'local-acceptance', runId, generation: 1,
      requirementDigest: 'c'.repeat(64), resourceKey: 'external:local-acceptance:shared-uat', profileIdentity: runId } })
  }
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  let sends = 0
  const gateway = createExecutionDelivery({ store, artifacts, authorize: async () => ({ principalId: 'owner', authorizationRef: 'trusted-local' }), authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'trusted-local' }),
    externalAdapter: { async execute() { sends++; started.resolve(); await release.promise; return { status: 'succeeded' } }, async reconcile() { return { status: 'succeeded' } } } })
  const first = gateway.execute(requests[0])
  try {
    await started.promise
    await assert.rejects(gateway.execute(requests[1]), error => /resource.*busy|resource.*locked/i.test(error.code))
    assert.equal(sends, 1)
  } finally { release.resolve(); await first }
})


test('远端引用只读重试：超时后成功，命令身份与15秒边界保持', async () => {
  const calls = [], waits = [], args = ['ls-remote', '--refs', '--', 'https://github.com/example/repo.git', 'refs/heads/feature/uat2-base']
  const value = await readEngineeringRemoteRefs('D:/fixture', args, {
    execImpl: async (file, received, options) => { calls.push({ file, received, options });
      if (calls.length < 3) throw Object.assign(Error('private remote'), { code: null, killed: true, signal: 'SIGTERM' })
      return { stdout: `${'a'.repeat(40)}\trefs/heads/feature/uat2-base\n` } }, delay: async ms => waits.push(ms),
  })
  assert.equal(value, `${'a'.repeat(40)}\trefs/heads/feature/uat2-base`)
  assert.equal(calls.length, 3); assert.deepEqual(waits, [250, 500])
  for (const call of calls) { assert.equal(call.file, 'git'); assert.deepEqual(call.received, ['-C', 'D:/fixture', ...args]); assert.equal(call.options.timeout, 15000) }
})

for (const failure of [
  { code: null, killed: true, signal: 'SIGTERM' }, { code: 'ECONNRESET' }, { code: 'EAI_AGAIN' },
  { code: 128, stderr: 'fatal: TLS handshake timeout secret-token' },
  { code: 128, stderr: 'fatal: The requested URL returned error: 503 secret-token' },
]) test(`远端引用只读重试耗尽明确暂态 ${JSON.stringify(failure)}`, async () => {
  let calls = 0
  await assert.rejects(readEngineeringRemoteRefs('fixture', ['ls-remote', '--refs', '--', 'remote', 'refs/heads/a'], {
    execImpl: async () => { calls++; throw Object.assign(Error('secret-token'), failure) }, delay: async () => {},
  }), error => error.code === 'ENGINEERING_REMOTE_READ_TRANSIENT' && !error.message.includes('secret-token'))
  assert.equal(calls, 3)
})

for (const failure of [
  { code: 128, stderr: 'Authentication failed secret-token' },
  { code: 128, stderr: 'Permission denied (publickey).' },
  { code: 128, stderr: 'repository not found' },
  { code: 128, stderr: 'The requested URL returned error: 403' },
  { code: 128, stderr: 'SSL certificate problem: unable to get local issuer certificate' },
  { code: 'ENOENT' }, { code: 128, stderr: 'unknown failure' },
  { code: 'ETIMEDOUT', stderr: 'Authentication failed' },
]) test(`远端引用确定性失败不重试 ${JSON.stringify(failure)}`, async () => {
  let calls = 0
  await assert.rejects(readEngineeringRemoteRefs('fixture', ['ls-remote', '--refs', '--', 'remote', 'refs/heads/a'], {
    execImpl: async () => { calls++; throw Object.assign(Error('secret-token'), failure) }, delay: async () => assert.fail('must not retry'),
  }), error => error.code === 'ENGINEERING_REMOTE_READ_FAILED' && !error.message.includes('secret-token'))
  assert.equal(calls, 1)
})

test('远端引用分支不存在不重试，写命令不进入读取器', async () => {
  let calls = 0
  await assert.rejects(readEngineeringRemoteRefs('fixture', ['ls-remote', '--exit-code', 'remote', 'refs/heads/a'], {
    execImpl: async () => { calls++; throw Object.assign(Error('missing'), { code: 2 }) }, delay: async () => assert.fail('must not retry'),
  }), /ENGINEERING_UAT_BRANCH_NOT_FOUND/)
  assert.equal(calls, 1)
  for (const action of ['push', 'fetch', 'commit']) await assert.rejects(readEngineeringRemoteRefs('fixture', [action], {
    execImpl: async () => assert.fail('write must not execute'),
  }), /ENGINEERING_REMOTE_READ_ARGUMENT_INVALID/)
})
