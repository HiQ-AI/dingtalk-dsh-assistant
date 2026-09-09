import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 独立无外发浏览器：运行真实 Observer 脚本，DSH 容器与 UI primitives 用最小宿主替身。
// node <script> <playwright-package-directory>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const playwrightPath = process.argv[2]
if (!playwrightPath) throw new Error('playwright_package_directory_required')
const { chromium } = createRequire(pathToFileURL(path.join(playwrightPath, 'package.json')))('playwright')
const packageDirs = await readdir(path.join(root, 'node_modules/.pnpm'))
const reactDir = packageDirs.find((name) => /^react@18\./u.test(name))
const domDir = packageDirs.find((name) => /^react-dom@18\./u.test(name))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(5000)
const errors = [], requests = []
page.on('pageerror', (error) => errors.push(error.message))
const outputDir = path.join(root, 'docs/tmp/workflow-notification-review')
await mkdir(outputDir, { recursive: true })
const group = { groupId: 'g', name: '验收群', messages: [], outbox: [
  {
    "outboundId": "queued",
    "text": "尚未尝试发送",
    "status": "pending",
    "readbackRequired": true
  },
  {
    "outboundId": "before",
    "text": "发送前受阻通知",
    "status": "pending",
    "readbackRequired": true,
    "deliveryPendingReason": "preflight_failed",
    "deliveryError": "CLI_ORG_NOT_AUTHORIZED",
    "deliveryAttemptCount": 2,
    "deliveryAttemptedAt": "2026-09-09T03:10:00Z"
  },
  {
    "outboundId": "after",
    "text": "回读受阻通知",
    "status": "pending",
    "readbackRequired": true,
    "deliveryPendingReason": "postflight_failed",
    "deliveryError": "CLI_ORG_NOT_AUTHORIZED",
    "deliveryAttemptCount": 1,
    "deliveryAttemptedAt": "2026-09-09T03:11:00Z"
  },
  {
    "outboundId": "success",
    "text": "成功通知",
    "status": "sent",
    "deliveredMessageId": "actual-message-id"
  },
  {
    "outboundId": "legacy",
    "text": "历史确认通知",
    "status": "sent"
  },
  {
    "outboundId": "recalled",
    "text": "撤回通知",
    "status": "sent",
    "recallStatus": "recalled"
  },
  {
    "outboundId": "long",
    "text": "长错误详情通知",
    "status": "pending",
    "deliveryPendingReason": "send_failed",
    "deliveryError": "NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_NETWORK_TIMEOUT_",
    "deliveryAttemptCount": 3,
    "deliveryAttemptedAt": "2026-09-09T03:12:00Z"
  }
] }
const fixtures = new Map([
  ['/health', { status: 'ok' }],
  ['/state/groups', [group]],
  ['/state/tasks', []],
  ['/state/supervisor/alerts', []],
  ['/state/authorizations', []],
  ['/state/topics', { topics: [], total: 0, offset: 0, limit: 100 }],
])
const unexpectedRequests = []
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  requests.push(url.pathname + url.search)
  if (url.origin !== 'http://127.0.0.1:18998' || !fixtures.has(url.pathname)) {
    unexpectedRequests.push(url.href)
    return route.abort()
  }
  await route.fulfill({ status: 200, json: fixtures.get(url.pathname) })
})
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{font:14px system-ui;margin:0}button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid blue}*{box-sizing:border-box}</style></head><body><div id="root"></div></body></html>')
  await page.addScriptTag({ path: path.join(root, 'node_modules/.pnpm', reactDir, 'node_modules/react/umd/react.development.js') })
  await page.addScriptTag({ path: path.join(root, 'node_modules/.pnpm', domDir, 'node_modules/react-dom/umd/react-dom.development.js') })
  await page.evaluate(() => {
    const h = React.createElement
    const ui = {
      Button: ({ variant, size, children, ...props }) => h('button', props, children),
      Pill: ({ children, ...props }) => h('span', props, children), StateDot: () => h('span', { 'aria-hidden': true }, '●'),
      IconChecklistOutline14: () => null, IconChevronDownOutline14: () => null, IconChevronUpOutline14: () => null,
      Menu: ({ open, anchor, items, onSelect }) => h('div', null, anchor, open ? h('div', { role: 'menu' }, ...items.map((item) => h('button', { key: item.id, role: 'menuitem', onClick: () => onSelect(item.id) }, item.label))) : null),
    }
    const root = ReactDOM.createRoot(document.getElementById('root'))
    let sidebar, content
    const render = () => root.render(h('div', null, sidebar ? h(sidebar, { wide: true }) : null, content ? h(content, { openSession: async () => undefined }) : null))
    window.__ModuleLoader__ = { load({ factory }) { const plugin = factory((name) => name === 'react' ? React : ui); plugin.apply({ slots: { inject(_name, callback) { callback() }, register(options, component) { if (options.name === 'sidebar.footer.action') sidebar = component; else content = component; render(); return () => undefined } }, sessions: {} }) } }
  })
  await page.addScriptTag({ content: await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8') })
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()

  await page.getByRole('tab', { name: '发信箱 · 7', exact: true }).click()
  const row = (text) => page.getByRole('row').filter({ has: page.getByText(text, { exact: true }) })
  assert.match(await row('尚未尝试发送').innerText(), /待发送/)
  assert.match(await row('发送前受阻通知').innerText(), /发送受阻[\s\S]*发送前检查失败，本次未发送：CLI_ORG_NOT_AUTHORIZED[\s\S]*最近尝试.*共 2 次/)
  assert.match(await row('回读受阻通知').innerText(), /待回读[\s\S]*发送后回读失败：CLI_ORG_NOT_AUTHORIZED/)
  assert.match(await row('成功通知').innerText(), /已回读/)
  assert.match(await row('历史确认通知').innerText(), /已发送/)
  assert.match(await row('撤回通知').innerText(), /已撤回/)
  assert.match(await row('长错误详情通知').innerText(), /投递异常[\s\S]*发送调用失败，尚未确认送达：[\s\S]*最近尝试.*共 3 次/)
  const select = page.getByRole('button', { name: '筛选发件状态', exact: true })
  await select.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: '投递异常', exact: true }).click()
  assert.equal(await page.getByRole('row').count(), 3)
  assert.equal(await row('回读受阻通知').count(), 0)
  await select.click()
  await page.getByRole('menuitem', { name: '待回读', exact: true }).click()
  assert.equal(await page.getByRole('row').count(), 2)
  await select.click()
  await page.getByRole('menuitem', { name: '全部发件状态', exact: true }).click()
  const badgeLayout = await row('发送前受阻通知').locator('td').first().evaluate(el => { const badge = el.querySelector('div > span'); const clip = badge.parentElement; return { badgeWidth: badge.getBoundingClientRect().width, available: clip.getBoundingClientRect().width } })
  assert.ok(badgeLayout.badgeWidth <= badgeLayout.available, JSON.stringify(badgeLayout))
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await row('长错误详情通知').scrollIntoViewIfNeeded()
  const layout = await row('长错误详情通知').locator('td').nth(1).evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }))
  assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout))
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-narrow.png'), fullPage: true })
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpectedRequests, [])
  console.log(JSON.stringify({ status: 'PASS', scenarios: 7, keyboardFilter: true, narrowContentWrap: true, pageErrors: errors.length, interceptedRequests: requests.length, realDwsRequests: 0 }))
} finally { await browser.close() }
