import test from 'node:test'
import { assert, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, execFileSync, tmpdir, join, pathToFileURL, createHash, after, DomainFacility, assertSupportedJsonSchema, buildTaskAssociationIndex, openResidentRuntime, residentSessionId, openResidentStore, resolveTopicMessages, taskSessionId, stagePlanFor, taskReports, taskPlanFixture, stageOutputFixture, fingerprint, stableId, startDwsBridge, agentWorkspace, replacementWorkspace, memoryFacility, immediate, until, setup, ingest, route, decide, createTask, workflowAssessment, statusLlm, statusReply, taskWithWorkflow, inputVersion, directLeafCall, prepareFixturePlan, rawLeafCall, leafCall, blockedItem, checkpoint, fullCheckpoints, completeResult, persistedCompletedTask, submitNotification } from './fixtures/runtime-mixed.js'

test('叶子登记的 worktree 在归档失败时保留，修复后迁出文档并删除目录', async t => {
  const h = await setup(t)
  const task = await createTask(h, 'worktree-archive')
  const root = mkdtempSync(join(agentWorkspace, 'archive-fixture-'))
  const primary = join(root, 'primary')
  const remote = join(root, 'remote.git')
  const location = join(agentWorkspace, 'worktrees', `task-${task.taskId}`)
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  mkdirSync(primary)
  mkdirSync(join(agentWorkspace, 'worktrees'), { recursive: true })
  git(root, 'init', '--bare', remote)
  git(primary, 'init')
  git(primary, 'config', 'user.name', 'Test')
  git(primary, 'config', 'user.email', 'test@example.test')
  writeFileSync(join(primary, 'README.md'), 'base\n')
  git(primary, 'add', '.')
  git(primary, 'commit', '-m', 'base')
  git(primary, 'remote', 'add', 'origin', remote)
  git(primary, 'push', '-u', 'origin', 'HEAD:refs/heads/main')
  git(primary, 'worktree', 'add', '-b', `task-${task.taskId}`, location)
  git(location, 'push', '-u', 'origin', `task-${task.taskId}`)
  const doc = join(location, 'docs', 'spec', 'plan.md')
  mkdirSync(join(location, 'docs', 'spec'), { recursive: true })
  writeFileSync(doc, '归档方案\n')
  const leaf = h.handles.get(task.childSessionId)
  await assert.rejects(leaf.tools.get('task_worktree_register').execute({ inputVersion: task.inputVersion, runSequence: task.runSequence, location, createdByTask: true, documents: ['docs/spec/../secret.md'] }, { agent: leaf.agent }), /invalid_document_source/)
  await leaf.tools.get('task_worktree_register').execute({ inputVersion: task.inputVersion, runSequence: task.runSequence, location, createdByTask: true, documents: ['docs/spec/plan.md'] }, { agent: leaf.agent })
  assert.equal(h.store.getTask(task.taskId).localWorktrees[0].path, location)
  const restoredStore = await openResidentStore(memoryFacility(h.snapshot))
  assert.equal(restoredStore.getTask(task.taskId).localWorktrees[0].path, location)
  const secondLocation = `${location}-second`
  git(primary, 'worktree', 'add', '-b', `task-${task.taskId}-second`, secondLocation)
  git(secondLocation, 'push', '-u', 'origin', `task-${task.taskId}-second`)
  await leaf.tools.get('task_worktree_register').execute({ inputVersion: task.inputVersion, runSequence: task.runSequence, location: secondLocation, createdByTask: true, documents: [] }, { agent: leaf.agent })
  const borrower = await createTask(h, 'borrowed-worktree')
  await h.store.updateTask(borrower.taskId, current => ({ ...current, localWorktrees: [{ ...h.store.getTask(task.taskId).localWorktrees[0], ownerTaskId: current.taskId, createdByTask: false }] }))
  writeFileSync(join(location, 'README.md'), 'dirty\n')
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'archive-fixture-cancel', topicRefs: task.topicRefs, ...inputVersion(task), reason: '测试取消与清理' })
  await until(() => h.store.getTask(task.taskId).archiveCleanup?.status === 'failed')
  assert.match(h.store.getTask(task.taskId).archiveCleanup.error, /worktree_in_use_by_other_task/)
  await h.store.updateTask(borrower.taskId, current => ({ ...current, localWorktrees: [] }))
  await assert.rejects(h.runtime.archiveTask({ taskId: task.taskId }), /worktree_dirty_code/)
  assert.equal(h.store.getTask(task.taskId).archiveCleanup.status, 'failed')
  assert.equal(h.store.getTask(task.taskId).archivedAt, undefined)
  assert.equal(existsSync(location), true)
  git(location, 'checkout', '--', 'README.md')
  writeFileSync(join(secondLocation, 'README.md'), 'second dirty\n')
  await assert.rejects(h.runtime.archiveTask({ taskId: task.taskId }), /worktree_dirty_code/)
  assert.equal(existsSync(location), true, '后续目录预检失败不能删除首个目录')
  assert.equal(existsSync(doc), true)
  git(secondLocation, 'checkout', '--', 'README.md')
  git(primary, 'worktree', 'remove', secondLocation)
  await h.store.updateTask(task.taskId, current => ({ ...current, localWorktrees: current.localWorktrees.filter(entry => entry.path !== secondLocation) }))
  const archived = await h.runtime.archiveTask({ taskId: task.taskId })
  assert.equal(archived.archiveCleanup.status, 'completed')
  assert.equal(archived.localWorktrees[0].status, 'cleaned')
  assert.equal(existsSync(location), false)
  assert.equal(existsSync(archived.localWorktrees[0].documents[0].archivePath), true)
  t.after(() => rmSync(root, { recursive: true, force: true }))
})

test('内部审阅预算故障由 Host 暂停并一次通知，叶子重复提交不能耗尽轮次', async t => {
  const original = await setup(t), task = await createTask(original, 'system-failure')
  const preparedPlan = await prepareFixturePlan(original, task, task.stageTasks)
  await original.store.updateTask(task.taskId, current => ({ ...current, executionEvents: [...(current.executionEvents ?? []),
    { kind: 'task-report-received', submissionId: 'system-plan', digest: 'fixed', reportType: 'checkpoint', value: { ...inputVersion(task),
      kind: 'plan-confirmed', plan: preparedPlan, summary: '保持原计划', remainingItems: task.stageTasks, completedItems: [], evidence: [], nextStep: '等待审阅',
      needsCoordinatorDecision: false, workflowAssessment: workflowAssessment(task) },
      inputVersion: task.inputVersion, runSequence: task.runSequence, at: new Date().toISOString(), status: 'review-wait' },
    { kind: 'task-report-settled', submissionId: 'system-plan', inputVersion: task.inputVersion, runSequence: task.runSequence,
      status: 'failed', error: 'topic_context_budget_exceeded', at: new Date().toISOString() },
  ] }))
  await original.runtime.close()
  const h = await setup(t, { snapshot: original.snapshot, goals: original.goals })
  await until(() => h.store.getTask(task.taskId).state === 'waiting')
  const paused = h.store.getTask(task.taskId)
  assert.equal(paused.waitingKind, 'system')
  assert.equal(h.runtime.getTaskReport({ taskId: task.taskId, submissionId: 'system-plan' }).reviewStatus, 'failed')
  assert.ok(h.goals.get(task.childSessionId).phase === 'blocked')
  const notices = () => h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith(`task-system:${task.taskId}:`))
  await until(() => notices().length === 1)
  assert.match(notices()[0].text, /插件内部故障已暂停/u)
  for (let i = 0; i < 100; i++) await assert.rejects(rawLeafCall(h, task, 'submit_task_checkpoint', {
    ...inputVersion(task), submissionId: `repeat-${i}`, kind: 'plan-confirmed', plan: preparedPlan, summary: '重复改稿', remainingItems: task.stageTasks, nextStep: '等待审阅',
    workflowAssessment: workflowAssessment(task),
  }), /task_system_waiting/u)
  assert.equal(h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'task-report-received').length, 1)
  assert.equal(notices().length, 1)
  const other = await createTask(h, 'independent-task')
  assert.equal(other.state, 'running')
  await h.store.updateTask(other.taskId, current => ({ ...current, state: 'completed', completion: '独立任务已结束' }))
  const retry = await h.runtime.retryTaskReport({ taskId: task.taskId, submissionId: 'system-plan' })
  assert.equal(retry.reviewStatus, 'pending')
  assert.equal(notices()[0].status, 'superseded')
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '故障修复后按原目标审阅通过' } })).status, 'accepted')
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: 'system-plan' }).reviewStatus === 'approved')
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.store.listAlerts().filter(item => item.taskId === task.taskId && item.fingerprint.startsWith('task-system-failure:') && item.status !== 'resolved').length, 0)
})

test('系统等待恢复先只读构造原报告，预算仍超限时不解除等待或建立模型会话', async t => {
  const h = await setup(t), task = await createTask(h, 'preflight-budget')
  const promptRef = { id: 'large-prompt-'.repeat(5000), revision: 1 }
  // 故障注入：合法字符串身份使未读流程提示本身超过信封预算。
  h.store.getTaskPrompts = () => [{ ...promptRef, enabled: true, name: 'large', description: '', prompt: '规则' }]
  const value = { ...inputVersion(task), kind: 'plan-confirmed', summary: '原计划', remainingItems: task.stageTasks,
    completedItems: [], evidence: [], nextStep: '等待审阅', needsCoordinatorDecision: false, workflowAssessment: { ...workflowAssessment(task), promptRefs: [promptRef] } }
  await h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'system', waitingReason: 'task_review_envelope_too_large', taskPromptRefs: [promptRef],
    executionEvents: [...(current.executionEvents ?? []), { kind: 'task-report-received', submissionId: 'budget-original', digest: 'fixed', reportType: 'checkpoint', value,
      ...inputVersion(task), at: new Date().toISOString(), status: 'failed', error: 'task_review_envelope_too_large' }] }))
  const before = JSON.stringify(h.store.getTask(task.taskId)), groupBefore = JSON.stringify(h.store.getGroup('g')), sessions = h.calls.length
  for (let i = 0; i < 3; i++) await assert.rejects(h.runtime.retryTaskReport({ taskId: task.taskId, submissionId: 'budget-original' }), /task_review_envelope_too_large/)
  assert.equal(JSON.stringify(h.store.getTask(task.taskId)), before)
  assert.equal(JSON.stringify(h.store.getGroup('g')), groupBefore)
  assert.equal(h.calls.length, sessions)
})

test('系统等待恢复拒绝旧输入、待授权和未归类撤销消息，失败不产生报告重试事件', async t => {
  for (const scenario of ['stale', 'authorization', 'pending-input']) await t.test(scenario, async child => {
    const h = await setup(child), task = await createTask(h, `preflight-${scenario}`)
    const value = { ...inputVersion(task), kind: 'plan-confirmed', summary: '原计划', remainingItems: task.stageTasks,
      completedItems: [], evidence: [], nextStep: '等待审阅', needsCoordinatorDecision: false, workflowAssessment: workflowAssessment(task) }
    await h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'system', waitingReason: 'topic_context_budget_exceeded',
      ...(scenario === 'stale' ? { inputVersion: task.inputVersion + 1 } : {}),
      ...(scenario === 'authorization' ? { humanBlocker: { requestId: 'approval-pending', category: 'redline', requestedAction: '重新批准', status: 'waiting-reply' } } : {}),
      executionEvents: [...(current.executionEvents ?? []), { kind: 'task-report-received', submissionId: 'blocked-original', digest: 'fixed', reportType: 'checkpoint', value,
        ...inputVersion(task), at: new Date().toISOString(), status: 'failed', error: 'topic_context_budget_exceeded' }] }))
    if (scenario === 'pending-input') await h.store.ingest({ groupId: 'g', messageId: 'cancel-before-retry', text: '@助理 取消授权，停止任务', occurredAt: new Date().toISOString() })
    const before = JSON.stringify(h.store.getTask(task.taskId)), sessions = h.calls.length
    await assert.rejects(h.runtime.retryTaskReport({ taskId: task.taskId, submissionId: 'blocked-original' }), scenario === 'stale' ? /task_report_retry_stale/ : scenario === 'authorization' ? /task_report_retry_authorization_pending/ : /task_input_pending/)
    assert.equal(JSON.stringify(h.store.getTask(task.taskId)), before)
    assert.equal(h.calls.length, sessions)
  })
})

test('活动投影从 DSH 工具结果关联真实工具名与错误位', async t => {
  const h = await setup(t), task = await createTask(h, 'activity-result')
  const session = h.handles.get(task.childSessionId).agent.session
  const observer = h.events.get('session/event')
  session.append('tool/call', { callId: 'tool-1', name: 'group_topic_context_get' })
  session.snapshotEvents().at(-1).time = 1000
  observer(session, session.snapshotEvents().at(-1))
  session.append('tool/result', {
    message: { source: { kind: 'tool', callId: 'tool-1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'synthetic error' }] }] },
  })
  const result = session.snapshotEvents().at(-1)
  result.time = 1250
  observer(session, result)
  await h.runtime.flushActivities()
  const projected = h.store.listActivities(task.taskId).find(item => item.eventKey === `${task.childSessionId}:${result.seq}`)
  assert.deepEqual(projected.detail, { tool: 'group_topic_context_get', isError: true, callId: 'tool-1', durationMs: 250, resultSizeBytes: Buffer.byteLength(JSON.stringify(result.data.message.content[0].content)) })
})

test('活动落盘失败暂停后续投影，故障消失按原事件顺序补齐并清除当前告警', async t => {
  const h = await setup(t), task = await createTask(h, 'activity-recovery')
  const session = h.handles.get(task.childSessionId).agent.session
  const observer = h.events.get('session/event')
  const record = h.store.recordActivity.bind(h.store)
  let blocked = true, attempts = 0
  h.store.recordActivity = async input => {
    attempts += 1
    if (blocked) throw new Error('EPERM: synthetic rename failure')
    return record(input)
  }
  session.append('tool/call', { callId: 'recover-1', name: 'read' })
  const first = session.snapshotEvents().at(-1)
  observer(session, first)
  session.append('tool/result', { message: { source: { callId: 'recover-1' }, content: [{ type: 'tool-result', isError: false }] } })
  const second = session.snapshotEvents().at(-1)
  observer(session, second)
  await h.runtime.flushActivities()
  assert.equal(attempts, 3)
  assert.equal(h.store.listActivities(task.taskId).length, 0)
  assert.equal(h.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 1)
  blocked = false
  await h.runtime.reconcileActivityProjections({ force: true })
  const recovered = h.store.listActivities(task.taskId)
  assert.deepEqual(recovered.map(item => item.seq), [first.seq, second.seq])
  assert.equal(h.store.getTask(task.taskId).activityProjection.sessions[task.childSessionId].lastSeq, second.seq)
  assert.equal(h.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 0)
  await h.runtime.reconcileActivityProjections({ force: true })
  assert.equal(h.store.listActivities(task.taskId).length, 2)
})

test('活动故障跨 Runtime 重启从 Session 原事件补投影', async t => {
  const original = await setup(t), task = await createTask(original, 'activity-restart')
  const session = original.handles.get(task.childSessionId).agent.session
  const observer = original.events.get('session/event')
  original.store.recordActivity = async () => { throw new Error('EPERM: synthetic persistent failure') }
  session.append('tool/call', { callId: 'after-restart', name: 'read' })
  observer(session, session.snapshotEvents().at(-1))
  session.append('tool/result', { message: { source: { callId: 'after-restart' }, content: [{ type: 'tool-result', isError: false }] } })
  observer(session, session.snapshotEvents().at(-1))
  await original.runtime.flushActivities()
  assert.equal(original.store.listActivities(task.taskId).length, 0)
  const events = new Map([[task.childSessionId, session.snapshotEvents()]])
  await original.runtime.close()
  const restored = await setup(t, { snapshot: original.snapshot, goals: original.goals, sessionEvents: events })
  await restored.runtime.flushActivities()
  assert.equal(restored.store.listActivities(task.taskId).length, 2)
  assert.equal(restored.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 0)
})

test('已完成任务重启后从持久 Session 审计并补齐遗漏活动', async t => {
  const original = await setup(t), task = await createTask(original, 'completed-activity-restart')
  const session = original.handles.get(task.childSessionId).agent.session
  session.append('tool/call', { callId: 'completed-replay', name: 'read' })
  const missing = session.snapshotEvents().at(-1)
  await original.store.updateTask(task.taskId, value => ({ ...value, state: 'completed' }))
  const sessionEvents = new Map([[task.childSessionId, session.snapshotEvents()]])
  await original.runtime.close()
  let disposed = 0
  const restored = await setup(t, { snapshot: original.snapshot, sessionPersistence: {
    async open(id, access) { assert.equal(access, 'read'); return { header: { id }, inheritedEventCount: 0, async read() { return { events: sessionEvents.get(String(id)) } }, async close() { disposed += 1 } } },
  } })
  assert.equal(restored.store.listActivities(task.taskId).length, 0)
  await restored.runtime.reconcileActivityProjections({ force: true })
  assert.equal(restored.store.listActivities(task.taskId).find(item => item.seq === missing.seq)?.detail.tool, 'read')
  assert.equal(restored.store.getTask(task.taskId).activityProjection.sessions[task.childSessionId].lastSeq, missing.seq)
  assert.equal(disposed, 1)
  assert.equal(restored.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 0)
})

test('历史已完成任务的 Session 不存在时审计收束为不可回填，不反复报当前写盘故障', async t => {
  const original = await setup(t), task = await createTask(original, 'missing-completed-session')
  await original.store.updateTask(task.taskId, value => ({ ...value, state: 'completed' }))
  await original.runtime.close()
  let attempts = 0
  const restored = await setup(t, { snapshot: original.snapshot, sessionPersistence: {
    async open(id) { attempts += 1; throw Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError', sessionId: id }) },
  } })
  await restored.runtime.reconcileActivityProjections({ force: true })
  await restored.runtime.reconcileActivityProjections({ force: true })
  assert.equal(attempts, 1)
  assert.deepEqual(restored.runtime.getActivityAuditStatus(), { total: 1, pending: 0, audited: 0,
    unavailable: [{ taskId: task.taskId, reason: 'session-not-found' }] })
  assert.equal(restored.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 0)
})

test('已完成任务的持久 Session 读取故障仍保留重试和当前告警', async t => {
  const original = await setup(t), task = await createTask(original, 'completed-session-read-failure')
  await original.store.updateTask(task.taskId, value => ({ ...value, state: 'completed' }))
  await original.runtime.close()
  let attempts = 0
  const restored = await setup(t, { snapshot: original.snapshot, sessionPersistence: {
    async open() { attempts += 1; throw new Error('EPERM: synthetic read failure') },
  } })
  await restored.runtime.reconcileActivityProjections({ force: true })
  await restored.runtime.reconcileActivityProjections({ force: true })
  assert.equal(attempts, 2)
  assert.equal(restored.runtime.getActivityAuditStatus().pending, 1)
  assert.deepEqual(restored.runtime.getActivityAuditStatus().unavailable, [])
  assert.equal(restored.runtime.listRecoveryIssues().filter(issue => issue.kind === 'activity-projection').length, 1)
})

test('关联状态追问走同模型无工具短路径，事实未变才写入统一 Outbox', async t => {
  const calls = [], h = await setup(t, { llm: statusLlm(statusReply, calls) })
  const task = await createTask(h)
  const before = h.messages().filter(message => message.content[0].text.startsWith('[GROUP_TOPIC_DECISION]')).length
  await ingest(h, 'status-question', { text: '状态查错了吧？' })
  await route(h, { 'status-question': task.topicRefs[0].topicId })
  await until(() => h.store.getGroup('g').outbox.some(item => item.text.startsWith('已有部署证据')))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].tools, [])
  assert.equal(calls[0].provider, 'fake'); assert.equal(calls[0].model, 'fake')
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
  assert.equal(h.messages().filter(message => message.content[0].text.startsWith('[GROUP_TOPIC_DECISION]')).length, before)
  const input = JSON.parse(calls[0].messages[0].content[0].text)
  assert.deepEqual(input.sourceMessageIds, ['status-question'])
  assert.equal(input.taskSnapshots[0].taskId, task.taskId)
  assert.ok(h.resident().agent.session.snapshotEvents().some(event => event.type === 'status-query/finish' && event.data.outcome === 'accepted'))
})

test('短路径识别执行请求后交还常驻，不创建动作或发送推测回复', async t => {
  const calls = [], h = await setup(t, { llm: statusLlm(() => ({ kind: 'handoff', reason: '请求执行操作' }), calls) })
  const task = await createTask(h)
  await ingest(h, 'do-work', { text: '重新部署到生产' })
  await route(h, { 'do-work': task.topicRefs[0].topicId })
  await until(() => h.envelope('[GROUP_TOPIC_DECISION]')?.messages.some(message => message.messageId === 'do-work'))
  assert.equal(calls.length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
})

test('短答生成期间 Task 事实变化，原子提交拒绝旧快照并交还常驻', async t => {
  const calls = []; let changed
  const h = await setup(t, { llm: statusLlm(async input => { await changed(); return statusReply(input) }, calls) })
  const task = await createTask(h)
  changed = () => h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'information', waitingReason: '新阻塞' }))
  await ingest(h, 'stale-status', { text: '现在进度？' })
  await route(h, { 'stale-status': task.topicRefs[0].topicId })
  await until(() => h.envelope('[GROUP_TOPIC_DECISION]')?.messages.some(message => message.messageId === 'stale-status'))
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.ok(h.resident().agent.session.snapshotEvents().some(event => event.type === 'status-query/finish' && event.data.outcome === 'stale'))
})

