import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'
import { prepareMessageContext, splitContext, intentContext, candidateCards } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { createMessageModel, prepareMessageRequest } from '../packages/dingtalk-dsh-assistant/message-model.js'
import { messageSystem } from '../packages/dingtalk-dsh-assistant/message-model.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'message-workflow-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: 'test', initialize: true })
  const workflow = createMessageWorkflow({ store, ...options })
  t.after(async () => { await workflow.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, workflow }
}
const source = { sourceKey: 'channel:account:group:m1', sourceVersion: 1, conversationId: 'group', actorId: 'user', body: '查A；查B' }
const split = { kind: 'split', units: [{ spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [] }, { spans: [{ start: 3, end: 5 }], goalText: '查B', constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: 5, role: 'unit' }], sharedConstraints: [] }
const binding = { kind: 'binding', disposition: 'conversation', candidateId: null, evidence: ['source'] }
const intent = { kind: 'intent', actions: [{ intent: 'status', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }

test('短指代保留原文进入 R，不在 S 扩写旧话题', async t => {
  let routed
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => {
    if (stage === 'S') throw new Error('short reference should use fixed split')
    if (stage === 'R') { routed = input; return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['待核对'] } }
    return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  } })
  await workflow.receive({ ...source, runId: 'short-reference', sourceKey: 'short-reference', body: '这不是让你去查吗' })
  await workflow.process('short-reference')
  assert.equal(routed?.goalText, '这不是让你去查吗')
})
test('短指代由 R 核对最近消息和候选后关联话题', async t => {
  const first = { ...source, runId: 'account-first', sourceKey: 'account-first', body: '查账号创建时间' }
  let relationInput
  const { workflow } = await fixture(t, { context: { history: async run => run.runId === 'account-followup' ? [{ sourceKey: first.sourceKey, sourceVersion: 1, actorId: first.actorId, text: first.body }] : [], splitBackground: async ({ history }) => ({ messages: history }), candidates: async ({ run }) => run.runId === 'account-followup'
    ? [{ candidateId: 'account-topic', topicId: 'account-topic', title: first.body, goal: first.body, state: 'topic', relevantTime: new Date().toISOString(), sourceRefs: [first.sourceKey], explicitReferenceMatches: [] }] : [] },
  judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] }
    if (stage === 'R') {
      if (input.sourceKey === 'account-followup') { relationInput = input; return { kind: 'binding', disposition: 'existing', candidateId: 'account-topic', evidence: ['account-first 原文指向账号创建时间'] } }
      return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['首条'] }
    }
    return { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  } })
  await workflow.receive(first)
  await workflow.process(first.runId)
  await workflow.receive({ ...source, runId: 'account-followup', sourceKey: 'account-followup', body: '这不是让你去查吗' })
  const result = await workflow.process('account-followup')
  assert.equal(result.nodes.find(node => node.nodeId === 'R').output.output.candidateId, 'account-topic')
  assert.equal(relationInput.candidates[0].recentSourceMatch, true)
  assert.equal(relationInput.recentMessages.at(-1).text, first.body)
  assert.equal(JSON.stringify(result).includes('verifiedRecentSourceKey'), false)
})

test('同人相邻消息仅排序候选，R 可保留跨话题歧义', async t => {
  const first = { ...source, runId: 'topic-one', sourceKey: 'topic-one', body: '排查账号问题' }
  const second = { ...source, runId: 'topic-two', sourceKey: 'topic-two', body: '设计发布方案' }
  let relationInput
  const { workflow } = await fixture(t, { context: {
    history: async run => run.runId === 'ambiguous' ? [first, second].map(item => ({ sourceKey: item.sourceKey, sourceVersion: 1, actorId: item.actorId, text: item.body })) : [],
    splitBackground: async ({ history }) => ({ messages: history }),
    candidates: async ({ run }) => run.runId === 'ambiguous' ? [first, second].map(item => ({ candidateId: item.runId, topicId: item.runId, goal: item.body, state: 'topic', sourceRefs: [item.sourceKey], explicitReferenceMatches: [] })) : [],
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] }
    if (stage === 'R') { relationInput = input; return { kind: 'binding', disposition: 'unresolved', candidateId: null, evidence: ['两个话题均可能是指代目标'] } }
    throw new Error(`unexpected stage ${stage}`)
  } })
  await workflow.receive(first)
  await workflow.receive(second)
  await workflow.receive({ ...source, runId: 'ambiguous', sourceKey: 'ambiguous', body: '继续处理这个' })
  const result = await workflow.process('ambiguous')
  assert.equal(relationInput.candidates[0].candidateId, 'topic-two')
  assert.equal(relationInput.candidates[0].recentSourceMatch, true)
  assert.equal(result.units[0].routingBinding, undefined)
  assert.equal(result.requests.some(request => request.nodeId === 'R' && request.status === 'pending'), true)
})

test('三条同话题先全部关联，再一次 IB 只创建一个业务任务', async t => {
  let releaseLast, lastStarted
  const gate = new Promise(resolve => { releaseLast = resolve })
  const started = new Promise(resolve => { lastStarted = resolve })
  const calls = [], created = []
  const { workflow, store } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: 'topic-three', conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: '一项任务', facts: [] }), facts: async () => ({}),
      validateAction: async () => ({ allowed: true }) },
    judge: async ({ stage, input }) => {
      calls.push(stage)
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') { if (input.sourceKey === 'three') { lastStarted(); await gate }; return binding }
      if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map((item, index) => ({ unitId: item.unitId,
        intent: { kind: 'intent', actions: [index === 0
          ? { intent: 'create', arguments: { objective: '合并办理', workflowId: 'task-analysis' }, dependsOn: [] }
          : { intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } })) }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { create: async (_, info) => { created.push(info.run.sourceKey); return { taskId: 'one-task' } } },
  })
  const items = await Promise.all(['one', 'two', 'three'].map(sourceKey => workflow.receive({ sourceKey, sourceVersion: 1,
    conversationId: 'group', actorId: 'alice', body: sourceKey }, { process: false })))
  const flights = items.map(item => workflow.process(item.runId))
  await started
  assert.equal(calls.filter(stage => stage === 'IB').length, 0)
  releaseLast(); await Promise.all(flights)
  for (let attempt = 0; attempt < 100 && created.length < 1; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(created, ['one'])
  assert.equal(calls.filter(stage => stage === 'IB').length, 1)
  const traces = await Promise.all(items.map(item => store.query({ kind: 'message.intent.runs', runId: item.runId })))
  assert.ok(traces.every(trace => trace.length === 1))
  assert.equal(new Set(traces.map(trace => trace[0].nodeRunId)).size, 1)
  assert.equal(traces[0][0].input.sourceManifest.length, 3)
})

test('同群待关联消息阻止意图判断；归类完成后同话题只判断一次且各来源独立派发', async t => {
  let releaseSecond, secondStarted
  const blocked = new Promise(resolve => { releaseSecond = resolve })
  const started = new Promise(resolve => { secondStarted = resolve })
  const calls = [], sent = []
  const { workflow, store } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: 'topic-a', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.id ?? unit.unitId, title: '查询', facts: [] }), facts: async () => ({}) },
    judge: async ({ stage, input }) => {
      calls.push(stage)
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') { if (input.sourceKey === 'm2') { secondStarted(); await blocked }; return binding }
      if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async (_, info) => { sent.push(info.run.sourceKey); return { ok: true } } },
  })
  const one = await workflow.receive({ sourceKey: 'm1', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  const two = await workflow.receive({ sourceKey: 'm2', sourceVersion: 1, conversationId: 'group', actorId: 'bob', body: '查B' }, { process: false })
  const firstFlight = workflow.process(one.runId), secondFlight = workflow.process(two.runId)
  await started
  assert.equal(calls.filter(stage => stage === 'IB').length, 0)
  assert.ok((await store.query({ kind: 'message.routing.pending', conversationId: 'group' })).length >= 1)
  releaseSecond(); await Promise.all([firstFlight, secondFlight])
  for (let attempt = 0; attempt < 100 && sent.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sent.length, 2, JSON.stringify({ calls, one: await workflow.state(one.runId), two: await workflow.state(two.runId), topic: await store.query({ kind: 'message.topic', topicId: 'topic-a' }) }))
  assert.deepEqual(sent.sort(), ['m1', 'm2'])
  assert.equal(calls.filter(stage => stage === 'IB').length, 1)
  assert.equal((await store.query({ kind: 'message.topic', topicId: 'topic-a' })).processedRevision, 2)
})

