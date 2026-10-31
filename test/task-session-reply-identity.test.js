import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, modelToolValues } from './fixtures/task-session-native-host.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

function memoryFacility(seed = new Map()) {
  const table = name => ({
    get: key => seed.get(`${name}:${key}`),
    entries: () => [...seed.entries()].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value])[Symbol.iterator](),
    async put(key, value) { seed.set(`${name}:${key}`, value) },
    async delete(key) { seed.delete(`${name}:${key}`) },
    async update(key, transform) { const k = `${name}:${key}`, value = transform(seed.get(k)); seed.set(k, value); return value },
  })
  return { seed, facility: { async open() { return { table, close: async () => {} } } } }
}

test('Agent署名配置恢复读写、校验与持久化', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } }
  const { facility, seed } = memoryFacility(new Map([['scheduler:runtime', { tasks: [], replySignature: '旧署名' }]]))
  const store = await openResidentStore(facility)
  const runtime = await openTaskResidentRuntime(ctx, store, root, { agentReplySignature: 'Profile署名' })
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message }))
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await (await fetch(base + '/state/agent-config')).json()).replySignature, '旧署名')
  const saved = await fetch(base + '/config/agent', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replySignature: 'HTTP Agent' }) })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).replySignature, 'HTTP Agent')
  await runtime.updateAgentConfig({ replySignature: '旧署名' })
  assert.equal(runtime.getAgentConfig().replySignature, '旧署名')
  await assert.rejects(runtime.updateAgentConfig({ agentNames: ['不得保存'], replySignature: '- invalid' }), /GROUP_REPLY_SIGNATURE_INVALID/)
  assert.deepEqual(runtime.getAgentConfig().agentNames, [])
  await runtime.updateAgentConfig({ replySignature: ' Ada Support ' })
  await runtime.updateAgentConfig({ agentNames: ['助理'] })
  assert.equal(runtime.getAgentConfig().replySignature, 'Ada Support')
  assert.equal(residentDomainSpec.tables.scheduler.valueSchema.parse(seed.get('scheduler:runtime')).replySignature, 'Ada Support')
  await runtime.close()
  const reopened = await openTaskResidentRuntime(ctx, await openResidentStore(facility), root)
  assert.equal(reopened.getAgentConfig().replySignature, 'Ada Support')
  await reopened.updateAgentConfig({ replySignature: '' })
  assert.equal(reopened.getAgentConfig().replySignature, '')
  await reopened.close()
  const empty = await openTaskResidentRuntime(ctx, await openResidentStore(facility), root, { agentReplySignature: 'Must not override empty' })
  assert.equal(empty.getAgentConfig().replySignature, '')
  await empty.close()
  const fresh = memoryFacility()
  const initialized = await openTaskResidentRuntime(ctx, await openResidentStore(fresh.facility), root, { agentReplySignature: ' Profile Agent ' })
  assert.equal(initialized.getAgentConfig().replySignature, 'Profile Agent')
  assert.equal(fresh.seed.get('scheduler:runtime').replySignature, 'Profile Agent')
  await initialized.close()
})

function jsonValues(value) {
  if (!value || typeof value !== 'object') return []
  const values = [value]
  for (const child of Object.values(value)) {
    if (typeof child === 'string') { try { values.push(...jsonValues(JSON.parse(child))) } catch {} }
    else if (typeof child === 'object') values.push(...jsonValues(child))
  }
  return values
}

