import { scriptedCoordinator, actionDecision } from './fixtures/group-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { toToolJsonSchema } from '../packages/dingtalk-dsh-assistant/tool-schema.js'
import { intentContext, validateExecutionMaterialRefs, messageSchemas } from '../packages/dingtalk-dsh-assistant/message-context.js'

test('启动材料引用由Host列举，查询资源和其他事项引用不能进入材料等待', () => {
  const input = intentContext({ sourceKey: 'source-a', executionMaterialRefs: ['attachment-a'],
    referenceSources: [{ sourceKey: 'quote-a' }] }, { disposition: 'new' }, {})
  const intent = refs => ({ kind: 'intent', actions: [], requiredExecutionMaterials: refs })
  assert.deepEqual(input.executionMaterialRefs, ['source-a', 'attachment-a', 'quote-a'])
  assert.doesNotThrow(() => validateExecutionMaterialRefs('I', intent(['attachment-a']), input))
  assert.doesNotThrow(() => validateExecutionMaterialRefs('I', intent([]), input))
  assert.throws(() => validateExecutionMaterialRefs('I', intent(['registered-code-resource']), input), /MESSAGE_EXECUTION_MATERIAL_REF_INVALID/)
  const batch = { units: [{ unitId: 'a', input }, { unitId: 'b', input: { executionMaterialRefs: ['source-b'] } }] }
  assert.throws(() => validateExecutionMaterialRefs('IB', { kind: 'topic_intents', decisions: [
    { unitId: 'a', intent: intent(['source-b']) }] }, batch), /MESSAGE_EXECUTION_MATERIAL_REF_INVALID/)
  assert.doesNotThrow(() => validateExecutionMaterialRefs('IB', { kind: 'topic_intents', decisions: [
    { unitId: 'a', intent: intent(['source-a']) }, { unitId: 'b', intent: intent(['source-b']) }] }, batch))
})

