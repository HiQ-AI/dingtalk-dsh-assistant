// Real Chromium/React and complete observer CSS; synthetic task/API data only.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
const [toolsRoot, output, executablePath, reactRoot = toolsRoot] = process.argv.slice(2)
assert.ok(toolsRoot && output && executablePath, 'usage: node browser.mjs <browser-tools-root> <output> <browser-executable> [react-root]')
const require = createRequire(`${toolsRoot}/package.json`)
const { chromium } = require('playwright-core')
const root = new URL('../../../', import.meta.url)
const [react, dom, original] = await Promise.all([
  readFile(`${reactRoot}/node_modules/react/umd/react.development.js`, 'utf8'),
  readFile(`${reactRoot}/node_modules/react-dom/umd/react-dom.development.js`, 'utf8'),
  readFile(new URL('packages/dingtalk-dsh-observer/web-client.js', root), 'utf8'),
])
const source = original.replace('return module.exports', 'return { ...module.exports, TaskExecutionTimeline, observerCss, taskDetailCss }')
const timeline = { task: { startedAt: '2026-10-22T01:00:00Z', endedAt: '2026-10-22T02:00:00Z', status: 'completed', complete: true, events: [], segments: [] },
  executions: [{ id: 'e', title: '数据整理与核验', status: 'succeeded', complete: true,
    segments: [{ id: 'run', startedAt: '2026-10-22T01:00:00Z', endedAt: '2026-10-22T02:00:00Z', state: 'closed', status: 'recorded', label: '整理并核对材料' }],
    milestones: [{ id: 's1', at: '2026-10-22T01:05:00Z', summary: '已完成来源核对，输出材料索引。', activity: '等待原构建结果', evidence: ['https://example.test/proof/commit-123', 'javascript:alert(1)', 'docs/verification/' + '来源证据'.repeat(30) + '.json'] }, { id: 's2', at: '2026-10-22T01:30:00Z', summary: '整理结果已产出，边界检查尚待完成。' }] }],
  human: { id: 'human', title: '人工介入', complete: true, segments: [], milestones: [] } }
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font:14px system-ui;background:#fff;color:#25262b}button{font:inherit;cursor:pointer;padding:6px 10px;border:1px solid #c7c9d0;border-radius:6px;background:white}button:disabled{cursor:default;opacity:.5}</style><div id="root" data-dingtalk-observer></div><script>${react}</script><script>${dom}</script><script>window.__ModuleLoader__={load({factory}){window.preview=factory(name=>name==='react'?React:{Button:({children,variant,size,...props})=>React.createElement('button',props,children)})}}</script><script>${source}</script><script>const style=document.createElement('style');style.textContent=preview.observerCss+preview.taskDetailCss;document.head.append(style);ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'observer-session-detail'},React.createElement('h1',null,'材料整理任务 · 模拟预览'),React.createElement(preview.TaskExecutionTimeline,{taskId:'synthetic',timeline:${JSON.stringify(timeline)}})))</script></html>`
const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html) })
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []; page.on('pageerror', error => errors.push(error.message))
let failOlder = true, emptyRecords = false, firstRead = true
const initialRead = Promise.withResolvers()
const review = (id, at, summary) => ({ id, recordedAt: at, triggers: [{ kind: 'execution.progress.review' }], decision: { action: 'wait', summary, evidence: ['已核对当前目标、会话动作与产物记录。'], limitations: ['尚未完成最终核验。'] } })
await page.route('http://127.0.0.1:18998/**', async route => {
  if (firstRead) { firstRead = false; await initialRead.promise }
  if (emptyRecords) return route.fulfill({ json: { decisions: [], nextBefore: null } })
  const before = new URL(route.request().url()).searchParams.get('before')
  if (before === '20' && failOlder) return route.fulfill({ status: 500, json: { error: '模拟读取失败' } })
  const value = before === '40' ? { decisions: [review('r1', '2026-10-22T01:10:00Z', '未发现新偏离，继续等待当前执行。')], nextBefore: 20 }
    : before === '20' ? { decisions: [], nextBefore: null }
      : { decisions: [review('r2', '2026-10-22T01:40:00Z', '交付方向与目标一致；下一步核验结果边界。'), { id: 'other', triggers: [], decision: { summary: '普通决定不应混入' } }], nextBefore: 40 }
  await route.fulfill({ json: value })
})
try {
  await mkdir(output, { recursive: true }); await page.goto(`http://127.0.0.1:${server.address().port}`); await page.evaluate(() => document.fonts.ready)
  await page.getByText('正在读取统筹记录…', { exact: true }).waitFor()
  await page.getByText('报告时活动：等待原构建结果', { exact: true }).waitFor()
  initialRead.resolve()
  await page.getByText('交付方向与目标一致；下一步核验结果边界。', { exact: true }).waitFor()
  const outcomes = page.getByLabel('阶段成果与统筹巡查', { exact: true })
  await outcomes.getByText('报告时活动：等待原构建结果', { exact: true }).waitFor()
  assert.equal(await outcomes.getByRole('link', { name: 'https://example.test/proof/commit-123', exact: true }).getAttribute('href'), 'https://example.test/proof/commit-123')
  assert.equal(await outcomes.locator('a[href^="javascript:"]').count(), 0)
  await outcomes.getByText('阶段成果为执行会话报告；报告本身不代表已独立核验。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '读取更早记录' }).click()
  await page.getByText('未发现新偏离，继续等待当前执行。', { exact: true }).waitFor()
  assert.equal(await page.getByText('普通决定不应混入', { exact: true }).count(), 0)
  const labels = await page.locator('.timeline-outcomes li strong').allTextContents()
  assert.equal(labels.length, 4); assert.match(labels[0], /统筹巡查/); assert.match(labels[1], /阶段成果/); assert.match(labels[2], /统筹巡查/)
  await page.getByText('活动与时间明细', { exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('details.timeline-details').getAttribute('open'), '')
  await page.screenshot({ path: `${output}/task-review-results-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(await page.locator('.timeline-outcomes').evaluate(el => getComputedStyle(el).display), 'grid')
  await page.screenshot({ path: `${output}/task-review-results-mobile.png`, fullPage: true })
  await page.getByRole('button', { name: '读取更早记录' }).click(); await page.getByRole('button', { name: '重试读取记录' }).waitFor()
  assert.equal(await page.locator('.timeline-outcomes li').count(), 4)
  failOlder = false; await page.getByRole('button', { name: '重试读取记录' }).click()
  await page.getByRole('button', { name: '重试读取记录' }).waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '读取更早记录' }).count(), 0)
  const font = await page.locator('.timeline-outcomes').evaluate(el => getComputedStyle(el).fontFamily)
  emptyRecords = true
  await page.evaluate(() => {
    // 同一真实组件重挂到无成果任务，检查空记录而非制造一条默认成果。
    ReactDOM.createRoot(document.getElementById('root').appendChild(document.createElement('div'))).render(
      React.createElement('main', { className: 'observer-session-detail' }, React.createElement(preview.TaskExecutionTimeline,
        { taskId: 'empty', timeline: { task: { complete: false }, executions: [], human: { id: 'human', segments: [], milestones: [] } } })))
  })
  await page.getByText('已加载范围内暂无阶段成果或巡查结论。', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  const result = { passed: true, records: labels, evidenceAndActivityVisible: true, unsafeLinkRejected: true, keyboardDisclosure: true, narrowNoOverflow: true, failurePreservesRecords: true, loadingKeepsEvidence: true, emptyRecordsVisible: true, font, screenshots: output }
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser.close(); await new Promise(done => server.close(done)) }