test('短答期间关联任务集合或群职责改变，拒绝按旧集合和旧准入发言', async t => {
  for (const change of ['association', 'responsibility']) await t.test(change, async t => {
    let mutate
    const h = await setup(t, { llm: statusLlm(async input => { await mutate(); return statusReply(input) }, []) })
    const task = await createTask(h)
    const other = await createTask(h, 'other-task')
    mutate = () => change === 'association'
      ? h.store.updateTask(other.taskId, current => ({ ...current, topicRefs: [...current.topicRefs, ...task.topicRefs] }))
      : h.store.updateGroup({ groupId: 'g', responsibility: '已不再负责此事项' })
    const count = h.store.getGroup('g').outbox.length
    await ingest(h, 'changed-policy', { text: '现在什么状态？' })
    await route(h, { 'changed-policy': task.topicRefs[0].topicId })
    await until(() => h.envelope('[GROUP_TOPIC_DECISION]')?.messages.some(message => message.messageId === 'changed-policy'))
    assert.equal(h.store.getGroup('g').outbox.length, count)
    assert.ok(h.resident().agent.session.snapshotEvents().some(event => event.type === 'status-query/finish' && event.data.outcome === 'stale'))
  })
})

test('纯工具心跳不使只含业务事实的短答失效，短答不携带活动投影', async t => {
  let task
  const calls = [], h = await setup(t, { llm: statusLlm(async input => {
    assert.equal(input.taskSnapshots[0].activityProjection, undefined)
    await h.store.recordActivity({ taskId: task.taskId, sessionId: task.childSessionId, seq: 99, eventKey: 'heartbeat-99', type: 'tool/call', detail: { tool: 'pwsh' } })
    return statusReply(input)
  }, calls) })
  task = await createTask(h)
  await ingest(h, 'heartbeat-status', { text: '当前任务状态？' })
  await route(h, { 'heartbeat-status': task.topicRefs[0].topicId })
  await until(() => h.store.getGroup('g').outbox.some(item => item.text.startsWith('已有部署证据')))
  assert.equal(calls.length, 1)
})

test('Task 只保存固定 Topic 引用，叶子收到版本化原始上下文', async (t) => {
  const h = await setup(t), task = await createTask(h)
  assert.equal(task.state, 'running')
  for (const name of ['sourceMessageId', 'sourceMessageIds', 'triggerHistory', 'messageHistory', 'relatedContexts']) assert.equal(name in task, false)
  assert.equal(task.inputVersion, 1); assert.equal(task.runSequence, 1)
  assert.equal(task.childSessionId, taskSessionId(task.taskId))
  const leaf = h.handles.get(task.childSessionId)
  assert.ok(leaf)
  assert.equal(h.goals.get(task.childSessionId).objective, task.objective)
  const call = h.calls.find((item) => item.sessionId === task.childSessionId)
  assert.equal(call.input.meta.cwd, join(agentWorkspace, 'session-workspaces', '任务执行'))
  assert.equal(call.input.meta.parentSession, h.store.getGroup('g').residentSessionId)
  assert.equal(call.input.meta.origin, 'subagent')
  assert.ok(h.permissions.some(([sessionId, preset]) => sessionId === task.childSessionId && preset === 'danger-full-access'))
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('[TASK_TOPIC_CONTEXT]')))
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('"inputVersion":1')))
  for (const tool of leaf.tools.values()) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema) }
})

test('任务关联摘要不复制原文，按需读取返回 Topic refs 与执行约定', async (t) => {
  const h = await setup(t), task = await createTask(h, '任务范围')
  const index = buildTaskAssociationIndex([task])
  assert.deepEqual(index[0].topicRefs, task.topicRefs)
  assert.doesNotMatch(JSON.stringify(index), /messageHistory|senderOpenDingTalkId/)
  const detail = await h.call('group_task_context_get', { taskIds: [task.taskId] })
  assert.equal(detail.tasks[0].objective, task.objective)
  assert.deepEqual(detail.tasks[0].topicRefs, task.topicRefs)
  assert.equal('messageHistory' in detail.tasks[0], false)
  const assertJsonValue = (value) => {
    assert.notEqual(value, undefined)
    if (Array.isArray(value)) value.forEach(assertJsonValue)
    else if (value && typeof value === 'object') Object.values(value).forEach(assertJsonValue)
  }
  assertJsonValue(detail)
  await assert.rejects(h.call('group_task_context_get', { taskIds: [task.taskId, task.taskId] }), /group_task_context_request_duplicate/)
  await assert.rejects(h.call('group_task_context_get', { taskIds: ['missing'] }), /group_task_context_not_found/)
})

test('任务并发容量满时 FIFO 排队，取消释放名额并保留取消事实', async (t) => {
  const h = await setup(t, { maxConcurrentTasks: 2 })
  const one = await createTask(h, 'one'), two = await createTask(h, 'two'), three = await createTask(h, 'three')
  assert.deepEqual([h.store.getTask(one.taskId).state, h.store.getTask(two.taskId).state, h.store.getTask(three.taskId).state], ['running', 'running', 'queued'])
  await h.runtime.cancelTask({ taskId: one.taskId, requestId: 'cancel-one', topicRefs: one.topicRefs, ...inputVersion(h.store.getTask(one.taskId)), reason: '用户取消' })
  assert.equal(h.store.getTask(one.taskId).state, 'completed')
  await until(() => h.store.getTask(three.taskId).state === 'running')
  assert.equal(h.store.getTask(three.taskId).state, 'running')
  assert.equal(h.cancelled.filter(item => item.sessionId.startsWith('session-task-'))[0].sessionId, one.childSessionId)
})

test('Host 动作默认无适配器，显式注册后仍逐次绑定身份版本与授权', async t => {
  const h = await setup(t), task = await createTask(h)
  const input = { taskId: task.taskId, ...inputVersion(task), adapterId: 'sql', params: {}, authorizationRefs: ['source'] }
  await assert.rejects(h.runtime.prepareTaskAction(input), /adapter_unregistered/)
  assert.equal(h.handles.get(task.childSessionId).tools.has('prepare_task_action'), false)
  let allowed = false, calls = 0
  const adapter = { parseParams: value => value, normalizeResourceKeys: () => ['fixture/resource'], execute: async () => { calls += 1 }, reconcile: async () => ({ status: 'confirmed', receiptRefs: ['readback'] }) }
  const next = await setup(t, { actionAdapters: new Map([['fixture', adapter]]), authorizeTaskAction: () => allowed })
  const bound = await createTask(next)
  const value = { taskId: bound.taskId, ...inputVersion(bound), adapterId: 'fixture', params: {}, authorizationRefs: ['source'] }
  await assert.rejects(next.runtime.prepareTaskAction(value), /unauthorized/)
  allowed = true
  const intent = await next.runtime.prepareTaskAction(value)
  await assert.rejects(next.runtime.executeTaskAction({ taskId: 'another-task', actionId: intent.actionId, ...inputVersion(bound) }), /binding_invalid/)
  await assert.rejects(next.runtime.executeTaskAction({ taskId: bound.taskId, actionId: intent.actionId, ...inputVersion(bound), inputVersion: 999 }), /binding_invalid/)
  allowed = false
  await assert.rejects(next.runtime.executeTaskAction({ taskId: bound.taskId, actionId: intent.actionId, ...inputVersion(bound) }), /unauthorized/)
  assert.equal(calls, 0)
})

test('取消先持久停止再中断叶子，未知动作跨重启保留占用且读回后才终结', async t => {
  let known = false, calls = 0
  const adapter = { parseParams: value => value, normalizeResourceKeys: () => ['fixture/resource'], execute: async () => { calls += 1 }, reconcile: async () => known ? { status: 'confirmed', receiptRefs: ['target-version'] } : { status: 'unknown' } }
  const options = { actionAdapters: new Map([['fixture', adapter]]), authorizeTaskAction: () => true }
  const h = await setup(t, options), task = await createTask(h)
  const intent = await h.runtime.prepareTaskAction({ taskId: task.taskId, ...inputVersion(task), adapterId: 'fixture', params: {}, authorizationRefs: ['task-input'] })
  await h.runtime.executeTaskAction({ taskId: task.taskId, actionId: intent.actionId, ...inputVersion(task) })
  const handle = h.handles.get(task.childSessionId), originalCancel = handle.agent.cancel
  handle.agent.cancel = cause => {
    assert.ok(h.store.getTask(task.taskId).stopRequest, '任何中断前必须已经有停止事实')
    originalCancel(cause)
  }
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'cancel-action', topicRefs: task.topicRefs, ...inputVersion(task), reason: '用户撤销后续操作' })
  await until(() => h.store.getTask(task.taskId).stopRequest?.status === 'reconciling')
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).outcome, undefined)
  assert.equal(h.runtime.listTaskActions({ taskId: task.taskId })[0].status, 'unknown')
  assert.equal(h.store.getTask(task.taskId).executionEvents.find(event => event.kind === 'task-stop-requested').authorizationRefs.length, 1)
  await h.runtime.close()
  const reopened = await setup(t, { ...options, snapshot: h.snapshot })
  assert.equal(reopened.calls.filter(call => call.sessionId === task.childSessionId).length, 0, '停止恢复不能重新启动叶子')
  assert.equal(reopened.store.getTask(task.taskId).state, 'waiting')
  known = true
  await reopened.runtime.reconcileTaskAction({ taskId: task.taskId, actionId: intent.actionId, ...inputVersion(task) })
  await until(() => reopened.store.getTask(task.taskId).state === 'completed')
  assert.equal(reopened.store.getTask(task.taskId).outcome, 'cancelled')
  assert.equal(reopened.store.getTask(task.taskId).stopRequest.status, 'settled')
  assert.equal(reopened.runtime.listTaskActions({ taskId: task.taskId })[0].status, 'confirmed')
  assert.equal(calls, 1, '取消和恢复不能重复业务写入，也不假装撤销已生效操作')
})

test('取消等待非中断动作时不持有全局提交锁，独立任务仍能保存新动作', async t => {
  let finish, entered
  const started = new Promise(resolve => { entered = resolve })
  const adapter = { parseParams: value => value, normalizeResourceKeys: value => [value.resource],
    execute: () => new Promise(resolve => { finish = resolve; entered() }), reconcile: async () => ({ status: 'confirmed', receiptRefs: ['target-readback'] }) }
  const h = await setup(t, { actionAdapters: new Map([['fixture', adapter]]), authorizeTaskAction: () => true, maxConcurrentTasks: 2 })
  const task = await createTask(h, 'long-action'), other = await createTask(h, 'independent')
  const intent = await h.runtime.prepareTaskAction({ taskId: task.taskId, ...inputVersion(task), adapterId: 'fixture', params: { resource: 'long' }, authorizationRefs: ['long-action'] })
  const running = h.runtime.executeTaskAction({ taskId: task.taskId, actionId: intent.actionId, ...inputVersion(task) })
  await started
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'stop-long', topicRefs: task.topicRefs, ...inputVersion(task), reason: '停止后续操作' })
  const independent = await h.runtime.prepareTaskAction({ taskId: other.taskId, ...inputVersion(other), adapterId: 'fixture', params: { resource: 'other' }, authorizationRefs: ['independent'] })
  assert.equal(independent.status, 'prepared')
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  finish({ status: 'submitted' })
  await running
  await until(() => h.store.getTask(task.taskId).outcome === 'cancelled')
})

test('workflow 启用时在线换工作区零写拒绝，同根及模型修改仍可用', async t => {
  const h = await setup(t, { workflowGroupIds: ['g'] })
  const before = h.runtime.getAgentConfig(), calls = h.calls.length
  await assert.rejects(h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace, model: 'other' }),
    /workflow_task_workspace_change_requires_offline_migration/)
  assert.deepEqual(h.runtime.getAgentConfig(), before)
  assert.equal(h.calls.length, calls)
  assert.equal(h.store.getAgentWorkspaceDir(), agentWorkspace)
  const updated = await h.runtime.updateAgentConfig({ workspaceDir: agentWorkspace, model: 'other' })
  assert.equal(updated.workspaceDir, agentWorkspace)
  assert.equal(updated.model, 'other')
})

test('工作区切换保留事件历史并重建 Resident，旧 Session 释放', async (t) => {
  const h = await setup(t), oldId = h.store.getGroup('g').residentSessionId
  assert.deepEqual(h.permissions, [[oldId, 'danger-full-access']])
  h.resident().agent.session.append('turn/end', { status: 'success' })
  h.idle.set(oldId, Promise.resolve())
  const result = await h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  assert.equal(result.workspaceDir, replacementWorkspace)
  assert.notEqual(h.store.getGroup('g').residentSessionId, oldId)
  const replacement = h.calls.at(-1)
  assert.equal(replacement.input.meta.cwd, join(replacementWorkspace, 'session-workspaces', '群聊常驻'))
  assert.deepEqual(h.permissions.at(-1), [h.store.getGroup('g').residentSessionId, 'danger-full-access'])
  assert.ok(replacement.input.seed.some((event) => event.type === 'turn/end'))
  assert.ok(h.disposed.includes(oldId))
})

test('存在活动 Task 时仍保存默认模型并在下一请求生效，工作区切换继续拒绝', async (t) => {
  const h = await setup(t); const task = await createTask(h)
  const leaf = h.handles.get(task.childSessionId)
  const assembledBefore = await leaf.hooks.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }))
  assert.equal(assembledBefore.variables.model, 'fake')
  await assert.rejects(h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }), /agent_config_has_active_tasks/)
  const saved = await h.runtime.updateAgentConfig({ model: 'other', reasoningEffort: 'high' })
  assert.equal(h.runtime.getAgentConfig().workspaceDir, agentWorkspace)
  assert.equal(h.runtime.getAgentConfig().model, 'other')
  assert.deepEqual(h.savedSelection, { provider: 'fake', model: 'other', reasoningEffort: 'high' })
  const inFlight = await leaf.hooks.get('agent/request')({}, async () => ({ provider: 'fake', model: 'fake', reasoningEffort: 'low' }))
  assert.equal(inFlight.model, 'fake', '配置变化不能改写已经完成system-prompt组装的在途请求')
  const assembledAfter = await leaf.hooks.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }))
  assert.equal(assembledAfter.variables.model, 'other')
  const nextRequest = await leaf.hooks.get('agent/request')({}, async () => ({ provider: 'fake', model: 'fake', reasoningEffort: 'low' }))
  assert.deepEqual(nextRequest, { provider: 'fake', model: 'other', reasoningEffort: 'high' })
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.store.getTask(task.taskId).childSessionId, task.childSessionId)
})

test('叶子会话提示词通过统一配置字段保存和读取', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ leafSessionPrompt: '先核对范围，再提交可复核证据。' })
  assert.equal(saved.leafSessionPrompt, '先核对范围，再提交可复核证据。')
  assert.equal(h.runtime.getAgentConfig().leafSessionPrompt, '先核对范围，再提交可复核证据。')
  assert.equal('taskExecutionGuidance' in saved, false)
  assert.equal('taskEvidenceGuidance' in saved, false)
})

