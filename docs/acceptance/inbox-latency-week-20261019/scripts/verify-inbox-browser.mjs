import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { createHash } from 'node:crypto'
const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, baseline: { type: 'boolean' }, playwright: { type: 'string' }, 'react-dom': { type: 'string' } } })
assert.ok(values.root && values.output)
const root = path.resolve(values.root), output = path.resolve(values.output), require = createRequire(path.join(root, 'package.json'))
await mkdir(output, { recursive: true })
const { handleRequest } = await import(pathToFileURL(path.join(root, 'packages/dingtalk-dsh-assistant/http.js')))
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const playwright = await import(values.playwright ? pathToFileURL(path.resolve(values.playwright)) : 'playwright')
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
assert.ok(values['react-dom'] || domDirectory, 'provide --react-dom matching the workspace React version')
const domRoot = values['react-dom'] || path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom')
assert.equal(JSON.parse(await readFile(path.join(domRoot, 'package.json'), 'utf8')).version, reactVersion)
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(domRoot, 'umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
const sent = '2026-10-25T23:59:00Z', done = '2026-10-26T00:01:00Z'
const messages = [
  ['topic-pending', '旧话题尚在处理', 'routed'], ['topic-done', '旧话题已经判断', 'routed'],
  ['semantic', '新来源语义完成尚未收束', 'routed'], ['source-pending', '新来源尚未判断', 'routed'],
  ['history', '历史状态缺失', 'routed'], ['ignored', '纯忽略消息', 'routed'],
  ['negative', '时钟异常消息', 'routed'], ['failed', '明确归类失败', 'failed'], ['routing', '尚待归类', 'pending'],
].map(([messageId, text, routingStatus], i) => ({ messageId, text, routingStatus, messageVersion: 1, sequence: i + 1, sourceKind: 'dingtalk', occurredAt: sent, senderName: '合成发送人',
  ...(messageId === 'ignored' ? { ignoredRanges: [{ reason: '无需办理' }], agentDeliveryStatus: 'delivered', agentDeliveryAt: done } : {}) }))
const topic = (id, processed, completed) => ({ topicId: id, title: id, revision: 1, processedRevision: processed ? 1 : 0,
  entries: [{ messageId: id, messageVersion: 1, revision: 1, action: 'add' }], decisions: completed ? [{ decisionId: `decision-${id}`, status: 'completed', revision: 1, updatedAt: completed, decision: { reason: '已作语义判断' } }] : [] })
const topics = [topic('topic-pending', false), topic('topic-done', true, done), topic('negative', true, '2026-10-25T23:58:59Z')]
const group = { groupId: 'fixture-group', name: '收件箱隔离验收', messages, outbox: [] }
const sourceRows = [
  { sourceId: 'source-semantic', groupId: group.groupId, messageId: 'semantic', version: 1, channel: 'im', routed: false, processingCompleted: { at: done }, receivedAt: sent, notifications: [], stages: [{ spanId: 'fixture-turn-1', stage: 'turn', requestId: 'fixture-request', attempt: 2, startedAt: sent, completedAt: done, quality: 'observed', shared: true }] },
  { sourceId: 'source-pending', groupId: group.groupId, messageId: 'source-pending', version: 1, channel: 'im', routed: false, notifications: [] },
]
const runtime = { listRecoveryIssues: () => [], listGroups: () => [group], getGroup: () => group, listTopics: () => topics, listTaskView: () => [], listTasks: () => [], listAlerts: () => [],
  listAuthorizationRequests: () => [], messageProcessingSources: async () => sourceRows }
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>收件箱隔离验收</title><style>body{margin:0;font:14px "Microsoft YaHei",sans-serif}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const h=React.createElement, primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size})=>h('span',{'data-state':state}),Menu:({anchor,open,items,onSelect})=>h('span',null,anchor,open?h('div',{role:'menu'},items.map(item=>h('button',{key:item.id,role:'menuitem',onClick:()=>onSelect(item.id)},item.label))):null)};
for(const name of ['IconChecklistOutlineRegular','IconChevronDownOutlineRegular','IconChevronUpOutlineRegular'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true});
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='main.conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},uiWorkspace:{openSession(){}},sessions:{subagentAddress(){},async refreshProjections(){},async refreshSubagents(){},async refresh(){},open(){}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => {
  if (request.url.startsWith('/state/') || request.url === '/health') return void handleRequest(request, response, runtime).catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: error.message })) })
  response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8')
  response.end(request.url === '/' ? html : routes.get(request.url) ?? '')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`, browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], writes = [], checks = []
let failure
page.on('pageerror', error => errors.push(error.message))
await context.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (route.request().method() !== 'GET') { writes.push(target.pathname); return route.abort() }
  const response = await fetch(url + target.pathname + target.search)
  return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
})
const row = text => page.getByRole('row').filter({ hasText: text })
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await row('旧话题尚在处理').waitFor()
  if (values.baseline) {
    assert.match(await row('旧话题尚在处理').innerText(), /已处理/)
    assert.match(await row('新来源尚未判断').innerText(), /已处理/)
    checks.push('baseline-reproduces-false-processed-without-topics')
  } else {
    assert.match(await row('旧话题尚在处理').innerText(), /处理中/)
    assert.match(await row('新来源尚未判断').innerText(), /处理中/)
    assert.match(await row('历史状态缺失').innerText(), /未知/)
    assert.match(await row('历史状态缺失').innerText(), /处理状态未记录/); assert.doesNotMatch(await row('历史状态缺失').innerText(), /尚未处理完成|待归类/)
    assert.match(await row('时钟异常消息').innerText(), /异常/)
    assert.match(await row('新来源语义完成尚未收束').innerText(), /已处理|语义完成/)
    assert.match(await row('旧话题已经判断').innerText(), /2 分 0 秒/)
    assert.match(await row('纯忽略消息').innerText(), /无需办理/)
    checks.push('api-backed-topic-source-ignore-unknown-negative-and-cross-midnight')
    const details = row('新来源语义完成尚未收束').locator('details').filter({ hasText: '计时' }).first()
    await details.locator('summary').click()
    assert.match(await details.innerText(), /来源.*未收束|收束.*未完成/)
    assert.match(await details.innerText(), /通知.*未记录|通知.*无/)
    assert.match(await details.innerText(), /原生回合（含模型\/工具）/); assert.match(await details.innerText(), /共享区间/); assert.match(await details.innerText(), /尝试 2/); assert.match(await details.innerText(), /请求 fixture-request/); assert.match(await details.innerText(), /未记录阶段/); checks.push('open-processing-facts-separates-settlement-and-notification')
    await details.locator('summary').focus(); await page.keyboard.press('Enter'); assert.equal(await details.evaluate(node => node.open), false)
    await page.keyboard.press('Enter'); assert.equal(await details.evaluate(node => node.open), true)
    await page.screenshot({ path: path.join(output, 'processing-details.png'), fullPage: true })
    checks.push('native-details-keyboard-toggle-and-stage-correlation')
    const filter = page.getByRole('button', { name: '筛选处理状态', exact: true })
    await filter.click(); await page.getByRole('menuitem', { name: '处理中', exact: true }).click()
    assert.equal(await row('旧话题已经判断').count(), 0)
    assert.equal(await row('旧话题尚在处理').count(), 1)
    await filter.click(); await page.getByRole('menuitem', { name: '状态未知', exact: true }).click()
    assert.equal(await row('历史状态缺失').count(), 1)
    assert.equal(await row('旧话题尚在处理').count(), 0)
    await filter.click(); await page.getByRole('menuitem', { name: '全部处理状态', exact: true }).click()
    checks.push('status-filter-uses-projected-state')
    await page.getByRole('button', { name: /^(刷新|已刷新)$/ }).click()
    await row('旧话题尚在处理').waitFor()
    assert.match(await row('旧话题尚在处理').innerText(), /处理中/)
    checks.push('refresh-does-not-invent-success')
  }
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true })
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
} catch (error) { failure = error.stack; await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}) }
finally {
  const result = { passed: !failure, mode: values.baseline ? 'baseline' : 'fixed', checks, browser: await browser.version(), sourceSha256: createHash('sha256').update(observer).digest('hex'), errors, writes, failure,
    boundary: 'Full observer + real React/ReactDOM + real HTTP handleRequest + synthetic runtime; host slots/primitives adapted. No production instance, models, database or channel writes.' }
  await writeFile(path.join(output, 'browser-result.json'), JSON.stringify(result, null, 2))
  await browser.close(); await new Promise(resolve => server.close(resolve))
  console.log(JSON.stringify(result, null, 2)); if (failure) process.exitCode = 1
}
