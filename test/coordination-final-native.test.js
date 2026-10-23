import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {available,reason,nativeTaskHost,latestInput,modelToolValues,topicTaskCalls} from './fixtures/task-session-native-host.js'
import {projectTaskNotification} from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import {residentDomainSpec} from '../packages/dingtalk-dsh-assistant/store.js'
import {formatCoordinationTime} from '../packages/dingtalk-dsh-assistant/coordination-summary.js'

const model={enabled:true,provider:'native-task-test',model:'coordination-controlled'}
const wait=request=>topicTaskCalls(request)??(request.tools.some(t=>t.name==='task_session_submit')
  ? [{name:'task_session_submit',args:{decision:{action:'wait',summary:'保持原任务目标',evidence:[],limitations:[]}}}] : [])

test('expired no-Topic query reaches the real outbox once after offline restart without reopening its Task',
  {skip:!available?reason:false,timeout:20000},async t=>{
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'coordination-expired-native-'));let host
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,wait)
    const command=(kind,args,id=kind)=>host.service.store.command({id,kind,args})
    await command('task.create',{taskId:'A',groupId:'native-group',ownerActorId:'native-user',request:'原目标'})
    const binding=(await command('task.claim',{taskId:'A'})).result.binding
    await command('task.complete',{binding,summary:'已有正式结果',result:{evidence:['original-completion']}})
    await command('task.drained',{binding})
    const before=await host.query('task.get',{taskId:'A'})
    const source=(await command('coordination.reserve',{unitId:'expired-source',revision:1,groupId:'native-group',original:'九点查询A'})).result.source
    await command('coordination.accept',{coordinationId:'expired-query',sourceId:source.id,fence:source.fence,members:[],readOnly:true,
      schedule:{scheduleId:'nine',timezone:'Asia/Shanghai',rule:{kind:'once',at:'2026-10-21T01:00:00.000Z'},
        action:{kind:'read-query',taskIds:['A']},target:{conversationId:'native-group',recipientIds:['native-user']}}})
    await host.close();t.mock.timers.tick(76*60000)
    host=await nativeTaskHost(root,wait,{initialize:false})
    await host.service.recover();await host.service.whenIdle()
    const sent=host.sent.filter(n=>n.payload.fact.coordinationId==='expired-query')
    assert.equal(sent.length,1,JSON.stringify(host.service.listAlerts()))
    assert.match(sent[0].payload.text,/已过期，本次未执行/);assert.ok(sent[0].payload.text.includes(formatCoordinationTime('2026-10-21T01:00:00Z')))
    assert.deepEqual(sent[0].payload.atOpenDingTalkIds,['native-user'])
    assert.equal((await host.query('notification.get',{notificationId:sent[0].id})).state,'delivered')
    assert.equal((await host.query('coordination.occurrence.list'))[0].actionState,'expired')
    assert.deepEqual(await host.query('coordination.job.list'),[])
    assert.deepEqual(await host.query('task.get',{taskId:'A'}),before)
    await host.close();host=await nativeTaskHost(root,wait,{initialize:false})
    await host.service.recover();await host.service.whenIdle()
    assert.equal(host.sent.length,0)
    const outbox=host.residentStore.getGroup('native-group').outbox.filter(o=>o.outboundId===sent[0].id)
    assert.equal(outbox.length,1);assert.equal(outbox[0].status,'sent');assert.equal(outbox[0].notificationState,'delivered')
  })

test('competing actual ingress and recovery reserve one source, plan once and keep original receipt after restart',
  {skip:!available?reason:false,timeout:20000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'coordination-final-ingress-'));let host,plans=0
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    const decide=request=>{
      const names=request.tools.map(t=>t.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit'))return[{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(message=>({messageId:message.messageId,messageVersion:message.messageVersion,ignoredRefs:[],
          units:[{unitKey:'one',summary:'同一补充',sourceRefs:[{quote:message.text}],dispatchOwner:'coordination',topics:[],reason:'原任务补充'}]}))}}]
      if(names.includes('coordination_submit')){
        const task=modelToolValues(request).flatMap(v=>v.taskContexts??[]).find(t=>t.taskId==='A')
        if(!task)return[{name:'coordination_context_get',args:{taskIds:['A']}}]
        plans++;return[{name:'coordination_submit',args:{kind:'arrangement',members:[{taskId:'A',action:'task-context',inputVersion:task.requirementRevision,
          runSequence:task.runSequence,progressImpact:'preserve',impactReason:'原目标不变',context:'唯一定位材料'}]}}]
      }
      return wait(request)
    }
    host=await nativeTaskHost(root,decide,{config:{coordination:model}})
    await host.service.store.command({id:'seed',kind:'task.create',args:{taskId:'A',groupId:'native-group',ownerActorId:'native-user',request:'原目标'}})
    const message={groupId:'native-group',messageId:'same',senderOpenDingTalkId:'native-user',senderName:'测试用户',text:'测试助手，给A补充唯一定位材料。',timestamp:'2026-10-21T00:00:00Z'}
    await Promise.all([host.service.ingest(message),host.service.ingest(message),host.service.recover()]);await host.service.whenIdle()
    assert.equal(plans,1,JSON.stringify(host.service.listAlerts()))
    assert.equal((await host.query('task.get',{taskId:'A'})).contextRevision,1)
    assert.equal(host.residentStore.listSourceDispatchOwnership('native-group').length,1)
    const members=(await host.query('coordination.get',{coordinationId:(await host.query('coordination.list'))[0].id})).members
    assert.equal(members.length,1);const receipt=members[0].receipt
    await host.close();host=await nativeTaskHost(root,decide,{initialize:false,config:{coordination:model}})
    await Promise.all([host.service.recover(),host.service.ingest(message)]);await host.service.whenIdle()
    assert.equal(plans,1);assert.equal((await host.query('task.get',{taskId:'A'})).contextRevision,1)
    assert.deepEqual((await host.query('coordination.get',{coordinationId:members[0].coordinationId})).members[0].receipt,receipt)
  })

