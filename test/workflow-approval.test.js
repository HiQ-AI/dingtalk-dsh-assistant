import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createWorkflowApprovalService } from '../packages/dingtalk-dsh-assistant/workflow-approval.js'

for (const [decision, channel] of [['approved', 'web'], ['rejected', 'web'], ['rejected', 'im']]) test(`同一效果的 Web/钉钉审批首终态生效；无权及跨任务拒绝 ${decision}/${channel}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workflow-approval-'))
  let store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'approval', initialize: true })
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
  const prepared = { action: 'external', workflowKind: decision === 'approved' ? 'production-release' : 'data-change',
    ...(decision === 'rejected' ? { stage: 'approval-gate', intent: { approvalSource: 'assistant' } } : {}), runId: 'run', generation: 1,
    requirementDigest: 'c'.repeat(64), resourceKey: 'external:production:service', taskId: 'task' }
  await assert.rejects(delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared }), { code: 'effect_approval_required' })
  const controller = { state: async () => ({ run: { taskId: 'task', runId: 'run' } }), recover: async () => { recoveries++ } }
  const approvals = createWorkflowApprovalService({ store, controller, authorizeTask: async ({ taskId, actorId, conversationId }) => taskId === 'task' && actorId === 'owner' && conversationId === 'group' })
  await assert.rejects(approvals.decide({ requestId: 'approval-1', decision: 'approved', eventId: 'unauthorized' },
    { channel: 'im', actorId: 'outsider', conversationId: 'group' }), { code: 'WORKFLOW_APPROVAL_FORBIDDEN' })
  assert.equal((await store.query({ kind: 'approval.get', requestId: 'approval-1' })).decision, 'pending')
  const first = await approvals.decide({ requestId: 'approval-1', decision, eventId: 'first-1', comment: 'name 列使用 character varying，保留已有数据'  },
    { channel, actorId: 'owner', conversationId: 'group' })
  assert.equal(first.decision, decision); assert.equal(first.decisionSource, channel === 'web' ? 'web' : 'dingtalk'); assert.equal(recoveries, 1)
  const second = await approvals.decide({ requestId: 'approval-1', decision: decision === 'approved' ? 'rejected' : 'approved', eventId: 'im-2', comment: '不得覆盖首个真实意见' },
    { channel: 'im', actorId: 'owner', conversationId: 'group' })
  assert.equal(second.decision, decision); assert.equal(second.applied, false); assert.equal(recoveries, 1)
  await assert.rejects(delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) },
    action: 'external', prepared: { ...prepared, resourceKey: 'external:production:other-service' } }),
  { code: 'DELIVERY_IDENTITY_CONFLICT' })
  assert.equal(sends, 0)
  assert.equal((await delivery.execute({ binding: { ...binding, requirementDigest: 'c'.repeat(64) }, action: 'external', prepared })).state, decision === 'approved' ? 'succeeded' : 'failed')
  assert.equal(sends, decision === 'approved' ? 1 : 0)
  await store.close()
  if (decision === 'rejected') {
    const db = new DatabaseSync(join(dir, 'control.db'), { readOnly: true })
    try {
      const observation = JSON.parse(db.prepare('SELECT payload_json FROM execution_effect_observations WHERE receipt_id=?').get('approval-rejected:approval-1').payload_json)
      assert.equal(observation.result.mutationAttempted, false)
      assert.equal(observation.status, 'failed')
    } finally { db.close() }
  }
  store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'approval', initialize: false })
  const saved = await store.query({ kind: 'approval.get', requestId: 'approval-1' })
  assert.equal(saved.comment, 'name 列使用 character varying，保留已有数据')
  assert.equal((await store.query({ kind: 'approval.list' }))[0].comment, saved.comment)
  assert.equal(saved.decision, decision)
})
