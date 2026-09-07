import assert from 'node:assert/strict'
import test from 'node:test'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'

function memoryFacility(seed = new Map()) {
  const table = (name) => ({
    get: (key) => seed.get(`${name}:${key}`),
    entries: () => [...seed.entries()].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value])[Symbol.iterator](),
    async put(key, value) { seed.set(`${name}:${key}`, value) },
    async delete(key) { seed.delete(`${name}:${key}`) },
    async update(key, transform) { const storageKey = `${name}:${key}`; const value = transform(seed.get(storageKey)); seed.set(storageKey, value); return value },
  })
  return { seed, facility: { async open() { return { table, close: async () => undefined } } } }
}

test('Task消息时间线作为可选字段保持现有storage domain版本兼容', () => {
  assert.equal(residentDomainSpec.version, 6)
})

test('群配置初始化、职责修改和删除均持久化', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  assert.equal(store.hasGroupConfiguration(), false)
  await store.initializeGroupConfiguration()
  await store.subscribe({ groupId: 'group-config', responsibility: '旧职责' })
  const updated = await store.updateGroup({ groupId: 'group-config', responsibility: '新职责' })
  await store.setAgentWorkspaceDir('D:\\baibu-agent')
  await store.setProxyUrl('http://127.0.0.1:10808')
  assert.equal(store.hasGroupConfiguration(), true)
  assert.equal(updated.responsibility, '新职责')
  assert.equal(store.getAgentWorkspaceDir(), 'D:\\baibu-agent')
  assert.equal(store.getProxyUrl(), 'http://127.0.0.1:10808')
  await store.removeGroup({ groupId: 'group-config' })
  assert.equal(store.getGroup('group-config'), undefined)
})

test('同群消息按稳定 messageId 去重并递增排序', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  const subscription = await store.subscribe({ groupId: 'group-a', responsibility: 'review' })
  const first = await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-24T12:00:00+08:00' })
  const duplicate = await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-24T12:00:00+08:00' })
  const enriched = await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-24T12:00:00+08:00', senderName: '张三', senderOpenDingTalkId: 'sender-1' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-24T12:00:00+08:00', quotedMessage: { content: '提示 @485388732', messageId: 'm-source', senderName: 'null' } })
  const quoteEnriched = await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-24T12:00:00+08:00', quotedMessage: { content: '提示 @485388732', messageId: 'm-source', senderName: '郑耀彬', occurredAt: '2026-08-24 10:42:37' } })
  const second = await store.ingest({ groupId: 'group-a', messageId: 'm-2', text: 'two', occurredAt: '2026-08-24T12:00:01+08:00' })
  const delivered = await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-2', status: 'delivered' })
  await store.appendOutbox({ groupId: 'group-a', sourceMessageId: 'm-1', text: 'reply-one' })
  const replied = await store.appendOutbox({ groupId: 'group-a', sourceMessageId: 'm-1', text: 'reply-one-again' })

  assert.equal(subscription.group.residentSessionId, first.group.residentSessionId)
  assert.deepEqual([first.sequence, duplicate.sequence, second.sequence], [1, 1, 2])
  assert.equal(duplicate.duplicate, true)
  assert.equal(enriched.enriched, true)
  assert.equal(enriched.group.messages[0].senderName, '张三')
  assert.equal(enriched.group.messages[0].senderOpenDingTalkId, 'sender-1')
  assert.equal(quoteEnriched.group.messages[0].quotedMessage.senderName, '郑耀彬')
  assert.equal(quoteEnriched.group.messages[0].quotedMessage.occurredAt, '2026-08-24 10:42:37')
  assert.equal(quoteEnriched.group.messages[0].quotedMessage.content, '提示 @485388732')
  assert.equal(second.group.messages.length, 2)
  assert.equal(delivered.messages[1].agentDeliveryStatus, 'delivered')
  const steered = await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-1', status: 'steered' })
  assert.equal(steered.messages[0].agentDecisionAttemptCount, 1)
  const retryAt = '2026-09-04T06:00:00.000Z'
  const retrying = await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-1', status: 'decision-retrying', error: 'group_decision_not_submitted', retryAt })
  assert.equal(retrying.messages[0].agentDeliveryStatus, 'decision-retrying')
  assert.equal(retrying.messages[0].agentDeliveryError, 'group_decision_not_submitted')
  assert.equal(retrying.messages[0].agentDecisionRetryAt, retryAt)
  const retrySteered = await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-1', status: 'steered' })
  assert.equal(retrySteered.messages[0].agentDecisionAttemptCount, 2)
  assert.equal(retrySteered.messages[0].agentDeliveryError, undefined)
  assert.equal(retrySteered.messages[0].agentDecisionRetryAt, undefined)
  await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-2', status: 'failed', error: 'temporary failure' })
  const recovered = await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-2', status: 'delivered' })
  assert.equal(recovered.messages[1].agentDeliveryError, undefined)
  const marked = await store.markMessagesAgentDelivery({ groupId: 'group-a', status: 'delivered', onlyMissing: true })
  assert.equal(marked.updated, 0)
  assert.equal(marked.group.messages[0].agentDeliveryStatus, 'steered')
  assert.equal(marked.group.messages[1].agentDeliveryStatus, 'delivered')
  assert.equal(replied.outbox.length, 1)
  assert.equal(replied.outbox[0].text, 'reply-one')

  await store.markMessageAgentDelivery({ groupId: 'group-a', messageId: 'm-1', status: 'failed', error: 'schema failure' })
  const exact = await store.markMessagesAgentDelivery({ groupId: 'group-a', status: 'delivered', onlyMissing: false, messageIds: ['m-1'] })
  assert.equal(exact.updated, 1)
  assert.equal(exact.group.messages[0].agentDeliveryStatus, 'delivered')
  assert.equal(exact.group.messages[0].agentDeliveryError, undefined)
  assert.equal(exact.group.messages[1].agentDeliveryStatus, 'delivered')
})

