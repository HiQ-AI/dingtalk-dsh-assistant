import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

testRunner('原生网页工具错误不建立未知效果，仍可完成后续读取', { skip: !available ? reason : false, timeout: 20000 }, async t => {
 const root=await mkdtemp(join(tmpdir(),'native-web-read-'))
 let host, delegated=false, calls=0
 const team=nativeVerificationTeam()
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
 host=await nativeTaskHost(root, async(request,h)=>{
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

test('running reminder and coordinator clarification preserve one native shell job with received and consumed receipts', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-running-feedback-'))
  const team = nativeVerificationTeam({ filePath: 'effect.txt', expected: 'once' })
  let h, delegated = false, clarified = false, executions = 0
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, async request => {
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
  })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'original', objective: '创建并保留原作业' })
  try { await waitUntil(async () => { try { await readFile(join(root, 'started')); return true } catch { return false } }) }
  catch (error) { throw new Error(JSON.stringify({ alerts: h.service.listAlerts(), executions: await h.query('execution.list'), results: h.toolResults }), { cause: error }) }
  const before = (await h.query('execution.list'))[0]
  await h.service.appendTaskContext({ taskId: task.taskId, requestId: 'reminder', context: '开发分支别搞错了', progressImpact: 'preserve', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  assert.equal((await h.query('task.get', { taskId: task.taskId })).requirementRevision, 1, '普通提醒不能变成需求修订并取消原作业')
  assert.equal((await h.query('execution.list'))[0].cancelRequested, false, '原作业不能被普通提醒取消')
  await waitUntil(async () => (await h.query('execution.list'))[0].feedback?.length === 2)
  const received = (await h.query('execution.list'))[0]
  assert.ok(received.feedback.every(item => item.receivedAt && !item.consumedAt))
  assert.equal(received.cancelRequested, before.cancelRequested)
  await writeFile(join(root, 'release'), 'release')
  await h.service.whenIdle()
  const after = (await h.query('execution.list'))[0]
  for (const key of ['executionId', 'sessionId', 'inputVersion', 'leaseEpoch']) assert.equal(after[key], before[key])
  assert.equal((await h.query('execution.list')).length, 3)
  assert.equal((await h.query('execution.list')).filter(item => item.key === 'original').length, 1)
  assert.ok(after.feedback.every(item => item.consumedAt && Number.isInteger(item.sequence)))
  assert.ok(after.feedback.every(item => item.modelStepEnteredAt === item.consumedAt && item.consumptionMeaning === 'native-model-step-admission'))
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify({
    alerts: h.service.listAlerts(), recovery: (await h.query('task.get', { taskId: task.taskId })).providerRecovery,
    executions: (await h.query('execution.list')).map(item => ({ key: item.key, status: item.status, error: item.result?.payload.error })),
  }))
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
  const events = (await inspectSession(h.ctx.sessionPersistence, after.sessionId)).events
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.executionFeedback).length, 2)
})

// The real Windows shell and three independent verification sessions exceed the old 15s budget.
test('native completion race drains then resumes the original execution without replaying its shell effect', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-feedback-completion-'))
  const team = nativeVerificationTeam({ filePath: 'effect.txt', expected: 'once' })
  let h, delegated = false, steps = 0, injected = false
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, async request => {
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
  })
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
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'completion-race', objective: '写入一次并核对输入' })
  await h.service.whenIdle()
  const [execution] = await h.query('execution.list')
  assert.equal(injected, true); assert.equal(execution.leaseEpoch, 2); assert.equal(execution.inputVersion, 1)
  assert.equal(execution.result.payload.error, null, JSON.stringify({ error: execution.result.payload.error, alerts: h.service.listAlerts() }))
  assert.equal(execution.result.payload.output.summary, '已核对新补充')
  assert.ok(execution.feedback[0].consumedAt)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await readFile(join(root, 'tasks', task.taskId, 'effect.txt'), 'utf8')).trim(), 'once')
  assert.equal((await h.query('operation.list')).filter(item => item.state === 'succeeded').length, 1)
})

