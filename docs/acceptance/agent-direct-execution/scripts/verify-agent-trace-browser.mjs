import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.join(root, 'docs/tmp/agent-trace-browser')
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

const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], reads = [], checks = []
let failRead = false, emptyRead = false, traceStatus = 'succeeded', failSubmit = true
const submissions = []
const clarification = { runId: 'message-test', requestId: 'question-1', question: '需要检查哪个环境？', canAnswer: true }
const trace = () => ({ runId: 'message-test', status: 'settled', message: { text: '请排查项目接口为何返回空数据。' }, total: 1, nextCursor: null,
  items: [{ id: 'agent:1', kind: 'agent', status: traceStatus, sessionId: 'answer-session', createdAt: '2026-09-27T10:00:00Z', startedAt: '2026-09-27T10:00:00Z', completedAt: '2026-09-27T11:02:03Z',
    clarification: traceStatus === 'waiting_user' ? clarification : null, outputRef: 'result-ref', evidenceCount: 1, summary: { title: '查询与答复', conclusion: traceStatus === 'waiting_user' ? '等待必要补充' : '答复已生成，送达情况见发信箱', rows: [{ label: '答复摘要', value: '已读取接口代码与状态信息，当前证据不足以确认历史故障原因。' }] } }] })
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
 const target = new URL(route.request().url())
 if (target.origin === url) return route.continue()
 if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
 if (route.request().method() === 'POST' && /\/workflows\/(message-test|execution-investigation)\/requests\/question-1\/answer$/.test(target.pathname)) {
   submissions.push({ path: target.pathname, ...route.request().postDataJSON() })
   await new Promise(resolve => setTimeout(resolve, 250))
   return route.fulfill({ status: failSubmit ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failSubmit ? { error: 'fixture failure' } : { accepted: true }) })
 }
 if (route.request().method() !== 'GET') return route.abort()
 let data = []
 if (target.pathname === '/state/tasks') data = [{ taskId: 'investigation', engine: 'workflow-v2', title: '调查接口异常', objective: '检查接口', state: 'waiting', groupId: 'g', createdAt: '2026-09-27T10:00:00Z', updatedAt: '2026-09-27T10:00:00Z', executionNodes: [], plan: { stages: [] }, investigationRequest: { ...clarification, runId: 'execution-investigation' } }]
 if (target.pathname === '/health') data = { status: 'ok' }
 if (target.pathname === '/state/groups') data = [{ groupId: 'g', name: '隔离验收群', messages: [{ messageId: 'm', runId: 'message-test', text: '请排查项目接口为何返回空数据。', senderName: '测试成员', receivedAt: '2026-09-27T10:00:00Z', workflowStatus: 'processed' }], outbox: [] }]
 if (target.pathname.endsWith('/trace')) data = trace()
 if (target.pathname.includes('/evidence/')) {
   reads.push(target.pathname)
   await new Promise(resolve => setTimeout(resolve, 200))
   if (failRead) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture failure' }) })
   data = target.pathname.endsWith('/result-ref') ? { text: '答复正文：当前接口配置正常，历史调用参数未保留。', hash: 'hash', nextCursor: null, evidenceRefs: ['evidence-ref'] }
     : { text: '来源：项目版本 a1b2c3\n读取结果：当前接口状态正常。', hash: 'evidence-hash', nextCursor: null }
   if (emptyRead) data = { text: '', hash: 'empty', nextCursor: null }
 }
 return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
