import test from 'node:test'
import { readTaskOwnerStageArtifacts, assert, execFile, promisify, createHash, mkdir, mkdtemp, writeFile, readdir, readFile, join, tmpdir, assertEngineeringStageRepository, selectTaskLocalAcceptance, createEngineeringStageContract, createEngineeringRegistry, readEngineeringDeliveryProof, readEngineeringRemoteRefs, uatBranchFor, isUatBranch, engineeringWorkflowOwnerContract, createEngineeringCompletionPolicy, createTaskWorkflowContracts, openExecutionStore, defineExecutionWorkflow, executionDigest, openExecutionArtifacts, createManagedWorkspaces, registryLocalFixture } from './fixtures/workflow-engineering-mixed.js'

test('重执行复用受信开发分支最新提交并冻结远端，保留源检出与历史定义', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-branch-reuse-')), source = join(directory, 'source'), remote = join(directory, 'remote.git')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base')
  await git('init', '--bare', remote); await git('push', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/feature/uat2-base')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'branches', initialize: true }); t.after(() => store.close())
  const taskFiles = { work: join(directory, 'tasks', 'original', 'work'), tmp: join(directory, 'tasks', 'original', 'tmp') }
  const options = { getTaskDirectories: async taskId => taskId === 'new-task' ? taskFiles : null, ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }), author: { name: 'Test', email: 'test@example.invalid' },
    repositories: [{ id: 'repo', sourceRepository: source, managedRoot: join(directory, 'managed'), remote, baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'],
      localAcceptance:{version:'branch-fixture',sharedDataProfilePath:join(directory,'profile.json'),prepareSteps:[],service:{executable:process.execPath,args:['-e','process.exit(0)','127.0.0.1','{port}'],readyPath:'/'},scenarios:[{id:'value',description:'branch fixture only',executable:process.execPath,args:['-e','process.exit(0)']}],cleanup:{executable:process.execPath,args:['-e','process.exit(0)']},verifyCleanup:{executable:process.execPath,args:['-e','process.exit(0)']}},
      checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] }
  const registry = createEngineeringRegistry(options); await registry.restore(store)
  let workflow
  const controller = { registerWorkflow(value) { workflow = value } }
  const prepare = (taskId, commandId, rerunOfTaskId) => registry.prepareTask({ taskId, arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修改代码' } },
    { commandId, ...(rerunOfTaskId ? { rerunOfTaskId } : {}), run: { actorId: 'owner' }, unit: {} }, controller)
  const { symlink, readdir } = await import('node:fs/promises')
  const outside = join(directory, 'outside'), linkedWork = join(directory, 'linked-work')
  await mkdir(outside); await symlink(outside, linkedWork, process.platform === 'win32' ? 'junction' : 'dir')
  const unsafeRegistry = createEngineeringRegistry({ ...options, getTaskDirectories: async () => ({ ...taskFiles, work: join(linkedWork, 'must-not-exist') }) })
  await unsafeRegistry.restore(store)
  await assert.rejects(unsafeRegistry.prepareTask({ taskId: 'unsafe-task', arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修改代码' } },
    { commandId: 'unsafe-command', run: { actorId: 'owner' }, unit: {} }, controller), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  assert.deepEqual(await readdir(outside), [])
  const original = await prepare('original', 'first')
  const oldRecord = (await store.query({ kind: 'workflow.list' }))[0], head = oldRecord.config.head
  assert.equal(oldRecord.definitionVersion, '26')
  assert.equal(workflow.nodes.some(node => node.id === 'validate-proposal'), false)
  assert.equal(workflow.nodes.find(node => node.id === 'apply-changes').executor, 'agent')
  await git('push', remote, `HEAD:refs/heads/${head}`)
  await writeFile(join(source, 'value.txt'), 'latest'); await git('commit', '-am', 'latest'); await git('push', remote, `HEAD:refs/heads/${head}`)
  const latest = await git('rev-parse', 'HEAD'), sourceBranch = await git('symbolic-ref', 'HEAD')
  const rerun = await prepare('new-task', 'second', 'original')
  const record = (await store.query({ kind: 'workflow.list' })).find(item => item.config.taskId === 'new-task')
  assert.notEqual(rerun.runId, original.runId); assert.equal(record.config.head, head); await git('merge-base', '--is-ancestor', rerun.input.baseCommit, latest)
  assert.deepEqual(record.config.branchSource, { taskId: 'original', expectedRemoteSha: latest })
  assert.equal(record.config.taskBase, latest)
  assert.equal(record.config.targetCommit, oldRecord.config.targetCommit)
  assert.equal(await git('symbolic-ref', 'HEAD'), sourceBranch)
  const start = workflow.nodes.find(node => node.id === 'prepare-generation')
  const output = await start.execute({ input: rerun.input, runId: rerun.runId, generation: 1 })
  assert.equal(output.requirement.expectedRemoteSha, latest)
  const workspaceNode = workflow.nodes.find(node => node.id === 'prepare-workspace')
  const workspaceContext = { input: output.requirement, runId: rerun.runId, generation: 1, requirementDigest: 'a'.repeat(64),
    perform: effect => registry.deliveryOptions.workspaceAdapter.execute(effect.prepared) }
  const workspaceOutput = await workspaceNode.execute(workspaceContext)
  assert.ok(workspaceOutput.workspace.directory.startsWith(taskFiles.work))
  assert.deepEqual(record.config.taskFiles, taskFiles)
  assert.equal(oldRecord.config.taskFiles, undefined)
  assert.equal((await exec('git', ['-C', workspaceOutput.workspace.directory, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(), latest)
  assert.equal(workspaceOutput.workspace.branchDisposition, 'reused')
  assert.equal((await git('ls-remote', remote, 'refs/heads/feature/uat2-base')).split(/\s+/)[0], record.config.targetCommit)
  assert.equal((await exec('git', ['-C', workspaceOutput.workspace.directory, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true })).stdout.trim(), 'HEAD')
  assert.deepEqual((await store.query({ kind: 'workflow.list' })).find(item => item.workflowId === oldRecord.workflowId), oldRecord)
  const withRegistration={...options,repositories:options.repositories.map(repo=>({...repo,taskLocalAcceptance:[{scope:{taskId:'original',uatEnvironment:'uat2',requestDigest:executionDigest({request:oldRecord.config.input.request,acceptanceCriteria:oldRecord.config.input.acceptanceCriteria})},localAcceptance:repo.localAcceptance}]}))};
  const restored = createEngineeringRegistry(withRegistration); const restoredWorkflows = await restored.restore(store)
  assert.equal(restoredWorkflows.length, 2)
  for (const restoredWorkflow of restoredWorkflows) {
    assert.equal(restoredWorkflow.version, '26')
    assert.equal(restoredWorkflow.nodes.some(node => node.id === 'validate-proposal'), false)
    assert.equal(defineExecutionWorkflow(restoredWorkflow).digest, (await store.query({ kind: 'workflow.list' })).find(record => record.workflowId === restoredWorkflow.id).digest)
  }
  // Restart after Run success must retain the exact definition until native Owner completion.
  let owner = { status: 'blocked', decision: { action: 'wait' }, applicationStatus: 'applied' }
  const pendingStore = { command: value => { throw new Error('RESTORE_MUST_NOT_WRITE') }, query: value => {
    if (value.kind === 'workflow.list') return [oldRecord]
    if (value.kind === 'run') return { run: { runId: oldRecord.config.runId, taskId: 'original', status: 'succeeded', workflowDigest: oldRecord.digest }, nodes: [] }
    if (value.kind === 'task.owner') return owner
    return store.query(value)
  } }
  const pendingRegistry = createEngineeringRegistry(withRegistration)
  const pending = await pendingRegistry.restore(pendingStore)
  assert.equal(pending.length, 1)
  assert.equal(defineExecutionWorkflow(pending[0]).digest, oldRecord.digest)
  assert.ok(pending[0].ownerContract)
  owner = { status: 'idle', decision: { action: 'complete' }, applicationStatus: 'applied' }
  assert.equal((await createEngineeringRegistry(withRegistration).restore(pendingStore)).length, 1)
  owner = null
  assert.equal((await createEngineeringRegistry(withRegistration).restore(pendingStore)).length, 1)
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
    await assert.rejects(migrated.restore({ command: value => store.command(value), query: value => {
      if (value.kind === 'workflow.list') return [legacy]
      if (value.kind === 'run') return { run: { status: 'succeeded', workflowDigest: legacy.digest } }
      if (value.kind === 'effect.list') return [{ state: evidence.state, definition: { action: 'push', payload: { remote: evidence.remote, ref: evidence.ref } } },
        ...(index === 3 ? [{ state: 'succeeded', generation: 1, definition: { action: 'pr', payload: { repo: 'example/repo', head, base: 'main', operationKey: 'f'.repeat(64) } }, result: { result: { status: 'succeeded', number: 371 } } }] : [])]
      return store.query(value)
    } }), { code: 'ENGINEERING_DEFINITION_CONFIG_DRIFT' })

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

test('v11 输入映射、候选绑定和失败验收不能进入提交；v10 工厂摘要保持稳定', async () => {
  const { createEngineeringLocalAcceptanceWorkflow, createEngineeringAcceptanceWorkflow } = await import('../packages/dingtalk-dsh-assistant/task-workflow.js')
  let commitCalls = 0
  const options = { provider: 'test', model: 'test', adapterIdentity: 'contract', workspaceAdapter: {}, editAdapter: {},
    checks: [{ id: 'check', version: '1', run: async () => ({ passed: true }) }], project: { uatEnvironment: 'uat1' },
    deliveryPlan: { identity: 'delivery', expectedRemoteSha: null, date: '1700000000 +0000', commitMessage: 'change', title: 'change', body: 'change',
      gitAdapterFor: async () => ({ async prepareCommit() { commitCalls++ } }), prAdapterFor: async () => ({}) },
    localAcceptance: { identity: 'local', instructions: '必须关闭后台消费任务', scenarios: [{ id: 'value', expected: 'one', description: '业务值' }],
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
