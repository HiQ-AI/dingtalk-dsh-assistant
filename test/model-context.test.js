import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { taskExecutionContext } from '../packages/dingtalk-dsh-assistant/execution-context.js'
import { createModelContentIndex, taskModelInput, executionModelInput, operationModelReadback } from '../packages/dingtalk-dsh-assistant/model-context.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'model-content-')); t.after(() => rm(root, { recursive: true, force: true }))
  const session = Session.create('content-fixture')
  return { root, session, index: createModelContentIndex(session, { root }) }
}
test('integrated projection keeps stage evidence and provider decisions bound to the original versions', async t => {
  const { index } = await fixture(t)
  const stageProgress = { summary: '阶段事实'.repeat(150), evidence: ['original-evidence-ref'], sequence: 3, recordedAt: '2026-10-14T17:00:00Z', inputVersion: 4, leaseEpoch: 2, requirementRevision: 5, controlRevision: 6 }
  const recovery = { decision: 'scheduled', attempts: 2, nextAttemptAt: '2026-10-14T17:00:05Z' }
  const execution = { executionId: 'execution', taskId: 'task', sessionId: 'session', inputVersion: 4, inputDigest: 'original-input-digest', leaseEpoch: 2, requirementRevision: 5, controlRevision: 6,
    status: 'queued', drained: true, stageProgress, providerRecovery: { attempts: 2, nextAttemptAt: recovery.nextAttemptAt },
    result: { current: true, inputVersion: 4, leaseEpoch: 2, requirementRevision: 5, controlRevision: 6, recovery, payload: { error: { code: 'EXECUTION_PROVIDER_TRANSIENT', providerError: { code: 'SERVER', message: 'full retained diagnostics'.repeat(1000) } } } } }
  const lastDecision = { action: 'wait', summary: '已确认整体进展', at: '2026-10-14T16:59:00Z', requirementRevision: 5, controlRevision: 6 }
  const projected = index.project(taskModelInput({ task: { taskId: 'task', lastDecision }, executions: [execution], blockers: { executions: [taskExecutionContext(execution)] } }), { reuseVisible: false })
  for (const item of [projected.executions[0], projected.blockers.executions[0]]) {
    for (const key of ['executionId', 'taskId', 'sessionId', 'inputVersion', 'inputDigest', 'leaseEpoch', 'requirementRevision', 'controlRevision']) assert.equal(item[key], execution[key])
    const stage = item.stageProgress.contentRef ? resolve(index, item.stageProgress) : item.stageProgress
    assert.equal(typeof stage.summary === 'string' ? stage.summary : resolve(index, stage.summary), stageProgress.summary)
    assert.deepEqual(stage.evidence, stageProgress.evidence)
    assert.equal(stage.inputVersion, execution.inputVersion)
    assert.equal(stage.leaseEpoch, execution.leaseEpoch)
    const result = item.result.contentRef ? resolve(index, item.result) : item.result
    assert.deepEqual(result.recovery?.contentRef ? resolve(index, result.recovery) : result.recovery, recovery)
    assert.deepEqual(resolve(index, item.resultRef), execution.result)
  }
  assert.equal(projected.task.lastDecision.at, lastDecision.at)
  assert.equal(resolve(index, projected.task.lastDecision.summary), lastDecision.summary)
  assert.deepEqual(resolve(index, projected.executionIndex.catalogRef, '/execution'), execution)
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 10000, 'full provider diagnostics stay referenced')
})
function resolve(index, ref, path = '') {
  let text = '', offset = 0, page
  do { page = index.read({ contentRef: ref.contentRef, path, offset, limit: 173 }); text += page.text; offset = page.nextOffset } while (offset !== null)
  return page.format === 'json' ? JSON.parse(text) : text
}

