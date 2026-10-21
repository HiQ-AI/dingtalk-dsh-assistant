import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'

const config = { coordination: { enabled: true, provider: 'native-task-test', model: 'coordination-controlled' } }
const unitRoute = input => [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
  routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
    units: [{ unitKey: 'independent', summary: '独立协调请求', sourceRefs: [{ quote: message.text }],
      dispatchOwner: 'coordination', topics: [], reason: '独立于Topic的安排及关联改口' }] })) } }]
const arrangement = taskContexts => ({ kind: 'arrangement', commonContext: '', members: taskContexts.map(task => ({ taskId: task.taskId,
  action: 'task-context', inputVersion: task.requirementRevision, runSequence: task.runSequence,
  progressImpact: 'preserve', impactReason: '只增加定位材料，不改变目标或验收', context: `${task.taskId}新材料`,
  afterTaskIds: task.taskId === 'B' ? ['A'] : [] })) })
const ownerWait = { name: 'task_session_submit', args: { decision: { action: 'wait', summary: '原Owner接收材料，等待独立业务结果', evidence: [], limitations: [] } } }
async function seed(host) {
  for (const taskId of ['B','A']) await host.service.store.command({ id: `seed:${taskId}`, kind: 'task.create',
    args: { taskId, groupId: 'native-group', ownerActorId: 'native-user', request: `原目标${taskId}` } })
}
const message = (messageId, text) => ({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'native-user', senderName: '测试用户', text,
  timestamp: '2026-10-21T01:00:00Z' })

test('native scheduled query releases an explicitly authorized continuation only after fresh incomplete facts',
  {skip:!available?reason:false,timeout:20000},async t=>{
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'conditional-native-'));let host
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,request=>{
      const names=request.tools.map(t=>t.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit'))return unitRoute(input)
      if(names.includes('coordination_submit')){
        const full=modelToolValues(request).find(v=>v.taskContexts?.some(task=>task.taskId==='A'))
        if(!full)return [{name:'coordination_context_get',args:{taskIds:['A']}}]
        const task=full.taskContexts.find(task=>task.taskId==='A')
        return [{name:'coordination_submit',args:{kind:'schedule',actionKind:'read-query',timezone:'Asia/Shanghai',
          rule:{kind:'once',at:'2026-10-21T00:01:00.000Z'},taskIds:['A'],recipientIds:[],interpretation:'一分钟后查A，未完成则按原目标继续',
          conditionalMembers:[{taskId:'A',action:'task-continue',inputVersion:task.requirementRevision,runSequence:task.runSequence,
            progressImpact:'preserve',impactReason:'仅继续已授权原目标，不改验收或授权',context:'继续原目标',afterTaskIds:[]}]}}]
      }
      const topic=topicTaskCalls(request);if(topic)return topic
      if(names.includes('task_session_submit'))return [ownerWait]
      return []
    },{config})
    await host.service.store.command({id:'seed-A',kind:'task.create',args:{taskId:'A',groupId:'native-group',ownerActorId:'native-user',request:'原目标A'}})
    await host.service.ingest({...message('conditional','测试助手，一分钟后查询A，未完成则按原目标继续。'),timestamp:'2026-10-21T00:00:00Z'})
    await host.service.whenIdle()
    assert.equal((await host.query('task.get',{taskId:'A'})).contextRevision??0,0,JSON.stringify(host.service.listAlerts()))
    t.mock.timers.tick(60000);await host.service.recover();await host.service.whenIdle()
    const task=await host.query('task.get',{taskId:'A'})
    assert.equal(task.contextRevision,1,JSON.stringify(host.service.listAlerts()));assert.equal(task.runSequence,1)
    const occurrences=await host.query('coordination.occurrence.list')
    assert.equal(occurrences.length,1);assert.equal(occurrences[0].triggerKind,'time')
    assert.equal(occurrences[0].result.results[0].contextRevision,0)
    assert.equal(occurrences[0].result.conditionalCommands.results.length,1)
    assert.equal(occurrences[0].deliveryState,'delivered')
  })

