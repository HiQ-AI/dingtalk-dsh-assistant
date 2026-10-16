import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { projectTaskTimeline, projectTaskLifecycle } from '../../../packages/dingtalk-dsh-assistant/task-execution-timeline.js'

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../', import.meta.url))
const { chromium } = require('/opt/codex/cua_node/lib/node_modules/playwright')
const output = path.join(root, 'docs/acceptance/task-execution-list', process.env.TIMELINE_PREVIEW_DIR || 'preview')
await mkdir(output, { recursive: true })
const files = new Map([
  ['/react.js', await readFile(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile('/tmp/task-timeline-browser/node_modules/react-dom/umd/react-dom.development.js')],
  ['/observer.js', await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'))],
])
const nativeRoot = path.join(root, 'packages/dingtalk-dsh-observer/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib')
const nativeModule = await readFile(path.join(nativeRoot, 'index.js'), 'utf8')
const nativeStateCode = nativeModule.slice(nativeModule.indexOf('function syncSpinner('), nativeModule.indexOf('//#endregion', nativeModule.indexOf('function StateDot(')))
const nativeStateCss = await readFile(path.join(nativeRoot, 'StateDot.module.css'), 'utf8')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>执行时间泳道图 · 隔离预览</title><style>:root{--dsw-alias-label-tertiary:#8b8d94}
${nativeStateCss}
body{margin:0;color:#202124;font:14px system-ui,sans-serif}button{font:inherit}#sidebar{padding:8px}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const h=React.createElement;const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
const jsx=(type,props)=>{const {children,...rest}=props;return React.createElement(type,rest,...(Array.isArray(children)?children:[children]))},jsxs=jsx,clsx=(...args)=>args.filter(Boolean).join(' '),css=new Proxy({},{get:(_,name)=>name});
${nativeStateCode}
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot,Menu:({anchor})=>anchor};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='main.conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},uiWorkspace:{openSession(){}},sessions:{subagentAddress(){},async refreshProjections(){},async refreshSubagents(){},async refresh(){},open(){}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); res.end(req.url === '/' ? html : files.get(req.url) || '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`, iso = minute => new Date(Date.parse('2026-10-16T10:00:00Z') + minute * 60000).toISOString()
const segment = (from, to, activity, state = 'closed') => ({ startedAt: iso(from), endedAt: to == null ? null : iso(to), activity, state })
const executions = [
  { title: '查询订单信息', status: 'running', drained: false, timeline: { complete: true, segments: [segment(1, 7, '查询订单信息'), segment(18, 19, '排查差异结果')] } },
  { title: '修改接口校验', status: 'succeeded', timeline: { complete: true, segments: [segment(7, 12, '修改接口校验')] } },
  { title: '修改页面提示', status: 'succeeded', timeline: { complete: true, segments: [segment(7, 16, '修改页面提示')] } },
  { title: '验证修复边界', status: 'running', drained: false, timeline: { complete: true, segments: [segment(18, null, '验证修复边界', 'running')] } },
  { title: '核对历史异常及完整中文名称与证据范围'.repeat(5), status: 'succeeded' },
  { title: '恢复后继续核对', status: 'running', recovering: true, drained: false, timeline: { complete: false, segments: [segment(2, 4, '读取配置'), segment(18, null, '崩溃区间不猜终点', 'unknown')] } },
].slice(0, 1).map((item, index) => ({ ...item, id: `e${index}`, executionId: `e${index}`, sessionId: `s${index}`, taskId: 'fixture', createdAt: iso(0), updatedAt: iso(20), drained: item.drained ?? true, prompt: item.title }))
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
let executionsFailure = false, executionsDelay = false
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
  } else if (target.pathname.endsWith('/executions')) {
    if (executionsDelay) await new Promise(resolve => setTimeout(resolve, 500))
    if (executionsFailure) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '列表隔离失败' }) })
    body = { executions, total: executions.length, offset: 0, limit: 20 }
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
})
const refresh = async () => { await page.clock.runFor(1500); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForTimeout(450) }
try {
  await page.clock.install({ time: new Date(iso(20)) })
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  const cardSpinner = page.locator('.observer-execution-session [data-state=ongoing]')
  await cardSpinner.waitFor()
  await page.emulateMedia({ reducedMotion:'no-preference' })
  const cardStyle = await cardSpinner.evaluate(n => ({ color:getComputedStyle(n).color, stroke:getComputedStyle(n.querySelector('circle')).stroke, width:n.getBoundingClientRect().width, height:n.getBoundingClientRect().height, animation:getComputedStyle(n.querySelector('g')).animationName }))
  await page.screenshot({ path:path.join(output,'unified-card.png') })
  await page.getByText(task.title, { exact: true }).click()
  const list = page.getByRole('region', { name: '动态执行列表', exact: true })
  // A section with an accessible name is a region.
  await list.getByRole('heading', { name: '执行会话', exact: true }).waitFor()
  const meta = list.locator('.detail-execution-meta')
  await page.waitForFunction(() => document.querySelector('.detail-execution-meta')?.innerText.includes('更新 '))
  assert.match(await meta.innerText(), /更新 .*2026.*1 条执行记录 · 1–1/s)
  assert.doesNotMatch(await list.innerText(), /执行记录已更新|由任务会话按需安排|Invalid Date/)
  const runningTag = list.locator('.detail-execution-summary > span').filter({ hasText:'执行中' })
  assert.equal(await runningTag.count(), 1)
  assert.match(await runningTag.innerText(), /执行中/)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const palette = await runningTag.evaluate(n => {
    const fg = getComputedStyle(n).color, bg = getComputedStyle(n).backgroundColor, ring = n.querySelector('[data-state=ongoing]')
    return { foreground:fg, background:bg, ringColor:getComputedStyle(ring).color, stroke:getComputedStyle(ring.querySelector('circle')).stroke, animation:getComputedStyle(ring.querySelector('g')).animationName, width:n.getBoundingClientRect().width, height:n.getBoundingClientRect().height }
  })
  const topSpinner = page.locator('.detail-title-row [data-state=ongoing]')
  const topStyle = await topSpinner.evaluate(n => ({ color:getComputedStyle(n).color, stroke:getComputedStyle(n.querySelector('circle')).stroke, animation:getComputedStyle(n.querySelector('g')).animationName }))
  assert.equal(topStyle.animation,'dsh-state-dot-spin')
  assert.equal(cardStyle.animation,'dsh-state-dot-spin')
  assert.equal(topStyle.color,'rgb(139, 141, 148)')
  assert.equal(topStyle.stroke,topStyle.color)
  assert.equal(cardStyle.color,topStyle.color)
  assert.equal(cardStyle.stroke,topStyle.color)
  assert.equal(cardStyle.width,14); assert.equal(cardStyle.height,14)
  assert.equal(palette.ringColor,topStyle.color)
  assert.equal(palette.stroke,topStyle.color)
  assert.equal(palette.animation, 'dsh-state-dot-spin')
  const channel = color => color.match(/[\d.]+/g).map(Number)
  const fg = channel(palette.foreground), rawBg = channel(palette.background)
  const bg = rawBg.slice(0,3).map(c => c * (rawBg[3] ?? 1) + 1 - (rawBg[3] ?? 1))
  const lum = rgb => rgb.slice(0,3).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum,c,i) => sum + c * [.2126,.7152,.0722][i],0)
  palette.contrast = (lum(bg) + .05) / (lum(fg) + .05)
  assert.equal(palette.foreground,'rgb(77, 107, 254)', 'restore original PR196 brand tone, do not force gray')
  assert.equal(await page.locator('.observer-task-running, .detail-execution-running-tag').count(),0)
  const initial = await meta.innerText()
  await list.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.mouse.move(1400, 10)
  await list.screenshot({ path: path.join(output, 'desktop.png') })
  const desktopMeta = await meta.evaluate(n => [...n.children].map(c => ({ x:c.getBoundingClientRect().x, y:c.getBoundingClientRect().y })))
  assert.equal(desktopMeta[0].y, desktopMeta[1].y, 'timestamp and count share desktop line')
  executionsFailure = true; await refresh()
  await list.getByRole('alert').waitFor()
  assert.equal(await meta.innerText(), initial, 'failed refresh preserves previous success timestamp')
  executionsFailure = false; executionsDelay = true
  await list.getByRole('button', { name: '重试读取执行' }).click()
  const busy = await list.locator('.detail-section-heading').boundingBox()
  await page.waitForTimeout(650)
  const ready = await list.locator('.detail-section-heading').boundingBox()
  assert.equal(busy.height, ready.height, 'loading status reserves stable heading height')
  await page.setViewportSize({ width:390, height:844 })
  await list.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.clock.runFor(100)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.mouse.move(380, 10)
  await list.screenshot({ path: path.join(output, 'narrow.png') })
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ palette, cardStyle, topStyle, desktopMeta, loadingHeadingHeight:busy.height, readyHeadingHeight:ready.height, errors, fixture:'isolated synthetic task and intercepted read-only APIs; real React and complete Observer module' }, null, 2))
  console.log('execution session list: desktop metadata line, missing/failed refresh handling, loading stability and narrow viewport passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