test('外部阶段授权在消息入口要求完整原文合同，非外部任务不增加门槛', () => {
  const body = '生产 Editor process_id_temp 新增 is_deleted 默认0'
  const intent = args => ({ kind: 'intent', actions: [{ intent: 'create', arguments: { objective: body, ...args }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' })
  const authorization = { workflowId: 'task-data-change', sourceQuote: body, objective: body, gate: 'none' }
  assert.equal(messageSchemas.I.safeParse(intent({ stageAuthorizations: [authorization] })).success, true)
  const toolSchema = toToolJsonSchema(messageSchemas.I)
  const rendered = JSON.stringify(toolSchema)
  assert.match(rendered, /objective/)
  const findExternal = node => {
    if (!node || typeof node !== 'object') return null
    if (node.properties?.workflowId?.enum?.includes('task-data-change') && node.properties?.sourceQuote) return node
    for (const value of Object.values(node)) { const found = Array.isArray(value) ? value.map(findExternal).find(Boolean) : findExternal(value); if (found) return found }
    return null
  }
  assert.ok(findExternal(toolSchema).required.includes('objective'))
  assert.ok(findExternal(toolSchema).required.includes('gate'))
  for (const field of ['objective', 'gate']) {
    const missing = { ...authorization }; delete missing[field]
    assert.equal(messageSchemas.I.safeParse(intent({ stageAuthorizations: [missing] })).success, false)
    assert.throws(() => validateExecutionMaterialRefs('I', intent({ stageAuthorizations: [missing] }), { text: body }), /MESSAGE_STAGE_AUTHORIZATION_INVALID/)
  }
  assert.equal(messageSchemas.I.safeParse(intent({ workflowId: 'task-data-change' })).success, false)
  assert.equal(messageSchemas.I.safeParse(intent({ workflowId: 'task-data-change', stageAuthorizations: [authorization] })).success, true)
  assert.equal(messageSchemas.I.safeParse(intent({})).success, true)
  assert.equal(messageSchemas.I.safeParse(intent({ stageAuthorizations: [{ workflowId: 'task-group-file-delivery', sourceQuote: body }] })).success, true)
  assert.throws(() => validateExecutionMaterialRefs('I', intent({ stageAuthorizations: [{ ...authorization, objective: '全库清理' }] }), { text: body }), /MESSAGE_STAGE_AUTHORIZATION_INVALID/)
})

const answer = summary => ({ outcome: 'completed', summary, evidenceRefs: [], limitations: [], question: '' })
async function fixture(t, execute = async () => answer('已回答'), options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-agent-service-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [], readTools: ['read-topic-sources', 'read-predecessor-artifact', 'organize-topic-sources', 'read-task-message-resource', 'query_project_resource', 'query_readonly_database', 'query_runtime_status'] })
  const calls = [], sent = [], flights = new Set()
  const execution = { store, artifacts, controller }
  const legacy = { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: groupId => ({ groupId, responsibility: '答复项目问题', messages: [] }) }
  const coordinatorSessions = scriptedCoordinator((source,input) => actionDecision(source, options.actions ?? [{ intent: 'answer', arguments: { objective: '回答当前问题' }, dependsOn: [] }], {candidate:input.candidates.find(item=>item.topicId)}), options.beforeSubmit)
  const notifications = options.notifications ?? { canDisclose: async () => true, send: async notice => { sent.push(notice); return { messageId: `reply-${sent.length}` } }, readback: async notice => ({ messageId: notice.ack.messageId, conversationId: 'g' }) }
  const taskOwnerSessions = { async run() { throw new Error('ORDINARY_ANSWER_MUST_NOT_CREATE_TASK') }, async close() {} }
  const messageAgentSessions = { run(options) { const flight = (async () => { calls.push(options); await options.onSessionBound(); const result = await execute(options, calls.length); await options.onResult(result); return { status: 'submitted', output: result } })(); flights.add(flight); void flight.then(() => flights.delete(flight), () => flights.delete(flight)); return flight }, async cancel() {}, async close() { await Promise.all([...flights]) } }
  const open = () => openWorkflowService({ ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', webActorId: 'owner', ...options.config }, legacy, coordinatorSessions, execution, notifications, taskOwnerSessions, messageAgentSessions })
  let service
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  service = await open()
  async function settle(runId, predicate = state => state.commands.length > 0 && state.commands.every(command => command.status === 'applied')) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await service.messages.process(runId)
      const state = await service.state(runId)
      if (predicate(state)) return state
      await delay(10)
    }
    assert.fail(JSON.stringify(await service.state(runId)))
  }
  return { get service() { return service }, store, artifacts, calls, sent, settle,
    async receive(id, text = '请解释项目的当前行为', actor = 'owner') { return service.ingest({ groupId: 'g', messageId: id, text, senderOpenDingTalkId: actor }) },
    async restart() { await service.close(); service = await open() },
  }
}

test('answer objective进入消息Agent并持久产出、零Task，补读及重启不重执行或重发', async t => {
  const h = await fixture(t)
  const received = await h.receive('first')
  const state = await h.settle(received.runId)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].binding.kind, 'message-unit'); assert.equal(h.calls[0].input.request, '回答当前问题')
  assert.equal(Object.hasOwn(h.calls[0].binding, 'taskId'), false)
  assert.equal(state.commands[0].result.status, 'answered')
  assert.equal(state.executions[0].status, 'succeeded')
  assert.deepEqual(await h.service.tasks(), [])
  await h.service.flushNotifications(); assert.equal(h.sent.length, 1)
  await h.receive('first'); await h.settle(received.runId)
  await h.restart(); await h.service.recover(); await h.settle(received.runId); await h.service.flushNotifications()
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
  assert.deepEqual(await h.store.query({ kind: 'run.list' }), [])
})

