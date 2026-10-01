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
const output = path.resolve(process.argv[3] ?? path.join(root, 'docs/acceptance/message-processing-20260930/round-2'))
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], writes = [], checks = []
page.setDefaultTimeout(7000)
page.on('pageerror', error => errors.push(error.message))
const messages = [
 {messageId:'m1',runId:'r1',sequence:1,text:'核对资料',workflowStatus:'waiting_context',waiting:[{responsibility:'host',reason:'读取原表格',recoveryCondition:'取得并核验所需材料后继续'}],notifications:[]},
 {messageId:'m2',runId:'r2',sequence:2,text:'生成修复脚本',workflowStatus:'waiting_system',waiting:[{unitId:'u2',goalText:'核对原表格',responsibility:'system',reason:'文件读取失败',recoveryCondition:'恢复文件读取后继续'}],notifications:[{notificationId:'n',status:'unknown'}]},
 {messageId:'m3',runId:'r3',sequence:3,text:'独立查表已完成',workflowStatus:'processed',waiting:[],notifications:[{notificationId:'n3',status:'delivered'}]},
 {messageId:'m4',runId:'r4',sequence:4,text:'等待核对新条件',workflowStatus:'waiting_routing_barrier',waiting:[{responsibility:'host',reason:'核对补充约束',recoveryCondition:'纳入当前要求后继续'}],blockingSources:[{runId:'related',text:'先测试两条，验证后再执行'}],notifications:[{notificationId:'n4',status:'acknowledged'}]},
 {messageId:'m5',runId:'r5',sequence:5,text:'缺少业务目标',workflowStatus:'waiting_clarification',waiting:[{responsibility:'requester',reason:'请说明目标',recoveryCondition:'收到有效补充后继续'}],notifications:[]}
].map(m=>({...m,occurredAt:'2026-09-30T10:00:00Z',topicRefs:[]}))
let empty=false
await page.route('**/*', async route => {
 const target=new URL(route.request().url()); if(target.origin===url)return route.continue()
 if(target.origin!=='http://127.0.0.1:18998')return route.abort()
 if(route.request().method()!=='GET'){writes.push(target.pathname);return route.abort()}
 let data=[]
 if(target.pathname==='/state/groups')data=[{groupId:'g',name:'隔离验证群',messages:empty?[]:messages,outbox:[]}]
 else if(target.pathname==='/health')data={status:'ok'}
 else if(target.pathname==='/config')data={groupIds:['g']}
 return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)})
})
try{
 await page.goto(url);await page.getByRole('button',{name:'钉钉群聊运行看板',exact:true}).click()
 for(const label of ['正在读取材料','材料读取受阻','等待用户补充','核对相关输入'])await page.getByText(label,{exact:true}).first().waitFor()
 const summaries=page.locator('summary').filter({hasText:'等待与通知'})
 assert.equal(await summaries.count(),5)
 for(let i=0;i<5;i++){await summaries.nth(i).focus();await page.keyboard.press('Enter')}
 await page.getByText('相关来源：先测试两条，验证后再执行',{exact:true}).waitFor()
 await page.getByText('通知：已确认发送，待回读',{exact:true}).waitFor()
 await page.getByText('通知：发送结果待核对',{exact:true}).waitFor()
 await page.getByText('通知：已回读送达',{exact:true}).waitFor()
 await page.getByText(/事项：核对原表格；系统维护人员排查/).waitFor()
 checks.push('waiting-responsibilities','scope-source','ack-vs-readback','keyboard-disclosure')
 await page.screenshot({path:path.join(output,'observer-waits-desktop.png'),fullPage:true})
 await page.setViewportSize({width:390,height:844})
 await page.getByText('通知：发送结果待核对',{exact:true}).scrollIntoViewIfNeeded()
 await page.screenshot({path:path.join(output,'observer-waits-narrow.png'),fullPage:true})
 checks.push('narrow-viewport','reduced-motion')
 empty=true;await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.waitForFunction(()=>!document.body.textContent.includes('独立查表已完成'))
 checks.push('empty-refresh')
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
 const result={checks,errors,writes,observerSha256:createHash('sha256').update(observer).digest('hex')}
 await writeFile(path.join(output,'observer-waits-checks.json'),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve))}
