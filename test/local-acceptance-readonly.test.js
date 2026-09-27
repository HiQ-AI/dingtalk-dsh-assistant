import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeReadOnly, projectResult, browserRequestAllowed, optionalTelemetry, localOrigin } from '../scripts/local-acceptance-readonly.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-readonly-'))
  const accountsFile = join(root, 'account.json')
  await writeFile(accountsFile, JSON.stringify({ accounts: { editor_uat_admin: { username: 'fixture-user', password: 'fixture-secret' } } }))
  return { config: { uatEnvironment: 'uat2', evidenceRoot: join(root, 'evidence'), accountsFile, accountKey: 'editor_uat_admin', ssoOrigin: 'https://editor2.hiqdat.dev', playwrightModule: join(root, 'playwright.mjs') },
    input: { namespace: 'acceptance-' + 'a'.repeat(32), baseUrl: 'http://127.0.0.1:12345', uatEnvironment: 'uat2', case: { expected: 'not-the-actual-value', parameters: { endpoint: 'units', body: { page: 1, size: 2 }, projections: [{ name: 'rows', path: ['data'], op: 'count' }] } } } }
}
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

test('既有固定遥测非fatal但仍阻断；未知远端与业务依赖不能冒充遥测', () => {
  for (const url of ['https://o.alicdn.com/QTSDK/quicktracking-sdk/qt_web.cjs.js', 'https://www.googletagmanager.com/gtag/js?id=example']) {
    assert.equal(optionalTelemetry(url, 'GET', 'script'), true)
    assert.equal(browserRequestAllowed(url, 'GET', 'http://127.0.0.1:12345', 'script'), false)
  }
  assert.equal(optionalTelemetry('https://editor.hiqlcd.com/collect', 'POST', 'xhr'), true)
  for (const url of ['https://editor.hiqlcd.com/api/dataset/unit/getPage', 'https://unknown.example/collect', 'https://o.alicdn.com/other.js', 'https://www.googletagmanager.com/unknown']) assert.equal(optionalTelemetry(url, 'GET', 'script'), false)
})

