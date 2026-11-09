import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { taskDirectories } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTopicMessages } from '../packages/dingtalk-dsh-assistant/store.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { groupReplyScopeInstructions } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { groupNotificationRouting } from '../packages/dingtalk-dsh-assistant/group-notification.js'
import { fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { buildReplyReviewCandidates } from '../packages/dingtalk-dsh-assistant/decision.js'
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil, modelToolValues, topicTaskCalls, scriptedRouteSilences } from './fixtures/task-session-native-host.js'

const call = (name, args) => ({ name, args: name === 'group_decision_submit' ? { ...args, decision: { ...args.decision, topicUpdate: { summary: '围绕原始事项持续核对，当前结论以任务真实进展为准。' } } } : args })
function decisionSummaryRead(request, input) {
  if (input.summaryContext?.section !== 'summary') return
  const pages = modelToolValues(request).filter(value => value.requestId === input.requestId && value.section === 'summary')
  const last = pages.at(-1)
  if (last && !last.hasMore) return
  return call('group_decision_context_get', { requestId: input.requestId, section: 'summary', offset: last?.nextOffset ?? 0 })
}
function missingSourceRead(request, input) {
  const values = modelToolValues(request)
  for (const source of input.sources ?? []) {
    let offset = 0
    while (offset < source.totalLength) {
      const page = values.find(item => item.batchId === input.batchId && item.sourceId === source.sourceId && item.offset === offset && Number.isInteger(item.nextOffset))
      if (!page) return { sourceId: source.sourceId, offset }
      offset = page.nextOffset
    }
  }
  return null
}
function envelope(request, prefix) {
  for (const message of request.messages.toReversed().filter(item => item.role === 'user')) for (const part of message.content ?? []) {
    if (part.type !== 'text' || !(part.text.startsWith(prefix) || prefix === '[GROUP_TOPIC_ROUTE]' && part.text.startsWith('[GROUP_TOPIC_ROUTE_UPDATE]'))) continue
    const line = part.text.split('\n').find(value => value.startsWith('Topic 请求：'))
    if (line) {
      const value = JSON.parse(line.slice('Topic 请求：'.length))
      if (prefix === '[GROUP_TOPIC_ROUTE]' && part.text.startsWith('[GROUP_TOPIC_ROUTE_UPDATE]')) {
        const original = request.messages.filter(item => item.role === 'user').flatMap(item => item.content ?? []).filter(item => item.type === 'text' && item.text.startsWith('[GROUP_TOPIC_ROUTE]'))
          .map(item => item.text.split('\n').find(text => text.startsWith('Topic 请求：'))).filter(Boolean)
          .map(text => JSON.parse(text.slice('Topic 请求：'.length))).find(item => item.requestId === value.requestId)
        return { ...original, ...value }
      }
      return value
    }
  }
  throw new Error(`Missing native ${prefix} request`)
}
function jsonValues(value) {
  if (!value || typeof value !== 'object') return []
  const values = [value]
  for (const child of Object.values(value)) {
    if (typeof child === 'string') { try { values.push(...jsonValues(JSON.parse(child))) } catch {} }
    else if (typeof child === 'object') values.push(...jsonValues(child))
  }
  return values
}
const message = (messageId, text) => ({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'native-user', senderName: '真实用户', sourceKind: 'dingtalk', text,
  occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' })

testRunner('direct triage rejects confirmation replacement of non-confirmation replies', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const cases = [['substantive', 'substantive'], ['correction', 'correction'], ['unknown', undefined], ['confirmation', 'confirmation']]
  const attemptedInvalid = new Set()
  const sourceIds = new Map(cases.map(([id]) => [id, `im:${createHash('sha256').update(JSON.stringify(['native-group', `confirmation-${id}`, 1])).digest('hex')}`]))
  const h = await t.step(() => extraHost(t, 'confirmation-kind-gate-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    const missingSource = missingSourceRead(request, input)
    if (missingSource) return [call('router_source_read', missingSource)]
    if (!names.includes('triage_submit')) throw new Error(`Unexpected direct triage tools: ${names.join(', ')}`)
    const sourceId = input.sources?.[0]?.sourceId
    const review = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
    if (!review) return [call('router_reply_review_get', {})]
    const sourceCase = cases.find(([id]) => sourceIds.get(id) === sourceId)
    assert.ok(sourceCase, sourceId)
    const target = `seed-${sourceCase[0]}`
    const candidateIds = review.candidates.map(item => item.outboundId)
    assert.deepEqual(candidateIds, [target])
    if (attemptedInvalid.has(sourceId)) {
      assert.ok(h.toolResults.some(item => item.name === 'triage_submit' && JSON.stringify(item.result).includes('router_reply_review_invalid')))
      assert.equal(h.residentStore.getGroup('native-group').outbox.some(item => item.replyToMessageId === `confirmation-${sourceCase[0]}` && item.outboundId !== target), false)
      return [call('triage_submit', { needsProcessing: false, reply: `核查${sourceCase[0]}回复。`, review: {
        kind: 'substantive', reviewedOutboundIds: candidateIds, sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
    }
    if (sourceCase[0] !== 'confirmation') attemptedInvalid.add(sourceId)
    return [call('triage_submit', { needsProcessing: false, reply: `核查${sourceCase[0]}回复替换门禁。`, review: {
      kind: 'confirmation', reviewedOutboundIds: candidateIds, sameMatterOutboundIds: [target], replaceOutboundIds: [target] } })]
  }))
  await t.beginBusiness()
  for (const [id, kind] of cases) await t.step(() => h.residentStore.appendOutbox({ groupId: 'native-group', outboundId: `seed-${id}`,
    sourceMessageId: `fixture:seed-${id}`, replyToMessageId: `confirmation-${id}`, text: `历史回复 ${id}`, ...(kind ? { replyKind: kind } : {}) }))
  for (const [id] of cases) {
    const source = message(`confirmation-${id}`, `请核查${id}原事项。`)
    await t.step(() => h.service.ingest(source))
    await t.step(() => h.service.whenIdle())
    await t.step(() => waitUntil(() => h.residentStore.getRouterState('native-group').triage
      .some(item => item.sourceRef.sourceId === sourceIds.get(id) && item.replyStatus === 'applied'), '首筛回复已应用'))
    const expectedError = id === 'confirmation' ? null : 'router_reply_review_invalid'
    if (expectedError) assert.ok(h.toolResults.some(item => item.name === 'triage_submit' && JSON.stringify(item.result).includes(expectedError)))
  }
  const rejected = h.toolResults.filter(item => item.name === 'triage_submit' && JSON.stringify(item.result).includes('router_reply_review_invalid'))
  assert.equal(rejected.length, 3)
  const triage = h.residentStore.getRouterState('native-group').triage
  assert.equal(triage.length, 4)
  assert.equal(triage.find(item => item.sourceRef.sourceId === sourceIds.get('confirmation'))?.replyStatus, 'applied')
  await t.step(() => waitUntil(() => h.sent.length === 4, '四条审阅通过的回复已发送'))
  assert.equal(h.sent.length, 4)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
}))

testRunner('direct triage delivers one concise first reply and cold recovery does not resend it', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await mkdtemp(join(tmpdir(), 'routing-initial-reply-'))
  let host
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  const decide = request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    const missingSource = missingSourceRead(request, input)
    if (missingSource) return [call('router_source_read', missingSource)]
    if (!names.includes('triage_submit')) throw new Error(`Unexpected direct triage tools: ${names.join(', ')}`)
    const sourceId = input.sources?.[0]?.sourceId
    const review = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
    if (!review) return [call('router_reply_review_get', {})]
    return [call('triage_submit', { needsProcessing: false, reply: '已收到单据核查请求，后续情况确认后再补充。',
      review: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
  }
  host = await t.step(() => nativeTaskHost(root, decide))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('initial-source', '请核查这张单据。')))
  await t.step(() => host.service.whenIdle())
  const notices = await t.step(() => host.query('notification.list'))
  const initial = notices.filter(item => item.payload.replyToMessageId === 'initial-source')
  assert.equal(initial.length, 1, JSON.stringify(host.service.listAlerts()))
  assert.equal(initial[0].state, 'delivered')
  assert.equal(initial[0].payload.replyToMessageId, 'initial-source')
  assert.equal(initial[0].payload.replyToSenderOpenDingTalkId, 'native-user')
  assert.ok(initial[0].receipt.messageId)
  assert.equal(host.sent.length, 1)
  assert.equal((await t.step(() => host.query('task.list'))).length, 0)
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
  await t.step(() => host.close())
  host = await t.step(() => nativeTaskHost(root, () => assert.fail('冷恢复不得重做已完成路由'), { initialize: false }))
  await t.step(() => host.service.recover()); await t.step(() => host.service.whenIdle())
  assert.equal(host.sent.length, 0)
  assert.deepEqual((await t.step(() => host.query('notification.list'))).map(item => item.id), initial.map(item => item.id))
}))

for (const mode of ['normal', 'stale', 'prepared', 'starting', 'two']) testRunner(`直接首筛回复在进程退出后沿原身份恢复 mode=${mode}`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const stale = !['normal', 'two'].includes(mode)
  const root = await mkdtemp(join(tmpdir(), 'direct-triage-process-recovery-'))
  let host, child, childDone
  const allowOld = Promise.withResolvers()
  t.onCancel(() => { allowOld.resolve(); if (child?.connected) child.disconnect() })
  t.after(async () => { allowOld.resolve(); if (child?.connected) child.disconnect(); await childDone?.catch(() => {}); await host?.close(); await rm(root, { recursive: true, force: true }) })
  const script = `
    import assert from 'node:assert/strict'
    process.on('disconnect', () => process.exit(1))
    import { nativeTaskHost, latestInput, modelToolValues, waitUntil } from './test/fixtures/task-session-native-host.js'
    const root = process.argv[1], mode = process.argv[2]
    const call = (name, args) => ({ name, args })
    const childSent = []
    let firstReceipt
    const host = await nativeTaskHost(root, request => {
      const input = latestInput(request), values = modelToolValues(request)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = values.find(item => item.batchId === input.batchId && item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      const review = values.findLast(value => Array.isArray(value.candidates))
      if (!review) return [call('router_reply_review_get', {})]
      return [call('triage_submit', { needsProcessing: false, reply: '已收到原始请求。', review: {
        kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
    }, { notifications: { send: async notification => {
      assert.equal(mode, 'two')
      childSent.push(structuredClone(notification))
      return { messageId: 'cold-child-sent' }
    }, readback: async notification => childSent.some(item => item.id === notification.id) ? { messageId: 'cold-child-sent', visible: true } : undefined } })
    if (mode === 'two') {
      await host.service.ingest({ groupId: 'native-group', messageId: 'first-valid', senderOpenDingTalkId: 'native-user',
        senderName: '真实用户', sourceKind: 'dingtalk', text: '请核查第一条来源。', timestamp: '2026-10-13T10:00:00Z' })
      firstReceipt = await waitUntil(async () => {
        const item = (await host.query('notification.list')).find(value => value.state === 'delivered')
        return item && host.residentStore.getRouterState('native-group').triage.some(entry => entry.replyReceipt?.notificationId === item.id && entry.replyStatus === 'applied') && item
      }, '第一来源送达并入账')
      assert.equal(childSent.length, 1)
      assert.equal(childSent[0].payload.replyToMessageId, 'first-valid')
    }
    async function checkpoint(triageId, outboundId) {
      const triage = host.residentStore.getRouterState('native-group').triage.find(item => item.triageId === triageId)
      assert.equal(triage?.replyStatus, 'pending')
      assert.equal(outboundId, 'router-reply:' + triageId)
      assert.equal((host.residentStore.getRouterState('native-group').failures ?? []).length, 0)
      let notification = await host.query('notification.get', { notificationId: outboundId })
      if (mode === 'normal' || mode === 'stale' || mode === 'two') {
        assert.equal(host.residentStore.getGroup('native-group').outbox.some(item => item.outboundId === outboundId), false)
        assert.equal(notification, null)
      } else {
        assert.equal(notification.state, 'prepared')
        if (mode === 'starting') {
          const started = await host.service.store.command({ kind: 'notification.start', id: 'cold-start:' + outboundId, args: { notificationId: outboundId } })
          assert.equal(started.result.notification.state, 'starting')
        }
      }
      process.stdout.write('RECOVERY_MARKER:' + JSON.stringify({ triageId, outboundId, firstReceipt }) + '\\n', () => process.exit(0))
      await new Promise(() => {})
    }
    if (mode === 'normal' || mode === 'stale' || mode === 'two') host.residentStore.withRouterReplyPreparation = async args => {
      assert.equal(args.intent.decisionId, args.intent.operationId)
      await checkpoint(args.intent.decisionId, args.outbound.outboundId)
    }
    else {
      host.residentStore.withNotificationSource = async () => new Promise(() => {})
      host.residentStore.triageRecordReply = async args => checkpoint(args.triageId, args.receipt.notificationId)
    }
    await host.service.ingest({ groupId: 'native-group', messageId: 'cold-source', senderOpenDingTalkId: 'native-user',
      senderName: '真实用户', sourceKind: 'dingtalk', text: '请核查原始请求。', timestamp: '2026-10-13T10:00:00Z' })
    await new Promise(() => {})
  `
  await t.beginBusiness()
  child = spawn(process.execPath, ['--input-type=module', '-e', script, root, mode], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  childDone = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  const exit = await t.step(() => childDone)
  assert.deepEqual(exit, { code: 0, signal: null }, stderr)
  const marker = stdout.split('\n').find(line => line.startsWith('RECOVERY_MARKER:'))
  assert.ok(marker, stderr)
  const { triageId, outboundId, firstReceipt } = JSON.parse(marker.slice('RECOVERY_MARKER:'.length))
  const validSourceId = `im:${createHash('sha256').update(JSON.stringify(['native-group', 'valid-source', 1])).digest('hex')}`
  const sent = [], readbacks = []
  host = await t.step(() => nativeTaskHost(root, request => {
    if (!stale) throw new Error('恢复原决议不得重新调用模型')
    const input = latestInput(request), values = modelToolValues(request)
    const missing = missingSourceRead(request, input)
    if (missing) return [call('router_source_read', missing)]
    const sourceId = input.sources[0].sourceId
    if (sourceId !== validSourceId) return [call('triage_submit', { needsProcessing: false, reply: null })]
    const review = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
    if (!review) return [call('router_reply_review_get', {})]
    return [call('triage_submit', { needsProcessing: false, reply: '有效来源已收到。', review: { kind: 'substantive',
      reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
  }, { initialize: false, notifications: {
    async send(notification) { sent.push(structuredClone(notification)); return { messageId: `cold-sent-${sent.length}` } },
    async readback(notification) {
      readbacks.push(structuredClone(notification))
      const index = sent.findIndex(item => item.id === notification.id)
      return index < 0 ? undefined : { messageId: `cold-sent-${index + 1}`, visible: true }
    },
  } }))
  const prepare = host.residentStore.withRouterReplyPreparation.bind(host.residentStore)
  if (stale) host.residentStore.withRouterReplyPreparation = async args => {
    if (args.outbound.outboundId === outboundId) await allowOld.promise
    return prepare(args)
  }
  const before = host.residentStore.getRouterState('native-group')
  assert.equal(before.triage.find(item => item.triageId === triageId)?.replyStatus, 'pending')
  assert.ok(!(before.failures ?? []).some(item => item.requestId === triageId))
  const originalOutbox = host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)
  const originalNotification = await t.step(() => host.query('notification.get', { notificationId: outboundId }))
  if (mode === 'normal' || mode === 'stale' || mode === 'two') {
    assert.equal(originalOutbox, undefined)
    assert.equal(originalNotification, null)
  } else {
    assert.ok(originalOutbox)
    assert.equal(originalNotification?.state, mode === 'prepared' ? 'prepared' : 'unknown')
  }
  if (stale) {
    await t.step(() => host.service.ingest({ ...message('cold-source', '已更新的原始请求。'), messageVersion: 2 }))
    allowOld.resolve()
    await t.step(() => host.service.ingest(message('valid-source', '请核查另一条有效来源。')))
  }
  await t.step(() => host.service.recover())
  if (mode === 'starting') {
    await t.step(() => waitUntil(async () => (await host.query('notification.get', { notificationId: outboundId }))?.state === 'unknown'
      && readbacks.some(item => item.id === outboundId), '原发送中回复只回读并保持未知'))
    assert.notEqual(host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)?.status, 'superseded')
  } else if (stale) {
    const original = await t.step(() => waitUntil(() => host.residentStore.getRouterState('native-group').triage
      .find(entry => entry.triageId === triageId && entry.replyStatus === 'applied'), '原回复退役入账'))
    assert.equal(original.replyReceipt.notificationId, outboundId)
    assert.equal(original.replyReceipt.status, 'retired')
    const retiredNotification = await t.step(() => host.query('notification.get', { notificationId: outboundId }))
    if (mode === 'prepared') assert.equal(retiredNotification?.state, 'superseded')
    else assert.equal(retiredNotification, null)
    assert.equal(host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)?.status, 'superseded')
  } else {
    const notification = await t.step(() => waitUntil(async () => {
      const item = await host.query('notification.get', { notificationId: outboundId })
      return item?.state === 'delivered' && host.residentStore.getRouterState('native-group').triage
        .some(entry => entry.triageId === triageId && entry.replyStatus === 'applied') && item
    }, '原回复沿原身份送达并入账').catch(async error => {
      const notification = await host.query('notification.get', { notificationId: outboundId })
      const triage = host.residentStore.getRouterState('native-group').triage.find(item => item.triageId === triageId)
      throw new Error(`${error.message} ${JSON.stringify({ state: notification?.state, replyStatus: triage?.replyStatus,
        sent: sent.length, readbacks: readbacks.length, alerts: host.service.listAlerts() })}`)
    }))
    assert.equal(notification.id, outboundId)
    assert.equal(sent[0].id, outboundId)
  }
  if (stale) {
    const valid = await t.step(() => waitUntil(async () => {
      const item = sent.find(entry => entry.payload.replyToMessageId === 'valid-source')
      return item && (await host.query('notification.get', { notificationId: item.id }))?.state === 'delivered' && item
    }, '有效来源送达'))
    assert.equal(valid.payload.replyToMessageId, 'valid-source')
    assert.equal(sent.some(item => item.id === outboundId), false)
  }
  assert.equal(sent.length, 1)
  if (mode === 'two') {
    assert.ok(firstReceipt?.id)
    assert.notEqual(firstReceipt.id, outboundId)
    assert.deepEqual(await t.step(() => host.query('notification.get', { notificationId: firstReceipt.id })), firstReceipt)
    assert.equal(sent[0].payload.replyToMessageId, 'cold-source')
  }
  await t.step(() => host.service.recover())
  await t.step(() => host.service.whenIdle())
  assert.equal(sent.length, 1)
  if (mode === 'two') assert.deepEqual(await t.step(() => host.query('notification.get', { notificationId: firstReceipt.id })), firstReceipt)
}))

testRunner('direct Router rejects a stale reply review after the same-version triage reply is delivered', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'initial-fact-fence-'))
  const sendEntered = Promise.withResolvers(), releaseSend = Promise.withResolvers(), reviewEntered = Promise.withResolvers(), releaseReview = Promise.withResolvers()
  let host, phase = 0, originalId, staleReview
  const sent = []
  t.onCancel(() => { releaseSend.resolve(); releaseReview.resolve() })
  t.after(async () => { releaseSend.resolve(); releaseReview.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name), values = modelToolValues(request)
    const missing = missingSourceRead(request, input)
    if (missing) return [call('router_source_read', missing)]
    const sourceId = input.sources[0].sourceId
    const reviews = values.filter(value => value.sourceId === sourceId && Array.isArray(value.candidates))
    if (names.includes('triage_submit')) {
      if (!reviews.length) return [call('router_reply_review_get', {})]
      return [call('triage_submit', { needsProcessing: true, reply: '已收到核查请求。', review: {
        kind: 'substantive', reviewedOutboundIds: reviews.at(-1).candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
    }
    if (!names.includes('router_submit')) throw new Error(`Unexpected tools: ${names.join(', ')}`)
    if (!reviews.length || phase === 2) { if (phase === 2) phase = 3; return [call('router_reply_review_get', { sourceId })] }
    if (phase === 0) {
      await sendEntered.promise
      staleReview = reviews.at(-1)
      assert.ok(staleReview.candidates.some(item => item.outboundId === originalId))
      phase = 1; reviewEntered.resolve(); await releaseReview.promise
    } else if (phase === 1) {
      assert.ok(host.toolResults.some(item => item.name === 'router_submit' && JSON.stringify(item.result).includes('router_reply_review_stale')))
      assert.equal(host.residentStore.getRouterState('native-group').decisions.length, 0)
      phase = 2
      return [call('router_reply_review_get', { sourceId })]
    }
    const review = phase === 1 ? staleReview : reviews.at(-1)
    return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '核查请求已记录。', review: {
      kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
  }, { notifications: { async send(notification) {
    if (!originalId) { originalId = notification.id; sendEntered.resolve(); await releaseSend.promise }
    sent.push(structuredClone(notification))
    return { messageId: `sent-${notification.id}` }
  }, async readback(notification) {
    return sent.some(item => item.id === notification.id) ? { messageId: `sent-${notification.id}`, visible: true } : undefined
  } } }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('fact-fence-source', '@测试助手 请核查事实。')))
  await t.step(() => sendEntered.promise)
  await t.step(() => reviewEntered.promise)
  assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'fact-fence-source').messageVersion, 1)
  releaseSend.resolve()
  await t.step(() => waitUntil(async () => (await host.query('notification.get', { notificationId: originalId }))?.state === 'delivered'
    && host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === originalId)?.status === 'sent', '原首筛回复送达'))
  releaseReview.resolve()
  await t.step(() => waitUntil(() => host.residentStore.getRouterState('native-group').decisions.some(item => item.applications.every(application => application.status === 'applied')), '修正后的 Router 决议已应用'))
  assert.ok(host.toolResults.some(item => item.name === 'router_submit' && JSON.stringify(item.result).includes('router_reply_review_stale')))
  assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'fact-fence-source').messageVersion, 1)
  assert.equal((await t.step(() => host.query('task.list'))).length, 0)
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
}))

