import { createNodeDwsRunner } from '../../../../packages/dingtalk-dsh-assistant/dws-runner.js'
import { createTaskSheetSyncService, TASK_SHEET_SYNC_INTERVAL_MS } from '../../../../packages/dingtalk-dsh-assistant/task-sheet-sync.js'

const documentUrl = process.argv[2]
const nodeId = process.argv[3]
const sheetId = process.argv[4]
if (!documentUrl || !nodeId || !sheetId) throw new Error('usage: node run-live-sync.mjs <document-url> <node-id> <sheet-id>')
const endpoint = process.env.DSH_RESIDENT_ENDPOINT ?? 'http://127.0.0.1:18998'
const read = async (path) => {
  const response = await fetch(`${endpoint}${path}`)
  if (!response.ok) throw new Error(`resident_read_failed:${path}:${response.status}`)
  return response.json()
}
const [tasks, groups] = await Promise.all([read('/state/tasks'), read('/state/groups')])
let status = { state: 'idle' }
const store = {
  getTaskSheetSyncConfig: () => ({ enabled: true, documentUrl, nodeId, documentName: '小小鹏任务表', sheetId, sheetTitle: 'Sheet1', intervalMs: TASK_SHEET_SYNC_INTERVAL_MS }),
  getTaskSheetSyncStatus: () => status,
  setTaskSheetSyncStatus: async (patch) => { status = { ...status, ...patch }; return status },
  listTasks: () => tasks,
  listGroups: () => groups,
}
const service = createTaskSheetSyncService({ store, runner: createNodeDwsRunner(), logger: console })
const result = await service.run('manual')
process.stdout.write(`${JSON.stringify({ ...result, sourceTaskCount: tasks.length, sourceUnarchivedCount: tasks.filter((task) => !task.archivedAt).length }, null, 2)}\n`)
