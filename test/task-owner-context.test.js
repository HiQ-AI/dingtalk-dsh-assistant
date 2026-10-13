import assert from 'node:assert/strict'
import test from 'node:test'
import { projectOwnerContext, measureOwnerContext } from '../packages/dingtalk-dsh-assistant/task-owner-context.js'
import { executionDigest, readTaskMaterialIndexPage } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { ownerImmutableReadReceipts, retainOwnerContextBase } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'

export function fixture() {
  const values = new Map()
  const artifacts = { async put(value, { taskId }) {
    const ref = `tasks/${taskId}/sha256-${executionDigest(value)}.json`
    values.set(ref, structuredClone(value)); return { ref }
  }, async read(ref) { assert.ok(values.has(ref)); return structuredClone(values.get(ref)) } }
  return { artifacts, values }
}

export function stressInput(rounds = 12) {
  const text = '必须暂停生产；先审批再写入。executor旧总结和旧head baeb；当前head 152a609f。'.repeat(400)
  const sources = Array.from({ length: rounds }, (_, i) => ({ sourceKey: 'user', sourceVersion: i + 1, actorId: 'human', text }))
  return { taskId: 'task-stress', eventWatermark: 815, goal: { request: '修复并核验', objective: '修复并核验', constraints: [text, text],
    authorization: { actorId: 'human', channel: 'dingtalk' }, acceptanceCriteria: ['覆盖最新用户要求'], sourceInstructions: sources },
    currentSources: sources, acceptanceItems: [{ itemId: 'accept-current', criterion: '覆盖最新用户要求' }],
    task: { requirementRevision: 12, controlState: 'paused' }, stages: [], stageArtifacts: [{ domainEvidence: text }],
    correction: { instruction: text }, events: [{ eventSeq: 815, eventType: 'intent.received', payloadRef: 'new-input' }],
    sharedMaterials: { logicalTaskId: 'task-stress', indexTool: 'task_owner_list_materials' } }
}

test('large repeated instructions become lossless readable deduplicated references; host input unchanged', async () => {
  const f = fixture(), input = stressInput(), original = structuredClone(input)
  const projection = await projectOwnerContext(input, f.artifacts)
  assert.deepEqual(input, original)
  assert.ok(JSON.stringify(projection.modelInput).length < JSON.stringify(input).length / 10)
  assert.equal(projection.modelInput.task.controlState, 'paused')
  assert.deepEqual(projection.modelInput.events, input.events)
  const ref = projection.modelInput.goal.constraints[0].contextRef
  assert.ok(projection.requiredRefs.includes(ref))
  assert.equal((await f.artifacts.read(ref)).value, input.goal.constraints[0])
  assert.equal(projection.modelInput.goal.sourceInstructions[0].text.contextRef, ref)
  assert.equal(projection.modelInput.currentSources[0].text.contextRef, ref)
  assert.equal(f.values.size, 2) // string body and stage evidence section
  const repeated = await projectOwnerContext(input, f.artifacts)
  assert.deepEqual(repeated, projection)
  assert.ok(measureOwnerContext(input).some(field => field.path === 'goal.constraints'))
})

test('new user requirements and changed approval survive retry, source identity remains independently traceable', async () => {
  const f = fixture(), input = stressInput(1)
  const first = await projectOwnerContext(input, f.artifacts)
  input.goal.constraints.push('新增要求：仍需真人审批；不重发未知效果。'.repeat(200))
  input.goal.sourceInstructions.push({ sourceKey: 'new-user', sourceVersion: 1, actorId: 'human', text: '新增要求：核验恢复诊断。'.repeat(250) })
  const second = await projectOwnerContext(input, f.artifacts)
  assert.ok(second.requiredRefs.length > first.requiredRefs.length)
  assert.equal(second.modelInput.goal.sourceInstructions[1].sourceKey, 'new-user')
  assert.match((await f.artifacts.read(second.modelInput.goal.constraints[2].contextRef)).value, /真人审批/)
  assert.match((await f.artifacts.read(second.modelInput.goal.sourceInstructions[1].text.contextRef)).value, /恢复诊断/)
})

test('multi-round repeated text grows by source identity metadata, not repeated long body', async () => {
  const f = fixture(), sizes = []
  for (const rounds of [1, 10, 50]) sizes.push(JSON.stringify((await projectOwnerContext(stressInput(rounds), f.artifacts)).modelInput).length)
  assert.ok(sizes[2] - sizes[1] < 40000)
  assert.equal(f.values.size, 2)
})

