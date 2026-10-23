// Generic channel safety; personal identity, signature and business instructions come from user configuration.
export const groupReplyScopeInstructions = '群内回复像同事日常交流，简短自然，避免公文腔；按上下文和真实进度灵活组织表达，不规定固定开头、句式、状态用语或标题编号，不为变化措辞夸大进度。同一条消息有多个事项时，每条说清具体在处理哪个问题、准备怎么做或已经做到哪里，让人看得出是不同的事，避免多条相似的空泛确认造成重复处理的感觉。只处理或完成其中一部分时，点明具体是哪几项，不把部分说成全部。其他事项只说已经核实的进展；不清楚时就只说明当前这项，不猜测它们没处理、已交给别人或会稍后处理。合并回复也逐项说清问题和进展，不假设其他回复已经送达或会按固定顺序到达。'

export const groupReplyInstructions = `依据当前原始消息、真实作者和群职责说明实际业务结果与限制，不编造业务名称、数据、链接或已执行动作。${groupReplyScopeInstructions}引用和提及使用受信消息身份；Host 已提供钉钉原生引用，正文直接写答复，不再以 Markdown 引文或其他方式复述被引用消息。只分享接收者可访问的交付结果。公开正文不包含内部任务、会话、调度、诊断编号或凭据。需要用户决定或补充时具体说明缺口，已有材料与可取得事实先自主核对。个人姓名、语气偏好和业务流程以当前工作区规则与所属群会话职责为准；署名由Host按显式Agent配置在完整最终正文末尾统一附加一次，模型正文和中间内容不生成署名，不从旧报告推断默认身份。通知仅按当前任务授权及Host唯一出口处理，不自行补发或重放未知效果。`

/** 格式兜底不猜测合法业务 URL 内的同形编号；已知内部身份仍由正文全范围校验。 */
function containsRuntimeDetails(text) {
  const matches = [...text.matchAll(/(?:task|owner|run|session|coordination|human)-[a-f0-9]{32,}\b|(?:unit|topic)-[a-f0-9]{32}(?![a-f0-9])|execution-[a-f0-9]{40}(?![a-f0-9])|coord-route-[a-f0-9]{64}(?![a-f0-9])|(?:time|message|business-event):[a-f0-9]{32,}\b|(?:任务|会话|执行|流程|协调|调度)(?:编号|[ _-]?id)\s*[:：=]\s*\S+|(?:taskId|sessionId|runId|coordinationId|scheduleId|occurrenceId|humanRequestId|leaseEpoch|inputDigest)\s*[:：=]\s*\S+|任务会话|执行会话|叶子会话|平台机制|(?:Task Owner|Outbox|IntentRun)\s*(?:已|将|正在|等待|调度|提交|写入)/giu)]
  if (!matches.length) return false
  const urls = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。；！？、（）【】]+/giu)) {
    try {
      const url = new URL(match[0])
      if (['http:', 'https:'].includes(url.protocol) && url.hostname) urls.push([match.index, match.index + match[0].length])
    } catch { /* 不合法的 URL 不豁免内部格式检查。 */ }
  }
  return matches.some(match => !urls.some(([start, end]) => match.index >= start && match.index + match[0].length <= end))
}

export function assertGroupReply(text, internalIds = []) {
  if (typeof text !== 'string') return
  // 已知身份按原值检查；短 ID 还需边界，避免误命中正常单词中的几个字母。
  if (internalIds.some(id => typeof id === 'string' && id.trim()
    && (id.length >= 8 ? text.includes(id) : new RegExp(`(?<![a-zA-Z0-9_-])${RegExp.escape(id)}(?![a-zA-Z0-9_-])`, 'u').test(text)))
    || containsRuntimeDetails(text)) {
    const error = new Error('GROUP_REPLY_INTERNAL_DETAILS: 请将公开正文改成群成员能理解的业务进展，不包含插件内部编号或机制。')
    error.code = 'GROUP_REPLY_INTERNAL_DETAILS'
    throw error
  }
}