test('native partial clarification continues A, resolves B under the original arrangement, and answers a factual chat query',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root=await mkdtemp(join(tmpdir(),'coordination-partial-query-native-'));let host, originalId
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,request=>{
      const names=request.tools.map(tool=>tool.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit'))return unitRoute(input)
      if(names.includes('coordination_submit')){
        const source=input.source??modelToolValues(request).find(value=>value.source)?.source
        const full=modelToolValues(request).find(value=>value.arrangementContexts?.length)
        if(source.unitText.includes('还欠')){
          if(!full)return [{name:'coordination_context_get',args:{coordinationIds:[originalId]}}]
          return [{name:'coordination_submit',args:{kind:'query',coordinationIds:[originalId]}}]
        }
        if(source.unitText.includes('明确是B')){
          const observed=modelToolValues(request).find(value=>value.arrangementContexts?.length&&value.taskContexts?.length)
          if(!observed)return [{name:'coordination_context_get',args:{coordinationIds:[originalId],taskIds:['B']}}]
          const resolution=arrangement(observed.taskContexts);resolution.members[0].afterTaskIds=[]
          return [{name:'coordination_submit',args:{kind:'resolve',coordinationId:originalId,expectedRevision:1,
            clarificationIds:['other-task'],resolution}}]
        }
        const observed=modelToolValues(request).find(value=>value.taskContexts?.length)
        if(!observed)return [{name:'coordination_context_get',args:{taskIds:['A']}}]
        return [{name:'coordination_submit',args:{...arrangement(observed.taskContexts),pendingClarifications:[{
          clarificationId:'other-task',question:'另一个任务是B吗？',candidates:['B']}]}}]
      }
      if(names.includes('task_session_submit'))return [ownerWait]
      return topicTaskCalls(request)??[]
    },{config})
    await seed(host)
    await host.service.ingest(message('partial','测试助手，A补充定位材料，另一个同名任务也补充。'));await host.service.whenIdle()
    const original=(await host.query('coordination.list'))[0];originalId=original.id
    let state=await host.query('coordination.get',{coordinationId:originalId})
    assert.equal(state.members[0].state,'applied',JSON.stringify(host.service.listAlerts()))
    assert.equal(state.coordination.pendingClarifications.length,1)
    let source=host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.equal(source.semanticState,'needs_clarification');assert.equal(source.settled,false);assert.equal(source.dispatchOwner,'coordination')
    await host.service.ingest(message('answer','测试助手，另一个明确是B，只补材料。'));await host.service.whenIdle()
    state=await host.query('coordination.get',{coordinationId:originalId})
    assert.equal(state.coordination.revision,2,JSON.stringify(host.service.listAlerts()))
    assert.deepEqual(state.members.map(member=>member.state),['applied','applied'])
    const before=await host.query('task.list')
    await host.service.ingest(message('facts','测试助手，整体还欠什么，为什么等待？'));await host.service.whenIdle()
    const answer=host.sent.find(notification=>notification.payload.sourceMessageId==='facts')
    assert.ok(answer,JSON.stringify(host.service.listAlerts()));assert.match(answer.payload.text,/正式完成 0 项/)
    assert.match(answer.payload.text,/尚欠 2 项/);assert.deepEqual(await host.query('task.list'),before)
    assert.equal(host.residentStore.listTopics('native-group').length,0)
    await host.service.recover();await host.service.whenIdle()
    assert.equal(host.sent.filter(notification=>notification.id===answer.id).length,1)
  })

test('actual ingress applies a follow-up ordinal to the original coordination member and keeps original Tasks active',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-change-native-'))
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return unitRoute(input)
      if (names.includes('coordination_submit')) {
        const source = input.source ?? modelToolValues(request).find(value => value.source)?.source
        if (source.unitText.includes('第二个')) {
          const full = modelToolValues(request).find(value => value.arrangementContexts?.length)
          if (!full) return [{ name: 'coordination_context_get', args: { coordinationIds: [input.arrangements[0].id] } }]
          const original = full.arrangementContexts[0]
          return [{ name: 'coordination_submit', args: { kind: 'change', coordinationId: original.coordination.id,
            expectedRevision: original.coordination.revision, change: { action: 'pause', selectors: [{ ordinal: 2 }], reason: '第二个先别动' } } }]
        }
        const full = modelToolValues(request).find(value => value.taskContexts?.length === 2)
        if (!full) return [{ name: 'coordination_context_get', args: { taskIds: ['A','B'] } }]
        return [{ name: 'coordination_submit', args: arrangement(full.taskContexts) }]
      }
      if (names.includes('task_session_submit')) return [ownerWait]
      return topicTaskCalls(request) ?? []
    }, { config })
    await seed(host)
    await host.service.ingest(message('original', '测试助手，先完成A，再处理B，都补充新材料。'))
    await host.service.whenIdle()
    const original = (await host.query('coordination.list'))[0]
    await host.service.ingest(message('pause', '测试助手，第二个先别动。'))
    await host.service.whenIdle()
    const state = await host.query('coordination.get', { coordinationId: original.id })
    assert.equal(state.coordination.revision, 2, JSON.stringify({ alerts: host.service.listAlerts(), tools: host.toolResults.filter(result => result.name.startsWith('coordination_')) }))
    assert.deepEqual(state.members.map(member => [member.taskId, member.control ?? 'active']), [['A','active'],['B','paused']])
    assert.equal(state.members[0].state, 'applied'); assert.equal(state.members[1].state, 'ready')
    assert.equal((await host.query('task.get', { taskId: 'B' })).control, 'active')
    assert.equal((await host.query('task.get', { taskId: 'B' })).contextRevision ?? 0, 0)
    const control = host.sent.filter(notification => notification.payload.fact.noticeKind === 'control')
    assert.equal(control.length, 1)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(host.sent.filter(notification => notification.id === control[0].id).length, 1)
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
    assert.equal((await host.query('task.list')).length, 2)
  })

