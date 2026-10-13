import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readExecutedAgentQueryRefs } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { restoreEngineeringReadEvidence } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'

function receipt(value, extra = {}) {
  return { seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: { message: {
    role: 'tool', toolCallId: 'read', source: { kind: 'tool', callId: 'read' },
    content: [{ type: 'text', text: JSON.stringify(value) }], ...extra,
  } } }
}

test('alpha2 query receipts retain call provenance and reject failed or forged evidence', () => {
  const call = { seq: 1, type: 'tool/call', data: { name: 'query', callId: 'read' } }
  const result = receipt({ evidenceRef: 'verified.json' })
  assert.deepEqual(readExecutedAgentQueryRefs([call, result], ['query']), ['verified.json'])
  assert.deepEqual(readExecutedAgentQueryRefs([call, receipt({ evidenceRef: 'bad.json' }, { isError: true })], ['query']), [])
  assert.throws(() => readExecutedAgentQueryRefs([call, receipt({ evidenceRef: 'forged.json' }, { toolCallId: 'other' })], ['query']), /QUERY_EVIDENCE_INVALID/)
  assert.throws(() => readExecutedAgentQueryRefs([call, receipt({ evidenceRef: 'forged.json' }, { source: { kind: 'tool', callId: 'other' } })], ['query']), /QUERY_EVIDENCE_INVALID/)
})

test('alpha2 engineering read restoration requires the same identity and current bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alpha2-engineering-read-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'src'))
  const text = 'const value = 1\n'
  await writeFile(join(directory, 'src/a.js'), text)
  const binding = { taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, inputDigest: 'digest', sessionId: 'session' }
  const events = [
    { type: 'plugin:dingtalk/execution-session', data: { identity: binding } },
    { seq: 1, type: 'tool/call', data: { name: 'engineering_repo_inspect', callId: 'read', arguments: JSON.stringify({ operation: 'read', path: 'src/a.js' }) } },
    receipt({ path: 'src/a.js', text, expectedHash: createHash('sha256').update(text).digest('hex') }),
  ]
  const input = { events, binding, paths: ['src/a.js'], directory, allowedPrefixes: ['src/'] }
  assert.deepEqual(await restoreEngineeringReadEvidence(input), ['src/a.js'])
  assert.deepEqual(await restoreEngineeringReadEvidence({ ...input, binding: { ...binding, sessionId: 'foreign' } }), [])
  events[2].data.message.isError = true
  assert.deepEqual(await restoreEngineeringReadEvidence(input), [])
  delete events[2].data.message.isError
  await writeFile(join(directory, 'src/a.js'), 'changed')
  assert.deepEqual(await restoreEngineeringReadEvidence(input), [])
})
