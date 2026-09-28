import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = await import(process.argv[3] || 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
const output = path.join(root, 'docs/tmp/task-current-steps/browser')
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

// 历史验收脚本硬编码执行切换；本脚本复用其真实 React 宿主，单独验证当前目录。
const replay = JSON.parse((await readFile(process.argv[2] || path.join(root, 'docs/tmp/task-current-steps/completed-copy-3/replay-details.json'), 'utf8')).replace(/^\uFEFF/, ''))
const cards = replay.map(item => item.detail), details = new Map(cards.map(task => [task.taskId, structuredClone(task)]))
assert.deepEqual(cards.map(task => task.executionNodes.length), [30, 3, 30])
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], writes = [], reads = [], realChecks = [], mockChecks = []
let failDetail = false, mockText = '', holdOutput = false, releaseOutput
// 在隔离宿主中冻结五秒自动刷新，仅显式刷新触发版本变化，避免夹具竞态。
await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, ms, ...args) => ms === 5000 ? interval(() => {}, ms) : interval(fn, ms, ...args) })
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  reads.push(target.pathname)
  let data = []
  if (target.pathname === '/state/tasks') data = cards
  if (target.pathname === '/health') data = { status: 'ok' }
  if (target.pathname === '/state/groups') data = [...new Set(cards.map(task => task.groupId))].map(groupId => ({ groupId, name: '隔离只读验收来源', messages: [], outbox: [] }))
  if (target.pathname === '/state/topics') data = { topics: [], total: 0 }
  const detail = /^\/state\/tasks\/([^/]+)\/detail$/.exec(target.pathname)
  if (detail) {
    if (failDetail) { return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离夹具模拟读取失败' }) }) }
    data = details.get(decodeURIComponent(detail[1])); assert.ok(data)
  }
  const node = /^\/state\/tasks\/([^/]+)\/runs\/([^/]+)\/nodes\/([^/]+)\/output$/.exec(target.pathname)
  if (node) {
    const task = decodeURIComponent(node[1]), nodeId = decodeURIComponent(node[3]), cursor = Number(target.searchParams.get('cursor'))
    const text = mockText || replay.find(item => item.taskId === task)?.outputs.find(item => item.nodeRunId === nodeId)?.text || ''
    const chunk = text.slice(cursor, cursor + 600)
    data = { text: chunk, overview: mockText ? '模拟长文摘要' : '', documentName: '', nextCursor: cursor + chunk.length < text.length ? cursor + chunk.length : null }
    if (holdOutput) { holdOutput = false; await new Promise(resolve => { releaseOutput = resolve }) }
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
const region = () => page.getByRole('region', { name: '任务执行详情', exact: true })
async function openCard(task) {
  await page.getByRole('button', { name: task.archivedAt ? '归档任务' : '任务看板', exact: true }).click()
  const card = page.getByRole('button').filter({ has: page.locator('strong[title]').filter({ hasText: task.title }) })
  await card.focus(); await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: task.title, exact: true }).waitFor()
}
async function back() { await page.getByRole('button', { name: '返回看板', exact: true }).focus(); await page.keyboard.press('Enter') }
async function refresh() { await page.getByRole('button', { name: '刷新', exact: true }).click() }
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  for (let i = 0; i < cards.length; i++) {
    const task = cards[i]; await openCard(task)
    assert.equal(await region().locator('li.observer-task-step').count(), [30, 3, 30][i])
    await page.getByRole('region', { name: '当前结果', exact: true }).waitFor()
    assert.equal(await page.getByText(/执行历史|返回最新执行|查看本次执行过程与会话/).count(), 0)
    const output = replay[i].outputs.find(item => item.text.length > 0)
    if (output) await page.waitForFunction(text => document.querySelector('[aria-label="任务执行详情"]')?.textContent.replace(/\s/g, '').includes(text.replace(/\s/g, '')), output.text.slice(0, 30))
    let pages = 0
    while (await region().getByRole('button', { name: '继续阅读产出', exact: true }).count()) {
      const button = region().getByRole('button', { name: '继续阅读产出', exact: true }).first()
      await button.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(30)
      assert.ok(++pages < 300)
    }
    for (const item of replay[i].outputs.filter(item => item.text.length > 600)) {
      const tail = item.text.trim().slice(-40)
      if (tail) await page.waitForFunction(text => document.querySelector('[aria-label="任务执行详情"]')?.textContent.replace(/\s/g, '').includes(text.replace(/\s/g, '')), tail)
    }
    assert.equal(await region().evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.screenshot({ path: path.join(outputDirectory(), `task-${i + 1}-desktop.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await region().evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.screenshot({ path: path.join(outputDirectory(), `task-${i + 1}-narrow.png`), fullPage: true })
    realChecks.push({ taskIndex: i + 1, nodes: [30, 3, 30][i], pages, completeOutput: true, noHistory: true, noOverflow: true, keyboard: true })
    await back(); await page.setViewportSize({ width: 1440, height: 1100 })
  }
  const task = cards[0]; await openCard(task)
  failDetail = true; await refresh()
  await page.getByRole('alert').filter({ hasText: '当前详情刷新失败' }).waitFor()
  assert.equal(await region().locator('li.observer-task-step').count(), 30)
  failDetail = false; await page.getByRole('button', { name: '重试读取详情', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '当前详情刷新失败' }).waitFor({ state: 'hidden' })
  mockChecks.push('refresh-error-preserves-content-and-retry')
  await region().locator('li.observer-task-step').first().focus()
  const changed = structuredClone(task), removed = changed.executionNodes.shift(), originalCount = changed.executionNodes.length
  changed.detailRevision += '-mock-1'; changed.executionNodes = changed.executionNodes.map(node => node.outputRef ? { ...node, outputRef: node.outputRef + '-mock' } : node)
  changed.executionNodes.push({ ...removed, stepKey: 'mock-added-step', nodeId: 'mock-new', title: '模拟新增步骤', status: 'pending', outputRef: undefined, nodeRunId: undefined, definitionPending: false })
  mockText = '新版正文唯一标记' + '长文分页内容'.repeat(100) + '长文结束标记'; details.set(task.taskId, changed)
  await refresh(); await page.getByText('模拟新增步骤', { exact: true }).waitFor()
  assert.equal(await region().locator('li.observer-task-step').count(), originalCount + 1)
  assert.equal(await page.getByText('模拟新增步骤', { exact: true }).count(), 1)
  await page.getByText('正在阅读的步骤已从当前计划移除，已转到相邻步骤。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.stepKey), changed.executionNodes[0].stepKey)
  mockChecks.push('removed-reading-step-notice-and-adjacent-focus')
  const expandedOutput = region().locator('li.observer-task-step').filter({ has: page.locator('summary').filter({ hasText: '模拟长文摘要' }) }).first()
  await expandedOutput.locator('summary').click()
  await expandedOutput.getByRole('button', { name: '继续阅读产出', exact: true }).waitFor()
  await expandedOutput.getByRole('button', { name: '继续阅读产出', exact: true }).focus(); await page.keyboard.press('Enter')
  await expandedOutput.getByText(/长文结束标记/).waitFor()
  mockChecks.push('revision-resets-body-remove-add-without-duplicates')
  changed.detailRevision += '-unrelated'; details.set(task.taskId, structuredClone(changed)); await refresh()
  await expandedOutput.getByText(/长文结束标记/).waitFor()
  assert.equal(await expandedOutput.locator('details').getAttribute('open'), '')
  assert.equal(await expandedOutput.getByRole('button', { name: '继续阅读产出', exact: true }).count(), 0)
  mockChecks.push('unrelated-revision-keeps-expanded-long-body')
  holdOutput = true; changed.detailRevision += '-slow'; changed.executionNodes = changed.executionNodes.map(node => node.outputRef ? { ...node, outputRef: node.outputRef + '-slow' } : node); details.set(task.taskId, structuredClone(changed)); await refresh()
  for (let attempt = 0; !releaseOutput && attempt < 100; attempt++) await page.waitForTimeout(20)
  assert.ok(releaseOutput)
  mockText = '当前版本慢响应隔离标记'; changed.detailRevision += '-current'; changed.executionNodes = changed.executionNodes.map(node => node.outputRef ? { ...node, outputRef: node.outputRef + '-current' } : node); details.set(task.taskId, structuredClone(changed)); await refresh()
  await region().locator('summary').filter({ hasText: '模拟长文摘要' }).first().click()
  await page.getByText(mockText, { exact: true }).first().waitFor(); releaseOutput(); releaseOutput = undefined
  await page.waitForTimeout(100)
  assert.equal(await region().getByText(/长文结束标记/).count(), 0)
  mockChecks.push('stale-slow-output-cannot-mix-current-body')
  changed.detailRevision += '-empty'; changed.executionNodes = []; changed.plan.stepsResolved = false
  details.set(task.taskId, structuredClone(changed)); await refresh()
  await page.getByText('该阶段步骤待确定', { exact: true }).waitFor()
  assert.equal(await region().getByText(/100%/).count(), 0)
  assert.equal(await region().locator('li.observer-task-step').count(), 0)
  mockChecks.push('empty-unresolved-plan-not-complete')
  changed.detailRevision += '-pending'; changed.executionNodes = [{ ...removed, stepKey: 'mock-pending', definitionPending: true, status: 'pending', outputRef: undefined, nodeRunId: undefined }]
  details.set(task.taskId, structuredClone(changed)); await refresh()
  await region().locator('li.observer-task-step').waitFor()
  assert.equal(await region().getByRole('progressbar').getAttribute('aria-valuenow'), '0')
  assert.equal(await region().getByText(/100%/).count(), 0)
  mockChecks.push('pending-definition-not-complete')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
  assert.equal(reads.some(item => item.endsWith('/executions') || item.endsWith('/runs')), false)
  const result = { passed: true, realChecks, mockChecks, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), viewports: [1440, 390], errors, writes, boundary: '真实完成任务只读快照重放，React/observer为真实代码，宿主与API为隔离替身；mock变化场景独立列出。全部18998请求被截获，未发消息、未重跑任务、未部署。' }
  await writeFile(path.join(outputDirectory(), 'browser-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: true, realTasks: realChecks.length, mockChecks: mockChecks.length, output }))
} catch (error) { await writeFile(path.join(outputDirectory(), 'failure.html'), await page.content()); throw error } finally { releaseOutput?.(); await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
function outputDirectory() { return output }