test('material page opens only selected entries, hides diagnostics and preserves immutable source references', async () => {
  const f = fixture(), names = []
  for (let i = 0; i < 120; i++) {
    const saved = await f.artifacts.put({ kind: 'agent-query-evidence', execution: { requirementRevision: i === 0 ? 12 : 1 }, result: { text: 'body'.repeat(10000) }, id: i }, { taskId: 'task-stress' })
    names.push(saved.ref.split('/').at(-1))
  }
  const hidden = await f.artifacts.put({ kind: 'private-diagnostic', privateDiagnostic: 'do not enumerate' }, { taskId: 'task-stress' })
  names.splice(1, 0, hidden.ref.split('/').at(-1))
  let reads = 0
  const artifacts = { async read(ref) { reads++; return f.artifacts.read(ref) } }
  const args = { logicalTaskId: 'task-stress', names, artifacts, requirementRevision: 12, offset: 0, limit: 10 }
  const page = await readTaskMaterialIndexPage(args)
  assert.equal(reads, 10); assert.equal(page.entries.length, 9); assert.equal(page.nextCursor, 10)
  assert.equal(page.entries[0].status, 'current'); assert.equal(page.entries[1].status, 'history')
  assert.ok(!JSON.stringify(page).includes('body')); assert.ok(!page.entries.some(entry => entry.artifactRef === hidden.ref))
  assert.deepEqual(await readTaskMaterialIndexPage(args), page)
  await assert.rejects(readTaskMaterialIndexPage({ ...args, limit: 101 }), { code: 'TASK_MATERIAL_ARGUMENT_INVALID' })
})

test('explicitly superseded source versions are deferred while authorization-bound old versions stay required', async () => {
  const f = fixture(), input = stressInput(3)
  input.goal.scope = { sourceVersions: { user: 3 } }
  input.goal.stageAuthorizations = [{ sourceKey: 'user', sourceVersion: 1, sourceQuote: '真人审批', gate: 'confirmation' }]
  const result = await projectOwnerContext(input, f.artifacts), sources = result.modelInput.goal.sourceInstructions
  assert.deepEqual(sources.current.map(source => source.sourceVersion), [1, 3])
  assert.deepEqual((await f.artifacts.read(sources.history.contextRef)).value.map(source => source.sourceVersion), [2])
  assert.equal(sources.history.requiredBeforeSubmit, false)
  assert.ok(result.requiredRefs.includes(sources.current[0].text.contextRef))
})

test('read reuse requires complete original successful pages, exact digest, matching task/session and consistent overlap', () => {
  const binding = { taskId: 'task', sessionId: 'owner' }, value = { kind: 'owner-context-section', value: 'AUTHORIZATION'.repeat(300) }
  const ref = `sha256-${executionDigest(value)}.json`, text = JSON.stringify(value), split = 2000
  const input = taskId => ({ seq: 0, type: 'user/message', surfaceOp: 'append', data: {
    source: { taskOwner: { taskId, sessionId: 'owner' } }, content: [] } })
  const call = (id, offset, seq) => ({ seq, type: 'tool/call', data: { callId: id, name: 'task_owner_read_artifact', arguments: { artifactRef: ref, offset } } })
  const result = (id, artifact, seq, isError = false, surfaceOp = 'append') => ({ seq, type: 'tool/result', surfaceOp, data: { message: { content: [
    { toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify({ artifact, totalLength: text.length }) }] },
  ] } } })
  const events = [input('task'), call('a', 0, 1), result('a', text.slice(0, split), 2), call('b', split, 3), result('b', text.slice(split), 4)]
  const receipts = ownerImmutableReadReceipts(events, binding)
  assert.equal(receipts.get(ref).kind, 'owner-context-section'); assert.deepEqual([...receipts.get(ref).retained], [2, 4])
  for (const invalid of [events.slice(0, 3), [input('foreign'), ...events.slice(1)],
    [events[0], events[1], result('a', text, 2, true)],
    [events[0], events[1], result('a', text, 2, false, { op: 'replace', start: 2, end: 2 })],
    [events[0], events[1], result('a', text.replace('AUTHORIZATION', 'CHANGED______'), 2)],
    [...events, call('c', 10, 5), result('c', 'bad overlap', 6)],
  ]) assert.equal(ownerImmutableReadReceipts(invalid, binding).size, 0)
  assert.equal(ownerImmutableReadReceipts(events, { ...binding, sessionId: 'other' }).size, 0)
})


