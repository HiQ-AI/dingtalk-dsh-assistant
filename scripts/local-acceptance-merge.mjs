import { readFile, writeFile, mkdir, rename, lstat, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { localOrigin } from './local-acceptance-readonly.mjs'

const exec = promisify(execFile)
const fail = code => { throw Object.assign(new Error(code), { code: `MERGE_ACCEPTANCE_${code}` }) }
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
// 有界十进制规范化，不经二进制浮点舍入；原始值仍单独保存到证据账。
export function exactDecimal(value) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof raw !== 'string' || raw.length > 256) fail('DECIMAL_INVALID')
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,4}))?$/.exec(raw)
  if (!match) fail('DECIMAL_INVALID')
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '') || '0'
  if (digits === '0') return '0'
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0)
  if (Math.abs(scale) > 1000) fail('DECIMAL_INVALID')
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale-- }
  const result = scale <= 0 ? digits + '0'.repeat(-scale) : scale >= digits.length
    ? '0.' + '0'.repeat(scale - digits.length) + digits : digits.slice(0, -scale) + '.' + digits.slice(-scale)
  return (match[1] === '-' ? '-' : '') + result
}
const tables = ['tw_processes', 'tw_process_core', 'tw_process_data', 'tw_process_doc', 'tb_activities']
const reviewedTrigger = 'fb925227a39750e0541737e945276fa0799a5e3c4f5fd953f357668c0dd63d80'
const reviewedConsumer = 'sha256:d154c2b3b41cce0848fdf55dc51afb885bf0565255bfd4b66b0786acd11cf530'

// 固定只读SQL；不接收来自任务或配置的SQL、shell片段或数据库连接串。
const probeProgram = String.raw`
import sys,json,hashlib,psycopg2
try:
 p=json.loads(sys.stdin.buffer.read().decode('utf-8'))
 with open(p['credentialsFile'],encoding='utf-8') as f:
  c=json.load(f)['connections'][p['databaseAlias']]
 conn=psycopg2.connect(host=c['host'],port=c['port'],dbname=c['db'],user=c['user'],password=c['password'],connect_timeout=10,options='-c default_transaction_read_only=on -c statement_timeout=10000')
 conn.set_session(readonly=True)
 with conn.cursor() as q:
  q.execute("select current_database(),current_setting('transaction_read_only')")
  identity=q.fetchone()
  q.execute("select conrelid::regclass::text,confrelid::regclass::text,conname,pg_get_constraintdef(oid) from pg_constraint where contype='f' and (conrelid::regclass::text=any(%s) or confrelid::regclass::text=any(%s)) order by conname",(p['tables'],p['tables']))
  fks=q.fetchall()
  q.execute("select c.relname,t.tgname,pg_get_triggerdef(t.oid),pg_get_functiondef(t.tgfoid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname=any(%s) order by c.relname,t.tgname",(p['tables'],))
  triggers=[{'table':r[0],'name':r[1],'definitionSha256':hashlib.sha256((r[2]+r[3]).encode()).hexdigest(),'emitsNotification':'pg_notify' in r[3].lower()} for r in q.fetchall()]
  q.execute("select d.id,d.process,d.val::text,d.unit_id,d.jsonb_data->>'declaredUnitId',d.is_reference_product,pr.tenant_id,pr.data_attribution,(select count(*) from tw_process_core co where co.process_id=pr.id and coalesce(co.is_deleted,false)=false),(select count(*) from tw_process_data rd where rd.process=pr.id and rd.is_reference_product=true and coalesce(rd.is_deleted,false)=false) from tw_process_data d join tw_processes pr on pr.id=d.process where d.id=any(%s) and coalesce(d.is_deleted,false)=false and coalesce(pr.is_deleted,false)=false order by d.id",(p['referenceIds'],))
  refs=[dict(zip(['id','processId','value','unitId','declaredUnitId','referenceProduct','tenantId','dataAttribution','coreCount','referenceCount'],r)) for r in q.fetchall()]
  q.execute("select id,unit_group_id,conversion_factor::text from tw_units where id=any(%s) and coalesce(is_deleted,false)=false",([p['kilogramUnitId'],p['tonneUnitId']],))
  units=[dict(zip(['id','groupId','factor'],r)) for r in q.fetchall()]
 conn.rollback();conn.close()
 print(json.dumps({'database':identity[0],'readOnly':identity[1]=='on','foreignKeys':fks,'triggers':triggers,'references':refs,'units':units},default=str))
except Exception:
 print('MERGE_ACCEPTANCE_DATABASE_PROBE_FAILED',file=sys.stderr)
 sys.exit(1)
`

