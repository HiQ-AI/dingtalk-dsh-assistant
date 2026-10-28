import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { coordinationContextSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

const model = { enabled: true, provider: 'native-task-test', model: 'coordination-controlled' }

test('即时进度询问经原生路由与query工具一次答复四项任务，恢复不唤醒或重发',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'instant-task-progress-'))
    let host, ownerCalls = 0
    const taskIds = []
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'progress', summary: '查询导入事项进度', sourceRefs: [{ quote: message.text }],
            dispatchOwner: 'coordination', topics: [], reason: '多个现有任务即时只读查询' }] })) } }]
      if (names.includes('coordination_submit')) {
        assert.equal(input.tasks.length, 4)
        return [{ name: 'coordination_submit', args: { kind: 'query', taskIds } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        ownerCalls++
        return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '原工作未结束', evidence: [], limitations: [] } } }]
      }
      return []
    }, { config: { coordination: model } })
    for (const title of ['终审只读UPR导入覆盖', '未保存草稿UPR导入', '草稿UPR物料名称回显', 'v4合并数据集UPR替换'])
      taskIds.push((await host.service.createTask({ groupId: 'native-group', requestId: title, title, objective: title })).taskId)
    await host.service.whenIdle()
    const tasks = await host.query('task.list'), wakes = await host.query('wake.list'), calls = ownerCalls
    await host.service.ingest({ groupId: 'native-group', messageId: 'progress', senderOpenDingTalkId: 'native-user', senderName: '同事',
      text: '昨天关于导入的其他问题 修复了没', timestamp: '2026-10-28T01:44:09Z' })
    await host.service.whenIdle()
    assert.equal(host.sent.length, 1)
    for (const task of tasks) assert.ok(host.sent[0].payload.text.includes(task.title))
    const arrangement = (await host.query('coordination.list'))[0]
    assert.deepEqual((await host.query('coordination.get', { coordinationId: arrangement.id })).members, [])
    assert.deepEqual(await host.query('task.list'), tasks)
    assert.deepEqual(await host.query('wake.list'), wakes)
    assert.equal(ownerCalls, calls)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(host.sent.length, 1); assert.equal(ownerCalls, calls)
    assert.deepEqual(await host.query('execution.list'), [])
    assert.deepEqual(await host.query('coordination.schedule.list'), [])
    assert.deepEqual(await host.query('coordination.occurrence.list'), [])
  })

