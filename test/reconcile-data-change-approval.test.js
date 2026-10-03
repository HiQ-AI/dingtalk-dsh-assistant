import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { validateManifest, readonlyClients, reconcileReadonlyGate, verifyClosedBackup } from '../scripts/reconcile-data-change-approval.mjs'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const manifest = root => ({ version: 1, scope: 'data-change-approval-handoff', runtimeDirectory: root,
  domainDirectory: root, profileDirectory: root, profilePath: join(root, 'cordis.patch.yml'), dbPath: join(root, 'control.sqlite'),
  artifactDirectory: join(root, 'artifacts'), secretsDirectory: root, taskWorkspaceRoot: root, instanceId: 'test',
  ownerActorId: 'owner', taskId: 'task', runId: 'run', effectId: 'effect', expectedProfileSha256: 'a'.repeat(64), runtimePorts: [18998] })

test('清单检查可发现binding，执行必须精确binding/offline/路径，零写端口不能转发平台写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approval-cutover-manifest-')), m = manifest(root)
  assert.equal(validateManifest(m, 'check'), m)
  assert.throws(() => validateManifest(m, 'reconcile'), /BINDING_REQUIRED/)
  assert.throws(() => validateManifest({ ...m, bindingDigest: 'b'.repeat(64) }, 'reconcile'), /OFFLINE_REQUIRED/)
  assert.throws(() => validateManifest({ ...m, dbPath: join(root, 'other.sqlite') }, 'check'), /MANIFEST_INVALID/)
  let writes = 0, reads = 0
  const clients = readonlyClients({ bytebase: { getIssueBundle: async () => { reads++; return {} },
    createIssueBundle: async () => { writes++ }, runTask: async () => { writes++ } },
    productionPostgres: { readBaseline: async () => { reads++ }, execute: async () => { writes++ } } })
  await clients.bytebase.getIssueBundle(); await clients.productionPostgres.readBaseline()
  await assert.rejects(clients.bytebase.createIssueBundle(), /DISPATCH_FORBIDDEN/)
  await assert.rejects(clients.bytebase.runTask(), /DISPATCH_FORBIDDEN/)
  await assert.rejects(clients.productionPostgres.execute(), /DISPATCH_FORBIDDEN/)
  await assert.rejects(clients.uatPostgres.rehearseInUat(), /DISPATCH_FORBIDDEN/)
  assert.equal(writes, 0); assert.equal(reads, 2)
})

test('原生待审unknown受信失败观察后才能seal，CAS失败不落账，重复对账不派发/不stopRun', async t => {
  const root = await mkdtemp(join(tmpdir(), 'approval-cutover-native-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'test', initialize: true })
  t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let reads = 0, writes = 0
  const adapter = { execute: async () => { reads++; return { status: 'unknown', reason: 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED' } },
    closeReadonlyApproval: async () => { reads++; return { status: 'failed', reason: 'APPROVAL_CHANNEL_SUPERSEDED', result: { readonlyProof: 'same-issue' } } } }
  const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => { throw new Error('no write') },
    authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'readonly-approval' }), externalAdapter: adapter })
  const workflow = { id: 'task-data-change', version: '5', nodes: [{ id: 'approval-gate', version: '1', executor: 'code',
    allowedEffects: ['external.operation'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    mapInput: ({ requirement }) => requirement,
    execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external',
      prepared: { action: 'external', workflowKind: 'data-change', stage: 'approval-gate', runId, generation,
        requirementDigest, resourceKey: 'external:database:app', intent: { approvalSource: 'bytebase' } } }) }] }
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: workflow.id, input: {} })
  await controller.whenIdle('run')
  const effect = (await store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(effect.state, 'unknown')
  const before = await store.query({ kind: 'runtime.maintenance' })
  await store.command({ id: 'maintenance', kind: 'runtime.maintenance.change', args: { active: true, maintenanceId: 'deploy-test',
    actorId: 'owner', reason: '禁派发对账', expectedRevision: before.revision } })
  const m = { ...manifest(root), effectId: effect.effectId, bindingDigest: 'b'.repeat(64), offline: { maintenanceId: 'deploy-test', actorId: 'owner' } }
  const platform = { operationAdapter: { ...adapter, execute: async () => { writes++; throw new Error('write prohibited') } } }
  await assert.rejects(reconcileReadonlyGate({ store, artifacts, platform, m,
    verifyCurrent: async () => { throw new Error('CAS changed') } }), /CAS changed/)
  assert.equal((await store.query({ kind: 'effect.get', effectId: effect.effectId })).state, 'unknown')
  const interruptedStore = { query: query => store.query(query), command: command => {
    if (command.kind === 'runtime.maintenance.seal') throw new Error('crash after close before seal')
    return store.command(command)
  } }
  await assert.rejects(reconcileReadonlyGate({ store: interruptedStore, artifacts, platform, m,
    verifyCurrent: async () => {} }), /crash after close before seal/)
  assert.equal((await store.query({ kind: 'effect.get', effectId: effect.effectId })).state, 'failed')
  assert.equal((await store.query({ kind: 'runtime.maintenance' })).phase, 'draining')
  const closed = await reconcileReadonlyGate({ store, artifacts, platform, m, verifyCurrent: async () => {} })
  assert.equal(closed.maintenance.phase, 'stopping'); assert.equal(closed.maintenance.drained, true)
  await reconcileReadonlyGate({ store, artifacts, platform, m, verifyCurrent: async () => {} })
  assert.equal(writes, 0)
  assert.equal((await store.query({ kind: 'run', runId: 'run' })).run.status, 'waiting')
  const db = new DatabaseSync(join(root, 'control.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT state FROM execution_effects WHERE effect_id=?').get(effect.effectId).state, 'failed')
    assert.equal(db.prepare('SELECT count(*) n FROM execution_effect_observations WHERE effect_id=?').get(effect.effectId).n, 2) }
  finally { db.close() }
  assert.equal(reads, 5)
})

test('关闭观察后重放仍核验完整备份原文件；新增观察不使旧备份失效，篡改拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approval-cutover-backup-')), backup = join(root, 'backup')
  const taskDirectory = join(root, 'tasks'), original = join(taskDirectory, 'task/work/artifacts/old.json')
  await mkdir(join(taskDirectory, 'task/work/artifacts'), { recursive: true })
  await mkdir(join(backup, 'tasks/task/work/artifacts'), { recursive: true })
  await mkdir(join(backup, 'runtime'), { recursive: true })
  await writeFile(original, '{}'); await writeFile(join(backup, 'tasks/task/work/artifacts/old.json'), '{}')
  const restored = join(backup, 'runtime/verified-control.sqlite'), db = new DatabaseSync(restored)
  db.exec('CREATE TABLE proof(id INTEGER)'); db.close()
  const proof = { verified: true, taskDirectory, manifest: [{ path: 'tasks/task/work/artifacts/old.json', bytes: 2, sha256: hash('{}') }],
    database: { restoreFile: 'runtime/verified-control.sqlite', sha256: hash(await readFile(restored)) } }
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(proof))
  const m = { ...manifest(root), offline: { backupRoot: backup, taskDirectory } }
  await writeFile(join(taskDirectory, 'task/work/artifacts/new-observation.json'), '{"status":"failed"}')
  assert.equal((await verifyClosedBackup(m)).writes, 0)
  await writeFile(original, '{"changed":true}')
  await assert.rejects(verifyClosedBackup(m), /BACKUP_SOURCE_CHANGED/)
})
