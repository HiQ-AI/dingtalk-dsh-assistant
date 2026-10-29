import { assertGroupReply } from './group-message.js'

// Explicit Agent configuration only; never infer an identity from names or prose.
export function normalizeReplySignature(value = '') {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new Error('GROUP_REPLY_SIGNATURE_INVALID')
  const signature = value.trim()
  if (signature.length > 80 || /^[-*•]/u.test(signature)) throw new Error('GROUP_REPLY_SIGNATURE_INVALID')
  assertGroupReply(signature)
  return signature
}

// Remove only exact, standalone configured footer paragraphs. Quotes, code,
// lists and other identities are business content, not candidates for deletion.
export function withoutConfiguredReplySignature(text, signature) {
  const sign = normalizeReplySignature(signature)
  if (!sign) return text
  const rows = text.split(/\r?\n/u)
  const isSignature = row => typeof row === 'string' && /^[-*•][ \t]+/u.test(row) && row.replace(/^[-*•][ \t]+/u, '').trim() === sign
  let fence
  const removed = new Set()
  rows.forEach((row, index) => {
    const marker = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      return true
    }
    if (fence || !/^[-*•][ \t]+/u.test(row)) return true
    const exact = isSignature(row)
    const standalone = (index === 0 || !rows[index - 1].trim() || isSignature(rows[index - 1])) && (index === rows.length - 1 || !rows[index + 1].trim() || isSignature(rows[index + 1]))
    let previous = index - 1
    while (previous >= 0 && !rows[previous].trim()) previous--
    const previousIsSignature = isSignature(rows[previous])
    const listContext = !previousIsSignature && previous >= 0 && /^(?:[ \t]*[-*•][ \t]+|[ \t]*\d+[.)][ \t]+|>| {4}|\t)|[:：]\s*$/u.test(rows[previous])
    if (exact && standalone && !listContext) removed.add(index)
  })
  return rows.filter((row, index) => !removed.has(index) && !(removed.has(index - 1) && !row.trim())).join('\n').trim()
}

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
export function formatTaskGroupReply({ source, summary, evidence, limitations, signature, includeSignature = true, internalIds = [] } = {}) {
  const groupId = required(source?.groupId, 'GROUP_ID')
  const replyToMessageId = required(source?.messageId, 'SOURCE_MESSAGE_ID')
  const replyToSenderOpenDingTalkId = required(source?.senderOpenDingTalkId, 'SOURCE_SENDER_ID')
  const clean = text => withoutConfiguredReplySignature(text, signature)
  const body = required(withoutSourceQuote(clean(required(summary, 'SUMMARY')), source.text), 'SUMMARY')
  const facts = lines(evidence, 'EVIDENCE').map(clean).filter(Boolean)
  const boundaries = lines(limitations, 'LIMITATIONS').map(clean).filter(Boolean)
  const sections = [body]
  if (facts.length) sections.push(facts.map(fact => `- ${fact.replace(/^[-*•][ \t]+/u, '').replace(/\r?\n/gu, '\n  ')}`).join('\n\n'))
  if (boundaries.length) sections.push(boundaries.join('\n\n'))
  // Each model field has been cleaned before list indentation. Never scan the
  // assembled evidence list for footer-like business content.
  const sign = normalizeReplySignature(signature)
  if (sign && includeSignature) sections.push(`- ${sign}`)
  const text = sections.join('\n\n')
  assertGroupReply(text, internalIds)
  if (/通过AI发送|全部已读|(?:查看|见|打开)(?:\s*Agent)?\s*本地(?:任务)?详情|(?:调度|内部)(?:任务)?编号\s*[:：]?\s*SG\d+|(?:\/workspace\/|\/tmp\/|[A-Za-z]:\\Users\\)/iu.test(text)) {
    throw new Error('GROUP_REPLY_PRIVATE_OR_PLATFORM_TEXT')
  }
  return { groupId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds: [replyToSenderOpenDingTalkId] }
}
