import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'

const ok = value => ({ exitCode: 0, stdout: JSON.stringify(value) })
const data = Buffer.from([0, 255, 128, 13, 10, 42])
const expected = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
const message = { conversationId: 'g', messageId: 'm', messageType: 'file', resourceRefs: [{ type: 'mediaId', resourceId: 'resource' }] }
const mget = row => ({ complete: true, hasMore: false, failedCount: 0, failures: [], foundCount: 1, notFoundMessageIds: [], messages: [row] })

test('文件发送绑定 user、profile、相对文件名并保持写授权门禁', async () => {
  let calls = 0
  const runner = { run: async args => { calls++; assert.equal(args.includes('--yes'), true); return ok({ sendReceipt: { openTaskId: 'task' } }) } }
  const request = { groupId: 'g', fileName: '产物 报告.sql', idempotencyKey: 'delivery' }
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, profile: 'corp:user', runner })
  assert.deepEqual(adapter.compileGroupFileSend(request), ['chat', '+messages-send', '--as', 'user', '--group', 'g', '--msg-type', 'file', '--file', './产物 报告.sql', '--idempotency-key', 'delivery', '--format', 'json', '--yes', '--profile', 'corp:user'])
  assert.deepEqual(await adapter.sendGroupFile(request), { sendReceipt: { openTaskId: 'task' } })
  for (const options of [{}, { enabled: true }]) await assert.rejects(createDwsAdapter({ ...options, runner }).sendGroupFile(request), /disabled|not_authorized/u)
  assert.equal(calls, 1)
  for (const fileName of ['../a', 'C:\\a', 'a/b', 'a\\b', 'CON.sql', 'a.', 'a\n.sql']) assert.throws(() => adapter.compileGroupFileSend({ ...request, fileName }), /file_name_invalid/u)
})

test('发送状态只查询并保留真实原始回执', async () => {
  const adapter = createDwsAdapter({ enabled: true, profile: 'corp:user', runner: { run: async args => {
    assert.deepEqual(args, ['chat', '+messages-query-send-status', '--open-task-id', 'task', '--format', 'json', '--profile', 'corp:user'])
    return ok({ result: { sendStatus: 'PROCESSING' } })
  } } })
  assert.deepEqual(await adapter.querySendStatus('task'), { result: { sendStatus: 'PROCESSING' } })
})

async function harness(t, { row = message, bytes = data, receipt = {} } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dws-file-test-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let calls = 0
  const adapter = createDwsAdapter({ enabled: true, runner: { cwd, run: async args => {
    calls++
    if (args.includes('+messages-mget')) return ok(mget(row))
    const output = args[args.indexOf('--output') + 1]
    const localPath = path.join(output, '产物.sql')
    await writeFile(path.resolve(cwd, localPath), bytes)
    return ok({ messageId: row.messageId, resourceId: row.resourceRefs[0].resourceId, resourceType: row.resourceRefs[0].type, localPath, sizeBytes: bytes.length, ...receipt })
  } } })
  return { adapter, cwd, calls: () => calls }
}

test('文件回读保留原始二进制字节、精确资源身份、大小和sha256，并清理临时下载', async t => {
  const h = await harness(t)
  const value = await h.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected })
  assert.deepEqual(Buffer.from(value.data), data)
  assert.equal(value.sha256, expected.sha256)
  assert.deepEqual(value.resourceRef, message.resourceRefs[0])
  assert.equal(h.calls(), 2)
  assert.deepEqual(await readdir(h.cwd), [])
})

test('错误目标、类型、资源或同名不同字节均不能核验送达', async t => {
  for (const row of [{ ...message, conversationId: 'other' }, { ...message, messageId: 'other' }, { ...message, messageType: 'text' }, { ...message, resourceRefs: [] }]) {
    const h = await harness(t, { row })
    await assert.rejects(h.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected }), /mismatch|identity_invalid/u)
    assert.equal(h.calls(), 1)
  }
  const changed = await harness(t, { bytes: Buffer.from([1, 255, 128, 13, 10, 42]) })
  await assert.rejects(changed.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected }), /content_mismatch/u)
  const receipt = await harness(t, { receipt: { resourceId: 'other' } })
  await assert.rejects(receipt.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected }), /download_incomplete/u)
  const resource = await harness(t)
  await assert.rejects(resource.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected: { ...expected, resourceRef: { type: 'mediaId', resourceId: 'other' } } }), /resource_identity_mismatch/u)
  assert.equal(resource.calls(), 1)
})

test('真实CLI文件投影缺少类型时仅唯一fileId能证明文件，原下载合同保持可核验', async t => {
  // v1.0.61 授权测试群的实际 mget：无 messageType/msgType，资源身份来自 fileId，不依赖正文或同名。
  const row = { conversationId: 'g', messageId: 'm', senderId: 'DOii4iiLKtZz5A91yyWlCtDQU7Ba43QHb0t', resourceRefs: [{ type: 'fileId', resourceId: 'MyQA2dXW7ZZ4z1B1U1347QEk8zlwrZgb', name: '文件交付测试 md.md' }], text: '[文件] 文件交付测试 md.md fileId: MyQA2dXW7ZZ4z1B1U1347QEk8zlwrZgb' }
  const h = await harness(t, { row })
  const result = await h.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected })
  assert.equal(result.resourceRef.type, 'fileId')
  assert.equal(result.downloadReceipt.resourceType, 'fileId')
  assert.deepEqual(Buffer.from(result.data), data)
  for (const invalid of [{ ...row, resourceRefs: [{ type: 'mediaId', resourceId: 'resource' }] }, { ...row, msgType: 'image' }, { ...row, messageType: 'file', msgType: 'text' }]) {
    const denied = await harness(t, { row: invalid })
    await assert.rejects(denied.adapter.readMessageFile({ groupId: 'g', messageId: 'm', expected }), /message_type_mismatch/u)
    assert.equal(denied.calls(), 1)
  }
})