test('source content is unique while identities, Web request, human correction and material references remain exact', async t => {
  const { index } = await fixture(t), body = '仅分析，不发布。'.repeat(150), reply = '更正：允许准备方案，仍不执行。'.repeat(100)
  const sources = [
    { sourceId: 'a', actorId: 'owner', version: 1, text: body, requestIdentity: { action: { context: body }, request: { args: { context: body } } } },
    { sourceId: 'b', actorId: 'other', version: 2, text: body, quote: { sourceId: 'a', text: body } },
    { sourceId: 'reply', actorId: 'owner', version: 3, text: reply, corrects: 'a' },
  ]
  const task = { taskId: 'task', request: body, ownerActorId: 'owner', requirementRevision: 3,
    lastDecision: { action: 'wait', summary: 'Host recorded current progress', recordedAt: '2026-10-14T15:00:00Z', requirementRevision: 3, controlRevision: 2, binding: { taskId: 'task', sessionId: 'session', leaseEpoch: 4 } },
    humanRequests: [{ requestId: 'question', status: 'answered', reply, responseSourceId: 'reply' }] }
  const raw = { task, sources, materials: sources.map(source => ({ sourceId: source.sourceId, text: source.text, quote: source.quote })), executions: [], operations: [] }
  const unchanged = structuredClone(raw), projected = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.deepEqual(raw, unchanged, 'projection does not mutate ledger-shaped input')
  assert.equal(JSON.stringify(projected).split(body).length - 1, 1)
  assert.equal(JSON.stringify(projected).split(reply).length - 1, 1)
  assert.equal(projected.sources[0].actorId, 'owner'); assert.equal(projected.sources[1].actorId, 'other')
  assert.equal(projected.sources[1].version, 2)
  assert.equal(resolve(index, projected.sources[0].requestIdentityRef, '/request/args/context'), body)
  assert.equal(resolve(index, projected.materials[0].textRef), body)
  assert.equal(resolve(index, projected.task.humanRequests[0].reply), reply)
  assert.deepEqual(resolve(index, projected.task.fullRecord), task)
  assert.deepEqual(resolve(index, projected.task.lastDecisionRef), task.lastDecision, 'existing decision identity and versions remain exact')
})

test('short authority bodies also have one definition rather than silently bypassing source indexing', async t => {
  const { index } = await fixture(t), text = '仅分析，不执行'
  const projected = index.project(taskModelInput({ task: { taskId: 'task', request: text, humanRequests: [{ status: 'answered', reply: text }] },
    objective: text, context: text, sources: [{ sourceId: 'one', actorId: 'owner', version: 1, text }, { sourceId: 'two', actorId: 'other', version: 2, text }], materials: [{ sourceId: 'one', text }] }), { reuseVisible: false })
  assert.equal(JSON.stringify(projected).split(text).length - 1, 1)
  assert.equal(resolve(index, projected.sources[0].text), text)
  assert.equal(projected.sources[1].actorId, 'other')
})

