import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createCoordinationSessions, createCoordinationStepGate } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
const requireGoal = createRequire(import.meta.resolve('@deepseek-ai/dsh-goal'))
const { SessionProjectionRegistry } = requireGoal('@deepseek-ai/dsh-session-projection')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('native Decision round keeps one Agent across pending same-topic revisions; next accepted round is fresh', { timeout: 10000 }, async t => {
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'decision-round' })
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'g', responsibility: 'business requests' })
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const enteredUpdate = Promise.withResolvers(), releaseUpdate = Promise.withResolvers()
  const accepted = [], handles = [], errors = [], modelInputs = []
  let coordinator, manager, topicId, blocked = false
  class Model extends LlmAdapter {
    constructor(entry) { super(); this.entry = entry; this.calls = 0 }
    async *stream(options) {
      const { request, role } = this.entry
      const revision = request.revision
      this.calls++
      modelInputs.push({ sessionId: this.entry.sessionId, role, revision, messages: options.messages })
      if (role === 'decision' && !blocked) { blocked = true; entered.resolve(); await release.promise }
      if (role === 'decision' && request.topicId === topicId && this.calls === 2) { enteredUpdate.resolve(); await releaseUpdate.promise }
      let name, args
      if (role === 'route') {
        name = 'group_topic_route_submit'
        args = { requestId: request.requestId, routes: request.messages.map(m => ({ messageId: m.messageId, messageVersion: m.messageVersion,
          topics: m.messageId === 'other' ? [{ newTopicKey: 'other', title: 'Other matter' }] : topicId ? [{ topicId }] : [{ newTopicKey: 'same', title: 'Same matter' }] })) }
      } else {
        name = 'group_decision_submit'
        args = { requestId: request.requestId, topicId: request.topicId, revision,
          decision: { actions: [], reason: 'record discussion', topicUpdate: { summary: 'Current business facts' },
            basisMessageIds: request.messages.map(m => m.messageId), basisUnitRefs: request.messages.map(({unitId,unitRevision})=>({unitId,unitRevision})) } }
      }
      const id = this.entry.sessionId + '-' + this.calls, json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  manager = createCoordinationSessions({ isCurrent: request => coordinator.isCurrentRequest(request), onError: error => errors.push(error), create: async entry => {
    ctx.llm.registerAdapter([entry.sessionId], new Model(entry))
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: entry.sessionId, agentOptions: { provider: entry.sessionId, model: 'fixture' }, setup(agentCtx) {
      agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, request => coordinator.isCurrentRequest(request)))
      coordinator.register(agentCtx, 'g', entry.request)
    } })
    handles.push({ entry, handle }); return handle
  } })
  coordinator = createTopicCoordinator({ store, getAgent: (_g, request) => request ? manager.get('g', request) : {},
    dispatchRequest: (request, message) => manager.dispatch(request, message), waitRequestIdle: request => manager.whenSettled(request),
    onRequestFinished(request) { if (request.topicId) accepted.push({ requestId: request.requestId, revision: request.revision, topicId: request.topicId }); manager.finish(request) },
    assertSession(exec, groupId, scope) { manager.assert(exec.agent, groupId, scope.requestId) },
    serializeTasks: operation => operation(), isClosing: () => false, retryDelayMs: 1000,
    reviewCandidates: () => [], validateReplyReview: review => review,
    appendOutbox: outbound => store.appendOutbox(outbound), cancelTask() {}, applyAction() { throw new Error('unexpected action') },
    onError(_groupId, error) { errors.push(error) },
  })
  t.after(async () => { release.resolve(); releaseUpdate.resolve(); await coordinator.close(); await manager.close(); await store.close(); await ctx.fiber.dispose() })
  const ingest = id => store.ingest({ groupId: 'g', messageId: id, text: 'Business fact ' + id, senderOpenDingTalkId: 'actor', occurredAt: '2026-11-01T00:00:00Z' })
  const until = async predicate => { for (let i=0;i<1000;i++) { if(predicate()) return; await tick() } throw new Error('condition timeout') }
  await ingest('first'); await coordinator.schedule('g'); await entered.promise
  topicId = store.listTopics('g')[0].topicId
  const original = handles.find(h => h.entry.role === 'decision')
  const firstId = original.handle.agent.session.id
  await ingest('second'); await ingest('third'); await ingest('third'); await ingest('other')
  await coordinator.schedule('g'); release.resolve()
  await enteredUpdate.promise
  await ingest('additional'); await coordinator.schedule('g'); releaseUpdate.resolve()
  await until(() => accepted.some(a => a.topicId === topicId && a.revision === 4))
  await coordinator.drain('g')
  assert.equal(handles.filter(h => h.entry.role === 'decision' && h.entry.request.topicId === topicId).length, 1)
  const events = original.handle.agent.session.snapshotEvents()
  const inputs = events.filter(e=>e.type==='user/message' && e.data.id?.startsWith('message-coord-decision-'))
  assert.equal(inputs.length, 3)
  assert.match(inputs[1].data.id, /revision-3$/)
  assert.match(inputs[2].data.id, /revision-4$/)
  const body = inputs[1].data.content[0].text
  assert.ok(body.includes('Business fact second') && body.includes('Business fact third'))
  assert.equal(body.includes('Business fact other'), false)
  const results = events.filter(e=>e.type==='tool/result').map(e=>JSON.parse(e.data.message.content[0].text))
  assert.ok(results.some(r=>r.status==='routing-required'))
  assert.equal(store.getTopic('g',topicId).decisions.length,1)
  await ingest('fourth'); await coordinator.schedule('g')
  await until(()=>accepted.filter(a=>a.topicId===topicId).length===2)
  const rounds = handles.filter(h=>h.entry.role==='decision' && h.entry.request.topicId===topicId)
  assert.equal(rounds.length,2)
  assert.notEqual(rounds[1].handle.agent.session.id, firstId)
  assert.equal(store.listTasks().length,0)
  assert.deepEqual(errors,[])
  t.diagnostic(JSON.stringify({firstSession:firstId,nextSession:rounds[1].handle.agent.session.id,firstRoundRevision:4,sourceMessages:inputs.length}))
})
