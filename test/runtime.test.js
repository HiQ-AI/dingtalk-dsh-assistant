import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { openResidentRuntime, residentSessionId } from '../packages/dingtalk-dsh-assistant/runtime.js'
import { taskSessionId } from '../packages/dingtalk-dsh-assistant/store.js'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

const agentWorkspace = mkdtempSync(join(tmpdir(), 'dsh-agent-workspace-'))
const replacementWorkspace = mkdtempSync(join(tmpdir(), 'dsh-replacement-workspace-'))
const runtimeOptions = (options = {}) => ({ inboxDeliveryDelayMs: 0, ...options })
after(() => {
  rmSync(agentWorkspace, { recursive: true, force: true })
  rmSync(replacementWorkspace, { recursive: true, force: true })
})

test('Inbox 每条消息零延迟 steer，主会话向叶子会话同样使用插话', () => {
  const source = readFileSync(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /inboxDeliveryDelayMs|setTimeout\(resolve, inboxDeliveryDelayMs\)/)
  assert.match(source, /handle\.agent\.steer\(createUserMessage\(\{ content, source: \{ kind: 'user' \} \}\)\)/)
  assert.match(source, /async function followupTaskInternal[\s\S]*?handle\.agent\.steer\(createUserMessage/)
  assert.match(source, /name: 'group_decision_submit'/)
  assert.doesNotMatch(source, /GROUP_DECISION_SCHEMA_CORRECTION|GROUP_DECISION_FINALIZE|parseGroupDecision\(/)
  assert.match(source, /收到 TASK_OBJECTIVE_REVISED 后，必须根据修订后的完整目标重新提交 plan-confirmed/)
  assert.match(source, /顶层不允许 kind 字段/)
  assert.match(source, /忽略为 [^\r\n]*\{\"actions\":\[\],\"reason\":\"原因\"\}/)
  assert.match(source, /const submitted = await pending\.promise/)
  assert.match(source, /agentCtx\.tools\.restrict\(\{ deny: \['get_goal', 'create_goal', 'update_goal'\] \}\)/)
  assert.match(source, /name: 'tool:goal', order: 114, text: ''/)
})

function decisionRuntimeFixture({ groupId = 'steer-group', taskCapacity = false } = {}) {
  const group = { groupId: 'steer-group', residentSessionId: 'session-steer', residentAgentPreset: 'standard', nextSequence: 1, messages: [], outbox: [] }
  group.groupId = groupId
  const steered = [], followups = [], registeredTools = [], tasks = []
  let releaseIdle, resolveSteerCount
  let targetSteerCount = 0
  const idle = new Promise((resolve) => { releaseIdle = resolve })
  const waitForSteers = (count) => {
    targetSteerCount = count
    if (steered.length >= count) return Promise.resolve()
    return new Promise((resolve) => { resolveSteerCount = resolve })
  }
  const session = { id: 'session-steer', seq: 0, events: [] }
  const agent = {
    session, status: 'running',
    steer(message) {
      const text = message.content[0].text
      if (text.startsWith('[GROUP_MESSAGE_STEER]')) {
        steered.push(message)
        if (steered.length >= targetSteerCount) resolveSteerCount?.()
        return
      }
      throw new Error('仅群消息允许通过 steer 插入')
    },
    followup(message) { followups.push(message) },
    async whenIdle() { await idle },
  }
  const handle = { agent, dispose: async () => undefined }
  const agentCtx = { on: () => () => undefined, tools: { register: (tool) => registeredTools.push(tool), restrict: () => undefined }, systemPrompt: { section: () => undefined } }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: { async resume(options) { await options.setup(agentCtx); return handle } },
    subagents: { drainContinuableDescendants: async () => undefined },
    agentPresets: { mount: async (_ctx, id) => ({ id }), serviceFor: () => ({ set: () => undefined }) },
  }
  const store = {
    getGroup: (groupId) => groupId === group.groupId ? group : undefined,
    listGroups: () => [group], listTasks: () => tasks, getTask: (taskId) => tasks.find((task) => task.taskId === taskId),
    async ingest(message) {
      const duplicate = group.messages.find((item) => item.messageId === message.messageId)
      if (duplicate) return { duplicate: true, sequence: duplicate.sequence, group }
      const accepted = { ...message, sequence: group.nextSequence++, agentDeliveryStatus: 'pending' }
      group.messages.push(accepted)
      return { duplicate: false, sequence: accepted.sequence, group }
    },
    async markMessageAgentDelivery({ messageId, status, error }) { Object.assign(group.messages.find((item) => item.messageId === messageId), { agentDeliveryStatus: status, ...(error === undefined ? {} : { error }) }); return group },
    async appendOutbox(value) { group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, ...value, status: 'pending' }); return group },
    async createTask(value) { const task = { ...value, taskId: `task-${tasks.length + 1}`, childSessionId: `session-task-${tasks.length + 1}`, state: 'queued' }; tasks.push(task); return { created: true, task } },
    close: async () => undefined,
  }
  return { group, steered, followups, registeredTools, tasks, releaseIdle, waitForSteers, ctx, store, handle, taskCapacity }
}

const decisionRequestId = (message) => message.content[0].text.match(/^判断请求 ID：([^\r\n]+)$/mu)?.[1]

function twoGroupDecisionFixture() {
  const groups = new Map(['group-a', 'group-b'].map((groupId) => [groupId, { groupId, residentSessionId: `session-${groupId}`, residentAgentPreset: 'standard', nextSequence: 1, messages: [], outbox: [] }]))
  const handles = new Map(), registeredTools = new Map(), steered = new Map()
  const neverIdle = new Promise(() => undefined)
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: { async resume(options) {
      const group = [...groups.values()].find((item) => item.residentSessionId === options.resumeSessionId)
      const messages = [], tools = []
      const agent = { session: { id: group.residentSessionId, seq: 0, events: [] }, status: 'running', steer: (message) => messages.push(message), async whenIdle() { await neverIdle } }
      const handle = { agent, dispose: async () => undefined }
      await options.setup({ on: () => () => undefined, tools: { register: (tool) => tools.push(tool), restrict: () => undefined }, systemPrompt: { section: () => undefined } })
      handles.set(group.groupId, handle); registeredTools.set(group.groupId, tools); steered.set(group.groupId, messages)
      return handle
    } },
    subagents: { drainContinuableDescendants: async () => undefined },
    agentPresets: { mount: async (_ctx, id) => ({ id }), serviceFor: () => ({ set: () => undefined }) },
  }
  const store = {
    getGroup: (groupId) => groups.get(groupId), listGroups: () => [...groups.values()], listTasks: () => [], getTask: () => undefined,
    async ingest(message) { const group = groups.get(message.groupId); const accepted = { ...message, sequence: group.nextSequence++, agentDeliveryStatus: 'pending' }; group.messages.push(accepted); return { duplicate: false, sequence: accepted.sequence, group } },
    async markMessageAgentDelivery({ groupId, messageId, status, error }) { Object.assign(groups.get(groupId).messages.find((item) => item.messageId === messageId), { agentDeliveryStatus: status, ...(error === undefined ? {} : { error }) }); return groups.get(groupId) },
    async appendOutbox(value) { const group = groups.get(value.groupId); group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, ...value, status: 'pending' }); return group },
    close: async () => undefined,
  }
  const waitForSteers = async () => { while ([...steered.values()].reduce((total, items) => total + items.length, 0) < 2) await new Promise((resolve) => setImmediate(resolve)) }
  return { groups, handles, registeredTools, steered, waitForSteers, ctx, store }
}

