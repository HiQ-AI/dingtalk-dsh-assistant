import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { available, reason, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'

for (const [mode, scheduled] of [['completed-A', false], ['waiting-A', false], ['paused-B', false], ['completed-A', true], ['waiting-A', true]]) test(
  `current chat reads Tasks without mutation; retired observation never resumes the original Task: ${mode}, scheduled=${scheduled}`,
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    if (scheduled) t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    let finishA = mode === 'completed-A', continueB = false, topicId, actionCount = 0
    const ownerInputs = []
    const original = scheduled ? '九点以后等原材料完成，再继续原校验。' : '原材料处理完之后继续原校验。'
    const frozen = { id: 'legacy-continue', kind: 'task.supplement', args: {
      taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, messageId: 'legacy-input', text: original,
    } }
    const rows = {
      coordination: [{ id: 'legacy-order', groupId: 'native-group', state: 'active', revision: 1 }],
      coordination_sources: [{ id: 'legacy-source', unitId: 'legacy-unit', revision: 1, groupId: 'native-group',
        sourceMessageId: 'original-order', dispatchOwner: 'coordination', state: 'accepted', original, sourceRefs: [] }],
      coordination_members: [
        { id: 'observe', coordinationId: 'legacy-order', taskId: 'A', state: 'applied', observation: true,
          dependencies: [], command: { id: 'legacy-observe', kind: 'coordination.observe', args: { taskId: 'A', expectedRequirementRevision: 1, expectedRunSequence: 1 } } },
        { id: 'continue', coordinationId: 'legacy-order', taskId: 'B', state: 'pending', dependencies: ['observe'], command: frozen },
      ],
      ...(scheduled ? { coordination_schedules: [{ id: 'legacy-schedule', coordinationId: 'legacy-order', state: 'active',
        revision: 1, timezone: 'Asia/Shanghai', nextDueAt: '2026-10-21T01:00:00.000Z',
        rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, action: { kind: 'task-command', instructionIds: ['continue'] },
        target: { conversationId: 'native-group', recipientIds: ['original-requester'] } }] } : {}),
    }
    const decide = request => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name), values = modelToolValues(request)
      assert.ok(!names.includes('coordination_submit'), 'Removed planning must not regain authority from old stored rows')
      if (input.trigger === 'task-facts') return topicTaskCalls(request)
      if (names.includes('group_topic_route_submit')) {
        const calls = topicTaskCalls(request, { title: '原材料与校验进展' })
        if (topicId) for (const route of calls[0].args.routes) for (const unit of route.units)
          unit.topics = [{ topicId, relationship: 'continuation', reason: '同一事项明确后续' }]
        return calls
      }
      if (names.includes('group_decision_submit')) {
        topicId = input.topicId
        const tasks = values.flatMap(value => value.tasks ?? [])
        const a = tasks.find(task => task.taskId === 'A'), b = tasks.find(task => task.taskId === 'B')
        if (!a || !b) return [{ name: 'group_task_context_get', args: { taskIds: ['A', 'B'] } }]
        const review = values.findLast(value => Array.isArray(value.candidates))
        if (!review) return [{ name: 'group_reply_review_get', args: { requestIds: [input.requestId] } }]
        const current = input.messages.at(-1), refs = [{ unitId: current.unitId, unitRevision: current.unitRevision }]
        const explicit = current.messageId === 'explicit-continue'
        if (explicit) actionCount++
        return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId, revision: input.revision,
          decision: { basisMessageIds: [current.messageId], basisUnitRefs: refs,
            actions: explicit ? [{ kind: 'task-context', taskId: 'B', inputVersion: b.inputVersion, runSequence: b.runSequence,
              context: current.text, progressImpact: 'preserve', topicRefs: [{ topicId, revision: input.revision }], basisUnitRefs: refs }] : [],
            reply: explicit ? '已按本次明确要求继续原校验。'
              : `已只读核对：原材料${a.state === 'completed' ? '已完成' : '仍未完成'}；原校验保持现状，未执行历史安排。`,
            replyToMessageId: current.messageId, atOpenDingTalkIds: ['native-user'],
            replyReview: { kind: explicit ? 'confirmation' : 'substantive',
              reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
          } } }]
      }
      assert.ok(names.includes('task_session_submit'), 'The current Task Owner tool must actually execute')
      ownerInputs.push({ taskId: input.task.taskId, sessionId: input.task.sessionId, contextRevision: input.task.contextRevision })
      const complete = input.task.taskId === 'A' ? finishA : continueB
      return [{ name: 'task_session_submit', args: { decision: { action: complete ? 'complete' : 'wait',
        summary: complete ? '原事项正式验收完成' : '等待明确后续', evidence: complete ? ['current-owner-proof'] : [], limitations: [],
      } } }]
    }
    const f = await retiredCoordinationHost(t, { name: 'observed-current-native-', decide, rows,
      tasks: [{ taskId: 'A', title: '原材料', request: '核验原材料' }, { taskId: 'B', title: '原校验', request: '完成原校验' }] })
    const command = (kind, args) => f.host.service.store.command({ id: randomUUID(), kind, args })
    if (mode === 'paused-B') {
      const b = await f.host.query('task.get', { taskId: 'B' })
      await command('task.control', { taskId: 'B', expectedControlRevision: b.controlRevision, control: 'paused', reason: '明确暂停原校验' })
      await f.host.service.recover(); await f.host.service.whenIdle()
    }
    const beforeA = await f.host.query('task.get', { taskId: 'A' }), beforeB = await f.host.query('task.get', { taskId: 'B' })
    const wakes = await f.host.query('wake.list'), owners = ownerInputs.length
    const history = await f.host.query('coordination.get', { coordinationId: 'legacy-order' })
    assert.equal(history.members.find(item => item.id === 'observe').observation, true)
    assert.deepEqual(history.members.find(item => item.id === 'continue').command, frozen)
    const query = { groupId: 'native-group', messageId: 'read-current', senderOpenDingTalkId: 'native-user', senderName: '需求提出人',
      text: '测试助手，只读查看原材料和校验的进展，不改变任务或恢复历史安排。', timestamp: '2026-10-21T01:00:00Z' }
    await f.host.service.ingest(query); await f.host.service.whenIdle()
    assert.equal(f.host.sent.length, 1, JSON.stringify(f.host.service.listAlerts()))
    const notice = f.host.sent[0]
    assert.equal(notice.payload.sourceMessageId, query.messageId)
    assert.deepEqual(notice.payload.atOpenDingTalkIds, ['native-user'])
    assert.equal((await f.host.query('notification.get', { notificationId: notice.id })).state, 'delivered')
    assert.ok(f.host.toolResults.some(item => item.name === 'group_task_context_get' && JSON.stringify(item.result).includes('核验原材料')
      && JSON.stringify(item.result).includes('完成原校验')), 'Both task details must be returned by the actual scoped read')
    assert.equal(ownerInputs.length, owners)
    assert.deepEqual(await f.host.query('task.get', { taskId: 'A' }), beforeA)
    assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), beforeB)
    assert.deepEqual(await f.host.query('wake.list'), wakes)
    if (scheduled) t.mock.timers.tick(3600000)
    await f.restart(); await f.host.service.recover(); await f.host.service.whenIdle()
    assert.equal(f.host.sent.length, 0); assert.equal(ownerInputs.length, owners)
    assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), beforeB)
    assert.deepEqual(await f.host.query('coordination.occurrence.list'), [])
    assert.equal((await f.host.query('coordination.source.list'))[0].original, original)
    if (beforeA.status !== 'completed') {
      finishA = true
      await f.host.service.appendTaskContext({ taskId: 'A', requestId: 'current-A-verification', context: '当前已核对原材料，请完成原事项。',
        expectedRequirementRevision: beforeA.requirementRevision, expectedControlRevision: beforeA.controlRevision, progressImpact: 'preserve' })
      await f.host.service.whenIdle()
      assert.equal((await f.host.query('task.get', { taskId: 'A' })).status, 'completed')
      assert.deepEqual(await f.host.query('task.get', { taskId: 'B' }), beforeB,
        'Completion of the observed Task is evidence only, never an automatic authorization for another Task')
    }
    const completedA = await f.host.query('task.get', { taskId: 'A' })
    if (mode === 'paused-B') {
      await command('task.control', { taskId: 'B', expectedControlRevision: beforeB.controlRevision, control: 'active', reason: '当前明确解除暂停' })
      await f.host.service.recover(); await f.host.service.whenIdle()
      assert.equal((await f.host.query('task.get', { taskId: 'B' })).status, 'active')
    }
    continueB = true
    const followup = { ...query, messageId: 'explicit-continue', text: '测试助手，现在明确继续原校验，保留原目标，不重做已完成材料。' }
    await f.host.service.ingest(followup); await f.host.service.whenIdle()
    const b = await f.host.query('task.get', { taskId: 'B' })
    assert.equal(b.status, 'completed', JSON.stringify(f.host.service.listAlerts()))
    assert.equal(actionCount, 1); assert.equal(b.contextRevision, (beforeB.contextRevision ?? 0) + 1)
    assert.equal(b.sessionId, beforeB.sessionId); assert.equal(b.runSequence, beforeB.runSequence)
    assert.ok(ownerInputs.filter(item => item.taskId === 'B').every(item => item.sessionId === beforeB.sessionId))
    assert.deepEqual(await f.host.query('task.get', { taskId: 'A' }), completedA)
    assert.deepEqual(await f.host.query('coordination.get', { coordinationId: 'legacy-order' }), history)
    assert.equal((await f.host.query('task.list')).length, 2)
    const completion = f.host.sent.find(item => item.payload.coveredEventIds?.length && item.payload.taskIds?.includes('B'))
    assert.ok(completion, 'The current Owner fact must produce a real Topic notification')
    const fact = await f.host.query('topic.fact.get', { factId: completion.payload.coveredEventIds[0] })
    assert.equal(fact.decision.decision.replyToMessageId, followup.messageId)
    const sources = await Promise.all(fact.sourceIds.map(sourceId => f.host.query('source.get', { sourceId })))
    assert.ok(sources.some(source => source.messageId === followup.messageId && source.text === followup.text))
    assert.equal(completion.payload.sourceMessageId, undefined, 'Provenance stays in the fact ledger rather than becoming a quote')
    assert.deepEqual(completion.payload.atOpenDingTalkIds, ['native-user'])
    assert.equal(completion.payload.replyToMessageId, undefined, 'Final facts use the shared ordinary-message path')
    await f.restart()
    await Promise.all([f.host.service.recover(), f.host.service.ingest(followup)]); await f.host.service.whenIdle()
    assert.equal(actionCount, 1); assert.equal(f.host.sent.length, 0)
    assert.equal((await f.host.query('notification.get', { notificationId: completion.id })).state, 'delivered')
  })
