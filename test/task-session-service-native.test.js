import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import * as resident from '../packages/dingtalk-dsh-assistant/resident.js'
import { available, reason, nativeShell, nativeTaskHost, latestInput, modelToolValues, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { taskSessionLogRoot } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { retireTaskContext } from '../packages/dingtalk-dsh-assistant/task-session.js'

testRunner('原生网页工具错误不建立未知效果，仍可完成后续读取', { skip: !available ? reason : false, timeout: 20000 }, async t => {
 const root=await mkdtemp(join(tmpdir(),'native-web-read-'))
 let host, delegated=false, calls=0
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
 host=await nativeTaskHost(root, async(request,h)=>{
  const topics=topicTaskCalls(request);if(topics)return topics
  const names=request.tools.map(tool=>tool.name)
  if(names.includes('task_delegate')) {
   if(!delegated){
    delegated=true
    for(const name of ['web_fetch','web_search']) h.ctx.tools.register({name,description:'Native readonly web contract fixture',parameters:{type:'object'},
     output:{schema:{type:'object'},render:()=>[]},execute(){calls++;throw new Error('unsupported content type')}})
    return [{name:'task_delegate',args:{key:'read',objective:'读取网页并如实记录错误'}}]
   }
   return [{name:'task_session_submit',args:{decision:{action:'complete',summary:'已核对读取失败，未重放请求',evidence:[],limitations:['网页内容不支持']}}}]
  }
  if(calls===0)return [{name:'web_fetch',args:{}}]
  if(calls===1)return [{name:'web_search',args:{}}]
  return [{name:'execution_submit',args:{output:{status:'completed',summary:'已记录两次读取失败',evidence:[],limitations:['内容不可读'],artifacts:[]}}}]
 })
 await host.service.ingest({groupId:'native-group',messageId:'web-failure',senderOpenDingTalkId:'native-user',text:'测试助手，读取并报告结果',timestamp:'2026-10-13T11:00:00Z'})
 await host.service.whenIdle()
 assert.equal(calls,2);assert.equal((await host.query('operation.list')).length,0)
 assert.equal((await host.query('task.list'))[0].status,'completed')
 assert.equal((await host.query('task.list'))[0].humanRequests?.length ?? 0,0)
})
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { findSessionLog, requestSystemText } from './fixtures/session-persistence.js'

const call = (name, args) => ({ name, args })
const test = (name, options, run) => testRunner(name, { ...options, ...(!available ? { skip: reason } : {}) }, run)
const decision = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: ['实际文件和进程输出已核验'], limitations: [] } })
const message = { groupId: 'native-group', messageId: 'native-message-1', senderOpenDingTalkId: 'native-user', senderName: '真实用户', text: '测试助手，分别生成 alpha 和 beta 的文件并用终端验证，再汇总结论。', occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' }

async function nativeCase(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix)), hosts = []
  t.after(async () => { try { for (const host of hosts.toReversed()) await host.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { root, async host(decide, options) { const host = await nativeTaskHost(root, decide, options); hosts.push(host); return host } }
}

test('owner injects one authoritative source body across task, Web identity and materials', { timeout: 30000 }, async t => {
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
    return [decision('complete', 'only analysis')]
  })
  await h.service.createTask({ groupId: 'native-group', requestId: 'indexed-web', objective: body, context: body })
  await h.service.whenIdle()
  assert.ok(counts.length > 0, JSON.stringify(h.service.listAlerts()))
  t.diagnostic(JSON.stringify({ scope: 'actual native owner scripted adapter UTF-8 JSON bytes', bodyCopies: counts, metrics }))
  assert.deepEqual(counts, counts.map(() => 1), 'one complete authority body in each real model request')
  assert.equal(h.service.listAlerts().length, 0)
  const [source] = await h.query('source.list'), [task] = await h.query('task.list')
  assert.equal(source.text, body)
  assert.equal(source.requestIdentity.request.args.context, body, 'Web admission identity remains raw in the ledger')
  const dto = await h.service.taskDetail(task.taskId)
  assert.equal(dto.request, task.request)
  assert.deepEqual(dto.completion, task.completion, 'Observer still receives the original task completion')
  assert.equal(dto.executions.length, 0)
  const saved = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  const current = h.requests.at(-1).messages.find(message => message.source?.taskSession && !message.source.taskContextHistory)
  const raw = saved.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => message.id === current.source.rawHostMessageId)
  assert.ok(raw)
  assert.ok(raw.content[0].text.split(body).length - 1 > 1, 'raw admission audit is not deduplicated to shrink display')
  assert.equal(JSON.parse(raw.content[0].text).sources[0].requestIdentity.request.args.context, body)
})

