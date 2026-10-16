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
test('v25 actual reset preserves pending source; own commit cold-restores without redoing prefix and rejects foreign drift',async t=>{
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
 for(const id of ['frontend']){
  const source=join(dir,id),managedRoot=join(dir,id+'-managed'),remote=join(dir,id+'.git');await mkdir(source);await mkdir(managedRoot)
  await git(source,'init','-b','main');await git(source,'config','user.name','Test');await git(source,'config','user.email','test@example.invalid');await writeFile(join(source,'value.txt'),'old');await git(source,'add','.');await git(source,'commit','-m','base');await exec('git',['init','--bare',remote]);await git(source,'push',remote,'HEAD:refs/heads/feature/uat3-base','HEAD:refs/heads/main');await git(remote,'symbolic-ref','HEAD','refs/heads/main')
  configs.push({id,managedRoot,remote,githubRepository:'test/'+id,editablePaths:['value.txt','pending-note.txt','pending-staged.txt','supplement.txt','supplement-staged.txt'],localAcceptance:{...localAcceptance,scenarios:localAcceptance.scenarios.map(s=>({...s,expected:id+'-new'}))},checks:[{id:'real-check',version:'1',...command("if((require('node:fs').appendFileSync("+JSON.stringify(cwdLog)+",JSON.stringify({phase:'build',cwd:process.cwd()})+'\\n'),require('node:fs').readFileSync('value.txt','utf8'))!=="+JSON.stringify(id+'-new')+")process.exit(1)")}]})
  fixture[id]={remote,stateFile:join(dir,id+'-pr.json')}
 }
 const fixtureFile=join(dir,'gh-fixture.json'),script=join(dir,'gh.cjs');await writeFile(fixtureFile,JSON.stringify(fixture))
 await writeFile(script,`const fs=require('fs'),cp=require('child_process'),f=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),a=process.argv.slice(3),v=k=>a[a.indexOf(k)+1],endpoint=a.find(arg=>arg.startsWith('repos/'));const repo=a[0]==='api'?endpoint.split('/')[2]:v('--repo').split('/')[1],x=f[repo],s=fs.existsSync(x.stateFile)?JSON.parse(fs.readFileSync(x.stateFile,'utf8')):null;const sha=head=>cp.execFileSync('git',['--git-dir',x.remote,'rev-parse',head],{encoding:'utf8'}).trim();if(a[0]==='api'&&endpoint.includes('/git/'))console.log(JSON.stringify({object:{sha:sha(decodeURIComponent(endpoint.split('/git/ref/heads/')[1]))}}));else if(a[0]==='api')console.log(JSON.stringify([s?[{number:s.number,html_url:s.url,state:'open',draft:true,head:{ref:s.headRefName,sha:s.headRefOid},base:{ref:s.baseRefName},body:s.body}]:[]]));else if(a[1]==='view')console.log(JSON.stringify(s));else if(a[1]==='create'||a[1]==='edit'){const head=a[1]==='create'?v('--head'):s.headRefName;const n={number:1,url:'https://github.com/test/'+repo+'/pull/1',state:'OPEN',isDraft:true,headRefOid:sha(head),headRefName:head,baseRefName:v('--base')||s?.baseRefName,body:fs.readFileSync(v('--body-file'),'utf8'),title:v('--title'),creates:(s?.creates||0)+(a[1]==='create'?1:0),edits:(s?.edits||0)+(a[1]==='edit'?1:0)};fs.writeFileSync(x.stateFile,JSON.stringify(n));console.log(n.url)}else process.exit(2)`)
 store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'two-repo',initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true,taskWorkspaceRoot:join(dir,'task-files'),getTaskDirectories:async taskId=>({logicalTaskId:taskId})})
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
 let held=false,resetting=false,resetHeld=false
 const wrappedStore={query:q=>store.query(q),command:async c=>{const receipt=await store.command(c);if(!held&&c.kind==='node.commit'&&c.args.nodeId==='prepare-workspace'){held=true;await store.command({id:'hold-source-cache-restart',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'source-cache-restart',actorId:'owner',reason:'Cold restart before commit'}})}if(resetting&&!resetHeld&&c.kind==='node.commit'&&c.args.nodeId==='commit'){resetHeld=true;await store.command({id:'hold-reset-workspace',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:2,maintenanceId:'reset-workspace',actorId:'owner',reason:'Inspect reset source without running development'}})}return receipt}}
 controller=createExecutionController({store:wrappedStore,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:[],changeQuietMs:0,maxChangeDelayMs:0})
 const taskId='combined',requirement={request:'frontend then backend',constraints:[],acceptanceCriteria:['value updated'],scope:{taskId},target:{repositoryId:'frontend',uatEnvironment:'uat3'},authorization:{actorId:'owner',ownerConfirmed:true},sourceInstructions:[{sourceKey:'original',sourceVersion:1,actorId:'owner',text:'frontend then backend'}]}
 await store.command({id:'original-message',kind:'message.receive',args:{runId:'original-message',sourceKey:'original',sourceVersion:1,actorId:'owner',conversationId:'group',body:requirement.request,context:{},policy:{}}})
 const goal=await artifacts.put(requirement)
 await store.command({id:'accept',kind:'task.accept',args:{taskId,requirementRef:goal.ref,requirementRevision:1,sessionId:'owner-combined',criteria:requirement.acceptanceCriteria,sourceKey:'original',eventKey:'original'}})
 const first=await registry.prepareTask({taskId,arguments:{repositoryId:'frontend',uatEnvironment:'uat3',objective:'frontend',acceptanceCriteria:['frontend-new']}},{commandId:'front',stageRunId:controller.plannedTaskStageRunId({taskId,planRevision:1,stageId:'front',attempt:1}),run:{actorId:'owner'},unit:{}},controller)
 await controller.initializeTaskPlan({commandId:'plan',taskId,expectedRequirementRevision:1,stages:[{stageId:'front',workflowId:first.workflowId,input:first.input}]})
 await controller.advanceTaskPlan(taskId);await controller.whenIdle(first.runId).catch(error=>assert.equal(error.code,'RUNTIME_MAINTENANCE_ACTIVE'))
 let state=await controller.state(first.runId);assert.equal(held,true,JSON.stringify(state));assert.equal(state.nodes.find(n=>n.nodeId==='prepare-workspace').status,'succeeded');assert.deepEqual(visited,[])
 assert.equal(state.nodes.length,16);assert.ok(!state.nodes.some(n=>n.nodeId==='plan-local-acceptance'));
 const originalWorkspace=await artifacts.read(state.nodes.find(n=>n.nodeId==='prepare-workspace').outputRef),directory=originalWorkspace.workspace.directory
 const initialHead=await git(directory,'rev-parse','HEAD');assert.equal(initialHead,first.input.baseCommit)
 await writeFile(join(directory,'value.txt'),'pending staged source');await git(directory,'add','value.txt');await writeFile(join(directory,'pending-note.txt'),'pending untracked source');await writeFile(join(directory,'pending-staged.txt'),'pending staged addition');await git(directory,'add','pending-staged.txt')
 const snapshot=async()=>({head:await git(directory,'rev-parse','HEAD'),branch:await git(directory,'symbolic-ref','--short','HEAD'),status:await git(directory,'status','--porcelain'),index:await git(directory,'diff','--cached','--binary'),value:await readFile(join(directory,'value.txt'),'utf8'),untracked:await readFile(join(directory,'pending-note.txt'),'utf8')});const before=await snapshot()
 await controller.controlTask({commandId:'pause-before-reset',taskId,intent:'pause',expectedControlRevision:(await controller.taskPlan(taskId)).task.controlRevision});await controller.whenIdle(first.runId).catch(e=>assert.equal(e.code,'RUNTIME_MAINTENANCE_ACTIVE'))
 const paused=await controller.taskPlan(taskId);assert.equal(paused.task.controlState,'paused')
 const resetRun='reset-actual',newRun=await registry.prepareExecutionReset({taskId,sourceRunId:first.runId,runId:resetRun,commandId:'actual-reset'},controller)
 const resetCommand={id:'actual-reset',kind:'task.execution.reset',args:{taskId,actorId:'owner',expectedControlRevision:paused.task.controlRevision,reason:'Retain source and restart before delivery',newRun}};const receipt=await store.command(resetCommand);assert.equal(receipt.result.newRunId,resetRun);assert.equal((await store.command(resetCommand)).replayed,true);assert.deepEqual(await snapshot(),before);assert.equal((await controller.state(resetRun)).run.pauseRequested,true)
 await controller.close();const cold=await registry.restore(store,artifacts);controller=createExecutionController({store:wrappedStore,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:cold})
 resetting=true;await store.command({id:'release-first-hold',kind:'runtime.maintenance.change',args:{active:false,expectedRevision:1,maintenanceId:'source-cache-restart',actorId:'owner',reason:'Execute explicitly resumed isolated reset'}})
 await controller.controlTask({commandId:'resume-reset-task',taskId,intent:'resume',expectedControlRevision:(await controller.taskPlan(taskId)).task.controlRevision});await controller.whenIdle(resetRun).catch(e=>assert.equal(e.code,'RUNTIME_MAINTENANCE_ACTIVE'))
 state=await controller.state(resetRun);assert.equal(resetHeld,true,JSON.stringify(state));assert.equal(state.nodes.find(n=>n.nodeId==='commit').status,'succeeded');const head=await git(directory,'rev-parse','HEAD');assert.notEqual(head,initialHead)
 assert.equal((await artifacts.read(state.nodes.find(n=>n.nodeId==='prepare-workspace').outputRef)).workspace.directory,directory);assert.equal(await readFile(join(directory,'pending-note.txt'),'utf8'),before.untracked);assert.deepEqual(visited,['frontend:plan','frontend:apply'])
 const retained=state.nodes.filter(n=>n.status==='succeeded').map(n=>({nodeId:n.nodeId,outputRef:n.outputRef,leaseEpoch:n.leaseEpoch})),effects=await store.query({kind:'effect.list',runId:resetRun}),buildLog=await readFile(cwdLog,'utf8')
 await controller.close();await store.close();store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'two-repo',initialize:false})
 const options={repositories:configs,ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,fixtureFile]}}
 const restore=async actualStore=>{const result=createEngineeringRegistry(options);return {registry:result,workflows:await result.restore(actualStore??store,artifacts)}}
 // Authorized pending additions are preserved, while completed source stays byte-identical.
 await writeFile(join(directory,'supplement.txt'),'authorized pending addition');await writeFile(join(directory,'supplement-staged.txt'),'authorized staged addition');await git(directory,'add','supplement-staged.txt');const pending=await snapshot()
 const ready=await restore();assert.ok(ready.workflows.some(w=>w.id===state.run.workflowId));assert.deepEqual(await snapshot(),pending)
 const value=await readFile(join(directory,'value.txt'),'utf8');await writeFile(join(directory,'value.txt'),'external drift of completed code');await assert.rejects(ready.registry.prepareExecutionReset({taskId,sourceRunId:resetRun,runId:'reject-code',commandId:'reject-code'},{registerWorkflow(){},prepareResetRun:v=>v}),{code:'TASK_RESET_WORKSPACE_CHANGED'});await writeFile(join(directory,'value.txt'),value)
 await writeFile(join(directory,'foreign.txt'),'unrelated untracked file');await assert.rejects(ready.registry.prepareExecutionReset({taskId,sourceRunId:resetRun,runId:'reject-foreign',commandId:'reject-foreign'},{registerWorkflow(){},prepareResetRun:v=>v}),{code:'TASK_RESET_WORKSPACE_CHANGED'});await rm(join(directory,'foreign.txt'))
 const tree=await git(directory,'rev-parse','HEAD^{tree}'),foreignCommit=(await exec('git',['-C',directory,'-c','user.name=External','-c','user.email=external@example.invalid','commit-tree',tree,'-p',head,'-m','foreign'],{windowsHide:true})).stdout.trim();await git(directory,'update-ref','refs/heads/'+pending.branch,foreignCommit,head);await assert.rejects(restore(),{code:'TASK_RESET_WORKSPACE_CHANGED'});await git(directory,'update-ref','refs/heads/'+pending.branch,head,foreignCommit)
 await git(directory,'branch','foreign-branch',head);await git(directory,'symbolic-ref','HEAD','refs/heads/foreign-branch');await assert.rejects(restore(),{code:'TASK_RESET_WORKSPACE_CHANGED'});await git(directory,'symbolic-ref','HEAD','refs/heads/'+pending.branch)
 const metadataPath=join(directory,'..','repository.json'),metadata=await readFile(metadataPath,'utf8');await writeFile(metadataPath,JSON.stringify({...JSON.parse(metadata),taskId:'foreign-task'}));await assert.rejects(restore(),{code:'TASK_RESET_WORKSPACE_CHANGED'});await writeFile(metadataPath,metadata)
 const missingCommit={command:c=>store.command(c),query:async q=>{const actual=await store.query(q);return q.kind==='effect.list'&&q.runId===resetRun?actual.filter(e=>e.definition.action!=='commit'):actual}};await assert.rejects(restore(missingCommit),{code:'TASK_RESET_WORKSPACE_CHANGED'})
 const forgedCommit={command:c=>store.command(c),query:async q=>{const actual=await store.query(q);return q.kind==='effect.list'&&q.runId===resetRun?actual.map(e=>e.definition.action==='commit'?{...e,definition:{...e.definition,payload:{...e.definition.payload,tree:'a'.repeat(40)}}}:e):actual}};await assert.rejects(restore(forgedCommit),{code:'TASK_RESET_WORKSPACE_CHANGED'})
 assert.deepEqual(await snapshot(),pending)
 registry=ready.registry;controller=createExecutionController({store,artifacts,sessions,readTools:['engineering_repo_inspect'],delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:ready.workflows})
 // Preparing another reset recognizes the real HEAD, while the transaction keeps delivery replay protection.
 await controller.controlTask({commandId:'pause-finished-reset',taskId,intent:'pause',expectedControlRevision:(await controller.taskPlan(taskId)).task.controlRevision})
 const next=await registry.prepareExecutionReset({taskId,sourceRunId:resetRun,runId:'another-reset',commandId:'another-reset'},controller);assert.equal((await artifacts.read(next.requirementRef)).baseCommit,head);assert.deepEqual(await snapshot(),pending)
 await assert.rejects(store.command({id:'another-reset',kind:'task.execution.reset',args:{taskId,actorId:'owner',expectedControlRevision:(await controller.taskPlan(taskId)).task.controlRevision,reason:'Do not repeat delivery',newRun:next}}),{code:'TASK_RESET_DELIVERY_ALREADY_PERFORMED'})
 // Test-only probes remain unverified; remove them explicitly before submitting the original accepted candidate.
 assert.deepEqual(await snapshot(),pending);await git(directory,'rm','--cached','supplement-staged.txt');await rm(join(directory,'supplement-staged.txt'));await rm(join(directory,'supplement.txt'));const delivered=await snapshot()
 await store.command({id:'release-reset-commit',kind:'runtime.maintenance.change',args:{active:false,expectedRevision:3,maintenanceId:'reset-workspace',actorId:'owner',reason:'Continue remaining delivery without redoing completed phases'}})
 await controller.controlTask({commandId:'resume-existing-reset-run',taskId,intent:'resume',expectedControlRevision:(await controller.taskPlan(taskId)).task.controlRevision});state=await controller.whenIdle(resetRun);assert.equal(state.run.status,'succeeded',JSON.stringify(state));for(const prior of retained){const current=state.nodes.find(n=>n.nodeId===prior.nodeId);assert.equal(current.outputRef,prior.outputRef);assert.equal(current.leaseEpoch,prior.leaseEpoch)}
 assert.equal(await readFile(cwdLog,'utf8'),buildLog);assert.deepEqual(visited,['frontend:plan','frontend:apply']);assert.deepEqual(await snapshot(),delivered)
 const finalEffects=await store.query({kind:'effect.list',runId:resetRun});for(const action of ['commit','push','pr'])assert.equal(finalEffects.filter(e=>e.definition.action===action).length,1);assert.deepEqual(finalEffects.filter(e=>e.definition.action==='commit'),effects.filter(e=>e.definition.action==='commit'))
 await controller.recover({commandId:'repeat-completed-reset-run',runId:resetRun});await controller.whenIdle(resetRun);assert.deepEqual(await store.query({kind:'effect.list',runId:resetRun}),finalEffects);assert.equal(JSON.parse(await readFile(fixture.frontend.stateFile,'utf8')).creates,1)
 }catch(error){process.stderr.write(String(error.stack)+'\n');throw error}
})