test('actual clarification reply resolves the original no-Topic arrangement instead of creating a replacement',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-resolve-native-'))
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return unitRoute(input)
      if (names.includes('coordination_submit')) {
        const source = input.source ?? modelToolValues(request).find(value => value.source)?.source
        if (source.unitText.includes('那个任务')) return [{ name: 'coordination_submit', args: {
          kind: 'clarify', question: '具体是原任务A还是B？', candidates: ['A','B'] } }]
        const full = modelToolValues(request).find(value => value.arrangementContexts?.length && value.taskContexts?.length)
        if (!full) return [{ name: 'coordination_context_get', args: { coordinationIds: [input.unresolved[0].coordinationId], taskIds: ['A'] } }]
        const original = full.arrangementContexts[0]
        return [{ name: 'coordination_submit', args: { kind: 'resolve', coordinationId: original.coordination.id,
          expectedRevision: original.coordination.revision, resolution: arrangement(full.taskContexts) } }]
      }
      if (names.includes('task_session_submit')) return [ownerWait]
      return topicTaskCalls(request) ?? []
    }, { config })
    await seed(host)
    await host.service.ingest(message('ambiguous', '测试助手，先处理那个任务。'))
    await host.service.whenIdle()
    const original = (await host.query('coordination.list'))[0]
    assert.equal(original.state, 'needs_clarification')
    await host.service.ingest(message('answer', '测试助手，明确是原任务A，只补充定位材料。'))
    await host.service.whenIdle()
    const list = await host.query('coordination.list')
    assert.equal(list.length, 1, JSON.stringify(host.service.listAlerts()))
    assert.equal(list[0].id, original.id); assert.equal(list[0].revision, 2)
    assert.equal((await host.query('coordination.get', { coordinationId: original.id })).members[0].taskId, 'A')
    const ownership = host.residentStore.listSourceDispatchOwnership('native-group')
    assert.deepEqual(ownership.map(entry => [entry.coordinationId, entry.semanticState, entry.settled]), [
      [original.id,'accepted',true], [original.id,'accepted',true],
    ])
    assert.equal((await host.query('task.get', { taskId: 'B' })).contextRevision ?? 0, 0)
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
  })

test('actual rejected ingress hands back one fenced unit and resumes the legacy discussion router without business effects',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-handoff-native-'))
    let host, routes = 0, rejected = 0, decisionCalls = 0
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) {
        routes++
        if (routes === 1) return unitRoute(input)
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
          routes: input.messages.map(source => ({ messageId: source.messageId, messageVersion: source.messageVersion, ignoredRefs: [],
            units: [{ unitKey: 'independent', summary: '普通讨论', sourceRefs: [{ quote: source.text }], dispatchOwner: 'legacy-topic',
              topics: [{ newTopicKey: 'discussion', title: '普通事项讨论' }] }] })) } }]
      }
      if (names.includes('coordination_submit')) { rejected++; return [{ name: 'coordination_submit', args: { kind: 'reject', reason: '仅普通单项讨论，无跨任务或定时安排' } }] }
      const calls = topicTaskCalls(request)
      if (names.includes('group_decision_submit')) {
        decisionCalls++
        assert.ok(decisionCalls <= 3, JSON.stringify(modelToolValues(request).slice(-2)))
        calls[0].args.decision = { ...calls[0].args.decision, actions: [], reason: '保持讨论，无业务执行授权' }
        delete calls[0].args.decision.reply
        delete calls[0].args.decision.replyReview
      }
      return calls ?? []
    }, { config })
    await host.service.ingest(message('wrong-route', '测试助手，这是普通事项讨论，没有任务协调安排。'))
    await host.service.whenIdle()
    const reservation = host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.equal(reservation.dispatchOwner, 'legacy-topic', JSON.stringify(host.service.listAlerts()))
    assert.equal(reservation.generation, 2)
    assert.equal(rejected, 1); assert.equal(routes, 2)
    assert.equal((await host.query('coordination.source', { unitId: reservation.unitId, revision: reservation.unitRevision })).dispatchOwner, 'legacy-topic')
    assert.equal(host.residentStore.listTopics('native-group').length, 1)
    assert.equal(host.residentStore.listTopics('native-group')[0].decisions[0].status, 'completed')
    assert.equal((await host.query('coordination.list')).length, 0)
    assert.equal((await host.query('task.list')).length, 0)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(rejected, 1); assert.equal(routes, 2)
  })