// The scripted coordinator obeys the same required-read contract as a real model.
for (const mode of ['missing', 'preserve', 'replan', 'cancel']) test(`real coordinator input enforces explicit context semantics without default cancellation: ${mode}`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-input-semantics-'))
  let h, task, delegated = false, executionSteps = 0
  const reviews = new Set()
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      for (const route of calls[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId: task.topicRefs[0].topicId }]
      return calls
    }
    if (names.includes('group_decision_submit')) {
      const input = latestInput(request)
      const schema = request.tools.find(tool => tool.name === 'group_decision_submit').parameters
      assert.match(JSON.stringify(schema), /progressImpact/)
      if (!reviews.has(input.requestId)) { reviews.add(input.requestId); return [call('group_reply_review_get', { requestIds: [input.requestId] })] }
      const review = h.toolResults.findLast(item => item.name === 'group_reply_review_get')
      const ids = JSON.parse(review.result.content[0].text).candidates.map(item => item.outboundId)
      const action = { kind: mode === 'cancel' ? 'task-cancel' : 'task-context', taskId: task.taskId,
        inputVersion: task.requirementRevision, runSequence: task.runSequence, topicRefs: [{ topicId: input.topicId, revision: input.revision }],
        ...(mode === 'cancel' ? { reason: '用户明确取消' } : { context: input.messages.at(-1).text }) }
      if (mode !== 'cancel' && mode !== 'missing') action.progressImpact = mode === 'replan' ? 'replan' : 'preserve'
      if (mode === 'replan') action.objective = '新的明确目标'
      return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
        decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [action], reply: '已核对本次输入语义', replyToMessageId: input.messages.at(-1).messageId,
          replyReview: { kind: 'substantive', reviewedOutboundIds: ids, sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
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
  })
  task = await h.service.createTask({ groupId: 'native-group', requestId: 'initial', objective: '原始明确任务' })
  await waitUntil(async () => { try { await readFile(join(root, 'started')); return true } catch { return false } }, 'original shell running')
  await h.service.ingest({ groupId: 'native-group', messageId: 'semantic-input', senderOpenDingTalkId: 'native-user',
    text: mode === 'cancel' ? '测试助手，明确取消原任务' : mode === 'replan' ? '测试助手，改为新的明确目标，停止旧目标' : '测试助手，开发分支别搞错了', timestamp: new Date().toISOString() })
  if (mode === 'missing') {
    const rejected = () => h.toolResults.some(item => item.name === 'group_decision_submit' && item.result.isError)
      || h.requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('progressImpact')))
    await waitUntil(async () => rejected() || (await h.query('task.get', { taskId: task.taskId })).requirementRevision !== 1, 'real tool schema rejects omitted classification')
    const current = await h.query('task.get', { taskId: task.taskId }), [execution] = await h.query('execution.list')
    assert.equal(current.requirementRevision, 1); assert.equal(execution.cancelRequested, false); assert.equal(execution.drained, false)
    assert.equal(execution.feedback?.length ?? 0, 0)
    assert.equal(rejected(), true, '缺失字段须明确拒绝，不能默认为preserve')
    await writeFile(join(root, 'release'), 'release')
    return
  }
  await waitUntil(async () => {
    const current = await h.query('task.get', { taskId: task.taskId }), [execution] = await h.query('execution.list')
    return mode === 'cancel' ? current.control === 'cancelled' : mode === 'replan' ? current.requirementRevision === 2 : execution.feedback?.length === 1
  }, 'coordinator semantic action applied')
  const current = await h.query('task.get', { taskId: task.taskId }), [execution] = await h.query('execution.list')
  if (mode === 'preserve' || mode === 'missing') {
    assert.equal(current.requirementRevision, 1); assert.equal(execution.cancelRequested, false); assert.equal(execution.drained, false)
    await writeFile(join(root, 'release'), 'release')
  } else assert.equal(execution.cancelRequested, true)
  await h.service.whenIdle()
})

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
    const required = requiredDecisionRead(request, latestInput(request))
    if (required) return [required]
    return [decision('complete', 'only analysis')]
  })
  await h.service.createTask({ groupId: 'native-group', requestId: 'indexed-web', objective: body, context: body })
  await h.service.whenIdle()
  assert.ok(counts.length > 0, JSON.stringify(h.service.listAlerts()))
  t.diagnostic(JSON.stringify({ scope: 'actual native owner scripted adapter UTF-8 JSON bytes', bodyCopies: counts, metrics }))
  assert.equal(counts[0], 0, 'long authority is explicitly marked for lossless read')
  assert.ok(counts.every(count => count === 0), 'targeted native reads do not reinject the entire long authority body')
  assert.ok(h.toolResults.some(result => result.name === 'read'), 'the existing native file reader is used')
  assert.equal(h.service.listAlerts().length, 0)
  const [source] = await h.query('source.list'), [task] = await h.query('task.list')
  assert.equal(source.text, body)
  assert.equal(source.requestIdentity.request.args.context, body, 'Web admission identity remains raw in the ledger')
  const dto = await h.service.taskDetail(task.taskId)
  assert.equal(dto.request, task.request)
  assert.deepEqual(dto.completion, task.completion, 'Observer still receives the original task completion')
  assert.equal(dto.executions.length, 0)
  assert.equal(task.status, 'completed', 'A direct analysis task does not need an execution member')
  assert.equal((await h.query('execution.list', { taskId: task.taskId })).length, 0)
  const saved = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
  const current = h.requests.at(-1).messages.find(message => message.source?.taskSession && !message.source.taskContextHistory)
  const raw = saved.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => message.id === current.source.rawHostMessageId)
  assert.ok(raw)
  assert.ok(raw.content[0].text.split(body).length - 1 > 1, 'raw admission audit is not deduplicated to shrink display')
  assert.equal(JSON.parse(raw.content[0].text).sources[0].requestIdentity.request.args.context, body)
})

