import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, topicTaskCalls, latestInput } from './fixtures/task-session-native-host.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'

test('explicit background message retry admits original facts through topics once without opening automatic history ingress', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-background-retry-'))
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) { const input = latestInput(request); return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'explicit-history', title: '原图位置调整' }] })) } }] }
    return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待核对原图位置', evidence: [], limitations: [] } } }] }, { config: { ingressEpoch: '2026-10-14T02:00:00.000Z' } })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const runtime = await openTaskResidentRuntime(h.ctx, h.residentStore, root)
  const message = { groupId: 'native-group', messageId: 'saved-history', text: '测试助手，请合并后调整描述输入框位置', senderOpenDingTalkId: 'native-user', senderName: '现场用户', occurredAt: '2026-10-14T01:25:51.750Z', sourceKind: 'dingtalk', quotedMessage: { messageId: 'prior', content: '原布局' }, imageRefs: [{ path: 'images/original.png', mediaType: 'image/png' }], resourceRefs: [{ type: 'fileId', resourceId: 'original-image', download: { ready: true } }] }
  await runtime.backfill([message])
  const before = structuredClone(h.residentStore.getGroup('native-group').messages[0])
  assert.equal(before.agentDeliveryStatus, 'skipped')
  assert.equal((await h.query('source.list')).length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal((await h.service.ingest(message)).accepted, false)
  await h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId })
  await h.service.whenIdle()
  const sources = await h.query('source.list'), tasks = await h.query('task.list')
  assert.equal(sources.length, 1)
  assert.equal(tasks.length, 1)
  assert.equal(sources[0].timestamp, message.occurredAt)
  assert.equal(sources[0].actorId, message.senderOpenDingTalkId)
  assert.equal(sources[0].text, message.text)
  assert.deepEqual(sources[0].quote, before.quotedMessage)
  assert.deepEqual(sources[0].resources, before.resourceRefs)
  const after = h.residentStore.getGroup('native-group').messages.find(item => item.messageId === message.messageId)
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId', 'imageRefs', 'resourceRefs', 'quotedMessage']) assert.deepEqual(after[key], before[key], key)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.equal(tasks[0].topicRefs.length, 1)
  const requests = h.requests.length
  for (let i = 0; i < 2; i++) { await h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId }); await h.service.whenIdle() }
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.requests.length, requests)
  await runtime.backfill([{ ...message, messageId: 'another-old-message' }])
  await h.service.whenIdle()
  assert.equal(h.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'another-old-message').agentDeliveryStatus, 'skipped')
  assert.equal((await h.query('source.list')).length, 1)
  assert.equal(h.requests.length, requests)
})
