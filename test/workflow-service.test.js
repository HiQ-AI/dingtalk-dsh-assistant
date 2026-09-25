import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { isDirectedTaskRequest, openWorkflowService, rankMessageCandidates } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { messageSchemas, taskWorkflowCatalog } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { formatGroupReply, notificationOpenTaskId, sameDeliveredText, sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import { queryConversationTaskProgress } from '../packages/dingtalk-dsh-assistant/task-progress-query.js'

const schema = { type: 'object', additionalProperties: true }
const splitOne = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] })
test('短指代消息优先呈现紧邻来源的话题，显式引用仍优先', () => {
  const cards = Array.from({ length: 12 }, (_, index) => ({ candidateId: `old-${index}`, goal: '审核草稿排查', sourceRefs: [], explicitReferenceMatches: [], relevantTime: '2026-09-24T00:00:00Z' }))
  cards.push({ candidateId: 'account', topicId: 'account', goal: 'test3 账号创建时间为空', sourceRefs: ['previous'], explicitReferenceMatches: [], relevantTime: '2026-09-24T07:28:41Z' })
  assert.equal(rankMessageCandidates(cards, '这不是让你去查吗', 'previous')[0].candidateId, 'account')
  cards.find(item => item.candidateId === 'old-1').explicitReferenceMatches = ['quoted']
  assert.equal(rankMessageCandidates(cards, '这不是让你去查吗', 'previous')[0].candidateId, 'old-1')
})
test('明确交办与问题报告分开准入',()=>{
  assert.equal(isDirectedTaskRequest('@孙鹏(孙鹏) 小小鹏 数据集合并出现的这个问题需要修复'),true)
  assert.equal(isDirectedTaskRequest('@孙鹏(孙鹏) 修复又引入了归一化计算问题：当前得到 0.001 t。'),false)
  assert.equal(isDirectedTaskRequest('@孙鹏 任务已创建，开始处理。'),false)
})
test('内置进展查询限制本群与八项候选，流程结果可审计',()=>{
  const legacyTasks=Array.from({length:10},(_,index)=>({taskId:`t-${index}`,groupId:'g',title:`审核草稿保存 ${index}`,objective:'修复审核草稿保存',state:'completed'}))
  legacyTasks.push({taskId:'other',groupId:'other',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed'})
  const result=queryConversationTaskProgress({queryText:'审核草稿保存的问题进展如何？',conversationId:'g',actorId:'member',ownerActorId:'owner',occurredAt:'2026-09-24T00:00:00Z',workflowOrigins:[],workflowRuns:[],legacyTasks})
  assert.equal(result.items.length,8)
  assert.equal(result.flow.steps[1].count,10)
  assert.match(result.reply,/仅显示前 8 项/)
  assert.ok(result.items.every(item=>item.taskId!=='other'))
})
test('渠道回读仅归一化空白，正文差异仍阻止送达',()=>{
  assert.equal(sameDeliveredText('第一行 第二行','第一行\n第二行'),true)
  assert.equal(sameDeliveredText('第一行 第三行','第一行\n第二行'),false)
  assert.equal(sameDeliveredText('引用内容：这是待核对的原问题。回复内容：第一行 第二行','第一行\n第二行',true),false)
  assert.equal(sameDeliveredText('引用内容：原消息。回复内容：审核草稿和撤回通知已交付测试，分配撤回任务已取消。','审核草稿和撤回通知已交付测试，分配撤回任务已取消。',true),true)
  assert.equal(sameDeliveredText('@向春梅 更正审核问题：1. 草稿保存已部署。2. 分配撤回未部署。','更正审核问题：1. 草稿保存已部署。\n2. 分配撤回未部署。',true),true)
  assert.equal(sameDeliveredText('', ''),true)
  assert.equal(sameDeliveredText(null,'第一行'),false)
})
test('DWS 发送 ACK 的实际 result.openTaskId 可用于独立回读',()=>{
  assert.equal(notificationOpenTaskId({success:true,result:{openTaskId:'task-1'}}),'task-1')
})
test('群职责指定的日常代答署名在通知准备时固化且不会重复附加',()=>{
  const rule='针对消息必须引用回复；日常代答末尾空一行附 - 小小鹏代回'
  assert.equal(formatGroupReply('任务状态已核对。',rule),'任务状态已核对。\n\n- 小小鹏代回')
  assert.equal(formatGroupReply('任务状态已核对。\n\n- 小小鹏代回',rule),'任务状态已核对。\n\n- 小小鹏代回')
  assert.equal(formatGroupReply('任务状态已核对。','普通群'),'任务状态已核对。')
})
test('群职责贯穿即时进展查询的持久通知正文与引用来源',async t=>{
  const sent=[]
  const notifications={canDisclose:async()=>true,send:async notice=>{sent.push(notice);return{messageId:'reply-1'}},readback:async()=>({messageId:'reply-1',conversationId:'g'})}
  const task={taskId:'review-1',groupId:'g',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed'}
  const {service,message}=await fixture(t,'participant',notifications,{legacy:{listTasks:()=>[task],getGroup:id=>({groupId:id,responsibility:'日常代答末尾空一行附 - 小小鹏代回；针对消息必须引用回复',messages:[]})},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'conversation',candidateId:null,evidence:['本群任务']}:{kind:'intent',actions:[{intent:'status',arguments:{scope:'conversation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}})
  const received=await service.ingest({...message,text:'审核草稿保存进度如何？'})
  await service.messages.process(received.runId)
  await service.flushNotifications()
  assert.equal(sent.length,1)
  assert.match(sent[0].payload.text,/\n\n- 小小鹏代回$/u)
  assert.equal(sent[0].payload.sourceMessageId,message.messageId)
  assert.equal(sent[0].status,'sending')
})
test('群职责调整后已送达通知保留原正文，新通知仍可继续发送',async t=>{
  let responsibility='普通群'
  const sent=[]
  const notifications={canDisclose:async()=>true,send:async notice=>{sent.push(notice.payload.text);return{messageId:`reply-${sent.length}`}},readback:async notice=>({messageId:notice.ack.messageId,conversationId:'g'})}
  const task={taskId:'review',groupId:'g',title:'审核草稿',objective:'排查审核草稿',state:'completed'}
  const {service,message}=await fixture(t,'owner',notifications,{legacy:{listTasks:()=>[task],getGroup:id=>({groupId:id,responsibility,messages:[]})},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'conversation',candidateId:null,evidence:['本群任务']}
    :{kind:'intent',actions:[{intent:'status',arguments:{scope:'conversation'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}})
  const first=await service.ingest({...message,messageId:'first',text:'审核草稿进度如何？'})
  await service.messages.process(first.runId);await service.flushNotifications()
  responsibility='日常代答末尾空一行附 - 小小鹏代回'
  const second=await service.ingest({...message,messageId:'second',text:'审核草稿现在什么状态？'})
  await service.messages.process(second.runId);await service.flushNotifications()
  assert.equal(sent.length,2)
  assert.doesNotMatch(sent[0],/小小鹏代回/u)
  assert.match(sent[1],/\n\n- 小小鹏代回$/u)
})
test('工作流通知引用来源消息，缺来源才发送普通群消息',async()=>{
  const sent=[]
  const adapter={sendGroupReply:async value=>sent.push({kind:'reply',...value}),sendGroup:async value=>sent.push({kind:'group',...value})}
  await sendWorkflowNotification(adapter,{id:'n1',payload:{conversationId:'g',text:'已核对任务状态',sourceMessageId:'m1',actorId:'sender'}})
  await sendWorkflowNotification(adapter,{id:'n2',payload:{conversationId:'g',text:'系统通知'}})
  assert.equal(sent[0].kind,'reply')
  assert.equal(sent[0].replyToMessageId,'m1')
  assert.equal(sent[0].replyToSenderOpenDingTalkId,'sender')
  assert.equal(sent[1].kind,'group')
})
async function fixture(t, actor = 'owner', notifications, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-service-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, ...(options.external ? { delivery: { execute: async () => { throw new Error('EXTERNAL_EFFECT_NOT_EXPECTED') } } } : {}), workflows: [{ id: 'task-analysis', version: 'test', nodes: [
    { id: 'analyze', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ requirement }) => requirement, execute: options.execute ?? (async ({ input }) => ({ summary: `已分析：${input.request}`, evidenceIds: input.materials.map(item => item.id), limitations: [] })) },
  ] }] })
  const execution = { store, artifacts, controller }
  const legacy = { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: id => ({ groupId: id, responsibility: '处理本人交办事项', messages: [] }), ...options.legacy }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理本条材料', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const legacyJudge = options.judge ?? judge
  const batchJudge = async request => request.stage === 'IB'
    ? { kind: 'topic_intents', decisions: await Promise.all(request.input.units.map(async unit => ({
      unitId: unit.unitId, intent: await legacyJudge({ ...request, stage: 'I', input: unit.input }),
    }))) }
    : legacyJudge(request)
  const service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', ...options.config }, legacy, judge: batchJudge, execution, notifications, readResource: options.readResource, external: options.external })
  const process = service.messages.process.bind(service.messages)
  service.messages.process = async runId => {
    await process(runId)
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await service.messages.state(runId)
      if (['needs_attention', 'superseded'].includes(state.run.status) || state.requests.some(item => item.status === 'pending')
        || state.run.status === 'settled' && state.commands.every(command => ['applied', 'rejected', 'failed', 'unknown', 'superseded'].includes(command.status))) return state
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return service.messages.state(runId)
  }
  t.after(async () => { await service.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'g', messageId: 'm', text: '整理本条材料', senderOpenDingTalkId: actor }
  return { service, execution, message }
}

test('真实同库消息接纳→固定Task执行→看板结果；重复入站不重复创建', async t => {
  const { service, execution, message } = await fixture(t)
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  const state = await service.state(accepted.runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(state.commands.length, 1)
  const topic=(await service.topics('g'))[0]
  assert.ok(topic)
  assert.equal((await service.mailboxes()).messages[0].topicRefs[0].topicId,topic.topicId)
  assert.equal((await service.topicContext({groupId:'g',topicId:topic.topicId})).messages[0].messageId,message.messageId)
  const taskRunId = state.commands[0].result.runId
  await execution.controller.whenIdle(taskRunId)
  assert.deepEqual((await service.recover()).failures, [])
  const tasks = await service.tasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].state, 'completed')
  assert.equal(tasks[0].outcome, 'succeeded')
  assert.match(tasks[0].result, /已分析/)
  assert.equal((await service.ingest(message)).duplicate, true)
  assert.equal((await service.tasks()).length, 1)
})

test('模型要求为非本人创建Task仍被Host拒绝，未受权群也拒绝', async t => {
  const { service, execution, message } = await fixture(t, 'outsider')
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  const rejected = await service.state(accepted.runId)
  assert.equal(rejected.run.status, 'settled')
  assert.equal(rejected.commands[0].status, 'rejected')
  assert.match(rejected.commands[0].result.reply, /权限/)
  await service.ingest(message)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
  await assert.rejects(service.ingest({ ...message, groupId: 'another' }), /WORKFLOW_GROUP_NOT_ADMITTED/)
})

test('无可信消息编辑版本不能把变更正文当重复消息或新授权', async t => {
  const { service, message } = await fixture(t)
  await service.ingest(message)
  await assert.rejects(service.ingest({ ...message, text: '先不要执行' }), /WORKFLOW_EDIT_VERSION_REQUIRED/)
})

test('Web与IM引用同一澄清首终态生效，无权拒绝且答复不新建消息或重跑S', async t => {
  let splits = 0
  const notifications = { canDisclose: async () => true, send: async () => ({ messageId: 'question-message' }), readback: async () => ({ messageId: 'question-message', conversationId: 'g' }) }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') { splits++; return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] } }
    if (stage === 'R') return input.clarificationAnswers?.length ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['answer'] } : { kind: 'needs_clarification', reason: '请选择范围', question: '请选择第一个或第二个范围', needs: [] }
    return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge, config: { webActorId: 'owner' } })
  const received = await service.ingest(message); await service.messages.process(received.runId); await service.flushNotifications()
  const request = (await service.state(received.runId)).requests[0]
  await assert.rejects(service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'bad', answer: '第一' }, { channel: 'web', actorId: 'outsider' }), /FORBIDDEN/)
  const first = await service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'web-1', answer: '第一个' }, { channel: 'web', actorId: 'owner' })
  assert.equal(first.answer, '第一个')
  const second = await service.ingest({ ...message, messageId: 'im-answer', text: '第二个', quotedMessage: { messageId: 'question-message' } })
  assert.equal(second.answer, '第一个')
  assert.equal(splits, 1)
  assert.equal((await execution.store.query({ kind: 'message.list', limit: 100 })).length, 1)
})

