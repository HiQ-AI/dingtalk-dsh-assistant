import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import { lifecycleStages } from './fixtures/lifecycle-stages.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { createHash } from 'node:crypto'
import * as resident from '../packages/dingtalk-dsh-assistant/resident.js'
import { available, reason, nativeShell, nativeTaskHost, nativeVerificationTeam, latestInput, modelToolValues, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { taskSessionLogRoot } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { retireTaskContext } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { taskNotificationRecovery } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { DatabaseSync } from 'node:sqlite'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'

testRunner('历史通知投影缓慢时新通知仍可领取许可', { timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async t => {
  assert.ok(available, reason)
  const root = await mkdtemp(join(tmpdir(), 'notification-scan-'))
  let host
  const blocked = Promise.withResolvers(), release = Promise.withResolvers(), sent = Promise.withResolvers()
  t.onCancel(() => release.resolve())
  t.after(async () => { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, () => assert.fail('不得调用模型'), { notifications: {
    async send(notification) { sent.resolve(notification.id); return { messageId: 'new-delivery' } },
    async readback(notification) { return { messageId: notification.ack.messageId, visible: true } },
  } }))
  const command = (kind, args, id) => host.service.store.command({ kind, args, id })
  const payload = { conversationId: 'native-group', sourceMessageId: 'source', actorId: 'native-user', text: '隔离回复', fact: { topicRefs: [{ topicId: 'fixture-topic', revision: 1 }] }, kind: 'topic-reply' }
  await command('notification.prepare', { notificationId: 'old-notice', kind: 'topic-reply', requirementRevision: 1, payload }, 'prepare-old-notice')
  const start = await command('notification.start', { notificationId: 'old-notice' }, 'start-old-notice')
  await command('notification.delivered', { notificationId: 'old-notice', dispatchToken: start.result.notification.dispatchToken, receipt: { messageId: 'old-delivery' } }, 'deliver-old-notice')
  await command('notification.prepare', { notificationId: 'new-notice', kind: 'topic-reply', requirementRevision: 1, payload }, 'prepare-new-notice')
  const project = host.residentStore.projectTaskNotification
  host.residentStore.projectTaskNotification = async args => {
    if (args.outbound.outboundId === 'old-notice') { blocked.resolve(); await release.promise }
    return project(args)
  }
  await t.beginBusiness()
  const recovery = host.service.recover()
  await t.step(() => blocked.promise)
  const outcome = await t.step(() => Promise.race([sent.promise, new Promise(resolve => setTimeout(() => resolve('blocked'), 500))]))
  assert.equal(outcome, 'new-notice')
  release.resolve()
  await t.step(() => recovery)
  await t.step(() => host.service.whenIdle())
  assert.equal(host.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === 'old-notice')?.notificationState, 'delivered')
  assert.equal((await t.step(() => host.query('notification.get', { notificationId: 'new-notice' }))).state, 'delivered')
}))

testRunner('same-host recovery drains the original native process without replaying an unknown operation', { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-drain-retry-'))
  const store = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
  let h, delegated = false, requested = false, ready = false, rejectCommit = false, launches = 0, waits = 0
  t.after(async () => { await h?.close().catch(() => {}); await store.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, request => {
    const topics = topicTaskCalls(request); if (topics) return topics
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) { delegated = true; return [{ name: 'task_delegate', args: { key: 'original', objective: '只读取本地标识并保留原始回执' } }] }
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待原执行排空与效果核验', evidence: [], limitations: [] } } }]
    }
    assert.equal(requested, false, 'unknown operation must not start another model/tool turn')
    requested = true
    return [{ name: nativeShell, args: { command: nativeShell === 'pwsh' ? "Write-Output 'drain-retry-native-marker'" : "printf 'drain-retry-native-marker'", description: '读取本地测试标识' } }]
  }, { store: { ...store, command(command) {
    if (command.kind === 'execution.drained' && rejectCommit) { rejectCommit = false; throw new Error('fixture ledger write unavailable') }
    return store.command(command)
  } }, serviceFactory: async options => {
    const service = options.ctx.subprocess, spawn = service.spawn
    service.spawn = function (...args) {
      const handle = spawn.apply(this, args)
      if (!JSON.stringify(args).includes('drain-retry-native-marker')) return handle
      launches++
      return new Proxy(handle, { get(target, key) {
        if (key === 'waitForExit') return async (...waitArgs) => {
          waits++
          const empty = await target.waitForExit(...waitArgs)
          if (!ready) throw new Error('fixture range observation unavailable')
          return empty
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    return openTaskSessionService(options)
  } }))
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'drain-retry', objective: '读取本地标识' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(launches, 1, JSON.stringify(h.toolResults.filter(item => item.name === nativeShell)))
  const held = await t.step(async () => waitUntil(async () => (await h.query('execution.list', { taskId: task.taskId })).find(item => item.recovering), 'original drain failure recorded'))
  assert.equal(held.drained, false)
  assert.equal(held.drainFailure.error.cause.phase, 'waitForExit')
  assert.match(held.drainFailure.error.cause.cause.message, /fixture range observation unavailable/)
  const operations = await t.step(async () => h.query('operation.list', { taskId: task.taskId }))
  assert.equal(operations.length, 1); assert.equal(operations[0].state, 'unknown')
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('execution.get', { executionId: held.executionId }))).drained, false)
  ready = true; rejectCommit = true
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('execution.get', { executionId: held.executionId }))).drained, false, 'physical proof alone cannot settle the ledger')
  await t.step(async () => Promise.all([h.service.recover(), h.service.recover()])); await t.step(async () => h.service.whenIdle())
  const drained = await t.step(async () => h.query('execution.get', { executionId: held.executionId }))
  assert.equal(drained.drained, true); assert.equal(drained.recovering, false)
  assert.deepEqual(drained.result, held.result)
  assert.ok(drained.drainFailure.recoveredAt)
  assert.equal(launches, 1); assert.equal(waits, 3)
  assert.deepEqual(await t.step(async () => h.query('operation.list', { taskId: task.taskId })), operations)
}))

testRunner('原生网页工具错误不建立未知效果，仍可完成后续读取', { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
 const root=await mkdtemp(join(tmpdir(),'native-web-read-'))
 let host, delegated=false, calls=0
 const team=nativeVerificationTeam()
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
 await t.beginBusiness()
 host=await t.step(async () => nativeTaskHost(root, async(request,h)=>{
  const topics=topicTaskCalls(request);if(topics)return topics
  const input=latestInput(request), names=request.tools.map(tool=>tool.name)
  const verification=team.execute(request,input);if(verification)return verification
  if(names.includes('task_delegate')) {
   if(!delegated){
    delegated=true
    for(const name of ['web_fetch','web_search']) h.ctx.tools.register({name,description:'Native readonly web contract fixture',parameters:{type:'object'},
     output:{schema:{type:'object'},render:()=>[]},execute(){calls++;throw new Error('unsupported content type')}})
    return [{name:'task_delegate',args:{key:'read',objective:'读取网页并如实记录错误'}}]
   }
   const members=await h.query('execution.list');const more=team.owner(input,members[0]);if(more)return more
   if(members.some(item=>!item.drained||item.status!=='succeeded'))return [decision('wait','等待核验')]
   return [{name:'task_session_submit',args:{decision:{action:'complete',summary:'已核对读取失败，未重放请求',evidence:[],limitations:['网页内容不支持']}}}]
  }
  if(calls===0)return [{name:'web_fetch',args:{}}]
  if(calls===1)return [{name:'web_search',args:{}}]
  return [{name:'execution_submit',args:{output:{status:'completed',summary:'已记录两次读取失败',evidence:[],limitations:['内容不可读'],artifacts:[]}}}]
 }))
 await t.step(async () => host.service.ingest({groupId:'native-group',messageId:'web-failure',senderOpenDingTalkId:'native-user',text:'测试助手，读取并报告结果',timestamp:'2026-10-13T11:00:00Z'}))
 await t.step(async () => host.service.whenIdle())
 assert.equal(calls,2);assert.equal((await t.step(async () => host.query('operation.list'))).length,0)
 assert.equal((await t.step(async () => host.query('task.list')))[0].status,'completed')
 assert.equal((await t.step(async () => host.query('task.list')))[0].humanRequests?.length ?? 0,0)
}))
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { findSessionLog, requestSystemText } from './fixtures/session-persistence.js'

const call = (name, args) => ({ name, args })
function directRouterCalls(request) {
  const names = request.tools.map(tool => tool.name)
  if (!names.includes('triage_submit') && !names.includes('router_submit')) return null
  const input = latestInput(request), pages = modelToolValues(request).filter(item => item.batchId === input.batchId && item.sourceId)
  for (const source of input.sources) {
    let offset = 0
    while (offset < source.totalLength) {
      const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
      if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
      offset = page.nextOffset
    }
  }
  if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
  return [call('router_submit', { actions: input.sources.length ? [{ kind: 'new-task', sourceIds: input.sources.map(source => source.sourceId),
    title: '处理来源请求', objective: '按来源请求完成任务' }] : [], continuity: [], reply: null })]
}
const test = (name, options, run) => testRunner(name, { ...options, ...(!available ? { skip: reason } : {}) }, run)
const decision = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: ['实际文件和进程输出已核验'], limitations: [] } })

test('native DWS observer binds send and status operations, filters early echoes and persists exact identities', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const fixture = await nativeCase(t, 'native-dws-receipts-')
  const launched = Promise.withResolvers(), allowAck = Promise.withResolvers(), allowStatus = Promise.withResolvers()
  let delegated = false, h, probes = 0, stage = 'prepare'
  t.onCancel(() => { allowAck.resolve(); allowStatus.resolve(); t.diagnostic(JSON.stringify({ stage, probes, alerts: h?.service.listAlerts(),
    toolErrors: h?.toolResults.filter(item => item.result.isError).map(item => ({ name: item.name, result: item.result })) })) })
  const status = (openTaskId = 'trusted-send', messageId = 'sent-file') => ({ contractVersion: 'im.message-send-status.v1', success: true, openTaskId,
    result: { sendStatus: 'SUCCESS', openConversationId: 'native-group', openMessageId: messageId }, messageRef: { openConversationId: 'native-group', openMessageId: messageId } })
  const result = (...values) => ({ value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, stdout: { text: values.map(JSON.stringify).join('\n') }, stderr: { text: '' } } })
  const executor = { close: async () => {}, cancel: async () => {}, feedback: async () => {}, assertDrained() {},
    async run({ binding, onNativeExecution, onResult }) {
      const invoke = async (callId, command, output, effectClass = 'unknown', cancelled = false) => {
        const event = { binding, callId, toolName: 'pwsh', arguments: { command, timeoutMs: 10000 }, effectClass }
        await onNativeExecution({ ...event, phase: 'started' })
        await onNativeExecution({ ...event, phase: 'settled', result: output, cancelled })
      }
      await invoke('failed-read', "dws chat message send-status --open-task-id 'failed-read' --format json", { isError: true }, 'read')
      await invoke('cancelled-read', "dws chat message send-status --open-task-id 'cancelled-read' --format json", result(status()), 'pure', true)
      await invoke('mget-only', "dws chat +messages-mget --msg-ids 'other' --no-reactions --no-threads --format json", result(status()))
      assert.equal(h.residentStore.getGroup('native-group').outbox.length, 0)
      const event = { binding, callId: 'original-send', toolName: 'pwsh', effectClass: 'unknown', arguments: {
        command: "dws chat +messages-send --as user --group 'native-group' --file 'accepted.png' --msg-type file --idempotency-key 'original-key' --yes --format json", timeoutMs: 10000 } }
      await onNativeExecution({ ...event, phase: 'started' }); launched.resolve()
      await allowAck.promise
      await onNativeExecution({ ...event, phase: 'settled', result: result({ ok: true, result: { success: true, result: { openTaskId: 'trusted-send' } }, sendReceipt: { openTaskId: 'trusted-send' } }) })
      await allowStatus.promise
      await invoke('unrelated-status', "dws chat message send-status --open-task-id 'unrelated-send' --format json", result(status('unrelated-send', 'unrelated-message')))
      await invoke('original-status', "dws chat message send-status --open-task-id 'trusted-send' --format json; dws chat +messages-mget --msg-ids 'sent-file' --no-reactions --no-threads --format json",
        result(status(), { messages: [status('forged-in-mget', 'not-ours')] }))
      await onResult({ status: 'completed', summary: '原发送及成功状态已观察', evidence: ['exact-send-receipt'], limitations: [], artifacts: [] })
      return { status: 'submitted' }
    } }
  const options = { config: { assistantActorId: 'native-assistant' }, serviceFactory: options => openTaskSessionService({ ...options, executionSessions: executor }),
    notifications: { send: async () => assert.fail('This test must not dispatch a notification'), readback: async () => undefined,
      querySendStatus: async id => { assert.equal(id, 'trusted-send'); return ++probes === 1 ? { ...status(), result: { sendStatus: 'PROCESSING' } } : status() } } }
  await t.beginBusiness()
  h = await t.step(async () => fixture.host(async (request, host) => {
    const input = latestInput(request)
    const routed = topicTaskCalls(request, { needsProcessing: false })
    if (routed) return routed
    if (!delegated) { delegated = true; return [call('task_delegate', { key: 'send', objective: '观察受信发送回执' }), decision('wait', '等待发送观察')] }
    const [execution] = await host.query('execution.list', { taskId: input.task.taskId })
    return [decision(execution?.drained && execution.status === 'succeeded' ? 'complete' : 'wait', '核对发送观察结果')]
  }, options))
  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'native-send', objective: '观察明确授权的发送及成功状态' }))
  stage = 'await-send-start'
  await t.step(async () => launched.promise)
  const echo = { groupId: 'native-group', messageId: 'sent-file', senderOpenDingTalkId: 'native-assistant', text: '[文件] accepted.png', timestamp: new Date().toISOString() }
  const early = h.service.ingest(echo)
  stage = 'await-early-echo'
  allowAck.resolve()
  assert.equal((await t.step(async () => early)).reason, 'own-notification')
  stage = 'await-task-idle'
  allowStatus.resolve(); await t.step(async () => h.service.whenIdle())
  const outbox = h.residentStore.getGroup('native-group').outbox
  assert.equal(outbox.length, 1); assert.equal(outbox[0].deliveredMessageId, 'sent-file')
  assert.equal(outbox[0].sendReceipt.openTaskId, 'trusted-send')
  const operations = await t.step(async () => h.query('operation.list', { taskId: created.taskId }))
  assert.ok(operations.some(operation => operation.result?.nativeDwsSend?.openTaskId === 'trusted-send'))
  assert.ok(operations.some(operation => operation.result?.nativeDwsStatuses?.some(proof => proof.messageId === 'sent-file')))
  for (const id of ['failed-read', 'cancelled-read']) {
    const operation = operations.find(item => item.result?.callId === id)
    assert.equal(operation.state, 'failed'); assert.equal(operation.result.noEffect, true)
    assert.equal(operation.result.nativeDwsStatuses, undefined)
  }
  assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).status, 'completed')
  assert.equal((await t.step(async () => h.service.ingest({ ...echo, messageId: 'manual-same-body', messageAiSendFlag: 'DWS' }))).accepted, true)
  await t.step(async () => h.service.whenIdle())
  const sources = await t.step(async () => h.query('source.list'))
  assert.equal(sources.filter(source => source.messageId === 'manual-same-body').length, 1)
  assert.equal(sources.some(source => source.messageId === 'sent-file'), false, 'The echo never reaches semantic ingress')
  await t.step(async () => h.close())
  h = await t.step(async () => fixture.host(() => { throw new Error('Receipt recovery must not invoke models') }, { ...options, initialize: false }))
  assert.equal((await t.step(async () => h.service.ingest(echo))).reason, 'own-notification')
  assert.equal(h.residentStore.getGroup('native-group').outbox.length, 1)
}))

test('迟回读的精确自身回复自动收束已入账来源，同账号人工消息仍处理', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const fixture = await nativeCase(t, 'late-own-notification-')
  const readbackStarted = Promise.withResolvers(), allowReadback = Promise.withResolvers()
  const routeStarted = Promise.withResolvers(), allowRoute = Promise.withResolvers()
  let sends = 0, submitted = false
  t.onCancel(() => { allowReadback.resolve(); allowRoute.resolve() })
  await t.beginBusiness()
  const h = await t.step(async () => fixture.host(async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const sourceId = input.sources[0].sourceId
      const pages = modelToolValues(request).filter(item => item.batchId === input.batchId && item.sourceId === sourceId).sort((a, b) => a.offset - b.offset)
      const source = JSON.parse(pages.map(item => item.text).join(''))
      if (source.messageId === 'late-echo') { routeStarted.resolve(); await allowRoute.promise; return [] }
      return [call('triage_submit', { needsProcessing: source.messageId === 'fixed-request', reply: null })]
    }
    if (names.includes('router_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      if (submitted || !input.sources.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const sourceId = input.sources[0].sourceId
      const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', { sourceId })]
      submitted = true
      return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '当前范围没有已完成任务。', review: {
        kind: 'substantive', reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    return []
  }, { config: { assistantActorId: 'native-user' }, notifications: {
    async send() { sends++; return { openTaskId: 'late-send' } },
    async readback(notification) { assert.equal(notification.ack.openTaskId, 'late-send'); readbackStarted.resolve(); await allowReadback.promise; return { messageId: 'late-echo' } },
  } }))
  t.onCancel(() => {
    const error = h.toolResults.find(item => item.result.isError)
    t.diagnostic(JSON.stringify({ firstToolError: error ? { name: error.name, result: error.result } : null }))
  })
  const original = { groupId: 'native-group', messageId: 'fixed-request', senderOpenDingTalkId: 'native-user', text: '测试助手，请说明工作成果', occurredAt: '2026-10-28T00:00:00Z', mentionedAgent: true }
  await t.step(async () => h.service.ingest(original))
  t.diagnostic('原始来源已接纳，等待回读开始')
  await t.step(async () => readbackStarted.promise)
  t.diagnostic('回读已开始，准备接入迟到自身消息')
  const [pending] = await t.step(async () => h.query('notification.list'))
  assert.equal(pending.kind, 'router-reply')
  assert.equal(pending.ack.openTaskId, 'late-send')
  assert.equal(pending.receipt?.messageId, undefined)
  const echo = { ...original, messageId: 'late-echo', text: '当前范围没有已完成任务。' }
  assert.equal((await t.step(async () => h.service.ingest(echo))).accepted, true)
  await t.step(async () => routeStarted.promise)
  t.diagnostic('自身消息已进入路由，核验回读前来源')
  const source = (await t.step(async () => h.query('source.list'))).find(item => item.messageId === echo.messageId)
  assert.ok(source)
  assert.notEqual(source.routed, true)
  assert.equal(h.residentStore.getGroup('native-group').messages.find(item => item.messageId === echo.messageId).routingStatus, 'pending')
  allowReadback.resolve()
  t.diagnostic('回读已放行')
  await t.step(async () => waitUntil(async () => (await h.query('source.list')).find(item => item.messageId === echo.messageId)?.ownNotificationRetirement?.kind === 'own-notification', 'late echo retired'))
  t.diagnostic('Dynamic 来源已退役')
  allowRoute.resolve()
  await t.step(async () => h.service.whenIdle())
  t.diagnostic('服务已排空')
  const firstToolError = h.toolResults.find(item => item.result.isError)
  t.diagnostic(JSON.stringify({ firstToolError: firstToolError ? { name: firstToolError.name, result: firstToolError.result } : null }))
  const [delivered] = await t.step(async () => h.query('notification.list'))
  assert.equal(delivered.id, pending.id)
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.ack.openTaskId, 'late-send')
  assert.equal(delivered.receipt.messageId, 'late-echo')
  assert.equal(sends, 1)
  assert.equal(h.residentStore.getGroup('native-group').outbox.length, 1)
  assert.equal((await t.step(async () => h.service.ingest({ ...echo, messageId: 'human-same-account', text: '普通人工消息' }))).accepted, true)
  await t.step(async () => h.service.whenIdle())
  const sources = await t.step(async () => h.query('source.list'))
  assert.ok(sources.some(item => item.messageId === 'human-same-account' && !item.ownNotificationRetirement))
  assert.equal(sends, 1)
}))