try {
 await page.goto(url)
 await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
 await page.getByRole('button', { name: '群消息', exact: true }).click()
 await page.getByRole('button', { name: '处理过程', exact: true }).click()
 await page.getByText('查询与答复', { exact: true }).waitFor()
 assert.equal(reads.length, 0)
 await page.getByText('耗时 1 小时 2 分 3 秒', { exact: true }).waitFor()
 const open = page.getByRole('button', { name: '查看答复与依据（1 条）', exact: true })
 await open.focus(); await page.keyboard.press('Enter')
 await page.getByRole('status').filter({ hasText: '正在读取产出' }).waitFor()
 await page.getByText('答复正文：当前接口配置正常，历史调用参数未保留。', { exact: true }).waitFor()
 assert.equal(reads.length, 1)
 await page.getByRole('button', { name: '查看依据 1', exact: true }).click()
 await page.getByText('来源：项目版本 a1b2c3', { exact: false }).waitFor()
 assert.equal(reads.length, 2)
 checks.push('no-eager-artifact-reads', 'keyboard-open', 'hours-format', 'on-demand-evidence')
 await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
 await page.setViewportSize({ width: 390, height: 844 })
 const overflow = await page.getByRole('region', { name: '消息处理过程' }).evaluate(el => el.scrollWidth > el.clientWidth + 2)
 assert.equal(overflow, false)
 await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true })
 await page.getByRole('button', { name: '收起产出', exact: true }).first().click()
 failRead = true
 await page.getByRole('button', { name: '查看答复与依据（1 条）', exact: true }).click()
 await page.getByRole('alert').filter({ hasText: '产出暂时无法读取' }).waitFor()
 failRead = false; await page.getByRole('button', { name: '重试', exact: true }).click()
 await page.getByText('答复正文：当前接口配置正常，历史调用参数未保留。', { exact: true }).waitFor()
 checks.push('narrow-no-overflow', 'read-error-retry', 'loading-state')
 await page.getByRole('button', { name: '收起产出', exact: true }).first().click()
 emptyRead = true
 await page.getByRole('button', { name: '查看答复与依据（1 条）', exact: true }).click()
 await page.getByText('未记录正文。', { exact: true }).waitFor()
 checks.push('empty-output-state')
 traceStatus = 'waiting_user'; await page.getByRole('button', { name: '刷新处理记录', exact: true }).click()
 await page.getByText('待补充', { exact: true }).waitFor()
 await page.getByRole('button', { name: '提交补充并继续', exact: true }).click()
 await page.getByText('请填写需要补充的信息。', { exact: true }).waitFor()
 assert.equal(submissions.length, 0)
 await page.getByRole('textbox', { name: '补充信息', exact: true }).fill('UAT2')
 await page.getByRole('button', { name: '提交补充并继续', exact: true }).click()
 await page.getByRole('alert').filter({ hasText: '补充信息提交未确认' }).waitFor()
 assert.equal(await page.getByRole('textbox', { name: '补充信息', exact: true }).inputValue(), 'UAT2')
 failSubmit = false
 await page.getByRole('button', { name: '提交补充并继续', exact: true }).click()
 await page.waitForTimeout(500)
 assert.equal(submissions.length, 2); assert.equal(submissions[0].eventId, submissions[1].eventId)
 checks.push('clarification-empty-validation', 'clarification-draft-preserved', 'clarification-idempotent-retry')
 await page.getByRole('button', { name: '查看会话记录', exact: true }).click()
 assert.deepEqual(await page.evaluate(() => window.opened), ['answer-session'])
 await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
 await page.getByRole('button', { name: '任务看板', exact: true }).click()
 await page.getByText('调查接口异常', { exact: true }).click()
 await page.getByRole('textbox', { name: '补充信息', exact: true }).fill('UAT3')
 await page.getByRole('button', { name: '提交补充并继续', exact: true }).click()
 await page.waitForTimeout(500)
 assert.equal(submissions.at(-1).path, '/workflows/execution-investigation/requests/question-1/answer')
 assert.equal(submissions.at(-1).answer, 'UAT3')
 checks.push('task-native-investigation-clarification')
 assert.deepEqual(errors, [])
 checks.push('waiting-state', 'native-session-navigation')
 await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors, evidenceReads: reads }, null, 2))
 console.log(JSON.stringify({ passed: true, checks }))
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
