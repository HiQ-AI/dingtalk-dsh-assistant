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
  if (!Number.isFinite(after)) throw new Error('COORDINATION_TIME_INVALID')
  if (rule.kind === 'once') return Date.parse(rule.at) > after ? rule.at : null
  const date = localSlot(after, timezone).date
  // Iterate local calendar days rather than every UTC minute while holding the
  // writer transaction. The first UTC candidate fixes fall-back disambiguation.
  for (let day = 0; day < 16; day++) {
    const candidateDate = addLocalDays(date, day)
    if (candidateDate === lastLocalDate || rule.kind === 'weekly' && new Date(`${candidateDate}T12:00:00Z`).getUTCDay() !== rule.weekday) continue
    const candidate = firstLocalInstant(candidateDate, rule.time, timezone)
    if (candidate !== null && candidate > after) return new Date(candidate).toISOString()
  }
  throw new Error('COORDINATION_TIME_HORIZON')
}

function addLocalDays(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

function firstLocalInstant(date, time, timezone) {
  const wall = Date.parse(`${date}T${time}:00Z`), offsets = new Set()
  // Cover both sides of ordinary DST, half-hour changes and date-line changes.
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wall + hours * 3600000, local = localSlot(probe, timezone)
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - probe)
  }
  const matches = [...offsets].map(offset => wall - offset).filter(instant => {
    const local = localSlot(instant, timezone)
    return local.date === date && local.time === time
  })
  return matches.length ? Math.min(...matches) : null
}

/** Exact count and latest UTC identity for coalesced offline slots. */
export function summarizeTimeSlots(rule, timezone, from, through) {
  validateTimeRule(rule, timezone)
  if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) throw new Error('COORDINATION_TIME_INVALID')
  if (rule.kind === 'once') {
    const present = Date.parse(rule.at) >= from && Date.parse(rule.at) <= through
    return { latest: present ? rule.at : null, count: present ? 1 : 0 }
  }
  const firstDate = localSlot(from, timezone).date, lastDate = localSlot(through, timezone).date
  const days = Math.round((Date.parse(`${lastDate}T12:00:00Z`) - Date.parse(`${firstDate}T12:00:00Z`)) / 86400000)
  if (days > 100000) throw new Error('COORDINATION_TIME_HORIZON')
  let latest = null, count = 0
  for (let day = 0; day <= days; day++) {
    const date = addLocalDays(firstDate, day)
    if (rule.kind === 'weekly' && new Date(`${date}T12:00:00Z`).getUTCDay() !== rule.weekday) continue
    const instant = firstLocalInstant(date, rule.time, timezone)
    if (instant !== null && instant >= from && instant <= through) { count++; latest = new Date(instant).toISOString() }
  }
  return { latest, count }
}
