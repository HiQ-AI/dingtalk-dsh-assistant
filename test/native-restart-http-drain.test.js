import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { createExecutionSessions } from '../packages/dingtalk-dsh-assistant/execution-session.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { isolationDigest as hash, isolationBinding, readAuditedRestartDrain } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { restartFixture } from './fixtures/native-restart-isolation.js'
import { restartScopeProbePlan } from '../packages/dingtalk-dsh-assistant/native-restart-scope-probe.js'

const pg = String.raw`& D:\soft\PostgreSQL\16\bin\postgres.exe -D D:\agent\artifacts\isolated-pg -h 127.0.0.1 -p 25428`
const noop = async () => {}
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'restart-http-')), dbPath = join(root, 'control.sqlite')
 const options = { dbPath, instanceId: 'restart-http', webActorId: 'operator' }
 let store = await openDynamicTaskStore({ ...options, initialize: true }), sequence = 0
 const command = (kind, args, id = `fixture-${++sequence}`) => store.command({ id, kind, args })
 const query = (kind, args = {}) => store.query({ kind, ...args })
 await command('task.create', { taskId: 'task', groupId: 'g', ownerActorId: 'operator', request: 'Continue the original task' })
 const owner = (await command('task.claim', { taskId: 'task' })).result.binding
 const execution = (await command('execution.dispatch', { binding: owner, executionId: 'original', key: 'original', prompt: 'Original local operation', input: {} })).result.execution
 const binding = (await command('execution.claim', { executionId: execution.executionId })).result.binding
 await command('execution.sessionBound', { binding })
 const key = `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:original-call`
 await command('operation.prepare', { binding, operationId: 'operation', key, definition: { toolName: 'pwsh', argumentsDigest: hash({ command: pg }), effectClass: 'unknown' }, resourceKeys: ['local-source'] })
 await command('operation.start', { binding, operationId: 'operation' })
 await command('operation.job', { binding, operationId: 'operation', job: { jobId: 'pwsh-redacted-original', owner: binding.sessionId, startedAt: Date.now(), status: 'running' } })
 const investigated = (await command('execution.dispatch', { binding: owner, executionId: 'investigation', key: 'investigation', prompt: 'Read original effects',
  definition: { recoveryReadOnly: true }, input: { readbackOperationId: 'operation' } })).result.execution
 const readBinding = (await command('execution.claim', { executionId: investigated.executionId })).result.binding
 await command('execution.result', { binding: readBinding, output: { inspected: true } }); await command('execution.drained', { binding: readBinding })
 await command('execution.cancel', { binding })
 await command('task.wait', { binding: owner, action: 'blocked', summary: 'Unknown original result', question: 'Confirm bounded isolation',
  humanRequest: { requestId: 'human', audience: 'operator', reason: 'Host restart', attemptedActions: ['Original effects inspected'] } })
 await command('task.drained', { binding: owner })
 await store.close(); store = await openDynamicTaskStore(options)
 const operation = await query('operation.get', { operationId: 'operation' }), currentBinding = await query('execution.binding', { executionId: 'original' })
 const original = await query('execution.get', { executionId: 'original' }), readback = await query('execution.get', { executionId: 'investigation' })
 const facts = restartFixture(false, pg)
 Object.assign(facts.original[0].data.identity, currentBinding)
 Object.keys(facts.operation).forEach(key => delete facts.operation[key]); Object.assign(facts.operation, operation)
 Object.keys(facts.execution).forEach(key => delete facts.execution[key]); Object.assign(facts.execution, original)
 Object.keys(facts.readback).forEach(key => delete facts.readback[key]); Object.assign(facts.readback, readback)
 facts.readback.kind = 'task-execution'
 facts.original[3].data = { ...operation.job, kind: 'pwsh', label: pg, toolCall: { callId: 'original-call', rootCallId: 'original-call' } }
 facts.receipt.binding = isolationBinding(operation, 'original-call'); facts.receipt.observedAt = new Date().toISOString()
 const ctx = facts.ctx
 const driver = createExecutionSessions({ ctx, isCurrent: async () => true, readRestartDrainProof: args => readAuditedRestartDrain({ ctx, query, ...args }) })
 const service = await openTaskSessionService({ ctx, store, config: { ...options, workspaceDir: root, webActorId: 'operator' },
  legacy: { getGroup: () => undefined, getAgentConfig: () => ({ workspaceDir: root }) },
  residentStore: { listGroups: () => [], listTopics: () => [], getGroup: () => undefined }, persistence: { register: noop, close: noop },
  taskSessions: { close: noop, cancel: noop, run: async ({ submit }) => { await submit({ action: 'wait', summary: 'Unknown results retained', evidence: [], limitations: ['No replay'] }); return { status: 'submitted' } } },
  executionSessions: driver, notifications: { canDisclose: () => false } })
 const server = createServer((request, response) => handleRequest(request, response, { respondTaskHumanRequest: args => service.respondHumanRequest(args) }))
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
 const url = `http://127.0.0.1:${server.address().port}/tasks/task/human-requests/human/reply`
 const post = async (suffix, body, extraHeaders = {}) => {
  const response = await fetch(url + suffix, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
 }
 t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
 const body = { requestId: 'operator-isolation', reply: 'Confirm bounded source isolation; retain unknown and partial effects; no replay',
  expectedRequirementRevision: 1, expectedControlRevision: 1, nativeRestartResolutions: [{ operationId: 'operation', expectedOperationDigest: hash(operation) }] }
 return { root, store, service, facts, driver, binding: currentBinding, operation, command, query, post, body }
}

