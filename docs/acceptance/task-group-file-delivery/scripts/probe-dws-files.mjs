import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

const exec = promisify(execFile), args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const profile = option('--profile'), group = option('--group'), directory = resolve(option('--directory') ?? 'docs/acceptance/task-group-file-delivery/round-1')
if (!profile || !group || args.filter(arg => ['--check', '--execute'].includes(arg)).length !== 1) throw new Error('profile/group and exactly one of --check/--execute required')
const run = async (command, cwd = process.cwd()) => JSON.parse((await exec('dws', [...command, '--profile', profile, '--format', 'json'], { cwd, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout)
const safe = value => JSON.parse(JSON.stringify(value, (key, item) => /token|secret|url/iu.test(key) ? '[redacted]' : item))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const search = await run(['chat', '+chat-search', '--query', group, '--page-all'])
if (!search.complete || search.hasMore || search.failedCount || search.chats?.length !== 1 || search.chats[0].name !== group) throw new Error('TEST_GROUP_NOT_UNIQUE')
const groupId = search.chats[0].openConversationId
if (args.includes('--check')) { console.log(JSON.stringify({ check: 'PASS', group, groupId, profile, writes: 0 })); process.exit(0) }
await mkdir(directory, { recursive: true })
await writeFile(join(directory, 'group-readback.json'), JSON.stringify(safe(search), null, 2))
const formats = (option('--formats') ?? 'md').split(',')
const fixtures = {
  md: Buffer.from('# 文件交付测试\n\n仅用于群聊文件传输验收，请勿建立业务任务。\n标识：task-group-file-delivery-20260928\n', 'utf8'),
  sql: Buffer.from('-- 文件交付测试，仅作为附件，不执行数据库变更。\nSELECT 1 AS file_delivery_fixture;\n', 'utf8'),
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQy7vzHwAEfgJodQLI1QAAAABJRU5ErkJggg==', 'base64'),
}
for (const format of formats) {
  if (!fixtures[format]) throw new Error('FIXTURE_FORMAT_INVALID')
  const fileName = `文件交付测试 ${format}.${format}`, filePath = join(directory, fileName), ackPath = join(directory, `${format}-ack.json`)
  await writeFile(filePath, fixtures[format])
  let ack
  try { ack = JSON.parse(await readFile(ackPath, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    // 领取文件保证脚本重跑不会重新发送未知操作；异常时保留 marker。
    const marker = join(directory, `${format}-send-started.json`)
    try { await stat(marker); throw new Error('PRIOR_SEND_UNKNOWN_RECONCILE_REQUIRED') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await writeFile(marker, JSON.stringify({ groupId, fileName, sha256: hash(fixtures[format]) }), { flag: 'wx' })
    ack = await run(['chat', '+messages-send', '--as', 'user', '--group', groupId, '--msg-type', 'file', '--file', `./${fileName}`, '--idempotency-key', `file-delivery-probe-20260928-${format}`, '--yes'], directory)
    await writeFile(ackPath, JSON.stringify(safe(ack), null, 2), { flag: 'wx' })
  }
  const openTaskId = ack.sendReceipt?.openTaskId ?? ack.result?.openTaskId ?? ack.result?.result?.openTaskId
  if (!openTaskId) throw new Error('SEND_TASK_ID_MISSING')
  let status, messageId
  for (let i = 0; i < 10; i++) {
    status = await run(['chat', '+messages-query-send-status', '--open-task-id', openTaskId])
    messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
    if (messageId) break
    await setTimeout(500)
  }
  await writeFile(join(directory, `${format}-status.json`), JSON.stringify(safe(status), null, 2))
  if (!messageId) throw new Error('MESSAGE_ID_NOT_CONFIRMED')
  const message = await run(['chat', '+messages-mget', '--msg-ids', messageId])
  await writeFile(join(directory, `${format}-message.json`), JSON.stringify(safe(message), null, 2))
  console.log(JSON.stringify({ format, fileName, groupId, openTaskId, messageId, size: fixtures[format].length, sha256: hash(fixtures[format]), ack: safe(ack), message: safe(message) }))
}
