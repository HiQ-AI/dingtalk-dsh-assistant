import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil, topicTaskCalls } from './fixtures/task-session-native-host.js'
const call = (name, args) => ({ name, args })

for (const replaceVersion of [false,true]) test(`Web maintenance preserves an unsubmitted Topic input${replaceVersion ? ' across source enrichment' : ''}`,
 { timeout: 20000, ...(!available ? { skip: reason } : {}) },async t=>{
 const root=await mkdtemp(join(tmpdir(),'web-unjudged-source-'))
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),currentEntered=Promise.withResolvers(),finish=Promise.withResolvers()
 let topicId,rounds=0
 const h=await nativeTaskHost(root,async request=>{
  assert.ok(++rounds<30)
  const input=latestInput(request),names=request.tools.map(tool=>tool.name)
  if(input.requestId?.startsWith('coord-summary-')||input.trigger==='task-facts')return topicTaskCalls(request)
  if(names.includes('group_topic_route_submit'))return [call('group_topic_route_submit',{requestId:input.requestId,
   routes:input.messages.map(item=>({messageId:item.messageId,messageVersion:item.messageVersion,topics:[{topicId}]}))})]
  if(names.includes('group_decision_submit')){
   if(input.revision===2){entered.resolve(input);await release.promise}
   else if(!replaceVersion||input.messages.some(item=>item.messageId==='pending-topic-source'&&item.messageVersion===2)){
    currentEntered.resolve(input);await finish.promise
   }
   return [call('group_decision_submit',{requestId:input.requestId,topicId:input.topicId,revision:input.revision,
    decision:{actions:[],basisMessageIds:input.messages.map(item=>item.messageId),reason:'已核对当前版本的验收要求，无需新增任务',topicUpdate:{summary:'当前验收要求已记录'}}})]
  }
  return [call('task_session_submit',{decision:{action:'wait',summary:'等待验收材料',evidence:[],limitations:[]}})]
 })
 t.after(async()=>{release.resolve();finish.resolve();await h.close();await rm(root,{recursive:true,force:true})})
 const task=await h.service.createTask({groupId:'native-group',requestId:'original-web-task',title:'列表核验',objective:'核验空状态',acceptanceCriteria:['记录结果']})
 await h.service.whenIdle();topicId=task.topicRefs[0].topicId
 const message={groupId:'native-group',messageId:'pending-topic-source',messageVersion:1,senderOpenDingTalkId:'native-user',senderName:'测试成员',text:'请核对空状态要求',occurredAt:'2026-01-01T00:00:00Z'}
 const admitted=await h.service.ingest(message);await entered.promise
 const context={taskId:task.taskId,requestId:'web-maintenance',context:'补充原任务材料说明',progressImpact:'preserve'}
 await h.service.appendTaskContext(context)
 assert.equal(h.residentStore.getTopic('native-group',topicId).processedRevision,1)
 let current=admitted
 if(replaceVersion)current=await h.service.ingest({...message,messageVersion:2,text:'请核对更新后的空状态要求'})
 release.resolve()
 const revised=await currentEntered.promise
 assert.equal(revised.ownedDeltaMessageIds.includes(message.messageId),true)
 assert.equal(revised.ownedDeltaMessageIds.some(id=>id.startsWith('web-')),false,'applied maintenance is not new authorization')
 const pending=await h.query('source.get',{sourceId:current.sourceId})
 assert.equal(pending.processingCompleted,undefined)
 const row=(await h.service.observerGroupPage('native-group')).items.find(item=>item.messageId===message.messageId)
 assert.equal(row.processingState,'processing');assert.equal(row.processingConclusion,null)
 let priorStamp,priorReceipt
 if(!replaceVersion){
  // Seed the old release's durable source receipt, then use real recovery.
  const refs=h.residentStore.getGroup('native-group').messages.find(item=>item.messageId===message.messageId).activeUnitRefs
  await h.service.store.command({id:'historical-semantic-stamp',kind:'source.processingCompleted',args:{sourceId:current.sourceId,messageVersion:1,
   routingRevision:h.residentStore.getGroup('native-group').routingRevision,activeUnitRefs:refs,units:refs.map(ref=>({...ref,dispatchOwner:'legacy-topic',processingComplete:true}))}})
  priorReceipt=[{topicId,revision:revised.revision}]
  await h.service.store.command({id:'historical-route-receipt',kind:'source.routed',args:{sourceId:current.sourceId,receipt:priorReceipt}})
  priorStamp=(await h.query('source.get',{sourceId:current.sourceId})).processingCompleted
  await h.service.recover()
  const recovered=await h.query('source.get',{sourceId:current.sourceId})
  assert.equal(recovered.processingCompleted,undefined);assert.equal(recovered.processingPending,true)
  assert.deepEqual(recovered.processingHistory,[priorStamp]);assert.deepEqual(recovered.routeReceipt,priorReceipt)
 }
 finish.resolve();await h.service.whenIdle()
 const source=await waitUntil(async()=>{const item=await h.query('source.get',{sourceId:current.sourceId});return item.processingCompleted&&item},'current input semantic conclusion')
 const topic=h.residentStore.getTopic('native-group',topicId)
 const real=topic.decisions.find(record=>record.status==='completed'&&record.decision.basisMessageIds.includes(message.messageId))
 assert.ok(real);assert.equal(topic.processedRevision,topic.revision);assert.equal(topic.summary,'当前验收要求已记录')
 assert.equal(source.version,replaceVersion?2:1)
 if(priorStamp){assert.deepEqual(source.processingHistory,[priorStamp]);assert.deepEqual(source.routeReceipt,priorReceipt)}
 const done=(await h.service.observerGroupPage('native-group')).items.find(item=>item.messageId===message.messageId)
 assert.equal(done.processingState,'processed');assert.equal(done.processingConclusion,real.decision.reason)
 if(replaceVersion){const old=await h.query('source.get',{sourceId:admitted.sourceId});assert.equal(old.processingCompleted,undefined);assert.deepEqual(old.routeReceipt,[{supersededByVersion:2}])}
 const before=await h.query('task.get',{taskId:task.taskId}),decisions=structuredClone(topic.decisions)
 await h.service.appendTaskContext(context);await h.service.whenIdle()
 assert.deepEqual(await h.query('task.get',{taskId:task.taskId}),before,'maintenance replay stays idempotent')
 assert.deepEqual(h.residentStore.getTopic('native-group',topicId).decisions,decisions)
 assert.equal((await h.query('task.list')).length,1);assert.equal((await h.query('execution.list')).length,0);assert.equal(h.sent.length,0)
})

