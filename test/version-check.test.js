import assert from 'node:assert/strict'
import test from 'node:test'
import { checkForUpdates, isNewerVersion, readCurrentVersion } from '../packages/dingtalk-dsh-assistant/version-check.js'

test('语义版本比较覆盖正式版与预发布版', () => {
  assert.equal(isNewerVersion('0.4.1', '0.4.0'), true)
  assert.equal(isNewerVersion('0.4.0', '0.4.0'), false)
  assert.equal(isNewerVersion('0.4.0', '0.4.0-rc.1'), true)
  assert.equal(isNewerVersion('0.4.0-rc.1', '0.4.0'), false)
  assert.equal(isNewerVersion('not-a-version', '0.4.0'), false)
})

test('版本检查返回当前版本、最新 Release 与升级判断', async () => {
  const currentVersion = await readCurrentVersion()
  const [major, minor, patch] = currentVersion.split('.').map(Number)
  const latestVersion = `${major}.${minor}.${patch + 1}`
  const result = await checkForUpdates({
    force: true,
    now: Date.parse('2026-08-26T00:00:00.000Z'),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: `v${latestVersion}`, html_url: 'https://example.test/release' }) }),
  })
  assert.equal(result.currentVersion, currentVersion)
  assert.equal(result.latestVersion, latestVersion)
  assert.equal(result.updateAvailable, true)
  assert.equal(result.releaseUrl, 'https://example.test/release')
})

test('没有 Release 与上游失败都返回明确状态', async () => {
  const missing = await checkForUpdates({ force: true, fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(missing.latestVersion, null)
  assert.equal(missing.error, undefined)

  const failed = await checkForUpdates({ force: true, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(failed.currentVersion, await readCurrentVersion())
  assert.equal(failed.error, 'offline')
})
