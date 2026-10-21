import { localSlot, nextTimeSlot, validateTimeRule } from './coordination-time.js'

export const scheduleSchema = `
${['schedules','occurrences','slots','jobs'].map(name => `CREATE TABLE dynamic_coordination_${name}(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));`).join('\n')}
CREATE INDEX coordination_due ON dynamic_coordination_schedules(json_extract(body,'$.state'),json_extract(body,'$.nextDueAt'));
CREATE UNIQUE INDEX coordination_slot ON dynamic_coordination_slots(json_extract(body,'$.scheduleId'),json_extract(body,'$.plannedAt'));
`

export function coordinationSchedules({ get, put, all, fail, text, integer, array, record, clone, digest, now }) {
  const table = name => `dynamic_coordination_${name}`
  const save = (name, value) => put(table(name), value)
  const read = (name, id, optional = false) => get(table(name), id, optional)
  const list = name => all(table(name))
  const timestamp = value => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('DYNAMIC_COORDINATION_TIME_INVALID')
    return value
  }
  const validAction = (action, groupId) => {
    record(action)
    if (action.kind !== 'read-query' || !array(action.taskIds).length || action.taskIds.length > 100) fail('DYNAMIC_COORDINATION_ACTION_INVALID')
    for (const id of action.taskIds) if (get('dynamic_tasks', id).groupId !== groupId) fail('DYNAMIC_COORDINATION_SCOPE')
    return clone(action)
  }
  const validTarget = (target, groupId) => {
    record(target)
    if (target.conversationId !== groupId || !Array.isArray(target.recipientIds) || target.recipientIds.some(id => typeof id !== 'string' || !id.trim())) fail('DYNAMIC_COORDINATION_SCOPE')
    return clone(target)
  }
  function command(kind, a) {
    const stamp = now(), milliseconds = Date.parse(stamp)
    if (kind === 'coordination.schedule.create') {
      const coordination = get('dynamic_coordination', a.coordinationId)
      if (coordination.state !== 'active') fail('DYNAMIC_COORDINATION_REVISION_STALE')
      const id = text(a.scheduleId, 'scheduleId')
      if (read('schedules', id, true)) fail('DYNAMIC_COORDINATION_EXISTS')
      try { validateTimeRule(a.rule, a.timezone) } catch { fail('DYNAMIC_COORDINATION_TIME_INVALID') }
      const effectiveFrom = stamp
      if (a.rule.kind === 'once' && Date.parse(a.rule.at) <= milliseconds) fail('DYNAMIC_COORDINATION_TIME_PAST')
      const schedule = { id, coordinationId: coordination.id, revision: 1, state: 'active', effectiveFrom,
        timezone: text(a.timezone, 'timezone'), rule: clone(a.rule), action: validAction(a.action, coordination.groupId),
        target: validTarget(a.target, coordination.groupId), graceMs: a.graceMs ?? 900000,
        misfirePolicy: 'coalesce-latest', overlapPolicy: 'serial', cursor: null, history: [],
        nextDueAt: nextTimeSlot(a.rule, a.timezone, milliseconds), createdAt: stamp }
      if (!Number.isSafeInteger(schedule.graceMs) || schedule.graceMs < 0 || schedule.graceMs > 604800000) fail('DYNAMIC_ARGUMENT_INVALID')
      save('schedules', schedule); return { schedule }
    }
    if (kind === 'coordination.schedule.change') {
      const schedule = read('schedules', a.scheduleId)
      if (schedule.revision !== a.expectedRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      if (!['active','paused'].includes(schedule.state)) fail('DYNAMIC_COORDINATION_TERMINAL')
      const coordination = get('dynamic_coordination', schedule.coordinationId)
      const rule = a.rule ?? schedule.rule, timezone = a.timezone ?? schedule.timezone
      try { validateTimeRule(rule, timezone) } catch { fail('DYNAMIC_COORDINATION_TIME_INVALID') }
      if (a.state !== undefined && !['active','paused','cancelled'].includes(a.state)) fail('DYNAMIC_ARGUMENT_INVALID')
      schedule.history.push({ revision: schedule.revision, rule: schedule.rule, timezone: schedule.timezone,
        action: schedule.action, target: schedule.target, state: schedule.state, changedAt: stamp })
      schedule.revision++; schedule.effectiveFrom = stamp; schedule.rule = clone(rule); schedule.timezone = timezone
      schedule.action = validAction(a.action ?? schedule.action, coordination.groupId)
      schedule.target = validTarget(a.target ?? schedule.target, coordination.groupId)
      schedule.state = a.state ?? schedule.state
      schedule.nextDueAt = schedule.state === 'active' ? nextTimeSlot(rule, timezone, milliseconds, schedule.cursor?.localDate) : null
      // Future changes leave started occurrences pinned to their accepted revision.
      for (const occurrence of list('occurrences').filter(o => o.scheduleId === schedule.id && o.actionState === 'waiting')) {
        occurrence.actionState = schedule.state === 'cancelled' ? 'cancelled' : 'superseded'
        occurrence.instanceControlRevision++; save('occurrences', occurrence)
      }
      if (schedule.state === 'cancelled') for (const occurrence of list('occurrences').filter(o => o.scheduleId === schedule.id && o.actionState !== 'cancelled')) {
        occurrence.instanceControlRevision++; occurrence.cancelledAt = stamp; save('occurrences', occurrence)
      }
      save('schedules', schedule); return { schedule }
    }
    if (kind === 'coordination.schedule.scan') {
      const limit = a.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DYNAMIC_ARGUMENT_INVALID')
      const accepted = []
      for (const schedule of list('schedules').filter(s => s.state === 'active' && s.nextDueAt && s.nextDueAt <= stamp).sort((a,b) => a.nextDueAt.localeCompare(b.nextDueAt)).slice(0,limit)) {
        let plannedAt = schedule.nextDueAt, merged = 0
        const firstMissedAt = plannedAt
        // Bounded arithmetic search: choose the most recent applicable local day,
        // not one iteration per missed slot across years of downtime.
        if (schedule.rule.kind !== 'once' && milliseconds - Date.parse(plannedAt) > 86400000) {
          const recent = nextTimeSlot(schedule.rule, schedule.timezone, milliseconds - 8 * 86400000)
          let candidate = recent
          while (candidate && candidate <= stamp) {
            if (candidate > plannedAt) { plannedAt = candidate; merged++ }
            candidate = nextTimeSlot(schedule.rule, schedule.timezone, Date.parse(candidate), localSlot(candidate, schedule.timezone).date)
          }
        }
        const slotId = digest({ scheduleId: schedule.id, plannedAt })
        const localDate = localSlot(plannedAt, schedule.timezone).date
        if (!read('slots', slotId, true)) {
          const occurrenceId = `time:${slotId}`
          const expired = milliseconds - Date.parse(plannedAt) > schedule.graceMs
          const occurrence = { id: occurrenceId, coordinationId: schedule.coordinationId, triggerKind: 'time', scheduleId: schedule.id,
            acceptedScheduleRevision: schedule.revision, plannedAt, slotId, instanceControlRevision: 1, deliveryControlRevision: 1,
            actionState: expired ? 'expired' : 'waiting', deliveryState: 'none', acceptedAt: stamp, merged,
            mergedRange: firstMissedAt === plannedAt ? null : { from: firstMissedAt, through: plannedAt },
            action: clone(schedule.action), target: clone(schedule.target), jobId: `job:${occurrenceId}` }
          save('occurrences', occurrence)
          save('slots', { id: slotId, scheduleId: schedule.id, plannedAt, currentOccurrenceId: occurrenceId, startedOccurrenceId: null })
          if (!expired) save('jobs', { id: occurrence.jobId, occurrenceId, state: 'waiting', fence: 0, attempt: 0 })
          accepted.push(occurrence)
        }
        schedule.cursor = { plannedAt, localDate }
        schedule.nextDueAt = nextTimeSlot(schedule.rule, schedule.timezone, Math.max(milliseconds, Date.parse(plannedAt)), localDate)
        save('schedules', schedule)
      }
      return { occurrences: accepted }
    }
    if (kind === 'coordination.job.claim') {
      const job = read('jobs', a.jobId), occurrence = read('occurrences', job.occurrenceId)
      const schedule = read('schedules', occurrence.scheduleId)
      if (occurrence.cancelledAt || ['cancelled','superseded','expired'].includes(occurrence.actionState)) fail('DYNAMIC_COORDINATION_CANCELLED')
      if (job.state === 'completed' || job.state === 'running' && job.leaseUntil > stamp) fail('DYNAMIC_COORDINATION_JOB_BUSY')
      if (job.state === 'waiting') {
        if (schedule.state !== 'active' || schedule.revision !== occurrence.acceptedScheduleRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
        if (list('occurrences').some(o => o.scheduleId === schedule.id && o.id !== occurrence.id
          && !o.cancelledAt && (o.actionState === 'running' || ['pending','unknown'].includes(o.deliveryState)))) fail('DYNAMIC_COORDINATION_OVERLAP')
        const slot = read('slots', occurrence.slotId)
        if (slot.currentOccurrenceId !== occurrence.id || slot.startedOccurrenceId && slot.startedOccurrenceId !== occurrence.id) fail('DYNAMIC_COORDINATION_SLOT_CONSUMED')
        slot.startedOccurrenceId = occurrence.id; save('slots', slot)
      }
      job.state = 'running'; job.fence++; job.attempt++; job.leaseUntil = new Date(milliseconds + 60000).toISOString()
      job.instanceControlRevision = occurrence.instanceControlRevision
      occurrence.actionState = 'running'; save('jobs', job); save('occurrences', occurrence)
      return { job, occurrence }
    }
    if (kind === 'coordination.job.read') {
      const job = read('jobs', a.jobId), occurrence = read('occurrences', job.occurrenceId)
      if (job.fence !== a.fence || job.state !== 'running' || job.leaseUntil <= stamp
        || occurrence.cancelledAt || job.instanceControlRevision !== occurrence.instanceControlRevision) fail('DYNAMIC_COORDINATION_JOB_STALE')
      // Whitelisted in-process projection only: no arbitrary tools, Owner calls,
      // attachment writes, Task mutations or model-supplied "read-only" assertions.
      const coordination = get('dynamic_coordination', occurrence.coordinationId)
      const results = occurrence.action.taskIds.map(id => {
        const task = get('dynamic_tasks', id, true)
        if (!task || task.groupId !== coordination.groupId) return { taskId: id, unavailable: true }
        return { taskId: id, title: task.title, status: task.status, control: task.control, requirementRevision: task.requirementRevision,
          contextRevision: task.contextRevision ?? 0, runSequence: task.runSequence, completion: task.completion ?? null }
      })
      job.state = 'completed'; job.result = { observedAt: stamp, results, limitations: ['Task ledger only; deployment and external acceptance are not inferred.'] }
      occurrence.actionState = 'succeeded'; occurrence.result = clone(job.result); occurrence.deliveryState = 'pending'
      save('jobs', job); save('occurrences', occurrence); return { job, occurrence }
    }
    if (kind === 'coordination.occurrence.cancel') {
      const occurrence = read('occurrences', a.occurrenceId)
      if (occurrence.instanceControlRevision !== a.expectedControlRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      occurrence.instanceControlRevision++; occurrence.cancelledAt = stamp
      if (occurrence.actionState === 'waiting') occurrence.actionState = 'cancelled'
      save('occurrences', occurrence); return { occurrence }
    }
    fail('DYNAMIC_COMMAND_UNKNOWN', kind)
  }
  return { command, list, read }
}
