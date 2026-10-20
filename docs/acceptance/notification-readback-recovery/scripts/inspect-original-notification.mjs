import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createDwsAdapter } from '../../../../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { readTaskNotificationDelivery } from '../../../../packages/dingtalk-dsh-assistant/task-notification-readback.js'

// 只读原通知与精确渠道消息；该工具没有发送、对账或数据库写入入口。
const [dbPath, notificationId, dwsPath] = process.argv.slice(2)
if (!dbPath || !notificationId || !dwsPath) throw new Error('需要数据库路径、原通知ID和DWS可执行路径')
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const notification = JSON.parse(db.prepare('SELECT body FROM dynamic_notifications WHERE id=?').get(notificationId).body)
  const calls = []
  const runner = { async run(args) {
    if (!['+messages-query-send-status', '+messages-mget'].includes(args[1])) throw new Error('只允许精确发送状态与消息读取')
    calls.push(args[1])
    const result = spawnSync(dwsPath, args, {encoding:'utf8',windowsHide:true,timeout:60000})
    if (result.error) throw result.error
    return {exitCode:result.status,stdout:result.stdout,stderr:result.stderr}
  } }
  const adapter = createDwsAdapter({enabled:true,runner})
  const proof = await readTaskNotificationDelivery(adapter, notification)
  console.log(JSON.stringify({notificationId,state:notification.state,sendAttemptCount:notification.sendAttemptCount,
    readbackAttemptCount:notification.readbackAttemptCount,storedReceipt:notification.receipt?.messageId ? {
      messageId:notification.receipt.messageId,identity:notification.receipt.identity,sentAt:notification.receipt.sentAt,
      mentionVerification:notification.receipt.mentionVerification} : null,
    proof:proof ?? null,calls,writes:0}, null, 2))
  if (!proof) process.exitCode=1
} finally {db.close()}
