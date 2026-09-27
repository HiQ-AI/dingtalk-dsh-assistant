import { parseArgs } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { planWorkflowGroupEnrollment } from './workflow-group-profile.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutoverWorkflow, enrollEmptyWorkflowGroup } from '../packages/dingtalk-dsh-assistant/workflow-cutover.js'
const { values } = parseArgs({ options: { 'enroll-empty-group': { type: 'boolean' }, profile: { type: 'string' }, 'expected-profile-sha256': { type: 'string' }, legacy: { type: 'string' }, journal: { type: 'string' }, db: { type: 'string' }, artifacts: { type: 'string' }, instance: { type: 'string' }, group: { type: 'string', multiple: true }, 'runtime-pid': { type: 'string' }, 'runtime-port': { type: 'string' }, 'scheduled-task': { type: 'string' }, check: { type: 'boolean' }, execute: { type: 'boolean' } } })
if (values.check === values.execute || ['legacy', 'journal', 'db', 'artifacts', 'instance', 'runtime-pid', 'runtime-port', 'scheduled-task'].some(k => !values[k]) || !values.group?.length) throw new Error('usage: --legacy <json> --journal <json> --db <sqlite> --artifacts <directory> --instance <id> --group <id> --runtime-pid <stopped-pid> --runtime-port <port> --scheduled-task <exact-name> (--check | --execute)')
if (process.platform !== 'win32') throw new Error('cutover_cli_requires_windows_quiescence_probe')
const probeStopped = async () => { const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./check-workflow-quiescence.ps1', import.meta.url)), '-RuntimePid', values['runtime-pid'], '-RuntimePort', values['runtime-port'], '-ScheduledTaskName', values['scheduled-task']], { windowsHide: true, timeout: 15000 }); return JSON.parse(stdout) }
const enroll = values['enroll-empty-group'] === true
if (enroll && (!values.profile || !values['expected-profile-sha256'] || values.group.length !== 1)) throw new Error('enrollment_requires_profile_hash_and_one_group')
const profilePath = enroll ? resolve(values.profile) : null
const yaml = enroll ? createRequire(pathToFileURL(profilePath))(join(dirname(profilePath), 'node_modules/js-yaml')) : null
try { console.log(JSON.stringify(await (enroll ? enrollEmptyWorkflowGroup : cutoverWorkflow)({
  ...(enroll ? { profilePath, expectedProfileSha256: values['expected-profile-sha256'], planProfile: (source, groupIds, conversationId) => planWorkflowGroupEnrollment(source, yaml, { instanceId: values.instance, dbPath: resolve(values.db), groupIds, conversationId }) } : {}), legacyPath: resolve(values.legacy), journalPath: resolve(values.journal), dbPath: resolve(values.db), artifactDirectory: resolve(values.artifacts), instanceId: values.instance, groupIds: values.group, check: values.check === true, probeStopped }), null, 2)) }
catch (error) { console.error(JSON.stringify({ code: error.code ?? error.message, details: error.details })); process.exitCode = 1 }
