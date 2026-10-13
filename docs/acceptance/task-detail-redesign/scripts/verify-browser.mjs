import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

// 可重放的全合成夹具：真实 React + 完整 observer；宿主 primitive 与 API 为隔离替身。
// 先 pnpm install --frozen-lockfile；第 3 参数可覆写 Playwright 模块 file: URL。
// 用法：node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs baseline|round-N [playwright-module-url]
const BASE_COMMIT = '462c213fe84bcd1ce5e31e1015d3fde0a1f81212'
const mode = process.argv[2] || 'round-1'
assert.match(mode, /^(baseline|round-\d+)$/)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const output = path.join(root, 'docs/tmp/task-detail-redesign', mode)
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const playwright = await import(process.argv[3] || 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
const reactPath = require.resolve('react/package.json')
const reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
assert.ok(domDirectory, 'matching_react_dom_required')
const observer = mode === 'baseline'
  ? execFileSync('git', ['show', `${BASE_COMMIT}:packages/dingtalk-dsh-observer/web-client.js`], { cwd: root, encoding: 'utf8' })
  : await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const baseCommit = execFileSync('git', ['rev-parse', BASE_COMMIT], { cwd: root, encoding: 'utf8' }).trim()
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>任务详情隔离验收</title><style>
:root{--dsw-alias-label-primary:#202124;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f7f8;--dsw-alias-label-secondary:#686868;--dsw-alias-border-l2:#d5d5d8;--dsw-alias-brand-primary:#4d6bfe}
html[data-theme=dark]{color-scheme:dark;--dsw-alias-label-primary:#eee;--dsw-alias-bg-base:#191a1c;--dsw-alias-bg-layer-1:#242529;--dsw-alias-label-secondary:#aaa;--dsw-alias-border-l2:#45464b;--dsw-alias-brand-primary:#9aaaff;--dsw-alias-state-warn-primary:#d6aa5b;--dsw-alias-state-error-primary:#ff9292;--dsw-alias-state-success-primary:#71c58a}
body{margin:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:0 8px}#app{height:calc(100dvh - 50px)}button{font:inherit}button[data-primitive]{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:inherit;cursor:pointer}button[data-primitive]:disabled{opacity:.5;cursor:default}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const primitives={Button:({variant,size,children,...props})=>h('button',{'data-primitive':'button',...props},children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=7})=>h('span',{'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor})=>anchor};
for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true},h('path',{d:'M3 5L7 9L11 5',fill:'none',stroke:'currentColor'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const titles = ['确认材料范围', '核对资料', '生成实施方案', '环境不适用步骤', '核对资料', '等待补充验收范围', '执行检查', '汇总检查结果', '核对资料', '提交变更', '回读交付结果', '整理最终说明']
const nodes = titles.map((title, index) => ({
  stepKey: `fixture-step-${index + 1}`, nodeId: `node-${index + 1}`, nodeRunId: `node-run-${index + 1}`, runId: `run-${Math.floor(index / 4) + 1}`,
  stageId: `stage-${Math.floor(index / 4) + 1}`, stageTitle: ['调查与准备', '执行与验证', '交付与回读'][Math.floor(index / 4)],
  title, status: index < 5 ? 'succeeded' : index === 5 ? 'waiting' : 'pending',
  ...(index < 6 ? { startedAt: `2026-10-13T01:${String(index * 3).padStart(2, '0')}:00.000Z`, completedAt: `2026-10-13T01:${String(index * 3 + 2).padStart(2, '0')}:00.000Z`, leaseEpoch: index === 4 ? 2 : 1 } : {}),
  ...(index < 5 && index !== 3 ? { outputRef: `artifact-${index + 1}`, sessionId: `session-step-${index + 1}` } : {}),
  ...(index === 3 ? { control: { action: 'skip', reason: '该环境没有独立发布步骤，已由任务负责人确认不适用。', source: 'operator' } } : {}),
  ...(index === 4 ? { control: { action: 'reuse', reason: '复用同一输入版本的核验结论。', source: 'task-session' } } : {}),
  ...(index === 5 ? { waitReason: { reference: '等待任务发起人确认需要覆盖的验收范围。' }, sessionId: 'session-current-step' } : {}),
}))
const fixture = {
  taskId: 'task-redesign-fixture', engine: 'workflow-v2', groupId: 'group-fixture', state: 'waiting', title: '完成供应链服务升级并核验交付',
  objective: '根据任务要求完成材料核对、方案实施与交付回读。\n完整目标保留所有约束：先核对范围，再执行检查，最后确认交付结果。' + '需要明确记录证据来源、执行限制和未确认事项。'.repeat(16),
  createdAt: '2026-10-13T00:58:00.000Z', updatedAt: '2026-10-13T01:17:00.000Z', waitingReason: '等待用户补充验收范围，已完成的材料和检查结论可继续阅读。',
  executionTiming: { elapsedMs: 600000, sampledAt: '2026-10-13T01:17:00.000Z', running: false, complete: true },
  detailRevision: 'revision-1', executionNodes: nodes,
  result: '已完成材料整理和方案核对，等待确认验收范围。\n[查看交付说明](https://example.test/delivery/report) 与 https://example.test/review/42',
  plan: { stepsResolved: true, stages: ['调查与准备', '执行与验证', '交付与回读'].map((title, i) => ({ stageId: `stage-${i + 1}`, title, status: i === 0 ? 'succeeded' : i === 1 ? 'waiting_confirmation' : 'ready' })) },
  workflowProgress: { outcomeLabel: '等待补充', stages: [] },
}
let detail = structuredClone(fixture), detailFailure = false, detailHold = false, releaseDetail
let failOutput = false, holdOutput = false, releaseOutput, overrideText = ''
const textFor = id => `产出摘要\n${id} 已完成核对，输入材料与当前版本一致。\n\n正文\n` + ('这是合成的验收正文。中文长文本、English-token-' + 'x'.repeat(100) + '，用来检查换行和长段落阅读。\n').repeat(13) + `\n${id}-正文结束标记`
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultTimeout(10000)
const errors = [], writes = [], requests = [], checks = [], metrics = []
// 冻结五秒轮询；刷新仍走真实 UI 与真实 fetch，隔离时间导致的夹具竞态。
await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, ms, ...args) => ms === 5000 ? interval(() => {}, ms) : interval(fn, ms, ...args) })
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  requests.push({ path: target.pathname, query: Object.fromEntries(target.searchParams) })
  let data = []
  if (target.pathname === '/health') data = { status: 'ok' }
  if (target.pathname === '/state/tasks') data = [fixture]
  if (target.pathname === '/state/groups') data = [{ groupId: fixture.groupId, name: '隔离验收群', messages: [], outbox: [] }]
  if (target.pathname === '/state/topics') data = { topics: [], total: 0 }
  if (target.pathname.endsWith('/detail')) {
    if (detailHold) { detailHold = false; await new Promise(resolve => { releaseDetail = resolve }) }
    if (detailFailure) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成夹具读取失败' }) })
    data = structuredClone(detail)
  }
  const match = /\/nodes\/([^/]+)\/output$/.exec(target.pathname)
  if (match) {
    if (failOutput) { failOutput = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成夹具产出失败' }) }) }
    const text = overrideText || textFor(match[1]), cursor = Number(target.searchParams.get('cursor'))
    const chunk = text.slice(cursor, cursor + 600)
    data = { text: chunk, overview: `验收摘要 ${match[1]}`, documentName: '检查记录.txt', nextCursor: cursor + chunk.length < text.length ? cursor + chunk.length : null }
    if (holdOutput) { holdOutput = false; await new Promise(resolve => { releaseOutput = resolve }) }
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
const region = () => page.getByRole('region', { name: '任务执行详情', exact: true })
const active = () => page.getByRole('region', { name: '步骤详情', exact: true })
const navigation = () => region().locator('.observer-task-navigation')
const step = key => navigation().locator(`li[data-step-key="${key}"] button`)
const outputReads = () => requests.filter(request => request.path.endsWith('/output'))
async function openCard() {
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  const card = page.getByRole('button').filter({ has: page.locator(`strong[title="${fixture.title}"]`) })
  await card.focus(); await page.keyboard.press('Enter')
}
async function back() { await page.getByRole('button', { name: '返回看板', exact: true }).click() }
async function refresh() {
  const before = requests.filter(item => item.path.endsWith('/detail')).length
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="刷新"]')?.getAttribute('aria-busy') !== 'true')
  for (let i = 0; requests.filter(item => item.path.endsWith('/detail')).length <= before && i < 100; i++) await page.waitForTimeout(20)
  assert.ok(requests.filter(item => item.path.endsWith('/detail')).length > before, 'refresh_detail_requested')
  await page.waitForTimeout(80)
}
async function select(key) {
  await step(key).focus(); await page.keyboard.press('Enter')
  await active().waitFor()
  assert.equal(await active().getAttribute('data-step-key'), key)
  assert.equal(await step(key).getAttribute('aria-pressed'), 'true')
}
async function expand() { const summary = active().locator('summary'); await summary.waitFor(); if (await summary.locator('..').getAttribute('open') === null) await summary.click(); await active().locator('details[open] > div').waitFor() }
async function screenshot(name) { await page.screenshot({ path: path.join(output, name), fullPage: true }) }
async function recordLayout(label) {
  const result = await region().evaluate(element => {
    const box = element.getBoundingClientRect(), result = element.querySelector('[aria-label="当前结果"]')?.getBoundingClientRect(), nav = element.querySelector('.observer-task-navigation')?.getBoundingClientRect(), reading = element.querySelector('.observer-task-reading')?.getBoundingClientRect()
    return { width: box.width, scrollWidth: element.scrollWidth, height: box.height, resultTop: result?.top, resultHeight: result?.height, nav: nav && { x: nav.x, y: nav.y, width: nav.width, height: nav.height }, reading: reading && { x: reading.x, y: reading.y, width: reading.width, height: reading.height }, documentOverflow: document.documentElement.scrollWidth > innerWidth + 2 }
  })
  metrics.push({ label, viewport: page.viewportSize(), ...result })
  assert.equal(result.scrollWidth > result.width + 2, false, `${label}_region_overflow`)
  assert.equal(result.documentOverflow, false, `${label}_document_overflow`)
  return result
}
async function check(id, label, fn) {
  try { await fn(); checks.push({ id, label, status: 'PASS' }) }
  catch (error) { checks.push({ id, label, status: 'FAIL', error: error.message }); throw error }
}
let failure
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  if (mode === 'baseline') {
    await openCard(); await region().locator('h1').waitFor()
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(element => element.textContent === '正在读取产出…'))
    assert.equal(await region().locator('.observer-task-step').count(), 12)
    await recordLayout('desktop'); await screenshot('desktop.png')
    await page.setViewportSize({ width: 390, height: 844 }); await recordLayout('narrow'); await screenshot('narrow.png')
    checks.push({ id: 'baseline', label: '相同合成任务、origin/main 完整源码的改版前截图和指标', status: 'PASS', eagerOutputRequests: outputReads().length })
  } else {
    await check('loading', '首次详情读取等待、失败与重试', async () => {
      detailHold = true; await openCard()
      await page.getByText('正在读取当前任务详情…', { exact: true }).waitFor()
      await screenshot('loading.png'); detailFailure = true; releaseDetail(); releaseDetail = undefined
      await page.getByRole('alert').filter({ hasText: '任务详情读取失败' }).waitFor()
      await screenshot('initial-error.png'); detailFailure = false
      await page.getByRole('button', { name: '重试读取详情', exact: true }).click()
      await region().locator('h1').waitFor()
    })
    await check('overview', '结果前置、完整分组、默认选中当前等待步骤及懒读取', async () => {
      assert.equal(await navigation().locator('li[data-step-key] button').count(), 12)
      assert.equal(await navigation().locator('.observer-task-workflow').count(), 3)
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-6')
      assert.equal(outputReads().length, 0, 'unvisited_outputs_must_not_load')
      assert.equal(await region().evaluate(element => !!(element.querySelector('[aria-label="当前结果"]').compareDocumentPosition(element.querySelector('[aria-label="执行步骤"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
      assert.ok((await region().innerText()).includes('累计执行时长 10 分 0 秒'))
      assert.equal(await region().getByRole('progressbar').getAttribute('aria-valuenow'), '42')
      assert.equal(await region().getByRole('link', { name: '查看交付说明', exact: true }).getAttribute('href'), 'https://example.test/delivery/report')
      const objective = region().locator('details').filter({ has: page.locator('summary').filter({ hasText: /^任务目标$/ }) })
      await objective.locator('summary').click(); assert.equal(await objective.locator('p').textContent(), fixture.objective); await objective.locator('summary').click()
      await recordLayout('desktop'); await screenshot('desktop.png')
      await page.setViewportSize({ width: 390, height: 844 })
      const initialSelection = await step('fixture-step-6').evaluate(element => { const bounds = element.getBoundingClientRect(), nav = element.closest('nav').getBoundingClientRect(); return { selectedTop: bounds.top, selectedBottom: bounds.bottom, navTop: nav.top, navBottom: nav.bottom, selectedVisibleInsideDirectory: bounds.top >= nav.top && bounds.bottom <= nav.bottom } })
      metrics.push({ label: 'initial-selection-narrow', ...initialSelection })
      await screenshot('initial-selection-narrow.png'); await page.setViewportSize({ width: 1440, height: 1100 })
    })
    if (!['round-1', 'round-2'].includes(mode)) await check('initial-visible', '进入窄屏后初始选中步骤处于目录可视区', async () => {
      assert.equal(metrics.find(item => item.label === 'initial-selection-narrow').selectedVisibleInsideDirectory, true)
    })
    await check('keyboard', '原生按钮选择、焦点可见及目录和阅读跳转', async () => {
      await page.keyboard.press('Tab'); await step('fixture-step-6').focus()
      assert.equal(await step('fixture-step-6').evaluate(element => getComputedStyle(element).outlineStyle), 'solid')
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.closest('[data-step-key]')?.dataset.stepKey), 'fixture-step-7')
      await page.keyboard.press('Enter'); assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-7')
      const read = page.getByRole('button', { name: '查看所选步骤', exact: true }); await read.focus(); await page.keyboard.press('Enter')
      assert.equal(await active().locator('h3').evaluate(element => element === document.activeElement), true)
      const returnNav = active().getByRole('button', { name: '返回步骤目录', exact: true }); await returnNav.focus(); await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(() => document.activeElement.closest('[data-step-key]')?.dataset.stepKey), 'fixture-step-7')
    })
    await check('output', '产出读取失败重试、分页、长文本、下载地址', async () => {
      failOutput = true; await select('fixture-step-1')
      await active().getByRole('alert').waitFor(); await active().getByRole('button', { name: '重试读取产出', exact: true }).click(); await expand()
      let pages = 0
      while (await active().getByRole('button', { name: '继续阅读产出', exact: true }).count()) { const response = page.waitForResponse(response => response.url().includes('/output?')); await active().getByRole('button', { name: '继续阅读产出', exact: true }).click(); await response; await active().getByText('正在读取产出…', { exact: true }).waitFor({ state: 'hidden' }); assert.ok(++pages < 20) }
      await active().getByText(/node-run-1-正文结束标记/).waitFor()
      const href = await active().getByRole('link', { name: '下载 检查记录.txt', exact: true }).getAttribute('href')
      assert.ok(href.includes('/nodes/node-run-1/document?ref=artifact-1&detailRevision=revision-1'))
      assert.ok(pages >= 2); await recordLayout('long-text'); await screenshot('long-output.png')
    })
    await check('preserve', '切换与刷新保持选择、分页和展开', async () => {
      const count = outputReads().length
      await select('fixture-step-7'); await select('fixture-step-1')
      await active().getByText(/node-run-1-正文结束标记/).waitFor()
      assert.equal(await active().locator('details').getAttribute('open'), '')
      assert.equal(outputReads().length, count)
      detail.detailRevision = 'revision-unrelated'; await refresh()
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-1')
      await active().getByText(/node-run-1-正文结束标记/).waitFor()
      assert.equal(await active().locator('details').getAttribute('open'), '')
      assert.equal(outputReads().length, count)
      detailFailure = true; await refresh()
      await page.getByRole('alert').filter({ hasText: '当前详情刷新失败' }).waitFor()
      await active().getByText(/node-run-1-正文结束标记/).waitFor()
      detailFailure = false; await page.getByRole('button', { name: '重试读取详情', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '当前详情刷新失败' }).waitFor({ state: 'hidden' })
    })
    await check('responsive', '390px 窄屏、暗色与完整目录触达', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await recordLayout('narrow-long-text'); await screenshot('narrow.png')
      await select('fixture-step-12'); await page.getByRole('button', { name: '查看所选步骤', exact: true }).click()
      await active().locator('h3').waitFor(); assert.equal(await active().locator('h3').evaluate(element => element === document.activeElement), true)
      assert.equal(await active().locator('h3').evaluate(element => element.getBoundingClientRect().top >= document.querySelector('[data-dingtalk-observer] > header').getBoundingClientRect().bottom), true, 'reading_focus_not_obscured')
      await screenshot('narrow-selected-last.png')
      await page.setViewportSize({ width: 1440, height: 1100 }); await select('fixture-step-6')
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.querySelector('[data-dingtalk-observer]').scrollTop = 0 })
      await recordLayout('dark'); await screenshot('dark.png'); await page.evaluate(() => delete document.documentElement.dataset.theme)
    })
    await check('controls', '跨组同名、跳过和复用的身份、原因与耗时', async () => {
      await select('fixture-step-2'); assert.equal(await active().locator('h3').innerText(), '核对资料')
      await select('fixture-step-5'); assert.equal(await active().locator('h3').innerText(), '核对资料')
      assert.ok((await active().innerText()).includes('已复用产出'))
      assert.ok((await active().innerText()).includes('复用同一输入版本的核验结论。'))
      assert.ok((await active().innerText()).includes('第 2 次处理'))
      await select('fixture-step-4'); assert.ok((await active().innerText()).includes('不适用 · 已跳过'))
      assert.ok((await active().innerText()).includes('该环境没有独立发布步骤'))
      await select('fixture-step-6'); assert.ok((await active().innerText()).includes('等待任务发起人确认需要覆盖的验收范围。'))
    })
    if (!['round-1', 'round-2'].includes(mode)) await check('directory-scroll', '直接窄屏打开可见且普通刷新不抢目录和正文位置', async () => {
      await back(); await page.setViewportSize({ width: 390, height: 844 }); await openCard(); await active().waitFor()
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-6')
      assert.equal(await step('fixture-step-6').evaluate(element => { const box = element.getBoundingClientRect(), nav = element.closest('nav').getBoundingClientRect(); return box.top >= nav.top && box.bottom <= nav.bottom }), true)
      const before = await navigation().evaluate(element => { element.scrollTop = 0; const host = document.querySelector('[data-dingtalk-observer]'); host.scrollTop = 600; return { directory: element.scrollTop, host: host.scrollTop } })
      detail.detailRevision = 'revision-preserve-directory-scroll'; await refresh()
      const after = await navigation().evaluate(element => ({ directory: element.scrollTop, host: document.querySelector('[data-dingtalk-observer]').scrollTop }))
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-6')
      assert.deepEqual(after, before)
      metrics.push({ label: 'refresh-preserves-scroll', before, after })
      await back(); await openCard(); await active().waitFor()
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-6')
      assert.equal(await step('fixture-step-6').evaluate(element => { const box = element.getBoundingClientRect(), nav = element.closest('nav').getBoundingClientRect(); return box.top >= nav.top && box.bottom <= nav.bottom }), true, 'same_task_reopen_narrow_selection_visible')
      await page.setViewportSize({ width: 1440, height: 1100 })
    })
    await check('slow', '新产物替换与旧慢响应隔离', async () => {
      await select('fixture-step-1')
      holdOutput = true; detail.detailRevision = 'revision-slow'; detail.executionNodes[0].outputRef = 'artifact-slow'; overrideText = '过期慢响应不得混入'; await refresh()
      for (let i = 0; !releaseOutput && i < 100; i++) await page.waitForTimeout(20)
      assert.ok(releaseOutput)
      detail.detailRevision = 'revision-new'; detail.executionNodes[0].outputRef = 'artifact-new'; overrideText = '新版本产物正文唯一标记'; await refresh(); await expand()
      await active().getByText(overrideText, { exact: true }).waitFor(); releaseOutput(); releaseOutput = undefined; await page.waitForTimeout(100)
      assert.equal(await region().getByText('过期慢响应不得混入', { exact: true }).count(), 0)
    })
    await check('removed', '选中步骤删除后相邻选择、焦点与提示', async () => {
      await select('fixture-step-5'); detail.executionNodes = detail.executionNodes.filter(node => node.stepKey !== 'fixture-step-5'); detail.detailRevision = 'revision-removed'; await refresh()
      await page.getByText('正在阅读的步骤已从当前计划移除，已转到相邻步骤。', { exact: true }).waitFor()
      assert.equal(await active().getAttribute('data-step-key'), 'fixture-step-6')
      assert.equal(await page.evaluate(() => document.activeElement.closest('[data-step-key]')?.dataset.stepKey), 'fixture-step-6')
    })
    await check('empty', '空计划与未确定步骤不误报完成', async () => {
      detail.executionNodes = []; detail.plan.stepsResolved = true; detail.detailRevision = 'revision-empty'; await refresh()
      await page.getByText('暂无执行步骤记录', { exact: true }).waitFor()
      assert.equal(await region().getByRole('progressbar').count(), 0)
      assert.equal(await region().getByRole('heading', { name: '执行步骤', exact: true }).evaluate(element => element === document.activeElement), true)
      await screenshot('empty.png')
      detail.plan.stepsResolved = false; detail.detailRevision = 'revision-unresolved'; await refresh(); await page.getByText('该阶段步骤待确定', { exact: true }).waitFor()
      detail.executionNodes = [{ ...nodes[6], definitionPending: true }]; detail.detailRevision = 'revision-definition'; await refresh()
      await active().waitFor(); assert.equal(await region().getByRole('progressbar').getAttribute('aria-valuenow'), '0')
      assert.equal(await region().getByText(/100%/).count(), 0)
    })
    await check('defaults', '首次选择失败、受阻、未开始和完成末步', async () => {
      for (const [status, expected] of [['failed', 2], ['blocked', 2], ['pending', 2], ['succeeded', 3]]) {
        await back(); detail = structuredClone(fixture); detail.executionNodes = nodes.slice(0, 3).map((node, index) => ({ ...node, status: index === 1 ? status : 'succeeded', outputRef: undefined }))
        detail.detailRevision = `revision-default-${status}`; await openCard(); await active().waitFor(); assert.equal(await active().getAttribute('data-step-key'), `fixture-step-${expected}`)
      }
    })
    if (mode !== 'round-1') await check('long-plan', '30 步完整目录、窄屏局部滚动和返回焦点无遮挡', async () => {
      await back(); detail = structuredClone(fixture)
      detail.executionNodes = Array.from({ length: 30 }, (_, index) => ({ ...nodes[6], stepKey: `long-step-${index + 1}`, nodeId: `long-node-${index + 1}`, title: `第 ${index + 1} 项核对事项`, status: index === 29 ? 'blocked' : 'succeeded', stageId: `long-stage-${Math.floor(index / 10)}`, stageTitle: `验收阶段 ${Math.floor(index / 10) + 1}` }))
      detail.detailRevision = 'revision-30-steps'; await openCard(); await active().waitFor()
      assert.equal(await active().getAttribute('data-step-key'), 'long-step-30')
      assert.equal(await navigation().locator('li[data-step-key]').count(), 30)
      await page.setViewportSize({ width: 390, height: 844 })
      const layout = await recordLayout('narrow-30-steps'); assert.ok(layout.nav.height <= 370)
      assert.ok(await navigation().evaluate(element => element.scrollHeight > element.clientHeight))
      await page.getByRole('button', { name: '查看所选步骤', exact: true }).click()
      await active().getByRole('button', { name: '返回步骤目录', exact: true }).click()
      assert.equal(await step('long-step-30').evaluate(element => element === document.activeElement), true)
      const visible = await step('long-step-30').evaluate(element => { const bounds = element.getBoundingClientRect(), nav = element.closest('nav').getBoundingClientRect(), header = document.querySelector('[data-dingtalk-observer] > header').getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, navTop: nav.top, navBottom: nav.bottom, headerBottom: header.bottom } })
      assert.ok(visible.top >= Math.max(visible.navTop, visible.headerBottom) - 2 && visible.bottom <= visible.navBottom + 2, JSON.stringify(visible))
      await screenshot('narrow-30-steps.png'); await page.setViewportSize({ width: 1440, height: 1100 })
    })
    await check('session', '会话入口打开选中步骤的真实 sessionId', async () => {
      await back(); detail = structuredClone(fixture); await openCard(); await active().waitFor()
      await active().getByRole('button', { name: '查看会话记录', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.opened), ['session-current-step'])
    })
    assert.deepEqual(errors, []); assert.deepEqual(writes, [])
    assert.equal(requests.some(item => item.path.endsWith('/executions') || item.path.endsWith('/runs')), false)
    checks.push({ id: 'isolation', label: '零运行时错误、零业务写入、无历史执行查询', status: 'PASS' })
  }
} catch (error) {
  failure = error
  await writeFile(path.join(output, 'failure.html'), await page.content())
  await screenshot('failure.png')
} finally {
  releaseOutput?.(); releaseDetail?.()
  const result = { passed: !failure, mode, baseCommit, sourceSha256: createHash('sha256').update(observer).digest('hex'), fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), browser: await browser.version(), reactVersion, checks, metrics, errors, writes, requests, boundary: '全部任务数据为合成夹具，真实 React 与完整 observer 源码；DSH primitive/槽位/会话 API 与所有运行时 HTTP 均为隔离替身。未连接真实运行时、未操作用户浏览器、未部署，不能证明真实钉钉或宿主集成。' }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: !failure, mode, checks: checks.length, output, failure: failure?.message }))
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve))
}
if (failure) throw failure