test('内置通用规范不依赖用户补充，动态清空及恢复后仍只注入叶子', async (t) => {
  const h = await setup(t)
  const task = await createTask(h, 'builtin-leaf-prompt')
  const text = (handle) => handle.sections.map((section) => typeof section.text === 'function' ? section.text() : section.text).join('\n')
  const leaf = h.handles.get(task.childSessionId)
  const builtin = '### 叶子会话内置通用规范'
  const custom = '用户定制唯一标识：交付报告使用表格。'
  assert.equal(h.runtime.getAgentConfig().leafSessionPrompt, '')
  assert.ok(text(leaf).includes(builtin))
  assert.match(text(leaf), /主动检验反例/)
  assert.doesNotMatch(text(leaf), /### 用户补充的叶子会话提示词/)
  await h.runtime.updateAgentConfig({ leafSessionPrompt: custom })
  assert.equal(text(leaf).split(builtin).length, 2)
  assert.equal(text(leaf).split(custom).length, 2)
  assert.ok(!text(h.resident()).includes(builtin))
  assert.ok(!text(h.resident()).includes(custom))
  await h.runtime.close()
  const recovered = await setup(t, { snapshot: h.snapshot, goals: h.goals, sessionEvents: new Map() })
  const restored = recovered.handles.get(task.childSessionId)
  assert.equal(text(restored).split(builtin).length, 2)
  assert.equal(text(restored).split(custom).length, 2)
  await recovered.runtime.updateAgentConfig({ leafSessionPrompt: '' })
  assert.ok(text(restored).includes(builtin))
  assert.ok(!text(restored).includes(custom))
  assert.doesNotMatch(text(restored), /### 用户补充的叶子会话提示词/)
})

test('叶子只常驻流程索引，按需加载后直接动态注入当前正文', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ taskPrompts: [
    { name: '问题排查', description: '只定位原因时使用', prompt: '排查正文唯一标识', enabled: true },
    { name: '实施修复', description: '已授权修复时使用', prompt: '修复正文唯一标识', enabled: true },
  ], taskPromptsVersion: 0 })
  const task = await createTask(h, 'prompt-task')
  const leaf = h.handles.get(task.childSessionId)
  const systemText = leaf.sections.map((section) => section.text()).join('\n')
  assert.match(systemText, /问题排查/)
  assert.doesNotMatch(systemText, /排查正文唯一标识|修复正文唯一标识/)
  const prompt = saved.taskPrompts[0]
  const loaded = await leafCall(h, task, 'load_task_prompt', { id: prompt.id })
  assert.equal(loaded.prompt, '排查正文唯一标识')
  assert.deepEqual(Object.keys(loaded).sort(), ['description', 'id', 'name', 'prompt', 'revision'])
  assert.deepEqual(h.store.getTask(task.taskId).taskPromptRefs, [{ id: prompt.id, revision: 1 }])
  assert.match(leaf.sections.map((section) => section.text()).join('\n'), /排查正文唯一标识/)
  assert.doesNotMatch(leaf.sections.map((section) => section.text()).join('\n'), /修复正文唯一标识/)
})

test('长任务可组合超过五个流程，重复加载去重，恢复后保留组合并按阶段裁减', async (t) => {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: Array.from({ length: 7 }, (_, index) => ({ name: `流程${index}`, description: `阶段${index}`, prompt: `组合正文-${index}-结束`, enabled: true })), taskPromptsVersion: 0 })
  const task = await createTask(h, 'composed-workflow')
  const loaded = config.taskPrompts.slice(0, 6)
  for (const prompt of [...loaded, loaded[0]]) await leafCall(h, task, 'load_task_prompt', { id: prompt.id })
  assert.deepEqual(h.store.getTask(task.taskId).taskPromptRefs, loaded.map(({ id, revision }) => ({ id, revision })))
  await leafCall(h, task, 'select_task_prompts', { inputVersion: 1, ids: loaded.map(({ id }) => id), reason: '当前长流程由六项规则组合' })
  // 无历史工具结果也能重建当前流程组合，覆盖压缩后不依赖工具历史的恢复路径。
  await h.runtime.close()
  const recovered = await setup(t, { snapshot: h.snapshot, goals: h.goals, sessionEvents: new Map() })
  const text = () => recovered.handles.get(task.childSessionId).sections.map((section) => section.text()).join('\n')
  for (const prompt of loaded) assert.ok(text().includes(prompt.prompt))
  assert.ok(!text().includes(config.taskPrompts[6].prompt))
  await leafCall(recovered, task, 'select_task_prompts', { inputVersion: 1, ids: [loaded[5].id], reason: '前面阶段已完成，只需最后阶段规则' })
  assert.ok(text().includes(loaded[5].prompt))
  assert.ok(!text().includes(loaded[0].prompt))
  await leafCall(recovered, task, 'load_task_prompt', { id: config.taskPrompts[6].id })
  assert.ok(text().includes(config.taskPrompts[6].prompt))
})

test('流程加载与组合调整排队期间目标变化时拒绝迟到写入', async (t) => {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: [{ name: '排查', description: '排查目标', prompt: '排查正文', enabled: true }], taskPromptsVersion: 0 })
  const task = await createTask(h, 'prompt-stale-update')
  await leafCall(h, task, 'load_task_prompt', { id: config.taskPrompts[0].id })
  const original = h.store.updateTask
  h.store.updateTask = async (id, transform) => {
    await original(id, (value) => ({ ...value, inputVersion: value.inputVersion + 1, taskPromptRefs: [] }))
    return original(id, transform)
  }
  await assert.rejects(leafCall(h, task, 'load_task_prompt', { id: config.taskPrompts[0].id }), /task_prompt_selection_stale/)
  await assert.rejects(leafCall(h, task, 'select_task_prompts', { inputVersion: 2, ids: [], reason: '当前无适用规则' }), /task_prompt_selection_stale/)
  assert.deepEqual(h.store.getTask(task.taskId).taskPromptRefs, [])
})

test('流程修订后旧选择失效，拒绝叶子用旧流程完成任务', async (t) => {
  const h = await setup(t)
  const first = await h.runtime.updateAgentConfig({ taskPrompts: [{ name: '问题排查', description: '定位原因', prompt: '第一版流程', enabled: true }], taskPromptsVersion: 0 })
  const task = await createTask(h, 'prompt-revision')
  await leafCall(h, task, 'load_task_prompt', { id: first.taskPrompts[0].id })
  await leafCall(h, task, 'select_task_prompts', { inputVersion: 1, ids: [first.taskPrompts[0].id], reason: '按排查流程执行' })
  await h.runtime.updateAgentConfig({ taskPrompts: [{ ...first.taskPrompts[0], prompt: '第二版流程' }], taskPromptsVersion: first.taskPromptsVersion })
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'], artifacts: [] }), /task_prompt_selection_stale/)
})

test('计划绑定已选流程，主会话读完同一流程正文后才可审阅', async (t) => {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: [{ id: 'workflow-uat', name: 'UAT 交付', description: '部署后只检查启动和访问', prompt: '部署后不重复业务 E2E。', enabled: true }], taskPromptsVersion: 0 })
  let task = await createTask(h, 'uat-plan')
  await leafCall(h, task, 'load_task_prompt', { id: config.taskPrompts[0].id }); task = h.store.getTask(task.taskId)
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '缺少流程声明', completedItems: [], evidence: [], remainingItems: ['部署'], nextStep: '部署', needsCoordinatorDecision: false }), /task_workflow_assessment_required/)
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '伪造例外来源', completedItems: [], evidence: [], remainingItems: ['部署'], nextStep: '部署', needsCoordinatorDecision: false,
    workflowAssessment: workflowAssessment(task, { exceptions: [{ requirement: 'UAT 重跑业务 E2E', basisMessageIds: ['not-a-topic-message'], reason: '主会话要求' }] }) }), /task_workflow_exception_basis_invalid/)
  const pending = leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '按 UAT 流程部署', completedItems: [], evidence: [], remainingItems: ['部署并检查访问'], nextStep: '部署', needsCoordinatorDecision: false, workflowAssessment: workflowAssessment(task) })
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '计划一致' } })).status, 'prompt-review-required')
  assert.equal((await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['workflow-uat'] })).prompts[0].prompt, '部署后不重复业务 E2E。')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '原始消息与流程一致' } })).status, 'accepted')
  assert.equal((await pending).accepted, true)
})

test('主会话可拒绝自行扩写的冲突计划，叶子重新规划前不能推进', async (t) => {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: [{ id: 'workflow-uat', name: 'UAT 交付', description: '部署提测', prompt: '部署后不重复业务 E2E。', enabled: true }], taskPromptsVersion: 0 })
  let task = await createTask(h, 'deploy-uat')
  await leafCall(h, task, 'load_task_prompt', { id: config.taskPrompts[0].id }); task = h.store.getTask(task.taskId)
  const pending = leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '部署后在 UAT 重跑完整业务 E2E', completedItems: [], evidence: [], remainingItems: ['部署', 'UAT 业务 E2E'], nextStep: '部署', needsCoordinatorDecision: true, workflowAssessment: workflowAssessment(task) })
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['workflow-uat'] })
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'reject', reason: '原始消息只要求部署，完整 UAT E2E 是主会话扩写' } })
  const rejected = await pending
  assert.equal(rejected.code, 'task_checkpoint_rejected')
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: h.store.getTask(task.taskId).plan?.stages[0].title ?? task.stageTasks[0], summary: '已部署', completedItems: ['部署'], evidence: ['服务正常'], remainingItems: ['UAT 业务 E2E'], nextStep: 'E2E', needsCoordinatorDecision: false }), /task_checkpoint_plan_required/)
  assert.ok(h.handles.get(task.childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_PLAN_REJECTED]')))
})

test('流程修订只使引用任务的旧计划失效，未引用任务不接收更新', async (t) => {
  const h = await setup(t, { maxConcurrentTasks: 2 })
  const first = await h.runtime.updateAgentConfig({ taskPrompts: [{ id: 'workflow-uat', name: 'UAT 交付', description: '部署提测', prompt: '第一版', enabled: true }], taskPromptsVersion: 0 })
  let selected = await createTask(h, 'selected'), unrelated = await createTask(h, 'unrelated')
  await leafCall(h, selected, 'load_task_prompt', { id: 'workflow-uat' }); selected = h.store.getTask(selected.taskId)
  const plan = leafCall(h, selected, 'submit_task_checkpoint', { ...inputVersion(selected), kind: 'plan-confirmed', summary: '第一版计划', completedItems: [], evidence: [], remainingItems: ['部署'], nextStep: '部署', needsCoordinatorDecision: false, workflowAssessment: workflowAssessment(selected) })
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求'); await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['workflow-uat'] })
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } }); await plan
  const selectedMessages = h.handles.get(selected.childSessionId).sent.length, unrelatedMessages = h.handles.get(unrelated.childSessionId).sent.length
  const second = await h.runtime.updateAgentConfig({ taskPrompts: [{ ...first.taskPrompts[0], prompt: '第二版' }], taskPromptsVersion: first.taskPromptsVersion })
  assert.ok(h.handles.get(selected.childSessionId).sent.length > selectedMessages)
  assert.equal(h.handles.get(unrelated.childSessionId).sent.length, unrelatedMessages)
  await leafCall(h, selected, 'load_task_prompt', { id: second.taskPrompts[0].id }); selected = h.store.getTask(selected.taskId)
  await assert.rejects(leafCall(h, selected, 'submit_task_checkpoint', { ...inputVersion(selected), kind: 'stage-completed', stageTask: selected.stageTasks[0], summary: '继续旧计划', completedItems: ['部署'], evidence: ['证据'], remainingItems: [], nextStep: '完成', needsCoordinatorDecision: false }), /task_workflow_plan_stale/)
})

test('任务目标变化保留流程引用供重审，并拒绝未加载流程', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ taskPrompts: [{ name: '问题排查', description: '定位原因', prompt: '排查流程', enabled: true }], taskPromptsVersion: 0 })
  const task = await createTask(h, 'prompt-switch')
  await assert.rejects(leafCall(h, task, 'select_task_prompts', { inputVersion: 1, ids: [saved.taskPrompts[0].id], reason: '排查' }), /task_prompt_not_loaded/)
  await leafCall(h, task, 'load_task_prompt', { id: saved.taskPrompts[0].id })
  await leafCall(h, task, 'select_task_prompts', { inputVersion: 1, ids: [saved.taskPrompts[0].id], reason: '排查' })
  const revised = await h.runtime.followupTask({ taskId: task.taskId, requestId: 'switch-to-fix', progressImpact: 'replan', topicRefs: task.topicRefs, ...inputVersion(h.store.getTask(task.taskId)), text: '用户明确要求修复', title: '修复已定位问题', objective: '修复已定位的问题', acceptanceCriteria: ['修复可验证'], stageTasks: ['完成修复'] })
  assert.equal(revised.inputVersion, 2)
  assert.deepEqual(revised.taskPromptRefs, h.store.getTask(task.taskId).taskPromptRefs)
  assert.equal(revised.taskPromptRefs[0].id, saved.taskPrompts[0].id)
  assert.deepEqual(revised.checkpoints, [])
})

test('流程修改、禁用和删除后未重新加载也不能推进旧阶段', async (t) => {
  for (const change of ['modify', 'disable', 'delete']) await t.test(change, async (t) => {
    const { h, task, config } = await taskWithWorkflow(t, change)
    await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'], workflowAssessment: workflowAssessment(task) })
    const taskPrompts = change === 'delete' ? [] : [{ ...config.taskPrompts[0], ...(change === 'disable' ? { enabled: false } : { prompt: '第二版核验要求' }) }]
    await h.runtime.updateAgentConfig({ taskPrompts, taskPromptsVersion: config.taskPromptsVersion })
    await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: h.store.getTask(task.taskId).plan?.stages[0].title ?? task.stageTasks[0], summary: '继续旧计划', completedItems: ['核验'], remainingItems: [], evidence: ['旧证据'], nextStep: '结束' }), /task_prompt_selection_stale/)
    assert.equal(h.store.getTask(task.taskId).checkpoints.length, 1)
    assert.equal((await checkpoint(h, task, { kind: 'scope-conflict', remainingItems: ['核验'], summary: '流程变化，需要协调' })).accepted, true)
  })
})

test('待审计划遇流程改版会失效并归档，重新加载后可重新规划', async (t) => {
  const { h, task, config } = await taskWithWorkflow(t, 'review-race')
  const pending = leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '第一版计划', remainingItems: ['核验'], nextStep: '核验', workflowAssessment: workflowAssessment(task) }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['audit-flow'] })
  await h.runtime.updateAgentConfig({ taskPrompts: [{ ...config.taskPrompts[0], prompt: '第二版核验要求' }], taskPromptsVersion: config.taskPromptsVersion })
  assert.match((await pending).error.message, /task_prompt_selection_stale/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.length, 0)
  assert.ok(h.store.getTask(task.taskId).executionEvents.some((event) => event.kind === 'checkpoint-review-invalidated'))
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '迟到确认' } }), /coordination_tool_wrong_request/)
  await leafCall(h, task, 'load_task_prompt', { id: 'audit-flow' })
  const updated = h.store.getTask(task.taskId)
  assert.equal((await checkpoint(h, updated, { kind: 'plan-confirmed', remainingItems: ['重新核验'], workflowAssessment: workflowAssessment(updated) })).accepted, true)
})

test('首次异常可报告但不能改变进度，随后可制定计划并正常完成', async (t) => {
  const h = await setup(t), task = await createTask(h, 'diagnostic-first')
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'scope-conflict', summary: '冲突', completedItems: ['伪造完成'], nextStep: '协调' }), /task_checkpoint_invalid:.*completedItems/)
  for (const kind of ['scope-conflict', 'evidence-gap', 'risk-changed']) assert.equal((await checkpoint(h, task, { kind, needsCoordinatorDecision: true })).accepted, true)
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '仍无计划', evidence: ['诊断不等于完成'] }), /task_checkpoint_plan_required/)
  await fullCheckpoints(h, task)
  assert.equal((await completeResult(h, task)).value.state, 'completed')
})

test('异常可抢占待审计划，旧审阅不得回写或阻止新计划', async (t) => {
  const h = await setup(t), task = await createTask(h, 'diagnostic-preemption')
  const pending = leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '待审计划', remainingItems: ['核验'], nextStep: '核验' }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const previous = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await checkpoint(h, task, { kind: 'scope-conflict', remainingItems: [], summary: '计划未获准前发现冲突', needsCoordinatorDecision: true })).accepted, true)
  assert.match((await pending).error.message, /task_checkpoint_review_superseded/)
  await assert.rejects(h.call('group_task_review_submit', { requestId: previous.requestId, review: { decision: 'acknowledge', reason: '迟到审阅' } }), /coordination_tool_wrong_request/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.length, 1)
  assert.equal((await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['协调后核验'] })).accepted, true)
})

test('被拒计划仍能报告证据缺口，诊断确认不解除计划拒绝', async (t) => {
  const h = await setup(t), task = await createTask(h, 'rejected-diagnostic')
  const pending = leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '错误计划', remainingItems: ['核验'], nextStep: '核验' })
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'reject', reason: '范围冲突' } })
  assert.equal((await pending).accepted, false)
  assert.equal((await checkpoint(h, task, { kind: 'evidence-gap', remainingItems: ['核验'] })).accepted, true)
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: h.store.getTask(task.taskId).plan?.stages[0].title ?? task.stageTasks[0], summary: '不能绕过拒绝', completedItems: ['核验'], remainingItems: [], evidence: ['证据'], nextStep: '结束' }), /task_checkpoint_plan_required/)
})

test('完成审阅发起即记录事件，拒绝与失败也保留耗时起点', async (t) => {
  const h = await setup(t), task = await createTask(h, 'review-timing')
  await fullCheckpoints(h, task)
  const pending = leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '等待验收', evidence: ['证据'] }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  const started = h.store.getTask(task.taskId).executionEvents.findLast((event) => event.kind === 'completion-review-requested')
  assert.ok(started.at)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: false, reason: '需补证据' } })
  assert.match((await pending).error.message, /task_result_objective_not_covered/)
  const reviewed = h.store.getTask(task.taskId).executionEvents.findLast((event) => event.kind === 'completion-reviewed')
  assert.equal(reviewed.accepted, false)
  assert.equal(reviewed.reviewAttemptId, started.reviewAttemptId)
})

test('完成审阅期间流程更新保持 Task 与 Goal 活动并记录失败', async (t) => {
  const { h, task, config } = await taskWithWorkflow(t, 'completion-review-race')
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'], workflowAssessment: workflowAssessment(task) })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验', completedItems: ['核验'] })
  const pending = leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'] }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['audit-flow'] })
  await h.runtime.updateAgentConfig({ taskPrompts: [{ ...config.taskPrompts[0], prompt: '第二版' }], taskPromptsVersion: config.taskPromptsVersion })
  assert.match((await pending).error.message, /task_prompt_selection_stale/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
  assert.ok(h.store.getTask(task.taskId).executionEvents.some((event) => event.kind === 'completion-review-failed'))
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 0)
})

test('审阅通过后最后落盘前流程改变，不能完成任务或发送通知', async (t) => {
  const { h, task, config } = await taskWithWorkflow(t, 'completion-commit-race')
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'], workflowAssessment: workflowAssessment(task) })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验', completedItems: ['核验'] })
  const pending = leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'] }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['audit-flow'] })
  const candidates = await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  const original = h.store.updateTask
  let injected = false
  h.store.updateTask = async (...args) => {
    if (!injected) {
      injected = true
      await h.store.setTaskPrompts([{ ...config.taskPrompts[0], prompt: '提交瞬间改版' }], config.taskPromptsVersion)
    }
    return original(...args)
  }
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '已审阅', notification: { reply: '核验完毕', replyToMessageId: task.title, atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } })
  assert.match((await pending).error.message, /task_prompt_selection_stale/)
  assert.equal(injected, true)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 0)
})

