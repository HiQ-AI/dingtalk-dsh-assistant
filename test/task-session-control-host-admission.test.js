import test from 'node:test'
import assert from 'node:assert/strict'
import {openTaskSessionControlFixture} from './fixtures/task-session-control-integration.js'
import {nodeBinding,saveActual} from './fixtures/task-session-control-adapter.js'
const object={type:'object'}
test('host admission verifies reused output without changing the frozen node definition',async t=>{
 const f=await openTaskSessionControlFixture(t,{workflowFactory:ctx=>[{id:'host-proof',version:'1',nodes:[
  {id:'verify',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({requirement})=>requirement,execute:()=>{throw Error('Independent verification required')}},
  {id:'deliver',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({previousOutput})=>previousOutput,execute:({input})=>input}
 ]}]})
 await f.start();const before=await f.controller.state(f.runId),output=await saveActual(f,{observed:'actual'})
 const request={...await nodeBinding(f),commandId:'reuse-host-proof',action:'reuse',outputRef:output.ref}
 await assert.rejects(f.controller.controlNode(request),{code:'NODE_CONTROL_REUSE_UNPROVEN'})
 await assert.rejects(f.controller.controlNode(request,{validateControlledOutput:()=>{throw Object.assign(Error('Not observed'),{code:'REMOTE_UNCONFIRMED'})}}),{code:'REMOTE_UNCONFIRMED'})
 const unchanged=await f.controller.state(f.runId);assert.equal(unchanged.nodes[0].outputRef,before.nodes[0].outputRef)
 await f.controller.controlNode(request,{validateControlledOutput:({binding,input,output})=>{assert.equal(binding.taskId,f.taskId);assert.equal(binding.runId,f.runId);assert.equal(input.request,f.expected);assert.deepEqual(output,{observed:'actual'});return true}})
 const done=await f.controller.whenIdle(f.runId);assert.equal(done.run.status,'succeeded');assert.equal(done.run.workflowDigest,before.run.workflowDigest)
})