test('同一turn的多条消息按step工具提交独立Decision且不等待turn结束', async () => {
  const fixture = decisionRuntimeFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '第一条', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '第二条', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submitted = await tool.execute({ submissions: [
    { requestIds: [requestIds[0]], decision: { actions: [], reply: '第一项结果' } },
    { requestIds: [requestIds[1]], decision: { actions: [], reason: '第二项独立忽略' } },
  ] }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted.acceptedRequestIds, requestIds)
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '第一项结果')
  assert.equal(secondResult.decision.reason, '第二项独立忽略')
  assert.equal(fixture.followups.length, 0, '普通群判断不再排队 coordinator followup')
  assert.equal(fixture.handle.agent.session.events.length, 0, 'Decision 在工具执行时结算，不依赖 turn/end 日志')
  assert.deepEqual(fixture.group.messages.map((item) => item.agentDeliveryStatus), ['delivered', 'delivered'])
  fixture.releaseIdle()
  await runtime.close()
})

test('模型可合并相关请求且Runtime只提交一次副作用并保留全部来源', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'combined-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '任务主体', occurredAt: '2026-08-28T01:00:00Z', senderName: '甲' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '补充范围', occurredAt: '2026-08-28T01:00:01Z', senderName: '乙' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds, decision: { actions: [{ kind: 'new-task', title: '合并处理', objective: '处理主体与补充范围', acceptanceCriteria: ['范围均已核验'] }], reply: '已开始处理。' } }] }, { agent: fixture.handle.agent })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(fixture.tasks.length, 1, '共享Decision的业务副作用只能由最早请求执行一次')
  assert.equal(fixture.group.outbox.length, 1)
  assert.match(fixture.tasks[0].relatedContexts[0], /消息ID：m1[\s\S]*原始消息：\s*任务主体/u)
  assert.match(fixture.tasks[0].relatedContexts[0], /消息ID：m2[\s\S]*原始消息：\s*补充范围/u)
  assert.equal(firstResult.decisionOwnerRequestId, undefined)
  assert.equal(secondResult.decisionOwnerRequestId, requestIds[0])
  fixture.releaseIdle()
  await runtime.close()
})

test('后完成的独立Decision不会被前一条pending请求串行阻塞', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'out-of-order-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '仍在分析的事项', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '已经判断完成的独立事项', occurredAt: '2026-08-28T01:00:01Z' })
  let firstSettled = false
  first.then(() => { firstSettled = true }, () => { firstSettled = true })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: [requestIds[1]], decision: { actions: [], reply: '第二项先完成' } }] }, { agent: fixture.handle.agent })
  const secondResult = await second
  assert.equal(secondResult.decision.reply, '第二项先完成')
  assert.equal(firstSettled, false, '未提交的第一项不能阻塞已提交的独立第二项')
  await tool.execute({ submissions: [{ requestIds: [requestIds[0]], decision: { actions: [], reason: '第一项随后完成' } }] }, { agent: fixture.handle.agent })
  const firstResult = await first
  assert.equal(firstResult.decision.reason, '第一项随后完成')
  fixture.releaseIdle()
  await runtime.close()
})

test('Decision工具对重复未知和非法结构执行全量预检且不部分提交', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'atomic-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '原子校验一', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '原子校验二', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await assert.rejects(tool.execute({ submissions: [{ requestIds: [requestIds[0], requestIds[0]], decision: { actions: [], reason: '重复' } }] }, { agent: fixture.handle.agent }), /group_decision_request_duplicate/)
  await assert.rejects(tool.execute({ submissions: [
    { requestIds: [requestIds[0]], decision: { actions: [], reply: '不应部分提交' } },
    { requestIds: ['unknown-request'], decision: { actions: [], reason: '未知' } },
  ] }, { agent: fixture.handle.agent }), /group_decision_request_unknown/)
  await assert.rejects(tool.execute({ submissions: [
    { requestIds: [requestIds[0]], decision: { actions: [], reply: '仍不应部分提交' } },
    { requestIds: [requestIds[1]], decision: { actions: [], reason: '' } },
  ] }, { agent: fixture.handle.agent }), /group_decision_invalid_schema/)
  assert.deepEqual(fixture.group.messages.map((message) => message.agentDeliveryStatus), ['steered', 'steered'])
  await tool.execute({ submissions: [
    { requestIds: [requestIds[0]], decision: { actions: [], reply: '合法一' } },
    { requestIds: [requestIds[1]], decision: { actions: [], reason: '合法二' } },
  ] }, { agent: fixture.handle.agent })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '合法一')
  assert.equal(secondResult.decision.reason, '合法二')
  fixture.releaseIdle()
  await runtime.close()
})

test('Decision请求ID不能跨群提交且失败不会消耗任一群pending', async () => {
  const fixture = twoGroupDecisionFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: 'group-a', messageId: 'm-a', text: '群A事项', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: 'group-b', messageId: 'm-b', text: '群B事项', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers()
  const requestA = decisionRequestId(fixture.steered.get('group-a')[0])
  const requestB = decisionRequestId(fixture.steered.get('group-b')[0])
  const toolA = fixture.registeredTools.get('group-a').find((item) => item.name === 'group_decision_submit')
  const toolB = fixture.registeredTools.get('group-b').find((item) => item.name === 'group_decision_submit')
  await assert.rejects(toolA.execute({ submissions: [{ requestIds: [requestA, requestB], decision: { actions: [], reason: '不得跨群合并' } }] }, { agent: fixture.handles.get('group-a').agent }), /group_decision_request_wrong_group/)
  assert.equal(fixture.groups.get('group-a').messages[0].agentDeliveryStatus, 'steered')
  assert.equal(fixture.groups.get('group-b').messages[0].agentDeliveryStatus, 'steered')
  await toolA.execute({ submissions: [{ requestIds: [requestA], decision: { actions: [], reply: '群A完成' } }] }, { agent: fixture.handles.get('group-a').agent })
  await toolB.execute({ submissions: [{ requestIds: [requestB], decision: { actions: [], reason: '群B完成' } }] }, { agent: fixture.handles.get('group-b').agent })
  const [resultA, resultB] = await Promise.all([first, second])
  assert.equal(resultA.decision.reply, '群A完成')
  assert.equal(resultB.decision.reason, '群B完成')
  await runtime.close()
})

test('普通assistant文本和turn结束不能冒充Decision，停稳未提交会明确失败', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'missing-submit-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '不要解析最终文本', occurredAt: '2026-08-28T01:00:00Z' })
  await fixture.waitForSteers(1)
  fixture.handle.agent.session.events.push(
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"actions":[],"reply":"伪Decision"}' }] } } },
    { seq: 2, type: 'turn/end', data: { status: 'success', reason: { kind: 'completed' } } },
  )
  fixture.releaseIdle()
  await assert.rejects(ingest, /group_decision_not_submitted:missing-submit-group:m1/)
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'decision-failed')
  assert.match(fixture.group.messages[0].error, /group_decision_not_submitted/)
  assert.equal(fixture.group.outbox.length, 0)
  await runtime.close()
})

