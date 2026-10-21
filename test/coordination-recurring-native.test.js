import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'

test('chat daily Task command reaches two original Owner inputs with distinct slot identities and no replanning confirmation',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root = await mkdtemp(join(tmpdir(),'coordination-recurring-native-'))
    let host, plans=0
    const ownerInputs=[]
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host = await nativeTaskHost(root,request=>{
      const names=request.tools.map(tool=>tool.name), input=latestInput(request)
      if(names.includes('group_topic_route_submit')) return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(message=>({messageId:message.messageId,messageVersion:message.messageVersion,ignoredRefs:[],
          units:[{unitKey:'daily',summary:'每天给原任务补充固定材料',sourceRefs:[{quote:message.text}],dispatchOwner:'coordination',topics:[],reason:'独立周期安排'}]}))}}]
      if(names.includes('coordination_submit')) {
        const task=modelToolValues(request).find(value=>value.taskContexts?.length)?.taskContexts[0]
        if(!task) return [{name:'coordination_context_get',args:{taskIds:['A']}}]
        plans++
        return [{name:'coordination_submit',args:{kind:'schedule',actionKind:'task-command',timezone:'Asia/Shanghai',rule:{kind:'daily',time:'09:00'},
          members:[{action:'task-context',taskId:'A',inputVersion:task.requirementRevision,runSequence:task.runSequence,
            progressImpact:'preserve',impactReason:'固定材料，原目标与授权不变',context:'每天核对已授权原目标',afterTaskIds:[]}],recipientIds:[],interpretation:'每天09:00 Asia/Shanghai 给原任务A补充固定核对材料'}}]
      }
      const topic=topicTaskCalls(request);if(topic)return topic
      if(names.includes('task_session_submit')) {
        ownerInputs.push(...input.wakes.filter(wake=>wake.kind==='task.supplement').map(wake=>wake.payload.contextRevision))
        return [{name:'task_session_submit',args:{decision:{action:'wait',summary:'保持原目标并处理固定补充',evidence:[],limitations:[]}}}]
      }
      return []
    },{config:{coordination:{enabled:true,provider:'native-task-test',model:'coordination-controlled'}}})
    await host.service.store.command({id:'seed:A',kind:'task.create',args:{taskId:'A',groupId:'native-group',ownerActorId:'native-user',request:'原任务A'}})
    await host.service.ingest({groupId:'native-group',messageId:'daily',senderOpenDingTalkId:'native-user',senderName:'测试用户',
      text:'测试助手，每天九点给原任务A补充固定核对材料，保持原目标和范围。',timestamp:'2026-10-21T00:00:00Z'})
    await host.service.whenIdle()
    assert.equal(plans,1,JSON.stringify(host.service.listAlerts()))
    for(const elapsed of [3600000,86400000]) {
      t.mock.timers.tick(elapsed);await host.service.recover();await host.service.whenIdle()
    }
    const task=await host.query('task.get',{taskId:'A'})
    assert.equal(task.contextRevision,2,JSON.stringify(host.service.listAlerts()))
    assert.equal(task.requirementRevision,1);assert.equal(task.runSequence,1);assert.equal(plans,1)
    assert.ok(ownerInputs.includes(1));assert.ok(ownerInputs.includes(2))
    const occurrences=await host.query('coordination.occurrence.list')
    assert.equal(occurrences.length,2)
    assert.ok(occurrences.every(occurrence=>occurrence.actionState==='succeeded' && occurrence.deliveryState==='delivered'))
    assert.notEqual(occurrences[0].action.instructionIds[0],occurrences[1].action.instructionIds[0])
    const state=await host.query('coordination.get',{coordinationId:occurrences[0].coordinationId})
    assert.ok(state.members.filter(member=>member.recurringOccurrenceId).every(member=>member.hostHandoffAt))
    assert.equal((await host.query('task.list')).length,1)
  })
