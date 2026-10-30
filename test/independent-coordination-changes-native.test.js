import test from 'node:test'
import assert from 'node:assert/strict'
import { available, reason, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'

const native = { skip: !available ? reason : false, timeout: 20000 }
const ownerWait = { name: 'task_session_submit', args: { decision: { action: 'wait', summary: '保留原目标，等待核验', evidence: [], limitations: [] } } }
const tasks = ['A', 'B'].map(taskId => ({ taskId, request: '原目标' + taskId }))
const message = (messageId, text, quotedMessage) => ({ groupId: 'native-group', messageId,
  senderOpenDingTalkId: 'native-user', text, timestamp: '2026-10-23T09:00:00Z', ...(quotedMessage ? { quotedMessage } : {}) })

// This scripts semantic choices only. Current Topic validation, Task CAS, native
// Owner sessions and durable notifications remain real; no retired planner runs.
function currentModel(select = () => null, observe = () => {}) {
  return request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    observe(request, input)
    if (names.includes('task_session_submit')) return [ownerWait]
    if (input.trigger === 'task-facts') return topicTaskCalls(request)
    const calls = topicTaskCalls(request)
    if (!names.includes('group_decision_submit')) return calls ?? []
    const source = input.messages.at(-1), selected = select(source)
    let task
    if (selected) {
      task = modelToolValues(request).findLast(value => value.tasks?.some(item => item.taskId === selected.taskId))?.tasks.find(item => item.taskId === selected.taskId)
      if (!task) return [{ name: 'group_task_context_get', args: { taskIds: [selected.taskId] } }]
    }
    const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
    const actions = task ? [{ kind: selected.kind ?? 'task-context', taskId: task.taskId, inputVersion: task.inputVersion,
      runSequence: task.runSequence, context: source.text, ...(selected.kind === 'task-reopen' ? {} : { progressImpact: 'preserve' }),
      topicRefs: [{ topicId: input.topicId, revision: input.revision }], basisUnitRefs }] : []
    calls[0].args.decision = { basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs, actions,
      reply: selected ? '已向指定原任务补充要求。' : '已记录当前问题；尚未交办业务动作。',
      replyToMessageId: source.messageId, atOpenDingTalkIds: [source.senderOpenDingTalkId],
      replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } }
    return calls
  }
}
const arrangement = { id: 'old', groupId: 'native-group', state: 'active', revision: 2, history: [{ kind: 'accepted', evidence: 'original' }] }
const schedule = { id: 'old-reminder', coordinationId: 'old', state: 'active', revision: 1,
  rule: { kind: 'once', at: '2026-10-23T09:10:00.000Z' }, target: { conversationId: 'native-group', recipientIds: ['recipient-b'] },
  reminderText: '查看原结果。' }
const oldNotice = (id, state = 'delivered') => ({ id, kind: 'coordination', state,
  payload: { conversationId: 'native-group', text: '原提醒已登记', sourceMessageId: 'original-reminder', actorId: 'native-user',
    fact: { coordinationId: 'old', eventId: id } },
  ...(state === 'delivered' ? { receipt: { messageId: 'receipt-' + id } } : { dispatchToken: 'original-permit', sendAttemptCount: 1 }) })

for (const correction of ['提前三分钟', '改为提醒C', '另外给C安排一个提醒']) test('quoted historical reminder stays read-only; a current Topic records the new request: ' + correction, native, async t => {
  const observed = []
  const f = await retiredCoordinationHost(t, { tasks, rows: { coordination: [arrangement], coordination_schedules: [schedule],
    notifications: [oldNotice('confirmation')] }, decide: currentModel(() => null, (request, input) => {
      if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) observed.push(...input.messages)
    }) })
  const before = await f.host.query('task.list'), old = await f.host.query('coordination.schedule.list')
  await f.host.service.ingest(message('correction', correction, { messageId: 'receipt-confirmation', content: '原提醒已登记' }))
  await f.host.service.whenIdle()
  assert.equal(observed.length, 1)
  assert.equal(observed[0].quotedMessage.messageId, 'receipt-confirmation')
  assert.deepEqual(await f.host.query('coordination.schedule.list'), old)
  assert.deepEqual(old[0].target.recipientIds, ['recipient-b'])
  assert.deepEqual(await f.host.query('task.list'), before)
  assert.equal(f.host.residentStore.listTopics('native-group').length, 1)
  assert.equal(f.host.sent.length, 1)
  assert.deepEqual(f.host.sent[0].payload.atOpenDingTalkIds, ['native-user'])
  assert.equal(f.requests.some(request => request.tools.some(tool => tool.name === 'coordination_submit')), false)
  await f.restart(); await f.host.service.recover(); await f.host.service.whenIdle()
  assert.deepEqual(await f.host.query('coordination.schedule.list'), old)
  assert.equal(f.host.sent.length, 0, 'cold recovery does not resend the recorded response')
})

