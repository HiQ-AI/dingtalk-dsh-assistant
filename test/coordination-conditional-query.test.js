import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t,{completed=false,daily=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'retired-conditional-query-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'conditional-test',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original goal'})
  if(completed){
    const binding=(await command('task.claim',{taskId:'A'})).result.binding
    await command('task.complete',{binding,summary:'Actual accepted delivery',result:{evidence:['original-proof']}})
    await command('task.drained',{binding})
  }
  const before=await query('task.get',{taskId:'A'})
  await store.close()
  const db=new DatabaseSync(options.dbPath)
  const put=(table,id,body)=>db.prepare('INSERT INTO dynamic_'+table+'(id,body) VALUES (?,?)').run(id,JSON.stringify({id,...body}))
  const originalCommand={id:'old-conditional-command',kind:'task.supplement',args:{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,
    messageId:'old-source',text:'Continue if incomplete',request:'original goal'}}
  try{
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    put('coordination','conditional',{groupId:'group',state:'active',revision:1,memberIds:['A']})
    put('coordination_members','A',{coordinationId:'conditional',taskId:'A',state:'ready',requiresTrigger:true,command:originalCommand})
    put('coordination_schedules','schedule',{coordinationId:'conditional',state:'active',timezone:'Asia/Shanghai',
      rule:daily?{kind:'daily',time:'09:00'}:{kind:'once',at:'2026-10-21T01:00:00.000Z'},
      nextDueAt:'2026-10-21T01:00:00.000Z',action:{kind:'read-query',taskIds:['A'],onIncomplete:{kind:'task-command',instructionIds:['A']}}})
    put('coordination_occurrences','occurrence',{coordinationId:'conditional',scheduleId:'schedule',actionState:'pending',jobId:'job',plannedAt:'2026-10-21T01:00:00.000Z'})
    put('coordination_jobs','job',{coordinationId:'conditional',occurrenceId:'occurrence',state:'pending',fence:1})
  }finally{db.close()}
  store=await openDynamicTaskStore({...options,initialize:false})
  return {command,query,before,originalCommand,async restart(){await store.close();store=await openDynamicTaskStore({...options,initialize:false})}}
}

test('a retired conditional continuation cannot apply itself; current Owner context requires an explicit current command',async t=>{
  const f=await fixture(t)
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),f.before)
  assert.equal(await f.query('receipt.get',{id:f.originalCommand.id}),null)
  assert.deepEqual(await f.query('execution.list',{taskId:'A'}),[])
  const old=(await f.query('coordination.get',{coordinationId:'conditional'})).members[0]
  assert.deepEqual(old.command,f.originalCommand);assert.equal(old.eligible,false)
  await f.command('task.supplement',{...f.originalCommand.args,messageId:'current-explicit-source',text:'Current authorized context'},'current-context')
  const after=await f.query('task.get',{taskId:'A'})
  assert.equal(after.contextRevision,1);assert.equal(after.requirementRevision,f.before.requirementRevision)
  assert.equal(after.runSequence,f.before.runSequence)
  await f.restart()
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision,1)
  assert.equal(await f.query('receipt.get',{id:f.originalCommand.id}),null)
})

test('retiring an old conditional job cannot reopen a completed Task or alter its accepted result',async t=>{
  const f=await fixture(t,{completed:true})
  const schedule=(await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.retirement.kind,'feature-removed')
  assert.equal(schedule.state,'active','Original schedule state remains audit, not a live scheduling instruction')
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),f.before)
  await f.restart()
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),f.before)
  assert.deepEqual(await f.query('notification.list'),[])
  assert.equal((await f.query('task.list')).length,1)
  await assert.rejects(f.command('task.supplement',f.originalCommand.args),{code:'DYNAMIC_TASK_NOT_ACTIVE'})
})

test('daily legacy templates remain frozen across repeated recovery and cannot manufacture per-slot task writes',async t=>{
  const f=await fixture(t,{daily:true})
  const schedule=(await f.query('coordination.schedule.list'))[0]
  const occurrences=await f.query('coordination.occurrence.list')
  const jobs=await f.query('coordination.job.list')
  for(let restart=0;restart<2;restart++){
    await f.restart()
    assert.deepEqual((await f.query('coordination.schedule.list'))[0],schedule)
    assert.deepEqual(await f.query('coordination.occurrence.list'),occurrences)
    assert.deepEqual(await f.query('coordination.job.list'),jobs)
    assert.deepEqual(await f.query('task.get',{taskId:'A'}),f.before)
    assert.equal(await f.query('receipt.get',{id:f.originalCommand.id}),null)
  }
  const args={...f.originalCommand.args,messageId:'new-request',text:'A new explicit request'}
  await f.command('task.supplement',args,'new-request-command')
  assert.equal((await f.command('task.supplement',args,'new-request-command')).replayed,true)
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision,1)
})

test('changed Task scope rejects the original frozen continuation rather than rebasing its expected version',async t=>{
  const f=await fixture(t)
  await f.command('task.revise',{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,request:'changed goal'})
  await assert.rejects(f.command(f.originalCommand.kind,f.originalCommand.args,f.originalCommand.id),{code:'DYNAMIC_TASK_REVISION_STALE'})
  await f.restart()
  assert.equal((await f.query('task.get',{taskId:'A'})).request,'changed goal')
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision??0,0)
  assert.equal(await f.query('receipt.get',{id:f.originalCommand.id}),null)
  const old=(await f.query('coordination.get',{coordinationId:'conditional'})).members[0]
  assert.deepEqual(old.command,f.originalCommand)
  assert.equal(old.eligible,false)
})
