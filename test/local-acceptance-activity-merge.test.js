import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { executeActivityMerge } from '../scripts/local-acceptance-activity-merge.mjs'

async function fixture() {
  await mkdir(resolve('docs/tmp'), { recursive: true })
  const root = await mkdtemp(resolve('docs/tmp/activity-ui-test-'))
  return { root, config: { taskId: 'task-f559fc2e93230cf2cdcd61c8ad51dc35', uatEnvironment: 'uat3', evidenceRoot: root, playwrightModule: join(root, 'unused.mjs') }, input: { uatEnvironment: 'uat3', namespace: 'acceptance-' + 'a'.repeat(32), baseUrl: 'http://127.0.0.1:19113' } }
}
test('合并结果UI验收固定Task/UAT，拒绝旧review和其他Task', async () => {
  const f = await fixture()
  for (const config of [{ ...f.config, uatEnvironment: 'uat2' }, { ...f.config, taskId: 'other' }]) await assert.rejects(executeActivityMerge('initialize', config, f.input), { code: 'ACTIVITY_MERGE_CONFIG_INVALID' })
  await assert.rejects(executeActivityMerge('initialize', f.config, { ...f.input, taskId: 'other' }), { code: 'ACTIVITY_MERGE_INPUT_INVALID' })
  await assert.rejects(executeActivityMerge('initialize', f.config, { ...f.input, namespace: '../escape' }), { code: 'ACTIVITY_MERGE_INPUT_INVALID' })
})
test('合并结果UI独立namespace初始化、关闭证明及重复执行保护', async () => {
  const f = await fixture()
  await assert.rejects(executeActivityMerge('cleanup', f.config, f.input), { code: 'ACTIVITY_MERGE_LEDGER_MISSING' })
  await executeActivityMerge('initialize', f.config, f.input)
  await assert.rejects(executeActivityMerge('initialize', f.config, f.input), { code: 'ACTIVITY_MERGE_ALREADY_INITIALIZED' })
  assert.equal((await executeActivityMerge('verify-cleanup', f.config, f.input)).empty, true)
  const file = join(f.root, f.input.namespace, 'activity-merge-ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8'))
  ledger.browserClosed = false; await writeFile(file, JSON.stringify(ledger))
  await assert.rejects(executeActivityMerge('verify-cleanup', f.config, f.input), { code: 'ACTIVITY_MERGE_CLEANUP_UNCONFIRMED' })
  ledger.browserClosed = true; ledger.started = true; await writeFile(file, JSON.stringify(ledger))
  await assert.rejects(executeActivityMerge('execute', f.config, f.input), { code: 'ACTIVITY_MERGE_EXECUTION_INVALID' })
  await assert.rejects(executeActivityMerge('cleanup', f.config, { ...f.input, baseUrl: 'http://127.0.0.1:19114' }), { code: 'ACTIVITY_MERGE_LEDGER_IDENTITY' })
})
test('合并结果UI不接收远程origin或任意case参数', async () => {
  const f = await fixture()
  await assert.rejects(executeActivityMerge('initialize', f.config, { ...f.input, baseUrl: 'https://editor.hiqdat.dev' }))
  await executeActivityMerge('initialize', f.config, f.input)
  await assert.rejects(executeActivityMerge('execute', f.config, { ...f.input, case: { parameters: { bypass: true } } }), { code: 'ACTIVITY_MERGE_EXECUTION_INVALID' })
})
