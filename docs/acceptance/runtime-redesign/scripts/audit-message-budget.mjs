// 隔离审查：使用真实消息工作流/存储与模拟判断器，不接渠道、不调用模型、不派发业务动作。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../../../../packages/dingtalk-dsh-assistant/message-workflow.js'

const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'message-budget-audit-'))
const outcomes = []
const split = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] })
const binding = { kind: 'binding', disposition: 'conversation', candidateId: null, evidence: ['隔离审查'] }
const intent = { kind: 'intent', actions: [{ intent: 'no_action', arguments: {}, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' }

async function probe(name, options, execute) {
  const store = await openExecutionStore({ dbPath: join(directory, `${name}.sqlite`), instanceId: name, initialize: true })
  const workflow = createMessageWorkflow({ store, ...options })
  try {
    const input = { sourceKey: `audit:${name}`, sourceVersion: 1, conversationId: 'audit', actorId: 'auditor', body: '继续上面八项中的最后一项' }
    outcomes.push({ name, ...await execute(workflow, input) })
  } finally { await workflow.close(); await store.close() }
}

let observedRelation
await probe('explicit-candidate-protected', {
  context: { candidates: async () => Array.from({ length: 8 }, (_, i) => ({ candidateId: `candidate-${i}`, goal: `任务${i}`, detailRef: `candidate-detail:${i}`, explicitReferenceMatches: [`quote-${i}`], sourceRefs: [`quote-${i}`], distinguishingFacts: ['重要事实'.repeat(180)] })) },
  judge: async ({ stage, input }) => { if (stage === 'S') return split(input.source.text); if (stage === 'R') { observedRelation = input; return binding }; return intent },
}, async (workflow, input) => {
  const { runId } = await workflow.receive(input, { process: false }); await workflow.process(runId)
  assert.ok(observedRelation)
  assert.equal(observedRelation.candidates.length, 8)
  assert.equal(observedRelation.omittedCandidateCount, 0)
  return { fixed: true, retained: observedRelation.candidates.map(item => item.candidateId), omitted: observedRelation.omittedCandidateCount }
})

let observedIntent, materialSeenByRelation = false
const constraint = '材料唯一约束：禁止生产写入，仅验证 UAT2'
await probe('material-not-forwarded', {
  context: { material: async () => ({ ready: true, data: { evidence: constraint } }), facts: async () => ({ taskStatus: 'running' }) },
  judge: async ({ stage, input }) => {
    if (stage === 'S') return split(input.source.text)
    if (stage === 'R') {
      if (!input.clarificationAnswers) return { kind: 'needs_context', reason: '需任务历史', needs: [{ resourceRef: 'task-history:audit', reason: '核对原任务范围' }] }
      materialSeenByRelation = JSON.stringify(input).includes(constraint)
      return binding
    }
    observedIntent = input; return intent
  },
}, async (workflow, input) => {
  const { runId } = await workflow.receive(input, { process: false }); await workflow.process(runId); await workflow.recover()
  assert.equal(materialSeenByRelation, true)
  assert.ok(observedIntent)
  assert.equal(JSON.stringify(observedIntent).includes(constraint), true)
  return { fixed: true, materialSeenByRelation, materialSeenByIntent: true, state: (await workflow.state(runId)).run.status }
})

let judgeCalls = 0
await probe('deterministic-node-capacity', {
  judge: async () => { judgeCalls++; return intent },
}, async (workflow, input) => {
  const body = '小小鹏，审核任务都部署了吗？' + '补充说明'.repeat(800)
  const { runId } = await workflow.receive({ ...input, body }, { process: false }); await workflow.process(runId)
  const { run } = await workflow.state(runId)
  const state = await workflow.state(runId)
  assert.ok(state.nodes.some(node => node.nodeId === 'S' && node.status === 'succeeded' && node.usage.input === 0))
  assert.ok(!run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:S:'))
  return { fixed: true, judgeCalls, reason: run.reason ?? null, deterministicS: true }
})

const materialSize = 5000
await probe('resolved-material-capacity-recoverable', {
  policy: { nodeInputByteLimits: { S: 8000, R: 2800, I: 16000 } },
  context: { material: async () => ({ ready: true, data: { text: '大材料'.repeat(materialSize) } }) },
  judge: async ({ stage, input }) => stage === 'S' ? split(input.source.text) : stage === 'R' ? input.clarificationAnswers ? binding : { kind: 'needs_context', reason: '查历史', needs: [{ resourceRef: 'history:audit', reason: '判断关联' }] } : intent,
}, async (workflow, input) => {
  const { runId } = await workflow.receive(input, { process: false }); await workflow.process(runId); await workflow.recover()
  const before = await workflow.state(runId)
  assert.match(before.run.reason, /^MESSAGE_CONTEXT_CAPACITY:R:/)
  await workflow.recover()
  const after = await workflow.state(runId)
  assert.equal(after.run.status, 'needs_attention')
  assert.equal(after.run.capacityRetryVersion, 'r-bounded-cards-v2')
  return { fixed: true, reason: after.run.reason, requestStatus: after.requests[0].status, capacityRecoveryAttempted: true }
})

const output = { checkedAt: new Date().toISOString(), directory, outcomes }
await writeFile(join(directory, 'result.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify(output, null, 2))
