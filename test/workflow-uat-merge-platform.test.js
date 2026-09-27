import test from 'node:test'
import assert from 'node:assert/strict'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createUatMergePlatform } from '../packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js'
import { createPlatformClients } from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'
import { createUatPrMergeTaskWorkflowV2 as createUatPrMergeTaskWorkflow, createUatPrMergeTaskWorkflow as createCurrentUatWorkflow, createMainPrMergeTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-uat-pr-merge.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), MERGE = 'c'.repeat(40), TREE = 'd'.repeat(40)
const target = { id: 'dataset-uat', kind: 'uat-deployment', repository: 'HiQ-AI/dataset',
  service: 'dataset', branch: 'feature/uat1-base' }
const requirement = { request: '将开发 PR 合入 UAT', targetId: target.id,
  repository: target.repository, service: target.service, baseBranch: target.branch,
  pullRequestNumber: 42, headCommitSha: HEAD, requiredChecks: ['unit'], evidenceRefs: ['task:source'] }

function fixture({ failingCheck = false, driftHead = false, missingWrites = false } = {}) {
  let merged = false, calls = 0, checks = 0
  const github = {
    readPullRequest: async () => ({ number: 42, state: merged ? 'closed' : 'open', merged,
      draft: false, mergeable: true, baseBranch: 'feature/uat1-base', baseRepository: 'HiQ-AI/dataset',
      headRepository: 'HiQ-AI/dataset', headCommitSha: driftHead ? BASE : HEAD,
      baseCommitSha: BASE, mergeCommitSha: merged ? MERGE : null, evidenceRef: 'pr:42' }),
    readBranch: async () => ({ commitSha: merged ? MERGE : BASE, evidenceRef: 'branch:uat' }),
    readCommit: async ({ commitSha }) => ({ commitSha, treeSha: TREE, evidenceRef: `commit:${commitSha}` }),
    readChecks: async () => { checks++; return { complete: true, checks: [{ id: 1, name: 'unit',
      status: 'completed', conclusion: failingCheck ? 'failure' : 'success' }], evidenceRef: 'checks:unit' } },
    ...(!missingWrites ? { readAtomicPushPolicy: async () => ({allowed:true,evidenceRef:'atomic-policy'}), atomicFastForward: async ({expectedBase,expectedTree}) => { assert.equal(expectedBase,BASE);assert.equal(expectedTree,TREE);calls++; merged = true
      return { mergeCommitSha: MERGE, evidenceRef: 'dispatch:42' } } } : {}),
  }
  const platform = () => createUatMergePlatform({ targets: [target], policies: [{ targetId: target.id,
    requiredChecks: ['unit'] }], github })
  return { platform, get calls() { return calls }, get checks() { return checks } }
}

test('精确 PR、head、目标和检查通过后，合并经独立回读产生来源证明；再次执行不重发', async () => {
  const f = fixture(), p = f.platform()
  const observation = await p.adapter.inspect({ phase: 'preflight', requirement })
  const prepared = await p.adapter.prepareOperation({ requirement, observation, runId: 'run-1', generation: 1,
    requirementDigest: executionDigest(requirement) })
  const first = await p.operationAdapter.execute(prepared)
  assert.equal(first.status, 'succeeded')
  assert.equal(first.mergeCommitSha, MERGE)
  assert.equal((await p.operationAdapter.execute(prepared)).status, 'succeeded')
  assert.equal(f.calls, 1)
  const source = await p.adapter.inspect({ phase: 'merged', prepared, receipt: first })
  assert.equal(source.treeSha, TREE)
  assert.equal(source.headCommitSha, HEAD)
  assert.ok(source.evidenceRefs.length >= 4)
  assert.equal(createUatPrMergeTaskWorkflow({ adapter: p.adapter }).id, 'task-uat-pr-merge')
})

test('head 漂移、检查失败、未装写端口均阻断合并', async () => {
  for (const options of [{ driftHead: true }, { failingCheck: true }]) {
    const f = fixture(options)
    await assert.rejects(f.platform().adapter.inspect({ phase: 'preflight', requirement }),
      /UAT_MERGE_PR_DRIFT_OR_UNCONFIRMED|UAT_MERGE_REQUIRED_CHECK_NOT_PASSED/)
    assert.equal(f.calls, 0)
  }
  await assert.rejects(fixture({ missingWrites: true }).platform().adapter.inspect({phase:'preflight',requirement}), /UAT_ATOMIC_BASE_CAPABILITY_REQUIRED/)
})

