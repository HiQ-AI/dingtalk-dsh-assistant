import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

test('retired pending-reorder graph remains audit while current Task Owners use only their actual resource leases',async t=>{
  const root=await mkdtemp(join(tmpdir(),'retired-effective-graph-'))
  const options={dbPath:join(root,'task.sqlite'),instanceId:'effective-graph',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
  const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
  for(const taskId of ['A','B'])await command('task.create',{taskId,groupId:'group',request:taskId})
  await store.close()
  const db=new DatabaseSync(options.dbPath)
  const put=(table,id,body)=>db.prepare('INSERT INTO dynamic_'+table+'(id,body) VALUES (?,?)').run(id,JSON.stringify({id,...body}))
  const graph={state:'cancelled',groupId:'group',revision:2,memberIds:['a','b']}
  const members=[
    {id:'a',taskId:'A',coordinationId:'old',state:'applied',dependencies:[],receipt:{commandId:'original-a'},
      reorderAssessment:{id:'pending-order',state:'pending',afterInstructionIds:['b']}},
    {id:'b',taskId:'B',coordinationId:'old',state:'ready',dependencies:['a']},
  ]
  try {
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    put('coordination','old',graph)
    for(const member of members)put('coordination_members',member.id,member)
  }finally{db.close()}
  store=await openDynamicTaskStore({...options,initialize:false})
  const history=await store.query({kind:'coordination.get',coordinationId:'old'})
  assert.equal(history.coordination.state,'cancelled')
  assert.equal(history.coordination.retirement.kind,'feature-removed')
  for(const original of members){
    const member=history.members.find(m=>m.id===original.id)
    assert.equal(member.state,original.state)
    assert.deepEqual(member.dependencies,original.dependencies)
    assert.deepEqual(member.receipt,original.receipt)
    assert.deepEqual(member.reorderAssessment,original.reorderAssessment)
    assert.equal(member.eligible,false)
  }
  const active=[]
  for(const taskId of ['B','A']){
    const binding=(await command('task.claim',{taskId})).result.binding
    const execution=(await command('execution.dispatch',{binding,key:'current-'+taskId,prompt:'Current authorized work',resourceKeys:['shared']})).result.execution
    assert.deepEqual(execution.instructionScope.instructionIds,[])
    active.push(execution)
  }
  const first=(await command('execution.claim',{executionId:active[0].id})).result.binding
  await assert.rejects(command('execution.claim',{executionId:active[1].id}),{code:'DYNAMIC_RESOURCE_BUSY'})
  await command('execution.result',{binding:first,output:{summary:'B actual result'}})
  await command('execution.drained',{binding:first})
  await command('execution.claim',{executionId:active[1].id})
  assert.equal((await store.query({kind:'resource.list'})).length,1)
  assert.deepEqual(await store.query({kind:'coordination.get',coordinationId:'old'}),history)
})