test('不同群成员续办已完成任务，旧授权拒绝显式重试仍保留原任务和会话', { timeout: 20000 }, async t => {
  let h, backing, original, topicId, block = true
  t.after(async () => { await h?.close(); await backing?.close() })
  const fixture = await nativeCase(t, 'task-topic-auth-')
  backing = await openDynamicTaskStore({ dbPath: join(fixture.root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
  const store = { ...backing, command(input) {
    if (block && input.kind === 'task.reopen') throw new Error('TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED')
    return backing.command(input)
  } }
  const reviews = new Set()
  h = await fixture.host(async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (input.trigger === 'task-facts') return topicTaskCalls(request)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      if (topicId) for (const route of calls[0].args.routes) for (const unit of route.units)
        unit.topics = [{ topicId, relationship: 'continuation', reason: '部署原修复' }]
      return calls
    }
    if (names.includes('group_decision_submit') && topicId) {
      if (!reviews.has(input.requestId)) {
        reviews.add(input.requestId)
        return [call('group_reply_review_get', { requestIds: [input.requestId] })]
      }
      const review = h.toolResults.findLast(item => item.name === 'group_reply_review_get')
      const reviewedOutboundIds = JSON.parse(review.result.content[0].text).candidates.map(item => item.outboundId)
      const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      return [call('group_decision_submit', { requestId: input.requestId, topicId, revision: input.revision, decision: {
        basisMessageIds: input.messages.map(item => item.messageId), basisUnitRefs,
        actions: [{ kind: 'task-reopen', taskId: original.taskId, inputVersion: original.requirementRevision,
          runSequence: original.runSequence, context: '部署原修复到UAT2', objective: '部署原修复到UAT2',
          acceptanceCriteria: ['核验实际运行版本'], topicRefs: [{ topicId, revision: input.revision }], basisUnitRefs }],
        reply: '沿原任务部署UAT2。', replyReview: { kind: 'substantive', reviewedOutboundIds, sameMatterOutboundIds: [], replaceOutboundIds: [] },
      } })]
    }
    const calls = topicTaskCalls(request)
    if (calls) return calls
    if (original) {
      assert.equal(input.task.sessionId, original.sessionId)
      assert.ok(input.sources.some(source => source.actorId === 'colleague' && source.text === '测试助手，部署原修复到UAT2'))
    }
    return [decision('complete', original ? '已处理原任务续办' : '修复已完成，未部署')]
  }, { store })
  await h.service.ingest(message); await h.service.whenIdle()
  ;[original] = await h.query('task.list'); topicId = original.topicRefs[0].topicId
  const followup = { ...message, messageId: 'deploy-followup', senderOpenDingTalkId: 'colleague', text: '测试助手，部署原修复到UAT2', occurredAt: '2026-10-13T10:02:00Z' }
  await h.service.ingest(followup); await h.service.whenIdle()
  const blocked = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
  assert.equal(blocked.error, 'TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.operations.length, 1)
  assert.equal(blocked.operations[0].status, 'blocked')
  assert.equal(blocked.operations[0].lastError, 'TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED')
  assert.equal((await h.query('task.list'))[0].requirementRevision, 1)
  const sent = h.sent.length
  block = false
  await h.service.retryMessage({ groupId: message.groupId, messageId: followup.messageId }); await h.service.whenIdle()
  const [task] = await h.query('task.list')
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(task.taskId, original.taskId); assert.equal(task.sessionId, original.sessionId)
  assert.equal(task.ownerActorId, 'native-user'); assert.equal(task.runSequence, 2)
  assert.equal(task.requirementRevision, 2); assert.equal(task.status, 'completed')
  assert.ok(h.sent.length > sent)
  const recovered = h.residentStore.getTopic(message.groupId, topicId).decisions.at(-1)
  assert.equal(recovered.decisionId, blocked.decisionId)
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.attempt, 2)
  assert.equal(recovered.operations[0].operationId, blocked.operations[0].operationId)
  assert.equal(recovered.operations[0].status, 'applied')
  assert.equal(recovered.operations[0].recoveryResolution, 'not-applied')
  assert.equal(recovered.operations[0].lastError, 'TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED', '恢复不抹除原 Host 接纳失败证据')
  assert.equal(h.residentStore.getTopic(message.groupId, topicId).processedRevision, 2)
  await h.service.retryMessage({ groupId: message.groupId, messageId: followup.messageId }); await h.service.whenIdle()
  assert.equal((await h.query('task.list'))[0].runSequence, 2)
})

for (const [ownEcho, followupActor] of [[true, 'native-user'], [true, 'colleague'], [false, 'native-user']]) test(`话题历史${ownEcho ? '自身通知不阻断人工补充' : '未准入真实消息仍拒绝更新且不发送成功回复'}-${followupActor}`, { timeout: 15000 }, async t => {
  const fixture = await nativeCase(t, 'task-topic-source-')
  let topicId, originalTask, ownerCalls = 0
  const readReviews = new Set()
  let h
  const model = async request => {
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
    if (++ownerCalls === 1) return followupActor === 'colleague'
      ? [call('task_request_human', { audience: 'requester', reason: '需要核对开发来源', question: '是否批准分支例外？', evidence: [], attemptedActions: ['核对原始交办'] })]
      : [call('task_session_submit', { decision: { action: 'blocked', summary: '需要核对开发来源', question: '是否批准分支例外？', evidence: [], limitations: [] } })]
    assert.equal(input.task.sessionId, originalTask.sessionId)
    assert.ok(input.sources.some(source => source.text === '先核对分支，不是批准例外'))
    assert.ok(input.sources.every(source => source.messageId !== 'native-notification-1'))
    return [decision('complete', '已按补充要求核对分支')]
  }
  h = await fixture.host(model, { config: { assistantActorId: 'native-user' } })
  await h.service.ingest(message); await h.service.whenIdle()
  ;[originalTask] = await h.query('task.list')
  topicId = originalTask.topicRefs[0].topicId
  const echo = { ...message, messageId: ownEcho ? 'native-notification-1' : 'unadmitted-user-message',
    text: ownEcho ? h.sent[0].payload.text : '需要保留的真实历史指令', quotedMessage: { messageId: message.messageId, content: message.text }, occurredAt: '2026-10-13T10:01:00Z' }
  await h.residentStore.ingest(echo)
  await h.residentStore.routeMessages({ groupId: message.groupId, routeId: 'historical-echo-route', routingRevision: h.residentStore.getGroup(message.groupId).routingRevision, routes: [{ messageId: echo.messageId, messageVersion: 1,
    topics: [{ topicId, relationship: 'continuation', reason: '历史话题上下文' }] }] })
  const sentBefore = h.sent.filter(notification => notification.kind === 'topic-reply').length
  await h.service.ingest({ ...message, senderOpenDingTalkId: followupActor, messageId: 'manual-followup', text: '先核对分支，不是批准例外', occurredAt: '2026-10-13T10:02:00Z' })
  await h.service.whenIdle()
  const [task] = await h.query('task.list')
  assert.equal((await h.query('task.list')).length, 1)
  assert.ok(!(await h.query('source.list')).some(source => source.messageId === echo.messageId))
  if (ownEcho) {
    assert.equal(task.status, 'active', JSON.stringify(h.service.listAlerts()))
    assert.equal(task.humanRequests[0].status, 'waiting-reply', '普通定位补充既不改变授权，也不能代答或清除operator技术申请')
    assert.equal(task.requirementRevision, 1)
    assert.equal(ownerCalls, 1)
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
    // A legacy partial commit is observed only after a real service restart.
    // Retain the test's transport audit across both instances; expected counts stay unchanged.
    const sentHistory = h.sent.slice()
    await h.close(); readReviews.clear()
    h = await fixture.host(model, { initialize: false, config: { assistantActorId: 'native-user' } })
    h.sent.unshift(...sentHistory) // Preserve the diagnostic recorder across the two real instances.
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
    assert.equal((await h.query('task.list'))[0].status, 'active', JSON.stringify(h.service.listAlerts()))
    assert.equal((await h.query('task.list'))[0].humanRequests[0].status, 'waiting-reply')
    assert.equal(ownerCalls, 1)
    assert.equal((await h.query('notification.get', { notificationId })).state, 'delivered')
    assert.equal(h.residentStore.getGroup(message.groupId).outbox.find(item => item.outboundId === notificationId).deliveredMessageId, 'historical-reply-id')
    assert.equal(h.sent.filter(notification => notification.kind === 'topic-reply').length, sentBefore)
    const oldEcho = await h.service.ingest({ ...message, messageId: 'historical-reply-id', text: blocked.decision.reply })
    assert.equal(oldEcho.reason, 'own-notification', '重放 prepared 收据不能覆盖当前 delivered 的发送身份缓存')
    const sentAfter = h.sent.length
    await h.service.retryMessage({ groupId: message.groupId, messageId: 'manual-followup' }); await h.service.whenIdle()
    assert.equal(h.sent.length, sentAfter, '已应用动作和已送达回复不能因重复重试再次执行')
    assert.equal(ownerCalls, 1)
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

// Full baseline and current native runs need about 140s for 32 generations and independent verification.
test('32 continuations bound owner Host input and execution-read tool results while preserving authority and unknown effects', { timeout: 240000 }, async t => {
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
  await h.service.ingest({ ...message, text: '测试助手，仅分析并汇总32轮观察。' + scope }); await h.service.whenIdle()
  const [task] = await h.query('task.list'), executions = await h.query('execution.list')
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(executions.length, 3); assert.equal(executions.filter(item => item.inputVersion === 32).length, 1); assert.equal(executions[0].inputVersion, 32)
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

test('simple existing-file delivery uses one executor and owner reads the delivered evidence', { timeout: 30000 }, async t => {
  const fixture = await nativeCase(t, 'task-simple-file-')
  const source = join(fixture.root, 'existing-template.txt'), contents = 'existing template, unchanged bytes\n'
  await writeFile(source, contents)
  let delegated = false, executorStep = 0, ownerRead = false
  const h = await fixture.host(async request => {
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
  })
  await h.service.ingest({ ...message, messageId: 'existing-file-delivery', text: '测试助手，将现成模板原样交付到任务目录即可。' })
  await h.service.whenIdle()
  const [task] = await h.query('task.list'), [execution] = await h.query('execution.list')
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal(await readFile(join(fixture.root, 'tasks', task.taskId, 'delivered-template.txt'), 'utf8'), contents)
  const writes = h.toolResults.filter(result => result.name === nativeShell)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sessionId, execution.sessionId)
  assert.equal(writes[0].result.isError, false)
  assert.ok(h.toolResults.some(result => result.name === 'read' && result.sessionId === task.sessionId && !result.result.isError))
  await h.service.recover(); await h.service.whenIdle()
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1, '完成后不重放文件交付')
})

test('native service routes authenticated source, delegates parallel execution, persists wake before owner wait, and sends confirmation and completion with readback', { timeout: 30000 }, async t => {
  const fixture = await nativeCase(t, 'task-service-native-'), { root } = fixture
  const teamMessage = { ...message, text: '测试助手，分别生成 alpha、beta 和 gamma 的文件并用终端验证，再汇总结论。' }
  const steps = new Map(), executionStarted = new Set(), started = Promise.withResolvers()
  const handoffs = Object.fromEntries(['alpha', 'beta', 'gamma'].map(key => [key, `负责${key}-native-proof.txt和${key}-process-cwd.txt；原请求要求分别生成并核验。另一组文件由其他执行负责，互无前置依赖。仅在本任务目录写这两个文件，用原生读取与终端核验内容和目录后报告证据，不发送消息。`]))
  const wrappedFilesystems = new Set(), readOverlap = { active: 0, peak: 0, started: 0 }
  let ownerRounds = 0, sawResultsBeforeWait = false, lateNativeCalls = 0
  const h = await fixture.host(async (request, host) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
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
  const first = await h.service.ingest(teamMessage)
  assert.equal(first.accepted, true)
  await h.service.whenIdle()
  assert.deepEqual((await h.service.recover()).failures, [])
  const tasks = await h.query('task.list')
  assert.equal(tasks.length, 1)
  const task = tasks[0], executions = await h.query('execution.list', { taskId: task.taskId })
  assert.equal(new Set(executions.map(execution => execution.sessionId)).size, 3)
  for (const execution of executions) {
    assert.equal(execution.input.context, handoffs[execution.key])
    assert.deepEqual(execution.resourceKeys, ['file:' + execution.key])
  }
  const executionViews = await h.service.taskExecutions(task.taskId)
  assert.ok(executionViews.executions.every(execution => execution.workspaceDir === join(root, 'tasks', task.taskId)
    && execution.workingDirectory === join(root, 'tasks', task.taskId)))
  assert.equal(task.status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), lastDecision: task.lastDecision,
    failures: h.toolResults.filter(result => result.result.isError) }))
  assert.equal(task.topicRefs.length, 1)
  assert.equal(h.residentStore.getTopic(message.groupId, task.topicRefs[0].topicId).processedRevision, task.topicRefs[0].revision)
  assert.equal(ownerRounds, 2)
  assert.equal(sawResultsBeforeWait, true)
  assert.equal(lateNativeCalls, 0, '晚注册工具不能绕过统筹职责边界')
  for (const file of ['owner-native-proof.txt', 'owner-shell-proof.txt']) await assert.rejects(readFile(join(root, 'tasks', task.taskId, file)), { code: 'ENOENT' })
  assert.equal(readOverlap.peak, 3, 'Native concurrency-safe filesystem calls must overlap')
  assert.equal(h.sent.length, 2); assert.equal(h.readbacks.length, 2)
  const echo = await h.service.ingest({ ...message, messageId: 'native-notification-2', senderOpenDingTalkId: 'notification-sender', text: 'completion echo' })
  assert.equal(echo.reason, 'own-notification')
  await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 1, 'durable send receipt must exclude our own group echo')
  assert.equal((await h.query('notification.list'))[0].state, 'delivered')
  assert.equal((await h.query('source.get', { sourceId: first.sourceId })).actorId, message.senderOpenDingTalkId)
  assert.equal((await h.query('source.get', { sourceId: first.sourceId })).routed, true)
  const ownerLog = await inspectSession(h.ctx.sessionPersistence, task.sessionId)
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
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).length, 6)
  assert.ok((await h.query('operation.list', { taskId: task.taskId })).every(operation => operation.state === 'succeeded'))
  await h.service.ingest(teamMessage); await h.service.whenIdle(); await h.service.recover(); await h.service.whenIdle()
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 3)
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

