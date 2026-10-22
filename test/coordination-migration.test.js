import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openIndependentCoordination } from '../packages/dingtalk-dsh-assistant/independent-coordination-service.js'
import { inspectCoordinationMigration, migrateCoordinationLedger } from '../scripts/migrate-coordination-ledger.mjs'
import { migrationStateDigest } from '../packages/dingtalk-dsh-assistant/coordination-migration-state.js'

const repository = fileURLToPath(new URL('../', import.meta.url))
const baseline = '94f99720836e134f0615dc7e02f0f4d4bd72b7e9'
const epoch = '2026-10-01T00:00:00.000Z'
const currentStoreUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
const cli = fileURLToPath(new URL('../scripts/migrate-coordination-ledger.mjs', import.meta.url))
const legacyFiles = new Map()
function baselineSource(path) {
  if (!legacyFiles.has(path)) legacyFiles.set(path, execFileSync('git', ['show', `${baseline}:${path}`], { cwd: repository, encoding: 'utf8' }))
  return legacyFiles.get(path)
}

async function realV1(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-real-v1-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'baseline')
  await mkdir(root)
  await writeFile(join(root, 'package.json'), '{"type":"module","private":true}\n')
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const copied = new Set()
  async function copy(path) {
    if (copied.has(path)) return
    copied.add(path)
    const source = baselineSource(path), target = join(root, path)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, source)
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) if (specifier.startsWith('.')) {
      // Resolve package-local imports against repository-relative paths without
      // reading today's working tree or changing the historical source bytes.
      const normalized = fileURLToPath(new URL(specifier, pathToFileURL(join(repository,path)))).slice(repository.length).replace(/^[/\\]/,'').replaceAll('\\','/')
      await copy(normalized)
    }
  }
  const path = 'packages/dingtalk-dsh-assistant/dynamic-task-store.js'
  await copy(path)
  assert.match(await readFile(join(root,path),'utf8'), /const VERSION = 1/)
  const options = { dbPath: join(directory,'history.sqlite'), instanceId: 'historical-instance', ingressEpoch: epoch, initialize: true }
  const legacyUrl = pathToFileURL(join(root,path)).href
  const script = `import {openDynamicTaskStore} from ${JSON.stringify(legacyUrl)};
    const store = await openDynamicTaskStore(JSON.parse(process.argv[1]));
    const command = (kind,args,id)=>store.command({kind,args,id});
    await command('source.record',{sourceId:'historical-source',groupId:'group',messageId:'historical-message',actorId:'author',text:'historical request',timestamp:'2026-10-02T00:00:00.000Z'},'historical-source');
    await command('task.create',{taskId:'history',groupId:'group',ownerActorId:'author',request:'historical request',sourceRefs:['historical-source']},'historical-create');
    const owner=(await command('task.claim',{taskId:'history'},'historical-claim')).result.binding;
    const execution=(await command('execution.dispatch',{binding:owner,key:'once',prompt:'historical execution',input:{evidence:'historical input'},resourceKeys:['fixture:shared']},'historical-dispatch')).result.execution;
    const runner=(await command('execution.claim',{executionId:execution.executionId},'historical-run')).result.binding;
    await command('execution.result',{binding:runner,output:{summary:'historical completed execution'}},'historical-result');
    await command('execution.drained',{binding:runner},'historical-execution-drained');
    await command('task.complete',{binding:owner,summary:'historical Owner acceptance',result:{evidence:['historical-artifact']}},'historical-complete');
    await command('task.drained',{binding:owner},'historical-task-drained');
    const group=(await command('group.claim',{groupId:'group'},'historical-group')).result.binding;
    await command('group.drained',{binding:group},'historical-group-drained');
    console.log(JSON.stringify({version:store.info.version,task:await store.query({kind:'task.get',taskId:'history'}),execution:await store.query({kind:'execution.get',executionId:execution.executionId})}));
    await store.close();`
  const generated = JSON.parse(execFileSync(process.execPath, ['--input-type=module','--eval',script,JSON.stringify(options)], { encoding:'utf8' }))
  assert.equal(generated.version,1)
  const legacyCommand = commands => {
    const body = `import {openDynamicTaskStore} from ${JSON.stringify(legacyUrl)};const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
      for(const command of JSON.parse(process.argv[2]))await store.command(command);await store.close();`
    execFileSync(process.execPath,['--input-type=module','--eval',body,JSON.stringify({...options,initialize:false}),JSON.stringify(commands)],{encoding:'utf8'})
  }
  return { directory, options: { ...options, initialize:false }, legacyUrl, generated, legacyCommand }
}

