import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localOrigin } from './local-acceptance-readonly.mjs'

const taskId = 'task-f559fc2e93230cf2cdcd61c8ad51dc35'
const fail = code => { throw Object.assign(new Error(code), { code: `ACTIVITY_MERGE_${code}` }) }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = { result: 'src/views/version/components/ActivityMergeResultDialog.vue', reminder: 'src/views/version/components/ActivityMergeReminderDialog.vue', detail: 'src/views/version/Detail.vue', api: 'src/api/v1/version/manager.js', state: 'src/views/version/components/activity-merge-state.js', lang: 'src/lang/zh.json' }
const methodNames = ['transitionReleaseFlow', 'handleRelease', 'handleActivityMergeCancel', 'handleActivityMergeSkip', 'handleActivityMergeCompleted', 'handleActivityMergeUnknown', 'handleMergeResultCancel', 'handleMergeResultContinue', 'confirmVersionGeneration', 'executeVersionGeneration']

// 读取真实候选；完整脚本先通过原生parser，不从坏文件抽出片段假装候选可运行。
export async function readActivityMergeCandidate(repository) {
  const require = createRequire(join(repository, 'package.json')), compiler = require('vue/compiler-sfc'), parser = require('@babel/parser')
  const source = {}, proof = {}
  for (const [key, path] of Object.entries(files)) { source[key] = await readFile(join(repository, path), 'utf8'); proof[path] = hash(source[key]) }
  const parsed = {}, descriptors = {}
  for (const key of ['result', 'reminder', 'detail']) {
    const descriptor = compiler.parse({ source: source[key], filename: files[key] })
    if (!descriptor.script || !descriptor.template) fail('SFC_INVALID')
    if (compiler.compileTemplate({ source: descriptor.template.content, filename: files[key] }).errors.length) fail('TEMPLATE_INVALID')
    try { parsed[key] = parser.parse(descriptor.script.content, { sourceType: 'module' }) }
    catch (error) { throw Object.assign(new Error('ACTIVITY_MERGE_CANDIDATE_SYNTAX'), { code: 'ACTIVITY_MERGE_CANDIDATE_SYNTAX', file: files[key], line: error.loc?.line, reason: error.reasonCode, proof }) }
    descriptors[key] = descriptor
  }
  const object = key => parsed[key].program.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration
  const methods = object('detail')?.properties.find(node => node.key?.name === 'methods')?.value?.properties
  const selected = methodNames.map(name => { const node = methods?.find(item => item.key?.name === name); if (!node) fail('METHOD_MISSING'); return descriptors.detail.script.content.slice(node.start, node.end) })
  const parentTemplate = descriptors.detail.template.content.trim(), templateAst = compiler.compileTemplate({ source: parentTemplate, filename: files.detail, compilerOptions: { outputSourceRange: true } }).ast
  const bindings = [], seen = new Set()
  const walk = node => { if (!node || seen.has(node)) return; seen.add(node); if (['ActivityMergeReminderDialog', 'ActivityMergeResultDialog'].includes(node.tag)) bindings.push(parentTemplate.slice(node.start, node.end)); for (const child of [...(node.children ?? []), ...Object.values(node.scopedSlots ?? {}), ...(node.ifConditions ?? []).map(item => item.block)]) walk(child) }
  walk(templateAst); if (bindings.length !== 2) fail('PARENT_BINDING_MISSING')
  const parentHarness = '<div><el-button id="generate" @click="handleRelease">生成版本</el-button>' + bindings.join('') + '</div>'
  const apiAst = parser.parse(source.api, { sourceType: 'module' }), apiNames = ['exportActivityMergeResult', 'mergeVersionActivities', 'getActivityMergeCandidates', 'releaseVersion']
  const api = apiNames.map(name => { const node = apiAst.program.body.find(item => item.type === 'ExportNamedDeclaration' && item.declaration?.id?.name === name)?.declaration; if (!node) fail('API_MISSING'); return source.api.slice(node.start, node.end) }).join('\n')
  const component = key => `(()=>{const c=${descriptors[key].script.content.slice(object(key).start, object(key).end)};c.template=${JSON.stringify(descriptors[key].template.content)};c._scopeId='data-v-merge-${key}';return c})()`
  const css = ['result', 'reminder'].flatMap(key => descriptors[key].styles.map(style => { const compiled = compiler.compileStyle({ source: style.content, filename: files[key], id: 'data-v-merge-' + key, scoped: !!style.scoped }); if (compiled.errors.length) fail('STYLE_INVALID'); return compiled.code })).join('\n')
  const state = `(()=>{const module={exports:{}};${source.state};return module.exports})()`
  const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/__merge/element.css"><style>${css}</style><div id="app"></div><script src="/__merge/vue.js"></script><script src="/__merge/element.js"></script><script src="/__merge/app.js"></script>`
  const js = `const state=${state};const {RELEASE_PHASE,createReleaseFlowState,transitionReleaseFlow}=state;
const request=async options=>{const r=await fetch('/__merge/api'+options.url,{method:options.method.toUpperCase(),headers:{'Content-Type':'application/json'},...(options.data?{body:JSON.stringify(options.data)}:{})});if(!r.ok)throw Error('HTTP '+r.status);return options.responseType==='blob'?r.blob():r.json()};
${api}
const copy=()=>{throw Error('UNEXPECTED_COPY')},ROUTER_NAME={},SCENE_MEMBER_WORKPLACE=0;
const words=${source.lang};Vue.prototype.$t=(key,values={})=>{let v=Object.hasOwn(words,key)?words[key]:key.split('.').reduce((v,k)=>v?.[k],words);return String(v??key).replace(/\\{(\\w+)\\}/g,(_,k)=>values[k]??'{'+k+'}')};
Vue.component('svg-icon',{render:h=>h('span')});
const Result=${component('result')},Reminder=${component('reminder')};
window.ui=new Vue({el:'#app',components:{ActivityMergeResultDialog:Result,ActivityMergeReminderDialog:Reminder},
data:()=>({versionId:'fixture-version',versionInfo:{version:'fixture-v1'},releaseFlow:createReleaseFlowState(),activityMergeCandidates:null,mergeResultGroups:[],mergeResultVisible:false,mergeResultUnknown:false,refreshes:0}),
computed:{activityMergeDialogVisible(){return this.releaseFlow.phase===RELEASE_PHASE.MERGE_DIALOG},activityMergeSucceeded(){return this.releaseFlow.mergeSucceeded}},
methods:{${selected.join(',')},refreshVersion(){this.refreshes++}},
template:${JSON.stringify(parentHarness)}});`
  return { proof, html, js, assets: { '/__merge/vue.js': await readFile(require.resolve('vue/dist/vue.js')), '/__merge/element.js': await readFile(require.resolve('element-ui/lib/index.js')), '/__merge/element.css': await readFile(require.resolve('element-ui/lib/theme-chalk/index.css')), '/__merge/fonts/element-icons.woff': await readFile(require.resolve('element-ui/lib/theme-chalk/fonts/element-icons.woff')) } }
}

