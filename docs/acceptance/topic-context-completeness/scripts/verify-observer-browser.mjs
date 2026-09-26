import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.join(root, 'docs/acceptance/topic-context-completeness/round-1')
await mkdir(output, { recursive: true })
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
if (!domDirectory) throw new Error('matching_react_dom_missing')
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 真实 React 与完整 observer 代码；DSH 外壳/primitive 仅用无副作用语义替身。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流程状态验收夹具</title><style>body{margin:0;color:#202124;font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:8px}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=7})=>h('span',{'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor})=>anchor};
for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true},h('path',{d:'M3 5L7 9L11 5',fill:'none',stroke:'currentColor'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`

const tasks = [{ taskId: 'task-1', title: '隔离任务', objective: '核对上下文', groupId: 'g', engine: 'workflow-v2', state: 'completed', updatedAt: '2026-09-26T00:00:00Z', topicRefs: [{ topicId: 'topic-2' }], executionNodes: [] }]
const topics = [{ topicId: 'topic-1', groupId: 'g', title: '慢话题', revision: 1 }, { topicId: 'topic-2', groupId: 'g', title: '当前话题', revision: 1 }]
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], writes = [], checks = [], calls = []
let slowRequested
const slowStarted = new Promise(resolve => { slowRequested = resolve })
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  calls.push(target.pathname)
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  let data = []
  if (target.pathname === '/health') data = { status: 'ok' }
  if (target.pathname === '/state/groups') data = [{ groupId: 'g', name: '隔离群', messages: [{ messageId: 'm', runId: 'msg-1', sequence: 1, text: '请检查记录', workflowStatus: 'processed', occurredAt: '2026-09-26T00:00:00Z', topicRefs: [] }], outbox: [] }]
  if (target.pathname === '/state/tasks') data = tasks
  if (target.pathname === '/state/topics') data = { topics, total: 2 }
  if (target.pathname.startsWith('/state/topics/topic-')) data = { topic: topics.find(item => target.pathname.endsWith(item.topicId)), messages: [], total: 0 }
  if (target.pathname === '/state/workflows/msg-1/trace') data = { runId: 'msg-1', revision: 1, reason: 'MESSAGE_CONTEXT_CAPACITY:IB:$:33000/32000', items: [{ id: 'n1', kind: 'intent', status: 'succeeded', input: { text: '完整输入' }, output: { reason: '当前判断' }, usage: null, sourceRunIds: ['msg-1'] }], nextCursor: null }
  if (target.pathname.startsWith('/state/workflows/topics/')) {
    const slow = target.pathname.includes('topic-1')
    if (slow) { slowRequested(); await new Promise(resolve => setTimeout(resolve, 800)) }
    data = { topicId: slow ? 'topic-1' : 'topic-2', revision: 1, current: { text: slow ? '不应覆盖的旧上下文' : '当前有效上下文' }, facts: [], intentRuns: [{ intentRunId: target.searchParams.has('intentCursor') ? 'ib-older' : 'ib-1', carrierRunId: 'msg-1', status: 'succeeded', sourceRunIds: ['msg-1'] }], intentNextCursor: target.searchParams.has('intentCursor') ? null : 50, nextCursor: null }
  }
  if (target.pathname === '/state/tasks/task-1/runs') data = { taskId: 'task-1', taskOwner: { status: 'active', sessionId: 'reserved-owner', sessionBound: false }, runs: [{ runId: 'run-old', status: 'succeeded', nodes: [{ nodeId: 'analyze', label: '历史分析', status: 'succeeded', sessionId: 'node-history' }] }], nextCursor: null }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '处理过程', exact: true }).click()
  await page.getByRole('region', { name: '消息处理过程' }).waitFor()
  const input = page.locator('summary').filter({ hasText: /^输入$/ })
  await input.focus(); await page.keyboard.press('Enter')
  assert.equal(await input.evaluate(element => element.parentElement.open), true)
  await page.getByText('完整输入', { exact: false }).waitFor()
  await page.getByText(/上下文容量受阻/).waitFor()
  const usage = page.locator('summary').filter({ hasText: /^用量$/ })
  await usage.focus(); await page.keyboard.press(' ')
  await page.getByText('模型用量未知（未记录）').waitFor()
  checks.push('message-trace', 'keyboard-details', 'unknown-usage', 'capacity-reason')
  await page.screenshot({ path: path.join(output, 'message-trace.png'), fullPage: true })
  await page.getByRole('button', { name: '返回收信箱' }).click()
  await page.getByRole('button', { name: '话题', exact: true }).click()
  await page.getByRole('button', { name: '慢话题', exact: true }).click()
  await slowStarted
  await page.getByRole('button', { name: '当前话题', exact: true }).click()
  const current = page.locator('summary').filter({ hasText: /^当前有效状态$/ })
  await current.waitFor(); await current.click()
  await page.getByText(/当前有效上下文/).waitFor()
  await page.waitForTimeout(1000)
  assert.equal(await page.getByText(/不应覆盖的旧上下文/).count(), 0)
  await page.getByText(/意图判断批次/).waitFor()
    await page.getByRole('button', { name: '下一页判断', exact: true }).click()
  const older = page.locator('summary').filter({ hasText: /ib-older/ })
  await older.waitFor(); await older.click()
  await page.getByRole('button', { name: '查看本次判断', exact: true }).click()
  await page.getByRole('region', { name: '消息处理过程' }).waitFor()
  await page.getByRole('button', { name: '返回话题判断列表', exact: true }).click()
  await older.waitFor()
  await page.getByRole('button', { name: '上一页判断', exact: true }).click()
  await page.locator('summary').filter({ hasText: /ib-1/ }).waitFor()
  checks.push('topic-context', 'stale-response-ignored', 'intent-batches', 'independent-intent-pagination', 'intent-trace-return-preserves-page')
  await page.screenshot({ path: path.join(output, 'topic-context.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('region', { name: '话题详情内容' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'topic-context-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  checks.push('narrow-topic-context')
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await page.getByText('隔离任务', { exact: true }).click()
  await page.getByText('任务负责人会话与历史执行', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '查看任务负责人会话' }).count(), 0)
  const run = page.locator('summary').filter({ hasText: /执行 run-old/ })
  await run.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '查看此节点会话记录', exact: true }).waitFor()
  checks.push('task-history', 'reserved-owner-no-link')
  await page.screenshot({ path: path.join(output, 'topic-context-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.getByRole('button', { name: '查看此节点会话记录', exact: true }).isVisible())
  await run.focus(); await page.keyboard.press(' ')
  assert.equal(await run.evaluate(element => element.parentElement.open), false)
  await page.screenshot({ path: path.join(output, 'task-history-narrow.png'), fullPage: true })
  checks.push('narrow-history', 'narrow-keyboard-collapse')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
  const result = { passed: true, checks, screenshots: { message: 'message-trace.png', topic: 'topic-context.png', topicNarrow: 'topic-context-narrow.png', task: 'topic-context-desktop.png', taskNarrow: 'task-history-narrow.png' }, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), errors, writes, apiCalls: calls.length, boundary: '真实React与完整observer代码；隔离临时server，API全部由Playwright拦截，未访问真实18998；DSH primitives为语义替身。' }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