test('result size, execution/failed counts and continuation self-result stay in lazy bounded catalogues', async t => {
  const { index } = await fixture(t), metrics = []
  for (const count of [1, 20, 120]) {
    const executions = Array.from({ length: count }, (_, i) => ({ executionId: 'e' + i, inputVersion: 2, status: 'succeeded', drained: true,
      input: { objective: 'goal-' + i }, result: { payload: { output: { summary: 'RESULT_' + 'evidence'.repeat(count * 100) } } }, results: [{ output: 'old' }] }))
    const failed = Array.from({ length: count }, (_, i) => ({ operationId: 'failed' + i, state: 'failed', definition: { arguments: 'terminal'.repeat(count * 100) }, result: { proof: 'failed' } }))
    const unknown = { operationId: 'unknown', state: 'unknown', resourceKeys: ['protected'], definition: { arguments: 'UNKNOWN_EFFECT' }, result: { evidence: 'partial' }, evidenceRef: 'original-receipt' }
    const owner = { task: { taskId: 'task', request: 'goal' }, executions, operations: [...failed, unknown], blockers: { executions: [], operations: [unknown] } }
    const projected = index.project(taskModelInput(owner), { reuseVisible: false })
    assert.equal(projected.executions.length, Math.min(count, 20))
    assert.equal(projected.operations.length, 1); assert.equal(projected.operations[0].state, 'unknown')
    assert.equal(projected.blockers.operations[0].evidenceRef, 'original-receipt')
    assert.deepEqual(resolve(index, projected.blockers.operations[0].evidence), unknown)
    assert.deepEqual(resolve(index, projected.executionIndex.catalogRef, '/e' + (count - 1)), executions.at(-1))
    assert.deepEqual(resolve(index, projected.operationHistory.catalogRef, '/failed' + (count - 1)), failed.at(-1))
    const continued = index.project(executionModelInput({ task: { ownerActorId: 'owner', authorizationSourceId: 'auth' }, sources: [{ sourceId: 'auth', text: 'authority' }, { sourceId: 'unrelated', text: 'details'.repeat(5000) }], previousExecutions: executions }, { executionId: 'e0' }), { reuseVisible: false })
    assert.equal(continued.sources.length, 2); assert.equal(continued.sources[0].sourceId, 'auth')
    assert.equal(JSON.stringify(continued).split('details'.repeat(5000)).length - 1, 1, '近期原文仅定义一次，不能按非最初需求人身份丢弃')
    assert.equal(continued.executionHistory.total, count - 1)
    assert.equal(resolve(index, continued.sourceCatalog.catalogRef, '/unrelated').text.length, 35000)
    assert.equal(continued.previousExecutions.some(execution => execution.executionId === 'e0'), false)
    const readback = index.project(operationModelReadback({ operation: unknown, unresolved: true }))
    assert.equal(readback.operation.state, 'unknown'); assert.deepEqual(resolve(index, readback.operation.evidence), unknown)
    metrics.push({ count, beforeOwnerBytes: Buffer.byteLength(JSON.stringify({ ...owner, executions: executions.map(taskExecutionContext) })), ownerBytes: Buffer.byteLength(JSON.stringify(projected)), executionBytes: Buffer.byteLength(JSON.stringify(continued)) })
  }
  assert.ok(metrics.at(-1).ownerBytes < 17000)
  // Scoped references plus definitions for the 20 short goals have fixed
  // overhead; increasing result bodies and record counts must not expand them.
  assert.ok(metrics.at(-1).executionBytes - Buffer.byteLength('details'.repeat(5000)) < 17000, '执行目录预算与本轮必要来源正文分别计量')
  assert.ok(Math.abs(metrics.at(-1).ownerBytes - metrics[1].ownerBytes) < 1000)
  assert.ok(Math.abs(metrics.at(-1).executionBytes - metrics[1].executionBytes) < 1000)
  t.diagnostic(JSON.stringify({ scope: 'projected current Host JSON UTF-8 bytes, catalogues are not eagerly expanded', metrics }))
})

test('current source windows retain operator authorization and later restrictions beyond the first twenty sources', async t => {
  const { index } = await fixture(t)
  const sources = Array.from({ length: 28 }, (_, i) => ({ sourceId: `s${i}`, actorId: 'requester', version: 1, text: `历史资料${i}` }))
  sources[1] = { sourceId: 's1', actorId: 'operator', version: 1, text: '暂停发布，等待我明确恢复', channel: 'private' }
  sources.push({ sourceId: 'uat', actorId: 'operator', version: 1, text: '部署到UAT2', channel: 'im' },
    { sourceId: 'technical', actorId: 'operator', version: 1, text: '仅恢复工具，本答复不新增部署授权', channel: 'web' },
    { sourceId: 'restriction', actorId: 'operator', version: 1, text: '先不要部署，继续本地准备', channel: 'private' })
  const task = { taskId: 'task', ownerActorId: 'requester', request: '原始修复需求', objective: '当前UAT交付目标', requirements: ['保留真实申请'],
    metadata: { authorizationSourceId: 's0' }, authorizationSourceId: 's0' }
  const input = { task, sources, materialPaths: sources.map(source => `materials/${source.sourceId}.md`) }
  const unchanged = structuredClone(input)
  for (const projected of [index.project(taskModelInput(input), { reuseVisible: false }), index.project(executionModelInput(input, {}), { reuseVisible: false })]) {
    assert.equal(projected.sources.length, 20)
    assert.equal(projected.sources[0].sourceId, 's0')
    assert.deepEqual(projected.sources.slice(-3).map(source => source.sourceId), ['uat', 'technical', 'restriction'])
    assert.deepEqual(projected.sources.slice(-3).map(source => source.actorId), ['operator', 'operator', 'operator'])
    for (const source of sources.slice(-3)) assert.equal(resolve(index, projected.sources.find(item => item.sourceId === source.sourceId).text), source.text)
    assert.equal(projected.sourceCatalog.total, sources.length)
    assert.deepEqual(resolve(index, projected.sourceCatalog.catalogRef, '/s1'), sources[1], '窗口外撤销仍能逐字读取，不可用窗口内旧授权复活发布')
    assert.equal(resolve(index, projected.task.objective), task.objective)
    assert.deepEqual(projected.task.requirements, task.requirements)
  }
  const execution = executionModelInput(input, {})
  assert.deepEqual(execution.materialPaths, execution.sources.map(source => `materials/${source.sourceId}.md`))
  assert.deepEqual(input, unchanged)
})

