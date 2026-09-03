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

test('Inbox 默认零延迟 steer，回复提交门禁不退化为定时聚合', () => {
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
  const steered = [], rechecks = [], followups = [], registeredTools = [], tasks = []
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
      if (text.startsWith('[GROUP_DECISION_RECHECK]')) {
        rechecks.push(message)
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
    async createTask(value) {
      const { sourceMessageIds, ...taskValue } = value
      const messageHistory = (sourceMessageIds ?? [value.sourceMessageId]).flatMap((messageId) => {
        const message = group.messages.find((item) => item.messageId === messageId)
        if (message === undefined) return []
        return [{
          messageId: message.messageId, text: message.text,
          ...(message.senderName ? { senderName: message.senderName } : {}),
          ...(message.senderOpenDingTalkId ? { senderOpenDingTalkId: message.senderOpenDingTalkId } : {}),
          ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
          ...(message.quotedMessage?.messageId ? { quotedMessageId: message.quotedMessage.messageId } : {}),
          runSequence: 1, associatedAt: '2026-09-02T00:00:00.000Z',
        }]
      })
      const task = { ...taskValue, ...(messageHistory.length > 0 ? { messageHistory } : {}), taskId: `task-${tasks.length + 1}`, childSessionId: `session-task-${tasks.length + 1}`, state: 'queued' }
      tasks.push(task)
      return { created: true, task }
    },
    async updateTask(taskId, transform) {
      const index = tasks.findIndex((task) => task.taskId === taskId)
      if (index < 0) throw new Error(`task_not_found:${taskId}`)
      tasks[index] = transform(tasks[index])
      return tasks[index]
    },
    close: async () => undefined,
  }
  return { group, steered, rechecks, followups, registeredTools, tasks, releaseIdle, waitForSteers, ctx, store, handle, taskCapacity }
}

const decisionRequestId = (message) => message.content[0].text.match(/^判断请求 ID：([^\r\n]+)$/mu)?.[1]
const acceptedSubmission = (acceptedRequestIds, pendingRequestIds = []) => ({
  status: 'accepted', acceptedRequestIds, pendingRequestIds, missingRequestIds: [], unexpectedRequestIds: [],
})
const staleSubmission = (pendingRequestIds, missingRequestIds, unexpectedRequestIds = []) => ({
  status: 'stale', acceptedRequestIds: [], pendingRequestIds, missingRequestIds, unexpectedRequestIds,
})

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

function taskReplyRuntimeFixture({ messageHistory, groupMessages = [] } = {}) {
  const result = { status: 'completed', workType: 'non-development', summary: '原完成结果', evidence: ['已核验'], artifacts: [] }
  const group = { groupId: 'task-reply-group', residentSessionId: 'session-task-reply', residentAgentPreset: 'standard', nextSequence: groupMessages.length + 1, messages: groupMessages, outbox: [] }
  let task = { taskId: 'task-reply', groupId: group.groupId, state: 'completed', objective: '完成既定事项', sourceMessageId: 'source-message', requesterName: '提出人', requesterOpenDingTalkId: 'od-requester', ...(messageHistory ? { messageHistory } : {}), completionSequence: 1, result, lastCompletedResult: result }
  const registeredTools = [], followups = [], steered = []
  const neverIdle = new Promise(() => undefined)
  let idleCalls = 0
  const agent = {
    session: { id: group.residentSessionId, seq: 0, events: [] }, status: 'running',
    followup(message) { followups.push(message) },
    steer(message) { steered.push(message) },
    async whenIdle() { idleCalls += 1; if (idleCalls > 1) await neverIdle },
  }
  const handle = { agent, dispose: async () => undefined }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: { async resume(options) { await options.setup({ on: () => () => undefined, tools: { register: (tool) => registeredTools.push(tool), restrict: () => undefined }, systemPrompt: { section: () => undefined } }); return handle } },
    subagents: { drainContinuableDescendants: async () => undefined },
    agentPresets: { mount: async (_ctx, id) => ({ id }), serviceFor: () => ({ set: () => undefined }) },
  }
  const store = {
    getGroup: (groupId) => groupId === group.groupId ? group : undefined,
    listGroups: () => [group], listTasks: () => [task], getTask: (taskId) => taskId === task.taskId ? task : undefined,
    async updateTask(taskId, transform) { if (taskId !== task.taskId) throw new Error(`task_not_found:${taskId}`); task = transform(task); return task },
    async ingest(message) { const accepted = { ...message, sequence: group.nextSequence++, agentDeliveryStatus: 'pending' }; group.messages.push(accepted); return { duplicate: false, sequence: accepted.sequence, group } },
    async markMessageAgentDelivery({ messageId, status, error }) { Object.assign(group.messages.find((item) => item.messageId === messageId), { agentDeliveryStatus: status, ...(error === undefined ? {} : { error }) }); return group },
    async appendOutbox(value) { if (!group.outbox.some((item) => item.sourceMessageId === value.sourceMessageId)) group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, ...value, status: 'pending' }); return group },
    close: async () => undefined,
  }
  return { result, group, getTask: () => task, registeredTools, followups, steered, agent, ctx, store }
}

test('同一turn的多条消息按step工具提交独立Decision且不等待turn结束', async () => {
  const fixture = decisionRuntimeFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '第一条', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '第二条', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submitted = await tool.execute({ observedRequestIds: requestIds, submissions: [
    { requestIds: [requestIds[0]], decision: { actions: [], reply: '第一项结果' } },
    { requestIds: [requestIds[1]], decision: { actions: [], reason: '第二项独立忽略' } },
  ] }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission(requestIds))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '第一项结果')
  assert.equal(secondResult.decision.reason, '第二项独立忽略')
  assert.equal(fixture.followups.length, 0, '普通群判断不再排队 coordinator followup')
  assert.equal(fixture.handle.agent.session.events.length, 0, 'Decision 在工具执行时结算，不依赖 turn/end 日志')
  assert.deepEqual(fixture.group.messages.map((item) => item.agentDeliveryStatus), ['delivered', 'delivered'])
  fixture.releaseIdle()
  await runtime.close()
})

test('DWS listener 恢复会关闭退出和启动异常两类 carrier 告警', async () => {
  const fixture = decisionRuntimeFixture()
  fixture.tasks.push(
    { taskId: 'task-running', groupId: fixture.group.groupId, state: 'running' },
    { taskId: 'task-completed', groupId: fixture.group.groupId, state: 'completed' },
  )
  const resolutions = []
  fixture.store.resolveAlerts = async (value) => { resolutions.push(value); return { resolved: 1 } }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))

  await runtime.resolveGroupCarrierIssues({ groupId: fixture.group.groupId })

  assert.deepEqual(resolutions, [{ taskId: 'task-running', fingerprintPrefix: 'dws-consumer-' }, { taskId: 'task-completed', fingerprintPrefix: 'dws-consumer-' }])
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
  await tool.execute({ observedRequestIds: requestIds, submissions: [{ requestIds, decision: { actions: [{ kind: 'new-task', title: '合并处理', objective: '处理主体与补充范围', acceptanceCriteria: ['范围均已核验'], sourceMessageIds: ['m1', 'm2'] }], reply: '已开始处理。' } }] }, { agent: fixture.handle.agent })
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

test('同批四条消息可同时表达部分相关独立完成与仅观察待处理', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'complex-batch-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingests = [
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-a', text: '事项A主体', occurredAt: '2026-09-02T01:00:00Z' }),
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-b', text: '事项A的补充B', occurredAt: '2026-09-02T01:00:01Z' }),
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-c', text: '独立事项C', occurredAt: '2026-09-02T01:00:02Z' }),
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-d', text: '已观察但稍后处理D', occurredAt: '2026-09-02T01:00:03Z' }),
  ]
  await fixture.waitForSteers(4)
  const [requestA, requestB, requestC, requestD] = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submitted = await tool.execute({
    observedRequestIds: [requestA, requestB, requestC, requestD],
    submissions: [
      { requestIds: [requestA, requestB], decision: { actions: [{ kind: 'new-task', title: '合并AB', objective: '结合A与B完成同一事项', acceptanceCriteria: ['A与B均已覆盖'], sourceMessageIds: ['m-a', 'm-b'] }], reply: '已结合A与B处理。' } },
      { requestIds: [requestC], decision: { actions: [], reason: 'C是独立且无需回复的事项' } },
    ],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission([requestA, requestB, requestC], [requestD]))
  const [resultA, resultB, resultC] = await Promise.all(ingests.slice(0, 3))
  assert.equal(resultA.decision.reply, '已结合A与B处理。')
  assert.equal(resultB.decision.reply, '已结合A与B处理。')
  assert.equal(resultC.decision.reason, 'C是独立且无需回复的事项')
  assert.deepEqual(fixture.group.messages.map((message) => message.agentDeliveryStatus), ['delivered', 'delivered', 'delivered', 'steered'])
  assert.equal(fixture.tasks.length, 1)
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['已结合A与B处理。'])

  await tool.execute({ submissions: [{ requestIds: [requestD], decision: { actions: [], reason: 'D在回复后继续处理' } }] }, { agent: fixture.handle.agent })
  assert.equal((await ingests[3]).decision.reason, 'D在回复后继续处理')
  fixture.releaseIdle()
  await runtime.close()
})

