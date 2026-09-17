import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, outputDir, launchLog] = process.argv.slice(2)
if (!playwrightPath || !outputDir || !launchLog) throw new Error('playwright_path_output_dir_and_launch_log_required')
const launchUrl = (await readFile(launchLog, 'utf8')).match(/http:\/\/127\.0\.0\.1:3080\/\S+/u)?.[0]
if (!launchUrl) throw new Error('authenticated_launch_url_not_found')
const { chromium } = createRequire(pathToFileURL(path.join(playwrightPath, 'package.json')))('playwright')
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
try {
  await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.getByRole('button', { name: '钉钉群聊运行看板', exact: true }).click()
  await page.getByText('运行正常', { exact: true }).waitFor({ timeout: 30_000 })
  await page.getByText('任务看板', { exact: true }).first().click()
  await page.getByText('已完成', { exact: true }).first().waitFor()
  const taskPageVisible = true
  await page.getByText('人工介入', { exact: true }).first().click()
  await page.getByRole('button', { name: '查看', exact: true }).first().waitFor({ timeout: 30_000 })
  const view = page.getByRole('button', { name: '查看', exact: true }).first()
  await view.click()
  await page.getByRole('dialog', { name: '人工介入事项详情' }).waitFor()
  const detailVisible = true
  const approve = page.getByRole('button', { name: '批准该事项并继续', exact: true })
  if (await approve.count()) assert.equal(await approve.isVisible(), true)
  await page.screenshot({ path: path.join(outputDir, 'live-board.png'), fullPage: true })
  const result = { status: 'PASS', taskPageVisible, authorizationPageVisible: true, detailVisible, pageErrors }
  assert.deepEqual(pageErrors, [])
  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true })
  console.error(JSON.stringify({ status: 'FAIL', title: await page.title(), url: new URL(page.url()).origin, error: error.message }))
  throw error
} finally {
  await browser.close()
}
