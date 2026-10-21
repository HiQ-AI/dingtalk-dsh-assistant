import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls } from './fixtures/task-session-native-host.js'

const model = { enabled: true, provider: 'native-task-test', model: 'coordination-controlled' }

test('real ingress reserves a no-Topic unit, independently plans A then B and dispatches original Owners from completion facts',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'independent-native-'))
    let host, plans = 0
    const completions = []
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: {
        requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
          ignoredRefs: [], units: [{ unitKey: 'sequence', summary: '原任务先后安排', sourceRefs: [{ quote: message.text }],
            dispatchOwner: 'coordination', topics: [], reason: '独立于Topic的两任务安排' }] })) } }]
      if (names.includes('coordination_submit')) {
        const full = modelToolValues(request).find(v => v.taskContexts?.length === 2)
        if (!full) return [{ name: 'coordination_context_get', args: { taskIds: ['A','B'] } }]
        plans++
        return [{ name: 'coordination_submit', args: { kind: 'arrangement', commonContext: '保留原目标，核对本次补充', allTogether: true,
          members: full.taskContexts.map(task => ({ taskId: task.taskId, action: 'task-context', inputVersion: task.requirementRevision,
            runSequence: task.runSequence, progressImpact: 'preserve', impactReason: '仅增加定位材料，不改变目标/验收/授权',
            context: `${task.taskId}补充材料`, afterTaskIds: task.taskId === 'B' ? ['A'] : [] })) } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) {
        const supplemented = input.wakes.some(wake => wake.kind === 'task.supplement')
        if (supplemented) completions.push(input.task.taskId)
        return [{ name: 'task_session_submit', args: { decision: { action: supplemented ? 'complete' : 'wait',
          summary: supplemented ? `已核验${input.task.taskId}补充` : '等候原任务补充', evidence: supplemented ? [`proof:${input.task.taskId}`] : [], limitations: [] } } }]
      }
      return []
    }, { config: { coordination: model } })
    for (const taskId of ['A','B']) await host.service.store.command({ id: `seed:${taskId}`, kind: 'task.create',
      args: { taskId, groupId: 'native-group', ownerActorId: 'native-user', request: `原目标${taskId}` } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'sequence-input', senderOpenDingTalkId: 'native-user',
      senderName: '测试用户', text: '测试助手，先完成原任务A，再继续原任务B；各加定位材料。', timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    assert.equal(plans, 1, JSON.stringify(host.service.listAlerts()))
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
    assert.deepEqual((await host.query('task.list')).map(t => [t.taskId,t.status]), [['A','completed'],['B','completed']])
    assert.deepEqual(completions, ['A','B'])
    const reservations = host.residentStore.listSourceDispatchOwnership('native-group')
    assert.equal(reservations.length, 1); assert.equal(reservations[0].dispatchOwner, 'coordination'); assert.equal(reservations[0].settled, true)
    const state = await host.query('coordination.get', { coordinationId: reservations[0].coordinationId })
    assert.deepEqual(state.members.map(m => m.state), ['fulfilled','fulfilled'])
    assert.equal((await host.query('task.events')).events.length, 2)
    assert.equal(host.sent.filter(n => n.kind === 'topic-reply').length, 0)
    assert.equal(host.sent.filter(n => n.kind === 'coordination').length, 1)
    await host.service.recover(); await host.service.whenIdle()
    assert.equal(plans, 1); assert.deepEqual(completions, ['A','B'])
    assert.equal(host.sent.filter(n => n.kind === 'coordination').length, 1)
  })

test('ambiguous no-Topic request remains exclusively pending clarification without changing original tasks',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'independent-clarify-'))
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'ambiguous', summary: '对象待澄清', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '跨任务对象不明' }] })) } }]
      if (names.includes('coordination_submit')) return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '“第二个”指哪张已有安排中的任务？', candidates: [] } }]
      return topicTaskCalls(request) ?? []
    }, { config: { coordination: model } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'ambiguous', senderOpenDingTalkId: 'native-user', senderName: '测试用户',
      text: '测试助手，第二个先别动。', timestamp: '2026-10-21T01:00:00Z' })
    await host.service.whenIdle()
    const reservation = host.residentStore.listSourceDispatchOwnership('native-group')[0]
    assert.equal(reservation.semanticState, 'needs_clarification', JSON.stringify(host.service.listAlerts())); assert.equal(reservation.settled, false)
    assert.equal((await host.query('task.list')).length, 0)
    assert.equal((await host.query('source.list'))[0].routed, undefined)
    assert.equal(host.sent.length, 1); assert.equal(host.sent[0].kind, 'coordination')
  })

test('no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task',
  { skip: !available ? reason : false, timeout: 15000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
    const root = await mkdtemp(join(tmpdir(), 'independent-schedule-'))
    let host, ownerCalls = 0
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, request => {
      const names = request.tools.map(t => t.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'time', summary: '到期查原任务', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '独立时间计划' }] })) } }]
      if (names.includes('coordination_submit')) {
        if (!modelToolValues(request).some(v => v.taskContexts?.length)) return [{ name: 'coordination_context_get', args: { taskIds: ['A'] } }]
        return [{ name: 'coordination_submit', args: { kind: 'schedule', timezone: 'Asia/Shanghai',
          rule: { kind: 'once', at: '2026-10-21T00:01:00.000Z' }, taskIds: ['A'], recipientIds: ['native-user'],
          interpretation: '2026年10月21日08:01 Asia/Shanghai，在当前群@测试用户查询任务A' } }]
      }
      const topic = topicTaskCalls(request); if (topic) return topic
      if (names.includes('task_session_submit')) { ownerCalls++; return [{ name: 'task_session_submit', args: { decision: {
        action: 'wait', summary: '等待原交付', evidence: [], limitations: [] } } }] }
      return []
    }, { config: { coordination: model } })
    await host.service.store.command({ id: 'seed:A', kind: 'task.create', args: { taskId: 'A', groupId: 'native-group', ownerActorId: 'native-user', request: '原任务A' } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'schedule', senderOpenDingTalkId: 'native-user', senderName: '测试用户',
      text: '测试助手，今天08:01查任务A的进度，在群里通知我。', timestamp: '2026-10-21T00:00:00Z' })
    await host.service.whenIdle()
    const before = await host.query('task.get', { taskId: 'A' }), calls = ownerCalls
    assert.equal((await host.query('coordination.schedule.list')).length, 1)
    assert.equal((await host.query('coordination.occurrence.list')).length, 0)
    t.mock.timers.tick(60000)
    await host.service.recover(); await host.service.whenIdle()
    const after = await host.query('task.get', { taskId: 'A' })
    for (const key of ['requirementRevision','contextRevision','controlRevision','runSequence','status']) assert.equal(after[key], before[key])
    assert.equal(ownerCalls, calls)
    const occurrence = (await host.query('coordination.occurrence.list'))[0]
    assert.equal(occurrence.actionState, 'succeeded'); assert.equal(occurrence.deliveryState, 'delivered')
    assert.equal((await host.query('coordination.schedule.list'))[0].state, 'completed')
    const delivery = host.sent.find(n => n.payload.fact.occurrenceId === occurrence.id)
    assert.ok(delivery.sendPermit); assert.deepEqual(delivery.payload.atOpenDingTalkIds, ['native-user'])
    assert.ok(host.residentStore.getGroup('native-group').outbox.some(o => o.outboundId === delivery.id && o.status === 'sent'))
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
  })