for (const ownEcho of [true, false]) test(`话题历史${ownEcho ? '自身通知不阻断同账号人工补充' : '未准入真实消息仍拒绝更新且不发送成功回复'}`, { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-topic-source-')
  let topicId, originalTask, ownerCalls = 0
  const readReviews = new Set()
  const h = await fixture.host(async request => {
    assert.ok(h.requests.length < 12, JSON.stringify(h.toolResults.slice(-2)))
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      if (topicId) for (const route of calls[0].args.routes) for (const unit of route.units)
        unit.topics = [{ topicId, relationship: 'continuation', reason: '原任务的人工补充' }]
      return calls
    }
    if (names.includes('group_decision_submit') && topicId) {
      if (!readReviews.has(input.requestId)) {
        readReviews.add(input.requestId)
        return [call('group_reply_review_get', { requestIds: [input.requestId] })]
      }
      const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      const review = h.toolResults.findLast(item => item.name === 'group_reply_review_get')
      const reviewedOutboundIds = JSON.parse(review.result.content[0].text).candidates.map(item => item.outboundId)
      return [call('group_decision_submit', { requestId: input.requestId, topicId, revision: input.revision, decision: {
        basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs,
        actions: [{ kind: 'task-context', taskId: originalTask.taskId, inputVersion: originalTask.requirementRevision,
          runSequence: originalTask.runSequence, context: '先核对正确开发分支，这不是批准例外', progressImpact: 'preserve',
          topicRefs: [{ topicId, revision: input.revision }], basisUnitRefs }],
        reply: '已补入原任务，先核对正确分支。', replyReview: { kind: 'substantive', reviewedOutboundIds, sameMatterOutboundIds: [], replaceOutboundIds: [] },
      } })]
    }
    const calls = topicTaskCalls(request)
    if (calls) return calls
    if (++ownerCalls === 1) return [call('task_session_submit', { decision: { action: 'blocked', summary: '需要核对开发来源', question: '是否批准分支例外？', evidence: [], limitations: [] } })]
    assert.equal(input.task.sessionId, originalTask.sessionId)
    assert.ok(input.sources.some(source => source.text === '先核对分支，不是批准例外'))
    assert.ok(input.sources.every(source => source.messageId !== 'native-notification-1'))
    return [decision('complete', '已按补充要求核对分支')]
  }, { config: { assistantActorId: 'native-user' } })
  await h.service.ingest(message); await h.service.whenIdle()
  ;[originalTask] = await h.query('task.list')
  topicId = originalTask.topicRefs[0].topicId
  const echo = { ...message, messageId: ownEcho ? 'native-notification-1' : 'unadmitted-user-message',
    text: ownEcho ? h.sent[0].payload.text : '需要保留的真实历史指令', quotedMessage: { messageId: message.messageId, content: message.text }, occurredAt: '2026-10-13T10:01:00Z' }
  await h.residentStore.ingest(echo)
  await h.residentStore.routeMessages({ groupId: message.groupId, routeId: 'historical-echo-route', routingRevision: h.residentStore.getGroup(message.groupId).routingRevision, routes: [{ messageId: echo.messageId, messageVersion: 1,
    topics: [{ topicId, relationship: 'continuation', reason: '历史话题上下文' }] }] })
  const sentBefore = h.sent.filter(notification => notification.kind === 'topic-reply').length
  await h.service.ingest({ ...message, messageId: 'manual-followup', text: '先核对分支，不是批准例外', occurredAt: '2026-10-13T10:02:00Z' })
  await h.service.whenIdle()
  const [task] = await h.query('task.list')
  assert.equal((await h.query('task.list')).length, 1)
  assert.ok(!(await h.query('source.list')).some(source => source.messageId === echo.messageId))
  if (ownEcho) {
    assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
    assert.equal(task.humanRequests[0].status, 'superseded', '群补充是需求修订，不能作为operator技术申请答复')
    assert.equal(ownerCalls, 2)
    assert.equal(h.residentStore.getTopic(message.groupId, topicId).processedRevision, 3)
  } else {
    assert.equal(task.humanRequests[0].status, 'waiting-reply')
    assert.equal(ownerCalls, 1)
    assert.equal(h.sent.filter(notification => notification.kind === 'topic-reply').length, sentBefore)
    const blocked = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.error, 'TASK_TOPIC_SOURCE_VERSION_MISSING')
    // 模拟旧版先回复再失败，投影后的来源身份已改变。
    const notificationId = blocked.outboundId, topicRefs = [{ topicId, revision: blocked.revision }]
    await h.residentStore.appendOutbox({ groupId: message.groupId, outboundId: notificationId, decisionId: blocked.decisionId,
      sourceMessageId: `topic-decision:${blocked.decisionId}`, text: blocked.decision.reply,
      replyToMessageId: 'manual-followup', replyToSenderOpenDingTalkId: 'native-user' })
    await h.service.store.command({ id: `prepare-notification:${notificationId}`, kind: 'notification.prepare', args: {
      notificationId, taskId: originalTask.taskId, requirementRevision: 1, kind: 'topic-reply', payload: {
        text: blocked.decision.reply, topicRefs, replyKind: 'substantive', conversationId: message.groupId,
        sourceMessageId: 'manual-followup', actorId: 'native-user', replyToMessageId: 'manual-followup',
        replyToSenderOpenDingTalkId: 'native-user', atOpenDingTalkIds: ['native-user'], fact: { topicRefs }, kind: 'topic-reply',
      },
    } })
    const started = await h.service.store.command({ id: 'fixture-old-reply-start', kind: 'notification.start', args: { notificationId } })
    const delivered = await h.service.store.command({ id: 'fixture-old-reply-delivered', kind: 'notification.delivered', args: {
      notificationId, dispatchToken: started.result.notification.dispatchToken, receipt: { messageId: 'historical-reply-id' },
    } })
    await projectTaskNotification({ residentStore: h.residentStore, notification: delivered.result.notification })
    await h.service.store.command({ id: 'fixture-admit-historical-source', kind: 'source.record', args: {
      sourceId: 'fixture-historical-source', groupId: message.groupId, messageId: echo.messageId, version: 1,
      actorId: message.senderOpenDingTalkId, text: echo.text, timestamp: echo.occurredAt,
    } })
    const append = h.residentStore.appendOutbox
    h.residentStore.appendOutbox = args => {
      if (args.outboundId === notificationId) throw new Error('outbox_identity_duplicate')
      return append(args)
    }
    await h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' }); await h.service.whenIdle()
    h.residentStore.appendOutbox = append
    const replyBlocked = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
    assert.equal(replyBlocked.error, 'outbox_identity_duplicate')
    assert.ok(replyBlocked.operations.every(operation => operation.status === 'applied'))
    await h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' }); await h.service.whenIdle()
    assert.equal((await h.query('task.list'))[0].status, 'completed', JSON.stringify(h.service.listAlerts()))
    assert.equal(ownerCalls, 2)
    assert.equal((await h.query('notification.get', { notificationId })).state, 'delivered')
    assert.equal(h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === notificationId).deliveredMessageId, 'historical-reply-id')
    assert.equal(h.sent.filter(notification => notification.kind === 'topic-reply').length, sentBefore)
    const oldEcho = await h.service.ingest({ ...message, messageId: 'historical-reply-id', text: blocked.decision.reply })
    assert.equal(oldEcho.reason, 'own-notification', '重放 prepared 收据不能覆盖当前 delivered 的发送身份缓存')
    const sentAfter = h.sent.length
    await h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' }); await h.service.whenIdle()
    assert.equal(h.sent.length, sentAfter, '已应用动作和已送达回复不能因重复重试再次执行')
    assert.equal(ownerCalls, 2)
  }
})

test('180 legacy task Host markers retire without changing audit or foreign context, including compacted surface replay', { timeout: 30000 }, async t => {
  const { createUserMessage, createSystemMessage } = await import('@deepseek-ai/dsh-llm')
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const fixture = await nativeCase(t, 'task-host-retirement-')
  const h = await fixture.host(async () => [])
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
})