test('reopen reconsiders all five unapplied context messages at the current task version without replay', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-context-recovery-'))
  let store, topicId, sequence = 0, reviewed = []
  const command = (kind, args) => store.command({ id: 'setup-' + ++sequence, kind, args })
  const texts = ['请保留完整审核历史', '两条记录都显示第一轮', '打回修改一次才算一轮', '请核实轮次', '验收时覆盖这些要求']
  const ids = texts.map((_, index) => 'supplement-' + index)
  const h = await nativeTaskHost(root, async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_decision_submit')) {
      if (input.trigger === 'task-facts') return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { actions: [], reason: '保留内部恢复事实' } })]
      reviewed.push(input)
      const basis = input.messages.filter(message => ids.includes(message.messageId))
      assert.deepEqual(basis.map(message => message.messageId), ids)
      assert.deepEqual(input.ownedDeltaMessageIds, ids, 'completed reopen authorization is already consumed; the entire old batch remains')
      const task = await host.query('task.get', { taskId: 'original-task' })
      assert.equal(task.requirementRevision, 2)
      const basisUnitRefs = basis.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      return [call('group_decision_submit', { requestId: input.requestId, topicId, revision: input.revision, decision: {
        basisMessageIds: ids, basisUnitRefs, actions: [{ kind: 'task-context', taskId: task.taskId, inputVersion: task.requirementRevision, runSequence: task.runSequence,
          context: texts.join('\n'), progressImpact: 'preserve', authorizationChange: 'none', basisUnitRefs, topicRefs: [{ topicId, revision: input.revision }] }],
        reply: '补充已并入原事项。', replyToMessageId: ids.at(-1), replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    }
    assert.ok(names.includes('task_session_submit'), 'no execution or routing is created by recovery')
    return [call('task_session_submit', { decision: { action: 'wait', summary: '保留补充，等待原业务继续', evidence: [], limitations: [] } })]
  }, { serviceFactory: async options => {
    store = await openDynamicTaskStore({ ...options.config, initialize: true })
    const resident = options.residentStore
    await resident.ingest({ groupId: 'native-group', messageId: 'original-request', text: '核对审核历史', senderOpenDingTalkId: 'native-user', occurredAt: '2026-01-01T00:00:00Z' })
    topicId = (await resident.routeMessages({ groupId: 'native-group', routeId: 'original-route', routingRevision: 0,
      routes: [{ messageId: 'original-request', messageVersion: 1, topics: [{ newTopicKey: 'history', title: '审核历史' }] }] })).topicIdsByKey.history
    await resident.acceptTopicDecision({ groupId: 'native-group', topicId, revision: 1, decisionId: 'original-decision', decision: { actions: [], basisMessageIds: ['original-request'], reason: '原业务' } })
    await resident.completeTopicDecision({ groupId: 'native-group', topicId, decisionId: 'original-decision' })
    await command('source.record', { sourceId: 'original-source', groupId: 'native-group', messageId: 'original-request', actorId: 'native-user', text: '核对审核历史', channel: 'im' })
    await command('task.create', { taskId: 'original-task', groupId: 'native-group', ownerActorId: 'native-user', title: '审核历史', request: '核对审核历史', topicRefs: [{ topicId, revision: 1 }], sourceRefs: ['original-source'] })
    await command('task.control', { taskId: 'original-task', control: 'cancelled', expectedControlRevision: 1 })
    return openTaskSessionService({ ...options, store })
  } })
  t.after(async () => { await h.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  for (const [index, text] of texts.entries()) {
    await h.residentStore.ingest({ groupId: 'native-group', messageId: ids[index], text, senderOpenDingTalkId: 'native-user', occurredAt: `2026-01-01T00:00:0${index + 1}Z` })
    await command('source.record', { sourceId: 'source-' + index, groupId: 'native-group', messageId: ids[index], actorId: 'native-user', text, channel: 'im' })
  }
  await h.residentStore.routeMessages({ groupId: 'native-group', routeId: 'supplements', routingRevision: h.residentStore.getGroup('native-group').routingRevision,
    routes: ids.map(messageId => ({ messageId, messageVersion: 1, topics: [{ topicId }] })) })
  const topic = h.residentStore.getTopic('native-group', topicId), before = await h.query('task.get', { taskId: 'original-task' })
  const action = { kind: 'task-context', taskId: before.taskId, inputVersion: before.requirementRevision, runSequence: before.runSequence, context: texts.join('\n'), progressImpact: 'preserve', authorizationChange: 'none', topicRefs: [{ topicId, revision: topic.revision }] }
  const old = await h.residentStore.acceptTopicDecision({ groupId: 'native-group', topicId, revision: topic.revision, decisionId: 'blocked-batch',
    expectedTaskVersions: [{ taskId: before.taskId, inputVersion: before.requirementRevision, runSequence: before.runSequence }], decision: { basisMessageIds: ids, actions: [action] } })
  assert.equal(old.status, 'accepted')
  await h.residentStore.updateTopicDecision({ groupId: 'native-group', topicId, decisionId: old.record.decisionId,
    patch: { status: 'blocked', attempt: 1, error: 'DYNAMIC_TASK_NOT_ACTIVE', failureOperationId: old.record.operations[0].operationId,
      operations: old.record.operations.map(operation => ({ ...operation, status: 'blocked', lastError: 'DYNAMIC_TASK_NOT_ACTIVE' })) } })
  const failedPage = await h.service.observerGroupPage('native-group', { filter: 'failed', limit: 10 })
  assert.equal(failedPage.total, 5); assert.ok(failedPage.items.every(message => message.processingFailureCode === 'DYNAMIC_TASK_NOT_ACTIVE'))
  const args = { taskId: before.taskId, requestId: 'resume-original', context: '恢复原任务，保留全部补充要求', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision }
  await h.service.reopenTask(args); await h.service.whenIdle()
  await waitUntil(() => { const topic=h.residentStore.getTopic('native-group',topicId);return topic.processedRevision===topic.revision }, 'all original supplements applied')
  await h.service.whenIdle()
  assert.equal(reviewed.length, 1, JSON.stringify({ alerts: h.service.listAlerts(), results: h.toolResults.slice(-1) }))
  const current = await h.query('task.get', { taskId: before.taskId }), completed = h.residentStore.getTopic('native-group', topicId)
  assert.equal(completed.decisions.find(record => record.decisionId === old.record.decisionId).status, 'rejected')
  assert.deepEqual(completed.decisions.find(record => record.decisionId === old.record.decisionId).decision, old.record.decision)
  assert.equal(completed.processedRevision, completed.revision, JSON.stringify({ decisions: completed.decisions.map(({status,error,operations})=>({status,error,operations})), alerts:h.service.listAlerts() }))
  assert.ok(current.request.includes(texts.join('\n')))
  assert.equal(current.requirementRevision, 2, 'context supplement preserves the reopened goal and revision')
  assert.equal((await h.query('task.list')).length, 1); assert.equal((await h.query('execution.list')).length, 0)
  assert.equal(await h.query('receipt.get', { id: 'topic-operation:' + old.record.operations[0].operationId }), null)
  assert.equal(h.sent.length, 1)
  await h.service.reopenTask(args); await h.service.whenIdle(); assert.equal(reviewed.length, 1); assert.equal(h.sent.length, 1)
})

test('web acceptance reuses existing topic and captures exact enriched source version with real image execution material', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-topic-reuse-')), image = Buffer.from('actual-image-bytes')
  const resource = { type: 'mediaId', resourceId: 'real-image-id', download: { ready: true } }
  let originalTopic, taskRead = false, delegated = false
  const h = await nativeTaskHost(root, async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [originalTopic ? { topicId: originalTopic } : { newTopicKey: 'layout', title: '描述框位置' }] })) })]
    if (names.includes('group_decision_submit') && originalTopic) return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '仅补充原图，等待明确交办' } })]
    if (names.includes('group_decision_submit')) return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [{ kind: 'task-proposal', title: '描述框位置', objective: '右侧顶部对齐', topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '这个事项是否需要我处理？', replyToMessageId: input.messages.at(-1).messageId, replyReview: { kind: 'confirmation', reviewedOutboundIds: host.sent.map(item => item.id), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
    if (names.includes('task_delegate')) {
      if (!delegated) { delegated = true; return [call('task_delegate', { key: 'inspect-original', objective: '核对原图和授权' })] }
      return [call('task_session_submit', { decision: { action: 'wait', summary: '原图已核对，等待继续', evidence: [], limitations: [] } })]
    }
    assert.ok(names.includes('execution_submit'))
    assert.equal(input.sources.length, 2)
    assert.equal(input.materialPaths.length, 2)
    const snapshots = await Promise.all(input.materialPaths.map(path => readFile(path, 'utf8').then(JSON.parse)))
    const original = snapshots.find(item => item.messageId === 'original-layout')
    assert.equal(original.version, 2)
    assert.equal(original.resources[0].status, 'read')
    assert.ok((await readFile(original.resources[0].path)).equals(image))
    return [call('execution_submit', { output: { status: 'completed', summary: '核对真实原图', evidence: ['原图字节已读取'], limitations: [], artifacts: [] } })]
  }, { serviceFactory: options => openTaskSessionService({ ...options, readResource: async () => taskRead ? ({ image: { data: image, mediaType: 'image/png' } }) : ({ text: 'resource metadata only', complete: true }) }) })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  const message = { groupId: 'native-group', messageId: 'original-layout', senderOpenDingTalkId: 'native-user', senderName: '真实用户', occurredAt: '2026-10-13T10:00:00Z', text: '描述框放在文字右侧顶部对齐', resourceRefs: [resource] }
  await h.service.ingest(message); await h.service.whenIdle()
  originalTopic = h.residentStore.listTopics('native-group')[0].topicId
  await h.residentStore.ingest({ ...message, imageRefs: [{ attachmentId: 'saved-original-image', mediaType: 'image/png' }] })
  await h.service.retryMessage({ groupId: message.groupId, messageId: message.messageId }); await h.service.whenIdle()
  assert.equal((await h.query('source.list')).length, 1, 'Proposal itself must not create a task source revision')
  const topic = h.residentStore.getTopic('native-group', originalTopic), oldRevision = topic.revision
  const args = { requestId: 'accept-original-layout', groupId: 'native-group', title: '描述框位置', objective: '按原图右侧顶部对齐', context: '用户本轮明确授权：触发', topicRefs: [{ topicId: originalTopic, revision: oldRevision }] }
  taskRead = true
  const created = await h.service.createTask(args); await h.service.whenIdle()
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  const task = await h.query('task.get', { taskId: created.taskId })
  assert.equal(task.sourceRefs.length, 2)
  const sources = await Promise.all(task.sourceRefs.map(sourceId => h.query('source.get', { sourceId })))
  const original = sources.find(item => item.messageId === message.messageId)
  assert.equal(original.version, 2)
  assert.deepEqual(original.resources, [resource])
  assert.ok(original.admissionSourceId)
  assert.equal(sources.find(item => item.sourceId === task.metadata.authorizationSourceId).channel, 'web')
  assert.equal((await h.query('execution.list', { taskId: task.taskId })).length, 1)
  assert.equal((await h.service.createTask(args)).taskId, task.taskId)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.equal((await h.query('task.list')).length, 1)
  await assert.rejects(h.service.createTask({ ...args, requestId: 'stale-accept' }), error => error.code === 'TASK_TOPIC_WEB_topic-stale')
  const beforeContext=await h.query('task.get',{taskId:task.taskId})
  const contextArgs={taskId:task.taskId,requestId:'continue-existing-topic',progressImpact:'replan',context:'只补充原事项验收要求，保持同一任务',expectedRequirementRevision:beforeContext.requirementRevision,expectedControlRevision:beforeContext.controlRevision}
  await h.service.appendTaskContext(contextArgs);await h.service.whenIdle()
  assert.equal(h.residentStore.listTopics('native-group').length,1,'Web补充不另开话题')
  const afterContext=await h.query('task.get',{taskId:task.taskId})
  assert.equal(afterContext.requirementRevision,beforeContext.requirementRevision+1)
  assert.equal(h.residentStore.getTopic('native-group',originalTopic).revision,oldRevision+2)
  const webMessages=(await h.residentStore.getTopicContext({groupId:'native-group',topicId:originalTopic,revision:oldRevision+2,offset:0,limit:100})).messages.filter(item=>item.sourceKind==='web')
  assert.equal(webMessages.length,2,'原授权与后续补充都可追溯')
  await h.service.appendTaskContext(contextArgs);await h.service.whenIdle()
  assert.equal((await h.query('task.get',{taskId:task.taskId})).requirementRevision,afterContext.requirementRevision)
  assert.equal(h.residentStore.listTopics('native-group').length,1)

})
