// Synthetic structure only; no production identities, messages, or attachments.
export function context172Fixture() {
  const stageProgress = { summary: 'SYNTHETIC_STAGE '.repeat(26), evidence: ['synthetic-stage-evidence'], sequence: 3,
    inputVersion: 4, leaseEpoch: 2, requirementRevision: 5, controlRevision: 6, recordedAt: '2026-10-15T00:00:00Z' }
  const executions = Array.from({ length: 3 }, (_, i) => ({ executionId: 'history-' + i, key: 'history-' + i, status: 'succeeded', drained: true,
    input: { title: '历史核验' + i, objective: ('HISTORICAL_GOAL_' + i + ' ').repeat(58) }, result: { current: false, receivedAt: '2026-10-15T00:00:00Z' } }))
  executions.push({ executionId: 'active', key: 'active', status: 'running', drained: false, inputVersion: 4, leaseEpoch: 2,
    requirementRevision: 5, controlRevision: 6, input: { objective: '当前委派核验目标' }, stageProgress })
  const operations = Array.from({ length: 7 }, (_, i) => ({ operationId: 'operation-' + i, executionId: 'active', state: i === 6 ? 'unknown' : 'starting',
    requirementRevision: 5, controlRevision: 6, resourceKeys: ['synthetic-resource-' + i], evidenceRef: 'receipt-' + i,
    authorizationRef: 'source:authority:1', definition: { toolName: 'synthetic_effect', effectClass: 'write', arguments: { body: 'synthetic operation argument '.repeat(10) } } }))
  return { task: { taskId: 'synthetic-task', objective: '当前目标：仅本地核验', requirementRevision: 5, controlRevision: 6,
    metadata: { authorizationSourceId: 'authority' } },
    sources: [{ sourceId: 'authority', actorId: 'synthetic-owner', version: 1, text: '仅本地分析，禁止发布' },
      { sourceId: 'correction', actorId: 'synthetic-operator', version: 2, corrects: 'authority', text: '新更正：可准备方案，仍禁止发布' }],
    executions, operations, blockers: { executions: [executions.at(-1)], operations },
    wakes: [{ wakeId: 'stage', kind: 'execution.stage.progress', payload: { executionId: 'active', ...stageProgress } },
      { wakeId: 'new-message', kind: 'source.received', payload: { sourceId: 'correction', version: 2 } }] }
}
