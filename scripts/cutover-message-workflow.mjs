import { parseArgs } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutoverWorkflow } from '../packages/dingtalk-dsh-assistant/workflow-cutover.js'
const { values } = parseArgs({ options: { legacy: { type: 'string' }, journal: { type: 'string' }, db: { type: 'string' }, artifacts: { type: 'string' }, instance: { type: 'string' }, group: { type: 'string', multiple: true }, 'runtime-pid': { type: 'string' }, 'runtime-port': { type: 'string' }, 'scheduled-task': { type: 'string' }, check: { type: 'boolean' }, execute: { type: 'boolean' } } })
if (values.check === values.execute || ['legacy', 'journal', 'db', 'artifacts', 'instance', 'runtime-pid', 'runtime-port', 'scheduled-task'].some(k => !values[k]) || !values.group?.length) throw new Error('usage: --legacy <json> --journal <json> --db <sqlite> --artifacts <directory> --instance <id> --group <id> --runtime-pid <stopped-pid> --runtime-port <port> --scheduled-task <exact-name> (--check | --execute)')
if (process.platform !== 'win32') throw new Error('cutover_cli_requires_windows_quiescence_probe')
const probeStopped = async () => { const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./check-workflow-quiescence.ps1', import.meta.url)), '-RuntimePid', values['runtime-pid'], '-RuntimePort', values['runtime-port'], '-ScheduledTaskName', values['scheduled-task']], { windowsHide: true, timeout: 15000 }); return JSON.parse(stdout) }
try { console.log(JSON.stringify(await cutoverWorkflow({ legacyPath: resolve(values.legacy), journalPath: resolve(values.journal), dbPath: resolve(values.db), artifactDirectory: resolve(values.artifacts), instanceId: values.instance, groupIds: values.group, check: values.check === true, probeStopped }), null, 2)) }
catch (error) { console.error(JSON.stringify({ code: error.code ?? error.message, details: error.details })); process.exitCode = 1 }