test('一个Decision可把历史与当前消息多对多关联到不同Task', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'many-to-many-history-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  await runtime.backfill([{
    groupId: fixture.group.groupId, messageId: 'm-history', text: '最初提出两个事项', occurredAt: '2026-09-02T00:59:59Z', senderName: '最初提出人', senderOpenDingTalkId: 'od-history',
  }])
  const ingests = [
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-a', text: '事项A的执行要求', occurredAt: '2026-09-02T01:00:00Z', senderName: '甲', senderOpenDingTalkId: 'od-a' }),
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-b', text: 'A与B共用的约束', occurredAt: '2026-09-02T01:00:01Z', senderName: '乙', senderOpenDingTalkId: 'od-b' }),
    runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm-c', text: '事项B的验收要求', occurredAt: '2026-09-02T01:00:02Z', senderName: '丙', senderOpenDingTalkId: 'od-c' }),
  ]
  await fixture.waitForSteers(3)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = (actions) => ({ observedRequestIds: requestIds, submissions: [{ requestIds, decision: { actions, reply: '' } }] })

  await assert.rejects(tool.execute(submission([{ kind: 'new-task', title: '缺少来源', objective: '不得创建', acceptanceCriteria: ['不得创建'] }]), { agent: fixture.handle.agent }), /group_decision_invalid_schema/)
  await assert.rejects(tool.execute(submission([{ kind: 'new-task', title: '重复来源', objective: '不得创建', acceptanceCriteria: ['不得创建'], sourceMessageIds: ['m-a', 'm-a'] }]), { agent: fixture.handle.agent }), /task_action_source_message_duplicate/)
  await assert.rejects(tool.execute(submission([{ kind: 'new-task', title: '未知来源', objective: '不得创建', acceptanceCriteria: ['不得创建'], sourceMessageIds: ['m-a', 'm-missing'] }]), { agent: fixture.handle.agent }), /task_action_source_message_invalid/)
  await assert.rejects(tool.execute(submission([{ kind: 'new-task', title: '只有旧来源', objective: '不得创建', acceptanceCriteria: ['不得创建'], sourceMessageIds: ['m-history'] }]), { agent: fixture.handle.agent }), /task_action_current_source_message_required/)
  assert.equal(fixture.tasks.length, 0, '来源映射全量预检失败时不得产生部分副作用')

  await tool.execute(submission([
    { kind: 'new-task', title: '事项A', objective: '完成事项A', acceptanceCriteria: ['A完成'], sourceMessageIds: ['m-history', 'm-a', 'm-b'] },
    { kind: 'new-task', title: '事项B', objective: '完成事项B', acceptanceCriteria: ['B完成'], sourceMessageIds: ['m-history', 'm-b', 'm-c'] },
  ]), { agent: fixture.handle.agent })
  await Promise.all(ingests)

  assert.deepEqual(fixture.tasks.map((task) => task.messageHistory.map((message) => message.messageId)), [
    ['m-history', 'm-a', 'm-b'],
    ['m-history', 'm-b', 'm-c'],
  ])
  assert.deepEqual(fixture.tasks[0].messageHistory.map((message) => message.senderOpenDingTalkId), ['od-history', 'od-a', 'od-b'])
  assert.deepEqual(fixture.tasks[1].messageHistory.map((message) => message.senderOpenDingTalkId), ['od-history', 'od-b', 'od-c'])
  assert.doesNotMatch(fixture.tasks[0].relatedContexts[0], /事项B的验收要求/u)
  assert.doesNotMatch(fixture.tasks[1].relatedContexts[0], /事项A的执行要求/u)
  assert.equal(fixture.tasks.filter((task) => task.messageHistory.some((message) => message.messageId === 'm-b')).length, 2, '同一消息可以关联多个Task')
  fixture.releaseIdle()
  await runtime.close()
})

test('明确@其他同事的消息不能建Task，后续引用并指向Agent后才允许转交', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'directed-other-participants-group' })
  fixture.store.getAgentNames = () => ['小小鹏']
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const original = runtime.ingest({
    groupId: fixture.group.groupId,
    messageId: 'msg624ca5N0Mq3+36twQq+b7A==',
    text: '[图片消息](mediaId=@lQLPJyFx1LlkTRfNBWjNC3qwS5c44-MgXl8Kat4grwTGAA)@李辰 @郑耀彬 只是计算了，没有改信息，为啥要提示这个呢？',
    occurredAt: '2026-09-03T02:01:01.000Z',
    senderName: '向春梅',
  })
  await fixture.waitForSteers(1)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const originalRequestId = decisionRequestId(fixture.steered[0])
  await assert.rejects(tool.execute({ submissions: [{ requestIds: [originalRequestId], decision: {
    actions: [{ kind: 'new-task', title: '误建任务', objective: '排查计算提示', acceptanceCriteria: ['定位原因'], sourceMessageIds: ['msg624ca5N0Mq3+36twQq+b7A=='] }], reply: '',
  } }] }, { agent: fixture.handle.agent }), /task_action_directed_to_other_participants/)
  assert.equal(fixture.tasks.length, 0)

  const transfer = runtime.ingest({
    groupId: fixture.group.groupId,
    messageId: 'm-transfer',
    text: '@小小鹏 看下这个',
    quotedMessage: { messageId: 'msg624ca5N0Mq3+36twQq+b7A==' },
    occurredAt: '2026-09-03T02:02:01.000Z',
    senderName: '向春梅',
  })
  await fixture.waitForSteers(2)
  const transferRequestId = decisionRequestId(fixture.steered[1])
  await tool.execute({ observedRequestIds: [originalRequestId, transferRequestId], submissions: [{ requestIds: [originalRequestId, transferRequestId], decision: {
    actions: [{ kind: 'new-task', title: '排查计算提示', objective: '排查仅计算后出现未保存提示的原因', acceptanceCriteria: ['定位原因'], sourceMessageIds: ['msg624ca5N0Mq3+36twQq+b7A==', 'm-transfer'] }], reply: '',
  } }] }, { agent: fixture.handle.agent })
  await Promise.all([original, transfer])
  assert.equal(fixture.tasks.length, 1)
  assert.deepEqual(fixture.tasks[0].messageHistory.map((message) => message.messageId), ['msg624ca5N0Mq3+36twQq+b7A==', 'm-transfer'])
  const cancelled = await runtime.cancelTask({ taskId: fixture.tasks[0].taskId, reason: '回归用误建任务' })
  assert.equal(cancelled.state, 'completed')
  assert.equal(cancelled.completion, '已取消：回归用误建任务')
  assert.ok(cancelled.archivedAt)
  assert.equal(cancelled.result, undefined)
  fixture.releaseIdle()
  await runtime.close()
})

test('不影响当前回复的请求只观察不消费并在回复提交后继续处理', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'out-of-order-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '仍在分析的事项', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '已经判断完成的独立事项', occurredAt: '2026-08-28T01:00:01Z' })
  let firstSettled = false
  first.then(() => { firstSettled = true }, () => { firstSettled = true })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submitted = await tool.execute({ observedRequestIds: requestIds, submissions: [{ requestIds: [requestIds[1]], decision: { actions: [], reply: '第二项先完成' } }] }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission([requestIds[1]], [requestIds[0]]))
  const secondResult = await second
  assert.equal(secondResult.decision.reply, '第二项先完成')
  assert.equal(firstSettled, false, '未提交的第一项不能阻塞已提交的独立第二项')
  await tool.execute({ submissions: [{ requestIds: [requestIds[0]], decision: { actions: [], reason: '第一项随后完成' } }] }, { agent: fixture.handle.agent })
  const firstResult = await first
  assert.equal(firstResult.decision.reason, '第一项随后完成')
  fixture.releaseIdle()
  await runtime.close()
})

test('单请求含回复时submission自身即完成观察并引用当前入站消息', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'single-reply-reference-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const processing = runtime.ingest({
    groupId: fixture.group.groupId,
    messageId: 'current-message',
    text: '请补充部署Ref',
    senderName: '测试成员',
    senderOpenDingTalkId: 'od-current',
    quotedMessage: { messageId: 'older-agent-message', content: '此前的部署结果' },
    occurredAt: '2026-09-02T07:24:18.880Z',
  })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')

  const submitted = await tool.execute({
    submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '部署Ref如下。' } }],
  }, { agent: fixture.handle.agent })

  assert.deepEqual(submitted, acceptedSubmission([requestId]))
  await processing
  assert.equal(fixture.group.outbox[0].replyToMessageId, 'current-message', '应回复当前群成员消息，而不是它引用的旧消息')
  assert.equal(fixture.group.outbox[0].replyToSenderOpenDingTalkId, 'od-current')
  assert.deepEqual(fixture.group.outbox[0].atOpenDingTalkIds, ['od-current'])
  fixture.releaseIdle()
  await runtime.close()
})

test('回复遗漏其他已Steer请求时返回stale且零副作用，合并新消息后只发送重新生成的回复', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'stale-reply-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '原问题', senderOpenDingTalkId: 'od-first', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '会改变答案的补充', senderOpenDingTalkId: 'od-second', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')

  const stale = await tool.execute({
    submissions: [{ requestIds: [requestIds[0]], decision: { actions: [], reply: '未结合补充的旧回复' } }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(stale, staleSubmission(requestIds, [requestIds[1]]))
  assert.match(tool.output.render({}, stale)[0].text, new RegExp(requestIds[1]))
  assert.deepEqual(fixture.group.messages.map((message) => message.agentDeliveryStatus), ['steered', 'steered'])
  assert.equal(fixture.group.outbox.length, 0)

  const submitted = await tool.execute({
    submissions: [{ requestIds, decision: { actions: [], reply: '结合两条消息重新生成的回复' } }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission(requestIds))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '结合两条消息重新生成的回复')
  assert.equal(secondResult.decision.reply, '结合两条消息重新生成的回复')
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['结合两条消息重新生成的回复'])
  assert.equal(fixture.group.outbox[0].replyToMessageId, 'm2', '合并回复应引用本批最新的有效入站消息')
  assert.equal(fixture.group.outbox[0].replyToSenderOpenDingTalkId, 'od-second')
  assert.deepEqual(fixture.group.outbox[0].atOpenDingTalkIds, ['od-second'])
  fixture.releaseIdle()
  await runtime.close()
})

test('入站消息缺少稳定发送人ID时普通回复不伪造引用参数', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'reply-reference-fallback-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const processing = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'message-without-sender-id', text: '回答一下', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')

  await tool.execute({ submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '安全降级回复' } }] }, { agent: fixture.handle.agent })
  await processing
  assert.equal(fixture.group.outbox[0].replyToMessageId, undefined)
  assert.equal(fixture.group.outbox[0].replyToSenderOpenDingTalkId, undefined)
  assert.equal(fixture.group.outbox[0].atOpenDingTalkIds, undefined)
  fixture.releaseIdle()
  await runtime.close()
})

test('Decision claim到可靠Outbox之间阻止同群新Steer越过回复门禁', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'reply-linearization-group' })
  let markAppendEntered, releaseAppend
  const appendEntered = new Promise((resolve) => { markAppendEntered = resolve })
  const appendGate = new Promise((resolve) => { releaseAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => {
    markAppendEntered()
    await appendGate
    return appendOutbox(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '先回复这一项', occurredAt: '2026-08-28T01:00:00Z' })
  await fixture.waitForSteers(1)
  const firstRequestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  let toolSettled = false
  const submitting = tool.execute({
    observedRequestIds: [firstRequestId],
    submissions: [{ requestIds: [firstRequestId], decision: { actions: [], reply: '第一项可靠回复' } }],
  }, { agent: fixture.handle.agent }).finally(() => { toolSettled = true })
  await appendEntered

  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '回复提交窗口内到达', occurredAt: '2026-08-28T01:00:01Z' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.group.messages.length, 2, '新消息应先持久化')
  assert.equal(fixture.steered.length, 1, '可靠Outbox完成前不得把新消息Steer给模型')
  assert.equal(fixture.group.outbox.length, 0)
  assert.equal(toolSettled, false, '工具成功不得早于可靠Outbox')

  releaseAppend()
  const submitted = await submitting
  await fixture.waitForSteers(2)
  const secondRequestId = decisionRequestId(fixture.steered[1])
  assert.deepEqual(submitted, acceptedSubmission([firstRequestId], [secondRequestId]))
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['第一项可靠回复'])
  await tool.execute({ submissions: [{ requestIds: [secondRequestId], decision: { actions: [], reason: '第二项随后独立处理' } }] }, { agent: fixture.handle.agent })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '第一项可靠回复')
  assert.equal(secondResult.decision.reason, '第二项随后独立处理')
  fixture.releaseIdle()
  await runtime.close()
})