test('慢查询不堵塞其他消息判断和独立Agent执行', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await fixture(t, async (_options, index) => { if (index === 1) { entered.resolve(); await release.promise } return answer(`结果${index}`) })
  const first = await h.receive('slow'); await h.service.messages.process(first.runId); await entered.promise
  const second = await h.receive('fast', '另一个项目问题')
  const next = await h.settle(second.runId)
  assert.equal(next.commands[0].result.reply, '结果2')
  assert.equal((await h.service.state(first.runId)).executions[0].status, 'running')
  release.resolve(); await h.settle(first.runId)
  assert.equal(h.calls.length, 2)
})

test('原生协调读取虚构材料被工具拒绝，纠正后提交且只执行一次', async t => {
  let rejected = 0
  const h = await fixture(t, undefined, { beforeSubmit: async args => {
    if (!args.input.sources.length) return
    const read = args.readTools.find(tool => tool.name === 'group_coordinator_read_material')
    await assert.rejects(read.execute({runId:args.input.sources[0].runId,resourceRef:'query-resource'}), error => error.code === 'GROUP_COORDINATOR_MATERIAL_FORBIDDEN')
    rejected++
  } })
  const received = await h.receive('invalid-material-ref')
  const state = await h.settle(received.runId)
  assert.equal(rejected,1);assert.equal(state.requests.length,0)
  assert.equal(state.commands.length,1);assert.equal(h.calls.length,1)
  assert.equal(state.executions[0].status,'succeeded')
})

test('异步问答完成即派发后继，不依赖再次process或恢复轮询', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await fixture(t, async (_options, index) => {
    if (index === 1) { entered.resolve(); await release.promise }
    return answer(`答复${index}`)
  }, { actions: [{ intent: 'answer', arguments: { objective: '核对第一项' }, dependsOn: [] },
    { intent: 'answer', arguments: { objective: '结合前项答复第二项' }, dependsOn: [0] }] })
  const received = await h.receive('dependency')
  await h.service.messages.process(received.runId); await entered.promise
  assert.equal(h.calls.length, 1)
  release.resolve()
  let state
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await h.service.state(received.runId)
    if (state.commands.length === 2 && state.commands.every(command => command.status === 'applied')) break
    await delay(10)
  }
  assert.equal(h.calls.length, 2)
  assert.ok(state.commands.every(command => command.status === 'applied'))
  assert.ok(h.calls[1].input.materials.some(material => material.id.startsWith('command-result:') && material.text.includes('答复1')))
})

test('同话题后续问题读取既有话题，但创建独立消息会话和发送者范围', async t => {
  const h = await fixture(t)
  const first = await h.receive('context-a', '项目口令是青竹472，请记住'); const a = await h.settle(first.runId)
  const second = await h.receive('context-b', '继续刚才的话题，口令是什么', 'participant'); const b = await h.settle(second.runId)
  assert.ok(a.units[0].topicId)
  assert.equal(a.units[0].topicId, b.units[0].topicId)
  assert.notEqual(h.calls[0].binding.sessionId, h.calls[1].binding.sessionId)
  assert.equal(h.calls[1].input.scope.actorId, 'participant')
  assert.ok(JSON.stringify(h.calls[1].input.context.topic).includes('青竹472'))
  assert.deepEqual(await h.service.tasks(), [])
})

test('需要补充创建message request，授权答复沿用会话递增输入版本', async t => {
  const h = await fixture(t, async (_options, index) => index === 1 ? { ...answer('缺少环境'), outcome: 'needs_input', question: '需要检查哪个环境？' } : answer('已核对UAT2'))
  const received = await h.receive('clarification')
  const waiting = await h.settle(received.runId, state => state.requests.some(request => request.status === 'pending'))
  const request = waiting.requests.find(item => item.status === 'pending')
  assert.deepEqual(await h.service.tasks(), [])
  await assert.rejects(h.service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'bad', answer: 'UAT2' }, { channel: 'im', actorId: 'stranger', conversationId: 'g' }))
  await h.restart()
  await h.service.resumeRequest({ runId: received.runId, requestId: request.id, eventId: 'clarified', answer: 'UAT2' }, { channel: 'im', actorId: 'owner', conversationId: 'g' })
  const completed = await h.settle(received.runId)
  assert.equal(completed.commands[0].result.reply, '已核对UAT2')
  assert.equal(h.calls[0].binding.sessionId, h.calls[1].binding.sessionId)
  assert.equal(h.calls[1].binding.inputVersion, 2)
  assert.equal(h.calls[1].input.clarificationAnswers[0].answer, 'UAT2')
})

