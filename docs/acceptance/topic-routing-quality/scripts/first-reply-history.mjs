import { readFile } from 'node:fs/promises'

const sequences = [773, 774, 778, 780, 783]

function topicEnvelope(event) {
  for (const part of event.data?.content ?? []) {
    const text = part.text ?? ''
    const marker = 'Topic 请求：'
    const index = text.indexOf(marker)
    const candidates = index < 0 ? [text] : [text.slice(index + marker.length).split('\n')[0]]
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate)
        if (typeof value.requestId === 'string') return value
      } catch {}
    }
  }
}

function requestSegment(events, requestId) {
  const envelopes = events.map(event => event.type === 'user/message' ? topicEnvelope(event) : undefined)
  const positions = envelopes.flatMap((envelope, index) => envelope?.requestId === requestId ? [index] : [])
  if (positions.length !== 1) throw new Error('historical_request_not_unique')
  const start = positions[0]
  const next = envelopes.findIndex((envelope, index) => index > start && envelope && envelope.requestId !== requestId)
  return { envelope: envelopes[start], events: events.slice(start, next < 0 ? events.length : next) }
}

export async function readHistoricalFirstReply({ residentPath, decisionSessionPath, routeSessionPath, relatedDecisionSessionPath, sequence }) {
  if (!sequences.includes(sequence)) throw new Error('unsupported_sequence')
  const resident = JSON.parse(await readFile(residentPath, 'utf8'))
  const groups = Object.values(resident.tables.groups).filter(group => sequences.every(n => group.messages.some(message => message.sequence === n)))
  if (groups.length !== 1) throw new Error('historical_group_not_unique')
  const group = groups[0]
  const message = group.messages.find(item => item.sequence === sequence)
  const matches = group.topics.flatMap(topic => topic.decisions.filter(record => record.decision?.basisMessageIds?.includes(message.messageId)).map(record => ({ topic, record })))
  if (matches.length !== 1) throw new Error('historical_decision_not_unique')
  const { topic, record } = matches[0]
  const routes = group.routeHistory.filter(item => JSON.stringify(item).includes(message.messageId))
  if (routes.length !== 1) throw new Error('historical_route_not_unique')
  const decisionEvents = (await readFile(decisionSessionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const routeEvents = (await readFile(routeSessionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const toolResults = events => events.filter(event => event.type === 'tool/result').flatMap(event => (event.data?.message?.content ?? []).flatMap(part => {
    try { return [JSON.parse(part.text)] } catch { return [] }
  }))
  const decision = requestSegment(decisionEvents, record.decisionId)
  const route = requestSegment(routeEvents, routes[0].routeId)
  if (decision.envelope.topicId !== topic.topicId || decision.envelope.revision !== record.revision) throw new Error('historical_decision_mismatch')
  const envelope = decision.envelope, results = toolResults(decision.events)
  const review = results.find(result => result.replyReview)?.replyReview
  if (!review) throw new Error('historical_reply_review_missing')
  const outbox = review.candidates.map(candidate => {
    const matches = group.outbox.filter(item => item.outboundId === candidate.outboundId)
    if (matches.length !== 1) throw new Error('historical_outbox_not_unique')
    const item = matches[0]
    const text = String(item.text ?? '').trim()
    const projected = text.length <= 360 ? text : `${text.slice(0, 360)}…`
    if (candidate.reply !== projected || candidate.status !== item.status || candidate.sourceMessageId !== item.sourceMessageId || candidate.deliveredMessageId !== item.deliveredMessageId || JSON.stringify(candidate.topicRefs) !== JSON.stringify(item.topicRefs) || JSON.stringify(candidate.taskIds) !== JSON.stringify(item.taskIds)) throw new Error('historical_outbox_changed')
    return item
  })
  const assistantStreams = events => events.filter(event => event.type === 'assistant/message').map(event => {
    const { usage, stream } = event.data
    if (!Array.isArray(stream)) throw new Error('historical_stream_missing')
    for (const chunk of stream) if (chunk.type === 'tool-call-chunks' && (!Array.isArray(chunk.dt) || !Array.isArray(chunk.args) || chunk.args.length !== chunk.dt.length + 1)) throw new Error('historical_stream_invalid')
    return { usage, stream }
  })
  let relatedDecision
  if (relatedDecisionSessionPath) {
    const visible = new Set([...route.envelope.topics, ...route.envelope.relatedTopics, ...route.envelope.recalledTopics].map(item => item.topicId))
    const missing = new Set(outbox.flatMap(item => (item.topicRefs ?? []).filter(ref => !visible.has(ref.topicId)).map(ref => ref.topicId)))
    if (missing.size !== 1) throw new Error('historical_related_topic_not_unique')
    const relatedTopic = group.topics.find(item => missing.has(item.topicId))
    const revision = Math.max(...outbox.flatMap(item => (item.topicRefs ?? []).filter(ref => missing.has(ref.topicId)).map(ref => ref.revision)))
    const relatedRecords = relatedTopic?.decisions.filter(item => item.revision === revision && item.status === 'completed') ?? []
    if (relatedRecords.length !== 1) throw new Error('historical_related_decision_not_unique')
    const relatedRecord = relatedRecords[0]
    if (!Number.isFinite(Date.parse(relatedRecord.completedAt)) || Date.parse(relatedRecord.completedAt) > Date.parse(message.occurredAt)) throw new Error('historical_related_decision_missing')
    const events = (await readFile(relatedDecisionSessionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const related = requestSegment(events, relatedRecord.decisionId)
    if (related.envelope.topicId !== relatedTopic.topicId || related.envelope.revision !== revision) throw new Error('historical_related_decision_mismatch')
    relatedDecision = { topic: relatedTopic, record: relatedRecord, envelope: related.envelope }
  }
  return { message, currentGroup: group, currentTopic: topic, currentDecision: record, envelope, results, assistantStreams: assistantStreams(decision.events), currentOutbox: outbox, relatedDecision, route: { routingRevision: routes[0].routingRevision, envelope: route.envelope, results: toolResults(route.events), assistantStreams: assistantStreams(route.events) } }
}
