// 独立 Chromium + 真实 React 和发布 bundle；配置 API 使用内存 fixture，不触碰本地运行任务。
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, reactDomPath, outputDir] = process.argv.slice(2)
assert.ok(playwrightPath && reactDomPath && outputDir, '参数：playwright/index.mjs react-dom/umd/react-dom.development.js 输出目录')
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)))
const root = new URL('../../../../', import.meta.url)
const assets = await Promise.all([
  readFile(new URL('node_modules/react/umd/react.development.js', root), 'utf8'),
  readFile(reactDomPath, 'utf8'),
  readFile(new URL('packages/dingtalk-dsh-assistant/web-client.js', root), 'utf8'),
])
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}#root{max-width:760px;margin:auto}</style><div id="root"></div>
<script>${assets[0]}</script><script>${assets[1]}</script>
<script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:{IconRefreshOutline16:()=>null})}}</script>
<script>${assets[2]}</script><script>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(plugin.DingTalkDshAssistantCard))</script>`
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let config={workspaceDir:'D:/fixture',agentNames:['百部'],model:'sol',reasoningEffort:'low',proxyUrl:'',taskSessionModel:{provider:'openai-codex',model:'gpt-6-astra',reasoningMode:'explicit',reasoningEffort:'low'}}
let failSave=false,partialSave=false,writes=0,holdGroups=false,heldGroup
await page.route('http://127.0.0.1:18998/**',async route=>{
 const path=new URL(route.request().url()).pathname
 if(path==='/state/groups'&&holdGroups){heldGroup=route;return}
 let value={'/health':{status:'ok'},'/state/groups':[],'/state/tasks':[],'/state/supervisor/alerts':[],'/state/environment':{},'/state/version':{},'/state/agent-config':config}[path]??{}
 if(path==='/state/task-model-options')value={providers:[{id:'openai-codex',name:'Codex'}],models:[{id:'gpt-6-astra',name:'Astra'},{id:'limited',name:'Limited'}],available:true,reasoning:{efforts:(new URL(route.request().url()).searchParams.get('model')==='limited'?['low']:['low','high']).map(id=>({id,name:id}))}}
 if(path==='/config/agent'){writes++;await new Promise(done=>setTimeout(done,200));if(partialSave){const body=route.request().postDataJSON();config={...config,model:body.model,reasoningEffort:body.reasoningEffort};return route.fulfill({status:500,json:{error:'AGENT_CONFIG_SAVE_FAILED',readback:config}})};if(failSave)return route.fulfill({status:400,json:{error:'UNSUPPORTED_REASONING_EFFORT'}});config={...config,...route.request().postDataJSON()};value=config}
 await route.fulfill({json:value})
})
try{
 await mkdir(outputDir,{recursive:true})
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 const form=page.getByRole('form',{name:'Agent 配置'})
 await form.waitFor()
 assert.equal(await page.locator('#task-reasoning').inputValue(),'low')
 assert.equal(await form.getByRole('button',{name:'保存配置',exact:true}).count(),1)
 assert.equal(await form.getByText('推理深度',{exact:true}).count(),2)
 assert.match(await form.textContent(),/Agent 配置/)
 const desktopBoxes=await Promise.all(['#agent-model-id','#agent-reasoning','#task-model-id','#task-reasoning'].map(selector=>page.locator(selector).boundingBox()))
 if(page.viewportSize().width>720){
  assert.equal(desktopBoxes[0].y,desktopBoxes[1].y)
  assert.equal(desktopBoxes[2].y,desktopBoxes[3].y)
  assert.equal(desktopBoxes[0].x,desktopBoxes[2].x)
  assert.equal(desktopBoxes[1].x,desktopBoxes[3].x)
 }
 await page.waitForFunction(()=>document.querySelectorAll('#agent-model-id-list option').length>0)
 assert.deepEqual(await page.locator('#agent-model-id-list option').evaluateAll(nodes=>nodes.map(n=>n.value)),await page.locator('#task-model-id-list option').evaluateAll(nodes=>nodes.map(n=>n.value)))
 assert.equal(await page.locator('#agent-reasoning option[value="high"]').textContent(),await page.locator('#task-reasoning option[value="high"]').textContent())
 holdGroups=true;await page.getByRole('button',{name:'刷新',exact:true}).click()
 while(!heldGroup)await page.waitForTimeout(20)
 await page.locator('#task-reasoning').selectOption('high')
 await page.getByRole('button',{name:'保存配置',exact:true}).click()
 assert.equal(await page.locator('#agent-model-id').isDisabled(),true)
 assert.equal(await page.locator('#dingtalk-agent-reply-signature').isDisabled(),true)
 await form.evaluate(node=>node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 await page.getByText('Agent 配置已保存',{exact:false}).waitFor()
 holdGroups=false;await heldGroup.fulfill({json:[]});await page.waitForTimeout(150)
 assert.equal(await page.locator('#task-reasoning').inputValue(),'high','old refresh cannot overwrite saved config')
 assert.equal(config.taskSessionModel.reasoningEffort,'high');assert.equal(config.reasoningEffort,'low');assert.equal(writes,1)
 await form.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(outputDir,'saved-desktop.png'),fullPage:true})
 await page.reload();await form.waitFor();assert.equal(await page.locator('#task-reasoning').inputValue(),'high')
 await page.locator('#task-model-id').fill('limited')
 await page.waitForTimeout(500)
 assert.equal(await page.locator('#task-reasoning option[value="high"]').textContent(),'high（当前模型不支持）')
 await page.locator('#task-reasoning').selectOption('model-default');failSave=true
 await page.getByRole('button',{name:'保存配置',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'保存未全部完成'}).waitFor()
 assert.equal(await page.locator('#task-model-id').inputValue(),'limited')
 failSave=false;partialSave=true
 await page.locator('#agent-reasoning').selectOption('high')
 await page.getByRole('button',{name:'保存配置',exact:true}).click()
 await page.getByRole('alert').filter({hasText:'默认模型：已生效；插件设置（含统筹）：未全部生效'}).waitFor()
 assert.equal(await page.locator('#task-model-id').inputValue(),'limited')
 await page.setViewportSize({width:390,height:844});await form.scrollIntoViewIfNeeded()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.screenshot({path:resolve(outputDir,'error-narrow.png'),fullPage:true})
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,writes,checks:['save','refresh','execution unchanged','capability linkage','failure retains draft','narrow no overflow','real bundle CSS'],screenshots:['saved-desktop.png','error-narrow.png']}))
}finally{await browser.close();await new Promise(done=>server.close(done))}