const dataProgram = String.raw`
import sys,json,psycopg2,datetime,yaml,redis,re,os
from urllib.parse import urlparse
from psycopg2.extras import RealDictCursor,Json
def validate_resource_ownership(q,resources,processIds,uuids,tenant,owner):
 for table,values in resources.items():
  q.execute('select row_to_json(t) from '+table+' t where id=any(%s)',(values,))
  rows=[r[0] for r in q.fetchall()]
  assert len(rows)==len(values)
  for row in rows:
   assert row['tenant_id']==tenant and str(row['create_id'])==owner
   if table=='tw_process_core': assert row['process_id'] in processIds and row['process'] in uuids
   if table=='tw_process_data': assert row['process'] in processIds and row['core'] in resources['tw_process_core']
   if table=='tb_activities': assert row['activity_id'] in uuids
 # 同账号/租户仍可能共享文档或core；不能仅以创建人判定可删除。
 q.execute('select count(*) from tw_processes where process_doc_id=any(%s) and not (id=any(%s))',(resources['tw_process_doc'],processIds))
 assert q.fetchone()[0]==0
 q.execute('select count(*) from tw_processes where uuid=any(%s) and not (id=any(%s))',(uuids,processIds))
 assert q.fetchone()[0]==0
 q.execute('select count(*) from tw_process_data where core=any(%s) and not (id=any(%s))',(resources['tw_process_core'],resources['tw_process_data']))
 assert q.fetchone()[0]==0
try:
 p=json.loads(sys.stdin.buffer.read().decode('utf-8'));c=json.load(open(p['credentialsFile'],encoding='utf-8'))['connections'][p['databaseAlias']]
 mode=p['mode'];ledger=p['ledger'];ids=ledger['sources'];tenant=p['expectedTenantId'];owner=ledger.get('userId')
 datasource=ledger['datasourceId'];assert re.fullmatch(r'[0-9a-f-]{36}',datasource)
 settings=yaml.safe_load(open(p['springConfigFile'],encoding='utf-8'))
 admin=settings['spring']['datasource']['dynamic']['datasource']['admin']
 adminUrl=admin['url'].replace('$'+'{POSTGRES_DB_ADMIN:hiq_admin}',os.environ.get('POSTGRES_DB_ADMIN','hiq_admin'))
 assert '$'+'{' not in adminUrl and adminUrl.startswith('jdbc:postgresql://')
 parsed=urlparse(adminUrl[5:]);assert parsed.path=='/hiq_admin' and parsed.hostname and not parsed.username and not parsed.password
 adminConn=psycopg2.connect(host=parsed.hostname,port=parsed.port or 5432,dbname='hiq_admin',user=admin['username'],password=admin['password'],connect_timeout=10,options='-c default_transaction_read_only=on -c statement_timeout=10000')
 adminConn.set_session(readonly=True)
 with adminConn.cursor() as aq:
  aq.execute('select current_database()');assert aq.fetchone()[0]=='hiq_admin'
  aq.execute('select count(*) from public.ts_datasource_info where id=%s',(datasource,));adminDatasourceCount=aq.fetchone()[0];assert adminDatasourceCount==0
 adminConn.rollback();adminConn.close()
 conn=psycopg2.connect(host=c['host'],port=c['port'],dbname=c['db'],user=c['user'],password=c['password'],connect_timeout=10,options='-c statement_timeout=15000')
 conn.set_session(readonly=mode in ['inspect','verify'])
 def insert(q,table,row):
  q.execute('insert into '+table+' select * from jsonb_populate_record(null::'+table+',%s)',(Json(row),))
 def read(q,table,id):
  q.execute('select row_to_json(t) from '+table+' t where id=%s',(id,));v=q.fetchone();return v[0] if v else None
 with conn.cursor() as q:
  q.execute('select current_database()');assert q.fetchone()[0]==p['expectedDatabase']
  q.execute('select count(*) from public.te_data_quality_report where data_attribution=%s',(datasource,));qualityReportCount=q.fetchone()[0];assert qualityReportCount==0
  if mode=='provision':
   for s,template in zip(ids,p['referenceIds']):
    d=read(q,'tw_process_data',template);assert d and not d['is_deleted'] and d['is_reference_product']
    pr=read(q,'tw_processes',d['process']);co=read(q,'tw_process_core',d['core']);doc=read(q,'tw_process_doc',pr['process_doc_id'])
    assert pr['tenant_id']==tenant and co and doc
    for table,key in [('tw_processes','processId'),('tw_process_core','coreId'),('tw_process_data','dataId'),('tw_process_doc','docId')]: assert read(q,table,s[key]) is None
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    for row,key in [(pr,'processId'),(co,'coreId'),(d,'dataId'),(doc,'docId')]:
     row.update(id=s[key],tenant_id=tenant,create_id=owner,update_id=owner,create_time=now,update_time=now,is_deleted=False,delete_id=None,delete_time=None)
    pr.update(data_attribution=datasource,uuid=s['uuid'],name=s['name'],process_doc_id=s['docId'],reference_exchange_id=s['dataId'],reference_product_amount=0.5)
    co.update(process_id=s['processId'],process=s['uuid'])
    d.update(process=s['processId'],core=s['coreId'],val=0.5,unit_id=p['kilogramUnitId'],unit_name='kg')
    j=d.get('jsonb_data') or {};j.update(declaredUnitId=p['tonneUnitId'],declaredUnitName='t');d['jsonb_data']=j
    for table,row in [('tw_process_doc',doc),('tw_processes',pr),('tw_process_core',co),('tw_process_data',d)]:insert(q,table,row)
   conn.commit()
  processIds=[s['processId'] for s in ids]
  q.execute('select id,uuid,process_doc_id,create_id,tenant_id,name,data_attribution from tw_processes where name=%s',(ledger['resultName'],));results=q.fetchall()
  assert len(results)<=1
  if results:
   rr=results[0];assert rr[3]==owner and rr[4]==tenant and rr[6]==datasource
   if ledger.get('resultId'):assert rr[0]==ledger['resultId']
   processIds.append(rr[0])
  resultId=results[0][0] if results else None
  resources={}
  q.execute('select id,uuid,process_doc_id from tw_processes where id=any(%s) and tenant_id=%s and create_id=%s',(processIds,tenant,owner));owned=q.fetchall()
  q.execute('select count(*) from tw_processes where id=any(%s)',(processIds,));assert q.fetchone()[0]==len(owned)
  for s in ids:
   current=read(q,'tw_processes',s['processId'])
   if current:assert current['data_attribution']==datasource and current['name']==s['name'] and current['uuid']==s['uuid'] and current['process_doc_id']==s['docId']
  docs=[x[2] for x in owned];uuids=[x[1] for x in owned]
  queries={'tw_process_data':('process',processIds),'tw_process_core':('process_id',processIds),'tw_process_doc':('id',docs),'tb_activities':('activity_id',uuids),'tw_processes':('id',processIds)}
  for table,(key,values) in queries.items():
   q.execute('select id from '+table+' where '+key+'=any(%s)',(values,));resources[table]=[x[0] for x in q.fetchall()]
  for table,previous in ledger.get('resources',{}).items():
   assert table in queries
   q.execute('select id from '+table+' where id=any(%s)',(previous,));resources[table]=list(set(resources[table]+[x[0] for x in q.fetchall()]))
  validate_resource_ownership(q,resources,processIds,uuids,tenant,owner)
  q.execute('select id,val::text,unit_id,jsonb_data->>\'declaredUnitId\' from tw_process_data where process=%s and is_reference_product=true',(resultId,));referenceResults=q.fetchall()
  q.execute('select id,val::text,unit_id,jsonb_data->>\'declaredUnitId\' from tw_process_data where id=any(%s)',([s['dataId'] for s in ids],));sourceResults=q.fetchall()
  if mode=='cleanup':
   for table in ['tw_process_data','tw_process_core','tw_processes','tw_process_doc','tb_activities']:
    q.execute('delete from '+table+' where id=any(%s)',(resources[table],));assert q.rowcount==len(resources[table])
   conn.commit()
  else:conn.rollback()
 conn.close()
 snapshotCount=0;snapshotIds=[]
 if ledger.get('userId'):
  settings=yaml.safe_load(open(p['springConfigFile'],encoding='utf-8'))['spring']['redis']
  r=redis.Redis(host=settings['host'],port=settings['port'],password=settings.get('password'),db=settings.get('database',0),socket_timeout=10,decode_responses=True)
  # HTTP丢失响应时仍按精确namespace名称/租户/用户找回自有snapshot，不依赖拿到snapshotId。
  for key in r.scan_iter(match='DATASET_MERGE_PREVIEW:*',count=100):
   raw=r.get(key)
   if not raw:continue
   snapshotValue=json.loads(raw);assert isinstance(snapshotValue,str)
   snapshot=json.loads(snapshotValue)
   if snapshot.get('datasetName')!=ledger['resultName']:continue
   assert str(snapshot['userId'])==owner and snapshot['tenantId']==tenant
   snapshotIds.append(key.split(':',1)[1])
   if mode=='cleanup':
    assert r.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,key,raw)==1
   else:snapshotCount+=1
  r.close()
 print(json.dumps({'resultId':resultId,'resources':resources,'referenceResults':referenceResults,'sourceResults':sourceResults,'snapshotIds':snapshotIds,'snapshotCount':snapshotCount,'adminDatasourceCount':adminDatasourceCount,'qualityReportCount':qualityReportCount,'businessRows':sum(len(v) for v in resources.values())}))
except Exception:
 print('MERGE_ACCEPTANCE_DATA_OPERATION_FAILED',file=sys.stderr);sys.exit(1)
`

