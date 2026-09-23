import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createGitDelivery } from '../packages/dingtalk-dsh-assistant/execution-git.js'
import { freezeCandidate, verifyCandidate } from '../packages/dingtalk-dsh-assistant/execution-candidate.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim()
test('真实固定节点链：验证→commit丢回执→只读对账→续接push→远端SHA', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delivery-runtime-')), repository = join(root, 'source'), remote = join(root, 'remote.git')
  await mkdir(repository); await mkdir(remote)
  await git(repository, 'init', '-b', 'main'); await git(remote, 'init', '--bare')
  await git(repository, 'config', 'user.name', 'Synthetic'); await git(repository, 'config', 'user.email', 'synthetic@example.invalid')
  await writeFile(join(repository, 'value.txt'), 'base'); await git(repository, 'add', 'value.txt'); await git(repository, 'commit', '-m', 'base')
  const baseCommit = await git(repository, 'rev-parse', 'HEAD')
  await writeFile(join(repository, 'value.txt'), 'verified')
  const adapter = await createGitDelivery({ repository, remote, branch: 'delivery', author: { name: 'Synthetic', email: 'synthetic@example.invalid' } })
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'integration', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let commits = 0, pushes = 0
  const delivery = createExecutionDelivery({ store, artifacts, adapter: { ...adapter,
    executeCommit: async prepared => { commits++; await adapter.executeCommit(prepared); throw Object.assign(new Error('lost ack'), { code: 'SYNTHETIC_ACK_LOSS' }) },
    executePush: async prepared => { pushes++; return adapter.executePush(prepared) },
  }, authorize: async () => ({ principalId: 'synthetic', authorizationRef: 'explicit-test-task' }) })
  const object = { type: 'object' }, requiredChecks = [{ id: 'content', version: '1' }]
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [{ id: 'delivery', version: '1', nodes: [
    { id: 'verify', version: '1', executor: 'code', allowedEffects: ['read'], inputSchema: object, outputSchema: object, mapInput: ({ requirement }) => requirement,
      execute: async ({ generation, requirementDigest }) => {
        const candidate = await freezeCandidate({ repository, baseCommit, generation, requirementDigest })
        const verification = await verifyCandidate({ candidate, checks: [{ ...requiredChecks[0], run: async ({ readFile }) => ({ passed: (await readFile('value.txt')).toString() === 'verified', log: 'verified fixed bytes' }) }] })
        return adapter.prepareCommit({ candidate, verification, requiredChecks, message: 'verified result', date: '1790150400 +0000' })
      } },
    { id: 'commit', version: '1', executor: 'code', allowedEffects: ['git.commit'], inputSchema: object, outputSchema: object, mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, perform }) => { await perform({ action: 'commit', prepared: input }); return input } },
    { id: 'push', version: '1', executor: 'code', allowedEffects: ['git.push'], inputSchema: object, outputSchema: object, mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, perform }) => perform({ action: 'push', prepared: await adapter.preparePush({ commit: input, expectedRemoteSha: null }) }) },
  ] }] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'delivery', input: { requirement: 'verified content only' } })
  const waiting = await controller.whenIdle('run')
  assert.equal(waiting.run.status, 'waiting')
  assert.equal(waiting.nodes[2].leaseEpoch, 0)
  const [unknown] = await store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(unknown.state, 'unknown')
  assert.equal((await delivery.reconcile(unknown.effectId)).state, 'succeeded')
  await controller.recover({ commandId: 'recover', runId: 'run' })
  const completed = await controller.whenIdle('run')
  assert.equal(completed.run.status, 'succeeded')
  const output = await artifacts.read(completed.nodes[2].outputRef)
  assert.equal(output.status, 'succeeded')
  assert.equal(output.commitId, unknown.definition.payload.commitId)
  assert.equal(commits, 1); assert.equal(pushes, 1)
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/delivery'), unknown.definition.payload.commitId)
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal((await store.query({ kind: 'effect.list', runId: 'run' })).every(effect => effect.state === 'succeeded'), true)
})