test('纯话题事实同库沉淀，后续任务读取原文并强制继承话题约束', async t => {
  let sawSource = false
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') return input.candidates.length ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['topic'] } : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    if (input.text.includes('只用中文')) return { kind: 'intent', actions: [{ intent: 'fact', arguments: { kind: 'constraint', text: '只用中文' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    sawSource = input.facts.topic.sources.some(ref => ref.text === '后续报告只用中文')
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '整理报告', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '后续报告只用中文' }); await service.messages.process(first.runId)
  const topics = await execution.store.query({ kind: 'message.topics', conversationId: 'g', limit: 20 })
  assert.equal(topics.length, 1)
  assert.ok(topics[0].facts.some(fact => fact.kind === 'constraint' && fact.text === '只用中文'))
  const second = await service.ingest({ ...message, messageId: 'followup', text: '开始整理报告' }); await service.messages.process(second.runId)
  const state = await service.state(second.runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(sawSource, true)
  const task = await execution.controller.state(state.commands[0].result.runId)
  const input = await execution.artifacts.read(task.run.requirementRef)
  assert.ok(input.constraints.includes('只用中文'))
  assert.equal((await execution.store.query({ kind: 'message.topic.source', sourceKey: state.run.sourceKey })).length, 1)
})

test('旧完成Task只读候选返回旧结果，不调用新controller或恢复旧引擎', async t => {
  const old = { taskId: 'old-task', groupId: 'g', state: 'completed', outcome: 'succeeded', title: '翻译报告', result: '旧报告已翻译完成' }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }] }
    if (stage === 'R') { assert.equal(input.candidates[0].engine, 'legacy'); return { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['old-result'] } }
    return { kind: 'intent', actions: [{ intent: 'result', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, legacy: { listTasks: () => [old], getTask: id => id === old.taskId ? old : null } })
  const { runId } = await service.ingest({ ...message, text: '翻译报告结果是什么' }); await service.messages.process(runId)
  const state = await service.state(runId)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.equal(state.commands[0].result.reply, old.result)
  assert.deepEqual(await execution.store.query({ kind: 'run.list' }), [])
})

test('群集合查询不要求单个Task身份', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'conversation', candidateId: null, evidence: ['查询本群'] }
      : { kind: 'intent', actions: [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
  const { service, message } = await fixture(t, 'owner', undefined, { judge })
  const receipt = await service.ingest({ ...message, text: '本群任务进度如何？' })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.run.status, 'settled')
  assert.deepEqual(state.commands[0].result.items, [])
  assert.match(state.commands[0].result.reply, /没有/)
})

