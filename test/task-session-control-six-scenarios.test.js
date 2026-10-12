import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFile,readFile,appendFile} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {openTaskSessionControlFixture} from './fixtures/task-session-control-integration.js'
import {requireControl,nodeBinding,control,saveActual,stop,continueRun,bindOriginalRequirement,applyRequirementDifference,attemptOriginalCompletion} from './fixtures/task-session-control-adapter.js'
const exec=promisify(execFile),object={type:'object'}
const count=(calls,phase)=>calls.filter(c=>c.phase===phase).length
const retained=state=>state.nodes.filter(n=>n.status==='succeeded').map(n=>({nodeRunId:n.nodeRunId,outputRef:n.outputRef,leaseEpoch:n.leaseEpoch}))
const until=async predicate=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw Error('Actual state transition was not observed');await new Promise(r=>setTimeout(r,10))}}

test('scenario 1: actual failed script is taken over with an equivalent tool result; next node executes once',async t=>{
 const f=await openTaskSessionControlFixture(t);if(!requireControl(t,f))return
 const failed=await f.start(),prefix=retained(failed);assert.equal(failed.run.status,'waiting');assert.equal(failed.nodes[2].leaseEpoch,0)
 assert.equal((await f.artifacts.read(failed.nodes[1].evidenceRefs.at(-1))).code,'LOCAL_CHECK_FAILED')
 await control(f,'takeover',{commandId:'takeover-failed-script'})
 const fake=await saveActual(f,{status:'succeeded'});await assert.rejects(control(f,'submit-output',{commandId:'fake-success',outputRef:fake.ref}),{code:'LOCAL_CHECK_FAILED'})
 const output=await f.equivalentOutput(),actual=await saveActual(f,output),foreign=await f.artifacts.put(output,{taskId:'foreign-task'})
 await assert.rejects(control(f,'submit-output',{commandId:'cross-task',outputRef:foreign.ref}),{code:'NODE_CONTROL_OUTPUT_SCOPE_INVALID'})
 const submit={commandId:'submit-equivalent',outputRef:actual.ref,evidenceRefs:[actual.ref]};await control(f,'submit-output',submit)
 const done=await f.controller.whenIdle(f.runId);assert.equal(done.run.status,'succeeded');for(const prior of prefix){const node=done.nodes.find(n=>n.nodeRunId===prior.nodeRunId);assert.equal(node.outputRef,prior.outputRef);assert.equal(node.leaseEpoch,prior.leaseEpoch)}
 assert.equal(count(await f.calls(),'verify'),1);assert.equal(count(await f.calls(),'deliver'),1)
 const before=await f.calls();assert.equal((await control(f,'submit-output',submit)).replayed,true);await f.controller.whenIdle(f.runId);assert.deepEqual(await f.calls(),before)
})