testRunner('direct Router keeps a late source out of the active batch and handles it afterward', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-late-source-'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const inputs = []
  const ids = ['router-first', 'router-second'].map(id => `im:${createHash('sha256').update(JSON.stringify(['native-group', id, 1])).digest('hex')}`)
  let host, held = false
  t.onCancel(() => release.resolve())
  t.after(async () => { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    const missing = missingSourceRead(request, input)
    if (missing) return [call('router_source_read', missing)]
    if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
    if (!names.includes('router_submit')) throw new Error(`Unexpected tools: ${names.join(', ')}`)
    inputs.push(structuredClone(input))
    if (!held) {
      held = true
      assert.deepEqual(input.context.newSourceIds, [ids[0]])
      assert.deepEqual(input.sources.map(source => source.sourceId), [ids[0]])
      entered.resolve()
      await release.promise
    }
    return [call('router_submit', { actions: [], continuity: ['继续跟进两条独立来源。'], reply: null })]
  }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('router-first', '请记录第一条讨论。')))
  await t.step(() => entered.promise)
  const active = structuredClone(host.residentStore.getRouterState('native-group').active)
  await t.step(() => host.service.ingest(message('router-second', '请记录第二条讨论。')))
  assert.ok(host.residentStore.getGroup('native-group').messages.some(item => item.messageId === 'router-second' && item.messageVersion === 1))
  assert.deepEqual(host.residentStore.getRouterState('native-group').active, active)
  assert.equal(inputs.length, 1)
  release.resolve()
  await t.step(() => waitUntil(async () => {
    const state = host.residentStore.getRouterState('native-group')
    const sources = await host.query('source.list', { groupId: 'native-group' })
    return !state.active && !state.queue.length && ids.every(sourceId => sources.some(source => source.sourceId === sourceId && source.processingCompleted))
      && ids.every(sourceId => state.decisions.some(decision => decision.inputs.some(item => item.sourceRef?.sourceId === sourceId) && decision.applications.every(item => item.status === 'applied')))
  }, '两条来源各自完成 Router 处置'))
  assert.ok(inputs.some(input => input.context.newSourceIds.includes(ids[1]) && input.context.continuity.includes('继续跟进两条独立来源。')))
  const state = host.residentStore.getRouterState('native-group')
  for (const sourceId of ids) assert.equal(state.decisions.filter(decision => decision.inputs.some(item => item.sourceRef?.sourceId === sourceId)).length, 1)
  assert.equal((await t.step(() => host.query('task.list'))).length, 0)
  assert.equal(host.sent.length, 0)
}))

testRunner('direct triage processes a source arriving during an earlier triage without mixing identities', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await mkdtemp(join(tmpdir(), 'routing-live-update-'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), sessions = []
  let host, held = false
  t.onCancel(() => release.resolve())
  t.after(async () => { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (!names.includes('triage_submit')) throw new Error(`Unexpected tools: ${names.join(', ')}`)
    const missing = missingSourceRead(request, input)
    if (missing) return [call('router_source_read', missing)]
    if (!held) { held = true; entered.resolve(); await release.promise }
    return [call('triage_submit', { needsProcessing: false, reply: null })]
  }))
  host.ctx.on('session/created', session => { if (session.id.startsWith('session-triage-')) sessions.push(session.id) })
  await t.beginBusiness()
  const firstIngress = host.service.ingest(message('live-first', '第一条讨论。'))
  await t.step(() => entered.promise)
  assert.equal(sessions.length, 1)
  const firstSession = sessions[0]
  assert.equal(host.ctx.agents.get(firstSession)?.status, 'running')
  await t.step(() => host.service.ingest(message('live-second', '第二条讨论。')))
  assert.equal(host.ctx.agents.get(firstSession)?.status, 'running')
  release.resolve()
  await t.step(() => firstIngress)
  await t.step(() => waitUntil(async () => {
    const sources = await host.query('source.list', { groupId: 'native-group' })
    return ['live-first', 'live-second'].every(id => sources.some(source => source.messageId === id && source.processingCompleted))
  }, '两条来源均完成首筛'))
  const triage = host.residentStore.getRouterState('native-group').triage
  assert.equal(triage.length, 2)
  assert.deepEqual(triage.map(item => item.sourceRef.messageId).sort(), ['live-first', 'live-second'])
  assert.equal(new Set(triage.map(item => item.triageId)).size, 2)
  assert.equal(sessions.length, 2)
  assert.notEqual(sessions[0], sessions[1])
  const sources = await t.step(() => host.query('source.list', { groupId: 'native-group' }))
  const firstSource = sources.find(source => source.messageId === 'live-first')
  const secondSource = sources.find(source => source.messageId === 'live-second')
  const firstTurn = firstSource.stages.find(stage => stage.stage === 'turn' && stage.sessionId === firstSession)
  assert.ok(firstTurn?.completedAt)
  assert.equal(firstTurn.shared, false)
  assert.ok(!(secondSource.stages ?? []).some(stage => stage.spanId === firstTurn.spanId))
  assert.ok((secondSource.stages ?? []).some(stage => stage.stage === 'ingress' && stage.completedAt))
  assert.equal(host.service.listAlerts().some(item => item.id?.startsWith('timing:')), false)
  assert.equal((await t.step(() => host.query('task.list'))).length, 0)
  assert.equal(host.sent.length, 0)
}))



testRunner('notification routing selects only a fixed real human source', () => {
  const human = { messageId: 'human', senderOpenDingTalkId: 'user-a', sourceKind: 'dingtalk' }
  const web = { ...human, messageId: 'web', senderOpenDingTalkId: 'web-actor', sourceKind: 'web' }
  const internal = { ...web, messageId: 'internal', sourceKind: 'internal' }
  for (const [messages, replyToMessageId, expected] of [[[human], 'human', 'user-a'], [[human, web], 'human', 'user-a'],
    [[human, internal], 'human', 'user-a'], [[web], undefined, undefined]]) {
    const result = groupNotificationRouting(messages, { ...(replyToMessageId ? { replyToMessageId } : {}), atOpenDingTalkIds: replyToMessageId ? undefined : [] })
    assert.equal(result.target?.messageId, replyToMessageId)
    assert.deepEqual(result.recipients, expected ? [expected] : [])
  }
})

testRunner('direct source completion is durably stamped while its Task Owner is still blocked',
  { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
    const root = await mkdtemp(join(tmpdir(), 'direct-source-clock-'))
    const releaseOwner = Promise.withResolvers(), ownerEntered = Promise.withResolvers()
    let host, ownerBlocked = false
    t.onCancel(() => releaseOwner.resolve())
    t.after(async () => { releaseOwner.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    host = await t.step(async () => nativeTaskHost(root, async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
      if (names.includes('triage_submit') || names.includes('router_submit')) {
        const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
        for (const source of input.sources ?? []) {
          let offset = 0
          while (offset < source.totalLength) {
            const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
            if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
        const firstSourceId = `im:${createHash('sha256').update(JSON.stringify(['native-group', 'fast-clock', 1])).digest('hex')}`
        const sourceIds = (input.context?.newSourceIds ?? []).filter(sourceId => sourceId === firstSourceId)
        return [call('router_submit', { actions: sourceIds.length ? [{ kind: 'new-task', sourceIds, title: '来源时钟任务', objective: '等待Owner完成只读核验' }] : [], continuity: [], reply: null })]
      }
      if (names.includes('task_session_submit')) {
        ownerBlocked = true; ownerEntered.resolve()
        await releaseOwner.promise
        return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续资料', evidence: [], limitations: [] } })]
      }
      throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
    }))
    const source = message('fast-clock', '@助手，创建只读核验任务并等待资料。')
    await t.step(async () => host.service.ingest(source))
    await t.step(async () => ownerEntered.promise)
    const firstSource = await t.step(async () => waitUntil(async () => {
      const item = (await host.query('source.list')).find(entry => entry.messageId === source.messageId)
      return item?.processingCompleted && item
    }, '原来源在 Owner 阻塞时完成'))
    const settledAt = firstSource.processingCompleted.at
    assert.ok(ownerBlocked)
    const unrelated = message('slow-clock', '测试助手，记录一个独立事项，不要求回复或执行。')
    await t.step(async () => host.service.ingest(unrelated))
    await t.step(async () => waitUntil(async () => (await host.query('source.list')).find(item => item.messageId === unrelated.messageId)?.processingCompleted,
      'independent source processing projection', 5000))
    assert.equal((await t.step(async () => host.query('source.list'))).find(item => item.messageId === source.messageId).processingCompleted.at, settledAt)
    assert.ok(ownerBlocked)
    assert.equal((await t.step(async () => host.query('task.list'))).length, 1)
    assert.equal(host.sent.length, 0)
    releaseOwner.resolve()
    await t.step(async () => host.service.whenIdle())
    const finalSource = (await t.step(async () => host.query('source.list'))).find(item => item.messageId === source.messageId)
    assert.equal(finalSource.processingCompleted.at, settledAt)
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    assert.equal((await t.step(async () => host.query('source.list'))).find(item => item.messageId === source.messageId).processingCompleted.at, settledAt)
    assert.equal((await t.step(async () => host.query('task.list'))).length, 1)
    assert.equal(host.residentStore.listTopics('native-group').length, 0)
    assert.equal(host.sent.length, 0)
  }))




testRunner('direct Router binds reply review and source reads to explicitly admitted source identity',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    const source = message('contract-source', '固定来源读取合同核验，无需办理业务。')
    const sourceId = `im:${createHash('sha256').update(JSON.stringify([source.groupId, source.messageId, 1])).digest('hex')}`
    let triaged = false, wrongSourceChecked = false, reviewed = false, sourceRead = false
    const h = await extraHost(t, 'bound-direct-source-read-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
      const missingSource = missingSourceRead(request, input)
      if (missingSource) return [call('router_source_read', missingSource)]
      if (names.includes('triage_submit')) {
        if (!triaged) {
          triaged = true
          return [call('triage_submit', { needsProcessing: true, reply: null })]
        }
      }
      if (names.includes('router_submit')) {
        assert.deepEqual(request.tools.find(tool => tool.name === 'router_reply_review_get').parameters.required, ['sourceId'])
        assert.deepEqual(request.tools.find(tool => tool.name === 'router_source_read').parameters.required, ['sourceId', 'offset'])
        if (!wrongSourceChecked) { wrongSourceChecked = true; return [call('router_reply_review_get', { sourceId: 'cross-source' })] }
        const invalid = values.find(value => value.error === 'router_source_unadmitted' || value.status === 'router_source_unadmitted')
        assert.ok(invalid || h.toolResults.some(item => item.name === 'router_reply_review_get' && JSON.stringify(item.result).includes('router_source_unadmitted')))
        const review = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
        if (!reviewed) { reviewed = true; return [call('router_reply_review_get', { sourceId })] }
        const current = values.findLast(value => value.batchId === input.batchId && value.sourceId === sourceId && Number.isInteger(value.nextOffset))
        if (!current) return [call('router_source_read', { sourceId, offset: 0 })]
        assert.equal(current.nextOffset, current.totalLength)
        sourceRead = true
        assert.equal(review.sourceId, sourceId)
        assert.ok(Array.isArray(review.candidates))
        return [call('router_submit', { actions: [], continuity: [], reply: null })]
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: false, reply: null })]
      throw new Error(`Unexpected direct source tools: ${names.join(', ')}`)
    })
    await t.beginBusiness()
    await t.step(() => h.service.ingest(source))
    await t.step(() => h.service.whenIdle())
    const persisted = (await t.step(() => h.query('source.list'))).find(item => item.messageId === source.messageId)
    assert.ok(persisted?.processingCompleted)
    assert.equal(persisted.sourceId, sourceId)
    assert.ok(wrongSourceChecked && reviewed && sourceRead)
    assert.ok(h.toolResults.some(item => item.name === 'router_reply_review_get' && JSON.stringify(item.result).includes('router_source_unadmitted')))
    assert.equal(h.residentStore.getRouterState('native-group').decisions.length, 1)
    assert.equal((await t.step(() => h.query('task.list'))).length, 0)
    assert.equal(h.residentStore.listTopics('native-group').length, 0)
    assert.equal(h.sent.length, 0)
  }))