test('owner keeps one current Host snapshot and delegates non-recursive execution context across three generations', { timeout: 30000 }, async t => {
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
      assert.match(JSON.stringify(snapshots[0]), /CURRENT_AUTHORIZATION_SCOPE_/)
      for (const execution of input.executions) {
        assert.equal(execution.input.previousExecutions, undefined)
        assert.equal(execution.input.context, undefined)
        assert.equal(execution.definition, undefined)
        assert.equal(execution.results, undefined)
        if (execution.resultRef) {
          const page = modelToolValues(request).find(value => value.contentRef === execution.resultRef.contentRef && value.path === '/payload/output/summary')
          if (!page) return [call('model_content_read', { contentRef: execution.resultRef.contentRef, path: '/payload/output/summary' })]
          assert.equal(page.text ?? page.resolvedRef, execution.input.objective, 'original result is read through the admitted content tool')
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
  await h.service.ingest({ ...message, text: message.text + scope }); await h.service.whenIdle()
  const [task] = await h.query('task.list')
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await h.query('execution.list')).length, 3)
  const log = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  assert.ok(log.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession && !event.data.source.taskContextHistory).length >= 4,
    '原始Host输入仍在审计日志')
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const folded = foldSurface(log.events)
  const visible = folded.nodes.map(seq => deriveEventMessage(log.events[seq], folded.projectedMessages)).filter(Boolean)
  assert.equal(visible.filter(message => message.source?.taskSession).length, 1)
  assert.equal(visible.filter(message => message.source?.taskContextHistory).length, 0)
  const last = ownerRequests.at(-1)
  console.log(JSON.stringify({ contextProof: { ownerRequests: ownerRequests.length,
    latestInputBytes: Buffer.byteLength(JSON.stringify(latestInput(last))), totalRequestBytes: Buffer.byteLength(JSON.stringify(last)) } }))
})

test('32 continuations bound owner Host input and execution-read tool results while preserving authority and unknown effects', { timeout: 120000 }, async t => {
  const fixture = await nativeCase(t, 'task-five-context-'), metrics = []
  let ownerSteps = 0
  const scope = 'ONLY_ANALYZE_AUTHORIZATION_'.repeat(300)
  const h = await fixture.host(async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const input = latestInput(request)
    if (!request.tools.some(tool => tool.name === 'task_delegate')) return [call('execution_submit', { output: { status: 'completed', summary: 'done-' + input.objective, evidence: ['UNKNOWN_EFFECT: observed, never replay'], limitations: ['analysis only'], artifacts: [] } })]
    const host = request.messages.filter(m => m.source?.taskSession && !m.source.taskContextHistory)
    assert.equal(host.length, 1)
    assert.match(JSON.stringify(input.sources), /ONLY_ANALYZE_AUTHORIZATION_/)
    for (const e of [...input.executions, ...input.blockers.executions]) {
      assert.equal(e.input.previousExecutions, undefined); assert.equal(e.input.context, undefined); assert.equal(e.results, undefined); assert.equal(e.inputHistory, undefined)
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
      const path = ['/payload/output', '/payload/output/summary', '/payload/output/evidence/0']
        .find(path => !values.some(value => value.contentRef === execution.resultRef?.contentRef && value.path === path))
      if (path) return [call('model_content_read', { contentRef: execution.resultRef.contentRef, path })]
    }
    if (execution?.inputVersion === 32) {
      assert.match(JSON.stringify(request.messages), /UNKNOWN_EFFECT/)
      return [decision('complete', '32 inputs reviewed')]
    }
    return [call('task_delegate', { key: 'continue-' + (execution?.inputVersion ?? 0), objective: 'generation-' + ((execution?.inputVersion ?? 0) + 1),
      ...(execution ? { executionId: execution.executionId } : {}), context: scope }), decision('wait', 'wait for result')]
  })
  await h.service.ingest({ ...message, text: '测试助手，仅分析并汇总32轮观察。' + scope }); await h.service.whenIdle()
  const [task] = await h.query('task.list'), executions = await h.query('execution.list')
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(executions.length, 1); assert.equal(executions[0].inputVersion, 32)
  assert.ok(metrics.length >= 33)
  t.diagnostic(JSON.stringify({ scope: 'native owner scripted adapter, UTF-8 JSON bytes; no provider tokens', metrics: metrics.filter(m => [0, 1, 5, 32].includes(m.inputVersion)) }))
  assert.ok(metrics.every(m => m.currentInputBytes < 60000), 'current owner input must stay within fixture budget')
  assert.ok(metrics.at(-1).currentInputBytes < metrics[0].currentInputBytes + 6000, 'input growth excludes recursive execution history')
  assert.ok(metrics.every(m => m.retainedBaselineBytes === 0), '没有被转移为基线的旧Host正文')
  assert.ok(metrics.at(-1).hostMessagesBytes - metrics.at(-1).currentInputBytes < 1500, 'Host包装开销不随续办轮数增长')
})

test('configured group responsibility reaches group and task models and its reply signature survives notification formatting', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-group-reply-scope-')
  const responsibility = 'GROUP_REPLY_SCOPE_PROOF：日常回复末尾空一行附 - 测试群助理代回。'
  let groupRequests = 0, taskRequests = 0
  const h = await fixture.host(async request => {
    const calls = topicTaskCalls(request)
    if (calls) {
      groupRequests++
      assert.ok(requestSystemText(request).includes(responsibility))
      if (calls[0].args.decision) calls[0].args.decision.reply += '\n\n- 测试群助理代回'
      return calls
    }
    taskRequests++
    assert.ok(requestSystemText(request).includes(responsibility), '任务统筹继承所属群已配置的边界与红线')
    return [decision('complete', '已完成当前目标。')]
  })
  await h.residentStore.updateGroup({ groupId: 'native-group', responsibility })
  await h.service.ingest(message); await h.service.whenIdle()
  assert.ok(groupRequests >= 2); assert.equal(taskRequests, 1, JSON.stringify(h.service.listAlerts()))
  assert.ok(h.sent.find(notification => notification.kind === 'topic-reply').payload.text.endsWith('\n\n- 测试群助理代回'))
})

