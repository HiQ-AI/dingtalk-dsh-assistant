// 独立 Chromium + 真实 React 和发布 bundle；配置 API 使用内存 fixture，不触碰本地运行任务。
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, reactDomPath, outputDir] = process.argv.slice(2)
assert.ok(playwrightPath && reactDomPath && outputDir, '参数：playwright/index.mjs react-dom/umd/react-dom.development.js 输出目录')
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)))
const root = new URL('../../../../', import.meta.url)
const assets = await Promise.all([
  readFile(new URL('node_modules/react/umd/react.development.js', root), 'utf8'),
  readFile(reactDomPath, 'utf8'),
  readFile(new URL('packages/dingtalk-dsh-assistant/web-client.js', root), 'utf8'),
])
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root"></div>
<script>${assets[0]}</script><script>${assets[1]}</script>
<script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:{IconRefreshOutline16:()=>null})}}</script>
<script>${assets[2]}</script><script>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(plugin.DingTalkDshAssistantCard))</script>`
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let config = { workspaceDir: 'D:/test', agentNames: ['助理'], model: 'fake', reasoningEffort: 'low', leafSessionPrompt: '', proxyUrl: '', maxConcurrentTasks: 5, taskPromptsVersion: 1,
  taskPrompts: Array.from({ length: 9 }, (_, i) => ({ id: `flow-${i}`, name: `流程 ${i + 1}`, description: `适用说明 ${i + 1}`, prompt: `正文 ${i + 1}`, enabled: i !== 8, revision: 1 })) }
let failSave = false, writes = 0
await page.route('http://127.0.0.1:18998/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  const data = { '/health': { status: 'ok' }, '/state/groups': [], '/state/tasks': [], '/state/supervisor/alerts': [], '/state/environment': {}, '/state/version': {}, '/state/agent-config': config }
  if (path === '/config/agent') {
    writes++
    if (failSave) return route.fulfill({ status: 409, json: { error: '模拟版本冲突，请刷新后重试' } })
    config = { ...config, ...route.request().postDataJSON() }
  }
  return route.fulfill({ json: path === '/config/agent' ? config : (data[path] ?? {}) })
})
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('通用执行规范已内置，留空也会生效。', { exact: false }).waitFor()
  await page.locator('details').last().waitFor({ state: 'visible' })
  assert.equal(await page.locator('details').count(), 9)
  assert.equal(await page.locator('details[open]').count(), 0)
  assert.equal(await page.getByLabel(/^流程与验收提示词/).first().isVisible(), false)
  assert.equal(await page.getByLabel('叶子会话提示词', { exact: true }).inputValue(), '')
  assert.match(await page.locator('summary').last().textContent(), /已停用/)
  const summary = page.locator('summary').first()
  await summary.focus(); await summary.press('Enter')
  await page.getByLabel('名称', { exact: true }).first().fill('修改后的流程')
  await page.getByLabel(/^流程与验收提示词/).first().fill('已编辑正文')
  assert.equal(await page.locator('details[open]').count(), 1)
  await summary.focus(); await summary.press('Space')
  assert.equal(await page.locator('details[open]').count(), 0)
  assert.equal(writes, 0, '展开、编辑、收起不能隐式保存')
  await summary.click()
  assert.equal(await page.getByLabel(/^流程与验收提示词/).first().inputValue(), '已编辑正文')
  await page.getByLabel('叶子会话提示词', { exact: true }).fill('报告使用中文表格')
  failSave = true
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('模拟版本冲突，请刷新后重试').waitFor()
  assert.equal(await page.getByLabel('叶子会话提示词', { exact: true }).inputValue(), '报告使用中文表格')
  failSave = false
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '保存配置', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('button[disabled]')?.textContent === '保存配置' || [...document.querySelectorAll('button')].some(b => b.textContent === '保存配置' && b.disabled))
  assert.equal(config.leafSessionPrompt, '报告使用中文表格')
  assert.equal(config.taskPrompts[0].prompt, '已编辑正文')
  await page.reload()
  await page.locator('details').last().waitFor()
  assert.equal(await page.locator('details[open]').count(), 0)
  assert.equal(await page.getByLabel('叶子会话提示词', { exact: true }).inputValue(), '报告使用中文表格')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('summary').first().scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await mkdir(outputDir, { recursive: true })
  await page.screenshot({ path: resolve(outputDir, 'collapsed-narrow.png') })
  await page.getByRole('button', { name: '添加流程', exact: true }).click()
  assert.equal(await page.locator('details').count(), 10)
  assert.equal(await page.locator('details[open]').count(), 0)
  await page.locator('summary').last().click()
  await page.getByRole('button', { name: '移除', exact: true }).last().click()
  assert.equal(await page.locator('details').count(), 9)
  assert.equal(await page.locator('details[open]').count(), 0)
  config = { ...config, leafSessionPrompt: '', taskPrompts: [] }
  await page.reload()
  await page.getByText('尚未配置专用流程。叶子按通用提示词执行。').waitFor()
  assert.equal(await page.locator('details').count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: 默认九项折叠、键盘展开收起、编辑保留、失败保留草稿、保存回读、重载折叠、新增/删除、空列表、390px 无横溢出；pageerror=0')
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