test('mixed current discussion and explicit Task supplement keep all source text while only the chosen Task changes', native, async t => {
  const f = await retiredCoordinationHost(t, { tasks, decide: currentModel(() => ({ taskId: 'A' })) })
  const beforeA = await f.host.query('task.get', { taskId: 'A' }), beforeB = await f.host.query('task.get', { taskId: 'B' })
  const text = '测试助手，保留关于提醒的讨论；只给原任务A增加验收材料，不改原目标。'
  await f.host.service.ingest(message('mixed-current', text)); await f.host.service.whenIdle()
  const a = await f.host.query('task.get', { taskId: 'A' })
  assert.equal(a.contextRevision, (beforeA.contextRevision ?? 0) + 1)
  assert.equal(a.requirementRevision, beforeA.requirementRevision); assert.equal(a.sessionId, beforeA.sessionId)
  assert.ok((await f.host.query('source.list')).some(source => source.text === text && source.routed))
  assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), beforeB)
  assert.equal((await f.host.query('task.list')).length, 2)
  const count = f.host.sent.length
  await f.host.service.recover(); await f.host.service.whenIdle(); assert.equal(f.host.sent.length, count)
})

test('two old reminder receipts remain distinct across restart; delivered and unknown effects are never recreated', native, async t => {
  const first = oldNotice('first'), second = oldNotice('second', 'unknown')
  const f = await retiredCoordinationHost(t, { rows: { coordination: [arrangement], coordination_schedules: [
    schedule, { ...schedule, id: 'second-reminder', rule: { kind: 'once', at: '2026-10-23T09:10:39.000Z' } }],
    notifications: [first, second] } })
  await f.host.service.recover(); await f.host.service.whenIdle()
  const saved = await f.host.query('coordination.schedule.list'), notices = await f.host.query('notification.list')
  assert.equal(saved.length, 2); assert.deepEqual(notices.find(item => item.id === 'first').receipt, first.receipt)
  assert.equal(notices.find(item => item.id === 'second').state, 'unknown')
  assert.equal(notices.find(item => item.id === 'second').dispatchToken, second.dispatchToken)
  assert.deepEqual(await f.host.query('coordination.job.list'), []); assert.deepEqual(await f.host.query('task.list'), [])
  assert.equal(f.host.sent.length, 0)
  await f.restart(); await f.host.service.recover(); await f.host.service.whenIdle()
  assert.deepEqual(await f.host.query('coordination.schedule.list'), saved); assert.equal(f.host.sent.length, 0)
})

test('retired conditional schedule cannot continue a Task; one fresh explicit supplement reaches its existing Owner once', native, async t => {
  const f = await retiredCoordinationHost(t, { tasks, rows: { coordination: [arrangement], coordination_schedules: [
    { ...schedule, action: { kind: 'task-command', taskId: 'A', context: 'old continuation' } }] } })
  const before = await f.host.query('task.list')
  await f.host.service.recover(); await f.host.service.whenIdle()
  assert.deepEqual(await f.host.query('task.list'), before)
  const args = { taskId: 'A', requestId: 'fresh-continuation', context: '核对当前证据后继续原目标', progressImpact: 'preserve',
    expectedRequirementRevision: 1, expectedControlRevision: 1 }
  await f.host.service.appendTaskContext(args); await f.host.service.whenIdle()
  await f.host.service.appendTaskContext(args); await f.host.service.whenIdle()
  const a = await f.host.query('task.get', { taskId: 'A' })
  assert.equal(a.contextRevision, 1); assert.equal(a.sessionId, before.find(task => task.taskId === 'A').sessionId)
  assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), before.find(task => task.taskId === 'B'))
  assert.deepEqual(await f.host.query('coordination.job.list'), [])
  assert.equal((await f.host.query('task.list')).length, 2)
})

test('a clarification has no Task effect until the next source identifies A; B and the original question stay intact', native, async t => {
  const f = await retiredCoordinationHost(t, { tasks, decide: currentModel(source => source.messageId === 'answer' ? { taskId: 'A' } : null) })
  const before = await f.host.query('task.list')
  await f.host.service.ingest(message('question', '测试助手，那个同名任务需要补充材料。')); await f.host.service.whenIdle()
  assert.deepEqual(await f.host.query('task.list'), before)
  const original = (await f.host.query('source.list')).find(source => source.messageId === 'question')
  await f.host.service.ingest(message('answer', '测试助手，明确是原任务A，只补充定位材料。')); await f.host.service.whenIdle()
  assert.equal((await f.host.query('task.get', { taskId: 'A' })).contextRevision, 1)
  assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), before.find(task => task.taskId === 'B'))
  assert.deepEqual(await f.host.query('source.get', { sourceId: original.sourceId }), original)
  assert.ok(f.host.toolResults.some(item => item.name === 'group_task_context_get'))
  assert.deepEqual(await f.host.query('coordination.list'), [])
})