const nativeOptions = { timeout: 30000, ...(!available ? { skip: reason } : {}) }
async function assertFinalReplySource(host, notification, messageId, actorId) {
  assert.equal(notification.payload.replyToMessageId, undefined, 'Final results use ordinary Markdown, not an implicit quote mention')
  assert.equal(notification.payload.replyToSenderOpenDingTalkId, undefined)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, [actorId])
  const fact = await host.query('topic.fact.get', { factId: notification.payload.coveredEventIds[0] })
  assert.equal(fact.decision.decision.replyToMessageId, messageId, 'The selected context remains in the durable decision')
  const sources = await Promise.all(fact.sourceIds.map(sourceId => host.query('source.get', { sourceId })))
  assert.ok(sources.some(source => source.messageId === messageId && source.actorId === actorId && source.groupId === notification.payload.conversationId))
}
async function serviceFixture(t, replySignature, action = 'complete', legacyFooter = false) {
  const root = await mkdtemp(join(tmpdir(), 'reply-service-'))
  const config = { agentNames: ['测试助手'], replySignature }
  const reviewed = new Set()
  let host, modelFailure
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, async (request, h) => {
    try {
      assert.ok(h.requests.length <= 40, 'Native reply identity script must not loop on rejected decisions')
      const names = request.tools.map(tool => tool.name)
      const input = latestInput(request)
      if (modelToolValues(request).some(value => ['accepted', 'request-unavailable'].includes(value.status))) return []
      if (names.includes('group_topic_route_submit')) {
        const calls = topicTaskCalls(request, { title: '核对材料' })
        const existing = h.residentStore.listTopics('native-group')[0]
        if (existing) for (const route of calls[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId: existing.topicId }]
        return calls
      }
      if (names.includes('group_decision_submit')) {
        if (input.trigger === 'task-facts') {
          const calls = topicTaskCalls(request)
          calls[0].args.decision.reply = input.facts.map(fact => fact.question || [fact.summary, ...fact.evidence.map(text => `- ${text}`), ...fact.limitations].join('\n\n')).join('\n\n')
          return calls
        }
        if (!input.messages.some(message => message.text.includes('状态'))) {
          const calls = topicTaskCalls(request, { title: '核对材料' })
          calls[0].args.decision.topicUpdate = { summary: '核对材料，等待真实任务结果。' }
          return calls
        }
        if (!reviewed.has(input.requestId)) {
          reviewed.add(input.requestId)
          return [{ name: 'group_reply_review_get', args: { requestIds: [input.requestId] } }]
        }
        const review = jsonValues(h.toolResults.findLast(result => result.name === 'group_reply_review_get')?.result).find(value => Array.isArray(value.candidates))
        assert.ok(review, 'Status reply must review the real Topic outbox')
        const task = h.residentStore.listTasks()[0]
        assert.equal(task.status, 'completed', 'Status must describe the completed real task')
        const current = input.messages.at(-1)
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: [current.messageId], basisUnitRefs: [{ unitId: current.unitId, unitRevision: current.unitRevision }],
            actions: [], reply: task.completion.summary, replyToMessageId: current.messageId, topicUpdate: { summary: '材料核对任务已完成。' },
            replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(candidate => candidate.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
      }
      assert.ok(names.includes('task_session_submit'), 'Completion and questions must use the real native task owner')
      assert.match(JSON.stringify(request.messages.filter(message => message.role === 'system')), /完成、阻塞和重要阶段进展只提交事实/u)
      assert.doesNotMatch(JSON.stringify(request.messages.filter(message => message.role === 'system')), /显式全局署名由Host统一附加/u)
      return [{ name: 'task_session_submit', args: { decision: { action, summary: legacyFooter ? `核验完成。\n\n- ${replySignature}\n\n• ${replySignature}` : '核验完成。', evidence: ['材料已核对。'], limitations: legacyFooter ? [`未部署。\n\n- ${replySignature}`] : [],
        ...(action === 'wait' ? { question: '请提供目标日期。', audience: 'requester' } : {}) } } }]
    } catch (error) { modelFailure = error; return [] }
  }, { agentConfig: config })
  await host.residentStore.setAgentNames(config.agentNames)
  await host.residentStore.subscribe({ groupId: 'native-group', name: '真实署名测试群', responsibility: '日常代答末尾附 - 旧职责助理代回' })
  const ingest = async (messageId, text) => {
    await host.service.ingest({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'owner', senderName: '真实发起人',
      text: `@测试助手 ${text}`, occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' })
    let timer
    try {
      await Promise.race([
        host.service.whenIdle(),
        new Promise((_, reject) => {
          const check = () => {
            if (modelFailure) reject(modelFailure)
            else timer = setTimeout(check, 10)
          }
          check()
        }),
      ])
      if (modelFailure) throw modelFailure
    } finally { clearTimeout(timer) }
  }
  return { service: host.service, config, host, get sent() { return host.sent.filter(notification => notification.payload.kind !== 'topic-reply' || notification.payload.replyKind === 'substantive') }, ingest }
}

test('完成及状态末尾统一署名，保留来源和真实@且最终结果不隐式引用', { ...(nativeOptions), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const f = await serviceFixture(t, '资料助理代回')
  await t.beginBusiness()

  await t.step(async () => f.ingest('original', '核对材料'))
  assert.equal(f.sent.length, 1)
  await t.step(async () => assertFinalReplySource(f.host, f.sent[0], 'original', 'owner'))
  assert.equal(f.sent[0].payload.text, '核验完成。\n\n- 材料已核对。\n\n- 资料助理代回')
  assert.ok(f.host.sent.filter(row => row.payload.replyKind === 'confirmation').every(row => !row.payload.text.includes('资料助理代回')))
  for (const [messageId, signature] of [['renamed', 'Ada Support'], ['cleared', ''], ['unset', undefined]]) {
    f.config.replySignature = signature
    await t.step(async () => f.ingest(messageId, '状态'))
    const payload = f.sent.at(-1).payload
    assert.equal(payload.text, `核验完成。${signature ? `\n\n- ${signature}` : ''}`)
    assert.equal(payload.replyToMessageId, messageId)
    assert.equal(payload.replyToSenderOpenDingTalkId, 'owner')
    assert.deepEqual(payload.atOpenDingTalkIds, ['owner'])
    assert.doesNotMatch(payload.text, /旧职责助理/u)
  }
  const persisted = await t.step(async () => f.service.store.query({ kind: 'notification.list' }))
  assert.equal(persisted.filter(row => row.payload.kind !== 'topic-reply' || row.payload.replyKind === 'substantive').length, 4)
  assert.equal(persisted.find(row => row.payload.coveredEventIds?.length).payload.text, f.sent[0].payload.text, 'already prepared delivery remains immutable')
}))

test('任务提问使用显式Agent署名', { ...(nativeOptions), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  await t.beginBusiness()
  for (const signature of ['Mira Support', undefined]) {
    await t.step(async () => t.test(signature ?? 'unconfigured', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
      const f = await serviceFixture(t, signature, 'wait')
      await t.beginBusiness()

      await t.step(async () => f.ingest('question-source', '请核对日期'))
      assert.equal(f.sent.length, 1)
      const payload = f.sent[0].payload
      assert.equal(payload.text, `请提供目标日期。${signature ? `\n\n- ${signature}` : ''}`)
      await t.step(async () => assertFinalReplySource(f.host, f.sent[0], 'question-source', 'owner'))
      assert.doesNotMatch(payload.text, /资料助理|Ada|旧职责助理/u)
      f.config.replySignature = 'Changed Agent'
      await t.step(async () => f.service.recover())
      await t.step(async () => f.service.whenIdle())
      const persisted = await t.step(async () => f.service.store.query({ kind: 'notification.list' }))
      assert.equal(persisted.find(row => row.payload.coveredEventIds?.length).payload.text, payload.text)
      assert.equal(f.sent.length, 1, 'Recovery must not send the question again')
    })))
  }
}))

