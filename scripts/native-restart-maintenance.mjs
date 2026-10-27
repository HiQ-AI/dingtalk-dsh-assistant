import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { isolationDigest as hash, isolationBinding, hasRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { restartScopeProbePlan } from '../packages/dingtalk-dsh-assistant/native-restart-scope-probe.js'

export function readNativeHistory(workspace, row) {
  const matches = []
  function walk(directory) {
    if (lstatSync(directory).isSymbolicLink()) throw Error('DEPLOY_LOG_REPARSE_POINT')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw Error('DEPLOY_LOG_REPARSE_POINT')
      if (entry.isDirectory()) walk(file)
      else if (/^session\.v4\.jsonl(?:\.zst)?$/u.test(entry.name)) {
        let bytes = readFileSync(file)
        if (file.endsWith('.zst')) bytes = zstdDecompressSync(bytes)
        const text = bytes.toString('utf8')
        const events = text.trim().split(/\r?\n/u).map(line => JSON.parse(line))
        if (events[0]?.id === row.sessionId) matches.push({ events, digest: hash({ text }) })
      }
    }
  }
  walk(join(workspace, 'tasks', row.taskId, '.dsh', 'sessions'))
  if (matches.length !== 1) throw Error('DEPLOY_NATIVE_LOG_IDENTITY')
  return matches[0]
}