test('关联复核也使用独立Decision请求且不回退读取assistant文本', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'recheck-group' })
  fixture.tasks.push({ taskId: 'task-existing', groupId: fixture.group.groupId, state: 'completed' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'image-message', text: '[图片消息]', occurredAt: '2026-08-28T01:00:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '图片补充说明', occurredAt: '2026-08-28T01:01:00Z' })
  await fixture.waitForSteers(1)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: [decisionRequestId(fixture.steered[0])], decision: { actions: [], reason: '初次忽略' } }] }, { agent: fixture.handle.agent })
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  assert.match(fixture.followups[0].content[0].text, /^\[GROUP_DECISION_RECHECK\]/u)
  const recheckRequestId = decisionRequestId(fixture.followups[0])
  await tool.execute({ submissions: [{ requestIds: [recheckRequestId], decision: { actions: [], reason: '复核后仍无关' } }] }, { agent: fixture.handle.agent })
  const result = await ingest
  assert.equal(result.decision.reason, '复核后仍无关')
  assert.equal(fixture.group.messages.find((message) => message.messageId === 'm1').agentDeliveryStatus, 'delivered')
  fixture.releaseIdle()
  await runtime.close()
})

test('消息插话后的判断失败不会把同一消息再次 steer', async () => {
  const source = readFileSync(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /status: 'steered'/)
  assert.match(source, /status: 'decision-failed'/)
  assert.match(source, /\['steered', 'delivered', 'decision-failed', 'skipped'\]\.includes\(persisted\?\.agentDeliveryStatus\)/)
})

test('已有群切换预设时沿用原 Session，新群先创建 dsh Session 再持久绑定', async () => {
  const groups = new Map([['existing', { groupId: 'existing', residentSessionId: 'session-existing', residentAgentPreset: 'standard' }]])
  const calls = []
  const setupReturns = []
  const permissionSets = []
  const promptSections = []
  const registeredTools = []
  const toolRestrictions = []
  const tasks = []
  const handle = (sessionId) => ({ agent: { session: { id: sessionId, meta: { agentPreset: 'standard-convergent' } } }, dispose: async () => undefined })
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: {
      async resume(options) { calls.push(['resume', options.resumeSessionId]); return handle(options.resumeSessionId) },
      async create(options) { calls.push(['create', options.sessionId, options.meta.cwd, options.meta.agentPreset]); setupReturns.push(await options.setup({ on: () => () => undefined, tools: { register: (tool) => registeredTools.push(tool), restrict: (filter) => toolRestrictions.push(filter) }, systemPrompt: { section: (value) => promptSections.push(value) } })); return handle(options.sessionId) },
    },
    subagents: {
      drainContinuableDescendants: async () => undefined,
    },
    agentPresets: {
      mount: async (_ctx, id) => ({ id }), composeFrom: () => 'standard',
      serviceFor: () => ({ set: (session, preset) => permissionSets.push([session.id, preset]) }),
    },
  }
  const store = {
    getGroup: (id) => groups.get(id),
    listGroups: () => [...groups.values()],
    listTasks: () => tasks,
    getTask: (id) => tasks.find((task) => task.taskId === id),
    async createTask(value) {
      const duplicate = tasks.find((task) => task.groupId === value.groupId && task.sourceMessageId === value.sourceMessageId)
      if (duplicate) return { created: false, task: duplicate }
      const taskId = `task-${tasks.length + 1}`
      const task = { ...value, taskId, childSessionId: taskSessionId(taskId), state: 'queued' }
      tasks.push(task)
      return { created: true, task }
    },
    ingest: async () => undefined,
    acknowledge: async () => undefined,
    async subscribe(value) { const group = { ...value, nextSequence: 1, messages: [], outbox: [] }; groups.set(value.groupId, group); return { created: true, group } },
    async updateGroup(value) { const group = { ...groups.get(value.groupId), ...value }; groups.set(value.groupId, group); return group },
    close: async () => undefined,
  }

  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions({ agentPreset: 'standard-convergent', maxConcurrentTasks: 0 }))
  const created = await runtime.subscribe({ groupId: 'new-group', name: '新群名称' })
  assert.deepEqual(calls[0], ['resume', 'session-existing'])
  assert.deepEqual(calls[1].slice(0, 2), ['create', created.group.residentSessionId])
  assert.equal(groups.get('existing').residentSessionId, 'session-existing')
  assert.equal(groups.get('existing').residentAgentPreset, 'standard-convergent')
  assert.deepEqual(permissionSets, [['session-existing', 'danger-full-access'], [created.group.residentSessionId, 'danger-full-access']])
  assert.equal(calls[1][2], agentWorkspace)
  assert.equal(calls[1][3], 'standard-convergent')
  assert.deepEqual(setupReturns, [undefined], 'Agent setup不能意外返回非事务对象')
  assert.equal(created.group.residentSessionId, residentSessionId('new-group'))
  const responsibility = promptSections.find((section) => section.name === 'dingtalk-group-responsibility')
  assert.match(responsibility.text(), /群名称：新群名称/)
  assert.match(responsibility.text(), /群 ID：new-group/)
  assert.match(responsibility.text(), /未设置职责/)
  assert.deepEqual(toolRestrictions, [{ deny: ['get_goal', 'create_goal', 'update_goal'] }])
  assert.deepEqual(promptSections.find((section) => section.name === 'tool:goal'), { name: 'tool:goal', order: 114, text: '' })
  assert.deepEqual(registeredTools.map((tool) => tool.name), ['group_decision_submit', 'group_task_create', 'group_task_context_append', 'group_task_reopen', 'group_task_list'])
  for (const tool of registeredTools) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  }
  const taskTool = registeredTools.find((tool) => tool.name === 'group_task_create')
  const toolResult = await taskTool.execute({ objective: '从 Web 主会话创建任务' }, { agent: { session: { id: created.group.residentSessionId } } })
  assert.deepEqual(toolResult, { created: true, taskId: 'task-1', state: 'queued', childSessionId: 'session-task-1' })
  const duplicate = await taskTool.execute({ objective: '从 Web 主会话创建任务' }, { agent: { session: { id: created.group.residentSessionId } } })
  assert.equal(duplicate.created, false)
  await assert.rejects(taskTool.execute({ objective: '越权' }, { agent: { session: { id: 'another-session' } } }), /resident_tool_wrong_session/)
  await runtime.close()
})

test('Agent工作区统一写入各群Session cwd，变更时保留历史并重建resident', async () => {
  const groups = new Map()
  const creates = [], disposed = []
  const makeHandle = (sessionId, events = []) => ({ agent: { session: { id: sessionId, events }, whenIdle: async () => undefined }, dispose: async () => { disposed.push(sessionId) } })
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: { async create(options) { creates.push(options); const events = options.seed ? [...options.seed] : [{ seq: 0, type: 'turn/start', data: {} }, { seq: 1, type: 'turn/end', data: { status: 'success' } }]; return makeHandle(options.sessionId, events) } },
    subagents: { drainContinuableDescendants: async () => undefined },
    agentPresets: { serviceFor: () => ({ set: () => undefined }) },
  }
  const store = {
    getGroup: (id) => groups.get(id), listGroups: () => [...groups.values()], listTasks: () => [],
    getAgentWorkspaceDir: () => store.workspaceDir,
    async setAgentWorkspaceDir(value) { store.workspaceDir = value; return { workspaceDir: value } },
    async subscribe(value) { const group = { ...value, nextSequence: 1, messages: [], outbox: [] }; groups.set(value.groupId, group); return { created: true, group } },
    async updateGroup(value) { const group = { ...groups.get(value.groupId), ...value }; groups.set(value.groupId, group); return group },
    close: async () => undefined,
  }
  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions())
  await runtime.subscribe({ groupId: 'workspace-group' })
  creates.length = 0
  await runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  assert.equal(store.workspaceDir, replacementWorkspace)
  assert.equal(creates[0].meta.cwd, replacementWorkspace)
  assert.equal(creates[0].seed.length, 2)
  assert.notEqual(groups.get('workspace-group').residentSessionId, residentSessionId('workspace-group'))
  await runtime.close()
})

