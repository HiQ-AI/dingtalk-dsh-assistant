import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {executionError} from './execution-artifacts.js'
const fail=code=>{throw executionError(code)}
const origin='https://editor2.hiqdat.dev'
export function validateBrowserResource(r){
 if(r.kind!=='uat-review-observation'||!r.id||!['editor_uat_admin','editor_uat_sunpeng'].includes(r.accountKey)||!['accountsFile','playwrightModule','evidenceDirectory'].every(k=>isAbsolute(r[k]??'')))fail('QUERY_BROWSER_CONFIG_INVALID')
}
/** 只读路由来自现有 UAT 审核页面 API；登录/退出仅由 Host 请求。 */
export function browserObservationRequestAllowed(value,method,type,body){
 let u;try{u=new URL(value)}catch{return false}
 if(u.origin!==origin||u.username||u.password||/%2f|%5c|\.\./i.test(u.pathname))return false
 if(method==='GET'&&u.pathname==='/app-config.json')return !u.search
 if(method==='POST'&&u.pathname==='/api/dataset/dictionary/getMenusListByMenuCodes')return !u.search&&Array.isArray(body)&&body.length<=50&&body.every(x=>typeof x==='string'&&x.length<100)
 if(method==='GET'&&['/api/dataset/approval/reviewers','/api/dataset/approval/reviewTemplate'].includes(u.pathname))return !u.search
 if(method==='GET'&&u.pathname==='/api/sso/user/info/current')return u.searchParams.get('productCode')==='hiq_editor'&&[...u.searchParams.keys()].every(k=>k==='productCode')
 if(method==='POST'&&['/api/dataset/approval/list','/api/dataset/message/list'].includes(u.pathname))return !u.search&&body&&typeof body==='object'&&!Array.isArray(body)&&JSON.stringify(body).length<4096
 if(method==='GET'&&['/api/dataset/enum/process/common','/api/dataset/datasourceInfo/getTenantDatasource','/api/dataset/system/log/getSystemModule','/api/dataset/system/log/getSystemFunction'].includes(u.pathname))return !u.search
 if(u.pathname.startsWith('/api/')||u.pathname.includes('/sockjs'))return false
 if(method==='HEAD')return u.pathname==='/'&&/^\?cv=0\.\d+$/.test(u.search)
 return method==='GET'&&['document','script','stylesheet','image','font','manifest'].includes(type)
}
export async function readBrowserResource(r,{signal,loadBrowser=async path=>(await import(pathToFileURL(path).href)).chromium,fetchImpl=fetch}={}){
 validateBrowserResource(r);signal?.throwIfAborted()
 const directory=join(r.evidenceDirectory,randomUUID());await mkdir(directory,{recursive:true})
 const result={origin,accountKey:r.accountKey,observedAt:new Date().toISOString(),businessWrites:0,businessFlowReproduced:false,blockedRequests:[],failedReads:[],pages:[]}
 let session,browser
 const request=async(path,body)=>{const response=await fetchImpl(origin+path,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Site':'101',...(session?{Authorization:session.accessToken,accessToken:session.accessToken,userId:String(session.userId),Cookie:`accessToken=${session.accessToken}`}:{})},body:JSON.stringify(body)});let data;try{data=await response.json()}catch{fail('QUERY_BROWSER_RESPONSE_INVALID')}if(!response.ok||!['200','0'].includes(String(data?.code)))fail('QUERY_BROWSER_LOGIN_FAILED');return data.data}
 try{
  const account=JSON.parse(await readFile(r.accountsFile,'utf8')).accounts?.[r.accountKey]
  if(!account?.username||!account.password)fail('QUERY_BROWSER_ACCOUNT_MISSING')
  session=await request('/api/sso/auth/login',{username:account.username,password:account.password,grantType:'PASSWORD'})
  if(!session?.accessToken||!session.userId)fail('QUERY_BROWSER_LOGIN_FAILED')
  const chromium=await loadBrowser(r.playwrightModule);browser=await chromium.launch({channel:'msedge',headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',serviceWorkers:'block',acceptDownloads:false})
  await context.addCookies([{name:'user',value:encodeURIComponent(JSON.stringify(session)),url:origin,sameSite:'Lax'},{name:'accessToken',value:session.accessToken,url:origin,sameSite:'Lax'}])
  await context.route('**/*',async route=>{const req=route.request();let body;try{body=req.postData()===null?undefined:req.postDataJSON()}catch{body=null}if(browserObservationRequestAllowed(req.url(),req.method(),req.resourceType(),body))return route.continue();const u=new URL(req.url());if(result.blockedRequests.length<100)result.blockedRequests.push({method:req.method(),origin:u.origin,path:u.pathname});return route.abort()})
  await context.routeWebSocket('**/*',socket=>socket.close())
  const page=await context.newPage()
  page.on('response',response=>{const u=new URL(response.url());if(u.origin===origin&&response.status()>=400&&result.failedReads.length<50)result.failedReads.push({path:u.pathname,status:response.status()})})
  await page.goto(origin+'/audit/dataset/received?tab=0',{waitUntil:'networkidle',timeout:45000})
  if(new URL(page.url()).pathname.includes('login'))fail('QUERY_BROWSER_LOGIN_FAILED')
  for(const state of ['initial','toggled']){
   if(state==='toggled'){const toggle=page.locator('.expand-collapse-icon');if(await toggle.count()!==1)break;await toggle.click();await page.waitForTimeout(350)}
   const layout=await page.evaluate(()=>{const nav=document.querySelector('.nav-container');const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return {path:location.pathname,nav:nav?{className:nav.className,...box(nav)}:null,items:[...document.querySelectorAll('.nav-scroll > *, .nav-scroll-inner > *')].map(e=>({text:e.textContent.trim().slice(0,120),...box(e)})),horizontalOverflow:document.documentElement.scrollWidth>innerWidth}})
   if(!layout.nav)fail('QUERY_BROWSER_PAGE_INCOMPLETE')
   const screenshot=await page.screenshot({fullPage:false});const path=join(directory,`${state}.png`);await writeFile(path,screenshot)
   result.pages.push({state,...layout,screenshot:{path,sha256:createHash('sha256').update(screenshot).digest('hex')}})
  }
  const messages=await request('/api/dataset/message/list',{messageType:'APPROVAL',pageNum:1,pageSize:100})
  if(!Array.isArray(messages)||messages.length>100||messages.some(x=>!x||typeof x.id!=='string'||typeof x.msgType!=='string'||typeof x.sendTime!=='string'||typeof x.isRead!=='boolean'))fail('QUERY_BROWSER_RESPONSE_INVALID')
  result.messages={userId:String(session.userId),messageType:'APPROVAL',pageNum:1,pageSize:100,items:messages.map(({id,msgType,sendTime,isRead})=>({id,msgType,sendTime,isRead}))}
  result.authenticated=true
 }catch(error){fail(error.code?.startsWith('QUERY_')?error.code:signal?.aborted?'QUERY_CANCELLED':error.name==='TimeoutError'?'QUERY_BROWSER_TIMEOUT':'QUERY_BROWSER_UNAVAILABLE')}
 finally{try{if(browser)await browser.close()}finally{if(session)await request('/api/sso/auth/logout',{})}}
 await writeFile(join(directory,'observation.json'),JSON.stringify(result,null,2))
 return result
}