test('scenario 2: an independently observed existing PR is reused without historical producer identity or duplicate create',async t=>{
 let remote,script,row
 const f=await openTaskSessionControlFixture(t,{expected:'https://github.com/fixture/repo/pull/42',validateOutput:async({output})=>{const actual=JSON.parse((await exec(process.execPath,[script,remote],{windowsHide:true})).stdout);for(const key of ['repository','number','url','head','base','headSha','draft'])if(output.pullRequest?.[key]!==actual[key])throw Object.assign(Error('Real independently observed PR identity does not match'),{code:'PR_ACTUAL_IDENTITY_INVALID'})}});if(!requireControl(t,f))return
 remote=join(f.directory,'observed-pr.json');script=join(f.directory,'observe-pr.cjs')
 row={repository:'fixture/repo',number:42,url:f.expected,head:'feature/current',base:'feature/uat3-base',headSha:'a'.repeat(40),draft:true,creates:0,reads:0}
 await writeFile(remote,JSON.stringify(row));await writeFile(script,"const fs=require('node:fs'),file=process.argv[2],s=JSON.parse(fs.readFileSync(file));s.reads++;fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(s))")
 const failed=await f.start();assert.equal(failed.nodes[1].status,'waiting')
 const observed=JSON.parse((await exec(process.execPath,[script,remote],{windowsHide:true})).stdout);assert.equal(observed.url,f.expected);assert.equal(observed.repository,row.repository);assert.equal(observed.headSha,row.headSha)
 await f.equivalentOutput();const actual=await saveActual(f,{pullRequest:observed,tool:'independent-authorized-read'})
 assert.equal(await f.store.query({kind:'node.output.producer',taskId:f.taskId,outputRef:actual.ref}),null,'This real observed result was not produced by an old workflow node')
 await control(f,'takeover',{commandId:'inspect-existing-pr'})
 for(const [index,change] of [{repository:'foreign/repo'},{head:'feature/other'},{base:'feature/wrong'},{headSha:'b'.repeat(40)}].entries()){const invalid=await saveActual(f,{pullRequest:{...observed,...change},tool:'independent-authorized-read'});await assert.rejects(control(f,'submit-output',{commandId:'reject-pr-'+index,outputRef:invalid.ref}),{code:'PR_ACTUAL_IDENTITY_INVALID'})}
 try{await control(f,'reuse',{commandId:'reuse-existing-pr',outputRef:actual.ref,evidenceRefs:[actual.ref]});const done=await f.controller.whenIdle(f.runId);assert.equal(done.run.status,'succeeded');assert.equal(count(await f.calls(),'verify'),1);assert.equal(count(await f.calls(),'deliver'),1);await control(f,'reuse',{commandId:'reuse-existing-pr',outputRef:actual.ref,evidenceRefs:[actual.ref]});assert.equal(count(await f.calls(),'deliver'),1)}finally{assert.equal(JSON.parse(await readFile(remote,'utf8')).creates,0)}
})

test('scenario 3: stop fences late results; paused state and takeover or continue survive restart',async t=>{
 for(const mode of ['takeover','continue'])await t.test(mode,async child=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();child.after(()=>release.resolve());let executions=0
  const f=await openTaskSessionControlFixture(child,{execute:async({fixture})=>{if(++executions===1){entered.resolve();await release.promise;return {actual:'late obsolete result'}}return fixture.verify()}});if(!requireControl(child,f))return
  const running=f.start();await entered.promise;const original=await nodeBinding(f);await stop(f)
  let state=await f.controller.state(f.runId);assert.equal(state.run.pauseRequested,true);if(typeof f.controller.controlRun==='function')assert.equal(state.run.control.action,'stop');assert.equal(state.nodes[1].drained,false);assert.equal(state.nodes[2].leaseEpoch,0)
  release.resolve();await running;state=await f.controller.whenIdle(f.runId);assert.equal(state.nodes[1].outputRef,null);assert.equal(state.nodes[1].drained,true);assert.equal(count(await f.calls(),'deliver'),0)
  const stoppedCalls=await f.calls();await f.reopen();await f.controller.recover({commandId:'recover-stopped',runId:f.runId});state=await f.controller.whenIdle(f.runId);assert.equal(state.run.pauseRequested,true);if(typeof f.controller.controlRun==='function'){assert.equal(state.run.control.action,'stop');assert.equal(state.run.control.source,'operator')}assert.equal(state.nodes[1].outputRef,null);assert.deepEqual(await f.calls(),stoppedCalls)
  const actual=await saveActual(f,await f.equivalentOutput())
  if(mode==='takeover'){await control(f,'takeover',{commandId:'takeover-after-stop'});const binding=await nodeBinding(f);assert.ok(binding.leaseEpoch>original.leaseEpoch);await assert.rejects(control(f,'submit-output',{commandId:'late-old-lease',outputRef:actual.ref,leaseEpoch:original.leaseEpoch}),{code:'NODE_CONTROL_STALE'});await control(f,'submit-output',{commandId:'submit-after-stop',outputRef:actual.ref});assert.equal(executions,1)}else{await continueRun(f);const continued=await f.controller.whenIdle(f.runId);assert.equal(continued.run.pauseRequested,false);if(typeof f.controller.controlRun==='function')assert.equal(continued.run.control.action,'continue');assert.equal(executions,2)}
  state=await f.controller.whenIdle(f.runId);assert.equal(state.run.status,'succeeded');assert.equal(count(await f.calls(),'deliver'),1);assert.equal((await f.artifacts.read(state.nodes[1].outputRef)).actual==='late obsolete result',false)
  const completed=retained(state),calls=await f.calls();await f.reopen();await f.controller.recover({commandId:'recover-continued',runId:f.runId});state=await f.controller.whenIdle(f.runId);assert.deepEqual(retained(state),completed);if(mode==='continue'&&typeof f.controller.controlRun==='function'){assert.equal(state.run.control.action,'continue');assert.equal(state.run.control.source,'operator')}assert.deepEqual(await f.calls(),calls)
 })
})

