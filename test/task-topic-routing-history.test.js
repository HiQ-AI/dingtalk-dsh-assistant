import { assert, available, buildReplyReviewCandidates, call, createHash, decisionSummaryRead, envelope, extraHost, fingerprint, groupReplyScopeInstructions, join, jsonValues, latestInput, message, mkdir, mkdtemp, modelToolValues, nativeLifecycle, nativeLifecycleTimeout, nativeTaskHost, openDynamicTaskStore, openTaskSessionService, projectTaskNotification, readFile, reason, resolveTopicMessages, rm, rmdir, scriptedRouteSilences, taskDirectories, taskIndexPage, testRunner, tmpdir, topicTaskCalls, waitUntil } from './fixtures/task-topic-routing-history.js'

testRunner('一级运行中十五条入批且第十六条在下一批处理', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  const root = await mkdtemp(join(tmpdir(), 'routing-live-capacity-'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), routeInputs = []
  let host, first = true
  t.onCancel(() => release.resolve())
  t.after(async () => { release.resolve(); await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const input = latestInput(request), previous = modelToolValues(request).at(-1)
    if (previous?.status === 'context-required' && previous.nextCall) return [{ name: previous.nextCall.name, args: previous.nextCall.arguments }]
    if (!request.tools.some(tool => tool.name === 'group_topic_route_submit')) return topicTaskCalls(request)
    routeInputs.push(structuredClone(input))
    if (first) { first = false; entered.resolve(); await release.promise }
    return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, initialReplies: [], initialReplySilences: [], ...(input.batchRevision !== undefined ? { batchRevision: input.batchRevision } : {}),
      routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion,
        units: [{ unitKey: 'discussion', summary: '讨论记录', sourceRefs: [{ wholeMessage: true }], contextRefs: [], topics: [], fixedTopic: 'out-of-scope', reason: '无需处理' }] })) } }]
  }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest(message('capacity-0', '独立讨论0。')))
  await t.step(() => entered.promise)
  for (let index = 1; index < 16; index++) await t.step(() => host.service.ingest(message(`capacity-${index}`, `独立讨论${index}。`)))
  release.resolve()
  await t.step(() => host.service.whenIdle())
  const group = host.residentStore.getGroup('native-group')
  const receipts = group.routeHistory.filter(item => item.routeId.startsWith('coord-route-'))
  const batches = routeInputs.filter(input => input.messages.length > 0)
  assert.equal(receipts.length, 2)
  assert.ok(batches.some(input => input.requestId === batches[0].requestId && input.messages.length === 15), JSON.stringify(batches.map(input => ({ id: input.requestId, size: input.messages.length }))))
  assert.ok(batches.some(input => input.requestId !== batches[0].requestId && input.messages.some(item => item.messageId === 'capacity-15')))
  assert.ok(batches.every(input => input.messages.length <= 15))
  const acceptedIds = host.toolResults.filter(item => item.name === 'group_topic_route_submit' && item.result.value?.status === 'accepted')
    .map(item => item.result.value.requestId)
  assert.equal(acceptedIds.length, 2)
  const acceptedMessages = acceptedIds.flatMap(id => batches.findLast(input => input.requestId === id).messages.map(item => item.messageId))
  assert.equal(acceptedMessages.length, 16)
  assert.equal(new Set(acceptedMessages).size, 16)
  for (let index = 0; index < 16; index++) {
    assert.ok(acceptedMessages.includes(`capacity-${index}`))
    assert.equal(group.messages.find(item => item.messageId === `capacity-${index}`)?.routingStatus, 'routed')
  }
  assert.equal(host.sent.length, 0)
}))

