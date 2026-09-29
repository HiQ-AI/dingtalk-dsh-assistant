import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const fail = code => { throw Object.assign(new Error(code), { code: `READONLY_ACCEPTANCE_${code}` }) }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype
const endpoints = Object.freeze({ units: '/unit/getPage', drafts: '/processDraft/query', workspace: '/dataWorkspace/getWorkspacePage' })
const operations = new Set(['api', 'browser', 'cleanup', 'verify-cleanup'])
const sensitive = /password|token|secret|authorization|cookie|credential/i
const success = body => body && (body.code === 200 || body.code === '200' || body.code === 0 || body.code === '0') && body.success !== false
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)

export function localOrigin(value) {
  let url
  try { url = new URL(value) } catch { fail('ORIGIN_INVALID') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('ORIGIN_INVALID')
  return url.origin
}
export function projectResult(body, projections) {
  if (!Array.isArray(projections) || !projections.length || projections.length > 16) fail('PROJECTION_INVALID')
  const result = Object.create(null)
  for (const item of projections) {
    if (!plain(item) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.name) || sensitive.test(item.name) || Object.hasOwn(result, item.name)
      || !Array.isArray(item.path) || !item.path.length || item.path.length > 12
      || item.path.some(key => !(typeof key === 'string' || Number.isSafeInteger(key)) || sensitive.test(String(key)) || ['__proto__', 'prototype', 'constructor'].includes(key))
      || !['value', 'type', 'count', 'nonempty'].includes(item.op)) fail('PROJECTION_INVALID')
    let value = body
    for (const key of item.path) { if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('PROJECTION_MISSING'); value = value[key] }
    if (item.op === 'type') value = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    else if (item.op === 'count') { if (!Array.isArray(value) && typeof value !== 'string') fail('PROJECTION_TYPE'); value = value.length }
    else if (item.op === 'nonempty') value = Array.isArray(value) || typeof value === 'string' ? value.length > 0 : plain(value) ? Object.keys(value).length > 0 : value !== null && value !== undefined
    else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) fail('PROJECTION_TYPE')
    result[item.name] = value
  }
  const actual = JSON.stringify(result)
  if (Buffer.byteLength(actual) > 1600) fail('OUTPUT_TOO_LARGE')
  return actual
}
const layoutQueries = Object.freeze({
  '/api/dataset/approval/list': { approvalType: 1, completeType: 0, approvalStatusList: [], page: 1, size: 1 },
  '/api/dataset/message/list': { messageType: null, isRead: false, pageNum: 1, pageSize: 1 },
})
const layoutReads = new Set(['/api/dataset/enum/process/common', '/api/dataset/datasourceInfo/getTenantDatasource', '/api/dataset/system/log/getSystemModule', '/api/dataset/system/log/getSystemFunction'])
function exactLayoutBody(value, expected) {
  return Boolean(plain(value)) && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, entry]) => Object.hasOwn(value, key)
      && (Array.isArray(entry) ? Array.isArray(value[key]) && value[key].length === 0 : value[key] === entry))
}
export function browserRequestAllowed(urlValue, method, origin, resourceType, body) {
  let url
  try { url = new URL(urlValue) } catch { return false }
  if (url.origin !== origin || url.username || url.password || /%2f|%5c|\.\./i.test(url.pathname)) return false
  if (url.pathname === '/app-config.json') return method === 'GET' && !url.search && body === undefined
  if (method === 'HEAD') return url.pathname === '/' && /^\?cv=0\.\d+$/.test(url.search) && body === undefined
  if (Object.hasOwn(layoutQueries, url.pathname)) return method === 'POST' && !url.search && exactLayoutBody(body, layoutQueries[url.pathname])
  if (layoutReads.has(url.pathname)) return method === 'GET' && !url.search && body === undefined
  if (Object.values(endpoints).some(path => url.pathname === `/api/dataset${path}`)) return method === 'POST' && !url.search
  if (url.pathname === '/api/dataset/ready') return method === 'GET' && !url.search
  if (url.pathname === '/api/sso/user/info/current') return method === 'GET' && [...url.searchParams].every(([key, value]) => key === 'productCode' && value === 'hiq_editor')
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/sockjs')) return false
  return method === 'GET' && ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(resourceType) && !url.search
}
// 当前前端 public/index.html 与 src/log/monitor.js 声明的遥测；始终阻断，绝不放行外发。
export function optionalTelemetry(urlValue, method, resourceType) {
  let url
  try { url = new URL(urlValue) } catch { return false }
  if (url.username || url.password || url.protocol !== 'https:') return false
  return method === 'GET' && resourceType === 'script' && (
    url.origin === 'https://o.alicdn.com' && url.pathname === '/QTSDK/quicktracking-sdk/qt_web.cjs.js'
    || url.origin === 'https://www.googletagmanager.com' && url.pathname === '/gtag/js')
    || method === 'POST' && ['xhr', 'fetch', 'other'].includes(resourceType)
      && url.origin === 'https://editor.hiqlcd.com' && url.pathname === '/collect'
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink() || canonical(await realpath(directory)) !== canonical(directory)) fail('UNSAFE_DIRECTORY')
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    await exec('icacls', [directory, '/inheritance:r', '/grant:r', `*${stdout.match(/S-1-[0-9-]+/)?.[0]}:(OI)(CI)F`], { windowsHide: true })
  }
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function maybeJson(path) { try { return await json(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function save(path, value) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }) }
function headers(session) { return { 'Content-Type': 'application/json', 'X-Site': '101', ...(session ? { Authorization: session.data.accessToken, accessToken: session.data.accessToken, userId: String(session.data.userId), Cookie: `accessToken=${session.data.accessToken}` } : {}) } }