test('scenario 4: changed requirement reuses the real completed base and executes only its difference',async t=>{
 let basePath,deltaPath
 const f=await openTaskSessionControlFixture(t,{workflowFactory:context=>[
  {id:'original-base',version:'1',nodes:[{id:'base',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({requirement})=>requirement,execute:async()=>{await context.trace('base');await writeFile(basePath,'base actual value');return {basePath,value:'base actual value'}}}]},
  {id:'requirement-difference',version:'1',nodes:[{id:'difference',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({requirement})=>requirement,execute:async({input})=>{assert.equal(await readFile(input.basePath,'utf8'),'base actual value');await context.trace('difference');await writeFile(deltaPath,input.addition);return {basePath:input.basePath,deltaPath,value:input.addition}}}]},
 ]});if(!requireControl(t,f))return;basePath=join(f.directory,'base.txt');deltaPath=join(f.directory,'difference.txt')
 const initialGoal={request:'Create the base artifact',acceptanceCriteria:['Base exists'],scope:{}}
 await f.start({stages:[{stageId:'base',workflowId:'original-base',input:initialGoal},{stageId:'difference',workflowId:'requirement-difference',gate:'confirmation'}]});let plan=await f.controller.advanceTaskPlan(f.taskId)
 const prefix=structuredClone(plan.stages[0]),before=await f.controller.state(prefix.runId);assert.equal(prefix.status,'succeeded');assert.equal(count(await f.calls(),'base'),1)
 await bindOriginalRequirement(f,initialGoal)
 const goal={request:'Keep the base and add the additional result',acceptanceCriteria:['Base exists','Additional result exists'],scope:{}}
 plan=await applyRequirementDifference(f,{requirement:goal,stages:[{stageId:'base',workflowId:'original-base'},{stageId:'difference',workflowId:'requirement-difference',gate:'confirmation'}],stageId:'difference',predecessorOutputRef:prefix.outputRef,input:{basePath,addition:'actual requested difference'}})
 const runId=plan.stages[1].runId;assert.ok(runId);await f.controller.whenIdle(runId);plan=await f.controller.advanceTaskPlan(f.taskId)
 assert.equal(plan.task.requirementRevision,2);assert.deepEqual(await f.artifacts.read(plan.task.requirementRef),goal);assert.equal(plan.stages[0].runId,prefix.runId);assert.equal(plan.stages[0].outputRef,prefix.outputRef);assert.deepEqual((await f.controller.state(prefix.runId)).nodes,before.nodes)
 assert.equal(await readFile(basePath,'utf8'),'base actual value');assert.equal(await readFile(deltaPath,'utf8'),'actual requested difference');assert.equal(count(await f.calls(),'base'),1);assert.equal(count(await f.calls(),'difference'),1)
 await assert.rejects(control(f,'retry',{commandId:'stale-goal',nodeId:'base',expectedRequirementRevision:1}),{code:'NODE_CONTROL_STALE'});await f.controller.advanceTaskPlan(f.taskId);assert.equal(count(await f.calls(),'difference'),1)
})

