import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {stripVTControlCharacters} from 'node:util'
import {chromium} from 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const get=async path=>{const r=await fetch('http://127.0.0.1:18998'+path,{signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json()}
const tasks=await get('/state/tasks'), groups=await get('/state/groups')
const bound=tasks.filter(t=>t.engine==='workflow-v2'&&t.topicRefs?.length); const selected=[...bound.filter(t=>t.sourceChannel==='web'),...bound.filter(t=>t.sourceChannel!=='web').slice(0,1)]
assert.ok(selected.length>0); assert.ok(selected.some(t=>t.sourceChannel==='web')); assert.ok(selected.some(t=>t.sourceChannel!=='web'))
const names=new Map(groups.map(g=>[g.groupId,g.name]))
for(const task of selected){assert.ok(task.sourceGroupId&&!task.sourceGroupId.startsWith('web:'));assert.ok(names.get(task.sourceGroupId))}
const log=stripVTControlCharacters(await readFile('docs/tmp/task-current-steps/deployment-topic-final/start.stdout.log','utf8'))
const auth=(log.match(/https?:\/\/[^\s<>]+:3080[^\s<>]*/g)||[]).map(s=>new URL(s)).filter(u=>u.hostname==='127.0.0.1'&&u.searchParams.has('token')).at(-1)
assert.ok(auth)
const browser=await chromium.launch({channel:'msedge',headless:true})
let writes=0; const errors=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'})
 await page.route('**/*',route=>route.request().method()==='GET'?route.continue():route.fulfill({status:405,body:'readonly'}))
 page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).port==='18998')writes++})
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(auth.href)
 await page.getByText('稍后提醒',{exact:true}).click({timeout:1500}).catch(()=>{})
 await page.getByText('运行看板',{exact:true}).first().click()

 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1100})
  for(const task of selected){
   const reminder=page.getByText('稍后提醒',{exact:true}); if(await reminder.count()) await reminder.click()
   console.log(JSON.stringify({phase:'card',width}))
   await page.getByRole('button',{name:task.archivedAt?'归档任务':'任务看板',exact:true}).click()
   const actual=page.getByRole('button').filter({has:page.locator('strong[title='+JSON.stringify(task.title)+']')})
   await actual.first().waitFor()
   const label=actual.first().locator('span').filter({hasText:names.get(task.sourceGroupId)})
   assert.ok(await label.count()>0)
   if(task.sourceChannel==='web') assert.ok(!(await actual.first().innerText()).includes(task.groupId))
   const ref=task.topicRefs[0]; assert.equal(ref.groupId,task.sourceGroupId || task.groupId); assert.ok(ref.title)
   const topicButton=actual.first().locator('[data-task-card-action="open-topic"]').first(); assert.equal(await topicButton.getAttribute('title'),ref.title)
   const lateReminder=page.getByText('稍后提醒',{exact:true}); if(await lateReminder.count()) await lateReminder.click()
   if(width===1440) await topicButton.click(); else { await topicButton.focus(); await page.keyboard.press('Enter') }
   await page.getByRole('region',{name:'话题详情',exact:true}).waitFor()
   await page.getByRole('region',{name:'话题详情',exact:true}).getByRole('heading',{name:ref.title,exact:true}).waitFor()
   await page.getByRole('region',{name:'关联任务',exact:true}).getByRole('button',{name:task.title,exact:true}).waitFor()
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 }
 assert.equal(writes,0);assert.deepEqual(errors,[])
 const result={passed:true,workflowCards:tasks.filter(t=>t.engine==='workflow-v2').length,cardsWithTopics:bound.length,checkedCards:selected.length,topicClickAndKeyboardNavigation:true,allResolvedToNamedGroups:true,originalWebSourcePreserved:true,widths:[1440,390],errors:0,businessWrites:writes}
 await writeFile('docs/acceptance/task-current-steps/topic-label-summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close()}
