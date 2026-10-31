import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'

const test = (name, run, options = {}) => testRunner(name, { timeout: 15000, ...options, ...(!available ? { skip: reason } : {}) }, run)
const precise = '2026-10-14T01:25:51.750Z'
const coarse = '2026-10-14T01:25:51.000Z'
const resource = { type: 'fileId', resourceId: 'official-file-4d', name: '百部4d.xlsx' }
const enriched = { ...resource, resourceIdType: 'fileId', download: { ready: true, resourceId: resource.resourceId } }
const message = (extra = {}) => ({ groupId: 'native-group', messageId: 'backfill-4d', messageVersion: 1,
  senderOpenDingTalkId: 'native-user', senderName: '现场用户', text: '百部4d现场附件',
  occurredAt: precise, timestamp: precise, resourceRefs: [resource], ...extra })

async function idle(h) {
  let timer
  try {
    await Promise.race([h.service.whenIdle(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`source replay idle timeout; last tool results: ${JSON.stringify(h.toolResults.slice(-3))}; last request: ${JSON.stringify(h.requests.at(-1))}`)), 3000)
    })])
  } finally { clearTimeout(timer) }
}

async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-source-replay-'))
  let calls = 0
  const h = await nativeTaskHost(root, async request => {
    calls++
    assert.ok(calls <= 8, `script model exceeded bounded rounds: ${calls}`)
    const names = request.tools.map(tool => tool.name)
    assert.ok(names.includes('group_topic_route_submit'), `unexpected model role: ${names.join(',')}`)
    const input = latestInput(request)
    assert.ok(input?.requestId && Array.isArray(input.messages), 'missing current route request')
    return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(item => ({
      messageId: item.messageId, messageVersion: item.messageVersion, units: [],
      ignoredRefs: [{ quote: item.text, reason: '身份去重测试，无待执行事项' }],
    })) } }]
  }, { config: { ingressEpoch: '2026-10-14T01:00:00.000Z', ...config } })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  return { h, calls: () => calls }
}

for (const reverse of [false, true]) {
  test(`source replay accepts ${reverse ? 'official history then realtime' : 'realtime then official history'} without rerouting or losing original facts`, nativeLifecycle(15000, async (t) => {
    const { h, calls } = await fixture(t)
    await t.beginBusiness()

    const live = message(), history = message({ occurredAt: coarse, timestamp: coarse, resourceRefs: [enriched] })
    const first = await t.step(async () => h.service.ingest(reverse ? history : live))
    await t.step(async () => idle(h))
    const before = await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))
    const admission = await t.step(async () => h.query('receipt.get', { id: `source:${first.sourceId}` }))
    const second = await t.step(async () => h.service.ingest(reverse ? live : history))
    await t.step(async () => idle(h))
    assert.equal(second.accepted, true)
    assert.equal(second.sourceId, first.sourceId)
    assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
    assert.equal(calls(), 1)
    const after = await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))
    assert.equal(after.timestamp, before.timestamp, 'original event precision must stay intact')
    assert.equal(after.actorId, before.actorId)
    assert.equal(after.text, before.text)
    assert.deepEqual(after.resources, [enriched], 'official attachment enrichment must remain readable in either replay order')
    assert.deepEqual(h.residentStore.getGroup('native-group').messages[0].resourceRefs, [enriched], 'group timeline must retain official resource metadata')
    assert.deepEqual(await t.step(async () => h.query('receipt.get', { id: `source:${first.sourceId}` })), admission, 'enrichment cannot rewrite original admission receipt')
    assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
    assert.equal((await t.step(async () => h.query('notification.list'))).length, 0)
  }), { timeout: nativeLifecycleTimeout(15000) })
}

test('same-second transport timestamp projections do not turn one source into multiple commands', nativeLifecycle(15000, async (t) => {
  const { h, calls } = await fixture(t)
  await t.beginBusiness()

  const first = await t.step(async () => h.service.ingest(message()))
  await t.step(async () => idle(h))
  for (const timestamp of [coarse, '2026-10-14T01:25:51Z', '2026-10-14T09:25:51+08:00']) {
    const result = await t.step(async () => h.service.ingest(message({ occurredAt: timestamp, timestamp })))
    assert.equal(result.sourceId, first.sourceId)
    assert.equal(result.accepted, true)
  }
  await t.step(async () => idle(h))
  assert.equal(calls(), 1)
}), { timeout: nativeLifecycleTimeout(15000) })