test('Decision可靠Outbox失败会明确失败并释放门禁且不重放Task动作', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'reply-append-failure-group' })
  const appendOutbox = fixture.store.appendOutbox
  let failAppend = true
  fixture.store.appendOutbox = async (value) => {
    if (failAppend) { failAppend = false; throw new Error('outbox_append_failed') }
    return appendOutbox(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '创建任务并回复', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const firstRequestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({
    observedRequestIds: [firstRequestId],
    submissions: [{ requestIds: [firstRequestId], decision: { actions: [{ kind: 'new-task', title: '只执行一次', objective: '验证Outbox失败边界', acceptanceCriteria: ['任务动作只执行一次'], sourceMessageIds: ['m1'] }], reply: '不得假成功' } }],
  }, { agent: fixture.handle.agent })

  await assert.rejects(submission, /outbox_append_failed/)
  await assert.rejects(first, /outbox_append_failed/)
  assert.equal(fixture.group.outbox.length, 0)
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'decision-failed')
  assert.equal(fixture.tasks.length, 1, 'Outbox失败不得自动重放已提交的Task动作')

  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '失败后进入的新消息', occurredAt: '2026-09-02T01:00:01Z' })
  await fixture.waitForSteers(2)
  const secondRequestId = decisionRequestId(fixture.steered[1])
  await tool.execute({ submissions: [{ requestIds: [secondRequestId], decision: { actions: [], reason: '后续消息正常处理' } }] }, { agent: fixture.handle.agent })
  await second
  assert.equal(fixture.tasks.length, 1)
  fixture.releaseIdle()
  await runtime.close()
})

test('显式重试会让无副作用的decision-failed消息重新进入判断且拒绝重试已完成消息', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'decision-retry-group' })
  const createTask = fixture.store.createTask
  let failCreate = true
  fixture.store.createTask = async (value) => {
    if (failCreate) { failCreate = false; throw new Error('task_create_failed') }
    return createTask(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '重新判断这条消息', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const firstRequestId = decisionRequestId(fixture.steered[0])
  const firstSubmission = tool.execute({
    submissions: [{ requestIds: [firstRequestId], decision: { actions: [{ kind: 'new-task', title: '首次创建失败', objective: '触发无副作用的提交失败', acceptanceCriteria: ['不得残留任务'], sourceMessageIds: ['m1'] }], reply: '' } }],
  }, { agent: fixture.handle.agent })
  assert.equal((await firstSubmission).status, 'accepted')
  await assert.rejects(first, /task_create_failed/)
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'decision-failed')
  assert.equal(fixture.tasks.length, 0)

  await new Promise((resolve) => setImmediate(resolve))
  const retried = runtime.retryDecisionFailedMessage({ groupId: fixture.group.groupId, messageId: 'm1' })
  await fixture.waitForSteers(2)
  const retryRequestId = decisionRequestId(fixture.steered[1])
  await tool.execute({ submissions: [{ requestIds: [retryRequestId], decision: { actions: [], reason: '复核后无需执行' } }] }, { agent: fixture.handle.agent })
  const result = await retried
  assert.equal(result.recovered, true)
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'delivered')
  await assert.rejects(runtime.retryDecisionFailedMessage({ groupId: fixture.group.groupId, messageId: 'm1' }), /message_not_retryable:m1/)
  fixture.releaseIdle()
  await runtime.close()
})

test('Runtime重启后把孤立steered收敛为可诊断失败且不自动重放', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'interrupted-decision-group' })
  fixture.group.messages.push(
    { messageId: 'm-interrupted', sequence: 1, text: '重启时正在判断', occurredAt: '2026-09-03T03:23:28.063Z', agentDeliveryStatus: 'steered' },
    { messageId: 'm-delivered', sequence: 2, text: '已经完成', occurredAt: '2026-09-03T03:23:29.063Z', agentDeliveryStatus: 'delivered' },
  )
  fixture.group.nextSequence = 3
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const recovered = await runtime.recoverInterruptedDecisions()
  assert.deepEqual(recovered, [{ groupId: fixture.group.groupId, messageId: 'm-interrupted', status: 'recovered' }])
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'decision-failed')
  assert.equal(fixture.group.messages[0].error, 'resident_restarted_before_decision_settled')
  assert.equal(fixture.group.messages[1].agentDeliveryStatus, 'delivered')
  assert.equal(fixture.steered.length, 0, '启动恢复不得自动重放判断')
  fixture.releaseIdle()
  await runtime.close()
})

test('Outbox已落库后监听器失败不会反向否定Decision提交', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'outbox-listener-failure-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  runtime.onOutboxAppended(async () => { throw new Error('outbox_listener_failed') })
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '监听器失败不影响持久提交', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const [submitted, result] = await Promise.all([
    tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '已可靠落库' } }] }, { agent: fixture.handle.agent }),
    ingest,
  ])
  assert.deepEqual(submitted, acceptedSubmission([requestId]))
  assert.equal(result.decision.reply, '已可靠落库')
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'delivered')
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['已可靠落库'])
  assert.equal(runtime.listRecoveryIssues().some((issue) => issue.kind === 'outbox-listener' && issue.error === 'outbox_listener_failed'), true)
  fixture.releaseIdle()
  await runtime.close()
})

test('缓冲Outbox监听器同步失败会被隔离并记录', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'buffered-outbox-listener-failure-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '先落库后注册监听', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await Promise.all([
    tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '已进入缓冲Outbox' } }] }, { agent: fixture.handle.agent }),
    ingest,
  ])
  assert.doesNotThrow(() => runtime.onOutboxAppended(() => { throw new Error('buffered_listener_failed') }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'delivered')
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['已进入缓冲Outbox'])
  assert.equal(runtime.listRecoveryIssues().some((issue) => issue.kind === 'outbox-listener' && issue.error === 'buffered_listener_failed'), true)
  fixture.releaseIdle()
  await runtime.close()
})

test('消息已被Decision领取后标记steered失败会结算工具并释放门禁', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'steered-write-failure-group' })
  let markSteeredEntered, rejectMarkSteered
  const markEntered = new Promise((resolve) => { markSteeredEntered = resolve })
  const markGate = new Promise((_, reject) => { rejectMarkSteered = reject })
  const markMessageAgentDelivery = fixture.store.markMessageAgentDelivery
  let failSteered = true
  fixture.store.markMessageAgentDelivery = async (value) => {
    if (value.status === 'steered' && failSteered) {
      failSteered = false
      markSteeredEntered()
      await markGate
    }
    return markMessageAgentDelivery(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '标记状态失败', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  await markEntered
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '不得发送' } }] }, { agent: fixture.handle.agent })
  rejectMarkSteered(new Error('mark_steered_failed'))

  await assert.rejects(submission, /mark_steered_failed/)
  await assert.rejects(ingest, /mark_steered_failed/)
  assert.equal(fixture.group.outbox.length, 0)
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'failed')

  const next = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '门禁释放后的消息', occurredAt: '2026-09-02T01:00:01Z' })
  await fixture.waitForSteers(2)
  const nextRequestId = decisionRequestId(fixture.steered[1])
  await tool.execute({ submissions: [{ requestIds: [nextRequestId], decision: { actions: [], reason: '后续请求可正常处理' } }] }, { agent: fixture.handle.agent })
  await next
  fixture.releaseIdle()
  await runtime.close()
})

test('关联复核合并的新消息标记steered失败时不会发送候选回复', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'recheck-steered-write-failure-group' })
  fixture.tasks.push({ taskId: 'task-existing', groupId: fixture.group.groupId, state: 'completed' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'image-message', text: '[图片消息]', occurredAt: '2026-09-02T01:00:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '先进入关联复核', occurredAt: '2026-09-02T01:01:00Z' })
  await fixture.waitForSteers(1)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: [decisionRequestId(fixture.steered[0])], decision: { actions: [], reason: '初次忽略' } }] }, { agent: fixture.handle.agent })
  while (fixture.rechecks.length === 0) await new Promise((resolve) => setImmediate(resolve))

  let markSteeredEntered, rejectMarkSteered
  const markEntered = new Promise((resolve) => { markSteeredEntered = resolve })
  const markGate = new Promise((_, reject) => { rejectMarkSteered = reject })
  const markMessageAgentDelivery = fixture.store.markMessageAgentDelivery
  let failSteered = true
  fixture.store.markMessageAgentDelivery = async (value) => {
    if (value.status === 'steered' && failSteered) {
      failSteered = false
      markSteeredEntered()
      await markGate
    }
    return markMessageAgentDelivery(value)
  }
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '影响复核回复的新补充', occurredAt: '2026-09-02T01:01:01Z' })
  await fixture.waitForSteers(2)
  await markEntered
  const recheckRequestId = decisionRequestId(fixture.rechecks[0])
  const secondRequestId = decisionRequestId(fixture.steered[1])
  const submission = tool.execute({
    observedRequestIds: [secondRequestId],
    submissions: [{ requestIds: [recheckRequestId, secondRequestId], decision: { actions: [], reply: '不得发送的复核候选' } }],
  }, { agent: fixture.handle.agent })
  rejectMarkSteered(new Error('recheck_mark_steered_failed'))

  await assert.rejects(submission, /recheck_mark_steered_failed/)
  await assert.rejects(first, /recheck_mark_steered_failed/)
  await assert.rejects(second, /recheck_mark_steered_failed/)
  assert.equal(fixture.group.outbox.length, 0)
  assert.deepEqual(fixture.group.messages.slice(1).map((message) => message.agentDeliveryStatus), ['decision-failed', 'failed'])
  fixture.releaseIdle()
  await runtime.close()
})

test('关闭Runtime会等待已领取的Decision可靠写入Outbox', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'claimed-close-group' })
  let markAppendEntered, releaseAppend
  const appendEntered = new Promise((resolve) => { markAppendEntered = resolve })
  const appendGate = new Promise((resolve) => { releaseAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => { markAppendEntered(); await appendGate; return appendOutbox(value) }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '关闭窗口', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '尚未落库' } }] }, { agent: fixture.handle.agent })
  await appendEntered

  let closeSettled = false
  const closing = runtime.close().finally(() => { closeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeSettled, false, '关闭过程必须等待已开始的可靠Outbox提交')
  releaseAppend()
  await Promise.all([submission, ingest, closing])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['尚未落库'])
})

