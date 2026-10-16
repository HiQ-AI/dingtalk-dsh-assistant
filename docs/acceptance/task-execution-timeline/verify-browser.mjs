import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { projectTaskTimeline, projectTaskLifecycle } from '../../../packages/dingtalk-dsh-assistant/task-execution-timeline.js'

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../', import.meta.url))
const { chromium } = require('/opt/codex/cua_node/lib/node_modules/playwright')
const output = path.join(root, 'docs/acceptance/task-execution-timeline', process.env.TIMELINE_PREVIEW_DIR || 'preview')
await mkdir(output, { recursive: true })
const files = new Map([
  ['/react.js', await readFile(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile('/tmp/task-timeline-browser/node_modules/react-dom/umd/react-dom.development.js')],
  ['/observer.js', await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'))],
])
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>执行时间泳道图 · 隔离预览</title><style>body{margin:0;color:#202124;font:14px system-ui,sans-serif}button{font:inherit}#sidebar{padding:8px}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const h=React.createElement;const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:()=>h('span',null,'◉'),Menu:({anchor})=>anchor};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='main.conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},uiWorkspace:{openSession(){}},sessions:{subagentAddress(){},async refreshProjections(){},async refreshSubagents(){},async refresh(){},open(){}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); res.end(req.url === '/' ? html : files.get(req.url) || '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`, iso = minute => new Date(Date.parse('2026-10-16T10:00:00Z') + minute * 60000).toISOString()
const segment = (from, to, activity, state = 'closed') => ({ startedAt: iso(from), endedAt: to == null ? null : iso(to), activity, state })
const executions = [
  { title: '查询订单信息', status: 'succeeded', timeline: { complete: true, segments: [segment(1, 7, '查询订单信息'), segment(18, 19, '排查差异结果')] } },
  { title: '修改接口校验', status: 'succeeded', timeline: { complete: true, segments: [segment(7, 12, '修改接口校验')] } },
  { title: '修改页面提示', status: 'succeeded', timeline: { complete: true, segments: [segment(7, 16, '修改页面提示')] } },
  { title: '验证修复边界', status: 'running', drained: false, timeline: { complete: true, segments: [segment(18, null, '验证修复边界', 'running')] } },
  { title: '核对历史异常及完整中文名称与证据范围'.repeat(5), status: 'succeeded' },
  { title: '恢复后继续核对', status: 'running', recovering: true, drained: false, timeline: { complete: false, segments: [segment(2, 4, '读取配置'), segment(18, null, '崩溃区间不猜终点', 'unknown')] } },
].map((item, index) => ({ ...item, id: `e${index}`, executionId: `e${index}`, sessionId: `s${index}`, taskId: 'fixture', createdAt: iso(0), updatedAt: iso(20), drained: item.drained ?? true, prompt: item.title }))
const task = { taskId: 'fixture', title: '核对订单信息并验证修复', objective: '隔离示例：查询、并行修改、空档后续办及验证。不会调用真实业务或发送消息。', state: 'running', status: 'active', control: 'active', createdAt: iso(0), updatedAt: iso(20), executionCount: executions.length, runSequence: 2, requirementRevision: 2, controlRevision: 2,
  executionSessions: executions, humanRequests: [
    { requestId: 'answered', question: '请确认核对范围', createdAt: iso(4), answeredAt: iso(6), status: 'answered' },
    { requestId: 'superseded', question: '旧版本范围', createdAt: iso(13), supersededAt: iso(15), status: 'superseded' },
    { requestId: 'pending', question: '验证后是否保留原结果？', createdAt: iso(18), status: 'waiting-reply' },
  ] }
const wakes = [{ id: 'stage', taskId: 'fixture', kind: 'execution.stage.progress', payload: { executionId: 'e0', recordedAt: iso(7), summary: '已查询到差异证据' } }]
let mode = 'normal', detailFailure = false, delayDetail = false
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], checks = [], requests = []
page.on('pageerror', error => errors.push(error.message))
await context.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  assert.equal(route.request().method(), 'GET', 'preview never mutates business state')
  assert.equal(target.origin, 'http://127.0.0.1:18998')
  requests.push(target.pathname)
  let body = []
  if (target.pathname === '/state/tasks') body = [task]
  else if (target.pathname === '/state/overview') body = {}
  else if (target.pathname.endsWith('/detail')) {
    if (delayDetail) await new Promise(resolve => setTimeout(resolve, 350))
    if (detailFailure) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离读取失败' }) })
    const projected = structuredClone(task)
    if (mode === 'empty') projected.humanRequests = []
    const history = [{ sequence: 2, at: iso(18), completedAt: mode === 'missing-lifecycle' ? null : iso(16) }]
    const projectedExecutions = structuredClone(executions)
    if (mode === 'completed') {
      projected.status = 'completed'; projected.completion = { at: iso(20) }
      projected.humanRequests.at(-1).status = 'answered'; projected.humanRequests.at(-1).answeredAt = iso(20)
      for (const execution of projectedExecutions) {
        execution.status = 'succeeded'; execution.drained = true; execution.recovering = false
        for (const part of execution.timeline?.segments || []) if (part.state === 'running') { part.state = 'closed'; part.endedAt = iso(20) }
      }
    }
    projected.timeline = mode === 'legacy' ? undefined : projectTaskTimeline(projected, projectedExecutions, wakes, projectTaskLifecycle(projected, history))
    body = { ...projected, executions }
  } else if (target.pathname.endsWith('/executions')) body = { executions, total: executions.length, offset: 0, limit: 20 }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
})
const refresh = async () => { await page.clock.runFor(1500); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForTimeout(450) }
try {
  await page.clock.install({ time: new Date(iso(20)) })
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await page.getByText(task.title, { exact: true }).click()
  await page.getByRole('region', { name: '执行时间泳道图', exact: true }).waitFor().catch(() => page.locator('.detail-timeline').waitFor())
  const chart = page.locator('.detail-timeline'), rows = chart.locator('tbody tr')
  const measure = () => chart.evaluate(node => {
    const css = getComputedStyle(node)
    return { chartHeight: node.getBoundingClientRect().height, paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, panelGap: css.gap,
      rowHeights: [...node.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height),
      trackHeight: node.querySelector('.timeline-track').getBoundingClientRect().height,
      barHeight: node.querySelector('.timeline-bar:not(.timeline-total)').getBoundingClientRect().height,
      totalBarHeight: node.querySelector('.timeline-total').getBoundingClientRect().height,
      axisHeight: node.querySelector('.timeline-axis').getBoundingClientRect().height,
      barGap: [...node.querySelectorAll('tbody tr')].slice(1, 4).map(row => row.querySelector('.timeline-bar').getBoundingClientRect().y),
      summaryHeight: node.querySelector('summary').getBoundingClientRect().height }
  })
  const density = { desktop: await measure() }
  const measureContrast = () => chart.locator('.timeline-bar:not(.timeline-total)').evaluateAll(nodes => {
    const luminance = value => {
      const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => value.startsWith('color(srgb') ? v : v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
    }
    return nodes.map(node => {
      const bg = getComputedStyle(node).backgroundColor, css = getComputedStyle(node.firstElementChild), fg = css.color
      const a = luminance(bg), b = luminance(fg)
      return { background: bg, foreground: fg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight }
    })
  })
  const contrast = { light: await measureContrast() }
  assert.ok(contrast.light.every(item => item.ratio >= 4.5), 'all colored activity labels meet 4.5:1 contrast')
  const cdp = await context.newCDPSession(page)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const { root: documentNode } = await cdp.send('DOM.getDocument')
  const { nodeId: fontNode } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.timeline-name' })
  const renderedFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: fontNode })).fonts
  await cdp.detach()
  assert.equal(await rows.count(), 8)
  assert.equal(await rows.first().locator('.timeline-total').count(), 2)
  assert.match(await rows.first().innerText(), /已完成.*重开后处理中/)
  const totals = await rows.first().locator('.timeline-total').evaluateAll(nodes => nodes.map(n => ({ x: n.getBoundingClientRect().x, right: n.getBoundingClientRect().right })))
  assert.ok(totals[0].right < totals[1].x, 'completed to reopen remains blank')
  checks.push('completed-reopened-total-segments-with-real-gap')
  assert.match(await rows.last().innerText(), /人工介入/)
  assert.equal(await rows.nth(1).locator('.timeline-bar').count(), 2)
  assert.equal(await chart.locator('.timeline-milestone').count(), 0)
  for (const target of [rows.nth(4).locator('.timeline-bar'), rows.last().locator('.timeline-bar').last()]) {
    assert.equal(await target.evaluate(node => getComputedStyle(node, '::after').content), 'none', 'running/waiting interval has no decorative endpoint')
  }
  checks.push('no-stage-ticks-or-running-waiting-endpoint-ticks')
  const geometry = await rows.evaluateAll(nodes => nodes.map(row => [...row.querySelectorAll('.timeline-bar')].map(bar => ({ x: bar.getBoundingClientRect().x, width: bar.getBoundingClientRect().width }))))
  assert.ok(geometry[1][0].x + geometry[1][0].width < geometry[1][1].x)
  assert.equal(Math.round(geometry[2][0].x), Math.round(geometry[3][0].x))
  assert.ok(geometry[2][0].width < geometry[3][0].width)
  assert.equal(await rows.nth(6).locator('.timeline-bar').count(), 1, 'unknown interval is never painted')
  assert.match(await rows.nth(5).innerText(), /历史区间未记录/)
  checks.push('reference-structure-total-session-rows-human-bottom', 'same-session-gap', 'parallel-start-different-end', 'historical-and-recovery-missing-evidence')
  const longHeader = rows.nth(5).locator('th')
  await longHeader.focus()
  assert.ok(await longHeader.locator('.timeline-row-info').isVisible())
  assert.ok((await longHeader.locator('.timeline-row-info').innerText()).includes(executions[4].title))
  assert.match(await longHeader.locator('.timeline-row-info').innerText(), /已成功.*部分区间未记录/)
  await longHeader.evaluate(node => node.blur())
  await rows.nth(6).locator('th').hover()
  assert.ok(await rows.nth(6).locator('.timeline-row-info').isVisible())
  await chart.locator('h2').hover()
  checks.push('full-name-status-and-missing-evidence-hover-and-keyboard-focus-tooltip')
  await chart.scrollIntoViewIfNeeded()
  await page.mouse.move(1400, 10)
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  await chart.screenshot({ path: path.join(output, 'desktop-chart.png') })
  await chart.getByText('活动与时间明细', { exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await chart.locator('details').getAttribute('open'), '')
  assert.ok((await chart.locator('details').innerText()).includes(executions[4].title))
  assert.match(await chart.locator('details').innerText(), /已答复|已失效/)
  checks.push('keyboard-details-full-long-name-and-human-statuses')
  await page.keyboard.press('Enter')
  const pending = rows.last().locator('.timeline-bar').last(), widthBefore = (await pending.boundingBox()).width
  await page.clock.runFor(60_000)
  assert.ok((await pending.boundingBox()).width > widthBefore)
  checks.push('pending-human-and-running-execution-extend-now')
  await page.setViewportSize({ width: 390, height: 844 })
  density.narrow = await measure()
  await chart.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const scroller = chart.locator('.timeline-scroll')
  await longHeader.focus()
  const infoBox = await longHeader.locator('.timeline-row-info').boundingBox(), chartBox = await chart.boundingBox()
  assert.ok(infoBox.x >= chartBox.x && infoBox.x + infoBox.width <= chartBox.x + chartBox.width, 'narrow tooltip remains within chart')
  await longHeader.evaluate(node => node.blur())
  assert.ok(await scroller.evaluate(node => node.scrollWidth > node.clientWidth))
  await scroller.focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100)
  assert.ok(await scroller.evaluate(node => node.scrollLeft > 0))
  const pinned = await rows.nth(1).locator('th').boundingBox(), scrollBox = await scroller.boundingBox()
  assert.ok(Math.abs(pinned.x - scrollBox.x) < 1, 'session labels remain pinned while time track scrolls')
  await page.waitForTimeout(250)
  await scroller.evaluate(node => { node.scrollTo({ left: 0, behavior: 'instant' }); node.blur() })
  await chart.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.mouse.move(380, 10)
  assert.equal(await scroller.evaluate(node => node.scrollLeft), 0)
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: false })
  await chart.screenshot({ path: path.join(output, 'narrow-chart.png') })
  checks.push('narrow-no-page-overflow-keyboard-local-horizontal-scroll')
  mode = 'completed'; await refresh()
  assert.match(await rows.first().innerText(), /已完成.*重开后完成/)
  const fixedWidth = await rows.first().locator('.timeline-total').last().evaluate(n => n.style.width)
  await page.clock.runFor(60_000)
  assert.equal(await rows.first().locator('.timeline-total').last().evaluate(n => n.style.width), fixedWidth)
  mode = 'missing-lifecycle'; await refresh()
  assert.equal(await rows.first().locator('.timeline-total').count(), 1)
  assert.match(await rows.first().innerText(), /不完整|未记录/)
  checks.push('terminal-fixed-total-and-missing-history-no-invented-interval')
  mode = 'empty'; await refresh()
  assert.match(await chart.innerText(), /暂无人工介入/)
  mode = 'legacy'; await refresh()
  assert.match(await chart.innerText(), /历史执行过程未记录/)
  mode = 'normal'; detailFailure = true; await refresh()
  await page.getByRole('alert').filter({ hasText: '隔离读取失败' }).waitFor()
  detailFailure = false; delayDetail = true; await refresh()
  assert.equal(await chart.locator('tbody tr').count(), 8)
  checks.push('empty-human-legacy-no-timeline-failure-retry-retains-detail')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addStyleTag({ content: ':root{--dsw-alias-bg-base:#18191b;--dsw-alias-bg-layer-1:#24262c;--dsw-alias-border-l2:rgba(255,255,255,.22);--dsw-alias-label-secondary:#aaaeb8;--dsw-alias-brand-primary:#a4afff}body{background:#18191b;color:#ececf1}' })
  await chart.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.mouse.move(1400, 10)
  await chart.screenshot({ path: path.join(output, 'dark-chart.png') })
  assert.equal(await chart.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(24, 25, 27)')
  contrast.dark = await measureContrast()
  assert.ok(contrast.dark.every(item => item.ratio >= 4.5), 'dark colored activity labels meet 4.5:1 contrast')
  checks.push('pinned-narrow-labels-and-host-dark-theme-aliases')
  await page.emulateMedia({ forcedColors: 'active' })
  await chart.screenshot({ path: path.join(output, 'forced-colors.png') })
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, geometry, density, contrast, renderedFonts, requests: [...new Set(requests)], fixture: 'complete observer module + real React; semantic host shell substitutes; all API calls intercepted, projectTaskTimeline used for synthetic records; no resident or business access' }, null, 2))
  console.log(JSON.stringify({ checks, output }, null, 2))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
