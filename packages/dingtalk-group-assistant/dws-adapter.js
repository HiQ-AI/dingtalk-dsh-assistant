import { EventEmitter } from 'node:events'
import { readFile, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'

function assertStableId(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}_required`)
  return value
}

function parseJson(stdout, operation) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`dws_invalid_json:${operation}`, { cause: error })
  }
}

function comparableMessageText(value) {
  return String(value ?? '').replace(/[\p{P}\p{S}\s]/gu, '')
}

function matchesOutbound(message, outbound) {
  const actual = comparableMessageText(message.text), expected = comparableMessageText(outbound.text)
  if (actual === expected) return true
  if (expected.length < 24 || !actual.includes(expected)) return false
  const quotedId = message.quotedMessage?.messageId ?? message.quotedMessage?.message_id
  return !outbound.replyToMessageId || quotedId === outbound.replyToMessageId
}

export function createDwsAdapter({ enabled = false, writesAuthorized = false, profile, runner }) {
  if (runner === undefined) throw new Error('dws_runner_required')

  const requireEnabled = () => {
    if (!enabled) throw new Error('dws_adapter_disabled')
  }
  const withProfile = (args) => typeof profile === 'string' && profile.trim() !== '' ? [...args, '--profile', profile] : args

  return {
    compileGroupListen(groupId) {
      return withProfile(['event', '+listen-im', '--kind', 'group', '--events', 'message', '--chat-id', assertStableId(groupId, 'group_id'), '--format', 'ndjson'])
    },
    compileGroupRead(groupId) {
      return withProfile(['chat', '+chat-messages', '--group', assertStableId(groupId, 'group_id'), '--format', 'json'])
    },
    compileGroupReadRange(groupId, { start, end }) {
      return withProfile(['chat', '+chat-messages', '--group', assertStableId(groupId, 'group_id'), '--start', assertStableId(start, 'start'), '--end', assertStableId(end, 'end'), '--order', 'asc', '--page-all', '--page-limit', '50', '--max-items', '500', '--format', 'json'])
    },
    compileGroupSend({ groupId, text, idempotencyKey }) {
      const args = ['chat', '+messages-send', '--as', 'user', '--group', assertStableId(groupId, 'group_id'), '--text', assertStableId(text, 'text'), '--idempotency-key', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    compileGroupReply({ groupId, text, idempotencyKey, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds = [] }) {
      const args = ['chat', 'message', 'reply', '--group', assertStableId(groupId, 'group_id'), '--ref-msg-id', assertStableId(replyToMessageId, 'reply_message_id'), '--ref-sender', assertStableId(replyToSenderOpenDingTalkId, 'reply_sender_id'), '--content', assertStableId(text, 'text'), '--uuid', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
      if (atOpenDingTalkIds.length > 0) args.push('--at-open-dingtalk-ids', atOpenDingTalkIds.map((value) => assertStableId(value, 'at_open_dingtalk_id')).join(','))
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    compileSelfSend({ userId, text, idempotencyKey }) {
      const args = ['chat', '+messages-send', '--as', 'user', '--user', assertStableId(userId, 'human_user_id'), '--text', assertStableId(text, 'text'), '--idempotency-key', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    compileSendStatus(openTaskId) {
      return withProfile(['chat', '+messages-query-send-status', '--open-task-id', assertStableId(openTaskId, 'open_task_id'), '--format', 'json'])
    },
    compileMessageResourceDownload({ groupId, messageId, resourceId }) {
      return withProfile(['chat', '+messages-resource-download', '--type', 'mediaId', '--resource-id', assertStableId(resourceId, 'resource_id'), '--message-id', assertStableId(messageId, 'message_id'), '--open-conversation-id', assertStableId(groupId, 'group_id'), '--format', 'json'])
    },
    compileConversationRead(conversationId, { start, end }) {
      return withProfile(['chat', '+chat-messages', '--group', assertStableId(conversationId, 'conversation_id'), '--start', assertStableId(start, 'start'), '--end', assertStableId(end, 'end'), '--order', 'asc', '--page-all', '--format', 'json'])
    },
    compileMessageSearch(query) {
      return withProfile(['chat', '+search-msg', '--query', assertStableId(query, 'query'), '--days', '7', '--page-all', '--no-reactions', '--format', 'json'])
    },
    compileMessageRecall(messageId) {
      const args = ['chat', '+messages-recall', '--msg-id', assertStableId(messageId, 'message_id'), '--format', 'json']
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    async readGroup(groupId) {
      requireEnabled()
      const result = await runner.run(this.compileGroupRead(groupId))
      if (result.exitCode !== 0) throw new Error(`dws_read_failed:${result.exitCode}`)
      const value = parseJson(result.stdout, 'read')
      if (!Array.isArray(value.messages) || typeof value.complete !== 'boolean') throw new Error('dws_read_contract_invalid')
      return value
    },
    async readGroupRange(groupId, range) {
      requireEnabled()
      const result = await runner.run(this.compileGroupReadRange(groupId, range))
      if (result.exitCode !== 0) throw new Error(`dws_read_failed:${result.exitCode}`)
      const value = parseJson(result.stdout, 'read-range')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_backfill_partial')
      return value
    },
    async sendGroup(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const result = await runner.run(this.compileGroupSend(request))
      if (result.exitCode !== 0) throw new Error(`dws_send_failed:${result.exitCode}`)
      return parseJson(result.stdout, 'send')
    },
    async sendGroupReply(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const result = await runner.run(this.compileGroupReply(request))
      if (result.exitCode !== 0) throw new Error(`dws_reply_failed:${result.exitCode}`)
      return parseJson(result.stdout, 'reply')
    },
    async sendSelf(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const sent = await runner.run(this.compileSelfSend(request))
      if (sent.exitCode !== 0) throw new Error(`dws_self_send_failed:${sent.exitCode}`)
      const receipt = parseJson(sent.stdout, 'self-send')
      const openTaskId = receipt.sendReceipt?.openTaskId ?? receipt.result?.result?.openTaskId
      if (typeof openTaskId !== 'string' || openTaskId === '') throw new Error('dws_self_send_task_id_missing')
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (attempt > 0) await delay(500)
        const statusResult = await runner.run(this.compileSendStatus(openTaskId))
        if (statusResult.exitCode !== 0) throw new Error(`dws_self_send_status_failed:${statusResult.exitCode}`)
        const status = parseJson(statusResult.stdout, 'self-send-status')
        const conversationId = status.messageRef?.openConversationId ?? status.result?.openConversationId
        const messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
        if (status.result?.sendStatus === 'SUCCESS' && typeof conversationId === 'string' && typeof messageId === 'string') return { openTaskId, conversationId, messageId }
      }
      throw new Error('dws_self_send_not_confirmed')
    },
    async readConversation(conversationId, range) {
      requireEnabled()
      const result = await runner.run(this.compileConversationRead(conversationId, range))
      if (result.exitCode !== 0) throw new Error(`dws_conversation_read_failed:${result.exitCode}`)
      const value = parseJson(result.stdout, 'conversation-read')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_conversation_read_partial')
      return value.messages
    },
    async findHumanBlockerExchange(requestId) {
      requireEnabled()
      const result = await runner.run(this.compileMessageSearch(requestId))
      if (result.exitCode !== 0) throw new Error(`dws_blocker_search_failed:${result.exitCode}`)
      const value = parseJson(result.stdout, 'blocker-search')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_blocker_search_partial')
      const request = value.messages.find((message) => typeof message.text === 'string' && message.text.includes(`阻塞请求 ID：${requestId}`))
      if (request === undefined || typeof request.conversationId !== 'string' || typeof request.messageId !== 'string') return undefined
      const reply = value.messages.find((message) => message.quotedMessage?.messageId === request.messageId && typeof message.text === 'string' && message.text.trim() !== '')
      return { conversationId: request.conversationId, messageId: request.messageId, sentAt: request.createTime ?? request.time, ...(reply ? { replyMessageId: reply.messageId, reply: reply.text.trim() } : {}) }
    },
    async findOutboundMessage(groupId, outbound) {
      requireEnabled()
      const query = String(outbound.text ?? '').split(/\r?\n/u, 1)[0].replace(/[`*_~>#]/gu, '').trim().slice(0, 32)
      if (query.length < 12) return undefined
      const result = await runner.run(this.compileMessageSearch(query))
      if (result.exitCode !== 0) throw new Error(`dws_outbound_search_failed:${result.exitCode}`)
      const value = parseJson(result.stdout, 'outbound-search')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_outbound_search_partial')
      return value.messages.find((message) => message.conversationId === groupId && matchesOutbound(message, outbound))
    },
    async recallMessage(messageId) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const result = await runner.run(this.compileMessageRecall(messageId))
      if (result.exitCode !== 0) throw new Error(`dws_recall_failed:${result.exitCode}`)
      return parseJson(result.stdout, 'recall')
    },
    async loadMessageImages({ groupId, messageId, resourceRefs = [] }) {
      requireEnabled()
      const images = []
      const mediaUnavailable = []
      for (const resource of resourceRefs.filter((item) => item?.type === 'mediaId')) {
        let localPath
        try {
          const result = await runner.run(this.compileMessageResourceDownload({ groupId, messageId, resourceId: resource.resourceId }))
          if (result.exitCode !== 0) throw new Error(`exit_${result.exitCode}:${result.stderr}`)
          const receipt = parseJson(result.stdout, 'resource-download')
          if (typeof receipt.localPath !== 'string' || receipt.localPath === '') throw new Error('local_path_missing')
          localPath = path.resolve(runner.cwd, receipt.localPath)
          const cwdRoot = path.resolve(runner.cwd) + path.sep
          if (!localPath.startsWith(cwdRoot)) throw new Error('local_path_outside_runner_cwd')
          const extension = path.extname(localPath).toLowerCase()
          const mediaType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : 'image/png'
          images.push({ data: new Uint8Array(await readFile(localPath)), mediaType, name: path.basename(localPath) })
        } catch (error) {
          mediaUnavailable.push(`${resource.resourceId}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          if (localPath) await unlink(localPath).catch(() => undefined)
        }
      }
      return { images, mediaUnavailable }
    },
    startGroupSubscription(groupId, onEvent) {
      requireEnabled()
      const lifecycle = new EventEmitter()
      let ready = false
      let resolveReady
      const readyPromise = new Promise((resolve) => { resolveReady = resolve })
      const child = runner.spawn(this.compileGroupListen(groupId), {
        onStdoutLine(line) {
          try {
            const event = JSON.parse(line)
            if (!ready) throw new Error('dws_event_before_ready')
            onEvent(event)
          } catch (error) {
            lifecycle.emit('line-error', error, line)
          }
        },
        onStderrLine(line) {
          if (/^\[event\] ready\b/.test(line)) {
            ready = true
            resolveReady()
            lifecycle.emit('ready', line)
          }
        },
      })
      return { lifecycle, ready: readyPromise, done: child.done, stop: () => child.terminate('SIGTERM') }
    },
  }
}

export async function dispatchOutbox({ adapter, groupId, outbound }) {
  const before = await adapter.readGroup(groupId)
  const usableHistory = (history) => history.complete === true || (history.partial === false && (history.failedCount ?? 0) === 0 && Array.isArray(history.failures) && history.failures.length === 0)
  if (!usableHistory(before)) return { status: 'pending', reason: 'preflight_history_partial' }
  const existing = before.messages.find((message) => matchesOutbound(message, outbound))
  if (existing !== undefined) return { status: 'sent', messageId: existing.messageId, deduplicated: true }
  const historical = typeof adapter.findOutboundMessage === 'function' ? await adapter.findOutboundMessage(groupId, outbound) : undefined
  if (historical !== undefined) return { status: 'sent', messageId: historical.messageId, deduplicated: true }

  const sent = outbound.replyToMessageId && outbound.replyToSenderOpenDingTalkId
    ? await adapter.sendGroupReply({ groupId, text: outbound.text, idempotencyKey: outbound.outboundId, replyToMessageId: outbound.replyToMessageId, replyToSenderOpenDingTalkId: outbound.replyToSenderOpenDingTalkId, atOpenDingTalkIds: outbound.atOpenDingTalkIds ?? [] })
    : await adapter.sendGroup({ groupId, text: outbound.text, idempotencyKey: outbound.outboundId })
  if (sent.deliveryStatus === 'unknown') return { status: 'pending', reason: 'delivery_unknown', sendResult: sent }

  const after = await adapter.readGroup(groupId)
  if (!usableHistory(after)) return { status: 'pending', reason: 'postflight_history_partial', sendResult: sent }
  const delivered = after.messages.find((message) => matchesOutbound(message, outbound))
  if (delivered === undefined) return { status: 'pending', reason: 'message_not_observed', sendResult: sent }
  return { status: 'sent', messageId: delivered.messageId, deduplicated: false }
}
