import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {executionDigest,openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {inspectDevelopmentBranch,selectDevelopmentBaseline,resolveDevelopmentSource,readDevelopmentSnapshot} from '../packages/dingtalk-dsh-assistant/execution-development-branch.js'
import {createEngineeringRegistry,readEngineeringDeliveryProof} from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import {createEngineeringUatBaselineWorkflow} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import {createManagedWorkspaces} from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {createExecutionController,defineExecutionWorkflow} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import {createExecutionDelivery} from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
const exec=promisify(execFile)
const root=resolve('.test-runs');await mkdir(root,{recursive:true});process.env.TEMP=root;process.env.TMP=root
const git=async(repository,...args)=>(await exec('git',['-C',repository,...args],{windowsHide:true,maxBuffer:32*1024*1024})).stdout.trim()
async function fixture(){
 const directory=await mkdtemp(join(root,'purity-')),repository=join(directory,'repo'),remote=join(directory,'remote.git');await mkdir(repository)
 const g=(...args)=>git(repository,...args)
 await g('init','-b','trunk');await g('config','user.name','Synthetic');await g('config','user.email','test@example.invalid')
 await writeFile(join(repository,'shared.txt'),'source\n');await g('add','.');await g('commit','-m','source');const sourceCommit=await g('rev-parse','HEAD')
 await g('init','--bare',remote);await git(remote,'symbolic-ref','HEAD','refs/heads/trunk');await g('push',remote,'trunk')
 await g('checkout','-b','feature/uat2-base');await writeFile(join(repository,'uat-only.txt'),'unrelated target\n');await g('add','.');await g('commit','-m','unrelated target');const targetCommit=await g('rev-parse','HEAD');await g('push',remote,'feature/uat2-base')
 await g('checkout','-b','dev',sourceCommit);await writeFile(join(repository,'feature.txt'),'whole feature\n');await writeFile(join(repository,'shared.txt'),'source\nrequired dependency\n');await g('add','.');await g('commit','-m','feature');const headCommit=await g('rev-parse','HEAD')
 return {directory,repository,remote,g,sourceCommit,targetCommit,headCommit}
}
async function configuration(f,baseRef){
 const worker=join(f.directory,'acceptance.cjs');await writeFile(worker,`const fs=require('fs'),http=require('http');const mode=process.argv[2];if(mode==='serve'){http.createServer((q,r)=>r.end('ok')).listen(Number(process.argv[3]),'127.0.0.1')}else{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const c=JSON.parse(s);console.log(JSON.stringify(mode==='case'?{namespace:c.namespace,baseUrl:c.baseUrl,actual:'verified'}:{namespace:c.namespace,cleaned:true,empty:true,mode:'read-only',createdResources:0}))})}`)
 const profile=join(f.directory,'profile.json');await writeFile(profile,JSON.stringify({environment:'uat',env:{SYNTHETIC_SCOPE:'isolated-scope-not-output'}}))
 const gh=join(f.directory,'gh.cjs');await writeFile(gh,`const fs=require('fs'),path=require('path'),cp=require('child_process');const a=process.argv.slice(2),state=path.join(__dirname,'synthetic-pr.json');const opt=k=>a[a.indexOf(k)+1];const row=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):null;if(row){const r=cp.spawnSync('git',['rev-parse','refs/heads/'+row.headRefName],{encoding:'utf8'});if(r.status===0){row.headRefOid=r.stdout.trim();fs.writeFileSync(state,JSON.stringify(row))}}if(a[0]==='api'&&a.some(x=>x.includes('/pulls?')))console.log(JSON.stringify([row?[{number:1,html_url:row.url,state:'open',body:row.body,head:{ref:row.headRefName,sha:row.headRefOid},base:{ref:row.baseRefName}}]:[]]));else if(a[0]==='api'&&a[1].includes('/git/ref/heads/')){const head=decodeURIComponent(a[1].split('/git/ref/heads/')[1]);const sha=cp.execFileSync('git',['rev-parse','refs/heads/'+head],{encoding:'utf8'}).trim();console.log(JSON.stringify({object:{sha}}))}else if(a[0]==='pr'&&a[1]==='create'){const head=opt('--head'),sha=cp.execFileSync('git',['rev-parse','refs/heads/'+head],{encoding:'utf8'}).trim();fs.writeFileSync(state,JSON.stringify({number:1,url:'https://github.com/'+opt('--repo')+'/pull/1',state:'OPEN',isDraft:false,headRefOid:sha,headRefName:head,baseRefName:opt('--base'),body:fs.readFileSync(opt('--body-file'),'utf8')}));console.log('https://github.com/'+opt('--repo')+'/pull/1')}else if(a[0]==='pr'&&a[1]==='edit'){row.body=fs.readFileSync(opt('--body-file'),'utf8');row.headRefOid=cp.execFileSync('git',['rev-parse','refs/heads/'+row.headRefName],{encoding:'utf8'}).trim();if(a.includes('--base'))row.baseRefName=opt('--base');fs.writeFileSync(state,JSON.stringify(row))}else if(a[0]==='pr'&&a[1]==='view')console.log(JSON.stringify(row));else {console.error('unexpected synthetic CLI '+a.join(' '));process.exit(1)}`)

 return {ownerActorId:'owner',modelConfig:()=>({provider:'synthetic',model:'synthetic'}),author:{name:'Synthetic',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[gh]},repositories:[{id:'arbitrary',sourceRepository:f.repository,managedRoot:join(f.directory,'managed'),remote:f.remote,githubRepository:'example/arbitrary',...(baseRef?{baseRef}:{}),discovery:{allowedPrefixes:['']},checks:[{id:'feature',version:'1',executable:process.execPath,args:['-e',`const fs=require('fs');if(fs.existsSync('uat-only.txt')||fs.readFileSync('feature.txt','utf8')!=='whole feature\\n')process.exit(1)`]}],localAcceptance:{version:'synthetic',sharedDataProfilePath:profile,prepareSteps:[],service:{executable:process.execPath,args:[worker,'serve','{port}','--host','127.0.0.1'],readyPath:'/'},scenarios:[{id:'feature',expected:'verified',description:'isolated code acceptance',executable:process.execPath,args:[worker,'case']}],cleanup:{executable:process.execPath,args:[worker,'cleanup']},verifyCleanup:{executable:process.execPath,args:[worker,'cleanup']}}}]}
}
test('actual remote default and explicit non-main/UAT-named source resolve without hardcoded main',async()=>{
 const f=await fixture();assert.deepEqual(await resolveDevelopmentSource({repository:f.repository,remote:f.remote}),{ref:'refs/heads/trunk',commit:f.sourceCommit})
 assert.equal((await resolveDevelopmentSource({repository:f.repository,remote:f.remote,baseRef:'refs/heads/dev'})).commit,f.headCommit)
 assert.equal((await resolveDevelopmentSource({repository:f.repository,remote:f.remote,baseRef:'refs/heads/feature/uat2-base'})).commit,f.targetCommit)
})
test('ordinary complete feature/shared increment is retained without assessor or mandatory verdict metadata',async()=>{
 const f=await fixture();const selected=await selectDevelopmentBaseline({...f,existingBranch:'dev',newBranch:'fresh'})
 assert.equal(selected.disposition,'reused');assert.equal(selected.head,'dev');assert.equal(selected.baseCommit,f.headCommit)
 assert.match(selected.evidence.diff,/required dependency/);assert.match(selected.evidence.diff,/feature.txt/);assert.equal(selected.evidence.commits.length,1)
})
test('known merge pollution rebuilds at source while preserving local and remote old branch',async()=>{
 const f=await fixture();await f.g('merge','--no-ff','feature/uat2-base','-m','old integration');f.headCommit=await f.g('rev-parse','HEAD');await f.g('push',f.remote,'dev')
 const selected=await selectDevelopmentBaseline({...f,existingBranch:'dev',newBranch:'fresh'});assert.equal(selected.disposition,'rebuilt');assert.equal(selected.baseCommit,f.sourceCommit)
 assert.match(selected.evidence.diff,/uat-only.txt/);assert.equal(selected.retiredHead,'dev');assert.equal(await f.g('rev-parse','dev'),f.headCommit);assert.equal(await git(f.remote,'rev-parse','dev'),f.headCommit)
})
test('historical UAT workflow still uses its original merge semantics, source-only bypasses them',async()=>{
 const f=await fixture();const managed=join(f.directory,'work');await mkdir(managed);const adapter=await createManagedWorkspaces({root:managed,sourceRepository:f.repository})
 const options={provider:'synthetic',model:'synthetic',adapterIdentity:'fixture',workspaceAdapter:adapter,editAdapter:{},checks:[{id:'content',version:'1',run:async()=>({passed:true,log:'ok'})}],project:{targetCommit:f.targetCommit,taskBase:f.sourceCommit}}
 const originalText=(await exec('git',['-c','safe.directory='+resolve('.'),'show','HEAD:packages/dingtalk-dsh-assistant/task-workflow.js'],{windowsHide:true,maxBuffer:32*1024*1024})).stdout.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../packages/dingtalk-dsh-assistant/'+path.slice(2),import.meta.url).href}'`)
 const original=await import('data:text/javascript;base64,'+Buffer.from(originalText).toString('base64'))
 assert.equal(defineExecutionWorkflow(createEngineeringUatBaselineWorkflow(options)).digest,defineExecutionWorkflow(original.createEngineeringUatBaselineWorkflow(options)).digest)
 const context={input:{request:'whole feature',constraints:[],editablePaths:['feature.txt'],baseCommit:f.headCommit},runId:'factory',generation:1,requirementDigest:'a'.repeat(64),perform:async({prepared})=>adapter.execute(prepared)}
 await assert.rejects(createEngineeringUatBaselineWorkflow(options).nodes.find(n=>n.id==='prepare-workspace').execute(context),{code:'ENGINEERING_UAT_BASELINE_MISMATCH'})
 await createEngineeringUatBaselineWorkflow({...options,project:{...options.project,developmentMode:'source-only'}}).nodes.find(n=>n.id==='prepare-workspace').execute(context)
})

async function endToEnd(t,{polluted,remoteBranch,explicitSource,localAhead,analysisPollution,reissue,staged,requestSource,interrupt,crossReuse}={}){
 let f=await fixture();if(explicitSource)await f.g('push',f.remote,'dev');const original=f,destination=reissue==='cross'?await fixture():null;const config=await configuration(f,explicitSource?'refs/heads/dev':requestSource?'refs/heads/trunk':undefined);if(destination){const other=await configuration(destination);other.repositories[0].id='other';other.repositories[0].githubRepository='example/other';config.repositories.push(other.repositories[0])};const rawStore=await openExecutionStore({dbPath:join(f.directory,'isolated.sqlite'),instanceId:'isolated-purity',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(f.directory,'artifacts'),initialize:true})
 let interrupted=false;const store=interrupt?{...rawStore,command:async command=>{if(!interrupted&&command.kind==='run.workflow.reissue-repository'){interrupted=true;throw Object.assign(new Error('synthetic interruption before migration commit'),{code:'ETIMEDOUT'})};return rawStore.command(command)}}:rawStore
 t.after(async()=>{await controller?.close();await store.close()});const registry=createEngineeringRegistry(config);await registry.restore(store,artifacts)
 let controller,currentRunId,seen=[],outputs={},preparedPr
 const delivery=createExecutionDelivery({store,artifacts,...registry.deliveryOptions})
 const sessions={async run({binding,input,definition,onSessionBound,onResult,applyEdits}){
  seen.push(binding.nodeId);await onSessionBound();let output
  if(binding.nodeId==='plan-local-acceptance')output={cases:input.criteria.map(c=>({criterionId:c.id,scenarioId:'feature',parameters:{},steps:['read candidate'],expected:'verified'}))}
  else if(binding.nodeId==='inspect-and-propose'){
   assert.match(definition.prompt,/complete source-to-head diff/);assert(!definition.prompt.includes('evidenceDigest'))
   assert.equal(input.developmentBranch.disposition,analysisPollution&&binding.generation===2?'rebuilt':reissue&&binding.generation===2?(crossReuse?'reused':'created'):polluted?'rebuilt':remoteBranch?'reused':'created')
   if(polluted||remoteBranch){assert.match(input.developmentBranch.evidence.diff,/feature.txt/);assert.match(input.developmentBranch.evidence.diff,/required dependency/)}
   let read;try{read=await registry.repositoryInspect(binding,{operation:'read',path:'shared.txt'},new AbortController().signal,input)}catch(e){console.error('ANALYSIS TOOL',e.stack);throw e};assert.match(read.text,/source/)
   if(polluted||analysisPollution&&binding.generation===2){const retired=await registry.repositoryInspect(binding,{operation:'read',path:'shared.txt',source:'retired'},new AbortController().signal,input);assert.match(retired.text,/required dependency/);const feature=await registry.repositoryInspect(binding,{operation:'read',path:'feature.txt',source:'retired'},new AbortController().signal,input);assert.equal(feature.text,'whole feature\n')}
   output={document:{markdown:'Whole feature and necessary shared helper; remove unrelated target increments.'}}
   if(analysisPollution){assert.match(input.developmentBranch.evidence.diff,/unrelated-function.txt/);if(binding.generation===1){output.developmentBranchAction='rebuild'}else{assert(input.previousApproach.analysisRef);assert.equal(input.developmentBranch.sourceCommit,original.sourceCommit)}}
  } else if(binding.nodeId==='apply-changes'){
   if(reissue&&binding.generation===1&&binding.runId===currentRunId)throw Object.assign(new Error('synthetic pre-edit repository mismatch'),{code:'ENGINEERING_EDIT_SCOPE_MISMATCH'})
   const requirement=input.requirement;const signal=new AbortController().signal
   const existing=await registry.repositoryInspect(binding,{operation:'list'},signal,requirement)
   const changes=[]
   for(const [path,content] of [['feature.txt','whole feature\n'],['shared.txt','source\nrequired dependency\n']]){
    const read=existing.paths.includes(path)?await registry.repositoryInspect(binding,{operation:'read',path},signal,requirement):null
    if(read?.text!==content)changes.push({path,expectedHash:read?.expectedHash??null,content})
   }
   // Ensure a real managed edit even for an already valid complete feature.
   const marker=existing.paths.includes('verification.txt')?await registry.repositoryInspect(binding,{operation:'read',path:'verification.txt'},signal,requirement):null
   changes.push({path:'verification.txt',expectedHash:marker?.expectedHash??null,content:'same rebuilt identity generation '+binding.generation+'\n'})
   await applyEdits({changes,replacements:[]},signal);output={status:'succeeded',summary:'Migrated whole feature with shared dependency'}
  }else throw Error('Unexpected new Agent role '+binding.nodeId)
  await onResult(output);return {status:'submitted'}
 },async close(){},async cancel(){},async assertDrained(){}}
 controller=createExecutionController({store,artifacts,sessions,delivery,workflows:[],readTools:['engineering_repo_inspect']})
 const action={taskId:'task-fixture',arguments:{repositoryId:'arbitrary',uatEnvironment:'uat2',objective:'whole feature with required shared helper',...(requestSource?{developmentSourceRef:'refs/heads/dev'}:{})}}
 const prepare=commandId=>registry.prepareTask(action,{commandId,run:{actorId:'owner'},unit:{}},controller)
 if(polluted||remoteBranch){
  const seed=await prepare('seed');const old=(await store.query({kind:'workflow.list'})).find(r=>r.config.runId===seed.runId)
  await f.g('branch',old.config.head,f.headCommit)
  if(polluted){await f.g('checkout',old.config.head);await f.g('merge','--no-ff','feature/uat2-base','-m','polluted prior target');f.headCommit=await f.g('rev-parse','HEAD')}
  if(analysisPollution){await f.g('checkout',old.config.head);await writeFile(join(f.repository,'unrelated-function.txt'),'unrelated feature linear increment\n');await f.g('add','.');await f.g('commit','-m','other feature');f.headCommit=await f.g('rev-parse','HEAD')}
  if(remoteBranch||polluted)await f.g('push',f.remote,old.config.head)
  if(localAhead){await f.g('checkout',old.config.head);await writeFile(join(f.repository,'local-only.txt'),'local ahead\n');await f.g('add','.');await f.g('commit','-m','local ahead');f.headCommit=await f.g('rev-parse','HEAD')}
 }
 const remoteExpected=remoteBranch?await git(f.remote,'rev-parse',(await store.query({kind:'workflow.list'}))[0].config.head):undefined
 if(crossReuse){
  const seedOther=await registry.prepareTask({...action,arguments:{...action.arguments,repositoryId:'other'}},{commandId:'seed-other',run:{actorId:'owner'},unit:{}},controller)
  await controller.createRun({commandId:'seed-other-start',...seedOther});const seeded=await controller.whenIdle(seedOther.runId);assert.equal(seeded.run.status,'succeeded')
  const commitNode=seeded.nodes.find(n=>n.nodeId==='commit');destination.headCommit=(await artifacts.read(commitNode.outputRef)).prepared.commitId;seen.length=0
 }
 const task=await prepare('current');currentRunId=task.runId;let record=(await store.query({kind:'workflow.list'})).find(r=>r.config.runId===task.runId)
 assert.equal(record.config.input.baseCommit,polluted?f.sourceCommit:remoteBranch||explicitSource||requestSource?f.headCommit:f.sourceCommit)
 assert.equal(record.config.taskBase,explicitSource||requestSource?f.headCommit:f.sourceCommit)
 assert.equal(record.config.branchSource?.expectedRemoteSha,polluted||!remoteBranch?undefined:remoteExpected)
 if(staged)await controller.createTaskPlan({commandId:'plan',taskId:task.taskId,stages:[{stageId:'engineering',workflowId:task.workflowId,input:task.input}]})
 await controller.createRun({commandId:'start',...task,...(staged?{stageBinding:{planRevision:1,stageId:'engineering',attempt:1,expectedControlRevision:1}}:{})});let state=await controller.whenIdle(task.runId)
 let oldWorkspace
 if(interrupt){assert(interrupted);assert.equal(state.run.status,'waiting');assert.equal(state.run.generation,1);assert.equal((await controller.state(task.runId)).controllerError,'ETIMEDOUT');await controller.close();const restoredWorkflows=await registry.restore(store,artifacts);controller=createExecutionController({store,artifacts,sessions,delivery,workflows:restoredWorkflows,readTools:['engineering_repo_inspect']});await controller.recover({commandId:'resume-rebuild',runId:task.runId});state=await controller.whenIdle(task.runId)}
 if(reissue){
  assert.equal(state.run.status,'waiting');assert(state.nodes.every(n=>n.drained));oldWorkspace=(await artifacts.read(state.nodes.find(n=>n.nodeId==='prepare-workspace').outputRef)).workspace.directory
  if(destination)f=destination
  const result=await registry.reissueTask({taskId:task.taskId,runId:task.runId,repositoryId:destination?'other':'arbitrary',requestId:'fixture-reissue',...(reissue==='explicit'?{developmentSourceRef:'refs/heads/dev'}:{})},controller,artifacts)
  assert.equal(result.runId,task.runId);assert.equal(result.generation,2);state=await controller.whenIdle(task.runId)
 }
 record=(await store.query({kind:'workflow.list'})).find(r=>r.digest===state.run.workflowDigest)
 if(analysisPollution||reissue){assert.equal(state.run.generation,2);assert.equal(record.config.sourceCommit,reissue==='explicit'?f.headCommit:f.sourceCommit);assert.equal(record.config.input.baseCommit,crossReuse?f.headCommit:record.config.sourceCommit);if(crossReuse){assert.equal(record.config.branchSource.expectedRemoteSha,f.headCommit);assert.equal(record.config.previousPullRequest.repo,'example/other');assert.equal(record.config.previousPullRequest.number,1)}else{assert.equal(record.config.branchSource,undefined);assert.equal(record.config.previousPullRequest,undefined)}}
 if(analysisPollution){assert.equal(await original.g('rev-parse',record.config.branchSelection.retiredHead),original.headCommit);assert.equal(await git(original.remote,'rev-parse',record.config.branchSelection.retiredHead),original.headCommit)}

 // A real production controller invokes both existing analysis and managed edit Agent sessions.
 assert.equal(state.run.status,'succeeded',JSON.stringify({run:state.run,nodes:state.nodes.map(n=>({id:n.nodeId,status:n.status,wait:n.waitReason})),error:state.controllerError}))
 for(const node of state.nodes)if(node.outputRef)outputs[node.nodeId]=await artifacts.read(node.outputRef)
 const restored=createEngineeringRegistry(config);const workflows=await restored.restore(store,artifacts);assert(workflows.some(w=>defineExecutionWorkflow(w).digest===record.digest))
 const candidate=outputs['verify-candidate'].candidate,commit=outputs.commit.prepared,push=outputs.push.prepared
 assert.equal(candidate.repository,outputs['prepare-workspace'].workspace.directory);assert.equal(candidate.baseCommit,record.config.input.baseCommit)
 assert.equal(commit.ref,'refs/heads/'+record.config.head);assert.equal(push.ref,'refs/heads/'+record.config.head);assert.equal(push.expectedRemoteSha,crossReuse?f.headCommit:analysisPollution||reissue||polluted||!remoteBranch?null:remoteExpected)
 assert.equal(await git(candidate.repository,'show','--format=%P','--no-patch',commit.commitId),record.config.input.baseCommit);assert.equal(commit.mergeParent,undefined)
 assert.equal(await git(f.remote,'rev-parse','refs/heads/'+record.config.head),commit.commitId)
 preparedPr=outputs['prepare-pr'];assert.equal(preparedPr.head,record.config.head);assert.equal(preparedPr.base,'feature/uat2-base');assert.equal(preparedPr.commitId,commit.commitId)
 const diff=await inspectDevelopmentBranch({repository:candidate.repository,sourceCommit:record.config.sourceCommit,headCommit:commit.commitId});assert.doesNotMatch(diff.diff,/uat-only.txt/);assert.match(await git(candidate.repository,'show',commit.commitId+':shared.txt'),/required dependency/);if(!explicitSource&&!requestSource&&reissue!=='explicit')assert.match(diff.diff,/required dependency/);assert.doesNotMatch(diff.diff,/unrelated-function.txt/)
 if(polluted){const old=record.config.branchSelection.retiredHead;assert.equal(await f.g('rev-parse',old),f.headCommit);assert.equal(await git(f.remote,'rev-parse',old),f.headCommit);assert(!record.config.previousPullRequest)}
 if(staged){const plan=await controller.taskPlan(task.taskId),stage=plan.stages.find(s=>s.stageId==='engineering');assert.equal(stage.workflowDigest,state.run.workflowDigest);assert.equal(stage.workflowId,state.run.workflowId);assert.equal(stage.requirementRef,state.run.requirementRef);assert.equal(stage.runId,task.runId)}
 const proof=await readEngineeringDeliveryProof({state,artifacts,store,taskId:task.taskId});assert.equal(proof.commitSha,commit.commitId);assert.equal(proof.pullRequest.head,record.config.head)
 if(analysisPollution)assert.deepEqual(seen,['inspect-and-propose','plan-local-acceptance','inspect-and-propose','apply-changes'])
 else if(reissue)assert.deepEqual(seen,['inspect-and-propose','apply-changes','plan-local-acceptance','inspect-and-propose','apply-changes'])
 else assert.deepEqual(seen,['inspect-and-propose','apply-changes'])
 if(oldWorkspace)assert.notEqual(candidate.repository,oldWorkspace)
 if(analysisPollution){assert.equal(candidate.generation,2);assert(candidate.repository.includes('ws-'));assert(!candidate.repository.includes('ws-'+executionDigest({runId:task.runId,generation:1})));assert.equal(record.config.branchRebuild.fromGeneration,1)}
 if(destination){assert.equal(record.config.repoId,'other');assert.equal(record.config.stageContract.repositoryId,'other');assert.equal(commit.remote,destination.remote);assert.equal(preparedPr.repo,'example/other');assert.equal(await original.g('rev-parse','dev'),original.headCommit)}

 await writeFile(join(f.directory,'evidence.json'),JSON.stringify({source:record.config.sourceCommit,base:candidate.baseCommit,head:record.config.head,candidate:candidate.digest,commit:commit.commitId,push:push.ref,prHead:preparedPr.head,prBase:preparedPr.base,agentRoles:seen,polluted,explicitSource,analysisPollution,reissue,crossReuse},null,2))
 return {f,store,registry,controller,record}
}
test('rebuilt polluted branch: existing Agent -> actual edit/check/commit/push/PR identity end to end',t=>endToEnd(t,{polluted:true}))
test('remote complete feature reuses development head with full diff in existing Agent',t=>endToEnd(t,{remoteBranch:true}))
test('explicit non-main source flows through workspace/candidate/commit identity',t=>endToEnd(t,{explicitSource:true}))

test('local development head ahead of remote retains complete work and remote lease',t=>endToEnd(t,{remoteBranch:true,localAhead:true}))

test('unrelated explicit source history rebuilds without discarding old development head',async()=>{
 const f=await fixture();await f.g('checkout','--orphan','different-source');await f.g('add','.');await f.g('commit','-m','different source root');const sourceCommit=await f.g('rev-parse','HEAD')
 const selected=await selectDevelopmentBaseline({...f,sourceCommit,existingBranch:'dev',newBranch:'fresh'})
 assert.equal(selected.disposition,'rebuilt');assert.equal(selected.baseCommit,sourceCommit);assert.equal(selected.evidence.sourceAncestor,false);assert.equal(await f.g('rev-parse','dev'),f.headCommit)
})
test('linear other-feature pollution: existing analysis rebuilds same Run into fresh source workspace and PR',t=>endToEnd(t,{remoteBranch:true,analysisPollution:true}))
test('reissue explicit source wins and rebinds candidate/head/remote/PR through actual Controller',t=>endToEnd(t,{reissue:'explicit'}))
test('reissue omitted source resolves real remote default through actual Controller',t=>endToEnd(t,{reissue:'default'}))
test('reissue cross repository resets each source/workspace/head/remote/PR identity',t=>endToEnd(t,{reissue:'cross'}))

test('stage-bound analysis rebuild keeps current stage and same Run binding',t=>endToEnd(t,{remoteBranch:true,analysisPollution:true,staged:true}))
test('stage-bound cross repository reissue keeps stage/workflow/requirement identity',t=>endToEnd(t,{reissue:'cross',staged:true}))

test('request explicit source overrides configured source through production Controller',t=>endToEnd(t,{requestSource:true}))
test('analysis rebuild interrupted before migration resumes from persisted decision with fresh generation',t=>endToEnd(t,{remoteBranch:true,analysisPollution:true,interrupt:true}))

test('cross repository reissue reuses destination development head and its real registered PR binding',t=>endToEnd(t,{reissue:'cross',crossReuse:true}))

test('retired tree snapshot preserves exact bytes despite dirty source files and leaves checkout untouched',async()=>{
 const f=await fixture();await writeFile(join(f.repository,'shared.txt'),'dirty source should never migrate\n');const before=await f.g('status','--porcelain')
 const snapshot=await readDevelopmentSnapshot({repository:f.repository,headCommit:f.headCommit});assert(snapshot.files.some(file=>file.path==='feature.txt'))
 assert.equal((await snapshot.readFile('shared.txt')).toString('utf8'),'source\nrequired dependency\n');assert.equal(await f.g('status','--porcelain'),before)
 await assert.rejects(snapshot.readFile('absent.txt'),{code:'ENGINEERING_READ_PATH_INVALID'})
})
