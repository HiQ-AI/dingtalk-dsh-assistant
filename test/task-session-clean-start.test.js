import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as resident from '../packages/dingtalk-dsh-assistant/resident.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { startDwsBridge } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import { available, reason, nativeTaskHost, waitUntil } from './fixtures/task-session-native-host.js'

const epoch = '2026-10-13T00:00:00Z'
const explicit = { dbPath: '/unused/new.sqlite', instanceId: 'new-instance', ownerActorId: 'real-owner', webActorId: 'real-web', ingressEpoch: epoch }

test('resident requires explicit task-session configuration before opening any storage, even with complete workflow settings', async () => {
  const workflow = { dbPath: '/unused/old.sqlite', instanceId: 'old-instance', ownerActorId: 'old-owner', webActorId: 'old-web' }
  let opened = 0
  const ctx = { storageDomain: { async open() { opened++; throw new Error('MUST_NOT_OPEN') } } }
  await assert.rejects(resident.apply(ctx, { workflow }), { code: 'TASK_SESSION_CONFIGURATION_REQUIRED' })
  for (const field of ['dbPath', 'instanceId', 'ownerActorId', 'webActorId']) for (const value of [undefined, '', '  ', null]) {
    await assert.rejects(resident.apply(ctx, { workflow, taskSessions: { ...explicit, [field]: value } }), { code: 'TASK_SESSION_CONFIGURATION_REQUIRED' })
  }
  for (const ingressEpoch of [undefined, '', '2026-10-13', '2026-10-13T00:00:00', '2026-02-30T00:00:00Z', '2026-10-13T24:00:00Z', 1791849600000]) {
    await assert.rejects(resident.apply(ctx, { workflow, taskSessions: { ...explicit, ingressEpoch } }), { code: 'TASK_SESSION_INGRESS_EPOCH_INVALID' })
  }
  assert.equal(opened, 0)
})

function legacyGroup() {
  return { groupId: 'g', name: '保留群配置', responsibility: '保留群职责', residentSessionId: 'old-group-session', nextSequence: 2,
    messages: [{ messageId: 'old-message', sequence: 1, text: '旧消息仅供传输游标', messageVersion: 1, occurredAt: '2026-10-12T23:59:00Z', routingStatus: 'routed', agentDeliveryStatus: 'delivered', senderOpenDingTalkId: 'real-owner' }],
    outbox: [{ outboundId: 'old-outbound', sourceMessageId: 'task-result:task-old:completed:1', text: '旧结果不能重新发', status: 'pending', readbackRequired: true }],
    topics: [], routingRevision: 0, routeHistory: [], taskReservations: [], coordinationRequests: {} }
}
function legacyTask(index) {
  return { taskId: `task-old-${index}`, groupId: 'g', topicRefs: [{ topicId: 'old-topic', revision: 1 }], inputVersion: 1,
    objective: '旧任务不能启动', state: 'waiting', childSessionId: `old-session-${index}`, waitingKind: 'human-intervention', waitingReason: '旧阻塞',
    humanBlocker: { requestId: `old-blocker-${index}`, category: 'human-decision', requestedAction: '旧操作', status: 'pending-send' },
    createdAt: epoch, updatedAt: epoch }
}