test('Agent默认模型与推理深度通过dsh原生默认模型服务保存', async () => {
  const saved = []
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'openai-codex', model: 'gpt-old', reasoningEffort: 'medium' }),
      async saveSelection(value) { saved.push(value) },
    },
    agents: {}, subagents: { drainContinuableDescendants: async () => undefined },
  }
  const store = { listGroups: () => [], listTasks: () => [], getProxyUrl: () => '', setProxyUrl: async () => undefined, close: async () => undefined }
  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions())
  const updated = await runtime.updateAgentConfig({ model: 'gpt-5.6-sol', reasoningEffort: 'low' })
  assert.deepEqual(saved, [{ provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' }])
  assert.equal(updated.model, 'gpt-5.6-sol')
  assert.equal(updated.reasoningEffort, 'low')
  assert.deepEqual(runtime.getAgentConfig(), { agentNames: [], workspaceDir: agentWorkspace, provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low', proxyUrl: '', taskExecutionGuidance: '', taskEvidenceGuidance: '', maxConcurrentTasks: 5 })
  await runtime.close()
})

test('单个 resident Session 恢复超时被隔离且不阻塞其他群启动', async () => {
  const groups = [
    { groupId: 'bad-group', residentSessionId: 'session-bad' },
    { groupId: 'good-group', residentSessionId: 'session-good' },
  ]
  const handle = { agent: { session: {} }, dispose: async () => undefined }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: { async resume({ resumeSessionId, signal }) { if (resumeSessionId !== 'session-bad') return handle; return new Promise((_, reject) => { const keepAlive = setTimeout(() => reject(new Error('native signal did not abort')), 50); signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason) }, { once: true }) }) } },
    subagents: { drainContinuableDescendants: async () => undefined },
  }
  const store = {
    listGroups: () => groups, listTasks: () => [], getGroup: () => undefined,
    close: async () => undefined,
  }
  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions({ resumeTimeoutMs: 10 }))
  const issues = runtime.listRecoveryIssues()
  assert.equal(issues[0].groupId, 'bad-group')
  assert.equal(issues[0].residentSessionId, 'session-bad')
  assert.match(issues[0].error, /timeout/i)
  await runtime.close()
})

