import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'

const { values } = parseArgs({ options: { source: { type: 'string' }, baseline: { type: 'boolean' }, playwright: { type: 'string' } } })
const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const output = path.join(root, 'docs/tmp/observer-refresh-navigation'), mode = values.baseline ? 'baseline' : 'fixed'
await mkdir(output, { recursive: true })
const observer = await readFile(values.source || path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const playwright = await import(values.playwright || 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
assert.ok(domDirectory, 'matching ReactDOM dependency is required')
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 使用真实 React/ReactDOM 和完整 observer；只替换宿主 slot、UI primitive 与 GET 接口。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>导航刷新隔离验收</title><style>body{margin:0;font:14px "Microsoft YaHei",sans-serif}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><button role="treeitem" aria-selected="false">夹具会话</button><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const h=React.createElement, primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=7})=>h('span',{'aria-hidden':true}),Menu:({anchor})=>anchor};
for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true});
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
let activeSlot;window.hostRemounts=0;
window.remountObserver=()=>{if(!activeSlot)throw Error('observer_slot_missing');window.previousObserverRoot=document.querySelector('[data-dingtalk-observer]');ReactDOM.flushSync(()=>roots.app.render(null));window.hostRemounts++;ReactDOM.flushSync(()=>roots.app.render(h(activeSlot.Component,activeSlot.props)))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar',props={...(spec.inject?.()||{}),wide:true};if(target==='app')activeSlot={Component,props};roots[target].render(h(Component,props));return()=>{if(target==='app')activeSlot=undefined;roots[target].render(null)}}},sessions:{subagentAddress(){},async refreshSubagents(){},async refresh(){},open(){}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`, key = 'dingtalk-dsh-observer.active-page'
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], writes = [], reads = [], checks = []
let emptyTasks = false, failHealth = false, failure
const task = { taskId: 'fixture-task', groupId: 'fixture-group', title: '导航刷新验收任务', objective: '验证导航状态', engine: 'workflow-v2', state: 'queued', createdAt: '2026-10-13T02:00:00Z', updatedAt: '2026-10-13T02:00:00Z' }
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  reads.push({ pathname: target.pathname, at: Date.now() })
  if (failHealth && target.pathname === '/health') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离夹具读取失败' }) })
  const fixtures = { '/health': { status: 'ok' }, '/state/tasks': emptyTasks ? [] : [task], '/state/groups': [{ groupId: 'fixture-group', name: '隔离验收群', messages: [], outbox: [] }], '/state/topics': { topics: [], total: 0 }, '/state/supervisor/alerts': [], '/state/authorizations': [] }
  assert.ok(target.pathname in fixtures, `unhandled fixture read: ${target.pathname}`)
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures[target.pathname]) })
})
const labels = ['群消息', '话题', '任务看板', '人工介入', '归档任务', '告警']
const ids = ['groups', 'topics', 'tasks', 'authorizations', 'archive', 'alerts']
const nav = () => page.getByRole('navigation', { name: '运行看板视图' })
const healthReads = () => reads.filter(item => item.pathname === '/health').length
const active = async label => { await nav().locator('[aria-current="page"]').filter({ hasText: label }).waitFor(); assert.equal(await nav().locator('[aria-current="page"]').textContent(), label) }
const ready = () => page.locator('[aria-label^="运行正常，最近更新"]').waitFor()
async function openObserver() { await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click(); await ready() }
async function manualRefresh(label) {
  const before = healthReads()
  await page.getByRole('button', { name: /^(刷新|已刷新)$/ }).click()
  await page.getByRole('button', { name: '已刷新', exact: true }).waitFor()
  assert.ok(healthReads() > before); await active(label)
}
async function remount(label) {
  await page.evaluate(() => window.remountObserver()); await ready(); await active(label)
  assert.equal(await page.evaluate(() => window.previousObserverRoot === document.querySelector('[data-dingtalk-observer]')), false)
}
function pass(name) { checks.push(name); console.log(`PASS ${name}`) }
try {
  await page.goto(url); await openObserver(); await active('群消息')
  await nav().getByRole('button', { name: '任务看板', exact: true }).click(); await active('任务看板')
  await page.locator('strong[title="导航刷新验收任务"]').waitFor()
  const initialReads = healthReads(), pollStarted = Date.now()
  await page.waitForTimeout(5300)
  assert.ok(healthReads() > initialReads); assert.ok(Date.now() - pollStarted >= 5000); await active('任务看板')
  pass('task-board-real-five-second-poll')
  await manualRefresh('任务看板'); pass('task-board-manual-refresh')
  if (values.baseline) {
    await remount('群消息')
    await page.screenshot({ path: path.join(output, 'baseline-remount-reset.png'), fullPage: true })
    pass('baseline-host-remount-reproduces-reset-to-groups')
  } else {
    await remount('任务看板'); pass('task-board-host-remount')
    await page.screenshot({ path: path.join(output, 'fixed-task-board-desktop.png'), fullPage: true })
    for (const [index, label] of labels.entries()) {
      await nav().getByRole('button', { name: label, exact: true }).click(); await active(label)
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), ids[index])
      const before = healthReads()
      await page.waitForTimeout(5200)
      assert.ok(healthReads() > before); await active(label)
      await manualRefresh(label); await remount(label)
      await page.reload(); await openObserver(); await active(label)
      pass(`${ids[index]}-poll-manual-remount-reload`)
    }
    await nav().getByRole('button', { name: '任务看板', exact: true }).click()
    await page.getByRole('treeitem', { name: '夹具会话' }).click()
    await page.locator('[data-dingtalk-observer]').waitFor({ state: 'detached' })
    await openObserver(); await active('任务看板'); pass('session-close-and-reopen-keeps-page')
    failHealth = true
    await manualRefresh('任务看板'); await page.getByText('无法连接 resident 插件：隔离夹具读取失败', { exact: true }).waitFor()
    await page.locator('strong[title="导航刷新验收任务"]').waitFor(); pass('failed-refresh-keeps-page-and-existing-content')
    failHealth = false; emptyTasks = true
    await manualRefresh('任务看板'); assert.equal(await page.getByText('暂无任务', { exact: true }).count(), 4)
    await remount('任务看板'); assert.equal(await page.getByText('暂无任务', { exact: true }).count(), 4)
    pass('empty-task-board-keeps-page')
    await page.setViewportSize({ width: 390, height: 844 })
    await nav().getByRole('button', { name: '话题', exact: true }).focus(); await page.keyboard.press('Enter'); await active('话题')
    await page.keyboard.press('Tab'); assert.equal(await page.locator(':focus').textContent(), '任务看板')
    await page.keyboard.press('Enter'); await active('任务看板'); await manualRefresh('任务看板'); await remount('任务看板')
    assert.equal(await page.locator('[data-dingtalk-observer]').evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.screenshot({ path: path.join(output, 'fixed-task-board-narrow.png'), fullPage: true })
    pass('narrow-keyboard-navigation-and-no-horizontal-overflow')
    await page.evaluate(key => sessionStorage.setItem(key, 'unknown-page'), key)
    await page.reload(); await openObserver(); await active('群消息'); pass('unknown-stored-page-defaults-to-groups')
    await page.evaluate(() => {
      for (const method of ['getItem', 'setItem']) Storage.prototype[method] = () => { throw new DOMException('Storage blocked by fixture', 'SecurityError') }
    })
    await remount('群消息')
    await nav().getByRole('button', { name: '任务看板', exact: true }).click(); await active('任务看板')
    await manualRefresh('任务看板'); pass('blocked-storage-still-allows-navigation-and-refresh')
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
} catch (error) {
  failure = error.stack
  await page.screenshot({ path: path.join(output, `${mode}-failure.png`), fullPage: true }).catch(() => {})
} finally {
  const result = { passed: !failure, mode, checks, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), errors, writes, healthReads: healthReads(), failure, boundary: '真实 headless Edge、React 与完整 observer；宿主 slot/primitive/API 使用隔离 fixtures。复现重挂载，不代表已证明用户运行实例确实在重挂载；未启动业务服务、未写业务接口、未部署。' }
  await writeFile(path.join(output, `${mode}-browser-results.json`), JSON.stringify(result, null, 2))
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve))
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, output, failure }))
}
if (failure) process.exitCode = 1
