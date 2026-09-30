import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'

const split = input => ({ kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text,
  constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] })
const independent = { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前完整对象与候选目标不同，是独立事项'] }
const answer = { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: '查询当前业务对象并回答' }, dependsOn: [] }],
  constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'message-repair-coordination-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: 'repair-test', initialize: true })
  const workflow = createMessageWorkflow({ store, ...options })
  t.after(async () => { await workflow.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, workflow }
}
const source = (id, body = id) => ({ runId: id, sourceKey: id, sourceVersion: 1, conversationId: 'group', actorId: 'user', body })
async function until(predicate, description) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(description)
}

test('同群 A 模型等待时 B 仍能进入拆分，不持有整群异步锁', async t => {
  let releaseA, aStarted = false, bStarted = false
  const blocked = new Promise(resolve => { releaseA = resolve })
  const { workflow } = await fixture(t, { context: { bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.runId}`, conversationId: 'group',
    sourceRunId: run.runId, unitId: unit.unitId, title: run.body, facts: [] }) }, judge: async ({ stage, input }) => {
    if (stage === 'S') {
      if (input.source.sourceKey === 'A') { aStarted = true; await blocked } else bStarted = true
      return { kind: 'no_action', reason: '只提供资料，无需回应', coverage: [{ start: 0, end: input.sourceLength }] }
    }
    throw new Error(`unexpected stage ${stage}`)
  } })
  try {
    await workflow.receive(source('A'))
    await until(() => aStarted, 'A 未进入模型')
    await workflow.receive(source('B'))
    await until(() => bStarted, 'B 被 A 的模型调用阻塞')
  } finally { releaseA(); await workflow.process('A'); await workflow.process('B') }
})

test('候选继续读取是 Host 动作，跨页证据累积且恢复不重复已完成模型调用', async t => {
  let reads = 0, calls = 0
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 79 }, (_, i) => ({ candidateId: `c${i}`, title: `旧对象${i}`, goal: `旧对象${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        reads++
        if (input.candidatePage > 0) assert.ok(input.accumulatedEvidence.length >= input.candidatePage)
        return input.candidateContinuation ? { kind: 'continue_candidates', reason: '本页目标均不同，继续核对目录', evidence: ['已核对本页全部对象'] } : independent
      }
      return answer
    }, handlers: { answer: async () => { calls++; return { reply: '已完成查询' } } } })
  await workflow.receive(source('pages', '查询新的业务对象'), { process: false })
  let state = await workflow.process('pages')
  assert.equal(state.commands[0]?.status, 'applied', JSON.stringify(state.run))
  assert.equal(reads, 10)
  const finishedReads = reads
  state = await workflow.process('pages')
  assert.equal(reads, finishedReads)
  assert.equal(calls, 1)
  assert.equal(state.requests.length, 0)
})

test('非法内部目录引用有限纠正，不落成等待用户的请求', async t => {
  let relations = 0
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => {
    if (stage === 'S') return split(input)
    if (stage === 'R') {
      relations++
      if (relations === 1) return { kind: 'needs_context', reason: '取下一页', needs: [{ resourceRef: 'candidate-catalog:invented:page:1', reason: '内部目录' }] }
      assert.match(input.previousFailure, /REF|RESOURCE|CONTEXT/u)
      return independent
    }
    return answer
  }, handlers: { answer: async () => ({ reply: '已回答' }) } })
  await workflow.receive(source('bad-ref', '查询业务资料'), { process: false })
  const state = await workflow.process('bad-ref')
  assert.equal(state.requests.filter(item => item.status === 'pending').length, 0)
  assert.equal(state.commands[0]?.status, 'applied', JSON.stringify(state.run))
  assert.equal(relations, 2)
})

test('同一消息 A 缺材料不冻结已证明归属独立的 B，恢复后 A 沿原事项完成', async t => {
  let materialReady = false
  const completed = []
  const { workflow } = await fixture(t, { context: {
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${unit.goalText}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
    material: async () => ({ ready: materialReady, data: { text: 'A 的查询资料' } }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [
      { spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [{ resourceRef: 'file-a', reason: 'A 的资料' }] },
      { spans: [{ start: 3, end: 5 }], goalText: '查B', constraints: [], contextNeeds: [] },
    ], sharedConstraints: [], coverage: [{ start: 0, end: 5, role: 'unit' }] }
    if (stage === 'R') return independent
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.unit.goalText); return { reply: '查询完成' } } } })
  await workflow.receive({ ...source('two-units', '查A；查B'), context: { attachments: [{ resourceRef: 'file-a', name: 'A资料' }] } }, { process: false })
  await workflow.process('two-units')
  await until(() => completed.includes('查B'), 'B 被同一来源的 A 材料等待冻结')
  assert.deepEqual(completed, ['查B'])
  assert.equal((await workflow.state('two-units')).requests.filter(item => item.status === 'pending').length, 1)
  materialReady = true
  await workflow.recover()
  await until(() => completed.includes('查A'), 'A 材料恢复后没有继续')
  assert.deepEqual(completed, ['查B', '查A'])
})

