import { basename } from 'node:path'
import { notificationOpenTaskId } from './group-message.js'
import { taskNotificationOutbound } from './task-message-projections.js'

// Closed literal CLI grammar, not a search for DWS-looking text in arbitrary scripts.
// Computed arguments, pipelines, functions, redirection and shell evaluation are not receipts.
export function nativeDwsCommands(toolName, args) {
  if (!['pwsh', 'bash'].includes(toolName) || typeof args?.command !== 'string') return []
  const input = args.command
  if (input.length > 64000 || !/^\s*dws(?:\.exe)?[ \t]+chat[ \t]/iu.test(input)) return []
  const rows = []; let row = [], token = '', quote = '', started = false
  const endToken = () => { if (started) row.push(token); token = ''; started = false }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quote) {
      if (char === quote) {
        if (quote === "'" && toolName === 'pwsh' && input[i + 1] === "'") { token += "'"; i++ }
        else quote = ''
      } else {
        if (quote === '"' && (/[$`]/u.test(char) || toolName === 'bash' && char === '\\')) return []
        token += char
      }
    } else if (char === "'" || char === '"') { if (started) return []; quote = char; started = true }
    else if (char === ';' || char === '\n') { endToken(); if (row.length) rows.push(row); row = [] }
    else if (/\s/u.test(char)) endToken()
    else { if (/[|&<>$`{}()[\]\\#*?~]/u.test(char)) return []; token += char; started = true }
  }
  if (quote) return []
  endToken(); if (row.length) rows.push(row)
  if (!rows.length || rows.length > 8) return []
  const commands = []
  for (const values of rows) {
    if (!['dws', 'dws.exe'].includes(values.shift()?.toLowerCase())) return []
    let kind, count
    if (values[0] === 'chat' && values[1] === '+messages-send') { kind = 'send'; count = 2 }
    else if (values.slice(0, 3).join(' ') === 'chat message reply') { kind = 'reply'; count = 3 }
    else if (values.slice(0, 3).join(' ') === 'chat message send-status') { kind = 'status'; count = 3 }
    else if (values[0] === 'chat' && values[1] === '+messages-query-send-status') { kind = 'status'; count = 2 }
    else if (values[0] === 'chat' && values[1] === '+messages-mget') { kind = 'read'; count = 2 }
    else return []
    const flags = {}, switches = new Set(['--yes', '--no-reactions', '--no-threads'])
    const allowed = new Set(kind === 'send' ? ['--as','--group','--text','--markdown','--file','--msg-type','--idempotency-key','--yes','--format','--profile','--at-open-dingtalk-ids']
      : kind === 'reply' ? ['--group','--ref-msg-id','--ref-sender','--content','--uuid','--yes','--format','--profile','--at-open-dingtalk-ids']
        : kind === 'status' ? ['--open-task-id','--format','--profile'] : ['--msg-ids','--no-reactions','--no-threads','--format','--profile'])
    for (let i = count; i < values.length; i++) {
      const name = values[i]
      if (!allowed.has(name) || Object.hasOwn(flags, name)) return []
      flags[name] = switches.has(name) ? true : values[++i]
      if (flags[name] === undefined || flags[name] === '') return []
    }
    if (flags['--format'] !== 'json') return []
    if (kind === 'send' || kind === 'reply') {
      const text = kind === 'send' ? flags['--markdown'] ?? flags['--text'] : flags['--content'], file = flags['--file']
      const key = flags[kind === 'send' ? '--idempotency-key' : '--uuid']
      if (!flags['--group'] || !key || !flags['--yes'] || kind === 'send' && flags['--as'] !== 'user'
        || flags['--text'] && flags['--markdown']
        || !text && !file || text && file || kind === 'reply' && (!flags['--ref-msg-id'] || !flags['--ref-sender'])) return []
      commands.push({ kind: 'send', conversationId: flags['--group'], idempotencyKey: key,
        profile: flags['--profile'] ?? null,
        messageType: kind === 'reply' ? 'reply' : flags['--msg-type'] ?? (flags['--markdown'] ? 'markdown' : file ? 'file' : 'text'),
        text: text ?? `[文件] ${basename(file.replaceAll('\\', '/'))}` })
    } else if (kind === 'status') {
      if (!flags['--open-task-id']) return []
      commands.push({ kind, openTaskId: flags['--open-task-id'], profile: flags['--profile'] ?? null })
    } else { if (!flags['--msg-ids']) return []; commands.push({ kind }) }
  }
  // A send result is unambiguous only when it is the sole invocation in this call.
  if (commands.some(command => command.kind === 'send') && commands.length !== 1) return []
  return commands
}

function jsonStream(text) {
  const values = []; let start = 0
  while (start < text.length) {
    while (/\s/u.test(text[start] ?? '') && start < text.length) start++
    if (start === text.length) break
    if (!['{', '['].includes(text[start])) return []
    let depth = 0, quoted = false, escaped = false, end = start
    for (; end < text.length; end++) {
      const char = text[end]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
      else if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') { if (--depth === 0) break }
    }
    if (depth || quoted) return []
    try { values.push(JSON.parse(text.slice(start, end + 1))) } catch { return [] }
    start = end + 1
  }
  return values
}

export function nativeDwsStatus(value, openTaskId, conversationId) {
  if (value?.contractVersion !== 'im.message-send-status.v1' || value.success !== true || value.openTaskId !== openTaskId
    || value.result?.sendStatus !== 'SUCCESS') return undefined
  const group = value.result.openConversationId, messageId = value.result.openMessageId
  if (typeof group !== 'string' || !group || typeof messageId !== 'string' || !messageId || conversationId && group !== conversationId
    || value.messageRef && (value.messageRef.openConversationId !== group || value.messageRef.openMessageId !== messageId)) return undefined
  return { openTaskId, conversationId: group, messageId }
}

export function nativeDwsObservation(event, commands) {
  if (!commands?.length || event.cancelled || event.result?.isError) return {}
  let output
  const value = event.result?.value, job = event.jobReceipt
  if (value?.kind === 'foreground' && value.exitCode === 0 && value.timedOut === false && value.aborted === false
    && !value.stdout?.truncated && typeof value.stdout?.text === 'string') output = value.stdout.text
  else if (job?.status === 'completed' && job.owner === event.binding.sessionId && !job.lossy && !job.cancelled)
    output = job.chunks?.filter(chunk => chunk.stream !== 'stderr').map(chunk => chunk.text).join('')
  if (typeof output !== 'string' || Buffer.byteLength(output) > 256 * 1024) return {}
  const values = jsonStream(output), first = values[0]
  if (commands[0].kind === 'send') {
    if (values.length !== 1 || first?.ok === false || first?.success === false || first?.result?.success === false
      || !(first?.ok === true || first?.success === true || first?.result?.success === true)) return {}
    const ids = [first.sendReceipt?.openTaskId, first.result?.result?.openTaskId, first.result?.openTaskId].filter(value => value !== undefined)
    if (!ids.length || ids.some(id => typeof id !== 'string' || !id || id !== ids[0])) return {}
    return { nativeDwsSend: { ...commands[0], openTaskId: ids[0] } }
  }
  const statuses = commands.flatMap((command, index) => {
    const proof = command.kind === 'status' && nativeDwsStatus(values[index], command.openTaskId)
    return proof ? [{ ...proof, profile: command.profile }] : []
  })
  return statuses.length ? { nativeDwsStatuses: statuses } : {}
}

/** Original native operations are the authority; the existing outbox stores exact self IDs. */
export function createNativeDwsObserver({ operations, residentStore, notificationCache = new Map(), querySendStatus, warn = () => {}, ingressWaitMs = 1500, probeWaitMs = 3000 }) {
  const pending = new Map(), probes = new Map()
  let closed = false
  const stopped = Promise.withResolvers()
  const bounded = async (promise, ms) => {
    let timer
    try { return await Promise.race([promise, stopped.promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })]) }
    finally { clearTimeout(timer) }
  }
  const sendOf = operation => operation.state === 'succeeded' && operation.result?.nativeDwsSend
  const outboundId = operation => `native-dws:${operation.id}`
  const recorded = operation => residentStore.getGroup(sendOf(operation)?.conversationId)?.outbox.some(item => item.outboundId === outboundId(operation))
  async function register(operation, proof) {
    const send = sendOf(operation)
    if (closed || !send || send.openTaskId !== proof.openTaskId || send.conversationId !== proof.conversationId || recorded(operation)) return
    await residentStore.projectTaskNotification({ groupId: send.conversationId, outbound: {
      outboundId: outboundId(operation), sourceMessageId: `native-operation:${operation.id}`, text: send.text,
      status: 'sent', notificationState: 'delivered', taskIds: [operation.taskId], notificationTaskId: operation.taskId,
      deliveredMessageId: proof.messageId, deliveredAt: new Date().toISOString(),
      sendReceipt: { openTaskId: proof.openTaskId, conversationId: proof.conversationId, messageId: proof.messageId },
    } })
  }
  async function probeStatus(key, openTaskId, conversationId, options, save) {
    if (closed || !querySendStatus) return
    if (probes.has(key)) return bounded(probes.get(key), probeWaitMs)
    const promise = Promise.resolve().then(async () => {
      const proof = nativeDwsStatus(await querySendStatus(openTaskId, options), openTaskId, conversationId)
      if (proof && !closed) await save(proof)
    }).catch(error => warn(error)).finally(() => probes.delete(key))
    probes.set(key, promise); return bounded(promise, probeWaitMs)
  }
  async function probe(operation) {
    const send = sendOf(operation)
    if (!send || recorded(operation)) return
    return probeStatus(operation.id, send.openTaskId, send.conversationId, { profile: send.profile }, proof => register(operation, proof))
  }
  async function probeNotification(notification) {
    if (!['starting', 'unknown'].includes(notification.state) || notification.payload?.audience === 'operator') return
    const groupId = notification.payload?.conversationId, openTaskId = notificationOpenTaskId(notification.ack ?? notification.receipt)
    if (!openTaskId || residentStore.getGroup(groupId)?.outbox.some(item => item.outboundId === notification.id && item.deliveredMessageId)) return
    return probeStatus(`notification:${notification.id}`, openTaskId, groupId, undefined, async proof => {
      // Identity is known before a file's byte readback finishes. Keep its current
      // delivery state: filtering an echo does not claim the attachment was verified.
      const current = notificationCache.get(notification.id) ?? notification
      await residentStore.projectTaskNotification({ groupId, outbound: {
        ...taskNotificationOutbound(current), deliveredMessageId: proof.messageId, sendReceipt: proof,
      } })
    })
  }
  async function observeStatuses(operation) {
    if (operation?.state !== 'succeeded') return
    for (const proof of operation.result?.nativeDwsStatuses ?? []) {
      const send = [...operations.values()].find(item => item.taskId === operation.taskId && sendOf(item)?.openTaskId === proof.openTaskId
        && sendOf(item)?.profile === proof.profile)
      if (send) await register(send, proof)
    }
  }
  return {
    start(operationId, commands) {
      if (commands?.[0]?.kind === 'send') pending.set(operationId, { groupId: commands[0].conversationId, ...Promise.withResolvers() })
    },
    finish(operationId) { pending.get(operationId)?.resolve(); pending.delete(operationId) },
    notificationChanged(notification) {
      const key = `notification:${notification.id}`
      if (notification.state === 'starting' && !notification.ack && !notification.receipt && notification.payload.audience !== 'operator') {
        if (!pending.has(key)) pending.set(key, { groupId: notification.payload.conversationId, ...Promise.withResolvers() })
      } else { pending.get(key)?.resolve(); pending.delete(key) }
    },
    async observe(operation) {
      if (operation?.state !== 'succeeded') return
      await observeStatuses(operation)
      await probe(operation)
    },
    async beforeIngress(groupId) {
      const startedAt = Date.now()
      await bounded(Promise.all([...pending.values()].filter(item => item.groupId === groupId).map(item => item.promise)), ingressWaitMs)
      if (closed || Date.now() - startedAt >= ingressWaitMs) return
      await bounded(Promise.all([
        ...[...operations.values()].filter(item => sendOf(item)?.conversationId === groupId).map(probe),
        ...[...notificationCache.values()].filter(item => item.payload?.conversationId === groupId).map(probeNotification),
      ]), ingressWaitMs - (Date.now() - startedAt))
    },
    async recover() {
      // Startup reprojects persisted proofs; network availability is never a boot gate.
      for (const operation of operations.values()) await observeStatuses(operation)
    },
    close() { closed = true; stopped.resolve(); for (const item of pending.values()) item.resolve(); pending.clear() },
  }
}