test('重启恢复过期待审计划时归档失败项，新计划不再被 pending 卡住', async (t) => {
  const { h, task, config } = await taskWithWorkflow(t, 'recover-stale-plan')
  await h.store.updateTask(task.taskId, (current) => ({ ...current, checkpoints: [{ ...inputVersion(task), kind: 'plan-confirmed', checkpointId: 'checkpoint-before-crash', submittedAt: new Date().toISOString(), summary: '崩溃前旧计划', completedItems: [], remainingItems: ['旧核验'], evidence: [], nextStep: '核验', needsCoordinatorDecision: false, workflowAssessment: workflowAssessment(task) }] }))
  await h.store.setTaskPrompts([{ ...config.taskPrompts[0], prompt: '配置已更新但失效清理前崩溃' }], config.taskPromptsVersion)
  await h.runtime.close()
  const recovered = await setup(t, { snapshot: h.snapshot, goals: h.goals })
  await recovered.runtime.inspectRunningTasks()
  await until(() => recovered.store.getTask(task.taskId).checkpoints.length === 0)
  assert.ok(recovered.store.getTask(task.taskId).executionEvents.some((event) => event.kind === 'checkpoint-review-failed' && event.checkpoint.checkpointId === 'checkpoint-before-crash'))
  await leafCall(recovered, task, 'load_task_prompt', { id: 'audit-flow' })
  const updated = recovered.store.getTask(task.taskId)
  assert.equal((await checkpoint(recovered, updated, { kind: 'plan-confirmed', remainingItems: ['新核验'], workflowAssessment: workflowAssessment(updated) })).accepted, true)
})

test('完成审阅通过后的并发暂停不能被完成 CAS 覆盖', async (t) => {
  const h = await setup(t), task = await createTask(h, 'pause-after-review')
  await fullCheckpoints(h, task)
  const pending = leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'] }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  const candidates = await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  let pause
  const original = h.store.updateTask
  h.store.updateTask = async (...args) => {
    const updated = await original(...args)
    if (!pause && updated.executionEvents?.at(-1)?.kind === 'completion-reviewed') pause = h.runtime.waitTask({ taskId: task.taskId, reason: '用户暂停核验' })
    return updated
  }
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '证据齐全', notification: { reply: '完成', replyToMessageId: task.title, atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } })).status, 'accepted')
  assert.match((await pending).error.message, /task_not_active/)
  await pause
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 0)
})

test('报告先持久接收并停等，Topic 决策事件解除等待而无需再次提交或巡检', async t => {
  const h = await setup(t), task = await createTask(h)
  await ingest(h, 'pending-status', { text: '这项现在是什么状态？' })
  const started = performance.now()
  const value = { ...inputVersion(task), submissionId: 'saved-report', status: 'waiting', waitingKind: 'information', summary: '缺少范围', evidence: [], artifacts: [], waitingReason: '需要范围', questions: ['具体范围？'], blockedItems: [blockedItem(h, task, '需要范围')] }
  const receipt = await rawLeafCall(h, task, 'submit_task_result', value)
  assert.equal(receipt.reviewStatus, 'pending')
  assert.ok(performance.now() - started < 1000, '正常本地接收不能等待模型审阅')
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
  assert.equal(h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'task-report-received').length, 1)
  assert.deepEqual(await rawLeafCall(h, task, 'submit_task_result', value), receipt)
  const request = (await route(h, { 'pending-status': task.topicRefs[0].topicId })).pendingDecisions[0]
  await decide(h, request)
  await until(() => Boolean(h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')))
  const waitingReview = h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: waitingReview.requestId, review: { decision: 'approve-wait', reason: '当前交付仍缺必要范围' } })).status, 'accepted')
  await until(() => h.store.getTask(task.taskId).state === 'waiting')
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId }).reviewStatus === 'approved')
  assert.equal(h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'task-report-received').length, 1)
})

test('坏阶段决策在持久化前拒绝，同一请求纠正后恢复报告与正常阶段推进', async t => {
  const h = await setup(t), task = await createTask(h)
  await h.store.updateTask(task.taskId, current => ({ ...current, stagePlan: undefined }))
  const context = (await h.call('group_task_context_get', { taskIds: [task.taskId] })).tasks[0]
  assert.equal(task.checkpoints?.length ?? 0, 0, '阶段身份不代表计划已获批准')
  assert.deepEqual(context.stagePlan, stagePlanFor(task, task.stageTasks))
  const leafPrompt = h.handles.get(task.childSessionId).sections.map(section => typeof section.text === 'function' ? section.text() : section.text).join('\n')
  assert.ok(leafPrompt.includes(context.stagePlan[0].stageId), '主叶获得相同的代码生成ID')
  await ingest(h, 'revision-input')
  const request = (await route(h, { 'revision-input': task.topicRefs[0].topicId })).pendingDecisions[0]
  const action = { kind: 'task-context', taskId: task.taskId, ...inputVersion(task), context: '新增阶段验收', progressImpact: 'replan',
    impactEvidence: { basisMessageIds: ['revision-input'], reason: '当前阶段需重验', affectedStageIds: ['invented-id'] }, topicRefs: [{ topicId: request.topicId, revision: request.revision }] }
  const review = await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  const before = structuredClone(h.store.getGroup('g'))
  const submit = () => decide(h, request, { actions: [action], reply: '已关联补充输入。', replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId) } })
  assert.equal((await submit()).status, 'invalid-arguments')
  assert.deepEqual(h.store.getGroup('g'), before, '拒绝不能写决策、预约、确认或已消费状态')
  action.impactEvidence.affectedStageIds = [context.stagePlan[0].stageId]
  assert.equal((await submit()).status, 'accepted')
  const current = h.store.getTask(task.taskId)
  assert.equal(current.inputVersion, task.inputVersion + 1)
  await checkpoint(h, current, { kind: 'plan-confirmed', remainingItems: current.stageTasks })
  const stage = h.store.getTask(task.taskId).stagePlan[0]
  await checkpoint(h, current, { kind: 'stage-completed', stageId: stage.stageId, stageTask: stage.title, completedItems: [stage.title], remainingItems: [] })
  assert.equal(h.store.getTask(task.taskId).checkpoints.at(-1).coordinatorDecision, 'acknowledge')
})

test('历史坏决策重启后退回重判，原报告不跳过且纠正后恢复同一Task', async t => {
  const h = await setup(t), task = await createTask(h)
  const preparedPlan = await prepareFixturePlan(h, task, task.stageTasks)
  await ingest(h, 'fix-delivery')
  const request = (await route(h, { 'fix-delivery': task.topicRefs[0].topicId })).pendingDecisions[0]
  const action = { kind: 'task-context', taskId: task.taskId, ...inputVersion(task), context: '补充交付验收', progressImpact: 'replan',
    impactEvidence: { basisMessageIds: ['fix-delivery'], reason: '补充验收依据', affectedStageIds: [stagePlanFor(task, task.stageTasks)[0].stageId] }, topicRefs: [{ topicId: request.topicId, revision: request.revision }] }
  const received = await rawLeafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), submissionId: 'blocked-plan', kind: 'plan-confirmed', plan: preparedPlan, summary: '待审计划', remainingItems: task.stageTasks, nextStep: '实施' })
  assert.equal(received.reviewStatus, 'pending')
  const accepted = await h.store.acceptTopicDecision({ groupId: 'g', topicId: request.topicId, revision: request.revision, decisionId: request.requestId,
    decision: { basisMessageIds: ['fix-delivery'], actions: [action], reply: '已接收。', replyReview: { kind: 'confirmation' } }, expectedTaskVersions: [{ taskId: task.taskId, ...inputVersion(task) }] })
  assert.equal(accepted.status, 'accepted')
  await h.runtime.close()
  // 隔离快照模拟旧版本曾接受的错误；不经过新入口伪造接纳成功。
  const record = h.snapshot.tables.groups.g.topics.find(topic => topic.topicId === request.topicId).decisions.at(-1)
  record.status = 'failed'; record.error = 'task_revision_stage_invalid'
  record.decision.actions[0].impactEvidence.affectedStageIds = ['invented-id']
  delete h.snapshot.tables.tasks[task.taskId].stagePlan
  const reopened = await setup(t, { snapshot: h.snapshot, goals: h.goals })
  await reopened.runtime.recoverInterruptedDecisions(); await reopened.runtime.drainTopicOperations('g')
  await until(() => reopened.envelope('[GROUP_TOPIC_DECISION]')?.requestId !== request.requestId && reopened.envelope('[GROUP_TOPIC_DECISION]')?.rejectedDecisions?.length === 1)
  const retry = reopened.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(reopened.store.getTopic('g', request.topicId).processedRevision, request.revision - 1)
  assert.equal(reopened.store.getTask(task.taskId).inputVersion, task.inputVersion)
  assert.equal(reopened.runtime.getTaskReport({ taskId: task.taskId, submissionId: 'blocked-plan' }).reviewStatus, 'pending')
  assert.deepEqual(retry.ownedDeltaMessageIds, ['fix-delivery'])
  const review = await reopened.call('group_reply_review_get', { requestIds: [retry.requestId] })
  assert.equal((await decide(reopened, retry, { actions: [action], reply: '已关联有效补充。', replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId) } })).status, 'accepted')
  const current = reopened.store.getTask(task.taskId)
  await until(() => reopened.runtime.getTaskReport({ taskId: task.taskId, submissionId: 'blocked-plan' }).reviewStatus === 'stale')
  assert.equal(current.inputVersion, task.inputVersion + 1)
  assert.equal(current.childSessionId, task.childSessionId)
  assert.equal(reopened.store.listTasks().length, 1)
  await checkpoint(reopened, current, { kind: 'plan-confirmed', remainingItems: current.stageTasks })
  assert.equal(reopened.goals.get(task.childSessionId).phase, 'active')
  assert.equal(reopened.store.getTopic('g', request.topicId).processedRevision, request.revision)
  const records = reopened.store.getTopic('g', request.topicId).decisions
  assert.equal(records.find(item => item.decisionId === request.requestId).status, 'rejected')
  assert.equal(records.at(-1).status, 'completed')
})

test('报告审阅耗尽保持同身份停等，显式重试重置原请求后恢复推进', async t => {
  const h = await setup(t, { retryDelayMs: 200 }), task = await createTask(h)
  let reviewIdle = true
  h.onSteer = (sessionId, message) => { if (/^\[TASK_(?:CHECKPOINT|COMPLETION|WAITING)_REVIEW\]/u.test(message.content[0]?.text)) { h.idle.set(sessionId, reviewIdle ? Promise.resolve() : new Promise(() => {})); const session = h.handles.get(sessionId).agent.session; session.deriveMessages = () => session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data) } }
  const pauseReviewIdle = () => { reviewIdle = false }
  const receipt = await rawLeafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), submissionId: 'exhausted-plan', kind: 'plan-confirmed', summary: '待审计划', remainingItems: ['核验'], nextStep: '等待审阅' })
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId })?.reviewStatus === 'failed')
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
  assert.equal(h.store.getCoordinationRequest('g', request.requestId).status, 'exhausted')
  const originalOwner = h.owner(request.requestId)
  pauseReviewIdle()
  const retried = await h.runtime.retryTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId })
  assert.equal(retried.submissionId, receipt.submissionId)
  await until(() => h.store.getTask(task.taskId).checkpoints?.length === 1)
  assert.equal(h.store.getCoordinationRequest('g', request.requestId).resumeEpoch, 1)
  await until(() => h.owner(request.requestId) && h.owner(request.requestId) !== originalOwner)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '现在可审阅' } })).status, 'accepted')
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId }).reviewStatus === 'approved')
  assert.equal(h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'task-report-received').length, 1)
  assert.equal(h.messages().filter(message => message.content[0].text.startsWith('[TASK_CHECKPOINT_REVIEW]')).length, 2)
})

