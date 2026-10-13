// 独立 headless Chrome 加载真实 React/发布 bundle；所有 Resident API 使用内存 fixture。
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, reactDomPath, outputDir, mode] = process.argv.slice(2)
assert.ok(playwrightPath && reactDomPath && outputDir, '参数：playwright/index.mjs react-dom/umd/react-dom.development.js 输出目录 [--baseline]')
assert.ok(!mode || mode === '--baseline', '唯一可选模式为 --baseline')
const baseline = mode === '--baseline'
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)))
const root = new URL('../../../../', import.meta.url)
const assets = await Promise.all([
  readFile(new URL('node_modules/react/umd/react.development.js', root), 'utf8'),
  readFile(reactDomPath, 'utf8'),
  readFile(new URL('packages/dingtalk-dsh-assistant/web-client.js', root), 'utf8'),
])
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>钉钉个人助理设置验收</title>
<style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root"></div>
<script>${assets[0]}</script><script>${assets[1]}</script>
<script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:{IconRefreshOutline16:()=>null})}}</script>
<script>${assets[2]}</script><script>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(plugin.DingTalkDshAssistantCard))</script></html>`
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(html)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 950 } })
const requests = [], errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
let config = { workspaceDir: 'D:/fixture', agentNames: ['验收助理'], model: 'fixture-model', reasoningEffort: 'low', proxyUrl: '', maxConcurrentTasks: 5 }
let failHealth = false, failSave = false, writes = 0, releaseInitialHealth
const initialHealth = new Promise(done => { releaseInitialHealth = done })
await page.route('http://127.0.0.1:18998/**', async route => {
  const path = new URL(route.request().url()).pathname
  requests.push({ method: route.request().method(), path })
  if (path === '/health') {
    await initialHealth
    if (failHealth) return route.fulfill({ status: 503, json: { error: '验收模拟：服务暂时不可用' } })
  }
  if (path === '/config/agent') {
    writes++
    if (failSave) return route.fulfill({ status: 409, json: { error: '验收模拟：配置保存失败' } })
    config = { ...config, ...route.request().postDataJSON() }
    return route.fulfill({ json: config })
  }
  const data = {
    '/health': { status: 'ok', transport: 'fixture', inboundProcessing: true, outboundAuthorized: false },
    '/state/groups': [{ groupId: 'fixture-group', name: '验收群', responsibility: '仅供本地浏览器验收' }],
    '/state/tasks': [{ state: 'running' }],
    '/state/supervisor/alerts': [],
    '/state/environment': { dws: { installed: true, authenticated: true, tokenValid: true, user: '验收账号' } },
    '/state/version': { currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
    '/state/agent-config': config,
    '/state/workflows/catalog': { engine: 'workflow-v2', groupIds: ['fixture-group'], messageStages: [{ id: 'intake', label: '接收消息' }], workflows: [{ id: 'fixture', label: '验收流程', purpose: '浏览器夹具', status: 'available', version: 1, nodes: [{ id: 'prepare', executor: 'code' }] }] },
    ...(baseline ? { '/state/task-sheet-sync': { config: null, status: { state: 'idle' } } } : {}),
  }
  return route.fulfill(Object.hasOwn(data, path) ? { json: data[path] } : { status: 404, json: { error: 'Not Found' } })
})
const agentNames = page.getByLabel('Agent 名称和别名', { exact: true })
const waitName = value => page.waitForFunction(expected => document.querySelector('[aria-label="Agent 名称和别名"]')?.value === expected, value)
const assertNoSheetUi = async () => {
  assert.equal(await page.getByText('任务表格同步', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('钉钉任务表格地址', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '立即同步', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '保存同步配置', exact: true }).count(), 0)
}
try {
  await mkdir(outputDir, { recursive: true })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('连接中', { exact: true }).waitFor()
  if (!baseline) await assertNoSheetUi()
  releaseInitialHealth()
  await waitName('验收助理')
  await page.getByText('ok', { exact: true }).waitFor()
  await page.getByRole('region', { name: '任务工作流目录' }).waitFor()
  assert.equal(await page.getByText('验收群', { exact: true }).isVisible(), true)
  assert.equal(await page.getByText('任务表格同步', { exact: true }).count(), baseline ? 1 : 0)
  checks.push('loading-and-initial-overview')
  await page.screenshot({ path: resolve(outputDir, baseline ? 'baseline-desktop.png' : 'after-desktop.png'), fullPage: true })
  if (!baseline) {
    const beforeRefresh = requests.filter(item => item.path === '/health').length
    const refresh = page.getByRole('button', { name: '刷新', exact: true })
    await refresh.focus()
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/state/version'),
      refresh.press('Enter'),
    ])
    assert.equal(requests.filter(item => item.path === '/health').length, beforeRefresh + 1)
    await assertNoSheetUi()
    await refresh.focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '检查更新')
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid')
    checks.push('refresh-and-keyboard-focus')

    await agentNames.fill('已保存助理')
    const save = page.getByRole('button', { name: '保存配置', exact: true })
    await save.focus()
    await save.press('Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '保存配置' && button.disabled))
    assert.deepEqual(config.agentNames, ['已保存助理'])
    assert.equal(writes, 1)
    await page.reload()
    await waitName('已保存助理')
    await assertNoSheetUi()
    checks.push('adjacent-config-save-and-reload')

    await agentNames.fill('失败保留草稿')
    failSave = true
    await save.click()
    await page.getByText('验收模拟：配置保存失败', { exact: true }).waitFor()
    assert.equal(await agentNames.inputValue(), '失败保留草稿')
    assert.deepEqual(config.agentNames, ['已保存助理'])
    failSave = false
    await refresh.click()
    await waitName('已保存助理')
    await page.getByText('验收模拟：配置保存失败', { exact: true }).waitFor({ state: 'detached' })
    await agentNames.fill('重试后保存')
    await save.click()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '保存配置' && button.disabled))
    assert.deepEqual(config.agentNames, ['重试后保存'])
    checks.push('save-failure-draft-refresh-and-retry')

    failHealth = true
    await refresh.click()
    await page.getByText('验收模拟：服务暂时不可用', { exact: true }).waitFor()
    await assertNoSheetUi()
    failHealth = false
    await refresh.click()
    await page.getByText('验收模拟：服务暂时不可用', { exact: true }).waitFor({ state: 'detached' })
    await page.getByText('ok', { exact: true }).waitFor()
    checks.push('overview-failure-refresh-recovery')

    const summary = page.getByRole('region', { name: '任务工作流目录' }).locator('summary').first()
    await summary.focus()
    await summary.press('Enter')
    assert.equal(await page.locator('details[open]').count(), 1)
    await summary.press('Space')
    assert.equal(await page.locator('details[open]').count(), 0)
    const reasoning = page.getByLabel('Agent 推理深度', { exact: true })
    await reasoning.selectOption('high')
    assert.equal(await reasoning.inputValue(), 'high')
    await reasoning.focus()
    await reasoning.press('Alt+ArrowDown')
    await reasoning.press('Escape')
    assert.equal(await reasoning.inputValue(), 'high')
    await refresh.click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 推理深度"]')?.value === 'low')
    checks.push('workflow-keyboard-and-adjacent-native-select')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  if (!baseline) {
    await assertNoSheetUi()
    const layout = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('[data-dingtalk-assistant-settings] > section')]
      const environment = sections.find(section => section.querySelector('strong')?.textContent === '环境检查')
      const agent = sections.find(section => section.querySelector('strong')?.textContent === 'Agent 配置')
      return { adjacent: environment.nextElementSibling === agent, gap: agent.getBoundingClientRect().top - environment.getBoundingClientRect().bottom }
    })
    assert.deepEqual(layout, { adjacent: true, gap: 12 })
  }
  await page.screenshot({ path: resolve(outputDir, baseline ? 'baseline-narrow.png' : 'after-narrow.png'), fullPage: true })
  checks.push('narrow-layout-no-horizontal-overflow')
  const sheetRequests = requests.filter(item => item.path.includes('task-sheet-sync'))
  assert.equal(sheetRequests.length, baseline ? 1 : 0)
  assert.deepEqual(errors, [])
  const result = { mode: baseline ? 'baseline' : 'after', checks, requestCount: requests.length, sheetRequests, writes, pageErrors: errors, requests }
  await writeFile(resolve(outputDir, baseline ? 'browser-baseline.json' : 'browser-after.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`PASS: ${result.mode}; ${checks.length} checks; sheetRequests=${sheetRequests.length}; pageerror=0`)
} finally {
  releaseInitialHealth()
  await browser.close()
  await new Promise(done => server.close(done))
}
