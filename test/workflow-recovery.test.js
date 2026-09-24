import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
test('单Task恢复失败和正在执行Task不能阻止其它恢复与通知扫描',async()=>{
 const recovered=[],queries=[]
 const store={command:async()=>({result:{}}),query:async q=>{queries.push(q.kind);if(q.kind==='run.list')return [{runId:'running',status:'running'},{runId:'bad',status:'waiting'},{runId:'good',status:'waiting'},{runId:'check-failed',status:'waiting'}];if(q.kind==='run')return {nodes:q.runId==='check-failed'?[{waitReason:{reference:'ENGINEERING_VERIFICATION_FAILED'}}]:[]};return []}}
 const controller={pendingTaskPlans:async()=>[],recover:async({runId})=>{recovered.push(runId);if(runId!=='good')throw Object.assign(new Error('busy'),{code:runId==='running'?'EXECUTOR_STILL_ACTIVE':'EFFECT_UNKNOWN'})}}
 const service=await openWorkflowService({ctx:{},config:{groupIds:['g'],ownerActorId:'a'},legacy:{getAgentConfig:()=>({provider:'test',model:'test'}),getGroup:()=>({messages:[]})},judge:async()=>{},execution:{store,controller,artifacts:{}}})
 try {const result=await service.recover();assert.deepEqual(recovered,['bad','good']);assert.ok(queries.includes('message.list'));assert.equal(result.failures.length,1)}finally{await service.close()}
})
test('大量unknown通知不能挤掉新prepared；对账游标可到下一页',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-notice-fairness-'));const store=await openExecutionStore({dbPath:join(root,'control.db'),instanceId:'test',initialize:true});t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 const c=(kind,args)=>store.command({id:randomUUID(),kind:'message.'+kind,args})
 await c('receive',{runId:'m',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'a',body:'test'});await c('split',{runId:'m',units:[{unitId:'u'}]});await c('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'status',args:{}}]});const command=(await c('command.claim',{commandId:'c'})).result.command;await c('command.complete',{commandId:'c',leaseEpoch:command.leaseEpoch,result:{}})
 for(let i=0;i<202;i++){await c('notification.prepare',{runId:'m',commandId:'c',notificationId:'n'+i,payload:{text:'notice'+i},disclosure:{conversationId:'g',authorizationRef:'proof'}});if(i<201){const n=(await c('notification.claim',{notificationId:'n'+i})).result.notification;await c('notification.fail',{notificationId:'n'+i,leaseEpoch:n.leaseEpoch,error:'unknown'})}}
 const prepared=await store.query({kind:'message.notifications',states:['prepared'],limit:100});assert.deepEqual(prepared.map(n=>n.id),['n201'])
 const one=await store.query({kind:'message.notifications',states:['unknown'],limit:100}),two=await store.query({kind:'message.notifications',states:['unknown'],afterSequenceId:one.at(-1).sequenceId,limit:100});assert.equal(one.length,100);assert.equal(two.length,100);assert.notEqual(one[0].id,two[0].id)
})
test('旧活动Task不会被超过200条新终态任务挤出恢复索引',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-active-index-'));const store=await openExecutionStore({dbPath:join(root,'control.db'),instanceId:'test',initialize:true});t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
 const create=i=>command('run.create',{runId:'run'+i,taskId:'task'+i,workflowId:'w',workflowDigest:'a'.repeat(64),requirementRef:'sha/input',nodes:[{nodeId:'n',nodeVersion:'1',executor:'code',inputRef:'sha/input',inputDigest:'a'.repeat(64)}]})
 await create('old')
 for(let i=0;i<201;i++){await create(i);await command('run.stop',{runId:'run'+i,reason:'cancel'});await command('run.stopped',{runId:'run'+i})}
 assert.equal((await store.query({kind:'run.list',limit:200})).some(r=>r.runId==='runold'),false)
 assert.deepEqual((await store.query({kind:'run.list',limit:200,activeOnly:true})).map(r=>r.runId),['runold'])
})
