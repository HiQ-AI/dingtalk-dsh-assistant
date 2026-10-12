import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
const number={type:'number'}
async function fixture(t,{failAt='work',onWork}={}) {
 const directory=await mkdtemp(join(tmpdir(),'dsh-controls-')),dbPath=join(directory,'control.sqlite')
 const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true})
 let store=await openExecutionStore({dbPath,instanceId:'controls',initialize:true}),allow=false,calls={first:0,work:0,last:0}
 const definition={id:'control-fixture',version:'1',nodes:['first','work','last'].map((id,index)=>({id,version:'1',executor:'code',allowedEffects:['pure'],inputSchema:number,outputSchema:number,mapInput:({requirement,previousOutput})=>index?previousOutput:requirement,execute:async({input})=>{calls[id]++;if(id===failAt&&!allow)throw Object.assign(new Error('requires owner'),{code:'OWNER_INPUT_REQUIRED'});if(id==='work'&&onWork)return onWork(input);return input+1}}))}
 let controller=createExecutionController({store,artifacts,workflows:[definition]})
 t.after(async()=>{await controller.close();await store.close()})
 await controller.createTaskPlan({commandId:'plan',taskId:'task',stages:[{stageId:'stage',workflowId:definition.id,input:1}]})
 const plan=await controller.advanceTaskPlan('task'),runId=plan.stages[0].runId
 await controller.whenIdle(runId)
 return {calls,artifacts,runId,get controller(){return controller},get store(){return store},allow:()=>{allow=true},async restart(){await controller.close();await store.close();store=await openExecutionStore({dbPath,instanceId:'controls'});controller=createExecutionController({store,artifacts,workflows:[definition]})},async common(action,nodeId='work'){const state=await controller.state(runId),task=(await controller.taskPlan('task')).task,node=state.nodes.find(n=>n.nodeId===nodeId);return {commandId:action,taskId:'task',runId,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,expectedRequirementRevision:task.requirementRevision,expectedControlRevision:task.controlRevision,action,source:'operator',actorId:'fixture',reason:'real fixture control'}}}
}
test('stop and continue state/source/reason persist across actual store reopen',async t=>{
 const f=await fixture(t),args=await f.common('stop');delete args.nodeRunId;delete args.generation;delete args.leaseEpoch
 await f.controller.controlRun(args);await f.controller.whenIdle(f.runId);await f.restart()
 let state=await f.controller.state(f.runId);assert.equal(state.run.pauseRequested,true);assert.equal(state.run.recoveryReason,'user_pause');assert.equal(state.run.control.action,'stop');assert.equal(state.run.control.reason,args.reason)
 await f.controller.controlRun({...args,commandId:'continue',action:'continue'});await f.controller.whenIdle(f.runId);await f.restart();state=await f.controller.state(f.runId);assert.equal(state.run.pauseRequested,false);assert.equal(state.run.control.action,'continue');assert.equal(f.calls.work,1)
})
test('retry executes only failed suffix and same request cannot cross node/task scope',async t=>{
 const f=await fixture(t);f.allow();const args=await f.common('retry');await f.controller.controlNode(args);await f.controller.whenIdle(f.runId)
 assert.deepEqual(f.calls,{first:1,work:2,last:1});assert.equal((await f.controller.state(f.runId)).run.status,'succeeded')
 await assert.rejects(f.controller.controlNode({...args,taskId:'other'}),{code:'NODE_CONTROL_REQUEST_CONFLICT'})
 assert.equal((await f.controller.controlNode(args)).replayed,true)
})
test('takeover real output advances without executing work twice and survives restart',async t=>{
 const f=await fixture(t),args=await f.common('takeover');await f.controller.controlNode(args);await f.restart()
 let state=await f.controller.state(f.runId);assert.equal(state.nodes[1].control.action,'takeover');assert.equal(state.nodes[1].waitReason.reference,'TASK_SESSION_TAKEOVER')
 const output=await f.artifacts.put(20,{reference:state.run.requirementRef}),submit=await f.common('submit-output')
 await f.controller.controlNode({...submit,outputRef:output.ref,evidenceRefs:[output.ref]});await f.controller.whenIdle(f.runId)
 state=await f.controller.state(f.runId);assert.equal(await f.artifacts.read(state.nodes[2].outputRef),21);assert.deepEqual(f.calls,{first:1,work:1,last:1});assert.equal(state.nodes[1].control.action,'submit-output')
})
test('skip explicitly uses real predecessor and remains distinct from produced output',async t=>{
 const f=await fixture(t);await f.controller.controlNode(await f.common('skip'));await f.controller.whenIdle(f.runId)
 const state=await f.controller.state(f.runId);assert.equal(state.nodes[1].control.action,'skip');assert.equal(state.nodes[1].outputRef,state.nodes[0].outputRef);assert.equal(await f.artifacts.read(state.nodes[2].outputRef),3);assert.deepEqual(f.calls,{first:1,work:1,last:1})
})
test('unbound task session cannot control a node or persist stop',async t=>{
 const f=await fixture(t),args={...await f.common('takeover'),source:'task-session',actorId:'spoofed-session'}
 await assert.rejects(f.controller.controlNode(args),{code:'WORKFLOW_ACTION_FORBIDDEN'})
 delete args.nodeRunId;delete args.generation;delete args.leaseEpoch
 await assert.rejects(f.controller.controlRun({...args,action:'stop'}),{code:'WORKFLOW_ACTION_FORBIDDEN'})
 assert.equal((await f.controller.state(f.runId)).run.pauseRequested,false)
})

