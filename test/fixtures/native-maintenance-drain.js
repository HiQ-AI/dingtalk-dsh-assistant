import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolationDigest as hash } from '../../packages/dingtalk-dsh-assistant/native-restart-isolation.js'

// The installer's actual file shapes, including PowerShell's one-child object.
export async function maintenanceEvidenceFixture(root, binding, events, rawText) {
  const directory = join(root, 'maintenance-audit'), logs = join(root, 'tasks', binding.taskId, '.dsh', 'sessions')
  await mkdir(directory, { recursive: true }); await mkdir(logs, { recursive: true })
  const text = rawText ?? [{ type: 'session', id: binding.sessionId, timestamp: '2026-01-01T00:00:00Z' }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'
  const logFile = join(logs, 'session.v4.jsonl'); await writeFile(logFile, text)
  const expectedHost = { pid: 412, creationDate: '2026-01-01T00:00:00.123456Z', commandLineSha256: 'a'.repeat(64) }
  const frozen = { executionId: binding.executionId,
    binding: Object.fromEntries(['taskId','executionId','sessionId','requirementRevision','controlRevision','inputVersion','inputDigest','leaseEpoch'].map(key => [key, binding[key]])),
    taskDigest: 'b'.repeat(64), executionDigest: 'c'.repeat(64), nativeLogDigest: hash({ text }), terminalSequence: events.findLast(event => event.type === 'turn/end').seq,
    cancelResponse: { statusCode: 400, observedAt: '2026-01-01T00:01:00Z', body: { error: 'execution_session_drain_failed: Windows Job runner exited before proving managed range empty' } } }
  const proposal = { schema: 'native-drain-maintenance-v1', controlDigestFormat: 'sqlite-row-stream-v1', controlDigest: 'd'.repeat(64), expectedHost,
    operatorApproval: { kind: 'explicit-stop-deploy-resume', authorizedAt: '2026-01-01T00:00:30Z', sourceRef: 'operator-maintenance-approval' }, executions: [frozen] }
  const { cancelResponse, ...retained } = frozen
  const maintenance = { schema: proposal.schema, controlDigestFormat: proposal.controlDigestFormat, proposalDigest: hash(proposal), ledgerDigest: proposal.controlDigest,
    retained: [{ ...retained, cancelResponseDigest: hash(cancelResponse), ledgerDrainedUnchanged: true }], writes: 0 }
  const preflight = { candidateOnly: true, maintenanceReady: true, maintenance }, offline = { candidateOnly: false, quiescent: true, ownerProcessExited: true, maintenanceReady: true, maintenance }
  const artifacts = { 'drain-maintenance-proposal': proposal, 'drain-maintenance-preflight': preflight,
    control: { pid: expectedHost.pid, creationDate: expectedHost.creationDate, commandLineSha256: expectedHost.commandLineSha256 },
    'captured-descendants': { ProcessId: 413, ParentProcessId: 412, CreationDate: '2026-01-01T00:00:01Z', Name: 'pwsh.exe' },
    signal: { targetPid: expectedHost.pid, signalSent: 'CTRL_C_EVENT' },
    quiescent: { pid: expectedHost.pid, creationDate: expectedHost.creationDate, observedAt: '2026-01-01T00:02:00Z', shutdown: 'SIGINT', remainingDescendants: 0, runtimePortClosed: true, ledger: offline },
    'drain-maintenance-cutover': { maintenance, processesExited: true, drained: false, replayAllowed: false, recoveryRequired: true } }
  const save = async () => { for (const [name, value] of Object.entries(artifacts)) await writeFile(join(directory, name + '.json'), JSON.stringify(value)) }
  await save()
  return { evidence: { directory, expectedProposalDigest: hash(proposal) }, artifacts, logFile, text, save }
}
