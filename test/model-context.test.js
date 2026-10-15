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
  assert.deepEqual(projected.blockers.executions, [{ executionId: execution.executionId }])
  for (const item of [projected.executions[0]]) {
    for (const key of ['executionId', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision']) assert.equal(item[key], execution[key])
    const stage = item.stageProgress.contentRef ? resolve(index, item.stageProgress) : item.stageProgress
    assert.equal(typeof stage.summary === 'string' ? stage.summary : resolve(index, stage.summary), stageProgress.summary)
    assert.deepEqual(stage.evidence, stageProgress.evidence)
    assert.equal(stage.inputVersion, execution.inputVersion)
    assert.equal(stage.leaseEpoch, execution.leaseEpoch)
    const result = item.result.contentRef ? resolve(index, item.result) : item.result
    assert.deepEqual(result.recovery?.contentRef ? resolve(index, result.recovery) : result.recovery, recovery)
    assert.deepEqual(resolve(index, projected.catalogRef, '/executions/execution/result'), execution.result)
  }
  assert.equal(projected.task.lastDecision.at, lastDecision.at)
  assert.equal(resolve(index, projected.task.lastDecision.summary), lastDecision.summary)
  assert.deepEqual(resolve(index, projected.catalogRef, '/executions/execution'), execution)
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 10000, 'full provider diagnostics stay referenced')
})
function resolve(index, ref, path = '') {
  if (!ref?.contentRef) return ref
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
  assert.equal(JSON.stringify(projected).split(body).length - 1, 0)
  assert.equal(projected.sources[0].readRequired, true)
  assert.equal(resolve(index, projected.sources[0].text), body)
  assert.equal(JSON.stringify(projected).split(reply).length - 1, 0)
  assert.equal(resolve(index, projected.sources[2].text), reply)
  assert.equal(projected.sources[0].actorId, 'owner'); assert.equal(projected.sources[1].actorId, 'other')
  assert.equal(projected.sources[1].version, 2)
  assert.equal(resolve(index, projected.sources[0].requestIdentityRef, '/request/args/context'), body)
  assert.equal((projected.materials ?? []).length, 0, '纯来源快照不重复列入附件材料')
  assert.equal(resolve(index, projected.catalogRef, '/materials/0/text'), body)
  assert.equal(resolve(index, projected.catalogRef, '/task/humanRequests/0/reply'), reply)
  assert.deepEqual(resolve(index, projected.catalogRef, '/task'), task)
  assert.deepEqual(resolve(index, projected.catalogRef, '/task/lastDecision'), task.lastDecision, 'existing decision identity and versions remain exact')
})

test('short authority bodies stay literal with exact authors instead of larger hash dictionaries', async t => {
  const { index } = await fixture(t), text = '仅分析，不执行'
  const projected = index.project(taskModelInput({ task: { taskId: 'task', request: text, humanRequests: [{ status: 'answered', reply: text }] },
    objective: text, context: text, sources: [{ sourceId: 'one', actorId: 'owner', version: 1, text }, { sourceId: 'two', actorId: 'other', version: 2, body: text }], materials: [{ sourceId: 'one', text }] }), { reuseVisible: false })
  assert.equal(projected.contentIndex, undefined, '短原文无需180字节引用和字典键')
  assert.equal(projected.sources[0].text, text)
  assert.equal(projected.sources[1].body, text)
  assert.equal(resolve(index, projected.sources[0].text), text)
  assert.equal(projected.sources[1].actorId, 'other')
  assert.equal(resolve(index, projected.catalogRef, '/task/request'), text, '完整旧request仍可按需读取')
})