test('完成审阅耗尽进入系统等待，拒绝新报告且原完成报告可显式恢复', async t => {
  for (const historicalBlocker of [false, true]) await t.test(historicalBlocker ? '保留历史人工阻塞事实' : '直接恢复系统等待', async t => {
    const h = await setup(t, { retryDelayMs: 1 }), task = await createTask(h, 'coord-recover')
    await fullCheckpoints(h, task)
    let reviewIdle = true
    h.onSteer = (sessionId, message) => { if (/^\[TASK_(?:CHECKPOINT|COMPLETION|WAITING)_REVIEW\]/u.test(message.content[0]?.text)) h.idle.set(sessionId, reviewIdle ? Promise.resolve() : new Promise(() => {})) }
    const pauseReviewIdle = () => { reviewIdle = false }
    const completedValue = { ...inputVersion(task), submissionId: 'durable-completed-report', status: 'completed', summary: '业务交付已完成', evidence: ['已有代码、构建和部署证据'], artifacts: [] }
    const completedReceipt = await rawLeafCall(h, task, 'submit_task_result', completedValue)
    await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: completedReceipt.submissionId })?.reviewStatus === 'failed')
    const completionRequest = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
    const exhaustedOwner = h.owner(completionRequest.requestId)
    assert.equal(h.store.getCoordinationRequest('g', completionRequest.requestId).status, 'exhausted')
    const laterRequestId = 'coord-completion-later-exhaustion'
    await h.store.updateTask(task.taskId, current => ({ ...current, executionEvents: [...current.executionEvents, { kind: 'task-report-settled', submissionId: completedReceipt.submissionId, inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'failed', error: `topic_request_retry_exhausted:${laterRequestId}`, at: new Date().toISOString() }] }))
    await h.store.updateCoordinationRequest('g', laterRequestId, { status: 'exhausted', attempt: 3, resumeEpoch: 0, lastError: `topic_request_retry_exhausted:${laterRequestId}` })

    await until(() => h.store.getTask(task.taskId).waitingKind === 'system')
    const eventsBefore = h.store.getTask(task.taskId).executionEvents.length
    await assert.rejects(rawLeafCall(h, task, 'submit_task_result', { ...inputVersion(task), submissionId: 'operator-blocker', status: 'waiting', waitingKind: 'human-intervention', summary: '等待 Runtime 恢复', evidence: ['完成报告已持久化'], artifacts: [], waitingReason: '协调请求耗尽', blockerCategory: 'unexpected', requestedAction: '重放已持久化完成报告', risk: '不得重复业务执行', attemptedActions: ['已确认完成报告存在'], blockedItems: [blockedItem(h, task, '协调恢复')] }), /task_system_waiting/)
    assert.equal(h.store.getTask(task.taskId).executionEvents.length, eventsBefore)
    const blockerId = 'historical-operator-blocker'
    if (historicalBlocker) {
      // 已存的旧人工阻塞只通过存储夹具还原；新契约下不允许故障叶子再提交它。
      await h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'human-intervention',
        humanBlocker: { requestId: blockerId, category: 'unexpected', requestedAction: '恢复原报告', status: 'waiting-reply', runSequence: task.runSequence, evidence: ['历史恢复要求'], createdAt: new Date().toISOString() } }))
    }
    const waiting = h.store.getTask(task.taskId)
    const leafCallsBefore = h.calls.filter(call => call.sessionId === task.childSessionId).length
    const reviewAttemptsBefore = waiting.executionEvents.filter(event => event.kind === 'completion-review-requested').length

    pauseReviewIdle()
    const retried = await h.runtime.retryCoordinationRequest({ groupId: 'g', requestId: completionRequest.requestId })
    assert.equal(retried.submissionId, completedReceipt.submissionId)
    await until(() => h.store.getCoordinationRequest('g', completionRequest.requestId).resumeEpoch === 1)
    await until(() => h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'completion-review-requested').length === reviewAttemptsBefore + 1)
    await until(() => { const current = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求'); return current && h.owner(current.requestId) && h.owner(current.requestId) !== exhaustedOwner })
    const recoveredRequest = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
    const candidates = await h.call('group_reply_review_get', { requestIds: [recoveredRequest.requestId] })
    assert.equal((await h.call('group_task_review_submit', { requestId: recoveredRequest.requestId, review: { accepted: true, reason: '已接收报告足以收口', notification: { reply: '任务已完成，沿用原交付结果。', replyToMessageId: task.title, replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } })).status, 'accepted')
    await until(() => h.store.getTask(task.taskId).state === 'completed')
    await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:completed`)))
    const current = h.store.getTask(task.taskId)
    assert.equal(h.runtime.getTaskReport({ taskId: task.taskId, submissionId: completedReceipt.submissionId }).reviewStatus, 'approved')
    assert.equal(current.humanBlocker, undefined)
    if (historicalBlocker) {
      const history = current.humanBlockerHistory.find(item => item.requestId === blockerId)
      assert.equal(history.status, 'superseded')
      assert.deepEqual(history.evidence, ['历史恢复要求'])
    }
    assert.equal(h.store.getCoordinationRequest('g', completionRequest.requestId).status, 'completed')
    assert.equal(h.store.getCoordinationRequest('g', laterRequestId).status, 'completed')
    assert.equal(h.calls.filter(call => call.sessionId === task.childSessionId).length, leafCallsBefore, '恢复不得新建或恢复叶子执行')
    assert.equal(current.executionEvents.filter(event => event.kind === 'task-report-received' && event.submissionId === completedReceipt.submissionId).length, 1)
    assert.equal(h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:completed`)).length, 1)
    assert.deepEqual(h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:completed`)).atOpenDingTalkIds, ['od-a'])
  })
})

test('旧运行任务恢复时从已批准计划补齐阶段索引，原检查点不改写且只补一次', async t => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['准备', '执行'] })
  await h.store.updateTask(task.taskId, current => ({ ...current, stageTasks: ['完成并验证当前轮目标'], stagePlan: undefined }))
  const before = h.store.getTask(task.taskId).checkpoints
  await h.runtime.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  const current = reopened.store.getTask(task.taskId)
  assert.deepEqual(current.stageTasks, ['准备', '执行'])
  assert.deepEqual(current.checkpoints, before)
  assert.equal(current.inputVersion, task.inputVersion)
  assert.equal(current.executionEvents.filter(event => event.kind === 'stage-plan-reconciled').length, 1)
  await reopened.runtime.close()
  const again = await setup(t, { snapshot: h.snapshot })
  assert.equal(again.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'stage-plan-reconciled').length, 1)
})

test('直接叶子工具不能绕过结构化必填、准备记录或可信检查器边界', async t => {
  const h = await setup(t), task = await createTask(h)
  const base = { ...inputVersion(task), summary: '绕过尝试', nextStep: '推进' }
  const before = h.store.getTask(task.taskId).executionEvents?.length ?? 0
  await assert.rejects(directLeafCall(h, task, 'submit_task_checkpoint', { ...base, kind: 'plan-confirmed' }), /task_checkpoint_invalid:.*plan/)
  await assert.rejects(directLeafCall(h, task, 'submit_task_checkpoint', { ...base, kind: 'stage-completed', evidence: ['陈述'] }), /task_checkpoint_invalid:.*stageOutput/)
  await assert.rejects(directLeafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '无验收', evidence: ['陈述'] }), /task_result_invalid:.*planRevision/)
  assert.equal(h.store.getTask(task.taskId).executionEvents?.length ?? 0, before)
  const plan = await prepareFixturePlan(h, task, ['核验'])
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...base, kind: 'plan-confirmed', plan: { ...plan, revision: plan.revision + 1 } }), /task_plan_not_prepared/)
  assert.equal(h.store.getTask(task.taskId).plan, undefined)
  await checkpoint(h, task, { kind: 'plan-confirmed', plan })
  const sample = stageOutputFixture(plan)
  await assert.rejects(directLeafCall(h, task, 'submit_task_checkpoint', { ...base, kind: 'stage-completed', evidence: ['伪造检查'], stageOutput: sample.output, artifactRecords: [sample.artifact], modelEvidence: [{ ...sample.evidence, producerKind: 'checker', checkerId: 'artifact-sha256', checkerVersion: '1', receiptId: 'invented' }] }), /task_checkpoint_invalid/)
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...base, kind: 'stage-completed', evidence: ['未登记产物'], stageOutput: sample.output, artifactRecords: [sample.artifact], modelEvidence: [sample.evidence] }), /task_plan_artifact_unregistered/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.filter(item => item.kind === 'stage-completed').length, 0)
})

test('输入修订沿阶段依赖闭包撤销，跨计划采用及无关输入保留同一原证据', async t => {
  const h = await setup(t), task = await createTask(h, 'dependency-chain')
  h.idle.set(task.childSessionId, Promise.resolve())
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['A', 'B', 'C'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: 'A', completedItems: ['A'], remainingItems: ['B', 'C'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: 'B', completedItems: ['B'], remainingItems: ['C'] })
  const before = structuredClone(h.store.getTask(task.taskId).checkpoints.filter(item => item.kind === 'stage-completed'))
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['C'] })
  assert.equal(h.store.getTask(task.taskId).plan.revision, 2)
  let current = h.store.getTask(task.taskId)
  await h.runtime.followupTask({ taskId: task.taskId, requestId: 'unrelated-1', topicRefs: current.topicRefs, ...inputVersion(current), text: '仅补充说明，不改变目标及已核验事实', progressImpact: 'preserve' })
  current = h.store.getTask(task.taskId)
  assert.deepEqual(current.checkpoints.filter(item => item.kind === 'stage-completed'), before)
  assert.deepEqual(current.executionEvents.findLast(event => event.kind === 'input-revised').retainedCheckpointIds.filter(id => before.some(item => item.checkpointId === id)), before.map(item => item.checkpointId))
  await checkpoint(h, current, { kind: 'plan-confirmed', remainingItems: ['C'] })
  current = h.store.getTask(task.taskId)
  assert.equal(current.plan.revision, 3)
  await h.runtime.followupTask({ taskId: task.taskId, requestId: 'unrelated-2', topicRefs: current.topicRefs, ...inputVersion(current), text: '再次补充无关描述', progressImpact: 'preserve' })
  current = h.store.getTask(task.taskId)
  assert.deepEqual(current.checkpoints.filter(item => item.kind === 'stage-completed'), before)
  assert.deepEqual(current.executionEvents.findLast(event => event.kind === 'input-revised').retainedCheckpointIds.filter(id => before.some(item => item.checkpointId === id)), before.map(item => item.checkpointId))
  await h.runtime.followupTask({ taskId: task.taskId, requestId: 'invalidate-a', topicRefs: current.topicRefs, ...inputVersion(current), text: 'A 的现场证据已被否定，下游需重新核验', progressImpact: 'replan',
    impactEvidence: { basisMessageIds: ['dependency-chain'], reason: '明确否定 A 的原证据', affectedStageIds: [current.plan.stages[0].stageId] } })
  const changed = h.store.getTask(task.taskId), revision = changed.executionEvents.findLast(event => event.kind === 'input-revised')
  assert.deepEqual(revision.affectedStageIds, current.plan.stages.map(stage => stage.stageId))
  assert.deepEqual(revision.retainedCheckpointIds, [])
  assert.equal(changed.checkpoints.filter(item => item.kind === 'stage-completed').length, 0)
  assert.deepEqual(revision.checkpoints.filter(item => item.kind === 'stage-completed'), before)
})

test('真实检查工具记录 UNKNOWN 不满足独立验收，文件产生后重新检查方可通过', async t => {
  const h = await setup(t), task = await createTask(h, 'checker-native-flow')
  const plan = await prepareFixturePlan(h, task, ['核验文件'], 'independent-check')
  await checkpoint(h, task, { kind: 'plan-confirmed', plan })
  const filename = join(agentWorkspace, `check-${task.taskId}.txt`), content = 'independent file evidence'
  t.after(() => rmSync(filename, { force: true }))
  const digest = createHash('sha256').update(content).digest('hex')
  const artifact = await directLeafCall(h, task, 'task_artifact_register', { ...inputVersion(task), artifact: { uri: pathToFileURL(filename).href, version: '1', digest } })
  const check = { ...inputVersion(task), criterionIds: [plan.criteria[0].criterionId], check: { checkerId: 'artifact-sha256', checkerVersion: '1', artifactId: artifact.artifactId, expectedDigest: digest } }
  const unknown = await directLeafCall(h, task, 'task_check_run', check)
  assert.equal(unknown.outcome, 'unknown')
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验文件', artifactRecords: [artifact], modelEvidence: [],
    stageOutput: { ...inputVersion(task), stageId: plan.stages[0].stageId, planRevision: plan.revision, artifactRefs: [artifact.artifactId], evidenceRefs: [unknown.evidenceId], blockers: [] } })
  const reviews = evidenceId => [{ criterionId: plan.criteria[0].criterionId, evidenceRefs: [evidenceId], verdict: 'pass', reason: '独立文件摘要检查' }]
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '不能以未知结果通过', evidence: ['文件待确认'], planRevision: plan.revision, criterionReviews: reviews(unknown.evidenceId) }), /task_plan_evidence_not_pass/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  writeFileSync(filename, content)
  const checked = await directLeafCall(h, task, 'task_check_run', check)
  assert.equal(checked.producerKind, 'checker')
  assert.equal(checked.outcome, 'pass')
  assert.notEqual(checked.receiptId, unknown.receiptId)
  assert.equal((await completeResult(h, task, true, { planRevision: plan.revision, criterionReviews: reviews(checked.evidenceId) })).value.state, 'completed')
})

test('叶子结果与检查点拒绝缺失或过期 inputVersion/runSequence', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = { status: 'waiting', waitingKind: 'information', summary: '缺少输入', waitingReason: '缺少范围', questions: ['范围是什么？'], evidence: [], artifacts: [] }
  await assert.rejects(leafCall(h, task, 'submit_task_result', result))
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...result, inputVersion: task.inputVersion + 1, runSequence: task.runSequence }), /task_input_version_stale/)
  const value = { inputVersion: 9, runSequence: 1, kind: 'plan-confirmed', summary: '旧计划', remainingItems: ['一', '二'], nextStep: '核验' }
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', value), /task_input_version_stale/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal((h.store.getTask(task.taskId).checkpoints ?? []).length, 0)
})

test('完成验收不接收历史检查点夹带证据，跨检查点同ID不同内容明确拒绝', async t => {
  for (const mode of ['unreferenced', 'identity-conflict', 'identical-reuse']) {
    const h = await setup(t), task = await createTask(h, `evidence-${mode}`)
    await fullCheckpoints(h, task)
    const current = h.store.getTask(task.taskId)
    const completed = current.checkpoints.findLast(item => item.kind === 'stage-completed')
    const originalEvidence = completed.modelEvidence[0]
    const injected = { ...originalEvidence, evidenceId: mode === 'unreferenced' ? 'unreferenced-extra' : originalEvidence.evidenceId, reason: mode === 'identical-reuse' ? originalEvidence.reason : '内容与原证据不同' }
    await h.store.updateTask(task.taskId, value => ({ ...value, checkpoints: mode === 'unreferenced'
      ? value.checkpoints.map(item => item.checkpointId === completed.checkpointId ? { ...item, modelEvidence: [...item.modelEvidence, injected] } : item)
      : [...value.checkpoints, { ...completed, checkpointId: 'conflicting-checkpoint', modelEvidence: [injected] }] }))
    const criterionReviews = current.plan.criteria.map(item => ({ criterionId: item.criterionId, evidenceRefs: [injected.evidenceId], verdict: 'pass', reason: '尝试引用夹带或冲突证据' }))
    if (mode === 'identical-reuse') {
      assert.equal((await completeResult(h, task, true, { planRevision: current.plan.revision, criterionReviews })).value.state, 'completed')
      continue
    }
    await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '不能通过', evidence: ['陈述'], planRevision: current.plan.revision, criterionReviews }), mode === 'unreferenced' ? /evidence_reference_invalid/ : /evidence_identity_conflict/)
  }
})

test('检查点逐项推进并由结构化内部审阅确认，不能跳项完成', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['一', '二'] })
  assert.deepEqual(h.store.getTask(task.taskId).stageTasks, ['一', '二'])
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: '二', summary: '跳项', evidence: ['证据'], completedItems: ['一', '二'], remainingItems: [], nextStep: '结束' }), /task_plan_stage_order_invalid/)
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'], artifacts: [] }), /task_checkpoints_insufficient|task_checkpoints_remaining|task_plan_stages_incomplete/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 1, '内部审阅不能发群消息')
  assert.equal((await checkpoint(h, task, { kind: 'stage-completed', stageTask: '一', completedItems: ['一'], remainingItems: ['二'] })).accepted, true)
  await assert.rejects(checkpoint(h, task, { kind: 'stage-completed', stageTask: '一', summary: '重复当前阶段', completedItems: ['一'], remainingItems: ['二'] }), /task_plan_stage_already_completed/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.length, 2)
  assert.equal((await checkpoint(h, task, { kind: 'stage-completed', stageTask: '二', completedItems: ['二'], remainingItems: [] })).accepted, true)
  assert.deepEqual(h.store.getTask(task.taskId).checkpoints.at(-1).remainingItems, [])
})

test('首阶段尚未完成时拒绝跨序推进，不能以主会话审阅绕过顺序', async t => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['复现循环', '核对门禁', '形成结论'] })
  const prior = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: '核对门禁', stageId: h.store.getTask(task.taskId).stagePlan[1].stageId,
    summary: '跨序核对门禁', evidence: ['路由与账号权限证据'], completedItems: ['核对门禁'], remainingItems: ['复现循环', '形成结论'], nextStep: '继续取证', needsCoordinatorDecision: true }), /task_plan_stage_order_invalid/)
  assert.equal(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId, prior)
  assert.equal(h.store.getTask(task.taskId).checkpoints.filter(item => item.kind === 'stage-completed').length, 0)
  assert.deepEqual(h.store.getTask(task.taskId).checkpoints.at(-1).remainingItems, ['复现循环', '核对门禁', '形成结论'])
})

test('完成验收拒绝后保持 running 并向叶子发送具体纠偏', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await fullCheckpoints(h, task)
  const outcome = await completeResult(h, task, false)
  assert.match(outcome.error.message, /task_result_objective_not_covered/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.ok(h.handles.get(task.childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_RESULT_REJECTED]')))
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('一次完成审阅同时准备通知，完成落盘后直接入 Outbox 且 FIFO 下个任务启动', async (t) => {
  const h = await setup(t), task = await createTask(h, 'first'), queued = await createTask(h, 'second')
  assert.equal(queued.state, 'queued')
  await fullCheckpoints(h, task)
  const outcome = await completeResult(h, task)
  assert.equal(outcome.value.state, 'completed')
  h.handles.get(task.childSessionId).completeStep()
  await until(() => h.store.getTask(queued.taskId).state === 'running')
  assert.equal(h.store.getTask(queued.taskId).state, 'running')
  await until(() => h.store.getGroup('g').outbox.some((item) => item.sourceMessageId.startsWith('task-result:')) || h.runtime.listRecoveryIssues().some((item) => item.kind === 'task-notification') || h.store.getTask(task.taskId).executionEvents.some((event) => event.kind === 'completion-notification-fallback'))
  assert.ok(h.store.getGroup('g').outbox.some((item) => item.sourceMessageId.startsWith('task-result:')), JSON.stringify({ issues: h.runtime.listRecoveryIssues(), events: h.store.getTask(task.taskId).executionEvents }))
  assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
  assert.ok(h.store.getTask(task.taskId).executionEvents.some((event) => event.kind === 'completion-notification-enqueued'))
  await h.runtime.reconcileCompletedNotifications()
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
})

test('通知已入 Outbox 后执行事件写入失败不会重复发起通知协调', async (t) => {
  const h = await setup(t), task = await createTask(h); await fullCheckpoints(h, task)
  const original = h.store.updateTask
  h.store.updateTask = async (taskId, updater) => original(taskId, (current) => {
    const next = updater(current)
    if ((next.executionEvents ?? []).some((event) => event.kind === 'completion-notification-enqueued')) throw new Error('telemetry_storage_failure')
    return next
  })
  await completeResult(h, task)
  await until(() => h.runtime.listRecoveryIssues().some((item) => item.kind === 'task-notification-telemetry'))
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
  assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
})

test('尚未归类的新消息阻止叶子提交等待或完成结果', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await ingest(h, 'new-info')
  assert.equal((await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '需要输入', waitingReason: '范围未明', questions: ['范围？'], evidence: [], artifacts: [] })).reviewStatus, 'pending')
  assert.equal(h.store.getTask(task.taskId).state, 'running')
})

test('Web 创建按 requestId 幂等，原始输入只落 Topic，参数变更不能复用身份', async (t) => {
  const h = await setup(t)
  const request = { groupId: 'g', requestId: 'web-create-1', title: 'Web 核验', objective: '核验 Web 流程', context: '请核验保存与读取', acceptanceCriteria: ['保存和读取都可验证'], stageTasks: ['核验'] }
  const task = await h.runtime.createTask(request), repeated = await h.runtime.createTask(request)
  assert.equal(task.taskId, repeated.taskId)
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(h.store.getGroup('g').messages.length, 1)
  const message = h.runtime.getTopicContext({ groupId: 'g', ...task.topicRefs[0] }).messages[0]
  assert.equal(message.sourceKind, 'web')
  assert.match(message.text, /请核验保存与读取/)
  assert.equal('sourceMessageId' in task, false)
  await assert.rejects(h.runtime.createTask({ ...request, context: '不同输入' }), /identity_conflict/)
})

test('Web 补充提升输入版本并重置当前检查点，同请求重试不重复补充', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['一', '二'] })
  const request = { taskId: task.taskId, requestId: 'web-append-1', progressImpact: 'replan', topicRefs: task.topicRefs, context: '新增异常分支范围', stageTasks: ['新增异常核验', '一', '二'], ...inputVersion(task) }
  const updated = await h.runtime.appendTaskContext(request)
  assert.equal(updated.inputVersion, task.inputVersion + 1)
  assert.equal(updated.runSequence, task.runSequence)
  assert.deepEqual(updated.checkpoints, [])
  assert.ok(updated.executionEvents.some((event) => event.checkpoints?.length === 1))
  const repeated = await h.runtime.appendTaskContext(request)
  assert.equal(repeated.inputVersion, updated.inputVersion)
  assert.equal(h.store.getGroup('g').messages.length, 2)
  await assert.rejects(h.runtime.appendTaskContext({ ...request, requestId: 'stale-append' }), /task_web_task-stale|task_input_version_stale/)
  const leaf = h.handles.get(task.childSessionId)
  await until(() => leaf.sent.some((message) => message.content[0].text.includes('"inputVersion":2')))
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('"inputVersion":2')))
  await until(() => h.store.getTask(task.taskId).dispatchedInputVersion === updated.inputVersion)
  const revision = h.goals.get(task.childSessionId).revision, sent = leaf.sent.length
  await h.runtime.recoverInterruptedDecisions()
  await immediate(); await immediate()
  assert.equal(h.goals.get(task.childSessionId).revision, revision, '已持许可且输入已送达时，无关pump不能再次resume Goal')
  assert.equal(leaf.sent.length, sent, '同版本稳定消息ID不能重复派发')
})

test('目标修订原子更新任务名称并保留旧名称，普通补充不得单独改名', async (t) => {
  const h = await setup(t), task = await createTask(h, '数据库切换排查')
  await assert.rejects(h.runtime.appendTaskContext({ taskId: task.taskId, requestId: 'title-only', progressImpact: 'replan', topicRefs: task.topicRefs, context: '只补充信息', title: '不应改名', ...inputVersion(task) }), /task_title_requires_objective_revision/)
  const updated = await h.runtime.appendTaskContext({ taskId: task.taskId, requestId: 'revise-objective', progressImpact: 'replan', topicRefs: task.topicRefs, context: '明确要求修复并部署', title: '修复并部署数据库切换', objective: '修复数据库切换问题并部署 UAT', ...inputVersion(task) })
  assert.equal(updated.title, '修复并部署数据库切换')
  assert.equal(updated.objective, '修复数据库切换问题并部署 UAT')
  assert.deepEqual(updated.titleHistory.map((item) => item.title), ['数据库切换排查'])
  assert.deepEqual(updated.objectiveHistory.map((item) => item.objective), ['核验 数据库切换排查'])
  assert.equal(updated.titleHistory[0].inputVersion, task.inputVersion)
  assert.equal(updated.titleHistory[0].runSequence, task.runSequence)
})

test('目标变化缺少新任务名称时拒绝续接', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await assert.rejects(h.runtime.appendTaskContext({ taskId: task.taskId, requestId: 'objective-without-title', progressImpact: 'replan', topicRefs: task.topicRefs, context: '扩大范围', objective: '修复并部署', ...inputVersion(task) }), /task_objective_title_required/)
  assert.equal(h.store.getTask(task.taskId).objective, task.objective)
  assert.equal(h.store.getTask(task.taskId).title, task.title)
})

test('preserve 新输入作废待审 checkpoint，并按新版本重新审阅', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const value = { ...inputVersion(task), kind: 'plan-confirmed', summary: '初始计划', completedItems: [], evidence: [], remainingItems: ['核验'], nextStep: '核验', needsCoordinatorDecision: false }
  const pending = leafCall(h, task, 'submit_task_checkpoint', value)
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  await h.runtime.inspectRunningTasks()
  assert.equal(h.messages().filter((message) => message.content[0].text.startsWith('[TASK_CHECKPOINT_REVIEW]')).length, 1)
  const request = { taskId: task.taskId, requestId: 'preserve-pending', topicRefs: task.topicRefs, context: '补充核验地址，不改变范围', progressImpact: 'preserve', ...inputVersion(task) }
  const updated = await h.runtime.appendTaskContext(request)
  assert.equal(updated.inputVersion, 2)
  assert.deepEqual(updated.checkpoints, [])
  assert.equal(updated.executionEvents.at(-1).checkpoints.length, 1)
  const oldReview = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: oldReview.requestId, review: { decision: 'acknowledge', reason: '旧审阅' } })).status, 'task-stale')
  await assert.rejects(pending, /task_review_context_changed/)
  await checkpoint(h, updated, { kind: 'plan-confirmed', remainingItems: ['核验'] })
  assert.equal(h.store.getTask(task.taskId).checkpoints[0].inputVersion, 2)
})

test('授权变化即使阶段名称不变也撤销旧阶段批准', async t => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'] })
  const before = h.store.getTask(task.taskId)
  assert.equal(before.checkpoints.length, 1)
  const updated = await h.runtime.appendTaskContext({ taskId: task.taskId, requestId: 'authorization-changed', topicRefs: task.topicRefs,
    context: '原有授权已被撤回', progressImpact: 'replan', authorizationChange: 'changed',
    impactEvidence: { basisMessageIds: [stableId('web', 'g:authorization-changed')], reason: '原授权已撤回，旧阶段批准必须失效',
      affectedStageIds: stagePlanFor(before, before.stageTasks).map(stage => stage.stageId) }, ...inputVersion(before) })
  assert.deepEqual(updated.checkpoints, [])
  const revision = updated.executionEvents.findLast(event => event.kind === 'input-revised')
  assert.equal(revision.authorizationChange, 'changed')
  assert.equal(revision.authorizationBasisMessageIds.length, 1)
  assert.ok(h.store.getGroup('g').messages.some(message => message.messageId === revision.authorizationBasisMessageIds[0] && message.sourceKind === 'web'))
  assert.deepEqual(revision.retainedCheckpointIds, [])
})

test('相同待审计划的重复提交与Supervisor恢复共用一次审阅和拒绝注入', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const value = { ...inputVersion(task), kind: 'plan-confirmed', summary: '待审计划', completedItems: [], evidence: [], remainingItems: ['核验'], nextStep: '核验', needsCoordinatorDecision: false }
  const first = leafCall(h, task, 'submit_task_checkpoint', value)
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  const second = leafCall(h, task, 'submit_task_checkpoint', value)
  await Promise.all([h.runtime.inspectRunningTasks(), h.runtime.inspectRunningTasks(), h.runtime.inspectRunningTasks()])
  const reviewRequests = h.messages().filter((message) => message.content[0].text.startsWith('[TASK_CHECKPOINT_REVIEW]'))
  assert.equal(reviewRequests.length, 1)
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'reject', reason: '计划扩大授权范围' } })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.code, 'task_checkpoint_rejected')
  assert.equal(secondResult.checkpointId, firstResult.checkpointId)
  const rejectedInputs = h.handles.get(task.childSessionId).sent.filter((message) => message.content[0].text.startsWith('[TASK_PLAN_REJECTED]'))
  assert.equal(rejectedInputs.length, 1)
})

test('旧执行轮次的 idle 回收不释放已重开的叶子', async (t) => {
  const h = await setup(t), task = await createTask(h)
  h.idle.set(task.childSessionId, Promise.resolve())
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验', completedItems: ['核验'], remainingItems: [] })
  let release
  h.idle.set(task.childSessionId, new Promise((resolve) => { release = resolve }))
  const completion = completeResult(h, task)
  const review = await completion
  assert.equal(review.value.state, 'completed')
  const completed = h.store.getTask(task.taskId)
  const reopened = await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'reopen-before-old-idle', topicRefs: completed.topicRefs, context: '重新核验', ...inputVersion(completed) })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.disposed.includes(task.childSessionId), false)
  await until(() => h.store.getTask(task.taskId).state === 'running')
  await checkpoint(h, reopened, { kind: 'plan-confirmed', remainingItems: ['重新核验'] })
  assert.equal(h.store.getTask(task.taskId).state, 'running')
})

test('人工批准与排队启动竞争时不突破并发上限', async (t) => {
  let release, entered = false, blockedId
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { maxConcurrentTasks: 1, beforeCreate: async (input) => { if (String(input.sessionId) === blockedId) { entered = true; await gate } } })
  t.after(() => release())
  const waiting = await createTask(h, 'waiting')
  await leafCall(h, waiting, 'submit_task_result', { ...inputVersion(waiting), status: 'waiting', waitingKind: 'human-intervention', summary: '需要许可', evidence: ['隔离证据'], artifacts: [], waitingReason: '需要许可', blockerCategory: 'redline', requestedAction: '执行隔离测试', risk: '测试环境' })
  const running = await createTask(h, 'running')
  const queued = await createTask(h, 'queued')
  blockedId = queued.childSessionId
  await h.runtime.cancelTask({ taskId: running.taskId, requestId: 'release-capacity', topicRefs: running.topicRefs, ...inputVersion(running), reason: '释放容量' })
  await until(() => entered)
  await h.runtime.decideAuthorization({ requestId: h.store.getTask(waiting.taskId).humanBlocker.requestId, decision: 'approved', comment: '批准测试' })
  assert.equal(h.store.getTask(waiting.taskId).state, 'queued')
  assert.match(h.store.getTask(waiting.taskId).resumeContext, /Requested action: 执行隔离测试/)
  assert.match(h.store.getTask(waiting.taskId).resumeContext, /If the decision, requested action, and note conflict, do not act/)
  assert.equal(h.store.listTasks().filter((task) => task.state === 'running').length, 0)
  release()
  await until(() => h.store.getTask(queued.taskId).state === 'running')
  assert.equal(h.store.listTasks().filter((task) => task.state === 'running').length, 1)
})

test('Web 重开完成任务建立新轮次，固定保留旧输入版本与历史', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'cancel-before-reopen', topicRefs: task.topicRefs, ...inputVersion(h.store.getTask(task.taskId)), reason: '先停止' })
  const completed = h.store.getTask(task.taskId)
  const reopened = await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'web-reopen-1', topicRefs: completed.topicRefs, context: '继续核验剩余范围', ...inputVersion(completed) })
  await until(() => h.store.getTask(task.taskId).state === 'running')
  assert.equal(reopened.runSequence, completed.runSequence + 1)
  assert.equal(reopened.inputVersion, completed.inputVersion + 1)
  assert.equal(reopened.runHistory.length, 1)
  assert.deepEqual(reopened.runHistory[0].topicRefs, completed.topicRefs)
  const stages = (await h.call('group_task_context_get', { taskIds: [task.taskId] })).tasks[0].stagePlan
  assert.deepEqual(stages, stagePlanFor(reopened, reopened.stageTasks))
  const prompt = h.handles.get(reopened.childSessionId).sections.map(section => typeof section.text === 'function' ? section.text() : section.text).join('\n')
  for (const stage of stages) assert.ok(prompt.includes(stage.stageId))
  assert.equal(h.store.listTasks().length, 1)
  for (const field of ['messageHistory', 'sourceMessageId', 'triggerHistory', 'relatedContexts']) assert.equal(field in reopened.runHistory[0], false)
})

test('完成任务按新目标重开时同步更新名称并在轮次历史保留旧名称', async (t) => {
  const h = await setup(t), task = await createTask(h, '排查数据库切换')
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'finish-diagnostic', topicRefs: task.topicRefs, ...inputVersion(task), reason: '排查阶段结束' })
  const completed = h.store.getTask(task.taskId)
  const reopened = await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'reopen-as-fix', topicRefs: completed.topicRefs, context: '开始修复', title: '修复数据库切换', objective: '修复数据库切换问题', ...inputVersion(completed) })
  assert.equal(reopened.title, '修复数据库切换')
  assert.equal(reopened.objective, '修复数据库切换问题')
  assert.equal(reopened.titleHistory.at(-1).title, '排查数据库切换')
  assert.equal(reopened.runHistory.at(-1).title, '排查数据库切换')
})

test('人工授权重发、引用校验、批准幂等及已批准范围复用', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const requested = []
  h.runtime.onHumanBlockerRequested((value) => { requested.push(value) })
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'human-intervention', summary: '等待批准', evidence: ['范围已核验'], artifacts: [], waitingReason: '需要批准发布', blockerCategory: 'redline', risk: '影响服务', attemptedActions: ['完成预检'], requestedAction: '批准发布本次补丁' }
  await leafCall(h, task, 'submit_task_result', result)
  await until(() => requested.length === 1)
  const original = h.store.getTask(task.taskId).humanBlocker
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
  await h.runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: original.requestId, openTaskId: 'approval-1', conversationId: 'approval-chat', messageId: 'approval-msg-1', sentAt: '2026-09-07T01:00:00Z', formatVersion: 3 })
  const reissued = await h.runtime.reissueAuthorization({ requestId: original.requestId, reason: '重发结构化审批' })
  assert.equal(h.runtime.getAuthorizationRequest(original.requestId).status, 'superseded')
  assert.equal(h.runtime.getAuthorizationRequest(original.requestId).recallStatus, 'pending')
  await assert.rejects(h.runtime.decideAuthorization({ requestId: original.requestId, decision: 'approved' }), /authorization_request_not_pending/)
  await h.runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: reissued.request.requestId, conversationId: 'approval-chat', messageId: 'approval-msg-2', sentAt: '2026-09-07T01:01:00Z', formatVersion: 3 })
  await assert.rejects(h.runtime.resolveHumanBlocker({ taskId: task.taskId, requestId: reissued.request.requestId, quotedMessageId: 'wrong', replyMessageId: 'reply1', reply: '批准', decision: 'approved' }), /human_blocker_reply_mismatch/)
  const approved = await h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'approved', comment: '范围内批准' })
  const repeated = await h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'approved' })
  assert.equal(approved.requestId, repeated.requestId)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
  const before = requested.length
  await leafCall(h, task, 'submit_task_result', result)
  await immediate()
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(requested.length, before, '相同已批准范围不得重复发起审批')
  await assert.rejects(h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'rejected' }), /authorization_decision_conflict/)
})

test('Goal 耗尽转真实 waiting，正常 turn 结束只记录活动不完成 Task', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const event = { seq: 999, type: 'turn/end', data: { status: 'success' } }
  h.events.get('session/event')({ id: task.childSessionId }, event); h.events.get('session/event')({ id: task.childSessionId }, event)
  await h.runtime.flushActivities()
  assert.equal(h.runtime.listActivities().length, 1)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  h.goals.set(task.childSessionId, { ...h.goals.get(task.childSessionId), phase: 'blocked', activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 })
  const inspected = await h.runtime.inspectRunningTasks()
  assert.equal(inspected.find((item) => item.taskId === task.taskId).exhausted, true)
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).result.inputVersion, task.inputVersion)
})

test('无许可的耗尽 Goal 重新获许可仍转人工等待，不自动扩轮', async (t) => {
  const h = await setup(t), task = await createTask(h, 'exhausted-without-permit')
  h.handles.get(task.childSessionId).completeStep()
  await h.runtime.waitTask({ taskId: task.taskId, reason: '暂时释放执行许可' })
  await new Promise(resolve => setTimeout(resolve, 20))
  h.goals.set(task.childSessionId, { ...h.goals.get(task.childSessionId), phase: 'blocked', activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 })
  await h.store.updateTask(task.taskId, current => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined }))
  const inspected = await h.runtime.inspectRunningTasks()
  assert.equal(inspected.find(item => item.taskId === task.taskId).exhausted, true)
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.goals.get(task.childSessionId).maxGoalRounds, 24)
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
})

test('叶子异常暂停最多重建两次，继续失败升级为人工阻塞', async (t) => {
  const h = await setup(t), task = await createTask(h)
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = h.store.getTask(task.taskId), handle = h.handles.get(current.childSessionId)
    handle.agent.status = 'idle'
    h.goals.set(current.childSessionId, { ...h.goals.get(current.childSessionId), phase: 'paused', activation: 'disarmed' })
    const inspected = await h.runtime.inspectRunningTasks()
    if (attempt < 2) {
      assert.equal(inspected[0].sessionRecovered, true)
      assert.notEqual(h.store.getTask(task.taskId).childSessionId, current.childSessionId)
      assert.ok(h.handles.get(h.store.getTask(task.taskId).childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_TOPIC_CONTEXT]')))
    }
  }
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).humanBlocker.category, 'unexpected')
})

test('running 叶子 idle 时由 Runtime 继续，底层 unavailable 时重建同一 Task', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const original = h.handles.get(task.childSessionId)
  original.agent.status = 'idle'
  const sentBefore = original.sent.length
  let inspected = await h.runtime.inspectRunningTasks()
  assert.equal(inspected[0].continuationRequested, true)
  assert.equal(h.store.getTask(task.taskId).childSessionId, task.childSessionId)
  assert.match(original.sent[sentBefore].content[0].text, /继续原任务/)

  original.agent.steer = () => { throw new Error(`subagent "${task.childSessionId}" is unavailable`) }
  original.agent.session.snapshotEvents = () => original.agent.session.ownEvents().filter((event) => event.data?.id !== original.sent[sentBefore].id)
  inspected = await h.runtime.inspectRunningTasks()
  const current = h.store.getTask(task.taskId)
  assert.equal(inspected[0].sessionRecovered, true)
  assert.equal(current.state, 'running')
  assert.notEqual(current.childSessionId, task.childSessionId)
  assert.ok(h.handles.get(current.childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_TOPIC_CONTEXT]')))

  for (let attempt = 0; attempt < 2; attempt++) {
    const active = h.store.getTask(task.taskId)
    const handle = h.handles.get(active.childSessionId)
    handle.agent.status = 'idle'
    handle.agent.steer = () => { throw new Error(`subagent "${active.childSessionId}" is unavailable`) }
    inspected = await h.runtime.inspectRunningTasks()
  }
  assert.equal(inspected[0].waiting, true)
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.match(h.store.getTask(task.taskId).waitingReason, /连续3次不可用/)
})

test('Resident 恢复超时由原生 AbortSignal 隔离，不阻止下一群恢复', { timeout: 2_000 }, async (t) => {
  const h = await setup(t, { groups: ['g', 'b'], resumeTimeoutMs: 10, beforeResume: (input) => {
    if (input.resumeSessionId !== residentSessionId('g')) return
    return new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); input.signal.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal.reason) }, { once: true }) })
  } })
  assert.ok(h.runtime.listRecoveryIssues().some((item) => item.groupId === 'g' && /timeout|timed out/i.test(item.error)))
  assert.ok(h.resident('b'))
})

test('恢复清理旧协议与旧 Topic 请求 Inbox，但保留普通待办', async (t) => {
  const messages = ['[GROUP_MESSAGE_STEER]', '[GROUP_TOPIC_ROUTE]', '[GROUP_TOPIC_DECISION]', '普通待办'].map((text, index) => ({ id: `m${index}`, content: [{ type: 'text', text }] }))
  const removed = []
  const h = await setup(t, { inbox: { nextStep: messages, nextTurn: [], remove(id) { removed.push(id); return true } } })
  assert.deepEqual(removed, ['m0', 'm1', 'm2'])
  assert.ok(h.resident())
})

test('重启恢复 Running 叶子沿用 Goal 与已接纳输入，并重新注入已选流程正文', async (t) => {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: [{ name: '恢复流程', description: '恢复验证', prompt: '恢复后必须重新出现的正文', enabled: true }], taskPromptsVersion: 0 })
  const task = await createTask(h)
  await leafCall(h, task, 'load_task_prompt', { id: config.taskPrompts[0].id })
  await leafCall(h, task, 'select_task_prompts', { inputVersion: task.inputVersion, ids: [config.taskPrompts[0].id], reason: '验证恢复注入' })
  const sessionEvents = new Map([...h.handles].map(([id, handle]) => [id, handle.agent.session.snapshotEvents()]))
  await h.runtime.close()
  const recovered = await setup(t, { snapshot: h.snapshot, goals: h.goals, sessionEvents })
  assert.equal(recovered.store.getTask(task.taskId).state, 'running')
  assert.equal(recovered.handles.get(task.childSessionId).sent.length, 0)
  assert.equal(recovered.goals.get(task.childSessionId).phase, 'active')
  assert.match(recovered.handles.get(task.childSessionId).sections.map((section) => section.text()).join('\n'), /恢复后必须重新出现的正文/)
})

test('迁移任务重启不自动执行，显式恢复清门禁并要求重订计划', async t => {
  const first = await setup(t), task = await createTask(first)
  await first.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'system', inputVersion: current.inputVersion + 1, childSessionId: 'migration-review-new-session', migrationReview: { status: 'required', reason: '迁移核对', candidate: { status: 'historical-unverified' } } }))
  await first.runtime.close()
  const h = await setup(t, { snapshot: first.snapshot })
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).migrationReview.status, 'required')
  await h.runtime.resumeTask({ taskId: task.taskId })
  const resumed = h.store.getTask(task.taskId)
  assert.equal(resumed.migrationReview, undefined)
  assert.equal(resumed.plan, undefined)
  assert.deepEqual(resumed.checkpoints, [])
  assert.ok(resumed.executionEvents.some(event => event.kind === 'workflow-migration-resumed' && event.review.status === 'required'))
})

test('等待通知在同版本 resume 清除 result 后失效，不发送旧问题', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '等问题一', evidence: [], artifacts: [], waitingReason: '缺少输入一', questions: ['输入一是什么？'] })
  await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)))
  const old = h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`))
  await h.runtime.resumeTask({ taskId: task.taskId })
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
  assert.equal((await h.runtime.prepareOutbound({ groupId: 'g', outbound: old })).status, 'superseded')
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups(), [])
})

