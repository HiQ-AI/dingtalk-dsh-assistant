import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { available, reason, nativeTaskHost } from './fixtures/task-session-native-host.js'
import { sessionPersistenceFixture } from './fixtures/session-persistence.js'
import { restartScopeProbePlan, readRestartScopeProbe, restartScopeProbeToolName } from '../packages/dingtalk-dsh-assistant/native-restart-scope-probe.js'
import { isolationDigest as hash } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { createExecutionSessions } from '../packages/dingtalk-dsh-assistant/execution-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { readNativeOperationContext } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const skip = process.platform !== 'win32' ? 'Windows native pwsh required' : !available ? reason : false

// 全部保留物均为新建夹具；运行的只是生产只读探针，不启动 PostgreSQL / Maven，不读取历史业务账本。
async function fixturePlan(root, observedExit = false, wrapper = false) {
 const startedAt = Date.now() - 60000, dshHome = join(root, 'synthetic-host')
 const script = join(root, 'tasks', 'probe-task', 'work', 'run-postgres.ps1')
 const source = wrapper ? join(dirname(script), 'postgres', 'data') : join(root, 'retained-source'), hostLogPath = join(root, 'host.oom.log')
 await mkdir(source, { recursive: true })
 await writeFile(join(source, 'postmaster.pid'), `900002\n${source}\n0\n${wrapper ? 25428 : 25429}\n`)
 const log = observedExit ? 'Host started; no exit cause was recorded.' : '[900001:0] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
 await writeFile(hostLogPath, log)
 if (observedExit) await utimes(hostLogPath, new Date(startedAt - 10000), new Date(startedAt - 10000))
 const scopeEvidence = { hostPid: 900001, hostLogPath, hostLogSha256: digest(log),
  ...(observedExit ? { hostExit: { observedAt: new Date().toISOString(), evidenceRef: 'fixture-original-host-exit-observation' } } : {}),
  producerScopeReviewed: true, localEffectsOnlyConfirmed: true, excludeOriginalSourcesConfirmed: true }
 if (wrapper) {
  const content = await readFile(new URL('./fixtures/restart-postgres-wrapper.ps1', import.meta.url))
  await writeFile(script, content); await writeFile(join(dirname(source), 'owner.txt'), 'synthetic-task-owner')
  await writeFile(join(source, 'postmaster.opts'), `"D:/soft/PostgreSQL/16/bin/postgres.exe" "-D" "${source}" "-h" "127.0.0.1" "-p" "25428" "-c" "logging_collector=off"`)
  await writeFile(join(source, 'postgresql.conf'), '# no external dependencies\n'); await writeFile(join(source, 'postgresql.auto.conf'), '# no overrides\n')
  scopeEvidence.postgresWrapper = { scriptSha256: digest(content), historicalEvidenceRef: 'fixture-retained-original-script', pgBin: 'D:\\soft\\PostgreSQL\\16\\bin', port: 25428, ownerText: 'synthetic-task-owner' }
 }
 const binding = { operationId: 'original-operation', operationDigest: 'a'.repeat(64), taskId: 'probe-task', executionId: 'original',
  sessionId: 'original-session', jobId: 'original-job', startedAt, callId: 'original-call', argumentsDigest: 'b'.repeat(64) }
 const plan = restartScopeProbePlan({ command: wrapper ? `pwsh -NoProfile -File "${script}" -Action serve` : `& D:\\fixture\\postgres.exe -D ${source} -h 127.0.0.1 -p 25429`, binding, evidence: scopeEvidence, dshHome, workspaceRoot: root })
 assert.ok(plan)
 const profileRoot = dirname(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? 'D:/dsh_home/profiles/web/package.json'))
 for (const file of plan.spec.providerFiles) {
  const relative = file.path.slice(join(dshHome, 'profiles', 'web').length + 1)
  const bytes = await readFile(join(profileRoot, relative))
  assert.equal(digest(bytes), file.sha256, 'Fixture must use the currently reviewed provider bytes')
  await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, bytes)
  await utimes(file.path, new Date(startedAt - 10000), new Date(startedAt - 10000))
 }
 return { plan, scopeEvidence, operation: { operationId: binding.operationId, taskId: binding.taskId, job: { startedAt } } }
}