test('native service routes authenticated source, delegates parallel execution, persists wake before owner wait, and sends confirmation and completion with readback', { timeout: 30000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-native-'), { root } = fixture
  const steps = new Map(), executionStarted = new Set(), started = Promise.withResolvers()
  const wrappedFilesystems = new Set(), readOverlap = { active: 0, peak: 0, started: 0 }
  let ownerRounds = 0, sawResultsBeforeWait = false, lateNativeCalls = 0
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) {
      const key = 'owner:' + input.task.leaseEpoch, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      assert.ok(names.includes(nativeShell) && names.includes('write') && names.includes('read'), '任务会话继承原生工具')
      if (!input.executions.length) {
        if (step === 0) {
          ownerRounds++
          const owner = host.ctx.agents.get(input.task.sessionId)
          owner.ctx.tools.register({ name: 'late_native_write', description: 'Native tool registered after session setup', parameters: { type: 'object' },
            output: { schema: { type: 'object' }, render: () => [] }, execute() { lateNativeCalls++; return {} } })
          return [call('write', { file_path: 'owner-native-proof.txt', content: 'owner native proof' }), call('late_native_write', {})]
        }
        if (step === 1) return [call('read', { file_path: 'owner-native-proof.txt' }), call(nativeShell, { command: nativeShell === 'pwsh' ? "Get-Content -LiteralPath 'owner-native-proof.txt'" : 'cat owner-native-proof.txt', description: 'Read the task session native proof through its configured shell' })]
        if (step === 2) return ['alpha', 'beta'].map(key => call('task_delegate', { key, objective: key }))
        const executions = await waitUntil(async () => { const executions = await host.query('execution.list'); return executions.length === 2 && executions.every(e => e.drained && e.status === 'succeeded') ? executions : null }, 'both native executors persisted before owner wait')
        assert.equal(executions.length, 2); sawResultsBeforeWait = true
        return [decision('wait', '等待已落账结果唤醒')]
      }
      ownerRounds++
      assert.equal(input.executions.length, 2)
      assert.ok(input.executions.every(e => e.drained && e.status === 'succeeded'))
      assert.ok(input.wakes.some(wake => wake.kind.startsWith('execution.')))
      return [decision('complete', 'alpha 和 beta 已分别生成并实际验证。')]
    }
    assert.ok(names.includes('execution_submit'))
    const key = input.objective, step = steps.get(key) ?? 0
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
          if (!this.processPath(args[0]).endsWith('-native-proof.txt')) return readText.apply(this, args)
          readOverlap.started++; readOverlap.active++; readOverlap.peak = Math.max(readOverlap.peak, readOverlap.active)
          try {
            await waitUntil(() => readOverlap.started === 2, 'both real filesystem reads entered together', 3000)
            return await readText.apply(this, args)
          } finally { readOverlap.active-- }
        }
        t.after(() => { fs.readText = readText })
      }
      executionStarted.add(key)
      if (executionStarted.size === 2) started.resolve()
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
  const first = await h.service.ingest(message)
  assert.equal(first.accepted, true)
  await h.service.whenIdle()
  assert.deepEqual((await h.service.recover()).failures, [])
  const tasks = await h.query('task.list')
  assert.equal(tasks.length, 1)
  const task = tasks[0], executions = await h.query('execution.list', { taskId: task.taskId })
  const executionViews = await h.service.taskExecutions(task.taskId)
  assert.ok(executionViews.executions.every(execution => execution.workspaceDir === join(root, 'tasks', task.taskId)
    && execution.workingDirectory === join(root, 'tasks', task.taskId)))
  assert.equal(task.status, 'completed')
  assert.equal(task.topicRefs.length, 1)
  assert.equal(h.residentStore.getTopic(message.groupId, task.topicRefs[0].topicId).processedRevision, task.topicRefs[0].revision)
  assert.equal(ownerRounds, 2)
  assert.equal(sawResultsBeforeWait, true)
  assert.equal(lateNativeCalls, 1)
  assert.equal(readOverlap.peak, 2, 'Native concurrency-safe filesystem calls must overlap')
  assert.equal(h.sent.length, 2); assert.equal(h.readbacks.length, 2)
  const echo = await h.service.ingest({ ...message, messageId: 'native-notification-2', senderOpenDingTalkId: 'notification-sender', text: 'completion echo' })
  assert.equal(echo.reason, 'own-notification')
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 1, 'durable send receipt must exclude our own group echo')
  assert.equal((await h.query('notification.list'))[0].state, 'delivered')
  assert.equal((await h.query('source.get', { sourceId: first.sourceId })).actorId, message.senderOpenDingTalkId)
  assert.equal((await h.query('source.get', { sourceId: first.sourceId })).routed, true)
  const ownerLog = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  assert.equal(ownerLog.meta.cwd, join(root, 'tasks', task.taskId))
  assert.ok(!ownerLog.events.some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access'))
  const ownerWorkspace = h.ctx.workspaceRegistry.list().find(workspace => workspace.path === ownerLog.meta.cwd)
  assert.ok(ownerWorkspace)
  assert.ok(ownerWorkspace.sessionIds.includes(task.sessionId))
  assert.equal(ownerWorkspace.title, task.title)
  assert.equal(ownerLog.events.findLast(event => event.type === 'session/title')?.data.title, task.title)
  assert.equal(ownerLog.events.filter(e => e.type === 'plugin:dingtalk/task-session').length, 1)
  assert.equal(ownerLog.events.filter(e => e.type === 'user/message' && e.data.source?.taskSession && !e.data.source.taskContextHistory).length, 2)
  assert.ok(h.toolResults.some(result => result.name === 'late_native_write' && !result.result.isError))
  for (const execution of executions) {
    const log = await inspectSession(h.ctx.sessionPersistence, execution.sessionId), cwd = join(root, 'tasks', task.taskId)
    assert.ok(log.events.some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access'))
    assert.equal(log.meta.cwd, ownerLog.meta.cwd)
    assert.ok(!log.events.some(event => event.type === 'working-directory/change'), 'Executor cwd starts at the same immutable task root')
    assert.equal(log.events.findLast(event => event.type === 'session/title')?.data.title, execution.input.title)
    const executionWorkspace = h.ctx.workspaceRegistry.list().find(workspace => workspace.path === ownerLog.meta.cwd)
    assert.ok(executionWorkspace)
    assert.ok(executionWorkspace.sessionIds.includes(execution.sessionId))
    assert.equal(executionWorkspace.id, ownerWorkspace.id)
    assert.equal(h.ctx.workspaceRegistry.list().filter(workspace => workspace.path.startsWith(join(root, 'tasks', task.taskId))).length, 1)
    assert.equal(await readFile(join(cwd, execution.input.objective + '-native-proof.txt'), 'utf8'), execution.input.objective + '\n')
    assert.equal((await readFile(join(cwd, execution.input.objective + '-process-cwd.txt'), 'utf8')).trim(), cwd)
    assert.ok(log.events.some(e => e.type === 'tool/call' && e.data.name === nativeShell))
    assert.ok(log.events.some(e => e.type === 'tool/result'))
    assert.ok((await findSessionLog(root, execution.sessionId)).startsWith(taskSessionLogRoot(root, task.taskId)))
  }
  assert.ok((await findSessionLog(root, task.sessionId)).startsWith(taskSessionLogRoot(root, task.taskId)))
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).length, 4)
  assert.ok((await h.query('operation.list', { taskId: task.taskId })).every(operation => operation.state === 'succeeded'))
  await h.service.ingest(message); await h.service.whenIdle(); await h.service.recover(); await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 2)
  assert.equal(h.sent.length, 2)
  assert.ok((await readdir(join(root, 'tasks', task.taskId))).includes('alpha-native-proof.txt'))
  await h.close()
  const reopened = await fixture.host(() => { throw new Error('Completed native work must not be repeated after reopening SQLite') }, { initialize: false })
  await reopened.service.recover(); await reopened.service.whenIdle()
  assert.equal((await reopened.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.deepEqual((await reopened.query('execution.list')).map(e => e.sessionId).sort(), executions.map(e => e.sessionId).sort())
  assert.equal((await reopened.query('notification.list'))[0].state, 'delivered')
  assert.equal(reopened.sent.length, 0)
  assert.equal(reopened.requests.length, 0)
  for (const [sessionId, cwd] of [[task.sessionId, ownerLog.meta.cwd], ...executions.map(execution => [execution.sessionId, ownerLog.meta.cwd])]) {
    assert.equal((await inspectSession(reopened.ctx.sessionPersistence, sessionId)).meta.cwd, cwd)
    assert.ok(reopened.ctx.workspaceRegistry.list().find(workspace => workspace.path === cwd)?.sessionIds.includes(sessionId))
  }
})

