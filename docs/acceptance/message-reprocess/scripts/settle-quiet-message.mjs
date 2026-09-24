import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'

const dbPath = 'D:/dsh_home/workflows/runtime-v2/control.sqlite'
const runId = 'msg-replay-84fabf372125d5db6f770a6156d8c87d8a701fe9'
const mode = process.argv[2]
if (!['--check', '--apply'].includes(mode)) throw new Error('usage: node settle-quiet-message.mjs --check|--apply')
const reader = new DatabaseSync(dbPath, { readOnly: true })
const instanceId = reader.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id
const row = reader.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
const run = row && JSON.parse(row.body)
const commands = reader.prepare("SELECT count(*) AS n FROM message_items WHERE run_id=? AND kind='command'").get(runId).n
if (!instanceId || !run || run.conversationId !== 'cidq+PGRQW098/2Qh23wrl/ZQ==' || run.context?.sourceMessageId !== 'msgYfmuFKQY+FxfM44AxkH8qg==' || run.body.trim() !== '先别管它' || run.context?.quoteRefs?.length || commands || !['waiting', 'settled'].includes(run.status)) throw new Error('quiet_message_preflight_failed')
reader.close()
console.log(JSON.stringify({ mode, runId, status: run.status, reason: run.reason ?? null, commands }))
if (mode === '--check') process.exit(0)
if (run.status === 'settled') process.exit(0)
const store = await openExecutionStore({ dbPath, instanceId })
try {
  await store.command({ id: `quiet:${runId}`, kind: 'message.quiet', args: { runId, body: run.body } })
} finally { await store.close() }
