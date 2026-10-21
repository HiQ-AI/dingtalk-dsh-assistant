import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import yaml from 'js-yaml'
import { checkedInventory, lanes } from '../scripts/test-suites.mjs'
const load = async p => yaml.load(await readFile(new URL('../' + p, import.meta.url), 'utf8'))
test('manual compatibility CI has no push, PR, schedule or publication side effects', async () => {
  const ci = await load('.github/workflows/ci.yml')
  assert.deepEqual(Object.keys(ci.on), ['workflow_dispatch'])
  assert.deepEqual(ci.permissions, { contents: 'read' })
  assert.deepEqual(ci.jobs.check.strategy.matrix.lane, lanes)
  assert.equal(ci.jobs.check.strategy['fail-fast'], false)
  assert.ok(ci.jobs.check.steps.some(x => /matrix[.]lane/.test(x.run ?? '')))
})
test('release exact SHA validates all lanes before immutable build and same-run publication', async () => {
  const r = await load('.github/workflows/release.yml')
  assert.deepEqual(r.permissions, { contents: 'read' })
  assert.deepEqual(r.jobs.validate.needs, 'resolve')
  assert.deepEqual(r.jobs.validate.strategy.matrix.lane, lanes)
  assert.equal(r.jobs.validate.strategy['fail-fast'], false)
  assert.deepEqual(r.jobs.build.needs, ['resolve', 'validate'])
  assert.deepEqual(r.jobs.publish.needs, ['resolve', 'build'])
  assert.equal(r.jobs.publish.environment, 'NPM_PUBLISH')
  assert.deepEqual(r.jobs.publish.permissions, { contents: 'write', 'id-token': 'write' })
  for (const [name, job] of Object.entries(r.jobs)) {
    assert.equal(job.runsOn ?? job['runs-on'], 'windows-latest')
    if (name !== 'publish') assert.equal(job.permissions?.['id-token'], undefined)
    assert.equal(job['continue-on-error'], undefined)
    for (const step of job.steps) assert.equal(step['continue-on-error'], undefined)
  }
  const build = r.jobs.build.steps.map(x => x.run ?? '').join('\n')
  assert.match(build, /release-artifacts\.mjs create/)
  assert.match(build, /RELEASE_PACKAGE_DIRECTORY/)
  assert.match(build, /node --test test\/task-session-package-native\.test\.js/)
  assert.match(build, /release-artifacts\.mjs verify/)
  assert.match(build, /built_package_native_smoke_failed/)
  const upload = r.jobs.build.steps.find(x => x.uses?.startsWith('actions/upload-artifact@'))
  const download = r.jobs.publish.steps.find(x => x.uses?.startsWith('actions/download-artifact@'))
  assert.equal(upload.with.name, download.with.name)
  assert.match(download.with.name, /needs\.resolve\.outputs\.sha/)
  assert.equal(download.with['run-id'], undefined, 'artifact retrieval defaults to this run only')
  assert.equal(download.with['github-token'], undefined)
  const publish = r.jobs.publish.steps.map(x => x.run ?? '').join('\n')
  assert.doesNotMatch(publish, /pnpm (?:test|install|pack)|mvn |build-web-client/)
  assert.ok(publish.indexOf('release-artifacts.mjs verify') < publish.indexOf('Publish-NpmPackage'))
  assert.ok(publish.indexOf('zzusp-dingtalk-dsh-observer-') < publish.indexOf('zzusp-dingtalk-dsh-assistant-'))
  assert.ok(publish.indexOf('npm view $package version') < publish.indexOf('gh release create'))
  assert.match(publish, /published_package_shasum_mismatch/)
  assert.match(publish, /github_release_asset_mismatch/)
  assert.match(publish, /release_sha_changed/)
  const source = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_PUBLISH_TOKEN|NPM_TOKEN|--provenance/)
  const env = await readFile(new URL('../.github/actions/release-test-env/action.yml', import.meta.url), 'utf8')
  assert.match(env, /pnpm install --frozen-lockfile/)
  assert.match(env, /node-version: 24\.19\.0/)
  assert.match(env, /cache: pnpm/)
  assert.match(env, /cache: maven/)
})
test('every test file is mapped exactly once and no historical failure is excluded', async () => {
  const map = await checkedInventory()
  assert.ok(map.entries.length >= 265)
  assert.ok(map.entries.every(x => x.release && x.reason))
  for (const file of ['task-session-execution-provider-recovery-native.test.js', 'task-session-skills-native.test.js', 'message-impact.test.js', 'workflow-engineering.test.js']) assert.ok(map.entries.some(x => x.file === 'test/' + file && x.release))
})
test('release publishes three tgz plus identity manifest and verifies every attachment', async () => {
  const r = await load('.github/workflows/release.yml')
  const publish = r.jobs.publish.steps.map(x => x.run ?? '').join('\n')
  assert.match(publish, /gh release create .*\*\.tgz docs\/tmp\/packages\/release-manifest\.json/)
  assert.match(publish, /\$release\.assets\.Count -ne 4/)
  assert.match(publish, /foreach \(\$file in \$files\)/)
  assert.match(publish, /\$assetRows\[0\]\.digest -ne "sha256:\$sha256"/)
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

test('resident profile 只解析到最新版 DSH 依赖边界', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.dsh/profiles/resident/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.2.1-alpha.2')
  assert.equal(manifest.dependencies['@deepseek-ai/cordis'], '4.0.5-alpha.1')
  assert.equal(manifest.dependencies['dsh-codex-connect'], '0.1.0-alpha.4.30')
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.1-alpha.2', name)
  }
})

test('常驻启动优先读取用户代理，避免为启动解析完整 resident 状态', async () => {
  for (const script of ['start-web.ps1', 'start-resident.ps1']) {
    const source = await readFile(new URL(`../scripts/${script}`, import.meta.url), 'utf8')
    const registry = source.indexOf("Get-ItemPropertyValue -Path 'HKCU:\\Environment'")
    const residentState = source.indexOf('Get-Content -LiteralPath $residentState')
    assert.ok(registry >= 0 && registry < residentState, script)
  }
})

test('Web 启动优先使用当前 profile 的 DSH 入口', async () => {
  const source = await readFile(new URL('../scripts/start-web.ps1', import.meta.url), 'utf8')
  const profileEntry = source.indexOf("profiles\\web\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js")
  const globalCommand = source.indexOf('Get-Command dsh.cmd')
  assert.ok(profileEntry >= 0 && globalCommand > profileEntry)
  assert.match(source, /if \(Test-Path -LiteralPath \$profileDshEntry\)/u)
})
