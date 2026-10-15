import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sdkHost } from './model-context-sdk-host.js'
import { context172Fixture } from './model-context-172.js'
import { createTaskSessions } from '../../packages/dingtalk-dsh-assistant/task-session.js'

export function decisionScenarios172({ includeLegacyStress = false } = {}) {
  const names = ['first-entry', 'stage-progress', 'periodic-review', 'new-message', 'unknown-effect', 'recovery']
  if (includeLegacyStress) names.push('long-new-message') // Historical repeat(1200) stress generator, not a normal user message.
  return names.map(name => {
    const input = context172Fixture(), active = input.executions.at(-1)
    const event = (kind, payload) => [{ wakeId: 'synthetic-' + name, kind, payload }]
    if (name === 'first-entry') input.wakes = event('task.created', { sourceRefs: ['authority', 'correction'] })
    if (name === 'stage-progress') input.wakes = [input.wakes[0]]
    if (name === 'periodic-review') input.wakes = event('execution.progress.review', { executionId: 'active', inputVersion: 4, leaseEpoch: 2, lastSequence: 12 })
    if (name === 'new-message' || name === 'long-new-message') {
      // Real revisions need not carry a sourceId. The correction must still appear.
      input.wakes = event('task.revise', { requirementRevision: 5, controlRevision: 6 })
      if (name === 'long-new-message') input.sources[1].text = '新指令：仅本地核验，禁止发布。'.repeat(1200)
    }
    if (name === 'unknown-effect') input.wakes = event('operation.result', { operationId: 'operation-6', state: 'unknown' })
    if (name === 'recovery') {
      active.status = 'queued'; active.drained = true
      active.providerRecovery = { attempts: 2, nextAttemptAt: '2026-10-15T00:00:05Z' }
      active.result = { current: true, inputVersion: 4, leaseEpoch: 2, requirementRevision: 5, controlRevision: 6,
        recovery: { decision: 'scheduled', attempts: 2 }, payload: { error: { code: 'SERVER', message: 'SYNTHETIC_TRANSIENT: transport unavailable; no credential evidence' } } }
      input.wakes = event('execution.provider.review', { executionId: 'active' })
    }
    return { name, input }
  })
}

