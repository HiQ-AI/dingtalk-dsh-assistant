import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openDynamicTaskStore } from '../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openResidentStore } from '../../packages/dingtalk-dsh-assistant/store.js'
import { createTopicFactHandler } from '../../packages/dingtalk-dsh-assistant/topic-facts.js'
import { projectTaskNotification } from '../../packages/dingtalk-dsh-assistant/task-message-projections.js'

// Synthetic current-product fixture. Historical rows enter only while closed,
// then the real startup retirement runs; retired commands are never enabled.
export async function currentCoordinationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'current-coordination-contract-'))
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'current-contract-test' })
  const resident = await openResidentStore(facility)
  const options = { dbPath: join(root, 'ledger.sqlite'), instanceId: 'current-contract', initialize: true, webActorId: 'operator' }
  let ledger = await openDynamicTaskStore(options)
  t.after(async () => { await ledger.close(); await resident.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => ledger.command({ id, kind, args })
  const query = (kind, args = {}) => ledger.query({ kind, ...args })
  await resident.subscribe({ groupId: 'group' })
  await resident.ingest({ groupId: 'group', messageId: 'origin', text: '核验原需求并报告结果', senderOpenDingTalkId: 'author', occurredAt: new Date().toISOString() })
  await resident.routeMessages({ groupId: 'group', routeId: 'route', routingRevision: 0,
    routes: [{ messageId: 'origin', messageVersion: 1, topics: [{ newTopicKey: 'matter', title: '结果核验' }] }] })
  const topicId = resident.listTopics('group')[0].topicId
  await resident.acceptTopicDecision({ groupId: 'group', topicId, revision: 1, decisionId: 'initial',
    decision: { basisMessageIds: ['origin'], actions: [], reason: '记录需求', topicUpdate: { summary: '等待核验' } } })
  await resident.completeTopicDecision({ groupId: 'group', topicId, decisionId: 'initial' })
  await command('source.record', { sourceId: 'source', groupId: 'group', messageId: 'origin', version: 1,
    actorId: 'author', channel: 'im', text: '核验原需求并报告结果', timestamp: new Date().toISOString() })
  const handler = createTopicFactHandler({ residentStore: resident, query, commit: command, signature: () => '',
    onNotification: notification => projectTaskNotification({ residentStore: resident, notification }) })
  const context = () => handler.context('group', resident.getTopic('group', topicId))
  const submission = (factContext, decision = {}, requestId = randomUUID()) => ({
    requestId, groupId: 'group', topicId, revision: resident.getTopic('group', topicId).revision, factContext,
    decision: { actions: [], topicUpdate: { summary: '已核验当前事实' }, reason: '依据当前事实判断', ...decision },
  })
  const submit = request => handler.submit(request, Object.fromEntries(['requestId', 'topicId', 'revision', 'decision'].map(key => [key, request[key]])))
  const create = async (taskId = 'A') => {
    await command('task.create', { taskId, groupId: 'group', ownerActorId: 'author', request: `核验${taskId}`,
      title: `核验${taskId}`, sourceRefs: ['source'], topicRefs: [{ topicId, revision: 1 }],
      replyBindings: [{ groupId: 'group', topicId, sourceIds: ['source'] }] })
    return (await command('task.claim', { taskId })).result.binding
  }
  const wait = (binding, summary, id = randomUUID()) => command('task.wait', {
    binding, action: 'blocked', summary, evidence: ['fixture:readback'], limitations: [], topicFacts: true,
  }, id)
  const finish = (binding, summary = '核验完成', id = randomUUID()) => command('task.complete', {
    binding, summary, result: { summary, evidence: ['fixture:readback'], limitations: [] }, topicFacts: true,
  }, id)
  const inspect = callback => { const db = new DatabaseSync(options.dbPath, { readOnly: true }); try { return callback(db) } finally { db.close() } }
  const reopen = async () => { await ledger.close(); ledger = await openDynamicTaskStore({ ...options, initialize: false }) }
  const historical = async rows => {
    await ledger.close()
    const db = new DatabaseSync(options.dbPath)
    try {
      db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
      for (const [table, id, value] of rows) {
        if (!['coordination', 'coordination_sources', 'coordination_members', 'coordination_schedules', 'coordination_occurrences',
          'coordination_slots', 'coordination_jobs', 'notifications', 'wakes'].includes(table)) throw new Error('test history table outside fixture')
        db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(id, JSON.stringify({ id, ...value }))
      }
    } finally { db.close() }
    ledger = await openDynamicTaskStore({ ...options, initialize: false })
  }
  return { root, options, resident, handler, topicId, command, query, create, wait, finish, context, submission, submit, inspect, reopen, historical }
}