test('关闭Runtime会释放回复门禁中的新消息并等待已开始的可靠提交', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'close-admission-group' })
  let markAppendEntered, releaseAppend
  const appendEntered = new Promise((resolve) => { markAppendEntered = resolve })
  const appendGate = new Promise((resolve) => { releaseAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => { markAppendEntered(); await appendGate; return appendOutbox(value) }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '先开始回复', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '关闭前已开始提交' } }] }, { agent: fixture.handle.agent })
  await appendEntered
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '等待门禁的新消息', occurredAt: '2026-09-02T01:00:01Z' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.steered.length, 1)

  let closeSettled = false
  const closing = runtime.close().finally(() => { closeSettled = true })
  await assert.rejects(second, /resident_runtime_closed/)
  assert.equal(closeSettled, false, '关闭仍须等待已经进入可靠Outbox的提交')
  releaseAppend()
  await Promise.all([submission, first, closing])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['关闭前已开始提交'])
})

test('群历史导入等待resident时不占群提交尾链', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'history-reply-group' })
  let releaseResidentIdle
  const residentIdle = new Promise((resolve) => { releaseResidentIdle = resolve })
  let idleWaits = 0
  fixture.handle.agent.whenIdle = async () => { idleWaits += 1; await residentIdle }
  fixture.handle.agent.followup = (message) => {
    fixture.followups.push(message)
    if (message.content[0]?.text?.startsWith('[GROUP_HISTORY_IMPORT]')) fixture.handle.agent.session.events.push({ seq: fixture.handle.agent.session.seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '历史导入并发回复', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const hydrating = runtime.hydrateGroupHistory({ groupId: fixture.group.groupId })
  while (idleWaits < 2) await new Promise((resolve) => setImmediate(resolve))

  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '历史导入期间的可靠回复' } }] }, { agent: fixture.handle.agent })
  const outcome = await Promise.race([submission.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
  releaseResidentIdle()
  await Promise.all([submission, ingest, hydrating])
  await runtime.close()
  assert.equal(outcome, 'settled', '等待resident完成历史导入不能占住回复所需的同群Outbox尾链')
})

test('退订等待resident停稳时不占群提交尾链', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'unsubscribe-reply-group' })
  let releaseResidentIdle
  const residentIdle = new Promise((resolve) => { releaseResidentIdle = resolve })
  let idleWaits = 0
  fixture.handle.agent.whenIdle = async () => { idleWaits += 1; await residentIdle }
  fixture.store.removeGroup = async ({ groupId }) => ({ removed: true, groupId })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '退订并发回复', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const unsubscribing = runtime.unsubscribe({ groupId: fixture.group.groupId })
  while (idleWaits < 2) await new Promise((resolve) => setImmediate(resolve))

  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [], reply: '退订前可靠提交' } }] }, { agent: fixture.handle.agent })
  const outcome = await Promise.race([submission.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
  releaseResidentIdle()
  await Promise.all([submission, ingest, unsubscribing])
  await runtime.close()
  assert.equal(outcome, 'settled', '等待resident停稳不能占住回复所需的同群Outbox尾链')
})

test('无回复Decision返回后退订仍等待其动作提交并在同一Task临界区复核', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'unsubscribe-no-reply-group' })
  let markCreateEntered, releaseCreate
  const createEntered = new Promise((resolve) => { markCreateEntered = resolve })
  const createGate = new Promise((resolve) => { releaseCreate = resolve })
  const createTask = fixture.store.createTask
  fixture.store.createTask = async (value) => { markCreateEntered(); await createGate; return createTask(value) }
  let removeCalls = 0
  fixture.store.removeGroup = async ({ groupId }) => { removeCalls += 1; return { removed: true, groupId } }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '创建任务但无需群回复', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: [requestId], decision: { actions: [{ kind: 'new-task', title: '并发任务', objective: '验证无回复提交', acceptanceCriteria: ['动作提交完成'], sourceMessageIds: ['m1'] }], reply: '' } }] }, { agent: fixture.handle.agent })
  await createEntered
  const unsubscribing = runtime.unsubscribe({ groupId: fixture.group.groupId })
  fixture.releaseIdle()
  await new Promise((resolve) => setImmediate(resolve))
  let unsubscribeSettled = false
  unsubscribing.finally(() => { unsubscribeSettled = true }).catch(() => undefined)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unsubscribeSettled, false, '退订不能只等待无回复工具返回，必须等待动作提交')
  assert.equal(removeCalls, 0)

  releaseCreate()
  await ingest
  await assert.rejects(unsubscribing, /group_has_active_tasks:unsubscribe-no-reply-group/)
  assert.equal(removeCalls, 0, '最终复核发现新Task后不得移除群')
  await runtime.close()
})

test('退订持久化失败时保留resident并允许再次退订清理', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'unsubscribe-remove-failure-group' })
  fixture.handle.agent.whenIdle = async () => undefined
  let disposeCalls = 0
  fixture.handle.dispose = async () => { disposeCalls += 1 }
  let failRemove = true
  fixture.store.removeGroup = async ({ groupId }) => {
    if (failRemove) throw new Error('remove_group_failed')
    return { removed: true, groupId }
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  await assert.rejects(runtime.unsubscribe({ groupId: fixture.group.groupId }), /remove_group_failed/)
  assert.equal(disposeCalls, 0, '群仍在存储中时不得先销毁resident')

  failRemove = false
  await runtime.unsubscribe({ groupId: fixture.group.groupId })
  assert.equal(disposeCalls, 1, '持久化移除成功后应销毁同一resident')
  await runtime.close()
})

test('无回复Decision不要求观察全部pending请求', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'no-reply-observation-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '可忽略事项', occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '仍在处理的事项', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submitted = await tool.execute({
    observedRequestIds: [requestIds[0]],
    submissions: [{ requestIds: [requestIds[0]], decision: { actions: [], reason: '第一项无需回复' } }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission([requestIds[0]], [requestIds[1]]))
  assert.equal((await first).decision.reason, '第一项无需回复')
  assert.equal(fixture.group.outbox.length, 0)
  await tool.execute({ submissions: [{ requestIds: [requestIds[1]], decision: { actions: [], reason: '第二项随后完成' } }] }, { agent: fixture.handle.agent })
  assert.equal((await second).decision.reason, '第二项随后完成')
  fixture.releaseIdle()
  await runtime.close()
})

