import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { available, reason, nativeTaskHost, latestInput, nativeShell, waitUntil, contextReadResponse, topicSummaryResponse } from './fixtures/task-session-native-host.js'
const test = (name, fn, options = {}) => testRunner(name, { timeout: 30000, ...options, ...(!available ? { skip: reason } : {}) }, fn)
const call = (name, args) => ({ name, args })
const decide = action => call('task_session_submit', { decision: { action, summary: 'Original goal', evidence: [], limitations: [] } })
const submit = call('execution_submit', { output: { status: 'completed', summary: 'Original goal done', evidence: ['Original operation retained'], limitations: [], artifacts: ['effect.txt'] } })
const overloaded = { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: {"httpStatus":200}]' }
async function host(root, { initialize = true, fault = true, allowUnrelated = false, persistent = false, humanFlow = false, recoverAfterCold = false, providerError = overloaded, reviewWait = false, revisedReview = false } = {}) {
  let executionSteps = 0, sequence = 0, humanAttempts = 0
  const requests = []
  const h = await nativeTaskHost(root, async () => [], { initialize, agentConfig: { provider: 'execution-recovery-fixture' },
    serviceFactory: async options => {
      class Provider extends LlmAdapter {
        async *stream(request) {
          if (yield* topicSummaryResponse(request, h.auxiliaryRequests)) return
          if (yield* contextReadResponse(request)) return
          requests.push(structuredClone(request))
          let calls
          if (request.tools.some(tool => tool.name === 'task_delegate')) {
            const input = latestInput(request)
            if (revisedReview && input.wakes?.some(wake => wake.kind === 'execution.provider.review')) {
              const review = input.wakes.find(wake => wake.kind === 'execution.provider.review')
              assert.equal(review.payload.requirementRevision, 2)
              assert.equal(review.payload.executionRequirementRevision, 1)
              assert.ok(Date.parse(review.payload.reviewedAt) >= Date.parse(review.payload.retryNotBefore))
            }
            const answered = input.task.humanRequests?.find(request => request.status === 'answered')
            if (humanFlow && answered) {
              const response = input.sources.find(source => source.sourceId === answered.sourceId)
              assert.ok(response, 'Read the authenticated answer source bound to this human request')
              assert.match(response.text, /UAT3/)
            }
            calls = persistent && input.wakes?.some(wake => wake.kind === 'execution.provider.review' || wake.kind === 'provider.evidence.available')
              ? reviewWait ? [decide('wait')] : [call('task_delegate', { key: 'cold-' + input.executions[0].inputVersion, executionId: input.executions[0].executionId, objective: 'Write exactly once and verify' }), decide('wait')]
              : humanFlow && answered && input.executions[0]?.inputVersion === 1
              ? [call('task_delegate', { key: 'answered-target', executionId: input.executions[0].executionId, objective: 'Authenticated UAT3 target' }), decide('wait')]
              : humanFlow && input.executions.some(e => e.result?.recovery?.decision === 'scheduled') && !input.task.humanRequests?.length
                ? [call('task_request_human', { reason: 'Target must be supplied', question: 'Which target?', audience: 'requester', evidence: [], attemptedActions: ['Read business request'] })]
              : !input.executions.length ? [call('task_delegate', { key: 'original', objective: 'Write exactly once and verify' }), decide('wait')]
              : persistent && input.executions.some(e => e.result?.recovery?.decision === 'exhausted') && humanAttempts++ === 0
                ? [call('task_request_human', { reason: 'Bounded native provider recovery exhausted', question: 'Investigate original provider or transport failure using retained diagnostics', audience: 'operator', evidence: ['Native error, three managed recovery attempts'], attemptedActions: ['Same session bounded backoff'] })]
                : [decide(input.executions.every(e => e.status === 'succeeded') ? 'complete' : 'wait')]
          } else {
            const step = executionSteps++
            if (fault && (step === 1 || persistent && step > 1 && !(recoverAfterCold && step >= 5))) { yield { type: 'finish', reason: { kind: 'error', failure: providerError } }; return }
            calls = fault && step === 0 ? [call(nativeShell, { command: nativeShell === 'pwsh' ? "Add-Content effect.txt 'once'" : "printf 'once\\n' >> effect.txt", description: 'One authorized effect' })] : [submit]
            if (humanFlow && step > 1) assert.equal(latestInput(request).objective, 'Authenticated UAT3 target')
            if (!allowUnrelated && !humanFlow && !persistent && (!fault || step > 1)) {
              assert.match(JSON.stringify(request), /provider-recovery/)
              assert.match(JSON.stringify(request), /Original operation retained|once/)
            }
          }
          for (const [index, tool] of calls.entries()) {
            const id = `recovery-call-${++sequence}`, args = JSON.stringify(tool.args)
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: tool.name, argumentsDelta: args }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: tool.name, arguments: args } }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
      }
      options.ctx.llm.registerAdapter(['execution-recovery-fixture'], new Provider())
      return openTaskSessionService(options)
    } })
  return Object.assign(h, { requests })
}
for (const restart of [false, true]) test(`native provider failure resumes original executor after persisted backoff; successful write never replays: restart=${restart}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-provider-recovery-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  let h = await host(root); hosts.push(h)
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'provider', objective: 'Original task' })
  await h.service.whenIdle()
  const first = (await h.query('execution.list'))[0]
  assert.equal(first.status, 'queued'); assert.equal(first.drained, true)
  assert.equal(first.providerRecovery.attempts, 1)
  assert.equal(first.result.payload.error.providerError.code, 'PI_AI_ERROR')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests?.length ?? 0, 0)
  if (restart) {
    await h.close(); h = await host(root, { initialize: false, fault: false }); hosts.push(h)
    await h.service.recover()
  }
  // 十秒只约束定时恢复准入；实际模型读取和执行由原生排空等待，仍受用例总时限约束。
  await waitUntil(async () => (await h.query('execution.list'))[0]?.inputVersion === 2, 'bounded native provider recovery admission', 10000)
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  const final = (await h.query('execution.list'))[0]
  assert.equal(final.executionId, first.executionId); assert.equal(final.sessionId, first.sessionId)
  assert.equal(final.inputVersion, 2); assert.equal(final.status, 'succeeded')
  assert.equal(final.results.length, 1); assert.equal(final.results[0].payload.error.code, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
  const operations = await h.query('operation.list')
  assert.equal(operations.length, 1); assert.equal(operations[0].state, 'succeeded')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests?.length ?? 0, 0)
})

test('one unreadable provider terminal stops only its recovery and unrelated native task still completes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-provider-isolation-'))
  const h = await host(root, { allowUnrelated: true })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'bad-proof', objective: 'Original task' })
  await h.service.whenIdle()
  const execution = (await h.query('execution.list'))[0]
  const persistence = h.ctx.sessionPersistence, originalOpen = persistence.open.bind(persistence)
  persistence.open = (sessionId, mode, ...args) => {
    if (sessionId === execution.sessionId && mode === 'read') throw Object.assign(new Error('Injected terminal evidence unavailable'), { code: 'TEST_TERMINAL_READ_FAILED' })
    return originalOpen(sessionId, mode, ...args)
  }
  const unrelated = await h.service.createTask({ groupId: 'native-group', requestId: 'unrelated', objective: 'Other task' })
  await h.service.whenIdle()
  await waitUntil(async () => (await h.query('execution.get', { executionId: execution.executionId })).providerRecovery?.blocked, 'visible recovery proof failure')
  await h.service.whenIdle()
  const blocked = await h.query('execution.get', { executionId: execution.executionId })
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.providerRecovery.nextAttemptAt, null)
  assert.equal(blocked.result.payload.error.code, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal(blocked.result.recovery.decision, 'blocked')
  assert.equal(blocked.providerRecovery.blocked.code, 'TEST_TERMINAL_READ_FAILED')
  assert.equal(blocked.inputVersion, 1)
  assert.equal((await h.query('task.get', { taskId: unrelated.taskId })).status, 'completed')
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
})

for (const recoverAfterCold of [false, true]) test(`provider short budget exhaustion remains technical wait; bounded cold owner review resumes safely: recovered=${recoverAfterCold}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'native-provider-exhausted-'))
  const h = await host(root, { persistent: true, recoverAfterCold })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'persistent', objective: 'Original task' })
  await h.service.whenIdle()
  const first = (await h.query('execution.list'))[0]
  for (let attempt = 1; attempt <= 3; attempt++) {
    const execution = (await h.query('execution.list'))[0]
    assert.equal(execution.providerRecovery.attempts, attempt)
    assert.equal(execution.inputVersion, attempt)
    t.mock.timers.setTime(Date.parse(execution.providerRecovery.nextAttemptAt) + 1)
    await h.service.recover(); await h.service.whenIdle()
  }
  let execution = (await h.query('execution.list'))[0]
  assert.equal(execution.providerRecovery.exhausted, true); assert.equal(execution.providerRecovery.attempts, 3)
  assert.equal(execution.inputVersion, 4); assert.equal(execution.status, 'failed')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  assert.match(JSON.stringify(h.requests), /DYNAMIC_PROVIDER_TECHNICAL_WAIT/)
  const beforeCooldown = h.requests.length
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, beforeCooldown)
  for (let cold = 1; cold <= (recoverAfterCold ? 1 : 3); cold++) {
    execution = (await h.query('execution.list'))[0]
    assert.ok(execution.providerRecovery.nextReviewAt)
    t.mock.timers.setTime(Date.parse(execution.providerRecovery.nextReviewAt) + 1)
    await h.service.recover(); await h.service.whenIdle()
    execution = (await h.query('execution.list'))[0]
    assert.equal(execution.inputVersion, 4 + cold)
    assert.equal(execution.sessionId, first.sessionId)
    if (!recoverAfterCold) { assert.equal(execution.providerRecovery.attempts, 3); assert.equal(execution.providerRecovery.coldAttempts, cold) }
    assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  }
  if (recoverAfterCold) {
    assert.equal(execution.status, 'succeeded'); assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  } else {
    assert.equal(execution.providerRecovery.nextReviewAt, null)
    const count = h.requests.length
    for (let tick = 0; tick < 4; tick++) { t.mock.timers.setTime(Date.now() + 3600000); await h.service.recover(); await h.service.whenIdle() }
    assert.equal(h.requests.length, count)
    // A later real event may ask the successful owner to evaluate availability;
    // this does not reset the short budget or create an autonomous retry loop.
    await h.service.store.command({ id: 'new-provider-evidence', kind: 'task.wake', args: { taskId: task.taskId, kind: 'provider.evidence.available', payload: { observed: true } } })
    await h.service.recover(); await h.service.whenIdle()
    execution = (await h.query('execution.list'))[0]
    assert.equal(execution.providerRecovery.attempts, 3); assert.equal(execution.providerRecovery.coldAttempts, 4)
    assert.equal(execution.providerRecovery.nextReviewAt, null)
  }
  assert.equal((await h.query('operation.list')).length, 1)
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
  // 未恢复分支完整运行三次冷审阅及后续真实事件，新增原生引用读取也计入墙钟预算。
}, { timeout: recoverAfterCold ? 30000 : 60000 })