for (const unrelatedCount of [13, 14]) testRunner(`原生路由保持恢复配对完整并遵守十五条上限：其他来源=${unrelatedCount}`,
  { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
    assert.ok(available, reason)
    const root = await mkdtemp(join(tmpdir(), 'routing-pair-capacity-'))
    const batches = []
    let host
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await t.step(() => nativeTaskHost(root, request => {
      const input = latestInput(request), previous = modelToolValues(request).at(-1)
      if (previous?.status === 'context-required' && previous.nextCall) return [{ name: previous.nextCall.name, args: previous.nextCall.arguments }]
      if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) {
        batches.push(input.messages.map(item => item.messageId))
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, initialReplies: [], initialReplySilences: [], routes: input.messages.map(item => ({
          messageId: item.messageId, messageVersion: item.messageVersion,
          units: [{ unitKey: 'discussion', summary: '讨论记录', sourceRefs: [{ wholeMessage: true }], contextRefs: [], topics: [], fixedTopic: 'out-of-scope', reason: '无需处理' }],
        })) } }]
      }
      return topicTaskCalls(request)
    }))
    for (let index = 0; index < unrelatedCount; index++) await t.step(() => host.residentStore.ingest(message(`other-${index}`, `独立讨论${index}`)))
    await t.step(() => host.residentStore.ingest(message('pair-original', '请说明这个问题。')))
    await t.step(() => host.residentStore.routeMessages({ groupId: 'native-group', routeId: 'pair-hold', routingRevision: host.residentStore.getGroup('native-group').routingRevision,
      routes: [{ messageId: 'pair-original', messageVersion: 1, deferred: { reason: '等待补充' } }] }))
    await t.beginBusiness()
    await t.step(() => host.service.ingest({ ...message('pair-answer', '这是需要补充的说明。'), quotedMessage: { messageId: 'pair-original', content: '请说明这个问题。' } }))
    assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === 'pair-original').routingRecoveryMessageId, 'pair-answer')
    await t.step(() => host.service.whenIdle())
    const expected = [...Array.from({ length: unrelatedCount }, (_, index) => `other-${index}`), 'pair-original', 'pair-answer']
    assert.ok(batches.every(batch => batch.length <= 15))
    assert.deepEqual(batches.map(batch => batch.length), unrelatedCount === 13 ? [15] : [14, 2])
    assert.deepEqual(new Set(batches.flat()), new Set(expected))
    assert.equal(batches.flat().length, expected.length)
    assert.equal(batches.findIndex(batch => batch.includes('pair-original')), batches.findIndex(batch => batch.includes('pair-answer')))
    for (const id of expected) assert.equal(host.residentStore.getGroup('native-group').messages.find(item => item.messageId === id).routingStatus, 'routed', id)
    assert.equal(host.sent.length, 0)
  }))

testRunner('completed task catalogue stays within the tool budget and advances by returned entries without losing tasks', () => {
  const tasks = Array.from({ length: 14 }, (_, index) => ({ taskId: `task-${index}`, title: `原任务${index}`, state: 'completed',
    inputVersion: index + 1, runSequence: 2, topicRefs: [{ topicId: `topic-${index}`, revision: 3 }],
    objective: '核对原任务交付。'.repeat(1000), completion: { result: { summary: '已交付原 PR 及 UAT 证据。'.repeat(1000) } },
    sourceRefs: ['internal-source'], request: '长原文'.repeat(10000), appliedOperations: ['historical-operation'] }))
  const seen = []
  for (let offset = 0; offset < tasks.length;) {
    const page = taskIndexPage(tasks, offset, 100)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12 * 1024)
    assert.ok(page.tasks.length > 0 && page.tasks.length < 14)
    assert.equal(page.total, tasks.length)
    assert.equal(page.nextOffset, offset + page.tasks.length)
    assert.equal(page.hasMore, page.nextOffset < tasks.length)
    for (const item of page.tasks) {
      assert.equal(item.state, 'completed')
      assert.equal(item.inputVersion, tasks.find(task => task.taskId === item.taskId).inputVersion)
      assert.ok(item.objectivePreview && item.resultPreview)
      assert.equal(item.request, undefined)
      assert.equal(item.appliedOperations, undefined)
      seen.push(item.taskId)
    }
    offset = page.nextOffset
  }
  assert.deepEqual(seen, tasks.map(task => task.taskId))
  assert.equal(taskIndexPage(tasks, tasks.length, 100).hasMore, false)
  assert.equal(taskIndexPage([], 0, 100).nextOffset, 0)
  assert.ok(tasks[0].request.length > 20000, '目录缩减不得改写原任务正文')
})

