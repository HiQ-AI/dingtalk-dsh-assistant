import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectIsolatedHostRestart } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'
import { isolationDigest as hash, isolationBinding, validIsolationReceipt, hasRestartIsolation, operationBlocksRecovery, verifyRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { restartFixture } from './fixtures/native-restart-isolation.js'


for (const acknowledged of [true, false]) test(`strict isolated restart proof preserves redacted ${acknowledged ? 'draft acknowledgement' : 'material missing-result'} history`, async () => {
 const f = restartFixture(acknowledged), before = structuredClone({ operation: f.operation, original: f.original })
 const proof = await inspectIsolatedHostRestart(f)
 assert.equal(proof.kind, 'native-host-restart-isolated')
 assert.equal(proof.exitStatus, 'unknown'); assert.equal(proof.noReplay, true)
 assert.equal(validIsolationReceipt(proof.isolation, isolationBinding(f.operation, proof.callId)), true)
 assert.deepEqual({ operation: f.operation, original: f.original }, before)
 assert.equal(hasRestartIsolation(f.operation), false, 'proof collection alone cannot release a blocker')
 f.operation.recoverySettlement = { kind: 'host-restart-isolated', exitStatus: 'unknown', noReplay: true, partialEffectsPossible: true,
  operatorSourceId: 'operator-source', humanRequestId: 'human-request', proof }
 assert.equal(hasRestartIsolation(f.operation), true)
 assert.equal(operationBlocksRecovery(f.operation), false)
 assert.equal(await verifyRestartIsolation(f.ctx, f.operation), true)
 f.revoke(); assert.equal(await verifyRestartIsolation(f.ctx, f.operation), false)
 assert.equal(f.operation.state, 'unknown'); assert.equal(f.operation.job.status, 'running'); assert.equal(f.operation.result, null)
})

const refusals = {
 'no Host restart': f => { delete f.operation.recoveryReason },
 'original result already exists': f => { f.operation.result = { isError: true } },
 'live original executor': f => f.live.add(f.execution.sessionId),
 'running registry producer': f => f.jobs.push({ status: 'running' }),
 'ordinary undrained executor': f => { f.execution.drained = false; f.execution.recovering = false },
 'unfinished investigation': f => { f.readback.drained = false },
 'failed investigation': f => { f.readback.status = 'failed' },
 'unbound investigation': f => { f.readback.input.readbackOperationId = 'foreign' },
 'foreign investigation': f => { f.readback.taskId = 'foreign' },
 'stale isolation digest': f => { f.receipt.binding.operationDigest = 'stale' },
 'foreign scope': f => { f.receipt.binding.sessionId = 'foreign' },
 'old start identity': f => { f.receipt.binding.startedAt-- },
 'residual writers': f => { f.receipt.activeWriterCount = 1 },
 'incomplete range exclusion': f => { f.receipt.externalWritersExcluded = false },
 'no durable fence': f => { f.receipt.durableFence = false },
 'revoked fence': f => f.revoke(),
 'no authority': f => { const get = f.ctx.get; f.ctx.get = name => name === 'nativeJobRecovery' ? undefined : get(name) },
 'real terminal receipt must use normal reconciliation': f => f.original.push({ seq: 5, type: 'job/settled', data: { jobId: f.operation.job.jobId, status: 'failed' } }),
 'wrong original registration': f => { f.original[3].data.toolCall.callId = 'other' },
 'changed original arguments': f => { f.original[2].data.arguments = '{"command":"other"}' },
}
for (const [name, alter] of Object.entries(refusals)) test(`isolated restart rejects ${name}`, async () => {
 const f = restartFixture(); alter(f)
 assert.equal(await inspectIsolatedHostRestart(f), null)
 assert.equal(operationBlocksRecovery(f.operation), true)
 assert.equal(f.operation.recoverySettlement, undefined)
})