test('附件缺失转换出的effective reply同样对未提交pending执行观察门禁', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'effective-reply-group' })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '按附件执行', mediaUnavailable: ['附件正文下载失败'], occurredAt: '2026-08-28T01:00:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '另一项', occurredAt: '2026-08-28T01:00:01Z' })
  await fixture.waitForSteers(2)
  const requestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const taskDecision = { actions: [{ kind: 'new-task', title: '处理附件', objective: '按附件执行', acceptanceCriteria: ['附件要求已完成'], sourceMessageIds: ['m1'] }], reply: '' }
  const stale = await tool.execute({
    submissions: [{ requestIds: [requestIds[0]], decision: taskDecision }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(stale, staleSubmission(requestIds, [requestIds[1]]))
  assert.equal(fixture.tasks.length, 0)
  assert.equal(fixture.group.outbox.length, 0)

  await tool.execute({ observedRequestIds: [requestIds[1]], submissions: [{ requestIds: [requestIds[0]], decision: taskDecision }] }, { agent: fixture.handle.agent })
  const firstResult = await first
  assert.match(firstResult.decision.reply, /附件正文下载失败/u)
  assert.equal(fixture.tasks.length, 0)
  assert.equal(fixture.group.messages[1].agentDeliveryStatus, 'steered')
  await tool.execute({ submissions: [{ requestIds: [requestIds[1]], decision: { actions: [], reason: '另一项随后处理' } }] }, { agent: fixture.handle.agent })
  await second
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
  await tool.execute({ observedRequestIds: requestIds, submissions: [
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
  await toolA.execute({ observedRequestIds: [requestA], submissions: [{ requestIds: [requestA], decision: { actions: [], reply: '群A完成' } }] }, { agent: fixture.handles.get('group-a').agent })
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
  while (fixture.rechecks.length === 0) await new Promise((resolve) => setImmediate(resolve))
  assert.match(fixture.rechecks[0].content[0].text, /^\[GROUP_DECISION_RECHECK\]/u)
  assert.equal(fixture.followups.length, 0, '关联复核必须插入当前Turn，不能排队到后续Turn')
  const recheckRequestId = decisionRequestId(fixture.rechecks[0])
  await tool.execute({ submissions: [{ requestIds: [recheckRequestId], decision: { actions: [], reason: '复核后仍无关' } }] }, { agent: fixture.handle.agent })
  const result = await ingest
  assert.equal(result.decision.reason, '复核后仍无关')
  assert.equal(fixture.group.messages.find((message) => message.messageId === 'm1').agentDeliveryStatus, 'delivered')
  fixture.releaseIdle()
  await runtime.close()
})

test('同一Turn的多个关联复核都通过steer获得执行机会后再结算', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'concurrent-recheck-group' })
  fixture.tasks.push({ taskId: 'task-existing', groupId: fixture.group.groupId, state: 'completed' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'image-message', text: '[图片消息]', occurredAt: '2026-09-03T07:26:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '[图片消息]构建失败', occurredAt: '2026-09-03T07:26:52Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '没有接入新代码包上传', occurredAt: '2026-09-03T07:27:11Z' })
  await fixture.waitForSteers(2)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const initialRequestIds = fixture.steered.map(decisionRequestId)
  await tool.execute({ submissions: initialRequestIds.map((requestId) => ({ requestIds: [requestId], decision: { actions: [], reason: '初次忽略' } })) }, { agent: fixture.handle.agent })

  for (let attempt = 0; attempt < 20 && fixture.rechecks.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.rechecks.length, 2)
  assert.equal(fixture.followups.length, 0, '复核不能排入尚未开始的后续Turn')
  const recheckRequestIds = fixture.rechecks.map(decisionRequestId)
  await tool.execute({ submissions: recheckRequestIds.map((requestId) => ({ requestIds: [requestId], decision: { actions: [], reason: '复核后仍无关' } })) }, { agent: fixture.handle.agent })

  const results = await Promise.all([first, second])
  assert.deepEqual(results.map((result) => result.decision.reason), ['复核后仍无关', '复核后仍无关'])
  assert.deepEqual(fixture.group.messages.slice(1).map((message) => message.agentDeliveryStatus), ['delivered', 'delivered'])
  fixture.releaseIdle()
  await runtime.close()
})

test('同群回复门禁不会阻塞其他群的Steer与Decision', async () => {
  const fixture = twoGroupDecisionFixture()
  let markGroupAAppendEntered, releaseGroupAAppend
  const groupAAppendEntered = new Promise((resolve) => { markGroupAAppendEntered = resolve })
  const groupAAppendGate = new Promise((resolve) => { releaseGroupAAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => {
    if (value.groupId === 'group-a') {
      markGroupAAppendEntered()
      await groupAAppendGate
    }
    return appendOutbox(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: 'group-a', messageId: 'm-a', text: '群A回复', occurredAt: '2026-08-28T01:00:00Z' })
  while (fixture.steered.get('group-a').length === 0) await new Promise((resolve) => setImmediate(resolve))
  const requestA = decisionRequestId(fixture.steered.get('group-a')[0])
  const toolA = fixture.registeredTools.get('group-a').find((item) => item.name === 'group_decision_submit')
  const submittingA = toolA.execute({ observedRequestIds: [requestA], submissions: [{ requestIds: [requestA], decision: { actions: [], reply: '群A可靠回复' } }] }, { agent: fixture.handles.get('group-a').agent })
  await groupAAppendEntered

  const second = runtime.ingest({ groupId: 'group-b', messageId: 'm-b', text: '群B独立事项', occurredAt: '2026-08-28T01:00:01Z' })
  while (fixture.steered.get('group-b').length === 0) await new Promise((resolve) => setImmediate(resolve))
  const requestB = decisionRequestId(fixture.steered.get('group-b')[0])
  const toolB = fixture.registeredTools.get('group-b').find((item) => item.name === 'group_decision_submit')
  await toolB.execute({ submissions: [{ requestIds: [requestB], decision: { actions: [], reason: '群B不受群A门禁影响' } }] }, { agent: fixture.handles.get('group-b').agent })
  assert.equal((await second).decision.reason, '群B不受群A门禁影响')
  assert.equal(fixture.groups.get('group-a').outbox.length, 0)

  releaseGroupAAppend()
  await submittingA
  assert.equal((await first).decision.reply, '群A可靠回复')
  assert.deepEqual(fixture.groups.get('group-a').outbox.map((item) => item.text), ['群A可靠回复'])
  await runtime.close()
})

test('关联复核可合并影响回复的新Steer并由外层Outbox统一提交', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'recheck-combined-group' })
  // 真实持久 Store 返回新快照；可变测试对象会掩盖跨复核等待的过期读取。
  fixture.store.getGroup = () => structuredClone(fixture.group)
  fixture.tasks.push({ taskId: 'task-existing', groupId: fixture.group.groupId, state: 'completed' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'image-message', text: '[图片消息]', occurredAt: '2026-08-28T01:00:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '图片补充说明', occurredAt: '2026-08-28T01:01:00Z' })
  await fixture.waitForSteers(1)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: [decisionRequestId(fixture.steered[0])], decision: { actions: [], reason: '先进入关联复核' } }] }, { agent: fixture.handle.agent })
  while (fixture.rechecks.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const recheckRequestId = decisionRequestId(fixture.rechecks[0])

  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '这条补充会改变复核回复', occurredAt: '2026-08-28T01:01:01Z' })
  await fixture.waitForSteers(2)
  const secondRequestId = decisionRequestId(fixture.steered[1])
  const submitted = await tool.execute({
    observedRequestIds: [secondRequestId],
    submissions: [{ requestIds: [recheckRequestId, secondRequestId], decision: { actions: [{ kind: 'new-task', title: '复核合并任务', objective: '结合图片说明及新补充', acceptanceCriteria: ['包含两条来源'], sourceMessageIds: ['m1', 'm2'] }], reply: '已结合复核期间的新补充。' } }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission([recheckRequestId, secondRequestId]))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.decision.reply, '已结合复核期间的新补充。')
  assert.equal(secondResult.decisionOwnerRequestId, recheckRequestId)
  assert.deepEqual(fixture.group.messages.slice(1).map((message) => message.agentDeliveryStatus), ['delivered', 'delivered'])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['已结合复核期间的新补充。'])
  assert.equal(fixture.tasks.length, 2)
  assert.deepEqual(fixture.tasks[1].messageHistory.map((item) => item.messageId), ['m1', 'm2'])
  fixture.releaseIdle()
  await runtime.close()
})

test('关联复核继承shared来源附件异常且不能绕过回复观察门禁', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'recheck-effective-reply-group' })
  fixture.tasks.push({ taskId: 'task-existing', groupId: fixture.group.groupId, state: 'completed' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'image-message', text: '[图片消息]', occurredAt: '2026-08-28T01:00:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const first = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '主体说明', occurredAt: '2026-08-28T01:01:00Z' })
  const second = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm2', text: '附件补充', mediaUnavailable: ['共享附件无法读取'], occurredAt: '2026-08-28T01:01:01Z' })
  await fixture.waitForSteers(2)
  const initialRequestIds = fixture.steered.map(decisionRequestId)
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  await tool.execute({ submissions: [{ requestIds: initialRequestIds, decision: { actions: [], reason: '先复核共享消息' } }] }, { agent: fixture.handle.agent })
  while (fixture.rechecks.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const recheckRequestId = decisionRequestId(fixture.rechecks[0])
  const third = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm3', text: '无关后续', occurredAt: '2026-08-28T01:01:02Z' })
  await fixture.waitForSteers(3)
  const thirdRequestId = decisionRequestId(fixture.steered[2])
  const recheckDecision = { actions: [{ kind: 'new-task', title: '处理共享附件', objective: '按共享附件处理', acceptanceCriteria: ['附件要求已核验'], sourceMessageIds: ['m1', 'm2'] }], reply: '' }

  const stale = await tool.execute({
    observedRequestIds: [],
    submissions: [{ requestIds: [recheckRequestId], decision: recheckDecision }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(stale, staleSubmission([thirdRequestId], [thirdRequestId]))
  assert.equal(fixture.group.outbox.length, 0)
  assert.equal(fixture.tasks.length, 1, '只有预置任务，复核动作尚未执行')

  const submitted = await tool.execute({
    observedRequestIds: [thirdRequestId],
    submissions: [{ requestIds: [recheckRequestId], decision: recheckDecision }],
  }, { agent: fixture.handle.agent })
  assert.deepEqual(submitted, acceptedSubmission([recheckRequestId], [thirdRequestId]))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.match(firstResult.decision.reply, /共享附件无法读取/u)
  assert.match(secondResult.decision.reply, /共享附件无法读取/u)
  assert.equal(fixture.tasks.length, 1, '附件拦截不得创建新任务')
  await tool.execute({ submissions: [{ requestIds: [thirdRequestId], decision: { actions: [], reason: '无关消息随后处理' } }] }, { agent: fixture.handle.agent })
  await third
  fixture.releaseIdle()
  await runtime.close()
})

test('Task通知由模型从完整历史选择承接消息与多位参与人', async () => {
  const messageHistory = [
    { messageId: 'm-origin', text: '请排查草稿提交失败', senderName: '提出人', senderOpenDingTalkId: 'od-owner', occurredAt: '2026-09-02T01:00:00Z', runSequence: 1, associatedAt: '2026-09-02T01:00:00Z' },
    { messageId: 'm-domain', text: '数据集关联由我确认', senderName: '业务确认人', senderOpenDingTalkId: 'od-domain', occurredAt: '2026-09-02T01:00:01Z', runSequence: 1, associatedAt: '2026-09-02T01:00:01Z' },
    { messageId: 'm-latest', text: '我只补充了日志位置', senderName: '最新补充人', senderOpenDingTalkId: 'od-latest', occurredAt: '2026-09-02T01:00:02Z', runSequence: 1, associatedAt: '2026-09-02T01:00:02Z' },
  ]
  const fixture = taskReplyRuntimeFixture({ messageHistory })
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const coordinationPrompt = fixture.followups[0].content[0].text
  const requestId = coordinationPrompt.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')

  assert.match(coordinationPrompt, /任务消息时间线：\[\{"messageId":"m-origin"[\s\S]*"messageId":"m-domain"[\s\S]*"messageId":"m-latest"/u)
  assert.match(coordinationPrompt, /不得机械选择最后一条消息或只通知最后触发人/u)
  await assert.rejects(replyTool.execute({ requestId, observedRequestIds: [], reply: '错误目标', replyToMessageId: 'm-outside', atOpenDingTalkIds: ['od-owner'] }, { agent: fixture.agent }), /group_reply_target_not_in_task_history/)
  await assert.rejects(replyTool.execute({ requestId, observedRequestIds: [], reply: '错误参与人', replyToMessageId: 'm-origin', atOpenDingTalkIds: ['od-outside'] }, { agent: fixture.agent }), /group_reply_recipient_not_in_task_history/)

  await Promise.all([
    replyTool.execute({ requestId, observedRequestIds: [], reply: '@提出人 @业务确认人 已完成并核验。', replyToMessageId: 'm-origin', atOpenDingTalkIds: ['od-owner', 'od-domain'] }, { agent: fixture.agent }),
    repairing,
  ])
  assert.equal(fixture.group.outbox[0].replyToMessageId, 'm-origin', '模型可选择历史承接消息，不强制最新消息')
  assert.equal(fixture.group.outbox[0].replyToSenderOpenDingTalkId, 'od-owner')
  assert.deepEqual(fixture.group.outbox[0].atOpenDingTalkIds, ['od-owner', 'od-domain'])
  assert.equal(fixture.group.outbox[0].text, '已完成并核验。', '正文中的手写@由结构化通知替代')
  await runtime.close()
})

test('Task通知在新Steer到达后拒绝旧候选并只可靠提交重生成回复', async () => {
  const fixture = taskReplyRuntimeFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  let repairSettled = false
  const repairing = runtime.reconcileCompletedNotifications().finally(() => { repairSettled = true })
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const coordinationPrompt = fixture.followups[0].content[0].text
  const replyRequestId = coordinationPrompt.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  const decisionTool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')

  fixture.agent.session.events.push({ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧普通文本候选' }] } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(repairSettled, false, '普通assistant文本不能提交Task通知')
  assert.equal(fixture.group.outbox.length, 0)

  const incoming = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'new-message', text: '会影响通知的新消息', occurredAt: '2026-09-02T01:00:00Z' })
  while (fixture.steered.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const incomingRequestId = decisionRequestId(fixture.steered[0])
  const stale = await replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '未结合新消息的旧通知' }, { agent: fixture.agent })
  assert.deepEqual(stale, staleSubmission([incomingRequestId], [incomingRequestId]))
  assert.match(replyTool.output.render({}, stale)[0].text, new RegExp(incomingRequestId))
  assert.equal(fixture.group.outbox.length, 0)

  const [submitted, repaired] = await Promise.all([
    replyTool.execute({ requestId: replyRequestId, observedRequestIds: [incomingRequestId], reply: '结合新消息重新生成的最终通知' }, { agent: fixture.agent }),
    repairing,
  ])
  assert.deepEqual(submitted, acceptedSubmission([replyRequestId], [incomingRequestId]))
  assert.deepEqual(repaired, [{ taskId: fixture.getTask().taskId, sourceMessageId: `task-result:${fixture.getTask().taskId}:completed:1` }])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['结合新消息重新生成的最终通知'])
  assert.equal(fixture.group.messages[0].agentDeliveryStatus, 'steered', '已审阅的新消息仍应保留给自己的Decision处理')

  await decisionTool.execute({ submissions: [{ requestIds: [incomingRequestId], decision: { actions: [], reason: '通知发出后单独处理' } }] }, { agent: fixture.agent })
  assert.equal((await incoming).decision.reason, '通知发出后单独处理')
  await runtime.close()
})

test('Task通知生成不占用Task尾链且新Steer可先完成任务动作', async () => {
  const fixture = taskReplyRuntimeFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  const decisionTool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')

  const incoming = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'reopen-message', text: '补充后继续处理', occurredAt: '2026-09-02T01:00:00Z' })
  while (fixture.steered.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const incomingRequestId = decisionRequestId(fixture.steered[0])
  const decisionSubmission = decisionTool.execute({
    observedRequestIds: [incomingRequestId],
    submissions: [{ requestIds: [incomingRequestId], decision: { actions: [{ kind: 'task-reopen', taskId: fixture.getTask().taskId, context: '结合补充继续处理', sourceMessageIds: ['reopen-message'] }], reply: '已结合补充继续处理。' } }],
  }, { agent: fixture.agent })
  const outcome = await Promise.race([decisionSubmission.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
  if (outcome === 'blocked') {
    await replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '用于解除失败用例资源的通知' }, { agent: fixture.agent })
    await Promise.all([decisionSubmission, repairing, incoming])
    await runtime.close()
  }
  assert.equal(outcome, 'settled', '通知生成期间不得持有Task尾链阻塞消息动作，否则resident会等待Decision工具而无法提交通知')

  assert.equal((await incoming).task.state, 'queued')
  await replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '结合已处理补充生成的任务通知' }, { agent: fixture.agent })
  await repairing
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['已结合补充继续处理。', '结合已处理补充生成的任务通知'])
  await runtime.close()
})

