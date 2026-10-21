// Trigger identities authorize no effects. The ledger separately validates the
// source fact, action, scope, control version and Task command preconditions.
export function coordinationTrigger(trigger, { fail, text, integer, digest }) {
  if (!trigger || Object.getPrototypeOf(trigger) !== Object.prototype) fail('DYNAMIC_COORDINATION_TRIGGER_INVALID')
  const required = trigger.triggerKind === 'time' ? ['scheduleId','acceptedScheduleRevision','plannedAt','slotId']
    : trigger.triggerKind === 'message' ? ['sourceUnitId','sourceUnitRevision','actionId']
      : trigger.triggerKind === 'business-event' ? ['eventSource','eventId','actionId'] : null
  if (!required || Object.keys(trigger).some(key => !['triggerKind', ...required].includes(key))) fail('DYNAMIC_COORDINATION_TRIGGER_INVALID')
  for (const key of required) {
    if (['acceptedScheduleRevision','sourceUnitRevision'].includes(key)) integer(trigger[key], key)
    else text(trigger[key], key)
  }
  if (trigger.triggerKind === 'time' && (!Number.isFinite(Date.parse(trigger.plannedAt))
    || new Date(trigger.plannedAt).toISOString() !== trigger.plannedAt
    || trigger.slotId !== digest({ scheduleId: trigger.scheduleId, plannedAt: trigger.plannedAt }))) fail('DYNAMIC_COORDINATION_TRIGGER_INVALID')
  return Object.fromEntries(['triggerKind', ...required].map(key => [key, trigger[key]]))
}

export function coordinationOccurrenceId(coordinationId, trigger, digest) {
  if (trigger.triggerKind === 'time') return `time:${trigger.slotId}`
  return `${trigger.triggerKind}:${digest({ coordinationId, ...trigger })}`
}
