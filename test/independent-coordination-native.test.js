import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { coordinationContextSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

const model = { enabled: true, provider: 'native-task-test', model: 'coordination-controlled' }

test('coordination context shares exact bounded inputs, including paired source identity', () => {
  assert.ok(coordinationContextSchema.safeParse({ limit: 50, offset: 0, taskIds: Array.from({length:8}, (_, i) => `t${i}`),
    coordinationIds: ['a','b','c','d'], arrangementSourceUnitId: 'source', arrangementSourceUnitRevision: 1 }).success)
  for (const args of [{limit:0},{limit:100},{taskIds:Array(17).fill('t')},{coordinationIds:Array(5).fill('c')},
    {taskIds:'t'},{arrangementSourceUnitId:'s'},{arrangementSourceUnitRevision:1},{arrangementSourceUnitRevision:0,arrangementSourceUnitId:'s'},
    ...['offset','sourceOffset','arrangementSourceOffset','arrangementOffset','memberOffset'].flatMap(key => [-1,0.5,Number.MAX_SAFE_INTEGER+1].map(value => ({[key]:value})))])
    assert.equal(coordinationContextSchema.safeParse(args).success, false, JSON.stringify(args))
})

for (const taskCount of [17,41]) test(`read-only scheduling selects ${taskCount} observed directory tasks without detail reads`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'coordination-directory-query-'))
    let host, plannerCalls=0, contextCalls=0, observed=[]
    const modelErrors=[]
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,request=>{
      const names=request.tools.map(tool=>tool.name), input=latestInput(request)
      if(names.includes('group_topic_route_submit')) return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(message=>({messageId:message.messageId,messageVersion:message.messageVersion,ignoredRefs:[],
          units:[{unitKey:'query',summary:'三分钟后查询全部原任务',sourceRefs:[{quote:message.text}],dispatchOwner:'coordination',topics:[],reason:'定时只读查询'}]}))}}]
      if(names.includes('coordination_submit')) {
        try {
        plannerCalls++
        const schema=request.tools.find(tool=>tool.name==='coordination_context_get').parameters
        assert.match(schema.properties.limit.description,/"minimum":1/);assert.match(schema.properties.limit.description,/"maximum":50/)
        assert.match(schema.properties.taskIds.description,/"maxItems":8/);assert.match(schema.properties.coordinationIds.description,/"maxItems":4/)
        assert.match(schema.properties.offset.description,/"minimum":0/)
        const page=modelToolValues(request).filter(value=>Array.isArray(value.tasks)).at(-1)??input
        assert.equal(page.taskContexts.length,0)
        observed=[...new Set([...observed,...page.tasks.map(task=>task.taskId)])]
        if(page.hasMore){contextCalls++;return [{name:'coordination_context_get',args:{offset:page.nextOffset,limit:50}}]}
        assert.equal(observed.length,taskCount)
        assert.equal(input.source.occurredAt,'2026-10-21T00:00:00.000Z')
        assert.equal(input.currentTime,'2026-10-21T00:00:00.000Z')
        return [{name:'coordination_submit',args:{kind:'schedule',timezone:'Asia/Shanghai',rule:{kind:'once',at:'2026-10-21T00:03:00.000Z'},
          taskIds:observed,recipientIds:['native-user'],interpretation:'原消息三分钟后查询已观察的全部原任务'}}]
        } catch(error) { modelErrors.push(error); throw error }
      }
      return topicTaskCalls(request)??[{name:'task_session_submit',args:{decision:{action:'wait',summary:'保持原任务',evidence:[],limitations:[]}}}]
    },{config:{coordination:model}})
    for(let i=0;i<taskCount;i++) await host.service.store.command({id:`seed:${i}`,kind:'task.create',args:{taskId:`T${i}`,groupId:'native-group',request:`原任务${i}`}})
    await host.service.ingest({groupId:'native-group',messageId:'directory-query',senderOpenDingTalkId:'native-user',senderName:'测试用户',
      text:'测试助手，三分钟后查询当前群所有任务进度，通知我。',timestamp:'2026-10-21T00:00:00Z'})
    await host.service.whenIdle()
    assert.deepEqual(modelErrors,[])
    const schedules=await host.query('coordination.schedule.list')
    assert.equal(schedules.length,1,JSON.stringify(host.service.listAlerts()))
    assert.deepEqual(schedules[0].action.taskIds,observed)
    assert.equal(contextCalls,taskCount===17?0:1);assert.equal(plannerCalls,contextCalls+1)
    assert.ok((await host.query('task.list')).every(task=>(task.contextRevision??0)===0&&task.requirementRevision===1&&task.runSequence===1))
  })