testRunner('direct Router reads the current Task before a preserve-only context update',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    const objective = '只核对资料，不执行部署。' + '范围约束'.repeat(1100)
    let taskId, original, h, ownerRunsBefore = 0, taskRead = false
    h = await t.step(() => extraHost(t, 'direct-task-context-cas-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
      const missingSource = missingSourceRead(request, input)
      if (missingSource) return [call('router_source_read', missingSource)]
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      if (names.includes('router_submit') || names.includes('router_task_list') || names.includes('router_task_get') || names.includes('router_source_read')) {
        for (const source of input.sources ?? []) {
          let offset = 0
          while (offset < source.totalLength) {
            const page = values.find(item => item.batchId === input.batchId && item.sourceId === source.sourceId && item.offset === offset && Number.isInteger(item.nextOffset))
            if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        if (!values.some(value => Array.isArray(value.tasks))) return [call('router_task_list', {})]
        const summary = values.flatMap(value => value.tasks ?? []).find(item => item.taskId === taskId)
        assert.ok(summary)
        const loaded = values.findLast(value => (value.task?.taskId ?? value.taskId) === taskId)
        if (!loaded) return [call('router_task_get', { taskId })]
        const task = loaded.task ?? loaded
        taskRead = true
        assert.equal(task.taskId, taskId)
        assert.equal(task.requirementRevision, original.requirementRevision)
        assert.ok(task.objective.includes(objective))
        return [call('router_submit', { actions: [{ kind: 'task-context', taskId, inputVersion: task.requirementRevision,
          runSequence: task.runSequence, expectedControlRevision: task.controlRevision,
          context: '补充只检查名称，不发送通知。', progressImpact: 'preserve', sourceIds: input.context?.newSourceIds ?? [] }], continuity: [], reply: null })]
      }
      if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续资料', evidence: [], limitations: [] } })]
      throw new Error(`Unexpected direct Task tools: ${names.join(', ')}`)
    }))
    await t.beginBusiness()
    const created = await t.step(() => h.service.createTask({ groupId: 'native-group', requestId: 'context-original', title: '资料核对', objective }))
    await t.step(() => h.service.whenIdle())
    original = await t.step(() => h.query('task.get', { taskId: created.taskId }))
    taskId = original.taskId
    ownerRunsBefore = h.toolResults.filter(item => item.name === 'task_session_submit').length
    const follow = message('inline-apply-follow', '请补充原任务：只检查名称，不发送通知。')
    await t.step(() => h.service.ingest(follow))
    await t.step(() => h.service.whenIdle())
    assert.ok(taskRead, JSON.stringify({ tools: h.toolResults.map(item => ({ name: item.name, status: item.result.value?.status, error: item.result.value?.error ?? item.result.error,
      taskId: item.result.value?.task?.taskId ?? item.result.value?.taskId, hasTasks: Array.isArray(item.result.value?.tasks), objective: typeof (item.result.value?.task?.objective ?? item.result.value?.objective) })) }))
    const updated = await t.step(() => h.query('task.get', { taskId }))
    assert.equal(updated.requirementRevision, original.requirementRevision)
    assert.equal(updated.controlRevision, original.controlRevision)
    assert.equal(updated.sessionId, original.sessionId)
    assert.equal(updated.runSequence, original.runSequence)
    assert.equal(updated.drained, true)
    assert.equal(updated.lastDecision.action, 'wait')
    assert.ok(updated.request.includes('只检查名称，不发送通知'), JSON.stringify({ tail: updated.request.slice(-240),
      tools: h.toolResults.slice(-8).map(item => ({ name: item.name, status: item.result.value?.status, error: item.result.value?.error ?? item.result.error })), alerts: h.service.listAlerts() }))
    const sourceId = `im:${createHash('sha256').update(JSON.stringify(['native-group', follow.messageId, 1])).digest('hex')}`
    assert.ok(updated.sourceRefs.includes(sourceId))
    assert.equal(h.toolResults.filter(item => item.name === 'task_session_submit').length, ownerRunsBefore + 1,
      'a preserve-only supplement feeds the existing Task Owner without changing its run identity')
    assert.ok(h.requests.some(request => request.tools.some(tool => tool.name === 'task_session_submit')
      && JSON.stringify(request.messages).includes('只检查名称，不发送通知')), 'the existing Owner must receive the supplemental context')
    assert.equal((await t.step(() => h.query('task.list'))).length, 1)
    assert.ok((await t.step(() => h.query('source.list'))).find(source => source.messageId === follow.messageId)?.processingCompleted)
    assert.equal(h.residentStore.listTopics('native-group').length, 0)
    assert.equal(h.sent.length, 0)
  }))

testRunner('direct Router explicitly reads an oversized Task before the current decision',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    const objective = '必须完整核验的原目标'.repeat(800)
    let taskId, fullRead = false
    const h = await t.step(() => extraHost(t, 'direct-linked-task-read-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
      const missingSource = missingSourceRead(request, input)
      if (missingSource) return [call('router_source_read', missingSource)]
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      if (names.includes('router_submit') || names.includes('router_task_list') || names.includes('router_task_get') || names.includes('router_source_read')) {
        for (const source of input.sources ?? []) {
          let offset = 0
          while (offset < source.totalLength) {
            const page = values.find(item => item.batchId === input.batchId && item.sourceId === source.sourceId && item.offset === offset && Number.isInteger(item.nextOffset))
            if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        if (!values.some(value => Array.isArray(value.tasks))) return [call('router_task_list', {})]
        const summary = values.flatMap(value => value.tasks ?? []).find(task => task.taskId === taskId)
        assert.ok(summary)
        const full = values.findLast(value => (value.task?.taskId ?? value.taskId) === taskId && (value.task?.objective ?? value.objective))
        if (!full) return [call('router_task_get', { taskId })]
        const task = full.task ?? full
        assert.equal(task.objective, objective)
        assert.ok(Buffer.byteLength(JSON.stringify(task), 'utf8') > 64 * 1024, 'the complete Task remains larger than the former inline budget')
        fullRead = true
        return [call('router_submit', { actions: [], continuity: [], reply: null })]
      }
      if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续资料', evidence: [], limitations: [] } })]
      throw new Error(`Unexpected direct Task tools: ${names.join(', ')}`)
    }))
    await t.beginBusiness()
    const created = await t.step(() => h.service.createTask({ groupId: 'native-group', requestId: 'linked-original', title: '关联原任务', objective }))
    await t.step(() => h.service.whenIdle())
    taskId = created.taskId
    const original = await t.step(() => h.query('task.get', { taskId }))
    const ownerRuns = h.toolResults.filter(item => item.name === 'task_session_submit').length
    await t.step(() => h.service.ingest(message('linked-follow', '补充原事项讨论，只核对上下文，不执行新动作。')))
    await t.step(() => h.service.whenIdle())
    assert.ok(fullRead, JSON.stringify({ tools: h.toolResults.slice(-8).map(item => ({ name: item.name,
      status: item.result.value?.status, error: item.result.value?.error ?? item.result.error })), alerts: h.service.listAlerts() }))
    assert.deepEqual(await t.step(() => h.query('task.get', { taskId })), original, 'a read-only context lookup must not mutate or wake the Task')
    assert.equal(h.toolResults.filter(item => item.name === 'task_session_submit').length, ownerRuns)
    assert.equal(h.toolResults.filter(item => item.name === 'router_task_list').length, 1)
    assert.equal(h.toolResults.filter(item => item.name === 'router_task_get').length, 1)
    assert.equal((await t.step(() => h.query('task.list'))).length, 1)
    assert.ok((await t.step(() => h.query('source.list'))).find(source => source.messageId === 'linked-follow')?.processingCompleted)
    assert.equal(h.residentStore.listTopics('native-group').length, 0)
    assert.equal(h.sent.length, 0)
  }))

testRunner('direct Router reads archived Task identity only within its current group', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  let taskId, foreignTaskId, foreignRequested = false, missingRequested = false, checked = false
  const h = await extraHost(t, 'direct-archived-task-context-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      if (!values.some(value => Array.isArray(value.tasks))) return [call('router_task_list', {})]
      const archived = values.findLast(value => (value.task?.taskId ?? value.taskId) === taskId)
      if (!archived) return [call('router_task_get', { taskId })]
      if (!archived) return [call('router_task_get', { taskId })]
      assert.equal((archived.task ?? archived).taskId, taskId)
      if (!foreignRequested) { foreignRequested = true; return [call('router_task_get', { taskId: foreignTaskId })] }
      if (!missingRequested) { missingRequested = true; return [call('router_task_get', { taskId: 'missing-task-id' })] }
      const errors = h.toolResults.filter(item => item.name === 'router_task_get' && item.result.isError)
      assert.equal(errors.length, 2)
      assert.ok(errors.every(item => item.result.error?.message === 'router_task_missing'))
      assert.doesNotMatch(JSON.stringify(errors), /跨群机密原目标/)
      checked = true
      return [call('router_submit', { actions: [], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: {
      action: 'complete', summary: '归档测试完成。', evidence: ['已完成身份检查'], limitations: [] } })]
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'archive-contract-create', title: '归档测试', objective: '敏感原目标不应出现在归档上下文' }))
  taskId = created.taskId
  await t.step(async () => waitUntil(async () => {
    const task = await h.query('task.get', { taskId })
    return task?.status === 'completed' && task.drained
  }, '原群任务完成并排空'))
  await t.step(async () => h.service.archiveTask({ taskId }))
  await t.step(async () => h.residentStore.subscribe({ groupId: 'foreign-group', name: '隔离测试群', responsibility: '测试群边界' }))
  const foreign = await t.step(async () => h.service.createTask({ groupId: 'foreign-group', requestId: 'foreign-archive-create', title: '外群测试', objective: '跨群机密原目标' }))
  foreignTaskId = foreign.taskId
  await t.step(async () => waitUntil(async () => {
    const task = await h.query('task.get', { taskId: foreignTaskId })
    return task?.status === 'completed' && task.drained
  }, '外群任务完成并排空'))
  await t.step(async () => h.service.archiveTask({ taskId: foreignTaskId }))
  await t.step(async () => h.service.ingest(message('archive-contract-source', '只核对归档身份，无需执行。')))
  await t.step(async () => waitUntil(() => checked, 'Router完成归档身份读取').catch(error => {
    throw new Error(`${error.message} ${JSON.stringify({ foreignRequested, missingRequested, alerts: h.service.listAlerts(),
      results: h.toolResults.slice(-8).map(item => ({ name: item.name, error: item.result.error?.message })) })}`)
  }))
  assert.equal(checked, true)
  assert.ok(h.toolResults.some(item => item.name === 'router_task_get' && JSON.stringify(item.result).includes('router_task_missing')))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal(h.sent.length, 0)
}))

for (const recovery of ['retry', 'same-turn']) testRunner('Router failed task action cannot become empty success; recovery=' + recovery, { timeout: nativeLifecycleTimeout(30000), ...(!available ? { skip: reason } : {}) }, nativeLifecycle(30000, async t => {
  let original, retrying = false, taskReadForRetry = false, retryAttempts = 0, attempts = 0
  const ownerInputs = []
  const h = await extraHost(t, 'router-task-contract-', async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const missing = missingSourceRead(request, input)
      if (missing) return [call('router_source_read', missing)]
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length || input.sources.some(source => source.text.includes('无需新任务')))
        return [call('router_submit', { actions: [], continuity: [], reply: null })]
      if (retrying && ++retryAttempts === 1) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      if (retrying && !taskReadForRetry) { taskReadForRetry = true; return [call('router_task_get', { taskId: original.taskId })] }
      const loaded = modelToolValues(request).findLast(value => value.task?.taskId === original.taskId)
      if (!loaded) return [call('router_task_get', { taskId: original.taskId })]
      const task = loaded.task
      const action = { kind: 'task-reopen', taskId: task.taskId, inputVersion: task.requirementRevision,
        runSequence: task.runSequence, expectedControlRevision: task.controlRevision, context: '按已批准的方案开始开发，保留原任务和会话。', sourceIds }
      if (!retrying && ++attempts === 1) return [call('router_submit', { actions: [{ ...action, kind: 'update-task' }], continuity: [], reply: null })]
      if (!retrying && attempts === 2) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      if (!retrying && recovery === 'retry') {
        host.ctx.agents.get(host.residentStore.getRouterState('native-group').sessionId).cancel({ kind: 'user' })
        return []
      }
      const schema = request.tools.find(tool => tool.name === 'router_submit').parameters.properties.actions.items
      const branches = schema.oneOf ?? [schema]
      assert.deepEqual([...new Set(branches.flatMap(branch => branch.properties.kind.enum ?? [branch.properties.kind.const]))].sort(),
        ['new-task', 'task-cancel', 'task-context', 'task-reopen'])
      const reopen = branches.find(branch => branch.properties.kind.const === 'task-reopen')
      assert.ok(reopen.required.includes('expectedControlRevision'))
      assert.ok(reopen.required.includes('context'))
      return [call('router_submit', { actions: [action], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) {
      ownerInputs.push({ task: input.task, visible: JSON.stringify([input, request.messages, modelToolValues(request)]) })
      return [call('task_session_submit', { decision: { action: 'complete', summary: '已收到当前输入并完成隔离核验', evidence: ['真实原生Owner输入'], limitations: [] } })]
    }
    throw new Error(`Unexpected tools: ${names.join(', ')}`)
  })
  t.onCancel(() => t.diagnostic(JSON.stringify({ attempts, retrying, failure: h.residentStore.getRouterState('native-group').failures, tools: h.toolResults.slice(-5), owner: ownerInputs.map(item => item.task) })))
  await t.beginBusiness()
  const created = await t.step(() => h.service.createTask({ groupId: 'native-group', requestId: 'seed-contract', title: '原方案', objective: '完成方案分析' }))
  await t.step(() => h.service.whenIdle())
  original = await t.step(() => h.query('task.get', { taskId: created.taskId }))
  assert.equal(original.status, 'completed')
  ownerInputs.length = 0
  const source = message('develop-approved', '方案已批准，开发吧。')
  await t.step(() => h.service.ingest(source))
  await t.step(() => h.service.whenIdle())
  if (recovery === 'retry') {
    const state = h.residentStore.getRouterState('native-group')
    assert.equal(state.decisions.some(item => item.inputs.some(input => input.kind === 'source' && input.sourceRef.messageId === source.messageId)), false)
    const failure = state.failures.find(item => item.sourceRef.messageId === source.messageId && item.status === 'failed')
    assert.ok(failure, 'must persist a retryable failure instead of completing the source')
    assert.equal(failure.code, 'router_task_action_unresolved')
    const storedSource = (await t.step(() => h.query('source.list'))).find(item => item.messageId === source.messageId)
    assert.equal(storedSource.processingCompleted, undefined)
    assert.equal((await t.step(() => h.query('task.get', { taskId: original.taskId }))).requirementRevision, original.requirementRevision)
    assert.equal(ownerInputs.length, 0)
    retrying = true
    await t.step(() => h.service.retryMessageProcessing({ groupId: 'native-group', messageId: source.messageId,
      messageVersion: 1, phase: failure.phase, requestId: failure.requestId, token: failure.retryToken }))
    await t.step(() => h.service.whenIdle())
  }
  const tasks = await t.step(() => h.query('task.list'))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskId, original.taskId)
  assert.equal(tasks[0].sessionId, original.sessionId)
  assert.equal(tasks[0].runSequence, original.runSequence + 1)
  assert.equal(tasks[0].requirementRevision, original.requirementRevision + 1)
  assert.equal(ownerInputs.length, 1)
  assert.equal(ownerInputs[0].task.requirementRevision, original.requirementRevision + 1)
  assert.ok(tasks[0].request.includes('按已批准的方案开始开发'))
  assert.ok(ownerInputs[0].visible.includes('方案已批准，开发吧'))
  assert.ok(h.toolResults.some(item => item.name === 'router_submit' && JSON.stringify(item.result).includes('router_task_action_unresolved')))
  await t.step(() => h.service.ingest(source))
  await t.step(() => h.service.recover())
  await t.step(() => h.service.whenIdle())
  assert.equal(ownerInputs.length, 1)
  await t.step(() => h.service.ingest(message('benign-after-error', '无需新任务，仅记录讨论。')))
  await t.step(() => h.service.whenIdle())
  const benign = (await t.step(() => h.query('source.list'))).find(item => item.messageId === 'benign-after-error')
  assert.ok(benign.processingCompleted, 'prior batch failures must not forbid a legitimate empty decision')
  assert.equal(h.sent.length, 0)
}))