test('business human answer replaces pending provider recovery input before any original session resumes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'native-provider-human-target-'))
  const h = await host(root, { humanFlow: true })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'human-target', objective: 'Original task' })
  await h.service.whenIdle()
  const first = (await h.query('execution.list'))[0]
  await h.service.store.command({ id: 'business-target-wake', kind: 'task.wake', args: { taskId: task.taskId, kind: 'business.target.required', payload: {} } })
  await h.service.recover(); await h.service.whenIdle()
  const waiting = await h.query('task.get', { taskId: task.taskId })
  assert.equal(waiting.humanRequests.length, 1); assert.equal(waiting.humanRequests[0].audience, 'requester')
  t.mock.timers.setTime(Date.parse(first.providerRecovery.nextAttemptAt) + 1)
  await h.service.respondHumanRequest({ taskId: task.taskId, humanRequestId: waiting.humanRequests[0].requestId, requestId: 'actual-target',
    expectedRequirementRevision: 1, expectedControlRevision: 1, reply: 'Only use UAT3 target' })
  await h.service.whenIdle()
  const execution = (await h.query('execution.list'))[0]
  assert.equal(execution.sessionId, first.sessionId); assert.equal(execution.executionId, first.executionId)
  assert.equal(execution.inputVersion, 2); assert.equal(execution.input.objective, 'Authenticated UAT3 target')
  assert.equal(execution.status, 'succeeded')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal((await h.query('operation.list')).length, 1)
})

