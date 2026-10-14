import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
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

test('Agent signature config saves, clears and reloads without profile fallback or cross-Agent values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } }
  const { facility, seed } = memoryFacility()
  let runtime = await openTaskResidentRuntime(ctx, await openResidentStore(facility), root)
  assert.equal(runtime.getAgentConfig().replySignature, '')
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message }))
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await runtime.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const put = async body => {
    const response = await fetch(base + '/config/agent', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  for (const [name, signature] of [['资料助理', '资料助理代回'], ['Ada', 'Ada Support']]) {
    const response = await put({ agentNames: [name], replySignature: signature })
    assert.equal(response.status, 200)
    assert.equal(response.body.replySignature, signature)
    assert.deepEqual(response.body.agentNames, [name])
    const stored = residentDomainSpec.tables.scheduler.valueSchema.parse(seed.get('scheduler:runtime'))
    assert.equal(stored.replySignature, signature)
    await runtime.close()
    runtime = await openTaskResidentRuntime(ctx, await openResidentStore(memoryFacility(seed).facility), root, { agentReplySignature: 'Profile fallback' })
    assert.equal((await (await fetch(base + '/state/agent-config')).json()).replySignature, signature)
  }
  const invalid = await put({ agentNames: ['Must not save'], replySignature: 'Ada\nMira' })
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.error, /SIGNATURE_INVALID/u)
  assert.deepEqual(runtime.getAgentConfig().agentNames, ['Ada'])
  assert.equal(runtime.getAgentConfig().replySignature, 'Ada Support')
  assert.equal((await put({ replySignature: '' })).status, 200)
  await runtime.close()
  runtime = await openTaskResidentRuntime(ctx, await openResidentStore(memoryFacility(seed).facility), root, { agentReplySignature: 'Profile fallback' })
  assert.equal(runtime.getAgentConfig().replySignature, '', 'explicit clear must survive restart, not re-enable the profile default')
  const other = await openTaskResidentRuntime(ctx, await openResidentStore(memoryFacility().facility), root, { agentReplySignature: 'Mira Support' })
  assert.equal(other.getAgentConfig().replySignature, 'Mira Support')
  assert.equal(runtime.getAgentConfig().replySignature, '')
  await other.close()
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
async function serviceFixture(t, replySignature, action = 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'reply-service-'))
  const config = { agentNames: ['测试助手'], replySignature }
  const reviewed = new Set()
  let host, modelFailure
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, async (request, h) => {
    try {
      const lastTool = h.toolResults.at(-1)
      if (['group_topic_route_submit', 'group_decision_submit'].includes(lastTool?.name)) {
        assert.equal(lastTool.result.value?.status, 'accepted', JSON.stringify(lastTool.result))
      }
      assert.ok(h.requests.length <= 40, 'Native reply identity script must not loop on rejected decisions')
      const names = request.tools.map(tool => tool.name)
      const input = latestInput(request)
      if (names.includes('group_topic_route_submit')) {
        const calls = topicTaskCalls(request, { title: '核对材料' })
        const existing = h.residentStore.listTopics('native-group')[0]
        if (existing) for (const route of calls[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId: existing.topicId }]
        return calls
      }
      if (names.includes('group_decision_submit')) {
        if (!input.messages.some(message => message.text.includes('状态'))) return topicTaskCalls(request, { title: '核对材料' })
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
            actions: [], reply: task.completion.summary,
            replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(candidate => candidate.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
      }
      assert.ok(names.includes('task_session_submit'), 'Completion and questions must use the real native task owner')
      return [{ name: 'task_session_submit', args: { decision: { action, summary: '核验完成。\n\n• 小小鹏代回', evidence: ['材料已核对。'], limitations: [],
        ...(action === 'wait' ? { question: '请提供目标日期。\n\n- 小小鹏代回' } : {}) } } }]
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

test('real service completion and later status use only the current explicit signature and retain quote/mention', nativeOptions, async t => {
  const f = await serviceFixture(t, '资料助理代回')
  await f.ingest('original', '核对材料')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].payload.replyToMessageId, 'original')
  assert.equal(f.sent[0].payload.replyToSenderOpenDingTalkId, 'owner')
  assert.deepEqual(f.sent[0].payload.atOpenDingTalkIds, ['owner'])
  assert.equal(f.sent[0].payload.text, '核验完成。\n\n- 材料已核对。\n\n- 资料助理代回')
  for (const [messageId, signature] of [['renamed', 'Ada Support'], ['cleared', ''], ['unset', undefined]]) {
    f.config.replySignature = signature
    await f.ingest(messageId, '状态')
    const payload = f.sent.at(-1).payload
    assert.equal(payload.text, `核验完成。${signature ? `\n\n- ${signature}` : ''}`)
    assert.equal(payload.replyToMessageId, messageId)
    assert.equal(payload.replyToSenderOpenDingTalkId, 'owner')
    assert.deepEqual(payload.atOpenDingTalkIds, ['owner'])
    assert.doesNotMatch(payload.text, /小小鹏|旧职责助理/u)
  }
  const persisted = await f.service.store.query({ kind: 'notification.list' })
  assert.equal(persisted.filter(row => row.payload.kind !== 'topic-reply' || row.payload.replyKind === 'substantive').length, 4)
  assert.equal(persisted.find(row => row.payload.kind === 'task-completed').payload.text, f.sent[0].payload.text, 'already prepared delivery remains immutable')
})

test('questions and separate service instances do not borrow another Agent signature', nativeOptions, async t => {
  for (const signature of ['Mira Support', undefined]) {
    await t.test(signature ?? 'unconfigured', async t => {
      const f = await serviceFixture(t, signature, 'wait')
      await f.ingest('question-source', '请核对日期')
      assert.equal(f.sent.length, 1)
      const payload = f.sent[0].payload
      assert.equal(payload.text, `请提供目标日期。${signature ? `\n\n- ${signature}` : ''}`)
      assert.equal(payload.replyToMessageId, 'question-source')
      assert.equal(payload.replyToSenderOpenDingTalkId, 'owner')
      assert.deepEqual(payload.atOpenDingTalkIds, ['owner'])
      assert.doesNotMatch(payload.text, /小小鹏|资料助理|Ada|旧职责助理/u)
    })
  }
})
