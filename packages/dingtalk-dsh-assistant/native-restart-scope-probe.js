import { win32 } from 'node:path'
import { isolationDigest as hash } from './native-restart-isolation.js'
import { inspectSession } from './session-persistence.js'

// These are the reviewed, deployed rc.2 Windows Job owner implementations, not an
// inference that every shell provider has the same containment semantics.
const providerFiles = [
 ['dsh-subprocess-local/lib/runner.js', '4e21528dfdb3e92bdce2340945dc4dcb202e4a4af0bbeb8b97585f67735d30c1'],
 ['dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js', '6df08adc4a27f278878a5f4cde8b551b51e647b922ac7d6591fd62d272ced153'],
 ['dsh-win32-process/lib/index.js', '622bc3a9e97c46e784fe41c9a0a8535da2808019e4ac3f66d17cdad70c9ac0c9'],
]
const safePath = value => typeof value === 'string' && win32.isAbsolute(value) && !/[\r\n'";&|<>`$]/u.test(value)
const shellPath = '[A-Za-z]:\\\\[^\\s;\'"&|<>`$]+'

export function localRestartScope(command) {
 const pg = new RegExp(`^& (${shellPath}\\\\postgres\\.exe) -D (${shellPath}) -h 127\\.0\\.0\\.1 -p ([0-9]+)$`, 'i').exec(command)
 if (pg && Number(pg[3]) > 0 && Number(pg[3]) <= 65535) return { kind: 'local-postgres', executable: pg[1], directory: pg[2], port: Number(pg[3]) }
 const prefix = /^\$env:JAVA_HOME='([^']+)'; \$env:PATH="\$env:JAVA_HOME\\bin;\$env:PATH"; \$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'; /u
 const stripped = command.replace(prefix, '')
 if (stripped === command) return null
 const compile = new RegExp(`^python (${shellPath}\\\\verification_run\\.py) --cwd (${shellPath}) --evidence-dir (${shellPath}) --name ([A-Za-z0-9_-]+) -- (${shellPath}\\\\mvn\\.cmd) -o '-Dmaven\\.repo\\.local=(${shellPath})' -DskipTests test-compile$`, 'i').exec(stripped)
 if (!compile) return null
 return { kind: 'local-maven-compile', wrapper: compile[1], directory: compile[2], evidenceFile: win32.join(compile[3], compile[4] + '.json') }
}

// Shared by the actual probe and executable PowerShell classification tests.
export const restartProducerFilter = `
function Get-RestartSourceText($Entry) {
 $text = [string]$Entry.CommandLine
 if ($text -match '(?i)-EncodedCommand\\s+"?([A-Za-z0-9+/=]+)') {
  try { $text += ' ' + [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) } catch {}
 }
 return $text.Replace('/','\\')
}
function Get-RestartRelatedProducer($Processes, $Spec, $WindowStart, $WindowEnd, $OriginalSourcePid) {
 $related = [Collections.Generic.HashSet[long]]::new()
 [void]$related.Add([long]$Spec.hostPid)
 if ($OriginalSourcePid -gt 0) { [void]$related.Add([long]$OriginalSourcePid) }
 do {
  $changed = $false
  foreach ($entry in $Processes) {
   if ($related.Contains([long]$entry.ParentProcessId) -and $related.Add([long]$entry.ProcessId)) { $changed = $true }
  }
 } while ($changed)
 $providerRoot = $Spec.managedProviderRoot.Replace('/','\\')
 foreach ($entry in $Processes) {
  if ($related.Contains([long]$entry.ProcessId)) { $entry; continue }
  $sourceText = Get-RestartSourceText $entry
  $inWindow = $null -eq $entry.CreationDate -or ($entry.CreationDate.ToUniversalTime() -ge $WindowStart -and $entry.CreationDate.ToUniversalTime() -le $WindowEnd)
  if ($inWindow -and $sourceText.IndexOf($providerRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $entry }
 }
}
`