test('growing receipt lists and workflow catalog are deferred losslessly without hiding current obligations', async () => {
  const f = fixture(), input = { taskId: 'task-context',
    goal: { request: '核验真实行为', constraints: ['只核验，不部署'], authorization: { actorId: 'human' } },
    events: [{ eventSeq: 99, eventType: 'system.recovery', payloadRef: 'current-recovery' }],
    completionEvidenceRefs: Array.from({ length: 60 }, (_, i) => `tasks/task-context/sha256-${String(i).padStart(64, '0')}.json`),
    workflowCatalog: Array.from({ length: 10 }, (_, i) => ({ id: `workflow-${i}`, purpose: '按实际需要选择受管流程', contract: { detail: 'scope-and-evidence '.repeat(20) } })) }
  const original = structuredClone(input), result = await projectOwnerContext(input, f.artifacts)
  assert.deepEqual(input, original)
  assert.deepEqual(result.modelInput.goal, input.goal)
  assert.deepEqual(result.modelInput.events, input.events)
  assert.ok(JSON.stringify(result.modelInput).length < JSON.stringify(input).length / 3)
  for (const field of ['completionEvidenceRefs', 'workflowCatalog']) {
    const ref = result.modelInput[field].contextRef
    assert.ok(result.readableRefs.includes(ref))
    assert.equal(result.modelInput[field].requiredBeforeSubmit, false)
    assert.deepEqual((await f.artifacts.read(ref)).value, original[field])
  }
  assert.deepEqual(result.requiredRefs, [])
  const small = { taskId: 'small', completionEvidenceRefs: ['actual-ref'], workflowCatalog: [{ id: 'known', purpose: 'small' }] }
  const projected = await projectOwnerContext(small, f.artifacts)
  assert.deepEqual(projected.modelInput.completionEvidenceRefs, small.completionEvidenceRefs)
  assert.deepEqual(projected.modelInput.workflowCatalog, small.workflowCatalog)
})

test('duplicate source text resolves within the same input while identities and differing requirements survive', async () => {
  const f = fixture(), text = '核验一位专家通过另一位退回后是否禁止撤回；仅核验，不修复部署。'.repeat(4)
  const input = { taskId: 'dedup', goal: { request: text, sourceInstructions: [
    { sourceKey: 'a', sourceVersion: 1, actorId: 'human-a', text },
    { sourceKey: 'b', sourceVersion: 2, actorId: 'human-b', text: text + '新增要求' },
  ] }, currentSources: [{ sourceKey: 'a', sourceVersion: 1, actorId: 'human-a', text, attachments: ['attachment'] }] }
  const original = structuredClone(input), { modelInput } = await projectOwnerContext(input, f.artifacts)
  const resolve = value => value?.sameAs ? value.sameAs.reduce((node, key) => node[key], modelInput) : value
  assert.deepEqual(input, original)
  assert.equal(resolve(modelInput.goal.request), text)
  assert.equal(resolve(modelInput.currentSources[0].text), text)
  assert.equal(modelInput.goal.sourceInstructions[1].text, text + '新增要求')
  assert.deepEqual({ ...modelInput.currentSources[0], text: resolve(modelInput.currentSources[0].text) }, input.currentSources[0])
  assert.ok(JSON.stringify(modelInput.goal).length + JSON.stringify(modelInput.currentSources).length < JSON.stringify(input.goal).length + JSON.stringify(input.currentSources).length)
})

test('visible base survives continuation, updates removed constraints, and restores after compaction without historical assumptions', async () => {
  const events = [], session = { surface: { nodes: [] }, snapshotEvents: () => events,
    append(type, data, options = {}) {
      const seq = events.length
      events.push({ type, data: structuredClone(data), seq, ...options })
      if (options.surfaceOp?.op === 'replace') this.surface.nodes = this.surface.nodes.filter(id => id !== options.surfaceOp.startSeq)
      this.surface.nodes.push(seq)
    } }
  const binding = { taskId: 'one', sessionId: 'owner' }, f = fixture()
  const text = '核验撤回限制，当前不授权部署。'.repeat(10)
  const raw = { taskId: 'one', goal: { request: text, constraints: ['不部署'], sourceInstructions: [{ sourceKey: 'a', text }] },
    currentSources: [{ sourceKey: 'a', text }], task: { requirementRevision: 1 }, events: [] }
  const { modelInput } = await projectOwnerContext(raw, f.artifacts)
  const dynamic = retainOwnerContextBase(session, binding, modelInput)
  const currentBase = () => JSON.parse(events[session.surface.nodes.at(-1)].data.content[0].text).ownerContextBase
  const merged = { ...currentBase(), ...dynamic }; delete merged.contextBaseDigest
  assert.deepEqual(merged, modelInput)
  assert.equal(merged.goal.request.sameAs.reduce((node, key) => node[key], merged), text)
  retainOwnerContextBase(session, binding, { ...modelInput, events: [{ eventSeq: 2 }] })
  assert.equal(events.length, 1, 'unchanged base does not append another event')
  const changed = { ...modelInput, goal: { ...modelInput.goal, constraints: ['只允许隔离环境测试'] } }
  retainOwnerContextBase(session, binding, changed)
  assert.equal(session.surface.nodes.length, 1)
  assert.deepEqual(currentBase().goal.constraints, ['只允许隔离环境测试'])
  session.surface.nodes = [] // Compaction removed the visible base; audit still exists.
  retainOwnerContextBase(session, binding, changed)
  assert.equal(events.length, 3)
  assert.deepEqual(currentBase().goal, changed.goal)
  retainOwnerContextBase(session, { ...binding, sessionId: 'other' }, changed)
  assert.equal(events.length, 4, 'another session cannot reuse this base')
  assert.deepEqual(raw.goal.constraints, ['不部署'])
})