test('原子UAT仅FF显式base租约；无REST写入，保护策略与非FF均拒绝', async () => {
  assert.equal(createPlatformClients().github.atomicFastForward, undefined)
  let pushes = 0, blocked = false, nonFF = false, raced = false
  const clients = createPlatformClients({ githubMergeWritesEnabled: true, githubToken: 'test',
    fetchImpl: async (url, options) => {
      assert.equal(options.method,undefined)
      const body = url.includes('/rules/') ? (blocked ? [{type:'pull_request'}] : []) : url.includes('/pulls/')
        ? { state:'open',draft:false,head:{sha:HEAD,repo:{full_name:'HiQ-AI/dataset'}},base:{ref:'feature/uat1-base',sha:BASE,repo:{full_name:'HiQ-AI/dataset'}} }
        : {protected:false,commit:{sha:BASE}}
      return {ok:true,status:200,json:async()=>body}
    }, execFileImpl: async (_exe,args) => {
      if(args.includes('merge-base') && nonFF) throw Error('not ancestor')
      if(args.includes('push')) {
        assert.ok(args.includes(`--force-with-lease=refs/heads/feature/uat1-base:${BASE}`))
        assert.ok(args.includes(`${HEAD}:refs/heads/feature/uat1-base`))
        if(raced) throw Error('stale lease')
        pushes++
      }
      return {stdout:args.includes('rev-parse') ? TREE : ''}
    } })
  const input={repository:'HiQ-AI/dataset',branch:'feature/uat1-base',number:42,headCommitSha:HEAD,expectedBase:BASE,expectedTree:TREE}
  assert.equal((await clients.github.atomicFastForward(input)).mergeCommitSha,HEAD);assert.equal(pushes,1)
  for(const reason of ['protection','nonFF','race']) {
    blocked=reason==='protection';nonFF=reason==='nonFF';raced=reason==='race'
    await assert.rejects(clients.github.atomicFastForward(input), /UAT_ATOMIC_/);assert.equal(pushes,1)
  }
})

test('合并请求回执丢失后仅只读对账，恢复时不发送第二次', async () => {
  let merged = false, sends = 0
  const github = {
    readPullRequest: async () => ({ number: 42, state: merged ? 'closed' : 'open', merged,
      draft: false, mergeable: true, baseBranch: 'feature/uat1-base', baseRepository: 'HiQ-AI/dataset',
      headRepository: 'HiQ-AI/dataset', headCommitSha: HEAD, baseCommitSha: BASE,
      mergeCommitSha: merged ? MERGE : null, evidenceRef: 'pr:42' }),
    readBranch: async () => ({ commitSha: merged ? MERGE : BASE, evidenceRef: 'branch:uat' }),
    readCommit: async ({ commitSha }) => ({ commitSha, treeSha: TREE, evidenceRef: `commit:${commitSha}` }),
    readChecks: async () => ({ complete: true, checks: [{ id: 1, name: 'unit',
      status: 'completed', conclusion: 'success' }], evidenceRef: 'checks:unit' }),
    readAtomicPushPolicy: async()=>({allowed:true,evidenceRef:'atomic-policy'}),
    atomicFastForward: async () => { sends++; merged = true; throw new Error('response lost') },
  }
  const p = createUatMergePlatform({ targets: [target], policies: [{ targetId: target.id,
    requiredChecks: ['unit'] }], github })
  const observation = await p.adapter.inspect({ phase: 'preflight', requirement })
  const prepared = await p.adapter.prepareOperation({ requirement, observation, runId: 'run-timeout', generation: 1,
    requirementDigest: executionDigest(requirement) })
  await assert.rejects(p.operationAdapter.execute(prepared), /response lost/)
  assert.equal((await p.operationAdapter.reconcile(prepared)).status, 'succeeded')
  assert.equal((await p.operationAdapter.execute(prepared)).status, 'succeeded')
  assert.equal(sends, 1)
})

