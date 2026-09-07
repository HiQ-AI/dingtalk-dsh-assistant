// 只运行隔离内存 Store 和仓库既有 Agent 替身，不连接 DWS、模型或本机 profile。
// 复用 test/runtime.test.js 的 fixture 前导，避免复制另一套 Runtime 模拟器。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { buildTaskAssociationIndex } from '../../../../packages/dingtalk-dsh-assistant/runtime.js'

const fixtureUrl = new URL('../../../../test/runtime.test.js', import.meta.url)
const require = createRequire(fixtureUrl)
const source = await readFile(fixtureUrl, 'utf8')
const boundary = source.indexOf("test('入站持久接收")
assert.ok(boundary > 0, '既有 fixture 边界已变更，请先检查测试文件')
const fixture = source.slice(0, boundary).replace(/from '([^']+)'/g, (match, specifier) => {
  if (specifier.startsWith('node:')) return match
  const url = specifier.startsWith('.') ? new URL(specifier, fixtureUrl).href : pathToFileURL(require.resolve(specifier)).href
  return `from '${url}'`
}) + '\nexport { setup, ingest, route, decide, createTask, until };'
const { setup, ingest, route, decide, createTask, until } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`)
const versions = (task) => ({ inputVersion: task.inputVersion, runSequence: task.runSequence })
const callLeaf = (h, task, name, value) => {
  const leaf = h.handles.get(task.childSessionId)
  return leaf.tools.get(name).execute({ ...versions(h.store.getTask(task.taskId)), ...value }, { agent: leaf.agent })
}
const plan = { kind: 'plan-confirmed', summary: '计划', completedItems: [], evidence: [], remainingItems: ['核验一', '核验二'], nextStep: '核验一', needsCoordinatorDecision: false }
async function ackCheckpoint(h, task, value) {
  const before = h.resident().sent.length
  const pending = callLeaf(h, task, 'submit_task_checkpoint', value)
  await until(() => h.resident().sent.slice(before).some((item) => item.content[0].text.startsWith('[TASK_CHECKPOINT_REVIEW]')))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: 'fixture 已核对' } })
  return pending
}
const humanWait = { status: 'waiting', waitingKind: 'human-intervention', summary: '需要发布许可', evidence: ['隔离测试事实'], artifacts: [], waitingReason: '需要许可', blockerCategory: 'redline', requestedAction: '发布当前版本', risk: '影响测试环境' }

test('A01 无明确点名时，Host 拒绝模型提交的 new-task', async (t) => {
  const h = await setup(t)
  await ingest(h, 'discussion', { text: '今天讨论一下这个问题，先不要做任何事情' })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '执行修复', objective: '修改代码修复', acceptanceCriteria: ['已修改'], topicRefs: [{ topicId: request.topicId, revision: request.revision }] }
  await assert.rejects(decide(h, request, { actions: [action], reply: '开始处理' }), /task_group_responsibility_required|task_explicit_authorization_required/)
  assert.equal(h.store.listTasks().length, 0)
  console.log('A01 fixed: rejected; taskCount=0; resident deny=', JSON.stringify(h.resident().restrictions))
})

test('A02 waiting 释放容量后，无关 queued Task 可以启动', async (t) => {
  const h = await setup(t, { maxConcurrentTasks: 1 })
  const first = await createTask(h, 'one')
  const second = await createTask(h, 'two')
  await callLeaf(h, first, 'submit_task_result', humanWait)
  await createTask(h, 'three') // 再触发一次实际 pump，排除只是尚未调度。
  await h.runtime.inspectRunningTasks()
  assert.equal(h.store.getTask(first.taskId).state, 'waiting')
  assert.equal(h.store.getTask(second.taskId).state, 'running')
  console.log('A02 fixed: first=waiting, second=running, capacity=1')
})

test('A03 checkpoint 审阅失败后，同一提交恢复原 checkpoint 并可重试', async (t) => {
  const h = await setup(t, { retryDelayMs: 10 })
  const task = await createTask(h)
  await ackCheckpoint(h, task, plan)
  h.idle.set(h.resident().agent.session.id, Promise.resolve())
  const stage = { kind: 'stage-completed', stageTask: task.stageTasks[0], summary: '一已完成', completedItems: ['核验一'], evidence: ['证据'], remainingItems: ['核验二'], nextStep: '核验二', needsCoordinatorDecision: false }
  // 保持进程活跃，协调器的 unref 定时器仍按实际路径执行。
  const keepAlive = setInterval(() => {}, 100)
  try {
    const first = callLeaf(h, task, 'submit_task_checkpoint', { ...stage, kind: 'risk-changed', completedItems: [], remainingItems: ['核验一', '核验二'], needsCoordinatorDecision: true })
    await assert.rejects(first, /topic_request_not_submitted/)
    assert.equal(h.store.getTask(task.taskId).checkpoints.at(-1).coordinatorDecision, undefined)
    h.idle.delete(h.resident().agent.session.id)
    const previous = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求').requestId
    const retried = callLeaf(h, task, 'submit_task_checkpoint', { ...stage, kind: 'risk-changed', completedItems: [], remainingItems: ['核验一', '核验二'], needsCoordinatorDecision: true })
    await until(() => h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求').requestId !== previous)
    const review = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
    await h.call('group_task_review_submit', { requestId: review.requestId, review: { decision: 'acknowledge', reason: '已恢复审阅' } })
    await retried
    assert.equal(h.store.getTask(task.taskId).checkpoints.length, 2)
    console.log('A03 fixed: timeout -> same persisted checkpoint -> retry review accepted without duplicate')
  } finally { clearInterval(keepAlive) }
})

test('A04 跨 Topic 追加会合并保留 Task 原有证据入口', async (t) => {
  const h = await setup(t)
  const task = await createTask(h, 'original')
  const oldRef = task.topicRefs[0]
  await ingest(h, 'supplement', { text: '@助理 原任务增加核验条件' })
  const request = (await route(h)).pendingDecisions[0]
  const refs = [{ topicId: request.topicId, revision: request.revision }]
  await decide(h, request, { actions: [{ kind: 'task-context', taskId: task.taskId, ...versions(task), context: '补充条件', topicRefs: refs }], reply: '已收到' })
  assert.equal(h.store.getTask(task.taskId).topicRefs.length, 2)
  assert.equal(callLeaf(h, task, 'group_topic_context_get', oldRef).topicId, oldRef.topicId)
  console.log('A04 fixed: old and new Topic refs both remain readable')
})

test('A05 明确无进度影响的普通事实补充保留检查点', async (t) => {
  const h = await setup(t)
  const task = await createTask(h)
  await ackCheckpoint(h, task, plan)
  await ingest(h, 'fact-only', { text: '@助理 补充核验用 IP，不改变目标或验收标准' })
  const request = (await route(h)).pendingDecisions[0]
  await decide(h, request, { actions: [{ kind: 'task-context', taskId: task.taskId, ...versions(task), context: '补充核验用 IP', progressImpact: 'preserve', topicRefs: [{ topicId: request.topicId, revision: request.revision }] }], reply: '已收到' })
  const current = h.store.getTask(task.taskId)
  assert.equal(current.objective, task.objective)
  assert.deepEqual(current.acceptanceCriteria, task.acceptanceCriteria)
  assert.equal(current.checkpoints.length, 1)
  assert.equal(current.executionEvents[0].progressImpact, 'preserve')
  console.log('A05 fixed: unchanged objective and criteria; checkpoint retained')
})

test('A06 人工批准不跨执行轮次或风险变化复用', async (t) => {
  const h = await setup(t)
  const task = await createTask(h)
  await callLeaf(h, task, 'submit_task_result', humanWait)
  const blocker = h.store.getTask(task.taskId).humanBlocker
  await h.runtime.decideAuthorization({ requestId: blocker.requestId, decision: 'approved', comment: '允许本次测试环境发布', source: 'web' })
  let current = h.store.getTask(task.taskId)
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'cancel-a06', topicRefs: current.topicRefs, ...versions(current), reason: '停止本轮' })
  current = h.store.getTask(task.taskId)
  await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'reopen-a06', context: '新一轮发布，需要重新核验风险', topicRefs: current.topicRefs, ...versions(current) })
  current = h.store.getTask(task.taskId)
  await callLeaf(h, current, 'submit_task_result', { ...humanWait, risk: '本次影响生产环境', evidence: ['目标和风险已改变'] })
  current = h.store.getTask(task.taskId)
  assert.equal(current.runSequence, 2)
  assert.equal(current.state, 'waiting')
  assert.notEqual(current.humanBlocker.requestId, blocker.requestId)
  console.log('A06 fixed: run=2 and changed risk creates a new approval request')
})

test('A07 Topic 的历史失败附件不拦截明确无需附件的新任务', async (t) => {
  const h = await setup(t)
  await ingest(h, 'bad-image', { text: '此前图片下载失败', mediaUnavailable: ['旧图片不可用'] })
  const old = (await route(h)).pendingDecisions[0]
  await decide(h, old)
  await ingest(h, 'new-scope', { text: '@助理 无需旧图片，只核验文字中给出的版本 1.0' })
  const current = (await route(h, { 'new-scope': old.topicId })).pendingDecisions[0]
  const action = { kind: 'new-task', title: '核验版本', objective: '只核验版本 1.0，不使用旧图片', acceptanceCriteria: ['版本已核验'], topicRefs: [{ topicId: current.topicId, revision: current.revision }] }
  await decide(h, current, { actions: [action], reply: '开始核验版本' })
  assert.equal(h.store.listTasks().length, 1)
  console.log('A07 fixed: taskCount=1; unrelated historical media failure does not replace decision')
})

test('A08 实测协议字符数、动态索引及重复消息载荷', async (t) => {
  const h = await setup(t)
  const task = await createTask(h)
  const sizes = (handle) => Object.fromEntries(handle.sections.map((section) => {
    const text = typeof section.text === 'function' ? section.text() : section.text
    return [section.name, { chars: text.length, utf8Bytes: Buffer.byteLength(text) }]
  }))
  const resident = sizes(h.resident()), leaf = sizes(h.handles.get(task.childSessionId))
  const index = [10, 100, 1000].map((count) => {
    const tasks = Array.from({ length: count }, (_, i) => ({ ...task, taskId: `task-${String(i).padStart(32, '0')}`, title: '核验示例任务'.repeat(4), objective: '核验真实业务范围'.repeat(15) }))
    const text = JSON.stringify(buildTaskAssociationIndex(tasks))
    return { count, chars: text.length, utf8Bytes: Buffer.byteLength(text) }
  })
  await ingest(h, 'large', { text: '示例原始事实'.repeat(2000) })
  await route(h)
  const routeText = h.resident().sent.findLast((m) => m.content[0].text.startsWith('[GROUP_TOPIC_ROUTE]')).content[0].text
  const decisionText = h.resident().sent.findLast((m) => m.content[0].text.startsWith('[GROUP_TOPIC_DECISION]')).content[0].text
  assert.ok(routeText.length > 12000 && decisionText.length > 12000)
  console.log('A08 metrics (characters and UTF-8 bytes, NOT tokens):', JSON.stringify({ resident, leaf, index, oneMessageChars: 12000, routeChars: routeText.length, decisionChars: decisionText.length, fixture: fileURLToPath(fixtureUrl) }))
})

test('A09 Supervisor 等待 Session 恢复时，其他 Task 取消立即发信号', async (t) => {
  let blocked = false, release, firstSession
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { maxConcurrentTasks: 2, beforeResume: async (input) => {
    if (input.resumeSessionId === firstSession) { blocked = true; await gate }
  } })
  const first = await createTask(h, 'first')
  const second = await createTask(h, 'second')
  firstSession = first.childSessionId
  const originalGet = h.ctx.agents.get
  let simulateMissing = true
  h.ctx.agents.get = (id) => {
    if (simulateMissing && id === firstSession) { simulateMissing = false; return undefined }
    return originalGet(id)
  }
  const inspection = h.runtime.inspectRunningTasks()
  await until(() => blocked)
  const pendingCancel = h.runtime.cancelTask({ taskId: second.taskId, requestId: 'cancel-a09', topicRefs: second.topicRefs, ...versions(second), reason: '立即停止第二项' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await until(() => h.cancelled.some((item) => item.sessionId === second.childSessionId))
    assert.equal(h.store.getTask(second.taskId).state, 'completed')
    console.log('A09 fixed: unrelated resume does not hold the cancel signal')
  } finally { release() }
  await inspection
  await pendingCancel
  assert.ok(h.cancelled.some((item) => item.sessionId === second.childSessionId))
})

test('A10 看板使用 Topic 工作流状态而非旧 agentDeliveryStatus', async (t) => {
  const h = await setup(t)
  await ingest(h, 'message-status')
  const request = (await route(h)).pendingDecisions[0]
  await decide(h, request)
  const topic = h.store.getTopic('g', request.topicId)
  const message = h.store.getGroup('g').messages[0]
  assert.equal(topic.processedRevision, topic.revision)
  assert.equal(message.routingStatus, 'routed')
  assert.equal(message.agentDeliveryStatus, 'pending')
  const observer = await readFile(new URL('../../../../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(observer, /messageWorkflowState/)
  assert.doesNotMatch(observer, /delivery\[message\.agentDeliveryStatus\]/)
  console.log('A10 fixed: legacy field remains for migration, Observer derives Topic workflow state')
})
