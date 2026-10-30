import assert from 'node:assert/strict'
import test from 'node:test'
import { available, reason } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'

// Old schedule/job fairness is no longer an active feature. Its retained safety
// guarantee is that paused/dependent historical work cannot block current Owners.
for (const blockedBy of ['occurrence-pause', 'schedule-pause', 'dependency']) test('retired ' + blockedBy + ' preserves history without blocking ready cross-group Task Owners',
  { timeout: 60000 }, async t => {
    assert.ok(available, reason)
    const rows = { coordination: [], coordination_schedules: [], coordination_occurrences: [], coordination_jobs: [], coordination_members: [] }
    for (const [id, groupId, count] of [['paused', 'native-group', 3], ['later', 'native-group', 2], ['other', 'other-group', 1]]) {
      rows.coordination.push({ id, groupId, state: 'active', revision: 1, memberIds: [id + '-member'] })
      rows.coordination_members.push({ id: id + '-member', coordinationId: id, taskId: id, state: id === 'paused' ? 'waiting' : 'applied',
        dependencies: id === 'paused' && blockedBy === 'dependency' ? ['predecessor'] : [], instruction: '保留原安排，不新增授权' })
      for (let index = 0; index < count; index++) {
        const scheduleId = id + '-' + index, occurrenceId = scheduleId + '-occurrence'
        rows.coordination_schedules.push({ id: scheduleId, coordinationId: id, state: id === 'paused' && blockedBy === 'schedule-pause' ? 'paused' : 'active',
          timezone: 'Asia/Shanghai', rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, nextDueAt: '2026-10-21T01:00:00.000Z' })
        rows.coordination_occurrences.push({ id: occurrenceId, scheduleId, coordinationId: id, state: id === 'paused' && blockedBy === 'occurrence-pause' ? 'paused' : 'pending',
          plannedAt: '2026-10-21T01:00:00.000Z', action: { kind: 'read-query', taskIds: [id] } })
        rows.coordination_jobs.push({ id: occurrenceId + '-job', occurrenceId, coordinationId: id, state: 'waiting', attempt: 0,
          ...(id === 'paused' && blockedBy === 'dependency' ? { waitingReason: 'waiting_dependency' } : {}) })
      }
    }
    const f = await retiredCoordinationHost(t, { name: 'retired-fairness-', tasks: [
      { taskId: 'paused' }, { taskId: 'later' }, { taskId: 'other', groupId: 'other-group' },
    ], rows })
    let h = f.host
    const schedules = await h.query('coordination.schedule.list'), jobs = await h.query('coordination.job.list')
    assert.equal(schedules.length, 6); assert.equal(jobs.length, 6)
    for (const [table, records] of [['coordination.schedule.list', rows.coordination_schedules], ['coordination.job.list', rows.coordination_jobs]]) {
      const saved = await h.query(table)
      for (const original of records) {
        const row = saved.find(item => item.id === original.id), { retirement, ...body } = row
        assert.deepEqual(body, original)
        assert.equal(retirement.previousState, original.state)
      }
    }
    assert.deepEqual(await h.query('coordination.occurrence.list'), rows.coordination_occurrences)
    await h.service.recover(); await h.service.whenIdle()
    assert.deepEqual(await h.query('task.list'), f.beforeTasks, 'retirement must not silently complete/cancel business work')
    for (const taskId of ['later', 'other']) {
      const task = await h.query('task.get', { taskId })
      await h.service.appendTaskContext({ taskId, requestId: 'fresh-' + taskId, context: '只核对原范围内新增材料',
        expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision, progressImpact: 'preserve' })
    }
    await h.service.whenIdle()
    for (const taskId of ['later', 'other']) {
      const task = await h.query('task.get', { taskId })
      assert.equal(task.contextRevision, 1); assert.equal(task.requirementRevision, 1); assert.equal(task.status, 'active')
    }
    assert.deepEqual(await h.query('task.get', { taskId: 'paused' }), f.beforeTasks.find(task => task.taskId === 'paused'))
    assert.deepEqual(await h.query('coordination.job.list'), jobs)
    assert.equal(h.sent.length, 0)
    assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
    const current = await h.query('task.list')
    h = await f.restart(); await h.service.recover(); await h.service.whenIdle()
    assert.deepEqual(await h.query('task.list'), current)
    assert.deepEqual(await h.query('coordination.schedule.list'), schedules)
    assert.deepEqual(await h.query('coordination.job.list'), jobs)
    assert.deepEqual(await h.query('coordination.occurrence.list'), rows.coordination_occurrences)
    assert.equal(h.sent.length, 0)
  })
