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
const currentRuntime = request => JSON.stringify(request.messages.findLast(message => message.source?.kind === 'runtime-context') ?? {})

function completionReviews(reference) {
  const read = new Set(); let delegated = false
  const roles = ['独立核对技能引用', '独立核对原始要求']
  return {
    execution(input) {
      const index = roles.indexOf(input.objective)
      if (index < 0) return null
      const path = index === 0 ? reference : input.materialPaths[0]
      assert.ok(path)
      if (!read.has(index)) { read.add(index); return [call('read', { file_path: path })] }
      return [call('execution_submit', { output: { status: 'completed', summary: `${roles[index]}已读取原始材料`, evidence: [path], limitations: [], artifacts: [] } })]
    },
    owner(input, summary) {
      if (!input.executions.every(item => item.status === 'succeeded' && item.drained)) return [finish('wait', '等待原执行与独立核对结果。')]
      if (input.executionCount >= 3) return [finish('complete', summary)]
      if (delegated) return [finish('wait', '等待独立核对结果。')]
      delegated = true
      return [...roles.map((objective, index) => call('task_delegate', { key: `completion-review-${index}`, objective })), finish('wait', '已安排独立核对。')]
    },
  }
}

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
    const host = await nativeTaskHost(root, async (...args) => {
      try { return await decide(...args) }
      catch (error) { t.diagnostic(error.stack); throw error }
    }, { skillDirs: [skillRoot], ...options }); hosts.push(host); return host
  } }
}

test('native personal skills are discovered cheaply, loaded independently by both sessions, and references stay execution-owned', async t => {
  const f = await fixture(t), steps = new Map(), first = new Map()
  const reviewers = completionReviews(join(f.skillRoot, names[0], 'references/procedure.md'))
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) {
      assert.ok(!JSON.stringify(request).includes('BODY_ONLY_'), 'Topic coordination does not acquire personal workflow bodies')
      assert.ok(!tools.includes(nativeShell) && !tools.includes('write'), 'Topic coordination cannot execute business work')
      return topicCalls
    }
    const role = tools.includes('task_delegate') ? 'owner' : 'execution'
    if (role === 'execution') { const review = reviewers.execution(input); if (review) return review }
    if (role === 'owner' && input.executions.length) return reviewers.owner(input, 'The delegated read was verified.')
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
  assert.equal((await h.query('execution.list')).length, 3)
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
  const reviewers = completionReviews(join(f.skillRoot, names[1], 'references/procedure.md'))
  const h = await f.host(async request => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (tools.includes('task_delegate')) return !input.executions.length
      ? [call('task_delegate', { key: 'missing-skill', objective: 'Handle a missing guide without a write' }), finish('wait', 'Waiting.')]
      : reviewers.owner(input, 'The missing guide was reported and an available one was read.')
    const review = reviewers.execution(input); if (review) return review
    if (step++ === 0) return [call('skill', { name: 'no-longer-present' })]
    if (step === 2) return [call('skill', { name: names[1] })]
    assert.ok(JSON.stringify(request).includes(`BODY_ONLY_${names[1]}`))
    return [call('execution_submit', { output: { status: 'completed', summary: 'Read available fallback instructions.', evidence: [], limitations: ['Requested guide is unavailable.'], artifacts: [] } })]
  })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.equal((await h.query('task.list'))[0].status, 'completed')
  assert.equal((await h.query('execution.list')).length, 3)
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
  const reviewers = completionReviews(join(f.skillRoot, names[0], 'references/procedure.md'))
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (tools.includes('task_delegate')) return !input.executions.length
      ? [call('task_delegate', { key: 'shadow-test', objective: 'Verify same-name tool accounting' }), finish('wait', 'Waiting.')]
      : reviewers.owner(input, 'The replacement remained accounted for.')
    const review = reviewers.execution(input); if (review) return review
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
  assert.equal((await h.query('execution.list')).length, 3)
})

