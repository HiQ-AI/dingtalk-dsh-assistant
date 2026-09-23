import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'
import { prepareMessageContext, splitContext, intentContext } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { createMessageModel } from '../packages/dingtalk-dsh-assistant/message-model.js'

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
