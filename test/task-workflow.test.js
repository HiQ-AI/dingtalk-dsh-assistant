import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createAnalysisTaskWorkflow, createEngineeringTaskWorkflow, createEngineeringDeliveryAdapters, createEngineeringDeliverableWorkflow, createEngineeringAcceptanceWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { describeVerificationChecks, createBusinessAcceptanceCheck } from '../packages/dingtalk-dsh-assistant/execution-check-job.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import { createManagedEdits } from '../packages/dingtalk-dsh-assistant/execution-edit.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createGitDelivery } from '../packages/dingtalk-dsh-assistant/execution-git.js'
import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'
import { readEngineeringDeliveryProof } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { createEngineeringBranchReuseWorkflow, createEngineeringUatBaselineWorkflow, createEngineeringMappedBaselineWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'

test('v13冻结目标树并强制冲突在范围内、被实际读取和纳入修改',async()=>{
  const targetCommit='b'.repeat(40),mergeTree='c'.repeat(40),baseCommit='a'.repeat(40)
  let conflictPaths=['src/value.js'],didRead=false
  const workflow=createEngineeringUatBaselineWorkflow({provider:'test',model:'test',discovery:{allowedPrefixes:['src/']},
    project:{targetCommit,taskBase:baseCommit,targetBranch:'feature/uat3-base',developmentBranch:'codex/existing',branchDisposition:'reused'},
    workspaceAdapter:{prepare:async value=>({...value,targetCommit,taskBase:baseCommit,mergeTree,conflictPaths,directory:'/isolated',sourceRepository:'/source'}),reconcile:async()=>({status:'succeeded'})},
    editAdapter:{prepare:async()=>({action:'edit'})},assertConflictReads:async()=>{if(!didRead)throw Error('ENGINEERING_CONFLICT_NOT_READ')},
    checks:[{id:'check',version:'1',run:async()=>({passed:true})}],adapterIdentity:'test'})
  assert.equal(workflow.version,'13');assert.ok(defineExecutionWorkflow(workflow).digest)
  const requirement={request:'修复',baseCommit,constraints:[],editablePaths:[],expectedRemoteSha:baseCommit}
  const context={input:requirement,runId:'r',generation:1,requirementDigest:'a'.repeat(64),perform:async({prepared})=>({status:'succeeded',directory:prepared.directory,baseCommit})}
  const node=id=>workflow.nodes.find(item=>item.id===id)
  const output=await node('prepare-workspace').execute(context)
  assert.deepEqual(output.workspace.conflictPaths,conflictPaths)
  const input=node('inspect-and-propose').mapInput({requirement,dependencyOutputs:{'prepare-workspace':output}})
  assert.equal(input.baselineMerge.mergeTree,mergeTree)
  await assert.rejects(node('apply-changes').execute({...context,input:{requirement,proposal:{changes:[],replacements:[]}}}),/CONFLICT_NOT_PROPOSED/)
  const proposed={changes:[{path:'src/value.js',expectedHash:'a'.repeat(64),content:'resolved'}],replacements:[]}
  await assert.rejects(node('apply-changes').execute({...context,input:{requirement,proposal:proposed}}),/CONFLICT_NOT_READ/)
  didRead=true;await node('apply-changes').execute({...context,input:{requirement,proposal:proposed}})
  conflictPaths=['outside.js']
  await assert.rejects(node('prepare-workspace').execute(context),/CONFLICT_SCOPE_UNSUPPORTED/)
})

test('v12 工作目录产出区分已有开发分支与提测目标', async () => {
  for (const branchDisposition of ['reused', 'created']) {
    const workflow = createEngineeringBranchReuseWorkflow({ provider: 'test', model: 'test', discovery: { allowedPrefixes: ['src/'] },
      project: { developmentBranch: 'codex/existing', branchDisposition, targetBranch: 'feature/uat2-base' },
      workspaceAdapter: { prepare: async input => ({ ...input, directory: '/isolated', sourceRepository: '/source' }) },
      editAdapter: {}, checks: [{ id: 'check', version: '1', run: async () => ({ passed: true, log: '' }) }], adapterIdentity: 'test' })
    assert.equal(workflow.version, '12')
    assert.ok(defineExecutionWorkflow(workflow).digest)
    const output = await workflow.nodes.find(node => node.id === 'prepare-workspace').execute({
      input: { request: '修改内容', constraints: [], editablePaths: [], baseCommit: 'a'.repeat(40) }, perform: async ({ prepared }) => ({ status: 'succeeded', directory: prepared.directory, baseCommit: prepared.baseCommit }) })
    assert.equal(output.workspace.developmentBranch, 'codex/existing')
    assert.equal(output.workspace.branchDisposition, branchDisposition)
    assert.equal(output.workspace.targetBranch, 'feature/uat2-base')
    assert.equal(output.workspace.kind, 'independent-git-repository')
    const continued = await workflow.nodes.find(node => node.id === 'prepare-workspace').execute({
      input: { request: '继续修改', constraints: [], editablePaths: [], baseCommit: 'b'.repeat(40), expectedRemoteSha: 'b'.repeat(40) },
      perform: async ({ prepared }) => ({ status: 'succeeded', directory: prepared.directory, baseCommit: prepared.baseCommit }) })
    assert.equal(continued.workspace.branchDisposition, 'reused')
  }
})

test('新工程节点保存起点、目录回执和方案文档，缺失覆盖的方案不得进入修改', async () => {
  const project = { repository: 'org/repo', sourceRepository: '/source', workBranch: 'codex/task', targetBranch: 'main' }
  const workflow = createEngineeringDeliverableWorkflow({ provider: 'test', model: 'test', discovery: { allowedPrefixes: ['src/'] }, project,
    workspaceAdapter: { prepare: async input => ({ ...input, directory: '/isolated', sourceRepository: '/source' }) }, editAdapter: {},
    checks: [{ id: 'check', version: '1', run: async () => ({ passed: true, log: '' }) }], adapterIdentity: 'test', prepareGeneration: async ({ input }) => ({ ...input, expectedRemoteSha: null }) })
  assert.ok(defineExecutionWorkflow(workflow).digest)
  assert.equal(workflow.version, '9')
  const requirement = { request: '修改内容', baseCommit: 'a'.repeat(40), constraints: [], editablePaths: [] }
  const start = await workflow.nodes[0].execute({ input: requirement })
  assert.equal(start.startingPoint.repository, 'org/repo')
  assert.equal(start.startingPoint.mode, 'initial')
  const workspace = workflow.nodes.find(node => node.id === 'prepare-workspace')
  assert.deepEqual(await workspace.mapInput({ requirement, dependencyOutputs: { 'prepare-generation': start } }), start.requirement)
  const output = await workspace.execute({ input: requirement, perform: async ({ prepared }) => ({ status: 'succeeded', directory: prepared.directory, baseCommit: prepared.baseCommit }) })
  assert.equal(output.workspace.directory, '/isolated')
  assert.equal(output.workspace.kind, 'independent-git-repository')
  await assert.rejects(workspace.execute({ input: requirement, perform: async () => ({ status: 'unknown' }) }), /ENGINEERING_WORKSPACE_RECEIPT_INVALID/)
  const validation = workflow.nodes.find(node => node.id === 'validate-proposal')
  const proposal = { changes: [], replacements: [{ path: 'src/value.js', expectedHash: 'a'.repeat(64), from: 'old', to: 'new' }], document: { name: '修改方案.md', markdown: '# 方案\n调整 src/value.js，验证计划：运行单元测试；尚未执行。' } }
  assert.deepEqual(await validation.execute({ input: proposal }), proposal)
  for (const markdown of ['', '没有提到变更文件', 'src/value.js' + 'x'.repeat(24000)]) await assert.rejects(validation.execute({ input: { ...proposal, document: { ...proposal.document, markdown } } }), /ENGINEERING_PROPOSAL_DOCUMENT_INVALID/)
})

test('检查报告解释真实命令，跳过测试不可被显示为测试通过', () => {
  const result = describeVerificationChecks({ checks: [{ id: 'dataset-package', passed: true, log: JSON.stringify({ steps: [{ args: ['-DskipTests', 'package'], exitCode: 0, reason: null }] }) }] })
  assert.match(result[0].title, /Java 项目打包（跳过测试）/)
  assert.match(result[0].steps[0].limitation, /不能作为测试通过/)
  assert.doesNotMatch(JSON.stringify(result), /dataset-package/)
  assert.match(describeVerificationChecks({ checks: [{ id: 'private-id', passed: true, log: 'plain log' }] })[0].limitation, /无法确定验证范围/)
})

test('工程读取节点可交接超过旧 48KB 限额的完整文件材料', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-large-read-'))
  const source = join(directory, 'source')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  const content = 'a'.repeat(225000)
  await writeFile(join(source, 'large.txt'), content); await git('add', 'large.txt'); await git('commit', '-m', 'base')
  const workspaceAdapter = { prepare: async () => ({ directory: source }), reconcile: async () => ({ status: 'succeeded' }) }
  const workflow = createEngineeringTaskWorkflow({ provider: 'test', model: 'synthetic', workspaceAdapter,
    editAdapter: {}, checks: [{ id: 'noop', version: '1', run: async () => ({ passed: true, log: '' }) }], adapterIdentity: source })
  const result = await workflow.nodes.find(node => node.id === 'read-files').execute({
    input: { request: '检查大文件', constraints: [], baseCommit: await git('rev-parse', 'HEAD'), editablePaths: ['large.txt'] },
    runId: 'large-run', generation: 1, requirementDigest: 'a'.repeat(64), signal: new AbortController().signal,
  })
  assert.equal(result.files[0].text, content)
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  assert.equal((await artifacts.read((await artifacts.put(result)).ref)).files[0].text, content)
})