// Scripted planning verifies actual ingress/Host contracts, not model comprehension.
test('successful clarification after retry clears its old planning alert without resetting the persisted attempt',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
    const root=await mkdtemp(join(tmpdir(),'coordination-recovered-alert-'))
    let host, plans=0
    t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
    host=await nativeTaskHost(root,request=>{
      const names=request.tools.map(tool=>tool.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit')) return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(message=>({messageId:message.messageId,messageVersion:message.messageVersion,ignoredRefs:[],
          units:[{unitKey:'query',summary:'查询目标待确认',sourceRefs:[{quote:message.text}],dispatchOwner:'coordination',topics:[],reason:'定时对象不明'}]}))}}]
      if(names.includes('coordination_submit')) {
        if(++plans===1)return []
        return [{name:'coordination_submit',args:{kind:'clarify',question:'要查询哪个原任务？',candidates:[]}}]
      }
      return topicTaskCalls(request)??[]
    },{config:{coordination:model}})
    await host.service.ingest({groupId:'native-group',messageId:'retry-query',senderOpenDingTalkId:'native-user',senderName:'测试用户',
      text:'测试助手，三分钟后查那个任务。',timestamp:'2026-10-21T00:00:00Z'})
    await host.service.whenIdle()
    const entry=host.residentStore.listSourceDispatchOwnership('native-group')[0]
    const alertId=`failure:${entry.reservationId}`
    assert.ok(host.service.listAlerts().some(alert=>alert.alertId===alertId&&alert.detail==='COORDINATION_NO_SUBMISSION'))
    assert.equal(plans,1)
    t.mock.timers.tick(4999);await host.service.recover();await host.service.whenIdle()
    assert.equal(plans,1);assert.ok(host.service.listAlerts().some(alert=>alert.alertId===alertId))
    t.mock.timers.tick(1);await host.service.recover();await host.service.whenIdle()
    assert.equal(plans,2)
    const ledger=await host.query('coordination.source',{unitId:entry.unitId,revision:entry.unitRevision})
    assert.equal(ledger.state,'needs_clarification');assert.equal(ledger.attemptCount,1)
    assert.equal(host.service.listAlerts().some(alert=>alert.alertId===alertId),false)
    assert.equal(host.sent.filter(notice=>notice.payload.text==='要查询哪个原任务？').length,1)
  })

