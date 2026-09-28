import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { taskWorkflowCatalog } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = await import(process.argv[4] || 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
const output = path.join(root, 'docs/tmp/task-card-execution-history-browser')
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

// 输入为本机只读快照，不嵌入或提交真实群/任务 ID。
if (!process.argv[2] || !process.argv[3]) throw new Error('usage: node verify-browser.mjs <task-inventory.json> <lineage.json> [playwright-module-url]')
const inventory = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''))
const lineage = JSON.parse((await readFile(process.argv[3], 'utf8')).replace(/^\uFEFF/, ''))
const taskMap = new Map(inventory.map(task => [task.taskId, task]))
const details = new Map(), histories = new Map(), runs = new Map(), cards = []
for (const family of lineage) {
  const latest = family.executions.at(-1).taskId, rootId = family.executions[0].taskId
  // lineage.runs 按执行时间升序；与 API 对 catalog 的 rowid DESC runs 反转后的顺序一致。
  const executions = family.executions.map(execution => {
    const task = taskMap.get(execution.taskId)
    if (!task) throw new Error('snapshot task missing')
    const detail = { ...task, logicalTaskId: rootId, latestTaskId: latest, executionNumber: execution.executionNumber, executionCount: family.executions.length }
    details.set(task.taskId, detail)
    runs.set(task.taskId, { taskOwner: null, runs: execution.runs.map(run => ({ runId: run.run_id, startedAt: run.created_at, status: run.status, nodes: [] })), nextCursor: null })
    return { taskId: task.taskId, executionNumber: execution.executionNumber, state: task.state, outcome: execution.outcome, title: task.title, objective: task.objective, createdAt: task.createdAt, updatedAt: task.updatedAt, archivedAt: execution.archivedAt, result: task.result, stageOutcomes: execution.runs.map(run => ({ runId: run.run_id, title: task.plan?.stages.find(stage => stage.runId === run.run_id)?.title ?? taskWorkflowCatalog.find(item => item.id === run.workflow_id)?.label ?? '工程执行', status: run.status })) }
  }).reverse()
  histories.set(rootId, { rootTaskId: rootId, latestTaskId: latest, total: executions.length, executions, nextOffset: null })
  cards.push(details.get(latest))
}
assert.deepEqual(lineage.map(family => family.taskCount), [7, 6])
assert.equal(cards.length, 2)
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], reads = [], writes = [], checks = []
let failHistoryOnce = false, failDetailOnce = false, holdDetail = '', releaseDetail
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  reads.push(target.pathname)
  let data = []
  if (target.pathname === '/state/tasks') data = cards
  if (target.pathname === '/health') data = { status: 'ok' }
  if (target.pathname === '/state/groups') data = [...new Set(cards.map(task => task.groupId))].map(groupId => ({ groupId, name: '隔离只读验收来源', messages: [], outbox: [] }))
  if (target.pathname === '/state/topics') data = { topics: [], total: 0 }
  const match = /^\/state\/tasks\/([^/]+)\/(detail|executions|runs)$/.exec(target.pathname)
  if (match) {
    const id = decodeURIComponent(match[1]), operation = match[2]
    if ((operation === 'executions' && failHistoryOnce) || (operation === 'detail' && failDetailOnce)) {
      failHistoryOnce = false; failDetailOnce = false
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离夹具模拟读取失败' }) })
    }
    if (operation === 'detail' && id === holdDetail) await new Promise(resolve => { releaseDetail = resolve })
    data = operation === 'detail' ? details.get(id) : operation === 'executions' ? histories.get(id) : runs.get(id)
    if (!data) throw new Error('unknown fixture read')
  }
  if (target.pathname.endsWith('/output')) data = { text: '隔离接口替身：展示选中执行的节点产出。', overview: '', documentName: '', nextCursor: null }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