test('completed stage reports and routing internals stay readable without inflating the current task snapshot', async t => {
  const { index } = await fixture(t), old = 'OLD_STAGE '.repeat(4000), evidence = '完整结果'.repeat(3000)
  const source = { sourceId: 's', actorId: 'operator', version: 2, corrects: 'previous', text: '暂停部署，先检查',
    id: 's', groupId: 'group', routeReceipt: [{ taskId: 'task', debug: old }], routed: true, timestamp: '2026-10-15T05:00:00Z' }
  const execution = { executionId: 'done', status: 'succeeded', drained: true, input: { objective: '核验当前要求' }, stageProgress: { summary: old, evidence: [evidence] }, result: { payload: { output: { summary: evidence } } } }
  const stale = { ...execution, executionId: 'stale', status: 'stale', result: { ...execution.result, current: false } }
  const input = { task: { taskId: 'task', request: old, objective: '继续核查' }, sources: [source], executions: [execution, stale],
    materials: [{ sourceId: 's', text: source.text, path: 'source.json', resources: [] }, { sourceId: 'file', path: 'attachment.json', resources: [{ status: 'unavailable', reason: '读取失败' }] }] }
  const projected = index.project(taskModelInput(input), { reuseVisible: false })
  assert.equal(projected.sources[0].corrects, 'previous')
  assert.equal(projected.sources[0].routeReceipt, undefined)
  assert.equal(projected.executions[0].stageProgress, undefined)
  assert.equal(resolve(index, projected.catalogRef, '/executions/done/input/objective'), execution.input.objective)
  assert.deepEqual(resolve(index, projected.catalogRef, '/executions/done/result'), execution.result, '终态目录保留业务结果的精确读取入口')
  assert.equal(projected.executions.length, 1)
  assert.equal(resolve(index, projected.catalogRef, '/executions/stale/result/current'), false, '过期结果完整可读但不铺开')
  assert.equal(projected.materials.length, 1)
  assert.equal(projected.materials[0].resources[0].status, 'unavailable', '附件不可用仍明确可见')
  assert.deepEqual(resolve(index, projected.catalogRef, '/sources/s'), source)
  assert.deepEqual(resolve(index, projected.catalogRef, '/executions/done'), execution)
  assert.equal(resolve(index, projected.catalogRef, '/task/request'), old)
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 5000)
})

test('result size, execution/failed counts and continuation self-result stay in lazy bounded catalogues', async t => {
  const { index } = await fixture(t), metrics = []
  for (const count of [1, 20, 120]) {
    const executions = Array.from({ length: count }, (_, i) => ({ executionId: 'e' + i, inputVersion: 2, status: 'succeeded', drained: true,
      input: { objective: 'goal-' + i }, result: { current: false, payload: { output: { summary: 'RESULT_' + 'evidence'.repeat(count * 100) } } }, results: [{ output: 'old' }] }))
    const failed = Array.from({ length: count }, (_, i) => ({ operationId: 'failed' + i, state: 'failed', definition: { arguments: 'terminal'.repeat(count * 100) }, result: { proof: 'failed' } }))
    const unknown = { operationId: 'unknown', state: 'unknown', resourceKeys: ['protected'], definition: { arguments: 'UNKNOWN_EFFECT' }, result: { evidence: 'partial' }, evidenceRef: 'original-receipt' }
    const owner = { task: { taskId: 'task', request: 'goal' }, executions, operations: [...failed, unknown], blockers: { executions: [], operations: [unknown] } }
    const projected = index.project(taskModelInput(owner), { reuseVisible: false })
    assert.equal(projected.executions.length, 0)
    assert.equal(projected.operations.length, 1); assert.equal(projected.operations[0].state, 'unknown')
    assert.deepEqual(projected.blockers.operations, [{ operationId: 'unknown' }])
    assert.equal(projected.operations[0].evidenceRef, 'original-receipt')
    assert.deepEqual(resolve(index, projected.catalogRef, '/operations/unknown'), unknown)
    assert.deepEqual(resolve(index, projected.catalogRef, '/executions/e' + (count - 1)), executions.at(-1))
    assert.deepEqual(resolve(index, projected.catalogRef, '/operations/failed' + (count - 1)), failed.at(-1))
    const continued = index.project(executionModelInput({ task: { ownerActorId: 'owner', authorizationSourceId: 'auth' }, sources: [{ sourceId: 'auth', text: 'authority' }, { sourceId: 'unrelated', text: 'details'.repeat(5000) }], previousExecutions: executions }, { executionId: 'e0' }), { reuseVisible: false })
    assert.equal(continued.sources.length, 2); assert.equal(continued.sources[0].sourceId, 'auth')
    assert.equal(JSON.stringify(continued).split('details'.repeat(5000)).length - 1, 0, '近期原文仅定义一次，不能按非最初需求人身份丢弃')
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
    assert.equal(projected.sourceCount ?? projected.sourceCatalog.total, sources.length)
    assert.deepEqual(resolve(index, projected.catalogRef ?? projected.sourceCatalog.catalogRef, projected.catalogRef ? '/sources/s1' : '/s1'), sources[1], '窗口外撤销仍能逐字读取，不可用窗口内旧授权复活发布')
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
  assert.equal(JSON.stringify(first).includes('new evidence'), false)
  assert.equal(JSON.parse(await readFile(first.material.path, 'utf8')), 'new evidence'.repeat(1000))
  session.append('user/message', createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify(first) }] }), { surfaceOp: 'append' })
  const repeated = index.project({ material: 'new evidence'.repeat(1000) })
  assert.equal(resolve(index, repeated, '/material'), 'new evidence'.repeat(1000))
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
    assert.equal(JSON.stringify(projected).split(text).length - 1, 0)
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

