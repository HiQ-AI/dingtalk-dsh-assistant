import assert from 'node:assert/strict'
import test from 'node:test'
import { openResidentRuntime, residentSessionId } from '../packages/dingtalk-dsh-assistant/runtime.js'
import { taskSessionId } from '../packages/dingtalk-dsh-assistant/store.js'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

test('已有群恢复原 Session，新群先创建 dsh Session 再持久绑定', async () => {
  const groups = new Map([['existing', { groupId: 'existing', residentSessionId: 'session-existing' }]])
  const calls = []
  const setupReturns = []
  const permissionSets = []
  const promptSections = []
  const registeredTools = []
  const tasks = []
  const handle = (sessionId) => ({ agent: { session: { id: sessionId } }, dispose: async () => undefined })
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: {
      async resume(options) { calls.push(['resume', options.resumeSessionId]); return handle(options.resumeSessionId) },
      async create(options) { calls.push(['create', options.sessionId, options.meta.cwd]); setupReturns.push(await options.setup({ on: () => () => undefined, tools: { register: (tool) => registeredTools.push(tool) }, systemPrompt: { section: (value) => promptSections.push(value) } })); return handle(options.sessionId) },
    },
    subagents: {
      drainContinuableDescendants: async () => undefined,
    },
    agentPresets: {
      mount: async () => ({ id: 'standard' }), composeFrom: () => 'standard',
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
    close: async () => undefined,
  }

  const runtime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent', { maxConcurrentTasks: 0 })
  const created = await runtime.subscribe({ groupId: 'new-group', name: '新群名称' })
  assert.deepEqual(calls[0], ['resume', 'session-existing'])
  assert.deepEqual(calls[1].slice(0, 2), ['create', created.group.residentSessionId])
  assert.deepEqual(permissionSets, [['session-existing', 'danger-full-access'], [created.group.residentSessionId, 'danger-full-access']])
  assert.equal(calls[1][2], 'D:\\baibu-agent')
  assert.deepEqual(setupReturns, [undefined], 'Agent setup不能意外返回非事务对象')
  assert.equal(created.group.residentSessionId, residentSessionId('new-group'))
  assert.equal(promptSections[0].name, 'dingtalk-group-responsibility')
  assert.match(promptSections[0].text(), /群名称：新群名称/)
  assert.match(promptSections[0].text(), /群 ID：new-group/)
  assert.match(promptSections[0].text(), /未设置职责/)
  assert.deepEqual(registeredTools.map((tool) => tool.name), ['group_task_create', 'group_task_context_append', 'group_task_reopen', 'group_task_list'])
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
  const runtime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent')
  await runtime.subscribe({ groupId: 'workspace-group' })
  creates.length = 0
  await runtime.updateAgentConfig({ workspaceDir: 'D:\\project\\dingtalk-dsh-assistant' })
  assert.equal(store.workspaceDir, 'D:\\project\\dingtalk-dsh-assistant')
  assert.equal(creates[0].meta.cwd, 'D:\\project\\dingtalk-dsh-assistant')
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
  const runtime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent')
  const updated = await runtime.updateAgentConfig({ model: 'gpt-5.6-sol', reasoningEffort: 'low' })
  assert.deepEqual(saved, [{ provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' }])
  assert.equal(updated.model, 'gpt-5.6-sol')
  assert.equal(updated.reasoningEffort, 'low')
  assert.deepEqual(runtime.getAgentConfig(), { agentNames: [], workspaceDir: 'D:\\baibu-agent', provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low', proxyUrl: '', taskExecutionGuidance: '', taskEvidenceGuidance: '', maxConcurrentTasks: 5 })
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
  const runtime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent', { resumeTimeoutMs: 10 })
  const issues = runtime.listRecoveryIssues()
  assert.equal(issues[0].groupId, 'bad-group')
  assert.equal(issues[0].residentSessionId, 'session-bad')
  assert.match(issues[0].error, /timeout/i)
  await runtime.close()
})

test('Task 使用确定性独立 Agent 与原生 Goal，两个名额满后 FIFO 排队', async () => {
  const groups = new Map([['group-a', { groupId: 'group-a', responsibility: 'coordinate', residentSessionId: 'session-parent', outbox: [] }]])
  const tasks = []
  const creates = [], createMetas = [], followups = [], approvalResumeOrder = [], disposed = [], activities = [], alerts = [], goals = new Map(), agents = new Map()
  let sessionObserver
  const makeHandle = (sessionId) => {
    const session = { id: sessionId, events: [], seq: 0, meta: {}, append(type, data) { const event = { seq: session.seq++, type, data }; session.events.push(event); return event } }
    const agent = { session, status: 'idle', followup(message) {
      followups.push([sessionId, message])
      const text = message.content[0]?.text ?? ''
      if (text.startsWith('[HUMAN_INTERVENTION_REPLY]')) approvalResumeOrder.push('批复入队')
      if (sessionId === 'session-parent' && text.startsWith('[TASK_COORDINATION]')) {
        session.events.push({ seq: session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `coordinated:${text.match(/Task ID: (.*)/)?.[1]}` }] } } })
      }
    }, whenIdle: async () => undefined }
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
      async create({ sessionId, meta, setup }) { creates.push(sessionId); createMetas.push(meta); setup({ on: () => () => undefined, tools: { register: () => undefined }, systemPrompt: { section: () => undefined } }); const handle = makeHandle(sessionId); agents.set(sessionId, handle.agent); return handle },
    },
    goals: {
      get(agent) { return goals.get(agent.session.id) },
      create(agent, request) { const goal = { id: `goal-${agent.session.id}`, revision: 1, phase: 'active', activation: 'armed', ...request }; goals.set(agent.session.id, goal); return goal },
      block(agent, ref, reason) { const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'blocked', activation: 'disarmed', blockedReason: reason }; goals.set(agent.session.id, goal); return goal },
      resume(agent, ref) { approvalResumeOrder.push('Goal恢复'); const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'active', activation: 'armed', blockedReason: undefined }; goals.set(agent.session.id, goal); return goal },
      complete(agent, ref) { const goal = { ...goals.get(agent.session.id), revision: ref.revision + 1, phase: 'complete', activation: 'disarmed' }; goals.set(agent.session.id, goal); return goal },
    },
    on(name, listener) { if (name === 'session/event') sessionObserver = listener; return () => { sessionObserver = undefined } },
    subagents: {
      async drainContinuableDescendants() {},
    },
    agentPresets: {
      mount: async () => ({ id: 'standard' }), composeFrom: () => 'standard',
      serviceFor: () => ({ set: () => undefined }),
    },
  }
  const store = {
    getGroup: (id) => groups.get(id), listGroups: () => [...groups.values()], listTasks: () => tasks, getTask: (id) => tasks.find((task) => task.taskId === id),
    getMaxConcurrentTasks: () => store.maxConcurrentTasks,
    async setMaxConcurrentTasks(value) { store.maxConcurrentTasks = value; return { maxConcurrentTasks: value } },
    async createTask(value) { const duplicate = tasks.find((task) => task.groupId === value.groupId && task.sourceMessageId === value.sourceMessageId); if (duplicate) return { created: false, task: duplicate }; const taskId = `task-${tasks.length + 1}`; const task = { ...value, taskId, childSessionId: taskSessionId(taskId), state: 'queued' }; tasks.push(task); return { created: true, task } },
    async updateTask(id, transform) { const index = tasks.findIndex((task) => task.taskId === id); tasks[index] = transform(tasks[index]); return tasks[index] },
    async appendOutbox({ groupId, sourceMessageId, text }) { const group = groups.get(groupId); if (!group.outbox.some((item) => item.sourceMessageId === sourceMessageId)) group.outbox.push({ outboundId: `out-${group.outbox.length + 1}`, sourceMessageId, text, status: 'pending' }); return group },
    async recordActivity(value) { const existing = activities.find((item) => item.eventKey === value.eventKey); if (existing) return { created: false, activity: existing }; activities.push(value); return { created: true, activity: value } },
    async recordAlert(value) { const existing = alerts.find((item) => item.taskId === value.taskId && item.fingerprint === value.fingerprint); if (existing) { existing.count += 1; return { created: false, alert: existing } } const alert = { ...value, count: 1 }; alerts.push(alert); return { created: true, alert } },
    listActivities: () => activities,
    close: async () => undefined,
  }
  const runtime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent', { maxConcurrentTasks: 2, supervisorIntervalMs: 0 })
  const one = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm1', objective: 'one' })
  const two = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm2', objective: 'two' })
  const three = await runtime.createTask({ groupId: 'group-a', sourceMessageId: 'm3', objective: 'three' })

  assert.deepEqual([one.task.state, two.task.state, three.task.state], ['running', 'running', 'queued'])
  assert.deepEqual(creates, ['session-task-1', 'session-task-2'])
  assert.deepEqual(createMetas[0], { cwd: 'D:\\baibu-agent', parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 })
  assert.equal(goals.get('session-task-1').phase, 'active')
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', 'Goal active 不等于 Task 完成')
  sessionObserver({ id: 'session-task-1' }, { seq: 7, type: 'turn/end', data: { status: 'success' } })
  sessionObserver({ id: 'session-task-1' }, { seq: 7, type: 'turn/end', data: { status: 'success' } })
  await runtime.flushActivities()
  assert.equal(runtime.listActivities().length, 1)
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', 'turn/end投影不能完成Task')
  const followup = await runtime.followupTask({ taskId: one.task.taskId, text: 'more evidence' })
  assert.equal(followup.accepted, true)
  assert.equal(followups[0][0], 'session-task-1')
  await runtime.submitTaskResult({ taskId: two.task.taskId, result: { status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'provide fixture', questions: ['Which fixture?'] } })
  assert.equal(runtime.getTask(two.task.taskId).state, 'waiting')
  assert.equal(groups.get('group-a').outbox[0].sourceMessageId.startsWith(`task-result:${two.task.taskId}:waiting:`), true)
  const blockerRequests = []
  runtime.onHumanBlockerRequested((event) => { blockerRequests.push(event) })
  const releaseWaiting = { status: 'waiting', waitingKind: 'human-intervention', summary: '等待发布批准', evidence: ['发布范围已核验'], artifacts: [], waitingReason: '生产发布需要批准', blockerCategory: 'redline', risk: '错误发布会影响生产环境', attemptedActions: ['已完成只读核验'], requestedAction: '发布 dataset v1 和 dataset-web v2；不执行回滚' }
  const firstBlocker = await runtime.submitTaskResult({ taskId: one.task.taskId, result: releaseWaiting })
  const firstRequestId = firstBlocker.humanBlocker.requestId
  const duplicateBlocker = await runtime.submitTaskResult({ taskId: one.task.taskId, result: { ...releaseWaiting, requestedAction: ' 发布 dataset v1 和 dataset-web v2；不执行回滚 ' } })
  assert.equal(duplicateBlocker.humanBlocker.requestId, firstRequestId, '同一待批范围重复上报必须复用阻塞请求')
  assert.equal(blockerRequests.length, 1, '同一待批范围只能触发一次外发')
  await runtime.recordHumanBlockerDelivery({ taskId: one.task.taskId, requestId: firstRequestId, openTaskId: 'open-1', conversationId: 'self-1', messageId: 'approval-1' })
  await runtime.resolveHumanBlocker({ taskId: one.task.taskId, requestId: firstRequestId, quotedMessageId: 'approval-1', replyMessageId: 'reply-1', reply: '批准', decision: 'approved' })
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
  await runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] } })
  assert.equal(groups.get('group-a').outbox[1].sourceMessageId, `task-result:${one.task.taskId}:completed`)
  assert.equal(groups.get('group-a').outbox[1].text, `coordinated:${one.task.taskId}`)
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
  const reopened = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '补做已归档任务' })
  assert.equal(reopened.state, 'queued', '并发名额已满时重开的归档任务进入原生FIFO队列')
  assert.equal(reopened.archivedAt, undefined)
  assert.equal(reopened.relatedContexts.at(-1), '补做已归档任务')
  const raisedConcurrency = await runtime.updateAgentConfig({ maxConcurrentTasks: 3 })
  assert.equal(raisedConcurrency.maxConcurrentTasks, 3)
  assert.equal(runtime.getTask(one.task.taskId).state, 'running', '提高并行上限后按FIFO立即启动待执行任务')
  await runtime.submitTaskResult({ taskId: one.task.taskId, result: { status: 'completed', workType: 'non-development', summary: 'second done', evidence: ['second verified'], artifacts: [] } })
  assert.equal(groups.get('group-a').outbox.at(-1).sourceMessageId, `task-result:${one.task.taskId}:completed:1`, '重开任务再次完成必须生成独立通知')
  const reopenedCompleted = await runtime.appendTaskContext({ taskId: one.task.taskId, context: '继续核验已完成任务' })
  assert.equal(reopenedCompleted.state, 'running', '已完成任务收到task-context时必须恢复原Task')
  assert.equal(reopenedCompleted.relatedContexts.at(-1), '继续核验已完成任务')
  assert.equal(reopenedCompleted.completionSequence, 2)
  await runtime.close()
  const persistedChildSessionId = runtime.getTask(three.task.taskId).childSessionId
  goals.set(persistedChildSessionId, { ...goals.get(persistedChildSessionId), revision: 4, phase: 'paused', activation: 'disarmed' })
  const recoveredRuntime = await openResidentRuntime(ctx, store, 'D:\\baibu-agent', { supervisorIntervalMs: 0 })
  assert.equal(goals.get(persistedChildSessionId).phase, 'active', '进程重启恢复时仍应续接Task当前叶子')
  assert.equal(recoveredRuntime.getTask(three.task.taskId).state, 'running')
  assert.equal(goals.get('session-task-2').phase, 'blocked', '业务 waiting Task 不应被启动恢复误唤醒')
  await recoveredRuntime.close()
})
