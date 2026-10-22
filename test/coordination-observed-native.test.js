import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { available, reason, nativeTaskHost, latestInput, modelToolValues } from './fixtures/task-session-native-host.js'

for (const [mode,scheduled] of [['completed-A',false],['waiting-A',false],['paused-B',false],['completed-A',true],['waiting-A',true]]) test(`actual chat observes A without mutation and resumes original B: ${mode}, scheduled=${scheduled}`,
  {skip:!available?reason:false,timeout:20000},async t=>{
    if(scheduled)t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'observed-native-'));let h, admitted=false, plans=0
    const ownerSessions=[]
    const decide=request=>{
      const names=request.tools.map(x=>x.name), input=latestInput(request)
      if(names.includes('group_topic_route_submit')) return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(m=>({messageId:m.messageId,messageVersion:m.messageVersion,ignoredRefs:[],units:[{unitKey:'order',summary:'只观察A后继续B',
          sourceRefs:[{quote:m.text}],dispatchOwner:'coordination',topics:[],reason:'原任务依赖'}]}))}}]
      if(names.includes('coordination_submit')) {
        const context=modelToolValues(request).find(v=>v.taskContexts?.length===2)
        if(!context)return [{name:'coordination_context_get',args:{taskIds:['A','B']}}]
        const [a,b]=['A','B'].map(id=>context.taskContexts.find(x=>x.taskId===id));plans++
        return [{name:'coordination_submit',args:{...(scheduled?{kind:'schedule',actionKind:'task-command',timezone:'Asia/Shanghai',rule:{kind:'once',at:'2026-10-21T01:00:00.000Z'},recipientIds:[],interpretation:'九点后等原A完成再继续B'}:{kind:'arrangement'}),members:[
          {action:'task-observe',taskId:'A',inputVersion:a.requirementRevision,runSequence:a.runSequence},
          {action:'task-continue',taskId:'B',inputVersion:b.requirementRevision,runSequence:b.runSequence,progressImpact:'preserve',
            impactReason:'继续原目标',context:'A完成后继续B',afterTaskIds:['A']}]}}]
      }
      if(names.includes('task_session_submit')) {
        if(input.task.taskId==='B')ownerSessions.push(input.task.sessionId)
        const complete=input.task.taskId==='A'?mode==='completed-A':admitted
        return [{name:'task_session_submit',args:{decision:{action:complete?'complete':'wait',summary:complete?'Owner正式验收':'等待后续',evidence:complete?['proof']:[],limitations:[]}}}]
      }
      return []
    }
    const open=initialize=>nativeTaskHost(root,decide,{initialize,config:{coordination:{enabled:true,provider:'native-task-test',model:'controlled'}}})
    h=await open(true);t.after(async()=>{await h?.close();await rm(root,{recursive:true,force:true})})
    const cmd=(kind,args)=>h.service.store.command({id:randomUUID(),kind,args})
    for(const taskId of ['A','B'])await cmd('task.create',{taskId,groupId:'native-group',ownerActorId:'native-user',request:taskId})
    await h.service.recover();await h.service.whenIdle()
    if(mode==='paused-B') {const b=await h.query('task.get',{taskId:'B'});await cmd('task.control',{taskId:'B',expectedControlRevision:b.controlRevision,control:'paused',reason:'existing pause'})}
    const aBefore=await h.query('task.get',{taskId:'A'}), aWakes=await h.query('wake.list',{taskId:'A'}), bBefore=await h.query('task.get',{taskId:'B'})
    admitted=true
    await h.service.ingest({groupId:'native-group',messageId:'order',senderOpenDingTalkId:'native-user',text:scheduled?'九点以后等A任务处理完之后继续B任务':'A任务处理完之后继续B任务',timestamp:'2026-10-21T01:00:00Z'})
    await h.service.whenIdle()
    assert.equal(plans,1,JSON.stringify(h.service.listAlerts()))
    if(scheduled) {
      assert.deepEqual(await h.query('task.get',{taskId:'B'}),bBefore)
      t.mock.timers.tick(3600000);await h.service.recover();await h.service.whenIdle()
    }
    assert.deepEqual(await h.query('task.get',{taskId:'A'}),aBefore)
    assert.deepEqual(await h.query('wake.list',{taskId:'A'}),aWakes)
    if(mode!=='completed-A') {
      assert.deepEqual(await h.query('task.get',{taskId:'B'}),bBefore)
      await h.close();h=await open(false);await h.service.recover();await h.service.whenIdle()
      assert.deepEqual(await h.query('task.get',{taskId:'A'}),aBefore)
      const binding=(await cmd('task.claim',{taskId:'A',force:true})).result.binding
      await cmd('task.complete',{binding,summary:'原A正式完成',result:{evidence:['original-A-proof']}})
      await cmd('task.drained',{binding});await h.service.recover();await h.service.whenIdle()
    }
    const b=await h.query('task.get',{taskId:'B'})
    assert.equal(b.status,'completed',JSON.stringify(h.service.listAlerts()))
    assert.equal(b.sessionId,bBefore.sessionId);assert.equal(b.runSequence,bBefore.runSequence)
    assert.ok(ownerSessions.every(id=>id===bBefore.sessionId))
    assert.equal((await h.query('task.get',{taskId:'A'})).contextRevision,aBefore.contextRevision)
    const coordination=(await h.query('coordination.list'))[0], state=await h.query('coordination.get',{coordinationId:coordination.id})
    assert.equal(state.members[0].observation,true);assert.equal(state.members[0].hostHandoffAt,undefined)
    assert.equal(state.members[1].state,'fulfilled')
    await h.service.recover();await h.service.whenIdle();assert.equal(plans,1)
  })