test('native executor resumes in the same titled task workspace and all task sessions share the process cwd', { timeout: 20000 }, async t => {
  const fixture = await nativeCase(t, 'task-workspace-resume-')
  function model(continuing) {
    const steps = new Map()
    return async (request, host) => {
      const input = latestInput(request), names = request.tools.map(tool => tool.name)
      if (names.includes('task_delegate')) {
        const step = steps.get('owner:' + input.task.leaseEpoch) ?? 0
        steps.set('owner:' + input.task.leaseEpoch, step + 1)
        if (!input.executions.length && step === 0) return [call('task_delegate', { key: '初次核对', objective: 'first' })]
        if (continuing && input.executions[0]?.input.objective === 'first' && step === 0)
          return [call('task_delegate', { key: '继续核对', objective: 'second', executionId: input.executions[0].executionId })]
        if (input.executions[0]?.input.objective === 'second' && input.executions[0].status === 'succeeded') return [decision('complete', '第二次核对已完成')]
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
  const created = await first.service.createTask({ groupId: 'native-group', requestId: 'workspace-resume', title: '恢复目录核对', objective: '核对执行会话恢复时的工作区' })
  await first.service.whenIdle()
  const [execution] = await first.query('execution.list'), taskRoot = join(fixture.root, 'tasks', created.taskId)
  const runtimeCwd = taskRoot
  await first.close()
  const next = await fixture.host(model(true), { initialize: false })
  await next.service.recover(); await next.service.whenIdle()
  await next.service.appendTaskContext({ taskId: created.taskId, requestId: 'resume-executor', context: '继续使用原执行会话完成第二次核对' })
  await next.service.whenIdle()
  assert.deepEqual((await next.service.recover()).failures, [])
  const [resumed] = await next.query('execution.list')
  assert.equal(resumed.sessionId, execution.sessionId)
  assert.equal(resumed.executionId, execution.executionId)
  assert.equal(resumed.input.objective, 'second')
  assert.equal(resumed.status, 'succeeded')
  assert.equal((await next.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal(await readFile(join(runtimeCwd, 'resume-cwd.txt'), 'utf8'), runtimeCwd)
  const workspace = next.ctx.workspaceRegistry.list().find(item => item.path === taskRoot)
  assert.equal(workspace.title, '恢复目录核对')
  assert.ok(workspace.sessionIds.includes(created.session.sessionId) && workspace.sessionIds.includes(resumed.sessionId))
  assert.equal(next.ctx.workspaceRegistry.list().filter(item => item.path.startsWith(taskRoot)).length, 1)
  const log = await inspectSession(next.ctx.sessionPersistence, resumed.sessionId)
  assert.equal(log.meta.cwd, taskRoot)
  assert.ok(!log.events.some(event => event.type === 'working-directory/change'))
  assert.equal(log.events.findLast(event => event.type === 'session/title').data.title, execution.title, '同一执行保留稳定名称，续办key不改名')
})

test('native service reopens an unknown notification for readback without resending completed business work', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-notification-')
  let sends = 0, canRead = false, readbacks = 0
  const notifications = {
    async send(notification) { sends++; return { messageId: notification.kind === 'completion' ? 'durable-delivery-id' : 'durable-confirmation-id' } },
    async readback(notification) {
      readbacks++
      const id = notification.kind === 'completion' ? 'durable-delivery-id' : 'durable-confirmation-id'
      assert.equal(notification.ack.messageId, id)
      return notification.kind !== 'completion' || canRead ? { messageId: id, verified: true } : null
    },
  }
  const first = await fixture.host(async request => {
    return topicTaskCalls(request) ?? [decision('complete', '可用的已有证据已核验。')]
  }, { notifications })
  try {
    await first.service.ingest({ ...message, messageId: 'notification-request', text: '测试助手，核对已有记录并给出结论。' })
    await first.service.whenIdle()
    assert.equal((await first.query('task.list'))[0].status, 'completed')
    assert.equal((await first.query('notification.list')).find(notification => notification.kind === 'completion').state, 'unknown')
    assert.equal(sends, 2)
  } finally { await first.close() }
  const readsBeforeRecovery = readbacks
  canRead = true
  const second = await fixture.host(() => { throw new Error('Completed task must not invoke the model during receipt recovery') }, { notifications, initialize: false })
  await second.service.recover(); await second.service.whenIdle()
  assert.equal(readbacks, readsBeforeRecovery, 'Restart must preserve the persisted observation cooldown')
  const retryAt = Math.max(...(await second.query('notification.list')).filter(notification => notification.state === 'unknown').map(notification => Date.parse(notification.nextAttemptAt)))
  await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 20))
  await second.service.recover(); await second.service.whenIdle()
  assert.ok((await second.query('notification.list')).every(notification => notification.state === 'delivered'))
  assert.equal((await second.query('task.list')).length, 1)
  assert.equal(sends, 2); assert.equal(readbacks, readsBeforeRecovery + 1)
  assert.equal(second.requests.length, 0)
})

test('native service cancellation stops the real execution process, drains the session, and rejects late completion', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-cancel-'), { root } = fixture
  let ownerStep = 0
  const h = await fixture.host(async request => {
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
  await h.service.ingest({ ...message, messageId: 'cancel-request' })
  const execution = await waitUntil(async () => {
    const [execution] = await h.query('execution.list')
    if (!execution) return null
    const marker = join(root, 'tasks', execution.taskId, 'process-started.txt')
    return await readFile(marker, 'utf8').then(() => execution, error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 'real shell process started')
  const oldBinding = await h.query('execution.binding', { executionId: execution.executionId })
  const result = await h.service.cancelTask({ taskId: execution.taskId, requestId: 'cancel-once', reason: '停止本次执行' })
  await h.service.whenIdle()
  assert.equal(result.control, 'cancelled')
  const task = await h.query('task.get', { taskId: execution.taskId }), stored = await h.query('execution.get', { executionId: execution.executionId })
  assert.equal(task.control, 'cancelled'); assert.equal(task.drained, true)
  assert.equal(stored.drained, true); assert.notEqual(stored.status, 'succeeded')
  assert.equal(h.ctx.agents.get(execution.sessionId), undefined)
  assert.equal(h.ctx.sessions.get(execution.sessionId), undefined)
  await assert.rejects(readFile(join(root, 'tasks', task.taskId, 'process-completed.txt')), { code: 'ENOENT' })
  assert.equal(h.sent.length, 1)
  assert.equal((await h.query('notification.list')).length, 1)
  const operations = await h.query('operation.list', { taskId: task.taskId })
  assert.equal(operations.length, 1)
  assert.ok(['unknown', 'cancelled'].includes(operations[0].state), 'Interrupted shell must not be asserted successful')
  const saved = await inspectSession(h.ctx.sessionPersistence, execution.sessionId)
  assert.ok(saved.events.some(event => event.type === 'tool/call' && event.data.name === nativeShell))
  assert.ok(saved.events.some(event => event.type === 'turn/end'))
  await assert.rejects(h.service.store.command({ id: 'late-completion-after-cancel', kind: 'execution.result', args: {
    binding: oldBinding, output: { status: 'completed', summary: 'stale late success', evidence: [], limitations: [], artifacts: [] },
  } }), { code: 'DYNAMIC_EXECUTION_RESULT_CONFLICT' })
  const webSources = (await h.query('source.list')).filter(source => source.channel === 'web')
  assert.equal(webSources.length, 1)
  assert.equal(webSources[0].routed, true, 'Direct web cancellation must not be rerouted as a new group message on restart')
  const requests = h.requests.length
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, requests)
  assert.equal((await h.query('task.list')).length, 1)
})

test('native requirement update resumes the same owner with new sources and fences the interrupted old execution result', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-revise-'), { root } = fixture
  let ownerStep = 0
  const revisedInputs = []
  const h = await fixture.host(async request => {
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
  await h.service.ingest({ ...message, messageId: 'revision-original' })
  const oldExecution = await waitUntil(async () => {
    const [execution] = await h.query('execution.list')
    if (!execution) return null
    const marker = join(root, 'tasks', execution.taskId, 'revision-process-started.txt')
    return await readFile(marker).then(() => execution, error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 'old real execution started')
  const oldTask = await h.query('task.get', { taskId: oldExecution.taskId })
  await h.service.appendTaskContext({ taskId: oldTask.taskId, requestId: 'revise-once', expectedRequirementRevision: 1, expectedControlRevision: 1,
    context: '最新要求：暂停生成文件，先核对旧操作结果，不要将旧结果当作新要求完成。' })
  await h.service.whenIdle()
  const task = await h.query('task.get', { taskId: oldTask.taskId }), execution = await h.query('execution.get', { executionId: oldExecution.executionId })
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
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal((await h.query('notification.list')).length, 1)
  assert.equal(h.sent.length, 1)
  const saved = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  assert.equal(saved.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.ok(saved.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).length >= 2)
  assert.equal((await h.query('source.list')).find(source => source.channel === 'web').routed, true)
  const requests = h.requests.length
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.requests.length, requests)
  assert.equal((await h.query('task.list')).length, 1)
})

for (const [maxConcurrentTasks, maxConcurrentExecutions] of [[1, 1], [1, 2], [2, 1], [2, 3]]) test(`native capacity queues promote every task and execution: tasks=${maxConcurrentTasks}, executions=${maxConcurrentExecutions}`, { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-capacity-'), gate = Promise.withResolvers(), steps = new Map()
  let entered = 0
  const h = await fixture.host(async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('task_delegate')) {
      const key = input.task.taskId + ':' + input.task.leaseEpoch, step = steps.get(key) ?? 0
      steps.set(key, step + 1)
      if (!input.executions.length && step === 0) return ['one', 'two'].map(key => call('task_delegate', { key, objective: key }))
      return [decision(input.executions.length === 2 && input.executions.every(e => e.status === 'succeeded' && e.drained) ? 'complete' : 'wait', '容量测试负责人决定')]
    }
    const key = input.task.taskId + ':' + input.objective, step = steps.get(key) ?? 0
    steps.set(key, step + 1)
    if (step === 0) { entered++; await gate.promise; return [call('write', { file_path: input.objective + '-capacity-proof.txt', content: key })] }
    return [call('execution_submit', { output: { status: 'completed', summary: key, evidence: ['actual filesystem write'], limitations: [], artifacts: [input.objective + '-capacity-proof.txt'] } })]
  }, { config: { maxConcurrentTasks, maxConcurrentExecutions } })
  try {
    await h.service.createTask({ groupId: 'native-group', requestId: 'capacity-a', objective: 'first task' })
    await h.service.createTask({ groupId: 'native-group', requestId: 'capacity-b', objective: 'second task' })
    const admitted = Math.min(maxConcurrentTasks * 2, maxConcurrentExecutions)
    await waitUntil(() => entered === admitted, 'available native executor slots admitted')
    await waitUntil(async () => (await h.query('execution.list')).length === maxConcurrentTasks * 2, 'admitted owners persisted both delegations')
    assert.equal((await h.query('task.list')).filter(task => task.sessionBound).length, maxConcurrentTasks)
    assert.equal((await h.query('execution.list')).filter(execution => execution.status === 'running').length, admitted)
  } finally { gate.resolve() }
  await h.service.whenIdle()
  assert.equal(entered, 4, 'All four real execution sessions must run without a periodic recovery tick')
  assert.ok((await h.query('task.list')).every(task => task.status === 'completed'))
  for (const execution of await h.query('execution.list')) {
    assert.equal(execution.status, 'succeeded'); assert.equal(execution.drained, true)
    assert.equal(await readFile(join(fixture.root, 'tasks', execution.taskId, execution.input.objective + '-capacity-proof.txt'), 'utf8'), execution.taskId + ':' + execution.input.objective)
  }
})

test('recovering an idle owner with no pending wake does not consume a task slot', { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-idle-slot-')
  let rounds = 0
  const h = await fixture.host(async () => { rounds++; return [decision('wait', '没有具体执行待办')] }, { config: { maxConcurrentTasks: 1 } })
  await h.service.createTask({ groupId: 'native-group', requestId: 'idle-a', objective: 'wait for input' })
  await h.service.whenIdle()
  await h.service.recover(); await h.service.whenIdle()
  await h.service.createTask({ groupId: 'native-group', requestId: 'idle-b', objective: 'another independent wait' })
  await h.service.whenIdle()
  assert.equal(rounds, 2)
  assert.ok((await h.query('task.list')).every(task => task.sessionBound && task.drained))
})

for (const persistent of [false, true]) test(`native session creation failure has bounded recovery retries: persistent=${persistent}`, { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-retry-')
  const h = await fixture.host(async () => [decision('complete', 'native session recovered')], { config: { retryIntervalMs: 2000 } })
  const registry = h.ctx.agents, create = registry.create
  let attempts = 0
  h.ctx.agents.create = async function (options) {
    if (options.meta?.cwd && basename(options.meta.cwd).startsWith('task-') && (++attempts === 1 || persistent))
      throw Object.assign(new Error('NATIVE_SETUP_INJECTED_FAILURE'), { code: 'NATIVE_SETUP_INJECTED_FAILURE' })
    return create.call(this, options)
  }
  t.after(() => { registry.create = create })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'setup-failure', objective: 'test native setup failure' })
  await h.service.whenIdle()
  assert.equal(attempts, 1)
  const failure = (await h.service.recover()).failures.find(value => value.id === task.taskId)
  assert.ok(failure.retryAfter - Date.parse(failure.at) >= 2000, 'Persisted failure must retain the full configured retry delay')
  for (let i = 0; i < 3; i++) { await h.service.recover(); await h.service.whenIdle() }
  assert.equal(attempts, 1, 'Explicit recovery cannot busy-loop inside the retry window')
  await new Promise(resolve => setTimeout(resolve, Math.max(0, failure.retryAfter - Date.now()) + 10))
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(attempts, 2)
  const stored = await h.query('task.get', { taskId: task.taskId })
  assert.equal(stored.drained, true)
  assert.equal(stored.status, persistent ? 'active' : 'completed')
  if (!persistent) assert.equal((await h.service.recover()).failures.some(value => value.id === task.taskId), false)
})

for (const persistent of [false, true]) test(`native model failures settle without repeated owner requests: persistent=${persistent}`, { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-model-failure-')
  let requests = 0
  const h = await fixture.host(async () => {
    if (++requests === 1 || persistent) throw new Error('CONTROLLED_MODEL_FAILURE')
    return [decision('complete', 'new source recovered the existing native owner')]
  })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'model-failure', objective: 'test native model failure' })
  await h.service.whenIdle()
  for (let i = 0; i < 3; i++) { await h.service.recover(); await h.service.whenIdle() }
  assert.equal(requests, 1)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).lastDecision.action, 'blocked')
  await h.service.appendTaskContext({ taskId: task.taskId, requestId: 'model-retry-source', context: 'Try this same task again with the new information.' })
  await h.service.whenIdle()
  assert.equal(requests, 2)
  const stored = await h.query('task.get', { taskId: task.taskId })
  assert.equal(stored.drained, true)
  assert.equal(stored.status, persistent ? 'active' : 'completed')
  assert.equal(stored.sessionId, task.session.sessionId)
})