test('native sequential handoff preserves one executor before independent review of the fixed artifact', { timeout: 30000 }, async t => {
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
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'sequential-review',
    objective: '生成固定候选，沿原执行核对后独立只读核验；未完成所有核验前不要宣布完成，不部署或发送。' })
  await h.service.whenIdle()
  assert.deepEqual((await h.service.recover()).failures, [])
  const executions = await h.query('execution.list', { taskId: created.taskId })
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal(executions.length, 2, 'Sequential continuation reuses the executor; only the independent review adds a member')
  const rejectedCompletions = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
  assert.equal(rejectedCompletions.length, 0, 'Two members may complete once the actual work is verified')
  assert.ok(executions.every(item => item.definition.executionBackend === 'dsh' && item.sessionBound))
  assert.equal(executions.find(item => item.key === 'candidate').continuations.length, 1)
  assert.equal(independentStartedAfterDrain, true)
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal(createHash('sha256').update(await readFile(join(fixture.root, 'tasks', created.taskId, artifact))).digest('hex'), sha256)
  const reviewer = executions.find(item => item.key === 'independent-review')
  const reviewLog = await inspectSession(h.ctx.sessionPersistence, reviewer.sessionId)
  const reviewTools = reviewLog.events.filter(event => event.type === 'tool/call').map(event => event.data.name)
  assert.ok(reviewTools.every(name => ['model_content_read', 'read', 'execution_submit'].includes(name)), 'Independent review only reads evidence and submits its result')
  assert.equal(reviewTools.filter(name => name === 'read').length, 1)
  assert.equal(reviewTools.filter(name => name === 'execution_submit').length, 1)
  assert.equal(reviewTools.at(-1), 'execution_submit')
  assert.equal((await h.query('operation.list', { taskId: created.taskId })).length, 1, 'Verification creates no second write effect')
})