test('意图判断途中同话题新消息使旧结果失效并集合重判', async t => {
  let releaseFirst, firstStarted
  const held = new Promise(resolve => { releaseFirst = resolve })
  const started = new Promise(resolve => { firstStarted = resolve })
  const batches = [], sent = [], stages = []
  const { workflow } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: 'topic-shared', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.id ?? unit.unitId, title: '查询', facts: [] }), facts: async () => ({}) },
    judge: async ({ stage, input }) => {
      stages.push(stage)
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') return binding
      if (stage === 'IB') { batches.push(input.units.map(item => item.unitId)); if (batches.length === 1) { firstStarted(); await held }; return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) } }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async (_, info) => { sent.push(info.run.sourceKey); return { ok: true } } },
  })
  const one = await workflow.receive({ sourceKey: 'one', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  await workflow.process(one.runId); await started
  const two = await workflow.receive({ sourceKey: 'two', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查B' }, { process: false })
  await workflow.process(two.runId)
  releaseFirst()
  for (let attempt = 0; attempt < 100 && sent.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(batches.length, 2)
  assert.deepEqual(batches.map(batch => batch.length), [1, 2])
  assert.deepEqual(sent.sort(), ['one', 'two'])
  assert.equal(stages.filter(stage => stage === 'S').length, 2)
  assert.equal(stages.filter(stage => stage === 'R').length, 2)
})

test('不同话题使用独立 IB 判断且可并行', async t => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const started = new Set()
  const { workflow } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.sourceKey}`, conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId, title: run.body, facts: [] }), facts: async () => ({}) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') return binding
      if (stage === 'IB') { started.add(input.topicId); await held; return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) } }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async () => ({ ok: true }) },
  })
  const one = await workflow.receive({ sourceKey: 'a', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  const two = await workflow.receive({ sourceKey: 'b', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查B' }, { process: false })
  await Promise.all([workflow.process(one.runId), workflow.process(two.runId)])
  for (let attempt = 0; attempt < 100 && started.size < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual([...started].sort(), ['topic-a', 'topic-b'])
  release()
})

test('I 期间收到另一话题消息，待其归类后复用原话题已完成判断', async t => {
  let releaseIntent, releaseRouting, intentStarted, routingStarted
  const intentGate = new Promise(resolve => { releaseIntent = resolve })
  const routingGate = new Promise(resolve => { releaseRouting = resolve })
  const sawIntent = new Promise(resolve => { intentStarted = resolve })
  const sawRouting = new Promise(resolve => { routingStarted = resolve })
  const intentCalls = [], sent = []
  const { workflow } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.sourceKey}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: run.body, facts: [] }), facts: async () => ({}) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') { if (input.sourceKey === 'b') { routingStarted(); await routingGate }; return binding }
      if (stage === 'IB') { intentCalls.push(input.topicId); if (input.topicId === 'topic-a') { intentStarted(); await intentGate }; return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) } }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async (_, info) => { sent.push(info.run.sourceKey); return { ok: true } } },
  })
  const one = await workflow.receive({ sourceKey: 'a', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  await workflow.process(one.runId); await sawIntent
  const two = await workflow.receive({ sourceKey: 'b', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查B' }, { process: false })
  const second = workflow.process(two.runId)
  await sawRouting
  releaseIntent()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(sent, [])
  releaseRouting(); await second
  for (let attempt = 0; attempt < 100 && sent.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(sent.sort(), ['a', 'b'])
  assert.equal(intentCalls.filter(topic => topic === 'topic-a').length, 1)
})

test('R 已持久归属但等待另一消息时重建运行器，恢复后只派发一次', async t => {
  const sent = []
  const makeOptions = () => ({
    context: { bindTopic: async ({ run, unit }) => ({ topicId: 'topic-recovery', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId, title: '查询', facts: [] }), facts: async () => ({}) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') return binding
      if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async (_, info) => { sent.push(info.run.sourceKey); return { ok: true } } },
  })
  const { workflow, store } = await fixture(t, makeOptions())
  const one = await workflow.receive({ sourceKey: 'recover-one', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  const two = await workflow.receive({ sourceKey: 'recover-two', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查B' }, { process: false })
  await workflow.process(one.runId)
  assert.equal((await workflow.state(one.runId)).run.routingStatus, 'routing_complete')
  assert.deepEqual(sent, [])
  await workflow.close()
  const restarted = createMessageWorkflow({ store, ...makeOptions() })
  t.after(() => restarted.close())
  await restarted.recover()
  for (let attempt = 0; attempt < 100 && sent.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(sent.sort(), ['recover-one', 'recover-two'])
  await restarted.recover()
  assert.equal(sent.length, 2)
  await restarted.close()
})

test('同话题不同发送者逐单元授权，拒绝者不继承首条消息权限', async t => {
  const sent = []
  const { workflow } = await fixture(t, {
    context: { bindTopic: async ({ run, unit }) => ({ topicId: 'topic-auth', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId, title: '查询', facts: [] }), facts: async () => ({}), validateAction: async (_, info) => ({ allowed: info.run.actorId === 'alice', reason: '无权' }) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] }
      if (stage === 'R') return binding
      if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) }
      throw new Error(`unexpected stage ${stage}`)
    },
    handlers: { status: async (_, info) => { sent.push(info.run.actorId); return { ok: true } } },
  })
  const one = await workflow.receive({ sourceKey: 'auth-one', sourceVersion: 1, conversationId: 'group', actorId: 'alice', body: '查A' }, { process: false })
  const two = await workflow.receive({ sourceKey: 'auth-two', sourceVersion: 1, conversationId: 'group', actorId: 'bob', body: '查B' }, { process: false })
  await Promise.all([workflow.process(one.runId), workflow.process(two.runId)])
  for (let attempt = 0; attempt < 100 && (await workflow.state(two.runId)).run.status !== 'settled'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(sent, ['alice'])
  assert.equal((await workflow.state(two.runId)).commands[0].status, 'rejected')
})

test('message.task.latest 返回最近已应用的续办命令，message.task 保持首条来源', async t => {
  const { store } = await fixture(t, { judge: async () => { throw new Error('MODEL_NOT_EXPECTED') } })
  for (const [version, kind] of [[1, 'create'], [2, 'reopen']]) {
    const runId = `latest-run-${version}`, sourceKey = `latest-source-${version}`, unitId = `${runId}:u0`, commandId = `${runId}:command`
    await store.command({ id: `receive:${runId}`, kind: 'message.receive', args: { runId, sourceKey, sourceVersion: 1, conversationId: 'group', actorId: 'owner', body: '继续', policy: {} } })
    await store.command({ id: `split:${runId}`, kind: 'message.split', args: { runId, units: [{ unitId, goalText: '继续', spans: [{ start: 0, end: 2 }], constraints: [], contextNeeds: [] }] } })
    await store.command({ id: `accept:${runId}`, kind: 'message.accept', args: { runId, unitId, commands: [{ commandId, kind, args: { taskId: 'same-task', arguments: { objective: `目标${version}` } }, dependsOn: [] }] } })
    const claimed = await store.command({ id: `claim:${runId}`, kind: 'message.command.claim', args: { commandId } })
    await store.command({ id: `complete:${runId}`, kind: 'message.command.complete', args: { commandId, leaseEpoch: claimed.result.command.leaseEpoch, result: { ok: true } } })
  }
  assert.equal((await store.query({ kind: 'message.task', taskId: 'same-task' })).command.kind, 'create')
  const latest = await store.query({ kind: 'message.task.latest', taskId: 'same-task' })
  assert.equal(latest.command.kind, 'reopen')
  assert.equal(latest.run.runId, 'latest-run-2')
})

test('A关联等待时B独立接纳和回复；重复接收不重复派发', async t => {
  let release, bDone
  const blocked = new Promise(resolve => { release = resolve }), done = new Promise(resolve => { bDone = resolve })
  const sent = []
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => { if (stage === 'S') return split; if (stage === 'R' && input.goalText === '查A') await blocked; return stage === 'R' ? binding : intent }, handlers: { status: async (_, { unit }) => { sent.push(unit.goalText); if (unit.goalText === '查B') bDone(); return { state: 'read' } } } })
  const received = await workflow.receive(source, { process: false })
  const processing = workflow.process(received.runId)
  await done
  assert.deepEqual(sent, ['查B'])
  release(); await processing
  assert.equal((await workflow.state(received.runId)).run.status, 'settled')
  await workflow.receive(source, { process: false }); await workflow.process(received.runId)
  assert.equal(sent.length, 2)
})

test('模型越界候选拒绝且不派发，记录可恢复失败', async t => {
  let dispatched = 0
  const { workflow } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : { ...binding, disposition: 'existing', candidateId: 'invented' }, handlers: { status: async () => dispatched++ } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  const state = await workflow.state(runId)
  assert.equal(dispatched, 0)
  assert.equal(state.nodes.filter(node => node.error === 'MESSAGE_UNKNOWN_TARGET').length, 2)
})

test('超时保留成功S，关闭重建运行器后不重新拆分', async t => {
  const calls = []
  const { workflow, store } = await fixture(t, { policy: { attemptMs: 15, recoveryDelaysMs: [0] }, judge: async ({ stage }) => { calls.push(stage); if (stage === 'S') return split; return new Promise(() => {}) } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId); await workflow.close()
  const recovered = createMessageWorkflow({ store, judge: async ({ stage }) => { calls.push(stage); return stage === 'R' ? binding : intent }, handlers: { status: async () => ({ ok: true }) } })
  await recovered.process(runId)
  assert.equal(calls.filter(stage => stage === 'S').length, 1)
  assert.equal((await recovered.state(runId)).run.status, 'settled')
  await recovered.close()
})

test('历史原文增长不进入S；跨群未授权内容不进入manifest，远端引用不下载', async () => {
  let downloads = 0
  const context = { history: async () => [{ sourceKey: 'old', text: '无关'.repeat(100000), conversationId: 'group' }, { sourceKey: 'secret', text: 'secret', conversationId: 'other' }], resolveQuote: async () => { downloads++; throw Error('remote') } }
  const snapshot = await prepareMessageContext({ ...source, context: { quoteRefs: ['missing'] } }, context)
  assert.equal(downloads, 0)
  assert.equal(snapshot.historyManifest.length, 1)
  assert.ok(JSON.stringify(splitContext(snapshot)).length < 1000)
  assert.equal(snapshot.quotes[0].missing, true)
})

test('澄清答案恢复原节点且不创建新消息；无权回复拒绝，重复回复不重派', async t => {
  let sends = 0
  const one = { ...split, units: [split.units[0]], coverage: [{ start: 0, end: 5, role: 'unit' }] }
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => stage === 'S' ? one : stage === 'R' ? (input.clarificationAnswers?.length ? binding : { kind: 'needs_clarification', reason: '哪个任务', question: '第一个还是第二个？', needs: [] }) : intent, handlers: { status: async () => { sends++; return { ok: true } } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  const request = (await workflow.state(runId)).requests[0]
  await assert.rejects(workflow.resume({ runId, requestId: request.id, eventId: 'evil', actorId: 'other', answer: '第一个' }), { code: 'MESSAGE_ACTOR_FORBIDDEN' })
  await workflow.resume({ runId, requestId: request.id, eventId: 'answer-1', actorId: 'user', answer: '第一个' })
  assert.equal((await workflow.state(runId)).run.status, 'settled')
  await workflow.resume({ runId, requestId: request.id, eventId: 'answer-1', actorId: 'user', answer: '第一个' })
  assert.equal(sends, 1)
})

test('provider纯节点无工具且额外工具块直接拒绝', async () => {
  let call
  const model = createMessageModel({ modelConfig: { provider: 'test', model: 'test' }, llm: { async *stream(args) { call = args; yield { type: 'tool-call-delta' } } } })
  await assert.rejects(model({ stage: 'S', input: {}, maxOutputTokens: 2000 }), /MESSAGE_TOOL_FORBIDDEN/)
  assert.deepEqual(call.tools, [])
})

test('补充撤销源版本时迟到R结果不能接纳和派发', async t => {
  let release, started
  const hold = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { started = resolve })
  let sends = 0
  const { workflow } = await fixture(t, { judge: async ({ stage }) => { if (stage === 'S') return split; if (stage === 'R') { started(); await hold }; return stage === 'R' ? binding : intent }, handlers: { status: async () => { sends++; return {} } } })
  const first = await workflow.receive(source, { process: false }); const driving = workflow.process(first.runId)
  await ready
  await workflow.receive({ ...source, sourceVersion: 2, body: '先不要执行' }, { process: false })
  release(); await driving.catch(error => assert.ok(['MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(error.code)))
  assert.equal(sends, 0)
  assert.equal((await workflow.state(first.runId)).run.status, 'superseded')
})

test('材料等待不占模型槽，材料就绪只恢复原节点', async t => {
  let available = false
  const calls = [], replies = []
  const units = structuredClone(split)
  units.units[0].contextNeeds = [{ resourceRef: 'attachment-a', reason: '目标在附件中' }]
  const { workflow } = await fixture(t, { context: { material: async () => ({ ready: available, data: { target: 'A' } }) }, judge: async ({ stage, input }) => { calls.push(`${stage}:${input.goalText ?? ''}`); return stage === 'S' ? units : stage === 'R' ? binding : intent }, handlers: { status: async (_, { unit }) => { replies.push(unit.goalText); return {} } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  assert.deepEqual(replies, ['查B'])
  assert.ok(!calls.includes('R:查A'))
  available = true; await workflow.recover()
  assert.deepEqual(replies, ['查B', '查A'])
  assert.equal(calls.filter(value => value.startsWith('S:')).length, 1)
})

test('重拆保留已消费B的命令，A纠正后继续而不重复B', async t => {
  let notify, corrected = false
  const done = new Promise(resolve => { notify = resolve }), replies = []
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => {
    if (stage === 'S') return split
    if (stage === 'R') return binding
    if (input.goalText === '查A' && !corrected) { await done; corrected = true; return { kind: 'needs_resegmentation', reason: '重新核对完整来源边界' } }
    return intent
  }, handlers: { status: async (_, { unit }) => { replies.push(unit.goalText); if (unit.goalText === '查B') notify(); return {} } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  assert.deepEqual(replies, ['查B', '查A'])
  assert.equal((await workflow.state(runId)).run.status, 'settled')
})

test('接收后立刻关闭不把后续节点永久留在关闭队列', { timeout: 2000 }, async t => {
  const { workflow } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : stage === 'R' ? binding : intent })
  await workflow.receive(source)
  await workflow.close()
  await assert.rejects(workflow.process('any'), /MESSAGE_WORKFLOW_CLOSED/)
})

test('慢独立动作不挡另一个事项八动作依赖链即时走完', { timeout: 3000 }, async t => {
  let release, complete
  const slow = new Promise(resolve => { release = resolve }), fast = new Promise(resolve => { complete = resolve }), events = []
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => stage === 'S' ? split : stage === 'R' ? binding : input.goalText === '查A' ? intent : { ...intent, actions: Array.from({ length: 8 }, (_, index) => ({ intent: 'status', arguments: { text: String(index) }, dependsOn: index ? [index - 1] : [] })) }, handlers: { status: async (action, { unit }) => {
    if (unit.goalText === '查A') { await slow; events.push('A'); return {} }
    events.push(Number(action.arguments.text)); if (action.arguments.text === '7') complete(); return {}
  } } })
  const { runId } = await workflow.receive(source, { process: false }); const run = workflow.process(runId)
  await fast
  assert.deepEqual(events, [0, 1, 2, 3, 4, 5, 6, 7])
  release(); await run
  assert.equal((await workflow.state(runId)).run.status, 'settled')
})

test('未实现handler持久记录needs_attention而非静默pending或假成功', async t => {
  const { workflow } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : stage === 'R' ? binding : intent })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  const state = await workflow.state(runId)
  assert.equal(state.run.status, 'needs_attention')
  assert.ok(state.commands.every(command => command.status === 'pending'))
})

test('必要上下文超限进入可见attention，投影异常不形成静默pending恢复循环', async t => {
  for (const scenario of ['capacity', 'projection']) {
    const { workflow } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : binding, context: { candidates: async () => scenario === 'capacity' ? [{ candidateId: 'one', distinguishingFacts: ['必需判别'.repeat(5000)] }] : [], facts: async () => { throw new Error('WORKFLOW_TASK_FORBIDDEN') } } })
    const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
    const data = await workflow.state(runId)
    assert.equal(data.run.status, 'needs_attention')
    assert.equal(data.requests.length, 0)
  }
})

test('执行材料未齐不接纳，ready事件只检查材料不重跑I', async t => {
  let ready = false, iCalls = 0, sends = 0
  const { workflow } = await fixture(t, { context: { material: async () => ({ ready, data: { resources: ['attachment'] } }) }, judge: async ({ stage }) => { if (stage === 'S') return split; if (stage === 'R') return binding; iCalls++; return { ...intent, requiredExecutionMaterials: ['attachment'] } }, handlers: { status: async () => { sends++; return {} } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  assert.equal(sends, 0)
  ready = true; await workflow.recover()
  assert.equal(sends, 2)
  assert.equal(iCalls, 2)
})

test('R 节点把 S 的历史短引用还原为来源键后再取材料', async t => {
  const requested=[]
  const {workflow}=await fixture(t,{context:{history:async()=>[{sourceKey:'history-account',text:'test3 创建时间为空',conversationId:'group'}],material:async({needs})=>{
    requested.push(needs[0].resourceRef)
    return needs[0].resourceRef==='history-account'?{ready:true,data:{resources:[{resourceRef:'history-account',text:'test3 创建时间为空'}]}}:{ready:false}
  }},judge:async({stage,input})=>stage==='S'
    ?{kind:'split',units:[{spans:[{start:0,end:input.source.text.length}],goalText:input.source.text,constraints:[],contextNeeds:[{resourceRef:'h1',reason:'指代前文'}]}],coverage:[{start:0,end:input.source.text.length,role:'unit'}],sharedConstraints:[]}
    :stage==='R'?binding:intent,handlers:{status:async()=>({})}})
  const {runId}=await workflow.receive({...source,body:'这个账号怎么回事'},{process:false})
  await workflow.process(runId)
  assert.deepEqual(requested,['history-account'])
  assert.equal((await workflow.state(runId)).run.status,'settled')
})

test('S投影保留可追溯缺口，长群职责和30条历史不阻塞事项拆分', async () => {
  const snapshot = await prepareMessageContext({ ...source, context: { compactPolicy: '职责'.repeat(2100) } }, {
    history: async () => Array.from({ length: 30 }, (_, index) => ({ sourceKey: `history-${index}`, text: '历史消息'.repeat(30), conversationId: 'group' })),
    splitBackground: async ({ history }) => ({ messages: history.slice(-7).map(item => ({ sourceKey: item.sourceKey, text: item.text.slice(0, 20) })), omissions: history.slice(0, -7).map(item => ({ sourceKey: item.sourceKey, reason: 'background_budget', contentLength: item.text.length })) })
  })
  const projected = splitContext(snapshot)
  assert.equal(snapshot.policy.length, 4200)
  assert.equal(projected.policy, undefined)
  assert.ok(projected.omissions.includes('h1'))
  assert.equal(snapshot.historyManifest[0].sourceKey, 'history-0')
  assert.ok(Buffer.byteLength(JSON.stringify(projected) + messageSystem('S')) <= 8000)
})

test('S短引用在材料请求前恢复原sourceKey，正文只进入一次模型输入', async t => {
  const original = 'dws:' + 'a'.repeat(64)
  const { workflow } = await fixture(t, { context: { history: async () => [{ sourceKey: original, text: '历史事实', conversationId: 'group' }] }, judge: async ({ stage, input }) => {
    assert.equal(stage, 'S')
    assert.equal(input.omissions[0], 'h1')
    assert.ok(input.segments.every(segment => segment.text === undefined))
    return { kind: 'needs_context', reason: '查历史', needs: [{ resourceRef: 'h1', reason: '指代前文' }] }
  } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  assert.equal((await workflow.state(runId)).requests[0].needs[0].resourceRef, original)
})

test('R明确引用候选不因容量被删除；超出保护集合时留可见容量状态', async t => {
  let relationCalls = 0
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 8 }, (_, i) => ({ candidateId: `c${i}`, goal: `任务${i}`, explicitReferenceMatches: [`ref${i}`], sourceRefs: [`ref${i}`], distinguishingFacts: ['完整关键事实'.repeat(200)] })) }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }], sharedConstraints: [] }
    relationCalls++; return binding
  } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  const state = await workflow.state(runId)
  assert.match(state.run.reason, /^MESSAGE_CONTEXT_CAPACITY:R:/)
  assert.equal(relationCalls, 0)
  assert.equal(state.commands.length, 0)
})

test('R补取的长材料尾部限制进入I与效果命令，原文引用保留', async t => {
  let intentInput, applied
  const restriction = '禁止生产写入，仅验证UAT2'
  const { workflow } = await fixture(t, { context: { material: async () => ({ ready: true, data: { resources: [{ resourceRef: 'history:audit', text: '历史描述'.repeat(300) + `。${restriction}` }], constraints: [restriction] } }) }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.source.text.length }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.source.text.length, role: 'unit' }], sharedConstraints: [] }
    if (stage === 'R') return input.clarificationAnswers ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['材料已取回'] } : { kind: 'needs_context', reason: '查历史', needs: [{ resourceRef: 'history:audit', reason: '核对目标' }] }
    intentInput = input
    return { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '验证问题', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
  }, handlers: { create: async action => { applied = action; return { accepted: true } } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId); await workflow.recover()
  assert.ok(JSON.stringify(intentInput.resolvedEvidence).includes(restriction))
  assert.ok(applied)
  assert.ok(applied.constraints.includes(restriction))
  assert.ok(applied.requiredExecutionMaterials.includes('history:audit'))
  assert.equal((await workflow.state(runId)).run.status, 'settled')
})

test('长材料中段对象与日期保留全文', async t => {
  const important = '本次处理对象是乙租户，验收日期为十一月十五日。'
  let seen = false
  const content = '背景记录。'.repeat(100) + important + '继续记录。'.repeat(100) + '禁止生产写入。'
  const { workflow } = await fixture(t, { handlers: { status: async () => ({}) }, context: { material: async () => ({ ready: true, data: { resources: [{ resourceRef: 'history:middle', text: content }] } }) }, judge: async ({ stage, input }) => {
    if (stage === 'S') return split
    if (stage === 'R') {
      if (!input.clarificationAnswers) return { kind: 'needs_context', reason: '读取材料', needs: [{ resourceRef: 'history:middle', reason: '核对对象和日期' }] }
      seen = JSON.stringify(input.clarificationAnswers).includes(important)
      return binding
    }
    return intent
  } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId); await workflow.recover()
  assert.equal(seen, true)
  assert.equal((await workflow.state(runId)).run.status, 'settled')
})

test('必要材料超限时不使用首尾预览派发效果', async t => {
  let effects = 0
  const { workflow } = await fixture(t, { handlers: { status: async () => { effects++; return {} } },
    context: { material: async () => ({ ready: true, data: { resources: [{ resourceRef: 'history:large', text: '长材料内容'.repeat(2000) }] } }) },
    judge: async ({ stage }) => stage === 'S' ? split : stage === 'R'
      ? { kind: 'needs_context', reason: '完整材料必需', needs: [{ resourceRef: 'history:large', reason: '核对全部条件' }] } : intent })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId); await workflow.recover()
  const state = await workflow.state(runId)
  assert.equal(state.run.status, 'needs_attention')
  assert.match(state.run.reason, /MESSAGE_MATERIAL_CAPACITY/)
  assert.equal(effects, 0)
  assert.equal(state.commands.length, 0)
})

test('确定性S跳过模型容量及调用账，后继R仍受自己的容量约束', async t => {
  let calls = 0
  const { workflow } = await fixture(t, { judge: async () => { calls++; return binding } })
  const body = '小小鹏，审核任务都部署了吗？' + '补充说明'.repeat(800)
  const { runId } = await workflow.receive({ ...source, body }, { process: false }); await workflow.process(runId)
  const state = await workflow.state(runId)
  assert.equal(state.nodes.find(node => node.nodeId === 'S').usage.input, 0)
  assert.equal(state.budget.claims, 0)
  assert.equal(calls, 0)
  assert.match(state.run.reason, /^MESSAGE_CONTEXT_CAPACITY:R:/)
})

test('旧R容量阻断含已解决材料请求时恢复原节点且不重跑S', async t => {
  let sCalls = 0
  const { workflow, store } = await fixture(t, { judge: async ({ stage }) => { if (stage === 'S') { sCalls++; return split }; return stage === 'R' ? binding : intent }, handlers: { status: async () => ({ ok: true }) } })
  const { runId } = await workflow.receive(source, { process: false })
  const snapshot = await prepareMessageContext(source, {})
  await store.command({ id: 'budget-snapshot', kind: 'message.snapshot', args: { runId, snapshot } })
  const claimed = (await store.command({ id: 'budget-s-claim', kind: 'message.node.claim', args: { runId, unitId: '$', nodeId: 'S', input: {}, estimatedInputTokens: 0, maxOutputTokens: 0 } })).result.node
  await store.command({ id: 'budget-s-complete', kind: 'message.node.complete', args: { runId, nodeRunId: claimed.nodeRunId, leaseEpoch: claimed.leaseEpoch, output: { output: split }, usage: { inputTokens: 0, outputTokens: 0 } } })
  await store.command({ id: 'budget-split', kind: 'message.split', args: { runId, units: split.units.map((unit, i) => ({ ...unit, unitId: `${runId}:u${i}` })) } })
  const requestId = 'resolved-budget-request'
  await store.command({ id: 'budget-request', kind: 'message.wait', args: { runId, unitId: `${runId}:u0`, nodeId: 'R', reason: '旧材料请求', request: { requestId, kind: 'needs_context', question: '核对目标', needs: [{ resourceRef: 'history:a', reason: '查历史' }], permittedActors: ['user'] } } })
  await store.command({ id: 'budget-wake', kind: 'message.wake', args: { runId, requestId, eventId: 'material-ready', actorId: 'user', answer: { resources: [{ resourceRef: 'history:a', text: '已核对' }] } } })
  await store.command({ id: 'budget-attention', kind: 'message.attention', args: { runId, reason: `MESSAGE_CONTEXT_CAPACITY:R:${runId}:u0:16000/14000` } })
  await workflow.recover()
  const state = await workflow.state(runId)
  assert.equal(state.run.status, 'settled', JSON.stringify({ reason: state.run.reason, capacityRetryVersion: state.run.capacityRetryVersion, requests: state.requests, commands: state.commands, nodes: state.nodes.map(node => ({ id: node.nodeId, unitId: node.unitId, status: node.status, error: node.error })) }))
  assert.equal(state.run.capacityRetryVersion, 'r-bounded-cards-v2')
  assert.equal(state.requests[0].status, 'resolved')
  assert.equal(sCalls, 0)
})

test('模型请求计量与实际发送复用同一system和message', async () => {
  const input = { source: '含中文与code()' }, prepared = prepareMessageRequest('R', input)
  let observed
  const model = createMessageModel({ modelConfig: { provider: 'test', model: 'test' }, llm: { async *stream(args) { observed = args; yield { type: 'text-delta', text: JSON.stringify(binding) }; yield { type: 'finish', reason: { kind: 'stop' } } } } })
  await model({ stage: 'R', input, prepared, maxOutputTokens: 1000 })
  assert.equal(observed.system, prepared.system)
  assert.deepEqual(observed.messages, prepared.messages)
  assert.equal(prepared.inputBytes, Buffer.byteLength(prepared.system) + Buffer.byteLength(JSON.stringify(input)))
})

test('S容量修复仅恢复无副作用旧消息一次，重复恢复不循环', async t => {
  let calls = 0
  const { workflow, store } = await fixture(t, { judge: async ({ stage }) => { calls++; return stage === 'S' ? split : stage === 'R' ? binding : intent }, handlers: { status: async () => ({ ok: true }) } })
  const { runId } = await workflow.receive(source, { process: false })
  await store.command({ id: 'snapshot', kind: 'message.snapshot', args: { runId, snapshot: await prepareMessageContext(source, {}) } })
  await store.command({ id: 'attention', kind: 'message.attention', args: { runId, reason: 'MESSAGE_CONTEXT_CAPACITY:S:$:12000/8000' } })
  await workflow.recover()
  assert.equal((await workflow.state(runId)).run.status, 'settled')
  const before = calls
  await workflow.recover()
  assert.equal(calls, before)
  assert.equal((await workflow.state(runId)).run.capacityRetryVersion, 's-compact-v1')
  await store.command({ id: 'attention-again', kind: 'message.attention', args: { runId, reason: 'MESSAGE_CONTEXT_CAPACITY:S:$:12000/8000' } })
  await workflow.recover()
  assert.equal(calls, before)
  assert.equal((await workflow.state(runId)).run.status, 'needs_attention')
})

test('R身份卡保留明确引用并压缩无关历史来源', () => {
  const refs = Array.from({ length: 60 }, (_, i) => `channel:account:group:history-${i}`)
  const cards = candidateCards(Array.from({ length: 8 }, (_, i) => ({ candidateId: `legacy:task-${i}`, taskId: `task-${i}`, title: `任务 ${i}`, goal: `任务 ${i}`, state: 'completed', sourceRefs: refs, explicitReferenceMatches: i === 0 ? [refs[0]] : [], distinguishingFacts: ['旧引擎已完成任务，仅支持只读状态和结果查询'] })))
  assert.deepEqual(cards[0].sourceRefs, [refs[0]])
  assert.equal(cards[0].omissions[0].count, 59)
  assert.ok(Buffer.byteLength(JSON.stringify({ candidates: cards }) + messageSystem('R')) <= 12000)
})

test('R容量旧阻断仅在无命令、请求和副作用时重试', async t => {
  const { workflow, store } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : stage === 'R' ? binding : intent, handlers: { status: async () => ({ ok: true }) } })
  const { runId } = await workflow.receive(source, { process: false })
  const snapshot = await prepareMessageContext(source, {})
  await store.command({ id: 'snapshot-r', kind: 'message.snapshot', args: { runId, snapshot } })
  const claimed = await store.command({ id: 'claim-s-before-r', kind: 'message.node.claim', args: { runId, unitId: '$', nodeId: 'S', input: {}, estimatedInputTokens: 0, maxOutputTokens: 0 } })
  const node = claimed.result.node
  await store.command({ id: 'complete-s-before-r', kind: 'message.node.complete', args: { runId, nodeRunId: node.nodeRunId, leaseEpoch: node.leaseEpoch, output: { output: split }, usage: { inputTokens: 0, outputTokens: 0 } } })
  await store.command({ id: 'split-r', kind: 'message.split', args: { runId, units: split.units.map((unit, i) => ({ ...unit, unitId: `${runId}:u${i}` })), coverage: split.coverage } })
  await store.command({ id: 'attention-r', kind: 'message.attention', args: { runId, reason: `MESSAGE_CONTEXT_CAPACITY:R:${runId}:u0:16000/4000` } })
  await workflow.recover()
  assert.equal((await workflow.state(runId)).run.capacityRetryVersion, 'r-bounded-cards-v2')
})

test('I容量阻断仅在无副作用时恢复原节点', async t => {
  let large = true
  const { workflow } = await fixture(t, { judge: async ({ stage }) => stage === 'S' ? split : stage === 'R' ? binding : intent, context: { facts: async () => ({ detail: large ? '事实'.repeat(10000) : '已核对' }) }, handlers: { status: async () => ({ ok: true }) } })
  const { runId } = await workflow.receive(source, { process: false })
  await workflow.process(runId)
  assert.match((await workflow.state(runId)).run.reason, /^MESSAGE_CONTEXT_CAPACITY:I:/)
  large = false
  await workflow.recover()
  const state = await workflow.state(runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(state.run.capacityRetryVersion, 'i-bounded-facts-v1')
})

test('I参数命名错误不派发，字段校验反馈只重试I', async t => {
  let wrong = true, sent = 0, sawFailure = false
  const { workflow } = await fixture(t, { policy: { recoveryDelaysMs: [0] }, judge: async ({ stage, input }) => {
    if (stage === 'S') return split
    if (stage === 'R') return binding
    if (wrong) return { ...intent, actions: [{ intent: 'create', arguments: { goal: '错误别名', workflowId: 'task-analysis' }, dependsOn: [] }] }
    sawFailure ||= input.previousFailure.includes('MESSAGE_SCHEMA_INVALID')
    return { ...intent, actions: [{ intent: 'create', arguments: { objective: '正确字段', workflowId: 'task-analysis' }, dependsOn: [] }] }
  }, handlers: { create: async () => { sent++; return {} } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  assert.equal(sent, 0)
  wrong = false; await workflow.recover()
  assert.equal(sent, 2)
  assert.equal(sawFailure, true)
  assert.equal((await workflow.state(runId)).nodes.filter(node => node.nodeId === 'S').length, 1)
})

test('Host预检拒绝在claim前收口，并拒绝依赖动作且从不进入handler', async t => {
  let calls = 0
  const { workflow } = await fixture(t, { context: { validateAction: async () => ({ allowed: false, reason: '没有执行权限' }) }, judge: async ({ stage }) => stage === 'S' ? split : stage === 'R' ? binding : { ...intent, actions: [{ intent: 'status', arguments: {}, dependsOn: [] }, { intent: 'status', arguments: {}, dependsOn: [0] }] }, handlers: { status: async () => { calls++; return {} } } })
  const { runId } = await workflow.receive(source, { process: false }); await workflow.process(runId)
  const state = await workflow.state(runId)
  assert.equal(state.run.status, 'settled')
  assert.equal(calls, 0)
  assert.ok(state.commands.every(command => command.status === 'rejected' && command.leaseEpoch === 0))
  await workflow.process(runId)
  assert.equal(calls, 0)
})

test('IB 有效条件本身超过输入预算时零派发且记录容量原因', async t => {
  let effects = 0
  const { workflow } = await fixture(t, { context: {
    bindTopic: async ({ run, unit }) => ({ topicId: 'oversize-topic', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId, title: '大条件集', facts: [] }),
    facts: async () => ({ topic: { topicId: 'oversize-topic', facts: [{ kind: 'constraint', text: '有效且不可删除的条件'.repeat(4000) }], sources: [] } }),
  }, judge: async ({ stage, input }) => stage === 'S' ? { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }], sharedConstraints: [] } : binding,
  handlers: { create: async () => { effects++; return {} } } })
  const { runId } = await workflow.receive({ ...source, body: '处理条件' }, { process: false }); await workflow.process(runId)
  let state = await workflow.state(runId)
  for (let attempt = 0; attempt < 100 && state.run.status === 'pending'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); state = await workflow.state(runId) }
  assert.equal(state.run.status, 'needs_attention')
  assert.match(state.run.reason, /MESSAGE_CONTEXT_CAPACITY:IB/)
  assert.equal(state.commands.length, 0)
  assert.equal(effects, 0)
})

test('I投影去除Host目标副本，完整保留身份材料权限和约束',()=>{
  const target={candidateId:'c',taskId:'t',runId:'r',goal:'完整目标',sourceRefs:['source'],distinguishingFacts:['权限和目标判别事实'],versions:{requirement:3}}
  const binding={...target,disposition:'existing',evidence:['引用'],target}
  const base={text:'修改目标',constraints:['禁止生产写入'],sharedConstraints:['保留旧记录'],referenceSources:[{sourceKey:'source',text:'完整来源原文',readScope:['owner']}]}
  const facts={topic:{actorId:'owner',facts:[{kind:'constraint',text:'不得删除',sourceRefs:[{sourceKey:'source',text:'完整来源原文'}]}]}}
  const projected=intentContext(base,binding,facts)
  assert.deepEqual(projected,{...base,binding:{...target,disposition:'existing',evidence:['引用']},facts})
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<Buffer.byteLength(JSON.stringify({...base,binding,facts})))
  const shared = intentContext(base, binding, { ...facts, topic: { ...facts.topic, topicId: 'topic-shared', contextRevision: 4 } }, '', [], [], { sharedTopic: true })
  assert.deepEqual(shared.facts.topic, { topicId: 'topic-shared', contextRevision: 4 })
  assert.ok(!JSON.stringify(shared.facts).includes('不得删除'))
  assert.equal(binding.target,target)
})
test('编辑失效的旧话题约束不再进入意图上下文',()=>{
  const facts={topic:{facts:[{kind:'constraint',text:'只用中文',status:'invalidated',sourceRefs:[{sourceKey:'m',sourceVersion:1}]},{kind:'constraint',text:'改用英文',status:'active',sourceRefs:[{sourceKey:'m',sourceVersion:2}]}]}}
  const input=intentContext({text:'改用英文',constraints:[]},{kind:'binding',disposition:'existing',target:{taskId:'t'}},facts)
  assert.deepEqual(input.facts.topic.facts.map(fact=>fact.text),['改用英文'])
  assert.equal(facts.topic.facts.length,2)
})
test('有权且明确目标的暂停意图越过无关归类等待，普通意图仍等待',async t=>{
  const effects=[]
  const binding={kind:'binding',disposition:'existing',candidateId:'task',evidence:['明确任务']}
  const {store,workflow}=await fixture(t,{
    context:{bindTopic:async({run,unit})=>({topicId:'task-topic',conversationId:run.conversationId,sourceRunId:run.runId,unitId:unit.unitId,title:'任务',facts:[]}),
      facts:async()=>({}),candidates:async()=>[{candidateId:'task',taskId:'task',topicId:'task-topic',engine:'workflow',title:'任务',goal:'原任务',state:'active'}],
      authorizePriorityControl:async({run})=>run.sourceKey==='control'?{taskId:'task',action:'pause'}:null},
    judge:async({stage,input})=>stage==='S'?{kind:'split',units:[{spans:[{start:0,end:input.sourceLength}],goalText:input.source.text,constraints:[],contextNeeds:[]}],sharedConstraints:[],coverage:[{start:0,end:input.sourceLength,role:'unit'}]}
      :stage==='R'?binding:{kind:'topic_intents',decisions:input.units.map(item=>({unitId:item.unitId,intent:{kind:'intent',actions:[{intent:'pause',arguments:{},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}))},
    handlers:{pause:async()=>{effects.push('pause');return{ok:true}}},
  })
  const command=async(kind,args)=>store.command({id:randomUUID(),kind:`message.${kind}`,args})
  await command('receive',{runId:'origin',sourceKey:'origin',sourceVersion:1,conversationId:'g',actorId:'a',body:'原任务'})
  await command('split',{runId:'origin',units:[{unitId:'origin-unit'}]})
  await command('topic.bind',{runId:'origin',unitId:'origin-unit',expectedRevision:0,binding:{...binding,taskId:'task'},topic:{topicId:'task-topic',conversationId:'g',sourceRunId:'origin',unitId:'origin-unit',title:'任务',facts:[]}})
  await command('topic.intent.accept',{runId:'origin',topicId:'task-topic',conversationId:'g',inputRevision:1,decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'create-task',kind:'create',args:{taskId:'task'}}]}]})
  const claimed=await command('command.claim',{commandId:'create-task'})
  await command('command.complete',{commandId:'create-task',leaseEpoch:claimed.result.command.leaseEpoch,result:{taskId:'task'}})
  await workflow.receive({sourceKey:'unrelated',sourceVersion:1,conversationId:'g',actorId:'a',body:'其他消息'}, {process:false})
  const control=await workflow.receive({sourceKey:'control',sourceVersion:1,conversationId:'g',actorId:'a',body:'暂停任务'}, {process:false})
  await workflow.process(control.runId)
  for(let i=0;i<30&&!effects.length;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.deepEqual(effects,['pause'],JSON.stringify(await workflow.state(control.runId)))
  assert.equal((await store.query({kind:'message.routing.pending',conversationId:'g'})).length,1)
})

test('C02 共享材料连接器暂停时所有相关事项均不接纳，独立版B可先执行',{timeout:5000},async t=>{
 for(const shared of [false,true]){
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);let reads=0,bDone;const bFinished=new Promise(r=>bDone=r);const sent=[]
  const units=structuredClone(split);units.units[0].contextNeeds=[{resourceRef:'shared-rules',reason:'必要规则'}]
  if(shared){units.units[1].contextNeeds=[...units.units[0].contextNeeds];units.sharedConstraints=['两项均须遵守附件规则']}
  const {workflow,store}=await fixture(t,{context:{material:async()=>{if(++reads===(shared?2:1))started();await gate;return{ready:true,data:{constraints:['禁止生产写入']}}}},judge:async({stage})=>stage==='S'?units:stage==='R'?binding:intent,handlers:{status:async(_,info)=>{sent.push(info.unit.goalText);if(info.unit.goalText==='查B')bDone();return{ok:true}}}})
  const received=await workflow.receive({...source,sourceKey:source.sourceKey+shared},{process:false});const work=workflow.process(received.runId)
  try{await ready
   if(shared){assert.deepEqual(sent,[]);assert.equal((await store.query({kind:'message.run',runId:received.runId})).commands.length,0)}
   else {await bFinished;assert.deepEqual(sent,['查B'])}
  }finally{release()}
  await work;assert.deepEqual(new Set(sent),new Set(['查A','查B']))
 }
})

test('同群消息按接收顺序逐条处理，后一条不越过正在执行的消息',{timeout:5000},async t=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);const effects=[]
 const {workflow}=await fixture(t,{judge:async({stage,input})=>stage==='S'?{kind:'split',units:[{spans:[{start:0,end:input.source.text.length}],goalText:input.source.text,constraints:[],contextNeeds:[]}],sharedConstraints:[],coverage:[{start:0,end:input.source.text.length,role:'unit'}]}:stage==='R'?binding:{...intent,actions:[{intent:input.text==='启动'?'create':input.text==='查询'?'status':'cancel',arguments:input.text==='启动'?{objective:'任务',workflowId:'task-analysis'}:{},dependsOn:[]}]},handlers:{create:async()=>{started();await gate;effects.push('created');return{}},status:async()=>{effects.push('status');return{}},cancel:async()=>{effects.push('cancel');return{}}}})
 const first=await workflow.receive({...source,body:'启动'},{process:false});const creating=workflow.process(first.runId)
 await began
 const later=[]
 for(const body of ['查询','取消']){const next=await workflow.receive({...source,sourceKey:body,body},{process:false});later.push(workflow.process(next.runId))}
 await new Promise(resolve=>setTimeout(resolve,30))
 assert.deepEqual(effects,[])
 release()
 await creating
 await Promise.all(later)
 assert.deepEqual(effects,['created','status','cancel'])
})

test('R 候选分页在第九项命中后只派发一次', async t => {
  const pages = []
  let dispatched = 0
  const { workflow } = await fixture(t, {
    context: { candidates: async () => Array.from({ length: 9 }, (_, index) => ({ candidateId: `page-${index + 1}`, taskId: `task-${index + 1}`, goal: `候选任务 ${index + 1}`, sourceRefs: [], explicitReferenceMatches: [] })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: 2, role: 'unit' }] }
      if (stage === 'R') {
        pages.push(input.candidates.map(item => item.candidateId))
        return input.candidates.some(item => item.candidateId === 'page-9')
          ? { kind: 'binding', disposition: 'existing', candidateId: 'page-9', evidence: ['第九项是对应任务'] }
          : { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['本页没有对应任务'] }
      }
      return intent
    }, handlers: { status: async () => { dispatched++; return { ok: true } } },
  })
  await workflow.receive({ ...source, runId: 'candidate-nine', body: '查A' })
  const state = await workflow.process('candidate-nine')
  assert.equal(pages.length, 2, JSON.stringify(state))
  assert.deepEqual(pages[0], Array.from({ length: 8 }, (_, index) => `page-${index + 1}`))
  assert.deepEqual(pages[1], ['page-9'])
  assert.equal(state.commands[0].args.binding.candidateId, 'page-9')
  assert.equal(state.run.status, 'settled')
  assert.equal(dispatched, 1)
  await workflow.process('candidate-nine')
  assert.equal(dispatched, 1)
})

test('R 候选分页将第一与第九项明确引用同时保护在首页', async t => {
  const pages = []
  const { workflow } = await fixture(t, {
    context: { candidates: async () => Array.from({ length: 9 }, (_, index) => ({ candidateId: `protected-${index + 1}`, taskId: `task-${index + 1}`, goal: `候选 ${index + 1}`, sourceRefs: [`ref-${index + 1}`], explicitReferenceMatches: index === 0 || index === 8 ? [`ref-${index + 1}`] : [] })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: 2, role: 'unit' }] }
      if (stage === 'R') {
        pages.push(input.candidates.map(item => item.candidateId))
        return { kind: 'binding', disposition: 'existing', candidateId: 'protected-9', evidence: ['两个引用已同时核对'] }
      }
      return intent
    }, handlers: { status: async () => ({ ok: true }) },
  })
  await workflow.receive({ ...source, runId: 'protected-nine', body: '查A' })
  const state = await workflow.process('protected-nine')
  assert.equal(pages.length, 1, JSON.stringify(state))
  assert.ok(pages[0].includes('protected-1'))
  assert.ok(pages[0].includes('protected-9'))
  assert.equal(state.commands[0].args.binding.candidateId, 'protected-9')
  assert.equal(state.run.status, 'settled')
})

test('IB 判断期间任务语义事实改变，旧动作零派发且新状态只派发一次', { timeout: 5000 }, async t => {
  let releaseFirst, releaseSecond, startFirst, startSecond, finish
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  const firstStarted = new Promise(resolve => { startFirst = resolve })
  const secondStarted = new Promise(resolve => { startSecond = resolve })
  const dispatched = new Promise(resolve => { finish = resolve })
  let taskStatus = 'running'
  const observed = [], effects = []
  const { workflow } = await fixture(t, {
    context: {
      bindTopic: async ({ run, unit }) => ({ topicId: 'semantic-topic', conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.id ?? unit.unitId, title: '任务状态', facts: [] }),
      facts: async () => ({ task: { taskId: 'semantic-task', status: taskStatus } }),
    },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] }
      if (stage === 'R') return binding
      assert.equal(stage, 'IB')
      const status = input.units[0].input.facts.task.status
      observed.push(status)
      if (observed.length === 1) { startFirst(); await firstGate }
      else if (observed.length === 2) { startSecond(); await secondGate }
      else throw new Error('unexpected repeated IB')
      return { kind: 'topic_intents', decisions: input.units.map(item => ({ unitId: item.unitId, intent })) }
    },
    handlers: { status: async () => { effects.push(observed.at(-1)); finish(); return { ok: true } } },
  })
  const received = await workflow.receive({ ...source, sourceKey: 'semantic-change', body: '查询任务进度' }, { process: false })
  try {
    await workflow.process(received.runId)
    await firstStarted
    taskStatus = 'succeeded'
    releaseFirst()
    const retried = await Promise.race([secondStarted.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))])
    assert.equal(retried, true, JSON.stringify(await workflow.state(received.runId)))
    assert.deepEqual(observed, ['running', 'succeeded'])
    assert.deepEqual(effects, [])
    assert.equal((await workflow.state(received.runId)).commands.length, 0)
    releaseSecond()
    await dispatched
    await workflow.process(received.runId)
    assert.deepEqual(effects, ['succeeded'])
  } finally { releaseFirst(); releaseSecond() }
})

test('长材料分块逐页留证，中段对象日期和末段限制进入 I 且只派发一次', async t => {
 const important='处理对象是乙租户，验收日期为十一月十五日。', restriction='禁止生产写入，仅允许在 UAT 验证。'
 const text='background '.repeat(580)+important+'continuation '.repeat(490)+restriction
 assert.ok(Buffer.byteLength(text)>12000)
 const pages=[],effects=[];let intentInput
 const {workflow}=await fixture(t,{context:{material:async()=>({ready:true,data:{resources:[{resourceRef:'material:long',text}]}})},judge:async({stage,input})=>{
  let output
  if(stage==='S')output={kind:'split',units:[{spans:[{start:0,end:input.sourceLength}],goalText:input.source.text,constraints:[],contextNeeds:[]}],sharedConstraints:[],coverage:[{start:0,end:input.sourceLength,role:'unit'}]}
  else if(stage==='R')output=input.clarificationAnswers?{kind:'binding',disposition:'new',candidateId:null,evidence:['材料已逐页核对']}:{kind:'needs_context',reason:'读取完整材料',needs:[{resourceRef:'material:long',reason:'核对对象日期及限制'}]}
  else if(stage==='material'){
   pages.push(input)
   const facts=[]
   if(input.text.includes(important))facts.push({quote:important,kind:'object'})
   if(input.text.includes(restriction))facts.push({quote:restriction,kind:'restriction'})
   output={kind:'material_facts',complete:true,facts,reason:'本页已覆盖'}
  }else {assert.equal(stage,'I');intentInput=input;output={kind:'intent',actions:[{intent:'create',arguments:{objective:'按材料验证',workflowId:'task-analysis'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}
  return {output,usage:{inputTokens:100,outputTokens:100}}
 },handlers:{create:async action=>{effects.push(action);return{accepted:true}}}})
 const {runId}=await workflow.receive({...source,sourceKey:'paged-material',body:'按材料办理'},{process:false})
 await workflow.process(runId);await workflow.recover()
 const state=await workflow.state(runId)
 assert.equal(state.run.status,'settled',JSON.stringify(state))
 assert.equal(effects.length,1)
 assert.ok(pages.length>=4)
 assert.equal(state.nodes.filter(node=>node.nodeId==='material'&&node.status==='succeeded').length,pages.length)
 assert.equal(pages[0].start,0);assert.equal(pages.at(-1).end,text.length)
 for(let i=1;i<pages.length;i++)assert.ok(pages[i].start<=pages[i-1].end)
 assert.ok(JSON.stringify(intentInput.resolvedEvidence).includes(important))
 assert.ok(JSON.stringify(intentInput.resolvedEvidence).includes(restriction))
 assert.ok(effects[0].constraints.includes(restriction))
 const calls=pages.length
 await workflow.process(runId)
 assert.equal(pages.length,calls);assert.equal(effects.length,1)
})

test('材料分块伪造引文或未完整覆盖时零派发', async t => {
 for(const mode of ['forged','incomplete']){
  let effects=0,materialCalls=0
  const text='材料背景。'.repeat(900)
  const {workflow}=await fixture(t,{context:{material:async()=>({ready:true,data:{resources:[{resourceRef:'material:invalid',text}]}})},judge:async({stage,input})=>{
   let output
   if(stage==='S')output={kind:'split',units:[{spans:[{start:0,end:input.sourceLength}],goalText:input.source.text,constraints:[],contextNeeds:[]}],sharedConstraints:[],coverage:[{start:0,end:input.sourceLength,role:'unit'}]}
   else if(stage==='R')output={kind:'needs_context',reason:'读取材料',needs:[{resourceRef:'material:invalid',reason:'完整条件必需'}]}
   else if(stage==='material'){materialCalls++;output={kind:'material_facts',complete:mode!=='incomplete',facts:[{quote:mode==='forged'?'原文不存在的伪造租户':input.text.slice(0,6),kind:'fact'}],reason:'测试覆盖检查'}}
   else throw new Error('incomplete evidence must not reach intent')
   return {output,usage:{inputTokens:100,outputTokens:100}}
  },handlers:{create:async()=>{effects++;return{}}}})
  const {runId}=await workflow.receive({...source,sourceKey:`invalid-page-${mode}`,body:'按材料办理'},{process:false})
  await workflow.process(runId);await workflow.recover()
  const state=await workflow.state(runId)
  assert.equal(materialCalls,1);assert.equal(effects,0);assert.equal(state.commands.length,0)
  assert.equal(state.run.status,'needs_attention');assert.match(state.run.reason,/MESSAGE_MATERIAL_CAPACITY/)
 }
})

test('C09 材料临时失败在重建 workflow 后续读且复用成功页', async t => {
  const text = '完整材料背景。'.repeat(1100)
  const calls = []
  let allowRetry = false, effects = 0
  const options = { policy: { recoveryDelaysMs: [0, 0] }, context: { material: async () => ({ ready: true, data: { resources: [{ resourceRef: 'material:resume', text }] } }) },
    judge: async ({ stage, input }) => {
      let output
      if (stage === 'S') output = { kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] }
      else if (stage === 'R') output = input.clarificationAnswers ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['材料已完整读取'] } : { kind: 'needs_context', reason: '读取材料', needs: [{ resourceRef: 'material:resume', reason: '完整依据' }] }
      else if (stage === 'material') {
        calls.push(input.pageIndex)
        if (input.pageIndex === 1 && !allowRetry) throw new Error('TEMPORARY_PAGE_FAILURE')
        output = { kind: 'material_facts', complete: true, facts: [], reason: '本页核对完成' }
      } else output = { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '按材料处理', workflowId: 'task-analysis' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }
      return { output, usage: { inputTokens: 100, outputTokens: 100 } }
    }, handlers: { create: async () => { effects++; return { accepted: true } } } }
  assert.ok(Buffer.byteLength(text) > 12000)
  const { workflow, store } = await fixture(t, options)
  const { runId } = await workflow.receive({ ...source, sourceKey: 'material-resume', body: '按材料办理' }, { process: false })
  await workflow.process(runId); await workflow.recover()
  const before = await workflow.state(runId)
  assert.equal(effects, 0)
  assert.equal(before.run.status, 'pending', JSON.stringify(before))
  assert.equal(calls.filter(index => index === 0).length, 1)
  assert.ok(before.nodes.some(node => node.nodeId === 'material' && node.input.pageIndex === 0 && node.status === 'succeeded'))
  assert.ok(before.nodes.some(node => node.nodeId === 'material' && node.input.pageIndex === 1 && node.status === 'failed'))
  await workflow.close()
  allowRetry = true
  const resumed = createMessageWorkflow({ store, ...options })
  try {
    await resumed.recover(); await resumed.process(runId)
    const after = await resumed.state(runId)
    assert.equal(after.run.status, 'settled', JSON.stringify(after))
    assert.equal(calls.filter(index => index === 0).length, 1)
    assert.equal(calls.filter(index => index === 1).length, 2)
    assert.ok(calls.some(index => index > 1))
    assert.equal(effects, 1)
    await resumed.process(runId)
    assert.equal(effects, 1)
  } finally { await resumed.close() }
})
