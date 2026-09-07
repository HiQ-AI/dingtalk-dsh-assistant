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
const errors = [], requests = []
page.on('pageerror', (error) => errors.push(error.message))
let scene = 'normal'
const delayedReplies = []
const topic = { topicId: 'topic-a', groupId: 'g', title: '月度数据导出', revision: 3, processedRevision: 2, status: 'active', summary: '确认导出范围与交付格式', openQuestions: ['是否包含历史记录？'], processing: { decisionId: 'failed-a', status: 'failed', appliedOperations: 1, totalOperations: 2 } }
const group = { groupId: 'g', name: '验收群', messages: [], outbox: [], topicProgress: { total: 1, pending: 1, unroutedMessages: 2 } }
const task = { taskId: 'task-a', groupId: 'g', title: '导出数据', objective: '导出本月数据', state: 'running', topicRefs: [{ topicId: 'topic-a', revision: 2 }], inputVersion: 1, childSessionId: 'session-a', updatedAt: '2026-09-07T00:00:00Z' }
await page.route('http://127.0.0.1:18998/**', async (route) => {
  const url = new URL(route.request().url())
  requests.push(url.pathname + url.search)
  let body = []
  if (url.pathname === '/health') body = { status: 'ok' }
  if (url.pathname === '/state/groups') body = [group]
  if (url.pathname === '/state/tasks') body = [task]
  if (url.pathname === '/state/topics') {
    if (scene === 'list-error') return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } })
    body = { topics: scene === 'empty' ? [] : scene === 'race' ? [topic, { ...topic, topicId: 'topic-b', title: '独立话题 B' }] : [topic], total: scene === 'empty' ? 0 : scene === 'race' ? 2 : 1, offset: 0, limit: 25 }
  }
  if (url.pathname === '/state/topics/topic-a') {
    if (scene === 'race') await new Promise((resolve) => delayedReplies.push(resolve))
    if (scene === 'detail-error') return route.fulfill({ status: 503, json: { error: 'fixture_context_unavailable' } })
    const offset = Number(url.searchParams.get('offset'))
    body = { topic, revision: Number(url.searchParams.get('revision')), groupId: 'g', topicId: 'topic-a', messages: [{ messageId: `m-${offset}`, text: offset ? '第二页原始输入' : '请导出本月数据，保留原始列名。', senderName: '测试成员', occurredAt: '2026-09-07T00:00:00Z' }], total: 26, offset, limit: 25, taskRefs: [] }
  }
  if (url.pathname === '/state/topics/topic-b') body = { topic: { ...topic, topicId: 'topic-b', title: '独立话题 B' }, revision: 3, messages: [{ messageId: 'b1', text: 'B 的固定版本输入' }], total: 1, offset: 0, limit: 25 }
  await route.fulfill({ status: 200, json: body })
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
  await page.getByRole('button', { name: '话题', exact: true }).click()
  await page.getByText('处理失败 · 已处理 2 / 3 · 动作 1 / 2', { exact: true }).waitFor()
  await page.getByRole('button', { name: '月度数据导出', exact: true }).click()
  await page.getByText('请导出本月数据，保留原始列名。', { exact: true }).waitFor()
  assert.ok(requests.includes('/state/topics/topic-a?groupId=g&revision=3&offset=0&limit=25'))
  await page.getByRole('region', { name: '话题详情', exact: true }).getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('第二页原始输入', { exact: true }).waitFor()
  assert.ok(requests.includes('/state/topics/topic-a?groupId=g&revision=3&offset=25&limit=25'))
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await page.getByRole('button', { name: '话题 topic-a · v2', exact: true }).click()
  await page.getByText('请导出本月数据，保留原始列名。', { exact: true }).waitFor()
  assert.ok(requests.includes('/state/topics/topic-a?groupId=g&revision=2&offset=0&limit=25'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '月度数据导出', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByText('版本 3', { exact: true }).waitFor()
  const overflow = await page.getByRole('region', { name: '话题与上下文', exact: true }).evaluate((element) => element.scrollWidth > element.clientWidth)
  assert.equal(overflow, false)
  await mkdir(path.join(root, 'docs/tmp/topic-observer'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'docs/tmp/topic-observer/narrow.png'), fullPage: true })
  scene = 'detail-error'
  await page.getByRole('region', { name: '话题详情', exact: true }).getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'fixture_context_unavailable' }).waitFor()
  scene = 'normal'
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByText('第二页原始输入', { exact: true }).waitFor()
  scene = 'empty'
  await page.getByRole('button', { name: '群聊会话', exact: true }).click()
  await page.getByRole('button', { name: '话题', exact: true }).click()
  await page.getByText('暂无话题，消息归类后会显示在这里', { exact: true }).waitFor()
  scene = 'list-error'
  await page.getByRole('button', { name: '群聊会话', exact: true }).click()
  await page.getByRole('button', { name: '话题', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '话题加载失败' }).waitFor()
  scene = 'normal'
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByRole('button', { name: '月度数据导出', exact: true }).waitFor()
  scene = 'race'
  await page.getByRole('button', { name: '群聊会话', exact: true }).click()
  await page.getByRole('button', { name: '话题', exact: true }).click()
  await page.getByText('正在读取固定版本上下文…', { exact: true }).waitFor()
  await page.getByRole('button', { name: '独立话题 B', exact: true }).click()
  await page.getByText('B 的固定版本输入', { exact: true }).waitFor()
  const oldResponse = page.waitForResponse((response) => response.url().includes('/state/topics/topic-a?'))
  delayedReplies.forEach((resolve) => resolve())
  await oldResponse
  assert.equal(await page.getByText('B 的固定版本输入', { exact: true }).count(), 1)
  assert.equal(await page.getByText('请导出本月数据，保留原始列名。', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'PASS', checks: ['list', 'fixed-revision-detail', 'pagination', 'task-topic-version-link', 'keyboard', 'narrow-no-overflow', 'empty', 'list-error-retry', 'detail-error-retry', 'loading', 'stale-response-suppressed'], pageErrors: errors, host: 'DSH mock container and primitive stubs; no real service or DWS writes' }))
} finally { await browser.close() }
