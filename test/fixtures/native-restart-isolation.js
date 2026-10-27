import { isolationDigest as hash, isolationBinding } from '../../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { sessionPersistenceFixture } from './session-persistence.js'

export function restartFixture(launchAcknowledged = true, commandOverride) {
 const binding = { kind: 'task-execution', taskId: 'task', executionId: 'original', sessionId: 'original-session', inputVersion: 2, leaseEpoch: 2, inputDigest: 'input' }
 const args = { command: commandOverride ?? (launchAcknowledged ? 'isolated-postgres-command' : 'isolated-maven-command') }
 const operation = { operationId: 'operation', taskId: binding.taskId, executionId: binding.executionId, dispatchBinding: binding,
  ownerBinding: binding, key: 'native:original:2:2:original-call', state: 'unknown', recoveryReason: 'host_restart', result: null,
  definition: { toolName: 'pwsh', effectClass: 'unknown', argumentsDigest: hash(args) }, updatedAt: '2026-10-27T07:32:20Z',
  job: { jobId: 'pwsh-redacted-original', owner: binding.sessionId, startedAt: Date.parse('2026-10-27T07:31:13Z'), status: 'running' } }
 const execution = { ...binding, drained: launchAcknowledged, recovering: !launchAcknowledged, status: launchAcknowledged ? 'queued' : 'running' }
 const readback = { ...binding, executionId: 'investigation', sessionId: 'investigation-session', inputDigest: 'investigation-input',
  status: 'succeeded', drained: true, recovering: false, definition: { recoveryReadOnly: true }, input: { readbackOperationId: operation.operationId }, updatedAt: '2026-10-27T08:29:00Z' }
 const seed = identity => ({ seq: 0, type: 'plugin:dingtalk/execution-session', data: { version: 2, identity, creationLease: 1 } })
 const input = b => ({ seq: 1, type: 'user/message', data: { source: { executionSession: b } } })
 const original = [seed(binding), input(binding), { seq: 2, type: 'tool/call', data: { name: 'pwsh', callId: 'original-call', arguments: JSON.stringify(args) } },
  { seq: 3, type: 'job/registered', data: { ...operation.job, kind: 'pwsh', label: args.command, toolCall: { callId: 'original-call', rootCallId: 'original-call' } } }]
 if (launchAcknowledged) original.push({ seq: 4, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'original-call', isError: false,
  content: [{ type: 'text', text: JSON.stringify({ nativeJobReceipt: operation.job }) }] } } })
 const reads = [seed(readback), input(readback), { seq: 2, type: 'tool/call', data: { callId: 'read-call', name: 'read', arguments: '{"file_path":"original-evidence.json"}' } },
  { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'read-call', isError: false, content: [{ type: 'text', text: 'Observed historical effects; exit remains unknown' }] } } }]
 const receipt = { kind: 'native-job-durable-isolation', receiptId: 'host-isolation-1', issuer: 'trusted-host-range-owner',
  fenceRef: 'durable-original-range-fence', hostExitRef: 'verified-host-fatal-record', originalHostExited: true,
  durableFence: true, managedRangeEmpty: true, externalWritersExcluded: true, activeWriterCount: 0,
  observedAt: '2026-10-27T08:30:00Z', binding: isolationBinding(operation, 'original-call') }
 let verified = true
 const authority = { readIsolation: async () => structuredClone(receipt), verifyIsolation: async () => verified }
 const live = new Set(), jobs = []
 const ctx = { agents: { get: id => live.has(id) }, sessions: { get: () => undefined },
  get: name => name === 'jobs' ? { list: () => jobs } : name === 'nativeJobRecovery' ? authority : undefined,
  sessionPersistence: sessionPersistenceFixture(async id => ({ meta: { id }, events: id === binding.sessionId ? original : reads })) }
 return { operation, execution, executions: [execution, readback], readback, ctx, original, reads, receipt, authority, live, jobs,
  revoke: () => { verified = false } }
}