export async function executeActivityMerge(mode, config, input, repository = process.cwd()) {
  if (!['initialize', 'execute', 'cleanup', 'verify-cleanup', '--check'].includes(mode) || config.taskId !== taskId || config.uatEnvironment !== 'uat3'
    || !isAbsolute(config.evidenceRoot ?? '') || !isAbsolute(config.playwrightModule ?? '')) fail('CONFIG_INVALID')
  if (mode === '--check') { const candidate = await readActivityMergeCandidate(repository); return { checked: true, proof: candidate.proof, coverage: 'candidate-ui-with-api-fixtures' } }
  if (input.uatEnvironment !== 'uat3' || !/^acceptance-[a-f0-9]{32}$/.test(input.namespace ?? '') || input.taskId && input.taskId !== taskId) fail('INPUT_INVALID')
  const origin = localOrigin(input.baseUrl), directory = join(input.evidenceRoot ?? config.evidenceRoot, input.namespace)
  if (!isAbsolute(directory)) fail('INPUT_INVALID')
  await mkdir(directory, { recursive: true })
  const ledgerPath = join(directory, 'activity-merge-ledger.json')
  let ledger; try { ledger = await json(ledgerPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (ledger && (ledger.taskId !== taskId || ledger.namespace !== input.namespace || ledger.baseUrl !== origin)) fail('LEDGER_IDENTITY')
  const persist = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
  if (mode === 'initialize') {
    if (ledger) fail('ALREADY_INITIALIZED')
    ledger = { taskId, namespace: input.namespace, baseUrl: origin, coverage: 'candidate-ui-with-api-fixtures', browserClosed: true, businessWrites: 0, started: false, passed: false, cases: [] }
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx' }); return { initialized: true, namespace: input.namespace }
  }
  if (!ledger) fail('LEDGER_MISSING')
  if (mode !== 'execute') { if (!ledger.browserClosed || ledger.businessWrites !== 0) fail('CLEANUP_UNCONFIRMED'); return { namespace: input.namespace, empty: true, createdResources: 0, mode: 'fixture-only' } }
  if (ledger.started || Object.keys(input.case?.parameters ?? {}).length) fail('EXECUTION_INVALID')
  ledger.started = true; await persist()
  let browser, page
  try {
    const candidate = await readActivityMergeCandidate(repository); ledger.proof = candidate.proof
    const { chromium } = await import(pathToFileURL(config.playwrightModule).href)
    browser = await chromium.launch({ channel: 'msedge', headless: true }); ledger.browserClosed = false; await persist()
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1000 } })
    const groups = ['甲生产活动', '乙生产活动', '丙生产活动'].map((name, i) => ({ groupKey: 'group-' + i, activityName: name, targetUuidOptions: ['uuid-' + i], defaultTargetUuid: 'uuid-' + i, datasets: [0, 1].map(j => ({ datasetId: `dataset-${i}-${j}`, uuid: 'uuid-' + i, datasetName: name + j, includedInCurrentVersion: true })) }))
    let outcome = 'partial', badFile = false, requests = []
    const fixtureBytes = Buffer.from('fixture-only-xlsx-response-bytes')
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname
      if (url.origin !== origin || url.search) { ledger.unexpected = true; return route.abort() }
      if (req.method() === 'GET' && path === '/__merge/ui') return route.fulfill({ contentType: 'text/html', body: candidate.html })
      if (req.method() === 'GET' && path === '/__merge/app.js') return route.fulfill({ contentType: 'text/javascript', body: candidate.js })
      if (req.method() === 'GET' && candidate.assets[path]) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.woff') ? 'font/woff' : 'text/javascript', body: candidate.assets[path] })
      if (req.method() === 'GET' && /element-icons\.(woff|ttf)$/.test(path)) return route.fulfill({ status: 204, body: '' })
      const prefix = '/__merge/api/versionManage/', version = prefix + 'fixture-version/'
      let body; try { body = req.postDataJSON() } catch {}
      requests.push({ path, method: req.method(), body })
      if (req.method() === 'GET' && path === version + 'activity-merge-candidates') return route.fulfill({ json: { code: '200', data: { groupCount: outcome === 'none' ? 0 : 3, relatedUuidCount: 3, datasetCount: 6, versionDatasetCount: 6, groups: outcome === 'none' ? [] : groups } } })
      if (req.method() === 'POST' && path === version + 'activity-merge') return route.fulfill({ json: { code: '200', data: { groups: groups.map((g, i) => ({ groupKey: g.groupKey, status: outcome === 'success' || outcome === 'partial' && i === 0 ? 'SUCCESS' : 'FAILED' })) } } })
      if (req.method() === 'POST' && path === version + 'activity-merge-result/export') return route.fulfill({ contentType: badFile ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: badFile ? '{}' : fixtureBytes })
      if (req.method() === 'POST' && body?.versionId === 'fixture-version' && path === prefix + 'releaseVersion') return route.fulfill({ json: { code: '200' } })
      ledger.unexpected = true; return route.abort()
    })
    await context.routeWebSocket('**/*', socket => socket.close())
    page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message))
    const start = async mode => {
      outcome = mode; requests = []; await page.goto(origin + '/__merge/ui'); await page.locator('#generate').click()
      if (mode === 'none') return
      await page.locator('.activity-merge-dialog:visible').waitFor()
      // 点击真实checkbox选择业务提交范围；不用直接调用submit或伪造emit。
      const items = page.locator('.activity-merge-dialog .group-item')
      for (let i = 0; i < 3; i++) { await items.nth(i).click(); await items.nth(i).locator('.el-checkbox').click() }
      await page.locator('.activity-merge-dialog .el-dialog__footer button').last().click()
    }
    const result = page.locator('.activity-merge-result:visible')
    const record = async name => { assert.equal(ledger.unexpected, undefined); assert.deepEqual(errors, []); ledger.cases.push({ name, passed: true }); await persist() }
    await start('partial'); await result.waitFor()
    assert.deepEqual(await result.locator('.stat b').allTextContents(), ['3', '1', '2'])
    assert.deepEqual(await result.locator('tbody td:first-child').allTextContents(), groups.map(g => g.activityName))
    assert.equal(await result.locator('td.success').count(), 1); assert.equal(await result.locator('td.failed').count(), 2)
    assert.equal(await result.getByText('已成功合并的结果已保留，取消生成版本不会撤销合并。').count(), 1)
    const downloadEvent = page.waitForEvent('download'); await result.getByRole('button', { name: '下载合并结果明细' }).click(); const download = await downloadEvent
    assert.equal(download.suggestedFilename(), 'activity-merge-result-fixture-v1.xlsx')
    const downloaded = join(directory, download.suggestedFilename()); await download.saveAs(downloaded); assert.deepEqual(await readFile(downloaded), fixtureBytes)
    const exported = requests.find(req => req.path.endsWith('/activity-merge-result/export'))
    assert.deepEqual(exported.body, { groups: groups.map((g, i) => ({ groupKey: g.groupKey, selectedDatasetIds: g.datasets.map(d => d.datasetId), status: i === 0 ? 'SUCCESS' : 'FAILED' })) })
    badFile = true; await result.getByRole('button', { name: '下载合并结果明细' }).click(); await page.getByText('合并结果明细下载失败，请重试').waitFor(); badFile = false
    await page.screenshot({ path: join(directory, 'partial-failure.png') })
    await result.getByRole('button', { name: '取消生成版本', exact: true }).click(); await result.waitFor({ state: 'hidden' })
    assert.equal(requests.some(req => req.path.endsWith('/releaseVersion')), false); assert.equal(await page.evaluate(() => window.ui.refreshes), 1)
    await record('partial-cancel-download-contract')
    await start('failed'); await result.waitFor(); assert.deepEqual(await result.locator('.stat b').allTextContents(), ['3', '0', '3'])
    assert.equal(await result.locator('td.failed').count(), 3); await page.screenshot({ path: join(directory, 'all-failure.png') })
    const allDownloadEvent = page.waitForEvent('download'); await result.getByRole('button', { name: '下载合并结果明细' }).click()
    const allDownload = await allDownloadEvent; await allDownload.saveAs(join(directory, 'all-failed.xlsx')); assert.deepEqual(await readFile(join(directory, 'all-failed.xlsx')), fixtureBytes)
    assert.deepEqual(requests.find(req => req.path.endsWith('/activity-merge-result/export')).body, { groups: groups.map(g => ({ groupKey: g.groupKey, selectedDatasetIds: g.datasets.map(d => d.datasetId), status: 'FAILED' })) })
    await result.getByRole('button', { name: '跳过，继续生成版本' }).click(); await page.locator('.el-message-box:visible').waitFor()
    assert.equal(requests.some(req => req.path.endsWith('/releaseVersion')), false)
    await page.locator('.el-message-box__btns button').last().click(); await page.waitForFunction(() => window.ui.refreshes === 1)
    assert.equal(requests.filter(req => req.path.endsWith('/releaseVersion')).length, 1); await record('all-failed-continue-confirm')
    await start('success'); await page.locator('.el-message-box:visible').waitFor(); assert.equal(await result.count(), 0)
    await page.locator('.el-message--success').waitFor(); assert.equal(requests.some(req => req.path.endsWith('/releaseVersion')), false)
    await page.locator('.el-message-box__btns button').first().click(); await record('all-success-old-confirm-cancel')
    await start('none'); await page.locator('.el-message-box:visible').waitFor(); assert.equal(await result.count(), 0)
    assert.equal(requests.some(req => req.path.endsWith('/activity-merge')), false); await page.locator('.el-message-box__btns button').first().click(); await record('no-candidate-old-confirm')
    ledger.passed = true
    return { namespace: input.namespace, baseUrl: origin, actual: JSON.stringify({ uiContract: true, coverage: 'candidate-ui-with-api-fixtures', backendVerified: false }) }
  } catch (error) { ledger.failure = { code: error.code ?? 'UI_ASSERTION_FAILED', file: error.file, line: error.line, reason: error.reason }; if (page) await page.screenshot({ path: join(directory, 'failed.png') }).catch(() => {}); throw error }
  finally { if (browser) await browser.close(); ledger.browserClosed = true; await persist() }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, flag, configPath, ...extra] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (flag !== '--config' || !isAbsolute(configPath ?? '') || extra.length) fail('CLI_INVALID')
    let raw = ''; if (mode !== '--check') for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 64000) fail('INPUT_INVALID') }
    console.log(JSON.stringify(await executeActivityMerge(mode, await json(configPath), raw ? JSON.parse(raw) : {})))
  }).catch(error => { console.error(JSON.stringify({ code: error.code ?? 'ACTIVITY_MERGE_FAILED', file: error.file, line: error.line, reason: error.reason })); process.exitCode = 1 })
}