test('anonymous field v12 error restores original execution with complete diagnostics and no human request or duplicate effect', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { fieldV12Error } = await import('./fixtures/execution-provider-field-sample.js')
  const root = await mkdtemp(join(tmpdir(), 'native-field-v12-'))
  const h = await host(root, { providerError: fieldV12Error })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'field-v12', objective: 'Original task' })
  await h.service.whenIdle()
  const before = (await h.query('execution.list'))[0]
  assert.deepEqual(before.result.payload.error.providerError, fieldV12Error)
  assert.equal(before.result.payload.output, null); assert.equal(before.result.payload.error.phase, 'provider')
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextAttemptAt) + 1)
  await h.service.recover(); await h.service.whenIdle()
  const after = (await h.query('execution.list'))[0]
  assert.equal(after.sessionId, before.sessionId); assert.equal(after.executionId, before.executionId)
  assert.equal(after.status, 'succeeded'); assert.deepEqual(after.results[0].payload.error.providerError, fieldV12Error)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  assert.equal((await h.query('operation.list')).length, 1)
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
})

test('requirement supplement during provider cooldown wakes current owner after restart and resumes original executor once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'native-review-revised-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  let h = await host(root, { persistent: true, recoverAfterCold: true, revisedReview: true }); hosts.push(h)
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'review-revised', objective: 'Original task' })
  await h.service.whenIdle()
  for (let fast = 0; fast < 3; fast++) {
    const e = (await h.query('execution.list'))[0]
    t.mock.timers.setTime(Date.parse(e.providerRecovery.nextAttemptAt) + 1)
    await h.service.recover(); await h.service.whenIdle()
  }
  const first = (await h.query('execution.list'))[0]
  await h.service.appendTaskContext({ taskId: task.taskId, requestId: 'network-restored', context: 'Network restored; retain original scope', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).requirementRevision, 2)
  assert.equal((await h.query('execution.list'))[0].inputVersion, first.inputVersion)
  await h.close(); h = await host(root, { initialize: false, persistent: true, fault: false, revisedReview: true }); hosts.push(h)
  t.mock.timers.setTime(Date.parse(first.providerRecovery.nextReviewAt) + 1)
  await h.service.recover(); await h.service.whenIdle()
  const after = (await h.query('execution.list'))[0]
  assert.equal(after.sessionId, first.sessionId); assert.equal(after.executionId, first.executionId)
  assert.equal(after.requirementRevision, 2); assert.equal(after.inputVersion, first.inputVersion + 1)
  assert.equal(first.providerRecovery.attempts, 3)
  assert.equal(after.providerRecovery, null, 'Successful completion closes recovery without altering retained failures')
  assert.equal(after.status, 'succeeded')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal((await h.query('operation.list')).length, 1)
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
})

