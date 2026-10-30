import test from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { restartFixture } from './fixtures/native-restart-isolation.js'
import { restartScopeProbePlan, localRestartScope, restartProducerFilter } from '../packages/dingtalk-dsh-assistant/native-restart-scope-probe.js'
import { inspectIsolatedHostRestart, prepareRestartScopeProbe } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'
import { isolationBinding, isolationDigest, verifyRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'

const pg = String.raw`& D:\soft\PostgreSQL\16\bin\postgres.exe -D D:\agent\artifacts\isolated-pg -h 127.0.0.1 -p 25428`
const maven = String.raw`$env:JAVA_HOME='D:\jdk'; $env:PATH="$env:JAVA_HOME\bin;$env:PATH"; $env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'; python D:\host\skills\business-development\scripts\verification_run.py --cwd D:\agent\worktrees\compat --evidence-dir D:\agent\tasks\task\round-5 --name compile -- D:\maven\bin\mvn.cmd -o '-Dmaven.repo.local=D:\maven\repository' -DskipTests test-compile`
const evidence = () => ({ hostPid: 900, hostLogPath: 'D:\\approved\\host.oom.log', hostLogSha256: 'a'.repeat(64),
 producerScopeReviewed: true, localEffectsOnlyConfirmed: true, excludeOriginalSourcesConfirmed: true,
 probeExecutionId: 'investigation', probeCallId: 'scope-probe' })

function probeFixture(command, acknowledged, hostExit) {
 const f = restartFixture(acknowledged, command), scopeEvidence = evidence()
 if (hostExit) scopeEvidence.hostExit = hostExit
 const plan = restartScopeProbePlan({ command, binding: isolationBinding(f.operation, 'original-call'), evidence: scopeEvidence, dshHome: 'D:\\host' })
 assert.ok(plan)
 const readInput = f.reads[1]
 const observation = { schema: plan.spec.schema, specDigest: plan.specDigest, observedAt: '2026-10-27T08:31:00Z', hostFatalTime: '2026-10-27T07:32:20Z',
  hostFatal: true, providerContractVerified: true, originalHostCount: 0, originalHostChildCount: 0, legacySourceCount: 0, sourceWriterCount: 0,
  listeningCount: 0, originalArtifactsPreserved: true, artifactState: 'retained-unverified' }
 if (hostExit) Object.assign(observation, { hostFatal: false, hostFatalTime: '2026-10-27T07:00:00Z', hostLogVerified: true, hostExitObservedAt: hostExit.observedAt })
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

test('observed non-OOM Host exit preserves unknown effects and requires full bounded isolation', async () => {
 const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 try {
  const hostExit = { observedAt: '2026-10-27T07:32:20Z', evidenceRef: 'retained-launcher-process-observation' }
  const f = probeFixture(pg, true, hostExit)
  const proof = await inspectIsolatedHostRestart(f)
  assert.equal(proof.exitStatus, 'unknown'); assert.equal(proof.partialEffectsPossible, true); assert.equal(proof.noReplay, true)
  assert.equal(proof.isolation.provenance.observation.hostFatal, false)
  assert.deepEqual(proof.isolation.provenance.hostExit, { ...hostExit, basis: 'operator-observed-exit', cause: 'unknown' })
  assert.equal(proof.isolation.hostExitRef, `observed-host-exit:${isolationDigest(hostExit)}`)
  assert.deepEqual((await inspectIsolatedHostRestart({ ...f, planOnly: true })).probe, f.plan)
  assert.equal(f.operation.state, 'unknown'); assert.equal(f.operation.job.status, 'running'); assert.equal(f.operation.result, null)
  for (const [name, change] of Object.entries({
   'missing retained log': x => { x.observation.hostLogVerified = false },
   'live Host': x => { x.observation.originalHostCount = 1 },
   'live descendant': x => { x.observation.originalHostChildCount = 1 },
   'legacy producer after startup log': x => { x.observation.legacySourceCount = 1 },
   'remaining writer': x => { x.observation.sourceWriterCount = 1 },
   'occupied port': x => { x.observation.listeningCount = 1 },
   'lost artifacts': x => { x.observation.originalArtifactsPreserved = false },
   'changed provider': x => { x.observation.providerContractVerified = false },
   'invalid observation time': x => { x.observation.observedAt = 'not-a-date' },
   'mismatched exit time': x => { x.observation.hostExitObservedAt = '2026-10-27T07:32:21Z' },
   'foreign task': x => { x.readback.taskId = 'other-task' },
   'unbound investigation': x => { x.readback.input.readbackOperationId = 'other-operation' },
  })) {
   const other = probeFixture(pg, true, hostExit); change(other); other.updateOutput()
   assert.equal(await inspectIsolatedHostRestart(other), null, name)
  }
  for (const hostExit of [null, {}, { observedAt: 'invalid', evidenceRef: 'fact' },
   { observedAt: '2026-10-27T07:00:00Z', evidenceRef: 'fact' },
   { observedAt: '9999-01-01T00:00:00Z', evidenceRef: 'fact' },
   { observedAt: '2026-10-27T07:32:20Z', evidenceRef: ' ' }]) {
   assert.equal(restartScopeProbePlan({ command: pg, binding: f.plan.spec.binding, evidence: { ...f.scopeEvidence, hostExit } }), null)
  }
 } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
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
 'missing final LF': f => { f.reads[2].data.arguments = JSON.stringify({ command: f.plan.command.slice(0, -1) }) },
 'LF converted to CRLF': f => { f.reads[2].data.arguments = JSON.stringify({ command: f.plan.command.replaceAll('\n', '\r\n') }) },
 'probe not producer-settled': f => { f.reads[4].data.producerReported = false },
 'probe failed': f => { f.reads[4].data.status = 'failed' },
 'foreign probe': f => { f.scopeEvidence.probeExecutionId = 'foreign' },
 'no reviewed scope': f => { f.scopeEvidence.localEffectsOnlyConfirmed = false },
})) test(`scoped probe rejects ${name}`, async () => {
 const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 try { const f = probeFixture(pg, true); alter(f); f.updateOutput(); assert.equal(await inspectIsolatedHostRestart(f), null) }
 finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})

test('managed plan is rebuilt from original native evidence and bound to the current investigation', async () => {
 const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = 'D:\\host'
 try {
  const f = probeFixture(maven, false)
  const investigation = { ...f.readback, executionId: 'current-investigation', sessionId: 'current-session', status: 'running', drained: false }
  const args = { expectedOperationDigest: isolationDigest(f.operation), expectedScriptDigest: f.plan.scriptDigest, scopeEvidence: f.scopeEvidence }
  const request = { ...f, executions: [f.execution, investigation], investigation, binding: investigation, args }
  assert.deepEqual(await prepareRestartScopeProbe(request), f.plan)
  for (const changes of [
   { binding: { ...investigation, inputVersion: 55 } },
   { investigation: { ...investigation, taskId: 'foreign' } },
   { investigation: { ...investigation, definition: { recoveryReadOnly: false } } },
   { investigation: { ...investigation, input: { readbackOperationId: 'other' } } },
   { args: { ...args, expectedOperationDigest: 'f'.repeat(64) } },
   { args: { ...args, expectedScriptDigest: isolationDigest({ command: f.plan.command.trimEnd() }) } },
  ]) assert.equal(await prepareRestartScopeProbe({ ...request, ...changes }), null)
 } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome }
})


