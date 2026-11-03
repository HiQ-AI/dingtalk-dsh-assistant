import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

test('本地 API 恢复待判后真实调度并收束原始来源', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await mkdtemp(join(tmpdir(), 'topic-routing-hold-native-'))
  const release = Promise.withResolvers(), secondStarted = Promise.withResolvers()
  let h, runtime, server, calls = 0
  t.onCancel(() => release.resolve())
  t.after(async () => {
    release.resolve()
    if (server) await new Promise(resolve => server.close(resolve))
    await h?.service?.close(); if (h) h.service = undefined
    await runtime?.close(); if (h) h.residentStore = undefined
    await h?.close(); await rm(root, { recursive: true, force: true })
  })
  await t.beginBusiness()
  h = await t.step(() => nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'group_topic_route_submit')) return []
    const input = latestInput(request)
    calls++
    if (calls === 1) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
      routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, deferred: { reason: '停止范围不明确' } })) } }]
    secondStarted.resolve(); await release.promise
    return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
      routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
        units: [], ignoredRefs: [{ quote: message.text, reason: '澄清后无需执行' }] })) } }]
  }, { resident: true }))
  const resident = h.residentStore = await t.step(() => openResidentStore(h.ctx.storageDomain))
  runtime = await t.step(() => openTaskResidentRuntime(h.ctx, resident, root, { agentPreset: 'native-test' }))
  await t.step(() => runtime.subscribe({ groupId: 'g', name: '隔离群' }))
  h.service = await t.step(() => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: resident,
    config: { dbPath: join(root, 'dynamic.db'), instanceId: 'hold-native', initialize: true, ownerActorId: 'native-user', webActorId: 'native-user' },
    notifications: { async send() { assert.fail('不得发送钉钉消息') }, async readback() { assert.fail('不得读取钉钉消息') } } }))
  server = createServer((req, res) => handleRequest(req, res, h.service).catch(error => { res.statusCode = 500; res.end(error.message) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/config/groups/g/messages/m/routing-hold`
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: JSON.stringify(body) })
  await t.step(() => h.service.ingest({ groupId: 'g', messageId: 'm', senderOpenDingTalkId: 'native-user', text: '停止相关任务', timestamp: new Date().toISOString() }))
  await t.step(() => waitUntil(() => resident.getGroup('g').messages[0]?.routingStatus === 'needs-context', 'waiting for hold', 10000))
  const held = resident.getGroup('g').messages[0]
  let sources = await h.service.messageProcessingSources('g')
  assert.equal(sources.find(source => source.messageId === 'm')?.routed, false)
  assert.equal((await post({ messageVersion: held.messageVersion, epoch: held.routingHold.epoch + 1, resume: true })).status, 409)
  assert.equal((await post({ messageVersion: held.messageVersion, epoch: held.routingHold.epoch, scope: ['not-a-topic'], confirmClosedScope: true })).status, 400)
  assert.equal(resident.getGroup('g').messages[0].routingStatus, 'needs-context')
  const accepted = await post({ messageVersion: held.messageVersion, epoch: held.routingHold.epoch, resume: true })
  assert.equal(accepted.status, 200)
  await t.step(() => secondStarted.promise)
  assert.equal(resident.getGroup('g').messages[0].routingStatus, 'pending')
  release.resolve()
  await t.step(() => waitUntil(() => resident.getGroup('g').messages[0]?.routingStatus === 'routed', 'waiting for routed', 10000))
  await t.step(() => h.service.whenIdle())
  sources = await h.service.messageProcessingSources('g')
  assert.equal(sources.find(source => source.messageId === 'm')?.routed, true)
  assert.equal((await h.service.store.query({ kind: 'task.list' })).length, 0)
  assert.equal(resident.getGroup('g').outbox.length, 0)
}))