test('real HTTP/service/ledger check is zero-write; reply is digest-bound/idempotent; missing-result drain uses the same audit', async t => {
 const f = await fixture(t), before = structuredClone(f.facts.original)
 await assert.rejects(f.driver.recoverDrained({ binding: f.binding }), { code: 'execution_recovery_tool_unresolved' })
 const sourceCount = (await f.query('source.list')).length, wakeCount = (await f.query('wake.list')).length
 assert.equal((await f.post('/check', f.body, { origin: 'https://outside.invalid' })).status, 403)
 const checked = await f.post('/check', f.body)
 assert.equal(checked.status, 200, JSON.stringify(checked.body)); assert.equal(checked.body.writes, 0); assert.equal(checked.body.ready, true)
 assert.deepEqual(await f.query('operation.get', { operationId: 'operation' }), f.operation)
 assert.equal((await f.query('source.list')).length, sourceCount); assert.equal((await f.query('wake.list')).length, wakeCount)
 assert.notEqual((await f.post('', f.body)).status, 200, 'reply must confirm the exact isolation digest shown by check')
 const body = structuredClone(f.body); body.nativeRestartResolutions[0].expectedIsolationDigest = checked.body.restartResolutions[0].isolationDigest
 assert.equal((await f.post('', body)).status, 200)
 assert.equal((await f.post('', body)).status, 200)
 assert.notEqual((await f.post('', { ...body, reply: 'changed scope' })).status, 200)
 let audited = await f.query('operation.get', { operationId: 'operation' })
 assert.equal(audited.state, 'unknown'); assert.equal(audited.job.status, 'running'); assert.equal(audited.result, undefined)
 f.facts.jobs.push({ status: 'running' })
 await assert.rejects(f.driver.recoverDrained({ binding: f.binding }), { code: 'execution_recovery_tool_unresolved' })
 f.facts.jobs.pop(); f.facts.revoke()
 await assert.rejects(f.driver.recoverDrained({ binding: f.binding }), { code: 'execution_recovery_tool_unresolved' })
 f.facts.authority.verifyIsolation = async () => true
 f.facts.original.push({ seq: 9, type: 'tool/call', data: { callId: 'another-unresolved-call', name: 'pwsh', arguments: '{}' } })
 await assert.rejects(f.driver.recoverDrained({ binding: f.binding }), { code: 'execution_recovery_tool_unresolved' })
 f.facts.original.pop()
 const drained = await f.driver.recoverDrained({ binding: f.binding })
 assert.equal(drained.drained, true); assert.equal(drained.isolationAuditRefs.length, 1)
 assert.deepEqual(f.facts.original, before, 'recovery never appends a fabricated tool result')
 await f.command('execution.drained', { binding: f.binding, isolationAuditRefs: drained.isolationAuditRefs })
 const execution = await f.query('execution.get', { executionId: 'original' })
 assert.equal(execution.drained, true); assert.equal(execution.recovering, false); assert.equal(execution.result, undefined)
 assert.deepEqual(execution.recoveryDrainAudit.refs, drained.isolationAuditRefs)
 audited = await f.query('operation.get', { operationId: 'operation' }); assert.equal(audited.state, 'unknown'); assert.equal(audited.job.status, 'running')
})