test('独立 UAT 合并流程经 Host 运行，最终产物通过 schema 并落到精确 Run', async t => {
  const f = fixture(), p = f.platform(), dir = await mkdtemp(join(tmpdir(), 'dsh-uat-merge-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'uat-merge', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  const workflow = createUatPrMergeTaskWorkflow({ adapter: p.adapter })
  const delivery = { async execute({ prepared }) { return { state: 'succeeded',
    result: { result: await p.operationAdapter.execute(prepared) } } } }
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run-merge', taskId: 'task-1',
    workflowId: workflow.id, input: requirement })
  const state = await controller.whenIdle('run-merge')
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(node => [node.nodeId, node.waitReason])))
  const result = await artifacts.read(state.nodes.at(-1).outputRef)
  assert.equal(result.mergeCommitSha, MERGE)
  assert.equal(f.calls, 1)
})


test('main合并独立于UAT，缺验收或批准时零合并，精确目标贯穿回读', async () => {
  const approval = 'e'.repeat(64), facts = { headTreeVerified:true, checksPassed:true, baseBound:true, uatVerified:true, businessAcceptancePassed:true, humanApproved:true, approvalReceiptDigest:approval }
  const input = { ...requirement, baseBranch:'main' }
  const adapter = { id:'main',version:'1',rulesDigest:'f'.repeat(64),
    inspect: async ({ phase }) => phase === 'preflight' ? {status:'confirmed',facts:{...facts},evidenceRefs:['uat-test','approval']} : {status:'confirmed',baseBranch:'main',headCommitSha:HEAD,mergeCommitSha:MERGE,treeSha:TREE,pullRequestNumber:42,evidenceRefs:['merged']},
    prepareOperation:async ({requirement,observation,runId,generation,requirementDigest})=>({action:'external',workflowKind:'main-pr-merge',operation:'merge-main-pr',runId,generation,requirementDigest,resourceKey:'main',operationKey:'merge',targetDigest:executionDigest(requirement),expected:{baseBranch:'main',headCommitSha:HEAD,pullRequestNumber:42,approvalReceiptDigest:observation.facts.approvalReceiptDigest}}) }
  const workflow=createMainPrMergeTaskWorkflow({adapter}), node=id=>workflow.nodes.find(item=>item.id===id)
  assert.equal(workflow.id,'task-main-pr-merge')
  await assert.rejects(node('freeze-target').execute({input:requirement}),/MAIN_MERGE_BRANCH_INVALID/)
  await node('freeze-target').execute({input})
  for(const key of ['uatVerified','businessAcceptancePassed','humanApproved']){facts[key]=false;await assert.rejects(node('inspect-preflight').execute({input}),/MAIN_MERGE_PREFLIGHT_UNCONFIRMED/);facts[key]=true}
  const checked=await node('inspect-preflight').execute({input})
  const prepared=await node('prepare-merge').execute({input:checked,runId:'main-run',generation:1,requirementDigest:'a'.repeat(64)})
  let merged=0
  const output=await node('execute-merge').execute({input:prepared,perform:async()=>{merged++;return {status:'succeeded'}}})
  const result=await node('verify-source').execute({input:output})
  assert.equal(merged,1);assert.equal(result.baseBranch,'main')
  await assert.rejects(createUatPrMergeTaskWorkflow({adapter}).nodes[0].execute({input}),/UAT_MERGE_BRANCH_INVALID/)
})

