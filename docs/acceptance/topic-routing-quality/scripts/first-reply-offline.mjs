import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readHistoricalFirstReply } from './first-reply-history.mjs'
import { boundedFirstReplyFixture, boundedBenchmarkFirstReplyFixture, readBoundedHistoricalSources, seedBoundedStores } from './first-reply-bounded.mjs'
import { installEvaluationIsolation, installBoundedTopicGuard, isolatedEffects } from './first-reply-isolation.mjs'

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
  const at = arg.indexOf('=')
  return [arg.slice(2, at), arg.slice(at + 1)]
}))
for (const name of ['source', 'resident', 'decision-session', 'route-session']) if (!args[name]) throw new Error(`missing_${name}`)
const source = resolve(args.source)
const sequence = Number(args.sequence ?? 773)
if (![773, 774, 778, 780, 783].includes(sequence)) throw new Error('unsupported_sequence')
for (const path of [source, args.resident, args['decision-session'], args['route-session'], ...(args['related-decision-session'] ? [args['related-decision-session']] : [])]) await access(path)
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ check: 'ok', sequence, modelCalls: 0, sideEffects: false }))
} else {
  const load = path => import(pathToFileURL(join(source, path)).href)
  const native = await load('test/fixtures/task-session-native-host.js')
  const { residentDomainSpec, openResidentStore } = await load('packages/dingtalk-dsh-assistant/store.js')
  const { openDynamicTaskStore } = await load('packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const { openTaskSessionService } = await load('packages/dingtalk-dsh-assistant/task-session-service.js')
  const snapshot = await readHistoricalFirstReply({ residentPath: args.resident, decisionSessionPath: args['decision-session'], routeSessionPath: args['route-session'], relatedDecisionSessionPath: args['related-decision-session'], sequence })
  const fixture = (process.argv.includes('--benchmark-related-active') ? boundedBenchmarkFirstReplyFixture : boundedFirstReplyFixture)(snapshot)
  if (sequence === 774 && !args['source-db']) throw new Error('source_db_required')
  const historicalSources = sequence === 774 ? readBoundedHistoricalSources(args['source-db'], fixture) : []
  if (sequence === 774) Object.assign(fixture.scope, { resourceMetadataProjected: true, contentNotReconstructed: true })
  const root = await mkdtemp(join(tmpdir(), 'first-reply-bounded-'))
  const effects = isolatedEffects()
  let host
  try {
    host = await native.nativeTaskHost(root, async request => {
      const input = native.latestInput(request)
      if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [], units: [{ unitKey: 'bounded-input', summary: '原事项状态询问', sourceRefs: [{ quote: message.text }], topics: [{ topicId: fixture.targetTopicId, relationship: 'continuation', reason: '隔离场景指定同一历史话题' }] }] })) } }]
      const values = native.modelToolValues(request)
      const review = input.inlineDecisionContext?.replyReview ?? values.findLast(value => Array.isArray(value.candidates) && value.requestIds)
      if (!review && input.replyReviewCandidateCount > 0) return [{ name: 'group_reply_review_get', args: { requestIds: [input.requestId] } }]
      const refs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
      const target = input.messages.findLast(item => item.senderOpenDingTalkId)
      const actions = sequence === 774 ? [{ kind: 'task-reopen', taskId: fixture.tasks[0].taskId, inputVersion: fixture.tasks[0].requirementRevision, runSequence: fixture.tasks[0].runSequence, context: fixture.input.text, topicRefs: [{ topicId: input.topicId, revision: input.revision }], basisUnitRefs: refs }] : []
      return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: { basisMessageIds: [...new Set(input.messages.map(item => item.messageId))], basisUnitRefs: refs, actions, reply: '已收到，沿原任务处理。', ...(target ? { replyToMessageId: target.messageId, atOpenDingTalkIds: [target.senderOpenDingTalkId] } : { atOpenDingTalkIds: [] }), replyReview: { kind: 'substantive', reviewedOutboundIds: (review?.candidates ?? []).map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } } } }]
    }, { resident: true, ...(args.profile ? { nativeProfile: native.loadNativeTestProfile(args.profile) } : {}) })
    installEvaluationIsolation(host.ctx)
    installBoundedTopicGuard(host.ctx, { groupId: fixture.group.groupId, targetTopicId: fixture.targetTopicId })
    const seeded = await seedBoundedStores({ storageDomain: host.ctx.storageDomain, root, fixture, residentDomainSpec, openResidentStore, openDynamicTaskStore, historicalSources })
    host.residentStore = seeded.residentStore
    const legacy = { getAgentConfig: () => ({ workspaceDir: root, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', agentNames: ['测试助手'] }), getGroup: id => host.residentStore.getGroup(id) }
    host.service = await openTaskSessionService({ ctx: host.ctx, legacy, residentStore: host.residentStore, taskSessions: effects.taskSessions, notifications: effects.notificationAdapter, config: { ...seeded.config, initialize: false, workspaceDir: root, provider: 'native-task-test', ownerActorId: fixture.tasks[0].ownerActorId, webActorId: fixture.tasks[0].ownerActorId } })
    await host.service.ingest(fixture.input)
    try {
      await native.waitUntil(async () => {
        const last = host.toolResults.at(-1)
        if (last?.result?.content?.some(content => { try { return JSON.parse(content.text).status === 'invalid-arguments' } catch { return false } })) throw new Error('bounded_script_invalid_arguments')
        const sources = await host.service.store.query({ kind: 'source.list' })
        const group = host.residentStore.getGroup(fixture.group.groupId)
        if (group.messages.some(item => item.messageId === fixture.input.messageId && item.agentDeliveryStatus === 'decision-failed')) throw new Error('bounded_decision_failed')
        return sources.some(item => item.messageId === fixture.input.messageId && item.processingCompleted) && group.outbox.some(item => item.status === 'sent' && item.deliveredMessageId?.startsWith('isolated-notification-') && item.deliveredAt)
      }, '有界首例来源和隔离回执', 20000)
    } catch (error) {
      const sources = await host.service.store.query({ kind: 'source.list' })
      const group = host.residentStore.getGroup(fixture.group.groupId)
      console.error(JSON.stringify({ source: sources.filter(item => item.messageId === fixture.input.messageId).map(item => ({ status: item.status, processingCompleted: item.processingCompleted })), requests: host.requests.length, message: group.messages.filter(item => item.messageId === fixture.input.messageId).map(item => ({ routingStatus: item.routingStatus, agentDeliveryStatus: item.agentDeliveryStatus, error: item.agentDeliveryError?.split(':')[0] })), tools: host.toolResults.slice(-3).map(item => ({ name: item.name, isError: item.result?.isError, result: (item.result?.content ?? []).map(content => { try { const value = JSON.parse(content.text); return { status: value.status, code: value.code, error: value.error?.code, issues: value.issues?.map(issue => ({ code: issue.code, field: issue.field })) } } catch { return {} } }) })), decisions: group.topics.flatMap(topic => topic.decisions).map(item => item.status), sends: effects.notifications.length, readbacks: effects.readbacks.length, ownerAttempts: effects.ownerAttempts.length, emptyCancels: effects.emptyCancels.length }))
      throw error
    }
    const group = host.residentStore.getGroup(fixture.group.groupId)
    const decisions = group.topics.flatMap(topic => topic.decisions).filter(item => item.decision.basisMessageIds?.includes(fixture.input.messageId))
    const record = decisions[0], operation = record?.operations?.[0]
    const receipt = operation && await host.service.store.query({ kind: 'receipt.get', id: `topic-operation:${operation.operationId}` })
    const task = sequence === 774 && await host.service.store.query({ kind: 'task.get', taskId: fixture.tasks[0].taskId })
    const requests = host.requests
    await host.close()
    host = undefined
    const requestSummary = requests.map(request => {
      const input = native.latestInput(request)
      return { route: request.tools.some(tool => tool.name === 'group_topic_route_submit'), decision: request.tools.some(tool => tool.name === 'group_decision_submit'), inputMessageCount: input.messages?.length ?? 0, includesCurrent: input.messages?.some(item => item.messageId === fixture.input.messageId) ?? false }
    })
    const terminalValid = decisions.length === 1 && record.status === 'completed' && (sequence === 774 ? record.decision.actions.length === 1 && operation?.status === 'applied' && operation.taskId === fixture.tasks[0].taskId && !!receipt && task?.requirementRevision === fixture.tasks[0].requirementRevision + 1 : record.decision.actions.length === 0) && (sequence === 774 || !effects.ownerAttempts.length) && requestSummary.every(item => (item.route || item.decision) && item.inputMessageCount === 1 && item.includesCurrent) && !!effects.notifications.length && !!effects.readbacks.length
    const blob = async name => { const bytes = await readFile(new URL(name, import.meta.url)); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }
    const scripts = Object.fromEntries(await Promise.all(['first-reply-bounded.mjs', 'first-reply-isolation.mjs', 'first-reply-offline.mjs'].map(async name => [name, await blob(name)])))
    const summary = { terminalValid, scripts, sequence, mode: 'offline', scope: fixture.scope, decisionStatus: record.status, actions: record.decision.actions.length, operationStatus: operation?.status, receiptPresent: !!receipt, initialRevision: fixture.tasks[0].requirementRevision, finalRevision: task?.requirementRevision, historicalSourceCount: historicalSources.length, resourceSourceCount: historicalSources.filter(source => source.resources?.length).length, missingTimestampCount: historicalSources.filter(source => !source.timestamp).length, requestSummary, isolatedSends: effects.notifications.length, isolatedReadbacks: effects.readbacks.length, ownerRunAttempts: effects.ownerAttempts.length, ownerRunDenied: effects.ownerAttempts.length, actualOwnerExecutions: 0, emptyCancels: effects.emptyCancels.length, modelQuality: 'not-measured' }
    if (args.result) {
      if (!/^[a-zA-Z0-9._-]+\.json$/.test(args.result)) throw new Error('invalid_result_filename')
      await writeFile(new URL(`../../../tmp/semantic-latency/${args.result}`, import.meta.url), JSON.stringify(summary, null, 2), { flag: 'wx' })
    }
    console.log(JSON.stringify(summary))
    if (!terminalValid) throw new Error('bounded_terminal_mismatch')
  } finally {
    try {
      await host?.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