testRunner('task catalogue continuation carries the exact normalized query and current snapshot identity', () => {
  const tasks = Array.from({ length: 18 }, (_, index) => ({ taskId: `task-${index}`, title: `数据集${index}`, state: 'completed',
    inputVersion: 1, runSequence: 1, objective: '完整目标'.repeat(300), result: { summary: '实际结果'.repeat(300) } }))
  const first = taskIndexPage(tasks, 0, 50, '数据集')
  assert.equal(first.hasMore, true); assert.equal(first.query, '数据集')
  assert.deepEqual(first.nextCall, { name: 'group_task_list', arguments: { query: '数据集', offset: first.nextOffset, limit: 50 } })
  const next = taskIndexPage(tasks, first.nextCall.arguments.offset, first.nextCall.arguments.limit, first.nextCall.arguments.query)
  assert.equal(next.snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(next.tasks[0].taskId, tasks[first.nextOffset].taskId)
  assert.deepEqual(taskIndexPage(tasks, 0, 50, '数据集'), first)
  tasks[0].inputVersion++
  assert.notEqual(taskIndexPage(tasks, 0, 50, '数据集').snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(taskIndexPage([], 0, 50, '数据集').nextCall, null)
})

testRunner('native request-bound review and Topic reads accept empty args while routing never guesses a Topic',
  { ...({ timeout: 30000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    let routed = false, reviewed = false, readTopic = false, wrongRequestChecked = false
    const h = await extraHost(t, 'bound-topic-read-', async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request), values = modelToolValues(request)
      if (names.includes('group_topic_route_submit')) {
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_topic_context_get').parameters.required, ['topicId'])
        if (!routed) { routed = true; return [call('group_topic_context_get', {})] }
        const missing = values.find(value => value.issues?.some(issue => issue.code === 'topic_id_required'))
        assert.equal(missing?.status, 'invalid-arguments')
        assert.deepEqual(missing.nextCall, { name: 'group_topic_list', arguments: { offset: 0, limit: 50 } })
        const routes = input.messages.map(item => ({ messageId: item.messageId,
          messageVersion: item.messageVersion, topics: [{ newTopicKey: 'bound-read', title: '只读承接合同核验', reason: '独立核验请求绑定读取合同' }] }))
        return [call('group_topic_route_submit', { requestId: input.requestId, routes, initialReplies: [],
          initialReplySilences: scriptedRouteSilences(routes, '本次仅核验读取合同，无需办理业务') })]
      }
      if (names.includes('group_decision_submit')) {
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_reply_review_get').parameters.required, [])
        assert.deepEqual(request.tools.find(tool => tool.name === 'group_topic_context_get').parameters.required, [])
        if (!wrongRequestChecked) { wrongRequestChecked = true; return [call('group_reply_review_get', { requestIds: ['cross-request'] })] }
        if (!reviewed) { reviewed = true; return [call('group_reply_review_get', {})] }
        const review = values.find(value => Array.isArray(value.requestIds) && Array.isArray(value.candidates))
        assert.deepEqual(review?.requestIds, [input.requestId])
        if (!readTopic) { readTopic = true; return [call('group_topic_context_get', {})] }
        const context = values.find(value => value.topic?.topicId === input.topicId && Array.isArray(value.messages))
        assert.equal(context?.topic.revision, input.revision)
        assert.equal(context.messages[0].messageId, 'contract-source')
        return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision,
          decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '仅核验固定请求读取合同，无业务交办' } })]
      }
      return topicTaskCalls(request) ?? []
    })
    await t.beginBusiness()

    await t.step(async () => h.service.ingest(message('contract-source', '固定请求读取合同核验，无需办理业务。')))
    await t.step(async () => h.service.whenIdle())
    await t.step(async () => waitUntil(async () => (await h.query('source.list')).find(source => source.messageId === 'contract-source')?.processingCompleted, '读取合同来源完成'))
    const group = h.residentStore.getGroup('native-group')
    assert.equal(group.messages.find(item => item.messageId === 'contract-source').routingStatus, 'routed')
    assert.ok(group.routeHistory.some(receipt => receipt.routeId.startsWith('coord-route-') && receipt.initialReplySilences?.some(item => item.sourceRef.messageId === 'contract-source')))
    assert.ok(routed && reviewed && readTopic && wrongRequestChecked)
    assert.ok(h.toolResults.filter(item => item.name === 'group_reply_review_get').some(item => JSON.stringify(item.result).includes('coordination_tool_wrong_request')))
    assert.equal(h.residentStore.listTopics('native-group')[0].decisions[0].status, 'completed')
    assert.equal((await t.step(async () => h.query('task.list'))).length, 0)
    assert.equal(h.sent.length, 0)
  }))