test('Task通知到可靠Outbox之间同样阻止新Steer越过门禁', async () => {
  const fixture = taskReplyRuntimeFixture()
  let markAppendEntered, releaseAppend
  const appendEntered = new Promise((resolve) => { markAppendEntered = resolve })
  const appendGate = new Promise((resolve) => { releaseAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => { markAppendEntered(); await appendGate; return appendOutbox(value) }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  const decisionTool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '任务可靠通知' }, { agent: fixture.agent })
  await appendEntered

  const incoming = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'during-task-reply', text: '通知提交窗口的新消息', occurredAt: '2026-09-02T01:00:00Z' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.group.messages.length, 1, '新消息应先持久化')
  assert.equal(fixture.steered.length, 0, 'Task通知可靠落库前不得插入新Steer')

  releaseAppend()
  await Promise.all([submission, repairing])
  while (fixture.steered.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const incomingRequestId = decisionRequestId(fixture.steered[0])
  await decisionTool.execute({ submissions: [{ requestIds: [incomingRequestId], decision: { actions: [], reason: '通知后处理' } }] }, { agent: fixture.agent })
  await incoming
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['任务可靠通知'])
  await runtime.close()
})

test('首次完成通知Outbox失败后可按稳定结果键补发', async () => {
  const fixture = taskReplyRuntimeFixture()
  delete fixture.getTask().lastCompletedResult
  delete fixture.getTask().completionSequence
  const neverIdle = new Promise(() => undefined)
  let idleCalls = 0
  fixture.agent.whenIdle = async () => { idleCalls += 1; if (idleCalls % 2 === 0) await neverIdle }
  const appendOutbox = fixture.store.appendOutbox
  let failAppend = true
  fixture.store.appendOutbox = async (value) => {
    if (failAppend) { failAppend = false; throw new Error('task_outbox_append_failed') }
    return appendOutbox(value)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const firstRepair = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  const firstRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const firstSubmission = replyTool.execute({ requestId: firstRequestId, observedRequestIds: [], reply: '首次失败通知' }, { agent: fixture.agent })
  await assert.rejects(firstSubmission, /task_outbox_append_failed/)
  await assert.rejects(firstRepair, /task_outbox_append_failed/)
  assert.equal(fixture.group.outbox.length, 0)

  const secondRepair = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length < 2) await new Promise((resolve) => setImmediate(resolve))
  const secondRequestId = fixture.followups[1].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  await Promise.all([
    replyTool.execute({ requestId: secondRequestId, observedRequestIds: [], reply: '首次完成补发成功' }, { agent: fixture.agent }),
    secondRepair,
  ])
  assert.equal(fixture.group.outbox.length, 1)
  assert.equal(fixture.group.outbox[0].sourceMessageId, `task-result:${fixture.getTask().taskId}:completed`)
  assert.equal(fixture.group.outbox[0].text, '首次完成补发成功')
  await runtime.close()
})

test('完成通知补发跳过退订群并隔离异常resident且不饿死有效群', async () => {
  const fixture = taskReplyRuntimeFixture()
  const validTask = fixture.getTask()
  const orphanTask = { ...validTask, taskId: 'task-orphan', groupId: 'removed-group', completionSequence: 1 }
  const brokenGroup = { groupId: 'broken-group', residentSessionId: 'session-broken', residentAgentPreset: 'standard', nextSequence: 1, messages: [], outbox: [] }
  const brokenTask = { ...validTask, taskId: 'task-broken', groupId: brokenGroup.groupId, completionSequence: 1 }
  fixture.store.listGroups = () => [brokenGroup, fixture.group]
  fixture.store.getGroup = (groupId) => groupId === brokenGroup.groupId ? brokenGroup : groupId === fixture.group.groupId ? fixture.group : undefined
  fixture.store.listTasks = () => [orphanTask, brokenTask, validTask]
  const resumeResident = fixture.ctx.agents.resume
  fixture.ctx.agents.resume = async (options) => {
    if (options.resumeSessionId === brokenGroup.residentSessionId) throw new Error('broken_resident_resume')
    return resumeResident(options)
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  await replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '有效群仍完成补发' }, { agent: fixture.agent })
  await assert.rejects(repairing, /resident_not_active:broken-group/)
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['有效群仍完成补发'])
  assert.equal(brokenGroup.outbox.length, 0)
  assert.equal(runtime.listRecoveryIssues().some((issue) => issue.kind === 'task-notification-reconcile' && issue.taskId === brokenTask.taskId), true)
  await runtime.close()
})

test('关闭Runtime会拒绝尚未提交的Task通知请求而不悬挂', async () => {
  const fixture = taskReplyRuntimeFixture()
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))

  await runtime.close()
  await assert.rejects(repairing, /resident_runtime_closed/)
})

test('关闭Runtime会等待已领取的Task通知可靠写入Outbox', async () => {
  const fixture = taskReplyRuntimeFixture()
  let markAppendEntered, releaseAppend
  const appendEntered = new Promise((resolve) => { markAppendEntered = resolve })
  const appendGate = new Promise((resolve) => { releaseAppend = resolve })
  const appendOutbox = fixture.store.appendOutbox
  fixture.store.appendOutbox = async (value) => { markAppendEntered(); await appendGate; return appendOutbox(value) }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  const submission = replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '关闭前已领取的任务通知' }, { agent: fixture.agent })
  await appendEntered

  let closeSettled = false
  const closing = runtime.close().finally(() => { closeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeSettled, false, '关闭过程必须等待已领取Task通知的可靠Outbox提交')
  releaseAppend()
  await Promise.all([submission, repairing, closing])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['关闭前已领取的任务通知'])
})