const review = lineage[0], merge = lineage[1], reviewLatest = details.get(review.executions.at(-1).taskId), mergeLatest = details.get(merge.executions.at(-1).taskId)
const detailRegion = () => page.getByRole('region', { name: '任务执行详情', exact: true })
const historySummary = count => page.locator('summary').filter({ hasText: `执行历史（${count} 次）` })
async function openCard(task) {
  await page.getByRole('button').filter({ has: page.locator('strong[title]').filter({ hasText: task.title }) }).click()
  await page.getByRole('heading', { name: task.title, exact: true }).waitFor()
}
async function openHistory(count) {
  const summary = historySummary(count)
  await summary.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '正在查看', exact: true }).waitFor()
}
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  assert.equal(await page.locator('strong[title]').count(), 2)
  const sourceBaseline = require('node:child_process').execFileSync('git', ['show', 'HEAD:packages/dingtalk-dsh-observer/web-client.js'], { cwd: root, encoding: 'utf8' })
  for (const [start, end] of [['      const renderTaskCard =', '      const bucketColumns ='], ["        React.createElement('section', { 'aria-label': '执行步骤'", "        React.createElement('section', { 'aria-label': '最新产出'"]]) assert.equal(observer.slice(observer.indexOf(start), observer.indexOf(end, observer.indexOf(start))).replace(/\r\n/g, '\n'), sourceBaseline.slice(sourceBaseline.indexOf(start), sourceBaseline.indexOf(end, sourceBaseline.indexOf(start))).replace(/\r\n/g, '\n'))
  checks.push('two-real-families-two-cards', 'card-and-step-source-unchanged')
  await openCard(reviewLatest)
  assert.equal(reads.filter(route => route.endsWith('/executions')).length, 0)
  assert.equal(await detailRegion().locator('li.observer-task-step').count(), reviewLatest.executionNodes.length)
  await openHistory(7)
  assert.equal(await page.getByRole('button', { name: '查看此次执行', exact: true }).count(), 6)
  checks.push('history-lazy-seven-executions', 'keyboard-history-disclosure', 'latest-steps-preserved')
  const expectedUrl = /https?:\/\/[^\s。]+/.exec(details.get(review.executions[0].taskId).result)[0]
  const link = page.locator('article').filter({ hasText: '第 1 次 ·' }).getByRole('link')
  assert.equal(await link.getAttribute('href'), expectedUrl)
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(await link.evaluate(element => element.tagName), 'A')
  // 阻止默认外部导航，只核验可点击真实 anchor 及 href。
  await link.evaluate(element => { element.addEventListener('click', event => { event.preventDefault(); window.historyLinkClicked = true }, { once: true }) })
  await link.click()
  assert.equal(await page.evaluate(() => window.historyLinkClicked), true)
  checks.push('history-pr-link-click-and-href-without-external-navigation')

  await page.screenshot({ path: path.join(output, 'review-desktop.png'), fullPage: true })
  // 保留最新这次失败部署及成功重建，不将阶段次数作为整项执行次数。
  await page.locator('summary').filter({ hasText: '查看本次执行过程与会话' }).click()
  await page.getByRole('region', { name: '本次执行过程与会话' }).getByText(/执行失败/).waitFor()
  assert.equal(await page.getByRole('region', { name: '本次执行过程与会话' }).locator('details').count(), 4)
  assert.ok(await page.getByRole('region', { name: '本次执行过程与会话' }).getByText(/已完成/).count() >= 3)
  const latestRow = page.locator('article').filter({ hasText: '第 7 次 ·' })
  const stageSummary = histories.get(review.executions[0].taskId).executions[0].stageOutcomes
  assert.equal(stageSummary.length, 4)
  assert.equal(stageSummary[2].status, 'failed')
  assert.equal(stageSummary[3].status, 'succeeded')
  await latestRow.getByText(`${stageSummary[2].title} · 失败`, { exact: true }).waitFor()
  await latestRow.getByText(`${stageSummary[3].title} · 已完成`, { exact: true }).waitFor()
  checks.push('review-failed-deployment-and-successful-rebuild-in-history-and-runs')
  const historical = review.executions[1], oldReview = details.get(historical.taskId)
  const row = page.locator('article').filter({ hasText: '第 2 次 ·' })
  await row.getByRole('button', { name: '查看此次执行', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.getByText('第 2 次执行 · 历史记录', { exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: oldReview.title, exact: true }).count(), 1)
  assert.equal(await detailRegion().locator('li.observer-task-step').count(), oldReview.executionNodes.length)
  const expectedResult = oldReview.result || '暂未记录产出'
  assert.equal(await page.getByRole('region', { name: '最新产出' }).locator('div').first().textContent(), expectedResult)
  await page.waitForTimeout(5500)
  await page.getByText('第 2 次执行 · 历史记录', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '返回最新执行', exact: true }).count(), 1)
  checks.push('keyboard-switch-physical-detail-and-output', 'refresh-keeps-historical-execution')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await detailRegion().evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
  await page.screenshot({ path: path.join(output, 'historical-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '返回最新执行', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.getByText('第 7 次执行 · 最新执行', { exact: true }).waitFor()
  checks.push('narrow-no-detail-overflow', 'keyboard-return-latest')
  await page.getByRole('button', { name: '返回看板', exact: true }).click()
  await openCard(mergeLatest)
  failHistoryOnce = true
  await historySummary(6).click()
  await page.getByRole('alert').filter({ hasText: '执行历史读取失败' }).waitFor()
  await page.getByRole('button', { name: '重试读取历史', exact: true }).click()
  await page.getByRole('button', { name: '正在查看', exact: true }).waitFor()
  const cancelledRow = page.locator('article').filter({ hasText: '第 4 次 · 已取消' })
  const cancelledStages = histories.get(merge.executions[0].taskId).executions.find(execution => execution.executionNumber === 4).stageOutcomes
  assert.equal(cancelledStages.length, 1)
  assert.equal(cancelledStages[0].status, 'succeeded')
  assert.equal(await cancelledRow.getByText(`${cancelledStages[0].title} · 已完成`, { exact: true }).count(), 1)
  assert.equal(await cancelledRow.getByText(/受阻/).count(), 0)
  assert.equal(await page.getByRole('button', { name: '查看此次执行', exact: true }).count(), 5)
  checks.push('merge-six-executions', 'cancelled-engineering-success-visible', 'history-error-retry')
  failDetailOnce = true
  await cancelledRow.getByRole('button', { name: '查看此次执行' }).click()
  await page.getByRole('alert').filter({ hasText: '任务详情读取失败' }).waitFor()
  assert.equal(await page.getByRole('region', { name: '执行步骤', exact: true }).count(), 0)
  await page.getByRole('button', { name: '重试读取详情', exact: true }).click()
  await page.getByText('第 4 次执行 · 历史记录', { exact: true }).waitFor()
  checks.push('detail-error-hides-previous-target-and-steps', 'detail-error-retry')
  await page.screenshot({ path: path.join(output, 'merge-cancelled-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '返回看板', exact: true }).click()
  holdDetail = reviewLatest.taskId
  await page.getByRole('button').filter({ has: page.locator('strong[title]').filter({ hasText: reviewLatest.title }) }).click()
  await page.getByText('正在读取此次执行…', { exact: true }).waitFor()
  assert.equal(await page.getByRole('region', { name: '执行步骤', exact: true }).count(), 0)
  await page.getByRole('button', { name: '返回看板', exact: true }).click()
  await openCard(mergeLatest)
  holdDetail = ''; releaseDetail()
  await page.waitForTimeout(250)
  await page.getByRole('heading', { name: mergeLatest.title, exact: true }).waitFor()
  checks.push('slow-detail-loading-clears-old-content', 'stale-detail-response-cannot-replace-selection')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ passed: true, checks, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), viewport: [1440, 390], errors, writes, boundary: '隔离本机只读快照 UI 验收：真实 React/ReactDOM 与完整 observer；DSH 外壳、primitive 和接口响应为替身。未连接生产 profile，未重新执行业务、未发送消息、未部署。' }, null, 2))
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
} finally { releaseDetail?.(); await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
