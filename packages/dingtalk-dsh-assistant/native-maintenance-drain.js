import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { isolationDigest as hash } from './native-restart-isolation.js'

const fail = reason => { throw Object.assign(new Error('DYNAMIC_MAINTENANCE_' + reason), { code: 'DYNAMIC_MAINTENANCE_' + reason }) }
const time = value => typeof value === 'string' ? Date.parse(value) : NaN
const bindingKeys = ['taskId', 'executionId', 'sessionId', 'requirementRevision', 'controlRevision', 'inputVersion', 'inputDigest', 'leaseEpoch']

// Native v4 persists consecutive source sequences as ranges; inspection expands
// them. Compare ranges without expanding untrusted or very large intervals.
function comparableEvents(events) {
  return events.map(event => {
    if (!Object.hasOwn(event, 'sourceEventSeqs')) return event
    if (!Array.isArray(event.sourceEventSeqs)) fail('NATIVE_HISTORY_CHANGED')
    const ranges = []
    for (const value of event.sourceEventSeqs) {
      const range = Array.isArray(value) ? value : [value, value]
      if (range.length !== 2 || range.some(item => !Number.isSafeInteger(item) || item < 0) || range[1] < range[0]) fail('NATIVE_HISTORY_CHANGED')
      const previous = ranges.at(-1)
      if (previous && previous[1] + 1 === range[0]) previous[1] = range[1]
      else ranges.push([...range])
    }
    return { ...event, sourceEventSeqs: ranges }
  })
}

// Shared with the offline freezer: compare the original JSONL bytes, including feedback.
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

async function currentProcesses(identities) {
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED')
  const filter = identities.map(row => 'ProcessId = ' + row.ProcessId).join(' OR ')
  const script = `$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | ForEach-Object {
  @{ ProcessId=$_.ProcessId; CreationDate=$_.CreationDate.ToUniversalTime().ToString('o') }
})
ConvertTo-Json -InputObject $rows -Compress`
  const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const rows = JSON.parse(stdout.trim())
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.ProcessId) || !Number.isFinite(time(row.CreationDate)))) fail('PROCESS_OBSERVATION_INVALID')
  return rows
}