import { context172Fixture } from './fixtures/model-context-172.js'
test('issue 172: seven operation memberships, stage wakes and historical objectives have one detail/readable catalog', async t => {
  const { index } = await fixture(t), raw = context172Fixture(), unchanged = structuredClone(raw)
  const projected = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.deepEqual(resolve(index, projected.catalogRef, '/task'), raw.task, 'one durable catalog retains the complete task')
  assert.equal(projected.materialCatalogRef, undefined, 'empty material bodies need no reference')
  assert.equal(projected.operationHistory, undefined, 'one canonical catalog replaces duplicated indexes')
  assert.equal(projected.operations.length, 1)
  assert.equal(projected.operations[0].state, 'unknown')
  assert.deepEqual(projected.operationCounts, { starting: 6, unknown: 1 })
  assert.deepEqual(projected.blockers.operations, raw.operations.map(({ operationId }) => ({ operationId })))
  assert.equal(projected.blockers.operationIndex, undefined)
  assert.deepEqual(projected.blockers.executions, [{ executionId: 'active' }])
  for (const operation of raw.operations) assert.deepEqual(resolve(index, projected.catalogRef, '/operations/' + operation.operationId), operation)
  assert.deepEqual(resolve(index, projected.catalogRef, '/operations/operation-6'), raw.operations[6])
  for (const [i, execution] of raw.executions.slice(0, 3).entries()) {
    assert.equal(projected.executions.some(item => item.executionId === execution.executionId), false)
    assert.equal(resolve(index, projected.catalogRef, '/executions/' + execution.executionId + '/input/objective'), execution.input.objective)
    assert.ok(!JSON.stringify(projected.contentIndex ?? {}).includes(execution.input.objective))
    assert.deepEqual(resolve(index, projected.catalogRef, '/executions/' + execution.executionId), execution)
  }
  assert.equal(projected.executions[0].input.objective, raw.executions[3].input.objective)
  assert.equal(projected.task.objective, raw.task.objective)
  assert.equal(projected.wakes[0].payload.summary, undefined)
  assert.equal(projected.wakes[0].payload.sequence, 3)
  assert.equal(projected.wakes[0].payload.reportRef, undefined)
  assert.deepEqual(projected.executions[0].stageProgress, raw.executions[3].stageProgress)
  assert.deepEqual(projected.wakes[1], raw.wakes[1])
  assert.deepEqual(projected.sources.map(s => [s.sourceId, s.actorId, s.version, s.corrects, s.text]), raw.sources.map(s => [s.sourceId, s.actorId, s.version, s.corrects, s.text]))
  // Stale stage notifications retain their own exact evidence/version, not a pointer to the latest report.
  raw.wakes[0].payload.sequence = 2
  raw.wakes[0].payload.summary = 'OLDER_STAGE_BODY'
  const stale = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.equal(resolve(index, stale.wakes[0].payload.reportRef).summary, 'OLDER_STAGE_BODY')
  assert.equal(stale.executions[0].stageProgress.sequence, 3)
  const blockerOnly = index.project(taskModelInput({ blockers: { operations: raw.operations, executions: raw.executions } }), { reuseVisible: false })
  assert.deepEqual(blockerOnly.operationCounts, { starting: 6, unknown: 1 })
  assert.equal(blockerOnly.executionCount, 4)
  assert.deepEqual(resolve(index, blockerOnly.catalogRef, '/operations/operation-6'), raw.operations[6])
  assert.deepEqual(unchanged, context172Fixture(), 'projection never changes the source records')
  const continued = index.project(executionModelInput({ objective: 'CURRENT_CONTINUATION', previousExecutions: raw.executions.slice(0, 3), sources: raw.sources }, {}), { reuseVisible: false })
  const activeHistory = index.project(executionModelInput({ previousExecutions: [raw.executions[3]] }, {}), { reuseVisible: false })
  assert.equal(activeHistory.previousExecutions[0].input.objective, undefined)
  assert.equal(resolve(index, activeHistory.executionHistory.catalogRef, '/active/input/objective'), raw.executions[3].input.objective)
  assert.equal(continued.objective, 'CURRENT_CONTINUATION')
  assert.equal(resolve(index, continued.executionHistory.catalogRef, '/history-2/input/objective'), raw.executions[2].input.objective)
  t.diagnostic(JSON.stringify({ scope: 'synthetic issue172 projected Host UTF-8 JSON bytes', bytes: Buffer.byteLength(JSON.stringify(projected)),
    operationsBytes: Buffer.byteLength(JSON.stringify(projected.operations)), blockersBytes: Buffer.byteLength(JSON.stringify(projected.blockers)), contentIndexBytes: Buffer.byteLength(JSON.stringify(projected.contentIndex ?? {})) }))
})

