import { nativeLifecycle, nativeLifecycleTimeout } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { available, reason } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'

// Periodic Task commands belonged to the removed coordinator. Their original
// slots remain audit facts; a new explicit input still reaches the original Owner once.
test('retired daily Task schedule preserves both occurrence identities and never invents another Owner input',
  { ...({ skip: !available ? reason : false, timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
    const occurrences = ['2026-10-21T01:00:00.000Z', '2026-10-22T01:00:00.000Z'].map((plannedAt, index) => ({
      id: 'daily-occurrence-' + index, coordinationId: 'daily', scheduleId: 'daily-schedule', plannedAt,
      action: { kind: 'task-command', instructionIds: ['a-day-' + index] }, actionState: 'pending', deliveryState: 'pending',
    }))
    const slots = occurrences.map(item => ({ id: item.id + '-slot', scheduleId: item.scheduleId, plannedAt: item.plannedAt, occurrenceId: item.id }))
    await t.beginBusiness()
    const f = await t.step(async () => retiredCoordinationHost(t, { name: 'retired-recurring-', tasks: [{ taskId: 'A', request: '原任务A，保留完整目标' }], rows: {
      coordination: [{ id: 'daily', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['a-template'] }],
      coordination_members: [{ id: 'a-template', taskId: 'A', coordinationId: 'daily', state: 'waiting', dependencies: [],
        instruction: '每天核对已授权原目标', progressImpact: 'preserve' }],
      coordination_schedules: [{ id: 'daily-schedule', coordinationId: 'daily', state: 'active', timezone: 'Asia/Shanghai',
        rule: { kind: 'daily', time: '09:00' }, nextDueAt: '2026-10-23T01:00:00.000Z', action: { kind: 'task-command', instructionIds: ['a-template'] } }],
      coordination_occurrences: occurrences, coordination_slots: slots,
      coordination_jobs: occurrences.map(item => ({ id: item.id + '-job', occurrenceId: item.id, coordinationId: 'daily', state: 'pending', attempt: 0 })),
    } }))
    let h = f.host
    for (let attempt = 0; attempt < 2; attempt++) { await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle()) }
    assert.deepEqual(await t.step(async () => h.query('task.list')), f.beforeTasks)
    assert.deepEqual(await t.step(async () => h.query('coordination.occurrence.list')), occurrences)
    const savedSchedule = (await t.step(async () => h.query('coordination.schedule.list')))[0]
    assert.equal(savedSchedule.rule.kind, 'daily'); assert.equal(savedSchedule.rule.time, '09:00')
    assert.equal(savedSchedule.retirement.previousState, 'active')
    assert.ok((await t.step(async () => h.query('coordination.job.list'))).every(job => job.state === 'pending' && job.attempt === 0 && job.retirement))
    assert.equal(h.sent.length, 0)
    const args = { taskId: 'A', requestId: 'explicit-today', context: '今天只核对这份新增材料，目标不变',
      expectedRequirementRevision: 1, expectedControlRevision: 1, progressImpact: 'preserve' }
    await t.step(async () => h.service.appendTaskContext(args)); await t.step(async () => h.service.whenIdle())
    const task = await t.step(async () => h.query('task.get', { taskId: 'A' }))
    assert.equal(task.contextRevision, 1); assert.equal(task.requirementRevision, 1); assert.equal(task.runSequence, 1)
    assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
    const executions = await t.step(async () => h.query('execution.list')), notifications = await t.step(async () => h.query('notification.list'))
    h = await t.step(async () => f.restart()); await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
    const restored = await t.step(async () => h.query('task.get', { taskId: 'A' }))
    for (const key of ['taskId', 'groupId', 'objective', 'request', 'requirements', 'requirementRevision',
      'contextRevision', 'control', 'controlRevision', 'runSequence', 'status', 'sessionId', 'sessionBound',
      'sourceRefs', 'topicRefs', 'supplements', 'appliedOperations', 'lastDecision', 'drained'])
      assert.deepEqual(restored[key], task[key], 'recovery must preserve ' + key)
    assert.equal(restored.leaseEpoch, task.leaseEpoch + 1, 'one recovery reclaims the same Owner session once')
    assert.ok(Date.parse(restored.updatedAt) >= Date.parse(task.updatedAt))
    assert.deepEqual(await t.step(async () => h.query('execution.list')), executions)
    assert.deepEqual(await t.step(async () => h.query('notification.list')), notifications)
    assert.deepEqual(await t.step(async () => h.query('coordination.occurrence.list')), occurrences)
    assert.equal(h.sent.length, 0)
    assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
  }))