test('Task通知尚在等待resident空闲时关闭Runtime不会在关闭后创建回复请求', async () => {
  const fixture = taskReplyRuntimeFixture()
  let markIdleEntered, releaseIdle
  const idleEntered = new Promise((resolve) => { markIdleEntered = resolve })
  const idleGate = new Promise((resolve) => { releaseIdle = resolve })
  fixture.agent.whenIdle = async () => { markIdleEntered(); await idleGate }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 0, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  await idleEntered
  let closeSettled = false
  const closing = runtime.close().finally(() => { closeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeSettled, false, '关闭必须等待已登记的Resident操作退出')

  releaseIdle()
  await assert.rejects(repairing, /resident_runtime_closed/)
  await closing
  assert.equal(fixture.followups.length, 0)
  assert.equal(fixture.group.outbox.length, 0)
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
  runtime.setCurrentDwsProfile("corp'user")
  const decisionProtocol = promptSections.find((section) => section.name === 'dingtalk-group-decision-protocol')?.text()
  assert.match(decisionProtocol, /加载 `dingtalk-chat` Skill/u)
  assert.match(decisionProtocol, /dws chat \+messages-mget --msg-ids '<消息ID>' --profile 'corp''user' --format json/u)
  assert.match(decisionProtocol, /`complete`、`failedCount`、`failures`、`foundCount` 和 `notFoundMessageIds`/u)
  assert.match(decisionProtocol, /仍含 `quotedMessage\.messageId`，继续按该 ID 查询/u)
  assert.match(decisionProtocol, /不得向群成员回复“请补原问题、正文或截图”/u)
  assert.match(decisionProtocol, /不得调用 group_decision_submit[\s\S]*decision-failed/u)
  assert.deepEqual(toolRestrictions, [{ deny: ['get_goal', 'create_goal', 'update_goal'] }])
  assert.deepEqual(promptSections.find((section) => section.name === 'tool:goal'), { name: 'tool:goal', order: 114, text: '' })
  assert.deepEqual(registeredTools.map((tool) => tool.name), ['group_decision_submit', 'group_reply_submit', 'group_task_create', 'group_task_context_append', 'group_task_reopen', 'group_task_list'])
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

test('Agent工作区切换等待resident时不占Task尾链并在提交前复核新任务', { timeout: 3_000 }, async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'config-reply-group' })
  let releaseResidentIdle
  const residentIdle = new Promise((resolve) => { releaseResidentIdle = resolve })
  let idleWaits = 0
  fixture.handle.agent.whenIdle = async () => { idleWaits += 1; await residentIdle }
  fixture.ctx.agents.create = async (options) => {
    const session = { id: options.sessionId, seq: 0, events: [...(options.seed ?? [])] }
    const agent = { session, status: 'idle', whenIdle: async () => undefined, steer: () => undefined, followup: () => undefined }
    await options.setup({ on: () => () => undefined, tools: { register: () => undefined, restrict: () => undefined }, systemPrompt: { section: () => undefined } })
    return { agent, dispose: async () => undefined }
  }
  fixture.store.getAgentWorkspaceDir = () => fixture.store.workspaceDir
  fixture.store.setAgentWorkspaceDir = async (value) => { fixture.store.workspaceDir = value }
  fixture.store.updateGroup = async (value) => { Object.assign(fixture.group, value); return fixture.group }
  fixture.store.createTask = async (value) => {
    const task = { ...value, taskId: `task-${fixture.tasks.length + 1}`, childSessionId: `session-task-${fixture.tasks.length + 1}`, state: 'running' }
    fixture.tasks.push(task)
    return { created: true, task }
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 1, supervisorIntervalMs: 0 }))
  const ingest = runtime.ingest({ groupId: fixture.group.groupId, messageId: 'm1', text: '配置切换期间创建任务', occurredAt: '2026-09-02T01:00:00Z' })
  await fixture.waitForSteers(1)
  const configuring = runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  const idleOutcome = await Promise.race([
    (async () => { while (idleWaits < 2) await new Promise((resolve) => setImmediate(resolve)); return 'ready' })(),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
  ])
  if (idleOutcome === 'timed-out') {
    releaseResidentIdle()
    await configuring
    await ingest.catch(() => undefined)
    await runtime.close()
  }
  assert.equal(idleOutcome, 'ready', `预期两个 resident 空闲等待，实际 ${idleWaits}`)

  const requestId = decisionRequestId(fixture.steered[0])
  const tool = fixture.registeredTools.find((item) => item.name === 'group_decision_submit')
  const submission = tool.execute({ observedRequestIds: [requestId], submissions: [{ requestIds: [requestId], decision: { actions: [{ kind: 'new-task', title: '配置并发任务', objective: '验证配置切换并发', acceptanceCriteria: ['并发路径已验证'], sourceMessageIds: ['m1'] }], reply: '已创建并发任务。' } }] }, { agent: fixture.handle.agent })
  const outcome = await Promise.race([submission.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
  releaseResidentIdle()
  await Promise.all([submission, ingest])
  await assert.rejects(configuring, /agent_config_has_active_tasks/)
  await runtime.close()
  assert.equal(outcome, 'settled', '配置切换等待resident期间不得持有新消息任务动作所需的Task尾链')
  assert.equal(fixture.store.workspaceDir, agentWorkspace, '提交阶段发现新任务后不得切换工作区')
})

test('工作区切换等待尚未登记pending的Task通知完成后再替换resident', async () => {
  const fixture = taskReplyRuntimeFixture()
  let markFirstIdleEntered, releaseFirstIdle
  const firstIdleEntered = new Promise((resolve) => { markFirstIdleEntered = resolve })
  const firstIdleGate = new Promise((resolve) => { releaseFirstIdle = resolve })
  const notificationTurn = new Promise(() => undefined)
  let idleCalls = 0
  fixture.agent.whenIdle = async () => {
    idleCalls += 1
    if (idleCalls === 1) { markFirstIdleEntered(); await firstIdleGate }
    else if (idleCalls === 2) await notificationTurn
  }
  let replacementCreates = 0
  fixture.ctx.agents.create = async (options) => {
    replacementCreates += 1
    const session = { id: options.sessionId, seq: 0, events: [...(options.seed ?? [])] }
    const agent = { session, status: 'idle', whenIdle: async () => undefined, steer: () => undefined, followup: () => undefined }
    await options.setup({ on: () => () => undefined, tools: { register: () => undefined, restrict: () => undefined }, systemPrompt: { section: () => undefined } })
    return { agent, dispose: async () => undefined }
  }
  fixture.store.getAgentWorkspaceDir = () => fixture.store.workspaceDir
  fixture.store.setAgentWorkspaceDir = async (value) => { fixture.store.workspaceDir = value }
  fixture.store.updateGroup = async (value) => { Object.assign(fixture.group, value); return fixture.group }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 1, supervisorIntervalMs: 0 }))
  const repairing = runtime.reconcileCompletedNotifications()
  await firstIdleEntered
  const configuring = runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(replacementCreates, 0, '通知进入pending之前也必须计入Resident生命周期')

  releaseFirstIdle()
  while (fixture.followups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const replyRequestId = fixture.followups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = fixture.registeredTools.find((item) => item.name === 'group_reply_submit')
  await Promise.all([
    replyTool.execute({ requestId: replyRequestId, observedRequestIds: [], reply: '切换前可靠完成通知' }, { agent: fixture.agent }),
    repairing,
  ])
  await configuring
  assert.equal(replacementCreates, 1)
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['切换前可靠完成通知'])
  assert.equal(fixture.store.workspaceDir, replacementWorkspace)
  await runtime.close()
})

test('工作区切换等待历史导入完成并把完整事件作为新resident seed', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'history-config-group' })
  fixture.group.messages.push({ groupId: fixture.group.groupId, messageId: 'history-message', text: '历史事实', occurredAt: '2026-09-02T01:00:00Z', sequence: 1, agentDeliveryStatus: 'delivered' })
  fixture.group.nextSequence = 2
  let markIdleEntered, releaseIdle
  const idleEntered = new Promise((resolve) => { markIdleEntered = resolve })
  const idleGate = new Promise((resolve) => { releaseIdle = resolve })
  let idleCalls = 0
  fixture.handle.agent.whenIdle = async () => {
    idleCalls += 1
    if (idleCalls === 1) { markIdleEntered(); await idleGate }
  }
  fixture.handle.agent.followup = (message) => {
    fixture.followups.push(message)
    if (message.content[0]?.text?.startsWith('[GROUP_HISTORY_IMPORT]')) fixture.handle.agent.session.events.push({ seq: fixture.handle.agent.session.seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  let replacementSeed
  fixture.ctx.agents.create = async (options) => {
    replacementSeed = [...(options.seed ?? [])]
    const session = { id: options.sessionId, seq: replacementSeed.length, events: [...replacementSeed] }
    const agent = { session, status: 'idle', whenIdle: async () => undefined, steer: () => undefined, followup: () => undefined }
    await options.setup({ on: () => () => undefined, tools: { register: () => undefined, restrict: () => undefined }, systemPrompt: { section: () => undefined } })
    return { agent, dispose: async () => undefined }
  }
  fixture.store.getAgentWorkspaceDir = () => fixture.store.workspaceDir
  fixture.store.setAgentWorkspaceDir = async (value) => { fixture.store.workspaceDir = value }
  fixture.store.updateGroup = async (value) => { Object.assign(fixture.group, value); return fixture.group }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 1, supervisorIntervalMs: 0 }))
  const hydrating = runtime.hydrateGroupHistory({ groupId: fixture.group.groupId })
  await idleEntered
  const configuring = runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(replacementSeed, undefined, '历史导入完成前不得截取旧Resident seed')

  releaseIdle()
  await Promise.all([hydrating, configuring])
  assert.equal(fixture.followups.length, 1)
  assert.equal(replacementSeed.some((event) => event.type === 'turn/end' && event.data?.reason?.kind === 'completed'), true)
  await runtime.close()
})

test('工作区切换屏障建立后到达的Task通知改用新resident', async () => {
  const fixture = taskReplyRuntimeFixture()
  let markOldIdleEntered, releaseOldIdle
  const oldIdleEntered = new Promise((resolve) => { markOldIdleEntered = resolve })
  const oldIdleGate = new Promise((resolve) => { releaseOldIdle = resolve })
  fixture.agent.whenIdle = async () => { markOldIdleEntered(); await oldIdleGate }
  const replacementTools = [], replacementFollowups = []
  const replacementNeverIdle = new Promise(() => undefined)
  let replacementAgent, replacementIdleCalls = 0
  fixture.ctx.agents.create = async (options) => {
    const session = { id: options.sessionId, seq: 0, events: [...(options.seed ?? [])] }
    replacementAgent = {
      session, status: 'running', steer: () => undefined,
      followup: (message) => replacementFollowups.push(message),
      async whenIdle() { replacementIdleCalls += 1; if (replacementIdleCalls > 1) await replacementNeverIdle },
    }
    await options.setup({ on: () => () => undefined, tools: { register: (tool) => replacementTools.push(tool), restrict: () => undefined }, systemPrompt: { section: () => undefined } })
    return { agent: replacementAgent, dispose: async () => undefined }
  }
  fixture.store.getAgentWorkspaceDir = () => fixture.store.workspaceDir
  fixture.store.setAgentWorkspaceDir = async (value) => { fixture.store.workspaceDir = value }
  fixture.store.updateGroup = async (value) => { Object.assign(fixture.group, value); return fixture.group }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 1, supervisorIntervalMs: 0 }))
  const configuring = runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await oldIdleEntered

  const repairing = runtime.reconcileCompletedNotifications()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.followups.length, 0, 'transition期间到达的通知不得继续投递旧Resident')
  assert.equal(replacementFollowups.length, 0)

  releaseOldIdle()
  await configuring
  while (replacementFollowups.length === 0) await new Promise((resolve) => setImmediate(resolve))
  const requestId = replacementFollowups[0].content[0].text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
  const replyTool = replacementTools.find((item) => item.name === 'group_reply_submit')
  await Promise.all([
    replyTool.execute({ requestId, observedRequestIds: [], reply: '由新Resident生成的完成通知' }, { agent: replacementAgent }),
    repairing,
  ])
  assert.deepEqual(fixture.group.outbox.map((item) => item.text), ['由新Resident生成的完成通知'])
  await runtime.close()
})