export function validateMergeConfig(config) {
  if (!config || config.uatEnvironment !== 'uat3' || config.databaseAlias !== 'hiq_editor_uat'
    || config.expectedDatabase !== 'hiq_editor' || !isAbsolute(config.credentialsFile ?? '')
    || !isAbsolute(config.pythonExecutable ?? '') || !isAbsolute(config.sourceRepository ?? '')
    || !/^[0-9a-f]{40}$/i.test(config.sourceCommit ?? '') || typeof config.expectedTenantId !== 'string' || !config.expectedTenantId
    || !Array.isArray(config.referenceIds) || config.referenceIds.length !== 2 || !config.referenceIds.every(uuid)
    || config.referenceIds[0] === config.referenceIds[1] || !uuid(config.kilogramUnitId) || !uuid(config.tonneUnitId)
    || config.kilogramUnitId === config.tonneUnitId) fail('CONFIG_INVALID')
  return config
}

export function assessMergePreflight(config, database, controller) {
  validateMergeConfig(config)
  const blockers = []
  if (database.database !== config.expectedDatabase || database.readOnly !== true) blockers.push('DATABASE_IDENTITY_UNCONFIRMED')
  if (!controller.includes('/merge-preview') || !controller.includes('confirmationService.confirm(')) blockers.push('CANDIDATE_PREVIEW_ENTRY_MISSING')
  // 所有用户触发器都必须审阅下游处理与清理；配置不得自行声明已安全。
  if (database.triggers.length !== 1 || database.triggers[0].definitionSha256 !== reviewedTrigger
    || database.consumerImage !== reviewedConsumer || database.consumerRouteVerified !== true) blockers.push('SIDE_EFFECT_TRIGGER_UNRESOLVED')
  if (database.foreignKeys.length) blockers.push('FOREIGN_KEY_CLEANUP_UNRESOLVED')
  const refs = database.references
  if (refs.length !== 2 || refs.some(r => !config.referenceIds.includes(r.id) || !(Number(r.value) > 0) || r.referenceProduct !== true
    || r.tenantId !== config.expectedTenantId || Number(r.coreCount) !== 1 || Number(r.referenceCount) !== 1)
    || new Set(refs.map(r => r.processId)).size !== 2 || new Set(refs.map(r => r.dataAttribution)).size !== 1
    || refs.some(r => !r.dataAttribution)) blockers.push('DEDICATED_FIXTURE_REQUIRED')
  const kg = database.units.find(u => u.id === config.kilogramUnitId)
  const tonne = database.units.find(u => u.id === config.tonneUnitId)
  if (!kg || !tonne || !kg.groupId || kg.groupId !== tonne.groupId || !(Number(kg.factor) > 0)
    || Number(tonne.factor) / Number(kg.factor) !== 1000) blockers.push('UNIT_CONVERSION_UNCONFIRMED')
  return { scenario: 'merge-normalization', uatEnvironment: 'uat3', readOnly: true, ready: blockers.length === 0,
    sourceCommit: config.sourceCommit, controllerSha256: createHash('sha256').update(controller).digest('hex'),
    blockers, database: { name: database.database, readOnly: database.readOnly, foreignKeys: database.foreignKeys,
      triggers: database.triggers }, fixture: { expectedSourceCount: 2, matchedSourceCount: refs.length,
      ready: !blockers.includes('DEDICATED_FIXTURE_REQUIRED'), referenceIds: config.referenceIds },
    cleanupContract: { businessData: tables, snapshots: 'exact-owned-snapshot-id', auditLogs: 'retained', dataCleaned: false } }
}