test('信息等待只在原通知确认送达后有限跟进，重复巡检不补发', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '缺少现场时序', evidence: [], artifacts: [], waitingReason: '等待受影响会话', questions: ['请提供脱敏 Network 时序'] })
  await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)))
  const first = h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`))
  assert.match(first.text, /已暂停/)
  assert.ok(first.atOpenDingTalkIds.includes('od-a'))
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: Date.now() + 3 * 60 * 60_000 }), [])
  await h.store.acknowledge({ groupId: 'g', outboundId: first.outboundId, deliveredMessageId: 'wait-delivered' })
  const sentAt = Date.parse(h.store.getGroup('g').outbox.find(item => item.outboundId === first.outboundId).deliveredAt)
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: sentAt + 31 * 60_000 }), [{ taskId: task.taskId, followup: 1 }])
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: sentAt + 31 * 60_000 }), [])
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: sentAt + 121 * 60_000 }), [{ taskId: task.taskId, followup: 2 }])
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: sentAt + 180 * 60_000 }), [])
  assert.equal(h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith(first.sourceMessageId)).length, 3)
})

test('信息等待同时通知反馈人与发起人，并引用反馈消息', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await ingest(h, 'feedback', { senderName: '乙', senderOpenDingTalkId: 'od-b', text: '受影响账号已确认' })
  const routed = (await route(h, { feedback: task.topicRefs[0].topicId })).pendingDecisions[0]
  await decide(h, routed, { basisMessageIds: ['feedback'], actions: [], reason: '此消息只补充原任务证据' })
  await h.store.updateTask(task.taskId, current => ({ ...current, topicRefs: [{ topicId: routed.topicId, revision: routed.revision }] }))
  const current = h.store.getTask(task.taskId)
  const result = { ...inputVersion(current), status: 'waiting', waitingKind: 'information', summary: '仍缺时序', evidence: [], artifacts: [], waitingReason: '需反馈人补充', questions: ['请提供脱敏时序'], blockedItems: [{ requirement: current.objective, basisMessageIds: ['feedback'], dependency: '现场时序', reason: '只有反馈会话可取' }] }
  await leafCall(h, current, 'submit_task_result', result)
  await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)))
  const notice = h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`))
  assert.equal(notice.replyToMessageId, 'feedback')
  assert.deepEqual(new Set(notice.atOpenDingTalkIds), new Set(['od-a', 'od-b']))
})

