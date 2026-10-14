import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectStoppedNativeOperation, legacyDrainedError } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'
import { sessionPersistenceFixture } from './fixtures/session-persistence.js'
// Reproduce the a5 nativeOperation ledger's canonical arguments/content digest.
const canonical = value => value && typeof value==='object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function fixture(){
 const binding={kind:'task-execution',taskId:'task',executionId:'execution',sessionId:'session',inputVersion:1,leaseEpoch:1,inputDigest:'original'}
 const operation={operationId:'operation',taskId:'task',executionId:'execution',dispatchBinding:binding,state:'unknown',key:'native:execution:1:1:call-1',definition:{toolName:'pwsh',argumentsDigest:hash({command:'git fetch origin --prune',timeoutMs:20000})},result:{toolName:'pwsh',callId:'call-1',isError:true,resultDigest:hash([{type:'text',text:legacyDrainedError}])},updatedAt:'2026-10-14T01:00:00Z'}
 const execution={...binding,drained:true,recovering:false}
 const readback={...binding,executionId:'readback',sessionId:'readback-session',inputDigest:'readback-input',status:'succeeded',drained:true,definition:{recoveryReadOnly:true},input:{readbackOperationId:'operation'},updatedAt:'2026-10-14T02:00:00Z'}
 const seed=b=>({seq:0,type:'plugin:dingtalk/execution-session',data:{identity:b}})
 const input=b=>({seq:1,type:'user/message',data:{source:{executionSession:b}}})
 const original=[seed(binding),input(binding),{seq:2,type:'tool/call',data:{callId:'call-1',name:'pwsh',arguments:JSON.stringify({command:'git fetch origin --prune',timeoutMs:20000})}},
  {seq:3,type:'tool/result',data:{message:{role:'tool',toolCallId:'call-1',isError:true,content:[{type:'text',text:'Error: '+legacyDrainedError}]}}}]
 const readEvents=[seed(readback),input(readback),{seq:2,type:'tool/call',data:{callId:'read-1',name:'read',arguments:JSON.stringify({file_path:'.git/FETCH_HEAD'})}},
  {seq:3,type:'tool/result',data:{message:{role:'tool',toolCallId:'read-1',isError:false,content:[{type:'text',text:'Observed actual refs; fetch completion remains unknown'}]}}}]
 const live=new Set(),jobs=[]
 const ctx={agents:{get:id=>live.has(id)},sessions:{get:()=>undefined},get:name=>name==='jobs'?{list:()=>jobs}:undefined,
  sessionPersistence:sessionPersistenceFixture(async id=>({meta:{id},events:id==='session'?original:readEvents}))}
 return {ctx,operation,execution,executions:[execution,readback],original,readEvents,live,jobs,readback}
}
test('legacy Host drained error plus bound real readonly observation proves failed partial effects only',async()=>{
 const f=fixture(),proof=await inspectStoppedNativeOperation(f)
 assert.equal(proof.kind,'legacy-host-drained-partial');assert.equal(proof.partialEffectsPossible,true)
 assert.equal(proof.observations[0].executionId,'readback')
 assert.match(proof.conclusion,/does not prove command success/)
})
for(const [name,mutate] of Object.entries({
 'model text instead of tool receipt':f=>{f.original[3]={seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:legacyDrainedError}]}}}},
 'printed error text in successful shell output':f=>{f.original[3].data.message.isError=false},
 'forged ledger result digest':f=>{f.operation.result.resultDigest='0'.repeat(64)},
 'wrong call':f=>{f.original[3].data.message.toolCallId='another-call'},
 'changed arguments':f=>{f.original[2].data.arguments=JSON.stringify({command:'git push origin main',timeoutMs:20000})},
 'wrong session identity':f=>{f.original[0].data.identity={...f.operation.dispatchBinding,sessionId:'other'}},
 'active original agent':f=>f.live.add('session'),
 'live job still running':f=>f.jobs.push({status:'running'}),
 'execution not drained':f=>{f.execution.drained=false},
 'no actual readonly result':f=>f.readEvents.pop(),
 'wrong readback operation':f=>{f.readback.input.readbackOperationId='other'},
 'unrestricted readback':f=>{f.readback.definition.recoveryReadOnly=false},
 'failed readback call':f=>{f.readEvents[3].data.message.isError=true},
 'stale observation predates unknown':f=>{f.readback.updatedAt='2026-10-14T00:00:00Z'},
}))test(`legacy unknown remains fenced: ${name}`,async()=>{const f=fixture();mutate(f);assert.equal(await inspectStoppedNativeOperation(f),null)})
