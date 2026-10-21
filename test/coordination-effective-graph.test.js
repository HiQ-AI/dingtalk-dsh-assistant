import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

test('cancelled arrangement retires applied pending-reorder edges without deleting history or rejecting new opposite ordering',async t=>{
  const root=await mkdtemp(join(tmpdir(),'coordination-effective-graph-'))
  const store=await openDynamicTaskStore({dbPath:join(root,'task.sqlite'),instanceId:'effective-graph',initialize:true})
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
  const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
  const source=async unitId=>(await command('coordination.reserve',{unitId,revision:1,groupId:'group',original:unitId})).result.source
  for(const taskId of ['A','B'])await command('task.create',{taskId,groupId:'group',request:taskId})
  const member=(coordinationId,id,taskId,dependencies=[])=>({instructionId:id,taskId,progressImpact:'preserve',dependencies,
    command:{id:`coordination-command:${coordinationId}:${id}`,kind:'task.supplement',args:{taskId,expectedRequirementRevision:1,expectedControlRevision:1,
      messageId:`${coordinationId}:${id}`,text:'preserved material',request:taskId}}})
  const original=await source('original')
  await command('coordination.accept',{sourceId:original.id,fence:1,coordinationId:'old',members:[member('old','oldA','A'),member('old','oldB','B')]})
  await command('coordination.apply',{instructionId:'oldA',expectedRevision:1})
  const reorder=await source('reorder')
  await command('coordination.change',{sourceId:reorder.id,fence:1,coordinationId:'old',expectedRevision:1,
    change:{action:'reorder',dependencies:[{instructionId:'oldA',afterInstructionIds:['oldB']}]}})
  const proposed=await source('new-proposed')
  const accept=()=>command('coordination.accept',{sourceId:proposed.id,fence:1,coordinationId:'new',members:[
    member('new','newA','A'),member('new','newB','B',['newA'])]})
  await assert.rejects(accept(),{code:'DYNAMIC_COORDINATION_CYCLE'})
  await command('coordination.cancel',{coordinationId:'old',expectedRevision:2})
  await accept()
  const old=await store.query({kind:'coordination.get',coordinationId:'old'})
  assert.equal(old.coordination.state,'cancelled')
  assert.equal(old.members.find(m=>m.id==='oldA').state,'applied')
  assert.deepEqual(old.members.find(m=>m.id==='oldA').reorderAssessment.afterInstructionIds,['oldB'])
  assert.equal((await store.query({kind:'coordination.get',coordinationId:'new'})).members.length,2)
})