for (const [observedExit, wrapper] of [[false, false], [true, false], [true, true]]) test(`managed probe passes authoritative LF-preserving bytes through real native pwsh, jobs, persistence and strict reader: ${wrapper ? 'retained PG wrapper' : observedExit ? 'observed exit' : 'OOM'}`, { skip, timeout: 60000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'native-scope-runner-'))
 const { plan, scopeEvidence, operation } = await fixturePlan(root, observedExit, wrapper)
 const args = { expectedOperationDigest: plan.spec.binding.operationDigest, expectedScriptDigest: plan.scriptDigest, scopeEvidence }
 let step = 0
 const h = await nativeTaskHost(root, async () => ++step === 1 ? [{ name: restartScopeProbeToolName, args }]
  : [{ name: 'execution_submit', args: { output: { answer: 'probe finished' } } }], { resident: true, promoteOnTimeout: true })
 const binding = { kind: 'task-execution', taskId: operation.taskId, executionId: 'probe-execution', sessionId: 'probe-session',
  requirementRevision: 1, controlRevision: 1, inputVersion: 1, inputHistory: [], inputDigest: 'probe-input', leaseEpoch: 1, sessionBound: false }
 const phases = []
 const manager = createExecutionSessions({ ctx: h.ctx, isCurrent: async () => true,
  getWorkspaceDir: async () => join(root, 'tasks', binding.taskId), contentRoot: join(root, 'content') })
 t.after(async () => { await manager.close(); await h.close(); assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) })
 await mkdir(join(root, 'tasks', binding.taskId), { recursive: true })
 const result = await manager.run({ binding, input: { task: { taskId: binding.taskId }, readbackOperationId: operation.operationId },
  definition: { provider: 'native-task-test', model: 'controlled', prompt: 'Run the bound read-only probe then submit.', nativeTools: true,
   recoveryReadOnly: true, allowedTools: [], outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
  onSessionBound: async () => {}, onResult: async () => {}, readRestartScopeProbePlan: async received => { assert.deepEqual(received, args); return plan },
  onNativeExecution: async event => { phases.push(structuredClone(event)); return {} },
 })
 assert.equal(result.status, 'submitted', JSON.stringify(result))
 const events = (await inspectSession(h.ctx.sessionPersistence, binding.sessionId)).events
 const outer = events.find(event => event.type === 'tool/call' && event.data.name === restartScopeProbeToolName)
 const nativeCall = phases.find(event => event.phase === 'started' && event.toolName === 'pwsh')
 assert.ok(nativeCall, JSON.stringify(h.toolResults))
 assert.equal(plan.command.at(-1), '\n')
 assert.ok(plan.command.length > 6000)
 assert.equal(nativeCall.arguments.command, plan.command)
 assert.equal(nativeCall.callId, `${outer.data.callId}:restart-scope`)
 assert.ok(events.some(event => event.type === 'job/registered' && event.data.toolCall.callId === nativeCall.callId))
 assert.ok(phases.some(event => event.phase === 'settled' && event.callId === nativeCall.callId))
 assert.ok(!phases.some(event => event.toolName === restartScopeProbeToolName), 'Composite must not create a second operation for the same native call')
 const readback = { ...binding, status: 'succeeded', drained: true, recovering: false, definition: { recoveryReadOnly: true }, input: { readbackOperationId: operation.operationId } }
 const request = { ctx: h.ctx, plan, operation, evidence: { ...scopeEvidence, probeExecutionId: binding.executionId, probeCallId: nativeCall.callId }, executions: [readback] }
 assert.ok(await readRestartScopeProbe(request), JSON.stringify({ events: events.filter(e => /tool\/|job\//u.test(e.type)), results: h.toolResults }))
 const changeResult = (list, change) => {
  const message = list.find(e => e.type === 'tool/result' && e.data.message?.toolCallId === outer.data.callId).data.message
  const value = JSON.parse(message.content[0].text); change(value); message.content[0].text = JSON.stringify(value)
 }
 // 从真实日志拷贝做反例；不篡改真实持久 Session。任何一环缺失或命令归一化都不能取得审计凭证。
 for (const [name, alter] of Object.entries({
  'missing LF': list => changeResult(list, value => { value.nativeArguments.command = plan.command.slice(0, -1) }),
  'CRLF rewrite': list => changeResult(list, value => { value.nativeArguments.command = plan.command.replaceAll('\n', '\r\n') }),
  'missing child result': list => changeResult(list, value => { delete value.nativeResult }),
  'missing operation observation': list => changeResult(list, value => { delete value.operationObservation }),
  'cancelled operation observation': list => changeResult(list, value => { value.operationObservation.cancelled = true }),
  'missing outer result': list => list.splice(list.findIndex(e => e.type === 'tool/result' && e.data.message?.toolCallId === outer.data.callId), 1),
  'wrong parent': list => { list.find(e => e.type === 'job/registered').data.toolCall.rootCallId = 'other' },
  'duplicate jobs': list => { list.push(structuredClone(list.find(e => e.type === 'job/registered'))) },
  'not producer settled': list => { list.find(e => e.type === 'job/settled').data.producerReported = false },
 })) {
  const tampered = structuredClone(events); alter(tampered)
  const ctx = { agents: { get: () => undefined }, sessions: { get: () => undefined },
   sessionPersistence: sessionPersistenceFixture(async () => ({ meta: { id: binding.sessionId }, events: tampered })) }
  assert.equal(await readRestartScopeProbe({ ...request, ctx }), null, name)
 }
 assert.equal(hash({ command: nativeCall.arguments.command }), plan.scriptDigest)
})

test('managed native entry rejects tampering and policy denial; a failed real producer stays failed and its original call remains readable', { skip, timeout: 60000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'native-scope-denied-'))
 t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) })
 const { plan, scopeEvidence, operation } = await fixturePlan(root)
 for (const mode of ['changed-bytes', 'stale-digest', 'command-injection', 'native-guard', 'native-execution-denied', 'post-policy-block', 'failed-native', 'failed-native-post-block']) {
  const working = join(root, mode); await mkdir(working, { recursive: true })
  const args = { expectedOperationDigest: plan.spec.binding.operationDigest, expectedScriptDigest: plan.scriptDigest, scopeEvidence }
  if (mode === 'stale-digest') args.expectedScriptDigest = 'f'.repeat(64)
  if (mode === 'command-injection') args.command = 'Write-Output untrusted'
  if (mode === 'failed-native') await rm(plan.spec.hostLogPath)
  let step = 0, read = 0, denied = 0
  const h = await nativeTaskHost(working, async () => ++step === 1 ? [{ name: restartScopeProbeToolName, args }]
   : [{ name: 'execution_submit', args: { output: { answer: 'rejected; original effect unchanged' } } }], { resident: true, promoteOnTimeout: true })
  if (mode === 'native-guard') h.ctx.tools.guard(exec => { if (exec.name === 'pwsh') { denied++; return 'probe_denied_by_native_guard' } })
  if (mode === 'native-execution-denied') h.ctx.on('tools/execute', (exec, next) => { if (exec.name === 'pwsh') throw Error('probe_denied_at_native_dispatch'); return next() })
  if (['post-policy-block', 'failed-native-post-block'].includes(mode)) h.ctx.on('tools/post-execute', async (exec, result, next) => {
   const decision = await next()
   return exec.name === 'pwsh' ? { kind: 'block', feedback: [{ type: 'text', text: 'probe_denied_after_native_completion' }] } : decision
  })
  const phases = []
  const binding = { kind: 'task-execution', taskId: operation.taskId, executionId: 'denied-probe', sessionId: 'denied-session',
   requirementRevision: 1, controlRevision: 1, inputVersion: 1, inputHistory: [], inputDigest: 'denied-input', leaseEpoch: 1, sessionBound: false }
  const cwd = join(working, 'tasks', binding.taskId); await mkdir(cwd, { recursive: true })
  const manager = createExecutionSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd, contentRoot: join(working, 'content') })
  try {
   await manager.run({ binding, input: { task: { taskId: binding.taskId }, readbackOperationId: operation.operationId },
    definition: { provider: 'native-task-test', model: 'controlled', prompt: 'Run the bound probe.', nativeTools: true, recoveryReadOnly: true,
     allowedTools: [], outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
    onSessionBound: async () => {}, onResult: async () => {}, onNativeExecution: async event => { phases.push(event); return {} },
    readRestartScopeProbePlan: async () => { read++; return mode === 'changed-bytes' ? { ...plan, command: plan.command.trimEnd() } : plan },
   })
   assert.equal(h.toolResults.find(item => item.name === restartScopeProbeToolName)?.result.isError, true, mode)
   const events = (await inspectSession(h.ctx.sessionPersistence, binding.sessionId)).events
   if (['failed-native', 'post-policy-block', 'failed-native-post-block'].includes(mode)) {
    const original = phases.find(event => event.phase === 'started' && event.toolName === 'pwsh')
    const settled = phases.find(event => event.phase === 'settled' && event.callId === original?.callId)
    assert.ok(settled, h.toolResults.map(item => `${item.name}: ${item.result.isError}`).join('; '))
    assert.equal(events.find(event => event.type === 'job/settled').data.detail, mode.startsWith('failed-native') ? 'exit code: 1' : 'exit code: 0')
    const failedOperation = { operationId: 'failed-probe-operation', taskId: binding.taskId, executionId: binding.executionId,
     dispatchBinding: binding, key: `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${original.callId}`,
     state: settled.result.isError ? 'unknown' : 'succeeded', definition: { toolName: 'pwsh', argumentsDigest: hash(original.arguments) },
     result: { callId: original.callId, toolName: 'pwsh', isError: settled.result.isError, resultDigest: hash(settled.result.content) } }
    const context = await readNativeOperationContext({ ctx: h.ctx, operation: failedOperation })
    assert.ok(context, 'Failed managed child must remain readable using its original operation identity')
    assert.equal(context.operationId, failedOperation.operationId)
    assert.equal(context.arguments.command, plan.command)
    assert.equal(context.result.isError, settled.result.isError, 'Preserve native tool outcome independently from failed process outcome')
    if (['post-policy-block', 'failed-native-post-block'].includes(mode)) {
     assert.equal(context.finalPolicyResult.isError, true)
     assert.equal(hash(context.result.content), failedOperation.result.resultDigest)
     assert.notEqual(hash(context.finalPolicyResult.content), failedOperation.result.resultDigest)
     const readback = { ...binding, status: 'succeeded', drained: true, recovering: false,
      definition: { recoveryReadOnly: true }, input: { readbackOperationId: operation.operationId } }
     assert.equal(await readRestartScopeProbe({ ctx: h.ctx, plan, operation,
      evidence: { ...scopeEvidence, probeExecutionId: binding.executionId, probeCallId: original.callId }, executions: [readback] }), null)
    }
    assert.equal(failedOperation.state, settled.result.isError ? 'unknown' : 'succeeded')
    assert.equal(failedOperation.result.callId, original.callId)
   } else {
    assert.ok(!phases.some(event => event.phase === 'started' && event.toolName === 'pwsh'), mode)
    assert.ok(!events.some(event => event.type === 'job/registered'), mode)
   }
   if (mode === 'command-injection') assert.equal(read, 0)
   if (mode === 'native-guard') assert.equal(denied, 1)
  } finally { await manager.close(); await h.close() }
 }
})