test('actual PowerShell producer filter excludes unrelated Claude and retains DSH ownership and original-source descendants', {skip:process.platform!=='win32'}, () => {
 const created = '2026-10-27T07:10:00Z', root = 'D:\\host\\profiles\\web\node_modules\\@deepseek-ai'
 const rows = [
  {ProcessId:1,ParentProcessId:100,Name:'pwsh.exe',CommandLine:'pwsh -File C:\\other\\cc-pool.ps1',CreationDate:created},
  {ProcessId:2,ParentProcessId:1,Name:'claude.exe',CommandLine:'claude --session-id unrelated',CreationDate:created},
  {ProcessId:3,ParentProcessId:100,Name:'node.exe',CommandLine:root+'\\dsh-subprocess-local\\lib\\runner.js',CreationDate:created},
  {ProcessId:4,ParentProcessId:900,Name:'pwsh.exe',CommandLine:'pwsh -Command work',CreationDate:created},
  {ProcessId:5,ParentProcessId:4,Name:'java.exe',CommandLine:'java compiler',CreationDate:created},
  {ProcessId:6,ParentProcessId:991,Name:'python.exe',CommandLine:'python worker',CreationDate:created},
  {ProcessId:7,ParentProcessId:100,Name:'java.exe',CommandLine:'java unrelated-project',CreationDate:created},
  {ProcessId:8,ParentProcessId:100,Name:'node.exe',CommandLine:root+'\\dsh\\lib\\bin.js',CreationDate:'2026-10-27T08:00:00Z'},
  {ProcessId:11,ParentProcessId:100,Name:'postgres.exe',CommandLine:'D:\\other-pg\\postgres.exe -D D:\\other-db',CreationDate:created},
  {ProcessId:9,ParentProcessId:100,Name:'pwsh.exe',CommandLine:root+'\\dsh-provider\\entry.js',CreationDate:null},
  {ProcessId:10,ParentProcessId:100,Name:'pwsh.exe',CommandLine:'pwsh -EncodedCommand '+Buffer.from(root+'\\dsh-provider\\entry.js','utf16le').toString('base64'),CreationDate:created},
 ]
 const encoded=Buffer.from(JSON.stringify(rows)).toString('base64')
 const script=restartProducerFilter+`\n$rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json\n$spec=[pscustomobject]@{hostPid=900;managedProviderRoot='${root}'}\n@(Get-RestartRelatedProducer $rows $spec ([DateTimeOffset]::Parse('2026-10-27T07:00:00Z').UtcDateTime) ([DateTimeOffset]::Parse('2026-10-27T07:32:00Z').UtcDateTime) 991)|Select-Object -ExpandProperty ProcessId|ConvertTo-Json -Compress`
 const output=execFileSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true})
 assert.deepEqual(JSON.parse(output),[3,4,5,6,9,10])
})
