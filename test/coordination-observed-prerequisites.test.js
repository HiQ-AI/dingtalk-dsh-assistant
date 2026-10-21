import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { freezeCoordinationMembers } from '../packages/dingtalk-dsh-assistant/coordination-task-commands.js'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'observe-prerequisite-'))
  const options = {dbPath:join(root,'tasks.db'),instanceId:'observe-test',initialize:true}
  let store = await openDynamicTaskStore(options)
  t.after(async()=>{await store.close(); await rm(root,{recursive:true,force:true})})
  const command=(kind,args,id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  for(const taskId of ['A','B']) await command('task.create',{taskId,groupId:'g',ownerActorId:'u',request:taskId})
  const reserve=async()=> (await command('coordination.reserve',{unitId:'source',revision:1,groupId:'g',original:'A任务处理完之后继续B任务',actorId:'u'})).result.source
  const arrange=async()=>{
    const source=await reserve(), tasks=new Map((await query('task.list')).map(t=>[t.taskId,t]))
    const proposal=coordinationProposalSchema.parse({kind:'arrangement',members:[
      {action:'task-observe',taskId:'A',inputVersion:tasks.get('A').requirementRevision,runSequence:tasks.get('A').runSequence},
      {action:'task-continue',taskId:'B',inputVersion:1,runSequence:1,progressImpact:'preserve',impactReason:'继续原目标',context:'A完成后继续',afterTaskIds:['A']}]})
    const members=freezeCoordinationMembers({coordinationId:'c',proposal,tasks,source:{...source,sourceId:source.id,unitRevision:source.revision,actorId:'u'}})
    await command('coordination.accept',{coordinationId:'c',sourceId:source.id,fence:source.fence,members})
    return members
  }
  const owner=async taskId=>(await command('task.claim',{taskId,force:true})).result.binding
  const complete=async taskId=>{const binding=await owner(taskId); const receipt=await command('task.complete',{binding,summary:'Owner正式验收',result:{evidence:['proof']}}); await command('task.drained',{binding}); return receipt}
  return {command,query,arrange,owner,complete,inject:fn=>{const db=new DatabaseSync(options.dbPath);try{fn(db)}finally{db.close()}},
    restart:async()=>{await store.close();store=await openDynamicTaskStore({...options,initialize:false})}}
}

for(const before of [true,false]) test(`observed A never receives a command or wake; authoritative completion survives restart: completedBefore=${before}`,async t=>{
  const f=await fixture(t)
  if(before) await f.complete('A')
  const original=await f.query('task.get',{taskId:'A'}), wakes=await f.query('wake.list',{taskId:'A'})
  const members=await f.arrange()
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),original)
  assert.deepEqual(await f.query('wake.list',{taskId:'A'}),wakes)
  await assert.rejects(f.command('coordination.apply',{instructionId:members[0].instructionId,expectedRevision:1}),{code:'DYNAMIC_COORDINATION_OBSERVATION_READ_ONLY'})
  if(!before) {
    assert.equal((await f.query('coordination.get',{coordinationId:'c'})).members[1].waitingReason.code,'waiting_dependency')
    await f.complete('A')
  }
  await f.restart()
  await f.command('coordination.observe.reconcile',{coordinationId:'c'})
  const observed=(await f.query('coordination.get',{coordinationId:'c'})).members[0]
  assert.equal(observed.state,'fulfilled'); assert.ok(observed.completionProof.taskDecisionReceiptId)
  const a=await f.query('task.get',{taskId:'A'})
  assert.equal(a.contextRevision,original.contextRevision);assert.equal(a.requirementRevision,original.requirementRevision);assert.equal(a.runSequence,original.runSequence)
  assert.deepEqual(a.completion.instructionIds,[])
  // Even after completion was seen, a changed target invalidates that proof.
  await f.command('task.reopen',{taskId:'A',expectedRequirementRevision:a.requirementRevision,expectedControlRevision:a.controlRevision,request:'new A target'})
  await f.command('coordination.observe.reconcile',{coordinationId:'c'})
  const state=await f.query('coordination.get',{coordinationId:'c'})
  assert.equal(state.members[0].state,'observing');assert.equal(state.members[0].completionProof,undefined)
  assert.ok(state.members[1].waitingReason)
})

test('completed status without a formal receipt cannot release observed prerequisite',async t=>{
  const f=await fixture(t), receipt=await f.complete('A')
  f.inject(db=>db.prepare('DELETE FROM dynamic_receipts WHERE id=?').run(receipt.taskDecision.id))
  await f.arrange();await f.command('coordination.observe.reconcile',{coordinationId:'c'})
  const state=await f.query('coordination.get',{coordinationId:'c'})
  assert.equal(state.members[0].state,'observing');assert.equal(state.members[0].waitingReason.code,'waiting_completion_proof')
  assert.equal(state.members[1].waitingReason.code,'waiting_dependency')
})

