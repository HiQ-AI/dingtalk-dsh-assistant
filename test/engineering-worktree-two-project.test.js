import { trackTestService } from './fixtures/owned-test-service.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import {createExecutionDelivery} from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import {createEngineeringRegistry,createEngineeringStageContract} from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
const exec=promisify(execFile)
test('shared worktrees retain durable verification across cold restart and iterative edits without source exports',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'two-repo-chain-'));let store,controller;t.after(async()=>{await controller?.close();await store?.close();await rm(dir,{recursive:true,force:true})})
 try{
 const cwdLog=join(dir,'source-cwds.jsonl')
 const git=async(root,...args)=>(await exec('git',['-C',root,...args],{windowsHide:true})).stdout.trim()
 const command=code=>({executable:process.execPath,args:['-e',code]})
 const profile=join(dir,'profile.json');await writeFile(profile,JSON.stringify({environment:'uat',env:{ISOLATED_TEST:'yes'}}))
 const inputCode="let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const input=JSON.parse(s);"
 const localAcceptance={version:'1',sharedDataProfilePath:profile,prepareSteps:[command("require('fs').appendFileSync("+JSON.stringify(cwdLog)+",JSON.stringify({phase:'acceptance',cwd:process.cwd()})+'\\n')")],service:{...command("require('node:http').createServer((req,res)=>res.end(require('node:fs').readFileSync('value.txt','utf8'))).listen(Number(process.argv[1]),process.argv[2])"),args:['-e',"require('node:http').createServer((req,res)=>res.end(require('node:fs').readFileSync('value.txt','utf8'))).listen(Number(process.argv[1]),process.argv[2])",'{port}','127.0.0.1'],readyPath:'/'},scenarios:[{id:'value',description:'Read actual local candidate service',...command(inputCode+"const actual=await(await fetch(input.baseUrl)).text();console.log(JSON.stringify({namespace:input.namespace,baseUrl:input.baseUrl,actual}));});")}],cleanup:command(inputCode+"console.log(JSON.stringify({namespace:input.namespace}));});"),verifyCleanup:command(inputCode+"console.log(JSON.stringify({namespace:input.namespace,empty:true}));});")}
 trackTestService(t,localAcceptance.service,dir)
 const configs=[],fixture={}
 for(const id of ['frontend','backend']){
  const source=join(dir,id),managedRoot=join(dir,id+'-managed'),remote=join(dir,id+'.git');await mkdir(source);await mkdir(managedRoot)
  await git(source,'init','-b','main');await git(source,'config','user.name','Test');await git(source,'config','user.email','test@example.invalid');await writeFile(join(source,'value.txt'),'old');await git(source,'add','.');await git(source,'commit','-m','base');await exec('git',['init','--bare',remote]);await git(source,'push',remote,'HEAD:refs/heads/main','HEAD:refs/heads/feature/uat3-base')
  configs.push({id,sourceRepository:source,managedRoot,remote,githubRepository:'test/'+id,baseRef:'main',editablePaths:['value.txt'],localAcceptance:{...localAcceptance,scenarios:localAcceptance.scenarios.map(scenario=>({...scenario,expected:id+'-new'}))},checks:[{id:'real-check',version:'1',...command("if((require('node:fs').appendFileSync("+JSON.stringify(cwdLog)+",JSON.stringify({phase:'build',cwd:process.cwd()})+'\\n'),require('node:fs').readFileSync('value.txt','utf8'))!=="+JSON.stringify(id+'-new')+")process.exit(1)")}]})
  fixture[id]={remote,stateFile:join(dir,id+'-pr.json')}
 }
 const fixtureFile=join(dir,'gh-fixture.json'),script=join(dir,'gh.cjs');await writeFile(fixtureFile,JSON.stringify(fixture))
 await writeFile(script,`const fs=require('fs'),cp=require('child_process'),f=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),a=process.argv.slice(3),v=k=>a[a.indexOf(k)+1],endpoint=a.find(arg=>arg.startsWith('repos/'));const repo=a[0]==='api'?endpoint.split('/')[2]:v('--repo').split('/')[1],x=f[repo],s=fs.existsSync(x.stateFile)?JSON.parse(fs.readFileSync(x.stateFile,'utf8')):null;const sha=head=>cp.execFileSync('git',['--git-dir',x.remote,'rev-parse',head],{encoding:'utf8'}).trim();if(a[0]==='api'&&endpoint.includes('/git/'))console.log(JSON.stringify({object:{sha:sha(decodeURIComponent(endpoint.split('/git/ref/heads/')[1]))}}));else if(a[0]==='api')console.log(JSON.stringify([s?[{number:s.number,html_url:s.url,state:'open',draft:true,head:{ref:s.headRefName,sha:s.headRefOid},base:{ref:s.baseRefName},body:s.body}]:[]]));else if(a[1]==='view')console.log(JSON.stringify(s));else if(a[1]==='create'||a[1]==='edit'){const head=a[1]==='create'?v('--head'):s.headRefName;const n={number:1,url:'https://github.com/test/'+repo+'/pull/1',state:'OPEN',isDraft:true,headRefOid:sha(head),headRefName:head,baseRefName:v('--base')||s?.baseRefName,body:fs.readFileSync(v('--body-file'),'utf8'),title:v('--title'),creates:(s?.creates||0)+(a[1]==='create'?1:0),edits:(s?.edits||0)+(a[1]==='edit'?1:0)};fs.writeFileSync(x.stateFile,JSON.stringify(n));console.log(n.url)}else process.exit(2)`)
 store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'two-repo',initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
 let registry=createEngineeringRegistry({repositories:configs,ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,fixtureFile]}});await registry.restore(store,artifacts)
 const visited=[]
 const sessions={async run({input,binding,applyEdits,onSessionBound,onResult}){
  await onSessionBound()
  if(input.criteria)return onResult({cases:input.criteria.map(c=>({expected:input.request+'-new'}))})
  const requirement=input.requirement??input
  visited.push(requirement.request+':'+(applyEdits?'apply':'plan'))
  if(!applyEdits)return onResult({document:{name:'approach-not-fixed.md',markdown:'Update value.txt using the existing implementation.'},notes:{revision:9}})
  const file=await registry.repositoryInspect(binding,{operation:'read',path:'value.txt'},undefined,requirement)
  const batch={changes:[{path:'value.txt',expectedHash:file.expectedHash,content:requirement.request+'-intermediate'}]}
  const receipt=await applyEdits(batch,new AbortController().signal);assert.deepEqual(await applyEdits(batch,new AbortController().signal),receipt)
  const current=await registry.repositoryInspect(binding,{operation:'read',path:'value.txt'},undefined,requirement)
  const next={changes:[{path:'value.txt',expectedHash:current.expectedHash,content:requirement.request+'-new'}]}
  const nextReceipt=await applyEdits(next,new AbortController().signal);assert.deepEqual(await applyEdits(next,new AbortController().signal),nextReceipt)
  return onResult({status:'succeeded'})
 },async cancel(){},async close(){}}
 let held=false
 const wrappedStore={query:q=>store.query(q),command:async c=>{const receipt=await store.command(c);if(!held&&c.kind==='node.commit'&&c.args.nodeId==='finalize-local-acceptance'){held=true;await store.command({id:'hold-source-cache-restart',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'source-cache-restart',actorId:'owner',reason:'Cold restart before commit'}})}return receipt}}
 controller=createExecutionController({store:wrappedStore,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:[],changeQuietMs:0,maxChangeDelayMs:0})
 const taskId='combined',requirement={request:'frontend then backend',constraints:[],acceptanceCriteria:['value updated'],scope:{taskId},target:{repositoryId:'frontend',uatEnvironment:'uat3'},authorization:{actorId:'owner',ownerConfirmed:true},sourceInstructions:[{sourceKey:'original',sourceVersion:1,actorId:'owner',text:'frontend then backend'}]}
 await store.command({id:'original-message',kind:'message.receive',args:{runId:'original-message',sourceKey:'original',sourceVersion:1,actorId:'owner',conversationId:'group',body:requirement.request,context:{},policy:{}}})
 const goal=await artifacts.put(requirement)
 await store.command({id:'accept',kind:'task.accept',args:{taskId,requirementRef:goal.ref,requirementRevision:1,sessionId:'owner-combined',criteria:requirement.acceptanceCriteria,sourceKey:'original',eventKey:'original'}})
 const first=await registry.prepareTask({taskId,arguments:{repositoryId:'frontend',uatEnvironment:'uat3',objective:'frontend',acceptanceCriteria:['value updated']}},{commandId:'front',stageRunId:controller.plannedTaskStageRunId({taskId,planRevision:1,stageId:'front',attempt:1}),run:{actorId:'owner'},unit:{}},controller)
 await controller.initializeTaskPlan({commandId:'plan',taskId,expectedRequirementRevision:1,stages:[{stageId:'front',workflowId:first.workflowId,input:first.input},{stageId:'back',workflowId:'task-engineering',sourceCondition:{repositoryId:'backend',sourceKey:'original',sourceVersion:1,sourceQuote:'frontend then backend',objective:'backend',acceptanceCriteria:['value updated']}}]})
 await controller.advanceTaskPlan(taskId);await controller.whenIdle(first.runId).catch(error=>assert.equal(error.code,'RUNTIME_MAINTENANCE_ACTIVE'))
 let state=await controller.state(first.runId);assert.equal(held,true,JSON.stringify(state));assert.equal(state.nodes.find(n=>n.nodeId==='finalize-local-acceptance').status,'succeeded')
 const beforeVerification=state.nodes.find(n=>n.nodeId==='verify-candidate'),beforeBuild=await artifacts.read(beforeVerification.outputRef)
 const finalized=await artifacts.read(state.nodes.find(n=>n.nodeId==='finalize-local-acceptance').outputRef)
 const buildCount=()=>readFile(cwdLog,'utf8').then(text=>text.trim().split('\n').map(line=>JSON.parse(line)).filter(x=>x.phase==='build').length)
 assert.equal(await buildCount(),1)
 await controller.close()
 const rejectedStore={command:c=>store.command(c),query:async q=>{const value=await store.query(q);return q.kind==='run'&&q.runId===first.runId?{...value,nodes:value.nodes.map(n=>n.nodeId==='verify-candidate'?{...n,status:'waiting'}:n)}:value}}
 const untrusted=createEngineeringRegistry({repositories:configs,ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,fixtureFile]}})
 const untrustedWorkflows=await untrusted.restore(rejectedStore,artifacts),untrustedCommit=untrustedWorkflows.find(w=>w.id===state.run.workflowId).nodes.find(n=>n.id==='prepare-commit')
 await assert.rejects(untrustedCommit.execute({input:{...finalized,verification:{passed:true},currentRequest:'frontend'}}),{code:'CANDIDATE_VERIFICATION_UNTRUSTED'})
 const commit=controller.workflowDefinition(state.run.workflowId,state.run.workflowDigest).nodes.find(n=>n.id==='prepare-commit')
 const beforeBytes=await readFile(join(beforeBuild.candidate.repository,'value.txt'));await writeFile(join(beforeBuild.candidate.repository,'value.txt'),'tampered')
 await assert.rejects(commit.execute({input:{...finalized,currentRequest:'frontend'}}),{code:'CANDIDATE_WORKTREE_CHANGED'});await writeFile(join(beforeBuild.candidate.repository,'value.txt'),beforeBytes)
 await store.close();store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'two-repo',initialize:false})
 registry=createEngineeringRegistry({repositories:configs,ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,fixtureFile]}})
 const cold=await registry.restore(store,artifacts)
 controller=createExecutionController({store,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:cold})
 await store.command({id:'resume-source-cache-restart',kind:'runtime.maintenance.change',args:{active:false,expectedRevision:1,maintenanceId:'source-cache-restart',actorId:'owner',reason:'Submit with durable success evidence'}})
 await controller.recover({commandId:'continue-durable-source',runId:first.runId});state=await controller.whenIdle(first.runId);assert.equal(state.run.status,'succeeded',JSON.stringify(state))
 assert.equal(state.nodes.find(n=>n.nodeId==='verify-candidate').outputRef,beforeVerification.outputRef);assert.equal(await buildCount(),1)
 await controller.advanceTaskPlan(taskId)

 let plan=await controller.taskPlan(taskId);assert.equal(plan.stages[0].status,'succeeded');assert.equal(plan.stages[1].runId,null)
 const contract=createEngineeringStageContract({engineering:registry,controller,mayCreate:async()=>true,readTaskEvidence:async()=>[]})
 const second=await contract.prepare({taskId,stage:plan.stages[1],plan,requirement,origin:{run:{actorId:'owner'},command:{args:{arguments:requirement.target}}}})
 await controller.bindTaskStageInput({commandId:'bind-back',taskId,planRevision:1,stageId:'back',predecessorOutputRef:plan.stages[0].outputRef,input:second.input,workflowId:second.workflowId})
 await controller.advanceTaskPlan(taskId);state=await controller.whenIdle(second.runId);assert.equal(state.run.status,'succeeded',JSON.stringify(state));await controller.advanceTaskPlan(taskId)
 plan=await controller.taskPlan(taskId);assert.ok(plan.stages.every(stage=>stage.status==='succeeded'))
 const results=await Promise.all(plan.stages.map(stage=>artifacts.read(stage.outputRef)));assert.equal(results.length,2);assert.ok(results.every(result=>result.commitId&&result.url))
 const beforeEffects=await Promise.all(plan.stages.map(stage=>store.query({kind:'effect.list',runId:stage.runId})))
 await controller.advanceTaskPlan(taskId);await controller.advanceTaskPlan(taskId)
 assert.deepEqual(await Promise.all(plan.stages.map(stage=>store.query({kind:'effect.list',runId:stage.runId}))),beforeEffects)
 await controller.close();await store.close()
 store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'two-repo',initialize:false})
 const restarted=createEngineeringRegistry({repositories:configs,ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,fixtureFile]}})
 const restored=await restarted.restore(store,artifacts)
 controller=createExecutionController({store,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...restarted.deliveryOptions}),workflows:restored})
 await controller.advanceTaskPlan(taskId)
 assert.deepEqual(await Promise.all(plan.stages.map(stage=>store.query({kind:'effect.list',runId:stage.runId}))),beforeEffects)

 const cwdRecords=(await readFile(cwdLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 for(const stage of plan.stages){const actual=await store.query({kind:'run',runId:stage.runId}),workspace=await artifacts.read(actual.nodes.find(n=>n.nodeId==='prepare-workspace').outputRef),build=await artifacts.read(actual.nodes.find(n=>n.nodeId==='verify-candidate').outputRef),local=await artifacts.read(actual.nodes.find(n=>n.nodeId==='prepare-local-acceptance').outputRef);assert.equal(build.candidate.repository,workspace.workspace.directory);assert.equal(JSON.parse(build.verification.checks[0].log).directory,workspace.workspace.directory);assert.equal(local.localPrepared.directory,workspace.workspace.directory);assert.equal(cwdRecords.filter(r=>r.phase==='build'&&r.cwd===workspace.workspace.directory).length,1);assert.equal(cwdRecords.filter(r=>r.phase==='acceptance'&&r.cwd===workspace.workspace.directory).length,1);assert.equal((await store.query({kind:'effect.list',runId:stage.runId})).filter(e=>e.definition.action==='edit').length,2)}
 assert.deepEqual(visited,['frontend:plan','frontend:apply','backend:plan','backend:apply'])
 for(const id of ['frontend','backend']){const pr=JSON.parse(await readFile(fixture[id].stateFile,'utf8'));assert.equal(pr.creates,1);assert.equal(pr.isDraft,true);assert.equal(await git(fixture[id].remote,'show',pr.headRefOid+':value.txt'),id+'-new');assert.equal(await readFile(join(dir,id,'value.txt'),'utf8'),'old')}
 }catch(error){process.stderr.write(String(error.stack)+'\n');throw error}
})