for (const correctOnce of [false, true]) test(`native owner empty-summary corrections are bounded and may recover: correctOnce=${correctOnce}`, { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-invalid-summary-')
  let requests = 0
  const h = await fixture.host(async () => {
    assert.ok(++requests <= 4, 'Invalid owner decisions must stop before a fifth model request')
    return [decision('complete', correctOnce && requests > 1 ? '纠正为空的summary后完成' : '  ')]
  })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'empty-summary', objective: 'test owner decision correction' })
  await h.service.whenIdle()
  const stored = await h.query('task.get', { taskId: task.taskId })
  assert.equal(requests, correctOnce ? 2 : 3)
  assert.equal(stored.drained, true)
  assert.equal(stored.status, correctOnce ? 'completed' : 'active')
  const results = h.toolResults.filter(result => result.name === 'task_session_submit')
  assert.equal(results.filter(result => result.result.isError).length, correctOnce ? 1 : 3)
  assert.match(JSON.stringify(results[0].result), /TASK_SESSION_DECISION_INVALID/)
  if (!correctOnce) {
    assert.equal(stored.lastDecision.action, 'blocked')
    assert.match(stored.lastDecision.limitations.join(' '), /TASK_SESSION_DECISION_INVALID/)
    assert.equal(h.ctx.agents.get(stored.sessionId), undefined)
  }
  const saved = await inspectSession(h.ctx.sessionPersistence, stored.sessionId)
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_session_submit').length, requests)
  await h.service.whenIdle()
  assert.equal(requests, correctOnce ? 2 : 3)
})