test('formal receipt without event can release once, but cancellation or pause never releases B',async t=>{
  const f=await fixture(t), receipt=await f.complete('A'), id=receipt.taskDecision.id
  f.inject(db=>{const row=db.prepare('SELECT body FROM dynamic_receipts WHERE id=?').get(id), body=JSON.parse(row.body)
    delete body.completionEvent;db.prepare('UPDATE dynamic_receipts SET body=? WHERE id=?').run(JSON.stringify(body),id)
    db.prepare('DELETE FROM dynamic_task_events WHERE id=?').run(`task-completed:${id}`)})
  const members=await f.arrange();await f.restart();await f.command('coordination.observe.reconcile',{coordinationId:'c'})
  const trigger={triggerKind:'business-event',eventSource:'task-decision-receipt',eventId:`task-decision:${id}`,actionId:members[1].instructionId}
  await f.command('coordination.occurrence.accept',{coordinationId:'c',trigger,action:{kind:'task-command',instructionIds:[members[1].instructionId]},
    target:{conversationId:'g',recipientIds:[],summaryOnly:true}})
  assert.equal((await f.query('coordination.occurrence.list')).length,1)
  for(const action of ['pause','cancel']) {
    const source=(await f.command('coordination.reserve',{unitId:action,revision:1,groupId:'g',original:action})).result.source
    const coordination=(await f.query('coordination.get',{coordinationId:'c'})).coordination
    await f.command('coordination.change',{sourceId:source.id,fence:source.fence,coordinationId:'c',expectedRevision:coordination.revision,
      change:{action,instructionIds:[members[0].instructionId],reason:action}})
    const state=await f.query('coordination.get',{coordinationId:'c'})
    assert.equal(state.members[1].waitingReason.code,'waiting_dependency')
    assert.equal((await f.query('task.get',{taskId:'A'})).status,'completed')
  }
})

test('first order on running B requires read-only Owner assessment and never stops existing work',async t=>{
  const f=await fixture(t), binding=await f.owner('B')
  const execution=(await f.command('execution.dispatch',{binding,key:'old',prompt:'old B',input:{},resourceKeys:[]})).result.execution
  await f.command('execution.claim',{executionId:execution.id})
  const before=await f.query('task.get',{taskId:'B'}), members=await f.arrange()
  const pending=(await f.query('coordination.get',{coordinationId:'c'})).members[1]
  assert.equal(pending.waitingReason.code,'reorder_pending');assert.deepEqual(await f.query('task.get',{taskId:'B'}),before)
  assert.equal((await f.query('execution.get',{executionId:execution.id})).cancelRequested,false)
  await assert.rejects(f.command('task.complete',{binding,summary:'skip assessment'}),{code:'DYNAMIC_COORDINATION_ASSESSMENT_REQUIRED'})
  await f.command('coordination.reorder.assess',{binding,instructionId:members[1].instructionId,assessmentId:pending.reorderAssessment.id,
    decision:'continue_existing',summary:'保留已开始B，仅后续输入等待A',evidence:['原B输入已认领']})
  assert.equal((await f.query('coordination.get',{coordinationId:'c'})).members[1].waitingReason.code,'waiting_dependency')
})

test('continue never silently reopens an already completed B',async t=>{
  const f=await fixture(t);await f.complete('B')
  const before=await f.query('task.get',{taskId:'B'})
  await assert.rejects(f.arrange(),{code:'COORDINATION_REOPEN_REQUIRED'})
  assert.deepEqual(await f.query('task.get',{taskId:'B'}),before)
})

for(const action of ['append','resolve-members']) test(`running B first receives assessment when added through ${action}`,async t=>{
  const f=await fixture(t), binding=await f.owner('B')
  const originalA=await f.query('task.get',{taskId:'A'})
  const execution=(await f.command('execution.dispatch',{binding,key:'old',prompt:'old B',input:{},resourceKeys:[]})).result.execution
  await f.command('execution.claim',{executionId:execution.id})
  const source=(await f.command('coordination.reserve',{unitId:'original',revision:1,groupId:'g',original:'A完成后继续目标待澄清'})).result.source
  const observer={instructionId:'a',taskId:'A',observation:true,dependencies:[],command:{id:'coordination-command:c:a',kind:'coordination.observe',
    args:{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,expectedContextRevision:0,expectedRunSequence:1}}}
  await f.command('coordination.accept',{coordinationId:'c',sourceId:source.id,fence:source.fence,members:[observer],
    ...(action==='resolve-members'?{pendingClarifications:[{clarificationId:'b-question',question:'哪个B',candidates:['B']}]}:{})})
  const changeSource=(await f.command('coordination.reserve',{unitId:'reply',revision:1,groupId:'g',original:'明确B'})).result.source
  await f.command('coordination.change',{sourceId:changeSource.id,fence:changeSource.fence,coordinationId:'c',expectedRevision:1,
    change:{action,...(action==='resolve-members'?{clarificationIds:['b-question']}:{}),members:[{instructionId:'b',taskId:'B',dependencies:['a'],
      progressImpact:'preserve',command:{id:'coordination-command:c:b',kind:'task.supplement',args:{taskId:'B',text:'A之后继续B',request:'B',
        expectedRequirementRevision:1,expectedControlRevision:1}}}]}})
  const b=(await f.query('coordination.get',{coordinationId:'c'})).members.find(x=>x.id==='b')
  assert.equal(b.reorderAssessment.state,'pending');assert.equal(b.reorderAssessment.revision,2)
  assert.equal((await f.query('execution.get',{executionId:execution.id})).cancelRequested,false)
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),originalA)
})