test('native service runs eleven independent members within the configured concurrency and completes', { timeout: 45000 }, async t => {
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
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'eleven-members', objective: '分别生成并读取十一份互不依赖的证据文件，全部核验后完成' })
  await h.service.whenIdle()
  const executions = await h.query('execution.list', { taskId: created.taskId })
  assert.equal(executions.length, 11, JSON.stringify(h.toolResults.filter(item => item.result.isError)))
  assert.equal(new Set(executions.map(item => item.sessionId)).size, 11)
  assert.ok(peakRunning > 0 && peakRunning <= 2)
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed', JSON.stringify(h.service.listAlerts()))
  for (const execution of executions) {
    assert.equal(execution.definition.executionBackend, 'dsh')
    assert.equal(execution.status, 'succeeded'); assert.equal(execution.drained, true); assert.equal(execution.sessionBound, true)
    assert.equal(await readFile(join(fixture.root, 'tasks', created.taskId, `${execution.input.objective}.txt`), 'utf8'), execution.input.objective)
    assert.match(await readFile(join(fixture.root, 'tasks', created.taskId, 'outputs', execution.executionId, 'round-1.md'), 'utf8'), new RegExp(execution.input.objective))
  }
  assert.equal((await h.query('operation.list', { taskId: created.taskId })).length, 11)
  assert.ok(!h.toolResults.some(item => item.result.isError))
})

test('native executor resumes in the same titled task workspace and all task sessions share the process cwd', { timeout: 30000 }, async t => {
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
  const created = await first.service.createTask({ groupId: 'native-group', requestId: 'workspace-resume', title: '恢复目录核对', objective: '核对执行会话恢复时的工作区' })
  await first.service.whenIdle()
  const [execution] = await first.query('execution.list'), taskRoot = join(fixture.root, 'tasks', created.taskId)
  const runtimeCwd = taskRoot
  await first.close()
  const next = await fixture.host(model(true), { initialize: false })
  await next.service.recover(); await next.service.whenIdle()
  await next.service.appendTaskContext({ taskId: created.taskId, requestId: 'resume-executor', progressImpact: 'replan', context: '继续使用原执行会话完成第二次核对' })
  await next.service.whenIdle()
  assert.deepEqual((await next.service.recover()).failures, [])
  const [resumed] = await next.query('execution.list')
  assert.equal(resumed.sessionId, execution.sessionId)
  assert.equal(resumed.executionId, execution.executionId)
  assert.equal(resumed.input.objective, 'second')
  assert.equal((await next.query('execution.list')).length, 1, 'A continuation does not add members to satisfy a headcount')
  assert.equal(resumed.definition.executionBackend, 'dsh')
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
  assert.equal(resumed.input.title, execution.title)
})