test('显式确认可只回填缺少Agent投递状态的历史消息', async () => {
  const seed = new Map([['groups:group-legacy', { groupId: 'group-legacy', responsibility: '', residentSessionId: 'session-legacy', nextSequence: 2, messages: [{ messageId: 'm-old', sequence: 1, text: 'old', occurredAt: '2026-08-24 10:00:00' }], outbox: [] }]])
  const { facility } = memoryFacility(seed)
  const store = await openResidentStore(facility)
  const marked = await store.markMessagesAgentDelivery({ groupId: 'group-legacy', status: 'delivered', onlyMissing: true })
  assert.equal(marked.updated, 1)
  assert.equal(marked.group.messages[0].agentDeliveryStatus, 'delivered')
})

test('旧版工具装配失败结果恢复为运行态且不升级真人阻塞', async () => {
  const legacyTask = {
    taskId: 'task-legacy', groupId: 'group-a', sourceMessageId: 'm-legacy', objective: 'legacy objective', state: 'running', childSessionId: 'session-task-legacy',
    result: { status: 'waiting', summary: '缺少运行工具', evidence: ['只有提交工具'], artifacts: [], waitingReason: '请提供命令执行工具' },
    createdAt: '2026-08-24T10:00:00.000Z', updatedAt: '2026-08-24T10:00:00.000Z',
  }
  const seed = new Map([['scheduler:runtime', { tasks: [legacyTask] }]])
  const { facility } = memoryFacility(seed)
  const store = await openResidentStore(facility)
  const migrated = store.getTask('task-legacy')
  assert.equal(migrated.state, 'running')
  assert.equal(migrated.waitingKind, undefined)
  assert.equal(migrated.humanBlocker, undefined)
  assert.equal(migrated.result, undefined)
})

