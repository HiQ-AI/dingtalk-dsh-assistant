// Synthetic acceptance host: real observer JS, React, native primitives, HTTP and SQLite.
// Only ModuleLoader/slots/session navigation are adapted; this is not full dsh-host acceptance.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { openDynamicTaskStore } from '../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../../../../packages/dingtalk-dsh-assistant/task-session-service.js'
import { createCoordinationObserver } from '../../../../packages/dingtalk-dsh-assistant/coordination-observer.js'
import { handleRequest } from '../../../../packages/dingtalk-dsh-assistant/http.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const { values } = parseArgs({ options: {
  'data-root': { type: 'string' }, 'deps-root': { type: 'string' }, 'esbuild-module': { type: 'string' },
  'web-port': { type: 'string', default: '19087' }, 'api-port': { type: 'string', default: '19088' },
  check: { type: 'boolean', default: false }, empty: { type: 'boolean', default: false },
} })
for (const key of ['data-root', 'deps-root', 'esbuild-module']) assert.ok(values[key], `--${key} required`)
const dataRoot = resolve(values['data-root']), depsRoot = resolve(values['deps-root'])
const webPort = Number(values['web-port']), apiPort = Number(values['api-port'])
for (const port of [webPort, apiPort]) assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535 && port !== 18998)
assert.notEqual(webPort, apiPort)
const esbuild = await import(pathToFileURL(resolve(values['esbuild-module'])))
const observerPath = join(root, 'packages/dingtalk-dsh-observer/web-client.js')
const primitivePath = createRequire(join(root, 'packages/dingtalk-dsh-observer/package.json')).resolve('@deepseek-ai/dsh-client-ui-primitives')
for (const p of [observerPath, primitivePath, join(depsRoot, 'node_modules/react-dom/client.js')]) await access(p)
if (values.check) {
  console.log(JSON.stringify({ check: 'PASS', root, dataRoot, webPort, apiPort, primitivePath, limitation: 'Minimal ModuleLoader/slots host adapter; not full dsh host.' }))
  process.exit(0)
}
// Never reuse or erase another run's database.
await mkdir(dataRoot)
const storage = new JsonStorageBackend(join(dataRoot, 'resident'))
const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => storage } } }, { backend: 'json' })
const resident = await openResidentStore(facility)
const db = await openDynamicTaskStore({ dbPath: join(dataRoot, 'tasks.sqlite'), instanceId: 'synthetic-browser-acceptance', initialize: true })
const query = (kind, args = {}) => db.query({ kind, ...args })
const command = (kind, args) => db.command({ id: randomUUID(), kind, args })
const manifest = { synthetic: true, pid: process.pid, dataRoot, webPort, apiPort,
  launchCommand: [process.execPath, ...process.argv.slice(1)],
  hostIntegration: 'Minimal ModuleLoader/slots host with actual React 18, dsh primitives 0.2.1-alpha.2 and production task service read DTOs; model/session runs forbidden',
  sourceHashes: {}, sources: {}, tasks: {} }