// Compare projections through the same SDK task manager and scripted judgment.
// Only the projection module is substituted; no provider, network, or business store.
async function managerWithProjection(source) {
  if (!source) return createTaskSessions
  const projection = source.replace("'@deepseek-ai/dsh-llm'", JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm')))
  const projectionURL = 'data:text/javascript;base64,' + Buffer.from(projection).toString('base64')
  const taskURL = new URL('../../packages/dingtalk-dsh-assistant/task-session.js', import.meta.url)
  const taskSource = (await readFile(taskURL, 'utf8')).replace(/from '([^']*)'/g, (_all, specifier) =>
    'from ' + JSON.stringify(specifier === './model-context.js' ? projectionURL : specifier.startsWith('.') ? new URL(specifier, taskURL).href : import.meta.resolve(specifier)))
  return (await import('data:text/javascript;base64,' + Buffer.from(taskSource).toString('base64'))).createTaskSessions
}
const bytes = value => Buffer.byteLength(JSON.stringify(value))
export async function measureTaskDecision172(scenario, { projectionSource } = {}) {
  const createManager = await managerWithProjection(projectionSource), root = await mkdtemp(join(tmpdir(), 'issue172-decision-'))
  const cwd = join(root, 'task'); await mkdir(cwd)
  const raw = scenario.input, requests = [], readCalls = [], progress = { executionId: 'active', inputVersion: 4,
    observation: { changed: false, newEventCount: 0, lastSequence: 12, lastActivityAt: '2026-10-15T00:00:00Z' }, entries: [], limitations: ['Synthetic observation; no elapsed-time inference'] }
  let manager
  const h = await sdkHost(root, request => {
    requests.push(structuredClone(request))
    assert.ok(requests.length < 12, 'script must finish with the same bounded judgment')
    const hosts = request.messages.filter(m => m.source?.taskSession)
    assert.equal(hosts.length, 1)
    const input = JSON.parse(hosts[0].content[0].text)
    const pages = request.messages.filter(m => m.role === 'tool').flatMap(m => m.content ?? []).filter(b => b.type === 'text')
      .flatMap(b => { try { return [JSON.parse(b.text)] } catch { return [] } })
    const read = args => { readCalls.push('model_content_read'); return [{ name: 'model_content_read', args }] }
    function requireText(value, expected, path = '') {
      if (typeof value === 'string') { assert.equal(value, expected); return }
      const ref = value.contentRef
      if (input.contentIndex?.[ref] !== undefined) { assert.equal(input.contentIndex[ref], expected); return }
      const found = pages.filter(page => page.contentRef === ref && page.path === path && page.format === 'text').sort((a, b) => a.offset - b.offset)
      let text = '', offset = 0
      for (const page of found) { assert.equal(page.offset, offset); text += page.text; offset = page.nextOffset }
      if (!found.length || offset !== null) return read({ contentRef: ref, path, offset: offset ?? 0, limit: 16000 })
      assert.equal(text, expected, 'the scripted judgment saw every exact character before deciding')
    }
    assert.equal(input.task.objective, raw.task.objective)
    for (const source of raw.sources) {
      const visible = input.sources.find(item => item.sourceId === source.sourceId)
      assert.equal(visible.actorId, source.actorId); assert.equal(visible.version, source.version)
      assert.equal(visible.corrects, source.corrects)
      const pending = requireText(visible.text, source.text)
      if (pending) return pending
    }
    assert.equal(input.operations.find(op => op.operationId === 'operation-6').state, 'unknown')
    const active = input.executions.find(item => item.executionId === 'active')
    assert.equal(active.status, raw.executions.at(-1).status)
    assert.equal(active.inputVersion, 4); assert.equal(active.leaseEpoch, 2)
    if (scenario.name === 'stage-progress') {
      assert.equal(active.stageProgress.summary, raw.executions.at(-1).stageProgress.summary)
      assert.deepEqual(active.stageProgress.evidence, raw.executions.at(-1).stageProgress.evidence)
      assert.equal(active.stageProgress.sequence, 3)
    }
    if (scenario.name === 'periodic-review' && !pages.some(page => page.observation?.lastSequence === 12)) {
      readCalls.push('task_execution_progress')
      return [{ name: 'task_execution_progress', args: { executionId: 'active' } }]
    }
    if (scenario.name === 'unknown-effect') {
      const ref = input.catalogRef ?? input.operationHistory.catalogRef
      const path = input.catalogRef ? '/operations/operation-6/definition/arguments/body' : '/operation-6/definition/arguments/body'
      const pending = requireText(ref, raw.operations[6].definition.arguments.body, path)
      if (pending) return pending
    }
    if (scenario.name === 'recovery') {
      const pending = requireText(active.resultRef ?? input.catalogRef, raw.executions.at(-1).result.payload.error.message, active.resultRef ? '/payload/error/message' : '/executions/active/result/payload/error/message')
      if (pending) return pending
      assert.equal(active.result.recovery.decision, 'scheduled')
    }
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '保留本地授权边界，核对原身份，不重放未知效果；等待原执行', evidence: [], limitations: [] } } }]
  })
  try {
    manager = createManager({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
    const result = await manager.run({ binding: { kind: 'task-session', taskId: 'synthetic-task', sessionId: 'synthetic-decision-session', leaseEpoch: 1, sessionBound: false },
      input: raw, provider: 'native-task-test', model: 'controlled', onSessionBound: async () => {}, readProgress: async () => progress,
      submit: async () => ({ accepted: true }) })
    assert.equal(result.status, 'submitted')
    const hosts = requests.map(request => request.messages.find(m => m.source?.taskSession).content[0].text)
    return { scenario: scenario.name, hostTextBytes: Buffer.byteLength(hosts[0]), readCalls: readCalls.length, readTools: readCalls,
      sdkRequests: requests.length,
      // Count repeated Host plus all retained tool text on EVERY SDK request.
      cumulativeHostAndToolTextBytes: requests.reduce((sum, request, i) => sum + Buffer.byteLength(hosts[i])
        + request.messages.filter(m => m.role === 'tool').flatMap(m => m.content ?? []).filter(b => b.type === 'text').reduce((n, b) => n + Buffer.byteLength(b.text), 0), 0),
      cumulativeSDKMessageJSONBytes: requests.reduce((sum, request) => sum + bytes(request.messages), 0) }
  } finally {
    try { await manager?.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}