test('native topic routing rejects incomplete source coverage and accepts correction in the same real session', { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-invalid-route-')
  let requests = 0
  const h = await fixture.host(async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) {
      requests++
      assert.ok(requests <= 2, 'Routing correction must finish on its second model call')
      if (requests === 1) {
        const input = latestInput(request)
        return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, units: [], ignoredRefs: [] })) })]
      }
    }
    return topicTaskCalls(request) ?? [decision('complete', '话题决定合法纠正后完成任务')]
  })
  const ingested = await h.service.ingest({ ...message, messageId: 'invalid-source-coverage' })
  await h.service.whenIdle()
  assert.equal(requests, 2)
  assert.equal((await h.query('source.get', { sourceId: ingested.sourceId })).routed, true)
  const tasks = await h.query('task.list')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'completed')
  const group = h.residentStore.getGroup(message.groupId)
  assert.equal(group.messages[0].routingStatus, 'routed')
  assert.equal(group.topics.length, 1)
  assert.equal(group.topics[0].processedRevision, group.topics[0].revision)
  const results = h.toolResults.filter(result => result.name === 'group_topic_route_submit')
  assert.equal(results[0].result.value.status, 'invalid-arguments')
  assert.equal(results[0].result.value.issues[0].path, 'routes.0.ignoredRefs')
  assert.match(results[0].result.value.issues[0].message, /完整原文忽略记录/)
  assert.equal(results[1].result.value.status, 'accepted')
  const saved = await inspectSession(h.ctx.sessionPersistence, results[0].sessionId)
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'group_topic_route_submit').length, 2)
  await h.service.whenIdle()
  assert.equal(requests, 2)
})