test('已读技能和引用变化只提示相关路径，原生重读后消除提示且保留旧版本审计', async t => {
  const f = await fixture(t), reference = join(f.skillRoot, names[0], 'references/procedure.md')
  let step = 0
  const h = await f.host(async request => {
    const rendered = JSON.stringify(request)
    switch (step++) {
      case 0: return [call('skill', { name: names[0] })]
      case 1: return [call('read', { file_path: reference })]
      case 2:
        await writeFile(reference, 'UPDATED_REFERENCE')
        await writeFile(join(f.skillRoot, names[1], 'SKILL.md'), `---\nname: ${names[1]}\ndescription: Routing summary.\n---\nUNRELATED_BODY\n`)
        return [call('write', { file_path: join(f.skillRoot, names[0], 'SKILL.md'), content: `---\nname: ${names[0]}\ndescription: Routing summary.\n---\nUPDATED_BODY\n` })]
      case 3:
        assert.ok(rendered.includes('本会话已读技能或引用有变化'))
        assert.ok(rendered.includes(reference.replaceAll('\\', '\\\\')))
        assert.ok(!rendered.includes('UPDATED_REFERENCE') && !rendered.includes('UNRELATED_BODY'), '变化提示不自动注入引用或无关正文')
        return [call('skill', { name: names[0] }), call('read', { file_path: reference })]
      default:
        assert.ok(rendered.includes('UPDATED_BODY') && rendered.includes('UPDATED_REFERENCE'))
        assert.ok(!currentRuntime(request).includes('本会话已读技能或引用有变化'), '重新读取后最新上下文清除提醒；历史提示仍保留')
        return [finish('complete', '已核对最新相关规则')]
    }
  })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'skill-freshness', objective: '只读核对规则更新' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify(await h.query('task.get', { taskId: task.taskId })))
  const log = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  assert.equal(log.events.filter(e => e.data.source?.kind === 'dingtalk-skill-read').length, 4)
  assert.ok(log.events.some(e => e.type === 'tool/result' && JSON.stringify(e.data).includes(`BODY_ONLY_${names[0]}`)), '旧实际工具结果保留')
})

test('执行会话续办恢复已读版本，入口未变而引用改变也能在首次模型步骤看到', async t => {
  const f = await fixture(t), reference = join(f.skillRoot, names[0], 'references/procedure.md')
  const reviewers = completionReviews(reference), steps = new Map()
  const h = await f.host(async request => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const execution = input.executions[0]
      if (!execution) return [call('task_delegate', { key: 'phase-one', objective: '调查阶段读取规则', skillNames: [names[0]] }), finish('wait', '等待调查结果')]
      if (!execution.drained) return [finish('wait', '等待排空')]
      if (execution.inputVersion === 1) {
        await writeFile(reference, 'RESUMED_REFERENCE_VERSION')
        return [call('task_delegate', { key: 'phase-two', executionId: execution.executionId, objective: '实施阶段核对新规则', skillNames: [names[0]] }), finish('wait', '等待续办')]
      }
      return reviewers.owner(input, '已核对续办接收新引用')
    }
    const review = reviewers.execution(input); if (review) return review
    const phase = input.objective, step = steps.get(phase) ?? 0; steps.set(phase, step + 1)
    if (phase === '调查阶段读取规则') {
      if (step === 0) return [call('skill', { name: names[0] })]
      if (step === 1) return [call('read', { file_path: reference })]
    } else {
      if (step === 0) {
        assert.ok(JSON.stringify(request).includes('本会话已读技能或引用有变化'))
        assert.ok(!JSON.stringify(request).includes('RESUMED_REFERENCE_VERSION'), '续办只提示相关引用，仍需实际读取')
        return [call('read', { file_path: reference })]
      }
      assert.ok(JSON.stringify(request).includes('RESUMED_REFERENCE_VERSION'))
      assert.ok(!currentRuntime(request).includes('本会话已读技能或引用有变化'))
    }
    return [call('execution_submit', { output: { status: 'completed', summary: '已读取本阶段相关规则', evidence: [reference], limitations: [], artifacts: [] } })]
  })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'skill-resume', objective: '分两阶段核对规则更新' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify(await h.query('task.get', { taskId: task.taskId })))
  const [execution] = await h.query('execution.list', { taskId: task.taskId })
  assert.equal(execution.inputVersion, 2)
  const log = await inspectSession(h.ctx.sessionPersistence, execution.sessionId)
  assert.equal(log.events.filter(e => e.data.source?.kind === 'dingtalk-skill-read' && e.data.source.record.kind === 'reference').length, 2)
  assert.deepEqual(await h.query('operation.list'), [], '技能检查不制造外部效果')
})
