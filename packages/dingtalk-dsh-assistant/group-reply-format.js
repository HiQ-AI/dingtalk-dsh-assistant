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

// This is an explicit personal setting, never inferred from names, responsibilities or model output.
export function normalizeReplySignature(value = '') {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new Error('GROUP_REPLY_SIGNATURE_INVALID')
  const signature = value.trim()
  if (signature.length > 80 || /^[-*•]/u.test(signature)) throw new Error('GROUP_REPLY_SIGNATURE_INVALID')
  assertGroupReply(signature)
  return signature
}

function withoutSessionSignature(text, signature) {
  // Only an explicit global signature authorizes replacing the session's footer.
  if (!signature) return text.trim()
  const rows = text.split(/\r?\n/u)
  let end = rows.length - 1
  while (end >= 0 && !rows[end].trim()) end--
  if (end < 0) return ''
  const row = rows[end]
  // A formatter footer is one unindented final paragraph. Never filter arbitrary
  // body lines: list items, quoted examples and indented/fenced code are content.
  if (/^[ \t>]/u.test(row) || end > 0 && rows[end - 1].trim()) return text.trim()
  const candidate = row.match(/^[-*•][ \t]+(.+)$/u)?.[1]?.trim()
  if (!candidate || candidate !== signature && !/^[^\r\n，,；;。！!？?`"'“”「」<>]{1,40}代回$/u.test(candidate)) return text.trim()
  let fence
  for (const line of rows.slice(0, end)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined }
  }
  if (fence) return text.trim()
  let previous = end - 1
  while (previous >= 0 && !rows[previous].trim()) previous--
  // A terminal list item is still business content, even with blank lines between items.
  if (previous >= 0 && (/^(?:[ \t]*[-*•][ \t]+|[ \t]*\d+[.)][ \t]+|>| {4}|\t)/u.test(rows[previous])
    || /[:：]\s*$/u.test(rows[previous]))) return text.trim()
  return rows.slice(0, end).join('\n').trim()
}

/**
 * Presentation only: the caller decides whether and when a notification is allowed.
 * DWS owns the native quote and mention; do not duplicate either as display-name text.
 * Evidence and limitations must already be public, verified task-session statements.
 */
export function formatTaskGroupReply({ source, summary, evidence, limitations, signature, internalIds = [] } = {}) {
  const groupId = required(source?.groupId, 'GROUP_ID')
  const replyToMessageId = required(source?.messageId, 'SOURCE_MESSAGE_ID')
  const replyToSenderOpenDingTalkId = required(source?.senderOpenDingTalkId, 'SOURCE_SENDER_ID')
  const sign = normalizeReplySignature(signature)
  const body = required(withoutSessionSignature(required(summary, 'SUMMARY'), sign), 'SUMMARY')
  const facts = lines(evidence, 'EVIDENCE').map(value => withoutSessionSignature(value, sign)).filter(Boolean)
  const boundaries = lines(limitations, 'LIMITATIONS').map(value => withoutSessionSignature(value, sign)).filter(Boolean)
  const sections = [body]
  if (facts.length) sections.push(facts.map(fact => `- ${fact.replace(/^[-*•][ \t]+/u, '').replace(/\r?\n/gu, '\n  ')}`).join('\n\n'))
  if (boundaries.length) sections.push(boundaries.join('\n\n'))
  // An explicit global signature replaces the session footer; otherwise keep session text.
  if (sign) sections.push(`- ${sign}`)
  const text = sections.join('\n\n')
  assertGroupReply(text, internalIds)
  if (/通过AI发送|全部已读|(?:查看|见|打开)(?:\s*Agent)?\s*本地(?:任务)?详情|(?:调度|内部)(?:任务)?编号\s*[:：]?\s*SG\d+|(?:\/workspace\/|\/tmp\/|[A-Za-z]:\\Users\\)/iu.test(text)) {
    throw new Error('GROUP_REPLY_PRIVATE_OR_PLATFORM_TEXT')
  }
  return { groupId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds: [replyToSenderOpenDingTalkId] }
}
