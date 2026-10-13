import assert from 'node:assert/strict'
import test from 'node:test'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { ownerImmutableReadReceipts, previouslyReadOwnerArtifacts, compactOwnerReadProjection } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'
import { inspectLegacyTurnFailure } from '../packages/dingtalk-dsh-assistant/execution-session.js'

function ownerRead() {
  const binding = { taskId: 'task', sessionId: 'owner', requirementRevision: 1 }
  const value = { kind: 'owner-context-section', value: 'An immutable task requirement' }
  const text = JSON.stringify(value), ref = `sha256-${executionDigest(value)}.json`
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'coordinator', taskOwner: binding }, content: [{ type: 'text', text: JSON.stringify({ task: { requirementRevision: 1 } }) }] } },
    { seq: 1, type: 'tool/call', data: { name: 'task_owner_read_artifact', callId: 'read-1', arguments: JSON.stringify({ artifactRef: ref }) } },
    { seq: 2, type: 'tool/result', surfaceOp: 'append', data: { message: { id: 'result-1', role: 'tool', toolCallId: 'read-1', source: { kind: 'tool', callId: 'read-1' }, content: [{ type: 'text', text: JSON.stringify({ artifact: text, totalLength: text.length }) }] } } },
  ]
  return { binding, text, ref, events }
}

test('V4 tool-role receipts preserve complete immutable-read coverage and reject error or foreign results', () => {
  const { binding, ref, text, events } = ownerRead()
  assert.deepEqual(previouslyReadOwnerArtifacts(events, binding), [ref])
  assert.equal(ownerImmutableReadReceipts(events, binding).get(ref).text, text)
  for (const change of [message => { message.isError = true }, message => { message.toolCallId = 'foreign' }]) {
    const invalid = structuredClone(events); change(invalid[2].data.message)
    assert.equal(ownerImmutableReadReceipts(invalid, binding).size, 0)
    assert.deepEqual(previouslyReadOwnerArtifacts(invalid, binding), [])
  }
  const replacement = structuredClone(events); replacement[2].surfaceOp = { op: 'replace', startSeq: 2, endSeq: 2 }
  assert.equal(ownerImmutableReadReceipts(replacement, binding).size, 0)
})

test('V4 read compaction keeps tool-role identity and replaces direct content without wrapping results', () => {
  const { binding, ref, events } = ownerRead(), appended = []
  const session = { snapshotEvents: () => events, surface: { nodes: [2] }, append: (...args) => appended.push(args) }
  compactOwnerReadProjection(session, binding, new Set())
  assert.equal(appended.length, 1)
  const [type, data, options] = appended[0]
  assert.equal(type, 'tool/result'); assert.equal(data.message.role, 'tool')
  assert.equal(data.message.toolCallId, 'read-1'); assert.equal(data.message.content[0].type, 'text')
  assert.equal(JSON.parse(data.message.content[0].text).historicalArtifactRead.artifactRef, ref)
  assert.deepEqual(options.sourceEventSeqs, [2])
  assert.equal(events[2].data.message.content[0].text.includes('historicalArtifactRead'), false)
})

function recoveryFixture(identityType = 'plugin:dingtalk/execution-session') {
  const binding = { taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, inputDigest: 'digest', sessionId: 'execution', leaseEpoch: 1, sessionBound: true }
  const { leaseEpoch, sessionBound, ...identity } = binding
  const events = [
    { seq: 0, type: identityType, ignorable: true, data: { version: 1, identity, creationLease: 1 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'runtime-context', form: 'snapshot' }, content: [] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'coordinator', executionSession: { sessionId: binding.sessionId, leaseEpoch: 1 } }, content: [] } },
    { seq: 3, type: 'tool/call', data: { name: 'engineering_repo_inspect', callId: 'inspect-1', arguments: JSON.stringify({ operation: 'read', path: 'missing.js' }) } },
    { seq: 4, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'inspect-1', isError: true, content: [{ type: 'text', text: 'Error: ENGINEERING_READ_PATH_INVALID' }] } } },
    { seq: 5, type: 'step/end', data: {} },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'blocked' } } },
  ]
  let closed = 0
  const ctx = { agents: { get() {} }, sessions: { get() {} }, sessionPersistence: { async open(id, access) {
    assert.equal(id, binding.sessionId); assert.equal(access, 'read')
    return { header: { id }, inheritedEventCount: 0, async read() { return { events } }, async close() { closed++ } }
  } } }
  return { binding, events, ctx, closed: () => closed }
}

test('migrated plugin identity and V4 runtime-context/tool errors retain safe execution recovery', async () => {
  for (const identityType of ['plugin:dingtalk/execution-session', 'dingtalk/execution-session']) {
    const f = recoveryFixture(identityType)
    const result = await inspectLegacyTurnFailure(f.ctx, f.binding, 'execution_tool_failed')
    assert.equal(result.failure.code, 'ENGINEERING_READ_PATH_INVALID'); assert.equal(f.closed(), 1)
  }
})

test('migration compatibility still rejects duplicate identities, wrong call provenance, and unrelated input', async () => {
  const duplicate = recoveryFixture()
  duplicate.events.push({ ...duplicate.events[0], type: 'dingtalk/execution-session' })
  await assert.rejects(inspectLegacyTurnFailure(duplicate.ctx, duplicate.binding, 'execution_tool_failed'), /identity_mismatch/)
  assert.equal(duplicate.closed(), 1)
  for (const change of [f => { f.events[4].data.message.toolCallId = 'foreign' }, f => { f.events[1].data.source.kind = 'untrusted' }]) {
    const f = recoveryFixture(); change(f)
    assert.equal(await inspectLegacyTurnFailure(f.ctx, f.binding, 'execution_tool_failed'), null)
    assert.equal(f.closed(), 1)
  }
})

test('real V3 JSONL migration preserves plugin identity payloads and originals through V4 write/reopen', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'dsh-alpha2-legacy-'))
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', packChunks: false })
    for (const [id, type, data] of [
      ['old-owner', 'dingtalk/task-owner-session', { version: 1, taskId: 'task', sessionId: 'old-owner', ownerEpoch: 1, creationLease: 1 }],
      ['old-execution', 'dingtalk/execution-session', { version: 1, identity: { taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, inputDigest: 'digest', sessionId: 'old-execution' }, creationLease: 1 }],
    ]) {
      const directory = join(root, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'session.v3.jsonl')
      const original = [
        { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
        { type, seq: 0, time: 1, ignorable: true, data },
      ].map(row => JSON.stringify(row) + '\n').join('')
      await writeFile(path, original)
      const reader = await ctx.sessionPersistence.open(id, 'read')
      try {
        const { events } = await reader.read()
        assert.equal(events[0].type, `plugin:${type}`)
        assert.equal(events[0].ignorable, true); assert.deepEqual(events[0].data, data)
      } finally { await reader.close() }
      assert.deepEqual(await readdir(directory), ['session.v3.jsonl'], 'read-only inspection does not publish a successor')
      const writer = await ctx.sessionPersistence.open(id, 'write')
      try { await writer.flush() } finally { await writer.close() }
      assert.equal(await readFile(path, 'utf8'), original)
      assert.ok((await readdir(directory)).includes('session.v4.jsonl'))
      const reopened = await ctx.sessionPersistence.open(id, 'read')
      try { assert.deepEqual((await reopened.read()).events[0].data, data) } finally { await reopened.close() }
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
