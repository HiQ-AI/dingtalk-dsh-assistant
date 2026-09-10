import assert from 'node:assert/strict'
import test from 'node:test'
import { createStatusQueryHandler } from '../packages/dingtalk-dsh-assistant/status-query.js'

const request = () => ({ requestId: 'query-1', groupId: 'g1', topicId: 't1', revision: 2, sourceMessageIds: ['m1'], sourceMessages: [{ messageId: 'm1', text: '现在完成了吗？' }], taskSnapshots: [{ taskId: 'task1', topicRefs: [{ topicId: 't1', revision: 2 }], state: 'completed', observedAt: '2026-09-10T08:00:00Z' }], compactPolicy: '只回复明确向助手提出的问题。', replyCandidates: [] })
const reply = { kind: 'reply', decision: { actions: [], basisMessageIds: ['m1'], reply: '截至 16:00 的报告显示已完成。' } }
function setup(output = reply, options = {}) {
  const calls = [], commits = [], events = []
  const llm = { async *stream(args) { calls.push(args); yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const handler = createStatusQueryHandler({ llm, modelConfig: { provider: 'same-provider', model: 'same-model', reasoningEffort: 'high' }, commit: async (value) => { commits.push(value); return { status: 'accepted' } }, recordEvent: async (event) => events.push(event), ...options })
  return { handler, calls, commits, events }
}

test('短问答同模型一次调用，空工具、版本提交和usage均保留', async () => {
  const { handler, calls, commits, events } = setup()
  assert.equal((await handler.handle(request())).kind, 'reply')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'same-model')
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.deepEqual(calls[0].tools, [])
  assert.equal(commits[0].request.revision, 2)
  assert.equal(events[1].usage.outputTokens, 20)
  assert.equal(events[1].outcome, 'accepted')
})

test('越界Task动作、额外字段和未知来源均不提交', async () => {
  for (const output of [
    { ...reply, decision: { ...reply.decision, actions: [{ kind: 'new-task', title: '执行', objective: '执行', acceptanceCriteria: ['完成'], topicRefs: [{ topicId: 't1', revision: 2 }] }] } },
    { ...reply, command: 'execute' },
    { ...reply, decision: { ...reply.decision, basisMessageIds: ['unrelated'] } },
  ]) {
    const { handler, commits } = setup(output)
    assert.equal((await handler.handle(request())).kind, 'handoff')
    assert.equal(commits.length, 0)
  }
})

test('输入预算和关联不明确时不发起模型调用，来源快照不能截掉', async () => {
  const bounded = setup(reply, { maxInputTokens: 20 })
  assert.equal((await bounded.handler.handle(request())).reason, 'context_budget_exceeded')
  assert.equal(bounded.calls.length, 0)
  const unrelated = setup()
  assert.equal((await unrelated.handler.handle({ ...request(), taskSnapshots: [{ taskId: 'task1', topicRefs: [{ topicId: 'other', revision: 1 }] }] })).reason, 'task_association_unresolved')
  assert.equal(unrelated.calls.length, 0)
})

test('复杂请求显式转交，过期CAS结果不产生第二出口', async () => {
  const complex = setup({ kind: 'handoff', reason: '请求包含新执行授权' })
  assert.equal((await complex.handler.handle(request())).reason, '请求包含新执行授权')
  assert.equal(complex.commits.length, 0)
  const stale = setup(reply, { commit: async () => ({ status: 'stale' }) })
  assert.equal((await stale.handler.handle(request())).reason, 'snapshot_changed')
})

test('工具流、Provider失败和超时均转交且不提交', async () => {
  for (const llm of [
    { async *stream() { yield { type: 'tool-call-delta', name: 'pwsh' } } },
    { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'overloaded' } } } } },
    { async *stream() { await new Promise((resolve) => setTimeout(resolve, 30)) } },
  ]) {
    const { handler, commits } = setup(reply, { llm, timeoutMs: 5 })
    assert.equal((await handler.handle(request())).kind, 'handoff')
    assert.equal(commits.length, 0)
  }
})

