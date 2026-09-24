import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const {runId}=await workflow.receive({...source,body:'这不是让你去查吗'},{process:false})
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
  const { workflow } = await fixture(t, { context: { material: async () => ({ ready: true, data: { resources: [{ resourceRef: 'history:audit', text: '历史描述'.repeat(1000) + `。${restriction}` }], constraints: [restriction] } }) }, judge: async ({ stage, input }) => {
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

test('I投影去除Host目标副本，完整保留身份材料权限和约束',()=>{
  const target={candidateId:'c',taskId:'t',runId:'r',goal:'完整目标',sourceRefs:['source'],distinguishingFacts:['权限和目标判别事实'],versions:{requirement:3}}
  const binding={...target,disposition:'existing',evidence:['引用'],target}
  const base={text:'修改目标',constraints:['禁止生产写入'],sharedConstraints:['保留旧记录'],referenceSources:[{sourceKey:'source',text:'完整来源原文',readScope:['owner']}]}
  const facts={topic:{actorId:'owner',facts:[{kind:'constraint',text:'不得删除',sourceRefs:[{sourceKey:'source',text:'完整来源原文'}]}]}}
  const projected=intentContext(base,binding,facts)
  assert.deepEqual(projected,{...base,binding:{...target,disposition:'existing',evidence:['引用']},facts})
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<Buffer.byteLength(JSON.stringify({...base,binding,facts})))
  assert.equal(binding.target,target)
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