test('调查直接由任务会话处理，独立调查及旧材料流程不再可选', async t => {
  const h = await fixture(t)
  const catalog = h.service.catalog().workflows
  const ids = catalog.map(item => item.id ?? item.workflowId)
  assert.ok(!ids.includes('task-investigation'))
  for (const id of ['task-analysis', 'task-planning', 'task-pr-review', 'task-data-query', 'task-retrospective', 'task-general', 'task-general-intake']) assert.ok(!ids.includes(id), id)
})


test('能力受阻如实结束为blocked，伪造工具证据不能成为回答', async t => {
  for (const result of [{ ...answer('缺少数据库能力'), outcome: 'blocked', limitations: ['未配置只读数据库'] }, { ...answer('声称查过数据'), evidenceRefs: ['sha256-' + 'f'.repeat(64) + '.json'] }]) {
    const h = await fixture(t, async () => result)
    const received = await h.receive('blocked')
    const state = await h.settle(received.runId)
    assert.equal(state.commands[0].result.status, 'blocked')
    assert.equal(state.requests.filter(item => item.status === 'pending').length, 0)
    assert.deepEqual(await h.service.tasks(), [])
    if (result.evidenceRefs.length) {
      assert.notEqual(state.commands[0].result.reply, result.summary)
      assert.equal(state.executions[0].status, 'failed')
    }
  }
})

test('通知发送未知后重启只补读原通知，不重复Agent执行与外发', async t => {
  let sends = 0, delivered = false
  const h = await fixture(t, undefined, { notifications: { canDisclose: async () => true,
    send: async () => { sends++; throw new Error('CONNECTION_LOST_AFTER_SEND') },
    readback: async () => delivered ? { messageId: 'actual-reply', conversationId: 'g' } : null } })
  const received = await h.receive('unknown-send'); await h.settle(received.runId); await h.service.flushNotifications()
  const before = await h.store.query({ kind: 'message.notifications', states: ['unknown'] })
  assert.equal(before.length, 1); assert.equal(sends, 1)
  await h.restart(); await h.service.recover(); await h.service.flushNotifications()
  assert.equal(sends, 1); assert.equal(h.calls.length, 1)
  delivered = true
  await h.service.flushNotifications(); await h.service.flushNotifications()
  const after = await h.store.query({ kind: 'message.notifications', states: ['delivered'] })
  assert.equal(after.length, 1); assert.equal(after[0].id, before[0].id)
  assert.equal(after[0].evidence.messageId, 'actual-reply'); assert.equal(sends, 1)
})


test('已排队旧answer.text明确拒绝，不由新Agent猜测旧合同', async t => {
  const h = await fixture(t)
  const runId = 'queued-old-answer', unitId = 'old-unit', commandId = 'old-command'
  const command = (kind, args) => h.store.command({ id: `old:${kind}`, kind: `message.${kind}`, args })
  await command('receive', { runId, sourceKey: runId, sourceVersion: 1, actorId: 'owner', conversationId: 'g', body: '原答复', policy: { initialWindowMs: 45000 } })
  await command('split', { runId, units: [{ unitId }] })
  await command('accept', { runId, unitId, commands: [{ commandId, kind: 'answer', args: { taskId: null, arguments: { text: '原正文' }, binding: { disposition: 'new' }, replyPolicy: 'none' }, dependsOn: [] }] })
  const state = await h.settle(runId, state => state.commands[0]?.status === 'rejected')
  assert.equal(state.commands[0].status, 'rejected'); assert.equal(h.calls.length, 0)
  assert.match(state.commands[0].result.reply, /请说明需要回答的具体问题/)
})


