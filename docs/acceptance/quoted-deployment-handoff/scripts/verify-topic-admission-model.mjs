import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'
import { openTaskTopicCoordinator } from '../../../../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'

// #320 同类图文的生产Topic承接链；不运行现场TaskStore、Owner或钉钉渠道。
const output = path.resolve(process.argv[2] ?? 'docs/tmp/quoted-deployment-handoff/latency320/model')
const installedProfile = 'D:/dsh_home/profiles/web/package.json'
process.env.DSH_NATIVE_TEST_PROFILE = installedProfile
const installed = createRequire(pathToFileURL(installedProfile))
const load = name => import(pathToFileURL(installed.resolve(name)))
const sha = value => createHash('sha256').update(value).digest('hex')
const result = { passed: false, provider: 'cortex-gateway', model: 'cortex-cowork', reasoningEffort: 'low',
  standardStreams: 0, streamsByPhase: {}, tools: [], invalidToolCalls: [], duplicateTaskListReads: [],
  actions: [], outboundCaptured: [], realChannelSends: 0, realTaskWrites: 0, providerNetworkCalls: null, cost: null, sourceSha256: {} }
let host, coordinator, credentialDigest, timeout, phase = 'setup', restoreFetch
const wireReaders = []
try {
  await mkdir(output, { recursive: true })
  for (const file of ['task-topic-coordinator.js', 'topic-runtime.js', 'store.js'])
    result.sourceSha256[file] = sha(await readFile(new URL(`../../../../packages/dingtalk-dsh-assistant/${file}`, import.meta.url)))
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ expression: value }) })])
  const profile = yaml.load(await readFile('D:/dsh_home/profiles/web/cordis.patch.yml', 'utf8'), { schema })
  const route = profile.find(row => row.id === 'llm-pi-ai')?.config?.providers?.[result.provider]
  assert.ok(route?.apiKeyEnv && route.models?.some(model => model.id === result.model))
  // 仅采提供方实际发送的工具schema和SSE工具参数，不记录headers、正文图片或任何reasoning事件。
  const providerOrigin = new URL(route.baseURL).origin, originalFetch = globalThis.fetch
  let wireSequence = 0
  result.wire = { requests: [], events: [] }
  globalThis.fetch = async (...args) => {
    const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url)
    const response = await originalFetch(...args)
    if (url.origin !== providerOrigin || !response.headers.get('content-type')?.includes('text/event-stream')) return response
    const id = ++wireSequence
    try {
      const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : null
      result.wire.requests.push({ id, tools: (body?.tools ?? []).filter(tool => ['group_topic_context_get', 'group_reply_review_get'].includes(tool.name))
        .map(tool => ({ name: tool.name, inputSchema: tool.input_schema })) })
    } catch { result.wire.requests.push({ id, schemaUnavailable: true }) }
    const copy = response.clone()
    wireReaders.push((async () => {
      const reader = copy.body.getReader(), decoder = new TextDecoder()
      let pending = ''
      while (true) {
        const { value, done } = await reader.read()
        pending += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(line.slice(6)) } catch { continue }
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
            result.wire.events.push({ request: id, type: event.type, index: event.index, name: event.content_block.name,
              id: event.content_block.id, input: event.content_block.input })
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta')
            result.wire.events.push({ request: id, type: event.type, index: event.index, partialJson: event.delta.partial_json })
        }
        if (done) break
      }
    })().catch(error => { (result.wire.errors ??= []).push({ name: error.name, code: error.code ?? null }) }))
    return response
  }
  restoreFetch = () => { globalThis.fetch = originalFetch }
  const credentials = await load('@deepseek-ai/dsh-credentials-local'), credentialBytes = await readFile('D:/dsh_home/.credentials.yaml')
  credentialDigest = sha(credentialBytes)
  assert.equal(credentials.renderFlatLayoutMigration(credentialBytes.toString('utf8')), undefined)
  assert.ok(credentials.parseCredentialsDocument(credentialBytes.toString('utf8'), 'configured-store').refs.has(route.apiKeyEnv))
  const { nativeTaskHost, available, reason } = await import('../../../../test/fixtures/task-session-native-host.js')
  assert.ok(available, reason)
  const runtime = path.join(output, 'runtime')
  host = await nativeTaskHost(runtime, () => { throw new Error('SCRIPTED_MODEL_FORBIDDEN') }, { serviceFactory: async () => ({ close: async () => {} }) })
  await host.ctx.plugin(credentials.default, { dshHome: 'D:/dsh_home', watch: false })
  await host.ctx.plugin(await load('@deepseek-ai/dsh-llm-pi-ai'), { providers: { [result.provider]: route } })
  await host.ctx.plugin((await load('@deepseek-ai/dsh-attachment-local')).default, { dshHome: path.join(runtime, 'attachment-home') })
  await host.ctx.loader.await()
  const store = host.residentStore, groupId = 'native-group'
  await store.setAgentNames(['测试助手'])
  const historical = [
    { title: '修复终审只读UPR导入覆盖并部署UAT2', summary: '已完成终审只读UPR覆盖权限修复和UAT2部署；未涉及草稿导入后的物料名称显示。' },
    { title: '调整数据集合并与UPR合并来源展示', summary: '已完成合并来源入口展示；未涉及草稿导入UPR后的物料名称。' },
  ]
  for (const [index, item] of historical.entries()) {
    const messageId = `synthetic-history-${index}`
    await store.ingest({ groupId, messageId, text: item.summary, senderName: '合成人员', senderOpenDingTalkId: 'synthetic-user', occurredAt: '2026-10-26T00:00:00Z' })
    await store.routeMessages({ groupId, routeId: `seed-route-${index}`, routingRevision: store.getGroup(groupId).routingRevision,
      routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: `history-${index}`, title: item.title }] }] })
    const topic = store.listTopics(groupId).find(topic => topic.title === item.title)
    const refs = store.getGroup(groupId).messages.find(message => message.messageId === messageId).activeUnitRefs
    await store.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: topic.revision, decisionId: `seed-decision-${index}`,
      decision: { basisMessageIds: [messageId], basisUnitRefs: refs, actions: [], reason: '合成历史已完成', topicUpdate: { summary: item.summary } } })
    await store.completeTopicDecision({ groupId, topicId: topic.topicId, decisionId: `seed-decision-${index}` })
    item.topicId = topic.topicId
  }
  const tasks = Array.from({ length: 27 }, (_, index) => ({ taskId: `synthetic-task-${index}`, groupId, title: historical[index]?.title ?? `其他独立事项${index}`,
    state: 'completed', inputVersion: 1, runSequence: 1, topicRefs: historical[index] ? [{ topicId: historical[index].topicId, revision: 1 }] : [],
    objective: historical[index]?.summary ?? `办理独立事项${index}，与UPR草稿导入物料名称无关。`,
    request: historical[index]?.summary ?? `独立事项${index}`, completion: { result: { summary: historical[index]?.summary ?? `独立事项${index}已完成。` } } }))
  tasks.push({ ...tasks[0], taskId: 'outside-group-task', groupId: 'other-group', title: '草稿UPR物料名称为空排查', objective: '这是另一个群的事项，不可读取或续办。', topicRefs: [] })
  store.setTaskSessionReader({ listTasks: () => tasks, getTask: id => tasks.find(task => task.taskId === id), isTaskQuiescent: () => true })
  const imageBytes = await readFile('D:/dsh_home/attachments/v1/objects/25/256569caee3a1187f2376b56c6ab56ad40c22e0f79449f629e310baa7b44c98d')
  assert.equal(sha(imageBytes), '256569caee3a1187f2376b56c6ab56ad40c22e0f79449f629e310baa7b44c98d')
  const imageRefs = await host.ctx.attachments.saveImages([{ mediaType: 'image/jpeg', data: imageBytes, name: 'synthetic-material-name.jpg' }])
  result.image = { bytes: imageBytes.length, sha256: sha(imageBytes), prepared: true }
  const sessionPhases = new Map(), calls = new Map(), pages = new Set()
  host.ctx.on('llm/stream', (request, next) => {
    assert.equal(request.provider, result.provider); assert.equal(request.model, result.model)
    const names = request.tools.map(tool => tool.name)
    phase = names.includes('group_topic_route_submit') ? 'route' : names.includes('group_decision_submit') ? 'decision' : 'other'
    result.standardStreams++; result.streamsByPhase[phase] = (result.streamsByPhase[phase] ?? 0) + 1
    return next()
  })
  host.ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'plugin:dingtalk/coordination') sessionPhases.set(sessionId, event.data.role)
    if (event.type === 'tool/call') {
      let args
      try { args = JSON.parse(event.data.arguments) } catch { args = { parseFailed: true } }
      const entry = { sessionId, phase: sessionPhases.get(sessionId) ?? phase, seq: event.seq, name: event.data.name, arguments: args }
      result.tools.push(entry); calls.set(event.data.callId, entry)
      if (entry.name === 'group_task_list') {
        const key = JSON.stringify([sessionId, (args.query ?? '').trim().toLowerCase(), args.offset ?? 0])
        if (pages.has(key)) result.duplicateTaskListReads.push(entry)
        pages.add(key)
      }
    }
    if (event.type === 'tool/result') {
      const call = calls.get(event.data.callId ?? event.data.message?.toolCallId)
      const message = event.data.message
      let value
      try { value = JSON.parse(message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n')) } catch {}
      if (message?.isError || value?.status === 'invalid-arguments') result.invalidToolCalls.push({ name: call?.name ?? null, phase: call?.phase ?? phase, seq: event.seq,
        status: message?.isError ? 'tool-error' : value.status, codes: value?.issues?.map(issue => issue.code) ?? [] })
    }
  })
  coordinator = await openTaskTopicCoordinator({ ctx: host.ctx, store, root: runtime,
    legacy: { getAgentConfig: () => ({ agentPreset: 'native-test', agentNames: ['测试助手'] }) },
    models: { provider: result.provider, model: result.model, reasoningEffort: result.reasoningEffort },
    async applyAction(_groupId, action, operation) {
      result.actions.push(structuredClone(action))
      if (action.kind === 'new-task') tasks.push({ taskId: operation.taskId, groupId, title: action.title, objective: action.objective, state: 'queued',
        inputVersion: 1, runSequence: 1, topicRefs: action.topicRefs, appliedOperations: [operation.operationId] })
    },
    async appendOutbox(outbound) { result.outboundCaptured.push({ text: outbound.text, topicRefs: outbound.topicRefs }); await store.appendOutbox(outbound) },
    onStage: async (_request, stage) => { (result.stages ??= []).push(stage) },
    onError: (_groupId, error) => { (result.errors ??= []).push({ name: error.name, code: error.code ?? null }) },
  })
  const started = performance.now()
  await store.ingest({ groupId, messageId: 'synthetic-material-source', senderName: '合成请求人', senderOpenDingTalkId: 'synthetic-user', sourceKind: 'dingtalk',
    text: '测试助手，草稿导入UPR没有正确显示物料名称，如图所示。先只读排查原因并报告，不修改代码或部署。', occurredAt: new Date().toISOString(), imageRefs })
  result.imagePreparedToScheduleMs = performance.now() - started
  await coordinator.schedule(groupId)
  await Promise.race([coordinator.whenIdle(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error('bounded timeout'), { code: 'MODEL_ADMISSION_TIMEOUT' })), 180000) })])
  clearTimeout(timeout)
  result.elapsedMs = performance.now() - started
  const topics = store.listTopics(groupId).filter(topic => !historical.some(item => item.topicId === topic.topicId))
  assert.equal(topics.length, 1, 'new distinct material-name issue must have one new Topic')
  assert.equal(result.actions.length, 1, 'one issue must have one task handoff')
  assert.equal(result.actions[0].kind, 'new-task')
  assert.match(result.actions[0].objective, /物料.*名称|名称.*物料/)
  assert.match(result.actions[0].objective, /只读|排查|分析/)
  assert.equal(topics[0].decisions.filter(item => item.status === 'completed').length, 1)
  assert.equal(result.invalidToolCalls.length, 0, 'no invalid tool roundtrip')
  assert.equal(result.duplicateTaskListReads.length, 0, 'no duplicate query/page in one request')
  assert.equal(tasks.filter(task => task.groupId === groupId).length, 28)
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, code: error.code ?? null, assertion: error.code === 'ERR_ASSERTION' ? error.message : null }
} finally {
  clearTimeout(timeout)
  await coordinator?.close(); await host?.close()
  await Promise.allSettled(wireReaders)
  restoreFetch?.()
  if (credentialDigest) result.credentialStoreUnchanged = sha(await readFile('D:/dsh_home/.credentials.yaml')) === credentialDigest
  result.boundary = 'One production route/decision coordinator chain, real prepared #320 image bytes and synthetic 27-task candidates; captured task handoff in isolated ResidentStore, no real TaskStore/Owner/channel. Timing starts after image prepared, excludes original DWS download. Historical timing is observational, not a controlled speedup comparison.'
  await writeFile(path.join(output, 'topic-model-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, elapsedMs: result.elapsedMs, streams: result.standardStreams, byPhase: result.streamsByPhase,
    invalid: result.invalidToolCalls.length, duplicate: result.duplicateTaskListReads.length, actions: result.actions.map(action => ({ kind: action.kind, title: action.title })), failure: result.failure }))
  if (!result.passed) process.exitCode = 1
}
