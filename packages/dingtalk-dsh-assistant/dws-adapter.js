import { assertGroupReply } from './workflow-notifications.js'
import { EventEmitter } from 'node:events'
import { readFile, unlink, realpath, stat, mkdtemp, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

function assertStableId(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}_required`)
  return value
}

function assertFileName(value) {
  assertStableId(value, 'file_name')
  if (value !== value.trim() || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) || /[. ]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) throw new Error('dws_file_name_invalid')
  return value
}

function parseJson(stdout, operation) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`dws_invalid_json:${operation}`, { cause: error })
  }
}

function commandError(prefix, result) {
  let serverErrorCode
  try { serverErrorCode = JSON.parse(result.stderr)?.error?.server_error_code } catch {}
  const error = new Error(`${prefix}:${result.exitCode}${serverErrorCode ? `:${serverErrorCode}` : ''}`)
  if (serverErrorCode) error.serverErrorCode = serverErrorCode
  return error
}

function comparableMessageText(value) {
  return String(value ?? '').replace(/[\p{P}\p{S}\s]/gu, '')
}

// DWS把段落边界回读为Markdown硬换行、软换行显示为单空格；保留其他空格和SQL字符。
export function normalizeApprovalNoticeText(value) {
  return typeof value === 'string' ? value.replace(/ {2}\r?\n/gu, '\n\n').replace(/\r?\n/gu, ' ') : value
}

export function matchesOutbound(message, outbound) {
  const actual = comparableMessageText(message.text), expected = comparableMessageText(outbound.text)
  const quotedId = message.quotedMessage?.messageId ?? message.quotedMessage?.message_id
  if ((quotedId ?? undefined) !== (outbound.replyToMessageId ?? undefined)) return false
  if (actual === expected) return true
  if (outbound.replyToMessageId) return expected.length > 0 && actual.includes(expected)
  if (expected.length < 24 || !actual.includes(expected)) return false
  return true
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
    compileHumanReplyListen() {
      return withProfile(['event', '+listen-im', '--kind', 'all-direct', '--events', 'message', '--format', 'ndjson'])
    },
    compileGroupRead(groupId) {
      return withProfile(['chat', '+chat-messages', '--group', assertStableId(groupId, 'group_id'), '--format', 'json'])
    },
    compileGroupReadRange(groupId, { start, end }) {
      return withProfile(['chat', '+chat-messages', '--group', assertStableId(groupId, 'group_id'), '--start', assertStableId(start, 'start'), '--end', assertStableId(end, 'end'), '--order', 'asc', '--page-all', '--page-limit', '50', '--format', 'json'])
    },
    compileGroupSend({ groupId, text, idempotencyKey }) {
      const args = ['chat', '+messages-send', '--as', 'user', '--group', assertStableId(groupId, 'group_id'), '--text', assertStableId(text, 'text'), '--idempotency-key', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    compileGroupFileSend({ groupId, fileName, idempotencyKey }) {
      const args = ['chat', '+messages-send', '--as', 'user', '--group', assertStableId(groupId, 'group_id'), '--msg-type', 'file', '--file', `./${assertFileName(fileName)}`, '--idempotency-key', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
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
      assertStableId(idempotencyKey, 'idempotency_key')
      if (idempotencyKey.length > 128) throw new Error('dws_self_send_uuid_too_long')
      const args = ['chat', '+messages-send', '--as', 'user', '--user', assertStableId(userId, 'human_user_id'), '--text', assertStableId(text, 'text'), '--idempotency-key', assertStableId(idempotencyKey, 'idempotency_key'), '--format', 'json']
      if (writesAuthorized) args.push('--yes')
      return withProfile(args)
    },
    compileSendStatus(openTaskId) {
      return withProfile(['chat', '+messages-query-send-status', '--open-task-id', assertStableId(openTaskId, 'open_task_id'), '--format', 'json'])
    },
    compileMessageResourceDownload({ groupId, messageId, resourceId, type = 'mediaId' }) {
      if (!['mediaId', 'fileId'].includes(type)) throw new Error('dws_resource_type_invalid')
      return withProfile(['chat', '+messages-resource-download', '--type', type, '--resource-id', assertStableId(resourceId, 'resource_id'), '--message-id', assertStableId(messageId, 'message_id'), '--open-conversation-id', assertStableId(groupId, 'group_id'), '--format', 'json'])
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
    async readMessage(groupId, messageId) {
      requireEnabled()
      const result = await runner.run(withProfile(['chat', '+messages-mget', '--msg-ids', assertStableId(messageId, 'message_id'), '--format', 'json']))
      if (result.exitCode !== 0) throw commandError('dws_read_failed', result)
      const value = parseJson(result.stdout, 'messages-mget')
      if (value.complete !== true || value.hasMore === true || value.failedCount !== 0 || !Array.isArray(value.failures) || value.failures.length
        || value.foundCount !== 1 || !Array.isArray(value.notFoundMessageIds) || value.notFoundMessageIds.length
        || !Array.isArray(value.messages) || value.messages.length !== 1) throw new Error('dws_message_read_incomplete')
      const message = value.messages[0]
      if (message.messageId !== messageId || message.conversationId !== groupId) throw new Error('dws_message_identity_mismatch')
      return message
    },
    async readGroup(groupId) {
      requireEnabled()
      const result = await runner.run(this.compileGroupRead(groupId))
      if (result.exitCode !== 0) throw commandError('dws_read_failed', result)
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
      assertGroupReply(request.text)
      const result = await runner.run(this.compileGroupSend(request))
      if (result.exitCode !== 0) throw commandError('dws_send_failed', result)
      return parseJson(result.stdout, 'send')
    },
    async sendGroupFile(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const result = await runner.run(this.compileGroupFileSend(request))
      if (result.exitCode !== 0) throw commandError('dws_file_send_failed', result)
      return parseJson(result.stdout, 'file-send')
    },
    async querySendStatus(openTaskId) {
      requireEnabled()
      const result = await runner.run(this.compileSendStatus(openTaskId))
      if (result.exitCode !== 0) throw commandError('dws_send_status_failed', result)
      return parseJson(result.stdout, 'send-status')
    },
    async readMessageFile({ groupId, messageId, expected }) {
      requireEnabled()
      if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 1 || !/^[a-f0-9]{64}$/u.test(expected.sha256 ?? '')) throw new Error('dws_file_expectation_required')
      const message = await this.readMessage(groupId, messageId)
      const refs = message.resourceRefs
      if (!Array.isArray(refs) || refs.length !== 1 || !['mediaId', 'fileId'].includes(refs[0]?.type) || typeof refs[0].resourceId !== 'string' || !refs[0].resourceId) throw new Error('dws_file_resource_identity_invalid')
      if (['messageType', 'msgType'].some(key => message[key] !== undefined && message[key] !== 'file')
        || message.messageType === undefined && message.msgType === undefined && refs[0].type !== 'fileId') throw new Error('dws_file_message_type_mismatch')
      const resourceRef = refs[0]
      if (expected.resourceRef && (expected.resourceRef.type !== resourceRef.type || expected.resourceRef.resourceId !== resourceRef.resourceId)) throw new Error('dws_file_resource_identity_mismatch')
      const downloadRoot = await mkdtemp(path.join(runner.cwd, 'file-readback-'))
      try {
        const args = this.compileMessageResourceDownload({ groupId, messageId, resourceId: resourceRef.resourceId, type: resourceRef.type })
        const result = await runner.run([...args, '--output', `${path.relative(runner.cwd, downloadRoot)}/`])
        if (result.exitCode !== 0) throw commandError('dws_file_download_failed', result)
        const receipt = parseJson(result.stdout, 'file-download')
        if (receipt.resourceId !== resourceRef.resourceId || receipt.resourceType !== resourceRef.type || receipt.messageId !== messageId
          || !Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes !== expected.size || typeof receipt.localPath !== 'string' || !receipt.localPath
          || receipt.complete === false || receipt.hasMore === true || receipt.failures?.length) throw new Error('dws_file_download_incomplete')
        const root = await realpath(downloadRoot)
        const localPath = await realpath(path.resolve(runner.cwd, receipt.localPath))
        const relative = path.relative(root, localPath)
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('dws_file_download_path_invalid')
        const info = await stat(localPath)
        if (!info.isFile() || info.size !== expected.size) throw new Error('dws_file_download_size_mismatch')
        const data = await readFile(localPath)
        const sha256 = createHash('sha256').update(data).digest('hex')
        if (data.length !== expected.size || sha256 !== expected.sha256) throw new Error('dws_file_download_content_mismatch')
        return { message, resourceRef, sha256, size: data.length, data: new Uint8Array(data), downloadReceipt: receipt }
      } finally { await rm(downloadRoot, { recursive: true, force: true }) }
    },
    async sendGroupReply(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      assertGroupReply(request.text)
      const result = await runner.run(this.compileGroupReply(request))
      if (result.exitCode !== 0) throw commandError('dws_reply_failed', result)
      return parseJson(result.stdout, 'reply')
    },
    async sendSelf(request) {
      const { openTaskId } = await this.sendSelfIntent(request)
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
    async sendSelfIntent(request) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const sent = await runner.run(this.compileSelfSend(request))
      if (sent.exitCode !== 0) {
        const error = commandError('dws_self_send_failed', sent)
        let payload, details
        try { payload = JSON.parse(sent.stderr); details = payload?.error } catch {}
        const errorMessage = details?.errorMsg ?? details?.error_message ?? details?.message
        const match = /^sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is (\d+)\.$/u.exec(errorMessage ?? '')
        const traceId = details?.trace_id ?? details?.traceId ?? payload?.trace_id ?? payload?.traceId
        // 仅平台明确的uuid前置拒绝可证明未发送；网络错误及未知回执仍保持unknown。
        if (String(error.serverErrorCode) === '1001' && match && Number(match[1]) === request.idempotencyKey.length && request.idempotencyKey.length > 128 && typeof traceId === 'string' && traceId.trim()) {
          error.knownNotSent = true
          error.proof = { kind: 'dws-uuid-rejected', idempotencyKey: request.idempotencyKey, serverErrorCode: '1001', errorMessage,
            traceId }
        }
        throw error
      }
      const receipt = parseJson(sent.stdout, 'self-send')
      const openTaskId = receipt.sendReceipt?.openTaskId ?? receipt.result?.result?.openTaskId
      if (typeof openTaskId !== 'string' || openTaskId === '') throw new Error('dws_self_send_task_id_missing')
      return { openTaskId }
    },
    async confirmSelfDelivery({ openTaskId, recipientUserId, text }) {
      const status = await this.querySendStatus(openTaskId)
      if (status.result?.sendStatus !== 'SUCCESS') return undefined
      const conversationId = status.messageRef?.openConversationId ?? status.result?.openConversationId
      const messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
      if (!conversationId || !messageId) throw new Error('dws_self_delivery_identity_missing')
      const message = await this.readMessage(conversationId, messageId)
      if (normalizeApprovalNoticeText(message.text) !== normalizeApprovalNoticeText(text)
        || message.recipientUserId !== undefined && message.recipientUserId !== recipientUserId) throw new Error('dws_self_delivery_content_mismatch')
      return { openTaskId, conversationId, messageId, ...(message.createTime ? { sentAt: message.createTime } : {}) }
    },
    async findWorkflowApprovalNotice({ requestId, recipientUserId, text, conversationId }) {
      requireEnabled()
      const result = await runner.run(this.compileMessageSearch(requestId.slice(-12)))
      if (result.exitCode !== 0) throw commandError('dws_workflow_approval_search_failed', result)
      const value = parseJson(result.stdout, 'workflow-approval-search')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_workflow_approval_search_partial')
      const matches = value.messages.filter(message => normalizeApprovalNoticeText(message.text) === normalizeApprovalNoticeText(text) && message.messageId && message.conversationId
        && (conversationId ? message.conversationId === conversationId : message.recipientUserId === recipientUserId))
      if (matches.length > 1) throw new Error('dws_workflow_approval_search_ambiguous')
      if (!matches.length) return undefined
      const message = await this.readMessage(matches[0].conversationId, matches[0].messageId)
      if (normalizeApprovalNoticeText(message.text) !== normalizeApprovalNoticeText(text) || (!conversationId && message.recipientUserId !== recipientUserId)) throw new Error('dws_self_delivery_content_mismatch')
      return { conversationId: message.conversationId, messageId: message.messageId, ...(message.createTime ? { sentAt: message.createTime } : {}) }
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
      if (result.exitCode !== 0) throw commandError('dws_outbound_search_failed', result)
      const value = parseJson(result.stdout, 'outbound-search')
      if (!Array.isArray(value.messages) || value.complete !== true || value.hasMore === true || (value.failedCount ?? 0) !== 0) throw new Error('dws_outbound_search_partial')
      return value.messages.find((message) => message.conversationId === groupId && matchesOutbound(message, outbound))
    },
    async recallMessage(messageId) {
      requireEnabled()
      if (!writesAuthorized) throw new Error('dws_write_not_authorized')
      const result = await runner.run(this.compileMessageRecall(messageId))
      if (result.exitCode !== 0) throw commandError('dws_recall_failed', result)
      return parseJson(result.stdout, 'recall')
    },
    async readMessageResource(groupId, messageId, resource) {
      requireEnabled()
      const downloadRoot = await mkdtemp(path.join(runner.cwd, 'coordination-resource-'))
      try {
      const args = this.compileMessageResourceDownload({ groupId, messageId, resourceId: resource.resourceId, type: resource.type })
      const result = await runner.run([...args, '--output', path.relative(runner.cwd, downloadRoot)])
      if (result.exitCode !== 0) throw commandError('dws_resource_read_failed', result)
      const receipt = parseJson(result.stdout, 'resource-download')
      if (receipt.complete === false || receipt.hasMore === true || receipt.failures?.length || typeof receipt.localPath !== 'string' || !receipt.localPath) throw new Error('dws_resource_read_incomplete')
      const root = await realpath(downloadRoot)
      const localPath = await realpath(path.resolve(runner.cwd, receipt.localPath))
      const relative = path.relative(root, localPath)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('dws_resource_path_outside_workspace')
      try {
        const info = await stat(localPath)
        if (!info.isFile() || info.size === 0 || info.size > 8 * 1024 * 1024 || receipt.sizeBytes !== undefined && receipt.sizeBytes !== info.size) throw new Error('dws_resource_size_invalid')
        const data = new Uint8Array(await readFile(localPath))
        const extension = path.extname(localPath).toLowerCase()
        const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
        if (imageTypes[extension]) return { image: { data, mediaType: imageTypes[extension], name: path.basename(localPath) } }
        if (extension === '.xlsx') {
          const { default: ExcelJS } = await import('exceljs')
          const workbook = new ExcelJS.Workbook()
          await workbook.xlsx.load(data)
          if (workbook.model.media?.length) throw new Error('coordination_workbook_embedded_media_unsupported')
          const sheets = workbook.worksheets.map(sheet => {
            const rows = []
            sheet.eachRow(row => {
              const cells = []
              row.eachCell(cell => cells.push({ address: cell.address, value: cell.value,
                ...(cell.isMerged ? { mergedInto: cell.master.address } : {}) }))
              rows.push({ row: row.number, cells })
            })
            return { name: sheet.name, state: sheet.state, rowCount: sheet.rowCount, columnCount: sheet.columnCount, rows }
          })
          return { text: JSON.stringify({ format: 'xlsx', name: path.basename(localPath),
            sourceSha256: createHash('sha256').update(data).digest('hex'),
            formulasRecalculated: false, formulaResults: '文件保存的缓存值，未执行公式或外链', sheets }),
            mediaType: 'application/json', complete: true }
        }
        if (!['.txt', '.md', '.sql', '.json', '.csv', '.tsv', '.xml', '.html', '.log'].includes(extension)) throw new Error('coordination_resource_format_unsupported')
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), mediaType: 'text/plain' }
      } finally { await unlink(localPath) }
      } finally { await rm(downloadRoot, { recursive: true, force: true }) }
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
    startHumanReplySubscription(onEvent) {
      requireEnabled()
      const lifecycle = new EventEmitter()
      let ready = false
      let resolveReady
      const readyPromise = new Promise((resolve) => { resolveReady = resolve })
      const child = runner.spawn(this.compileHumanReplyListen(), {
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

export async function dispatchOutbox({ adapter, groupId, outbound, beforeSend, beforeReadback }) {
  let phase = 'preflight'
  try {
    await beforeReadback?.()
    const before = await adapter.readGroup(groupId)
    const usableHistory = (history) => history.complete === true || (history.partial === false && (history.failedCount ?? 0) === 0 && Array.isArray(history.failures) && history.failures.length === 0)
    if (!usableHistory(before)) return { status: 'pending', reason: 'preflight_history_partial' }
    const existing = before.messages.find((message) => matchesOutbound(message, outbound))
    if (existing !== undefined) return { status: 'sent', messageId: assertStableId(existing.messageId, 'outbox_message_id'), deduplicated: true }
    const historical = typeof adapter.findOutboundMessage === 'function' ? await adapter.findOutboundMessage(groupId, outbound) : undefined
    if (historical !== undefined) return { status: 'sent', messageId: assertStableId(historical.messageId, 'outbox_message_id'), deduplicated: true }

    assertGroupReply(outbound.text, outbound.taskIds ?? [])
    // 在完整预检后、实际外发前持久领取；替换提交可能已使旧快照失效。
    if (beforeSend && !(await beforeSend())) return { status: 'superseded' }
    phase = 'send'
    const sent = outbound.replyToMessageId && outbound.replyToSenderOpenDingTalkId
      ? await adapter.sendGroupReply({ groupId, text: outbound.text, idempotencyKey: outbound.outboundId, replyToMessageId: outbound.replyToMessageId, replyToSenderOpenDingTalkId: outbound.replyToSenderOpenDingTalkId, atOpenDingTalkIds: outbound.atOpenDingTalkIds ?? [] })
      : await adapter.sendGroup({ groupId, text: outbound.text, idempotencyKey: outbound.outboundId })
    if (sent?.deliveryStatus === 'unknown') return { status: 'pending', reason: 'delivery_unknown', sendResult: sent }

    phase = 'postflight'
    await beforeReadback?.()
    const after = await adapter.readGroup(groupId)
    if (!usableHistory(after)) return { status: 'pending', reason: 'postflight_history_partial', sendResult: sent }
    const delivered = after.messages.find((message) => matchesOutbound(message, outbound))
    if (delivered === undefined) return { status: 'pending', reason: 'message_not_observed', sendResult: sent }
    return { status: 'sent', messageId: assertStableId(delivered.messageId, 'outbox_message_id'), deduplicated: false }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    error.deliveryPendingReason = `${phase}_failed`
    throw error
  }
}
