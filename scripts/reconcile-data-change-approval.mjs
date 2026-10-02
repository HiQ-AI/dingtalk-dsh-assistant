import { readFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import yaml from 'js-yaml'
import { bootstrapProfile } from './bootstrap-workflow-maintenance.mjs'
import { reverifyDeploymentBackup } from './deployment-integrity.mjs'
import { createHostPlatformClients } from '../packages/dingtalk-dsh-assistant/platform-host.js'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { createDataChangeTaskWorkflowV5 } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'
import { nativeDataChangeOwnerContract } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { executionDigest, openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { queryEffects } from '../packages/dingtalk-dsh-assistant/execution-effects.js'
import { maintenanceStatus } from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'

const execFile = promisify(execFileCallback)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const deny = async () => fail('APPROVAL_RECONCILE_DISPATCH_FORBIDDEN')

export function validateManifest(m, mode) {
  if (m?.version !== 1 || m.scope !== 'data-change-approval-handoff') fail('APPROVAL_RECONCILE_MANIFEST_INVALID')
  for (const key of ['runtimeDirectory', 'domainDirectory', 'profileDirectory', 'profilePath', 'dbPath',
    'artifactDirectory', 'secretsDirectory', 'taskWorkspaceRoot']) if (!isAbsolute(m[key] ?? '')) fail('APPROVAL_RECONCILE_PATH_INVALID')
  for (const key of ['instanceId', 'ownerActorId', 'taskId', 'runId', 'effectId'])
    if (typeof m[key] !== 'string' || !m[key].trim()) fail('APPROVAL_RECONCILE_IDENTITY_INVALID')
  if (resolve(m.dbPath) !== resolve(m.runtimeDirectory, 'control.sqlite')
    || resolve(m.artifactDirectory) !== resolve(m.runtimeDirectory, 'artifacts')
    || resolve(m.profilePath) !== resolve(m.profileDirectory, 'cordis.patch.yml')
    || !/^[a-f0-9]{64}$/.test(m.expectedProfileSha256 ?? '')
    || (!Array.isArray(m.runtimePorts) || !m.runtimePorts.length
      || m.runtimePorts.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)))
    fail('APPROVAL_RECONCILE_MANIFEST_INVALID')
  if ((mode !== 'check' || m.bindingDigest !== undefined) && !/^[a-f0-9]{64}$/.test(m.bindingDigest ?? ''))
    fail('APPROVAL_RECONCILE_BINDING_REQUIRED')
  if (mode === 'reconcile' && (!m.offline || !isAbsolute(m.offline.backupRoot ?? '')
    || !/^[a-f0-9]{64}$/.test(m.offline.backupProofSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(m.offline.disabledProfileSha256 ?? '')
    || !m.offline.maintenanceId || m.offline.actorId !== m.ownerActorId
    || resolve(m.offline.taskDirectory ?? '') !== resolve(m.taskWorkspaceRoot, 'tasks'))) fail('APPROVAL_RECONCILE_OFFLINE_REQUIRED')
  return m
}

/** 只读快照；摘要冻结完整业务/Run/节点/输入/Owner，唯独允许本效果终态观察和维护状态改变。 */
export function readSnapshot(m) {
  const db = new DatabaseSync(m.dbPath, { readOnly: true })
  try {
    db.exec('BEGIN')
    const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(m.runId)
    const effect = db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(m.effectId)
    const nodes = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(m.runId)
    const task = db.prepare('SELECT * FROM business_tasks WHERE task_id=?').get(m.taskId)
    const control = db.prepare('SELECT * FROM task_controls WHERE task_id=?').get(m.taskId)
    const owner = db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(m.taskId)
    const inputs = db.prepare('SELECT * FROM execution_inputs WHERE run_id=? ORDER BY seq').all(m.runId)
    const stages = task && db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position').all(m.taskId, task.plan_revision)
    const record = run && db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(run.workflow_digest)
    const instanceId = db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id
    const state = maintenanceStatus(db)
    const otherEffects = db.prepare("SELECT effect_id FROM execution_effects WHERE state IN ('starting','executing','unknown') AND effect_id<>?").all(m.effectId)
    const { state: effectState, result_json, updated_at, ...effectBinding } = effect ?? {}
    const bindingDigest = executionDigest({ run, nodes, task, control, owner, inputs, stages, record, effect: effectBinding, instanceId })
    const store = { query: async query => {
      if (['effect.list', 'effect.get'].includes(query.kind)) return queryEffects(db, query)
      if (query.kind === 'run' && query.runId === m.runId) return { run: { runId: run.run_id, taskId: run.task_id,
        workflowId: run.workflow_id, workflowDigest: run.workflow_digest, requirementRef: run.requirement_ref,
        generation: run.generation, revision: run.revision, status: run.status }, nodes: nodes.map(node => ({
        nodeId: node.node_id, nodeRunId: node.node_run_id, generation: node.generation, leaseEpoch: node.lease_epoch,
        inputRef: node.input_ref, inputDigest: node.input_digest, drained: !!node.drained, status: node.status })),
        pendingInputCount: inputs.filter(item => item.status === 'pending').length }
      fail('APPROVAL_RECONCILE_READ_SCOPE_INVALID')
    }, command: deny }
    return { run, effect, nodes, task, control, owner, inputs, stages, record: record && JSON.parse(record.body),
      instanceId, maintenance: state, otherEffects, bindingDigest, store, close: () => db.close() }
  } catch (error) { db.close(); throw error }
}

export function validateSnapshot(s, m) {
  const payload = JSON.parse(s.effect?.definition_json ?? '{}').payload
  const closed = s.effect?.state === 'failed' && JSON.parse(s.effect.result_json ?? '{}').result?.reason === 'APPROVAL_CHANNEL_SUPERSEDED'
  if (s.instanceId !== m.instanceId || s.run?.task_id !== m.taskId || s.effect?.run_id !== m.runId
    || s.run.workflow_id !== 'task-data-change' || s.record?.definitionVersion !== '5'
    || s.run.status !== 'waiting' || s.run.pause_requested || s.run.stop_requested
    || s.control?.state !== 'active' || s.task?.status !== 'active' || !s.owner || s.owner.status !== 'idle'
    || s.owner.current_turn_id || s.nodes.some(node => !node.drained) || s.inputs.some(input => input.status === 'pending')
    || !s.stages?.some(stage => stage.run_id === m.runId && stage.status === 'running')
    || payload?.workflowKind !== 'data-change' || payload.stage !== 'approval-gate' || payload.intent?.approvalSource !== 'bytebase'
    || s.effect.state !== 'unknown' && !closed || s.otherEffects.length
    || s.maintenance.busy.nodes || s.maintenance.busy.owners || s.maintenance.busy.messages
    || s.maintenance.busy.effects !== (closed ? 0 : 1)
    || m.bindingDigest && s.bindingDigest !== m.bindingDigest) fail('APPROVAL_RECONCILE_BINDING_STALE')
  return { closed, bindingDigest: s.bindingDigest }
}

export function readonlyClients(clients) {
  const guard = (port, allowed) => Object.fromEntries(Object.entries(port ?? {}).map(([key, value]) =>
    [key, typeof value === 'function' ? allowed.includes(key) ? value.bind(port) : deny : value]))
  return { bytebase: guard(clients.bytebase, ['getIssueBundle', 'getIssueApproval', 'getTaskExecution']),
    productionPostgres: guard(clients.productionPostgres, ['readBaseline', 'checkPreconditions']),
    uatPostgres: Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql', 'rehearseInUat', 'getUatRehearsalByOperationKey'].map(key => [key, deny])) }
}

async function readPlatform(m, source) {
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
  const document = yaml.load(source, { schema }), residents = [], hosts = []
  const walk = value => { if (!value || typeof value !== 'object') return
    if (value.name === '@zzusp/dingtalk-dsh-assistant/resident') residents.push(value)
    if (value.config?.productionPostgres?.targets) hosts.push(value.config)
    Object.values(value).forEach(walk) }
  walk(document)
  if (residents.length !== 1 || hosts.length !== 1 || hosts[0].secretsDirectory !== m.secretsDirectory
    || residents[0].config?.workflow?.dbPath !== m.dbPath || residents[0].config.workflow.instanceId !== m.instanceId
    || residents[0].config.workflow.webActorId !== m.ownerActorId) fail('APPROVAL_RECONCILE_PROFILE_IDENTITY_INVALID')
  const clients = await createHostPlatformClients({ secretsDirectory: m.secretsDirectory,
    productionPostgres: hosts[0].productionPostgres })
  const configured = residents[0].config.workflow.platforms
  return createTrustedWorkflowPlatforms({ config: { bytebase: configured?.bytebase,
    productionApproverActorIds: configured?.productionApproverActorIds },
    clients: readonlyClients(clients), ownerActorId: m.ownerActorId })
}

async function verifyProof(m, platform, artifacts, snapshot) {
  const adapter = platform.dataChangeAdapter?.nativeAdapter, saved = snapshot.record.config
  if (saved.adapterId !== adapter?.id || saved.adapterVersion !== adapter.version || saved.rulesDigest !== adapter.rulesDigest)
    fail('APPROVAL_RECONCILE_DEFINITION_DRIFT')
  const workflow = { ...createDataChangeTaskWorkflowV5({ ...saved.modelConfig, adapter }), ownerContract: nativeDataChangeOwnerContract }
  const definition = defineExecutionWorkflow(workflow)
  if (![definition.digest, ...definition.legacyDigests].includes(snapshot.run.workflow_digest)) fail('APPROVAL_RECONCILE_DEFINITION_DRIFT')
  const delivery = createExecutionDelivery({ store: snapshot.store, artifacts, authorize: deny,
    externalAdapter: platform.operationAdapter })
  const controller = createExecutionController({ store: snapshot.store, artifacts, delivery, workflows: [workflow],
    readTools: [...new Set(workflow.nodes.flatMap(node => node.allowedTools ?? []))] })
  platform.bindExecution({ store: snapshot.store, artifacts, controller })
  return platform.verifyDataChangeApprovalHandoff({ taskId: m.taskId, runId: m.runId })
}

async function assertOffline(m, source, state) {
  if (!m.offline || !state.active || !['draining', 'stopping'].includes(state.phase)
    || state.maintenanceId !== m.offline.maintenanceId || state.actorId !== m.offline.actorId
    || hash(source) !== m.offline.disabledProfileSha256 || hash(bootstrapProfile(source, 'enable', yaml)) !== m.expectedProfileSha256)
    fail('APPROVAL_RECONCILE_MAINTENANCE_REQUIRED')
  const ports = m.runtimePorts.join(',')
  const { stdout } = await execFile('pwsh', ['-NoProfile', '-Command', `$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in @(${ports})); if($listeners.Count){exit 19}`], { windowsHide: true })
  if (stdout.trim()) fail('APPROVAL_RECONCILE_HOST_PRESENT')
}

export async function reconcileReadonlyGate({ store, artifacts, platform, m, verifyCurrent }) {
  const delivery = createExecutionDelivery({ store, artifacts, authorize: deny, externalAdapter: platform.operationAdapter })
  const effect = await delivery.closeReadonlyApproval(m.effectId, { beforeObserve: verifyCurrent })
  const state = await store.query({ kind: 'runtime.maintenance' })
  if (!state.active || state.maintenanceId !== m.offline.maintenanceId || state.actorId !== m.offline.actorId || !state.drained)
    fail('APPROVAL_RECONCILE_SEAL_NOT_DRAINED')
  if (state.phase === 'draining') await store.command({ id: `approval-reconcile-seal:${executionDigest([m.taskId, m.effectId, m.bindingDigest])}`,
    kind: 'runtime.maintenance.seal', args: { maintenanceId: m.offline.maintenanceId, actorId: m.offline.actorId,
      expectedRevision: state.revision, reason: '旧原生审批只读观察已可信失败收口，封存安装插件审批接续版本' } })
  const sealed = await store.query({ kind: 'runtime.maintenance' })
  if (sealed.phase !== 'stopping' || !sealed.drained) fail('APPROVAL_RECONCILE_SEAL_UNCONFIRMED')
  return { effectId: effect.effectId, effectState: effect.state, runId: m.runId, maintenance: sealed, remoteWriteAttempts: 0 }
}

/** 终态回执增加了新工件；重放核验不变的完整备份和所有原文件，不能要求新工件已在旧备份中。 */
export async function verifyClosedBackup(m) {
  const proof = JSON.parse(await readFile(join(m.offline.backupRoot, 'manifest.json'), 'utf8'))
  if (proof.verified !== true || !Array.isArray(proof.manifest)
    || proof.database?.restoreFile !== 'runtime/verified-control.sqlite'
    || resolve(proof.taskDirectory ?? '') !== resolve(m.offline.taskDirectory)) fail('APPROVAL_RECONCILE_BACKUP_INVALID')
  const paths = new Set()
  for (const item of proof.manifest) {
    if (!/^(domain|runtime|profile|tasks)\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/.test(item.path)
      || paths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('APPROVAL_RECONCILE_BACKUP_INVALID')
    paths.add(item.path)
    const path = join(m.offline.backupRoot, item.path), info = await lstat(path), bytes = await readFile(path)
    if (!info.isFile() || info.isSymbolicLink() || bytes.length !== item.bytes || hash(bytes) !== item.sha256)
      fail('APPROVAL_RECONCILE_BACKUP_CHANGED')
    const prefix = item.path.split('/')[0], relative = item.path.slice(prefix.length + 1)
    const original = prefix === 'domain' ? join(m.domainDirectory, relative)
      : prefix === 'tasks' ? join(m.offline.taskDirectory, relative)
        : prefix === 'runtime' && relative.startsWith('artifacts/') ? join(m.runtimeDirectory, relative) : null
    if (original && hash(await readFile(original)) !== item.sha256) fail('APPROVAL_RECONCILE_BACKUP_SOURCE_CHANGED')
  }
  const restored = join(m.offline.backupRoot, proof.database.restoreFile)
  if (hash(await readFile(restored)) !== proof.database.sha256) fail('APPROVAL_RECONCILE_BACKUP_CHANGED')
  const db = new DatabaseSync(restored, { readOnly: true })
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('APPROVAL_RECONCILE_BACKUP_INVALID') }
  finally { db.close() }
  return { verified: true, writes: 0 }
}

export async function main(mode, manifestPath) {
  if (!['check', 'readback', 'reconcile'].includes(mode) || !isAbsolute(manifestPath ?? '')) fail('APPROVAL_RECONCILE_ARGUMENT_INVALID')
  const m = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), mode)
  const source = await readFile(m.profilePath, 'utf8'), snapshot = readSnapshot(m)
  let alreadyClosed = false
  try {
    const gate = validateSnapshot(snapshot, m)
    if (hash(source) !== (m.offline?.disabledProfileSha256 ?? m.expectedProfileSha256)) fail('APPROVAL_RECONCILE_PROFILE_CAS')
    if (mode === 'reconcile') await assertOffline(m, source, snapshot.maintenance)
    const artifacts = await openExecutionArtifacts({ directory: m.artifactDirectory, taskWorkspaceRoot: m.taskWorkspaceRoot })
    const platform = await readPlatform(m, source)
    const proof = await verifyProof(m, platform, artifacts, snapshot)
    if (proof.effectId !== m.effectId) fail('APPROVAL_RECONCILE_EFFECT_DRIFT')
    alreadyClosed = gate.closed
    if (gate.closed && executionDigest(JSON.parse(snapshot.effect.result_json).result.result) !== executionDigest(proof))
      fail('APPROVAL_RECONCILE_RECEIPT_DRIFT')
    if (mode !== 'reconcile') return { mode, writes: 0, ...gate, proofDigest: executionDigest(proof),
      complete: gate.closed && snapshot.maintenance.phase === 'stopping', maintenance: snapshot.maintenance }
  } finally { snapshot.close() }
  if (hash(await readFile(join(m.offline.backupRoot, 'manifest.json'))) !== m.offline.backupProofSha256) fail('APPROVAL_RECONCILE_BACKUP_CAS')
  if (alreadyClosed) await verifyClosedBackup(m)
  else await reverifyDeploymentBackup({ backupRoot: m.offline.backupRoot, domain: m.domainDirectory,
    runtime: m.runtimeDirectory, taskDirectory: m.offline.taskDirectory })
  const store = await openExecutionStore({ dbPath: m.dbPath, instanceId: m.instanceId })
  try {
    const artifacts = await openExecutionArtifacts({ directory: m.artifactDirectory, taskWorkspaceRoot: m.taskWorkspaceRoot })
    const platform = await readPlatform(m, source), before = readSnapshot(m)
    try { validateSnapshot(before, m); await verifyProof(m, platform, artifacts, { ...before, store }) } finally { before.close() }
    return await reconcileReadonlyGate({ store, artifacts, platform, m, verifyCurrent: async () => {
      const current = readSnapshot(m)
      try { validateSnapshot(current, m); await assertOffline(m, await readFile(m.profilePath, 'utf8'), current.maintenance) }
      finally { current.close() }
    } })
  } finally { await store.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, check: { type: 'boolean' }, readback: { type: 'boolean' }, reconcile: { type: 'boolean' } } })
  const modes = ['check', 'readback', 'reconcile'].filter(mode => values[mode])
  if (modes.length !== 1) fail('APPROVAL_RECONCILE_ARGUMENT_INVALID')
  main(modes[0], values.manifest).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(/^APPROVAL_|^BYTEBASE_|^DATA_CHANGE_|^BACKUP_|^STORE_|^RUNTIME_MAINTENANCE_/.test(error.message) ? error.message : 'APPROVAL_RECONCILE_FAILED'); process.exitCode = 1 })
}
