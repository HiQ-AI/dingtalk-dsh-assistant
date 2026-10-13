import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 真实 React 与完整 Observer 源码；宿主外壳与只读 API 使用隔离夹具。
// node <script> <playwright-package-directory> <baseline|verify|configuration> <round-number>
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const [playwrightPath, mode = 'verify', round = '1'] = process.argv.slice(2)
if (!playwrightPath || !['baseline', 'verify', 'configuration'].includes(mode) || !/^\d+$/u.test(round)) throw new Error('browser_arguments_invalid')
const { chromium } = createRequire(pathToFileURL(path.join(path.resolve(playwrightPath), 'package.json')))('playwright')
const output = path.join(root, 'docs/acceptance/workflow-dashboard', `round-${round}`)
const screenshots = path.join(root, 'docs/tmp/workflow-dashboard', `round-${round}`)
const fixtureUrl = 'http://127.0.0.1:18998/__fixture__'
const fixtureHtml = '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px "Microsoft YaHei",sans-serif}button{font:inherit}*{box-sizing:border-box}</style></head><body><div id="root"></div></body></html>'
await mkdir(output, { recursive: true })
await mkdir(screenshots, { recursive: true })
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const packages = await readdir(path.join(root, 'node_modules/.pnpm'))
const react = packages.find(name => /^react@18\./u.test(name))
const dom = packages.find(name => /^react-dom@18\./u.test(name))
if (!react || !dom) throw new Error('react_18_dependencies_missing')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
page.setDefaultTimeout(7000)
await page.clock.install({ time: new Date('2026-10-13T03:00:00Z') })
const errors = [], writes = [], unexpectedRequests = [], requests = [], checks = []
const unexpectedWrites = [], nativeDialogs = []
let scene = 'normal', heldCatalog = false, catalogSerial = 0
let heldRequestObserved
const delayedReplies = []
const holdNextRequest = () => { heldCatalog = true; return new Promise(resolve => { heldRequestObserved = resolve }) }
const workflows = [
  { id: 'task-data-change', label: '数据变更', purpose: '核对变更范围、审批与交付结果。', mode: 'external', version: '7', status: 'available', nodes: [
    { id: 'prepare', executor: 'code', effects: ['read'] }, { id: 'propose-sql', executor: 'agent', effects: ['read'] }, { id: 'apply-change', executor: 'code', effects: ['database-write'] },
  ] },
  { id: 'task-engineering', label: '代码开发', purpose: '根据开发目标和受信仓库冻结工程步骤。', mode: 'engineering', version: null, status: 'available', nodes: [], repositories: ['fixture-repository'], reason: '具体节点随任务和仓库配置冻结，在任务详情查看' },
  { id: 'task-production-release', label: '生产发布', purpose: '将核验后的目标发布至生产环境。', mode: 'external', version: null, status: 'unavailable', nodes: [], reason: '受信平台目标、客户端或验证未齐，当前不能发起' },
  { id: 'task-group-file-delivery', label: '群聊文件交付', purpose: '将必交文件发送至原群，并核验原字节。', mode: 'delivery', version: '2', status: 'available', nodes: [{ id: 'future-delivery-node', executor: 'future-executor', effects: ['future-effect'] }] },
  { id: 'task-empty-definition', label: '未返回节点的流程', purpose: '检验节点缺失的展示边界。', mode: 'external', version: '1', status: 'available', nodes: [] },
]
const builtInWorkflows = [{ id: 'task-progress-query', label: '查询任务进展', mode: 'built-in', version: 'task-progress-query@1', nodes: [{ id: 'scope', label: '校验范围' }, { id: 'candidates', label: '检索候选' }, { id: 'readback', label: '回读进展' }, { id: 'reply', label: '生成答复' }] }]
const catalog = () => scene === 'disabled' ? { enabled: false } : { engine: 'workflow-v2', groupIds: ['fixture-group'], messageStages: [{ id: 'receive', label: '接收消息' }, { id: 'dispatch', label: '派发任务' }], workflows: scene === 'empty' ? [] : structuredClone(workflows).map(item => scene === 'stale' && item.id === 'task-data-change' ? { ...item, label: '过期目录绝不应回写' } : item), builtInWorkflows: scene === 'empty' ? [] : structuredClone(builtInWorkflows) }
const tasks = [
  { taskId: 'task-direct', title: '直接绑定数据变更', workflowId: 'task-data-change', state: 'running' },
  { taskId: 'task-stage', title: '阶段绑定数据变更', workflowId: 'task-engineering', state: 'completed', outcome: 'succeeded', archivedAt: '2026-10-12T04:00:00Z', plan: { stages: [{ stageId: 'stage-data', workflowId: 'task-data-change', title: '数据变更', status: 'succeeded' }] } },
  { taskId: 'task-unrelated', title: '标题含数据变更但不属于此流程', workflowId: 'task-engineering', state: 'running' },
  { taskId: 'task-derived', title: '受信工程派生任务', workflowId: 'task-engineering-fixture-repository', state: 'waiting' },
  { taskId: 'task-legacy', title: '旧引擎同标识任务', workflowId: 'task-data-change', engine: 'legacy', state: 'completed' },
].map(task => ({ engine: 'workflow-v2', groupId: 'fixture-group', updatedAt: '2026-10-13T03:00:00Z', objective: task.title, result: '隔离夹具已核验', ...task }))
let configurationScene = 'normal', saveFailure = '', configurationSerial = 0
let holdConfiguration = false, configurationReadObserved
const delayedConfiguration = []
const holdConfigurationRequest = () => { holdConfiguration = true; return new Promise(resolve => { configurationReadObserved = resolve }) }
let holdWrite = false, writeObserved
const delayedWrites = []
const holdNextWrite = () => { holdWrite = true; return new Promise(resolve => { writeObserved = resolve }) }
const configuration = { revision: 0, writable: true, variables: [], bindings: [] }
const configurationView = () => ({ ...structuredClone(configuration), variables: configuration.variables.map(({ value, ...variable }) => variable.kind === 'secret' ? { ...variable } : { ...variable, value }) })
const saveConfiguration = (pathname, input) => {
  if (input.expectedRevision !== configuration.revision) return { status: 409, json: { error: 'WORKFLOW_CONFIG_REVISION_CONFLICT' } }
  const binding = /^\/config\/workflow-bindings\/([^/]+)$/u.exec(pathname)
  const enabled = /^\/config\/workflow-variables\/([^/]+)\/enabled$/u.exec(pathname)
  const name = decodeURIComponent(pathname.split('/')[3] ?? '')
  const existing = configuration.variables.find(variable => variable.name === name)
  if (binding) {
    const workflowId = decodeURIComponent(binding[1])
    if (![...workflows, ...builtInWorkflows].some(workflow => workflow.id === workflowId)) return { status: 400, json: { error: 'WORKFLOW_CONFIG_WORKFLOW_INVALID' } }
    if (input.variables.some(reference => !configuration.variables.some(variable => variable.name === reference.name && variable.enabled))) return { status: 400, json: { error: 'WORKFLOW_CONFIG_VARIABLE_DISABLED' } }
    configuration.bindings = [...configuration.bindings.filter(item => item.workflowId !== workflowId), { workflowId, variables: input.variables }]
  } else if (enabled) {
    if (!existing) return { status: 400, json: { error: 'WORKFLOW_CONFIG_ARGUMENT_INVALID' } }
    existing.enabled = input.enabled
  } else {
    if (existing && existing.kind !== input.kind) return { status: 400, json: { error: 'WORKFLOW_CONFIG_KIND_IMMUTABLE' } }
    if (existing && existing.format !== input.format) return { status: 400, json: { error: 'WORKFLOW_CONFIG_FORMAT_IMMUTABLE' } }
    if (input.kind === 'secret' && !input.value?.trim()) return { status: 400, json: { error: 'WORKFLOW_CONFIG_SECRET_REQUIRED' } }
    if (input.format === 'json') { try { JSON.parse(input.value) } catch { return { status: 400, json: { error: 'WORKFLOW_CONFIG_JSON_INVALID' } } } }
    configuration.variables = [...configuration.variables.filter(variable => variable.name !== name), { name, kind: input.kind, format: input.format, description: input.description ?? '', value: input.value, revision: (existing?.revision ?? 0) + 1, enabled: existing?.enabled ?? true }]
  }
  configuration.revision++
  return { status: 200, json: configurationView() }
}
page.on('pageerror', error => errors.push(error.message))
page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss() })
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin !== 'http://127.0.0.1:18998') { unexpectedRequests.push(target.href); return route.abort() }
  if (target.href === fixtureUrl && route.request().method() === 'GET') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml })
  if (route.request().method() !== 'GET') {
    const request = `${route.request().method()} ${target.pathname}`
    const variableWrite = route.request().method() === 'PUT' && /^\/config\/workflow-variables\/[^/]+$/u.test(target.pathname)
    const enabledWrite = route.request().method() === 'POST' && /^\/config\/workflow-variables\/[^/]+\/enabled$/u.test(target.pathname)
    const bindingWrite = route.request().method() === 'PUT' && /^\/config\/workflow-bindings\/[^/]+$/u.test(target.pathname)
    if (mode !== 'configuration' || !variableWrite && !enabledWrite && !bindingWrite) { unexpectedWrites.push(request); return route.abort() }
    writes.push(request)
    if (holdWrite) { holdWrite = false; await new Promise(resolve => { delayedWrites.push(resolve); writeObserved?.(); writeObserved = undefined }) }
    if (saveFailure) { const error = saveFailure; saveFailure = ''; return route.fulfill({ status: error === 'WORKFLOW_CONFIG_REVISION_CONFLICT' ? 409 : 503, json: { error } }) }
    return route.fulfill(saveConfiguration(target.pathname, route.request().postDataJSON()))
  }
  requests.push(target.pathname + target.search)
  let body = []
  if (target.pathname === '/health') body = { status: 'ok' }
  if (target.pathname === '/state/groups') body = [{ groupId: 'fixture-group', name: '隔离验收群', messages: [], outbox: [] }]
  if (target.pathname === '/state/topics') body = { topics: [], total: 0, offset: 0, limit: 100 }
  if (target.pathname === '/state/tasks') body = mode === 'baseline' ? [] : tasks
  if (target.pathname === '/config/workflow-variables') {
    configurationSerial++
    const requestScene = configurationScene
    body = configurationView()
    if (configurationScene === 'stale') body.variables = body.variables.map(variable => variable.kind === 'plain' ? { ...variable, value: '过期变量值绝不应回写' } : variable)
    if (holdConfiguration) { holdConfiguration = false; await new Promise(resolve => { delayedConfiguration.push(resolve); configurationReadObserved?.(); configurationReadObserved = undefined }) }
    if (requestScene === 'error') return route.fulfill({ status: 503, json: { error: 'WORKFLOW_CONFIG_STORAGE_FAILED' } })
    if (requestScene === 'unavailable') return route.fulfill({ status: 503, json: { error: 'WORKFLOW_CONFIG_UNAVAILABLE' } })
  }
  const detail = /^\/state\/tasks\/([^/]+)\/detail$/u.exec(target.pathname)
  if (detail) body = { ...tasks.find(task => task.taskId === detail[1]), executionNodes: [] }
  if (target.pathname === '/state/workflows/catalog') {
    catalogSerial++
    const requestScene = scene
    body = catalog()
    if (heldCatalog) await new Promise(resolve => { delayedReplies.push(resolve); heldRequestObserved?.(); heldRequestObserved = undefined })
    if (requestScene === 'error') return route.fulfill({ status: 503, json: { error: 'fixture_catalog_unavailable' } })
  }
  await route.fulfill({ status: 200, json: body })
})
try {
  await page.goto(fixtureUrl)
  await page.addScriptTag({ path: path.join(root, 'node_modules/.pnpm', react, 'node_modules/react/umd/react.development.js') })
  await page.addScriptTag({ path: path.join(root, 'node_modules/.pnpm', dom, 'node_modules/react-dom/umd/react-dom.development.js') })
  await page.evaluate(() => {
    const h = React.createElement
    const ui = {
      Button: ({ variant, size, children, ...props }) => h('button', props, children),
      Pill: ({ children, ...props }) => h('span', props, children), StateDot: () => h('span', { 'aria-hidden': true }, '●'),
      IconChecklistOutline14: () => null, IconChevronDownOutline14: () => null, IconChevronUpOutline14: () => null,
      Menu: ({ open, anchor, items, onSelect }) => h('div', null, anchor, open ? h('div', { role: 'menu' }, ...items.map(item => h('button', { key: item.id, role: 'menuitem', onClick: () => onSelect(item.id) }, item.label))) : null),
    }
    const root = ReactDOM.createRoot(document.getElementById('root'))
    let sidebar, content
    const render = () => root.render(h('div', null, sidebar ? h('aside', { style: { width: 240, overflow: 'hidden' } }, h(sidebar, { wide: true })) : null, content ? h(content, { openSession: async () => undefined }) : null))
    window.remountObserver = () => {
      window.previousObserverRoot = document.querySelector('[data-dingtalk-observer]')
      ReactDOM.flushSync(() => root.render(null))
      ReactDOM.flushSync(render)
    }
    window.__ModuleLoader__ = { load({ factory }) { const plugin = factory(name => name === 'react' ? React : ui); plugin.apply({ slots: { inject(_name, callback) { callback() }, register(options, component) { if (options.name === 'sidebar.footer.action') sidebar = component; else content = component; render(); return () => undefined } }, sessions: {} }) } }
  })
  await page.addScriptTag({ content: observer })
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  const navigation = page.getByRole('navigation', { name: '运行看板视图', exact: true })
  const navigationLabels = await navigation.getByRole('button').allTextContents()
  if (mode === 'baseline') {
    assert.deepEqual(navigationLabels, ['群消息', '话题', '任务看板', '人工介入', '归档任务', '告警'])
    assert.equal(await navigation.getByRole('button', { name: '工作流', exact: true }).count(), 0)
    checks.push('existing-six-navigation-items', 'workflow-tab-missing-before-change')
    await page.screenshot({ path: path.join(screenshots, 'baseline-desktop.png'), fullPage: true })
  } else if (mode === 'verify') {
    assert.deepEqual(navigationLabels, ['群消息', '话题', '任务看板', '工作流', '配置', '人工介入', '归档任务', '告警'])
    assert.equal(catalogSerial, 0)
    checks.push('navigation-after-tasks', 'catalog-lazy-loading')
    const directory = page.getByRole('region', { name: '工作流目录', exact: true })
    const listing = () => page.getByLabel('工作流列表', { exact: true })
    const detail = () => page.getByRole('region', { name: '工作流详情', exact: true })
    const choose = name => listing().getByRole('button', { name, exact: true })
    const refresh = () => page.getByRole('button', { name: /^(刷新|已刷新)$/u }).click()
    const retry = () => directory.getByRole('button', { name: '重新读取', exact: true }).click()
    const releaseReplies = () => { heldCatalog = false; delayedReplies.splice(0).forEach(resolve => resolve()) }
    scene = 'error'; heldCatalog = true
    await navigation.getByRole('button', { name: '工作流', exact: true }).focus()
    await page.keyboard.press('Enter')
    await directory.getByRole('status').filter({ hasText: '正在读取工作流目录' }).waitFor()
    checks.push('initial-loading', 'keyboard-open-tab')
    releaseReplies()
    await directory.getByRole('alert').filter({ hasText: 'fixture_catalog_unavailable' }).waitFor()
    checks.push('initial-error')
    scene = 'normal'; await retry()
    await choose('数据变更').waitFor()
    assert.equal(await listing().getByRole('button').count(), 6)
    checks.push('initial-error-retry', 'catalog-external-engineering-delivery-built-in')
    await choose('数据变更').click()
    await detail().getByText('核对变更范围、审批与交付结果。', { exact: true }).waitFor()
    assert.equal(await choose('数据变更').getAttribute('aria-pressed'), 'true')
    assert.equal(await detail().locator('ol li').count(), 3)
    await detail().getByText(/代码校验/u).first().waitFor()
    await detail().getByText(/模型处理/u).first().waitFor()
    await detail().getByText(/受控操作/u).first().waitFor()
    checks.push('ordered-nodes-and-executors', 'selected-state-and-purpose')
    await detail().getByText(/配置与维护/u).waitFor()
    const links = await detail().getByRole('link').evaluateAll(elements => elements.map(element => ({ label: element.textContent, href: element.href, target: element.target, rel: element.rel })))
    assert.ok(links.length > 0)
    for (const link of links) {
      const target = new URL(link.href)
      assert.equal(target.protocol, 'https:')
      assert.equal(target.hostname, 'github.com')
      const relative = target.pathname.split('/blob/main/')[1]
      assert.ok(relative, `文档链接没有 main 文件路径：${link.href}`)
      assert.ok((await readFile(path.join(root, decodeURIComponent(relative)))).length > 0)
      assert.equal(link.target, '_blank')
      assert.match(link.rel, /noopener|noreferrer/u)
      assert.match(link.label, /新窗口/u)
    }
    checks.push('maintenance-doc-links-resolve-to-repository-files')
    await detail().getByRole('button', { name: /直接绑定数据变更/u }).waitFor()
    await detail().getByRole('button', { name: /阶段绑定数据变更/u }).waitFor()
    assert.equal(await detail().getByText('标题含数据变更但不属于此流程', { exact: true }).count(), 0)
    assert.equal(await detail().getByText('旧引擎同标识任务', { exact: true }).count(), 0)
    await page.screenshot({ path: path.join(screenshots, 'workflow-desktop.png'), fullPage: true })
    checks.push('related-direct-and-archived-stage-binding', 'exclude-title-only-match')
    await detail().getByRole('button', { name: /阶段绑定数据变更/u }).click()
    await page.getByRole('region', { name: '任务执行详情', exact: true }).getByRole('heading', { name: '阶段绑定数据变更', exact: true }).waitFor()
    await page.getByRole('button', { name: '返回工作流', exact: true }).click()
    await detail().getByText('核对变更范围、审批与交付结果。', { exact: true }).waitFor()
    assert.equal(await choose('数据变更').getAttribute('aria-pressed'), 'true')
    assert.equal(await choose('数据变更').evaluate(element => document.activeElement === element), true)
    checks.push('related-task-original-detail', 'return-preserves-selection-and-focus')
    await choose('代码开发').focus(); await page.keyboard.press('Space')
    await detail().getByText('具体步骤随任务和仓库配置冻结，请从相关任务查看本次执行步骤。', { exact: true }).waitFor()
    await detail().getByText(/fixture-repository/u).waitFor()
    await detail().getByRole('button', { name: '受信工程派生任务', exact: true }).waitFor()
    assert.equal(await detail().locator('ol li').count(), 0)
    checks.push('engineering-dynamic-nodes-and-repositories', 'keyboard-select-workflow')
    await choose('生产发布').click()
    await detail().getByText('受信平台目标、客户端或验证未齐，当前不能发起', { exact: true }).waitFor()
    assert.doesNotMatch(await detail().textContent(), /版本\s*(v?null|v?undefined)/u)
    checks.push('unavailable-reason', 'unknown-version-not-fabricated')
    await choose('查询任务进展').click()
    assert.equal(await detail().locator('ol li').count(), 4)
    await detail().getByText('校验范围', { exact: true }).waitFor()
    checks.push('built-in-labelled-nodes')
    await choose('群聊文件交付').click()
    assert.equal(await detail().locator('ol li').count(), 1)
    await detail().getByText('步骤 1（名称未登记）', { exact: true }).waitFor()
    await detail().getByText('执行方式未提供', { exact: true }).waitFor()
    checks.push('unknown-node-visible')
    await choose('未返回节点的流程').click()
    await detail().getByText('当前目录未提供可展示的节点定义。', { exact: true }).waitFor()
    checks.push('missing-nodes-explained')
    await choose('代码开发').click()
    scene = 'error'; await refresh()
    await directory.getByRole('alert').filter({ hasText: 'fixture_catalog_unavailable' }).waitFor()
    assert.equal(await choose('代码开发').getAttribute('aria-pressed'), 'true')
    await detail().getByText(/fixture-repository/u).waitFor()
    await directory.getByText(/未刷新|刷新失败/u).first().waitFor()
    checks.push('refresh-error-retains-data-and-selection')
    scene = 'normal'; await retry()
    await directory.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(await choose('代码开发').getAttribute('aria-pressed'), 'true')
    await refresh()
    assert.equal(await choose('代码开发').getAttribute('aria-pressed'), 'true')
    checks.push('refresh-error-retry', 'refresh-preserves-selection')
    await page.setViewportSize({ width: 390, height: 844 })
    await choose('数据变更').click()
    assert.equal(await directory.evaluate(element => element.scrollWidth > element.clientWidth), false)
    checks.push('390-directory-no-horizontal-overflow')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const listBox = await listing().boundingBox(), detailBox = await detail().boundingBox()
    assert.ok(listBox && detailBox && detailBox.y >= listBox.y + listBox.height - 1)
    await page.screenshot({ path: path.join(screenshots, 'workflow-narrow.png'), fullPage: true })
    checks.push('390-no-horizontal-overflow', '390-stacked-list-detail')
    await page.setViewportSize({ width: 1440, height: 900 })
    scene = 'empty'; await refresh()
    await directory.getByText(/暂无.*工作流|没有.*工作流/u).waitFor()
    checks.push('empty-catalog')
    scene = 'disabled'; await refresh()
    await directory.getByText(/未启用|未开启/u).waitFor()
    checks.push('workflow-engine-disabled')
    scene = 'normal'; await retry()
    await choose('数据变更').waitFor()
    scene = 'stale'
    const staleRequest = holdNextRequest()
    await refresh(); await staleRequest
    const staleCancelled = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/state/workflows/catalog' })
    await navigation.getByRole('button', { name: '任务看板', exact: true }).click()
    await staleCancelled
    scene = 'normal'; heldCatalog = false
    await navigation.getByRole('button', { name: '工作流', exact: true }).click()
    await choose('数据变更').waitFor()
    releaseReplies()
    assert.equal(await choose('过期目录绝不应回写').count(), 0)
    await choose('数据变更').waitFor()
    checks.push('stale-response-after-page-exit-suppressed')
    const slowRequest = holdNextRequest()
    await refresh(); await slowRequest
    const serialBeforePolling = catalogSerial
    const healthBeforePolling = requests.filter(request => request === '/health').length
    for (let tick = 0; tick < 2; tick++) {
      const beforeTime = await page.getByText(/^更新于 /u).textContent()
      const pollRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/health')
      await page.clock.runFor(5500)
      await pollRequest
      await page.waitForFunction(previous => [...document.querySelectorAll('span')].some(element => /^更新于 /u.test(element.textContent) && element.textContent !== previous), beforeTime)
    }
    assert.ok(requests.filter(request => request === '/health').length >= healthBeforePolling + 2)
    assert.equal(catalogSerial, serialBeforePolling)
    const slowResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/state/workflows/catalog')
    releaseReplies(); await slowResponse
    await choose('数据变更').waitFor()
    checks.push('slow-catalog-request-deduplicated-across-polling')
    const storageKey = 'dingtalk-dsh-observer.active-page'
    const activePage = async label => {
      await navigation.getByRole('button', { name: label, exact: true }).and(navigation.locator('[aria-current="page"]')).waitFor()
      assert.equal(await navigation.locator('[aria-current="page"]').textContent(), label)
    }
    const remount = async label => {
      await page.evaluate(() => window.remountObserver())
      await activePage(label)
      assert.equal(await page.evaluate(() => window.previousObserverRoot === document.querySelector('[data-dingtalk-observer]')), false)
    }
    for (const [id, label] of [['workflows', '工作流'], ['configuration', '配置']]) {
      await navigation.getByRole('button', { name: label, exact: true }).click()
      await activePage(label)
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), id)
      await remount(label)
      await page.getByRole('region', { name: id === 'workflows' ? '工作流目录' : '配置管理', exact: true }).waitFor()
      checks.push(`${id}-host-remount-restores-active-page`)
    }
    await page.evaluate(key => sessionStorage.setItem(key, 'fixture-invalid-page'), storageKey)
    await remount('群消息')
    checks.push('invalid-stored-page-defaults-to-groups')
    await page.evaluate(() => {
      window.fixtureStorageMethods = { getItem: Storage.prototype.getItem, setItem: Storage.prototype.setItem }
      for (const method of ['getItem', 'setItem']) Storage.prototype[method] = () => { throw new DOMException('Storage blocked by fixture', 'SecurityError') }
    })
    await remount('群消息')
    await navigation.getByRole('button', { name: '工作流', exact: true }).click()
    await activePage('工作流')
    await choose('数据变更').waitFor()
    await page.evaluate(() => Object.assign(Storage.prototype, window.fixtureStorageMethods))
    checks.push('blocked-storage-allows-workflow-navigation')
    checks.push('no-browser-errors-or-write-requests')
  } else {
    assert.deepEqual(navigationLabels, ['群消息', '话题', '任务看板', '工作流', '配置', '人工介入', '归档任务', '告警'])
    assert.equal(configurationSerial, 0)
    const configPage = page.getByRole('region', { name: '配置管理', exact: true })
    const variableForm = () => configPage.getByRole('form', { name: '变量编辑', exact: true })
    const bindingForm = () => configPage.getByRole('form', { name: '工作流变量绑定', exact: true })
    const variableList = () => configPage.getByRole('region', { name: '变量列表', exact: true })
    const variable = name => variableList().getByRole('button', { name, exact: true })
    const value = () => variableForm().getByLabel('变量值', { exact: true })
    const saveVariable = async () => { await variableForm().getByRole('button', { name: '保存变量', exact: true }).click() }
    const saved = () => configPage.getByRole('status').filter({ hasText: '变量已保存' }).waitFor()
    const reload = () => configPage.getByRole('button', { name: '重新读取配置', exact: true }).click()
    const newVariable = async () => { await variableList().getByRole('button', { name: '新建变量', exact: true }).click(); await variableForm().getByRole('heading', { name: '新建变量', exact: true }).waitFor() }
    configurationScene = 'unavailable'
    const initialConfigurationRead = holdConfigurationRequest()
    await navigation.getByRole('button', { name: '配置', exact: true }).focus(); await page.keyboard.press('Enter')
    await initialConfigurationRead
    await configPage.getByText('正在读取配置…', { exact: true }).waitFor()
    delayedConfiguration.splice(0).forEach(resolve => resolve())
    await configPage.getByRole('alert').filter({ hasText: '当前实例未提供托管配置服务' }).waitFor()
    configurationScene = 'error'; await reload()
    await configPage.getByRole('alert').filter({ hasText: '配置请求失败' }).waitFor()
    configurationScene = 'normal'; await reload()
    await configPage.getByText('暂无变量', { exact: true }).waitFor()
    checks.push('config-navigation-read-states')
    await variableForm().getByLabel('变量名称', { exact: true }).fill('fixturePlain')
    await variableForm().getByLabel('用途说明', { exact: true }).fill('浏览器隔离验证普通变量')
    await value().fill('plain-original')
    await saveVariable(); await saved()
    assert.equal(configuration.variables.find(item => item.name === 'fixturePlain').value, 'plain-original')
    assert.equal(await variableForm().getByLabel('变量名称', { exact: true }).getAttribute('readonly'), '')
    assert.equal(await variableForm().getByLabel('类型', { exact: true }).isDisabled(), true)
    assert.equal(await variableForm().getByLabel('值格式', { exact: true }).isDisabled(), true)
    await value().fill('plain-after-error'); saveFailure = 'WORKFLOW_CONFIG_STORAGE_FAILED'
    await saveVariable()
    await configPage.getByRole('alert').filter({ hasText: '配置请求失败' }).waitFor()
    assert.equal(await value().inputValue(), 'plain-after-error')
    assert.equal(configuration.variables.find(item => item.name === 'fixturePlain').value, 'plain-original')
    checks.push('config-save-error-retains-draft')
    configuration.revision++
    await saveVariable()
    await configPage.getByRole('alert').filter({ hasText: '配置已被其他操作更新' }).waitFor()
    assert.equal(await value().inputValue(), 'plain-after-error')
    const readsBeforeDirtyNavigation = configurationSerial
    await navigation.getByRole('button', { name: '任务看板', exact: true }).click()
    await navigation.getByRole('button', { name: '配置', exact: true }).click()
    assert.equal(await value().inputValue(), 'plain-after-error')
    assert.equal(configurationSerial, readsBeforeDirtyNavigation)
    await reload()
    await configPage.getByRole('region', { name: '未保存修改', exact: true }).waitFor()
    await configPage.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(await value().inputValue(), 'plain-after-error')
    await reload(); await configPage.getByRole('button', { name: '放弃修改并继续', exact: true }).click()
    await variableList().getByText(`1 个变量 · 配置版本 ${configuration.revision}`, { exact: true }).waitFor()
    await page.waitForFunction(() => document.getElementById('workflow-variable-value')?.value === 'plain-original')
    await value().fill('plain-final'); await saveVariable(); await saved()
    assert.equal(configuration.variables.find(item => item.name === 'fixturePlain').revision, 2)
    checks.push('config-cas-conflict-retains-draft', 'config-plain-crud')
    await value().fill('unsaved-draft')
    await variableList().getByRole('button', { name: '新建变量', exact: true }).click()
    await configPage.getByRole('region', { name: '未保存修改', exact: true }).waitFor()
    await configPage.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(await value().inputValue(), 'unsaved-draft')
    await variableForm().getByRole('button', { name: '取消修改', exact: true }).click()
    assert.equal(await value().inputValue(), 'plain-final')
    checks.push('config-dirty-navigation')
    await newVariable()
    await variableForm().getByLabel('变量名称', { exact: true }).fill('fixtureJson')
    await variableForm().getByLabel('值格式', { exact: true }).selectOption('json')
    await value().fill('{invalid')
    const writesBeforeJsonError = writes.length
    await saveVariable()
    await configPage.getByRole('alert').filter({ hasText: '值不是有效的 JSON' }).waitFor()
    assert.equal(writes.length, writesBeforeJsonError)
    assert.equal(await value().inputValue(), '{invalid')
    await value().fill('{"region":"fixture","limit":3}')
    await saveVariable(); await saved()
    assert.deepEqual(JSON.parse(configuration.variables.find(item => item.name === 'fixtureJson').value), { region: 'fixture', limit: 3 })
    checks.push('config-json-validation')
    await newVariable()
    await variableForm().getByLabel('变量名称', { exact: true }).fill('fixtureSecret')
    await variableForm().getByLabel('类型', { exact: true }).selectOption('secret')
    const secretInput = () => variableForm().getByLabel(/^(凭据值|替换凭据值)$/u)
    await secretInput().fill('fixture-secret-line-one\nfixture-secret-line-two')
    assert.equal(await secretInput().evaluate(element => getComputedStyle(element).webkitTextSecurity), 'disc')
    await variableForm().getByRole('button', { name: '显示输入', exact: true }).focus(); await page.keyboard.press('Space')
    assert.equal(await secretInput().evaluate(element => getComputedStyle(element).webkitTextSecurity), 'none')
    await variableForm().getByRole('button', { name: '隐藏输入', exact: true }).click()
    assert.equal(await secretInput().evaluate(element => getComputedStyle(element).webkitTextSecurity), 'disc')
    await saveVariable(); await saved()
    assert.equal(await secretInput().inputValue(), '')
    assert.equal(Object.hasOwn(configurationView().variables.find(item => item.name === 'fixtureSecret'), 'value'), false)
    assert.doesNotMatch(await configPage.textContent(), /fixture-secret-line/u)
    await variableForm().getByLabel('用途说明', { exact: true }).fill('变更说明而不填凭据')
    const writesBeforeEmptySecret = writes.length
    await saveVariable()
    await configPage.getByRole('alert').filter({ hasText: '留空不会清除' }).waitFor()
    assert.equal(writes.length, writesBeforeEmptySecret)
    assert.equal(configuration.variables.find(item => item.name === 'fixtureSecret').revision, 1)
    await secretInput().fill('fixture-secret-replacement'); await saveVariable(); await saved()
    assert.equal(await secretInput().inputValue(), '')
    assert.equal(configuration.variables.find(item => item.name === 'fixtureSecret').revision, 2)
    assert.equal(await variableForm().getByLabel('类型', { exact: true }).isDisabled(), true)
    checks.push('config-secret-mask-replace', 'config-secret-no-roundtrip', 'config-secret-empty-no-delete')
    await bindingForm().getByLabel('选择工作流', { exact: true }).selectOption('task-data-change')
    await bindingForm().getByRole('button', { name: '添加引用', exact: true }).click()
    await bindingForm().getByLabel('读取别名 1', { exact: true }).fill('settings')
    await bindingForm().getByLabel('引用变量 1', { exact: true }).selectOption('fixturePlain')
    await bindingForm().getByRole('button', { name: '添加引用', exact: true }).click()
    await bindingForm().getByLabel('读取别名 2', { exact: true }).fill('token')
    await bindingForm().getByLabel('引用变量 2', { exact: true }).selectOption('fixtureSecret')
    await bindingForm().getByRole('button', { name: '保存绑定', exact: true }).click()
    await configPage.getByRole('status').filter({ hasText: '变量绑定已保存' }).waitFor()
    assert.deepEqual(configuration.bindings.find(item => item.workflowId === 'task-data-change').variables, [{ alias: 'settings', name: 'fixturePlain' }, { alias: 'token', name: 'fixtureSecret' }])
    checks.push('config-binding-catalog-selection')
    await navigation.getByRole('button', { name: '工作流', exact: true }).click()
    const directory = page.getByRole('region', { name: '工作流目录', exact: true })
    await directory.getByRole('region', { name: '工作流列表', exact: true }).getByRole('button', { name: '数据变更', exact: true }).click()
    const references = directory.getByRole('region', { name: '流程变量', exact: true })
    await references.getByText('settings → fixturePlain · 普通变量 · v2', { exact: false }).waitFor()
    await references.getByText('token → fixtureSecret · 凭据 · v2', { exact: false }).waitFor()
    await references.getByRole('button', { name: '查看配置', exact: true }).first().click()
    await variableForm().getByRole('heading', { name: '编辑 fixturePlain', exact: true }).waitFor()
    assert.equal(await value().inputValue(), 'plain-final')
    checks.push('config-binding-directory-link')
    await value().fill('plain-after-slow-save')
    const capturedWrite = holdNextWrite()
    await saveVariable(); await capturedWrite
    await navigation.getByRole('button', { name: '工作流', exact: true }).click()
    await references.getByText('token → fixtureSecret · 凭据 · v2', { exact: false }).waitFor()
    await references.getByRole('button', { name: '查看配置', exact: true }).nth(1).click()
    assert.equal(await variableForm().getByLabel('变量名称', { exact: true }).isDisabled(), true)
    delayedWrites.splice(0).forEach(resolve => resolve())
    await variableForm().getByRole('heading', { name: '编辑 fixtureSecret', exact: true }).waitFor()
    assert.equal(await secretInput().inputValue(), '')
    await variable('fixturePlain').click()
    assert.equal(await value().inputValue(), 'plain-after-slow-save')
    checks.push('config-pending-save-target')
    const writesBeforeDisable = writes.length, valueRevision = configuration.variables.find(item => item.name === 'fixturePlain').revision
    await variableForm().getByRole('button', { name: '停用变量', exact: true }).click()
    await variableForm().getByRole('group', { name: '确认停用变量', exact: true }).waitFor()
    await variableForm().getByRole('button', { name: '取消停用', exact: true }).click()
    assert.equal(writes.length, writesBeforeDisable)
    await variableForm().getByRole('button', { name: '停用变量', exact: true }).click()
    await variableForm().getByRole('button', { name: '确认停用', exact: true }).click()
    await configPage.getByRole('status').filter({ hasText: '变量已停用' }).waitFor()
    assert.equal(configuration.variables.find(item => item.name === 'fixturePlain').enabled, false)
    assert.equal(configuration.variables.find(item => item.name === 'fixturePlain').revision, valueRevision)
    assert.equal(configuration.bindings.find(item => item.workflowId === 'task-data-change').variables.length, 2)
    await bindingForm().getByLabel('选择工作流', { exact: true }).selectOption('task-production-release')
    await bindingForm().getByRole('button', { name: '添加引用', exact: true }).click()
    assert.equal(await bindingForm().getByLabel('引用变量 1', { exact: true }).locator('option[value="fixturePlain"]').count(), 0)
    await bindingForm().getByRole('button', { name: '取消绑定修改', exact: true }).click()
    checks.push('config-disable-confirmation')
    await variable('fixtureSecret').focus(); await page.keyboard.press('Enter')
    await variableForm().getByRole('heading', { name: '编辑 fixtureSecret', exact: true }).waitFor()
    await page.screenshot({ path: path.join(screenshots, 'configuration-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await configPage.evaluate(element => element.scrollWidth > element.clientWidth), false)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(screenshots, 'configuration-narrow.png'), fullPage: true })
    checks.push('config-keyboard-narrow')
    await page.setViewportSize({ width: 1440, height: 900 })
    await variable('fixtureJson').click()
    configurationScene = 'stale'
    const captured = holdConfigurationRequest()
    await reload(); await captured
    const cancelled = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/config/workflow-variables' })
    await navigation.getByRole('button', { name: '任务看板', exact: true }).click(); await cancelled
    configurationScene = 'normal'
    await navigation.getByRole('button', { name: '配置', exact: true }).click()
    await configPage.getByRole('button', { name: '重新读取配置', exact: true }).waitFor()
    delayedConfiguration.splice(0).forEach(resolve => resolve())
    assert.equal(await value().inputValue(), '{"region":"fixture","limit":3}')
    checks.push('config-stale-read-suppressed')
    assert.ok(writes.length >= 9)
    checks.push('config-fixture-only-writes')
  }
  assert.deepEqual(errors, [])
  if (mode !== 'configuration') assert.deepEqual(writes, [])
  assert.deepEqual(unexpectedWrites, [])
  assert.deepEqual(nativeDialogs, [])
  assert.deepEqual(unexpectedRequests, [])
  const result = { status: 'PASS', mode, browserVersion: browser.version(), observerSha256: createHash('sha256').update(observer).digest('hex'), navigationLabels, checks, pageErrors: errors, writes, unexpectedWrites, nativeDialogs, unexpectedRequests, requests, evidenceBoundary: '完整 Observer 源码与真实 React/Edge；宿主外壳和 API 为隔离夹具，配置模式仅允许白名单夹具写入；未连接运行实例或钉钉，非部署或业务 E2E 证据。' }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, `${mode}-failure.png`), fullPage: true }).catch(() => undefined)
  const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, overflows: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth).slice(0, 15).map(element => ({ tag: element.tagName, label: element.getAttribute('aria-label'), class: element.className, text: element.textContent?.slice(0, 80), width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })) })).catch(() => undefined)
  const result = { status: 'FAIL', mode, browserVersion: browser.version(), observerSha256: createHash('sha256').update(observer).digest('hex'), checks, error: error.stack, layout, pageErrors: errors, writes, unexpectedWrites, nativeDialogs, unexpectedRequests, requests }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(result, null, 2) + '\n')
  console.error(JSON.stringify(result))
  process.exitCode = 1
} finally {
  await browser.close()
}