test('scenario 5: restart and repeated control preserve actual side-effect count and settled effect history',async t=>{
 let writesPath
 const f=await openTaskSessionControlFixture(t,{execute:async({runId,fixture})=>{
  const state=await fixture.controller.state(runId),node=state.nodes.find(n=>n.nodeId==='verify'),effectId='actual-local-write'
  await fixture.store.command({id:'prepare-local-write',kind:'effect.prepare',args:{effectId,kind:'operation',runId:runId,nodeId:'verify',generation:node.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,definition:{adapterId:'fixture-local-file',adapterVersion:'1',principalId:'fixture-operator',action:'append',payload:{path:writesPath}},resourceKeys:[writesPath],authorizationRef:'fixture-local-file-grant'}})
  const begin=await fixture.store.command({id:'begin-local-write',kind:'effect.begin',args:{effectId,leaseEpoch:node.leaseEpoch,expectedSafetyEpoch:0}})
  if(begin.dispatchEligible){await appendFile(writesPath,'actual write\n');await fixture.store.command({id:'observe-local-write',kind:'effect.observe',args:{effectId,receiptId:'actual-local-write-receipt',status:'succeeded',evidenceRef:'fixture-local-file-observed',result:{actualWrites:1}}})}
  return fixture.verify()
 }});if(!requireControl(t,f))return;writesPath=join(f.directory,'actual-write.log');await f.start()
 const effects=await f.store.query({kind:'effect.list',runId:f.runId});assert.equal(effects.length,1);assert.equal(effects[0].state,'succeeded');assert.equal((await readFile(writesPath,'utf8')).trim().split('\n').length,1)
 await f.reopen();assert.deepEqual(await f.store.query({kind:'effect.list',runId:f.runId}),effects);await assert.rejects(control(f,'retry',{commandId:'must-not-rewrite'}),{code:'NODE_CONTROL_EFFECT_REUSE_REQUIRED'})
 await control(f,'takeover',{commandId:'takeover-existing-side-effect'});const actual=await saveActual(f,await f.equivalentOutput());const request={commandId:'settle-existing-result',outputRef:actual.ref};await control(f,'submit-output',request);assert.equal((await f.controller.whenIdle(f.runId)).run.status,'succeeded')
 await f.reopen();await f.controller.recover({commandId:'cold-settled-effect',runId:f.runId});await f.controller.whenIdle(f.runId);await control(f,'submit-output',request);await f.controller.whenIdle(f.runId)
 assert.deepEqual(await f.store.query({kind:'effect.list',runId:f.runId}),effects);assert.equal((await readFile(writesPath,'utf8')).trim().split('\n').length,1);assert.equal(count(await f.calls(),'verify'),1);assert.equal(count(await f.calls(),'deliver'),1)
})

test('scenario 6: workflow succeeds but the actual original delivery is missing; Task completion remains unverified',async t=>{
 let reportPath
 const f=await openTaskSessionControlFixture(t,{ownerContract:{id:'actual-report',version:'1',resultContract:{id:'actual-report',version:'1',requiredFields:['result']},validateCompletion:async()=>{try{return (await readFile(reportPath,'utf8'))==='requested final report'}catch(error){if(error.code==='ENOENT')return false;throw error}}}});reportPath=join(f.directory,'requested-report.md')
 const requirement={request:'Produce actual result and deliver requested final report',acceptanceCriteria:['Actual result exists','Requested final report is delivered'],scope:{}}
 await writeFile(f.candidatePath,f.expected);const done=await f.start({input:requirement});assert.equal(done.run.status,'succeeded');await f.controller.advanceTaskPlan(f.taskId);await bindOriginalRequirement(f,requirement)
 await assert.rejects(readFile(reportPath),{code:'ENOENT'});await assert.rejects(attemptOriginalCompletion(f,requirement),{code:'TASK_OWNER_COMPLETION_UNVERIFIED'})
 assert.equal(await f.store.query({kind:'task.owner.delivery-manifest',taskId:f.taskId}),null);const owner=await f.store.query({kind:'task.owner',taskId:f.taskId});assert.notEqual(owner.status,'accepted');assert.equal(count(await f.calls(),'deliver'),1)
})