test('native service reopens an unknown notification for readback without resending completed business work', { timeout: 15000 }, async t => {
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
  try {
    await first.service.ingest({ ...message, messageId: 'notification-request', text: '测试助手，核对已有记录并给出结论。' })
    await first.service.whenIdle()
    assert.equal((await first.query('task.list'))[0].status, 'completed')
    const pending = (await first.query('notification.list')).find(notification => notification.payload.coveredEventIds?.length)
    assert.equal(pending.state, 'starting', 'Topic 发件箱将 ACK 与送达回查分开记录')
    assert.equal(pending.ack.messageId, 'durable-delivery-id')
    assert.equal(pending.readbackAttemptCount, 1)
    assert.ok(Date.parse(pending.nextAttemptAt) > Date.now())
    assert.equal(sends, 2)
  } finally { await first.close() }
  const readsBeforeRecovery = readbacks
  canRead = true
  const second = await fixture.host(() => { throw new Error('Completed task must not invoke the model during receipt recovery') }, { notifications, initialize: false })
  assert.equal((await second.query('notification.list')).find(notification => notification.payload.coveredEventIds?.length).state, 'unknown')
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
  await h.service.appendTaskContext({ taskId: oldTask.taskId, requestId: 'revise-once', progressImpact: 'replan', expectedRequirementRevision: 1, expectedControlRevision: 1,
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

for (const [maxConcurrentTasks, maxConcurrentExecutions] of [[1, 1], [1, 2], [2, 1], [2, 3]]) test(`native capacity queues promote every task and execution: tasks=${maxConcurrentTasks}, executions=${maxConcurrentExecutions}`, { timeout: 25000 }, async t => {
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
  try {
    await h.service.createTask({ groupId: 'native-group', requestId: 'capacity-a', objective: 'first task' })
    await h.service.createTask({ groupId: 'native-group', requestId: 'capacity-b', objective: 'second task' })
    const admitted = Math.min(maxConcurrentTasks * 3, maxConcurrentExecutions)
    await waitUntil(() => entered === admitted, 'available native executor slots admitted')
    await waitUntil(async () => (await h.query('execution.list')).length === maxConcurrentTasks * 3, 'admitted owners persisted all three delegations')
    assert.equal((await h.query('task.list')).filter(task => task.sessionBound).length, maxConcurrentTasks)
    assert.equal((await h.query('execution.list')).filter(execution => execution.status === 'running').length, admitted)
  } finally { gate.resolve() }
  await h.service.whenIdle()
  assert.equal(entered, 6, 'All six real execution sessions must run without a periodic recovery tick')
  assert.ok((await h.query('task.list')).every(task => task.status === 'completed'))
  for (const execution of await h.query('execution.list')) {
    assert.equal(execution.status, 'succeeded'); assert.equal(execution.drained, true)
    assert.equal(await readFile(join(fixture.root, 'tasks', execution.taskId, execution.input.objective + '-capacity-proof.txt'), 'utf8'), execution.taskId + ':' + execution.input.objective)
  }
})

test('native shared resources queue without occupying task capacity and promote on drain', { timeout: 45000 }, async t => {
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
  try {
    await h.service.createTask({ groupId: 'native-group', requestId: 'resource-holder', objective: 'holder' })
    await waitUntil(() => entered.includes('holder'), 'first execution holds resource')
    const waiter = await h.service.createTask({ groupId: 'native-group', requestId: 'resource-waiter', objective: 'waiter' })
    await waitUntil(async () => (await h.query('execution.list', { taskId: waiter.taskId }))[0]?.resources.state === 'waiting', 'same resource waits')
    await h.service.createTask({ groupId: 'native-group', requestId: 'resource-independent', objective: 'independent' })
    await waitUntil(() => entered.includes('independent'), 'waiting task gives capacity to independent resource')
    assert.deepEqual(entered, ['holder', 'independent'])
    const waiting = (await h.query('execution.list', { taskId: waiter.taskId }))[0]
    assert.equal(waiting.status, 'queued'); assert.equal(waiting.leaseEpoch, 0)
    assert.equal(waiting.resources.blocking[0].resourceKey, 'uat2')
    assert.equal(h.service.listAlerts().length, 0)
    // 在持有者不释放期间，等待者不能反复进入模型或增加执行租约。
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal((await h.query('execution.get', { executionId: waiting.executionId })).leaseEpoch, 0)
    assert.ok(h.requests.filter(request => { try { return latestInput(request).task?.taskId === waiter.taskId } catch { return false } }).length < 6, 'resource conflict must not create a model/claim hot loop')
  } finally { gate.resolve() }
  await h.service.whenIdle()
  assert.deepEqual(entered, ['holder', 'independent', 'waiter'])
  assert.ok((await h.query('task.list')).every(task => task.status === 'completed'), JSON.stringify({ tasks: (await h.query('task.list')).map(item => ({ status: item.status, recovery: item.providerRecovery })), executions: (await h.query('execution.list')).map(item => ({ key: item.key, objective: item.input.objective, status: item.status, error: item.result?.payload.error })), errors: h.toolResults.filter(item => item.result.isError) }))
  for (const execution of (await h.query('execution.list')).filter(item => item.key === 'run')) {
    assert.equal(execution.resources.state, 'released')
    assert.equal(await readFile(join(fixture.root, 'tasks', execution.taskId, 'resource-proof.txt'), 'utf8'), execution.input.objective)
  }
})

test('native delegation rejects changed keys on receipt replay and preserves omitted continuation keys', { timeout: 30000 }, async t => {
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
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'resource-continuation', objective: 'resource continuation' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(executions, 2)
  const all = await h.query('execution.list'); assert.equal(all.length, 3); assert.equal(all.filter(item => item.key === 'original').length, 1)
  assert.deepEqual(all[0].resourceKeys, ['uat2']); assert.equal(all[0].inputVersion, 2)
  const results = h.toolResults.filter(item => item.name === 'task_delegate')
  assert.equal(results.filter(item => item.result.isError).length, 1)
  assert.match(JSON.stringify(results[1].result), /DYNAMIC_DISPATCH_KEY_CONFLICT/)
  assert.match(JSON.stringify(results[2].result), /"status":"succeeded"/)
  assert.match(JSON.stringify(results[2].result), /"state":"released"/)
  assert.match(JSON.stringify(h.toolResults.find(item => item.name === 'task_execution_read').result), /"state":"released"/)
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
  await h.service.appendTaskContext({ taskId: task.taskId, requestId: 'model-retry-source', progressImpact: 'replan', context: 'Try this same task again with the new information.' })
  await h.service.whenIdle()
  assert.equal(requests, 2)
  const stored = await h.query('task.get', { taskId: task.taskId })
  assert.equal(stored.drained, true)
  assert.equal(stored.status, persistent ? 'active' : 'completed')
  assert.equal(stored.sessionId, task.session.sessionId)
})

test('empty owner recovery reviews the retained execution without replaying its completed native write', { timeout: 30000 }, async t => {
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
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'empty-after-write', objective: '写一次后核对结果' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).providerRecovery.failure.code, 'TASK_SESSION_NO_SUBMISSION')
  assert.deepEqual((await h.query('task.events')).events, [], 'An empty Owner turn cannot publish a business completion event')
  try {
    // 单独核对五秒退避后的恢复；后续成员核验沿真实调度排空，仍受外层三十秒总时限约束。
    await waitUntil(() => reviewed, 'retained owner recovery', 10000)
    await h.service.whenIdle()
    assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  }
  catch (error) { throw new Error(JSON.stringify({ task: await h.query('task.get', { taskId: created.taskId }), executions: (await h.query('execution.list')).map(item => ({ key: item.key, status: item.status, error: item.result?.payload.error })), errors: h.toolResults.filter(item => item.result.isError) }), { cause: error }) }
  assert.equal(reviewed, true)
  assert.equal((await readFile(effect, 'utf8')).trim(), 'once')
  const executions = await h.query('execution.list', { taskId: created.taskId })
  assert.equal(executions.length, 3); assert.equal(executions.filter(item => item.key === 'once').length, 1)
  assert.equal(executions[0].executionId, executionId)
  assert.equal(executions[0].inputVersion, 1)
  assert.equal((await h.query('operation.list', { taskId: created.taskId })).filter(item => item.state === 'succeeded').length, 1)
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1)
  const events = (await h.query('task.events')).events
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'task.completed')
  assert.equal(events[0].taskId, created.taskId)
  const receipt = await h.query('receipt.get', { id: events[0].taskDecisionReceiptId })
  assert.equal(receipt.taskDecision.id, events[0].commandId)
  assert.equal(receipt.taskDecision.decision.action, 'complete')
  assert.deepEqual(receipt.completionEvent, events[0], 'The completion event is anchored to the exact formal Owner receipt')
  const operations = await h.query('operation.list', { taskId: created.taskId })
  await h.service.recover()
  await h.service.whenIdle()
  assert.deepEqual((await h.query('task.events')).events, events)
  assert.deepEqual((await h.query('execution.list', { taskId: created.taskId })).map(item => ({ executionId: item.executionId, inputVersion: item.inputVersion })),
    executions.map(item => ({ executionId: item.executionId, inputVersion: item.inputVersion })))
  assert.deepEqual((await h.query('operation.list', { taskId: created.taskId })).map(item => item.operationId), operations.map(item => item.operationId))
  assert.equal(h.toolResults.filter(result => result.name === nativeShell).length, 1)
  assert.equal((await readFile(effect, 'utf8')).trim(), 'once')
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
  const completionEvents = (await h.query('task.events')).events
  assert.equal(completionEvents.length, correctOnce ? 1 : 0, 'Only a valid complete submission may publish the authoritative event')
  if (correctOnce) {
    assert.equal(completionEvents[0].taskId, task.taskId)
    const receipt = await h.query('receipt.get', { id: completionEvents[0].taskDecisionReceiptId })
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
  const saved = await inspectSession(h.ctx.sessionPersistence, stored.sessionId)
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_session_submit').length, requests)
  await h.service.whenIdle()
  assert.equal(requests, correctOnce ? 2 : 3)
  assert.deepEqual((await h.query('task.events')).events, completionEvents)
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
    const rejection = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
    assert.equal(rejection.length, 1)
    const blockers = JSON.parse(rejection[0].result.error.message)
    assert.equal(blockers.executions.length, 1)
    assert.equal(blockers.executions[0].taskId, task.taskId)
    assert.equal(blockers.executions[0].drained, false)
  } finally { release.resolve(); await h.service.whenIdle() }
  assert.equal((await h.query('task.list'))[0].status, 'completed', 'The same single-member task completes only after physical drain')
})