test('固定只读路由允许查询，拒绝任意URL、写API、远端、脚本请求和编码路径', () => {
  const origin = 'http://127.0.0.1:12345'
  assert.equal(localOrigin(origin), origin)
  for (const url of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.0.0.1:12345/x', 'http://user@127.0.0.1:12345']) assert.throws(() => localOrigin(url))
  for (const path of ['/unit/getPage', '/processDraft/query', '/dataWorkspace/getWorkspacePage']) assert.equal(browserRequestAllowed(origin + '/api/dataset' + path, 'POST', origin, 'xhr'), true)
  assert.equal(browserRequestAllowed(origin + '/api/sso/user/info/current?productCode=hiq_editor', 'GET', origin, 'xhr'), true)
  assert.equal(browserRequestAllowed(origin + '/js/app.js', 'GET', origin, 'script'), true)
  for (const [url, method, type] of [[origin + '/api/dataset/processDraft/delete/1', 'POST', 'xhr'], [origin + '/api/dataset/ai/refit/optimize', 'POST', 'xhr'], ['https://remote.invalid/x', 'GET', 'image'], [origin + '/api%2fdataset/x', 'GET', 'document'], [origin + '/foo', 'POST', 'document'], [origin + '/foo', 'GET', 'fetch'], [origin + '/api/sso/user/info/current?token=secret', 'GET', 'xhr']]) assert.equal(browserRequestAllowed(url, method, origin, type), false)
})

test('投影只输出提取实际值，不返回完整响应或凭据字段', () => {
  const body = { code: '200', data: [{ name: '单位' }], secret: 'hidden' }
  assert.equal(projectResult(body, [{ name: 'count', path: ['data'], op: 'count' }, { name: 'type', path: ['data'], op: 'type' }, { name: 'filled', path: ['data'], op: 'nonempty' }]), '{"count":1,"type":"array","filled":true}')
  for (const path of [['secret'], ['accessToken'], ['__proto__'], ['missing']]) assert.throws(() => projectResult(body, [{ name: 'value', path, op: 'value' }]))
  assert.throws(() => projectResult(body, [{ name: 'all', path: ['data'], op: 'value' }]))
})

test('运行配置与版本探针仅精确准入本地固定路径，不泛化fetch或HEAD', () => {
  const origin = 'http://127.0.0.1:12345'
  assert.equal(browserRequestAllowed(origin + '/app-config.json', 'GET', origin, 'fetch'), true)
  assert.equal(browserRequestAllowed(origin + '/?cv=0.123456', 'HEAD', origin, 'xhr'), true)
  for (const [path, method, type] of [['/other.json', 'GET', 'fetch'], ['/app-config.json?secret=x', 'GET', 'fetch'], ['/app-config.json', 'POST', 'fetch'], ['/', 'HEAD', 'xhr'], ['/?cv=1.23', 'HEAD', 'xhr'], ['/?cv=0.123&extra=1', 'HEAD', 'xhr'], ['/?cv=0.1&cv=0.2', 'HEAD', 'xhr'], ['/api/dataset/unit/getPage?cv=0.1', 'HEAD', 'xhr']]) assert.equal(browserRequestAllowed(origin + path, method, origin, type), false)
  assert.equal(browserRequestAllowed('https://remote.invalid/app-config.json', 'GET', origin, 'fetch'), false)
  assert.equal(browserRequestAllowed(origin + '/?cv=0.12', 'HEAD', origin, 'xhr', {}), false)
})

test('布局查询只准入已审计的固定参数，额外字段、不同分页、写接口均拒绝', () => {
  const origin = 'http://127.0.0.1:12345'
  for (const path of ['/enum/process/common', '/datasourceInfo/getTenantDatasource', '/system/log/getSystemModule', '/system/log/getSystemFunction']) {
    assert.equal(browserRequestAllowed(origin + '/api/dataset' + path, 'GET', origin, 'xhr'), true)
    assert.equal(browserRequestAllowed(origin + '/api/dataset' + path + '?extra=1', 'GET', origin, 'xhr'), false)
    assert.equal(browserRequestAllowed(origin + '/api/dataset' + path, 'GET', origin, 'xhr', {}), false)
  }
  for (const [path, body, changed] of [
    ['/approval/list', { approvalType: 1, completeType: 0, approvalStatusList: [], page: 1, size: 1 }, { size: 20 }],
    ['/message/list', { messageType: null, isRead: false, pageNum: 1, pageSize: 1 }, { isRead: true }],
  ]) {
    const url = origin + '/api/dataset' + path
    assert.equal(browserRequestAllowed(url, 'POST', origin, 'xhr', body), true)
    for (const invalid of [undefined, null, {}, { ...body, extra: true }, { ...body, ...changed }]) assert.equal(browserRequestAllowed(url, 'POST', origin, 'xhr', invalid), false)
    assert.equal(browserRequestAllowed(url, 'GET', origin, 'xhr', body), false)
  }
  for (const path of ['/message/read', '/message/readAll', '/approval/assign', '/enum/process/common', '/enum/category/uncertainty']) assert.equal(browserRequestAllowed(origin + '/api/dataset' + path, 'POST', origin, 'xhr', {}), false)
})

test('清理回读对布局请求body执行相同严格验证', async () => {
  const f = await fixture(), directory = join(f.config.evidenceRoot, f.input.namespace)
  await mkdir(directory, { recursive: true })
  const ledger = { namespace: f.input.namespace, baseUrl: f.input.baseUrl, uatEnvironment: 'uat2', mode: 'read-only', createdResources: 0, sessionState: 'none', browserState: 'closed',
    requests: [{ kind: 'browser', path: '/api/dataset/message/list', method: 'POST', resourceType: 'xhr', allowed: true, body: { messageType: null, isRead: false, pageNum: 1, pageSize: 1 } }] }
  await writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger))
  assert.equal((await executeReadOnly('verify-cleanup', f.config, f.input)).empty, true)
  ledger.requests[0].body.extra = 'not-admitted'
  await writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger))
  await assert.rejects(executeReadOnly('verify-cleanup', f.config, f.input), { code: 'READONLY_ACCEPTANCE_LEDGER_REQUEST_INVALID' })
})