export function restartScopeProbePlan({ command, binding, evidence, dshHome = process.env.DSH_HOME }) {
 const scope = localRestartScope(command)
 if (!scope || !safePath(dshHome) || !safePath(evidence?.hostLogPath) || !/^[a-f0-9]{64}$/u.test(evidence.hostLogSha256 ?? '')
  || !Number.isSafeInteger(evidence.hostPid) || evidence.hostPid < 1
  || evidence.producerScopeReviewed !== true || evidence.localEffectsOnlyConfirmed !== true || evidence.excludeOriginalSourcesConfirmed !== true) return null
 const spec = { schema: 'native-restart-scope-v1', binding, scope, hostPid: evidence.hostPid, hostLogPath: evidence.hostLogPath,
  hostLogSha256: evidence.hostLogSha256, managedProviderRoot: win32.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai'), providerFiles: providerFiles.map(([path, sha256]) => ({ path: win32.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', path), sha256 })) }
 const encoded = Buffer.from(JSON.stringify(spec)).toString('base64')
 const probe = `$ErrorActionPreference = 'Stop'
${restartProducerFilter}
$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$log = Get-Item -LiteralPath $s.hostLogPath -ErrorAction Stop
if ($log.PSIsContainer -or ($log.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'HOST_LOG_NOT_REGULAR' }
$logHash = (Get-FileHash -LiteralPath $s.hostLogPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
$fatalText = [IO.File]::ReadAllText($s.hostLogPath)
$fatal = $logHash -eq $s.hostLogSha256 -and $fatalText.Contains('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory') -and $fatalText.Contains('[' + $s.hostPid + ':')
$providerOk = $true
foreach ($f in $s.providerFiles) {
 $i = Get-Item -LiteralPath $f.path -ErrorAction Stop
 if ($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.LastWriteTimeUtc -gt [DateTimeOffset]::FromUnixTimeMilliseconds($s.binding.startedAt).UtcDateTime -or (Get-FileHash -LiteralPath $f.path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $f.sha256) { $providerOk = $false }
}
$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$hostCount = @($all | Where-Object { $_.ProcessId -eq $s.hostPid }).Count
$hostChildren = @($all | Where-Object { $_.ParentProcessId -eq $s.hostPid }).Count
$windowStart = [DateTimeOffset]::FromUnixTimeMilliseconds($s.binding.startedAt - 5000).UtcDateTime
$windowEnd = $log.LastWriteTimeUtc
$portCount = 0; $preserved = $false; $sourceProcessId = 0; $artifactState = $null
if ($s.scope.kind -eq 'local-postgres') {
 $sourcePidFile = Join-Path $s.scope.directory 'postmaster.pid'
 $sourcePidLines = @([IO.File]::ReadAllLines($sourcePidFile)); $sourceProcessId = [int]$sourcePidLines[0]
 $preserved = $sourcePidLines.Count -ge 4 -and [IO.Path]::GetFullPath($sourcePidLines[1]) -eq [IO.Path]::GetFullPath($s.scope.directory) -and [int]$sourcePidLines[3] -eq $s.scope.port
 $portCount = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq $s.scope.port }).Count
 $writers = @($all | Where-Object { $_.ProcessId -eq $sourceProcessId -or ((Get-RestartSourceText $_).IndexOf($s.scope.directory.Replace('/','\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0) }).Count
 $artifactState = 'retained-unverified-database'
} else {
 $record = [IO.File]::ReadAllText($s.scope.evidenceFile) | ConvertFrom-Json
 $sourceProcessId = [int]$record.pid
 $preserved = $sourceProcessId -gt 0 -and $record.cwd -eq $s.scope.directory -and $record.state -eq 'running' -and $null -eq $record.exitCode
 $writers = @($all | Where-Object { $_.ProcessId -eq $sourceProcessId -or ((Get-RestartSourceText $_).IndexOf($s.scope.directory.Replace('/','\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0) }).Count
 $artifactState = 'retained-unverified-build'
}
$legacySourceCount = @(Get-RestartRelatedProducer $all $s $windowStart $windowEnd $sourceProcessId).Count
[ordered]@{schema=$s.schema;specDigest='${hash(spec)}';observedAt=[DateTimeOffset]::UtcNow.ToString('o');hostFatal=$fatal;hostFatalTime=$log.LastWriteTimeUtc.ToString('o');providerContractVerified=$providerOk;originalHostCount=$hostCount;originalHostChildCount=$hostChildren;legacySourceCount=$legacySourceCount;sourceWriterCount=$writers;listeningCount=$portCount;originalArtifactsPreserved=$preserved;artifactState=$artifactState} | ConvertTo-Json -Compress
`
 return { command: probe, spec, specDigest: hash(spec), scriptDigest: hash({ command: probe }) }
}