test('takeover drains an executor ignoring abort, fences late work and runs downstream once',async t=>{
 let release,started;const entered=new Promise(r=>{started=r}),blocked=new Promise(r=>{release=r})
 const f=await fixture(t,{onWork:async()=>{started();await blocked;return 40}});f.allow()
 await f.controller.controlNode(await f.common('retry'));await entered
 const old=(await f.controller.state(f.runId)).nodes[1],takeover=await f.common('takeover')
 let granted=false;const taking=f.controller.controlNode(takeover).then(r=>{granted=true;return r})
 await new Promise(r=>setTimeout(r,120));assert.equal(granted,false);assert.equal(f.calls.last,0)
 release();await taking
 const state=await f.controller.state(f.runId);assert.equal(state.nodes[1].drained,true);assert.equal(state.nodes[1].control.action,'takeover');assert.equal(state.nodes[1].outputRef,null);assert.equal(state.nodes[1].leaseEpoch>old.leaseEpoch,true);assert.equal(f.calls.last,0)
 const actual=await f.artifacts.put(77,{reference:state.run.requirementRef})
 await f.controller.controlNode({...await f.common('submit-output'),outputRef:actual.ref});await f.controller.whenIdle(f.runId)
 assert.equal(await f.artifacts.read((await f.controller.state(f.runId)).nodes[2].outputRef),78);assert.deepEqual(f.calls,{first:1,work:2,last:1})
})
test('continue resumes paused Task atomically and failed work still requires explicit retry',async t=>{
 const f=await fixture(t),task=(await f.controller.taskPlan('task')).task
 await f.controller.controlTask({commandId:'pause-task',taskId:'task',intent:'pause',expectedControlRevision:task.controlRevision})
 const args=await f.common('continue');delete args.nodeRunId;delete args.generation;delete args.leaseEpoch
 await f.controller.controlRun(args);await f.controller.whenIdle(f.runId)
 assert.equal((await f.controller.taskPlan('task')).task.controlState,'active');assert.equal((await f.controller.state(f.runId)).run.pauseRequested,false);assert.equal(f.calls.work,1)
 f.allow();await f.controller.controlNode(await f.common('retry'));await f.controller.whenIdle(f.runId);assert.equal((await f.controller.state(f.runId)).run.status,'succeeded')
})