test('API真实合同缓存当前namespace会话；注销及独立验证确认401，零业务写入', async t => {
  const f = await fixture(), sent = []
  let loggedOut = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, method: options.method })
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/auth/login')) { assert.equal(options.headers['X-Site'], '101'); assert.deepEqual(JSON.parse(options.body), { username: 'fixture-user', password: 'fixture-secret', grantType: 'PASSWORD' }); return reply({ code: 200, data: { accessToken: 'fixture-token', userId: 'user' } }) }
    assert.equal(options.headers.Authorization, 'fixture-token')
    if (url.endsWith('/unit/getPage')) return reply({ code: '200', data: [1, 2], privateField: 'do-not-output' })
    if (url.endsWith('/auth/logout')) { loggedOut = true; return reply({ code: 200, data: true }) }
    assert.equal(loggedOut, true)
    return reply({ code: 401 }, 200)
  })
  const first = await executeReadOnly('api', f.config, f.input)
  assert.equal(first.actual, '{"rows":2}')
  assert.equal((await executeReadOnly('api', f.config, f.input)).actual, first.actual)
  assert.equal(sent.filter(item => item.url.endsWith('/auth/login')).length, 1)
  await executeReadOnly('cleanup', f.config, f.input)
  assert.deepEqual(await executeReadOnly('verify-cleanup', f.config, f.input), { namespace: f.input.namespace, empty: true, mode: 'read-only', createdResources: 0 })
  assert.equal(sent.filter(item => item.url.includes('/user/info/current')).length, 2)
  const ledger = await readFile(join(f.config.evidenceRoot, f.input.namespace, 'ledger.json'), 'utf8')
  assert.doesNotMatch(ledger, /fixture-secret|fixture-token|do-not-output/)
})

test('登录结果未知不得伪称清理完成，非法endpoint零登录', async t => {
  const f = await fixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('sensitive provider failure') })
  await assert.rejects(executeReadOnly('api', f.config, { ...f.input, case: { parameters: { ...f.input.case.parameters, endpoint: 'delete' } } }), { code: 'READONLY_ACCEPTANCE_PARAMETERS_INVALID' })
  assert.equal(calls, 0)
  await assert.rejects(executeReadOnly('api', f.config, f.input), { code: 'READONLY_ACCEPTANCE_REQUEST_FAILED' })
  await assert.rejects(executeReadOnly('cleanup', f.config, f.input), { code: 'READONLY_ACCEPTANCE_SESSION_UNKNOWN' })
  await assert.rejects(executeReadOnly('verify-cleanup', f.config, f.input), { code: 'READONLY_ACCEPTANCE_CLEANUP_UNCONFIRMED' })
})

test('前端就绪相同UP仍须匹配精确后端origin和artifactSha256', async t => {
  const f = await fixture()
  t.mock.method(globalThis, 'fetch', async () => reply({ status: 'UP' }))
  const input = { ...f.input, services: { dataset: { baseUrl: 'http://127.0.0.1:23456', artifactSha256: 'a'.repeat(64) } }, case: { parameters: { path: '/login', selector: 'body', read: 'text' } } }
  await assert.rejects(executeReadOnly('browser', f.config, input), { code: 'READONLY_ACCEPTANCE_DATASET_BINDING_UNCONFIRMED' })
  await assert.rejects(executeReadOnly('browser', f.config, { ...input, services: { dataset: 'http://127.0.0.1:23456' } }), { code: 'READONLY_ACCEPTANCE_DATASET_BINDING_UNCONFIRMED' })
})

test('独立清理验证拒绝活动浏览器或篡改的业务写入ledger', async () => {
  const f = await fixture(), directory = join(f.config.evidenceRoot, f.input.namespace)
  await mkdir(directory, { recursive: true })
  const ledger = { namespace: f.input.namespace, baseUrl: f.input.baseUrl, uatEnvironment: 'uat2', mode: 'read-only', createdResources: 0, sessionState: 'none', browserState: 'active', requests: [] }
  await writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger))
  await assert.rejects(executeReadOnly('verify-cleanup', f.config, f.input), { code: 'READONLY_ACCEPTANCE_CLEANUP_UNCONFIRMED' })
  ledger.browserState = 'closed'; ledger.requests = [{ kind: 'api', method: 'POST', path: '/unit/delete', allowed: true }]
  await writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger))
  await assert.rejects(executeReadOnly('verify-cleanup', f.config, f.input), { code: 'READONLY_ACCEPTANCE_LEDGER_REQUEST_INVALID' })
})
