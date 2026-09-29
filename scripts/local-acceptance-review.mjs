import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localOrigin, browserRequestAllowed, optionalTelemetry } from './local-acceptance-readonly.mjs'
const fail = code => { throw Object.assign(new Error(code), { code: `REVIEW_ACCEPTANCE_${code}` }) }
const success = value => ['200', '0'].includes(String(value?.code))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const types = ['INDUSTRY_EXPERT', 'LCA_EXPERT']
export function reviewRequestAllowed(value, method, origin, resourceType, body, fixture) {
  const url = new URL(value)
  if (url.origin !== origin || /%2f|%5c|\.\./i.test(url.pathname)) return false
  const query = (...names) => [...url.searchParams.keys()].every(key => names.includes(key))
  if (url.pathname === `/dataset/review/${fixture.processId}`) return method === 'GET' && url.searchParams.get('applicationId') === fixture.applicationId && query('applicationId')
  if (['/api/dataset/approval/reviewContext', '/api/dataset/approval/reviewTemplate', '/api/dataset/approval/reviewDetail'].includes(url.pathname))
    return method === 'GET' && url.searchParams.get('applicationId') === fixture.applicationId && query('applicationId')
  if (url.pathname === '/api/dataset/approval/attachment/pending') return method === 'GET' && url.searchParams.get('applicationId') === fixture.applicationId && types.includes(url.searchParams.get('reviewType')) && query('applicationId', 'reviewType')
  if (url.pathname === '/api/dataset/data/getNewDataDetails') return method === 'POST' && !url.search && body?.processId === fixture.processId && body.scene === 0 && ['baseInfo', 'managerInfo'].includes(body.isShow) && Object.keys(body).every(key => ['processId', 'scene', 'isShow'].includes(key))
  if (url.pathname === '/api/dataset/dataHouse/model/check/info') return method === 'GET' && url.searchParams.get('processId') === fixture.processId && ['0', null].includes(url.searchParams.get('scene')) && query('processId', 'scene')
  if (url.pathname.startsWith('/api/dataset/categories/detail/')) return method === 'GET' && /^\/api\/dataset\/categories\/detail\/[a-zA-Z0-9-]+$/.test(url.pathname) && !url.search
  if (url.pathname === '/api/dataset/basicInfo/flow/product/list') return method === 'GET' && query('name', 'page', 'size', 'pageNum', 'pageSize')
  return browserRequestAllowed(value, method, origin, resourceType, body)
}
export function eligibleReviewer(context, records, userId) {
  return (context.reviewers ?? []).some(r => String(r.id) === String(userId) && types.includes(r.type)
    && !(records ?? []).some(x => String(x.reviewerId) === String(userId) && x.reviewType === r.type
      && (['APPROVED', 'REJECTED'].includes(x.status) || Number(x.round || 1) === Number(context.currentRound || 1))))
}
export async function executeReview(mode, config, input) {
  if (!['initialize', 'execute', 'cleanup', 'verify-cleanup'].includes(mode) || config.uatEnvironment !== 'uat2' || config.ssoOrigin !== 'https://editor2.hiqdat.dev'
    || !['evidenceRoot', 'accountsFile', 'playwrightModule'].every(key => isAbsolute(config[key] ?? '')) || config.accountKey !== 'editor_uat_admin') fail('CONFIG_INVALID')
  if (input.uatEnvironment !== 'uat2' || !/^acceptance-[a-f0-9]{32}$/.test(input.namespace ?? '')) fail('INPUT_INVALID')
  const fixture = config.reviewFixture
  if (!fixture || !/^[a-zA-Z0-9-]+$/.test(fixture.applicationId ?? '') || !/^[a-zA-Z0-9-]+$/.test(fixture.processId ?? '')) fail('FIXTURE_REQUIRED')
  if (input.evidenceRoot !== undefined && !isAbsolute(input.evidenceRoot)) fail('INPUT_INVALID')
  const origin = localOrigin(input.baseUrl), directory = join(input.evidenceRoot ?? config.evidenceRoot, input.namespace)
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
  if (!input.services?.dataset?.artifactSha256) fail('BACKEND_BINDING_REQUIRED')
  const backend = localOrigin(input.services.dataset.baseUrl)
  ledger.executionStarted = true; await persist()
  const ready = await fetch(origin + '/api/dataset/ready', { redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!ready.ok || ready.headers.get('x-local-acceptance-dataset-origin') !== backend || ready.headers.get('x-local-acceptance-dataset-sha256') !== input.services.dataset.artifactSha256) fail('BACKEND_BINDING_REQUIRED')
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
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, flag, configPath, ...extra] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (flag !== '--config' || !isAbsolute(configPath ?? '') || extra.length) fail('CLI_INVALID')
    let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 64000) fail('INPUT_INVALID') }
    console.log(JSON.stringify(await executeReview(mode, await json(configPath), JSON.parse(raw))))
  }).catch(error => { console.error(error.code?.startsWith('REVIEW_ACCEPTANCE_') ? error.code : 'REVIEW_ACCEPTANCE_FAILED'); process.exitCode = 1 })
}
