import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { available, reason, nativeTaskHost, topicTaskCalls } from './fixtures/task-session-native-host.js'
for (const blockedBy of ['occurrence-pause', 'schedule-pause', 'dependency']) test(`blocked schedules preserve ready cross-group work and do not replay after restart: ${blockedBy}`, { timeout: 60000 }, async t => {
  assert.ok(available, reason)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const root = await mkdtemp(join(tmpdir(), 'coordination-job-fairness-'))
  const decide = request => topicTaskCalls(request) ?? [{ name: 'task_session_submit',
    args: { decision: { action: 'wait', summary: '保持原目标', evidence: [], limitations: [] } } }]
  let host = await nativeTaskHost(root, decide)
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args = {}) => host.service.store.command({ id: randomUUID(), kind, args })
  await host.residentStore.subscribe({ groupId: 'other-group', name: '另一群', responsibility: '独立查询' })
  for (const [coordinationId, groupId, count] of [['paused', 'native-group', 3], ['later', 'native-group', 2], ['other', 'other-group', 1]]) {
    await command('task.create', { taskId: coordinationId, groupId, request: '保持原目标' })
    const source = (await command('coordination.reserve', { unitId: coordinationId, revision: 1, groupId, original: '独立时间查询' })).result.source
    const dependent = blockedBy === 'dependency' && coordinationId === 'paused'
    if (dependent) await command('task.create', { taskId: 'dependent', groupId, request: '等前置完成' })
    const members = dependent ? ['paused', 'dependent'].map((taskId, index) => ({ instructionId: taskId, taskId,
      dependencies: index ? ['paused'] : [], progressImpact: 'preserve', command: { id: `coordination-command:paused:${taskId}`,
        kind: 'task.supplement', args: { taskId, expectedRequirementRevision: 1, expectedControlRevision: 1,
          messageId: `context-${taskId}`, text: '保持原目标', request: '保持原目标' } } })) : []
    await command('coordination.accept', { coordinationId, sourceId: source.id, fence: source.fence, members, readOnly: !dependent })
    for (let i = 0; i < count; i++) await command('coordination.schedule.create', { coordinationId, scheduleId: `${coordinationId}-${i}`,
      timezone: 'Asia/Shanghai', rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' },
      action: dependent ? { kind: 'task-command', instructionIds: ['dependent'] } : { kind: 'read-query', taskIds: [coordinationId] }, target: { conversationId: groupId, recipientIds: [] } })
  }
  t.mock.timers.tick(3600000)
  const occurrences = (await command('coordination.schedule.scan', { limit: 100 })).result.occurrences
  assert.equal(occurrences.length, 6)
  for (const occurrence of occurrences.filter(item => item.coordinationId === 'paused')) {
    if (blockedBy === 'occurrence-pause') await command('coordination.occurrence.control', {
      occurrenceId: occurrence.id, expectedControlRevision: 1, control: 'pause' })
    else if (blockedBy === 'schedule-pause') await command('coordination.schedule.change', { scheduleId: occurrence.scheduleId, expectedRevision: 1, state: 'paused', scope: 'future' })
  }
  await host.close(); host = await nativeTaskHost(root, decide, { initialize: false })
  await host.service.recover()
  await host.service.whenIdle()
  const jobs = await host.query('coordination.job.list')
  assert.equal(jobs.filter(job => job.state === 'completed' && job.attempt === 1).length, 3)
  assert.equal(jobs.filter(job => job.state === 'waiting' && (blockedBy === 'dependency' ? job.attempt > 0 && job.waitingReason === 'waiting_dependency' : job.attempt === 0)).length, 3)
  for (const id of ['later', 'other']) {
    const occurrence = (await host.query('coordination.occurrence.list')).find(item => item.coordinationId === id)
    assert.equal(occurrence.actionState, 'succeeded')
  }
  await host.close(); host = await nativeTaskHost(root, decide, { initialize: false })
  await host.service.recover(); await host.service.whenIdle()
  assert.deepEqual((await host.query('coordination.job.list')).filter(job => job.state === 'completed').map(job => [job.id, job.attempt]),
    jobs.filter(job => job.state === 'completed').map(job => [job.id, job.attempt]))
})