test('部署到UAT2携带原引用穿过预约和独立协调，分页找到并重开唯一原任务，不重复新建',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'quoted-deployment-native-'))
    let host, originalId, plans = 0
    const quote = { messageId: 'original-delivery', senderName: '原交付作者',
      content: '终审详情确认编辑修复已交付：后端 https://github.com/HiQ-AI/dataset/pull/417、前端 https://github.com/HiQ-AI/dataset-web/pull/389。尚未部署。' }
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'deploy-uat2', summary: '引用交付部署到UAT2', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '继续引用事项' }] })) } }]
      if (names.includes('coordination_submit')) {
        assert.equal(input.source.original, '部署到UAT2')
        assert.equal(input.source.quotedMessage.content, quote.content)
        assert.equal(input.source.quotedMessage.senderName, quote.senderName)
        assert.ok(names.includes('group_message_get')); assert.ok(names.includes('group_resource_get'))
        const full = modelToolValues(request).findLast(value => value.taskContexts?.length)
        if (!full) {
          const page = modelToolValues(request).findLast(value => Array.isArray(value.tasks)) ?? input
          const target = page.tasks.find(task => task.taskId === originalId)
          return [{ name: 'coordination_context_get', args: target ? { taskIds: [target.taskId] } : { offset: page.nextOffset, limit: 50 } }]
        }
        plans++
        const task = full.taskContexts[0]
        assert.equal(task.taskId, originalId); assert.equal(task.status, 'completed')
        return [{ name: 'coordination_submit', args: { kind: 'arrangement', members: [{ action: 'task-reopen', taskId: originalId,
          inputVersion: task.requirementRevision, runSequence: task.runSequence, progressImpact: 'replan',
          impactReason: '当前作者明确要求原交付部署到UAT2', context: `当前授权：部署到UAT2。引用交付：${quote.content}`,
          objective: '将终审编辑原交付的后端#417和前端#389部署到UAT2并核验', requirements: ['按runbook部署UAT2，核验版本与健康，不部署生产'] }] } }]
      }
      const topics = topicTaskCalls(request); if (topics) return topics
      return [{ name: 'task_session_submit', args: { decision: { action: input.task.runSequence === 1 ? 'complete' : 'wait',
        summary: input.task.runSequence === 1 ? '原交付已完成，尚未部署' : '已正确承接UAT2部署，等待实际执行验证', evidence: [], limitations: ['隔离合同测试不进行外部部署'] } } }]
    }, { config: { coordination: model } })
    for (let i = 0; i < 21; i++) await host.service.store.command({ id: `distractor:${i}`, kind: 'task.create',
      args: { taskId: `other-${i}`, groupId: 'native-group', request: `其他独立事项${i}` } })
    originalId = (await host.service.createTask({ groupId: 'native-group', requestId: 'original-delivery',
      title: '修复终审详情确认编辑持久状态', objective: `终审详情确认编辑修复；${quote.content}` })).taskId
    await host.service.whenIdle()
    assert.equal((await host.query('task.get', { taskId: originalId })).status, 'completed')
    await host.service.ingest({ groupId: 'native-group', messageId: 'quoted-deploy', senderOpenDingTalkId: 'native-user',
      senderName: '当前部署人', text: '部署到UAT2', quotedMessage: quote, timestamp: '2026-10-27T04:15:53.180Z' })
    await host.service.whenIdle()
    const owner = host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.deepEqual(owner.sourceSnapshot.quotedMessage, quote)
    assert.equal(owner.semanticState, 'accepted'); assert.equal(owner.settled, true); assert.equal(plans, 1)
    const original = await host.query('task.get', { taskId: originalId })
    assert.equal(original.runSequence, 2); assert.match(original.objective, /#417.*#389.*UAT2/)
    assert.equal((await host.query('task.list')).length, 22)
    assert.equal(host.sent.some(notice => /要将哪项|请提供.*PR/.test(notice.payload.text)), false)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(plans, 1); assert.equal((await host.query('task.get', { taskId: originalId })).runSequence, 2)
  })