// An authenticated operator selects the existing installation audit. This is a
// stopped-host-tree proof, never a native Job receipt or an effect settlement.
export async function readMaintenanceDrainProof({ workspace, binding, events, evidence, calls = [], operations = [], observeProcesses = currentProcesses, history = readNativeHistory }) {
  if (!isAbsolute(evidence?.directory ?? '') || !/^[a-f0-9]{64}$/u.test(evidence?.expectedProposalDigest ?? '')
    || !/^[\w][\w.-]*$/u.test(binding.taskId)) fail('EVIDENCE_INVALID')
  if (lstatSync(evidence.directory).isSymbolicLink()) fail('EVIDENCE_INVALID')
  const names = ['drain-maintenance-proposal', 'drain-maintenance-preflight', 'control', 'captured-descendants', 'signal', 'quiescent', 'drain-maintenance-cutover']
  const artifacts = Object.fromEntries(names.map(name => {
    const file = join(evidence.directory, name + '.json'), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('EVIDENCE_INVALID')
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
    const value = text.trim() ? JSON.parse(text) : name === 'captured-descendants' ? [] : fail('EVIDENCE_INVALID')
    return [name, name === 'captured-descendants' && !Array.isArray(value) ? [value] : value]
  }))
  const proposal = artifacts['drain-maintenance-proposal'], pre = artifacts['drain-maintenance-preflight']
  const control = artifacts.control, children = artifacts['captured-descendants'], signal = artifacts.signal
  const stopped = artifacts.quiescent, cutover = artifacts['drain-maintenance-cutover'], post = stopped.ledger
  if (proposal.schema !== 'native-drain-maintenance-v1' || proposal.controlDigestFormat !== 'sqlite-row-stream-v1'
    || hash(proposal) !== evidence.expectedProposalDigest || proposal.operatorApproval?.kind !== 'explicit-stop-deploy-resume'
    || !proposal.operatorApproval.sourceRef || !Number.isFinite(time(proposal.operatorApproval.authorizedAt))
    || !Array.isArray(proposal.executions) || !proposal.executions.length
    || new Set(proposal.executions.map(row => row.executionId)).size !== proposal.executions.length) fail('PROPOSAL_INVALID')
  const frozen = proposal.executions.find(row => row.executionId === binding.executionId)
  if (!frozen || !bindingKeys.every(key => frozen.binding?.[key] === binding[key])) fail('BINDING_STALE')
  const pid = proposal.expectedHost?.pid, created = time(proposal.expectedHost?.creationDate)
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(created) || control.pid !== pid || time(control.creationDate) !== created
    || !/^[a-f0-9]{64}$/u.test(proposal.expectedHost.commandLineSha256 ?? '') || control.commandLineSha256 !== proposal.expectedHost.commandLineSha256
    || stopped.pid !== pid || time(stopped.creationDate) !== created
    || signal.targetPid !== pid || signal.signalSent !== 'CTRL_C_EVENT') fail('HOST_IDENTITY')
  const observedAt = time(stopped.observedAt)
  if (!Number.isFinite(observedAt) || observedAt < created || observedAt < time(proposal.operatorApproval.authorizedAt) || observedAt > Date.now()
    || stopped.shutdown !== 'SIGINT' || stopped.remainingDescendants !== 0 || stopped.runtimePortClosed !== true
    || cutover.processesExited !== true || cutover.drained !== false || cutover.replayAllowed !== false || cutover.recoveryRequired !== true
    || pre?.candidateOnly !== true || post?.candidateOnly !== false || post.quiescent !== true || post.ownerProcessExited !== true
    || pre.maintenanceReady !== true || post.maintenanceReady !== true) fail('CUTOVER_UNPROVEN')
  for (const proof of [pre.maintenance, post.maintenance, cutover.maintenance]) {
    const retained = proof?.retained?.find(row => row.executionId === binding.executionId)
    const { cancelResponse, ...row } = frozen
    if (proof?.schema !== proposal.schema || proof.controlDigestFormat !== proposal.controlDigestFormat
      || proof.proposalDigest !== evidence.expectedProposalDigest || proof.ledgerDigest !== proposal.controlDigest
      || proof.writes !== 0 || hash(retained) !== hash({ ...row, cancelResponseDigest: hash(cancelResponse), ledgerDrainedUnchanged: true })) fail('CUTOVER_UNPROVEN')
  }
  if (hash(pre.maintenance) !== hash(post.maintenance) || hash(post.maintenance) !== hash(cutover.maintenance)) fail('CUTOVER_UNPROVEN')
  const stored = history(workspace, binding)
  // Persistence inspection excludes the JSONL header; the remaining native events must agree.
  if (stored.events[0]?.type !== 'session' || stored.events[0].id !== binding.sessionId) fail('NATIVE_HISTORY_CHANGED')
  const nativeEvents = stored.events.slice(1)
  if (stored.digest !== frozen.nativeLogDigest || hash(comparableEvents(nativeEvents)) !== hash(comparableEvents(events))) fail('NATIVE_HISTORY_CHANGED')
  const inputs = events.flatMap(event => event.type === 'user/message' ? [{ seq: event.seq, source: event.data?.source }]
    : event.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? []).filter(message => message.role === 'user').map(message => ({ seq: event.seq, source: message.source })) : [])
  const input = inputs.findLast(item => Object.hasOwn(item.source ?? {}, 'executionSession'))
  const end = events.findLast(event => event.type === 'turn/end'), start = events.findLast(event => event.type === 'turn/start')
  if (!input || !bindingKeys.filter(key => !['taskId', 'executionId'].includes(key)).every(key => input.source.executionSession?.[key] === binding[key])
    || !end || !start || end.seq !== frozen.terminalSequence || end.seq <= input.seq || end.seq <= start.seq
    || inputs.some(item => item.seq > end.seq) || events.some(event => event.seq > end.seq && ['tool/call', 'job/registered'].includes(event.type))) fail('NATIVE_HISTORY_CHANGED')
  const pendingOperations = calls.map(call => {
    const operation = operations.find(item => item.taskId === binding.taskId && item.executionId === binding.executionId
      && item.key === `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${call.data.callId}`)
    let args
    try { args = JSON.parse(call.data.arguments) } catch { fail('CALL_UNBOUND') }
    if (!operation || operation.state !== 'unknown' || !bindingKeys.every(key => operation.dispatchBinding?.[key] === binding[key])
      || operation.definition.toolName !== call.data.name || operation.definition.argumentsDigest !== hash(args)) fail('CALL_UNBOUND')
    return { operationId: operation.operationId, operationDigest: hash(operation), callId: call.data.callId, sequence: call.seq }
  })
  if (!Array.isArray(children)) fail('PROCESS_TREE_INVALID')
  const root = { ProcessId: pid, CreationDate: proposal.expectedHost.creationDate }, identities = [root, ...children]
  const byPid = new Map(identities.map(row => [row.ProcessId, row]))
  if (byPid.size !== identities.length || identities.some(row => !Number.isSafeInteger(row.ProcessId) || row.ProcessId < 1
    || !Number.isFinite(time(row.CreationDate)) || time(row.CreationDate) > observedAt)) fail('PROCESS_TREE_INVALID')
  for (const child of children) {
    const seen = new Set(); let cursor = child
    while (cursor.ProcessId !== pid) {
      if (seen.has(cursor.ProcessId)) fail('PROCESS_TREE_INVALID')
      seen.add(cursor.ProcessId)
      const parent = byPid.get(cursor.ParentProcessId)
      if (!parent || time(cursor.CreationDate) < time(parent.CreationDate)) fail('PROCESS_TREE_INVALID')
      cursor = parent
    }
  }
  const current = await observeProcesses(identities)
  if (!Array.isArray(current) || current.some(row => !Number.isFinite(time(row.CreationDate))
    || identities.some(original => original.ProcessId === row.ProcessId && time(original.CreationDate) === time(row.CreationDate)))) fail('PROCESS_REMAINS')
  return { kind: 'native-maintenance-drain', binding, proposalDigest: evidence.expectedProposalDigest, evidenceDigest: hash(artifacts),
    evidenceDirectory: evidence.directory, nativeLogDigest: stored.digest, terminalSequence: end.seq,
    observedAt: new Date().toISOString(), stoppedAt: stopped.observedAt, originalHost: proposal.expectedHost,
    capturedProcessCount: identities.length, pendingOperations, processesExited: true, noReplay: true, partialEffectsPossible: true,
    basis: 'operator-reviewed-maintenance-cutover' }
}
