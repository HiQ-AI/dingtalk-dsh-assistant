// Generic channel safety; personal identity, signature and business instructions come from user configuration.
export const groupReplyScopeInstructions = '群内回复用自然简短的日常说法，避免“本次承接”“本项交付”等公文措辞，不强制加标题或编号。按真实进度表达：已经开始做时说“正在处理…”“现在正在查…”；已确定要做但还没开始时说“我来处理…”；完成后直接说具体结果。同一条消息有多个事项时，每条直接说清在处理哪个问题、准备怎么做或已经做到哪里，让人看得出是不同的事，避免两条都只说“收到，这项我来处理”。只处理或完成其中一部分时，点明具体是哪几项，不把部分说成全部。其他事项只说已经核实的进展；不清楚时就只说明当前这项，不猜测它们没处理、已交给别人或会稍后处理。合并回复也逐项说清问题和进展，不假设其他回复已经送达或会按固定顺序到达。'

export const groupReplyInstructions = `依据当前原始消息、真实作者和群职责说明实际业务结果与限制，不编造业务名称、数据、链接或已执行动作。${groupReplyScopeInstructions}引用和提及使用受信消息身份；Host 已提供钉钉原生引用，正文直接写答复，不再以 Markdown 引文或其他方式复述被引用消息。只分享接收者可访问的交付结果。公开正文不包含内部任务、会话、调度、诊断编号或凭据。需要用户决定或补充时具体说明缺口，已有材料与可取得事实先自主核对。个人姓名、语气偏好和业务流程以当前工作区规则与所属群会话职责为准；署名由Host按显式Agent配置在完整最终正文末尾统一附加一次，模型正文和中间内容不生成署名，不从旧报告推断默认身份。通知仅按当前任务授权及Host唯一出口处理，不自行补发或重放未知效果。`

export function assertGroupReply(text, internalIds = []) {
  if (typeof text !== 'string') return
  if (internalIds.some(id => typeof id === 'string' && id.length >= 8 && text.includes(id))
    || /(?:task|owner|run|session)-[a-f0-9]{32,}\b|(?:任务|会话|执行|流程)(?:编号|[ _-]?id)\s*[:：=]\s*\S+|(?:taskId|sessionId|runId|leaseEpoch|inputDigest)\s*[:：=]\s*\S+|任务会话|执行会话|叶子会话|平台机制|(?:Task Owner|Outbox|IntentRun)\s*(?:已|将|正在|等待|调度|提交|写入)/iu.test(text)) {
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

export function sendWorkflowNotification(adapter, notification) {
  const payload = notification.payload
  if (payload.reportChannel === 'web' || payload.externalMessaging === false
    || notification.disclosure?.authorizationRef?.startsWith('web-rerun:')) throw new Error('WORKFLOW_WEB_NOTIFICATION_FORBIDDEN')
  assertGroupReply(payload.text)
  const base = { groupId: payload.conversationId, text: payload.text, idempotencyKey: notification.id }
  return payload.sourceMessageId && payload.actorId
    ? adapter.sendGroupReply({ ...base, replyToMessageId: payload.sourceMessageId, replyToSenderOpenDingTalkId: payload.actorId, ...(payload.atOpenDingTalkIds ? { atOpenDingTalkIds: payload.atOpenDingTalkIds } : {}) })
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