testRunner('native direct Router batch followup reopens each original completed task and session once', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const reopenedInputs = []
  const h = await extraHost(t, 'direct-task-batch-followup-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const listed = values.findLast(value => Array.isArray(value.tasks) && value.tasks.some(task => task.title?.startsWith('dataset ')))
      if (!listed) return [call('router_task_list', {})]
      const targets = listed.tasks.filter(task => task.title.startsWith('dataset '))
      const loaded = targets.map(target => values.findLast(value => (value.task?.taskId ?? value.taskId) === target.taskId)).filter(Boolean)
      if (loaded.length !== targets.length) return [call('router_task_get', { taskId: targets.find(target => !loaded.some(value => (value.task?.taskId ?? value.taskId) === target.taskId)).taskId })]
      const taskStates = loaded.map(value => value.task ?? value)
      assert.ok(taskStates.every(task => task.status === 'completed' || task.state === 'completed'))
      return [call('router_submit', { actions: taskStates.map(task => ({ kind: 'task-reopen', taskId: task.taskId,
        inputVersion: task.requirementRevision, runSequence: task.runSequence, expectedControlRevision: task.controlRevision,
        context: `仅跟进 ${task.title} 的原 PR；核查新评论，适用时修订、验证并提测原 UAT，无新评论则不重复修改或部署。`, sourceIds })), continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) {
      const input = latestInput(request)
      reopenedInputs.push({ taskId: input.task.taskId, sessionId: input.task.sessionId, request: input.task.request })
      return [call('task_session_submit', { decision: { action: 'complete', summary: '已核查，无新增适用评论，不修改或提测。', evidence: ['原任务上下文已核对'], limitations: [] } })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  for (const title of ['dataset 名称校验', 'dataset 关联校验', '无关通知文案']) {
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: `seed-${title}`, title, objective: `${title}：完成原 PR 并交付原 UAT` }))
    await t.step(async () => h.service.whenIdle())
  }
  const originals = await t.step(async () => h.query('task.list'))
  assert.ok(originals.every(task => task.status === 'completed'))
  reopenedInputs.length = 0
  const source = message('batch-followup', '测试助手，云端对dataset项目当前活跃的PR做了代码审查，并给出了修复方案，你看看你当前已完成的项目中未合并的PR是否有新的评论，如果有，则逐个按照PR中的评论修改，然后重新提测对应UAT环境')
  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.whenIdle())
  const after = await t.step(async () => h.query('task.list'))
  assert.equal(after.length, originals.length)
  for (const original of originals) {
    const current = after.find(task => task.taskId === original.taskId), selected = original.title.startsWith('dataset ')
    assert.equal(current.sessionId, original.sessionId)
    assert.equal(current.runSequence, original.runSequence + Number(selected))
    assert.equal(current.requirementRevision, original.requirementRevision + Number(selected))
    assert.ok(current.request.startsWith(original.request))
    assert.ok(original.sourceRefs.every(ref => current.sourceRefs.includes(ref)))
    assert.deepEqual(current.topicRefs, original.topicRefs)
    assert.equal(current.status, 'completed')
  }
  assert.equal(reopenedInputs.length, 2)
  const router = h.residentStore.getRouterState('native-group')
  const decision = router.decisions.find(item => item.inputs?.some(input => input.kind === 'source' && input.sourceRef.messageId === source.messageId))
  assert.ok(decision)
  assert.deepEqual(decision.applications.map(application => application.action.kind), ['task-reopen', 'task-reopen'])
  assert.ok(decision.applications.every(application => application.status === 'applied'))
  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  assert.equal(reopenedInputs.length, 2)
  assert.deepEqual((await t.step(async () => h.query('task.list'))).map(task => [task.taskId, task.requirementRevision, task.runSequence]), after.map(task => [task.taskId, task.requirementRevision, task.runSequence]))
}))

for (const quoted of [true, false]) testRunner('直接来源路由显式多人通知贯穿原生通知格式化 quoted=' + quoted, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const first = { ...message('recipient-a', '@助手 请核对资料。'), senderOpenDingTalkId: 'user-a' }
  const second = { ...message('recipient-b', '资料已准备。'), senderOpenDingTalkId: 'user-b' }
  const sourceIdFor = input => `im:${createHash('sha256').update(JSON.stringify([input.groupId, input.messageId, input.messageVersion ?? 1])).digest('hex')}`
  const firstSourceId = sourceIdFor(first), secondSourceId = sourceIdFor(second)
  let rejectedQuote = false
  const h = await extraHost(t, 'direct-source-recipients-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      if (names.includes('triage_submit')) {
        for (const source of input.sources ?? []) {
          let offset = 0
          while (offset < source.totalLength) {
            const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
            if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        return [call('triage_submit', { needsProcessing: true, reply: null })]
      }
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.includes(secondSourceId)) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const firstPage = pages.find(item => item.sourceId === firstSourceId && item.offset === 0)
      if (!firstPage && !input.sources?.some(source => source.sourceId === firstSourceId))
        return [call('router_source_read', { sourceId: firstSourceId, offset: 0 })]
      const sources = [...(input.sources ?? [])]
      if (!sources.some(source => source.sourceId === firstSourceId)) sources.push({ sourceId: firstSourceId, totalLength: firstPage.totalLength })
      for (const source of sources) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      const review = values.findLast(value => value.sourceId === secondSourceId && Array.isArray(value.candidates))
      if (!review) return [call('router_reply_review_get', { sourceId: secondSourceId })]
      if (rejectedQuote) {
        const error = JSON.stringify(request.messages.filter(item => item.role === 'tool').slice(-2))
        assert.match(error, /group_reply_quote_author_not_in_recipients/i)
      }
      const reply = { sourceId: secondSourceId, text: '已收到资料。', review: { kind: 'substantive',
        reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
        atOpenDingTalkIds: ['user-a', 'user-b'] }
      if (!quoted && !rejectedQuote) {
        rejectedQuote = true
        reply.replyToMessageId = 'recipient-b'
        reply.atOpenDingTalkIds = ['user-a']
      } else if (quoted) reply.replyToMessageId = 'recipient-a'
      return [call('router_submit', { actions: [], continuity: [], reply })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  t.onCancel(() => t.diagnostic(JSON.stringify({ quoted, sourceIds: [firstSourceId, secondSourceId],
    requests: h.requests.slice(-4).map(request => ({ tools: request.tools.map(tool => tool.name), newSourceIds: latestInput(request).context?.newSourceIds })),
    results: h.toolResults.slice(-8).map(item => ({ name: item.name, error: item.result.error ?? item.result.value?.error, status: item.result.value?.status })),
    decisions: h.residentStore.getRouterState('native-group').decisions.map(item => ({ id: item.decisionId, inputs: item.inputs.map(input => input.sourceRef?.sourceId), applications: item.applications.map(application => ({ kind: application.kind, status: application.status })) })) })))
  await t.beginBusiness()

  await t.step(async () => Promise.all([h.service.ingest(first), h.service.ingest(second)]))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => {
    const sources = await h.query('source.list')
    return sources.some(item => item.messageId === first.messageId && item.processingCompleted)
      && sources.some(item => item.messageId === second.messageId && item.processingCompleted) && h.sent.length === 1
  }, 'direct Router multi-recipient reply sent'))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].payload.replyToMessageId, quoted ? 'recipient-a' : undefined)
  assert.deepEqual(h.sent[0].payload.atOpenDingTalkIds, ['user-a', 'user-b'])
  assert.equal(h.residentStore.getGroup('native-group').outbox.length, 1)
  assert.equal(h.residentStore.getGroup('native-group').outbox[0].replyToMessageId, quoted ? 'recipient-a' : undefined)
  assert.deepEqual(h.residentStore.getGroup('native-group').outbox[0].atOpenDingTalkIds, ['user-a', 'user-b'])
  if (!quoted) assert.ok(h.toolResults.some(result => JSON.stringify(result).includes('group_reply_quote_author_not_in_recipients')))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(h.sent.length, 1)
}))

testRunner('direct Router retires a reply when a non-anchor recipient source changes before first prepare', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'direct-router-recipient-source-revision-'))
  const anchor = { ...message('recipient-anchor', '@助手 请核对资料。'), senderOpenDingTalkId: 'user-a' }
  const participant = { ...message('recipient-participant', '资料已准备。'), senderOpenDingTalkId: 'user-b' }
  const revisedParticipant = { ...participant, messageVersion: 2, text: '资料版本已更新，但仍不需要新回复。' }
  const sourceIdFor = input => `im:${createHash('sha256').update(JSON.stringify([input.groupId, input.messageId, input.messageVersion ?? 1])).digest('hex')}`
  const anchorSourceId = sourceIdFor(anchor), participantSourceId = sourceIdFor(participant), revisedSourceId = sourceIdFor(revisedParticipant)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let host, intercepted, originalPreparation
  t.onCancel(() => release.resolve())
  t.after(async () => { release.resolve(); if (host) { if (originalPreparation) host.residentStore.withRouterReplyPreparation = originalPreparation; await host.close() } await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      if (names.includes('triage_submit')) {
        for (const source of input.sources ?? []) {
          let offset = 0
          while (offset < source.totalLength) {
            const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
            if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        const isRevisedParticipant = input.sources?.some(source => source.sourceId === revisedSourceId)
        return [call('triage_submit', { needsProcessing: !isRevisedParticipant, reply: null })]
      }
      const newSourceIds = input.context?.newSourceIds ?? []
      if (!newSourceIds.includes(participantSourceId)) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const sources = [...(input.sources ?? [])]
      const anchorPage = pages.find(item => item.sourceId === anchorSourceId && item.offset === 0)
      if (!anchorPage && !sources.some(source => source.sourceId === anchorSourceId)) return [call('router_source_read', { sourceId: anchorSourceId, offset: 0 })]
      if (!sources.some(source => source.sourceId === anchorSourceId)) sources.push({ sourceId: anchorSourceId, totalLength: anchorPage.totalLength })
      for (const source of sources) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      const review = values.findLast(value => value.sourceId === anchorSourceId && Array.isArray(value.candidates))
      if (!review) return [call('router_reply_review_get', { sourceId: anchorSourceId })]
      return [call('router_submit', { actions: [], continuity: [], reply: { sourceId: anchorSourceId, text: '已收到资料，正在核对。',
        replyToMessageId: participant.messageId, atOpenDingTalkIds: ['user-a', 'user-b'],
        review: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  }))
  originalPreparation = host.residentStore.withRouterReplyPreparation.bind(host.residentStore)
  host.residentStore.withRouterReplyPreparation = async args => {
    if (!intercepted && args.intent.sourceRef.sourceId === anchorSourceId
      && args.intent.notificationRouting?.sourceRefs.some(ref => ref.sourceId === participantSourceId && ref.messageVersion === 1)) {
      intercepted = structuredClone({ decisionId: args.intent.decisionId, operationId: args.intent.operationId,
        sourceRef: args.intent.sourceRef, notificationRouting: args.intent.notificationRouting })
      entered.resolve()
      await release.promise
    }
    return originalPreparation(args)
  }

  await t.step(async () => host.service.ingest(anchor))
  await t.step(async () => waitUntil(async () => (await host.query('source.list')).some(source => source.sourceId === anchorSourceId && source.processingCompleted), 'anchor source completes'))
  await t.step(async () => host.service.ingest(participant))
  await t.step(async () => entered.promise)
  assert.deepEqual(intercepted.sourceRef, { sourceId: anchorSourceId, messageId: anchor.messageId, messageVersion: 1 })
  assert.ok(intercepted.notificationRouting.sourceRefs.some(ref => ref.sourceId === participantSourceId && ref.messageVersion === 1))
  const decision = host.residentStore.getRouterState('native-group').decisions.find(item => item.decisionId === intercepted.decisionId)
  const application = decision?.applications.find(item => item.operationId === intercepted.operationId && item.kind === 'reply')
  assert.ok(application)
  assert.notEqual(application.status, 'applied')
  const outboundId = `router-reply:${intercepted.operationId}`
  assert.equal(await t.step(async () => host.query('notification.get', { notificationId: outboundId })), null)
  assert.equal(host.residentStore.getGroup('native-group').outbox.some(item => item.outboundId === outboundId), false)

  await t.step(async () => host.service.ingest(revisedParticipant))
  await t.step(async () => waitUntil(async () => (await host.query('source.list')).some(source => source.sourceId === revisedSourceId && source.version === 2), 'revised non-anchor source is durably ingested'))
  assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === participant.messageId).messageVersion, 2)
  assert.equal((await t.step(async () => host.query('source.get', { sourceId: participantSourceId }))).version, 1)
  release.resolve()
  await t.step(async () => host.service.whenIdle())
  assert.ok((await t.step(async () => host.query('source.list'))).some(source => source.sourceId === revisedSourceId && source.processingCompleted))

  const settledDecision = host.residentStore.getRouterState('native-group').decisions.find(item => item.decisionId === intercepted.decisionId)
  const settledApplication = settledDecision.applications.find(item => item.operationId === intercepted.operationId && item.kind === 'reply')
  assert.equal(settledApplication.status, 'applied')
  const retired = host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)
  assert.equal(retired.status, 'superseded')
  assert.equal(retired.supersededReason, 'router-source-stale-before-prepare')
  assert.equal(await t.step(async () => host.query('notification.get', { notificationId: outboundId })), null)
  assert.equal(host.sent.length, 0)
  assert.equal((await t.step(async () => host.query('task.list'))).length, 0)
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
}))