test('内部材料失败有界重试后保留系统责任和准确原因，重启不无限重读', async t => {
  let reads = 0
  const { workflow, store } = await fixture(t, { policy: { recoveryDelaysMs: [0, 0] }, context: {
    material: async () => { reads++; return { ready: false, reason: 'CONNECTOR_UNAVAILABLE' } },
  }, judge: async ({ stage, input }) => stage === 'S' ? split(input)
    : { kind: 'needs_context', reason: '读取已提供文件', needs: [{ resourceRef: 'file', reason: '需要完整内容' }] } })
  await workflow.receive({ ...source('bounded-material'), context: { attachments: [{ resourceRef: 'file', name: '已提供文件' }] } }, { process: false })
  await workflow.process('bounded-material')
  for (let i = 0; i < 5; i++) await workflow.recover()
  const state = await store.query({ kind: 'message.run', runId: 'bounded-material' })
  assert.equal(reads, 3)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].blocked, true)
  assert.equal(state.requests[0].responsibility, 'system')
  assert.equal(state.requests[0].lastError, 'CONNECTOR_UNAVAILABLE')
  assert.equal(state.commands.length, 0)
})

test('跨页比较后可以选择首页相关候选，恢复不重复派发', async t => {
  const pages = [], delivered = []
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 9 }, (_, i) => ({ candidateId: `c${i}`, taskId: `task-${i}`, goal: `候选${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        pages.push(input.candidatePage)
        if (input.candidateContinuation) return { kind: 'continue_candidates', reason: '先比较目录末页', evidence: ['首页首项相关，继续核对其余项'],
          assessments: [{ candidateId: 'c0', relation: 'related', reason: '原对象相同', sourceQuote: '查A' }] }
        assert.ok(input.candidates.some(card => card.candidateId === 'c0'))
        assert.ok(input.accumulatedEvidence.some(page => page.assessments.some(item => item.candidateId === 'c0')))
        return { kind: 'binding', disposition: 'existing', candidateId: 'c0', evidence: ['全目录比较后选择首项'] }
      }
      return answer
    }, handlers: { answer: async (_, info) => { delivered.push(info.binding.candidateId); return { reply: '已查询原任务' } } } })
  await workflow.receive(source('first-page-choice', '查A'), { process: false })
  const state = await workflow.process('first-page-choice')
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.deepEqual(pages, [0, 1])
  assert.deepEqual(delivered, ['c0'])
  await workflow.recover()
  assert.deepEqual(delivered, ['c0'])
})

test('非法作用域quote在当轮明确纠正，不等待普通恢复周期', async t => {
  let relations = 0
  const { workflow } = await fixture(t, { policy: { recoveryDelaysMs: [60_000, 60_000] }, context: { candidates: async () => [{ candidateId: 'c0', goal: '另一个业务对象' }] },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        relations++
        if (relations === 1) return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '对象不同', sourceQuote: '不存在的原文' }] }
        assert.match(input.previousFailure, /MESSAGE_SCOPE_PROOF_INVALID/)
        return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '对象不同', sourceQuote: '查A' }] }
      }
      return answer
    }, handlers: { answer: async () => ({ reply: '查询完成' }) } })
  await workflow.receive(source('scope-correction', '查A'), { process: false })
  const state = await workflow.process('scope-correction')
  assert.equal(relations, 2)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.equal(state.requests.length, 0)
})

test('跨页相关候选未撤销时不能直接新建，明确重评后才派发', async t => {
  let finalJudgments = 0, executed = 0
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 9 }, (_, i) => ({ candidateId: `c${i}`, goal: `候选${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        if (input.candidateContinuation) return { kind: 'continue_candidates', reason: '仍需比较目录', evidence: ['首项可能是同一目标'],
          assessments: [{ candidateId: 'c0', relation: 'related', reason: '业务对象相同待比较', sourceQuote: '查A' }] }
        finalJudgments++
        if (finalJudgments === 1) return independent
        assert.match(input.previousFailure, /MESSAGE_/)
        assert.equal(executed, 0, '矛盾归属不得先产生效果')
        return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '完整比较后确认对象不同', sourceQuote: '查A' }] }
      }
      return answer
    }, handlers: { answer: async () => { executed++; return { reply: '完成查询' } } } })
  await workflow.receive(source('related-then-new', '查A'), { process: false })
  const state = await workflow.process('related-then-new')
  assert.equal(finalJudgments, 2)
  assert.equal(executed, 1)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
})

