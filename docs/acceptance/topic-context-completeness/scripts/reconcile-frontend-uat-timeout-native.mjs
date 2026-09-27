import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHostPlatformClients } from '../../../../packages/dingtalk-dsh-assistant/platform-host.js'
import { createReleasePlatform } from '../../../../packages/dingtalk-dsh-assistant/workflow-release-platform.js'
import { executionDigest, openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { createExecutionDelivery, isTerminalUatBuildFailure } from '../../../../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { maintenanceStatus } from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import { verifyDeploymentBackup } from '../../../../scripts/deployment-integrity.mjs'

const root = 'D:/dsh_home/workflows/runtime-v2', profile = 'D:/dsh_home/profiles/web'
const domain = 'D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116'
export const evidence = new URL('../../../tmp/frontend-uat-timeout-incident/', import.meta.url)
export const incidentScope = 'frontend-uat-timeout'
export const manifestDigest = '08e93a01c52a0a3fefeed3a8f3712adedea6cd6151adb63056fd8718ddf53fb1'
const fail = code => { throw Error(code) }
export async function manifest() {
  const m = JSON.parse(await readFile(new URL('../round-36/frontend-uat-timeout-manifest.json', import.meta.url), 'utf8'))
  if (executionDigest(m) !== manifestDigest) fail('INCIDENT_MANIFEST_DRIFT')
  return m
}
export function validateGate(s, m) {
  const e = s.effect, r = s.run, definition = JSON.parse(e?.definition_json ?? '{}')
  if (s.instanceId !== m.instanceId || e?.effect_id !== m.effectId || e.run_id !== m.runId
    || e.node_id !== 'execute-build' || e.node_run_id !== m.nodeRunId || e.kind !== 'operation'
    || e.generation !== m.generation || e.input_digest !== m.inputDigest || e.definition_digest !== m.definitionDigest
    || definition.action !== 'external' || definition.adapterId !== 'external-operation' || definition.adapterVersion !== '1'
    || executionDigest(definition.payload) !== executionDigest(m.prepared)) fail('INCIDENT_EFFECT_DRIFT')
  if (m.prepared.workflowKind !== 'uat-deployment' || m.prepared.operation !== 'build'
    || m.prepared.expected.commitSha !== 'd1e447787201212140a2732b798d336965ddfaa7'
    || m.prepared.resourceKey !== 'external:uat:HiQ-AI/dataset-web:dataset-web') fail('INCIDENT_SCOPE_DRIFT')
  if (!['unknown', 'failed'].includes(e.state) || s.busy.nodes || s.busy.owners || s.busy.messages || s.otherEffects.length) fail('INCIDENT_EXECUTION_NOT_DRAINED')
  if (r.run_id !== m.runId || r.task_id !== m.taskId || r.workflow_digest !== m.workflowDigest
    || r.requirement_ref !== m.requirementRef || r.generation !== m.generation || r.revision !== m.runRevision
    || r.claim_count !== m.claimCount || r.stop_requested || r.pause_requested || !['waiting', 'queued'].includes(r.status)) fail('INCIDENT_RUN_DRIFT')
  if (s.controlState !== 'active' || s.pendingInputCount) fail('INCIDENT_TASK_CONTROL_INVALID')
  if (s.nodes.length !== m.nodeIdentities.length || s.nodes.some(n => !n.drained || n.status === 'running')) fail('INCIDENT_NODE_NOT_DRAINED')
  for (const original of m.nodeIdentities) {
    const n = s.nodes.find(n => n.node_run_id === original.nodeRunId)
    if (!n || n.node_id !== original.nodeId || n.input_digest !== original.inputDigest || n.output_ref !== original.outputRef
      || (original.nodeId === 'execute-build' ? !['waiting', 'ready'].includes(n.status) || n.lease_epoch !== m.nodeLeaseEpoch
        : n.status !== original.status)) fail('INCIDENT_NODE_IDENTITY_DRIFT')
  }
  const node = s.nodes.find(n => n.node_run_id === m.nodeRunId)
  if (node.status === 'waiting' && JSON.parse(node.wait_reason ?? '{}').reference !== 'DELIVERY_RECONCILIATION_REQUIRED') fail('INCIDENT_WAIT_REASON_INVALID')
  if (e.state === 'failed' && !isTerminalUatBuildFailure({ state: e.state, definition, result: JSON.parse(e.result_json ?? '{}') })) fail('INCIDENT_FAILED_RECEIPT_INVALID')
  return s
}
export function snapshot(m) {
  const db = new DatabaseSync(root + '/control.sqlite', { readOnly: true })
  try {
    db.exec('BEGIN')
    const state = maintenanceStatus(db)
    return validateGate({ effect: db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(m.effectId),
      run: db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(m.runId),
      nodes: db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(m.runId),
      controlState: db.prepare('SELECT state FROM task_controls WHERE task_id=?').get(m.taskId)?.state,
      pendingInputCount: db.prepare("SELECT count(*) n FROM execution_inputs WHERE run_id=? AND status='pending'").get(m.runId).n,
      busy: state.busy, maintenance: state,
      otherEffects: db.prepare("SELECT effect_id FROM execution_effects WHERE state IN ('starting','executing','unknown') AND effect_id<>?").all(m.effectId),
      instanceId: db.prepare('SELECT instance_id FROM execution_meta').get().instance_id }, m)
  } finally { db.close() }
}
export async function readAdapter(m) {
  const require = createRequire(profile + '/package.json'), yaml = require('js-yaml')
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: v => v })])
  const document = yaml.load(await readFile(profile + '/cordis.patch.yml', 'utf8'), { schema }), found = [], seen = new Set()
  const walk = v => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v.repositories) && ['dataset', 'dataset-web'].every(id => v.repositories.some(r => r.id === id))) found.push(v)
    Object.values(v).forEach(walk)
  }
  walk(document)
  const targets = found.length === 1 ? found[0].platforms.release.targets.filter(t => t.id === 'dataset-web-uat2-deployment') : []
  if (targets.length !== 1 || executionDigest(targets[0]) !== executionDigest(m.platformTarget)) fail('INCIDENT_TARGET_DRIFT')
  const clients = (await createHostPlatformClients({ secretsDirectory: 'D:/baibu-agent/.secrets' })).release
  // Constructor requires triggerBuild capability; this incident deliberately replaces it with a rejection.
  const platform = createReleasePlatform({ targets: targets.map(({ id, ...target }) => target),
    clients: { ...clients, woodpecker: { ...clients.woodpecker, triggerBuild: async () => fail('INCIDENT_DISPATCH_FORBIDDEN') } } })
  return { async reconcile(prepared) {
    const [scan, pr, branch] = await Promise.all([
      clients.woodpecker.listPipelines({ baseUrl: m.platformTarget.woodpecker.baseUrl, repositoryId: 2 }),
      clients.github.readPullRequest({ repository: 'HiQ-AI/dataset-web', number: 368 }),
      clients.github.readBranch({ repository: 'HiQ-AI/dataset-web', branch: 'feature/uat2-base' }),
    ])
    const same = scan.pipelines.filter(p => p.commitSha === m.pipeline.commitSha && p.branch === m.pipeline.branch)
    if (!scan.complete || same.length !== 1 || same[0].number !== 319 || same[0].status !== 'killed'
      || !pr.merged || pr.baseBranch !== m.pipeline.branch || pr.headCommitSha !== m.pipeline.commitSha
      || pr.mergeCommitSha !== m.pipeline.commitSha || branch.commitSha !== m.pipeline.commitSha) fail('INCIDENT_TERMINAL_PROOF_DRIFT')
    return platform.operationAdapter.reconcile(prepared)
  } }
}
export async function checkObserved(m, adapter) {
  const receipt = await adapter.reconcile(m.prepared)
  const effect = { state: 'failed', definition: { action: 'external', adapterId: 'external-operation', adapterVersion: '1', payload: m.prepared }, result: { result: receipt } }
  if (!isTerminalUatBuildFailure(effect) || receipt.pipelineNumber !== 319 || receipt.pipelineStatus !== 'killed') fail('INCIDENT_FAILURE_NOT_OBSERVED')
  return receipt
}
export async function nativeRecover({ store, artifacts, m, operationAdapter, readSnapshot, maintenanceId, actorId }) {
  const before = validateGate(await readSnapshot(), m)
  if (!before.maintenance.active || before.maintenance.maintenanceId !== maintenanceId || before.maintenance.actorId !== actorId) fail('INCIDENT_MAINTENANCE_DRIFT')
  const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => fail('INCIDENT_DISPATCH_FORBIDDEN'),
    externalAdapter: { reconcile: async prepared => {
      if (executionDigest(prepared) !== executionDigest(m.prepared)) fail('INCIDENT_PAYLOAD_DRIFT')
      return checkObserved(m, operationAdapter)
    } } })
  const effect = await delivery.reconcile(m.effectId)
  if (!isTerminalUatBuildFailure(effect)) fail('INCIDENT_RECONCILE_UNKNOWN')
  const after = validateGate(await readSnapshot(), m)
  if (!after.maintenance.active || after.maintenance.maintenanceId !== maintenanceId || after.maintenance.actorId !== actorId) fail('INCIDENT_MAINTENANCE_DRIFT')
  if (after.run.status === 'waiting') await store.command({ id: 'frontend-timeout-recover:' + m.prepared.operationKey, kind: 'run.recover', args: { runId: m.runId } })
  let state = await store.query({ kind: 'runtime.maintenance' })
  if (state.phase === 'draining') await store.command({ id: 'frontend-timeout-seal:' + m.prepared.operationKey, kind: 'runtime.maintenance.seal',
    args: { maintenanceId, actorId, expectedRevision: state.revision, reason: '前端319超时已原生确认失败，保留原运行并封存安装后收口' } })
  state = await store.query({ kind: 'runtime.maintenance' })
  if (state.phase !== 'stopping' || !state.drained) fail('INCIDENT_SEAL_FAILED')
  return { effectId: m.effectId, effectState: effect.state, runId: m.runId,
    runStatus: (await store.query({ kind: 'run', runId: m.runId })).run.status, maintenance: state, remoteWriteAttempts: 0 }
}
export async function main(mode) {
  if (!['--check', '--snapshot', '--readback', '--reconcile'].includes(mode)) fail('INCIDENT_ARGUMENT_INVALID')
  const m = await manifest(), operationAdapter = await readAdapter(m)
  const receipt = await checkObserved(m, operationAdapter), state = snapshot(m)
  if (mode !== '--reconcile') return { mode, writes: 0, ready: true, effectState: state.effect.state, runStatus: state.run.status,
    receipt, maintenance: state.maintenance, complete: state.effect.state === 'failed' && state.run.status === 'queued' && state.maintenance.phase === 'stopping' }
  const plan = JSON.parse(await readFile(new URL('execution-plan.json', evidence), 'utf8'))
  if (plan.scope !== incidentScope || plan.manifestDigest !== manifestDigest) fail('INCIDENT_AUTHORIZATION_REQUIRED')
  const offline = JSON.parse(await readFile(new URL('offline.json', evidence), 'utf8'))
  if (offline.effectId !== m.effectId || offline.manifestDigest !== manifestDigest || offline.scope !== incidentScope) fail('INCIDENT_OFFLINE_PROOF_INVALID')
  if (state.effect.state !== 'unknown' || state.run.status !== 'waiting' || state.maintenance.phase !== 'draining') fail('INCIDENT_PARTIAL_NATIVE_PROGRESS_READBACK_REQUIRED')
  await verifyDeploymentBackup({ runtime: root, domain, profile, backupRoot: offline.backup })
  const store = await openExecutionStore({ dbPath: root + '/control.sqlite', instanceId: m.instanceId })
  try {
    return await nativeRecover({ store, artifacts: await openExecutionArtifacts({ directory: root + '/artifacts' }), m,
      operationAdapter, readSnapshot: () => snapshot(m), maintenanceId: offline.maintenanceId, actorId: state.maintenance.actorId })
  } finally { await store.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2])
  .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