test('信息等待通知投递失败产生告警，送达后解除', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '缺少现场时序', evidence: [], artifacts: [], waitingReason: '等待受影响会话', questions: ['请提供脱敏时序'] })
  await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)))
  const notice = h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`))
  await h.runtime.recordOutboundDeliveryAttempt({ groupId: 'g', outboundId: notice.outboundId, blocked: true, reason: 'send_failed', error: 'server rejected' })
  assert.ok(h.store.listAlerts().some(alert => alert.fingerprint === `information-wait-delivery:${notice.sourceMessageId}` && alert.status === 'active'))
  await h.runtime.acknowledge({ groupId: 'g', outboundId: notice.outboundId, deliveredMessageId: 'wait-delivered' })
  assert.ok(h.store.listAlerts().some(alert => alert.fingerprint === `information-wait-delivery:${notice.sourceMessageId}` && alert.status === 'resolved'))
})

test('历史已送达询问只按指定任务补一次暂停更正，送达前不启动催促', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '待取证', evidence: [], artifacts: [], waitingReason: '缺现场时序', questions: ['请提供脱敏记录'], blockedItems: [] }
  await h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'information', waitingReason: result.waitingReason, result }))
  const oldKey = `task-result:${task.taskId}:waiting:1:1:legacy`
  await h.store.appendOutbox({ groupId: 'g', sourceMessageId: oldKey, outboundId: 'old-wait-notice', text: '请提供脱敏记录', resultFingerprint: fingerprint(result), taskIds: [task.taskId], taskInputVersion: task.inputVersion, taskRunSequence: task.runSequence })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'old-wait-notice', deliveredMessageId: 'legacy-delivered' })
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: Date.now() + 3 * 60 * 60_000 }), [])
  const corrected = await h.runtime.reconcileInformationWaitNotice({ taskId: task.taskId })
  assert.equal(corrected.status, 'enqueued')
  assert.equal((await h.runtime.reconcileInformationWaitNotice({ taskId: task.taskId })).sourceMessageId, corrected.sourceMessageId)
  const notice = h.store.getGroup('g').outbox.find(item => item.sourceMessageId === corrected.sourceMessageId)
  assert.match(notice.text, /已暂停/)
  assert.equal(h.store.getGroup('g').outbox.filter(item => item.sourceMessageId === corrected.sourceMessageId).length, 1)
  assert.deepEqual(await h.runtime.reconcileInformationWaitFollowups({ now: Date.now() + 3 * 60 * 60_000 }), [])
})

test('已完成自身工作的叶子不能以外部独立检查提交等待', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const blockers = []
  h.runtime.onHumanBlockerRequested((value) => { blockers.push(value) })
  const priorOutbox = h.store.getGroup('g').outbox.length
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'coordination', summary: '工时已补填并独立回读', evidence: ['10 条日期与需求 ID 清单', 'operation_id=verified'], waitingReason: '等待 leobot 检查结论', request: '请 leobot 检查 10 条工时清单并反馈具体结论' }
  await assert.rejects(rawLeafCall(h, task, 'submit_task_result', result), /task_waiting_coordination_obsolete/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(blockers.length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, priorOutbox)
  assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
})

test('把他人后续检查误列为本职阶段时，内部修订范围并保留已完成证据', async (t) => {
  const h = await setup(t)
  const task = await createTask(h, 'own-work', { title: '填写工时并检查', objective: '填写工时、独立回读，等待甲检查', acceptanceCriteria: ['工时已回读', '甲检查通过'], stageTasks: ['填写并回读', '甲检查'] }, { text: '@助理 请填写工时并自行核对，完成后由甲检查一下。' })
  h.idle.set(task.childSessionId, Promise.resolve())
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['填写并回读', '甲检查'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '填写并回读', completedItems: ['填写并回读'], remainingItems: ['甲检查'], evidence: ['写入后独立回读一致'] })
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '自身工作已完成', evidence: ['写入后独立回读一致'], waitingReason: '等待甲检查', questions: ['请甲检查是否通过'], blockedItems: [] }
  const receipt = await rawLeafCall(h, task, 'submit_task_result', result)
  await until(() => Boolean(h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'approve-wait', reason: '等待甲' } }), /task_waiting_blocked_items_invalid/)
  const revision = { decision: 'revise-scope', reason: '甲的检查是后续协作', basisMessageIds: ['own-work'], affectedStageIds: [h.store.getTask(task.taskId).plan.stages[1].stageId], title: '填写并回读工时', objective: '填写工时并自行回读核验', acceptanceCriteria: ['工时已填写并独立回读'], stageTasks: ['填写并回读'] }
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: revision })).status, 'accepted')
  await until(() => h.store.getTask(task.taskId).inputVersion === task.inputVersion + 1)
  const revised = h.store.getTask(task.taskId)
  assert.equal(revised.state, 'running')
  assert.deepEqual(revised.stageTasks, ['填写并回读'])
  assert.equal(revised.checkpoints.filter(item => item.kind === 'stage-completed').length, 1)
  assert.equal(h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith('task-result:')).length, 0)
  await until(() => h.goals.get(task.childSessionId).phase === 'active')
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId }).reviewStatus === 'stale')
})

test('等待审阅认为仍可自行继续时保持 Task 运行且不发阻塞通知', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '暂未读到资料', evidence: [], waitingReason: '资料尚未查找', questions: ['资料在哪里？'], blockedItems: [blockedItem(h, task, '资料位置')] }
  const receipt = await rawLeafCall(h, task, 'submit_task_result', result)
  await until(() => Boolean(h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')))
  const request = h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'continue', reason: '可按原文给出的链接自行读取' } })).status, 'accepted')
  await until(() => h.runtime.getTaskReport({ taskId: task.taskId, submissionId: receipt.submissionId }).reviewStatus === 'rejected')
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
  assert.equal(h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith('task-result:')).length, 0)
})

test('历史 coordination 等待结果可重启读取，但通知补偿不会重发旧检查', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const historical = { ...inputVersion(task), status: 'waiting', waitingKind: 'coordination', summary: '已完成自验', evidence: ['回读一致'], artifacts: [], waitingReason: '等待外部检查', request: '请甲检查' }
  await h.store.updateTask(task.taskId, current => ({ ...current, state: 'waiting', waitingKind: 'coordination', waitingReason: historical.waitingReason, result: historical }))
  const before = h.store.getGroup('g').outbox.length
  assert.deepEqual(await h.runtime.reconcileCompletedNotifications(), [])
  assert.equal(h.store.getGroup('g').outbox.length, before)
  await h.runtime.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  assert.equal(reopened.store.getTask(task.taskId).result.request, '请甲检查')
  assert.deepEqual(await reopened.runtime.reconcileCompletedNotifications(), [])
  assert.equal(reopened.store.getGroup('g').outbox.length, before)
})

test('同版本重新 waiting 新问题不能被旧问题的通知快照覆盖', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = (id) => ({ ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: `问题${id}`, evidence: [], artifacts: [], waitingReason: `缺少输入${id}`, questions: [`输入${id}是什么？`] })
  await leafCall(h, task, 'submit_task_result', result(1)); await until(() => h.store.getGroup('g').outbox.some(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)))
  const old = h.store.getGroup('g').outbox.find(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`))
  await h.runtime.resumeTask({ taskId: task.taskId })
  await leafCall(h, task, 'submit_task_result', result(2)); await until(() => h.store.getGroup('g').outbox.filter(item => item.sourceMessageId.startsWith(`task-result:${task.taskId}:waiting:`)).length === 2)
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
  assert.equal((await h.runtime.prepareOutbound({ groupId: 'g', outbound: old })).status, 'superseded')
  assert.equal(h.store.getTask(task.taskId).result.waitingReason, '缺少输入2')
})

test('等待结果原子落盘遇新输入，报告保留且 Goal 停等', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const original = h.store.updateTask; let injected = false
  h.store.updateTask = async (...args) => { if (!injected) { injected = true; await ingest(h, 'arrived-at-commit') } return original(...args) }
  assert.equal((await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '缺少输入', evidence: [], artifacts: [], waitingReason: '缺范围', questions: ['范围？'] })).reviewStatus, 'pending')
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
})

test('完成审阅通过后原子落盘遇新输入，不能提前 complete Goal', async (t) => {
  const h = await setup(t), task = await createTask(h); await fullCheckpoints(h, task)
  const result = { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'], artifacts: [] }
  const pending = leafCall(h, task, 'submit_task_result', result)
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  const original = h.store.updateTask; let injected = false
  h.store.updateTask = async (...args) => { if (!injected) { injected = true; await ingest(h, 'arrived-after-review') } return original(...args) }
  const review = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  const candidates = await h.call('group_reply_review_get', { requestIds: [review.requestId] })
  await h.call('group_task_review_submit', { requestId: review.requestId, review: { accepted: true, reason: '通过', notification: { reply: '完成核验', replyToMessageId: 'task-input', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } })
  assert.equal((await outcome).value.reviewStatus, 'pending')
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
})

test('接纳后新入站先阻止叶子启动，同话题决策完成再恢复或取消', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? '同话题取消不启动叶子' : '同话题无动作后恢复启动', async t => {
    const h = await setup(t)
    const complete = h.store.completeTopicDecision.bind(h.store)
    let injected = false
    h.store.completeTopicDecision = async (...args) => {
      if (!injected && h.store.listTasks().length) {
        injected = true
        await ingest(h, 'followup-before-start', { text: cancel ? '刚才的任务撤销' : '补充说明仅供参考' })
      }
      return complete(...args)
    }
    const task = await createTask(h, 'accept-before-new-input')
    await immediate(); await immediate()
    assert.equal(h.store.getTask(task.taskId).state, 'queued')
    assert.equal(h.calls.some(call => call.sessionId === task.childSessionId), false)
    const request = (await route(h, { 'followup-before-start': task.topicRefs[0].topicId })).pendingDecisions.find(item => item.topicId === task.topicRefs[0].topicId)
    await immediate()
    assert.equal(h.calls.some(call => call.sessionId === task.childSessionId), false, '已路由但未决策仍不能启动')
    const review = cancel ? await h.call('group_reply_review_get', { requestIds: [request.requestId] }) : undefined
    const decision = await decide(h, request, cancel ? { reply: '已取消。', replyReview: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] }, actions: [{ kind: 'task-cancel', taskId: task.taskId, ...inputVersion(task), topicRefs: [{ topicId: request.topicId, revision: request.revision }], reason: '用户撤销' }] } : {})
    assert.equal(decision.status, 'accepted', JSON.stringify(decision))
    await until(() => h.store.getTask(task.taskId).state === (cancel ? 'completed' : 'running'))
    assert.equal(h.calls.some(call => call.sessionId === task.childSessionId), !cancel)
    if (cancel) assert.equal(h.store.getTask(task.taskId).outcome, 'cancelled')
  })
})

test('慢叶子创建期间同群其他 Topic 仍可完成', async (t) => {
  let release, entered = false
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { beforeCreate: async (input) => { if (String(input.sessionId).startsWith('session-task-')) { entered = true; await gate } } })
  t.after(() => release())
  await ingest(h, 'slow-a')
  const a = (await route(h)).pendingDecisions[0]
  const result = await h.call('group_decision_submit', { requestId: a.requestId, topicId: a.topicId, revision: a.revision, decision: { basisMessageIds: ['slow-a'], actions: [{ kind: 'new-task', title: 'A', objective: '核验 A', acceptanceCriteria: ['可查'], topicRefs: [{ topicId: a.topicId, revision: a.revision }] }], reply: '开始核验。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })
  assert.equal(result.status, 'accepted')
  await until(() => entered)
  try {
    await ingest(h, 'fast-b')
    const b = (await route(h)).pendingDecisions.find((item) => item.messages.some((message) => message.messageId === 'fast-b'))
    assert.equal((await h.call('group_decision_submit', { requestId: b.requestId, topicId: b.topicId, revision: b.revision, decision: { basisMessageIds: ['fast-b'], actions: [], reason: '独立讨论无需回复' } })).status, 'accepted')
    await until(() => h.store.getTopic('g', b.topicId).processedRevision === b.revision)
    assert.equal(h.store.listTasks()[0].state, 'queued')
  } finally { release() }
  await h.runtime.drainTopicOperations('g')
  await until(() => h.store.listTasks()[0].state === 'running')
})

test('排队叶子启动中取消立即落盘，迟到的 Session 创建不能复活任务', async (t) => {
  let release, entered = false, blockedId
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { beforeCreate: async (input) => { if (String(input.sessionId) === blockedId) { entered = true; await gate } } })
  t.after(() => release())
  const one = await createTask(h, 'first'), two = await createTask(h, 'second')
  blockedId = two.childSessionId
  try {
    await h.runtime.cancelTask({ taskId: one.taskId, requestId: 'cancel-first-start-second', topicRefs: one.topicRefs, ...inputVersion(one), reason: '取消第一个' })
    await until(() => entered)
    await h.runtime.cancelTask({ taskId: two.taskId, requestId: 'cancel-second-during-create', topicRefs: two.topicRefs, ...inputVersion(two), reason: '取消第二个' })
    assert.equal(h.store.getTask(two.taskId).state, 'completed')
  } finally { release() }
  await until(() => h.disposed.includes(two.childSessionId))
  assert.equal(h.store.getTask(two.taskId).state, 'completed')
  assert.equal(h.goals.has(two.childSessionId), false)
  assert.equal(h.handles.get(two.childSessionId).sent.length, 0)
})

test('没有持久通知意图的历史完成任务不在启动或对账时补发', async t => {
  const h = await setup(t), task = await persistedCompletedTask(h)
  await h.store.updateTask(task.taskId, current => ({ ...current, outcome: 'legacy-unknown', notificationIntents: [] }))
  assert.deepEqual(await h.runtime.reconcileCompletedNotifications(), [])
  assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
  await h.runtime.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  assert.deepEqual(await reopened.runtime.reconcileCompletedNotifications(), [])
  assert.equal(reopened.envelope('[TASK_COORDINATION]'), undefined)
  assert.equal(reopened.store.getGroup('g').outbox.length, 0)
})

test('非法完成通知草稿只重做通知，业务完成及固定意图跨重启保留', async t => {
  const h = await setup(t), task = await createTask(h, 'invalid-draft')
  await fullCheckpoints(h, task)
  const result = await completeResult(h, task, true, {}, { notification: { reply: '' } })
  assert.equal(result.value.outcome, 'succeeded')
  await until(() => h.envelope('[TASK_COORDINATION]'))
  const intent = h.store.getTask(task.taskId).notificationIntents[0]
  assert.equal(intent.status, 'pending')
  await h.runtime.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await until(() => reopened.envelope('[TASK_COORDINATION]'))
  assert.equal(reopened.calls.some(call => call.sessionId === task.childSessionId), false)
  assert.equal(reopened.store.getTask(task.taskId).outcome, 'succeeded')
  await submitNotification(reopened)
  await reopened.runtime.recoverCompletionNotifications()
  assert.equal(reopened.store.getTask(task.taskId).notificationIntents[0].status, 'enqueued')
  const outbox = reopened.store.getGroup('g').outbox.filter(item => item.sourceMessageId === intent.sourceMessageId)
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].outboundId, intent.outboundId)
  await reopened.runtime.recoverCompletionNotifications()
  assert.equal(reopened.store.getGroup('g').outbox.filter(item => item.sourceMessageId === intent.sourceMessageId).length, 1)
})

test('通知写入持续故障不产生未处理拒绝，恢复只补同一Outbox身份', async t => {
  const h = await setup(t), task = await createTask(h, 'notification-storage')
  await fullCheckpoints(h, task)
  const append = h.store.appendOutbox, update = h.store.updateTask
  h.store.appendOutbox = async outbound => {
    if (outbound.sourceMessageId.startsWith('task-result:')) throw new Error('outbox-storage-down')
    return append(outbound)
  }
  h.store.updateTask = async (taskId, updater) => update(taskId, current => {
    const next = updater(current)
    if (next.notificationIntents?.some(item => item.status === 'blocked')) throw new Error('task-storage-down')
    return next
  })
  assert.equal((await completeResult(h, task)).value.outcome, 'succeeded')
  await until(() => h.runtime.listRecoveryIssues().some(issue => issue.kind === 'completion-notification-storage'))
  const intent = h.store.getTask(task.taskId).notificationIntents[0]
  assert.equal(intent.status, 'pending')
  h.store.appendOutbox = append; h.store.updateTask = update
  await h.runtime.recoverCompletionNotifications()
  assert.equal(h.store.getGroup('g').outbox.filter(item => item.outboundId === intent.outboundId).length, 1)
  assert.equal(h.store.getTask(task.taskId).notificationIntents[0].status, 'enqueued')
})

test('通知补发同批跳过退订群、隔离损坏 Resident，正常群仍独立完成', async (t) => {
  const h = await setup(t, { groups: ['g', 'bad', 'gone'], resumeFailure: (id) => id === residentSessionId('bad') })
  for (const id of ['g', 'bad']) await persistedCompletedTask(h, id)
  await h.store.removeGroup({ groupId: 'gone' })
  const reconciliation = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  assert.equal((await submitNotification(h)).status, 'accepted')
  const outcome = await reconciliation
  assert.match(outcome.error.message, /task_notification_reconcile_failed:resident_not_active:bad/)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.store.getGroup('bad').outbox.length, 0)
  assert.equal(h.handles.get(residentSessionId('gone')).sent.length, 0)
  assert.ok(h.runtime.listRecoveryIssues().some((issue) => issue.groupId === 'bad' && issue.kind === 'task-notification-reconcile'))
  assert.equal(h.runtime.listRecoveryIssues().some((issue) => issue.groupId === 'gone' && issue.kind === 'task-notification-reconcile'), false)
  await assert.rejects(h.runtime.reconcileCompletedNotifications(), /resident_not_active:bad/)
  const repeated = h.runtime.listRecoveryIssues().filter((issue) => issue.groupId === 'bad' && issue.kind === 'task-notification-reconcile')
  assert.equal(repeated.length, 1, '相同恢复故障只保留一个稳定身份')
  assert.equal(repeated[0].count, 2)
  assert.ok(repeated[0].firstSeenAt <= repeated[0].lastSeenAt)
})