test('default CLI check reads a genuine historical v1 ledger without changing its database or marker', async t => {
  const f = await realV1(t)
  const before = await readFile(f.options.dbPath), marker = await readFile(`${f.options.dbPath}.initialized`)
  const output = execFileSync(process.execPath,[cli,'--db',f.options.dbPath,'--instance-id',f.options.instanceId,'--ingress-epoch',epoch],{encoding:'utf8'})
  const report = JSON.parse(output)
  assert.equal(report.schemaVersion,1); assert.equal(report.ready,true)
  assert.ok(report.rowCounts.dynamic_receipts > 5)
  assert.match(report.expectedDigest,/^[a-f0-9]{64}$/)
  assert.deepEqual(await readFile(f.options.dbPath),before)
  assert.deepEqual(await readFile(`${f.options.dbPath}.initialized`),marker)
})

test('genuine v1 migrates with historical receipts and identities intact; the actual old v1 program refuses v2', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  const result = await migrateCoordinationLedger({...f.options,expectedDigest:before.expectedDigest})
  assert.equal(result.migrated,true); assert.equal(result.schemaVersion,2); assert.equal(result.historyPreserved,true)
  assert.equal(result.markerDigest,before.markerDigest); assert.equal(result.ingressEpoch,epoch)
  const store = await openDynamicTaskStore(f.options)
  try {
    const task = await store.query({kind:'task.get',taskId:'history'})
    assert.equal(task.status,'completed'); assert.equal(task.sessionId,f.generated.task.sessionId)
    const receipt = await store.query({kind:'receipt.get',id:'historical-complete'})
    assert.equal(receipt.taskDecision.id,'historical-complete')
    const execution = await store.query({kind:'execution.get',executionId:f.generated.execution.executionId})
    assert.equal(execution.inputVersion,1); assert.equal(execution.instructionScope.kind,'existing')
    assert.deepEqual(execution.instructionScope.instructionIds,[])
    assert.deepEqual((await store.query({kind:'task.events'})).events,[],'migration never invents a new authoritative completion event')
  } finally { await store.close() }
  const rejection = `import {openDynamicTaskStore} from ${JSON.stringify(f.legacyUrl)};try{const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));await store.close();console.log('unexpected-open')}catch(error){console.log(error.code)}`
  assert.equal(execFileSync(process.execPath,['--input-type=module','--eval',rejection,JSON.stringify(f.options)],{encoding:'utf8'}).trim(),'DYNAMIC_SCHEMA_INVALID')
  const current = inspectCoordinationMigration(f.options)
  const again = await migrateCoordinationLedger({...f.options,expectedDigest:current.expectedDigest})
  assert.equal(again.unchanged,true); assert.equal(again.migrated,false)
})

test('a real process killed after migration DDL but before version update leaves atomic v1 state and retries safely', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  const script = `import {DatabaseSync} from 'node:sqlite';import {openDynamicTaskStore} from ${JSON.stringify(currentStoreUrl)};
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql.includes('PRAGMA user_version=2')){process.stdout.write('migration-kill-point\\n');process.kill(process.pid,'SIGKILL')}return exec.call(this,sql)};
    await openDynamicTaskStore({...JSON.parse(process.argv[1]),migrate:true,migrationExpectedDigest:process.argv[2]});`
  const child = spawnSync(process.execPath,['--input-type=module','--eval',script,JSON.stringify(f.options),before.expectedDigest],{encoding:'utf8'})
  assert.equal(child.error,undefined)
  assert.match(child.stdout,/migration-kill-point/)
  if(process.platform==='win32'){assert.equal(child.signal,null);assert.equal(child.status,1)}
  else assert.equal(child.signal,'SIGKILL')
  const after = inspectCoordinationMigration(f.options)
  assert.equal(after.schemaVersion,1); assert.equal(after.expectedDigest,before.expectedDigest)
  assert.equal(after.markerDigest,before.markerDigest)
  const db = new DatabaseSync(f.options.dbPath,{readOnly:true})
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'dynamic_coordination%'").get().count,0) } finally { db.close() }
  assert.equal((await migrateCoordinationLedger({...f.options,expectedDigest:before.expectedDigest})).historyPreserved,true)
})

