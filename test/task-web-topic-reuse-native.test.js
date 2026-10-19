import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'
const call = (name, args) => ({ name, args })

test('web acceptance reuses existing topic and captures exact enriched source version with real image execution material', { timeout: 20000, ...(!available ? { skip: reason } : {}) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-topic-reuse-')), image = Buffer.from('actual-image-bytes')
  const resource = { type: 'mediaId', resourceId: 'real-image-id', download: { ready: true } }
  let originalTopic, taskRead = false, delegated = false
  const h = await nativeTaskHost(root, async (request, host) => {
    const names = request.tools.map(tool => tool.name), input = latestInput(request)
    if (names.includes('group_topic_route_submit')) return [call('group_topic_route_submit', { requestId: input.requestId, routes: input.messages.map(item => ({ messageId: item.messageId, messageVersion: item.messageVersion, topics: [originalTopic ? { topicId: originalTopic } : { newTopicKey: 'layout', title: '描述框位置' }] })) })]
    if (names.includes('group_decision_submit') && originalTopic) return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [], reason: '仅补充原图，等待明确交办' } })]
    if (names.includes('group_decision_submit')) return [call('group_decision_submit', { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: input.messages.map(item => item.messageId), actions: [{ kind: 'task-proposal', title: '描述框位置', objective: '右侧顶部对齐', topicRefs: [{ topicId: input.topicId, revision: input.revision }] }], reply: '这个事项是否需要我处理？', replyReview: { kind: 'confirmation', reviewedOutboundIds: host.sent.map(item => item.id), sameMatterOutboundIds: [], replaceOutboundIds: [] } } })]
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
