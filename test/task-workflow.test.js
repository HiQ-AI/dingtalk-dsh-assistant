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
import { createAnalysisTaskWorkflow, createEngineeringTaskWorkflow, createEngineeringDeliveryAdapters, createEngineeringDeliverableWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { describeVerificationChecks } from '../packages/dingtalk-dsh-assistant/execution-check-job.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import { createManagedEdits } from '../packages/dingtalk-dsh-assistant/execution-edit.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createGitDelivery } from '../packages/dingtalk-dsh-assistant/execution-git.js'
import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'
import { readEngineeringDeliveryProof } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'

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
  const chunks=await Promise.all(node.evidenceRefs.map(ref=>artifacts.read(ref)))
  assert.ok(chunks.every(c=>c.kind==='engineering-verification-failure'&&c.passed===false&&Buffer.byteLength(JSON.stringify(c))<65536))
  const bytes=Buffer.concat(chunks.sort((a,b)=>a.part-b.part).map(c=>Buffer.from(c.data,'base64')))
  assert.equal(bytes.toString('utf8'),log);assert.equal(createHash('sha256').update(bytes).digest('hex'),chunks[0].logSha256)
  const recorded=JSON.parse(log).steps[0];assert.deepEqual(Buffer.from(recorded.stdout,'base64'),Buffer.alloc(10000,0));assert.deepEqual(Buffer.from(recorded.stderr,'base64'),Buffer.alloc(10000,1))
  assert.deepEqual(await store.query({kind:'effect.list',runId:'run'}),[])
})