test('旧误澄清通过精确恢复原生重判引用，复用原安排与Task且旧已送达问题不重发',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'quoted-context-reconsider-native-'))
    let host, originalId, recoveredPlans = 0
    const quote = { messageId: 'delivery', senderName: '原交付作者', content: '原终审修复：后端 #417、前端 #389，尚未部署。' }
    const question = '要将哪项改动部署到UAT2？'
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'deploy-uat2', summary: '部署原交付', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '原交付后续部署' }] })) } }]
      if (names.includes('coordination_submit')) {
        // 先生成真实待澄清账；下方显式移除预约引用字段，模拟修复前持久预约，而非生产恢复手段。
        if (!input.source.contextReconsideration) return [{ name: 'coordination_submit', args: { kind: 'clarify', question } }]
        assert.equal(input.source.quotedMessage.content, quote.content)
        const full = modelToolValues(request).findLast(value => value.taskContexts?.some(task => task.taskId === originalId))
        if (!full) return [{ name: 'coordination_context_get', args: { taskIds: [originalId] } }]
        recoveredPlans++
        const task = full.taskContexts.find(task => task.taskId === originalId)
        return [{ name: 'coordination_submit', args: { kind: 'arrangement', members: [{ action: 'task-reopen', taskId: originalId,
          inputVersion: task.requirementRevision, runSequence: task.runSequence, progressImpact: 'replan', impactReason: '原交付新增UAT2部署阶段',
          context: '沿原交付部署UAT2', objective: '将原终审修复后端#417、前端#389部署到UAT2', requirements: ['部署并核对版本，不涉及生产'] }] } }]
      }
      const topics = topicTaskCalls(request); if (topics) return topics
      return [{ name: 'task_session_submit', args: { decision: { action: input.task.runSequence === 1 ? 'complete' : 'wait',
        summary: input.task.runSequence === 1 ? '交付完成，未部署' : '已承接原部署阶段，待实际执行', evidence: [], limitations: ['隔离测试不部署真实服务'] } } }]
    }, { config: { coordination: model } })
    originalId = (await host.service.createTask({ groupId: 'native-group', requestId: 'delivery', title: '终审确认编辑修复', objective: quote.content })).taskId
    await host.service.whenIdle()
    await host.service.ingest({ groupId: 'native-group', messageId: 'deployment', senderOpenDingTalkId: 'native-user', senderName: '当前部署人',
      text: '部署到UAT2', quotedMessage: quote, timestamp: '2026-10-27T04:15:53.180Z' })
    await host.service.whenIdle()
    const owner = host.residentStore.getGroup('native-group').sourceDispatchOwnership[0]
    delete owner.sourceSnapshot.quotedMessage
    assert.equal(owner.semanticState, 'needs_clarification')
    const originalCoordinationId = owner.coordinationId
    const beforeNotices = await host.query('notification.list')
    const oldQuestion = beforeNotices.find(notice => notice.payload.text === question)
    assert.equal(oldQuestion.state, 'delivered')
    const sourceBefore = (await host.query('source.list')).find(source => source.messageId === 'deployment')
    const token = (await host.service.messageProcessingSources('native-group')).find(source => source.messageId === 'deployment').coordination[0].contextRecoveryToken
    assert.match(token, /^[a-f0-9]{64}$/)
    const message = host.residentStore.getGroup('native-group').messages.find(message => message.messageId === 'deployment')
    const args = { groupId: 'native-group', messageId: 'deployment', messageVersion: message.messageVersion, activeUnitRefs: message.activeUnitRefs,
      phase: 'coordination-context', requestId: owner.reservationId, token }
    assert.equal((await host.service.retryMessageProcessing(args)).status, 'attempted')
    await host.service.whenIdle()
    const current = host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.equal(current.coordinationId, originalCoordinationId); assert.equal(current.semanticState, 'accepted'); assert.equal(current.generation, 1)
    assert.equal(recoveredPlans, 1); assert.equal((await host.query('coordination.list')).length, 1)
    assert.equal((await host.query('task.list')).length, 1); assert.equal((await host.query('task.get', { taskId: originalId })).runSequence, 2)
    assert.deepEqual(await host.query('notification.get', { notificationId: oldQuestion.id }), oldQuestion)
    assert.equal(host.sent.filter(notice => notice.payload.text === question).length, 1)
    const originalSource = (await host.query('source.list')).find(source => source.sourceId === sourceBefore.sourceId)
    assert.deepEqual(originalSource.processingHistory[0], sourceBefore.processingCompleted)
    await assert.rejects(host.service.retryMessageProcessing(args), /MESSAGE_RETRY_STALE|MESSAGE_RETRY_IN_PROGRESS/)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(recoveredPlans, 1); assert.equal(host.sent.filter(notice => notice.payload.text === question).length, 1)
  })

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
    const stages = async () => (await host.query('source.list'))[0].stages.filter(stage => stage.requestId === entry.reservationId)
    const firstStages = await stages()
    assert.deepEqual([...new Set(firstStages.map(stage => stage.attempt))],[0])
    assert.ok(firstStages.some(stage => stage.stage === 'queue'))
    assert.ok(firstStages.some(stage => stage.stage === 'turn'))
    t.mock.timers.tick(4999);await host.service.recover();await host.service.whenIdle()
    assert.equal(plans,1);assert.ok(host.service.listAlerts().some(alert=>alert.alertId===alertId))
    t.mock.timers.tick(1);await host.service.recover();await host.service.whenIdle()
    assert.equal(plans,2)
    const retryStages = (await stages()).filter(stage => !firstStages.some(first => first.spanId === stage.spanId))
    assert.deepEqual([...new Set(retryStages.map(stage => stage.attempt))],[1])
    for (const kind of ['queue','turn','host']) assert.ok(retryStages.some(stage => stage.stage === kind))
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
          summary: supplemented ? '已核验本轮补充材料' : '等候原任务补充', evidence: supplemented ? ['已读取并核验本轮补充材料'] : [], limitations: [] } } }]
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
    assert.deepEqual((await host.query('task.list')).map(t => [t.taskId,t.status]), [['A','completed'],['B','completed']], JSON.stringify(host.service.listAlerts()))
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