for (const staleFiles of [false, true]) test(staleFiles ? 'Router 来源更新时整批退役真实附件且不发送' : 'native completion freezes files and resumes remaining delivery after the explanation is archived', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const fixture = await nativeCase(t, 'native-final-files-')
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let delegated = false, step = 0, h, sends = 0, fileSends = 0, triaged = false
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  t.onCancel(() => t.diagnostic(JSON.stringify({ requests: h?.requests.slice(-5).map(request => request.tools.map(tool => tool.name)),
    results: h?.toolResults.slice(-5).map(item => ({ name: item.name, result: item.result })), alerts: h?.service.listAlerts() })))
  h = await fixture.host(async (request, host) => {
    const names = request.tools.map(tool => tool.name)
    if (staleFiles && names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const needsProcessing = !triaged
      triaged = true
      return [call('triage_submit', { needsProcessing, reply: null })]
    }
    if (names.includes('router_submit')) {
      const input = latestInput(request), fact = input.context?.facts?.find(item => item.kind === 'completed' && item.result?.artifactFiles?.length)
      if (fact) {
        const sourceId = fact.sourceIds[0], pages = modelToolValues(request)
        const source = input.sources.find(item => item.sourceId === sourceId)
        assert.ok(source)
        let offset = 0
        while (offset < source.totalLength) {
          const page = pages.find(item => item.batchId === input.batchId && item.sourceId === sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId, offset })]
          offset = page.nextOffset
        }
        const reviewed = pages.findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
        if (!reviewed) return [call('router_reply_review_get', { sourceId })]
        return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '本地验收结果已核对', review: {
          kind: 'substantive', reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
          completion: { factId: fact.factId, taskId: fact.taskId, artifactIds: fact.result.artifactFiles.map(item => item.artifact.artifactId) } } })]
      }
      if (input.context?.facts?.length) {
        const calls = directRouterCalls(request)
        return calls[0].name === 'router_source_read' ? calls : [call('router_submit', { actions: [], continuity: [], reply: null })]
      }
    }
    const topic = topicTaskCalls(request); if (topic) return topic
    const input = latestInput(request)
    if (names.includes('task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'acceptance', objective: '生成本地验收产物并报告，不自行外发' }), decision('wait', '等待验收产物')] }
      const [execution] = await host.query('execution.list', { taskId: input.task.taskId })
      if (!execution?.drained || execution.status !== 'succeeded') return [decision('wait', '等待产物完成')]
      return [call('task_session_submit', { decision: { action: 'complete', summary: '本地验收结果已核对', evidence: ['acceptance.txt'], limitations: [],
        deliveryFiles: [{ executionId: execution.executionId, path: 'acceptance.txt', caption: '本地验收结果' }] } })]
    }
    if (step++ === 0) return [call('write', { file_path: 'acceptance.txt', content: 'accepted original bytes' })]
    return [call('execution_submit', { output: { status: 'completed', summary: '本地验收文件已生成', evidence: ['acceptance.txt'], limitations: [], artifacts: ['acceptance.txt'] } })]
  }, { notifications: { send: async () => { sends++; return { messageId: 'summary' } }, readback: async () => undefined,
    sendFile: async () => { fileSends++; assert.fail('Files must wait for the final explanation receipt') }, readbackFile: async () => undefined } })
  if (staleFiles) {
    const fence = h.residentStore.withNotificationSource.bind(h.residentStore)
    h.residentStore.withNotificationSource = async args => { entered.resolve(); await release.promise; return fence(args) }
  }
    await t.beginBusiness()

  await t.step(async () => h.service.ingest({ groupId: 'native-group', messageId: 'final-file', senderOpenDingTalkId: 'native-user', senderName: '用户',
    text: '测试助手，生成并核验本地文件，随最终结果交付', timestamp: new Date().toISOString() }))
  if (staleFiles) await t.step(async () => waitUntil(async () => (await h.query('task.list'))[0]?.status === 'completed', '等待附件任务完成'))
  else await t.step(async () => h.service.whenIdle())
  const [created] = await t.step(async () => h.query('task.list'))
  const task = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(task.status, 'completed', JSON.stringify(h.toolResults.filter(item => item.result.isError)))
  assert.equal(task.completion.result.artifactFiles.length, 1)
  assert.equal(task.completion.result.artifactFiles[0].artifact.taskId, created.taskId)
  assert.equal(task.completion.result.artifactFiles[0].caption, '本地验收结果')
  await t.step(async () => waitUntil(async () => (await h.query('notification.list')).some(n => n.kind === 'router-reply' && n.payload.deliveryId === n.id), 'Router 完成回复已准备'))
  const notices = await t.step(async () => h.query('notification.list'))
  const preparedExplanation = notices.find(n => n.payload.deliveryId === n.id)
  const fileNotice = notices.find(n => n.payload.artifact)
  assert.ok(preparedExplanation); assert.equal(fileNotice.state, 'prepared')
  if (staleFiles) {
    await t.step(() => entered.promise)
    const parts = notices.filter(n => n.payload.deliveryId === preparedExplanation.id && n.id !== preparedExplanation.id)
    assert.ok(parts.length > 0)
    assert.ok(parts.every(part => part.state === 'prepared'))
    await t.step(() => waitUntil(() => h.residentStore.getRouterState('native-group').decisions.flatMap(item => item.applications)
      .some(item => item.kind === 'reply' && item.status === 'applied' && item.receipt?.notificationId === preparedExplanation.id), '等待附件回复应用入账'))
    await t.step(() => h.service.ingest({ groupId: 'native-group', messageId: 'final-file', messageVersion: 2,
      senderOpenDingTalkId: 'native-user', senderName: '用户', text: '测试助手，更新文件交付要求', timestamp: new Date().toISOString() }))
    release.resolve()
    await t.step(() => waitUntil(async () => (await h.query('notification.get', { notificationId: preparedExplanation.id }))?.state === 'superseded', '等待附件父通知退役'))
    for (const part of parts) assert.equal((await h.query('notification.get', { notificationId: part.id })).state, 'superseded')
    assert.equal(sends, 0)
    assert.equal(fileSends, 0)
    t.diagnostic(JSON.stringify({ parentState: 'superseded', filePartCount: parts.length, filePartState: 'superseded', sends, fileSends }))
    return
  }
  const explanation = await t.step(async () => waitUntil(async () => {
    const notice = await h.query('notification.get', { notificationId: preparedExplanation.id })
    return notice?.ack?.messageId ? notice : null
  }, 'Router 完成回复已取得发送回执'))
  await t.step(async () => h.service.store.command({ id: 'observe-summary', kind: 'notification.reconcile', args: { notificationId: explanation.id, state: 'delivered',
    evidenceRef: 'exact-original-send', receipt: { messageId: explanation.ack.messageId, conversationId: 'native-group' } } }))
  await t.step(async () => h.service.store.command({ id: 'archive-delivery-task', kind: 'task.archive', args: { taskId: created.taskId, actorId: 'native-user' } }))
  assert.equal((await t.step(async () => h.query('notification.get', { notificationId: explanation.id }))).state, 'delivered')
  await t.step(async () => h.close())
  const sent = []
  const recovered = await t.step(async () => fixture.host(() => { throw new Error('Recovery must not re-run task models') }, { initialize: false, notifications: {
    send: async () => assert.fail('The explanation must not be sent twice'), readback: async n => ({ messageId: n.ack.messageId }),
    sendFile: async (n, file) => { sent.push(n.id); assert.equal(await readFile(file.path, 'utf8'), 'accepted original bytes'); return { openTaskId: 'queued-file-send' } },
    readbackFile: async () => undefined,
    querySendStatus: async id => { assert.equal(id, 'queued-file-send'); return { contractVersion: 'im.message-send-status.v1', success: true, openTaskId: id,
      result: { sendStatus: 'SUCCESS', openConversationId: 'native-group', openMessageId: 'delivered-file' },
      messageRef: { openConversationId: 'native-group', openMessageId: 'delivered-file' } } },
  } }))
  await t.step(async () => recovered.service.whenIdle())
  assert.deepEqual(sent, [fileNotice.id])
  const echo = { groupId: 'native-group', messageId: 'delivered-file', senderOpenDingTalkId: 'native-assistant', text: '[文件] acceptance.txt', timestamp: new Date().toISOString() }
  assert.equal((await t.step(async () => recovered.service.ingest(echo))).reason, 'own-notification')
  const pendingFile = await t.step(async () => recovered.query('notification.get', { notificationId: fileNotice.id }))
  assert.equal(pendingFile.state, 'starting'); assert.equal(pendingFile.ack.openTaskId, 'queued-file-send')
  const outbound = recovered.residentStore.getGroup('native-group').outbox.find(item => item.outboundId === fileNotice.id)
  assert.equal(outbound.deliveredMessageId, 'delivered-file'); assert.equal(outbound.status, 'pending')
  await t.step(async () => recovered.close())
  const verified = await t.step(async () => fixture.host(() => { throw new Error('Receipt recovery must not re-run models') }, { initialize: false, notifications: {
    send: async () => assert.fail('The explanation must not be sent twice'), readback: async () => undefined,
    sendFile: async () => assert.fail('An acknowledged file must not be sent twice'),
    readbackFile: async () => ({ messageId: 'delivered-file', conversationId: 'native-group' }),
  } }))
  assert.equal((await t.step(async () => verified.service.ingest(echo))).reason, 'own-notification', 'Early identity proof survives restart')
  await t.step(async () => verified.service.whenIdle())
  const awaitingReadback = await t.step(async () => verified.query('notification.get', { notificationId: fileNotice.id }))
  const retry = await t.step(async () => verified.service.retryNotification({ groupId: 'native-group', notificationId: fileNotice.id,
    expectedToken: taskNotificationRecovery(awaitingReadback).expectedToken }))
  assert.equal(retry.action, 'readback')
  assert.equal((await t.step(async () => verified.query('notification.get', { notificationId: fileNotice.id }))).state, 'delivered')
}))

test('running reminder and coordinator clarification preserve one native shell job with received and consumed receipts', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-running-feedback-'))
  const team = nativeVerificationTeam({ filePath: 'effect.txt', expected: 'once' })
  let h, delegated = false, clarified = false, executions = 0
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const topics = topicTaskCalls(request); if (topics) return topics
    const input = latestInput(request)
    const verification = team.execute(request, input); if (verification) return verification
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const required = requiredDecisionRead(request, input); if (required) return [required]
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'original', objective: '创建原作业并核对补充' }), decision('wait', '等待原作业')] }
      const execution = input.executions[0]
      if (!execution) return [decision('wait', '等待执行')]
      if (input.wakes.some(wake => wake.kind === 'task.supplement') && !clarified) {
        clarified = true
        return [call('task_delegate', { executionId: execution.executionId, feedback: true, key: 'clarify', objective: '原目标不变，内置通知仍允许' }), decision('wait', '等待原执行消费说明')]
      }
      const more = team.owner(input, execution); if (more) return more
      return [decision(input.executions.length === 3 && input.executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '核对原执行及补充')]
    }
    if (++executions === 1) {
      const start = join(root, 'started'), release = join(root, 'release')
      const command = nativeShell === 'pwsh'
        ? `Add-Content effect.txt once; New-Item -ItemType File '${start}' | Out-Null; while (!(Test-Path '${release}')) { Start-Sleep -Milliseconds 20 }`
        : `echo once >> effect.txt; touch '${start}'; while [ ! -f '${release}' ]; do sleep 0.02; done`
      return [call(nativeShell, { command, description: '运行原生作业并等待测试释放' })]
    }
    return [call('execution_submit', { output: { status: 'completed', summary: '已读取补充，原作业完成', evidence: [], limitations: [], artifacts: ['effect.txt'] } })]
  }))
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'original', objective: '创建并保留原作业' }))
  try { await t.step(async () => waitUntil(async () => { try { await readFile(join(root, 'started')); return true } catch { return false } })) }
  catch (error) { throw new Error(JSON.stringify({ alerts: h.service.listAlerts(), executions: await t.step(async () => h.query('execution.list')), results: h.toolResults }), { cause: error }) }
  const before = (await t.step(async () => h.query('execution.list')))[0]
  await t.step(async () => h.service.appendTaskContext({ taskId: task.taskId, requestId: 'reminder', context: '开发分支别搞错了', progressImpact: 'preserve', expectedRequirementRevision: 1, expectedControlRevision: 1 }))
  const reminderSources = (await t.step(async () => h.query('source.list'))).filter(source => source.requestIdentity?.request?.args?.requestId === 'reminder')
  assert.equal(reminderSources.length, 1)
  const hostStages = reminderSources[0].stages.filter(stage => stage.stage === 'host')
  const overall = hostStages.find(stage => !stage.phase)
  assert.ok(overall?.completedAt && overall.quality === 'observed')
  for (const phase of ['task-commit', 'materialize']) {
    const stage = hostStages.find(item => item.phase === phase && item.requestId === overall.requestId)
    assert.ok(stage?.completedAt && stage.quality === 'observed')
  }
  assert.equal(hostStages.some(stage => stage.phase === 'old-drain'), false)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).requirementRevision, 1, '普通提醒不能变成需求修订并取消原作业')
  assert.equal((await t.step(async () => h.query('execution.list')))[0].cancelRequested, false, '原作业不能被普通提醒取消')
  await t.step(async () => waitUntil(async () => (await h.query('execution.list'))[0].feedback?.length === 2))
  const received = (await t.step(async () => h.query('execution.list')))[0]
  assert.ok(received.feedback.every(item => item.receivedAt && !item.consumedAt))
  assert.equal(received.cancelRequested, before.cancelRequested)
  await t.step(async () => writeFile(join(root, 'release'), 'release'))
  await t.step(async () => h.service.whenIdle())
  const after = (await t.step(async () => h.query('execution.list')))[0]
  for (const key of ['executionId', 'sessionId', 'inputVersion', 'leaseEpoch']) assert.equal(after[key], before[key])
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  assert.equal((await t.step(async () => h.query('execution.list'))).filter(item => item.key === 'original').length, 1)
  assert.ok(after.feedback.every(item => item.consumedAt && Number.isInteger(item.sequence)))
  assert.ok(after.feedback.every(item => item.modelStepEnteredAt === item.consumedAt && item.consumptionMeaning === 'native-model-step-admission'))
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify({
    alerts: h.service.listAlerts(), recovery: (await t.step(async () => h.query('task.get', { taskId: task.taskId }))).providerRecovery,
    executions: (await t.step(async () => h.query('execution.list'))).map(item => ({ key: item.key, status: item.status, error: item.result?.payload.error })),
  }))
  assert.equal((await t.step(async () => readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8'))).trim(), 'once')
  const events = (await t.step(async () => inspectSession(h.ctx.sessionPersistence, after.sessionId))).events
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.executionFeedback).length, 2)
}))

// The real Windows shell and three independent verification sessions exceed the old 15s budget.
test('native completion race drains then resumes the original execution without replaying its shell effect', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-feedback-completion-'))
  const team = nativeVerificationTeam({ filePath: 'effect.txt', expected: 'once' })
  let h, delegated = false, steps = 0, injected = false
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const topics = topicTaskCalls(request); if (topics) return topics
    const input = latestInput(request)
    const verification = team.execute(request, input); if (verification) return verification
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const required = requiredDecisionRead(request, input); if (required) return [required]
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'once', objective: '原作业只写入一次' }), decision('wait', '等待原执行')] }
      const members = await h.query('execution.list'), more = team.owner(input, members[0]); if (more) return more
      return [decision(input.executions.length < 3 || input.executions.some(item => !item.drained || item.status !== 'succeeded') ? 'wait' : 'complete', '核对当前结果')]
    }
    if (++steps === 1) return [call(nativeShell, { command: nativeShell === 'pwsh' ? 'Add-Content effect.txt once' : 'echo once >> effect.txt', description: '真实原生单次写入' })]
    return [call('execution_submit', { output: { status: 'completed', summary: steps === 2 ? '过时结果' : '已核对新补充', evidence: [], limitations: [], artifacts: ['effect.txt'] } })]
  }))
  h.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name === 'execution_submit' && !result.isError && !injected) {
      injected = true
      const task = (await h.query('task.list'))[0]
      await h.service.store.command({ id: 'completion-race-input', kind: 'task.supplement', args: { taskId: task.taskId,
        expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision,
        messageId: 'completion-race-input', text: '完成前核对新事实', request: task.request + '\n完成前核对新事实' } })
    }
    return decision
  })
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'completion-race', objective: '写入一次并核对输入' }))
  await t.step(async () => h.service.whenIdle())
  const [execution] = await t.step(async () => h.query('execution.list'))
  assert.equal(injected, true); assert.equal(execution.leaseEpoch, 2); assert.equal(execution.inputVersion, 1)
  assert.equal(execution.result.payload.error, null, JSON.stringify({ error: execution.result.payload.error, alerts: h.service.listAlerts() }))
  assert.equal(execution.result.payload.output.summary, '已核对新补充')
  assert.ok(execution.feedback[0].consumedAt)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await t.step(async () => readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8'))).trim(), 'once')
  assert.equal((await t.step(async () => h.query('operation.list'))).filter(item => item.state === 'succeeded').length, 1)
}))

// The scripted coordinator obeys the same required-read contract as a real model.
for (const mode of ['missing', 'preserve', 'replan', 'cancel']) test(`real coordinator input enforces explicit context semantics without default cancellation: ${mode}`, { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-input-semantics-'))
  let h, task, backing, delegated = false, executionSteps = 0, stage = 'prepare'
  t.onCancel(async () => {
    const current = task && await h?.query('task.get', { taskId: task.taskId })
    const executions = await h?.query('execution.list')
    t.diagnostic(JSON.stringify({ stage, alerts: h?.service.listAlerts(), task: current && { status: current.status, drained: current.drained,
      contextRevision: current.contextRevision, requirementRevision: current.requirementRevision, controlRevision: current.controlRevision },
      executions: executions?.map(({ status, drained, cancelRequested, feedback }) => ({ status, drained, cancelRequested, feedback })),
      toolErrors: h?.toolResults.filter(item => item.result.isError).slice(0, 3).map(item => ({ name: item.name, result: item.result })) }))
  })
  const classificationRejected = Promise.withResolvers()
  t.onCancel(() => writeFile(join(root, 'release'), 'release'))
  t.after(async () => { await writeFile(join(root, 'release'), 'release'); await h?.close(); await backing?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  if (mode === 'missing') backing = await t.step(() => openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const store = backing && { ...backing, async command(input) {
    try { return await backing.command(input) }
    catch (error) { if (input.kind === 'router.task.apply') classificationRejected.resolve(error); throw error }
  } }
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const calls = directRouterCalls(request)
      if (!names.includes('router_submit') || calls[0].name === 'router_source_read') return calls
      const input = latestInput(request)
      const sourceIds = input.context?.newSourceIds ?? []
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const loaded = modelToolValues(request).findLast(item => item.task?.taskId === task.taskId)
      if (!loaded) return [call('router_task_get', { taskId: task.taskId })]
      const current = loaded.task
      const action = { kind: mode === 'cancel' ? 'task-cancel' : 'task-context', taskId: task.taskId,
        sourceIds, inputVersion: current.requirementRevision,
        runSequence: current.runSequence, expectedControlRevision: current.controlRevision,
        ...(mode === 'cancel' ? { reason: '用户明确取消' } : { context: '开发分支别搞错了' }) }
      if (mode !== 'cancel' && mode !== 'missing') action.progressImpact = mode === 'replan' ? 'replan' : 'preserve'
      if (mode === 'replan') action.objective = '新的明确目标'
      return [call('router_submit', { actions: [action], continuity: [], reply: null })]
    }
    const topics = topicTaskCalls(request); if (topics) return topics
    if (names.includes('task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'original', objective: '保留原作业等待明确输入' }), decision('wait', '等待原执行')] }
      return [decision('wait', '保留当前执行证据')]
    }
    if (++executionSteps === 1) {
      const started = join(root, 'started'), released = join(root, 'release')
      return [call(nativeShell, { command: nativeShell === 'pwsh'
        ? `New-Item -ItemType File '${started}' | Out-Null; while (!(Test-Path '${released}')) { Start-Sleep -Milliseconds 20 }`
        : `touch '${started}'; while [ ! -f '${released}' ]; do sleep 0.02; done`, description: '真实原生作业等待输入' })]
    }
    return [call('execution_submit', { output: { status: 'completed', summary: '已核对补充', evidence: [], limitations: [], artifacts: [] } })]
  }, store ? { store } : {}))
  task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'initial', objective: '原始明确任务' }))
  stage = 'wait-original-shell'
  await t.step(async () => waitUntil(async () => { try { await readFile(join(root, 'started')); return true } catch { return false } }, 'original shell running'))
  stage = 'ingest-input'
  await t.step(async () => h.service.ingest({ groupId: 'native-group', messageId: 'semantic-input', senderOpenDingTalkId: 'native-user',
    text: mode === 'cancel' ? '测试助手，明确取消原任务' : mode === 'replan' ? '测试助手，改为新的明确目标，停止旧目标' : '测试助手，开发分支别搞错了', timestamp: new Date().toISOString() }))
  if (mode === 'missing') {
    const rejected = await t.step(() => classificationRejected.promise)
    assert.equal(rejected.code, 'TASK_CONTEXT_CLASSIFICATION_REQUIRED')
    const current = await t.step(async () => h.query('task.get', { taskId: task.taskId })), [execution] = await t.step(async () => h.query('execution.list'))
    assert.equal(current.requirementRevision, 1); assert.equal(execution.cancelRequested, false); assert.equal(execution.drained, false)
    assert.equal(execution.feedback?.length ?? 0, 0)
    await t.step(async () => writeFile(join(root, 'release'), 'release'))
    return
  }
  stage = 'wait-semantic-action'
  await t.step(async () => waitUntil(async () => {
    const current = await h.query('task.get', { taskId: task.taskId }), [execution] = await h.query('execution.list')
    return mode === 'cancel' ? current.control === 'cancelled' : mode === 'replan' ? current.requirementRevision === 2 : execution.feedback?.length === 1
  }, 'coordinator semantic action applied'))
  const current = await t.step(async () => h.query('task.get', { taskId: task.taskId })), [execution] = await t.step(async () => h.query('execution.list'))
  if (mode === 'preserve' || mode === 'missing') {
    assert.equal(current.requirementRevision, 1); assert.equal(execution.cancelRequested, false); assert.equal(execution.drained, false)
    await t.step(async () => writeFile(join(root, 'release'), 'release'))
  } else assert.equal(execution.cancelRequested, true)
  stage = 'wait-idle-after-release'
  await t.step(async () => h.service.whenIdle())
}))

function requiredDecisionRead(request, input) {
  for (const source of input.sources ?? []) if (source.textFile && source.readRequired) {
    const alreadyLocated = request.messages.filter(message => message.role === 'tool').some(message =>
      (message.content ?? []).some(part => part.type === 'text' && part.text.includes(source.textFile)))
    if (!alreadyLocated) return call('read', { file_path: source.textFile, offset: 1, limit: 1 })
  }
  const refs = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (value.contentRef) refs.add(value.contentRef)
    else for (const child of Object.values(value)) visit(child)
  }
  if (input.task?.readRequired) { visit(input.task.objective); visit(input.task.requirements) }
  for (const source of input.sources ?? []) if (source.readRequired) { visit(source.text); visit(source.body); visit(source.quote) }
  for (const execution of input.executions ?? []) if (execution.readRequired) { visit(execution.input?.objective); visit(execution.stageProgress) }
  const pages = modelToolValues(request)
  for (const ref of refs) {
    const textPages = pages.filter(page => page.contentRef === ref && page.format === 'text')
    if (!textPages.some(page => page.nextOffset === null)) return call('model_content_read', { contentRef: ref, offset: textPages.at(-1)?.nextOffset ?? 0, limit: 16000 })
  }
}

const message = { groupId: 'native-group', messageId: 'native-message-1', senderOpenDingTalkId: 'native-user', senderName: '真实用户', text: '测试助手，分别生成 alpha 和 beta 的文件并用终端验证，再汇总结论。', occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' }

async function nativeCase(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix)), hosts = []
  t.after(async () => { try { for (const host of hosts.toReversed()) await host.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { root, async host(decide, options) { const host = await nativeTaskHost(root, decide, options); hosts.push(host); return host } }
}

testRunner('Task 页面仅投影自身同群来源身份且归档后保留', { timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'task-source-dto-')
  const h = await t.step(() => fixture.host(() => assert.fail('不应调用模型')))
  await t.beginBusiness()
  const command = (kind, args, id) => h.service.store.command({ kind, args, id })
  await command('source.record', { sourceId: 'own-source', groupId: 'native-group', messageId: 'own-message', version: 1, actorId: 'native-user', text: '私有正文' }, 'dto-source')
  await command('source.record', { sourceId: 'foreign-source', groupId: 'foreign', messageId: 'foreign-message', version: 1, actorId: 'other', text: '其他群正文' }, 'dto-foreign')
  const refs = ['own-source', 'foreign-source', 'missing-source']
  await command('task.create', { taskId: 'dto-task', groupId: 'native-group', request: '测试', sourceRefs: refs }, 'dto-task')
  const expected = [{ sourceId: 'own-source', groupId: 'native-group', messageId: 'own-message', version: 1 }]
  const verify = item => { assert.deepEqual(item.sourceRefs, refs); assert.deepEqual(item.sourceMessages, expected); assert.equal(JSON.stringify(item.sourceMessages).includes('正文'), false) }
  verify(await h.service.taskDetail('dto-task'))
  verify((await h.service.boardTasks({ limit: 20, offset: 0 })).items.find(item => item.taskId === 'dto-task'))
  verify((await h.service.boardTasks({ limit: 20, offset: 0, summary: true })).items.find(item => item.taskId === 'dto-task'))
  const binding = (await command('task.claim', { taskId: 'dto-task' }, 'dto-claim')).result.binding
  await command('task.complete', { binding, summary: '完成' }, 'dto-complete')
  await command('task.drained', { binding }, 'dto-drain')
  await command('task.archive', { taskId: 'dto-task', actorId: 'native-user' }, 'dto-archive')
  verify(await h.service.taskDetail('dto-task'))
  verify((await h.service.boardTasks({ limit: 20, offset: 0, summary: true, archived: 'all' })).items.find(item => item.taskId === 'dto-task'))
}))

testRunner('切换后入站在双账之间中断时恢复原来源', { timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'router-ingress-recovery-')
  const backing = await t.step(() => openDynamicTaskStore({ dbPath: join(fixture.root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  let backingClosed = false
  t.after(() => backingClosed ? undefined : backing.close())
  let failOnce = true
  const store = { ...backing, command(input) {
    if (input.kind === 'source.record' && failOnce) { failOnce = false; throw new Error('TEST_SOURCE_WRITE_INTERRUPTED') }
    return backing.command(input)
  } }
  const first = await t.step(() => fixture.host(() => assert.fail('中断前不应调用模型'), { store }))
  await t.beginBusiness()
  await assert.rejects(t.step(() => first.service.ingest(message)), /TEST_SOURCE_WRITE_INTERRUPTED/)
  assert.equal((await first.query('source.list')).length, 0)
  assert.equal(first.residentStore.getGroup(message.groupId).messages[0].routerIngress.messageVersion, 1)
  await t.step(() => first.close())
  await t.step(() => backing.close())
  backingClosed = true
  const second = await t.step(() => fixture.host(request => {
    if (request.tools.some(tool => tool.name === 'triage_submit')) return [call('triage_submit', { needsProcessing: false, reply: null })]
    throw new Error('不应产生 Router 或 Task 请求')
  }, { initialize: false }))
  await t.step(() => second.service.recover())
  await t.step(() => second.service.whenIdle())
  const sources = await t.step(() => second.query('source.list', { groupId: message.groupId }))
  assert.equal(sources.length, 1)
  assert.equal(sources[0].messageId, message.messageId)
  assert.equal(sources[0].directProcessing.disposition.phase, 'triage')
  await t.step(() => second.service.recover())
  await t.step(() => second.service.whenIdle())
  assert.equal((await second.query('source.list', { groupId: message.groupId })).length, 1)
}))

for (const beforeOutbox of [false, true]) testRunner(`Router 回复${beforeOutbox ? '出箱前' : '待发送时'}来源更新会退役原身份且不发送`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let h, stage = 'construct', triaged = false
  t.onCancel(() => { release.resolve(); t.diagnostic(JSON.stringify({ stage, requests: h?.requests.slice(-5).map(request => request.tools.map(tool => tool.name)),
    results: h?.toolResults.slice(-5).map(item => ({ name: item.name, result: item.result })), alerts: h?.service.listAlerts() })) })
  t.after(() => release.resolve())
  const fixture = await nativeCase(t, 'router-reply-stale-')
  h = await t.step(() => fixture.host(request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const needsProcessing = !triaged
      triaged = true
      return [call('triage_submit', { needsProcessing, reply: null })]
    }
    if (names.includes('router_submit')) {
      const input = latestInput(request)
      if (!input.sources.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const sourceId = input.sources[0].sourceId
      const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', { sourceId })]
      return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '已核对来源', review: {
        kind: 'substantive', reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    return [decision('wait', '等待')]
  }))
  if (beforeOutbox) {
    const prepare = h.residentStore.withRouterReplyPreparation.bind(h.residentStore)
    h.residentStore.withRouterReplyPreparation = async args => { entered.resolve(args.outbound.outboundId); await release.promise; return prepare(args) }
  } else {
    const fence = h.residentStore.withNotificationSource.bind(h.residentStore)
    h.residentStore.withNotificationSource = async args => { entered.resolve(); await release.promise; return fence(args) }
  }
  await t.beginBusiness()
  stage = 'ingest-v1'
  await t.step(() => h.service.ingest(message))
  stage = 'wait-start-fence'
  const outboundId = await t.step(() => entered.promise)
  if (beforeOutbox) {
    assert.ok(outboundId)
    assert.equal(h.residentStore.getGroup(message.groupId).outbox.some(item => item.outboundId === outboundId), false)
    assert.equal(await h.query('notification.get', { notificationId: outboundId }), null)
    await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
    release.resolve()
    await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions
      .flatMap(item => item.applications).some(item => item.kind === 'reply' && item.status === 'applied'
        && item.receipt?.notificationId === outboundId && item.receipt.status === 'retired'), '等待原回复退役入账'))
    const retired = h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === outboundId)
    assert.equal(retired.status, 'superseded')
    assert.equal(retired.supersededReason, 'router-source-stale-before-prepare')
    assert.equal(await h.query('notification.get', { notificationId: outboundId }), null)
    assert.equal(h.sent.length, 0)
    return
  }
  stage = 'inspect-prepared'
  const notices = await h.query('notification.list')
  const original = notices.find(item => item.kind === 'router-reply')
  assert.ok(original)
  assert.equal(original.state, 'prepared')
  await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions
    .flatMap(item => item.applications).some(item => item.kind === 'reply' && item.status === 'applied'
      && item.receipt?.notificationId === original.id), '等待原回复应用入账'))
  stage = 'ingest-v2'
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  release.resolve()
  stage = 'wait-superseded'
  await t.step(() => waitUntil(async () => (await h.query('notification.get', { notificationId: original.id }))?.state === 'superseded', '等待原通知退役'))
  await t.step(() => h.service.whenIdle())
  assert.equal(h.sent.length, 0)
  assert.equal((await h.query('notification.get', { notificationId: original.id })).state, 'superseded')
  assert.ok((await h.query('notification.list')).filter(item => item.payload?.deliveryId === original.id).every(item => item.state === 'superseded'))
}))

