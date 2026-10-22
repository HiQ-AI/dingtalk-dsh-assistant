// 真实 Chromium、React 和发布 bundle；隔离配置 API，不连接本地任务或启动 CLI。
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, reactDomPath, browserPath, outputDir] = process.argv.slice(2)
assert.ok(playwrightPath && reactDomPath && browserPath && outputDir, '参数：playwright/index.mjs ReactDOM-UMD 浏览器可执行文件 输出目录')
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)))
const root = new URL('../../../../', import.meta.url)
const [react, reactDom, bundle] = await Promise.all([
  readFile(new URL('node_modules/react/umd/react.development.js', root), 'utf8'),
  readFile(reactDomPath, 'utf8'), readFile(new URL('packages/dingtalk-dsh-assistant/web-client.js', root), 'utf8'),
])
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>执行后端配置验收</title><style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root"></div><script>${react}</script><script>${reactDom}</script><script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>{if(name==='react')return React;throw Error(name)})}}</script><script>${bundle}</script><script>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(plugin.DingTalkDshAssistantCard))</script></html>`
const observerBundle = (await readFile(new URL('packages/dingtalk-dsh-observer/web-client.js', root), 'utf8')).replace('return module.exports', 'return { ...module.exports, SessionLocation, observerCss, taskDetailCss }')
const observerHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>执行后端路径验收</title><style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root" class="observer-session-detail" data-dingtalk-observer></div><script>${react}</script><script>${reactDom}</script><script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:{Button:({variant,size,...props})=>React.createElement('button',props)})}};window.opened=[]</script><script>${observerBundle}</script><script>const locationData={sessionId:'cli-session',sessionBound:true,executionBackend:'claude-code',workspaceDir:'D:/tasks/current',workingDirectory:'D:/tasks/current/work',document:{path:'D:/tasks/current/outputs/execution/round-2.md',inputVersion:2},logPath:'D:/tasks/current/outputs/execution/claude-events.jsonl'};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement('style',null,plugin.observerCss + plugin.taskDetailCss),React.createElement('div',{id:'cli-location'},React.createElement(plugin.SessionLocation,{session:locationData,label:'执行会话',compact:true,onOpenSession:id=>opened.push(id)})),React.createElement('div',{id:'dsh-location'},React.createElement(plugin.SessionLocation,{session:{sessionId:'dsh-session',executionBackend:'dsh'},label:'任务会话',compact:true,onOpenSession:id=>opened.push(id)}))))</script></html>`
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(req.url === '/observer' ? observerHtml : html) })
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }), errors = [], requests = []
page.on('pageerror', error => errors.push(error.message))
const model = () => ({ provider: 'openai-codex', model: 'gpt-6-astra', reasoningMode: 'explicit', reasoningEffort: 'low' })
let config = { provider: 'openai-codex', model: 'sol', reasoningEffort: 'low', workspaceDir: 'D:/synthetic-agent', agentNames: ['测试助手'], replySignature: '', proxyUrl: '', taskSessionModel: model(), coordinationModel: model() }
let fail = false, hold = false, held
await page.route('http://127.0.0.1:18998/**', async route => {
  const path = new URL(route.request().url()).pathname
  if (path === '/state/groups' && hold) { held = route; return }
  let value = { '/health': { status: 'ok' }, '/state/groups': [], '/state/tasks': [], '/state/supervisor/alerts': [], '/state/environment': {}, '/state/version': {}, '/state/agent-config': config }[path] ?? {}
  if (path === '/state/task-model-options') value = { providers: [{ id: 'openai-codex', name: 'Codex' }], models: [{ id: 'gpt-6-astra', name: 'Astra' }], available: true, reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
  if (path === '/config/agent') {
    const body = route.request().postDataJSON(); requests.push(body)
    await new Promise(done => setTimeout(done, 200))
    if (fail) return route.fulfill({ status: 500, json: { error: 'AGENT_CONFIG_SAVE_FAILED', readback: config } })
    config = { ...config, ...body }; value = config
  }
  await route.fulfill({ json: value })
})
try {
  await mkdir(outputDir, { recursive: true })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const form = page.getByRole('form', { name: 'Agent 配置' }), select = form.getByLabel('执行后端', { exact: true }), save = form.getByRole('button', { name: '保存配置', exact: true })
  await select.waitFor(); await page.waitForFunction(() => document.querySelectorAll('#task-reasoning option').length === 3)
  assert.equal(await select.inputValue(), 'dsh', '未配置时显示默认DSH')
  assert.equal(await save.count(), 1)
  assert.match(await form.textContent(), /仅新执行使用此选择；已有执行及续办保持原后端/)
  await form.getByText('执行后端', { exact: true }).click()
  assert.equal(await select.evaluate(node => document.activeElement === node), true)
  await select.press('Alt+ArrowDown'); await page.screenshot({ path: resolve(outputDir, 'backend-select-open.png') })
  await select.press('Escape'); await select.press('ArrowDown'); await select.press('Enter')
  assert.equal(await select.inputValue(), 'claude-code', '原生菜单支持键盘选择')
  hold = true; await page.getByRole('button', { name: '刷新', exact: true }).click()
  for (let attempt = 0; !held && attempt < 100; attempt++) await page.waitForTimeout(20)
  assert.ok(held, '应观察到被暂缓的刷新请求')
  const beforeSave = await save.boundingBox()
  await save.click(); assert.equal(await select.isDisabled(), true)
  assert.equal((await form.getByRole('button', { name: '正在保存…', exact: true }).boundingBox()).width, beforeSave.width)
  await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await form.getByRole('status').filter({ hasText: 'Agent 配置已保存' }).waitFor()
  hold = false; await held.fulfill({ json: [] }); await page.waitForTimeout(100)
  assert.equal(requests.length, 1, '保存中不重复请求')
  assert.equal(await select.inputValue(), 'claude-code', '过期刷新不能覆盖保存结果')
  assert.equal(config.executionBackend, 'claude-code')
  assert.equal(config.model, 'sol'); assert.equal(config.taskSessionModel.model, 'gpt-6-astra')
  await form.screenshot({ path: resolve(outputDir, 'backend-saved-desktop.png') })
  await page.reload(); await select.waitFor(); assert.equal(await select.inputValue(), 'claude-code', '刷新回读保存值')
  await select.selectOption('dsh'); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForTimeout(400)
  assert.equal(await select.inputValue(), 'dsh', '刷新不覆盖未保存草稿')
  fail = true; await save.click()
  await form.getByRole('alert').filter({ hasText: '插件设置（含统筹、协调和执行后端）：未全部生效' }).waitFor()
  assert.equal(config.executionBackend, 'claude-code'); assert.equal(await select.inputValue(), 'dsh', '失败保留选择并诚实回读')
  await page.setViewportSize({ width: 390, height: 844 }); await select.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await form.screenshot({ path: resolve(outputDir, 'backend-error-narrow.png') })
  fail = false; await save.click(); await form.getByRole('status').filter({ hasText: 'Agent 配置已保存' }).waitFor()
  assert.equal(config.executionBackend, 'dsh')
  await page.goto(`http://127.0.0.1:${server.address().port}/observer`)
  const cli = page.locator('#cli-location'), native = page.locator('#dsh-location')
  await cli.getByText('执行会话 · Claude Code', { exact: true }).waitFor()
  assert.equal(await cli.getByRole('button').count(), 0, 'CLI绑定不能展示DSH导航')
  await cli.locator('summary').click()
  assert.match(await cli.textContent(), /round-2.md/); assert.match(await cli.textContent(), /claude-events.jsonl/)
  await native.getByRole('button', { name: '打开任务会话', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.opened), ['dsh-session'])
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: resolve(outputDir, 'backend-observer-narrow.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const result = { passed: true, requests: requests.length, checks: ['default DSH', 'native select label and keyboard', 'single save and busy guard', 'save readback and reload', 'stale refresh fenced', 'unsaved draft retained', 'failure readback and retry', '390px no overflow', 'full generated bundle', 'CLI paths without DSH navigation; native entry retained'], boundary: 'isolated HTTP fixture and native-button adapter for observer; no real CLI execution, permission or deployment proof' }
  await writeFile(resolve(outputDir, 'config-browser-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser.close(); await new Promise(done => server.close(done)) }
