import test from 'node:test'
import assert from 'node:assert/strict'
import { restartFixture } from './fixtures/native-restart-isolation.js'
import { restartScopeProbePlan, localRestartScope } from '../packages/dingtalk-dsh-assistant/native-restart-scope-probe.js'
import { inspectIsolatedHostRestart } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'
import { isolationBinding, verifyRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'

const pg = String.raw`& D:\soft\PostgreSQL\16\bin\postgres.exe -D D:\agent\artifacts\isolated-pg -h 127.0.0.1 -p 25428`
const maven = String.raw`$env:JAVA_HOME='D:\jdk'; $env:PATH="$env:JAVA_HOME\bin;$env:PATH"; $env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'; python D:\host\skills\business-development\scripts\verification_run.py --cwd D:\agent\worktrees\compat --evidence-dir D:\agent\tasks\task\round-5 --name compile -- D:\maven\bin\mvn.cmd -o '-Dmaven.repo.local=D:\maven\repository' -DskipTests test-compile`
const evidence = () => ({ hostPid: 900, hostLogPath: 'D:\\approved\\host.oom.log', hostLogSha256: 'a'.repeat(64),
 producerScopeReviewed: true, localEffectsOnlyConfirmed: true, excludeOriginalSourcesConfirmed: true,
 probeExecutionId: 'investigation', probeCallId: 'scope-probe' })

function probeFixture(command, acknowledged) {
 const f = restartFixture(acknowledged, command), scopeEvidence = evidence()
 const plan = restartScopeProbePlan({ command, binding: isolationBinding(f.operation, 'original-call'), evidence: scopeEvidence, dshHome: 'D:\\host' })
 assert.ok(plan)
 const readInput = f.reads[1]
 const observation = { schema: plan.spec.schema, specDigest: plan.specDigest, observedAt: '2026-10-27T08:31:00Z', hostFatalTime: '2026-10-27T07:32:20Z',
  hostFatal: true, providerContractVerified: true, originalHostCount: 0, originalHostChildCount: 0, legacySourceCount: 0, sourceWriterCount: 0,
  listeningCount: 0, originalArtifactsPreserved: true, artifactState: 'retained-unverified' }
 f.reads.splice(2, f.reads.length, { seq: 2, type: 'tool/call', data: { callId: 'scope-probe', name: 'pwsh', arguments: JSON.stringify({ command: plan.command }) } },
  { seq: 3, type: 'job/registered', data: { jobId: 'scope-job', owner: f.readback.sessionId, kind: 'pwsh', label: plan.command, startedAt: 1000, toolCall: { callId: 'scope-probe' } } },
  { seq: 4, type: 'job/settled', data: { jobId: 'scope-job', owner: f.readback.sessionId, startedAt: 1000, status: 'completed', producerReported: true, detail: 'exit code: 0' } },
  { seq: 5, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'scope-probe', isError: false,
   content: [{ type: 'text', text: JSON.stringify(observation) + '\n[exit code: 0]' }] } } },
  { seq: 6, type: 'tool/call', data: { callId: 'read-call', name: 'read', arguments: '{"file_path":"effects.json"}' } },
  { seq: 7, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'read-call', isError: false, content: [{ type: 'text', text: 'effects remain unverified' }] } } })
 f.reads[1] = readInput
 const originalGet = f.ctx.get
 f.ctx.get = name => name === 'nativeJobRecovery' ? undefined : originalGet(name)
 return { ...f, scopeEvidence, plan, observation, updateOutput() { f.reads[5].data.message.content[0].text = JSON.stringify(observation) + '\n[exit code: 0]' } }
}

test('only the two bounded local launch recipes are supported; arbitrary shell extensions reject', () => {
 assert.equal(localRestartScope(pg).kind, 'local-postgres')
 assert.equal(localRestartScope(maven).kind, 'local-maven-compile')
 for (const command of [pg + '; Write-Output fake', maven + '; Invoke-WebRequest https://example.invalid', 'Start-Process postgres', 'python arbitrary.py']) assert.equal(localRestartScope(command), null)
})

for (const [command, acknowledged] of [[pg, true], [maven, false]]) test(`existing native probe proves bounded isolation without a new service: ${acknowledged ? 'PG' : 'Maven'}`, async () => {
 const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 try {
  const f = probeFixture(command, acknowledged)
  const plan = await inspectIsolatedHostRestart({ ...f, planOnly: true })
  assert.equal(plan.probe.command, f.plan.command)
  assert.doesNotMatch(plan.probe.command, /\$(?:pid|home|host|error|pshome)\s*=/iu, 'fixed probe must not assign PowerShell automatic variables')
  const proof = await inspectIsolatedHostRestart(f)
  assert.equal(proof.isolation.issuer, 'native-windows-scope-evidence-v1')
  assert.equal(proof.exitStatus, 'unknown')
  f.operation.recoverySettlement = { kind: 'host-restart-isolated', exitStatus: 'unknown', noReplay: true, partialEffectsPossible: true,
   operatorSourceId: 'operator', humanRequestId: 'human', proof }
  assert.equal(await verifyRestartIsolation(f.ctx, f.operation), true)
  assert.equal(f.operation.state, 'unknown'); assert.equal(f.operation.job.status, 'running'); assert.equal(f.operation.result, null)
 } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})

for (const [name, alter] of Object.entries({
 'host still alive': f => { f.observation.originalHostCount = 1 },
 'old host runner alive': f => { f.observation.originalHostChildCount = 1 },
 'unattributed legacy producer alive': f => { f.observation.legacySourceCount = 1 },
 'residual writer': f => { f.observation.sourceWriterCount = 1 },
 'listener remains': f => { f.observation.listeningCount = 1 },
 'provider version changed': f => { f.observation.providerContractVerified = false },
 'wrong fatal evidence': f => { f.observation.hostFatal = false },
 'discarded local effects': f => { f.observation.originalArtifactsPreserved = false },
 'fake echo command': f => { f.reads[2].data.arguments = JSON.stringify({ command: 'Write-Output fake' }) },
 'probe not producer-settled': f => { f.reads[4].data.producerReported = false },
 'probe failed': f => { f.reads[4].data.status = 'failed' },
 'foreign probe': f => { f.scopeEvidence.probeExecutionId = 'foreign' },
 'no reviewed scope': f => { f.scopeEvidence.localEffectsOnlyConfirmed = false },
})) test(`scoped probe rejects ${name}`, async () => {
 const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 try { const f = probeFixture(pg, true); alter(f); f.updateOutput(); assert.equal(await inspectIsolatedHostRestart(f), null) }
 finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})
