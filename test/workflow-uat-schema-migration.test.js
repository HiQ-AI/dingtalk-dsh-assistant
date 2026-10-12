import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createUatSchemaMigrationTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-uat-schema-migration.js'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { planReleaseTargetAppend, configureReleaseTargetAppend } from '../scripts/configure-release-targets.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client as PgClient } from '../packages/dingtalk-dsh-assistant/node_modules/pg/esm/index.mjs'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createUatSchemaMigrationHost } from '../packages/dingtalk-dsh-assistant/workflow-uat-schema-host.js'
import { sg22SchemaScope, validateUatSchemaTarget, validateUatSchemaSql, createUatSchemaMigrationPlatform } from '../packages/dingtalk-dsh-assistant/workflow-uat-schema-migration.js'
const sql = await readFile(new URL('./fixtures/sg22-activity-merge-result.sql', import.meta.url),'utf8')
const target = { id: 'sg22-activity-merge-schema-uat3', ...sg22SchemaScope }
const migrationKey = executionDigest(target)
const local = { host: '127.0.0.1', port: Number(process.env.UAT_SCHEMA_TEST_PORT ?? 54393), user: 'postgres', database: 'hiq_editor' }
const connection = { host: target.host, port: target.port, database: target.database }
class IsolatedClient extends PgClient { constructor() { super(local) } }
await test('approved target and SQL only; production and modified SQL reject before connect', async () => {
  for (const change of [{environment:'production'},{host:'101.89.215.147'},{database:'postgres'},{taskId:'other-task'},{candidateSha:'a'.repeat(40)},{tables:['existing_uat2_business']}]) assert.throws(()=>validateUatSchemaTarget({...target,...change}), /UAT_SCHEMA_TARGET_NOT_ALLOWED/)
  assert.throws(()=>validateUatSchemaSql(sql+'DROP TABLE existing_uat2_business;'), /UAT_SCHEMA_SQL_NOT_APPROVED/)
  assert.equal(validateUatSchemaSql(sql),sql)
})
if (process.env.UAT_SCHEMA_TEST_PORT) {
const admin = new PgClient({ ...local, database: 'postgres' }); await admin.connect()
const actualDirectory=(await admin.query("SELECT current_setting('data_directory') AS directory")).rows[0].directory
const expectedDirectory=fileURLToPath(new URL('../docs/tmp/remaining-node-integration/sg18-sg22-uat-release/schema-migration-pg',import.meta.url))
assert.equal(resolve(actualDirectory).toLowerCase(),resolve(expectedDirectory).toLowerCase(),'Integration requires the task-owned synthetic PG cluster; no DDL before this guard')
if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='hiq_editor'")).rowCount) await admin.query('CREATE DATABASE hiq_editor')
await admin.end()
const db = new PgClient(local); await db.connect()
await db.query('CREATE TABLE IF NOT EXISTS existing_uat2_business(id integer PRIMARY KEY,value text)')
await db.query("INSERT INTO existing_uat2_business VALUES(1,'unchanged') ON CONFLICT DO NOTHING")
async function clear() { for (const name of [...target.tables].reverse()) await db.query(`DROP TABLE IF EXISTS public.${name} CASCADE`) }
const host = Client => createUatSchemaMigrationHost({ connection, Client: Client ?? IsolatedClient })
await test('real PG concurrent migration executes once; native retry uses same durable marker; UAT2 sentinel unchanged', async () => {
  await clear(); const p=host(); assert.equal((await p.reconcile({target,migrationKey})).status,'unseen')
  const [one,two]=await Promise.all([p.apply({target,migrationKey,sql}),p.apply({target,migrationKey,sql})])
  assert.equal(one.status,'succeeded');assert.equal(two.schemaDigest,one.schemaDigest)
  assert.equal((await p.reconcile({target,migrationKey})).schemaDigest,one.schemaDigest)
  assert.deepEqual((await db.query('SELECT * FROM existing_uat2_business')).rows,[{id:1,value:'unchanged'}])
})
await test('real PG error after DDL before COMMIT rolls back all3; clean retry succeeds', async () => {
  await clear()
  class FailBeforeCommit extends IsolatedClient { async query(q,...args) { if(typeof q==='string'&&q.startsWith('COMMENT ON TABLE public.te_activity_merge_submission')) throw Error('injected transport failure'); return super.query(q,...args) } }
  await assert.rejects(host(FailBeforeCommit).apply({target,migrationKey,sql}),/UAT_SCHEMA_TRANSACTION_FAILED/)
  assert.equal((await host().reconcile({target,migrationKey})).status,'unseen')
  assert.equal((await host().apply({target,migrationKey,sql})).status,'succeeded')
})
await test('real COMMIT with lost response reconciles successful without another DDL', async () => {
  await clear(); let ddl=0
  class LostCommit extends IsolatedClient { async query(q,...args) { if(q===sql)ddl++; const result=await super.query(q,...args); if(q==='COMMIT')throw Error('lost COMMIT acknowledgement'); return result } }
  const p=host(LostCommit); await assert.rejects(p.apply({target,migrationKey,sql}),/UAT_SCHEMA_COMMIT_UNCONFIRMED/)
  assert.equal((await p.reconcile({target,migrationKey})).status,'succeeded'); assert.equal(ddl,1)
  assert.equal((await p.apply({target,migrationKey,sql})).status,'succeeded');assert.equal(ddl,1)
})
await test('preexisting partial or unmarked tables fail closed; schema drift cannot reuse receipt', async () => {
  await clear();await db.query('CREATE TABLE te_activity_merge_candidate(id integer)')
  await assert.rejects(host().apply({target,migrationKey,sql}),/UAT_SCHEMA_TRANSACTION_FAILED/)
  assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_class WHERE relname=ANY($1)",[target.tables])).rows[0].count,1)
  await clear();await host().apply({target,migrationKey,sql});await db.query('ALTER TABLE te_activity_merge_candidate ADD COLUMN unrelated text')
  const changed=await host().reconcile({target,migrationKey});assert.equal(changed.status,'unmarked')
  for(const name of target.tables) await db.query(`COMMENT ON TABLE public.${name} IS 'dsh-uat-schema-v1:${migrationKey}:${changed.schemaDigest}'`)
  assert.equal((await host().reconcile({target,migrationKey})).status,'unmarked','A self-declared marker cannot bless a schema different from approved SQL')
})
await test('platform requires exact current accepted task/candidate/merged source and emits native operation key', async () => {
  await clear()
  const github={readPullRequest:async()=>({merged:true,headCommitSha:target.candidateSha,mergeCommitSha:target.candidateSha,baseBranch:target.branch,baseRepository:target.repository,headRepository:target.repository,evidenceRef:'github:pr382'}),readBranch:async()=>({commitSha:target.candidateSha,evidenceRef:'github:uat3'}),readVersionedFile:async()=>({content:sql,evidenceRef:'github:versioned-sql'})}
  const p=createUatSchemaMigrationPlatform({targets:[target],postgres:host(),github,readAcceptedSource:async()=>({candidateSha:target.candidateSha,evidenceRef:'native:candidate'})})
  const requirement={taskId:target.taskId,targetId:target.id,candidateSha:target.candidateSha,request:'Apply approved SG22 schema'}
  assert.equal((await p.adapter.inspect({phase:'preflight',requirement})).status,'confirmed')
  const prepared=await p.adapter.prepareOperation({requirement,runId:'native-run',generation:1,requirementDigest:executionDigest(requirement)})
  assert.equal(prepared.workflowKind,'uat-schema-migration');const receipt=await p.operationAdapter.execute(prepared)
  assert.equal(receipt.status,'succeeded');assert.equal((await p.adapter.inspect({phase:'migrated',prepared,receipt})).status,'succeeded')
  await assert.rejects(p.operationAdapter.execute({...prepared,expected:{...prepared.expected,taskId:'other'}}),/UAT_SCHEMA_OPERATION_INVALID/)
  github.readBranch=async()=>({commitSha:'a'.repeat(40),evidenceRef:'github:other'});await assert.rejects(p.adapter.inspect({phase:'preflight',requirement}),/UAT_SCHEMA_SOURCE_UNCONFIRMED/)
})
await test('actual native Store persists one schema external effect and real PG proof', async t => {
  await clear()
  const github={readPullRequest:async()=>({merged:true,headCommitSha:target.candidateSha,mergeCommitSha:target.candidateSha,baseBranch:target.branch,baseRepository:target.repository,headRepository:target.repository,evidenceRef:'github:pr382'}),readBranch:async()=>({commitSha:target.candidateSha,evidenceRef:'github:uat3'}),readVersionedFile:async()=>({content:sql,evidenceRef:'github:sql'})}
  const p=createUatSchemaMigrationPlatform({targets:[target],postgres:host(),github,readAcceptedSource:async()=>({candidateSha:target.candidateSha,evidenceRef:'native:accepted'})})
  const dir=await mkdtemp(join(tmpdir(),'dsh-schema-native-'));const store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'schema-test',initialize:true});const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
  const delivery=createExecutionDelivery({store,artifacts,externalAdapter:p.operationAdapter,authorize:async()=>({principalId:'owner',authorizationRef:'test-authorized'}),authorizeExternal:async()=>({principalId:'owner',authorizationRef:'exact-approved-task-schema'})})
  const workflow=createUatSchemaMigrationTaskWorkflow({adapter:p.adapter});const controller=createExecutionController({store,artifacts,delivery,workflows:[workflow]});t.after(async()=>{await controller.close();await store.close()})
  await controller.createRun({commandId:'schema-create',runId:'schema-native-run',taskId:target.taskId,workflowId:workflow.id,input:{taskId:target.taskId,targetId:target.id,candidateSha:target.candidateSha,request:'approved schema'}})
  const state=await controller.whenIdle('schema-native-run');assert.equal(state.run.status,'succeeded',JSON.stringify(state.nodes.map(n=>[n.nodeId,n.waitReason])))
  const effects=await store.query({kind:'effect.list',runId:'schema-native-run'});assert.equal(effects.length,1);assert.equal(effects[0].state,'succeeded');assert.equal(effects[0].definition.payload.workflowKind,'uat-schema-migration')
  const proof=await artifacts.read(state.nodes.at(-1).outputRef);assert.equal(proof.schemaDigest,(await host().reconcile({target,migrationKey})).schemaDigest);assert.equal(proof.taskId,target.taskId)
})
await test('native failed attempt settles only after read-only empty-schema proof; fresh attempt preserves old receipt', async t => {
  await clear(); let fail = true
  class FailOnce extends IsolatedClient { async query(q,...args) { if(fail && typeof q==='string' && q.startsWith('COMMENT ON TABLE public.te_activity_merge_submission')) { fail=false; throw Error('before commit failure') } return super.query(q,...args) } }
  const github={readPullRequest:async()=>({merged:true,headCommitSha:target.candidateSha,mergeCommitSha:target.candidateSha,baseBranch:target.branch,baseRepository:target.repository,headRepository:target.repository,evidenceRef:'github:pr'}),readBranch:async()=>({commitSha:target.candidateSha,evidenceRef:'github:branch'}),readVersionedFile:async()=>({content:sql,evidenceRef:'github:sql'})}
  const p=createUatSchemaMigrationPlatform({targets:[target],postgres:host(FailOnce),github,readAcceptedSource:async()=>({candidateSha:target.candidateSha,evidenceRef:'native:accepted'})});const dir=await mkdtemp(join(tmpdir(),'dsh-schema-retry-'));const store=await openExecutionStore({dbPath:join(dir,'control.db'),instanceId:'schema-retry',initialize:true});const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true});const delivery=createExecutionDelivery({store,artifacts,externalAdapter:p.operationAdapter,authorize:async()=>({principalId:'owner',authorizationRef:'approved'}),authorizeExternal:async()=>({principalId:'owner',authorizationRef:'approved-exact-schema'})});const workflow=createUatSchemaMigrationTaskWorkflow({adapter:p.adapter}),controller=createExecutionController({store,artifacts,delivery,workflows:[workflow]});t.after(async()=>{await controller.close();await store.close()});const input={taskId:target.taskId,targetId:target.id,candidateSha:target.candidateSha,request:'approved schema'}
  await controller.createRun({commandId:'first',runId:'schema-failed-attempt',taskId:target.taskId,workflowId:workflow.id,input});await controller.whenIdle('schema-failed-attempt')
  const old=(await store.query({kind:'effect.list',runId:'schema-failed-attempt'}))[0];assert.equal(old.state,'unknown')
  const settled=await delivery.reconcile(old.effectId);assert.equal(settled.state,'failed');assert.equal(settled.result.result.noCommittedEffect,true)
  await controller.stop({commandId:'stop-settled-attempt',runId:'schema-failed-attempt',reason:'Effect failed and read-only catalog proves rollback; replace with fresh authorized attempt'})
  assert.equal((await controller.whenIdle('schema-failed-attempt')).run.status,'cancelled')
  await controller.createRun({commandId:'second',runId:'schema-fresh-attempt',taskId:target.taskId,workflowId:workflow.id,input});const state=await controller.whenIdle('schema-fresh-attempt');assert.equal(state.run.status,'succeeded')
  const unchanged=await store.query({kind:'effect.get',effectId:old.effectId});assert.equal(unchanged.state,'failed');assert.deepEqual(unchanged.result,settled.result)
  assert.equal((await host().reconcile({target,migrationKey})).status,'succeeded')
})
await test('formal profile CAS append is exact, writes0 in Check, and preserves existing release/production config', async () => {
  const hash=x=>createHash('sha256').update(x).digest('hex')
  const source=yaml.dump([{name:'@zzusp/dingtalk-dsh-assistant/resident',config:{workflow:{repositories:[{githubRepository:target.repository}],platforms:{release:{targets:[]},uatMerge:{targets:[]},bytebase:{unchanged:'production'},untouched:'keep'}}}}])
  const proposal={expectedProfileSha256:hash(source),uatSchemaMigrationTarget:target};const plan=await planReleaseTargetAppend(source,proposal);assert.equal(plan.changed,true)
  const config=yaml.load(plan.updated)[0].config.workflow.platforms;assert.deepEqual(config.uatSchemaMigration,{targets:[target]});assert.equal(config.bytebase.unchanged,'production');assert.equal(config.untouched,'keep')
  const dir=await mkdtemp(join(tmpdir(),'dsh-schema-config-'));const profile=join(dir,'profile.yml'),file=join(dir,'proposal.json');await writeFile(profile,source);await writeFile(file,JSON.stringify(proposal))
  assert.equal((await configureReleaseTargetAppend({profile,proposal:file,mode:'check',expectedSha256:hash(source)})).writes,0);assert.equal(await readFile(profile,'utf8'),source)
  assert.equal((await configureReleaseTargetAppend({profile,proposal:file,mode:'apply',expectedSha256:hash(source)})).writes,1)
  await assert.rejects(planReleaseTargetAppend(source,{...proposal,uatSchemaMigrationTarget:{...target,environment:'production'}}),/UAT_SCHEMA_TARGET_NOT_ALLOWED/)
  assert.equal((await planReleaseTargetAppend(plan.updated,{expectedProfileSha256:hash(plan.updated),uatSchemaMigrationTarget:target})).changed,false)
})
await test('trusted native registration exposes only the approved original task target',async()=>{
  const platform=createTrustedWorkflowPlatforms({config:{uatSchemaMigration:{targets:[target]}},clients:{uatSchemaMigration:host(),release:{github:{readPullRequest:async()=>{},readBranch:async()=>{},readVersionedFile:async()=>{}}}},ownerActorId:'owner'})
  assert.equal(platform.availableTargets[0].workflowId,'task-uat-schema-migration')
  assert.deepEqual(await platform.prepareRequirement({workflowId:'task-uat-schema-migration',action:{taskId:target.taskId,arguments:{objective:'approved',targetId:target.id}}}),{request:'approved',taskId:target.taskId,targetId:target.id,candidateSha:target.candidateSha})
  await assert.rejects(platform.prepareRequirement({workflowId:'task-uat-schema-migration',action:{taskId:'foreign',arguments:{objective:'approved',targetId:target.id}}}),/UAT_SCHEMA_TARGET_NOT_ALLOWED/)
})
await clear(); await db.end()

} else { test('real PostgreSQL schema migration integration', { skip: 'Set UAT_SCHEMA_TEST_PORT=54393 for the task-owned isolated PG cluster; no mock success' }, () => {}) }
