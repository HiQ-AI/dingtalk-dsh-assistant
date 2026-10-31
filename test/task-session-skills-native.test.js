import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeShell, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

const test = (name, run, options = {}) => testRunner(name, { timeout: 30000, ...options, ...(!available ? { skip: reason } : {}) }, run)
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

test('native personal skills are discovered cheaply, loaded independently by both sessions, and references stay execution-owned', nativeLifecycle(30000, async (t) => {
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
      if (role === 'owner') assert.ok(!tools.includes(nativeShell) && tools.includes('read') && !tools.includes('write'))
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
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  assert.deepEqual((await t.step(async () => h.service.recover())).failures, [])
  const [task] = await t.step(async () => h.query('task.list')), [execution] = await t.step(async () => h.query('execution.list'))
  assert.equal(task.status, 'completed')
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  assert.equal(task.topicRefs.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.notEqual(task.sessionId, execution.sessionId)
  assert.deepEqual(execution.input.skillNames, [names[0]])
  assert.equal(first.size, 2)
  assert.equal(h.toolResults.filter(result => result.name === 'skill' && !result.result.isError).length, 2)
  assert.ok(!(await t.step(async () => h.query('operation.list'))).some(operation => operation.definition?.toolName === 'skill'), 'Skill loads do not pretend to be external effects')
  for (const sessionId of [task.sessionId, execution.sessionId]) {
    const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, sessionId))
    assert.ok(log.events.some(event => event.type === 'tool/call' && event.data.name === 'skill'))
    assert.ok(log.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'skill-catalog'))
  }
}), { timeout: nativeLifecycleTimeout(30000) })

test('an unavailable native skill is a correctable read and does not leave unknown external effects', nativeLifecycle(30000, async (t) => {
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
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed')
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  assert.ok(h.toolResults.some(result => result.name === 'skill' && result.result.isError))
  assert.deepEqual(await t.step(async () => h.query('operation.list')), [])
  assert.deepEqual((await t.step(async () => h.service.recover())).failures, [])
}), { timeout: nativeLifecycleTimeout(30000) })

test('task session rejects business tools and late replacements while keeping the original evidence reader', nativeLifecycle(30000, async (t) => {
  const f = await fixture(t); let ownerStep = 0, effects = 0
  const h = await f.host(async (request, host) => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (ownerStep++ === 0) {
      for (const name of [nativeShell, 'write', 'edit', 'glob', 'grep']) assert.ok(!tools.includes(name), `${name} must not be advertised to the owner`)
      const agent = host.ctx.agents.get(input.task.sessionId)
      const effect = name => ({ name, description: 'Untrusted late capability', effectClass: 'read', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { effects++; return {} } })
      host.ctx.tools.register(effect('late_global_business'))
      agent.ctx.tools.register(effect('late_scoped_business'))
      agent.ctx.tools.register(effect('skill'))
      return [call('skill', {}), call('late_global_business', {}), call('late_scoped_business', {}),
        call('write', { file_path: join(f.root, 'forbidden.txt'), content: 'must not write' }),
        call(nativeShell, { command: nativeShell === 'pwsh' ? "Write-Output 'forbidden-shell'" : "printf 'forbidden-shell'", description: 'Must not execute' }),
        call('read', { file_path: join(f.skillRoot, names[0], 'SKILL.md') })]
    }
    assert.ok(!tools.includes('late_global_business'))
    return [finish('complete', '已读取证据，业务操作均被拒绝。'), call('skill', {})]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  assert.equal(effects, 0)
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed')
  assert.ok(h.toolResults.some(result => result.name === 'read' && !result.result.isError))
  for (const name of ['skill', 'late_global_business', 'late_scoped_business', 'write', nativeShell])
    assert.ok(h.toolResults.some(result => result.name === name && result.result.isError), `${name} was denied`)
  assert.equal(h.toolResults.filter(result => result.name === 'skill' && result.result.isError).length, 2, '提交后仍拒绝被替换的工具')
}), { timeout: nativeLifecycleTimeout(30000) })

test('unconfigured native profiles expose no bundled personal skills', nativeLifecycle(30000, async (t) => {
  const f = await fixture(t)
  const h = await f.host(async request => {
    const input = latestInput(request), tools = request.tools.map(tool => tool.name)
    assert.ok(!tools.includes('skill'))
    assert.ok(!JSON.stringify(request).includes('Routing summary for personal-'))
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    return [finish('complete', 'No personal skills were configured.')]
  }, { skillDirs: undefined })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed')
}), { timeout: nativeLifecycleTimeout(30000) })

test('an execution same-name replacement does not inherit the native loader read-only accounting', nativeLifecycle(30000, async (t) => {
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
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  assert.equal(effects, 1)
  const operations = await t.step(async () => h.query('operation.list'))
  assert.equal(operations.length, 1)
  assert.equal(operations[0].definition.toolName, 'skill')
  assert.equal(operations[0].state, 'succeeded')
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed')
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
}), { timeout: nativeLifecycleTimeout(30000) })

test('已读技能和引用变化只提示相关路径，原生重读后消除提示且保留旧版本审计', nativeLifecycle(30000, async (t) => {
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
        // 模拟管理员在外部更新技能；统筹自身没有写权限。
        await writeFile(join(f.skillRoot, names[0], 'SKILL.md'), `---\nname: ${names[0]}\ndescription: Routing summary.\n---\nUPDATED_BODY\n`)
        return [call('task_decisions_read', {})]
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
  await t.beginBusiness()

  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'skill-freshness', objective: '只读核对规则更新' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify(await t.step(async () => h.query('task.get', { taskId: task.taskId }))))
  const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))
  assert.equal(log.events.filter(e => e.data.source?.kind === 'dingtalk-skill-read').length, 4)
  assert.ok(log.events.some(e => e.type === 'tool/result' && JSON.stringify(e.data).includes(`BODY_ONLY_${names[0]}`)), '旧实际工具结果保留')
}), { timeout: nativeLifecycleTimeout(30000) })

test('执行会话续办恢复已读版本，入口未变而引用改变也能在首次模型步骤看到', nativeLifecycle(30000, async (t) => {
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
  await t.beginBusiness()

  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'skill-resume', objective: '分两阶段核对规则更新' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify(await t.step(async () => h.query('task.get', { taskId: task.taskId }))))
  const [execution] = await t.step(async () => h.query('execution.list', { taskId: task.taskId }))
  assert.equal(execution.inputVersion, 2)
  const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, execution.sessionId))
  assert.equal(log.events.filter(e => e.data.source?.kind === 'dingtalk-skill-read' && e.data.source.record.kind === 'reference').length, 2)
  assert.deepEqual(await t.step(async () => h.query('operation.list')), [], '技能检查不制造外部效果')
}), { timeout: nativeLifecycleTimeout(30000) })
