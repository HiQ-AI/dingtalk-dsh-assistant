import { describeMessageTraceItem } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.resolve(process.argv[3] ?? path.join(root, 'docs/acceptance/topic-context-completeness/round-1'))
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
tasks.push({ taskId: 'task-design', title: '核对租户权限并整理排查结论', objective: '核对租户 A 的权限配置，确认问题范围，整理处理建议。仅排查，不修改现有配置。', groupId: 'g', engine: 'workflow-v2', state: 'waiting', updatedAt: '2026-09-26T04:20:00Z', waitingReason: '排查结论已整理，等待确认是否继续检查关联角色。', result: '已核对当前租户与角色配置。\n\n排查结论\n租户配置完整；部分成员未关联预期角色，需要进一步确认角色分配规则。\n\n建议下一步\n核实成员的角色来源，再决定是否调整配置。当前尚未修改任何权限。', topicRefs: [], plan: { currentStageId: 'review', stages: [{ stageId: 'research', title: '权限排查', status: 'succeeded' }, { stageId: 'review', title: '确认后续范围', status: 'waiting_confirmation' }] }, executionNodes: [{ nodeId: 'read-files', title: '读取租户与角色配置', status: 'succeeded', outputRef: 'ref-1' }, { nodeId: 'analyze', title: '核对权限关联', status: 'succeeded', outputRef: 'ref-2' }, { nodeId: 'approval-gate', title: '确认后续检查范围', status: 'waiting', waitReason: { reference: '等待确认是否继续检查关联角色' } }, { nodeId: 'finalize', title: '整理最终处理建议', status: 'pending' }] })
Object.assign(tasks[1].executionNodes[0], { startedAt: '2026-09-26T00:00:00Z', completedAt: '2026-09-26T00:00:03.500Z' })
Object.assign(tasks[1].executionNodes[2], { startedAt: '2026-09-26T00:00:04Z', completedAt: '2026-09-26T00:00:06Z' })
for (const [index, node] of tasks[1].executionNodes.entries()) Object.assign(node, { runId: 'design-run', nodeRunId: `design-node-${index}` })
let outputFailures = 1
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
  if (target.pathname.includes('/nodes/') && target.pathname.endsWith('/output')) {
    const first = target.pathname.includes('design-node-0')
    if (!first && outputFailures-- > 0) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary' }) })
    const text = first ? '产出摘要\n已读取租户 A 的角色配置，范围覆盖 12 个角色与 86 名成员。\n\n发现\n租户基础配置完整，角色定义均可读取。\n成员名单已与当前角色关联记录对应。' : '产出摘要\n已核对成员与角色的关联关系。\n\n发现\n部分成员未关联预期角色，现有配置与反馈范围一致。\n\n限制与未确认事项\n尚未取得角色分配规则，暂不能判断该差异是否符合业务预期。'
    const cursor = Number(target.searchParams.get('cursor') || 0), end = first && !cursor ? 42 : text.length
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: text.slice(cursor, end), nextCursor: end < text.length ? end : null, totalLength: text.length }) })
  }
  if (target.pathname === '/health') data = { status: 'ok' }
  if (target.pathname === '/state/groups') data = [{ groupId: 'g', name: '隔离群', messages: [{ messageId: 'm', runId: 'msg-1', sequence: 1, text: '请检查记录', workflowStatus: 'processed', occurredAt: '2026-09-26T00:00:00Z', topicRefs: [] }], outbox: [] }]
  if (target.pathname === '/state/tasks') data = tasks
  if (target.pathname === '/state/topics') data = { topics, total: 2 }
  if (target.pathname.startsWith('/state/topics/topic-')) data = { topic: topics.find(item => target.pathname.endsWith(item.topicId)), messages: [], total: 0 }
  if (/\/state\/workflows\/msg-[12]\/trace/.test(target.pathname)) data = { runId: 'msg-1', revision: 1, reason: 'MESSAGE_CONTEXT_CAPACITY:IB:$:33000/32000', items: [{ id: 'n1', kind: 'intent', status: 'succeeded', input: { text: '完整输入' }, output: { kind: 'topic_intents', decisions: [{ intent: { actions: [{ intent: 'research', arguments: { objective: '核对租户权限' } }], constraints: ['仅排查，不修改'] } }] }, usage: null, sourceRunIds: ['msg-1'] }], nextCursor: null }
  if (/\/state\/workflows\/msg-[12]\/trace/.test(target.pathname)) {
    const currentId = target.pathname.includes('msg-2') ? 'msg-2' : 'msg-1'
    data.status = 'needs_attention'; data.message = { text: '请核对租户权限，仅排查，不修改。' }
    Object.assign(data.items[0], { topicTitle: '租户权限排查', startedAt: '2026-09-26T00:00:02Z', completedAt: '2026-09-26T00:00:05.500Z', sourceRunIds: ['msg-1', 'msg-2'], sourceMessages: [
      { runId: 'msg-1', senderName: '张三', occurredAt: '2026-09-26T00:00:00Z', text: '请核对租户权限', current: currentId === 'msg-1' },
      { runId: 'msg-2', senderName: '李四', occurredAt: '2026-09-26T00:00:01Z', text: '限定租户 A，先排查', current: currentId === 'msg-2' }] })
    data.items.unshift(
      { id: 's1', kind: 'split', status: 'succeeded', createdAt: '2026-09-26T00:00:00Z', output: { units: [{ goalText: '核对租户权限' }] } },
      { id: 'r1', kind: 'route', status: 'succeeded', createdAt: '2026-09-26T00:00:02Z', input: { candidates: [{ candidateId: 't1', title: '租户权限排查' }] }, output: { kind: 'binding', disposition: 'existing', candidateId: 't1', evidence: ['明确引用了原排查消息'] } })
    data.total = data.items.length
  }
  if (target.pathname.startsWith('/state/workflows/topics/')) {
    const slow = target.pathname.includes('topic-1')
    if (slow) { slowRequested(); await new Promise(resolve => setTimeout(resolve, 800)) }
    data = { topicId: slow ? 'topic-1' : 'topic-2', revision: 1, current: { text: slow ? '不应覆盖的旧上下文' : '当前有效上下文' }, facts: [], intentRuns: [{ intentRunId: target.searchParams.has('intentCursor') ? 'ib-older' : 'ib-1', carrierRunId: 'msg-1', status: 'succeeded', sourceRunIds: ['msg-1'] }], intentNextCursor: target.searchParams.has('intentCursor') ? null : 50, nextCursor: null }
  }
  if (target.pathname === '/state/tasks/task-1/runs') data = { taskId: 'task-1', taskOwner: { status: 'active', sessionId: 'reserved-owner', sessionBound: false }, runs: [{ runId: 'run-old', status: 'succeeded', nodes: [{ nodeId: 'analyze', label: '历史分析', status: 'succeeded', sessionId: 'node-history' }] }], nextCursor: null }
  if (target.pathname.endsWith('/trace')) data.items = data.items.map(({input,output,usage,...item})=>({...item,summary:describeMessageTraceItem({...item,input,output})}))
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '处理过程', exact: true }).click()
  await page.getByRole('region', { name: '消息处理过程' }).waitFor()
  await page.getByText('提出 1 项处理决定', { exact: true }).waitFor()
  await page.getByText('仅排查，不修改', { exact: true }).waitFor()
  await page.getByText('耗时 3.5 秒', { exact: true }).waitFor()
  await page.getByText(/本次判断覆盖 2 条消息/).waitFor()
  await page.getByText('拆分为 1 个事项', { exact: true }).waitFor()
  await page.getByText('租户权限排查', { exact: true }).waitFor()
  assert.equal(await page.getByRole('region',{name:'消息处理过程'}).locator('details,pre').count(),0)
  await page.getByText(/上下文容量受阻/).waitFor()
  checks.push('message-trace','no-technical-details','capacity-reason')
  await page.evaluate(() => document.querySelectorAll('*').forEach(element => { if (element.scrollTop) element.scrollTop = 0 }))
  await page.screenshot({ path: path.join(output, 'message-trace.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => document.querySelectorAll('*').forEach(element => { if (element.scrollTop) element.scrollTop = 0 }))
  await page.screenshot({ path: path.join(output, 'message-trace-narrow.png'), fullPage: true })
  assert.ok(await page.getByText('提出 1 项处理决定', { exact: true }).isVisible())
  const traceWidth=await page.getByRole('region',{name:'消息处理过程'}).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}))
  assert.ok(traceWidth.scroll<=traceWidth.width+1)
  checks.push('readable-conclusion','summary-only-render','narrow-trace-no-overflow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '查看这条消息的过程', exact: true }).click()
  await page.getByText(/李四.*当前查看的消息/).waitFor()
  assert.equal(await page.getByText('提出 1 项处理决定', { exact: true }).count(), 1)
  checks.push('step-duration','shared-batch-sources','switch-source-keeps-single-judgment')
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
  assert.equal(calls.filter(url => url.includes('/tasks/task-1/runs')).length, 0)
  await page.getByText('核对上下文', { exact: true }).waitFor()
  await page.getByText('暂无执行步骤记录', { exact: true }).waitFor()
  const history = page.locator('summary').filter({ hasText: '查看历史执行与会话' })
  await history.focus(); await page.keyboard.press('Enter')
  await page.getByText('任务负责人会话与历史执行', { exact: true }).waitFor()
  checks.push('task-business-overview', 'task-history-lazy-load')
  assert.equal(await page.getByRole('button', { name: '查看任务负责人会话' }).count(), 0)
  const run = page.locator('summary').filter({ hasText: /已完成/ })
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
  assert.equal(calls.some(path => path.endsWith('/output')), false)
  await page.getByRole('button', { name: '返回看板', exact: true }).click()
  await page.getByText('核对租户权限并整理排查结论', { exact: true }).click()
  const detail = page.getByRole('region', { name: '任务执行详情', exact: true })
  await detail.getByRole('heading', { name: '最新产出', exact: true }).waitFor()
  for (let number = 1; number <= 4; number++) assert.equal(await detail.getByLabel(`步骤 ${number}`, { exact: true }).innerText(), String(number).padStart(2, '0'))
  await detail.getByRole('button', { name: '重试读取产出' }).click()
  await detail.getByText('已核对成员与角色的关联关系。', { exact: false }).waitFor()
  await detail.getByRole('button', { name: '继续阅读产出' }).click()
  await detail.getByText('成员名单已与当前角色关联记录对应。', { exact: false }).waitFor()
  assert.equal(await detail.locator('[role="status"]').count(), 1)
  checks.push('step-output-default-visible', 'step-output-retry', 'step-output-read-more')
  assert.equal(await detail.locator('pre').count(), 0)
  await detail.getByText('耗时 3.5 秒', { exact: true }).waitFor()
  await detail.getByText('本次执行耗时 2.0 秒', { exact: true }).waitFor()
  await detail.getByText('耗时未记录', { exact: true }).waitFor()
  await detail.getByText('尚未开始', { exact: true }).waitFor()
  assert.equal(calls.includes('/state/task-timings'), false)
  checks.push('task-step-durations', 'task-step-waiting-time', 'task-step-missing-time', 'task-step-not-started', 'no-diagnostic-request')

  await page.setViewportSize({ width: 1440, height: 1000 })
  const firstStep = detail.locator('.observer-task-step').first()
  const headingBox = await firstStep.locator('.observer-task-step-heading').boundingBox()
  const timerBox = await firstStep.getByText('耗时 3.5 秒', { exact: true }).boundingBox()
  assert.ok(Math.abs(timerBox.x + timerBox.width - headingBox.x - headingBox.width) < 2)
  assert.ok(timerBox.y < headingBox.y + headingBox.height)
  assert.equal(await firstStep.evaluate(element => getComputedStyle(element, '::before').borderLeftWidth), '1px')
  assert.equal(await detail.getByRole('progressbar').getAttribute('aria-valuenow'), '2')
  checks.push('timeline-connector', 'step-heading-right-duration', 'step-count-progress')
  await page.evaluate(() => document.querySelectorAll('*').forEach(element => { if (element.scrollTop) element.scrollTop = 0 }))
  await page.screenshot({ path: path.join(output, 'task-detail-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(() => document.querySelectorAll('*').forEach(element => { if (element.scrollTop) element.scrollTop = 0 }))
  await page.screenshot({ path: path.join(output, 'task-detail-narrow.png'), fullPage: true })
  await detail.getByRole('heading', { name: '最新产出', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'task-result-narrow.png'), fullPage: true })
  checks.push('task-numbered-timeline', 'task-waiting-result-layout', 'task-narrow-no-overflow')
  Object.assign(tasks[1].executionNodes[3], { status: 'running', startedAt: new Date(Date.now() - 2000).toISOString(), leaseEpoch: 2 })
  await page.getByRole('button', { name: /刷新/ }).click()
  const runningTime = detail.getByText(/^已用时.*第 2 次处理/)
  await runningTime.waitFor()
  const previousTime = await runningTime.innerText()
  await page.waitForFunction(previous => [...document.querySelectorAll('span')].some(item => /^已用时.*第 2 次处理/.test(item.textContent) && item.textContent !== previous), previousTime)
  checks.push('task-step-running-timer')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
  const result = { passed: true, checks, screenshots: { message: 'message-trace.png', topic: 'topic-context.png', topicNarrow: 'topic-context-narrow.png', task: 'task-detail-desktop.png', taskNarrow: 'task-detail-narrow.png' }, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), errors, writes, apiCalls: calls.length, boundary: '真实React与完整observer代码；隔离临时server，API全部由Playwright拦截，未访问真实18998；DSH primitives为语义替身。' }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
