// Calendar evaluation is deterministic and independent of model/session timers.
// Policy: skip nonexistent wall times; use the first UTC occurrence on a repeated day.
const formatters = new Map()
export function localSlot(instant, timezone) {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(timezone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function validateTimeRule(rule, timezone) {
  localSlot(Date.now(), timezone)
  if (rule?.kind === 'once') {
    if (typeof rule.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(rule.at)
      || !Number.isFinite(Date.parse(rule.at)) || new Date(rule.at).toISOString() !== rule.at) throw new Error('COORDINATION_TIME_INVALID')
  } else if (!['daily','weekly'].includes(rule?.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time ?? '')
    || rule.kind === 'weekly' && (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6)) throw new Error('COORDINATION_TIME_INVALID')
}

export function nextTimeSlot(rule, timezone, after, lastLocalDate = null) {
  validateTimeRule(rule, timezone)
  if (rule.kind === 'once') return Date.parse(rule.at) > after ? rule.at : null
  const start = Math.floor(after / 60000) * 60000 + 60000
  // Includes the week following a skipped DST day; no unbounded catch-up loop.
  for (let instant = start; instant <= start + 15 * 86400000; instant += 60000) {
    const local = localSlot(instant, timezone)
    if (local.date === lastLocalDate || local.time !== rule.time) continue
    if (rule.kind === 'weekly' && new Date(`${local.date}T12:00:00Z`).getUTCDay() !== rule.weekday) continue
    // On a fall-back day reject a second occurrence even if the scanner starts
    // after the first one, rather than treating it as an unconsumed new slot.
    let repeated = false
    for (let earlier = instant - 3 * 3600000; earlier < instant; earlier += 60000) {
      const candidate = localSlot(earlier, timezone)
      if (candidate.date === local.date && candidate.time === local.time) { repeated = true; break }
    }
    if (!repeated) return new Date(instant).toISOString()
  }
  throw new Error('COORDINATION_TIME_HORIZON')
}