const toolMessages = event => event.type !== 'tool/result' ? [] : event.data.message?.role === 'tool' ? [event.data.message] : event.data.message?.content ?? []

export const restartScopeProbeToolName = 'execution_restart_scope_probe'
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' }

/** 只把 Host 重建的原文交给原生工具；不接受模型提供的 command，不自行启动进程或补写原生事件。 */
export function registerRestartScopeProbe({ agentCtx, agent, current, readPlan, captureSettlement }) {
 const outcomes = new Map()
 agentCtx.tools.register({
  name: restartScopeProbeToolName,
  description: '执行当前只读调查绑定的 Host 重启隔离探针。expectedOperationDigest、expectedScriptDigest 和 scopeEvidence 来自正式 reply/check。Host 重新核对原调用并将固定 command 原文传给原生 pwsh，无需复制命令。成功只证明本次探针执行，仍须正式人工对账；不重放原操作。',
  effectClass: 'read',
  parameters: { type: 'object', properties: {
   expectedOperationDigest: digestSchema, expectedScriptDigest: digestSchema,
   scopeEvidence: { type: 'object', properties: {
    hostPid: { type: 'integer', minimum: 1 }, hostLogPath: { type: 'string', minLength: 1 }, hostLogSha256: digestSchema,
    producerScopeReviewed: { const: true }, localEffectsOnlyConfirmed: { const: true }, excludeOriginalSourcesConfirmed: { const: true },
   }, required: ['hostPid', 'hostLogPath', 'hostLogSha256', 'producerScopeReviewed', 'localEffectsOnlyConfirmed', 'excludeOriginalSourcesConfirmed'], additionalProperties: false },
  }, required: ['expectedOperationDigest', 'expectedScriptDigest', 'scopeEvidence'], additionalProperties: false },
  output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  // 保留失败子结果，但不改原生 isError。否则下一次调查只能看到外层报错，无法定位原子调用。
  finalizeContent(exec, result) {
   const outcome = outcomes.get(exec.token); outcomes.delete(exec.token)
   return outcome ? [{ type: 'text', text: JSON.stringify({ ...outcome, ...(result.isError ? { failure: result.error?.message ?? 'DYNAMIC_SCOPE_PROBE_EXECUTION_FAILED' } : {}) }) }] : undefined
  },
  async execute(args, exec) {
   const check = async () => { exec.signal.throwIfAborted(); if (!await current()) throw Error('execution_binding_stale') }
   await check()
   const plan = await readPlan(args)
   if (!plan || plan.spec.binding.operationDigest !== args.expectedOperationDigest || plan.scriptDigest !== args.expectedScriptDigest
    || hash({ command: plan.command }) !== plan.scriptDigest) throw Error('DYNAMIC_SCOPE_PROBE_PLAN_STALE')
   await check()
   const callId = `${exec.callId}:restart-scope`, parameters = { command: plan.command, description: '核对原 Host 及原操作生产来源是否隔离', timeoutMs: 60000 }
   // 必须经过同一 registry 的 guard、operation 账本、原生 job 和 post-execute；parent 是原生分配的外层 token。
   const { result, operationObservation } = await captureSettlement(callId, () => agentCtx.tools.execute({ callId, rootCallId: exec.rootCallId, parent: exec.token,
    name: 'pwsh', arguments: parameters, agent: exec.agent, signal: exec.signal }))
   const outcome = { probeCallId: callId, scriptDigest: plan.scriptDigest, nativeArguments: parameters,
    ...(operationObservation ? { operationObservation } : {}), nativeResult: { isError: result.isError, content: result.content } }
   outcomes.set(exec.token, outcome)
   await check()
   const events = agent.session.snapshotEvents()
   const jobs = events.filter(event => event.type === 'job/registered' && event.data.owner === agent.id && event.data.toolCall?.callId === callId)
   const settled = jobs.length === 1 ? events.filter(event => event.type === 'job/settled' && event.data.owner === agent.id
    && event.data.jobId === jobs[0].data.jobId && event.data.startedAt === jobs[0].data.startedAt) : []
   // shell 工具可成功返回 exitCode=1；调用成功不能替代 producer 成功，缺 job 也不能生成受管成功回执。
   if (result.isError || !operationObservation || operationObservation.cancelled || operationObservation.postExecutionDecision !== 'accept'
    || jobs.length !== 1 || jobs[0].data.label !== plan.command || jobs[0].data.toolCall.rootCallId !== exec.rootCallId
    || settled.length !== 1 || settled[0].data.producerReported !== true || settled[0].data.status !== 'completed'
    || settled[0].data.detail !== 'exit code: 0') throw Error('DYNAMIC_SCOPE_PROBE_EXECUTION_FAILED')
   // 外层原生 tool/result 保存受管实参及子结果；真正派发还必须由独立 native job 记录交叉证明。
   return outcome
  },
 })
 return agentCtx.tools.get(restartScopeProbeToolName, agent)
}