test('native single-member completion keeps an unknown tool effect unresolved without replay', { timeout: 20000 }, async t => {
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
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'single-unknown-effect', objective: '核对失败后原操作效果，不重放原动作' })
  await h.service.whenIdle()
  const [execution] = await h.query('execution.list', { taskId: created.taskId }), operations = await h.query('operation.list', { taskId: created.taskId })
  assert.equal(execution.drained, true)
  assert.equal(operations.length, 1); assert.equal(operations[0].state, 'unknown')
  assert.equal(await readFile(join(fixture.root, 'tasks', created.taskId, 'uncertain-effect.txt'), 'utf8'), 'once')
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'active')
  assert.equal(attemptedComplete, true)
  const rejection = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
  assert.equal(rejection.length, 1)
  const blockers = JSON.parse(rejection[0].result.error.message)
  assert.equal(blockers.operations.length, 1); assert.equal(blockers.operations[0].state, 'unknown')
  assert.equal(blockers.operations[0].operationId, operations[0].operationId)
  assert.equal(h.toolResults.filter(item => item.name === 'uncertain_native_write').length, 1)
  assert.equal((await h.query('task.events')).events.length, 0, 'An unresolved effect cannot publish task completion')
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

test('execution document publication failure after claim drains the committed execution and exposes an alert', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-document-claim-failure-'))
  let h, backing, delegated = false, poisoned = false, executionCalls = 0, claimed
  t.after(async () => { try { await h?.close(); await backing?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  backing = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
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
  h = await nativeTaskHost(root, async request => {
    const topics = topicTaskCalls(request); if (topics) return topics
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'document-failure-check', objective: '只读核对当前材料' })] }
      return [decision('wait', '等待当前执行的实际结果')]
    }
    executionCalls++
    return [call('execution_submit', { output: { status: 'completed', summary: '不应在文档读取失败时执行', evidence: [], limitations: [], artifacts: [] } })]
  }, { store })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'document-write-failure', objective: '只读核对当前材料' })
  await h.service.whenIdle()
  assert.equal(poisoned, true)
  const execution = await h.query('execution.get', { executionId: claimed.executionId })
  assert.equal(execution.executionId, claimed.executionId); assert.equal(execution.leaseEpoch, claimed.leaseEpoch)
  assert.equal(execution.status, 'failed'); assert.equal(execution.drained, true); assert.equal(execution.sessionBound, false)
  assert.equal(execution.result.payload.error.code, 'EXECUTION_DOCUMENT_PATH_INVALID')
  assert.equal(executionCalls, 0); assert.equal((await h.query('operation.list')).length, 0)
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'active')
  assert.ok(h.service.listAlerts().some(item => item.alertId === `failure:execution-document:${execution.executionId}` && item.detail === 'EXECUTION_DOCUMENT_PATH_INVALID'))
})