test('issue 172: complete catalogs beyond the display window and explicit tool reads render bodies directly', async t => {
  const { index } = await fixture(t), raw = context172Fixture(), tools = new Map()
  raw.operations = Array.from({ length: 25 }, (_, i) => ({ ...raw.operations[6], operationId: 'op/' + i }))
  raw.blockers.operations = [raw.operations[24]]
  const projected = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.equal(projected.operations.length, 25, 'unknown effects never disappear behind a window')
  assert.deepEqual(projected.blockers.operations, [{ operationId: 'op/24' }])
  index.install({ systemPrompt: { section() {} }, tools: { register(tool) { tools.set(tool.name, tool) } } })
  const tool = tools.get('model_content_read'), exec = { signal: new AbortController().signal }
  const first = await tool.execute({ contentRef: projected.catalogRef.contentRef, path: '/operations' }, exec)
  assert.equal(first.totalEntries, 25); assert.equal(first.nextOffset, 20)
  const second = await tool.execute({ contentRef: projected.catalogRef.contentRef, path: '/operations', offset: 20 }, exec)
  assert.equal(second.nextOffset, null)
  assert.ok([...first.entries, ...second.entries].some(entry => entry.key === 'op/24'))
  const operation = await tool.execute({ contentRef: projected.catalogRef.contentRef, path: '/operations/op~124' }, exec)
  assert.equal(operation.entries.find(entry => entry.key === 'state').value, 'unknown')
  const objective = projected.catalogRef
  const objectivePath = '/executions/history-0/input/objective'
  const page = await tool.execute({ contentRef: objective.contentRef, path: objectivePath, limit: 16000 }, exec)
  const rendered = JSON.parse(tool.output.render({}, page)[0].text)
  assert.equal(rendered.text, raw.executions[0].input.objective)
  assert.equal(rendered.format, 'text')
  assert.equal(rendered.resolvedRef.bytes, index.store(raw.executions[0].input.objective).bytes, 'explicit reads still report full format and byte metadata')
  assert.equal(rendered.nextOffset, null)
  assert.deepEqual(await tool.execute({ contentRef: objective.contentRef, path: objectivePath, limit: 16000 }, exec), page)
})

