import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCoordinationResourceTools, readPublicResource } from '../packages/dingtalk-dsh-assistant/coordination-resources.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'

function harness(options = {}) {
  let active = true
  const request = { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '当前', quotedMessage: { messageId: 'b' } }] }
  const tools = new Map(createCoordinationResourceTools({ request, assertCurrent(exec) { if (!active || exec?.requestId !== 'r') throw new Error('wrong_request') }, ...options }).map(tool => [tool.name, tool]))
  return { request, stop() { active = false }, call: (name, input, exec = { requestId: 'r' }) => tools.get(name).execute(input, exec), render: (name, value) => tools.get(name).output.render({}, value) }
}

test('引用只沿已验证消息扩展，错群/缺正文/假完整不能成为新授权入口', async () => {
  const messages = { b: { groupId: 'g', messageId: 'b', text: '上游', quotedMessage: { messageId: 'c' } }, c: { groupId: 'g', messageId: 'c', text: '更上游' } }
  let reads = 0
  const h = harness({ readMessage: async (_group, id) => { reads++; return messages[id] } })
  await assert.rejects(h.call('group_message_get', { messageId: 'c' }), /outside_request/)
  assert.equal(reads, 0)
  assert.equal((await h.call('group_message_get', { messageId: 'b' })).message.text, '上游')
  assert.equal((await h.call('group_message_get', { messageId: 'c' })).message.text, '更上游')
  for (const change of [{ groupId: 'other' }, { complete: false }, { hasMore: true }, { text: undefined }, { failures: ['failed'] }]) {
    const bad = harness({ readMessage: async () => ({ ...messages.b, ...change }) })
    await assert.rejects(bad.call('group_message_get', { messageId: 'b' }), /identity_or_completeness/)
    await assert.rejects(bad.call('group_message_get', { messageId: 'c' }), /outside_request/)
  }
})

test('资源ID必须来自当前消息，文本真实分页，读取失败不缓存为完整', async () => {
  let reads = 0
  const h = harness({ readMessage: async (_group, id) => ({ groupId: 'g', messageId: id, text: '上游', resourceRefs: [{ type: 'fileId', resourceId: 'file-a' }] }), readResource: async () => { reads++; return reads === 1 ? { text: '错误正文', complete: false } : { text: '甲'.repeat(9000), mediaType: 'text/plain' } } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'fileId', resourceId: 'foreign' }), /outside_request/)
  assert.equal(reads, 0)
  const args = { messageId: 'b', type: 'fileId', resourceId: 'file-a' }
  await assert.rejects(h.call('group_resource_get', args), /read_incomplete/)
  await assert.rejects(h.call('group_resource_get', { ...args, offset: 8000 }), /unread_gap/)
  const first = await h.call('group_resource_get', args)
  assert.equal(first.complete, false)
  assert.equal(first.hasMore, true)
  const next = await h.call('group_resource_get', { ...args, offset: first.nextOffset })
  assert.equal(next.complete, true)
  assert.equal(first.text + next.text, '甲'.repeat(9000))
  assert.equal(reads, 2)
  assert.equal(first.contentFingerprint, next.contentFingerprint)
})

test('公网链接限于精确消息引用，异步读取后请求过期不能交付', async () => {
  let calls = 0
  const h = harness({ readMessage: async (_group, id) => ({ groupId: 'g', messageId: id, text: 'https://example.org/report' }), readUrl: async () => { calls++; h.stop(); return { text: '公开资料' } } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'url', resourceId: 'https://example.org/other' }), /outside_request/)
  assert.equal(calls, 0)
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'url', resourceId: 'https://example.org/report' }), /wrong_request/)
})

test('外链拒绝凭据、非HTTPS和私有/保留DNS地址且不建立连接', async () => {
  for (const url of ['http://example.org', 'https://user:secret@example.org', 'https://example.org:8080']) await assert.rejects(readPublicResource(url), /not_public_https/)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '0.0.0.0']) await assert.rejects(readPublicResource('https://example.org', { resolve: async () => [{ address, family: 4 }] }), /private_address/)
})