test('工作区屏障内到达的历史导入与通知等待新 Resident，导入先前事件进入新 seed', async (t) => {
  const h = await setup(t), task = await persistedCompletedTask(h), old = h.resident(), oldId = old.agent.session.id
  await h.runtime.hydrateGroupHistory({ groupId: 'g' })
  const priorHistory = old.sent.at(-1).id
  let releaseIdle
  const idle = new Promise((resolve) => { releaseIdle = resolve })
  h.idle.set(oldId, idle)
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const importing = h.runtime.hydrateGroupHistory({ groupId: 'g' })
  const notifying = h.runtime.reconcileCompletedNotifications()
  try {
    await immediate()
    assert.equal(old.sent.filter((message) => message.content[0].text.startsWith('[GROUP_HISTORY_IMPORT]')).length, 1)
    assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
  } finally { releaseIdle() }
  await changing
  const imported = await importing
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  const current = h.resident()
  assert.notEqual(current.agent.session.id, oldId)
  assert.equal(imported.residentSessionId, current.agent.session.id)
  assert.ok(h.calls.findLast(call => !call.sessionId.startsWith('session-coordination-')).input.seed.some((event) => event.type === 'user/message' && event.data.id === priorHistory))
  assert.equal(old.sent.some((message) => message.content[0].text.startsWith('[TASK_COORDINATION]')), false)
  assert.equal(h.envelope('[TASK_COORDINATION]').taskId, task.taskId)
  await submitNotification(h)
  await notifying
})

test('切换工作区等待已经开始的结果通知，通知落盘前不释放旧 Resident', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const old = h.resident(), oldId = old.agent.session.id
  const notifying = h.runtime.reconcileCompletedNotifications()
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  h.idle.set(oldId, Promise.resolve())
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await immediate()
  assert.equal(h.resident(), old)
  assert.equal(h.calls.filter((call) => !call.resumed && !call.sessionId.startsWith('session-coordination-')).length, 0)
  assert.equal((await submitNotification(h)).status, 'accepted')
  await notifying; await changing
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.ok(h.disposed.includes(oldId))
})

test('退订屏障之后的历史导入拒绝旧 Resident，等待期间其他群仍可提交', async (t) => {
  const h = await setup(t, { groups: ['g', 'b'] }), old = h.resident(), oldId = old.agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const removing = h.runtime.unsubscribe({ groupId: 'g' })
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const importing = h.runtime.hydrateGroupHistory({ groupId: 'g' }).then((value) => ({ value }), (error) => ({ error }))
  try {
    await ingest(h, 'b-live', { groupId: 'b' })
    assert.equal((await decide(h, (await route(h, {}, 'b')).pendingDecisions[0], { reply: 'B 完成' }, 'b')).status, 'accepted')
    assert.equal(old.sent.length, 0)
  } finally { releaseIdle() }
  await removing
  assert.match((await importing).error.message, /group_not_subscribed:g/)
  assert.ok(h.disposed.includes(oldId))
  assert.equal(old.sent.length, 0)
})

test('关闭与进行中工作区切换串行收口，旧和替换 Resident 均释放一次', async (t) => {
  const h = await setup(t), oldId = h.resident().agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const closing = h.runtime.close()
  releaseIdle()
  const result = await changing
  await closing
  assert.equal(result.error, undefined)
  assert.equal(h.disposed.filter((id) => id === oldId).length, 1)
  const replacementId = h.calls.at(-1).sessionId
  assert.notEqual(replacementId, oldId)
  assert.equal(h.disposed.filter((id) => id === replacementId).length, 1)
})

test('工作区切换等待期间不占任务提交队列，提交前复核新出现的活动任务', async (t) => {
  const h = await setup(t), old = h.resident(), oldId = old.agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  try {
    const task = await h.runtime.createTask({ groupId: 'g', requestId: 'created-during-config', context: '配置等待时用户独立下达任务', title: '即时任务', objective: '核验', acceptanceCriteria: ['证据'] })
    await until(() => h.store.getTask(task.taskId).state === 'running' && h.store.getTask(task.taskId).dispatchedInputVersion === task.inputVersion)
    assert.equal(h.store.getTask(task.taskId).state, 'running')
  } finally { releaseIdle() }
  assert.match((await changing).error.message, /agent_config_has_active_tasks/)
  assert.equal(h.resident(), old)
  assert.equal(h.runtime.getAgentConfig().workspaceDir, agentWorkspace)
  assert.equal(h.disposed.includes(oldId), false)
  assert.ok(h.disposed.some((id) => id !== oldId))
})

test('关闭拒绝尚未提交的结果通知且不悬挂', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const notifying = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  await h.runtime.close()
  assert.match((await notifying).error.message, /resident_runtime_closed/)
  assert.equal(Object.values(h.snapshot.tables.groups)[0].outbox.length, 0)
})

test('关闭等待已开始提交的结果通知 Outbox，不能提前关闭存储', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const notifying = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  let release, entered = false
  const gate = new Promise((resolve) => { release = resolve }), original = h.store.appendOutbox
  h.store.appendOutbox = async (args) => { entered = true; await gate; return original(args) }
  const submitting = submitNotification(h).then((value) => ({ value }), (error) => ({ error }))
  await until(() => entered)
  let closed = false
  const closing = h.runtime.close().then(() => { closed = true })
  try { await immediate(); assert.equal(closed, false) } finally { release() }
  const result = await submitting
  await notifying; await closing
  assert.equal(result.error, undefined)
  assert.equal(result.value.status, 'accepted')
  assert.equal(Object.values(h.snapshot.tables.groups)[0].outbox.length, 1)
})

test('任务工作位置仅验证已有工件，保留历史来源并排除不存在及远程定位', async () => {
  const { taskWorkLocations } = await import('../packages/dingtalk-dsh-assistant/runtime.js')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-locations-'))
  try {
    const acceptance = join(root, 'docs', 'acceptance', 'feature-one')
    const goal = join(acceptance, 'goal.md')
    await mkdir(acceptance, { recursive: true })
    await writeFile(goal, 'goal')
    await writeFile(join(root, '.git'), 'gitdir: fixture')
    const result = await taskWorkLocations({ checkpoints: [{ checkpointId: 'c1', evidence: [`已记录 \`${goal}\``] }],
      result: { artifacts: [goal, join(root, 'missing.md'), 'https://example.com/report'] } })
    assert.equal(result.status, 'verified')
    assert.deepEqual(new Set(result.locations.map(item => item.kind)), new Set(['goal', 'acceptance', 'worktree']))
    assert.equal(result.locations.some(item => item.path.endsWith('missing.md')), false)
    const reopened = await taskWorkLocations({ runHistory: [{ result: { artifacts: [goal] } }] })
    assert.equal(reopened.locations.find(item => item.kind === 'goal').source, 'previousRun.result.artifacts')
    assert.equal((await taskWorkLocations({ result: { artifacts: ['relative/goal.md', 'https://example.com'] } })).status, 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('启动活动审计不阻塞后续叶子和API，固定快照后live按序接续且close排空', async t => {
  const original = await setup(t, { maxConcurrentTasks: 2 })
  const first = await createTask(original, 'audit-first')
  original.idle.set(first.childSessionId, Promise.resolve())
  const second = await createTask(original, 'audit-second')
  const session = original.handles.get(first.childSessionId).agent.session
  session.append('tool/call', { callId: 'history', name: 'read' })
  const historical = session.snapshotEvents().at(-1)
  const sessionEvents = new Map([[first.childSessionId, session.snapshotEvents()]])
  await original.runtime.close()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let writes = 0
  const restored = await setup(t, { snapshot: original.snapshot, goals: original.goals, sessionEvents, maxConcurrentTasks: 2,
    beforeRuntime(h) {
      const record = h.store.recordActivity.bind(h.store)
      h.store.recordActivity = async value => {
        if (value.taskId === first.taskId && writes++ === 0) { entered.resolve(); await release.promise }
        return record(value)
      }
    },
  })
  await entered.promise
  assert.ok(restored.handles.has(second.childSessionId), '首Task审计尚未完成时第二Task已恢复')
  const liveSession = restored.handles.get(first.childSessionId).agent.session
  liveSession.append('tool/result', { message: { source: { callId: 'history' }, content: [{ type: 'tool-result', isError: false }] } })
  const live = liveSession.snapshotEvents().at(-1)
  restored.events.get('session/event')(liveSession, live)
  for (const id of restored.handles.keys()) restored.idle.set(id, Promise.resolve())
  let closed = false
  const closing = restored.runtime.close().then(() => { closed = true })
  await immediate()
  assert.equal(closed, false)
  release.resolve()
  await closing
  assert.equal(writes, 2, '历史固定快照和live各写一次，不重新扫描已入队的live事件')
  const taskRecord = restored.snapshot.tables.tasks[first.taskId]
  assert.equal(taskRecord.activityProjection.sessions[first.childSessionId].lastSeq, live.seq)
  const projected = Object.values(restored.snapshot.tables.activities).filter(item => item.taskId === first.taskId)
  assert.deepEqual(projected.map(item => item.seq), [historical.seq, live.seq])
})

test('活动重试固定快照期间新增事件不丢且失败水位不跳洞', async t => {
  const h = await setup(t), task = await createTask(h, 'recovery-live')
  const session = h.handles.get(task.childSessionId).agent.session, observer = h.events.get('session/event')
  const record = h.store.recordActivity.bind(h.store)
  let blocked = true
  h.store.recordActivity = async value => { if (blocked) throw new Error('audit-failure'); return record(value) }
  session.append('tool/call', { callId: 'failed-first', name: 'read' })
  const first = session.snapshotEvents().at(-1); observer(session, first)
  await h.runtime.flushActivities()
  assert.equal(h.store.getTask(task.taskId).activityProjection?.sessions?.[task.childSessionId]?.lastSeq, undefined)
  blocked = false
  let appended = false
  h.store.recordActivity = async value => {
    if (!appended) {
      appended = true
      session.append('tool/result', { message: { source: { callId: 'failed-first' }, content: [{ type: 'tool-result', isError: false }] } })
      observer(session, session.snapshotEvents().at(-1))
    }
    return record(value)
  }
  await h.runtime.reconcileActivityProjections({ force: true })
  await h.runtime.flushActivities()
  assert.deepEqual(h.store.listActivities(task.taskId).map(item => item.seq), [first.seq, session.snapshotEvents().at(-1).seq])
})

test('启动resume失败会释放活动恢复预约，后续flush和close不悬挂', async t => {
  const original = await setup(t), task = await createTask(original, 'audit-resume-failure')
  await original.runtime.close()
  const restored = await setup(t, { snapshot: original.snapshot, goals: original.goals, resumeFailure: id => id === task.childSessionId })
  await restored.runtime.flushActivities()
  assert.ok(restored.runtime.listRecoveryIssues().some(issue => issue.taskId === task.taskId))
  await restored.runtime.close()
})

test('input-wait重启按原report形状恢复待审稿，复用已持久reject且保留checkpoint身份', async t => {
  const h = await setup(t), task = await createTask(h, 'checkpoint-order-restart')
  const receipt = await rawLeafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'plan-confirmed', summary: '等待原稿审阅', evidence: [], completedItems: [], remainingItems: ['核验'], nextStep: '核验', needsCoordinatorDecision: true })
  await until(() => h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求'))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  const pendingCheckpoint = structuredClone(h.store.getTask(task.taskId).checkpoints.at(-1))
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'reject', reason: '须先限定隔离核验环境' } })).status, 'accepted')
  await until(() => taskReports(h.store.getTask(task.taskId)).find(r => r.submissionId === receipt.submissionId)?.status === 'rejected')
  await h.runtime.close()
  // 构造已接受审阅、尚未应用且因输入等待的崩溃边界；保留原持久审阅ID。
  const stored = h.snapshot.tables.tasks[task.taskId]
  stored.checkpoints = [pendingCheckpoint]
  stored.executionEvents = stored.executionEvents.filter(e => !(e.submissionId === receipt.submissionId && ['task-report-settled', 'task-report-notified'].includes(e.kind)))
  stored.executionEvents.push({ kind: 'task-report-settled', submissionId: receipt.submissionId, ...inputVersion(task), status: 'input-wait', error: `task_input_pending:${task.taskId}`, at: new Date().toISOString() })
  const received = stored.executionEvents.find(e => e.kind === 'task-report-received' && e.submissionId === receipt.submissionId)
  assert.notDeepEqual(Object.keys(pendingCheckpoint).slice(0, 5), Object.keys(received.value).slice(0, 5))
  const mismatchSnapshot = structuredClone(h.snapshot)
  mismatchSnapshot.tables.tasks[task.taskId].executionEvents.find(e => e.kind === 'task-report-received' && e.submissionId === receipt.submissionId).value.summary = '真实不同稿'
  const mismatch = await setup(t, { snapshot: mismatchSnapshot, goals: new Map(h.goals) })
  await until(() => taskReports(mismatch.store.getTask(task.taskId)).find(r => r.submissionId === receipt.submissionId)?.status === 'failed')
  assert.match(taskReports(mismatch.store.getTask(task.taskId)).find(r => r.submissionId === receipt.submissionId).error, /task_checkpoint_review_pending/)
  assert.deepEqual(mismatch.store.getTask(task.taskId).checkpoints.at(-1), pendingCheckpoint)
  const restored = await setup(t, { snapshot: h.snapshot, goals: h.goals })
  await until(() => taskReports(restored.store.getTask(task.taskId)).find(r => r.submissionId === receipt.submissionId)?.status === 'rejected')
  const current = restored.store.getTask(task.taskId)
  assert.equal(current.checkpoints.at(-1).coordinatorDecision, 'reject')
  assert.equal(current.checkpoints.at(-1).checkpointId, pendingCheckpoint.checkpointId)
  assert.equal(current.checkpoints.at(-1).submittedAt, pendingCheckpoint.submittedAt)
  assert.equal(current.executionEvents.filter(e => e.kind === 'coordination-review-accepted').length, 1)
  assert.equal(current.executionEvents.filter(e => e.kind === 'task-report-received' && e.submissionId === receipt.submissionId).length, 1)
  assert.equal(current.executionEvents.find(e => e.kind === 'coordination-review-accepted').requestId, request.requestId)
  assert.equal(restored.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求'), undefined, '不新建第二次模型审阅')
  assert.equal(current.plan, undefined, 'reject绝不能恢复成计划通过')
})

test('旧Session缺失时仅为已重开的独立轮次建立新Session并保持Task身份', async t => {
  const original = await setup(t), task = await createTask(original, 'missing-reopened-session')
  await original.store.updateTask(task.taskId, current => ({ ...current, state: 'queued', inputVersion: 2, runSequence: 2,
    runHistory: [{ inputVersion: 1, runSequence: 1, childSessionId: current.childSessionId, objective: current.objective,
      startedAt: current.runStartedAt, topicRefs: current.topicRefs, acceptanceCriteria: current.acceptanceCriteria, stageTasks: current.stageTasks }],
    reopenContext: '核验新一轮来源', checkpoints: [], plan: undefined }))
  await original.runtime.close()
  const restored = await setup(t, { snapshot: original.snapshot, beforeResume: async ({ resumeSessionId }) => {
    if (resumeSessionId === task.childSessionId) throw new Error(`session "${resumeSessionId}" not found`)
  } })
  await until(() => restored.store.getTask(task.taskId).state === 'running')
  const current = restored.store.getTask(task.taskId)
  assert.notEqual(current.childSessionId, task.childSessionId)
  assert.equal(current.inputVersion, 2)
  assert.equal(current.runSequence, 2)
  assert.equal(current.runHistory[0].childSessionId, task.childSessionId)
  assert.equal(current.executionEvents.filter(event => event.kind === 'task-reopen-session-recreated').length, 1)
  assert.equal(restored.store.listTasks().filter(item => item.taskId === task.taskId).length, 1)
  assert.equal(restored.deliveries.filter(item => item.sessionId === current.childSessionId && item.message.content?.[0]?.text?.startsWith('[TASK_REOPEN]')).length, 1)
  assert.equal(restored.runtime.listRecoveryIssues().filter(issue => issue.taskId === task.taskId && issue.kind === 'task-start').length, 0)
  await restored.runtime.close()
  const again = await setup(t, { snapshot: original.snapshot, goals: restored.goals })
  await until(() => again.calls.some(call => call.resumed && call.sessionId === current.childSessionId))
  assert.equal(again.store.getTask(task.taskId).childSessionId, current.childSessionId)
  assert.equal(again.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'task-reopen-session-recreated').length, 1)
})

test('非缺失故障和非重开任务不得替换旧Session', async t => {
  for (const errorText of ['EPERM: synthetic read failure', 'session "other" not found']) {
    const original = await setup(t), task = await createTask(original, 'no-session-replacement')
    await original.store.updateTask(task.taskId, current => ({ ...current, state: 'queued', inputVersion: 2, runSequence: 2,
      runHistory: [{ inputVersion: 1, runSequence: 1, childSessionId: current.childSessionId, objective: current.objective,
        startedAt: current.runStartedAt, topicRefs: current.topicRefs, acceptanceCriteria: current.acceptanceCriteria, stageTasks: current.stageTasks }], reopenContext: '新轮次' }))
    await original.runtime.close()
    const restored = await setup(t, { snapshot: original.snapshot, beforeResume: async ({ resumeSessionId }) => {
      if (resumeSessionId === task.childSessionId) throw new Error(errorText)
    } })
    await until(() => restored.runtime.listRecoveryIssues().some(issue => issue.taskId === task.taskId && issue.kind === 'task-start'))
    assert.equal(restored.store.getTask(task.taskId).childSessionId, task.childSessionId)
    assert.equal(restored.store.getTask(task.taskId).state, 'queued')
    assert.equal(restored.calls.some(call => call.sessionId !== task.childSessionId && !call.resumed && call.sessionId.startsWith(`session-${task.taskId}-`)), false)
  }
  const original = await setup(t), task = await createTask(original, 'running-missing-session')
  await original.runtime.close()
  const restored = await setup(t, { snapshot: original.snapshot, beforeResume: async ({ resumeSessionId }) => {
    if (resumeSessionId === task.childSessionId) throw new Error(`session "${resumeSessionId}" not found`)
  } })
  await until(() => restored.runtime.listRecoveryIssues().some(issue => issue.taskId === task.taskId))
  assert.equal(restored.store.getTask(task.taskId).state, 'running')
  assert.equal(restored.store.getTask(task.taskId).childSessionId, task.childSessionId)
  assert.equal(restored.calls.some(call => !call.resumed && call.sessionId.startsWith(`session-${task.taskId}-`)), false)
})

test('已切换群不恢复旧resident，旧入口拒绝接收且不产生协调会话', async t => {
  const h = await setup(t, { workflowGroupIds: ['g'] })
  assert.equal(h.resident(), undefined)
  await assert.rejects(h.runtime.ingest({ groupId: 'g', messageId: 'new', text: '执行新任务' }), /workflow_group_requires_workflow_ingress/)
  await h.runtime.recoverInterruptedDecisions()
  assert.equal(h.resident(), undefined)
  assert.equal(h.messages().length, 0)
})