test('historical interleaved ordinals and resolutions retain their proof without controlling current Tasks', native, async t => {
  const sourceOrder = [{ ordinal: 1, clarificationId: 'first', resolvedBy: ['old-B'] }, { ordinal: 2, instructionId: 'old-A' }]
  const f = await retiredCoordinationHost(t, { tasks, rows: { coordination: [{ ...arrangement, sourceOrder }],
    coordination_members: [{ id: 'old-A', coordinationId: 'old', taskId: 'A', control: 'paused', state: 'applied' },
      { id: 'old-B', coordinationId: 'old', taskId: 'B', control: 'paused', state: 'ready' }] } })
  const before = await f.host.query('task.list')
  await f.host.service.recover(); await f.host.service.whenIdle(); await f.restart(); await f.host.service.recover(); await f.host.service.whenIdle()
  const history = await f.host.query('coordination.get', { coordinationId: 'old' })
  assert.deepEqual(history.coordination.sourceOrder, sourceOrder)
  assert.deepEqual(history.members.map(member => [member.taskId, member.control]), [['A', 'paused'], ['B', 'paused']])
  assert.deepEqual(await f.host.query('task.list'), before)
  assert.ok(before.every(task => task.control === 'active'))
  assert.equal(f.host.sent.length, 0)
})

test('current explicit follow-up rejects stale Task CAS before changing any Task, then preserves one accepted input identity', native, async t => {
  const f = await retiredCoordinationHost(t, { tasks })
  const before = await f.host.query('task.list'), wakes = await f.host.query('wake.list')
  const args = { taskId: 'B', requestId: 'precise-followup', context: '只补充B核验材料', progressImpact: 'preserve',
    expectedRequirementRevision: 99, expectedControlRevision: 1 }
  await assert.rejects(f.host.service.appendTaskContext(args), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  assert.deepEqual(await f.host.query('task.list'), before); assert.deepEqual(await f.host.query('wake.list'), wakes)
  args.expectedRequirementRevision = 1
  await f.host.service.appendTaskContext(args); await f.host.service.whenIdle()
  await f.host.service.appendTaskContext(args); await f.host.service.whenIdle()
  const b = await f.host.query('task.get', { taskId: 'B' })
  assert.equal(b.contextRevision, 1); assert.equal(b.sessionId, before.find(task => task.taskId === 'B').sessionId)
  assert.deepEqual(await f.host.query('task.get', { taskId: 'A' }), before.find(task => task.taskId === 'A'))
})

test('a new authorized review reopens the completed original Task without replacing its session or completing another Task', native, async t => {
  const f = await retiredCoordinationHost(t, { tasks })
  const a = await f.host.query('task.get', { taskId: 'A' }), b = await f.host.query('task.get', { taskId: 'B' })
  const binding = (await f.host.service.store.command({ id: 'claim-for-proof', kind: 'task.claim', args: { taskId: 'A', force: true } })).result.binding
  const proof = await f.host.service.store.command({ id: 'complete-original', kind: 'task.complete', args: { binding, summary: '原结果正式完成', result: { evidence: ['synthetic-proof'] } } })
  await f.host.service.store.command({ id: 'drain-proof-owner', kind: 'task.drained', args: { binding } })
  await f.host.service.reopenTask({ taskId: 'A', requestId: 'new-review', context: '核查新指出的遗漏，不重放已完成效果',
    expectedRequirementRevision: 1, expectedControlRevision: 1 })
  await f.host.service.whenIdle()
  const reopened = await f.host.query('task.get', { taskId: 'A' })
  assert.equal(reopened.taskId, a.taskId); assert.equal(reopened.sessionId, a.sessionId)
  assert.equal(reopened.runSequence, 2); assert.equal(reopened.completion, null); assert.equal(reopened.status, 'active')
  assert.deepEqual((await f.host.query('receipt.get', { id: 'complete-original' })).taskDecision, proof.taskDecision)
  assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), b)
  assert.equal((await f.host.query('task.list')).length, 2); assert.deepEqual(await f.host.query('execution.list'), [])
})

test('ordinary discussion goes directly through a current Topic with no independent reservation, handoff or business effect', native, async t => {
  const f = await retiredCoordinationHost(t, { decide: currentModel() })
  await f.host.service.ingest(message('discussion', '测试助手，这里只确认讨论记录，不开展业务操作。')); await f.host.service.whenIdle()
  const [topic] = f.host.residentStore.listTopics('native-group')
  assert.equal(topic.decisions.length, 1); assert.equal(topic.decisions[0].status, 'completed')
  assert.deepEqual(topic.decisions[0].decision.actions, [])
  assert.deepEqual(f.host.residentStore.listSourceDispatchOwnership('native-group'), [])
  assert.deepEqual(await f.host.query('task.list'), []); assert.deepEqual(await f.host.query('coordination.list'), [])
  const source = (await f.host.query('source.list'))[0]; assert.ok(source.processingCompleted)
  assert.equal(f.requests.filter(request => request.tools.some(tool => tool.name === 'group_topic_route_submit')).length, 1)
  const sent = f.host.sent.length
  await f.host.service.recover(); await f.host.service.whenIdle(); assert.equal(f.host.sent.length, sent)
})
