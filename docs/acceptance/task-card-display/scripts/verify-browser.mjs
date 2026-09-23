import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../../../', import.meta.url)), require = createRequire(import.meta.url)
const playwright = process.argv[2] ? require(path.resolve(process.argv[2], 'playwright')) : require('playwright')
const output = path.join(root, 'docs/acceptance/task-card-display/round-2')
await mkdir(output, { recursive: true })
const reactPath = require.resolve('react/package.json'), reactVersion = JSON.parse(await readFile(reactPath, 'utf8')).version
const domDirectory = (await readdir(path.join(root, 'node_modules/.pnpm'))).find(name => name.startsWith(`react-dom@${reactVersion}_`))
if (!domDirectory) throw new Error('matching_react_dom_missing')
const observer = await readFile(path.join(root, 'packages/dingtalk-dsh-observer/web-client.js'), 'utf8')
const routes = new Map([
  ['/react.js', await readFile(path.join(path.dirname(reactPath), 'umd/react.development.js'))],
  ['/react-dom.js', await readFile(path.join(root, 'node_modules/.pnpm', domDirectory, 'node_modules/react-dom/umd/react-dom.development.js'))],
  ['/observer.js', observer],
])
// 真实 React 与完整 observer 代码；DSH 外壳/primitive 仅用无副作用语义替身。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流程状态验收夹具</title><style>body{margin:0;color:#202124;font:14px "Microsoft YaHei",sans-serif}#sidebar{padding:8px}button{font:inherit}#app{height:calc(100dvh - 48px)}</style><div id="sidebar"></div><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.opened=[];const h=React.createElement;
const matrixCells=[[0,0],[4,0],[8,0],[8,4],[8,8],[4,8],[0,8],[0,4]];
const primitives={Button:({variant,size,children,...props})=>h('button',props,children),Pill:({children,...props})=>h('span',props,children),StateDot:({state,size=10})=>state==='ongoing'?h('svg',{'data-state':'ongoing',width:size,height:size,viewBox:'0 0 10 10',shapeRendering:'crispEdges','aria-hidden':true,style:{color:'#5675ef'}},...matrixCells.map(([x,y])=>h('rect',{key:x+'-'+y,x,y,width:2,height:2,fill:'currentColor'}))):h('span',{'data-state':state,'aria-hidden':true,style:{display:'inline-block',width:size,height:size,borderRadius:'50%',background:state==='done'?'#248a3d':'#737373'}}),Menu:({anchor})=>anchor};
primitives.IconChecklistOutline14=({size=14,...props})=>h('svg',{...props,width:size,height:size,viewBox:'0 0 14 14',fill:'none'},
  h('path',{d:'M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z',fill:'currentColor'}),
  h('path',{d:'M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z',fill:'currentColor'}),
  h('path',{d:'M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z',fill:'currentColor'}));
