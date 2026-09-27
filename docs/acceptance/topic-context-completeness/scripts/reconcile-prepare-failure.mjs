import { readFile, access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../../../../packages/dingtalk-dsh-assistant/execution-delivery.js'

// 此工具仅对账本次准备失败事件；没有可选择的 effect 或“强制解锁”参数。
export const incident = Object.freeze({
  effectId: 'external-d08db79d462bc9538faf842feca5131e27aa5d2df4fc7963d482f1a80707f240',
  identity: '365cc3de9b2d30868f489153bf6c0e7c9c43845b0d8840ecf9ce733eeda907c5',
  taskId: 'task-web-eef13ea07fe7ef7eeb00df717e6a06eb61dc5d1d15382a998094e9a1755cf1da',
  runId: 'run-fcfcafcb5f72d356dfca5aac311cd549c63bffb0a1c109ce85927ee7a5f2c1ac',
  namespace: 'acceptance-365cc3de9b2d30868f489153bf6c0e7c',
  candidateDigest: '697bf8b53b927c8420f57ec5f4e6e21dd0f3e598aca11bf620ebe3f6a2377f2d',
  planDigest: '809de7391071812b7e9123f687eafb6376fabacaf939583c7e887e04541bb109',
  receiptHash: 'eb8e32eec1eb9561a659ced08c77cde45381ace250f82a73b58ba5a7979f1af0',
  preparedHash: 'b581a0dbe91715798d7fb9a148ac2209889770ef06699cbca58871b759bcee67',
})
const root = 'D:/dsh_home/workflows/runtime-v2'
const dbPath = root + '/control.sqlite'
const acceptance = root + '/engineering/dataset/local-acceptance/' + incident.identity
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const run = (exe, args, input) => new Promise((resolve, reject) => {
  const child = execFile(exe, args, { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(new Error('INCIDENT_READONLY_PROBE_FAILED'))
    try { resolve(JSON.parse(stdout)) } catch { reject(new Error('INCIDENT_PROBE_RESPONSE_INVALID')) }
  })
  child.stdin.end(input)
})
const probe = String.raw`
import json,sys,psycopg2,redis,yaml
try:
 ns='acceptance-365cc3de9b2d30868f489153bf6c0e7c';name='merge-'+ns
 c=json.load(open('D:/baibu-agent/.secrets/db-credentials.json',encoding='utf-8'))['connections']['hiq_editor_uat']
 assert c['db']=='hiq_editor'
 conn=psycopg2.connect(host=c['host'],port=c['port'],dbname=c['db'],user=c['user'],password=c['password'],connect_timeout=10,options='-c default_transaction_read_only=on -c statement_timeout=10000')
 try:
  with conn.cursor() as q:
   q.execute('show transaction_read_only');assert q.fetchone()[0]=='on'
   q.execute('select current_database()');assert q.fetchone()[0]=='hiq_editor'
   q.execute('select count(*) from tw_processes where name=any(%s)',([name,name+'-A',name+'-B'],));count=q.fetchone()[0]
 finally: conn.rollback();conn.close()
 s=yaml.safe_load(open('D:/dsh_home/workflows/runtime-v2/local-acceptance/shared-uat/application-local.yml',encoding='utf-8'))['spring']['redis']
 r=redis.Redis(host=s['host'],port=s['port'],password=s.get('password'),db=s.get('database',0),socket_timeout=10,decode_responses=True)
 snapshots=0
 try:
  for k in r.scan_iter(match='DATASET_MERGE_PREVIEW:*',count=100):
   raw=r.get(k)
   if raw is None: continue
   v=json.loads(raw)
   if isinstance(v,str):v=json.loads(v)
   assert isinstance(v,dict)
   if v.get('datasetName')==name:snapshots+=1
 finally:r.close()
 print(json.dumps({'namespace':ns,'database':'hiq_editor','readOnly':True,'processCount':count,'snapshotCount':snapshots}))
except Exception:
 sys.exit(1)
`
const machineProbe = String.raw`
$ErrorActionPreference='Stop'
$identity='365cc3de9b2d30868f489153bf6c0e7c9c43845b0d8840ecf9ce733eeda907c5'
$matches=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -in @('java.exe','node.exe','python.exe') -and $_.CommandLine -and ($_.CommandLine.Contains($identity) -or $_.CommandLine -match '(?<!\d)63486(?!\d)') })
$ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 63486 })
@{processCount=$matches.Count;listenerCount=$ports.Count} | ConvertTo-Json -Compress
`
export function validateEvidence(prepared, receipt, audit) {
  for (const key of ['identity', 'candidateDigest', 'planDigest', 'namespace'])
    if (prepared[key] !== incident[key] || receipt[key] !== incident[key]) fail('INCIDENT_IDENTITY_MISMATCH')
  if (prepared.taskId !== incident.taskId || prepared.runId !== incident.runId || prepared.generation !== 1
    || prepared.uatEnvironment !== 'uat3' || receipt.uatEnvironment !== 'uat3'
    || receipt.baseUrl !== 'http://127.0.0.1:63486' || receipt.passed !== false || receipt.checks?.length !== 0
    || JSON.stringify(receipt.phases?.map(p => [p.id,p.status])) !== JSON.stringify([['prepare','failed'],['cleanup','failed']])
    || receipt.cleanup?.processStopped !== true || receipt.cleanup?.dataCleaned !== false
    || receipt.failureCode !== 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED') fail('INCIDENT_NOT_PREPARE_ONLY_FAILURE')
  if (audit.namespace !== incident.namespace || audit.database !== 'hiq_editor' || audit.readOnly !== true
    || audit.processCount !== 0 || audit.snapshotCount !== 0 || audit.machine.processCount !== 0 || audit.machine.listenerCount !== 0)
    fail('INCIDENT_EXTERNAL_STATE_NOT_EMPTY')
}
async function evidence() {
  const [p,r] = await Promise.all(['prepared.json','receipt.json'].map(name => readFile(acceptance+'/'+name)))
  if (hash(p) !== incident.preparedHash || hash(r) !== incident.receiptHash) fail('INCIDENT_FILE_CHANGED')
  const prepared = JSON.parse(p), receipt = JSON.parse(r)
  // 原缺失账本绝不能重新初始化来制造清理证明。
  const ledger = root + '/local-acceptance/shared-uat/merge-evidence/' + incident.namespace + '/merge-ledger.json'
  try { await access(ledger); fail('INCIDENT_LEDGER_APPEARED') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const audit = await run('D:/soft/Python312/python.exe', ['-c',probe])
  audit.machine = await run('pwsh', ['-NoProfile','-Command',machineProbe])
  validateEvidence(prepared,receipt,audit)
  return { prepared, receipt, audit, observedAt: new Date().toISOString(), receiptSha256: hash(r), preparedSha256: hash(p), ledgerMissing: true }
}
function readControl() {
  const db = new DatabaseSync(dbPath,{readOnly:true})
  try {
    const row = db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(incident.effectId)
    const def = row && JSON.parse(row.definition_json)
    if (!row || row.state !== 'unknown' || row.run_id !== incident.runId || row.node_id !== 'run-local-acceptance'
      || def.action !== 'external' || def.adapterId !== 'external-operation' || def.adapterVersion !== '1'
      || def.payload.identity !== incident.identity || def.payload.taskId !== incident.taskId
      || def.payload.candidateDigest !== incident.candidateDigest || def.payload.planDigest !== incident.planDigest
      || def.payload.resourceKey !== 'external:local-acceptance:shared-uat') fail('INCIDENT_EFFECT_MISMATCH')
    const control = db.prepare('SELECT state FROM task_controls WHERE task_id=?').get(incident.taskId)
    if (!['cancelling','cancelled'].includes(control?.state)) fail('INCIDENT_NOT_CANCELLED')
    return { instanceId: db.prepare('SELECT instance_id FROM execution_meta').get().instance_id, definitionDigest: executionDigest(def), definition: def,
      observations: db.prepare('SELECT * FROM execution_effect_observations WHERE effect_id=? ORDER BY receipt_id').all(incident.effectId) }
  } finally { db.close() }
}
export async function main(mode) {
  if (!['--check','--execute'].includes(mode)) fail('USAGE_CHECK_OR_EXECUTE_ONLY')
  const before = readControl(), proof = await evidence()
  if (mode === '--check') return { mode, effectId: incident.effectId, ready: true, writes: 0, audit: proof.audit, receiptSha256: proof.receiptSha256 }
  // 先用与运行实例相同的独占锁备份；活动实例持锁时直接失败，不杀进程。
  const owner = new DatabaseSync(dbPath+'.owner.sqlite')
  const backupPath = dbPath+'.pre-prepare-failure-'+randomUUID()+'.sqlite'
  try {
    owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    const db = new DatabaseSync(dbPath,{readOnly:true})
    try {
      if (db.prepare("SELECT COUNT(*) AS n FROM execution_nodes WHERE current=1 AND (status='running' OR drained=0)").get().n
        || db.prepare("SELECT COUNT(*) AS n FROM task_owners WHERE status='running'").get().n
        || db.prepare("SELECT COUNT(*) AS n FROM execution_effects WHERE state IN ('starting','executing')").get().n) fail('INCIDENT_RUNTIME_NOT_DRAINED')
      db.prepare('VACUUM INTO ?').run(backupPath)
      const backup = new DatabaseSync(backupPath,{readOnly:true})
      try {
        if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
          || backup.prepare('SELECT instance_id FROM execution_meta').get().instance_id !== before.instanceId
          || backup.prepare('SELECT state FROM execution_effects WHERE effect_id=?').get(incident.effectId)?.state !== 'unknown') fail('INCIDENT_BACKUP_INVALID')
      } finally { backup.close() }
    } finally { db.close() }
  } finally { try { owner.exec('ROLLBACK') } catch {} owner.close() }
  const store = await openExecutionStore({ dbPath, instanceId: before.instanceId })
  try {
    if (executionDigest(readControl()) !== executionDigest(before)) fail('INCIDENT_CONTROL_CHANGED')
    const artifacts = await openExecutionArtifacts({directory:root+'/artifacts'})
    const delivery = createExecutionDelivery({store,artifacts,authorize:async()=>{fail('INCIDENT_DISPATCH_FORBIDDEN')},
      externalAdapter:{reconcile:async payload=>{
        if (executionDigest(payload)!==executionDigest(before.definition.payload)) fail('INCIDENT_PAYLOAD_CHANGED')
        const current=await evidence()
        return {status:'failed',reason:'LOCAL_ACCEPTANCE_PREPARE_FAILED_RECONCILED',businessAcceptancePassed:false,
          originalReceipt:current.receipt,originalReceiptSha256:current.receiptSha256,preparedSha256:current.preparedSha256,
          ledgerMissing:true,audit:current.audit,observedAt:current.observedAt,backupPath}
      }}})
    const result=await delivery.reconcile(incident.effectId)
    if(result.state!=='failed')fail('INCIDENT_RECONCILIATION_FAILED')
  } finally {await store.close()}
  const verify=new DatabaseSync(dbPath,{readOnly:true})
  try {
    const state=verify.prepare('SELECT state FROM execution_effects WHERE effect_id=?').get(incident.effectId)?.state
    const holds=verify.prepare('SELECT count(*) AS n FROM execution_resource_holds WHERE effect_id=?').get(incident.effectId).n
    const observations=verify.prepare('SELECT * FROM execution_effect_observations WHERE effect_id=? ORDER BY receipt_id').all(incident.effectId)
    if(state!=='failed'||holds!==0||before.observations.some(old=>!observations.some(row=>executionDigest(row)===executionDigest(old))))fail('INCIDENT_READBACK_FAILED')
    if(hash(await readFile(acceptance+'/receipt.json'))!==incident.receiptHash)fail('INCIDENT_ORIGINAL_RECEIPT_CHANGED')
    return {mode:'readback',effectId:incident.effectId,state,holds,backupPath,businessAcceptancePassed:false}
  } finally {verify.close()}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3)throw Error('USAGE_CHECK_OR_EXECUTE_ONLY')
  console.log(JSON.stringify(await main(process.argv[2])))
}