export function sameDeliveredText(observed, expected, quoted = false) {
  const normalize = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : null
  const actual = normalize(observed), wanted = normalize(expected)
  if (actual === null || wanted === null) return false
  // 钉钉回读把单行 inline-code 表示成粗体；只变换期望的成对单反引号，保留正文。
  const inlineRendered = expected.replace(/(^|[^`])`([^`\r\n]+)`(?!`)/gu, '$1**$2**')
  // DWS 会移除列表项间换行；仅变换期望的顶层列表边界，保留正文和段落间隔。
  const listRendered = (text, restartOrdered = false) => {
    const lines = text.split(/\r?\n/u), rendered = []
    let fence = null
    for (let index = 0; index < lines.length; index++) {
      const marker = lines[index].match(/^\s*(`{3,}|~{3,})/u)?.[1]
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null }
      if (!fence && /^- .+/u.test(lines[index])) {
        let end = index, joined = lines[index]
        while (end + 1 < lines.length) {
          let next = end + 1
          while (next < lines.length && lines[next].trim() === '') next++
          if (!/^- .+/u.test(lines[next] ?? '')) break
          joined += lines[next]; end = next
        }
        rendered.push(joined); index = end; continue
      }
      if (!fence && /^1\. .+/u.test(lines[index])) {
        // 分段有序列表在钉钉回读中可各自从 1 开始；只变换连续原序号，正文逐字保留。
        if (restartOrdered) {
          let end = index, count = 1
          const items = [lines[index]]
          while (end + 1 < lines.length) {
            let next = end + 1
            while (next < lines.length && lines[next].trim() === '') next++
            const prefix = `${count + 1}. `
            if (!lines[next]?.startsWith(prefix) || lines[next].length <= prefix.length) break
            items.push(...lines.slice(end + 1, next), `1. ${lines[next].slice(prefix.length)}`)
            end = next; count++
          }
          if (count > 1) { rendered.push(...items); index = end; continue }
        }
        let end = index + 1
        while (end < lines.length && lines[end].startsWith(`${end - index + 1}. `) && lines[end].length > `${end - index + 1}. `.length) end++
        if (end > index + 1) { rendered.push(lines.slice(index, end).join('')); index = end - 1; continue }
      }
      rendered.push(lines[index])
    }
    return normalize(rendered.join('\n'))
  }
  const prefix = typeof quoted === 'object' && quoted?.sender ? normalize(`@${quoted.sender} `) + ' ' : null
  const body = prefix && actual.startsWith(prefix) ? actual.slice(prefix.length) : actual
  return [wanted, normalize(inlineRendered), listRendered(expected), listRendered(inlineRendered),
    listRendered(expected, true), listRendered(inlineRendered, true)].some(candidate => body === candidate)
}

export function notificationOpenTaskId(ack) {
  return ack?.openTaskId ?? ack?.sendReceipt?.openTaskId ?? ack?.result?.openTaskId ?? ack?.result?.result?.openTaskId
}

/** 只收集事实里的结构化身份和摘要；业务正文、标题及普通数值不作为内部标识。 */
function factInternalIds(fact) {
  if (!fact || typeof fact !== 'object') return []
  return Object.entries(fact).flatMap(([key, value]) => {
    const identity = /(?:Id|Ids|Digest|Ref|Refs)$/u.test(key) || key === 'id'
    if (Array.isArray(value)) return value.flatMap(item => item && typeof item === 'object' ? factInternalIds(item) : identity ? [item] : [])
    if (value && typeof value === 'object') return factInternalIds(value)
    return identity ? [value] : []
  })
}

export function sendWorkflowNotification(adapter, notification) {
  const payload = notification.payload
  if (payload.reportChannel === 'web' || payload.externalMessaging === false
    || notification.disclosure?.authorizationRef?.startsWith('web-rerun:')) throw new Error('WORKFLOW_WEB_NOTIFICATION_FORBIDDEN')
  assertGroupReply(payload.text, [notification.id, notification.taskId, payload.conversationId, payload.sourceMessageId,
    payload.actorId, payload.recipientUserId, payload.humanRequestId,
    ...(Array.isArray(payload.atOpenDingTalkIds) ? payload.atOpenDingTalkIds : []), ...factInternalIds(payload.fact)])
  // 普通提醒与引用回复都使用原生提及参数，不把人员 ID 或 @ 姓名拼进正文。
  const base = { groupId: payload.conversationId, text: payload.text, idempotencyKey: notification.id,
    atOpenDingTalkIds: payload.atOpenDingTalkIds ?? [] }
  return payload.sourceMessageId && payload.actorId
    ? adapter.sendGroupReply({ ...base, replyToMessageId: payload.sourceMessageId, replyToSenderOpenDingTalkId: payload.actorId })
    : adapter.sendGroup(base)
}

// CLI v1.0.63 gateway contract: this exact guard refusal precedes the send call.
// A generic exit, rate limit, retryable flag or missing ACK is never a negative receipt.
export function quotedSendRejectionProof(result, request) {
  let error
  try { error = JSON.parse(result.stderr)?.error } catch { return undefined }
  if (result.exitCode !== 1 || (result.stdout ?? '').trim() || error?.category !== 'api' || error.code !== 1
    || error.origin !== 'mcp_gateway' || error.operation !== 'chat/get_conversation_info'
    || error.reason !== 'topic_quote_guard_unavailable' || error.retryable !== true
    || error.message !== '无法确认引用回复目标是否属于话题圈，已阻止发送') return undefined
  if (![request.groupId, request.replyToMessageId, request.replyToSenderOpenDingTalkId, request.idempotencyKey].every(value => typeof value === 'string' && value.trim())) return undefined
  return { kind: 'dws-topic-quote-guard-rejected', category: error.category, code: error.code, origin: error.origin,
    operation: error.operation, reason: error.reason, retryable: true, message: error.message,
    groupId: request.groupId, replyToMessageId: request.replyToMessageId, replyToSenderOpenDingTalkId: request.replyToSenderOpenDingTalkId, idempotencyKey: request.idempotencyKey }
}

/** 仅凭原发送尝试的完整 uuid 校验拒绝结清失败；不为未知网络结果或重发提供许可。 */
export function persistedUuidSendRejectionProof(notification) {
  const id = notification?.id, permit = notification?.sendPermit, failure = notification?.deliveryError
  if (notification?.state !== 'unknown' || notification.sendAttemptCount !== 1
    || notification.ack != null || notification.receipt != null || typeof id !== 'string' || id.length <= 128
    || !/^[a-f0-9]{64}$/u.test(notification.payloadDigest ?? '') || permit?.notificationId !== id
    || permit.payloadDigest !== notification.payloadDigest || permit.attempt !== 1
    || typeof notification.dispatchToken !== 'string' || !notification.dispatchToken.trim() || permit.fence !== notification.dispatchToken
    || failure?.phase !== 'send' || failure.exitCode !== 1 || failure.stdout !== ''
    || !['dws_send_failed:1:PARAM_ERROR', 'dws_reply_failed:1:PARAM_ERROR'].includes(failure.message)
    || failure.serverErrorCode !== 'PARAM_ERROR' || failure.origin !== 'dingtalk_api'
    || failure.operation !== 'tools/call' || failure.reason !== 'invalid_request' || failure.retryable !== false) return undefined
  let error
  try { error = JSON.parse(failure.stderr)?.error } catch { return undefined }
  const message = `sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is ${id.length}.`
  if (error?.category !== 'api' || error.code !== 1 || error.origin !== 'dingtalk_api'
    || error.operation !== 'tools/call' || error.reason !== 'invalid_request' || error.retryable !== false
    || error.server_error_code !== 'PARAM_ERROR' || error.server_key !== 'chat' || error.stage !== 'tool_validation'
    || error.message !== message) return undefined
  return { kind: 'dws-uuid-validation-rejected', notificationId: id, idempotencyKey: id,
    payloadDigest: notification.payloadDigest, attempt: 1, fence: permit.fence,
    origin: error.origin, operation: error.operation, stage: error.stage, reason: error.reason,
    serverErrorCode: error.server_error_code, maximumLength: 128, actualLength: id.length, errorMessage: message }
}

/** 已观察到的单成员 CLI 占位符校验在发送前拒绝；历史通知只能结清失败，不能自动补发。 */
export function persistedMentionSendRejectionProof(notification) {
  const id = notification?.id, permit = notification?.sendPermit, failure = notification?.deliveryError
  const mentions = notification?.payload?.atOpenDingTalkIds
  if (notification?.state !== 'unknown' || notification.sendAttemptCount !== 1
    || notification.ack != null || notification.receipt != null || typeof id !== 'string' || !id.trim()
    || !/^[a-f0-9]{64}$/u.test(notification.payloadDigest ?? '') || permit?.notificationId !== id
    || permit.payloadDigest !== notification.payloadDigest || permit.attempt !== 1
    || typeof notification.dispatchToken !== 'string' || !notification.dispatchToken.trim() || permit.fence !== notification.dispatchToken
    || failure?.phase !== 'send' || failure.exitCode !== 3 || failure.stdout !== ''
    || !['dws_send_failed:3', 'dws_reply_failed:3'].includes(failure.message)
    || !Array.isArray(mentions) || mentions.length !== 1 || typeof mentions[0] !== 'string' || !mentions[0]
    || /[\s,<>]/u.test(mentions[0]) || typeof notification.payload.text !== 'string'
    || notification.payload.text.includes(`<@${mentions[0]}>`)) return undefined
  let error
  try { error = JSON.parse(failure.stderr)?.error } catch { return undefined }
  const message = `--at-open-dingtalk-ids 中的成员必须在正文中使用对应 <@openDingTalkId> 占位符；缺少: ${mentions[0]}`
  if (error?.category !== 'validation' || error.code !== 3 || error.message !== message
    || Object.keys(error).sort().join(',') !== 'category,code,message') return undefined
  return { kind: 'dws-mention-validation-rejected', notificationId: id, payloadDigest: notification.payloadDigest,
    attempt: 1, fence: permit.fence, category: error.category, code: error.code, errorMessage: message }
}
