// Historical table definitions remain so upgrades never drop audit data.
export const coordinationSchema = `
CREATE TABLE dynamic_coordination(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_members(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE UNIQUE INDEX coordination_source_unit ON dynamic_coordination_sources(json_extract(body,'$.unitId'),json_extract(body,'$.revision'));
CREATE UNIQUE INDEX IF NOT EXISTS coordination_notification_event ON dynamic_notifications(json_extract(body,'$.payload.fact.coordinationId'),json_extract(body,'$.payload.fact.eventId')) WHERE json_extract(body,'$.kind')='coordination';
CREATE TABLE IF NOT EXISTS dynamic_task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE IF NOT EXISTS dynamic_coordination_consumers(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
`

export const scheduleSchema = `
${['schedules','occurrences','slots','jobs'].map(name => `CREATE TABLE dynamic_coordination_${name}(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));`).join('\n')}
CREATE INDEX coordination_due ON dynamic_coordination_schedules(json_extract(body,'$.state'),json_extract(body,'$.nextDueAt'));
CREATE UNIQUE INDEX coordination_slot ON dynamic_coordination_slots(json_extract(body,'$.scheduleId'),json_extract(body,'$.plannedAt'));
`

export const COORDINATION_RETIRED_REASON = '协调功能已移除，旧澄清停止等待；关联业务任务保持原状'

// Resident ownership is authoritative even if a crash preceded the SQLite source
// reservation. Project only the exact message version and retired unit revisions.
export function retiredSourceOwnership(sources, ownerships = [], groupId) {
  const byMessage = new Map()
  const key = value => JSON.stringify([value.groupId, value.messageId, value.version])
  for (const owner of ownerships) {
    if (owner.dispatchOwner !== 'coordination' || !owner.retirement) continue
    const snapshot = owner.sourceSnapshot
    const identity = { groupId: snapshot.groupId ?? groupId, messageId: snapshot.messageId, version: snapshot.messageVersion }
    const id = key(identity)
    const value = byMessage.get(id) ?? { ...identity, coordinationRetirement: { ...owner.retirement, units: [] } }
    value.coordinationRetirement.units.push({ unitId: owner.unitId, unitRevision: owner.unitRevision })
    byMessage.set(id, value)
  }
  const result = sources.map(source => {
    const retired = byMessage.get(key(source))
    if (!retired) return source
    byMessage.delete(key(source))
    return { ...source, coordinationRetirement: retired.coordinationRetirement }
  })
  return [...result, ...byMessage.values()]
}

// Called inside the existing startup transaction, before recovery/scheduling.
// Keep original questions, state snapshots, receipts and task links for audit.
export function retireIndependentCoordination(db, at) {
  if (db.prepare("SELECT 1 FROM dynamic_meta WHERE key='independentCoordinationRetired'").get()) return
  const retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at }
  const update = (table, id, value) => db.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(JSON.stringify(value), id)
  const visit = (table, where, apply) => {
    let after = 0
    for (;;) {
      const rows = db.prepare(`SELECT rowid AS sequence,id,body FROM ${table} WHERE rowid>? AND (${where}) ORDER BY rowid LIMIT 100`).all(after)
      if (!rows.length) break
      for (const row of rows) { apply(row.id, JSON.parse(row.body)); after = row.sequence }
    }
  }
  visit('dynamic_coordination_sources', "json_extract(body,'$.dispatchOwner')='coordination'", (id, source) => {
    source.retirement = { ...retirement, previousState: source.state }
    update('dynamic_coordination_sources', id, source)
    for (const sourceId of new Set(source.sourceRefs ?? [])) {
      const row = db.prepare('SELECT body FROM dynamic_sources WHERE id=?').get(sourceId)
      if (!row) continue
      const input = JSON.parse(row.body)
      if (input.groupId !== source.groupId || input.messageId !== source.sourceMessageId) continue
      input.coordinationRetirement ??= { ...retirement, units: [] }
      const refs = input.coordinationRetirement.units
      if (!refs.some(ref => ref.unitId === source.unitId && ref.unitRevision === source.revision))
        refs.push({ unitId: source.unitId, unitRevision: source.revision })
      update('dynamic_sources', sourceId, input)
    }
  })
  for (const table of ['dynamic_coordination','dynamic_coordination_members','dynamic_coordination_schedules','dynamic_coordination_jobs']) {
    visit(table, '1', (id, item) => {
      item.retirement = { ...retirement, previousState: item.state }
      // Keep the original lifecycle and artifact bindings as historical facts.
      // No retired command/scheduler is callable; retirement is not cancellation
      // or completion of a previously dispatched business action.
      update(table, id, item)
    })
  }
  visit('dynamic_notifications', "json_extract(body,'$.kind')='coordination' AND json_extract(body,'$.state')='prepared'", (id, item) => {
    if (item.sendPermit || item.dispatchToken || item.sendStartedAt || item.sendAttemptCount || item.ack || item.receipt) return
    item.state = 'superseded'; item.updatedAt = at; item.retirement = { ...retirement, reason: 'coordination-feature-removed' }
    update('dynamic_notifications', id, item)
  })
  // Consume only coordinator wakes; other work queued for the same Task survives.
  visit('dynamic_wakes', "json_extract(body,'$.kind') LIKE 'coordination.%' AND json_extract(body,'$.state')!='acked'", (id, item) => {
    item.retirement = { ...retirement, previousState: item.state }; item.state = 'acked'; item.ackedAt = at; update('dynamic_wakes', id, item)
  })
  db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('independentCoordinationRetired',?)").run(JSON.stringify(retirement))
}