const stageCases = [
  { name: 'software', objective: '需求X先方案评审，然后开发，开发完部署UAT', requirements: ['先完成方案评审', '评审后开发', '开发完成后部署UAT并验证'] },
  { name: 'translation-two', objective: '这份稿件先翻译，再校对', requirements: ['翻译稿件', '翻译后校对'] },
  { name: 'research-four', objective: '本次调研先设计问卷，再访谈，然后分析，最后撰写报告', requirements: ['设计问卷', '问卷后访谈', '访谈后分析', '分析后撰写报告'] },
  { name: 'translation-reversed', objective: '这份已有译稿先校对，再翻译修订内容', requirements: ['先校对已有译稿', '校对后翻译修订内容'] },
]
for (const stageCase of stageCases) for (const existing of [false, true]) test(`one delivery preserves arbitrary user stages: ${stageCase.name}, existing=${existing}`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'single-task-stages-'))
    let host, admitted = false, delegated = false, ownerInput
    const prompts = { route: '', planner: '', owner: '' }
    const { objective, requirements } = stageCase
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) {
        prompts.route = JSON.stringify(request)
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
          routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
            ignoredRefs: [], units: [{ unitKey: 'delivery', summary: objective, sourceRefs: [{ quote: message.text }],
              dispatchOwner: 'coordination', topics: [], reason: '一个完整交付目标' }] })) } }]
      }
      if (names.includes('coordination_submit')) {
        prompts.planner = JSON.stringify(request)
        const full = modelToolValues(request).find(value => value.taskContexts?.some(task => task.taskId === 'original'))
        if (existing && !full) return [{ name: 'coordination_context_get', args: { taskIds: ['original'] } }]
        const task = full?.taskContexts.find(task => task.taskId === 'original')
        admitted = true
        return [{ name: 'coordination_submit', args: { kind: 'arrangement', members: [existing
          ? { action: 'task-context', taskId: task.taskId, inputVersion: task.requirementRevision, runSequence: task.runSequence,
              progressImpact: 'replan', impactReason: '明确补齐后续交付范围', context: objective, objective, requirements }
          : { action: 'new-task', creationKey: 'delivery-X', title: '需求X交付', objective, requirements }] } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        prompts.owner = JSON.stringify(request)
        if (admitted) {
          ownerInput = input
          if (!delegated) {
            delegated = true
            return [{ name: 'task_delegate', args: { key: 'first-stage', objective: requirements[0], resourceKeys: [] } }]
          }
        }
        return [{ name: 'task_session_submit', args: { decision: { action: 'wait',
          summary: '首阶段结果仅是证据，后续阶段尚未交付', evidence: [], limitations: requirements.slice(1) } } }]
      }
      if (names.includes('execution_submit')) return [{ name: 'execution_submit', args: { output: {
        status: 'completed', summary: requirements[0], evidence: ['synthetic-first-stage'], limitations: requirements.slice(1), artifacts: [] } } }]
      return []
    }, { config: { coordination: model } })
    if (existing) await host.service.store.command({ id: 'original-create', kind: 'task.create',
      args: { taskId: 'original', groupId: 'native-group', ownerActorId: 'native-user', request: requirements[0] } })
    if (existing) { await host.service.recover(); await host.service.whenIdle() }
    await host.service.ingest({ groupId: 'native-group', messageId: 'stages', senderOpenDingTalkId: 'native-user',
      text: `测试助手，${objective}`, timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    const tasks = await host.query('task.list')
    assert.match(prompts.route, /任意用户指定阶段/)
    assert.match(prompts.planner, /不按内部阶段分别生成new-task/)
    assert.match(prompts.planner, /不得套用默认阶段模板/)
    assert.match(prompts.owner, /阶段执行结果仅为证据/)
    assert.equal(tasks.length, 1, JSON.stringify(host.service.listAlerts()))
    const task = tasks[0]
    if (existing) assert.equal(task.taskId, 'original')
    assert.equal(task.objective, objective)
    assert.deepEqual(task.requirements, requirements)
    assert.equal(ownerInput.task.objective, objective)
    assert.deepEqual(ownerInput.task.requirements, requirements)
    assert.ok(ownerInput.sources.some(source => source.text.includes(objective)))
    assert.equal(task.status, 'active')
    assert.equal(task.completion, undefined)
    const executions = await host.query('execution.list', { taskId: task.taskId })
    assert.equal(executions.length, 1)
    assert.equal(executions[0].status, 'succeeded')
    await host.service.recover(); await host.service.whenIdle()
    assert.equal((await host.query('task.list')).length, 1)
    assert.equal((await host.query('task.get', { taskId: task.taskId })).status, 'active')
  })

