import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createWorkflowApprovalService } from '../packages/dingtalk-dsh-assistant/workflow-approval.js'

test('同一效果的 Web/钉钉审批首终态生效；无权及跨任务拒绝', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workflow-approval-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'approval', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  t.after(() => store.close())
  await store.command({ id: 'create', kind: 'run.create', args: { runId: 'run', taskId: 'task', workflowId: 'release',
    workflowDigest: 'a'.repeat(64), requirementRef: 'requirement', nodes: [{ nodeId: 'publish', nodeVersion: '1',
      executor: 'code', inputRef: 'input', inputDigest: 'b'.repeat(64) }] } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: {
    runId: 'run', nodeId: 'publish', expectedGeneration: 1, expectedLeaseEpoch: 0,
  } })
  let sends = 0, recoveries = 0
  const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => null,
    externalAdapter: { execute: async () => { sends++; return { status: 'succeeded', evidenceRef: 'readback' } }, reconcile: async () => ({ status: 'unknown' }) },
    authorizeExternal: async () => ({ principalId: 'owner', approval: { requestId: 'approval-1', approverIds: ['owner'] } }),
  })
  const prepared = { action: 'external', workflowKind: 'production-release', runId: 'run', generation: 1,
    requirementDigest: 'c'.repeat(64), resourceKey: 'external:production:service', taskId: 'task' }
  await assert.rejects(delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared }), { code: 'effect_approval_required' })
  const controller = { state: async () => ({ run: { taskId: 'task', runId: 'run' } }), recover: async () => { recoveries++ } }
  const approvals = createWorkflowApprovalService({ store, controller, authorizeTask: async ({ taskId, actorId, conversationId }) => taskId === 'task' && actorId === 'owner' && conversationId === 'group' })
  await assert.rejects(approvals.decide({ requestId: 'approval-1', decision: 'approved', eventId: 'unauthorized' },
    { channel: 'im', actorId: 'outsider', conversationId: 'group' }), { code: 'WORKFLOW_APPROVAL_FORBIDDEN' })
  assert.equal((await store.query({ kind: 'approval.get', requestId: 'approval-1' })).decision, 'pending')
  const first = await approvals.decide({ requestId: 'approval-1', decision: 'approved', eventId: 'web-1' },
    { channel: 'web', actorId: 'owner', conversationId: 'group' })
  assert.equal(first.decision, 'approved'); assert.equal(first.decisionSource, 'web'); assert.equal(recoveries, 1)
  const second = await approvals.decide({ requestId: 'approval-1', decision: 'rejected', eventId: 'im-2' },
    { channel: 'im', actorId: 'owner', conversationId: 'group' })
  assert.equal(second.decision, 'approved'); assert.equal(second.applied, false); assert.equal(recoveries, 1)
  await assert.rejects(delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) },
    action: 'external', prepared: { ...prepared, resourceKey: 'external:production:other-service' } }),
  { code: 'DELIVERY_IDENTITY_CONFLICT' })
  assert.equal(sends, 0)
  assert.equal((await delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared })).state, 'succeeded')
  assert.equal(sends, 1)
})
