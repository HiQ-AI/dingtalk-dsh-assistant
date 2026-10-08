import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateBrowserResource,browserObservationRequestAllowed as allowed,readBrowserResource} from '../packages/dingtalk-dsh-assistant/agent-query-browser.js'
import {createAgentStatusReadCapability} from '../packages/dingtalk-dsh-assistant/agent-query-status.js'
const origin='https://editor2.hiqdat.dev'
test('UAT2观察仅已知读请求，撤回/保存/消息已读/跨站和编码绕过均拦截',()=>{
 assert.equal(allowed(origin+'/api/dataset/approval/list','POST','xhr',{page:1,size:10}),true)
 assert.equal(allowed(origin+'/api/dataset/message/list','POST','xhr',{pageNum:1,pageSize:1}),true)
 assert.equal(allowed(origin+'/app-config.json','GET','fetch'),true)
 for(const path of ['/api/dataset/approval/withdraw','/api/dataset/message/read','/api/dataset/message/readAll','/api/dataset/approval/assign','/api/dataset/processDraft/save','/api/sso/auth/login'])assert.equal(allowed(origin+path,'POST','xhr',{}),false)
 assert.equal(allowed('https://editor.hiqlcd.com/api/dataset/approval/list','POST','xhr',{}),false)
 assert.equal(allowed(origin+'/api%2fdataset/approval/list','GET','document'),false)
})
test('登记资源与既有statusIds权限一致，模型不能注入账号/URL',async()=>{
 const r={id:'browser',kind:'uat-review-observation',accountKey:'editor_uat_admin',accountsFile:'D:/trusted/accounts.json',playwrightModule:'D:/trusted/index.mjs',evidenceDirectory:'D:/trusted/proofs'}
 assert.doesNotThrow(()=>validateBrowserResource(r));assert.throws(()=>validateBrowserResource({...r,accountKey:'arbitrary'}),{code:'QUERY_BROWSER_CONFIG_INVALID'})
 const c=createAgentStatusReadCapability({resources:[r]});assert.equal(await c.authorize({input:{resourceId:r.id},scope:{statusIds:[]}}),false)
 await assert.rejects(c.execute({input:{resourceId:r.id},scope:{statusIds:[]}}),{code:'QUERY_SCOPE_DENIED'})
 assert.deepEqual(Object.keys(c.parameters.properties),['resourceId'])
})
test('独立浏览器两种菜单取证并关闭退出，证据不含登录凭据；失败也清理',async()=>{
 const root=await mkdtemp(join(tmpdir(),'browser-observation-')),accountsFile=join(root,'accounts.json');await writeFile(accountsFile,JSON.stringify({accounts:{editor_uat_admin:{username:'u',password:'SECRET_PASSWORD'}}}))
 const r={id:'browser',kind:'uat-review-observation',accountKey:'editor_uat_admin',accountsFile,playwrightModule:join(root,'index.mjs'),evidenceDirectory:root}
 for(const broken of [false,true]){
  let closed=0,logout=0,routed=0,websocket=0
  const page={on:()=>{},goto:async()=>{if(broken)throw Error('SECRET_PASSWORD')},url:()=>origin+'/audit/dataset/received',locator:()=>({count:async()=>1,click:async()=>{}}),waitForTimeout:async()=>{},evaluate:async()=>({path:'/audit/dataset/received',nav:{width:100},items:[]}),screenshot:async()=>Buffer.from('PNG')}
  const loadBrowser=async()=>({launch:async options=>{assert.equal(options.headless,true);return{newContext:async options=>{assert.equal(options.serviceWorkers,'block');return{addCookies:async()=>{},route:async()=>routed++,routeWebSocket:async()=>websocket++,newPage:async()=>page}},close:async()=>closed++}}})
  const fetchImpl=async(url,options)=>{assert.equal(options.redirect,'error');if(url.endsWith('/message/list')){assert.deepEqual(JSON.parse(options.body),{messageType:'APPROVAL',pageNum:1,pageSize:100});return new Response(JSON.stringify({code:200,data:[{id:'message-1',msgType:'APPROVAL',sendTime:'2026-10-08 21:04:54',isRead:false,body:'UNRELATED_PRIVATE_TEXT'}]}))}if(url.endsWith('/logout'))logout++;return new Response(JSON.stringify({code:200,data:{accessToken:'SECRET_TOKEN',userId:'u'}}))}
  if(broken)await assert.rejects(readBrowserResource(r,{loadBrowser,fetchImpl}),e=>e.code==='QUERY_BROWSER_UNAVAILABLE'&&!e.message.includes('SECRET'))
  else{const output=await readBrowserResource(r,{loadBrowser,fetchImpl});assert.deepEqual(output.messages,{userId:'u',messageType:'APPROVAL',pageNum:1,pageSize:100,items:[{id:'message-1',msgType:'APPROVAL',sendTime:'2026-10-08 21:04:54',isRead:false}]});assert.equal(JSON.stringify(output).includes('UNRELATED_PRIVATE_TEXT'),false);assert.equal(output.businessWrites,0);assert.equal(output.pages.length,2);assert.equal(JSON.stringify(output).includes('SECRET'),false);assert.equal((await readFile(output.pages[0].screenshot.path)).toString(),'PNG')}
  assert.equal(closed,1);assert.equal(logout,1);assert.equal(routed,1);assert.equal(websocket,1)
 }
})