test('必需附件正文进入Task固定输入且保留意图约束', async t => {
  let reads = 0
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新材料'] }
      : { kind: 'intent', actions: [{ intent: 'research', arguments: { objective: '分析附件', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: ['不可执行SQL'], requiredExecutionMaterials: ['file-1'], replyPolicy: 'result' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge, readResource: async () => ({ text: ++reads === 1 ? '附件正文：SELECT 1;' : '已被替换的正文' }) })
  const receipt = await service.ingest({ ...message, text: '分析附件', resourceRefs: [{ resourceId: 'file-1' }] })
  const state = await service.messages.process(receipt.runId)
  assert.equal(state.run.status, 'settled')
  const task = await execution.controller.whenIdle(state.commands[0].result.runId)
  const input = await execution.artifacts.read(task.run.requirementRef)
  assert.deepEqual(input.constraints, ['不可执行SQL'])
  assert.deepEqual(input.materials.find(item => item.id === 'file-1'), { id: 'file-1', text: '附件正文：SELECT 1;' })
  assert.equal(reads, 1)
})

test('通知ACK丢失只回查不重发；当前披露不允许时零发送', async t => {
  let allowed = false, sends = 0, visible = false
  const { service, execution, message } = await fixture(t, 'owner', {
    canDisclose: async () => allowed,
    send: async () => { sends++; throw new Error('ACK_LOST') },
    readback: async notice => visible ? { messageId: `observed:${notice.id}`, conversationId: 'g' } : null,
  })
  const accepted = await service.ingest(message)
  await service.messages.process(accepted.runId)
  const state = await service.state(accepted.runId)
  await execution.controller.whenIdle(state.commands[0].result.runId)
  await service.flushNotifications()
  assert.equal(sends, 0)
  allowed = true
  await service.flushNotifications()
  assert.equal(sends, 2)
  assert.ok((await execution.store.query({ kind: 'message.notifications' })).every(item => item.status === 'unknown'))
  await service.flushNotifications()
  assert.equal(sends, 2)
  visible = true
  await service.flushNotifications()
  assert.equal(sends, 2)
  assert.deepEqual(await execution.store.query({ kind: 'message.notifications' }), [])
})

test('同文高版本编辑复用原Task且别名重投回原run', async t => {
  const { service, execution, message } = await fixture(t)
  const first = await service.ingest(message); await service.messages.process(first.runId)
  const command = (await service.state(first.runId)).commands[0]
  await execution.controller.whenIdle(command.result.runId)
  const edited = await service.ingest({ ...message, messageVersion: 2 })
  assert.equal(edited.runId, first.runId); assert.equal(edited.duplicate, true)
  assert.equal((await service.ingest({ ...message, messageVersion: 2 })).runId, first.runId)
  assert.equal((await execution.store.query({ kind: 'run.list' })).length, 1)
  assert.equal((await execution.store.query({ kind: 'message.list' })).length, 1)
})
test('群职责允许明确点名交办创建任务，普通问题报告仍无创建权',async t=>{
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'new',candidateId:null,evidence:['新事项']}
    :{kind:'intent',actions:[{intent:'create',arguments:{objective:'核对归一化回归',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{judge,legacy:{getGroup:id=>({groupId:id,responsibility:'## 任务准入\n消息明确要求“小小鹏”处理时可以创建任务。',messages:[]})}})
  const passive=await service.ingest({...message,messageId:'report',text:'@孙鹏(孙鹏) 修复又引入了归一化计算问题：当前得到 0.001 t。'})
  await service.messages.process(passive.runId)
  assert.equal((await service.state(passive.runId)).commands[0].status,'rejected')
  const directed=await service.ingest({...message,messageId:'request',text:'@孙鹏(孙鹏) 小小鹏 数据集合并出现的这个问题需要修复'})
  await service.messages.process(directed.runId)
  assert.equal((await service.state(directed.runId)).commands[0].status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
})
test('本机操作者逐条重处理旧澄清，旧请求失效且有命令消息拒绝重跑',async t=>{
  let clarified=false
  const judge=async({stage,input})=>{
    if(stage==='S')return clarified?splitOne(input.source.text):{kind:'needs_clarification',reason:'旧上下文不足',question:'旧问题',needs:[]}
    if(stage==='R')return{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    return{kind:'intent',actions:[{intent:'create',arguments:{objective:'整理本条材料',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  }
  const {service,message}=await fixture(t,'owner',undefined,{judge,config:{webActorId:'owner'}})
  const first=await service.ingest(message);await service.messages.process(first.runId)
  await assert.rejects(service.reprocessMessage(first.runId,{channel:'web',actorId:'other'}),/FORBIDDEN/)
  clarified=true
  const replay=await service.reprocessMessage(first.runId,{channel:'web',actorId:'owner'})
  assert.notEqual(replay.runId,first.runId)
  assert.equal((await service.state(first.runId)).requests[0].status,'superseded')
  assert.equal((await service.state(replay.runId)).commands.length,1)
  assert.equal((await service.ingest(message)).duplicate,true)
  await assert.rejects(service.reprocessMessage(replay.runId,{channel:'web',actorId:'owner'}),/MESSAGE_REPROCESS_EFFECT_PENDING/)
})

test('无引用的先别管它静默收束，不追问也不创建任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge:async()=>{throw new Error('MODEL_MUST_NOT_RUN')}})
  const received=await service.ingest({...message,text:'先别管它'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.run.reason,'message_quiet')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})
test('第三方任务已创建进展同步即使含@也静默，不生成澄清或业务任务',async t=>{
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge:async()=>{throw new Error('PROGRESS_SYNC_MUST_NOT_CALL_MODEL')}})
  const received=await service.ingest({...message,text:'@孙鹏  任务已创建，开始处理。 任务：dingtalk_at_xcm:20260924130713-437 — 小煤球',quotedMessage:{messageId:'old-reply',content:'此前话题的回复'}})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.reason,'message_quiet')
  assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,0)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  const mailbox=(await service.mailboxes()).messages.find(item=>item.messageId===message.messageId)
  assert.equal(mailbox.routingStatus,'pending')
  assert.deepEqual(mailbox.topicRefs,[])
})
test('已送达回复引用可将第三方进展静默绑定到唯一话题，且旧消息可确定性补录',async t=>{
  const outbox=[]
  let calls=0
  const judge=async({stage,input})=>{calls++;return stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
    :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:input.text},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}
  const {service,message,execution}=await fixture(t,'owner',undefined,{judge,legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[],outbox})}})
  const origin=await service.ingest({...message,messageId:'source-1',text:'审核草稿保存的问题'})
  await service.messages.process(origin.runId)
  const topic=(await service.topics('g'))[0]
  assert.ok(topic)
  const progress={...message,messageId:'progress-1',text:'@孙鹏  任务已创建，开始处理。 任务：external-1 — 小煤球',quotedMessage:{messageId:'reply-1',content:'审核问题已核对'}}
  const received=await service.ingest(progress)
  await service.messages.process(received.runId)
  assert.equal((await service.mailboxes()).messages.find(item=>item.messageId==='progress-1').routingStatus,'pending')
  const priorCalls=calls
  outbox.push({status:'sent',deliveredMessageId:'reply-1',sourceMessageId:'source-1'})
  await service.messages.recover()
  const routed=(await service.mailboxes()).messages.find(item=>item.messageId==='progress-1')
  assert.equal(routed.routingStatus,'routed')
  assert.deepEqual(routed.topicRefs.map(item=>item.topicId),[topic.topicId])
  assert.ok((await service.topicContext({groupId:'g',topicId:topic.topicId})).messages.some(item=>item.messageId==='progress-1'))
  assert.equal(calls,priorCalls)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
  await service.messages.recover()
  assert.equal((await service.mailboxes()).messages.find(item=>item.messageId==='progress-1').topicRefs.length,1)
})
test('已完成的纯排查任务再次收到相同问题反馈时提出修复授权问题',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查评审意见草稿再次进入未回显问题',objective:'排查草稿未回显，仅授权排查分析，不实施修改',state:'completed',outcome:'succeeded'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:'问题仍然存在'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'receipt'}})
  const received=await service.ingest({...message,text:'@孙鹏(孙鹏) 审核草稿保存依然有问题，填写评审意见点击保存草稿后，再次进入没有显示草稿内容'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'waiting')
  assert.equal(state.commands.length,0)
  assert.equal(state.requests.length,1)
  assert.match(state.requests[0].question,/是否需要我继续实施修复并验证/u)
  assert.deepEqual(await execution.store.query({kind:'run.list'}),[])
})
test('旧任务缺标题且长目标进入R候选时仍能计算材料摘要',async t=>{
  const task={taskId:'untitled',groupId:'g',objective:'历史目标'.repeat(90),state:'completed',outcome:'succeeded'}
  let sawCandidate=false
  const {service,message}=await fixture(t,'owner',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?(sawCandidate=true,assert.equal(input.candidates.find(item=>item.candidateId==='legacy:untitled').title,task.objective),{kind:'binding',disposition:'new',candidateId:null,evidence:['新消息']})
    :{kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
  const received=await service.ingest({...message,text:'历史目标需要核对'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.notEqual(state.run.reason,'MESSAGE_CONTEXT_OR_DISPATCH_FAILED:INVALID_JSON_VALUE')
  assert.notEqual(state.run.status,'needs_attention')
  assert.equal(sawCandidate,true)
})
test('旧排查任务的肯定答复只授权同一消息继续准入，随后可创建新工作流任务',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查草稿未回显',objective:'排查草稿未回显，仅授权排查分析',state:'completed',outcome:'succeeded'}
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :input.clarificationAnswers?.length
      ?{kind:'intent',actions:[{intent:'create',arguments:{objective:'核验草稿未回显新反馈',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
      :{kind:'intent',actions:[{intent:'fact',arguments:{kind:'fact',text:'问题仍然存在'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{getGroup:id=>({groupId:id,responsibility:'任务准入：肯定答复后准入',messages:[]}),listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge})
  const received=await service.ingest({...message,text:'@孙鹏(孙鹏) 草稿未回显依然有问题'})
  await service.messages.process(received.runId)
  const request=(await service.state(received.runId)).requests[0]
  await service.messages.resume({runId:received.runId,requestId:request.id,eventId:'confirm-1',actorId:'participant',answer:'需要，请继续修复'})
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
})

test('本人可答复他人旧排查澄清，其他群成员不能冒用且不阻断消息接收',async t=>{
  const task={taskId:'old-draft',groupId:'g',title:'排查草稿未回显',objective:'仅授权排查分析',state:'completed',outcome:'succeeded'}
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'
    ?{kind:'binding',disposition:'existing',candidateId:'legacy:old-draft',evidence:['同一现象']}
    :input.clarificationAnswers?.length
      ?{kind:'intent',actions:[{intent:'create',arguments:{objective:'修复草稿未回显',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
      :{kind:'needs_clarification',reason:'消息未明确授权；此前对应任务仅授权排查分析，不能据此实施修改。',question:'继续排查还是修复？',needs:[]}
  const notifications={canDisclose:async()=>true,send:async()=>({messageId:'clarify-sent'}),readback:async()=>({messageId:'clarify-sent',conversationId:'g'})}
  const {service,message,execution}=await fixture(t,'participant',notifications,{legacy:{getGroup:id=>({groupId:id,responsibility:'任务准入',messages:[]}),listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge})
  const received=await service.ingest({...message,text:'@孙鹏(孙鹏) 审核草稿保存依然有问题，评审意见再次进入未回显'})
  await service.messages.process(received.runId)
  const request=(await service.state(received.runId)).requests[0]
  await service.flushNotifications()
  await assert.rejects(service.resumeRequest({runId:received.runId,requestId:request.id,eventId:'outsider',answer:'修复'}, {channel:'im',actorId:'outsider',conversationId:'g'}),/WORKFLOW_ACTION_FORBIDDEN/u)
  const other=await service.ingest({...message,messageId:'other-reply',senderOpenDingTalkId:'outsider',text:'我也要修复',quotedMessage:{messageId:'clarify-sent'}})
  assert.equal(other.duplicate,false)
  await service.messages.process(other.runId)
  assert.equal((await service.state(received.runId)).requests[0].status,'pending')
  const answer='修复并验证，完成后发uat提测'
  const eventId=`dws:${executionDigest(['','g','owner-reply'])}`
  await execution.store.command({id:'old-misrouted-answer',kind:'message.receive',args:{runId:'old-misrouted-answer',sourceKey:eventId,sourceVersion:1,conversationId:'g',actorId:'owner',body:answer,context:{sourceMessageId:'owner-reply',quoteRefs:[{sourceKey:'quote',messageId:'clarify-sent'}]}}})
  const accepted=await service.ingest({...message,messageId:'owner-reply',senderOpenDingTalkId:'owner',text:'修复并验证，完成后发uat提测',quotedMessage:{messageId:'clarify-sent'}})
  assert.equal(accepted.status,'resolved')
  assert.equal((await service.state('old-misrouted-answer')).run.status,'superseded')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
})

test('明确问小小鹏审核问题是否部署时即使I误判无动作也回读群任务',async t=>{
  const task={taskId:'old-review',groupId:'g',title:'审核草稿与撤回通知',objective:'修复审核草稿与撤回通知',state:'completed',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}}}
  const {service,message}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'conversation',candidateId:null,evidence:['群审核任务']}:{kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}})
  assert.deepEqual(service.catalog().builtInWorkflows[0].nodes.map(node=>node.id),['scope','candidates','readback','reply'])
  const received=await service.ingest({...message,text:'小小鹏，我审核的问题都改完部署到uat2了吗？'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].kind,'status')
  assert.match(state.commands[0].result.reply,/UAT2：deployed-and-handed-to-testing/)
})
test('审核状态问句、两个任务说明和引用问题清单归为同一话题，不误建三个任务',async t=>{
  const tasks=[
    {taskId:'draft',groupId:'g',title:'审核草稿与撤回通知可靠化',objective:'修复审核草稿保存和撤回消息通知',state:'completed',outcome:'succeeded',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}}},
    {taskId:'withdraw',groupId:'g',title:'修复专家审核后仍可撤回分配',objective:'修复分配后打回修改撤回的问题',state:'completed',outcome:'cancelled'},
    {taskId:'draft-investigation',groupId:'g',title:'排查审核草稿保存问题',objective:'排查审核草稿保存问题，仅授权排查分析，不实施代码、配置或数据修改',state:'completed',outcome:'succeeded'},
    {taskId:'notice-investigation',groupId:'g',title:'排查撤回消息通知问题',objective:'核对撤回消息通知异常，不实施代码、配置或数据修改',state:'completed',outcome:'succeeded'},
    {taskId:'draft-unknown',groupId:'g',title:'排查审核草稿保存',objective:'核对审核草稿保存现象',state:'completed'},
  ]
  const {service,message,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>tasks,getTask:id=>tasks.find(task=>task.taskId===id)},judge:async({stage,input})=>{
    if(stage==='S' && input.source.text.includes('小小鹏'))throw new Error('STATUS_SPLIT_SHOULD_USE_HOST_RULE')
    if(stage==='S')return splitOne(input.source.text)
    if(stage==='R')return{kind:'binding',disposition:'conversation',candidateId:null,evidence:['群任务']}
    return{kind:'intent',actions:[{intent:'no_action',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  const first=await service.ingest({...message,messageId:'review-question',text:'小小鹏，我审核的问题都改完部署到uat2了吗？'})
  await service.messages.process(first.runId)
  const firstState=await service.state(first.runId)
  assert.equal(firstState.commands[0].kind,'status')
  assert.equal(firstState.commands[0].result.flow.version,'task-progress-query@1')
  assert.deepEqual(firstState.commands[0].result.flow.steps.map(step=>step.nodeId),['scope','candidates','readback','reply'])
  assert.match(firstState.commands[0].result.reply,/审核草稿与撤回通知可靠化/)
  assert.match(firstState.commands[0].result.reply,/修复专家审核后仍可撤回分配/)
  const second=await service.ingest({...message,senderOpenDingTalkId:'owner',messageId:'two-tasks',text:'审核问题会匹配到两个任务'})
  await service.messages.process(second.runId)
  const secondState=await service.state(second.runId)
  assert.deepEqual(secondState.commands.map(item=>item.kind),['fact'])
  const third=await service.ingest({...message,messageId:'review-details',text:'审核草稿保存的问题，分配后打回修改撤回的问题，撤回消息通知的问题',quotedMessage:{messageId:'two-tasks',content:'审核问题会匹配到两个任务'}})
  await service.messages.process(third.runId)
  const thirdState=await service.state(third.runId)
  assert.equal(thirdState.units.length,1)
  assert.deepEqual(thirdState.commands.map(item=>item.kind),['status'])
  assert.match(thirdState.commands[0].result.reply,/UAT2：deployed-and-handed-to-testing/)
  assert.match(thirdState.commands[0].result.reply,/cancelled/)
  assert.equal(thirdState.commands[0].result.items.length,2)
  assert.equal(thirdState.commands[0].result.flow.version,'task-progress-query@1')
  assert.equal((await execution.store.query({kind:'run.list'})).length,0)
  const topicIds=[firstState,secondState,thirdState].map(state=>state.units[0].topicId)
  assert.equal(new Set(topicIds).size,1)
})
test('恢复扫描先重试一次无回执只读查询，再完成原命令',async t=>{
  const task={taskId:'old-review',groupId:'g',title:'审核草稿保存',objective:'修复审核草稿保存',state:'completed',outcome:'succeeded'}
  const {service,execution}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null}})
  const command=(kind,args)=>execution.store.command({id:`test-${kind}`,kind:`message.${kind}`,args})
  await command('receive',{runId:'recover-status',sourceKey:'recover-status',sourceVersion:1,conversationId:'g',actorId:'participant',body:'小小鹏，审核草稿保存的问题完成了吗？',policy:{initialWindowMs:45000}})
  await command('snapshot',{runId:'recover-status',snapshot:{snapshotId:'test-snapshot',source:{sourceKey:'recover-status',sourceVersion:1,text:'小小鹏，审核草稿保存的问题完成了吗？',actorId:'participant',conversationId:'g'},history:[],quotes:[],attachments:[],omissions:[],policy:'',actorPermissions:[]}})
  await command('split',{runId:'recover-status',units:[{unitId:'recover-unit',goalText:'小小鹏，审核草稿保存的问题完成了吗？',spans:[{start:0,end:22}],constraints:[],contextNeeds:[],sharedConstraints:[]}]})
  await command('accept',{runId:'recover-status',unitId:'recover-unit',commands:[{commandId:'recover-command',kind:'status',args:{taskId:null,arguments:{scope:'conversation'},binding:{disposition:'conversation'},replyPolicy:'none'}}]})
  const claimed=(await command('command.claim',{commandId:'recover-command'})).result.command
  await command('command.fail',{commandId:'recover-command',leaseEpoch:claimed.leaseEpoch,error:'INVALID_ARGUMENT'})
  await command('attention',{runId:'recover-status',reason:'recovery_exhausted'})
  await service.messages.recover()
  const state=await service.state('recover-status')
  assert.equal(state.run.status,'settled')
  assert.equal(state.commands[0].status,'applied')
  assert.equal(state.commands[0].readonlyRetryCount,1)
})

test('已回读的自身澄清通知不再作为新消息入站，收发信箱分别投影', async t => {
  const sent = []
  const notifications = { canDisclose: async () => true, send: async notice => { const item = { messageId: 'out-1', text: notice.payload.text }; sent.push(item); return { messageId: item.messageId } }, readback: async () => ({ messageId: 'out-1', conversationId: 'g' }) }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { judge: async ({ stage }) => stage === 'S' ? { kind: 'needs_clarification', reason: '问题不明确', question: '请说明具体任务', needs: [] } : null })
  const original = await service.ingest(message)
  await service.messages.process(original.runId)
  await service.flushNotifications()
  const echo = await service.ingest({ ...message, messageId: 'out-1', text: sent[0].text })
  assert.equal(echo.processing, 'outbound-echo')
  const genuine = await service.ingest({ ...message, messageId: 'manual-2', text: sent[0].text })
  assert.equal(genuine.duplicate, false)
  assert.equal((await execution.store.query({ kind: 'message.list', conversationId: 'g', limit: 30 })).length, 2)
  const mailboxes = await service.mailboxes()
  assert.equal(mailboxes.messages.length, 2)
  assert.equal(mailboxes.outbox.length, 1)
  assert.equal(mailboxes.outbox[0].status, 'sent')
  await execution.store.command({ id: 'old-echo', kind: 'message.receive', args: { runId: 'old-echo', sourceKey: 'echo:out-1', sourceVersion: 1, conversationId: 'g', actorId: 'owner', body: sent[0].text, context: { sourceMessageId: 'out-1' } } })
  await service.messages.recover()
  assert.equal((await service.state('old-echo')).run.status, 'superseded')
  await execution.store.command({ id: 'recall-out-1', kind: 'message.notification.recall.record', args: { notificationId: mailboxes.outbox[0].outboundId, messageId: 'out-1', recallStatus: 'SUCCESS', evidenceRef: 'test-readback-recall' } })
  assert.equal((await service.mailboxes()).outbox[0].recallStatus, 'recalled')
})

test('受管撤回逐条核验负责人原消息，回读后补发保留原通知', async t => {
  let sends = 0, recalls = 0
  const notifications = {
    canDisclose: async () => true,
    send: async () => ({ messageId: `out-${++sends}` }),
    readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }),
    recall: async () => { recalls++; return { recallStatus: 'SUCCESS' } },
    readbackRecall: async ({ messageId }) => ({ messageId, recallStatus: 'SUCCESS', conversationId: 'g' }),
  }
  const { service, execution, message } = await fixture(t, 'owner', notifications, { config: { webActorId: 'owner' } })
  const received = await service.ingest(message)
  await service.messages.process(received.runId)
  await service.flushNotifications()
  const notice = (await execution.store.query({ kind: 'message.notifications', states: ['delivered'] }))[0]
  const originalSource = (await execution.store.query({ kind: 'message.run', runId: received.runId })).run.sourceKey
  await assert.rejects(service.prepareWorkflowNotificationOperation({ operationId: 'recall-1', notificationId: notice.id,
    type: 'recall', reason: 'explicit_user', authorizationRef: originalSource }), /AUTHORIZATION_REQUIRED/u)
  const authorization = await service.ingest({ ...message, messageId: 'auth-recall', text: `撤回通知 ${notice.id}` })
  const authSource = (await execution.store.query({ kind: 'message.run', runId: authorization.runId })).run.sourceKey
  const prepared = await service.prepareWorkflowNotificationOperation({ operationId: 'recall-1', notificationId: notice.id,
    type: 'recall', reason: 'explicit_user', authorizationRef: authSource })
  const executed = await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })
  assert.equal(executed.status, 'completed')
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: prepared.id,
    expectedFactDigest: prepared.snapshot.expectedFactDigest, authorizationRef: authSource })).status, 'completed')
  assert.equal(recalls, 1)
  assert.equal((await service.mailboxes()).outbox.find(item => item.outboundId === notice.id).recallStatus, 'recalled')
  const restoreAuthorization = await service.ingest({ ...message, messageId: 'auth-restore', text: `补发通知 ${notice.id}` })
  const restoreSource = (await execution.store.query({ kind: 'message.run', runId: restoreAuthorization.runId })).run.sourceKey
  const restore = await service.prepareWorkflowNotificationOperation({ operationId: 'restore-1', notificationId: notice.id,
    type: 'restore', reason: 'explicit_user', authorizationRef: restoreSource })
  assert.equal((await service.executeWorkflowNotificationOperation({ operationId: restore.id,
    expectedFactDigest: restore.snapshot.expectedFactDigest, authorizationRef: restoreSource })).status, 'completed')
  assert.equal(sends, 2)
  assert.equal((await service.mailboxes()).outbox.find(item => item.replacesNotificationId === notice.id).deliveredMessageId, 'out-2')
})

test('群职责进入 I 而不占用 S/R；任务历史可由固定材料键读取', async t => {
  let seen
  const task = { taskId: 'old-1', groupId: 'g', title: '审核草稿保存', objective: '修复审核草稿保存问题', state: 'completed', outcome: '已完成', objectiveHistory: [{ objective: '定位保存失败', revisedAt: '2026-09-23T00:00:00Z' }] }
  const { service, message } = await fixture(t, 'owner', undefined, { legacy: { listTasks: () => [task], getTask: id => id === task.taskId ? task : null }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { ...splitOne(input.source.text), units: [{ ...splitOne(input.source.text).units[0], contextNeeds: [{ resourceRef: 'task-history:old-1', reason: '核对已有任务' }] }] }
    if (stage === 'R') { seen = input; return { kind: 'binding', disposition: 'conversation', candidateId: null, evidence: ['群任务'] } }
    assert.match(input.groupResponsibility, /处理本人交办事项/)
    return { kind: 'intent', actions: [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  } })
  const received = await service.ingest(message)
  await service.messages.process(received.runId)
  assert.match(JSON.stringify(seen.material), /定位保存失败/)
  assert.equal((await service.state(received.runId)).run.status, 'settled')
})

test('群成员可核对本群旧任务摘要和UAT2交付状态，跨群历史不可读取', async t => {
  const task={taskId:'old-uat',groupId:'g',title:'审核草稿与撤回通知',objective:'修复审核草稿与撤回通知',state:'completed',outcome:'succeeded',result:{delivery:{uat2Status:'deployed-and-handed-to-testing'}},objectiveHistory:[]}
  const {service,message}=await fixture(t,'participant',undefined,{legacy:{listTasks:()=>[task],getTask:id=>id===task.taskId?task:null},judge:async({stage,input})=>{
    if(stage==='S')return splitOne(input.source.text)
    if(stage==='R')return{kind:'binding',disposition:'existing',candidateId:'legacy:old-uat',evidence:['同群旧任务']}
    assert.equal(input.facts.legacyTask.uat2Status,'deployed-and-handed-to-testing')
    return{kind:'intent',actions:[{intent:'status',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
  }})
  const received=await service.ingest({...message,text:'审核问题部署UAT2了吗'})
  await service.messages.process(received.runId)
  const state=await service.state(received.runId)
  assert.equal(state.run.status,'settled')
  assert.match(state.commands[0].result.reply,/UAT2：deployed-and-handed-to-testing/)
})

test('旧群历史缺发送人字段时仍能写入快照',async t=>{
  const {service,message}=await fixture(t,'owner',undefined,{legacy:{getGroup:id=>({groupId:id,responsibility:'处理本人交办事项',messages:[{messageId:'old',text:'历史问题'}]})}})
  const received=await service.ingest(message)
  await service.messages.process(received.runId)
  assert.ok((await service.state(received.runId)).run.snapshot)
})

test('五类旧只读流程共享消息schema、可用列表和创建路由，外部效果流程不准入', async t => {
  const ids = ['task-investigation', 'task-planning', 'task-pr-review', 'task-data-query', 'task-retrospective']
  let selected = 0
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    const available = input.facts.availableWorkflows.map(item => item.id)
    assert.ok(ids.every(id => available.includes(id)))
    assert.deepEqual(input.facts.unavailableWorkflows, ['UAT交付', '生产发布', '数据变更', 'UAT同提交重建'])
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: input.text, workflowId: ids[selected++] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const catalog = service.catalog()
  assert.equal(catalog.engine, 'workflow-v2')
  assert.deepEqual(catalog.messageStages.map(stage => stage.id), ['receive', 'context', 'S', 'R', 'routing-barrier', 'IB', 'intent-check', 'dispatch'])
  assert.equal(catalog.workflows.length, taskWorkflowCatalog.length)
  assert.ok(ids.every(id => catalog.workflows.some(item => item.id === id && item.status === 'available' && item.version && item.nodes.length)))
  assert.equal(catalog.workflows.find(item => item.id === 'task-data-change').status, 'unavailable')
  for (let index = 0; index < ids.length; index++) {
    const receipt = await service.ingest({ ...message, messageId: `readonly-${index}`, text: `审阅材料 ${index}` })
    const state = await service.messages.process(receipt.runId)
    assert.equal(state.run.status, 'settled')
    const run = await execution.store.query({ kind: 'run', runId: state.commands[0].result.runId })
    assert.equal(run.run.workflowId, ids[index])
    const view = (await service.tasks()).find(task => task.taskId === run.run.taskId)
    assert.equal(view.workflowId, ids[index])
    assert.equal(view.workflowVersion, run.run.definitionVersion)
  }
  assert.deepEqual(taskWorkflowCatalog.filter(item => item.mode === 'read-only').map(item => item.id), ['task-analysis', ...ids])
  const envelope = { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '生产数据变更', workflowId: 'task-data-change' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  assert.equal(messageSchemas.I.safeParse(envelope).success, true)
  const denied = await fixture(t, 'owner', undefined, { judge: async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] } : envelope })
  const blocked = await denied.service.ingest({ ...denied.message, messageId: 'external-denied', text: '执行生产数据变更' })
  const deniedState = await denied.service.messages.process(blocked.runId)
  assert.equal(deniedState.commands[0].status, 'rejected')
  assert.deepEqual(await denied.execution.store.query({ kind: 'run.list' }), [])
})

test('受信外部适配器齐备时四类流程可选并按固定需求创建，模型不持有执行能力', async t => {
  const ids = ['task-uat-delivery', 'task-production-release', 'task-data-change', 'task-uat-rebuild']
  const digest = createHash('sha256').update('rules').digest('hex')
  const releaseAdapter = kind => ({ id: kind, version: '1', rulesDigest: digest,
    inspect: async () => { throw new Error('PREFLIGHT_NOT_AVAILABLE') }, prepareOperation: async () => { throw new Error('EFFECT_NOT_EXPECTED') } })
  const dataChangeAdapter = { id: 'bytebase-test', version: '1', rulesDigest: digest,
    validate: async () => { throw new Error('VALIDATION_NOT_EXPECTED') },
    prepareRehearsal: async () => { throw new Error('REHEARSAL_NOT_EXPECTED') },
    readbackRehearsal: async () => { throw new Error('REHEARSAL_NOT_EXPECTED') },
    inspect: async () => { throw new Error('INSPECT_NOT_EXPECTED') }, prepareIssue: async () => { throw new Error('ISSUE_NOT_EXPECTED') },
    prepareApproval: async () => { throw new Error('APPROVAL_NOT_EXPECTED') },
    prepareExecute: async () => { throw new Error('EXECUTE_NOT_EXPECTED') }, readback: async () => { throw new Error('READBACK_NOT_EXPECTED') } }
  const source = 'SELECT 1', hash = createHash('sha256').update(source).digest('hex')
  let selected = 0, prepared = 0, effects = 0
  const external = { releaseAdapters: Object.fromEntries(['uat-delivery', 'production-release', 'uat-rebuild'].map(kind => [kind, releaseAdapter(kind)])), dataChangeAdapter,
    operationAdapter: { execute: async () => { effects++; throw new Error('EFFECT_NOT_EXPECTED') }, reconcile: async () => { effects++; throw new Error('EFFECT_NOT_EXPECTED') } },
    authorizeExternal: async () => { throw new Error('AUTHORIZATION_NOT_EXPECTED') },
    prepareRequirement: async ({ workflowId, action }) => {
      prepared++
      assert.ok(ids.includes(workflowId))
      if (workflowId === 'task-data-change') return { request: action.arguments.objective, constraints: [], target: { instance: 'test', database: 'test', environment: 'uat' },
        sources: [{ id: 's', sha256: hash, content: source }], baseline: { snapshotId: 'baseline', sha256: hash } }
      return { request: action.arguments.objective, constraints: [], evidenceRefs: ['source'], target: { repository: 'org/repo', environment: workflowId === 'task-production-release' ? 'production' : 'uat', service: 'service', commitSha: 'a'.repeat(40), runbookId: 'runbook' } }
    } }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['source'] }
    assert.ok(ids.every(id => input.facts.availableWorkflows.some(item => item.id === id)))
    assert.deepEqual(input.facts.unavailableWorkflows, [])
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: input.text, workflowId: ids[selected++] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { external, judge })
  assert.ok(ids.every(id => service.catalog().workflows.some(item => item.id === id && item.status === 'available' && item.version && item.nodes.length)))
  for (let index = 0; index < ids.length; index++) {
    const receipt = await service.ingest({ ...message, messageId: `external-${index}`, text: `处理外部任务 ${index}` })
    const state = await service.messages.process(receipt.runId)
    assert.equal(state.commands[0].status, 'applied', JSON.stringify(state.commands[0]))
    const run = await execution.store.query({ kind: 'run', runId: state.commands[0].result.runId })
    assert.equal(run.run.workflowId, ids[index])
  }
  assert.equal(prepared, 4)
  assert.equal(effects, 0)
})

test('原消息否定编辑取消原Task，不发第二个任务且屏障释放', async t => {
  const judge = async ({stage,input}) => stage === 'S' ? splitOne(input.source.text) : stage === 'R'
    ? {kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}
    : {kind:'intent',actions:[{intent:input.sourceEdit?'cancel':'create',arguments:input.sourceEdit?{}:{objective:'整理材料',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}
  const { service, execution, message } = await fixture(t,'owner',undefined,{judge})
  const first=await service.ingest(message); await service.messages.process(first.runId)
  const initial=(await service.state(first.runId)).commands[0]
  await execution.controller.whenIdle(initial.result.runId)
  const edit=await service.ingest({...message,text:'不要执行原任务，取消',messageVersion:2});await service.messages.process(edit.runId)
  const state=await service.state(edit.runId)
  assert.equal(state.commands[0]?.kind,'cancel',JSON.stringify(state));assert.equal(state.commands[0]?.status,'applied')
  assert.equal((await execution.store.query({kind:'run.list'})).length,1)
  assert.ok(state.barriers.every(b=>b.status==='resolved'))
})

test('运行中原消息修订只更新原Task输入代际并解除编辑屏障', async t => {
  let release,started
  const began=new Promise(r=>started=r), gate=new Promise(r=>release=r)
  t.after(()=>release())
  const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:input.sourceEdit?'existing':'new',candidateId:input.sourceEdit?input.candidates.find(c=>c.taskId)?.candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:input.sourceEdit?'revise':'create',arguments:{objective:input.sourceEdit?'按新增要求分析':'整理材料',workflowId:'task-analysis'},dependsOn:[]}],constraints:input.sourceEdit?['新增格式要求']:['禁止生产写入'],requiredExecutionMaterials:[],replyPolicy:'result'}
  const {service,execution,message}=await fixture(t,'owner',undefined,{judge,execute:async({input})=>{started();await gate;return{summary:input.request}}})
  const first=await service.ingest(message);await service.messages.process(first.runId);await began
  const original=(await service.state(first.runId)).commands[0]
  const edit=await service.ingest({...message,text:'改为按新增要求分析',messageVersion:2});await service.messages.process(edit.runId)
  const state=await service.state(edit.runId)
  assert.equal(state.commands[0]?.kind,'revise',JSON.stringify(state.run));assert.equal(state.commands[0]?.status,'applied')
  assert.ok(state.barriers.every(b=>b.status==='resolved'))
  const runs=await execution.store.query({kind:'run.list'});assert.equal(runs.length,1);assert.equal(runs[0].taskId,original.result.taskId)
  release();await execution.controller.whenIdle(original.result.runId)
  const final=await execution.store.query({kind:'run',runId:original.result.runId})
  assert.equal((await execution.artifacts.read(final.run.requirementRef)).request,'按新增要求分析')
  assert.deepEqual((await execution.artifacts.read(final.run.requirementRef)).constraints,['禁止生产写入','新增格式要求'])
})

test('新Task真实HTTP补充与取消同库幂等；无权/跨站/伪造输入不执行，暂停不恢复',async t=>{
 let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},execute:async()=>{started();await gate;return {summary:'done'}}})
 const received=await service.ingest(message);await service.messages.process(received.runId);await began
 const original=(await service.state(received.runId)).commands[0].result
 await execution.controller.pause({commandId:'pause-test',runId:original.runId,reason:'先暂停'});release();await execution.controller.whenIdle(original.runId)
 let legacyCalls=0
 const runtime={isWorkflowTask:service.isTask,submitWorkflowTask:r=>service.submitWebTask(r,{channel:'web',actorId:'owner'}),cancelTask:()=>{legacyCalls++;throw new Error('legacy')},appendTaskContext:()=>{legacyCalls++;throw new Error('legacy')}}
 const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const post=(action,body,origin)=>fetch(`http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/${action}`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
 const task=(await service.tasks())[0],input={requestId:'web-context-1',inputVersion:task.inputVersion,runSequence:1,context:'追加检查中文格式',topicRefs:[]}
 assert.equal((await post('context',input,'https://evil.example')).status,403)
 assert.equal((await post('context',{...input,actorId:'owner'})).status,400)
 await assert.rejects(service.submitWebTask({...input,action:'context',taskId:task.taskId},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 await assert.rejects(service.submitWebTask({action:'reissue-repository',taskId:task.taskId,repositoryId:'backend',requestId:'unauthorized'},{channel:'web',actorId:'attacker'}),/FORBIDDEN/)
 const firstContext=await post('context',input);assert.equal(firstContext.status,202,await firstContext.text());assert.equal((await post('context',input)).status,202)
 assert.equal((await post('context',{...input,context:'冲突内容'})).status,409)
 let state=await execution.controller.state(original.runId);assert.equal(state.pendingInputCount,1);assert.equal(state.run.pauseRequested,true)
 assert.equal((await post('reopen',input)).status,409);assert.equal((await post('archive',{})).status,409)
 const cancel={requestId:'web-cancel-1',inputVersion:(await service.tasks())[0].inputVersion,runSequence:1,reason:'停止'}
 assert.equal((await post('cancel',cancel)).status,202);assert.equal((await post('cancel',cancel)).status,202)
 await execution.controller.whenIdle(original.runId);state=await execution.controller.state(original.runId);assert.equal(state.run.status,'cancelled');assert.equal(legacyCalls,0)
})

test('Controller未排空错误投影等待原因，不能显示正常执行',async t=>{
 const {service,execution,message}=await fixture(t,'owner',undefined,{execute:async()=>{throw Object.assign(new Error('EXECUTOR_DRAIN_EVIDENCE_REQUIRED'),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED',executionDrained:false})}})
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result;await execution.controller.whenIdle(task.runId).catch(error=>assert.equal(error.code,'EXECUTOR_DRAIN_EVIDENCE_REQUIRED'))
 assert.equal((await execution.controller.state(task.runId)).run.status,'running')
 const view=(await service.tasks())[0];assert.equal(view.state,'waiting');assert.equal(view.waitingReason,'EXECUTOR_DRAIN_EVIDENCE_REQUIRED')
})

test('Web事件已准备后中断由恢复通路接纳一次，后续恢复不重复输入',async t=>{
 let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const {service,execution,message}=await fixture(t,'owner',undefined,{config:{webActorId:'owner'},execute:async()=>{started();await gate;return{summary:'done'}}})
 const first=await service.ingest(message);await service.messages.process(first.runId)
 const task=(await service.state(first.runId)).commands[0].result;await began
 await execution.controller.pause({commandId:'prepare-pause',runId:task.runId,reason:'暂停'});release();await execution.controller.whenIdle(task.runId)
 const state=await execution.controller.state(task.runId),prior=await execution.artifacts.read(state.run.requirementRef)
 await execution.store.command({id:'prepare-only',kind:'message.web-task.prepare',args:{eventId:'web-crash',actorId:'owner',executionRunId:task.runId,request:{taskId:task.taskId,action:'context',requestId:'crash',inputVersion:state.run.revision+1,runSequence:1,context:'新要求'},input:{...prior,request:prior.request+'\n新要求'}}})
 assert.deepEqual(await service.recoverExecutionTasks(),[]);await execution.controller.whenIdle(task.runId)
 assert.equal((await execution.store.query({kind:'message.web-task',eventId:'web-crash'})).status,'accepted')
 const before=await execution.controller.state(task.runId);assert.deepEqual(await service.recoverExecutionTasks(),[]);await execution.controller.whenIdle(task.runId)
 const after=await execution.controller.state(task.runId)
 assert.equal(after.run.revision,before.run.revision);assert.equal(after.pendingInputCount,before.pendingInputCount)
})

test('C01 媒体连接器挂起不阻durable接收和独立SQLite读回',{timeout:5000},async t=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r)
 const judge=async({stage,input})=>stage==='S'?splitOne(input.source.text):stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}:{kind:'intent',actions:[{intent:'create',arguments:{objective:'读取附件',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:['file'],replyPolicy:'result'}
 const {service,execution,message}=await fixture(t,'owner',undefined,{judge,readResource:async()=>{started();await gate;return{text:'完整材料'}}})
 const received=await service.ingest({...message,resourceRefs:[{resourceId:'file'}]})
 try{await began;const persisted=await execution.store.query({kind:'message.run',runId:received.runId});assert.equal(persisted.run.body,message.text);assert.equal(persisted.commands.length,0);assert.equal((await execution.store.query({kind:'run.list'})).length,0)}finally{release()}
 await service.messages.process(received.runId)
 let settled
 for(let attempt=0;attempt<100;attempt++){
   settled=await service.state(received.runId)
   if(settled.commands[0]?.status==='applied')break
   await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.equal(settled.commands[0].status,'applied')
})

test('只关联话题时意图仍读到已执行Task及结果限制，运行成功不冒充目标达成', async t => {
  let observed, routingCard
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') {
      routingCard = input.candidates.find(item => item.taskId)
      return input.candidates.length
        ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates.find(item => item.topicId)?.candidateId ?? input.candidates[0].candidateId, evidence: ['同一账号问题'] }
        : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新问题'] }
    }
    if (input.text === '继续查这个账号') {
      observed = input.facts
      return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
    }
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '查 test3 账号创建记录', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, {
    judge, execute: async () => ({ summary: '仅整理了消息文字', evidenceIds: [], limitations: ['没有读取账号创建日志'] }),
  })
  const first = await service.ingest({ ...message, text: '查 test3 账号创建记录' })
  const accepted = await service.messages.process(first.runId)
  assert.ok(accepted.commands.length, JSON.stringify({ run: accepted.run, requests: accepted.requests, nodes: accepted.nodes }))
  const taskId = accepted.commands[0].result.taskId
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  const second = await service.ingest({ ...message, messageId: 'followup', text: '继续查这个账号' })
  await service.messages.process(second.runId)
  const task = observed?.tasks?.find(item => item.taskId === taskId) ?? observed?.topicTasks?.tasks?.find(item => item.taskId === taskId)
  assert.ok(task, JSON.stringify(observed))
  assert.ok(routingCard.distinguishingFacts.some(item => item.includes('执行状态：succeeded')))
  assert.ok(routingCard.distinguishingFacts.some(item => item.includes('没有读取账号创建日志')))
  assert.equal(task.run.status, 'succeeded')
  assert.deepEqual(task.result.limitations, ['没有读取账号创建日志'])
  assert.equal(task.objectiveAssessment.status, 'unassessed')
})

test('方案阶段完成后等待确认，确认沿用业务Task并只启动下一阶段', async t => {
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return splitOne(input.source.text)
    if (stage === 'R') return input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
    return input.text.startsWith('确认方案')
      ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '继续执行', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先给方案', workflowId: 'task-analysis', workflowPlan: [
        { workflowId: 'task-analysis', gate: 'none' }, { workflowId: 'task-analysis', gate: 'confirmation' },
      ] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '先给方案，确认后继续' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId
  await execution.controller.whenIdle(accepted.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  let plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.status, 'waiting_confirmation')
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 1)
  const second = await service.ingest({ ...message, messageId: 'confirm-stage', text: '确认方案，继续执行' })
  const confirmed = await service.messages.process(second.runId)
  assert.equal(confirmed.commands[0].status, 'applied')
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[1].status, 'running')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded')
})

test('编排UAT但缺受信适配器时只阻塞UAT阶段，不冒充提测完成', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先分析再提测', workflowId: 'task-analysis', workflowPlan: [
        { workflowId: 'task-analysis', gate: 'none' }, { workflowId: 'task-uat-delivery', gate: 'none' },
      ] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const received = await service.ingest({ ...message, text: '分析并提测' })
  const result = await service.messages.process(received.runId)
  assert.equal(result.commands.length, 1, JSON.stringify({ status: result.run.status, reason: result.run.reason, requests: result.requests }))
  await execution.controller.whenIdle(result.commands[0].result.runId)
  assert.deepEqual((await service.recover()).failures, [])
  const task = (await service.tasks())[0]
  assert.equal(task.state, 'waiting')
  assert.equal(task.plan.stages[1].status, 'blocked')
  assert.match(task.waitingReason, /受信执行适配器/)
  assert.equal((await execution.store.query({ kind: 'run.list', taskId: task.taskId })).length, 1)
})

