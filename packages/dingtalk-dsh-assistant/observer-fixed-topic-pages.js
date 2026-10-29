import { ObserverMemoryPages } from './observer-memory-pages.js'
import { FIXED_TOPICS, fixedUnitRequestId } from './fixed-topics.js'

// Resident storage already owns the group records in memory. Build only membership
// metadata at startup/after a committed write, never by scanning messages in a GET.
// Bodies and replies are projected only after the requested page has been selected.
export function createFixedTopicPages(readGroup) {
  const pages = new ObserverMemoryPages(), groups = new Map()
  const key = (groupId, topicId) => JSON.stringify([groupId ?? null, topicId])
  const refresh = groupId => {
    for (const { topicId } of FIXED_TOPICS) {
      const own = groups.get(groupId)?.rows.filter(row => row.topicId === topicId) ?? []
      pages.replace(key(groupId, topicId), {}, own)
      pages.replace(key(undefined, topicId), {}, [...groups.values()].flatMap(group => group.rows.filter(row => row.topicId === topicId)))
    }
  }
  refresh(undefined)
  return {
    update(group) {
      const prior = groups.get(group.groupId)
      if (prior?.messages === group.messages && prior?.outbox === group.outbox && prior?.name === group.name) return
      const messagesChanged = prior?.messages !== group.messages
      const rows = messagesChanged ? [] : prior.rows, lookup = messagesChanged ? new Map() : prior.lookup
      for (let messageIndex = 0; messagesChanged && messageIndex < group.messages.length; messageIndex++) {
        const message = group.messages[messageIndex]
        for (let unitIndex = 0; unitIndex < (message.units?.length ?? 0); unitIndex++) {
          const unit = message.units[unitIndex]
          if (!FIXED_TOPICS.some(topic => topic.topicId === unit.fixedTopic)) continue
          const id = JSON.stringify([group.groupId, message.messageId, unit.unitId, unit.unitRevision])
          const row = { id, topicId: unit.fixedTopic, sort: `${String(new Date(message.occurredAt).getTime() || 0).padStart(17, '0')}:${String(message.sequence).padStart(17, '0')}` }
          rows.push(row); lookup.set(id, { messageIndex, unitIndex })
        }
      }
      const replies = new Map(), repliesByUnit = new Map()
      for (const [index, reply] of group.outbox.entries()) {
        if (!reply.outboundId.startsWith('fixed-topic-')) continue
        replies.set(reply.outboundId, index)
        for (const messageId of reply.matterSourceMessageIds ?? []) for (const ref of reply.matterUnitRefs ?? [])
          repliesByUnit.set(JSON.stringify([messageId, ref.unitId, ref.unitRevision]), index)
      }
      groups.set(group.groupId, { messages: group.messages, outbox: group.outbox, name: group.name, rows, lookup, replies, repliesByUnit })
      refresh(group.groupId)
    },
    remove(groupId) { groups.delete(groupId); refresh(groupId) },
    async page({ topicId, groupId, ...options }) {
      const topic = FIXED_TOPICS.find(item => item.topicId === topicId)
      if (!topic) return null
      if (groupId && !groups.has(groupId)) throw new Error('group_not_subscribed')
      const result = await pages.page(key(groupId, topicId), options, id => {
        const [sourceGroupId] = JSON.parse(id), index = groups.get(sourceGroupId)
        const group = readGroup(sourceGroupId), ref = index.lookup.get(id)
        const message = group.messages[ref.messageIndex], unit = message.units[ref.unitIndex]
        const active = message.activeUnitRefs?.some(item => item.unitId === unit.unitId && item.unitRevision === unit.unitRevision) === true
        // Enriching the message version can retain a handled unit. Its already
        // prepared reply still belongs to the explicit message/unit revision.
        const replyIndex = index.replies.get(fixedUnitRequestId(sourceGroupId, message, unit))
          ?? index.repliesByUnit.get(JSON.stringify([message.messageId, unit.unitId, unit.unitRevision]))
        const reply = replyIndex === undefined ? undefined : group.outbox[replyIndex]
        const failed = active && !unit.fixedTopicHandledAt && ['failed', 'decision-failed', 'decision-commit-failed'].includes(message.agentDeliveryStatus)
        return { id, groupId: sourceGroupId, groupName: group.name, messageId: message.messageId, messageVersion: message.messageVersion,
          senderName: message.senderName, occurredAt: message.occurredAt, text: message.text,
          unitId: unit.unitId, unitRevision: unit.unitRevision, summary: unit.summary,
          sourceText: unit.sourceRanges.map(range => range.quote).join('\n'),
          state: !active ? 'superseded' : unit.fixedTopicHandledAt ? reply ? 'replied' : 'silent' : failed ? 'failed' : 'pending',
          handledAt: unit.fixedTopicHandledAt, manualCorrection: unit.manualCorrection, error: !unit.fixedTopicHandledAt && active ? message.agentDeliveryError : undefined,
          reply: reply ? { outboundId: reply.outboundId, text: reply.text, status: reply.status, notificationState: reply.notificationState,
            deliveredAt: reply.deliveredAt, deliveredMessageId: reply.deliveredMessageId, deliveryPendingReason: reply.deliveryPendingReason,
            notificationFailurePhase: reply.notificationFailurePhase, notificationKnownNotSent: reply.notificationKnownNotSent,
            deliveryError: reply.deliveryError, deliveryBlockedAt: reply.deliveryBlockedAt } : undefined }
      })
      return { ...result, topic: { ...topic, fixed: true }, groupId: groupId ?? null }
    },
  }
}