for (const mode of ['prepared', 'projected', 'revision-conflict', 'taskIds-conflict']) testRunner(`旧回复冻结恢复 ${mode}`, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'topic-frozen-recovery-'))
  let h, stage = 'initial host'
  t.after(async () => { t.diagnostic(`恢复测试结束阶段：${stage}`); await h?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, () => []))
  stage = 'seed'
  await t.step(async () => h.residentStore.ingest(message('frozen-a', '@助手 请核对资料。')))
  const routed = await t.step(async () => h.residentStore.routeMessages({ groupId: 'native-group', routeId: 'frozen-route', routingRevision: 0,
    routes: [{ messageId: 'frozen-a', messageVersion: 1, topics: [{ newTopicKey: 'frozen', title: '资料核对' }] }] }))
  const topicId = routed.topicIdsByKey.frozen
  const basisUnitRefs = resolveTopicMessages(h.residentStore.getGroup('native-group'), topicId, 1).map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
  const accepted = await t.step(async () => h.residentStore.acceptTopicDecision({ groupId: 'native-group', topicId, revision: 1, decisionId: 'old-decision',
    decision: { basisMessageIds: ['frozen-a'], basisUnitRefs, actions: [], reply: '旧决定文本' } }))
  const outboundId = accepted.record.outboundId
  const refs = [{ topicId, revision: mode === 'revision-conflict' ? 2 : 1 }]
  const row = (await t.step(async () => h.service.store.command({ id: 'prepare-frozen', kind: 'notification.prepare', args: { notificationId: outboundId, kind: 'topic-reply', requirementRevision: 1,
    payload: { conversationId: 'native-group', topicRefs: refs, taskIds: mode === 'taskIds-conflict' ? ['unrelated-fixture-task'] : [], text: '冻结文本', sourceMessageId: 'frozen-a', actorId: 'native-user',
      replyToMessageId: 'frozen-a', replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'], fact: { topicRefs: refs } } } }))).result.notification
  if (mode === 'projected') {
    await t.step(async () => projectTaskNotification({ residentStore: h.residentStore, notification: row }))
    const projected = h.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === outboundId)
    assert.equal(projected.sourceMessageId, `task-notification:${outboundId}`)
    assert.equal(projected.decisionId, undefined)
  }
  stage = 'close first host'
  await t.step(async () => h.close())
  stage = 'reopen host'
  h = await t.step(async () => nativeTaskHost(root, () => [], { initialize: false }))
  stage = 'recover and service idle'
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  stage = 'wait notification outcome'
  if (mode === 'revision-conflict' || mode === 'taskIds-conflict') {
    await t.step(async () => waitUntil(() => h.service.listAlerts().some(item => item.alertId === `failure:${outboundId}` && item.detail === 'group_reply_frozen_identity_conflict'), '冻结身份冲突'))
    assert.equal((await t.step(() => h.query('notification.get', { notificationId: outboundId }))).state, 'prepared')
    assert.equal(h.sent.length, 0)
  } else {
    await t.step(async () => waitUntil(async () => (await h.query('notification.get', { notificationId: outboundId }))?.state === 'delivered', '原冻结通知送达'))
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].id, outboundId)
    assert.equal(h.sent[0].payload.text, '冻结文本')
    assert.equal(h.sent[0].payload.replyToMessageId, 'frozen-a')
    assert.equal(h.sent[0].payload.replyToSenderOpenDingTalkId, 'native-user')
    assert.deepEqual(h.sent[0].payload.atOpenDingTalkIds, ['native-user'])
  }
  const record = h.residentStore.getTopic('native-group', topicId).decisions.find(item => item.decisionId === 'old-decision')
  assert.deepEqual(record, accepted.record)
  assert.ok(h.service.listAlerts().some(item => item.alertId === 'failure:old-decision' && item.detail === 'LEGACY_DECISION_RECONCILIATION_REQUIRED'))
  const sentBefore = h.sent.length
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(h.sent.length, sentBefore)
  assert.deepEqual(h.residentStore.getTopic('native-group', topicId).decisions.find(item => item.decisionId === 'old-decision'), record)
  if (mode === 'revision-conflict' || mode === 'taskIds-conflict') {
    assert.equal((await t.step(() => h.query('notification.get', { notificationId: outboundId }))).state, 'prepared')
    assert.ok(h.service.listAlerts().some(item => item.alertId === `failure:${outboundId}` && item.detail === 'group_reply_frozen_identity_conflict'))
  } else assert.equal((await t.step(() => h.query('notification.get', { notificationId: outboundId }))).state, 'delivered')
}))

testRunner('native direct source routing preserves Task association, follow-up facts and replay idempotency', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'direct-source-task-native-'))
  const first = message('first', '@助手 检查指定文件，先承接并等待我补充资料。')
  const followup = message('followup', '@助手 再补充一条：只检查文件名称，不执行任何部署。')
  const factFeedback = message('fact-feedback', '我从原始材料里发现目标文件还有一个定位线索，补充给原检查。')
  const sourceIdFor = input => `im:${createHash('sha256').update(JSON.stringify([input.groupId, input.messageId, input.messageVersion ?? 1])).digest('hex')}`
  const firstSourceId = sourceIdFor(first)
  const followupSourceId = sourceIdFor(followup)
  const factSourceId = sourceIdFor(factFeedback)
  let h, triageDecisions = 0
  const ownerInputs = [], ownerRequests = []
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  t.onCancel(() => t.diagnostic(JSON.stringify({ requests: h?.requests.length, results: h?.toolResults.slice(-8).map(item => ({ name: item.name, error: item.result.error,
    accepted: item.result.value?.accepted, status: item.result.value?.status, sourceId: item.result.value?.sourceId, offset: item.result.value?.offset })) })))
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const input = latestInput(request)
      const values = modelToolValues(request)
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: ++triageDecisions !== 2, reply: null })]
      const newSourceIds = input.context?.newSourceIds ?? []
      if (!newSourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      if (newSourceIds.includes(firstSourceId)) return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds: newSourceIds,
        title: '原生文件检查', objective: '检查指定文件并等待补充', acceptanceCriteria: ['保留原始交办及后续补充'] }], continuity: [], reply: null })]
      const taskList = values.findLast(value => Array.isArray(value.tasks))
      if (!taskList) return [call('router_task_list', {})]
      const current = taskList.tasks.find(item => item.sourceRefs?.includes(firstSourceId))
      assert.ok(current, 'Router task directory must retain the original direct-source Task')
      const loaded = values.findLast(value => (value.task?.taskId ?? value.taskId) === current.taskId)
      if (!loaded) return [call('router_task_get', { taskId: current.taskId })]
      const taskState = loaded.task ?? loaded
      const sourceId = newSourceIds.find(id => id === followupSourceId || id === factSourceId)
      assert.ok(sourceId, 'new direct source must be the follow-up or unmentioned fact')
      const context = sourceId === followupSourceId
        ? '补充同一文件检查：只检查文件名称，不执行部署。'
        : '无点名事实补充：从原始材料发现目标文件的定位线索，纳入原检查。'
      return [call('router_submit', { actions: [{ kind: 'task-context', taskId: current.taskId, inputVersion: taskState.requirementRevision,
        runSequence: taskState.runSequence, expectedControlRevision: taskState.controlRevision, context, progressImpact: 'preserve', sourceIds: newSourceIds }], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) {
      const ownerInput = latestInput(request)
      ownerInputs.push(ownerInput)
      ownerRequests.push(request)
      const systemText = request.messages.filter(item => item.role === 'system').flatMap(item => item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      assert.ok(systemText.includes(groupReplyScopeInstructions), 'Task Owner keeps the group reply scope instructions')
      return [call('task_session_submit', { decision: { action: 'wait', summary: '原检查目标不变，已消费补充事实', evidence: [], limitations: [] } })]
    }
    throw new Error(`Unexpected direct Task tools: ${names.join(', ')}`)
  }))

  assert.equal((await t.step(async () => h.service.ingest(first))).accepted, true)
  await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list'))
  assert.ok(task)
  assert.equal(task.drained, true)
  assert.equal(task.lastDecision.action, 'wait')
  assert.deepEqual(task.topicRefs, [])
  const sources = await t.step(async () => h.query('source.list'))
  assert.equal(sources.length, 1)
  const firstSource = sources[0]
  assert.equal(firstSource.messageId, first.messageId)
  assert.equal(firstSource.version, first.messageVersion ?? 1)
  assert.equal(firstSource.actorId, first.senderOpenDingTalkId)
  assert.ok(firstSource.processingCompleted)
  assert.ok(task.sourceRefs.includes(firstSource.sourceId))
  assert.equal(task.ownerActorId, first.senderOpenDingTalkId)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal(ownerInputs.length, 1, 'the original Task Owner consumes the initial Task')
  const firstOwnerMessages = ownerRequests[0].messages
  const firstOwnerMessagesSnapshot = structuredClone(firstOwnerMessages)

  const noise = message('noise', '哈哈，今天午饭不错。')
  await t.step(async () => h.service.ingest(noise))
  await t.step(async () => h.service.whenIdle())
  const allSources = await t.step(async () => h.query('source.list'))
  const noiseSource = allSources.find(source => source.messageId === noise.messageId)
  const noiseTriage = h.residentStore.getRouterState('native-group').triage.find(item => item.sourceRef.sourceId === noiseSource.sourceId)
  assert.equal(noiseTriage.disposition.needsProcessing, false)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.ok(!(await t.step(async () => h.query('task.get', { taskId: task.taskId }))).sourceRefs.includes(noiseSource.sourceId))

  const beforeReplay = { requests: h.requests.length, sources: structuredClone(allSources), task: await t.step(async () => h.query('task.get', { taskId: task.taskId })) }
  await t.step(async () => h.service.ingest(first))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  assert.equal(triageDecisions, 2)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.deepEqual(await t.step(async () => h.query('source.list')), beforeReplay.sources)
  assert.deepEqual(await t.step(async () => h.query('task.get', { taskId: task.taskId })), beforeReplay.task)
  assert.equal(h.requests.length, beforeReplay.requests)

  const beforeFollowup = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  await t.step(async () => h.service.ingest(followup))
  await t.step(async () => h.service.whenIdle())
  const afterFollowup = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  const followupSource = (await t.step(async () => h.query('source.list'))).find(source => source.messageId === followup.messageId)
  assert.ok(followupSource.processingCompleted)
  assert.ok(afterFollowup.sourceRefs.includes(followupSource.sourceId))
  assert.equal(afterFollowup.drained, true)
  assert.equal(afterFollowup.lastDecision.action, 'wait')
  assert.equal(afterFollowup.requirementRevision, beforeFollowup.requirementRevision)
  assert.equal(afterFollowup.contextRevision, (beforeFollowup.contextRevision ?? 0) + 1)
  assert.equal(afterFollowup.controlRevision, beforeFollowup.controlRevision)
  assert.equal(afterFollowup.sessionId, beforeFollowup.sessionId)
  assert.equal(afterFollowup.runSequence, beforeFollowup.runSequence)
  assert.ok(ownerInputs.some(input => JSON.stringify(input).includes(followup.text)), 'a real Task Owner invocation must consume the follow-up source body')
  assert.deepEqual(firstOwnerMessages, firstOwnerMessagesSnapshot, 'later context updates do not mutate the original provider request messages')

  const beforeFact = structuredClone(afterFollowup)
  const sentBeforeFact = h.sent.length
  await t.step(async () => h.service.ingest(factFeedback))
  await t.step(async () => h.service.whenIdle())
  const afterFact = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  const factSource = (await t.step(async () => h.query('source.list'))).find(source => source.messageId === factFeedback.messageId)
  assert.ok(factSource.processingCompleted)
  assert.ok(afterFact.sourceRefs.includes(factSource.sourceId))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(afterFact.drained, true)
  assert.equal(afterFact.lastDecision.action, 'wait')
  assert.equal(afterFact.requirementRevision, beforeFact.requirementRevision)
  assert.equal(afterFact.contextRevision, (beforeFact.contextRevision ?? 0) + 1)
  assert.equal(afterFact.controlRevision, beforeFact.controlRevision)
  assert.equal(afterFact.sessionId, beforeFact.sessionId)
  assert.equal(afterFact.runSequence, beforeFact.runSequence)
  assert.ok(ownerInputs.some(input => JSON.stringify(input).includes(factFeedback.text)), 'a real Task Owner invocation must consume the unmentioned fact source body')
  assert.deepEqual(firstOwnerMessages, firstOwnerMessagesSnapshot, 'fact feedback does not mutate the original provider request messages')
  assert.equal(h.sent.length, sentBeforeFact, 'unmentioned fact feedback does not create an extra group confirmation')

  const settledTaskFacts = await t.step(async () => waitUntil(() => {
    const group = h.residentStore.getGroup('native-group')
    const router = h.residentStore.getRouterState('native-group')
    const facts = (group.routerFacts ?? []).map(item => item.fact).filter(fact => fact.taskId === task.taskId)
    const sameVersion = fact => ['requirementRevision', 'contextRevision', 'controlRevision', 'runSequence']
      .every(key => fact.taskVersion?.[key] === afterFact[key])
    const hasFinalDrain = facts.some(fact => fact.kind === 'drained' && sameVersion(fact))
    const decided = facts.every(fact => router.decisions.some(decision => decision.inputs?.some(input => input.kind === 'fact'
      && input.id === fact.factId && input.digest === fact.factDigest) && decision.applications.every(application => application.status === 'applied')))
    const pendingIds = new Set([...router.queue, ...(router.active?.inputs ?? [])].filter(input => input.kind === 'fact').map(input => input.id))
    if (!facts.length || !hasFinalDrain || !decided || facts.some(fact => pendingIds.has(fact.factId)) || router.active || router.queue.length) return false
    return facts.map(({ factId, factDigest }) => ({ factId, factDigest }))
  }, 'Task Router facts to reach durable decisions'))
  const beforeSettledReplay = {
    requests: h.requests.length,
    sources: structuredClone(await t.step(async () => h.query('source.list'))),
    task: structuredClone(await t.step(async () => h.query('task.get', { taskId: task.taskId }))),
    taskFacts: settledTaskFacts,
    sent: h.sent.length,
  }
  for (const replay of [first, followup, factFeedback]) await t.step(async () => h.service.ingest(replay))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  const settledAfterReplay = await t.step(async () => waitUntil(() => {
    const group = h.residentStore.getGroup('native-group')
    const router = h.residentStore.getRouterState('native-group')
    const facts = (group.routerFacts ?? []).map(item => item.fact).filter(fact => fact.taskId === task.taskId)
    const decided = facts.every(fact => router.decisions.some(decision => decision.inputs?.some(input => input.kind === 'fact'
      && input.id === fact.factId && input.digest === fact.factDigest) && decision.applications.every(application => application.status === 'applied')))
    return facts.length === beforeSettledReplay.taskFacts.length && decided && !router.active && router.queue.length === 0
      ? facts.map(({ factId, factDigest }) => ({ factId, factDigest })) : false
  }, 'replayed Task facts to remain durably settled'))
  const afterReplaySources = await t.step(async () => h.query('source.list'))
  assert.deepEqual(settledAfterReplay, beforeSettledReplay.taskFacts)
  assert.deepEqual(afterReplaySources, beforeSettledReplay.sources)
  assert.deepEqual(afterReplaySources.map(({ sourceId, stages }) => ({ sourceId, stages })),
    beforeSettledReplay.sources.map(({ sourceId, stages }) => ({ sourceId, stages })))
  assert.deepEqual(await t.step(async () => h.query('task.get', { taskId: task.taskId })), beforeSettledReplay.task)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(h.requests.length, beforeSettledReplay.requests, 'replaying routed sources after Task fact projection creates no new Router work')
  assert.equal(h.sent.length, beforeSettledReplay.sent)
  assert.equal(triageDecisions, 4)
}))

async function extraHost(t, prefix, decide) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, decide)
  return host
}