test('执行中收到追加阶段意图时保留当前Run，完成后从核验产物启动后继', async t => {
  let release, began
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { began = resolve })
  t.after(() => release())
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : input.text.startsWith('追加')
        ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '追加后续分析', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '先排查', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge,
    execute: async ({ input }) => { if (input.request === '先排查') { began(); await gate }; return { summary: input.request, evidenceIds: input.materials.map(item => item.id), limitations: [] } } })
  const first = await service.ingest({ ...message, text: '先排查' })
  const accepted = await service.messages.process(first.runId)
  await started
  const taskId = accepted.commands[0].result.taskId
  const firstRunId = accepted.commands[0].result.runId
  const second = await service.ingest({ ...message, messageId: 'append-later', text: '追加后续分析' })
  const appended = await service.messages.process(second.runId)
  assert.equal(appended.commands[0].status, 'applied')
  let plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages.length, 2)
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[1].status, 'blocked')
  release(); await execution.controller.whenIdle(firstRunId)
  assert.deepEqual((await service.recover()).failures, [])
  plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.stages[1].status, 'running')
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded')
  assert.equal((await execution.store.query({ kind: 'run.list', taskId })).length, 2)
})

test('纯排查完成后续办仍用原业务Task，原Run成功证据不重跑', async t => {
  const judge = async ({ stage, input }) => stage === 'S' ? splitOne(input.source.text)
    : stage === 'R' ? input.candidates.length
      ? { kind: 'binding', disposition: 'existing', candidateId: input.candidates[0].candidateId, evidence: ['原任务'] }
      : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['新任务'] }
      : input.text.startsWith('继续')
        ? { kind: 'intent', actions: [{ intent: 'reopen', arguments: { objective: '继续分析', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
        : { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '仅排查', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'receipt' }
  const { service, execution, message } = await fixture(t, 'owner', undefined, { judge })
  const first = await service.ingest({ ...message, text: '仅排查' })
  const accepted = await service.messages.process(first.runId)
  const taskId = accepted.commands[0].result.taskId, firstRunId = accepted.commands[0].result.runId
  await execution.controller.whenIdle(firstRunId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await execution.controller.taskPlan(taskId)).task.status, 'succeeded')
  const second = await service.ingest({ ...message, messageId: 'continue-task', text: '继续分析' })
  const resumed = await service.messages.process(second.runId)
  assert.equal(resumed.commands[0].status, 'applied')
  const plan = await execution.controller.taskPlan(taskId)
  assert.equal(plan.task.planRevision, 2)
  assert.equal(plan.stages[0].runId, firstRunId)
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'running')
  await execution.controller.whenIdle(plan.stages[1].runId)
  assert.deepEqual((await service.recover()).failures, [])
  assert.equal((await service.tasks()).length, 1)
})

test('C13 渠道读回挂起时新业务和取消继续，ACK不冒充送达',{timeout:7000},async t=>{
 let readStarted,releaseRead,executionStarted,releaseExecution,executions=0,disclose=false
 const reading=new Promise(r=>readStarted=r),readGate=new Promise(r=>releaseRead=r),running=new Promise(r=>executionStarted=r),executionGate=new Promise(r=>releaseExecution=r)
 const notices={canDisclose:async()=>disclose,send:async n=>({messageId:n.id}),readback:async n=>{readStarted();await readGate;return{messageId:n.id,conversationId:'g'}}}
 const {service,execution,message}=await fixture(t,'owner',notices,{config:{webActorId:'owner'},execute:async()=>{if(++executions===1){executionStarted();await executionGate}return{summary:'完成'}}})
 const first=await service.ingest(message);await service.messages.process(first.runId);await running
 const task=(await service.state(first.runId)).commands[0].result;await service.flushNotifications();assert.equal((await execution.store.query({kind:'message.notifications'}))[0].status,'prepared');disclose=true;const flushing=service.flushNotifications()
 try{await reading
 const pending=await execution.store.query({kind:'message.notifications'});assert.ok(pending.some(n=>n.status==='acknowledged'));assert.ok(!pending.some(n=>n.status==='delivered'))
 const next=await service.ingest({...message,messageId:'second'});await service.messages.process(next.runId);const nextTask=(await service.state(next.runId)).commands[0].result;await execution.controller.whenIdle(nextTask.runId)
 assert.equal((await execution.controller.state(nextTask.runId)).run.status,'succeeded')
 const view=(await service.tasks()).find(t=>t.taskId===task.taskId);assert.equal(view.state,'running')
 await service.submitWebTask({action:'cancel',taskId:task.taskId,requestId:'cancel-during-readback',inputVersion:view.inputVersion,runSequence:1,reason:'取消'},{channel:'web',actorId:'owner'})
 assert.equal((await execution.controller.state(task.runId)).run.stopRequested,true)
 }finally{releaseExecution();releaseRead()}
 await flushing;await execution.controller.whenIdle(task.runId);assert.equal((await execution.controller.state(task.runId)).run.status,'cancelled')
 assert.equal((await execution.store.query({kind:'message.notifications',states:['delivered']})).length,1)
})
