import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { runTaskCheck } from '../packages/dingtalk-dsh-assistant/task-checks.js'

const digest = text => createHash('sha256').update(text).digest('hex')
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-check-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'workspace'), outside = path.join(directory, 'outside')
  await mkdir(root); await mkdir(outside)
  const file = path.join(root, 'result.txt')
  await writeFile(file, 'expected result')
  const request = { checkerId: 'artifact-sha256', checkerVersion: '1', artifactId: 'a1', expectedDigest: digest('expected result') }
  const context = { receiptId: 'host-receipt-1', criterionIds: ['c1'], workspaceRoot: root, artifacts: [{ artifactId: 'a1', uri: pathToFileURL(file).href, version: '1' }], observedAt: '2026-09-22T00:00:00.000Z' }
  return { root, outside, file, request, context }
}

test('注册只读检查器返回稳定 Host 回执，摘要符合 PASS/不符 FAIL，内容不出现在证据', async t => {
  const { request, context } = await fixture(t)
  const result = await runTaskCheck(request, context)
  assert.equal(result.outcome, 'pass')
  assert.equal(result.producerKind, 'checker')
  assert.deepEqual(await runTaskCheck(request, context), result)
  assert.equal((await runTaskCheck({ ...request, expectedDigest: digest('different') }, context)).outcome, 'fail')
  assert.equal(JSON.stringify(result).includes('expected result'), false)
  assert.equal(JSON.stringify(result).includes(context.workspaceRoot), false)
})

test('缺失文件及超出 Host 大小预算是 UNKNOWN，不宣称通过', async t => {
  const { request, context, file } = await fixture(t)
  assert.equal((await runTaskCheck(request, { ...context, maxBytes: 2 })).outcome, 'unknown')
  await rm(file)
  assert.equal((await runTaskCheck(request, context)).outcome, 'unknown')
})

test('严格拒绝模型路径/命令、未知版本/产物和路径越界', async t => {
  const { request, context, outside } = await fixture(t)
  for (const extra of [{ command: 'echo secret' }, { path: 'secret' }, { checkerVersion: '2' }, { artifactId: 'other' }]) await assert.rejects(runTaskCheck({ ...request, ...extra }, context))
  const file = path.join(outside, 'secret.txt'); await writeFile(file, 'credential-value')
  await assert.rejects(runTaskCheck(request, { ...context, artifacts: [{ ...context.artifacts[0], uri: pathToFileURL(file).href }] }), /outside_workspace/)
})

test('工作区内目录链接不能越界读取注册产物', async t => {
  const { request, context, root, outside } = await fixture(t)
  const link = path.join(root, 'external')
  await writeFile(path.join(outside, 'secret.txt'), 'credential-value')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(runTaskCheck(request, { ...context, artifacts: [{ ...context.artifacts[0], uri: pathToFileURL(path.join(link, 'secret.txt')).href }] }), /outside_workspace/)
})
