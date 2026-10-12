import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskMaintenanceConstraint } from '../packages/dingtalk-dsh-assistant/task-maintenance-constraint.js'
const fixture=()=>{
 const values=new Map([['requirement',{sourceInstructions:[{sourceKey:'original',sourceVersion:1,actorId:'requester',text:'original UI task'}]}]])
 let event,source,otherTouched=false,completeWrites=0
 const original={sourceVersion:1,actorId:'requester',body:'original UI task',conversationId:'g'}
 const store={async query(q){
  if(q.kind==='task.origin')return{run:{conversationId:'g'}}
  if(q.kind==='receipt')return event?{result:{eventSeq:1}}:null
  if(q.kind==='task.owner.events')return[{payloadRef:'event'}]
  if(q.kind==='runtime.maintenance')return{active:false,phase:'task-scoped',taskRunScope:{taskId:'task',runId:'run',requirementRevision:2}}
  if(q.kind==='task.owner')return{status:'idle'}
  if(q.kind==='task.source')return original
  throw Error('unexpected query '+q.kind)
 }}
 const artifacts={async read(ref){return values.get(ref)},async put(v){source=v;values.set('repair',v);return{ref:'repair'}}}
 const plan={task:{taskId:'task',requirementRef:'requirement',controlState:'active',requirementRevision:2,controlRevision:50},stages:[{stageId:'stage',runId:'run',status:'succeeded',outputRef:'final'}]}
 const state={run:{status:'succeeded'},nodes:[{status:'succeeded',drained:true,outputRef:'final',evidenceRefs:['acceptance']}]}
 const controller={async taskPlan(){return plan},async state(){return state}}
 const recordFact=async(action,info)=>{assert.equal(action.arguments.kind,'constraint');assert.equal(info.binding.taskId,'task');assert.equal(info.run.actorId,'operator');event={sourceKey:info.run.sourceKey,repairSource:info.repairSource};values.set('event',event)}
 const apply=createTaskMaintenanceConstraint({store,artifacts,controller,webActorId:'operator',taskAccess:async()=>{},recordFact})
 const request={taskId:'task',requestId:'r',text:'Maintenance scope; no merge',expectedRequirementRevision:2,expectedControlRevision:50,evidenceRefs:['requirement','final','acceptance']}
 return{apply,request,identity:{channel:'web',actorId:'operator'},original,plan,state,source:()=>source,event:()=>event}
}
test('internal constraint retains original provenance and idempotent request without completion decision',async()=>{
 const f=fixture(),first=await f.apply(f.request,f.identity),again=await f.apply(f.request,f.identity)
 assert.equal(first.sourceRef,again.sourceRef);assert.equal(again.replayed,true)
 assert.equal(f.source().channel,'internal-maintenance');assert.equal(f.source().actorId,'operator')
 assert.equal(f.source().sources[0].text,'original UI task');assert.equal(f.event().repairSource.kind,'engineering-maintenance')
 assert.equal(f.state.run.status,'succeeded');assert.equal(f.plan.task.requirementRevision,2)
 await assert.rejects(f.apply({...f.request,text:'changed'},f.identity),/CONFLICT/)
})
test('constraint rejects wrong actor, other task and stale real source without event',async()=>{
 const f=fixture()
 await assert.rejects(f.apply(f.request,{channel:'web',actorId:'requester'}),/FORBIDDEN/)
 await assert.rejects(f.apply({...f.request,taskId:'other'},f.identity),/SCOPE_REQUIRED/)
 f.original.sourceVersion=2
 await assert.rejects(f.apply(f.request,f.identity),/TASK_AUTHORIZATION_SOURCE_STALE/)
 assert.equal(f.event(),undefined);assert.equal(f.source(),undefined)
})
test('constraint rejects incomplete run and foreign artifacts before provenance storage',async()=>{
 const f=fixture();f.state.nodes[0].drained=false
 await assert.rejects(f.apply(f.request,f.identity),/NOT_COMPLETE/)
 f.state.nodes[0].drained=true
 await assert.rejects(f.apply({...f.request,evidenceRefs:['requirement','final','foreign']},f.identity),/EVIDENCE_SCOPE/)
 await assert.rejects(f.apply({...f.request,expectedControlRevision:49},f.identity),/STALE/)
 assert.equal(f.event(),undefined);assert.equal(f.source(),undefined)
})

test('maintenance constraint HTTP route keeps local identity and does not accept client actor injection',async t=>{
 const {createServer}=await import('node:http'),{handleRequest}=await import('../packages/dingtalk-dsh-assistant/http.js')
 let seen
 const store={applyWorkflowMaintenanceConstraint:async r=>{seen=r;return{accepted:true}}}
 const server=createServer((request,response)=>handleRequest(request,response,store).catch(e=>{response.statusCode=500;response.end(String(e))}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const url='http://127.0.0.1:'+server.address().port+'/tasks/task/maintenance-constraint'
 const body={requestId:'r',text:'Internal maintenance; Draft delivery only',expectedRequirementRevision:2,expectedControlRevision:50,evidenceRefs:['requirement','final']}
 const send=(value,origin='http://127.0.0.1:3080')=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)})
 assert.equal((await send(body,'https://foreign.example')).status,403)
 assert.equal((await send({...body,actorId:'forged'})).status,400);assert.equal(seen,undefined)
 assert.equal((await send(body)).status,202);assert.equal(seen.taskId,'task');assert.deepEqual(seen.evidenceRefs,body.evidenceRefs)
});
