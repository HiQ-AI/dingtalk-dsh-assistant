// 专用远程 UAT 验收；本地入口守卫不变。生命周期复用本地已审查步骤的静态副本，远程身份由主入口独立回读。
import {readFile,writeFile,mkdir,rename,lstat,realpath} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {isAbsolute,resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {validateMergeConfig,dataOperation,checkMerge,confirmBody,exactDecimal} from '../../../../scripts/local-acceptance-merge.mjs'
import {reviewRequestAllowed,eligibleReviewer} from '../../../../scripts/local-acceptance-review.mjs'
import {optionalTelemetry} from '../../../../scripts/local-acceptance-readonly.mjs'
const exec=promisify(execFile),fail=code=>{throw Object.assign(new Error(code),{code:'REMOTE_UAT_'+code})}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const success=value=>['200','0'].includes(String(value?.code)),json=async path=>JSON.parse(await readFile(path,'utf8'))
function remoteOrigin(value,expected){if(value!==expected)fail('REMOTE_ORIGIN_INVALID');return expected}
export function assertRemoteMergeRequest(origin,path,method){
 const post=new Set(['/api/sso/auth/login','/api/sso/auth/logout','/api/dataset/dataset/allProcessLinkProduction','/api/dataset/dataset/merge-preview','/api/dataset/dataset/do-merge'])
 if(origin!=='https://editor3.hiqdat.dev'||!(method==='POST'&&post.has(path)||method==='GET'&&path==='/api/sso/user/info/current?productCode=hiq_editor'))fail('REQUEST_PATH_NOT_ALLOWED')
}


export async function remoteMerge(mode, config, input, dependencies = {}) {
  validateMergeConfig(config)
  if (!['initialize', 'execute', 'api', 'cleanup', 'verify-cleanup'].includes(mode) || !/^acceptance-[a-f0-9]{32}$/.test(input?.namespace ?? '')
    || input.uatEnvironment !== 'uat3' || !/^https:\/\/editor[1-9]\.hiqdat\.dev$/.test(config.ssoOrigin ?? '')
    || !['evidenceRoot', 'accountsFile', 'springConfigFile'].every(k => isAbsolute(config[k] ?? '')) || config.accountKey !== 'editor_uat_admin') fail('INPUT_INVALID')
  const baseUrl = remoteOrigin(input.baseUrl, 'https://editor3.hiqdat.dev'), directory = join(config.evidenceRoot, input.namespace), ledgerPath = join(directory, 'merge-ledger.json')
  const operate = dependencies.dataOperation ?? dataOperation, fetcher = dependencies.fetch ?? fetch, precheck = dependencies.check ?? checkMerge
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink() || resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()) fail('DIRECTORY_INVALID')
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0]; if (!sid) fail('ACL_INVALID')
    await exec('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true })
  }
  let ledger
  try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!ledger && mode !== 'initialize') fail('LEDGER_MISSING')
  ledger ??= { namespace: input.namespace, baseUrl, sourceCommit: config.sourceCommit, status: 'new', sessionState: 'none',
    datasourceId: randomUUID(), resultName: `merge-${input.namespace}`, sources: ['A', 'B'].map(suffix => ({ processId: randomUUID(), coreId: randomUUID(),
      dataId: randomUUID(), docId: randomUUID(), uuid: randomUUID(), name: `merge-${input.namespace}-${suffix}` })), requests: [] }
  if (ledger.namespace !== input.namespace || ledger.baseUrl !== baseUrl || ledger.sourceCommit !== config.sourceCommit) fail('LEDGER_IDENTITY')
  if (!uuid(ledger.datasourceId)) fail('LEDGER_ISOLATION_MISSING')
  const assertEmpty = data => { if (data.businessRows !== 0 || data.snapshotCount !== 0 || data.adminDatasourceCount !== 0 || data.qualityReportCount !== 0) fail('RESOURCES_REMAIN') }
  const persist = async () => { const temp = ledgerPath + '.tmp'; await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 }); await rename(temp, ledgerPath) }
  await persist()
  if (mode === 'initialize') {
    if (ledger.status !== 'new' || ledger.sessionState !== 'none' || ledger.requests.length) fail('INITIALIZATION_ALREADY_USED')
    assertEmpty(await operate('verify', config, ledger))
    return { namespace: input.namespace, baseUrl, initialized: true }
  }
  const sessionPath = join(directory, 'merge-session.json')
  let session
  if (ledger.sessionState === 'active' || ledger.sessionState === 'logout-pending') session = JSON.parse(await readFile(sessionPath, 'utf8'))
  const request = async (origin, path, body) => {
    ledger.requests.push({ path, method: body === undefined ? 'GET' : 'POST' }); await persist()
    const response = await fetcher(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'X-Site': '101', ...(session ? { Authorization: session.accessToken, userId: String(session.userId), Cookie: `accessToken=${session.accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const raw = await response.text(); if (raw.length > 4_000_000) fail('RESPONSE_TOO_LARGE')
    let json; try { json = JSON.parse(raw, (key, value, context) => key === 'resultValue' && typeof value === 'number'
      ? context?.source ?? fail('EXACT_JSON_REQUIRED') : value) } catch { ledger.invalidResponse = { path, status:response.status, contentType:response.headers.get('content-type'), bodySha256:createHash('sha256').update(raw).digest('hex'), frontendHtml:/<html|<!doctype/i.test(raw) }; await persist(); fail('RESPONSE_INVALID') }
    return { status: response.status, body: json }
  }
  const ok = r => r.status === 200 && ['200', '0'].includes(String(r.body.code))
  if (mode === 'verify-cleanup') {
    if (ledger.sessionState !== 'logged-out' || ledger.status !== 'cleaned') fail('CLEANUP_UNCONFIRMED')
    const data = await operate('verify', config, ledger)
    assertEmpty(data)
    if (ledger.userId) {
      session = JSON.parse(await readFile(sessionPath, 'utf8'))
      const current = await request(config.ssoOrigin, '/api/sso/user/info/current?productCode=hiq_editor')
      if (current.status !== 401 && String(current.body.code) !== '401') fail('SESSION_STILL_ACTIVE')
    }
    return { namespace: input.namespace, empty: true, dataCleaned: true, auditPolicy: 'retain-queue-provider-and-system-audit', auditIds: null, auditCount: null }
  }
  if (mode === 'cleanup') {
    if (ledger.sessionState === 'login-pending') fail('SESSION_UNKNOWN')
    if (ledger.userId) {
      const before = await operate('inspect', config, ledger)
      if (ledger.status === 'confirm-pending' && !before.resultId) fail('CONFIRM_OUTCOME_UNKNOWN')
      if (ledger.status === 'preview-pending' && !before.snapshotCount && !ledger.snapshotId) fail('PREVIEW_OUTCOME_UNKNOWN')
      ledger.resources = before.resources; ledger.resultId = before.resultId ?? ledger.resultId; await persist()
      await operate('cleanup', config, ledger)
      const after = await operate('verify', config, ledger); assertEmpty(after)
    }
    if (!ledger.userId) {
      const untouched = await operate('verify', config, ledger)
      assertEmpty(untouched)
    }
    if (session) {
      ledger.sessionState = 'logout-pending'; await persist()
      const out = await request(config.ssoOrigin, '/api/sso/auth/logout', {}); if (!ok(out) && out.status !== 401 && String(out.body.code) !== '401') fail('LOGOUT_FAILED')
      const current = await request(config.ssoOrigin, '/api/sso/user/info/current?productCode=hiq_editor')
      if (current.status !== 401 && String(current.body.code) !== '401') fail('SESSION_STILL_ACTIVE')
    }
    ledger.sessionState = 'logged-out'; ledger.status = 'cleaned'; await persist()
    return { namespace: input.namespace, dataCleaned: true, auditPolicy: 'retained' }
  }
  if (ledger.status === 'passed') return { namespace: input.namespace, baseUrl, actual: ledger.actual }
  if (ledger.status !== 'new') fail('RECOVERY_REQUIRES_CLEANUP')
  const preflight = await precheck(config); if (!preflight.ready) fail('PREFLIGHT_BLOCKED')
  const ready = await fetcher(baseUrl + '/api/dataset/ready', { redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!ready.ok || (await ready.json()).status !== 'UP') fail('CANDIDATE_NOT_READY')
  const account = JSON.parse(await readFile(config.accountsFile, 'utf8')).accounts?.[config.accountKey]; if (!account?.username || !account.password) fail('ACCOUNT_MISSING')
  ledger.sessionState = 'login-pending'; await persist()
  const login = await request(config.ssoOrigin, '/api/sso/auth/login', { username: account.username, password: account.password, grantType: 'PASSWORD' })
  if (!ok(login) || !login.body.data?.accessToken || !login.body.data?.userId) fail('LOGIN_FAILED')
  session = login.body.data; await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 }); ledger.userId = String(session.userId); ledger.sessionState = 'active'; await persist()
  ledger.status = 'provision-pending'; await persist()
  await operate('provision', config, ledger); ledger.status = 'provisioned'; await persist()
  const sourceProof = await operate('inspect', config, ledger)
  if (sourceProof.sourceResults.length !== 2 || sourceProof.sourceResults.some(r => exactDecimal(r[1]) !== '0.5' || r[2] !== config.kilogramUnitId || r[3] !== config.tonneUnitId)) fail('FIXTURE_READBACK_FAILED')
  ledger.sourceProof = sourceProof.sourceResults; ledger.resources = sourceProof.resources; await persist()
  const candidates = await request(baseUrl, '/api/dataset/dataset/allProcessLinkProduction', ledger.sources.map(s => s.processId))
  if (!ok(candidates)) fail('REFERENCE_CANDIDATES_FAILED')
  const choices = Object.values(candidates.body.data ?? {}).flat(); const reference = choices.find(c => c.declaredUnitId === config.tonneUnitId)
  if (!reference?.elementName) fail('REFERENCE_CANDIDATES_INVALID')
  ledger.status = 'preview-pending'; await persist()
  const preview = await request(baseUrl, '/api/dataset/dataset/merge-preview', { name: ledger.resultName, resultReferenceProductName: reference.elementName,
    resultReferenceProductUnitId: config.tonneUnitId, dataSet: ledger.sources.map(s => ({ id: s.processId, x: '0.500' })) })
  if (!ok(preview)) { ledger.status = 'preview-rejected'; await persist(); fail('PREVIEW_FAILED') }
  ledger.snapshotId = preview.body.data?.snapshotId; await persist()
  const body = confirmBody(preview.body.data)
  if (body.mergedItems.find(g => g.mergeType === 'REFERENCE_PRODUCT').result.unitId !== config.tonneUnitId) fail('RESULT_UNIT_MISMATCH')
  ledger.status = 'confirm-pending'; await persist()
  const confirmed = await request(baseUrl, '/api/dataset/dataset/do-merge', body)
  if (!ok(confirmed)) { ledger.status = 'confirm-rejected'; await persist(); fail('CONFIRM_FAILED') }
  if (!uuid(confirmed.body.data)) fail('CONFIRM_FAILED')
  ledger.resultId = confirmed.body.data; await persist()
  const proof = await operate('inspect', config, ledger); ledger.resources = proof.resources; await persist()
  ledger.referenceProof = proof.referenceResults; ledger.previewReferenceValue = preview.body.data.mergedItems.find(g => g.mergeType === 'REFERENCE_PRODUCT').result.resultValue; await persist()
  if (proof.referenceResults.length !== 1 || exactDecimal(proof.referenceResults[0][1]) !== '1' || proof.referenceResults[0][2] !== config.tonneUnitId || proof.referenceResults[0][3] !== config.tonneUnitId) fail('PERSISTED_RESULT_MISMATCH')
  ledger.actual = JSON.stringify({ sourceCount: sourceProof.sourceResults.length, sourceValue: exactDecimal(sourceProof.sourceResults[0][1]), sourceUnit: 'kg', declaredUnit: 't', weightSum: '1', resultValue: exactDecimal(proof.referenceResults[0][1]), resultUnit: 't', persisted: true })
  ledger.status = 'passed'; await persist()
  return { namespace: input.namespace, baseUrl, actual: ledger.actual }
}

async function remoteReview(mode, config, input) {
  if (!['initialize', 'execute', 'cleanup', 'verify-cleanup'].includes(mode) || config.uatEnvironment !== 'uat2' || config.ssoOrigin !== 'https://editor2.hiqdat.dev'
    || !['evidenceRoot', 'accountsFile', 'playwrightModule'].every(key => isAbsolute(config[key] ?? '')) || config.accountKey !== 'editor_uat_admin') fail('CONFIG_INVALID')
  if (input.uatEnvironment !== 'uat2' || !/^acceptance-[a-f0-9]{32}$/.test(input.namespace ?? '')) fail('INPUT_INVALID')
  const fixture = config.reviewFixture
  if (!fixture || !/^[a-zA-Z0-9-]+$/.test(fixture.applicationId ?? '') || !/^[a-zA-Z0-9-]+$/.test(fixture.processId ?? '')) fail('FIXTURE_REQUIRED')
  const origin = remoteOrigin(input.baseUrl, 'https://editor2.hiqdat.dev'), directory = join(config.evidenceRoot, input.namespace)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'review-ledger.json')
  let ledger
  try { ledger = await json(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (ledger && (ledger.namespace !== input.namespace || ledger.baseUrl !== origin)) fail('LEDGER_IDENTITY')
  const persist = () => writeFile(path, JSON.stringify(ledger, null, 2))
  const stage = async value => { ledger.stage = value; await persist() }
  if (mode === 'initialize') {
    if (ledger) fail('ALREADY_INITIALIZED')
    ledger = { namespace: input.namespace, baseUrl: origin, fixture, initialized: true, executionStarted: false,
      browserClosed: true, sessionClosed: true, businessWrites: 0, blockedRequests: [], passed: false }
    await writeFile(path, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 })
    return { namespace: input.namespace, initialized: true }
  }
  if (mode !== 'execute') {
    if (!ledger || ledger.browserClosed !== true || ledger.sessionClosed !== true || ledger.businessWrites !== 0) fail('CLEANUP_UNCONFIRMED')
    return mode === 'cleanup' ? { namespace: input.namespace, mode: 'read-only', createdResources: 0 } : { namespace: input.namespace, empty: true, mode: 'read-only', createdResources: 0 }
  }
  if (!ledger?.initialized) fail('LEDGER_MISSING')
  if (ledger.executionStarted) fail('ALREADY_EXECUTED')
  if (Object.keys(input.case?.parameters ?? {}).length) fail('PARAMETERS_INVALID')
  ledger.executionStarted = true; await persist()
  let session, browser, page, result
  const request = async (base, route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', 'X-Site': '101', ...(session ? { Authorization: session.accessToken, accessToken: session.accessToken, userId: String(session.userId), Cookie: `accessToken=${session.accessToken}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json()
    if (!response.ok || !success(data)) fail('REQUEST_FAILED')
    return data.data
  }
  try {
    await stage('login')
    const account = (await json(config.accountsFile)).accounts?.[config.accountKey]
    if (!account?.username || !account.password) fail('ACCOUNT_REQUIRED')
    ledger.sessionClosed = false; await persist()
    session = await request(config.ssoOrigin, '/api/sso/auth/login', 'POST', { username: account.username, password: account.password, grantType: 'PASSWORD' })
    const q = `?applicationId=${encodeURIComponent(fixture.applicationId)}`
    await stage('reviewer-context')
    const context = await request(origin, '/api/dataset/approval/reviewContext' + q)
    const records = await request(origin, '/api/dataset/approval/reviewDetail' + q)
    if (context.processId !== fixture.processId || !eligibleReviewer(context, records, session.userId)) fail('REVIEWER_NOT_ELIGIBLE')
    const { chromium } = await import(pathToFileURL(config.playwrightModule).href)
    await stage('browser-launch')
    ledger.browserClosed = false; await persist()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const browserContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    await browserContext.addCookies([{ name: 'user', value: encodeURIComponent(JSON.stringify(session)), url: origin, sameSite: 'Lax' }, { name: 'accessToken', value: session.accessToken, url: origin, sameSite: 'Lax' }])
    await browserContext.route('**/*', async route => {
      const req = route.request(); let body
      if (req.postData() !== null) { try { body = req.postDataJSON() } catch { body = null } }
      if (reviewRequestAllowed(req.url(), req.method(), origin, req.resourceType(), body, fixture)) return route.continue()
      if (!optionalTelemetry(req.url(), req.method(), req.resourceType())) ledger.blockedRequests.push({ method: req.method(), path: new URL(req.url()).pathname })
      return route.abort()
    })
    await browserContext.routeWebSocket('**/*', socket => socket.close())
    page = await browserContext.newPage()
    const url = origin + `/dataset/review/${fixture.processId}` + q
    await stage('open-review')
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await stage('fill-opinion')
    const active = page.locator('.review-dimension-panel .audit-content:visible')
    await active.locator('.custom-dim-head button').click({ timeout: 20000 })
    const card = active.locator('.custom-dim-card').last()
    await card.locator('.cd-label input').fill(`${input.namespace} 自定义验收维度`)
    const field = card.locator('textarea')
    const text = `${input.namespace} 评审意见保存回显验证`
    await field.fill(text, { timeout: 20000 })
    await stage('save-draft')
    await page.getByRole('button', { name: /保存草稿|Save draft/ }).click()
    await page.getByText(/草稿已保存|草稿保存成功|Draft saved/).first().waitFor({ timeout: 10000 })
    await stage('restore-draft')
    await page.goto(origin + '/unit', { waitUntil: 'networkidle', timeout: 60000 })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    const actual = await field.inputValue({ timeout: 20000 })
    if (actual !== text) fail('DRAFT_NOT_RESTORED')
    if (ledger.blockedRequests.length) fail('UNEXPECTED_REQUEST')
    await page.screenshot({ path: join(directory, 'review-restored.png') })
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) fail('STORAGE_NOT_CLEARED')
    ledger.passed = true
    result = { namespace: input.namespace, baseUrl: origin, actual: JSON.stringify({ saved: true, restored: true, browserStorageCleared: true }) }
  } catch (error) {
    ledger.failure = error.code?.startsWith('REVIEW_ACCEPTANCE_') ? error.code : error.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : 'EXECUTION_ERROR'
    if (page && !page.isClosed()) {
      ledger.page = { path: new URL(page.url()).pathname,
        reviewPanels: await page.locator('.review-dimension-panel').count(),
        activeForms: await page.locator('.audit-content:visible').count(),
        editableOpinions: await page.locator('.review-dimension-panel textarea:visible:not([disabled])').count(),
        saveButtons: await page.getByRole('button', { name: /保存草稿|Save draft/ }).count(),
        contextErrors: await page.locator('.review-context-error').count() }
      await page.screenshot({ path: join(directory, 'review-failed.png') }).catch(() => {})
    }
    await persist()
    throw error
  } finally {
    try { if (browser) { await browser.close(); ledger.browserClosed = true } }
    finally {
      if (session) {
        await request(config.ssoOrigin, '/api/sso/auth/logout', 'POST', {})
        const response = await fetch(config.ssoOrigin + '/api/sso/user/info/current?productCode=hiq_editor', { headers: { Authorization: session.accessToken, accessToken: session.accessToken, 'X-Site': '101' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
        const data = await response.json(); if (response.status !== 401 && String(data.code) !== '401') fail('SESSION_NOT_CLOSED')
        ledger.sessionClosed = true
      }
      await persist()
    }
  }
  return result
}
async function main(){
const ROOT=resolve('docs/tmp/round43-uat'),runtime='D:/dsh_home/workflows/runtime-v2/local-acceptance'
const mode=process.argv[2]
if(!['--check','--execute','--backend-execute'].includes(mode)||process.argv.length!==3)fail('ARGUMENTS_INVALID')
await mkdir(ROOT,{recursive:true})
const merge=await json(runtime+'/merge-uat3-0a18c059dedd.json'),review=await json(runtime+'/review-8c4afbd79cb89b67.json')
merge.sourceRepository=join(ROOT,'dataset-source')
merge.sourceCommit='3ea89c0d4daf970a5be9b8a7d40e7ec81f2da842'
merge.evidenceRoot=join(ROOT,'private-merge');review.evidenceRoot=join(ROOT,'private-review')
merge.ssoOrigin='https://editor3.hiqdat.dev'
const capture=async(project,commit,pipeline)=>{const p=await exec(process.execPath,[resolve('docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs'),'--project',project,'--commit',commit,'--pipeline',String(pipeline)],{windowsHide:true,timeout:120000,maxBuffer:1000000});const result=JSON.parse(p.stdout);await writeFile(join(ROOT,project+'-identity.json'),JSON.stringify(result,null,2));return result}
const identities=await Promise.all([capture('dataset',merge.sourceCommit,277),capture('dataset-web','d1e447787201212140a2732b798d336965ddfaa7',320)])
const preflight=await checkMerge(merge)
if(!preflight.ready)fail('MERGE_PREFLIGHT_BLOCKED')
const check={at:new Date().toISOString(),mode,ready:true,urls:['https://editor3.hiqdat.dev/api/dataset','https://editor2.hiqdat.dev'],identities:identities.map(x=>({project:x.project,commit:x.commit,pipeline:x.pipeline,imageDigest:x.build.imageDigest,passed:x.passed})),mergePreflight:preflight,writes:0}
await writeFile(join(ROOT,'check.json'),JSON.stringify(check,null,2))
if(mode==='--check'){console.log(JSON.stringify({ready:true,writes:0,evidence:join(ROOT,'check.json')}));process.exit(0)}
const results=[]
for(const [name,fn,config,baseUrl,env]of[['backend',remoteMerge,merge,'https://editor3.hiqdat.dev','uat3'],['frontend',remoteReview,review,'https://editor2.hiqdat.dev','uat2']]){
 if(mode==='--backend-execute'&&name==='frontend')continue
 const input={namespace:'acceptance-'+randomUUID().replaceAll('-',''),baseUrl,uatEnvironment:env,case:{parameters:{}}};let result,cleanup,verification,failure
 await fn('initialize',config,input)
 try{result=await fn('execute',config,input)}catch(e){failure=e.code??'REMOTE_EXECUTION_FAILED'}
 finally{try{cleanup=await fn('cleanup',config,input);verification=await fn('verify-cleanup',config,input)}catch(e){failure=(failure??'')+' '+(e.code??'REMOTE_CLEANUP_FAILED')}}
 const record={at:new Date().toISOString(),name,input,result,cleanup,verification,failure,passed:!failure&&Boolean(result)&&verification?.empty===true}
 await writeFile(join(ROOT,name+'-'+input.namespace+'.json'),JSON.stringify(record,null,2));
 await writeFile(join(ROOT,name+'-business.json'),JSON.stringify(record,null,2));results.push({name,passed:record.passed,failure})
}
console.log(JSON.stringify({results,evidenceRoot:ROOT}));if(results.some(x=>!x.passed))process.exitCode=1

}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(typeof e.code==="string"&&/^(REMOTE_UAT|MERGE_ACCEPTANCE)_[A-Z_]+$/.test(e.code)?e.code:"REMOTE_UAT_FAILED");process.exitCode=1})
