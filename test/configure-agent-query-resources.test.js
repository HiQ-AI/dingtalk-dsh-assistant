import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {planAgentQueryResources,configureAgentQueryResources} from '../scripts/configure-agent-query-resources.mjs'
const hash=s=>createHash('sha256').update(s).digest('hex')
const source="- id: dingtalk-dsh-assistant\n  name: '@zzusp/dingtalk-dsh-assistant/resident'\n  config:\n    storage: !!js dshHomePath('state')\n    workflow:\n      ownerActorId: owner\n      groupIds: [test-group]\n      repositories: []\n"
const proposal=()=>({expectedProfileSha256:hash(source),target:'dingtalk-dsh-assistant.config.workflow.directQueries',directQueries:{resources:[{id:'files',kind:'files',root:resolve('docs'),paths:['spec/agent-direct-question-answering.md']}],databases:[],statusResources:[{id:'health',url:'http://127.0.0.1:18998/health',fields:['status']}],permissions:{resourceIds:['files'],databaseIds:[],statusIds:['health']}}})
test('查询配置只变目标字段，保留原文tag，重复计划幂等',async()=>{const p=proposal(),a=await planAgentQueryResources(source,p);assert.ok(a.changed);assert.ok(a.updated.includes("storage: !!js dshHomePath('state')"));assert.equal((await planAgentQueryResources(a.updated,p)).changed,false)})
test('旧成员授权/未知字段/未登记资源/数据库/非法资源均拒绝',async()=>{for(const mutate of [p=>p.directQueries.grants=[],p=>p.directQueries.permissions.actorId='other',p=>p.directQueries.permissions.resourceIds=['unknown'],p=>p.directQueries.databases.push({id:'db'}),p=>p.directQueries.resources[0].paths=['../secret'],p=>p.directQueries.statusResources[0].url='http://example.com']){const p=proposal();mutate(p);await assert.rejects(planAgentQueryResources(source,p),/QUERY_CONFIG_/)}await assert.rejects(planAgentQueryResources('bad: !!unknown secret',proposal()),/QUERY_CONFIG_PROFILE_YAML_INVALID/)})
test('check零写，apply备份回读，旧SHA与锁拒绝',async()=>{const dir=await mkdtemp(join(tmpdir(),'query-config-test-')),profile=join(dir,'patch.yml'),file=join(dir,'proposal.json');await writeFile(profile,source);await writeFile(file,JSON.stringify(proposal()));const args={profile,proposal:file,expectedSha256:hash(source)};assert.equal((await configureAgentQueryResources({...args,mode:'check'})).writes,0);assert.deepEqual((await readdir(dir)).sort(),['patch.yml','proposal.json']);await writeFile(profile+'.agent-queries.lock','occupied');await assert.rejects(configureAgentQueryResources({...args,mode:'apply'}),/PROFILE_LOCKED/);const {unlink}=await import('node:fs/promises');await unlink(profile+'.agent-queries.lock');const result=await configureAgentQueryResources({...args,mode:'apply'});assert.equal(await readFile(result.backupPath,'utf8'),source);assert.equal(hash(await readFile(profile,'utf8')),result.afterSha256);await assert.rejects(configureAgentQueryResources({...args,mode:'apply'}),/PROFILE_CHANGED/)})

