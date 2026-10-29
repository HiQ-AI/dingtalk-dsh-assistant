import { FIXED_TOPICS, manuallySettled } from './fixed-topics.js'
import {isPendingDecision,topicDecisionRecovery} from './topic-model.js'
const instant = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
const timing = (start, end) => {
  const duration = instant(end) - instant(start)
  return { quality: !Number.isFinite(duration) ? 'missing' : duration < 0 ? 'negative' : 'valid', durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null }
}

// 状态在拥有 Topic/来源账的后端判定，通知及业务 Task 完成不作语义完成门禁。
export function messageProcessingProjection(message, topics, source, requests, stateOnly=false) {
  const currentUnit = ref => !Array.isArray(message.activeUnitRefs) || message.activeUnitRefs.some(item => item.unitId === ref.unitId && item.unitRevision === ref.unitRevision)
  const related = topics.flatMap(topic => {
    const latest = new Map()
    for (const entry of topic.entries ?? []) if (entry.messageId === message.messageId) latest.set(entry.unitId ?? 'legacy', entry)
    return [...latest.values()].filter(entry => entry.action === 'add' && entry.messageVersion === message.messageVersion && currentUnit(entry)).map(entry => ({ topic, entry }))
  })
  const records = related.map(({ topic, entry }) => [...(topic.decisions ?? [])]
    .filter(record => record.status === 'completed' && record.revision >= entry.revision)
    .sort((a, b) => a.revision - b.revision)[0])
  const topicPending = related.some(({ topic, entry }, i) => !(topic.processedRevision >= entry.revision) || !records[i])
  const reasons = [...new Set((message.ignoredRanges ?? []).map(range => range.reason).filter(reason => typeof reason === 'string' && reason.trim()))]
  const refsKey = refs => refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision])).sort()
  const sourceDone = !!source?.processingCompleted && (!Array.isArray(message.activeUnitRefs)
    || Array.isArray(source.processingCompleted.activeUnitRefs)
      && JSON.stringify(refsKey(message.activeUnitRefs)) === JSON.stringify(refsKey(source.processingCompleted.activeUnitRefs)))
  const ignored = !related.length && reasons.length > 0 && message.agentDeliveryStatus === 'delivered'
  const coordination = (source?.coordination ?? []).filter(item => currentUnit(item)
    && message.units?.some(unit => unit.unitId === item.unitId && unit.unitRevision === item.unitRevision && unit.dispatchOwner === 'coordination'))
  const needsClarification = coordination.some(item => item.semanticState === 'needs_clarification')
  const unitsPending = message.activeUnitRefs?.some(ref => {
    const unit = message.units?.find(item => item.unitId === ref.unitId && item.unitRevision === ref.unitRevision)
    return !unit || unit.fixedTopic && !unit.fixedTopicHandledAt || unit.dispatchOwner === 'coordination' && !sourceDone
      && !coordination.some(item => item.unitId === ref.unitId && item.unitRevision === ref.unitRevision && item.semanticState === 'needs_clarification')
  })
  const issues = [], recovery = []
  for (const item of coordination) if (item.contextRecoveryToken)
    recovery.push({ requestId: item.reservationId, token: item.contextRecoveryToken, phase: 'coordination-context' })
  const issue = (phase, code, status, requestId, attempt, retryAt) => {
    if (!issues.some(item => item.phase === phase && item.requestId === requestId)) issues.push({ phase, code, status, requestId, attempt: attempt ?? 0, retryAt: retryAt ?? null })
  }
  // Only current, unfinished owners can fail a message; group delivery errors are not ownership evidence.
  for (const request of requests) {
    if (!['pending', 'exhausted'].includes(request.status) || !request.messages.some(item => item.messageId === message.messageId
      && item.messageVersion === message.messageVersion && (!request.topicId || currentUnit(item)))) continue
    if (request.topicId ? !related.some(({ topic, entry }, i) => topic.topicId === request.topicId && topic.revision === request.revision
      && (topic.processedRevision < entry.revision || !records[i])) : message.routingStatus === 'routed') continue
    const startup = request.failurePhase === 'startup'
    if (request.status === 'exhausted' && request.retryToken) recovery.push({ requestId: request.requestId, token: request.retryToken, phase: request.topicId ? 'decision' : 'routing' })
    if (request.status === 'exhausted' || request.nextRetryAt) issue(request.topicId ? 'decision' : 'routing',
      startup ? 'startup-recovery' : request.status === 'exhausted' ? request.failurePhase === 'dispatch' ? 'dispatch-failed' : 'protocol-exhausted' : 'protocol-retry',
      startup || request.status === 'pending' ? 'retrying' : 'failed', request.requestId, request.attempt, request.nextRetryAt)
  }
  for (const { topic, entry } of related) {
    if (topic.processedRevision >= entry.revision) continue
    const record = topic.decisions?.findLast(isPendingDecision)
    if (!record || record.revision < entry.revision || record.revision > topic.revision
      || record.decision?.basisUnitRefs?.length && !record.decision.basisUnitRefs.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision)) continue
    const hostRecovery = topicDecisionRecovery(record)
    if (hostRecovery && record.revision === topic.revision) recovery.push({ requestId: record.decisionId, token: hostRecovery.token, phase: 'host' })
    if (record.status === 'blocked' || record.status === 'failed') issue('host', record.status === 'blocked' ? 'decision-blocked' : 'decision-retry',
      record.status === 'blocked' ? 'failed' : 'retrying', record.decisionId, record.attempt, record.nextRetryAt)
  }
  if (!sourceDone) for (const item of source?.coordination ?? []) {
    if (!currentUnit(item) || !message.units?.some(unit => unit.unitId === item.unitId && unit.unitRevision === item.unitRevision && unit.dispatchOwner === 'coordination')
      || item.state !== 'reserved' || item.resolved || item.frozen || !(item.attempt > 0)) continue
    const exhausted = item.attempt >= 3 && !item.nextRetryAt
    if (exhausted && item.retryToken) recovery.push({ requestId: item.reservationId, token: item.retryToken, phase: 'coordination' })
    issue('coordination', exhausted ? 'coordination-exhausted' : 'coordination-retry', exhausted ? 'failed' : 'retrying', item.reservationId, item.attempt, item.nextRetryAt)
  }
  if (message.routingStatus === 'failed' && !issues.some(item => item.phase === 'routing')) issue('routing', 'routing-failed', 'failed', null, 0, null)
  let state = 'unknown', basis = 'unknown', completedAt = null, conclusion = null
  const semanticCompletionTime = () => {
    const decisionTimes = records.map(record => instant(record?.completedAt))
    if (sourceDone) {
      const at = instant(source.processingCompleted.at)
      // 来源戳在所有当前事项判断后落一次；若早于明确决策终态则证据矛盾，不拼出数字。
      return Number.isFinite(at) && !decisionTimes.some(time => Number.isFinite(time) && time > at) ? new Date(at).toISOString() : null
    }
    // 当前来源尚未落精确终态时不能先报旧Topic时钟，再因迟到的来源戳改变历时。
    if (source) return null
    return records.length ? decisionTimes.every(Number.isFinite) ? new Date(Math.max(...decisionTimes)).toISOString() : null : message.agentDeliveryAt ?? null
  }
  if (manuallySettled(message)) {
    state = 'processed'; basis = 'manual-fixed-topic-correction'; completedAt = message.agentDeliveryAt
    conclusion = message.units.find(unit => unit.unitId === message.activeUnitRefs[0].unitId && unit.unitRevision === message.activeUnitRefs[0].unitRevision).manualCorrection.reason
  }
  else if (issues.some(item => item.status === 'failed')) state = 'failed'
  else if (message.routingStatus !== 'routed') state = 'routing'
  else if (topicPending || unitsPending) state = 'processing'
  else if (needsClarification) state = 'needs_clarification'
  else if (sourceDone || related.length || ignored) {
    state = 'processed'
    basis = sourceDone ? 'source-semantic' : related.length ? 'topic-decision' : 'ignored-delivered'
    completedAt = semanticCompletionTime()
  } else if (source && source.routed !== true || related.length || reasons.length) state = 'processing'
  if (state === 'needs_clarification' && sourceDone) {
    basis = 'source-semantic'
    completedAt = semanticCompletionTime()
  }
  if(stateOnly)return {processingState:state}
  conclusion = [...new Set([conclusion, ...(topicPending ? [] : records.map(record => record?.decision?.reason ?? record?.decision?.reply)),
    ...coordination.map(item => item.conclusion), ...(['processed', 'needs_clarification'].includes(state) ? reasons : [])]
    .filter(text => typeof text === 'string' && text.trim()))].join('；') || null
  const notices = source?.notifications ?? []
  const noticeTimes = notices.map(notice => notice.deliveredAt)
  const deliveredAt = notices.length && notices.every(notice => notice.versionMatched === true && notice.state === 'delivered') && noticeTimes.every(time => Number.isFinite(instant(time)))
    ? new Date(Math.max(...noticeTimes.map(instant))).toISOString() : null
  return { processingState: state, processingBasis: basis, processingConclusion: conclusion,
    processingSentAt: message.occurredAt ?? null, processingCompletedAt: completedAt,
    processingFacts: {
      sourceId: source?.sourceId ?? null, messageVersion: message.messageVersion ?? null,
      sourceState: !source ? 'unknown' : source.routed === true ? 'settled' : 'unsettled', sourceSettledAt: source?.routedAt ?? null,
      receivedAt: source?.receivedAt ?? message.receivedAt ?? null,
      notificationState: !notices.length ? 'unknown' : deliveredAt ? 'delivered' : 'unconfirmed', notifications: notices,
      semantic: timing(message.occurredAt, completedAt),
      notificationE2e: timing(source?.receivedAt ?? message.receivedAt, deliveredAt),
      stages: source?.stages ?? [], issues, recovery,
      fixedTopics: FIXED_TOPICS.filter(topic => message.units?.some(unit => unit.fixedTopic === topic.topicId && currentUnit(unit))),
    } }
}