test('消息trace只返回Agent摘要、耗时和绑定会话，长产出按需分页且不允许跨消息工件', async t => {
  const body = '调查所得事实。'.repeat(2000)
  const h = await fixture(t, async ({ input }) => ({ ...answer(body), evidenceRefs: [input.source.sourceKey] }))
  const received = await h.receive('trace-artifact')
  await h.settle(received.runId)
  const trace = await h.service.messageTrace(received.runId)
  const entry = trace.items.find(item => item.kind === 'agent')
  assert.ok(entry); assert.equal(entry.status, 'succeeded'); assert.ok(entry.startedAt); assert.ok(entry.completedAt)
  assert.equal(entry.sessionId, h.calls[0].binding.sessionId); assert.equal(entry.evidenceCount, 1)
  assert.equal(entry.summary.rows.find(row => row.label === '答复摘要').value.length, 240)
  assert.ok(!JSON.stringify(trace).includes(body)); assert.ok(!Object.hasOwn(entry, 'input')); assert.ok(!Object.hasOwn(entry, 'output'))
  const first = await h.service.messageEvidence(received.runId, entry.outputRef, { limit: 2000 })
  assert.equal(first.text.length, 2000); assert.equal(first.nextCursor, 2000); assert.equal(first.evidenceRefs.length, 1)
  const second = await h.service.messageEvidence(received.runId, entry.outputRef, { offset: 2000, hash: first.hash })
  assert.equal(second.start, 2000)
  await assert.rejects(h.service.messageEvidence(received.runId, entry.outputRef, { offset: 2000, hash: 'stale' }), /VERSION_CHANGED/)
  const foreign = await h.artifacts.put({ summary: '其他消息私有结果' })
  assert.equal(await h.service.messageEvidence(received.runId, foreign.ref), null)
  assert.ok((await h.service.messageEvidence(received.runId, first.evidenceRefs[0])).text.includes('项目'))
})

test('Agent资源权限独立于发送者，各发送者使用相同职责范围', async t => {
  const h = await fixture(t, undefined, { config: { directQueries: {
    resources: [{ id: 'docs', kind: 'files', root: process.cwd(), paths: ['README.md'], description: '项目文档' },
      { id: 'outside', kind: 'files', root: process.cwd(), paths: ['AGENTS.md'], description: '未授权资料' }],
    statusResources: [{ id: 'runtime', url: 'http://127.0.0.1:19999/health', fields: ['status'], description: '运行状态' }],
    permissions: { resourceIds: ['docs'], databaseIds: [], statusIds: ['runtime'] },
  } } })
  for (const actor of ['owner', 'participant']) { const received = await h.receive(actor, '查询项目资料及运行状态', actor); await h.settle(received.runId) }
  const first = h.calls[0], second = h.calls[1]
  assert.ok(first.definition.allowedTools.includes('query_project_resource')); assert.ok(first.definition.allowedTools.includes('query_runtime_status'))
  assert.ok(second.definition.allowedTools.includes('query_project_resource')); assert.ok(second.definition.allowedTools.includes('query_runtime_status'))
  assert.equal(first.input.context.resources[0].id, 'docs'); assert.equal(first.input.context.statusResources[0].id, 'runtime')
  assert.deepEqual(first.input.context.resources[0].paths, ['README.md'])
  assert.equal(Object.hasOwn(first.input.context.resources[0], 'root'), false)
  assert.deepEqual(second.input.context.resources, first.input.context.resources); assert.deepEqual(second.input.context.statusResources, first.input.context.statusResources)
  assert.equal(first.input.scope.actorId, 'owner'); assert.equal(second.input.scope.actorId, 'participant')
  assert.deepEqual(second.input.scope.resourceIds, ['docs'])
  assert.equal(second.input.context.resources.some(resource => resource.id === 'outside'), false)
})
