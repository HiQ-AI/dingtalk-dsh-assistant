import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEngineeringRegistry, readEngineeringDeliveryProof } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'

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
  await mkdir(join(source, 'src')); await writeFile(join(source, 'src', 'value.txt'), 'old'); await git('add', '.'); await git('commit', '-m', 'base')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'reissue', initialize: true }); t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const repositories = ['frontend', 'backend'].map(id => ({ id, sourceRepository: source, managedRoot: join(directory, id),
    remote: `https://github.com/example/${id}.git`, baseRef: 'main', githubRepository: `example/${id}`,
    editablePaths: [], discovery: { allowedPrefixes: ['src/'] }, purpose: id, routingTerms: [id === 'backend' ? '归一化' : '页面'],
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }))
  const registry = createEngineeringRegistry({ ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }),
    author: { name: 'Test', email: 'test@example.invalid' }, repositories })
  await registry.restore(store, artifacts)
  let workflow
  const controller = { registerWorkflow(value) { workflow = value }, async recover() {} }
  const prepared = await registry.prepareTask({ taskId: 'task', arguments: { repositoryId: 'frontend', objective: '修改数据' } },
    { commandId: 'source', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }, controller)
  const definition = defineExecutionWorkflow(workflow), requirement = await artifacts.put(prepared.input)
  const first = await artifacts.put({ workflowDigest: definition.digest, nodeId: workflow.nodes[0].id, nodeVersion: workflow.nodes[0].version,
    requirementRef: requirement.ref, data: prepared.input })
  await store.command({ id: 'create', kind: 'run.create', args: { taskId: 'task', runId: prepared.runId, workflowId: prepared.workflowId,
    workflowDigest: definition.digest, requirementRef: requirement.ref, nodes: workflow.nodes.map((node, index) => ({ nodeId: node.id,
      nodeVersion: node.version, executor: node.executor, inputRef: index ? null : first.ref, inputDigest: index ? null : first.digest })) } })
  for (let index = 0; index < 4; index++) {
    const node = workflow.nodes[index], claimed = (await store.command({ id: `claim-${index}`, kind: 'node.claim', args: {
      runId: prepared.runId, nodeId: node.id, expectedGeneration: 1, expectedLeaseEpoch: 0 } })).result.binding
    if (node.executor === 'agent') await store.command({ id: 'bind', kind: 'node.sessionBound', args: {
      runId: prepared.runId, nodeId: node.id, generation: 1, leaseEpoch: 1, sessionId: claimed.sessionId } })
    await store.command({ id: `drain-${index}`, kind: 'node.drained', args: { runId: prepared.runId, nodeId: node.id,
      generation: 1, leaseEpoch: 1, evidenceRef: requirement.ref } })
    await store.command({ id: `commit-${index}`, kind: 'node.commit', args: { runId: prepared.runId, nodeId: node.id,
      generation: 1, leaseEpoch: 1, inputDigest: claimed.inputDigest, outcome: index === 3 ? 'waiting' : 'succeeded', evidenceRefs: [],
      ...(index === 3 ? { waitReason: { kind: 'recovery', reference: 'ENGINEERING_NO_CHANGES_PROPOSED' } }
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
  const workspace = await createManagedWorkspaces({ root: join(directory, 'backend'), sourceRepository: source })
  await workspace.execute(await workspace.prepare({ runId: prepared.runId, generation: 2,
    requirementDigest: executionDigest(currentRequirement), baseCommit: currentRequirement.baseCommit }))
  const inspection = await registry.repositoryInspect({ taskId: 'task', runId: prepared.runId, generation: 2,
    inputDigest: state.nodes[0].inputDigest, requirementDigest: executionDigest(currentRequirement) }, { operation: 'list', query: 'value' }, undefined,
  currentRequirement)
  assert.deepEqual(inspection.paths, ['src/value.txt'])
  const apply = workflow.nodes.find(node => node.id === 'apply-changes')
  const binding = { runId: prepared.runId, generation: 2, requirementDigest: executionDigest(currentRequirement) }
  const proposal = { changes: [], replacements: [{ path: 'src/value.txt',
    expectedHash: createHash('sha256').update('old').digest('hex'), from: 'old', to: 'new' }] }
  const applied = await apply.execute({ input: { requirement: currentRequirement, proposal }, ...binding,
    perform: async effect => effect.prepared.changes })
  assert.deepEqual(applied, [{ path: 'src/value.txt', expectedHash: proposal.replacements[0].expectedHash, content: 'new' }])
  await assert.rejects(apply.execute({ input: { requirement: currentRequirement, proposal: { changes: [],
    replacements: [{ ...proposal.replacements[0], from: 'missing' }] } }, ...binding,
  perform: async () => { throw new Error('must not edit') } }), { code: 'ENGINEERING_PATCH_AMBIGUOUS' })
  await assert.rejects(apply.execute({ input: { requirement: currentRequirement, proposal: { changes: [], replacements: [] } },
    ...binding, perform: async () => {} }), { code: 'ENGINEERING_NO_CHANGES_PROPOSED' })
  assert.deepEqual(await registry.reissueTask({ taskId: 'task', repositoryId: 'backend', requestId: 'user-reissue' }, controller, artifacts), result)
})

test('工程registry按Task冻结配置，重启重建同digest，模型变化不改历史，owner/目录/argv不由消息提升', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-engineering-registry-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'old'); await git('add', 'value.txt'); await git('commit', '-m', 'base')
  const options = { dbPath: join(directory, 'control.db'), instanceId: 'registry', initialize: true }
  const store = await openExecutionStore(options); t.after(() => store.close())
  const config = { ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'v1', reasoningEffort: 'low' }), repositories: [{
    id: 'project', sourceRepository: source, managedRoot: root, remote: 'https://github.com/test/repo.git', baseRef: 'main', editablePaths: ['value.txt'],
    purpose: '前端页面', routingTerms: ['页面'],
    checks: [{ id: 'fixed', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }, {
    id: 'project-backend', sourceRepository: source, managedRoot: join(directory, 'backend'), remote: 'https://github.com/test/backend.git', baseRef: 'main', editablePaths: ['value.txt'],
    purpose: '后端归一化计算', routingTerms: ['归一化'],
    checks: [{ id: 'fixed', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }] }
  const registry = createEngineeringRegistry(config), admitted = []
  await registry.restore(store)
  assert.equal(registry.availableWorkflows().find(item => item.repositoryId === 'project-backend').purpose, '后端归一化计算')
  await assert.rejects(registry.prepareTask({ taskId: 'wrong', arguments: { repositoryId: 'project', objective: '修复归一化计算' } },
    { commandId: 'wrong', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }, { registerWorkflow() {} }), { code: 'ENGINEERING_REPOSITORY_SCOPE_MISMATCH' })
  const controller = { registerWorkflow: workflow => admitted.push(defineExecutionWorkflow(workflow).digest) }
  const action = { taskId: 'task', constraints: ['I节点新增限制'], arguments: { repositoryId: 'project', objective: '修改value', sourceRepository: 'C:/ignored', checks: ['malicious'] } }
  const info = { commandId: 'command', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }
  const prepared = await registry.prepareTask(action, info, controller)
  assert.deepEqual(prepared.input.editablePaths, ['value.txt'])
  assert.deepEqual(prepared.input.constraints, ['I节点新增限制'])
  assert.deepEqual(await registry.prepareTask(action, info, controller), prepared)
  assert.equal(admitted[0], admitted[1])
  const [record] = await store.query({ kind: 'workflow.list' })
  assert.equal(record.config.provider, 'test'); assert.equal(record.config.model, 'v1')
  assert.equal(record.config.reasoningEffort, 'low')
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

test('工程交付后补充：固定分支祖先条件续写、PR原位修订且新代读取旧代结果', { timeout: 120000 }, async t => {
  const { readFile } = await import('node:fs/promises')
  const { openExecutionArtifacts } = await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
  const { createExecutionController } = await import('../packages/dingtalk-dsh-assistant/execution-controller.js')
  const { createExecutionDelivery } = await import('../packages/dingtalk-dsh-assistant/execution-delivery.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-revision-')), source = join(directory,'source'), root=join(directory,'managed'), remote=join(directory,'remote.git'), script=join(directory,'gh.cjs'), stateFile=join(directory,'pr.json')
  await mkdir(source); await mkdir(root)
  const exec=promisify(execFile), git=async (repo,...args)=>(await exec('git',['-C',repo,...args],{windowsHide:true})).stdout.trim()
  await git(source,'init','-b','main');await git(source,'config','user.name','Test');await git(source,'config','user.email','test@example.invalid')
  await writeFile(join(source,'value.txt'),'old');await git(source,'add','.');await git(source,'commit','-m','base');await exec('git',['init','--bare',remote])
  const head=`codex/task-${executionDigest('revision-command').slice(0,24)}`
  await writeFile(script,`const fs=require('node:fs'),cp=require('node:child_process');const [file,remote,head,...args]=process.argv.slice(2);let s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;const sha=()=>cp.execFileSync('git',['ls-remote',remote,'refs/heads/'+head],{encoding:'utf8'}).trim().split(/\\s+/)[0];const value=x=>args[args.indexOf(x)+1];if(s)s.headRefOid=sha();if(args[0]==='api')console.log(JSON.stringify({object:{sha:sha()}}));else if(args[1]==='list')console.log(JSON.stringify(s?[s]:[]));else if(args[1]==='view')console.log(JSON.stringify(s));else if(['create','edit'].includes(args[1])){s={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:sha(),headRefName:head,baseRefName:'main',body:fs.readFileSync(value('--body-file'),'utf8'),title:value('--title'),creates:(s?.creates??0)+(args[1]==='create'?1:0),edits:(s?.edits??0)+(args[1]==='edit'?1:0)};fs.writeFileSync(file,JSON.stringify(s));process.exit(1)}else process.exit(2)`)
  const store=await openExecutionStore({dbPath:join(directory,'control.db'),instanceId:'revision',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true});t.after(()=>store.close())
  const registry=createEngineeringRegistry({ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,stateFile,remote,head]},repositories:[{id:'repo',sourceRepository:source,managedRoot:root,remote,githubRepository:'test/repo',baseRef:'main',editablePaths:['value.txt'],checks:[{id:'check',version:'1',executable:process.execPath,args:['-e',"if(!['one','two'].includes(require('node:fs').readFileSync('value.txt','utf8')))process.exit(1)"]}]}]})
  await registry.restore(store)
  const reached=Promise.withResolvers(),release=Promise.withResolvers();let firstCommit
  const sessions={async run({input,onSessionBound,onResult}){await onSessionBound();assert.equal(input.files[0].text,input.request==='first'?'old':'one');onResult({changes:[{path:'value.txt',expectedHash:input.files[0].expectedHash,content:input.request==='first'?'one':'two'}]})},async cancel(){},async close(){}}
  const controller=createExecutionController({store,artifacts,sessions,delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:[],changeQuietMs:0,maxChangeDelayMs:0});t.after(()=>controller.close())
  const prepared=await registry.prepareTask({taskId:'task',arguments:{repositoryId:'repo',objective:'first'}},{commandId:'revision-command',run:{actorId:'owner'},unit:{}},{registerWorkflow(workflow){const node=workflow.nodes.at(-1),original=node.execute;node.execute=async args=>{const result=await original(args);if(args.generation===1){firstCommit=result.commitId;reached.resolve();await release.promise}return result};controller.registerWorkflow(workflow)}})
  await controller.createRun({commandId:'create',...prepared})
  await reached.promise
  await controller.changeInput({commandId:'revise',runId:prepared.runId,inputId:'revision',sourceKey:'revision',input:{...prepared.input,request:'second'}});release.resolve()
  const state=await controller.whenIdle(prepared.runId)
  assert.equal(state.run.status,'succeeded',JSON.stringify(await controller.state(prepared.runId)));assert.equal(state.run.generation,2)
  const result=await artifacts.read(state.nodes.at(-1).outputRef),pr=JSON.parse(await readFile(stateFile,'utf8'))
  assert.notEqual(result.commitId,firstCommit);assert.equal(await git(remote,'rev-parse',result.commitId+'^'),firstCommit)
  assert.equal(await git(remote,'show',result.commitId+':value.txt'),'two');assert.equal(pr.creates,1);assert.equal(pr.edits,1);assert.equal(pr.title,'second');assert.match(pr.body,/second/)
  assert.equal(await readFile(join(source,'value.txt'),'utf8'),'old')
})