test('owner may honestly wait at each bounded provider review; all three reviews survive restart without replay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'native-review-wait-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  let h = await host(root, { persistent: true, reviewWait: true }); hosts.push(h)
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'review-wait', objective: 'Original task' })
  await h.service.whenIdle()
  for (let fast = 0; fast < 3; fast++) {
    const e = (await h.query('execution.list'))[0]
    t.mock.timers.setTime(Date.parse(e.providerRecovery.nextAttemptAt) + 1)
    await h.service.recover(); await h.service.whenIdle()
  }
  const first = (await h.query('execution.list'))[0]
  await h.close(); h = await host(root, { initialize: false, persistent: true, reviewWait: true, fault: false }); hosts.push(h)
  await h.service.recover(); await h.service.whenIdle()
  for (let review = 1; review <= 3; review++) {
    const e = (await h.query('execution.list'))[0]
    assert.ok(e.providerRecovery.nextReviewAt)
    t.mock.timers.setTime(Date.parse(e.providerRecovery.nextReviewAt) + 1)
    await h.service.recover(); await h.service.whenIdle()
    const after = (await h.query('execution.list'))[0]
    assert.equal(after.providerRecovery.reviewAttempts, review)
    assert.equal(after.providerRecovery.coldAttempts, 0)
    assert.equal(after.inputVersion, first.inputVersion); assert.equal(after.leaseEpoch, first.leaseEpoch)
    assert.equal(after.sessionId, first.sessionId)
  }
  const count = h.requests.length
  t.mock.timers.setTime(Date.now() + 3600000)
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, count)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  assert.equal((await h.query('operation.list')).length, 1)
})