test('active transport facade exposes notification read models without legacy DWS sending or retrying them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-clean-facade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const group = legacyGroup(), tasks = Array.from({ length: 152 }, (_, i) => legacyTask(i))
  for (const state of ['prepared', 'unknown']) group.outbox.push({ outboundId: `current-${state}`, sourceMessageId: `task-notification:current-${state}`, text: '当前通知由task service持有', status: 'pending', readbackRequired: true, notificationState: state })
  const snapshot = structuredClone({ group, tasks })
  let historyReads = 0, outboundCalls = 0, closed = 0
  const forbidden = () => { historyReads++; throw new Error('LEGACY_TASK_READ_FORBIDDEN') }
  const store = { getAgentWorkspaceDir: () => root, getGroup: id => id === 'g' ? group : undefined, listGroups: () => [group],
    listTasks: forbidden, getTask: forbidden, listTopics: () => [], getTopic: () => undefined, getTopicContext: () => undefined,
    listTaskTimings: forbidden, listPerformance: forbidden, listActivities: forbidden, listAlerts: forbidden,
    async close() { closed++ } }
  const runtime = await openTaskResidentRuntime({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } }, store, root)
  const completed = Promise.withResolvers(), warnings = [], backfills = []
  const stop = startDwsBridge({ runtime, logger: { warn: error => warnings.push(error) }, humanUserId: 'configured-user',
    humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 5,
    adapter: {
      startGroupSubscription() { return { done: completed.promise, stop() { completed.resolve() } } },
      async readGroupRange(_id, range) { backfills.push(range); return { messages: [], complete: true } },
      async sendSelf() { outboundCalls++; throw new Error('OLD_SEND_FORBIDDEN') },
      async sendGroup() { outboundCalls++; throw new Error('OLD_SEND_FORBIDDEN') },
      async findHumanBlockerExchange() { outboundCalls++; throw new Error('OLD_LOOKUP_FORBIDDEN') },
      async findOutboundMessage() { outboundCalls++; throw new Error('OLD_LOOKUP_FORBIDDEN') },
    },
  })
  try {
    await waitUntil(() => backfills.length, 'initial cursor backfill')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(backfills[0].start, '2026-10-12T23:58:30.000Z')
    assert.deepEqual(runtime.getGroup('g').messages, group.messages)
    runtime.isOwnNotification = message => message.groupId === 'g' && message.messageId === 'old-message'
    assert.deepEqual(runtime.getGroup('g').messages, [])
    assert.deepEqual(runtime.listGroups()[0].messages, [])
    assert.equal(group.messages.length, 1, '仅过滤投影，保留原始历史')
    runtime.isOwnNotification = () => false
    assert.equal(runtime.getGroup('g').name, group.name)
    assert.equal(runtime.getGroup('g').responsibility, group.responsibility)
    assert.deepEqual(runtime.getGroup('g').outbox, group.outbox)
    assert.equal(runtime.taskSessionNotifications, true)
    await assert.rejects(async () => runtime.prepareOutbound({ groupId: 'g', outbound: group.outbox[0] }), { code: 'WORKFLOW_RETIRED' })
    for (const method of ['listTasks', 'listTopics', 'listTaskTimings', 'listActivities', 'listAlerts', 'listAuthorizationRequests']) assert.deepEqual(runtime[method](), [])
    assert.deepEqual(runtime.listPerformance().rows, [])
    assert.equal(runtime.getTask('task-old-1'), undefined)
    assert.equal(runtime.getAuthorizationRequest('old-blocker-1'), undefined)
    assert.deepEqual(warnings, [])
    assert.equal(outboundCalls, 0)
    assert.equal(historyReads, 0)
    assert.deepEqual({ group, tasks }, snapshot)
  } finally { await stop(); await runtime.close() }
  assert.equal(closed, 1)
})