test('启动迁移清理覆盖真实来源的内部恢复伪触发', async () => {
  const task = {
    taskId: 'task-recovery-source', groupId: 'group-a', sourceMessageId: 'recovery:completion-review-gate', objective: '完成任务', state: 'completed', childSessionId: 'session-task-recovery-source', requesterName: '内部操作人',
    triggerHistory: [
      { sourceMessageId: 'm-real', requesterName: '真实提出人', requesterOpenDingTalkId: 'od-real' },
      { sourceMessageId: 'recovery:completion-review-gate', requesterName: '内部操作人' },
    ],
    result: { status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] },
    createdAt: '2026-08-24T10:00:00.000Z', updatedAt: '2026-08-24T11:00:00.000Z',
  }
  const { facility } = memoryFacility(new Map([['scheduler:runtime', { tasks: [task] }]]))
  const store = await openResidentStore(facility)
  const migrated = store.getTask(task.taskId)
  assert.equal(migrated.sourceMessageId, 'm-real')
  assert.equal(migrated.requesterName, '真实提出人')
  assert.equal(migrated.requesterOpenDingTalkId, 'od-real')
  assert.deepEqual(migrated.triggerHistory, [{ sourceMessageId: 'm-real', requesterName: '真实提出人', requesterOpenDingTalkId: 'od-real' }])
})

test('Task 按来源去重并持久化四桶状态', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.setAgentNames(['数字助理', '小助手'])
  await store.ingest({ groupId: 'group-a', messageId: 'm-task', text: '请调查', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '调查任务', objective: 'investigate', requesterName: '张三', requesterOpenDingTalkId: 'od-zhang', occurredAt: '2026-08-25T01:00:00Z', acceptanceCriteria: ['调查结论有可核验证据'] })
  const duplicate = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '调查任务', objective: 'investigate', acceptanceCriteria: ['调查结论有可核验证据'] })
  const secondFromSameMessage = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '修复任务', objective: 'fix', acceptanceCriteria: ['修复结果有可核验证据'] })
  const running = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'running' }))
  const waiting = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'waiting', waitingReason: 'need input' }))
  const completed = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'completed', completion: 'done' }))

  assert.equal(duplicate.created, false)
  assert.equal(secondFromSameMessage.created, true)
  assert.equal(created.task.title, '调查任务')
  assert.equal(duplicate.task.taskId, created.task.taskId)
  assert.notEqual(secondFromSameMessage.task.taskId, created.task.taskId)
  assert.deepEqual(created.task.triggerHistory, [{ sourceMessageId: 'm-task', requesterName: '张三', requesterOpenDingTalkId: 'od-zhang', occurredAt: '2026-08-25T01:00:00Z' }])
  assert.equal(running.state, 'running')
  assert.equal(waiting.state, 'waiting')
  assert.equal(completed.state, 'completed')
  assert.deepEqual(completed.stateHistory.map((event) => event.state), ['queued', 'running', 'waiting', 'completed'])
})

test('Task 按消息时序持久化全部关联消息与发送人', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-history' })
  await store.ingest({ groupId: 'group-history', messageId: 'm-origin', text: '请排查导入失败', occurredAt: '2026-09-02T01:00:00Z', senderName: '提出人', senderOpenDingTalkId: 'od-owner' })
  await store.ingest({ groupId: 'group-history', messageId: 'm-detail', text: '补充：失败文件是 a.xlsx', occurredAt: '2026-09-02T01:00:01Z', senderName: '补充人', senderOpenDingTalkId: 'od-detail', quotedMessage: { messageId: 'm-origin', content: '请排查导入失败' } })

  const created = await store.createTask({
    groupId: 'group-history', sourceMessageId: 'm-detail', sourceMessageIds: ['m-detail', 'm-origin'],
    title: '排查导入失败', objective: '排查 a.xlsx 导入失败', acceptanceCriteria: ['给出可核验根因'],
  })
  const projection = created.task.messageHistory.map(({ associatedAt, ...message }) => message)
  assert.deepEqual(projection, [
    { messageId: 'm-origin', text: '请排查导入失败', senderName: '提出人', senderOpenDingTalkId: 'od-owner', occurredAt: '2026-09-02T01:00:00Z', runSequence: 1 },
    { messageId: 'm-detail', text: '补充：失败文件是 a.xlsx', senderName: '补充人', senderOpenDingTalkId: 'od-detail', occurredAt: '2026-09-02T01:00:01Z', quotedMessageId: 'm-origin', runSequence: 1 },
  ])
  assert.equal(created.task.messageHistory.every((message) => typeof message.associatedAt === 'string'), true)

  await store.close()
  const reopened = await openResidentStore(facility)
  assert.deepEqual(reopened.getTask(created.task.taskId).messageHistory, created.task.messageHistory)
  await reopened.close()
})

