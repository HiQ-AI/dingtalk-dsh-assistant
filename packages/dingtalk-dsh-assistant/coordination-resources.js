import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'

const MAX_BYTES = 2 * 1024 * 1024
const PAGE_CHARS = 8_000
const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix)

// 精确引用的公网 HTTPS 文本，不跟随重定向；DNS 结果固定到本次连接，避免重绑定。
export async function readPublicResource(url, { resolve = lookup } = {}) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443') throw new Error('coordination_url_not_public_https')
  const addresses = await resolve(parsed.hostname, { family: 4, all: true })
  if (!addresses.length || addresses.some(item => item.family !== 4 || blocked.check(item.address))) throw new Error('coordination_url_private_address')
  return new Promise((resolve, reject) => {
    const request = httpsRequest(parsed, { method: 'GET', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/plain, text/html, application/json' }, lookup(_host, options, callback) { const answer = addresses[0]; callback(null, options.all ? [answer] : answer.address, answer.family) } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('coordination_url_http_status:' + response.statusCode)); return }
      const type = String(response.headers['content-type'] ?? '').split(';')[0]
      if (!['text/plain', 'text/html', 'text/markdown', 'text/csv', 'application/json', 'application/xml'].includes(type)) { response.destroy(); reject(new Error('coordination_resource_format_unsupported')); return }
      let bytes = 0
      const chunks = []
      response.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) response.destroy(new Error('coordination_resource_too_large')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { try { resolve({ text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), mediaType: type }) } catch { reject(new Error('coordination_resource_encoding_unsupported')) } })
    })
    request.on('error', reject)
    request.end()
  })
}