test('Task 使用确定性独立 Agent 与原生 Goal，两个名额满后 FIFO 排队', async () => {
  const groups = new Map([['group-a', { groupId: 'group-a', responsibility: 'coordinate', residentSessionId: 'session-parent', residentAgentPreset: 'standard-convergent', outbox: [] }]])
  const tasks = []
  const creates = [], createMetas = [], followups = [], steers = [], approvalResumeOrder = [], disposed = [], activities = [], alerts = [], goals = new Map(), agents = new Map(), leafTools = [], leafPromptSections = []
  let blockCheckpointReview = false, checkpointReviewPending = false, releaseCheckpointReview, markCheckpointReviewStarted
  let blockCompletionReview = false, completionReviewPending = false, releaseCompletionReview, markCompletionReviewStarted
  let sessionObserver
  const makeHandle = (sessionId) => {
    const session = { id: sessionId, events: [], seq: 0, meta: {}, append(type, data) { const event = { seq: session.seq++, type, data }; session.events.push(event); return event } }
    const recordMessage = (message) => {
      const text = message.content[0]?.text ?? ''
      if (text.startsWith('[HUMAN_INTERVENTION_REPLY]')) approvalResumeOrder.push('批复入队')
      if (sessionId === 'session-parent' && text.startsWith('[TASK_COMPLETION_REVIEW]')) {
        completionReviewPending = blockCompletionReview
        markCompletionReviewStarted?.()
        const accepted = !text.includes('旧结论')
        session.events.push({ seq: session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ accepted, reason: accepted ? '当前目标均有证据覆盖' : '新增点击跳转目标没有实现和验证证据' }) }] } } })
      }
      if (sessionId === 'session-parent' && text.startsWith('[TASK_CHECKPOINT_REVIEW]')) {
        checkpointReviewPending = blockCheckpointReview
        markCheckpointReviewStarted?.()
        session.events.push({ seq: session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ decision: 'guidance', reason: '还缺少异常路径证据', guidance: '补充异常路径回归后再提交完成结果' }) }] } } })
      }
      if (sessionId === 'session-parent' && text.startsWith('[TASK_COORDINATION]')) {
        session.events.push({ seq: session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `coordinated:${text.match(/Task ID: (.*)/)?.[1]}` }] } } })
      }
    }
    const agent = {
      session, status: 'idle',
      followup(message) { followups.push([sessionId, message]); recordMessage(message) },
      steer(message) { steers.push([sessionId, message]); recordMessage(message) },
      async whenIdle() {
        if (sessionId === 'session-parent' && checkpointReviewPending) {
          await new Promise((resolve) => { releaseCheckpointReview = resolve })
          checkpointReviewPending = false
        }
        if (sessionId === 'session-parent' && completionReviewPending) {
          await new Promise((resolve) => { releaseCompletionReview = resolve })
          completionReviewPending = false
        }
      },
    }
    return { agent, dispose: async () => { disposed.push(sessionId); if (agents.get(sessionId) === agent) agents.delete(sessionId) } }
  }
  const parentHandle = makeHandle('session-parent')
  agents.set('session-parent', parentHandle.agent)
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: {
      get(sessionId) { return agents.get(sessionId) },
      withoutInitiator(operation) { return operation() },
      async resume({ resumeSessionId }) { const handle = resumeSessionId === 'session-parent' ? parentHandle : makeHandle(resumeSessionId); agents.set(resumeSessionId, handle.agent); return handle },
      async create({ sessionId, meta, setup }) { creates.push(sessionId); createMetas.push(meta); setup({ on: () => () => undefined, tools: { register: (tool) => leafTools.push([sessionId, tool]) }, systemPrompt: { section: (section) => leafPromptSections.push([sessionId, section]) } }); const handle = makeHandle(sessionId); agents.set(sessionId, handle.agent); return handle },
    },
    goals: {
      get(agent) { return goals.get(agent.session.id) },
      create(agent, request) { const goal = { id: `goal-${agent.session.id}`, revision: 1, phase: 'active', activation: 'armed', ...request }; goals.set(agent.session.id, goal); return goal },
      block(agent, ref, reason) { const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'blocked', activation: 'disarmed', blockedReason: reason }; goals.set(agent.session.id, goal); return goal },
      edit(agent, ref, patch) { const goal = { ...goals.get(agent.session.id), ...patch, revision: ref.revision + 1 }; goals.set(agent.session.id, goal); return goal },
      resume(agent, ref) { approvalResumeOrder.push('Goal恢复'); const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'active', activation: 'armed', blockedReason: undefined }; goals.set(agent.session.id, goal); return goal },
      complete(agent, ref) { const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'complete', activation: 'disarmed' }; goals.set(agent.session.id, goal); return goal },
    },
    on(name, listener) { if (name === 'session/event') sessionObserver = listener; return () => { sessionObserver = undefined } },
    subagents: {
      async drainContinuableDescendants() {},
    },
    agentPresets: {
      mount: async () => ({ id: 'standard-convergent' }), composeFrom: () => 'standard-convergent',
      serviceFor: () => ({ set: () => undefined }),
    },
  }
  const store = {
    getGroup: (id) => groups.get(id), listGroups: () => [...groups.values()], listTasks: () => tasks, getTask: (id) => tasks.find((task) => task.taskId === id),
    getMaxConcurrentTasks: () => store.maxConcurrentTasks,
    async setMaxConcurrentTasks(value) { store.maxConcurrentTasks = value; return { maxConcurrentTasks: value } },
    async createTask(value) { const duplicate = tasks.find((task) => task.groupId === value.groupId && task.sourceMessageId === value.sourceMessageId); if (duplicate) return { created: false, task: duplicate }; const taskId = `task-${tasks.length + 1}`; const trigger = { sourceMessageId: value.sourceMessageId, ...(value.requesterName ? { requesterName: value.requesterName } : {}), ...(value.requesterOpenDingTalkId ? { requesterOpenDingTalkId: value.requesterOpenDingTalkId } : {}), ...(value.occurredAt !== undefined ? { occurredAt: value.occurredAt } : {}) }; const task = { ...value, taskId, childSessionId: taskSessionId(taskId), state: 'queued', triggerHistory: [trigger], runSequence: 1, runStartedAt: '2026-08-25T00:00:00Z', acceptanceCriteria: value.acceptanceCriteria ?? [value.objective], stageTasks: value.stageTasks ?? ['完成并验证当前轮目标'], runHistory: [], createdAt: '2026-08-25T00:00:00Z' }; tasks.push(task); return { created: true, task } },
    async updateTask(id, transform) { const index = tasks.findIndex((task) => task.taskId === id); tasks[index] = transform(tasks[index]); return tasks[index] },
    async appendOutbox({ groupId, ...outbound }) { const group = groups.get(groupId); if (!group.outbox.some((item) => item.sourceMessageId === outbound.sourceMessageId)) group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, ...outbound, status: 'pending' }); return group },
    async updateOutboundRecall({ groupId, outboundId, status, reason, error }) { const item = groups.get(groupId).outbox.find((entry) => entry.outboundId === outboundId); Object.assign(item, { recallStatus: status, recallReason: reason }, status === 'recalled' ? { recalledAt: '2026-08-27T00:00:00Z', recallError: undefined } : {}, status === 'failed' ? { recallError: error } : {}); return groups.get(groupId) },
    async recordActivity(value) { const existing = activities.find((item) => item.eventKey === value.eventKey); if (existing) return { created: false, activity: existing }; activities.push(value); return { created: true, activity: value } },
    async recordAlert(value) { const existing = alerts.find((item) => item.taskId === value.taskId && item.fingerprint === value.fingerprint); if (existing) { existing.count += 1; return { created: false, alert: existing } } const alert = { ...value, count: 1 }; alerts.push(alert); return { created: true, alert } },
    listActivities: () => activities,
    close: async () => undefined,
  }
  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions({ agentPreset: 'standard-convergent', maxConcurrentTasks: 2, supervisorIntervalMs: 0 }))
  const one = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm1', objective: 'one', requesterName: '初始提出人', requesterOpenDingTalkId: 'od-initial', occurredAt: '2026-08-25T01:00:00Z' })
  const two = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm2', objective: 'two' })
  const three = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm3', objective: 'three' })

  assert.deepEqual([one.task.state, two.task.state, three.task.state], ['running', 'running', 'queued'])
  assert.deepEqual(creates, ['session-task-1', 'session-task-2'])
  const secondCheckpointTool = leafTools.find(([sessionId, tool]) => sessionId === two.task.childSessionId && tool.name === 'submit_task_checkpoint')?.[1]
  blockCheckpointReview = true
  const checkpointReviewStarted = new Promise((resolve) => { markCheckpointReviewStarted = resolve })
  const pendingCheckpoint = secondCheckpointTool.execute({ kind: 'plan-confirmed', summary: '并发检查计划', completedItems: [], evidence: ['已读取目标'], remainingItems: ['检查一', '检查二'], nextStep: '检查一', needsCoordinatorDecision: false }, { agent: { session: { id: two.task.childSessionId } } })
  await checkpointReviewStarted
  const concurrentUpdate = runtime.appendTaskContext({ taskId: one.task.taskId, context: '评审期间补充另一个 Task 的上下文' })
  assert.equal(await Promise.race([concurrentUpdate.then(() => 'updated'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))]), 'updated', '主会话评审不得持有全局 Task 串行锁并阻塞其他 Task')
  releaseCheckpointReview()
  await pendingCheckpoint
  blockCheckpointReview = false
  markCheckpointReviewStarted = undefined
  assert.deepEqual(createMetas[0], { cwd: agentWorkspace, parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 })
  const leafPolicyPrompt = leafPromptSections.find(([sessionId, section]) => sessionId === one.task.childSessionId && section.name === 'group-task-blocking-policy')?.[1].text()
  assert.match(leafPolicyPrompt, /命中任何适用 Skill 时，必须加载并遵循其完整说明/u)
  assert.match(leafPolicyPrompt, /内部维护动作不视为扩大 Task objective/u)
  assert.match(leafPolicyPrompt, /Runtime 不指定或绑定任何具体 Skill/u)
  assert.doesNotMatch(leafPolicyPrompt, /evolve-self-improving|learningSignals|TASK_INTERNAL_LEARNING_SIGNALS/u, 'Runtime 提示词不得绑定具体 Skill 或专用学习协议')
  assert.equal(goals.get('session-task-1').phase, 'active')
  assert.equal(one.task.runSequence, 1)
  assert.deepEqual(one.task.acceptanceCriteria, ['one'])
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', 'Goal active 不等于 Task 完成')
  const checkpointTool = leafTools.find(([sessionId, tool]) => sessionId === one.task.childSessionId && tool.name === 'submit_task_checkpoint')?.[1]
  assert.ok(checkpointTool)
  const submitCheckpointPair = async (taskId, label) => {
    const current = runtime.getTask(taskId)
    const tool = leafTools.filter(([sessionId, candidate]) => sessionId === current.childSessionId && candidate.name === 'submit_task_checkpoint').at(-1)?.[1]
    await tool.execute({ kind: 'plan-confirmed', summary: `${label}计划`, completedItems: [], evidence: ['已读取当前目标'], remainingItems: [`${label}检查点一`, `${label}检查点二`], nextStep: `${label}检查点一`, needsCoordinatorDecision: false }, { agent: { session: { id: current.childSessionId } } })
    await tool.execute({ kind: 'stage-completed', stageTask: current.stageTasks[0], summary: `${label}阶段完成`, completedItems: [`${label}检查点一`], evidence: ['阶段证据'], remainingItems: [`${label}检查点二`], nextStep: `${label}检查点二`, needsCoordinatorDecision: false }, { agent: { session: { id: current.childSessionId } } })
    await tool.execute({ kind: 'stage-completed', stageTask: current.stageTasks[0], summary: `${label}验证完成`, completedItems: [`${label}检查点二`], evidence: ['验证证据'], remainingItems: [], nextStep: '提交完成结果', needsCoordinatorDecision: false }, { agent: { session: { id: current.childSessionId } } })
  }
  assertSupportedJsonSchema(checkpointTool.parameters)
  assertSupportedJsonSchema(checkpointTool.output.schema)
  await assert.rejects(checkpointTool.execute({ kind: 'stage-completed', stageTask: '完成并验证当前轮目标', summary: '跳过计划', completedItems: [], evidence: [], remainingItems: [], nextStep: '完成', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } }), /task_checkpoint_plan_required/)
  await assert.rejects(checkpointTool.execute({ kind: 'plan-confirmed', summary: '计划不足', completedItems: [], evidence: [], remainingItems: ['只有一项'], nextStep: '执行', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } }), /task_checkpoint_plan_insufficient/)
  await checkpointTool.execute({ kind: 'plan-confirmed', summary: '已拆分执行检查点', completedItems: [], evidence: ['已读取任务目标'], remainingItems: ['核验正常路径', '核验异常路径'], nextStep: '核验正常路径', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } })
  await assert.rejects(checkpointTool.execute({ kind: 'stage-completed', stageTask: '完成并验证当前轮目标', summary: '批量核验完成', completedItems: ['核验正常路径', '核验异常路径'], evidence: ['runtime.js:303'], remainingItems: [], nextStep: '提交结果', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } }), /task_checkpoint_must_advance_one/)
  const checkpointReply = await checkpointTool.execute({ kind: 'stage-completed', stageTask: '完成并验证当前轮目标', summary: '接口核验完成', completedItems: ['核验正常路径'], evidence: ['runtime.js:303'], remainingItems: ['核验异常路径'], nextStep: '运行异常路径回归', needsCoordinatorDecision: true }, { agent: { session: { id: one.task.childSessionId } } })
  assert.equal(checkpointReply.coordinatorDecision, 'guidance')
  assert.equal(checkpointReply.guidance, '补充异常路径回归后再提交完成结果')
  assert.equal(runtime.getTask(one.task.taskId).checkpoints[1].coordinatorDecision, 'guidance')
  const checkpointReviewMessage = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith('[TASK_CHECKPOINT_REVIEW]'))?.[1]
  assert.equal(checkpointReviewMessage.source.kind, 'coordinator', '检查点验收必须作为内部上下文注入')
  await assert.rejects(checkpointTool.execute({ kind: 'stage-completed', stageTask: '不存在的阶段', summary: '错误阶段', completedItems: [], evidence: [], remainingItems: [], nextStep: '停止', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } }), /task_checkpoint_stage_invalid/)
  await assert.rejects(checkpointTool.execute({ kind: 'evidence-gap', summary: '证据不足', completedItems: [], evidence: [], remainingItems: [], nextStep: '补证', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } }), /task_checkpoint_progress_requires_stage_completed/)
  await assert.rejects(runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: '检查点未清空', evidence: ['verified'], artifacts: [] } }), /task_checkpoints_remaining/)
  await checkpointTool.execute({ kind: 'stage-completed', stageTask: '完成并验证当前轮目标', summary: '异常路径回归完成', completedItems: ['核验异常路径'], evidence: ['异常路径回归通过'], remainingItems: [], nextStep: '提交完成结果', needsCoordinatorDecision: false }, { agent: { session: { id: one.task.childSessionId } } })
  assert.equal(groups.get('group-a').outbox.length, 0, '内部检查点不得进入群聊发信箱')
  sessionObserver({ id: 'session-task-1' }, { seq: 7, type: 'turn/end', data: { status: 'success' } })
  sessionObserver({ id: 'session-task-1' }, { seq: 7, type: 'turn/end', data: { status: 'success' } })
  await runtime.flushActivities()
  assert.equal(runtime.listActivities().length, 1)
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', 'turn/end投影不能完成Task')
  const followup = await runtime.followupTask({ taskId: one.task.taskId, text: 'more evidence' })
  assert.equal(followup.accepted, true)
  assert.equal(steers.some(([sessionId, message]) => sessionId === 'session-task-1' && message.content[0]?.text === 'more evidence'), true)
  assert.equal(followups.some(([sessionId, message]) => sessionId === 'session-task-1' && message.content[0]?.text === 'more evidence'), false, '主会话向叶子补充上下文不得排队发送')
  await runtime.submitTaskResult({ taskId: two.task.taskId, result: { status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'provide fixture', questions: ['Which fixture?'] } })
  assert.equal(runtime.getTask(two.task.taskId).state, 'waiting')
  assert.equal(groups.get('group-a').outbox[0].sourceMessageId.startsWith(`task-result:${two.task.taskId}:waiting:`), true)
  const blockerRequests = []
  runtime.onHumanBlockerRequested((event) => { blockerRequests.push(event) })
  const releaseWaiting = { status: 'waiting', waitingKind: 'human-intervention', summary: '等待发布批准', evidence: ['发布范围已核验'], artifacts: [], waitingReason: '生产发布需要批准', blockerCategory: 'redline', risk: '错误发布会影响生产环境', attemptedActions: ['已完成只读核验'], requestedAction: '发布 dataset v1 和 dataset-web v2；不执行回滚' }
  const firstBlocker = await runtime.submitTaskResult({ taskId: one.task.taskId, result: releaseWaiting })
  const firstRequestId = firstBlocker.humanBlocker.requestId
  const supplementedBlocker = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '补充阻塞背景，不解除审批' })
  assert.equal(supplementedBlocker.state, 'waiting')
  assert.equal(supplementedBlocker.runSequence, firstBlocker.runSequence, '阻塞中补充不得增加执行轮次')
  assert.equal(supplementedBlocker.childSessionId, firstBlocker.childSessionId, '阻塞中补充必须保持同一叶子 Session')
  assert.equal(supplementedBlocker.humanBlocker.requestId, firstRequestId, '阻塞中补充不得清空 blocker')
  const duplicateBlocker = await runtime.submitTaskResult({ taskId: one.task.taskId, result: { ...releaseWaiting, requestedAction: ' 发布 dataset v1 和 dataset-web v2；不执行回滚 ' } })
  assert.equal(duplicateBlocker.humanBlocker.requestId, firstRequestId, '同一待批范围重复上报必须复用阻塞请求')
  assert.equal(blockerRequests.length, 1, '同一待批范围只能触发一次外发')
  await runtime.recordHumanBlockerDelivery({ taskId: one.task.taskId, requestId: firstRequestId, openTaskId: 'open-1', conversationId: 'self-1', messageId: 'approval-1' })
  goals.set('session-task-1', { ...goals.get('session-task-1'), roundsStarted: 24, maxGoalRounds: 24 })
  await runtime.resolveHumanBlocker({ taskId: one.task.taskId, requestId: firstRequestId, quotedMessageId: 'approval-1', replyMessageId: 'reply-1', reply: '批准', decision: 'approved' })
  assert.equal(goals.get('session-task-1').maxGoalRounds, 48, '真人解决阻塞后必须先补充一组Goal轮数预算')
  assert.equal(goals.get('session-task-1').phase, 'active')
  assert.equal(goals.get('session-task-1').activation, 'armed')
  assert.equal(runtime.getTask(one.task.taskId).humanBlockerHistory.length, 1, '真人批复必须持久化到Task历史')
  const approvedReplay = await runtime.submitTaskResult({ taskId: one.task.taskId, result: releaseWaiting })
  assert.equal(approvedReplay.state, 'running', '已批准的完全相同范围不得再次进入等待')
  assert.equal(approvedReplay.humanBlocker.requestId, firstRequestId)
  assert.equal(blockerRequests.length, 1, '已批准范围重试不得再次外发申请')
  const changedScope = await runtime.submitTaskResult({ taskId: one.task.taskId, result: { ...releaseWaiting, requestedAction: '发布 dataset v2 和 dataset-web v2；不执行回滚' } })
  assert.notEqual(changedScope.humanBlocker.requestId, firstRequestId, '受控操作范围实质变化时必须创建新申请')
  await runtime.recordHumanBlockerDelivery({ taskId: one.task.taskId, requestId: changedScope.humanBlocker.requestId, openTaskId: 'open-2', conversationId: 'self-1', messageId: 'approval-2' })
  const reissued = await runtime.reissueAuthorization({ requestId: changedScope.humanBlocker.requestId, reason: '迁移到统一授权审批' })
  assert.notEqual(reissued.request.requestId, changedScope.humanBlocker.requestId)
  assert.equal(runtime.getAuthorizationRequest(changedScope.humanBlocker.requestId).status, 'superseded')
  assert.equal(runtime.getAuthorizationRequest(changedScope.humanBlocker.requestId).supersededBy, reissued.request.requestId)
  assert.equal(runtime.getTask(one.task.taskId).humanBlocker.status, 'pending-send')
  assert.equal(blockerRequests.length, 3, '重提申请必须只新增一次外发')
  await runtime.recordAuthorizationRecall({ requestId: changedScope.humanBlocker.requestId, status: 'recalled' })
  assert.equal(runtime.getAuthorizationRequest(changedScope.humanBlocker.requestId).recallStatus, 'recalled')
  approvalResumeOrder.length = 0
  const webDecision = await runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'approved', comment: '页面批准', source: 'web' })
  assert.deepEqual(approvalResumeOrder, ['批复入队', 'Goal恢复'], '必须先让叶子会话收到批复原文，再恢复自动 Goal 轮次')
  assert.equal(webDecision.decisionSource, 'web')
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', 'Web批准必须恢复同一Task')
  assert.equal(runtime.getTask(one.task.taskId).humanBlockerHistory.length, 3)
  await assert.rejects(runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'done', evidence: [], artifacts: [] } }))
  assert.equal(runtime.getTask(one.task.taskId).state, 'running')
  await store.updateTask(one.task.taskId, (current) => ({
    ...current,
    sourceMessageId: 'recovery:completion-review-gate',
    requesterName: '内部恢复操作人',
    requesterOpenDingTalkId: undefined,
    triggerHistory: [...current.triggerHistory, { sourceMessageId: 'recovery:completion-review-gate', requesterName: '内部恢复操作人' }],
  }))
  Object.assign(groups.get('group-a').outbox[0], { status: 'sent', deliveredMessageId: 'ding-old-1' })
  blockCompletionReview = true
  const completionReviewStarted = new Promise((resolve) => { markCompletionReviewStarted = resolve })
  const pendingCompletion = runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified', 'uat2 页面回归通过'], artifacts: ['docs/acceptance/report.md'], delivery: { environment: 'UAT2', pipeline: 186 } } })
  await completionReviewStarted
  const concurrentRename = runtime.renameTask({ taskId: three.task.taskId, title: '评审期间更新另一个 Task' })
  assert.equal(await Promise.race([concurrentRename.then(() => 'updated'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))]), 'updated', '完成结果评审不得持有全局 Task 串行锁并阻塞其他 Task')
  releaseCompletionReview()
  await pendingCompletion
  blockCompletionReview = false
  markCompletionReviewStarted = undefined
  const completionReviewMessage = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith('[TASK_COMPLETION_REVIEW]'))?.[1]
  assert.equal(completionReviewMessage.source.kind, 'coordinator', '完成验收必须作为内部上下文注入')
  assert.match(completionReviewMessage.content[0].text, /不得回复群聊、不得写入发信箱/u)
  assert.equal(groups.get('group-a').outbox[1].sourceMessageId, `task-result:${one.task.taskId}:completed`)
  assert.equal(groups.get('group-a').outbox[1].text, `coordinated:${one.task.taskId}`)
  assert.equal(groups.get('group-a').outbox[1].replyToMessageId, 'm1', '内部恢复来源不得覆盖最后一条真实群消息引用')
  assert.equal(groups.get('group-a').outbox[1].replyToSenderOpenDingTalkId, 'od-initial')
  assert.deepEqual(groups.get('group-a').outbox[1].atOpenDingTalkIds, ['od-initial'])
  const coordinationPrompt = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith(`[TASK_COORDINATION]\nTask ID: ${one.task.taskId}\n`))?.[1].content[0].text
  const coordinationMessage = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith(`[TASK_COORDINATION]\nTask ID: ${one.task.taskId}\n`))?.[1]
  assert.equal(coordinationMessage.source.kind, 'user', '对外通知生成路径保持现状')
  assert.match(coordinationPrompt, /"evidence":\["verified","uat2 页面回归通过"\]/u, '主会话必须收到完整证据而非只有摘要')
  assert.match(coordinationPrompt, /"artifacts":\["docs\/acceptance\/report\.md"\]/u, '主会话必须收到交付物')
  assert.match(coordinationPrompt, /"delivery":\{"environment":"UAT2","pipeline":186\}/u, '主会话必须收到部署与交付状态')
  assert.match(coordinationPrompt, /不得省略不同关注点、限定条件、失败项或“未验证\/未部署”等边界/u)
  assert.equal(followups.some(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith('[TASK_INTERNAL_LEARNING_SIGNALS]')), false, 'Runtime 不得向主会话转发专用学习信号')
  const replayed = []
  runtime.onOutboxAppended((event) => { replayed.push(event) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(replayed.map((event) => event.outbound.sourceMessageId), groups.get('group-a').outbox.map((item) => item.sourceMessageId))
  await assert.rejects(runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] } }))
  assert.equal(groups.get('group-a').outbox.length, 2)
  assert.equal(runtime.getTask(three.task.taskId).state, 'running')
  assert.equal(creates[2], 'session-task-3')
  assert.equal(goals.get('session-task-1').phase, 'complete')
  assert.ok(disposed.includes('session-task-1'))
  goals.set('session-task-3', { ...goals.get('session-task-3'), revision: 2, phase: 'paused', activation: 'disarmed' })
  agents.get('session-task-3').status = 'running'
  const deferredInspection = await runtime.inspectRunningTasks()
  assert.equal(deferredInspection[0].deferred, true, 'Goal 当前轮尚未停稳时不得中途 resume')
  assert.equal(goals.get('session-task-3').phase, 'paused')
  agents.get('session-task-3').status = 'idle'
  goals.set('session-task-3', { ...goals.get('session-task-3'), revision: 3, phase: 'complete', activation: 'disarmed' })
  const resultRequestInspection = await runtime.inspectRunningTasks()
  assert.equal(resultRequestInspection.find((item) => item.taskId === three.task.taskId).resultRequested, true)
  assert.equal(goals.get('session-task-3').phase, 'active')
  goals.set('session-task-3', { ...goals.get('session-task-3'), revision: 4, phase: 'complete', activation: 'disarmed' })
  const goalInspection = await runtime.inspectRunningTasks()
  const recoveredTask = runtime.getTask(three.task.taskId)
  assert.equal(goalInspection.find((item) => item.taskId === three.task.taskId).goalRecovered, true)
  assert.notEqual(recoveredTask.childSessionId, 'session-task-3')
  assert.equal(goals.get(recoveredTask.childSessionId).phase, 'active')
  assert.equal(goals.get(recoveredTask.childSessionId).activation, 'armed')
  agents.delete(recoveredTask.childSessionId)
  const sessionInspection = await runtime.inspectRunningTasks()
  assert.equal(sessionInspection.find((item) => item.taskId === three.task.taskId).sessionRecovered, true)
  assert.equal(agents.get(recoveredTask.childSessionId)?.session.id, recoveredTask.childSessionId)
  assert.equal(runtime.getTask(three.task.taskId).state, 'running')
  assert.equal(goals.get('session-task-2').phase, 'blocked', '业务 waiting Task 不应被常驻巡检误唤醒')
  assert.equal(alerts.some((alert) => alert.fingerprint === 'leaf-session-recovered'), true)
  const archived = await runtime.archiveTask({ taskId: one.task.taskId })
  assert.ok(archived.archivedAt)
  const reopened = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '补做已归档任务', sourceMessageId: 'm-reopen-1', requesterName: '重开提出人', requesterOpenDingTalkId: 'od-reopen-1', occurredAt: '2026-08-26T01:00:00Z' })
  assert.equal(reopened.state, 'queued', '并发名额已满时重开的归档任务进入原生FIFO队列')
  assert.equal(reopened.archivedAt, undefined)
  assert.equal(reopened.relatedContexts.at(-1), '补做已归档任务')
  assert.equal(reopened.sourceMessageId, 'm-reopen-1')
  assert.equal(reopened.requesterOpenDingTalkId, 'od-reopen-1')
  assert.equal(reopened.childSessionId, one.task.childSessionId, 'reopen 必须复用同一叶子 Session')
  assert.equal(reopened.runSequence, 2)
  assert.equal(reopened.runHistory.length, 1)
  assert.equal(reopened.runHistory[0].childSessionId, one.task.childSessionId)
  assert.deepEqual(reopened.acceptanceCriteria, ['one'])
  assert.deepEqual(reopened.stageTasks, ['完成并验证当前轮目标'])
  assert.deepEqual(reopened.triggerHistory, [
    { sourceMessageId: 'm1', requesterName: '初始提出人', requesterOpenDingTalkId: 'od-initial', occurredAt: '2026-08-25T01:00:00Z' },
    { sourceMessageId: 'm-reopen-1', requesterName: '重开提出人', requesterOpenDingTalkId: 'od-reopen-1', occurredAt: '2026-08-26T01:00:00Z' },
  ])
  const raisedConcurrency = await runtime.updateAgentConfig({ maxConcurrentTasks: 3 })
  assert.equal(raisedConcurrency.maxConcurrentTasks, 3)
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', '提高并行上限后按FIFO立即启动待执行任务')
  await submitCheckpointPair(one.task.taskId, '第二轮')
  await runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'second done', evidence: ['second verified'], artifacts: [] } })
  assert.equal(groups.get('group-a').outbox.at(-1).sourceMessageId, `task-result:${one.task.taskId}:completed:1`, '重开任务再次完成必须生成独立通知')
  assert.equal(groups.get('group-a').outbox.at(-1).replyToMessageId, 'm-reopen-1')
  assert.equal(groups.get('group-a').outbox.at(-1).replyToSenderOpenDingTalkId, 'od-reopen-1')
  assert.deepEqual(groups.get('group-a').outbox.at(-1).atOpenDingTalkIds, ['od-reopen-1'])

  const reopenedCompleted = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '继续核验已完成任务', sourceMessageId: 'm-reopen-2', requesterName: '再次提出人', requesterOpenDingTalkId: 'od-reopen-2' })
  assert.equal(reopenedCompleted.state, 'running', '已完成任务收到task-context时必须恢复原Task')
  const runningUpgraded = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '调查清楚后请直接修复', objective: '调查并修复问题', sourceMessageId: 'm-running-upgrade', requesterName: '升级提出人', requesterOpenDingTalkId: 'od-upgrade' })
  assert.equal(runningUpgraded.objective, '调查并修复问题')
  assert.equal(runningUpgraded.objectiveHistory.at(-1).objective, 'one')
  assert.equal(goals.get(runningUpgraded.childSessionId).objective, runningUpgraded.objective, '运行中授权升级必须替换当前Goal目标')

  await submitCheckpointPair(one.task.taskId, '第三轮')
  await runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'investigated', evidence: ['checked'], artifacts: [] } })
  const internalReopen = await runtime.reopenTask({ taskId: one.task.taskId, context: '内部恢复完成验收', sourceMessageId: 'recovery:completion-review-gate', requesterName: '内部恢复操作人' })
  assert.equal(internalReopen.sourceMessageId, 'm-reopen-2', '内部恢复不得覆盖当前真实群消息')
  assert.equal(internalReopen.requesterOpenDingTalkId, 'od-reopen-2')
  assert.equal(internalReopen.triggerHistory.some((item) => item.sourceMessageId.startsWith('recovery:')), false, '内部恢复不得写入消息触发历史')
  await submitCheckpointPair(one.task.taskId, '内部恢复轮')
  await runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'internal recovery done', evidence: ['checked again'], artifacts: [] } })
  const upgraded = await runtime.reopenTask({ taskId: one.task.taskId, context: '请修复并部署 UAT2', objective: '修复问题、部署 UAT2 并完成业务验证', sourceMessageId: 'm-upgrade', requesterName: '升级提出人', requesterOpenDingTalkId: 'od-upgrade' })
  assert.equal(upgraded.objective, '修复问题、部署 UAT2 并完成业务验证')
  assert.equal(upgraded.objectiveHistory.at(-1).objective, '调查并修复问题')
  assert.equal(upgraded.objectiveHistory.at(-1).sourceMessageId, 'm-upgrade')
  assert.equal(goals.get(upgraded.childSessionId).objective, upgraded.objective)
  assert.equal(reopenedCompleted.relatedContexts.at(-1), '继续核验已完成任务')
  assert.equal(reopenedCompleted.completionSequence, 2)
  assert.equal(reopenedCompleted.sourceMessageId, 'm-reopen-2')
  assert.equal(reopenedCompleted.triggerHistory.length, 3)
  assert.equal(reopenedCompleted.triggerHistory[0].sourceMessageId, 'm1')
  assert.equal(reopenedCompleted.triggerHistory[1].sourceMessageId, 'm-reopen-1')
  assert.equal(reopenedCompleted.triggerHistory[2].sourceMessageId, 'm-reopen-2')
  const beforeRejectedCompletion = groups.get('group-a').outbox.length
  await submitCheckpointPair(one.task.taskId, '升级轮')
  await assert.rejects(runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'development', summary: '重复上一轮旧结论', evidence: ['只有旧结论证据'], artifacts: [] } }), /task_result_objective_not_covered/)
  assert.equal(runtime.getTask(one.task.taskId).state, 'running')
  assert.equal(groups.get('group-a').outbox.length, beforeRejectedCompletion, '验收拒绝不得生成完成通知')
  assert.match(steers.at(-1)[1].content[0].text, /^\[TASK_RESULT_REJECTED\]/u)
  assert.equal(followups.some(([sessionId, message]) => sessionId === one.task.childSessionId && message.content[0]?.text?.startsWith('[TASK_RESULT_REJECTED]')), false, '结果驳回必须插话给叶子')
  await runtime.close()
  const persistedChildSessionId = runtime.getTask(three.task.taskId).childSessionId
  goals.set(persistedChildSessionId, { ...goals.get(persistedChildSessionId), revision: 4, phase: 'paused', activation: 'disarmed' })
  const recoveredRuntime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions({ agentPreset: 'standard-convergent', supervisorIntervalMs: 0 }))
  assert.equal(goals.get(persistedChildSessionId).phase, 'active', '进程重启恢复时仍应续接Task当前叶子')
  assert.equal(recoveredRuntime.getTask(three.task.taskId).state, 'running')
  assert.equal(goals.get('session-task-2').phase, 'blocked', '业务 waiting Task 不应被启动恢复误唤醒')
  agents.get(persistedChildSessionId).status = 'running'
  goals.set(persistedChildSessionId, { ...goals.get(persistedChildSessionId), revision: 5, phase: 'blocked', activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 })
  const exhaustedInspection = await recoveredRuntime.inspectRunningTasks()
  assert.equal(exhaustedInspection.find((item) => item.taskId === three.task.taskId).exhausted, true)
  assert.equal(recoveredRuntime.getTask(three.task.taskId).state, 'waiting', '轮数耗尽后即使Agent残留running也不得继续显示运行中')
  assert.match(recoveredRuntime.getTask(three.task.taskId).waitingReason, /24\/24/u)
  await recoveredRuntime.close()
})