test('非连续原文span分别提交来源证明，真实ledger接纳独立事项', async t => {
  const body = '查A；说明：仅参考；A保留旧状态'
  const finalStart = body.indexOf('A保留')
  const completed = []
  const { workflow, store } = await fixture(t, { context: {
    candidates: async ({ run }) => run.runId === 'seed' ? [] : [{ candidateId: 'old', topicId: 'topic-seed', goal: '查库存' }],
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.runId}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return input.source.sourceKey === 'seed' ? split(input) : { kind: 'split', units: [{
      spans: [{ start: 0, end: 2 }, { start: finalStart, end: body.length }], goalText: '查A并保留旧状态', constraints: [], contextNeeds: [],
    }], sharedConstraints: [], coverage: [{ start: 0, end: body.length, role: 'unit' }] }
    if (stage === 'R') return input.sourceKey === 'seed' ? independent : { ...independent,
      assessments: [{ candidateId: 'old', relation: 'independent', reason: '查A与库存目标不同', sourceQuote: '查A' }] }
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.run.runId); return { reply: '查询完成' } } } })
  await workflow.receive(source('seed', '查库存'), { process: false })
  await workflow.process('seed')
  await until(() => completed.includes('seed'), '基准事项未完成')
  await workflow.receive(source('non-contiguous', body), { process: false })
  await workflow.process('non-contiguous')
  await until(() => completed.includes('non-contiguous'), '合法多span证明被错误判为来源漂移')
  const current = await workflow.state('non-contiguous')
  assert.equal(current.run.status, 'settled', JSON.stringify(current.run))
  const impact = await store.query({ kind: 'message.impact', runId: 'non-contiguous' })
  const saved = JSON.stringify(impact.impact)
  assert.ok(saved.includes('independent'))
  assert.ok(!saved.includes('查A\\nA保留旧状态'))
})

test('A局部协议失败不阻止尚未关联的B，恢复不重复B效果', async t => {
  const completed = []
  const { workflow } = await fixture(t, { policy: { maxCorrections: 0 }, context: {
    candidates: async ({ unit }) => { if (unit.goalText === '查B') await new Promise(resolve => setTimeout(resolve, 80)); return [] },
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${unit.goalText}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [
      { spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [] },
      { spans: [{ start: 3, end: 5 }], goalText: '查B', constraints: [], contextNeeds: [] },
    ], sharedConstraints: [], coverage: [{ start: 0, end: 5, role: 'unit' }] }
    if (stage === 'R') return input.text === '查A'
      ? { kind: 'needs_context', reason: '非法内部材料', needs: [{ resourceRef: 'fake', reason: '内部材料' }] }
      : { ...independent, assessments: input.candidates.filter(item => item.unboundSource).map(item => ({ candidateId: item.candidateId,
        relation: 'independent', reason: '查B与查A各自查询独立对象，无共享条件', sourceQuote: '查B' })) }
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.unit.goalText); return { reply: '查询完成' } } } })
  await workflow.receive(source('local-failure', '查A；查B'), { process: false })
  await workflow.process('local-failure')
  await until(() => completed.includes('查B'), 'B被另一Unit协议失败阻止').catch(async () => {
    const state = await workflow.state('local-failure')
    assert.fail(JSON.stringify({ run: state.run, units: state.units, nodes: state.nodes.map(node => ({ unitId: node.unitId, nodeId: node.nodeId, status: node.status, error: node.error })), commands: state.commands }))
  })
  let state = await workflow.state('local-failure')
  assert.match(state.units.find(unit => unit.goalText === '查A').blockedReason, /PROTOCOL_CORRECTION_EXHAUSTED/)
  assert.deepEqual(completed, ['查B'])
  await workflow.recover()
  state = await workflow.state('local-failure')
  assert.deepEqual(completed, ['查B'])
  assert.equal(state.units.find(unit => unit.goalText === '查B').status, 'applied')
})