test('resident.apply boots and disposes with only its declared native service dependencies', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-resident-native-')
  const h = await fixture.host(() => { throw new Error('Startup must not invoke the model') }, { resident: true })
  for (const name of resident.inject) assert.ok(h.ctx.get(name), 'Declared dependency available: ' + name)
  for (const name of ['subagents', 'goal', 'workflow', 'execution']) assert.equal(h.ctx.get(name), undefined, 'Retired dependency must not be required: ' + name)
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  const fiber = await h.ctx.plugin(resident, { host: '127.0.0.1', port, agentWorkspaceDir: fixture.root, agentPreset: 'native-test', proxyUrl: '',
    groups: [{ groupId: 'native-group', name: 'native group', responsibility: 'native startup test' }], dws: { enabled: false },
    taskSessions: { dbPath: join(fixture.root, 'resident.db'), instanceId: 'resident-native', ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', initialize: true, recoveryIntervalMs: 60000 } })
  const read = path => new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}${path}`, { agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) } })
  }).on('error', reject))
  assert.deepEqual((await read('/health')).body.status, 'ok')
  const groups = await read('/state/groups')
  assert.equal(groups.status, 200)
  assert.equal(groups.body[0].groupId, 'native-group')
  assert.equal((await read('/state/agent-config')).body.workspaceDir, fixture.root)
  assert.equal(h.requests.length, 0)
  await fiber.dispose()
  await assert.rejects(read('/health'), { code: 'ECONNREFUSED' })
})

test('resident listener startup failure disposes native resources and permits reopening the same task database', { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-resident-start-failure-')
  const occupied = createServer()
  t.after(() => occupied.listening ? new Promise(resolve => occupied.close(resolve)) : undefined)
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const port = occupied.address().port
  const config = { host: '127.0.0.1', port, agentWorkspaceDir: fixture.root, agentPreset: 'native-test', proxyUrl: '', dws: { enabled: false },
    taskSessions: { dbPath: join(fixture.root, 'startup.db'), instanceId: 'startup-failure', ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', initialize: true } }
  const failed = await fixture.host(() => { throw new Error('MODEL_NOT_EXPECTED') }, { resident: true })
  await assert.rejects(resident.apply(failed.ctx, config), { code: 'EADDRINUSE' })
  await failed.close()
  await new Promise(resolve => occupied.close(resolve))
  const next = await fixture.host(() => { throw new Error('MODEL_NOT_EXPECTED') }, { resident: true })
  await resident.apply(next.ctx, { ...config, taskSessions: { ...config.taskSessions, initialize: false } })
  const health = await new Promise((resolve, reject) => httpGet(`http://127.0.0.1:${port}/health`, { agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
  }).on('error', reject))
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')
  assert.equal(next.requests.length, 0)
})


test('native board keeps a drained coordinator running while its delegated target is executing', { timeout: 20000 }, async t => {
  const fixture = await nativeCase(t, 'task-board-active-execution-'), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let delegated = false
  const h = await fixture.host(async request => {
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'board-target', objective: '核对执行中的任务状态' })] }
      return [decision(input.executions.some(execution => execution.status === 'succeeded') ? 'complete' : 'wait', '等待小目标执行结果')]
    }
    await release.promise
    return [call('execution_submit', { output: { status: 'completed', summary: '已核对', evidence: [], limitations: [], artifacts: [] } })]
  })
  try {
    await h.service.ingest(message)
    const task = await waitUntil(async () => {
      const [task] = await h.query('task.list'), executions = await h.query('execution.list')
      return task?.drained && task.lastDecision?.action === 'wait' && executions.some(execution => execution.status === 'running' && !execution.drained) ? task : null
    }, 'coordinator waits while native execution remains running')
    const view = (await h.service.boardTasks()).find(item => item.taskId === task.taskId)
    assert.equal(view.state, 'running')
    assert.equal(view.waitingReason, '')
    assert.equal((await h.service.taskDetail(task.taskId)).state, 'running')
  } finally { release.resolve(); await h.service.whenIdle() }
})


test('native recovery no-op preserves an undrained task writer conflict alert', { timeout: 10000 }, async t => {
  const fixture = await nativeCase(t, 'task-live-conflict-alert-')
  const h = await fixture.host(async () => [decision('complete', '不应执行')], { config: { retryIntervalMs: 100 } })
  const registry = h.ctx.agents, create = registry.create
  h.ctx.agents.create = async function (options) {
    if (options.meta?.cwd && basename(options.meta.cwd).startsWith('task-')) throw Object.assign(new Error('TASK_SESSION_ALREADY_LIVE'), { code: 'TASK_SESSION_ALREADY_LIVE', taskSessionDrained: false })
    return create.call(this, options)
  }
  t.after(() => { registry.create = create })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'live-conflict', objective: '保留原写者冲突诊断' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).drained, false)
  const original = (await h.service.recover()).failures.find(item => item.id === task.taskId)
  assert.equal(original.code, 'TASK_SESSION_ALREADY_LIVE')
  await new Promise(resolve => setTimeout(resolve, 150))
  const recovered = await h.service.recover()
  assert.equal(recovered.failures.find(item => item.id === task.taskId)?.code, original.code)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).drained, false)
})