test('旧 Task 只从可靠触发ID回填仍存在的历史消息', async () => {
  const legacyTask = {
    taskId: 'task-legacy-message-history', groupId: 'group-legacy-history', sourceMessageId: 'm-latest', objective: '排查历史问题', state: 'completed', childSessionId: 'session-task-legacy-message-history',
    triggerHistory: [
      { sourceMessageId: 'm-origin', requesterName: '提出人', requesterOpenDingTalkId: 'od-owner' },
      { sourceMessageId: 'm-missing', requesterName: '缺失消息发送人', requesterOpenDingTalkId: 'od-missing' },
      { sourceMessageId: 'recovery:internal', requesterName: '内部恢复' },
      { sourceMessageId: 'm-latest', requesterName: '补充人', requesterOpenDingTalkId: 'od-detail' },
    ],
    createdAt: '2026-09-01T01:00:00.000Z', updatedAt: '2026-09-01T02:00:00.000Z',
  }
  const group = {
    groupId: 'group-legacy-history', responsibility: '', residentSessionId: 'session-legacy-history', nextSequence: 3, outbox: [],
    messages: [
      { messageId: 'm-origin', sequence: 1, text: '最初需求', occurredAt: '2026-09-01T01:00:00Z', senderName: '提出人', senderOpenDingTalkId: 'od-owner' },
      { messageId: 'm-latest', sequence: 2, text: '后续补充', occurredAt: '2026-09-01T01:30:00Z', senderName: '补充人', senderOpenDingTalkId: 'od-detail' },
    ],
  }
  const { facility } = memoryFacility(new Map([
    ['groups:group-legacy-history', group],
    ['scheduler:runtime', { tasks: [legacyTask] }],
  ]))
  const store = await openResidentStore(facility)
  assert.deepEqual(store.getTask(legacyTask.taskId).messageHistory.map((message) => message.messageId), ['m-origin', 'm-latest'])
  assert.equal(store.getTask(legacyTask.taskId).messageHistory.some((message) => message.messageId === 'm-missing'), false)
  await store.close()
})

test('Task 创建门禁只校验通用可追溯字段和可核验验收标准', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-task', text: '请处理', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  await assert.rejects(store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', objective: '处理事项', acceptanceCriteria: ['结果可核验'] }), /task_title_invalid/)
  await assert.rejects(store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '处理事项', objective: '处理事项', acceptanceCriteria: [] }), /task_acceptance_criteria_required/)
  await assert.rejects(store.createTask({ groupId: 'group-a', sourceMessageId: 'web:manual', title: '人工任务', objective: '处理人工任务', acceptanceCriteria: ['结果可核验'] }), /task_synthetic_source_requester_required/)
  await assert.rejects(store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', sourceMessageIds: [], title: '处理事项', objective: '处理事项', acceptanceCriteria: ['结果可核验'] }), /task_source_messages_invalid/)
  await assert.rejects(store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', sourceMessageIds: ['m-task', 'm-task'], title: '处理事项', objective: '处理事项', acceptanceCriteria: ['结果可核验'] }), /task_source_message_duplicate/)
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '处理事项', objective: '处理事项', acceptanceCriteria: ['结果可核验'] })
  assert.equal(created.task.requesterName, '张三')
  assert.deepEqual(created.task.acceptanceCriteria, ['结果可核验'])
})