test('退订屏障建立后到达的历史导入不会继续操作旧resident', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'unsubscribe-history-group' })
  let subscribed = true
  fixture.store.getGroup = (groupId) => subscribed && groupId === fixture.group.groupId ? fixture.group : undefined
  fixture.store.listGroups = () => subscribed ? [fixture.group] : []
  fixture.store.removeGroup = async ({ groupId }) => {
    assert.equal(groupId, fixture.group.groupId)
    subscribed = false
    return fixture.group
  }
  let markUnsubscribeIdleEntered, releaseUnsubscribeIdle
  const unsubscribeIdleEntered = new Promise((resolve) => { markUnsubscribeIdleEntered = resolve })
  const unsubscribeIdleGate = new Promise((resolve) => { releaseUnsubscribeIdle = resolve })
  let idleCalls = 0
  fixture.handle.agent.whenIdle = async () => {
    idleCalls += 1
    if (idleCalls === 1) { markUnsubscribeIdleEntered(); await unsubscribeIdleGate }
  }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ supervisorIntervalMs: 0 }))
  const unsubscribing = runtime.unsubscribe({ groupId: fixture.group.groupId })
  await unsubscribeIdleEntered

  const hydrating = runtime.hydrateGroupHistory({ groupId: fixture.group.groupId })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(idleCalls, 1, 'transition期间到达的历史导入不得进入旧Resident')
  assert.equal(fixture.followups.length, 0)

  releaseUnsubscribeIdle()
  await unsubscribing
  await assert.rejects(hydrating, /group_not_subscribed/)
  assert.equal(fixture.followups.length, 0)
  await runtime.close()
})

test('关闭Runtime与进行中的工作区切换按生命周期串行收口', async () => {
  const fixture = decisionRuntimeFixture({ groupId: 'config-close-group' })
  fixture.handle.agent.whenIdle = async () => undefined
  let oldDisposeCalls = 0
  fixture.handle.dispose = async () => { oldDisposeCalls += 1 }
  let markCreateEntered, releaseCreate
  const createEntered = new Promise((resolve) => { markCreateEntered = resolve })
  const createGate = new Promise((resolve) => { releaseCreate = resolve })
  let replacementDisposeCalls = 0
  fixture.ctx.agents.create = async (options) => {
    markCreateEntered()
    await createGate
    const session = { id: options.sessionId, seq: 0, events: [...(options.seed ?? [])] }
    const agent = { session, status: 'idle', whenIdle: async () => undefined, steer: () => undefined, followup: () => undefined }
    await options.setup({ on: () => () => undefined, tools: { register: () => undefined, restrict: () => undefined }, systemPrompt: { section: () => undefined } })
    return { agent, dispose: async () => { replacementDisposeCalls += 1 } }
  }
  fixture.store.getAgentWorkspaceDir = () => fixture.store.workspaceDir
  fixture.store.setAgentWorkspaceDir = async (value) => { fixture.store.workspaceDir = value }
  fixture.store.updateGroup = async (value) => { Object.assign(fixture.group, value); return fixture.group }
  let storeClosed = false
  fixture.store.close = async () => { storeClosed = true }
  const runtime = await openResidentRuntime(fixture.ctx, fixture.store, agentWorkspace, runtimeOptions({ maxConcurrentTasks: 1, supervisorIntervalMs: 0 }))
  const configuring = runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await createEntered
  const closing = runtime.close()
  releaseCreate()
  await Promise.all([configuring, closing])

  assert.equal(storeClosed, true)
  assert.equal(oldDisposeCalls, 1, '配置提交后应释放旧Resident')
  assert.equal(replacementDisposeCalls, 1, '关闭应等待配置提交并释放新Resident')
  await assert.rejects(runtime.updateAgentConfig({ workspaceDir: agentWorkspace }), /resident_runtime_closed/)
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
  const groups = new Map([['group-a', {
    groupId: 'group-a', responsibility: 'coordinate', residentSessionId: 'session-parent', residentAgentPreset: 'standard-convergent', nextSequence: 4, outbox: [],
    messages: [
      { messageId: 'm1', sequence: 1, text: '初始任务消息', occurredAt: '2026-08-25T01:00:00Z', senderName: '初始提出人', senderOpenDingTalkId: 'od-initial' },
      { messageId: 'm2', sequence: 2, text: '第二个任务消息', occurredAt: '2026-08-25T01:00:01Z', senderName: '第二提出人', senderOpenDingTalkId: 'od-second' },
      { messageId: 'm3', sequence: 3, text: '第三个任务消息', occurredAt: '2026-08-25T01:00:02Z', senderName: '第三提出人', senderOpenDingTalkId: 'od-third' },
    ],
  }]])
  const tasks = []
  const creates = [], createMetas = [], followups = [], steers = [], approvalResumeOrder = [], disposed = [], activities = [], alerts = [], goals = new Map(), agents = new Map(), leafTools = [], leafPromptSections = [], residentTools = [], coordinationSubmissions = []
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
        const requestId = text.match(/^回复请求 ID：([^\r\n]+)$/mu)?.[1]
        const taskId = text.match(/^Task ID: ([^\r\n]+)$/mu)?.[1]
        const timeline = JSON.parse(text.match(/^任务消息时间线：(\[[^\r\n]*\])$/mu)?.[1] ?? '[]')
        const routingCandidates = timeline.filter((item) => typeof item.messageId === 'string' && typeof item.senderOpenDingTalkId === 'string')
        const replyTarget = routingCandidates.at(-1)
        const recipients = [...new Set(routingCandidates.map((item) => item.senderOpenDingTalkId))]
        const tool = residentTools.find((candidate) => candidate.name === 'group_reply_submit')
        const submission = tool.execute({
          requestId, observedRequestIds: [], reply: `coordinated:${taskId}`,
          ...(replyTarget === undefined ? {} : { replyToMessageId: replyTarget.messageId, atOpenDingTalkIds: recipients }),
        }, { agent })
        submission.catch(() => undefined)
        coordinationSubmissions.push(submission)
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
      async resume({ resumeSessionId, setup }) {
        const handle = resumeSessionId === 'session-parent' ? parentHandle : makeHandle(resumeSessionId)
        if (resumeSessionId === 'session-parent') await setup({
          on: () => () => undefined,
          tools: { register: (tool) => residentTools.push(tool), restrict: () => undefined },
          systemPrompt: { section: () => undefined },
        })
        agents.set(resumeSessionId, handle.agent)
        return handle
      },
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
    async createTask(value) {
      const duplicate = tasks.find((task) => task.groupId === value.groupId && task.sourceMessageId === value.sourceMessageId)
      if (duplicate) return { created: false, task: duplicate }
      const group = groups.get(value.groupId)
      const sourceIds = new Set(value.sourceMessageIds ?? [value.sourceMessageId])
      const sourceMessages = (group.messages ?? []).filter((message) => sourceIds.has(message.messageId))
      const currentSource = sourceMessages.findLast((message) => message.messageId === value.sourceMessageId)
      const requesterName = value.requesterName ?? currentSource?.senderName
      const requesterOpenDingTalkId = value.requesterOpenDingTalkId ?? currentSource?.senderOpenDingTalkId
      const occurredAt = value.occurredAt ?? currentSource?.occurredAt
      const messageHistory = sourceMessages.map((message) => ({
        messageId: message.messageId, text: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId,
        occurredAt: message.occurredAt, runSequence: 1, associatedAt: '2026-08-25T00:00:00Z',
      }))
      const taskId = `task-${tasks.length + 1}`
      const trigger = { sourceMessageId: value.sourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) }
      const task = { ...value, requesterName, requesterOpenDingTalkId, occurredAt, ...(messageHistory.length > 0 ? { messageHistory } : {}), taskId, childSessionId: taskSessionId(taskId), state: 'queued', triggerHistory: [trigger], runSequence: 1, runStartedAt: '2026-08-25T00:00:00Z', acceptanceCriteria: value.acceptanceCriteria ?? [value.objective], stageTasks: value.stageTasks ?? ['完成并验证当前轮目标'], runHistory: [], createdAt: '2026-08-25T00:00:00Z' }
      tasks.push(task)
      return { created: true, task }
    },
    async updateTask(id, transform) { const index = tasks.findIndex((task) => task.taskId === id); tasks[index] = transform(tasks[index]); return tasks[index] },
    async appendOutbox({ groupId, ...outbound }) { const group = groups.get(groupId); if (!group.outbox.some((item) => item.sourceMessageId === outbound.sourceMessageId)) group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, ...outbound, status: 'pending' }); return group },
    async updateOutboundRecall({ groupId, outboundId, status, reason, error }) { const item = groups.get(groupId).outbox.find((entry) => entry.outboundId === outboundId); Object.assign(item, { recallStatus: status, recallReason: reason }, status === 'recalled' ? { recalledAt: '2026-08-27T00:00:00Z', recallError: undefined } : {}, status === 'failed' ? { recallError: error } : {}); return groups.get(groupId) },
    async recordActivity(value) { const existing = activities.find((item) => item.eventKey === value.eventKey); if (existing) return { created: false, activity: existing }; activities.push(value); return { created: true, activity: value } },
    async recordAlert(value) { const existing = alerts.find((item) => item.taskId === value.taskId && item.fingerprint === value.fingerprint); if (existing) { existing.count += 1; return { created: false, alert: existing } } const alert = { ...value, count: 1 }; alerts.push(alert); return { created: true, alert } },
    listActivities: () => activities,
    close: async () => undefined,
  }
  const runtime = await openResidentRuntime(ctx, store, agentWorkspace, runtimeOptions({ agentPreset: 'standard-convergent', maxConcurrentTasks: 2, supervisorIntervalMs: 0 }))
  runtime.setCurrentDwsProfile('corp:user')
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
  assert.match(leafPolicyPrompt, /加载 `dingtalk-chat` Skill/u)
  assert.match(leafPolicyPrompt, /dws chat \+messages-mget --msg-ids '<消息ID>' --profile 'corp:user' --format json/u)
  assert.match(leafPolicyPrompt, /仍含 `quotedMessage\.messageId`，继续按该 ID 查询/u)
  assert.match(leafPolicyPrompt, /submit_task_result 如实提交 waiting 状态和 DWS 读取证据/u)
  assert.match(leafPolicyPrompt, /不得要求群成员重新提供已经存在于钉钉中的消息/u)
  assert.match(leafPolicyPrompt, /Task 完整消息与参与人时间线/u)
  assert.match(leafPolicyPrompt, /"messageId":"m1"[\s\S]*"text":"初始任务消息"[\s\S]*"senderOpenDingTalkId":"od-initial"/u)
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
  const coordinationPrompt = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith('[TASK_COORDINATION]') && message.content[0].text.includes(`\nTask ID: ${one.task.taskId}\n`))?.[1].content[0].text
  const coordinationMessage = followups.find(([sessionId, message]) => sessionId === 'session-parent' && message.content[0]?.text?.startsWith('[TASK_COORDINATION]') && message.content[0].text.includes(`\nTask ID: ${one.task.taskId}\n`))?.[1]
  assert.equal(coordinationMessage.source.kind, 'user', '对外通知生成路径保持现状')
  assert.equal(coordinationSubmissions.length >= 2, true, 'Task waiting/completed 通知必须经 group_reply_submit 提交')
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
  assert.deepEqual(groups.get('group-a').outbox.at(-1).atOpenDingTalkIds, ['od-initial', 'od-reopen-1'])

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