testRunner('direct Router rejects internal source IDs before Task/outbox commit and accepts the corrected same-turn reply', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const request = message('business-request-with-identities', '测试助手，核查 PR #253 与订单 SG18 的关联。')
  const context = message('business-context-with-identities', '订单背景资料仅供核查。')
  const sourceIdFor = item => `im:${createHash('sha256').update(JSON.stringify([item.groupId, item.messageId, 1])).digest('hex')}`
  const anchorId = sourceIdFor(request), contextId = sourceIdFor(context)
  assert.notEqual(anchorId, contextId)
  const publicText = '已安排核查 PR #253 与订单 SG18：https://example.com/orders/SG18'
  let host, invalidSubmitted = false, attempts = 0
  await t.beginBusiness()
  host = await t.step(async () => extraHost(t, 'direct-router-public-identities-', async (modelRequest, h) => {
    const names = modelRequest.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const input = latestInput(modelRequest)
      const values = modelToolValues(modelRequest)
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: input.sources[0].sourceId === anchorId, reply: null })]
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      assert.deepEqual(sourceIds, [anchorId])
      const sourceId = anchorId
      const contextPage = pages.find(item => item.sourceId === contextId && item.offset === 0)
      if (!contextPage) return [call('router_source_read', { sourceId: contextId, offset: 0 })]
      let contextOffset = 0
      while (contextOffset < contextPage.totalLength) {
        const page = pages.find(item => item.sourceId === contextId && item.offset === contextOffset)
        if (!page) return [call('router_source_read', { sourceId: contextId, offset: contextOffset })]
        contextOffset = page.nextOffset
      }
      const read = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
      if (!read) return [call('router_reply_review_get', { sourceId })]
      const review = { kind: 'confirmation', reviewedOutboundIds: read.candidates.map(item => item.outboundId),
        sameMatterOutboundIds: read.candidates.map(item => item.outboundId), replaceOutboundIds: read.candidates.map(item => item.outboundId) }
      if (invalidSubmitted) {
        const rejected = h.toolResults.filter(item => item.name === 'router_submit').at(-1)
        assert.ok(rejected?.result.isError || rejected?.result.error, 'the invalid router_submit must fail before the corrected turn')
        assert.ok(JSON.stringify(rejected.result).includes('GROUP_REPLY_INTERNAL_DETAILS'))
        assert.equal(h.residentStore.getRouterState('native-group').decisions.length, 0, 'invalid reply must not persist a Router decision')
        assert.equal((await h.query('task.list')).length, 0, 'invalid reply must not create the candidate Task')
        assert.equal(h.residentStore.getGroup('native-group').outbox.length, 0, 'invalid reply must not prepare an outbound')
        assert.equal((await h.query('notification.list')).length, 0, 'invalid reply must not prepare a notification')
        assert.equal(h.sent.length, 0, 'invalid reply must not send a group message')
        attempts++
        return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds, title: 'PR 与订单关联核查', objective: '核查 PR #253 与订单 SG18 的关联' }],
          continuity: [], reply: { sourceId, text: publicText, review } })]
      }
      assert.equal(h.residentStore.getRouterState('native-group').decisions.length, 0)
      assert.equal((await h.query('task.list')).length, 0)
      assert.equal(h.residentStore.getGroup('native-group').outbox.length, 0)
      assert.equal((await h.query('notification.list')).length, 0)
      assert.equal(h.sent.length, 0)
      invalidSubmitted = true
      attempts++
      return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds, title: 'PR 与订单关联核查', objective: '核查 PR #253 与订单 SG18 的关联' }],
        continuity: [], reply: { sourceId, text: `已安排核查 ${contextId} 对应事项。`, review } })]
    }
    if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'wait', summary: '等待实际核验结果', evidence: [], limitations: [] } })]
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  }))

  await t.step(async () => host.service.ingest(context))
  await t.step(async () => waitUntil(async () => (await host.query('source.list')).some(item => item.sourceId === contextId && item.processingCompleted), '背景来源完成首筛'))
  await t.step(async () => host.service.ingest(request))
  await t.step(async () => host.service.whenIdle())
  await t.step(async () => waitUntil(async () => {
    const state = host.residentStore.getRouterState('native-group')
    const source = (await host.query('source.list')).find(item => item.messageId === request.messageId)
    const decision = state.decisions.find(item => item.inputs?.some(input => input.kind === 'source' && input.sourceRef.messageId === request.messageId))
    const reply = decision?.applications.find(item => item.kind === 'reply')
    const notification = reply?.receipt?.notificationId && await host.query('notification.get', { notificationId: reply.receipt.notificationId })
    return attempts === 2 && reply?.status === 'applied' && notification?.state === 'delivered' && source?.processingCompleted && (await host.query('task.list')).length === 1
      && host.sent.filter(item => item.id === notification.id && item.payload.text === publicText).length === 1
  }, 'corrected Router reply and new Task to apply'))
  const source = (await t.step(async () => host.query('source.list'))).find(item => item.messageId === request.messageId)
  const task = (await t.step(async () => host.query('task.list')))[0]
  const decision = host.residentStore.getRouterState('native-group').decisions.find(item => item.inputs?.some(input => input.kind === 'source' && input.sourceRef.messageId === request.messageId))
  const rejected = host.toolResults.filter(item => item.name === 'router_submit' && JSON.stringify(item.result).includes('GROUP_REPLY_INTERNAL_DETAILS'))
  assert.equal(attempts, 2)
  assert.equal(rejected.length, 1)
  assert.equal(host.residentStore.getRouterState('native-group').decisions.length, 1)
  assert.equal(decision.applications.filter(item => item.status === 'applied').length, 2)
  assert.equal(task.sourceRefs.includes(source.sourceId), true)
  assert.deepEqual(task.topicRefs, [])
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
  const sentReply = host.sent.find(item => item.payload.text === publicText)
  assert.ok(sentReply)
  assert.equal(sentReply.payload.sourceMessageId, request.messageId)
}))

testRunner('direct Router explicit requester remains the Task and completion-notification owner', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const discussion = message('colleague-discussion', '我们正在讨论文件检查，稍后请负责人确认。')
  const handoff = message('explicit-handoff', '@测试助手 请完成上述文件检查并告诉我结论。')
  let h
  await t.beginBusiness()
  h = await t.step(async () => extraHost(t, 'direct-task-owner-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      const sourceTexts = new Map((input.sources ?? []).map(source => [source.sourceId, pages.filter(page => page.sourceId === source.sourceId)
        .sort((a, b) => a.offset - b.offset).map(page => page.text).join('')]))
      if (names.includes('triage_submit')) {
        return [call('triage_submit', { needsProcessing: [...sourceTexts.values()].some(text => text.includes('@测试助手')), reply: null })]
      }
      const fact = input.context?.facts?.find(item => item.kind === 'completed')
      if (fact) {
        const sourceId = fact.sourceIds[0]
        const reviewed = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
        if (!reviewed) return [call('router_reply_review_get', { sourceId })]
        return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '文件检查已完成，结论已核验。',
          review: { kind: 'substantive', reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
      }
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      assert.ok(sourceIds.some(id => sourceTexts.get(id)?.includes('@测试助手')), 'only explicit handoff source authorizes a Task')
      return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds, title: '文件检查交接', objective: '确认文件检查已完成并向明确交办人报告结论' }], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'complete', summary: '文件检查已完成，结论已核验。', evidence: ['已核对本轮原始交办'], limitations: [] } })]
    throw new Error(`Unexpected direct Task tools: ${names.join(', ')}`)
  }))

  await t.step(async () => h.service.ingest({ ...discussion, senderOpenDingTalkId: 'native-colleague', senderName: '同事' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  const handoffResult = await t.step(async () => h.service.ingest(handoff))
  await t.step(async () => h.service.whenIdle())
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.status, 'completed')
  assert.equal(task.ownerActorId, 'native-user')
  assert.ok(task.sourceRefs.includes(handoffResult.sourceId))
  assert.deepEqual(task.topicRefs, [])
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  const completion = await t.step(async () => waitUntil(async () => (await h.query('notification.list'))
    .find(item => item.payload.text === '文件检查已完成，结论已核验。' && item.state === 'delivered'), '完成事实回复已送达'))
  const decision = h.residentStore.getRouterState('native-group').decisions.find(item => item.inputs.some(input => input.kind === 'fact')
    && item.applications.some(application => application.kind === 'reply' && application.receipt?.notificationId === completion.id))
  assert.ok(decision, '完成通知必须来自实际 Task 事实对应的 Router 决议')
  assert.equal(completion.payload.sourceMessageId, handoff.messageId)
  assert.equal(completion.payload.replyToMessageId, handoff.messageId)
  assert.equal(completion.payload.replyToSenderOpenDingTalkId, 'native-user')
  assert.deepEqual(completion.payload.atOpenDingTalkIds, ['native-user'])
  assert.ok(h.sent.some(item => item.id === completion.id && item.payload.atOpenDingTalkIds.includes('native-user')))
}))

for (const committed of [false, true]) testRunner(`replan fences an execution claim ${committed ? 'after commit' : 'before commit'}`, { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'execution-claim-gate-'))
  const gate = Promise.withResolvers()
t.onCancel(() => gate.resolve())

  let host, store, entered = false, revised = false, ownerDone = false, claimError, current, claims = 0, executionRuns = 0, cancels = 0, ownerRuns = 0
  const sessions = {
    async run({ delegate, submit }) {
      ownerRuns++
      if (ownerRuns === 1) await delegate({ key: 'first', objective: '检查隔离测试' })
      await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] })
      if (ownerRuns === 1) ownerDone = true
      return { status: 'submitted' }
    },
    async cancel() {}, async close() {},
  }
  const executionSessions = {
    async run({ binding }) { executionRuns++; current = await store.query({ kind: 'execution.current', binding }); return { status: 'stale' } },
    async cancel() { cancels++ }, async feedback() {}, async close() {},
  }
  t.after(async () => { gate.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      if (request.kind === 'execution.claim') { claims++; if (!committed) { entered = true; await gate.promise } }
      let result
      try { result = await store.command(request) } catch (error) { if (request.kind === 'execution.claim') claimError = error.code ?? error.message; throw error }
      if (request.kind === 'execution.claim' && committed) { entered = true; await gate.promise }
      if (request.kind === 'task.revise') revised = true
      return result
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions, executionSessions })
  } }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'claim-create', title: '领取竞态', objective: '检查任务' }))
  await t.step(async () => waitUntil(() => entered && ownerDone, '旧 execution claim 与 Owner 已到达门闩', 10000))
  await t.step(async () => waitUntil(async () => (await host.query('task.get', { taskId: task.taskId })).drained, '旧 Owner 已排空', 5000))
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  let accepted = false
  const pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'claim-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '更新要求' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(() => revised, '任务修订已提交', 5000))
  if (committed) await t.step(async () => waitUntil(() => cancels === 1, '已领取 execution 已收到取消', 5000))
  assert.equal(accepted, false)
  assert.equal(claims, 1)
  gate.resolve()
  await t.step(async () => pending)
  await t.step(async () => host.service.whenIdle())
  if (committed) { assert.equal(executionRuns, 1); assert.equal(current, false) }
  else { assert.equal(executionRuns, 0); assert.equal(claimError, 'DYNAMIC_EXECUTION_BUSY') }
  assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).requirementRevision, before.requirementRevision + 1)
  assert.equal(ownerRuns, 2)
}))

testRunner('concurrent same-task revisions honor CAS while another task makes progress', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-admission-isolation-'))
  const gate = Promise.withResolvers()
t.onCancel(() => gate.resolve())

  let host, store, entered = false, block = false
  const ownerRuns = new Map()
  const sessions = { async run({ binding, submit }) { ownerRuns.set(binding.taskId, (ownerRuns.get(binding.taskId) ?? 0) + 1); await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } }, async cancel() {}, async close() {} }
  t.after(async () => { gate.resolve(); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      if (block && request.kind === 'task.revise' && !entered) { entered = true; await gate.promise }
      return store.command(request)
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
  } }))
  const first = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'serial-create', title: '任务一', objective: '检查任务一' }))
  await t.step(async () => host.residentStore.subscribe({ groupId: 'independent-group', name: '独立群', responsibility: '隔离测试' }))
  const second = await t.step(async () => host.service.createTask({ groupId: 'independent-group', requestId: 'independent-create', title: '任务二', objective: '检查任务二' }))
  await t.step(async () => host.service.whenIdle())
  const a = await t.step(async () => host.query('task.get', { taskId: first.taskId })), b = await t.step(async () => host.query('task.get', { taskId: second.taskId }))
  const params = { taskId: first.taskId, progressImpact: 'replan', expectedRequirementRevision: a.requirementRevision, expectedControlRevision: a.controlRevision }
  block = true
  const pending = host.service.appendTaskContext({ ...params, requestId: 'serial-first', context: '第一条变更' })
  await t.step(async () => waitUntil(() => entered, '第一任务修订进入门闩', 5000))
  const duplicateRevision = host.service.appendTaskContext({ ...params, requestId: 'serial-second', context: '第二条变更' }).then(value => ({ value }), error => ({ error }))
  const independent = await t.step(async () => host.service.appendTaskContext({ taskId: second.taskId, requestId: 'independent-replan', progressImpact: 'replan',
    expectedRequirementRevision: b.requirementRevision, expectedControlRevision: b.controlRevision, context: '独立任务变更' }))
  assert.equal(independent.taskId, second.taskId)
  assert.equal((await t.step(async () => host.query('task.get', { taskId: first.taskId }))).requirementRevision, a.requirementRevision)
  assert.equal(ownerRuns.get(first.taskId), 1)
  gate.resolve()
  await t.step(async () => pending)
  const result = await t.step(async () => duplicateRevision)
  assert.ok(result.error)
  assert.equal(result.error.code, 'DYNAMIC_TASK_REVISION_STALE')
  await t.step(async () => host.service.whenIdle())
  assert.equal((await t.step(async () => host.query('task.get', { taskId: first.taskId }))).requirementRevision, a.requirementRevision + 1)
  assert.equal((await t.step(async () => host.query('task.get', { taskId: second.taskId }))).requirementRevision, b.requirementRevision + 1)
  assert.equal(ownerRuns.get(first.taskId), 2)
  assert.equal(ownerRuns.get(second.taskId), 2)
}))

testRunner('failed direct Task owner cancellation preserves the Web request for an exact retry before later work', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'old-drain-failure-'))
  let host, cancelAttempts = 0, runs = 0
  const ownerStarted = Promise.withResolvers(), releaseOwner = Promise.withResolvers()
  const sessions = {
    async run({ submit }) {
      runs++
      if (runs === 1) { ownerStarted.resolve(); await releaseOwner.promise; return { status: 'cancelled' } }
      await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] })
      return { status: 'submitted' }
    },
    async cancel() { if (++cancelAttempts === 1) throw Object.assign(new Error('fixture cancel failed'), { code: 'FIXTURE_CANCEL_FAILED' }); releaseOwner.resolve() },
    async close() { releaseOwner.resolve() },
  }
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: args => openTaskSessionService({ ...args, taskSessions: sessions }),
  }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'drain-create', title: '排空测试', objective: '检查排空' }))
  await t.step(async () => ownerStarted.promise)
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const request = { taskId: task.taskId, requestId: 'drain-replan', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '排空失败后补充' }
  await t.step(async () => assert.rejects(host.service.appendTaskContext(request), /fixture cancel failed/))
  assert.equal(cancelAttempts, 1)
  const failedSource = (await t.step(async () => host.query('source.list'))).find(item => item.text === request.context)
  assert.ok(failedSource)
  assert.equal(failedSource.requestIdentity.request.args.requestId, request.requestId)
  assert.equal(failedSource.requestIdentity.action.kind, 'task-context')
  assert.equal(failedSource.requestIdentity.action.taskId, task.taskId)
  assert.notEqual(failedSource.routed, true)
  await t.step(async () => assert.rejects(host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-busy', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '过期版本不得覆盖原请求' }), { code: 'DYNAMIC_TASK_REVISION_STALE' }))
  const retried = await t.step(async () => host.service.appendTaskContext(request))
  assert.equal(retried.taskId, task.taskId)
  assert.equal(cancelAttempts, 2)
  await t.step(async () => host.service.whenIdle())
  const recoveredSource = (await t.step(async () => host.query('source.list'))).find(item => item.sourceId === failedSource.sourceId)
  assert.deepEqual(recoveredSource.requestIdentity, failedSource.requestIdentity)
  assert.equal(recoveredSource.routed, true)
  assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).requirementRevision, before.requirementRevision + 1)
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
  const current = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const later = await t.step(async () => host.service.appendTaskContext({ taskId: task.taskId, requestId: 'drain-later', progressImpact: 'replan',
    expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision, context: '稍后继续处理' }))
  assert.equal(later.taskId, task.taskId)
  await t.step(async () => host.service.whenIdle())
  assert.ok(runs >= 3)
}))

