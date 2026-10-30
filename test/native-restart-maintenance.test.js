import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRetainedRestart } from '../scripts/native-restart-maintenance.mjs'
import { readMaintenanceDrainProof } from '../packages/dingtalk-dsh-assistant/native-maintenance-drain.js'
import { maintenanceEvidenceFixture } from './fixtures/native-maintenance-drain.js'
import { restartFixture } from './fixtures/native-restart-isolation.js'
import { isolationDigest as hash, isolationBinding, hasRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'

test('retained maintenance audit binds the native input, feedback, terminal history and original process identities', async t => {
 const root = await mkdtemp(join(tmpdir(), 'maintenance-proof-')); t.after(() => rm(root, { recursive: true, force: true }))
 const f = restartFixture(false)
 Object.assign(f.operation.dispatchBinding, { requirementRevision: 2, controlRevision: 3 })
 const binding = f.operation.dispatchBinding
 f.original.splice(1, 0, { type: 'turn/start', data: {} })
 f.original.push({ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', source: { kind: 'coordinator', executionFeedback: { executionId: binding.executionId, messageId: 'feedback' } } }] } },
  { type: 'agent/inbox/spliced', data: { inserted: [], removedCount: 1 } }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
 f.original.forEach((event, seq) => { event.seq = seq })
 const encoded = structuredClone(f.original)
 encoded.at(-1).sourceEventSeqs = [[0, 2], 4]
 f.original.at(-1).sourceEventSeqs = [0, 1, 2, 4]
 const audit = await maintenanceEvidenceFixture(root, binding, encoded), operations = [f.operation]
 const args = { workspace: root, binding, events: f.original, calls: f.original.filter(event => event.type === 'tool/call'), operations, evidence: audit.evidence, observeProcesses: async () => [] }
 const before = JSON.stringify(operations)
 const proof = await readMaintenanceDrainProof(args)
 assert.equal(proof.noReplay, true); assert.equal(proof.partialEffectsPossible, true); assert.equal(proof.capturedProcessCount, 2)
 assert.equal(proof.pendingOperations[0].operationDigest, hash(f.operation)); assert.equal(JSON.stringify(operations), before)
 const parent = audit.artifacts['captured-descendants']
 audit.artifacts['captured-descendants'] = [parent, { ProcessId: 414, ParentProcessId: 413, CreationDate: '2026-01-01T00:00:02Z' }]
 await audit.save(); assert.equal((await readMaintenanceDrainProof(args)).capturedProcessCount, 3)
 await assert.rejects(readMaintenanceDrainProof({ ...args, observeProcesses: async () => [parent] }), /PROCESS_REMAINS/)
 assert.equal((await readMaintenanceDrainProof({ ...args, observeProcesses: async () => [{ ...parent, CreationDate: '2026-01-01T01:00:00Z' }] })).processesExited, true, 'PID reuse is not the original child')
 audit.artifacts['captured-descendants'][1].CreationDate = '2025-12-31T23:00:00Z'; await audit.save()
 await assert.rejects(readMaintenanceDrainProof(args), /PROCESS_TREE_INVALID/)
 await writeFile(join(audit.evidence.directory, 'captured-descendants.json'), '')
 assert.equal((await readMaintenanceDrainProof(args)).capturedProcessCount, 1, 'old installer writes an empty file for zero descendants')
 await assert.rejects(readMaintenanceDrainProof({ ...args, binding: { ...binding, leaseEpoch: binding.leaseEpoch + 1 } }), /BINDING_STALE/)
 await assert.rejects(readMaintenanceDrainProof({ ...args, operations: [] }), /CALL_UNBOUND/)
 await writeFile(audit.logFile, audit.text + JSON.stringify({ seq: 99, type: 'tool/call', data: {} }) + '\n')
 await assert.rejects(readMaintenanceDrainProof(args), /NATIVE_HISTORY_CHANGED/)
 await writeFile(audit.logFile, audit.text)
 audit.artifacts.quiescent.runtimePortClosed = false; await audit.save()
 await assert.rejects(readMaintenanceDrainProof(args), /CUTOVER_UNPROVEN/)
 assert.equal(JSON.stringify(operations), before)
})
function fixture(acknowledged = false) {
 const f = restartFixture(acknowledged, '& D:\\pg\\bin\\postgres.exe -D D:\\agent\\artifacts\\retained -h 127.0.0.1 -p 25428')
 f.execution.sessionBound = true; f.execution.cancelRequested = true
 const tables = { tasks: [{ taskId: 'task', drained: true }], groups: [], executions: [f.execution], operations: [f.operation], notifications: [] }
 const proposal = { schema: 'native-restart-maintenance-v1', expectedOwnerPid: 123, dshHome: 'D:\\host',
  operatorApproval: { kind: 'explicit-stop-deploy-resume', authorizedAt: '2026-10-27T11:01:46Z', sourceRef: 'operator-approval' },
  operations: [{ operationId: f.operation.operationId, expectedOperationDigest: hash(f.operation),
   scopeEvidence: { hostPid: 90, hostLogPath: 'D:\\host\\fatal.log', hostLogSha256: 'a'.repeat(64),
    producerScopeReviewed: true, localEffectsOnlyConfirmed: true, excludeOriginalSourcesConfirmed: true } }] }
 const observation = { hostFatal: true, providerContractVerified: true, originalHostCount: 0, originalHostChildCount: 0,
  legacySourceCount: 0, sourceWriterCount: 0, listeningCount: 0, originalArtifactsPreserved: true,
  observedAt: new Date().toISOString(), hostFatalTime: '2026-10-27T07:32:20Z' }
 return { ...f, tables, proposal, observation, args: { tables, proposal, ownerPid: 123, workspace: 'unused',
  history: () => ({ events: f.original, digest: 'historical-log' }),
  runProbe: plan => ({ ...observation, schema: plan.spec.schema, specDigest: plan.specDigest }) } }
}
for (const acknowledged of [false, true]) test('maintenance preserves original ledger and history: ' + acknowledged, () => {
 const f = fixture(acknowledged), before = JSON.stringify(f.tables), log = JSON.stringify(f.original)
 const first = inspectRetainedRestart(f.args), second = inspectRetainedRestart(f.args)
 assert.equal(first.writes, 0); assert.equal(first.retained[0].historicalOutcome, 'unknown')
 assert.deepEqual(first.preservedSessionIds, ['original-session'])
 assert.equal(first.ledgerDigest, second.ledgerDigest)
 assert.equal(JSON.stringify(f.tables), before); assert.equal(JSON.stringify(f.original), log)
})
test('maintenance accepts reviewed non-OOM exit only with full original-scope exclusion', () => {
 const f = fixture(), before = JSON.stringify(f.tables)
 f.proposal.operations[0].scopeEvidence.hostExit = { observedAt: '2026-10-27T07:32:20Z', evidenceRef: 'retained-exit-observation' }
 Object.assign(f.observation, { hostFatal: false, hostFatalTime: '2026-10-27T07:00:00Z', hostLogVerified: true, hostExitObservedAt: '2026-10-27T07:32:20Z' })
 assert.equal(inspectRetainedRestart(f.args).writes, 0)
 assert.equal(JSON.stringify(f.tables), before)
 f.observation.legacySourceCount = 1
 assert.throws(() => inspectRetainedRestart(f.args), /DEPLOY_RESTART_ISOLATION_UNPROVEN/)
})
for (const [name, mutate] of [
 ['no explicit approval', f => { delete f.proposal.operatorApproval }],
 ['wrong current Host', f => { f.args.ownerPid++ }],
 ['stale digest', f => { f.proposal.operations[0].expectedOperationDigest = 'b'.repeat(64) }],
 ['new live task', f => { f.tables.tasks[0].drained = false }],
 ['other unfinished execution', f => { f.tables.executions.push({ sessionId: 'other', drained: false }) }],
 ['live group', f => { f.tables.groups.push({ drained: false }) }],
 ['uncancelled original', f => { f.execution.cancelRequested = false }],
 ['not recovery', f => { f.execution.recovering = false }],
 ['another unresolved call', f => { f.original.push({ seq: 4, type: 'tool/call', data: { callId: 'other' } }) }],
 ['old settled receipt', f => { f.original.push({ seq: 4, type: 'job/settled', data: { jobId: f.operation.job.jobId } }) }],
 ['wrong registration', f => { f.original[3].data.startedAt++ }],
 ['unreviewed scope', f => { f.proposal.operations[0].scopeEvidence.localEffectsOnlyConfirmed = false }],
 ['residual producer', f => { f.observation.legacySourceCount = 1 }],
 ['residual writer', f => { f.observation.sourceWriterCount = 1 }],
 ['listener', f => { f.observation.listeningCount = 1 }],
 ['stale observation', f => { f.observation.observedAt = '2026-10-27T07:00:00Z' }],
 ['lost retained artifacts', f => { f.observation.originalArtifactsPreserved = false }],
]) test('maintenance rejects ' + name, () => {
 const f = fixture(); mutate(f)
 assert.throws(() => inspectRetainedRestart(f.args), /DEPLOY_RESTART_ISOLATION_UNPROVEN/)
})

for (const corrupt of [false, true]) test('maintenance retains only unaudited restart work; corrupt audit rejects: '+corrupt, () => {
 const f=fixture(), g=fixture(true), op=g.operation;
 op.operationId='already-audited'; op.executionId='audited-execution';
 op.dispatchBinding={...op.dispatchBinding,executionId:op.executionId};op.ownerBinding=op.dispatchBinding;
 const proof={kind:'native-host-restart-isolated',operationId:op.operationId,taskId:op.taskId,executionId:op.executionId,
  sessionId:op.dispatchBinding.sessionId,callId:'original-call',argumentsDigest:op.definition.argumentsDigest,
  operationDigest:hash(op),observations:[{sequence:3}],isolation:{...g.receipt,binding:isolationBinding(op,'original-call')}};
 op.recoverySettlement={kind:'host-restart-isolated',exitStatus:'unknown',noReplay:true,partialEffectsPossible:true,
  operatorSourceId:'operator-source',humanRequestId:'operator-question',proof};
 assert.equal(hasRestartIsolation(op),true);
 if(corrupt)op.recoverySettlement.proof.operationDigest='stale';
 f.tables.operations.push(op);f.tables.executions.push({...g.execution,executionId:op.executionId,drained:true});
 const before=JSON.stringify(f.tables);
 if(corrupt)assert.throws(()=>inspectRetainedRestart(f.args),/DEPLOY_RESTART_ISOLATION_UNPROVEN/);
 else {const result=inspectRetainedRestart(f.args);assert.equal(result.retained.length,1);assert.equal(result.writes,0);}
 assert.equal(JSON.stringify(f.tables),before);assert.equal(op.state,'unknown');assert.equal(op.job.status,'running');
});