testRunner('resource read retries preserve image facts and duplicate ingress reuses the source', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const { openResidentStore } = await import('../packages/dingtalk-dsh-assistant/store.js')
  const { openTaskSessionService } = await import('../packages/dingtalk-dsh-assistant/task-session-service.js')
  const root = await mkdtemp(join(tmpdir(), 'native-ingress-phases-'))
  let h, reads = 0
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, request => {
    const input = latestInput(request)
    return request.tools.some(tool => tool.name === 'group_topic_route_submit') ? [{ name: 'group_topic_route_submit', args: {
      requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
        ignoredRefs: [{ quote: item.text, reason: '隔离入站时钟验证，无业务执行' }], units: [] })) } }] : []
  }, { resident: true })
  h.residentStore = await openResidentStore(h.ctx.storageDomain)
  await h.residentStore.subscribe({ groupId: 'phase-group', name: '隔离计时群' })
  h.service = await openTaskSessionService({ ctx: h.ctx, residentStore: h.residentStore,
    legacy: { getGroup: id => h.residentStore.getGroup(id), getAgentConfig: () => ({ workspaceDir: root, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', agentNames: ['测试助手'] }) },
    config: { workspaceDir: root, dbPath: join(root, 'dynamic.db'), instanceId: 'native-ingress', initialize: true, ownerActorId: 'native-user', webActorId: 'native-user', provider: 'native-task-test' },
    readResource: async () => {
      if (++reads === 1) throw Object.assign(new Error('offline'), { code: 'OFFLINE' })
      return { image: { mediaType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQy7vzHwAEfgJodQLI1QAAAABJRU5ErkJggg==', 'base64') } }
    }, notifications: { send: () => assert.fail('不得发送消息'), readback: () => assert.fail('不得读取渠道回执') } })
  const message = { groupId: 'phase-group', messageId: 'image-message', occurredAt: '2026-10-27T05:30:27.636Z', senderOpenDingTalkId: 'native-user', text: '图片入站计时', resourceRefs: [{ type: 'mediaId', resourceId: 'private-media' }] }
  const first = await h.service.ingest(message)
  const failed = await h.service.store.query({ kind: 'source.get', sourceId: first.sourceId })
  const retry = await h.service.ingest(message)
  await h.service.whenIdle() // Settle legitimate queue/router spans before checking duplicate-ingress stability.
  const success = await h.service.store.query({ kind: 'source.get', sourceId: retry.sourceId })
  assert.notEqual(retry.sourceId, first.sourceId)
  assert.equal(h.residentStore.getGroup('phase-group').messages[0].imageRefs.length, 1)
  assert.equal(JSON.stringify(success.stages).includes('private-media'), false)
  const repeated = await h.service.ingest({ ...message, imageRefs: h.residentStore.getGroup('phase-group').messages[0].imageRefs })
  assert.equal(repeated.sourceId, retry.sourceId)
  assert.equal(h.residentStore.getGroup('phase-group').messages.filter(item => item.messageId === message.messageId).length, 1)
  assert.equal(reads, 2)
})