for(const name of ['IconChevronDownOutline14','IconChevronUpOutline14'])primitives[name]=props=>h('svg',{...props,width:14,height:14,viewBox:'0 0 14 14',fill:'none'},h('path',{d:name==='IconChevronUpOutline14'?'M3 9L7 5L11 9':'M3 5L7 9L11 5',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}));
const roots={sidebar:ReactDOM.createRoot(document.getElementById('sidebar')),app:ReactDOM.createRoot(document.getElementById('app'))};
window.__ModuleLoader__={load(def){const mod=def.factory(name=>name==='react'?React:primitives);mod.apply({slots:{inject(name,callback){return callback()},register(spec,Component){const target=spec.name==='conversation'?'app':'sidebar';roots[target].render(h(Component,{...(spec.inject?.()||{}),wide:true}));return()=>roots[target].render(null)}},sessions:{subagentAddress(){return undefined},async refreshSubagents(){},async refresh(){},open(id){window.opened.push(id)}}})}};
</script><script src="/observer.js"></script></html>`
const server = createServer((request, response) => { response.setHeader('content-type', request.url === '/' ? 'text/html;charset=utf-8' : 'text/javascript;charset=utf-8'); response.end(request.url === '/' ? html : routes.get(request.url) ?? '') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const labels = { succeeded: '已成功', cancelled: '已取消', failed: '已失败', 'legacy-unknown': '历史结果未知' }
const tasks = Object.entries(labels).map(([outcome, label], index) => ({ taskId: `fixture-${outcome}`, title: `${label}：中文长标题核验与通知状态`, objective: '在同名阶段中精确区分已核验与尚未核验的阶段，不把结束状态当成全部验收通过。', groupId: 'fixture-group', childSessionId: `session-${outcome}`, state: 'completed', inputVersion: 1, runSequence: 1, updatedAt: '2026-09-22T06:00:00Z', createdAt: '2026-09-22T05:00:00Z', checkpoints: [], workflowProgress: { outcome, outcomeLabel: label, stages: [{ stageId: `stage-${index}-first`, title: '同名核验阶段', completed: true }, { stageId: `stage-${index}-second`, title: '同名核验阶段', completed: false }] }, notificationIntents: [{ intentId: `notice-${index}`, inputVersion: 1, runSequence: 1, status: ['pending', 'blocked', 'enqueued', 'delivered'][index] }] }))
const worktree = { path: 'D:\\baibu-agent\\worktrees\\dataset-web-same-name-activity-merge', status: 'registered', createdByTask: false, branch: 'worktree-same-name-activity-merge', documents: ['round-10.md', 'checklist-plan.csv', 'checklist-implementation.csv', 'checklist-acceptance.csv', 'filter-copy-e2e.json', 'pr-body.md', 'scripts/filter-copy-e2e.cjs', 'production-build.log'].map(name => ({ source: `docs/acceptance/same-name-activity-merge-reminder/round-10/${name}` })) }
tasks[0].localWorktrees = [worktree, { ...worktree }]
tasks[0].archiveCleanup = { status: 'pending' }
tasks[2].localWorktrees = [{ ...worktree, path: 'D:\\baibu-agent\\worktrees\\task-owned', createdByTask: true, documents: [{ source: 'docs/acceptance/example/report.md' }] }]
tasks[2].archiveCleanup = { status: 'failed', error: 'worktree_unpushed_or_remote_changed' }
tasks.push({ ...tasks[0], taskId: 'fixture-archived', title: '已归档：查看目录记录', archivedAt: '2026-09-22T07:00:00Z', localWorktrees: [{ ...worktree, path: 'D:\\baibu-agent\\worktrees\\finished-task', createdByTask: true, status: 'cleaned', documents: [{ source: 'docs/acceptance/example/report.md', archivePath: 'D:\\baibu-agent\\docs\\acceptance\\fixture-archived\\report.md' }] }], archiveCleanup: { status: 'completed' }, notificationIntents: [] })
tasks.push({ taskId: 'fixture-waiting', title: '协调请求等待恢复', objective: '展示可读等待原因与技术详情。', groupId: 'fixture-group', childSessionId: 'session-waiting', state: 'waiting', inputVersion: 1, runSequence: 1, updatedAt: '2026-09-22T06:00:00Z', createdAt: '2026-09-22T05:00:00Z', checkpoints: [], waitingReason: 'topic_request_retry_exhausted:coord-checkpoint-6ac3909a8691397f7688914cce25695eccad669d114f9fb9ec6cc3f39488ca60' })
const stageTitles = ['核验输入文件、目标环境、字段映射及生产只读基线', '准备并演练正向 SQL、回滚方案和影响范围', '通过 Bytebase MCP 生成 SQL 工单并提交孙鹏审查', '获批后按批准范围执行并完成独立回查']
const fixtureNow = Date.now()
tasks.push({ taskId: 'fixture-progress', title: '执行进度原样核对', objective: '保持任务阶段的原有进度条、图标和耗时布局。', groupId: 'fixture-group', childSessionId: 'session-progress', state: 'running', inputVersion: 1, runSequence: 1, updatedAt: new Date(fixtureNow).toISOString(), createdAt: new Date(fixtureNow - 300000).toISOString(), workflowProgress: { stages: stageTitles.map((title, index) => ({ stageId: `stage-progress-${index}`, title, completed: index === 0 })) }, checkpoints: [{ kind: 'plan-confirmed', submittedAt: new Date(fixtureNow - 300000).toISOString(), remainingItems: stageTitles }, { kind: 'stage-completed', submittedAt: new Date(fixtureNow - 34000).toISOString(), remainingItems: stageTitles.slice(1) }] })
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], blockedWrites = [], simulatedWrites = [], checks = []
let mode = 'normal', allowArchive = false
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const target = new URL(route.request().url())
  if (target.origin === url) return route.continue()
  if (target.origin !== 'http://127.0.0.1:18998') return route.abort()
  if (route.request().method() !== 'GET') {
    if (allowArchive && target.pathname === '/tasks/fixture-succeeded/archive') {
      simulatedWrites.push(target.pathname); tasks[0].archivedAt = '2026-09-22T08:00:00Z'
      return route.fulfill({ contentType: 'application/json', body: '{}' })
    }
    blockedWrites.push(target.pathname)
    return route.fulfill({ status: 403, body: JSON.stringify({ error: 'fixture forbids writes' }), contentType: 'application/json' })
  }
  if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离夹具模拟读取失败' }) })
  const data = target.pathname === '/state/tasks' ? mode === 'empty' ? [] : tasks : target.pathname === '/health' ? { status: 'ok' } : target.pathname === '/state/groups' ? [{ groupId: 'fixture-group', name: '隔离验收群', messages: [], outbox: [] }] : target.pathname === '/state/topics' ? { topics: [], total: 0 } : []
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
})
try {
  await page.goto(url)
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  await page.getByText(tasks[0].title, { exact: true }).waitFor()
  for (const label of Object.values(labels)) assert.ok(await page.getByRole('status').filter({ hasText: label }).count())
  for (const label of ['通知待生成', '通知受阻', '通知待送达']) assert.ok(await page.getByRole('status').filter({ hasText: label }).count())
  assert.equal(await page.getByText('通知已送达').count(), 0)
  assert.equal(await page.getByText('待归档清理').count(), 0)
  assert.equal(await page.getByText(worktree.path).count(), 0)
  assert.ok(await page.getByRole('alert').filter({ hasText: '归档失败 · 查看原因后重试' }).count())
  assert.equal(await page.getByText('worktree_unpushed_or_remote_changed').count(), 0)
  assert.ok(await page.getByText('系统协调受阻 · 待恢复').count())
  assert.equal(await page.getByText(/topic_request_retry_exhausted/u).count(), 0)
  checks.push('normal-delivery-hidden', 'archive-data-absent-from-card', 'waiting-reason-readable')
  assert.ok(await page.getByText('已结束', { exact: true }).count())
  const bars = page.getByRole('progressbar', { name: '检查点进度' })
  assert.equal(await bars.count(), 5)
  assert.deepEqual((await Promise.all([0, 1, 2, 3, 4].map(index => bars.nth(index).getAttribute('aria-valuenow')))).sort(), ['25', '50', '50', '50', '50'])
  checks.push('four-outcomes', 'independent-notification-status', 'ended-is-not-all-passed', 'same-title-stable-stage-ids')
  await page.screenshot({ path: path.join(output, 'observer-desktop.png'), fullPage: true })
  await page.getByText('协调请求等待恢复', { exact: true }).locator('xpath=../..').screenshot({ path: path.join(output, 'waiting-card.png') })
  const toggle = page.locator('[data-task-card-action="toggle-checkpoints"]').first()
  if (await toggle.count() === 0) throw new Error('checkpoint_keyboard_button_not_found')
  await page.setViewportSize({ width: 1920, height: 1100 })
  await toggle.focus(); await page.keyboard.press('Enter')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(await toggle.locator('svg').first().locator('path').count(), 4)
  assert.equal(await toggle.locator('svg').last().locator('path').getAttribute('d'), 'M3 9L7 5L11 9')
  checks.push('checklist-icon-distinct-from-collapse-chevron')
  const currentStageIcon = page.locator('[data-state="ongoing"]:visible').first()
  assert.equal(await currentStageIcon.getAttribute('viewBox'), '0 0 10 10')
  assert.equal(await currentStageIcon.locator('rect').count(), 8)
  checks.push('ongoing-icon-pixel-matrix')
  const outline = await toggle.evaluate(element => getComputedStyle(element).outlineStyle)
  assert.notEqual(outline, 'none')
  checks.push('keyboard-enter-expands', 'visible-focus')
  await toggle.evaluate(element => element.blur())
  await toggle.locator('xpath=..').screenshot({ path: path.join(output, 'progress-expanded.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  const archiveButtons = page.getByRole('button', { name: '检查并归档' })
  assert.equal(await archiveButtons.count(), 1)
  await archiveButtons.first().click()
  const archive = page.getByRole('region', { name: '归档前核对' })
  assert.equal(await archive.count(), 1)
  assert.match(await archive.innerText(), /借用目录及其登记文档会保留原处/u)
  assert.equal(await archive.getByText(worktree.path).count(), 1)
  assert.equal(await archive.getByText(/checklist-plan\.csv/u).count(), 1)
  assert.equal(await archive.getByRole('button', { name: '确认归档' }).count(), 1)
  await archive.getByRole('button', { name: '取消' }).click()
  assert.equal(await archive.count(), 0)
  await page.getByRole('button', { name: '查看并重试' }).click()
  assert.match(await archive.innerText(), /将迁出 1 份文档并清理 1 个任务自建目录/u)
  assert.match(await archive.innerText(), /worktree_unpushed_or_remote_changed/u)
  await archive.getByRole('button', { name: '取消' }).click()
  checks.push('archive-preview-before-action', 'borrowed-retained', 'owned-cleanup-preview')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.observer-task-board > div').last().evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.locator('.observer-task-board > div').last().locator(':scope > div').last().evaluate(element => { element.scrollTop = 0 })
  const narrow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, board: document.querySelector('.observer-task-board').getBoundingClientRect().width }))
  assert.ok(narrow.board <= narrow.viewport, '任务看板应保持窄屏单列宽度')
  await toggle.focus(); await page.keyboard.press(' ')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  await toggle.evaluate(element => element.blur())
  checks.push('narrow-keyboard-space-collapses')
  checks.push('narrow-chinese-cards')
  await archiveButtons.first().scrollIntoViewIfNeeded()
  await archiveButtons.first().locator('xpath=../..').screenshot({ path: path.join(output, 'card-narrow.png') })
  await archiveButtons.first().click()
  await archive.scrollIntoViewIfNeeded()
  await archive.screenshot({ path: path.join(output, 'archive-narrow.png') })
  await page.screenshot({ path: path.join(output, 'observer-narrow.png'), fullPage: true })
  await archive.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: '归档任务', exact: true }).click()
  await page.getByRole('button', { name: '归档记录' }).click()
  const record = page.getByRole('region', { name: '归档记录' })
  assert.match(await record.innerText(), /已清理/u)
  assert.match(await record.innerText(), /归档至 D:\\baibu-agent/u)
  checks.push('archived-record-on-demand')
  await page.getByRole('button', { name: '任务看板', exact: true }).click()
  allowArchive = true
  await page.getByRole('button', { name: '检查并归档' }).click()
  await page.getByRole('region', { name: '归档前核对' }).getByRole('button', { name: '确认归档' }).click()
  assert.deepEqual(simulatedWrites, ['/tasks/fixture-succeeded/archive'])
  await page.getByText(tasks[0].title, { exact: true }).waitFor({ state: 'detached' })
  assert.equal(await page.getByText(tasks[0].title, { exact: true }).count(), 0)
  allowArchive = false
  checks.push('confirm-archives-exact-task-once')
  mode = 'empty'; await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText('暂无已结束任务', { exact: false }).waitFor({ timeout: 5000 }).catch(async () => { assert.equal(await page.getByRole('progressbar').count(), 0) })
  checks.push('empty-task-list')
  mode = 'error'; await page.waitForTimeout(1300); await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText(/无法连接 resident 插件.*隔离夹具模拟读取失败/).waitFor()
  checks.push('read-error-visible')
  assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, [])
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ checks, sourceSha256: createHash('sha256').update(observer).digest('hex'), browser: await browser.version(), viewport: narrow, errors, blockedWrites, simulatedWrites, boundary: '完整observer源码与真实React浏览器渲染；DSH壳、UI primitive与API为替身。归档POST仅由隔离夹具模拟，未接真实profile、未执行真实归档或发送消息。' }, null, 2))
  console.log(JSON.stringify({ checks: checks.length, passed: true, narrow }))
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
