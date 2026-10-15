import { assertGroupReply } from './group-message.js'

const required = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`GROUP_REPLY_${field}_REQUIRED`)
  return value.trim()
}

function lines(values, field) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw new Error(`GROUP_REPLY_${field}_INVALID`)
  }
  return values.map(value => value.trim()).filter(Boolean)
}

function withoutSourceQuote(text, sourceText) {
  if (typeof sourceText !== 'string') return text
  const match = text.match(/^((?:[ \t]*>[^\r\n]*(?:\r?\n|$))+)(?:\r?\n)*([\s\S]*)$/u)
  if (!match) return text
  const quote = match[1].split(/\r?\n/u).map(line => line.replace(/^[ \t]*>[ \t]?/u, '')).join('\n').trim()
  const normalize = value => value.replace(/\s+/gu, ' ').trim()
  return normalize(quote) === normalize(sourceText) ? match[2].trim() : text
}

/**
 * Presentation only: the caller decides whether and when a notification is allowed.
 * DWS owns the native quote and mention; do not duplicate either as display-name text.
 * Evidence and limitations must already be public, verified task-session statements.
 */
export function formatTaskGroupReply({ source, summary, evidence, limitations, internalIds = [] } = {}) {
  const groupId = required(source?.groupId, 'GROUP_ID')
  const replyToMessageId = required(source?.messageId, 'SOURCE_MESSAGE_ID')
  const replyToSenderOpenDingTalkId = required(source?.senderOpenDingTalkId, 'SOURCE_SENDER_ID')
  const body = required(withoutSourceQuote(required(summary, 'SUMMARY'), source.text), 'SUMMARY')
  const facts = lines(evidence, 'EVIDENCE')
  const boundaries = lines(limitations, 'LIMITATIONS')
  const sections = [body]
  if (facts.length) sections.push(facts.map(fact => `- ${fact.replace(/^[-*•][ \t]+/u, '').replace(/\r?\n/gu, '\n  ')}`).join('\n\n'))
  if (boundaries.length) sections.push(boundaries.join('\n\n'))
  const text = sections.join('\n\n')
  assertGroupReply(text, internalIds)
  if (/通过AI发送|全部已读|(?:查看|见|打开)(?:\s*Agent)?\s*本地(?:任务)?详情|(?:调度|内部)(?:任务)?编号\s*[:：]?\s*SG\d+|(?:\/workspace\/|\/tmp\/|[A-Za-z]:\\Users\\)/iu.test(text)) {
    throw new Error('GROUP_REPLY_PRIVATE_OR_PLATFORM_TEXT')
  }
  return { groupId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds: [replyToSenderOpenDingTalkId] }
}