test('诊断区分输出截断和Provider错误，仅记录无敏感字段', async () => {
  for (const reason of [{ kind: 'max-tokens' }, { kind: 'error', failure: { code: 'OVERLOADED', status: 503, message: 'sensitive provider response' } }]) {
    const { handler, events } = setup(reply, { llm: { async *stream() { yield { type: 'finish', reason } } } })
    assert.equal((await handler.handle(request())).reason, 'model_incomplete')
    assert.equal(events.at(-1).modelFinish.kind, reason.kind)
    assert.equal(JSON.stringify(events).includes('sensitive provider response'), false)
  }
})

test('短请求只执行一次原生Provider重试策略，复用输入身份并累计usage', async () => {
  const calls = []
  const policy = { mode: 'normal', maxRetries: 2, retryableCodes: ['OVERLOADED'], initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 }
  const llm = { stream() { throw new Error('must_use_prepared_registration') }, async prepareCall(config) { return { config, retryPolicy: policy, async *stream(args) {
    calls.push(args)
    if (calls.length === 1) {
      yield { type: 'text-delta', text: '未完成的JSON片段' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'OVERLOADED', status: 503 } } }
    } else {
      yield { type: 'text-delta', text: JSON.stringify(reply) }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } } } }
  const { handler, events, commits } = setup(reply, { llm })
  assert.equal((await handler.handle(request())).kind, 'reply')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].messages[0].id, calls[1].messages[0].id)
  assert.equal(events.filter(event => event.type === 'status-query/retry').length, 1)
  assert.equal(events.at(-1).usage.inputTokens, 12)
  assert.equal(events.at(-1).attempts, 2)
  assert.equal(commits.length, 1)
})

test('Provider不可重试/重试耗尽/超出总预算不产生无界请求', async () => {
  for (const [mode, code, maxRetries, initialDelayMs, expectedCalls] of [['normal', 'AUTH_INVALID', 2, 1, 1], ['normal', 'OVERLOADED', 2, 1, 3], ['always', 'OVERLOADED', 2, 100, 1]]) {
    let calls = 0
    const llm = { stream() {}, async prepareCall(config) { return { config, retryPolicy: { mode, maxRetries, retryableCodes: ['OVERLOADED'], initialDelayMs, maxDelayMs: 100, jitterRatio: 0 }, async *stream() { calls++; yield { type: 'finish', reason: { kind: 'error', failure: { code } } } } } } }
    const { handler, commits } = setup(reply, { llm, timeoutMs: 50 })
    assert.equal((await handler.handle(request())).kind, 'handoff')
    assert.equal(calls, expectedCalls)
    assert.equal(commits.length, 0)
  }
})

test('配置解算占用同一总预算，不能在超时后才启动首个模型调用', async () => {
  const { handler, calls } = setup(reply, { timeoutMs: 5, modelConfig: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { provider: 'same-provider', model: 'same-model' } } })
  assert.equal((await handler.handle(request())).reason, 'model_timeout')
  assert.equal(calls.length, 0)
})

test('同群并发只允许一个模型请求；候选必须完整审阅且不能编造引用', async () => {
  let release
  const llm = { async *stream() { await new Promise((resolve) => { release = resolve }); yield { type: 'text-delta', text: JSON.stringify(reply) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const { handler } = setup(reply, { llm })
  const pending = handler.handle(request())
  assert.equal((await handler.handle({ ...request(), requestId: 'query-2' })).reason, 'group_query_in_flight')
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await pending
  const { handler: candidates, commits } = setup()
  assert.equal((await candidates.handle({ ...request(), replyCandidates: [{ outboundId: 'o1', reply: '旧状态' }] })).reason, 'reply_review_incomplete')
  assert.equal(commits.length, 0)
})