test('decision view preserves request-only targets, all unknown identities and unreviewed current results', async t => {
  const { index } = await fixture(t), raw = context172Fixture()
  const fallback = index.project(taskModelInput({ task: { request: '唯一当前目标：仅本地核验' } }), { reuseVisible: false })
  assert.equal(fallback.task.objective, '唯一当前目标：仅本地核验')
  const current = { ...raw.executions[0], executionId: 'current-result', result: { current: true, receivedAt: '2026-01-01T00:00:00Z' } }
  raw.executions.push(current)
  raw.task.lastDecision = { action: 'wait', at: '2026-10-15T00:00:00Z' }
  const projected = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.ok(projected.executions.some(item => item.executionId === 'current-result'), 'a later decision timestamp does not prove the result was reviewed')
  raw.executions[0].status = 'stale'
  raw.wakes = [{ kind: 'execution.result', payload: { executionId: raw.executions[0].executionId } }]
  const woken = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.ok(woken.executions.some(item => item.executionId === raw.executions[0].executionId), 'a historical result explicitly woken for this round remains discoverable')
  raw.wakes = [context172Fixture().wakes[0]]
  raw.wakes[0].payload.controlRevision++
  const mismatched = index.project(taskModelInput(raw), { reuseVisible: false })
  assert.ok(mismatched.wakes[0].payload.reportRef, 'same sequence with a different version is not the current stage report')
  assert.equal(resolve(index, mismatched.wakes[0].payload.reportRef).controlRevision, 7)
})

test('all long content surfaces expose existing readable files without contentIndex reinjection', async t => {
  const { index, root } = await fixture(t)
  const long = '原文包含"引号"、\\路径、🙂与换行\n'.repeat(80)
  const log = Array.from({ length: 90 }, (_, i) => ({ sequence: i, message: 'synthetic event ' + i, author: 'fixture' }))
  const raw = { context: long, result: { summary: long }, evidence: [long], diagnostics: { message: long }, entries: log }
  const projected = index.project(raw, { reuseVisible: false })
  assert.equal(projected.contentIndex, undefined)
  assert.equal(JSON.stringify(projected).includes(long), false)
  for (const [ref, value] of [[projected.context, long], [projected.result.summary, long], [projected.evidence, [long]], [projected.diagnostics, raw.diagnostics], [projected.entries, log]]) {
    assert.ok(ref, JSON.stringify(projected))
    assert.ok(ref.path.startsWith(root + '/'))
    assert.equal(ref.path, index.store(value).path, 'existing content-addressed file is reused')
    assert.deepEqual(JSON.parse(await readFile(ref.path, 'utf8')), value)
  }
  assert.equal(resolve(index, projected.entries, '/89/message'), 'synthetic event 89')
})

test('many short requirements remain one lossless file after source-reference mapping', async t => {
  const { index } = await fixture(t)
  const requirements = Array.from({ length: 160 }, (_, i) => `当前核验要求${i}：保留原始证据，不新增授权。`)
  const projected = index.project(taskModelInput({ task: { objective: '当前核验', requirements } }), { reuseVisible: false })
  assert.equal(projected.task.readRequired, true)
  assert.ok(projected.task.requirements.path)
  assert.deepEqual(JSON.parse(await readFile(projected.task.requirements.path, 'utf8')), requirements)
  assert.equal(projected.contentIndex, undefined)
})

test('long configured task/execution instructions reuse the content file instead of a long prompt', async t => {
  const { index } = await fixture(t), body = '配置边界：仅核对本地文件。\n'.repeat(120)
  const text = index.instruction(body, '工作区规则')
  assert.equal(text.includes(body), false)
  const file = index.store(body)
  assert.ok(text.includes(file.path)); assert.equal(JSON.parse(await readFile(file.path, 'utf8')), body)
  assert.equal(index.instruction('短指引'), '短指引')
})