test('本地证明为独立必需门禁，空 GitHub 规则可通过但不接受遗漏、漂移和新增失败规则', async () => {
  let localValid = true, rules = [], checkRows = [], merged = false, sends = 0
  const localEvidence = { taskId: 'task-1', runId: 'engineering-1', commitSha: HEAD, treeSha: TREE, scenarioIds: ['business'] }
  const input = { ...requirement, requiredChecks: [], localEvidence }
  const github = {
    readPullRequest: async () => ({ number:42, state:merged?'closed':'open', merged, draft:false, mergeable:true,
      baseBranch:target.branch, baseRepository:target.repository, headRepository:target.repository,
      headCommitSha:HEAD, baseCommitSha:BASE, mergeCommitSha:merged?MERGE:null, evidenceRef:'pr' }),
    readBranch:async()=>({commitSha:merged?MERGE:BASE,evidenceRef:'branch'}),
    readCommit:async()=>({treeSha:TREE,evidenceRef:'commit'}),
    readChecks:async()=>({complete:true,checks:checkRows,evidenceRef:executionDigest(checkRows)}),
    readRequiredChecks:async()=>({complete:true,checks:rules,evidenceRef:executionDigest(rules)}),
    readAtomicPushPolicy:async()=>({allowed:true,evidenceRef:'atomic-policy'}),
    atomicFastForward:async()=>{sends++;merged=true;return {evidenceRef:'merged'}},
  }
  const platform = createUatMergePlatform({targets:[target],policies:[{targetId:target.id,requiredChecks:[],requiredScenarioIds:['business']}],github,
    readLocalEvidence:async value=>{
      assert.deepEqual(value.localEvidence,localEvidence)
      if(!localValid)throw Error('LOCAL_RECEIPT_CHANGED')
      return {...localEvidence,evidenceRef:'local:verified'}
    }})
  for (const version of ['13', '14']) {
    localEvidence.definitionVersion = version
    localEvidence.targetCommit = HEAD
    await assert.rejects(platform.adapter.inspect({phase:'preflight',requirement:input}), /UAT_MERGE_BASELINE_DRIFT/)
    localEvidence.targetCommit = BASE
    await platform.adapter.inspect({phase:'preflight',requirement:input})
  }
  const observed=await platform.adapter.inspect({phase:'preflight',requirement:input})
  assert.equal(observed.facts.localAcceptancePassed,true)
  const workflow=createCurrentUatWorkflow({adapter:platform.adapter})
  assert.equal(workflow.version,'3')
  await workflow.nodes[0].execute({input})
  await assert.rejects(workflow.nodes[0].execute({input:{...input,localEvidence:undefined}}),/REQUIREMENT_INVALID/)
  const prepared=await platform.adapter.prepareOperation({requirement:input,observation:observed,runId:'run',generation:1,requirementDigest:executionDigest(input)})
  localValid=false
  await assert.rejects(platform.operationAdapter.execute(prepared),/LOCAL_RECEIPT_CHANGED/)
  localValid=true;rules=[{name:'ci',appId:9}]
  await assert.rejects(platform.operationAdapter.execute(prepared),/REQUIRED_CHECK_NOT_PASSED/)
  checkRows=[{name:'ci',appId:8,status:'completed',conclusion:'success'}]
  await assert.rejects(platform.operationAdapter.execute(prepared),/REQUIRED_CHECK_NOT_PASSED/)
  checkRows=[{name:'ci',appId:9,status:'completed',conclusion:'success'}]
  await assert.rejects(platform.operationAdapter.execute(prepared),/PREFLIGHT_DRIFT/)
  rules=[];checkRows=[]
  assert.equal((await platform.operationAdapter.execute(prepared)).status,'succeeded')
  assert.equal(sends,1)
})

test('GitHub 规则合并保护和 ruleset，传统 status 仅采纳当前 head 最新状态',async()=>{
  const github=createPlatformClients({fetchImpl:async url=>{
    const data=url.includes('/protection')?{required_status_checks:{contexts:['classic'],checks:[{context:'classic',app_id:7}]}}
      :url.includes('/rules/')?[{type:'required_status_checks',parameters:{required_status_checks:[{context:'ruleset',integration_id:8}]}}]
      :url.includes('/check-runs')?{total_count:1,check_runs:[{id:1,name:'classic',head_sha:HEAD,app:{id:7},status:'completed',conclusion:'success'}]}
      :url.includes('/statuses')?[{id:3,context:'legacy',state:'failure'},{id:2,context:'legacy',state:'success'}]
      :{protected:true,commit:{sha:HEAD}}
    return {ok:true,status:200,json:async()=>data}
  }}).github
  assert.deepEqual((await github.readRequiredChecks({repository:target.repository,branch:target.branch})).checks,[{name:'classic',appId:7},{name:'ruleset',appId:8}])
  const checks=await github.readChecks({repository:target.repository,commitSha:HEAD,includeStatuses:true})
  assert.equal(checks.checks.length,2)
  assert.equal(checks.checks[1].conclusion,'failure')
})

