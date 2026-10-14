import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeShell, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

const test = (name, run) => testRunner(name, { timeout: 30000, ...(!available ? { skip: reason } : {}) }, run)
const call = (name, args) => ({ name, args })
const finish = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })
const message = { groupId: 'native-group', messageId: 'personal-skills-1', senderOpenDingTalkId: 'native-user',
  text: '测试助手，Read the relevant personal guide and verify its reference in an independent execution.', occurredAt: '2026-10-13T16:00:00Z', timestamp: '2026-10-13T16:00:00Z' }
const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map(name => 'personal-' + name)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-personal-skills-'))
  // Personal assets are deliberately outside the managed task workspaces and plugin package.
  const skillRoot = join(root, 'personal-assets'), hosts = []
  for (const name of names) {
    await mkdir(join(skillRoot, name, 'references'), { recursive: true })
    await writeFile(join(skillRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Routing summary for ${name}.\n---\nBODY_ONLY_${name}\nRead references/procedure.md only when needed.\n`)
    await writeFile(join(skillRoot, name, 'references/procedure.md'), `REFERENCE_ONLY_${name}`)
  }
  t.after(async () => { try { for (const host of hosts.toReversed()) await host.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { root, skillRoot, async host(decide, options = {}) {
    const host = await nativeTaskHost(root, decide, { skillDirs: [skillRoot], ...options }); hosts.push(host); return host
  } }
}

test('native personal skills are discovered cheaply, loaded independently by both sessions, and references stay execution-owned', async t => {
  const f = await fixture(t), steps = new Map(), first = new Map()
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) {
      assert.ok(!JSON.stringify(request).includes('BODY_ONLY_'), 'Topic coordination does not acquire personal workflow bodies')
      assert.ok(!tools.includes(nativeShell) && !tools.includes('write'), 'Topic coordination cannot execute business work')
      return topicCalls
    }
    const role = tools.includes('task_delegate') ? 'owner' : 'execution'
    if (role === 'owner' && input.executions.length) return [finish('complete', 'The delegated read was verified.')]
    const step = steps.get(role) ?? 0; steps.set(role, step + 1)
    const rendered = JSON.stringify(request)
    if (step === 0) {
      first.set(role, rendered)
      assert.ok(tools.includes('skill'))
      for (const name of names) assert.ok(rendered.includes(`Routing summary for ${name}.`))
      assert.ok(!rendered.includes('BODY_ONLY_') && !rendered.includes('REFERENCE_ONLY_'))
      if (role === 'owner') assert.ok(tools.includes(nativeShell) && tools.includes('read') && tools.includes('write'))
      else assert.deepEqual(input.skillNames, [names[0]])
      return [call('skill', { name: names[0] })]
    }
    if (step === 1) {
      assert.ok(rendered.includes(`BODY_ONLY_${names[0]}`))
      for (const name of names.slice(1)) assert.ok(!rendered.includes(`BODY_ONLY_${name}`))
      assert.ok(!rendered.includes('REFERENCE_ONLY_'))
      return role === 'owner'
        ? [call('task_delegate', { key: 'read-personal-guide', objective: 'Verify the selected personal reference', skillNames: [names[0]] })]
        : [call('read', { file_path: join(f.skillRoot, names[0], 'references/procedure.md') })]
    }
    if (role === 'owner') return [finish('wait', 'Waiting for the independent execution.')]
    assert.ok(rendered.includes(`REFERENCE_ONLY_${names[0]}`))
    return [call('execution_submit', { output: { status: 'completed', summary: 'Read the actual personal reference.',
      evidence: [`REFERENCE_ONLY_${names[0]}`], limitations: [], artifacts: [] } })]
  })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.deepEqual((await h.service.recover()).failures, [])
  const [task] = await h.query('task.list'), [execution] = await h.query('execution.list')
  assert.equal(task.status, 'completed')
  assert.equal(task.topicRefs.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.notEqual(task.sessionId, execution.sessionId)
  assert.deepEqual(execution.input.skillNames, [names[0]])
  assert.equal(first.size, 2)
  assert.equal(h.toolResults.filter(result => result.name === 'skill' && !result.result.isError).length, 2)
  assert.ok(!(await h.query('operation.list')).some(operation => operation.definition?.toolName === 'skill'), 'Skill loads do not pretend to be external effects')
  for (const sessionId of [task.sessionId, execution.sessionId]) {
    const log = await inspectSession(h.ctx.sessionPersistence, sessionId)
    assert.ok(log.events.some(event => event.type === 'tool/call' && event.data.name === 'skill'))
    assert.ok(log.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'skill-catalog'))
  }
})

test('an unavailable native skill is a correctable read and does not leave unknown external effects', async t => {
  const f = await fixture(t); let step = 0
  const h = await f.host(async request => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (tools.includes('task_delegate')) return !input.executions.length
      ? [call('task_delegate', { key: 'missing-skill', objective: 'Handle a missing guide without a write' }), finish('wait', 'Waiting.')]
      : [finish('complete', 'The missing guide was reported and an available one was read.')]
    if (step++ === 0) return [call('skill', { name: 'no-longer-present' })]
    if (step === 2) return [call('skill', { name: names[1] })]
    assert.ok(JSON.stringify(request).includes(`BODY_ONLY_${names[1]}`))
    return [call('execution_submit', { output: { status: 'completed', summary: 'Read available fallback instructions.', evidence: [], limitations: ['Requested guide is unavailable.'], artifacts: [] } })]
  })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.equal((await h.query('task.list'))[0].status, 'completed')
  assert.ok(h.toolResults.some(result => result.name === 'skill' && result.result.isError))
  assert.deepEqual(await h.query('operation.list'), [])
  assert.deepEqual((await h.service.recover()).failures, [])
})

test('task session permits late native tools and configured read and shell alongside skills', async t => {
  const f = await fixture(t); let ownerStep = 0, effects = 0
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (ownerStep++ === 0) {
      const agent = host.ctx.agents.get(input.task.sessionId)
      agent.ctx.tools.register({ name: 'skill', description: 'Configured native replacement', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { effects++; return {} } })
      return [call('skill', {}), call(nativeShell, { command: nativeShell === 'pwsh' ? "Write-Output 'owner-native-shell'" : "printf 'owner-native-shell'", description: 'Use the configured native shell' }), call('read', { file_path: join(f.skillRoot, names[0], 'SKILL.md') })]
    }
    return [finish('complete', 'Native skills and tools are available.'), call('skill', {})]
  })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.equal(effects, 1)
  assert.equal((await h.query('task.list'))[0].status, 'completed')
  assert.equal(h.toolResults.filter(result => result.result.isError).length, 1, '提交本轮结论后不能继续执行工具')
})

test('unconfigured native profiles expose no bundled personal skills', async t => {
  const f = await fixture(t)
  const h = await f.host(async request => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    assert.ok(!tools.includes('skill'))
    assert.ok(!JSON.stringify(request).includes('Routing summary for personal-'))
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    return [finish('complete', 'No personal skills were configured.')]
  }, { skillDirs: undefined })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.equal((await h.query('task.list'))[0].status, 'completed')
})

test('an execution same-name replacement does not inherit the native loader read-only accounting', async t => {
  const f = await fixture(t); let step = 0, effects = 0
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (tools.includes('task_delegate')) return !input.executions.length
      ? [call('task_delegate', { key: 'shadow-test', objective: 'Verify same-name tool accounting' }), finish('wait', 'Waiting.')]
      : [finish('complete', 'The replacement remained accounted for.')]
    if (step++ === 0) return [call('skill', { name: names[0] })]
    if (step === 2) {
      const [execution] = await host.query('execution.list')
      const agent = host.ctx.agents.get(execution.sessionId)
      agent.ctx.tools.register({ name: 'skill', description: 'Fixture effectful replacement', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'replacement accounted' }] },
        execute() { effects++; return {} } })
      return [call('skill', {})]
    }
    return [call('execution_submit', { output: { status: 'completed', summary: 'Replacement returned.', evidence: [], limitations: [], artifacts: [] } })]
  })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.equal(effects, 1)
  const operations = await h.query('operation.list')
  assert.equal(operations.length, 1)
  assert.equal(operations[0].definition.toolName, 'skill')
  assert.equal(operations[0].state, 'succeeded')
  assert.equal((await h.query('task.list'))[0].status, 'completed')
})
