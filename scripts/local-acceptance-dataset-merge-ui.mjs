import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { runMergeCommand } from './local-acceptance-merge.mjs'
import { localOrigin } from './local-acceptance-readonly.mjs'

// SG20 的七项 UI 交互使用真实候选 SFC；列表/API 输入是显式 fixture，不代表后端验收。
export async function readDatasetMergeCandidate(repository) {
  const require = createRequire(join(repository, 'package.json'))
  const compiler = require('vue/compiler-sfc'), parser = require('@babel/parser'), sass = require('sass')
  const proof = {}, styles = []
  const source = async path => { const text = await readFile(join(repository, path), 'utf8'); proof[path] = createHash('sha256').update(text).digest('hex'); return text }
  function script(text, component = false) {
    const ast = parser.parse(text, { sourceType: 'module' })
    return ast.program.body.map(node => node.type === 'ImportDeclaration' ? '' : node.type === 'ExportDefaultDeclaration' ? 'return ' + text.slice(node.declaration.start, node.declaration.end) : node.type === 'ExportNamedDeclaration' ? text.slice(node.declaration.start, node.declaration.end) : text.slice(node.start, node.end)).join('\n')
  }
  async function sfc(name, path) {
    const descriptor = compiler.parse({ source: await source(path), filename: path })
    assert.ok(descriptor.script && descriptor.template, path)
    assert.deepEqual(compiler.compileTemplate({ source: descriptor.template.content, filename: path }).errors, [], path)
    for (const style of descriptor.styles) {
      const css = style.lang === 'scss' ? sass.renderSync({ data: style.content }).css.toString() : style.content
      const compiled = compiler.compileStyle({ source: css, filename: path, id: 'data-v-proof-' + name, scoped: !!style.scoped })
      assert.deepEqual(compiled.errors, []); styles.push(compiled.code)
    }
    return `const ${name}=(()=>{const c=(()=>{${script(descriptor.script.content, true)}})();c.template=${JSON.stringify(descriptor.template.content)};c._scopeId='data-v-proof-${name}';return c})();`
  }
  const components = []
  for (const name of ['BasePage', 'FormOne', 'FormTwo', 'FormThree']) components.push(await sfc(name, `src/views/dataStore/components/${name}.vue`))
  components.unshift(await sfc('OverflowTip', 'src/components/overflow-tip.vue'))
  components.push(await sfc('Create', 'src/views/dataStore/create.vue'))
  const helpers = []
  for (const path of ['src/constant/flow.js', 'src/views/dataStore/mergeDatabaseContext.js', 'src/views/dataStore/manualMergeState.js']) helpers.push(script(await source(path)))
  const words = await source('src/lang/zh.json')
  const js = `const {ref,watch,computed,onBeforeUnmount}=Vue;const {Message,MessageBox}=ELEMENT;Vue.config.errorHandler=e=>{setTimeout(()=>{throw e},0)};
const words=${words};const t=(key)=>String(Object.hasOwn(words,key)?words[key]:key.split('.').reduce((v,k)=>v?.[k],words)??key);const i18n={t};Vue.prototype.$t=t;
const store={state:Vue.observable({options:{backgroundDatasetId:'fixture-db'},category:{map:{specialType:[]}}}),commit(){}};
const router={resolve:()=>({href:'#'}),replace(){},push(){}},ROUTER_NAME={},SCENE_MEMBER_WORKPLACE=0,CALCULATE_STATUS_OPTIONS=[],FILTER_SYSTEM_MODEL_OPTIONS=[],codeOptions={elementType:'fixture'};
const isDef=x=>x!==undefined&&x!==null,getTagColor=()=>'',empty=async()=>({data:[]});
window.calls=[];window.rows=[0,1].map(i=>({id:'fixture-'+i,name:'来源'+i,middleFlowName:'共同产品流',locationName:'测试位置'}));
const selectData=async args=>{window.calls.push(JSON.parse(JSON.stringify(args)));return {data:window.rows,total:2}},queryAllProcessByData=async()=>({data:Object.fromEntries(window.rows.map((r,i)=>[r.id,[{isLast:true,elementName:'共同产品流',production:i?3:1,processId:'p'+i,unitName:'kg',unitId:'kg',declaredUnitId:'kg',declaredUnitName:'kg'}]]))});
window.preview={mergedItems:[0,1].map(i=>({id:'group-'+i,mergeType:i?'NORMAL':'REFERENCE_PRODUCT',result:{materialName:'材料'+i,flowId:'flow'+i,flowName:'流'+i,flowType:'PRODUCT_FLOW',resultValue:12,unitName:'kg',resultDescription:'短描述',materialTypeId:'input',materialTypeName:'原材料',isOutput:false},sources:[]})),unmergedItems:[]};
const previewMergeDataset=async()=>({code:'200',data:window.preview}),mergeDataset=()=>{throw Error('UNEXPECTED_BUSINESS_WRITE')},getDictionaryByMenuCode=empty,getUnitGroups=empty,selectFlowById=empty,queryUnitInfoById=empty;
const fixtureEmpty={render:h=>h('span')},DxSelect=fixtureEmpty,EasySelect=fixtureEmpty,ChooseFlow=fixtureEmpty,ChooseRelatedFlow=fixtureEmpty,MergeUpstreamLink=fixtureEmpty,TableColumnHeader=fixtureEmpty,FilterTag=fixtureEmpty,CheckView=fixtureEmpty;
const LayoutTable={template:'<div><slot name="filter"/><slot/><slot name="footer"/></div>'};
const TableDatasetList={props:['data'],methods:{clearSelection(){this.$emit('selection-change',[])},toggleRowSelection(){}},template:${JSON.stringify(`<div class="fixture-list"><button v-for="(r,i) in data" :id="'select-'+i" @click="$emit('selection-change',[r])">选择 {{r.name}}</button></div>`)}};
Vue.component('svg-icon',fixtureEmpty);${helpers.join('\n')}
${components.join('\n')}
window.root=new Vue({el:'#app',render:h=>h(Create)});window.component=name=>{const walk=v=>v.$options._scopeId==='data-v-proof-'+name?v:v.$children.map(walk).find(Boolean);return walk(window.root)};`
  const assets = { '/vue.js': await readFile(require.resolve('vue/dist/vue.js')), '/element.js': await readFile(require.resolve('element-ui/lib/index.js')), '/element.css': await readFile(require.resolve('element-ui/lib/theme-chalk/index.css')), '/big.js': await readFile(require.resolve('big.js')), '/fonts/element-icons.woff':await readFile(require.resolve('element-ui/lib/theme-chalk/fonts/element-icons.woff')) }
  return { proof, js, assets, html: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/element.css"><style>html,body,#app{height:100%;margin:0}.flex-column{display:flex;flex-direction:column}.flex-1{flex:1;min-width:0}.flex-none{flex:none}${styles.join('\n')}</style><div id="app"></div><script src="/vue.js"></script><script src="/element.js"></script><script src="/big.js"></script><script src="/app.js"></script>` }
}

export async function verifyDatasetMergeUI({ repository, playwrightModule, evidenceRoot, baseUrl, namespace }) {
  await mkdir(evidenceRoot, { recursive: true })
  const report = { taskId:'task-83c651ebdbdb77584a06d1fcb6b9e255',uatEnvironment:'uat3',coverage:'candidate-ui-with-explicit-api-and-list-fixtures',backendVerified:false,browserClosed:true,cases:[],pageErrors:[] }
  let browser
  try {
    const candidate = await readDatasetMergeCandidate(repository); report.proof=candidate.proof
    const { chromium } = await import(pathToFileURL(playwrightModule).href)
    browser=await chromium.launch({channel:'msedge',headless:true});report.browserClosed=false
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'})
    const origin=localOrigin(baseUrl)
    const ready=await (await fetch(origin+'/ready',{redirect:'error'})).json()
    assert.equal(ready.taskId,report.taskId);assert.equal(ready.uatEnvironment,report.uatEnvironment);assert.deepEqual(ready.proof,candidate.proof);assert.equal(ready.namespace,namespace);assert.ok(Number.isSafeInteger(ready.pid)&&ready.pid>0)
    report.service={baseUrl:origin,pid:ready.pid,proof:ready.proof}
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
    const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin+'/');assert.equal(new URL(page.url()).origin,origin);await page.waitForFunction(()=>window.component?.('FormOne'),{},{timeout:10000})
    const run=async(id,fn)=>{try{await fn();report.cases.push({id,status:'PASS'})}catch(e){report.cases.push({id,status:'FAIL',error:e.message});await page.screenshot({path:join(evidenceRoot,id+'.png'),fullPage:true})}}
    await run('SG20-01-selection',async()=>{
      await page.evaluate(()=>component('FormOne').handleFilterChange({prop:'name',value:'保留过滤',label:'名称'}));await page.click('#select-0')
      await page.waitForFunction(()=>calls.at(-1)?.referenceProduct==='共同产品流')
      assert.equal(await page.evaluate(()=>calls.at(-1).processName),'保留过滤')
      await page.evaluate(()=>{component('FormOne').handleSelectChange([]);component('FormOne').handleSelectChange([{id:'new',middleFlowName:'不覆盖'}])})
      assert.equal(await page.evaluate(()=>calls.at(-1).referenceProduct),'共同产品流')
      await page.evaluate(()=>{const c=component('FormOne');c.handleClearAllFilters();c.handleSelectChange([]);c.handleSelectChange([{id:'new',middleFlowName:'再次填入'}])})
      await page.waitForFunction(()=>calls.at(-1)?.referenceProduct==='再次填入')
    })
    await run('SG20-06-notice',async()=>{
      const text=await page.locator('.merge-notice').innerText();assert.ok(text.includes('请选择至少两个单工序数据集'));assert.ok(!text.includes('必须计算'))
      assert.equal(await page.evaluate(()=>calls[0].isCalculated),'')
      assert.ok(await page.locator('.merge-notice').isVisible());await page.locator('.merge-notice .el-alert__closebtn').click();assert.equal(await page.locator('.merge-notice').count(),0)
    })
    await page.evaluate(()=>component('Create').handleNext(window.rows));await page.waitForFunction(()=>component('Create').curStep===2)
    await run('SG20-02-columns',async()=>{
      const labels=await page.locator('.form-two-wrap .el-table__header-wrapper th').allTextContents();const prod=labels.findIndex(x=>x.includes('产量')&&!x.includes('权重'));assert.ok(prod>=0);assert.ok(labels[prod+1].includes('权重'));assert.ok(labels[prod+2].includes('声明单位'));assert.ok(labels[prod-1].includes('物料'));assert.ok(labels[prod-2].includes('参考产品'));assert.ok(labels[prod+3].includes('地理'));assert.ok(labels[prod+4].includes('操作'))
      assert.deepEqual(await page.evaluate(()=>component('Create').checkNodes.map(x=>x.x)),[0.25,0.75])
      await page.locator('.form-two-wrap .el-input-number input').first().fill('0.4');await page.locator('.form-two-wrap .el-input-number input').first().blur()
      await page.getByRole('button',{name:'产量权重恢复初始'}).click();assert.deepEqual(await page.evaluate(()=>component('Create').checkNodes.map(x=>x.x)),[0.25,0.75])
    })
    const preview=async()=>{await page.locator('.form-two-wrap .search-item.name input').fill('验收结果');await page.locator('.form-two-wrap button.next').click();await page.waitForFunction(()=>component('Create').curStep===3)};await preview()
    await run('SG20-03-panel',async()=>{
      const button=page.locator('.settings-heading button');assert.equal(await button.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.settings-content').count(),0)
      assert.ok(await page.locator('.preview-reminder').isVisible());await button.click();assert.equal(await page.locator('.source-dataset-table').count(),1)
      await page.evaluate(()=>component('Create').handlePreviewPrev());await preview();assert.equal(await button.getAttribute('aria-expanded'),'false')
      const box=await page.locator('.settings-heading').boundingBox();assert.ok(Math.abs(box.height-38)<=2,'heading height '+box.height)
    })
    await run('SG20-04-filter-scroll',async()=>{
      const widths=await page.locator('.common-filters .el-select').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().width));await page.setViewportSize({width:420,height:900})
      for(const tab of ['merged','unmerged']){await page.evaluate(tab=>component('FormThree').activeTab=tab,tab);await page.waitForTimeout(50)
        const dimensions=await page.locator('.common-filters .el-select').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().width));assert.deepEqual(dimensions,widths)
        const scroll=await page.locator('.common-filters').evaluate(x=>({overflow:getComputedStyle(x).overflowX,scroll:x.scrollWidth,width:x.clientWidth}));assert.ok(['auto','scroll'].includes(scroll.overflow));assert.ok(scroll.scroll>scroll.width);assert.ok(await page.locator('.common-filters .filter-button').evaluateAll(xs=>xs.every(x=>getComputedStyle(x).whiteSpace==='nowrap')))
        await page.locator('.common-filters').evaluate(x=>x.scrollLeft=x.scrollWidth);assert.ok(await page.locator('.common-filters').evaluate(x=>x.scrollLeft>0))}
      await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>component('FormThree').activeTab='merged')
    })
    await run('SG20-05-steps',async()=>{
      assert.equal(await page.locator('.merge-step.current').count(),1);assert.equal(await page.locator('.merge-step.complete .el-icon-check').count(),2)
      const style=await page.locator('.merge-step.current').evaluate(x=>({font:getComputedStyle(x).fontSize,weight:getComputedStyle(x).fontWeight,badge:x.querySelector('.step-badge').getBoundingClientRect().width}));assert.equal(style.font,'14px');assert.equal(style.badge,24);assert.ok(Number(style.weight)>=600);assert.equal(await page.locator('.step-line').count(),2)
    })
    await run('SG20-07-description',async()=>{
      for(const text of ['短描述','较长描述'.repeat(35),'第一行\n第二行\n第三行']){
        await page.locator('.result-description-field textarea').last().fill(text)
        const positions=await page.locator('.merged-card').last().evaluate(x=>{const r=s=>x.querySelector(s).getBoundingClientRect();return {unit:r('.unit-field .summary-label').top,description:r('.result-description-field .summary-label').top,valueRight:r('.value-field').right,unitLeft:r('.unit-field').left,unitRight:r('.unit-field').right,descriptionLeft:r('.result-description-field').left,split:r('.split-button').right,right:r('.result-summary').right}})
        assert.ok(Math.abs(positions.split-positions.right)<=2,JSON.stringify(positions));assert.ok(Math.abs(positions.unit-positions.description)<=2,JSON.stringify(positions));assert.ok(Math.abs((positions.unitLeft-positions.valueRight)-(positions.descriptionLeft-positions.unitRight))<=2,JSON.stringify(positions))
      }
      assert.equal(await page.locator('.reference-product-card .split-button').count(),0);assert.equal(await page.locator('.merged-card:not(.reference-product-card) .split-button').count(),1)
    })
    await page.screenshot({path:join(evidenceRoot,'final.png'),fullPage:true})
  } catch(error){report.error=error.message} finally {try{await browser?.close();report.browserClosed=true}catch(error){report.error='BROWSER_CLOSE_FAILED: '+error.message}report.passed=report.browserClosed&&report.cases.length===7&&report.cases.every(x=>x.status==='PASS')&&!report.error&&report.pageErrors.length===0;await writeFile(join(evidenceRoot,'result.json'),JSON.stringify(report,null,2))}
  return report
}
export async function executeDatasetMergeUI(mode,config,input={},repository=process.cwd()) {
  assert.equal(config.taskId,'task-83c651ebdbdb77584a06d1fcb6b9e255','TASK_SCOPE_INVALID')
  assert.equal(config.uatEnvironment,'uat3','UAT_SCOPE_INVALID')
  assert.ok(isAbsolute(config.playwrightModule??'')&&isAbsolute(config.evidenceRoot??''),'CONFIG_INVALID')
  assert.ok(['--check','prepare','initialize','execute','cleanup','verify-cleanup'].includes(mode),'MODE_INVALID')
  if(mode==='prepare'){assert.equal(input.uatEnvironment,'uat3');assert.ok(/^acceptance-[a-f0-9]{32}$/.test(input.namespace??''));assert.ok(isAbsolute(config.yarnCli??'')&&isAbsolute(config.nodeExecutable??''),'INSTALL_RUNTIME_INVALID');const capacity=await statfs(repository);assert.ok(capacity.bavail*capacity.bsize>=1.6*1024**3,'INSTALL_DISK_CAPACITY_REQUIRED');await runMergeCommand(config.nodeExecutable,[config.yarnCli,'install','--frozen-lockfile','--ignore-scripts','--non-interactive','--production=false'],{cwd:repository});return {prepared:true}}
  if(mode==='--check')return {checked:true,proof:(await readDatasetMergeCandidate(repository)).proof,backendVerified:false}
  assert.equal(input.uatEnvironment,'uat3','INPUT_UAT_INVALID');assert.ok(/^acceptance-[a-f0-9]{32}$/.test(input.namespace??''),'NAMESPACE_INVALID')
  if(input.taskId)assert.equal(input.taskId,config.taskId,'INPUT_TASK_INVALID')
  const baseUrl=localOrigin(input.baseUrl),directory=join(config.evidenceRoot,input.namespace),path=join(directory,'dataset-merge-ui-ledger.json')
  await mkdir(directory,{recursive:true})
  if(mode==='initialize'){await writeFile(path,JSON.stringify({taskId:config.taskId,namespace:input.namespace,baseUrl,started:false,browserClosed:true,businessWrites:0}),{flag:'wx'});return {initialized:true,namespace:input.namespace}}
  const ledger=JSON.parse(await readFile(path,'utf8'));assert.equal(ledger.taskId,config.taskId);assert.equal(ledger.namespace,input.namespace);assert.equal(ledger.baseUrl,baseUrl)
  if(mode==='cleanup'||mode==='verify-cleanup'){assert.equal(ledger.browserClosed,true);assert.equal(ledger.businessWrites,0);return {namespace:input.namespace,empty:true,createdResources:0,mode:'read-only'}}
  assert.equal(ledger.started,false,'ALREADY_EXECUTED');assert.equal(Object.keys(input.case?.parameters??{}).length,0,'CASE_PARAMETERS_INVALID')
  ledger.started=true;ledger.browserClosed=false;await writeFile(path,JSON.stringify(ledger))
  let report
  try{report=await verifyDatasetMergeUI({repository,playwrightModule:config.playwrightModule,evidenceRoot:directory,baseUrl,namespace:input.namespace})}
  finally{ledger.browserClosed=report?.browserClosed===true;ledger.passed=report?.passed===true;await writeFile(path,JSON.stringify(ledger))}
  assert.equal(report.passed,true,'DATASET_MERGE_UI_ASSERTION_FAILED: '+report.cases.filter(x=>x.status==='FAIL').map(x=>x.id).join(','))
  return {namespace:input.namespace,baseUrl,actual:JSON.stringify({uiContract:true,coverage:report.coverage,backendVerified:false})}
}
export async function serveDatasetMergeUI(config,input,{host,port,repository=process.cwd()}) {
  assert.equal(host,'127.0.0.1');assert.ok(Number.isInteger(port)&&port>0&&port<65536)
  assert.equal(config.taskId,'task-83c651ebdbdb77584a06d1fcb6b9e255');assert.equal(config.uatEnvironment,'uat3');assert.equal(input.uatEnvironment,'uat3')
  assert.equal(localOrigin(input.baseUrl),`http://${host}:${port}`)
  assert.ok(/^acceptance-[a-f0-9]{32}$/.test(input.namespace??''))
  const candidate=await readDatasetMergeCandidate(repository)
  const server=createServer((request,response)=>{
    if(request.method!=='GET'){response.writeHead(405);response.end();return}
    const path=new URL(request.url,input.baseUrl).pathname
    const body=path==='/ready'?JSON.stringify({status:'UP',taskId:config.taskId,uatEnvironment:config.uatEnvironment,namespace:input.namespace,pid:process.pid,proof:candidate.proof}):path==='/'?candidate.html:path==='/app.js'?candidate.js:candidate.assets[path]
    if(body===undefined){response.writeHead(404);response.end();return}
    response.writeHead(200,{'Content-Type':path==='/ready'?'application/json':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':path.endsWith('.woff')?'font/woff':'text/html','Cache-Control':'no-store'});response.end(body)
  })
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,host,accept)})
  return server
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,flag,configPath,...extra]=process.argv.slice(2)
  try{assert.equal(flag,'--config');assert.ok(isAbsolute(configPath??''));let raw='';if(mode!=='--check')for await(const chunk of process.stdin){raw+=chunk;assert.ok(raw.length<64000)}
    const config=JSON.parse(await readFile(configPath,'utf8')),input=raw?JSON.parse(raw):{}
    if(mode==='serve'){assert.equal(extra[0],'--host');assert.equal(extra[2],'--port');assert.equal(extra.length,4);await serveDatasetMergeUI(config,input,{host:extra[1],port:Number(extra[3])})}
    else{assert.equal(extra.length,0);console.log(JSON.stringify(await executeDatasetMergeUI(mode,config,input)))}}
  catch(error){console.error(JSON.stringify({code:'DATASET_MERGE_UI_FAILED',message:error.message}));process.exitCode=1}
}