testRunner('首筛回复先失败后来源更新沿原身份退役', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'triage-stale-failure-')
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let h, inject = true, triaged = false, sends = 0
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  h = await t.step(() => fixture.host(request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      if (triaged) return [call('triage_submit', { needsProcessing: false, reply: null })]
      const reviewed = modelToolValues(request).findLast(item => Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', {})]
      triaged = true
      return [call('triage_submit', { needsProcessing: false, reply: '已收到。', review: { kind: 'confirmation',
        reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
    }
    return [decision('wait', '等待')]
  }, { notifications: { send: async () => { sends++; return { messageId: 'unexpected' } }, readback: async () => undefined } }))
  const record = h.residentStore.triageRecordReply.bind(h.residentStore)
  h.residentStore.triageRecordReply = async args => {
    if (inject) { inject = false; entered.resolve(args); throw new Error('TEST_TRIAGE_REPLY_ACK') }
    return record(args)
  }
  const fence = h.residentStore.withNotificationSource.bind(h.residentStore)
  h.residentStore.withNotificationSource = async args => { await release.promise; return fence(args) }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  const original = await t.step(() => entered.promise)
  const failure = await t.step(() => waitUntil(() => (h.residentStore.getRouterState(message.groupId).failures ?? [])
    .find(item => item.requestId === original.triageId && item.status === 'failed'), '等待首筛回复失败持久化'))
  const notificationId = original.receipt.notificationId
  assert.equal((await h.query('notification.get', { notificationId })).state, 'prepared')
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  await assert.rejects(t.step(() => h.service.retryMessageProcessing({ groupId: message.groupId, messageId: message.messageId,
    messageVersion: 1, phase: failure.phase, requestId: failure.requestId, token: failure.retryToken })), /MESSAGE_RETRY_STALE/)
  release.resolve()
  await t.step(() => h.service.recover())
  const triage = await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).triage
    .find(item => item.triageId === original.triageId && item.replyStatus === 'applied'), '等待原首筛回复退役'))
  assert.equal(triage.replyReceipt.notificationId, notificationId)
  assert.equal(triage.replyReceipt.status, 'retired')
  assert.equal((await h.query('notification.get', { notificationId })).state, 'superseded')
  assert.ok(!(h.residentStore.getRouterState(message.groupId).failures ?? []).some(item => item.requestId === original.triageId))
  assert.equal(sends, 0)
}))

for (const failedBeforeEdit of [false, true]) testRunner(`Router 退役提交后投影先行仍沿原应用恢复 failedBeforeEdit=${failedBeforeEdit}`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'router-retire-cas-')
  const backing = await t.step(() => openDynamicTaskStore({ dbPath: join(fixture.root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const ackEntered = Promise.withResolvers(), allowAck = Promise.withResolvers(), casDone = Promise.withResolvers(), allowStart = Promise.withResolvers(), allowProjection = Promise.withResolvers()
  let h, injectCas = true, casCommitted = false, triaged = false, sends = 0
  t.onCancel(() => { allowAck.resolve(); allowStart.resolve(); allowProjection.resolve() })
  t.finallyCleanup(async () => { allowAck.resolve(); allowStart.resolve(); allowProjection.resolve(); await h?.close(); await backing.close() })
  const store = { ...backing, async command(input) {
    const receipt = await backing.command(input)
    if (injectCas && input.kind === 'notification.routerRetireUnsent' && receipt.result.status === 'retired') {
      injectCas = false
      casCommitted = true
      casDone.resolve(input.args.notificationId)
      throw new Error('TEST_AFTER_RETIRE_CAS')
    }
    return receipt
  } }
  h = await t.step(() => fixture.host(request => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const needsProcessing = !triaged; triaged = true
      return [call('triage_submit', { needsProcessing, reply: null })]
    }
    if (names.includes('router_submit')) {
      if (!input.sources.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const sourceId = input.sources[0].sourceId
      const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', { sourceId })]
      return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: '已核对来源', review: {
        kind: 'substantive', reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    return [decision('wait', '等待')]
  }, { store, notifications: { send: async () => { sends++; return { messageId: 'unexpected' } }, readback: async () => undefined } }))
  const prepare = h.residentStore.withRouterReplyPreparation.bind(h.residentStore)
  h.residentStore.withRouterReplyPreparation = async args => {
    if (casCommitted) await allowProjection.promise
    return prepare(args)
  }
  const record = h.residentStore.routerRecordApplication.bind(h.residentStore)
  let injectAck = true
  h.residentStore.routerRecordApplication = async args => {
    if (injectAck && args.receipt?.notificationId) {
      injectAck = false; ackEntered.resolve(args); await allowAck.promise
      throw new Error('TEST_BEFORE_ROUTER_ACK')
    }
    return record(args)
  }
  const fence = h.residentStore.withNotificationSource.bind(h.residentStore)
  h.residentStore.withNotificationSource = async args => { await allowStart.promise; return fence(args) }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  const original = await t.step(() => ackEntered.promise)
  const notificationId = original.receipt.notificationId
  assert.equal((await h.query('notification.get', { notificationId })).state, 'prepared')
  if (failedBeforeEdit) {
    allowAck.resolve()
    await t.step(() => waitUntil(() => (h.residentStore.getRouterState(message.groupId).failures ?? [])
      .find(item => item.requestId === original.operationId && item.status === 'failed'), '等待原版本失败持久化'))
  }
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  if (!failedBeforeEdit) allowAck.resolve()
  await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions
    .find(item => item.decisionId === original.decisionId)?.applications.some(item => item.operationId === original.operationId && item.status === 'pending'), '等待原应用保持待处理'))
  const recovery = h.service.recover()
  assert.equal(await t.step(() => casDone.promise), notificationId)
  const retired = await h.query('notification.get', { notificationId })
  assert.equal(retired.state, 'superseded')
  const failures = h.residentStore.getRouterState(message.groupId).failures ?? []
  assert.equal(failures.some(item => item.requestId === original.operationId && item.status === 'failed'), failedBeforeEdit)
  await t.step(() => projectTaskNotification({ residentStore: h.residentStore, notification: retired }))
  assert.equal(h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === notificationId).status, 'superseded')
  assert.equal(h.residentStore.getRouterState(message.groupId).decisions.find(item => item.decisionId === original.decisionId)
    .applications.find(item => item.operationId === original.operationId).status, 'pending')
  allowProjection.resolve()
  allowStart.resolve()
  await t.step(() => recovery)
  await t.step(() => h.service.recover())
  const application = await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions
    .find(item => item.decisionId === original.decisionId)?.applications.find(item => item.operationId === original.operationId && item.status === 'applied'), '等待原应用补账'))
  assert.equal(application.receipt.notificationId, notificationId)
  assert.equal(application.receipt.status, 'retired')
  assert.ok(!(h.residentStore.getRouterState(message.groupId).failures ?? []).some(item => item.requestId === original.operationId))
  assert.equal((await h.query('notification.get', { notificationId })).state, 'superseded')
  assert.equal(h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === notificationId).status, 'superseded')
  assert.equal(sends, 0)
}))

testRunner('Router 来源预检后自身送达身份出现时不创建 Task', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), rejected = Promise.withResolvers()
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  const fixture = await nativeCase(t, 'router-own-source-race-')
  const h = await t.step(() => fixture.host(request => directRouterCalls(request) ?? [decision('wait', '等待')]))
  const fence = h.residentStore.withOwnSourceFence.bind(h.residentStore)
  h.residentStore.withOwnSourceFence = async args => {
    entered.resolve(); await release.promise
    try { return await fence(args) } catch (error) { rejected.resolve(error); throw error }
  }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  await t.step(() => entered.promise)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 0)
  await t.step(() => h.residentStore.appendOutbox({ groupId: message.groupId, outboundId: 'race-outbound', sourceMessageId: 'other-source', text: '已发送' }))
  await t.step(() => h.residentStore.acknowledge({ groupId: message.groupId, outboundId: 'race-outbound', deliveredMessageId: message.messageId }))
  release.resolve()
  assert.match((await t.step(() => rejected.promise)).message, /DYNAMIC_SOURCE_RETIRED/)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 0)
  const pending = h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications).find(item => item.status === 'pending')
  assert.ok(pending)
  assert.equal(await h.query('receipt.get', { id: `router-operation:${pending.operationId}` }), null)
}))

testRunner('Router 无成功回执的旧来源在编辑后不得落账', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), rejected = Promise.withResolvers()
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  const fixture = await nativeCase(t, 'router-stale-source-')
  const h = await t.step(() => fixture.host(request => directRouterCalls(request) ?? [decision('wait', '等待')]))
  const fence = h.residentStore.withOwnSourceFence.bind(h.residentStore)
  h.residentStore.withOwnSourceFence = async args => {
    entered.resolve(); await release.promise
    try { return await fence(args) } catch (error) { rejected.resolve(error); throw error }
  }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  await t.step(() => entered.promise)
  const pending = h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications).find(item => item.status === 'pending')
  assert.ok(pending)
  assert.equal(await h.query('receipt.get', { id: `router-operation:${pending.operationId}` }), null)
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  assert.equal(h.residentStore.getGroup(message.groupId).messages.find(item => item.messageId === message.messageId).messageVersion, 2)
  release.resolve()
  assert.match((await t.step(() => rejected.promise)).message, /DYNAMIC_SOURCE_REVISION_CONFLICT|TASK_ROUTER_SOURCE_INVALID/)
  assert.equal(await h.query('receipt.get', { id: `router-operation:${pending.operationId}` }), null)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 0)
}))

testRunner('Router 失败应用无成功回执时来源更新不能创建动作', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  let h, backing, triaged = false, actionAttempts = 0
  t.after(async () => { await h?.close(); await backing?.close() })
  const fixture = await nativeCase(t, 'router-failed-no-receipt-')
  await t.beginBusiness()
  backing = await t.step(() => openDynamicTaskStore({ dbPath: join(fixture.root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const store = { ...backing, command(input) {
    if (input.kind === 'router.task.apply') { actionAttempts++; throw new Error('TEST_BEFORE_ROUTER_COMMIT') }
    return backing.command(input)
  } }
  h = await t.step(() => fixture.host(request => {
    const calls = directRouterCalls(request)
    if (!calls) return [decision('wait', '等待')]
    if (calls[0].name !== 'triage_submit') return calls
    const needsProcessing = !triaged
    triaged = true
    return [call('triage_submit', { needsProcessing, reply: null })]
  }, { store }))
  await t.step(() => h.service.ingest(message))
  const failure = await t.step(() => waitUntil(() => (h.residentStore.getRouterState(message.groupId).failures ?? [])
    .find(item => item.phase === 'host' && item.status === 'failed' && item.code === 'TEST_BEFORE_ROUTER_COMMIT'), '等待无回执应用失败'))
  const operationId = failure.requestId, receiptId = `router-operation:${operationId}`
  assert.equal(actionAttempts, 1)
  assert.equal(await h.query('receipt.get', { id: receiptId }), null)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 0)
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  assert.equal(h.residentStore.getGroup(message.groupId).messages.find(item => item.messageId === message.messageId).messageVersion, 2)
  await t.step(() => h.service.recover())
  await t.step(() => waitUntil(() => {
    const state = h.residentStore.getRouterState(message.groupId)
    return !state.active && !state.queue.length && state.triage.some(item => item.sourceRef.messageVersion === 2 && item.disposition.needsProcessing === false)
  }, '等待新来源静默完成'))
  const state = h.residentStore.getRouterState(message.groupId)
  assert.equal(state.failures.find(item => item.requestId === operationId).status, 'failed')
  assert.equal(state.decisions.flatMap(item => item.applications).find(item => item.operationId === operationId).status, 'pending')
  assert.equal(await h.query('receipt.get', { id: receiptId }), null)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 0)
  assert.equal(actionAttempts, 1)
}))

testRunner('Router 成功回执在来源编辑后按原动作恢复', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'router-receipt-edited-')
  const decide = request => directRouterCalls(request) ?? [decision('wait', '等待')]
  const h = await t.step(() => fixture.host(decide))
  let interrupted = false
  const release = Promise.withResolvers()
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  const record = h.residentStore.routerRecordApplication.bind(h.residentStore)
  h.residentStore.routerRecordApplication = async () => { interrupted = true; await release.promise; throw new Error('TEST_BEFORE_ROUTER_ACK') }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  await t.step(() => waitUntil(() => interrupted, '等待真实动作成功后 ACK 中断'))
  const pending = h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications).find(item => item.status === 'pending')
  assert.ok(pending)
  const receiptId = `router-operation:${pending.operationId}`
  const receipt = await h.query('receipt.get', { id: receiptId })
  assert.ok(receipt)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 1)
  const decisionRecord = h.residentStore.getRouterState(message.groupId).decisions.find(item => item.applications.some(app => app.operationId === pending.operationId))
  const altered = { ...pending.action, objective: `${pending.action.objective} 不同参数` }
  await assert.rejects(t.step(() => h.service.store.command({ id: receiptId, kind: 'router.task.apply', replay: true, args: {
    groupId: message.groupId, decisionId: decisionRecord.decisionId, operationId: pending.operationId, sourceRefs: pending.sourceRefs,
    action: altered, ownSourceFence: pending.sourceRefs.map(({ sourceId, messageId }) => ({ sourceId, groupId: message.groupId, messageId })),
    ownerActorId: 'native-user',
  } })), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  assert.deepEqual(await h.query('receipt.get', { id: receiptId }), receipt)
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, text: `${message.text} 修改后的内容` }))
  assert.equal(h.residentStore.getGroup(message.groupId).messages.find(item => item.messageId === message.messageId).messageVersion, 2)
  release.resolve()
  await t.step(() => h.service.whenIdle())
  h.residentStore.routerRecordApplication = record
  await t.step(() => h.service.recover())
  await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications)
    .some(item => item.operationId === pending.operationId && item.status === 'applied'), '等待原回执恢复'))
  assert.deepEqual(await h.query('receipt.get', { id: receiptId }), receipt)
  assert.equal((await h.query('task.list', { groupId: message.groupId })).filter(item => item.taskId === receipt.result.task.taskId).length, 1)
}))

for (const [actorChanged, v2NeedsProcessing] of [[false, false], [true, false], [false, true]]) testRunner(`Router 已成功动作先落失败后来源更新仍沿原回执恢复 actorChanged=${actorChanged} v2NeedsProcessing=${v2NeedsProcessing}`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'router-receipt-failed-edited-')
  let triaged = false
  const h = await t.step(() => fixture.host(request => {
    const calls = directRouterCalls(request)
    if (!calls) return [decision('wait', '等待')]
    if (calls[0].name === 'router_submit') return topicTaskCalls(request)
    if (calls[0].name !== 'triage_submit') return calls
    const needsProcessing = !triaged || v2NeedsProcessing
    triaged = true
    return [call('triage_submit', { needsProcessing, reply: null })]
  }))
  const record = h.residentStore.routerRecordApplication.bind(h.residentStore)
  h.residentStore.routerRecordApplication = async () => { throw new Error('TEST_BEFORE_ROUTER_ACK') }
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  const failure = await t.step(() => waitUntil(() => (h.residentStore.getRouterState(message.groupId).failures ?? [])
    .find(item => item.phase === 'host' && item.status === 'failed' && item.code === 'TEST_BEFORE_ROUTER_ACK'), '等待原 ACK 失败落账'))
  const operationId = failure.requestId, receiptId = `router-operation:${operationId}`
  const receipt = await h.query('receipt.get', { id: receiptId })
  assert.ok(receipt)
  const pending = h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications)
    .find(item => item.operationId === operationId)
  assert.equal(pending.status, 'pending')
  const changedActor = actorChanged ? 'other-actor' : message.senderOpenDingTalkId
  await t.step(() => h.service.ingest({ ...message, messageVersion: 2, senderOpenDingTalkId: changedActor, text: `${message.text} 修改后的内容` }))
  const latestMessage = h.residentStore.getGroup(message.groupId).messages.find(item => item.messageId === message.messageId)
  assert.equal(latestMessage.messageVersion, 2); assert.equal(latestMessage.senderOpenDingTalkId, changedActor)
  await assert.rejects(t.step(() => h.service.retryMessageProcessing({ groupId: message.groupId, messageId: message.messageId,
    messageVersion: 1, phase: failure.phase, requestId: operationId, token: failure.retryToken })), /MESSAGE_RETRY_STALE/)
  h.residentStore.routerRecordApplication = record
  try { await t.step(() => h.service.recover()) }
  catch (error) {
    const state = h.residentStore.getRouterState(message.groupId)
    t.diagnostic(JSON.stringify({ originalOperationId: operationId, failures: state.failures, decisions: state.decisions.map(item => ({
      decisionId: item.decisionId, applications: item.applications.map(app => ({ operationId: app.operationId, status: app.status, sourceRefs: app.sourceRefs })) })) }))
    throw error
  }
  if (actorChanged) {
    await t.step(() => waitUntil(() => {
      const state = h.residentStore.getRouterState(message.groupId)
      return !state.active && !state.queue.length && state.triage.some(item => item.sourceRef.messageVersion === 2 && item.disposition.needsProcessing === false)
    }, '等待不同作者的新来源静默完成'))
    const state = h.residentStore.getRouterState(message.groupId)
    assert.equal(state.failures.find(item => item.requestId === operationId).status, 'failed')
    assert.equal(state.decisions.flatMap(item => item.applications).find(item => item.operationId === operationId).status, 'pending')
    assert.deepEqual(await h.query('receipt.get', { id: receiptId }), receipt)
    assert.equal((await h.query('task.list', { groupId: message.groupId })).length, 1)
    return
  }
  try {
    await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications)
      .some(item => item.operationId === operationId && item.status === 'applied'), '等待原成功回执补账'))
  } catch (error) {
    const state = h.residentStore.getRouterState(message.groupId)
    t.diagnostic(JSON.stringify({ operationId, receiptPresent: !!(await h.query('receipt.get', { id: receiptId })),
      failure: state.failures?.find(item => item.requestId === operationId),
      application: state.decisions.flatMap(item => item.applications).find(item => item.operationId === operationId) }))
    throw error
  }
  assert.deepEqual(await h.query('receipt.get', { id: receiptId }), receipt)
  await t.step(() => waitUntil(() => !(h.residentStore.getRouterState(message.groupId).failures ?? []).some(item => item.requestId === operationId), '等待原失败清除'))
  assert.equal((await h.query('task.list', { groupId: message.groupId })).filter(item => item.taskId === receipt.result.task.taskId).length, 1)
  if (v2NeedsProcessing) await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).decisions.some(item =>
    item.applications.some(app => app.operationId !== operationId && app.status === 'applied'
      && app.sourceRefs?.some(ref => ref.messageId === message.messageId && ref.messageVersion === 2))), '等待新版本动作应用'))
}))