async function databaseProbe(config) {
  return new Promise((accept, reject) => {
    const child = execFile(config.pythonExecutable, ['-c', probeProgram], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(Object.assign(new Error('probe'), { code: 'MERGE_ACCEPTANCE_DATABASE_PROBE_FAILED' })); return }
      try { accept(JSON.parse(stdout)) } catch { reject(Object.assign(new Error('probe'), { code: 'MERGE_ACCEPTANCE_DATABASE_PROBE_FAILED' })) }
    })
    child.stdin.end(JSON.stringify({ ...config, tables }))
  })
}

async function dataOperation(mode, config, ledger) {
  return new Promise((accept, reject) => {
    const child = execFile(config.pythonExecutable, ['-c', dataProgram], { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(Object.assign(new Error('data'), { code: 'MERGE_ACCEPTANCE_DATA_OPERATION_FAILED' })); return }
      try { accept(JSON.parse(stdout)) } catch { reject(Object.assign(new Error('data'), { code: 'MERGE_ACCEPTANCE_DATA_OPERATION_FAILED' })) }
    })
    child.stdin.end(JSON.stringify({ ...config, mode, ledger }))
  })
}

export function confirmBody(preview) {
  if (!uuid(preview?.snapshotId) || !Array.isArray(preview.mergedItems) || !Array.isArray(preview.unmergedItems)) fail('PREVIEW_INVALID')
  const refs = preview.mergedItems.filter(g => g.mergeType === 'REFERENCE_PRODUCT')
  if (refs.length !== 1 || refs[0].sources?.length !== 2 || new Set(refs[0].sources.map(s => s.sourceItemId)).size !== 2
    || exactDecimal(refs[0].result?.resultValue) !== '1') fail('NORMALIZATION_MISMATCH')
  return { snapshotId: preview.snapshotId, mergedItems: preview.mergedItems.map(g => ({ id: g.id, mergeType: g.mergeType,
    sourceItemIds: g.sources.map(s => s.sourceItemId), result: { elementId: g.result.elementId, materialName: g.result.materialName,
      materialTypeId: g.result.materialTypeId, flowType: g.result.flowType, flowId: g.result.flowId, value: g.result.resultValue,
      unitId: g.result.unitId, output: g.result.output, resultDescription: g.result.resultDescription } })),
    unmergedItems: preview.unmergedItems.map(s => ({ sourceItemId: s.sourceItemId, resultDescription: s.resultDescription })) }
}

