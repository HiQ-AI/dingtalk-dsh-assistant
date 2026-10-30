import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'owner-races-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'isolated-races',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original A'})
  return {command,query,async restart(){await store.close();store=await openDynamicTaskStore({...options,initialize:false})},
    async question(){
      const binding=(await command('task.claim',{taskId:'A'})).result.binding
      await command('task.wait',{binding,summary:'Need the target environment',question:'Which environment?',
        humanRequest:{requestId:'question',audience:'requester'},evidence:[]})
      await command('task.drained',{binding})
      return (await command('notification.prepare',{kind:'question',notificationId:'notice',taskId:'A',requirementRevision:1,
        payload:{conversationId:'group',humanRequestId:'question',audience:'requester',text:'Which environment?'}})).result.notification
    }}
}

const permutations=values=>values.length ? values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[v,...rest])) : [[]]

// The retired cross-Task scheduler no longer owns these races. These tests keep
// the current single-writer guarantees at the Task Owner command boundary.
for(const order of permutations(['revise','supplement','claim'])) test('Task revision, original supplement and Owner claim linearize: '+order.join('/'),async t=>{
  const f=await fixture(t)
  const actions={
    revise:()=>f.command('task.revise',{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,request:'new A'},'revise'),
    supplement:()=>f.command('task.supplement',{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,
      messageId:'original-supplement',text:'original evidence',request:'original A with evidence'},'supplement'),
    claim:()=>f.command('task.claim',{taskId:'A'},'claim'),
  }
  const results=await Promise.allSettled(order.map(name=>actions[name]()))
  const byName=Object.fromEntries(order.map((name,i)=>[name,results[i]]))
  assert.equal(byName.revise.status,'fulfilled')
  assert.equal(byName.claim.status,'fulfilled')
  const oldScopeAccepted=order.indexOf('supplement')<order.indexOf('revise')
  assert.equal(byName.supplement.status,oldScopeAccepted?'fulfilled':'rejected')
  if(!oldScopeAccepted) assert.equal(byName.supplement.reason.code,'DYNAMIC_TASK_REVISION_STALE')
  const current=await f.query('task.get',{taskId:'A'})
  assert.equal(current.request,'new A')
  assert.equal(current.requirementRevision,2)
  assert.equal(current.contextRevision??0,oldScopeAccepted?1:0)
  const claimed=byName.claim.value.result.binding
  assert.equal(claimed.requirementRevision,order.indexOf('claim')<order.indexOf('revise')?1:2)
  await assert.rejects(f.command('task.claim',{taskId:'A'}),{code:'DYNAMIC_TASK_BUSY'})
  await f.restart()
  const recovered=await f.query('task.get',{taskId:'A'})
  assert.equal(recovered.request,'new A')
  assert.equal(recovered.requirementRevision,2)
  assert.equal(recovered.contextRevision??0,oldScopeAccepted?1:0)
  assert.equal((await f.query('task.list')).length,1)
  assert.equal((await f.query('execution.list',{taskId:'A'})).length,0)
  assert.equal((await f.query('wake.list',{taskId:'A'})).filter(w=>w.kind==='task.supplement').length,oldScopeAccepted?1:0)
})

for(const first of ['cancel','permit']) test('Task cancellation and question send permit preserve their committed order: '+first,async t=>{
  const f=await fixture(t),notification=await f.question()
  const actions={cancel:()=>f.command('task.control',{taskId:'A',expectedControlRevision:1,control:'cancelled'}),
    permit:()=>f.command('notification.start',{notificationId:notification.id},'original-permit')}
  const order=first==='cancel'?['cancel','permit']:['permit','cancel']
  const results=await Promise.all(order.map(name=>actions[name]()))
  assert.equal(results[order.indexOf('permit')].dispatchEligible===true,first==='permit')
  await f.restart()
  assert.equal((await f.command('notification.start',{notificationId:notification.id},'original-permit')).dispatchEligible,false)
  assert.notEqual((await f.command('notification.start',{notificationId:notification.id})).dispatchEligible,true)
  const current=await f.query('notification.get',{notificationId:notification.id})
  assert.equal(current.state,first==='permit'?'unknown':'failed')
  assert.deepEqual(current.payload,notification.payload)
  assert.equal(current.sendAttemptCount??0,first==='permit'?1:0)
  assert.equal((await f.query('task.get',{taskId:'A'})).control,'cancelled')
})

for(const first of ['first','second']) test('competing send claims issue one durable permit and never replace frozen content: '+first,async t=>{
  const f=await fixture(t),notification=await f.question()
  const order=first==='first'?['first','second']:['second','first']
  const result=await Promise.all(order.map(id=>f.command('notification.start',{notificationId:notification.id},id)))
  assert.equal(result.filter(r=>r.dispatchEligible===true).length,1)
  const permitted=result.find(r=>r.dispatchEligible).result.notification
  assert.equal(permitted.sendAttemptCount,1)
  await f.command('notification.receipt',{notificationId:notification.id,dispatchToken:permitted.dispatchToken,state:'unknown',
    error:{phase:'send',message:'Outcome unknown'}})
  await f.restart()
  const current=await f.query('notification.get',{notificationId:notification.id})
  assert.equal(current.state,'unknown')
  assert.deepEqual(current.payload,notification.payload)
  assert.equal(current.dispatchToken,permitted.dispatchToken)
  assert.equal(current.sendAttemptCount,1)
  for(const id of order) assert.equal((await f.command('notification.start',{notificationId:notification.id},id)).dispatchEligible,false)
  await assert.rejects(f.command('notification.prepare',{kind:'question',notificationId:'notice',taskId:'A',requirementRevision:1,
    payload:{...notification.payload,text:'An unsafe replacement'}}),{code:'DYNAMIC_NOTIFICATION_ID_CONFLICT'})
})