const refsFor = message => {
  const refs = [...(message.resourceRefs ?? []), ...(message.imageRefs ?? []).map(attachment => ({ type: 'attachment', resourceId: attachment.attachmentId ?? attachment.id, attachment }))]
  for (const match of String(message._sourceMessageText ?? message.text ?? '').matchAll(/https:\/\/[^\s<>"）)]+/gu)) refs.push({ type: 'url', resourceId: match[0] })
  return [...new Map(refs.filter(ref => typeof ref.resourceId === 'string').map(ref => [ref.type + ':' + ref.resourceId, ref])).values()]
}

// DWS 事件文件卡片带下载提示，精确消息回读不带；只接受同名、同 fileId 的这一种展示差异。
const sameDwsFileProjection = (message, remote) => {
  if (message.sourceKind !== 'dingtalk' || typeof remote.text !== 'string'
    || message.text !== `${remote.text} 注意：如需下载使用dws drive download命令下载`) return false
  const file = /^\[文件\] (.+) fileId: ([^\s]+)$/u.exec(remote.text)
  const refs = remote.resourceRefs
  return Boolean(file && Array.isArray(refs) && refs.length === 1
    && refs[0].type === 'fileId' && refs[0].resourceId === file[2] && refs[0].name === file[1])
}

// 请求内的唯一只读入口。外部消息只能沿已知引用链扩展；资源只能从这些消息的精确引用读取。
export function createCoordinationResourceTools({ request, assertCurrent, readMessage, readResource, readImage, readUrl = readPublicResource }) {
  const known = new Map((request.messages ?? []).map(message => [message.messageId, { ...message, text: message._sourceMessageText ?? message.text }]))
  const allowed = new Set([...known.keys(), ...[...known.values()].map(message => message.quotedMessage?.messageId).filter(Boolean)])
  const loaded = new Map()
  const readOffsets = new Map()
  const getMessage = async (messageId, exec) => {
    assertCurrent(exec)
    if (!allowed.has(messageId)) throw new Error('coordination_message_outside_request')
    let message = known.get(messageId)
    // 持久化入站投影可能不保留 fileId 资源；远端精确读回恢复当前引用身份。
    if (!message || !['web', 'internal'].includes(message.sourceKind) && !message.resourceRefs && !message.imageRefs?.length) {
      if (!readMessage) { if (!message) throw new Error('coordination_message_reader_unavailable') }
      else {
        const remote = await readMessage(request.groupId, messageId)
        assertCurrent(exec)
        if (remote?.messageId !== messageId || remote.groupId !== request.groupId || remote.complete === false || remote.hasMore === true || remote.failures?.length) throw new Error('coordination_message_identity_or_completeness_invalid')
        if (message && remote.text !== message.text && !sameDwsFileProjection(message, remote)) throw new Error('coordination_message_version_changed')
        message = remote
      }
    }
    if (message?.messageId !== messageId || message.groupId !== undefined && message.groupId !== request.groupId || typeof message.text !== 'string' || message.complete === false || message.hasMore === true) throw new Error('coordination_message_identity_or_completeness_invalid')
    known.set(messageId, message)
    if (message.quotedMessage?.messageId) allowed.add(message.quotedMessage.messageId)
    return message
  }
  const page = (text, offset, key) => {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error('coordination_resource_offset_invalid')
    if (offset > (readOffsets.get(key) ?? 0)) throw new Error('coordination_resource_unread_gap')
    const nextOffset = Math.min(text.length, offset + PAGE_CHARS)
    readOffsets.set(key, Math.max(readOffsets.get(key) ?? 0, nextOffset))
    return { text: text.slice(offset, nextOffset), offset, nextOffset, totalChars: text.length, hasMore: nextOffset < text.length, complete: nextOffset === text.length, contentFingerprint: createHash('sha256').update(text).digest('hex') }
  }
  const output = { schema: { type: 'object' }, render: (_args, out) => [{ type: 'text', text: JSON.stringify(out) }, ...(out.imageRefs ?? []).map(attachment => ({ type: 'image', attachment }))] }
  return [{ name: 'group_message_get', description: '分页读取本请求消息及其上游引用，保留资源身份。hasMore 为 true 必须继续；资源正文独立读取。',
    parameters: { type: 'object', properties: { messageId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['messageId'], additionalProperties: false }, output,
    async execute({ messageId, offset = 0 }, exec) {
      const message = await getMessage(messageId, exec)
      const { facts, units, _sourceMessageText, ...projection } = message
      const slice = page(message.text, offset, 'message:' + messageId)
      return { ...slice, message: { ...projection, text: slice.text }, resourceRefs: refsFor(message).map(({ attachment, ...ref }) => ref), resourcesRead: false }
    },
  }, { name: 'group_resource_get', description: '只读本请求消息明确引用的附件或公网HTTPS文本；不能读取任意ID/URL。文本按offset分页，图片通过原生附件返回，其他格式明确失败。',
    parameters: { type: 'object', properties: { messageId: { type: 'string' }, type: { type: 'string', enum: ['mediaId', 'fileId', 'attachment', 'url'] }, resourceId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['messageId', 'type', 'resourceId'], additionalProperties: false }, output,
    async execute({ messageId, type, resourceId, offset = 0 }, exec) {
      const message = await getMessage(messageId, exec)
      const ref = refsFor(message).find(item => item.type === type && item.resourceId === resourceId)
      if (!ref) throw new Error('coordination_resource_outside_request')
      const key = messageId + ':' + type + ':' + resourceId
      let value = loaded.get(key)
      if (!value) {
        if (type === 'attachment') { if (!readImage) throw new Error('coordination_resource_reader_unavailable'); await readImage(ref.attachment); value = { imageRefs: [ref.attachment] } }
        else if (type === 'url') value = await readUrl(resourceId)
        else { if (!readResource) throw new Error('coordination_resource_reader_unavailable'); value = await readResource(request.groupId, messageId, ref) }
        assertCurrent(exec)
        if (!value || value.complete === false || value.hasMore === true || value.failures?.length || value.mediaUnavailable?.length || typeof value.text !== 'string' && !value.imageRefs?.length) throw new Error('coordination_resource_read_incomplete')
        loaded.set(key, value)
      }
      if (value.imageRefs) { if (offset !== 0) throw new Error('coordination_resource_offset_invalid'); return { messageId, type, resourceId, complete: true, imageRefs: value.imageRefs } }
      return { messageId, type, resourceId, mediaType: value.mediaType, ...page(value.text, offset, key) }
    },
  }]
}
