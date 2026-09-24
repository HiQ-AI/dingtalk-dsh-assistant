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
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { messageSchemas, taskWorkflowCatalog } from '../packages/dingtalk-dsh-assistant/message-context.js'

const schema = { type: 'object', additionalProperties: true }
const splitOne = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] })
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
  const service = await openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', ...options.config }, legacy, judge: options.judge ?? judge, execution, notifications, readResource: options.readResource, external: options.external })
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
  await assert.rejects(service.reprocessMessage(replay.runId,{channel:'web',actorId:'owner'}),/MESSAGE_REPROCESS_EXHAUSTED/)
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
  await execution.store.command({ id: 'recall-out-1', kind: 'message.notification.recall.record', args: { notificationId: mailboxes.outbox[0].outboundId, messageId: 'out-1', recallStatus: 'SUCCESS' } })
  assert.equal((await service.mailboxes()).outbox[0].recallStatus, 'recalled')
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
  assert.deepEqual(catalog.messageStages.map(stage => stage.id), ['receive', 'context', 'S', 'R', 'I', 'dispatch'])
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
    validate: async () => { throw new Error('VALIDATION_NOT_EXPECTED') }, rehearse: async () => { throw new Error('REHEARSAL_NOT_EXPECTED') },
    inspect: async () => { throw new Error('INSPECT_NOT_EXPECTED') }, prepareIssue: async () => { throw new Error('ISSUE_NOT_EXPECTED') },
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
 assert.equal((await post('context',input)).status,202);assert.equal((await post('context',input)).status,202)
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
 const task=(await service.state(first.runId)).commands[0].result;await execution.controller.whenIdle(task.runId)
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
 await service.recover();await execution.controller.whenIdle(task.runId)
 assert.equal((await execution.store.query({kind:'message.web-task',eventId:'web-crash'})).status,'accepted')
 const before=await execution.controller.state(task.runId);await service.recover();await execution.controller.whenIdle(task.runId)
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
 assert.equal((await service.state(received.runId)).commands[0].status,'applied')
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