test('migration review digest is checked again inside the exclusive transaction before any DDL', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  const script = `import {DatabaseSync} from 'node:sqlite';import {openDynamicTaskStore} from ${JSON.stringify(currentStoreUrl)};
    const options=JSON.parse(process.argv[1]),exec=DatabaseSync.prototype.exec;let changed=false;
    DatabaseSync.prototype.exec=function(sql){if(!changed&&sql.includes('BEGIN IMMEDIATE')&&sql.includes('PRAGMA journal_mode')){changed=true;const other=new DatabaseSync(options.dbPath);other.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('concurrent-review-change','retained');other.close()}return exec.call(this,sql)};
    try{const store=await openDynamicTaskStore({...options,migrate:true,migrationExpectedDigest:process.argv[2]});await store.close();console.log('unexpected-open')}catch(error){console.log(error.code)}`
  const output = execFileSync(process.execPath,['--input-type=module','--eval',script,JSON.stringify(f.options),before.expectedDigest],{encoding:'utf8'})
  assert.equal(output.trim(),'DYNAMIC_MIGRATION_STATE_CHANGED')
  const db = new DatabaseSync(f.options.dbPath,{readOnly:true})
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,1)
    assert.equal(db.prepare("SELECT value FROM dynamic_meta WHERE key='concurrent-review-change'").get().value,'retained')
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='dynamic_coordination'").get().count,0)
    assert.notEqual(migrationStateDigest(db),before.expectedDigest)
  } finally { db.close() }
})

test('live legacy owner and undrained legacy group prevent migration before schema changes', async t => {
  const f = await realV1(t)
  const script = `import {openDynamicTaskStore} from ${JSON.stringify(f.legacyUrl)};await openDynamicTaskStore(JSON.parse(process.argv[1]));process.stdout.write('ready');setInterval(()=>{},1000)`
  const child = spawn(process.execPath,['--input-type=module','--eval',script,JSON.stringify(f.options)],{stdio:['ignore','pipe','pipe']})
  const ended = once(child,'exit'); t.after(()=>child.kill('SIGKILL'))
  assert.equal((await once(child.stdout,'data'))[0].toString(),'ready')
  const report = inspectCoordinationMigration(f.options)
  assert.equal(report.ready,false); assert.ok(report.blockReasons.includes('live_owner'))
  await assert.rejects(migrateCoordinationLedger({...f.options,expectedDigest:report.expectedDigest}),{code:'MIGRATION_PRECHECK_BLOCKED'})
  child.kill('SIGKILL'); await ended
  f.legacyCommand([{id:'undrained-group',kind:'group.claim',args:{groupId:'unclosed-group'}}])
  const drained = inspectCoordinationMigration(f.options)
  assert.equal(drained.schemaVersion,1); assert.ok(drained.blockReasons.includes('unresolved_groups'))
  await assert.rejects(openDynamicTaskStore({...f.options,migrate:true,migrationExpectedDigest:drained.expectedDigest}),{code:'DYNAMIC_MIGRATION_NOT_QUIESCENT'})
})

test('identity and review mismatches never initialize a new ledger or clear historical state', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  assert.throws(()=>inspectCoordinationMigration({...f.options,instanceId:'different-instance'}),{code:'MIGRATION_MARKER_INVALID'})
  assert.throws(()=>inspectCoordinationMigration({...f.options,ingressEpoch:'2026-10-02T00:00:00.000Z'}),{code:'MIGRATION_INGRESS_EPOCH_MISMATCH'})
  await assert.rejects(migrateCoordinationLedger({...f.options,expectedDigest:'0'.repeat(64)}),{code:'DYNAMIC_MIGRATION_STATE_CHANGED'})
  assert.throws(()=>inspectCoordinationMigration({...f.options,dbPath:join(f.directory,'missing.sqlite')}),{code:'MIGRATION_SOURCE_MISSING'})
  assert.equal(inspectCoordinationMigration(f.options).expectedDigest,before.expectedDigest)
})

