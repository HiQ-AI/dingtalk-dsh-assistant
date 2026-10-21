import { localSlot, nextTimeSlot, summarizeTimeSlots, validateTimeRule } from './coordination-time.js'

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
  const coordinationActive = coordinationId => get('dynamic_coordination', coordinationId).state !== 'cancelled'
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
  function snapshot(occurrence) {
    const coordination = get('dynamic_coordination', occurrence.coordinationId)
    const results = occurrence.action.taskIds.map(id => {
      const task = get('dynamic_tasks', id, true)
      if (!task || task.groupId !== coordination.groupId) return { taskId: id, unavailable: true }
      return { taskId: id, title: task.title, status: task.status, control: task.control, requirementRevision: task.requirementRevision,
        contextRevision: task.contextRevision ?? 0, runSequence: task.runSequence, completion: task.completion ?? null }
    })
    return { observedAt: now(), results, limitations: ['Task ledger only; deployment and external acceptance are not inferred.'] }
  }
  function cancelOccurrence(occurrence, stamp, reason) {
    if (occurrence.cancelledAt) return
    occurrence.instanceControlRevision++; occurrence.deliveryControlRevision++
    occurrence.cancelledAt = stamp; occurrence.cancellationReason = reason
    if (['waiting','running'].includes(occurrence.actionState)) occurrence.actionState = 'cancelled'
    const job = read('jobs', occurrence.jobId, true)
    if (job && ['waiting','running'].includes(job.state)) { job.state = 'cancelled'; job.fence++; save('jobs', job) }
    const candidates = all('dynamic_notifications').filter(n => n.payload?.fact?.occurrenceId === occurrence.id)
    const notification = candidates.find(n => n.state === 'delivered')
      ?? candidates.find(n => n.sendPermit && !n.deliveryError?.knownNotSent)
    if (notification?.state === 'delivered') occurrence.deliveryState = 'delivered'
    else if (notification?.sendPermit && !notification.deliveryError?.knownNotSent) {
      occurrence.deliveryState = 'unknown'; occurrence.cancellationBoundary = 'send-permit-already-granted'
    } else if (occurrence.deliveryState !== 'none') occurrence.deliveryState = 'cancelled'
    save('occurrences', occurrence)
  }
  function cancelCoordination(coordinationId) {
    const stamp = now()
    for (const schedule of list('schedules').filter(s => s.coordinationId === coordinationId && !['cancelled','completed'].includes(s.state))) {
      schedule.history.push({ revision: schedule.revision, state: schedule.state, changedAt: stamp, reason: 'coordination-cancelled' })
      schedule.revision++; schedule.state = 'cancelled'; schedule.nextDueAt = null
      save('schedules', schedule)
    }
    for (const occurrence of list('occurrences').filter(o => o.coordinationId === coordinationId && !['expired','superseded'].includes(o.actionState)))
      cancelOccurrence(occurrence, stamp, 'coordination-cancelled')
  }
  function replaceUnstarted(schedule, occurrence, plannedAt, stamp) {
    const oldSlot = read('slots', occurrence.slotId)
    if (occurrence.actionState !== 'waiting' || oldSlot.startedOccurrenceId || oldSlot.currentOccurrenceId !== occurrence.id) fail('DYNAMIC_COORDINATION_SLOT_CONSUMED')
    const slotId = digest({ scheduleId: schedule.id, plannedAt })
    if (slotId !== occurrence.slotId && read('slots', slotId, true)) fail('DYNAMIC_COORDINATION_SLOT_CONSUMED')
    const id = `${occurrence.id}:replacement:${schedule.revision}`
    const replacement = { ...clone(occurrence), id, plannedAt, slotId, acceptedAt: stamp,
      acceptedScheduleRevision: schedule.revision, instanceControlRevision: 1, deliveryControlRevision: 1,
      replacementOf: occurrence.id, action: clone(schedule.action), target: clone(schedule.target), jobId: `job:${id}` }
    occurrence.actionState = 'superseded'; occurrence.replacedBy = id; occurrence.instanceControlRevision++
    const oldJob = read('jobs', occurrence.jobId)
    oldJob.state = 'superseded'; oldJob.fence++; save('jobs', oldJob)
    save('occurrences', occurrence); save('occurrences', replacement)
    if (slotId === oldSlot.id) { oldSlot.currentOccurrenceId = id; save('slots', oldSlot) }
    else {
      oldSlot.retired = true; oldSlot.replacedBySlotId = slotId; save('slots', oldSlot)
      save('slots', { id: slotId, scheduleId: schedule.id, plannedAt, currentOccurrenceId: id, startedOccurrenceId: null, replacementOfSlotId: oldSlot.id })
    }
    save('jobs', { id: replacement.jobId, occurrenceId: id, state: 'waiting', fence: 0, attempt: 0 })
    return replacement
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
        freshnessWindowMs: a.freshnessWindowMs ?? 300000,
        misfirePolicy: a.misfirePolicy ?? 'coalesce-latest', overlapPolicy: 'serial', maxBacklog: 1, cursor: null, history: [],
        nextDueAt: nextTimeSlot(a.rule, a.timezone, milliseconds), createdAt: stamp }
      if (!Number.isSafeInteger(schedule.graceMs) || schedule.graceMs < 0 || schedule.graceMs > 604800000) fail('DYNAMIC_ARGUMENT_INVALID')
      if (!Number.isSafeInteger(schedule.freshnessWindowMs) || schedule.freshnessWindowMs < 1000 || schedule.freshnessWindowMs > 86400000) fail('DYNAMIC_ARGUMENT_INVALID')
      if (!['coalesce-latest','catch-up-once','expire'].includes(schedule.misfirePolicy)) fail('DYNAMIC_ARGUMENT_INVALID')
      save('schedules', schedule); return { schedule }
    }
    if (kind === 'coordination.schedule.change') {
      const schedule = read('schedules', a.scheduleId)
      if (schedule.revision !== a.expectedRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      if (!['active','paused'].includes(schedule.state)) fail('DYNAMIC_COORDINATION_TERMINAL')
      const coordination = get('dynamic_coordination', schedule.coordinationId)
      if (!coordinationActive(coordination.id)) fail('DYNAMIC_COORDINATION_CANCELLED')
      const rule = a.rule ?? schedule.rule, timezone = a.timezone ?? schedule.timezone
      try { validateTimeRule(rule, timezone) } catch { fail('DYNAMIC_COORDINATION_TIME_INVALID') }
      if (a.state !== undefined && !['active','paused','cancelled'].includes(a.state)) fail('DYNAMIC_ARGUMENT_INVALID')
      const scope = a.scope ?? 'future'
      if (!['future','unstarted'].includes(scope)) fail('DYNAMIC_ARGUMENT_INVALID')
      if (a.replacementPlannedAt !== undefined && (scope !== 'unstarted' || Date.parse(timestamp(a.replacementPlannedAt)) <= milliseconds)) fail('DYNAMIC_COORDINATION_TIME_PAST')
      const definitionChanged = a.rule !== undefined || a.timezone !== undefined || a.action !== undefined || a.target !== undefined
      schedule.history.push({ revision: schedule.revision, rule: schedule.rule, timezone: schedule.timezone,
        action: schedule.action, target: schedule.target, state: schedule.state, effectiveFrom: schedule.effectiveFrom,
        nextDueAt: schedule.nextDueAt, cursor: clone(schedule.cursor), scope, changedAt: stamp })
      schedule.revision++; schedule.effectiveFrom = stamp; schedule.rule = clone(rule); schedule.timezone = timezone
      schedule.action = validAction(a.action ?? schedule.action, coordination.groupId)
      schedule.target = validTarget(a.target ?? schedule.target, coordination.groupId)
      schedule.state = a.state ?? schedule.state
      // Pausing preserves the due cursor. Resuming without redefining the rule
      // uses the same misfire policy, rather than silently dropping missed work.
      if (definitionChanged) schedule.nextDueAt = nextTimeSlot(rule, timezone, milliseconds, schedule.cursor?.localDate)
      const replacements = []
      const instances = list('occurrences').filter(o => o.scheduleId === schedule.id)
      if (schedule.state === 'cancelled') {
        schedule.nextDueAt = null
        for (const occurrence of instances.filter(o => !['expired','superseded'].includes(o.actionState))) cancelOccurrence(occurrence, stamp, 'schedule-cancelled')
      } else if (scope === 'unstarted') {
        const waiting = instances.filter(o => o.actionState === 'waiting')
        if (!waiting.length && instances.some(o => o.actionState === 'running')) fail('DYNAMIC_COORDINATION_SLOT_CONSUMED')
        if (a.replacementPlannedAt && waiting.length !== 1) fail('DYNAMIC_COORDINATION_REPLACEMENT_AMBIGUOUS')
        for (const occurrence of waiting) replacements.push(replaceUnstarted(schedule, occurrence, a.replacementPlannedAt ?? occurrence.plannedAt, stamp))
        if (a.replacementPlannedAt && (!schedule.nextDueAt || a.replacementPlannedAt < schedule.nextDueAt)) schedule.nextDueAt = a.replacementPlannedAt
      }
      save('schedules', schedule); return { schedule, replacements }
    }
    if (kind === 'coordination.schedule.scan') {
      const limit = a.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DYNAMIC_ARGUMENT_INVALID')
      const accepted = []
      for (const schedule of list('schedules').filter(s => s.state === 'active' && coordinationActive(s.coordinationId) && s.nextDueAt && s.nextDueAt <= stamp).sort((a,b) => a.nextDueAt.localeCompare(b.nextDueAt)).slice(0,limit)) {
        let plannedAt = schedule.nextDueAt, merged = 0
        const firstMissedAt = plannedAt
        if (schedule.rule.kind !== 'once') {
          const missed = summarizeTimeSlots(schedule.rule, schedule.timezone, Date.parse(plannedAt), milliseconds)
          if (missed.latest) { plannedAt = missed.latest; merged = missed.count - 1 }
        }
        const slotId = digest({ scheduleId: schedule.id, plannedAt })
        const localDate = localSlot(plannedAt, schedule.timezone).date
        if (!read('slots', slotId, true)) {
          const occurrenceId = `time:${slotId}`
          const expired = schedule.misfirePolicy !== 'catch-up-once' && milliseconds - Date.parse(plannedAt) > schedule.graceMs
          const occurrence = { id: occurrenceId, coordinationId: schedule.coordinationId, triggerKind: 'time', scheduleId: schedule.id,
            acceptedScheduleRevision: schedule.revision, plannedAt, slotId, instanceControlRevision: 1, deliveryControlRevision: 1,
            actionState: expired ? 'expired' : 'waiting', deliveryState: 'none', acceptedAt: stamp, merged,
            freshnessWindowMs: schedule.freshnessWindowMs,
            mergedRange: firstMissedAt === plannedAt ? null : { from: firstMissedAt, through: plannedAt },
            action: clone(schedule.action), target: clone(schedule.target), jobId: `job:${occurrenceId}` }
          save('occurrences', occurrence)
          save('slots', { id: slotId, scheduleId: schedule.id, plannedAt, currentOccurrenceId: occurrenceId, startedOccurrenceId: null })
          if (!expired) {
            // At most one unstarted backlog member. Every discarded instance is
            // retained with an explicit merge link and cannot be revived by scan.
            for (const older of list('occurrences').filter(o => o.scheduleId === schedule.id && o.id !== occurrence.id && o.actionState === 'waiting')) {
              older.actionState = 'superseded'; older.mergedInto = occurrence.id; older.instanceControlRevision++
              const job = read('jobs', older.jobId); job.state = 'superseded'; job.fence++; save('jobs', job); save('occurrences', older)
              occurrence.mergedOccurrenceIds = [...(occurrence.mergedOccurrenceIds ?? []), older.id]
            }
            save('occurrences', occurrence)
            save('jobs', { id: occurrence.jobId, occurrenceId, state: 'waiting', fence: 0, attempt: 0 })
          } else if (schedule.rule.kind === 'once') { schedule.state = 'completed'; schedule.outcome = 'expired' }
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
      if (!coordinationActive(occurrence.coordinationId)) fail('DYNAMIC_COORDINATION_CANCELLED')
      if (occurrence.cancelledAt || ['cancelled','superseded','expired'].includes(occurrence.actionState)) fail('DYNAMIC_COORDINATION_CANCELLED')
      if (job.state === 'completed' || job.state === 'running' && job.leaseUntil > stamp) fail('DYNAMIC_COORDINATION_JOB_BUSY')
      if (job.state === 'waiting') {
        if (schedule.state !== 'active') fail('DYNAMIC_COORDINATION_REVISION_STALE')
        if (occurrence.plannedAt > stamp) fail('DYNAMIC_COORDINATION_NOT_DUE')
        const acceptedDefinition = occurrence.acceptedScheduleRevision === schedule.revision ? schedule
          : schedule.history.find(revision => revision.revision === occurrence.acceptedScheduleRevision)
        // A future-only revision leaves an earlier accepted occurrence valid,
        // but does not grant permission to invent an unrecorded old definition.
        if (!acceptedDefinition || digest(acceptedDefinition.action) !== digest(occurrence.action)
          || digest(acceptedDefinition.target) !== digest(occurrence.target)) fail('DYNAMIC_COORDINATION_REVISION_STALE')
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
        || !coordinationActive(occurrence.coordinationId) || occurrence.cancelledAt || job.instanceControlRevision !== occurrence.instanceControlRevision) fail('DYNAMIC_COORDINATION_JOB_STALE')
      // Whitelisted in-process projection only: no arbitrary tools, Owner calls,
      // attachment writes, Task mutations or model-supplied "read-only" assertions.
      job.state = 'completed'; job.result = snapshot(occurrence)
      occurrence.actionState = 'succeeded'; occurrence.result = clone(job.result); occurrence.deliveryState = 'pending'
      save('jobs', job); save('occurrences', occurrence); return { job, occurrence }
    }
    if (kind === 'coordination.occurrence.cancel') {
      const occurrence = read('occurrences', a.occurrenceId)
      if (occurrence.instanceControlRevision !== a.expectedControlRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      cancelOccurrence(occurrence, stamp, 'occurrence-cancelled'); return { occurrence }
    }
    fail('DYNAMIC_COMMAND_UNKNOWN', kind)
  }
  return { command, list, read, cancelCoordination, snapshot }
}