test('Task 当前轮耗时拆分状态时间和可配对工具时间', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-timing', text: '统计耗时', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-timing', title: '统计耗时', objective: '统计任务耗时', acceptanceCriteria: ['耗时分类可查询'] })
  await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'running' }))
  const start = Date.parse(created.task.runStartedAt)
  await store.recordActivity({ taskId: created.task.taskId, sessionId: created.task.childSessionId, eventKey: 'call', type: 'tool/call', detail: { tool: 'test', callId: 'call-1' }, occurredAt: new Date(start + 1).toISOString() })
  await store.recordActivity({ taskId: created.task.taskId, sessionId: created.task.childSessionId, eventKey: 'result', type: 'tool/result', detail: { tool: 'test', callId: 'call-1' }, occurredAt: new Date(start + 3).toISOString() })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const timing = store.listTaskTimings().find((item) => item.taskId === created.task.taskId)
  assert.equal(timing.complete, true)
  assert.equal(timing.toolMs, 2)
  assert.equal(timing.wallMs >= timing.queuedMs + timing.runningMs, true)
  assert.equal(timing.unclassifiedRunningMs, Math.max(0, timing.runningMs - timing.toolMs))
})

test('Task 完成结果事件晚于完成状态时仍按调用ID配对', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-terminal-timing', text: '统计终结调用', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-terminal-timing', title: '统计终结调用', objective: '统计终结调用耗时', acceptanceCriteria: ['终结调用可配对'] })
  const running = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'running' }))
  const callAt = running.stateHistory.at(-1).at
  await store.recordActivity({ taskId: created.task.taskId, sessionId: created.task.childSessionId, eventKey: 'terminal-call', type: 'tool/call', detail: { tool: 'submit_task_result', callId: 'call-terminal' }, occurredAt: callAt })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const completed = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'completed' }))
  const completedAt = completed.stateHistory.at(-1).at
  await store.recordActivity({ taskId: created.task.taskId, sessionId: created.task.childSessionId, eventKey: 'terminal-result', type: 'tool/result', detail: { tool: 'submit_task_result', callId: 'call-terminal' }, occurredAt: new Date(Date.parse(completedAt) + 211).toISOString() })

  const timing = store.listTaskTimings().find((item) => item.taskId === created.task.taskId)
  assert.equal(timing.complete, true)
  assert.deepEqual(timing.missing, [])
  assert.equal(timing.toolMs, Date.parse(completedAt) - Date.parse(callAt))
})

test('Task 确实缺少工具结果时保持未配对标记', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-unpaired-timing', text: '统计缺失结果', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-unpaired-timing', title: '统计缺失结果', objective: '识别缺失的工具结果', acceptanceCriteria: ['缺失结果可识别'] })
  const running = await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'running' }))
  await store.recordActivity({ taskId: created.task.taskId, sessionId: created.task.childSessionId, eventKey: 'unpaired-call', type: 'tool/call', detail: { tool: 'job_output', callId: 'call-unpaired' }, occurredAt: running.stateHistory.at(-1).at })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'completed' }))

  const timing = store.listTaskTimings().find((item) => item.taskId === created.task.taskId)
  assert.equal(timing.complete, false)
  assert.deepEqual(timing.missing, ['unpaired-tool-events'])
})

