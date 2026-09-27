import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { assessMergePreflight, validateMergeConfig, confirmBody, executeMerge, exactDecimal } from '../scripts/local-acceptance-merge.mjs'

test('十进制比较保留末位，拒绝浮点舍入伪通过', () => {
 for(const value of ['1','1.0','100e-2','+01.000'])assert.equal(exactDecimal(value),'1')
 for(const value of ['1.0000000000000001','0.99999999999999999'])assert.notEqual(exactDecimal(value),'1')
 for(const value of ['NaN','Infinity','1e9999','',null])assert.throws(()=>exactDecimal(value),/DECIMAL_INVALID/)
})

test('实际Python归属门禁拒绝共享doc及跨租户/创建人/父行的child，删除前阻断', () => {
  const source = readFileSync(new URL('../scripts/local-acceptance-merge.mjs', import.meta.url), 'utf8')
  const code = source.match(/const dataProgram = String.raw`([\s\S]*?)`/)?.[1]
  const probe = String.raw`
import ast,json,sys,copy
tree=ast.parse(sys.stdin.buffer.read().decode('utf-8'))
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='validate_resource_ownership')
exec(compile(ast.Module(body=[fn],type_ignores=[]),'ownership','exec'))
base={t:[dict(id=t,tenant_id='t',create_id='u')] for t in ['tw_processes','tw_process_core','tw_process_data','tw_process_doc','tb_activities']}
base['tw_process_core'][0].update(process_id='p',process='uuid')
base['tw_process_data'][0].update(process='p',core='tw_process_core')
base['tb_activities'][0].update(activity_id='uuid')
class Cursor:
 def __init__(self,rows,shared): self.rows=rows;self.shared=shared;self.deletes=0
 def execute(self,sql,args):
  assert not sql.lower().startswith('delete')
  self.sql=sql
 def fetchall(self): return [(r,) for r in self.rows[self.sql.split(' from ')[1].split()[0]]]
 def fetchone(self): return (int(self.shared and 'process_doc_id' in self.sql),)
cases=[(None,None,None,True),('tw_process_data','tenant_id','other',False),('tw_process_doc','create_id','other',False),('tw_process_core','process_id','outside',False),('tw_process_data','core','outside',False),('tb_activities','activity_id','outside',False)]
for table,key,value,shared in cases:
 rows=copy.deepcopy(base)
 if table: rows[table][0][key]=value
 q=Cursor(rows,shared)
 try: validate_resource_ownership(q,{t:[t] for t in rows},['p'],['uuid'],'t','u')
 except AssertionError: pass
 else: raise AssertionError('unsafe resource accepted')
 assert q.deletes==0
validate_resource_ownership(Cursor(base,False),{t:[t] for t in base},['p'],['uuid'],'t','u')
print('ownership cases passed')
`
  const result = spawnSync('python', ['-c', probe], { input: code, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ownership cases passed/)
  assert.ok(code.indexOf('  validate_resource_ownership(q,') < code.indexOf("  if mode=='cleanup':"))
})

const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const kg = '33333333-3333-4333-8333-333333333333'
const tonne = '44444444-4444-4444-8444-444444444444'
const config = { uatEnvironment: 'uat3', databaseAlias: 'hiq_editor_uat', expectedDatabase: 'hiq_editor',
  credentialsFile: process.cwd() + '/private.json', pythonExecutable: process.execPath, sourceRepository: process.cwd(),
  sourceCommit: 'a'.repeat(40), expectedTenantId: 'tenant', referenceIds: [first, second], kilogramUnitId: kg, tonneUnitId: tonne }
const database = () => ({ database: 'hiq_editor', readOnly: true, consumerRouteVerified: true, foreignKeys: [], triggers: [{ definitionSha256: 'fb925227a39750e0541737e945276fa0799a5e3c4f5fd953f357668c0dd63d80' }], consumerImage: 'sha256:d154c2b3b41cce0848fdf55dc51afb885bf0565255bfd4b66b0786acd11cf530',
  references: [first, second].map((id, index) => ({ id, processId: String(index), value: '0.5', unitId: kg,
    declaredUnitId: tonne, referenceProduct: true, tenantId: 'tenant', dataAttribution: 'shared', coreCount: 1, referenceCount: 1 })),
  units: [{ id: kg, groupId: 'mass', factor: '1' }, { id: tonne, groupId: 'mass', factor: '1000' }] })
const controller = '/merge-preview confirmationService.confirm(dto)'

test('合并预检拒绝非UAT3、任意DB别名及重复来源', () => {
  for (const change of [{ uatEnvironment: 'uat2' }, { databaseAlias: 'production' }, { referenceIds: [first, first] }, { sourceCommit: 'HEAD' }]) {
    assert.throws(() => validateMergeConfig({ ...config, ...change }), /CONFIG_INVALID/)
  }
})
test('模板与受信消费者证明满足条件时预检可执行，仍不宣称清理完成', () => {
  const result = assessMergePreflight(config, database(), controller)
  assert.deepEqual(result.blockers, [])
  assert.equal(result.ready, true)
  assert.equal(result.cleanupContract.dataCleaned, false)
  assert.equal(result.cleanupContract.auditLogs, 'retained')
})
test('旧入口、数据库身份和触发器独立阻塞', () => {
  const db = database()
  db.database = 'other'; db.readOnly = false
  db.triggers.push({ name: 'notify', emitsNotification: true })
  db.foreignKeys.push(['child', 'tw_processes', 'fk', '...'])
  const result = assessMergePreflight(config, db, 'service.mergeDataset2(dto)')
  for (const code of ['DATABASE_IDENTITY_UNCONFIRMED', 'CANDIDATE_PREVIEW_ENTRY_MISSING', 'SIDE_EFFECT_TRIGGER_UNRESOLVED', 'FOREIGN_KEY_CLEANUP_UNRESOLVED']) assert.ok(result.blockers.includes(code))
})
test('跨tenant、多工序、无参考值及单位倍率错误不得当PASS', () => {
  for (const mutate of [db => { db.references[0].value = '0' }, db => { db.references[0].tenantId = 'other' },
    db => { db.references[0].coreCount = 2 }, db => { db.references[0].referenceProduct = false }]) {
    const db = database(); mutate(db)
    assert.ok(assessMergePreflight(config, db, controller).blockers.includes('DEDICATED_FIXTURE_REQUIRED'))
  }
  const db = database(); db.units[1].factor = '1'
  assert.ok(assessMergePreflight(config, db, controller).blockers.includes('UNIT_CONVERSION_UNCONFIRMED'))
})
test('真实preview为1t才构造确认请求，拒绝0.001和来源缺失', () => {
  const preview = { snapshotId: first, mergedItems: [{ id: 'g', mergeType: 'REFERENCE_PRODUCT', sources: [{ sourceItemId: first }, { sourceItemId: second }], result: { resultValue: '1', unitId: tonne } }], unmergedItems: [] }
  assert.equal(confirmBody(preview).mergedItems[0].result.value, '1')
  preview.mergedItems[0].result.resultValue = '0.001'
  assert.throws(() => confirmBody(preview), /NORMALIZATION_MISMATCH/)
  preview.mergedItems[0].result.resultValue = '1'; preview.mergedItems[0].sources.pop()
  assert.throws(() => confirmBody(preview), /NORMALIZATION_MISMATCH/)
})
test('已审阅消费者镜像发生变化时阻塞写场景', () => {
  const db = database(); db.consumerImage = 'sha256:changed'
  assert.ok(assessMergePreflight(config, db, controller).blockers.includes('SIDE_EFFECT_TRIGGER_UNRESOLVED'))
})
test('固定Python数据库程序可编译且不含审计删除或触发器关闭', () => {
  const source = readFileSync(new URL('../scripts/local-acceptance-merge.mjs', import.meta.url), 'utf8')
  for (const name of ['probeProgram', 'dataProgram']) {
    const code = source.match(new RegExp(`const ${name} = String.raw\x60([\\s\\S]*?)\x60`))?.[1]
    assert.ok(code)
    const result = spawnSync('python', ['-c', 'import sys;compile(sys.stdin.buffer.read().decode("utf-8"),"merge-program","exec")'], { input: code, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(code, /disable\s+trigger|session_replication_role|delete from te_system_log/i)
  }
})

async function harness(t, failure) {
  const root = await mkdtemp(join(tmpdir(), 'merge-acceptance-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const accountsFile = join(root, 'accounts.json')
  await writeFile(accountsFile, JSON.stringify({ accounts: { editor_uat_admin: { username: 'fixture', password: 'fixture' } } }))
  const runtime = { ...config, accountsFile, springConfigFile: join(root, 'spring.yml'), evidenceRoot: root, accountKey: 'editor_uat_admin', ssoOrigin: 'https://editor2.hiqdat.dev' }
  const input = { namespace: 'acceptance-' + 'a'.repeat(32), uatEnvironment: 'uat3', baseUrl: 'http://127.0.0.1:12345' }
  const calls = []
  const preview = { snapshotId: first, mergedItems: [{ id: 'g', mergeType: 'REFERENCE_PRODUCT', sources: [{ sourceItemId: first }, { sourceItemId: second }], result: { resultValue: '1', unitId: tonne } }], unmergedItems: [] }
  const dependencies = { check: async () => ({ ready: failure !== 'preflight' }),
    dataOperation: async mode => { calls.push(mode); return { resultId: null, resources: {}, businessRows: 0, snapshotCount: 0, adminDatasourceCount: 0, qualityReportCount: 0,
      sourceResults: [[first, '0.5', kg, tonne], [second, '0.5', kg, tonne]] } },
    fetch: async url => {
      if (url.endsWith('/ready')) return new Response(JSON.stringify({ status: failure === 'ready' ? 'DOWN' : 'UP' }))
      if (url.includes('/info/current')) return new Response(JSON.stringify({ code: 401 }), { status: 401 })
      if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ code: 200, data: { accessToken: 'fixture-token', userId: 'fixture-user' } }))
      if (url.endsWith('/auth/logout')) return new Response(JSON.stringify({ code: 200 }))
      if (url.endsWith('/allProcessLinkProduction')) return new Response(JSON.stringify({ code: 200, data: { a: [{ declaredUnitId: tonne, elementName: 'fixture-product' }] } }))
      if (url.endsWith('/merge-preview')) {
        if (failure === 'timeout') throw new Error('fixture-timeout')
        return new Response(JSON.stringify(failure === 'preview' ? { code: 500 } : { code: 200, data: preview }))
      }
      if (url.endsWith('/do-merge')) return new Response(JSON.stringify({ code: 500 }))
      throw new Error('unexpected-route')
    } }
  const ledger = async () => JSON.parse(await readFile(join(root, input.namespace, 'merge-ledger.json'), 'utf8'))
  return { runtime, input, dependencies, calls, ledger }
}
for (const failure of ['preflight', 'ready', 'preview', 'confirm']) test(`${failure}明确失败仍可清理与独立查零`, async t => {
  const h = await harness(t, failure)
  await executeMerge('initialize', h.runtime, h.input, h.dependencies)
  await assert.rejects(executeMerge('api', h.runtime, h.input, h.dependencies))
  assert.ok(await h.ledger())
  await executeMerge('cleanup', h.runtime, h.input, h.dependencies)
  assert.equal((await executeMerge('verify-cleanup', h.runtime, h.input, h.dependencies)).dataCleaned, true)
  if (failure === 'preflight' || failure === 'ready') assert.deepEqual(h.calls, ['verify', 'verify', 'verify'])
})
test('网络超时保持未知，不因未发现snapshot就声称清理完成', async t => {
  const h = await harness(t, 'timeout')
  await executeMerge('initialize', h.runtime, h.input, h.dependencies)
  await assert.rejects(executeMerge('api', h.runtime, h.input, h.dependencies))
  assert.equal((await h.ledger()).status, 'preview-pending')
  await assert.rejects(executeMerge('cleanup', h.runtime, h.input, h.dependencies), /PREVIEW_OUTCOME_UNKNOWN/)
})


test('prepare前初始化持久空账，构建失败仍独立回读清理且不伪称read-only', async t => {
  const h = await harness(t, 'preflight')
  const initialized = await executeMerge('initialize', h.runtime, h.input, h.dependencies)
  assert.equal(initialized.initialized, true)
  const before = await h.ledger()
  assert.equal(before.baseUrl, h.input.baseUrl); assert.equal(before.status, 'new')
  assert.equal(before.sources.length, 2); assert.match(before.datasourceId, /^[a-f0-9-]{36}$/); assert.deepEqual(h.calls, ['verify'])
  await executeMerge('initialize', h.runtime, h.input, h.dependencies)
  assert.deepEqual((await h.ledger()).sources, before.sources)
  await executeMerge('cleanup', h.runtime, h.input, h.dependencies)
  const receipt = await executeMerge('verify-cleanup', h.runtime, h.input, h.dependencies)
  assert.equal(receipt.empty, true); assert.equal(receipt.namespace, h.input.namespace)
  assert.equal(receipt.mode, undefined); assert.equal(receipt.createdResources, undefined)
  assert.deepEqual(h.calls, ['verify', 'verify', 'verify', 'verify'])
})

test('缺账与跨namespace端口不自动补账，不把回读失败作为清理成功', async t => {
  const h = await harness(t)
  for (const mode of ['api', 'cleanup', 'verify-cleanup']) await assert.rejects(executeMerge(mode, h.runtime, h.input, h.dependencies), /LEDGER_MISSING/)
  await executeMerge('initialize', h.runtime, h.input, h.dependencies)
  await assert.rejects(executeMerge('initialize', h.runtime, { ...h.input, baseUrl: 'http://127.0.0.1:12346' }, h.dependencies), /LEDGER_IDENTITY/)
  await executeMerge('cleanup', h.runtime, h.input, h.dependencies)
  await assert.rejects(executeMerge('verify-cleanup', h.runtime, h.input, { ...h.dependencies, dataOperation: async () => ({ businessRows: 1, snapshotCount: 0 }) }), /RESOURCES_REMAIN/)
  await assert.rejects(executeMerge('verify-cleanup', h.runtime, h.input, { ...h.dependencies, dataOperation: async () => { throw Error('readonly-unavailable') } }), /readonly-unavailable/)
})


test('专属datasource预登记与管理员库/质量报告回读缺失或非零均阻断', async t => {
  for (const change of [{ adminDatasourceCount: 1 }, { qualityReportCount: 1 }, { adminDatasourceCount: undefined }]) {
    const h = await harness(t)
    await assert.rejects(executeMerge('initialize', h.runtime, h.input, { ...h.dependencies,
      dataOperation: async () => ({ businessRows: 0, snapshotCount: 0, adminDatasourceCount: 0, qualityReportCount: 0, ...change }) }), /RESOURCES_REMAIN/)
    assert.match((await h.ledger()).datasourceId, /^[a-f0-9-]{36}$/)
  }
  const source = readFileSync(new URL('../scripts/local-acceptance-merge.mjs', import.meta.url), 'utf8')
  assert.match(source, /pr.update\(data_attribution=datasource/)
  assert.match(source, /current\['data_attribution'\]==datasource/)
  assert.match(source, /rr\[6\]==datasource/)
  assert.match(source, /public.ts_datasource_info where id=%s/)
  assert.match(source, /public.te_data_quality_report where data_attribution=%s/)
  assert.doesNotMatch(source, /insert into (?:public\.)?ts_datasource_info|delete from (?:public\.)?te_data_quality_report/i)
})

test('模拟业务成功后通用runner清理回执不再误报read-only', async t => {
  const h = await harness(t)
  const deps = { ...h.dependencies,
    dataOperation: async mode => ({ ...(await h.dependencies.dataOperation(mode)), referenceResults: [[first, '1.0000', tonne, tonne]] }),
    fetch: async url => url.endsWith('/do-merge') ? new Response(JSON.stringify({ code: 200, data: second })) : h.dependencies.fetch(url) }
  await executeMerge('initialize', h.runtime, h.input, deps)
  const result = await executeMerge('api', h.runtime, h.input, deps)
  assert.equal(JSON.parse(result.actual).persisted, true)
  assert.equal(JSON.parse(result.actual).resultValue, '1')
  assert.equal((await h.ledger()).referenceProof[0][1], '1.0000')
  assert.equal((await h.ledger()).status, 'passed')
  await executeMerge('cleanup', h.runtime, h.input, deps)
  const receipt = await executeMerge('verify-cleanup', h.runtime, h.input, deps)
  assert.equal(receipt.namespace, h.input.namespace); assert.equal(receipt.empty, true)
  assert.equal(receipt.mode, undefined); assert.equal(receipt.createdResources, undefined)
})
for(const raw of ['1.0000000000000001','0.99999999999999999'])test(`持久结果${raw}不能冒充精确1t`,async t=>{
 const h=await harness(t)
 const deps={...h.dependencies,dataOperation:async mode=>({...await h.dependencies.dataOperation(mode),referenceResults:[[first,raw,tonne,tonne]]}),
 fetch:async url=>url.endsWith('/do-merge')?new Response(JSON.stringify({code:200,data:second})):h.dependencies.fetch(url)}
 await executeMerge('initialize',h.runtime,h.input,deps)
 await assert.rejects(executeMerge('api',h.runtime,h.input,deps),/PERSISTED_RESULT_MISMATCH/)
 assert.equal((await h.ledger()).referenceProof[0][1],raw)
})
test('预览JSON数值词元保留精度，不先舍入为Number',async t=>{
 const h=await harness(t)
 const deps={...h.dependencies,fetch:async url=>url.endsWith('/merge-preview')?new Response(`{"code":200,"data":{"snapshotId":"${first}","mergedItems":[{"mergeType":"REFERENCE_PRODUCT","sources":[{"sourceItemId":"${first}"},{"sourceItemId":"${second}"}],"result":{"resultValue":1.0000000000000001,"unitId":"${tonne}"}}],"unmergedItems":[]}}`):h.dependencies.fetch(url)}
 await executeMerge('initialize',h.runtime,h.input,deps)
 await assert.rejects(executeMerge('api',h.runtime,h.input,deps),/NORMALIZATION_MISMATCH/)
})
