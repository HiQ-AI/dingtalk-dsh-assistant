import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('CI 只允许手工触发并在 Node 24 下测试、打包三个发行包', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/u)
  assert.doesNotMatch(workflow, /pull_request:/u)
  assert.doesNotMatch(workflow, /\n\s*push:/u)
  assert.match(workflow, /runs-on: windows-latest/u)
  assert.match(workflow, /node-version: 24\.19\.0/u)
  assert.match(workflow, /pnpm install --frozen-lockfile/u)
  assert.match(workflow, /git diff --exit-code -- packages\/dingtalk-dsh-assistant\/web-client\.js/u)
  assert.match(workflow, /if \(\$packages\.Count -ne 3\)/u)
  assert.match(workflow, /actions\/checkout@v7/u)
  assert.match(workflow, /pnpm\/action-setup@v6/u)
  assert.match(workflow, /actions\/setup-node@v7/u)
  assert.match(workflow, /actions\/upload-artifact@v7/u)
})

test('Release 绑定受控环境并按依赖顺序发布，npm 回读后才创建 Release', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_dispatch:/u)
  assert.match(workflow, /release_tag:/u)
  assert.match(workflow, /RELEASE_TAG:.*inputs\.release_tag.*github\.ref_name/u)
  assert.match(workflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}/u)
  assert.doesNotMatch(workflow, /GITHUB_REF_NAME/u)
  assert.match(workflow, /runs-on: windows-latest/u)
  assert.match(workflow, /environment: NPM_PUBLISH/u)
  assert.match(workflow, /secrets\.NPM_PUBLISH_TOKEN \|\| secrets\.NPM_TOKEN/u)
  assert.match(workflow, /release_tag_must_point_to_main_history/u)
  assert.match(workflow, /version_mismatch_tag_/u)
  assert.match(workflow, /changelog_entry_missing_/u)
  assert.match(workflow, /changelog_release_link_missing_/u)
  assert.equal(workflow.match(/\\r\?\$/gu)?.length, 2)
  const observer = workflow.indexOf('npm publish "docs/tmp/packages/zzusp-dingtalk-dsh-observer-')
  const assistant = workflow.indexOf('npm publish "docs/tmp/packages/zzusp-dingtalk-dsh-assistant-')
  const distribution = workflow.indexOf('npm publish "docs/tmp/packages/dingtalk-dsh-assistant-')
  const readback = workflow.indexOf('npm view $package version')
  const release = workflow.indexOf('gh release create')
  assert.ok(observer >= 0 && observer < assistant && assistant < distribution)
  assert.ok(distribution < readback && readback < release)
  assert.match(workflow, /\$maxAttempts = 12/u)
  assert.match(workflow, /\$retryDelaySeconds = 10/u)
  assert.match(workflow, /for \(\$attempt = 1; \$attempt -le \$maxAttempts; \$attempt\+\+\)/u)
  assert.match(workflow, /Start-Sleep -Seconds \$retryDelaySeconds/u)
  assert.match(workflow, /npm_readback_failed_\$package`_after_\$maxAttempts`_attempts/u)
})

test('当前正式版本在 CHANGELOG 中有对应章节和 Release 链接', async () => {
  const [manifestSource, changelog] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ])
  const { version } = JSON.parse(manifestSource)
  const escapedVersion = version.replaceAll('.', '\\.')
  assert.match(changelog, new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu'))
  assert.match(changelog, new RegExp(`^\\[${escapedVersion}\\]: https://github\\.com/HiQ-AI/dingtalk-dsh-assistant/releases/tag/v${escapedVersion}$`, 'mu'))
})
