import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const [dbPath, output] = process.argv.slice(2)
if (!dbPath || !output) throw new Error('需要只读控制库和输出路径')
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
 const messages = db.prepare('SELECT rowid AS sequence, body FROM message_runs WHERE rowid BETWEEN 109 AND 115 ORDER BY rowid').all().map(row => {
  const run = JSON.parse(row.body)
  const items = db.prepare('SELECT kind,body FROM message_items WHERE run_id=?').all(run.runId).map(item => ({ itemKind: item.kind, ...JSON.parse(item.body) }))
  const source = db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(run.sourceKey)
  return { sequence: row.sequence, runId: run.runId, sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, currentSourceVersion: source.current_version,
   bodySha256: createHash('sha256').update(run.body).digest('hex'), status: run.status, reason: run.reason ?? null,
   commands: items.filter(item => item.itemKind === 'command').map(item => ({ id: item.id, status: item.status })),
   notifications: items.filter(item => item.itemKind === 'notification').map(item => ({ id: item.id, status: item.status })),
   requests: items.filter(item => item.itemKind === 'request').map(item => ({ id: item.id, kind: item.kind, status: item.status })),
   intendedAction: [109,110].includes(row.sequence) ? '保留文件来源，按真实渠道回读补附件身份，不重放业务'
    : row.sequence === 112 ? '旧问候保留，不集中补发过时问候'
    : row.sequence === 111 ? '核对当前对话后按独立表格审核查询重判'
    : row.sequence === 113 ? '封存无读取器的内部目录请求，再按真实材料重判'
    : '按顺序受管重处理并关联同一事项；仅准备与审批，不批准生产执行' }
 })
 if (messages.length !== 7) throw new Error('原七条消息不完整')
 const result = { checkedAt: new Date().toISOString(), sourceDatabaseReadOnly: true, schema: db.prepare('PRAGMA user_version').get().user_version,
  applied: false, externalSends: 0, messages, boundary: '此清单仅为执行前准备。实际恢复前再次验证来源、command/effect/通知；渠道沟通需明确授权，生产执行须独立批准。' }
 await writeFile(output, JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({ count: messages.length, sourceDatabaseReadOnly: true, commands: messages.reduce((n,m)=>n+m.commands.length,0), notifications: messages.reduce((n,m)=>n+m.notifications.length,0), applied:false }))
} finally { db.close() }