testRunner('Web material failure recovers once and retries the same request without repeating work', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-material-recovery-'))
  let host, store, target, runs = 0, injected = false, restarting = false
  const sessions = {
    async run({ submit }) { runs++; await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] }); return { status: 'submitted' } },
    async cancel() {}, async close() {},
  }
  t.after(async () => { await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  const options = { serviceFactory: async args => {
    store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: !restarting, webActorId: args.config.webActorId })
    const proxy = { ...store, async command(request) {
      const result = await store.command(request)
      if (request.kind === 'task.revise' && !injected) {
        injected = true
        const task = result.result.task, sourceId = task.sourceRefs.at(-1)
        const directories = await taskDirectories(root, task.taskId, { create: true })
        const digest = createHash('sha256').update(JSON.stringify(sourceId)).digest('hex').slice(0, 32)
        target = join(directories.materials, `source-${digest}.json`)
        await mkdir(target)
      }
      return result
    } }
    return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
  } }
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'material-create', title: '材料检查', objective: '检查材料' }))
  await t.step(async () => host.service.whenIdle())
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  const request = { taskId: task.taskId, requestId: 'material-revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision,
    expectedControlRevision: before.controlRevision, context: '更新检查要求' }
  await t.step(async () => assert.rejects(host.service.appendTaskContext(request), /TASK_MATERIAL_PATH_INVALID/))
  await t.step(async () => host.service.whenIdle())
  const revised = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  assert.equal(revised.requirementRevision, before.requirementRevision + 1)
  assert.equal(runs, 1)
  const failedSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === request.context)
  assert.ok(failedSource.sourceId.startsWith('web:'))
  assert.equal(failedSource.requestIdentity.request.args.requestId, request.requestId)
  assert.equal(failedSource.requestIdentity.action.kind, 'task-context')
  assert.equal(failedSource.requestIdentity.action.taskId, task.taskId)
  assert.ok(failedSource.requestIdentity.action.sourceRefs.includes(failedSource.sourceId))
  assert.equal(failedSource.requestIdentity.action.topicRefs, undefined)
  assert.notEqual(failedSource.routed, true)
  assert.equal(failedSource.processingCompleted, undefined)
  await t.step(async () => host.close()); await t.step(async () => store.close()); host = undefined; store = undefined
  await t.step(async () => rmdir(target))
  restarting = true
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options))
  const reordered = { context: request.context, expectedControlRevision: request.expectedControlRevision, expectedRequirementRevision: request.expectedRequirementRevision,
    progressImpact: request.progressImpact, requestId: request.requestId, taskId: request.taskId }
  assert.equal((await t.step(async () => host.service.appendTaskContext(reordered))).taskId, task.taskId)
  await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
  assert.equal(JSON.parse(await t.step(async () => readFile(target, 'utf8'))).taskId, task.taskId)
  assert.equal(runs, 2)
  assert.equal((await t.step(async () => host.service.appendTaskContext(reordered))).taskId, task.taskId)
  const recoveredSource = (await t.step(async () => host.query('source.list'))).find(source => source.sourceId === failedSource.sourceId)
  assert.deepEqual(recoveredSource.requestIdentity, failedSource.requestIdentity)
  assert.equal(recoveredSource.routed, true)
  assert.equal(host.residentStore.listTopics('native-group').length, 0)
  await t.step(async () => assert.rejects(host.service.appendTaskContext({ ...reordered, context: '不同内容' }), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' }))
  await t.step(async () => host.service.whenIdle())
  assert.equal((await t.step(async () => host.query('task.get', { taskId: task.taskId }))).requirementRevision, revised.requirementRevision)
  assert.equal(runs, 2)
}))

testRunner('Web replan blocks a new Owner while old-generation cancellation is in flight', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const releaseQuery = Promise.withResolvers(), releaseNew = Promise.withResolvers(), releaseOld = Promise.withResolvers()
  t.onCancel(() => { releaseQuery.resolve(); releaseNew.resolve(); releaseOld.resolve() })

  let host, store, pending, intercept = false, blocked = false, runs = 0, accepted = false, started = false
  const cancellations = []
  const sessions = {
    async run({ submit }) {
      runs++
      if (runs === 1) {
        await submit({ action: 'wait', summary: '等待输入', evidence: [], limitations: [] })
        await releaseOld.promise
        return { status: 'submitted' }
      }
      started = true
      await releaseNew.promise
      await submit({ action: 'wait', summary: '等待补充', evidence: [], limitations: [] })
      return { status: 'submitted' }
    },
    async cancel(taskId) { cancellations.push({ taskId, runs }); releaseOld.resolve() },
    async close() { releaseOld.resolve(); releaseNew.resolve() },
  }
  const root = await mkdtemp(join(tmpdir(), 'web-replan-query-gate-'))
  t.after(async () => { releaseQuery.resolve(); releaseNew.resolve(); releaseOld.resolve(); await pending?.catch(() => {}); await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: async args => {
      store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
      const proxy = { ...store,
        async command(request) {
          const result = await store.command(request)
          if (request.kind === 'task.revise') intercept = true
          return result
        },
        async query(request) {
          if (intercept && !blocked && request.kind === 'execution.list' && request.taskId) {
            blocked = true
            await releaseQuery.promise
          }
          return store.query(request)
        },
      }
      return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
    },
  }))
  const task = await t.step(async () => host.service.createTask({ groupId: 'native-group', requestId: 'query-gate-create', title: '检查文件', objective: '检查文件' }))
  await t.step(async () => waitUntil(() => runs === 1, '旧 Owner 已启动', 5000))
  const before = await t.step(async () => host.query('task.get', { taskId: task.taskId }))
  pending = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'query-gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: '新增文件名称检查' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(() => blocked, 'execution.list 门闩已进入', 5000))
  await t.step(async () => new Promise(resolve => setImmediate(resolve)))
  assert.equal(runs, 1, '旧代取消边界未完成时不能启动新 Owner')
  assert.equal(accepted, false)
  const pendingSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === '新增文件名称检查')
  const pendingDrain = pendingSource?.stages?.find(stage => stage.stage === 'host' && stage.phase === 'old-drain')
  assert.equal(pendingDrain?.completedAt, null, '排空仍被门闩阻塞时必须保持 open')
  assert.equal(pendingDrain.quality, 'open')
  await t.step(async () => assert.rejects(host.service.store.command({ id: 'invalid-host-phase', kind: 'source.stage', args: { sourceId: pendingSource.sourceId,
    stage: { spanId: 'invalid-host-phase', stage: 'host', phase: 'unknown', requestId: 'fixture', attempt: 0, startedAt: new Date().toISOString() } } }),
  { code: 'DYNAMIC_SOURCE_STAGE_INVALID' }))
  releaseQuery.resolve()
  await t.step(async () => waitUntil(() => started, '新 Owner 已启动', 5000))
  await t.step(async () => waitUntil(() => accepted, '新 Owner 未结束时接纳应返回', 5000))
  assert.deepEqual(cancellations.map(item => item.runs), [1], '新 Owner 不得被旧代取消')
  assert.equal((await t.step(async () => pending)).taskId, task.taskId)
  const revisedSource = (await t.step(async () => host.query('source.list'))).find(source => source.text === '新增文件名称检查')
  const stages = revisedSource?.stages?.filter(stage => stage.stage === 'host') ?? []
  const phases = ['task-commit', 'old-drain', 'materialize'].map(phase => stages.find(stage => stage.phase === phase))
  const overall = stages.find(stage => !stage.phase && phases.every(phase => phase?.requestId === stage.requestId))
  assert.ok(overall?.completedAt, 'Host 总阶段必须有真实终止时间')
  for (const phase of phases) {
    assert.ok(phase?.completedAt && phase.quality === 'observed')
    assert.ok(Date.parse(overall.startedAt) <= Date.parse(phase.startedAt))
    assert.ok(Date.parse(phase.startedAt) <= Date.parse(phase.completedAt))
    assert.ok(Date.parse(phase.completedAt) <= Date.parse(overall.completedAt))
  }
  for (let index = 1; index < phases.length; index++) assert.ok(Date.parse(phases[index - 1].completedAt) <= Date.parse(phases[index].startedAt))
  releaseNew.resolve()
  await t.step(async () => host.service.whenIdle())
}))

testRunner('Web replan drains the old Owner without waiting for the new Owner', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const oldEntered = Promise.withResolvers(), releaseOld = Promise.withResolvers()
t.onCancel(() => releaseOld.resolve())

  const newEntered = Promise.withResolvers(), releaseNew = Promise.withResolvers()
t.onCancel(() => releaseNew.resolve())

  let turns = 0, accepted = false, newFinished = false
  t.after(() => { releaseOld.resolve(); releaseNew.resolve() })
  const h = await extraHost(t, 'web-replan-owner-gates-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    if (++turns === 1) { oldEntered.resolve(); await releaseOld.promise }
    else { newEntered.resolve(); await releaseNew.promise; newFinished = true }
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待补充', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'gate-create', title: '检查文件', objective: '检查文件并等待补充' }))
  await t.step(async () => oldEntered.promise)
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  const pending = h.service.appendTaskContext({ taskId: created.taskId, requestId: 'gate-replan', progressImpact: 'replan',
    expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision, context: '补充检查文件名称' }).then(value => { accepted = true; return value })
  await t.step(async () => waitUntil(async () => (await h.query('task.get', { taskId: created.taskId })).requirementRevision > original.requirementRevision, 'replan 已提交', 5000))
  assert.equal(accepted, false, '旧 Owner 尚未排空时不能接纳')
  releaseOld.resolve()
  await t.step(async () => newEntered.promise)
  await t.step(async () => waitUntil(() => accepted, '新 Owner 尚未结束时接纳应返回', 5000))
  assert.equal(newFinished, false)
  const result = await t.step(async () => pending)
  assert.equal(result.taskId, created.taskId)
  releaseNew.resolve()
  await t.step(async () => h.service.whenIdle())
}))

testRunner('native Web Task edits reject stale requirement and control revisions without changing the Task', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const h = await extraHost(t, 'task-topic-web-stale-', async request => {
    assert.ok(request.tools.some(tool => tool.name === 'task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续补充', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'web-create', title: 'Web 文件检查', objective: '检查文件并等待补充' }))
  await t.step(async () => h.service.whenIdle())
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(original.requirementRevision, 1)
  await t.step(async () => h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '新增文件名称检查要求' }))
  await t.step(async () => h.service.whenIdle())
  const revised = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(revised.requirementRevision, 2)
  assert.deepEqual(h.residentStore.listTopics('native-group'), [], 'Web Task edits do not depend on a Topic side record')
  const topicSnapshot = JSON.stringify(h.residentStore.listTopics('native-group'))
  await t.step(async () => assert.rejects(h.service.appendTaskContext({ taskId: created.taskId, requestId: 'web-stale-append', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: original.controlRevision, context: '这条过期补充必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' }))
  await t.step(async () => assert.rejects(h.service.cancelTask({ taskId: created.taskId, requestId: 'web-stale-cancel', expectedRequirementRevision: revised.requirementRevision,
    expectedControlRevision: revised.controlRevision - 1, reason: '过期控制版本必须拒绝' }), { code: 'DYNAMIC_TASK_REVISION_STALE' }))
  const unchanged = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(unchanged.requirementRevision, revised.requirementRevision)
  assert.equal(unchanged.controlRevision, revised.controlRevision)
  assert.equal(unchanged.control, revised.control)
  assert.equal(unchanged.request, revised.request)
  assert.equal(JSON.stringify(h.residentStore.listTopics('native-group')), topicSnapshot)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
}))

testRunner('direct routing leaves business notices and named colleagues without Task or assistant replies', { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async t => {
  const h = await extraHost(t, 'direct-business-notice-context-', async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    const missing = missingSourceRead(request, latestInput(request))
    if (missing) return [call('router_source_read', missing)]
    if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: false, reply: null })]
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  await t.step(async () => h.residentStore.updateGroup({ groupId: 'native-group', personAliases: [{ alias: '小甲', name: '测试成员甲' }] }))
  const texts = [
    ['lci-start', 'LCI 单位缺失问题正在讨论'],
    ['notice-423', '@测试成员乙 @测试成员丙 已修复 LCI 单位缺失并发布测试环境'],
    ['notice-424', '@测试成员丁 LCI 任务已创建，开始处理。任务codex:example — 另一测试助手'],
    ['named-owner', '后续 LCI 验收交给测试成员乙处理'],
    ['named-reference', '看小甲发的应该是这样吧'],
  ]
  for (const [messageId, text] of texts) {
    await t.step(async () => h.service.ingest(message(messageId, text)))
    await t.step(async () => h.service.whenIdle())
  }
  const sources = await t.step(async () => h.query('source.list'))
  assert.deepEqual(sources.map(source => source.messageId), texts.map(([id]) => id))
  assert.ok(sources.every(source => source.processingCompleted))
  assert.equal(h.residentStore.getRouterState('native-group').decisions.length, 0)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal(h.sent.length, 0)
  const before = structuredClone(sources)
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.deepEqual(await t.step(async () => h.query('source.list')), before)
  assert.equal(h.sent.length, 0)
}))

// Prompt assertions check the guidance delivered to the model. Scripted choices
// below verify the real context/action pipeline, not free-running model semantics.
testRunner('direct Router aggregates screenshots and acceptance additions into the original Task', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  const initial = '测试助手，请把资料列表按更新时间倒序，并增加标题关键字筛选，作为本轮列表优化一起交付。'
  const inputs = [['list-work', initial], ['screenshot-delivery', '这轮列表优化完成后，请附上验收通过的截图。'], ['acceptance-addition', '再补一项验收：筛选没有匹配项时显示空状态。']]
  const initialCriteria = ['记录按更新时间倒序', '标题关键字筛选生效']
  const extraCriteria = { 'screenshot-delivery': '交付验收通过的截图', 'acceptance-addition': '筛选无匹配项时显示空状态' }
  const sourceIdFor = input => `im:${createHash('sha256').update(JSON.stringify([input.groupId, input.messageId, input.messageVersion ?? 1])).digest('hex')}`
  const sourceIds = Object.fromEntries(inputs.map(([id, text]) => [id, sourceIdFor(message(id, text))]))
  const ownerInputs = []
  let taskId
  const h = await extraHost(t, 'direct-matter-aggregation-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const newSourceIds = input.context?.newSourceIds ?? []
      if (!newSourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      if (newSourceIds.includes(sourceIds['list-work'])) return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds: newSourceIds,
        title: '资料列表优化', objective: initial, acceptanceCriteria: initialCriteria }], continuity: [], reply: null })]
      const list = values.findLast(value => Array.isArray(value.tasks))
      if (!list) return [call('router_task_list', {})]
      const taskSummary = list.tasks.find(task => task.sourceRefs?.includes(sourceIds['list-work']))
      assert.ok(taskSummary)
      const loaded = values.findLast(value => (value.task?.taskId ?? value.taskId) === taskSummary.taskId)
      if (!loaded) return [call('router_task_get', { taskId: taskSummary.taskId })]
      const task = loaded.task ?? loaded
      const currentSourceId = newSourceIds.at(-1), messageId = inputs.find(([id]) => sourceIds[id] === currentSourceId)?.[0]
      assert.ok(messageId && extraCriteria[messageId])
      const acceptanceCriteria = [...new Set([...(task.requirements ?? []), extraCriteria[messageId]])]
      return [call('router_submit', { actions: [{ kind: 'task-context', taskId: task.taskId, inputVersion: task.requirementRevision,
        runSequence: task.runSequence, expectedControlRevision: task.controlRevision, context: inputs.find(([id]) => id === messageId)[1],
        progressImpact: 'replan', acceptanceCriteria, sourceIds: newSourceIds }], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) {
      ownerInputs.push(latestInput(request))
      return [call('task_session_submit', { decision: { action: 'wait', summary: '等待测试资料', evidence: [], limitations: [] } })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  for (const [messageId, text] of inputs) {
    await t.step(async () => h.service.ingest(message(messageId, text)))
    await t.step(async () => h.service.whenIdle())
    const tasks = await t.step(async () => h.query('task.list'))
    assert.equal(tasks.length, 1)
    taskId ??= tasks[0].taskId
    assert.equal(tasks[0].taskId, taskId)
  }
  const [task] = await t.step(async () => h.query('task.list'))
  assert.equal(task.requirementRevision, 3)
  assert.equal(task.objective, initial)
  assert.deepEqual(task.requirements, [...initialCriteria, ...Object.values(extraCriteria)])
  assert.ok(inputs.every(([id]) => task.sourceRefs.includes(sourceIds[id])))
  assert.deepEqual(task.topicRefs, [])
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.ok(inputs.every(([, text]) => ownerInputs.some(ownerInput => JSON.stringify(ownerInput).includes(text))), 'the same Task Owner consumes each follow-up body')
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
}))

testRunner('direct Router reevaluates responsibility and does not inherit an old matter classification', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  let technicalDecisions = 0
  const technical = '另外资料列表保存报错，测试成员乙负责排查。'
  const h = await extraHost(t, 'direct-router-scope-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      const sourceText = (input.sources ?? []).map(source => pages.filter(page => page.sourceId === source.sourceId)
        .sort((a, b) => a.offset - b.offset).map(page => page.text).join('')).join('\n')
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: sourceText.includes(technical), reply: null })]
      technicalDecisions++
      return [call('router_submit', { actions: [], continuity: [], reply: null })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  await t.step(async () => h.residentStore.updateGroup({ groupId: 'native-group', responsibility: '负责业务系统技术问题排查及实现' }))
  const sources = [
    message('expense-origin', '差旅报销单的电子票据请由同事统一上传。'),
    { ...message('expense-followup', '旧附件已删除，请统一上传。'), quotedMessage: { messageId: 'expense-origin', content: '电子票据请统一上传' } },
    message('expense-short', '试试'),
    message('mixed-followup', '可以了。' + technical),
  ]
  for (const source of sources) { await t.step(async () => h.service.ingest(source)); await t.step(async () => h.service.whenIdle()) }
  await t.step(async () => waitUntil(async () => technicalDecisions === 1
    && (await h.query('source.list')).filter(source => source.processingCompleted).length === sources.length
    && h.residentStore.getRouterState('native-group').decisions.length === 1, '技术来源路由完成'))
  assert.equal(technicalDecisions, 1, 'the technical issue is independently reconsidered, while the colleague assignment requires no assistant action')
  const processed = await t.step(async () => h.query('source.list'))
  assert.deepEqual(processed.map(source => source.messageId), sources.map(source => source.messageId))
  assert.ok(processed.every(source => source.processingCompleted))
  assert.equal(h.residentStore.getRouterState('native-group').decisions.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal(h.sent.length, 0)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
}))

