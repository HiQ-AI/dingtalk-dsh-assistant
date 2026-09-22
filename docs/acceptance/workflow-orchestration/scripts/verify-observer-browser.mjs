import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.join(root, 'docs/acceptance/workflow-orchestration/round-7')
await mkdir(output, { recursive: true })
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
if (!domDirectory) throw new Error('matching_react_dom_missing')
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 真实 React 与完整 observer 代码；DSH 外壳/primitive 仅用无副作用语义替身。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流程状态验收夹具</title><style>body{margin:0;color:#202124;font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:8px}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=7})=>h('span',{'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor})=>anchor};
for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true},h('path',{d:'M3 5L7 9L11 5',fill:'none',stroke:'currentColor'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const labels = { succeeded: '已成功', cancelled: '已取消', failed: '已失败', 'legacy-unknown': '历史结果未知' }
const tasks = Object.entries(labels).map(([outcome, label], index) => ({ taskId: `fixture-${outcome}`, title: `${label}：中文长标题核验与通知状态`, objective: '在同名阶段中精确区分已核验与尚未核验的阶段，不把结束状态当成全部验收通过。', groupId: 'fixture-group', childSessionId: `session-${outcome}`, state: 'completed', inputVersion: 1, runSequence: 1, updatedAt: '2026-09-22T06:00:00Z', createdAt: '2026-09-22T05:00:00Z', checkpoints: [], workflowProgress: { outcome, outcomeLabel: label, stages: [{ stageId: `stage-${index}-first`, title: '同名核验阶段', completed: true }, { stageId: `stage-${index}-second`, title: '同名核验阶段', completed: false }] }, notificationIntents: [{ intentId: `notice-${index}`, inputVersion: 1, runSequence: 1, status: ['pending', 'blocked', 'enqueued', 'delivered'][index] }] }))
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], blockedWrites = [], checks = []
let mode = 'normal'
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (route.request().method() !== 'GET') { blockedWrites.push(target.pathname); return route.fulfill({ status: 403, body: JSON.stringify({ error: 'fixture forbids writes' }), contentType: 'application/json' }) }
  if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离夹具模拟读取失败' }) })
  const data = target.pathname === '/state/tasks' ? mode === 'empty' ? [] : tasks : target.pathname === '/health' ? { status: 'ok' } : target.pathname === '/state/groups' ? [{ groupId: 'fixture-group', name: '隔离验收群', messages: [], outbox: [] }] : target.pathname === '/state/topics' ? { topics: [], total: 0 } : []
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await page.getByText(tasks[0].title, { exact: true }).waitFor()
  for (const label of Object.values(labels)) assert.ok(await page.getByRole('status').filter({ hasText: label }).count())
  for (const label of ['完成通知待生成', '完成通知受阻', '完成通知待送达', '完成通知已送达']) assert.ok(await page.getByRole('status').filter({ hasText: label }).count())
  assert.ok(await page.getByText('已结束', { exact: true }).count())
  const bars = page.getByRole('progressbar', { name: '检查点进度' })
  assert.equal(await bars.count(), 4)
  for (let index = 0; index < 4; index++) assert.equal(await bars.nth(index).getAttribute('aria-valuenow'), '50')
  checks.push('four-outcomes', 'independent-notification-status', 'ended-is-not-all-passed', 'same-title-stable-stage-ids')
  const toggle = page.locator('[data-task-card-action="toggle-checkpoints"]').first()
  if (await toggle.count() === 0) throw new Error('checkpoint_keyboard_button_not_found')
  await toggle.focus(); await page.keyboard.press('Enter')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  const outline = await toggle.evaluate(element => getComputedStyle(element).outlineStyle)
  assert.notEqual(outline, 'none')
  checks.push('keyboard-enter-expands', 'visible-focus')
  await page.screenshot({ path: path.join(output, 'observer-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.observer-task-board > div').last().evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.locator('.observer-task-board > div').last().locator(':scope > div').last().evaluate(element => { element.scrollTop = 0 })
  const narrow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, board: document.querySelector('.observer-task-board').getBoundingClientRect().width }))
  assert.ok(narrow.board <= narrow.viewport, '任务看板应保持窄屏单列宽度')
  await toggle.focus(); await page.keyboard.press(' ')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  checks.push('narrow-keyboard-space-collapses')
  checks.push('narrow-chinese-cards')
  await page.screenshot({ path: path.join(output, 'observer-narrow.png'), fullPage: true })
  mode = 'empty'; await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText('暂无已结束任务', { exact: false }).waitFor({ timeout: 5000 }).catch(async () => { assert.equal(await page.getByRole('progressbar').count(), 0) })
  checks.push('empty-task-list')
  mode = 'error'; await page.waitForTimeout(1300); await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText(/无法连接 resident 插件.*隔离夹具模拟读取失败/).waitFor()
  checks.push('read-error-visible')
  assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, [])
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ checks, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), viewport: narrow, errors, writes: blockedWrites, boundary: '完整observer源码与真实React浏览器渲染；DSH壳、UI primitive与API为替身。未接真实profile、未发送任何消息；不覆盖原生DSH菜单或生产认证。' }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, passed: true, narrow }))
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
