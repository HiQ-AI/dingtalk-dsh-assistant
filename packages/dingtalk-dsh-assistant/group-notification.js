import { z } from 'zod'
import { formatTaskGroupReply } from './group-reply-format.js'

// Shared by Topic decisions, task facts and platform replies. Source provenance
// is deliberately not a quote or a default notification recipient.
export const groupNotificationFields = {
  replyToMessageId: z.string().min(1).optional().describe('可选的受信引用消息；原生引用可能隐式通知作者。无法确认不会重复提及时省略引用，使用普通 Markdown 消息。'),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional().describe('按本次结果与上下文选择受信成员 ID，可多人。明确不提及时填空数组；不能按名字猜 ID 或默认选择最近发言人。'),
  atAll: z.boolean().optional().describe('只有本次通知明确面向全群时设 true；与指定成员提及、引用互斥。不以正文“@所有人”代替。'),
}
export const finalNotificationFields = { ...groupNotificationFields,
  replyToMessageId: groupNotificationFields.replyToMessageId.describe('可选的受信上下文来源。最终结果统一发送普通 Markdown，不将此字段作为原生引用或隐式通知对象。'),
}
export const groupNotificationInstructions = '通知对象依据当前事项、原需求与明确交付对象选择，可包括多个需求人、验收人或知会人；来源作者、最新发言人不自动成为接收人，也不自动加入所有历史参与者。填写 atOpenDingTalkIds 的受信身份；身份不确定不猜测，明确不提及时填空数组。本次通知明确面向全群时填写 atAll=true 并省略单人提及和引用，不能仅因发在群里就通知全群。引用可能隐式@作者；不能通知无关引用作者或重复@，无法确认时省略 replyToMessageId，使用普通 Markdown 与结构化提及。保留完整链接、段落和列表；正文不手写@姓名或@所有人。附件随本次最终说明连续交付，不另行裸发；署名由 Host 添加。'

export function groupNotificationRouting(messages, { replyToMessageId, atOpenDingTalkIds, atAll } = {}, { quote = true } = {}) {
  const participants = messages.filter(message => message.senderOpenDingTalkId && !['web', 'internal'].includes(message.sourceKind))
  const target = participants.find(message => message.messageId === replyToMessageId)
  if (replyToMessageId && !target) throw new Error('group_reply_target_not_in_topic')
  if (atAll !== undefined && typeof atAll !== 'boolean') throw new Error('group_reply_audience_invalid')
  if (atAll && (atOpenDingTalkIds?.length || quote && target)) throw new Error('group_reply_audience_conflict')
  const recipients = atAll ? [] : [...new Set(atOpenDingTalkIds ?? (quote && target ? [target.senderOpenDingTalkId] : []))]
  if (participants.length && !atAll && atOpenDingTalkIds === undefined && !(quote && target)) throw new Error('group_reply_routing_required')
  if (recipients.some(id => !participants.some(message => message.senderOpenDingTalkId === id))) throw new Error('group_reply_recipient_not_in_topic')
  if (quote && target && !recipients.includes(target.senderOpenDingTalkId)) throw new Error('group_reply_quote_author_not_in_recipients')
  return { target, recipients, ...(atAll ? { atAll: true } : {}) }
}
export const finalNotificationRouting = (messages, decision) => groupNotificationRouting(messages, decision, { quote: false })

/** Route is selected and validated against trusted context by the caller. */
export function prepareGroupNotification({ groupId, text, replyToMessageId, replyToSenderOpenDingTalkId, sourceText,
  atOpenDingTalkIds = [], atAll, artifactFiles = [], signature, includeSignature = true, internalIds = [] }) {
  if (atAll && (atOpenDingTalkIds.length || replyToMessageId)) throw new Error('group_reply_audience_conflict')
  const attachments = artifactFiles.length ? '\n\n附件与验收对应：\n' + artifactFiles
    .map((file, index) => `${index + 1}. ${file.artifact.fileName}：${file.caption}`).join('\n') : ''
  const reply = formatTaskGroupReply({ source: { groupId, messageId: replyToMessageId, senderOpenDingTalkId: replyToSenderOpenDingTalkId, text: sourceText },
    summary: text + attachments, evidence: [], limitations: [], signature, includeSignature, internalIds, allowUnrouted: true })
  return { ...reply, atOpenDingTalkIds, ...(atAll ? { atAll: true } : {}) }
}

/** Parts use the existing durable queue, ordered after the explanatory message. */
export function groupNotificationParts(notification, artifactFiles = []) {
  const parts = [notification]
  if (artifactFiles.length) notification.payload.deliveryId = notification.id
  for (const file of artifactFiles) {
    const id = `${notification.id}:file:${file.artifact.artifactId}`, p = notification.payload
    parts.push({ id, notificationId: id, kind: notification.kind, taskId: file.artifact.taskId ?? null,
      requirementRevision: file.artifact.requirementRevision ?? notification.requirementRevision,
      state: 'prepared', createdAt: notification.createdAt, updatedAt: notification.updatedAt,
      payload: { ...Object.fromEntries(['conversationId', 'replyTopicId', 'topicRefs', 'taskIds', 'coveredEventIds'].filter(key => p[key] !== undefined).map(key => [key, p[key]])), replyKind: 'substantive',
        deliveryId: notification.id, afterNotificationId: parts.at(-1).id,
        text: `${file.artifact.fileName}：${file.caption}`, artifact: file.artifact, fact: p.fact,
        ...(p.sourceRef ? { sourceRef: p.sourceRef, sourceId: p.sourceId, sourceVersion: p.sourceVersion } : {}) } })
  }
  return parts
}
