import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
test('看板待判恢复与范围确认交互', async t => {
  assert.ok(process.argv[2], '请提供本机 playwright/index.mjs 路径')
  const { chromium } = await import(pathToFileURL(path.resolve(process.argv[2])).href)
  const reactPath = require.resolve('react/package.json')
  assert.ok(process.argv[3], '请提供与本地 React 版本匹配的 react-dom UMD 路径')
  const scripts = {
    '/react.js': await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js')),
    '/react-dom.js': await readFile(process.argv[3]),
    '/observer.js': await readFile('packages/dingtalk-dsh-observer/web-client.js'),
  }
  const html = `<!doctype html><meta charset="utf-8"><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
  const h=React.createElement, primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:()=>h('span'),Menu:({anchor})=>anchor};
  for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',props);
  const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
  window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},layout:{selectPanel(){}},sessions:{subagentAddress(){},async refreshSubagents(){},async refresh(){},open(){}}})}};
  </script><script src="/observer.js"></script>`
  const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); res.end(req.url === '/' ? html : scripts[req.url] ?? '') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })
  const page = await browser.newPage(), writes = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  const message = { messageId: 'm', messageVersion: 2, sequence: 1, text: '停止相关任务', senderName: '请求人', processingState: 'needs_clarification', processingConclusion: '范围不明', routingHold: { messageVersion: 2, epoch: 3 } }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== 'http://127.0.0.1:18998') return route.abort()
    if (route.request().method() === 'POST') { writes.push(route.request().postDataJSON()); return route.fulfill({ json: { status: 'accepted' } }) }
    let data
    if (url.pathname === '/health') data = { status: 'ok' }
    else if (url.pathname === '/state/groups') data = [{ groupId: 'g', name: '测试群' }]
    else if (url.pathname === '/state/groups/g/messages') data = { items: [message], total: 1, offset: 0, revision: '1' }
    else if (url.pathname === '/state/groups/g/outbox') data = { items: [], total: 0, offset: 0, revision: '1' }
    else if (url.pathname === '/state/topics') data = { topics: [], total: 0 }
    else if (url.pathname === '/state/tasks' || url.pathname === '/state/supervisor/alerts' || url.pathname === '/state/authorizations') data = []
    else return route.abort()
    return route.fulfill({ json: data })
  })
  await page.goto(origin)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByText('待补充：范围不明').waitFor({ timeout: 5000 }).catch(async error => { console.error('页面文本:', await page.locator('body').innerText(), '页面错误:', errors); throw error })
  await page.getByRole('button', { name: '重新判断' }).click()
  await page.getByText('已请求重新判断；不代表处理完成。').waitFor()
  assert.deepEqual(writes[0], { messageVersion: 2, epoch: 3, resume: true })
  await page.getByText('声明完整影响范围').click()
  await page.getByLabel('全部受影响话题 ID').fill('topic-a\ntopic-b')
  assert.equal(await page.getByRole('button', { name: '确认范围' }).isDisabled(), true)
  await page.getByLabel('我确认这是全部受影响话题，其他话题不受影响').check()
  await page.getByRole('button', { name: '确认范围' }).click()
  await page.getByText('已声明范围；待判尚未完成。').waitFor()
  assert.deepEqual(writes[1], { messageVersion: 2, epoch: 3, scope: ['topic-a', 'topic-b'], confirmClosedScope: true })
  assert.deepEqual(errors, [])
})