for (const [name, extra] of [
  ['different body', { text: '不同正文，不能吞掉' }],
  ['different authenticated actor', { senderOpenDingTalkId: 'another-user' }],
]) {
  test(`source replay rejects ${name} before changing existing facts or routing`, nativeLifecycle(15000, async (t) => {
    const { h, calls } = await fixture(t)
    await t.beginBusiness()

    const first = await t.step(async () => h.service.ingest(message()))
    await t.step(async () => idle(h))
    const before = await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))
    await t.step(async () => assert.rejects(h.service.ingest(message(extra)), error => ['DYNAMIC_SOURCE_CONFLICT', 'DYNAMIC_COMMAND_ID_CONFLICT'].includes(error.code)))
    await t.step(async () => idle(h))
    assert.deepEqual(await t.step(async () => h.query('source.get', { sourceId: first.sourceId })), before)
    assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
    assert.equal(calls(), 1)
  }), { timeout: nativeLifecycleTimeout(15000) })
}

test('millisecond ingress cutoff remains exact even when replay identity tolerates transport precision', nativeLifecycle(15000, async (t) => {
  const { h, calls } = await fixture(t, { ingressEpoch: '2026-10-14T01:25:51.500Z' })
  await t.beginBusiness()

  const live = await t.step(async () => h.service.ingest(message()))
  await t.step(async () => idle(h))
  const replay = await t.step(async () => h.service.ingest(message({ occurredAt: coarse, timestamp: coarse, resourceRefs: [enriched] })))
  assert.equal(replay.accepted, true, 'existing admitted source keeps its original ingress fact')
  assert.equal(replay.sourceId, live.sourceId)
  const old = await t.step(async () => h.service.ingest(message({ messageId: 'old-same-second', occurredAt: coarse, timestamp: coarse })))
  assert.equal(old.accepted, false)
  assert.equal(old.reason, 'before-ingress-epoch')
  await t.step(async () => idle(h))
  assert.equal((await t.step(async () => h.query('source.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('source.get', { sourceId: live.sourceId }))).timestamp, precise)
  assert.equal(calls(), 1)
}), { timeout: nativeLifecycleTimeout(15000) })

for (const [name, extra] of [
  ['different attachment identity', { resourceRefs: [{ ...resource, resourceId: 'different-file' }] }],
  ['different attachment type', { resourceRefs: [{ ...resource, type: 'mediaId' }] }],
  ['additional attachment', { resourceRefs: [resource, { ...resource, resourceId: 'extra-file' }] }],
  ['explicit new body version', { messageVersion: 2, text: '版本二正文' }],
]) {
  test(`source replay cannot silently swallow ${name}`, nativeLifecycle(15000, async (t) => {
    const { h } = await fixture(t)
    await t.beginBusiness()

    const first = await t.step(async () => h.service.ingest(message()))
    await t.step(async () => idle(h))
    const before = await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))
    let next
    try { next = await t.step(async () => h.service.ingest(message(extra))) }
    catch (error) {
      assert.ok(['DYNAMIC_SOURCE_CONFLICT', 'DYNAMIC_COMMAND_ID_CONFLICT'].includes(error.code))
      assert.deepEqual(await t.step(async () => h.query('source.get', { sourceId: first.sourceId })), before)
      return
    }
    assert.equal(next.accepted, true)
    assert.notEqual(next.sourceId, first.sourceId, 'a real changed fact requires an explicit new version')
    await t.step(async () => idle(h))
    const changed = await t.step(async () => h.query('source.get', { sourceId: next.sourceId }))
    assert.ok(changed.version > before.version)
    assert.equal(changed.text, extra.text ?? before.text)
    assert.deepEqual(changed.resources, extra.resourceRefs ?? before.resources)
    assert.deepEqual(await t.step(async () => h.query('source.get', { sourceId: first.sourceId })), before)
  }), { timeout: nativeLifecycleTimeout(15000) })
}

test('a quarantined source receipt cannot become admitted through a later same-second projection', nativeLifecycle(15000, async (t) => {
  const { h, calls } = await fixture(t, { ingressEpoch: '2026-10-14T01:25:51.500Z' })
  await t.beginBusiness()

  const old = await t.step(async () => h.service.ingest(message({ occurredAt: coarse, timestamp: coarse })))
  assert.equal(old.accepted, false)
  assert.equal(old.reason, 'before-ingress-epoch')
  try {
    const projected = await t.step(async () => h.service.ingest(message()))
    assert.equal(projected.accepted, false, 'negative admission receipts must not be bypassed by replay')
  } catch (error) { assert.ok(['DYNAMIC_SOURCE_CONFLICT', 'DYNAMIC_COMMAND_ID_CONFLICT'].includes(error.code)) }
  await t.step(async () => idle(h))
  assert.equal((await t.step(async () => h.query('source.list'))).length, 0)
  assert.equal(calls(), 0)
}), { timeout: nativeLifecycleTimeout(15000) })
