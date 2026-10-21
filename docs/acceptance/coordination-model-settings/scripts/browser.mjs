// Chromium, real React and the complete generated settings bundle/CSS; isolated HTTP fixtures only.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [playwrightPath,reactDomPath,outputDir]=process.argv.slice(2)
const {chromium}=await import(pathToFileURL(resolve(playwrightPath)))
const root=new URL('../../../../',import.meta.url)
const assets=await Promise.all(['node_modules/react/umd/react.development.js',reactDomPath,'packages/dingtalk-dsh-assistant/web-client.js'].map(path=>readFile(path.startsWith('/')?path:new URL(path,root),'utf8')))
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root"></div><script>${assets[0]}</script><script>${assets[1]}</script><script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:{IconRefreshOutline16:()=>null})}}</script><script>${assets[2]}</script><script>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(plugin.DingTalkDshAssistantCard))</script></html>`
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html)})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1200,height:1000}}), errors=[]
page.on('pageerror',e=>errors.push(e.message))
const selection=()=>({provider:'openai-codex',model:'gpt-6-astra',reasoningMode:'explicit',reasoningEffort:'low'})
let config={provider:'openai-codex',workspaceDir:'D:/synthetic-agent',agentNames:['测试助手'],replySignature:'',proxyUrl:'',model:'sol',reasoningEffort:'low',
 taskSessionModel:selection(),coordinationModel:selection(),coordinationEnabled:false}
const requests=[];let fail=false,partial=false,hold=false,held
await page.route('http://127.0.0.1:18998/**',async route=>{
 const url=new URL(route.request().url()),path=url.pathname
 if(path==='/state/groups'&&hold){held=route;return}
 let value={'/health':{status:'ok'},'/state/groups':[],'/state/tasks':[],'/state/supervisor/alerts':[],'/state/environment':{},'/state/version':{},'/state/agent-config':config}[path]??{}
 if(path==='/state/task-model-options')value={providers:[{id:'openai-codex',name:'Codex'},{id:'second',name:'Second'}],models:[{id:'gpt-6-astra',name:'Astra'},{id:'limited',name:'Limited'}],
   available:url.searchParams.get('model')!=='missing',reasoning:{efforts:(url.searchParams.get('model')==='limited'?['low']:['low','high']).map(id=>({id,name:id}))}}
 if(path==='/config/agent'){
   const body=route.request().postDataJSON();requests.push(body);await new Promise(done=>setTimeout(done,150))
   if(partial){config={...config,model:body.model,reasoningEffort:body.reasoningEffort};return route.fulfill({status:500,json:{error:'AGENT_CONFIG_SAVE_FAILED',readback:config}})}
   if(fail)return route.fulfill({status:500,json:{error:'AGENT_CONFIG_SAVE_FAILED',readback:config}})
   config={...config,...body};value=config
 }
 await route.fulfill({json:value})
})
try{
 await mkdir(outputDir,{recursive:true});await page.goto(`http://127.0.0.1:${server.address().port}`)
 const form=page.getByRole('form',{name:'Agent 配置'}),save=form.getByRole('button',{name:'保存配置',exact:true})
 await form.waitFor();await page.waitForTimeout(450)
 assert.equal(await form.getByText('推理深度',{exact:true}).count(),3)
 assert.equal(await form.getByRole('button',{name:'保存配置',exact:true}).count(),1)
 assert.equal(await page.locator('#coordination-model-id').inputValue(),'openai-codex/gpt-6-astra')
 assert.equal(await page.locator('#coordination-reasoning').inputValue(),'low')
 const boxes=await Promise.all(['agent','task','coordination'].flatMap(p=>[`#${p}-model-id`,`#${p}-reasoning`]).map(s=>page.locator(s).boundingBox()))
 for(let i=0;i<3;i++){assert.equal(boxes[i*2].y,boxes[i*2+1].y);assert.equal(boxes[i*2].x,boxes[0].x);assert.equal(boxes[i*2+1].x,boxes[1].x)}
 assert.equal(await page.locator('#task-reasoning option[value="high"]').textContent(),await page.locator('#coordination-reasoning option[value="high"]').textContent())
 assert.deepEqual(await page.locator('#task-model-id-list option').evaluateAll(nodes=>nodes.map(n=>n.value)),await page.locator('#coordination-model-id-list option').evaluateAll(nodes=>nodes.map(n=>n.value)))
 hold=true;await page.getByRole('button',{name:'刷新',exact:true}).click();while(!held)await page.waitForTimeout(20)
 await page.locator('#coordination-reasoning').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter')
 await page.locator('#coordination-reasoning').selectOption('high');await save.click()
 assert.equal(await page.locator('#task-model-id').isDisabled(),true);assert.equal(await page.locator('#coordination-model-id').isDisabled(),true)
 await form.evaluate(n=>n.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 await page.getByText('Agent 配置已保存',{exact:false}).waitFor();hold=false;await held.fulfill({json:[]});await page.waitForTimeout(100)
 assert.equal(requests.length,1);assert.equal(config.coordinationEnabled,false);assert.equal(requests[0].coordinationEnabled,undefined)
 assert.equal(config.coordinationModel.reasoningEffort,'high');assert.equal(config.taskSessionModel.reasoningEffort,'low');assert.equal(config.reasoningEffort,'low')
 assert.equal(await page.locator('#coordination-reasoning').inputValue(),'high')
 await form.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(outputDir,'coordination-model-desktop.png'),fullPage:true})
 await page.reload();await form.waitFor();await page.waitForTimeout(450);assert.equal(await page.locator('#coordination-reasoning').inputValue(),'high')
 await page.locator('#coordination-model-id').fill('')
 assert.equal(await page.locator('#coordination-model-id').inputValue(),'')
 await page.locator('#coordination-model-id').pressSequentially('second/limited')
 assert.equal(await page.locator('#coordination-model-id').inputValue(),'second/limited')
 await page.waitForTimeout(450)
 assert.equal(await page.locator('#coordination-reasoning option[value="high"]').textContent(),'high（当前模型不支持）')
 assert.equal(await save.isDisabled(),true)
 await page.locator('#coordination-reasoning').selectOption('model-default');fail=true;await save.click()
 await page.getByRole('alert').filter({hasText:'保存未全部完成'}).waitFor()
 assert.equal(await page.locator('#coordination-model-id').inputValue(),'second/limited')
 fail=false;partial=true;await page.locator('#agent-reasoning').selectOption('high');await save.click()
 await page.getByRole('alert').filter({hasText:'默认模型：已生效；插件设置（含统筹和协调）：未全部生效'}).waitFor()
 assert.equal(config.coordinationModel.provider,'openai-codex');assert.equal(requests.at(-1).coordinationModel.provider,'second')
 await page.setViewportSize({width:390,height:844});await form.scrollIntoViewIfNeeded()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.screenshot({path:resolve(outputDir,'coordination-model-error-narrow.png'),fullPage:true})
 const narrow=await Promise.all(['#coordination-model-id','#coordination-reasoning'].map(s=>page.locator(s).boundingBox()))
 assert.ok(narrow[1].y>narrow[0].y)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,requests:requests.length,checks:['three aligned rows','same choices and depth labels','keyboard native select','single save','no duplicate','save/refresh','stale refresh fenced','owner/executor unchanged','disabled remains disabled','provider/model parsing','unsupported blocked','partial failure/draft','390px no overflow','complete bundle CSS'],screenshots:['coordination-model-desktop.png','coordination-model-error-narrow.png']}))
}finally{await browser.close();await new Promise(done=>server.close(done))}