test('原生图片先验证附件字节，缺失图片不能返回完整', async () => {
  const attachment = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 5, width: 1, height: 1 }
  const h = harness({ request: { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '图片', imageRefs: [attachment] }] }, readImage: async () => { throw new Error('image_missing') } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' }), /image_missing/)
  const valid = harness({ request: h.request, readImage: async () => ({ ref: attachment, data: new Uint8Array(5) }) })
  const own = harness({ request: { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '图片', imageRefs: [attachment] }] }, readImage: async () => ({ ref: attachment, data: new Uint8Array(5) }) })
  const output = await own.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' })
  assert.equal(output.complete, true)
  assert.deepEqual(own.render('group_resource_get', output).at(-1), { type: 'image', attachment })
  // 独立请求没有继承上一个请求的附件身份。
  await assert.rejects(valid.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' }), /outside_request/)
})

test('DWS资源下载实际检查大小与路径，正文读取后清理临时文件', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'coord-resource-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let mismatch = false
  const adapter = createDwsAdapter({ enabled: true, profile: 'test-profile', runner: { cwd, async run(args) {
    assert.ok(args.includes('+messages-resource-download'))
    assert.equal(args[args.indexOf('--type') + 1], 'fileId')
    assert.equal(args[args.indexOf('--profile') + 1], 'test-profile')
    const localPath = path.join(args[args.indexOf('--output') + 1], 'resource.txt')
    await writeFile(path.join(cwd, localPath), '正文')
    return { exitCode: 0, stdout: JSON.stringify({ localPath, sizeBytes: mismatch ? 1 : 6 }) }
  } } })
  assert.equal((await adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' })).text, '正文')
  await assert.rejects(access(path.join(cwd, 'resource.txt')))
  mismatch = true
  await assert.rejects(adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' }), /size_invalid/)
  await assert.rejects(access(path.join(cwd, 'resource.txt')))
})

test('DWS 文件卡片只允许同名同 fileId 的精确下载尾注差异，真实内容或资源变更仍拒绝', async () => {
  const base = '[文件] 翻译测试_260922.xlsx fileId: fixture-file-translation-001'
  const source = { messageId: 'a', sourceKind: 'dingtalk', text: `${base} 注意：如需下载使用dws drive download命令下载` }
  const remote = { messageId: 'a', groupId: 'g', text: base, resourceRefs: [{ type: 'fileId', resourceId: 'fixture-file-translation-001', name: '翻译测试_260922.xlsx' }] }
  const make = (message = remote, inbound = source) => harness({ request: { requestId: 'r', groupId: 'g', messages: [inbound] }, readMessage: async () => message, readResource: async () => ({ text: '测试正文' }) })
  const h = make()
  assert.equal((await h.call('group_message_get', { messageId: 'a' })).message.text, base)
  assert.equal((await h.call('group_resource_get', { messageId: 'a', type: 'fileId', resourceId: remote.resourceRefs[0].resourceId })).text, '测试正文')
  for (const changed of [
    { ...remote, resourceRefs: [{ ...remote.resourceRefs[0], resourceId: 'different-file' }] },
    { ...remote, resourceRefs: [{ ...remote.resourceRefs[0], name: '另一个文件.xlsx' }] },
    { ...remote, resourceRefs: [] },
    { ...remote, text: base.replace('260922', '260923') },
    { ...remote, text: '已经修改的普通文本', resourceRefs: [] },
  ]) await assert.rejects(make(changed).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
  await assert.rejects(make({ ...remote, text: '原文', resourceRefs: [] }, { ...source, text: '原文 注意：如需下载使用dws drive download命令下载' }).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
  await assert.rejects(make(remote, { ...source, text: `${source.text} 追加业务要求` }).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
})