testRunner('真实 Host 根据完成与排空事实激活后续安排', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'router-arrangement-host-')
  const sourceId = `im:${createHash('sha256').update(JSON.stringify([message.groupId, message.messageId, 1])).digest('hex')}`
  const decide = request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit') || names.includes('router_submit')) {
      const input = latestInput(request)
      const pages = modelToolValues(request).filter(item => item.batchId === input.batchId && item.sourceId)
      for (const source of input.sources) {
        let offset = Math.min(1000, source.totalLength)
        while (offset < source.totalLength) {
          const page = pages.find(item => item.sourceId === source.sourceId && item.offset === offset)
          if (!page) return [call('router_source_read', { sourceId: source.sourceId, offset })]
          offset = page.nextOffset
        }
      }
    }
    if (names.includes('triage_submit')) return [call('triage_submit', { needsProcessing: true, reply: null })]
    if (names.includes('router_submit')) {
      const input = latestInput(request), arrangement = input.context?.arrangements?.[0]
      if (!arrangement) return [call('router_submit', { actions: [], arrangements: input.sources.length ? [{ sourceIds: [sourceId], title: '乙', objective: '完成乙', dependsOnTaskIds: ['task-a'] }] : [], continuity: [], reply: null })]
      const current = request.messages.slice(request.messages.findLastIndex(item => item.role === 'user'))
      const calls = current.flatMap(item => item.role === 'assistant' ? item.content ?? [] : []).filter(item => item.type === 'tool-call')
      if (!calls.some(item => item.name === 'router_source_read')) return [call('router_source_read', { sourceId, offset: 0 })]
      if (!calls.some(item => item.name === 'router_task_get')) return [call('router_task_get', { taskId: 'task-a' })]
      const loaded = modelToolValues({ ...request, messages: current }).findLast(item => item.task?.taskId === 'task-a')
      const task = loaded?.task
      const ready = task?.status === 'completed' && task.drained && !task.recovering
        && loaded.executions.every(item => item.drained && ['succeeded', 'failed', 'cancelled', 'stale'].includes(item.status))
        && loaded.operations.every(item => ['succeeded', 'failed', 'cancelled'].includes(item.state))
      const dependencies = ready ? [{ taskId: task.taskId, requirementRevision: task.requirementRevision, contextRevision: task.contextRevision,
        controlRevision: task.controlRevision, runSequence: task.runSequence }] : []
      return [call('router_submit', { actions: ready ? [{ kind: 'new-task', arrangementId: arrangement.arrangementId, sourceIds: [sourceId], dependencies }] : [], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) return [decision('complete', '任务已完成')]
    throw new Error(`unexpected_tools:${names.join(',')}`)
  }
  const h = await t.step(() => fixture.host(decide))
  await t.beginBusiness()
  await t.step(() => h.service.ingest(message))
  await t.step(async () => {
    try { await waitUntil(() => h.residentStore.getRouterState(message.groupId).arrangements?.[0], '等待后续安排') }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ alerts: h.service.listAlerts(), requests: h.requests.map(request => request.tools.map(tool => tool.name)), results: h.toolResults })}`) }
  })
  const arrangement = h.residentStore.getRouterState(message.groupId).arrangements[0]
  assert.equal(arrangement.status, 'waiting')
  assert.equal(await h.query('task.get', { taskId: arrangement.taskId }), null)
  let interrupted = false
  h.residentStore.routerRecordApplication = async () => { interrupted = true; throw new Error('TEST_BEFORE_RESIDENT_ACK') }
  await t.step(() => h.service.store.command({ id: 'seed-task-a', kind: 'task.create', args: { taskId: 'task-a', groupId: message.groupId, ownerActorId: 'native-user', sourceRefs: [sourceId], request: '完成甲' } }))
  await t.step(() => h.service.recover())
  await t.step(() => waitUntil(() => interrupted, '等待 SQLite 成功后 Resident ACK 中断'))
  const pending = h.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications).find(item => item.action?.taskId === arrangement.taskId)
  assert.equal(pending.status, 'pending')
  assert.ok(await h.query('receipt.get', { id: `router-operation:${pending.operationId}` }))
  assert.equal((await h.query('task.get', { taskId: 'task-a' })).status, 'completed')
  assert.equal((await h.query('task.list', { groupId: message.groupId })).filter(item => item.taskId === arrangement.taskId).length, 1)
  await t.step(() => h.close())
  const resumed = await t.step(() => fixture.host(decide, { initialize: false }))
  await t.step(() => resumed.service.recover())
  await t.step(() => resumed.service.whenIdle())
  const settled = resumed.residentStore.getRouterState(message.groupId).decisions.flatMap(item => item.applications).find(item => item.operationId === pending.operationId)
  assert.equal(settled.status, 'applied')
  assert.equal((await resumed.query('task.list', { groupId: message.groupId })).filter(item => item.taskId === arrangement.taskId).length, 1)
}))

for (const completedFirst of [false, true]) testRunner(`Web 任务完成与排空后唤醒 IM 安排 completedFirst=${completedFirst}`, { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  t.onCancel(() => release.resolve())
  t.after(() => release.resolve())
  const fixture = await nativeCase(t, 'router-web-dependency-')
  const sourceId = `im:${createHash('sha256').update(JSON.stringify([message.groupId, message.messageId, 1])).digest('hex')}`
  let aId, held = false
  const h = await t.step(() => fixture.host(async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) return directRouterCalls(request)
    if (names.includes('router_submit')) {
      const input = latestInput(request), arrangement = input.context?.arrangements?.[0]
      if (!arrangement) {
        const calls = directRouterCalls(request)
        if (calls[0].name === 'router_source_read') return calls
        return [call('router_submit', { actions: [], arrangements: input.sources.length ? [{ sourceIds: [sourceId], title: '乙', objective: '完成乙', dependsOnTaskIds: [aId] }] : [], continuity: [], reply: null })]
      }
      const current = request.messages.slice(request.messages.findLastIndex(item => item.role === 'user'))
      const calls = current.flatMap(item => item.role === 'assistant' ? item.content ?? [] : []).filter(item => item.type === 'tool-call')
      if (!calls.some(item => item.name === 'router_source_read')) return [call('router_source_read', { sourceId, offset: 0 })]
      if (!calls.some(item => item.name === 'router_task_get')) return [call('router_task_get', { taskId: aId })]
      const loaded = modelToolValues({ ...request, messages: current }).findLast(item => item.task?.taskId === aId)
      const task = loaded?.task
      const ready = task?.status === 'completed' && task.drained && !task.recovering
        && loaded.executions.every(item => item.drained && ['succeeded', 'failed', 'cancelled', 'stale'].includes(item.status))
        && loaded.operations.every(item => ['succeeded', 'failed', 'cancelled'].includes(item.state))
      const dependencies = ready ? [{ taskId: task.taskId, requirementRevision: task.requirementRevision, contextRevision: task.contextRevision,
        controlRevision: task.controlRevision, runSequence: task.runSequence }] : []
      return [call('router_submit', { actions: ready ? [{ kind: 'new-task', arrangementId: arrangement.arrangementId, sourceIds: [sourceId], dependencies }] : [], continuity: [], reply: null })]
    }
    if (names.includes('task_session_submit')) {
      const input = latestInput(request)
      if (input.task.objective === '完成甲' && !held) { held = true; entered.resolve(); await release.promise }
      return [decision('complete', '任务已完成')]
    }
    throw new Error(`unexpected_tools:${names.join(',')}`)
  }))
  await t.beginBusiness()
  const unrelated = await t.step(() => h.service.createTask({ groupId: message.groupId, requestId: 'web-unrelated', objective: '无关任务' }))
  await t.step(() => h.service.whenIdle())
  assert.ok(!(h.residentStore.getGroup(message.groupId).routerFacts ?? []).some(item => item.fact.taskId === unrelated.taskId))
  const a = await t.step(() => h.service.createTask({ groupId: message.groupId, requestId: 'web-a', objective: '完成甲' }))
  aId = a.taskId
  await t.step(() => entered.promise)
  if (completedFirst) { release.resolve(); await t.step(() => h.service.whenIdle()) }
  await t.step(() => h.service.ingest(message))
  await t.step(() => waitUntil(() => h.residentStore.getRouterState(message.groupId).arrangements?.[0], '等待真实来源安排'))
  const arrangement = h.residentStore.getRouterState(message.groupId).arrangements[0]
  if (!completedFirst) {
    assert.equal(arrangement.status, 'waiting')
    assert.equal(await h.query('task.get', { taskId: arrangement.taskId }), null)
    release.resolve()
  }
  await t.step(() => waitUntil(async () => (await h.query('task.get', { taskId: arrangement.taskId }))?.status === 'completed', '等待依赖安排完成'))
  await t.step(() => h.service.whenIdle())
  await t.step(() => h.service.recover())
  await t.step(() => h.service.recover())
  await t.step(() => h.service.whenIdle())
  assert.equal((await h.query('task.list', { groupId: message.groupId })).filter(item => item.taskId === arrangement.taskId).length, 1)
  assert.ok(!(h.residentStore.getGroup(message.groupId).routerFacts ?? []).some(item => [aId, unrelated.taskId].includes(item.fact.taskId)))
}))

testRunner('Web 新建任务直接落账且重复请求不创建 Topic', { timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'web-direct-task-')
  const h = await t.step(() => fixture.host(request => {
    const required = requiredDecisionRead(request, latestInput(request))
    return required ? [required] : [decision('complete', '完成')]
  }))
  await t.beginBusiness()
  const args = { groupId: 'native-group', requestId: 'web-direct-request', objective: '核对结果' }
  const first = await t.step(() => h.service.createTask(args))
  const again = await t.step(() => h.service.createTask(args))
  assert.equal(again.taskId, first.taskId)
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  assert.equal((await h.query('task.list', { groupId: 'native-group' })).length, 1)
  await assert.rejects(t.step(() => h.service.createTask({ ...args, objective: '不同请求' })), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await t.step(() => h.service.whenIdle())
  assert.equal((await h.query('task.get', { taskId: first.taskId })).status, 'completed')
  assert.equal(h.service.listAlerts().length, 0, JSON.stringify(h.service.listAlerts()))
}))

testRunner('Web 取消成功回执恢复排空旧 Owner 且不取消新版本', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await mkdtemp(join(tmpdir(), 'web-cancel-receipt-'))
  const backing = await t.step(() => openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const releases = [Promise.withResolvers(), Promise.withResolvers()]
  const entered = [Promise.withResolvers(), Promise.withResolvers()]
  let h
  t.onCancel(() => releases.forEach(gate => gate.resolve()))
  t.after(async () => { releases.forEach(gate => gate.resolve()); await h?.close(); await backing.close(); await rm(root, { recursive: true, force: true }) })
  let inject = true, ownerRuns = 0
  const store = { ...backing, async command(input) {
    const receipt = await backing.command(input)
    if (inject && input.kind === 'task.control') { inject = false; throw new Error('TEST_AFTER_CONTROL_COMMIT') }
    return receipt
  } }
  h = await t.step(() => nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const index = ownerRuns++
      if (index < 2) { entered[index].resolve(); await releases[index].promise }
      return [decision('wait', '等待')]
    }
    return []
  }, { store }))
  await t.beginBusiness()
  const created = await t.step(() => h.service.createTask({ groupId: 'native-group', requestId: 'cancel-recovery-create', objective: '等待取消' }))
  await t.step(() => entered[0].promise)
  const original = await h.query('task.get', { taskId: created.taskId })
  const live = h.ctx.agents.get(original.sessionId), agent = live?.agent ?? live
  assert.ok(agent)
  const cancel = agent.cancel.bind(agent), cancelStarted = Promise.withResolvers()
  let cancelCalls = 0
  agent.cancel = (...args) => { cancelCalls++; cancelStarted.resolve(); return cancel(...args) }
  const args = { taskId: created.taskId, requestId: 'cancel-recovery', reason: '停止', expectedControlRevision: 1 }
  await assert.rejects(t.step(() => h.service.cancelTask(args)), /TEST_AFTER_CONTROL_COMMIT/)
  const committed = await h.query('task.get', { taskId: created.taskId })
  assert.equal(committed.controlRevision, 2)
  const retry = h.service.cancelTask(args)
  await t.step(() => cancelStarted.promise)
  releases[0].resolve()
  const cancelled = await t.step(() => retry)
  assert.equal(cancelled.control, 'cancelled')
  await t.step(() => h.service.whenIdle())
  const drained = await h.query('task.get', { taskId: created.taskId })
  assert.equal(drained.drained, true)
  assert.equal(drained.controlRevision, 2)
  assert.ok(cancelCalls > 0)
  assert.ok((await h.query('execution.list', { taskId: created.taskId })).every(item => item.drained))
  await t.step(() => h.service.reopenTask({ taskId: created.taskId, requestId: 'cancel-recovery-reopen', context: '重新开始', expectedRequirementRevision: drained.requirementRevision, expectedControlRevision: drained.controlRevision }))
  await t.step(() => entered[1].promise)
  const newer = await h.query('task.get', { taskId: created.taskId })
  const newerLive = h.ctx.agents.get(newer.sessionId), newerAgent = newerLive?.agent ?? newerLive
  assert.ok(newerAgent)
  const newerCancel = newerAgent.cancel.bind(newerAgent)
  let newerCancelCalls = 0
  newerAgent.cancel = (...args) => { newerCancelCalls++; return newerCancel(...args) }
  await t.step(() => h.service.cancelTask(args))
  assert.equal(newerCancelCalls, 0)
  const afterReplay = await h.query('task.get', { taskId: created.taskId })
  assert.equal(afterReplay.controlRevision, newer.controlRevision)
  assert.equal(afterReplay.requirementRevision, newer.requirementRevision)
  releases[1].resolve()
  await t.step(() => h.service.whenIdle())
}))

testRunner('Web 追加、重开及取消直接修改原 Task', { timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  assert.ok(available, reason)
  const fixture = await nativeCase(t, 'web-direct-actions-')
  const h = await t.step(() => fixture.host(request => {
    const input = latestInput(request), required = requiredDecisionRead(request, input)
    if (required) return [required]
    return [decision(input.task?.taskId === 'seed-active' ? 'wait' : 'complete', '已处理')]
  }))
  await t.beginBusiness()
  const first = await t.step(() => h.service.createTask({ groupId: 'native-group', requestId: 'web-create', objective: '完成甲' }))
  await t.step(() => h.service.whenIdle())
  const reopened = await t.step(() => h.service.reopenTask({ taskId: first.taskId, requestId: 'web-reopen', context: '继续核对', expectedRequirementRevision: 1, expectedControlRevision: 1 }))
  assert.equal(reopened.taskId, first.taskId)
  assert.equal(reopened.requirementRevision, 2)
  await t.step(() => h.service.whenIdle())
  await t.step(() => h.service.store.command({ kind: 'task.create', id: 'seed-active', args: { taskId: 'seed-active', groupId: 'native-group', ownerActorId: 'native-user', request: '原任务' } }))
  const updated = await t.step(() => h.service.appendTaskContext({ taskId: 'seed-active', requestId: 'web-append', context: '补充', progressImpact: 'preserve', expectedRequirementRevision: 1, expectedControlRevision: 1 }))
  assert.equal(updated.requirementRevision, 1)
  assert.equal(updated.contextRevision, 1)
  const cancelled = await t.step(() => h.service.cancelTask({ taskId: 'seed-active', requestId: 'web-cancel', reason: '停止' }))
  assert.equal(cancelled.control, 'cancelled')
  assert.equal(h.residentStore.listTopics('native-group').length, 0)
  await t.step(() => h.service.whenIdle())
  assert.equal((await h.query('task.list', { groupId: 'native-group' })).length, 2)
}))

test('owner injects one authoritative source body across task, Web identity and materials', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-content-index-')
  const body = ('AUTHORIZATION_CORRECTION: analyze only; ' + 'boundary evidence '.repeat(150)).trim()
  const counts = [], metrics = []
  const h = await fixture.host(async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const text = JSON.stringify(request.messages)
    counts.push(text.split(body).length - 1)
    const bytes = messages => Buffer.byteLength(JSON.stringify(messages))
    metrics.push({ currentHostBytes: bytes(request.messages.filter(message => message.source?.taskSession && !message.source.taskContextHistory)),
      oldHostBytes: bytes(request.messages.filter(message => message.source?.taskContextHistory)), toolHistoryBytes: bytes(request.messages.filter(message => message.role === 'tool')),
      systemBytes: bytes(request.messages.filter(message => message.role === 'system')), schemaBytes: Buffer.byteLength(JSON.stringify(request.tools)), adapterRequestBytes: Buffer.byteLength(JSON.stringify(request)) })
    const required = requiredDecisionRead(request, latestInput(request))
    if (required) return [required]
    return [decision('complete', 'only analysis')]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'indexed-web', objective: body, context: body }))
  await t.step(async () => h.service.whenIdle())
  assert.ok(counts.length > 0, JSON.stringify(h.service.listAlerts()))
  t.diagnostic(JSON.stringify({ scope: 'actual native owner scripted adapter UTF-8 JSON bytes', bodyCopies: counts, metrics }))
  assert.equal(counts[0], 0, 'long authority is explicitly marked for lossless read')
  assert.ok(counts.every(count => count === 0), 'targeted native reads do not reinject the entire long authority body')
  assert.ok(h.toolResults.some(result => result.name === 'read'), 'the existing native file reader is used')
  assert.equal(h.service.listAlerts().length, 0, JSON.stringify(h.service.listAlerts()))
  const [source] = await t.step(async () => h.query('source.list')), [task] = await t.step(async () => h.query('task.list'))
  assert.equal(source.text, body)
  assert.equal(source.requestIdentity.request.args.context, body, 'Web admission identity remains raw in the ledger')
  const dto = await t.step(async () => h.service.taskDetail(task.taskId))
  assert.equal(dto.request, task.request)
  assert.deepEqual(dto.completion, task.completion, 'Observer still receives the original task completion')
  assert.equal(dto.executions.length, 0)
  assert.equal(task.status, 'completed', 'A direct analysis task does not need an execution member')
  assert.equal((await t.step(async () => h.query('execution.list', { taskId: task.taskId }))).length, 0)
  const saved = await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))
  const current = h.requests.at(-1).messages.find(message => message.source?.taskSession && !message.source.taskContextHistory)
  const raw = saved.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => message.id === current.source.rawHostMessageId)
  assert.ok(raw)
  assert.ok(raw.content[0].text.split(body).length - 1 > 1, 'raw admission audit is not deduplicated to shrink display')
  assert.equal(JSON.parse(raw.content[0].text).sources[0].requestIdentity.request.args.context, body)
}))

test('不同群成员续办已完成任务，提交拒绝后精确重试保留原任务和会话', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  let h, backing, original, block = true
  t.after(async () => { await h?.close(); await backing?.close() })
  const fixture = await nativeCase(t, 'task-topic-auth-')
  await t.beginBusiness()
  backing = await t.step(async () => openDynamicTaskStore({ dbPath: join(fixture.root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const store = { ...backing, command(input) {
    if (block && input.kind === 'router.task.apply' && input.args.action.kind === 'task-reopen') throw new Error('TEST_SOURCE_AUTH_REJECTED')
    return backing.command(input)
  } }
  h = await t.step(async () => fixture.host(async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) return directRouterCalls(request)
    if (names.includes('router_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const sourceIds = input.context?.newSourceIds ?? []
      if (!original || !sourceIds.length) return original ? [call('router_submit', { actions: [], continuity: [], reply: null })] : topicTaskCalls(request)
      const loaded = modelToolValues(request).findLast(item => item.task?.taskId === original.taskId)
      if (!loaded) return [call('router_task_get', { taskId: original.taskId })]
      const task = loaded.task
      const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceIds[0] && Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', { sourceId: sourceIds[0] })]
      return [call('router_submit', { actions: [{ kind: 'task-reopen', taskId: task.taskId, sourceIds,
        inputVersion: task.requirementRevision, runSequence: task.runSequence, expectedControlRevision: task.controlRevision,
        context: '部署原修复到UAT2', objective: '部署原修复到UAT2', acceptanceCriteria: ['核验实际运行版本'] }], continuity: [],
        reply: { sourceId: sourceIds[0], text: '沿原任务部署UAT2。', review: { kind: 'substantive',
          reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    if (original) assert.equal(input.task.sessionId, original.sessionId)
    return [decision('complete', original ? '已处理原任务续办' : '修复已完成，未部署')]
  }, { store }))
  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  await t.step(async () => waitUntil(async () => (await h.query('task.list'))[0]?.status === 'completed', '等待原任务完成'))
  ;[original] = await t.step(async () => h.query('task.list'))
  const followup = { ...message, messageId: 'deploy-followup', senderOpenDingTalkId: 'colleague', text: '测试助手，部署原修复到UAT2', occurredAt: '2026-10-13T10:02:00Z' }
  await t.step(async () => h.service.ingest(followup))
  const failure = await t.step(async () => waitUntil(() => (h.residentStore.getRouterState(message.groupId).failures ?? [])
    .find(item => item.phase === 'host' && item.code === 'TEST_SOURCE_AUTH_REJECTED'), '等待续办提交失败'))
  const blocked = h.residentStore.getRouterState(message.groupId).decisions.find(item => item.applications.some(app => app.operationId === failure.requestId))
  const application = blocked.applications.find(item => item.operationId === failure.requestId)
  assert.equal(application.status, 'pending')
  assert.equal((await h.query('task.get', { taskId: original.taskId })).requirementRevision, 1)
  const retryArgs = { groupId: message.groupId, messageId: followup.messageId, messageVersion: 1,
    phase: failure.phase, requestId: failure.requestId, token: failure.retryToken }
  const sentBeforeRetry = h.sent.length
  block = false
  await t.step(async () => h.service.retryMessageProcessing(retryArgs))
  await t.step(async () => waitUntil(async () => (await h.query('task.get', { taskId: original.taskId }))?.runSequence === 2, '等待原任务续办'))
  await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list'))
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(task.taskId, original.taskId); assert.equal(task.sessionId, original.sessionId)
  assert.equal(task.ownerActorId, 'native-user'); assert.equal(task.runSequence, 2)
  assert.equal(task.requirementRevision, 2); assert.equal(task.status, 'completed')
  const recovered = h.residentStore.getRouterState(message.groupId).decisions.find(item => item.decisionId === blocked.decisionId)
  assert.equal(recovered.applications.find(item => item.operationId === application.operationId).status, 'applied')
  await t.step(() => waitUntil(() => h.sent.length > sentBeforeRetry, '等待续办回复发送'))
  await assert.rejects(t.step(() => h.service.retryMessageProcessing(retryArgs)), /MESSAGE_RETRY_STALE/)
  assert.equal((await h.query('task.get', { taskId: original.taskId })).runSequence, 2)
}))

for (const audience of ['operator', 'requester']) testRunner(`直接来源补充保留待答问题及已送达回复 audience=${audience}`, { timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  const fixture = await nativeCase(t, 'task-direct-waiting-')
  let h, original, ownerCalls = 0
  const reviews = []
  const model = async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) return directRouterCalls(request)
    if (names.includes('router_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const sourceIds = input.context?.newSourceIds ?? []
      if (!original) return topicTaskCalls(request)
      if (!sourceIds.length) return [call('router_submit', { actions: [], continuity: [], reply: null })]
      const loaded = modelToolValues(request).findLast(item => item.task?.taskId === original.taskId)
      if (!loaded) return [call('router_task_get', { taskId: original.taskId })]
      const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceIds[0] && Array.isArray(item.candidates))
      if (!reviewed) return [call('router_reply_review_get', { sourceId: sourceIds[0] })]
      return [call('router_submit', { actions: [{ kind: 'task-context', taskId: original.taskId, sourceIds,
        inputVersion: loaded.task.requirementRevision, runSequence: loaded.task.runSequence,
        expectedControlRevision: loaded.task.controlRevision, context: '先核对分支，不是批准例外', progressImpact: 'preserve' }], continuity: [],
        reply: { sourceId: sourceIds[0], text: '已补入原任务，先核对正确分支。', review: { kind: 'substantive',
          reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    ownerCalls++
    if (!input.task.humanRequests.length) return [call('task_request_human', { audience, reason: '需要核对开发来源',
      question: '是否批准分支例外？', evidence: [], attemptedActions: ['核对原始交办'] })]
    assert.ok(input.humanReview)
    reviews.push(structuredClone(input.humanReview))
    assert.equal(input.task.sessionId, original.sessionId)
    assert.ok(input.sources.some(source => input.humanReview.sourceIds.includes(source.sourceId) && source.messageId === 'manual-direct-followup'))
    return [decision('wait', '补充并非批准，保留原待答问题')]
  }
  await t.beginBusiness()
  h = await t.step(() => fixture.host(model, { config: { assistantActorId: 'native-user' } }))
  await t.step(() => h.service.ingest(message))
  original = await t.step(() => waitUntil(async () => {
    const task = (await h.query('task.list'))[0]
    return task?.humanRequests?.[0]?.status === 'waiting-reply' && task.drained ? task : null
  }, '等待原问题和 Owner 排空'))
  const history = { ...message, messageId: 'unadmitted-history', text: '未选择的历史消息', occurredAt: new Date().toISOString() }
  await t.step(() => h.residentStore.ingest(history))
  const followup = { ...message, messageId: 'manual-direct-followup', senderOpenDingTalkId: audience === 'requester' ? 'colleague' : 'native-user',
    text: '先核对分支，不是批准例外', occurredAt: new Date().toISOString(), timestamp: new Date().toISOString() }
  await t.step(() => h.service.ingest(followup))
  let task = await t.step(() => waitUntil(async () => {
    const current = await h.query('task.get', { taskId: original.taskId })
    return current.contextRevision > (original.contextRevision ?? 0) && current.drained ? current : null
  }, '等待补充及 Owner 排空'))
  const source = (await h.query('source.list')).find(item => item.messageId === followup.messageId)
  assert.ok(source)
  if (audience === 'requester') task = await t.step(() => waitUntil(async () => {
    const current = await h.query('task.get', { taskId: original.taskId })
    const wakes = await h.query('wake.list', { taskId: original.taskId })
    return current.drained && current.lastDecision?.action === 'wait' && wakes.some(wake => wake.kind === 'task.supplement'
      && wake.payload?.humanRequestId === original.humanRequests[0].requestId && wake.payload.sourceIds?.includes(source.sourceId)
      && wake.state === 'acked') ? current : null
  }, '等待对应来源的只读复核落账及排空'))
  assert.ok(task.sourceRefs.includes(source.sourceId))
  assert.ok(!(await h.query('source.list')).some(item => item.messageId === history.messageId))
  assert.equal(task.taskId, original.taskId); assert.equal(task.sessionId, original.sessionId)
  assert.equal(task.requirementRevision, original.requirementRevision); assert.equal(task.controlRevision, original.controlRevision)
  assert.equal(task.runSequence, original.runSequence); assert.equal(task.ownerActorId, original.ownerActorId)
  assert.equal(task.humanRequests[0].requestId, original.humanRequests[0].requestId)
  assert.equal(task.humanRequests[0].status, 'waiting-reply')
  if (audience === 'operator') assert.equal(ownerCalls, 1)
  else {
    await t.step(() => waitUntil(() => reviews.some(review => review.sourceIds.includes(source.sourceId)), '等待只读复核'))
    assert.ok(reviews.every(review => review.requestId === original.humanRequests[0].requestId))
  }
  assert.equal((await h.query('execution.list', { taskId: task.taskId })).length, 0)
  const delivered = await t.step(() => waitUntil(async () => {
    const sent = h.sent.find(item => item.kind === 'router-reply' && item.payload.text === '已补入原任务，先核对正确分支。')
    if (!sent) return null
    const notification = await h.query('notification.get', { notificationId: sent.id })
    return notification?.state === 'delivered' ? notification : null
  }, '等待原 Router 回复送达'))
  const notificationId = delivered.id
  const settled = () => waitUntil(async () => {
    const router = h.residentStore.getRouterState(message.groupId), group = h.residentStore.getGroup(message.groupId)
    const facts = (group.routerFacts ?? []).map(item => item.fact).filter(fact => fact.taskId === task.taskId)
    const drainVersion = audience === 'operator' ? original : task
    const hasDrain = facts.some(fact => fact.kind === 'drained' && ['requirementRevision', 'contextRevision', 'controlRevision', 'runSequence']
      .every(key => (fact.taskVersion?.[key] ?? 0) === (drainVersion[key] ?? 0)))
    const decided = facts.every(fact => router.decisions.some(item => item.inputs?.some(input => input.kind === 'fact'
      && input.id === fact.factId && input.digest === fact.factDigest) && item.applications.every(app => app.status === 'applied')))
    const replyDecision = router.decisions.find(item => item.applications.some(app => app.kind === 'reply' && app.status === 'applied'
      && app.receipt?.notificationId === notificationId))
    const currentSource = await h.query('source.get', { sourceId: source.sourceId })
    if (!replyDecision || !hasDrain || !decided || router.active || router.queue.length || !currentSource?.routed) return false
    return { decision: replyDecision, facts: facts.map(({ factId, factDigest }) => ({ factId, factDigest })) }
  }, '等待回复、来源和 Task facts 完成 Router 应用')
  const baseline = await t.step(settled)
  const decisionRecord = baseline.decision
  const applications = structuredClone(decisionRecord.applications), sentBefore = h.sent.length
  const receipt = structuredClone(delivered.receipt)
  await t.step(() => h.close())
  h = await t.step(() => fixture.host(model, { initialize: false, config: { assistantActorId: 'native-user' } }))
  await t.step(() => h.service.recover()); await t.step(() => h.service.whenIdle())
  await t.step(() => h.service.ingest(followup)); await t.step(() => h.service.whenIdle())
  const afterReplay = await t.step(settled)
  assert.deepEqual(afterReplay.facts, baseline.facts)
  assert.equal(afterReplay.decision.decisionId, decisionRecord.decisionId)
  assert.deepEqual(afterReplay.decision.applications, applications)
  const recovered = await h.query('notification.get', { notificationId })
  assert.equal(recovered.state, 'delivered'); assert.deepEqual(recovered.receipt, receipt)
  const tasksAfterRecovery = await h.query('task.list')
  assert.equal(tasksAfterRecovery.length, 1); assert.equal(tasksAfterRecovery[0].contextRevision, task.contextRevision)
  assert.deepEqual(tasksAfterRecovery[0].sourceRefs, task.sourceRefs)
  assert.equal(tasksAfterRecovery[0].humanRequests[0].requestId, original.humanRequests[0].requestId)
  assert.equal(tasksAfterRecovery[0].humanRequests[0].status, 'waiting-reply')
  assert.equal(tasksAfterRecovery[0].humanRequests[0].question, original.humanRequests[0].question)
  assert.equal(h.sent.length, 0)
  const echo = await t.step(() => h.service.ingest({ ...message, messageId: receipt.messageId, text: '已补入原任务，先核对正确分支。' }))
  assert.equal(echo.reason, 'own-notification')
  await t.step(() => h.service.recover()); await t.step(() => h.service.whenIdle())
  assert.equal(h.sent.length, 0); assert.ok(sentBefore > 0)
}))

test('180 legacy task Host markers retire without changing audit or foreign context, including compacted surface replay', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  await t.beginBusiness()
  const { createUserMessage, createSystemMessage } = await t.step(async () => import('@deepseek-ai/dsh-llm'))
  const { foldSurface, deriveEventMessage } = await t.step(async () => import('@deepseek-ai/dsh-session'))
  const fixture = await t.step(async () => nativeCase(t, 'task-host-retirement-'))
  const h = await t.step(async () => fixture.host(async () => []))
  const binding = { taskId: 'retirement-task', sessionId: 'retirement-session', leaseEpoch: 181 }
  const session = h.ctx.sessions.prepare(binding.sessionId)
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('native protected head') }, { surfaceOp: 'append' })
  const append = (source, value, options = { surfaceOp: 'append' }) => session.append('user/message', createUserMessage({ source,
    content: [{ type: 'text', text: JSON.stringify(value) }] }), options)
  for (let i = 1; i <= 180; i++) append({ kind: 'coordinator', taskSession: { ...binding, leaseEpoch: i }, taskContextHistory: true },
    { historicalTaskContext: { leaseEpoch: i }, instruction: '此轮Host快照已替换，原文留审计' })
  append({ kind: 'coordinator', taskSession: { ...binding, taskId: 'foreign-task' }, taskContextHistory: true }, { instruction: 'FOREIGN_TASK_AUDIT' })
  const original = structuredClone(session.snapshotEvents())
  const messages = () => { const events = session.snapshotEvents(), folded = foldSurface(events)
    return folded.nodes.map(seq => deriveEventMessage(events[seq], folded.projectedMessages)).filter(Boolean) }
  const beforeBytes = Buffer.byteLength(JSON.stringify(messages()))
  retireTaskContext(session, binding, { turn: 1, step: 1 })
  const current = { task: { taskId: binding.taskId }, sources: [
    { sourceId: 'initial', actorId: 'requester', text: '原授权：仅UAT隔离验证' },
    { sourceId: 'restriction', actorId: 'operator', text: '后续收窄：暂停部署，只继续准备' }], unknownOperation: 'UNKNOWN_EFFECT_RETAINED' }
  append({ kind: 'coordinator', taskSession: binding }, current)
  const live = messages(), afterBytes = Buffer.byteLength(JSON.stringify(live))
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  assert.equal(live.filter(item => item.source?.taskSession?.taskId === binding.taskId).length, 1)
  assert.equal(live.filter(item => item.source?.taskContextHistory).length, 1, '其他任务的占位不动')
  assert.match(JSON.stringify(live), /FOREIGN_TASK_AUDIT/)
  assert.deepEqual(JSON.parse(live.find(item => item.source?.taskSession?.taskId === binding.taskId).content[0].text), current)
  assert.ok(beforeBytes - afterBytes > 30000, '删除旧占位确实降低总可见内容，而不是换位置')
  // 用SDK公开surface替换模拟压缩已移除旧Host；新输入仍必须全文独立，不能依赖已消失基线。
  const hostNode = session.surface.nodes.find(seq => session.snapshotEvents()[seq].data?.source?.taskSession?.taskId === binding.taskId)
  append({ kind: 'runtime-context', form: 'snapshot' }, { summary: 'COMPACTED_CONTEXT' },
    { surfaceOp: { op: 'replace', startSeq: hostNode, endSeq: hostNode }, sourceEventSeqs: [hostNode] })
  retireTaskContext(session, { ...binding, leaseEpoch: 182 }, { turn: 1, step: 1 })
  append({ kind: 'coordinator', taskSession: { ...binding, leaseEpoch: 182 } }, current)
  const restored = messages()
  assert.match(JSON.stringify(restored), /COMPACTED_CONTEXT/)
  assert.deepEqual(JSON.parse(restored.find(item => item.source?.taskSession?.taskId === binding.taskId).content[0].text), current)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  t.diagnostic(JSON.stringify({ scope: 'actual native foldSurface UTF-8 JSON message bytes; source/task identity retained',
    legacyHostCount: 180, beforeBytes, afterBytes, newInputBytes: Buffer.byteLength(JSON.stringify(current)), retainedBaselineBytes: 0,
    afterCompactionBytes: Buffer.byteLength(JSON.stringify(restored)), rawAuditEvents: session.snapshotEvents().length }))
}))

test('owner keeps one current Host snapshot and delegates non-recursive execution context across three generations', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-context-native-'), ownerRequests = []
  const scope = 'CURRENT_AUTHORIZATION_SCOPE_'.repeat(100)
  const h = await fixture.host(async request => {
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      ownerRequests.push(structuredClone(request))
      const snapshots = request.messages.filter(message => message.role === 'user').flatMap(message => message.content ?? [])
        .filter(block => block.type === 'text').flatMap(block => { try { const value = JSON.parse(block.text); return value.task && value.executions ? [value] : [] } catch { return [] } })
      assert.equal(snapshots.length, 1, '原生模型可见面只保留当前完整Host快照')
      assert.ok(latestInput(request).sources.some(source => source.readRequired || JSON.stringify(source).includes('CURRENT_AUTHORIZATION_SCOPE_')))
      const required = requiredDecisionRead(request, input)
      if (required) return [required]
      for (const execution of input.executions) {
        assert.equal(execution.input?.previousExecutions, undefined)
        assert.equal(execution.input?.context, undefined)
        assert.equal(execution.definition, undefined)
        assert.equal(execution.results, undefined)
        if (execution.resultRef || execution.resultInCatalog) {
          const resultRef = execution.resultRef ?? input.catalogRef
          const resultPath = execution.resultRef ? '/payload/output/summary' : '/executions/' + execution.executionId + '/result/payload/output/summary'
          const page = modelToolValues(request).find(value => value.contentRef === resultRef.contentRef && value.path === resultPath)
          if (!page) return [call('model_content_read', { contentRef: resultRef.contentRef, path: resultPath })]
          assert.equal(page.text, execution.key, 'original result is read through the admitted content tool')
        }
      }
      if (input.executions.some(execution => !execution.drained || execution.status !== 'succeeded')) return [decision('wait', '等待原执行结果')]
      if (input.executions.length === 3) return [decision('complete', '三代执行结果已核验')]
      const key = 'generation-' + input.executions.length
      return [call('task_delegate', { key, objective: key }), decision('wait', '等待原执行结果')]
    }
    for (const previous of input.previousExecutions) {
      assert.equal(previous.input.previousExecutions, undefined)
      assert.equal(previous.definition, undefined)
      assert.equal(previous.results, undefined)
    }
    return [call('execution_submit', { output: { status: 'completed', summary: input.objective, evidence: [], limitations: [], artifacts: [] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message, text: message.text + scope })); await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list'))
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))
  assert.ok(log.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession && !event.data.source.taskContextHistory).length >= 4,
    '原始Host输入仍在审计日志')
  const { foldSurface, deriveEventMessage } = await t.step(async () => import('@deepseek-ai/dsh-session'))
  const folded = foldSurface(log.events)
  const visible = folded.nodes.map(seq => deriveEventMessage(log.events[seq], folded.projectedMessages)).filter(Boolean)
  assert.equal(visible.filter(message => message.source?.taskSession).length, 1)
  assert.equal(visible.filter(message => message.source?.taskContextHistory).length, 0)
  const last = ownerRequests.at(-1)
  console.log(JSON.stringify({ contextProof: { ownerRequests: ownerRequests.length,
    latestInputBytes: Buffer.byteLength(JSON.stringify(latestInput(last))), totalRequestBytes: Buffer.byteLength(JSON.stringify(last)) } }))
}))

// Full baseline and current native runs need about 140s for 32 generations and independent verification.
test('32 continuations bound owner Host input and execution-read tool results while preserving authority and unknown effects', { ...({ timeout: 240000 }), timeout: nativeLifecycleTimeout(240000) }, nativeLifecycle(240000, async (t) => {
  const fixture = await nativeCase(t, 'task-five-context-'), metrics = []
  const team = nativeVerificationTeam()
  let ownerSteps = 0
  const scope = 'ONLY_ANALYZE_AUTHORIZATION_'.repeat(300)
  const h = await fixture.host(async (request, serviceHost) => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const input = latestInput(request)
    const verification = team.execute(request, input); if (verification) return verification
    if (!request.tools.some(tool => tool.name === 'task_delegate')) return [call('execution_submit', { output: { status: 'completed', summary: 'done-' + input.objective, evidence: ['UNKNOWN_EFFECT: observed, never replay'], limitations: ['analysis only'], artifacts: [] } })]
    const host = request.messages.filter(m => m.source?.taskSession && !m.source.taskContextHistory)
    assert.equal(host.length, 1)
    assert.ok(input.sources.some(source => source.readRequired || JSON.stringify(source).includes('ONLY_ANALYZE_AUTHORIZATION_')))
    const required = requiredDecisionRead(request, input)
    if (required) return [required]
    for (const e of input.executions) {
      assert.equal(e.input?.previousExecutions, undefined); assert.equal(e.input?.context, undefined); assert.equal(e.results, undefined); assert.equal(e.inputHistory, undefined)
    }
    const execution = input.executions[0]
    const values = request.messages.filter(m => m.role === 'tool').flatMap(m => m.content).filter(b => b.type === 'text').flatMap(b => { try { return [JSON.parse(b.text)] } catch { return [] } })
    const reads = values.filter(value => value.executionId && value.record)
    if (++ownerSteps > 200) throw new Error(JSON.stringify({ inputVersion: execution?.inputVersion, values: values.slice(-3).map(value => ({ keys: Object.keys(value), inputVersion: value.inputVersion, contentRef: value.contentRef, record: value.record })) }))
    for (const e of reads) { assert.ok(e.record.contentRef); assert.equal(e.input, undefined); assert.equal(e.results, undefined) }
    const currentHost = host[0].content.find(block => block.type === 'text').text
    const retainedHost = request.messages.filter(m => m.source?.taskSession && m !== host[0])
    assert.equal(retainedHost.length, 0, '退休快照不留下历史占位或隐含基线')
    metrics.push({ lease: input.task.leaseEpoch, inputVersion: execution?.inputVersion ?? 0, currentInputBytes: Buffer.byteLength(currentHost), retainedHostCount: retainedHost.length, retainedBaselineBytes: retainedHost.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0), hostMessagesBytes: Buffer.byteLength(JSON.stringify(request.messages.filter(m => m.source?.taskSession))), messagesBytes: Buffer.byteLength(JSON.stringify(request.messages)), adapterRequestBytes: Buffer.byteLength(JSON.stringify(request)) })
    if (execution && !execution.drained) return [decision('wait', 'wait for physical drain')]
    if (execution && !reads.some(e => e.inputVersion === execution.inputVersion)) return [call('task_execution_read', { executionId: execution.executionId })]
    if (execution) {
      const ref = execution.resultRef ?? input.catalogRef
      const prefix = execution.resultRef ? '' : '/executions/' + execution.executionId + '/result'
      const path = ['/payload/output', '/payload/output/summary', '/payload/output/evidence/0'].map(path => prefix + path)
        .find(path => !values.some(value => value.contentRef === ref.contentRef && value.path === path))
      if (path) return [call('model_content_read', { contentRef: ref.contentRef, path })]
    }
    if (execution?.inputVersion === 32) {
      assert.match(JSON.stringify(request.messages), /UNKNOWN_EFFECT/)
      const primary = (await serviceHost.query('execution.list'))[0], more = team.owner(input, primary); if (more) return more
      return [decision(input.executions.length === 3 && input.executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '32 inputs reviewed')]
    }
    return [call('task_delegate', { key: 'continue-' + (execution?.inputVersion ?? 0), objective: 'generation-' + ((execution?.inputVersion ?? 0) + 1),
      ...(execution ? { executionId: execution.executionId } : {}), context: scope }), decision('wait', 'wait for result')]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message, text: '测试助手，仅分析并汇总32轮观察。' + scope })); await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list')), executions = await t.step(async () => h.query('execution.list'))
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(executions.length, 3); assert.equal(executions.filter(item => item.inputVersion === 32).length, 1); assert.equal(executions[0].inputVersion, 32)
  assert.ok(metrics.length >= 33)
  t.diagnostic(JSON.stringify({ scope: 'native owner scripted adapter, UTF-8 JSON bytes; no provider tokens', metrics: metrics.filter(m => [0, 1, 5, 32].includes(m.inputVersion)) }))
  assert.ok(metrics.every(m => m.currentInputBytes < 60000), 'current owner input must stay within fixture budget')
  assert.ok(metrics.at(-1).currentInputBytes < metrics[0].currentInputBytes + 6000, 'input growth excludes recursive execution history')
  assert.ok(metrics.every(m => m.retainedBaselineBytes === 0), '没有被转移为基线的旧Host正文')
  assert.ok(metrics.at(-1).hostMessagesBytes - metrics.at(-1).currentInputBytes < 1500, 'Host包装开销不随续办轮数增长')
}))

test('configured group responsibility reaches group and task models and its reply signature survives notification formatting', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-group-reply-scope-')
  const responsibility = 'GROUP_REPLY_SCOPE_PROOF：日常回复末尾空一行附 - 测试群助理代回。'
  let groupRequests = 0, taskRequests = 0
  const h = await fixture.host(async request => {
    const calls = topicTaskCalls(request)
    if (calls) {
      groupRequests++
      assert.equal(latestInput(request).context.responsibility, responsibility)
      if (calls[0].name === 'router_submit' && calls[0].args.actions.length) {
        const sourceId = calls[0].args.actions[0].sourceIds[0]
        const reviewed = modelToolValues(request).findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
        if (!reviewed) return [call('router_reply_review_get', { sourceId })]
        calls[0].args.reply = { sourceId, text: '已安排处理。\n\n- 测试群助理代回', review: { kind: 'substantive',
          reviewedOutboundIds: reviewed.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } }
      }
      return calls
    }
    taskRequests++
    assert.ok(requestSystemText(request).includes(responsibility), '任务统筹继承所属群已配置的边界与红线')
    return [decision('complete', '已完成当前目标。')]
  })
  await t.beginBusiness()

  await t.step(async () => h.residentStore.updateGroup({ groupId: 'native-group', responsibility }))
  await t.step(async () => h.service.ingest(message)); await t.step(async () => h.service.whenIdle())
  try { await t.step(() => waitUntil(() => taskRequests > 0, '等待任务统筹')) }
  catch (error) {
    t.diagnostic(JSON.stringify({ alerts: h.service.listAlerts(), toolErrors: h.toolResults.filter(item => item.result.isError)
      .map(item => ({ name: item.name, result: item.result })), router: h.residentStore.getRouterState(message.groupId) }))
    throw error
  }
  assert.ok(groupRequests >= 2); assert.equal(taskRequests, 1, JSON.stringify(h.service.listAlerts()))
  await t.step(() => waitUntil(() => h.sent.find(notification => notification.kind === 'router-reply'), '等待 Router 回复'))
  assert.ok(h.sent.find(notification => notification.kind === 'router-reply').payload.text.endsWith('\n\n- 测试群助理代回'))
}))

test('simple existing-file delivery uses one executor and owner reads the delivered evidence', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-simple-file-')
  const source = join(fixture.root, 'existing-template.txt'), contents = 'existing template, unchanged bytes\n'
  await t.beginBusiness()
  await t.step(async () => writeFile(source, contents))
  let delegated = false, executorStep = 0, ownerRead = false
  const h = await t.step(async () => fixture.host(async request => {
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('task_delegate')) {
      assert.ok(!names.includes(nativeShell) && !names.includes('write'))
      if (!delegated) {
        delegated = true
        return [call('task_delegate', { key: 'deliver-existing-file', objective: '将已定位的现有文件原样交付到任务目录',
          context: `来源为 ${source}；只复制原文件到 delivered-template.txt 并读回，不重新生成、不修改内容、不发送外部消息。` }), decision('wait', '等待文件交付结果')]
      }
      assert.equal(input.executions.length, 1, '简单文件任务不追加固定审查成员')
      const execution = input.executions[0]
      if (!execution.drained || execution.status !== 'succeeded') return [decision('wait', '等待原执行完成')]
      if (!ownerRead) {
        ownerRead = true
        return [call('task_execution_read', { executionId: execution.executionId }), call('read', { file_path: 'delivered-template.txt' })]
      }
      assert.ok(JSON.stringify(request.messages.filter(message => message.role === 'tool')).includes(contents.trim()))
      return [decision('complete', '现有文件已原样交付。')]
    }
    assert.ok(names.includes(nativeShell) && names.includes('write'), '执行会话仍有实际业务操作能力')
    if (executorStep++ === 0) return [call(nativeShell, {
      command: nativeShell === 'pwsh' ? `Copy-Item -LiteralPath '${source}' -Destination 'delivered-template.txt'` : `cp '${source}' delivered-template.txt`,
      description: '原样复制已定位的文件，不重新生成内容',
    })]
    if (executorStep === 2) return [call('read', { file_path: 'delivered-template.txt' })]
    assert.ok(JSON.stringify(request.messages.filter(message => message.role === 'tool')).includes(contents.trim()))
    return [call('execution_submit', { output: { status: 'completed', summary: '原文件已复制并读回',
      evidence: ['delivered-template.txt'], limitations: ['仅验证本地文件交付，没有真实外发'], artifacts: ['delivered-template.txt'] } })]
  }))
  await t.step(async () => h.service.ingest({ ...message, messageId: 'existing-file-delivery', text: '测试助手，将现成模板原样交付到任务目录即可。' }))
  await t.step(async () => h.service.whenIdle())
  const [task] = await t.step(async () => h.query('task.list')), [execution] = await t.step(async () => h.query('execution.list'))
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 1)
  assert.equal(await t.step(async () => readFile(join(fixture.root, 'tasks', task.taskId, 'delivered-template.txt'), 'utf8')), contents)
  const writes = h.toolResults.filter(result => result.name === nativeShell)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sessionId, execution.sessionId)
  assert.equal(writes[0].result.isError, false)
  assert.ok(h.toolResults.some(result => result.name === 'read' && result.sessionId === task.sessionId && !result.result.isError))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 1)
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1, '完成后不重放文件交付')
}))

test('native service routes authenticated source, delegates parallel execution, persists wake before owner wait, and sends confirmation and completion with readback', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-native-'), { root } = fixture
  const teamMessage = { ...message, text: '测试助手，分别生成 alpha、beta 和 gamma 的文件并用终端验证，再汇总结论。' }
  const steps = new Map(), executionStarted = new Set(), started = Promise.withResolvers()
  const handoffs = Object.fromEntries(['alpha', 'beta', 'gamma'].map(key => [key, `负责${key}-native-proof.txt和${key}-process-cwd.txt；原请求要求分别生成并核验。另一组文件由其他执行负责，互无前置依赖。仅在本任务目录写这两个文件，用原生读取与终端核验内容和目录后报告证据，不发送消息。`]))
  const wrappedFilesystems = new Set(), readOverlap = { active: 0, peak: 0, started: 0 }
  let ownerRounds = 0, sawResultsBeforeWait = false, lateNativeCalls = 0
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('triage_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const review = modelToolValues(request).findLast(item => Array.isArray(item.candidates))
      if (!review) return [call('router_reply_review_get', {})]
      return [call('triage_submit', { needsProcessing: true, reply: '已收到，开始处理。', review: { kind: 'confirmation',
        reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })]
    }
    if (names.includes('router_submit')) {
      const calls = directRouterCalls(request)
      if (calls[0].name === 'router_source_read') return calls
      const fact = input.context?.facts?.find(item => item.kind === 'completed')
      if (fact) {
        const sourceId = fact.sourceIds[0]
        const review = modelToolValues(request).findLast(item => item.sourceId === sourceId && Array.isArray(item.candidates))
        if (!review) return [call('router_reply_review_get', { sourceId })]
        return [call('router_submit', { actions: [], continuity: [], reply: { sourceId, text: 'alpha、beta 和 gamma 已分别生成并实际验证。',
          review: { kind: 'substantive', reviewedOutboundIds: review.candidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
      }
      return topicTaskCalls(request)
    }
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) {
      const key = 'owner:' + input.task.leaseEpoch, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      assert.ok(names.includes('read'), '统筹保留原始证据读取')
      assert.ok(!names.includes(nativeShell) && !names.includes('write') && !names.includes('glob') && !names.includes('grep'), '统筹目录不暴露具体业务操作')
      if (!input.executions.length) {
        if (step === 0) {
          ownerRounds++
          const owner = host.ctx.agents.get(input.task.sessionId)
          owner.ctx.tools.register({ name: 'late_native_write', description: 'Native tool registered after session setup', parameters: { type: 'object' },
            output: { schema: { type: 'object' }, render: () => [] }, execute() { lateNativeCalls++; return {} } })
          return [call('write', { file_path: 'owner-native-proof.txt', content: 'must not write' }), call('late_native_write', {}),
            call(nativeShell, { command: nativeShell === 'pwsh' ? "Set-Content 'owner-shell-proof.txt' 'must not write'" : "printf 'must not write' > owner-shell-proof.txt", description: '统筹不得执行该业务命令' })]
        }
        if (step === 1) return ['alpha', 'beta', 'gamma'].map(key => call('task_delegate', { key, objective: key,
          context: handoffs[key], resourceKeys: ['file:' + key] }))
        const executions = await waitUntil(async () => { const executions = await host.query('execution.list'); return executions.length === 3 && executions.every(e => e.drained && e.status === 'succeeded') ? executions : null }, 'three native executors persisted before owner wait')
        assert.equal(executions.length, 3); sawResultsBeforeWait = true
        return [decision('wait', '等待已落账结果唤醒')]
      }
      assert.equal(input.executions.length, 3)
      assert.ok(input.executions.every(e => e.drained && e.status === 'succeeded'))
      assert.ok(input.wakes.some(wake => wake.kind.startsWith('execution.')))
      if (step === 0) {
        ownerRounds++
        return ['alpha', 'beta', 'gamma'].map(key => call('read', { file_path: key + '-native-proof.txt' }))
      }
      for (const key of ['alpha', 'beta', 'gamma']) assert.ok(request.messages.some(message => message.role === 'tool'
        && JSON.stringify(message.content).includes(key + '-native-proof.txt')), '统筹须实际读取执行产物')
      return [decision('complete', 'alpha、beta 和 gamma 已分别生成并实际验证。')]
    }
    assert.ok(names.includes('execution_submit'))
    const key = input.objective, step = steps.get(key) ?? 0
    assert.equal(input.context, handoffs[key], 'Each independent native session receives its own complete handoff')
    steps.set(key, step + 1)
    if (step === 0) {
      const execution = (await host.query('execution.list')).find(item => item.input.objective === key)
      const agent = host.ctx.agents.get(execution.sessionId)
      assert.deepEqual(((state) => ({ preset: state.preset, sandbox: state.sandbox, approval: state.approval }))(host.ctx.sessionProjections.stateOf(agent.session, 'permissions')), { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' })
      const fs = host.ctx.agentPresets.serviceFor(agent, 'fs')
      assert.ok(fs, 'Execution must inherit the actual mounted filesystem provider')
      if (!wrappedFilesystems.has(fs.identity)) {
        wrappedFilesystems.add(fs.identity)
        const readText = fs.readText
        fs.readText = async function (...args) {
          // 仅同步三个执行成员的首轮读取；统筹后续读证据不重新进入并发夹具。
          if (!this.processPath(args[0]).endsWith('-native-proof.txt') || readOverlap.started >= 3) return readText.apply(this, args)
          readOverlap.started++; readOverlap.active++; readOverlap.peak = Math.max(readOverlap.peak, readOverlap.active)
          try {
            await waitUntil(() => readOverlap.started === 3, 'three real filesystem reads entered together', 3000)
            return await readText.apply(this, args)
          } finally { readOverlap.active-- }
        }
        t.after(() => { fs.readText = readText })
      }
      executionStarted.add(key)
      if (executionStarted.size === 3) started.resolve()
      await started.promise
      assert.ok(names.includes('write') && names.includes('read') && names.includes(nativeShell))
      return [call('write', { file_path: key + '-native-proof.txt', content: key + '\n' })]
    }
    if (step === 1) return [call(nativeShell, { command: nativeShell === 'pwsh'
      ? `[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path '${key}-process-cwd.txt'), (Get-Location).Path); if (-not (Test-Path -LiteralPath '${key}-native-proof.txt' -PathType Leaf)) { exit 1 }; Write-Output 'native-process-verified'`
      : `printf '%s\\n' "$PWD" > ${key}-process-cwd.txt; test -f ${key}-native-proof.txt; printf 'native-process-verified'`, description: 'Verify the actual file in the execution cwd' })]
    if (step === 2) return [call('read', { file_path: key + '-native-proof.txt' })]
    assert.ok(JSON.stringify(request).includes(key), 'Native tool results must reach the model')
    return [call('execution_submit', { output: { status: 'completed', summary: key + ' 已验证', evidence: ['native-process-verified'], limitations: [], artifacts: [key + '-native-proof.txt', key + '-process-cwd.txt'] } })]
  })
  await t.beginBusiness()

  const first = await t.step(async () => h.service.ingest(teamMessage))
  assert.equal(first.accepted, true)
  await t.step(() => waitUntil(async () => {
    const [task] = await h.query('task.list')
    return task?.status === 'completed' && task.drained
  }, '等待并行任务完成并排空'))
  await t.step(async () => h.service.whenIdle())
  assert.deepEqual((await t.step(async () => h.service.recover())).failures, [])
  const tasks = await t.step(async () => h.query('task.list'))
  assert.equal(tasks.length, 1)
  const task = tasks[0], executions = await t.step(async () => h.query('execution.list', { taskId: task.taskId }))
  assert.equal(new Set(executions.map(execution => execution.sessionId)).size, 3)
  for (const execution of executions) {
    assert.equal(execution.input.context, handoffs[execution.key])
    assert.deepEqual(execution.resourceKeys, ['file:' + execution.key])
  }
  const executionViews = await t.step(async () => h.service.taskExecutions(task.taskId))
  assert.ok(executionViews.executions.every(execution => execution.workspaceDir === join(root, 'tasks', task.taskId)
    && execution.workingDirectory === join(root, 'tasks', task.taskId)))
  assert.equal(task.status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), lastDecision: task.lastDecision,
    failures: h.toolResults.filter(result => result.result.isError) }))
  assert.equal(task.sourceRefs.length, 1)
  const source = await t.step(() => h.query('source.get', { sourceId: task.sourceRefs[0] }))
  assert.equal(source.messageId, teamMessage.messageId)
  assert.equal(source.version, 1)
  assert.equal(source.groupId, teamMessage.groupId)
  assert.equal(ownerRounds, 2)
  assert.equal(sawResultsBeforeWait, true)
  assert.equal(lateNativeCalls, 0, '晚注册工具不能绕过统筹职责边界')
  for (const file of ['owner-native-proof.txt', 'owner-shell-proof.txt']) await t.step(async () => assert.rejects(readFile(join(root, 'tasks', task.taskId, file)), { code: 'ENOENT' }))
  assert.equal(readOverlap.peak, 3, 'Native concurrency-safe filesystem calls must overlap')
  await t.step(() => waitUntil(async () => {
    const notices = await h.query('notification.list')
    return h.sent.length === 2 && h.readbacks.length === 2 && notices.filter(item => item.state === 'delivered').length === 2
  }, '等待确认及完成回复实际送达'))
  assert.equal(h.sent.length, 2); assert.equal(h.readbacks.length, 2)
  const echo = await t.step(async () => h.service.ingest({ ...message, messageId: 'native-notification-2', senderOpenDingTalkId: 'notification-sender', text: 'completion echo' }))
  assert.equal(echo.reason, 'own-notification')
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1, 'durable send receipt must exclude our own group echo')
  assert.equal((await t.step(async () => h.query('notification.list')))[0].state, 'delivered')
  assert.equal((await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))).actorId, message.senderOpenDingTalkId)
  assert.equal((await t.step(async () => h.query('source.get', { sourceId: first.sourceId }))).routed, true)
  const ownerLog = await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))
  const delegated = ownerLog.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_delegate')
  const firstWait = ownerLog.events.find(event => event.type === 'tool/call' && event.data.name === 'task_session_submit')
  assert.equal(delegated.length, 3)
  assert.ok(delegated.every(event => event.seq < firstWait.seq), 'All three independent goals are delegated before the first wait')
  assert.equal(ownerLog.meta.cwd, join(root, 'tasks', task.taskId))
  assert.ok(!ownerLog.events.some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access'))
  const ownerWorkspace = h.ctx.workspaceRegistry.list().find(workspace => workspace.path === ownerLog.meta.cwd)
  assert.ok(ownerWorkspace)
  assert.ok(ownerWorkspace.sessionIds.includes(task.sessionId))
  assert.equal(ownerWorkspace.title, task.title)
  assert.equal(ownerLog.events.findLast(event => event.type === 'session/title')?.data.title, task.title)
  assert.equal(ownerLog.events.filter(e => e.type === 'plugin:dingtalk/task-session').length, 1)
  assert.equal(ownerLog.events.filter(e => e.type === 'user/message' && e.data.source?.taskSession && !e.data.source.taskContextHistory).length, 2)
  for (const name of ['write', nativeShell, 'late_native_write']) assert.ok(h.toolResults.some(result => result.sessionId === task.sessionId && result.name === name && result.result.isError), '统筹的实际越界调用须被拒绝')
  for (const execution of executions) {
    const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, execution.sessionId)), cwd = join(root, 'tasks', task.taskId)
    assert.ok(log.events.some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access'))
    assert.equal(log.meta.cwd, ownerLog.meta.cwd)
    assert.ok(!log.events.some(event => event.type === 'working-directory/change'), 'Executor cwd starts at the same immutable task root')
    assert.equal(log.events.findLast(event => event.type === 'session/title')?.data.title, execution.input.title)
    const executionWorkspace = h.ctx.workspaceRegistry.list().find(workspace => workspace.path === ownerLog.meta.cwd)
    assert.ok(executionWorkspace)
    assert.ok(executionWorkspace.sessionIds.includes(execution.sessionId))
    assert.equal(executionWorkspace.id, ownerWorkspace.id)
    assert.equal(h.ctx.workspaceRegistry.list().filter(workspace => workspace.path.startsWith(join(root, 'tasks', task.taskId))).length, 1)
    assert.equal(await t.step(async () => readFile(join(cwd, execution.input.objective + '-native-proof.txt'), 'utf8')), execution.input.objective + '\n')
    assert.equal((await t.step(async () => readFile(join(cwd, execution.input.objective + '-process-cwd.txt'), 'utf8'))).trim(), cwd)
    assert.ok(log.events.some(e => e.type === 'tool/call' && e.data.name === nativeShell))
    assert.ok(log.events.some(e => e.type === 'tool/result'))
    assert.ok((await t.step(async () => findSessionLog(root, execution.sessionId))).startsWith(taskSessionLogRoot(root, task.taskId)))
  }
  assert.ok((await t.step(async () => findSessionLog(root, task.sessionId))).startsWith(taskSessionLogRoot(root, task.taskId)))
  assert.equal((await t.step(async () => h.query('operation.list', { taskId: task.taskId }))).length, 6)
  assert.ok((await t.step(async () => h.query('operation.list', { taskId: task.taskId }))).every(operation => operation.state === 'succeeded'))
  await t.step(async () => h.service.ingest(teamMessage)); await t.step(async () => h.service.whenIdle()); await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  assert.equal(h.sent.length, 2)
  assert.ok((await t.step(async () => readdir(join(root, 'tasks', task.taskId)))).includes('alpha-native-proof.txt'))
  await t.step(async () => h.close())
  const reopened = await t.step(async () => fixture.host(() => { throw new Error('Completed native work must not be repeated after reopening SQLite') }, { initialize: false }))
  await t.step(async () => reopened.service.recover()); await t.step(async () => reopened.service.whenIdle())
  assert.equal((await t.step(async () => reopened.query('task.get', { taskId: task.taskId }))).status, 'completed')
  assert.deepEqual((await t.step(async () => reopened.query('execution.list'))).map(e => e.sessionId).sort(), executions.map(e => e.sessionId).sort())
  assert.equal((await t.step(async () => reopened.query('notification.list')))[0].state, 'delivered')
  assert.equal(reopened.sent.length, 0)
  assert.equal(reopened.requests.length, 0)
  for (const [sessionId, cwd] of [[task.sessionId, ownerLog.meta.cwd], ...executions.map(execution => [execution.sessionId, ownerLog.meta.cwd])]) {
    assert.equal((await t.step(async () => inspectSession(reopened.ctx.sessionPersistence, sessionId))).meta.cwd, cwd)
    assert.ok(reopened.ctx.workspaceRegistry.list().find(workspace => workspace.path === cwd)?.sessionIds.includes(sessionId))
  }
}))

test('native sequential handoff preserves one executor before independent review of the fixed artifact', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-sequential-review-'), steps = new Map(), reviewed = new Set()
  const artifact = 'candidate.txt', content = 'candidate-v1\ncandidate-proof:7\n'
  const sha256 = createHash('sha256').update(content).digest('hex')
  let firstIdentity, phase = 0, independentStartedAfterDrain = false
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const required = requiredDecisionRead(request, input); if (required) return [required]
      const executions = await host.query('execution.list', { taskId: input.task.taskId })
      const writer = executions.find(execution => execution.key === 'candidate'), reviewer = executions.find(execution => execution.key === 'independent-review')
      if (phase === 0) {
        phase++
        return [call('task_delegate', { key: 'candidate', objective: 'prepare-fixed-candidate', resourceKeys: ['candidate'],
          context: '仅在本任务目录创建candidate.txt版本candidate-v1；先写入并报告产物和摘要，后续核对须等待本次结果。不得发送或发布。' }), decision('wait', '等待原候选生成')]
      }
      if (!writer?.drained || writer.status !== 'succeeded') return [decision('wait', '前置执行未结束，保留原执行')]
      for (const execution of executions.filter(item => item.status === 'succeeded' && item.drained)) {
        const version = execution.executionId + ':' + execution.inputVersion
        if (!reviewed.has(version)) { reviewed.add(version); return [call('task_execution_read', { executionId: execution.executionId })] }
      }
      if (phase === 1) {
        firstIdentity = { executionId: writer.executionId, sessionId: writer.sessionId }
        assert.equal(await readFile(join(fixture.root, 'tasks', input.task.taskId, artifact), 'utf8'), content)
        phase++
        return [call('task_delegate', { key: 'verify-original', executionId: writer.executionId, objective: 'verify-original-candidate',
          context: `前置candidate-v1已生成；只读candidate.txt，预期SHA256=${sha256}，核对原内容并提交实际读取证据；不修改、发布或发送。` }), decision('wait', '沿原执行核对已生成候选')]
      }
      if (phase === 2 && writer.inputVersion === 2) {
        assert.deepEqual({ executionId: writer.executionId, sessionId: writer.sessionId }, firstIdentity)
        phase++
        return [call('task_delegate', { key: 'independent-review', objective: 'independently-review-candidate', resourceKeys: ['candidate'],
          context: `固定产物candidate.txt，版本candidate-v1，SHA256=${sha256}；原执行已排空。独立只读原文件，核对版本、内容和反例；不得改文件、部署、发送或重做原动作。报告真实证据与限制。` }), decision('wait', '候选已固定，等待独立核验')]
      }
      const teamComplete = executions.length === 2 && reviewer?.drained && executions.every(item => item.drained && item.status === 'succeeded')
      return [decision(teamComplete ? 'complete' : 'wait', teamComplete ? '原候选及独立核验均已核对' : '等待尚未结束的真实核验')]
    }
    const step = steps.get(input.objective) ?? 0
    steps.set(input.objective, step + 1)
    if (input.objective === 'prepare-fixed-candidate') {
      if (step === 0) return [call('write', { file_path: artifact, content })]
    } else {
      const executions = await host.query('execution.list', { taskId: input.task.taskId })
      const execution = executions.find(item => item.input.objective === input.objective)
      assert.equal(execution.input.recoveryReadOnly, false, 'Ordinary verification does not borrow the reconciliation marker')
      assert.ok(input.context.includes(sha256), 'The handoff pins the artifact rather than a mutable summary')
      if (input.objective === 'independently-review-candidate') {
        const writer = executions.find(item => item.key === 'candidate')
        assert.equal(writer.drained, true)
        assert.equal(writer.status, 'succeeded')
        assert.equal(writer.inputVersion, 2)
        assert.notEqual(execution.sessionId, writer.sessionId)
        independentStartedAfterDrain = true
      }
      if (step === 0) return [call('read', { file_path: artifact })]
      assert.ok(JSON.stringify(request.messages.filter(message => message.role === 'tool')).includes('candidate-proof:7'), 'Actual native file contents reach each verifier')
    }
    return [call('execution_submit', { output: { status: 'completed', summary: input.objective,
      evidence: [artifact, 'sha256:' + sha256], limitations: ['仅核验固定本地产物，未部署或发送'], artifacts: [artifact] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'sequential-review',
    objective: '生成固定候选，沿原执行核对后独立只读核验；未完成所有核验前不要宣布完成，不部署或发送。' }))
  await t.step(async () => h.service.whenIdle())
  assert.deepEqual((await t.step(async () => h.service.recover())).failures, [])
  const executions = await t.step(async () => h.query('execution.list', { taskId: created.taskId }))
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal(executions.length, 2, 'Sequential continuation reuses the executor; only the independent review adds a member')
  const rejectedCompletions = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
  assert.equal(rejectedCompletions.length, 0, 'Two members may complete once the actual work is verified')
  assert.ok(executions.every(item => item.definition.executionBackend === 'dsh' && item.sessionBound))
  assert.equal(executions.find(item => item.key === 'candidate').continuations.length, 1)
  assert.equal(independentStartedAfterDrain, true)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).status, 'completed')
  assert.equal(createHash('sha256').update(await t.step(async () => readFile(join(fixture.root, 'tasks', created.taskId, artifact)))).digest('hex'), sha256)
  const reviewer = executions.find(item => item.key === 'independent-review')
  const reviewLog = await t.step(async () => inspectSession(h.ctx.sessionPersistence, reviewer.sessionId))
  const reviewTools = reviewLog.events.filter(event => event.type === 'tool/call').map(event => event.data.name)
  assert.ok(reviewTools.every(name => ['model_content_read', 'read', 'execution_submit'].includes(name)), 'Independent review only reads evidence and submits its result')
  assert.equal(reviewTools.filter(name => name === 'read').length, 1)
  assert.equal(reviewTools.filter(name => name === 'execution_submit').length, 1)
  assert.equal(reviewTools.at(-1), 'execution_submit')
  assert.equal((await t.step(async () => h.query('operation.list', { taskId: created.taskId }))).length, 1, 'Verification creates no second write effect')
}))

test('native service runs eleven independent members within the configured concurrency and completes', { ...({ timeout: 45000 }), timeout: nativeLifecycleTimeout(45000) }, nativeLifecycle(45000, async (t) => {
  const fixture = await nativeCase(t, 'task-eleven-members-'), steps = new Map()
  const objectives = Array.from({ length: 11 }, (_, index) => `independent-proof-${index + 1}`)
  let delegated = false, peakRunning = 0
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) {
        delegated = true
        return [...objectives.map(objective => call('task_delegate', { key: objective, objective,
          resourceKeys: [objective], context: `仅生成并读取本任务目录的${objective}.txt，内容为${objective}；不修改其他成员文件，不部署或发送。` })), decision('wait', '等待各独立证据文件')]
      }
      const executions = await host.query('execution.list', { taskId: input.task.taskId })
      return [decision(executions.length === objectives.length && executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '核对独立证据文件结果')]
    }
    const executions = await host.query('execution.list', { taskId: input.task.taskId })
    const running = executions.filter(item => !item.drained).length
    peakRunning = Math.max(peakRunning, running)
    assert.ok(running <= 2, 'Removing the member ceiling does not remove the concurrent execution quota')
    const step = steps.get(input.objective) ?? 0
    steps.set(input.objective, step + 1)
    const file = `${input.objective}.txt`
    if (step === 0) return [call('write', { file_path: file, content: input.objective })]
    if (step === 1) return [call('read', { file_path: file })]
    const execution = executions.find(item => item.input.objective === input.objective)
    const read = host.toolResults.findLast(item => item.name === 'read' && item.sessionId === execution.sessionId)
    assert.ok(read && !read.result.isError)
    assert.ok(JSON.stringify(read.result).includes(input.objective), 'Each native member reads back its own file before submitting')
    return [call('execution_submit', { output: { status: 'completed', summary: input.objective, evidence: [file], limitations: [], artifacts: [file] } })]
  }, { config: { maxConcurrentExecutions: 2 } })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'eleven-members', objective: '分别生成并读取十一份互不依赖的证据文件，全部核验后完成' }))
  await t.step(async () => h.service.whenIdle())
  const executions = await t.step(async () => h.query('execution.list', { taskId: created.taskId }))
  assert.equal(executions.length, 11, JSON.stringify(h.toolResults.filter(item => item.result.isError)))
  assert.equal(new Set(executions.map(item => item.sessionId)).size, 11)
  assert.ok(peakRunning > 0 && peakRunning <= 2)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).status, 'completed', JSON.stringify(h.service.listAlerts()))
  for (const execution of executions) {
    assert.equal(execution.definition.executionBackend, 'dsh')
    assert.equal(execution.status, 'succeeded'); assert.equal(execution.drained, true); assert.equal(execution.sessionBound, true)
    assert.equal(await t.step(async () => readFile(join(fixture.root, 'tasks', created.taskId, `${execution.input.objective}.txt`), 'utf8')), execution.input.objective)
    assert.match(await t.step(async () => readFile(join(fixture.root, 'tasks', created.taskId, 'outputs', execution.executionId, 'round-1.md'), 'utf8')), new RegExp(execution.input.objective))
  }
  assert.equal((await t.step(async () => h.query('operation.list', { taskId: created.taskId }))).length, 11)
  assert.ok(!h.toolResults.some(item => item.result.isError))
}))

test('native executor resumes in the same titled task workspace and all task sessions share the process cwd', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-workspace-resume-')
  function model(continuing) {
    const steps = new Map()
    return async (request, host) => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      if (names.includes('task_delegate')) {
        const step = steps.get('owner:' + input.task.leaseEpoch) ?? 0
        steps.set('owner:' + input.task.leaseEpoch, step + 1)
        if (!input.executions.length && step === 0) return [call('task_delegate', { key: '初次核对', objective: 'first' })]
        const objective = (await host.query('execution.list')).find(e => e.executionId === input.executions[0]?.executionId)?.input.objective
        if (continuing && objective === 'first' && step === 0)
          return [call('task_delegate', { key: '继续核对', objective: 'second', executionId: input.executions[0].executionId })]
        if (objective === 'second' && input.executions[0].status === 'succeeded') {
          return [decision(input.executions.length === 1 && input.executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '第二次核对已完成')]
        }
        return [decision(input.executions.every(execution => execution.drained) ? 'blocked' : 'wait', '等待下一次明确输入')]
      }
      const liveExecution = (await host.query('execution.list')).find(item => item.input.objective === input.objective)
      assert.deepEqual(((state) => ({ preset: state.preset, sandbox: state.sandbox, approval: state.approval }))(host.ctx.sessionProjections.stateOf(host.ctx.agents.get(liveExecution.sessionId).session, 'permissions')), { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' })
      const key = 'execution:' + input.objective, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      if (step === 0) return [call(nativeShell, { command: nativeShell === 'pwsh'
        ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'resume-cwd.txt'), (Get-Location).Path)"
        : "printf '%s' \"$PWD\" > resume-cwd.txt", description: 'Verify resumed native process cwd' })]
      return [call('execution_submit', { output: { status: 'completed', summary: input.objective, evidence: ['实际进程目录已落盘'], limitations: [], artifacts: ['resume-cwd.txt'] } })]
    }
  }
  const first = await fixture.host(model(false))
  await t.beginBusiness()

  const created = await t.step(async () => first.service.createTask({ groupId: 'native-group', requestId: 'workspace-resume', title: '恢复目录核对', objective: '核对执行会话恢复时的工作区' }))
  await t.step(async () => first.service.whenIdle())
  const [execution] = await t.step(async () => first.query('execution.list')), taskRoot = join(fixture.root, 'tasks', created.taskId)
  const runtimeCwd = taskRoot
  await t.step(async () => first.close())
  const next = await t.step(async () => fixture.host(model(true), { initialize: false }))
  await t.step(async () => next.service.recover()); await t.step(async () => next.service.whenIdle())
  await t.step(async () => next.service.appendTaskContext({ taskId: created.taskId, requestId: 'resume-executor', progressImpact: 'replan', context: '继续使用原执行会话完成第二次核对' }))
  await t.step(async () => next.service.whenIdle())
  assert.deepEqual((await t.step(async () => next.service.recover())).failures, [])
  const [resumed] = await t.step(async () => next.query('execution.list'))
  assert.equal(resumed.sessionId, execution.sessionId)
  assert.equal(resumed.executionId, execution.executionId)
  assert.equal(resumed.input.objective, 'second')
  assert.equal((await t.step(async () => next.query('execution.list'))).length, 1, 'A continuation does not add members to satisfy a headcount')
  assert.equal(resumed.definition.executionBackend, 'dsh')
  assert.equal(resumed.status, 'succeeded')
  assert.equal((await t.step(async () => next.query('task.get', { taskId: created.taskId }))).status, 'completed')
  assert.equal(await t.step(async () => readFile(join(runtimeCwd, 'resume-cwd.txt'), 'utf8')), runtimeCwd)
  const workspace = next.ctx.workspaceRegistry.list().find(item => item.path === taskRoot)
  assert.equal(workspace.title, '恢复目录核对')
  assert.ok(workspace.sessionIds.includes(created.session.sessionId) && workspace.sessionIds.includes(resumed.sessionId))
  assert.equal(next.ctx.workspaceRegistry.list().filter(item => item.path.startsWith(taskRoot)).length, 1)
  const log = await t.step(async () => inspectSession(next.ctx.sessionPersistence, resumed.sessionId))
  assert.equal(log.meta.cwd, taskRoot)
  assert.ok(!log.events.some(event => event.type === 'working-directory/change'))
  assert.equal(log.events.findLast(event => event.type === 'session/title').data.title, execution.title, '同一执行保留稳定名称，续办key不改名')
  assert.equal(resumed.input.title, execution.title)
}))

test('native service reopens an unknown notification for readback without resending completed business work', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-notification-')
  let sends = 0, canRead = false, readbacks = 0
  const notifications = {
    async send(notification) { sends++; return { messageId: notification.payload.coveredEventIds?.length ? 'durable-delivery-id' : 'durable-confirmation-id' } },
    async readback(notification) {
      readbacks++
      const id = notification.payload.coveredEventIds?.length ? 'durable-delivery-id' : 'durable-confirmation-id'
      assert.equal(notification.ack.messageId, id)
      return !notification.payload.coveredEventIds?.length || canRead ? { messageId: id, verified: true } : null
    },
  }
  const first = await fixture.host(async request => {
    return topicTaskCalls(request) ?? [decision('complete', '可用的已有证据已核验。')]
  }, { notifications })
  await t.beginBusiness()

  try {
    await t.step(async () => first.service.ingest({ ...message, messageId: 'notification-request', text: '测试助手，核对已有记录并给出结论。' }))
    await t.step(async () => first.service.whenIdle())
    assert.equal((await t.step(async () => first.query('task.list')))[0].status, 'completed')
    const pending = (await t.step(async () => first.query('notification.list'))).find(notification => notification.payload.coveredEventIds?.length)
    assert.equal(pending.state, 'starting', 'Topic 发件箱将 ACK 与送达回查分开记录')
    assert.equal(pending.ack.messageId, 'durable-delivery-id')
    assert.equal(pending.readbackAttemptCount, 1)
    assert.ok(Date.parse(pending.nextAttemptAt) > Date.now())
    assert.equal(sends, 2)
  } finally { await t.step(async () => first.close()) }
  const readsBeforeRecovery = readbacks
  canRead = true
  const second = await t.step(async () => fixture.host(() => { throw new Error('Completed task must not invoke the model during receipt recovery') }, { notifications, initialize: false }))
  assert.equal((await t.step(async () => second.query('notification.list'))).find(notification => notification.payload.coveredEventIds?.length).state, 'unknown')
  await t.step(async () => second.service.recover()); await t.step(async () => second.service.whenIdle())
  assert.equal(readbacks, readsBeforeRecovery, 'Restart must preserve the persisted observation cooldown')
  const retryAt = Math.max(...(await t.step(async () => second.query('notification.list'))).filter(notification => notification.state === 'unknown').map(notification => Date.parse(notification.nextAttemptAt)))
  await t.step(async () => new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 20)))
  await t.step(async () => second.service.recover()); await t.step(async () => second.service.whenIdle())
  assert.ok((await t.step(async () => second.query('notification.list'))).every(notification => notification.state === 'delivered'))
  assert.equal((await t.step(async () => second.query('task.list'))).length, 1)
  assert.equal(sends, 2); assert.equal(readbacks, readsBeforeRecovery + 1)
  assert.equal(second.requests.length, 0)
}))

test('native service cancellation stops the real execution process, drains the session, and rejects late completion', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-cancel-'), { root } = fixture
  let ownerStep = 0
  const h = await fixture.host(async request => {
    const direct = directRouterCalls(request); if (direct) return direct
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) return ++ownerStep === 1
      ? [call('task_delegate', { key: 'long-process', objective: 'Run the cancellable process' })]
      : [decision('wait', '等待执行结果')]
    if (!JSON.stringify(request).includes('native-long-process-done')) return [call(nativeShell, {
      command: nativeShell === 'pwsh'
        ? "Set-Content -LiteralPath 'process-started.txt' -Value 'started' -NoNewline; Start-Sleep -Seconds 30; Set-Content -LiteralPath 'process-completed.txt' -Value 'late' -NoNewline; Write-Output 'native-long-process-done'"
        : "printf '%s' started > process-started.txt; sleep 30; printf '%s' late > process-completed.txt; printf 'native-long-process-done'",
      description: 'Run a cancellable test process', timeoutMs: 60000,
    })]
    return [call('execution_submit', { output: { status: 'completed', summary: 'This late result must not complete a cancelled task', evidence: [], limitations: [], artifacts: ['process-completed.txt'] } })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message, messageId: 'cancel-request' }))
  const execution = await t.step(async () => waitUntil(async () => {
    const [execution] = await h.query('execution.list')
    if (!execution) return null
    const marker = join(root, 'tasks', execution.taskId, 'process-started.txt')
    return await readFile(marker, 'utf8').then(() => execution, error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 'real shell process started'))
  const oldBinding = await t.step(async () => h.query('execution.binding', { executionId: execution.executionId }))
  const result = await t.step(async () => h.service.cancelTask({ taskId: execution.taskId, requestId: 'cancel-once', reason: '停止本次执行' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(result.control, 'cancelled')
  const task = await t.step(async () => h.query('task.get', { taskId: execution.taskId })), stored = await t.step(async () => h.query('execution.get', { executionId: execution.executionId }))
  assert.equal(task.control, 'cancelled'); assert.equal(task.drained, true)
  assert.equal(stored.drained, true); assert.notEqual(stored.status, 'succeeded')
  assert.equal(h.ctx.agents.get(execution.sessionId), undefined)
  assert.equal(h.ctx.sessions.get(execution.sessionId), undefined)
  await t.step(async () => assert.rejects(readFile(join(root, 'tasks', task.taskId, 'process-completed.txt')), { code: 'ENOENT' }))
  assert.equal(h.sent.length, 0)
  assert.equal((await t.step(async () => h.query('notification.list'))).length, 0)
  const operations = await t.step(async () => h.query('operation.list', { taskId: task.taskId }))
  assert.equal(operations.length, 1)
  assert.ok(['unknown', 'cancelled'].includes(operations[0].state), 'Interrupted shell must not be asserted successful')
  const saved = await t.step(async () => inspectSession(h.ctx.sessionPersistence, execution.sessionId))
  assert.ok(saved.events.some(event => event.type === 'tool/call' && event.data.name === nativeShell))
  assert.ok(saved.events.some(event => event.type === 'turn/end'))
  await t.step(async () => assert.rejects(h.service.store.command({ id: 'late-completion-after-cancel', kind: 'execution.result', args: {
    binding: oldBinding, output: { status: 'completed', summary: 'stale late success', evidence: [], limitations: [], artifacts: [] },
  } }), { code: 'DYNAMIC_EXECUTION_RESULT_CONFLICT' }))
  const webSources = (await t.step(async () => h.query('source.list'))).filter(source => source.channel === 'web')
  assert.equal(webSources.length, 1)
  assert.equal(webSources[0].routed, true, 'Direct web cancellation must not be rerouted as a new group message on restart')
  const requests = h.requests.length
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(h.requests.length, requests)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
}))

test('native requirement update resumes the same owner with new sources and fences the interrupted old execution result', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-revise-'), { root } = fixture
  let ownerStep = 0
  const revisedInputs = []
  const h = await fixture.host(async request => {
    const direct = directRouterCalls(request); if (direct) return direct
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) {
      if (input.task.requirementRevision > 1) {
        revisedInputs.push(input)
        return [decision('blocked', '新要求已接入，旧操作的未知效果需先核对。')]
      }
      return ++ownerStep === 1 ? [call('task_delegate', { key: 'old-requirement', objective: 'Validate the old request' })] : [decision('wait', '等待原执行结果')]
    }
    return [call(nativeShell, { command: nativeShell === 'pwsh'
      ? "Set-Content -LiteralPath 'revision-process-started.txt' -Value 'started' -NoNewline; Start-Sleep -Seconds 30; Set-Content -LiteralPath 'old-completed.txt' -Value 'old-result' -NoNewline"
      : "printf '%s' started > revision-process-started.txt; sleep 30; printf old-result > old-completed.txt",
      description: 'Hold the old requirement process until interrupted', timeoutMs: 60000 })]
  })
  await t.beginBusiness()

  await t.step(async () => h.service.ingest({ ...message, messageId: 'revision-original' }))
  const oldExecution = await t.step(async () => waitUntil(async () => {
    const [execution] = await h.query('execution.list')
    if (!execution) return null
    const marker = join(root, 'tasks', execution.taskId, 'revision-process-started.txt')
    return await readFile(marker).then(() => execution, error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 'old real execution started'))
  const oldTask = await t.step(async () => h.query('task.get', { taskId: oldExecution.taskId }))
  await t.step(async () => h.service.appendTaskContext({ taskId: oldTask.taskId, requestId: 'revise-once', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: 1,
    context: '最新要求：暂停生成文件，先核对旧操作结果，不要将旧结果当作新要求完成。' }))
  await t.step(async () => h.service.whenIdle())
  const task = await t.step(async () => h.query('task.get', { taskId: oldTask.taskId })), execution = await t.step(async () => h.query('execution.get', { executionId: oldExecution.executionId }))
  assert.equal(task.sessionId, oldTask.sessionId)
  assert.equal(task.requirementRevision, 2)
  assert.equal(task.status, 'active'); assert.equal(task.drained, true)
  assert.equal(task.lastDecision.action, 'blocked')
  assert.ok(revisedInputs.length >= 1)
  for (const input of revisedInputs) {
    assert.ok(input.sources.some(source => source.text.includes('最新要求：暂停生成文件')))
    assert.equal(input.sources.length, 2)
    assert.ok(input.sources.every(source => source.actorId === 'native-user'))
  }
  assert.equal(execution.drained, true)
  assert.equal(execution.result.current, false)
  assert.notEqual(execution.status, 'succeeded')
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 1)
  assert.equal((await t.step(async () => h.query('notification.list'))).length, 0)
  assert.equal(h.sent.length, 0)
  const saved = await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))
  assert.equal(saved.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.ok(saved.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).length >= 2)
  assert.equal((await t.step(async () => h.query('source.list'))).find(source => source.channel === 'web').routed, true)
  const requests = h.requests.length
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(h.requests.length, requests)
  assert.equal((await t.step(async () => h.query('task.list'))).length, 1)
}))

for (const [maxConcurrentTasks, maxConcurrentExecutions] of [[1, 1], [1, 2], [2, 1], [2, 3]]) test(`native capacity queues promote every task and execution: tasks=${maxConcurrentTasks}, executions=${maxConcurrentExecutions}`, { ...({ timeout: 25000 }), timeout: nativeLifecycleTimeout(25000) }, nativeLifecycle(25000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-capacity-'), gate = Promise.withResolvers(), steps = new Map()
  let entered = 0
  const h = await fixture.host(async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('task_delegate')) {
      const key = input.task.taskId + ':' + input.task.leaseEpoch, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      if (!input.executions.length && step === 0) return ['one', 'two', 'three'].map(key => call('task_delegate', { key, objective: key }))
      return [decision(input.executions.length === 3 && input.executions.every(e => e.status === 'succeeded' && e.drained) ? 'complete' : 'wait', '容量测试负责人决定')]
    }
    const key = input.task.taskId + ':' + input.objective, step = steps.get(key) ?? 0
    steps.set(key, step + 1)
    if (step === 0) { entered++; await gate.promise; return [call('write', { file_path: input.objective + '-capacity-proof.txt', content: key })] }
    return [call('execution_submit', { output: { status: 'completed', summary: key, evidence: ['actual filesystem write'], limitations: [], artifacts: [input.objective + '-capacity-proof.txt'] } })]
  }, { config: { maxConcurrentTasks, maxConcurrentExecutions } })
  await t.beginBusiness()

  try {
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'capacity-a', objective: 'first task' }))
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'capacity-b', objective: 'second task' }))
    const admitted = Math.min(maxConcurrentTasks * 3, maxConcurrentExecutions)
    await t.step(async () => waitUntil(() => entered === admitted, 'available native executor slots admitted'))
    await t.step(async () => waitUntil(async () => (await h.query('execution.list')).length === maxConcurrentTasks * 3, 'admitted owners persisted all three delegations'))
    assert.equal((await t.step(async () => h.query('task.list'))).filter(task => task.sessionBound).length, maxConcurrentTasks)
    assert.equal((await t.step(async () => h.query('execution.list'))).filter(execution => execution.status === 'running').length, admitted)
  } finally { gate.resolve() }
  await t.step(async () => h.service.whenIdle())
  assert.equal(entered, 6, 'All six real execution sessions must run without a periodic recovery tick')
  assert.ok((await t.step(async () => h.query('task.list'))).every(task => task.status === 'completed'))
  for (const execution of await t.step(async () => h.query('execution.list'))) {
    assert.equal(execution.status, 'succeeded'); assert.equal(execution.drained, true)
    assert.equal(await t.step(async () => readFile(join(fixture.root, 'tasks', execution.taskId, execution.input.objective + '-capacity-proof.txt'), 'utf8')), execution.taskId + ':' + execution.input.objective)
  }
}))

test('native shared resources queue without occupying task capacity and promote on drain', { ...({ timeout: 45000 }), timeout: nativeLifecycleTimeout(45000) }, nativeLifecycle(45000, async (t) => {
  const fixture = await nativeCase(t, 'task-resource-capacity-'), gate = Promise.withResolvers(), steps = new Map(), entered = []
  const team = nativeVerificationTeam({ filePath: 'resource-proof.txt', expected: '' })
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request)
    const verification = team.execute(request, input); if (verification) return verification
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const required = requiredDecisionRead(request, input); if (required) return [required]
      const key = input.task.taskId + ':' + input.task.leaseEpoch, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      if (!input.executions.length && step === 0) return [call('task_delegate', { key: 'run', objective: input.task.objective,
        resourceKeys: [input.task.objective === 'independent' ? 'uat3' : 'uat2'] })]
      const primary = (await host.query('execution.list', { taskId: input.task.taskId }))[0], more = team.owner(input, primary); if (more) return more
      return [decision(input.executions.length === 3 && input.executions.every(e => e.status === 'succeeded' && e.drained) ? 'complete' : 'wait', '核对实际执行结果')]
    }
    const step = steps.get(input.task.taskId) ?? 0; steps.set(input.task.taskId, step + 1)
    if (!step) {
      entered.push(input.objective)
      if (input.objective === 'holder') await gate.promise
      return [call('write', { file_path: 'resource-proof.txt', content: input.objective })]
    }
    return [call('execution_submit', { output: { status: 'completed', summary: input.objective, evidence: ['actual write'], limitations: [], artifacts: ['resource-proof.txt'] } })]
  }, { config: { maxConcurrentTasks: 2, maxConcurrentExecutions: 2 } })
  await t.beginBusiness()

  try {
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'resource-holder', objective: 'holder' }))
    await t.step(async () => waitUntil(() => entered.includes('holder'), 'first execution holds resource'))
    const waiter = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'resource-waiter', objective: 'waiter' }))
    await t.step(async () => waitUntil(async () => (await h.query('execution.list', { taskId: waiter.taskId }))[0]?.resources.state === 'waiting', 'same resource waits'))
    await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'resource-independent', objective: 'independent' }))
    await t.step(async () => waitUntil(() => entered.includes('independent'), 'waiting task gives capacity to independent resource'))
    assert.deepEqual(entered, ['holder', 'independent'])
    const waiting = (await t.step(async () => h.query('execution.list', { taskId: waiter.taskId })))[0]
    assert.equal(waiting.status, 'queued'); assert.equal(waiting.leaseEpoch, 0)
    assert.equal(waiting.resources.blocking[0].resourceKey, 'uat2')
    assert.equal(h.service.listAlerts().length, 0)
    // 在持有者不释放期间，等待者不能反复进入模型或增加执行租约。
    await t.step(async () => new Promise(resolve => setTimeout(resolve, 80)))
    assert.equal((await t.step(async () => h.query('execution.get', { executionId: waiting.executionId }))).leaseEpoch, 0)
    assert.ok(h.requests.filter(request => { try { return latestInput(request).task?.taskId === waiter.taskId } catch { return false } }).length < 6, 'resource conflict must not create a model/claim hot loop')
  } finally { gate.resolve() }
  await t.step(async () => h.service.whenIdle())
  assert.deepEqual(entered, ['holder', 'independent', 'waiter'])
  assert.ok((await t.step(async () => h.query('task.list'))).every(task => task.status === 'completed'), JSON.stringify({ tasks: (await t.step(async () => h.query('task.list'))).map(item => ({ status: item.status, recovery: item.providerRecovery })), executions: (await t.step(async () => h.query('execution.list'))).map(item => ({ key: item.key, objective: item.input.objective, status: item.status, error: item.result?.payload.error })), errors: h.toolResults.filter(item => item.result.isError) }))
  for (const execution of (await t.step(async () => h.query('execution.list'))).filter(item => item.key === 'run')) {
    assert.equal(execution.resources.state, 'released')
    assert.equal(await t.step(async () => readFile(join(fixture.root, 'tasks', execution.taskId, 'resource-proof.txt'), 'utf8')), execution.input.objective)
  }
}))

test('native delegation rejects changed keys on receipt replay and preserves omitted continuation keys', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-resource-continuation-')
  const team = nativeVerificationTeam()
  let stage = 0, executions = 0
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request)
    const verification = team.execute(request, input); if (verification) return verification
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      executions++
      return [call('execution_submit', { output: { status: 'completed', summary: input.objective, evidence: [], limitations: [], artifacts: [] } })]
    }
    const required = requiredDecisionRead(request, input); if (required) return [required]
    if (stage === 0) { stage++; return [call('task_delegate', { key: 'original', objective: 'first', resourceKeys: ['uat2'] })] }
    const execution = (await host.query('execution.list', { taskId: input.task.taskId }))[0]
    if (!execution?.drained || execution.status !== 'succeeded') return [decision('wait', '等待排空')]
    if (stage === 1) { stage++; return [call('task_delegate', { key: 'original', objective: 'first', resourceKeys: ['uat3'] })] }
    if (stage === 2) { stage++; return [call('task_delegate', { key: 'original', objective: 'first', resourceKeys: ['uat2'] }), call('task_execution_read', { executionId: execution.executionId })] }
    if (stage === 3) {
      stage++
      return [call('task_delegate', { key: 'continue', executionId: execution.executionId, objective: 'second' })]
    }
    if (execution.inputVersion === 2) { const more = team.owner(input, execution); if (more) return more }
    return [decision(execution.inputVersion === 2 && input.executions.length === 3 && input.executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '续办已核验')]
  })
  await t.beginBusiness()

  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'resource-continuation', objective: 'resource continuation' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(executions, 2)
  const all = await t.step(async () => h.query('execution.list')); assert.equal(all.length, 3); assert.equal(all.filter(item => item.key === 'original').length, 1)
  assert.deepEqual(all[0].resourceKeys, ['uat2']); assert.equal(all[0].inputVersion, 2)
  const results = h.toolResults.filter(item => item.name === 'task_delegate')
  assert.equal(results.filter(item => item.result.isError).length, 1)
  assert.match(JSON.stringify(results[1].result), /DYNAMIC_DISPATCH_KEY_CONFLICT/)
  assert.match(JSON.stringify(results[2].result), /"status":"succeeded"/)
  assert.match(JSON.stringify(results[2].result), /"state":"released"/)
  assert.match(JSON.stringify(h.toolResults.find(item => item.name === 'task_execution_read').result), /"state":"released"/)
}))

test('recovering an idle owner with no pending wake does not consume a task slot', { ...({ timeout: 10000 }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-idle-slot-')
  let rounds = 0
  const h = await fixture.host(async () => { rounds++; return [decision('wait', '没有具体执行待办')] }, { config: { maxConcurrentTasks: 1 } })
  await t.beginBusiness()

  await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'idle-a', objective: 'wait for input' }))
  await t.step(async () => h.service.whenIdle())
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'idle-b', objective: 'another independent wait' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(rounds, 2)
  assert.ok((await t.step(async () => h.query('task.list'))).every(task => task.sessionBound && task.drained))
}))

for (const persistent of [false, true]) test(`native session creation failure has bounded recovery retries: persistent=${persistent}`, { ...({ timeout: 10000 }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-retry-')
  const h = await fixture.host(async () => [decision('complete', 'native session recovered')], { config: { retryIntervalMs: 2000 } })
  await t.beginBusiness()

  const registry = h.ctx.agents, create = registry.create
  let attempts = 0
  h.ctx.agents.create = async function (options) {
    if (options.meta?.cwd && basename(options.meta.cwd).startsWith('task-') && (++attempts === 1 || persistent))
      throw Object.assign(new Error('NATIVE_SETUP_INJECTED_FAILURE'), { code: 'NATIVE_SETUP_INJECTED_FAILURE' })
    return create.call(this, options)
  }
  t.after(() => { registry.create = create })
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'setup-failure', objective: 'test native setup failure' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(attempts, 1)
  const failure = (await t.step(async () => h.service.recover())).failures.find(value => value.id === task.taskId)
  assert.ok(failure.retryAfter - Date.parse(failure.at) >= 2000, 'Persisted failure must retain the full configured retry delay')
  for (let i = 0; i < 3; i++) { await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle()) }
  assert.equal(attempts, 1, 'Explicit recovery cannot busy-loop inside the retry window')
  await t.step(async () => new Promise(resolve => setTimeout(resolve, Math.max(0, failure.retryAfter - Date.now()) + 10)))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(attempts, 2)
  const stored = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal(stored.drained, true)
  assert.equal(stored.status, persistent ? 'active' : 'completed')
  if (!persistent) assert.equal((await t.step(async () => h.service.recover())).failures.some(value => value.id === task.taskId), false)
}))

for (const persistent of [false, true]) test(`native model failures settle without repeated owner requests: persistent=${persistent}`, { ...({ timeout: 10000 }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-model-failure-')
  let requests = 0
  const h = await fixture.host(async () => {
    if (++requests === 1 || persistent) throw new Error('CONTROLLED_MODEL_FAILURE')
    return [decision('complete', 'new source recovered the existing native owner')]
  })
  await t.beginBusiness()

  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'model-failure', objective: 'test native model failure' }))
  await t.step(async () => h.service.whenIdle())
  for (let i = 0; i < 3; i++) { await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle()) }
  assert.equal(requests, 1)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).lastDecision.action, 'blocked')
  await t.step(async () => h.service.appendTaskContext({ taskId: task.taskId, requestId: 'model-retry-source', progressImpact: 'replan', context: 'Try this same task again with the new information.' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(requests, 2)
  const stored = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal(stored.drained, true)
  assert.equal(stored.status, persistent ? 'active' : 'completed')
  assert.equal(stored.sessionId, task.session.sessionId)
}))

test('empty owner recovery reviews the retained execution without replaying its completed native write', { ...({ timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const fixture = await nativeCase(t, 'task-empty-after-write-')
  const effect = join(fixture.root, 'effect.txt')
  const team = nativeVerificationTeam({ filePath: effect, expected: 'once' })
  let delegated = false, wrote = false, empty = false, reviewed = false, executionId
  const h = await fixture.host(async (request, host) => {
    const topics = topicTaskCalls(request); if (topics) return topics
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const verification = team.execute(request, input); if (verification) return verification
    if (names.includes('task_session_submit')) {
      if (!delegated) {
        delegated = true
        return [call('task_delegate', { key: 'once', objective: '只写一次并提交真实结果' }), decision('wait', '等待原执行')]
      }
      executionId = latestInput(request).executions[0].executionId
      if (!empty) { empty = true; return [] }
      if (!reviewed) { assert.match(requestSystemText(request), /上轮正常结束但未提交有效决定/); reviewed = true; return [call('task_execution_read', { executionId })] }
      const primary = (await host.query('execution.list'))[0], more = team.owner(input, primary); if (more) return more
      if (input.executions.length < 3 || input.executions.some(item => !item.drained || item.status !== 'succeeded')) return [decision('wait', '等待交付核验')]
      return [decision('complete', '已核对原执行，写入未重放')]
    }
    if (!wrote) {
      wrote = true
      return [call(nativeShell, { command: nativeShell === 'pwsh' ? `Add-Content -LiteralPath '${effect}' -Value once` : `echo once >> '${effect}'`, description: '仅执行一次受控写入' })]
    }
    return [call('execution_submit', { output: { status: 'completed', summary: '已完成一次写入', evidence: ['原生写入成功'], limitations: [], artifacts: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'empty-after-write', objective: '写一次后核对结果' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).providerRecovery.failure.code, 'TASK_SESSION_NO_SUBMISSION')
  assert.deepEqual((await t.step(async () => h.query('task.events'))).events, [], 'An empty Owner turn cannot publish a business completion event')
  try {
    // 单独核对五秒退避后的恢复；后续成员核验沿真实调度排空，仍受外层三十秒总时限约束。
    await t.step(async () => waitUntil(() => reviewed, 'retained owner recovery', 10000))
    await t.step(async () => h.service.whenIdle())
    assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).status, 'completed')
  }
  catch (error) { throw new Error(JSON.stringify({ task: await t.step(async () => h.query('task.get', { taskId: created.taskId })), executions: (await t.step(async () => h.query('execution.list'))).map(item => ({ key: item.key, status: item.status, error: item.result?.payload.error })), errors: h.toolResults.filter(item => item.result.isError) }), { cause: error }) }
  assert.equal(reviewed, true)
  assert.equal((await t.step(async () => readFile(effect, 'utf8'))).trim(), 'once')
  const executions = await t.step(async () => h.query('execution.list', { taskId: created.taskId }))
  assert.equal(executions.length, 3); assert.equal(executions.filter(item => item.key === 'once').length, 1)
  assert.equal(executions[0].executionId, executionId)
  assert.equal(executions[0].inputVersion, 1)
  assert.equal((await t.step(async () => h.query('operation.list', { taskId: created.taskId }))).filter(item => item.state === 'succeeded').length, 1)
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1)
  const events = (await t.step(async () => h.query('task.events'))).events
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'task.completed')
  assert.equal(events[0].taskId, created.taskId)
  const receipt = await t.step(async () => h.query('receipt.get', { id: events[0].taskDecisionReceiptId }))
  assert.equal(receipt.taskDecision.id, events[0].commandId)
  assert.equal(receipt.taskDecision.decision.action, 'complete')
  assert.deepEqual(receipt.completionEvent, events[0], 'The completion event is anchored to the exact formal Owner receipt')
  const operations = await t.step(async () => h.query('operation.list', { taskId: created.taskId }))
  await t.step(async () => h.service.recover())
  await t.step(async () => h.service.whenIdle())
  assert.deepEqual((await t.step(async () => h.query('task.events'))).events, events)
  assert.deepEqual((await t.step(async () => h.query('execution.list', { taskId: created.taskId }))).map(item => ({ executionId: item.executionId, inputVersion: item.inputVersion })),
    executions.map(item => ({ executionId: item.executionId, inputVersion: item.inputVersion })))
  assert.deepEqual((await t.step(async () => h.query('operation.list', { taskId: created.taskId }))).map(item => item.operationId), operations.map(item => item.operationId))
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1)
  assert.equal((await t.step(async () => readFile(effect, 'utf8'))).trim(), 'once')
}))

for (const correctOnce of [false, true]) test(`native owner empty-summary corrections are bounded and may recover: correctOnce=${correctOnce}`, { ...({ timeout: 10000 }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const fixture = await nativeCase(t, 'task-service-invalid-summary-')
  let requests = 0
  const h = await fixture.host(async () => {
    assert.ok(++requests <= 4, 'Invalid owner decisions must stop before a fifth model request')
    return [decision('complete', correctOnce && requests > 1 ? '纠正为空的summary后完成' : '  ')]
  })
  await t.beginBusiness()

  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'empty-summary', objective: 'test owner decision correction' }))
  await t.step(async () => h.service.whenIdle())
  const stored = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal(requests, correctOnce ? 2 : 3)
  assert.equal(stored.drained, true)
  assert.equal(stored.status, correctOnce ? 'completed' : 'active')
  const completionEvents = (await t.step(async () => h.query('task.events'))).events
  assert.equal(completionEvents.length, correctOnce ? 1 : 0, 'Only a valid complete submission may publish the authoritative event')
  if (correctOnce) {
    assert.equal(completionEvents[0].taskId, task.taskId)
    const receipt = await t.step(async () => h.query('receipt.get', { id: completionEvents[0].taskDecisionReceiptId }))
    assert.deepEqual(receipt.completionEvent, completionEvents[0])
    assert.equal(receipt.taskDecision.decision.action, 'complete')
  }
  const results = h.toolResults.filter(result => result.name === 'task_session_submit')
  assert.equal(results.filter(result => result.result.isError).length, correctOnce ? 1 : 3)
  assert.match(JSON.stringify(results[0].result), /TASK_SESSION_DECISION_INVALID/)
  if (!correctOnce) {
    assert.equal(stored.lastDecision.action, 'blocked')
    assert.match(stored.lastDecision.limitations.join(' '), /TASK_SESSION_DECISION_INVALID/)
    assert.equal(h.ctx.agents.get(stored.sessionId), undefined)
  }
  const saved = await t.step(async () => inspectSession(h.ctx.sessionPersistence, stored.sessionId))
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_session_submit').length, requests)
  await t.step(async () => h.service.whenIdle())
  assert.equal(requests, correctOnce ? 2 : 3)
  assert.deepEqual((await t.step(async () => h.query('task.events'))).events, completionEvents)
}))

test('native triage rejects unread source and accepts correction in the same real session', { timeout: 60000 }, async t => {
  let root, rootReady, opening, h, requests = 0, activity = 'host-preparation'
  await lifecycleStages(t, {
    limits: { business: 10000 },
    prepare: async step => {
      root = await step(() => (rootReady = mkdtemp(join(tmpdir(), 'task-service-invalid-route-'))))
      h = await step(() => (opening = nativeTaskHost(root, async request => {
        if (request.tools.some(tool => tool.name === 'triage_submit') && requests++ === 0)
          return [call('triage_submit', { needsProcessing: true, reply: null })]
        return directRouterCalls(request) ?? [decision('complete', '完整读取来源后完成任务')]
      })))
    },
    business: async (_value, step) => {
      activity = 'ingest'
      const ingested = await step(() => h.service.ingest({ ...message, messageId: 'invalid-source-coverage', text: message.text.repeat(80) }))
      activity = 'routing-drain'
      await step(() => h.service.whenIdle())
      assert.ok(requests >= 2)
      assert.equal((await step(() => h.query('source.get', { sourceId: ingested.sourceId }))).routed, true)
      const tasks = await step(() => h.query('task.list'))
      assert.equal(tasks.length, 1)
      assert.equal(tasks[0].status, 'completed')
      assert.ok(tasks[0].sourceRefs.includes(ingested.sourceId))
      const results = h.toolResults.filter(result => result.name === 'triage_submit')
      assert.equal(results[0].result.isError, true)
      assert.match(JSON.stringify(results[0].result), /router_source_unread/)
      assert.ok(h.toolResults.some(result => result.name === 'router_source_read' && !result.result.isError))
      assert.ok(results.some(result => !result.result.isError && result.sessionId === results[0].sessionId))
      activity = 'session-persistence'
      const saved = await step(() => inspectSession(h.ctx.sessionPersistence, results[0].sessionId))
      assert.ok(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'triage_submit').length >= 2)
      activity = 'final-drain'
      const before = requests
      await step(() => h.service.whenIdle())
      assert.equal(requests, before)
    },
    cleanup: async () => {
      t.diagnostic(JSON.stringify({ topicCorrectionActivity: activity, routeCalls: requests }))
      if (rootReady) root = await rootReady
      if (opening) h = await opening
      await h?.close()
      if (root) await rm(root, { recursive: true, force: true })
    },
  })
})

test('resident.apply boots and disposes with only its declared native service dependencies', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-resident-native-')
  const h = await fixture.host(() => { throw new Error('Startup must not invoke the model') }, { resident: true })
  await t.beginBusiness()

  for (const name of resident.inject) assert.ok(h.ctx.get(name), 'Declared dependency available: ' + name)
  for (const name of ['subagents', 'goal', 'workflow', 'execution']) assert.equal(h.ctx.get(name), undefined, 'Retired dependency must not be required: ' + name)
  const probe = createServer()
  await t.step(async () => new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)))
  const port = probe.address().port
  await t.step(async () => new Promise(resolve => probe.close(resolve)))
  const env = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  const fiber = await t.step(async () => h.ctx.plugin(resident, { host: '127.0.0.1', port, agentWorkspaceDir: fixture.root, agentPreset: 'native-test', proxyUrl: '',
    groups: [{ groupId: 'native-group', name: 'native group', responsibility: 'native startup test' }], dws: { enabled: false },
    taskSessions: { dbPath: join(fixture.root, 'resident.db'), instanceId: 'resident-native', ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', initialize: true, recoveryIntervalMs: 60000 } }))
  const read = path => new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}${path}`, { agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) } })
  }).on('error', reject))
  assert.deepEqual((await t.step(async () => read('/health'))).body.status, 'ok')
  const groups = await t.step(async () => read('/state/groups'))
  assert.equal(groups.status, 200)
  assert.equal(groups.body[0].groupId, 'native-group')
  assert.equal((await t.step(async () => read('/state/agent-config'))).body.workspaceDir, fixture.root)
  assert.equal(h.requests.length, 0)
  await t.step(async () => fiber.dispose())
  await t.step(async () => assert.rejects(read('/health'), { code: 'ECONNREFUSED' }))
}))

