import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'

// Distinct authored paragraphs: not the prior repeat(1200) amplification fixture.
const body = Array.from({ length: 36 }, (_, i) => `核验事项${i + 1}：记录本地样例编号${100 + i}，比较输入与输出；发现缺失时在报告说明，不执行外部写入。`).join('\n') + '\nBOUNDARY_END: 仅本地分析，禁止发布。'
test('user source files: exact original, native targeted reads, stable paths after restart and unchanged source identity', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-native-')), hosts = [], metrics = []
  let originalPath, originalSourceId, requestIdentityFile, steps = 0, modelError, decisionBytes = 0
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const model = request => { try {
    assert.ok(++steps <= 8, JSON.stringify(request.messages.filter(m => m.role === 'tool').at(-1)?.content ?? []).slice(0, 1500))
    const input = latestInput(request), host = request.messages.find(m => m.source?.taskSession)
    assert.ok(host, 'this fixture creates a Web task directly')
    assert.equal(host.content[0].text.includes(body), false)
    assert.equal(input.contentIndex, undefined)
    const source = input.sources.find(source => source.textFile)
    assert.ok(source.readRequired); assert.equal(source.text, undefined)
    assert.equal(dirname(source.textFile), join(root, 'tasks', input.task.taskId, 'materials'))
    assert.equal(source.textFile.endsWith('.txt'), true)
    assert.equal(source.actorId, 'native-user')
    assert.equal(source.requestIdentityInCatalog, true, 'the Web authorization identity remains available in the source catalog')
    originalPath ??= source.textFile; originalSourceId ??= source.sourceId; requestIdentityFile ??= input.catalogRef.path
    assert.equal(source.textFile, originalPath); assert.equal(source.sourceId, originalSourceId)
    const toolText = request.messages.filter(m => m.role === 'tool').flatMap(m => m.content ?? []).map(b => b.text ?? '').join('\n')
    decisionBytes += Buffer.byteLength(host.content[0].text) + Buffer.byteLength(toolText)
    if (!toolText.includes('核验事项31：')) return [{ name: 'read', args: { file_path: source.textFile, offset: 30, limit: 3 } }]
    if (!toolText.includes('BOUNDARY_END:')) return [{ name: 'read', args: { file_path: source.textFile, offset: 37, limit: 1 } }]
    metrics.push({ hostTextBytes: Buffer.byteLength(host.content[0].text), sourceVersion: source.version,
      toolTextBytes: Buffer.byteLength(toolText), decisionHostAndToolTextBytes: decisionBytes, sourceFile: source.textFile })
    decisionBytes = 0
    assert.equal(toolText.includes(body), false, 'native reads locate relevant evidence instead of reinjecting the whole message')
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '已定位核验事项与禁止发布边界，继续本地分析', evidence: [], limitations: [] } } }]
  } catch (error) { modelError = error.stack; throw error } }
  let h = await nativeTaskHost(root, model); hosts.push(h)
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'file-source', title: '本地样例核验', objective: body, context: body })
  await h.service.whenIdle()
  assert.equal(h.service.listAlerts().length, 0, JSON.stringify({ alerts: h.service.listAlerts(), steps, modelError, results: h.toolResults, lastTools: h.requests.at(-1)?.messages.filter(m => m.role === 'tool').slice(-2) }))
  assert.ok(metrics.length)
  assert.equal(await readFile(originalPath, 'utf8'), body)
  const snapshotPath = originalPath.replace(/\.txt$/, '.json'), snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  assert.equal(snapshot.text, body); assert.equal(snapshot.sourceId, originalSourceId); assert.equal(snapshot.version, 1)
  assert.equal(JSON.parse(await readFile(requestIdentityFile, 'utf8')).sources[originalSourceId].requestIdentity.request.args.context, body)
  await h.close()
  h = await nativeTaskHost(root, model, { initialize: false }); hosts.push(h)
  const current = await h.query('task.get', { taskId: created.taskId })
  await h.service.appendTaskContext({ taskId: created.taskId, requestId: 'file-source-correction', context: '新更正：仍然禁止发布，先确认核验事项31。',
    expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision })
  await h.service.whenIdle()
  assert.equal(h.service.listAlerts().length, 0, JSON.stringify({ alerts: h.service.listAlerts(), steps, modelError, results: h.toolResults, lastTools: h.requests.at(-1)?.messages.filter(m => m.role === 'tool').slice(-2) }))
  assert.equal(await readFile(originalPath, 'utf8'), body)
  assert.equal((await h.query('source.get', { sourceId: originalSourceId })).text, body)
  assert.ok(metrics.length >= 2)
  t.diagnostic(JSON.stringify({ scope: 'synthetic authored multiline message; real SDK targeted native file reads, not full-body model_content_read', originalUTF8Bytes: Buffer.byteLength(body), metrics }))
})