for (const path of ['packages/dingtalk-dsh-observer/web-client.js', 'packages/dingtalk-dsh-assistant/coordination-observer.js',
  'packages/dingtalk-dsh-assistant/http.js', 'packages/dingtalk-dsh-assistant/task-session-service.js',
  'docs/acceptance/coordinator-work-visualization/scripts/isolated-browser-host.mjs',
  'docs/acceptance/coordinator-work-visualization/scripts/browser-acceptance.py']) {
  const bytes = await readFile(join(root, path))
  manifest.sourceHashes[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}
await resident.subscribe({ groupId: 'synthetic-group', name: '合成验收群（非真实业务）', responsibility: '仅隔离浏览器验收，不发送消息' })
await resident.subscribe({ groupId: 'synthetic-empty', name: '合成空群（非真实业务）', responsibility: '验证空状态' })
if (!values.empty) {
  const reserve = async (key, original) => {
    const source = (await command('coordination.reserve', { unitId: `synthetic-${key}`, revision: 1, groupId: 'synthetic-group', original: `[合成测试数据] ${original}` })).result.source
    manifest.sources[key] = source.id
    return source
  }
  const member = (taskId, dependencies = [], coordinationId = 'synthetic-chain') => ({ instructionId: `instruction-${taskId}`, taskId, progressImpact: 'preserve', dependencies,
    command: { id: `coordination-command:${coordinationId}:instruction-${taskId}`, kind: 'task.supplement', args: { taskId, expectedRequirementRevision: 1, expectedControlRevision: 1,
      messageId: `synthetic-message-${taskId}`, text: '[合成测试数据] 接受协调安排', request: `[合成测试数据] ${taskId} 接受协调安排` } } })
  for (const taskId of ['synthetic-A', 'synthetic-B', 'synthetic-complete']) {
    await command('task.create', { taskId, groupId: 'synthetic-group', title: `[合成测试数据] ${taskId}`, request: `[合成测试数据] ${taskId} 的可核验目标` })
    manifest.tasks[taskId] = taskId
  }
  const accepted = await reserve('accepted', '先完成任务 A 的核验，再继续任务 B；B 正在等待 A。')
  await command('coordination.accept', { sourceId: accepted.id, fence: accepted.fence, coordinationId: 'synthetic-chain', members: [member('synthetic-A'), member('synthetic-B', ['instruction-synthetic-A'])] })
  await command('coordination.apply', { instructionId: 'instruction-synthetic-A', expectedRevision: 1 })
  const blocked = await command('coordination.apply', { instructionId: 'instruction-synthetic-B', expectedRevision: 1 })
  assert.deepEqual(blocked.result.waiting, ['instruction-synthetic-A'])
  const completed = await reserve('completed', '独立任务已有正式完成证据。')
  await command('coordination.accept', { sourceId: completed.id, fence: completed.fence, coordinationId: 'synthetic-completed', members: [member('synthetic-complete', [], 'synthetic-completed')] })
  await command('coordination.apply', { instructionId: 'instruction-synthetic-complete', expectedRevision: 1 })
  const binding = (await command('task.claim', { taskId: 'synthetic-complete' })).result.binding
  await command('task.complete', { binding, summary: '[合成测试数据] 已核验完成', result: { evidence: ['synthetic-proof:acceptance-only'] } })
  await command('task.drained', { binding })
  await reserve('reserved', '本条已接收，尚未形成正式安排。')
  const rejected = await reserve('rejected', '不属于协调职责的输入，明确不接纳。')
  await command('coordination.source.reject', { sourceId: rejected.id, fence: rejected.fence, reason: '[合成测试数据] 非协调职责，不创建任务' })
  const clarify = await reserve('clarification', '请继续那个任务（需要说明哪个任务）。')
  await command('coordination.source.clarify', { sourceId: clarify.id, fence: clarify.fence, coordinationId: 'synthetic-clarification', question: '[合成测试数据] 请确认具体任务', candidates: [] })
  const scheduled = await reserve('schedule', '每日上午九点的合成提醒，只用于隔离阅读验收。')
  await command('coordination.accept', { sourceId: scheduled.id, fence: scheduled.fence, coordinationId: 'synthetic-schedule', members: [], readOnly: true })
  await command('coordination.schedule.create', { coordinationId: 'synthetic-schedule', scheduleId: 'synthetic-daily', timezone: 'Asia/Shanghai',
    rule: { kind: 'daily', time: '09:00' }, action: { kind: 'message-reminder', text: '[合成测试数据] 每日核对待办安排' },
    target: { conversationId: 'synthetic-group', recipientIds: [] } })
  // Seed persisted outcomes through official commands only; no transport/model is attached.
  manifest.ledgerCases = []
  for (const scenario of [
    { name: 'once-failed', delivery: 'failed' }, { name: 'once-delivered', delivery: 'delivered' },
    { name: 'once-unknown', delivery: 'unknown' }, { name: 'once-pending', delivery: null },
    { name: 'recurring-failed', delivery: 'failed', recurring: true },
    { name: 'paused-failed', delivery: 'failed', recurring: true, control: 'paused' },
    { name: 'cancelled-failed', delivery: 'failed', recurring: true, control: 'cancelled' },
    { name: 'cancelled-delivered', delivery: 'delivered', recurring: true, control: 'cancelled' },
    { name: 'cancelled-unknown', delivery: 'unknown', recurring: true, control: 'cancelled' },
    { name: 'cancelled-unsent', delivery: null, cancelBeforeSend: true },
  ]) {
    const id = `synthetic-${scenario.name}`
    const source = await reserve(scenario.name, `${scenario.name} 的持久提醒状态`)
    await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: id, members: [], readOnly: true })
    await command('coordination.schedule.create', { coordinationId: id, scheduleId: id, timezone: 'Asia/Shanghai',
      rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString() },
      action: { kind: 'message-reminder', text: `[合成测试数据] ${scenario.name}` }, target: { conversationId: 'synthetic-group', recipientIds: [] } })
    const occurrence = (await command('coordination.schedule.scan')).result.occurrences.find(item => item.scheduleId === id)
    assert.ok(occurrence)
    const job = (await command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
    await command('coordination.job.remind', { jobId: job.id, fence: job.fence })
    if (scenario.recurring) await command('coordination.schedule.change', { scheduleId: id, expectedRevision: 1, rule: { kind: 'daily', time: '09:00' } })
    if (scenario.cancelBeforeSend) {
      const notice = (await command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
      await command('coordination.schedule.change', { scheduleId: id, expectedRevision: 1, state: 'cancelled' })
      const denied = await command('notification.start', { notificationId: notice.id })
      assert.equal(denied.dispatchEligible, false)
      assert.equal(denied.result.notification.sendAttemptCount ?? 0, 0)
    }
    if (scenario.delivery) {
      const notice = (await command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
      const permit = (await command('notification.start', { notificationId: notice.id })).result.notification
      await command('notification.receipt', { notificationId: notice.id, dispatchToken: permit.dispatchToken, state: scenario.delivery,
        ...(scenario.delivery === 'failed' ? { error: { phase: 'send', knownNotSent: true, retryable: false, message: 'Synthetic definitive failure' } } : {}) })
    }
    if (scenario.control) await command('coordination.schedule.change', { scheduleId: id, expectedRevision: 2, state: scenario.control })
    manifest.ledgerCases.push({ ...scenario, workId: `schedule:${id}` })
  }
  for (let index = 0; index < 20; index++) await reserve(`paging-${String(index).padStart(2, '0')}`, `分页验证输入 ${index + 1}`)
}
await writeFile(join(dataRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
const noop = async () => {}
const forbidden = async () => { throw new Error('Acceptance host must never run a model/task/execution session') }
const readOnlySessions = { close: noop, cancel: forbidden, run: forbidden }
const legacy = { getAgentConfig: () => ({ workspaceDir: dataRoot }), getGroup: id => resident.getGroup(id) }
const service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } }, config: {
  dbPath: join(dataRoot, 'tasks.sqlite'), workspaceDir: dataRoot, instanceId: 'synthetic-browser-acceptance',
}, legacy, residentStore: resident, store: db, persistence: { register: noop, close: noop },
  taskSessions: readOnlySessions, executionSessions: readOnlySessions, claudeExecutionSessions: readOnlySessions,
})
const observer = createCoordinationObserver(query)
const runtime = Object.assign(Object.create(resident), legacy, observer, {
  listTaskView: () => service.boardTasks(), getTaskSessionDetail: id => service.taskDetail(id),
  getTaskSessionExecutions: (...args) => service.taskExecutions(...args), getTaskSessionDecisions: (...args) => service.taskDecisions(...args),
  getTaskDialogue: id => service.taskDialogue(id),
  listAuthorizationRequests: async () => [], listTopics: () => [],
  listAlerts: () => [], listRecoveryIssues: () => [],
})
const api = createServer((req, res) => {
  // This adapter is intentionally read-only after seeding and cannot send messages.
  if (req.method !== 'GET' && req.method !== 'OPTIONS') { res.writeHead(405).end(); return }
  handleRequest(req, res, runtime, { checkForUpdatesImpl: async () => ({ currentVersion: 'synthetic-test', latestVersion: null, updateAvailable: false }) })
    .catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code ?? error.message })) })
})
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as primitives from ${JSON.stringify(primitivePath)};
const components=new Map();let plugin;
window.__ModuleLoader__={load(spec){plugin=spec.factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-ui-primitives')return primitives;throw new Error('Unsupported host import: '+name)})}};
await import('/observer.js');
let rerender=()=>{};
const ctx={slots:{inject(name,callback){return callback()},register(spec,Component){components.set(spec.name,{spec,Component});rerender();return()=>{components.delete(spec.name);rerender()}}},layout:{selectPanel(){}},sessions:{async refresh(){},async refreshProjections(){},subagentAddress(){return null}},uiWorkspace:{openSession(id){window.__lastOpenedSession=id;document.getElementById('host-status').textContent='Host adapter session navigation: '+id}}};
plugin.apply(ctx);
function Host(){const[version,setVersion]=React.useState(0);React.useEffect(()=>{rerender=()=>setVersion(x=>x+1);return()=>{rerender=()=>{}}},[]);return React.createElement(React.Fragment,null,...[...components.entries()].map(([name,{spec,Component}])=>React.createElement(Component,{key:name,...spec.inject?.()})))};
createRoot(document.getElementById('root')).render(React.createElement(Host));
window.__acceptanceHost={synthetic:true,realReact:React.version,realPrimitives:Object.keys(primitives),adapter:'ModuleLoader+slots+session navigation only'};
`
const result = await esbuild.build({ stdin: { contents: entry, sourcefile: 'acceptance-host.mjs', resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', write: false,
  outdir: 'virtual', nodePaths: [join(depsRoot, 'node_modules'), join(root, 'node_modules')],
  alias: { react: join(root, 'node_modules/react'), 'react-dom': join(depsRoot, 'node_modules/react-dom') },
  define: { 'process.env.NODE_ENV': '"production"' }, external: ['/observer.js'], loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
})
const files = new Map(result.outputFiles.map(file => [file.path.endsWith('.css') ? '/host.css' : '/host.js', file.contents]))
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成隔离验收</title><link rel="stylesheet" href="/host.css"><style>html,body,#root{margin:0;min-height:100%;font-family:"Microsoft YaHei",sans-serif}body{color:#23252a;background:#fff}#host-status{padding:8px 16px;background:#eef3ff;color:#26375f;font-size:12px}@media(prefers-color-scheme:dark){body{background:#191b20;color:#eee;--dsw-alias-bg-base:#191b20;--dsw-alias-bg-layer-1:#252830;--dsw-alias-label-secondary:#aaa;--dsw-alias-border-l2:#555;--dsw-alias-brand-primary:#9aaaff}}</style><p id="host-status">合成测试数据 · 最小 host 适配器 · 非生产部署，不验证完整宿主集成</p><div id="root"></div><script type="module" src="/host.js"></script></html>`
const web = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/__acceptance/mutate' && req.method === 'POST') {
    const sourceId = new URL(req.url, 'http://localhost').searchParams.get('sourceId')
    const source = (await query('coordination.source.list')).find(row => row.id === sourceId)
    if (!source || source.groupId !== 'synthetic-group' || !source.original.startsWith('[合成测试数据]')) { res.writeHead(403).end(); return }
    const receipt = await command('coordination.source.failed', { sourceId, fence: source.fence, code: 'SYNTHETIC_REFRESH_PROBE' })
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipt.result)); return
  }
  if (path.startsWith('/api/')) {
    const upstream = await fetch(`http://127.0.0.1:${apiPort}${req.url.slice(4)}`)
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
    res.end(Buffer.from(await upstream.arrayBuffer())); return
  }
  if (path === '/favicon.ico') { res.writeHead(204).end(); return }
  if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
  if (path === '/manifest.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return }
  if (path === '/observer.js') {
    // Fixture-only endpoint points at the real HTTP forwarding route to avoid changing production CORS.
    const source = await readFile(observerPath, 'utf8')
    assert.equal(source.split("const ENDPOINT = 'http://127.0.0.1:18998'").length, 2)
    res.setHeader('content-type', 'text/javascript'); res.end(source.replace("const ENDPOINT = 'http://127.0.0.1:18998'", `const ENDPOINT = 'http://127.0.0.1:${webPort}/api'`)); return
  }
  if (files.has(path)) { res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(files.get(path)); return }
  res.writeHead(404).end()
})
await new Promise((ok, fail) => api.once('error', fail).listen(apiPort, '127.0.0.1', ok))
await new Promise((ok, fail) => web.once('error', fail).listen(webPort, '127.0.0.1', ok))
console.log(JSON.stringify({ ready: true, pid: process.pid, web: `http://127.0.0.1:${webPort}`, api: `http://127.0.0.1:${apiPort}`, dataRoot, synthetic: true, sourceCount: (await observer.coordinationSources()).total, limitation: manifest.hostIntegration }))
const close = async () => { web.closeAllConnections(); api.closeAllConnections(); await Promise.all([new Promise(ok => web.close(ok)), new Promise(ok => api.close(ok))]); await service.close(); await db.close(); await resident.close(); process.exit(0) }
process.once('SIGINT', close); process.once('SIGTERM', close)
