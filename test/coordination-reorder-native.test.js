import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {available,reason,nativeTaskHost,latestInput,modelToolValues,topicTaskCalls} from './fixtures/task-session-native-host.js'

test('chat reorder wakes the original Owner into a read-only assessment and commits the validated safe-point receipt',
  {skip:!available?reason:false,timeout:20000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'coordination-reorder-native-'));let host
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,request=>{
      const names=request.tools.map(tool=>tool.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit'))return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(message=>({messageId:message.messageId,messageVersion:message.messageVersion,ignoredRefs:[],
          units:[{unitKey:'reorder',summary:'修改原安排顺序',sourceRefs:[{quote:message.text}],dispatchOwner:'coordination',topics:[],reason:'原任务顺序改口'}]}))}}]
      if(names.includes('coordination_submit')){
        if(!modelToolValues(request).some(value=>value.arrangementContexts?.length))return [{name:'coordination_context_get',args:{coordinationIds:['batch']}}]
        return [{name:'coordination_submit',args:{kind:'change',coordinationId:'batch',expectedRevision:1,
          change:{action:'reorder',reason:'已运行B后续工作等待A',dependencies:[{instructionId:'b',afterInstructionIds:['a']}]}}}]
      }
      if(names.includes('task_session_submit')){
        const pending=input.coordinationAssessments?.find(item=>item.state==='pending')
        const done=modelToolValues(request).some(value=>value.member?.reorderAssessment?.state==='assessed')
        if(pending&&!done)return [{name:'task_coordination_reorder_assess',args:{instructionId:pending.instructionId,
          assessmentId:pending.id,decision:'safe_point',summary:'无在途执行或未知操作，后续工作等待前置结果。',evidence:['Host执行及操作账本为空']}}]
        return [{name:'task_session_submit',args:{decision:{action:'wait',summary:'保留原任务，按已确认顺序等待。',evidence:[],limitations:[]}}}]
      }
      return topicTaskCalls(request)??[]
    },{config:{coordination:{enabled:true,provider:'native-task-test',model:'coordination-controlled'}}})
    const command=(id,kind,args)=>host.service.store.command({id,kind,args})
    for(const taskId of ['A','B'])await command(`create:${taskId}`,'task.create',{taskId,groupId:'native-group',ownerActorId:'native-user',request:taskId})
    const source=(await command('reserve','coordination.reserve',{unitId:'original',revision:1,groupId:'native-group',original:'处理A和B'})).result.source
    await command('accept','coordination.accept',{sourceId:source.id,fence:source.fence,coordinationId:'batch',members:['A','B'].map(taskId=>({
      instructionId:taskId.toLowerCase(),taskId,progressImpact:'preserve',dependencies:[],command:{id:`coordination-command:batch:${taskId.toLowerCase()}`,
        kind:'task.supplement',args:{taskId,expectedRequirementRevision:1,expectedControlRevision:1,messageId:`material:${taskId}`,text:'定位材料',request:taskId}}}))})
    await command('apply-b','coordination.apply',{instructionId:'b',expectedRevision:1})
    await host.service.recover();await host.service.whenIdle()
    const before=await host.query('task.get',{taskId:'B'})
    await host.service.ingest({groupId:'native-group',messageId:'reorder',senderOpenDingTalkId:'native-user',senderName:'测试用户',
      text:'测试助手，改成先完成A，再推进B后续工作。',timestamp:'2026-10-21T01:00:00Z'})
    await host.service.whenIdle()
    const state=await host.query('coordination.get',{coordinationId:'batch'}),member=state.members.find(item=>item.id==='b')
    assert.equal(member.reorderAssessment?.decision,'safe_point',JSON.stringify({member,alerts:host.service.listAlerts(),
      tools:host.toolResults.filter(item=>item.name.startsWith('task_coordination')||item.name==='task_session_submit')}))
    assert.deepEqual(member.dependencies,['a'])
    assert.equal(member.waitingReason.code,'waiting_dependency')
    assert.ok(member.reorderAssessment.ownerBinding.sessionId)
    assert.equal((await host.query('execution.list',{taskId:'B'})).length,0)
    const after=await host.query('task.get',{taskId:'B'})
    for(const key of ['requirementRevision','contextRevision','controlRevision','runSequence'])assert.equal(after[key],before[key])
    assert.equal((await host.query('task.list')).length,2)
    assert.equal(host.residentStore.listTopics('native-group').length,0)
  })
