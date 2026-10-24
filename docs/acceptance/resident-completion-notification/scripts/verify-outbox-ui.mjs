import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 加载真实 Observer，使用最小宿主替身；所有 HTTP 请求均拦截，禁止外发和修改运行账。
// node <script> <playwright-package-directory> <dsh-profile-node-modules-directory>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const playwrightPath = process.argv[2]
const hostModulesPath = process.argv[3]
if (!playwrightPath) throw new Error('playwright_package_directory_required')
if (!hostModulesPath) throw new Error('dsh_profile_node_modules_directory_required')
const { chromium } = createRequire(pathToFileURL(path.join(playwrightPath, 'package.json')))('playwright')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
page.setDefaultTimeout(5000)
const errors = [], requests = [], unexpectedRequests = []
page.on('pageerror', (error) => errors.push(error.message))
const outputDir = path.join(root, 'docs/tmp/outbox-cancellation-status')
await mkdir(outputDir, { recursive: true })
const retryAt = '2026-10-24T03:30:00Z'
const examples = [
  { outboundId: 'queued', text: '等待发送的新通知', notificationState: 'prepared', status: 'pending', expected: '待发送' },
  { outboundId: 'starting', text: '正在执行发送的通知', notificationState: 'starting', status: 'pending', expected: '发送中' },
  {
    outboundId: 'cancelled', text: '订正后取消的旧通知', notificationState: 'superseded', status: 'superseded', expected: '已取消',
    notificationKnownNotSent: true, deliveryPendingReason: 'task-notification-coordination-source-resolved',
    supersededByOutboundId: 'fixture-replacement-corrected', notificationRetryAt: retryAt, deliveryError: 'FIXTURE_CANCELLED_OLD_ERROR',
  },
  {
    outboundId: 'unknown', text: '被替代但发送结果仍未知', notificationState: 'unknown', status: 'superseded', expected: '待确认',
    supersededByOutboundId: 'fixture-replacement-unknown', notificationFailurePhase: 'readback',
    deliveryPendingReason: 'task-notification-coordination-source-resolved', notificationRetryAt: retryAt,
  },
  {
    outboundId: 'delivered', text: '已送达后被替代并撤回', notificationState: 'delivered', status: 'superseded', expected: '已送达',
    deliveredAt: '2026-10-24T03:10:00Z', deliveredMessageId: 'fixture-delivered-message',
    supersededByOutboundId: 'fixture-replacement-delivered', recallStatus: 'recalled', deliveryError: 'FIXTURE_HISTORICAL_ERROR',
  },
  {
    outboundId: 'retriable', text: '确定未发且等待重试', notificationState: 'failed', status: 'pending', expected: '异常',
    notificationKnownNotSent: true, deliveryPendingReason: 'task-notification-pre-send-rejected', notificationRetryAt: retryAt,
    deliveryError: 'FIXTURE_PRE_SEND_REJECTED', deliveryAttemptCount: 2, deliveryAttemptedAt: '2026-10-24T03:11:00Z',
  },
  {
    outboundId: 'reassessment', text: '旧确认关联仍需人工核验', notificationState: 'failed', status: 'pending', expected: '异常',
    notificationKnownNotSent: true, deliveryPendingReason: 'task-notification-confirmation-reassessment-required',
  },
  {
    outboundId: 'legacy', text: '历史替代记录缺少发送证明', status: 'superseded', expected: '待确认',
    supersededByOutboundId: 'fixture-replacement-legacy', deliveryError: 'FIXTURE_LEGACY_ERROR',
  },
  {
    outboundId: 'long-error', text: '长错误和撤回原因仅供诊断', notificationState: 'failed', status: 'pending', expected: '异常',
    deliveryPendingReason: 'task-notification-failed', deliveryError: 'FIXTURE_NETWORK_TIMEOUT_'.repeat(24),
    recallStatus: 'failed', recallError: 'FIXTURE_RECALL_ERROR',
  },
  { outboundId: 'workflow', text: '兼容工作流的待发送通知', notificationStatus: 'prepared', status: 'pending', expected: '待发送' },
]
const group = { groupId: 'g', name: '验收群', messages: [], outbox: examples.map(({ expected, ...message }) => ({
  sourceMessageId: 'fixture-source-' + message.outboundId, replyToMessageId: 'fixture-reply-' + message.outboundId,
  readbackRequired: true, ...message,
})) }
const fixtures = new Map([
  ['/health', { status: 'ok' }], ['/state/groups', [group]], ['/state/tasks', []],
  ['/state/supervisor/alerts', []], ['/state/authorizations', []],
  ['/state/topics', { topics: [], total: 0, offset: 0, limit: 100 }],
])
await page.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url())
  requests.push({ method: request.method(), path: url.pathname + url.search })
  if (request.method() !== 'GET' || url.origin !== 'http://127.0.0.1:18998' || !fixtures.has(url.pathname)) {
    unexpectedRequests.push(request.method() + ' ' + url.href)
    return route.abort()
  }
  await route.fulfill({ status: 200, json: fixtures.get(url.pathname) })
})
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{font:14px system-ui;margin:0}button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid blue}*{box-sizing:border-box}</style></head><body><div id="root"></div></body></html>')
  await page.addScriptTag({ path: path.join(hostModulesPath, 'react/umd/react.development.js') })
  await page.addScriptTag({ path: path.join(hostModulesPath, 'react-dom/umd/react-dom.development.js') })
  await page.evaluate(() => {
    const h = React.createElement
    const ui = {
      Button: ({ variant, size, children, ...props }) => h('button', props, children),
      Pill: ({ children, ...props }) => h('span', props, children), StateDot: () => h('span', { 'aria-hidden': true }, '●'),
      IconChecklistOutlineRegular: () => null, IconChevronDownOutlineRegular: () => null, IconChevronUpOutlineRegular: () => null,
      Menu: ({ open, anchor, items, onSelect }) => h('div', null, anchor, open ? h('div', { role: 'menu' }, ...items.map((item) => h('button', { key: item.id, role: 'menuitem', onClick: () => onSelect(item.id) }, item.label))) : null),
    }
    const root = ReactDOM.createRoot(document.getElementById('root'))
    let sidebar, content
    const render = () => root.render(h('div', null, sidebar ? h(sidebar.component, { ...sidebar.props(), wide: true }) : null, content ? h(content.component, content.props()) : null))
    window.__ModuleLoader__ = { load({ factory }) {
      const plugin = factory((name) => name === 'react' ? React : ui)
      plugin.apply({ slots: { inject(_name, callback) { callback() }, register(options, component) {
        const entry = { component, props: options.inject }
        if (options.name === 'sidebar.footer.action') sidebar = entry
        else content = entry
        render()
        return () => { if (content === entry) content = undefined; render() }
      } }, layout: { selectPanel() {} }, sessions: {}, uiWorkspace: {} })
    } }
  })
  await page.addScriptTag({ content: await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8') })
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('tab', { name: '发信箱 · ' + examples.length, exact: true }).click()
  const row = (text) => page.getByRole('row').filter({ has: page.getByText(text, { exact: true }) })
  const statusOf = async (text) => (await row(text).locator('td').first().innerText()).replace(/^●\s*/u, '').trim()
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(), ['状态', '送达时间', '消息内容', '来源'])
  for (const example of examples) assert.equal(await statusOf(example.text), example.expected, example.outboundId)
  const cancelled = row('订正后取消的旧通知')
  assert.match(await cancelled.innerText(), /后续消息已补充或订正原安排，已取消旧回复；本次未发送/)
  assert.doesNotMatch(await cancelled.innerText(), /计划重试|计划核验|FIXTURE_|fixture-/)
  assert.match(await row('确定未发且等待重试').innerText(), /计划重试/)
  assert.match(await row('被替代但发送结果仍未知').innerText(), /计划核验/)
  assert.match(await row('已送达后被替代并撤回').innerText(), /已替代[\s\S]*已撤回/)
  assert.match(await row('旧确认关联仍需人工核验').innerText(), /核验/)
  assert.doesNotMatch(await row('历史替代记录缺少发送证明').innerText(), /本次未发送|已取消/)
  assert.doesNotMatch(await page.locator('body').innerText(), /FIXTURE_|fixture-source-|fixture-reply-|fixture-replacement-|fixture-delivered-/)

  // 默认折叠保留原始诊断；展开后核验记录没有被展示层丢弃。
  const diagnostics = row('长错误和撤回原因仅供诊断')
  await diagnostics.locator('summary').click()
  assert.match(await diagnostics.innerText(), /FIXTURE_NETWORK_TIMEOUT_/)
  assert.match(await diagnostics.innerText(), /FIXTURE_RECALL_ERROR/)
  assert.match(await diagnostics.innerText(), /fixture-source-long-error/)
  await diagnostics.locator('summary').click()

  const select = page.getByRole('button', { name: '筛选发送状态', exact: true })
  assert.equal(await select.count(), 1)
  await select.focus()
  await page.keyboard.press('Enter')
  const labels = ['全部状态', '待发送', '发送中', '待确认', '已送达', '已取消', '异常']
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), labels)
  await page.getByRole('menuitem', { name: '已取消', exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.getByRole('row').count(), 2)
  assert.equal(await statusOf('订正后取消的旧通知'), '已取消')
  const beforeRefresh = requests.filter((request) => request.path === '/state/groups').length
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('button', { name: '已刷新', exact: true }).waitFor()
  assert.ok(requests.filter((request) => request.path === '/state/groups').length > beforeRefresh)
  assert.equal(await page.getByRole('row').count(), 2, '刷新应保留已取消筛选')
  assert.equal(await statusOf('订正后取消的旧通知'), '已取消')
  for (const label of labels.slice(1)) {
    await select.click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    const expected = examples.filter((example) => example.expected === label)
    assert.equal(await page.getByRole('row').count(), expected.length + 1, label)
    for (const example of expected) assert.equal(await statusOf(example.text), label)
  }
  await select.click()
  await page.getByRole('menuitem', { name: '全部状态', exact: true }).click()
  const badgeLayout = await cancelled.locator('td').first().evaluate((cell) => ({ width: cell.clientWidth, scrollWidth: cell.scrollWidth }))
  assert.ok(badgeLayout.scrollWidth <= badgeLayout.width + 1, JSON.stringify(badgeLayout))
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const filterLayout = await select.evaluate((button) => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right, viewport: window.innerWidth }))
  assert.ok(filterLayout.left >= 0 && filterLayout.right <= filterLayout.viewport, JSON.stringify(filterLayout))
  await diagnostics.scrollIntoViewIfNeeded()
  const layout = await diagnostics.locator('td').nth(2).evaluate((cell) => ({ width: cell.clientWidth, scrollWidth: cell.scrollWidth }))
  assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout))
  const tableLayout = await page.getByRole('table').evaluate((table) => ({ tableWidth: table.clientWidth, viewportWidth: table.parentElement.clientWidth, overflowX: getComputedStyle(table.parentElement).overflowX }))
  assert.equal(tableLayout.overflowX, 'auto')
  assert.ok(tableLayout.tableWidth > tableLayout.viewportWidth, JSON.stringify(tableLayout))
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-narrow.png'), fullPage: true })
  await diagnostics.locator('summary').click()
  const diagnosticLayout = await diagnostics.locator('td').nth(3).evaluate((cell) => ({ width: cell.clientWidth, scrollWidth: cell.scrollWidth }))
  assert.ok(diagnosticLayout.scrollWidth <= diagnosticLayout.width + 1, JSON.stringify(diagnosticLayout))
  assert.match(await diagnostics.innerText(), /FIXTURE_NETWORK_TIMEOUT_/)
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-narrow-diagnostics.png'), fullPage: true })
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpectedRequests, [])
  const report = { status: 'PASS', scenarios: examples.length, publicStatuses: labels.slice(1), fourColumns: true, keyboardFilter: true, refreshPreservesFilter: true, cancelledWithoutRetry: true, rawDiagnosticsFolded: true, narrowContentWrap: true, narrowFilterVisible: true, localTableScroll: true, pageErrors: errors.length, interceptedRequests: requests.length, realDwsRequests: 0, boundary: '真实 Observer 脚本；宿主 UI primitives 与 HTTP 均为合成替身，不代表钉钉真实收发验收。' }
  await writeFile(path.join(outputDir, 'browser-summary.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'outbox-ui-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally { await browser.close() }