test('历史 Web Task 可从已持久化群消息恢复提出人并修正完成通知路由', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-source', text: '请处理', occurredAt: 'now', senderName: '李辰', senderOpenDingTalkId: 'od-requester' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'web:legacy', title: '处理历史任务', objective: '处理任务', requesterName: '历史操作人', requesterOpenDingTalkId: 'od-legacy', acceptanceCriteria: ['处理结果可核验'] })
  await store.appendOutbox({ groupId: 'group-a', sourceMessageId: `task-result:${created.task.taskId}:completed`, text: '已完成' })

  const migrated = await store.migrateTaskProvenance({ taskId: created.task.taskId, sourceMessageId: 'm-source', completionDelivered: true })
  const outbound = store.getGroup('group-a').outbox[0]
  assert.equal(outbound.readbackRequired, true)
  assert.equal(migrated.sourceMessageId, 'm-source')
  assert.equal(migrated.requesterName, '李辰')
  assert.equal(migrated.requesterOpenDingTalkId, 'od-requester')
  assert.equal(outbound.status, 'sent')
  assert.equal(outbound.replyToMessageId, 'm-source')
  assert.equal(outbound.replyToSenderOpenDingTalkId, 'od-requester')
  assert.deepEqual(outbound.atOpenDingTalkIds, ['od-requester'])
})

test('并发创建不同 Task 不会用旧 scheduler 快照互相覆盖', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-2', text: 'two', occurredAt: '2026-08-25T01:01:00Z', senderName: '李四', senderOpenDingTalkId: 'od-li' })

  const [first, second] = await Promise.all([
    store.createTask({ groupId: 'group-a', sourceMessageId: 'm-1', title: '任务一', objective: 'one', acceptanceCriteria: ['one 完成可核验'] }),
    store.createTask({ groupId: 'group-a', sourceMessageId: 'm-2', title: '任务二', objective: 'two', acceptanceCriteria: ['two 完成可核验'] }),
  ])

  assert.equal(first.created, true)
  assert.equal(second.created, true)
  assert.deepEqual(store.listTasks().map((task) => task.sourceMessageId).sort(), ['m-1', 'm-2'])
})

test('Supervisor 告警按 Task 和指纹去重且不推进业务状态', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-task', text: 'investigate', occurredAt: '2026-08-25T01:00:00Z', senderName: '张三', senderOpenDingTalkId: 'od-zhang' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '调查异常', objective: 'investigate', acceptanceCriteria: ['调查结果可核验'] })
  await store.updateTask(created.task.taskId, (task) => ({ ...task, state: 'running' }))
  const first = await store.recordAlert({ taskId: created.task.taskId, fingerprint: 'carrier-missing', detail: 'child carrier missing' })
  const repeated = await store.recordAlert({ taskId: created.task.taskId, fingerprint: 'carrier-missing', detail: 'child carrier missing' })

  assert.equal(first.created, true)
  assert.equal(repeated.created, false)
  assert.equal(repeated.alert.alertId, first.alert.alertId)
  assert.equal(repeated.alert.count, 2)
  assert.equal(repeated.alert.status, 'active')
  const resolution = await store.resolveAlerts({ taskId: created.task.taskId, fingerprintPrefix: 'carrier-' })
  assert.equal(resolution.resolved, 1)
  assert.equal(store.listAlerts()[0].status, 'resolved')
  assert.ok(store.listAlerts()[0].resolvedAt)
  assert.equal(store.getTask(created.task.taskId).state, 'running')
})

test('重开 store 后复用同一 resident Session 和 outbox 状态', async () => {
  const { seed, facility } = memoryFacility()
  const firstStore = await openResidentStore(facility)
  const created = await firstStore.subscribe({ groupId: 'group-a' })
  const accepted = await firstStore.ingest({ groupId: 'group-a', messageId: 'm-1', text: 'one', occurredAt: 'now' })
  const withReply = await firstStore.appendOutbox({ groupId: 'group-a', sourceMessageId: 'm-1', text: 'reply' })
  const outboundId = withReply.outbox[0].outboundId
  await firstStore.acknowledge({ groupId: 'group-a', outboundId, deliveredMessageId: 'm-agent-reply' })

  const reopened = await openResidentStore(memoryFacility(seed).facility)
  const restored = reopened.getGroup('group-a')
  assert.equal(restored.residentSessionId, created.group.residentSessionId)
  assert.equal(restored.outbox[0].status, 'sent')
  assert.equal(restored.outbox[0].deliveredMessageId, 'm-agent-reply')
})