// Real resident entry, native Cordis/storage/persistence, HTTP and SQLite. The model is
// deterministic, and DWS is disabled. This test makes no deployment or live DingTalk claim.
test('real resident starts a clean explicit ledger without reading old workflow files, importing 152 blockers or showing old tasks', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-clean-resident-'))
  let host
  const env = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'].map(key => [key, process.env[key]]))
  t.after(async () => {
    try { await host?.close() } finally {
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value
      await rm(root, { recursive: true, force: true })
    }
  })
  host = await nativeTaskHost(root, request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '新任务已接收', evidence: [], limitations: [] } } }]
  }, { resident: true })
  const domain = await host.ctx.storageDomain.open(residentDomainSpec)
  await domain.table('scheduler').put('runtime', { tasks: [], groupConfigurationInitialized: true, agentWorkspaceDir: root, proxyUrl: '', agentNames: ['真实配置名称'] })
  await domain.table('groups').put('g', legacyGroup())
  for (let i = 0; i < 152; i++) await domain.table('tasks').put(`task-old-${i}`, legacyTask(i))
  await domain.close()
  const storagePath = join(root, 'storage', 'dingtalk_dsh_assistant.json'), before = await readFile(storagePath)
  const oldPath = join(root, 'old-workflow.sqlite'), sentinel = 'Archived legacy bytes. An active SQLite read must fail.'
  await writeFile(oldPath, sentinel)
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const dbPath = join(root, 'new-task-sessions.sqlite')
  const plugin = await host.ctx.plugin(resident, { host: '127.0.0.1', port, agentWorkspaceDir: root, agentPreset: 'native-test', proxyUrl: '',
    dws: { enabled: false }, workflow: { dbPath: oldPath, instanceId: 'retired', ownerActorId: 'wrong-owner', webActorId: 'wrong-web' },
    taskSessions: { ...explicit, provider: 'native-task-test', dbPath, initialize: true, ingressEpoch: '2026-10-13T08:00:00+08:00', recoveryIntervalMs: 60000 } })
  const read = path => new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}${path}`, { agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) } })
  }).on('error', reject))
  assert.equal((await read('/health')).body.status, 'ok')
  for (const path of ['/state/tasks', '/state/authorizations', '/state/activities', '/state/supervisor/alerts']) assert.deepEqual((await read(path)).body, [], path)
  assert.equal((await read('/state/tasks/task-old-1/detail')).status, 404)
  assert.deepEqual((await read('/state/tasks/task-old-1/executions')).body.executions, [])
  const groups = (await read('/state/groups')).body
  assert.equal(groups[0].name, '保留群配置')
  assert.deepEqual(groups[0].outbox, legacyGroup().outbox)
  assert.equal(groups[0].messages[0].senderOpenDingTalkId, 'real-owner')
  assert.equal(host.requests.length, 0)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    for (const table of ['dynamic_tasks', 'dynamic_executions', 'dynamic_notifications', 'dynamic_legacy_blockers']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table)
    assert.equal(JSON.parse(await readFile(dbPath + '.initialized', 'utf8')).ingressEpoch, '2026-10-13T00:00:00.000Z')
  } finally { db.close() }
  assert.deepEqual(await readFile(storagePath), before, 'Clean startup must not rewrite archived resident records')
  const created = await new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/tasks`, { agent: false, method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) } })
    }).on('error', reject)
    req.end(JSON.stringify({ requestId: 'fresh', groupId: 'g', title: '新任务', objective: '只处理新任务', acceptanceCriteria: ['新账本可用'] }))
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.ownerActorId, 'real-web')
  assert.equal((await read('/state/tasks')).body.length, 1)
  const settled = await waitUntil(async () => {
    const task = (await read(`/state/tasks/${created.body.taskId}/detail`)).body
    return task.session?.status === 'idle' && host.requests.length >= 1 ? task : null
  }, 'new task native turn drains')
  assert.equal(settled.session.sessionBound, true)
  assert.equal(settled.lastDecision.summary, '新任务已接收')
  assert.equal(settled.session.sessionId, created.body.session.sessionId)
  assert.equal(host.requests.length, 1)
  await plugin.dispose()
  const preserved = await host.ctx.storageDomain.open(residentDomainSpec)
  try {
    const archivedTasks = [...preserved.table('tasks').entries()]
    assert.equal(archivedTasks.length, 152)
    for (let i = 0; i < 152; i++) assert.deepEqual(preserved.table('tasks').get(`task-old-${i}`), residentDomainSpec.tables.tasks.valueSchema.parse(legacyTask(i)))
    const currentGroup = preserved.table('groups').get('g')
    assert.deepEqual(currentGroup.messages.find(message => message.messageId === 'old-message'), residentDomainSpec.tables.groups.valueSchema.parse(legacyGroup()).messages[0])
    assert.deepEqual(currentGroup.outbox.filter(outbound => outbound.outboundId === 'old-outbound'), residentDomainSpec.tables.groups.valueSchema.parse(legacyGroup()).outbox)
    assert.equal(currentGroup.topics.length, 1, 'New web input must create its own real topic')
    const topic = currentGroup.topics[0]
    assert.equal(topic.processedRevision, topic.revision)
    assert.equal(topic.decisions.length, 1)
    assert.equal(topic.decisions[0].status, 'completed')
    assert.equal(topic.decisions[0].operations[0].taskId, created.body.taskId)
  } finally { await preserved.close() }
  const active = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assert.equal(active.prepare('SELECT count(*) AS count FROM dynamic_tasks').get().count, 1)
    assert.equal(active.prepare('SELECT count(*) AS count FROM dynamic_legacy_blockers').get().count, 0)
  } finally { active.close() }
  assert.equal(await readFile(oldPath, 'utf8'), sentinel)
})