test('formal check prepares the existing native read-only probe without requiring a new service or claiming ready', async t => {
 const f = await fixture(t), oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome })
 const get = f.facts.ctx.get; f.facts.ctx.get = name => name === 'nativeJobRecovery' ? undefined : get(name)
 f.body.nativeRestartResolutions[0].scopeEvidence = { hostPid: 96580, hostLogPath: 'D:\\approved\\host.oom.log', hostLogSha256: 'a'.repeat(64),
  producerScopeReviewed: true, localEffectsOnlyConfirmed: true, excludeOriginalSourcesConfirmed: true }
 const response = await f.post('/check', f.body)
 assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.writes, 0); assert.equal(response.body.ready, false)
 assert.equal(response.body.requiredScopeProbes.length, 1)
 assert.match(response.body.requiredScopeProbes[0].command, /Get-CimInstance Win32_Process -ErrorAction Stop/)
 assert.match(response.body.requiredScopeProbes[0].command, /Get-NetTCPConnection -ErrorAction Stop/)
 assert.notEqual((await f.post('', f.body)).status, 200)
 assert.deepEqual(await f.query('operation.get', { operationId: 'operation' }), f.operation)
 const hostExit = { observedAt: new Date().toISOString(), evidenceRef: 'retained-original-host-exit-observation' }
 f.body.nativeRestartResolutions[0].scopeEvidence.hostExit = hostExit
 const observedExit = await f.post('/check', f.body)
 assert.equal(observedExit.status, 200, JSON.stringify(observedExit.body)); assert.equal(observedExit.body.ready, false)
 const probe = observedExit.body.requiredScopeProbes[0]
 assert.deepEqual(probe.managedCall.arguments.scopeEvidence.hostExit, hostExit, 'the managed call must retain the exact reviewed exit evidence')
 assert.notEqual(probe.scriptDigest, response.body.requiredScopeProbes[0].scriptDigest)
 assert.deepEqual(await f.query('operation.get', { operationId: 'operation' }), f.operation)
 const evidence = f.body.nativeRestartResolutions[0].scopeEvidence
 const plan = restartScopeProbePlan({ command: pg, binding: isolationBinding(f.operation, 'original-call'), evidence })
 assert.equal(plan.command, probe.command)
 const observation = { schema: plan.spec.schema, specDigest: plan.specDigest, observedAt: new Date().toISOString(),
  hostFatal: false, hostLogVerified: true, hostExitObservedAt: hostExit.observedAt, providerContractVerified: true,
  originalHostCount: 0, originalHostChildCount: 0, legacySourceCount: 0, sourceWriterCount: 0, listeningCount: 0, originalArtifactsPreserved: true }
 const startedAt = Date.now(), original = JSON.stringify(f.facts.original)
 f.facts.reads.push(
  { seq: 4, type: 'tool/call', data: { callId: 'scope-probe', name: 'pwsh', arguments: JSON.stringify({ command: plan.command }) } },
  { seq: 5, type: 'job/registered', data: { jobId: 'scope-job', owner: f.facts.readback.sessionId, kind: 'pwsh', label: plan.command, startedAt, toolCall: { callId: 'scope-probe' } } },
  { seq: 6, type: 'job/settled', data: { jobId: 'scope-job', owner: f.facts.readback.sessionId, startedAt, status: 'completed', producerReported: true, detail: 'exit code: 0' } },
  { seq: 7, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'scope-probe', isError: false, content: [{ type: 'text', text: JSON.stringify(observation) }] } } })
 Object.assign(evidence, { probeExecutionId: f.facts.readback.executionId, probeCallId: 'scope-probe' })
 const checked = await f.post('/check', f.body)
 assert.equal(checked.status, 200, JSON.stringify(checked.body)); assert.equal(checked.body.ready, true)
 f.body.nativeRestartResolutions[0].expectedIsolationDigest = checked.body.restartResolutions[0].isolationDigest
 const applied = await f.post('', f.body)
 assert.equal(applied.status, 200, JSON.stringify(applied.body))
 assert.equal((await f.post('', f.body)).status, 200)
 const audited = await f.query('operation.get', { operationId: 'operation' })
 assert.equal(audited.state, 'unknown'); assert.equal(audited.job.status, 'running'); assert.equal(audited.result, undefined)
 assert.equal(audited.recoverySettlement.noReplay, true); assert.equal(audited.recoverySettlement.partialEffectsPossible, true)
 assert.equal(audited.recoverySettlement.proof.isolation.provenance.hostExit.cause, 'unknown')
 assert.equal(JSON.stringify(f.facts.original), original)
 f.body.nativeRestartResolutions[0].scopeEvidence.hostExit.observedAt = 'not-a-date'
 assert.equal((await f.post('/check', f.body)).status, 400)
})