/** 外层原生调用只接受 Host 返回的实参；下游还须交叉核对同 root 的唯一原生 job 和 producer 终态。 */
export function readManagedRestartProbeCall(events, input, callId) {
 const parents = events.filter(event => event.seq > input.seq && event.type === 'tool/call'
  && callId === `${event.data.callId}:restart-scope` && event.data.name === restartScopeProbeToolName)
 if (parents.length !== 1) return null
 const parent = parents[0]
 let args
 try { args = JSON.parse(parent.data.arguments) } catch { return null }
 const outer = events.filter(event => event.seq > parent.seq && toolMessages(event).some(message => message.toolCallId === parent.data.callId))
 if (outer.length !== 1) return null
 const message = toolMessages(outer[0]).find(message => message.toolCallId === parent.data.callId)
 if (typeof message?.isError !== 'boolean') return null
 let value
 try { value = JSON.parse(message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n')) } catch { return null }
 if (value.probeCallId !== callId || value.scriptDigest !== args.expectedScriptDigest
  || hash({ command: value.nativeArguments?.command }) !== args.expectedScriptDigest
  || typeof value.nativeResult?.isError !== 'boolean' || !Array.isArray(value.nativeResult.content)
  || value.nativeResult.isError && !message.isError) return null
 const observation = value.operationObservation
 if (observation && (typeof observation.result?.isError !== 'boolean' || !Array.isArray(observation.result.content)
  || typeof observation.cancelled !== 'boolean' || !['accept', 'block'].includes(observation.postExecutionDecision)
  || observation.result.isError && !value.nativeResult.isError)) return null
 return { call: { seq: parent.seq, data: { callId, rootCallId: parent.data.callId, arguments: JSON.stringify(value.nativeArguments) } },
  returned: outer[0], message: { toolCallId: callId, ...value.nativeResult },
  operationMessage: observation ? { toolCallId: callId, ...observation.result } : null, operationObservation: observation,
  outerIsError: message.isError, expectedOperationDigest: args.expectedOperationDigest }
}

export async function readRestartScopeProbe({ ctx, plan, evidence, operation, executions }) {
 const readback = executions.find(item => item.executionId === evidence.probeExecutionId)
 if (!readback || readback.taskId !== operation.taskId || readback.status !== 'succeeded' || !readback.drained || readback.recovering
  || readback.definition?.recoveryReadOnly !== true || readback.input?.readbackOperationId !== operation.operationId
  || ctx.agents.get(readback.sessionId) || ctx.sessions.get(readback.sessionId)) return null
 const { events } = await inspectSession(ctx.sessionPersistence, readback.sessionId)
 const identity = events.some(event => event.type === 'plugin:dingtalk/execution-session' && event.data.identity?.taskId === operation.taskId
  && event.data.identity.executionId === readback.executionId && event.data.identity.sessionId === readback.sessionId)
 const input = events.findLast(event => event.type === 'user/message' && event.data.source?.executionSession?.sessionId === readback.sessionId
  && event.data.source.executionSession.inputVersion === readback.inputVersion && event.data.source.executionSession.inputDigest === readback.inputDigest
  && event.data.source.executionSession.leaseEpoch === readback.leaseEpoch)
 if (!identity || !input) return null
 const direct = events.filter(event => event.seq > input.seq && event.type === 'tool/call' && event.data.callId === evidence.probeCallId && event.data.name === 'pwsh')
 const managed = readManagedRestartProbeCall(events, input, evidence.probeCallId)
 if (managed && (managed.outerIsError || !managed.operationMessage || managed.operationMessage.isError
  || managed.operationObservation.cancelled || managed.operationObservation.postExecutionDecision !== 'accept'
  || managed.expectedOperationDigest !== plan.spec.binding.operationDigest)) return null
 if (direct.length + Number(!!managed) !== 1) return null
 const call = direct[0] ?? managed.call
 let args
 try { args = JSON.parse(call?.data.arguments) } catch { return null }
 if (args.command !== plan.command || args.run_in_background === true || Object.keys(args).some(key => !['command', 'description', 'timeoutMs', 'run_in_background'].includes(key))) return null
 const registered = events.filter(event => event.seq > call.seq && event.type === 'job/registered' && event.data.owner === readback.sessionId
  && event.data.toolCall?.callId === call.data.callId)
 if (registered.length !== 1) return null
 const registration = registered[0]
 if (registration.data.kind !== 'pwsh' || registration.data.label !== plan.command
  || managed && registration.data.toolCall.rootCallId !== call.data.rootCallId) return null
 const settled = events.filter(event => event.seq > registration.seq && event.type === 'job/settled'
  && event.data.jobId === registration.data.jobId && event.data.owner === readback.sessionId && event.data.startedAt === registration.data.startedAt)
 if (settled.length !== 1 || settled[0].data.producerReported !== true || settled[0].data.status !== 'completed' || settled[0].data.detail !== 'exit code: 0') return null
 const returned = managed?.returned ?? events.find(event => event.seq > call.seq && toolMessages(event).some(message => message.toolCallId === call.data.callId))
 const message = managed?.message ?? (returned && toolMessages(returned).find(message => message.toolCallId === call.data.callId))
 if (!message || message.isError !== false || returned.seq <= settled[0].seq) return null
 let text = message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
 try { const receipt = JSON.parse(text).nativeJobReceipt; if (receipt) {
  if (receipt.jobId !== registration.data.jobId || receipt.status !== 'completed') return null
  text = receipt.chunks.map(chunk => chunk.text).join('')
 } } catch {}
 const raw = text.trim().replace(/\s*\[exit code: 0\]\s*$/u, '')
 let observation
 try { observation = JSON.parse(raw) } catch { return null }
 if (observation.schema !== plan.spec.schema || observation.specDigest !== plan.specDigest || observation.hostFatal !== true
  || observation.providerContractVerified !== true || observation.originalHostCount !== 0 || observation.originalHostChildCount !== 0
  || observation.legacySourceCount !== 0 || observation.sourceWriterCount !== 0 || observation.listeningCount !== 0 || observation.originalArtifactsPreserved !== true
  || Date.parse(observation.hostFatalTime) < operation.job.startedAt || Date.parse(observation.observedAt) < Date.parse(observation.hostFatalTime)) return null
 const provenance = { kind: 'native-windows-restart-probe', scope: plan.spec.scope, isolationBasis: 'bounded-producer-exclusion', historicalJobObjectIdentity: 'unavailable', specDigest: plan.specDigest, scriptDigest: plan.scriptDigest,
  hostPid: plan.spec.hostPid, hostLogSha256: plan.spec.hostLogSha256, executionId: readback.executionId, sessionId: readback.sessionId,
  callId: call.data.callId, callSequence: call.seq, resultSequence: returned.seq, settledSequence: settled[0].seq, observation }
 return { kind: 'native-source-scope-isolation', receiptId: `native-scope:${hash(provenance)}`, issuer: 'native-windows-scope-evidence-v1',
  binding: plan.spec.binding, fenceRef: `retired-managed-range:${plan.specDigest}`, hostExitRef: `host-fatal:${plan.spec.hostLogSha256}`,
  originalHostExited: true, sourceScopeQuiescent: true, durableSourceExclusion: true, externalWritersExcluded: true, activeSourceCount: 0,
  observedAt: observation.observedAt, provenance, provenanceDigest: hash(provenance) }
}