test('first read is available, repeated readback uses references, reopen resolves and other sessions/tampering fail closed', async t => {
  const { index, session, root } = await fixture(t), body = 'body'.repeat(2000)
  const projected = index.project({ sources: [{ actorId: 'owner', text: body, sourceKey: 'source', sourceVersion: 1 }] }, { reuseVisible: false })
  session.append('user/message', createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify(projected) }] }), { surfaceOp: 'append' })
  const first = index.project({ material: 'new evidence'.repeat(1000) })
  assert.match(JSON.stringify(first), /new evidence/)
  session.append('user/message', createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify(first) }] }), { surfaceOp: 'append' })
  const repeated = index.project({ material: 'new evidence'.repeat(1000) })
  assert.ok(JSON.stringify(repeated).length < 300)
  const ref = projected.sources[0].text
  const reopened = createModelContentIndex(Session.create(session.id, session.snapshotEvents(), session.header), { root })
  assert.equal(resolve(reopened, ref), body)
  const foreign = createModelContentIndex(Session.create('other'), { root })
  assert.throws(() => resolve(foreign, ref), { code: 'MODEL_CONTENT_NOT_ADMITTED' })
  const [scope, , hash] = ref.contentRef.split(':')
  const path = join(root, scope, hash + '.json')
  assert.equal(JSON.parse(await readFile(path, 'utf8')), body)
  await writeFile(path, JSON.stringify('corrupt'))
  const fresh = createModelContentIndex(Session.create(session.id, session.snapshotEvents(), session.header), { root })
  assert.throws(() => resolve(fresh, ref), { code: 'MODEL_CONTENT_DIGEST_MISMATCH' })
})

test('nested quote graphs and identical bodies across distinct authors grow by identities and edges, not copied text', async t => {
  const { index } = await fixture(t), text = 'EXACT_QUOTED_AUTHORITY '.repeat(500), metrics = []
  for (const depth of [2, 5, 9]) {
    let source = { sourceKey: 'leaf', sourceVersion: 1, actorId: 'original', text }
    for (let level = 0; level < depth; level++) source = { sourceKey: 'parent-' + level, sourceVersion: level + 2, actorId: 'author-' + level, text,
      quoteRefs: [source, Object.fromEntries(Object.entries(source).reverse())] }
    const raw = { sources: [source, { ...source, actorId: 'other-author' }], groupResponsibility: text }
    const projected = index.project(raw, { reuseVisible: false })
    assert.equal(JSON.stringify(projected).split(text).length - 1, 1)
    assert.equal(projected.sources[0].actorId, source.actorId)
    assert.equal(projected.sources[1].actorId, 'other-author')
    const quote = projected.sources[0].quoteRefs[1]
    assert.ok(quote.contentRef)
    assert.equal(resolve(index, quote, '/actorId'), source.quoteRefs[1].actorId)
    assert.equal(resolve(index, quote, '/text'), text)
    metrics.push({ depth, beforeBytes: Buffer.byteLength(JSON.stringify(raw)), afterBytes: Buffer.byteLength(JSON.stringify(projected)) })
  }
  assert.ok(metrics.at(-1).afterBytes < metrics[0].afterBytes + 10000)
  t.diagnostic(JSON.stringify({ scope: 'nested source current Host UTF-8 JSON bytes', metrics }))
})
