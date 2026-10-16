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
const wakes = [{ id: 'stage', taskId: 'fixture', kind: 'execution.stage.progress', payload: { executionId: 'e0', recordedAt: iso(4), summary: '区段中间已查询到差异证据' } }]
wakes.push({ ...structuredClone(wakes[0]), id: 'stage-same', payload: { ...wakes[0].payload, summary: '同一时刻记录的补充证据' } },
  { ...structuredClone(wakes[0]), id: 'stage-near', payload: { ...wakes[0].payload, recordedAt: iso(4.05), summary: '已复核差异证据' } },
  { ...structuredClone(wakes[0]), id: 'stage-later', payload: { ...wakes[0].payload, recordedAt: iso(19), summary: '重开后确认修复结果' } })
for (const [index, minute] of [4.1, 4.15, 4.2].entries()) wakes.push({ ...structuredClone(wakes[0]), id: `stage-dense-${index}`, payload: { ...wakes[0].payload, recordedAt: iso(minute), summary: `密集成果证据 ${index + 1}` } })
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
    if (mode === 'completed' || mode === 'long-gap-completed') {
      projected.status = 'completed'; projected.completion = { at: iso(20) }
      projected.humanRequests.at(-1).status = 'answered'; projected.humanRequests.at(-1).answeredAt = iso(20)
      for (const execution of projectedExecutions) {
        execution.status = 'succeeded'; execution.drained = true; execution.recovering = false
        for (const part of execution.timeline?.segments || []) if (part.state === 'running') { part.state = 'closed'; part.endedAt = iso(20) }
      }
    }
    projected.timeline = mode === 'legacy' ? undefined : projectTaskTimeline(projected, projectedExecutions, wakes, projectTaskLifecycle(projected, history))
    if (mode.startsWith('long-gap')) {
      const shift = value => {
        if (typeof value === 'string' && /^2026-10-16T/.test(value) && Number.isFinite(Date.parse(value))) return Date.parse(value) >= Date.parse(iso(18)) ? new Date(Date.parse(value) + 120 * 60000).toISOString() : value
        if (Array.isArray(value)) return value.map(shift)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)]))
        return value
      }
      projected.timeline = shift(projected.timeline)
      if (mode === 'long-gap-occupied') projected.timeline.executions[0].milestones.push({ id: 'gap-proof', at: iso(60), summary: '空档内仍有真实成果，不折叠' })
    }
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
  assert.equal(await chart.locator('.timeline-milestone').count(), 6)
  const points = chart.locator('.timeline-milestone')
  for (const target of [points.first(), rows.nth(1).locator('.timeline-bar').first()]) {
    assert.equal(await target.evaluate(n => { for (let p = n; p; p = p.parentElement) if (p.getAttribute('title')) return p.getAttribute('title'); return null }), null, 'no native title on trigger or ancestors')
  }
  await chart.scrollIntoViewIfNeeded()
  await points.nth(4).hover()
  await page.waitForTimeout(1800)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1)
  assert.match(await page.locator('.timeline-tooltip:visible').innerText(), /密集成果证据/)
  await chart.screenshot({ path: path.join(output, 'single-tooltip-hover.png') })
  await points.first().focus()
  await points.last().hover()
  await page.waitForTimeout(1800)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1, 'hover another point hides previous focused tooltip')
  await points.first().evaluate(n => n.blur())
  await page.mouse.move(1400, 10)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 0)
  await points.first().focus()
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1)
  assert.match(await points.first().getAttribute('aria-label'), /同一时刻记录的补充证据/)
  await chart.screenshot({ path: path.join(output, 'single-tooltip-focus.png') })
  await points.first().evaluate(n => n.blur())
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 0)
  checks.push('one-tooltip-after-long-hover-focus-blur-and-switch-between-dense-points')

  assert.equal(await chart.locator('.timeline-milestone-count, .timeline-milestone-dot').count(), 0)
  const verifyPointCoordinates = async () => {
    const coords = await points.evaluateAll(nodes => nodes.map(n => {
      const track = n.closest('.timeline-track').getBoundingClientRect(), dot = n.querySelector('.timeline-milestone-tick').getBoundingClientRect()
      return { at: n.dataset.recordedAt, ratio: (dot.x + dot.width / 2 - track.x) / track.width, y: dot.y }
    }))
    // The initial fixture spans precisely 10:00–10:20; current time advances later.
    for (const [i, minute] of [4, 4.05, 4.1, 4.15, 4.2, 19].entries()) {
      const currentMinutes = (await page.evaluate(() => Date.now()) - Date.parse(iso(0))) / 60000
      assert.ok(Math.abs(coords[i].ratio - minute / currentMinutes) < .001, 'tick center matches actual recordedAt on unified axis')
    }
    assert.ok(coords.every(point => point.y === coords[0].y), 'all stage ticks stay on the same horizontal line without avoidance')
    return coords
  }
  const pointCoordinates = { desktop: await verifyPointCoordinates() }
  const tickExtent = await points.first().evaluate(n => {
    const line = n.firstElementChild.getBoundingClientRect(), band = n.closest('.timeline-track').querySelector('.timeline-bar').getBoundingClientRect()
    return { above: band.top - line.top, below: line.bottom - band.bottom, height: line.height, overflow: getComputedStyle(n).overflow }
  })
  assert.equal(tickExtent.above, 3)
  assert.equal(tickExtent.below, 3)
  assert.equal(tickExtent.height, 28)
  assert.equal(tickExtent.overflow, 'visible')
  checks.push('stage-lines-span-band-plus-three-pixels-no-clipping')
  await points.first().focus()
  assert.match(await points.first().evaluate(n => document.querySelector('.timeline-tooltip').innerText), /区段中间已查询到差异证据[\s\S]*同一时刻记录的补充证据[\s\S]*已复核差异证据/)
  assert.ok(await points.first().evaluate(n => getComputedStyle(document.querySelector('.timeline-tooltip')).display !== 'none'))
  await points.first().evaluate(n => n.blur())
  assert.equal(await rows.first().locator('.timeline-duration').first().innerText(), '16分0秒')
  assert.equal(await rows.nth(1).locator('.timeline-duration').first().innerText(), '6分0秒')
  const shortPart = rows.nth(1).locator('.timeline-bar').last()
  assert.equal(await shortPart.locator('.timeline-activity').evaluate(n => getComputedStyle(n).display), 'none')
  await shortPart.focus()
  assert.match(await shortPart.getAttribute('aria-label'), /排查差异结果.*1分0秒/)
  await shortPart.evaluate(n => n.blur())
  checks.push('segment-duration-and-exact-distinct-stage-time-coordinates')
  for (const target of [rows.nth(4).locator('.timeline-bar'), rows.last().locator('.timeline-bar').last()]) {
    assert.equal(await target.evaluate(node => getComputedStyle(node, '::after').content), 'none', 'running/waiting interval has no decorative endpoint')
  }
  checks.push('no-running-waiting-endpoint-ticks')
  const geometry = await rows.evaluateAll(nodes => nodes.map(row => [...row.querySelectorAll('.timeline-bar')].map(bar => ({ x: bar.getBoundingClientRect().x, width: bar.getBoundingClientRect().width }))))
  assert.ok(geometry[1][0].x + geometry[1][0].width < geometry[1][1].x)
  assert.equal(Math.round(geometry[2][0].x), Math.round(geometry[3][0].x))
  assert.ok(geometry[2][0].width < geometry[3][0].width)
  assert.equal(await rows.nth(6).locator('.timeline-bar').count(), 1, 'unknown interval is never painted')
  assert.match(await rows.nth(5).innerText(), /历史区间未记录/)
  checks.push('reference-structure-total-session-rows-human-bottom', 'same-session-gap', 'parallel-start-different-end', 'historical-and-recovery-missing-evidence')
  const longHeader = rows.nth(5).locator('th')
  await longHeader.focus()
  assert.ok(await page.locator('.timeline-tooltip').isVisible())
  assert.ok((await page.locator('.timeline-tooltip').innerText()).includes(executions[4].title))
  assert.match(await page.locator('.timeline-tooltip').innerText(), /已成功.*部分区间未记录/)
  await longHeader.evaluate(node => node.blur())
  await rows.nth(6).locator('th').hover()
  assert.ok(await page.locator('.timeline-tooltip').isVisible())
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
  const pending = rows.last().locator('.timeline-bar').last(), durationBefore = await rows.last().locator('.timeline-duration').last().innerText(), widthBefore = (await pending.boundingBox()).width
  await page.clock.runFor(60_000)
  assert.ok((await pending.boundingBox()).width > widthBefore)
  assert.notEqual(await rows.last().locator('.timeline-duration').last().innerText(), durationBefore)
  assert.equal(await rows.first().locator('.timeline-duration').first().innerText(), '16分0秒')
  checks.push('pending-human-and-running-execution-extend-now')
  await page.setViewportSize({ width: 390, height: 844 })
  density.narrow = await measure()
  pointCoordinates.narrow = await verifyPointCoordinates()
  await chart.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const scroller = chart.locator('.timeline-scroll')
  await longHeader.focus()
  const infoBox = await page.locator('.timeline-tooltip').boundingBox(), chartBox = await chart.boundingBox()
  assert.ok(infoBox.x >= 0 && infoBox.x + infoBox.width <= 390, 'narrow tooltip stays inside viewport')
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
  await scroller.evaluate(node => node.scrollTo({ left: 100, behavior: 'instant' }))
  await rows.nth(1).locator('.timeline-milestone').first().focus()
  const stageTooltip = await rows.nth(1).locator('.timeline-milestone').first().evaluate(n => { const b = document.querySelector('.timeline-tooltip').getBoundingClientRect(); return { x: b.x, right: b.right } })
  assert.ok(stageTooltip.x >= 0 && stageTooltip.right <= 390, 'focused stage tooltip stays inside narrow viewport after horizontal scroll')
  await rows.nth(1).locator('.timeline-milestone').first().evaluate(n => n.blur())
  await page.mouse.move(380, 10)
  await scroller.evaluate(node => node.scrollTo({ left: 100, behavior: 'instant' }))
  await page.clock.runFor(100)
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: false })
  await chart.screenshot({ path: path.join(output, 'narrow-chart.png') })
  checks.push('narrow-no-page-overflow-keyboard-local-horizontal-scroll')
  mode = 'long-gap'
  await page.clock.setSystemTime(new Date(iso(141)))
  await page.setViewportSize({ width: 1440, height: 1100 })
  await refresh()
  const navigator = chart.locator('.timeline-navigator')
  const selectedRange = () => navigator.evaluate(n => ({ start: +n.dataset.start, end: +n.dataset.end, fullStart: +n.dataset.fullStart, fullEnd: +n.dataset.fullEnd }))
  let selected = await selectedRange()
  assert.equal(Math.round(selected.end - selected.start), 3600000, 'default latest hour')
  assert.ok(Math.abs(selected.end - selected.fullEnd) < 1)
  assert.equal(await chart.locator('.timeline-axis-break, .timeline-fold-note').count(), 0)
  assert.equal(await rows.nth(1).locator('.timeline-bar').count(), 1, 'old blocks outside selection are omitted')
  assert.equal(await rows.nth(1).locator('.timeline-duration').innerText(), '1分0秒')
  const dragControl = async (name, dx) => {
    const control = chart.getByRole('slider', { name, exact: true })
    await control.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await page.clock.runFor(100)
    const box = await control.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
  }
  await dragControl('平移时间范围', -300)
  selected = await selectedRange()
  assert.ok(selected.start < selected.fullEnd - 3600000)
  const manual = { ...selected }
  await refresh()
  assert.equal((await selectedRange()).start, manual.start, 'refresh retains manual history')
  await page.clock.runFor(60000)
  assert.equal((await selectedRange()).end, manual.end, 'clock does not pull historical selection to latest')
  const oldSpan = manual.end - manual.start
  await dragControl('调整开始时间', 40)
  assert.ok((await selectedRange()).end - (await selectedRange()).start < oldSpan)
  const afterLeft = await selectedRange()
  await dragControl('调整结束时间', -30)
  assert.ok((await selectedRange()).end < afterLeft.end)
  await chart.getByRole('slider', { name: '平移时间范围', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.equal((await selectedRange()).start, (await selectedRange()).fullStart)
  await chart.getByRole('slider', { name: '调整结束时间', exact: true }).focus()
  await page.keyboard.press('End')
  selected = await selectedRange()
  assert.equal(selected.end, selected.fullEnd)
  assert.equal(selected.start, selected.fullStart)
  assert.equal(await rows.nth(1).locator('.timeline-bar').count(), 2)
  await chart.getByRole('slider', { name: '调整开始时间', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  assert.equal(await rows.nth(1).locator('.timeline-bar').first().evaluate(n => n.style.left), '0%')
  assert.equal(await rows.nth(1).locator('.timeline-duration').first().innerText(), '6分0秒', 'clipped block retains full actual duration')
  await page.keyboard.press('End')
  selected = await selectedRange()
  assert.equal(selected.end - selected.start, 1000, 'handles cannot cross and retain minimum width')
  await chart.getByRole('button', { name: '回到最新', exact: true }).click()
  selected = await selectedRange()
  assert.equal(selected.end - selected.start, 3600000)
  assert.equal(selected.end, selected.fullEnd)
  await chart.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.mouse.move(1400, 10)
  await page.clock.runFor(100)
  await chart.screenshot({ path: path.join(output, 'range-navigator-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await chart.locator('.timeline-scroll').evaluate(n => { n.scrollLeft = n.scrollWidth - n.clientWidth })
  await chart.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.mouse.move(380, 10)
  await page.clock.runFor(100)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: path.join(output, 'range-navigator-narrow.png') })
  await dragControl('平移时间范围', -30)
  assert.ok((await selectedRange()).end < (await selectedRange()).fullEnd)
  await chart.getByRole('button', { name: '回到最新', exact: true }).click()
  checks.push('linear-navigator-default-last-hour-pan-resize-clamp-keyboard-preserved-history-refresh-and-narrow-drag')
  mode = 'long-gap-completed'; await refresh()
  selected = await selectedRange()
  assert.equal(selected.end, Date.parse(iso(140)), 'completed task ends at true final timestamp')
  await page.clock.runFor(60000)
  assert.equal((await selectedRange()).end, Date.parse(iso(140)))
  mode = 'normal'
  await page.clock.setSystemTime(new Date(iso(21)))
  await refresh()
  mode = 'completed'; await refresh()
  assert.match(await rows.first().innerText(), /已完成.*重开后完成/)
  const fixedDuration = await rows.first().locator('.timeline-duration').last().innerText()
  assert.equal(fixedDuration, '2分0秒')
  const fixedWidth = await rows.first().locator('.timeline-total').last().evaluate(n => n.style.width)
  await page.clock.runFor(60_000)
  assert.equal(await rows.first().locator('.timeline-total').last().evaluate(n => n.style.width), fixedWidth)
  assert.equal(await rows.first().locator('.timeline-duration').last().innerText(), fixedDuration)
  mode = 'missing-lifecycle'; await refresh()
  assert.equal(await rows.first().locator('.timeline-total').count(), 1)
  assert.match(await rows.first().innerText(), /不完整|未记录/)
  checks.push('terminal-fixed-total-and-missing-history-no-invented-interval')
  mode = 'empty'; await refresh()
  assert.match(await chart.innerText(), /暂无人工介入/)
  const layoutMetrics = () => chart.evaluate(node => {
    const scroll = node.querySelector('.timeline-scroll'), below = node.nextElementSibling
    return { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, pageHeight: document.documentElement.scrollHeight, pageWidth: document.documentElement.scrollWidth, belowY: below?.getBoundingClientRect().top }
  })
  const emptyHumanHeader = chart.locator('tbody tr').last().locator('th')
  await chart.scrollIntoViewIfNeeded()
  await chart.locator('.timeline-scroll').evaluate(n => { n.scrollLeft = 0 })
  await page.clock.runFor(100)
  const beforeEmptyHuman = await layoutMetrics()
  await emptyHumanHeader.hover()
  await page.waitForTimeout(1800)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1)
  assert.match(await page.locator('.timeline-tooltip:visible').innerText(), /人工介入/)
  const overlayMeasurements = { emptyHumanBefore: beforeEmptyHuman, emptyHumanAfter: await layoutMetrics() }
  assert.deepEqual(overlayMeasurements.emptyHumanAfter, beforeEmptyHuman, 'empty human label hover never adds scroll overflow or moves following content')
  assert.equal(await page.locator('.timeline-tooltip').evaluate(n => n.parentElement === document.body && n.matches(':popover-open')), true)
  await page.screenshot({ path: path.join(output, 'empty-human-overlay.png'), fullPage: false })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 0)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await chart.scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  overlayMeasurements.desktopBefore = await layoutMetrics()
  await emptyHumanHeader.hover()
  await page.waitForTimeout(500)
  overlayMeasurements.desktopAfter = await layoutMetrics()
  assert.deepEqual(overlayMeasurements.desktopAfter, overlayMeasurements.desktopBefore)
  await page.screenshot({ path: path.join(output, 'empty-human-desktop-overlay.png'), fullPage: false })
  await page.mouse.move(1400, 10)
  await emptyHumanHeader.focus()
  await page.setViewportSize({ width: 390, height: 500 })
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 0, 'resize closes overlay')
  await emptyHumanHeader.focus()
  await emptyHumanHeader.evaluate(n => n.blur())
  await emptyHumanHeader.evaluate(n => n.scrollIntoView({ block: 'end', behavior: 'instant' }))
  await page.waitForTimeout(100)
  await emptyHumanHeader.focus()
  const headerBounds = await emptyHumanHeader.boundingBox()
  const overlayBounds = await page.locator('.timeline-tooltip').boundingBox()
  assert.ok(overlayBounds.x >= 0 && overlayBounds.x + overlayBounds.width <= 390 && overlayBounds.y >= 0 && overlayBounds.y + overlayBounds.height <= 500)
  assert.ok(overlayBounds.y + overlayBounds.height <= headerBounds.y, 'near viewport bottom tooltip flips above trigger')
  await page.screenshot({ path: path.join(output, 'empty-human-bottom-flip.png') })
  await emptyHumanHeader.evaluate(n => n.blur())
  await longHeader.focus()
  const longOverlay = await page.locator('.timeline-tooltip').boundingBox()
  assert.ok(longOverlay.x >= 0 && longOverlay.y >= 0 && longOverlay.x + longOverlay.width <= 390 && longOverlay.y + longOverlay.height <= 500)
  await longHeader.evaluate(n => n.blur())
  await emptyHumanHeader.focus()
  await chart.locator('.timeline-scroll').evaluate(n => { n.scrollLeft += 15 })
  await page.clock.runFor(100)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1, 'scroll repositions focused overlay')
  await emptyHumanHeader.evaluate(n => n.blur())
  checks.push('empty-human-label-body-top-layer-no-layout-overflow-escape-scroll-resize-edge-bounds')

  mode = 'legacy'; await refresh()
  assert.match(await chart.innerText(), /历史执行过程未记录/)
  mode = 'normal'; detailFailure = true; await refresh()
  await page.getByRole('alert').filter({ hasText: '隔离读取失败' }).waitFor()
  detailFailure = false; delayDetail = true; await refresh()
  assert.equal(await chart.locator('tbody tr').count(), 8)
  checks.push('empty-human-legacy-no-timeline-failure-retry-retains-detail')
  await scroller.evaluate(node => node.scrollTo({ left: 0, behavior: 'instant' }))
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
  await rows.nth(1).locator('th').focus()
  assert.equal(await page.locator('.timeline-tooltip:visible').count(), 1)
  await page.getByRole('button', { name: '返回看板', exact: true }).click()
  assert.equal(await page.locator('.timeline-tooltip').count(), 0, 'unmount removes body overlay')
  checks.push('leaving-task-removes-top-layer-tooltip')
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, overlayMeasurements, geometry, pointCoordinates, density, contrast, renderedFonts, requests: [...new Set(requests)], fixture: 'complete observer module + real React; semantic host shell substitutes; all API calls intercepted, projectTaskTimeline used for synthetic records; no resident or business access' }, null, 2))
  console.log(JSON.stringify({ checks, output }, null, 2))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