for (const wrongEvidence of [false, true]) test(`固定分析工作流：真实控制账和工件交接，${wrongEvidence ? '拒绝未知证据' : '完成三个节点'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-workflow-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'analysis', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  let calls = 0
  const sessions = {
    async run({ input, definition, onSessionBound, onResult }) {
      calls++
      assert.deepEqual(definition.allowedTools, [])
      assert.equal(input.materials[0].text, 'alpha is active')
      await onSessionBound()
      onResult({ summary: 'alpha is active', evidenceIds: [wrongEvidence ? 'unknown' : 'source-1'], limitations: [] })
    }, async cancel() {}, async close() {},
  }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: [createAnalysisTaskWorkflow({ provider: 'test', model: 'synthetic' })] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-analysis', input: {
    request: 'summarize', constraints: [], materials: [{ id: 'source-1', text: 'alpha is active' }],
  } })
  const state = await controller.whenIdle('run')
  assert.equal(calls, 1)
  assert.equal(state.run.status, wrongEvidence ? 'waiting' : 'succeeded')
  if (wrongEvidence) assert.equal(state.nodes[2].waitReason.reference, 'TASK_EVIDENCE_UNKNOWN')
  else assert.deepEqual(await artifacts.read(state.nodes[2].outputRef), { summary: 'alpha is active', evidenceIds: ['source-1'], limitations: [] })
})

for (const publish of [false, true]) test(`固定工程流程实跑：受管clone→结构化修改→冻结验证${publish ? '→commit/push→PR独立回读' : ''}`, { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-engineering-')), source = join(directory, 'source'), root = join(directory, 'workspaces')
  await mkdir(source); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'old'); await git('add', 'value.txt'); await git('commit', '-m', 'base')
  const baseCommit = await git('rev-parse', 'HEAD')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'engineering', initialize: true })
  t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workspaceAdapter = await createManagedWorkspaces({ root, sourceRepository: source }), editAdapter = createManagedEdits({ workspaceAdapter })
  let deliveryPlan, adapters = {}
  if (publish) {
    const remote = join(directory, 'remote.git'), script = join(directory, 'gh.cjs'), state = join(directory, 'pr.json')
    await exec('git', ['init', '--bare', remote], { windowsHide: true })
    await writeFile(script, `const fs=require('node:fs'), cp=require('node:child_process'); const [file,remote,...args]=process.argv.slice(2); const s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
const sha=()=>cp.execFileSync('git',['ls-remote',remote,'refs/heads/codex/test'],{encoding:'utf8'}).trim().split(/\\s+/)[0]; const value=x=>args[args.indexOf(x)+1];
if(args[0]==='api')console.log(JSON.stringify({object:{sha:sha()}}));else if(args[1]==='list')console.log(JSON.stringify(s?[s]:[]));else if(args[1]==='view')console.log(JSON.stringify(s));else if(args[1]==='create'){const pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:sha(),headRefName:'codex/test',baseRefName:'main',body:fs.readFileSync(value('--body-file'),'utf8')};fs.writeFileSync(file,JSON.stringify(pr));process.exit(1)}else process.exit(2);`)
    const gitAdapterFor = repository => createGitDelivery({ repository, remote, branch: 'codex/test', author: { name: 'Test', email: 'test@example.invalid' } })
    const prAdapterFor = repository => createGithubPullRequests({ repository, repo: 'test/repo', base: 'main', head: 'codex/test', ghCommand: { executable: process.execPath, args: [script, state, remote] } })
    deliveryPlan = { identity: remote, gitAdapterFor, prAdapterFor, date: '1750000000 +0000', commitMessage: 'validated change', title: 'validated change', body: '真实文件检查通过', expectedRemoteSha: null }
    adapters = createEngineeringDeliveryAdapters({ gitAdapterFor, prAdapterFor })
  }
  const delivery = createExecutionDelivery({ store, artifacts, workspaceAdapter, editAdapter, ...adapters, authorize: async () => ({ principalId: 'test', authorizationRef: 'test-task' }) })
  const sessions = { async run({ input, onSessionBound, onResult }) {
    assert.equal(input.files.length, 1); assert.equal(input.files[0].text, 'old')
    await onSessionBound(); onResult({ changes: [{ path: 'value.txt', expectedHash: input.files[0].expectedHash, content: 'new' }] })
  }, async cancel() {}, async close() {} }
  let checkCalls = 0
  const checks = [{ id: 'expected-value', version: '1', run: async snapshot => { checkCalls++; return { passed: (await snapshot.readFile('value.txt')).toString() === 'new', log: 'checked frozen value.txt' } } }]
  const controller = createExecutionController({ store, artifacts, sessions, delivery, workflows: [createEngineeringTaskWorkflow({ provider: 'test', model: 'synthetic', workspaceAdapter, editAdapter, checks, adapterIdentity: source, deliveryPlan })] })
  t.after(() => controller.close())
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-engineering', input: { request: 'replace old with new', constraints: [], baseCommit, editablePaths: ['value.txt'] } })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded', JSON.stringify({ error: (await controller.state('run')).controllerError, nodes: state.nodes.map(node => ({ id: node.nodeId, status: node.status, reason: node.waitReason })) }))
  assert.equal(state.nodes.length, publish ? 12 : 5)
  assert.equal(checkCalls, 1, '正常同进程验证与提交准备只能执行一次checks')
  const result = await artifacts.read(state.nodes[4].outputRef)
  assert.equal(result.verification.passed, true)
  assert.equal(result.deliveryStatus, 'not_submitted')
  assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'old')
  assert.equal(await readFile(join(result.candidate.repository, 'value.txt'), 'utf8'), 'new')
  if (publish) {
    const final = await artifacts.read(state.nodes.at(-1).outputRef)
    assert.equal(final.deliveryStatus, 'pr_verified'); assert.equal(final.number, 1); assert.equal(final.state, 'OPEN')
    // 该夹具直接注册流程，没有真实 registry 身份，不能作为受信跨流程交付证明。
    await assert.rejects(readEngineeringDeliveryProof({ state, artifacts, store, taskId: 'task', requiredE2eCheckIds: ['expected-value'] }), { code: 'ENGINEERING_DELIVERY_PROOF_UNAVAILABLE' })
  }
  const effects = await store.query({ kind: 'effect.list', runId: 'run' })
  assert.deepEqual(effects.map(effect => effect.definition.action).sort(), publish ? ['commit', 'edit', 'pr', 'push', 'workspace'] : ['edit', 'workspace'])
  assert.ok(effects.every(effect => effect.state === 'succeeded'))
})

test('提交准备只复用进程内可信票据；全新Node进程忽略持久JSON并重新实跑检查', { timeout: 60000 }, async () => {
  const { pathToFileURL } = await import('node:url')
  const directory=await mkdtemp(join(tmpdir(),'dsh-ticket-')),source=join(directory,'source'),remote=join(directory,'remote.git'),counter=join(directory,'counter.json'),moduleFile=join(directory,'factory.mjs'),inputFile=join(directory,'input.json')
  await mkdir(source)
  const exec=promisify(execFile),git=async(...args)=>(await exec('git',['-C',source,...args],{windowsHide:true})).stdout.trim()
  await git('init','-b','main');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');await writeFile(join(source,'value.txt'),'new');await git('add','.');await git('commit','-m','base')
  await exec('git',['init','--bare',remote],{windowsHide:true})
  await writeFile(counter,'0')
  await writeFile(moduleFile,`import {readFile,writeFile} from 'node:fs/promises';import {createEngineeringTaskWorkflow} from ${JSON.stringify(new URL('../packages/dingtalk-dsh-assistant/task-workflow.js',import.meta.url).href)};import {createGitDelivery} from ${JSON.stringify(new URL('../packages/dingtalk-dsh-assistant/execution-git.js',import.meta.url).href)};
