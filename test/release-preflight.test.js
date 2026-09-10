import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { revisePreflightPrompts, assessReleasePreflight } from '../docs/acceptance/resident-leaf-coordination-repair/scripts/release-preflight.mjs'

test('CLI --check零写入，--write只创建新候选且拒绝覆盖', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preflight-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = join(dir, 'before.json'), output = join(dir, 'after.json')
  const body = JSON.stringify({ taskPromptsVersion: 1, taskPrompts: ['workflow-production-release', 'workflow-data-change'].map((id) => ({ id, revision: 1, prompt: '旧正文' })) })
  await writeFile(input, body)
  const script = resolve('docs/acceptance/resident-leaf-coordination-repair/scripts/release-preflight.mjs')
  const run = (mode) => spawnSync(process.execPath, [script, mode, '--input', input, '--output', output], { encoding: 'utf8' })
  assert.equal(run('--check').status, 0)
  assert.deepEqual(await readdir(dir), ['before.json'])
  assert.equal(await readFile(input, 'utf8'), body)
  assert.equal(run('--write').status, 0)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).taskPromptsVersion, 2)
  assert.notEqual(run('--write').status, 0)
  assert.equal(await readFile(input, 'utf8'), body)
})

test('离线流程修订只更新两个目标版本且重复执行不增版', () => {
  const before = { taskPromptsVersion: 7, model: 'unchanged', taskPrompts: [{ id: 'workflow-production-release', revision: 2, prompt: '原生产正文', enabled: true }, { id: 'workflow-data-change', revision: 3, prompt: '原数据正文', enabled: false }, { id: 'other', revision: 4, prompt: '无关' }] }
  const after = revisePreflightPrompts(before)
  assert.equal(after.taskPromptsVersion, 8)
  assert.deepEqual(after.taskPrompts.map((p) => p.revision), [3, 4, 4])
  assert.equal(after.model, before.model)
  assert.deepEqual(after.taskPrompts[2], before.taskPrompts[2])
  assert.equal(after.taskPrompts[1].enabled, false)
  assert.deepEqual(revisePreflightPrompts(after), after)
  assert.equal(before.taskPrompts[0].prompt, '原生产正文')
})

const evidence = () => ({ baseline: { environment: 'production', readOnly: true, observedAt: '2026-09-10T08:00:00Z', evidenceRef: 'baseline.json' }, candidate: { revision: 'sha1', dependencyInventoryComplete: true, requiredObjects: ['base-table'], evidenceRef: 'candidate.json' }, observations: [{ name: 'base-table', status: 'present', evidenceRef: 'readback.json' }], rehearsalEnvironment: { authorized: true, isolated: true, available: true, runbookRef: 'uat.md', evidenceRef: 'environment.json' }, executionOrder: { steps: ['sql', 'backend'], dependencies: [{ before: 'sql', after: 'backend' }], stopConditions: ['前置失败停止'], rollbackScope: '已声明范围', evidenceRef: 'plan.json' } })
test('缺基础对象FAIL，依赖集合或基线不完整UNKNOWN，均不得通过', () => {
  assert.equal(assessReleasePreflight(evidence()).status, 'PASS')
  const missing = evidence(); missing.observations[0].status = 'missing'
  assert.equal(assessReleasePreflight(missing).status, 'FAIL')
  const unknown = evidence(); unknown.candidate.dependencyInventoryComplete = false
  assert.equal(assessReleasePreflight(unknown).status, 'UNKNOWN')
  assert.equal(assessReleasePreflight({ ...evidence(), baseline: undefined }).status, 'UNKNOWN')
  const noProof = evidence(); delete noProof.observations[0].evidenceRef
  assert.equal(assessReleasePreflight(noProof).status, 'UNKNOWN')
})
test('未经授权共享UAT和逆序依赖均FAIL，不强制选择Docker', () => {
  const shared = evidence(); shared.rehearsalEnvironment.isolated = false
  assert.equal(assessReleasePreflight(shared).status, 'FAIL')
  const wrong = evidence(); wrong.executionOrder.steps.reverse()
  assert.equal(assessReleasePreflight(wrong).status, 'FAIL')
  assert.equal(assessReleasePreflight(evidence()).checks.find((c) => c.id === 'rehearsal-environment').status, 'PASS')
})