const databaseProposal = () => {
  const p = proposal()
  p.directQueries.databases = [{ id: 'uat-readonly', connectionId: 'approved-readonly', tables: [{ schema: 'public', table: 'tw_process_drafts', columns: ['id','snapshot_version','is_deleted'] }] }]
  p.directQueries.credentialsPath = resolve('docs/tmp/does-not-exist-readonly-credentials.json')
  p.directQueries.permissions.databaseIds = ['uat-readonly']
  return p
}
test('显式数据库及表列按Agent授权登记，不读凭据也不连接；支持数据库独立提案', async () => {
  const p = databaseProposal()
  p.directQueries.resources = []; p.directQueries.statusResources = []
  p.directQueries.permissions.resourceIds = []; p.directQueries.permissions.statusIds = []
  const a = await planAgentQueryResources(source, p)
  assert.ok(a.changed); assert.ok(a.updated.includes('approved-readonly')); assert.ok(a.updated.includes('credentialsPath:'))
  assert.ok(a.updated.includes("storage: !!js dshHomePath('state')"))
  assert.equal((await planAgentQueryResources(a.updated, p)).changed, false)
})
test('现有UAT账号须显式声明受信只读事务模式，生产环境不能声明', async () => {
  const p = databaseProposal()
  p.directQueries.databases[0] = { ...p.directQueries.databases[0], environment: 'uat', identityPolicy: 'host-enforced-readonly' }
  const planned = await planAgentQueryResources(source, p)
  assert.ok(planned.updated.includes('identityPolicy: host-enforced-readonly'))
  assert.equal((await planAgentQueryResources(planned.updated, p)).changed, false)
  p.directQueries.databases[0].environment = 'production'
  await assert.rejects(planAgentQueryResources(source, p), /QUERY_CONFIG_DATABASE_INVALID/)
})
test('数据库拒绝缺凭据路径、隐式凭据、宽泛表列、重复资源及扩大授权', async () => {
  for (const mutate of [p=>delete p.directQueries.credentialsPath, p=>p.directQueries.credentialsPath='relative.json',
    p=>p.directQueries.password='must-not-appear', p=>p.directQueries.databases[0].password='must-not-appear',
    p=>p.directQueries.databases[0].tables[0].columns=['*'], p=>p.directQueries.databases[0].tables[0].columns=['id','id'],
    p=>p.directQueries.databases[0].tables.push(p.directQueries.databases[0].tables[0]),
    p=>p.directQueries.databases.push(p.directQueries.databases[0]), p=>p.directQueries.databases[0].tables=[],
    p=>p.directQueries.permissions.databaseIds=['other'], p=>p.directQueries.permissions.actorId='participant',
    p=>p.directQueries.permissions.conversationId='other']) {
    const p=databaseProposal(); mutate(p); await assert.rejects(planAgentQueryResources(source,p), /QUERY_CONFIG_/)
  }
})
test('数据库check零写原文不变，apply仅隔离profile CAS且备份回读，不输出凭据路径', async () => {
  const dir=await mkdtemp(join(tmpdir(),'query-config-db-test-')), profile=join(dir,'patch.yml'), file=join(dir,'proposal.json'), p=databaseProposal()
  await writeFile(profile,source); await writeFile(file,JSON.stringify(p))
  const args={profile,proposal:file,expectedSha256:hash(source)}
  const check=await configureAgentQueryResources({...args,mode:'check'})
  assert.equal(check.writes,0); assert.equal(await readFile(profile,'utf8'),source)
  assert.deepEqual((await readdir(dir)).sort(),['patch.yml','proposal.json'])
  assert.ok(!JSON.stringify(check).includes(p.directQueries.credentialsPath))
  const result=await configureAgentQueryResources({...args,mode:'apply'})
  assert.equal(await readFile(result.backupPath,'utf8'),source)
  assert.equal(hash(await readFile(profile,'utf8')),result.afterSha256)
  await assert.rejects(configureAgentQueryResources({...args,mode:'apply'}),/PROFILE_CHANGED/)
})

test('生产元数据schema授权提案保留数据表范围，非法schema拒绝',async()=>{
 const p=databaseProposal();const db=p.directQueries.databases[0];db.environment='production';db.metadataSchemas=['public'];
 const result=await planAgentQueryResources(source,p);assert.equal(result.changed,true);
 assert.deepEqual(p.directQueries.databases[0].tables,databaseProposal().directQueries.databases[0].tables);
 db.metadataSchemas=['public;DROP'];await assert.rejects(planAgentQueryResources(source,p),/QUERY_CONFIG_RESOURCE_INVALID/);
});