for (const scheduled of [false, true]) test(`explicit chat creation separates durable creation from dependency/time start: scheduled=${scheduled}`,
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    const root = await mkdtemp(join(tmpdir(), 'independent-create-'))
    let host
    const owners = []
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'create', summary: '明确新建及启动约束', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '独立协调' }] })) } }]
      if (names.includes('coordination_submit')) {
        const members = (scheduled ? ['B'] : ['A','B']).map(key => ({ action: 'new-task', creationKey: key,
          title: `新建${key}`, objective: `明确交付${key}`, requirements: [`正式核验${key}`], afterTaskIds: !scheduled && key === 'B' ? ['A'] : [] }))
        return [{ name: 'coordination_submit', args: scheduled ? { kind: 'schedule', actionKind: 'task-command', timezone: 'Asia/Shanghai',
          rule: { kind: 'once', at: '2026-10-21T00:01:00.000Z' }, members, recipientIds: [], interpretation: '一分钟后启动新建B' }
          : { kind: 'arrangement', members, allTogether: true } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) { owners.push(input.task.taskId); return [{ name: 'task_session_submit', args: { decision: {
        action: 'complete', summary: '正式验收该新建任务', evidence: ['isolated-owner-proof'], limitations: [] } } }] }
      return []
    }, { config: { coordination: model } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'create', senderOpenDingTalkId: 'native-user', senderName: '测试用户',
      text: scheduled ? '测试助手，明确新建B，一分钟后启动。' : '测试助手，明确新建A和B，完成A后再启动B。', timestamp: '2026-10-21T00:00:00Z' })
    await host.service.whenIdle()
    if (scheduled) {
      const held = (await host.query('task.list'))[0]
      assert.ok(held.coordinationHold, JSON.stringify(host.service.listAlerts())); assert.equal(owners.length, 0)
      assert.equal((await host.query('wake.list', { taskId: held.taskId })).length, 0)
      t.mock.timers.tick(60000); await host.service.recover(); await host.service.whenIdle()
    }
    const tasks = await host.query('task.list')
    assert.equal(tasks.length, scheduled ? 1 : 2, JSON.stringify(host.service.listAlerts()))
    assert.ok(tasks.every(t => t.status === 'completed' && !t.coordinationHold), JSON.stringify(host.service.listAlerts()))
    assert.equal(owners.length, tasks.length); assert.equal(new Set(owners).size, tasks.length)
    const occurrences = await host.query('coordination.occurrence.list')
    assert.deepEqual(occurrences.map(o => o.triggerKind), scheduled ? ['time'] : ['message','business-event'])
    assert.equal((await host.query('coordination.list'))[0].lifecycleState, 'completed')
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
  })

test('real ingress reserves a no-Topic unit, independently plans A then B and dispatches original Owners from completion facts',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'independent-native-'))
    let host, plans = 0
    const completions = []
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: {
        requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
          ignoredRefs: [], units: [{ unitKey: 'sequence', summary: '原任务先后安排', sourceRefs: [{ quote: message.text }],
            dispatchOwner: 'coordination', topics: [], reason: '独立于Topic的两任务安排' }] })) } }]
      if (names.includes('coordination_submit')) {
        const full = modelToolValues(request).find(v => v.taskContexts?.length === 2)
        if (!full) return [{ name: 'coordination_context_get', args: { taskIds: ['A','B'] } }]
        plans++
        return [{ name: 'coordination_submit', args: { kind: 'arrangement', commonContext: '保留原目标，核对本次补充', allTogether: true,
          members: full.taskContexts.map(task => ({ taskId: task.taskId, action: 'task-context', inputVersion: task.requirementRevision,
            runSequence: task.runSequence, progressImpact: 'preserve', impactReason: '仅增加定位材料，不改变目标/验收/授权',
            context: `${task.taskId}补充材料`, afterTaskIds: task.taskId === 'B' ? ['A'] : [] })) } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        const supplemented = input.wakes.some(wake => wake.kind === 'task.supplement')
        if (supplemented) completions.push(input.task.taskId)
        return [{ name: 'task_session_submit', args: { decision: { action: supplemented ? 'complete' : 'wait',
          summary: supplemented ? `已核验${input.task.taskId}补充` : '等候原任务补充', evidence: supplemented ? [`proof:${input.task.taskId}`] : [], limitations: [] } } }]
      }
      return []
    }, { config: { coordination: model } })
    for (const taskId of ['A','B']) await host.service.store.command({ id: `seed:${taskId}`, kind: 'task.create',
      args: { taskId, groupId: 'native-group', ownerActorId: 'native-user', request: `原目标${taskId}` } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'sequence-input', senderOpenDingTalkId: 'native-user',
      senderName: '测试用户', text: '测试助手，先完成原任务A，再继续原任务B；各加定位材料。', timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    assert.equal(plans, 1, JSON.stringify(host.service.listAlerts()))
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
    assert.deepEqual((await host.query('task.list')).map(t => [t.taskId,t.status]), [['A','completed'],['B','completed']])
    assert.deepEqual(completions, ['A','B'])
    const reservations = host.residentStore.listSourceDispatchOwnership('native-group')
    assert.equal(reservations.length, 1); assert.equal(reservations[0].dispatchOwner, 'coordination'); assert.equal(reservations[0].settled, true)
    const state = await host.query('coordination.get', { coordinationId: reservations[0].coordinationId })
    assert.deepEqual(state.members.map(m => m.state), ['fulfilled','fulfilled'])
    assert.equal((await host.query('task.events')).events.length, 2)
    assert.equal(host.sent.filter(n => n.kind === 'topic-reply').length, 0)
    assert.equal(host.sent.filter(n => n.kind === 'coordination').length, 2)
    const triggers = await host.query('coordination.occurrence.list')
    assert.deepEqual(triggers.map(o => o.triggerKind), ['message','business-event'])
    assert.equal(triggers[1].eventId, (await host.query('task.events')).events[0].id)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(plans, 1); assert.deepEqual(completions, ['A','B'])
    assert.equal(host.sent.filter(n => n.kind === 'coordination').length, 2)
  })