test('真实完成出口将模型重复署名移到证据和限制后', { ...(nativeOptions), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const f = await serviceFixture(t, 'Configured Agent', 'complete', true)
  await t.beginBusiness()

  await t.step(async () => f.ingest('legacy-footer', '核对材料'))
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].payload.text, '核验完成。\n\n- 材料已核对。\n\n未部署。\n\n- Configured Agent')
}))

for (const dialogueCase of [false, true]) test(`${dialogueCase ? 'Web对话' : 'Topic完成回复'}在公开入账前拒绝来源消息和人员标识，原轮订正保留业务编号与链接`, { ...(nativeOptions), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reply-public-identity-'))
  const messageId = 'opaque-native-message-184', actorId = 'opaque-open-dingtalk-875'
  const businessText = '已核对 PR #253 与订单 SG18：https://example.com/orders/SG18'
  let host, modelFailure, steps = 0
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async (request, h) => {
    try {
      assert.ok(h.requests.length <= 30, 'Rejected public text must be corrected in the original native turn')
      const incoming = latestInput(request), routed = topicTaskCalls(request)
      if (incoming.trigger === 'task-facts') {
        assert.equal((await h.query('task.get', { taskId: incoming.facts[0].taskId })).status, 'completed', '事实已完成，回复校验不能阻塞任务')
        assert.equal((await h.query('notification.list')).filter(item => item.payload.coveredEventIds?.length).length, 0)
        const step = ++steps
        routed[0].args.decision.reply = step === 1 ? `已核对来源 ${messageId}` : step === 2 ? `已通知人员 ${actorId}` : `${businessText}\n\n- 结果已核对`
        return routed
      }
      if (routed) return routed
      const input = latestInput(request), current = await h.query('task.get', { taskId: input.task.taskId })
      const source = input.sources.find(item => item.messageId === messageId)
      assert.equal(source.actorId, actorId)
      if (!dialogueCase) return [{ name: 'task_session_submit', args: { decision: {
        action: 'complete', summary: `内部核查来源 ${source.messageId}`, evidence: [`内部人员 ${source.actorId}`], limitations: [],
      } } }]
      if (dialogueCase && !input.dialogue) return [{ name: 'task_session_submit', args: { decision: {
        action: 'wait', summary: `等待内部核查来源 ${source.messageId}`, evidence: [], limitations: [],
      } } }]
      const step = ++steps
      if (input.dialogue) {
        assert.equal(current.status, 'active')
        assert.equal(current.dialogue.find(item => item.id === input.dialogue.id).reply, null, 'Rejected dialogue must not be displayed')
      } else {
        assert.notEqual(current.status, 'completed', 'Rejected completion must not finish the task')
        assert.equal((await h.query('notification.list')).filter(item => item.payload.kind === 'task-completed').length, 0)
      }
      return [{ name: 'task_session_submit', args: { decision: {
        action: input.dialogue ? 'wait' : 'complete',
        summary: step === 1 ? `已核对来源 ${source.messageId}` : step === 2 ? `已通知人员 ${source.actorId}` : businessText,
        evidence: input.dialogue ? [`内部核查来源 ${source.messageId}`] : ['结果已核对'], limitations: [],
      } } }]
    } catch (error) { modelFailure = error; return [] }
  }))
  await t.step(async () => host.service.ingest({ groupId: 'native-group', messageId, senderOpenDingTalkId: actorId,
    senderName: '真实发起人', text: '@测试助手 核对订单 SG18', occurredAt: '2026-10-23T08:00:00Z' }))
  await t.step(async () => host.service.whenIdle())
  if (modelFailure) throw modelFailure
  const [task] = await t.step(async () => host.query('task.list'))
  if (dialogueCase) {
    assert.match(task.lastDecision.summary, new RegExp(messageId), 'Internal wait diagnostics retain source identity')
    await t.step(async () => host.service.sendTaskDialogue({ taskId: task.taskId, requestId: 'public-dialogue', text: '核查结果是什么？' }))
    await t.step(async () => host.service.whenIdle())
    if (modelFailure) throw modelFailure
    const dialogue = await t.step(async () => host.service.taskDialogue(task.taskId))
    assert.equal(dialogue.messages.length, 1)
    assert.equal(dialogue.messages[0].reply, businessText)
    assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).status, 'active')
    assert.equal(host.sent.filter(item => item.payload.kind === 'task-completed').length, 0)
  } else {
    assert.equal(task.status, 'completed')
    const notices = host.sent.filter(item => item.payload.coveredEventIds?.length)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].payload.text, `${businessText}\n\n- 结果已核对`)
    await t.step(async () => assertFinalReplySource(host, notices[0], messageId, actorId))
  }
  assert.equal(steps, 3)
  assert.equal(host.toolResults.filter(item => item.name === (dialogueCase ? 'task_session_submit' : 'group_decision_submit') && JSON.stringify(item.result).includes('GROUP_REPLY_INTERNAL_DETAILS')).length, 2)
}))
