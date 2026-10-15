import { findSessionLog } from './fixtures/session-persistence.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { createGroupCoordinatorSessions } from '../packages/dingtalk-dsh-assistant/group-coordinator-session.js'
import { createModelContentIndex } from '../packages/dingtalk-dsh-assistant/model-context.js'

function indexedText(session, root, value) {
  if (typeof value === 'string') return value
  const page = createModelContentIndex(session, { root: join(root, 'model-content') }).read({ contentRef: value.contentRef, limit: 16000 })
  assert.equal(page.nextOffset, null)
  return page.text
}

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const decision = { kind: 'no_action', reason: '人际闲聊' }
const decisionSchema = { type: 'object', properties: { kind: { type: 'string' }, reason: { type: 'string' } }, required: ['kind', 'reason'], additionalProperties: false }

for (const variant of ['same-path-repeat', 'root-and-five-distinct-paths']) test(`explicit source reads return literal final SDK text and survive reopen: ${variant}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'model-read-literal-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const sourceId = 'web-human:42eb13721d14847ad394143e0fca8b268e1ba85de64f5bfbf519c83213dabbfd'
  const body = '仅核对原任务证据，不修改生产。'.repeat(20).slice(0, 180) + ' source authority '.padEnd(73, 'x')
  assert.equal(body.length, 253); assert.equal(Buffer.byteLength(JSON.stringify(body)), 615)
  let reference, reads = 0
  const path = '/' + sourceId + '/text'
  const paths = variant === 'same-path-repeat' ? Array(6).fill(path) : ['', path, '/' + sourceId + '/quoted/text', '/' + sourceId + '/original/text', '/' + sourceId + '/reply', '/' + sourceId + '/context/objective']
  const check = (request, expectedPath = path) => {
    const message = request.messages.filter(message => message.role === 'tool').at(-1)
    const page = JSON.parse(message.content[0].text)
    assert.equal(page.contentRef, reference); assert.equal(page.path, expectedPath)
    if (expectedPath === '') { assert.equal(page.format, 'json-index'); assert.equal(page.entries[0].key, sourceId); return page }
    assert.equal(page.format, 'text'); assert.equal(typeof page.text, 'string', 'final tool text must never be another content reference')
    assert.equal(page.text, body); assert.equal(page.totalLength, body.length)
    assert.equal(page.offset, 0); assert.equal(page.nextOffset, null)
    assert.equal(page.resolvedRef.bytes, 615)
    assert.equal(page.contentIndex, undefined, 'explicit read must not require a dictionary hop')
    return page
  }
  let previous
  const first = await host(root, { call: (number, request) => {
    if (number === 1) return { name: 'group_coordinator_read_material', args: {} }
    if (number === 2) reference = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content[0].text).catalogRef.contentRef
    else { const page = check(request, paths[reads]); if (previous && variant === 'same-path-repeat') assert.deepEqual(page, previous); previous = page; reads++ }
    return reads < paths.length ? { name: 'model_content_read', args: { contentRef: reference, path: paths[reads] } } : { name: 'group_coordinator_submit', args: { decision } }
  } }); hosts.push(first)
  const readTools = [{ name: 'group_coordinator_read_material', effectClass: 'read', description: 'source catalogue', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ catalogRef: createModelContentIndex(first.ctx.sessions.get('literal-session'), { root: join(root, 'model-content') }).store({ [sourceId]: { actorId: 'original-user', version: 2, text: body, quoted: { text: body }, original: { text: body }, reply: body, context: { objective: body } } }) }) }]
  const binding = { conversationId: 'group', sessionId: 'literal-session', turnId: 'first', leaseEpoch: 1, sessionBound: false }
  const run = (h, binding) => h.sessions.run({ binding, input: { sources: [] }, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools, onSessionBound: async () => {}, onCandidate: async () => {} })
  assert.equal((await run(first, binding)).status, 'submitted'); assert.equal(reads, 6)
  await first.close()
  const second = await host(root, { call: (number, request) => {
    if (number === 1) return { name: 'model_content_read', args: { contentRef: reference, path: previous.path } }
    assert.deepEqual(check(request, previous.path), previous)
    return { name: 'group_coordinator_submit', args: { decision } }
  } }); hosts.push(second); second.setLease(2)
  assert.equal((await run(second, { ...binding, leaseEpoch: 2, sessionBound: true, turnId: 'second' })).status, 'submitted')
})

test('group single-input nested quotes, policy and read-tool copies share resolvable content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-index-')); t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const body = 'SOURCE_BODY_UNIQUE ' + 'authorization '.repeat(200), policy = 'POLICY_UNIQUE ' + 'only analysis '.repeat(200)
  const source = { sourceKey: 'message', sourceVersion: 1, actorId: 'owner', text: body }
  const input = { sources: [{ ...source, body, context: { source, policy, history: [source], quotes: [{ ...source, quoteRefs: [source] }] } }], groupResponsibility: policy }
  await h.sessions.run({ binding: { conversationId: 'group', sessionId: 'indexed-group', turnId: 'one', leaseEpoch: 1, sessionBound: false }, input,
    provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {},
    readTools: [{ name: 'read_material', effectClass: 'read', description: 'read', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => input }] })
  const text = JSON.stringify(h.requests.at(-1).messages)
  assert.equal(text.split(body).length - 1, 1, 'nested source and tool readback do not repeat the source body')
  assert.equal(text.split(policy).length - 1, 1, 'policy has one authoritative content entry')
})

test('ordinary group reads deduplicate while explicit content reads return literal evidence, including after reopen', async t => {
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'group-read-index-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const bodies = ['source original ', 'history evidence ', 'material evidence ', 'task evidence '].map(text => text.repeat(200))
  const names = ['group_coordinator_read_tasks', 'group_coordinator_read_history', 'group_coordinator_read_material', 'group_coordinator_read_task']
  const values = bodies.map((text, index) => ({ actorId: 'author-' + index, sourceVersion: index + 1, text, authorization: { approved: false }, unknownEffect: 'original-effect-' + index }))
  const readTools = names.map((name, index) => ({ name, effectClass: 'read', description: name, parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => structuredClone(values[index]) }))
  const original = structuredClone(values), metrics = []
  let reference
  const first = await host(root, { call: (number, request) => {
    if (number <= 8) return { name: names[(number - 1) % 4], args: {} }
    if (number === 9) {
      const last = request.messages.filter(message => message.role === 'tool').at(-1)
      reference = JSON.parse(last.content[0].text).contentRef
      assert.ok(reference, 'repeat read returns an exact resolvable record reference')
      return { name: 'model_content_read', args: { contentRef: reference, path: '/text' } }
    }
    const page = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content[0].text)
    assert.equal(page.text, bodies[3]); assert.equal(page.nextOffset, null)
    return { name: 'group_coordinator_submit', args: { decision } }
  } }); hosts.push(first)
  const binding = { conversationId: 'group', sessionId: 'group-content-reopen', turnId: 'first', leaseEpoch: 1, sessionBound: false }
  const run = (h, binding) => h.sessions.run({ binding, input: { sources: [{ runId: 'run', sourceKey: 'source', sourceVersion: 1, actorId: 'author-0', body: bodies[0] }], groupResponsibility: 'only analyze' },
    provider: 'group-fixture', model: 'scripted', decisionSchema, readTools, onSessionBound: async () => {}, onCandidate: async () => {} })
  assert.equal((await run(first, binding)).status, 'submitted')
  assert.deepEqual(values, original)
  for (const [i, text] of bodies.entries()) assert.equal(JSON.stringify(first.requests.at(-1).messages).split(text).length - 1, i === 3 ? 2 : 1)
  await first.close()
  const second = await host(root, { call: number => number === 1 ? { name: 'model_content_read', args: { contentRef: reference, path: '/text' } } : { name: 'group_coordinator_submit', args: { decision } } }); hosts.push(second)
  second.setLease(2)
  assert.equal((await run(second, { ...binding, leaseEpoch: 2, sessionBound: true, turnId: 'second' })).status, 'submitted')
  const saved = await inspectSession(second.ctx.sessionPersistence, binding.sessionId), folded = foldSurface(saved.events)
  const messages = folded.nodes.map(seq => deriveEventMessage(saved.events[seq], folded.projectedMessages)).filter(Boolean)
  for (const [i, text] of bodies.entries()) if (i > 0) assert.equal(JSON.stringify(messages).split(text).length - 1, i === 3 ? 3 : 1)
  for (const request of [first.requests[0], first.requests[4], first.requests.at(-1), second.requests.at(-1)]) metrics.push({
    currentHostBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.source?.groupCoordinator && !message.source.groupCoordinatorHistory))),
    oldHostBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.source?.groupCoordinatorHistory))),
    toolHistoryBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.role === 'tool'))),
    systemBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.role === 'system'))), schemaBytes: Buffer.byteLength(JSON.stringify(request.tools)),
    adapterRequestBytes: Buffer.byteLength(JSON.stringify(request)) })
  t.diagnostic(JSON.stringify({ scope: 'actual SDK scripted adapter UTF-8 JSON bytes; not provider tokens', metrics }))
})

test('native json-index pages reach exact previously unseen text, quoted author/version, and remain readable after reopen', async t => {
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'group-json-index-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const body = Array.from({ length: 1200 }, (_, i) => `证据段${i}🙂：仅分析，不发布；`).join('')
  const quote = { actorId: 'quoted-author', sourceVersion: 2, text: '旧引用只是背景，不构成授权。' }
  const record = { actorId: 'authorized-owner', sourceVersion: 3, corrects: 'source-v2', text: body, quoted: quote,
    ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['extra-' + i.toString().padStart(2, '0'), 'fact-' + i])) }
  let reference, buffer = '', phase = 'root', offset = 0, rootPages = 0, observedQuote
  const entries = new Map(), metrics = []
  const decode = (request, value) => {
    if (typeof value === 'string') return value
    for (const message of request.messages) for (const block of message.content ?? []) if (block.type === 'text') {
      try { const definition = JSON.parse(block.text).contentIndex?.[value.contentRef]; if (definition !== undefined) return definition } catch {}
    }
    assert.fail('text reference must have an exact visible definition after the real read tool')
  }
  const first = await host(root, { call: (number, request) => {
    if (number === 1) return { name: 'group_coordinator_read_material', args: {} }
    const last = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content[0].text)
    if (!reference) reference = last.materialRef.contentRef
    else if (phase === 'root') {
      assert.equal(last.format, 'json-index'); rootPages++
      for (const item of last.entries) entries.set(item.key, item)
      if (last.nextOffset !== null) return { name: 'model_content_read', args: { contentRef: reference, offset: last.nextOffset, limit: 20 } }
      assert.equal(entries.get('actorId').value, 'authorized-owner'); assert.equal(entries.get('sourceVersion').value, 3)
      assert.equal(entries.get('corrects').value, 'source-v2'); phase = 'body'
    } else if (phase === 'body') {
      assert.equal(last.offset, offset)
      assert.equal(typeof last.text, 'string', 'each final model-visible page carries literal text')
      assert.equal(last.totalLength, body.length)
      assert.equal(last.text, body.slice(offset, offset + 1000))
      assert.equal(last.nextOffset, offset + last.text.length < body.length ? offset + last.text.length : null)
      buffer += last.text
      if (last.nextOffset === null) { assert.equal(buffer, body); phase = 'quoted' } else offset = last.nextOffset
    } else if (phase === 'quoted') {
      assert.equal(last.format, 'json-index')
      const fields = new Map(last.entries.map(item => [item.key, item]))
      assert.equal(fields.get('actorId').value, 'quoted-author'); assert.equal(fields.get('sourceVersion').value, 2)
      observedQuote = fields.get('text').valueRef.contentRef; phase = 'quote-text'
    } else if (phase === 'quote-text') {
      assert.equal(decode(request, last.text), quote.text); phase = 'done'
    }
    if (!reference) assert.fail('material capability missing')
    if (phase === 'root') return { name: 'model_content_read', args: { contentRef: reference, limit: 20 } }
    if (phase === 'body') return { name: 'model_content_read', args: { contentRef: entries.get('text').valueRef.contentRef, offset, limit: 1000 } }
    if (phase === 'quoted') return { name: 'model_content_read', args: { contentRef: reference, path: '/quoted' } }
    if (phase === 'quote-text') return { name: 'model_content_read', args: { contentRef: observedQuote } }
    return { name: 'group_coordinator_submit', args: { decision } }
  } }); hosts.push(first)
  const readTools = [{ name: 'group_coordinator_read_material', effectClass: 'read', description: 'read indexed material', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ materialRef: createModelContentIndex(first.ctx.sessions.get('json-index-group'), { root: join(root, 'model-content') }).store(record) }) }]
  const binding = { conversationId: 'group', sessionId: 'json-index-group', turnId: 'one', leaseEpoch: 1, sessionBound: false }
  const run = (h, binding) => h.sessions.run({ binding, input: { sources: [] }, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools, onSessionBound: async () => {}, onCandidate: async () => {} })
  assert.equal((await run(first, binding)).status, 'submitted'); assert.equal(rootPages, 2); assert.equal(buffer, body)
  await first.close()
  let recoveredText
  const next = await host(root, { call: (number, request) => {
    if (number === 1) return { name: 'model_content_read', args: { contentRef: reference, path: '/quoted/text' } }
    const result = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content[0].text)
    assert.equal(typeof result.text, 'string')
    recoveredText = result.text
    return { name: 'group_coordinator_submit', args: { decision } }
  } }); hosts.push(next); next.setLease(2)
  assert.equal((await run(next, { ...binding, turnId: 'two', leaseEpoch: 2, sessionBound: true })).status, 'submitted')
  assert.equal(recoveredText, quote.text)
  const saved = await inspectSession(next.ctx.sessionPersistence, binding.sessionId), surface = foldSurface(saved.events)
  assert.ok(surface.nodes.map(seq => deriveEventMessage(saved.events[seq], surface.projectedMessages)).filter(Boolean).length > 1)
  for (const request of [first.requests[0], first.requests[3], first.requests.at(-1), next.requests.at(-1)]) {
    const bytes = role => Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.role === role)))
    metrics.push({ currentHostBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.source?.groupCoordinator && !message.source.groupCoordinatorHistory))),
      oldHostBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(message => message.source?.groupCoordinatorHistory))), toolHistoryBytes: bytes('tool'), systemBytes: bytes('system'), schemaBytes: Buffer.byteLength(JSON.stringify(request.tools)), adapterRequestBytes: Buffer.byteLength(JSON.stringify(request)) })
  }
  t.diagnostic(JSON.stringify({ scope: 'real SDK json-index directory and UTF-16 text pages; measured UTF-8 JSON bytes, no provider tokens', textLength: body.length, metrics }))
})

test('invalid migrated assistant provenance is rejected by SDK replay before any model wake or rewrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-invalid-replay-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const first = await host(root, { call: () => ({ name: 'group_coordinator_submit', args: { decision } }) }); hosts.push(first)
  const binding = { conversationId: 'group', sessionId: 'invalid-migration', turnId: 'first', leaseEpoch: 1, sessionBound: false }
  const run = (h, binding) => h.sessions.run({ binding, input: { sources: [] }, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} })
  await run(first, binding); await first.close()
  const path = await findSessionLog(join(root, 'sessions'), binding.sessionId)
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  const assistant = rows.find(row => row.type === 'assistant/message')
  assert.ok(assistant)
  assistant.sourceEventSeqs = [rows.find(row => row.type === 'user/message').seq]
  const invalid = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(path, invalid)
  const next = await host(root); hosts.push(next); next.setLease(2)
  await assert.rejects(run(next, { ...binding, leaseEpoch: 2, sessionBound: true, turnId: 'next' }), /assistant\/message embeds its source stream and cannot carry sourceEventSeqs/)
  assert.equal(next.requests.length, 0)
  assert.equal(await readFile(path, 'utf8'), invalid, 'invalid original is not silently repaired or reinterpreted')
})

test('repeated and empty source wakes keep one copy across SDK requests, including dynamic mode', async t => {
  for (const dynamic of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'group-growth-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root); t.after(() => h.close())
    const metrics = []
    const source = { runId: 'run', sourceKey: 'key', sourceVersion: 1, actorId: 'actor', body: 'AUTHORIZATION: only analyze. '.repeat(100), context: { quotes: [{ text: 'quoted boundary' }], attachments: [{ resourceRef: 'attachment' }] } }
    for (let leaseEpoch = 1; leaseEpoch <= 32; leaseEpoch++) {
      h.setLease(leaseEpoch)
      const sources = leaseEpoch <= 6 ? [source] : []
      const result = await h.sessions.run({ binding: { conversationId: 'group', sessionId: 'growth', turnId: 't' + leaseEpoch, leaseEpoch, sessionBound: leaseEpoch > 1 },
        dynamic, input: { sources, candidates: [{ obsolete: 'candidate'.repeat(1000) }] }, provider: 'group-fixture', model: 'scripted', decisionSchema,
        readTools: [{ name: 'read_material', effectClass: 'read', description: 'read', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'UNKNOWN_EFFECT: do not replay' }] }, execute: async () => ({}) }], onSessionBound: async () => {}, onCandidate: async () => {} })
      assert.equal(result.status, 'submitted')
      const messages = h.requests.at(-1).messages
      const hostInputs = messages.filter(m => m.source?.groupCoordinator)
      const sourceCopies = hostInputs.flatMap(m => m.content).flatMap(b => b.type === 'text' ? JSON.parse(b.text).sources ?? [] : [])
      assert.equal(sourceCopies.length, 1, `same source must occur once, dynamic=${dynamic}, wake=${leaseEpoch}`)
      const retained = sourceCopies[0]
      const quote = (retained.quotes ?? retained.context?.quotes)[0]
      assert.equal(indexedText(h.ctx.sessions.get('growth'), root, quote.text), 'quoted boundary')
      assert.match(JSON.stringify(messages), /UNKNOWN_EFFECT: do not replay/)
      assert.ok(hostInputs.length <= 2, 'empty histories must not accumulate')
      metrics.push({ wake: leaseEpoch, hostMessagesBytes: Buffer.byteLength(JSON.stringify(hostInputs)), messagesBytes: Buffer.byteLength(JSON.stringify(messages)), adapterRequestBytes: Buffer.byteLength(JSON.stringify(h.requests.at(-1))) })
    }
    const saved = await inspectSession(h.ctx.sessionPersistence, 'growth')
    assert.equal(saved.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append' && e.data.source?.groupCoordinator).length, 32)
    assert.ok(metrics.at(-1).hostMessagesBytes < metrics[0].hostMessagesBytes + 1000)
    assert.ok(metrics.at(-1).messagesBytes - metrics[6].messagesBytes < 25 * 700, 'only actual tool and decision history grows')
    t.diagnostic(JSON.stringify({ scope: 'group scripted adapter UTF-8 JSON bytes', dynamic, metrics: metrics.filter(item => [1, 6, 7, 32].includes(item.wake)) }))
  }
})

test('upgrade deduplicates stored histories but preserves independent versions, actors and authorization evidence', async t => {
  const { createUserMessage, createSystemMessage } = await import('@deepseek-ai/dsh-llm')
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'group-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const binding = { conversationId: 'group', sessionId: 'old-histories', turnId: 'old', leaseEpoch: 1, sessionBound: true }
  const session = h.ctx.sessions.prepare(binding.sessionId, { seed: [{ type: 'plugin:dingtalk/group-coordinator-session', seq: 0, time: Date.now(), ignorable: true,
    data: { version: 1, conversationId: binding.conversationId, sessionId: binding.sessionId, creationLease: 1 } }] })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('original system') }, { surfaceOp: 'append' })
  const source = { runId: 'old', sourceKey: 'source', sourceVersion: 1, actorId: 'owner', body: 'Analyze only', quotes: [{ text: 'approval required' }], attachments: [{ resourceRef: 'original-file' }] }
  const append = (sources, owner = binding) => session.append('user/message', createUserMessage({ source: { kind: 'coordinator', groupCoordinator: owner, groupCoordinatorHistory: true }, content: [{ type: 'text', text: JSON.stringify({ sources }) }] }), { surfaceOp: 'append' })
  for (let i = 0; i < 71; i++) append([{ ...source, runId: 'wake-' + i }])
  for (let i = 0; i < 97; i++) append([])
  const distinct = [{ ...source, sourceVersion: 2 }, { ...source, actorId: 'other-actor' }, { ...source, body: 'Do not touch production' },
    { ...source, quotes: [{ text: 'UNKNOWN_EFFECT: must investigate' }] }, { ...source, attachments: [{ resourceRef: 'other-file' }] },
    { ...source, context: { policy: 'New red line', authorization: { approved: false } } },
    { actorId: 'owner', body: 'UNIDENTIFIED_SOURCE' }, { actorId: 'owner', body: 'UNIDENTIFIED_SOURCE' }]
  distinct.forEach(item => append([item]))
  append([{ ...source, body: 'FOREIGN_GROUP_BOUNDARY' }], { ...binding, conversationId: 'another-group' })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const writer = await h.ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents()); await writer.close()
  const original = (await inspectSession(h.ctx.sessionPersistence, binding.sessionId)).events
  h.setLease(2)
  await h.sessions.run({ binding: { ...binding, leaseEpoch: 2, turnId: 'new' }, input: { sources: [], groupResponsibility: 'CURRENT_RED_LINE', candidates: [] },
    provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {},
    readTools: [{ name: 'read_material', effectClass: 'read', description: 'read', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'material' }] }, execute: async () => ({}) }] })
  const saved = await inspectSession(h.ctx.sessionPersistence, binding.sessionId), folded = foldSurface(saved.events)
  assert.deepEqual(saved.events.slice(0, original.length), original)
  const messages = folded.nodes.map(seq => deriveEventMessage(saved.events[seq], folded.projectedMessages)).filter(Boolean)
  const histories = messages.filter(m => m.source?.groupCoordinatorHistory)
  const sources = histories.flatMap(m => JSON.parse(m.content[0].text).sources)
  assert.equal(sources.length, 2 + distinct.length)
  assert.equal(sources.filter(item => item.body === 'UNIDENTIFIED_SOURCE').length, 2)
  assert.equal(histories.some(m => JSON.parse(m.content[0].text).sources.length === 0), false)
  assert.match(JSON.stringify(h.requests.at(-1)), /CURRENT_RED_LINE/)
  for (const marker of ['approval required', 'UNKNOWN_EFFECT', 'other-file', 'New red line', 'approved', 'FOREIGN_GROUP_BOUNDARY']) assert.match(JSON.stringify(sources), new RegExp(marker))
  t.diagnostic(JSON.stringify({ scope: 'group Host source history, UTF-8 JSON bytes', beforeBytes: Buffer.byteLength(JSON.stringify(original.filter(e => e.type === 'user/message').map(e => e.data))), afterBytes: Buffer.byteLength(JSON.stringify(histories)), originalHistoryCount: original.filter(e => e.type === 'user/message').length, visibleHistoryCount: histories.length }))
})
async function host(root, options = {}) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: options.includeRuntimeContext ?? false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  new ApprovalService(ctx, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, { presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  const memberships = new Map()
  ctx.provide('workspaceRegistry', {
    async resolveByPath(path) { return memberships.get(path) },
    async create(path) {
      const target = { sessionIds: [], async attachSession(id) {
        assert.equal((await inspectSession(ctx.sessionPersistence, id)).meta.cwd, path)
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
      } }
      memberships.set(path, target); return target
    },
  })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  const optionsForHost = options
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const failure=optionsForHost.providerFailure?.(requests.length)
      if(failure){yield {type:'finish',reason:{kind:'error',failure}};return}
      if (optionsForHost.noSubmission) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      const selected = optionsForHost.call?.(requests.length, options)
      const id = `call-${requests.length}`, name = selected?.name ?? (requests.length === 1 ? 'read_material' : 'group_coordinator_submit')
      const args = JSON.stringify(selected?.args ?? (name === 'read_material' ? { ref: 'file' } : { decision: optionsForHost.decision?.(requests.length, options) ?? decision }))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['group-fixture'], new Scripted())
  let lease = 1
  const sessions = createGroupCoordinatorSessions({ ctx, isCurrent: async b => b.leaseEpoch === lease, contentRoot: join(root, 'model-content'), ...options })
  return { ctx, requests, sessions, memberships, setLease(n) { lease = n }, async close() { await sessions.close(); await ctx.fiber.dispose() } }
}

test('原生群会话同轮读取材料后提交，跨轮恢复同一session并保留历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let reads = 0, candidates = 0
  const terminalResults = []
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'group_coordinator_submit') terminalResults.push(result.concludesTurn === true) })
  const run = leaseEpoch => h.sessions.run({ binding: { conversationId: 'group', sessionId: 'group-session', turnId: `turn-${leaseEpoch}`, leaseEpoch, sessionBound: leaseEpoch > 1 },
    input: { messages: [{ actorId: 'user', text: '核对材料后按已有任务推进' }] }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async value => { candidates++; assert.deepEqual(value, decision) },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取授权材料', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async ({ ref }) => { assert.equal(ref, 'file'); reads++; return { text: '真实材料内容' } } }] })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.equal(reads, 1); assert.equal(candidates, 2)
  assert.deepEqual(terminalResults, [true, true])
  const persisted = await inspectSession(h.ctx.sessionPersistence, 'group-session')
  assert.equal(persisted.events.filter(e => e.type === 'plugin:dingtalk/group-coordinator-session').length, 1)
  assert.equal(persisted.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
  assert.equal(h.requests.length, 3)
  await assert.rejects(run(2), /LEASE_NOT_ADVANCED/)
})

test('原生群会话候选任务版本过期可反馈并重新提交，不新建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { if (++submissions === 1) throw Object.assign(Error('TASK_VERSION_STALE'), { code: 'TASK_VERSION_STALE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 2)
  assert.equal(h.requests.length, 3)
})


test('群逻辑会话跨原生宿主重启恢复，禁止注入写工具', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tool = { name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }
  const args = { binding: { conversationId: 'g', sessionId: 'restart-session', turnId: 'first', leaseEpoch: 1, sessionBound: false }, input: { message: '先审查' }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    readTools: [tool], onSessionBound: async () => {}, onCandidate: async () => {} }
  const first = await host(root)
  assert.equal((await first.sessions.run(args)).status, 'submitted')
  await first.close()
  const second = await host(root); t.after(() => second.close()); second.setLease(2)
  const next = { ...args, binding: { ...args.binding, turnId: 'second', leaseEpoch: 2, sessionBound: true }, input: { message: '原需求补充' } }
  await assert.rejects(second.sessions.run({ ...next, readTools: [{ ...tool, effectClass: 'write' }] }), /READ_TOOL_REQUIRED/)
  assert.equal((await second.sessions.run(next)).status, 'submitted')
  const saved = await inspectSession(second.ctx.sessionPersistence, 'restart-session')
  assert.equal(saved.events.filter(e => e.type === 'plugin:dingtalk/group-coordinator-session').length, 1)
  assert.equal(saved.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
})


for (const stop of ['cancel', 'close']) test(`同群会话互斥，${stop}等待原生工具排空后释放会话`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const started = Promise.withResolvers()
  const args = { binding: { conversationId: 'g', sessionId: 'cancel-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async () => { throw Error('不得提交') },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async (_args, exec) => {
        started.resolve()
        await new Promise((resolve, reject) => { if (exec.signal.aborted) reject(exec.signal.reason); else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true }) })
        return {}
      } }] }
  const running = h.sessions.run(args)
  await started.promise
  await assert.rejects(h.sessions.run(args), /GROUP_COORDINATOR_BUSY/)
  if (stop === 'close') await h.sessions.close()
  else await h.sessions.cancel('g')
  assert.equal((await running).status, 'cancelled')
  assert.equal(h.ctx.agents.get('cancel-session'), undefined)
})

test('来源版本过期结束旧claim，不在旧来源上反复提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { submissions++; throw Object.assign(Error('MESSAGE_STALE'), { code: 'MESSAGE_STALE' }) } })
  assert.equal(result.status, 'stale'); assert.equal(result.reason, 'MESSAGE_STALE'); assert.equal(submissions, 1)
  assert.equal(h.requests.length, 2)
})


test('原生会话超过32次合法反馈仍可继续提交，不设自造步数上限', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-unbounded-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const result = await h.sessions.run({ binding: { conversationId: 'group', sessionId: 'unbounded', turnId: 'turn', leaseEpoch: 1, sessionBound: false },
    input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {},
    onCandidate: async () => { if (++submissions <= 33) throw Object.assign(new Error('合并重复动作'), { code: 'GROUP_COORDINATOR_EXISTING_TASK_REQUIRES_UPDATE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 34)
})

test('旧职责目录派生到Agent根，完整继承日志，恢复群名和完全权限且不调用模型', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-relocation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let cwd = join(root, 'session-workspaces', '群聊常驻'), name = '具有超过二十八字的完整群聊名称用于验证名称没有被事项标题截断'
  await mkdir(cwd, { recursive: true })
  const h = await host(root, { getWorkspaceDir: () => cwd, getGroupName: () => name }); t.after(() => h.close())
  const args = { binding: { conversationId: 'group', sessionId: 'old-group', turnId: 'first', leaseEpoch: 1, sessionBound: false },
    input: { sources: [{ runId: 'm1', sourceVersion: 1, actorId: 'user', sourceKey: 'source:m1', body: '不要改生产，只分析；附件已提供', context: { quotes: [{ text: '引用原文' }], attachments: [{ resourceRef: 'file' }] } }], candidates: [{ obsoleteSnapshot: '旧目录'.repeat(20000) }] },
    provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} }
  assert.equal((await h.sessions.run(args)).status, 'submitted')
  const parent = await inspectSession(h.ctx.sessionPersistence, 'old-group')
  const parentPath = await findSessionLog(join(root, 'sessions'), parent.meta.id), originalBytes = await readFile(parentPath)
  assert.equal(parent.events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal(parent.events.findLast(e => e.type === 'permission/preset').data.preset, 'danger-full-access')
  assert.equal(parent.events.findLast(e => e.type === 'approval/policy').data.policy, 'never')
  cwd = root
  const binding = { conversationId: 'group', sessionId: 'old-group', sessionBound: true, leaseEpoch: 1 }
  const callsBefore = h.requests.length
  const relocated = await h.sessions.prepare(binding)
  assert.equal(relocated.previousSessionId, 'old-group')
  assert.equal(relocated.expectedLeaseEpoch, 1)
  assert.equal(h.requests.length, callsBefore)
  // 模拟绑定CAS回执丢失：同一旧绑定只恢复同一个派生Session，不重复复制。
  assert.deepEqual(await h.sessions.prepare(binding), relocated)
  const child = await inspectSession(h.ctx.sessionPersistence, relocated.sessionId)
  assert.equal(child.meta.cwd, root)
  assert.deepEqual(h.memberships.get(root).sessionIds, [relocated.sessionId])
  assert.ok(h.ctx.sessions.get(relocated.sessionId), '空闲协调会话仍挂接，宿主可读标题与权限投影')
  const visible = h.ctx.sessionProjections.cachedSnapshot(h.ctx.sessions.get(relocated.sessionId))
  assert.equal(visible.values.title, name)
  assert.equal(visible.values.permissions.currentValue, 'danger-full-access')
  assert.equal(child.meta.parentSession, 'old-group')
  assert.equal(child.inheritedEventCount, parent.events.length)
  assert.deepEqual(child.events.slice(0, parent.events.length), parent.events)
  assert.deepEqual(await readFile(parentPath), originalBytes)
  const history = child.events.findLast(e => e.data?.source?.groupCoordinatorHistory)
  assert.equal(indexedText(h.ctx.sessions.get(relocated.sessionId), root, JSON.parse(history.data.content[0].text).sources[0].body), args.input.sources[0].body)
  assert.deepEqual(JSON.parse(history.data.content[0].text).sources[0].attachments, args.input.sources[0].context.attachments)
  assert.ok(!history.data.content[0].text.includes('obsoleteSnapshot'))
  h.setLease(3); name = '广场与编辑器迭代'
  assert.equal(await h.sessions.prepare({ conversationId: 'group', sessionId: relocated.sessionId, sessionBound: true, leaseEpoch: 2 }), null)
  assert.equal(h.requests.length, callsBefore)
  assert.equal((await inspectSession(h.ctx.sessionPersistence, relocated.sessionId)).events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal((await h.sessions.run({ ...args, input: { sources: [], candidates: [{ current: true }] },
    binding: { ...args.binding, sessionId: relocated.sessionId, turnId: 'next', leaseEpoch: 3, sessionBound: true } })).status, 'submitted')
  const saved = await inspectSession(h.ctx.sessionPersistence, relocated.sessionId)
  assert.equal(saved.events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal(saved.events.filter(e => e.type === 'plugin:dingtalk/group-coordinator-session').length, 2)
  await assert.rejects(h.sessions.run({ ...args, binding: { ...args.binding, sessionId: relocated.sessionId, leaseEpoch: 3, sessionBound: true } }), /LEASE_NOT_ADVANCED/)
})

test('每轮完整输入保留，下一轮原生surface只保留历史来源而不重复Host快照', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-input-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const input = { sources: [{ runId: 'm1', sourceVersion: 1, actorId: 'user', sourceKey: 'source:m1', body: '完整原文：仅分析、不执行' }], candidates: [{ fullHostSnapshot: '旧候选'.repeat(10000) }] }
  const args = { binding: { conversationId: 'group', sessionId: 'history-group', turnId: 'first', leaseEpoch: 1, sessionBound: false },
    input, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} }
  await h.sessions.run(args)
  const before = JSON.stringify(h.requests[0].messages)
  assert.ok(before.includes('fullHostSnapshot'))
  h.setLease(2)
  await h.sessions.run({ ...args, input: { sources: [{ ...input.sources[0], runId: 'm2', body: '补充事实' }], candidates: [{ currentSnapshot: '本轮完整目录' }] },
    binding: { ...args.binding, turnId: 'next', leaseEpoch: 2, sessionBound: true } })
  const current = JSON.stringify(h.requests.at(-1).messages)
  const historyMessage = h.requests.at(-1).messages.find(message => message.source?.groupCoordinatorHistory)
  assert.equal(indexedText(h.ctx.sessions.get('history-group'), root, JSON.parse(historyMessage.content[0].text).sources[0].body), input.sources[0].body)
  assert.ok(current.includes('currentSnapshot'))
  assert.ok(!current.includes('fullHostSnapshot'))
  assert.ok(current.length < before.length / 2)
  t.diagnostic(`模型可见输入字符：完整旧快照=${before.length}，下一轮保留原文与当前快照=${current.length}`)
  const saved = await inspectSession(h.ctx.sessionPersistence, 'history-group')
  assert.ok(saved.events.some(e => e.type === 'user/message' && e.surfaceOp === 'append' && JSON.stringify(e.data).includes('fullHostSnapshot')))
  assert.equal(saved.events.filter(e => e.data?.source?.groupCoordinatorHistory).length, 1)
})

test('常驻空闲挂接保留原生投影、拒绝任意模型步进，关闭释放全部句柄',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-idle-visible-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const h=await host(root,{getWorkspaceDir:()=>root,getGroupName:()=> '业务群'});t.after(()=>h.close());
 await h.sessions.run({binding:{conversationId:'g',sessionId:'visible-group',turnId:'t',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,onSessionBound:async()=>{},onCandidate:async()=>{}});
 const live=h.ctx.sessions.get('visible-group');assert.ok(live);assert.equal(h.ctx.sessionProjections.cachedSnapshot(live).values.title,'业务群');
 assert.deepEqual(h.memberships.get(root).sessionIds,['visible-group']);
 const calls=h.requests.length;const {createUserMessage}=await import('@deepseek-ai/dsh-llm');
 const agent=h.ctx.agents.get('visible-group');agent.steer(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'用户误触发送'}]}));await agent.whenIdle();assert.equal(h.requests.length,calls);
 await h.sessions.close();assert.equal(h.ctx.agents.get('visible-group'),undefined);assert.equal(h.ctx.sessions.get('visible-group'),undefined);
});


test('原生正常结束但不提交仍保持no_submission，接纳后晚到错误不否定决定',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-finish-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 for(const noSubmission of [true,false]){
  const h=await host(join(root,String(noSubmission)),{noSubmission});t.after(()=>h.close())
  let accepted=false
  const result=await h.sessions.run({binding:{conversationId:'g',sessionId:'finish-session',turnId:'turn',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,
   readTools:[{name:'read_material',effectClass:'read',description:'读取',parameters:{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:v.text}]},execute:async()=>({text:'材料'})}],
   onSessionBound:async()=>{},onCandidate:async()=>{
    accepted=true
    const session=h.ctx.sessions.get('finish-session'),snapshot=session.snapshotEvents.bind(session)
    session.snapshotEvents=()=>{const events=snapshot();return [...events,{seq:(events.at(-1)?.seq??0)+1,type:'turn/end',data:{reason:{kind:'error',error:{code:'PI_AI_ERROR',message:'Codex error: Our servers are currently overloaded. Please try again later.'}}}}]}
   }})
  assert.equal(result.status,noSubmission?'no_submission':'submitted')
  assert.equal(accepted,!noSubmission)
  if(accepted)assert.equal(h.ctx.sessions.get('finish-session').snapshotEvents().at(-1).data.reason.kind,'error')
 }
})


test('上一轮原生错误不污染本轮正常无提交',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-error-watermark-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const h=await host(root,{noSubmission:true,providerFailure:n=>n===1?{code:'PI_AI_ERROR',message:'authentication failed'}:null});t.after(()=>h.close())
 const args={binding:{conversationId:'g',sessionId:'watermark-session',turnId:'first',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,readTools:[],onSessionBound:async()=>{},onCandidate:async()=>{assert.fail('不得提交')}}
 await assert.rejects(h.sessions.run(args),{code:'GROUP_COORDINATOR_PROVIDER_FAILED'})
 h.setLease(2)
 const result=await h.sessions.run({...args,binding:{...args.binding,turnId:'second',leaseEpoch:2,sessionBound:true}})
 assert.equal(result.status,'no_submission');assert.equal(h.requests.length,2)
})


test('阶段授权原文不匹配在同会话反馈修正，不改写来源或转澄清',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-authorization-source-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const original={sourceKey:'source-user',actorId:'requester',sourceQuote:'按文档开发'}
 const h=await host(root,{decision:(n,request)=>{
  if(n===3)assert.match(JSON.stringify(request.messages),/授权objective必须是该sourceQuote中的逐字来源片段/u)
  return {kind:'create',objective:'依据所分享文档实现数据集导入导出功能',stageAuthorizations:[{...original,objective:n===2?'实现数据集导入导出功能':'按文档开发'}]}
 }});t.after(()=>h.close())
 const schema={type:'object',properties:{kind:{type:'string'},objective:{type:'string'},stageAuthorizations:{type:'array',items:{type:'object',properties:{sourceKey:{type:'string'},actorId:{type:'string'},sourceQuote:{type:'string'},objective:{type:'string'}},required:['sourceKey','actorId','sourceQuote','objective'],additionalProperties:false}}},required:['kind','objective','stageAuthorizations'],additionalProperties:false}
 let calls=0,accepted=0
 const result=await h.sessions.run({binding:{conversationId:'g',sessionId:'source-session',turnId:'t',leaseEpoch:1,sessionBound:false},input:{source:original},provider:'group-fixture',model:'scripted',decisionSchema:schema,
  readTools:[{name:'read_material',effectClass:'read',description:'读取',parameters:{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:v.text}]},execute:async()=>({text:'按文档开发'})}],
  onSessionBound:async()=>{},onCandidate:async candidate=>{
   calls++;const authorization=candidate.stageAuthorizations[0]
   for(const key of Object.keys(original))assert.equal(authorization[key],original[key])
   assert.equal(candidate.kind,'create')
   if(!authorization.sourceQuote.includes(authorization.objective))throw Object.assign(Error('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID'),{code:'TASK_STAGE_AUTHORIZATION_SOURCE_INVALID'})
   accepted++
  }})
 assert.equal(result.status,'submitted');assert.equal(calls,2);assert.equal(accepted,1)
 assert.equal(result.decision.stageAuthorizations[0].objective,'按文档开发')
 assert.equal(h.requests.length,3)
})

for (const variant of ['idle', 'active', 'running', 'foreign-input', 'identity', 'lease', 'changed-during-fork']) test(`外部观察会话受管派生保留原实例并核验边界：${variant}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-observer-'))
  let h, external, sessions
  t.after(async () => { await sessions?.close(); await external?.dispose(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await host(root, { getWorkspaceDir: () => root, includeRuntimeContext: true })
  await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'observed', turnId: 'first', leaseEpoch: 1, sessionBound: false },
    input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} })
  await h.sessions.close()
  external = await h.ctx.agents.resume({ resumeSessionId: 'observed' })
  await external.agent.whenIdle()
  sessions = createGroupCoordinatorSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: () => root })
  const binding = { conversationId: variant === 'identity' ? 'other' : 'g', sessionId: 'observed', status: 'idle', sessionBound: true, leaseEpoch: variant === 'lease' ? 2 : 1 }
  let release, busy
  if (variant === 'active') busy = external.agent.runMaintenance(() => new Promise(resolve => { release = resolve }))
  if (variant === 'running') {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const entered = Promise.withResolvers(), gate = Promise.withResolvers()
    release = gate.resolve
    external.agent.ctx.on('agent/pre-step', async (_event, next) => { entered.resolve(); await gate.promise; return next() })
    external.agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '活动输入' }] }))
    await entered.promise
    assert.equal(external.agent.status, 'running')
  }
  if (variant === 'foreign-input') external.agent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '额外输入' }] }, { surfaceOp: 'append' })
  if (variant === 'changed-during-fork') {
    const create = h.ctx.agents.create.bind(h.ctx.agents)
    h.ctx.agents.create = async options => {
      const handle = await create(options)
      external.agent.session.append('plugin:dingtalk/test-input-changed', {})
      return handle
    }
  }
  const before = external.agent.session.snapshotEvents(), calls = h.requests.length
  if (variant !== 'idle') {
    try { await assert.rejects(sessions.prepare(binding)) } finally { release?.(); await busy; await external.agent.whenIdle() }
    assert.equal(h.ctx.agents.get('observed'), external.agent)
    return
  }
  const relocated = await sessions.prepare(binding)
  assert.equal(relocated.previousSessionId, 'observed')
  assert.equal(relocated.expectedLeaseEpoch, 1)
  assert.notEqual(relocated.sessionId, 'observed')
  assert.equal(h.ctx.agents.get('observed'), external.agent)
  assert.deepEqual(external.agent.session.snapshotEvents(), before)
  assert.equal(h.requests.length, calls)
  assert.deepEqual(await sessions.prepare(binding), relocated)
  const child = await inspectSession(h.ctx.sessionPersistence, relocated.sessionId)
  assert.equal(child.meta.parentSession, 'observed')
  assert.deepEqual(child.events.slice(0, child.inheritedEventCount), before)
  assert.equal((await sessions.run({ binding: { ...binding, sessionId: relocated.sessionId, leaseEpoch: 3, turnId: 'next' }, input: {},
    provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} })).status, 'submitted')
})


test('Task权限拒绝反馈保持原话题并区分公共fact与合法revise',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-public-fact-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const h=await host(root);t.after(()=>h.close());let attempts=0
 const result=await h.sessions.run({binding:{conversationId:'g',sessionId:'public-session',turnId:'t',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,
  readTools:[{name:'read_material',effectClass:'read',description:'读取',parameters:{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:v.text}]},execute:async()=>({text:'公共事实'})}],
  onSessionBound:async()=>{},onCandidate:async()=>{if(++attempts===1)throw Object.assign(Error('WORKFLOW_TASK_FORBIDDEN'),{code:'WORKFLOW_TASK_FORBIDDEN'})}})
 assert.equal(result.status,'submitted');assert.equal(attempts,2)
 const feedback=JSON.stringify(h.requests[2].messages)
 assert.match(feedback,/不得改绑新话题规避权限/u);assert.match(feedback,/scope=conversation/u);assert.match(feedback,/原Task用revise更新/u)
})
