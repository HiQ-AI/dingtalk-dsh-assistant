import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = require(process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright')
const output = path.join(root, 'docs/acceptance/task-card-archive/preview')
await mkdir(output, { recursive: true })
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(process.env.DSH_BROWSER_DEPS || '/tmp/archive-browser/node_modules', 'react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 真实 React 与完整 observer 代码；DSH 外壳/primitive 仅用无副作用语义替身。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流程状态验收夹具</title><style>body{margin:0;color:#202124;font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:8px}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const matrixCells=[[0,0],[4,0],[8,0],[8,4],[8,8],[4,8],[0,8],[0,4]];
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=10})=>state==='ongoing'?h('svg',{'data-state':'ongoing',width:size,height:size,viewBox:'0 0 10 10',shapeRendering:'crispEdges','aria-hidden':true,style:{color:'#5675ef'}},...matrixCells.map(([x,y])=>h('rect',{key:x+'-'+y,x,y,width:2,height:2,fill:'currentColor'}))):h('span',{'data-state':state,'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor})=>anchor};
primitives.IconChecklistOutline14=({size=14,...props})=>h('svg',{...props,width:size,height:size,viewBox:'0 0 14 14',fill:'none'},
  h('path',{d:'M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z',fill:'currentColor'}),
  h('path',{d:'M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z',fill:'currentColor'}));
for(const name of ['IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,viewBox:'0 0 14 14',fill:'none'},h('path',{d:name==='IconChevronUpOutline14'?'M3 9L7 5L11 9':'M3 5L7 9L11 5',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='main.conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},uiWorkspace:{openSession(id){window.opened.push(id)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`

const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { openTaskSessionService } = await import('../../../../packages/dingtalk-dsh-assistant/task-session-service.js')
const { handleRequest } = await import('../../../../packages/dingtalk-dsh-assistant/http.js')
const temporary = await mkdtemp(path.join(tmpdir(), 'archive-e2e-'))
const noop = async () => {}
let service
const openService = () => openTaskSessionService({ ctx: {}, residentStore: { listGroups: () => [], listTopics: () => [], getGroup: () => undefined }, config: { dbPath: path.join(temporary, 'fixture.sqlite'), instanceId: 'browser-fixture', initialize: true, workspaceDir: temporary, webActorId: 'fixture-owner' }, legacy: { getAgentConfig: () => ({ workspaceDir: temporary }) }, persistence: { register: noop, close: noop }, taskSessions: { close: noop }, executionSessions: { close: noop } })
service = await openService()
let sequence = 0
const command = (kind, args) => service.store.command({ id: `fixture-${++sequence}`, kind, args })
async function seed(id, state) {
  await command('task.create', { taskId: id, title: `${id} · 隔离任务`, request: '检查归档与执行列表，保留已有卡片布局及中文名称。' })
  const { binding } = (await command('task.claim', { taskId: id })).result
  const execution = (await command('execution.dispatch', { binding, key: 'verify', title: '核对归档入口', prompt: 'fixture-only', input: { objective: '仅测试数据', title: '核对归档入口' } })).result.execution
  const executionBinding = (await command('execution.claim', { executionId: execution.executionId })).result.binding
  await command('execution.result', { binding: executionBinding, output: { summary: '隔离测试完成' } })
  await command('execution.drained', { binding: executionBinding })
  if (state === 'completed') {
    await command('task.complete', { binding, summary: '已完成', result: { summary: '保留结果' } })
    await command('task.drained', { binding })
  } else if (state === 'waiting') {
    await command('task.wait', { binding, summary: '等待检查' })
    await command('task.drained', { binding })
  }
}
await seed('running-old', 'running')
await seed('waiting', 'waiting')
await seed('done', 'completed')
await seed('running-new', 'running')
const runtime = {
  isTaskSessionMode: () => true, getTaskSessionDetail: id => service.taskDetail(id), archiveTask: args => service.archiveTask(args), listTaskView: () => service.boardTasks(),
  listRecoveryIssues: () => [], listGroups: () => [], listTopics: () => [], listAlerts: () => [], listAuthorizationRequests: () => [],
}
const backend = createServer((req, res) => handleRequest(req, res, runtime).catch(error => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }))
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${backend.address().port}`
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], checks = [], requests = []
let failArchive = false, holdArchive = false, releaseArchive, releaseRead, holdRead = true, noRunning = false
page.on('pageerror', error => { errors.push(error.message); console.error('browser error:', error.message) })
await context.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  // No request ever reaches the real resident endpoint or another external host.
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (target.pathname === '/state/tasks' && holdRead) await new Promise(resolve => { releaseRead = resolve })
  const method = route.request().method()
  requests.push({ method, path: target.pathname })
  if (method === 'POST') {
    assert.match(target.pathname, /^\/tasks\/(done|running-new|running-old)\/archive$/)
    if (holdArchive) await new Promise(resolve => { releaseArchive = resolve })
    if (failArchive) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离服务暂时不可用' }) })
  }
  const response = await fetch(base + target.pathname + target.search, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: route.request().postData() } : {}) })
  let body = await response.text()
  if (target.pathname === '/state/tasks' && noRunning) body = JSON.stringify(JSON.parse(body).filter(task => task.state !== 'running'))
  return route.fulfill({ status: response.status, contentType: 'application/json', body })
})
const card = id => page.locator('article').filter({ has: page.locator('strong', { hasText: `${id} ·` }) })
const opened = () => page.locator('article details[open]')
const toggle = id => card(id).locator('summary')
const archive = id => card(id).getByRole('button', { name: `归档任务：${id} · 隔离任务`, exact: true })
const refresh = async () => { const response = page.waitForResponse(r => r.url().endsWith('/state/tasks')); await page.getByRole('button', { name: '刷新', exact: true }).click(); await response; await page.waitForTimeout(100) }
try {
  console.log('fixture ready'); await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  assert.equal(await opened().count(), 0)
  await page.waitForFunction(() => document.querySelector('main'))
  holdRead = false; while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10)); releaseRead()
  await card('running-new').waitFor()
  await page.waitForTimeout(100)
  const sorted = (await service.boardTasks()).filter(t => t.state === 'running').sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  assert.equal(await card(sorted[0].taskId).locator('details').getAttribute('open'), '')
  assert.equal(await opened().count(), 1)
  checks.push('first-asynchronous-load-default-matches-running-sort')
  await page.screenshot({ path: path.join(output, 'initial-single-expanded.png'), fullPage: true })
  await toggle('waiting').click(); assert.equal(await opened().count(), 1); assert.equal(await card('waiting').locator('details').getAttribute('open'), '')
  await toggle('done').focus(); await page.keyboard.press('Enter'); assert.equal(await opened().count(), 1); assert.equal(await card('done').locator('details').getAttribute('open'), '')
  await toggle('done').click(); assert.equal(await opened().count(), 0)
  await refresh(); assert.equal(await opened().count(), 0)
  checks.push('cross-bucket-single-expand-keyboard', 'manual-collapse-survives-refresh')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  await archive('running-new').click(); await page.getByRole('alert').filter({ hasText: '任务须已完成或已取消' }).waitFor()
  assert.equal((await service.store.query({ kind: 'task.get', taskId: 'running-new' })).control, 'active')
  assert.equal(await card('running-new').count(), 1)
  checks.push('running-archive-rejected-without-cancel', 'archive-click-does-not-open-detail')
  failArchive = true; holdArchive = true
  await archive('done').click(); await archive('done').evaluate(button => { button.click(); button.click() })
  assert.equal(await archive('done').isDisabled(), true)
  await page.waitForTimeout(100)
  assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/tasks/done/archive').length, 1)
  holdArchive = false; releaseArchive()
  await page.getByRole('alert').filter({ hasText: '隔离服务暂时不可用' }).waitFor()
  assert.equal(await card('done').count(), 1); assert.equal((await service.store.query({ kind: 'task.get', taskId: 'done' })).archivedAt, undefined)
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
  checks.push('inflight-disabled-and-duplicate-guard', 'failure-keeps-task-and-database-unmodified')
  failArchive = false
  // Simulate a coordinator that completed since initial list load, then archive the expanded card.
  const live = await service.store.query({ kind: 'task.get', taskId: 'running-new' })
  const binding = { kind: 'task-session', taskId: live.taskId, sessionId: live.sessionId, requirementRevision: live.requirementRevision, controlRevision: live.controlRevision, leaseEpoch: live.leaseEpoch }
  await command('task.complete', { binding, summary: '已结束' }); await command('task.drained', { binding })
  await refresh(); await toggle('running-new').click(); await archive('running-new').click()
  await page.getByRole('status').filter({ hasText: '已归档：running-new' }).waitFor()
  assert.equal(await card('running-new').count(), 0); assert.equal(await opened().count(), 0)
  await refresh(); assert.equal(await opened().count(), 0)
  await archive('done').click(); await page.getByRole('status').filter({ hasText: '已归档：done' }).waitFor()
  const persisted = await service.store.query({ kind: 'task.get', taskId: 'done' })
  assert.ok(persisted.archivedAt); assert.equal(persisted.completion.result.summary, '保留结果')
  await assert.rejects(command('task.reopen', { taskId: 'done', request: 'isolated late message' }), { code: 'DYNAMIC_TASK_ARCHIVED_CONFLICT' })
  assert.equal((await service.taskDetail('done')).status, 'completed')
  checks.push('archived-task-reopen-rejected-without-state-change')
  assert.equal((await service.store.query({ kind: 'execution.list', taskId: 'done' })).length, 1)
  await service.close(); service = await openService()
  assert.equal((await service.taskDetail('done')).archivedAt, persisted.archivedAt)
  await page.reload(); await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '历史任务', exact: true }).click(); await card('done').waitFor()
  assert.equal(await archive('done').count(), 0)
  await page.screenshot({ path: path.join(output, 'history-after-restart.png'), fullPage: true })
  checks.push('expanded-archived-task-cleared-without-redefault', 'durable-sqlite-service-restart-and-browser-reload', 'history-preserves-result-and-executions-without-restore')
  noRunning = true
  await page.reload(); await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click(); await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await card('waiting').waitFor(); assert.equal(await opened().count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  await toggle('waiting').click(); await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true })
  assert.equal(await opened().count(), 1)
  const geometry = await card('waiting').evaluate(node => { const s = getComputedStyle(node); return { padding: s.padding, gap: s.gap, width: node.getBoundingClientRect().width } })
  assert.equal(geometry.padding, '11px 13px'); assert.equal(geometry.gap, '6px'); assert.ok(geometry.width <= 390)
  checks.push('no-running-default-all-collapsed', 'narrow-original-card-spacing')
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, requests, errors, geometry, baseCommit: '3c028dd', fixture: 'temporary SQLite, real service + HTTP; semantic host primitives only; external requests blocked' }, null, 2))
  console.log(JSON.stringify({ checks, errors, output }, null, 2))
} finally { await browser.close(); await new Promise(resolve => backend.close(resolve)); await new Promise(resolve => server.close(resolve)); await service.close(); await rm(temporary, { recursive: true, force: true }) }