test('Task流程证据配置、回复审阅与撤回元数据持久化', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.setAgentNames(['数字助理', '小助手'])
  await store.setTaskGuidance({ taskExecutionGuidance: '开发类按发布流程', taskEvidenceGuidance: '提交当前证据' })
  const group = await store.appendOutbox({ groupId: 'group-a', sourceMessageId: 'task-result:1', text: 'done', replyToMessageId: 'm-source', replyToSenderOpenDingTalkId: 'od-requester', atOpenDingTalkIds: ['od-requester'], replyKind: 'confirmation', matterSourceMessageIds: ['m-source', 'm-source'], taskIds: ['task-1', 'task-1'], replacesOutboundIds: ['out-old', 'out-old'] })
  assert.equal(store.getTaskExecutionGuidance(), '开发类按发布流程')
  assert.deepEqual(store.getAgentNames(), ['数字助理', '小助手'])
  assert.equal(store.getTaskEvidenceGuidance(), '提交当前证据')
  assert.equal(group.outbox[0].replyToMessageId, 'm-source')
  assert.deepEqual(group.outbox[0].atOpenDingTalkIds, ['od-requester'])
  assert.equal(group.outbox[0].replyKind, 'confirmation')
  assert.deepEqual(group.outbox[0].matterSourceMessageIds, ['m-source'])
  assert.deepEqual(group.outbox[0].taskIds, ['task-1'])
  assert.deepEqual(group.outbox[0].replacesOutboundIds, ['out-old'])
  await store.acknowledge({ groupId: 'group-a', outboundId: group.outbox[0].outboundId, deliveredMessageId: 'sent-1' })
  await store.updateOutboundRecall({ groupId: 'group-a', outboundId: group.outbox[0].outboundId, status: 'requested', reason: 'superseded-by:m-new' })
  await store.updateOutboundRecall({ groupId: 'group-a', outboundId: group.outbox[0].outboundId, status: 'recalled', reason: 'superseded-by:m-new' })
  assert.equal(store.getGroup('group-a').outbox[0].recallStatus, 'recalled')
  assert.equal(store.getGroup('group-a').outbox[0].recallReason, 'superseded-by:m-new')
})

test('确认Outbox可在Task动作完成后原子补充关联Task', async () => {
  const { facility } = memoryFacility()
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'group-a' })
  await store.ingest({ groupId: 'group-a', messageId: 'm-task', text: '请处理', occurredAt: '2026-09-04T13:00:00Z', senderName: '提出人', senderOpenDingTalkId: 'od-owner' })
  await store.appendOutbox({ groupId: 'group-a', sourceMessageId: 'm-task', text: '收到，开始处理。' })
  const created = await store.createTask({ groupId: 'group-a', sourceMessageId: 'm-task', title: '处理事项', objective: '完成处理', acceptanceCriteria: ['结果可核验'] })

  const attached = await store.attachOutboxTasks({ groupId: 'group-a', sourceMessageId: 'm-task', taskIds: [created.task.taskId] })
  assert.deepEqual(attached.outbox[0].taskIds, [created.task.taskId])
  const repeated = await store.attachOutboxTasks({ groupId: 'group-a', sourceMessageId: 'm-task', taskIds: [created.task.taskId] })
  assert.deepEqual(repeated.outbox[0].taskIds, [created.task.taskId])
  await assert.rejects(store.attachOutboxTasks({ groupId: 'group-a', sourceMessageId: 'm-task', taskIds: ['task-missing'] }), /outbox_task_invalid/)
})