export function make({source,counter,remote}){const checks=[{id:'actual',version:'1',configurationDigest:'fixed',run:async snapshot=>{const count=JSON.parse(await readFile(counter,'utf8'))+1;await writeFile(counter,JSON.stringify(count));return {passed:(await snapshot.readFile('value.txt')).toString()==='new',log:'actual check '+count}}}];return createEngineeringTaskWorkflow({provider:'test',model:'test',workspaceAdapter:{prepare:async()=>({directory:source}),reconcile:async()=>({status:'succeeded'})},editAdapter:{},checks,adapterIdentity:source,deliveryPlan:{identity:'fixed',gitAdapterFor:repository=>createGitDelivery({repository,remote,branch:'delivery',author:{name:'Test',email:'test@example.invalid'}}),prAdapterFor:()=>({}),date:'1750000000 +0000',title:'verified',body:'verified',commitMessage:'verified',expectedRemoteSha:null}})}
`)
  const scope={source,counter,remote}, {make}=await import(pathToFileURL(moduleFile).href),workflow=make(scope)
  const verified=await workflow.nodes.find(n=>n.id==='verify-candidate').execute({input:{request:'verify',constraints:[],baseCommit:await git('rev-parse','HEAD'),editablePaths:['value.txt']},runId:'run',generation:1,requirementDigest:'a'.repeat(64)})
  const prepared=await workflow.nodes.find(n=>n.id==='prepare-commit').execute({input:structuredClone(verified)})
  assert.equal(JSON.parse(await readFile(counter,'utf8')),1)
  await writeFile(inputFile,JSON.stringify({...verified,verification:{passed:true,checks:[],digest:'forged-persistent-json'}}))
  const runner=join(directory,'restart.mjs')
  await writeFile(runner,`import {readFile} from 'node:fs/promises';import {make} from './factory.mjs';const input=JSON.parse(await readFile(process.argv[2],'utf8'));const workflow=make(JSON.parse(process.argv[3]));console.log(JSON.stringify(await workflow.nodes.find(n=>n.id==='prepare-commit').execute({input})));`)
  const resumed=JSON.parse((await exec(process.execPath,[runner,inputFile,JSON.stringify(scope)],{windowsHide:true})).stdout)
  assert.equal(JSON.parse(await readFile(counter,'utf8')),2);assert.equal(resumed.commitId,prepared.commitId);assert.equal(resumed.verification.checks[0].log,'actual check 2')
})

test('失败工程检查以有界工件保留完整日志，节点仍waiting且下游不执行', { timeout: 60000 }, async t => {
  const {createHash}=await import('node:crypto')
  const directory=await mkdtemp(join(tmpdir(),'dsh-check-evidence-')),source=join(directory,'source');await mkdir(source)
  const exec=promisify(execFile),git=async(...args)=>(await exec('git',['-C',source,...args],{windowsHide:true})).stdout.trim()
  await git('init','-b','main');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');await writeFile(join(source,'value.txt'),'source');await git('add','.');await git('commit','-m','base')
  const {createVerificationJobCheck}=await import('../packages/dingtalk-dsh-assistant/execution-check-job.js')
  let log
  const job=createVerificationJobCheck({id:'build',version:'1',root:join(directory,'checks'),executable:process.execPath,args:['-e',"process.stdout.write(Buffer.alloc(10000,0));process.stderr.write(Buffer.alloc(10000,1));process.exitCode=3"]})
  const store=await openExecutionStore({dbPath:join(directory,'control.db'),instanceId:'failure',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true})
  const factory=createEngineeringTaskWorkflow({provider:'test',model:'test',workspaceAdapter:{prepare:async()=>({directory:source}),reconcile:async()=>({status:'succeeded'})},editAdapter:{},adapterIdentity:source,checks:[{id:'build',version:'1',run:async snapshot=>{const result=await job.run(snapshot);log=result.log;return result}}]})
  let nextCalls=0
  const controller=createExecutionController({store,artifacts,workflows:[{id:'failed-check',version:'1',nodes:[factory.nodes.find(n=>n.id==='verify-candidate'),{id:'next',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({previousOutput})=>previousOutput,execute:async()=>{nextCalls++;return {}}}]}]})
  t.after(async()=>{await controller.close();await store.close()})
  await controller.createRun({commandId:'create',runId:'run',taskId:'task',workflowId:'failed-check',input:{request:'verify',constraints:[],editablePaths:['value.txt'],baseCommit:await git('rev-parse','HEAD')}})
  const state=await controller.whenIdle('run'),node=state.nodes[0]
  assert.equal(state.run.status,'waiting');assert.equal(node.status,'waiting');assert.equal(node.outputRef,null);assert.equal(node.waitReason.reference,'ENGINEERING_VERIFICATION_FAILED');assert.equal(nextCalls,0);assert.equal(state.nodes[1].status,'blocked')
  assert.ok(node.evidenceRefs.length>1);assert.ok(node.evidenceRefs.length<=128)
  const evidence=await Promise.all(node.evidenceRefs.map(ref=>artifacts.read(ref)))
  assert.equal(evidence.filter(item=>item.kind==='execution-failure'&&item.code==='ENGINEERING_VERIFICATION_FAILED').length,1)
  const chunks=evidence.filter(item=>item.kind==='engineering-verification-failure')
  assert.ok(chunks.every(c=>c.kind==='engineering-verification-failure'&&c.passed===false&&Buffer.byteLength(JSON.stringify(c))<65536))
  const bytes=Buffer.concat(chunks.sort((a,b)=>a.part-b.part).map(c=>Buffer.from(c.data,'base64')))
  assert.equal(bytes.toString('utf8'),log);assert.equal(createHash('sha256').update(bytes).digest('hex'),chunks[0].logSha256)
  const recorded=JSON.parse(log).steps[0];assert.deepEqual(Buffer.from(recorded.stdout,'base64'),Buffer.alloc(10000,0));assert.deepEqual(Buffer.from(recorded.stderr,'base64'),Buffer.alloc(10000,1))
  assert.deepEqual(await store.query({kind:'effect.list',runId:'run'}),[])
})


test('业务验收独立于构建，缺用例或实际结果不匹配时阻止提交，重建后不信任旧票据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-business-acceptance-')), source = join(directory, 'source')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'old'); await git('add', '.'); await git('commit', '-m', 'base')
  const baseCommit = await git('rev-parse', 'HEAD')
  await writeFile(join(source, 'value.txt'), '1 t')
  let commits = 0, calls = 0
  const options = { provider: 'test', model: 'test', adapterIdentity: 'test', editAdapter: {},
    workspaceAdapter: { prepare: async () => ({ directory: source }), reconcile: async () => ({ status: 'succeeded' }) },
    checks: [{ id: 'build', version: '1', run: async () => ({ passed: true, log: 'build-only' }) }],
    deliveryPlan: { identity: 'test', date: '1770000000 +0000', commitMessage: 'fix', title: 'fix', body: 'fix', expectedRemoteSha: null,
      gitAdapterFor: async () => ({ prepareCommit: async () => { commits++; return {} } }), prAdapterFor: async () => ({}) } }
  const context = { input: { request: '归一化应得到 1 t', constraints: [], editablePaths: ['value.txt'], baseCommit }, runId: 'r', generation: 1, requirementDigest: 'a'.repeat(64) }
  const makeCheck = (expected = '1 t', code = "console.log(JSON.stringify({actual:require('node:fs').readFileSync('value.txt','utf8')}))") => {
    const check = createBusinessAcceptanceCheck({ id: 'normalization', version: '1', criterion: '归一化计算结果', expected, root: join(directory, 'checks'), executable: process.execPath, args: ['-e', code] })
    const run = check.run
    return { ...check, run: async (...args) => { calls++; return run(...args) } }
  }
  const build = workflow => workflow.nodes.find(n => n.id === 'verify-candidate').execute(context)
  const accept = (workflow, input) => workflow.nodes.find(n => n.id === 'business-acceptance').execute({ input })
  const prepare = (workflow, input) => workflow.nodes.find(n => n.id === 'prepare-commit').execute({ input })
  const missing = createEngineeringAcceptanceWorkflow(options)
  assert.equal(missing.version, '10'); assert.ok(defineExecutionWorkflow(missing).digest)
  assert.deepEqual(missing.nodes.slice(-8, -5).map(n => n.id), ['business-acceptance', 'prepare-commit', 'commit'])
  const built = await build(missing)
  assert.equal(built.verification.passed, true)
  await assert.rejects(accept(missing, built), /ENGINEERING_ACCEPTANCE_REQUIRED/)
  await assert.rejects(prepare(missing, { ...built, acceptance: { passed: true } }), /ENGINEERING_ACCEPTANCE_REQUIRED/)
  const failed = createEngineeringAcceptanceWorkflow({ ...options, acceptanceChecks: [makeCheck('2 t')] })
  await assert.rejects(accept(failed, built), error => error.code === 'ENGINEERING_ACCEPTANCE_FAILED' && error.evidence.length > 0)
  const empty = createEngineeringAcceptanceWorkflow({ ...options, acceptanceChecks: [makeCheck('1 t', 'process.exit(0)')] })
  await assert.rejects(accept(empty, built), /ENGINEERING_ACCEPTANCE_FAILED/)
  assert.equal(commits, 0)
  const store = await openExecutionStore({ dbPath: join(directory, 'gates.db'), instanceId: 'gate', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const gate = failed.nodes.find(n => n.id === 'business-acceptance')
  const controller = createExecutionController({ store, artifacts, workflows: [{ id: 'gate', version: '1', nodes: [
    { id: 'build', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => built },
    gate,
    { id: 'commit', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ previousOutput }) => previousOutput, execute: async () => { commits++; return {} } },
  ] }] })
  try {
    await controller.createRun({ commandId: 'gate', runId: 'gate', taskId: 'gate', workflowId: 'gate', input: {} })
    const state = await controller.whenIdle('gate')
    assert.equal(state.run.status, 'waiting')
    assert.equal(state.nodes[0].status, 'succeeded')
    assert.equal(state.nodes[1].status, 'waiting')
    assert.equal(state.nodes[1].waitReason.reference, 'ENGINEERING_ACCEPTANCE_FAILED')
    assert.ok(state.nodes[1].evidenceRefs.length > 0)
    assert.notEqual(state.nodes[2].status, 'succeeded')
    assert.equal(commits, 0)
  } finally { await controller.close(); await store.close() }
  const passed = createEngineeringAcceptanceWorkflow({ ...options, acceptanceChecks: [makeCheck()] })
  const accepted = await accept(passed, built)
  const item = JSON.parse(accepted.acceptance.checks[0].log).acceptance
  assert.deepEqual(item, { criterion: '归一化计算结果', expected: '1 t', actual: '1 t', passed: true })
  const before = calls
  await prepare(passed, accepted); assert.equal(calls, before); assert.equal(commits, 1)
  const restarted = createEngineeringAcceptanceWorkflow({ ...options, acceptanceChecks: [makeCheck()] })
  await prepare(restarted, JSON.parse(JSON.stringify(accepted))); assert.equal(calls, before + 1)
  await writeFile(join(source, 'value.txt'), '0.001 t')
  const changed = await build(restarted)
  await assert.rejects(accept(restarted, { ...changed, acceptance: accepted.acceptance }), /ENGINEERING_ACCEPTANCE_FAILED/)
})


test('v14真实controller按需检索依次进入方案和应用，v13冻结合同不改', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-mapping-')), source = join(directory, 'source')
  await mkdir(join(source, 'src'), { recursive: true })
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'src/value.txt'), 'old'); await git('add', '.'); await git('commit', '-m', 'base')
  const baseCommit = await git('rev-parse', 'HEAD')
  for (const version of ['13', '14']) {
    const root = join(directory, version)
    await mkdir(join(root, 'workspace'), { recursive: true })
    const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'mapping', initialize: true })
    t.after(() => store.close())
    const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
    const workspaceAdapter = await createManagedWorkspaces({ root: join(root, 'workspace'), sourceRepository: source, targetCommit: baseCommit, taskBase: baseCommit })
    const editAdapter = createManagedEdits({ workspaceAdapter })
    const options = { provider: 'test', model: 'test', discovery: { allowedPrefixes: ['src/'] },
      prepareGeneration: async ({ input }) => ({ ...input, request: '派生要求' }),
      project: { targetCommit: baseCommit, taskBase: baseCommit, targetBranch: 'feature/uat2-base', uatEnvironment: 'uat2', developmentBranch: 'codex/test', branchDisposition: 'created' },
      workspaceAdapter, editAdapter, checks: [{ id: 'check', version: '1', run: async () => ({ passed: true }) }], adapterIdentity: 'mapping',
      localAcceptance: { scenarios: [{ id: 'value', description: '读取值' }] } }
    const previousDigest = defineExecutionWorkflow(createEngineeringUatBaselineWorkflow(options)).digest
    const workflow = (version === '14' ? createEngineeringMappedBaselineWorkflow : createEngineeringUatBaselineWorkflow)(options)
    assert.equal(defineExecutionWorkflow(createEngineeringUatBaselineWorkflow(options)).digest, previousDigest)
    // 保留真实顺序和所有输入映射，结束于 apply；本用例不运行验收服务或外部交付。
    workflow.nodes = workflow.nodes.slice(0, workflow.nodes.findIndex(node => node.id === 'apply-changes') + 1)
    const apply = workflow.nodes.at(-1), applyExecute = apply.execute
    apply.execute = context => { assert.equal(context.input.requirement.request, '派生要求'); return applyExecute(context) }
    let proposals = 0
    const sessions = { async run({ input, onSessionBound, onResult }) {
      await onSessionBound()
      if (input.criteria) return onResult({ cases: input.criteria.map(item => ({ criterionId: item.id, scenarioId: 'value', steps: ['读取'], expected: 'new', parameters: {} })) })
      proposals++
      assert.equal(input.request, '派生要求'); assert.equal(input.baseCommit, baseCommit)
      assert.equal(input.baselineMerge.taskBase, baseCommit)
      const { createHash } = await import('node:crypto')
      onResult({ document: { name: '修改方案.md', markdown: '修改 src/value.txt 并核对其内容。' },
        changes: [{ path: 'src/value.txt', expectedHash: createHash('sha256').update('old').digest('hex'), content: 'new' }], replacements: [] })
    }, async cancel() {}, async close() {} }
    const delivery = createExecutionDelivery({ store, artifacts, workspaceAdapter, editAdapter, authorize: async () => ({ principalId: 'test', authorizationRef: 'test' }) })
    const controller = createExecutionController({ store, artifacts, sessions, delivery, readTools: ['engineering_repo_inspect'], workflows: [workflow] })
    try {
      await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id,
        input: { request: '修改', constraints: [], baseCommit, editablePaths: [], acceptanceCriteria: ['值更新'] } })
      if (version === '13') {
        const state=await controller.whenIdle('run')
        assert.equal(state.run.status,'failed')
        const failed=state.nodes.find(node=>node.status==='failed')
        const evidence=await Promise.all(failed.evidenceRefs.map(ref=>artifacts.read(ref)))
        assert.ok(evidence.some(item=>item.kind==='execution-failure'&&item.phase==='input-mapping'&&/reading 'requirement'/.test(item.message)))
        assert.equal(proposals, 0)
      } else {
        const state = await controller.whenIdle('run')
        assert.equal(state.run.status, 'succeeded', JSON.stringify(await controller.state('run')))
        assert.equal(proposals, 1)
        for (const id of ['prepare-workspace', 'inspect-and-propose', 'validate-proposal', 'apply-changes']) assert.equal(state.nodes.find(node => node.nodeId === id).status, 'succeeded')
        const output = await artifacts.read(state.nodes.find(node => node.nodeId === 'prepare-workspace').outputRef)
        assert.equal(await readFile(join(output.workspace.directory, 'src/value.txt'), 'utf8'), 'new')
      }
    } finally { await controller.close(); await store.close() }
  }
})

test('v15无需修改保留源码并重新检查；缺读取、冲突、工作树漂移均阻断，v14仍拒绝空方案', async t => {
  const { createEngineeringRevalidationWorkflow } = await import('../packages/dingtalk-dsh-assistant/task-workflow.js')
  const { describeTaskNodeOutput } = await import('../packages/dingtalk-dsh-assistant/workflow-service.js')
  const root=await mkdtemp(join(tmpdir(),'dsh-no-change-')),source=join(root,'source')
  await mkdir(join(source,'src'),{recursive:true});await mkdir(join(root,'work'))
  const exec=promisify(execFile),git=async(...args)=>(await exec('git',['-C',source,...args],{windowsHide:true})).stdout.trim()
  await git('init','-b','main');await git('config','user.name','Test');await git('config','user.email','test@example.invalid')
  await writeFile(join(source,'src/value.txt'),'already correct');await git('add','.');await git('commit','-m','base')
  const baseCommit=await git('rev-parse','HEAD'),workspaceAdapter=await createManagedWorkspaces({root:join(root,'work'),sourceRepository:source,targetCommit:baseCommit,taskBase:baseCommit})
  const scope={runId:'run',generation:1,requirementDigest:'a'.repeat(64),baseCommit},workspace=await workspaceAdapter.prepare(scope)
  await workspaceAdapter.execute(workspace)
  let read=false,checks=0,edits=0
  const options={provider:'test',model:'test',discovery:{allowedPrefixes:['src/']},project:{targetCommit:baseCommit,taskBase:baseCommit},workspaceAdapter,
    editAdapter:{prepare(){edits++;throw Error('must not edit')}},assertConflictReads:async({paths})=>{assert.deepEqual(paths,['src/value.txt']);if(!read)throw Error('ENGINEERING_CONFLICT_NOT_READ')},
    checks:[{id:'build',version:'1',run:async()=>{checks++;return{passed:true,log:'build passed'}}}],adapterIdentity:'no-change'}
  const oldDigest=defineExecutionWorkflow(createEngineeringMappedBaselineWorkflow(options)).digest
  const workflow=createEngineeringRevalidationWorkflow(options),node=id=>workflow.nodes.find(n=>n.id===id)
  assert.equal(workflow.version,'15');assert.equal(defineExecutionWorkflow(createEngineeringMappedBaselineWorkflow(options)).digest,oldDigest)
  const proposal={changeDisposition:'no-change',changes:[],replacements:[],reviewedPaths:['src/value.txt'],reason:'已读取，现有实现满足要求',document:{name:'修改方案.md',markdown:'src/value.txt 现有实现正确，重新构建验收'}}
  const context={...scope,input:{requirement:{baseCommit},proposal},perform:()=>{throw Error('must not perform edit')}}
  await assert.rejects(node('apply-changes').execute(context),/ENGINEERING_CONFLICT_NOT_READ/)
  read=true;const result=await node('apply-changes').execute(context)
  assert.equal(result.changeDisposition,'no-change');assert.equal(edits,0);assert.deepEqual(result.files,[])
  assert.match(describeTaskNodeOutput({nodeId:'apply-changes'},result).overview,/无需修改源码；继续构建与验收/)
  await node('verify-candidate').execute({...scope,input:{baseCommit}});assert.equal(checks,1)
  assert.ok(node('run-local-acceptance'));assert.ok(node('finalize-local-acceptance'))
  const oldValidate=createEngineeringMappedBaselineWorkflow(options).nodes.find(n=>n.id==='validate-proposal')
  await assert.rejects(oldValidate.execute({input:proposal}),{code:'ENGINEERING_PROPOSAL_DOCUMENT_INVALID'})
  await assert.rejects(node('validate-proposal').execute({input:{...proposal,reviewedPaths:[]}}),{code:'ENGINEERING_NO_CHANGE_EVIDENCE_REQUIRED'})
  await assert.rejects(node('validate-proposal').execute({input:{...proposal,changes:[{path:'src/value.txt'}]}}),{code:'ENGINEERING_NO_CHANGE_EVIDENCE_REQUIRED'})
  await assert.rejects(node('validate-proposal').execute({input:{...proposal,changeDisposition:'modify',replacements:[{path:'src/value.txt',from:'same',to:'same'}]}}),{code:'ENGINEERING_NO_EFFECT_MODIFICATION'})
  const conflicted=createEngineeringRevalidationWorkflow({...options,workspaceAdapter:{...workspaceAdapter,
    prepare:async()=>({...workspace,conflictPaths:['src/value.txt']}),reconcile:async()=>({status:'succeeded'})}})
  await assert.rejects(conflicted.nodes.find(n=>n.id==='apply-changes').execute(context),{code:'ENGINEERING_CONFLICT_NOT_PROPOSED'})
  await writeFile(join(workspace.directory,'src/value.txt'),'drift')
  await assert.rejects(node('apply-changes').execute(context),{code:'ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT'})
})