export async function executeMerge(mode, config, input, dependencies = {}) {
  validateMergeConfig(config)
  if (!['initialize', 'execute', 'api', 'cleanup', 'verify-cleanup'].includes(mode) || !/^acceptance-[a-f0-9]{32}$/.test(input?.namespace ?? '')
    || input.uatEnvironment !== 'uat3' || !/^https:\/\/editor[1-9]\.hiqdat\.dev$/.test(config.ssoOrigin ?? '')
    || !['evidenceRoot', 'accountsFile', 'springConfigFile'].every(k => isAbsolute(config[k] ?? '')) || config.accountKey !== 'editor_uat_admin') fail('INPUT_INVALID')
  const baseUrl = localOrigin(input.baseUrl), directory = join(config.evidenceRoot, input.namespace), ledgerPath = join(directory, 'merge-ledger.json')
  const operate = dependencies.dataOperation ?? dataOperation, fetcher = dependencies.fetch ?? fetch, precheck = dependencies.check ?? checkMerge
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink() || resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()) fail('DIRECTORY_INVALID')
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0]; if (!sid) fail('ACL_INVALID')
    await exec('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true })
  }
  let ledger
  try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!ledger && mode !== 'initialize') fail('LEDGER_MISSING')
  ledger ??= { namespace: input.namespace, baseUrl, sourceCommit: config.sourceCommit, status: 'new', sessionState: 'none',
    datasourceId: randomUUID(), resultName: `merge-${input.namespace}`, sources: ['A', 'B'].map(suffix => ({ processId: randomUUID(), coreId: randomUUID(),
      dataId: randomUUID(), docId: randomUUID(), uuid: randomUUID(), name: `merge-${input.namespace}-${suffix}` })), requests: [] }
  if (ledger.namespace !== input.namespace || ledger.baseUrl !== baseUrl || ledger.sourceCommit !== config.sourceCommit) fail('LEDGER_IDENTITY')
  if (!uuid(ledger.datasourceId)) fail('LEDGER_ISOLATION_MISSING')
  const assertEmpty = data => { if (data.businessRows !== 0 || data.snapshotCount !== 0 || data.adminDatasourceCount !== 0 || data.qualityReportCount !== 0) fail('RESOURCES_REMAIN') }
  const persist = async () => { const temp = ledgerPath + '.tmp'; await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 }); await rename(temp, ledgerPath) }
  await persist()
  if (mode === 'initialize') {
    if (ledger.status !== 'new' || ledger.sessionState !== 'none' || ledger.requests.length) fail('INITIALIZATION_ALREADY_USED')
    assertEmpty(await operate('verify', config, ledger))
    return { namespace: input.namespace, baseUrl, initialized: true }
  }
  const sessionPath = join(directory, 'merge-session.json')
  let session
  if (ledger.sessionState === 'active' || ledger.sessionState === 'logout-pending') session = JSON.parse(await readFile(sessionPath, 'utf8'))
  const request = async (origin, path, body) => {
    ledger.requests.push({ path, method: body === undefined ? 'GET' : 'POST' }); await persist()
    const response = await fetcher(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'X-Site': '101', ...(session ? { Authorization: session.accessToken, userId: String(session.userId), Cookie: `accessToken=${session.accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const raw = await response.text(); if (raw.length > 4_000_000) fail('RESPONSE_TOO_LARGE')
    let json; try { json = JSON.parse(raw, (key, value, context) => key === 'resultValue' && typeof value === 'number'
      ? context?.source ?? fail('EXACT_JSON_REQUIRED') : value) } catch { fail('RESPONSE_INVALID') }
    return { status: response.status, body: json }
  }
  const ok = r => r.status === 200 && ['200', '0'].includes(String(r.body.code))
  if (mode === 'verify-cleanup') {
    if (ledger.sessionState !== 'logged-out' || ledger.status !== 'cleaned') fail('CLEANUP_UNCONFIRMED')
    const data = await operate('verify', config, ledger)
    assertEmpty(data)
    if (ledger.userId) {
      session = JSON.parse(await readFile(sessionPath, 'utf8'))
      const current = await request(config.ssoOrigin, '/api/sso/user/info/current?productCode=hiq_editor')
      if (current.status !== 401 && String(current.body.code) !== '401') fail('SESSION_STILL_ACTIVE')
    }
    return { namespace: input.namespace, empty: true, dataCleaned: true, auditPolicy: 'retain-queue-provider-and-system-audit', auditIds: null, auditCount: null }
  }
  if (mode === 'cleanup') {
    if (ledger.sessionState === 'login-pending') fail('SESSION_UNKNOWN')
    if (ledger.userId) {
      const before = await operate('inspect', config, ledger)
      if (ledger.status === 'confirm-pending' && !before.resultId) fail('CONFIRM_OUTCOME_UNKNOWN')
      if (ledger.status === 'preview-pending' && !before.snapshotCount && !ledger.snapshotId) fail('PREVIEW_OUTCOME_UNKNOWN')
      ledger.resources = before.resources; ledger.resultId = before.resultId ?? ledger.resultId; await persist()
      await operate('cleanup', config, ledger)
      const after = await operate('verify', config, ledger); assertEmpty(after)
    }
    if (!ledger.userId) {
      const untouched = await operate('verify', config, ledger)
      assertEmpty(untouched)
    }
    if (session) {
      ledger.sessionState = 'logout-pending'; await persist()
      const out = await request(config.ssoOrigin, '/api/sso/auth/logout', {}); if (!ok(out) && out.status !== 401 && String(out.body.code) !== '401') fail('LOGOUT_FAILED')
      const current = await request(config.ssoOrigin, '/api/sso/user/info/current?productCode=hiq_editor')
      if (current.status !== 401 && String(current.body.code) !== '401') fail('SESSION_STILL_ACTIVE')
    }
    ledger.sessionState = 'logged-out'; ledger.status = 'cleaned'; await persist()
    return { namespace: input.namespace, dataCleaned: true, auditPolicy: 'retained' }
  }
  if (ledger.status === 'passed') return { namespace: input.namespace, baseUrl, actual: ledger.actual }
  if (ledger.status !== 'new') fail('RECOVERY_REQUIRES_CLEANUP')
  const preflight = await precheck(config); if (!preflight.ready) fail('PREFLIGHT_BLOCKED')
  const ready = await fetcher(baseUrl + '/ready', { redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!ready.ok || (await ready.json()).status !== 'UP') fail('CANDIDATE_NOT_READY')
  const account = JSON.parse(await readFile(config.accountsFile, 'utf8')).accounts?.[config.accountKey]; if (!account?.username || !account.password) fail('ACCOUNT_MISSING')
  ledger.sessionState = 'login-pending'; await persist()
  const login = await request(config.ssoOrigin, '/api/sso/auth/login', { username: account.username, password: account.password, grantType: 'PASSWORD' })
  if (!ok(login) || !login.body.data?.accessToken || !login.body.data?.userId) fail('LOGIN_FAILED')
  session = login.body.data; await writeFile(sessionPath, JSON.stringify(session), { mode: 0o600 }); ledger.userId = String(session.userId); ledger.sessionState = 'active'; await persist()
  ledger.status = 'provision-pending'; await persist()
  await operate('provision', config, ledger); ledger.status = 'provisioned'; await persist()
  const sourceProof = await operate('inspect', config, ledger)
  if (sourceProof.sourceResults.length !== 2 || sourceProof.sourceResults.some(r => exactDecimal(r[1]) !== '0.5' || r[2] !== config.kilogramUnitId || r[3] !== config.tonneUnitId)) fail('FIXTURE_READBACK_FAILED')
  ledger.sourceProof = sourceProof.sourceResults; ledger.resources = sourceProof.resources; await persist()
  const candidates = await request(baseUrl, '/dataset/allProcessLinkProduction', ledger.sources.map(s => s.processId))
  if (!ok(candidates)) fail('REFERENCE_CANDIDATES_FAILED')
  const choices = Object.values(candidates.body.data ?? {}).flat(); const reference = choices.find(c => c.declaredUnitId === config.tonneUnitId)
  if (!reference?.elementName) fail('REFERENCE_CANDIDATES_INVALID')
  ledger.status = 'preview-pending'; await persist()
  const preview = await request(baseUrl, '/dataset/merge-preview', { name: ledger.resultName, resultReferenceProductName: reference.elementName,
    resultReferenceProductUnitId: config.tonneUnitId, dataSet: ledger.sources.map(s => ({ id: s.processId, x: '0.500' })) })
  if (!ok(preview)) { ledger.status = 'preview-rejected'; await persist(); fail('PREVIEW_FAILED') }
  ledger.snapshotId = preview.body.data?.snapshotId; await persist()
  const body = confirmBody(preview.body.data)
  if (body.mergedItems.find(g => g.mergeType === 'REFERENCE_PRODUCT').result.unitId !== config.tonneUnitId) fail('RESULT_UNIT_MISMATCH')
  ledger.status = 'confirm-pending'; await persist()
  const confirmed = await request(baseUrl, '/dataset/do-merge', body)
  if (!ok(confirmed)) { ledger.status = 'confirm-rejected'; await persist(); fail('CONFIRM_FAILED') }
  if (!uuid(confirmed.body.data)) fail('CONFIRM_FAILED')
  ledger.resultId = confirmed.body.data; await persist()
  const proof = await operate('inspect', config, ledger); ledger.resources = proof.resources; await persist()
  ledger.referenceProof = proof.referenceResults; ledger.previewReferenceValue = preview.body.data.mergedItems.find(g => g.mergeType === 'REFERENCE_PRODUCT').result.resultValue; await persist()
  if (proof.referenceResults.length !== 1 || exactDecimal(proof.referenceResults[0][1]) !== '1' || proof.referenceResults[0][2] !== config.tonneUnitId || proof.referenceResults[0][3] !== config.tonneUnitId) fail('PERSISTED_RESULT_MISMATCH')
  ledger.actual = JSON.stringify({ sourceCount: sourceProof.sourceResults.length, sourceValue: exactDecimal(sourceProof.sourceResults[0][1]), sourceUnit: 'kg', declaredUnit: 't', weightSum: '1', resultValue: exactDecimal(proof.referenceResults[0][1]), resultUnit: 't', persisted: true })
  ledger.status = 'passed'; await persist()
  return { namespace: input.namespace, baseUrl, actual: ledger.actual }
}

export async function checkMerge(config) {
  validateMergeConfig(config)
  if (!['accountsFile', 'springConfigFile', 'evidenceRoot'].every(k => isAbsolute(config[k] ?? ''))
    || !/^https:\/\/editor[1-9]\.hiqdat\.dev$/.test(config.ssoOrigin ?? '') || config.accountKey !== 'editor_uat_admin') fail('RUNTIME_CONFIG_REQUIRED')
  for (const path of [config.accountsFile, config.springConfigFile, config.pythonExecutable, config.credentialsFile]) if (!(await lstat(path)).isFile()) fail('RUNTIME_FILE_INVALID')
  const result = await exec('git', ['show', `${config.sourceCommit}:src/main/java/com/ecdigit/ecdata/controller/DatasetMergeCommonController.java`], {
    cwd: config.sourceRepository, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
  if (!isAbsolute(config.kubeconfig ?? '')) fail('KUBECONFIG_REQUIRED')
  const { stdout } = await exec('kubectl', ['--kubeconfig', config.kubeconfig, '-n', 'hiqlcd-app-uat2', 'get', 'pods', '-l', 'app=lca-search', '-o', 'json'], { windowsHide: true, timeout: 15000 })
  const pods = JSON.parse(stdout).items
  const images = pods.flatMap(p => p.status?.containerStatuses ?? []).map(c => c.imageID?.split('@')[1])
  const database = await databaseProbe(config); database.consumerImage = images.length && images.every(i => i === reviewedConsumer) ? reviewedConsumer : null
  const routeResult = await exec('kubectl', ['--kubeconfig', config.kubeconfig, 'get', '--raw', '/api/v1/namespaces/db/services/pg-kafka:8000/proxy/api/configs/process_editor/tables/tw_processes'], { windowsHide: true, timeout: 15000 })
  const route = JSON.parse(routeResult.stdout).table
  const middleware = await exec('kubectl', ['--kubeconfig', config.kubeconfig, '-n', 'db', 'get', 'pods', '-l', 'app=pg-kafka', '-o', 'json'], { windowsHide: true, timeout: 15000 })
  const middlewareImages = JSON.parse(middleware.stdout).items.flatMap(p => p.status?.containerStatuses ?? []).map(c => c.imageID?.split('@')[1])
  database.consumerRouteVerified = middlewareImages.length > 0 && middlewareImages.every(i => i === 'sha256:9eca9bfe0b03b4166ced27ef4a0463a380265bf79d41b8d1fd2ffebd6e38e07a')
    && route?.channel === 'editor_tw_processes_table_changes' && route.kafkaTopic === 'processes-editor-updates-dev'
    && route.serviceUrl === 'http:/lca-search.hiqlcd-app-uat2.svc.cluster.local:8080/api/update-process-embedding'
    && JSON.stringify(route.operations) === '["INSERT","UPDATE"]'
  return assessMergePreflight(config, database, result.stdout)
}

async function main() {
  const [mode, flag, configPath, ...extra] = process.argv.slice(2)
  if (!['--check', 'initialize', 'execute', 'api', 'cleanup', 'verify-cleanup'].includes(mode) || flag !== '--config' || !isAbsolute(configPath ?? '') || extra.length) fail('CLI_INVALID')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  let input = ''; if (mode !== '--check') for await (const chunk of process.stdin) { input += chunk; if (input.length > 64000) fail('INPUT_TOO_LARGE') }
  const report = mode === '--check' ? await checkMerge(config) : await executeMerge(mode, config, JSON.parse(input))
  process.stdout.write(JSON.stringify(report) + '\n')
  if (mode === '--check' && !report.ready) process.exitCode = 2
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  process.stderr.write((typeof error.code === 'string' && error.code.startsWith('MERGE_ACCEPTANCE_') ? error.code : 'MERGE_ACCEPTANCE_FAILED') + '\n')
  process.exitCode = 1
})