export async function executeReadOnly(mode, config, input) {
  if (!operations.has(mode) || !plain(config) || config.uatEnvironment !== 'uat2' || config.ssoOrigin !== 'https://editor2.hiqdat.dev'
    || !['evidenceRoot', 'accountsFile', 'playwrightModule'].every(key => isAbsolute(config[key] ?? '')) || config.accountKey !== 'editor_uat_admin') fail('CONFIG_INVALID')
  if (!plain(input) || input.uatEnvironment !== config.uatEnvironment || !/^acceptance-[a-f0-9]{32}$/.test(input.namespace ?? '')) fail('INPUT_INVALID')
  if (input.evidenceRoot !== undefined && !isAbsolute(input.evidenceRoot)) fail('INPUT_INVALID')
  const baseUrl = localOrigin(input.baseUrl), directory = join(input.evidenceRoot ?? config.evidenceRoot, input.namespace)
  await privateDirectory(directory)
  const ledgerPath = join(directory, 'ledger.json'), sessionPath = join(directory, 'session.json')
  let ledger = await maybeJson(ledgerPath)
  if (!ledger) {
    if (mode === 'verify-cleanup') fail('LEDGER_MISSING')
    ledger = { namespace: input.namespace, baseUrl, uatEnvironment: input.uatEnvironment, mode: 'read-only', createdResources: 0, sessionState: 'none', browserState: 'closed', requests: [] }
  }
  if (ledger.namespace !== input.namespace || ledger.baseUrl !== baseUrl || ledger.uatEnvironment !== input.uatEnvironment) fail('LEDGER_IDENTITY')
  let writes = Promise.resolve()
  const persist = () => { const snapshot = structuredClone(ledger); writes = writes.then(() => save(ledgerPath, snapshot)); return writes }
  const record = async (kind, path, method, allowed = true) => { ledger.requests.push({ kind, path, method, allowed }); if (ledger.requests.length > 4000) fail('REQUEST_LIMIT'); await persist() }
  const request = async (origin, path, method, body, session, kind) => {
    await record(kind, path, method)
    let response
    try { response = await fetch(origin + path, { method, headers: headers(session), redirect: 'error', signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { fail('REQUEST_FAILED') }
    const raw = await response.text()
    if (raw.length > 2_000_000) fail('RESPONSE_TOO_LARGE')
    let data
    try { data = JSON.parse(raw) } catch { fail('RESPONSE_INVALID') }
    return { status: response.status, body: data }
  }
  const current = session => request(config.ssoOrigin, '/api/sso/user/info/current?productCode=hiq_editor', 'GET', undefined, session, 'session-check')
  const login = async () => {
    if (ledger.sessionState === 'active') { const session = await json(sessionPath); if (session.namespace !== input.namespace) fail('SESSION_IDENTITY'); return session }
    if (ledger.sessionState !== 'none') fail('SESSION_UNKNOWN')
    const account = (await json(config.accountsFile)).accounts?.[config.accountKey]
    if (!account?.username || !account?.password) fail('ACCOUNT_MISSING')
    ledger.sessionState = 'login-pending'; await persist()
    const response = await request(config.ssoOrigin, '/api/sso/auth/login', 'POST', { username: account.username, password: account.password, grantType: 'PASSWORD' }, undefined, 'login')
    if (response.status !== 200 || !success(response.body) || typeof response.body.data?.accessToken !== 'string' || !response.body.data.userId) fail('LOGIN_UNCONFIRMED')
    const session = { namespace: input.namespace, data: response.body.data }
    await save(sessionPath, session)
    ledger.sessionState = 'active'; await persist()
    return session
  }
  const checkNotLoggedIn = response => response.status === 401 || response.body?.code === 401 || response.body?.code === '401'
  if (mode === 'cleanup') {
    if (ledger.browserState !== 'closed') fail('BROWSER_NOT_CLOSED')
    if (ledger.sessionState === 'login-pending') fail('SESSION_UNKNOWN')
    if (ledger.sessionState === 'active' || ledger.sessionState === 'logout-pending') {
      const session = await json(sessionPath)
      if (session.namespace !== input.namespace) fail('SESSION_IDENTITY')
      ledger.sessionState = 'logout-pending'; await persist()
      const response = await request(config.ssoOrigin, '/api/sso/auth/logout', 'POST', {}, session, 'logout')
      if (response.status !== 200 || !success(response.body)) fail('LOGOUT_UNCONFIRMED')
      if (!checkNotLoggedIn(await current(session))) fail('SESSION_STILL_ACTIVE')
      ledger.sessionState = 'logged-out'; await persist()
    }
    await persist()
    return { namespace: input.namespace, mode: 'read-only', createdResources: 0 }
  }
  if (mode === 'verify-cleanup') {
    if (ledger.mode !== 'read-only' || ledger.createdResources !== 0 || ledger.browserState !== 'closed' || !['none', 'logged-out'].includes(ledger.sessionState)) fail('CLEANUP_UNCONFIRMED')
    for (const item of ledger.requests) {
      const allowed = item.kind === 'api' ? item.method === 'POST' && Object.values(endpoints).includes(item.path)
        : item.kind === 'browser' ? browserRequestAllowed(baseUrl + item.path, item.method, baseUrl, item.resourceType, item.body)
          : item.kind === 'login' ? item.method === 'POST' && item.path === '/api/sso/auth/login'
            : item.kind === 'logout' ? item.method === 'POST' && item.path === '/api/sso/auth/logout'
              : item.kind === 'session-check' ? item.method === 'GET' && item.path === '/api/sso/user/info/current?productCode=hiq_editor'
                : item.kind === 'ready' && item.method === 'GET' && ['/ready', '/api/dataset/ready'].includes(item.path)
      // 被浏览器拦截的请求未发送；保留审计记录，但不冒充写入后已清理。
      if (item.allowed !== false && !allowed) fail('LEDGER_REQUEST_INVALID')
    }
    if (ledger.sessionState === 'logged-out' && !checkNotLoggedIn(await current(await json(sessionPath)))) fail('SESSION_STILL_ACTIVE')
    return { namespace: input.namespace, empty: true, mode: 'read-only', createdResources: 0 }
  }
  const parameters = input.case?.parameters
  if (!plain(parameters)) fail('PARAMETERS_INVALID')
  let actual
  if (mode === 'api') {
    if (Object.keys(parameters).some(key => !['endpoint', 'body', 'projections'].includes(key)) || !Object.hasOwn(endpoints, parameters.endpoint) || !plain(parameters.body) || Buffer.byteLength(JSON.stringify(parameters.body)) > 16000) fail('PARAMETERS_INVALID')
    const session = await login()
    const response = await request(baseUrl, endpoints[parameters.endpoint], 'POST', parameters.body, session, 'api')
    if (response.status !== 200 || !success(response.body)) fail('BUSINESS_QUERY_FAILED')
    actual = projectResult(response.body, parameters.projections)
    if (actual.includes(session.data.accessToken)) fail('SECRET_OUTPUT')
  } else {
    if (Object.keys(parameters).some(key => !['path', 'selector', 'read', 'authenticate'].includes(key)) || typeof parameters.path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(parameters.path) || parameters.path.startsWith('/api/')
      || typeof parameters.selector !== 'string' || !parameters.selector.trim() || parameters.selector.length > 300 || parameters.selector.includes('>>')
      || !['text', 'count', 'visible'].includes(parameters.read) || (parameters.authenticate !== undefined && typeof parameters.authenticate !== 'boolean')) fail('PARAMETERS_INVALID')
    if (!plain(input.services?.dataset) || !/^[a-f0-9]{64}$/i.test(input.services.dataset.artifactSha256 ?? '')) fail('DATASET_BINDING_UNCONFIRMED')
    const dataset = localOrigin(input.services.dataset.baseUrl)
    const backend = await request(dataset, '/ready', 'GET', undefined, undefined, 'ready')
    await record('ready', '/api/dataset/ready', 'GET')
    const frontend = await fetch(baseUrl + '/api/dataset/ready', { redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (frontend.headers.get('x-local-acceptance-dataset-origin') !== dataset || frontend.headers.get('x-local-acceptance-dataset-sha256')?.toLowerCase() !== input.services.dataset.artifactSha256.toLowerCase() || backend.body.status !== 'UP' || !frontend.ok || JSON.stringify(await frontend.json()) !== JSON.stringify(backend.body)) fail('DATASET_BINDING_UNCONFIRMED')
    const session = parameters.authenticate ? await login() : null
    const { chromium } = await import(pathToFileURL(config.playwrightModule).href)
    let browser
    ledger.browserState = 'starting'; await persist()
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true })
      ledger.browserState = 'active'; await persist()
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
      if (session) await context.addCookies([{ name: 'user', value: encodeURIComponent(JSON.stringify(session.data)), url: baseUrl, sameSite: 'Lax' }, { name: 'accessToken', value: session.data.accessToken, url: baseUrl, sameSite: 'Lax' }])
      let blocked = false
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url())
        let body
        if (req.postData() !== null) { try { body = req.postDataJSON() } catch { body = null } }
        const allowed = browserRequestAllowed(req.url(), req.method(), baseUrl, req.resourceType(), body)
        const telemetry = !allowed && optionalTelemetry(req.url(), req.method(), req.resourceType())
        ledger.requests.push({ kind: 'browser', path: allowed ? url.pathname + url.search : url.pathname, originHost: url.host, method: req.method(), resourceType: req.resourceType(), allowed,
          ...(allowed && Object.hasOwn(layoutQueries, url.pathname) ? { body } : {}), ...(telemetry ? { blockedReason: 'optional-telemetry' } : {}) })
        await persist()
        if (!allowed) { if (!telemetry) blocked = true; return route.abort() }
        return route.continue()
      })
      await context.routeWebSocket('**/*', socket => { blocked = true; socket.close() })
      const page = await context.newPage()
      await page.goto(baseUrl + parameters.path, { waitUntil: 'networkidle', timeout: 30000 })
      const locator = page.locator(`css=${parameters.selector}`)
      if (parameters.read === 'text') actual = (await locator.innerText({ timeout: 10000 })).trim()
      else if (parameters.read === 'count') actual = String(await locator.count())
      else actual = String(await locator.isVisible())
      if (blocked) fail('BROWSER_REQUEST_BLOCKED')
      if (!actual || actual.length > 1600 || (session && actual.includes(session.data.accessToken))) fail('OUTPUT_INVALID')
      await page.screenshot({ path: join(directory, 'browser.png'), fullPage: false })
    } finally {
      if (browser) { await browser.close(); ledger.browserState = 'closed'; await persist() }
    }
  }
  await persist()
  return { namespace: input.namespace, baseUrl, actual }
}

async function main() {
  const [mode, flag, configPath, ...extra] = process.argv.slice(2)
  if (!operations.has(mode) || flag !== '--config' || !isAbsolute(configPath ?? '') || extra.length) fail('CLI_INVALID')
  let stdin = ''
  for await (const chunk of process.stdin) { stdin += chunk; if (Buffer.byteLength(stdin) > 64000) fail('INPUT_TOO_LARGE') }
  const output = await executeReadOnly(mode, await json(configPath), JSON.parse(stdin))
  process.stdout.write(JSON.stringify(output) + '\n')
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  process.stderr.write((typeof error.code === 'string' && error.code.startsWith('READONLY_ACCEPTANCE_') ? error.code : 'READONLY_ACCEPTANCE_FAILED') + '\n'); process.exitCode = 1
})