test('ambiguous no-Topic request remains exclusively pending clarification without changing original tasks',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'independent-clarify-'))
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'ambiguous', summary: '对象待澄清', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '跨任务对象不明' }] })) } }]
      if (names.includes('coordination_submit')) return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '“第二个”指哪张已有安排中的任务？', candidates: [] } }]
      return topicTaskCalls(request) ?? []
    }, { config: { coordination: model } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'ambiguous', senderOpenDingTalkId: 'native-user', senderName: '测试用户',
      text: '测试助手，第二个先别动。', timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    const reservation = host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.equal(reservation.semanticState, 'needs_clarification', JSON.stringify(host.service.listAlerts())); assert.equal(reservation.settled, false)
    assert.equal((await host.query('task.list')).length, 0)
    assert.equal((await host.query('source.list'))[0].routed, undefined)
    assert.equal(host.sent.length, 1); assert.equal(host.sent[0].kind, 'coordination')
  })

test('no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    const root = await mkdtemp(join(tmpdir(), 'independent-schedule-'))
    let host, ownerCalls = 0
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'time', summary: '到期查原任务', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '独立时间计划' }] })) } }]
      if (names.includes('coordination_submit')) {
        if (!modelToolValues(request).some(v => v.taskContexts?.length)) return [{ name: 'coordination_context_get', args: { taskIds: ['A'] } }]
        return [{ name: 'coordination_submit', args: { kind: 'schedule', timezone: 'Asia/Shanghai',
          rule: { kind: 'once', at: '2026-10-21T00:01:00.000Z' }, taskIds: ['A'], recipientIds: ['native-user'],
          interpretation: '2026年10月21日08:01 Asia/Shanghai，在当前群@测试用户查询任务A' } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) { ownerCalls++; return [{ name: 'task_session_submit', args: { decision: {
        action: 'wait', summary: '等待原交付', evidence: [], limitations: [] } } }] }
      return []
    }, { config: { coordination: model } })
    await host.service.store.command({ id: 'seed:A', kind: 'task.create', args: { taskId: 'A', groupId: 'native-group', ownerActorId: 'native-user', request: '原任务A' } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'schedule', senderOpenDingTalkId: 'native-user', senderName: '测试用户',
      text: '测试助手，今天08:01查任务A的进度，在群里通知我。', timestamp: '2026-10-21T00:00:00Z' })
    await host.service.whenIdle()
    const before = await host.query('task.get', { taskId: 'A' }), calls = ownerCalls
    assert.equal((await host.query('coordination.schedule.list')).length, 1)
    assert.equal((await host.query('coordination.occurrence.list')).length, 0)
    t.mock.timers.tick(60000)
    await host.service.recover(); await host.service.whenIdle()
    const after = await host.query('task.get', { taskId: 'A' })
    for (const key of ['requirementRevision','contextRevision','controlRevision','runSequence','status']) assert.equal(after[key], before[key])
    assert.equal(ownerCalls, calls)
    const occurrence = (await host.query('coordination.occurrence.list'))[0]
    assert.equal(occurrence.actionState, 'succeeded'); assert.equal(occurrence.deliveryState, 'delivered')
    assert.equal((await host.query('coordination.schedule.list'))[0].state, 'completed')
    const delivery = host.sent.find(n => n.payload.fact.occurrenceId === occurrence.id)
    assert.ok(delivery.sendPermit); assert.deepEqual(delivery.payload.atOpenDingTalkIds, ['native-user'])
    assert.ok(host.residentStore.getGroup('native-group').outbox.some(o => o.outboundId === delivery.id && o.status === 'sent'))
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
  })
