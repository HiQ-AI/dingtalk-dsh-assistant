import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sdkHost } from './fixtures/model-context-sdk-host.js'
import { context172Fixture } from './fixtures/model-context-172.js'
import { createTaskSessions } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session'

test('issue172 actual SDK requests: seven operations, lazy historical goals, direct reads and three continued snapshots', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'issue172-native-')), cwd = join(root, 'task')
  await mkdir(cwd)
  let manager, round = 0, readRequests = 0
  const metrics = [], raw = context172Fixture()
  const h = await sdkHost(root, request => {
    const hosts = request.messages.filter(m => m.source?.taskSession)
    assert.equal(hosts.length, 1)
    assert.equal(request.messages.some(m => m.source?.taskContextHistory), false)
    const input = JSON.parse(hosts[0].content[0].text)
    assert.equal(input.operations.length, 1)
    assert.deepEqual(input.blockers.operations, raw.operations.map(({ operationId }) => ({ operationId })))
    assert.equal(input.operations[0].state, 'unknown')
    assert.equal(input.sources[1].corrects, 'authority')
    assert.equal(input.sources[1].actorId, 'synthetic-operator')
    assert.equal(input.sources[1].version, 2)
    assert.match(input.sources[1].text, /仍禁止发布/)
    assert.equal(input.task.objective, raw.task.objective)
    assert.equal(input.wakes[0].payload.summary, undefined)
    assert.equal(input.wakes[0].payload.reportRef, undefined)
    assert.deepEqual(input.executions[0].stageProgress, raw.executions[3].stageProgress)
    for (const execution of raw.executions.slice(0, 3)) assert.ok(!hosts[0].content[0].text.includes(execution.input.objective))
    const ref = input.catalogRef.contentRef, path = '/executions/history-0/input/objective'
    const pages = request.messages.filter(m => m.role === 'tool').flatMap(m => m.content ?? []).filter(b => b.type === 'text').flatMap(b => { try { return [JSON.parse(b.text)] } catch { return [] } })
    if (!pages.some(page => page.contentRef === ref && page.path === path && page.text === raw.executions[0].input.objective)) {
      readRequests++
      return [{ name: 'model_content_read', args: { contentRef: ref, path, limit: 16000 } }]
    }
    metrics.push({ round, currentHostTextBytes: Buffer.byteLength(hosts[0].content[0].text), hostCount: hosts.length,
      toolHistoryBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(m => m.role === 'tool'))) })
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '本地核验继续，未知效果未改变', evidence: [], limitations: [] } } }]
  })
  manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  for (round = 1; round <= 3; round++) {
    const result = await manager.run({ binding: { kind: 'task-session', taskId: 'synthetic-task', sessionId: 'synthetic-session', leaseEpoch: round, sessionBound: round > 1 },
      input: raw, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', onSessionBound: async () => {}, submit: async () => ({ accepted: true }) })
    assert.equal(result.status, 'submitted')
  }
  assert.equal(readRequests, 1, 'body already read remains in tool history without eager Host reinjection')
  const stored = await inspectSession(h.ctx.sessionPersistence, 'synthetic-session'), folded = foldSurface(stored.events)
  const visible = folded.nodes.map(seq => deriveEventMessage(stored.events[seq], folded.projectedMessages)).filter(Boolean)
  assert.equal(visible.filter(m => m.source?.taskSession).length, 1)
  assert.equal(stored.events.filter(e => e.type === 'user/message' && e.data.source?.taskSession).length, 3)
  t.diagnostic(JSON.stringify({ scope: 'real SDK with scripted adapter; Host text UTF-8 bytes, tool history separately measured', metrics }))
})


test('oversized SDK Host stays within budget across retries while exact source evidence is readable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'issue172-budget-')), cwd = join(root, 'task')
  await mkdir(cwd)
  const raw = context172Fixture(), metrics = []
  raw.sources = Array.from({ length: 5 }, (_, i) => ({ sourceId: 'source-' + i, actorId: 'actor-' + i, version: i + 1,
    text: '人工授权边界🙂'.repeat(30), quote: { text: '历史引用'.repeat(60) }, corrects: i ? 'source-' + (i - 1) : undefined }))
  let manager
  const h = await sdkHost(root, request => {
    const hosts = request.messages.filter(m => m.source?.taskSession)
    assert.equal(hosts.length, 1)
    const text = hosts[0].content.filter(b => b.type === 'text').map(b => b.text).join('')
    assert.ok(Buffer.byteLength(text) <= 3000)
    const input = JSON.parse(text)
    assert.equal(input.sources.readRequired, true)
    const pages = request.messages.filter(m => m.role === 'tool').flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => JSON.parse(b.text))
    if (!pages.some(page => page.text === 'actor-4')) return [{ name: 'model_content_read', args: { contentRef: input.contextRef, path: '/sources/4/actorId' } }]
    metrics.push(Buffer.byteLength(text))
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '尚待授权核验', evidence: [], limitations: [] } } }]
  })
  manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  for (let round = 1; round <= 3; round++) {
    const result = await manager.run({ binding: { kind: 'task-session', taskId: 'synthetic-task', sessionId: 'budget-session', leaseEpoch: round, sessionBound: round > 1 },
      input: raw, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', onSessionBound: async () => {}, submit: async () => ({ accepted: true }) })
    assert.equal(result.status, 'submitted')
  }
  const stored = await inspectSession(h.ctx.sessionPersistence, 'budget-session')
  assert.equal(stored.events.filter(e => e.type === 'user/message' && e.data.source?.taskSession).length, 3)
  t.diagnostic(JSON.stringify({ oversizedSDKHostBytes: metrics }))
})
