import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { stripVTControlCharacters } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'file:///C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'

function expectedStepElapsed(node) {
  const duration = Date.parse(node.completedAt) - Date.parse(node.startedAt)
  assert.ok(Number.isFinite(duration) && duration >= 0, 'actual_completed_node_timing_required')
  assert.equal(node.status, 'succeeded')
  const seconds = duration / 1000
  const value = seconds < 1 ? `${Math.round(duration)} 毫秒` : seconds < 60 ? `${seconds.toFixed(1)} 秒`
    : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
      : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${Math.floor(seconds % 60)} 秒`
  return `耗时 ${value}${node.leaseEpoch > 1 ? `（第 ${node.leaseEpoch} 次处理）` : ''}`
}

const root = fileURLToPath(new URL('../../../../', import.meta.url))
if (!process.argv[2]) throw new Error('usage: node verify-live-browser.mjs <fresh-start.stdout.log>')
const log = stripVTControlCharacters(await readFile(process.argv[2], 'utf8'))
const auth = (log.match(/https?:\/\/[^\s<>]+:3080[^\s<>]*/g) || []).map(value => new URL(value)).filter(value => value.hostname === '127.0.0.1' && value.searchParams.has('token')).at(-1)
assert.ok(auth, 'fresh_auth_url_missing')
const replay = JSON.parse((await readFile(path.join(root, 'docs/tmp/task-current-steps/completed-copy-3/replay-details.json'), 'utf8')).replace(/^\uFEFF/, ''))
const actualCards = await (await fetch('http://127.0.0.1:18998/state/tasks')).json()
const output = path.join(root, 'docs/tmp/task-current-steps/metadata-browser/live'); await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce' })
const page = await context.newPage(), blocked = [], errors = [], checks = [], network = []
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
page.on('response', async response => { const target = new URL(response.url()); if (target.pathname.endsWith('/output')) { const body = await response.json().catch(() => ({})); network.push({ kind: 'output', node: digest(target.pathname), cursor: target.searchParams.get('cursor'), revision: digest(target.searchParams.get('detailRevision') || ''), status: response.status(), textLength: body.text?.length, nextCursor: body.nextCursor }) }; if (target.pathname.endsWith('/detail')) { const body = await response.json().catch(() => ({})); network.push({ kind: 'detail', task: digest(target.pathname), status: response.status(), revision: digest(body.detailRevision || ''), nodes: body.executionNodes?.length }) } })
page.on('requestfailed', request => { if (new URL(request.url()).port === '18998') network.push({ kind: 'failed', path: digest(new URL(request.url()).pathname), error: request.failure()?.errorText }) })
await page.route('**/*', route => { if (route.request().method() !== 'GET') { blocked.push(new URL(route.request().url()).pathname); return route.abort() }; return route.continue() })
page.on('pageerror', error => errors.push(error.message))
const diagnostic = setInterval(() => { const outputs = network.filter(item => item.kind === 'output'); console.log(JSON.stringify({ phase: 'network-progress', outputs: outputs.length, failed: network.filter(item => item.kind === 'failed').length, details: network.filter(item => item.kind === 'detail').length })); void writeFile(path.join(output, 'network-progress.json'), JSON.stringify({ network, blocked, errors, checks }, null, 2)) }, 10000)
const progress = phase => console.log(JSON.stringify({ phase }))
async function dismissUpdate() { const remind = page.getByText('稍后提醒', { exact: true }); if (await remind.count()) await remind.first().click() }
try {
  await page.goto(auth.href)
  await page.getByText('稍后提醒', { exact: true }).click({ timeout: 1500 }).catch(() => {})
  await page.getByText('运行看板', { exact: true }).first().click()
  for (let index = 0; index < replay.length; index++) {
    progress(`task-${index + 1}-start`); await dismissUpdate()
    const task = replay[index].detail
    await page.getByRole('button', { name: task.archivedAt ? '归档任务' : '任务看板', exact: true }).click()
    const card = page.getByRole('button').filter({ has: page.locator(`strong[title=${JSON.stringify(task.title)}]`) })
    assert.ok(Array.from(await card.locator('strong[title]').textContent()).length <= 32)
    if (!task.archivedAt) {
      await card.locator('[data-task-card-action="toggle-checkpoints"]').focus(); await page.keyboard.press('Enter')
      const rows = card.locator('[title="本次执行耗时"]'); assert.equal(await rows.count(), 7)
      const actualCard = actualCards.find(card => card.taskId === task.taskId); assert.ok(actualCard)
      for (let stepIndex = 0; stepIndex < actualCard.workflowProgress.stages.length; stepIndex++) { const stage = actualCard.workflowProgress.stages[stepIndex], node = actualCard.executionNodes.find(node => node.nodeId === stage.stageId); assert.ok(node); assert.equal(await rows.nth(stepIndex).textContent(), expectedStepElapsed(node)); assert.notEqual(await rows.nth(stepIndex).locator('..').getAttribute('title'), stage.stageId) }
      const names = await card.locator('div[title]').evaluateAll(elements => elements.filter(element => element.querySelector('[title="本次执行耗时"]')).map(element => element.getAttribute('title')))
      assert.ok(names.length > 0 && names.every(name => /[\u4e00-\u9fff]/.test(name)))
    assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth + 2), false); await page.setViewportSize({ width: 1440, height: 1100 })
    }
    progress(`task-${index + 1}-card-metadata-pass`); await card.focus(); await page.keyboard.press('Enter')
    const region = page.getByRole('region', { name: '任务执行详情', exact: true }); await region.waitFor()
    assert.ok(Array.from(await region.locator('h1').textContent()).length <= 32)
    const objective = region.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^任务目标$/ }) }); await objective.locator('summary').click(); assert.equal(await objective.locator('p').textContent(), task.objective)
    assert.equal(await region.locator('section.observer-task-workflow').count(), [3, 2, 3][index])
    assert.deepEqual(await region.locator('li.observer-task-step time').evaluateAll(elements => elements.map(element => element.getAttribute('datetime'))), task.executionNodes.map(node => node.startedAt))
    assert.equal(await region.locator('li.observer-task-step').count(), [30, 3, 30][index])
    await page.getByRole('region', { name: '当前结果', exact: true }).waitFor()
    assert.equal(await region.getByText(/执行历史|返回最新执行|查看本次执行过程与会话/).count(), 0)
    progress(`task-${index + 1}-detail-metadata-pass`); await page.waitForTimeout(1000)
    await page.waitForFunction(() => !document.querySelector('[aria-label="任务执行详情"]')?.textContent.includes('正在读取产出…'))
    for (let disclosure = 0; await region.locator('li.observer-task-step details:not([open]) > summary').count(); disclosure++) { assert.ok(disclosure < 100, 'summary_disclosure_did_not_converge'); if (disclosure % 10 === 0) progress(`task-${index + 1}-summary-${disclosure}`); await dismissUpdate(); await region.locator('li.observer-task-step details:not([open]) > summary').first().click() }
    let reads = 0
    for (let round = 0; round < 300; round++) {
      await dismissUpdate()
      await page.waitForFunction(() => !document.querySelector('[aria-label="任务执行详情"]')?.textContent.includes('正在读取产出…'))
      for (let disclosure = 0; await region.locator('li.observer-task-step details:not([open]) > summary').count(); disclosure++) { assert.ok(disclosure < 100, 'summary_disclosure_did_not_converge'); if (disclosure % 10 === 0) progress(`task-${index + 1}-summary-${disclosure}`); await dismissUpdate(); await region.locator('li.observer-task-step details:not([open]) > summary').first().click() }
      const buttons = region.getByRole('button', { name: '继续阅读产出', exact: true })
      if (!await buttons.count()) { await page.waitForTimeout(300); if (!await buttons.count()) break }
      await buttons.first().focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(150)
      reads++; if (round % 5 === 0) progress(`task-${index + 1}-page-${reads}`); assert.ok(round < 299)
    }
    progress(`task-${index + 1}-pagination-pass-${reads}`); for (const item of replay[index].outputs.filter(item => item.text.length > 0)) { const tail = item.text.trim().slice(-40); if (tail) await page.waitForFunction(text => document.querySelector('[aria-label="任务执行详情"]')?.textContent.replace(/\s/g, '').includes(text.replace(/\s/g, '')), tail) }
    assert.equal(await region.evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.screenshot({ path: path.join(output, `task-${index + 1}-desktop.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await region.evaluate(element => element.scrollWidth > element.clientWidth + 2), false)
    await page.screenshot({ path: path.join(output, `task-${index + 1}-narrow.png`), fullPage: true })
    checks.push({ index: index + 1, nodes: [30, 3, 30][index], paginationReads: reads, workflowGroups: [3, 2, 3][index], startedAtTimes: task.executionNodes.length, shortTitle: true, completeObjective: true, chineseCardLabelsAndTiming: !task.archivedAt, noHistory: true, noOverflow: true })
    await dismissUpdate(); await page.getByRole('button', { name: '返回看板', exact: true }).focus(); await page.keyboard.press('Enter'); await page.setViewportSize({ width: 1440, height: 1100 })
  }
  assert.deepEqual(errors, [])
  assert.equal(network.filter(item => item.kind === 'failed').length, 0)
  assert.equal(blocked.some(item => /^\/(tasks|workflows|authorizations)\//.test(item)), false)
  const result = { passed: true, checks, blockedNonGet: blocked, errors, network, boundary: '正式DSH Web独立headless新context只读核验；全部非GET被拒绝，无任务重跑/外发/归档操作。' }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, tasks: checks.length, blockedNonGet: blocked.length, output }))
} catch (error) { await writeFile(path.join(output, 'failure-network.json'), JSON.stringify({ network, blocked, errors, checks }, null, 2)); await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); await writeFile(path.join(output, 'failure.html'), await page.content()); throw error }
finally { clearInterval(diagnostic); await context.close(); await browser.close() }