for(const topology of ['closed','deleted']) test(`automatic expired result refresh restores one outbox after restart with ${topology} optional Topic`,
  {skip:!available?reason:false,timeout:20000},async t=>{
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'coordination-final-refresh-'));let host
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,wait)
    const command=(kind,args,id=kind)=>host.service.store.command({id,kind,args})
    await command('task.create',{taskId:'A',groupId:'native-group',ownerActorId:'native-user',request:'原目标'})
    await host.residentStore.ingest({groupId:'native-group',messageId:'context',text:'仅对话上下文',occurredAt:'2026-10-21T00:00:00Z',senderName:'测试用户',senderOpenDingTalkId:'native-user'})
    await host.residentStore.routeMessages({groupId:'native-group',routeId:'context-route',routingRevision:0,routes:[{messageId:'context',messageVersion:1,topics:[{newTopicKey:'optional',title:'可选上下文'}]}]})
    const topicId=host.residentStore.listTopics('native-group')[0].topicId
    const source=(await command('coordination.reserve',{unitId:'query',revision:1,groupId:'native-group',original:'一次查询'})).result.source
    await command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'query',readOnly:true,members:[],topicRefs:[{groupId:'native-group',topicId}]})
    await command('coordination.schedule.create',{coordinationId:'query',scheduleId:'schedule',timezone:'Asia/Shanghai',rule:{kind:'once',at:'2026-10-21T00:01:00.000Z'},
      action:{kind:'read-query',taskIds:['A']},target:{conversationId:'native-group',recipientIds:[]}})
    t.mock.timers.tick(60000)
    const occurrence=(await command('coordination.schedule.scan',{})).result.occurrences[0]
    const job=(await command('coordination.job.claim',{jobId:occurrence.jobId})).result.job
    await command('coordination.job.read',{jobId:job.id,fence:job.fence})
    const old=(await command('coordination.notification.freeze',{occurrenceId:occurrence.id})).result.notification
    await projectTaskNotification({residentStore:host.residentStore,notification:old})
    // Isolated storage lifecycle fixture: no Topic deletion API is introduced.
    const domain=host.ctx.storageDomain.get(residentDomainSpec.name),groups=domain.table('groups')
    const group=structuredClone(groups.get('native-group'))
    if(topology==='deleted')group.topics=[];else group.topics[0].status='closed'
    await groups.put('native-group',group)
    await host.close();t.mock.timers.tick(300001)
    host=await nativeTaskHost(root,wait,{initialize:false})
    await host.service.recover();await host.service.whenIdle()
    const current=await host.query('coordination.occurrence.get',{occurrenceId:occurrence.id})
    assert.equal(current.resultVersion,2,JSON.stringify(host.service.listAlerts()))
    assert.equal(current.deliveryState,'delivered');assert.notEqual(current.notificationId,old.id)
    assert.equal((await host.query('notification.get',{notificationId:old.id})).state,'superseded')
    assert.equal((await host.query('coordination.schedule.list'))[0].state,'completed')
    const oldOutbound=host.residentStore.getGroup('native-group').outbox.find(o=>o.outboundId===old.id)
    assert.equal(oldOutbound.status,'superseded')
    const sends=host.sent.filter(n=>n.payload.fact.occurrenceId===occurrence.id)
    assert.equal(sends.length,1);assert.equal(sends[0].id,current.notificationId)
    await host.service.recover();await host.service.whenIdle()
    assert.equal(host.sent.filter(n=>n.payload.fact.occurrenceId===occurrence.id).length,1)
    assert.equal((await host.query('task.get',{taskId:'A'})).runSequence,1)
  })