testRunner('direct Router keeps distinct delivery goals from one message as separate Tasks',
  { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async t => {
    const parts = ['资料列表的检索体验优化单独排期；', '同一资料列表的权限风险另做审计报告。']
    const source = message('independent-page-work', parts.join(''))
    const sourceId = `im:${createHash('sha256').update(JSON.stringify([source.groupId, source.messageId, source.messageVersion ?? 1])).digest('hex')}`
    const h = await extraHost(t, 'direct-independent-page-matters-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
      if (names.includes('triage_submit') || names.includes('router_submit')) {
        const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
        for (const item of input.sources ?? []) {
          let offset = 0
          while (offset < item.totalLength) {
            const page = pages.find(value => value.sourceId === item.sourceId && value.offset === offset)
            if (!page) return [call('router_source_read', { sourceId: item.sourceId, offset })]
            offset = page.nextOffset
          }
        }
        if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
        const sourceIds = input.context?.newSourceIds ?? []
        if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
        assert.ok(sourceIds.includes(sourceId))
        return [call('router_submit', { actions: [
          { kind: 'new-task', sourceIds: [sourceId], title: '检索体验优化', objective: '独立排期并交付资料列表检索体验优化' },
          { kind: 'new-task', sourceIds: [sourceId], title: '权限风险审计', objective: '单独完成资料列表权限风险审计报告' },
        ], continuity: [], reply: null })]
      }
      if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'wait', summary: '等待事项资料', evidence: [], limitations: [] } })]
      throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
    })
    await t.beginBusiness()

    await t.step(async () => h.service.ingest(source)); await t.step(async () => h.service.whenIdle())
    const tasks = await t.step(async () => h.query('task.list'))
    assert.deepEqual(tasks.map(task => task.title).sort(), ['检索体验优化', '权限风险审计'].sort())
    assert.deepEqual(tasks.map(task => task.objective).sort(), ['独立排期并交付资料列表检索体验优化', '单独完成资料列表权限风险审计报告'].sort())
    assert.ok(tasks.every(task => task.sourceRefs.includes(sourceId)))
    assert.equal(new Set(tasks.map(task => task.taskId)).size, 2)
    assert.equal(h.residentStore.listTopics('native-group').length, 0)
    assert.equal(h.sent.length, 0)
  }))

testRunner('direct Router accepts a requirement that only mentions notification recipients', { ...({ timeout: 20000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const assignment = '测试助手，列表功能的明确展示需求由你实现，测试成员甲和测试成员乙接收同步。'
  const requirement = '@测试成员甲 @测试成员乙 状态列需要显示等待中的记录。'
  const sourceId = id => `im:${createHash('sha256').update(JSON.stringify(['native-group', id, 1])).digest('hex')}`
  const assignmentId = sourceId('assignment'), requirementId = sourceId('requirement')
  let historyRead = false
  const h = await extraHost(t, 'direct-participation-', async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const missing = missingSourceRead(request, input)
      if (missing) return [call('router_source_read', missing)]
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const newSourceIds = input.context?.newSourceIds ?? []
      if (!newSourceIds.includes(requirementId)) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const pages = values.filter(value => value.batchId === input.batchId && value.sourceId === assignmentId && Number.isInteger(value.nextOffset))
      let offset = 0, text = ''
      while (true) {
        const page = pages.find(value => value.offset === offset)
        if (!page) return [call('router_source_read', { sourceId: assignmentId, offset })]
        text += page.text
        offset = page.nextOffset
        if (offset >= page.totalLength) break
      }
      assert.ok(text.includes(assignment), '原分工必须从真实来源工具完整读回')
      historyRead = true
      const review = values.findLast(value => value.sourceId === requirementId && Array.isArray(value.candidates))
      if (!review) return [call('router_reply_review_get', { sourceId: requirementId })]
      return [call('router_submit', { actions: [{ kind: 'new-task', sourceIds: [assignmentId, requirementId], title: '列表状态展示',
        objective: '在列表状态列显示等待中的记录', acceptanceCriteria: ['等待中的记录可见'] }], continuity: [],
        reply: { sourceId: requirementId, text: '已承接列表状态展示需求。', review: { kind: 'confirmation',
          reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    assert.ok(names.includes('task_session_submit'))
    return [call('task_session_submit', { decision: { action: 'wait', summary: '等待后续测试资料', evidence: [], limitations: [] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(message('assignment', assignment)))
  await t.step(async () => waitUntil(async () => (await h.query('source.list')).some(item => item.sourceId === assignmentId && item.processingCompleted), '原分工处理完成'))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  await t.step(async () => h.service.ingest(message('requirement', requirement)))
  await t.step(async () => waitUntil(async () => (await h.query('task.list')).length === 1 && h.sent.length === 1
    && h.residentStore.getRouterState('native-group').decisions.some(item => item.applications.some(application => application.action?.kind === 'new-task')
      && item.applications.every(application => application.status === 'applied')), '需求任务与回复完成').catch(async error => {
    throw new Error(`${error.message} ${JSON.stringify({ historyRead, taskCount: (await h.query('task.list')).length, sent: h.sent.length,
      alerts: h.service.listAlerts(), results: h.toolResults.slice(-6).map(item => ({ name: item.name, error: item.result.error })),
      active: h.residentStore.getRouterState('native-group').active?.batchId })}`)
  }))
  assert.equal(historyRead, true)
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, '列表状态展示')
  assert.equal(tasks[0].objective, '在列表状态列显示等待中的记录')
  assert.deepEqual([...tasks[0].sourceRefs].sort(), [assignmentId, requirementId].sort())
  const decision = h.residentStore.getRouterState('native-group').decisions.find(item => item.applications.some(application => application.action?.kind === 'new-task'))
  assert.ok(decision)
  assert.ok(decision.applications.every(application => application.status === 'applied'))
  assert.equal(h.sent.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
}))

testRunner('direct Router may ask whether to help without creating or executing a Task', { ...({ timeout: 15000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async t => {
  const source = message('proposal-only', '合并后描述输入框放在该项文字右侧，和文字顶部对齐。')
  const sourceId = `im:${createHash('sha256').update(JSON.stringify([source.groupId, source.messageId, source.messageVersion ?? 1])).digest('hex')}`
  const h = await extraHost(t, 'direct-router-proposal-', async request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
    if (names.includes('group_topic_route_submit') || names.includes('group_decision_submit')) throw new Error('legacy Topic routing must not run')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const pages = values.filter(item => item.batchId === input.batchId && item.sourceId)
      for (const item of input.sources ?? []) {
        let offset = 0
        while (offset < item.totalLength) {
          const page = pages.find(value => value.sourceId === item.sourceId && value.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: item.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const review = values.findLast(value => value.sourceId === sourceId && Array.isArray(value.candidates))
      if (!review) return [call('router_reply_review_get', { sourceId })]
      return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '这个事项是否需要我处理？',
        review: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.whenIdle())
  const sources = await t.step(async () => h.query('source.list'))
  assert.ok(sources.find(item => item.sourceId === sourceId)?.processingCompleted)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal(h.residentStore.getRouterState('native-group').decisions.flatMap(item => item.applications).some(item => item.kind === 'new-task'), false)
  assert.equal(h.sent.length, 1)
  assert.ok(h.sent[0].payload.text.includes('这个事项是否需要我处理？'))
  const before = structuredClone(sources)
  await t.step(async () => h.service.ingest(source))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.deepEqual(await t.step(async () => h.query('source.list')), before)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal(h.sent.length, 1)
}))

testRunner('native Web reopen preserves task identity and rejects stale input; HTTP retry is idempotent', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  await t.beginBusiness()
  const { createServer } = await t.step(async () => import('node:http'))
  const { handleRequest } = await t.step(async () => import('../packages/dingtalk-dsh-assistant/http.js'))
  const h = await t.step(async () => extraHost(t, 'web-reopen-', async () => [call('task_session_submit', { decision: { action: 'complete', summary: '原事项已核对', evidence: ['fixture'], limitations: [] } })]))
  const created = await t.step(async () => h.service.createTask({ requestId: 'original', groupId: 'native-group', title: '原PR', objective: '核对原PR', acceptanceCriteria: ['核对完成'] }))
  await t.step(async () => h.service.whenIdle())
  const original = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(original.status, 'completed')
  const runtime = { isTaskSessionMode: () => true, getTaskSessionDetail: id => h.service.taskDetail(id), reopenTask: args => h.service.reopenTask(args) }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await t.step(async () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tasks/${original.taskId}/reopen`
  const args = { requestId: 'review-followup', context: '只处理新增审查，保留原提测证据', expectedRequirementRevision: original.requirementRevision, expectedControlRevision: original.controlRevision }
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await t.step(async () => post({ ...args, actorId: 'other' }))).status, 400)
  assert.equal((await t.step(async () => post({ ...args, expectedControlRevision: original.controlRevision + 1 }))).status, 409)
  assert.equal((await t.step(async () => post(args))).status, 200)
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => post(args))).status, 200)
  await t.step(async () => h.service.whenIdle())
  const reopened = await t.step(async () => h.query('task.get', { taskId: original.taskId }))
  assert.equal(reopened.runSequence, original.runSequence + 1)
  assert.equal(reopened.sessionId, original.sessionId)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(reopened.sourceRefs.length, original.sourceRefs.length + 1)
  assert.deepEqual(h.residentStore.listTopics('native-group'), [], 'HTTP Task reopen does not create or require Topic state')
}))

testRunner('direct Router failure keeps the exact source pending until its durable retry creates one Task', { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'direct-router-retry-'))
  const agentConfig = { agentPreset: 'missing-fixture-preset' }
  const inputMessage = message('direct-retry', '测试助手，请核对原文件并等待我补充。')
  const decide = async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('coordination_submit') || names.includes('group_topic_route_submit') || names.includes('group_decision_submit'))
      throw new Error('retired coordination and Topic paths must not handle this source')
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const input = latestInput(request)
      const pages = modelToolValues(request).filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources ?? []) {
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
      if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
      const sourceIds = input.context?.newSourceIds ?? []
      return [call('router_submit', { actions: sourceIds.length ? [{ kind: 'new-task', sourceIds,
        title: '原文件核对', objective: '核对原文件并等待补充', acceptanceCriteria: ['保持原来源身份'] }] : [], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) return [call('task_session_submit', { decision: { action: 'wait', summary: '等待用户补充原文件资料', evidence: [], limitations: [] } })]
    throw new Error(`Unexpected direct Router tools: ${names.join(', ')}`)
  }
  let h = await t.step(async () => nativeTaskHost(root, decide, { agentConfig }))
  await t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  await t.step(async () => h.service.ingest(inputMessage))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(() => h.residentStore.getRouterState(inputMessage.groupId).failures?.some(item => item.status === 'failed'), 'durable direct Router failure'))
  const original = structuredClone(h.residentStore.getGroup(inputMessage.groupId).messages[0])
  const failure = h.residentStore.getRouterState(inputMessage.groupId).failures.find(item => item.status === 'failed')
  const retry = { groupId: inputMessage.groupId, messageId: inputMessage.messageId, messageVersion: original.messageVersion,
    phase: failure.phase, requestId: failure.requestId, token: failure.retryToken }
  const failedSources = await t.step(async () => h.query('source.list'))
  assert.equal(failedSources.length, 1)
  assert.equal(failedSources[0].sourceId, failure.sourceRef.sourceId)
  assert.equal(failedSources[0].processingCompleted, undefined)
  assert.notEqual(failedSources[0].routed, true)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('coordination.source.list'))).length, 0)
  assert.equal(h.residentStore.listTopics(inputMessage.groupId).length, 0)
  for (const patch of [{ messageVersion: original.messageVersion + 1 }, { phase: 'decision' }, { requestId: 'foreign' }, { token: 'wrong-token' }])
    await t.step(async () => assert.rejects(h.service.retryMessageProcessing({ ...retry, ...patch }), /MESSAGE_RETRY_STALE/))

  await t.step(async () => h.close())
  agentConfig.agentPreset = 'native-test'
  h = await t.step(async () => nativeTaskHost(root, decide, { agentConfig }))
  const recoveredFailure = h.residentStore.getRouterState(inputMessage.groupId).failures.find(item => item.status === 'failed')
  assert.equal(recoveredFailure.requestId, retry.requestId)
  assert.equal(recoveredFailure.retryToken, retry.token)
  const attempted = await t.step(async () => h.service.retryMessageProcessing(retry))
  assert.equal(attempted.status, 'attempted')
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => (await h.query('source.list'))[0]?.processingCompleted, 'exact original source reaches direct completion'))
  const sources = await t.step(async () => h.query('source.list'))
  assert.equal(sources.length, 1)
  assert.equal(sources[0].sourceId, failure.sourceRef.sourceId)
  for (const key of ['messageId', 'messageVersion', 'text', 'occurredAt', 'senderOpenDingTalkId']) assert.deepEqual(h.residentStore.getGroup(inputMessage.groupId).messages[0][key], original[key])
  const [task] = await t.step(async () => h.query('task.list'))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.ok(task.sourceRefs.includes(failure.sourceRef.sourceId))
  assert.equal(task.topicRefs.length, 0)
  assert.equal((await t.step(async () => h.query('coordination.source.list'))).length, 0)
  assert.equal(h.residentStore.listTopics(inputMessage.groupId).length, 0)
  await t.step(async () => assert.rejects(h.service.retryMessageProcessing(retry), /MESSAGE_RETRY_STALE/))
}))