test('resident listener startup failure disposes native resources and permits reopening the same task database', { ...({ timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const fixture = await nativeCase(t, 'task-resident-start-failure-')
  const occupied = createServer()
  t.after(() => occupied.listening ? new Promise(resolve => occupied.close(resolve)) : undefined)
  await t.beginBusiness()
  await t.step(async () => new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve)))
  const port = occupied.address().port
  const config = { host: '127.0.0.1', port, agentWorkspaceDir: fixture.root, agentPreset: 'native-test', proxyUrl: '', dws: { enabled: false },
    taskSessions: { dbPath: join(fixture.root, 'startup.db'), instanceId: 'startup-failure', ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', initialize: true } }
  const failed = await t.step(async () => fixture.host(() => { throw new Error('MODEL_NOT_EXPECTED') }, { resident: true }))
  await t.step(async () => assert.rejects(resident.apply(failed.ctx, config), { code: 'EADDRINUSE' }))
  await t.step(async () => failed.close())
  await t.step(async () => new Promise(resolve => occupied.close(resolve)))
  const next = await t.step(async () => fixture.host(() => { throw new Error('MODEL_NOT_EXPECTED') }, { resident: true }))
  await t.step(async () => resident.apply(next.ctx, { ...config, taskSessions: { ...config.taskSessions, initialize: false } }))
  const health = await t.step(async () => new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}/health`, { agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
  }).on('error', reject)))
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')
  assert.equal(next.requests.length, 0)
}))


test('native board keeps a drained coordinator running while its delegated target is executing', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const fixture = await nativeCase(t, 'task-board-active-execution-'), release = Promise.withResolvers()
t.onCancel(() => release.resolve())

  t.after(() => release.resolve())
  let delegated = false, prematureCompletion = false
  const h = await fixture.host(async request => {
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'board-state', objective: '只读核对当前执行状态' })] }
      if (!prematureCompletion) { prematureCompletion = true; return [decision('complete', '尝试在唯一执行尚未排空时完成')] }
      return [decision(input.executions.length === 1 && input.executions.every(execution => execution.drained && execution.status === 'succeeded') ? 'complete' : 'wait', '等待小目标执行结果')]
    }
    await release.promise
    if (!modelToolValues(request).some(value => value.taskId === input.task.taskId && Array.isArray(value.executions))) return [call('execution_team_read', {})]
    return [call('execution_submit', { output: { status: 'completed', summary: '已核对', evidence: [], limitations: [], artifacts: [] } })]
  })
  await t.beginBusiness()

  try {
    await t.step(async () => h.service.ingest(message))
    const task = await t.step(async () => waitUntil(async () => {
      const [task] = await h.query('task.list'), executions = await h.query('execution.list')
      return task?.drained && task.lastDecision?.action === 'wait' && executions.some(execution => execution.status === 'running' && !execution.drained) ? task : null
    }, 'coordinator waits while native execution remains running'))
    const view = (await t.step(async () => h.service.boardTasks())).find(item => item.taskId === task.taskId)
    assert.equal(view.state, 'running')
    assert.equal(view.waitingReason, '')
    assert.equal((await t.step(async () => h.service.taskDetail(task.taskId))).state, 'running')
    const rejection = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
    assert.equal(rejection.length, 1)
    const blockers = JSON.parse(rejection[0].result.error.message)
    assert.equal(blockers.executions.length, 1)
    assert.equal(blockers.executions[0].taskId, task.taskId)
    assert.equal(blockers.executions[0].drained, false)
  } finally { release.resolve(); await t.step(async () => h.service.whenIdle()) }
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed', 'The same single-member task completes only after physical drain')
}))

test('native single-member completion keeps an unknown tool effect unresolved without replay', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const fixture = await nativeCase(t, 'task-single-unknown-effect-')
  let delegated = false, attemptedComplete = false, executed = false
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) {
        delegated = true
        host.ctx.tools.register({ name: 'uncertain_native_write', description: 'Write a real file then simulate loss of the tool acknowledgement', parameters: { type: 'object' },
          output: { schema: { type: 'object' }, render: () => [] }, async execute() {
            await writeFile(join(fixture.root, 'tasks', input.task.taskId, 'uncertain-effect.txt'), 'once')
            throw new Error('lost acknowledgement after file write')
          } })
        return [call('task_delegate', { key: 'uncertain-effect', objective: '执行一次文件写入并保留工具失败事实' })]
      }
      const [execution] = await host.query('execution.list', { taskId: input.task.taskId })
      if (!execution?.drained) return [decision('wait', '等待原执行排空')]
      if (!attemptedComplete) { attemptedComplete = true; return [decision('complete', '尝试在原操作效果未知时完成')] }
      return [decision('wait', '原操作效果未知，保留证据且不重放')]
    }
    if (!executed) {
      executed = true
      return [call('uncertain_native_write', {})]
    }
    return [call('execution_submit', { output: { status: 'blocked', summary: '原工具回执失败，未重放写入', evidence: ['uncertain-effect.txt'], limitations: ['操作账仍为未知效果'], artifacts: [] } })]
  })
  await t.beginBusiness()

  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'single-unknown-effect', objective: '核对失败后原操作效果，不重放原动作' }))
  await t.step(async () => h.service.whenIdle())
  const [execution] = await t.step(async () => h.query('execution.list', { taskId: created.taskId })), operations = await t.step(async () => h.query('operation.list', { taskId: created.taskId }))
  assert.equal(execution.drained, true)
  assert.equal(operations.length, 1); assert.equal(operations[0].state, 'unknown')
  assert.equal(await t.step(async () => readFile(join(fixture.root, 'tasks', created.taskId, 'uncertain-effect.txt'), 'utf8')), 'once')
  assert.equal((await t.step(async () => h.query('task.get', { taskId: created.taskId }))).status, 'active')
  assert.equal(attemptedComplete, true)
  const rejection = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
  assert.equal(rejection.length, 1)
  const blockers = JSON.parse(rejection[0].result.error.message)
  assert.equal(blockers.operations.length, 1); assert.equal(blockers.operations[0].state, 'unknown')
  assert.equal(blockers.operations[0].operationId, operations[0].operationId)
  assert.equal(h.toolResults.filter(item => item.name === 'uncertain_native_write').length, 1)
  assert.equal((await t.step(async () => h.query('task.events'))).events.length, 0, 'An unresolved effect cannot publish task completion')
}))


test('native recovery no-op preserves an undrained task writer conflict alert', { ...({ timeout: 10000 }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const fixture = await nativeCase(t, 'task-live-conflict-alert-')
  const h = await fixture.host(async () => [decision('complete', '不应执行')], { config: { retryIntervalMs: 100 } })
  await t.beginBusiness()

  const registry = h.ctx.agents, create = registry.create
  h.ctx.agents.create = async function (options) {
    if (options.meta?.cwd && basename(options.meta.cwd).startsWith('task-')) throw Object.assign(new Error('TASK_SESSION_ALREADY_LIVE'), { code: 'TASK_SESSION_ALREADY_LIVE', taskSessionDrained: false })
    return create.call(this, options)
  }
  t.after(() => { registry.create = create })
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'live-conflict', objective: '保留原写者冲突诊断' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).drained, false)
  const original = (await t.step(async () => h.service.recover())).failures.find(item => item.id === task.taskId)
  assert.equal(original.code, 'TASK_SESSION_ALREADY_LIVE')
  await t.step(async () => new Promise(resolve => setTimeout(resolve, 150)))
  const recovered = await t.step(async () => h.service.recover())
  assert.equal(recovered.failures.find(item => item.id === task.taskId)?.code, original.code)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).drained, false)
}))

test('execution document publication failure after claim drains the committed execution and exposes an alert', { ...({ timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-document-claim-failure-'))
  let h, backing, delegated = false, poisoned = false, executionCalls = 0, claimed
  t.after(async () => { try { await h?.close(); await backing?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  await t.beginBusiness()
  backing = await t.step(async () => openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true }))
  const store = { ...backing, async command(input) {
    const receipt = await backing.command(input)
    if (!poisoned && input.kind === 'execution.claim') {
      claimed = await backing.query({ kind: 'execution.get', executionId: receipt.result.execution.executionId })
      assert.equal(claimed.status, 'running'); assert.equal(claimed.drained, false)
      const path = join(root, 'tasks', claimed.taskId, 'outputs', claimed.executionId, `round-${claimed.inputVersion}.md`)
      assert.ok((await readFile(path, 'utf8')).startsWith('<!-- execution-document '))
      // 真实文件故障发生在 claim 已提交之后；不模拟 Store 拒绝或改变生命周期。
      await rm(path); await mkdir(path); poisoned = true
    }
    return receipt
  } }
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const topics = topicTaskCalls(request); if (topics) return topics
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'document-failure-check', objective: '只读核对当前材料' })] }
      return [decision('wait', '等待当前执行的实际结果')]
    }
    executionCalls++
    return [call('execution_submit', { output: { status: 'completed', summary: '不应在文档读取失败时执行', evidence: [], limitations: [], artifacts: [] } })]
  }, { store }))
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'document-write-failure', objective: '只读核对当前材料' }))
  await t.step(async () => h.service.whenIdle())
  assert.equal(poisoned, true)
  const execution = await t.step(async () => h.query('execution.get', { executionId: claimed.executionId }))
  assert.equal(execution.executionId, claimed.executionId); assert.equal(execution.leaseEpoch, claimed.leaseEpoch)
  assert.equal(execution.status, 'failed'); assert.equal(execution.drained, true); assert.equal(execution.sessionBound, false)
  assert.equal(execution.result.payload.error.code, 'EXECUTION_DOCUMENT_PATH_INVALID')
  assert.equal(executionCalls, 0); assert.equal((await t.step(async () => h.query('operation.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'active')
  assert.ok(h.service.listAlerts().some(item => item.alertId === `failure:execution-document:${execution.executionId}` && item.detail === 'EXECUTION_DOCUMENT_PATH_INVALID'))
}))

testRunner('resource read retries preserve image facts and duplicate ingress reuses the source', { ...({ skip: !available ? reason : false, timeout: 20000 }), timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async (t) => {
  await t.beginBusiness()
  const { openResidentStore } = await t.step(async () => import('../packages/dingtalk-dsh-assistant/store.js'))
  const { openTaskSessionService } = await t.step(async () => import('../packages/dingtalk-dsh-assistant/task-session-service.js'))
  const root = await t.step(async () => mkdtemp(join(tmpdir(), 'native-ingress-phases-')))
  let h, reads = 0
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await t.step(async () => nativeTaskHost(root, request => topicTaskCalls(request, { needsProcessing: false }) ?? [], { resident: true }))
  h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
  await t.step(async () => h.residentStore.subscribe({ groupId: 'phase-group', name: '隔离计时群' }))
  h.service = await t.step(async () => openTaskSessionService({ ctx: h.ctx, residentStore: h.residentStore,
    legacy: { getGroup: id => h.residentStore.getGroup(id), getAgentConfig: () => ({ workspaceDir: root, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', agentNames: ['测试助手'] }) },
    config: { workspaceDir: root, dbPath: join(root, 'dynamic.db'), instanceId: 'native-ingress', initialize: true, ownerActorId: 'native-user', webActorId: 'native-user', provider: 'native-task-test' },
    readResource: async () => {
      if (++reads === 1) throw Object.assign(new Error('offline'), { code: 'OFFLINE' })
      return { image: { mediaType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQy7vzHwAEfgJodQLI1QAAAABJRU5ErkJggg==', 'base64') } }
    }, notifications: { send: () => assert.fail('不得发送消息'), readback: () => assert.fail('不得读取渠道回执') } }))
  const message = { groupId: 'phase-group', messageId: 'image-message', occurredAt: '2026-10-27T05:30:27.636Z', senderOpenDingTalkId: 'native-user', text: '图片入站计时', resourceRefs: [{ type: 'mediaId', resourceId: 'private-media' }] }
  const first = await t.step(async () => h.service.ingest(message))
  const failed = await t.step(async () => h.service.store.query({ kind: 'source.get', sourceId: first.sourceId }))
  const retry = await t.step(async () => h.service.ingest(message))
  await t.step(async () => h.service.whenIdle()) // Settle legitimate queue/router spans before checking duplicate-ingress stability.
  const success = await t.step(async () => h.service.store.query({ kind: 'source.get', sourceId: retry.sourceId }))
  assert.notEqual(retry.sourceId, first.sourceId)
  assert.equal(h.residentStore.getGroup('phase-group').messages[0].imageRefs.length, 1)
  assert.equal(JSON.stringify(success.stages).includes('private-media'), false)
  const repeated = await t.step(async () => h.service.ingest({ ...message, imageRefs: h.residentStore.getGroup('phase-group').messages[0].imageRefs }))
  assert.equal(repeated.sourceId, retry.sourceId)
  assert.equal(h.residentStore.getGroup('phase-group').messages.filter(item => item.messageId === message.messageId).length, 1)
  assert.equal(reads, 2)
}))


testRunner('周期恢复与调度跨过百条已排空历史，不展开执行正文也不启动模型', { skip: !available ? reason : false, timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-background-scan-'))
  let host, modelCalls = 0, forbiddenReads = 0
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, () => { modelCalls++; throw new Error('history must not start a model') }))
  const db = new DatabaseSync(join(root, 'dynamic.db'))
  const marker = 'TERMINAL_EXECUTION_BODY_MUST_NOT_REACH_BACKGROUND_JS'
  try {
    const insert = db.prepare('INSERT INTO dynamic_executions(id,body) VALUES (?,?)')
    for (let i = 0; i < 103; i++) {
      const execution = { id: `history-${i}`, executionId: `history-${i}`, taskId: 'historical-task', status: i % 2 ? 'succeeded' : 'stale',
        drained: true, sessionBound: false, definition: { executionBackend: i % 2 ? 'claude-code' : 'dsh' }, input: { objective: marker } }
      insert.run(execution.id, JSON.stringify(execution))
    }
  } finally { db.close() }
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', function (text, ...args) {
    if (String(text).includes(marker)) { forbiddenReads++; throw new Error('terminal history body expanded') }
    return parse(text, ...args)
  })
  try {
    const result = await t.step(async () => host.service.recover())
    await t.step(async () => host.service.whenIdle())
    assert.equal(forbiddenReads, 0, '包括调度异常被记录的情况，不允许静默吞掉历史展开')
    assert.equal(modelCalls, 0)
    assert.deepEqual(result.failures, [])
  } finally { t.mock.restoreAll() }
}))


testRunner('群身份与入站校验不展开展示消息，展示层仍实时过滤通知', { skip: !available ? reason : false, timeout: nativeLifecycleTimeout(20000) }, nativeLifecycle(20000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-group-identity-'))
  let host, facade, visits = 0, models = 0
  const history = Array.from({ length: 1000 }, (_, i) => ({ messageId: `history-${i}`, text: 'synthetic history' }))
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, () => { models++; throw Error('identity check must not start a model') }, {
    serviceFactory: async options => {
      facade = await openTaskResidentRuntime(options.ctx, { ...options.residentStore,
        getGroup: id => { const group = options.residentStore.getGroup(id); return group && { ...group, messages: history } },
      }, root)
      facade.getAgentConfig = options.legacy.getAgentConfig
      facade.isOwnNotification = message => { visits++; return message.messageId === 'history-0' }
      return openTaskSessionService({ ...options, legacy: facade })
    },
  }))
  assert.equal(facade.getGroup('native-group').messages.length, 999)
  assert.equal(visits, 1000, '夹具确实走真实展示过滤器')
  visits = 0
  for (let i = 0; i < 100; i++) assert.equal(host.service.isGroup('native-group'), true)
  assert.equal(host.service.isGroup('absent'), false)
  await assert.rejects(host.service.ingest({ groupId: 'native-group', messageId: 'unauthenticated' }), /TASK_SESSION_AUTHENTICATED_SOURCE_REQUIRED/)
  await assert.rejects(host.service.ingest({ groupId: 'absent', messageId: 'outside', senderOpenDingTalkId: 'native-user' }), /group_not_subscribed/)
  assert.equal(visits, 0, '身份校验不得为每次入站重新过滤整个历史')
  facade.isOwnNotification = message => { visits++; return message.messageId === 'history-1' }
  const visible = facade.getGroup('native-group').messages
  assert.equal(visible.length, 999)
  assert.equal(visible.some(message => message.messageId === 'history-0'), true)
  assert.equal(visible.some(message => message.messageId === 'history-1'), false, '通知身份变化不缓存旧展示')
  await host.residentStore.removeGroup({ groupId: 'native-group' })
  assert.equal(host.service.isGroup('native-group'), false, '群删除后身份即时失效')
  assert.equal(models, 0)
}))
