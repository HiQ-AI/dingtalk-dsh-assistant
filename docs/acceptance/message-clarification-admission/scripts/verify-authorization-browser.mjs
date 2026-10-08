import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.resolve(process.argv[3] ?? path.join(root, 'docs/acceptance/message-clarification-admission/round-1'))
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
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=7})=>h('span',{'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor,open,items,onSelect})=>h(React.Fragment,null,anchor,open?h('div',{role:'listbox'},...items.map(item=>h('button',{role:'option',key:item.id,onClick:()=>onSelect(item.id)},item.label))):null)};
for(const name of ['IconChecklistOutline14','IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,'aria-hidden':true},h('path',{d:'M3 5L7 9L11 5',fill:'none',stroke:'currentColor'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`


const messages = [
 ['waiting_authorization','等待授权','按文档开发'],
 ['waiting_clarification','等待用户补充','选择目标对象'],
 ['waiting_system','材料读取受阻','读取文档失败'],
].map(([workflowStatus,label,text],i)=>({messageId:`m${i}`,runId:`r${i}`,sequence:i+1,text,workflowStatus,senderName:'隔离用户',occurredAt:'2026-10-08T01:00:00Z',topicRefs:[]}))
const browser=await playwright.chromium.launch({channel:'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'})
const page=await context.newPage(),errors=[],writes=[],checks=[]
page.on('pageerror',e=>errors.push(e.message))
await page.route('**/*',async route=>{
 const target=new URL(route.request().url())
 if(target.origin===url)return route.continue()
 if(target.origin!=='http://127.0.0.1:18998')return route.abort()
 if(route.request().method()!=='GET'){writes.push(target.pathname);return route.abort()}
 let data=[]
 if(target.pathname==='/health')data={status:'ok'}
 if(target.pathname==='/state/groups')data=[{groupId:'g',name:'隔离群',messages,outbox:[]}]
 if(target.pathname==='/state/topics')data={topics:[],total:0}
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
})
try{
 await page.goto(url)
 await page.getByRole('button',{name:'钉钉群聊运行看板',exact:true}).click()
 for(const label of ['等待授权','等待用户补充','材料读取受阻'])await page.getByText(label,{exact:true}).waitFor()
 checks.push('three-distinct-status-labels')
 for(const [label,text] of [['等待授权','按文档开发'],['等待用户补充','选择目标对象'],['材料读取受阻','读取文档失败']]){
  await page.getByRole('button',{name:'筛选处理状态',exact:true}).click()
  await page.getByRole('option',{name:label,exact:true}).click()
  await page.getByText(text,{exact:true}).waitFor()
  for(const other of messages.filter(m=>m.text!==text))assert.equal(await page.getByText(other.text,{exact:true}).count(),0)
  checks.push('filter-'+label)
 }
 await page.screenshot({path:path.join(output,'authorization-desktop.png'),fullPage:true})
 await page.setViewportSize({width:390,height:844})
 await page.getByRole('button',{name:'筛选处理状态',exact:true}).focus()
 await page.keyboard.press('Enter')
 await page.getByRole('option',{name:'等待授权',exact:true}).focus()
 await page.keyboard.press('Enter')
 await page.getByText('按文档开发',{exact:true}).waitFor()
 checks.push('narrow-keyboard-filter')
 await page.screenshot({path:path.join(output,'authorization-narrow.png'),fullPage:true})
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
 await writeFile(path.join(output,'authorization-browser-results.json'),JSON.stringify({checks,errors,writes,observerSha256:createHash('sha256').update(observer).digest('hex'),boundary:'完整 Observer/React；宿主 Menu 使用语义替身；全部 API 隔离，只验证状态与筛选回调。'},null,2))
 console.log(JSON.stringify({checks:checks.length,errors,writes}))
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
