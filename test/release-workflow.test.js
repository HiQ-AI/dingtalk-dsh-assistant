import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('CI 在 Node 24 下测试、打包并上传三个发行包', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /runs-on: windows-latest/u)
  assert.match(workflow, /node-version: 24\.19\.0/u)
  assert.match(workflow, /pnpm install --frozen-lockfile/u)
  assert.match(workflow, /git diff --exit-code -- packages\/dingtalk-dsh-assistant\/web-client\.js/u)
  assert.match(workflow, /if \(\$packages\.Count -ne 3\)/u)
  assert.match(workflow, /actions\/upload-artifact@v4/u)
})

test('Release 绑定受控环境并按依赖顺序发布，npm 回读后才创建 Release', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /runs-on: windows-latest/u)
  assert.match(workflow, /environment: NPM_PUBLISH/u)
  assert.match(workflow, /secrets\.NPM_PUBLISH_TOKEN \|\| secrets\.NPM_TOKEN/u)
  assert.match(workflow, /release_tag_must_point_to_main_history/u)
  assert.match(workflow, /version_mismatch_tag_/u)
  const observer = workflow.indexOf('npm publish "docs/tmp/packages/zzusp-dingtalk-dsh-observer-')
  const assistant = workflow.indexOf('npm publish "docs/tmp/packages/zzusp-dingtalk-dsh-assistant-')
  const distribution = workflow.indexOf('npm publish "docs/tmp/packages/dingtalk-dsh-assistant-')
  const readback = workflow.indexOf('npm view $package version')
  const release = workflow.indexOf('gh release create')
  assert.ok(observer >= 0 && observer < assistant && assistant < distribution)
  assert.ok(distribution < readback && readback < release)
})