test('读取规则失败不能当作空规则；只有明确无经典保护才继续读取规则集',async()=>{
  for(const error of [{status:403,message:'Forbidden'},{status:404,message:'Not Found'}]){
    const github=createPlatformClients({fetchImpl:async url=>url.includes('/protection')
      ?{ok:false,status:error.status,json:async()=>({message:error.message})}
      :{ok:true,status:200,json:async()=>({protected:true,commit:{sha:HEAD}})}}).github
    await assert.rejects(github.readRequiredChecks({repository:target.repository,branch:target.branch}),new RegExp(`PLATFORM_HTTP_${error.status}`))
  }
  let rulesRead=false
  const github=createPlatformClients({fetchImpl:async url=>{
    if(url.includes('/protection'))return {ok:false,status:404,json:async()=>({message:'Branch not protected'})}
    if(url.includes('/rules/')){rulesRead=true;return {ok:true,status:200,json:async()=>[]}}
    return {ok:true,status:200,json:async()=>({protected:true,commit:{sha:HEAD}})}
  }}).github
  assert.deepEqual((await github.readRequiredChecks({repository:target.repository,branch:target.branch})).checks,[])
  assert.equal(rulesRead,true)
})

test('真实本地bare Git只快进，检查后base并发漂移由服务端lease原子拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uat-real-git-')), remote = join(root, 'remote.git'), source = join(root, 'source')
  const run = promisify(execFile), git = async args => (await run('git', args, {windowsHide:true})).stdout.trim()
  await git(['init','--bare',remote]); await git(['init',source])
  await git(['-C',source,'config','user.name','Fixture']);await git(['-C',source,'config','user.email','fixture@example.invalid'])
  await writeFile(join(source,'file.txt'),'base'); await git(['-C',source,'add','.']); await git(['-C',source,'commit','-m','base'])
  const base = await git(['-C',source,'rev-parse','HEAD'])
  await writeFile(join(source,'file.txt'),'candidate'); await git(['-C',source,'commit','-am','candidate'])
  const head = await git(['-C',source,'rev-parse','HEAD']), tree = await git(['-C',source,'rev-parse','HEAD^{tree}'])
  await git(['-C',source,'checkout','--detach',base]); await writeFile(join(source,'file.txt'),'concurrent'); await git(['-C',source,'commit','-am','concurrent'])
  const concurrent = await git(['-C',source,'rev-parse','HEAD']), ref='refs/heads/feature/uat1-base'
  await git(['-C',source,'push',remote,`${base}:${ref}`,`${head}:refs/heads/candidate`,`${concurrent}:refs/heads/concurrent`])
  let race=false, pushes=0
  const github=createPlatformClients({githubMergeWritesEnabled:true,githubToken:'fixture',fetchImpl:async url=>({ok:true,status:200,json:async()=>url.includes('/rules/')?[]:url.includes('/pulls/')
    ?{state:'open',draft:false,head:{sha:head,repo:{full_name:'example/fixture'}},base:{ref:'feature/uat1-base',sha:base,repo:{full_name:'example/fixture'}}}
    :{protected:false,commit:{sha:base}}}),execFileImpl:async (exe,args,options)=>{
      if(args.includes('push')) {pushes++;if(race)await git(['--git-dir',remote,'update-ref',ref,concurrent,base])}
      return run(exe,args.map(arg=>arg==='https://github.com/example/fixture.git'?remote:arg),options)
    }}).github
  const input={repository:'example/fixture',branch:'feature/uat1-base',number:1,headCommitSha:head,expectedBase:base,expectedTree:tree}
  await github.atomicFastForward(input)
  assert.equal(await git(['--git-dir',remote,'rev-parse',ref]),head)
  await git(['--git-dir',remote,'update-ref',ref,base,head]);race=true
  await assert.rejects(github.atomicFastForward(input),/UAT_ATOMIC_PUSH_UNCONFIRMED/)
  assert.equal(await git(['--git-dir',remote,'rev-parse',ref]),concurrent);assert.equal(pushes,2)
})