test('compatible admission-off mode preserves ownership and resumes accepted work without planning new units', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  await migrateCoordinationLedger({...f.options,expectedDigest:before.expectedDigest})
  const store = await openDynamicTaskStore(f.options)
  let service
  try {
    const command = (kind,args,id=randomUUID())=>store.command({kind,args,id})
    const query = (kind,args={})=>store.query({kind,...args})
    const entry = { reservationId:'compat-reservation',generation:1,unitId:'compat-unit',unitRevision:1,dispatchOwner:'coordination',semanticState:'reserved',settled:false,
      sourceSnapshot:{messageId:'historical-message',messageVersion:1,actorId:'author',unitText:'historical request',text:'historical request',sourceRefs:[]} }
    const held = { ...entry,reservationId:'held-reservation',unitId:'held-unit',sourceSnapshot:{...entry.sourceSnapshot,messageId:'future-message',unitText:'new pending request',text:'new pending request'} }
    await command('source.record',{sourceId:'future-source',groupId:'group',messageId:'future-message',actorId:'author',text:'new pending request',timestamp:'2026-10-03T00:00:00.000Z'})
    const source = (await command('coordination.reserve',{unitId:entry.unitId,revision:1,groupId:'group',original:entry.sourceSnapshot.unitText,
      reservationId:entry.reservationId,reservationGeneration:1,actorId:'author',sourceRefs:['historical-source'],sourceMessageId:'historical-message'})).result.source
    await command('coordination.accept',{sourceId:source.id,fence:source.fence,coordinationId:'compat-coordination',members:[{
      instructionId:'compat-member',taskId:'history',progressImpact:'replan',dependencies:[],command:{id:'coordination-command:compat-coordination:compat-member',kind:'task.reopen',
        args:{taskId:'history',expectedRequirementRevision:1,expectedControlRevision:1,request:'explicit authorized new request'}}}]})
    let plans=0,handoffs=0
    const residentStore = {
      getSourceDispatchOwnership:(_group,unitId)=>[entry,held].find(item=>item.unitId===unitId),
      listSourceDispatchOwnership:()=>[entry,held],
      getGroup:()=>({messages:[{messageId:'historical-message',senderOpenDingTalkId:'author',senderName:'author'}]}),
      async updateSourceDispatch(args){const current=[entry,held].find(item=>item.unitId===args.unitId);assert.equal(current.generation,args.expectedGeneration);Object.assign(current,args);return current},
    }
    service=openIndependentCoordination({config:{enabled:false},residentStore,query,command,
      planner:{plan:async()=>{plans++},close:async()=>{}},onApplied:async()=>{handoffs++},onError:(_id,error)=>{throw error}})
    await service.recoverGroup('group')
    assert.equal(plans,0);assert.equal(handoffs,1)
    assert.equal((await query('task.get',{taskId:'history'})).runSequence,2)
    assert.equal((await query('coordination.get',{coordinationId:'compat-coordination'})).members[0].state,'applied')
    assert.equal((await query('coordination.source',{unitId:entry.unitId,revision:1})).dispatchOwner,'coordination')
    assert.equal((await query('coordination.source',{unitId:held.unitId,revision:1})).state,'reserved')
    assert.equal(held.settled,false)
    await service.recoverGroup('group');assert.equal(handoffs,1);assert.equal(plans,0)
  } finally { await service?.close();await store.close() }
})

test('compatible frozen mode survives restart and blocks coordinated claims and send permits without freezing unrelated work', async t => {
  const f = await realV1(t), before = inspectCoordinationMigration(f.options)
  await migrateCoordinationLedger({...f.options,expectedDigest:before.expectedDigest})
  let store = await openDynamicTaskStore(f.options)
  const command = (kind,args,id=randomUUID())=>store.command({kind,args,id})
  const query = (kind,args={})=>store.query({kind,...args})
  try {
    const source=(await command('coordination.reserve',{unitId:'frozen-unit',revision:1,groupId:'group',original:'explicit new request'})).result.source
    await command('coordination.accept',{sourceId:source.id,fence:source.fence,coordinationId:'frozen-coordination',members:[{
      instructionId:'frozen-member',taskId:'history',progressImpact:'replan',dependencies:[],command:{id:'coordination-command:frozen-coordination:frozen-member',kind:'task.reopen',
        args:{taskId:'history',expectedRequirementRevision:1,expectedControlRevision:1,request:'explicit new request'}}}]})
    await command('coordination.apply',{instructionId:'frozen-member',expectedRevision:1})
    const owner=(await command('task.claim',{taskId:'history'})).result.binding
    const execution=(await command('execution.dispatch',{binding:owner,key:'coordinated',prompt:'coordinated work',input:{}})).result.execution
    await command('notification.prepare',{notificationId:'frozen-summary',kind:'coordination',requirementRevision:1,
      payload:{conversationId:'group',text:'frozen coordination summary',fact:{coordinationId:'frozen-coordination',eventId:'frozen-summary'}}})
    await command('coordination.runtime.set',{mode:'frozen',reason:'isolated compatibility rollback drill'})
    await store.close();store=await openDynamicTaskStore(f.options)
    assert.equal((await query('coordination.runtime')).mode,'frozen')
    await assert.rejects(command('execution.claim',{executionId:execution.id}),{code:'DYNAMIC_COORDINATION_FROZEN'})
    assert.equal((await command('notification.start',{notificationId:'frozen-summary'})).dispatchEligible,false)
    assert.equal((await query('notification.get',{notificationId:'frozen-summary'})).state,'prepared')
    assert.equal((await query('coordination.source',{unitId:'frozen-unit',revision:1})).dispatchOwner,'coordination')
    await command('task.create',{taskId:'unrelated',groupId:'group',request:'unrelated previously authorized task'})
    const independentOwner=(await command('task.claim',{taskId:'unrelated'})).result.binding
    const independent=(await command('execution.dispatch',{binding:independentOwner,key:'unrelated',prompt:'unrelated',input:{}})).result.execution
    assert.equal((await command('execution.claim',{executionId:independent.id})).dispatchEligible,true)
  } finally {await store.close()}
})
