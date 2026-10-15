import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = require(process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright')
const output = path.join(root, 'docs/acceptance/task-session-duration/preview')
await mkdir(output, { recursive: true })
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const primitiveRoot = path.join(root, 'packages/dingtalk-dsh-observer/node_modules/@deepseek-ai/dsh-client-ui-primitives')
const primitiveBundle = await readFile(path.join(primitiveRoot, 'lib/index.js'), 'utf8')
const primitiveVersion = JSON.parse(await readFile(path.join(primitiveRoot, 'package.json'), 'utf8')).version
assert.match(primitiveBundle.slice(primitiveBundle.lastIndexOf('export {')), /\bStateDot\b/)
const nativeStart = primitiveBundle.indexOf('function syncSpinner(')
const nativeStateDot = primitiveBundle.slice(nativeStart, primitiveBundle.indexOf('//#endregion', primitiveBundle.indexOf('function StateDot(', nativeStart)))
const nativeCss = await readFile(path.join(primitiveRoot, 'lib/StateDot.module.css'), 'utf8')
const nativeCssMap = Object.fromEntries([...nativeCss.matchAll(/\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => [match[1], match[1]]))
const nativeEvidence = { package: '@deepseek-ai/dsh-client-ui-primitives', version: primitiveVersion, implementationSha256: createHash('sha256').update(nativeStateDot).digest('hex'), cssSha256: createHash('sha256').update(nativeCss).digest('hex'), method: 'unchanged StateDot + syncSpinner/pinSpinner implementation extracted from installed export; native stylesheet; JSX runtime and clsx adapters only' }
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(process.env.DSH_BROWSER_DEPS || '/tmp/duration-browser/node_modules', 'react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 真实 React 与完整 observer 代码；DSH 外壳/primitive 仅用无副作用语义替身。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流程状态验收夹具</title><style>body{margin:0;color:#202124;font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:8px}button{font:inherit}#app{height:calc(100dvh - 48px)}${nativeCss}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const jsx=(type,{children,...props},key)=>h(type,{...props,...(key===undefined?{}:{key})},...(Array.isArray(children)?children:[children]));const jsxs=jsx;const clsx=(...values)=>values.filter(Boolean).join(' ');const css=${JSON.stringify(nativeCssMap)};
${nativeStateDot}
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot,Menu:({anchor})=>anchor};
primitives.IconChecklistOutline14=({size=14,...props})=>h('svg',{...props,width:size,height:size,viewBox:'0 0 14 14',fill:'none'},
  h('path',{d:'M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z',fill:'currentColor'}),
  h('path',{d:'M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z',fill:'currentColor'}));
for(const name of ['IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,viewBox:'0 0 14 14',fill:'none'},h('path',{d:name==='IconChevronUpOutline14'?'M3 9L7 5L11 9':'M3 5L7 9L11 5',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='main.conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},uiWorkspace:{openSession(id){window.opened.push(id)}},sessions:{subagentAddress(){return undefined},async refreshProjections(){},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`

const browser = await playwright.chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], checks = []
const start = Date.parse('2026-10-15T10:00:00Z')
const sessions = [
  { title: '核对服务运行状态并整理完整中文证据与边界说明'.repeat(3), status: 'running', runTiming: { recorded: true, elapsedMs: 62_000, startedAt: new Date(start).toISOString() } },
  { title: '核对配置差异', status: 'succeeded', runTiming: { recorded: true, elapsedMs: 83_000, startedAt: null } },
  { title: '等待可用执行槽位', status: 'queued', runTiming: { recorded: true, elapsedMs: 0, startedAt: null } },
  { title: '历史执行没有计时字段', status: 'succeeded' },
  { title: '恢复后无法确定崩溃区间终点', status: 'running', recovering: true, runTiming: { recorded: false, elapsedMs: 9_000, startedAt: null } },
  { title: '长时间执行失败后已停止', status: 'failed', runTiming: { recorded: true, elapsedMs: 442_820_000, startedAt: null } },
].map((item, i) => ({ ...item, executionId: `execution-${i}`, sessionId: `session-${i}` }))
const tasks = [{ taskId: 'fixture', title: '执行会话时长预览', objective: '仅合成数据，验证累计运行时长、终态固定、缺字段与长中文名称。', state: 'running', status: 'active', updatedAt: new Date(start).toISOString(), executionCount: sessions.length, executionSessions: sessions }]
let failRead = false, empty = false
page.on('pageerror', e => errors.push(e.message))
await context.route('**/*', route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  assert.equal(route.request().method(), 'GET', 'fixture permits no business mutations')
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (target.pathname === '/state/tasks' && failRead) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成读取失败' }) })
  const body = target.pathname === '/state/tasks' ? (empty ? [] : tasks) : target.pathname === '/state/overview' ? {} : []
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
})
const durations = () => page.locator('.observer-execution-duration')
const refresh = async () => { await page.clock.runFor(1300); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForTimeout(120) }
try {
  await page.clock.install({ time: new Date(start) })
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await durations().first().waitFor()
  assert.equal(await durations().count(), 6)
  const before = await durations().allTextContents()
  assert.deepEqual(before, ['1分2秒', '1分23秒', '0秒', '—', '—', '123小时0分'])
  await page.clock.runFor(2100)
  const after = await durations().allTextContents()
  assert.equal(after[0], '1分4秒'); assert.deepEqual(after.slice(1), before.slice(1))
  checks.push('running-ticks-each-second', 'terminal-queued-and-unknown-remain-fixed', 'existing-duration-formatter')
  const loader = page.locator('.observer-execution-session [data-state=ongoing]')
  assert.equal(await loader.count(), 1, 'only physically active running session gets host loader')
  assert.equal(await loader.getAttribute('width'), '14'); assert.equal(await loader.getAttribute('height'), '14')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.deepEqual(await loader.evaluate(node => node.getAnimations({ subtree: true }).map(a => a.animationName).sort()), ['dsh-state-dot-dash', 'dsh-state-dot-spin'])
  const beforeMotion = await loader.locator('g').evaluate(node => getComputedStyle(node).transform)
  await page.waitForTimeout(180)
  const afterMotion = await loader.locator('g').evaluate(node => getComputedStyle(node).transform)
  assert.notEqual(beforeMotion, afterMotion, 'native CSS animation really advances')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await loader.evaluate(node => node.getAnimations({ subtree: true }).length), 0)
  checks.push('native-export-registration-and-14px-loader', 'actual-native-css-animation-and-reduced-motion')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  const rows = page.locator('.observer-execution-session')
  assert.deepEqual(await rows.locator(':scope > [role="img"]').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), tooltip: node.getAttribute('title') || node.querySelector('title')?.textContent }))), ['执行中', '已完成', '待处理', '已完成', '执行中', '失败'].map(label => ({ label, tooltip: label })))
  for (let index = 0; index < 6; index++) {
    const row = rows.nth(index)
    assert.equal(await row.locator(':scope > span:not([role=img])').count(), 2, 'only full name and duration remain')
    assert.equal(await row.locator(':scope > span:not([role=img])').first().textContent(), sessions[index].title)
    assert.equal(await row.locator(':scope > span:not([role=img])').first().getAttribute('title'), sessions[index].title)
    assert.equal(await row.locator(':scope > span').last().textContent(), after[index])
    assert.equal((await durations().nth(index).textContent()).includes('时长'), false)
  }
  for (const index of [3, 4]) {
    assert.equal(await durations().nth(index).textContent(), '—')
    assert.match(await durations().nth(index).getAttribute('title'), /时长未记录.*缺少完整/)
    assert.equal(await durations().nth(index).getAttribute('aria-label'), await durations().nth(index).getAttribute('title'))
  }
  checks.push('no-visible-status-or-duration-prefix', 'status-icon-accessible-label-and-tooltip', 'unknown-em-dash-with-explanation')
  // Real DOM single-line geometry, ellipsis and bounded layout at desktop/390/320px.
  const geometry = []
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 })
    const values = await page.locator('.observer-execution-session').evaluateAll(nodes => nodes.map(node => {
      const [icon, title, meta] = node.children, [duration] = meta.children
      const b = node.getBoundingClientRect(), d = duration.getBoundingClientRect(), t = title.getBoundingClientRect(), i = icon.getBoundingClientRect(), style = getComputedStyle(title)
      return { width: b.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, rightAligned: Math.abs(b.right-d.right)<1, sameLine: Math.abs(t.top-d.top)<1 && Math.abs(t.top-i.top)<2, singleLine: title.clientHeight <= parseFloat(style.lineHeight)+1, ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.overflow === 'hidden', fullTooltip: title.title === title.textContent, noOverlap: i.right <= t.left && t.right <= d.left, text: duration.textContent }
    }))
    assert.ok(values.every(v => v.rightAligned && v.sameLine && v.singleLine && v.ellipsis && v.fullTooltip && v.noOverlap && v.scrollWidth <= v.clientWidth))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    geometry.push({ width, values })
    await page.locator('article').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, width === 1440 ? 'desktop.png' : `narrow-${width}.png`), fullPage: true })
  }
  checks.push('390-and-320-no-horizontal-overflow', 'long-chinese-ellipsis-and-full-tooltip', 'icon-name-duration-single-line-no-overlap')
  // Change active timing to terminal while preserving row geometry and fixed duration.
  const runningRect = await rows.first().boundingBox()
  sessions[0].status = 'succeeded'; sessions[0].runTiming = { recorded: true, elapsedMs: 64_000, startedAt: null }
  await refresh()
  await page.clock.runFor(3100)
  assert.equal(await durations().first().textContent(), '1分4秒')
  assert.equal(await loader.count(), 0)
  const terminalRect = await rows.first().boundingBox()
  assert.equal(terminalRect.height, runningRect.height); assert.equal(terminalRect.width, runningRect.width)
  checks.push('running-to-terminal-clears-timer', 'native-loader-unmounts-and-state-switch-keeps-geometry')
  failRead = true; await refresh()
  await page.getByText('合成读取失败', { exact: false }).first().waitFor()
  checks.push('read-failure-visible')
  failRead = false; empty = true; await refresh()
  assert.equal(await durations().count(), 0)
  checks.push('empty-list-unmounts-timers')
  empty = false; await refresh()
  const button = page.locator('.observer-execution-session').first()
  if (!await button.isVisible()) await page.locator('article summary').click()
  await button.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(100)
  assert.deepEqual(await page.evaluate(() => window.opened), ['session-0'])
  checks.push('keyboard-session-navigation')
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, geometry, nativeEvidence, baseCommit: '8c2cc772', fixture: 'real React + complete observer module; native installed StateDot implementation/CSS; semantic other host primitives; synthetic read-only API, all external requests intercepted; no business data or resident service used' }, null, 2))
  console.log(JSON.stringify({ checks, errors, output }, null, 2))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