function runFixedProbe(plan) {
  if (process.platform !== 'win32') throw Error('DEPLOY_RESTART_WINDOWS_REQUIRED')
  const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(plan.command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  return JSON.parse(output.trim())
}

// This proves only a maintenance cutover boundary. It never settles a job,
// writes the ledger, or grants the runtime operator reconciliation.
export function inspectRetainedRestart({ tables, workspace, proposal, ownerPid, runProbe = runFixedProbe, history = readNativeHistory }) {
  const fail = () => { throw Error('DEPLOY_RESTART_ISOLATION_UNPROVEN') }
  if (proposal?.schema !== 'native-restart-maintenance-v1' || proposal.expectedOwnerPid !== ownerPid
    || proposal.operatorApproval?.kind !== 'explicit-stop-deploy-resume'
    || !Number.isFinite(Date.parse(proposal.operatorApproval.authorizedAt))
    || !proposal.operatorApproval.sourceRef || !Array.isArray(proposal.operations)
    || !proposal.operations.length || proposal.operations.length > 8
    || tables.tasks.some(row => row.drained !== true) || tables.groups.some(row => row.drained !== true)
    || tables.operations.some(row => row.state === 'starting') || tables.notifications.some(row => row.state === 'starting')) fail()
  const retained = tables.operations.filter(row => row.state === 'unknown' && row.recoveryReason === 'host_restart'
    && !hasRestartIsolation(row) && row.job && ['running', 'stopping'].includes(row.job.status))
  if (retained.length !== proposal.operations.length || new Set(proposal.operations.map(row => row.operationId)).size !== retained.length) fail()
  const sessions = [], observations = []
  for (const operation of retained) {
    const item = proposal.operations.find(row => row.operationId === operation.operationId)
    const execution = tables.executions.find(row => row.executionId === operation.executionId)
    const binding = operation.dispatchBinding
    if (!item || item.expectedOperationDigest !== hash(operation) || operation.result != null || operation.recoverySettlement
      || !execution || execution.taskId !== operation.taskId || !binding || binding.sessionId !== execution.sessionId
      || operation.job.owner !== execution.sessionId || !execution.sessionBound || execution.cancelRequested !== true
      || !execution.drained && !execution.recovering || execution.definition?.executionBackend === 'claude-code') fail()
    const stored = history(workspace, execution), events = stored.events
    if (!events.some(event => event.type === 'plugin:dingtalk/execution-session'
      && event.data.identity?.taskId === operation.taskId && event.data.identity.executionId === execution.executionId
      && event.data.identity.sessionId === execution.sessionId)) fail()
    const input = events.findLast(event => event.type === 'user/message'
      && event.data.source?.executionSession?.sessionId === binding.sessionId
      && event.data.source.executionSession.inputVersion === binding.inputVersion
      && event.data.source.executionSession.inputDigest === binding.inputDigest
      && event.data.source.executionSession.leaseEpoch === binding.leaseEpoch)
    const calls = events.filter(event => event.seq > (input?.seq ?? Infinity) && event.type === 'tool/call'
      && operation.key === 'native:' + binding.executionId + ':' + binding.inputVersion + ':' + binding.leaseEpoch + ':' + event.data.callId)
    if (calls.length !== 1 || calls[0].data.name !== operation.definition.toolName) fail()
    const call = calls[0], args = JSON.parse(call.data.arguments)
    const registrations = events.filter(event => event.type === 'job/registered' && event.data.jobId === operation.job.jobId)
    if (hash(args) !== operation.definition.argumentsDigest || registrations.length !== 1
      || registrations[0].seq <= call.seq || registrations[0].data.owner !== execution.sessionId
      || registrations[0].data.startedAt !== operation.job.startedAt || registrations[0].data.toolCall?.callId !== call.data.callId
      || registrations[0].data.kind !== operation.definition.toolName || registrations[0].data.label !== args.command
      || events.some(event => event.type === 'job/settled' && event.data.jobId === operation.job.jobId)) fail()
    const toolMessages = event => event.data.message?.role === 'tool' ? [event.data.message] : event.data.message?.content ?? []
    const completed = new Set(events.filter(event => event.type === 'tool/result').flatMap(toolMessages).map(message => message.toolCallId))
    if (events.some(event => event.type === 'tool/call' && !completed.has(event.data.callId) && event.data.callId !== call.data.callId)) fail()
    const originalResults = events.filter(event => event.type === 'tool/result').flatMap(toolMessages).filter(message => message.toolCallId === call.data.callId)
    if (originalResults.length > 1 || originalResults.some(message => {
      let receipt
      try { receipt = JSON.parse(message.content?.find(part => part.type === 'text')?.text).nativeJobReceipt } catch { return true }
      return message.isError !== false || receipt?.jobId !== operation.job.jobId || receipt.status !== 'running'
    })) fail()
    const plan = restartScopeProbePlan({ command: args.command, binding: isolationBinding(operation, call.data.callId),
      evidence: item.scopeEvidence, dshHome: proposal.dshHome })
    if (!plan) fail()
    const observed = runProbe(plan), now = Date.now()
    if (observed.schema !== plan.spec.schema || observed.specDigest !== plan.specDigest || observed.hostFatal !== true
      || observed.providerContractVerified !== true || observed.originalHostCount !== 0 || observed.originalHostChildCount !== 0
      || observed.legacySourceCount !== 0 || observed.sourceWriterCount !== 0 || observed.listeningCount !== 0
      || observed.originalArtifactsPreserved !== true || !Number.isFinite(Date.parse(observed.observedAt))
      || Math.abs(now - Date.parse(observed.observedAt)) > 60000
      || Date.parse(observed.hostFatalTime) < operation.job.startedAt) {
      const error = Error('DEPLOY_RESTART_ISOLATION_UNPROVEN'); error.observation = observed; throw error
    }
    sessions.push(execution.sessionId)
    observations.push({ operationId: operation.operationId, operationDigest: hash(operation), executionId: execution.executionId,
      sessionId: execution.sessionId, nativeLogDigest: stored.digest, scriptDigest: plan.scriptDigest,
      historicalOutcome: 'unknown', ledgerDrainedUnchanged: true, observation: observed })
  }
  if (tables.executions.some(row => row.drained === false && !sessions.includes(row.sessionId))) fail()
  return { schema: proposal.schema, operatorApproval: proposal.operatorApproval, proposalDigest: hash(proposal),
    preservedSessionIds: sessions, retained: observations, ledgerDigest: hash(tables), writes: 0 }
}
