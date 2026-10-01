import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createGitDelivery } from '../packages/dingtalk-dsh-assistant/execution-git.js'
import { freezeCandidate, verifyCandidate } from '../packages/dingtalk-dsh-assistant/execution-candidate.js'

import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'

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


test('原生 PR 链：相同预检失败跨 Controller 重启，同 effect 新 lease 恢复且仅创建一次', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pr-native-recovery-')), script = join(root, 'gh.cjs'), file = join(root, 'remote.json')
  await writeFile(file, JSON.stringify({ network: false, creates: 0, reads: 0, sha: 'a'.repeat(40), pr: null }))
  await writeFile(script, `const fs=require('node:fs'),[file,...args]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file));
const value=x=>args[args.indexOf(x)+1];
if(args[0]==='api'){s.reads++;fs.writeFileSync(file,JSON.stringify(s));if(!s.network){console.error('connection refused');process.exit(1)}
if(args.includes('--paginate'))console.log(JSON.stringify([s.pr?[{number:1,html_url:s.pr.url,state:'open',head:{sha:s.sha,ref:'codex/test'},base:{ref:'main'},body:s.pr.body}]:[]]));else console.log(JSON.stringify({object:{sha:s.sha}}));}
else if(args[1]==='view')console.log(JSON.stringify(s.pr));
else if(args[1]==='create'){s.creates++;s.pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:s.sha,headRefName:'codex/test',baseRefName:'main',body:fs.readFileSync(value('--body-file'),'utf8')};fs.writeFileSync(file,JSON.stringify(s));console.log(s.pr.url)}else process.exit(2);`)
  const storeOptions = { dbPath: join(root, 'control.db'), instanceId: 'pr-integration', initialize: true }
  let store = await openExecutionStore(storeOptions), controller
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const adapter = createGithubPullRequests({ repository: root, repo: 'test/repo', base: 'main', head: 'codex/test', ghCommand: { executable: process.execPath, args: [script, file] } })
  const makeController = () => {
    const delivery = createExecutionDelivery({ store, artifacts, prAdapter: adapter, authorize: async () => ({ principalId: 'synthetic', authorizationRef: 'explicit-task' }) })
    return createExecutionController({ store, artifacts, delivery, workflows: [{ id: 'pr', version: '1', nodes: [
      { id: 'pr', version: '1', executor: 'code', allowedEffects: ['github.pr'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement,
        execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'pr', prepared: adapter.prepare({ runId, generation, requirementDigest, commitId: 'a'.repeat(40), title: 'Title', body: 'verified' }) }) },
    ] }] })
  }
  controller = makeController()
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'pr', input: { request: 'PR' } })
  let state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting'); assert.equal(state.nodes[0].waitReason.reference, 'PR_CONNECTION_FAILED')
  const first = (await store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(first.state, 'failed'); assert.equal(first.result.result.mutationAttempted, false)
  await controller.recover({ commandId: 'second-attempt', runId: 'run' }); await controller.whenIdle('run')
  const second = (await store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(second.effectId, first.effectId); assert.equal(second.state, 'failed'); assert.ok(second.dispatchLeaseEpoch > first.dispatchLeaseEpoch)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).creates, 0)
  await controller.close(); await store.close()
  store = await openExecutionStore({ ...storeOptions, initialize: false }); controller = makeController()
  const remote = JSON.parse(await readFile(file, 'utf8')); remote.network = true; await writeFile(file, JSON.stringify(remote))
  await controller.recover({ commandId: 'after-restart', runId: 'run' }); state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded')
  const final = (await store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(final.effectId, first.effectId); assert.equal(final.state, 'succeeded'); assert.ok(final.dispatchLeaseEpoch > second.dispatchLeaseEpoch)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).creates, 1)
})
